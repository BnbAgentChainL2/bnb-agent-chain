// test/store.test.js —— 落库与幂等。
// 重点：重启重放同一批日志不许产生第二行、也不许把累加型字段（deploys/announces/credited/exited）加两次。
import test from "node:test";
import assert from "node:assert/strict";
import {
  ingestLogs, ingestLayerBlock, layerKeyFor, assignAnchorEpoch, anchoredThrough, anchoredThroughBlock, markAnchored, agentIdOfWallet,
} from "../src/store.js";
import { root as exitRootOf } from "../src/exit-tree.js";
import { resetWarnings, listWarnings } from "../src/warnings.js";
import { tempDb, cleanupTempDbs, mkLog, mkLock, mkLayerBlock, ADDR, TEST_CFG, TEST_BOOK, KIND } from "./helpers.js";

test.after(cleanupTempDbs);

const TS = 1790000000;
const feedIn = (db) => db.prepare("SELECT * FROM feed ORDER BY id").all();

function ingest(db, logs, chain = "bsc") {
  return ingestLogs(db, { chain, logs, cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS });
}

test("决策 #31：第一次锁桥就建出 agent 行（没有注册表、没有状态机）", () => {
  const { db } = tempDb();
  ingest(db, mkLock({ depositId: 0, agentId: 17, from: ADDR.agentWallet, amount: 5n * 10n ** 18n, blockNumber: 10 }));
  const a = db.prepare("SELECT * FROM agents WHERE agent_id = 17").get();
  assert.ok(a, "锁过桥的 ERC-8004 身份就是 agent");
  assert.equal(a.controller, ADDR.agentWallet, "第一次锁入的地址就是 agentController");
  assert.equal(a.wallet, ADDR.agentWallet);
  assert.equal(a.credited, "5000000000000000000");
  assert.equal(Number(a.first_lock_block), 10);
  assert.equal(Number(a.registered_at), TS);
  const w = db.prepare("SELECT * FROM agent_wallets WHERE agent_id = 17").all();
  assert.deepEqual(w.map((x) => x.wallet), [ADDR.agentWallet]);
  const f = feedIn(db);
  assert.deepEqual(f.map((x) => x.kind), ["AgentControllerSet", "Locked"]);
  assert.match(f[1].text_zh, /ERC-8004 身份/);
});

test("ERC-8004：一个身份从两个地址进桥（持有人 + agentWallet），两个地址都归到这个 agent", () => {
  const { db } = tempDb();
  ingest(db, [
    ...mkLock({ depositId: 0, agentId: 17, from: ADDR.controller, amount: 1n, blockNumber: 10 }),
    ...mkLock({ depositId: 1, agentId: 17, from: ADDR.agentWallet, amount: 2n, first: false, blockNumber: 11 }),
  ]);
  const a = db.prepare("SELECT * FROM agents WHERE agent_id = 17").get();
  assert.equal(a.controller, ADDR.controller, "后来的锁入不改 controller（BacBridge.lock 的规则）");
  assert.equal(a.credited, "3");
  const wallets = db.prepare("SELECT wallet FROM agent_wallets WHERE agent_id = 17 ORDER BY first_deposit_id").all();
  assert.deepEqual(wallets.map((x) => x.wallet), [ADDR.controller, ADDR.agentWallet]);
  assert.equal(agentIdOfWallet(db, ADDR.agentWallet), 17);
  assert.equal(agentIdOfWallet(db, ADDR.controller), 17);
  assert.equal(agentIdOfWallet(db, ADDR.validator), null);
});

test("ERC-8004：一个地址持有两个身份时，层内活动记在最早进桥的那个身份上", () => {
  const { db } = tempDb();
  ingest(db, [
    ...mkLock({ depositId: 0, agentId: 30, from: ADDR.agentWallet, amount: 1n, blockNumber: 10 }),
    ...mkLock({ depositId: 1, agentId: 17, from: ADDR.agentWallet, amount: 1n, blockNumber: 11 }),
  ]);
  assert.equal(agentIdOfWallet(db, ADDR.agentWallet), 30);
});

test("AgentControllerSet：setAgentController 之后 controller 跟着变", () => {
  const { db } = tempDb();
  ingest(db, mkLock({ depositId: 0, agentId: 17, from: ADDR.agentWallet, amount: 1n, blockNumber: 10 }));
  ingest(db, [mkLog("BacBridge", "AgentControllerSet", { agentId: 17n, previous: ADDR.agentWallet, current: ADDR.validator },
    { address: ADDR.BacBridge, blockNumber: 12 })]);
  assert.equal(db.prepare("SELECT controller FROM agents WHERE agent_id = 17").get().controller, ADDR.validator);
  assert.match(feedIn(db).at(-1).text_zh, /逃生领取地址改为/);
});

test("同一批日志摄入两次：行数不变、累加字段不翻倍", () => {
  const { db } = tempDb();
  const logs = mkLock({ depositId: 12, agentId: 7, from: ADDR.controller, layerWallet: ADDR.agentWallet, amount: 100n, blockNumber: 10 });
  // 关键：第二次必须用**同样的 txHash 与 logIndex**，这才是重启重放的样子
  ingest(db, logs);
  ingest(db, logs);

  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM logs").get().c), 2);
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM feed").get().c), 2);
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM deposits").get().c), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM agent_wallets").get().c), 1);
  const a = db.prepare("SELECT * FROM agents WHERE agent_id = 7").get();
  assert.equal(a.credited, "100", "credited 被加了两次");
});

test("deposits.layer_key 是 keccak 那一个，不是事件里的自增 depositId", () => {
  const { db } = tempDb();
  const log = mkLog("BacBridge", "Locked", {
    depositId: 12n, agentId: 7n, from: ADDR.controller, layerWallet: ADDR.agentWallet,
    measured: 1n, credits: 1n, totalIssued: 1n,
  }, { address: ADDR.BacBridge, blockNumber: 10, logIndex: 4 });
  ingest(db, [log]);
  const d = db.prepare("SELECT * FROM deposits WHERE deposit_id = 12").get();
  const expect = layerKeyFor(56, ADDR.BacBridge, log.transactionHash, 4);
  assert.equal(d.layer_key, expect);
  assert.notEqual(d.layer_key, "12");
});

test("层内 CreditsMinted 回填 deposits 的 layer_tx 与 lag_sec", () => {
  const { db } = tempDb();
  const lockLog = mkLog("BacBridge", "Locked", {
    depositId: 12n, agentId: 7n, from: ADDR.controller, layerWallet: ADDR.agentWallet,
    measured: 1n, credits: 1n, totalIssued: 1n,
  }, { address: ADDR.BacBridge, blockNumber: 10, logIndex: 0 });
  ingest(db, [lockLog]);
  const layerKey = layerKeyFor(56, ADDR.BacBridge, lockLog.transactionHash, 0);
  const mintLog = mkLog("L2Bridge", "CreditsMinted", {
    depositId: layerKey, agentId: 7n, to: ADDR.agentWallet, amount: 1n,
  }, { address: ADDR.L2Bridge, blockNumber: 500, logIndex: 0 });
  ingestLogs(db, { chain: "layer", logs: [mintLog], cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS + 61 });
  const d = db.prepare("SELECT * FROM deposits WHERE deposit_id = 12").get();
  assert.equal(d.layer_block, 500);
  assert.equal(Number(d.lag_sec), 61);
});

test("退出：ExitBurned 建行，ExitClaimed 回填 claimed_tx / 锁定的 BAC / anchor_epoch，exited 只加一次", () => {
  const { db } = tempDb();
  ingest(db, mkLock({ depositId: 0, agentId: 17, from: ADDR.controller, amount: 100n, blockNumber: 5 }));
  ingestLogs(db, {
    chain: "layer",
    logs: [mkLog("L2Bridge", "ExitBurned", { exitId: 41n, agentId: 17n, bscRecipient: ADDR.controller, amount: 20n, epoch: 20718n },
      { address: ADDR.L2Bridge, blockNumber: 1234501 })],
    cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS,
  });
  let e = db.prepare("SELECT * FROM exits WHERE exit_id = 41").get();
  assert.equal(Number(e.born_epoch), 20718);
  assert.equal(e.anchor_epoch, null);

  const claim = mkLog("BacBridge", "ExitClaimed", {
    anchorEpoch: 20719n, exitId: 41n, agentId: 17n, to: ADDR.controller,
    credits: 20n, lockedBacAmt: 777n, rateUsed: 1n, attributed: 1n,
  }, { address: ADDR.BacBridge, blockNumber: 20 });
  ingest(db, [claim]);
  ingest(db, [claim]);
  e = db.prepare("SELECT * FROM exits WHERE exit_id = 41").get();
  assert.equal(Number(e.anchor_epoch), 20719);
  assert.equal(e.locked_wei, "777", "v2：这一列存的是锁定的 BAC（回购来的），列名是 001 的历史名字");
  assert.ok(e.claimed_tx);
  assert.equal(db.prepare("SELECT exited FROM agents WHERE agent_id = 17").get().exited, "20");
});

test("锚点归属：本地重算的 exitRoot 对得上才写 anchor_epoch", () => {
  const { db } = tempDb();
  resetWarnings();
  const exits = [
    { exitId: 1n, agentId: 17n, to: ADDR.controller, credits: 100n },
    { exitId: 2n, agentId: 18n, to: ADDR.agentWallet, credits: 200n },
  ];
  ingestLogs(db, {
    chain: "layer",
    logs: exits.map((x, i) =>
      mkLog("L2Bridge", "ExitBurned", { exitId: x.exitId, agentId: x.agentId, bscRecipient: x.to, amount: x.credits, epoch: 20718n },
        { address: ADDR.L2Bridge, blockNumber: 1000 + i, logIndex: i })
    ),
    cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS,
  });
  const good = exitRootOf(exits, 56777, ADDR.BacBridge);
  const r = assignAnchorEpoch(db, TEST_CFG, 20718, 2, good);
  assert.equal(r.ok, true);
  assert.equal(r.assigned, 2);
  assert.equal(Number(db.prepare("SELECT anchor_epoch FROM exits WHERE exit_id = 1").get().anchor_epoch), 20718);
});

test("锚点归属：根对不上就不写，并且必须留下告警（宁可停，不可错）", () => {
  const { db } = tempDb();
  resetWarnings();
  ingestLogs(db, {
    chain: "layer",
    logs: [mkLog("L2Bridge", "ExitBurned", { exitId: 1n, agentId: 17n, bscRecipient: ADDR.controller, amount: 100n, epoch: 20718n },
      { address: ADDR.L2Bridge, blockNumber: 1000 })],
    cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS,
  });
  const r = assignAnchorEpoch(db, TEST_CFG, 20718, 1, "0x" + "ee".repeat(32));
  assert.equal(r.ok, false);
  assert.equal(r.assigned, 0);
  assert.equal(db.prepare("SELECT anchor_epoch FROM exits WHERE exit_id = 1").get().anchor_epoch, null);
  assert.ok(listWarnings().includes("anchor_root_mismatch"));
  resetWarnings();
});

test("被否决的纪元把未领取的退出归属清空，等下一个锚点重报", () => {
  const { db } = tempDb();
  resetWarnings();
  const exits = [{ exitId: 1n, agentId: 17n, to: ADDR.controller, credits: 100n }];
  ingestLogs(db, {
    chain: "layer",
    logs: [mkLog("L2Bridge", "ExitBurned", { exitId: 1n, agentId: 17n, bscRecipient: ADDR.controller, amount: 100n, epoch: 20718n },
      { address: ADDR.L2Bridge, blockNumber: 1000 })],
    cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS,
  });
  ingest(db, [mkLog("ChainAnchor", "AnchorPosted", {
    epoch: 20718n, exitRoot: exitRootOf(exits, 56777, ADDR.BacBridge), l2BlockHash: "0x" + "cd".repeat(32),
    l2Block: 1234567n, credited: 1n, exitCredits: 100n, feeBurned: 0n, circulating: 1n, exitCount: 1n,
  }, { address: ADDR.ChainAnchor, blockNumber: 30 })]);
  assert.equal(Number(db.prepare("SELECT anchor_epoch FROM exits WHERE exit_id = 1").get().anchor_epoch), 20718);

  ingest(db, [mkLog("ChainAnchor", "AnchorVetoed", { epoch: 20718n, by: ADDR.controller, reasonHash: "0x" + "00".repeat(32), countInWindow: 1n },
    { address: ADDR.ChainAnchor, blockNumber: 31 })]);
  assert.equal(db.prepare("SELECT anchor_epoch FROM exits WHERE exit_id = 1").get().anchor_epoch, null);
  assert.equal(db.prepare("SELECT state FROM epochs WHERE epoch = 20718").get().state, "VETOED");
  resetWarnings();
});

test("§4.3：收据里的 contractAddress 派生 DEPLOY，to 指向已知合约派生 CALL", () => {
  const { db } = tempDb();
  db.prepare(
    "INSERT INTO agents (agent_id, controller, wallet, agent_uri, endpoint_hash, model_fp, status, registered_at) VALUES (17, ?, ?, '', '', '', 2, 1)"
  ).run(ADDR.controller, ADDR.agentWallet);

  const created = ADDR.someContract;
  const b1 = mkLayerBlock({
    number: 1234560,
    ts: TS,
    txs: [{ from: ADDR.agentWallet, to: null, created, codeSize: 12844 }],
  });
  ingestLayerBlock(db, { ...b1, cfg: TEST_CFG });
  const c = db.prepare("SELECT * FROM contracts WHERE address = ?").get(created);
  assert.equal(Number(c.code_size), 12844);
  assert.equal(Number(c.agent_id), 17);
  assert.equal(Number(db.prepare("SELECT deploys FROM agents WHERE agent_id = 17").get().deploys), 1);
  let f = feedIn(db);
  assert.equal(f[0].kind, "DEPLOY");
  assert.match(f[0].text_zh, /部署了一个新合约/);
  assert.match(f[0].text_zh, /12,844 字节/);

  const b2 = mkLayerBlock({ number: 1234561, ts: TS + 3, txs: [{ from: ADDR.agentWallet, to: created }] });
  ingestLayerBlock(db, { ...b2, cfg: TEST_CFG });
  f = feedIn(db);
  assert.equal(f[1].kind, "CALL");
  assert.match(f[1].text_zh, /调用了/);
  assert.equal(Number(db.prepare("SELECT call_count FROM contracts WHERE address = ?").get(created).call_count), 1);

  // 同一个块再摄入一次：call_count 不许再加
  ingestLayerBlock(db, { ...b2, cfg: TEST_CFG });
  assert.equal(Number(db.prepare("SELECT call_count FROM contracts WHERE address = ?").get(created).call_count), 1);
});

test("同一个层内区块摄入两次：blocks / txs / feed 都不重复", () => {
  const { db } = tempDb();
  const b = mkLayerBlock({ number: 5, ts: TS, txs: [{ from: ADDR.agentWallet, to: ADDR.controller }] });
  ingestLayerBlock(db, { ...b, cfg: TEST_CFG });
  ingestLayerBlock(db, { ...b, cfg: TEST_CFG });
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM blocks").get().c), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM txs").get().c), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM feed").get().c), 0);
});

test("AgentBook.Action 落 actions 表，announces 只加一次", () => {
  const { db } = tempDb();
  db.prepare(
    "INSERT INTO agents (agent_id, controller, wallet, agent_uri, endpoint_hash, model_fp, status, registered_at) VALUES (17, ?, ?, '', '', '', 2, 1)"
  ).run(ADDR.controller, ADDR.agentWallet);
  const log = mkLog("AgentBook", "Action", {
    agentId: 17n, kind: KIND("PUBLISH"), subject: ADDR.controller, actor: ADDR.agentWallet,
    contentHash: "0x" + "11".repeat(32), summary: "第一篇", uri: "ipfs://x", seq: 1n, epoch: 20718n,
  }, { address: ADDR.AgentBook, blockNumber: 900 });
  ingestLogs(db, { chain: "layer", logs: [log, log], cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS });
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM actions").get().c), 1);
  assert.equal(Number(db.prepare("SELECT announces FROM agents WHERE agent_id = 17").get().announces), 1);
  const a = db.prepare("SELECT * FROM actions WHERE seq = 1").get();
  assert.equal(a.kind, "PUBLISH");
  assert.equal(a.kind_hash, KIND("PUBLISH"));
  assert.equal(a.summary, "第一篇", "summary 必须原样入库，转义只在出库时做");
});

test("层内 feed 在锚点定案前是未锚定，定案后按块高翻成已锚定", () => {
  const { db } = tempDb();
  const E = Math.floor(TS / 600);
  const log = mkLog("L2Bridge", "ExitBurned", { exitId: 1n, agentId: 17n, bscRecipient: ADDR.controller, amount: 1n, epoch: BigInt(E) },
    { address: ADDR.L2Bridge, blockNumber: 900 });
  ingestLogs(db, { chain: "layer", logs: [log], cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS });
  assert.equal(Number(feedIn(db)[0].anchored), 0);
  assert.equal(Number(feedIn(db)[0].epoch), E);
  assert.equal(anchoredThroughBlock(db), null, "还没有 FINAL 锚点");
  // 锚点承诺到第 899 块：第 900 块还没被覆盖
  db.prepare("INSERT INTO epochs (epoch, state, l2_block) VALUES (?, 'FINAL', 899)").run(E);
  assert.equal(anchoredThrough(db), E);
  assert.equal(markAnchored(db, anchoredThroughBlock(db)), 0);
  assert.equal(Number(feedIn(db)[0].anchored), 0);
  // 下一个锚点承诺到第 900 块：翻成已锚定
  db.prepare("INSERT INTO epochs (epoch, state, l2_block) VALUES (?, 'FINAL', 900)").run(E + 1);
  assert.equal(markAnchored(db, anchoredThroughBlock(db)), 1);
  assert.equal(Number(feedIn(db)[0].anchored), 1);
});

test("锚定按块高、不按纪元号：一个 FINAL 锚点不许把它之后的层内块标成已锚定（旧的 86400 / 600 单位错配）", () => {
  const { db } = tempDb();
  // 复现：块时间 1790000000，旧版 epochOf 给的是天序号 20717；600 秒纪元是 2983333
  ingestLayerBlock(db, {
    ...mkLayerBlock({ number: 5000, ts: 1790000000, txs: [{ from: ADDR.agentWallet, to: null, created: ADDR.someContract, codeSize: 10 }] }),
    cfg: TEST_CFG,
  });
  // AgentBook.Action 带的是天序号（AgentBook.EPOCH = 86400）
  const act = mkLog("AgentBook", "Action", {
    agentId: 17n, kind: KIND("PUBLISH"), subject: ADDR.controller, actor: ADDR.agentWallet,
    contentHash: "0x" + "11".repeat(32), summary: "x", uri: "", seq: 1n, epoch: 20717n,
  }, { address: ADDR.AgentBook, blockNumber: 5000, logIndex: 0 });
  ingestLogs(db, { chain: "layer", logs: [act], cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => 1790000000 });
  const rows = feedIn(db);
  assert.deepEqual(rows.map((r) => Number(r.epoch)), [2983333, 2983333], "feed.epoch 一律是 600 秒纪元");
  assert.equal(Number(db.prepare("SELECT epoch FROM blocks WHERE number = 5000").get().epoch), 2983333);
  assert.equal(Number(db.prepare("SELECT epoch FROM actions WHERE seq = 1").get().epoch), 20717, "天序号只留在 actions.epoch");
  // 一个比这一块早一天定案的锚点（600 秒纪元 2983189，承诺到第 4000 块）
  db.prepare("INSERT INTO epochs (epoch, state, l2_block) VALUES (2983189, 'FINAL', 4000)").run();
  assert.equal(markAnchored(db, anchoredThroughBlock(db)), 0, "第 5000 块在锚点之后，不许被标成已锚定");
  assert.ok(feedIn(db).every((r) => Number(r.anchored) === 0));
});

test("节点基金提取必须进 feed 且写明 owner 可提取（决策 #10）", () => {
  const { db } = tempDb();
  ingest(db, [mkLog("BacNodeFund", "Withdrawn", { to: ADDR.controller, amount: 12n * 10n ** 18n, balanceAfter: 0n },
    { address: ADDR.BacNodeFund, blockNumber: 40 })]);
  const f = feedIn(db)[0];
  assert.equal(f.kind, "Withdrawn");
  assert.match(f.text_zh, /官方节点基金被提取/);
  assert.match(f.text_zh, /owner/);
});

test("决策 #29c：桥的升级与紧急提取必须进 feed，并照实写出是项目方做的", () => {
  const { db } = tempDb();
  const impl1 = "0x1000000000000000000000000000000000000001";
  const impl2 = "0x1000000000000000000000000000000000000002";
  ingest(db, [
    mkLog("BacBridge", "BridgeUpgraded", {
      newImplementation: impl2, previousImplementation: impl1, by: ADDR.controller, upgradeNumber: 1n, at: BigInt(TS),
      bnbBook: 10n ** 18n, lockedBacBook: 0n, buybackBacBook: 0n, owedTotalBook: 0n,
    }, { address: ADDR.BacBridge, blockNumber: 50, logIndex: 0 }),
    mkLog("BacBridge", "Upgraded", { implementation: impl2 }, { address: ADDR.BacBridge, blockNumber: 50, logIndex: 1 }),
    mkLog("BacBridge", "EmergencyWithdraw", {
      by: ADDR.controller, to: ADDR.controller, token: "0x0000000000000000000000000000000000000000",
      amount: 10n ** 18n, balanceAfter: 0n, bookAtWithdraw: 10n ** 18n, lifetimeWithdrawn: 10n ** 18n,
      withdrawNumber: 1n, at: BigInt(TS),
    }, { address: ADDR.BacBridge, blockNumber: 51, logIndex: 0 }),
  ]);
  const f = feedIn(db);
  assert.deepEqual(f.map((x) => x.kind), ["BridgeUpgraded", "Upgraded", "EmergencyWithdraw"]);
  assert.match(f[0].text_zh, /项目方升级了桥合约（第 1 次）/);
  assert.match(f[2].text_zh, /项目方从桥里紧急提取了 1 BNB/);
  assert.equal(Number(f[2].anchored), 1, "BSC 侧事件一律是已上链的事实");
});

test("决策 #30：税收路由的四个事件都进 feed，推送失败写明可以 retryPush()", () => {
  const { db } = tempDb();
  ingest(db, [
    mkLog("BacTaxRouter", "RevenueRecognized", { from: ADDR.TaxProcessor, amount: 2n * 10n ** 18n },
      { address: ADDR.BacTaxRouter, blockNumber: 60, logIndex: 0 }),
    mkLog("BacTaxRouter", "RevenueSplit", { toBridge: 10n ** 18n, toNodeFund: 10n ** 18n },
      { address: ADDR.BacTaxRouter, blockNumber: 61, logIndex: 0 }),
    mkLog("BacTaxRouter", "PushSucceeded", { to: ADDR.BacBridge, amount: 10n ** 18n },
      { address: ADDR.BacTaxRouter, blockNumber: 61, logIndex: 1 }),
    mkLog("BacTaxRouter", "PushFailed", { to: ADDR.BacNodeFund, amount: 10n ** 18n },
      { address: ADDR.BacTaxRouter, blockNumber: 61, logIndex: 2 }),
  ]);
  const f = feedIn(db);
  assert.equal(f.length, 4);
  assert.match(f[1].text_zh, /桥池 1 BNB \/ 官方节点基金 1 BNB/);
  assert.match(f[3].text_zh, /retryPush/);
  const dec = db.prepare("SELECT contract FROM decoded_events").all().map((r) => r.contract);
  assert.ok(dec.every((c) => c === "BacTaxRouter"));
});

test("ValidatorStaking.RewardsSettled 是按天的，不写进 epochs 表（天 ≠ 纪元）", () => {
  const { db } = tempDb();
  ingest(db, [mkLog("ValidatorStaking", "RewardsSettled", { day: 20716n, pot: 5n, weight: 6n, rate: 7n },
    { address: ADDR.ValidatorStaking, blockNumber: 70 })]);
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM epochs").get().c), 0);
  assert.match(feedIn(db)[0].text_zh, /第 20716 天/);
});
