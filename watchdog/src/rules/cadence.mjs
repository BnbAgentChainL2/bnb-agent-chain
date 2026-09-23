// 规则 CADENCE —— 中继的活性：锚点迟到了多少个纪元。
//
// **这条规则永远不会跳闸，这是刻意的设计，不是遗漏。** 中继停了是可用性问题：退出会排队，
// 但没有一分钱被多放出去。这种时候去 `pause()` 只会把「退出慢」升级成「退出停」，
// 而且白白吃掉 21 天暂停额度里的一段 —— 额度耗尽本身会触发停机（触发 5）。
// 所以中继停摆只告警、只上报 webhook，由人来决定要不要动手。
//
// 反过来，锚点**早到**是不可能的：`postAnchor` 的检查 #4 要求纪元必须已经结束。
// 所以这里只有一个方向要看。

import { EPOCH, RULE } from '../constants.mjs';
import { ok, warn } from '../verdict.mjs';

/**
 * @param {object} i
 * @param {number} i.nowTs           当前时间戳（秒）
 * @param {number} i.lastPostedEpoch 链上 ChainAnchor.lastPostedEpoch()
 * @param {number} i.firstEpoch      这条链第一个可锚定的纪元
 * @param {number} i.warnAfterEpochs 迟到多少个纪元开始告警（默认 3 个 = 30 分钟）
 */
export function checkCadence(i) {
  const currentEpoch = Math.floor(i.nowTs / EPOCH);
  // 当前纪元还没结束，本来就不该被锚定，所以「应当已锚定的最后一个纪元」是 currentEpoch - 1。
  const due = currentEpoch - 1;
  const behind = Math.max(0, due - Number(i.lastPostedEpoch));
  const warnAfter = Number(i.warnAfterEpochs ?? 3);
  const compared = {
    nowTs: i.nowTs,
    currentEpoch,
    dueEpoch: due,
    lastPostedEpoch: Number(i.lastPostedEpoch),
    behindEpochs: behind,
    behindSeconds: behind * EPOCH,
    warnAfterEpochs: warnAfter,
    note: '活性问题不跳闸：暂停会把「退出慢」变成「退出停」，还会消耗 21 天的暂停额度',
  };
  if (behind >= warnAfter) {
    return warn(
      RULE.CADENCE,
      'global',
      `锚点落后 ${behind} 个纪元（约 ${behind * EPOCH} 秒）：链上最后一个是 ${Number(i.lastPostedEpoch)}，应当已经到 ${due}`,
      compared,
    );
  }
  return ok(RULE.CADENCE, 'global', `锚点进度正常，落后 ${behind} 个纪元`, compared);
}
