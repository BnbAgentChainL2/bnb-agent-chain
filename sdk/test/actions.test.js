// 层内动作：announce 的本地门槛、CREATE2 地址预测、feed/watch 的 kind 过滤。

import test from "node:test";
import assert from "node:assert/strict";
import { concat, getAddress, keccak256, toUtf8Bytes, Wallet } from "ethers";
import { BacAgent, ExitStore, create2Address, ADDRESSES_MAINNET, LAYER_SYSTEM } from "../dist/index.js";
import { chainMock, TEST_KEYS } from "./helpers/mock.js";

function mkAgent() {
  return new BacAgent({
    agentId: 17n,
    controllerKey: TEST_KEYS.controller,
    layerKey: TEST_KEYS.layer,
    walletAddress: new Wallet(TEST_KEYS.layer).address,
    card: { name: "t", model: "m", endpoint: "https://e.invalid" },
    addresses: {
      ...ADDRESSES_MAINNET,
      registry: "0x1111111111111111111111111111111111111111",
      bridge: "0x2222222222222222222222222222222222222222",
    },
    apiBase: "https://api.invalid",
    bsc: chainMock(56, {}),
    layer: chainMock(56777, {}),
    store: new ExitStore("./.bac-test-actions.json"),
  });
}

test("announce: summary 超过 120 字节时本地就拦下来，不白花发布费", async () => {
  const agent = mkAgent();
  const long = "中".repeat(41);          // 41 × 3 = 123 字节
  assert.equal(toUtf8Bytes(long).length, 123);
  await assert.rejects(
    () => agent.announce("NOTE", { summary: long }),
    (e) => e.code === "summary_too_long" && /123 字节/.test(e.message),
  );
});

test("announce: 120 字节整好放行（按 UTF-8 字节算，不是字符数）", async () => {
  const agent = mkAgent();
  const ok = "中".repeat(40);            // 正好 120 字节
  assert.equal(toUtf8Bytes(ok).length, 120);
  // 这里不发交易（假链没配 AgentBook 的 eth_call），只要不是 summary_too_long 就算通过
  await assert.rejects(
    () => agent.announce("NOTE", { summary: ok }),
    (e) => e.code !== "summary_too_long",
  );
});

test("predictAddress 与 CREATE2 公式一致，且用的是规范部署器地址", () => {
  const agent = mkAgent();
  const artifact = { bytecode: "0x6080604052348015600f57600080fd5b50", abi: [] };
  const salt = "我的第一个合约";
  const saltHash = keccak256(toUtf8Bytes(salt));
  const expected = getAddress("0x" + keccak256(concat([
    "0xff", LAYER_SYSTEM.create2Deployer, saltHash, keccak256(artifact.bytecode),
  ])).slice(-40));
  assert.equal(agent.predictAddress(artifact, [], salt), expected);
  assert.equal(create2Address(LAYER_SYSTEM.create2Deployer, saltHash, keccak256(artifact.bytecode)), expected);
  // 32 字节的 salt 原样用，不再哈希一次
  const raw = "0x" + "ab".repeat(32);
  assert.equal(
    agent.predictAddress(artifact, [], raw),
    create2Address(LAYER_SYSTEM.create2Deployer, raw, keccak256(artifact.bytecode)),
  );
});

test("层内系统合约地址是创世写死的那三个", () => {
  assert.equal(LAYER_SYSTEM.l2Bridge, "0x0000000000000000000000000000000000000101");
  assert.equal(LAYER_SYSTEM.l2Gate, "0x0000000000000000000000000000000000000102");
  assert.equal(LAYER_SYSTEM.agentBook, "0x0000000000000000000000000000000000000103");
  assert.equal(LAYER_SYSTEM.feeSink, "0x000000000000000000000000000000000000dEaD");
  assert.equal(LAYER_SYSTEM.create2Deployer, "0x4e59b44847b379578588920cA78FbF26c0B4956C");
  assert.equal(LAYER_SYSTEM.multicall3, "0xcA11bde05977b3631167028862bE2a173976CA11");
});

test("没有层内私钥的实例：写操作报 no_layer_key，读操作照常", async () => {
  const agent = new BacAgent({
    agentId: 17n,
    controllerKey: TEST_KEYS.controller,
    walletAddress: new Wallet(TEST_KEYS.layer).address,
    card: { name: "t", model: "m", endpoint: "https://e.invalid" },
    addresses: { ...ADDRESSES_MAINNET, registry: "0x1111111111111111111111111111111111111111", bridge: "0x2222222222222222222222222222222222222222" },
    apiBase: "https://api.invalid",
    bsc: chainMock(56, {}),
    layer: chainMock(56777, { balances: { [new Wallet(TEST_KEYS.layer).address.toLowerCase()]: 5n } }),
    store: new ExitStore("./.bac-test-actions.json"),
  });
  await assert.rejects(() => agent.call("0x" + "11".repeat(20), [], "f", []), (e) => e.code === "no_layer_key");
  assert.equal(await agent.balance(), 5n);
});
