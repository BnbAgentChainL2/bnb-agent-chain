// 确认状态机（03 §1.2）的逐条分支测试，**每一条 fail-closed 分支都要打到**。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONFIRM, WARN } from '../src/constants.mjs';
import { FinalityTracker, evaluateCredit, finalityAvailable } from '../src/finality.mjs';

const T0 = 1790000000;

function snap(over = {}) {
  return {
    ts: T0,
    headA: 1000,
    headB: 1000,
    finalizedA: { number: 990, hash: '0xaa' },
    finalizedB: { number: 991, hash: '0xaa' },
    crossCheck: 'agree',
    ...over,
  };
}

function job(over = {}) {
  return { src: { blockNumber: 900, seenAt: T0 - 100, ...over } };
}

function run(s, j) {
  const t = new FinalityTracker();
  t.update(s);
  return { r: evaluateCredit(s, j, t), t };
}

describe('三条确认条件（finalized 一路）', () => {
  it('三条都满足 → ready', () => {
    const { r } = run(snap(), job());
    assert.equal(r.decision, 'ready');
    assert.equal(r.path, 'finalized');
  });

  it('finalized 还没覆盖该区块 → wait', () => {
    const { r } = run(snap({ finalizedA: { number: 800, hash: '0xaa' } }), job({ blockNumber: 900 }));
    assert.equal(r.decision, 'wait');
    assert.match(r.reason, /尚未覆盖/);
  });

  it('深度 < 15 → wait', () => {
    const { r } = run(snap({ headA: 910, headB: 910 }), job({ blockNumber: 900 }));
    assert.equal(r.decision, 'wait');
    assert.match(r.reason, /深度/);
  });

  it('深度刚好 15 → 不再因深度被挡', () => {
    const { r } = run(snap({ headA: 915, headB: 915 }), job({ blockNumber: 900 }));
    assert.equal(r.decision, 'ready');
  });

  it('墙钟 < 45 秒 → wait', () => {
    const { r } = run(snap(), job({ seenAt: T0 - 44 }));
    assert.equal(r.decision, 'wait');
    assert.match(r.reason, /距首次看见/);
  });

  it('墙钟刚好 45 秒 → ready', () => {
    const { r } = run(snap(), job({ seenAt: T0 - CONFIRM.WALL_SEC }));
    assert.equal(r.decision, 'ready');
  });

  it('深度取两个 RPC 里较小的 head：一个领先不能替另一个背书', () => {
    const { r } = run(snap({ headA: 1000, headB: 905 }), job({ blockNumber: 900 }));
    assert.equal(r.decision, 'wait');
  });
});

describe('两个 RPC 必须一致', () => {
  it('只有一个 RPC 给出 finalized → 不算可用', () => {
    assert.equal(finalityAvailable(snap({ finalizedB: null })), false);
  });

  it('两个 RPC 在共同高度上的哈希不一致 → 走兜底并打 disagreement 告警', () => {
    const s = snap({ crossCheck: 'disagree' });
    const { r } = run(s, job({ blockNumber: 900, seenAt: T0 - 700 }));
    assert.ok(r.warnings.includes(WARN.BSC_FINALITY_DISAGREEMENT));
    // 深度只有 100 < 1200，所以还不能发
    assert.equal(r.decision, 'wait');
  });
});

describe('fail-closed 兜底与停发', () => {
  it('finalized 取不到 + 深度 >= 1200 + 墙钟 >= 600 → ready（兜底路径）', () => {
    const s = snap({ finalizedA: null, finalizedB: null, crossCheck: 'unknown', headA: 2200, headB: 2200 });
    const { r } = run(s, job({ blockNumber: 900, seenAt: T0 - 600 }));
    assert.equal(r.decision, 'ready');
    assert.equal(r.path, 'fallback');
  });

  it('兜底深度差 1 块 → wait', () => {
    const s = snap({ finalizedA: null, finalizedB: null, headA: 900 + CONFIRM.FALLBACK_DEPTH - 1, headB: 900 + CONFIRM.FALLBACK_DEPTH - 1 });
    const { r } = run(s, job({ blockNumber: 900, seenAt: T0 - 900 }));
    assert.equal(r.decision, 'wait');
    assert.match(r.reason, /兜底深度/);
  });

  it('兜底墙钟差 1 秒 → wait', () => {
    const s = snap({ finalizedA: null, finalizedB: null, headA: 3000, headB: 3000 });
    const { r } = run(s, job({ blockNumber: 900, seenAt: T0 - (CONFIRM.FALLBACK_WALL_SEC - 1) }));
    assert.equal(r.decision, 'wait');
    assert.match(r.reason, /兜底墙钟/);
  });

  it('连续 10 分钟取不到 finalized → halt + bsc_finality_unavailable（不看深度）', () => {
    const t = new FinalityTracker();
    const s1 = snap({ ts: T0, finalizedA: null, finalizedB: null, headA: 99999, headB: 99999 });
    t.update(s1);
    const s2 = { ...s1, ts: T0 + CONFIRM.OUTAGE_HALT_SEC };
    t.update(s2);
    const r = evaluateCredit(s2, job({ blockNumber: 900, seenAt: T0 - 5000 }), t);
    assert.equal(r.decision, 'halt');
    assert.ok(r.warnings.includes(WARN.BSC_FINALITY_UNAVAILABLE));
  });

  it('停发前一秒仍然走兜底（10 分钟是严格的 >=）', () => {
    const t = new FinalityTracker();
    const s1 = snap({ ts: T0, finalizedA: null, finalizedB: null, headA: 99999, headB: 99999 });
    t.update(s1);
    const s2 = { ...s1, ts: T0 + CONFIRM.OUTAGE_HALT_SEC - 1 };
    t.update(s2);
    const r = evaluateCredit(s2, job({ blockNumber: 900, seenAt: T0 - 5000 }), t);
    assert.equal(r.decision, 'ready');
    assert.equal(r.path, 'fallback');
  });

  it('finalized 恢复后计时清零，不会残留 halt', () => {
    const t = new FinalityTracker();
    t.update(snap({ ts: T0, finalizedA: null, finalizedB: null }));
    t.update(snap({ ts: T0 + 3000 })); // 恢复
    assert.equal(t.outageSince, null);
    assert.equal(t.halted(T0 + 3000), false);
  });

  it('兜底门槛必须显著严于正常门槛（旧的「深度 >= 120」等于没有兜底）', () => {
    // 实测 BSC 块时间 0.45 s：120 块只有 54 秒，比它要兜底的 45 秒规则强 9 秒。
    assert.ok(CONFIRM.FALLBACK_DEPTH * 0.45 > CONFIRM.WALL_SEC * 10);
    assert.equal(CONFIRM.FALLBACK_DEPTH, 1200);
    assert.equal(CONFIRM.FALLBACK_WALL_SEC, 600);
  });
});
