// 退出 merkle 树：逐字实现 docs/03-INTERFACES.md §1.3 与 docs/01-CONTRACT-SPEC.md §8.1。
// relayer / @bac/agent-sdk / @bac/node-cli 三处必须字节级一致，改这里就要改另外两处。
//
// leaf_i = keccak256(abi.encode(
//     EXIT_TYPEHASH, exitId, agentId, to, credits, uint256(56777), BAC_BRIDGE_ADDRESS))
//   ← 叶子里**没有 epoch 字段**；bornEpoch 只是分桶与展示信息。
// 叶子按 exitId 升序；内部节点 = keccak256(a < b ? a‖b : b‖a)（OpenZeppelin 的排序对法）；
// 叶子数为奇数时最后一个直接上浮（不复制）；exitCount == 0 时 root = bytes32(0)。

import { AbiCoder, keccak256, getAddress, concat, id as keccakUtf8 } from 'ethers';
import { LAYER_CHAIN_ID } from './constants.mjs';
import { BacError } from './util.mjs';

const coder = AbiCoder.defaultAbiCoder();

export const EXIT_TYPEHASH = keccakUtf8(
  'Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)'
);

export const ZERO_ROOT = '0x' + '00'.repeat(32);

/** @typedef {{exitId: bigint, agentId: bigint, to: string, credits: bigint}} Leaf */

export function leafHash(leaf, layerChainId = LAYER_CHAIN_ID, bridge) {
  if (!bridge) throw new BacError('leafHash 需要 BSC 侧 BacBridge 地址', 'bad_config');
  return keccak256(coder.encode(
    ['bytes32', 'uint256', 'uint256', 'address', 'uint256', 'uint256', 'address'],
    [EXIT_TYPEHASH, BigInt(leaf.exitId), BigInt(leaf.agentId), getAddress(leaf.to),
     BigInt(leaf.credits), BigInt(layerChainId), getAddress(bridge)]
  ));
}

function hashPair(a, b) {
  return keccak256(BigInt(a) < BigInt(b) ? concat([a, b]) : concat([b, a]));
}

function sortLeaves(leaves) {
  return [...leaves].sort((x, y) => (BigInt(x.exitId) < BigInt(y.exitId) ? -1 : BigInt(x.exitId) > BigInt(y.exitId) ? 1 : 0));
}

/** 逐层构树，返回每一层的哈希数组（第 0 层是叶子） */
function buildLayers(leafHashes) {
  const layers = [leafHashes];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      // 奇数个时最后一个直接上浮，不复制自己
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  return layers;
}

export function root(leaves, layerChainId = LAYER_CHAIN_ID, bridge) {
  if (!leaves || leaves.length === 0) return ZERO_ROOT;
  const sorted = sortLeaves(leaves);
  const layers = buildLayers(sorted.map((l) => leafHash(l, layerChainId, bridge)));
  return layers[layers.length - 1][0];
}

export function proof(leaves, exitId, layerChainId = LAYER_CHAIN_ID, bridge) {
  const sorted = sortLeaves(leaves);
  let idx = sorted.findIndex((l) => BigInt(l.exitId) === BigInt(exitId));
  if (idx < 0) throw new BacError(`退出 #${exitId} 不在这一批叶子里`, 'not_found');
  const layers = buildLayers(sorted.map((l) => leafHash(l, layerChainId, bridge)));
  const path = [];
  for (let d = 0; d < layers.length - 1; d++) {
    const layer = layers[d];
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sib < layer.length) path.push(layer[sib]);   // 上浮的那一个没有兄弟，不进证明
    idx = Math.floor(idx / 2);
  }
  return path;
}

/** 校验证明（本地自检用，和 OpenZeppelin MerkleProof.processProof 同一套） */
export function verify(proofPath, rootHash, leaf) {
  let h = leaf;
  for (const p of proofPath) h = hashPair(h, p);
  return h.toLowerCase() === rootHash.toLowerCase();
}

/**
 * 从 L2Bridge.ExitBurned 日志重建叶子。
 * 事件：ExitBurned(uint256 indexed exitId, uint256 indexed agentId, address indexed bscRecipient,
 *                  uint256 amount, uint64 epoch)
 * @param {{topics: string[], data: string}[]} logs
 * @param {number|null} epochFilter 只取这个纪元的（分桶以事件里的 epoch 字段为准，别无他解）
 */
export function fromLogs(logs, epochFilter = null) {
  const out = [];
  for (const log of logs) {
    const [amount, epoch] = coder.decode(['uint256', 'uint64'], log.data);
    const exitId = BigInt(log.topics[1]);
    const agentId = BigInt(log.topics[2]);
    const to = getAddress('0x' + log.topics[3].slice(26));
    if (epochFilter !== null && Number(epoch) !== Number(epochFilter)) continue;
    out.push({ exitId, agentId, to, credits: BigInt(amount), bornEpoch: Number(epoch) });
  }
  return sortLeaves(out);
}

export const EXIT_BURNED_TOPIC = keccakUtf8('ExitBurned(uint256,uint256,address,uint256,uint64)');
