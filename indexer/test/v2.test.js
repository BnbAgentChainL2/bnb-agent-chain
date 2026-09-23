// test/v2.test.js —— BSC 侧 v2（决策 #29 / #30 / #31 / #32 / #33 / #35）专属的用例：
//   * 创世分配项（对账为什么在演练链上是 −1e24，以及怎么把它公开地配平）；
//   * ERC-8004 身份读数与注册文件解析（自述、不抓链接）；
//   * 快照的三个阶段：没部署 / 合约部署了但代币没发射 / 代币发射了；
//   * eth_call 被 revert 时不重试；BSC 只摄我们自己合约的日志；配置的默认值与旧环境变量。
// 全程离线：假 RPC 在本进程里，唯一的「网络」是 127.0.0.1 上一个本测试自己起的 HTTP 服务。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { parseGenesisAlloc, readGenesisAlloc, resetGenesisCache } from "../src/genesis.js";
import {
  parseRegistration, walletFromMetadata, readIdentity, refreshIdentities, identityOf, TOKEN_URI_MAX,
} from "../src/identity.js";
import { refreshSnapshot, VIEWS, stageOf, checkWiring, WIRING_WARNINGS, bscReadRpc, resetReadRpcCache } from "../src/snapshot.js";
import {
  Rpc, RpcError, isRevertError, isHistoryUnavailableError, getLogsChunked, FailoverRpc, FAILOVER_PRIMARY_OPTS, FAILOVER_LAST_OPTS,
} from "../src/rpc.js";
import { computeReconcile, layerCirculating } from "../src/api/handlers.js";
import { loadConfig, bscLogAddresses, addressBook, enodeOrNull } from "../src/config.js";
import { bscTick } from "../src/ingest.js";
import { ingestLogs } from "../src/store.js";
import { route } from "../src/api/server.js";
import { resetWarnings, listWarnings } from "../src/warnings.js";
import { EIP1967_IMPLEMENTATION_SLOT, BSC_BAC_TOKEN, BSC_IDENTITY_REGISTRY, BSC_FLAP_PORTAL } from "../src/abi.js";
import { tempDb, cleanupTempDbs, mkLock, ADDR, TEST_CFG, TEST_BOOK } from "./helpers.js";

test.after(cleanupTempDbs);

const TS = 1790000000;
const OWNER = getAddress("0x934a6678120b85652D2CC818C69774ea17012844");
const HARDHAT0 = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const VALIDATOR = getAddress("0x729d90c32FF111D9686Fe04B201EcAC7A7F7Cf05");
const IMPL = getAddress("0x1000000000000000000000000000000000000001");
const NOTICE = "项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。";
const ENODE =
  "enode://8bc629391bad4d09cde161acf298d25ffb5dc2eee22c64acd9b0cd40596176b34c189a01a0787879cc4205dd8a1312dff141d06f284f6a1eb2b7c91e98cfb564@95.179.183.132:30303";
const GENESIS_HASH = "0x6d164838742ab651f9369e6d0cb238019036484ae66f0619f64683e692fac1f8";

// ===================== 创世分配项 =====================

test("创世分配：演练链只有一个预置账户、L2Bridge 没有预置余额 —— genesisAlloc 就是那一个账户", () => {
  // 2026-09-23 线上 https://bnbagentchain-rpc.xyz/genesis.json 的 alloc 原样
  const g = parseGenesisAlloc({ alloc: { "70997970c51812dc3a010c7d01b50e0d17dc79c8": { balance: "0xd3c21bcecceda1000000" } } });
  assert.equal(g.supply, (10n ** 24n).toString());
  assert.equal(g.bridgeAlloc, "0");
  assert.equal(g.genesisAlloc, (10n ** 24n).toString());
  assert.deepEqual(g.accounts, [{ addr: HARDHAT0, balance: (10n ** 24n).toString() }]);
});

test("创世分配：正式链形状（L2Bridge 持有总量减去中继浮存）—— genesisAlloc 只有中继那 1,000 BAC", () => {
  const float = 1000n * 10n ** 18n;
  const g = parseGenesisAlloc({
    alloc: {
      "0x0000000000000000000000000000000000000101": { balance: "0x" + (10n ** 27n - float).toString(16), code: "0x60" },
      "0x0000000000000000000000000000000000000102": { balance: "0x0", code: "0x60" },
      "0x000000000000000000000000000000000000dEaD": { balance: "0x0" },
      "0x000000000000000000000000000000000000e1a4": { balance: "0x" + float.toString(16) },
    },
  });
  assert.equal(g.supply, (10n ** 27n).toString());
  assert.equal(g.bridgeAlloc, (10n ** 27n - float).toString());
  assert.equal(g.genesisAlloc, float.toString());
  assert.equal(g.accounts.length, 1, "余额为 0 的地址不列");
  assert.equal(g.accounts[0].addr, getAddress("0x000000000000000000000000000000000000e1a4"));
});

test("创世分配：读文件有缓存；文件不存在返回 null（调用方必须照实说读不到）", () => {
  resetGenesisCache();
  const dir = mkdtempSync(join(tmpdir(), "bac-gen-"));
  const p = join(dir, "genesis.json");
  writeFileSync(p, JSON.stringify({ alloc: { [HARDHAT0]: { balance: "1000" } } }));
  const g = readGenesisAlloc(p);
  assert.equal(g.supply, "1000");
  assert.equal(g.source, p);
  assert.equal(readGenesisAlloc(join(dir, "nope.json")), null);
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.equal(readGenesisAlloc(join(dir, "bad.json")), null);
});

// ===================== ERC-8004 身份 =====================

test("注册文件：data:application/json;base64 解出几个字段，别的一概不收", () => {
  const j = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "ClawNews",
    description: "x".repeat(5000),
    image: "https://img.invalid/a.png",
    endpoints: [{ name: "MCP", endpoint: "https://m.invalid" }],
    secretStuff: { a: 1 },
  };
  const r = parseRegistration("data:application/json;base64," + Buffer.from(JSON.stringify(j)).toString("base64"));
  assert.equal(r.kind, "data-json");
  assert.equal(r.fields.name, "ClawNews");
  assert.equal(r.fields.description.length, 2000, "自述文本要截断");
  assert.deepEqual(r.fields.services, [{ name: "MCP", endpoint: "https://m.invalid", version: null, linkable: true }]);
  assert.equal(r.fields.secretStuff, undefined);
  assert.deepEqual(r.fields.dropped, []);
});

test("注册文件：控制字符 / 双向控制符 / 零宽字符去掉；image 只认 https/ipfs/ar；endpoint 危险 scheme 丢掉、非链接只标 linkable=false", () => {
  const RLO = "\u202e";
  const j = {
    name: `Good${RLO}exe.jpg\u0000\u200b`,
    description: "line1\nline2\u2066x\u2069\u0007",
    type: { nested: "object" },
    image: "javascript:alert(1)",
    services: [
      { name: "web", endpoint: "java\tscript:alert(1)" },
      { name: "ENS", endpoint: "agent.eth" },
      { name: "old", endpoint: "http://plain.invalid" },
      { name: "A2A", endpoint: "ipfs://bafy" },
      { name: "img", endpoint: "data:text/html,<script>1</script>" },
    ],
    supportedTrust: ["reputation\u200f"],
  };
  const r = parseRegistration("data:application/json;base64," + Buffer.from(JSON.stringify(j)).toString("base64"));
  assert.equal(r.kind, "data-json");
  assert.equal(r.fields.name, "Goodexe.jpg", "RLO / NUL / 零宽空格都去掉");
  assert.equal(r.fields.description, "line1 line2x", "换行换成空格，隔离符与响铃去掉");
  assert.equal(r.fields.type, null, "对象不 String() 成 [object Object]");
  assert.equal(r.fields.image, null);
  assert.deepEqual(r.fields.services.map((x) => [x.endpoint, x.linkable]), [
    [null, false],
    ["agent.eth", false],
    ["http://plain.invalid", false],
    ["ipfs://bafy", true],
    [null, false],
  ]);
  assert.deepEqual(r.fields.supportedTrust, ["reputation"]);
  assert.deepEqual(r.fields.dropped, ["image", "services[0].endpoint", "services[4].endpoint"]);
  // data: 图片（可以内嵌 SVG 脚本）也不当链接
  const img = parseRegistration("data:application/json," + encodeURIComponent(JSON.stringify({ image: "data:image/svg+xml;base64,PHN2Zz4=" })));
  assert.equal(img.fields.image, null);
  assert.deepEqual(img.fields.dropped, ["image"]);
  const ok = parseRegistration("data:application/json," + encodeURIComponent(JSON.stringify({ image: "ar://abc" })));
  assert.equal(ok.fields.image, "ar://abc");
});

test("tokenURI 不是 https/ipfs/ar：kind = 'text'（主网 agent #2 的 tokenURI 就是一个裸 0x… 字符串）；出库时旧行也按白名单重判", () => {
  assert.deepEqual(parseRegistration("0x6446ad98d161"), { kind: "text", fields: null });
  assert.deepEqual(parseRegistration("javascript:alert(1)"), { kind: "text", fields: null });
  assert.deepEqual(parseRegistration("http://agent.invalid/reg.json"), { kind: "text", fields: null });
  assert.deepEqual(parseRegistration("HTTPS://agent.invalid/reg.json"), { kind: "uri", fields: null });
  assert.deepEqual(parseRegistration("ar://tx"), { kind: "uri", fields: null });
  assert.deepEqual(parseRegistration("DATA:text/plain,hi"), { kind: "unparsable", fields: null });

  const { db } = tempDb();
  const put = (id, uri, kind, regJson = null) =>
    db.prepare(
      `INSERT INTO agent_identity (agent_id, registry, exists_on_registry, holder, token_uri, reg_kind, reg_json, checked_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(id, ADDR.IdentityRegistry, OWNER, uri, kind, regJson, TS);
  // 旧规则存下的行：非 data: 的一律记成了 'uri'，reg_json 也没洗过
  put(2, "0x6446ad98\u202ed161", "uri");
  put(3, "javascript:alert(document.cookie)", "uri");
  put(4, "https://ok.invalid/\u202ereg.json", "uri");
  put(5, "data:application/json,{}", "data-json", JSON.stringify({
    name: "N\u202eX", image: "javascript:x", services: [{ name: "s", endpoint: "vbscript:x", version: null }], servicesTotal: 1, supportedTrust: [],
  }));
  const i2 = identityOf(db, 2).registration;
  assert.equal(i2.kind, "text");
  assert.equal(i2.uri, null, "不是链接就不放进 uri");
  assert.equal(i2.text, "0x6446ad98d161", "纯文本给出，双向控制符去掉");
  const i3 = identityOf(db, 3).registration;
  assert.equal(i3.kind, "text");
  assert.equal(i3.text, null, "javascript: 连文本都不给");
  const i4 = identityOf(db, 4).registration;
  assert.equal(i4.kind, "uri");
  assert.equal(i4.uri, "https://ok.invalid/reg.json");
  const i5 = identityOf(db, 5).registration;
  assert.equal(i5.name, "NX");
  assert.equal(i5.image, null);
  assert.equal(i5.services[0].endpoint, null);
  assert.deepEqual(i5.dropped, ["image", "services[0].endpoint"]);
});

test("注册文件：URL 编码的 data: 也认；外部链接只标 uri、不抓取；空与坏的照实标", () => {
  const plain = parseRegistration("data:application/json," + encodeURIComponent(JSON.stringify({ name: "A" })));
  assert.equal(plain.kind, "data-json");
  assert.equal(plain.fields.name, "A");
  assert.deepEqual(parseRegistration("https://agent.invalid/reg.json"), { kind: "uri", fields: null });
  assert.deepEqual(parseRegistration("ipfs://bafy"), { kind: "uri", fields: null });
  assert.deepEqual(parseRegistration(""), { kind: "empty", fields: null });
  assert.deepEqual(parseRegistration(null), { kind: "empty", fields: null });
  assert.deepEqual(parseRegistration("data:application/json;base64,!!!"), { kind: "unparsable", fields: null });
  assert.deepEqual(parseRegistration("data:application/json,[1,2]"), { kind: "unparsable", fields: null });
  assert.deepEqual(parseRegistration("data:text/plain,hi"), { kind: "unparsable", fields: null });
});

test("agentWallet：getMetadata 返回 20 个裸字节才算地址，别的长度一律当没设置", () => {
  assert.equal(walletFromMetadata("0x" + "aa".repeat(20)), getAddress("0x" + "aa".repeat(20)));
  assert.equal(walletFromMetadata("0x"), null);
  assert.equal(walletFromMetadata("0x" + "00".repeat(12) + "aa".repeat(20)), null, "abi 编码的 32 字节不猜");
  assert.equal(walletFromMetadata("0x" + "00".repeat(20)), null);
});

const REG = new Interface([
  "function ownerOf(uint256) view returns (address)",
  "function getMetadata(uint256,string) view returns (bytes)",
  "function tokenURI(uint256) view returns (string)",
]);

/** 假的 ERC-8004 注册表：ids 里有的 id 才存在，其余 ownerOf revert（与主网实现一致）。 */
function fakeRegistry(ids, { failNetwork = false } = {}) {
  const calls = [];
  return {
    calls,
    async ethCall(to, data) {
      calls.push(data.slice(0, 10));
      if (failNetwork) throw new Error("ECONNRESET");
      const d = REG.parseTransaction({ data });
      const id = Number(d.args[0]);
      const row = ids[id];
      if (!row) throw new RpcError(3, "execution reverted: ERC721NonexistentToken", "eth_call");
      if (d.name === "ownerOf") return REG.encodeFunctionResult("ownerOf", [row.holder]);
      if (d.name === "getMetadata") return REG.encodeFunctionResult("getMetadata", [row.wallet ?? "0x"]);
      return REG.encodeFunctionResult("tokenURI", [row.uri ?? ""]);
    },
  };
}

test("readIdentity：存在的身份读出 holder / agentWallet / tokenURI；不存在的 id 是 exists=false 而不是报错", async () => {
  const rpc = fakeRegistry({ 7: { holder: OWNER, wallet: ADDR.agentWallet, uri: "https://x.invalid" } });
  const a = await readIdentity(rpc, ADDR.IdentityRegistry, 7);
  assert.deepEqual(a, { exists: true, holder: OWNER, agentWallet: ADDR.agentWallet, tokenURI: "https://x.invalid", tokenURIValidUtf8: true });
  const b = await readIdentity(rpc, ADDR.IdentityRegistry, 8);
  assert.deepEqual(b, { exists: false, holder: null, agentWallet: null, tokenURI: null, tokenURIValidUtf8: true });
});

test("refreshIdentities：只读锁过桥的 id，一轮最多 max 个，读过的在 staleSec 内不重读；网络错误记下来、不写猜测值", async () => {
  const { db } = tempDb();
  resetWarnings();
  const ingest = (logs) => ingestLogs(db, { chain: "bsc", logs, cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS });
  ingest([
    ...mkLock({ depositId: 0, agentId: 7, from: ADDR.agentWallet, amount: 1n, blockNumber: 10 }),
    ...mkLock({ depositId: 1, agentId: 8, from: ADDR.controller, amount: 1n, blockNumber: 11 }),
    ...mkLock({ depositId: 2, agentId: 9, from: ADDR.validator, amount: 1n, blockNumber: 12 }),
  ]);
  const long = "data:application/json," + encodeURIComponent(JSON.stringify({ name: "L", description: "y".repeat(TOKEN_URI_MAX) }));
  const rpc = fakeRegistry({ 7: { holder: OWNER, wallet: ADDR.agentWallet, uri: long }, 9: { holder: ADDR.validator } });
  let r = await refreshIdentities(db, rpc, { registry: ADDR.IdentityRegistry, now: TS, max: 2, staleSec: 3600 });
  assert.deepEqual(r, { read: 2, failed: 0 });
  r = await refreshIdentities(db, rpc, { registry: ADDR.IdentityRegistry, now: TS + 1, max: 2, staleSec: 3600 });
  assert.deepEqual(r, { read: 1, failed: 0 }, "第二轮只剩一个没读过的");
  r = await refreshIdentities(db, rpc, { registry: ADDR.IdentityRegistry, now: TS + 2, max: 10, staleSec: 3600 });
  assert.deepEqual(r, { read: 0, failed: 0 }, "都在有效期内，不重读");

  const i7 = identityOf(db, 7);
  assert.equal(i7.exists, true);
  assert.equal(i7.holder, OWNER);
  assert.equal(i7.registration.kind, "data-json");
  assert.equal(i7.registration.name, "L", "先解析、后截断");
  assert.equal(i7.registration.uriTruncated, true);
  assert.equal(identityOf(db, 8).exists, false, "ownerOf revert = 注册表里没有这个 id");
  assert.equal(identityOf(db, 9).agentWallet, null);

  // 过期之后网络断了：记 attempts / last_error，旧值不被覆盖，告警留下
  const bad = fakeRegistry({}, { failNetwork: true });
  r = await refreshIdentities(db, bad, { registry: ADDR.IdentityRegistry, now: TS + 7200, max: 10, staleSec: 3600 });
  assert.deepEqual(r, { read: 0, failed: 1 });
  const row = db.prepare("SELECT * FROM agent_identity WHERE agent_id = 7").get();
  assert.equal(Number(row.attempts), 1);
  assert.match(row.last_error, /ECONNRESET/);
  assert.equal(row.holder, OWNER, "读失败不许把旧读数抹掉");
  assert.ok(listWarnings().includes("identity_read_failed"));
  resetWarnings();
});

// ===================== 快照：三个阶段 =====================

const IMPL_WORD = "0x" + "0".repeat(24) + IMPL.slice(2).toLowerCase();

/**
 * 假 BSC：code / eth_call / storage / balance 都按地址配置；没配置的 eth_call 一律按合约 revert 处理。
 * 桥地址的 EIP-1967 实现槽默认指向 IMPL（它是个代理，和主网部署一致）；要模拟「填成了实现合约」就显式传一个全 0 的槽。
 */
function fakeBsc({ code = {}, calls = {}, storage: storageIn = {}, balances = {}, block = 50000000 } = {}) {
  const lc = (a) => String(a).toLowerCase();
  const storage = { [lc(ADDR.BacBridge)]: IMPL_WORD, ...storageIn };
  const seen = [];
  return {
    name: "fake-bsc",
    seen,
    async blockNumber() { return block; },
    async getCode(a) { return code[lc(a)] ?? "0x"; },
    async getStorageAt(a, slot) {
      assert.equal(slot, EIP1967_IMPLEMENTATION_SLOT);
      return storage[lc(a)] ?? "0x" + "0".repeat(64);
    },
    async getBalance(a) { return "0x" + BigInt(balances[lc(a)] ?? 0).toString(16); },
    async ethCall(to, data) {
      const key = `${lc(to)}:${data.slice(0, 10)}`;
      seen.push(key);
      const h = calls[key];
      if (h === undefined) throw new RpcError(3, "execution reverted", "eth_call");
      return typeof h === "function" ? h(data) : h;
    },
  };
}

/** 把「合约名.函数名 -> 返回值」翻成 fakeBsc 的 calls 表。 */
function callsOf(spec) {
  const out = {};
  for (const [addr, iface, fn, value] of spec) {
    const sel = iface.getFunction(fn).selector;
    out[`${addr.toLowerCase()}:${sel}`] = iface.encodeFunctionResult(fn, Array.isArray(value) ? value : [value]);
  }
  return out;
}

/**
 * 假层内链。l2 = null：L2Bridge 地址上没有代码（演练链的创世就是这样）；
 * l2 = { credited, exited, burned }：有代码，三个计数按给的值回答。
 */
const L2 = new Interface([
  "function totalCredited() view returns (uint256)",
  "function totalExited() view returns (uint256)",
  "function totalBurnedFloat() view returns (uint256)",
]);
function fakeLayer({ ts = TS, sink = 0n, validator = 0n, bridge = 0n, l2 = null } = {}) {
  const bal = {
    "0x0000000000000000000000000000000000000101": bridge,
    "0x000000000000000000000000000000000000dead": sink,
    [VALIDATOR.toLowerCase()]: validator,
  };
  return {
    async blockNumber() { return 19930; },
    async getBlockByNumber(n) {
      if (n === 0) return { hash: GENESIS_HASH, timestamp: "0x0", gasLimit: "0x1312d00" };
      return { hash: "0x" + "11".repeat(32), timestamp: "0x" + ts.toString(16), gasLimit: "0x1312d00", baseFeePerGas: "0x0" };
    },
    async netPeerCount() { return 0; },
    async getBalance(a) { return "0x" + BigInt(bal[String(a).toLowerCase()] ?? 0).toString(16); },
    async getCode(a) {
      return l2 && String(a).toLowerCase() === "0x0000000000000000000000000000000000000101" ? "0x6080" : "0x";
    },
    async ethCall(to, data) {
      if (!l2) return "0x";
      const f = L2.parseTransaction({ data });
      const v = { totalCredited: l2.credited, totalExited: l2.exited, totalBurnedFloat: l2.burned }[f.name];
      if (v === undefined) throw new RpcError(3, "execution reverted", "eth_call");
      return L2.encodeFunctionResult(f.name, [v]);
    },
    async call(m) {
      if (m === "qbft_getValidatorsByBlockNumber") return [VALIDATOR];
      throw new Error(`fake layer: ${m}`);
    },
  };
}

function genesisFile() {
  const dir = mkdtempSync(join(tmpdir(), "bac-gen-snap-"));
  const p = join(dir, "genesis.json");
  writeFileSync(p, JSON.stringify({ alloc: { [HARDHAT0.slice(2).toLowerCase()]: { balance: "0xd3c21bcecceda1000000" } } }));
  return p;
}

const CODE = "0x6080604052";

test("stageOf：三个阶段", () => {
  assert.equal(stageOf({ bridgeDeployed: false, routerDeployed: false, tokenHasCode: false }), "none");
  assert.equal(stageOf({ bridgeDeployed: true, routerDeployed: true, tokenHasCode: false }), "contracts_deployed");
  assert.equal(stageOf({ bridgeDeployed: true, routerDeployed: true, tokenHasCode: true }), "token_launched");
});

test("快照 · 阶段 none：地址配了但链上没有代码 —— 全是 null，不写 treasury，不编 0", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const cfg = { ...TEST_CFG, genesisPath: genesisFile(), layerEnode: ENODE };
  const snap = await refreshSnapshot(db, cfg, { layerRpc: fakeLayer(), bscRpc: fakeBsc(), now: TS });
  assert.equal(snap.stage, "none");
  assert.equal(snap.bsc.bridgeDeployed, false);
  assert.equal(snap.bsc.bridge, null);
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM treasury").get().c), 0);
  const { body } = route({ db, cfg, snapshot: snap }, "GET", "/api/health", {});
  assert.equal(body.stage, "none");
  assert.equal(body.bridge.deployed, false);
  assert.equal(body.bridge.owner, null);
  assert.equal(body.router.accountedQuote, null);
  assert.equal(body.token.hasCode, false);
  assert.equal(body.flap.marketAddressOk, null);
});

test("快照 · 阶段 contracts_deployed：合约自己的真状态照实返回，代币相关全是 null；演练链对账配平", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const cfg = { ...TEST_CFG, genesisPath: genesisFile(), layerEnode: ENODE };
  const A = cfg.addresses;
  const B = VIEWS.bridge;
  const R = VIEWS.router;
  const N = VIEWS.nodeFund;
  const bsc = fakeBsc({
    code: { [A.BacBridge.toLowerCase()]: CODE, [A.BacTaxRouter.toLowerCase()]: CODE, [A.BacNodeFund.toLowerCase()]: CODE },
    storage: { [A.BacBridge.toLowerCase()]: "0x" + "0".repeat(24) + IMPL.slice(2).toLowerCase() },
    calls: callsOf([
      [A.BacBridge, B, "owner", OWNER],
      [A.BacBridge, B, "pendingOwner", ZeroAddress],
      [A.BacBridge, B, "bacToken", ADDR.BacToken],
      [A.BacBridge, B, "identityRegistry", ADDR.IdentityRegistry],
      [A.BacBridge, B, "OWNER_POWER_NOTICE", NOTICE],
      [A.BacBridge, B, "totalCreditsIssued", 0n],
      [A.BacBridge, B, "totalCreditsExited", 0n],
      [A.BacBridge, B, "bnbBalance", 0n],
      [A.BacBridge, B, "bacAccounted", 0n],
      [A.BacBridge, B, "upgradeCount", 0n],
      [A.BacBridge, B, "lastUpgradeAt", 0n],
      [A.BacBridge, B, "emergencyCount", 0n],
      [A.BacBridge, B, "emergencyBnbWithdrawn", 0n],
      [A.BacBridge, B, "isHalted", false],
      [A.BacBridge, B, "isPaused", [false, 0n, 0n]],
      [A.BacTaxRouter, R, "accountedQuote", 0n],
      [A.BacTaxRouter, R, "unsplitRevenue", 0n],
      [A.BacTaxRouter, R, "stuckAmounts", [0n, 0n]],
      [A.BacTaxRouter, R, "lifetimeToBridge", 0n],
      [A.BacTaxRouter, R, "lifetimeToNodeFund", 0n],
      [A.BacTaxRouter, R, "totalRecognized", 0n],
      [A.BacTaxRouter, R, "solvency", [0n, 0n, 0n]],
      [A.BacTaxRouter, R, "bridge", A.BacBridge],
      [A.BacTaxRouter, R, "nodeFund", A.BacNodeFund],
      [A.BacTaxRouter, R, "BRIDGE_BPS", 5000n],
      [A.BacNodeFund, N, "owner", OWNER],
      [A.BacNodeFund, N, "balance", 0n],
    ]),
  });
  const sink = 2982000000000000n;
  const v = 62622000000000000n;
  const snap = await refreshSnapshot(db, cfg, { layerRpc: fakeLayer({ sink, validator: v }), bscRpc: bsc, now: TS });
  assert.equal(snap.stage, "contracts_deployed");
  // 发射前绝不去问代币、Portal、TaxProcessor，也不调 shortfall()（它对没代码的代币必然 revert）
  const shortfallSel = B.getFunction("shortfall").selector;
  assert.ok(!bsc.seen.some((k) => k.startsWith(A.FlapPortal.toLowerCase()) || k.startsWith(A.TaxProcessor.toLowerCase())));
  assert.ok(!bsc.seen.includes(`${A.BacBridge.toLowerCase()}:${shortfallSel}`));

  const ctx = { db, cfg, snapshot: snap };
  const { body } = route(ctx, "GET", "/api/health", {});
  assert.equal(body.stage, "contracts_deployed");
  assert.equal(body.bridge.owner, OWNER);
  assert.equal(body.bridge.implementation, IMPL);
  assert.equal(body.bridge.upgradeCount, 0);
  assert.equal(body.bridge.emergencyCount, 0);
  assert.equal(body.bridge.ownerPowerNotice, NOTICE);
  assert.deepEqual(
    { bnbShort: body.bridge.shortfall.bnbShort, bacShort: body.bridge.shortfall.bacShort },
    { bnbShort: "0", bacShort: "0" }
  );
  assert.match(body.bridge.shortfall.source, /尚未发射/);
  assert.equal(body.bridge.halted, false);
  assert.equal(body.bridge.paused, false);
  assert.equal(body.bridge.lockedBac, null, "没读到（假 RPC 没配这一项）就是 null");
  assert.equal(body.router.accountedQuote, "0");
  assert.deepEqual(body.router.stuck, { bridge: "0", nodeFund: "0" });
  assert.equal(body.router.bridgeBps, 5000);
  assert.equal(body.router.bridge, A.BacBridge);
  assert.equal(body.nodeFund.owner, OWNER);
  assert.equal(body.token.hasCode, false);
  assert.equal(body.token.price, null);
  assert.equal(body.flap.marketAddressOk, null);
  assert.equal(body.identityRegistry.source, "BacBridge.identityRegistry()");
  assert.equal(body.layer.enode, ENODE);
  assert.equal(body.layer.genesisHash, GENESIS_HASH);
  // 演练链对账：创世分配项公开列出，diff = 0
  assert.equal(body.reconcile.genesisAlloc, (10n ** 24n).toString());
  assert.deepEqual(body.reconcile.genesisAllocAccounts, [{ addr: HARDHAT0, balance: (10n ** 24n).toString() }]);
  assert.equal(body.reconcile.diff, "0");
  assert.equal(body.reconcile.ok, true);
  assert.deepEqual(body.warnings, []);
  assert.equal(body.ok, true);
  // 合约部署了：treasury 写一行，全是真的 0；marketAddress 没核对过
  const t = db.prepare("SELECT * FROM treasury").get();
  assert.equal(t.router_accounted, "0");
  assert.equal(Number(t.market_checked), 0);
  assert.equal(route(ctx, "GET", "/api/treasury", {}).body.items[0].marketAddressOk, null);
});

test("快照 · 阶段 token_launched：代币有代码，读 Portal 状态、自动发现 TaxProcessor 并核对 marketAddress == 路由", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const TP = getAddress("0x00000000000000000000000000000000000000a1");
  const cfg = {
    ...TEST_CFG,
    genesisPath: genesisFile(),
    layerEnode: ENODE,
    addresses: { ...TEST_CFG.addresses, TaxProcessor: null },
  };
  const A = cfg.addresses;
  const B = VIEWS.bridge;
  const st = [1, 0n, 0n, 123456789n, 6, 0n, 0n, 0n, 0n, ZeroAddress, false, ZeroHash, 300n, 300n, ZeroAddress, 5n * 10n ** 17n, 0, 0];
  const bsc = fakeBsc({
    code: {
      [A.BacBridge.toLowerCase()]: CODE, [A.BacTaxRouter.toLowerCase()]: CODE, [A.BacToken.toLowerCase()]: CODE,
    },
    balances: { [A.BacBridge.toLowerCase()]: 5n },
    calls: callsOf([
      [A.BacBridge, B, "owner", OWNER],
      [A.BacBridge, B, "bnbBalance", 10n],
      [A.BacBridge, B, "shortfall", [5n, 0n]],
      [A.BacToken, VIEWS.token, "taxProcessor", TP],
      [A.FlapPortal, VIEWS.portal, "getTokenV8Safe", [st]],
      [TP, VIEWS.taxProcessor, "marketAddress", A.BacTaxRouter],
    ]),
  });
  const snap = await refreshSnapshot(db, cfg, { layerRpc: fakeLayer(), bscRpc: bsc, now: TS });
  assert.equal(snap.stage, "token_launched");
  const ctx = { db, cfg, snapshot: snap };
  const { body } = route(ctx, "GET", "/api/health", {});
  assert.equal(body.token.hasCode, true);
  assert.equal(body.token.status, 1);
  assert.equal(body.token.statusName, "Tradable");
  assert.equal(body.token.price, "123456789");
  assert.equal(body.token.buyTaxBps, 300);
  assert.equal(body.token.taxProcessor, TP, "没配 BAC_ADDR_TAX_PROCESSOR 时从 token.taxProcessor() 发现");
  assert.equal(body.flap.marketAddressOk, true);
  assert.deepEqual(body.bridge.shortfall, { bnbShort: "5", bacShort: "0", source: "BacBridge.shortfall()" });
  const t = db.prepare("SELECT * FROM treasury").get();
  assert.equal(Number(t.market_checked), 1);
  assert.equal(Number(t.market_address_ok), 1);
  assert.equal(t.pool_balance, "10");
  assert.equal(t.bridge_bnb_held, "5");
});

test("快照：读不到创世文件时照实告警，genesisAlloc 记 0（旧行为），note 说明这是退路", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const cfg = { ...TEST_CFG, layerEnode: ENODE };
  const snap = await refreshSnapshot(db, cfg, { layerRpc: fakeLayer({ bridge: 10n ** 27n }), bscRpc: fakeBsc(), now: TS });
  assert.ok(listWarnings().includes("genesis_unreadable"));
  const { body } = route({ db, cfg, snapshot: snap }, "GET", "/api/health", {});
  assert.equal(body.reconcile.genesisAlloc, "0");
  assert.equal(body.reconcile.genesisSupply, (10n ** 27n).toString());
  assert.match(body.reconcile.note, /读不到创世文件/);
  resetWarnings();
});

test("快照：旧的金库 / 工厂 / 注册表环境变量还设着，/api/health 要喊出来", async () => {
  const { db } = tempDb();
  resetWarnings();
  const cfg = { ...TEST_CFG, layerEnode: ENODE, legacyEnvSet: ["BAC_ADDR_VAULT"] };
  await refreshSnapshot(db, cfg, { layerRpc: fakeLayer(), bscRpc: fakeBsc(), now: TS });
  assert.ok(listWarnings().includes("legacy_address_env_set"));
  resetWarnings();
});

// ===================== RPC：revert 不重试 =====================

async function withRpcServer(reply, fn) {
  let hits = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits += 1;
      const { id } = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, () => hits);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("eth_call 被 revert（code 3）：只打一次，不重试，抛出的错误认得出是 revert", async () => {
  await withRpcServer({ error: { code: 3, message: "execution reverted", data: "0x" } }, async (url, hits) => {
    const rpc = new Rpc(url, { name: "t", maxRetries: 5 });
    await assert.rejects(rpc.ethCall(ADDR.BacBridge, "0x12345678"), (e) => isRevertError(e));
    assert.equal(hits(), 1);
  });
});

test("-32000 + execution reverted：是 revert，不算限速", async () => {
  resetWarnings();
  await withRpcServer({ error: { code: -32000, message: "execution reverted: Not an agent" } }, async (url, hits) => {
    const rpc = new Rpc(url, { name: "t", maxRetries: 5 });
    await assert.rejects(rpc.ethCall(ADDR.BacBridge, "0x12345678"), (e) => isRevertError(e));
    assert.equal(hits(), 1);
    assert.equal(rpc.rateLimited24h(), 0);
  });
  assert.ok(!listWarnings().includes("rpc_rate_limited"));
});

// ===================== 配置与摄入范围 =====================

test("配置：BSC 主网的三个固定地址作默认值；旧环境变量被记下；enode 格式不对就是 null", () => {
  const c = loadConfig({ BAC_ADDR_VAULT: "0x6666666666666666666666666666666666666666", BAC_LAYER_ENODE: ENODE });
  assert.equal(c.addresses.BacToken, BSC_BAC_TOKEN);
  assert.equal(c.addresses.IdentityRegistry, BSC_IDENTITY_REGISTRY);
  assert.equal(c.addresses.FlapPortal, BSC_FLAP_PORTAL);
  assert.equal(c.addresses.BacTreasuryVault, undefined);
  assert.equal(c.addresses.AgentRegistry, undefined);
  assert.deepEqual(c.legacyEnvSet, ["BAC_ADDR_VAULT"]);
  assert.equal(c.layerEnode, ENODE);
  assert.equal(enodeOrNull("enode://abc@1.2.3.4:30303"), null);
  assert.equal(enodeOrNull(""), null);
  // 别的链不套 BSC 主网的默认值
  const t = loadConfig({ BSC_CHAIN_ID: "97" });
  assert.equal(t.addresses.BacToken, null);
  assert.equal(t.addresses.IdentityRegistry, null);
});

test("摄入范围：BSC 只对我们自己的合约跑 eth_getLogs；代币 / Portal / 注册表 / TaxProcessor 只读 view", async () => {
  const cfg = {
    ...TEST_CFG,
    bscStartBlock: 100, bscConfirmations: 0, bscLogRange: 1000, bscLogRangeMin: 100, bscLogRangeMax: 5000,
  };
  const addrs = bscLogAddresses(cfg);
  assert.deepEqual(addrs.sort(), [ADDR.BacBridge, ADDR.BacNodeFund, ADDR.BacTaxRouter, ADDR.ChainAnchor, ADDR.ValidatorStaking].sort());
  const book = addressBook(cfg);
  assert.equal(book[ADDR.BacToken.toLowerCase()], undefined);
  assert.equal(book[ADDR.IdentityRegistry.toLowerCase()], undefined);
  assert.equal(book[ADDR.BacTaxRouter.toLowerCase()], "BacTaxRouter");

  const { db } = tempDb();
  const filters = [];
  const rpc = {
    name: "fake",
    async blockNumber() { return 150; },
    async getLogs(f) { filters.push(f); return []; },
    async getBlockByNumber() { return { timestamp: "0x0" }; },
  };
  await bscTick(db, cfg, rpc);
  assert.ok(filters.length >= 1);
  for (const f of filters) {
    assert.ok(!f.address.includes(ADDR.BacToken));
    assert.ok(!f.address.includes(ADDR.IdentityRegistry));
    assert.ok(!f.address.includes(ADDR.FlapPortal));
    assert.ok(!f.address.includes(ADDR.TaxProcessor));
    assert.ok(f.address.includes(ADDR.BacTaxRouter));
  }
});

// ===================== 复核发现的问题（2026-09-23 验证轮）=====================

test("stage = 'none'：库里残留的一串 0 不许当测量值发出去；rate 没有读数时是 null，不是 \"0\"", () => {
  const { db } = tempDb();
  resetWarnings();
  // v1 在合约根本不存在时写的那种行（004 已经把旧行丢了，这里模拟「万一还有」）
  db.prepare(
    `INSERT INTO treasury (ts, bsc_block, router_balance, router_accounted, pool_balance, bridge_bnb_held, buyback_bac,
       owed_total, total_issued, total_exited, total_locked, emergency_bnb_withdrawn, emergency_bac_withdrawn, reward_balance)
     VALUES (?, ?, '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0')`
  ).run(TS, 123537069);
  const none = { db, cfg: TEST_CFG, snapshot: { stage: "none", bsc: { ok: true, bridgeDeployed: false, bridge: null }, bridge: null } };

  const sum = route(none, "GET", "/api/summary", {}).body;
  assert.equal(sum.stage, "none");
  for (const [k, v] of Object.entries(sum.treasury)) assert.equal(v, null, `summary.treasury.${k}`);
  for (const [k, v] of Object.entries(sum.bridge)) assert.equal(v, null, `summary.bridge.${k}`);
  assert.equal(sum.validators.rewardBalance, null);

  const rate = route(none, "GET", "/api/rate", {}).body;
  assert.deepEqual(
    [rate.bacPerCredit, rate.source, rate.buybackBac, rate.owedTotal, rate.creditsOutstanding, rate.lastPot],
    [null, null, null, null, null, null]
  );
  assert.deepEqual(route(none, "GET", "/api/treasury", {}).body.items, []);
  assert.equal(route(none, "GET", "/api/validators", {}).body.rewardBalance, null);

  // 合约部署了但既没有链上 currentRate()、也没有任何读数：同样是 null
  const empty = { db: tempDb().db, cfg: TEST_CFG, snapshot: { stage: "contracts_deployed" } };
  assert.equal(route(empty, "GET", "/api/rate", {}).body.bacPerCredit, null);
  // 本轮快照读到了桥的四个数：按合约的公式现算（outstanding = 0 时合约返回 0，这里也是 0 —— 那是真的）
  const live = {
    db: tempDb().db,
    cfg: TEST_CFG,
    snapshot: {
      stage: "contracts_deployed",
      bsc: { bridge: { buybackBac: "0", owedTotal: "0", totalCreditsIssued: "0", totalCreditsExited: "0", lastPot: "0" } },
    },
  };
  const lr = route(live, "GET", "/api/rate", {}).body;
  assert.equal(lr.bacPerCredit, "0");
  assert.match(lr.source, /本轮快照/);
  assert.equal(lr.creditsOutstanding, "0");
  // 配了部署块（BAC_BSC_START_BLOCK）时，比它早的行一律不认
  const after = { db, cfg: { ...TEST_CFG, bscStartBlock: 123600000 }, snapshot: { stage: "contracts_deployed" } };
  assert.deepEqual(route(after, "GET", "/api/treasury", {}).body.items, []);
  assert.equal(route(after, "GET", "/api/summary", {}).body.treasury.routerBalance, null);
});

test("treasury：某一轮没读到的 view 写 NULL、API 给 null，不写 \"0\"", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const cfg = { ...TEST_CFG, genesisPath: genesisFile(), layerEnode: ENODE };
  const A = cfg.addresses;
  // 只部署了桥，而且只配了 owner 与 bnbBalance 两个 view：其余全部 revert
  const bsc = fakeBsc({
    code: { [A.BacBridge.toLowerCase()]: CODE },
    calls: callsOf([
      [A.BacBridge, VIEWS.bridge, "owner", OWNER],
      [A.BacBridge, VIEWS.bridge, "bnbBalance", 0n],
    ]),
  });
  const snap = await refreshSnapshot(db, cfg, { layerRpc: fakeLayer(), bscRpc: bsc, now: TS });
  const item = route({ db, cfg, snapshot: snap }, "GET", "/api/treasury", {}).body.items[0];
  assert.equal(item.poolBalance, "0", "真读到的 0 照样是 \"0\"");
  assert.equal(item.bridgeBnbHeld, "0");
  assert.equal(item.routerBalance, null, "路由没部署");
  assert.equal(item.buybackBac, null, "view revert 了");
  assert.equal(item.totalLocked, null);
  assert.equal(item.marketAddressOk, null);
  // 桥没有 bacAccounted()：BAC 缺口是 null，不是 0
  assert.equal(snap.bsc.bridge.shortfall.bacShort, null);
  assert.equal(snap.bsc.bridge.shortfall.bnbShort, "0");
});

test("shortfall：代币已发射但 shortfall() 调不通 —— 读 BAC.balanceOf(bridge) 按合约公式重算；也读不到就是 null，绝不拿账面冒充缺口", async () => {
  const A = TEST_CFG.addresses;
  const B = VIEWS.bridge;
  const base = (extra) =>
    fakeBsc({
      code: { [A.BacBridge.toLowerCase()]: CODE, [A.BacToken.toLowerCase()]: CODE },
      balances: { [A.BacBridge.toLowerCase()]: 5n },
      calls: callsOf([
        [A.BacBridge, B, "owner", OWNER],
        [A.BacBridge, B, "bnbBalance", 10n],
        [A.BacBridge, B, "bacAccounted", 10n ** 21n],
        ...extra,
      ]),
    });
  const run = async (bsc) => {
    const { db } = tempDb();
    resetWarnings();
    resetGenesisCache();
    const cfg = { ...TEST_CFG, genesisPath: genesisFile(), layerEnode: ENODE };
    return (await refreshSnapshot(db, cfg, { layerRpc: fakeLayer(), bscRpc: bsc, now: TS })).bsc.bridge.shortfall;
  };
  // 桥里实际有 999 BAC，账面 1000：缺 1 BAC
  const withBal = await run(base([[A.BacToken, VIEWS.token, "balanceOf", 999n * 10n ** 18n]]));
  assert.equal(withBal.bnbShort, "5");
  assert.equal(withBal.bacShort, (10n ** 18n).toString());
  assert.match(withBal.source, /balanceOf/);
  // 余额 ≥ 账面：没有缺口
  const full = await run(base([[A.BacToken, VIEWS.token, "balanceOf", 2n * 10n ** 21n]]));
  assert.equal(full.bacShort, "0");
  // balanceOf 也读不到：未知，不是「全丢了」
  const unknown = await run(base([]));
  assert.equal(unknown.bacShort, null);
  assert.equal(unknown.bnbShort, "5");
  assert.match(unknown.source, /未知/);
});

test("ERC-8004：tokenURI 里塞非法 UTF-8 的身份不许卡住别的身份 —— 记成 unparsable，是最终答案", async () => {
  const { db } = tempDb();
  resetWarnings();
  ingestLogs(db, {
    chain: "bsc",
    logs: [
      ...mkLock({ depositId: 0, agentId: 7, from: ADDR.agentWallet, amount: 1n, blockNumber: 10 }),
      ...mkLock({ depositId: 1, agentId: 8, from: ADDR.controller, amount: 1n, blockNumber: 11 }),
      ...mkLock({ depositId: 2, agentId: 9, from: ADDR.validator, amount: 1n, blockNumber: 12 }),
    ],
    cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS,
  });
  const asBytes = new Interface(["function tokenURI(uint256) view returns (bytes)"]);
  const rpc = {
    async ethCall(to, data) {
      const d = REG.parseTransaction({ data });
      const id = Number(d.args[0]);
      if (d.name === "ownerOf") return REG.encodeFunctionResult("ownerOf", [OWNER]);
      if (d.name === "getMetadata") return REG.encodeFunctionResult("getMetadata", ["0x"]);
      // id 7 的注册文件是两个非法 UTF-8 字节（Solidity 的 string 里可以塞任意字节）
      if (id === 7) return asBytes.encodeFunctionResult("tokenURI", ["0xfffe"]);
      return REG.encodeFunctionResult("tokenURI", [`https://ok.invalid/${id}`]);
    },
  };
  const r = await refreshIdentities(db, rpc, { registry: ADDR.IdentityRegistry, now: TS, max: 10, staleSec: 3600 });
  assert.deepEqual(r, { read: 3, failed: 0 });
  const i7 = identityOf(db, 7);
  assert.equal(i7.read, true);
  assert.equal(i7.exists, true);
  assert.equal(i7.registration.kind, "unparsable");
  assert.equal(i7.registration.uri, null);
  assert.equal(identityOf(db, 8).registration.uri, "https://ok.invalid/8");
  assert.equal(identityOf(db, 9).registration.uri, "https://ok.invalid/9");
  assert.ok(!listWarnings().includes("identity_read_failed"));
  // 下一轮不会再去读它（checked_at 已经写了）
  assert.deepEqual(await refreshIdentities(db, rpc, { registry: ADDR.IdentityRegistry, now: TS + 1, max: 10, staleSec: 3600 }), { read: 0, failed: 0 });
});

test("ERC-8004：一个身份的返回值解不开只记在它自己身上，这一轮接着读别的；下一轮它排在最后", async () => {
  const { db } = tempDb();
  resetWarnings();
  ingestLogs(db, {
    chain: "bsc",
    logs: [
      ...mkLock({ depositId: 0, agentId: 7, from: ADDR.agentWallet, amount: 1n, blockNumber: 10 }),
      ...mkLock({ depositId: 1, agentId: 8, from: ADDR.controller, amount: 1n, blockNumber: 11 }),
      ...mkLock({ depositId: 2, agentId: 9, from: ADDR.validator, amount: 1n, blockNumber: 12 }),
    ],
    cfg: TEST_CFG, addressBook: TEST_BOOK, tsOf: () => TS,
  });
  const order = [];
  const rpc = {
    async ethCall(to, data) {
      const d = REG.parseTransaction({ data });
      const id = Number(d.args[0]);
      if (d.name === "ownerOf") {
        order.push(id);
        if (id === 7) return "0x12"; // 解不开的返回值
        return REG.encodeFunctionResult("ownerOf", [OWNER]);
      }
      if (d.name === "getMetadata") return REG.encodeFunctionResult("getMetadata", ["0x"]);
      return REG.encodeFunctionResult("tokenURI", [""]);
    },
  };
  let r = await refreshIdentities(db, rpc, { registry: ADDR.IdentityRegistry, now: TS, max: 10, staleSec: 3600 });
  assert.deepEqual(r, { read: 2, failed: 1 }, "8 和 9 在同一轮里照样读到");
  assert.equal(identityOf(db, 8).read, true);
  assert.equal(identityOf(db, 9).read, true);
  assert.equal(identityOf(db, 7).read, false);
  assert.equal(Number(db.prepare("SELECT attempts FROM agent_identity WHERE agent_id = 7").get().attempts), 1);
  assert.ok(listWarnings().includes("identity_read_failed"));
  // 都过期之后，一轮只读一个：先读从没失败过的（8），失败过的 7 排最后
  order.length = 0;
  r = await refreshIdentities(db, rpc, { registry: ADDR.IdentityRegistry, now: TS + 7200, max: 1, staleSec: 3600 });
  assert.deepEqual(order, [8]);
  resetWarnings();
});

test("公共节点不给老区块的日志（-32602 Archive requests…）：不当限速、不砍分片、不重试，打 bsc_log_history_unavailable", async () => {
  resetWarnings();
  const calls = [];
  const rpc = {
    name: "bsc",
    async getLogs(f) {
      calls.push(f);
      throw new RpcError(-32602, "Archive requests require a personal token, get one at https://publicnode.com", "eth_getLogs");
    },
  };
  await assert.rejects(
    getLogsChunked(rpc, { address: ["0x1"], from: 0, to: 9999, range: 3000, onChunk: async () => {} }),
    (e) => isHistoryUnavailableError(e)
  );
  assert.equal(calls.length, 1, "砍分片没用，不许在同一段上转圈");
  assert.ok(listWarnings().includes("bsc_log_history_unavailable"));
  assert.ok(!listWarnings().includes("rpc_rate_limited"), "这不是限速");
  assert.equal(isHistoryUnavailableError(new RpcError(-32005, "limit exceeded", "eth_getLogs")), false);
  assert.equal(isHistoryUnavailableError(new RpcError(3, "execution reverted", "eth_call")), false);
  resetWarnings();
});

test("-32602 Archive：Rpc 只打一次，不重试、不记限速", async () => {
  resetWarnings();
  await withRpcServer({ error: { code: -32602, message: "Archive requests require a personal token" } }, async (url, hits) => {
    const rpc = new Rpc(url, { name: "t", maxRetries: 5 });
    await assert.rejects(rpc.getLogs({ fromBlock: "0x0", toBlock: "0x1" }), (e) => isHistoryUnavailableError(e));
    assert.equal(hits(), 1);
    assert.equal(rpc.rateLimited24h(), 0);
  });
  assert.ok(!listWarnings().includes("rpc_rate_limited"));
});

test("配置了 BSC 合约地址但 BAC_BSC_START_BLOCK = 0：拒绝从第 0 块开始扫，打 bsc_start_block_unset", async () => {
  resetWarnings();
  const { db } = tempDb();
  const rpc = {
    name: "fake",
    async blockNumber() { throw new Error("不该走到这里"); },
    async getLogs() { throw new Error("不该走到这里"); },
  };
  const cfg = { ...TEST_CFG, bscStartBlock: 0, bscConfirmations: 0, bscLogRange: 1000, bscLogRangeMin: 100, bscLogRangeMax: 5000 };
  assert.equal(await bscTick(db, cfg, rpc), null);
  assert.ok(listWarnings().includes("bsc_start_block_unset"));
  resetWarnings();
});

test("/api/agents?sort=locked：按数值排，不在 INT64_MAX（约 9.22 BAC）处饱和", () => {
  const { db } = tempDb();
  const ins = db.prepare(
    "INSERT INTO agents (agent_id, controller, wallet, agent_uri, endpoint_hash, model_fp, status, registered_at, credited) VALUES (?, ?, ?, '', '', '', 2, 1, ?)"
  );
  const w = (i) => getAddress("0x" + String(i).padStart(40, "0"));
  ins.run(4, w(4), w(4), "10000000000000000000"); // 10 BAC
  ins.run(2, w(2), w(2), "500000000000000000000"); // 500 BAC
  ins.run(3, w(3), w(3), "9000000000000000000"); // 9 BAC
  ins.run(1, w(1), w(1), "1000000000000000000000000"); // 1,000,000 BAC
  const ctx = { db, cfg: TEST_CFG, snapshot: {} };
  for (const sort of ["locked", "credited"]) {
    assert.deepEqual(route(ctx, "GET", "/api/agents", { sort }).body.items.map((i) => i.agentId), [1, 2, 4, 3]);
  }
});

test("接线核对：注册表 / #29a 那句话 / bacToken / 路由去向，读到的不一致就进 warnings", () => {
  resetWarnings();
  const good = {
    bridgeDeployed: true,
    routerDeployed: true,
    bridge: { identityRegistry: ADDR.IdentityRegistry, ownerPowerNotice: NOTICE, bacToken: ADDR.BacToken },
    router: { bacToken: ADDR.BacToken, bridge: ADDR.BacBridge, nodeFund: ADDR.BacNodeFund },
  };
  assert.deepEqual(checkWiring(TEST_CFG, good), []);
  const LOOKALIKE = getAddress("0xfa09000000000000000000000000000000000001");
  const bad = {
    ...good,
    bridge: { identityRegistry: LOOKALIKE, ownerPowerNotice: "桥池只用于 agent 退出兑付。", bacToken: ADDR.someContract },
    router: { bacToken: ADDR.BacToken, bridge: ADDR.someContract, nodeFund: ADDR.BacNodeFund },
  };
  assert.deepEqual(checkWiring(TEST_CFG, bad).sort(), [...WIRING_WARNINGS].sort());
  for (const k of WIRING_WARNINGS) assert.ok(listWarnings().includes(k), k);
  // OWNER_POWER_NOTICE() 读不到、但 description() 里逐字包含那句话：算对；核对通过后告警清掉
  assert.deepEqual(checkWiring(TEST_CFG, { ...good, bridge: { ...good.bridge, ownerPowerNotice: null, description: NOTICE + "其余说明" } }), []);
  assert.deepEqual(listWarnings().filter((k) => WIRING_WARNINGS.includes(k)), []);
  // 两个都读不到：没法核对 #29a，也算不一致
  assert.deepEqual(checkWiring(TEST_CFG, { ...good, bridge: { ...good.bridge, ownerPowerNotice: null } }), ["owner_notice_mismatch"]);
  // 没部署的合约不核
  assert.deepEqual(checkWiring(TEST_CFG, { bridgeDeployed: false, routerDeployed: false, bridge: null, router: null }), []);
  resetWarnings();
});

test("接线核对进 /api/health：桥读的注册表不是官方那个 → warnings 里有、ok = false", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const cfg = { ...TEST_CFG, genesisPath: genesisFile(), layerEnode: ENODE };
  const A = cfg.addresses;
  const LOOKALIKE = getAddress("0xfa09000000000000000000000000000000000001");
  const bsc = fakeBsc({
    code: { [A.BacBridge.toLowerCase()]: CODE },
    calls: callsOf([
      [A.BacBridge, VIEWS.bridge, "identityRegistry", LOOKALIKE],
      [A.BacBridge, VIEWS.bridge, "OWNER_POWER_NOTICE", NOTICE],
      [A.BacBridge, VIEWS.bridge, "bacToken", ADDR.BacToken],
    ]),
  });
  const snap = await refreshSnapshot(db, cfg, { layerRpc: fakeLayer(), bscRpc: bsc, now: TS });
  const { body } = route({ db, cfg, snapshot: snap }, "GET", "/api/health", {});
  assert.ok(body.warnings.includes("identity_registry_mismatch"));
  assert.equal(body.identityRegistry.matchesExpected, false);
  assert.equal(body.ok, false);
  resetWarnings();
});

test("BSC_RPC_2：主 RPC 出网络错误 / 限速就换第二个并一直用它；revert 不换节点重问；eth_getLogs 永远只走主 RPC", async () => {
  await withRpcServer({ error: { code: -32005, message: "limit exceeded" } }, async (badUrl, badHits) => {
    await withRpcServer({ result: "0x10" }, async (okUrl, okHits) => {
      const f = new FailoverRpc([new Rpc(badUrl, { name: "a", maxRetries: 0 }), new Rpc(okUrl, { name: "b", maxRetries: 0 })], { name: "bsc" });
      assert.equal(await f.blockNumber(), 16);
      assert.equal(await f.blockNumber(), 16);
      assert.equal(badHits(), 1, "换过去之后这一轮不再回头试主 RPC");
      assert.equal(okHits(), 2);
      assert.equal(f.failovers, 1);
      // eth_getLogs：第二个（bsc-dataseed）不能当日志来源
      await assert.rejects(f.getLogs({ fromBlock: "0x0", toBlock: "0x1" }));
      assert.equal(okHits(), 2);
    });
  });
  await withRpcServer({ error: { code: 3, message: "execution reverted", data: "0x" } }, async (revUrl) => {
    await withRpcServer({ result: "0x01" }, async (okUrl, okHits) => {
      const f = new FailoverRpc([new Rpc(revUrl, { name: "a", maxRetries: 0 }), new Rpc(okUrl, { name: "b", maxRetries: 0 })], { name: "bsc" });
      await assert.rejects(f.ethCall(ADDR.BacBridge, "0x12345678"), (e) => isRevertError(e));
      assert.equal(okHits(), 0, "revert 是确定性答案");
    });
  });
});

// ===================== 复核发现的问题（2026-09-23 第二轮）=====================

const E18 = 10n ** 18n;

/**
 * 正式链形状的一个层内状态，按 L2Bridge 的真实语义推出余额：
 *   B(L2Bridge) = bridgeAlloc − Σ withdrawCredits + totalExited + totalBurnedFloat + 直接转入
 * 然后把 computeReconcile 需要的每一项都按快照的方式喂进去（layerCirculating 用同一个余额算）。
 */
function formalRec(st) {
  const S = 10n ** 27n;
  const float = 1000n * E18;
  const bridgeAlloc = S - float;
  const s0 = { issued: 0n, exitedB: 0n, credited: 0n, withdrawn: 0n, exitedL: 0n, burned: 0n, donated: 0n, outflow: 0n, ...st };
  const bal = bridgeAlloc - s0.withdrawn + s0.exitedL + s0.burned + s0.donated - s0.outflow;
  const sink = 7n;
  const splitter = 11n;
  const vals = [{ addr: VALIDATOR, balance: "13" }];
  return computeReconcile({
    bscBridgeDeployed: true,
    bscTotalIssued: s0.issued.toString(),
    bscTotalExited: s0.exitedB.toString(),
    layerCirculating: layerCirculating({
      genesisSupply: S, bridgeBalance: bal, sinkBalance: sink, splitterBalance: splitter, validatorBalances: vals,
    }),
    feeSinkBalance: sink.toString(),
    feeSplitterBalance: splitter.toString(),
    validatorBalances: vals,
    genesisSupply: S.toString(),
    genesisAlloc: float.toString(),
    bridgeAlloc: bridgeAlloc.toString(),
    l2Bridge: {
      hasCode: true, block: 1, balance: bal.toString(),
      totalCredited: s0.credited.toString(), totalExited: s0.exitedL.toString(), totalBurnedFloat: s0.burned.toString(),
    },
  });
}

test("对账：正常运行里的每一种过渡状态 rawDiff 都不是 0，但没有一项变负 —— diff = 0、ok = true，不告警", () => {
  const steps = [
    ["创世", {}, "0"],
    ["BSC 锁 10，中继还没 credit", { issued: 10n * E18 }, (10n * E18).toString()],
    ["中继 credit 了，agent 还没 withdrawCredits（PULL 模式）", { issued: 10n * E18, credited: 10n * E18 }, (10n * E18).toString()],
    ["提走了", { issued: 10n * E18, credited: 10n * E18, withdrawn: 10n * E18 }, "0"],
    ["层内 exit(4)，BSC 还没 claimExit", { issued: 10n * E18, credited: 10n * E18, withdrawn: 10n * E18, exitedL: 4n * E18 }, (4n * E18).toString()],
    ["运营方 burnFloat(1)", { issued: 10n * E18, credited: 10n * E18, withdrawn: 10n * E18, exitedL: 4n * E18, burned: E18 }, (5n * E18).toString()],
    ["有人往 L2Bridge 直接转 1 wei", { issued: 10n * E18, credited: 10n * E18, withdrawn: 10n * E18, exitedL: 4n * E18, burned: E18, donated: 1n }, (5n * E18 + 1n).toString()],
    ["BSC 上领了那 4", { issued: 10n * E18, exitedB: 4n * E18, credited: 10n * E18, withdrawn: 10n * E18, exitedL: 4n * E18, burned: E18, donated: 1n }, (E18 + 1n).toString()],
  ];
  for (const [name, st, raw] of steps) {
    const r = formalRec(st);
    assert.equal(r.rawDiff, raw, `${name}：rawDiff`);
    const sum = Object.values(r.terms).reduce((a, t) => a + BigInt(t.value), 0n);
    assert.equal(sum.toString(), r.rawDiff, `${name}：四项之和就是 rawDiff`);
    assert.equal(r.diff, "0", `${name}：diff`);
    assert.equal(r.ok, true, `${name}：ok`);
    assert.ok(Object.values(r.terms).every((t) => !t.alarm), name);
  }
  // 各项落在该落的地方
  const pending = formalRec({ issued: 10n * E18, credited: 10n * E18 });
  assert.equal(pending.terms.creditableAndDonations.value, (10n * E18).toString());
  const relay = formalRec({ issued: 10n * E18 });
  assert.equal(relay.terms.creditsPendingRelay.value, (10n * E18).toString());
  const unclaimed = formalRec({ exitedL: 4n * E18, credited: 4n * E18, issued: 4n * E18, withdrawn: 4n * E18 });
  assert.equal(unclaimed.terms.exitsPendingClaim.value, (4n * E18).toString());
});

test("对账：中继超发 / 超兑 / 来历不明的流出 —— 对应那一项变负，diff 是负数项之和，ok = false", () => {
  // 中继 credit 了 15，BSC 上只锁了 10：提没提走都一样抓得到
  for (const withdrawn of [0n, 15n * E18]) {
    const r = formalRec({ issued: 10n * E18, credited: 15n * E18, withdrawn });
    assert.equal(r.terms.creditsPendingRelay.value, (-5n * E18).toString());
    assert.equal(r.terms.creditsPendingRelay.alarm, true);
    assert.match(r.terms.creditsPendingRelay.ifNegative, /超发/);
    assert.equal(r.diff, (-5n * E18).toString());
    assert.equal(r.ok, false);
  }
  // 一笔等额的直接转入盖不住中继超发（两边都是计数）
  const masked = formalRec({ issued: 10n * E18, credited: 15n * E18, withdrawn: 15n * E18, donated: 5n * E18 });
  assert.equal(masked.ok, false);
  // BSC 兑付了 6，层内只销毁了 4
  const over = formalRec({ issued: 10n * E18, credited: 10n * E18, withdrawn: 10n * E18, exitedL: 4n * E18, exitedB: 6n * E18 });
  assert.equal(over.terms.exitsPendingClaim.alarm, true);
  assert.equal(over.diff, (-2n * E18).toString());
  // 有 3 个币离开了 L2Bridge，计数解释不了
  const leak = formalRec({ outflow: 3n * E18 });
  assert.equal(leak.terms.creditableAndDonations.alarm, true);
  assert.equal(leak.diff, (-3n * E18).toString());
  // 多项同时变负：diff 是它们的和
  const both = formalRec({ issued: 10n * E18, credited: 15n * E18, outflow: 20n * E18 });
  assert.equal(both.diff, (-5n * E18 - 5n * E18).toString());
});

test("对账：输入读不到时 diff / ok 是 null（不知道），不是 0 / true；负数项照样报", () => {
  const r = computeReconcile({ bscTotalIssued: "10", bscTotalExited: "0", l2Bridge: { hasCode: true, balance: "0" } });
  assert.equal(r.ok, null);
  assert.equal(r.diff, null);
  assert.deepEqual(r.missing, ["l2Bridge.totalCredited", "l2Bridge.totalExited", "l2Bridge.totalBurnedFloat"]);
  assert.equal(r.layerCirculating, null);
  assert.equal(r.rawDiff, null);
  const neg = computeReconcile({ bscTotalIssued: "10", bscTotalExited: "0", l2Bridge: { hasCode: true, totalCredited: "11" } });
  assert.equal(neg.ok, false);
  assert.equal(neg.diff, "-1");
});

function formalGenesisFile(float = 1000n * E18) {
  const dir = mkdtempSync(join(tmpdir(), "bac-gen-formal-"));
  const p = join(dir, "genesis.json");
  writeFileSync(p, JSON.stringify({
    alloc: {
      "0x0000000000000000000000000000000000000101": { balance: "0x" + (10n ** 27n - float).toString(16), code: "0x60" },
      [HARDHAT0.slice(2).toLowerCase()]: { balance: "0x" + float.toString(16) },
    },
  }));
  return p;
}

test("快照：演练链上任何人往 0x…0101 转 1 wei，health.ok 不再被弄成 false", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const cfg = { ...TEST_CFG, genesisPath: genesisFile(), layerEnode: ENODE };
  const snap = await refreshSnapshot(db, cfg, { layerRpc: fakeLayer({ bridge: 1n }), bscRpc: fakeBsc(), now: TS });
  const { body } = route({ db, cfg, snapshot: snap }, "GET", "/api/health", {});
  assert.equal(body.reconcile.rawDiff, "1", "旧公式在这里就是 1，永远 ok:false");
  assert.equal(body.reconcile.terms.creditableAndDonations.value, "1");
  assert.equal(body.reconcile.l2Bridge.hasCode, false);
  assert.equal(body.reconcile.l2Bridge.block, 19930, "余额与计数钉在同一个块上");
  assert.equal(body.reconcile.diff, "0");
  assert.equal(body.reconcile.ok, true);
  assert.deepEqual(body.warnings, []);
  assert.equal(body.ok, true);
});

test("快照：正式链上中继超发（L2Bridge.totalCredited > BacBridge.totalCreditsIssued）→ reconcile_overmint，health.ok = false", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const cfg = { ...TEST_CFG, genesisPath: formalGenesisFile(), layerEnode: ENODE };
  const A = cfg.addresses;
  const bsc = fakeBsc({
    code: { [A.BacBridge.toLowerCase()]: CODE },
    calls: callsOf([
      [A.BacBridge, VIEWS.bridge, "totalCreditsIssued", 10n * E18],
      [A.BacBridge, VIEWS.bridge, "totalCreditsExited", 0n],
    ]),
  });
  const bridgeAlloc = 10n ** 27n - 1000n * E18;
  // 中继 credit 了 15（其中 5 没有对应的 BSC 锁仓），agent 已全部提走
  const layer = fakeLayer({ bridge: bridgeAlloc - 15n * E18, l2: { credited: 15n * E18, exited: 0n, burned: 0n } });
  const snap = await refreshSnapshot(db, cfg, { layerRpc: layer, bscRpc: bsc, now: TS });
  const { body } = route({ db, cfg, snapshot: snap }, "GET", "/api/health", {});
  assert.equal(body.reconcile.l2Bridge.hasCode, true);
  assert.equal(body.reconcile.l2Bridge.totalCredited, (15n * E18).toString());
  assert.equal(body.reconcile.terms.creditsPendingRelay.value, (-5n * E18).toString());
  assert.equal(body.reconcile.diff, (-5n * E18).toString());
  assert.equal(body.reconcile.ok, false);
  assert.ok(body.warnings.includes("reconcile_overmint"));
  assert.ok(!body.warnings.includes("reconcile_unexplained_outflow"));
  assert.equal(body.ok, false);
  // 下一轮平了，告警清掉
  const fixed = fakeLayer({ bridge: bridgeAlloc - 10n * E18, l2: { credited: 10n * E18, exited: 0n, burned: 0n } });
  await refreshSnapshot(db, cfg, { layerRpc: fixed, bscRpc: bsc, now: TS + 30 });
  assert.ok(!listWarnings().includes("reconcile_overmint"));
  resetWarnings();
});

test("快照：这一轮读不到 BSC 时不拿 0 冒充发行量 —— 不会误报超发，只报 reconcile_incomplete", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const cfg = { ...TEST_CFG, genesisPath: formalGenesisFile(), layerEnode: ENODE };
  const down = { ...fakeBsc(), async blockNumber() { throw new Error("ECONNRESET"); } };
  const layer = fakeLayer({ bridge: 10n ** 27n - 1000n * E18 - 10n * E18, l2: { credited: 10n * E18, exited: 0n, burned: 0n } });
  const snap = await refreshSnapshot(db, cfg, { layerRpc: layer, bscRpc: down, now: TS });
  const { body } = route({ db, cfg, snapshot: snap }, "GET", "/api/health", {});
  assert.equal(body.reconcile.bscTotalIssued, null);
  assert.equal(body.reconcile.terms.creditsPendingRelay.value, null);
  assert.equal(body.reconcile.ok, null);
  assert.ok(body.warnings.includes("reconcile_incomplete"));
  assert.ok(!body.warnings.includes("reconcile_overmint"));
  assert.equal(body.ok, false);
  resetWarnings();
});

test("快照：BAC_ADDR_BRIDGE 填成了实现合约（EIP-1967 槽为空）→ bridge_not_proxy，读数一律不当测量值", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const cfg = { ...TEST_CFG, genesisPath: genesisFile(), layerEnode: ENODE };
  const A = cfg.addresses;
  const bsc = fakeBsc({
    code: { [A.BacBridge.toLowerCase()]: CODE },
    storage: { [A.BacBridge.toLowerCase()]: "0x" + "0".repeat(64) },
    // 实现合约自己的存储是空的：owner() 读出来是 0，计数是 0 —— 看起来像「部署了、状态是真的」
    calls: callsOf([
      [A.BacBridge, VIEWS.bridge, "owner", ZeroAddress],
      [A.BacBridge, VIEWS.bridge, "totalCreditsIssued", 0n],
      [A.BacBridge, VIEWS.bridge, "OWNER_POWER_NOTICE", NOTICE],
    ]),
  });
  const snap = await refreshSnapshot(db, cfg, { layerRpc: fakeLayer(), bscRpc: bsc, now: TS });
  const { body } = route({ db, cfg, snapshot: snap }, "GET", "/api/health", {});
  assert.ok(body.warnings.includes("bridge_not_proxy"));
  assert.ok(!body.warnings.includes("owner_notice_mismatch"), "不是代理就不拿它核接线，免得报一串误导的告警");
  assert.equal(body.ok, false);
  assert.equal(body.bridge.deployed, true);
  assert.equal(body.bridge.isProxy, false);
  assert.equal(body.bridge.owner, null);
  assert.equal(body.bridge.totalCreditsIssued, null);
  const ownerSel = VIEWS.bridge.getFunction("owner").selector;
  assert.ok(!bsc.seen.includes(`${A.BacBridge.toLowerCase()}:${ownerSel}`), "它的 view 一个都不读");
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM treasury").get().c), 0, "只有这个「桥」时不写 treasury 行");
  assert.equal(body.reconcile.bscTotalIssued, null);
  assert.match(body.reconcile.bscSource, /不是 ERC1967 代理/);
  // 改成代理之后告警清掉
  const fixed = fakeBsc({ code: { [A.BacBridge.toLowerCase()]: CODE } });
  const snap2 = await refreshSnapshot(db, cfg, { layerRpc: fakeLayer(), bscRpc: fixed, now: TS + 30 });
  assert.ok(!listWarnings().includes("bridge_not_proxy"));
  assert.equal(snap2.bsc.bridgeIsProxy, true);
  resetWarnings();
});

test("reconcile.genesisSource 是公开的 /api/genesis 地址 + 文件哈希，不是服务器上的文件路径（决策 #6）", async () => {
  const { db } = tempDb();
  resetWarnings();
  resetGenesisCache();
  const path = genesisFile();
  const cfg = { ...TEST_CFG, genesisPath: path, layerEnode: ENODE };
  const snap = await refreshSnapshot(db, cfg, { layerRpc: fakeLayer(), bscRpc: fakeBsc(), now: TS });
  const ctx = { db, cfg, snapshot: snap };
  const { body } = route(ctx, "GET", "/api/health", {});
  assert.equal(body.reconcile.genesisSource, `${cfg.apiBase}/api/genesis`);
  assert.equal(body.reconcile.genesisFileHash, keccak256(toUtf8Bytes(readFileSync(path, "utf8"))));
  // 与 /api/genesis 的响应头逐字相同：拿到的就是索引器用的那份
  assert.equal(route(ctx, "GET", "/api/genesis", {}).headers["X-Genesis-Hash"], body.reconcile.genesisFileHash);
  assert.ok(body.reconcile.howToCheck[0].startsWith(`curl -s ${cfg.apiBase}/api/genesis`));
  const dump = JSON.stringify(body);
  assert.ok(!dump.includes(path), "本机路径不许出现在返回体里");
  assert.ok(!dump.includes(path.replace(/\\/g, "\\\\")), "转义后的本机路径也不许出现");
  assert.ok(!/\/home\/ops/.test(dump));
});

test("BSC_RPC_2：主 RPC 用短预算（5 秒、重试 1 次），对象跨快照复用，换过去 10 分钟后再回头试主 RPC", async () => {
  resetReadRpcCache();
  const cfg = { bscRpc: "http://127.0.0.1:9/a", bscRpc2: "http://127.0.0.1:9/b" };
  const r = bscReadRpc(cfg);
  assert.ok(r instanceof FailoverRpc);
  assert.equal(bscReadRpc({ ...cfg }), r, "同一对 URL 复用同一个对象（rateLimited24h 才是真的 24 小时累计）");
  assert.equal(r.rpcs[0].timeoutMs, FAILOVER_PRIMARY_OPTS.timeoutMs);
  assert.equal(r.rpcs[0].maxRetries, FAILOVER_PRIMARY_OPTS.maxRetries);
  assert.ok(FAILOVER_PRIMARY_OPTS.timeoutMs <= 5000 && FAILOVER_PRIMARY_OPTS.maxRetries <= 1);
  assert.equal(r.rpcs[1].timeoutMs, FAILOVER_LAST_OPTS.timeoutMs);
  const single = bscReadRpc({ bscRpc: "http://127.0.0.1:9/c", bscRpc2: "http://127.0.0.1:9/c" });
  assert.ok(!(single instanceof FailoverRpc));
  assert.equal(single.maxRetries, 5, "只有一个 RPC 时它后面没人兜底，保留默认的耐心");
  resetReadRpcCache();

  let clock = 1_000_000;
  await withRpcServer({ error: { code: -32005, message: "limit exceeded" } }, async (badUrl, badHits) => {
    await withRpcServer({ result: "0x10" }, async (okUrl, okHits) => {
      const f = new FailoverRpc(
        [new Rpc(badUrl, { name: "a", maxRetries: 0 }), new Rpc(okUrl, { name: "b", maxRetries: 0 })],
        { name: "bsc", now: () => clock }
      );
      await f.blockNumber();
      clock += 9 * 60 * 1000;
      await f.blockNumber();
      assert.equal(badHits(), 1, "10 分钟之内一直走第二个");
      clock += 2 * 60 * 1000;
      await f.blockNumber();
      assert.equal(badHits(), 2, "过了 10 分钟回头试一次主 RPC");
      assert.equal(okHits(), 3);
      assert.equal(f.failovers, 2);
    });
  });
});
