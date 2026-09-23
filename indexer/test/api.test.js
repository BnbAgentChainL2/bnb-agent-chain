// test/api.test.js —— 03 §3 的每一个端点。
// 断言的是**确切的字段名**：这些名字是契约，改一个就要同时改索引器、API、网站数据层、SDK。
// 全程用临时 sqlite 文件 + 本机端口 0，不碰服务器、不碰主网、不需要任何密钥。
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer, RateLimiter, route } from "../src/api/server.js";
import { rpcGuard, checkCall, RPC_WHITELIST } from "../src/api/rpcguard.js";
import { ingestLogs, ingestLayerBlock } from "../src/store.js";
import { root as exitRootOf, leafHash, verify } from "../src/exit-tree.js";
import { resetWarnings } from "../src/warnings.js";
import { tempDb, cleanupTempDbs, mkLog, mkLayerBlock, ADDR, TEST_CFG, TEST_BOOK, KIND } from "./helpers.js";

test.after(cleanupTempDbs);

const TS = 1790000000;
const EPOCH = Math.floor(TS / 86400);

const EXITS = [
  { exitId: 1n, agentId: 17n, to: ADDR.controller, credits: 100n },
  { exitId: 2n, agentId: 17n, to: ADDR.agentWallet, credits: 200n },
  { exitId: 3n, agentId: 18n, to: ADDR.controller, credits: 300n },
];

/** 建一个装了两条链各类数据的库。 */
function seeded() {
  resetWarnings();
  const { db, path } = tempDb();
  const bsc = (logs) => ingestLogs(db, { chain: "bsc", logs, cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS });
  const layer = (logs) => ingestLogs(db, { chain: "layer", logs, cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS });

  bsc([
    mkLog("AgentRegistry", "Registered", {
      agentId: 17n, controller: ADDR.controller, agentWallet: ADDR.agentWallet,
      agentURI: "https://a.invalid/agent.json", endpointHash: "0x" + "11".repeat(32), modelFingerprint: "0x" + "22".repeat(32),
    }, { address: ADDR.AgentRegistry, blockNumber: 10, logIndex: 0 }),
    mkLog("AgentRegistry", "Activated", { agentId: 17n, agentWallet: ADDR.agentWallet },
      { address: ADDR.AgentRegistry, blockNumber: 11, logIndex: 0 }),
    mkLog("AgentRegistry", "Registered", {
      agentId: 18n, controller: ADDR.controller, agentWallet: ADDR.validator,
      agentURI: "https://b.invalid/agent.json", endpointHash: "0x" + "33".repeat(32), modelFingerprint: "0x" + "44".repeat(32),
    }, { address: ADDR.AgentRegistry, blockNumber: 12, logIndex: 0 }),
    mkLog("BacBridge", "Locked", {
      depositId: 12n, agentId: 17n, from: ADDR.controller, layerWallet: ADDR.agentWallet,
      measured: 250000n * 10n ** 18n, credits: 250000n * 10n ** 18n, totalIssued: 250000n * 10n ** 18n,
    }, { address: ADDR.BacBridge, blockNumber: 13, logIndex: 0 }),
    mkLog("ValidatorStaking", "Staked", { who: ADDR.validator, amount: 2000000n, total: 2000000n },
      { address: ADDR.ValidatorStaking, blockNumber: 14, logIndex: 0 }),
    mkLog("ValidatorStaking", "NodeRegistered", {
      nodeIdHash: "0x" + "55".repeat(32), validator: ADDR.validator, payout: ADDR.controller, enodeURI: "enode://ab@1.2.3.4:30303",
    }, { address: ADDR.ValidatorStaking, blockNumber: 15, logIndex: 0 }),
    mkLog("ValidatorStaking", "AttestationCommitted", { epoch: BigInt(EPOCH), validator: ADDR.validator, commitment: "0x" + "66".repeat(32) },
      { address: ADDR.ValidatorStaking, blockNumber: 16, logIndex: 0 }),
    mkLog("ValidatorStaking", "AttestationRevealed", {
      epoch: BigInt(EPOCH), validator: ADDR.validator, exitRoot: exitRootOf(EXITS, 56777, ADDR.BacBridge),
      l2BlockHash: "0x" + "cd".repeat(32), l2Block: 1234567n, agreeing: true, weight: 2000000n,
    }, { address: ADDR.ValidatorStaking, blockNumber: 17, logIndex: 0 }),
  ]);

  layer(
    EXITS.map((x, i) =>
      mkLog("L2Bridge", "ExitBurned", { exitId: x.exitId, agentId: x.agentId, bscRecipient: x.to, amount: x.credits, epoch: BigInt(EPOCH) },
        { address: ADDR.L2Bridge, blockNumber: 1000 + i, logIndex: 0 })
    )
  );
  layer([
    mkLog("AgentBook", "Action", {
      agentId: 17n, kind: KIND("PUBLISH"), subject: ADDR.controller, actor: ADDR.agentWallet,
      contentHash: "0x" + "11".repeat(32), summary: "第一篇 <b>x</b>", uri: "ipfs://x", seq: 1n, epoch: BigInt(EPOCH),
    }, { address: ADDR.AgentBook, blockNumber: 1010, logIndex: 0 }),
  ]);

  // 锚点：用真实的根，这样归属与证明端点才有数据
  bsc([
    mkLog("ChainAnchor", "AnchorPosted", {
      epoch: BigInt(EPOCH), exitRoot: exitRootOf(EXITS, 56777, ADDR.BacBridge), l2BlockHash: "0x" + "cd".repeat(32),
      l2Block: 1234567n, credited: 1n, exitCredits: 600n, feeBurned: 0n, circulating: 1n, exitCount: 3n,
    }, { address: ADDR.ChainAnchor, blockNumber: 20, logIndex: 0 }),
    mkLog("ChainAnchor", "AnchorFinalized", { epoch: BigInt(EPOCH), agreeingCount: 2n, releaseBps: 350n },
      { address: ADDR.ChainAnchor, blockNumber: 21, logIndex: 0 }),
    mkLog("BacBridge", "EpochSettled", { epoch: BigInt(EPOCH), pot: 1200n, owedTotalAfter: 4300n, releaseBps: 350n, skipped: false },
      { address: ADDR.BacBridge, blockNumber: 22, logIndex: 0 }),
  ]);

  // 层内区块 + 一次部署 + 一次调用
  const created = ADDR.BacVaultFactory;
  ingestLayerBlock(db, { ...mkLayerBlock({ number: 1234560, ts: TS, txs: [{ from: ADDR.agentWallet, to: null, created, codeSize: 12844 }] }), cfg: TEST_CFG });
  ingestLayerBlock(db, { ...mkLayerBlock({ number: 1234561, ts: TS + 3, txs: [{ from: ADDR.agentWallet, to: created }] }), cfg: TEST_CFG });

  db.prepare(
    `INSERT INTO treasury (ts, bsc_block, vault_balance, vault_accounted, vault_unsplit, lifetime_to_bridge,
      lifetime_to_node, pool_balance, node_fund_balance, node_fund_withdrawn, total_locked, total_issued,
      total_exited, reward_balance, reward_funded, reward_paid, market_address_ok)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
  ).run(TS, 123456789, "0", "0", "0", "12400000000000000000", "12400000000000000000", "9100000000000000000",
    "400000000000000000", "12000000000000000000", "5000000000000000000000000", "5000000000000000000000000",
    "120000000000000000000000", "300000000000000000", "800000000000000000", "500000000000000000");

  const snapshot = {
    layer: { chainId: 56777, head: 1234561, headTs: TS + 3, blockLagSec: 2, enode: "enode://ab@1.2.3.4:30303",
             genesisHash: "0x" + "ab".repeat(32), gasLimit: 20000000, baseFee: "0", peers: 3 },
    relayer: { lastPostedEpoch: EPOCH, currentEpoch: EPOCH, epochLag: 0, bscCursor: 123456789, bscLagBlocks: 18,
               layerCursor: 1234560, outboxNew: 0, outboxSent: 1, outboxOrphaned: 0,
               bscKeyBalance: "82000000000000000", layerKeyBalance: "994120000000000000000" },
    // 03 §3.1 的样例数字对不上它自己的公式（见仓库 README 的「与文档的出入」），
    // 这里用一组自洽的：layerCirculating = (issued − exited) − feeSink − feeSplitter − Σ validator
    reconcile: { bscTotalIssued: "5000000000000000000000000", bscTotalExited: "120000000000000000000000",
                 layerCirculating: "4879986396875000000000000", feeSinkBalance: "3125000000000000",
                 feeSplitterBalance: "12400000000000000000",
                 validatorBalances: [{ addr: "0x0000000000000000000000000000000000005164", balance: "1200000000000000000" }] },
    bridge: { paused: false, halted: false, owedTotal: "4300000000000000000", reservedTotal: "900000000000000000",
              lastSettledEpoch: EPOCH, currentReleaseBps: 350 },
    treasury: { taxFeeRateBps: 1000 },
    flap: { marketAddressOk: true, checkedAt: TS },
    anchorCommitWindowEndsAt: TS + 7200,
    dbBytes: 481234944,
  };
  return { db, path, ctx: { db, cfg: TEST_CFG, snapshot } };
}

/** 起一个真的 HTTP 服务，测响应头与状态码。 */
async function withServer(ctx, fn, opts = {}) {
  const server = createApiServer(ctx, opts);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const keys = (o) => Object.keys(o).sort();

// ===================== 公共响应头与错误形状 =====================

test("公共响应头：CORS、缓存、Content-Type（03 §3 开头）", async () => {
  const { ctx } = seeded();
  await withServer(ctx, async (base) => {
    const res = await fetch(`${base}/api/summary`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("cache-control"), "public, max-age=3");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  });
});

test("错误形状统一，且状态码对应 404 / 400", async () => {
  const { ctx } = seeded();
  await withServer(ctx, async (base) => {
    const r404 = await fetch(`${base}/api/agent/999`);
    assert.equal(r404.status, 404);
    const b404 = await r404.json();
    assert.deepEqual(keys(b404), ["error"]);
    assert.deepEqual(keys(b404.error), ["code", "message"]);
    assert.equal(b404.error.code, "not_found");
    assert.ok(b404.error.message.length > 0);

    const r400 = await fetch(`${base}/api/feed?limit=999`);
    assert.equal(r400.status, 400);
    assert.equal((await r400.json()).error.code, "bad_request");

    const rNo = await fetch(`${base}/api/nope`);
    assert.equal(rNo.status, 404);
    assert.equal((await rNo.json()).error.code, "not_found");
  });
});

test("限速：超过每秒上限返回 429 与 rate_limited", async () => {
  const { ctx } = seeded();
  const limiter = new RateLimiter({ perSec: 2, perMin: 100 });
  await withServer(ctx, async (base) => {
    await fetch(`${base}/api/summary`);
    await fetch(`${base}/api/summary`);
    const res = await fetch(`${base}/api/summary`);
    assert.equal(res.status, 429);
    const b = await res.json();
    assert.equal(b.error.code, "rate_limited");
  }, { limiter });
});

test("OPTIONS 预检返回 204 并带 CORS 头", async () => {
  const { ctx } = seeded();
  await withServer(ctx, async (base) => {
    const res = await fetch(`${base}/api/summary`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});

// ===================== §3.1 /api/health =====================

test("§3.1 /api/health：字段逐字齐全，reconcile 三元组与 howToCheck 原样返回", async () => {
  const { ctx } = seeded();
  const { body } = route(ctx, "GET", "/api/health", {});
  assert.equal(body.schema, "bac/health/1");
  assert.deepEqual(keys(body), [
    "anchorCommitWindowEndsAt", "bridge", "flap", "gas", "indexer", "layer", "now", "ok",
    "relayer", "reconcile", "rpc", "schema", "vault", "warnings",
  ].sort());
  assert.deepEqual(keys(body.layer), ["baseFee", "blockLagSec", "chainId", "enode", "gasLimit", "genesisHash", "head", "headTs", "minGasPrice", "peers", "zeroBaseFee"]);
  assert.deepEqual(keys(body.relayer), [
    "bscCursor", "bscKeyBalance", "bscLagBlocks", "currentEpoch", "epochLag", "lastPostedEpoch",
    "layerCursor", "layerKeyBalance", "outboxNew", "outboxOrphaned", "outboxSent",
  ]);
  assert.deepEqual(keys(body.reconcile), [
    "bscTotalExited", "bscTotalIssued", "diff", "feeSinkBalance", "feeSplitterBalance", "formula",
    "howToCheck", "layerCirculating", "ok", "validatorBalances",
  ]);
  assert.equal(
    body.reconcile.formula,
    "diff = (bscTotalIssued - bscTotalExited) - (layerCirculating + feeSinkBalance + feeSplitterBalance + sum(validatorBalances))"
  );
  // 决策 #17：FeeSplitter 与逐个验证者余额必须分项列出，才能逐项核
  assert.equal(body.reconcile.feeSplitterBalance, "12400000000000000000");
  assert.equal(body.reconcile.validatorBalances.length, 1);
  assert.deepEqual(keys(body.reconcile.validatorBalances[0]), ["addr", "balance"]);
  // gas 块（决策 #17 的对账三联）：没有 FINAL 锚点时一律是 "0"，不拿实时数冒充已锚定
  assert.deepEqual(keys(body.gas), [
    "carryPool", "foundationBalance", "gap", "gapBps", "lastAnchoredEpoch", "officialBlockValidatorBps",
    "operatorFloatReserve", "poolPending", "received", "remitOverdueEpochs", "remitted", "schemaNote",
    "shortfalls", "validatorBlockValidatorBps",
  ]);
  assert.equal(body.gas.officialBlockValidatorBps, 1000);
  assert.equal(body.gas.validatorBlockValidatorBps, 5000);
  assert.equal(body.gas.received, "0");
  assert.deepEqual(body.gas.shortfalls, []);
  // 这组夹具是按公式配平的，diff 必须是 0
  assert.equal(body.reconcile.diff, "0");
  assert.equal(body.reconcile.ok, true);
  assert.equal(body.reconcile.howToCheck.length, 7);
  assert.match(body.reconcile.howToCheck[0], /^cast call .* "totalCreditsIssued\(\)\(uint256\)" --rpc-url /);
  assert.match(body.reconcile.howToCheck[1], /"totalCreditsExited\(\)\(uint256\)"/);
  assert.match(body.reconcile.howToCheck[2], /^cast balance 0x0000000000000000000000000000000000000101 /);
  assert.match(body.reconcile.howToCheck[3], /^cast balance 0x000000000000000000000000000000000000dEaD /);
  assert.match(body.reconcile.howToCheck[4], /^cast balance 0x0000000000000000000000000000000000000104 /);
  assert.match(body.reconcile.howToCheck[5], /qbft_getValidatorsByBlockNumber/);
  assert.match(body.reconcile.howToCheck[6], /validator/);
  assert.deepEqual(keys(body.rpc), ["limits", "rateLimited24h", "throttledAgents"]);
  assert.deepEqual(keys(body.rpc.limits), ["ethCallStateWindowBlocks", "ethGetLogsMaxRange"]);
  assert.deepEqual(keys(body.indexer), ["bscCursor", "dbBytes", "layerCursor"]);
  assert.ok(Array.isArray(body.warnings));
});

test("§3.1：diff 的公式少掉 FeeSink 与签名者就会发散（回归用例）", async () => {
  const { ctx } = seeded();
  ctx.snapshot.reconcile.feeSinkBalance = "3125000000000000";
  const { body } = route(ctx, "GET", "/api/health", {});
  const issued = BigInt(body.reconcile.bscTotalIssued);
  const exited = BigInt(body.reconcile.bscTotalExited);
  const circ = BigInt(body.reconcile.layerCirculating);
  const naive = issued - exited - circ; // 旧写法
  assert.notEqual(naive, 0n, "旧写法本来就应该对不上，这条用例是防它被改回去");
  assert.equal(body.reconcile.diff, "0");
});

// ===================== §3.2 /api/summary =====================

test("§3.2 /api/summary：五个分组的字段名逐字一致", () => {
  const { ctx } = seeded();
  const { body } = route(ctx, "GET", "/api/summary", {});
  assert.equal(body.schema, "bac/summary/1");
  // 决策 #19（§7.7）：新增顶层 built（只有计数，没有金额）
  assert.deepEqual(keys(body), ["agents", "bridge", "built", "epoch", "gasFees", "layer", "schema", "treasury", "updatedAt", "validators"]);
  assert.deepEqual(keys(body.layer), ["blockTimeSec", "burnedTotal", "circulating", "contractsTotal", "head", "txTotal"]);
  assert.deepEqual(keys(body.agents), ["active", "banned", "challenged", "dormant", "retired", "total"]);
  assert.deepEqual(keys(body.treasury), [
    "lifetimeToBridge", "lifetimeToNodeFund", "nodeFundBalance", "nodeFundWithdrawn",
    "poolBalance", "taxFeeRateBps", "vaultAccounted", "vaultBalance",
  ]);
  assert.deepEqual(keys(body.bridge), ["currentReleaseBps", "halted", "lastSettledEpoch", "paused", "totalExited", "totalIssued", "totalLocked"]);
  assert.deepEqual(keys(body.validators), ["lifetimeFunded", "lifetimePaid", "nodes", "rewardBalance", "totalStaked"]);
  assert.deepEqual(keys(body.epoch), ["agreeingCount", "current", "disputingWeight", "lastFinal", "lastPosted", "state"]);
  // 决策 #17：gasFees 是层内 BAC，和 treasury（BSC 上的 BNB）分开两块，永远不合并
  assert.deepEqual(keys(body.gasFees), [
    "carryPool", "foundationWithdrawn", "lifetimeGap", "lifetimePoolClaimed", "lifetimeReceived",
    "lifetimeRemitted", "lifetimeToFoundation", "lifetimeToPool", "officialBlockValidatorBps",
    "proposers", "unit", "validatorBlockValidatorBps",
  ]);
  assert.equal(body.gasFees.unit, "BAC");
  assert.equal(body.gasFees.lifetimeReceived, "0", "没有 FINAL 锚点时不许拿实时数冒充已锚定的数");
  // taxFeeRateBps 必须出现：网站所有 50/50 的说明都写在这个基数上
  assert.equal(body.treasury.taxFeeRateBps, 1000);
  assert.equal(body.agents.total, 2);
  assert.equal(body.agents.active, 1);
  assert.equal(body.validators.nodes, 1);
});

// ===================== §3.3 /api/feed =====================

test("§3.3 /api/feed：条目字段逐字一致，含 anchored 与 anchoredThrough", () => {
  const { ctx } = seeded();
  const { body } = route(ctx, "GET", "/api/feed", {});
  assert.equal(body.schema, "bac/feed/1");
  assert.deepEqual(keys(body), ["anchoredThrough", "head", "items", "schema", "updatedAt"]);
  assert.deepEqual(keys(body.items[0]), ["agentId", "anchored", "block", "chain", "epoch", "id", "kind", "tx", "textZh", "ts"].sort());
  assert.equal(typeof body.items[0].anchored, "boolean");
  assert.equal(body.anchoredThrough, EPOCH);
  // agent 自己写的 summary 出库必须已转义
  const pub = body.items.find((i) => i.kind === "PUBLISH");
  assert.ok(pub.textZh.includes("&lt;b&gt;"));
  assert.ok(!pub.textZh.includes("<b>"));
});

test("§3.3 /api/feed：分页 before / after / limit / chain / kind / agentId", () => {
  const { ctx } = seeded();
  const all = route(ctx, "GET", "/api/feed", { limit: "200" }).body.items;
  assert.ok(all.length >= 6);

  const first2 = route(ctx, "GET", "/api/feed", { limit: "2" }).body.items;
  assert.equal(first2.length, 2);
  assert.ok(first2[0].id > first2[1].id, "默认按 id 倒序");

  const older = route(ctx, "GET", "/api/feed", { before: String(first2[1].id), limit: "2" }).body.items;
  assert.ok(older.every((i) => i.id < first2[1].id));

  const newer = route(ctx, "GET", "/api/feed", { after: "0", limit: "3" }).body.items;
  assert.ok(newer[0].id < newer[1].id, "after 是正序拉新");

  const layerOnly = route(ctx, "GET", "/api/feed", { chain: "layer", limit: "200" }).body.items;
  assert.ok(layerOnly.length > 0);
  assert.ok(layerOnly.every((i) => i.chain === "layer"));

  const kinds = route(ctx, "GET", "/api/feed", { kind: "DEPLOY,CALL", limit: "200" }).body.items;
  assert.ok(kinds.length >= 2);
  assert.ok(kinds.every((i) => i.kind === "DEPLOY" || i.kind === "CALL"));

  const byAgent = route(ctx, "GET", "/api/feed", { agentId: "17", limit: "200" }).body.items;
  assert.ok(byAgent.every((i) => i.agentId === 17));

  assert.throws(() => route(ctx, "GET", "/api/feed", { limit: "201" }), /limit 超出范围/);
  assert.throws(() => route(ctx, "GET", "/api/feed", { chain: "eth" }), /chain 只能是/);
});

// ===================== §3.4 / §3.5 agents =====================

test("§3.4 /api/agents：分页字段与条目字段逐字一致", () => {
  const { ctx } = seeded();
  const { body } = route(ctx, "GET", "/api/agents", {});
  assert.equal(body.schema, "bac/agents/1");
  assert.deepEqual(keys(body), ["items", "page", "pageSize", "schema", "total"]);
  assert.deepEqual(keys(body.items[0]), [
    "agentId", "agentURI", "announces", "controller", "credited", "deploys", "endpointHash", "exited",
    "lastHeartbeatEpoch", "lastLayerBlock", "layerBalance", "missed", "modelFingerprint",
    "registeredAt", "activatedAt", "solved", "status", "statusName", "wallet",
    // 决策 #19（§7.7）
    "tokensIssued", "pairsCreated", "swapCount",
  ].sort());
  assert.equal(body.total, 2);
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 50);

  const p = route(ctx, "GET", "/api/agents", { page: "2", pageSize: "1" }).body;
  assert.equal(p.items.length, 1);
  assert.equal(p.page, 2);
  assert.notEqual(p.items[0].agentId, body.items[0].agentId);

  const active = route(ctx, "GET", "/api/agents", { status: "active" }).body;
  assert.ok(active.items.every((i) => i.statusName === "ACTIVE"));
  assert.throws(() => route(ctx, "GET", "/api/agents", { status: "zzz" }), /status 只能是/);
  assert.throws(() => route(ctx, "GET", "/api/agents", { sort: "zzz" }), /sort 只能是/);
  for (const sort of ["newest", "actions", "deploys", "credited", "tokens", "swaps"]) {
    assert.equal(route(ctx, "GET", "/api/agents", { sort }).body.items.length, 2);
  }
});

test("§3.5 /api/agent/{id}：六个分组齐全，identity 带免责说明", () => {
  const { ctx } = seeded();
  const { body } = route(ctx, "GET", "/api/agent/17", {});
  assert.equal(body.schema, "bac/agent/1");
  assert.deepEqual(keys(body), [
    "actions", "agent", "contracts", "deposits", "escape", "exits", "identity", "schema",
    // 决策 #19（§7.7）
    "built", "trades", "holdings", "holdingsTruncated", "detection",
  ].sort());
  assert.deepEqual(keys(body.identity), [
    "agentURI", "endpointHashMatches", "note", "registrationsBackref", "uriCheckedAt", "uriReachable",
  ]);
  assert.match(body.identity.note, /不背书/);
  assert.deepEqual(keys(body.deposits[0]), ["bscTx", "credits", "depositId", "lagSec", "layerTx"]);
  assert.deepEqual(keys(body.exits[0]), ["anchorEpoch", "bornEpoch", "claimedTx", "collectedWei", "credits", "exitId", "layerTx", "lockedWei"]);
  assert.deepEqual(keys(body.contracts[0]), ["address", "block", "callCount", "classified", "classifiedZh", "codeSize", "symbol"]);
  assert.deepEqual(keys(body.actions[0]), ["block", "kind", "seq", "subject", "summary", "ts", "tx", "uri"]);
  assert.deepEqual(keys(body.escape), ["claimable", "halted", "weight"]);
  // actions[].summary 是原文（不可信），转义由渲染层负责，这里断言它没被悄悄改写
  assert.equal(body.actions[0].summary, "第一篇 <b>x</b>");
});

// ===================== §3.6 区块 / 交易 / 合约 =====================

test("§3.6 /api/blocks 与 /api/block/{n}", () => {
  const { ctx } = seeded();
  const list = route(ctx, "GET", "/api/blocks", {}).body;
  assert.equal(list.schema, "bac/blocks/1");
  assert.deepEqual(keys(list.items[0]), ["baseFee", "epoch", "gasLimit", "gasUsed", "hash", "number", "ts", "txCount"]);

  const one = route(ctx, "GET", "/api/block/1234560", {}).body;
  assert.deepEqual(keys(one), ["baseFee", "epoch", "gasLimit", "gasUsed", "hash", "number", "schema", "ts", "txCount", "txs"]);
  assert.equal(one.txs.length, 1);

  const ranged = route(ctx, "GET", "/api/blocks", { from: "1234560", to: "1234561" }).body;
  assert.equal(ranged.items.length, 2);
  assert.throws(() => route(ctx, "GET", "/api/blocks", { from: "9", to: "1" }), /to 不能小于 from/);
  assert.throws(() => route(ctx, "GET", "/api/block/999999", {}), /没有区块/);
});

test("§3.6 /api/tx/{hash}：tx / logs / decoded 三段", () => {
  const { ctx, db } = seeded();
  const deployTx = db.prepare("SELECT hash FROM txs WHERE created IS NOT NULL").get().hash;
  const { body } = route(ctx, "GET", `/api/tx/${deployTx}`, {});
  assert.equal(body.schema, "bac/tx/1");
  // 决策 #19（§7.7）：transfers[] 与 swaps[] 永远是数组，空数组和 null 不是一回事
  assert.deepEqual(keys(body), ["decoded", "detection", "logs", "schema", "swaps", "transfers", "tx"]);
  assert.deepEqual(body.transfers, []);
  assert.deepEqual(body.swaps, []);
  assert.deepEqual(keys(body.tx), [
    "agentId", "block", "created", "effGasPrice", "feeBurned", "feeToProposer", "from", "gasUsed",
    "hash", "idx", "status", "to", "ts", "value",
  ].sort());
  // 决策 #16/#17：zeroBaseFee 之后 feeBurned 恒为 "0"（字段保留不删），gas 费全额进出块者
  assert.equal(body.tx.feeBurned, "0");
  assert.equal(
    body.tx.feeToProposer,
    (BigInt(body.tx.gasUsed) * BigInt(body.tx.effGasPrice)).toString()
  );
  assert.equal(body.decoded, null, "这笔交易没有可解码的日志，decoded 必须是 null 而不是空数组");

  // 有日志的那笔：logs[] 的形状是 {address, topics, data}
  const actionTx = db.prepare("SELECT tx FROM actions LIMIT 1").get().tx;
  db.prepare("INSERT INTO txs (hash, block, idx, from_addr, to_addr, value, gas_used, eff_gas_price, fee_burned, created, status, agent_id, ts) VALUES (?,1010,0,?,?, '0', 21000, '0', '0', NULL, 1, 17, ?)")
    .run(actionTx, ADDR.agentWallet, ADDR.AgentBook, TS);
  const withLogs = route(ctx, "GET", `/api/tx/${actionTx}`, {}).body;
  assert.deepEqual(keys(withLogs.logs[0]), ["address", "data", "topics"]);
  assert.ok(Array.isArray(withLogs.logs[0].topics));
  assert.deepEqual(keys(withLogs.decoded[0]), ["args", "event"]);
  assert.equal(withLogs.decoded[0].event, "Action");

  assert.throws(() => route(ctx, "GET", "/api/tx/0xzz", {}), /交易哈希/);
  assert.throws(() => route(ctx, "GET", `/api/tx/0x${"1".repeat(64)}`, {}), /没有交易/);
});

test("§3.6 /api/contracts：总数、分页、按 agentId 过滤", () => {
  const { ctx } = seeded();
  const { body } = route(ctx, "GET", "/api/contracts", {});
  assert.equal(body.schema, "bac/contracts/1");
  assert.deepEqual(keys(body), ["detection", "items", "schema", "total"]);
  assert.deepEqual(keys(body.items[0]), ["address", "agentId", "block", "callCount", "classified", "classifiedZh", "codeSize", "deployer", "lastCall", "symbol", "ts"]);
  assert.equal(body.total, 1);
  assert.equal(route(ctx, "GET", "/api/contracts", { agentId: "18" }).body.total, 0);
  assert.equal(route(ctx, "GET", "/api/contracts", { page: "2", pageSize: "1" }).body.items.length, 0);
});

// ===================== 纪元 / 叶子 / 证明 =====================

test("/api/epochs 与 /api/epoch/{n}：含见证摘要与 attestations", () => {
  const { ctx } = seeded();
  const list = route(ctx, "GET", "/api/epochs", {}).body;
  assert.equal(list.schema, "bac/epochs/1");
  assert.equal(list.items[0].epoch, EPOCH);
  assert.equal(list.items[0].state, "FINAL");
  assert.equal(list.items[0].exitCount, 3);
  assert.equal(list.items[0].attestationCount, 1);
  assert.equal(list.items[0].agreeingAttestations, 1);

  const one = route(ctx, "GET", `/api/epoch/${EPOCH}`, {}).body;
  assert.equal(one.schema, "bac/epoch/1");
  assert.deepEqual(keys(one.attestations[0]), ["agreeing", "exitRoot", "l2Block", "l2BlockHash", "nodeId", "validator", "weight"]);
  assert.equal(one.attestations[0].agreeing, true);
  assert.equal(one.releaseBps, 350);
  assert.equal(one.pot, "1200");
  assert.throws(() => route(ctx, "GET", "/api/epoch/1", {}), /没有纪元/);
});

test("/api/epoch/{n}/leaves：构造证明所需的全部数据", () => {
  const { ctx } = seeded();
  const { body } = route(ctx, "GET", `/api/epoch/${EPOCH}/leaves`, {});
  assert.equal(body.schema, "bac/leaves/1");
  assert.deepEqual(keys(body), ["epoch", "exitRoot", "leaves", "proofFor", "schema"]);
  assert.equal(body.leaves.length, 3);
  assert.deepEqual(keys(body.leaves[0]), ["agentId", "credits", "exitId", "leaf", "to"]);
  assert.equal(body.exitRoot, exitRootOf(EXITS, 56777, ADDR.BacBridge));
  assert.match(body.proofFor, /\/api\/epoch\/\d+\/proof\/\{exitId\}/);
});

test("/api/epoch/{n}/proof/{exitId}：证明能重算出链上那个根", () => {
  const { ctx } = seeded();
  for (const ex of EXITS) {
    const { body } = route(ctx, "GET", `/api/epoch/${EPOCH}/proof/${ex.exitId}`, {});
    assert.equal(body.schema, "bac/proof/2");
    assert.deepEqual(keys(body), [
      "agentId", "anchorEpoch", "bornEpoch", "bridge", "credits", "exitId", "exitRoot", "layerChainId", "leaf", "proof", "schema", "to",
    ].sort());
    assert.equal(body.layerChainId, 56777);
    assert.equal(body.bridge, ADDR.BacBridge);
    assert.equal(body.anchorEpoch, EPOCH);
    assert.equal(body.bornEpoch, EPOCH);
    assert.equal(body.leaf, leafHash(ex, 56777, ADDR.BacBridge));
    assert.ok(verify(body.leaf, body.proof, body.exitRoot), `exitId=${ex.exitId} 的证明对不上`);
  }
  assert.throws(() => route(ctx, "GET", `/api/epoch/${EPOCH}/proof/99`, {}), /叶子里没有/);
});

// ===================== rate / validators / treasury / genesis =====================

test("/api/rate：字段齐全，并且带不承诺金额的说明", () => {
  const { ctx } = seeded();
  const { body } = route(ctx, "GET", "/api/rate", {});
  assert.equal(body.schema, "bac/rate/1");
  assert.deepEqual(keys(body), ["creditsOutstanding", "lastPot", "note", "owedTotal", "poolBalance", "schema", "weiPerCredit"]);
  assert.equal(body.note, "估算 · 不承诺任何金额");
  assert.equal(body.creditsOutstanding, "4880000000000000000000000");
  assert.equal(typeof body.weiPerCredit, "string");
});

test("/api/validators：条目字段逐字一致", () => {
  const { ctx } = seeded();
  const { body } = route(ctx, "GET", "/api/validators", {});
  assert.equal(body.schema, "bac/validators/1");
  assert.deepEqual(keys(body), ["items", "rewardBalance", "schema", "totalStaked"]);
  assert.deepEqual(keys(body.items[0]), [
    "active", "agreedEpochs", "disputedEpochs", "enodeURI", "lastEpoch", "lifetimeClaimed",
    "nodeId", "payout", "staked", "strikes", "validator",
  ]);
  assert.equal(body.items[0].validator, ADDR.validator);
  assert.equal(body.items[0].active, true);
  assert.equal(body.items[0].agreedEpochs, 1);
  assert.equal(body.totalStaked, "2000000");
});

test("/api/treasury：行字段逐字一致，支持 from/to", () => {
  const { ctx } = seeded();
  const { body } = route(ctx, "GET", "/api/treasury", {});
  assert.equal(body.schema, "bac/treasury/1");
  assert.deepEqual(keys(body.items[0]), [
    "bscBlock", "lifetimeToBridge", "lifetimeToNode", "marketAddressOk", "nodeFundBalance", "nodeFundWithdrawn",
    "poolBalance", "rewardBalance", "rewardFunded", "rewardPaid", "totalExited", "totalIssued", "totalLocked",
    "ts", "vaultAccounted", "vaultBalance", "vaultUnsplit",
  ]);
  assert.equal(route(ctx, "GET", "/api/treasury", { from: String(TS + 1) }).body.items.length, 0);
  assert.throws(() => route(ctx, "GET", "/api/treasury", { from: "9", to: "1" }), /to 不能小于 from/);
});

test("/api/genesis：本机没有文件时是 404，不是 500", () => {
  const { ctx } = seeded();
  assert.throws(() => route(ctx, "GET", "/api/genesis", {}), /genesis/);
});

// ===================== POST /rpc 的方法白名单 =====================

test("/rpc：白名单放行，非白名单 -32601", async () => {
  const { ctx } = seeded();
  const fake = { call: async (m) => `ok:${m}` };
  const ok = await rpcGuard(ctx, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), fake);
  assert.equal(ok.body.result, "ok:eth_blockNumber");

  for (const m of ["qbft_proposeValidatorVote", "miner_start", "admin_peers", "personal_unlockAccount", "debug_traceTransaction"]) {
    const bad = await rpcGuard(ctx, JSON.stringify({ jsonrpc: "2.0", id: 2, method: m }), fake);
    assert.equal(bad.body.error.code, -32601, `${m} 不该被放行`);
  }
  assert.ok(RPC_WHITELIST.has("eth_sendRawTransaction"));
  assert.ok(RPC_WHITELIST.has("qbft_getValidatorsByBlockNumber"));
  assert.ok(!RPC_WHITELIST.has("qbft_proposeValidatorVote"));
});

test("/rpc：eth_getLogs 必须带过滤且跨度不超过 5000", () => {
  const mk = (params) => checkCall({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params });
  assert.equal(mk([{ address: "0x1", fromBlock: "0x0", toBlock: "0x10" }]), null);
  assert.equal(mk([{ fromBlock: "0x0", toBlock: "0x10" }]).error.code, -32602);
  assert.equal(mk([{ address: "0x1", fromBlock: "0x0", toBlock: "0x1388" }]), null); // 正好 5000
  assert.equal(mk([{ address: "0x1", fromBlock: "0x0", toBlock: "0x1389" }]).error.code, -32602);
});

test("/rpc：限速超限返回 -32005（不是 HTTP 错误形状）", async () => {
  const { ctx } = seeded();
  ctx.upstream = { call: async () => "0x1" };
  const limiter = new RateLimiter({ perSec: 1, perMin: 100 });
  await withServer(ctx, async (base) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" });
    await fetch(`${base}/rpc`, { method: "POST", body, headers: { "content-type": "application/json" } });
    const res = await fetch(`${base}/rpc`, { method: "POST", body, headers: { "content-type": "application/json" } });
    assert.equal(res.status, 429);
    const j = await res.json();
    assert.equal(j.error.code, -32005);
  }, { limiter });
});

// ===================== §3.7 gas 费分账的三个端点（决策 #17） =====================

/** 造一个纪元的分账数据：两个出块者（官方 + 一个验证者），一笔池子领取。 */
function seedFees(db, epoch) {
  db.prepare(
    `INSERT OR REPLACE INTO epochs (epoch, state, proposer_income_root, gas_fees, gas_remitted, gas_gap,
       pool_accrued, pool_claimed, foundation_accrued, weight_total, weights_set_at, member_count)
     VALUES (?, 'FINAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    epoch, "0x" + "cd".repeat(32),
    "54000000000000000000", "54000000000000000000", "0",
    "5400000000000000000", "5399999999999999998", "48600000000000000000",
    "420000000000000000000000000", 1790012345, 1
  );
  db.prepare(
    `INSERT OR REPLACE INTO proposer_income (epoch, proposer, gas_income, remitted, gap, blocks, official, validator, anchored)
     VALUES (?,?,?,?,?,?,?,?,1)`
  ).run(epoch, "0x00000000000000000000000000000000000000f1", "40000000000000000000", "40000000000000000000", "0", 20000, 1, null);
  db.prepare(
    `INSERT OR REPLACE INTO proposer_income (epoch, proposer, gas_income, remitted, gap, blocks, official, validator, anchored)
     VALUES (?,?,?,?,?,?,?,?,1)`
  ).run(epoch, "0x00000000000000000000000000000000000000f2", "14000000000000000000", "14000000000000000000", "0", 8800, 0,
    "0x00000000000000000000000000000000000000v2".replace("v", "b"));
  db.prepare(
    `INSERT OR REPLACE INTO pool_claims (epoch, member, validator, weight, amount, to_addr, layer_tx, ts)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(epoch, "0x00000000000000000000000000000000000000c1", "0x00000000000000000000000000000000000000b2",
    "420000000000000000000000000", "5399999999999999998", "0x00000000000000000000000000000000000000c1",
    "0x" + "ef".repeat(32), 1790012400);
  db.prepare(
    `INSERT OR REPLACE INTO remittance (validator, proposer_addr, cum_owed, cum_remitted, arrears, shortfall, withheld, rights, qualify_streak, last_epoch)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run("0x00000000000000000000000000000000000000b2", "0x00000000000000000000000000000000000000f2",
    "14000000000000000000", "14000000000000000000", "0", 0, "0", 1, 30, epoch);
}

test("§3.7 /api/fees：单位是 BAC、规则常量写死、howToCheck 原样返回", () => {
  const { ctx, db } = seeded();
  seedFees(db, EPOCH);
  const { body } = route(ctx, "GET", "/api/fees", {});
  assert.equal(body.schema, "bac/fees/1");
  assert.equal(body.unit, "BAC", "§3.7 硬规则 1：每个返回体都要带单位");
  assert.equal(body.rules.officialBlockValidatorBps, 1000);
  assert.equal(body.rules.validatorBlockValidatorBps, 5000);
  assert.equal(body.rules.zeroBaseFee, true);
  // 对账三联：已收 / 已转入 / 差额
  assert.deepEqual(
    [body.reconcile.received, body.reconcile.remitted, body.reconcile.gap],
    ["54000000000000000000", "54000000000000000000", "0"]
  );
  assert.equal(body.reconcile.anchoredThrough, EPOCH);
  assert.equal(body.reconcile.howToCheck.length, 3);
  assert.match(body.reconcile.howToCheck[1], /remittedBy\(uint64,address\)/);
  assert.equal(body.splitter.address, "0x0000000000000000000000000000000000000104");
  // 不做任何收益预测：返回体里不许出现年化 / 预估字段（§3.7 硬规则 3）
  const j = JSON.stringify(body);
  assert.ok(!/apy|APY|annual|estimated|forecast/.test(j), "端点不许返回任何收益预测");
});

test("§3.7 /api/fees/{epoch}：余数必须显示出来，selfKept 官方恒为 0", () => {
  const { ctx, db } = seeded();
  seedFees(db, EPOCH);
  const { body } = route(ctx, "GET", `/api/fees/${EPOCH}`, {});
  assert.equal(body.schema, "bac/fee-epoch/1");
  assert.equal(body.unit, "BAC");
  assert.equal(body.anchored, true, "FINAL 锚点里报过的行才是 anchored");
  assert.equal(body.anchorState, "FINAL");
  assert.equal(body.received, "54000000000000000000");
  assert.equal(body.gap, "0");
  assert.equal(body.split.fromOfficialBlocks, "40000000000000000000");
  assert.equal(body.split.fromValidatorBlocks, "14000000000000000000");
  // remainder = accrued − Σ amount，哪怕只有 2 wei 也要显示
  assert.equal(body.pool.remainder, "2");
  assert.equal(body.pool.members.length, 1);
  assert.deepEqual(
    Object.keys(body.pool.members[0]).sort(),
    ["amount", "attend30", "claimedTx", "layerPayout", "staked", "validator", "weight"]
  );
  const official = body.proposers.find((r) => r.official);
  const validator = body.proposers.find((r) => !r.official);
  assert.equal(official.selfKept, "0", "官方不自留");
  assert.equal(validator.selfKept, "7000000000000000000", "验证者自留 gasIncome 的 50%");
});

test("§3.7 /api/fees/{epoch}：没有这个纪元就是 404，不编数据", () => {
  const { ctx } = seeded();
  assert.throws(() => route(ctx, "GET", "/api/fees/999999", {}), /没有纪元/);
});

test("§3.7 /api/proposers：按出块者聚合，官方那行必须带那句免责", () => {
  const { ctx, db } = seeded();
  seedFees(db, EPOCH);
  const { body } = route(ctx, "GET", "/api/proposers", { epochs: "30" });
  assert.equal(body.schema, "bac/proposers/1");
  assert.equal(body.unit, "BAC");
  assert.deepEqual(body.window, { from: EPOCH - 29, to: EPOCH });
  assert.equal(body.items.length, 2);
  const official = body.items.find((r) => r.official);
  assert.equal(official.blocks, 20000);
  assert.equal(official.gasIncome, "40000000000000000000");
  assert.equal(official.gap, "0");
  assert.match(official.note, /没有任何机制会因为它不归集而惩罚它/);
  const validator = body.items.find((r) => !r.official);
  assert.equal(validator.rights, true);
  assert.equal(validator.shortfall, false);
});

test("§3.7 health.gas：有 FINAL 锚点之后三联从锚点来，短缺列表逐条公开", () => {
  const { ctx, db } = seeded();
  seedFees(db, EPOCH);
  db.prepare("UPDATE remittance SET shortfall = 1, rights = 0, arrears = '5000000000000000000' WHERE validator = ?")
    .run("0x00000000000000000000000000000000000000b2");
  const { body } = route(ctx, "GET", "/api/health", {});
  assert.equal(body.gas.lastAnchoredEpoch, EPOCH);
  assert.equal(body.gas.received, "54000000000000000000");
  assert.equal(body.gas.gap, "0");
  assert.equal(body.gas.shortfalls.length, 1);
  assert.equal(body.gas.shortfalls[0].arrears, "5000000000000000000");
  // rights 已撤销时退回 last_epoch；§2 的 remittance 表没有 rights_revoked_at 列（文档内部不一致）
  assert.equal(body.gas.shortfalls[0].rightsRevokedAt, EPOCH);
});
