// 规则 BUYBACK —— 每一笔回购 vs 它自己的滑点上限与单次上限。
//
// 合约自己已经带了一道硬闸（`BacBridge.buyback`：`require(bought >= floorOut)`，
// `floorOut = expectedGross × (1e4 − buyTax) × (1e4 − MAX_BUY_SLIPPAGE_BPS) / 1e8`）。
// 那么看门狗还看什么？看**合约自己算的参考价对不对**：`expectedGross` 来自 Flap Portal 的
// `getTokenV8Safe` 或 PancakeSwap 的 `getAmountsOut`，两者都是**当笔交易里**读的现货价，
// 一个被三明治夹住的区块可以让它先被推高，于是 floorOut 本身就是被污染的数，
// 这一关「过了」也不代表买得不亏。看门狗在**交易前一个区块**独立再读一次参考价，
// 用没被这笔交易影响过的价格复算 floorOut，然后和真实成交量比。
//
// 现实约束（必须照实说）：读交易前一个区块的状态需要归档节点，公共 BSC RPC 基本都没有。
// 读不到时这一项一律 **SKIP**，绝不跳闸 —— 猜一个参考价然后冻结一座桥是最糟的组合。
// 读不到的时候仍然有两项**不需要历史状态**的硬检查在跑，它们才是这条规则的地板：
//   ① 单次 BNB 花费必须落在 [MIN_BUYBACK_BNB, MAX_BUYBACK_BNB] 内；
//   ② 买到的 BAC 不能为 0。
// 这两项任何一项不成立，都说明链上那个合约不是我们审过的那一份。

import { MAX_BUYBACK_BNB, MAX_BUY_SLIPPAGE_BPS, MIN_BUYBACK_BNB, RULE } from '../constants.mjs';
import { critical, ok, skip, warn } from '../verdict.mjs';

const BPS = 10000n;

/**
 * @param {object} i
 * @param {object} i.event { txHash, blockNumber, by, venue, bnbSpent, bacBought, buybackBacAfter }
 * @param {?object} i.reference 交易前一个区块上独立读到的参考价：
 *        { expectedGross: bigint, buyTaxBps: bigint, venue: number, at: number } —— 读不到给 null
 * @param {bigint} i.toleranceBps 我们的参考读在另一个区块上，给它留的额外余量
 * @param {?Array<{bnbSpent:bigint,bacBought:bigint}>} i.history 最近若干笔回购，用于「这一笔比平时贵得离谱」的软检查
 */
export function checkBuyback(i) {
  const e = i.event;
  const spent = BigInt(e.bnbSpent);
  const bought = BigInt(e.bacBought);
  const tolBps = BigInt(i.toleranceBps ?? 0n);
  const compared = {
    txHash: e.txHash,
    blockNumber: e.blockNumber,
    by: e.by,
    venue: Number(e.venue),
    bnbSpent: spent,
    bacBought: bought,
    bounds: { min: MIN_BUYBACK_BNB, max: MAX_BUYBACK_BNB },
    contractMaxSlippageBps: MAX_BUY_SLIPPAGE_BPS,
    watchdogToleranceBps: tolBps,
  };

  // ------------------------------------------------- 不需要历史状态的两项硬检查
  if (spent > MAX_BUYBACK_BNB) {
    return critical(
      RULE.BUYBACK,
      e.txHash,
      `单笔回购花了 ${spent} wei BNB，超过合约写死的 MAX_BUYBACK_BNB ${MAX_BUYBACK_BNB}。链上那份合约不是我们审过的那一份`,
      compared,
    );
  }
  if (spent < MIN_BUYBACK_BNB) {
    return critical(
      RULE.BUYBACK,
      e.txHash,
      `单笔回购只花了 ${spent} wei BNB，低于合约写死的 MIN_BUYBACK_BNB ${MIN_BUYBACK_BNB}`,
      compared,
    );
  }
  if (bought === 0n) {
    return critical(RULE.BUYBACK, e.txHash, `回购花了 ${spent} wei BNB 却一个 BAC 都没买到`, compared);
  }

  // --------------------------------------------------------- 独立复算参考价
  if (!i.reference) {
    const soft = softPriceCheck(i, compared);
    if (soft) return soft;
    return skip(
      RULE.BUYBACK,
      e.txHash,
      `读不到交易前一个区块的参考价（需要归档节点），只完成了上下限检查。花 ${spent} 买到 ${bought}`,
      { ...compared, referenceAvailable: false },
    );
  }

  const ref = i.reference;
  const gross = BigInt(ref.expectedGross);
  const tax = BigInt(ref.buyTaxBps);
  // 合约自己那条闸，用**没被这笔交易影响过的**价格重算一遍
  const floorOut = (gross * (BPS - tax) * (BPS - MAX_BUY_SLIPPAGE_BPS)) / (BPS * BPS);
  // 再放宽我们自己的容差（参考读在另一个区块上，价格本来就会动）
  const floorWithTol = (floorOut * (BPS - tolBps)) / BPS;
  const afterTax = (gross * (BPS - tax)) / BPS;
  const realizedSlippageBps = afterTax === 0n ? null : BPS - (bought * BPS) / afterTax;

  const full = {
    ...compared,
    referenceAvailable: true,
    reference: { at: ref.at, venue: Number(ref.venue ?? e.venue), expectedGross: gross, buyTaxBps: tax },
    expectedAfterTax: afterTax,
    contractFloor: floorOut,
    watchdogFloor: floorWithTol,
    realizedSlippageBps,
  };

  if (bought < floorWithTol) {
    return critical(
      RULE.BUYBACK,
      e.txHash,
      `回购成交量 ${bought} 低于用交易前区块 ${ref.at} 的价格复算的下限 ${floorWithTol}（合约自己的下限 ${floorOut}，实测滑点 ${realizedSlippageBps} bps）`,
      full,
    );
  }
  return ok(
    RULE.BUYBACK,
    e.txHash,
    `回购花 ${spent} wei BNB 买到 ${bought} BAC，实测滑点 ${realizedSlippageBps} bps，在上限内`,
    full,
  );
}

/**
 * 没有归档节点时的软检查：这一笔的单价比最近 N 笔的中位数差多少。
 * **永远只到 WARN**。单价本来就会随行情走，把它做成跳闸条件等于把「币价跌了」当成「桥被偷了」。
 */
function softPriceCheck(i, compared) {
  const h = (i.history ?? []).filter((x) => BigInt(x.bnbSpent) > 0n && BigInt(x.bacBought) > 0n);
  if (h.length < 5) return null;
  // 单价用 BAC per 1e18 wei BNB 表示，整数运算，不引入浮点
  const unit = (x) => (BigInt(x.bacBought) * 10n ** 18n) / BigInt(x.bnbSpent);
  const rates = h.map(unit).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = rates[Math.floor(rates.length / 2)];
  const mineRate = (BigInt(compared.bacBought) * 10n ** 18n) / BigInt(compared.bnbSpent);
  if (median === 0n) return null;
  const ratioBps = (mineRate * BPS) / median;
  const full = { ...compared, referenceAvailable: false, softCheck: { samples: h.length, median, thisRate: mineRate, ratioBps } };
  // 比中位数差 3 倍以上：可能是被夹了，也可能是币价真的涨了 3 倍。只说，不动手。
  if (ratioBps < 3333n) {
    return warn(
      RULE.BUYBACK,
      compared.txHash,
      `这笔回购的单价只有最近 ${h.length} 笔中位数的 ${ratioBps} / 10000。没有归档节点无法确认是被夹还是行情，**不跳闸**，请人工看一眼`,
      full,
    );
  }
  return null;
}
