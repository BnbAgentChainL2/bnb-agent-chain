// src/decode.js —— 把一条原始日志解成 03 §4 的规范事件。
// 输出的 args 里：金额一律十进制字符串 wei，地址一律 EIP-55，哈希一律小写 0x。
import { getAddress } from "ethers";
import { TOPIC0, IFACES, CONTRACT_CHAIN, HASH_KIND, STATUS_NAME } from "./abi.js";

/** 纪元号：epoch = floor(timestamp / 86400)。BSC 与层内同一个定义（03 开头的约定）。 */
export function epochOf(ts) {
  return Math.floor(Number(ts) / 86400);
}

/** 地址归一到 EIP-55；非地址原样返回。 */
export function addr(a) {
  try {
    return getAddress(String(a));
  } catch {
    return String(a);
  }
}

/** 哈希归一到小写 0x。 */
export function hash(h) {
  return String(h ?? "").toLowerCase();
}

/**
 * 把 ethers 解出来的值变成可 JSON 化的形状。
 * bigint -> 十进制字符串（03 的约定：金额永远是字符串，不是 number）；
 * uint8/16/32/64 这些计数类留成 number（区块号、纪元、bps、轮次）。
 */
function jsonable(v, type) {
  if (typeof v === "bigint") {
    if (type && /^uint(8|16|32|64)$/.test(type)) return Number(v);
    return v.toString(10);
  }
  if (Array.isArray(v)) return v.map((x) => jsonable(x));
  if (type === "address") return addr(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v)) return v.toLowerCase();
  return v;
}

/**
 * 解一条日志。
 * log: { address, topics[], data, blockNumber, transactionHash, logIndex }
 * opts.chain: 'bsc' | 'layer'
 * opts.addressBook: { "0x小写地址": "合约名" }，用于同签名事件消歧
 *   （BacBridge.ReleaseReceived 与 BacNodeFund.ReleaseReceived 的 topic0 相同，只能靠地址分）
 * 返回 { contract, event, args, agentId, epoch } 或 null（不认识的日志）。
 */
export function decodeLog(log, opts = {}) {
  const chain = opts.chain || null;
  const book = opts.addressBook || {};
  const topics = (log.topics || []).map(hash);
  if (topics.length === 0) return null;
  const candidates = TOPIC0.get(topics[0]);
  if (!candidates || candidates.length === 0) return null;

  const named = book[hash(log.address)] || null;
  let pick = null;
  if (named) {
    pick = candidates.find((c) => c.contract === named) || null;
    // 地址已知但它不发这个事件：宁可不解，也不要贴一个错的合约名。
    if (!pick) return null;
  }
  if (!pick && chain) pick = candidates.find((c) => CONTRACT_CHAIN[c.contract] === chain) || null;
  if (!pick) pick = candidates[0];

  const frag = pick.fragment;
  let parsed;
  try {
    parsed = IFACES[pick.contract].decodeEventLog(frag, log.data ?? "0x", topics);
  } catch {
    return null;
  }

  const args = {};
  frag.inputs.forEach((inp, i) => {
    args[inp.name] = jsonable(parsed[i], inp.type);
  });

  const out = { contract: pick.contract, event: pick.name, args, agentId: null, epoch: null };

  if (args.agentId !== undefined && args.agentId !== null) {
    const n = Number(args.agentId);
    out.agentId = Number.isFinite(n) ? n : null;
  }
  if (args.epoch !== undefined && args.epoch !== null) out.epoch = Number(args.epoch);
  if (out.epoch === null && args.anchorEpoch !== undefined) out.epoch = Number(args.anchorEpoch);

  // AgentBook.Action：把 kind 从 hash 还原成明文（§4.2）。
  // 认不出来的 hash 落 NOTE，并把原 hash 留在 kindHash 里 —— 不许静默丢掉一个 agent 的动作。
  if (pick.contract === "AgentBook" && pick.name === "Action") {
    out.args.kindHash = hash(args.kind);
    out.args.kind = HASH_KIND[out.args.kindHash] || "NOTE";
  }
  // 带 status 的事件附一个可读名字（L2Gate.AgentSynced）。
  if (args.status !== undefined && STATUS_NAME[Number(args.status)] !== undefined) {
    out.args.statusName = STATUS_NAME[Number(args.status)];
  }
  return out;
}

/** 一批日志解码，认不出来的丢掉（但调用方应该把原始日志照样落 logs 表）。 */
export function decodeLogs(logs, opts = {}) {
  const out = [];
  for (const l of logs) {
    const d = decodeLog(l, opts);
    if (d) out.push({ ...d, log: l });
  }
  return out;
}
