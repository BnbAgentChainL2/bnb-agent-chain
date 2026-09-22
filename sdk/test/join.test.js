// join()：register → 三轮真难度挑战 → ACTIVE。全程假链，不碰网络。
// 这个测试同时是「20 行进场」那个承诺的回归测试。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { AbiCoder, Interface, keccak256, randomBytes, Wallet, ZeroHash } from "ethers";
import { join, challenge } from "../dist/index.js";
import { REGISTRY_ABI } from "../dist/abi.js";
import { chainMock, makeLog, stubFetch, TEST_KEYS } from "./helpers/mock.js";

const abi = AbiCoder.defaultAbiCoder();
const iface = new Interface(REGISTRY_ABI);
const sel = (n) => iface.getFunction(n).selector;

const REGISTRY = "0x1111111111111111111111111111111111111111";
const AGENT_ID = 17n;

/** 一个会走完三轮的假 AgentRegistry。 */
function registryMock() {
  const state = {
    round: 1,
    status: 1,                      // CHALLENGED
    seed: keccak256(randomBytes(32)),
    challengeId: null,
    solves: [],
  };
  state.challengeId = challenge.challengeIdOf(AGENT_ID, state.round, state.seed);

  const nowSec = () => Math.floor(Date.now() / 1000);

  const bsc = chainMock(56, {
    calls: {
      [sel("currentChallenge")]: () => abi.encode(
        ["bytes32", "bytes32", "uint64", "uint64", "uint8"],
        state.status === 2
          ? [ZeroHash, ZeroHash, 0n, 0n, 0]
          : [state.challengeId, state.seed, BigInt(1000), BigInt(nowSec() + 5), state.round],
      ),
      [sel("getAgent")]: () => abi.encode(
        ["tuple(address,address,string,bytes32,bytes32,uint64,uint64,uint32,uint32,uint96,uint8)"],
        [[new Wallet(TEST_KEYS.controller).address, new Wallet(TEST_KEYS.layer).address,
          "https://example.invalid/a.json", ZeroHash, ZeroHash, 0n, 0n, 0, state.round - 1, 0n, state.status]],
      ),
    },
    logsFor: (tx) => {
      const parsed = iface.parseTransaction({ data: tx.data });
      if (parsed.name === "register") {
        return [
          makeLog(REGISTRY_ABI, REGISTRY, "Registered", [
            AGENT_ID, new Wallet(TEST_KEYS.controller).address, new Wallet(TEST_KEYS.layer).address,
            "https://example.invalid/a.json", ZeroHash, ZeroHash,
          ]),
          makeLog(REGISTRY_ABI, REGISTRY, "ChallengeIssued", [
            AGENT_ID, state.challengeId, state.seed, 1000n, BigInt(nowSec() + 5), 1,
          ]),
        ];
      }
      if (parsed.name === "solveChallenge") {
        // 校验答案真的满足链上那条不等式，不满足就当作 revert（这里直接抛）
        const digest = keccak256(abi.encode(["bytes32", "uint256"], [state.seed, parsed.args.nonce]));
        assert.ok(BigInt(digest) < challenge.TARGET, "上链的 nonce 必须满足 < 2**236");
        assert.equal(parsed.args.challengeId, state.challengeId);
        state.solves.push(parsed.args.nonce);
        const solvedRound = state.round;
        if (state.round < 3) {
          state.round += 1;
          state.seed = challenge.chainedSeed(state.seed, parsed.args.nonce, "0x" + "11".repeat(32));
          state.challengeId = challenge.challengeIdOf(AGENT_ID, state.round, state.seed);
        } else {
          state.status = 2;         // ACTIVE
        }
        return [makeLog(REGISTRY_ABI, REGISTRY, "ChallengeSolved", [AGENT_ID, state.challengeId, 2, solvedRound])];
      }
      return [];
    },
  });
  return { bsc, state };
}

function tmpState() {
  const dir = mkdtempSync(pjoin(tmpdir(), "bac-join-"));
  return { path: pjoin(dir, "state.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("join(): 注册 + 三轮挑战全部在截止前解出来，进度回调按顺序发", { timeout: 120_000 }, async () => {
  const st = tmpState();
  const { bsc, state } = registryMock();
  const f = stubFetch({ "/api/health": { addresses: { registry: REGISTRY } } });
  const steps = [];
  try {
    const agent = await join({
      bscKey: TEST_KEYS.controller,
      layerKey: TEST_KEYS.layer,
      agentWallet: new Wallet(TEST_KEYS.layer).address,
      card: { name: "测试 agent", model: "claude-opus-5", endpoint: "https://example.invalid/a.json" },
      apiBase: "https://api.invalid",
      statePath: st.path,
      onProgress: (e) => steps.push(e),
      reissueCooldownMs: 50,       // 假链上不必等真的 60 秒冷却
      // 地址由 BacConfig.addresses 指定，RPC 走假 provider
      addresses: { registry: REGISTRY, bridge: "0x2222222222222222222222222222222222222222" },
      bscProvider: bsc,
    });
    assert.equal(agent.agentId, AGENT_ID);
    assert.equal(state.solves.length, 3, "必须真的解了三轮");
    const seq = steps.map((s) => s.step);
    assert.equal(seq[0], "register");
    assert.equal(seq.at(-1), "active");
    assert.equal(seq.filter((x) => x === "solved").length, 3);
    // 每一个 solved 前面必须紧跟着一个 challenge（超时重来会多出 challenge，但不会多出 solved）
    seq.forEach((s, i) => { if (s === "solved") assert.equal(seq[i - 1], "challenge"); });
    for (const s of steps.filter((x) => x.step === "challenge" && x.nonce > 0n)) {
      assert.ok([1, 2, 3].includes(s.round));
      assert.ok(s.msLeft > 0, "上链前必须还有剩余时间");
    }
  } finally {
    f.restore(); st.cleanup();
  }
});

test("join(): 自带 agentWallet 却不给私钥时立刻报错（BindWallet 必须由钱包自己签）", async () => {
  const st = tmpState();
  const f = stubFetch({ "/api/health": { addresses: { registry: REGISTRY } } });
  const { bsc } = registryMock();
  try {
    await assert.rejects(
      () => join({
        bscKey: TEST_KEYS.controller,
        agentWallet: new Wallet(TEST_KEYS.layer).address,
        card: { name: "x", model: "m", endpoint: "https://e.invalid" },
        apiBase: "https://api.invalid",
        statePath: st.path,
        addresses: { registry: REGISTRY },
        bscProvider: bsc,
      }),
      (e) => e.code === "no_layer_key",
    );
  } finally {
    f.restore(); st.cleanup();
  }
});

test("join(): 不给 agentWallet 时自己生成一把，私钥随 Agent 返回", { timeout: 120_000 }, async () => {
  const st = tmpState();
  const { bsc } = registryMock();
  const f = stubFetch({ "/api/health": { addresses: { registry: REGISTRY } } });
  try {
    const agent = await join({
      bscKey: TEST_KEYS.controller,
      card: { name: "x", model: "m", endpoint: "https://e.invalid" },
      apiBase: "https://api.invalid",
      statePath: st.path,
      reissueCooldownMs: 50,
      addresses: { registry: REGISTRY, bridge: "0x2222222222222222222222222222222222222222" },
      bscProvider: bsc,
    });
    assert.match(agent.walletPrivateKey, /^0x[0-9a-f]{64}$/);
    assert.equal(new Wallet(agent.walletPrivateKey).address, agent.wallet);
  } finally {
    f.restore(); st.cleanup();
  }
});
