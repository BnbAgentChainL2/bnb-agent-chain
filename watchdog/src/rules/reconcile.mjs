// 规则 RECONCILE —— 层内与 BSC 的对账恒等式（docs/03-INTERFACES.md §3.1 的 diff，逐字）。
//
//   diff = (bscTotalIssued − bscTotalExited)
//        − (layerCirculating + balance(FeeSink) + balance(FeeSplitter) + Σ balance(v) for v in everValidator)
//   其中 layerCirculating = 1e27 − B_bridge − B_sink − B_signer
//
// **这条规则只往一个方向跳闸，理由必须写清楚，否则它会变成一条每天误报的噪音：**
//
// diff < 0 ＝ 层内的钱比 BSC 上锁进来的多 ＝ 超发。没有任何良性解释，跳闸。
// diff > 0 ＝ BSC 那边多，层内那边少。三件**必然发生**的正常事都会把它推正：
//   ① 在途存款：BSC 上 `lock()` 已经上链，层内 `credit` 还没落（入场约 1 分钟）；
//   ② 在途退出：层内已经 `ExitBurned`，BSC 上还没 `claimExit`（约 12–13 分钟）；
//   ③ everValidator 表没列全：某个历史出块者的小费没被加进右边。
// 所以正方向只告警、永不跳闸，并且把可解释的额度（在途存款 + 在途退出）显式扣掉，
// 让告警门槛是「超出可解释额度的那部分」而不是「diff 不为 0」。
//
// 反方向也有一个良性来源必须扣掉：两条链的读数不可能在同一瞬间。两次读之间发生的
// `claimExit` 会让 `bscTotalExited` 先涨、层内那边还没动，diff 当场变负。所以负方向的
// 容差里带上「最近 skew 窗口内 BSC 上已领取的退出积分」。

import { LAYER_TOTAL_SUPPLY, RULE } from '../constants.mjs';
import { critical, ok, warn } from '../verdict.mjs';

/**
 * @param {object} i
 * @param {bigint} i.bscTotalIssued
 * @param {bigint} i.bscTotalExited
 * @param {bigint} i.bridgeBalance   层内 L2Bridge 的余额
 * @param {bigint} i.feeSinkBalance
 * @param {bigint} i.signerBalance   官方出块者 EOA
 * @param {bigint} i.feeSplitterBalance
 * @param {Array<{addr:string,balance:bigint}>} i.validatorBalances everValidator 表逐个读
 * @param {bigint} i.inflightCredits BSC 上已 lock、层内 `seen()` 仍为 false 的积分之和
 * @param {bigint} i.inflightExits   层内已 ExitBurned、BSC 上还没 claimExit 的积分之和
 * @param {bigint} i.skewExits       读数偏斜窗口内 BSC 上已领取的退出积分（负方向容差）
 * @param {bigint} i.toleranceWei    额外的绝对容差
 * @param {object} i.at              { bscBlock, layerBlock } 两个读数各自钉在哪个区块上
 */
export function checkReconcile(i) {
  const validatorSum = (i.validatorBalances ?? []).reduce((a, v) => a + BigInt(v.balance), 0n);
  const layerCirculating = LAYER_TOTAL_SUPPLY - i.bridgeBalance - i.feeSinkBalance - i.signerBalance;
  const left = i.bscTotalIssued - i.bscTotalExited;
  const right = layerCirculating + i.feeSinkBalance + i.feeSplitterBalance + validatorSum;
  const diff = left - right;

  const tol = BigInt(i.toleranceWei ?? 0n);
  const explainedPositive = BigInt(i.inflightCredits ?? 0n) + BigInt(i.inflightExits ?? 0n) + tol;
  const explainedNegative = BigInt(i.skewExits ?? 0n) + tol;

  const compared = {
    formula:
      'diff = (bscTotalIssued - bscTotalExited) - (layerCirculating + feeSink + feeSplitter + sum(validators)); layerCirculating = 1e27 - B_bridge - B_sink - B_signer',
    at: i.at ?? null,
    bscTotalIssued: i.bscTotalIssued,
    bscTotalExited: i.bscTotalExited,
    bridgeBalance: i.bridgeBalance,
    feeSinkBalance: i.feeSinkBalance,
    signerBalance: i.signerBalance,
    feeSplitterBalance: i.feeSplitterBalance,
    validatorBalances: (i.validatorBalances ?? []).map((v) => ({ addr: v.addr, balance: BigInt(v.balance) })),
    layerCirculating,
    left,
    right,
    diff,
    inflightCredits: BigInt(i.inflightCredits ?? 0n),
    inflightExits: BigInt(i.inflightExits ?? 0n),
    skewExits: BigInt(i.skewExits ?? 0n),
    explainedPositive,
    explainedNegative,
  };

  if (diff < 0n && -diff > explainedNegative) {
    return critical(
      RULE.RECONCILE,
      'global',
      `对账恒等式为负 ${diff}：层内的积分比 BSC 上锁定的多，超出可解释的读数偏斜 ${explainedNegative}。这只有超发一种解释`,
      compared,
    );
  }
  if (diff > explainedPositive) {
    return warn(
      RULE.RECONCILE,
      'global',
      `对账差额 ${diff} 超出在途额度 ${explainedPositive}（在途存款 ${compared.inflightCredits} + 在途退出 ${compared.inflightExits}）。正方向不跳闸，但需要人看一眼 everValidator 表是否列全`,
      compared,
    );
  }
  return ok(RULE.RECONCILE, 'global', `对账差额 ${diff}，落在可解释区间内`, compared);
}
