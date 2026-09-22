// 多核求解池：真难度下要稳定在预算内出解，出解后其余线程必须立刻停手。

import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, keccak256, randomBytes } from "ethers";
import { SolverPool, challenge } from "../dist/index.js";

const abi = AbiCoder.defaultAbiCoder();

test("真难度 2**236：连开 6 轮，每轮都在 3.8 秒预算内出解", { timeout: 120_000 }, async () => {
  const pool = new SolverPool();
  try {
    for (let i = 0; i < 6; i++) {
      const seed = keccak256(randomBytes(32));
      const t0 = Date.now();
      const r = await pool.solve(seed, challenge.TARGET, 3800);
      const ms = Date.now() - t0;
      assert.ok(r, `第 ${i + 1} 轮应当出解（实际用了 ${ms} ms）`);
      const digest = keccak256(abi.encode(["bytes32", "uint256"], [seed, r.nonce]));
      assert.ok(BigInt(digest) < challenge.TARGET, "答案必须满足链上那条不等式");
      assert.ok(ms <= 4000, `第 ${i + 1} 轮用了 ${ms} ms，超出预算`);
    }
  } finally {
    await pool.close();
  }
});

test("出解之后其余线程立刻停手：连续两轮的间隔不会被上一轮的残留拖慢", { timeout: 120_000 }, async () => {
  const pool = new SolverPool();
  try {
    // 第一轮用超低难度秒出，此时其余线程本来会继续跑满预算
    await pool.solve(keccak256(randomBytes(32)), 2n ** 252n, 3800);
    // 紧接着一轮真难度：如果线程还在忙，这一轮会明显变慢甚至超时
    const t0 = Date.now();
    const r = await pool.solve(keccak256(randomBytes(32)), challenge.TARGET, 3800);
    assert.ok(r, `紧接的一轮应当仍然出解（用了 ${Date.now() - t0} ms）`);
  } finally {
    await pool.close();
  }
});

test("预算用完返回 null，不返回错答案", { timeout: 60_000 }, async () => {
  const pool = new SolverPool(2);
  try {
    const r = await pool.solve(keccak256(randomBytes(32)), 2n ** 200n, 300);
    assert.equal(r, null);
  } finally {
    await pool.close();
  }
});

test("线程数可配，且封顶 8", () => {
  const p1 = new SolverPool(1);
  assert.equal(p1.size, 1);
  const p2 = new SolverPool(99);
  assert.equal(p2.size, 8);
  return Promise.all([p1.close(), p2.close()]);
});
