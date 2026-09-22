// depositId 与 exitRoot 的对拍：三处实现必须字节级一致，所以这里用**独立算一遍**的方式核对。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AbiCoder, concat, keccak256, toUtf8Bytes } from 'ethers';
import { EXIT_TYPEHASH, ZERO_ROOT, depositKey, exitRootOf, leafHash, merkleProof, merkleRoot } from '../src/ids.mjs';
import { ADDR } from './fakes.mjs';

const coder = AbiCoder.defaultAbiCoder();
const TX = '0x' + '11'.repeat(32);

describe('depositId（层内幂等键）', () => {
  it('等于 keccak256(abi.encode(56, bridge, txHash, logIndex))', () => {
    const expected = keccak256(
      coder.encode(['uint256', 'address', 'bytes32', 'uint256'], [56n, ADDR.bacBridge, TX, 4n]),
    );
    assert.equal(depositKey(ADDR.bacBridge, TX, 4), expected);
  });

  it('同一笔交易的不同 logIndex 给出不同的键', () => {
    assert.notEqual(depositKey(ADDR.bacBridge, TX, 4), depositKey(ADDR.bacBridge, TX, 5));
  });

  it('确定性：同样的输入永远同一个值（重启后重算也一样）', () => {
    assert.equal(depositKey(ADDR.bacBridge, TX, 0), depositKey(ADDR.bacBridge, TX, 0));
  });
});

describe('EXIT_TYPEHASH 与叶子', () => {
  it('typehash 逐字等于 01 §4.1 里的那条字符串', () => {
    assert.equal(
      EXIT_TYPEHASH,
      keccak256(toUtf8Bytes('Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)')),
    );
  });

  it('叶子里没有 epoch：bornEpoch 改了，叶子哈希不变', () => {
    const a = { exitId: 41, agentId: 17, to: ADDR.agentWallet, credits: '20000', bornEpoch: 20718 };
    const b = { ...a, bornEpoch: 20999 };
    assert.equal(leafHash(a, ADDR.bacBridge), leafHash(b, ADDR.bacBridge));
  });

  it('叶子 = keccak256(abi.encode(TYPEHASH, exitId, agentId, to, credits, 56777, bridge))', () => {
    const expected = keccak256(
      coder.encode(
        ['bytes32', 'uint256', 'uint256', 'address', 'uint256', 'uint256', 'address'],
        [EXIT_TYPEHASH, 41n, 17n, ADDR.agentWallet, 20000n, 56777n, ADDR.bacBridge],
      ),
    );
    assert.equal(leafHash({ exitId: 41, agentId: 17, to: ADDR.agentWallet, credits: 20000n }, ADDR.bacBridge), expected);
  });
});

describe('merkle 树（OpenZeppelin 排序对法）', () => {
  const h = (n) => keccak256(toUtf8Bytes('leaf' + n));

  it('空树的根是 bytes32(0)', () => {
    assert.equal(merkleRoot([]), ZERO_ROOT);
  });

  it('单叶子的根就是它自己', () => {
    assert.equal(merkleRoot([h(1)]), h(1));
  });

  it('两片叶子：排序后拼接再 keccak', () => {
    const [a, b] = [h(1), h(2)];
    const expected = a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
    assert.equal(merkleRoot([a, b]), expected);
  });

  it('奇数片叶子：最后一个直接上浮，不复制', () => {
    const [a, b, c] = [h(1), h(2), h(3)];
    const ab = a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
    const expected = ab.toLowerCase() < c.toLowerCase() ? keccak256(concat([ab, c])) : keccak256(concat([c, ab]));
    assert.equal(merkleRoot([a, b, c]), expected);
  });

  it('证明能被独立验证（1..7 片叶子，每一片都验）', () => {
    for (let n = 1; n <= 7; n++) {
      const hashes = Array.from({ length: n }, (_, i) => h(i));
      const root = merkleRoot(hashes);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(hashes, i);
        let acc = hashes[i];
        for (const p of proof) acc = acc.toLowerCase() < p.toLowerCase() ? keccak256(concat([acc, p])) : keccak256(concat([p, acc]));
        assert.equal(acc, root, `n=${n} i=${i} 的证明验不过`);
      }
    }
  });

  it('exitRootOf 按 exitId 升序排（顺序是根的一部分）', () => {
    const leaves = [
      { exitId: 9, agentId: 1, to: ADDR.agentWallet, credits: '1' },
      { exitId: 2, agentId: 1, to: ADDR.agentWallet, credits: '2' },
      { exitId: 5, agentId: 1, to: ADDR.agentWallet, credits: '3' },
    ];
    const r1 = exitRootOf(leaves, ADDR.bacBridge);
    const r2 = exitRootOf(leaves.slice().reverse(), ADDR.bacBridge);
    assert.deepEqual(r1.leaves.map((l) => l.exitId), [2, 5, 9]);
    assert.equal(r1.root, r2.root, '输入顺序不同，根必须相同');
  });
});
