// test/decode.test.js —— 对 03 §4 里**每一个**事件类型的解码测试。
// 夹具日志是用真实 ABI 编码出来的，所以这组用例同时验证了 abi.js 的签名是否和合约一致。
import test from "node:test";
import assert from "node:assert/strict";
import { decodeLog } from "../src/decode.js";
import { renderEvent } from "../src/render.js";
import { ACTION_KINDS, KIND_HASH, HASH_KIND } from "../src/abi.js";
import { mkLog, ADDR, TEST_BOOK, KIND, cleanupTempDbs } from "./helpers.js";

test.after(cleanupTempDbs);

const dec = (log, chain) => decodeLog(log, { chain, addressBook: TEST_BOOK });

// ---------- §4.2：11 个 kind 全覆盖 ----------

test("§4.2：11 个 kind 常量都能从 hash 还原成明文", () => {
  assert.equal(ACTION_KINDS.length, 11);
  for (const k of ACTION_KINDS) {
    assert.equal(HASH_KIND[KIND_HASH[k]], k);
    assert.equal(KIND_HASH[k], KIND(k));
  }
});

for (const kind of ACTION_KINDS) {
  test(`§4.2：AgentBook.Action kind=${kind} 解码并渲染`, () => {
    const log = mkLog(
      "AgentBook",
      "Action",
      {
        agentId: 17n,
        kind: KIND(kind),
        subject: ADDR.agentWallet,
        actor: ADDR.agentWallet,
        contentHash: "0x" + "11".repeat(32),
        summary: "你好 <script>alert(1)</script>",
        uri: "https://example.invalid/x.json",
        seq: 8821n,
        epoch: 20718n,
      },
      { address: ADDR.AgentBook, blockNumber: 1234560 }
    );
    const d = dec(log, "layer");
    assert.equal(d.contract, "AgentBook");
    assert.equal(d.event, "Action");
    assert.equal(d.agentId, 17);
    assert.equal(d.epoch, 20718);
    assert.equal(d.args.kind, kind);
    assert.equal(d.args.kindHash, KIND(kind));
    assert.equal(d.args.seq, 8821);
    assert.equal(d.args.actor, ADDR.agentWallet);
    const r = renderEvent(d);
    assert.equal(r.kind, kind);
    // summary 是 agent 自己写的不可信文本：渲染时必须转义
    assert.ok(!r.textZh.includes("<script>"), "summary 没有被转义");
    if (!["DEPLOY", "POOL", "MESSAGE"].includes(kind)) {
      assert.ok(r.textZh.includes("&lt;script&gt;"));
    }
  });
}

test("§4.2：认不出来的 kind hash 落 NOTE，但原 hash 不丢", () => {
  const weird = "0x" + "ab".repeat(32);
  const log = mkLog(
    "AgentBook",
    "Action",
    {
      agentId: 3n,
      kind: weird,
      subject: ADDR.agentWallet,
      actor: ADDR.agentWallet,
      contentHash: "0x" + "00".repeat(32),
      summary: "x",
      uri: "",
      seq: 1n,
      epoch: 20718n,
    },
    { address: ADDR.AgentBook }
  );
  const d = dec(log, "layer");
  assert.equal(d.args.kind, "NOTE");
  assert.equal(d.args.kindHash, weird);
});

// ---------- §4.4：BSC 侧进 feed 的每一个事件 ----------

const H32 = "0x" + "cd".repeat(32);

const CASES = [
  ["AgentRegistry", "Registered", {
    agentId: 17n, controller: ADDR.controller, agentWallet: ADDR.agentWallet,
    agentURI: "https://a.invalid/agent.json", endpointHash: H32, modelFingerprint: H32,
  }, (d) => {
    assert.equal(d.agentId, 17);
    assert.equal(d.args.controller, ADDR.controller);
    assert.equal(d.args.agentURI, "https://a.invalid/agent.json");
  }],
  ["AgentRegistry", "ChallengeSolved", { agentId: 17n, challengeId: H32, blocksUsed: 2n, round: 1n },
    (d) => assert.equal(d.args.blocksUsed, 2)],
  ["AgentRegistry", "Activated", { agentId: 17n, agentWallet: ADDR.agentWallet },
    (d) => assert.equal(d.args.agentWallet, ADDR.agentWallet)],
  ["AgentRegistry", "Heartbeat", { agentId: 17n, epoch: 20718n, note: H32 },
    (d) => assert.equal(d.epoch, 20718)],
  ["AgentRegistry", "Dormant", { agentId: 17n, epoch: 20719n },
    (d) => assert.equal(d.epoch, 20719)],
  ["AgentRegistry", "Published", { agentId: 17n, kind: KIND("PUBLISH"), contentHash: H32, uri: "ipfs://x" },
    (d) => assert.equal(d.args.uri, "ipfs://x")],
  ["AgentRegistry", "Banned", { agentId: 17n, reasonHash: H32, by: ADDR.controller },
    (d) => assert.equal(d.args.by, ADDR.controller)],
  ["BacBridge", "Locked", {
    depositId: 12n, agentId: 17n, from: ADDR.controller, layerWallet: ADDR.agentWallet,
    measured: 250000n * 10n ** 18n, credits: 250000n * 10n ** 18n, totalIssued: 5000000n * 10n ** 18n,
  }, (d) => {
    // 金额必须是十进制字符串，不是 number、不是 bigint
    assert.equal(typeof d.args.credits, "string");
    assert.equal(d.args.credits, "250000000000000000000000");
    assert.equal(d.args.depositId, "12");
  }],
  ["BacBridge", "ExitClaimed", {
    anchorEpoch: 20719n, exitId: 41n, agentId: 17n, to: ADDR.controller,
    credits: 20000n * 10n ** 18n, lockedWei: 123n, rateUsed: 5n, attributed: 1n,
  }, (d) => {
    assert.equal(d.epoch, 20719);
    assert.equal(d.args.lockedWei, "123");
  }],
  ["BacBridge", "EpochSettled", { epoch: 20716n, pot: 12n, owedTotalAfter: 7n, releaseBps: 350n, skipped: false },
    (d) => { assert.equal(d.args.releaseBps, 350); assert.equal(d.args.skipped, false); }],
  ["BacBridge", "Collected", { who: ADDR.controller, to: ADDR.controller, amount: 9n, owedLeft: 1n },
    (d) => assert.equal(d.args.amount, "9")],
  ["BacBridge", "OwedDemoted", { who: ADDR.controller, amount: 5n },
    (d) => assert.equal(d.args.amount, "5")],
  ["BacBridge", "EscapeCollected", { agentId: 17n, to: ADDR.controller, amount: 8n },
    (d) => assert.equal(d.agentId, 17)],
  ["BacBridge", "Halted", { cause: 3n }, (d) => assert.equal(d.args.cause, 3)],
  ["BacBridge", "ReleaseReceived", { from: ADDR.BacTreasuryVault, amount: 100n, poolAfter: 900n },
    (d) => { assert.equal(d.contract, "BacBridge"); assert.equal(d.args.poolAfter, "900"); }],
  ["ChainAnchor", "AnchorPosted", {
    epoch: 20718n, exitRoot: H32, l2BlockHash: H32, l2Block: 1234567n,
    credited: 1n, exitCredits: 2n, feeBurned: 3n, circulating: 4n, exitCount: 7n,
  }, (d) => {
    assert.equal(d.args.l2Block, 1234567);
    assert.equal(d.args.exitCount, 7);
    assert.equal(d.args.credited, "1");
  }],
  ["ChainAnchor", "AnchorFinalized", { epoch: 20716n, agreeingCount: 2n, releaseBps: 350n },
    (d) => assert.equal(d.args.agreeingCount, 2)],
  ["ChainAnchor", "AnchorVetoed", { epoch: 20716n, by: ADDR.controller, reasonHash: H32, countInWindow: 1n },
    (d) => assert.equal(d.args.countInWindow, 1)],
  ["ChainAnchor", "AnchorDisputed", { epoch: 20716n, agreeingWeight: 10n, disputingWeight: 20n, disputingCount: 3n, countInWindow: 1n },
    (d) => assert.equal(d.args.disputingWeight, "20")],
  ["ValidatorStaking", "Staked", { who: ADDR.validator, amount: 2000000n, total: 2000000n },
    (d) => assert.equal(d.args.total, "2000000")],
  ["ValidatorStaking", "NodeRegistered", { nodeIdHash: H32, validator: ADDR.validator, payout: ADDR.controller, enodeURI: "enode://ab@1.2.3.4:30303" },
    (d) => assert.equal(d.args.enodeURI, "enode://ab@1.2.3.4:30303")],
  ["ValidatorStaking", "AttestationCommitted", { epoch: 20718n, validator: ADDR.validator, commitment: H32 },
    (d) => assert.equal(d.epoch, 20718)],
  ["ValidatorStaking", "AttestationRevealed", { epoch: 20718n, validator: ADDR.validator, exitRoot: H32, l2BlockHash: H32, l2Block: 5n, agreeing: true, weight: 99n },
    (d) => { assert.equal(d.args.agreeing, true); assert.equal(d.args.weight, "99"); }],
  ["ValidatorStaking", "RewardsSettled", { epoch: 20716n, pot: 5n, weight: 6n, rate: 7n },
    (d) => assert.equal(d.args.rate, "7")],
  ["ValidatorStaking", "RewardClaimed", { epoch: 20716n, validator: ADDR.validator, to: ADDR.controller, amount: 4n },
    (d) => assert.equal(d.args.amount, "4")],
  ["ValidatorStaking", "RewardsFunded", { from: ADDR.BacNodeFund, amount: 3n, balanceAfter: 8n },
    (d) => assert.equal(d.args.balanceAfter, "8")],
  ["BacTreasuryVault", "RevenueRecognized", { from: ADDR.TaxProcessor, amount: 10n },
    (d) => assert.equal(d.args.amount, "10")],
  ["BacTreasuryVault", "RevenueSplit", { toBridge: 5n, toNodeFund: 5n },
    (d) => { assert.equal(d.args.toBridge, "5"); assert.equal(d.args.toNodeFund, "5"); }],
  ["BacTreasuryVault", "PushSucceeded", { to: ADDR.BacBridge, amount: 5n },
    (d) => assert.equal(d.args.to, ADDR.BacBridge)],
  ["BacTreasuryVault", "PushFailed", { to: ADDR.BacNodeFund, amount: 5n },
    (d) => assert.equal(d.args.to, ADDR.BacNodeFund)],
  ["BacNodeFund", "ReleaseReceived", { from: ADDR.BacTreasuryVault, amount: 5n, balanceAfter: 55n },
    (d) => { assert.equal(d.contract, "BacNodeFund"); assert.equal(d.args.balanceAfter, "55"); }],
  ["BacNodeFund", "Withdrawn", { to: ADDR.controller, amount: 12n, balanceAfter: 43n },
    (d) => { assert.equal(d.contract, "BacNodeFund"); assert.equal(d.args.amount, "12"); }],
  ["FlapVaultPortal", "FlapTaxVaultTokenCreated", { token: ADDR.controller, vault: ADDR.BacTreasuryVault, vaultFactory: ADDR.BacVaultFactory },
    (d) => assert.equal(d.args.vault, ADDR.BacTreasuryVault)],
  // 层内
  ["L2Bridge", "CreditsMinted", { depositId: H32, agentId: 17n, to: ADDR.agentWallet, amount: 7n },
    (d) => { assert.equal(d.args.depositId, H32); assert.equal(d.args.amount, "7"); }],
  ["L2Bridge", "ExitBurned", { exitId: 41n, agentId: 17n, bscRecipient: ADDR.controller, amount: 20n, epoch: 20718n },
    (d) => { assert.equal(d.epoch, 20718); assert.equal(d.args.bscRecipient, ADDR.controller); }],
  ["L2Gate", "AgentSynced", { agentId: 17n, wallet: ADDR.agentWallet, status: 2n, bscBlock: 99n },
    (d) => { assert.equal(d.args.status, 2); assert.equal(d.args.statusName, "ACTIVE"); }],
];

for (const [contract, event, args, check] of CASES) {
  test(`§4.4：${contract}.${event} 解码`, () => {
    const chain = ["L2Bridge", "L2Gate", "AgentBook"].includes(contract) ? "layer" : "bsc";
    const log = mkLog(contract, event, args, { address: ADDR[contract] });
    const d = dec(log, chain);
    assert.ok(d, `${contract}.${event} 没解出来`);
    assert.equal(d.contract, contract);
    assert.equal(d.event, event);
    check(d);
    // 每一个事件都必须能渲染出一句非空中文
    const r = renderEvent(d);
    assert.ok(r.textZh && r.textZh.length > 0);
    assert.ok(!/undefined|NaN|\[object/.test(r.textZh), `渲染出了脏字符串：${r.textZh}`);
  });
}

test("同签名事件靠地址消歧：ReleaseReceived 在桥和节点基金上是两个合约", () => {
  const a = mkLog("BacBridge", "ReleaseReceived", { from: ADDR.BacTreasuryVault, amount: 1n, poolAfter: 2n }, { address: ADDR.BacBridge });
  const b = mkLog("BacNodeFund", "ReleaseReceived", { from: ADDR.BacTreasuryVault, amount: 1n, balanceAfter: 2n }, { address: ADDR.BacNodeFund });
  assert.equal(a.topics[0], b.topics[0], "两个事件的 topic0 本来就该一样");
  assert.equal(dec(a, "bsc").contract, "BacBridge");
  assert.equal(dec(b, "bsc").contract, "BacNodeFund");
});

test("不认识的 topic0 返回 null，不瞎猜", () => {
  const log = { address: ADDR.BacBridge, topics: ["0x" + "ff".repeat(32)], data: "0x", blockNumber: 1, transactionHash: "0x" + "0".repeat(64), logIndex: 0 };
  assert.equal(dec(log, "bsc"), null);
});

test("地址已知但它不发这个事件时不解码（不许贴错合约名）", () => {
  const log = mkLog("BacBridge", "Locked", {
    depositId: 1n, agentId: 1n, from: ADDR.controller, layerWallet: ADDR.agentWallet,
    measured: 1n, credits: 1n, totalIssued: 1n,
  }, { address: ADDR.BacNodeFund });
  assert.equal(dec(log, "bsc"), null);
});
