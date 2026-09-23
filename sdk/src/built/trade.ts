// 交易帮手：对着**别的 agent 部署的**任意 V2 形状交易对 / 路由器干活。
//
// 每一个函数的第一个参数都是「你要打哪个合约」：`router` / `pair` / `token` 一律由调用方传进来，
// SDK 里**没有任何一个写死的交易地址**，因为本链没有官方 DEX，也永远不会由我们发一个（决策 #19 / 03 §7.0）。
// 路由器的 ABI 只是 Uniswap V2 那个最常见的接口形状；遇到形状不一样的实现，
// 用 `swapOnPairDirect()` 直接打交易对，或者用 `Agent.call()` 按它自己的 ABI 调。
//
// gas 口径与 deploy.ts 完全一致：legacy（type 0）交易、gasPrice ≥ 1 gwei、gasLimit = 估算 × 1.25、上限 20,000,000。

import { Contract, Interface, getAddress, MaxUint256, type Provider, type Signer } from "ethers";
import { BacError, withChainErrors } from "../errors.js";
import { ERC20_FULL_ABI, V2_PAIR_ABI, V2_ROUTER_ABI, WRAPPED_NATIVE_ABI } from "./abi.js";
import { planGas, type DeployOptions } from "./deploy.js";
import { applySlippage, getAmountOut } from "./quote.js";

const erc20Iface = new Interface(ERC20_FULL_ABI);
const pairIface = new Interface(V2_PAIR_ABI);
const routerIface = new Interface(V2_ROUTER_ABI);
const wnativeIface = new Interface(WRAPPED_NATIVE_ABI);

/** 默认给 10 分钟：一个纪元就是 10 分钟（决策 #20），比这更长的 deadline 等于没有 deadline。 */
export const DEFAULT_DEADLINE_SEC = 600;

export interface TxOptions {
  gasLimit?: bigint;
  gasPrice?: bigint;
  gasHeadroomBps?: number;
  confirmations?: number;
  /** 不发交易，只返回将要发的 calldata 与 gas 方案（--dry-run 用） */
  dryRun?: boolean;
}

export interface TradeResult {
  txHash: string;
  blockNumber: number | null;
  gasUsed: bigint;
  gasPrice: bigint;
  feeWei: bigint;
  /** 实际发出去的 calldata，出问题时可以拿它去 eth_call 重放 */
  data: string;
  to: string;
  /** dryRun 时为 true，链上什么都没发生 */
  simulated: boolean;
}

function providerOf(signer: Signer): Provider {
  const p = signer.provider;
  if (!p) {
    throw new BacError("no_provider", "signer 没有连 provider",
      "用 new Wallet(key, layerProvider(cfg)) 把钱包接到层内 RPC 上再来。");
  }
  return p;
}

function requireAddr(v: string | undefined | null, what: string): string {
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x0+$/.test(v)) {
    throw new BacError(
      "missing_address",
      `${what} 必须由你传进来，收到 ${String(v)}`,
      "本链没有官方路由器 / 官方交易对 / 官方代币，SDK 里一个地址都没写死。先用 listPairs() 找到你要打的那个合约。",
    );
  }
  return getAddress(v);
}

/** 按链上时间给一个 deadline（不是本机时间：本机时钟偏几分钟就会让每一笔都 revert）。 */
export async function defaultDeadline(provider: Provider, sec = DEFAULT_DEADLINE_SEC): Promise<bigint> {
  const b = await provider.getBlock("latest");
  const base = b?.timestamp ?? Math.floor(Date.now() / 1000);
  return BigInt(base + sec);
}

/** 统一出口：估 gas → 发 legacy 交易 → 等确认。所有写操作都走这里，gas 口径才不会各写各的。 */
async function sendTx(
  signer: Signer, to: string, data: string, value: bigint, opts: TxOptions, what: string,
): Promise<TradeResult> {
  const provider = providerOf(signer);
  const from = await signer.getAddress();
  return withChainErrors(what, async () => {
    const plan = await planGas(provider, { from, to, data, value }, opts as DeployOptions);
    if (opts.dryRun) {
      return {
        txHash: "", blockNumber: null, gasUsed: plan.estimated, gasPrice: plan.gasPrice,
        feeWei: plan.estimated * plan.gasPrice, data, to, simulated: true,
      };
    }
    const tx = await signer.sendTransaction({
      type: 0, to, data, value, gasLimit: plan.gasLimit, gasPrice: plan.gasPrice,
    });
    const rc = await tx.wait(opts.confirmations ?? 1);
    if (rc && rc.status === 0) {
      throw new BacError("tx_failed", `${what} 上链了但 status = 0（tx ${tx.hash}）`,
        "拿返回里的 data 去 eth_call 重放同一高度，看 revert 字符串。滑点不够是最常见的原因。");
    }
    return {
      txHash: tx.hash, blockNumber: rc?.blockNumber ?? null, gasUsed: rc?.gasUsed ?? 0n,
      gasPrice: plan.gasPrice, feeWei: (rc?.gasUsed ?? 0n) * (rc?.gasPrice ?? plan.gasPrice),
      data, to, simulated: false,
    };
  });
}

// ---------------------------------------------------------------- 授权 ---

export async function allowanceOf(provider: Provider, token: string, owner: string, spender: string): Promise<bigint> {
  const c = new Contract(requireAddr(token, "token"), ERC20_FULL_ABI as unknown as string[], provider);
  return BigInt(await c.allowance(getAddress(owner), requireAddr(spender, "spender")));
}

/**
 * 授权。`amount` 不传就是无限授权（MaxUint256）—— **无限授权意味着那个合约随时能划走你这个代币的全部余额**，
 * 对着一个陌生 agent 部署的路由器给无限授权，风险自负。只授权这一笔要用的量更安全。
 */
export async function approve(
  signer: Signer, args: { token: string; spender: string; amount?: bigint }, opts: TxOptions = {},
): Promise<TradeResult> {
  const token = requireAddr(args.token, "token");
  const spender = requireAddr(args.spender, "spender");
  const data = erc20Iface.encodeFunctionData("approve", [spender, args.amount ?? MaxUint256]);
  return sendTx(signer, token, data, 0n, opts, "approve");
}

/** 够了就不发交易；不够才补一笔。返回 `txHash = null` 表示本来就够。 */
export async function ensureAllowance(
  signer: Signer, args: { token: string; spender: string; amount: bigint }, opts: TxOptions = {},
): Promise<{ txHash: string | null; allowance: bigint }> {
  const provider = providerOf(signer);
  const owner = await signer.getAddress();
  const current = await allowanceOf(provider, args.token, owner, args.spender);
  if (current >= args.amount) return { txHash: null, allowance: current };
  const r = await approve(signer, { token: args.token, spender: args.spender, amount: args.amount }, opts);
  return { txHash: r.txHash, allowance: args.amount };
}

// ---------------------------------------------------------------- 成交 ---

export interface SwapExactInArgs {
  /** **必填**：你要打的那个路由器，由你自己找（listPairs / 问部署它的 agent） */
  router: string;
  /** [tokenIn, …, tokenOut]，至少两个地址 */
  path: string[];
  amountIn: bigint;
  /** 最少要拿到多少。不给就用路由器自己的 getAmountsOut 报价 × (1 − slippageBps) */
  amountOutMin?: bigint;
  /** 默认 50（0.5%）。给 0 表示一分钱都不让，几乎一定 revert */
  slippageBps?: number;
  /** 收款地址，默认发起人自己 */
  to?: string;
  /** 绝对时间戳（秒）。不给就按**链上**最新块时间 + 10 分钟 */
  deadline?: bigint;
}

async function quoteWithRouter(
  provider: Provider, router: string, fn: "getAmountsOut" | "getAmountsIn", amount: bigint, path: string[],
): Promise<bigint[] | null> {
  try {
    const c = new Contract(router, V2_ROUTER_ABI as unknown as string[], provider);
    const out = await c[fn](amount, path);
    return (out as bigint[]).map((x) => BigInt(x));
  } catch {
    return null;   // 这个路由器不是这个形状：不猜，让调用方显式给滑点下限
  }
}

/** exact-in：投 `amountIn`，至少拿回 `amountOutMin`。 */
export async function swapExactIn(signer: Signer, args: SwapExactInArgs, opts: TxOptions = {}): Promise<TradeResult & { amountOutMin: bigint; deadline: bigint }> {
  const provider = providerOf(signer);
  const router = requireAddr(args.router, "router");
  const path = args.path.map((p, i) => requireAddr(p, `path[${i}]`));
  if (path.length < 2) {
    throw new BacError("bad_path", `path 至少要两个地址，收到 ${path.length} 个`, "path = [投入的代币, …, 想拿到的代币]。");
  }
  const to = getAddress(args.to ?? (await signer.getAddress()));
  const deadline = args.deadline ?? (await defaultDeadline(provider));

  let amountOutMin = args.amountOutMin;
  if (amountOutMin === undefined) {
    const amounts = await quoteWithRouter(provider, router, "getAmountsOut", args.amountIn, path);
    if (!amounts || amounts.length === 0) {
      throw new BacError(
        "no_quote",
        `${router} 上的 getAmountsOut 读不到，没法自己定滑点下限`,
        "这个路由器不是标准 V2 形状。请自己算好 amountOutMin 传进来（quoteExactIn() 可以按池子储备算），或者改用 swapOnPairDirect()。",
      );
    }
    amountOutMin = applySlippage(amounts[amounts.length - 1]!, args.slippageBps ?? 50, "min");
  }

  const data = routerIface.encodeFunctionData("swapExactTokensForTokens", [args.amountIn, amountOutMin, path, to, deadline]);
  const r = await sendTx(signer, router, data, 0n, opts, "swapExactTokensForTokens");
  return { ...r, amountOutMin, deadline };
}

export interface SwapExactOutArgs {
  router: string;
  path: string[];
  amountOut: bigint;
  amountInMax?: bigint;
  slippageBps?: number;
  to?: string;
  deadline?: bigint;
}

/** exact-out：要拿到 `amountOut`，最多付 `amountInMax`。 */
export async function swapExactOut(signer: Signer, args: SwapExactOutArgs, opts: TxOptions = {}): Promise<TradeResult & { amountInMax: bigint; deadline: bigint }> {
  const provider = providerOf(signer);
  const router = requireAddr(args.router, "router");
  const path = args.path.map((p, i) => requireAddr(p, `path[${i}]`));
  if (path.length < 2) {
    throw new BacError("bad_path", `path 至少要两个地址，收到 ${path.length} 个`, "path = [投入的代币, …, 想拿到的代币]。");
  }
  const to = getAddress(args.to ?? (await signer.getAddress()));
  const deadline = args.deadline ?? (await defaultDeadline(provider));

  let amountInMax = args.amountInMax;
  if (amountInMax === undefined) {
    const amounts = await quoteWithRouter(provider, router, "getAmountsIn", args.amountOut, path);
    if (!amounts || amounts.length === 0) {
      throw new BacError(
        "no_quote",
        `${router} 上的 getAmountsIn 读不到，没法自己定上限`,
        "这个路由器不是标准 V2 形状。请自己算好 amountInMax 传进来（quoteExactOut() 可以按池子储备算）。",
      );
    }
    amountInMax = applySlippage(amounts[0]!, args.slippageBps ?? 50, "max");
  }

  const data = routerIface.encodeFunctionData("swapTokensForExactTokens", [args.amountOut, amountInMax, path, to, deadline]);
  const r = await sendTx(signer, router, data, 0n, opts, "swapTokensForExactTokens");
  return { ...r, amountInMax, deadline };
}

/**
 * 不经路由器，直接打交易对（V2 的 `swap(amount0Out, amount1Out, to, data)`）。
 * 用在路由器形状不认识、或者你不想给任何路由器授权的时候。
 *
 * **顺序很重要**：V2 的 pair 是先收币后放币 —— 必须先把 `amountIn` 转进 pair，再调 `swap`。
 * 这两步不是原子的：中间被人抢跑，你的币就留在池子里成了别人的礼物。
 * 能用路由器（一笔原子交易）就用路由器；用这条路径请只用小额，并且自己承担抢跑风险。
 */
export async function swapOnPairDirect(
  signer: Signer,
  args: { pair: string; tokenIn: string; amountIn: bigint; feeBps: number; amountOutMin?: bigint; slippageBps?: number; to?: string },
  opts: TxOptions = {},
): Promise<{ transfer: TradeResult; swap: TradeResult; amountOut: bigint; amountOutMin: bigint }> {
  const provider = providerOf(signer);
  const pair = requireAddr(args.pair, "pair");
  const tokenIn = requireAddr(args.tokenIn, "tokenIn");
  const to = getAddress(args.to ?? (await signer.getAddress()));

  const c = new Contract(pair, V2_PAIR_ABI as unknown as string[], provider);
  const token0 = getAddress(await c.token0());
  const token1 = getAddress(await c.token1());
  const res = await c.getReserves();
  const reserve0 = BigInt(res[0]);
  const reserve1 = BigInt(res[1]);
  const zeroIn = tokenIn === token0;
  if (!zeroIn && tokenIn !== token1) {
    throw new BacError("not_in_pair", `${tokenIn} 不是 ${pair} 的任何一边`,
      `这个交易对的两边是 ${token0} 与 ${token1}。`);
  }
  const reserveIn = zeroIn ? reserve0 : reserve1;
  const reserveOut = zeroIn ? reserve1 : reserve0;
  const amountOut = getAmountOut(args.amountIn, reserveIn, reserveOut, args.feeBps);
  const amountOutMin = args.amountOutMin ?? applySlippage(amountOut, args.slippageBps ?? 50, "min");
  if (amountOut < amountOutMin) {
    throw new BacError("slippage", `按当前储备只能换到 ${amountOut}，低于你要求的 ${amountOutMin}`,
      "等价格回来，或者把数量调小。别把下限放宽到「随便多少都行」。");
  }

  const transfer = await sendTx(
    signer, tokenIn, erc20Iface.encodeFunctionData("transfer", [pair, args.amountIn]), 0n, opts, "把币转进交易对",
  );
  const swapData = pairIface.encodeFunctionData("swap", [
    zeroIn ? 0n : amountOut, zeroIn ? amountOut : 0n, to, "0x",
  ]);
  const swap = await sendTx(signer, pair, swapData, 0n, opts, "pair.swap");
  return { transfer, swap, amountOut, amountOutMin };
}

// -------------------------------------------------------------- 流动性 ---

export interface AddLiquidityArgs {
  router: string;
  tokenA: string;
  tokenB: string;
  amountADesired: bigint;
  amountBDesired: bigint;
  amountAMin?: bigint;
  amountBMin?: bigint;
  /** 不给 min 时按这个容忍度从 desired 折算，默认 50（0.5%） */
  slippageBps?: number;
  to?: string;
  deadline?: bigint;
}

/**
 * 加流动性。**第一笔流动性就是你在定价**：两个数量的比值就是初始价格，没有任何东西会纠正它。
 * 之后的每一笔都按当前储备比例配，多出来的那一边会退回给你。
 */
export async function addLiquidity(signer: Signer, args: AddLiquidityArgs, opts: TxOptions = {}): Promise<TradeResult & { deadline: bigint }> {
  const provider = providerOf(signer);
  const router = requireAddr(args.router, "router");
  const tokenA = requireAddr(args.tokenA, "tokenA");
  const tokenB = requireAddr(args.tokenB, "tokenB");
  const to = getAddress(args.to ?? (await signer.getAddress()));
  const deadline = args.deadline ?? (await defaultDeadline(provider));
  const slip = args.slippageBps ?? 50;
  const amountAMin = args.amountAMin ?? applySlippage(args.amountADesired, slip, "min");
  const amountBMin = args.amountBMin ?? applySlippage(args.amountBDesired, slip, "min");

  const data = routerIface.encodeFunctionData("addLiquidity", [
    tokenA, tokenB, args.amountADesired, args.amountBDesired, amountAMin, amountBMin, to, deadline,
  ]);
  const r = await sendTx(signer, router, data, 0n, opts, "addLiquidity");
  return { ...r, deadline };
}

export interface RemoveLiquidityArgs {
  router: string;
  tokenA: string;
  tokenB: string;
  /** LP 代币数量。先 approve 给路由器 */
  liquidity: bigint;
  amountAMin: bigint;
  amountBMin: bigint;
  to?: string;
  deadline?: bigint;
}

/** 撤流动性。`amountAMin` / `amountBMin` 没有默认值：撤资时的下限只有你自己知道该是多少。 */
export async function removeLiquidity(signer: Signer, args: RemoveLiquidityArgs, opts: TxOptions = {}): Promise<TradeResult & { deadline: bigint }> {
  const provider = providerOf(signer);
  const router = requireAddr(args.router, "router");
  const tokenA = requireAddr(args.tokenA, "tokenA");
  const tokenB = requireAddr(args.tokenB, "tokenB");
  const to = getAddress(args.to ?? (await signer.getAddress()));
  const deadline = args.deadline ?? (await defaultDeadline(provider));
  const data = routerIface.encodeFunctionData("removeLiquidity", [
    tokenA, tokenB, args.liquidity, args.amountAMin, args.amountBMin, to, deadline,
  ]);
  const r = await sendTx(signer, router, data, 0n, opts, "removeLiquidity");
  return { ...r, deadline };
}

// ------------------------------------------------------------ 包装原生币 ---

/**
 * 把原生 BAC 包成 ERC-20（WETH9 形状的 `deposit()`）。
 * V2 形状的池子两边必须都是 ERC-20，所以手上的 gas 币要先包一层（决策 #22）。
 * **地址由你传**：`wrappedNativeAddress(cfg)` 可以从 /api/health 取，SDK 里不写死。
 */
export async function wrapNative(
  signer: Signer, args: { wrappedNative: string; amount: bigint }, opts: TxOptions = {},
): Promise<TradeResult> {
  const w = requireAddr(args.wrappedNative, "wrappedNative");
  return sendTx(signer, w, wnativeIface.encodeFunctionData("deposit"), args.amount, opts, "wrap（deposit）");
}

/** 拆回原生 BAC（`withdraw(amount)`）。 */
export async function unwrapNative(
  signer: Signer, args: { wrappedNative: string; amount: bigint }, opts: TxOptions = {},
): Promise<TradeResult> {
  const w = requireAddr(args.wrappedNative, "wrappedNative");
  return sendTx(signer, w, wnativeIface.encodeFunctionData("withdraw", [args.amount]), 0n, opts, "unwrap（withdraw）");
}
