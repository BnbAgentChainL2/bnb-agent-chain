// 03 §5 列出的每一个导出都必须存在，且形状对得上。
// 这个文件是「接口契约」的可执行版本：改一个名字就必须在这里改一行。

import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import * as sdk from "../dist/index.js";
import { chainMock, TEST_KEYS } from "./helpers/mock.js";

test("§5.1 顶层常量与 loadAddresses", () => {
  assert.equal(sdk.LAYER_CHAIN_ID, 56777);
  assert.equal(sdk.BSC_CHAIN_ID, 56);
  assert.equal(typeof sdk.loadAddresses, "function");
  assert.equal(sdk.loadAddresses.length, 1);   // (cfg?)

  // ADDRESSES_MAINNET：11 个键，BSC 侧发射前全是 0x0，层内三个是创世固定地址
  const keys = ["registry", "bridge", "anchor", "staking", "nodeFund", "vault", "factory",
    "bacToken", "l2Bridge", "l2Gate", "agentBook"];
  assert.deepEqual(Object.keys(sdk.ADDRESSES_MAINNET).sort(), [...keys].sort());
  for (const k of ["registry", "bridge", "anchor", "staking", "nodeFund", "vault", "factory", "bacToken"]) {
    assert.match(sdk.ADDRESSES_MAINNET[k], /^0x0{40}$/, `${k} 发射前必须是 0x0`);
  }
  assert.equal(sdk.ADDRESSES_MAINNET.l2Bridge, "0x0000000000000000000000000000000000000101");
  assert.equal(sdk.ADDRESSES_MAINNET.l2Gate, "0x0000000000000000000000000000000000000102");
  assert.equal(sdk.ADDRESSES_MAINNET.agentBook, "0x0000000000000000000000000000000000000103");
});

test("§5.2 join 是函数，ENTRY_DEPOSIT 正好 0.02 BNB", () => {
  assert.equal(typeof sdk.join, "function");
  assert.equal(sdk.ENTRY_DEPOSIT, 20_000_000_000_000_000n);
});

test("§5.3 Agent 的每一个方法都在实例上，且参数个数对得上", () => {
  const agent = new sdk.BacAgent({
    agentId: 17n,
    controllerKey: TEST_KEYS.controller,
    layerKey: TEST_KEYS.layer,
    walletAddress: new Wallet(TEST_KEYS.layer).address,
    card: { name: "t", model: "claude-opus-5", endpoint: "https://example.invalid/a.json" },
    addresses: { ...sdk.ADDRESSES_MAINNET, registry: "0x1111111111111111111111111111111111111111", bridge: "0x2222222222222222222222222222222222222222" },
    apiBase: "https://api.invalid",
    bsc: chainMock(56, {}),
    layer: chainMock(56777, {}),
    store: new sdk.ExitStore("./.bac-test-state.json"),
  });

  // 只读属性
  assert.equal(agent.agentId, 17n);
  assert.equal(agent.controller, new Wallet(TEST_KEYS.controller).address);
  assert.equal(agent.wallet, new Wallet(TEST_KEYS.layer).address);
  assert.ok(agent.layer && agent.bsc);

  // Function.length 数的是「第一个带默认值的形参之前」的形参个数（`x?: T` 没有默认值，照数）。
  // 下面这张表是 03 §5.3 的签名逐条翻过来的，改签名就要改这里。
  const methods = {
    status: 0, setAgentURI: 1, rotateController: 1, card: 0, cardJson: 0,
    heartbeat: 0, keepAlive: 0, challengeIfSpotChecked: 0,
    lock: 1, waitCredited: 1, balance: 0,
    exit: 2,                       // (amount, bscRecipient?)，第三个 opts 有默认值
    exitStatus: 1, claimExit: 1,
    collect: 1,                    // (to?)
    quoteFor: 1, escapeClaimable: 0,
    escapeCollect: 1,              // (to?)
    deploy: 1,                     // (artifact, args = [], opts = {})
    predictAddress: 3, announce: 2,
    call: 5,                       // (address, abi, fn, args, value?)
    read: 4,
    watch: 0, agents: 0, contracts: 0,
    feed: 2,                       // (after?, limit?)
  };
  for (const [name, arity] of Object.entries(methods)) {
    assert.equal(typeof agent[name], "function", `Agent.${name} 必须存在`);
    assert.equal(agent[name].length, arity, `Agent.${name} 的必填参数个数应当是 ${arity}`);
  }

  // card() 返回拷贝，改它不影响内部
  const c = agent.card();
  c.name = "改掉";
  assert.equal(agent.card().name, "t");

  // cardJson() 是合法 JSON，且 registrations[] 回指 agentId 与注册合约
  const j = JSON.parse(agent.cardJson());
  assert.equal(j.registrations[0].agentId, "17");
  assert.match(j.registrations[0].agentRegistry, /^eip155:56:0x1111/);
  assert.equal(j.extensions["bnb-agent-chain"].layerChainId, 56777);
});

test("§5.3 ActionKind 的 11 个常量与合约的 keccak 一致", async () => {
  const { keccak256, toUtf8Bytes } = await import("ethers");
  assert.deepEqual([...sdk.ACTION_KINDS], [
    "JOIN", "DEPLOY", "PUBLISH", "SERVICE", "TRADE", "LIST",
    "POOL", "STRATEGY", "MESSAGE", "CLAIM", "NOTE",
  ]);
  for (const k of sdk.ACTION_KINDS) {
    assert.equal(sdk.kindHash(k), keccak256(toUtf8Bytes(k)));
    assert.equal(sdk.kindOfHash(sdk.kindHash(k)), k);
  }
  assert.equal(sdk.kindOfHash("0x" + "00".repeat(32)), null, "认不出来就返回 null，不猜成 NOTE");
  assert.throws(() => sdk.kindHash("NOPE"), /未知的 kind/);
});

test("§5.4 challenge / exitTree / anchorMath / api / reconcile 五个命名空间的成员", () => {
  for (const f of ["seed", "solve", "sign"]) {
    assert.equal(typeof sdk.challenge[f], "function", `challenge.${f}`);
  }
  assert.equal(sdk.challenge.seed.length, 4);
  assert.equal(sdk.challenge.sign.length, 5);   // 第 6 个 registry 是可选的（EIP-712 的 verifyingContract）
  assert.equal(sdk.challenge.solve.length, 1);  // target / opts 可选

  for (const f of ["leafHash", "root", "proof", "fromLogs"]) {
    assert.equal(typeof sdk.exitTree[f], "function", `exitTree.${f}`);
  }
  assert.equal(sdk.exitTree.leafHash.length, 3);
  assert.equal(sdk.exitTree.root.length, 3);
  assert.equal(sdk.exitTree.proof.length, 4);
  assert.equal(sdk.exitTree.fromLogs.length, 1);

  for (const f of ["l2BlockFor", "rangeFor"]) {
    assert.equal(typeof sdk.anchorMath[f], "function", `anchorMath.${f}`);
    assert.equal(sdk.anchorMath[f].length, 2);
  }

  for (const f of ["health", "summary", "rate", "feed", "proofFor"]) {
    assert.equal(typeof sdk.api[f], "function", `api.${f}`);
  }
  assert.equal(sdk.api.health.length, 1);   // (base?)
  assert.equal(sdk.api.feed.length, 0);     // (opts = {}, base?)
  assert.equal(sdk.api.proofFor.length, 3); // (epoch, exitId, base?)

  assert.equal(typeof sdk.reconcile.check, "function");
  assert.equal(sdk.reconcile.check.length, 1); // (cfg?)
});

test("错误类型都导出了，并且都是 BacError 的子类", () => {
  for (const name of ["BacError", "BacConfigError", "BacApiError", "BacUnknownStateError",
    "ChallengeTimeoutError", "RateTooLowError"]) {
    assert.equal(typeof sdk[name], "function", name);
  }
  const e = new sdk.RateTooLowError(1n, 0n);
  assert.ok(e instanceof sdk.BacError);
  assert.equal(e.code, "rate_too_low");
  assert.ok(e.action.length > 0, "每个错误都要有中文的下一步");
});

test("类型声明文件跟着构建产物一起出（tsc 能用）", async () => {
  const { existsSync } = await import("node:fs");
  for (const f of ["index.d.ts", "types.d.ts", "agent.d.ts", "challenge.d.ts", "exitTree.d.ts"]) {
    assert.ok(existsSync(new URL(`../dist/${f}`, import.meta.url)), `dist/${f} 必须存在`);
  }
});

test("examples/ 里的三个示例都能被 Node 解析（语法回归）", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = new URL("../examples/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length >= 3, "至少要有 20 行进场 + 部署公告 + 退出领取三个例子");
  for (const f of files) {
    execFileSync(process.execPath, ["--check", fileURLToPath(new URL(f, dir))]);
  }
});
