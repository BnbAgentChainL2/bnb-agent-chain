// src/economy/parse.js —— 把一条层内原始日志按 topic0 解成决策 #19 关心的形状。
//
// **一律按 topic0 分派，绝不按事件名分派**（§7.2.1 的同名陷阱）：
// Swap / Mint / Burn 在 V2 和 V3 里参数不同，topic0 也不同；V2 的 Mint 与 ERC-20 的铸造毫无关系。
import { Interface } from "ethers";
import { TOPIC } from "./constants.js";
import { addr, hash } from "../decode.js";

/** 三族 ABI 分开放三个 Interface：同名不同签名的事件放一个 Interface 里容易取错 fragment。 */
export const ERC20_IFACE = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const V2_IFACE = new Interface([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
]);

export const V3_IFACE = new Interface([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Initialize(uint160 sqrtPriceX96, int24 tick)",
]);

function dec(iface, name, log, topics) {
  try {
    return iface.decodeEventLog(iface.getEvent(name), log.data ?? "0x", topics);
  } catch {
    return null;
  }
}

/**
 * 解一条日志。返回 null 表示这条日志与决策 #19 无关。
 * 返回值统一带 { type, address, block, ts, tx, logIndex }。
 */
export function parseBuiltLog(log, ts) {
  const topics = (log.topics || []).map(hash);
  if (topics.length === 0) return null;
  const t0 = topics[0];
  const base = {
    address: addr(log.address),
    block: Number(log.blockNumber),
    ts: Number(ts),
    tx: hash(log.transactionHash),
    logIndex: Number(log.logIndex),
  };

  if (t0 === TOPIC.Transfer) {
    // N2：3 个 topic + 正好 32 字节 data 才是 ERC-20 的形状；
    // 4 个 topic（tokenId 是 indexed）是 ERC-721，X2 直接把这个地址挡在代币表外面。
    const dataLen = String(log.data || "0x").length <= 2 ? 0 : (String(log.data).length - 2) / 2;
    if (topics.length === 4 && dataLen === 0) return { ...base, type: "transfer_nft" };
    if (topics.length !== 3 || dataLen !== 32) return { ...base, type: "transfer_odd" };
    const d = dec(ERC20_IFACE, "Transfer", log, topics);
    if (!d) return { ...base, type: "transfer_odd" };
    return { ...base, type: "transfer", from: addr(d[0]), to: addr(d[1]), value: d[2] };
  }
  if (t0 === TOPIC.TransferSingle || t0 === TOPIC.TransferBatch) {
    return { ...base, type: "erc1155" };
  }

  if (t0 === TOPIC.PairCreated) {
    const d = dec(V2_IFACE, "PairCreated", log, topics);
    if (!d) return null;
    return { ...base, type: "pair_created", kind: "v2", token0: addr(d[0]), token1: addr(d[1]), pair: addr(d[2]) };
  }
  if (t0 === TOPIC.PoolCreated) {
    const d = dec(V3_IFACE, "PoolCreated", log, topics);
    if (!d) return null;
    return {
      ...base,
      type: "pair_created",
      kind: "v3",
      token0: addr(d[0]),
      token1: addr(d[1]),
      feePpm: Number(d[2]),
      tickSpacing: Number(d[3]),
      pair: addr(d[4]),
    };
  }

  if (t0 === TOPIC.Sync) {
    const d = dec(V2_IFACE, "Sync", log, topics);
    if (!d) return null;
    return { ...base, type: "sync", kind: "v2", reserve0: d[0], reserve1: d[1] };
  }
  if (t0 === TOPIC.InitializeV3) {
    const d = dec(V3_IFACE, "Initialize", log, topics);
    if (!d) return null;
    return { ...base, type: "init", kind: "v3" };
  }

  if (t0 === TOPIC.SwapV2) {
    const d = dec(V2_IFACE, "Swap", log, topics);
    if (!d) return null;
    return {
      ...base,
      type: "swap",
      kind: "v2",
      sender: addr(d[0]),
      amount0In: d[1],
      amount1In: d[2],
      amount0Out: d[3],
      amount1Out: d[4],
      recipient: addr(d[5]),
    };
  }
  if (t0 === TOPIC.SwapV3) {
    const d = dec(V3_IFACE, "Swap", log, topics);
    if (!d) return null;
    return {
      ...base,
      type: "swap",
      kind: "v3",
      sender: addr(d[0]),
      recipient: addr(d[1]),
      amount0: d[2],
      amount1: d[3],
    };
  }

  if (t0 === TOPIC.MintV2) {
    const d = dec(V2_IFACE, "Mint", log, topics);
    if (!d) return null;
    return { ...base, type: "liquidity", kind: "v2", op: "add", amount0: d[1], amount1: d[2] };
  }
  if (t0 === TOPIC.BurnV2) {
    const d = dec(V2_IFACE, "Burn", log, topics);
    if (!d) return null;
    return { ...base, type: "liquidity", kind: "v2", op: "remove", amount0: d[1], amount1: d[2] };
  }
  if (t0 === TOPIC.MintV3) {
    const d = dec(V3_IFACE, "Mint", log, topics);
    if (!d) return null;
    return { ...base, type: "liquidity", kind: "v3", op: "add", amount0: d[5], amount1: d[6] };
  }
  if (t0 === TOPIC.BurnV3) {
    const d = dec(V3_IFACE, "Burn", log, topics);
    if (!d) return null;
    return { ...base, type: "liquidity", kind: "v3", op: "remove", amount0: d[4], amount1: d[5] };
  }

  return null;
}

/** 一批日志解析，按顺序返回认识的那些。 */
export function parseBuiltLogs(logs, tsOf) {
  const out = [];
  for (const l of logs) {
    const p = parseBuiltLog(l, tsOf(Number(l.blockNumber)));
    if (p) out.push(p);
  }
  return out;
}
