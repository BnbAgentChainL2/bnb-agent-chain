// 规则 RELEASE_CAP —— 释放率 vs 每天 2%–5% 的上限。
//
// 决策 #21 / #25a 说得很清楚：2 分钟等待之后，**真正的闸门只剩两道**，一道是暂停开关，
// 另一道就是这条每天最多放 2%–5%。所以看门狗必须独立地、不看中继也不看索引器地，
// 自己算一遍每一笔 `settleEpoch` 放出来的 `pot` 有没有超。
//
// 合约里的算式（BacBridge.settleEpoch，逐字）：
//     pot = ((buybackBac − reservedTotal) × bps) / (10000 × EPOCHS_PER_DAY)
//     pot = min(pot, owedTotal − reservedTotal)                     ← 债权不够时的封顶
//     pot = min(pot, buybackBac × 1500/10000 − releasedInWindow)    ← 零见证的 30 天窗口
// 三道封顶都只会**把 pot 变小**，所以看门狗只需要检查一个方向：`pot` 有没有超过第一条式子。
// 超了，就说明要么合约被换了，要么 `bps` 不是链上那三档之一 —— 两种都是必须立刻暂停的事。
//
// `buybackBac` / `reservedTotal` 的「交易前值」从**看门狗自己的影子账本**（SQLite 里的
// `ledger` 表，由事件流维护）读，不依赖归档节点。影子账本还没建立起来（首次启动、或中间
// 漏过一段）时，这条规则返回 SKIP —— 用一个自己都不确定的基数去冻结一座桥是不能接受的。

import { EPOCHS_PER_DAY, RELEASE_DAILY_BPS_SET, RULE } from '../constants.mjs';
import { critical, ok, skip, warn } from '../verdict.mjs';

const BPS = 10000n;

/**
 * 单个纪元的释放额。
 * @param {object} i
 * @param {object} i.event { epoch, pot, owedTotalAfter, releaseBps, skipped, txHash, blockNumber }
 * @param {?object} i.before 交易前的影子账本 { buybackBac, reservedTotal, owedTotal }（没有就给 null）
 * @param {bigint} i.toleranceBps
 */
export function checkEpochRelease(i) {
  const e = i.event;
  const pot = BigInt(e.pot);
  const bps = BigInt(e.releaseBps);
  const compared = {
    epoch: Number(e.epoch),
    txHash: e.txHash ?? null,
    pot,
    releaseBps: bps,
    skipped: !!e.skipped,
    epochsPerDay: BigInt(EPOCHS_PER_DAY),
    allowedBps: RELEASE_DAILY_BPS_SET,
  };

  if (e.skipped) {
    return ok(RULE.RELEASE_CAP, `epoch:${e.epoch}`, `纪元 ${e.epoch} 被跳过（未定案或被否决），pot = 0`, compared);
  }
  // bps 必须是链上那三档之一。别的值只可能来自一个不是 ChainAnchor 的东西。
  if (!RELEASE_DAILY_BPS_SET.some((x) => x === bps)) {
    return critical(
      RULE.RELEASE_CAP,
      `epoch:${e.epoch}`,
      `纪元 ${e.epoch} 的 releaseBps = ${bps}，不是链上三档 200 / 350 / 500 中的任何一个`,
      compared,
    );
  }
  if (!i.before) {
    return skip(
      RULE.RELEASE_CAP,
      `epoch:${e.epoch}`,
      `纪元 ${e.epoch} 的 pot = ${pot}，但看门狗的影子账本还没覆盖这个区间，无法独立复算上限`,
      compared,
    );
  }

  const free = i.before.buybackBac - i.before.reservedTotal;
  const cap = free <= 0n ? 0n : (free * bps) / (BPS * BigInt(EPOCHS_PER_DAY));
  const tol = BigInt(i.toleranceBps ?? 0n);
  const capWithTol = cap + (cap * tol) / BPS + 1n; // +1 wei 吸收整除的取整
  const full = {
    ...compared,
    before: { buybackBac: i.before.buybackBac, reservedTotal: i.before.reservedTotal, owedTotal: i.before.owedTotal },
    free,
    cap,
    capWithTolerance: capWithTol,
    formula: 'cap = (buybackBac - reservedTotal) * releaseBps / (10000 * 144)',
  };

  if (pot > capWithTol) {
    return critical(
      RULE.RELEASE_CAP,
      `epoch:${e.epoch}`,
      `纪元 ${e.epoch} 释放了 ${pot}，超过按链上算式复算的上限 ${cap}（含容差 ${capWithTol}）`,
      full,
    );
  }
  return ok(RULE.RELEASE_CAP, `epoch:${e.epoch}`, `纪元 ${e.epoch} 释放 ${pot}，上限 ${cap}，未超`, full);
}

/**
 * 滚动 24 小时的释放总额。单纪元每一笔都合规，仍然可能因为 `bps` 被拉到最高档而让
 * 一天的总量超过当初写在文案里的「每天最多 2%–5%」。基数取窗口内观察到的**最大**
 * `buybackBac`（对桥最有利的读法），这样一个正在增长的桶不会制造误报。
 *
 * @param {object} i
 * @param {number} i.windowSec
 * @param {bigint} i.released  窗口内 pot 之和
 * @param {bigint} i.baseMax   窗口内观察到的最大 buybackBac
 * @param {bigint} i.maxDailyBps 窗口内出现过的最高一档 bps
 * @param {bigint} i.toleranceBps
 * @param {number} i.samples   窗口内记到的纪元数（太少就只告警）
 */
export function checkRollingRelease(i) {
  const cap = (BigInt(i.baseMax) * BigInt(i.maxDailyBps)) / BPS;
  const tol = BigInt(i.toleranceBps ?? 0n);
  const capWithTol = cap + (cap * tol) / BPS + BigInt(i.samples ?? 0);
  const compared = {
    windowSec: i.windowSec,
    samples: i.samples ?? 0,
    released: BigInt(i.released),
    baseMax: BigInt(i.baseMax),
    maxDailyBps: BigInt(i.maxDailyBps),
    cap,
    capWithTolerance: capWithTol,
    formula: 'cap = max(buybackBac in window) * maxDailyBps / 10000',
  };
  if (BigInt(i.baseMax) === 0n) {
    return ok(RULE.RELEASE_CAP, 'rolling', '回购桶还是空的，没有可释放的额度', compared);
  }
  if (BigInt(i.released) > capWithTol) {
    return critical(
      RULE.RELEASE_CAP,
      'rolling',
      `滚动 ${i.windowSec} 秒内共释放 ${BigInt(i.released)}，超过每天上限 ${cap}（含容差 ${capWithTol}）`,
      compared,
    );
  }
  // 逼近上限本身不是错，但值得在人还醒着的时候说一声。
  if (BigInt(i.released) * 10n > cap * 9n) {
    return warn(
      RULE.RELEASE_CAP,
      'rolling',
      `滚动 ${i.windowSec} 秒内已释放 ${BigInt(i.released)}，达到每天上限 ${cap} 的 90% 以上`,
      compared,
    );
  }
  return ok(RULE.RELEASE_CAP, 'rolling', `滚动 ${i.windowSec} 秒内释放 ${BigInt(i.released)}，上限 ${cap}`, compared);
}
