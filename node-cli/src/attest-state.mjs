// 每纪元「承诺 → 等锚点 → 揭示」的时序状态机。
// 纯函数，不碰网络、不碰文件：attest 命令把观测到的事实喂进来，它只回答「现在该做什么」。
// 时序规则逐字来自 docs/02-CHAIN-SPEC.md §7.3、docs/01-CONTRACT-SPEC.md §6.2/§7。
//
//   纪元 N 结束（UTC 00:00）
//     → commitAttestation(N, commitment)   截止 (N+1)*86400 + COMMIT_WINDOW(2h)，合约是**严格小于**
//     → 官方 postAnchor(N)（最早也在同一时刻之后）
//     → revealAttestation(N, ...)          必须 state == POSTED 且在 postedAt + 24h 之内
//     → finalize(N) → settleEpochRewards(N) → claimReward(N, 我)
//
// 两条「宁可停，不可错」的硬规则：
//   1. 本地节点的头部时间戳没越过纪元边界之前，l2Block(N) 还没确定，**绝不承诺**；
//   2. 链上已有承诺但和本地 salt 记录对不上时，**绝不揭示**（揭示不符会吃 strike），只告警。

import { COMMIT_WINDOW, CHALLENGE_WINDOW, ANCHOR_OVERDUE_GRACE, EPOCH } from './constants.mjs';

/**
 * @typedef {Object} AttestCtx
 * @property {number}  now            当前秒级时间戳
 * @property {number}  epoch          正在处理的纪元
 * @property {number|null} headTs     本地层内节点头部区块的时间戳；null = 读不到
 * @property {boolean} committed      链上已有本地址对该纪元的承诺
 * @property {boolean} commitMatches  链上承诺 == 用本地 salt 重算的承诺（committed 为 false 时忽略）
 * @property {boolean} hasSalt        本地还留着这个纪元的 salt 与三元组
 * @property {boolean} revealed       链上已揭示
 * @property {'NONE'|'POSTED'|'FINAL'|'VETOED'|'DISPUTED'} anchorState
 * @property {number}  postedAt       锚点 POSTED 的时间戳（无则 0）
 * @property {boolean} claimed        该纪元的奖励已领
 */

/**
 * @param {AttestCtx} ctx
 * @returns {{action: string, severity: 'info'|'warn'|'fail', zh: string,
 *            deadlineAt: number|null, nextCheckAt: number|null}}
 */
export function nextAction(ctx) {
  const epochEnd = (Number(ctx.epoch) + 1) * EPOCH;
  const commitDeadline = epochEnd + COMMIT_WINDOW;
  const mk = (action, severity, zh, deadlineAt = null, nextCheckAt = null) =>
    ({ action, severity, zh, deadlineAt, nextCheckAt });

  // 1) 纪元还没结束
  if (ctx.now < epochEnd) {
    return mk('wait_epoch_end', 'info',
      `纪元 ${ctx.epoch} 还没结束，等到边界再算`, commitDeadline, epochEnd);
  }

  // 2) 还没承诺
  if (!ctx.committed) {
    if (ctx.now >= commitDeadline) {
      return mk('commit_missed', 'warn',
        `纪元 ${ctx.epoch} 的承诺窗口已过（截止 ${commitDeadline}），这一纪元没有见证，也拿不到奖励。`
        + ' 不是错误，但连续错过就该查节点为什么没跑起来', commitDeadline, null);
    }
    if (ctx.headTs === null) {
      return mk('wait_sync', 'warn',
        '读不到本地层内节点的头部区块：先修 RPC，再谈承诺', commitDeadline, ctx.now + 60);
    }
    if (ctx.headTs < epochEnd) {
      return mk('wait_sync', 'info',
        `本地节点还没追到纪元边界（头部时间戳 ${ctx.headTs} < ${epochEnd}）：`
        + 'l2Block 此刻不确定，等追上再承诺。宁可停，不可错', commitDeadline, ctx.now + 30);
    }
    return mk('commit', 'info',
      `可以承诺纪元 ${ctx.epoch}`, commitDeadline, null);
  }

  // 3) 已承诺，但本地 salt 丢了或对不上 —— 绝不乱揭示
  if (!ctx.hasSalt) {
    return mk('salt_missing', 'fail',
      `链上有纪元 ${ctx.epoch} 的承诺，但本地找不到对应的 salt：无法揭示，这一纪元拿不到奖励。`
      + ' 不要猜一个 salt 去试，揭示不符会记一次 strike', null, null);
  }
  if (!ctx.commitMatches) {
    return mk('commit_mismatch', 'fail',
      `链上纪元 ${ctx.epoch} 的承诺和本地记录算出来的不一致：`
      + '多半是同一个私钥在两台机器上各跑了一份 attest。先停掉其中一台，再人工确认要揭示哪一份',
      null, null);
  }

  // 4) 已承诺，看锚点
  switch (ctx.anchorState) {
    case 'NONE': {
      if (ctx.now >= commitDeadline + ANCHOR_OVERDUE_GRACE) {
        return mk('anchor_overdue', 'warn',
          `纪元 ${ctx.epoch} 的锚点迟发：承诺窗口 ${commitDeadline} 早就过了，链上还是 NONE。`
          + ' 继续等，同时该去问官方（这条线和服务器的告警线是同一条）', null, ctx.now + 300);
      }
      return mk('wait_anchor', 'info',
        `等官方发纪元 ${ctx.epoch} 的锚点（最早 ${commitDeadline}）`, null, commitDeadline + 60);
    }
    case 'POSTED': {
      const revealDeadline = Number(ctx.postedAt) + CHALLENGE_WINDOW;
      if (ctx.revealed) {
        return mk('wait_finalize', 'info',
          `纪元 ${ctx.epoch} 已揭示，等挑战窗口结束后 finalize（${revealDeadline}）`, revealDeadline, revealDeadline);
      }
      if (ctx.now >= revealDeadline) {
        return mk('reveal_missed', 'warn',
          `纪元 ${ctx.epoch} 的揭示窗口已过（${revealDeadline}）：承诺白做了，这一纪元没有权重也没有奖励`,
          revealDeadline, null);
      }
      return mk('reveal', 'info',
        `可以揭示纪元 ${ctx.epoch}（截止 ${revealDeadline}）`, revealDeadline, null);
    }
    case 'FINAL': {
      if (!ctx.revealed) {
        return mk('done_not_revealed', 'warn',
          `纪元 ${ctx.epoch} 已定案，但本地没有揭示记录：这一纪元没有奖励`, null, null);
      }
      if (ctx.claimed) return mk('done', 'info', `纪元 ${ctx.epoch} 已定案、已领奖`, null, null);
      return mk('claimable', 'info',
        `纪元 ${ctx.epoch} 已定案，可以 settleEpochRewards + claimReward（30 天内不领会被 sweepExpired 退回奖池）`,
        null, null);
    }
    case 'VETOED':
      return mk('skip_vetoed', 'warn',
        `纪元 ${ctx.epoch} 被否决：不释放任何 BNB，也没有奖励。`
        + ' 这一纪元的退出叶子会并入下一个锚点重报（叶子不变，照样能证明）', null, null);
    case 'DISPUTED':
      return mk('skip_disputed', 'warn',
        `纪元 ${ctx.epoch} 被打成 DISPUTED：不释放、不结算。`
        + ' 30 个纪元内累计 3 次会武装逃生通道，这是见证机制在起作用，不是故障', null, null);
    default:
      return mk('unknown_anchor_state', 'fail',
        `锚点状态 ${ctx.anchorState} 不在已知的五个之内，停下来人工看`, null, null);
  }
}

/** 该动作是不是要发一笔 BSC 交易 */
export function isTxAction(action) { return action === 'commit' || action === 'reveal'; }

/** 这个纪元还有没有后续动作（用于 attest --once 决定要不要继续往下一个纪元看） */
export function isTerminal(action) {
  return ['commit_missed', 'reveal_missed', 'done', 'skip_vetoed', 'skip_disputed',
          'done_not_revealed', 'salt_missing', 'commit_mismatch'].includes(action);
}
