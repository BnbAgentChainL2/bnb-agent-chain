// test/built-api.test.js —— 03 §7.6 / §7.7 的每一个端点。
// 断言的是**确切的字段名**：这些名字是契约，改一个就要同时改索引器、API、网站数据层、SDK。
// 用的是 test/built-helpers.js 里那条完整剧本：#17 发币、#21 发第二个币并建池、#30 成交。
import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/api/server.js";
import { DETECTION_NOTE } from "../src/economy/constants.js";
import { cleanupTempDbs, TEST_CFG } from "./helpers.js";
import { A, scenario, e18, e6, T } from "./built-helpers.js";

test.after(cleanupTempDbs);

const keys = (o) => Object.keys(o).sort();

async function ctxOf() {
  const { db, rpc, tx } = await scenario();
  return { ctx: { db, cfg: TEST_CFG, snapshot: {} }, db, rpc, tx };
}

/** §7.6：每个返回体都必须带的那个块，一字不改。 */
function assertDetection(d, { unclassified }) {
  assert.deepEqual(keys(d), ["method", "note", "rulesUrl", "unclassifiedContracts"]);
  assert.equal(d.method, "heuristic");
  assert.equal(d.note, DETECTION_NOTE);
  assert.match(d.note, /本链没有官方 DEX、官方代币或官方工具合约/);
  // 解码规则说明页还不存在（03 的 [待定] 第 7 条），所以这里是 null，前端退化成纯文字说明。
  assert.equal(d.rulesUrl, null);
  assert.equal(d.unclassifiedContracts, unclassified);
}

// ===================== /api/tokens =====================

test("§7.6 GET /api/tokens：分页字段与条目字段逐字一致", async () => {
  const { ctx } = await ctxOf();
  const { body } = route(ctx, "GET", "/api/tokens", {});
  assert.equal(body.schema, "bac/tokens/1");
  assert.deepEqual(keys(body), ["detection", "items", "page", "pageSize", "schema", "total", "updatedAt"]);
  assertDetection(body.detection, { unclassified: 1 });
  assert.equal(body.total, 2);
  assert.deepEqual(keys(body.items[0]), [
    "address", "balanceDrift", "burns", "creator", "decimals", "deployBlock", "deployTs", "deployTx",
    "detectLevel", "firstTs", "holders", "lastTs", "mints", "name", "nameTrusted", "pairCount",
    "sameNameCount", "supplyBlock", "swapCount", "symbol", "totalSupply", "transfers", "zeroOnly",
  ]);
  const fuel = body.items.find((t) => t.symbol === "FUEL");
  assert.equal(fuel.address, A.tokenA);
  assert.equal(fuel.name, "Agent Fuel");
  assert.equal(fuel.decimals, 18);
  assert.equal(fuel.nameTrusted, false, "恒为 false：它存在的唯一目的是让前端没法忘记这件事");
  assert.equal(fuel.totalSupply, e18(1000000).toString());
  assert.deepEqual(fuel.creator, { agentId: 17, wallet: A.w17 });
  assert.equal(fuel.holders, 4);
  assert.equal(fuel.transfers, 6);
  assert.equal(fuel.mints, 1);
  assert.equal(fuel.burns, 1);
  assert.equal(fuel.pairCount, 1);
  assert.equal(fuel.swapCount, 1);
  assert.equal(fuel.detectLevel, "full");
  assert.equal(fuel.balanceDrift, false);
  assert.equal(fuel.zeroOnly, false);
  assert.equal(fuel.sameNameCount, 0);
});

test("§7.6 GET /api/tokens：排序、过滤、q 与参数校验", async () => {
  const { ctx } = await ctxOf();
  const get = (q) => route(ctx, "GET", "/api/tokens", q).body;
  assert.equal(get({ agentId: "17" }).total, 1);
  assert.equal(get({ agentId: "17" }).items[0].symbol, "FUEL");
  assert.equal(get({ agentId: "99" }).total, 0);
  assert.equal(get({ q: "FUE" }).items.length, 1, "q 只做字面前缀匹配");
  assert.equal(get({ q: A.tokenB }).items[0].symbol, "BACX", "q 也接受完整地址");
  assert.equal(get({ q: "zzz" }).items.length, 0);
  assert.equal(get({ level: "full" }).total, 2);
  assert.equal(get({ level: "partial" }).total, 0);
  for (const sort of ["newest", "holders", "transfers", "swaps", "activity"]) {
    assert.equal(get({ sort }).items.length, 2);
  }
  assert.throws(() => get({ sort: "zzz" }), /sort 只能是/);
  assert.throws(() => get({ level: "zzz" }), /level 只能是/);
  assert.throws(() => get({ includeZeroOnly: "2" }), /includeZeroOnly/);
  assert.throws(() => get({ q: "x".repeat(65) }), /64 字节/);
});

// ===================== /api/token/{address} =====================

test("§7.6 GET /api/token/{address}：七个分组齐全，supplyCheck 与 topHolders 逐字一致", async () => {
  const { ctx } = await ctxOf();
  const { body } = route(ctx, "GET", `/api/token/${A.tokenA}`, {});
  assert.equal(body.schema, "bac/token/1");
  assert.deepEqual(keys(body), [
    "creatorActions", "detection", "events", "pairs", "recentTransfers", "schema",
    "supplyCheck", "token", "topHolders", "updatedAt",
  ]);
  assertDetection(body.detection, { unclassified: 1 });

  assert.deepEqual(keys(body.supplyCheck), [
    "derivedHolderSum", "drift", "driftCheckedAt", "note", "onchainTotalSupply",
  ]);
  assert.equal(body.supplyCheck.onchainTotalSupply, e18(1000000).toString());
  assert.equal(body.supplyCheck.derivedHolderSum, e18(1000000).toString());
  assert.equal(body.supplyCheck.drift, "0");
  assert.match(body.supplyCheck.note, /以链上为准/);

  assert.deepEqual(keys(body.topHolders[0]), ["address", "agentId", "balance", "isContract", "rank", "role", "shareBps"]);
  assert.equal(body.topHolders[0].rank, 1);
  assert.equal(body.topHolders[0].address, A.w17, "发币的那个 agent 手里还留着大头");
  assert.equal(body.topHolders[0].balance, e18(789000).toString());
  assert.equal(body.topHolders[0].agentId, 17);
  assert.equal(body.topHolders[0].role, null);
  assert.equal(body.topHolders[0].shareBps, 7890);
  // 池子里的钱必须能标成「交易对合约」，否则「第二大户占 10%」这句话是误导
  const pool = body.topHolders.find((h) => h.address === A.pair);
  assert.equal(pool.role, "pair");
  assert.equal(pool.isContract, true);
  assert.equal(pool.balance, e18(101000).toString());
  assert.equal(pool.shareBps, 1010);
  // 0x…dEaD 不出现在持有人里
  assert.ok(!body.topHolders.some((h) => h.address === A.dead));

  assert.deepEqual(keys(body.pairs[0]), ["address", "kind", "other", "reserve0", "reserve1", "swapCount"]);
  assert.equal(body.pairs[0].address, A.pair);
  assert.deepEqual(body.pairs[0].other, { address: A.tokenB, symbol: "BACX", decimals: 6, known: true });

  assert.deepEqual(keys(body.recentTransfers[0]), [
    "block", "cursor", "from", "fromAgentId", "kind", "logIndex", "to", "toAgentId", "ts", "tx", "value",
  ]);
  assert.equal(body.recentTransfers[0].kind, "burn", "最新的一条是烧币");
  assert.equal(body.recentTransfers[0].to, A.dead);

  assert.deepEqual(keys(body.events[0]), ["block", "detail", "kind", "rule", "ts"]);
  assert.equal(body.events[0].kind, "DETECTED");
  assert.deepEqual(body.creatorActions, []);
});

test("§7.6 GET /api/token/{address}：地址不合法 400；不是代币的地址 404 且带 contract 指路", async () => {
  const { ctx } = await ctxOf();
  assert.throws(() => route(ctx, "GET", "/api/token/0xzz", {}), /42 字符地址/);
  try {
    route(ctx, "GET", `/api/token/${A.plain}`, {});
    assert.fail("应该 404");
  } catch (e) {
    assert.equal(e.status, 404);
    assert.equal(e.code, "not_found");
    assert.equal(e.message, "这个地址没有被识别为代币");
    // **不要只回一个空的 404** —— 前端要能把人接到合约页去
    assert.equal(e.extra.contract.address, A.plain);
    assert.equal(e.extra.contract.url, `/api/contract/${A.plain}`);
    assert.equal(e.extra.contract.classified, null);
    assert.match(e.extra.contract.classifiedZh, /我们没能识别出这个合约是什么/);
  }
});

// ===================== /api/token/{address}/holders =====================

test("§7.6 GET /api/token/{address}/holders：固定按余额倒序，burned 单独一行", async () => {
  const { ctx } = await ctxOf();
  const { body } = route(ctx, "GET", `/api/token/${A.tokenA}/holders`, {});
  assert.equal(body.schema, "bac/token-holders/1");
  assert.deepEqual(keys(body), [
    "balanceDrift", "burned", "detection", "items", "page", "pageSize", "schema", "token", "total", "updatedAt",
  ]);
  assert.equal(body.token, A.tokenA);
  assert.equal(body.total, 4, "两个销毁地址不计入持有人");
  assert.equal(body.balanceDrift, false);
  assert.deepEqual(keys(body.items[0]), [
    "address", "agentId", "balance", "firstTs", "inTotal", "isContract", "lastTs", "outTotal",
    "rank", "role", "shareBps", "txCount",
  ]);
  const bal = body.items.map((i) => BigInt(i.balance));
  assert.deepEqual([...bal].sort((a, b) => (a > b ? -1 : 1)), bal, "余额必须严格倒序");
  assert.deepEqual(body.burned, {
    amount: e18(1000).toString(),
    addresses: ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"],
  });
  // 分页稳定：第二页不会和第一页重复
  const p1 = route(ctx, "GET", `/api/token/${A.tokenA}/holders`, { pageSize: "2", page: "1" }).body;
  const p2 = route(ctx, "GET", `/api/token/${A.tokenA}/holders`, { pageSize: "2", page: "2" }).body;
  assert.equal(p1.items.length, 2);
  assert.equal(p2.items.length, 2);
  assert.equal(p2.items[0].rank, 3);
  assert.equal(new Set([...p1.items, ...p2.items].map((i) => i.address)).size, 4);
});

// ===================== /api/token/{address}/transfers =====================

test("§7.6 GET /api/token/{address}/transfers：游标是 {block}:{logIndex}，过滤与校验齐全", async () => {
  const { ctx } = await ctxOf();
  const get = (q) => route(ctx, "GET", `/api/token/${A.tokenA}/transfers`, q).body;
  const body = get({});
  assert.equal(body.schema, "bac/token-transfers/1");
  assert.deepEqual(keys(body), ["detection", "items", "next", "schema", "token", "updatedAt"]);
  assert.equal(body.items.length, 6);
  assert.equal(body.items[0].cursor, "107:0");
  assert.equal(body.next, null, "没有更多了就是 null");

  const page1 = get({ limit: "2" });
  assert.equal(page1.items.length, 2);
  assert.deepEqual(page1.items.map((i) => i.cursor), ["107:0", "106:0"]);
  assert.equal(page1.next, "106:0");
  const page2 = get({ limit: "2", before: page1.next });
  assert.deepEqual(page2.items.map((i) => i.cursor), ["105:0", "104:1"]);
  assert.equal(page2.items[0].to, A.pair);

  assert.equal(get({ kind: "mint" }).items.length, 1);
  assert.equal(get({ kind: "burn" }).items.length, 1);
  assert.equal(get({ kind: "transfer" }).items.length, 4);
  assert.equal(get({ address: A.w30, direction: "in" }).items.length, 1);
  assert.equal(get({ address: A.w30, direction: "out" }).items.length, 1);
  assert.throws(() => get({ direction: "in" }), /direction 必须与 address 同时给/);
  assert.throws(() => get({ kind: "zzz" }), /kind 只能是/);
  assert.throws(() => get({ before: "abc" }), /block.*logIndex/);
});

// ===================== /api/pairs 与 /api/pair/{address} =====================

test("§7.6 GET /api/pairs：条目字段逐字一致，reserveSource 与 detectLevel 都在", async () => {
  const { ctx, tx } = await ctxOf();
  const { body } = route(ctx, "GET", "/api/pairs", {});
  assert.equal(body.schema, "bac/pairs/1");
  assert.deepEqual(keys(body), ["detection", "items", "page", "pageSize", "schema", "total", "updatedAt"]);
  assert.equal(body.total, 1);
  const p = body.items[0];
  assert.deepEqual(keys(p), [
    "address", "burnCount", "creator", "deployBlock", "deployTs", "deployTx", "detectLevel",
    "discoveredVia", "factory", "feePpm", "firstTs", "kind", "lastPrice", "lastPriceBlock", "lastTs",
    "mintCount", "reserve0", "reserve1", "reserveBlock", "reserveSource", "swapCount",
    "tickSpacing", "token0", "token1", "vol0", "vol1", "volSkipped",
  ]);
  assert.equal(p.address, A.pair);
  assert.equal(p.kind, "v2");
  assert.equal(p.discoveredVia, "factory");
  assert.deepEqual(p.factory, { address: A.factory, creatorAgentId: 21 });
  assert.deepEqual(p.token0, { address: A.tokenA, symbol: "FUEL", decimals: 18, known: true });
  assert.deepEqual(p.token1, { address: A.tokenB, symbol: "BACX", decimals: 6, known: true });
  assert.deepEqual(p.creator, { agentId: 21, wallet: A.w21 });
  assert.equal(p.deployTx, tx.createPair);
  assert.equal(p.reserve0, e18(101000).toString());
  assert.equal(p.reserve1, e6(198020).toString());
  assert.equal(p.reserveSource, "getReserves");
  assert.equal(p.feePpm, null, "V2 的费率写死在代码里，读不出来");
  assert.equal(p.tickSpacing, null);
  assert.equal(p.swapCount, 1);
  assert.equal(p.vol0, e18(1000).toString());
  assert.equal(p.vol1, e6(1980).toString());
  assert.equal(p.volSkipped, 0);
  assert.equal(p.mintCount, 1);
  assert.equal(p.lastPrice, "1980000000000000000");
  assert.equal(p.detectLevel, "full");

  // 过滤
  const byToken = route(ctx, "GET", "/api/pairs", { token: A.tokenB }).body;
  assert.equal(byToken.total, 1);
  assert.equal(route(ctx, "GET", "/api/pairs", { kind: "v3" }).body.total, 0);
  assert.equal(route(ctx, "GET", "/api/pairs", { agentId: "21" }).body.total, 1);
  assert.throws(() => route(ctx, "GET", "/api/pairs", { kind: "v9" }), /kind 只能是/);
});

test("§7.6 GET /api/pair/{address}：price 块带来源与免责，V2 时没有 v3Note", async () => {
  const { ctx } = await ctxOf();
  const { body } = route(ctx, "GET", `/api/pair/${A.pair}`, {});
  assert.equal(body.schema, "bac/pair/1");
  assert.deepEqual(keys(body), ["detection", "liquidity", "pair", "price", "recentSwaps", "schema", "updatedAt"]);
  assert.ok(!("v3Note" in body), "V2 时 v3Note 不出现");
  assert.deepEqual(keys(body.price), ["atBlock", "note", "price0Per1", "price1Per0", "source"]);
  assert.equal(body.price.source, "reserves");
  assert.equal(body.price.atBlock, 106);
  // 198020e6 * 10^(18+18) / (101000e18 * 10^6)，整数除法
  assert.equal(body.price.price1Per0, "1960594059405940594");
  // 101000e18 * 10^(18+6) / (198020e6 * 10^18)，同样是整数除法，由 API 反向现算（不入库）
  assert.equal(body.price.price0Per1, "510049489950510049");
  assert.match(body.price.note, /不是行情价/);
  assert.match(body.price.note, /没有预言机/);
  // 返回体里不许出现任何法币或 BAC 折算值
  assert.ok(!JSON.stringify(body).includes("usd"));
  assert.ok(!JSON.stringify(body).includes("marketCap"));

  assert.equal(body.recentSwaps.length, 1);
  assert.deepEqual(keys(body.liquidity[0]), ["agentId", "amount0", "amount1", "block", "kind", "ts", "tx"]);
  assert.equal(body.liquidity[0].kind, "add");
  assert.throws(() => route(ctx, "GET", `/api/pair/${A.tokenA}`, {}), /没有被识别为交易对/);
});

// ===================== /api/swaps =====================

test("§7.6 GET /api/swaps：条目字段逐字一致，side 相对 token0，agent 取 tx.from", async () => {
  const { ctx, tx } = await ctxOf();
  const { body } = route(ctx, "GET", "/api/swaps", {});
  assert.equal(body.schema, "bac/swaps/1");
  assert.deepEqual(keys(body), ["anchoredThrough", "detection", "items", "next", "schema", "updatedAt"]);
  const s = body.items[0];
  assert.deepEqual(keys(s), [
    "agentId", "amountIn", "amountOut", "block", "cursor", "epoch", "logIndex", "normalized",
    "pair", "price1Per0", "recipient", "sender", "side", "tokenIn", "tokenOut", "ts", "tx", "txFrom",
  ]);
  assert.equal(s.cursor, "106:2");
  assert.equal(s.epoch, Math.floor((T + 18) / 600), "600 秒的结算纪元，与 epochs 表同一个单位");
  assert.deepEqual(keys(s.pair), ["address", "kind", "token0", "token1"]);
  assert.deepEqual(s.pair.token0, { address: A.tokenA, symbol: "FUEL", decimals: 18, known: true });
  assert.equal(s.agentId, 30, "归属取 tx.from，不是 sender / recipient");
  assert.equal(s.txFrom, A.w30);
  assert.equal(s.tx, tx.swap);
  assert.equal(s.side, "sell0");
  assert.equal(s.tokenIn, A.tokenA);
  assert.equal(s.amountIn, e18(1000).toString());
  assert.equal(s.tokenOut, A.tokenB);
  assert.equal(s.amountOut, e6(1980).toString());
  assert.equal(s.price1Per0, "1980000000000000000");
  assert.equal(s.normalized, true);

  assert.equal(route(ctx, "GET", "/api/swaps", { agentId: "30" }).body.items.length, 1);
  assert.equal(route(ctx, "GET", "/api/swaps", { agentId: "17" }).body.items.length, 0);
  assert.equal(route(ctx, "GET", "/api/swaps", { token: A.tokenB }).body.items.length, 1);
  assert.equal(route(ctx, "GET", "/api/swaps", { pair: A.pair }).body.items.length, 1);
  assert.equal(route(ctx, "GET", "/api/swaps", { normalized: "0" }).body.items.length, 0);
  assert.equal(route(ctx, "GET", "/api/swaps", { normalized: "1" }).body.items.length, 1);
  assert.throws(() => route(ctx, "GET", "/api/swaps", { normalized: "2" }), /normalized 只能是/);
});

// ===================== /api/contract/{address} =====================

test("§7.6 GET /api/contract/{address}：四种分类各给一句中文，认不出来那句必须照实说", async () => {
  const { ctx } = await ctxOf();
  const tk = route(ctx, "GET", `/api/contract/${A.tokenA}`, {}).body;
  assert.equal(tk.schema, "bac/contract/1");
  assert.deepEqual(keys(tk), [
    "callers", "classified", "classifiedZh", "contract", "detection", "events", "factory",
    "pair", "probe", "schema", "token", "updatedAt",
  ]);
  assert.deepEqual(keys(tk.contract), [
    "address", "agentId", "block", "callCount", "codeSize", "deployer", "lastCall", "ts", "tx",
  ]);
  assert.equal(tk.classified, "token");
  assert.equal(tk.classifiedZh, "这是一个代币");
  assert.equal(tk.token.symbol, "FUEL");
  assert.equal(tk.pair, null);
  assert.equal(tk.factory, null);
  assert.deepEqual(keys(tk.probe), ["attempts", "lastError", "probeBlock", "probedAt", "state"]);
  assert.equal(tk.probe.state, "token");
  assert.deepEqual(keys(tk.callers[0]), ["agentId", "calls", "lastTs"]);

  const pr = route(ctx, "GET", `/api/contract/${A.pair}`, {}).body;
  assert.equal(pr.classified, "pair");
  assert.equal(pr.classifiedZh, "这是一个交易对");
  assert.equal(pr.contract.deployer, null, "CREATE2 出来的池子没有部署记录，照实写 null，不许猜");

  const fa = route(ctx, "GET", `/api/contract/${A.factory}`, {}).body;
  assert.equal(fa.classified, "factory");
  assert.equal(fa.classifiedZh, "这是一个交易对工厂");
  assert.equal(fa.factory.pairCount, 1);

  const un = route(ctx, "GET", `/api/contract/${A.plain}`, {}).body;
  assert.equal(un.classified, null);
  assert.equal(
    un.classifiedZh,
    "我们没能识别出这个合约是什么。它照样是 agent 造出来的东西，只是不在我们的解码规则里。"
  );
  assert.equal(un.probe.state, "not_token");
  assert.throws(() => route(ctx, "GET", `/api/contract/${A.zero}`, {}), /没有合约/);
});

// ===================== §7.7 既有端点的增量 =====================

test("§7.7 /api/summary 的 built：只有计数，没有金额", async () => {
  const { ctx } = await ctxOf();
  const { body } = route(ctx, "GET", "/api/summary", {});
  assert.deepEqual(keys(body.built), [
    "detection", "factories", "firstPairTs", "firstTokenTs", "pairs", "swaps", "tokens",
    "transfers", "unclassifiedContracts",
  ]);
  assert.equal(body.built.tokens, 2);
  assert.equal(body.built.pairs, 1);
  assert.equal(body.built.factories, 1);
  assert.equal(body.built.swaps, 1);
  assert.equal(body.built.transfers, 9, "两个代币的 Transfer 加起来：6 + 3");
  assert.equal(body.built.unclassifiedContracts, 1);
  assert.equal(body.built.firstTokenTs, T);
  assert.equal(body.built.firstPairTs, T + 9);
  assertDetection(body.built.detection, { unclassified: 1 });
  // built 里不许出现任何金额字段（和 treasury / gasFees 一样，不得合并成一个「总量」）
  for (const [k, v] of Object.entries(body.built)) {
    if (k === "detection") continue;
    assert.ok(v === null || typeof v === "number", `built.${k} 必须是计数或时间戳，不能是金额字符串`);
  }
});

test("§7.7 /api/agent/{id}：built / trades / holdings 三块", async () => {
  const { ctx } = await ctxOf();
  const a17 = route(ctx, "GET", "/api/agent/17", {}).body;
  assert.deepEqual(keys(a17.built), ["factories", "pairs", "tokens"]);
  assert.equal(a17.built.tokens.length, 1);
  assert.equal(a17.built.tokens[0].symbol, "FUEL");
  assert.equal(a17.built.pairs.length, 0);
  assert.equal(a17.trades.swapCount, 0);
  assert.deepEqual(keys(a17.trades), ["firstTs", "lastTs", "pairs", "recent", "swapCount"]);
  assert.equal(a17.trades.firstTs, null);
  assert.deepEqual(keys(a17.holdings[0]), ["balance", "balanceDrift", "decimals", "shareBps", "symbol", "token"]);
  const fuel = a17.holdings.find((h) => h.token === A.tokenA);
  assert.equal(fuel.balance, e18(789000).toString());
  assert.equal(fuel.shareBps, 7890);
  assert.equal(a17.holdingsTruncated, false);
  // contracts[] 每个元素追加了分类
  const c = a17.contracts.find((x) => x.address === A.tokenA);
  assert.equal(c.classified, "token");
  assert.equal(c.classifiedZh, "这是一个代币");
  assert.equal(c.symbol, "FUEL");

  const a21 = route(ctx, "GET", "/api/agent/21", {}).body;
  assert.equal(a21.built.pairs.length, 1);
  assert.equal(a21.built.factories.length, 1);
  assert.deepEqual(keys(a21.built.factories[0]), [
    "address", "deployBlock", "deployTx", "firstTs", "kind", "lastTs", "pairCount",
  ]);

  const a30 = route(ctx, "GET", "/api/agent/30", {}).body;
  assert.equal(a30.trades.swapCount, 1);
  assert.equal(a30.trades.firstTs, T + 18);
  assert.deepEqual(a30.trades.pairs, [{ address: A.pair, swaps: 1 }]);
  assert.equal(a30.trades.recent.length, 1);
  assert.equal(a30.trades.recent[0].side, "sell0");
  // 它部署的那个认不出来的合约，照实写 null + 一句中文
  const plain = a30.contracts.find((x) => x.address === A.plain);
  assert.equal(plain.classified, null);
  assert.match(plain.classifiedZh, /我们没能识别出这个合约是什么/);
});

test("§7.7 /api/agents：每个元素追加三个计数，sort 新增 tokens / swaps", async () => {
  const { ctx } = await ctxOf();
  const { body } = route(ctx, "GET", "/api/agents", {});
  const byId = Object.fromEntries(body.items.map((i) => [i.agentId, i]));
  assert.equal(byId[17].tokensIssued, 1);
  assert.equal(byId[17].pairsCreated, 0);
  assert.equal(byId[17].swapCount, 0);
  assert.equal(byId[21].tokensIssued, 1);
  assert.equal(byId[21].pairsCreated, 1);
  assert.equal(byId[30].swapCount, 1);
  assert.equal(route(ctx, "GET", "/api/agents", { sort: "tokens" }).body.items.length, 3);
  assert.equal(route(ctx, "GET", "/api/agents", { sort: "swaps" }).body.items[0].agentId, 30);
});

test("§7.7 /api/contracts：address / classified 两个参数，元素追加三个字段", async () => {
  const { ctx } = await ctxOf();
  const all = route(ctx, "GET", "/api/contracts", {}).body;
  assert.equal(all.total, 4, "两个代币 + 一个工厂 + 一个认不出来的合约（池子是 CREATE2 出来的，没有部署记录）");
  const one = route(ctx, "GET", "/api/contracts", { address: A.tokenB }).body;
  assert.equal(one.total, 1);
  assert.equal(one.items[0].symbol, "BACX");
  assert.equal(route(ctx, "GET", "/api/contracts", { classified: "token" }).body.total, 2);
  assert.equal(route(ctx, "GET", "/api/contracts", { classified: "factory" }).body.total, 1);
  assert.equal(route(ctx, "GET", "/api/contracts", { classified: "pair" }).body.total, 0);
  const none = route(ctx, "GET", "/api/contracts", { classified: "none" }).body;
  assert.equal(none.total, 1);
  assert.equal(none.items[0].address, A.plain);
  assert.throws(() => route(ctx, "GET", "/api/contracts", { classified: "zzz" }), /classified 只能是/);
});

test("§7.7 /api/tx/{hash} 与 /api/block/{n}：transfers / swaps 永远是数组", async () => {
  const { ctx, tx } = await ctxOf();
  const swapTx = route(ctx, "GET", `/api/tx/${tx.swap}`, {}).body;
  assert.ok(Array.isArray(swapTx.transfers));
  assert.ok(Array.isArray(swapTx.swaps));
  assert.equal(swapTx.transfers.length, 2);
  assert.equal(swapTx.swaps.length, 1);
  assert.equal(swapTx.swaps[0].side, "sell0");

  const emptyTx = route(ctx, "GET", `/api/tx/${tx.deployFac}`, {}).body;
  assert.deepEqual(emptyTx.transfers, [], "空数组和 null 不是一回事");
  assert.deepEqual(emptyTx.swaps, []);

  const b = route(ctx, "GET", "/api/block/106", {}).body;
  assert.equal(b.txs[0].swapCount, 1);
  assert.equal(b.txs[0].transferCount, 2);
  const b102 = route(ctx, "GET", "/api/block/102", {}).body;
  assert.equal(b102.txs[0].swapCount, 0);
  assert.equal(b102.txs[0].transferCount, 0);
});

test("§7.7 /api/feed：三个新 kind 都在，成交不进 feed", async () => {
  const { ctx } = await ctxOf();
  const { body } = route(ctx, "GET", "/api/feed", { limit: "200" });
  const kinds = new Set(body.items.map((i) => i.kind));
  assert.ok(kinds.has("TOKEN_NEW"));
  assert.ok(kinds.has("PAIR_NEW"));
  assert.ok(kinds.has("TOKEN_FIRST_TRADE"));
  assert.ok(!kinds.has("SWAP"), "成交有自己的 /api/swaps 流水页，不许淹没 feed");
  const tn = body.items.find((i) => i.kind === "TOKEN_NEW" && i.textZh.includes("FUEL"));
  assert.equal(tn.agentId, 17);
  assert.equal(tn.chain, "layer");
  assert.match(tn.textZh, /总量 1000000000000000000000000/);
});
