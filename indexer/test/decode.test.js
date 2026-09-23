// test/decode.test.js —— 对 03 §4 里**每一个**事件类型的解码测试。
// 夹具日志是用真实 ABI 编码出来的，所以这组用例同时验证了 abi.js 的签名是否和合约一致。
import test from "node:test";
import assert from "node:assert/strict";
import { decodeLog } from "../src/decode.js";
import { renderEvent } from "../src/render.js";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";
import { ACTION_KINDS, KIND_HASH, HASH_KIND, IFACES } from "../src/abi.js";
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


// ---------- §4.4：BSC 侧进 feed 的每一个事件（v2：决策 #29 / #30 / #31）----------

const H32 = "0x" + "cd".repeat(32);
const ZERO = "0x0000000000000000000000000000000000000000";
const IMPL1 = "0x1000000000000000000000000000000000000001";
const IMPL2 = "0x1000000000000000000000000000000000000002";

const CASES = [
  ["BacBridge", "Locked", {
    depositId: 12n, agentId: 17n, from: ADDR.controller, layerWallet: ADDR.agentWallet,
    measured: 250000n * 10n ** 18n, credits: 250000n * 10n ** 18n, totalIssued: 5000000n * 10n ** 18n,
  }, (d) => {
    // 金额必须是十进制字符串，不是 number、不是 bigint
    assert.equal(typeof d.args.credits, "string");
    assert.equal(d.args.credits, "250000000000000000000000");
    assert.equal(d.args.depositId, "12");
    assert.equal(d.agentId, 17, "Locked 带着 ERC-8004 身份 id");
  }],
  ["BacBridge", "AgentControllerSet", { agentId: 17n, previous: ZERO, current: ADDR.controller },
    (d) => { assert.equal(d.agentId, 17); assert.equal(d.args.current, ADDR.controller); }],
  ["BacBridge", "ExitClaimed", {
    anchorEpoch: 20719n, exitId: 41n, agentId: 17n, to: ADDR.controller,
    credits: 20000n * 10n ** 18n, lockedBacAmt: 123n, rateUsed: 5n, attributed: 1n,
  }, (d) => {
    assert.equal(d.epoch, 20719);
    assert.equal(d.args.lockedBacAmt, "123");
  }],
  ["BacBridge", "EpochSettled", { epoch: 20716n, pot: 12n, owedTotalAfter: 7n, releaseBps: 350n, skipped: false },
    (d) => { assert.equal(d.args.releaseBps, 350); assert.equal(d.args.skipped, false); }],
  ["BacBridge", "Collected", { who: ADDR.controller, to: ADDR.controller, amount: 9n, owedLeft: 1n },
    (d) => assert.equal(d.args.amount, "9")],
  ["BacBridge", "OwedDemoted", { who: ADDR.controller, amount: 5n },
    (d) => assert.equal(d.args.amount, "5")],
  ["BacBridge", "OwedPaidAfterHalt", { who: ADDR.controller, to: ADDR.controller, amount: 5n },
    (d) => assert.equal(d.args.amount, "5")],
  ["BacBridge", "EpochOwedRevoked", { epoch: 20716n, by: ADDR.validator, revoked: 44n },
    (d) => assert.equal(d.args.revoked, "44")],
  ["BacBridge", "EscapeCollected", { agentId: 17n, to: ADDR.controller, bacPaid: 8n, bnbPaid: 2n },
    (d) => { assert.equal(d.agentId, 17); assert.equal(d.args.bacPaid, "8"); assert.equal(d.args.bnbPaid, "2"); }],
  ["BacBridge", "EscapeArmed", { by: ADDR.validator, cause: 4n, effectiveAt: 1790000000n },
    (d) => assert.equal(d.args.cause, 4)],
  ["BacBridge", "EscapeArmCancelled", { by: ADDR.validator }, (d) => assert.equal(d.args.by, ADDR.validator)],
  ["BacBridge", "Halted", { cause: 3n }, (d) => assert.equal(d.args.cause, 3)],
  ["BacBridge", "Paused", { by: ADDR.validator, until_: 1790000000n, cumulative: 60n },
    (d) => assert.equal(d.args.cumulative, 60)],
  ["BacBridge", "Unpaused", { by: ADDR.validator, cumulative: 60n }, (d) => assert.equal(d.args.cumulative, 60)],
  ["BacBridge", "ReleaseReceived", { from: ADDR.BacTaxRouter, amount: 100n, bnbAfter: 900n },
    (d) => { assert.equal(d.contract, "BacBridge"); assert.equal(d.args.bnbAfter, "900"); }],
  ["BacBridge", "Untracked", { amount: 3n, bnbAfter: 903n }, (d) => assert.equal(d.args.bnbAfter, "903")],
  ["BacBridge", "UntrackedBac", { amount: 3n, buybackBacAfter: 10n }, (d) => assert.equal(d.args.buybackBacAfter, "10")],
  ["BacBridge", "BoughtBack", { by: ADDR.validator, venue: 1n, bnbSpent: 10n ** 16n, bacBought: 5n * 10n ** 18n, buybackBacAfter: 5n * 10n ** 18n },
    (d) => { assert.equal(d.args.venue, 1); assert.equal(d.args.bacBought, "5000000000000000000"); }],
  ["BacBridge", "BuybackSkipped", { reason: 4n, budget: 7n }, (d) => assert.equal(d.args.reason, 4)],
  ["BacBridge", "LockedBurned", { amount: 7n }, (d) => assert.equal(d.args.amount, "7")],
  // 决策 #29c：升级与紧急提取
  ["BacBridge", "BridgeUpgraded", {
    newImplementation: IMPL2, previousImplementation: IMPL1, by: ADDR.controller, upgradeNumber: 1n, at: 1790000000n,
    bnbBook: 10n ** 18n, lockedBacBook: 2n * 10n ** 18n, buybackBacBook: 3n * 10n ** 18n, owedTotalBook: 4n * 10n ** 18n,
  }, (d) => { assert.equal(d.args.upgradeNumber, 1); assert.equal(d.args.newImplementation, getAddress(IMPL2)); }],
  ["BacBridge", "EmergencyWithdraw", {
    by: ADDR.controller, to: ADDR.controller, token: ZERO, amount: 10n ** 18n, balanceAfter: 0n,
    bookAtWithdraw: 10n ** 18n, lifetimeWithdrawn: 10n ** 18n, withdrawNumber: 1n, at: 1790000000n,
  }, (d) => { assert.equal(d.args.token, ZERO); assert.equal(d.args.withdrawNumber, 1); }],
  ["BacBridge", "Upgraded", { implementation: IMPL1 }, (d) => assert.equal(d.args.implementation, getAddress(IMPL1))],
  ["BacBridge", "Initialized", { version: 1n }, (d) => assert.equal(d.args.version, 1)],
  ["BacBridge", "OwnershipTransferStarted", { previousOwner: ADDR.controller, newOwner: ADDR.validator },
    (d) => assert.equal(d.args.newOwner, ADDR.validator)],
  ["BacBridge", "OwnershipTransferred", { previousOwner: ZERO, newOwner: ADDR.controller },
    (d) => { assert.equal(d.contract, "BacBridge"); assert.equal(d.args.newOwner, ADDR.controller); }],
  // 决策 #30：税收路由
  ["BacTaxRouter", "RevenueRecognized", { from: ADDR.TaxProcessor, amount: 10n },
    (d) => assert.equal(d.args.amount, "10")],
  ["BacTaxRouter", "RevenueSplit", { toBridge: 5n, toNodeFund: 5n },
    (d) => { assert.equal(d.args.toBridge, "5"); assert.equal(d.args.toNodeFund, "5"); }],
  ["BacTaxRouter", "PushSucceeded", { to: ADDR.BacBridge, amount: 5n },
    (d) => assert.equal(d.args.to, ADDR.BacBridge)],
  ["BacTaxRouter", "PushFailed", { to: ADDR.BacNodeFund, amount: 5n },
    (d) => assert.equal(d.args.to, ADDR.BacNodeFund)],
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
  ["ValidatorStaking", "DayAttested", { day: 20716n, validator: ADDR.validator, head: H32, ok: true, weight: 9n },
    (d) => { assert.equal(d.args.day, 20716); assert.equal(d.epoch, null, "day 不是纪元，不许塞进 epoch"); }],
  ["ValidatorStaking", "RewardsSettled", { day: 20716n, pot: 5n, weight: 6n, rate: 7n },
    (d) => assert.equal(d.args.rate, "7")],
  ["ValidatorStaking", "RewardClaimed", { day: 20716n, validator: ADDR.validator, to: ADDR.controller, amount: 4n },
    (d) => assert.equal(d.args.amount, "4")],
  ["ValidatorStaking", "RewardsFunded", { from: ADDR.BacNodeFund, amount: 3n, balanceAfter: 8n },
    (d) => assert.equal(d.args.balanceAfter, "8")],
  ["BacNodeFund", "ReleaseReceived", { from: ADDR.BacTaxRouter, amount: 5n, balanceAfter: 55n },
    (d) => { assert.equal(d.contract, "BacNodeFund"); assert.equal(d.args.balanceAfter, "55"); }],
  ["BacNodeFund", "Withdrawn", { to: ADDR.controller, amount: 12n, balanceAfter: 43n },
    (d) => { assert.equal(d.contract, "BacNodeFund"); assert.equal(d.args.amount, "12"); }],
  ["BacNodeFund", "OwnershipTransferred", { from: ZERO, to: ADDR.controller },
    (d) => { assert.equal(d.contract, "BacNodeFund"); assert.equal(d.args.to, ADDR.controller); }],
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
    const r = renderEvent(d, { bacToken: ADDR.BacToken });
    assert.ok(r.textZh && r.textZh.length > 0);
    assert.ok(!/undefined|NaN|\[object/.test(r.textZh), `渲染出了脏字符串：${r.textZh}`);
  });
}

test("v2 的 ABI 与 forge 编译产物逐条一致（有 contracts/out 时才核）", (t) => {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "out");
  // 只有整个 contracts/out 都不存在（服务器 / 没编译过的 CI）才跳过；目录在而某个产物缺了（改名、没编出来）必须失败，
  // 否则这条用例对「BacBridge 的事件改了而索引器没跟上」永远是绿的。
  if (!existsSync(out)) {
    t.skip("没有 contracts/out（没跑过 forge build）");
    return;
  }
  const pairs = [
    ["BacBridge.sol/BacBridge.json", "BacBridge"],
    ["BacTaxRouter.sol/BacTaxRouter.json", "BacTaxRouter"],
    ["BacNodeFund.sol/BacNodeFund.json", "BacNodeFund"],
    ["ChainAnchor.sol/ChainAnchor.json", "ChainAnchor"],
    ["ValidatorStaking.sol/ValidatorStaking.json", "ValidatorStaking"],
    ["L2Bridge.sol/L2Bridge.json", "L2Bridge"],
    ["L2Gate.sol/L2Gate.json", "L2Gate"],
    ["AgentBook.sol/AgentBook.json", "AgentBook"],
  ];
  let checked = 0;
  for (const [file, name] of pairs) {
    const path = join(out, file);
    assert.ok(existsSync(path), `contracts/out 在，但缺编译产物 ${file}（改名了？没编出来？）`);
    const abi = JSON.parse(readFileSync(path, "utf8")).abi;
    const sig = (e) => `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(",")})`;
    const compiled = abi.filter((x) => x.type === "event").map(sig).sort();
    const ours = [];
    IFACES[name].forEachEvent((f) =>
      ours.push(`${f.name}(${f.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(",")})`)
    );
    assert.deepEqual(ours.sort(), compiled, `${name} 的事件 ABI 与编译产物不一致`);
    checked += 1;
  }
  assert.equal(checked, pairs.length, "每一个合约都必须核过");
});

test("已删除的合约不再有 ABI（决策 #30 / #31）", () => {
  for (const gone of ["AgentRegistry", "BacTreasuryVault", "BacVaultFactory", "FlapVaultPortal"]) {
    assert.equal(IFACES[gone], undefined, `${gone} 应该已经删掉`);
  }
});

test("紧急提取的文案：BNB / BAC / 其他代币分开写，并写明第几次与提取时的账面", () => {
  const mk = (token) =>
    dec(mkLog("BacBridge", "EmergencyWithdraw", {
      by: ADDR.controller, to: ADDR.controller, token, amount: 2n * 10n ** 18n, balanceAfter: 0n,
      bookAtWithdraw: 2n * 10n ** 18n, lifetimeWithdrawn: 2n * 10n ** 18n, withdrawNumber: 3n, at: 1790000000n,
    }, { address: ADDR.BacBridge }), "bsc");
  const bnb = renderEvent(mk(ZERO), { bacToken: ADDR.BacToken }).textZh;
  const bac = renderEvent(mk(ADDR.BacToken), { bacToken: ADDR.BacToken }).textZh;
  const other = renderEvent(mk(ADDR.someContract), { bacToken: ADDR.BacToken }).textZh;
  assert.match(bnb, /紧急提取了 2 BNB/);
  assert.match(bnb, /第 3 次/);
  assert.match(bac, /紧急提取了 2 BAC/);
  assert.match(other, /个代币/);
});

test("退出兑付的单位是 BAC（决策 #24），不是 BNB", () => {
  const d = dec(mkLog("BacBridge", "EpochSettled", { epoch: 1n, pot: 10n ** 18n, owedTotalAfter: 0n, releaseBps: 350n, skipped: false },
    { address: ADDR.BacBridge }), "bsc");
  assert.match(renderEvent(d).textZh, /1 BAC/);
  assert.doesNotMatch(renderEvent(d).textZh, /BNB/);
});

test("同签名事件靠地址消歧：ReleaseReceived 在桥和节点基金上是两个合约", () => {
  const a = mkLog("BacBridge", "ReleaseReceived", { from: ADDR.BacTaxRouter, amount: 1n, bnbAfter: 2n }, { address: ADDR.BacBridge });
  const b = mkLog("BacNodeFund", "ReleaseReceived", { from: ADDR.BacTaxRouter, amount: 1n, balanceAfter: 2n }, { address: ADDR.BacNodeFund });
  assert.equal(a.topics[0], b.topics[0], "两个事件的 topic0 本来就该一样");
  assert.equal(dec(a, "bsc").contract, "BacBridge");
  assert.equal(dec(b, "bsc").contract, "BacNodeFund");
});

test("同签名事件靠地址消歧：OwnershipTransferred 在桥（OZ）和节点基金上参数名不同", () => {
  const a = mkLog("BacBridge", "OwnershipTransferred", { previousOwner: ZERO, newOwner: ADDR.controller }, { address: ADDR.BacBridge });
  const b = mkLog("BacNodeFund", "OwnershipTransferred", { from: ZERO, to: ADDR.controller }, { address: ADDR.BacNodeFund });
  assert.equal(a.topics[0], b.topics[0]);
  assert.equal(dec(a, "bsc").args.newOwner, ADDR.controller);
  assert.equal(dec(b, "bsc").args.to, ADDR.controller);
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
