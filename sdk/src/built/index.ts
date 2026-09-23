// `built` —— agent 自己造出来的那一层：部署自己的合约、发现别人造了什么、对着别人的池子交易。
//
// 这个模块和 SDK 的其它部分是分开的：`src/built/` 之外的代码一行都没改，
// 03 §5 里那份接口（join / Agent / challenge / exitTree / anchorMath / api / reconcile）原样不动。
//
// **它不含任何官方合约。** 没有官方 ERC-20、没有官方 DEX、没有官方工厂、没有官方路由器，
// 连一份「推荐实现」的字节码都没有（决策 #19 / 03 §7.0 第 1 条）。
// 代币和交易所都由 agent 自己写、自己部署；我们做的事只有两件：
//   1. 把你的字节码按这条链的 gas 规矩送上链；
//   2. 把别人已经部署的合约按日志形状 + eth_call 应答**解码出来**给你看 —— 这是启发式，会漏也会错。

export {
  ERC20_FULL_ABI, V2_PAIR_ABI, V2_FACTORY_ABI, V2_ROUTER_ABI, WRAPPED_NATIVE_ABI, V3_POOL_READ_ABI,
} from "./abi.js";

export { EndpointPool, backoffMs } from "./endpoints.js";
export type { EndpointHealth, PoolOptions } from "./endpoints.js";

export {
  FALLBACK_API_BASE, FALLBACK_LAYER_RPC, apiPool, layerPool, wrappedNativeAddress,
} from "./config.js";
export type { BuiltConfig } from "./config.js";

export {
  BLOCK_GAS_LIMIT, DEFAULT_GAS_HEADROOM_BPS, MAX_CODE_SIZE, MAX_INITCODE_SIZE, MIN_GAS_PRICE_WEI,
  checkCodeSize, deployContract, deployCreate2, encodeInitCode, gasPriceFor, planGas,
  predictCreate2Address, predictCreateAddress,
} from "./deploy.js";
export type { Artifact, DeployOptions, DeployResult, GasPlan } from "./deploy.js";

export {
  applySlippage, getAmountIn, getAmountOut, getAmountsOut, impliedFeeBps, price0Per1, price1Per0,
  quoteAddLiquidity, quoteLiquidity, quoteLiquidityMinted, sortTokens, sqrt,
} from "./quote.js";

export {
  BUILT_FEED_KINDS, builtSummary, classifyContract, getPair, getToken, listPairs, listSwaps,
  listTokens, parseDetection, parsePair, parseSwap, parseToken, quoteExactIn, quoteExactOut,
  readPoolFeePpm, readReserves, tokenHolders, tokenTransfers, watchBuilt,
} from "./discover.js";
export type { PairDetail, PairListOptions, QuoteResult, TokenDetail, TokenListOptions, WatchOptions } from "./discover.js";

export {
  DEFAULT_DEADLINE_SEC, addLiquidity, allowanceOf, approve, defaultDeadline, ensureAllowance,
  removeLiquidity, swapExactIn, swapExactOut, swapOnPairDirect, unwrapNative, wrapNative,
} from "./trade.js";
export type {
  AddLiquidityArgs, RemoveLiquidityArgs, SwapExactInArgs, SwapExactOutArgs, TradeResult, TxOptions,
} from "./trade.js";

export type {
  BuiltEvent, Classified, ContractClassification, Creator, Cursored, DetectLevel, Detection,
  HolderInfo, Page, PairInfo, PairKind, PairSide, Reserves, SwapInfo, SwapSide, TokenInfo,
  TransferInfo,
} from "./types.js";
