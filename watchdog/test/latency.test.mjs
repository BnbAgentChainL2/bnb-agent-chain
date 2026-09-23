// 探测延迟：把关键路径上的**往返次数**和**纯计算耗时**测出来，而不是拍脑袋写一个数。
//
// 指标从哪来（artifacts/sim/RESULTS-buyback.md §3.3，逐字）：
//   零损失的唯一条件是赶在 120 秒内 veto。预算 = 探测延迟 L + 上链延迟 I(≈7 s) + 30 s 余量 < 120 s
//   ⇒ L ≤ 83 s。工程指标取「轮询间隔 ≤ 10 s、端到端探测延迟 ≤ 30 s」。
//
// 这个测试能测的是**进程内**那一段（解析、复算 merkle 根、状态机）和**往返次数**；
// 每次往返实际花多少毫秒取决于 RPC，测不出来也不该假装测得出来。README 里把两段分开写。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EPOCH, LATENCY_BUDGET_SEC, LATENCY_TARGET_SEC } from '../src/constants.mjs';
import { openDb } from '../src/db.mjs';
import { makeEngine } from '../src/engine.mjs';
import { setSink } from '../src/log.mjs';
import { ADDR, FakeBsc, FakeLayer, fakeCfg, honestAnchor, makeBlocks } from './fakes.mjs';

setSink(() => {});

const E = 1000;
const START = (E - 1) * EPOCH;

/** 把一个假适配器包起来，数它被调了多少次「网络」往返 */
function counted(obj, counter) {
  return new Proxy(obj, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      return (...args) => {
        counter.n++;
        return v.apply(t, args);
      };
    },
  });
}

describe('探测延迟', () => {
  it('一个假根从「事件可见」到「pause 已发出」：往返次数与纯计算耗时', async () => {
    // 600 个块 ≈ 层内 30 分钟，二分查找要 log2(600) ≈ 10 次 getBlock
    const layer = new FakeLayer({
      blocks: makeBlocks(600, START, 3),
      exits: [
        { exitId: 1n, agentId: 7n, to: ADDR.alice, credits: 1000n, epoch: E, layerBlock: 250 },
        { exitId: 2n, agentId: 8n, to: ADDR.alice, credits: 2000n, epoch: E, layerBlock: 300 },
      ],
      mints: [{ amount: 500n, layerBlock: 260 }],
    });
    const anchors = new Map([[E, { ...honestAnchor(layer, E), exitRoot: '0x' + '99'.repeat(32) }]]);
    const events = [{ name: 'AnchorPosted', args: { epoch: E }, blockNumber: 5, logIndex: 0 }];

    // BSC 与层内分开数：两者的 RTT 差一个数量级（公共 BSC RPC 约 60 ms，
    // 层内节点在同一个 compose 网络里约 1–2 ms），混在一起算会把延迟估高 10 倍。
    const cb = { n: 0 };
    const cl = { n: 0 };
    const c = { get n() { return cb.n + cl.n; } };
    const bsc = counted(new FakeBsc({ head: 10, anchors, events }), cb);
    const bsc2 = counted(new FakeBsc({ head: 10, anchors, events, which: 'secondary' }), cb);
    const L1 = counted(layer, cl);
    const L2 = counted(new FakeLayer({ blocks: layer.blocks, exits: layer.exits, mints: layer.mints, which: 'secondary' }), cl);

    const engine = makeEngine({
      cfg: fakeCfg(),
      db: openDb(':memory:'),
      bsc,
      bsc2,
      layer: L1,
      layer2: L2,
      now: () => (E + 1) * EPOCH + 10,
      sleepFn: async () => {},
      notifyFn: async () => ({ sent: true }),
    });

    const t0 = process.hrtime.bigint();
    await engine.tickFast();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    assert.equal(engine.tripped, true);
    console.log(`  [实测] 关键路径往返：BSC ${cb.n} 次 + 层内 ${cl.n} 次 = ${c.n} 次`);
    console.log(`  [实测] 纯计算耗时 = ${ms.toFixed(1)} ms`);
    console.log(`  [推算] BSC 60 ms / 层内 2 ms 的 RTT 下 = ${(ms + cb.n * 60 + cl.n * 2).toFixed(0)} ms`);
    console.log(`  [推算] 全部按 60 ms 的最坏情况 = ${(ms + c.n * 60).toFixed(0)} ms`);

    // 进程内那一段必须远小于预算。这里给 2 秒，是为了在慢一点的 CI 机器上也不 flaky；
    // 真实测到的值会打印在上面那行，README 里引用的就是它。
    assert.ok(ms < 2000, `纯计算耗时 ${ms} ms 太长`);
    // 往返次数是延迟的真正驱动项。给 200 次的上限：60 ms RTT 下是 12 秒，仍在 30 秒指标内。
    assert.ok(c.n < 200, `关键路径往返次数 ${c.n} 太多，60 ms RTT 下会吃掉探测延迟预算`);
  });

  it('l2Block 记忆化真的减少了往返（第二次评估同一个纪元几乎不再查块）', async () => {
    const layer = new FakeLayer({ blocks: makeBlocks(600, START, 3), exits: [], mints: [] });
    const anchors = new Map([[E, honestAnchor(layer, E)]]);
    const engine = makeEngine({
      cfg: fakeCfg(),
      db: openDb(':memory:'),
      bsc: new FakeBsc({ head: 10, anchors }),
      bsc2: new FakeBsc({ head: 10, anchors, which: 'secondary' }),
      layer,
      layer2: layer,
      now: () => (E + 1) * EPOCH + 10,
      sleepFn: async () => {},
      notifyFn: async () => ({ sent: true }),
    });
    await engine.evaluateAnchor(E, false);
    const first = layer.calls.getBlock;
    await engine.evaluateAnchor(E, false);
    const second = layer.calls.getBlock - first;
    console.log(`  [实测] 首次二分查块 ${first} 次，第二次 ${second} 次`);
    assert.ok(second < first, '缓存必须真的起作用，否则关键路径每轮都要重新二分');
  });

  it('轮询间隔的默认值落在模拟给的指标内', () => {
    const cfg = fakeCfg();
    assert.ok(cfg.poll.fastMs <= 10000, '模拟报告 §3.3：轮询间隔 ≤ 10 秒');
    assert.ok(LATENCY_TARGET_SEC <= LATENCY_BUDGET_SEC);
    // 预算复算：L + I(7 s) + 30 s 余量 < 120 s
    assert.ok(LATENCY_TARGET_SEC + 7 + 30 < 120);
  });
});
