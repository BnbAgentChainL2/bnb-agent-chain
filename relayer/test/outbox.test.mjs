// outbox 的幂等与「先落盘再推游标」纪律。用真的 SQLite 文件（临时目录），不碰网络。

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { OUTBOX_STATUS } from '../src/constants.mjs';
import { countByStatus, enqueue, enqueueBatch, getCursor, getJob, initCursor, nextPending, pendingList, setCursor, updateJob } from '../src/db.mjs';
import { creditJobFrom, scanBscOnce } from '../src/scan.mjs';
import { depositKey } from '../src/ids.mjs';
import { ADDR, FakeBsc, fakeCfg, tmpDb } from './fakes.mjs';

const T = 1790000000;
const TX = '0x' + '22'.repeat(32);

function lockedLog(over = {}) {
  return {
    depositIdOnBsc: 7n,
    agentId: 17n,
    layerWallet: ADDR.agentWallet,
    credits: 250000000000000000000000n,
    blockNumber: 150,
    blockHash: '0x' + 'bb'.repeat(32),
    txHash: TX,
    logIndex: 4,
    blockTs: T,
    ...over,
  };
}

describe('outbox 幂等', () => {
  const t = tmpDb();
  after(() => t.cleanup());

  it('同一个 (kind,key) 重复入队只留一行', () => {
    const job = creditJobFrom(lockedLog(), ADDR.bacBridge, T);
    const a = enqueue(t.db, { kind: 'credit', key: job.depositId, payload: job }, T);
    const b = enqueue(t.db, { kind: 'credit', key: job.depositId, payload: job }, T);
    assert.equal(a.inserted, true);
    assert.equal(b.inserted, false);
    assert.equal(countByStatus(t.db, OUTBOX_STATUS.NEW), 1);
  });

  it('CreditJob 的形状与 03 §1.2 一致，depositId 是 keccak 不是事件里的计数器', () => {
    const job = creditJobFrom(lockedLog(), ADDR.bacBridge, T);
    assert.equal(job.$schema, 'bac/CreditJob/1');
    assert.equal(job.kind, 'credit');
    assert.equal(job.depositId, depositKey(ADDR.bacBridge, TX, 4));
    assert.notEqual(job.depositId, '7');
    assert.equal(job.amount, '250000000000000000000000'); // 金额是十进制字符串的 wei
    assert.equal(job.agentId, 17);
    assert.equal(job.src.chainId, 56);
    assert.equal(job.src.logIndex, 4);
    assert.equal(job.status, 'new');
    assert.equal(job.layerTxHash, null);
  });

  it('updateJob 同步改 payload 里的 status / layerTxHash（它就是 pendingCredits 的元素）', () => {
    const job = creditJobFrom(lockedLog({ logIndex: 9 }), ADDR.bacBridge, T);
    const { row } = enqueue(t.db, { kind: 'credit', key: job.depositId, payload: job }, T);
    updateJob(t.db, row.id, { status: OUTBOX_STATUS.SENT, txHash: '0x' + 'cc'.repeat(32), attempts: 1 }, T);
    const after_ = JSON.parse(getJob(t.db, 'credit', job.depositId).payload);
    assert.equal(after_.status, 'sent');
    assert.equal(after_.layerTxHash, '0x' + 'cc'.repeat(32));
    assert.equal(after_.attempts, 1);
  });

  it('队列按 id 升序（严格单线程）', () => {
    const rows = pendingList(t.db, 10);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].id > rows[i - 1].id);
    assert.equal(nextPending(t.db).id, rows[0].id);
  });
});

describe('先落盘再推游标', () => {
  const t = tmpDb();
  after(() => t.cleanup());

  it('扫描后 outbox 有行，游标才前进；重扫同一段不会产生第二行', async () => {
    const cfg = fakeCfg();
    const bsc = new FakeBsc({ head: 200, lockedLogs: [lockedLog()] });
    initCursor(t.db, 'bsc', 100, T);
    const ctx = { db: t.db, bsc, cfg, now: () => T };

    const r1 = await scanBscOnce(ctx);
    assert.equal(r1.credits, 1);
    assert.equal(getCursor(t.db, 'bsc'), 200);
    assert.equal(countByStatus(t.db, OUTBOX_STATUS.NEW), 1);

    // 把游标退回去，模拟「写完 outbox 就崩了，游标没推成」：重扫必须幂等。
    setCursor(t.db, 'bsc', 100, T);
    const r2 = await scanBscOnce(ctx);
    assert.equal(r2.credits, 1);
    assert.equal(countByStatus(t.db, OUTBOX_STATUS.NEW), 1, '重扫不得产生重复行');
  });
});

describe('sync job 的 key 与形状（03 §1.4）', () => {
  const t = tmpDb();
  after(() => t.cleanup());

  it('key 是 agentId:bscBlock，status 编码与 AgentRegistry.Status 一致', async () => {
    const cfg = fakeCfg();
    const bsc = new FakeBsc({
      head: 300,
      registryLogs: [
        { name: 'Activated', agentId: 17n, wallet: ADDR.agentWallet, blockNumber: 210, blockHash: '0x' + 'aa'.repeat(32), txHash: TX, logIndex: 1, blockTs: T },
      ],
      agentStates: new Map([[17, { wallet: ADDR.agentWallet, status: 2 }]]),
    });
    initCursor(t.db, 'bsc', 200, T);
    await scanBscOnce({ db: t.db, bsc, cfg, now: () => T });
    const row = getJob(t.db, 'sync', '17:210');
    assert.ok(row, '应该有一行 key=17:210 的 sync');
    const payload = JSON.parse(row.payload);
    assert.equal(payload.$schema, 'bac/SyncJob/1');
    assert.equal(payload.status, 2);
    assert.equal(payload.statusName, 'ACTIVE');
    assert.equal(payload.bscBlock, 210);
    assert.equal(payload.status_, 'new');
  });
});

describe('批量入队是一笔事务', () => {
  const t = tmpDb();
  after(() => t.cleanup());

  it('一条报错整批回滚（绝不留半批）', () => {
    const job = creditJobFrom(lockedLog(), ADDR.bacBridge, T);
    const bad = { kind: 'credit', key: job.depositId, payload: { get broken() { throw new Error('boom'); } } };
    assert.throws(() => enqueueBatch(t.db, [{ kind: 'credit', key: 'k1', payload: job }, bad], T));
    assert.equal(countByStatus(t.db, OUTBOX_STATUS.NEW), 0);
  });
});
