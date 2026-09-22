// 方向 A 的确认状态机（03-INTERFACES.md §1.2）。
// 这里全是**纯函数**：输入一个快照，输出「发 / 等 / 停」。所有网络读取都在 chains.mjs 里，
// 这样每一条 fail-closed 分支都能被单元测试逐条打到，不需要网络。

import { CONFIRM, WARN } from './constants.mjs';

/**
 * 一次 BSC 侧的确认快照。
 * @typedef {object} FinalitySnapshot
 * @property {number} ts            当前墙钟（秒）
 * @property {number|null} headA    BSC_RPC 的 head 块号
 * @property {number|null} headB    BSC_RPC_2 的 head 块号
 * @property {{number:number,hash:string}|null} finalizedA  BSC_RPC 的 finalized 区块
 * @property {{number:number,hash:string}|null} finalizedB  BSC_RPC_2 的 finalized 区块
 * @property {'agree'|'disagree'|'unknown'} crossCheck
 *   两个 RPC 在**同一个高度**（取两边 finalized 的较小者）上的区块哈希是否一致。
 *   一致才算「两个独立 RPC 给出一致的 finalized」；不一致说明至少一边在另一条链上。
 */

/**
 * finalized 这一路是否可用：两边都给出了 finalized，且在共同高度上是同一条链。
 * 任何一条不满足都算 unavailable —— 单一 RPC 是一个没被信任模型列出的受信方（03 §1.2）。
 */
export function finalityAvailable(snap) {
  return Boolean(snap.finalizedA && snap.finalizedB && snap.crossCheck === 'agree');
}

/**
 * 连续不可用时长的跟踪器。它只有一个状态：`outageSince`（秒）。
 * 进程重启后从 null 开始重新计时 —— 这是**保守方向**：重启后最多多等 10 分钟才停，
 * 而不会因为忘了历史就放松门槛（门槛本身全在下面的 evaluate 里，与这个状态无关）。
 */
export class FinalityTracker {
  constructor() {
    /** @type {number|null} 连续不可用的起点秒；可用时为 null */
    this.outageSince = null;
    /** @type {'agree'|'disagree'|'unknown'} 最近一次的交叉核对结果 */
    this.lastCrossCheck = 'unknown';
  }

  /** 吞进一个快照，更新不可用计时。返回本次是否可用。 */
  update(snap) {
    this.lastCrossCheck = snap.crossCheck;
    const ok = finalityAvailable(snap);
    if (ok) this.outageSince = null;
    else if (this.outageSince === null) this.outageSince = snap.ts;
    return ok;
  }

  /** 已经连续不可用了多少秒（可用时为 0） */
  outageSec(ts) {
    return this.outageSince === null ? 0 : Math.max(0, ts - this.outageSince);
  }

  /**
   * 是否已经到了「停止发 credit」的地步：连续 10 分钟取不到一致的 finalized。
   * 这是 fail-closed 的核心：credit 迟到几分钟只是体验问题，credit 发错不可恢复。
   */
  halted(ts) {
    return this.outageSec(ts) >= CONFIRM.OUTAGE_HALT_SEC;
  }
}

/**
 * 判定一条 CreditJob 能不能发。
 *
 * 三条同时满足才走 finalized 这一路：
 *   ① 两个独立 RPC 一致的 finalized 已覆盖该区块；② 深度 >= 15；③ 距首次看见 >= 45 秒。
 * finalized 取不到时走兜底（**不是更弱的条件，是显著更保守的条件**）：深度 >= 1200 **且** >= 600 秒。
 * 连续 10 分钟取不到 finalized：不管深度多少，一律停发并打 `bsc_finality_unavailable`。
 *
 * @param {FinalitySnapshot} snap
 * @param {{src:{blockNumber:number, seenAt:number}}} job
 * @param {FinalityTracker} tracker 已经 update 过本快照的跟踪器
 * @returns {{decision:'ready'|'wait'|'halt', path:'finalized'|'fallback'|null, reason:string, warnings:string[]}}
 */
export function evaluateCredit(snap, job, tracker) {
  const ts = snap.ts;
  const blockNumber = job.src.blockNumber;
  const seenAt = job.src.seenAt;
  const heads = [snap.headA, snap.headB].filter((h) => typeof h === 'number');
  // 深度用两个 RPC 里**较小**的 head 算：一个 RPC 领先不能替另一个背书。
  const head = heads.length ? Math.min(...heads) : null;
  const depth = head === null ? -1 : head - blockNumber;
  const age = ts - seenAt;
  const warnings = [];

  if (tracker.lastCrossCheck === 'disagree') warnings.push(WARN.BSC_FINALITY_DISAGREEMENT);

  if (finalityAvailable(snap)) {
    // 覆盖判定同样取两边较小的 finalized 高度。
    const finalized = Math.min(snap.finalizedA.number, snap.finalizedB.number);
    if (finalized < blockNumber) {
      return { decision: 'wait', path: null, reason: `finalized(${finalized}) 尚未覆盖区块 ${blockNumber}`, warnings };
    }
    if (depth < CONFIRM.DEPTH) {
      return { decision: 'wait', path: null, reason: `深度 ${depth} < ${CONFIRM.DEPTH}`, warnings };
    }
    if (age < CONFIRM.WALL_SEC) {
      return { decision: 'wait', path: null, reason: `距首次看见 ${age}s < ${CONFIRM.WALL_SEC}s`, warnings };
    }
    return { decision: 'ready', path: 'finalized', reason: '三条确认条件全部满足', warnings };
  }

  // ---- finalized 取不到（或两个 RPC 对不上）----
  if (tracker.halted(ts)) {
    warnings.push(WARN.BSC_FINALITY_UNAVAILABLE);
    return {
      decision: 'halt',
      path: null,
      reason: `连续 ${tracker.outageSec(ts)}s 取不到一致的 finalized，已停止发 credit（宁可停，不可错）`,
      warnings,
    };
  }
  if (depth < CONFIRM.FALLBACK_DEPTH) {
    return { decision: 'wait', path: null, reason: `兜底深度 ${depth} < ${CONFIRM.FALLBACK_DEPTH}`, warnings };
  }
  if (age < CONFIRM.FALLBACK_WALL_SEC) {
    return { decision: 'wait', path: null, reason: `兜底墙钟 ${age}s < ${CONFIRM.FALLBACK_WALL_SEC}s`, warnings };
  }
  return { decision: 'ready', path: 'fallback', reason: '兜底门槛（1200 块 + 600 秒）满足', warnings };
}

/**
 * 方向 C（状态镜像）用同一套判定。
 * 理由：它同样以 BSC 日志为来源，同样会被重组打穿；它改的是层内 `L2Gate` 的准入状态，
 * 发错会让一个被 ban 的 agent 继续发公告、或让一个正常 agent 被挡在 AgentBook 外面。
 * 退出（`L2Bridge.exit`）永远不看 status，所以这条判定不会影响任何人取钱。
 */
export const evaluateSync = evaluateCredit;
