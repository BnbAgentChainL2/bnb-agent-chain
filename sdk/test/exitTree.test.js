// 退出 merkle 树：叶子布局、根、证明、从日志重建。
// 合约侧用 OpenZeppelin MerkleProof.verify（排序对法），这里必须得出同一个根。

import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, concat, keccak256, toUtf8Bytes, ZeroHash } from "ethers";
import { exitTree } from "../dist/index.js";
import { makeLog } from "./helpers/mock.js";
import { L2BRIDGE_ABI } from "../dist/abi.js";

const abi = AbiCoder.defaultAbiCoder();
const BRIDGE = "0x2222222222222222222222222222222222222222";
const L2BRIDGE_ADDR = "0x0000000000000000000000000000000000000101";
const CHAIN = 56777;

const A = (n) => "0x" + String(n).repeat(40).slice(0, 40);

function mkLeaves(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ exitId: BigInt(i), agentId: BigInt(i * 7), to: A(i % 10), credits: BigInt(i) * 10n ** 18n });
  }
  return out;
}

test("EXIT_TYPEHASH 逐字等于合约常量，叶子里没有 epoch", () => {
  assert.equal(
    exitTree.EXIT_TYPEHASH,
    keccak256(toUtf8Bytes(
      "Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)",
    )),
  );
});

test("leafHash 与 01 §4.2 第 5 步的 abi.encode 布局逐字一致", () => {
  const l = { exitId: 41n, agentId: 17n, to: A(3), credits: 20000n * 10n ** 18n };
  const expected = keccak256(abi.encode(
    ["bytes32", "uint256", "uint256", "address", "uint256", "uint256", "address"],
    [exitTree.EXIT_TYPEHASH, l.exitId, l.agentId, l.to, l.credits, CHAIN, BRIDGE],
  ));
  assert.equal(exitTree.leafHash(l, CHAIN, BRIDGE), expected);
});

test("exitCount == 0 时 root 是 bytes32(0)", () => {
  assert.equal(exitTree.root([], CHAIN, BRIDGE), ZeroHash);
});

test("单叶子时 root 就是那个叶子，证明为空", () => {
  const leaves = mkLeaves(1);
  assert.equal(exitTree.root(leaves, CHAIN, BRIDGE), exitTree.leafHash(leaves[0], CHAIN, BRIDGE));
  assert.deepEqual(exitTree.proof(leaves, 1n, CHAIN, BRIDGE), []);
});

test("两个叶子：内部节点是排序对哈希", () => {
  const leaves = mkLeaves(2);
  const h = leaves.map((l) => exitTree.leafHash(l, CHAIN, BRIDGE));
  const expected = BigInt(h[0]) < BigInt(h[1])
    ? keccak256(concat([h[0], h[1]]))
    : keccak256(concat([h[1], h[0]]));
  assert.equal(exitTree.root(leaves, CHAIN, BRIDGE), expected);
});

test("1..33 个叶子：每一个 exitId 的证明都能验回同一个根（含奇数上浮的路径）", () => {
  for (let n = 1; n <= 33; n++) {
    const leaves = mkLeaves(n);
    const root = exitTree.root(leaves, CHAIN, BRIDGE);
    for (let i = 1; i <= n; i++) {
      const p = exitTree.proof(leaves, BigInt(i), CHAIN, BRIDGE);
      const leaf = exitTree.leafHash(leaves[i - 1], CHAIN, BRIDGE);
      assert.ok(exitTree.verify(leaf, p, root), `n=${n} exitId=${i} 的证明应当能验回根`);
    }
  }
});

test("叶子顺序不影响根：输入乱序也按 exitId 升序排", () => {
  const leaves = mkLeaves(9);
  const shuffled = [...leaves].reverse();
  assert.equal(exitTree.root(shuffled, CHAIN, BRIDGE), exitTree.root(leaves, CHAIN, BRIDGE));
});

test("改一个字段就换一个根（bridge / layerChainId 都进哈希）", () => {
  const leaves = mkLeaves(5);
  const r = exitTree.root(leaves, CHAIN, BRIDGE);
  assert.notEqual(exitTree.root(leaves, 56, BRIDGE), r);
  assert.notEqual(exitTree.root(leaves, CHAIN, A(9)), r);
});

test("被 veto 的纪元重报：叶子一个字节都不变，所以根也不变", () => {
  // bornEpoch 不进叶子，重报只是换了个 anchorEpoch 去证明同一批叶子。
  const leaves = mkLeaves(4);
  const before = exitTree.root(leaves, CHAIN, BRIDGE);
  const reported = leaves.map((l) => ({ ...l }));   // 重报时原样带过去
  assert.equal(exitTree.root(reported, CHAIN, BRIDGE), before);
});

test("fromLogs 从 ExitBurned 日志重建叶子并按 exitId 升序", () => {
  const logs = [
    makeLog(L2BRIDGE_ABI, L2BRIDGE_ADDR, "ExitBurned", [3n, 21n, A(3), 300n, 20718n]),
    makeLog(L2BRIDGE_ABI, L2BRIDGE_ADDR, "ExitBurned", [1n, 7n, A(1), 100n, 20718n]),
    { address: L2BRIDGE_ADDR, topics: ["0x" + "99".repeat(32)], data: "0x" },   // 无关日志
  ];
  const leaves = exitTree.fromLogs(logs);
  assert.equal(leaves.length, 2);
  assert.deepEqual(leaves.map((l) => l.exitId), [1n, 3n]);
  assert.equal(leaves[0].agentId, 7n);
  assert.equal(leaves[1].credits, 300n);
});

test("proof 对不存在的 exitId 报错，不返回一条假证明", () => {
  assert.throws(() => exitTree.proof(mkLeaves(3), 99n, CHAIN, BRIDGE), /没有 exitId/);
});
