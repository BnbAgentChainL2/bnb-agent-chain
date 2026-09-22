// 退出流程的证明处理：exit() 落盘 → claimExit 取证明 → 用 anchorEpoch（不是 bornEpoch）上链。
// 全程假 provider + 假 fetch，不碰网络、不碰服务器。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { AbiCoder, Interface, Wallet } from "ethers";
import { BacAgent, ExitStore, exitTree, RateTooLowError } from "../dist/index.js";
import { BRIDGE_ABI, L2BRIDGE_ABI } from "../dist/abi.js";
import { chainMock, makeLog, stubFetch, TEST_KEYS } from "./helpers/mock.js";

const abi = AbiCoder.defaultAbiCoder();
const bridgeIface = new Interface(BRIDGE_ABI);
const l2Iface = new Interface(L2BRIDGE_ABI);

const BRIDGE = "0x2222222222222222222222222222222222222222";
const REGISTRY = "0x1111111111111111111111111111111111111111";
const ANCHOR = "0x3333333333333333333333333333333333333333";
const L2BRIDGE_ADDR = "0x0000000000000000000000000000000000000101";
const LAYER_CHAIN_ID = 56777;
const AGENT_ID = 17n;
const BORN_EPOCH = 20718;
const ANCHOR_EPOCH = 20719;      // 被 veto 的纪元重报：anchorEpoch != bornEpoch
const EXIT_ID = 41n;
const CREDITS = 20000n * 10n ** 18n;

const sel = (name) => bridgeIface.getFunction(name).selector;
const l2sel = (name) => l2Iface.getFunction(name).selector;

function addresses() {
  return {
    registry: REGISTRY, bridge: BRIDGE, anchor: ANCHOR,
    staking: "0x4444444444444444444444444444444444444444",
    nodeFund: "0x5555555555555555555555555555555555555555",
    vault: "0x6666666666666666666666666666666666666666",
    factory: "0x7777777777777777777777777777777777777777",
    bacToken: "0x8888888888888888888888888888888888888888",
    l2Bridge: L2BRIDGE_ADDR,
    l2Gate: "0x0000000000000000000000000000000000000102",
    agentBook: "0x0000000000000000000000000000000000000103",
  };
}

/** 一棵真的树，用来喂给假 API —— 证明必须是真的能验回根的那一条。 */
function realProof(to) {
  const leaves = [
    { exitId: 40n, agentId: 9n, to: "0x9999999999999999999999999999999999999999", credits: 5n * 10n ** 18n },
    { exitId: EXIT_ID, agentId: AGENT_ID, to, credits: CREDITS },
    { exitId: 42n, agentId: 3n, to: "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa", credits: 7n * 10n ** 18n },
  ];
  const root = exitTree.root(leaves, LAYER_CHAIN_ID, BRIDGE);
  const proof = exitTree.proof(leaves, EXIT_ID, LAYER_CHAIN_ID, BRIDGE);
  const leaf = exitTree.leafHash(leaves[1], LAYER_CHAIN_ID, BRIDGE);
  assert.ok(exitTree.verify(leaf, proof, root));
  return { root, proof, leaf };
}

function mkAgent({ statePath, bscCalls = {}, layerCalls = {}, layerLogs = () => [] }) {
  const controller = new Wallet(TEST_KEYS.controller).address;
  const bsc = chainMock(56, {
    calls: {
      [sel("exitClaimed")]: abi.encode(["bool"], [false]),
      [sel("owed")]: abi.encode(["uint256"], [0n]),
      [sel("pendingCollect")]: abi.encode(["uint256"], [0n]),
      [sel("currentRate")]: abi.encode(["uint256"], [10n ** 12n]),
      [sel("lastSettledEpoch")]: abi.encode(["uint64"], [20717n]),
      ...bscCalls,
    },
    logsFor: () => [],
  });
  const layer = chainMock(LAYER_CHAIN_ID, { calls: layerCalls, logsFor: layerLogs });
  const agent = new BacAgent({
    agentId: AGENT_ID,
    controllerKey: TEST_KEYS.controller,
    layerKey: TEST_KEYS.layer,
    walletAddress: new Wallet(TEST_KEYS.layer).address,
    card: { name: "t", model: "m", endpoint: "https://example.invalid/agent.json" },
    addresses: addresses(),
    apiBase: "https://api.invalid",
    bsc,
    layer,
    store: new ExitStore(statePath),
  });
  return { agent, bsc, layer, controller };
}

function tmpState() {
  const dir = mkdtempSync(pjoin(tmpdir(), "bac-sdk-"));
  const path = pjoin(dir, "state.json");
  if (process.env.BAC_DEBUG) console.error("[tmpState]", path);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("exit(): 兑付率为 0 时默认拒发，且不发任何交易（积分会当场销毁）", async () => {
  const st = tmpState();
  const f = stubFetch({ "/api/rate": { weiPerCredit: "0", poolBalance: "0", lastPot: "0" } });
  try {
    const { agent, layer } = mkAgent({ statePath: st.path });
    await assert.rejects(() => agent.exit(CREDITS), (err) => err instanceof RateTooLowError && err.code === "rate_too_low");
    assert.equal(layer.sentRaw.length, 0, "不许发交易");
  } finally {
    f.restore(); st.cleanup();
  }
});

test("exit(): 读不到 /api/rate 时停下来（宁可停，不可错），不猜", async () => {
  const st = tmpState();
  const f = stubFetch({});   // 所有路由 404
  try {
    const { agent, layer } = mkAgent({ statePath: st.path });
    await assert.rejects(() => agent.exit(CREDITS), (err) => err.code === "unknown_state");
    assert.equal(layer.sentRaw.length, 0);
  } finally {
    f.restore(); st.cleanup();
  }
});

test("exit(): 成功后把 {exitId, to, credits, bornEpoch} 落盘（唯一不允许丢的状态）", async () => {
  const st = tmpState();
  const to = new Wallet(TEST_KEYS.controller).address;
  const f = stubFetch({ "/api/rate": { weiPerCredit: "1000000000000", poolBalance: "10", lastPot: "1" } });
  try {
    const { agent, layer } = mkAgent({
      statePath: st.path,
      layerLogs: (tx) => tx.to?.toLowerCase() === L2BRIDGE_ADDR.toLowerCase()
        ? [makeLog(L2BRIDGE_ABI, L2BRIDGE_ADDR, "ExitBurned", [EXIT_ID, AGENT_ID, to, CREDITS, BigInt(BORN_EPOCH)])]
        : [],
    });
    const r = await agent.exit(CREDITS, to);
    assert.equal(r.exitId, EXIT_ID);
    assert.equal(r.bornEpoch, BORN_EPOCH);

    // 发出去的那笔交易：L2Bridge.exit(bscRecipient)，**不带 agentId**
    const sent = layer.sentRaw.at(-1);
    assert.equal(sent.to.toLowerCase(), L2BRIDGE_ADDR.toLowerCase());
    assert.equal(sent.value, CREDITS);
    const decoded = l2Iface.parseTransaction({ data: sent.data, value: sent.value });
    assert.equal(decoded.name, "exit");
    assert.equal(decoded.args.length, 1, "exit 只有一个参数：bscRecipient");
    assert.equal(decoded.args[0], to);

    const rec = new ExitStore(st.path).get(EXIT_ID);
    assert.equal(rec.bornEpoch, BORN_EPOCH);
    assert.equal(rec.credits, CREDITS.toString());
    assert.equal(rec.to, to);
    assert.equal(rec.claimedTx, null);
  } finally {
    f.restore(); st.cleanup();
  }
});

test("claimExit(): 用 API 返回的 anchorEpoch 上链，不是 bornEpoch", async () => {
  const st = tmpState();
  const to = new Wallet(TEST_KEYS.controller).address;
  const { root, proof, leaf } = realProof(to);
  const store = new ExitStore(st.path);
  store.put({
    exitId: EXIT_ID.toString(), to, credits: CREDITS.toString(), bornEpoch: BORN_EPOCH,
    layerTx: "0x" + "cd".repeat(32), createdAt: 1790000000, claimedTx: null,
  });

  const f = stubFetch({
    [`/api/epoch/${BORN_EPOCH}/proof/${EXIT_ID}`]: {
      schema: "bac/proof/2", exitId: EXIT_ID.toString(), agentId: AGENT_ID.toString(), to,
      credits: CREDITS.toString(), anchorEpoch: ANCHOR_EPOCH, bornEpoch: BORN_EPOCH,
      leaf, proof, exitRoot: root, bridge: BRIDGE, layerChainId: LAYER_CHAIN_ID,
    },
  });
  try {
    const { agent, bsc } = mkAgent({ statePath: st.path });
    const tx = await agent.claimExit(EXIT_ID);
    assert.match(tx, /^0x[0-9a-f]{64}$/);

    // 证明请求打到 bornEpoch 那个端点（API 自己解析重报），但交易里用的是 anchorEpoch
    assert.ok(f.seen.some((u) => u.includes(`/api/epoch/${BORN_EPOCH}/proof/${EXIT_ID}`)));
    const sent = bsc.sentRaw.at(-1);
    const call = bridgeIface.parseTransaction({ data: sent.data });
    assert.equal(call.name, "claimExit");
    assert.equal(Number(call.args.anchorEpoch), ANCHOR_EPOCH);
    assert.notEqual(Number(call.args.anchorEpoch), BORN_EPOCH);
    assert.equal(call.args.exitId, EXIT_ID);
    assert.equal(call.args.agentId, AGENT_ID);
    assert.equal(call.args.to, to);
    assert.equal(call.args.credits, CREDITS);
    assert.deepEqual([...call.args.proof], proof);

    // 证明必须是真的：用同一套算法验回锚点根
    assert.ok(exitTree.verify(leaf, [...call.args.proof], root));
    assert.equal(new ExitStore(st.path).get(EXIT_ID).claimedTx, tx);
  } finally {
    f.restore(); st.cleanup();
  }
});

test("claimExit(): 链上已领过就直接抛 exit_already_claimed，不重发交易", async () => {
  const st = tmpState();
  const to = new Wallet(TEST_KEYS.controller).address;
  new ExitStore(st.path).put({
    exitId: EXIT_ID.toString(), to, credits: CREDITS.toString(), bornEpoch: BORN_EPOCH,
    layerTx: "0x" + "cd".repeat(32), createdAt: 1790000000, claimedTx: null,
  });
  const f = stubFetch({});
  try {
    const { agent, bsc } = mkAgent({
      statePath: st.path,
      bscCalls: { [sel("exitClaimed")]: abi.encode(["bool"], [true]) },
    });
    await assert.rejects(() => agent.claimExit(EXIT_ID), (err) => err.code === "exit_already_claimed");
    assert.equal(bsc.sentRaw.length, 0);
  } finally {
    f.restore(); st.cleanup();
  }
});

test("claimExit(): 证明里的 layerChainId 不对就停下来，不拿它去发交易", async () => {
  const st = tmpState();
  const to = new Wallet(TEST_KEYS.controller).address;
  const { root, proof, leaf } = realProof(to);
  new ExitStore(st.path).put({
    exitId: EXIT_ID.toString(), to, credits: CREDITS.toString(), bornEpoch: BORN_EPOCH,
    layerTx: "0x" + "cd".repeat(32), createdAt: 1790000000, claimedTx: null,
  });
  const f = stubFetch({
    [`/api/epoch/${BORN_EPOCH}/proof/${EXIT_ID}`]: {
      exitId: EXIT_ID.toString(), agentId: AGENT_ID.toString(), to, credits: CREDITS.toString(),
      anchorEpoch: ANCHOR_EPOCH, bornEpoch: BORN_EPOCH, leaf, proof, exitRoot: root,
      bridge: BRIDGE, layerChainId: 56,     // ← 假的
    },
  });
  try {
    const { agent, bsc } = mkAgent({ statePath: st.path });
    await assert.rejects(() => agent.claimExit(EXIT_ID), (err) => err.code === "unknown_state");
    assert.equal(bsc.sentRaw.length, 0);
  } finally {
    f.restore(); st.cleanup();
  }
});

test("replayPendingExits(): 启动时重放；链上已领的补记，没领的重试", async () => {
  const st = tmpState();
  const to = new Wallet(TEST_KEYS.controller).address;
  const { root, proof, leaf } = realProof(to);
  const store = new ExitStore(st.path);
  store.put({ exitId: "40", to, credits: "5", bornEpoch: BORN_EPOCH, layerTx: "0x" + "ab".repeat(32), createdAt: 1, claimedTx: null });
  store.put({ exitId: EXIT_ID.toString(), to, credits: CREDITS.toString(), bornEpoch: BORN_EPOCH, layerTx: "0x" + "cd".repeat(32), createdAt: 1, claimedTx: null });

  const f = stubFetch({
    [`/api/epoch/${BORN_EPOCH}/proof/${EXIT_ID}`]: {
      exitId: EXIT_ID.toString(), agentId: AGENT_ID.toString(), to, credits: CREDITS.toString(),
      anchorEpoch: ANCHOR_EPOCH, bornEpoch: BORN_EPOCH, leaf, proof, exitRoot: root,
      bridge: BRIDGE, layerChainId: LAYER_CHAIN_ID,
    },
  });
  try {
    // exitId 40 在链上已领，41 没有
    const { agent } = mkAgent({
      statePath: st.path,
      bscCalls: {
        [sel("exitClaimed")]: (params, data) => {
          const [id] = abi.decode(["uint256"], "0x" + data.slice(10));
          return abi.encode(["bool"], [id === 40n]);
        },
      },
    });
    const out = await agent.replayPendingExits();
    const byId = Object.fromEntries(out.map((o) => [o.exitId.toString(), o.result]));
    assert.equal(byId["40"], "already");
    assert.equal(byId["41"], "claimed");
    assert.equal(new ExitStore(st.path).unclaimed().length, 0);
  } finally {
    f.restore(); st.cleanup();
  }
});

test("ExitStore 是原子的：写坏的文件不会让启动崩，只会当成空表", () => {
  const st = tmpState();
  try {
    const store = new ExitStore(st.path);
    assert.deepEqual(store.list(), []);
    store.put({ exitId: "1", to: "0x" + "11".repeat(20), credits: "1", bornEpoch: 1, layerTx: "0x", createdAt: 1 });
    assert.equal(new ExitStore(st.path).list().length, 1);
    store.put({ exitId: "1", to: "0x" + "11".repeat(20), credits: "2", bornEpoch: 1, layerTx: "0x", createdAt: 1 });
    assert.equal(new ExitStore(st.path).list().length, 1, "同 exitId 覆盖写，幂等");
  } finally {
    st.cleanup();
  }
});
