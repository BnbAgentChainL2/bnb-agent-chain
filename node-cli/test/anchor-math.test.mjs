// l2Block(epoch) 的规范定义：三处实现必须字节级一致，所以这里把边界全试一遍。
// 用一条假链（3 秒一块），不碰网络。

import test from 'node:test';
import assert from 'node:assert/strict';
import { l2BlockFor, rangeFor, epochTimeline } from '../src/anchor-math.mjs';
import { computeEpoch } from '../src/attest-compute.mjs';
import { NotDeterminedError } from '../src/util.mjs';
import { FakeRpc, fakeChain } from './helpers.mjs';
import { COMMIT_WINDOW, CHALLENGE_WINDOW, EPOCH } from '../src/constants.mjs';
import { EXIT_BURNED_TOPIC, root as treeRoot, ZERO_ROOT } from '../src/exit-tree.mjs';
import { AbiCoder } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
const BRIDGE = '0x00000000000000000000000000000000000000bb';
const L2 = '0x0000000000000000000000000000000000000101';

// 纪元 2 的边界是 3*86400 = 259200。创世时间戳取 2*86400 - 30，3 秒一块。
const START = 2 * EPOCH - 30;
const PERIOD = 3;
const chain = (count) => fakeChain({ startTs: START, period: PERIOD, count });

test('l2Block = 时间戳严格小于 (epoch+1)*86400 的最大区块号', async () => {
  const rpc = new FakeRpc({ blocks: chain(100) });
  // 边界 = 2*86400 = 172800；START = 172770，所以块 0..9 的时间戳是 172770..172797
  const r = await l2BlockFor(rpc, 1);
  assert.equal(r.number, 9);
  assert.equal(Number(BigInt(chain(100)[9].timestamp)), 172797);
});

test('正好落在边界上的区块不算（严格小于）', async () => {
  // 造一条恰好有一个块的时间戳 == 边界的链
  const blocks = fakeChain({ startTs: 2 * EPOCH - 30, period: 3, count: 40 });
  const rpc = new FakeRpc({ blocks });
  const r = await l2BlockFor(rpc, 1);
  const tsOfNext = Number(BigInt(blocks[r.number + 1].timestamp));
  assert.ok(Number(BigInt(blocks[r.number].timestamp)) < 2 * EPOCH);
  assert.ok(tsOfNext >= 2 * EPOCH);
});

test('头部还没越过边界 → 抛 NotDetermined，绝不返回一个会变的值', async () => {
  const rpc = new FakeRpc({ blocks: chain(5) });     // 只到 172782，没到 172800
  await assert.rejects(() => l2BlockFor(rpc, 1), NotDeterminedError);
});

test('纪元早于创世 → 抛 NotDetermined', async () => {
  const rpc = new FakeRpc({ blocks: chain(100) });
  await assert.rejects(() => l2BlockFor(rpc, 0), NotDeterminedError);
});

test('区间是 (l2Block(epoch-1), l2Block(epoch)]', async () => {
  const rpc = new FakeRpc({ blocks: chain(60000) });
  const prev = await l2BlockFor(rpc, 1);
  const cur = await l2BlockFor(rpc, 2);
  const r = await rangeFor(rpc, 2);
  assert.equal(r.from, prev.number + 1);
  assert.equal(r.to, cur.number);
  assert.equal(r.empty, false);
});

test('第一个纪元（上一纪元早于创世）→ from = 0，含创世块', async () => {
  const rpc = new FakeRpc({ blocks: chain(100) });
  const r = await rangeFor(rpc, 1);
  assert.equal(r.from, 0);
});

test('空纪元（长时间停机，纪元内一个块都没有）→ 区间为空且 l2Block 不回退', async () => {
  // 一条只有 3 个块的链：创世在纪元 1，然后停机跨过整个纪元 2，纪元 3 才恢复
  const blocks = [
    { number: '0x0', hash: '0x' + '0'.repeat(64), timestamp: '0x' + (1 * EPOCH + 10).toString(16) },
    { number: '0x1', hash: '0x' + '1'.repeat(64), timestamp: '0x' + (1 * EPOCH + 13).toString(16) },
    { number: '0x2', hash: '0x' + '2'.repeat(64), timestamp: '0x' + (3 * EPOCH + 5).toString(16) },
  ];
  const rpc = new FakeRpc({ blocks });
  const e1 = await l2BlockFor(rpc, 1);
  const e2 = await l2BlockFor(rpc, 2);
  assert.equal(e1.number, 1);
  assert.equal(e2.number, 1, '空纪元的 l2Block 等于上一纪元的');
  const r = await rangeFor(rpc, 2);
  assert.equal(r.empty, true);
  assert.ok(r.from > r.to);
});

test('空纪元算出来的 exitRoot 是 0、叶子是空、且不去查日志', async () => {
  const blocks = [
    { number: '0x0', hash: '0x' + '0'.repeat(64), timestamp: '0x' + (1 * EPOCH + 10).toString(16) },
    { number: '0x1', hash: '0x' + '1'.repeat(64), timestamp: '0x' + (1 * EPOCH + 13).toString(16) },
    { number: '0x2', hash: '0x' + '2'.repeat(64), timestamp: '0x' + (3 * EPOCH + 5).toString(16) },
  ];
  const rpc = new FakeRpc({ blocks });
  const r = await computeEpoch(rpc, 2, { bscBridge: BRIDGE, l2Bridge: L2 });
  assert.equal(r.exitRoot, ZERO_ROOT);
  assert.equal(r.leaves.length, 0);
  assert.equal(r.empty, true);
  assert.ok(!rpc.log.some((c) => c[0] === 'getLogs'), '空纪元不该去拉日志');
});

test('computeEpoch：日志变成叶子、根与 exitTree.root 一致，且区间与规范一致', async () => {
  const blocks = chain(60000);
  const logs = [
    exitLog(1n, 7n, '0x' + '1'.repeat(40), 20n * 10n ** 18n, 1, 3),
    exitLog(2n, 8n, '0x' + '2'.repeat(40), 30n * 10n ** 18n, 1, 7),
    exitLog(3n, 9n, '0x' + '3'.repeat(40), 40n * 10n ** 18n, 2, 9),   // 别的纪元，不该算进来
  ];
  const rpc = new FakeRpc({ blocks, logs });
  const r = await computeEpoch(rpc, 1, { bscBridge: BRIDGE, l2Bridge: L2 });
  assert.equal(r.leaves.length, 2);
  assert.equal(r.exitRoot, treeRoot(r.leaves, 56777, BRIDGE));
  assert.equal(r.l2Block, 9);
  assert.equal(r.l2BlockHash, blocks[9].hash);
  const call = rpc.log.find((c) => c[0] === 'getLogs')[1];
  assert.equal(call.address, L2);
  assert.deepEqual(call.topics, [EXIT_BURNED_TOPIC]);
});

test('没配 bscBridge → 拒绝计算（叶子哈希里有它，算错就是自造异议）', async () => {
  const rpc = new FakeRpc({ blocks: chain(100) });
  await assert.rejects(() => computeEpoch(rpc, 1, {}), /BacBridge/);
});

test('epochTimeline：承诺截止 = 纪元结束 + 2 小时，也是锚点最早能发的时刻', () => {
  const t = epochTimeline(20718, COMMIT_WINDOW, CHALLENGE_WINDOW);
  assert.equal(t.end, 20719 * EPOCH);
  assert.equal(t.commitDeadline, 20719 * EPOCH + 7200);
  assert.equal(t.earliestAnchor, t.commitDeadline);
});

test('二分查找不会退化成逐块扫（6 万块的链上调用次数是对数级）', async () => {
  const rpc = new FakeRpc({ blocks: chain(60000) });
  await l2BlockFor(rpc, 1);
  const calls = rpc.log.filter((c) => c[0] === 'getBlock').length;
  assert.ok(calls < 40, `调用了 ${calls} 次，应该是 log2(60000) ≈ 16 级别`);
});

function exitLog(exitId, agentId, to, amount, epoch, blockNumber) {
  return {
    topics: [
      EXIT_BURNED_TOPIC,
      '0x' + exitId.toString(16).padStart(64, '0'),
      '0x' + agentId.toString(16).padStart(64, '0'),
      '0x' + to.slice(2).toLowerCase().padStart(64, '0'),
    ],
    data: coder.encode(['uint256', 'uint64'], [amount, BigInt(epoch)]),
    blockNumber: '0x' + blockNumber.toString(16),
  };
}
