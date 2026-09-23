// 状态机的端到端测试，全部离线：假 BSC + 假层内节点 + 真 SQLite。
// 覆盖的是「探测 → 复核 → 跳闸」这条链路本身，以及**不该跳闸的那些情况**。

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { EPOCH, FINDING_STATE, LAYER_TOTAL_SUPPLY, SEVERITY } from '../src/constants.mjs';
import { openDb, setLedger, trippedFindings } from '../src/db.mjs';
import { makeEngine } from '../src/engine.mjs';
import { exitRootOf } from '../src/ids.mjs';
import { setSink } from '../src/log.mjs';
import { ADDR, FakeBsc, FakeLayer, emptyBridgeEvents, fakeCfg, honestAnchor, makeBlocks } from './fakes.mjs';

// 测试期间把日志收进数组，保持输出干净；出错时仍然能把它打出来看。
let LINES = [];
setSink((_level, line) => LINES.push(line));
beforeEach(() => {
  LINES = [];
});

const E = 1000; // 纪元号：它从 599400 秒（纪元 999 的第一秒）开始的那条链上
const START = (E - 1) * EPOCH;

function buildLayer(over = {}) {
  return new FakeLayer({
    blocks: makeBlocks(600, START, 3),
    exits: over.exits ?? [
      { exitId: 1n, agentId: 7n, to: ADDR.alice, credits: 1000n, epoch: E, layerBlock: 250 },
      { exitId: 2n, agentId: 8n, to: ADDR.alice, credits: 2000n, epoch: E, layerBlock: 300 },
    ],
    mints: over.mints ?? [{ amount: 500n, layerBlock: 260 }],
    balances: over.balances ?? {},
    ...over,
  });
}

function build(over = {}) {
  const cfg = fakeCfg(over.cfg ?? {});
  const db = openDb(':memory:');
  const layer = over.layer ?? buildLayer();
  const layer2 = over.layer2 ?? layer;
  const anchors = new Map();
  const bsc = new FakeBsc({ head: 10, anchors, events: over.events ?? [], ...(over.bsc ?? {}) });
  const bsc2 = new FakeBsc({ head: 10, anchors: over.anchors2 ?? anchors, events: over.events ?? [], which: 'secondary', ...(over.bsc2 ?? {}) });
  const sent = [];
  const engine = makeEngine({
    cfg,
    db,
    bsc,
    bsc2,
    layer,
    layer2,
    now: () => 1_000_000,
    sleepFn: async () => {},
    notifyFn: async (_c, a) => {
      sent.push(a);
      return { sent: true };
    },
  });
  return { cfg, db, bsc, bsc2, layer, layer2, engine, sent, anchors };
}

const postedEvent = (epoch, block = 5) => ({ name: 'AnchorPosted', args: { epoch }, blockNumber: block, txHash: '0xaa', logIndex: 0 });

describe('快规则：锚点根', () => {
  it('诚实的锚点：不开单、不暂停', async () => {
    const t = build({ events: [postedEvent(E)] });
    t.anchors.set(E, honestAnchor(t.layer, E));
    const r = await t.engine.tickFast();
    assert.equal(r.posted.length, 1);
    assert.equal(t.engine.tripped, false);
    assert.equal(t.bsc.pauses.length, 0);
  });

  it('伪造的 exitRoot：复核成立 → 发出 pause()，发现落为 tripped', async () => {
    const t = build({ events: [postedEvent(E)] });
    const forged = { ...honestAnchor(t.layer, E), exitRoot: '0x' + '99'.repeat(32) };
    t.anchors.set(E, forged);

    await t.engine.tickFast();
    assert.equal(t.engine.tripped, true);
    assert.equal(t.bsc.pauses.length, 1, '必须正好发一笔 pause');
    const tripped = trippedFindings(t.db);
    assert.equal(tripped.length, 1);
    assert.equal(tripped[0].rule, 'anchor_root');
    assert.equal(tripped[0].subject, String(E));
    // 告警里必须带上「我比较了什么」
    const alert = t.sent.find((s) => s.action === 'paused');
    assert.ok(alert, '必须发出 action=paused 的告警');
    assert.equal(alert.compared.first.exitRoot.onchain, forged.exitRoot);
    assert.equal(alert.compared.second.exitRoot.mine, honestAnchor(t.layer, E).exitRoot);
  });

  it('伪造的 exitRoot，但第二个 RPC 上那笔 postAnchor 已经被重组掉 → 撤单，不暂停', async () => {
    const anchors2 = new Map(); // secondary 上根本没有这个锚点
    const t = build({ events: [postedEvent(E)], anchors2 });
    t.anchors.set(E, { ...honestAnchor(t.layer, E), exitRoot: '0x' + '99'.repeat(32) });

    await t.engine.tickFast();
    assert.equal(t.engine.tripped, false, '重组掉的幻影不许冻结一座桥');
    assert.equal(t.bsc.pauses.length, 0);
    assert.equal(trippedFindings(t.db).length, 0);
  });

  it('演练模式（WATCHDOG_ARMED=false）：照样开单与告警，但一笔交易都不发', async () => {
    const t = build({ events: [postedEvent(E)], cfg: { armed: false } });
    t.anchors.set(E, { ...honestAnchor(t.layer, E), exitRoot: '0x' + '99'.repeat(32) });
    await t.engine.tickFast();
    assert.equal(t.engine.tripped, true);
    assert.equal(t.bsc.pauses.length, 0);
    assert.ok(t.sent.some((s) => s.action === 'dry_run'));
  });

  it('pause() 自己失败时，告警必须说「桥没有被刹住」', async () => {
    const t = build({ events: [postedEvent(E)], bsc: { pauseShouldFail: true } });
    t.anchors.set(E, { ...honestAnchor(t.layer, E), exitRoot: '0x' + '99'.repeat(32) });
    await t.engine.tickFast();
    const alert = t.sent.find((s) => s.action === 'pause_failed');
    assert.ok(alert, '必须发出 action=pause_failed 的告警');
  });

  it('配了 vetoKey 且还在 120 秒等待期内：先 veto，再 pause', async () => {
    const t = build({ events: [postedEvent(E)], cfg: { keys: { watchdog: '0x' + '11'.repeat(32), veto: '0x' + '22'.repeat(32) } } });
    const a = { ...honestAnchor(t.layer, E), exitRoot: '0x' + '99'.repeat(32), postedAt: 1_000_000 - 30, state: 'POSTED' };
    t.anchors.set(E, a);
    await t.engine.tickFast();
    assert.equal(t.bsc.vetoes.length, 1, 'veto 是唯一的零损失路径，有钥匙就必须走');
    assert.equal(t.bsc.vetoes[0].epoch, E);
    assert.equal(t.bsc.pauses.length, 1, 'veto 之后仍然要 pause');
  });

  it('veto 窗口已经过了：只 pause，不白发一笔必然 revert 的交易', async () => {
    const t = build({ events: [postedEvent(E)], cfg: { keys: { watchdog: '0x' + '11'.repeat(32), veto: '0x' + '22'.repeat(32) } } });
    t.anchors.set(E, { ...honestAnchor(t.layer, E), exitRoot: '0x' + '99'.repeat(32), postedAt: 1_000_000 - 500, state: 'POSTED' });
    await t.engine.tickFast();
    assert.equal(t.bsc.vetoes.length, 0);
    assert.equal(t.bsc.pauses.length, 1);
  });
});

describe('误报防线：被否决的纪元要重报', () => {
  // 纪元 999 被 veto 之后，它的叶子必须原样并进纪元 1000 的锚点（03 §1.3）。
  // 不认这条规则，看门狗会把每一次 veto 之后的第一个合法锚点当成伪造 —— 而 veto 正是
  // 出事之后运维会做的动作，那等于「刚救完火就自己再点一把」。
  function mergedAnchor(layer) {
    const cur = layer.blocks.filter((b) => b.timestamp < (E + 1) * EPOCH).pop();
    const all = layer.exits.filter((e) => e.layerBlock <= cur.number);
    const { root } = exitRootOf(all.map((e) => ({ exitId: e.exitId, agentId: e.agentId, to: e.to, credits: e.credits })), ADDR.bridge);
    return {
      exitRoot: root,
      l2BlockHash: cur.hash,
      l2Block: cur.number,
      postedAt: (E + 1) * EPOCH + 5,
      finalizedAt: 0,
      creditedInEpoch: layer.mints.reduce((a, m) => a + m.amount, 0n),
      exitCreditsInEpoch: all.reduce((a, e) => a + e.credits, 0n),
      feeBurnedInEpoch: 0n,
      circulating: 0n,
      exitCount: all.length,
      agreeingCount: 0,
      state: 'POSTED',
    };
  }

  // 纪元 999 的区间是 0..199，纪元 1000 的是 200..399
  const layerWithBoth = () =>
    buildLayer({
      exits: [
        { exitId: 1n, agentId: 7n, to: ADDR.alice, credits: 1000n, epoch: E - 1, layerBlock: 100 },
        { exitId: 2n, agentId: 8n, to: ADDR.alice, credits: 2000n, epoch: E, layerBlock: 300 },
      ],
      mints: [{ amount: 500n, layerBlock: 50 }, { amount: 700n, layerBlock: 260 }],
    });

  it('看到 AnchorVetoed(999) 之后，合并了 999 叶子的 1000 号锚点是合法的', async () => {
    const layer = layerWithBoth();
    const t = build({
      layer,
      events: [{ name: 'AnchorVetoed', args: { epoch: E - 1 }, blockNumber: 3, logIndex: 0 }, postedEvent(E, 5)],
    });
    t.anchors.set(E, mergedAnchor(layer));
    await t.engine.tickFast();
    assert.equal(t.engine.tripped, false, '合法的重报不许跳闸');
  });

  it('同一段区块里同时有 Posted(1000) 与 Finalized(1000)：清重报集不能抢在评估之前', async () => {
    // 这是一个顺序 bug 的回归测试：先把事件分完类再统一评估的话，Finalized(1000) 会在
    // Posted(1000) 被评估之前把 999 从重报集里清掉，于是一个**诚实**的合并锚点被判成伪造。
    const layer = layerWithBoth();
    const t = build({
      layer,
      events: [
        { name: 'AnchorVetoed', args: { epoch: E - 1 }, blockNumber: 3, logIndex: 0 },
        postedEvent(E, 5),
        { name: 'AnchorFinalized', args: { epoch: E }, blockNumber: 6, logIndex: 0 },
      ],
    });
    t.anchors.set(E, mergedAnchor(layer));
    await t.engine.tickFast();
    assert.equal(t.engine.tripped, false);
  });

  it('对照组：没有那条 AnchorVetoed，同一个锚点就该被判为伪造', async () => {
    const layer = layerWithBoth();
    const t = build({ layer, events: [postedEvent(E, 5)] });
    t.anchors.set(E, mergedAnchor(layer));
    await t.engine.tickFast();
    assert.equal(t.engine.tripped, true, '这条对照组证明重报逻辑是承重的，不是装饰');
  });
});

describe('慢规则：桶 / 释放率 / 回购', () => {
  const issued = 3000n;
  const exited = 0n;

  function slowSetup(over = {}) {
    const balances = {
      [ADDR.l2Bridge]: LAYER_TOTAL_SUPPLY - (issued - exited),
      [ADDR.feeSink]: 0n,
      [ADDR.signer]: 0n,
      [ADDR.feeSplitter]: 0n,
    };
    const layer = buildLayer({ balances, totalExited: exited });
    const state = {
      lockedBac: 3000n,
      totalBurned: 0n,
      buybackBac: 1440000n,
      owedTotal: 1000000n,
      reservedTotal: 0n,
      totalCreditsIssued: issued,
      totalCreditsExited: exited,
      bnbBalance: 0n,
      tokenBalance: 3000n + 1440000n,
      ...(over.state ?? {}),
    };
    const bridgeEvents = { ...emptyBridgeEvents(), ...(over.bridgeEvents ?? {}) };
    const t = build({
      layer,
      bsc: { state, bridgeEvents, lastPostedEpoch: 1663 },
      bsc2: { state, bridgeEvents, which: 'secondary', lastPostedEpoch: 1663 },
      ...over.build,
    });
    if (over.prevSnapshot) {
      const p = over.prevSnapshot;
      setLedger(t.db, 'snap_block', BigInt(p.block), 1);
      setLedger(t.db, 'snap_lockedBac', p.lockedBac, 1);
      setLedger(t.db, 'snap_totalBurned', p.totalBurned, 1);
      setLedger(t.db, 'snap_buybackBac', p.buybackBac, 1);
      setLedger(t.db, 'snap_owedTotal', p.owedTotal, 1);
      setLedger(t.db, 'snap_reservedTotal', p.reservedTotal, 1);
    }
    return t;
  }

  it('一切正常：不开单、不暂停', async () => {
    const t = slowSetup();
    const r = await t.engine.tickSlow();
    assert.equal(t.engine.tripped, false);
    assert.equal(r.to, 10);
  });

  it('两个桶对不上（真实余额低于账面）→ 暂停', async () => {
    const t = slowSetup({ state: { tokenBalance: 1000n } });
    await t.engine.tickSlow();
    assert.equal(t.engine.tripped, true);
    assert.equal(t.bsc.pauses.length, 1);
    assert.equal(trippedFindings(t.db)[0].rule, 'buckets');
  });

  it('退出动了锁定桶（lockedBac 变小、没有对应事件）→ 暂停', async () => {
    const t = slowSetup({
      state: { lockedBac: 2000n, tokenBalance: 2000n + 1440000n },
      prevSnapshot: { block: 0, lockedBac: 3000n, totalBurned: 0n, buybackBac: 1440000n, owedTotal: 1000000n, reservedTotal: 0n },
    });
    await t.engine.tickSlow();
    assert.equal(t.engine.tripped, true);
    const f = trippedFindings(t.db)[0];
    assert.equal(f.rule, 'buckets');
    assert.equal(f.detail.second.delta.lockedBac.onchain, '-1000');
  });

  it('超过每纪元释放上限 → 暂停', async () => {
    // 影子账本里的基数：buybackBac 1440000、reservedTotal 0
    // 上限 = 1440000 × 200 / (10000 × 144) = 200；这里放了 50000
    const settled = [{ blockNumber: 6, logIndex: 0, epoch: 1663, pot: 50000n, owedTotalAfter: 1000000n, releaseBps: 200, skipped: false }];
    const t = slowSetup({
      bridgeEvents: { settled },
      prevSnapshot: { block: 0, lockedBac: 3000n, totalBurned: 0n, buybackBac: 1440000n, owedTotal: 1000000n, reservedTotal: 0n },
    });
    await t.engine.tickSlow();
    assert.equal(t.engine.tripped, true);
    assert.equal(trippedFindings(t.db)[0].rule, 'release_cap');
  });

  it('正好在每纪元释放上限内 → 不暂停', async () => {
    const settled = [{ blockNumber: 6, logIndex: 0, epoch: 1663, pot: 200n, owedTotalAfter: 1000000n, releaseBps: 200, skipped: false }];
    const t = slowSetup({
      bridgeEvents: { settled },
      prevSnapshot: { block: 0, lockedBac: 3000n, totalBurned: 0n, buybackBac: 1440000n, owedTotal: 1000000n, reservedTotal: 0n },
    });
    await t.engine.tickSlow();
    assert.equal(t.engine.tripped, false);
  });

  it('回购滑点击穿下限（读得到参考价）→ 暂停', async () => {
    const boughtBack = [{ blockNumber: 6, logIndex: 0, by: ADDR.alice, venue: 2, bnbSpent: 100000000000000000n, bacBought: 900n, buybackBacAfter: 1440900n, txHash: '0xb1' }];
    const t = slowSetup({ bridgeEvents: { boughtBack, flows: { ...emptyBridgeEvents().flows, bought: 900n } } });
    t.bsc.reference = { expectedGross: 1100n, buyTaxBps: 0n, at: 5 };
    t.bsc2.reference = { expectedGross: 1100n, buyTaxBps: 0n, at: 5 };
    await t.engine.tickSlow();
    assert.equal(t.engine.tripped, true);
    assert.equal(trippedFindings(t.db)[0].rule, 'buyback');
  });

  it('同一笔回购，读不到参考价（非归档 RPC）→ 只跳过，绝不暂停', async () => {
    const boughtBack = [{ blockNumber: 6, logIndex: 0, by: ADDR.alice, venue: 2, bnbSpent: 100000000000000000n, bacBought: 900n, buybackBacAfter: 1440900n, txHash: '0xb1' }];
    const t = slowSetup({ bridgeEvents: { boughtBack, flows: { ...emptyBridgeEvents().flows, bought: 900n } } });
    // reference 默认 null
    await t.engine.tickSlow();
    assert.equal(t.engine.tripped, false);
  });

  it('单笔回购超过 MAX_BUYBACK_BNB：不需要归档节点也能判 → 暂停', async () => {
    const boughtBack = [{ blockNumber: 6, logIndex: 0, by: ADDR.alice, venue: 2, bnbSpent: 900000000000000000n, bacBought: 900n, buybackBacAfter: 1440900n, txHash: '0xb2' }];
    const t = slowSetup({ bridgeEvents: { boughtBack, flows: { ...emptyBridgeEvents().flows, bought: 900n } } });
    await t.engine.tickSlow();
    assert.equal(t.engine.tripped, true);
    assert.equal(trippedFindings(t.db)[0].rule, 'buyback');
  });

  it('层内超发（对账恒等式为负）→ 暂停', async () => {
    const t = slowSetup();
    // 层内桥的余额比应有的少 500：层内多流通了 500，BSC 上没有对应的锁定
    t.layer.balances[ADDR.l2Bridge] = LAYER_TOTAL_SUPPLY - issued - 500n;
    await t.engine.tickSlow();
    assert.equal(t.engine.tripped, true);
    assert.equal(trippedFindings(t.db)[0].rule, 'reconcile');
  });

  it('在途存款让 diff 变正 → 只 WARN，不暂停', async () => {
    const t = slowSetup();
    t.layer.balances[ADDR.l2Bridge] = LAYER_TOTAL_SUPPLY - issued + 800n; // 800 还没到层内
    await t.engine.tickSlow();
    assert.equal(t.engine.tripped, false);
    assert.equal(t.engine.last.reconcile.severity, SEVERITY.WARN);
  });

  it('中继停摆：只告警，绝不暂停', async () => {
    const t = slowSetup();
    t.bsc.lastPosted = 1;
    await t.engine.tickSlow();
    assert.equal(t.engine.tripped, false);
    assert.equal(t.engine.last.cadence.severity, SEVERITY.WARN);
  });
});

describe('发现的生命周期', () => {
  it('复核不成立的发现落为 cleared，而不是留在 pending', async () => {
    const anchors2 = new Map();
    const t = build({ events: [postedEvent(E)], anchors2 });
    t.anchors.set(E, { ...honestAnchor(t.layer, E), exitRoot: '0x' + '99'.repeat(32) });
    await t.engine.tickFast();
    const row = t.db.prepare('SELECT state FROM findings WHERE rule = ? AND subject = ?').get('anchor_root', String(E));
    assert.equal(row.state, FINDING_STATE.CLEARED);
  });

  it('同一个假根被看到两次，只有一条发现、只发一笔 pause', async () => {
    const t = build({ events: [postedEvent(E)] });
    t.anchors.set(E, { ...honestAnchor(t.layer, E), exitRoot: '0x' + '99'.repeat(32) });
    await t.engine.tickFast();
    await t.engine.tickFast(); // 已经 tripped，第二轮直接返回
    assert.equal(t.bsc.pauses.length, 1);
    assert.equal(t.db.prepare('SELECT COUNT(*) c FROM findings').get().c, 1);
  });
});
