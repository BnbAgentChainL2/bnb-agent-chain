// src/api/built.js —— 03 §7.6 的端点：agent 造出来的东西（代币 / 交易对 / 成交）。
//
// 三条纪律，每一条都在返回体里有对应字段，前端没法忘：
//   1. 全部是启发式解码 —— 每个返回体都带 detection 块，一字不改（§7.6）；
//   2. name / symbol 是 agent 自己写的不可信文本 —— nameTrusted 恒为 false；
//   3. 代币金额是**该代币自己的最小单位**，随行给 decimals；本链没有任何法币计价，
//      返回体里永远不出现 $、市值、24h 涨跌 %（§7.3 的硬性规定）。
import { getAddress } from "ethers";
import { ApiError, badRequest, notFound } from "./handlers.js";
import { anchoredThrough } from "../store.js";
import { DETECTION_NOTE, classifiedZh, BURN_ADDRS, ZERO_ADDR, DEAD_ADDR } from "../economy/constants.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const s = (v) => (v === null || v === undefined ? null : String(v));
const n = (v) => (v === null || v === undefined ? null : Number(v));

function intParam(v, def, { min = 0, max = Number.MAX_SAFE_INTEGER, name = "参数" } = {}) {
  if (v === undefined || v === null || v === "") return def;
  const x = Number(v);
  if (!Number.isInteger(x)) throw badRequest(`${name} 必须是整数`);
  if (x < min || x > max) throw badRequest(`${name} 超出范围 ${min}..${max}`);
  return x;
}

/** 地址参数：不是合法地址一律 400，不做「猜一猜」。 */
export function addressParam(v, name = "address") {
  const raw = String(v ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw badRequest(`${name} 必须是 0x 前缀的 42 字符地址`);
  return getAddress(raw);
}

// ===================== detection 块 =====================

/**
 * §7.4：「另有 N 个被调用过但我们没能识别出类型的合约」。
 * 口径：被调用过（call_count > 0）、且不在代币 / 交易对 / 工厂 / NFT / 多代币 任何一张表里的合约。
 * 没有这个数字，前面所有列表都是在暗示「这就是全部」，而那是假的。
 */
export function unclassifiedContracts(db) {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS c FROM contracts c
        WHERE c.call_count > 0
          AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.address = c.address AND t.is_nft = 0 AND t.is_multi_token = 0)
          AND NOT EXISTS (SELECT 1 FROM pairs p WHERE p.address = c.address)
          AND NOT EXISTS (SELECT 1 FROM amm_factories f WHERE f.address = c.address)
          AND NOT EXISTS (SELECT 1 FROM contract_probes pr WHERE pr.address = c.address AND pr.state IN ('nft','multi_token'))`
    )
    .get();
  return Number(r.c);
}

/** §7.6：每个端点的返回体都必须带这个块。 */
export function detection(ctx) {
  const { db, cfg = {} } = ctx;
  return {
    method: "heuristic",
    note: DETECTION_NOTE,
    // 解码规则说明页还不存在（03 的 [待定] 第 7 条），所以默认是 null，前端退化成纯文字说明。
    rulesUrl: cfg.detectionRulesUrl ?? null,
    unclassifiedContracts: unclassifiedContracts(db),
  };
}

// ===================== 行 -> JSON =====================

const LIST_FILTER = "is_nft = 0 AND is_multi_token = 0";

/** 同名代币数：不合并、不去重、不打假标签，只告诉人「链上还有 N 个同名的」。 */
function sameNameCount(db, row) {
  const sym = row.symbol === null || row.symbol === undefined ? "" : String(row.symbol);
  if (sym) {
    const r = db
      .prepare(`SELECT COUNT(*) AS c FROM tokens WHERE ${LIST_FILTER} AND symbol = ? AND address != ?`)
      .get(sym, row.address);
    return Number(r.c);
  }
  const nm = row.name === null || row.name === undefined ? "" : String(row.name);
  if (!nm) return 0;
  const r = db
    .prepare(`SELECT COUNT(*) AS c FROM tokens WHERE ${LIST_FILTER} AND name = ? AND address != ?`)
    .get(nm, row.address);
  return Number(r.c);
}

export function tokenOut(db, r) {
  return {
    address: r.address,
    name: s(r.name),
    symbol: s(r.symbol),
    decimals: n(r.decimals),
    // 恒为 false。它存在的唯一目的是让前端没法忘记「这段文字是部署者自己写的，本站不核实」。
    nameTrusted: false,
    totalSupply: String(r.total_supply),
    supplyBlock: n(r.supply_block),
    creator: { agentId: n(r.creator_agent), wallet: s(r.creator) },
    deployTx: s(r.deploy_tx),
    deployBlock: n(r.deploy_block),
    deployTs: n(r.deploy_ts),
    holders: Number(r.holders),
    transfers: Number(r.transfers),
    mints: Number(r.mints),
    burns: Number(r.burns),
    pairCount: Number(r.pair_count),
    swapCount: Number(r.swap_count),
    firstTs: Number(r.first_ts),
    lastTs: Number(r.last_ts),
    detectLevel: r.detect_level,
    balanceDrift: !!r.balance_drift,
    zeroOnly: !!r.zero_only,
    sameNameCount: sameNameCount(db, r),
  };
}

function tokenBrief(db, address) {
  const t = db.prepare("SELECT address, symbol, decimals FROM tokens WHERE address = ?").get(address);
  return {
    address,
    symbol: t ? s(t.symbol) : null,
    decimals: t ? n(t.decimals) : null,
    known: !!t,
  };
}

export function pairOut(db, r) {
  const f = r.factory ? db.prepare("SELECT creator_agent FROM amm_factories WHERE address = ?").get(r.factory) : null;
  return {
    address: r.address,
    kind: r.kind,
    discoveredVia: r.discovered_via,
    factory: r.factory ? { address: r.factory, creatorAgentId: f ? n(f.creator_agent) : null } : null,
    token0: tokenBrief(db, r.token0),
    token1: tokenBrief(db, r.token1),
    creator: { agentId: n(r.creator_agent), wallet: s(r.creator) },
    deployTx: s(r.deploy_tx),
    deployBlock: n(r.deploy_block),
    deployTs: n(r.deploy_ts),
    reserve0: String(r.reserve0),
    reserve1: String(r.reserve1),
    // V2 的 reserve 与 V3 的池内余额不是一回事，前端不许放在同一列里不加区分地比较（§7.2.3）。
    reserveSource: r.reserve_source,
    reserveBlock: n(r.reserve_block),
    feePpm: n(r.fee_ppm),
    tickSpacing: n(r.tick_spacing),
    swapCount: Number(r.swap_count),
    vol0: String(r.vol0),
    vol1: String(r.vol1),
    volSkipped: Number(r.vol_skipped),
    mintCount: Number(r.mint_count),
    burnCount: Number(r.burn_count),
    lastPrice: s(r.last_price),
    lastPriceBlock: n(r.last_price_block),
    firstTs: Number(r.first_ts),
    lastTs: Number(r.last_ts),
    detectLevel: r.detect_level,
  };
}

export function transferOut(r) {
  return {
    cursor: `${Number(r.block)}:${Number(r.log_index)}`,
    block: Number(r.block),
    ts: Number(r.ts),
    tx: r.tx,
    logIndex: Number(r.log_index),
    from: r.from_addr,
    to: r.to_addr,
    fromAgentId: n(r.from_agent),
    toAgentId: n(r.to_agent),
    value: String(r.value),
    kind: r.kind,
  };
}

export function swapOut(db, r) {
  const p = db.prepare("SELECT address, kind, token0, token1 FROM pairs WHERE address = ?").get(r.pair);
  return {
    cursor: `${Number(r.block)}:${Number(r.log_index)}`,
    block: Number(r.block),
    ts: Number(r.ts),
    epoch: Number(r.epoch),
    tx: r.tx,
    logIndex: Number(r.log_index),
    pair: {
      address: r.pair,
      kind: p ? p.kind : r.kind,
      token0: p ? tokenBrief(db, p.token0) : null,
      token1: p ? tokenBrief(db, p.token1) : null,
    },
    agentId: n(r.agent_id),
    txFrom: r.tx_from,
    sender: r.sender,
    recipient: s(r.recipient),
    tokenIn: s(r.token_in),
    amountIn: s(r.amount_in),
    tokenOut: s(r.token_out),
    amountOut: s(r.amount_out),
    // side 相对 token0：sell0 = token0 进池子，buy0 = token0 出池子。
    // 前端要显示「买 / 卖」必须自己挑一个基准代币并把基准写在表头上。
    side: r.side,
    price1Per0: s(r.price_1_per_0),
    normalized: !!r.normalized,
  };
}

// ===================== 分类 =====================

/** §7.6：这个合约是个什么。判不出来就是 null，不猜。 */
export function classifiedOf(db, address) {
  if (db.prepare("SELECT 1 AS x FROM pairs WHERE address = ?").get(address)) return "pair";
  if (db.prepare("SELECT 1 AS x FROM amm_factories WHERE address = ?").get(address)) return "factory";
  const t = db.prepare("SELECT is_nft, is_multi_token FROM tokens WHERE address = ?").get(address);
  if (t && !Number(t.is_nft) && !Number(t.is_multi_token)) return "token";
  const p = db.prepare("SELECT state FROM contract_probes WHERE address = ?").get(address);
  if (p && p.state === "nft") return "nft";
  if (p && p.state === "multi_token") return "multi_token";
  if (t && Number(t.is_nft)) return "nft";
  if (t && Number(t.is_multi_token)) return "multi_token";
  return null;
}

export function symbolOf(db, address) {
  const t = db.prepare("SELECT symbol FROM tokens WHERE address = ?").get(address);
  return t ? s(t.symbol) : null;
}

/** 持有者在这条链上扮演什么角色 —— pair 的那一条必须在页面上标成「交易对合约（池子里的钱）」。 */
function roleOf(db, address) {
  const c = classifiedOf(db, address);
  if (c === "pair" || c === "token" || c === "factory") return c;
  return null;
}

function isContract(db, address) {
  if (db.prepare("SELECT 1 AS x FROM contracts WHERE address = ?").get(address)) return true;
  return classifiedOf(db, address) !== null;
}

// ===================== GET /api/tokens =====================

const TOKEN_SORTS = {
  newest: "COALESCE(deploy_block, detected_block) DESC, address ASC",
  holders: "holders DESC, address ASC",
  transfers: "transfers DESC, address ASC",
  swaps: "swap_count DESC, address ASC",
  activity: "last_block DESC, address ASC",
};

/** LIKE 的前缀匹配：只做字面匹配，不做模糊、不做排名加权（§7.6）。 */
function likePrefix(q) {
  return String(q).replace(/([\\%_])/g, "\\$1") + "%";
}

export function tokens(ctx, q = {}) {
  const { db } = ctx;
  const page = intParam(q.page, 1, { min: 1, name: "page" });
  const pageSize = intParam(q.pageSize, 50, { min: 1, max: 200, name: "pageSize" });
  const sort = q.sort || "newest";
  if (!TOKEN_SORTS[sort]) throw badRequest("sort 只能是 newest|holders|transfers|swaps|activity");
  const level = q.level || "all";
  if (!["full", "partial", "all"].includes(level)) throw badRequest("level 只能是 full|partial|all");
  const includeZeroOnly = String(q.includeZeroOnly ?? "0");
  if (!["0", "1"].includes(includeZeroOnly)) throw badRequest("includeZeroOnly 只能是 0 或 1");

  const where = [LIST_FILTER];
  const args = [];
  if (q.agentId !== undefined) {
    where.push("creator_agent = ?");
    args.push(intParam(q.agentId, null, { name: "agentId" }));
  }
  if (level !== "all") {
    where.push("detect_level = ?");
    args.push(level);
  }
  if (includeZeroOnly === "0") where.push("zero_only = 0");
  if (q.q !== undefined && q.q !== "") {
    const raw = String(q.q);
    if (Buffer.byteLength(raw, "utf8") > 64) throw badRequest("q 不能超过 64 字节");
    where.push("(symbol LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR address = ?)");
    let asAddr = raw;
    try {
      asAddr = getAddress(raw.trim());
    } catch {
      /* 不是地址就按前缀匹配走 */
    }
    args.push(likePrefix(raw), likePrefix(raw), asAddr);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM tokens ${whereSql}`).get(...args).c);
  const rows = db
    .prepare(`SELECT * FROM tokens ${whereSql} ORDER BY ${TOKEN_SORTS[sort]} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  return {
    status: 200,
    body: {
      schema: "bac/tokens/1",
      total,
      page,
      pageSize,
      detection: detection(ctx),
      items: rows.map((r) => tokenOut(db, r)),
      updatedAt: nowSec(),
    },
  };
}

// ===================== GET /api/token/{address} =====================

const SUPPLY_NOTE =
  "onchain 是 totalSupply() 的返回值；derived 是按 Transfer 事件推出来的余额之和。两者不一致说明这个代币的转账不守恒（收税或 rebase），以链上为准。";

function derivedSum(db, address) {
  const rows = db.prepare("SELECT balance FROM token_balances WHERE token = ?").all(address);
  return rows.reduce((a, r) => a + BigInt(r.balance || "0"), 0n);
}

function shareBps(balance, totalSupply) {
  const t = BigInt(totalSupply || "0");
  if (t === 0n) return null;
  return Number((BigInt(balance) * 10000n) / t);
}

export function token(ctx, addressRaw) {
  const { db } = ctx;
  const address = addressParam(addressRaw, "address");
  const r = db.prepare("SELECT * FROM tokens WHERE address = ?").get(address);
  if (!r || Number(r.is_nft) || Number(r.is_multi_token)) {
    // 不要只回一个空的 404 —— 前端要能把人接到合约页去（§7.6）。
    const e = new ApiError("not_found", "这个地址没有被识别为代币", 404);
    e.extra = {
      contract: {
        address,
        url: `/api/contract/${address}`,
        classified: classifiedOf(db, address),
        classifiedZh: classifiedZh(classifiedOf(db, address)),
      },
      detection: detection(ctx),
    };
    throw e;
  }
  const derived = derivedSum(db, address);
  const onchain = BigInt(r.total_supply || "0");

  const holderRows = db
    .prepare(
      `SELECT * FROM token_balances WHERE token = ? AND holder NOT IN (?, ?)
        ORDER BY balance_sort DESC, holder ASC LIMIT 10`
    )
    .all(address, ZERO_ADDR, DEAD_ADDR);

  const pairRows = db
    .prepare("SELECT * FROM pairs WHERE token0 = ? OR token1 = ? ORDER BY swap_count DESC, address ASC")
    .all(address, address);

  const transfers = db
    .prepare("SELECT * FROM token_transfers WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT 20")
    .all(address);

  // 公告板上以这个代币地址为 subject 的动作。我们只按 subject 精确匹配，不猜「哪条公告说的是它」。
  const creatorActions = db
    .prepare("SELECT * FROM actions WHERE subject = ? ORDER BY seq DESC LIMIT 10")
    .all(address)
    .map((a) => ({ seq: Number(a.seq), kind: a.kind, summary: a.summary, tx: a.tx, ts: Number(a.ts) }));

  const events = db
    .prepare("SELECT * FROM token_events WHERE address = ? ORDER BY id ASC")
    .all(address)
    .map((e) => ({ kind: e.kind, rule: s(e.rule), detail: s(e.detail), block: Number(e.block), ts: Number(e.ts) }));

  return {
    status: 200,
    body: {
      schema: "bac/token/1",
      detection: detection(ctx),
      token: tokenOut(db, r),
      supplyCheck: {
        onchainTotalSupply: onchain.toString(10),
        derivedHolderSum: derived.toString(10),
        drift: (onchain - derived).toString(10),
        driftCheckedAt: n(r.drift_checked_at),
        note: SUPPLY_NOTE,
      },
      topHolders: holderRows.map((h, i) => ({
        rank: i + 1,
        address: h.holder,
        agentId: n(h.agent_id),
        balance: String(h.balance),
        shareBps: shareBps(h.balance, onchain.toString(10)),
        isContract: isContract(db, h.holder),
        role: roleOf(db, h.holder),
      })),
      pairs: pairRows.map((p) => {
        const other = p.token0 === address ? p.token1 : p.token0;
        return {
          address: p.address,
          kind: p.kind,
          other: tokenBrief(db, other),
          reserve0: String(p.reserve0),
          reserve1: String(p.reserve1),
          swapCount: Number(p.swap_count),
        };
      }),
      recentTransfers: transfers.map(transferOut),
      creatorActions,
      events,
      updatedAt: nowSec(),
    },
  };
}

// ===================== GET /api/token/{address}/holders =====================

export function tokenHolders(ctx, addressRaw, q = {}) {
  const { db } = ctx;
  const address = addressParam(addressRaw, "address");
  const t = db.prepare("SELECT * FROM tokens WHERE address = ?").get(address);
  if (!t) throw notFound("这个地址没有被识别为代币");
  const page = intParam(q.page, 1, { min: 1, name: "page" });
  const pageSize = intParam(q.pageSize, 50, { min: 1, max: 200, name: "pageSize" });
  const total = Number(
    db
      .prepare("SELECT COUNT(*) AS c FROM token_balances WHERE token = ? AND holder NOT IN (?, ?)")
      .get(address, ZERO_ADDR, DEAD_ADDR).c
  );
  const rows = db
    .prepare(
      `SELECT * FROM token_balances WHERE token = ? AND holder NOT IN (?, ?)
        ORDER BY balance_sort DESC, holder ASC LIMIT ? OFFSET ?`
    )
    .all(address, ZERO_ADDR, DEAD_ADDR, pageSize, (page - 1) * pageSize);
  const supply = String(t.total_supply || "0");
  return {
    status: 200,
    body: {
      schema: "bac/token-holders/1",
      token: address,
      total,
      page,
      pageSize,
      detection: detection(ctx),
      balanceDrift: !!t.balance_drift,
      items: rows.map((h, i) => ({
        rank: (page - 1) * pageSize + i + 1,
        address: h.holder,
        agentId: n(h.agent_id),
        balance: String(h.balance),
        shareBps: shareBps(h.balance, supply),
        inTotal: String(h.in_total),
        outTotal: String(h.out_total),
        txCount: Number(h.tx_count),
        isContract: isContract(db, h.holder),
        role: roleOf(db, h.holder),
        firstTs: Number(h.first_ts),
        lastTs: Number(h.last_ts),
      })),
      burned: { amount: String(t.burned_amount || "0"), addresses: BURN_ADDRS },
      updatedAt: nowSec(),
    },
  };
}

// ===================== 游标 =====================

/** 游标是 "{block}:{logIndex}"，不是自增 id：这两张表没有自增列，重放后只有它是稳定的。 */
export function parseCursor(v, name) {
  const m = String(v).match(/^(\d+):(\d+)$/);
  if (!m) throw badRequest(`${name} 必须是 "{block}:{logIndex}" 形状`);
  return { block: Number(m[1]), logIndex: Number(m[2]) };
}

function cursorWhere(q, where, args) {
  let asc = false;
  if (q.before !== undefined) {
    const c = parseCursor(q.before, "before");
    where.push("(block < ? OR (block = ? AND log_index < ?))");
    args.push(c.block, c.block, c.logIndex);
  }
  if (q.after !== undefined) {
    const c = parseCursor(q.after, "after");
    where.push("(block > ? OR (block = ? AND log_index > ?))");
    args.push(c.block, c.block, c.logIndex);
    asc = true;
  }
  return asc;
}

// ===================== GET /api/token/{address}/transfers =====================

export function tokenTransfers(ctx, addressRaw, q = {}) {
  const { db } = ctx;
  const address = addressParam(addressRaw, "address");
  if (!db.prepare("SELECT 1 AS x FROM tokens WHERE address = ?").get(address)) {
    throw notFound("这个地址没有被识别为代币");
  }
  const limit = intParam(q.limit, 50, { min: 1, max: 200, name: "limit" });
  const where = ["token = ?"];
  const args = [address];
  const asc = cursorWhere(q, where, args);

  if (q.direction !== undefined && q.address === undefined) {
    throw badRequest("direction 必须与 address 同时给");
  }
  if (q.address !== undefined) {
    const who = addressParam(q.address, "address");
    const dir = q.direction === undefined ? null : String(q.direction);
    if (dir !== null && dir !== "in" && dir !== "out") throw badRequest("direction 只能是 in 或 out");
    if (dir === "in") {
      where.push("to_addr = ?");
      args.push(who);
    } else if (dir === "out") {
      where.push("from_addr = ?");
      args.push(who);
    } else {
      where.push("(from_addr = ? OR to_addr = ?)");
      args.push(who, who);
    }
  }
  if (q.kind !== undefined) {
    const k = String(q.kind);
    if (!["mint", "burn", "transfer"].includes(k)) throw badRequest("kind 只能是 mint|burn|transfer");
    where.push("kind = ?");
    args.push(k);
  }
  const order = asc ? "block ASC, log_index ASC" : "block DESC, log_index DESC";
  const rows = db
    .prepare(`SELECT * FROM token_transfers WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`)
    .all(...args, limit);
  const items = rows.map(transferOut);
  return {
    status: 200,
    body: {
      schema: "bac/token-transfers/1",
      token: address,
      detection: detection(ctx),
      items,
      next: items.length === limit ? items[items.length - 1].cursor : null,
      updatedAt: nowSec(),
    },
  };
}

// ===================== GET /api/pairs =====================

const PAIR_SORTS = {
  newest: "COALESCE(deploy_block, first_block) DESC, address ASC",
  swaps: "swap_count DESC, address ASC",
  activity: "last_block DESC, address ASC",
};

export function pairs(ctx, q = {}) {
  const { db } = ctx;
  const page = intParam(q.page, 1, { min: 1, name: "page" });
  const pageSize = intParam(q.pageSize, 50, { min: 1, max: 200, name: "pageSize" });
  const sort = q.sort || "newest";
  if (!PAIR_SORTS[sort]) throw badRequest("sort 只能是 newest|swaps|activity");
  const where = [];
  const args = [];
  if (q.token !== undefined) {
    const t = addressParam(q.token, "token");
    where.push("(token0 = ? OR token1 = ?)");
    args.push(t, t);
  }
  if (q.factory !== undefined) {
    where.push("factory = ?");
    args.push(addressParam(q.factory, "factory"));
  }
  if (q.kind !== undefined) {
    const k = String(q.kind);
    if (!["v2", "v3"].includes(k)) throw badRequest("kind 只能是 v2 或 v3");
    where.push("kind = ?");
    args.push(k);
  }
  if (q.agentId !== undefined) {
    where.push("creator_agent = ?");
    args.push(intParam(q.agentId, null, { name: "agentId" }));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM pairs ${whereSql}`).get(...args).c);
  const rows = db
    .prepare(`SELECT * FROM pairs ${whereSql} ORDER BY ${PAIR_SORTS[sort]} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  return {
    status: 200,
    body: {
      schema: "bac/pairs/1",
      total,
      page,
      pageSize,
      detection: detection(ctx),
      items: rows.map((r) => pairOut(db, r)),
      updatedAt: nowSec(),
    },
  };
}

// ===================== GET /api/pair/{address} =====================

const PRICE_NOTE = "这是按池子当前储备算出来的兑换比，不是行情价。本链没有法币计价，也没有预言机。";
const V3_NOTE = "V3 池子只显示池内余额与成交，不显示 tick 深度分布。";

/** price = amt1 * 10^(18+dec0) / (amt0 * 10^dec1)，定点整数，绝不用浮点（§7.3）。 */
function fixedPrice(amt0, amt1, dec0, dec1) {
  const a0 = BigInt(amt0 || "0");
  const a1 = BigInt(amt1 || "0");
  if (a0 === 0n || dec0 === null || dec1 === null) return null;
  return ((a1 * 10n ** BigInt(18 + dec0)) / (a0 * 10n ** BigInt(dec1))).toString(10);
}

export function pair(ctx, addressRaw) {
  const { db } = ctx;
  const address = addressParam(addressRaw, "address");
  const r = db.prepare("SELECT * FROM pairs WHERE address = ?").get(address);
  if (!r) throw notFound("这个地址没有被识别为交易对");
  const d0 = n((db.prepare("SELECT decimals FROM tokens WHERE address = ?").get(r.token0) || {}).decimals);
  const d1 = n((db.prepare("SELECT decimals FROM tokens WHERE address = ?").get(r.token1) || {}).decimals);

  let price1Per0 = fixedPrice(r.reserve0, r.reserve1, d0, d1);
  let price0Per1 = fixedPrice(r.reserve1, r.reserve0, d1, d0);
  let source = r.kind === "v2" ? "reserves" : "balances";
  let atBlock = n(r.reserve_block);
  if (price1Per0 === null) {
    // 储备读不到（或 decimals 未知）时退回到最后一笔成交的成交价。
    price1Per0 = s(r.last_price);
    price0Per1 = null;
    source = price1Per0 === null ? null : "lastSwap";
    atBlock = price1Per0 === null ? null : n(r.last_price_block);
  }

  const recentSwaps = db
    .prepare("SELECT * FROM swaps WHERE pair = ? ORDER BY block DESC, log_index DESC LIMIT 20")
    .all(address)
    .map((x) => swapOut(db, x));
  const liquidity = db
    .prepare("SELECT * FROM liquidity_events WHERE pair = ? ORDER BY block DESC, log_index DESC LIMIT 50")
    .all(address)
    .map((x) => ({
      tx: x.tx,
      block: Number(x.block),
      ts: Number(x.ts),
      agentId: n(x.agent_id),
      kind: x.kind,
      amount0: String(x.amount0),
      amount1: String(x.amount1),
    }));

  const body = {
    schema: "bac/pair/1",
    detection: detection(ctx),
    pair: pairOut(db, r),
    price: { price1Per0, price0Per1, source, atBlock, note: PRICE_NOTE },
    recentSwaps,
    liquidity,
    updatedAt: nowSec(),
  };
  // V2 时 v3Note 不出现。
  if (r.kind === "v3") body.v3Note = V3_NOTE;
  return { status: 200, body };
}

// ===================== GET /api/swaps =====================

export function swaps(ctx, q = {}) {
  const { db } = ctx;
  const limit = intParam(q.limit, 50, { min: 1, max: 200, name: "limit" });
  const where = [];
  const args = [];
  if (q.pair !== undefined) {
    where.push("pair = ?");
    args.push(addressParam(q.pair, "pair"));
  }
  if (q.token !== undefined) {
    const t = addressParam(q.token, "token");
    where.push("(token_in = ? OR token_out = ?)");
    args.push(t, t);
  }
  if (q.agentId !== undefined) {
    where.push("agent_id = ?");
    args.push(intParam(q.agentId, null, { name: "agentId" }));
  }
  if (q.normalized !== undefined) {
    const v = String(q.normalized);
    if (!["0", "1", "all"].includes(v)) throw badRequest("normalized 只能是 0|1|all");
    if (v !== "all") {
      where.push("normalized = ?");
      args.push(Number(v));
    }
  }
  const asc = cursorWhere(q, where, args);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = asc ? "block ASC, log_index ASC" : "block DESC, log_index DESC";
  const rows = db.prepare(`SELECT * FROM swaps ${whereSql} ORDER BY ${order} LIMIT ?`).all(...args, limit);
  const items = rows.map((r) => swapOut(db, r));
  return {
    status: 200,
    body: {
      schema: "bac/swaps/1",
      detection: detection(ctx),
      items,
      next: items.length === limit ? items[items.length - 1].cursor : null,
      anchoredThrough: anchoredThrough(db),
      updatedAt: nowSec(),
    },
  };
}

// ===================== GET /api/contract/{address} =====================

export function contract(ctx, addressRaw) {
  const { db } = ctx;
  const address = addressParam(addressRaw, "address");
  const c = db.prepare("SELECT * FROM contracts WHERE address = ?").get(address);
  const probe = db.prepare("SELECT * FROM contract_probes WHERE address = ?").get(address);
  const t = db.prepare("SELECT * FROM tokens WHERE address = ?").get(address);
  const p = db.prepare("SELECT * FROM pairs WHERE address = ?").get(address);
  const f = db.prepare("SELECT * FROM amm_factories WHERE address = ?").get(address);
  if (!c && !probe && !t && !p && !f) throw notFound(`没有合约 ${address}`);

  const cls = classifiedOf(db, address);
  const callers = db
    .prepare(
      `SELECT agent_id, COUNT(*) AS calls, MAX(ts) AS last_ts FROM txs
        WHERE to_addr = ? GROUP BY agent_id ORDER BY calls DESC LIMIT 20`
    )
    .all(address)
    .map((r) => ({ agentId: n(r.agent_id), calls: Number(r.calls), lastTs: Number(r.last_ts) }));

  return {
    status: 200,
    body: {
      schema: "bac/contract/1",
      detection: detection(ctx),
      contract: c
        ? {
            address: c.address,
            deployer: c.deployer,
            agentId: n(c.agent_id),
            tx: c.tx,
            block: Number(c.block),
            ts: Number(c.ts),
            codeSize: Number(c.code_size),
            callCount: Number(c.call_count),
            lastCall: n(c.last_call),
          }
        : // 部署记录早于索引起点：照实写 null，不许猜（§7.2.4）。
          {
            address,
            deployer: null,
            agentId: null,
            tx: null,
            block: null,
            ts: null,
            codeSize: null,
            callCount: 0,
            lastCall: null,
          },
      classified: cls,
      classifiedZh: classifiedZh(cls),
      token: t ? tokenOut(db, t) : null,
      pair: p ? pairOut(db, p) : null,
      factory: f
        ? {
            address: f.address,
            kind: f.kind,
            creator: s(f.creator),
            creatorAgentId: n(f.creator_agent),
            deployTx: s(f.deploy_tx),
            deployBlock: n(f.deploy_block),
            pairCount: Number(f.pair_count),
            firstTs: Number(f.first_ts),
            lastTs: Number(f.last_ts),
          }
        : null,
      probe: probe
        ? {
            state: probe.state,
            probeBlock: n(probe.probe_block),
            probedAt: n(probe.probed_at),
            attempts: Number(probe.attempts),
            lastError: s(probe.last_error),
          }
        : null,
      events: db
        .prepare("SELECT * FROM token_events WHERE address = ? ORDER BY id ASC")
        .all(address)
        .map((e) => ({ kind: e.kind, rule: s(e.rule), detail: s(e.detail), block: Number(e.block), ts: Number(e.ts) })),
      callers,
      updatedAt: nowSec(),
    },
  };
}

// ===================== §7.7 给既有端点用的增量 =====================

/** /api/summary 的 built 块。**只有计数，没有金额** —— 不得与 treasury / gasFees 合并。 */
export function builtSummary(ctx) {
  const { db } = ctx;
  const one = (sql, ...a) => Number(db.prepare(sql).get(...a).c);
  const firstToken = db.prepare(`SELECT MIN(first_ts) AS t FROM tokens WHERE ${LIST_FILTER}`).get();
  const firstPair = db.prepare("SELECT MIN(first_ts) AS t FROM pairs").get();
  return {
    tokens: one(`SELECT COUNT(*) AS c FROM tokens WHERE ${LIST_FILTER}`),
    pairs: one("SELECT COUNT(*) AS c FROM pairs"),
    factories: one("SELECT COUNT(*) AS c FROM amm_factories"),
    swaps: one("SELECT COUNT(*) AS c FROM swaps"),
    transfers: one("SELECT COUNT(*) AS c FROM token_transfers"),
    unclassifiedContracts: unclassifiedContracts(db),
    firstTokenTs: firstToken && firstToken.t != null ? Number(firstToken.t) : null,
    firstPairTs: firstPair && firstPair.t != null ? Number(firstPair.t) : null,
    detection: detection(ctx),
  };
}

/** /api/agent/{id} 的 built / trades / holdings 三块。 */
export function agentBuilt(ctx, agentId) {
  const { db } = ctx;
  const tokenRows = db
    .prepare(`SELECT * FROM tokens WHERE creator_agent = ? AND ${LIST_FILTER} ORDER BY deploy_block DESC`)
    .all(agentId);
  const pairRows = db.prepare("SELECT * FROM pairs WHERE creator_agent = ? ORDER BY deploy_block DESC").all(agentId);
  const factoryRows = db
    .prepare("SELECT * FROM amm_factories WHERE creator_agent = ? ORDER BY deploy_block DESC")
    .all(agentId);

  const agg = db
    .prepare("SELECT COUNT(*) AS c, MIN(ts) AS f, MAX(ts) AS l FROM swaps WHERE agent_id = ?")
    .get(agentId);
  const byPair = db
    .prepare("SELECT pair, COUNT(*) AS c FROM swaps WHERE agent_id = ? GROUP BY pair ORDER BY c DESC LIMIT 20")
    .all(agentId)
    .map((r) => ({ address: r.pair, swaps: Number(r.c) }));
  const recent = db
    .prepare("SELECT * FROM swaps WHERE agent_id = ? ORDER BY block DESC, log_index DESC LIMIT 10")
    .all(agentId)
    .map((r) => swapOut(db, r));

  const holdingRows = db
    .prepare(
      `SELECT b.*, t.symbol AS symbol, t.decimals AS decimals, t.total_supply AS total_supply, t.balance_drift AS balance_drift
         FROM token_balances b JOIN tokens t ON t.address = b.token
        WHERE b.agent_id = ? AND b.balance != '0' AND t.is_nft = 0 AND t.is_multi_token = 0
        ORDER BY b.balance_sort DESC, b.token ASC LIMIT 21`
    )
    .all(agentId);
  const holdings = holdingRows.slice(0, 20).map((h) => ({
    token: h.token,
    symbol: s(h.symbol),
    decimals: n(h.decimals),
    balance: String(h.balance),
    shareBps: shareBps(h.balance, String(h.total_supply || "0")),
    balanceDrift: !!h.balance_drift,
  }));

  return {
    built: {
      tokens: tokenRows.map((r) => tokenOut(db, r)),
      pairs: pairRows.map((r) => pairOut(db, r)),
      factories: factoryRows.map((r) => ({
        address: r.address,
        kind: r.kind,
        pairCount: Number(r.pair_count),
        deployTx: s(r.deploy_tx),
        deployBlock: n(r.deploy_block),
        firstTs: Number(r.first_ts),
        lastTs: Number(r.last_ts),
      })),
    },
    trades: {
      swapCount: Number(agg.c),
      firstTs: agg.f == null ? null : Number(agg.f),
      lastTs: agg.l == null ? null : Number(agg.l),
      pairs: byPair,
      recent,
    },
    holdings,
    holdingsTruncated: holdingRows.length > 20,
  };
}

/** /api/agents 每个元素追加的三个计数。 */
export function agentBuiltCounts(db, agentId) {
  const c1 = db
    .prepare(`SELECT COUNT(*) AS c FROM tokens WHERE creator_agent = ? AND ${LIST_FILTER}`)
    .get(agentId);
  const c2 = db.prepare("SELECT COUNT(*) AS c FROM pairs WHERE creator_agent = ?").get(agentId);
  const c3 = db.prepare("SELECT COUNT(*) AS c FROM swaps WHERE agent_id = ?").get(agentId);
  return { tokensIssued: Number(c1.c), pairsCreated: Number(c2.c), swapCount: Number(c3.c) };
}

export { LIST_FILTER };
