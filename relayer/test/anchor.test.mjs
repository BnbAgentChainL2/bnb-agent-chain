// 方向 B：l2Block 的规范定义、锚点排序、组装（含空纪元与 veto 重报）。

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { COMMIT_WINDOW, EPOCH, LAYER_TOTAL_SUPPLY, WARN } from '../src/constants.mjs';
import { commitWindowEndsAt, epochEndsAt, l2BlockFor, mergeCarried, planNextAnchor, rangeFor } from '../src/anchorMath.mjs';
import { assembleAnchor } from '../src/anchorJob.mjs';
import { putAnchor } from '../src/db.mjs';
import { exitRootOf } from '../src/ids.mjs';
import { ADDR, FakeLayer, fakeCfg, makeChain, tmpDb } from './fakes.mjs';

const E = 20700; // 纪元号
const START = E * EPOCH; // 该纪元的第一秒

describe('l2Block(epoch) 的规范定义', () => {
  it('= 时间戳 < (epoch+1)*86400 的最大区块号', async () => {
    // 3 秒一个块，从纪元 E 的第一秒开始，横跨到 E+1
    const blocks = makeChain(40000, START, 3);
    const layer = new FakeLayer({ blocks });
    const b = await l2BlockFor(layer, E);
    assert.ok(b.timestamp < epochEndsAt(E));
    const next = blocks[b.number + 1];
    assert.ok(next.timestamp >= epochEndsAt(E), '下一个块必须已经越过纪元边界');
  });

  it('head 还没越过边界时就返回 head', async () => {
    const blocks = makeChain(100, START, 3);
    const layer = new FakeLayer({ blocks });
    const b = await l2BlockFor(layer, E);
    assert.equal(b.number, 99);
  });

  it('链在该纪元结束时还不存在 → null', async () => {
    const layer = new FakeLayer({ blocks: makeChain(10, START, 3) });
    assert.equal(await l2BlockFor(layer, E - 5), null);
  });

  it('空纪元：l2Block(epoch) == l2Block(epoch-1)，区间 from > to', async () => {
    // 链在纪元 E 停了：最后一个块落在 E-1，E 整个纪元没有块
    const blocks = makeChain(50, (E - 1) * EPOCH, 3);
    const layer = new FakeLayer({ blocks });
    const cur = await l2BlockFor(layer, E);
    const prev = await l2BlockFor(layer, E - 1);
    assert.equal(cur.number, prev.number);
    const r = await rangeFor(layer, E);
    assert.ok(r.from > r.to, '空纪元的聚合区间必须是空的');
  });
});

describe('锚点排序（planNextAnchor）', () => {
  const base = { lastPostedEpoch: E - 1, firstEpoch: E - 10, prevState: 'FINAL', now: epochEndsAt(E) + COMMIT_WINDOW };

  it('epoch == lastPostedEpoch + 1，且承诺窗口已过 → post', () => {
    const p = planNextAnchor(base);
    assert.equal(p.action, 'post');
    assert.equal(p.epoch, E);
  });

  it('纪元还没结束 → wait', () => {
    const p = planNextAnchor({ ...base, now: epochEndsAt(E) - 10 });
    assert.equal(p.action, 'wait');
    assert.match(p.reason, /还没结束/);
  });

  it('承诺窗口未结束（差 1 秒）→ wait —— 见证人必须有 2 小时', () => {
    const p = planNextAnchor({ ...base, now: commitWindowEndsAt(E) - 1 });
    assert.equal(p.action, 'wait');
    assert.match(p.reason, /承诺窗口/);
  });

  it('上一个纪元还是 POSTED（未定案）→ wait', () => {
    const p = planNextAnchor({ ...base, prevState: 'POSTED' });
    assert.equal(p.action, 'wait');
    assert.match(p.reason, /尚未定案/);
  });

  it('上一个纪元 VETOED / DISPUTED 都算定案 → post（内容并进本次）', () => {
    for (const s of ['VETOED', 'DISPUTED']) {
      assert.equal(planNextAnchor({ ...base, prevState: s }).action, 'post');
    }
  });

  it('第一个锚点不看上一个纪元的状态', () => {
    const p = planNextAnchor({ lastPostedEpoch: null, firstEpoch: E, prevState: 'NONE', now: commitWindowEndsAt(E) });
    assert.equal(p.action, 'post');
    assert.equal(p.epoch, E);
  });

  it('落后多个纪元时先发最老的那个，绝不跳号', () => {
    const p = planNextAnchor({ ...base, lastPostedEpoch: E - 5, now: commitWindowEndsAt(E) + 10 * EPOCH });
    assert.equal(p.epoch, E - 4);
  });
});

describe('被否决的纪元并进下一个锚点', () => {
  it('计数字段相加，叶子原样带上（一个字节都不改）', () => {
    const own = { credited: 10n, exitCredits: 1n, feeBurned: 2n, leaves: [{ exitId: 9, agentId: 1, to: ADDR.agentWallet, credits: '1' }] };
    const carried = [
      {
        epoch: E - 1,
        payload: {
          anchor: { creditedInEpoch: '5', exitCreditsInEpoch: '3', feeBurnedInEpoch: '1' },
          leaves: [{ exitId: 4, agentId: 2, to: ADDR.agentWallet, credits: '3', bornEpoch: E - 1 }],
        },
      },
    ];
    const m = mergeCarried(own, carried);
    assert.equal(m.credited, 15n);
    assert.equal(m.exitCredits, 4n);
    assert.equal(m.feeBurned, 3n);
    assert.equal(m.leaves.length, 2);
    assert.deepEqual(m.carriedEpochs, [E - 1]);
    // 叶子哈希与出生纪元无关：重报到任何后续纪元都能证明
    const { root } = exitRootOf(m.leaves, ADDR.bacBridge);
    const { root: same } = exitRootOf(m.leaves.map((l) => ({ ...l, bornEpoch: 99999 })), ADDR.bacBridge);
    assert.equal(root, same);
  });
});

describe('锚点组装（assembleAnchor）', () => {
  const t = tmpDb();
  after(() => t.cleanup());
  const cfg = fakeCfg();

  function layerWith(exits, mints, balances) {
    return new FakeLayer({ blocks: makeChain(60000, (E - 1) * EPOCH, 3), exits, mints, balances });
  }

  it('正常纪元：叶子、四个计数字段、circulating 都按规范算', async () => {
    // 纪元 E 的区间：块 28800..57599（3 秒块，一天 28800 块）
    const exits = [
      { exitId: 41n, agentId: 17n, to: ADDR.agentWallet, credits: 20000n, epoch: E, layerTxHash: '0x' + '1'.repeat(64), layerBlock: 30000 },
      { exitId: 42n, agentId: 18n, to: ADDR.agentWallet, credits: 5000n, epoch: E, layerTxHash: '0x' + '2'.repeat(64), layerBlock: 40000 },
    ];
    const mints = [{ depositId: '0x01', amount: 90000n, layerBlock: 35000 }];
    const balances = new Map([
      [`${ADDR.feeSink}@28799`, 100n],
      [`${ADDR.feeSink}@57599`, 130n],
      [`${ADDR.layerSigner}@28799`, 7n],
      [`${ADDR.layerSigner}@57599`, 19n],
      [`${ADDR.l2Bridge}@57599`, 999_000n],
    ]);
    const layer = layerWith(exits, mints, balances);
    const r = await assembleAnchor({ db: t.db, layer, cfg, now: () => epochEndsAt(E) + 60 }, E);
    assert.equal(r.ok, true);
    const a = r.payload.anchor;
    assert.equal(r.payload.$schema, 'bac/AnchorJob/1');
    assert.equal(r.payload.epoch, E);
    assert.equal(a.exitCount, 2);
    assert.equal(a.exitCreditsInEpoch, '25000');
    assert.equal(a.creditedInEpoch, '90000');
    // feeBurned = ΔFeeSink + Δ签名者 = 30 + 12（小费不进 FeeSink，必须分开读再相加）
    assert.equal(a.feeBurnedInEpoch, '42');
    assert.equal(a.circulating, (LAYER_TOTAL_SUPPLY - 999_000n - 130n - 19n).toString());
    assert.equal(a.exitRoot, exitRootOf(r.payload.leaves, ADDR.bacBridge).root);
    assert.equal(r.payload.leaves[0].bornEpoch, E);
    assert.ok(r.payload.leaves[0].leaf.startsWith('0x'));
    assert.equal(r.warnings.length, 0);
  });

  it('空纪元：exitCount = 0、exitRoot = 0、四个计数字段为 0，l2Block 不回退', async () => {
    const layer = new FakeLayer({ blocks: makeChain(28800, (E - 1) * EPOCH, 3) }); // 只到 E-1
    const r = await assembleAnchor({ db: t.db, layer, cfg, now: () => epochEndsAt(E) + 60 }, E);
    assert.equal(r.ok, true);
    assert.equal(r.payload.anchor.exitCount, 0);
    assert.equal(r.payload.anchor.exitRoot, '0x' + '0'.repeat(64));
    assert.equal(r.payload.anchor.creditedInEpoch, '0');
    assert.equal(r.payload.anchor.exitCreditsInEpoch, '0');
    assert.equal(r.payload.range.empty, true);
  });

  it('ExitBurned 的 epoch 与区间推出的纪元不一致 → 停止组装并告警（宁可停，不可错）', async () => {
    const exits = [{ exitId: 41n, agentId: 17n, to: ADDR.agentWallet, credits: 1n, epoch: E + 5, layerTxHash: '0x' + '1'.repeat(64), layerBlock: 30000 }];
    const layer = layerWith(exits, [], new Map());
    const r = await assembleAnchor({ db: t.db, layer, cfg, now: () => epochEndsAt(E) + 60 }, E);
    assert.equal(r.ok, false);
    assert.ok(r.warnings.includes(WARN.EXIT_EPOCH_MISMATCH));
  });

  it('纪元结束超过 6 分钟才读余额 → layer_state_window_missed 告警', async () => {
    const layer = layerWith([], [], new Map());
    const r = await assembleAnchor({ db: t.db, layer, cfg, now: () => epochEndsAt(E) + 400 }, E);
    assert.equal(r.ok, true);
    assert.ok(r.warnings.includes(WARN.LAYER_STATE_WINDOW_MISSED));
  });

  it('库里有 vetoed 的旧锚点 → 自动并进本次（计数相加、叶子重报）', async () => {
    const t2 = tmpDb();
    try {
      putAnchor(
        t2.db,
        E - 1,
        {
          anchor: { creditedInEpoch: '7', exitCreditsInEpoch: '3', feeBurnedInEpoch: '1' },
          leaves: [{ exitId: 40, agentId: 3, to: ADDR.agentWallet, credits: '3', bornEpoch: E - 1 }],
        },
        'vetoed',
        1,
      );
      const layer = layerWith(
        [{ exitId: 41n, agentId: 17n, to: ADDR.agentWallet, credits: 5n, epoch: E, layerTxHash: '0x' + '1'.repeat(64), layerBlock: 30000 }],
        [],
        new Map(),
      );
      const r = await assembleAnchor({ db: t2.db, layer, cfg, now: () => epochEndsAt(E) + 60 }, E);
      assert.equal(r.ok, true);
      assert.equal(r.payload.anchor.exitCount, 2);
      assert.equal(r.payload.anchor.exitCreditsInEpoch, '8');
      assert.equal(r.payload.anchor.creditedInEpoch, '7');
      assert.deepEqual(r.payload.carriedEpochs, [E - 1]);
    } finally {
      t2.cleanup();
    }
  });
});
