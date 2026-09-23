// agent 造出来的东西：**接口形状**，不是实现。
//
// 这个文件里没有任何字节码，也不会有。本链不发官方代币、官方 DEX、官方工具合约（决策 #19 / 03 §7.0），
// SDK 也不许夹带一份「我们的」ERC-20 或 AMM —— 夹带了就等于我们背书了那套合约。
// 下面这些只是**调用形状**：ERC-20 的四个函数、Uniswap V2 形状的 pair / factory / router、
// WETH9 形状的 deposit/withdraw。地址一律由调用方传进来，本文件里一个地址都没有。
//
// 「V2 形状」的定义逐字来自 03 §7.2：token0() / token1() / getReserves() 三件套 + Swap/Sync/Mint/Burn 事件。
// 一个 agent 完全可以造出不是这个形状的交易所，那时下面这些函数用不上 —— 这是启发式，会漏也会错。

export const ERC20_FULL_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
] as const;

/** Uniswap V2 形状的交易对。`getReserves()` 返回 96 字节（uint112,uint112,uint32）是 03 §7.2.3 的 P3。 */
export const V2_PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to) returns (uint256 liquidity)",
  "function burn(address to) returns (uint256 amount0, uint256 amount1)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
  "function sync()",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
] as const;

export const V2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256 i) view returns (address pair)",
  "function createPair(address tokenA, address tokenB) returns (address pair)",
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)",
] as const;

/**
 * Uniswap V2 形状的路由器。**本链没有官方路由器** —— 这只是最常见的那个接口形状，
 * 地址必须由调用方传进来（`swapExactIn({ router })`）。
 * 某个 agent 部署的路由器可以长得完全不一样，那时请用 `swapOnPairDirect()` 直接打交易对，
 * 或者用 `Agent.call()` 按它自己的 ABI 调。
 */
export const V2_ROUTER_ABI = [
  "function factory() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)",
] as const;

/**
 * WETH9 形状的包装币（决策 #22 把 WBAC 放进创世，它是中立工具，不是 DEX）。
 * **地址由调用方传或由 /api/health 给**，SDK 里不写死：写死等于在地址还没定下来之前替所有人做主。
 */
export const WRAPPED_NATIVE_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;

/** V3 形状只用于**读**（03 §7.2.3 的 P5/P6）。SDK 不提供 V3 的交易帮手：正确做需要重建整条 tick 表。 */
export const V3_POOL_READ_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
] as const;
