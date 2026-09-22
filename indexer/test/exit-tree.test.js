// test/exit-tree.test.js —— exitRoot / proof 的构造（03 §1.3）。
// 这棵树的定义是 relayer / SDK / node-cli / 索引器四处共用的，所以这里既测行为也测常量。
import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, keccak256, concat, id as keccakId } from "ethers";
import { leafHash, root, proof, verify, EXIT_TYPEHASH, ZERO_ROOT } from "../src/exit-tree.js";
import { ADDR } from "./helpers.js";

const CHAIN = 56777;
const BRIDGE = ADDR.BacBridge;
const coder = AbiCoder.defaultAbiCoder();

const mk = (exitId, credits) => ({
  exitId: BigInt(exitId),
  agentId: 17n,
  to: ADDR.controller,
  credits: BigInt(credits),
});

test("EXIT_TYPEHASH 逐字等于 03 §1.3 里那一行", () => {
  assert.equal(
    EXIT_TYPEHASH,
    keccakId("Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)")
  );
});

test("叶子里没有 epoch：bornEpoch 不同不改变叶子哈希", () => {
  const a = leafHash({ ...mk(1, 100), bornEpoch: 20718 }, CHAIN, BRIDGE);
  const b = leafHash({ ...mk(1, 100), bornEpoch: 99999 }, CHAIN, BRIDGE);
  assert.equal(a, b);
});

test("leafHash 与手工 abi.encode 一致", () => {
  const l = mk(41, 20n * 10n ** 18n);
  const manual = keccak256(
    coder.encode(
      ["bytes32", "uint256", "uint256", "address", "uint256", "uint256", "address"],
      [EXIT_TYPEHASH, 41n, 17n, ADDR.controller, 20n * 10n ** 18n, 56777n, BRIDGE]
    )
  );
  assert.equal(leafHash(l, CHAIN, BRIDGE), manual);
});

test("空叶子的根是 bytes32(0)", () => {
  assert.equal(root([], CHAIN, BRIDGE), ZERO_ROOT);
});

test("单个叶子的根就是那个叶子", () => {
  const l = mk(1, 5);
  assert.equal(root([l], CHAIN, BRIDGE), leafHash(l, CHAIN, BRIDGE));
});

test("两个叶子用排序对法", () => {
  const a = mk(1, 5);
  const b = mk(2, 6);
  const ha = leafHash(a, CHAIN, BRIDGE);
  const hb = leafHash(b, CHAIN, BRIDGE);
  const expect = ha.toLowerCase() < hb.toLowerCase() ? keccak256(concat([ha, hb])) : keccak256(concat([hb, ha]));
  assert.equal(root([a, b], CHAIN, BRIDGE), expect);
});

test("叶子顺序不影响根：内部按 exitId 升序重排", () => {
  const ls = [mk(3, 7), mk(1, 5), mk(2, 6)];
  assert.equal(root(ls, CHAIN, BRIDGE), root([...ls].reverse(), CHAIN, BRIDGE));
});

for (const count of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 33]) {
  test(`${count} 个叶子：每一个的证明都能重算出根（奇数层最后一个上浮，不复制）`, () => {
    const ls = Array.from({ length: count }, (_, i) => mk(i + 1, (i + 1) * 1000));
    const r = root(ls, CHAIN, BRIDGE);
    for (const l of ls) {
      const p = proof(ls, l.exitId, CHAIN, BRIDGE);
      assert.ok(verify(leafHash(l, CHAIN, BRIDGE), p, r), `exitId=${l.exitId} 的证明对不上根`);
    }
  });
}

test("不在叶子里的 exitId 直接抛错，不返回空证明", () => {
  const ls = [mk(1, 5), mk(2, 6)];
  assert.throws(() => proof(ls, 99n, CHAIN, BRIDGE), /没有 exitId=99/);
});

test("换一个 bridge 地址，根就变（叶子把 bridge 钉进去了）", () => {
  const ls = [mk(1, 5), mk(2, 6)];
  assert.notEqual(root(ls, CHAIN, BRIDGE), root(ls, CHAIN, ADDR.BacNodeFund));
});
