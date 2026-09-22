// 见证时序状态机的单元测试。这是本包最要命的一块：
// 早一秒承诺 = 承诺一个还会变的 l2Block；晚一秒 = 交易必然 revert。

import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAction, isTerminal, isTxAction } from '../src/attest-state.mjs';
import { COMMIT_WINDOW, CHALLENGE_WINDOW, EPOCH, ANCHOR_OVERDUE_GRACE } from '../src/constants.mjs';

const N = 20718;
const END = (N + 1) * EPOCH;
const DEADLINE = END + COMMIT_WINDOW;

const base = {
  now: END + 60, epoch: N, headTs: END + 3,
  committed: false, commitMatches: true, hasSalt: false, revealed: false,
  anchorState: 'NONE', postedAt: 0, claimed: false,
};

test('纪元没结束 → 等，不算、不承诺', () => {
  const r = nextAction({ ...base, now: END - 1, headTs: END - 4 });
  assert.equal(r.action, 'wait_epoch_end');
  assert.equal(r.nextCheckAt, END);
});

test('纪元刚结束但本地节点还没追到边界 → wait_sync（宁可停，不可错）', () => {
  const r = nextAction({ ...base, now: END + 10, headTs: END - 3 });
  assert.equal(r.action, 'wait_sync');
  assert.equal(r.severity, 'info');
});

test('读不到本地头部 → wait_sync 且升级成告警', () => {
  const r = nextAction({ ...base, headTs: null });
  assert.equal(r.action, 'wait_sync');
  assert.equal(r.severity, 'warn');
});

test('边界已过且本地追上 → commit，并带上承诺截止时间', () => {
  const r = nextAction({ ...base, now: END + 5, headTs: END + 3 });
  assert.equal(r.action, 'commit');
  assert.equal(r.deadlineAt, DEADLINE);
  assert.ok(isTxAction(r.action));
});

test('承诺窗口的最后一秒仍然可以承诺（合约是严格小于）', () => {
  const r = nextAction({ ...base, now: DEADLINE - 1, headTs: END + 3 });
  assert.equal(r.action, 'commit');
});

test('承诺窗口正好到点 → 已经晚了', () => {
  const r = nextAction({ ...base, now: DEADLINE, headTs: END + 3 });
  assert.equal(r.action, 'commit_missed');
  assert.equal(r.severity, 'warn');
  assert.ok(isTerminal(r.action));
});

test('已承诺、锚点还没发 → 等锚点', () => {
  const r = nextAction({ ...base, committed: true, hasSalt: true, now: END + 100 });
  assert.equal(r.action, 'wait_anchor');
});

test('锚点迟发超过宽限 → 告警但继续等', () => {
  const r = nextAction({
    ...base, committed: true, hasSalt: true, now: DEADLINE + ANCHOR_OVERDUE_GRACE + 1,
  });
  assert.equal(r.action, 'anchor_overdue');
  assert.equal(r.severity, 'warn');
  assert.ok(!isTerminal(r.action));
});

test('锚点 POSTED 且在窗口内 → reveal', () => {
  const posted = DEADLINE + 600;
  const r = nextAction({
    ...base, committed: true, hasSalt: true, anchorState: 'POSTED', postedAt: posted, now: posted + 5,
  });
  assert.equal(r.action, 'reveal');
  assert.equal(r.deadlineAt, posted + CHALLENGE_WINDOW);
});

test('挑战窗口过了才想起来揭示 → reveal_missed', () => {
  const posted = DEADLINE + 600;
  const r = nextAction({
    ...base, committed: true, hasSalt: true, anchorState: 'POSTED', postedAt: posted,
    now: posted + CHALLENGE_WINDOW,
  });
  assert.equal(r.action, 'reveal_missed');
  assert.ok(isTerminal(r.action));
});

test('已揭示 → 等 finalize', () => {
  const posted = DEADLINE + 600;
  const r = nextAction({
    ...base, committed: true, hasSalt: true, revealed: true,
    anchorState: 'POSTED', postedAt: posted, now: posted + 100,
  });
  assert.equal(r.action, 'wait_finalize');
});

test('链上有承诺但本地 salt 丢了 → 停下告警，绝不乱揭示', () => {
  const r = nextAction({ ...base, committed: true, hasSalt: false, anchorState: 'POSTED', postedAt: DEADLINE });
  assert.equal(r.action, 'salt_missing');
  assert.equal(r.severity, 'fail');
  assert.ok(!isTxAction(r.action));
});

test('链上承诺与本地记录对不上（多机同跑一把钥匙）→ 停下告警', () => {
  const r = nextAction({
    ...base, committed: true, hasSalt: true, commitMatches: false,
    anchorState: 'POSTED', postedAt: DEADLINE,
  });
  assert.equal(r.action, 'commit_mismatch');
  assert.equal(r.severity, 'fail');
});

test('FINAL 且已揭示未领 → claimable；已领 → done', () => {
  const a = nextAction({ ...base, committed: true, hasSalt: true, revealed: true, anchorState: 'FINAL' });
  assert.equal(a.action, 'claimable');
  const b = nextAction({ ...base, committed: true, hasSalt: true, revealed: true, anchorState: 'FINAL', claimed: true });
  assert.equal(b.action, 'done');
  assert.ok(isTerminal(b.action));
});

test('FINAL 但没揭示 → 明说这一纪元没有奖励', () => {
  const r = nextAction({ ...base, committed: true, hasSalt: true, revealed: false, anchorState: 'FINAL' });
  assert.equal(r.action, 'done_not_revealed');
  assert.equal(r.severity, 'warn');
});

test('VETOED / DISPUTED 各自有明确终态，不会卡在循环里', () => {
  for (const [st, act] of [['VETOED', 'skip_vetoed'], ['DISPUTED', 'skip_disputed']]) {
    const r = nextAction({ ...base, committed: true, hasSalt: true, anchorState: st });
    assert.equal(r.action, act);
    assert.ok(isTerminal(r.action));
  }
});

test('不认识的锚点状态 → 停下来人工看，不猜', () => {
  const r = nextAction({ ...base, committed: true, hasSalt: true, anchorState: 'WEIRD' });
  assert.equal(r.action, 'unknown_anchor_state');
  assert.equal(r.severity, 'fail');
});

test('整条时间线走一遍：等 → 追块 → 承诺 → 等锚点 → 揭示 → 等定案 → 领', () => {
  const seen = [];
  let ctx = { ...base, now: END - 100, headTs: END - 103 };
  seen.push(nextAction(ctx).action);
  ctx = { ...ctx, now: END + 1, headTs: END - 2 };
  seen.push(nextAction(ctx).action);
  ctx = { ...ctx, now: END + 4, headTs: END + 1 };
  seen.push(nextAction(ctx).action);
  ctx = { ...ctx, committed: true, hasSalt: true, now: END + 60 };
  seen.push(nextAction(ctx).action);
  const posted = DEADLINE + 300;
  ctx = { ...ctx, anchorState: 'POSTED', postedAt: posted, now: posted + 10 };
  seen.push(nextAction(ctx).action);
  ctx = { ...ctx, revealed: true, now: posted + 20 };
  seen.push(nextAction(ctx).action);
  ctx = { ...ctx, anchorState: 'FINAL', now: posted + CHALLENGE_WINDOW + 10 };
  seen.push(nextAction(ctx).action);
  assert.deepEqual(seen, [
    'wait_epoch_end', 'wait_sync', 'commit', 'wait_anchor', 'reveal', 'wait_finalize', 'claimable',
  ]);
});
