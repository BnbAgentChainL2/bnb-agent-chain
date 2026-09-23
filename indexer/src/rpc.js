// src/rpc.js —— 极小的 JSON-RPC 客户端（fetch + 退避重试）。
// 不用 ethers 的 Provider 来拉日志：我们需要自己控制分片、退避与游标，Provider 的重试策略是黑盒。
// ethers 只用来做 ABI 编解码与地址/哈希归一化。
import { warn } from "./warnings.js";

export class RpcError extends Error {
  constructor(code, message, method) {
    super(`${method} 失败：${code} ${message}`);
    this.code = code;
    this.rpcMessage = message;
    this.method = method;
  }
}

/** 公共 BSC RPC 对 eth_getLogs 限窗时返回的错误码（2026-09-22 实测）。 */
export const RATE_LIMIT_CODES = new Set([-32005, -32000, 429]);

/**
 * eth_call 被合约 revert 了（geth / Besu / publicnode 都用 code 3 带 revert 数据，也有节点只写在 message 里）。
 * 这是**确定性**的结果，不是网络抖动：重试 5 次只会让一次快照多等 15 秒。所以它不重试，直接抛给调用方。
 * 注意 -32000 也被上面当成限速码：只有 message 里明说 revert 的 -32000 才算 revert。
 */
export function isRevertError(e) {
  if (!(e instanceof RpcError)) return false;
  if (e.code === 3) return true;
  return /revert/i.test(String(e.rpcMessage || ""));
}

/**
 * 节点不给这一段历史：publicnode 对离链头约 7k–20k 块（1–2.5 小时）以外的 eth_getLogs 返回
 * -32602 "Archive requests require a personal token…"（2026-09-23 只读探测：链头 123540779 往回 3000 / 7000 块 OK，
 * 20000 块就是这个错）。它**不是限速**：缩小分片、等多久都拿不到，只能换一个能查历史的（带密钥的）日志 RPC。
 * 所以它不重试、不砍分片、不记限速，直接抛出去，并由 getLogsChunked 打 bsc_log_history_unavailable 告警。
 */
const HISTORY_UNAVAILABLE_RE = /archive requests?|personal token|history (has been )?pruned|historical (state|data) (is )?not available/i;
export function isHistoryUnavailableError(e) {
  if (!(e instanceof RpcError)) return false;
  if (e.code === 3) return false;
  return HISTORY_UNAVAILABLE_RE.test(String(e.rpcMessage || ""));
}

export class Rpc {
  constructor(url, { name = "rpc", timeoutMs = 20000, maxRetries = 5 } = {}) {
    this.url = url;
    this.name = name;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.id = 0;
    this.rateLimitHits = [];
  }

  /** 最近 24 小时被限速的次数（/api/health 的 rpc.rateLimited24h）。 */
  rateLimited24h(now = Date.now()) {
    const cut = now - 24 * 3600 * 1000;
    this.rateLimitHits = this.rateLimitHits.filter((t) => t >= cut);
    return this.rateLimitHits.length;
  }

  async call(method, params = []) {
    let attempt = 0;
    let lastErr = null;
    while (attempt <= this.maxRetries) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
          signal: ac.signal,
        });
        clearTimeout(timer);
        if (res.status === 429) {
          this.rateLimitHits.push(Date.now());
          warn("rpc_rate_limited", `${this.name} 对 ${method} 返回 429`);
          throw new RpcError(429, "too many requests", method);
        }
        if (!res.ok) throw new RpcError(res.status, `HTTP ${res.status}`, method);
        const body = await res.json();
        if (body.error) {
          const code = Number(body.error.code);
          const msg = String(body.error.message || "");
          if (RATE_LIMIT_CODES.has(code) && !/revert/i.test(msg) && !HISTORY_UNAVAILABLE_RE.test(msg)) {
            this.rateLimitHits.push(Date.now());
            warn("rpc_rate_limited", `${this.name} 对 ${method} 返回 ${code}：${body.error.message}`);
          }
          throw new RpcError(code, String(body.error.message || ""), method);
        }
        return body.result;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        // revert 是确定性结果，重试没有意义（见 isRevertError）。
        if (isRevertError(e)) throw e;
        // 节点不给历史也是确定性结果（见 isHistoryUnavailableError），重试只会白等。
        if (isHistoryUnavailableError(e)) throw e;
        // 限窗类错误交给调用方缩小分片，不在这里盲目重试。
        if (e instanceof RpcError && RATE_LIMIT_CODES.has(e.code)) throw e;
        attempt += 1;
        if (attempt > this.maxRetries) break;
        await sleep(Math.min(30000, 500 * 2 ** (attempt - 1)));
      }
    }
    throw lastErr;
  }

  blockNumber() {
    return this.call("eth_blockNumber").then((h) => Number(BigInt(h)));
  }

  getBlockByNumber(n, full = false) {
    return this.call("eth_getBlockByNumber", [toHex(n), full]);
  }

  getLogs(filter) {
    return this.call("eth_getLogs", [filter]);
  }

  getTransactionReceipt(h) {
    return this.call("eth_getTransactionReceipt", [h]);
  }

  getBalance(a, tag = "latest") {
    return this.call("eth_getBalance", [a, typeof tag === "number" ? toHex(tag) : tag]);
  }

  ethCall(to, data, tag = "latest") {
    return this.call("eth_call", [{ to, data }, typeof tag === "number" ? toHex(tag) : tag]);
  }

  getCode(a, tag = "latest") {
    return this.call("eth_getCode", [a, typeof tag === "number" ? toHex(tag) : tag]);
  }

  getStorageAt(a, slot, tag = "latest") {
    return this.call("eth_getStorageAt", [a, slot, typeof tag === "number" ? toHex(tag) : tag]);
  }

  netPeerCount() {
    return this.call("net_peerCount").then((h) => Number(BigInt(h)));
  }
}

/**
 * 放进 FailoverRpc 当主 RPC 时的预算：5 秒超时、只重试 1 次。
 * 用 Rpc 的默认值（20 秒 × 6 次 + 0.5+1+2+4+8 秒退避）时，主 RPC 慢一次就要约 135 秒才轮到第二个，
 * 而快照每 30 秒要串行打 60–90 个 eth_call —— 一个慢的主节点会把每一轮快照都拖住。
 */
export const FAILOVER_PRIMARY_OPTS = { timeoutMs: 5000, maxRetries: 1 };
/** 第二个（最后一个）RPC：它后面没有人兜底了，给多一点耐心，但也不用 135 秒。 */
export const FAILOVER_LAST_OPTS = { timeoutMs: 10000, maxRetries: 2 };

/**
 * 只读 view 的两路兜底：BSC_RPC 出了网络错误 / 被限速（不是 revert、也不是「不给历史」）就换 BSC_RPC_2，
 * 并**一直用第二个**，直到 retryPrimaryAfterMs（默认 10 分钟）过去再回头试主 RPC ——
 * 这个对象跨快照复用（snapshot.js 的 bscReadRpc），所以换过去之后每一轮都直接走好的那个，不会每轮先在坏的上等一遍。
 * **eth_getLogs 永远只走第一个**：bsc-dataseed 对 eth_getLogs 在任何跨度上都返回 -32005（2026-09-22 实测），
 * 不能当日志来源。revert 是确定性答案，不换节点再问一遍。
 */
export class FailoverRpc extends Rpc {
  constructor(rpcs, { name = "rpc", retryPrimaryAfterMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    const list = rpcs.filter(Boolean);
    super(list[0].url, { name });
    this.rpcs = list;
    this.active = 0;
    this.failovers = 0;
    this.failedOverAt = null;
    this.retryPrimaryAfterMs = retryPrimaryAfterMs;
    this.now = now;
  }

  rateLimited24h(now = Date.now()) {
    return this.rpcs.reduce((a, r) => a + (r.rateLimited24h ? r.rateLimited24h(now) : 0), 0);
  }

  async call(method, params = []) {
    if (method === "eth_getLogs") return this.rpcs[0].call(method, params);
    if (this.active !== 0 && this.failedOverAt !== null && this.now() - this.failedOverAt >= this.retryPrimaryAfterMs) {
      this.active = 0;
      this.failedOverAt = null;
    }
    let lastErr = null;
    for (let i = this.active; i < this.rpcs.length; i++) {
      try {
        const out = await this.rpcs[i].call(method, params);
        if (i !== this.active) {
          this.active = i;
          this.failovers += 1;
          this.failedOverAt = this.now();
        }
        return out;
      } catch (e) {
        if (isRevertError(e) || isHistoryUnavailableError(e)) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }
}

export function toHex(n) {
  return "0x" + BigInt(n).toString(16);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 分片拉日志：从 from 到 to，按 range 切片；遇到限窗错误就把 range 砍半重试，
 * 连续成功若干片之后再缓慢放大（但不超过 maxRange）。
 * onChunk(logs, chunkFrom, chunkTo) 每片调用一次 —— **调用方必须在这里推进游标并落盘**，
 * 这样一次失败只会重做最后一片，不会从头再来（可恢复游标）。
 */
export async function getLogsChunked(rpc, { address, topics, from, to, range, minRange = 100, maxRange = 5000, onChunk }) {
  let cur = from;
  let size = Math.max(minRange, Math.min(range, maxRange));
  let okStreak = 0;
  while (cur <= to) {
    const end = Math.min(to, cur + size - 1);
    let logs;
    try {
      logs = await rpc.getLogs({
        fromBlock: toHex(cur),
        toBlock: toHex(end),
        ...(address ? { address } : {}),
        ...(topics ? { topics } : {}),
      });
    } catch (e) {
      if (isHistoryUnavailableError(e)) {
        // 不许当成限速去砍分片 / 等 30 秒：那样会永远卡在同一段上，只留下一条笼统的 bsc_ingest_failed。
        warn(
          "bsc_log_history_unavailable",
          `${rpc.name} 不提供 ${cur}–${end} 这一段的日志（${e.code} ${e.rpcMessage}）。` +
            "公共节点只给最近约 1–2.5 小时的 eth_getLogs：回填与停机后追赶必须用能查历史的、带密钥的日志 RPC（BSC_RPC），" +
            "并把 BAC_BSC_START_BLOCK 设在部署交易所在块附近。游标停在这里，不跳过任何区块。"
        );
        throw e;
      }
      if (e instanceof RpcError && RATE_LIMIT_CODES.has(e.code) && size > minRange) {
        size = Math.max(minRange, Math.floor(size / 2));
        okStreak = 0;
        await sleep(1000);
        continue;
      }
      if (e instanceof RpcError && RATE_LIMIT_CODES.has(e.code)) {
        // 已经缩到最小片还被限速：退避等待，不放弃、也不跳过区块。
        warn("rpc_rate_limited", `${rpc.name} 在最小分片 ${minRange} 上仍被限速，等待 30 秒`);
        await sleep(30000);
        continue;
      }
      throw e;
    }
    await onChunk(logs, cur, end);
    cur = end + 1;
    okStreak += 1;
    if (okStreak >= 5 && size < maxRange) {
      size = Math.min(maxRange, Math.floor(size * 1.5));
      okStreak = 0;
    }
  }
  return { lastRange: size };
}
