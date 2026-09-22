// src/api/handlers.js —— 03 §3 的每一个端点。
// 每个 handler 都是纯函数：(ctx, params) -> { status, body }，不碰 socket，测试可以直接调。
// 字段名逐字对齐 03 §3，一个字母都不许改。
import { STATUS_NAME, STATUS_CODE, GENESIS_SUPPLY, FEE_SINK, FEE_SPLITTER, LAYER_SYSTEM_ADDRESSES } from "../abi.js";
import { listWarnings } from "../warnings.js";
import { root as exitRootOf, leafHash, proof as proofOf, ZERO_ROOT } from "../exit-tree.js";
import { anchoredThrough } from "../store.js";

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const badRequest = (m) => new ApiError("bad_request", m, 400);
export const notFound = (m) => new ApiError("not_found", m, 404);

const nowSec = () => Math.floor(Date.now() / 1000);

function intParam(v, def, { min = 0, max = Number.MAX_SAFE_INTEGER, name = "参数" } = {}) {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`${name} 必须是整数`);
  if (n < min || n > max) throw badRequest(`${name} 超出范围 ${min}..${max}`);
  return n;
}

const s = (v) => (v === null || v === undefined ? null : String(v));
const n = (v) => (v === null || v === undefined ? null : Number(v));

// ===================== §3.1 /api/health =====================

/** reconcile.howToCheck 必须原样返回：任何人用这七条 cast 就能自己复算 diff（03 §3.1）。 */
export function howToCheck(cfg) {
  const bridge = (cfg.addresses && cfg.addresses.BacBridge) || "<BacBridge>";
  const rpc = cfg.bscRpc;
  const layerRpc = `${cfg.apiBase}/rpc`;
  return [
    `cast call ${bridge} "totalCreditsIssued()(uint256)" --rpc-url ${rpc}`,
    `cast call ${bridge} "totalCreditsExited()(uint256)" --rpc-url ${rpc}`,
    `cast balance ${LAYER_SYSTEM_ADDRESSES.L2Bridge} --rpc-url ${layerRpc}`,
    `cast balance ${FEE_SINK} --rpc-url ${layerRpc}`,
    `cast balance ${FEE_SPLITTER} --rpc-url ${layerRpc}`,
    `cast rpc qbft_getValidatorsByBlockNumber latest --rpc-url ${layerRpc}`,
    `cast balance <每一个历史出现过的 validator 地址> --rpc-url ${layerRpc}`,
  ];
}

/**
 * diff 的公式只有这一个（03 §3.1）：
 *   diff = (bscTotalIssued − bscTotalExited)
 *        − (layerCirculating + balance(FeeSink) + balance(FeeSplitter) + Σ balance(everValidator))
 * 少掉后面几项它会从第一笔交易 / 第一笔归集起单调发散，那条 5 分钟告警就会被运维关掉，
 * 而那条告警是发现中继超发的唯一手段。
 * 决策 #17 之后：FeeSplitter（0x…0104）必须减；QBFT 下出块者可变，所以单个 signerBalance
 * 已换成 validatorBalances[] 数组，按 everValidator 累积表逐个读。
 */
export function computeReconcile(r) {
  const issued = BigInt(r.bscTotalIssued ?? "0");
  const exited = BigInt(r.bscTotalExited ?? "0");
  const circ = BigInt(r.layerCirculating ?? "0");
  const sink = BigInt(r.feeSinkBalance ?? "0");
  const splitter = BigInt(r.feeSplitterBalance ?? "0");
  const vals = (r.validatorBalances ?? []).map((v) => ({
    addr: v.addr,
    balance: BigInt(v.balance ?? "0").toString(),
  }));
  const vSum = vals.reduce((a, v) => a + BigInt(v.balance), 0n);
  const diff = issued - exited - (circ + sink + splitter + vSum);
  return {
    bscTotalIssued: issued.toString(),
    bscTotalExited: exited.toString(),
    layerCirculating: circ.toString(),
    feeSinkBalance: sink.toString(),
    feeSplitterBalance: splitter.toString(),
    validatorBalances: vals,
    formula:
      "diff = (bscTotalIssued - bscTotalExited) - (layerCirculating + feeSinkBalance + feeSplitterBalance + sum(validatorBalances))",
    diff: diff.toString(),
    ok: diff === 0n,
  };
}

/** layerCirculating = 1e27 − B_bridge − B_sink − B_splitter − Σ B_validator（03 §1.3）。 */
export function layerCirculating({
  bridgeBalance,
  sinkBalance,
  splitterBalance = "0",
  validatorBalances = [],
}) {
  const vSum = validatorBalances.reduce((a, v) => a + BigInt(v.balance ?? v ?? "0"), 0n);
  return (
    GENESIS_SUPPLY -
    BigInt(bridgeBalance ?? "0") -
    BigInt(sinkBalance ?? "0") -
    BigInt(splitterBalance ?? "0") -
    vSum
  ).toString();
}

export function health(ctx) {
  const { db, cfg, snapshot = {} } = ctx;
  const snap = snapshot || {};
  const layer = snap.layer || {};
  const relayer = snap.relayer || {};
  const rec = computeReconcile(snap.reconcile || {});
  const idxLayer = cursorOf(db, "layer");
  const idxBsc = cursorOf(db, "bsc");
  const now = nowSec();

  const body = {
    schema: "bac/health/1",
    ok: rec.ok && listWarnings().length === 0,
    now,
    layer: {
      chainId: n(layer.chainId) ?? cfg.layerChainId,
      head: n(layer.head),
      headTs: n(layer.headTs),
      blockLagSec: n(layer.blockLagSec),
      enode: s(layer.enode),
      genesisHash: s(layer.genesisHash),
      gasLimit: n(layer.gasLimit),
      baseFee: s(layer.baseFee),
      // 决策 #16：zeroBaseFee，链上没有 base fee，防刷靠固定 min-gas-price
      zeroBaseFee: true,
      minGasPrice: s(layer.minGasPrice) ?? "1000000000",
      peers: n(layer.peers),
    },
    relayer: {
      lastPostedEpoch: n(relayer.lastPostedEpoch),
      currentEpoch: n(relayer.currentEpoch) ?? Math.floor(now / 86400),
      epochLag: n(relayer.epochLag),
      bscCursor: n(relayer.bscCursor),
      bscLagBlocks: n(relayer.bscLagBlocks),
      layerCursor: n(relayer.layerCursor),
      outboxNew: n(relayer.outboxNew),
      outboxSent: n(relayer.outboxSent),
      outboxOrphaned: n(relayer.outboxOrphaned),
      bscKeyBalance: s(relayer.bscKeyBalance),
      layerKeyBalance: s(relayer.layerKeyBalance),
    },
    reconcile: { ...rec, howToCheck: howToCheck(cfg) },
    // 决策 #17 的对账三联：已收 / 已转入 / 差额。单位全部是层内 BAC wei，不是 BNB。
    gas: gasBlock(ctx, snap),
    flap: {
      marketAddressOk: snap.flap ? !!snap.flap.marketAddressOk : null,
      checkedAt: snap.flap ? n(snap.flap.checkedAt) : null,
    },
    bridge: snap.bridge || {
      paused: null,
      pausedUntil: null,
      pausedCumulativeSec: null,
      maxPauseTotalSec: null,
      halted: null,
      haltCause: null,
      escapeArmedAt: null,
      armedCause: null,
      lastSettledEpoch: null,
      skippedEpochs: null,
      lastPot: null,
      releasedInWindow: null,
      owedTotal: null,
      reservedTotal: null,
    },
    vault: snap.vault || {
      accountedQuote: null,
      lastSettleAt: null,
      settleOverdueEpochs: null,
      nodeFundOwner: null,
    },
    anchorCommitWindowEndsAt: n(snap.anchorCommitWindowEndsAt),
    rpc: {
      rateLimited24h: n((snap.rpc || {}).rateLimited24h) ?? 0,
      throttledAgents: (snap.rpc || {}).throttledAgents || [],
      limits: {
        ethGetLogsMaxRange: cfg.bscLogRangeMax,
        // §3.1 的示例里写的是 128，但 02 §5.3 明确把 Besu 的
        // --bonsai-historical-block-limit 定在 512，并注明「比 Clique 版的 128 块宽」。
        // 这里按 02 取 512，字段名不变（差异记在 README）。
        ethCallStateWindowBlocks: cfg.ethCallStateWindowBlocks ?? 512,
      },
    },
    indexer: {
      layerCursor: idxLayer,
      bscCursor: idxBsc,
      dbBytes: n(snap.dbBytes) ?? 0,
    },
    warnings: listWarnings(),
  };
  return { status: 200, body };
}

/**
 * `/api/health` 的 `gas` 块（03 §3.1，决策 #17）。
 * 数字全部来自 epochs 表里由 FINAL 锚点回填的逐 proposer 行；没有锚点就全部是 "0"，
 * 绝不拿官方节点的实时数冒充已锚定的数（§3.7 硬规则 2）。
 */
export function gasBlock(ctx, snap = {}) {
  const { db } = ctx;
  const row = db
    .prepare(
      `SELECT epoch, gas_fees, gas_remitted, gas_gap, pool_accrued, pool_claimed, foundation_accrued
         FROM epochs
        WHERE state = 'FINAL' AND gas_fees IS NOT NULL
        ORDER BY epoch DESC LIMIT 1`
    )
    .get();
  const received = BigInt((row && row.gas_fees) || "0");
  const remitted = BigInt((row && row.gas_remitted) || "0");
  const gap = received - remitted;
  const sp = snap.splitter || {};
  const shortfalls = db
    .prepare(
      `SELECT validator, proposer_addr AS proposer, cum_owed AS cumOwed, cum_remitted AS cumRemitted,
              arrears, rights, last_epoch AS lastEpoch
         FROM remittance WHERE shortfall = 1 ORDER BY validator`
    )
    .all();
  return {
    schemaNote: "决策 #17：gas 费按出块者分账。单位全部是层内 BAC wei，不是 BNB。",
    officialBlockValidatorBps: 1000,
    validatorBlockValidatorBps: 5000,
    lastAnchoredEpoch: row ? Number(row.epoch) : null,
    received: received.toString(),
    remitted: remitted.toString(),
    gap: gap.toString(),
    gapBps: received === 0n ? 0 : Number((gap * 10000n) / received),
    operatorFloatReserve: s(sp.operatorFloatReserve) ?? "0",
    remitOverdueEpochs: n(sp.remitOverdueEpochs) ?? 0,
    poolPending: s(sp.poolPending) ?? "0",
    carryPool: s(sp.carryPool) ?? "0",
    foundationBalance: s(sp.foundationBalance) ?? "0",
    shortfalls: shortfalls.map((r) => ({
      validator: r.validator,
      proposer: r.proposer,
      cumOwed: s(r.cumOwed) ?? "0",
      cumRemitted: s(r.cumRemitted) ?? "0",
      arrears: s(r.arrears) ?? "0",
      // 03 §3.1 要求 rightsRevokedAt，但 §2 的 remittance 表没有对应列（文档内部不一致，
      // 记在仓库 README 的「待定」里）。出块资格已被撤销时退回 last_epoch，否则给 null，
      // 绝不编一个纪元号出来。
      rightsRevokedAt: Number(r.rights) === 0 ? n(r.lastEpoch) : null,
    })),
  };
}

function cursorOf(db, chain) {
  const row = db.prepare("SELECT last_block FROM cursor WHERE chain = ?").get(chain);
  return row ? Number(row.last_block) : 0;
}

// ===================== §3.2 /api/summary =====================

export function summary(ctx) {
  const { db, snapshot = {} } = ctx;
  const t = latestTreasury(db);
  const head = db.prepare("SELECT MAX(number) AS h FROM blocks").get();
  const txTotal = db.prepare("SELECT COUNT(*) AS c FROM txs").get();
  const contractsTotal = db.prepare("SELECT COUNT(*) AS c FROM contracts").get();
  const burned = db.prepare("SELECT fee_burned FROM txs").all();
  const burnedTotal = burned.reduce((acc, r) => acc + BigInt(r.fee_burned || "0"), 0n).toString();
  const counts = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS c FROM agents GROUP BY status").all().map((r) => [Number(r.status), Number(r.c)])
  );
  const totalAgents = Object.values(counts).reduce((a, b) => a + b, 0);
  const ep = db.prepare("SELECT MAX(epoch) AS e FROM epochs WHERE state = 'POSTED' OR state = 'FINAL'").get();
  const epFinal = db.prepare("SELECT MAX(epoch) AS e FROM epochs WHERE state = 'FINAL'").get();
  const lastPosted = ep && ep.e != null ? Number(ep.e) : null;
  const lastState = lastPosted != null
    ? db.prepare("SELECT state, agreeing_count, disputing_wt FROM epochs WHERE epoch = ?").get(lastPosted)
    : null;
  const blockTimes = db.prepare("SELECT ts FROM blocks ORDER BY number DESC LIMIT 101").all();
  let blockTimeSec = null;
  if (blockTimes.length >= 2) {
    const span = Number(blockTimes[0].ts) - Number(blockTimes[blockTimes.length - 1].ts);
    blockTimeSec = Math.round((span / (blockTimes.length - 1)) * 10) / 10;
  }

  const body = {
    schema: "bac/summary/1",
    layer: {
      head: head && head.h != null ? Number(head.h) : 0,
      blockTimeSec,
      txTotal: Number(txTotal.c),
      contractsTotal: Number(contractsTotal.c),
      circulating: s((snapshot.reconcile || {}).layerCirculating),
      burnedTotal,
    },
    agents: {
      total: totalAgents,
      challenged: counts[1] || 0,
      active: counts[2] || 0,
      dormant: counts[3] || 0,
      banned: counts[4] || 0,
      retired: counts[5] || 0,
    },
    treasury: {
      taxFeeRateBps: n((snapshot.treasury || {}).taxFeeRateBps),
      vaultBalance: t ? t.vault_balance : null,
      vaultAccounted: t ? t.vault_accounted : null,
      lifetimeToBridge: t ? t.lifetime_to_bridge : null,
      lifetimeToNodeFund: t ? t.lifetime_to_node : null,
      poolBalance: t ? t.pool_balance : null,
      nodeFundBalance: t ? t.node_fund_balance : null,
      nodeFundWithdrawn: t ? t.node_fund_withdrawn : null,
    },
    bridge: {
      totalLocked: t ? t.total_locked : null,
      totalIssued: t ? t.total_issued : null,
      totalExited: t ? t.total_exited : null,
      lastSettledEpoch: n((snapshot.bridge || {}).lastSettledEpoch),
      currentReleaseBps: n((snapshot.bridge || {}).currentReleaseBps),
      paused: (snapshot.bridge || {}).paused ?? null,
      halted: (snapshot.bridge || {}).halted ?? null,
    },
    validators: {
      nodes: validatorRows(db).length,
      totalStaked: validatorRows(db).reduce((a, v) => a + BigInt(v.staked || "0"), 0n).toString(),
      rewardBalance: t ? t.reward_balance : null,
      lifetimeFunded: t ? t.reward_funded : null,
      lifetimePaid: t ? t.reward_paid : null,
    },
    // 决策 #17：层内 BAC 的 gas 费分账。**与上面的 treasury（BSC 上的 BNB 税收）单位不同、链不同、
    // 分法不同，网站上绝不允许相加成一个「总收入」**（03 §3.2 明令禁止）。
    gasFees: gasFeesSummary(db, t),
    epoch: {
      current: Math.floor(nowSec() / 86400),
      lastPosted,
      lastFinal: epFinal && epFinal.e != null ? Number(epFinal.e) : null,
      state: lastState ? lastState.state : "NONE",
      agreeingCount: lastState ? n(lastState.agreeing_count) : null,
      disputingWeight: lastState ? s(lastState.disputing_wt) : null,
    },
    updatedAt: nowSec(),
  };
  return { status: 200, body };
}

/** §3.2 的 gasFees 块：全部从 epochs / proposer_income / treasury 三张表汇总，不预测、不年化。 */
export function gasFeesSummary(db, t) {
  // 金额是 wei（远超 2^63），SQLite 的 SUM 会直接溢出报错，所以逐行用 BigInt 加。
  const rows = db
    .prepare(
      `SELECT gas_fees, gas_remitted, pool_accrued, pool_claimed, foundation_accrued
         FROM epochs WHERE state = 'FINAL' AND gas_fees IS NOT NULL`
    )
    .all();
  const sum = (k) => rows.reduce((a, r) => a + BigInt(r[k] || "0"), 0n);
  const received = sum("gas_fees");
  const remitted = sum("gas_remitted");
  const proposers = db
    .prepare("SELECT official, COUNT(DISTINCT proposer) AS c FROM proposer_income GROUP BY official")
    .all();
  const byOfficial = Object.fromEntries(proposers.map((r) => [Number(r.official), Number(r.c)]));
  return {
    unit: "BAC",
    officialBlockValidatorBps: 1000,
    validatorBlockValidatorBps: 5000,
    lifetimeReceived: received.toString(),
    lifetimeRemitted: remitted.toString(),
    lifetimeGap: (received - remitted).toString(),
    lifetimeToPool: sum("pool_accrued").toString(),
    lifetimePoolClaimed: sum("pool_claimed").toString(),
    lifetimeToFoundation: sum("foundation_accrued").toString(),
    foundationWithdrawn: t ? s(t.lifetime_foundation_withdrawn) ?? "0" : "0",
    carryPool: t ? s(t.splitter_pool_pending) ?? "0" : "0",
    proposers: { official: byOfficial[1] || 0, validators: byOfficial[0] || 0 },
  };
}

function latestTreasury(db) {
  return db.prepare("SELECT * FROM treasury ORDER BY ts DESC LIMIT 1").get() || null;
}

// ===================== §3.3 /api/feed =====================

export function feed(ctx, q = {}) {
  const { db } = ctx;
  const limit = intParam(q.limit, 50, { min: 1, max: 200, name: "limit" });
  const after = q.after === undefined ? null : intParam(q.after, null, { name: "after" });
  const before = q.before === undefined ? null : intParam(q.before, null, { name: "before" });
  const where = [];
  const args = [];
  if (after !== null) {
    where.push("id > ?");
    args.push(after);
  }
  if (before !== null) {
    where.push("id < ?");
    args.push(before);
  }
  if (q.chain) {
    if (q.chain !== "bsc" && q.chain !== "layer") throw badRequest("chain 只能是 bsc 或 layer");
    where.push("chain = ?");
    args.push(q.chain);
  }
  if (q.kind) {
    const kinds = String(q.kind).split(",").map((x) => x.trim()).filter(Boolean);
    if (kinds.length === 0) throw badRequest("kind 不能为空");
    where.push(`kind IN (${kinds.map(() => "?").join(",")})`);
    args.push(...kinds);
  }
  if (q.agentId !== undefined) {
    where.push("agent_id = ?");
    args.push(intParam(q.agentId, null, { name: "agentId" }));
  }
  const sql = `SELECT * FROM feed ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ${
    after !== null ? "ASC" : "DESC"
  } LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit);
  const headRow = db.prepare("SELECT MAX(id) AS h FROM feed").get();
  return {
    status: 200,
    body: {
      schema: "bac/feed/1",
      items: rows.map((r) => ({
        id: Number(r.id),
        chain: r.chain,
        kind: r.kind,
        ts: Number(r.ts),
        block: Number(r.block),
        agentId: n(r.agent_id),
        textZh: r.text_zh,
        tx: r.tx,
        anchored: !!r.anchored,
        epoch: n(r.epoch),
      })),
      head: headRow && headRow.h != null ? Number(headRow.h) : 0,
      anchoredThrough: anchoredThrough(db),
      updatedAt: nowSec(),
    },
  };
}

// ===================== §3.4 /api/agents =====================

const AGENT_SORTS = {
  newest: "agent_id DESC",
  actions: "announces DESC, agent_id DESC",
  deploys: "deploys DESC, agent_id DESC",
  credited: "CAST(credited AS INTEGER) DESC, agent_id DESC",
};

function agentRow(db, r, snapshot) {
  const balances = (snapshot && snapshot.layerBalances) || {};
  return {
    agentId: Number(r.agent_id),
    controller: r.controller,
    wallet: r.wallet,
    status: Number(r.status),
    statusName: STATUS_NAME[Number(r.status)] || "NONE",
    registeredAt: Number(r.registered_at),
    activatedAt: n(r.activated_at),
    solved: Number(r.solved),
    lastHeartbeatEpoch: n(r.last_hb_epoch),
    missed: Number(r.missed),
    credited: r.credited,
    exited: r.exited,
    layerBalance: balances[r.wallet] ?? null,
    deploys: Number(r.deploys),
    announces: Number(r.announces),
    lastLayerBlock: n(r.last_layer_tx),
    agentURI: r.agent_uri,
    endpointHash: r.endpoint_hash,
    modelFingerprint: r.model_fp,
  };
}

export function agents(ctx, q = {}) {
  const { db, snapshot } = ctx;
  const page = intParam(q.page, 1, { min: 1, name: "page" });
  const pageSize = intParam(q.pageSize, 50, { min: 1, max: 200, name: "pageSize" });
  const sort = q.sort || "newest";
  if (!AGENT_SORTS[sort]) throw badRequest("sort 只能是 newest|actions|deploys|credited");
  const where = [];
  const args = [];
  if (q.status) {
    const code = STATUS_CODE[String(q.status).toLowerCase()];
    if (code === undefined) throw badRequest("status 只能是 challenged|active|dormant|banned|retired");
    where.push("status = ?");
    args.push(code);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM agents ${whereSql}`).get(...args).c);
  const rows = db
    .prepare(`SELECT * FROM agents ${whereSql} ORDER BY ${AGENT_SORTS[sort]} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  return {
    status: 200,
    body: {
      schema: "bac/agents/1",
      total,
      page,
      pageSize,
      items: rows.map((r) => agentRow(db, r, snapshot)),
    },
  };
}

// ===================== §3.5 /api/agent/{id} =====================

export function agent(ctx, id) {
  const { db, snapshot } = ctx;
  const agentId = intParam(id, null, { name: "agentId" });
  const r = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId);
  if (!r) throw notFound(`没有 agent #${agentId}`);
  const deposits = db
    .prepare("SELECT * FROM deposits WHERE agent_id = ? ORDER BY deposit_id DESC")
    .all(agentId)
    .map((d) => ({
      depositId: Number(d.deposit_id),
      credits: d.credits,
      bscTx: d.bsc_tx,
      layerTx: s(d.layer_tx),
      lagSec: n(d.lag_sec),
    }));
  const exits = db
    .prepare("SELECT * FROM exits WHERE agent_id = ? ORDER BY exit_id DESC")
    .all(agentId)
    .map((e) => ({
      exitId: Number(e.exit_id),
      credits: e.credits,
      bornEpoch: Number(e.born_epoch),
      anchorEpoch: n(e.anchor_epoch),
      layerTx: e.layer_tx,
      claimedTx: s(e.claimed_tx),
      lockedWei: s(e.locked_wei),
      collectedWei: e.collected_wei,
    }));
  const contracts = db
    .prepare("SELECT * FROM contracts WHERE agent_id = ? ORDER BY block DESC")
    .all(agentId)
    .map((c) => ({
      address: c.address,
      block: Number(c.block),
      codeSize: Number(c.code_size),
      callCount: Number(c.call_count),
    }));
  const actions = db
    .prepare("SELECT * FROM actions WHERE agent_id = ? ORDER BY seq DESC LIMIT 200")
    .all(agentId)
    .map((a) => ({
      seq: Number(a.seq),
      kind: a.kind,
      subject: s(a.subject),
      summary: a.summary,
      uri: a.uri,
      block: Number(a.block),
      tx: a.tx,
      ts: Number(a.ts),
    }));
  const id_ = (snapshot && snapshot.identity && snapshot.identity[agentId]) || {};
  return {
    status: 200,
    body: {
      schema: "bac/agent/1",
      agent: agentRow(db, r, snapshot),
      identity: {
        agentURI: r.agent_uri,
        uriReachable: id_.uriReachable ?? null,
        uriCheckedAt: id_.uriCheckedAt ?? null,
        registrationsBackref: id_.registrationsBackref ?? null,
        endpointHashMatches: id_.endpointHashMatches ?? null,
        note: "agentURI 的内容由 agent 自己提供，本站只做格式核对，不背书其中任何说法。",
      },
      deposits,
      exits,
      contracts,
      actions,
      escape: {
        halted: (snapshot && snapshot.bridge && snapshot.bridge.halted) ?? false,
        weight: r.credited,
        claimable: ((snapshot && snapshot.escape && snapshot.escape[agentId]) || "0"),
      },
    },
  };
}

// ===================== §3.6 区块 / 交易 / 合约 =====================

const blockOut = (b) => ({
  number: Number(b.number),
  hash: b.hash,
  ts: Number(b.ts),
  txCount: Number(b.tx_count),
  gasUsed: Number(b.gas_used),
  gasLimit: Number(b.gas_limit),
  baseFee: b.base_fee,
  epoch: Number(b.epoch),
});

export function blocks(ctx, q = {}) {
  const { db } = ctx;
  let rows;
  if (q.from !== undefined || q.to !== undefined) {
    const from = intParam(q.from, 0, { name: "from" });
    const to = intParam(q.to, from + 49, { name: "to" });
    if (to < from) throw badRequest("to 不能小于 from");
    rows = db.prepare("SELECT * FROM blocks WHERE number >= ? AND number <= ? ORDER BY number DESC LIMIT 200").all(from, to);
  } else {
    const limit = intParam(q.limit, 50, { min: 1, max: 200, name: "limit" });
    const head = q.head === undefined ? null : intParam(q.head, null, { name: "head" });
    rows =
      head === null
        ? db.prepare("SELECT * FROM blocks ORDER BY number DESC LIMIT ?").all(limit)
        : db.prepare("SELECT * FROM blocks WHERE number <= ? ORDER BY number DESC LIMIT ?").all(head, limit);
  }
  return { status: 200, body: { schema: "bac/blocks/1", items: rows.map(blockOut) } };
}

const txOut = (t) => ({
  hash: t.hash,
  block: Number(t.block),
  idx: Number(t.idx),
  from: t.from_addr,
  to: s(t.to_addr),
  value: t.value,
  gasUsed: Number(t.gas_used),
  effGasPrice: t.eff_gas_price,
  // 决策 #16：zeroBaseFee 之后链上没有 base fee，也没有任何销毁，所以这个字段恒为 "0"。
  // **旧字段保留但必须返回 "0"，不许删**，否则已经在用的 SDK 会静默拿到错的数（03 §3.7）。
  feeBurned: "0",
  // 决策 #17：这笔交易的 gas 费全额进出块者的 EOA。
  feeToProposer: (BigInt(t.gas_used || 0) * BigInt(t.eff_gas_price || "0")).toString(),
  created: s(t.created),
  status: Number(t.status),
  agentId: n(t.agent_id),
  ts: Number(t.ts),
});

export function block(ctx, num) {
  const { db } = ctx;
  const number = intParam(num, null, { name: "区块号" });
  const b = db.prepare("SELECT * FROM blocks WHERE number = ?").get(number);
  if (!b) throw notFound(`没有区块 ${number}`);
  const txs = db.prepare("SELECT * FROM txs WHERE block = ? ORDER BY idx ASC").all(number);
  return { status: 200, body: { schema: "bac/block/1", ...blockOut(b), txs: txs.map(txOut) } };
}

export function txByHash(ctx, hash) {
  const { db } = ctx;
  const h = String(hash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw badRequest("交易哈希必须是 0x 前缀的 66 字符");
  const t = db.prepare("SELECT * FROM txs WHERE hash = ?").get(h);
  if (!t) throw notFound(`没有交易 ${h}`);
  const logs = db
    .prepare("SELECT * FROM logs WHERE tx = ? ORDER BY log_index ASC")
    .all(h)
    .map((l) => ({ address: l.address, topics: JSON.parse(l.topics), data: l.data }));
  const dec = db
    .prepare("SELECT * FROM decoded_events WHERE tx = ? ORDER BY log_index ASC")
    .all(h)
    .map((d) => ({ event: d.event, args: JSON.parse(d.args) }));
  return {
    status: 200,
    body: { schema: "bac/tx/1", tx: txOut(t), logs, decoded: dec.length ? dec : null },
  };
}

export function contracts(ctx, q = {}) {
  const { db } = ctx;
  const page = intParam(q.page, 1, { min: 1, name: "page" });
  const pageSize = intParam(q.pageSize, 50, { min: 1, max: 200, name: "pageSize" });
  const where = [];
  const args = [];
  if (q.agentId !== undefined) {
    where.push("agent_id = ?");
    args.push(intParam(q.agentId, null, { name: "agentId" }));
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM contracts ${whereSql}`).get(...args).c);
  const rows = db
    .prepare(`SELECT * FROM contracts ${whereSql} ORDER BY block DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  return {
    status: 200,
    body: {
      schema: "bac/contracts/1",
      total,
      items: rows.map((c) => ({
        address: c.address,
        deployer: c.deployer,
        agentId: n(c.agent_id),
        block: Number(c.block),
        ts: Number(c.ts),
        codeSize: Number(c.code_size),
        callCount: Number(c.call_count),
        lastCall: n(c.last_call),
      })),
    },
  };
}

// ===================== 纪元 =====================

function epochOut(db, e) {
  const atts = db.prepare("SELECT * FROM attestations WHERE epoch = ?").all(Number(e.epoch));
  return {
    epoch: Number(e.epoch),
    state: e.state,
    exitRoot: s(e.exit_root),
    l2Block: n(e.l2_block),
    l2BlockHash: s(e.l2_block_hash),
    credited: s(e.credited),
    exitCredits: s(e.exit_credits),
    feeBurned: s(e.fee_burned),
    circulating: s(e.circulating),
    exitCount: n(e.exit_count),
    postedAt: n(e.posted_at),
    postedTx: s(e.posted_tx),
    finalizedAt: n(e.finalized_at),
    agreeingCount: n(e.agreeing_count),
    agreeingWt: s(e.agreeing_wt),
    disputingWt: s(e.disputing_wt),
    releaseBps: n(e.release_bps),
    pot: s(e.pot),
    rate: s(e.rate),
    settledAt: n(e.settled_at),
    rewardPot: s(e.reward_pot),
    attestationCount: atts.length,
    agreeingAttestations: atts.filter((a) => a.agreeing === 1).length,
    disputingAttestations: atts.filter((a) => a.agreeing === 0).length,
  };
}

export function epochs(ctx, q = {}) {
  const { db } = ctx;
  let rows;
  if (q.from !== undefined || q.to !== undefined) {
    const from = intParam(q.from, 0, { name: "from" });
    const to = intParam(q.to, from, { name: "to" });
    if (to < from) throw badRequest("to 不能小于 from");
    rows = db.prepare("SELECT * FROM epochs WHERE epoch >= ? AND epoch <= ? ORDER BY epoch DESC").all(from, to);
  } else {
    const limit = intParam(q.limit, 30, { min: 1, max: 200, name: "limit" });
    rows = db.prepare("SELECT * FROM epochs ORDER BY epoch DESC LIMIT ?").all(limit);
  }
  return { status: 200, body: { schema: "bac/epochs/1", items: rows.map((e) => epochOut(db, e)) } };
}

export function epoch(ctx, num) {
  const { db } = ctx;
  const e = intParam(num, null, { name: "纪元号" });
  const row = db.prepare("SELECT * FROM epochs WHERE epoch = ?").get(e);
  if (!row) throw notFound(`没有纪元 ${e}`);
  const attestations = db
    .prepare("SELECT * FROM attestations WHERE epoch = ? ORDER BY validator ASC")
    .all(e)
    .map((a) => ({
      validator: a.validator,
      nodeId: s(a.node_id),
      exitRoot: s(a.exit_root),
      l2Block: n(a.l2_block),
      l2BlockHash: s(a.l2_block_hash),
      weight: s(a.weight),
      agreeing: a.agreeing === null || a.agreeing === undefined ? null : a.agreeing === 1,
    }));
  return { status: 200, body: { schema: "bac/epoch/1", ...epochOut(db, row), attestations } };
}

function leavesOf(db, e) {
  return db
    .prepare("SELECT exit_id, agent_id, to_addr, credits, born_epoch FROM exits WHERE anchor_epoch = ? ORDER BY exit_id ASC")
    .all(Number(e));
}

export function epochLeaves(ctx, num) {
  const { db, cfg } = ctx;
  const e = intParam(num, null, { name: "纪元号" });
  const row = db.prepare("SELECT * FROM epochs WHERE epoch = ?").get(e);
  if (!row) throw notFound(`没有纪元 ${e}`);
  const bridge = cfg.addresses && cfg.addresses.BacBridge;
  const rows = leavesOf(db, e);
  const leaves = rows.map((r) => ({
    exitId: Number(r.exit_id),
    agentId: Number(r.agent_id),
    to: r.to_addr,
    credits: r.credits,
    leaf: bridge
      ? leafHash(
          { exitId: BigInt(r.exit_id), agentId: BigInt(r.agent_id), to: r.to_addr, credits: BigInt(r.credits) },
          cfg.layerChainId,
          bridge
        )
      : null,
  }));
  return {
    status: 200,
    body: {
      schema: "bac/leaves/1",
      epoch: e,
      exitRoot: s(row.exit_root) ?? ZERO_ROOT,
      leaves,
      proofFor: `${cfg.apiBase}/api/epoch/${e}/proof/{exitId}`,
    },
  };
}

export function epochProof(ctx, num, exitIdRaw) {
  const { db, cfg } = ctx;
  const e = intParam(num, null, { name: "纪元号" });
  const exitId = intParam(exitIdRaw, null, { name: "exitId" });
  const row = db.prepare("SELECT * FROM epochs WHERE epoch = ?").get(e);
  if (!row) throw notFound(`没有纪元 ${e}`);
  const bridge = cfg.addresses && cfg.addresses.BacBridge;
  if (!bridge) throw notFound("没有配置 BacBridge 地址，无法给出证明");
  const rows = leavesOf(db, e);
  const mine = rows.find((r) => Number(r.exit_id) === exitId);
  if (!mine) throw notFound(`纪元 ${e} 的叶子里没有 exitId=${exitId}`);
  const leaves = rows.map((r) => ({
    exitId: BigInt(r.exit_id),
    agentId: BigInt(r.agent_id),
    to: r.to_addr,
    credits: BigInt(r.credits),
  }));
  const localRoot = exitRootOf(leaves, cfg.layerChainId, bridge);
  // 本地重算的根与链上锚点对不上就不发证明：发一个对不上的证明会让 claimExit revert，
  // 而用户的积分在层内早就销毁了（「宁可停，不可错」）。
  if (row.exit_root && localRoot.toLowerCase() !== String(row.exit_root).toLowerCase()) {
    throw new ApiError(
      "internal",
      `纪元 ${e} 的本地叶子重算出的 exitRoot 与链上锚点不一致，证明暂不可用`,
      500
    );
  }
  const p = proofOf(leaves, BigInt(exitId), cfg.layerChainId, bridge);
  return {
    status: 200,
    body: {
      schema: "bac/proof/2",
      exitId,
      agentId: Number(mine.agent_id),
      to: mine.to_addr,
      credits: mine.credits,
      anchorEpoch: e,
      bornEpoch: Number(mine.born_epoch),
      leaf: leafHash(
        { exitId: BigInt(mine.exit_id), agentId: BigInt(mine.agent_id), to: mine.to_addr, credits: BigInt(mine.credits) },
        cfg.layerChainId,
        bridge
      ),
      proof: p,
      exitRoot: s(row.exit_root) ?? localRoot,
      bridge,
      layerChainId: cfg.layerChainId,
    },
  };
}

// ===================== /api/rate =====================

export function rate(ctx) {
  const { db, snapshot = {} } = ctx;
  const t = latestTreasury(db);
  const pool = BigInt((t && t.pool_balance) || (snapshot.bridge && snapshot.bridge.poolBalance) || "0");
  const owed = BigInt((snapshot.bridge && snapshot.bridge.owedTotal) || "0");
  const issued = BigInt((t && t.total_issued) || "0");
  const exited = BigInt((t && t.total_exited) || "0");
  const outstanding = issued > exited ? issued - exited : 0n;
  const free = pool > owed ? pool - owed : 0n;
  const weiPerCredit = outstanding > 0n ? ((free * 10n ** 18n) / outstanding).toString() : "0";
  const lastPot = db.prepare("SELECT pot FROM epochs WHERE pot IS NOT NULL ORDER BY epoch DESC LIMIT 1").get();
  return {
    status: 200,
    body: {
      schema: "bac/rate/1",
      weiPerCredit,
      poolBalance: pool.toString(),
      owedTotal: owed.toString(),
      creditsOutstanding: outstanding.toString(),
      lastPot: lastPot ? lastPot.pot : "0",
      note: "估算 · 不承诺任何金额",
    },
  };
}

// ===================== /api/validators =====================

/** §2 没有 validators 表，所以这里从 decoded_events + attestations 现算，不新增表。 */
export function validatorRows(db) {
  const rows = db
    .prepare("SELECT event, args, block FROM decoded_events WHERE contract = 'ValidatorStaking' ORDER BY block ASC, log_index ASC")
    .all();
  const byValidator = new Map();
  const get = (v) => {
    if (!byValidator.has(v))
      byValidator.set(v, {
        nodeId: null,
        validator: v,
        payout: null,
        enodeURI: null,
        active: false,
        strikes: 0,
        staked: "0",
        lastEpoch: null,
        agreedEpochs: 0,
        disputedEpochs: 0,
        lifetimeClaimed: "0",
      });
    return byValidator.get(v);
  };
  const nodeOwner = new Map();
  for (const r of rows) {
    const a = JSON.parse(r.args);
    switch (r.event) {
      case "Staked":
        get(a.who).staked = String(a.total);
        break;
      case "Unstaked": {
        const v = get(a.who);
        v.staked = (BigInt(v.staked) - BigInt(a.amount) > 0n ? BigInt(v.staked) - BigInt(a.amount) : 0n).toString();
        break;
      }
      case "NodeRegistered": {
        const v = get(a.validator);
        v.nodeId = a.nodeIdHash;
        v.payout = a.payout;
        v.enodeURI = a.enodeURI;
        v.active = true;
        nodeOwner.set(a.nodeIdHash, a.validator);
        break;
      }
      case "NodeRetired": {
        const owner = nodeOwner.get(a.nodeIdHash);
        if (owner) get(owner).active = false;
        break;
      }
      case "NodeStruck": {
        const owner = nodeOwner.get(a.nodeIdHash);
        if (owner) get(owner).strikes = Number(a.strikes);
        break;
      }
      case "RewardClaimed": {
        const v = get(a.validator);
        v.lifetimeClaimed = (BigInt(v.lifetimeClaimed) + BigInt(a.amount)).toString();
        break;
      }
      case "ValidatorRemoved":
        get(a.v).active = false;
        break;
      default:
        break;
    }
  }
  for (const att of db.prepare("SELECT * FROM attestations").all()) {
    const v = get(att.validator);
    if (v.lastEpoch === null || Number(att.epoch) > v.lastEpoch) v.lastEpoch = Number(att.epoch);
    if (att.agreeing === 1) v.agreedEpochs += 1;
    if (att.agreeing === 0) v.disputedEpochs += 1;
  }
  return [...byValidator.values()].sort((a, b) => (a.validator < b.validator ? -1 : 1));
}

export function validators(ctx) {
  const { db } = ctx;
  const items = validatorRows(db);
  const t = latestTreasury(db);
  return {
    status: 200,
    body: {
      schema: "bac/validators/1",
      items,
      totalStaked: items.reduce((a, v) => a + BigInt(v.staked || "0"), 0n).toString(),
      rewardBalance: t ? t.reward_balance : "0",
    },
  };
}

// ===================== /api/treasury =====================

export function treasury(ctx, q = {}) {
  const { db } = ctx;
  const from = intParam(q.from, 0, { name: "from" });
  const to = intParam(q.to, 9999999999, { name: "to" });
  if (to < from) throw badRequest("to 不能小于 from");
  const rows = db
    .prepare("SELECT * FROM treasury WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 2000")
    .all(from, to);
  return {
    status: 200,
    body: {
      schema: "bac/treasury/1",
      items: rows.map((r) => ({
        ts: Number(r.ts),
        bscBlock: Number(r.bsc_block),
        vaultBalance: r.vault_balance,
        vaultAccounted: r.vault_accounted,
        vaultUnsplit: r.vault_unsplit,
        lifetimeToBridge: r.lifetime_to_bridge,
        lifetimeToNode: r.lifetime_to_node,
        poolBalance: r.pool_balance,
        nodeFundBalance: r.node_fund_balance,
        nodeFundWithdrawn: r.node_fund_withdrawn,
        totalLocked: r.total_locked,
        totalIssued: r.total_issued,
        totalExited: r.total_exited,
        rewardBalance: r.reward_balance,
        rewardFunded: r.reward_funded,
        rewardPaid: r.reward_paid,
        marketAddressOk: !!r.market_address_ok,
      })),
    },
  };
}

// ===================== §3.7 gas 费分账的三个端点（决策 #17） =====================
//
// 三条硬规则，逐字照做：
//   1. 单位一律是层内 BAC（wei 十进制字符串），每个返回体带 "unit": "BAC"；
//   2. 每个数字都要能说出它从哪来：来自 FINAL 锚点的 anchored = true，
//      只来自官方节点实时数据的 anchored = false（网站必须写「未锚定 · 仅来自官方节点」）；
//   3. 不做任何收益预测：只返回已发生的金额与规则常量。

const FEE_RULES_NOTE =
  "官方节点出的块：10% 进验证者池 / 90% 进官方基金会；验证者出的块：50% 归该验证者 / 50% 进官方基金会。" +
  "基金会那一份用余数法算。费用先落在出块者自己的 EOA 里，转入分账合约这一步是受信的，差额公开在下面。";

/** GET /api/fees —— 全局的「已收 / 已转入 / 差额」三联 + 分账合约的存量。 */
export function fees(ctx) {
  const { db, cfg, snapshot = {} } = ctx;
  const g = gasBlock(ctx, snapshot);
  const t = latestTreasury(db);
  const sum = gasFeesSummary(db, t);
  const sp = snapshot.splitter || {};
  return {
    status: 200,
    body: {
      schema: "bac/fees/1",
      unit: "BAC",
      rules: {
        zeroBaseFee: true,
        minGasPrice: s((snapshot.layer || {}).minGasPrice) ?? "1000000000",
        officialBlockValidatorBps: 1000,
        validatorBlockValidatorBps: 5000,
        note: FEE_RULES_NOTE,
      },
      reconcile: {
        received: sum.lifetimeReceived,
        remitted: sum.lifetimeRemitted,
        gap: sum.lifetimeGap,
        operatorFloatReserve: g.operatorFloatReserve,
        anchoredThrough: g.lastAnchoredEpoch,
        howToCheck: feesHowToCheck(cfg),
      },
      splitter: {
        address: FEE_SPLITTER,
        balance: s((snapshot.reconcile || {}).feeSplitterBalance) ?? "0",
        poolPending: g.poolPending,
        carryPool: g.carryPool,
        foundationBalance: g.foundationBalance,
        foundationPayout: s(sp.foundationPayout),
        lifetimeOfficialGross: t ? s(t.lifetime_official_gross) ?? "0" : "0",
        lifetimeValidatorRemitted: t ? s(t.lifetime_validator_remitted) ?? "0" : "0",
        lifetimePool: sum.lifetimeToPool,
        lifetimePoolClaimed: sum.lifetimePoolClaimed,
        lifetimeFoundationAccrued: sum.lifetimeToFoundation,
        lifetimeFoundationWithdrawn: sum.foundationWithdrawn,
      },
      updatedAt: nowSec(),
    },
  };
}

/** howToCheck 必须原样返回：任何人不必相信我们算好的 gap，他自己就能复算（§3.7）。 */
export function feesHowToCheck(cfg) {
  const layerRpc = `${cfg.apiBase}/rpc`;
  const anchor = (cfg.addresses && cfg.addresses.ChainAnchor) || "<ChainAnchor>";
  return [
    "对每个区块：Σ(gasUsed × effectiveGasPrice) 按 header.miner 分组，即 received",
    `cast call ${FEE_SPLITTER} "remittedBy(uint64,address)(uint256)" <epoch> <proposer> --rpc-url ${layerRpc}`,
    `cast call ${anchor} "proposerIncome(uint64,address)" <epoch> <proposer> --rpc-url ${cfg.bscRpc}`,
  ];
}

/** GET /api/fees/{epoch} —— 单个纪元的分账明细，逐行列出 weight / amount / 余数。 */
export function feeEpoch(ctx, epochParam) {
  const { db } = ctx;
  const e = intParam(epochParam, null, { name: "纪元号" });
  const row = db.prepare("SELECT * FROM epochs WHERE epoch = ?").get(e);
  if (!row) throw notFound(`没有纪元 ${e}`);
  const rows = db.prepare("SELECT * FROM proposer_income WHERE epoch = ? ORDER BY proposer ASC").all(e);
  const claims = db.prepare("SELECT * FROM pool_claims WHERE epoch = ? ORDER BY member ASC").all(e);
  const received = rows.reduce((a, r) => a + BigInt(r.gas_income || "0"), 0n);
  const remitted = rows.reduce((a, r) => a + BigInt(r.remitted || "0"), 0n);
  const accrued = BigInt(row.pool_accrued || "0");
  const claimed = claims.reduce((a, r) => a + BigInt(r.amount || "0"), 0n);
  const anchored = row.state === "FINAL" && rows.some((r) => Number(r.anchored) === 1);
  return {
    status: 200,
    body: {
      schema: "bac/fee-epoch/1",
      unit: "BAC",
      epoch: e,
      // §3.7 硬规则 2：见证人在四元组里签过才是 true
      anchored,
      anchorState: row.state,
      proposerIncomeRoot: s(row.proposer_income_root),
      received: received.toString(),
      remitted: remitted.toString(),
      gap: (received - remitted).toString(),
      split: {
        toPool: s(row.pool_accrued) ?? "0",
        toFoundation: s(row.foundation_accrued) ?? "0",
        fromOfficialBlocks: rows
          .filter((r) => Number(r.official) === 1)
          .reduce((a, r) => a + BigInt(r.gas_income || "0"), 0n)
          .toString(),
        fromValidatorBlocks: rows
          .filter((r) => Number(r.official) !== 1)
          .reduce((a, r) => a + BigInt(r.gas_income || "0"), 0n)
          .toString(),
      },
      pool: {
        accrued: accrued.toString(),
        carriedIn: "0",
        claimed: claimed.toString(),
        // 余数必须显示出来，哪怕只有 2 wei —— 这正是「余数去哪了」的答案（§3.7）
        remainder: (accrued - claimed).toString(),
        weightTotal: s(row.weight_total) ?? "0",
        weightsSetAt: n(row.weights_set_at),
        memberCount: n(row.member_count) ?? claims.length,
        members: claims.map((c) => ({
          validator: s(c.validator),
          layerPayout: c.member,
          // staked / attend30 由 BSC 侧的 ValidatorStaking 快照回填，没有就给 null，绝不编
          staked: null,
          attend30: null,
          weight: c.weight,
          amount: c.amount,
          claimedTx: c.layer_tx,
        })),
      },
      proposers: rows.map((r) => ({
        proposer: r.proposer,
        validator: s(r.validator),
        official: Number(r.official) === 1,
        blocks: Number(r.blocks),
        gasIncome: r.gas_income,
        remitted: r.remitted,
        gap: r.gap,
        // 官方行恒为 "0"（官方不自留）；验证者行 = gasIncome × 5000 / 10000
        selfKept: Number(r.official) === 1 ? "0" : ((BigInt(r.gas_income || "0") * 5000n) / 10000n).toString(),
      })),
      updatedAt: nowSec(),
    },
  };
}

/** GET /api/proposers —— 最近 N 个纪元里每个出块者的已收 / 已转入 / 差额。 */
export function proposers(ctx, q = {}) {
  const { db } = ctx;
  const epochs = intParam(q.epochs, 30, { min: 1, max: 3650, name: "epochs" });
  const top = db.prepare("SELECT MAX(epoch) AS e FROM proposer_income").get();
  const to = top && top.e != null ? Number(top.e) : null;
  const from = to === null ? null : Math.max(0, to - epochs + 1);
  // 金额是 wei，SQLite 的整数加法会溢出，所以只在 SQL 里分组，金额逐行用 BigInt 加。
  const rows =
    to === null
      ? []
      : db
          .prepare(
            `SELECT epoch, proposer, validator, official, blocks, gas_income, remitted
               FROM proposer_income WHERE epoch BETWEEN ? AND ? ORDER BY proposer ASC, epoch ASC`
          )
          .all(from, to);
  const byProposer = new Map();
  for (const r of rows) {
    const cur = byProposer.get(r.proposer) || {
      proposer: r.proposer,
      validator: s(r.validator),
      official: Number(r.official) === 1,
      blocks: 0,
      income: 0n,
      remit: 0n,
    };
    cur.blocks += Number(r.blocks);
    cur.income += BigInt(r.gas_income || "0");
    cur.remit += BigInt(r.remitted || "0");
    byProposer.set(r.proposer, cur);
  }
  const items = [...byProposer.values()].map((c) => {
    const gap = c.income - c.remit;
    const rem = db.prepare("SELECT rights, shortfall FROM remittance WHERE proposer_addr = ?").get(c.proposer);
    return {
      proposer: c.proposer,
      validator: c.validator,
      official: c.official,
      blocks: c.blocks,
      gasIncome: c.income.toString(),
      remitted: c.remit.toString(),
      gap: gap.toString(),
      gapBps: c.income === 0n ? 0 : Number((gap * 10000n) / c.income),
      rights: c.official ? true : rem ? Number(rem.rights) === 1 : false,
      shortfall: rem ? Number(rem.shortfall) === 1 : false,
      note: c.official
        ? "官方节点：合约层面没有任何机制会因为它不归集而惩罚它，差额只能靠公开对账约束。"
        : "验证者节点：归集短缺会扣发 BSC 侧奖励并撤销出块资格（v1 不罚没本金）。",
    };
  });
  return {
    status: 200,
    body: {
      schema: "bac/proposers/1",
      unit: "BAC",
      window: { from, to },
      items,
      updatedAt: nowSec(),
    },
  };
}
