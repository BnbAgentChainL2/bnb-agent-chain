// outbox 发送器：03-INTERFACES.md §1.1 的五条纪律的唯一实现处。
//   1. 先落盘再推游标 —— 在 scan.mjs / index.mjs 里
//   2. 发送前用 eth_getTransactionReceipt 二次核对源日志仍在规范链上 —— verifySourceLog
//   3. **一次只发一笔**，await tx.wait(1) 之后才发下一笔，不做 nonce 管理器
//   4. 所有写操作靠链上的幂等键兜底（seen[depositId] / epoch == lastPostedEpoch + 1），重发是安全的
//   5. 60 秒未上链按 1.25 倍加价重发，最多 3 次；之后 parked（不阻塞后续 job）

import { OUTBOX_STATUS, SEND, WARN } from './constants.mjs';
import { getJobById, nextPending, parseJob, pendingList, setAnchorState, updateJob } from './db.mjs';
import { evaluateCredit } from './finality.mjs';
import { planNextAnchor } from './anchorMath.mjs';
import { log } from './log.mjs';

/**
 * 每种 job 的路由：走哪条链、怎么发、链上的幂等键怎么查。
 * @param {object} ctx
 */
function routeFor(ctx, job) {
  if (job.kind === 'credit') {
    return {
      chain: ctx.layer,
      label: 'credit',
      send: (j, opts) => ctx.layer.sendCredit(j, opts),
      alreadyDone: () => ctx.layer.seen(job.depositId),
      needsSourceCheck: true,
    };
  }
  if (job.kind === 'sync') {
    return {
      chain: ctx.layer,
      label: 'sync',
      send: (j, opts) => ctx.layer.sendSync(j, opts),
      alreadyDone: () => ctx.layer.syncApplied(job),
      needsSourceCheck: true,
    };
  }
  if (job.kind === 'anchor') {
    return {
      chain: ctx.bsc,
      label: 'anchor',
      send: (j, opts) => ctx.bsc.sendAnchor(j, opts),
      alreadyDone: async () => (await ctx.bsc.lastPostedEpoch()) >= job.epoch,
      needsSourceCheck: false, // 数据源是层内，QBFT 即时最终性，不可能孤块
    };
  }
  throw new Error(`未知 job kind: ${job.kind}`);
}


/**
 * 判定一条 job 现在能不能发。
 * @returns {Promise<{decision:'ready'|'wait'|'halt', reason:string, warnings:string[]}>}
 */
export async function gate(ctx, job) {
  if (job.kind === 'anchor') {
    const lastPosted = await ctx.bsc.lastPostedEpoch();
    if (lastPosted >= job.epoch) return { decision: 'done', reason: `链上 lastPostedEpoch=${lastPosted} 已覆盖`, warnings: [] };
    const prevState = job.epoch - 1 >= ctx.cfg.start.firstEpoch ? await ctx.bsc.anchorStateOf(job.epoch - 1) : 'NONE';
    const plan = planNextAnchor({
      lastPostedEpoch: lastPosted === 0 ? null : lastPosted,
      firstEpoch: ctx.cfg.start.firstEpoch,
      prevState,
      now: ctx.now(),
    });
    if (plan.action === 'wait') return { decision: 'wait', reason: plan.reason, warnings: [] };
    if (plan.epoch !== job.epoch) {
      // 顺序纪律：epoch 必须等于 lastPostedEpoch + 1，绝不跳号、绝不抢在前面。
      return { decision: 'wait', reason: `该发的是纪元 ${plan.epoch}，不是 ${job.epoch}`, warnings: [] };
    }
    return { decision: 'ready', reason: plan.reason, warnings: [] };
  }
  const r = evaluateCredit(ctx.snapshot, job, ctx.tracker);
  return { decision: r.decision, reason: r.reason, warnings: r.warnings, path: r.path };
}

/**
 * 发一笔并按纪律等待 / 加价重发。**这是唯一发交易的地方，调用方必须 await 它**。
 * @returns {Promise<'confirmed'|'parked'|'failed'>}
 */
export async function sendWithReprice(ctx, rowId, job, route) {
  let row = getJobById(ctx.db, rowId);
  let attempts = Number(row.attempts);
  let nonce = null;
  let gasPrice = await route.chain.feeGwei();

  while (attempts < SEND.MAX_ATTEMPTS) {
    attempts += 1;
    let sent;
    try {
      sent = await route.send(job, { nonce, gasPrice });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      // 发不出去（revert / 余额不足 / RPC 拒绝）：先看链上幂等键是不是已经满足了。
      if (await route.alreadyDone()) {
        updateJob(ctx.db, rowId, { status: OUTBOX_STATUS.CONFIRMED, attempts, lastError: msg }, ctx.now());
        log.info('链上幂等键已满足，无需重发', { rowId, kind: job.kind });
        return 'confirmed';
      }
      updateJob(ctx.db, rowId, { status: OUTBOX_STATUS.NEW, attempts, lastError: msg }, ctx.now());
      log.warn('发送失败', { rowId, kind: job.kind, attempts, err: msg });
      if (attempts >= SEND.MAX_ATTEMPTS) break;
      gasPrice = (gasPrice * SEND.BUMP_NUM) / SEND.BUMP_DEN;
      continue;
    }

    // 先把 tx_hash 落盘，再去等 —— 崩在等待中也能靠这条记录续传，不会重复发一笔新的。
    nonce = sent.nonce ?? nonce;
    updateJob(ctx.db, rowId, { status: OUTBOX_STATUS.SENT, txHash: sent.hash, attempts }, ctx.now());

    const receipt = await route.chain.waitMined(sent.hash, SEND.WAIT_MS);
    if (receipt && Number(receipt.status) === 1) {
      updateJob(ctx.db, rowId, { status: OUTBOX_STATUS.CONFIRMED, txHash: sent.hash, attempts }, ctx.now());
      log.info('已上链', { rowId, kind: job.kind, tx: sent.hash, attempts });
      return 'confirmed';
    }
    if (receipt && Number(receipt.status) === 0) {
      if (await route.alreadyDone()) {
        updateJob(ctx.db, rowId, { status: OUTBOX_STATUS.CONFIRMED, txHash: sent.hash, attempts, lastError: 'reverted but idempotency key already set' }, ctx.now());
        return 'confirmed';
      }
      updateJob(ctx.db, rowId, { status: OUTBOX_STATUS.FAILED, txHash: sent.hash, attempts, lastError: 'transaction reverted' }, ctx.now());
      log.error('交易被 revert', { rowId, kind: job.kind, tx: sent.hash });
      return 'failed';
    }
    // 60 秒没上链：同一个 nonce，1.25 倍加价重发（最多 3 次）。
    gasPrice = (gasPrice * SEND.BUMP_NUM) / SEND.BUMP_DEN;
    log.warn('60 秒未上链，加价重发', { rowId, kind: job.kind, attempts, nonce });
  }

  // 三次用尽：最后再查一次链上幂等键，确实没成才 park。
  if (await route.alreadyDone()) {
    updateJob(ctx.db, rowId, { status: OUTBOX_STATUS.CONFIRMED, attempts }, ctx.now());
    return 'confirmed';
  }
  updateJob(ctx.db, rowId, { status: OUTBOX_STATUS.PARKED, attempts, lastError: '连续 3 次未上链' }, ctx.now());
  ctx.warnings.add(WARN.OUTBOX_PARKED);
  log.error('job 已 parked（不阻塞后续 job，需要人工介入）', { rowId, kind: job.kind });
  return 'parked';
}

/**
 * 处理队列头部的一条。
 * @returns {Promise<'sent'|'skipped'|'halted'|'idle'>}
 */
export async function processRow(ctx, row) {
  const job = parseJob(row);
  const route = routeFor(ctx, job);

  // 已经在链上满足幂等键了？直接确认，不发第二笔。
  if (await route.alreadyDone()) {
    updateJob(ctx.db, row.id, { status: OUTBOX_STATUS.CONFIRMED }, ctx.now());
    if (job.kind === 'anchor') setAnchorState(ctx.db, job.epoch, 'posted', ctx.now(), row.tx_hash);
    return 'skipped';
  }

  const g = await gate(ctx, job);
  for (const w of g.warnings ?? []) ctx.warnings.add(w);
  if (g.decision === 'halt') {
    log.warn('停止发送（fail-closed）', { rowId: row.id, kind: job.kind, reason: g.reason });
    return 'halted';
  }
  if (g.decision === 'wait') {
    log.debug('尚未满足发送条件', { rowId: row.id, kind: job.kind, reason: g.reason });
    return 'skipped';
  }
  if (g.decision === 'done') {
    updateJob(ctx.db, row.id, { status: OUTBOX_STATUS.CONFIRMED }, ctx.now());
    return 'skipped';
  }

  // 发送前的二次核对（BSC 来源的 job 才有意义）。
  if (route.needsSourceCheck) {
    const v = await ctx.bsc.verifySourceLog(job.src);
    if (!v.ok) {
      updateJob(ctx.db, row.id, { status: OUTBOX_STATUS.ORPHANED, lastError: v.reason }, ctx.now());
      ctx.warnings.add(WARN.BSC_LOG_ORPHANED);
      log.error('源日志已不在规范链上，该 job 标记 orphaned，不发', { rowId: row.id, kind: job.kind, reason: v.reason });
      return 'skipped';
    }
    if (job.kind === 'credit' && g.path) {
      const payload = parseJob(getJobById(ctx.db, row.id));
      payload.src.finalizedAt = ctx.now();
      ctx.db.prepare('UPDATE outbox SET payload = ? WHERE id = ?').run(JSON.stringify(payload), row.id);
    }
  }

  const result = await sendWithReprice(ctx, row.id, job, route);
  if (job.kind === 'anchor' && result === 'confirmed') {
    const fresh = getJobById(ctx.db, row.id);
    setAnchorState(ctx.db, job.epoch, 'posted', ctx.now(), fresh.tx_hash);
  }
  return 'sent';
}

/**
 * 跑一轮队列。**严格一次一笔**：每条都 await 到底才看下一条。
 * 一条「还没到确认时间」的 job 会被跳过而不是堵住整条队列 —— 堵住的代价是
 * 锚点被一笔没确认够的存款拖过承诺窗口；而跳过是安全的，因为每条 job 的幂等键互相独立。
 * 真正「一条卡住」的情况由 `parked` 兜底（03 §1.5 的注释）。
 */
export async function drainOutbox(ctx, limit = 50) {
  const rows = pendingList(ctx.db, limit);
  let sent = 0;
  for (const row of rows) {
    const r = await processRow(ctx, row);
    if (r === 'halted') break;
    if (r === 'sent') sent += 1;
  }
  return { considered: rows.length, sent };
}

/**
 * 崩溃重启后的续传（03 §1.1 第 3/4 条 + 任务要求的「从 SQLite 游标恢复且不重复发送」）。
 *
 * 对每一条 status = 'sent' 的记录：
 *   ① 链上幂等键已满足 → confirmed（**不重发**）；
 *   ② 收据已存在且成功 → confirmed；
 *   ③ 都没有 → 退回 new，由正常队列重发（重发安全：链上幂等键兜底）。
 */
export async function resumePending(ctx) {
  const out = { confirmed: 0, requeued: 0 };
  const rows = ctx.db.prepare("SELECT * FROM outbox WHERE status = 'sent' ORDER BY id ASC").all();
  for (const row of rows) {
    const job = parseJob(row);
    const route = routeFor(ctx, job);
    if (await route.alreadyDone()) {
      updateJob(ctx.db, row.id, { status: OUTBOX_STATUS.CONFIRMED }, ctx.now());
      if (job.kind === 'anchor') setAnchorState(ctx.db, job.epoch, 'posted', ctx.now(), row.tx_hash);
      out.confirmed += 1;
      log.info('重启续传：链上已生效，标记 confirmed', { rowId: row.id, kind: job.kind });
      continue;
    }
    if (row.tx_hash) {
      const receipt = await route.chain.waitMined(row.tx_hash, 0);
      if (receipt && Number(receipt.status) === 1) {
        updateJob(ctx.db, row.id, { status: OUTBOX_STATUS.CONFIRMED }, ctx.now());
        out.confirmed += 1;
        continue;
      }
    }
    updateJob(ctx.db, row.id, { status: OUTBOX_STATUS.NEW, lastError: '重启时未确认，退回队列重发' }, ctx.now());
    out.requeued += 1;
    log.warn('重启续传：退回队列', { rowId: row.id, kind: job.kind, tx: row.tx_hash });
  }
  return out;
}

export { nextPending };
