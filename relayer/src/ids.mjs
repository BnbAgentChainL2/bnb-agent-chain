// 幂等键与 merkle 树：三处实现（relayer / @bac/agent-sdk / @bac/node-cli）必须字节级一致。
// 规范：03-INTERFACES.md §1.2（depositId）、§1.3（exitRoot）、01-CONTRACT-SPEC.md §4.1 / §8.1。

import { AbiCoder, concat, getAddress, keccak256 } from 'ethers';
import { BSC_CHAIN_ID, EXIT_TYPEHASH_SOURCE, LAYER_CHAIN_ID } from './constants.mjs';

const coder = AbiCoder.defaultAbiCoder();

/** EXIT_TYPEHASH（01 §4.1 逐字）。叶子里**没有 epoch 字段** */
export const EXIT_TYPEHASH = keccak256(new TextEncoder().encode(EXIT_TYPEHASH_SOURCE));

/** 32 字节全零，exitCount == 0 时的 exitRoot（03 §1.3） */
export const ZERO_ROOT = '0x' + '0'.repeat(64);

/**
 * 层内幂等键：`keccak256(abi.encode(56, bscBridgeAddr, bscTxHash, logIndex))`（03 §1.2）。
 *
 * **它不是 `BacBridge.Locked` 事件里的那个 `depositId`**。BSC 合约拿不到自己的 tx.hash，
 * 所以事件里的 depositId 是合约自增计数器；层内 `L2Bridge.seen[]` 的键永远是这个 keccak。
 * 写码时不许混用（03 §1.2 那段加粗的话）。
 *
 * @param {string} bridgeAddr BSC 上的 BacBridge 地址
 * @param {string} txHash     BSC 交易哈希（0x + 64 hex）
 * @param {number|bigint} logIndex 该日志在收据里的下标
 * @returns {string} 0x 前缀的 32 字节键
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
 * 退出叶子（01 §8.1 / 03 §1.3，逐字）：
 * `keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, to, credits, 56777, BSC_BRIDGE))`
 *
 * @param {{exitId: bigint|number, agentId: bigint|number, to: string, credits: bigint|string}} leaf
 * @param {string} bridgeAddr BSC 上的 BacBridge
 * @param {number} layerChainId 默认 56777
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

/** 内部节点：OpenZeppelin MerkleProof 的排序对法（03 §1.3） */
export function hashPair(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * 从叶子哈希数组算根。
 * 叶子按 exitId 升序（调用方负责排序，见 `sortLeaves`）；
 * 叶子数为奇数时最后一个**直接上浮**（不复制）；空树的根是 bytes32(0)。
 */
export function merkleRoot(leafHashes) {
  if (leafHashes.length === 0) return ZERO_ROOT;
  let level = leafHashes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) next.push(level[i]); // 奇数个：直接上浮
      else next.push(hashPair(level[i], level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

/** 某个下标的 merkle 证明（与 merkleRoot 同一套规则） */
export function merkleProof(leafHashes, index) {
  const proof = [];
  let level = leafHashes.slice();
  let idx = index;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);
        if (i === idx) idx = next.length - 1; // 上浮的那个没有兄弟，不产生证明元素
      } else {
        next.push(hashPair(level[i], level[i + 1]));
        if (i === idx) {
          proof.push(level[i + 1]);
          idx = next.length - 1;
        } else if (i + 1 === idx) {
          proof.push(level[i]);
          idx = next.length - 1;
        }
      }
    }
    level = next;
  }
  return proof;
}

/** 按 exitId 升序排（排序是根的一部分，不能省） */
export function sortLeaves(leaves) {
  return leaves.slice().sort((a, b) => (BigInt(a.exitId) < BigInt(b.exitId) ? -1 : BigInt(a.exitId) > BigInt(b.exitId) ? 1 : 0));
}

/**
 * 一步到位：从退出叶子列表算出 exitRoot 与每片叶子的哈希。
 * @returns {{root: string, hashes: string[], leaves: object[]}}
 */
export function exitRootOf(leaves, bridgeAddr, layerChainId = LAYER_CHAIN_ID) {
  const sorted = sortLeaves(leaves);
  const hashes = sorted.map((l) => leafHash(l, bridgeAddr, layerChainId));
  return { root: merkleRoot(hashes), hashes, leaves: sorted };
}
