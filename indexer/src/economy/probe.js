// src/economy/probe.js —— 探测用的 eth_call 封装（03 §7.1.6）。
//
// 两条硬约束：
//  1. **「探测失败」与「不是代币」是两件事**（§7.5.1 第 8 条）。探测失败（网络断、超时、被限速）
//     只能让这个地址留在 pending 里等下一轮，绝不许写成 not_token —— 混为一谈会永久漏掉真代币。
//     本文件用 ProbeUnavailable 这个专门的异常把两者分开。
//  2. Besu 的 path 状态方案只保留 128 个状态（≈ 6.4 分钟）。第一次探测在检测到的那个高度上做，
//     读不到状态就**立刻降级到 latest 重试一次**，并把实际成功的高度记进 contract_probes.probe_block。
import { RpcError, RATE_LIMIT_CODES, toHex } from "../rpc.js";

/** 探测暂时做不了（不是「不是代币」）。调用方必须让这个地址留在 pending。 */
export class ProbeUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeUnavailable";
  }
}

/** 状态窗口过期的错误特征。命中就降级到 latest 重试，而不是当成「这个函数不存在」。 */
const STATE_WINDOW_HINTS = [
  "missing trie node",
  "header not found",
  "block not found",
  "unknown block",
  "historical",
  "state is not available",
  "pruned",
];

function looksLikeStateWindow(e) {
  const m = String((e && (e.rpcMessage || e.message)) || "").toLowerCase();
  return STATE_WINDOW_HINTS.some((h) => m.includes(h));
}

/** 传输层失败（不是 revert）：非 RpcError，或被限速。这类必须让调用方留在 pending。 */
function looksLikeTransport(e) {
  if (!(e instanceof RpcError)) return true;
  return RATE_LIMIT_CODES.has(Number(e.code));
}

/**
 * 一个地址的一次探测会话。
 * rpc 需要实现 call(method, params)；wantBlock 是希望探测的高度（null = 直接用 latest）。
 *
 * 调用预算：每个会话自带计数，**每个合约的 eth_call 次数是有上限的**（§7.1 的「便宜」要求）。
 * 超出预算之后的可选探测直接跳过，不会无限打 RPC。
 */
export class ProbeSession {
  constructor(rpc, wantBlock = null, { maxCalls = 16 } = {}) {
    this.rpc = rpc;
    this.wantBlock = wantBlock === null || wantBlock === undefined ? null : Number(wantBlock);
    this.maxCalls = maxCalls;
    this.calls = 0;
    this.usedBlock = null; // 实际成功的高度；null 表示用的是 latest
    this.degraded = false; // 是否因为状态窗口降级到了 latest
    this.cache = new Map();
    this.alive = false; // eth_getCode 成功过一次之后，后续 eth_call 失败才允许解释成 revert
  }

  get budgetLeft() {
    return this.maxCalls - this.calls;
  }

  #tag(useLatest) {
    return useLatest || this.wantBlock === null ? "latest" : toHex(this.wantBlock);
  }

  async #attempt(method, mkParams) {
    // 先在希望的高度上试；状态读不到就降级到 latest 再试一次（只降级一次）。
    const first = this.wantBlock === null;
    try {
      const out = await this.rpc.call(method, mkParams(this.#tag(first)));
      if (!first) this.usedBlock = this.wantBlock;
      return { ok: true, data: out };
    } catch (e) {
      if (!first && (looksLikeStateWindow(e) || looksLikeTransport(e))) {
        try {
          const out = await this.rpc.call(method, mkParams("latest"));
          this.degraded = true;
          this.usedBlock = null;
          return { ok: true, data: out };
        } catch (e2) {
          if (looksLikeTransport(e2)) throw new ProbeUnavailable(String(e2.message || e2));
          return { ok: false, error: e2 };
        }
      }
      if (looksLikeTransport(e)) throw new ProbeUnavailable(String(e.message || e));
      return { ok: false, error: e };
    }
  }

  /** eth_getCode。它是本次会话的「连通性探针」：它失败就是传输层失败，不是「没有代码」。 */
  async code(address) {
    const k = `code:${String(address).toLowerCase()}`;
    if (this.cache.has(k)) return this.cache.get(k);
    this.calls += 1;
    let out;
    try {
      const r = await this.#attempt("eth_getCode", (tag) => [address, tag]);
      out = r.ok ? String(r.data || "0x") : "0x";
    } catch (e) {
      throw e instanceof ProbeUnavailable ? e : new ProbeUnavailable(String(e.message || e));
    }
    this.alive = true;
    this.cache.set(k, out);
    return out;
  }

  /** eth_call。返回 { ok, data }；ok=false 表示这个函数不存在或 revert 了 —— 这是有效结论，不是失败。 */
  async call(address, data) {
    const k = `call:${String(address).toLowerCase()}:${data}`;
    if (this.cache.has(k)) return this.cache.get(k);
    if (this.budgetLeft <= 0) {
      const out = { ok: false, data: "0x", skipped: true };
      this.cache.set(k, out);
      return out;
    }
    this.calls += 1;
    const r = await this.#attempt("eth_call", (tag) => [{ to: address, data }, tag]);
    const out = r.ok ? { ok: true, data: String(r.data ?? "0x") } : { ok: false, data: "0x" };
    this.cache.set(k, out);
    return out;
  }
}

/** 返回数据的字节数（"0x" 是 0）。 */
export function byteLen(hex) {
  const s = String(hex || "0x");
  return s.length <= 2 ? 0 : (s.length - 2) / 2;
}

/** 有代码（N1）。 */
export function hasCode(codeHex) {
  return byteLen(codeHex) > 0;
}

export { looksLikeStateWindow, looksLikeTransport };
