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
          if (RATE_LIMIT_CODES.has(code)) {
            this.rateLimitHits.push(Date.now());
            warn("rpc_rate_limited", `${this.name} 对 ${method} 返回 ${code}：${body.error.message}`);
          }
          throw new RpcError(code, String(body.error.message || ""), method);
        }
        return body.result;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
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

  netPeerCount() {
    return this.call("net_peerCount").then((h) => Number(BigInt(h)));
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
