// test/built-helpers.js —— 决策 #19 的测试夹具。
// 日志全部用真实 ABI 编码生成（复用 src/economy/parse.js 里的 Interface），
// eth_call 的应答也全部按真实返回值布局手工编码 —— 手写十六进制夹具只能证明它自己。
// 全程离线：没有网络、没有服务器、没有任何密钥。
import { getAddress } from "ethers";
import { ERC20_IFACE, V2_IFACE, V3_IFACE } from "../src/economy/parse.js";
import { SELECTOR } from "../src/economy/constants.js";
import { RpcError } from "../src/rpc.js";
import { ingestLogs, ingestLayerBlock } from "../src/store.js";
import { processBuiltLogs } from "../src/economy/index.js";
import { TEST_CFG, TEST_BOOK, tempDb, mkLock } from "./helpers.js";
import { resetWarnings } from "../src/warnings.js";

export const T = 1790000000;

const IFACES = { erc20: ERC20_IFACE, v2: V2_IFACE, v3: V3_IFACE };

/** 造一条日志。family: 'erc20' | 'v2' | 'v3'。 */
export function mkBuiltLog(family, event, argsObj, { address, blockNumber, logIndex = 0, txHash }) {
  const iface = IFACES[family];
  const frag = iface.getEvent(event);
  const values = frag.inputs.map((inp) => {
    if (!(inp.name in argsObj)) throw new Error(`夹具缺少参数 ${family}.${event}.${inp.name}`);
    return argsObj[inp.name];
  });
  const { data, topics } = iface.encodeEventLog(frag, values);
  return { address, topics, data, blockNumber, transactionHash: txHash, logIndex };
}

/** 一条自己拼出来的原始日志（用来造「形状不对」的夹具：4 个 topic 的 Transfer 之类）。 */
export function mkRawLog({ address, topics, data = "0x", blockNumber, logIndex = 0, txHash }) {
  return { address, topics, data, blockNumber, transactionHash: txHash, logIndex };
}

// ---------------------------------------------------------------- 返回值编码

export function u256(v) {
  return "0x" + BigInt(v).toString(16).padStart(64, "0");
}
export function i256(v) {
  return "0x" + BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
}
export function addr32(a) {
  return "0x" + String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");
}
/** 标准 ABI 的 string 返回值：offset(0x20) + length + 右填充的内容。 */
export function abiStr(s) {
  const b = Buffer.from(String(s), "utf8");
  const chunks = Math.ceil(b.length / 32) || 1;
  const body = Buffer.alloc(chunks * 32);
  b.copy(body);
  return "0x" + "20".padStart(64, "0") + BigInt(b.length).toString(16).padStart(64, "0") + body.toString("hex");
}
/** 老代币的 bytes32 形状（右侧补零）。 */
export function bytes32Str(s) {
  const b = Buffer.alloc(32);
  Buffer.from(String(s), "utf8").copy(b);
  return "0x" + b.toString("hex");
}
/** getReserves() 的 96 字节返回：uint112, uint112, uint32。 */
export function res96(r0, r1, ts = 1790000000) {
  return u256(r0) + u256(r1).slice(2) + u256(ts).slice(2);
}

export function balanceOfCall(holder) {
  return SELECTOR.balanceOf + String(holder).replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

// ---------------------------------------------------------------- 合约桩

/** 一个规规矩矩的 ERC-20。stringAs: 'abi'（默认）或 'bytes32'。 */
export function erc20Stub({ name, symbol, decimals, totalSupply, balances = {}, stringAs = "abi" }) {
  const enc = stringAs === "bytes32" ? bytes32Str : abiStr;
  const calls = {};
  if (name !== undefined && name !== null) calls[SELECTOR.name] = enc(name);
  if (symbol !== undefined && symbol !== null) calls[SELECTOR.symbol] = enc(symbol);
  if (decimals !== undefined && decimals !== null) calls[SELECTOR.decimals] = u256(decimals);
  calls[SELECTOR.totalSupply] = u256(totalSupply ?? 0);
  for (const [who, v] of Object.entries(balances)) calls[balanceOfCall(who)] = u256(v);
  // balanceOf 的默认应答（address(0) 的探测走这里）
  calls[SELECTOR.balanceOf] = u256(0);
  return { code: "0x6080604052", calls };
}

/** Uniswap V2 形状的池子。 */
export function v2PairStub({ token0, token1, reserve0, reserve1, factory = null }) {
  const calls = {
    [SELECTOR.token0]: addr32(token0),
    [SELECTOR.token1]: addr32(token1),
    [SELECTOR.getReserves]: res96(reserve0, reserve1),
  };
  if (factory) calls[SELECTOR.factory] = addr32(factory);
  return { code: "0x6080604052", calls };
}

/** Uniswap V3 形状的池子。储备靠两边代币的 balanceOf(pool) 读，这里不放 getReserves。 */
export function v3PoolStub({ token0, token1, feePpm, tickSpacing = 60, factory = null }) {
  const calls = {
    [SELECTOR.token0]: addr32(token0),
    [SELECTOR.token1]: addr32(token1),
    [SELECTOR.fee]: u256(feePpm),
    [SELECTOR.slot0]: u256(0) + u256(0).slice(2),
    [SELECTOR.tickSpacing]: u256(tickSpacing),
  };
  if (factory) calls[SELECTOR.factory] = addr32(factory);
  return { code: "0x6080604052", calls };
}

// ---------------------------------------------------------------- 假 RPC

/**
 * 离线的 eth_call / eth_getCode 桩。
 * state: { "0x地址": { code, calls: { "0x<calldata 或 4 字节选择器>": "0x返回值" } } }
 * 没有登记的 calldata 一律按「revert」处理 —— 这是「这个函数不存在」的有效结论，不是传输失败。
 * fail: 一组地址，对它们的一切请求都抛网络级异常（用来测「探测失败 ≠ 不是代币」）。
 */
export class FakeRpc {
  constructor(state = {}, { fail = [] } = {}) {
    this.state = {};
    for (const [k, v] of Object.entries(state)) this.state[k.toLowerCase()] = v;
    this.fail = new Set(fail.map((a) => a.toLowerCase()));
    this.calls = []; // { method, to }
  }

  set(address, stub) {
    this.state[String(address).toLowerCase()] = stub;
  }

  /** 某个地址一共被打了多少次 RPC（用来断言「探测必须便宜」）。 */
  countFor(address) {
    const a = String(address).toLowerCase();
    return this.calls.filter((c) => c.to === a).length;
  }

  async call(method, params) {
    if (method === "eth_getCode") {
      const to = String(params[0]).toLowerCase();
      this.calls.push({ method, to });
      if (this.fail.has(to)) throw new TypeError("fetch failed");
      const st = this.state[to];
      return st ? st.code : "0x";
    }
    if (method === "eth_call") {
      const to = String(params[0].to).toLowerCase();
      const data = String(params[0].data);
      this.calls.push({ method, to, data });
      if (this.fail.has(to)) throw new TypeError("fetch failed");
      const st = this.state[to];
      if (!st) throw new RpcError(3, "execution reverted", "eth_call");
      const hit = st.calls[data] ?? st.calls[data.slice(0, 10)];
      if (hit === undefined) throw new RpcError(3, "execution reverted", "eth_call");
      return hit;
    }
    throw new RpcError(-32601, `方法不支持：${method}`, method);
  }
}

// ---------------------------------------------------------------- 场景摄入

let hashSeq = 0x1000;
export function txHash(tag) {
  if (tag) return "0x" + Buffer.from(String(tag)).toString("hex").padEnd(64, "0").slice(0, 64);
  hashSeq += 1;
  return "0x" + hashSeq.toString(16).padStart(64, "0");
}

/**
 * 摄入一个层内区块：区块 + 交易 + 收据先落库（ingestLayerBlock），
 * 再落原始日志（ingestLogs），最后跑决策 #19 的解码（processBuiltLogs）。
 * 顺序与 src/ingest.js 的 layerTick 完全一致 —— 测试跑的就是生产路径。
 */
export async function ingestBlock(db, rpc, { number, ts, txs = [], logs = [] }) {
  const block = {
    number,
    hash: "0x" + String(number).padStart(64, "b"),
    parentHash: "0x" + String(number - 1).padStart(64, "a"),
    timestamp: ts,
    gasUsed: 21000 * txs.length,
    gasLimit: 20000000,
    baseFeePerGas: 0n,
    transactions: txs.map((t, i) => ({
      hash: t.hash,
      from: t.from,
      to: t.to ?? null,
      value: t.value ?? 0n,
      gasPrice: 1000000000n,
      transactionIndex: i,
    })),
  };
  const receipts = txs.map((t) => ({
    gasUsed: t.gasUsed ?? 21000,
    effectiveGasPrice: 1000000000n,
    contractAddress: t.created ?? null,
    status: 1,
    codeSize: t.codeSize ?? 1024,
  }));
  ingestLayerBlock(db, { block, receipts, cfg: TEST_CFG });
  if (logs.length) {
    ingestLogs(db, { chain: "layer", logs, cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => ts });
  }
  return processBuiltLogs(db, { logs, rpc, tsOf: () => ts, now: ts });
}

export const e18 = (n) => BigInt(n) * 10n ** 18n;
export const e6 = (n) => BigInt(n) * 10n ** 6n;

export const A = {
  tokenA: getAddress("0x00000000000000000000000000000000000000a1"),
  tokenB: getAddress("0x00000000000000000000000000000000000000b2"),
  factory: getAddress("0x00000000000000000000000000000000000000f0"),
  pair: getAddress("0x00000000000000000000000000000000000000e5"),
  plain: getAddress("0x00000000000000000000000000000000000000c7"),
  nft: getAddress("0x00000000000000000000000000000000000000d8"),
  w17: getAddress("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"),
  w21: getAddress("0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"),
  w30: getAddress("0xcccccccccccccccccccccccccccccccccccccccc"),
  zero: getAddress("0x0000000000000000000000000000000000000000"),
  dead: getAddress("0x000000000000000000000000000000000000dEaD"),
};

// ---------------------------------------------------------------- 完整剧本

/**
 * 让三个 agent 进桥（决策 #31：钱包 -> agentId 的映射来自 BacBridge.Locked 的 layerWallet）。
 * 每个 agent 用它自己的钱包以自己的 ERC-8004 身份锁 1 BAC。
 */
function seedAgents(db) {
  const reg = (agentId, wallet, block) =>
    mkLock({ depositId: agentId, agentId, from: wallet, amount: 10n ** 18n, blockNumber: block });
  ingestLogs(db, {
    chain: "bsc",
    logs: [...reg(17, A.w17, 10), ...reg(21, A.w21, 11), ...reg(30, A.w30, 12)],
    cfg: TEST_CFG,
    addressBook: TEST_BOOK,
    tsOf: () => T,
  });
}

function stubs() {
  const rpc = new FakeRpc();
  rpc.set(A.tokenA, erc20Stub({ name: "Agent Fuel", symbol: "FUEL", decimals: 18, totalSupply: e18(1000000) }));
  // 第二个币故意用 bytes32 形状的 name/symbol：老代币就是这么写的，我们必须也认。
  rpc.set(A.tokenB, erc20Stub({ name: "BAC X", symbol: "BACX", decimals: 6, totalSupply: e6(500000), stringAs: "bytes32" }));
  rpc.set(A.pair, v2PairStub({ token0: A.tokenA, token1: A.tokenB, reserve0: 0, reserve1: 0, factory: A.factory }));
  // 一个「被调用过、但我们的规则认不出来」的合约：有代码、发过形状正确的 Transfer，但 totalSupply() revert。
  rpc.set(A.plain, { code: "0x60806040", calls: {} });
  return rpc;
}

/** 完整剧本。返回 { db, rpc, tx }。两个测试文件共用同一个夹具。 */
export async function scenario() {
  resetWarnings();
  const { db } = tempDb();
  seedAgents(db);
  const rpc = stubs();
  const tx = {
    deployA: txHash("deployA"), deployB: txHash("deployB"), deployFac: txHash("deployFac"),
    deployPlain: txHash("deployPlain"), createPair: txHash("createPair"), spread: txHash("spread"),
    addLiq: txHash("addLiq"), swap: txHash("swap"), burn: txHash("burn"), callPlain: txHash("callPlain"),
  };
  const xfer = (token, from, to, value, o) =>
    mkBuiltLog("erc20", "Transfer", { from, to, value }, { address: token, ...o });

  // b100：agent #17 部署代币 A 并给自己铸了 100 万
  await ingestBlock(db, rpc, {
    number: 100, ts: T,
    txs: [{ hash: tx.deployA, from: A.w17, to: null, created: A.tokenA, codeSize: 12844 }],
    logs: [xfer(A.tokenA, A.zero, A.w17, e18(1000000), { blockNumber: 100, logIndex: 0, txHash: tx.deployA })],
  });

  // b101：agent #21 部署代币 B
  await ingestBlock(db, rpc, {
    number: 101, ts: T + 3,
    txs: [{ hash: tx.deployB, from: A.w21, to: null, created: A.tokenB, codeSize: 9001 }],
    logs: [xfer(A.tokenB, A.zero, A.w21, e6(500000), { blockNumber: 101, logIndex: 0, txHash: tx.deployB })],
  });

  // b102：agent #21 部署工厂；agent #30 部署一个我们认不出来的合约
  await ingestBlock(db, rpc, {
    number: 102, ts: T + 6,
    txs: [
      { hash: tx.deployFac, from: A.w21, to: null, created: A.factory, codeSize: 20000 },
      { hash: tx.deployPlain, from: A.w30, to: null, created: A.plain, codeSize: 700 },
    ],
    logs: [xfer(A.plain, A.zero, A.w30, 1n, { blockNumber: 102, logIndex: 0, txHash: tx.deployPlain })],
  });

  // b103：agent #21 调工厂建池（CREATE2 出来的地址收据里没有，creator 走 §7.2.4 的 tx.from）
  await ingestBlock(db, rpc, {
    number: 103, ts: T + 9,
    txs: [{ hash: tx.createPair, from: A.w21, to: A.factory }],
    logs: [
      mkBuiltLog("v2", "PairCreated", { token0: A.tokenA, token1: A.tokenB, pair: A.pair, allPairsLength: 1n },
        { address: A.factory, blockNumber: 103, logIndex: 0, txHash: tx.createPair }),
    ],
  });

  // b104：agent #17 把币分给 #21 和 #30
  await ingestBlock(db, rpc, {
    number: 104, ts: T + 12,
    txs: [{ hash: tx.spread, from: A.w17, to: A.tokenA }],
    logs: [
      xfer(A.tokenA, A.w17, A.w21, e18(200000), { blockNumber: 104, logIndex: 0, txHash: tx.spread }),
      xfer(A.tokenA, A.w17, A.w30, e18(10000), { blockNumber: 104, logIndex: 1, txHash: tx.spread }),
    ],
  });

  // b105：agent #21 加流动性
  await ingestBlock(db, rpc, {
    number: 105, ts: T + 15,
    txs: [{ hash: tx.addLiq, from: A.w21, to: A.pair }],
    logs: [
      xfer(A.tokenA, A.w21, A.pair, e18(100000), { blockNumber: 105, logIndex: 0, txHash: tx.addLiq }),
      xfer(A.tokenB, A.w21, A.pair, e6(200000), { blockNumber: 105, logIndex: 1, txHash: tx.addLiq }),
      mkBuiltLog("v2", "Sync", { reserve0: e18(100000), reserve1: e6(200000) },
        { address: A.pair, blockNumber: 105, logIndex: 2, txHash: tx.addLiq }),
      mkBuiltLog("v2", "Mint", { sender: A.w21, amount0: e18(100000), amount1: e6(200000) },
        { address: A.pair, blockNumber: 105, logIndex: 3, txHash: tx.addLiq }),
    ],
  });

  // b106：agent #30 拿 1000 个 A 换 1980 个 B
  await ingestBlock(db, rpc, {
    number: 106, ts: T + 18,
    txs: [{ hash: tx.swap, from: A.w30, to: A.pair }],
    logs: [
      xfer(A.tokenA, A.w30, A.pair, e18(1000), { blockNumber: 106, logIndex: 0, txHash: tx.swap }),
      xfer(A.tokenB, A.pair, A.w30, e6(1980), { blockNumber: 106, logIndex: 1, txHash: tx.swap }),
      mkBuiltLog("v2", "Swap", {
        sender: A.w30, amount0In: e18(1000), amount1In: 0n, amount0Out: 0n, amount1Out: e6(1980), to: A.w30,
      }, { address: A.pair, blockNumber: 106, logIndex: 2, txHash: tx.swap }),
      mkBuiltLog("v2", "Sync", { reserve0: e18(101000), reserve1: e6(198020) },
        { address: A.pair, blockNumber: 106, logIndex: 3, txHash: tx.swap }),
    ],
  });

  // b107：agent #17 烧掉 1000 个 A；agent #30 调一下那个认不出来的合约
  await ingestBlock(db, rpc, {
    number: 107, ts: T + 21,
    txs: [
      { hash: tx.burn, from: A.w17, to: A.tokenA },
      { hash: tx.callPlain, from: A.w30, to: A.plain },
    ],
    logs: [xfer(A.tokenA, A.w17, A.dead, e18(1000), { blockNumber: 107, logIndex: 0, txHash: tx.burn })],
  });

  return { db, rpc, tx };
}

