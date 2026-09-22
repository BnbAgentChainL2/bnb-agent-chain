// 挑战求解器：真难度下要在预算内解出来，预算用完要正确地失败。

import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, keccak256, randomBytes, verifyTypedData, Wallet } from "ethers";
import { challenge } from "../dist/index.js";

const abi = AbiCoder.defaultAbiCoder();
const REGISTRY = "0x1111111111111111111111111111111111111111";

test("常量与合约逐字一致（TARGET / K_BLOCKS / K_SECONDS / ROUNDS）", () => {
  assert.equal(challenge.TARGET, 2n ** 236n);
  assert.equal(challenge.K_BLOCKS, 8);
  assert.equal(challenge.K_SECONDS, 5);
  assert.equal(challenge.ROUNDS, 3);
});

test("seed / chainedSeed / challengeId 的推导与 01 §3.3 逐字一致", () => {
  const blockHash = "0x" + "ab".repeat(32);
  const agentId = 17n, nonce = 3n;
  assert.equal(
    challenge.seed(blockHash, agentId, nonce, REGISTRY),
    keccak256(abi.encode(["bytes32", "uint256", "uint256", "address"], [blockHash, agentId, nonce, REGISTRY])),
  );
  const s1 = challenge.seed(blockHash, agentId, nonce, REGISTRY);
  assert.equal(
    challenge.chainedSeed(s1, 42n, blockHash),
    keccak256(abi.encode(["bytes32", "uint256", "bytes32"], [s1, 42n, blockHash])),
  );
  assert.equal(
    challenge.challengeIdOf(agentId, 2, s1),
    keccak256(abi.encode(["uint256", "uint8", "bytes32"], [agentId, 2, s1])),
  );
});

// 真难度：2**236 平均约 2**20 次哈希。
test("真难度 2**236：单核能解出来，答案满足链上不等式", { timeout: 120_000 }, () => {
  const seed = keccak256(randomBytes(32));
  const t0 = Date.now();
  const r = challenge.solve(seed, challenge.TARGET, { budgetMs: 60_000 });
  const ms = Date.now() - t0;
  const digest = keccak256(abi.encode(["bytes32", "uint256"], [seed, r.nonce]));
  assert.ok(BigInt(digest) < challenge.TARGET, "答案必须满足 < 2**236");
  assert.ok(r.ms <= ms + 50, "返回的耗时要和实测对得上");
});

// 这一条记录的是**事实**，不是保证：单核在 3.8 秒预算内有约一成解不出来，
// 所以 join() 走多核池子（见 solvePool.test.js 里那条「6 轮全部在预算内」）。
// 断言写成「要么出解且答案正确，要么老老实实返回 null」，不写成「一定出解」。
test("单核 + 3.8 秒预算：出解则答案必须正确，解不出则必须返回 null", { timeout: 60_000 }, () => {
  const seed = keccak256(randomBytes(32));
  const r = challenge.trySolve(seed, challenge.TARGET, 3800);
  if (r === null) return;
  const digest = keccak256(abi.encode(["bytes32", "uint256"], [seed, r.nonce]));
  assert.ok(BigInt(digest) < challenge.TARGET);
  assert.ok(r.ms <= 4200, `出解就必须在预算内，实际 ${r.ms} ms`);
});

test("预算用完必须失败，而且是 challenge_timeout，不是返回一个错答案", () => {
  const seed = keccak256(randomBytes(32));
  // 2**200 需要约 2**56 次哈希，本机不可能在 200 ms 内解出来
  assert.throws(
    () => challenge.solve(seed, 2n ** 200n, { budgetMs: 200 }),
    (err) => err.code === "challenge_timeout",
  );
  const r = challenge.trySolve(seed, 2n ** 200n, 200);
  assert.equal(r, null, "trySolve 超预算应当返回 null");
});

test("同一个 seed + 同一个起始 nonce 出同一个解（可复现）", () => {
  const seed = keccak256(randomBytes(32));
  const a = challenge.trySolve(seed, 2n ** 244n, 5000, 0n);
  const b = challenge.trySolve(seed, 2n ** 244n, 5000, 0n);
  assert.equal(a.nonce, b.nonce);
});

test("sign 产出的是 controller 对 EIP-712 Challenge 的签名，domain 的 chainId 固定 56", async () => {
  const w = new Wallet("0x" + "11".repeat(32));
  const seed = keccak256(randomBytes(32));
  const challengeId = keccak256(randomBytes(32));
  const sig = await challenge.sign(w, 17n, challengeId, seed, 123n, REGISTRY);
  const recovered = verifyTypedData(
    { name: "BNB Agent Chain Registry", version: "1", chainId: 56, verifyingContract: REGISTRY },
    { Challenge: [
      { name: "agentId", type: "uint256" },
      { name: "challengeId", type: "bytes32" },
      { name: "seed", type: "bytes32" },
      { name: "nonce", type: "uint256" },
    ] },
    { agentId: 17n, challengeId, seed, nonce: 123n },
    sig,
  );
  assert.equal(recovered, w.address);
});
