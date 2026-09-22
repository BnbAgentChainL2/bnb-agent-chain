// 发送器：二次核对、幂等、加价重发、parked、重启续传（模拟发送中途崩溃）。

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { OUTBOX_STATUS, SEND, WARN } from '../src/constants.mjs';
import { commitWindowEndsAt, epochEndsAt } from '../src/anchorMath.mjs';
import { enqueue, getJob, getJobById, putAnchor, updateJob } from '../src/db.mjs';
import { FinalityTracker } from '../src/finality.mjs';
import { creditJobFrom } from '../src/scan.mjs';
import { drainOutbox, processRow, resumePending } from '../src/sender.mjs';
import { ADDR, FakeBsc, FakeLayer, fakeCfg, tmpDb } from './fakes.mjs';

const E = 20700;
const T = commitWindowEndsAt(E) + 60;
const TX = '0x' + '22'.repeat(32);
const BH = '0x' + 'bb'.repeat(32);

function lockedLog(over = {}) {
  return {
    depositIdOnBsc: 7n,
    agentId: 17n,
    layerWallet: ADDR.agentWallet,
    credits: 1000n,
    blockNumber: 900,
    blockHash: BH,
    txHash: TX,
    logIndex: 4,
    blockTs: T - 100,
    ...over,
  };
}

/** 一套「确认条件已满足」的上下文 */
function ctxWith(t, { bsc, layer, now = T } = {}) {
  const b = bsc ?? new FakeBsc({ head: 1000, finalized: { number: 990, hash: '0xaa' }, finalized2: { number: 990, hash: '0xaa' } });
  const l = layer ?? new FakeLayer();
  // 这笔交易的收据里有 0..31 号日志：测试里每条 job 用不同的 logIndex 区分
  b.receipts.set(TX, { blockHash: BH, logs: Array.from({ length: 32 }, (_, i) => ({ index: i, address: ADDR.bacBridge })), status: 1 });
  const tracker = new FinalityTracker();
  const snapshot = { ts: now, headA: b.head, headB: b.head, finalizedA: b.finalized, finalizedB: b.finalized2, crossCheck: b.crossCheck };
  tracker.update(snapshot);
  return { db: t.db, bsc: b, layer: l, cfg: fakeCfg(), tracker, snapshot, warnings: new Set(), now: () => now };
}

function queueCredit(t, over = {}) {
  const job = creditJobFrom(lockedLog(over), ADDR.bacBridge, T - 100);
  const { row } = enqueue(t.db, { kind: 'credit', key: job.depositId, payload: job }, T);
  return { job, row };
}

describe('credit 的发送路径', () => {
  const t = tmpDb();
  after(() => t.cleanup());

  it('条件满足 → 发一笔，落 confirmed，链上 seen 被置位', async () => {
    const { job, row } = queueCredit(t);
    const ctx = ctxWith(t);
    const r = await processRow(ctx, row);
    assert.equal(r, 'sent');
    assert.equal(ctx.layer.sends.length, 1);
    assert.equal(getJobById(t.db, row.id).status, OUTBOX_STATUS.CONFIRMED);
    assert.ok(await ctx.layer.seen(job.depositId));
  });

  it('链上已经 seen → 直接确认，一笔都不发（幂等键是最后的兜底）', async () => {
    const { job, row } = queueCredit(t, { logIndex: 5 });
    const ctx = ctxWith(t);
    ctx.layer.seenSet.add(job.depositId);
    const r = await processRow(ctx, row);
    assert.equal(r, 'skipped');
    assert.equal(ctx.layer.sends.length, 0);
    assert.equal(getJobById(t.db, row.id).status, OUTBOX_STATUS.CONFIRMED);
  });

  it('发送前二次核对：源日志没了 → orphaned，不发，打告警', async () => {
    const { row } = queueCredit(t, { logIndex: 6 });
    const ctx = ctxWith(t);
    ctx.bsc.receipts.delete(TX); // BSC 重组：收据消失
    const r = await processRow(ctx, row);
    assert.equal(r, 'skipped');
    assert.equal(ctx.layer.sends.length, 0);
    assert.equal(getJobById(t.db, row.id).status, OUTBOX_STATUS.ORPHANED);
    assert.ok(ctx.warnings.has(WARN.BSC_LOG_ORPHANED));
  });

  it('blockHash 变了（同一笔交易被重组到别的块）→ orphaned', async () => {
    const { row } = queueCredit(t, { logIndex: 7 });
    const ctx = ctxWith(t);
    ctx.bsc.receipts.set(TX, { blockHash: '0x' + 'cc'.repeat(32), logs: [{ index: 7, address: ADDR.bacBridge }], status: 1 });
    await processRow(ctx, row);
    assert.equal(getJobById(t.db, row.id).status, OUTBOX_STATUS.ORPHANED);
  });

  it('确认条件没满足 → 不发、不改状态，等下一轮', async () => {
    const { row } = queueCredit(t, { logIndex: 8 });
    const ctx = ctxWith(t);
    ctx.snapshot = { ...ctx.snapshot, headA: 905, headB: 905 }; // 深度 5 < 15
    const r = await processRow(ctx, row);
    assert.equal(r, 'skipped');
    assert.equal(ctx.layer.sends.length, 0);
    assert.equal(getJobById(t.db, row.id).status, OUTBOX_STATUS.NEW);
  });

  it('finalized 连续 10 分钟取不到 → halted，队列停下（宁可停，不可错）', async () => {
    const { row } = queueCredit(t, { logIndex: 10 });
    const ctx = ctxWith(t);
    const outage = { ...ctx.snapshot, finalizedA: null, finalizedB: null, crossCheck: 'unknown' };
    ctx.tracker = new FinalityTracker();
    ctx.tracker.update({ ...outage, ts: T - 601 });
    ctx.tracker.update(outage);
    ctx.snapshot = outage;
    const r = await processRow(ctx, row);
    assert.equal(r, 'halted');
    assert.equal(ctx.layer.sends.length, 0);
  });
});

describe('加价重发与 parked', () => {
  const t = tmpDb();
  after(() => t.cleanup());

  it('60 秒不上链 → 1.25 倍加价重发，最多 3 次，然后 parked', async () => {
    const { row } = queueCredit(t, { logIndex: 11 });
    const ctx = ctxWith(t);
    ctx.layer.mineResult = null; // 永远不上链
    const r = await processRow(ctx, row);
    assert.equal(r, 'sent');
    assert.equal(ctx.layer.sends.length, SEND.MAX_ATTEMPTS);
    const prices = ctx.layer.sends.map((s) => s.gasPrice);
    assert.equal(prices[1], (prices[0] * 125n) / 100n);
    assert.equal(prices[2], (prices[1] * 125n) / 100n);
    // 同一个 nonce 重发，不做 nonce 管理器
    assert.equal(ctx.layer.sends[1].nonce, ctx.layer.sends[0].nonce);
    const fresh = getJobById(t.db, row.id);
    assert.equal(fresh.status, OUTBOX_STATUS.PARKED);
    assert.equal(fresh.attempts, SEND.MAX_ATTEMPTS);
    assert.ok(ctx.warnings.has(WARN.OUTBOX_PARKED));
  });

  it('parked 的 job 不阻塞后面的 job', async () => {
    const ctx = ctxWith(t);
    queueCredit(t, { logIndex: 12 });
    const r = await drainOutbox(ctx);
    // parked 的那条已经不在 pending 里，后面这条照样被处理
    assert.ok(r.sent >= 1);
    assert.equal(getJob(t.db, 'credit', creditJobFrom(lockedLog({ logIndex: 12 }), ADDR.bacBridge, T).depositId).status, OUTBOX_STATUS.CONFIRMED);
  });
});

describe('锚点的发送路径', () => {
  const t = tmpDb();
  after(() => t.cleanup());

  function queueAnchor(epoch) {
    const payload = {
      $schema: 'bac/AnchorJob/1',
      kind: 'anchor',
      epoch,
      anchor: {
        exitRoot: '0x' + '0'.repeat(64),
        l2BlockHash: '0x' + '1'.repeat(64),
        l2Block: 28799,
        creditedInEpoch: '0',
        exitCreditsInEpoch: '0',
        feeBurnedInEpoch: '0',
        circulating: '0',
        exitCount: 0,
      },
      leaves: [],
      status: 'new',
      bscTxHash: null,
    };
    putAnchor(t.db, epoch, payload, 'new', T);
    const { row } = enqueue(t.db, { kind: 'anchor', key: String(epoch), payload }, T);
    return row;
  }

  it('承诺窗口未到 → 不发', async () => {
    const row = queueAnchor(E);
    const ctx = ctxWith(t, { now: epochEndsAt(E) + 10 });
    ctx.cfg.start.firstEpoch = E;
    ctx.bsc.posted = E - 1;
    ctx.bsc.anchorStates.set(E - 1, 'FINAL');
    const r = await processRow(ctx, row);
    assert.equal(r, 'skipped');
    assert.equal(ctx.bsc.sends.length, 0);
  });

  it('窗口过了、上一个纪元已定案 → 发，anchors 表变 posted', async () => {
    const row = getJobById(t.db, 1);
    const ctx = ctxWith(t, { now: commitWindowEndsAt(E) + 5 });
    ctx.cfg.start.firstEpoch = E - 1;
    ctx.bsc.posted = E - 1;
    ctx.bsc.anchorStates.set(E - 1, 'FINAL');
    const r = await processRow(ctx, row);
    assert.equal(r, 'sent');
    assert.equal(ctx.bsc.sends.length, 1);
    assert.equal(getJobById(t.db, row.id).status, OUTBOX_STATUS.CONFIRMED);
  });

  it('链上 lastPostedEpoch 已经覆盖该纪元 → 不重发（epoch == lastPostedEpoch + 1 是幂等键）', async () => {
    const row = queueAnchor(E + 1);
    const ctx = ctxWith(t, { now: commitWindowEndsAt(E + 1) + 5 });
    ctx.bsc.posted = E + 1;
    const before = ctx.bsc.sends.length;
    const r = await processRow(ctx, row);
    assert.equal(r, 'skipped');
    assert.equal(ctx.bsc.sends.length, before);
  });

  it('不许跳号：该发 E+1 时，E+2 的 job 只能等', async () => {
    const row = queueAnchor(E + 2);
    const ctx = ctxWith(t, { now: commitWindowEndsAt(E + 2) + 5 });
    ctx.cfg.start.firstEpoch = E;
    ctx.bsc.posted = E; // 该发的是 E+1
    ctx.bsc.anchorStates.set(E, 'FINAL');
    const r = await processRow(ctx, row);
    assert.equal(r, 'skipped');
  });

  it('上一个纪元还是 POSTED（未定案）→ 等', async () => {
    const t2 = tmpDb();
    try {
      const payload = { $schema: 'bac/AnchorJob/1', kind: 'anchor', epoch: E + 1, anchor: { exitRoot: '0x' + '0'.repeat(64), l2BlockHash: '0x' + '1'.repeat(64), l2Block: 1, creditedInEpoch: '0', exitCreditsInEpoch: '0', feeBurnedInEpoch: '0', circulating: '0', exitCount: 0 }, leaves: [], status: 'new', bscTxHash: null };
      putAnchor(t2.db, E + 1, payload, 'new', T);
      const { row } = enqueue(t2.db, { kind: 'anchor', key: String(E + 1), payload }, T);
      const ctx = ctxWith(t2, { now: commitWindowEndsAt(E + 1) + 5 });
      ctx.cfg.start.firstEpoch = E - 5;
      ctx.bsc.posted = E;
      ctx.bsc.anchorStates.set(E, 'POSTED');
      assert.equal(await processRow(ctx, row), 'skipped');
      assert.equal(ctx.bsc.sends.length, 0);
    } finally {
      t2.cleanup();
    }
  });
});

describe('崩溃重启（发送中途）', () => {
  it('已发出且链上已生效 → 标记 confirmed，绝不重发', async () => {
    const t = tmpDb();
    try {
      const { job, row } = queueCredit(t, { logIndex: 20 });
      // 模拟：发出去了、落了 sent + tx_hash，然后进程就崩了
      updateJob(t.db, row.id, { status: OUTBOX_STATUS.SENT, txHash: '0x' + 'ee'.repeat(32), attempts: 1 }, T);
      const ctx = ctxWith(t);
      ctx.layer.seenSet.add(job.depositId); // 链上其实已经成功了
      const r = await resumePending(ctx);
      assert.equal(r.confirmed, 1);
      assert.equal(r.requeued, 0);
      assert.equal(ctx.layer.sends.length, 0, '重启不得重发');
      assert.equal(getJobById(t.db, row.id).status, OUTBOX_STATUS.CONFIRMED);
    } finally {
      t.cleanup();
    }
  });

  it('已发出但链上没生效 → 退回队列重发，且只会成功一次（seen 兜底）', async () => {
    const t = tmpDb();
    try {
      const { job, row } = queueCredit(t, { logIndex: 21 });
      updateJob(t.db, row.id, { status: OUTBOX_STATUS.SENT, txHash: '0x' + 'ef'.repeat(32), attempts: 1 }, T);
      const ctx = ctxWith(t);
      const r = await resumePending(ctx);
      assert.equal(r.requeued, 1);
      assert.equal(getJobById(t.db, row.id).status, OUTBOX_STATUS.NEW);

      await drainOutbox(ctx);
      assert.equal(ctx.layer.sends.length, 1);
      assert.equal(getJobById(t.db, row.id).status, OUTBOX_STATUS.CONFIRMED);

      // 再跑一轮：链上 seen 已置位，一笔都不该再发
      await drainOutbox(ctx);
      assert.equal(ctx.layer.sends.length, 1, '重启 + 重发绝不能产生第二笔 credit');
      assert.ok(await ctx.layer.seen(job.depositId));
    } finally {
      t.cleanup();
    }
  });

  it('锚点发到一半崩了、链上已经 posted → confirmed，不会重发第二个锚点', async () => {
    const t = tmpDb();
    try {
      const payload = { $schema: 'bac/AnchorJob/1', kind: 'anchor', epoch: E, anchor: { exitRoot: '0x' + '0'.repeat(64), l2BlockHash: '0x' + '1'.repeat(64), l2Block: 1, creditedInEpoch: '0', exitCreditsInEpoch: '0', feeBurnedInEpoch: '0', circulating: '0', exitCount: 0 }, leaves: [], status: 'new', bscTxHash: null };
      putAnchor(t.db, E, payload, 'new', T);
      const { row } = enqueue(t.db, { kind: 'anchor', key: String(E), payload }, T);
      updateJob(t.db, row.id, { status: OUTBOX_STATUS.SENT, txHash: '0x' + 'aa'.repeat(32), attempts: 1 }, T);
      const ctx = ctxWith(t);
      ctx.bsc.posted = E;
      const r = await resumePending(ctx);
      assert.equal(r.confirmed, 1);
      assert.equal(ctx.bsc.sends.length, 0);
    } finally {
      t.cleanup();
    }
  });
});
