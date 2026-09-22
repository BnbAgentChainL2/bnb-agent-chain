// src/exit-tree.js —— exitRoot 的构造，逐字实现 03 §1.3。
// relayer / @bac/agent-sdk / @bac/node-cli / 索引器四处必须得出同一个根，所以这里一个字节都不许「优化」。
//
//   leaf_i = keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, to, credits, uint256(56777), BAC_BRIDGE))
//   叶子按 exitId 升序；
//   内部节点 = keccak256(a < b ? a||b : b||a)   // OpenZeppelin MerkleProof 的排序对法
//   叶子数为奇数时最后一个直接上浮（不复制）；
//   exitCount == 0 时 exitRoot = bytes32(0)。
//
// 叶子里**没有 epoch**（EXIT_TYPEHASH 已去掉该字段）；bornEpoch 只用于分桶与展示。
import { AbiCoder, keccak256, id as keccakId, concat, getAddress } from "ethers";

export const EXIT_TYPEHASH = keccakId(
  "Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)"
);

export const ZERO_ROOT = "0x" + "00".repeat(32);

const coder = AbiCoder.defaultAbiCoder();

/** 单个叶子哈希。credits 传 bigint 或十进制字符串。 */
export function leafHash(l, layerChainId, bridge) {
  return keccak256(
    coder.encode(
      ["bytes32", "uint256", "uint256", "address", "uint256", "uint256", "address"],
      [
        EXIT_TYPEHASH,
        BigInt(l.exitId),
        BigInt(l.agentId),
        getAddress(l.to),
        BigInt(l.credits),
        BigInt(layerChainId),
        getAddress(bridge),
      ]
    )
  );
}

/** 排序对哈希。 */
function pair(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

function sorted(leaves) {
  return [...leaves].sort((x, y) => (BigInt(x.exitId) < BigInt(y.exitId) ? -1 : BigInt(x.exitId) > BigInt(y.exitId) ? 1 : 0));
}

/** 逐层归并，返回每一层的节点数组（第 0 层是叶子）。 */
function levels(hashes) {
  const out = [hashes];
  let cur = hashes;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 < cur.length) next.push(pair(cur[i], cur[i + 1]));
      else next.push(cur[i]); // 奇数个：最后一个直接上浮，不复制
    }
    out.push(next);
    cur = next;
  }
  return out;
}

/** 根。叶子为空时返回 bytes32(0)。 */
export function root(leaves, layerChainId, bridge) {
  const ls = sorted(leaves);
  if (ls.length === 0) return ZERO_ROOT;
  const hs = ls.map((l) => leafHash(l, layerChainId, bridge));
  const lv = levels(hs);
  return lv[lv.length - 1][0];
}

/** 某个 exitId 的证明路径。找不到该叶子时抛错（不许返回一个「看起来像证明」的空数组）。 */
export function proof(leaves, exitId, layerChainId, bridge) {
  const ls = sorted(leaves);
  const idx = ls.findIndex((l) => BigInt(l.exitId) === BigInt(exitId));
  if (idx < 0) throw new Error(`叶子里没有 exitId=${exitId}`);
  const hs = ls.map((l) => leafHash(l, layerChainId, bridge));
  const lv = levels(hs);
  const out = [];
  let i = idx;
  for (let d = 0; d < lv.length - 1; d++) {
    const cur = lv[d];
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    if (sib < cur.length) out.push(cur[sib]);
    // 上浮的那个没有兄弟，这一层不贡献证明元素
    i = Math.floor(i / 2);
  }
  return out;
}

/** 校验：用证明重算根。 */
export function verify(leaf, proofArr, expectedRoot) {
  let h = leaf;
  for (const p of proofArr) h = pair(h, p);
  return h.toLowerCase() === String(expectedRoot).toLowerCase();
}
