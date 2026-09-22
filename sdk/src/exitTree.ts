// 退出 merkle 树（03 §1.3 / 01 §4.1）。
//
// 叶子里**没有 epoch**：EXIT_TYPEHASH 已经去掉该字段，bornEpoch 只用于分桶与展示。
// 被 veto 的纪元里的退出并入后续锚点时，叶子一个字节都不变。
//
// leaf_i  = keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, to, credits, layerChainId, bridge))
// 排序    = 按 exitId 升序
// 内部节点 = keccak256(a < b ? a||b : b||a)   （OpenZeppelin MerkleProof 的排序对法）
// 奇数个叶子时最后一个直接上浮（不复制）
// exitCount == 0 时 root = bytes32(0)

import { AbiCoder, concat, getAddress, Interface, keccak256, ZeroHash } from "ethers";
import { L2BRIDGE_ABI } from "./abi.js";

const abi = AbiCoder.defaultAbiCoder();

export const EXIT_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)",
  ),
);

export interface Leaf {
  exitId: bigint;
  agentId: bigint;
  to: string;
  credits: bigint;
}

export function leafHash(l: Leaf, layerChainId: number, bridge: string): string {
  return keccak256(abi.encode(
    ["bytes32", "uint256", "uint256", "address", "uint256", "uint256", "address"],
    [EXIT_TYPEHASH, l.exitId, l.agentId, getAddress(l.to), l.credits, layerChainId, getAddress(bridge)],
  ));
}

function pairHash(a: string, b: string): string {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

function sortLeaves(leaves: Leaf[]): Leaf[] {
  return [...leaves].sort((x, y) => (x.exitId < y.exitId ? -1 : x.exitId > y.exitId ? 1 : 0));
}

function layersOf(hashes: string[]): string[][] {
  const layers: string[][] = [hashes];
  let cur = hashes;
  while (cur.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      // 奇数个：最后一个直接上浮，不复制自己（复制会让两棵不同的树撞根）
      next.push(i + 1 < cur.length ? pairHash(cur[i], cur[i + 1]) : cur[i]);
    }
    layers.push(next);
    cur = next;
  }
  return layers;
}

export function root(leaves: Leaf[], layerChainId: number, bridge: string): string {
  if (leaves.length === 0) return ZeroHash;
  const hashes = sortLeaves(leaves).map((l) => leafHash(l, layerChainId, bridge));
  const layers = layersOf(hashes);
  return layers[layers.length - 1][0];
}

export function proof(leaves: Leaf[], exitId: bigint, layerChainId: number, bridge: string): string[] {
  const sorted = sortLeaves(leaves);
  const idx = sorted.findIndex((l) => l.exitId === exitId);
  if (idx < 0) throw new Error(`这一批叶子里没有 exitId ${exitId}`);
  const hashes = sorted.map((l) => leafHash(l, layerChainId, bridge));
  const layers = layersOf(hashes);
  const out: string[] = [];
  let i = idx;
  for (let d = 0; d < layers.length - 1; d++) {
    const layer = layers[d];
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    if (sibling < layer.length) out.push(layer[sibling]);
    // sibling 越界 = 本层最后一个奇数节点，直接上浮，不产生证明元素
    i = Math.floor(i / 2);
  }
  return out;
}

/** 用证明自己验一遍根（合约里是 OpenZeppelin MerkleProof.verify 的同一算法）。 */
export function verify(leaf: string, proofPath: string[], expectedRoot: string): boolean {
  let h = leaf;
  for (const p of proofPath) h = pairHash(h, p);
  return h.toLowerCase() === expectedRoot.toLowerCase();
}

const l2Iface = new Interface(L2BRIDGE_ABI as unknown as string[]);

/**
 * 从 L2Bridge.ExitBurned 日志重建叶子，供任何人独立核验一个纪元的 exitRoot。
 * 接受 ethers 的 Log 对象（{topics, data}），非 ExitBurned 的日志会被跳过。
 */
export function fromLogs(logs: any[]): Leaf[] {
  const out: Leaf[] = [];
  for (const log of logs) {
    let parsed;
    try {
      parsed = l2Iface.parseLog({ topics: [...(log.topics ?? [])], data: log.data ?? "0x" });
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== "ExitBurned") continue;
    out.push({
      exitId: BigInt(parsed.args.exitId),
      agentId: BigInt(parsed.args.agentId),
      to: getAddress(parsed.args.bscRecipient),
      credits: BigInt(parsed.args.amount),
    });
  }
  return sortLeaves(out);
}
