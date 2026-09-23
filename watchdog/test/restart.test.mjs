// 「探测到一半被重启」必须接着走完，而不是从头再探测一遍。
//
// 为什么这条要单独测：120 秒的窗口里，从头再探测一遍意味着多花一个完整的轮询周期，
// 而重启最可能发生的时刻恰恰是运维正在处理别的事故的时候。SQLite 里的 findings 表
// 就是为这件事存在的 —— 它不是日志，它是状态机的一部分。

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { EPOCH, FINDING_STATE } from '../src/constants.mjs';
import { getCursor, openDb, trippedFindings, upsertFinding } from '../src/db.mjs';
import { makeEngine } from '../src/engine.mjs';
import { setSink } from '../src/log.mjs';
import { ADDR, FakeBsc, FakeLayer, fakeCfg, honestAnchor, makeBlocks, tmpDbPath } from './fakes.mjs';

setSink(() => {});

const E = 1000;
const START = (E - 1) * EPOCH;
const cleanups = [];
const openDbs = [];
// Windows 上没关掉的 SQLite 句柄会让临时目录删不掉（EBUSY），所以先关库再删目录。
after(() => {
  for (const d of openDbs) {
    try {
      d.close();
    } catch {
      /* 已经关了 */
    }
  }
  cleanups.forEach((f) => f());
});

function layerOf() {
  return new FakeLayer({
    blocks: makeBlocks(600, START, 3),
    exits: [{ exitId: 1n, agentId: 7n, to: ADDR.alice, credits: 1000n, epoch: E, layerBlock: 250 }],
    mints: [{ amount: 500n, layerBlock: 260 }],
  });
}

function engineOn(dbPath, layer, anchors, events, sent) {
  const cfg = fakeCfg();
  const db = openDb(dbPath);
  openDbs.push(db);
  const bsc = new FakeBsc({ head: 10, anchors, events });
  const bsc2 = new FakeBsc({ head: 10, anchors, events, which: 'secondary' });
  const engine = makeEngine({
    cfg,
    db,
    bsc,
    bsc2,
    layer,
    layer2: layer,
    now: () => 1_000_000,
    sleepFn: async () => {},
    notifyFn: async (_c, a) => {
      sent.push(a);
      return { sent: true };
    },
  });
  return { cfg, db, bsc, bsc2, engine };
}

describe('重启续传', () => {
  it('崩在「复核已成立、pause 还没发出去」那一瞬间：重启后直接跳闸，不重新探测', async () => {
    const { path, cleanup } = tmpDbPath();
    cleanups.push(cleanup);
    const layer = layerOf();
    const anchors = new Map([[E, { ...honestAnchor(layer, E), exitRoot: '0x' + '99'.repeat(32) }]]);

    // ——— 上一个进程：写到 pending_trip 就被 kill 了 ———
    {
      const db = openDb(path);
      openDbs.push(db);
      upsertFinding(
        db,
        {
          rule: 'anchor_root',
          subject: String(E),
          severity: 'critical',
          state: FINDING_STATE.PENDING_TRIP,
          detail: { summary: '纪元 1000 的 exitRoot 与复算结果不一致', first: {}, second: {} },
        },
        999_000,
      );
    }

    // ——— 新进程 ———
    const sent = [];
    const t = engineOn(path, layer, anchors, [], sent);
    const before = layer.calls.exitLogs;
    const r = await t.engine.resume();

    assert.equal(r.resumed, 1);
    assert.equal(t.bsc.pauses.length, 1, '重启后必须立刻把那笔 pause 发出去');
    assert.equal(layer.calls.exitLogs, before, '不许重新探测一遍：那要多花一个完整的轮询周期');
    assert.equal(trippedFindings(t.db).length, 1);
    assert.ok(sent.some((s) => s.action === 'paused'));
  });

  it('崩在「已开单、还没复核」那一瞬间：重启后重跑规则并走完复核', async () => {
    const { path, cleanup } = tmpDbPath();
    cleanups.push(cleanup);
    const layer = layerOf();
    const anchors = new Map([[E, { ...honestAnchor(layer, E), exitRoot: '0x' + '99'.repeat(32) }]]);
    {
      const db = openDb(path);
      openDbs.push(db);
      upsertFinding(
        db,
        { rule: 'anchor_root', subject: String(E), severity: 'critical', state: FINDING_STATE.PENDING_CONFIRM, detail: {} },
        999_000,
      );
    }
    const sent = [];
    const t = engineOn(path, layer, anchors, [], sent);
    const before = layer.calls.exitLogs;
    await t.engine.resume();
    assert.ok(layer.calls.exitLogs > before, 'pending_confirm 的单子必须重新算一遍');
    assert.equal(t.bsc.pauses.length, 1);
  });

  it('上一轮的误报（cleared）不会在重启后被重新翻出来', async () => {
    const { path, cleanup } = tmpDbPath();
    cleanups.push(cleanup);
    const layer = layerOf();
    {
      const db = openDb(path);
      openDbs.push(db);
      upsertFinding(
        db,
        { rule: 'anchor_root', subject: String(E), severity: 'critical', state: FINDING_STATE.CLEARED, detail: {} },
        999_000,
      );
    }
    const t = engineOn(path, layer, new Map(), [], []);
    const r = await t.engine.resume();
    assert.equal(r.resumed, 0);
    assert.equal(t.bsc.pauses.length, 0);
  });

  it('游标落盘：重启后不会把同一段区块再扫一遍', async () => {
    const { path, cleanup } = tmpDbPath();
    cleanups.push(cleanup);
    const layer = layerOf();
    const anchors = new Map([[E, honestAnchor(layer, E)]]);
    const events = [{ name: 'AnchorPosted', args: { epoch: E }, blockNumber: 5, logIndex: 0 }];

    const a = engineOn(path, layer, anchors, events, []);
    const r1 = await a.engine.tickFast();
    assert.equal(r1.posted.length, 1);
    assert.equal(getCursor(a.db, 'bsc_anchor'), 10);

    // 新进程，同一个库
    const b = engineOn(path, layer, anchors, events, []);
    const r2 = await b.engine.tickFast();
    assert.equal(r2.events, 0, '没有新区块时这一轮不该再扫出任何事件');
    assert.equal(r2.from, 11);
  });

  it('重报集（carry）也落盘：veto 发生在重启之前，重启后仍然认', async () => {
    const { path, cleanup } = tmpDbPath();
    cleanups.push(cleanup);
    const layer = layerOf();
    const a = engineOn(path, layer, new Map(), [{ name: 'AnchorVetoed', args: { epoch: E - 1 }, blockNumber: 3, logIndex: 0 }], []);
    await a.engine.tickFast();

    const b = engineOn(path, layer, new Map(), [], []);
    const derived = await b.engine.deriveAnchor(layer, E);
    assert.deepEqual(derived.carried, [E - 1], '重启后必须还记得纪元 999 要被重报');
  });
});
