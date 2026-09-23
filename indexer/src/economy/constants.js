// src/economy/constants.js —— 决策 #19 的事件 topic0 与函数选择器（03 §7.1.1 / §7.2.1）。
//
// 纪律（§7.1.1 原话）：**实现里一律写 keccak256("Transfer(address,address,uint256)") 这种现算形式，
// 不许抄十六进制**。文档里那两张表只是给人对照用，test/economy.test.js 里有一条用例把现算结果
// 和文档表逐字对拍 —— 抄错一位的后果是整张代币表永远是空的。
import { id as keccakId, getAddress } from "ethers";

const sel = (sig) => keccakId(sig).slice(0, 10);

/** 事件 topic0。同名陷阱：Swap / Mint / Burn 在 V2 和 V3 里是不同的 topic0，
 *  一律按 topic0 分派，绝不按事件名分派（§7.2.1）。 */
export const TOPIC = {
  Transfer: keccakId("Transfer(address,address,uint256)"),
  Approval: keccakId("Approval(address,address,uint256)"),
  TransferSingle: keccakId("TransferSingle(address,address,address,uint256,uint256)"),
  TransferBatch: keccakId("TransferBatch(address,address,address,uint256[],uint256[])"),

  PairCreated: keccakId("PairCreated(address,address,address,uint256)"),
  SwapV2: keccakId("Swap(address,uint256,uint256,uint256,uint256,address)"),
  Sync: keccakId("Sync(uint112,uint112)"),
  MintV2: keccakId("Mint(address,uint256,uint256)"),
  BurnV2: keccakId("Burn(address,uint256,uint256,address)"),

  PoolCreated: keccakId("PoolCreated(address,address,uint24,int24,address)"),
  SwapV3: keccakId("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  MintV3: keccakId("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  BurnV3: keccakId("Burn(address,int24,int24,uint128,uint256,uint256)"),
  InitializeV3: keccakId("Initialize(uint160,int24)"),
};

/** 函数选择器。探测用的 eth_call 全部从这里取，不写死十六进制。 */
export const SELECTOR = {
  name: sel("name()"),
  symbol: sel("symbol()"),
  decimals: sel("decimals()"),
  totalSupply: sel("totalSupply()"),
  balanceOf: sel("balanceOf(address)"),

  token0: sel("token0()"),
  token1: sel("token1()"),
  getReserves: sel("getReserves()"),
  factory: sel("factory()"),
  fee: sel("fee()"),
  slot0: sel("slot0()"),
  liquidity: sel("liquidity()"),
  tickSpacing: sel("tickSpacing()"),
};

/** 零地址与常见黑洞地址。两者都不计入持有人数（§7.1.7）。 */
export const ZERO_ADDR = getAddress("0x0000000000000000000000000000000000000000");
export const DEAD_ADDR = getAddress("0x000000000000000000000000000000000000dEaD");
export const BURN_ADDRS = [ZERO_ADDR, DEAD_ADDR];

/** X6：四个创世系统合约永远不进代币 / 交易对表。它们是系统合约，不是 agent 造的东西。 */
export const SYSTEM_ADDRS = new Set(
  [
    "0x0000000000000000000000000000000000000101",
    "0x0000000000000000000000000000000000000102",
    "0x0000000000000000000000000000000000000103",
    "0x0000000000000000000000000000000000000104",
  ].map((a) => a.toLowerCase())
);

/** X3：uint256 的十进制位上限是 78，decimals 超过 77 就是垃圾值。 */
export const MAX_DECIMALS = 77;

/** X4：name / symbol 截断到 128 字节。 */
export const MAX_TEXT_BYTES = 128;

/** §7.6 每个返回体都必须带的 detection 块里的那句话，一字不改。 */
export const DETECTION_NOTE =
  "本链没有官方 DEX、官方代币或官方工具合约。这一页是把 agent 自己部署的合约按日志形状和 eth_call 应答解出来的结果，规则写在 docs/03-INTERFACES.md §7。它可能漏掉我们没认出来的东西，也可能认错。";

/** classified -> 给页面直接用的中文（§7.6 的对照表，一字不改）。 */
export const CLASSIFIED_ZH = {
  token: "这是一个代币",
  pair: "这是一个交易对",
  factory: "这是一个交易对工厂",
  multi_token: "这是一个多代币合约（ERC-1155 形状）",
  nft: "这是一个 NFT 形状的合约",
  null:
    "我们没能识别出这个合约是什么。它照样是 agent 造出来的东西，只是不在我们的解码规则里。",
};

export function classifiedZh(classified) {
  return CLASSIFIED_ZH[classified === null || classified === undefined ? "null" : classified] || CLASSIFIED_ZH.null;
}
