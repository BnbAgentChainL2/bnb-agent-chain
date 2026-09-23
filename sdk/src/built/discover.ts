// 发现别的 agent 造了什么：全部只读，全部带主/兜底端点切换。
//
// 两个数据源，用途分得很清：
//   · 索引 API（/api/tokens、/api/pairs、/api/swaps…）：**启发式解码**出来的表，会漏也会错，
//     每个返回体都带 detection 块，请求方必须把那句话显示出来，不许说成「全链所有代币」（03 §7.6）。
//   · 层内 RPC（eth_call）：链上此刻的真值，比如某个交易对的储备。要按这个数下单，不要按索引器的缓存。
//
// 这里的每一个函数都**只是读**。SDK 不发官方 DEX、不发官方代币、不发官方工具合约（决策 #19 / 03 §7.0）。

import { Interface, getAddress } from "ethers";
import { BacApiError } from "../errors.js";
import { ERC20_FULL_ABI, V2_PAIR_ABI, V3_POOL_READ_ABI } from "./abi.js";
import { apiPool, layerPool, type BuiltConfig } from "./config.js";
import { getAmountIn, getAmountOut } from "./quote.js";
import type {
  BuiltEvent, ContractClassification, Cursored, Detection, HolderInfo, Page, PairInfo, PairSide,
  Reserves, SwapInfo, TokenInfo, TransferInfo,
} from "./types.js";

const pairIface = new Interface(V2_PAIR_ABI);
const erc20Iface = new Interface(ERC20_FULL_ABI);
const v3Iface = new Interface(V3_POOL_READ_ABI);

// ------------------------------------------------------------------ 解析 ---

function big(v: unknown): bigint | null {
  if (v === undefined || v === null || v === "") return null;
  try { return BigInt(v as string); } catch { return null; }
}
function num(v: unknown): number | null {
  return v === undefined || v === null ? null : Number(v);
}
function int(v: unknown, dflt = 0): number {
  const n = num(v);
  return n === null || Number.isNaN(n) ? dflt : n;
}
function addr(v: unknown): string | null {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  return getAddress(v);
}

/** detection 块原样带出来；**没有它就说明对面不是本文档定义的那个 API**，此时返回 null 而不是编一个。 */
export function parseDetection(raw: unknown): Detection | null {
  const d = raw as Detection | undefined;
  if (!d || typeof d !== "object" || typeof d.note !== "string") return null;
  return {
    method: String(d.method ?? "heuristic"),
    note: d.note,
    rulesUrl: String(d.rulesUrl ?? ""),
    unclassifiedContracts: int((d as Detection).unclassifiedContracts, 0),
  };
}

export function parseToken(raw: any): TokenInfo {
  return {
    address: addr(raw?.address) ?? String(raw?.address ?? ""),
    name: raw?.name ?? null,
    symbol: raw?.symbol ?? null,
    decimals: raw?.decimals === undefined || raw?.decimals === null ? null : Number(raw.decimals),
    nameTrusted: false,
    totalSupply: big(raw?.totalSupply),
    supplyBlock: num(raw?.supplyBlock),
    creator: { agentId: num(raw?.creator?.agentId), wallet: addr(raw?.creator?.wallet) },
    deployTx: raw?.deployTx ?? null,
    deployBlock: num(raw?.deployBlock),
    deployTs: num(raw?.deployTs),
    holders: int(raw?.holders),
    transfers: int(raw?.transfers),
    mints: int(raw?.mints),
    burns: int(raw?.burns),
    pairCount: int(raw?.pairCount),
    swapCount: int(raw?.swapCount),
    firstTs: num(raw?.firstTs),
    lastTs: num(raw?.lastTs),
    detectLevel: raw?.detectLevel === "full" ? "full" : "partial",
    balanceDrift: Boolean(raw?.balanceDrift),
    zeroOnly: Boolean(raw?.zeroOnly),
    sameNameCount: int(raw?.sameNameCount),
  };
}

function parseSide(raw: any): PairSide {
  return {
    address: addr(raw?.address) ?? String(raw?.address ?? ""),
    symbol: raw?.symbol ?? null,
    decimals: raw?.decimals === undefined || raw?.decimals === null ? null : Number(raw.decimals),
    known: raw?.known !== false,
  };
}

export function parsePair(raw: any): PairInfo {
  return {
    address: addr(raw?.address) ?? String(raw?.address ?? ""),
    kind: raw?.kind === "v3" ? "v3" : "v2",
    discoveredVia: raw?.discoveredVia ?? null,
    factory: raw?.factory
      ? { address: addr(raw.factory.address) ?? String(raw.factory.address ?? ""), creatorAgentId: num(raw.factory.creatorAgentId) }
      : null,
    token0: parseSide(raw?.token0),
    token1: parseSide(raw?.token1),
    creator: { agentId: num(raw?.creator?.agentId), wallet: addr(raw?.creator?.wallet) },
    deployTx: raw?.deployTx ?? null,
    deployBlock: num(raw?.deployBlock),
    deployTs: num(raw?.deployTs),
    reserve0: big(raw?.reserve0),
    reserve1: big(raw?.reserve1),
    reserveSource: raw?.reserveSource ?? null,
    reserveBlock: num(raw?.reserveBlock),
    feePpm: num(raw?.feePpm),
    tickSpacing: num(raw?.tickSpacing),
    swapCount: int(raw?.swapCount),
    vol0: big(raw?.vol0),
    vol1: big(raw?.vol1),
    volSkipped: int(raw?.volSkipped),
    mintCount: int(raw?.mintCount),
    burnCount: int(raw?.burnCount),
    lastPrice: big(raw?.lastPrice),
    lastPriceBlock: num(raw?.lastPriceBlock),
    firstTs: num(raw?.firstTs),
    lastTs: num(raw?.lastTs),
    detectLevel: raw?.detectLevel === "full" ? "full" : "partial",
  };
}

export function parseSwap(raw: any): SwapInfo {
  return {
    cursor: String(raw?.cursor ?? ""),
    block: int(raw?.block),
    ts: int(raw?.ts),
    epoch: num(raw?.epoch),
    tx: String(raw?.tx ?? ""),
    logIndex: int(raw?.logIndex),
    pair: {
      address: addr(raw?.pair?.address) ?? String(raw?.pair?.address ?? ""),
      kind: raw?.pair?.kind === "v3" ? "v3" : "v2",
      token0: parseSide(raw?.pair?.token0),
      token1: parseSide(raw?.pair?.token1),
    },
    agentId: num(raw?.agentId),
    txFrom: addr(raw?.txFrom),
    sender: addr(raw?.sender),
    recipient: addr(raw?.recipient),
    tokenIn: addr(raw?.tokenIn),
    amountIn: big(raw?.amountIn),
    tokenOut: addr(raw?.tokenOut),
    amountOut: big(raw?.amountOut),
    side: raw?.side === "sell0" || raw?.side === "buy0" ? raw.side : "unknown",
    price1Per0: big(raw?.price1Per0),
    normalized: raw?.normalized !== false,
  };
}

function parseTransfer(raw: any): TransferInfo {
  return {
    cursor: String(raw?.cursor ?? ""),
    block: int(raw?.block),
    ts: int(raw?.ts),
    tx: String(raw?.tx ?? ""),
    logIndex: int(raw?.logIndex),
    from: addr(raw?.from) ?? String(raw?.from ?? ""),
    to: addr(raw?.to) ?? String(raw?.to ?? ""),
    fromAgentId: num(raw?.fromAgentId),
    toAgentId: num(raw?.toAgentId),
    value: big(raw?.value) ?? 0n,
    kind: raw?.kind === "mint" || raw?.kind === "burn" ? raw.kind : "transfer",
  };
}

function parseHolder(raw: any): HolderInfo {
  return {
    rank: int(raw?.rank),
    address: addr(raw?.address) ?? String(raw?.address ?? ""),
    agentId: num(raw?.agentId),
    balance: big(raw?.balance) ?? 0n,
    shareBps: num(raw?.shareBps),
    isContract: Boolean(raw?.isContract),
    role: raw?.role ?? null,
  };
}

function page<T>(raw: any, parse: (r: any) => T): Page<T> {
  return {
    total: int(raw?.total),
    page: int(raw?.page, 1),
    pageSize: int(raw?.pageSize, 50),
    items: Array.isArray(raw?.items) ? raw.items.map(parse) : [],
    detection: parseDetection(raw?.detection),
    updatedAt: num(raw?.updatedAt),
  };
}

function cursored<T>(raw: any, parse: (r: any) => T): Cursored<T> {
  return {
    items: Array.isArray(raw?.items) ? raw.items.map(parse) : [],
    next: raw?.next ?? null,
    detection: parseDetection(raw?.detection),
    updatedAt: num(raw?.updatedAt),
  };
}

// -------------------------------------------------------------- 索引 API ---

export interface TokenListOptions {
  page?: number;
  pageSize?: number;
  sort?: "newest" | "holders" | "transfers" | "swaps" | "activity";
  agentId?: number | bigint;
  /** ≤ 64 字节，只做字面前缀匹配，不做模糊 */
  q?: string;
  level?: "full" | "partial" | "all";
  /** X5 折叠掉的那批（totalSupply 恒为 0 的）要不要一起返回 */
  includeZeroOnly?: boolean;
}

/** 列出被判定成 ERC-20 形状的代币（03 §7.6 `GET /api/tokens`）。**这是启发式的结果，不是「全链所有代币」。** */
export async function listTokens(opts: TokenListOptions = {}, cfg: BuiltConfig = {}): Promise<Page<TokenInfo>> {
  const raw = await apiPool(cfg).getJson<any>("/api/tokens", {
    page: opts.page, pageSize: opts.pageSize, sort: opts.sort, agentId: opts.agentId?.toString(),
    q: opts.q, level: opts.level, includeZeroOnly: opts.includeZeroOnly ? 1 : undefined,
  });
  return page(raw, parseToken);
}

export interface TokenDetail {
  token: TokenInfo;
  detection: Detection | null;
  supplyCheck: { onchainTotalSupply: bigint | null; derivedHolderSum: bigint | null; drift: bigint | null; note: string } | null;
  topHolders: HolderInfo[];
  pairs: Array<{ address: string; kind: "v2" | "v3"; other: PairSide; reserve0: bigint | null; reserve1: bigint | null; swapCount: number }>;
  recentTransfers: TransferInfo[];
}

/** 单个代币。地址没被判成代币时 API 回 404，这里原样抛 BacApiError（body 里带 contract 指路）。 */
export async function getToken(address: string, cfg: BuiltConfig = {}): Promise<TokenDetail> {
  const raw = await apiPool(cfg).getJson<any>(`/api/token/${getAddress(address)}`);
  return {
    token: parseToken(raw?.token),
    detection: parseDetection(raw?.detection),
    supplyCheck: raw?.supplyCheck
      ? {
          onchainTotalSupply: big(raw.supplyCheck.onchainTotalSupply),
          derivedHolderSum: big(raw.supplyCheck.derivedHolderSum),
          drift: big(raw.supplyCheck.drift),
          note: String(raw.supplyCheck.note ?? ""),
        }
      : null,
    topHolders: Array.isArray(raw?.topHolders) ? raw.topHolders.map(parseHolder) : [],
    pairs: Array.isArray(raw?.pairs)
      ? raw.pairs.map((p: any) => ({
          address: addr(p?.address) ?? String(p?.address ?? ""),
          kind: p?.kind === "v3" ? "v3" : "v2",
          other: parseSide(p?.other),
          reserve0: big(p?.reserve0),
          reserve1: big(p?.reserve1),
          swapCount: int(p?.swapCount),
        }))
      : [],
    recentTransfers: Array.isArray(raw?.recentTransfers) ? raw.recentTransfers.map(parseTransfer) : [],
  };
}

export async function tokenHolders(
  address: string, opts: { page?: number; pageSize?: number } = {}, cfg: BuiltConfig = {},
): Promise<Page<HolderInfo> & { balanceDrift: boolean }> {
  const raw = await apiPool(cfg).getJson<any>(`/api/token/${getAddress(address)}/holders`, opts);
  return { ...page(raw, parseHolder), balanceDrift: Boolean(raw?.balanceDrift) };
}

export async function tokenTransfers(
  address: string,
  opts: { before?: string; after?: string; limit?: number; address?: string; direction?: "in" | "out"; kind?: "mint" | "burn" | "transfer" } = {},
  cfg: BuiltConfig = {},
): Promise<Cursored<TransferInfo>> {
  const raw = await apiPool(cfg).getJson<any>(`/api/token/${getAddress(address)}/transfers`, opts as Record<string, unknown>);
  return cursored(raw, parseTransfer);
}

export interface PairListOptions {
  page?: number;
  pageSize?: number;
  sort?: "newest" | "swaps" | "activity";
  /** 只看含某个代币的池子 */
  token?: string;
  factory?: string;
  kind?: "v2" | "v3";
  /** 建池人 */
  agentId?: number | bigint;
}

/** 列出被判定成交易对 / 池子的合约（03 §7.6 `GET /api/pairs`）。 */
export async function listPairs(opts: PairListOptions = {}, cfg: BuiltConfig = {}): Promise<Page<PairInfo>> {
  const raw = await apiPool(cfg).getJson<any>("/api/pairs", {
    page: opts.page, pageSize: opts.pageSize, sort: opts.sort,
    token: opts.token ? getAddress(opts.token) : undefined,
    factory: opts.factory ? getAddress(opts.factory) : undefined,
    kind: opts.kind, agentId: opts.agentId?.toString(),
  });
  return page(raw, parsePair);
}

export interface PairDetail {
  pair: PairInfo;
  detection: Detection | null;
  price: { price1Per0: bigint | null; price0Per1: bigint | null; source: string | null; atBlock: number | null; note: string } | null;
  recentSwaps: SwapInfo[];
}

export async function getPair(address: string, cfg: BuiltConfig = {}): Promise<PairDetail> {
  const raw = await apiPool(cfg).getJson<any>(`/api/pair/${getAddress(address)}`);
  return {
    pair: parsePair(raw?.pair),
    detection: parseDetection(raw?.detection),
    price: raw?.price
      ? {
          price1Per0: big(raw.price.price1Per0),
          price0Per1: big(raw.price.price0Per1),
          source: raw.price.source ?? null,
          atBlock: num(raw.price.atBlock),
          note: String(raw.price.note ?? ""),
        }
      : null,
    recentSwaps: Array.isArray(raw?.recentSwaps) ? raw.recentSwaps.map(parseSwap) : [],
  };
}

export async function listSwaps(
  opts: { pair?: string; token?: string; agentId?: number | bigint; before?: string; after?: string; limit?: number; normalized?: "0" | "1" | "all" } = {},
  cfg: BuiltConfig = {},
): Promise<Cursored<SwapInfo>> {
  const raw = await apiPool(cfg).getJson<any>("/api/swaps", {
    pair: opts.pair ? getAddress(opts.pair) : undefined,
    token: opts.token ? getAddress(opts.token) : undefined,
    agentId: opts.agentId?.toString(), before: opts.before, after: opts.after,
    limit: opts.limit, normalized: opts.normalized,
  });
  return cursored(raw, parseSwap);
}

/** 「这个合约是个什么」（03 §7.6 `GET /api/contract/{address}`）。认不出来时 classified = null，照实说。 */
export async function classifyContract(address: string, cfg: BuiltConfig = {}): Promise<ContractClassification> {
  const a = getAddress(address);
  const raw = await apiPool(cfg).getJson<any>(`/api/contract/${a}`);
  return {
    address: a,
    classified: raw?.classified ?? null,
    classifiedZh: String(raw?.classifiedZh ?? "我们没能识别出这个合约是什么。它照样是 agent 造出来的东西，只是不在我们的解码规则里。"),
    token: raw?.token ? parseToken(raw.token) : null,
    pair: raw?.pair ? parsePair(raw.pair) : null,
    detection: parseDetection(raw?.detection),
    deployer: addr(raw?.contract?.deployer),
    agentId: num(raw?.contract?.agentId),
    codeSize: num(raw?.contract?.codeSize),
    callCount: int(raw?.contract?.callCount),
  };
}

/** /api/summary 里的 `built` 块：**只有计数，没有金额**（03 §7.7）。 */
export async function builtSummary(cfg: BuiltConfig = {}): Promise<{
  tokens: number; pairs: number; factories: number; swaps: number; transfers: number;
  unclassifiedContracts: number; firstTokenTs: number | null; firstPairTs: number | null;
  detection: Detection | null;
}> {
  const raw = await apiPool(cfg).getJson<any>("/api/summary");
  const b = raw?.built ?? {};
  return {
    tokens: int(b.tokens), pairs: int(b.pairs), factories: int(b.factories),
    swaps: int(b.swaps), transfers: int(b.transfers), unclassifiedContracts: int(b.unclassifiedContracts),
    firstTokenTs: num(b.firstTokenTs), firstPairTs: num(b.firstPairTs),
    detection: parseDetection(b.detection),
  };
}

// --------------------------------------------------------------- 链上读 ---

async function ethCall(cfg: BuiltConfig, to: string, data: string, block: string = "latest"): Promise<string> {
  return layerPool(cfg).rpc<string>("eth_call", [{ to, data }, block]);
}

async function tryCall(cfg: BuiltConfig, to: string, data: string): Promise<string | null> {
  try {
    const out = await ethCall(cfg, to, data);
    return typeof out === "string" && out !== "0x" ? out : null;
  } catch (err) {
    if (err instanceof BacApiError) return null;   // revert / 方法不存在：当作「这个形状对不上」
    throw err;
  }
}

/**
 * 直接从链上读一个交易对此刻的储备。**下单请按这个数算，不要按索引器缓存的 reserve 算。**
 *
 * V2：`getReserves()`（96 字节）。
 * 读不到（V3 池子没有这个函数，或者这个 agent 的实现根本不叫这个名）→ 回退到 `balanceOf(token, pair)`，
 * `source` 写 `balanceOf`。**两个来源不是一个东西**：池内余额包含未领手续费与不在当前区间的流动性（03 §7.2.3）。
 */
export async function readReserves(pair: string, cfg: BuiltConfig = {}): Promise<Reserves> {
  const p = getAddress(pair);
  const t0raw = await tryCall(cfg, p, pairIface.encodeFunctionData("token0"));
  const t1raw = await tryCall(cfg, p, pairIface.encodeFunctionData("token1"));
  if (!t0raw || !t1raw) {
    throw new BacApiError(0, `${p} 上读不到 token0() / token1()`,
      "它不是 V2/V3 形状的交易对（03 §7.2.3 的 P1/P2 没过）。用 classifyContract() 看看它到底是什么。");
  }
  const token0 = getAddress(pairIface.decodeFunctionResult("token0", t0raw)[0] as string);
  const token1 = getAddress(pairIface.decodeFunctionResult("token1", t1raw)[0] as string);

  const resRaw = await tryCall(cfg, p, pairIface.encodeFunctionData("getReserves"));
  let atBlock: number | null = null;
  try {
    const bn = await layerPool(cfg).rpc<string>("eth_blockNumber", []);
    atBlock = Number(BigInt(bn));
  } catch { atBlock = null; }

  if (resRaw && (resRaw.length - 2) / 2 === 96) {
    const d = pairIface.decodeFunctionResult("getReserves", resRaw);
    return {
      pair: p, token0, token1,
      reserve0: BigInt(d[0] as bigint), reserve1: BigInt(d[1] as bigint),
      source: "getReserves", blockTimestampLast: Number(d[2] as bigint), atBlock,
    };
  }

  const b0 = await tryCall(cfg, token0, erc20Iface.encodeFunctionData("balanceOf", [p]));
  const b1 = await tryCall(cfg, token1, erc20Iface.encodeFunctionData("balanceOf", [p]));
  if (!b0 || !b1) {
    throw new BacApiError(0, `${p} 既读不到 getReserves()，两边的 balanceOf 也读不到`,
      "这个池子的形状我们认不出来。别按猜出来的储备下单。");
  }
  return {
    pair: p, token0, token1,
    reserve0: BigInt(erc20Iface.decodeFunctionResult("balanceOf", b0)[0] as bigint),
    reserve1: BigInt(erc20Iface.decodeFunctionResult("balanceOf", b1)[0] as bigint),
    source: "balanceOf", blockTimestampLast: null, atBlock,
  };
}

/** 读一个 V3 形状池子的费率（ppm）。读不到返回 null —— 不猜 3000。 */
export async function readPoolFeePpm(pool: string, cfg: BuiltConfig = {}): Promise<number | null> {
  const raw = await tryCall(cfg, getAddress(pool), v3Iface.encodeFunctionData("fee"));
  if (!raw) return null;
  const v = Number(v3Iface.decodeFunctionResult("fee", raw)[0] as bigint);
  return v >= 0 && v <= 1_000_000 ? v : null;
}

export interface QuoteResult {
  amountIn: bigint;
  amountOut: bigint;
  tokenIn: string;
  tokenOut: string;
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps: number;
  reserveSource: "getReserves" | "balanceOf";
  atBlock: number | null;
  /** 必须显示给人看的一句话 */
  note: string;
}

/**
 * 对着**任意一个** V2 形状的交易对报价。`pair` 和 `feeBps` 都是参数：
 * 我们不知道某个 agent 的池子收多少费，0.3% 只是最常见的默认，不是这条链的规则。
 */
export async function quoteExactIn(
  args: { pair: string; tokenIn: string; amountIn: bigint; feeBps: number }, cfg: BuiltConfig = {},
): Promise<QuoteResult> {
  const r = await readReserves(args.pair, cfg);
  const tokenIn = getAddress(args.tokenIn);
  const zeroIn = tokenIn === r.token0;
  if (!zeroIn && tokenIn !== r.token1) {
    throw new BacApiError(0, `${tokenIn} 不是 ${r.pair} 的任何一边`,
      `这个交易对的两边是 ${r.token0} 与 ${r.token1}。`);
  }
  const reserveIn = zeroIn ? r.reserve0 : r.reserve1;
  const reserveOut = zeroIn ? r.reserve1 : r.reserve0;
  return {
    amountIn: args.amountIn,
    amountOut: getAmountOut(args.amountIn, reserveIn, reserveOut, args.feeBps),
    tokenIn, tokenOut: zeroIn ? r.token1 : r.token0,
    reserveIn, reserveOut, feeBps: args.feeBps, reserveSource: r.source, atBlock: r.atBlock,
    note: "这是按池子此刻储备算出来的兑换比，不是行情价；本链没有法币计价，也没有预言机。",
  };
}

/** 反向：想拿到 amountOut，至少要投多少。同样要求显式 feeBps。 */
export async function quoteExactOut(
  args: { pair: string; tokenOut: string; amountOut: bigint; feeBps: number }, cfg: BuiltConfig = {},
): Promise<QuoteResult> {
  const r = await readReserves(args.pair, cfg);
  const tokenOut = getAddress(args.tokenOut);
  const zeroOut = tokenOut === r.token0;
  if (!zeroOut && tokenOut !== r.token1) {
    throw new BacApiError(0, `${tokenOut} 不是 ${r.pair} 的任何一边`,
      `这个交易对的两边是 ${r.token0} 与 ${r.token1}。`);
  }
  const reserveOut = zeroOut ? r.reserve0 : r.reserve1;
  const reserveIn = zeroOut ? r.reserve1 : r.reserve0;
  return {
    amountIn: getAmountIn(args.amountOut, reserveIn, reserveOut, args.feeBps),
    amountOut: args.amountOut,
    tokenIn: zeroOut ? r.token1 : r.token0, tokenOut,
    reserveIn, reserveOut, feeBps: args.feeBps, reserveSource: r.source, atBlock: r.atBlock,
    note: "这是按池子此刻储备算出来的兑换比，不是行情价；本链没有法币计价，也没有预言机。",
  };
}

// ---------------------------------------------------------------- 盯新事 ---

/** 默认只盯「造出了新东西」这三类 + 合约部署（03 §7.7：成交不进 feed，成交请轮询 listSwaps）。 */
export const BUILT_FEED_KINDS = ["TOKEN_NEW", "PAIR_NEW", "TOKEN_FIRST_TRADE", "DEPLOY"] as const;

export interface WatchOptions {
  /** 从哪条 feed id 之后开始；不给就从当前最新开始（只看新的） */
  after?: number;
  kind?: readonly string[];
  agentId?: number | bigint;
  /** 轮询间隔，默认 6000 毫秒（链 3 秒一块，不必比这更快） */
  intervalMs?: number;
  limit?: number;
  signal?: AbortSignal;
}

/**
 * 盯着别的 agent 又造了什么。轮询 `/api/feed`，游标是 feed 的自增 id，主/兜底端点自动切换。
 * `textZh` 里可能含 agent 自己写的 symbol：**渲染成 HTML 前必须自己转义。**
 */
export async function* watchBuilt(opts: WatchOptions = {}, cfg: BuiltConfig = {}): AsyncGenerator<BuiltEvent> {
  const pool = apiPool(cfg);
  const kinds = (opts.kind ?? BUILT_FEED_KINDS).join(",");
  let after = opts.after;
  if (after === undefined) {
    const head = await pool.getJson<any>("/api/feed", { limit: 1, kind: kinds });
    after = int(head?.head, 0);
  }
  const interval = Math.max(1000, opts.intervalMs ?? 6000);
  for (;;) {
    if (opts.signal?.aborted) return;
    const raw = await pool.getJson<any>("/api/feed", {
      after, limit: opts.limit ?? 50, kind: kinds, agentId: opts.agentId?.toString(),
    });
    const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
    for (const it of items) {
      const id = int(it?.id);
      if (id > (after ?? 0)) after = id;
      yield {
        id, kind: String(it?.kind ?? ""), ts: int(it?.ts), block: int(it?.block),
        agentId: num(it?.agentId), textZh: String(it?.textZh ?? ""), tx: String(it?.tx ?? ""),
        anchored: Boolean(it?.anchored), epoch: num(it?.epoch),
      };
    }
    if (opts.signal?.aborted) return;
    await sleep(interval, opts.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
