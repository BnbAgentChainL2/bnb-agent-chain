// src/api/rpcguard.js —— POST /rpc 的方法白名单（02-CHAIN-SPEC §5.3）。
// Caddy 解不了 JSON-RPC 的 body，所以这一关必须在本进程做。
// 非白名单一律 -32601；eth_getLogs 的两条硬限制在这里第一道，Besu 的 --rpc-max-logs-range 是第二道。
import { Rpc } from "../rpc.js";

export const RPC_WHITELIST = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getLogs",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionCount",
  "eth_sendRawTransaction",
  "net_version",
  "web3_clientVersion",
  // 任何人都要能独立核对当届验证者集，这是 02 §4.1 对账公式可复算的前提。
  "qbft_getValidatorsByBlockNumber",
  "qbft_getValidatorsByBlockHash",
]);

/** eth_getLogs 的跨度上限（02 §5.3 第 1 条）。 */
export const GET_LOGS_MAX_RANGE = 5000;

const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** 检查一条 JSON-RPC 请求。通过返回 null，否则返回错误响应体。 */
export function checkCall(call) {
  const id = call && call.id !== undefined ? call.id : null;
  if (!call || typeof call.method !== "string") return rpcErr(id, -32600, "请求无效");
  if (!RPC_WHITELIST.has(call.method)) return rpcErr(id, -32601, `方法不在白名单里：${call.method}`);

  if (call.method === "eth_getLogs") {
    const f = (call.params && call.params[0]) || {};
    const hasFilter = !!(f.address || (f.topics && f.topics.length));
    if (!hasFilter) return rpcErr(id, -32602, "eth_getLogs 必须带 address 或 topics");
    const from = f.fromBlock;
    const to = f.toBlock;
    if (typeof from === "string" && typeof to === "string" && from.startsWith("0x") && to.startsWith("0x")) {
      const span = BigInt(to) - BigInt(from);
      if (span > BigInt(GET_LOGS_MAX_RANGE)) {
        return rpcErr(id, -32602, `eth_getLogs 的跨度不能超过 ${GET_LOGS_MAX_RANGE} 个区块`);
      }
    } else if (from === "earliest" || (!from && !to)) {
      return rpcErr(id, -32602, `eth_getLogs 必须给出 ${GET_LOGS_MAX_RANGE} 个区块以内的 fromBlock/toBlock`);
    }
  }
  return null;
}

/**
 * 处理 POST /rpc 的 body。upstream 可注入（测试里用假的，不碰网络）。
 * 批量请求里只要有一条不合规，就只回那一条的错误 —— 不把整批放过去。
 */
export async function rpcGuard(ctx, rawBody, upstream = null) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody || "");
  } catch {
    return { status: 400, body: rpcErr(null, -32700, "JSON 解析失败") };
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  for (const c of calls) {
    const bad = checkCall(c);
    if (bad) return { status: 200, body: bad };
  }
  const up = upstream || ctx.upstream || new Rpc(ctx.cfg.layerRpc, { name: "layer-proxy" });
  try {
    const results = [];
    for (const c of calls) {
      const r = await up.call(c.method, c.params || []);
      results.push({ jsonrpc: "2.0", id: c.id ?? null, result: r });
    }
    return { status: 200, body: Array.isArray(parsed) ? results : results[0] };
  } catch (e) {
    const code = e && Number.isFinite(e.code) ? e.code : -32603;
    return { status: 200, body: rpcErr(calls[0] && calls[0].id, code, String(e && e.rpcMessage ? e.rpcMessage : "上游错误")) };
  }
}
