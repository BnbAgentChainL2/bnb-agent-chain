// agent 造出来的东西的对外类型。字段名逐字来自 docs/03-INTERFACES.md §7.6，改名就是改契约。
//
// 两条贯穿全文件的纪律：
//   1. **金额一律是该代币自己的最小单位**（bigint），随行给 `decimals`。decimals 未知时是 null，
//      **不许默认当 18**（03 §7.0 第 5 条）。代币金额不得和 BAC / BNB 放进同一个合计里。
//   2. **name / symbol / uri 是部署者自己写的不可信文本**，本站不核实（`nameTrusted` 恒为 false）。
//      渲染到 HTML 之前必须自己转义 —— SDK 不替你转义，因为它不知道你要渲染到哪里。

/** 每个返回体都带的启发式说明块（03 §7.6，一字不改地透传）。 */
export interface Detection {
  method: string;
  note: string;
  rulesUrl: string;
  unclassifiedContracts: number;
}

export type DetectLevel = "full" | "partial";
export type PairKind = "v2" | "v3";
export type SwapSide = "sell0" | "buy0" | "unknown";
export type Classified = "token" | "pair" | "factory" | "multi_token" | "nft" | null;

export interface Creator {
  agentId: number | null;
  wallet: string | null;
}

export interface TokenInfo {
  address: string;
  /** 不可信文本，可能为 null（partial 等级） */
  name: string | null;
  symbol: string | null;
  /** 未知就是 null，**不许当 18** */
  decimals: number | null;
  /** 恒为 false。它存在的唯一目的是让调用方没法忘记这件事 */
  nameTrusted: false;
  totalSupply: bigint | null;
  supplyBlock: number | null;
  creator: Creator;
  deployTx: string | null;
  deployBlock: number | null;
  deployTs: number | null;
  holders: number;
  transfers: number;
  mints: number;
  burns: number;
  pairCount: number;
  swapCount: number;
  firstTs: number | null;
  lastTs: number | null;
  detectLevel: DetectLevel;
  /** 转账事件与链上 balanceOf 对不上（收税 / rebase），持有量只能当参考 */
  balanceDrift: boolean;
  /** X5：totalSupply 恒为 0 且转账全是 0，列表里默认折叠 */
  zeroOnly: boolean;
  sameNameCount: number;
}

export interface PairSide {
  address: string;
  symbol: string | null;
  decimals: number | null;
  /** false = 这一边没被判成代币，只能显示地址 */
  known: boolean;
}

export interface PairInfo {
  address: string;
  kind: PairKind;
  discoveredVia: "factory" | "event" | null;
  factory: { address: string; creatorAgentId: number | null } | null;
  token0: PairSide;
  token1: PairSide;
  creator: Creator;
  deployTx: string | null;
  deployBlock: number | null;
  deployTs: number | null;
  reserve0: bigint | null;
  reserve1: bigint | null;
  /** V2 是 getReserves，V3 是 balanceOf 读的池内余额 —— **两者不是一个东西，不许混在一列里比** */
  reserveSource: "getReserves" | "balanceOf" | null;
  reserveBlock: number | null;
  feePpm: number | null;
  tickSpacing: number | null;
  swapCount: number;
  vol0: bigint | null;
  vol1: bigint | null;
  volSkipped: number;
  mintCount: number;
  burnCount: number;
  /** price_1_per_0 的 ×10^-18 定点数。**不是行情价、不是法币价** */
  lastPrice: bigint | null;
  lastPriceBlock: number | null;
  firstTs: number | null;
  lastTs: number | null;
  detectLevel: DetectLevel;
}

export interface SwapInfo {
  cursor: string;
  block: number;
  ts: number;
  epoch: number | null;
  tx: string;
  logIndex: number;
  pair: { address: string; kind: PairKind; token0: PairSide; token1: PairSide };
  /** 做这笔成交的 agent，取的是 tx.from，不是 sender / recipient（03 §7.3） */
  agentId: number | null;
  txFrom: string | null;
  sender: string | null;
  recipient: string | null;
  tokenIn: string | null;
  amountIn: bigint | null;
  tokenOut: string | null;
  amountOut: bigint | null;
  /** 固定相对 token0：sell0 = token0 进池子，buy0 = token0 出池子 */
  side: SwapSide;
  price1Per0: bigint | null;
  /** false = 这笔成交形状不标准，只有原始数值可信 */
  normalized: boolean;
}

export interface TransferInfo {
  cursor: string;
  block: number;
  ts: number;
  tx: string;
  logIndex: number;
  from: string;
  to: string;
  fromAgentId: number | null;
  toAgentId: number | null;
  value: bigint;
  kind: "mint" | "burn" | "transfer";
}

export interface HolderInfo {
  rank: number;
  address: string;
  agentId: number | null;
  balance: bigint;
  shareBps: number | null;
  isContract: boolean;
  /** "pair" 的持有者是池子里的钱，**不是某个人的持仓** */
  role: "pair" | "token" | "factory" | null;
}

/** 带 detection 的分页返回。 */
export interface Page<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
  detection: Detection | null;
  updatedAt: number | null;
}

/** 带 detection 的游标返回。 */
export interface Cursored<T> {
  items: T[];
  next: string | null;
  detection: Detection | null;
  updatedAt: number | null;
}

/** 直接从链上读出来的储备（不经索引器）。 */
export interface Reserves {
  pair: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  /** getReserves = V2 的储备；balanceOf = 池内余额（V3 或 getReserves 读不到时的回退） */
  source: "getReserves" | "balanceOf";
  blockTimestampLast: number | null;
  /** 读数所在的区块号（"latest" 读不出高度时为 null） */
  atBlock: number | null;
}

/** 合约分类（GET /api/contract/{address}）。 */
export interface ContractClassification {
  address: string;
  classified: Classified;
  classifiedZh: string;
  token: TokenInfo | null;
  pair: PairInfo | null;
  detection: Detection | null;
  deployer: string | null;
  agentId: number | null;
  codeSize: number | null;
  callCount: number;
}

/** watchBuilt() 吐出来的一条。 */
export interface BuiltEvent {
  id: number;
  kind: "TOKEN_NEW" | "PAIR_NEW" | "TOKEN_FIRST_TRADE" | "DEPLOY" | string;
  ts: number;
  block: number;
  agentId: number | null;
  /** 索引器渲染好的中文句子；里面可能含 agent 自己写的 symbol，**渲染前必须转义** */
  textZh: string;
  tx: string;
  anchored: boolean;
  epoch: number | null;
}
