// exitRoot 的构造：中继 / SDK / 本包三处必须得出同一个根，所以这里钉死向量与边界。

import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, id } from 'ethers';
import { EXIT_TYPEHASH, ZERO_ROOT, leafHash, root, proof, verify, fromLogs, EXIT_BURNED_TOPIC }
  from '../src/exit-tree.mjs';
import { LAYER_CHAIN_ID } from '../src/constants.mjs';

const BRIDGE = '0x00000000000000000000000000000000000000bb';
const coder = AbiCoder.defaultAbiCoder();

const mk = (n) => Array.from({ length: n }, (_, i) => ({
  exitId: BigInt(i + 1),
  agentId: BigInt(i + 100),
  to: '0x' + (i + 1).toString(16).padStart(40, '0'),
  credits: BigInt(i + 1) * 10n ** 18n,
}));

test('EXIT_TYPEHASH 逐字等于规格里那一行', () => {
  assert.equal(EXIT_TYPEHASH,
    id('Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)'));
});

test('叶子里没有 epoch 字段：同一笔退出在不同纪元重报，叶子一个字节都不变', () => {
  const l = mk(1)[0];
  const a = leafHash({ ...l, bornEpoch: 20718 }, LAYER_CHAIN_ID, BRIDGE);
  const b = leafHash({ ...l, bornEpoch: 20999 }, LAYER_CHAIN_ID, BRIDGE);
  assert.equal(a, b);
});

test('叶子哈希与 abi.encode 的手工编码一致', () => {
  const l = mk(1)[0];
  const manual = keccak256(coder.encode(
    ['bytes32', 'uint256', 'uint256', 'address', 'uint256', 'uint256', 'address'],
    [EXIT_TYPEHASH, l.exitId, l.agentId, l.to, l.credits, BigInt(LAYER_CHAIN_ID), BRIDGE]));
  assert.equal(leafHash(l, LAYER_CHAIN_ID, BRIDGE), manual);
});

test('exitCount == 0 → root 是 bytes32(0)', () => {
  assert.equal(root([], LAYER_CHAIN_ID, BRIDGE), ZERO_ROOT);
});

test('只有一笔退出 → root 就是那个叶子', () => {
  const ls = mk(1);
  assert.equal(root(ls, LAYER_CHAIN_ID, BRIDGE), leafHash(ls[0], LAYER_CHAIN_ID, BRIDGE));
});

test('内部节点用排序对法：换叶子顺序不改根', () => {
  const ls = mk(5);
  const a = root(ls, LAYER_CHAIN_ID, BRIDGE);
  const b = root([...ls].reverse(), LAYER_CHAIN_ID, BRIDGE);
  assert.equal(a, b);
});

test('奇数叶子时最后一个直接上浮（不复制自己）', () => {
  // 3 个叶子：layer1 = [H(l1,l2), l3]，root = H(H(l1,l2), l3)
  const ls = mk(3);
  const h = ls.map((l) => leafHash(l, LAYER_CHAIN_ID, BRIDGE));
  const pair = (a, b) => keccak256(BigInt(a) < BigInt(b)
    ? a + b.slice(2) : b + a.slice(2));
  assert.equal(root(ls, LAYER_CHAIN_ID, BRIDGE), pair(pair(h[0], h[1]), h[2]));
});

test('每一个叶子的证明都能验过（1..9 笔全试）', () => {
  for (let n = 1; n <= 9; n++) {
    const ls = mk(n);
    const r = root(ls, LAYER_CHAIN_ID, BRIDGE);
    for (const l of ls) {
      const p = proof(ls, l.exitId, LAYER_CHAIN_ID, BRIDGE);
      assert.ok(verify(p, r, leafHash(l, LAYER_CHAIN_ID, BRIDGE)), `n=${n} exitId=${l.exitId}`);
    }
  }
});

test('换一个 bridge 地址 → 根必须变（叶子里钉着它）', () => {
  const ls = mk(4);
  const a = root(ls, LAYER_CHAIN_ID, BRIDGE);
  const b = root(ls, LAYER_CHAIN_ID, '0x00000000000000000000000000000000000000cc');
  assert.notEqual(a, b);
});

test('换 chainId → 根必须变', () => {
  const ls = mk(4);
  assert.notEqual(root(ls, LAYER_CHAIN_ID, BRIDGE), root(ls, 56778, BRIDGE));
});

test('不在这批叶子里的 exitId → 明确报错，不返回一个假证明', () => {
  assert.throws(() => proof(mk(3), 99n, LAYER_CHAIN_ID, BRIDGE), /不在这一批叶子里/);
});

test('缺 bridge 地址 → 拒绝算，不拿 0 地址凑合', () => {
  assert.throws(() => leafHash(mk(1)[0], LAYER_CHAIN_ID, undefined), /BacBridge/);
});

test('从 ExitBurned 日志重建叶子：按 exitId 升序，并按事件里的 epoch 分桶', () => {
  const logs = [
    exitLog(2n, 101n, '0x' + '2'.repeat(40), 5n * 10n ** 18n, 20718),
    exitLog(1n, 100n, '0x' + '1'.repeat(40), 7n * 10n ** 18n, 20718),
    exitLog(3n, 102n, '0x' + '3'.repeat(40), 9n * 10n ** 18n, 20719),   // 下一个纪元的，不该进来
  ];
  const ls = fromLogs(logs, 20718);
  assert.equal(ls.length, 2);
  assert.deepEqual(ls.map((l) => Number(l.exitId)), [1, 2]);
  assert.equal(ls[0].credits, 7n * 10n ** 18n);
  assert.equal(ls[0].bornEpoch, 20718);
});

test('不给纪元过滤时全都要', () => {
  const logs = [exitLog(1n, 1n, '0x' + '1'.repeat(40), 1n, 1), exitLog(2n, 2n, '0x' + '2'.repeat(40), 2n, 2)];
  assert.equal(fromLogs(logs).length, 2);
});

test('ExitBurned 的 topic0 与事件签名一致', () => {
  assert.equal(EXIT_BURNED_TOPIC, id('ExitBurned(uint256,uint256,address,uint256,uint64)'));
});

function exitLog(exitId, agentId, to, amount, epoch) {
  return {
    topics: [
      EXIT_BURNED_TOPIC,
      '0x' + exitId.toString(16).padStart(64, '0'),
      '0x' + agentId.toString(16).padStart(64, '0'),
      '0x' + to.slice(2).toLowerCase().padStart(64, '0'),
    ],
    data: coder.encode(['uint256', 'uint64'], [amount, BigInt(epoch)]),
    blockNumber: '0x1',
  };
}
