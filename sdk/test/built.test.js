// agent 自己造出来的那一层（决策 #19 / 03 §7）：部署、发现、报价、交易、端点切换。
// 全程离线：假 provider + 假 fetch，没有网络、没有服务器、没有真私钥余额。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { AbiCoder, Interface, Wallet, getCreateAddress } from "ethers";
import { built, LAYER_SYSTEM } from "../dist/index.js";
import { chainMock, TEST_KEYS } from "./helpers/mock.js";

const abi = AbiCoder.defaultAbiCoder();
const routerIface = new Interface(built.V2_ROUTER_ABI);
const pairIface = new Interface(built.V2_PAIR_ABI);
const erc20Iface = new Interface(built.ERC20_FULL_ABI);
const rsel = (n) => routerIface.getFunction(n).selector;
const psel = (n) => pairIface.getFunction(n).selector;
const esel = (n) => erc20Iface.getFunction(n).selector;

const A = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const TOKEN0 = "0x1111111111111111111111111111111111111111";
const TOKEN1 = "0x2222222222222222222222222222222222222222";
const PAIR = "0x3333333333333333333333333333333333333333";
const ROUTER = "0x4444444444444444444444444444444444444444";
const WBAC = "0x5555555555555555555555555555555555555555";

/** 一份最小的假 artifact：字节码是测试用的占位符，不是任何合约的实现。 */
const ARTIFACT = {
  abi: [{ type: "constructor", inputs: [{ name: "supply", type: "uint256" }, { name: "sym", type: "string" }] }],
  bytecode: "0x6080604052",
};

/** 一张 URL → 响应的表；值可以是对象，也可以是函数（抛错 = 网络层失败）。 */
function fetchTable(routes) {
  const seen = [];
  const impl = async (url, init) => {
    const u = String(url);
    seen.push({ url: u, body: init?.body ? JSON.parse(init.body) : null });
    for (const [pattern, res] of Object.entries(routes)) {
      if (!u.includes(pattern)) continue;
      const body = typeof res === "function" ? res(u, init) : res;
      if (body && body.__status) {
        return new Response(JSON.stringify(body.body ?? {}), {
          status: body.__status, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: "mock 没有这条路由：" + u } }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  };
  impl.seen = seen;
  return impl;
}

// ═══════════════════════════════════════════════ 1. 报价算术（纯函数）═══

test("getAmountOut：手续费是参数，不是假设", () => {
  const rIn = 1_000_000n, rOut = 2_000_000n, amountIn = 1_000n;
  const free = built.getAmountOut(amountIn, rIn, rOut, 0);
  const uni = built.getAmountOut(amountIn, rIn, rOut, 30);      // 0.3%
  const one = built.getAmountOut(amountIn, rIn, rOut, 100);     // 1%
  assert.ok(free > uni && uni > one, "费率越高拿到越少");
  // 逐字对拍 Uniswap V2 的整数写法
  const withFee = amountIn * 9970n;
  assert.equal(uni, (withFee * rOut) / (rIn * 10000n + withFee));
  assert.equal(free, (amountIn * 10000n * rOut) / (rIn * 10000n + amountIn * 10000n));
});

test("getAmountOut 不许有默认费率：不传就报错", () => {
  assert.throws(() => built.getAmountOut(1n, 10n, 10n), (e) => e.code === "bad_fee");
  assert.throws(() => built.getAmountOut(1n, 10n, 10n, 10000), (e) => e.code === "bad_fee");
  assert.throws(() => built.getAmountOut(1n, 10n, 10n, 2.5), (e) => e.code === "bad_fee");
  assert.throws(() => built.getAmountOut(1n, 0n, 10n, 30), (e) => e.code === "empty_pool");
});

test("getAmountIn 是 getAmountOut 的逆，向上取整一 wei", () => {
  const rIn = 5_000_000n, rOut = 7_000_000n, fee = 30;
  const want = 12_345n;
  const need = built.getAmountIn(want, rIn, rOut, fee);
  assert.ok(built.getAmountOut(need, rIn, rOut, fee) >= want, "按算出来的投入必须真的够");
  assert.ok(built.getAmountOut(need - 1n, rIn, rOut, fee) < want, "少一 wei 就不够（说明没有多算）");
  assert.throws(() => built.getAmountIn(rOut, rIn, rOut, fee), (e) => e.code === "insufficient_liquidity");
});

test("多跳：每一跳的费率都要单独给", () => {
  const out = built.getAmountsOut(1000n, [[1_000_000n, 2_000_000n], [2_000_000n, 500_000n]], [30, 100]);
  assert.equal(out.length, 3);
  assert.equal(out[0], 1000n);
  assert.equal(out[1], built.getAmountOut(1000n, 1_000_000n, 2_000_000n, 30));
  assert.equal(out[2], built.getAmountOut(out[1], 2_000_000n, 500_000n, 100));
  assert.throws(() => built.getAmountsOut(1000n, [[1n, 1n]], [30, 30]), (e) => e.code === "bad_path");
});

test("加流动性：空池是你自己定价，之后按比例配", () => {
  const first = built.quoteAddLiquidity(100n, 400n, 0n, 0n);
  assert.deepEqual([first.amountA, first.amountB], [100n, 400n]);
  assert.match(first.note, /初始价格/);

  const later = built.quoteAddLiquidity(100n, 1000n, 1_000n, 4_000n);
  assert.deepEqual([later.amountA, later.amountB], [100n, 400n], "B 按 1:4 的储备比例配");

  const capped = built.quoteAddLiquidity(100n, 200n, 1_000n, 4_000n);
  assert.deepEqual([capped.amountA, capped.amountB], [50n, 200n], "B 不够时反过来按 B 定量");
});

test("首笔 LP 份额扣掉 MINIMUM_LIQUIDITY", () => {
  assert.equal(built.quoteLiquidityMinted(10_000n, 10_000n, 0n, 0n, 0n), 10_000n - 1000n);
  assert.equal(built.quoteLiquidityMinted(100n, 400n, 1_000n, 4_000n, 2_000n), 200n);
  assert.equal(built.sqrt(1_000_000n), 1000n);
});

test("滑点：min 往下、max 往上，超界报错", () => {
  assert.equal(built.applySlippage(10_000n, 50, "min"), 9_950n);
  assert.equal(built.applySlippage(10_000n, 50, "max"), 10_050n);
  assert.equal(built.applySlippage(10_000n, 0, "min"), 10_000n);
  assert.throws(() => built.applySlippage(1n, 10_001, "min"), (e) => e.code === "bad_slippage");
});

test("成交价公式逐字照抄 03 §7.3，decimals 未知就是 null", () => {
  // amt0 = 1e18 (dec0=18), amt1 = 1024e15 (dec1=18) → 1.024 ×10^18
  assert.equal(built.price1Per0(10n ** 18n, 1024n * 10n ** 15n, 18, 18), 1_024_000_000_000_000_000n);
  assert.equal(built.price0Per1(10n ** 18n, 1024n * 10n ** 15n, 18, 18), 976_562_500_000_000_000n);
  assert.equal(built.price1Per0(0n, 1n, 18, 18), null, "amt0 == 0 时没有价格");
  assert.equal(built.price1Per0(1n, 1n, null, 18), null, "decimals 未知不许当 18");
});

test("impliedFeeBps 能从一笔成交把费率反推出来", () => {
  const rIn = 3_000_000n, rOut = 9_000_000n;
  for (const fee of [0, 25, 30, 100]) {
    const out = built.getAmountOut(50_000n, rIn, rOut, fee);
    assert.equal(built.impliedFeeBps(50_000n, out, rIn, rOut), fee, `费率 ${fee} 应该能反推出来`);
  }
});

test("sortTokens 与 V2 内部一致，两边相同要报错", () => {
  assert.deepEqual(built.sortTokens(TOKEN1, TOKEN0), [TOKEN0, TOKEN1]);
  assert.throws(() => built.sortTokens(TOKEN0, TOKEN0.toLowerCase()), (e) => e.code === "same_token");
});

// ═══════════════════════════════════════════════════════ 2. 部署路径 ═══

test("encodeInitCode：带构造参数要 abi，deployedBytecode 传进来会被挡住", () => {
  const code = built.encodeInitCode(ARTIFACT, [1000n, "FUEL"]);
  assert.ok(code.startsWith(ARTIFACT.bytecode));
  assert.equal(code.length, ARTIFACT.bytecode.length + abi.encode(["uint256", "string"], [1000n, "FUEL"]).length - 2);
  assert.equal(built.encodeInitCode({ bytecode: "0x1234" }), "0x1234");
  assert.throws(() => built.encodeInitCode({ bytecode: "0x1234" }, [1n]), (e) => e.code === "no_abi");
  assert.throws(() => built.encodeInitCode({ bytecode: "不是十六进制" }), (e) => e.code === "bad_bytecode");
});

test("initcode 超过 EIP-3860 直接报错，不发那笔必然失败的交易", () => {
  const big = "0x" + "60".repeat(built.MAX_INITCODE_SIZE + 1);
  assert.throws(() => built.checkCodeSize(big), (e) => e.code === "initcode_too_big");
  const warn = built.checkCodeSize("0x" + "60".repeat(built.MAX_CODE_SIZE + 10));
  assert.match(warn.warning, /EIP-170/);
  assert.equal(built.checkCodeSize("0x6080").warning, null);
});

test("gasPrice：节点报价与 1 gwei 下限取大；显式给低于下限的会报错", async () => {
  const low = chainMock(56777, {});
  low.on_("eth_gasPrice", () => "0x1");
  assert.equal(await built.gasPriceFor(low), built.MIN_GAS_PRICE_WEI, "低于下限时抬到 1 gwei");

  const high = chainMock(56777, {});
  high.on_("eth_gasPrice", () => "0x77359400");   // 2 gwei
  assert.equal(await built.gasPriceFor(high), 2_000_000_000n, "节点报价更高就听节点的");

  await assert.rejects(() => built.gasPriceFor(high, 999_999_999n), (e) => e.code === "gas_price_too_low");
});

test("planGas：估算 × 1.25，超过区块上限直接报错", async () => {
  const p = chainMock(56777, {});
  const plan = await built.planGas(p, { data: "0x6080" });
  assert.equal(plan.estimated, 500_000n);
  assert.equal(plan.gasLimit, 625_000n, "500000 × 1.25");
  assert.equal(plan.gasPrice, built.MIN_GAS_PRICE_WEI);
  assert.equal(plan.maxFeeWei, 625_000n * built.MIN_GAS_PRICE_WEI);

  const fat = chainMock(56777, {});
  fat.on_("eth_estimateGas", () => "0x" + (25_000_000).toString(16));
  await assert.rejects(() => built.planGas(fat, { data: "0x6080" }), (e) => e.code === "gas_over_block_limit");

  const near = chainMock(56777, {});
  near.on_("eth_estimateGas", () => "0x" + (19_000_000).toString(16));
  const capped = await built.planGas(near, { data: "0x6080" });
  assert.equal(capped.gasLimit, built.BLOCK_GAS_LIMIT, "加了余量也不许超过区块上限");
});

test("deployContract：legacy 交易、1 gwei、地址由 from+nonce 定，部署完核对代码", async () => {
  const layer = chainMock(56777, {});
  const signer = new Wallet(TEST_KEYS.layer, layer);
  const r = await built.deployContract(signer, ARTIFACT, [1000n, "FUEL"]);

  const sent = layer.sentRaw.at(-1);
  assert.equal(sent.type, 0, "zeroBaseFee 的链上必须发 legacy 交易");
  assert.equal(sent.gasPrice, built.MIN_GAS_PRICE_WEI);
  assert.equal(sent.gasLimit, 625_000n);
  assert.equal(sent.to, null, "CREATE 部署没有 to");
  assert.equal(sent.data, built.encodeInitCode(ARTIFACT, [1000n, "FUEL"]));
  assert.equal(r.address, getCreateAddress({ from: signer.address, nonce: 0 }));
  assert.equal(r.via, "create");
  assert.equal(r.codeSize, 4, "部署后读一次 eth_getCode 核对，返回的是真实字节数");
  assert.equal(r.txHash, sent.hash);
});

test("deployContract：交易上链了但地址上没代码 → 抛 unknown_state，不假装成功", async () => {
  const layer = chainMock(56777, {});
  layer.on_("eth_getCode", () => "0x");
  const signer = new Wallet(TEST_KEYS.layer, layer);
  await assert.rejects(() => built.deployContract(signer, { bytecode: "0x6080" }),
    (e) => e.code === "unknown_state" && /没有代码/.test(e.message));
});

test("CREATE2：地址可以先算出来，且和创世部署器的算法一致", async () => {
  const predicted = built.predictCreate2Address(ARTIFACT, [1000n, "FUEL"], "第一个币");
  assert.match(predicted, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(predicted, built.predictCreate2Address(ARTIFACT, [1000n, "FUEL"], "第一个币"), "同 salt 同 initcode 必须同地址");
  assert.notEqual(predicted, built.predictCreate2Address(ARTIFACT, [1000n, "FUEL"], "第二个币"));

  let probes = 0;
  const layer = chainMock(56777, {});
  layer.on_("eth_getCode", () => (probes++ === 0 ? "0x" : "0x60006000"));
  const signer = new Wallet(TEST_KEYS.layer, layer);
  const r = await built.deployCreate2(signer, ARTIFACT, [1000n, "FUEL"], "第一个币");
  assert.equal(r.address, predicted, "发出去的地址就是先算好的那个");
  assert.equal(r.via, "create2");
  const sent = layer.sentRaw.at(-1);
  assert.equal(sent.to.toLowerCase(), LAYER_SYSTEM.create2Deployer.toLowerCase());
  assert.ok(sent.data.endsWith(built.encodeInitCode(ARTIFACT, [1000n, "FUEL"]).slice(2)), "salt 在前，initcode 在后");
});

test("CREATE2：地址已经被占用时报错并让人换 salt", async () => {
  const layer = chainMock(56777, {});   // eth_getCode 恒返回非空
  const signer = new Wallet(TEST_KEYS.layer, layer);
  await assert.rejects(() => built.deployCreate2(signer, { bytecode: "0x6080" }, [], "占用了"),
    (e) => e.code === "create2_taken");
});

// ═══════════════════════════════════════════ 3. 主 / 兜底端点切换 ═══

const PRIMARY = "https://primary.invalid";
const BACKUP = "https://backup.invalid";

function poolWithClock(routes, opts = {}) {
  let now = 1_000_000;
  const impl = fetchTable(routes);
  const pool = new built.EndpointPool([PRIMARY, BACKUP], {
    fetchImpl: impl, now: () => now, backoffBaseMs: 5000, ...opts,
  });
  return { pool, impl, advance: (ms) => { now += ms; }, at: () => now };
}

test("失败切换：主端点网络层坏了就走兜底，并记退避", async () => {
  const { pool, impl } = poolWithClock({
    [PRIMARY]: () => { throw new Error("getaddrinfo ENOTFOUND"); },
    [BACKUP]: { items: [{ id: 1 }] },
  });
  const r = await pool.getJson("/api/tokens");
  assert.deepEqual(r.items, [{ id: 1 }]);
  assert.equal(pool.stats.failovers, 1);
  assert.equal(impl.seen.length, 2, "先打主端点，再打兜底");
  assert.ok(!pool.healthy(PRIMARY), "主端点进了退避窗口");
  assert.equal(pool.get(PRIMARY).until - 1_000_000, 5000, "第一次失败退避 5 秒");
});

test("退避期间不再撞主端点；到期后自动换回去", async () => {
  const seenPrimary = [];
  const { pool, impl, advance } = poolWithClock({
    [PRIMARY]: () => {
      seenPrimary.push(1);
      if (seenPrimary.length <= 1) throw new Error("暂时不通");
      return { ok: "主端点回来了" };
    },
    [BACKUP]: { ok: "兜底" },
  });
  assert.equal((await pool.getJson("/x")).ok, "兜底");
  assert.equal((await pool.getJson("/x")).ok, "兜底", "退避期内直接用上一次成功的端点");
  assert.equal(seenPrimary.length, 1, "退避期内一次都没再撞主端点");
  advance(5001);
  assert.equal((await pool.getJson("/x")).ok, "主端点回来了");
  assert.equal(impl.seen.at(-1).url.startsWith(PRIMARY), true);
});

test("退避是翻倍的，上限 120 秒", () => {
  assert.equal(built.backoffMs(1, 5000), 5000);
  assert.equal(built.backoffMs(2, 5000), 10000);
  assert.equal(built.backoffMs(5, 5000), 80000);
  assert.equal(built.backoffMs(9, 5000), 120000);
  assert.equal(built.backoffMs(99, 5000), 120000);
});

test("JSON-RPC 自己回的 error 不算端点坏：不切换、不退避", async () => {
  const { pool, impl } = poolWithClock({
    [PRIMARY]: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } },
    [BACKUP]: { jsonrpc: "2.0", id: 1, result: "0x1" },
  });
  await assert.rejects(() => pool.rpc("eth_call", [{}, "latest"]), (e) => /execution reverted/.test(e.message));
  assert.equal(impl.seen.length, 1, "只打了主端点一次");
  assert.equal(pool.stats.failovers, 0);
  assert.ok(pool.healthy(PRIMARY));
});

test("API 的 4xx 也不切换（换个端点是同样的答案），429 会切换", async () => {
  const notFound = poolWithClock({
    [PRIMARY]: { __status: 404, body: { error: { code: "not_found", message: "这个地址没有被识别为代币" } } },
    [BACKUP]: { ok: 1 },
  });
  await assert.rejects(() => notFound.pool.getJson("/api/token/0x"), (e) => e.status === 404);
  assert.equal(notFound.impl.seen.length, 1);

  const limited = poolWithClock({
    [PRIMARY]: { __status: 429, body: { error: { code: "rate_limited", message: "限速了" } } },
    [BACKUP]: { ok: 1 },
  });
  assert.deepEqual(await limited.pool.getJson("/api/tokens"), { ok: 1 });
  assert.equal(limited.impl.seen.length, 2, "被限速时换兜底是对的");
});

test("两个端点都不通：报错里把两个都点名", async () => {
  const { pool } = poolWithClock({
    [PRIMARY]: () => { throw new Error("主挂了"); },
    [BACKUP]: () => { throw new Error("兜底也挂了"); },
  });
  await assert.rejects(() => pool.getJson("/x"), (e) =>
    e.code === "api" && e.message.includes("primary.invalid") && e.message.includes("backup.invalid"));
});

// ═══════════════════════════════════════════════════ 4. 发现别人造的 ═══

const DETECTION = {
  method: "heuristic",
  note: "本链没有官方 DEX、官方代币或官方工具合约。",
  rulesUrl: "https://bnbagentchain-scan.com/docs/detection",
  unclassifiedContracts: 3,
};

function builtCfg(routes) {
  const impl = fetchTable(routes);
  return {
    cfg: { apiBase: PRIMARY, fallbackApi: BACKUP, layerRpc: PRIMARY + "/rpc", fallbackRpc: BACKUP + "/rpc", pool: { fetchImpl: impl } },
    impl,
  };
}

test("listTokens：金额转 bigint、detection 透传、nameTrusted 恒为 false", async () => {
  const { cfg, impl } = builtCfg({
    "/api/tokens": {
      schema: "bac/tokens/1", total: 1, page: 1, pageSize: 50, detection: DETECTION, updatedAt: 17,
      items: [{
        address: TOKEN0, name: "Agent Fuel", symbol: "FUEL", decimals: 18, nameTrusted: false,
        totalSupply: "1000000000000000000000000", supplyBlock: 1234560,
        creator: { agentId: 17, wallet: TOKEN1 }, deployTx: "0xabc", deployBlock: 1, deployTs: 2,
        holders: 4, transfers: 19, mints: 1, burns: 0, pairCount: 1, swapCount: 6,
        detectLevel: "full", balanceDrift: false, zeroOnly: false, sameNameCount: 2,
      }],
    },
  });
  const page = await built.listTokens({ sort: "holders", agentId: 17, includeZeroOnly: true }, cfg);
  assert.equal(page.total, 1);
  assert.equal(page.items[0].totalSupply, 1_000_000_000_000_000_000_000_000n);
  assert.equal(typeof page.items[0].totalSupply, "bigint");
  assert.equal(page.items[0].nameTrusted, false);
  assert.equal(page.items[0].sameNameCount, 2);
  assert.deepEqual(page.detection, DETECTION, "detection 必须原样带出来");
  assert.match(impl.seen.at(-1).url, /sort=holders/);
  assert.match(impl.seen.at(-1).url, /includeZeroOnly=1/);
});

test("decimals 未知就是 null，绝不默认当 18", async () => {
  const { cfg } = builtCfg({
    "/api/tokens": { items: [{ address: TOKEN0, decimals: null, detectLevel: "partial", totalSupply: "0" }] },
  });
  const page = await built.listTokens({}, cfg);
  assert.equal(page.items[0].decimals, null);
  assert.equal(page.items[0].detectLevel, "partial");
  assert.equal(page.detection, null, "对面没给 detection 时就是 null，不许自己编一个");
});

test("listPairs / getPair：两边代币、储备来源、lastPrice 都按 §7.6 解出来", async () => {
  const { cfg } = builtCfg({
    "/api/pairs": {
      total: 1, page: 1, pageSize: 50, detection: DETECTION,
      items: [{
        address: PAIR, kind: "v2", discoveredVia: "factory",
        factory: { address: ROUTER, creatorAgentId: 21 },
        token0: { address: TOKEN0, symbol: "FUEL", decimals: 18, known: true },
        token1: { address: TOKEN1, symbol: null, decimals: null, known: false },
        creator: { agentId: 21, wallet: TOKEN1 },
        reserve0: "1000", reserve1: "4000", reserveSource: "getReserves", reserveBlock: 9,
        swapCount: 6, vol0: "10", vol1: "40", volSkipped: 1, mintCount: 2, burnCount: 0,
        lastPrice: "1024000000000000000", detectLevel: "partial",
      }],
    },
  });
  const page = await built.listPairs({ token: TOKEN0, kind: "v2" }, cfg);
  const p = page.items[0];
  assert.equal(p.reserve0, 1000n);
  assert.equal(p.reserve1, 4000n);
  assert.equal(p.reserveSource, "getReserves");
  assert.equal(p.token1.known, false, "这一边没被判成代币，只能显示地址");
  assert.equal(p.lastPrice, 1_024_000_000_000_000_000n);
  assert.equal(p.volSkipped, 1);
});

test("classifyContract：认不出来时 classified = null，并照实说一句中文", async () => {
  const { cfg } = builtCfg({
    "/api/contract/": {
      detection: DETECTION, classified: null,
      contract: { address: PAIR, deployer: TOKEN0, agentId: 17, codeSize: 12844, callCount: 190 },
    },
  });
  const c = await built.classifyContract(PAIR, cfg);
  assert.equal(c.classified, null);
  assert.match(c.classifiedZh, /没能识别/);
  assert.equal(c.codeSize, 12844);
  assert.equal(c.detection.unclassifiedContracts, 3);
});

test("readReserves：V2 走 getReserves", async () => {
  const { cfg } = builtCfg({
    "/rpc": (url, init) => {
      const req = JSON.parse(init.body);
      if (req.method === "eth_blockNumber") return { jsonrpc: "2.0", id: 1, result: "0x64" };
      const data = req.params[0].data;
      const out =
        data.startsWith(psel("token0")) ? abi.encode(["address"], [TOKEN0])
        : data.startsWith(psel("token1")) ? abi.encode(["address"], [TOKEN1])
        : data.startsWith(psel("getReserves")) ? abi.encode(["uint112", "uint112", "uint32"], [1000n, 4000n, 7n])
        : "0x";
      return { jsonrpc: "2.0", id: 1, result: out };
    },
  });
  const r = await built.readReserves(PAIR, cfg);
  assert.equal(r.source, "getReserves");
  assert.equal(r.reserve0, 1000n);
  assert.equal(r.reserve1, 4000n);
  assert.equal(r.blockTimestampLast, 7);
  assert.equal(r.atBlock, 100);
});

test("readReserves：没有 getReserves 的池子回退到 balanceOf，并把来源标出来", async () => {
  const { cfg } = builtCfg({
    "/rpc": (url, init) => {
      const req = JSON.parse(init.body);
      if (req.method === "eth_blockNumber") return { jsonrpc: "2.0", id: 1, result: "0x64" };
      const to = req.params[0].to.toLowerCase();
      const data = req.params[0].data;
      if (data.startsWith(psel("token0"))) return { jsonrpc: "2.0", id: 1, result: abi.encode(["address"], [TOKEN0]) };
      if (data.startsWith(psel("token1"))) return { jsonrpc: "2.0", id: 1, result: abi.encode(["address"], [TOKEN1]) };
      if (data.startsWith(psel("getReserves"))) {
        return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } };
      }
      if (data.startsWith(esel("balanceOf"))) {
        return { jsonrpc: "2.0", id: 1, result: abi.encode(["uint256"], [to === TOKEN0.toLowerCase() ? 500n : 1500n]) };
      }
      return { jsonrpc: "2.0", id: 1, result: "0x" };
    },
  });
  const r = await built.readReserves(PAIR, cfg);
  assert.equal(r.source, "balanceOf");
  assert.equal(r.reserve0, 500n);
  assert.equal(r.reserve1, 1500n);
  assert.equal(r.blockTimestampLast, null);
});

test("quoteExactIn / quoteExactOut：对着任意一个交易对报价，费率必须传", async () => {
  const { cfg } = builtCfg({
    "/rpc": (url, init) => {
      const req = JSON.parse(init.body);
      if (req.method === "eth_blockNumber") return { jsonrpc: "2.0", id: 1, result: "0x64" };
      const data = req.params[0].data;
      const out =
        data.startsWith(psel("token0")) ? abi.encode(["address"], [TOKEN0])
        : data.startsWith(psel("token1")) ? abi.encode(["address"], [TOKEN1])
        : abi.encode(["uint112", "uint112", "uint32"], [1_000_000n, 4_000_000n, 7n]);
      return { jsonrpc: "2.0", id: 1, result: out };
    },
  });
  const q = await built.quoteExactIn({ pair: PAIR, tokenIn: TOKEN0, amountIn: 1000n, feeBps: 30 }, cfg);
  assert.equal(q.amountOut, built.getAmountOut(1000n, 1_000_000n, 4_000_000n, 30));
  assert.equal(q.tokenOut, TOKEN1);
  assert.match(q.note, /不是行情价/);

  const q2 = await built.quoteExactOut({ pair: PAIR, tokenOut: TOKEN1, amountOut: q.amountOut, feeBps: 30 }, cfg);
  assert.ok(q2.amountIn >= 1000n - 1n && q2.amountIn <= 1001n);

  await assert.rejects(() => built.quoteExactIn({ pair: PAIR, tokenIn: A(9), amountIn: 1n, feeBps: 30 }, cfg),
    (e) => /不是 .* 的任何一边/.test(e.message));
});

test("watchBuilt：按 feed 游标拉新，盯的是「造出了新东西」这几类", async () => {
  let round = 0;
  const { cfg, impl } = builtCfg({
    "/api/feed": () => {
      round += 1;
      if (round === 1) return { items: [], head: 100 };            // 起点：只看新的
      if (round === 2) {
        return {
          items: [
            { id: 101, kind: "TOKEN_NEW", ts: 1, block: 2, agentId: 17, textZh: "agent #17 发了一个代币 FUEL", tx: "0xa", anchored: false, epoch: 5 },
            { id: 102, kind: "PAIR_NEW", ts: 2, block: 3, agentId: 21, textZh: "agent #21 建了一个交易对", tx: "0xb", anchored: true, epoch: 5 },
          ],
        };
      }
      return {
        items: [{ id: 103, kind: "TOKEN_FIRST_TRADE", ts: 3, block: 4, agentId: 17, textZh: "FUEL 有了第一笔成交", tx: "0xc", anchored: false, epoch: 5 }],
      };
    },
  });
  const ctl = new AbortController();
  const got = [];
  for await (const ev of built.watchBuilt({ intervalMs: 1, signal: ctl.signal }, cfg)) {
    got.push(ev);
    if (got.length === 3) ctl.abort();
  }
  assert.deepEqual(got.map((e) => e.id), [101, 102, 103]);
  assert.equal(got[0].kind, "TOKEN_NEW");
  assert.equal(got[1].anchored, true);
  assert.match(impl.seen[0].url, /kind=TOKEN_NEW%2CPAIR_NEW%2CTOKEN_FIRST_TRADE%2CDEPLOY/);
  assert.match(impl.seen.at(-1).url, /after=102/, "游标跟着最新的 id 往前走");
});

// ═══════════════════════════════════════════════════════ 5. 交易帮手 ═══

function layerChain(extra = {}) {
  return chainMock(56777, {
    calls: {
      [rsel("getAmountsOut")]: abi.encode(["uint256[]"], [[1000n, 3940n]]),
      [rsel("getAmountsIn")]: abi.encode(["uint256[]"], [[1020n, 4000n]]),
      [psel("token0")]: abi.encode(["address"], [TOKEN0]),
      [psel("token1")]: abi.encode(["address"], [TOKEN1]),
      [psel("getReserves")]: abi.encode(["uint112", "uint112", "uint32"], [1_000_000n, 4_000_000n, 7n]),
      [esel("allowance")]: abi.encode(["uint256"], [0n]),
      ...extra,
    },
  });
}

test("approve：打的是那个代币，spender 与数量都是你传的", async () => {
  const layer = layerChain();
  const signer = new Wallet(TEST_KEYS.layer, layer);
  await built.approve(signer, { token: TOKEN0, spender: ROUTER, amount: 123n }, {});
  const sent = layer.sentRaw.at(-1);
  assert.equal(sent.to, TOKEN0);
  const parsed = erc20Iface.parseTransaction({ data: sent.data });
  assert.equal(parsed.name, "approve");
  assert.equal(parsed.args[0], ROUTER);
  assert.equal(parsed.args[1], 123n);
});

test("ensureAllowance：够了就不发交易", async () => {
  const enough = layerChain({ [esel("allowance")]: abi.encode(["uint256"], [10_000n]) });
  const signer = new Wallet(TEST_KEYS.layer, enough);
  const r = await built.ensureAllowance(signer, { token: TOKEN0, spender: ROUTER, amount: 1000n });
  assert.equal(r.txHash, null);
  assert.equal(enough.sentRaw.length, 0, "不够才发交易，够了不许白花 gas");

  const short = layerChain();
  const s2 = new Wallet(TEST_KEYS.layer, short);
  const r2 = await built.ensureAllowance(s2, { token: TOKEN0, spender: ROUTER, amount: 1000n });
  assert.ok(r2.txHash);
  assert.equal(short.sentRaw.length, 1);
});

test("swapExactIn：router 是参数，没给就明确报错（SDK 里没有任何写死的交易地址）", async () => {
  const layer = layerChain();
  const signer = new Wallet(TEST_KEYS.layer, layer);
  await assert.rejects(
    () => built.swapExactIn(signer, { router: undefined, path: [TOKEN0, TOKEN1], amountIn: 1n }),
    (e) => e.code === "missing_address" && /没有官方路由器/.test(e.action),
  );
  await assert.rejects(
    () => built.swapExactIn(signer, { router: ROUTER, path: [TOKEN0], amountIn: 1n }),
    (e) => e.code === "bad_path",
  );
});

test("swapExactIn：滑点下限按路由器自己的报价折算，deadline 取链上时间 + 10 分钟", async () => {
  const layer = layerChain();
  const signer = new Wallet(TEST_KEYS.layer, layer);
  const r = await built.swapExactIn(signer, { router: ROUTER, path: [TOKEN0, TOKEN1], amountIn: 1000n, slippageBps: 50 });
  assert.equal(r.amountOutMin, built.applySlippage(3940n, 50, "min"));
  assert.equal(r.deadline, 1790000000n + 600n, "用链上最新块时间，不是本机时间");

  const sent = layer.sentRaw.at(-1);
  assert.equal(sent.to, ROUTER);
  assert.equal(sent.type, 0);
  assert.equal(sent.gasPrice, built.MIN_GAS_PRICE_WEI);
  const parsed = routerIface.parseTransaction({ data: sent.data });
  assert.equal(parsed.name, "swapExactTokensForTokens");
  assert.equal(parsed.args[0], 1000n);
  assert.equal(parsed.args[1], r.amountOutMin);
  assert.deepEqual([...parsed.args[2]], [TOKEN0, TOKEN1]);
  assert.equal(parsed.args[3], signer.address);
  assert.equal(parsed.args[4], r.deadline);
});

test("swapExactIn：路由器形状不认识时不猜报价，让调用方自己给下限", async () => {
  const layer = chainMock(56777, { calls: {} });   // getAmountsOut 没配 → eth_call 报错
  const signer = new Wallet(TEST_KEYS.layer, layer);
  await assert.rejects(
    () => built.swapExactIn(signer, { router: ROUTER, path: [TOKEN0, TOKEN1], amountIn: 1000n }),
    (e) => e.code === "no_quote",
  );
  const ok = await built.swapExactIn(signer, { router: ROUTER, path: [TOKEN0, TOKEN1], amountIn: 1000n, amountOutMin: 1n, deadline: 99n });
  assert.equal(ok.amountOutMin, 1n);
});

test("swapExactOut：上限按 getAmountsIn × (1 + 滑点)", async () => {
  const layer = layerChain();
  const signer = new Wallet(TEST_KEYS.layer, layer);
  const r = await built.swapExactOut(signer, { router: ROUTER, path: [TOKEN0, TOKEN1], amountOut: 4000n, slippageBps: 100 });
  assert.equal(r.amountInMax, built.applySlippage(1020n, 100, "max"));
  const parsed = routerIface.parseTransaction({ data: layer.sentRaw.at(-1).data });
  assert.equal(parsed.name, "swapTokensForExactTokens");
  assert.equal(parsed.args[0], 4000n);
  assert.equal(parsed.args[1], r.amountInMax);
});

test("addLiquidity / removeLiquidity：地址全是参数，min 按滑点折算", async () => {
  const layer = layerChain();
  const signer = new Wallet(TEST_KEYS.layer, layer);
  await built.addLiquidity(signer, {
    router: ROUTER, tokenA: TOKEN0, tokenB: TOKEN1, amountADesired: 1000n, amountBDesired: 4000n, slippageBps: 100,
  });
  const add = routerIface.parseTransaction({ data: layer.sentRaw.at(-1).data });
  assert.equal(add.name, "addLiquidity");
  assert.deepEqual([add.args[0], add.args[1]], [TOKEN0, TOKEN1]);
  assert.equal(add.args[4], built.applySlippage(1000n, 100, "min"));
  assert.equal(add.args[5], built.applySlippage(4000n, 100, "min"));

  await built.removeLiquidity(signer, {
    router: ROUTER, tokenA: TOKEN0, tokenB: TOKEN1, liquidity: 50n, amountAMin: 1n, amountBMin: 2n,
  });
  const rem = routerIface.parseTransaction({ data: layer.sentRaw.at(-1).data });
  assert.equal(rem.name, "removeLiquidity");
  assert.equal(rem.args[2], 50n);
  assert.equal(rem.args[3], 1n);
});

test("swapOnPairDirect：先转币再 swap，出币方向按 token0/token1 摆对", async () => {
  const layer = layerChain();
  const signer = new Wallet(TEST_KEYS.layer, layer);
  const r = await built.swapOnPairDirect(signer, { pair: PAIR, tokenIn: TOKEN0, amountIn: 1000n, feeBps: 30 });
  assert.equal(r.amountOut, built.getAmountOut(1000n, 1_000_000n, 4_000_000n, 30));
  assert.equal(layer.sentRaw.length, 2, "两笔：先 transfer 后 swap（这两步不是原子的）");

  const t = erc20Iface.parseTransaction({ data: layer.sentRaw[0].data });
  assert.equal(layer.sentRaw[0].to, TOKEN0);
  assert.equal(t.name, "transfer");
  assert.equal(t.args[0], PAIR);

  const s = pairIface.parseTransaction({ data: layer.sentRaw[1].data });
  assert.equal(layer.sentRaw[1].to, PAIR);
  assert.equal(s.name, "swap");
  assert.equal(s.args[0], 0n, "token0 进池子，所以 amount0Out 是 0");
  assert.equal(s.args[1], r.amountOut);
});

test("swapOnPairDirect：tokenIn 不属于这个池子就拒绝", async () => {
  const layer = layerChain();
  const signer = new Wallet(TEST_KEYS.layer, layer);
  await assert.rejects(
    () => built.swapOnPairDirect(signer, { pair: PAIR, tokenIn: A(9), amountIn: 1n, feeBps: 30 }),
    (e) => e.code === "not_in_pair",
  );
});

test("wrap / unwrap：地址由调用方传，deposit 带 value", async () => {
  const layer = layerChain();
  const signer = new Wallet(TEST_KEYS.layer, layer);
  await built.wrapNative(signer, { wrappedNative: WBAC, amount: 777n });
  assert.equal(layer.sentRaw.at(-1).to, WBAC);
  assert.equal(layer.sentRaw.at(-1).value, 777n);

  await built.unwrapNative(signer, { wrappedNative: WBAC, amount: 777n });
  assert.equal(layer.sentRaw.at(-1).value, 0n);
  await assert.rejects(() => built.wrapNative(signer, { wrappedNative: undefined, amount: 1n }),
    (e) => e.code === "missing_address");
});

test("dryRun：只算 gas，不发交易", async () => {
  const layer = layerChain();
  const signer = new Wallet(TEST_KEYS.layer, layer);
  const r = await built.approve(signer, { token: TOKEN0, spender: ROUTER, amount: 1n }, { dryRun: true });
  assert.equal(r.simulated, true);
  assert.equal(r.txHash, "");
  assert.equal(layer.sentRaw.length, 0);
});

test("wrappedNativeAddress：配置里没有、/api/health 也没有就报错，不猜一个地址", async () => {
  const { cfg } = builtCfg({ "/api/health": { layer: { chainId: 56777 } } });
  await assert.rejects(() => built.wrappedNativeAddress(cfg), (e) => e.code === "config" && /不替你猜/.test(e.action));

  const { cfg: cfg2 } = builtCfg({ "/api/health": { layer: { wbac: WBAC } } });
  assert.equal(await built.wrappedNativeAddress(cfg2), WBAC);
  assert.equal(await built.wrappedNativeAddress({ wrappedNative: WBAC }), WBAC, "配置优先");
});

// ═══════════════════════════ 6. 硬性边界：SDK 里不许夹带任何官方合约 ═══

test("built 模块里没有任何合约字节码，也没有写死的交易地址", () => {
  const dir = new URL("../dist/built/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 6, "build 出来的文件应该都在");
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8");
    const blob = src.match(/0x[0-9a-fA-F]{100,}/);
    assert.equal(blob, null, `${f} 里出现了长十六进制串，像是夹带了字节码：${blob?.[0]?.slice(0, 40)}`);
    for (const m of src.matchAll(/["'`]0x[0-9a-fA-F]{40}["'`]/g)) {
      assert.fail(`${f} 里写死了一个地址 ${m[0]}：本链没有官方代币 / DEX / 路由器，地址必须由调用方传`);
    }
  }
});

test("导出面里没有任何「官方」实现，只有接口形状与算术", () => {
  for (const name of ["ERC20_FULL_ABI", "V2_PAIR_ABI", "V2_ROUTER_ABI", "WRAPPED_NATIVE_ABI"]) {
    assert.ok(Array.isArray(built[name]), `${name} 应该是一张人类可读 ABI`);
    for (const frag of built[name]) assert.equal(typeof frag, "string");
  }
  for (const banned of ["ERC20_BYTECODE", "PAIR_BYTECODE", "ROUTER_ADDRESS", "OFFICIAL_ROUTER", "deployToken", "deployDex"]) {
    assert.equal(built[banned], undefined, `不许有 ${banned}：链是空的，这些东西由 agent 自己造`);
  }
});
