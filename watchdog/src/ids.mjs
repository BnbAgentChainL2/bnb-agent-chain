// 退出叶子与 merkle 根：规范在 docs/01-CONTRACT-SPEC.md §8.1 与 docs/03-INTERFACES.md §1.3。
//
// **这是第四份实现**（relayer / @bac/agent-sdk / @bac/node-cli / 本文件），而且是故意分开写的：
// 看门狗的全部意义就是「不相信中继报的东西」，所以它不能 import 中继的代码 —— 那样中继的一个
// bug 会在两边同时出现，比较永远相等，规则 ANCHOR_ROOT 结构上失效。
// 代价是四份实现有漂移的风险，所以 `test/ids.test.mjs` 里有一条测试会 import 中继的实现，
// 用 200 组随机叶子逐字节对比两边的根；文件不存在时该测试跳过（容器里只挂了 watchdog 目录）。

import { AbiCoder, concat, getAddress, keccak256 } from 'ethers';
import { BSC_CHAIN_ID, EXIT_TYPEHASH_SOURCE, LAYER_CHAIN_ID } from './constants.mjs';

const coder = AbiCoder.defaultAbiCoder();

/** keccak256 of the EXIT_TYPEHASH source string（合约里的 EXIT_TYPEHASH） */
export const EXIT_TYPEHASH = keccak256(new TextEncoder().encode(EXIT_TYPEHASH_SOURCE));

/** 32 字节全零：exitCount == 0 时的 exitRoot */
export const ZERO_ROOT = '0x' + '0'.repeat(64);

/**
 * 层内幂等键 `keccak256(abi.encode(56, bscBridgeAddr, bscTxHash, logIndex))`（03 §1.2）。
 * 对账规则用它问层内「这笔存款到了没」，从而把「在途存款」从 diff 里扣掉。
 * **它不是 `Locked` 事件里那个自增 depositId。**
 */
export function depositKey(bridgeAddr, txHash, logIndex) {
  return keccak256(
    coder.encode(
      ['uint256', 'address', 'bytes32', 'uint256'],
      [BigInt(BSC_CHAIN_ID), getAddress(bridgeAddr), txHash, BigInt(logIndex)],
    ),
  );
}

/**
 * 退出叶子：
 * `keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, to, credits, 56777, BSC_BRIDGE))`
 */
export function leafHash(leaf, bridgeAddr, layerChainId = LAYER_CHAIN_ID) {
  return keccak256(
    coder.encode(
      ['bytes32', 'uint256', 'uint256', 'address', 'uint256', 'uint256', 'address'],
      [
        EXIT_TYPEHASH,
        BigInt(leaf.exitId),
        BigInt(leaf.agentId),
        getAddress(leaf.to),
        BigInt(leaf.credits),
        BigInt(layerChainId),
        getAddress(bridgeAddr),
      ],
    ),
  );
}

/** 内部节点：OpenZeppelin MerkleProof 的排序对法 */
export function hashPair(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * 从叶子哈希数组算根：叶子按 exitId 升序，奇数个时最后一个**直接上浮**（不复制），
 * 空树的根是 bytes32(0)。
 */
export function merkleRoot(leafHashes) {
  if (leafHashes.length === 0) return ZERO_ROOT;
  let level = leafHashes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) next.push(level[i]);
      else next.push(hashPair(level[i], level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

/** 按 exitId 升序（排序是根的一部分，不能省） */
export function sortLeaves(leaves) {
  return leaves
    .slice()
    .sort((a, b) => (BigInt(a.exitId) < BigInt(b.exitId) ? -1 : BigInt(a.exitId) > BigInt(b.exitId) ? 1 : 0));
}

/** 一步到位：叶子列表 → { root, hashes, leaves } */
export function exitRootOf(leaves, bridgeAddr, layerChainId = LAYER_CHAIN_ID) {
  const sorted = sortLeaves(leaves);
  const hashes = sorted.map((l) => leafHash(l, bridgeAddr, layerChainId));
  return { root: merkleRoot(hashes), hashes, leaves: sorted };
}
