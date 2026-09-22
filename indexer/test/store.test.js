// test/store.test.js —— 落库与幂等。
// 重点：重启重放同一批日志不许产生第二行、也不许把累加型字段（solved/deploys/announces/credited）加两次。
import test from "node:test";
import assert from "node:assert/strict";
import { ingestLogs, ingestLayerBlock, layerKeyFor, assignAnchorEpoch, anchoredThrough, markAnchored } from "../src/store.js";
import { root as exitRootOf } from "../src/exit-tree.js";
import { resetWarnings, listWarnings } from "../src/warnings.js";
import { tempDb, cleanupTempDbs, mkLog, mkLayerBlock, ADDR, TEST_CFG, TEST_BOOK, KIND } from "./helpers.js";

test.after(cleanupTempDbs);

const TS = 1790000000;
const feedIn = (db) => db.prepare("SELECT * FROM feed ORDER BY id").all();

function ingest(db, logs, chain = "bsc") {
  return ingestLogs(db, { chain, logs, cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS });
}

test("注册 + 转正：agents 表写对，状态从 1 变 2", () => {
  const { db } = tempDb();
  ingest(db, [
    mkLog("AgentRegistry", "Registered", {
      agentId: 17n, controller: ADDR.controller, agentWallet: ADDR.agentWallet,
      agentURI: "https://a.invalid/agent.json", endpointHash: "0x" + "11".repeat(32), modelFingerprint: "0x" + "22".repeat(32),
    }, { address: ADDR.AgentRegistry, blockNumber: 10, logIndex: 0 }),
  ]);
  let a = db.prepare("SELECT * FROM agents WHERE agent_id = 17").get();
  assert.equal(a.status, 1);
  assert.equal(a.wallet, ADDR.agentWallet);
  ingest(db, [
    mkLog("AgentRegistry", "Activated", { agentId: 17n, agentWallet: ADDR.agentWallet },
      { address: ADDR.AgentRegistry, blockNumber: 11, logIndex: 0 }),
  ]);
  a = db.prepare("SELECT * FROM agents WHERE agent_id = 17").get();
  assert.equal(a.status, 2);
  assert.equal(Number(a.activated_at), TS);
});

test("同一批日志摄入两次：行数不变、累加字段不翻倍", () => {
  const { db } = tempDb();
  const logs = [
    mkLog("AgentRegistry", "Registered", {
      agentId: 7n, controller: ADDR.controller, agentWallet: ADDR.agentWallet,
      agentURI: "u", endpointHash: "0x" + "11".repeat(32), modelFingerprint: "0x" + "22".repeat(32),
    }, { address: ADDR.AgentRegistry, blockNumber: 10, logIndex: 0 }),
    mkLog("AgentRegistry", "ChallengeSolved", { agentId: 7n, challengeId: "0x" + "33".repeat(32), blocksUsed: 2n, round: 1n },
      { address: ADDR.AgentRegistry, blockNumber: 10, logIndex: 1 }),
    mkLog("BacBridge", "Locked", {
      depositId: 12n, agentId: 7n, from: ADDR.controller, layerWallet: ADDR.agentWallet,
      measured: 100n, credits: 100n, totalIssued: 100n,
    }, { address: ADDR.BacBridge, blockNumber: 10, logIndex: 2 }),
  ];
  // 关键：第二次必须用**同样的 txHash 与 logIndex**，这才是重启重放的样子
  ingest(db, logs);
  ingest(db, logs);

  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM logs").get().c), 3);
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM feed").get().c), 3);
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM deposits").get().c), 1);
  const a = db.prepare("SELECT * FROM agents WHERE agent_id = 7").get();
  assert.equal(Number(a.solved), 1, "solved 被加了两次");
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

test("退出：ExitBurned 建行，ExitClaimed 回填 claimed_tx / locked_wei / anchor_epoch", () => {
  const { db } = tempDb();
  ingestLogs(db, {
    chain: "layer",
    logs: [mkLog("L2Bridge", "ExitBurned", { exitId: 41n, agentId: 17n, bscRecipient: ADDR.controller, amount: 20n, epoch: 20718n },
      { address: ADDR.L2Bridge, blockNumber: 1234501 })],
    cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS,
  });
  let e = db.prepare("SELECT * FROM exits WHERE exit_id = 41").get();
  assert.equal(Number(e.born_epoch), 20718);
  assert.equal(e.anchor_epoch, null);

  ingest(db, [mkLog("BacBridge", "ExitClaimed", {
    anchorEpoch: 20719n, exitId: 41n, agentId: 17n, to: ADDR.controller,
    credits: 20n, lockedWei: 777n, rateUsed: 1n, attributed: 1n,
  }, { address: ADDR.BacBridge, blockNumber: 20 })]);
  e = db.prepare("SELECT * FROM exits WHERE exit_id = 41").get();
  assert.equal(Number(e.anchor_epoch), 20719);
  assert.equal(e.locked_wei, "777");
  assert.ok(e.claimed_tx);
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

  const created = ADDR.BacVaultFactory;
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

test("层内 feed 在纪元定案前是未锚定，定案后翻成已锚定", () => {
  const { db } = tempDb();
  const log = mkLog("L2Bridge", "ExitBurned", { exitId: 1n, agentId: 17n, bscRecipient: ADDR.controller, amount: 1n, epoch: 20718n },
    { address: ADDR.L2Bridge, blockNumber: 900 });
  ingestLogs(db, { chain: "layer", logs: [log], cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS });
  assert.equal(Number(feedIn(db)[0].anchored), 0);
  db.prepare("INSERT INTO epochs (epoch, state) VALUES (20718, 'FINAL')").run();
  assert.equal(anchoredThrough(db), 20718);
  markAnchored(db, 20718);
  assert.equal(Number(feedIn(db)[0].anchored), 1);
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
