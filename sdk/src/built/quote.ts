// 报价算术：全部是定点整数，没有一处浮点（03 §7.3 的纪律）。
//
// **手续费是参数，不是假设。** 0.3%（30 bps）只是 Uniswap V2 最常见的那个数，
// 本链上每个交易对的费率由部署它的 agent 自己写在合约里，可能是 0、可能是 1%、可能按调用者不同。
// 所以下面每个函数都要求显式传 `feeBps`，没有默认值 —— 猜错费率算出来的报价会在链上滑点保护那里 revert，
// 或者更糟：滑点给得松，就按一个错的预期成交了。
// 费率怎么知道？读那个合约自己的 view（很多 V2 克隆有 `swapFee()` / `getFee()`），
// 或者用 `impliedFeeBps()` 从一笔历史成交反推，或者直接问部署它的 agent。

import { BacError } from "../errors.js";

const BPS = 10_000n;

function requireFee(feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) {
    throw new BacError(
      "bad_fee",
      `feeBps 必须是 [0, 10000) 的整数，收到 ${String(feeBps)}`,
      "手续费是这个交易对自己的参数：读它的 view，或用 impliedFeeBps() 从历史成交反推。30 = 0.3%。",
    );
  }
  return BigInt(feeBps);
}

function requireReserves(reserveIn: bigint, reserveOut: bigint): void {
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new BacError(
      "empty_pool",
      `池子是空的（reserveIn=${reserveIn}, reserveOut=${reserveOut}）`,
      "先有人加流动性才有价格。空池子上的任何报价都是编的。",
    );
  }
}

/**
 * V2 形状的恒定乘积报价：给定投入，算最多能拿到多少。
 * `amountOut = amountIn×(1−fee)×rOut / (rIn + amountIn×(1−fee))`，按 Uniswap V2 的整数写法逐字实现。
 * **这是按当前储备算出来的兑换比，不是行情价**：本链没有法币计价、没有预言机（03 §7.3）。
 */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  const fee = requireFee(feeBps);
  requireReserves(reserveIn, reserveOut);
  if (amountIn <= 0n) {
    throw new BacError("bad_amount", `amountIn 必须大于 0，收到 ${amountIn}`, "投入为 0 没有报价可言。");
  }
  const amountInWithFee = amountIn * (BPS - fee);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BPS + amountInWithFee;
  return numerator / denominator;
}

/**
 * 反向：想拿到 `amountOut`，至少要投多少。末尾 +1 是 Uniswap 的向上取整（少一 wei 就会 revert）。
 * `amountOut >= reserveOut` 时抛错：池子里就这么多，不可能全部换出来。
 */
export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  const fee = requireFee(feeBps);
  requireReserves(reserveIn, reserveOut);
  if (amountOut <= 0n) {
    throw new BacError("bad_amount", `amountOut 必须大于 0，收到 ${amountOut}`, "产出为 0 没有报价可言。");
  }
  if (amountOut >= reserveOut) {
    throw new BacError(
      "insufficient_liquidity",
      `想换出 ${amountOut}，但池子里只有 ${reserveOut}`,
      "恒定乘积池永远换不空：把数量调小，或者等有人加流动性。",
    );
  }
  const numerator = reserveIn * amountOut * BPS;
  const denominator = (reserveOut - amountOut) * (BPS - fee);
  return numerator / denominator + 1n;
}

/** 多跳路径的逐跳报价。`reserves[i]` 是第 i 跳的 [rIn, rOut]，`feesBps[i]` 是第 i 跳自己的费率。 */
export function getAmountsOut(amountIn: bigint, reserves: Array<[bigint, bigint]>, feesBps: number[]): bigint[] {
  if (reserves.length === 0) throw new BacError("bad_path", "路径是空的", "至少要有一跳。");
  if (feesBps.length !== reserves.length) {
    throw new BacError("bad_path", `${reserves.length} 跳却给了 ${feesBps.length} 个费率`,
      "每一跳的费率都要单独给：不同 agent 部署的池子费率可以不一样。");
  }
  const out: bigint[] = [amountIn];
  for (let i = 0; i < reserves.length; i++) {
    const hop = reserves[i]!;
    out.push(getAmountOut(out[i]!, hop[0], hop[1], feesBps[i]!));
  }
  return out;
}

/** 无手续费的等比换算（Uniswap 的 `quote()`）：加流动性时算另一边该配多少。 */
export function quoteLiquidity(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  requireReserves(reserveA, reserveB);
  if (amountA <= 0n) throw new BacError("bad_amount", `amountA 必须大于 0，收到 ${amountA}`, "投入为 0 没有配比可言。");
  return (amountA * reserveB) / reserveA;
}

/**
 * 加流动性时两边实际会被吃掉多少（V2 的 `_addLiquidity` 逻辑）。
 * 空池（两边储备为 0）就是你自己定的初始价格：**第一笔流动性定价**，写在返回的 `note` 里。
 */
export function quoteAddLiquidity(
  amountADesired: bigint, amountBDesired: bigint, reserveA: bigint, reserveB: bigint,
): { amountA: bigint; amountB: bigint; note: string } {
  if (reserveA === 0n && reserveB === 0n) {
    return { amountA: amountADesired, amountB: amountBDesired, note: "空池：这两个数的比值就是你定下的初始价格。" };
  }
  requireReserves(reserveA, reserveB);
  const bOptimal = quoteLiquidity(amountADesired, reserveA, reserveB);
  if (bOptimal <= amountBDesired) {
    return { amountA: amountADesired, amountB: bOptimal, note: "按 A 定量，B 按当前比例配。" };
  }
  const aOptimal = quoteLiquidity(amountBDesired, reserveB, reserveA);
  return { amountA: aOptimal, amountB: amountBDesired, note: "按 B 定量，A 按当前比例配。" };
}

/** 加流动性能拿到多少 LP 份额。首笔要扣掉 `MINIMUM_LIQUIDITY`（V2 是 1000，可传）。 */
export function quoteLiquidityMinted(
  amountA: bigint, amountB: bigint, reserveA: bigint, reserveB: bigint, totalSupply: bigint,
  minimumLiquidity = 1000n,
): bigint {
  if (totalSupply === 0n) {
    const root = sqrt(amountA * amountB);
    return root > minimumLiquidity ? root - minimumLiquidity : 0n;
  }
  requireReserves(reserveA, reserveB);
  const a = (amountA * totalSupply) / reserveA;
  const b = (amountB * totalSupply) / reserveB;
  return a < b ? a : b;
}

/** 整数平方根（巴比伦法），只为 quoteLiquidityMinted 服务。 */
export function sqrt(n: bigint): bigint {
  if (n < 0n) throw new BacError("bad_amount", "负数没有平方根", "检查传进来的数量。");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

/** 滑点：给一个报价加上容忍度。`dir = "min"` 用于 exact-in 的下限，`"max"` 用于 exact-out 的上限。 */
export function applySlippage(amount: bigint, slippageBps: number, dir: "min" | "max"): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new BacError("bad_slippage", `slippageBps 必须是 [0, 10000] 的整数，收到 ${String(slippageBps)}`,
      "100 = 1%。给 0 表示一分钱都不让，几乎一定会 revert。");
  }
  const s = BigInt(slippageBps);
  return dir === "min" ? (amount * (BPS - s)) / BPS : (amount * (BPS + s)) / BPS;
}

/**
 * 一笔成交的成交价，公式**逐字照抄 03 §7.3**，含义是 ×10^-18 的定点数：
 * `price_1_per_0 = amt1 × 10^(18+dec0) / (amt0 × 10^dec1)`。
 * `amt0 == 0` 或任一 decimals 未知 → `null`（不许默认当 18，03 §7.0 第 5 条）。
 */
export function price1Per0(amt0: bigint, amt1: bigint, dec0: number | null, dec1: number | null): bigint | null {
  if (amt0 === 0n || dec0 === null || dec1 === null) return null;
  return (amt1 * 10n ** BigInt(18 + dec0)) / (amt0 * 10n ** BigInt(dec1));
}

/** 反向价，按同一个公式现算（03 §7.3：存两个就会有两个不一致的真相）。 */
export function price0Per1(amt0: bigint, amt1: bigint, dec0: number | null, dec1: number | null): bigint | null {
  return price1Per0(amt1, amt0, dec1, dec0);
}

/**
 * 从一笔已经发生的成交反推费率（bps，向下取整）。
 * 用途：面对一个陌生 agent 部署的池子，不知道它收多少费时，拿它自己的一笔历史成交当标尺。
 * **这是估算**：它假设那笔成交就是标准 V2 公式，且储备是成交前的值；
 * 收税代币、带白名单的路由器、rebase 都会让它算歪。算完请用小额试一笔再放大。
 */
export function impliedFeeBps(amountIn: bigint, amountOut: bigint, reserveIn: bigint, reserveOut: bigint): number {
  requireReserves(reserveIn, reserveOut);
  if (amountIn <= 0n || amountOut <= 0n) {
    throw new BacError("bad_amount", "反推费率需要两边都大于 0", "换一笔正常的成交当标尺。");
  }
  for (let bps = 0; bps < 10_000; bps++) {
    if (getAmountOut(amountIn, reserveIn, reserveOut, bps) <= amountOut) return bps;
  }
  throw new BacError("no_fit", "没有任何 [0,10000) 的费率能解释这笔成交",
    "这个池子多半不是标准 V2 公式（可能是收税代币、或者自定义曲线）。别用这个报价去交易。");
}

/** 两个地址排序，得到 (token0, token1)。V2 的池子内部就是这么排的。 */
export function sortTokens(tokenA: string, tokenB: string): [string, string] {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  if (a === b) throw new BacError("same_token", "两个地址一样", "交易对的两边必须是不同的代币（03 §7.2.3 P2）。");
  return a < b ? [tokenA, tokenB] : [tokenB, tokenA];
}
