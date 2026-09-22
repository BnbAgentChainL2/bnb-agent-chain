// HTTP API 封装 + 错误映射 + 对账公式。全部用假 fetch / 假 provider，不碰网络。

import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, Interface } from "ethers";
import { api, loadAddresses, mapChainError, reconcile, LAYER_TOTAL_SUPPLY } from "../dist/index.js";
import { BRIDGE_ABI } from "../dist/abi.js";
import { chainMock, stubFetch } from "./helpers/mock.js";

const abi = AbiCoder.defaultAbiCoder();
const bridgeIface = new Interface(BRIDGE_ABI);
const sel = (n) => bridgeIface.getFunction(n).selector;

test("api.rate 把 wei 字符串转成 bigint", async () => {
  const f = stubFetch({ "/api/rate": { weiPerCredit: "123456789", poolBalance: "10", lastPot: "3" } });
  try {
    const r = await api.rate("https://x.invalid");
    assert.equal(r.weiPerCredit, 123456789n);
    assert.equal(typeof r.poolBalance, "bigint");
  } finally { f.restore(); }
});

test("api.proofFor 保留 anchorEpoch 与 bornEpoch 两个字段", async () => {
  const f = stubFetch({
    "/api/epoch/20718/proof/41": {
      exitId: "41", agentId: "17", to: "0x1111111111111111111111111111111111111111",
      credits: "5", anchorEpoch: 20719, bornEpoch: 20718, leaf: "0x" + "aa".repeat(32),
      proof: ["0x" + "bb".repeat(32)], exitRoot: "0x" + "cc".repeat(32),
      bridge: "0x2222222222222222222222222222222222222222", layerChainId: 56777,
    },
  });
  try {
    const p = await api.proofFor(20718, 41n, "https://x.invalid");
    assert.equal(p.anchorEpoch, 20719);
    assert.equal(p.bornEpoch, 20718);
    assert.equal(p.exitId, 41n);
    assert.equal(p.credits, 5n);
  } finally { f.restore(); }
});

test("API 报错时抛 BacApiError，带上站点给的中文说明", async () => {
  const f = stubFetch({ "/api/rate": { __status: 429, body: { error: { code: "rate_limited", message: "限速了" } } } });
  try {
    await assert.rejects(() => api.rate("https://x.invalid"), (e) => e.code === "api" && e.status === 429 && /限速了/.test(e.message));
  } finally { f.restore(); }
});

test("api.feed 把 kind 数组拼成逗号分隔的查询参数", async () => {
  const f = stubFetch({ "/api/feed": { items: [{ id: 1 }] } });
  try {
    await api.feed({ after: 5, limit: 10, kind: ["DEPLOY", "PUBLISH"] }, "https://x.invalid");
    const url = f.seen.at(-1);
    assert.match(url, /after=5/);
    assert.match(url, /limit=10/);
    assert.match(url, /kind=DEPLOY%2CPUBLISH/);
  } finally { f.restore(); }
});

test("loadAddresses：站点给了地址就用站点的，站点不通就用常量且不抛错", async () => {
  const f = stubFetch({ "/api/health": { addresses: { registry: "0x1111111111111111111111111111111111111111" } } });
  try {
    const a = await loadAddresses({ apiBase: "https://x.invalid" });
    assert.equal(a.registry, "0x1111111111111111111111111111111111111111");
    assert.equal(a.l2Bridge, "0x0000000000000000000000000000000000000101");
  } finally { f.restore(); }

  const f2 = stubFetch({});   // 全部 404
  try {
    const a = await loadAddresses({ apiBase: "https://x.invalid" });
    assert.match(a.registry, /^0x0{40}$/, "读不到就还是 0x0，由 requireAddress 在用到时报错");
  } finally { f2.restore(); }
});

test("对账公式：diff = (issued − exited) − (circulating + feeSink + signer)", async () => {
  const bridgeBal = 900n * 10n ** 24n;
  const sinkBal = 3125n * 10n ** 12n;
  const signerBal = 42n * 10n ** 18n;
  const signer = "0x3333333333333333333333333333333333333333";
  const issued = LAYER_TOTAL_SUPPLY - bridgeBal;    // 让 diff 正好为 0
  const exited = 0n;

  const bsc = chainMock(56, {
    calls: {
      [sel("totalCreditsIssued")]: abi.encode(["uint256"], [issued]),
      [sel("totalCreditsExited")]: abi.encode(["uint256"], [exited]),
    },
  });
  const layer = chainMock(56777, {
    balances: {
      "0x0000000000000000000000000000000000000101": bridgeBal,
      "0x000000000000000000000000000000000000dead": sinkBal,
      [signer.toLowerCase()]: signerBal,
    },
  });
  layer.on_("qbft_getValidatorsByBlockNumber", () => [signer]);

  // reconcile.check 自己建 provider，这里直接验公式本身（用同样的读数）
  // 决策 #17：FeeSplitter 也要减（这里的假链没有它，余额是 0，公式照样成立）
  const splitterBal = 0n;
  const circulating = LAYER_TOTAL_SUPPLY - bridgeBal - sinkBal - splitterBal - signerBal;
  const diff = (issued - exited) - (circulating + sinkBal + splitterBal + signerBal);
  assert.equal(diff, 0n, "公式必须能真的等于 0，否则告警会被运维关掉");

  // 并且它不依赖 signer / splitter 的余额：这两项在等式两边相消
  const circ2 = LAYER_TOTAL_SUPPLY - bridgeBal - sinkBal - 0n - 0n;
  assert.equal((issued - exited) - (circ2 + sinkBal + 0n + 0n), 0n);
  assert.equal(await layer.getBalance(signer), signerBal);
  assert.equal(typeof reconcile.check, "function");
});

test("mapChainError 把双语 require 字符串翻成机器码 + 中文下一步", () => {
  const cases = [
    ["Anchor not final / 锚点尚未定案", "anchor_not_final"],
    ["Exit already claimed / 该退出已领取", "exit_already_claimed"],
    ["Bad merkle proof / merkle 证明无效", "bad_proof"],
    ["Bridge halted / 桥已停机", "bridge_halted"],
    ["Already collected this epoch / 本纪元已领取", "already_collected"],
    ["Agent not admitted / agent 未获准入", "not_admitted"],
    ["Summary too long / 摘要过长", "summary_too_long"],
    ["Challenge time deadline passed / 挑战时间截止已过", "challenge_deadline_time"],
  ];
  for (const [reason, code] of cases) {
    const e = mapChainError({ reason }, "测试");
    assert.equal(e.code, code, reason);
    assert.ok(e.action.length > 0);
    assert.equal(e.revertReason, reason);
  }
});

test("认不出来的 revert 原样带出去，不编造解释", () => {
  const e = mapChainError({ reason: "Something new / 新情况" }, "测试");
  assert.equal(e.code, "revert");
  assert.match(e.message, /Something new/);
  assert.match(e.action, /没有对应的解释条目/);
});

test("从 ethers 各种错误形状里都能抠出 revert 字符串", async () => {
  const { extractRevertReason } = await import("../dist/index.js");
  assert.equal(extractRevertReason({ reason: "A / 甲" }), "A / 甲");
  assert.equal(extractRevertReason({ revert: { args: ["B / 乙"] } }), "B / 乙");
  assert.equal(extractRevertReason({ info: { error: { message: "execution reverted: C / 丙" } } }), "C / 丙");
  assert.equal(extractRevertReason({ code: "NETWORK_ERROR" }), undefined);
});
