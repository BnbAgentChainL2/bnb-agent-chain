// 叶子与 merkle 根：固定向量 + 与中继那份实现的逐字节交叉核对。
//
// 看门狗**故意**不 import 中继的代码（否则中继的一个 bug 会在两边同时出现，比较永远相等）。
// 代价是两份实现可能漂移，所以这里用随机叶子把两边对一遍。中继目录不在（容器里只挂了
// watchdog）时这条测试跳过，不会把整套测试拖红。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXIT_TYPEHASH, ZERO_ROOT, depositKey, exitRootOf, hashPair, merkleRoot } from '../src/ids.mjs';

const BRIDGE = '0x00000000000000000000000000000000000b1d6e';

describe('叶子与根', () => {
  it('EXIT_TYPEHASH 是规范里那一串的 keccak（叶子里没有 epoch 字段）', () => {
    assert.equal(EXIT_TYPEHASH, '0x' + EXIT_TYPEHASH.slice(2));
    assert.equal(EXIT_TYPEHASH.length, 66);
  });

  it('空树的根是 bytes32(0)', () => {
    assert.equal(merkleRoot([]), ZERO_ROOT);
    assert.equal(exitRootOf([], BRIDGE).root, ZERO_ROOT);
  });

  it('单叶树的根就是那片叶子', () => {
    const h = '0x' + 'ab'.repeat(32);
    assert.equal(merkleRoot([h]), h);
  });

  it('内部节点是排序对（与 OpenZeppelin MerkleProof 一致）', () => {
    const a = '0x' + '11'.repeat(32);
    const b = '0x' + '22'.repeat(32);
    assert.equal(hashPair(a, b), hashPair(b, a));
  });

  it('奇数片叶子时最后一片直接上浮，不复制', () => {
    const leaves = [1, 2, 3].map((i) => ({ exitId: i, agentId: i, to: BRIDGE, credits: BigInt(i) }));
    const { hashes, root } = exitRootOf(leaves, BRIDGE);
    assert.equal(hashes.length, 3);
    // 上浮：root = pair(pair(h0,h1), h2)
    assert.equal(root, hashPair(hashPair(hashes[0], hashes[1]), hashes[2]));
  });

  it('叶子顺序由 exitId 决定，输入顺序不影响根', () => {
    const mk = (ids) => ids.map((i) => ({ exitId: i, agentId: 1, to: BRIDGE, credits: 7n }));
    assert.equal(exitRootOf(mk([3, 1, 2]), BRIDGE).root, exitRootOf(mk([1, 2, 3]), BRIDGE).root);
  });

  it('depositKey 是 keccak(abi.encode(56, bridge, txHash, logIndex))，不是事件里那个自增号', () => {
    const k1 = depositKey(BRIDGE, '0x' + 'aa'.repeat(32), 0);
    const k2 = depositKey(BRIDGE, '0x' + 'aa'.repeat(32), 1);
    assert.notEqual(k1, k2);
    assert.equal(k1.length, 66);
  });
});

describe('与中继实现的交叉核对', async () => {
  let relayer = null;
  try {
    relayer = await import('../../relayer/src/ids.mjs');
  } catch {
    relayer = null;
  }

  it('200 组随机叶子，两份独立实现算出同一个根', { skip: relayer ? false : '仓库里没有 relayer/src/ids.mjs（容器里只挂了 watchdog）' }, () => {
    let seed = 12345;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const count = rnd(9);
      const leaves = [];
      for (let i = 0; i < count; i++) {
        leaves.push({
          exitId: rnd(100000),
          agentId: rnd(1000),
          to: '0x' + rnd(0xffffff).toString(16).padStart(40, '0'),
          credits: BigInt(rnd(1000000)) * 10n ** 12n,
        });
      }
      const mine = exitRootOf(leaves, BRIDGE).root;
      const theirs = relayer.exitRootOf(
        leaves.map((l) => ({ ...l, credits: l.credits.toString() })),
        BRIDGE,
      ).root;
      assert.equal(mine, theirs, `第 ${round} 组（${count} 片叶子）两份实现的根不一致`);
    }
  });
});
