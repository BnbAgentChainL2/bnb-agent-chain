// src/economy/index.js —— 决策 #19 的主流程：把 agent 自己部署的合约解码成代币 / 交易对 / 成交。
//
// 我们不发任何官方 DEX、官方代币、官方工具合约（§7.0 第 1 条）。这里**只读**：
// 把链上已经发生的事按日志形状和 eth_call 应答解出来给人看，解不出来就照实写「未识别」。
//
// 顺序（每批日志一次）：
//   1. 解析日志，收集候选地址（代币候选来自 Transfer；交易对候选来自 PairCreated/PoolCreated/Sync/Swap/Initialize）；
//   2. 先探代币、再探交易对 —— 交易对的 P4 要求至少一边是已识别代币，所以顺序不能反；
//   3. 一个事务里把探测结论、身份行、流水行、计数器、feed 全写完。
//
// 幂等（§7.5.1）：流水表主键都是 (tx, log_index)，一律 INSERT OR IGNORE，
// **所有计数器与累计量只在 changes() == 1（这条日志第一次写入）时才动**。没有这一条，一次重启就能让持有量翻倍。
import { tx as withTx } from "../db.js";
import { agentIdOfWallet } from "../store.js";
import { epochOf, addr, hash } from "../decode.js";
import { warn } from "../warnings.js";
import { renderTokenNew, renderPairNew, renderTokenFirstTrade } from "../render.js";
import { ProbeSession, ProbeUnavailable } from "./probe.js";
import { probeToken, probePair, balanceOfData, decodeUint256 } from "./classify.js";
import { parseBuiltLog, parseBuiltLogs } from "./parse.js";
import { BURN_ADDRS, ZERO_ADDR, DEAD_ADDR, SYSTEM_ADDRS } from "./constants.js";

const isBurn = (a) => BURN_ADDRS.includes(a);
const isSystem = (a) => SYSTEM_ADDRS.has(String(a).toLowerCase());

/** 探测失败连续多少次才写 last_error 并降频（§7.5.1 第 8 条）。 */
export const PROBE_FAIL_LOUD_AT = 10;

// ---------------------------------------------------------------- 小工具

/** INSERT OR IGNORE，返回 true 表示这一行是第一次写入（计数器只在 true 时动）。 */
function insertIgnore(db, table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols
    .map(() => "?")
    .join(", ")})`;
  const info = db.prepare(sql).run(...cols.map((c) => norm(row[c])));
  return Number(info.changes || 0) === 1;
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return v.toString(10);
  return v;
}

function tokenEvent(db, { address, kind, rule = null, detail = null, block, ts }) {
  db.prepare("INSERT INTO token_events (address, kind, rule, detail, block, ts) VALUES (?,?,?,?,?,?)").run(
    address,
    kind,
    rule,
    detail,
    Number(block),
    Number(ts)
  );
}

/** 由层内钱包反查 agentId。 */
function agentOf(db, wallet) {
  if (!wallet) return null;
  return agentIdOfWallet(db, wallet);
}

/** 部署记录。查不到就返回全 null —— 页面显示「部署者未知（早于索引起点）」，不许猜（§7.2.4）。 */
function deployInfo(db, address) {
  const c = db.prepare("SELECT * FROM contracts WHERE address = ?").get(address);
  if (!c) return { creator: null, creator_agent: null, deploy_tx: null, deploy_block: null, deploy_ts: null };
  return {
    creator: c.deployer,
    creator_agent: c.agent_id === null || c.agent_id === undefined ? null : Number(c.agent_id),
    deploy_tx: c.tx,
    deploy_block: Number(c.block),
    deploy_ts: Number(c.ts),
  };
}

/** 这笔交易的 tx.from（§7.3：成交归属取 tx.from，不是 sender / recipient）。 */
function txFromOf(db, txHash) {
  const r = db.prepare("SELECT from_addr, agent_id FROM txs WHERE hash = ?").get(hash(txHash));
  if (!r) return { from: null, agentId: null };
  return { from: r.from_addr, agentId: r.agent_id === null || r.agent_id === undefined ? null : Number(r.agent_id) };
}

export function isKnownToken(db, address) {
  const r = db
    .prepare("SELECT 1 AS x FROM tokens WHERE address = ? AND is_nft = 0 AND is_multi_token = 0")
    .get(address);
  return !!r;
}

/** feed 去重键用的稳定串。 */
const feedUniq = (kind, address) => `layer:${String(address).toLowerCase()}:${kind}`;

// ---------------------------------------------------------------- 候选收集

/**
 * 从一批已解析的日志里收集候选。
 * 返回 { tokens: Map, pairs: Map, factories: Map, nft: Set, multi: Set }
 */
export function collectCandidates(parsed) {
  const tokens = new Map();
  const pairs = new Map();
  const factories = new Map();
  const nft = new Set();
  const multi = new Set();

  const touchToken = (a, p, shapeOk) => {
    if (isSystem(a)) return; // X6
    const cur = tokens.get(a) || { address: a, shapeOk: false, block: p.block, ts: p.ts };
    cur.shapeOk = cur.shapeOk || shapeOk;
    tokens.set(a, cur);
  };
  const touchPair = (a, p, kind, via, factory = null) => {
    if (isSystem(a)) return; // X6
    const cur = pairs.get(a) || { address: a, kind, via, factory, block: p.block, ts: p.ts, createTx: null };
    // 工厂路径比事件路径可信：工厂给的形状与 factory 地址覆盖事件路径猜的。
    if (via === "factory") {
      cur.via = "factory";
      cur.kind = kind;
      cur.factory = factory;
      // §7.2.4：工厂用 CREATE2 造池子时收据里没有 contractAddress，contracts 表查不到这个地址。
      // 发出 PairCreated 的那笔交易的 tx.from 就是调 createPair 的那个 agent —— 正是我们想显示的人。
      cur.createTx = p.tx;
      cur.block = p.block;
      cur.ts = p.ts;
    }
    pairs.set(a, cur);
  };

  for (const p of parsed) {
    switch (p.type) {
      case "transfer":
        touchToken(p.address, p, true);
        break;
      case "transfer_odd":
        touchToken(p.address, p, false);
        break;
      case "transfer_nft":
        nft.add(p.address); // X2
        touchToken(p.address, p, false);
        break;
      case "erc1155":
        multi.add(p.address); // X1
        touchToken(p.address, p, false);
        break;
      case "pair_created":
        if (!isSystem(p.address)) factories.set(p.address, { address: p.address, kind: p.kind, block: p.block, ts: p.ts });
        touchPair(p.pair, p, p.kind, "factory", isSystem(p.address) ? null : p.address);
        break;
      case "sync":
      case "init":
      case "swap":
      case "liquidity":
        touchPair(p.address, p, p.kind, "event");
        break;
      default:
        break;
    }
  }
  return { tokens, pairs, factories, nft, multi };
}

// ---------------------------------------------------------------- 主流程

/**
 * 处理一批层内日志的「agent 造出来的东西」部分。
 * 参数：
 *   logs   —— 与 ingestLogs 同一批（已 normalizeLog）
 *   rpc    —— 有 call(method, params) 的对象；离线测试传桩
 *   tsOf   —— (blockNumber) => 时间戳
 *   maxCallsPerContract —— 每个合约的 eth_call 预算上限（§7.1「要便宜」）
 * 返回统计：{ probed, tokens, pairs, factories, transfers, swaps, liquidity, unavailable }
 */
export async function processBuiltLogs(db, { logs, rpc, tsOf, now = Math.floor(Date.now() / 1000), maxCallsPerContract = 16 }) {
  const parsed = parseBuiltLogs(logs, tsOf);
  if (parsed.length === 0) return empty();
  const cand = collectCandidates(parsed);

  // ---- 第一步：先把 X1 / X2 的标记落下来（不需要探测就能下的结论），并对已入表的代币执行降级。
  const demotions = [];
  for (const a of cand.nft) demotions.push({ address: a, rule: "X2", state: "nft" });
  for (const a of cand.multi) demotions.push({ address: a, rule: "X1", state: "multi_token" });

  // ---- 第二步：探代币。只探「还没有定论」的地址。
  const settled = new Map(
    db.prepare("SELECT address, state, attempts, probed_at FROM contract_probes").all().map((r) => [r.address, r])
  );
  const nftOrMulti = new Set([...cand.nft, ...cand.multi].map((a) => a));
  const tokenResults = new Map();
  let unavailable = 0;

  for (const c of cand.tokens.values()) {
    if (nftOrMulti.has(c.address)) continue; // X1 / X2：直接定论，不浪费一次探测
    const prev = settled.get(c.address);
    if (prev && prev.state !== "pending" && prev.state !== "not_token") continue; // 已经定了，不重复探
    if (prev && prev.state === "not_token" && !shouldRetryNotToken(prev, now)) continue;
    if (!c.shapeOk && !prev) {
      // 连一条形状正确的 Transfer 都没见过：记下来，但别打 RPC。
      tokenResults.set(c.address, { isToken: false, reason: "N2：没有见过形状正确的 ERC-20 Transfer", cand: c, calls: 0 });
      continue;
    }
    const session = new ProbeSession(rpc, c.block, { maxCalls: maxCallsPerContract });
    try {
      const r = await probeToken(session, c.address, { shapeOk: c.shapeOk });
      tokenResults.set(c.address, { ...r, cand: c, session });
    } catch (e) {
      if (e instanceof ProbeUnavailable) {
        unavailable += 1;
        tokenResults.set(c.address, { unavailable: true, error: String(e.message || e), cand: c });
      } else throw e;
    }
  }

  // ---- 第三步：探交易对。P4 要查「已知代币」，所以要把本批刚判出来的代币也算进去。
  const freshTokens = new Set(
    [...tokenResults.entries()].filter(([, r]) => r.isToken).map(([a]) => a)
  );
  const known = (a) => freshTokens.has(a) || isKnownToken(db, a);

  // 本批的候选 + 之前停在 waiting_token 里、现在可能有救的候选，一起探。
  const pairQueue = new Map();
  for (const c of cand.pairs.values()) pairQueue.set(c.address, c);
  for (const row of db.prepare("SELECT * FROM pair_candidates WHERE state = 'waiting_token'").all()) {
    if (pairQueue.has(row.address)) continue;
    if (!(known(row.token0) || known(row.token1))) continue; // 还是没救，别浪费探测
    pairQueue.set(row.address, {
      address: row.address,
      kind: row.kind,
      via: row.factory ? "factory" : "event",
      factory: row.factory,
      block: Number(row.seen_block),
      ts: Number(row.seen_ts),
      retry: true,
    });
  }

  const pairResults = new Map();
  for (const c of pairQueue.values()) {
    const prev = settled.get(c.address);
    if (prev && (prev.state === "pair" || prev.state === "token" || prev.state === "factory")) continue;
    if (prev && prev.state === "not_token" && !c.retry && !shouldRetryNotToken(prev, now)) continue;
    const session = new ProbeSession(rpc, c.block, { maxCalls: maxCallsPerContract });
    try {
      const r = await probePair(session, c.address, { hint: c.kind, isKnownToken: known });
      pairResults.set(c.address, { ...r, cand: c, session });
    } catch (e) {
      if (e instanceof ProbeUnavailable) {
        unavailable += 1;
        pairResults.set(c.address, { unavailable: true, error: String(e.message || e), cand: c });
      } else throw e;
    }
  }

  // ---- 第四步：一个事务里写完所有东西。
  const stats = empty();
  stats.probed = tokenResults.size + pairResults.size;
  stats.unavailable = unavailable;

  withTx(db, () => {
    // 4.1 X1 / X2 的定论与降级
    for (const d of demotions) {
      const c = cand.tokens.get(d.address) || { block: 0, ts: now };
      setProbe(db, d.address, { state: d.state, probe_block: null, probed_at: now, first_seen_block: c.block, first_seen_ts: c.ts });
      const t = db.prepare("SELECT address, is_nft, is_multi_token FROM tokens WHERE address = ?").get(d.address);
      if (t) {
        const col = d.rule === "X2" ? "is_nft" : "is_multi_token";
        if (Number(t[col]) !== 1) {
          db.prepare(`UPDATE tokens SET "${col}" = 1 WHERE address = ?`).run(d.address);
          tokenEvent(db, {
            address: d.address,
            kind: "DEMOTED",
            rule: d.rule,
            detail:
              d.rule === "X2"
                ? "曾被识别为代币，后因 X2 移出（出现了 4 个 topic 的 Transfer，是 NFT 形状）"
                : "曾被识别为代币，后因 X1 移出（出现了 ERC-1155 的 TransferSingle / TransferBatch）",
            block: c.block,
            ts: c.ts,
          });
        }
      }
    }

    // 4.2 代币探测结论
    for (const [address, r] of tokenResults) {
      const c = r.cand;
      if (r.unavailable) {
        // 探测失败 ≠ 不是代币：留在 pending，只加 attempts。
        bumpProbeFailure(db, address, c, r.error, now);
        continue;
      }
      if (!r.isToken) {
        setProbe(db, address, {
          state: "not_token",
          probe_block: r.probeBlock ?? null,
          probed_at: now,
          last_error: null,
          first_seen_block: c.block,
          first_seen_ts: c.ts,
        });
        continue;
      }
      setProbe(db, address, {
        state: "token",
        probe_block: r.probeBlock ?? null,
        probed_at: now,
        last_error: null,
        first_seen_block: c.block,
        first_seen_ts: c.ts,
      });
      const fresh = upsertToken(db, address, r, c);
      if (fresh) stats.tokens += 1;
    }

    // 4.3 工厂
    for (const f of cand.factories.values()) {
      const d = deployInfo(db, f.address);
      const fresh = insertIgnore(db, "amm_factories", {
        address: f.address,
        kind: f.kind,
        creator: d.creator,
        creator_agent: d.creator_agent,
        deploy_tx: d.deploy_tx,
        deploy_block: d.deploy_block,
        deploy_ts: d.deploy_ts,
        pair_count: 0,
        first_ts: f.ts,
        last_ts: f.ts,
      });
      if (fresh) stats.factories += 1;
      db.prepare("UPDATE amm_factories SET last_ts = MAX(last_ts, ?) WHERE address = ?").run(f.ts, f.address);
      setProbe(db, f.address, {
        state: "factory",
        probe_block: null,
        probed_at: now,
        first_seen_block: f.block,
        first_seen_ts: f.ts,
      });
    }

    // 4.4 交易对探测结论
    for (const [address, r] of pairResults) {
      const c = r.cand;
      if (r.unavailable) {
        bumpProbeFailure(db, address, c, r.error, now);
        continue;
      }
      if (!r.ok && r.waiting) {
        // P4 没过：停在 pair_candidates 等某一边被判成代币，顺序无关（先建池后发币也能被认出来）。
        db.prepare(
          `INSERT INTO pair_candidates (address, kind, token0, token1, factory, state, reason, seen_block, seen_ts, retried_at)
           VALUES (?,?,?,?,?,'waiting_token',?,?,?,?)
           ON CONFLICT(address) DO UPDATE SET token0 = excluded.token0, token1 = excluded.token1,
             kind = excluded.kind, reason = excluded.reason, retried_at = excluded.retried_at`
        ).run(address, r.kind, r.token0, r.token1, c.factory ?? null, r.reason, c.block, c.ts, now);
        setProbe(db, address, {
          state: "pending",
          probe_block: null,
          probed_at: now,
          first_seen_block: c.block,
          first_seen_ts: c.ts,
        });
        continue;
      }
      if (!r.ok) {
        db.prepare(
          `INSERT INTO pair_candidates (address, kind, token0, token1, factory, state, reason, seen_block, seen_ts, retried_at)
           VALUES (?,?,?,?,?,'rejected',?,?,?,?)
           ON CONFLICT(address) DO UPDATE SET state = 'rejected', reason = excluded.reason, retried_at = excluded.retried_at`
        ).run(address, c.kind, null, null, c.factory ?? null, r.reason, c.block, c.ts, now);
        setProbe(db, address, {
          state: "not_token",
          probe_block: null,
          probed_at: now,
          first_seen_block: c.block,
          first_seen_ts: c.ts,
        });
        continue;
      }
      const fresh = upsertPair(db, address, r, c, now);
      if (fresh) stats.pairs += 1;
      setProbe(db, address, {
        state: "pair",
        probe_block: r.probeBlock ?? null,
        probed_at: now,
        last_error: null,
        first_seen_block: c.block,
        first_seen_ts: c.ts,
      });
      db.prepare("UPDATE pair_candidates SET state = 'rejected', reason = '已确认为交易对' WHERE address = ?").run(address);
    }

    // 4.5 流水：Transfer / Swap / 流动性 / Sync
    const touchedTokens = new Set();
    for (const p of parsed) {
      if (p.type === "transfer" && isKnownToken(db, p.address)) {
        if (applyTransfer(db, p)) {
          stats.transfers += 1;
          touchedTokens.add(p.address);
        }
      } else if (p.type === "swap") {
        if (applySwap(db, p)) stats.swaps += 1;
      } else if (p.type === "liquidity") {
        if (applyLiquidity(db, p)) stats.liquidity += 1;
      } else if (p.type === "sync") {
        applySync(db, p);
      }
    }

    // 4.6 X5：重算 zero_only（totalSupply 恒为 0 且 Transfer 全是 value == 0）
    for (const [a, r] of tokenResults) if (r.isToken) touchedTokens.add(a);
    for (const a of touchedTokens) refreshZeroOnly(db, a, now);
  });

  return stats;
}

function empty() {
  return { probed: 0, tokens: 0, pairs: 0, factories: 0, transfers: 0, swaps: 0, liquidity: 0, unavailable: 0 };
}

/** not_token 的重探规则（§7.1.6）：有新的 Transfer 且上次探测早于 24 小时前才重探（合约可能是代理）。 */
function shouldRetryNotToken(prev, now) {
  const at = Number(prev.probed_at || 0);
  return now - at >= 24 * 3600;
}

function setProbe(db, address, fields) {
  const row = {
    address,
    state: fields.state,
    probe_block: fields.probe_block ?? null,
    probed_at: fields.probed_at ?? null,
    attempts: 0,
    last_error: fields.last_error ?? null,
    first_seen_block: Number(fields.first_seen_block || 0),
    first_seen_ts: Number(fields.first_seen_ts || 0),
  };
  const fresh = insertIgnore(db, "contract_probes", row);
  if (!fresh) {
    db.prepare(
      `UPDATE contract_probes SET state = ?, probe_block = ?, probed_at = ?, last_error = ?,
         attempts = CASE WHEN ? = 'pending' THEN attempts ELSE 0 END
       WHERE address = ?`
    ).run(row.state, row.probe_block, row.probed_at, row.last_error, row.state, address);
  }
}

/** 探测失败：只 attempts += 1 并留在 pending；连续 10 次才写 last_error（§7.5.1 第 8 条）。 */
function bumpProbeFailure(db, address, cand, message, now) {
  insertIgnore(db, "contract_probes", {
    address,
    state: "pending",
    probe_block: null,
    probed_at: null,
    attempts: 0,
    last_error: null,
    first_seen_block: Number(cand.block || 0),
    first_seen_ts: Number(cand.ts || now),
  });
  db.prepare(
    `UPDATE contract_probes
       SET attempts = attempts + 1,
           state = 'pending',
           last_error = CASE WHEN attempts + 1 >= ? THEN ? ELSE last_error END
     WHERE address = ?`
  ).run(PROBE_FAIL_LOUD_AT, message, address);
  warn("probe_unavailable", `${address} 的探测暂时做不了：${message}（留在 pending，不写 not_token）`);
}

// ---------------------------------------------------------------- 身份行

function upsertToken(db, address, r, c) {
  const d = deployInfo(db, address);
  const fresh = insertIgnore(db, "tokens", {
    address,
    name: r.name,
    symbol: r.symbol,
    decimals: r.decimals,
    total_supply: r.totalSupply,
    supply_block: r.probeBlock ?? c.block,
    supply_stale: 0,
    creator: d.creator,
    creator_agent: d.creator_agent,
    deploy_tx: d.deploy_tx,
    deploy_block: d.deploy_block,
    deploy_ts: d.deploy_ts,
    detect_level: r.detectLevel,
    detected_block: c.block,
    first_block: c.block,
    first_ts: c.ts,
    last_block: c.block,
    last_ts: c.ts,
  });
  if (fresh) {
    tokenEvent(db, { address, kind: "DETECTED", rule: null, detail: `detect_level = ${r.detectLevel}`, block: c.block, ts: c.ts });
    pushFeed(db, {
      uniq: feedUniq("token_new", address),
      kind: "TOKEN_NEW",
      ts: c.ts,
      block: c.block,
      agentId: d.creator_agent,
      textZh: renderTokenNew({ agentId: d.creator_agent, symbol: r.symbol, address, totalSupply: r.totalSupply }),
      tx: d.deploy_tx || "0x",
      epoch: epochOf(c.ts),
    });
    // 这个代币在被认出来之前可能已经有过 Transfer（探测失败重试、或先建池后发币）。
    // 按地址把已落库的原始日志回放一遍 —— 所有写入都是幂等的，重放不会多算。
    backfillAddress(db, address);
  } else {
    // 幂等字段可以更新；累计计数器绝不在这里动（§7.5.1 第 4 条）。
    const prev = db.prepare("SELECT detect_level FROM tokens WHERE address = ?").get(address);
    db.prepare(
      `UPDATE tokens SET name = ?, symbol = ?, decimals = ?, total_supply = ?, supply_block = ?,
         supply_stale = 0, detect_level = ? WHERE address = ?`
    ).run(r.name, r.symbol, r.decimals, r.totalSupply, r.probeBlock ?? c.block, r.detectLevel, address);
    if (prev && prev.detect_level !== r.detectLevel) {
      tokenEvent(db, {
        address,
        kind: "RELEVEL",
        rule: null,
        detail: `detect_level ${prev.detect_level} -> ${r.detectLevel}`,
        block: c.block,
        ts: c.ts,
      });
    }
  }
  return fresh;
}

function upsertPair(db, address, r, c, now) {
  const d = deployInfo(db, address);
  if (d.creator === null && c.createTx) {
    // 路径 A 的归属（§7.2.4）。路径 B 不做这件事：第一条 Sync 的那笔交易不是建池交易，猜了就是错的。
    const t = txFromOf(db, c.createTx);
    if (t.from) {
      d.creator = t.from;
      d.creator_agent = t.agentId;
      d.deploy_tx = c.createTx;
      d.deploy_block = c.block;
      d.deploy_ts = c.ts;
    }
  }
  const fresh = insertIgnore(db, "pairs", {
    address,
    kind: r.kind,
    factory: c.factory ?? r.factory ?? null,
    discovered_via: c.via === "factory" ? "factory" : "event",
    token0: r.token0,
    token1: r.token1,
    fee_ppm: r.feePpm,
    tick_spacing: r.tickSpacing,
    creator: d.creator,
    creator_agent: d.creator_agent,
    deploy_tx: d.deploy_tx,
    deploy_block: d.deploy_block,
    deploy_ts: d.deploy_ts,
    reserve0: r.reserve0,
    reserve1: r.reserve1,
    reserve_source: r.reserveSource,
    reserve_block: r.probeBlock ?? c.block,
    first_block: c.block,
    first_ts: c.ts,
    last_block: c.block,
    last_ts: c.ts,
    detect_level: r.detectLevel,
  });
  if (fresh) {
    for (const t of [r.token0, r.token1]) {
      if (isKnownToken(db, t)) db.prepare("UPDATE tokens SET pair_count = pair_count + 1 WHERE address = ?").run(t);
    }
    const fac = c.factory ?? r.factory ?? null;
    if (fac) db.prepare("UPDATE amm_factories SET pair_count = pair_count + 1 WHERE address = ?").run(fac);
    const sym = (a) => {
      const t = db.prepare("SELECT symbol FROM tokens WHERE address = ?").get(a);
      return (t && t.symbol) || null;
    };
    pushFeed(db, {
      uniq: feedUniq("pair_new", address),
      kind: "PAIR_NEW",
      ts: c.ts,
      block: c.block,
      agentId: d.creator_agent,
      textZh: renderPairNew({
        agentId: d.creator_agent,
        symbol0: sym(r.token0),
        address0: r.token0,
        symbol1: sym(r.token1),
        address1: r.token1,
        address,
      }),
      tx: d.deploy_tx || "0x",
      epoch: epochOf(c.ts),
    });
    // 先建池、后发币的情形：确认之后把这个地址上已落库的 Swap / Sync / 流动性日志回放一遍。
    backfillAddress(db, address);
  } else {
    db.prepare(
      `UPDATE pairs SET reserve0 = ?, reserve1 = ?, reserve_source = ?, reserve_block = ?,
         fee_ppm = COALESCE(?, fee_ppm), tick_spacing = COALESCE(?, tick_spacing), detect_level = ?
       WHERE address = ?`
    ).run(r.reserve0, r.reserve1, r.reserveSource, r.probeBlock ?? c.block, r.feePpm, r.tickSpacing, r.detectLevel, address);
  }
  return fresh;
}

// ---------------------------------------------------------------- 流水

/**
 * 按地址回放已落库的层内原始日志（logs 表）。
 * 用在「一个地址刚刚被确认成代币 / 交易对」的时刻：它在被认出来之前发的那些 Transfer / Swap
 * 当时没地方落，必须补上 —— §7.2.3 的「顺序无关：先建池后发币也能被认出来」靠的就是这一步。
 * 所有写入都带 (tx, log_index) 主键且 INSERT OR IGNORE，重放不会多算任何一个计数器。
 */
export function backfillAddress(db, address) {
  const rows = db
    .prepare("SELECT * FROM logs WHERE chain = 'layer' AND address = ? ORDER BY block ASC, log_index ASC")
    .all(address);
  let n = 0;
  for (const r of rows) {
    let topics;
    try {
      topics = JSON.parse(r.topics);
    } catch {
      continue;
    }
    const log = {
      address: r.address,
      topics,
      data: r.data,
      blockNumber: Number(r.block),
      transactionHash: r.tx,
      logIndex: Number(r.log_index),
    };
    const p = parseBuiltLog(log, Number(r.ts));
    if (!p) continue;
    if (p.type === "transfer" && isKnownToken(db, p.address)) {
      if (applyTransfer(db, p)) n += 1;
    } else if (p.type === "swap") {
      if (applySwap(db, p)) n += 1;
    } else if (p.type === "liquidity") {
      if (applyLiquidity(db, p)) n += 1;
    } else if (p.type === "sync") {
      applySync(db, p);
    }
  }
  return n;
}

/** Transfer -> token_transfers + token_balances + tokens 的计数器。 */
export function applyTransfer(db, p) {
  const value = BigInt(p.value);
  const from = addr(p.from);
  const to = addr(p.to);
  let kind = "transfer";
  if (from === ZERO_ADDR && !isBurn(to)) kind = "mint";
  else if (isBurn(to)) kind = "burn";

  const fresh = insertIgnore(db, "token_transfers", {
    tx: p.tx,
    log_index: p.logIndex,
    token: p.address,
    block: p.block,
    ts: p.ts,
    from_addr: from,
    to_addr: to,
    from_agent: agentOf(db, from),
    to_agent: agentOf(db, to),
    value: value.toString(10),
    kind,
  });
  if (!fresh) return false; // 重放：计数器一个都不动

  // 余额：from 减、to 加。零地址不建余额行（它是铸销的源与汇）；
  // 0x…dEaD 建余额行（它手里的币还算在 totalSupply 里），但不计入持有人数。
  if (from !== ZERO_ADDR) moveBalance(db, p.address, from, -value, p.ts);
  if (to !== ZERO_ADDR) moveBalance(db, p.address, to, value, p.ts);

  const cols = ["transfers = transfers + 1", "supply_stale = 1", "last_block = MAX(last_block, ?)", "last_ts = MAX(last_ts, ?)"];
  const args = [p.block, p.ts];
  if (kind === "mint") cols.push("mints = mints + 1");
  if (kind === "burn") {
    cols.push("burns = burns + 1");
    const cur = db.prepare("SELECT burned_amount FROM tokens WHERE address = ?").get(p.address);
    const next = (BigInt((cur && cur.burned_amount) || "0") + value).toString(10);
    db.prepare("UPDATE tokens SET burned_amount = ? WHERE address = ?").run(next, p.address);
  }
  db.prepare(`UPDATE tokens SET ${cols.join(", ")} WHERE address = ?`).run(...args, p.address);
  db.prepare("UPDATE tokens SET first_block = MIN(first_block, ?), first_ts = MIN(first_ts, ?) WHERE address = ?").run(
    p.block,
    p.ts,
    p.address
  );
  return true;
}

/** 余额的读-改-写。balance 是字符串（真相），balance_sort 是 REAL（只用于 ORDER BY，绝不展示）。 */
function moveBalance(db, token, holder, delta, ts) {
  const row = db.prepare("SELECT * FROM token_balances WHERE token = ? AND holder = ?").get(token, holder);
  const before = row ? BigInt(row.balance) : 0n;
  const after = before + delta;
  const inAdd = delta > 0n ? delta : 0n;
  const outAdd = delta < 0n ? -delta : 0n;
  if (!row) {
    db.prepare(
      `INSERT INTO token_balances (token, holder, balance, balance_sort, in_total, out_total, tx_count, agent_id, first_ts, last_ts)
       VALUES (?,?,?,?,?,?,1,?,?,?)`
    ).run(
      token,
      holder,
      after.toString(10),
      Number(after),
      inAdd.toString(10),
      outAdd.toString(10),
      agentOf(db, holder),
      Number(ts),
      Number(ts)
    );
  } else {
    db.prepare(
      `UPDATE token_balances SET balance = ?, balance_sort = ?, in_total = ?, out_total = ?,
         tx_count = tx_count + 1, last_ts = MAX(last_ts, ?) WHERE token = ? AND holder = ?`
    ).run(
      after.toString(10),
      Number(after),
      (BigInt(row.in_total) + inAdd).toString(10),
      (BigInt(row.out_total) + outAdd).toString(10),
      Number(ts),
      token,
      holder
    );
  }
  // holders：余额从 0 变非零 +1，从非零变 0 -1；两个销毁地址不计入。
  if (!isBurn(holder)) {
    if (before === 0n && after !== 0n) db.prepare("UPDATE tokens SET holders = holders + 1 WHERE address = ?").run(token);
    else if (before !== 0n && after === 0n) db.prepare("UPDATE tokens SET holders = holders - 1 WHERE address = ?").run(token);
  }
}

/** §7.3 的成交归一化。normalized = 0 的行照样入库、照样显示，只是四个字段是 NULL。 */
export function normalizeSwap(p, { decimals0 = null, decimals1 = null, token0, token1 } = {}) {
  let tokenIn = null;
  let amountIn = null;
  let tokenOut = null;
  let amountOut = null;
  let side = "unknown";
  let normalized = 0;
  let amt0;
  let amt1;

  if (p.kind === "v2") {
    const a0i = BigInt(p.amount0In);
    const a1i = BigInt(p.amount1In);
    const a0o = BigInt(p.amount0Out);
    const a1o = BigInt(p.amount1Out);
    amt0 = a0i > 0n ? a0i : a0o;
    amt1 = a1i > 0n ? a1i : a1o;
    const bothIn = a0i > 0n && a1i > 0n;
    const noneIn = a0i === 0n && a1i === 0n;
    if (!bothIn && !noneIn) {
      normalized = 1;
      if (a0i > 0n) {
        tokenIn = token0;
        amountIn = a0i;
        tokenOut = token1;
        amountOut = a1o;
        side = "sell0";
      } else {
        tokenIn = token1;
        amountIn = a1i;
        tokenOut = token0;
        amountOut = a0o;
        side = "buy0";
      }
    }
  } else {
    const a0 = BigInt(p.amount0);
    const a1 = BigInt(p.amount1);
    amt0 = a0 < 0n ? -a0 : a0;
    amt1 = a1 < 0n ? -a1 : a1;
    // 有符号，正 = 流入池子。符号必须成对（一正一负），否则形状不标准。
    if (a0 > 0n && a1 < 0n) {
      normalized = 1;
      tokenIn = token0;
      amountIn = a0;
      tokenOut = token1;
      amountOut = -a1;
      side = "sell0";
    } else if (a1 > 0n && a0 < 0n) {
      normalized = 1;
      tokenIn = token1;
      amountIn = a1;
      tokenOut = token0;
      amountOut = -a0;
      side = "buy0";
    }
  }

  return {
    tokenIn,
    amountIn: amountIn === null ? null : amountIn.toString(10),
    tokenOut,
    amountOut: amountOut === null ? null : amountOut.toString(10),
    side,
    normalized,
    amt0: amt0.toString(10),
    amt1: amt1.toString(10),
    price1Per0: price1Per0(amt0, amt1, decimals0, decimals1),
  };
}

/**
 * §7.3 的价格：定点整数，绝不用浮点。
 *   price_1_per_0 = amt1 * 10^(18 + dec0) / (amt0 * 10^dec1)    // 整数除法，含义是 ×10^-18
 * amt0 == 0，或 dec0 / dec1 任一未知 -> NULL。
 */
export function price1Per0(amt0, amt1, dec0, dec1) {
  const a0 = BigInt(amt0 ?? 0);
  const a1 = BigInt(amt1 ?? 0);
  if (a0 === 0n) return null;
  if (dec0 === null || dec0 === undefined || dec1 === null || dec1 === undefined) return null;
  const num = a1 * 10n ** BigInt(18 + Number(dec0));
  const den = a0 * 10n ** BigInt(Number(dec1));
  if (den === 0n) return null;
  return (num / den).toString(10);
}

function decimalsOf(db, address) {
  const r = db.prepare("SELECT decimals FROM tokens WHERE address = ?").get(address);
  return r && r.decimals !== null && r.decimals !== undefined ? Number(r.decimals) : null;
}

/** Swap -> swaps + pairs 的量能 + tokens 的 swap_count。 */
export function applySwap(db, p) {
  const pair = db.prepare("SELECT * FROM pairs WHERE address = ?").get(p.address);
  if (!pair) return false; // 还没被确认成交易对：这条 Swap 先不入库，等确认后的区块重放（或下一次成交）
  const norm0 = normalizeSwap(p, {
    decimals0: decimalsOf(db, pair.token0),
    decimals1: decimalsOf(db, pair.token1),
    token0: pair.token0,
    token1: pair.token1,
  });
  const { from, agentId } = txFromOf(db, p.tx);
  const fresh = insertIgnore(db, "swaps", {
    tx: p.tx,
    log_index: p.logIndex,
    pair: p.address,
    kind: p.kind,
    block: p.block,
    ts: p.ts,
    epoch: epochOf(p.ts),
    agent_id: agentId,
    tx_from: from || p.sender,
    sender: p.sender,
    recipient: p.recipient ?? null,
    token_in: norm0.tokenIn,
    amount_in: norm0.amountIn,
    token_out: norm0.tokenOut,
    amount_out: norm0.amountOut,
    side: norm0.side,
    amt0: norm0.amt0,
    amt1: norm0.amt1,
    price_1_per_0: norm0.price1Per0,
    normalized: norm0.normalized,
  });
  if (!fresh) return false;

  const vol0 = (BigInt(pair.vol0) + (norm0.normalized ? BigInt(norm0.amt0) : 0n)).toString(10);
  const vol1 = (BigInt(pair.vol1) + (norm0.normalized ? BigInt(norm0.amt1) : 0n)).toString(10);
  db.prepare(
    `UPDATE pairs SET swap_count = swap_count + 1, vol0 = ?, vol1 = ?,
       vol_skipped = vol_skipped + ?, last_block = MAX(last_block, ?), last_ts = MAX(last_ts, ?),
       last_price = COALESCE(?, last_price), last_price_block = CASE WHEN ? IS NULL THEN last_price_block ELSE ? END
     WHERE address = ?`
  ).run(vol0, vol1, norm0.normalized ? 0 : 1, p.block, p.ts, norm0.price1Per0, norm0.price1Per0, p.block, p.address);

  // 代币维度：两边都算「参与了一笔成交」。不做任何跨代币折算 —— 没有共同计价单位，折算就是编的。
  for (const t of [pair.token0, pair.token1]) {
    const row = db.prepare("SELECT swap_count, symbol FROM tokens WHERE address = ?").get(t);
    if (!row) continue;
    const firstTrade = Number(row.swap_count) === 0;
    db.prepare(
      "UPDATE tokens SET swap_count = swap_count + 1, last_block = MAX(last_block, ?), last_ts = MAX(last_ts, ?) WHERE address = ?"
    ).run(p.block, p.ts, t);
    if (firstTrade) {
      pushFeed(db, {
        uniq: feedUniq("first_trade", t),
        kind: "TOKEN_FIRST_TRADE",
        ts: p.ts,
        block: p.block,
        agentId,
        textZh: renderTokenFirstTrade({ agentId, symbol: row.symbol, address: t, pair: p.address }),
        tx: p.tx,
        epoch: epochOf(p.ts),
      });
    }
  }
  return true;
}

/** V2/V3 的 Mint & Burn -> liquidity_events。 */
export function applyLiquidity(db, p) {
  const pair = db.prepare("SELECT address FROM pairs WHERE address = ?").get(p.address);
  if (!pair) return false;
  const { from, agentId } = txFromOf(db, p.tx);
  const fresh = insertIgnore(db, "liquidity_events", {
    tx: p.tx,
    log_index: p.logIndex,
    pair: p.address,
    block: p.block,
    ts: p.ts,
    agent_id: agentId,
    tx_from: from || p.address,
    kind: p.op,
    amount0: BigInt(p.amount0).toString(10),
    amount1: BigInt(p.amount1).toString(10),
  });
  if (!fresh) return false;
  const col = p.op === "add" ? "mint_count" : "burn_count";
  db.prepare(
    `UPDATE pairs SET "${col}" = "${col}" + 1, last_block = MAX(last_block, ?), last_ts = MAX(last_ts, ?) WHERE address = ?`
  ).run(p.block, p.ts, p.address);
  return true;
}

/** Sync：V2 的储备更新。它没有幂等键（同一个池子一个块里可以有多条），按区块号只往前推。 */
export function applySync(db, p) {
  const r = db.prepare("SELECT reserve_block, kind FROM pairs WHERE address = ?").get(p.address);
  if (!r || r.kind !== "v2") return false;
  if (r.reserve_block !== null && Number(r.reserve_block) > p.block) return false;
  db.prepare(
    `UPDATE pairs SET reserve0 = ?, reserve1 = ?, reserve_source = 'getReserves', reserve_block = ?,
       last_block = MAX(last_block, ?), last_ts = MAX(last_ts, ?) WHERE address = ?`
  ).run(BigInt(p.reserve0).toString(10), BigInt(p.reserve1).toString(10), p.block, p.block, p.ts, p.address);
  return true;
}

/** X5：totalSupply 恒为 0 且 Transfer 全是 value == 0 -> zero_only。进表，但默认在列表里折叠。 */
export function refreshZeroOnly(db, address, now) {
  const t = db.prepare("SELECT total_supply, zero_only, last_block FROM tokens WHERE address = ?").get(address);
  if (!t) return;
  const nonZero = db
    .prepare("SELECT 1 AS x FROM token_transfers WHERE token = ? AND value != '0' LIMIT 1")
    .get(address);
  const next = BigInt(t.total_supply || "0") === 0n && !nonZero ? 1 : 0;
  if (next === Number(t.zero_only)) return;
  db.prepare("UPDATE tokens SET zero_only = ? WHERE address = ?").run(next, address);
  tokenEvent(db, {
    address,
    kind: next ? "DEMOTED" : "RELEVEL",
    rule: "X5",
    detail: next
      ? "totalSupply 恒为 0 且所有 Transfer 的 value 都是 0，按 X5 折叠（仍在表里）"
      : "出现了非零的 totalSupply 或非零的 Transfer，X5 的折叠解除",
    block: Number(t.last_block || 0),
    ts: Number(now),
  });
}

/** feed 写入（与 store.js 的 feedPush 同一套去重键机制，避免循环依赖所以在这里重写一遍）。 */
function pushFeed(db, { uniq, kind, ts, block, agentId, textZh, tx, epoch }) {
  const exists = db.prepare("SELECT feed_id FROM feed_key WHERE uniq = ?").get(uniq);
  if (exists) return Number(exists.feed_id);
  const anchored = db.prepare("SELECT state FROM epochs WHERE epoch = ?").get(Number(epoch));
  const info = db
    .prepare(
      "INSERT INTO feed (chain, kind, ts, block, agent_id, text_zh, tx, anchored, epoch) VALUES ('layer',?,?,?,?,?,?,?,?)"
    )
    .run(
      kind,
      Number(ts),
      Number(block),
      agentId === null || agentId === undefined ? null : Number(agentId),
      textZh,
      hash(tx),
      anchored && anchored.state === "FINAL" ? 1 : 0,
      Number(epoch)
    );
  const feedId = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO feed_key (uniq, feed_id) VALUES (?, ?)").run(uniq, feedId);
  return feedId;
}

// ---------------------------------------------------------------- 刷新作业

/**
 * §7.1.6 / §7.1.7 的刷新作业：把 supply_stale = 1 的代币重读一遍 totalSupply，
 * 并用 balanceOf 对**前 20 个持有者**对拍，对不上就置 balance_drift = 1。
 * 这一步是异步的，与摄入分开跑；离线测试直接调它，传一个桩 rpc。
 */
export async function refreshStaleTokens(db, { rpc, limit = 20, topN = 20, now = Math.floor(Date.now() / 1000) }) {
  const rows = db
    .prepare("SELECT address FROM tokens WHERE supply_stale = 1 AND is_nft = 0 AND is_multi_token = 0 ORDER BY last_block DESC LIMIT ?")
    .all(limit);
  let refreshed = 0;
  let drifted = 0;
  for (const r of rows) {
    const session = new ProbeSession(rpc, null, { maxCalls: 4 + topN });
    let supply = null;
    try {
      const ts = await session.call(r.address, "0x18160ddd");
      supply = ts.ok ? decodeUint256(ts.data) : null;
    } catch (e) {
      if (e instanceof ProbeUnavailable) continue;
      throw e;
    }
    const holders = db
      .prepare(
        "SELECT holder, balance FROM token_balances WHERE token = ? ORDER BY balance_sort DESC, holder ASC LIMIT ?"
      )
      .all(r.address, topN);
    let drift = 0;
    for (const h of holders) {
      let onchain = null;
      try {
        const b = await session.call(r.address, balanceOfData(h.holder));
        onchain = b.ok ? decodeUint256(b.data) : null;
      } catch (e) {
        if (e instanceof ProbeUnavailable) break;
        throw e;
      }
      if (onchain === null) continue;
      if (onchain.toString(10) !== String(h.balance)) {
        drift = 1;
        break;
      }
    }
    withTx(db, () => {
      if (supply !== null) {
        db.prepare("UPDATE tokens SET total_supply = ?, supply_stale = 0 WHERE address = ?").run(
          supply.toString(10),
          r.address
        );
      }
      db.prepare("UPDATE tokens SET balance_drift = ?, drift_checked_at = ? WHERE address = ?").run(drift, now, r.address);
      refreshZeroOnly(db, r.address, now);
    });
    refreshed += 1;
    if (drift) drifted += 1;
  }
  return { refreshed, drifted };
}

export { ZERO_ADDR, DEAD_ADDR, BURN_ADDRS };
