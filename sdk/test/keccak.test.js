// 定长 keccak256 与求解器的正确性：对 ethers.keccak256 逐字对拍。

import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, keccak256, randomBytes } from "ethers";
import { keccak256_64, solveNonce } from "../dist/keccak.js";

const abi = AbiCoder.defaultAbiCoder();

test("keccak256_64 与 ethers.keccak256 在 200 组随机输入上逐字一致", () => {
  for (let i = 0; i < 200; i++) {
    const input = randomBytes(64);
    assert.equal(keccak256_64(input), keccak256(input));
  }
});

test("keccak256_64 拒绝非 64 字节输入", () => {
  assert.throws(() => keccak256_64(new Uint8Array(32)), /64 字节/);
});

test("solveNonce 找到的 nonce 满足合约那条不等式（用 ethers 独立复算）", () => {
  const target = 2n ** 248n;      // 简单难度，测试要快
  const seed = randomBytes(32);
  const r = solveNonce(seed, target, 5000, 0n);
  assert.ok(r, "应该在预算内出解");
  const digest = keccak256(abi.encode(["bytes32", "uint256"], [seed, r.nonce]));
  assert.ok(BigInt(digest) < target, `摘要 ${digest} 应当小于 target`);
});

test("预筛掩码没有漏解：从 0 开始穷举，第一个满足条件的就是它返回的", { timeout: 60_000 }, () => {
  const target = 2n ** 244n;      // 约 1/4096，10 万次以内漏掉的概率约 e^-24
  const seed = randomBytes(32);
  let expected = null;
  for (let n = 0n; n < 100000n; n++) {
    const d = keccak256(abi.encode(["bytes32", "uint256"], [seed, n]));
    if (BigInt(d) < target) { expected = n; break; }
  }
  assert.notEqual(expected, null, "穷举里应当能找到一个解");
  const r = solveNonce(seed, target, 10000, 0n);
  assert.equal(r.nonce, expected, "求解器必须找到穷举意义上的第一个解，不能跳过");
});
