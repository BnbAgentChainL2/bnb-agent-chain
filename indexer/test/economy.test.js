// test/economy.test.js —— 决策 #19（03 §7.1–§7.5）：把 agent 造出来的东西解码出来。
// 场景是一条完整的剧本：agent #17 发币、agent #21 发第二个币并部署工厂建池、agent #30 来成交。
// 断言的是**确切的数字与确切的字段**：分类、持有量、成交归一化、幂等、以及「未识别」那条诚实路径。
import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "ethers";
import { processBuiltLogs, refreshStaleTokens, normalizeSwap, price1Per0 } from "../src/economy/index.js";
import { TOPIC, SELECTOR } from "../src/economy/constants.js";
import { sanitizeText, decodeStringReturn, decodeUint256, decodeAddress } from "../src/economy/classify.js";
import { resetWarnings, listWarnings } from "../src/warnings.js";
import { tempDb, cleanupTempDbs } from "./helpers.js";
import {
  A, FakeRpc, ingestBlock, mkBuiltLog, mkRawLog, erc20Stub, v2PairStub, v3PoolStub,
  u256, abiStr, bytes32Str, addr32, txHash, scenario, e18, e6,
} from "./built-helpers.js";

test.after(cleanupTempDbs);

const T = 1790000000;

// ===================== §7.1.1 / §7.2.1 常量对拍 =====================

test("§7.1.1 / §7.2.1：现算的 topic0 与选择器和文档表逐字一致", () => {
  // 文档里那两张表只是给人对照用的；实现里一律现算。这条用例就是那次对拍。
  assert.equal(TOPIC.Transfer, "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  assert.equal(TOPIC.Approval, "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925");
  assert.equal(TOPIC.TransferSingle, "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62");
  assert.equal(TOPIC.TransferBatch, "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb");
  assert.equal(TOPIC.PairCreated, "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9");
  assert.equal(TOPIC.SwapV2, "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822");
  assert.equal(TOPIC.Sync, "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1");
  assert.equal(TOPIC.MintV2, "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f");
  assert.equal(TOPIC.BurnV2, "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496");
  assert.equal(TOPIC.PoolCreated, "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118");
  assert.equal(TOPIC.SwapV3, "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67");
  assert.equal(TOPIC.MintV3, "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde");
  assert.equal(TOPIC.BurnV3, "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c");
  assert.equal(TOPIC.InitializeV3, "0x98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95");

  assert.equal(SELECTOR.name, "0x06fdde03");
  assert.equal(SELECTOR.symbol, "0x95d89b41");
  assert.equal(SELECTOR.decimals, "0x313ce567");
  assert.equal(SELECTOR.totalSupply, "0x18160ddd");
  assert.equal(SELECTOR.balanceOf, "0x70a08231");
  assert.equal(SELECTOR.token0, "0x0dfe1681");
  assert.equal(SELECTOR.token1, "0xd21220a7");
  assert.equal(SELECTOR.getReserves, "0x0902f1ac");
  assert.equal(SELECTOR.factory, "0xc45a0155");
  assert.equal(SELECTOR.fee, "0xddca3f43");
  assert.equal(SELECTOR.slot0, "0x3850c7bd");
  assert.equal(SELECTOR.liquidity, "0x1a686502");
  assert.equal(SELECTOR.tickSpacing, "0xd0c93a7c");

  // V2 与 V3 的 Swap / Mint / Burn 必须是不同的 topic0 —— 按事件名分派会把它们混成一坨。
  assert.notEqual(TOPIC.SwapV2, TOPIC.SwapV3);
  assert.notEqual(TOPIC.MintV2, TOPIC.MintV3);
  assert.notEqual(TOPIC.BurnV2, TOPIC.BurnV3);
});

// ===================== 剧本 =====================

// ===================== 分类 =====================

test("§7.1：agent 发的币被判成代币，元数据、部署者、等级都对", async () => {
  const { db } = await scenario();
  const a = db.prepare("SELECT * FROM tokens WHERE address = ?").get(A.tokenA);
  assert.equal(a.name, "Agent Fuel");
  assert.equal(a.symbol, "FUEL");
  assert.equal(Number(a.decimals), 18);
  assert.equal(a.total_supply, e18(1000000).toString());
  assert.equal(a.detect_level, "full");
  assert.equal(a.creator, A.w17);
  assert.equal(Number(a.creator_agent), 17);
  assert.equal(Number(a.deploy_block), 100);
  assert.equal(Number(a.detected_block), 100);
  assert.equal(Number(a.is_nft), 0);
  assert.equal(Number(a.is_multi_token), 0);
  assert.equal(Number(a.zero_only), 0);

  // bytes32 形状的 name/symbol 也必须认出来（老代币就是这么写的）
  const b = db.prepare("SELECT * FROM tokens WHERE address = ?").get(A.tokenB);
  assert.equal(b.symbol, "BACX");
  assert.equal(b.name, "BAC X");
  assert.equal(Number(b.decimals), 6);
  assert.equal(Number(b.creator_agent), 21);

  // contract_probes 记下了结论
  assert.equal(db.prepare("SELECT state FROM contract_probes WHERE address = ?").get(A.tokenA).state, "token");
  // DETECTED 审计线索
  const ev = db.prepare("SELECT * FROM token_events WHERE address = ? ORDER BY id").all(A.tokenA);
  assert.equal(ev[0].kind, "DETECTED");
});

test("§7.4：认不出来的合约写 not_token，照实计入「未识别」，绝不静默丢掉", async () => {
  const { db } = await scenario();
  assert.equal(db.prepare("SELECT state FROM contract_probes WHERE address = ?").get(A.plain).state, "not_token");
  // 它没有进代币表，但 contracts 表里还在，而且被调用过
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tokens WHERE address = ?").get(A.plain).c, 0);
  const c = db.prepare("SELECT * FROM contracts WHERE address = ?").get(A.plain);
  assert.equal(Number(c.call_count), 1);
  // 它发的那条 Transfer 不会被当成代币流水
  assert.equal(db.prepare("SELECT COUNT(*) c FROM token_transfers WHERE token = ?").get(A.plain).c, 0);
});

test("§7.2：工厂与交易对都被认出来，creator 走建池交易的 tx.from", async () => {
  const { db, tx } = await scenario();
  const f = db.prepare("SELECT * FROM amm_factories WHERE address = ?").get(A.factory);
  assert.equal(f.kind, "v2");
  assert.equal(Number(f.creator_agent), 21);
  assert.equal(Number(f.pair_count), 1);

  const p = db.prepare("SELECT * FROM pairs WHERE address = ?").get(A.pair);
  assert.equal(p.kind, "v2");
  assert.equal(p.discovered_via, "factory");
  assert.equal(p.factory, A.factory);
  assert.equal(p.token0, A.tokenA);
  assert.equal(p.token1, A.tokenB);
  assert.equal(p.detect_level, "full");
  assert.equal(p.reserve_source, "getReserves");
  // §7.2.4：CREATE2 出来的池子收据里没有 contractAddress，归属取调 createPair 的那个 agent
  assert.equal(Number(p.creator_agent), 21);
  assert.equal(p.deploy_tx, tx.createPair);
  // Sync 把储备推到了最后一笔
  assert.equal(p.reserve0, e18(101000).toString());
  assert.equal(p.reserve1, e6(198020).toString());
  assert.equal(Number(p.reserve_block), 106);
  // 两边代币各记了一个交易对
  assert.equal(Number(db.prepare("SELECT pair_count FROM tokens WHERE address = ?").get(A.tokenA).pair_count), 1);
  assert.equal(Number(db.prepare("SELECT pair_count FROM tokens WHERE address = ?").get(A.tokenB).pair_count), 1);
});

test("§7.1：探测必须便宜 —— 每个合约的 eth_call 次数有上限，且不重复探已定论的地址", async () => {
  const { rpc } = await scenario();
  // 代币自身的探测是 6 次：getCode + totalSupply + balanceOf + name + symbol + decimals。
  // 再加交易对确认时对两边代币各打的一次 eth_getCode（P1/P2），全程一共 7 次，一次不多。
  assert.equal(rpc.countFor(A.tokenA), 7);
  assert.equal(rpc.countFor(A.tokenB), 7);
  // 认不出来的那个：getCode + totalSupply 就结束了，不会继续问 name/symbol
  assert.equal(rpc.countFor(A.plain), 2);
  // 交易对：getCode(pair) + token0 + token1 + getCode(t0) + getCode(t1) + getReserves + factory
  assert.ok(rpc.countFor(A.pair) <= 8, `交易对探测打了 ${rpc.countFor(A.pair)} 次 RPC，超出预算`);
});

// ===================== 持有量 =====================

test("§7.1.7：持有量按 Transfer 累加，铸/销分开记，销毁地址不计入持有人数", async () => {
  const { db } = await scenario();
  const bal = (holder) => {
    const r = db.prepare("SELECT balance FROM token_balances WHERE token = ? AND holder = ?").get(A.tokenA, holder);
    return r ? r.balance : null;
  };
  assert.equal(bal(A.w17), e18(789000).toString()); // 100万 - 20万 - 1万 - 1000
  assert.equal(bal(A.w21), e18(100000).toString()); // 20万 - 10万（进了池子）
  assert.equal(bal(A.w30), e18(9000).toString()); // 1万 - 1000（换出去了）
  assert.equal(bal(A.pair), e18(101000).toString()); // 10万 + 1000
  assert.equal(bal(A.dead), e18(1000).toString()); // 烧掉的那 1000 有余额行
  assert.equal(bal(A.zero), null, "零地址不建余额行 —— 它是铸销的源与汇，不是持有人");

  const t = db.prepare("SELECT * FROM tokens WHERE address = ?").get(A.tokenA);
  assert.equal(Number(t.holders), 4, "w17 / w21 / w30 / pair 四个；0x…dEaD 不计入");
  assert.equal(Number(t.transfers), 6);
  assert.equal(Number(t.mints), 1);
  assert.equal(Number(t.burns), 1);
  assert.equal(t.burned_amount, e18(1000).toString());

  // 推导余额之和必须等于 totalSupply（这个代币的转账是守恒的）
  const sum = db.prepare("SELECT balance FROM token_balances WHERE token = ?").all(A.tokenA)
    .reduce((a, r) => a + BigInt(r.balance), 0n);
  assert.equal(sum.toString(), e18(1000000).toString());

  // in/out 的流水账
  const w30 = db.prepare("SELECT * FROM token_balances WHERE token = ? AND holder = ?").get(A.tokenA, A.w30);
  assert.equal(w30.in_total, e18(10000).toString());
  assert.equal(w30.out_total, e18(1000).toString());
  assert.equal(Number(w30.tx_count), 2);
  assert.equal(Number(w30.agent_id), 30);

  // kind 分类
  const kinds = db.prepare("SELECT kind, COUNT(*) c FROM token_transfers WHERE token = ? GROUP BY kind").all(A.tokenA);
  assert.deepEqual(
    Object.fromEntries(kinds.map((k) => [k.kind, Number(k.c)])),
    { mint: 1, burn: 1, transfer: 4 }
  );
});

// ===================== 成交归一化 =====================

test("§7.3：V2 成交归一化 + 定点价格 + 成交量，agent 取 tx.from 不取 sender", async () => {
  const { db, tx } = await scenario();
  const sw = db.prepare("SELECT * FROM swaps").all();
  assert.equal(sw.length, 1);
  const s = sw[0];
  assert.equal(s.pair, A.pair);
  assert.equal(s.kind, "v2");
  assert.equal(Number(s.block), 106);
  assert.equal(s.side, "sell0", "amount0In > 0 -> token0 进池子");
  assert.equal(s.token_in, A.tokenA);
  assert.equal(s.amount_in, e18(1000).toString());
  assert.equal(s.token_out, A.tokenB);
  assert.equal(s.amount_out, e6(1980).toString());
  assert.equal(Number(s.normalized), 1);
  assert.equal(s.amt0, e18(1000).toString());
  assert.equal(s.amt1, e6(1980).toString());
  // price_1_per_0 = amt1 * 10^(18+dec0) / (amt0 * 10^dec1)，含义是 ×10^-18
  assert.equal(s.price_1_per_0, "1980000000000000000");
  // 归属：tx.from（agent #30），不是事件里的 sender
  assert.equal(Number(s.agent_id), 30);
  assert.equal(s.tx_from, A.w30);
  assert.equal(s.sender, A.w30);
  assert.equal(s.recipient, A.w30);
  assert.equal(s.tx, tx.swap);

  const p = db.prepare("SELECT * FROM pairs WHERE address = ?").get(A.pair);
  assert.equal(Number(p.swap_count), 1);
  assert.equal(p.vol0, e18(1000).toString());
  assert.equal(p.vol1, e6(1980).toString());
  assert.equal(Number(p.vol_skipped), 0);
  assert.equal(Number(p.mint_count), 1);
  assert.equal(Number(p.burn_count), 0);
  assert.equal(p.last_price, "1980000000000000000");

  // 流动性事件
  const liq = db.prepare("SELECT * FROM liquidity_events").all();
  assert.equal(liq.length, 1);
  assert.equal(liq[0].kind, "add");
  assert.equal(liq[0].amount0, e18(100000).toString());
  assert.equal(Number(liq[0].agent_id), 21);
});

test("§7.3：形状不标准的成交照样入库，只是 normalized = 0、四个字段为 NULL", () => {
  // 两边都有 In：V2 的实现里这是不可能的形状，但事件谁都能发。删掉它等于假装它没发生。
  const bad = normalizeSwap(
    { kind: "v2", amount0In: 5n, amount1In: 7n, amount0Out: 0n, amount1Out: 0n },
    { decimals0: 18, decimals1: 18, token0: A.tokenA, token1: A.tokenB }
  );
  assert.equal(bad.normalized, 0);
  assert.equal(bad.side, "unknown");
  assert.equal(bad.tokenIn, null);
  assert.equal(bad.amountIn, null);
  assert.equal(bad.tokenOut, null);
  assert.equal(bad.amountOut, null);
  assert.equal(bad.amt0, "5", "amt0 / amt1 仍按绝对值记，供量能统计");
  assert.equal(bad.amt1, "7");

  // 两边都为 0
  const zero = normalizeSwap(
    { kind: "v2", amount0In: 0n, amount1In: 0n, amount0Out: 0n, amount1Out: 0n },
    { decimals0: 18, decimals1: 18, token0: A.tokenA, token1: A.tokenB }
  );
  assert.equal(zero.normalized, 0);
  assert.equal(zero.price1Per0, null, "amt0 == 0 时价格算不出来，写 NULL 不写 0");

  // V3：符号成对才算标准
  const v3 = normalizeSwap(
    { kind: "v3", amount0: 1000n, amount1: -1980n },
    { decimals0: 18, decimals1: 18, token0: A.tokenA, token1: A.tokenB }
  );
  assert.equal(v3.normalized, 1);
  assert.equal(v3.side, "sell0");
  assert.equal(v3.amountIn, "1000");
  assert.equal(v3.amountOut, "1980");
  const v3buy = normalizeSwap(
    { kind: "v3", amount0: -500n, amount1: 990n },
    { decimals0: 18, decimals1: 18, token0: A.tokenA, token1: A.tokenB }
  );
  assert.equal(v3buy.side, "buy0");
  assert.equal(v3buy.tokenIn, A.tokenB);
  const v3bad = normalizeSwap(
    { kind: "v3", amount0: 100n, amount1: 200n },
    { decimals0: 18, decimals1: 18, token0: A.tokenA, token1: A.tokenB }
  );
  assert.equal(v3bad.normalized, 0, "同号不成对 -> 形状不标准");
});

test("§7.3：decimals 未知时价格一律 NULL，不许默认当 18", () => {
  assert.equal(price1Per0(e18(1000), e6(1980), 18, 6), "1980000000000000000");
  assert.equal(price1Per0(e18(1000), e6(1980), null, 6), null);
  assert.equal(price1Per0(e18(1000), e6(1980), 18, null), null);
  assert.equal(price1Per0(0n, e6(1980), 18, 6), null);
});

// ===================== 幂等 =====================

test("§7.5.1：重启后重放同一批区块，行数与所有计数器一个都不变", async () => {
  const { db, rpc, tx } = await scenario();
  const snap = () => ({
    tokens: db.prepare("SELECT * FROM tokens ORDER BY address").all(),
    balances: db.prepare("SELECT * FROM token_balances ORDER BY token, holder").all(),
    pairs: db.prepare("SELECT * FROM pairs ORDER BY address").all(),
    factories: db.prepare("SELECT * FROM amm_factories ORDER BY address").all(),
    transfers: Number(db.prepare("SELECT COUNT(*) c FROM token_transfers").get().c),
    swaps: db.prepare("SELECT * FROM swaps ORDER BY tx, log_index").all(),
    liq: Number(db.prepare("SELECT COUNT(*) c FROM liquidity_events").get().c),
    feed: db.prepare("SELECT kind, text_zh FROM feed ORDER BY id").all(),
  });
  const before = snap();

  // 重放：同样的 txHash、同样的 logIndex —— 这才是重启的样子
  const replayDb = db;
  const xfer = (token, from, to, value, o) =>
    mkBuiltLog("erc20", "Transfer", { from, to, value }, { address: token, ...o });
  await ingestBlock(replayDb, rpc, {
    number: 104, ts: T + 12,
    txs: [{ hash: tx.spread, from: A.w17, to: A.tokenA }],
    logs: [
      xfer(A.tokenA, A.w17, A.w21, e18(200000), { blockNumber: 104, logIndex: 0, txHash: tx.spread }),
      xfer(A.tokenA, A.w17, A.w30, e18(10000), { blockNumber: 104, logIndex: 1, txHash: tx.spread }),
    ],
  });
  await ingestBlock(replayDb, rpc, {
    number: 106, ts: T + 18,
    txs: [{ hash: tx.swap, from: A.w30, to: A.pair }],
    logs: [
      xfer(A.tokenA, A.w30, A.pair, e18(1000), { blockNumber: 106, logIndex: 0, txHash: tx.swap }),
      xfer(A.tokenB, A.pair, A.w30, e6(1980), { blockNumber: 106, logIndex: 1, txHash: tx.swap }),
      mkBuiltLog("v2", "Swap", {
        sender: A.w30, amount0In: e18(1000), amount1In: 0n, amount0Out: 0n, amount1Out: e6(1980), to: A.w30,
      }, { address: A.pair, blockNumber: 106, logIndex: 2, txHash: tx.swap }),
      mkBuiltLog("v2", "Sync", { reserve0: e18(101000), reserve1: e6(198020) },
        { address: A.pair, blockNumber: 106, logIndex: 3, txHash: tx.swap }),
    ],
  });

  assert.deepEqual(snap(), before, "重放之后任何一张表、任何一个计数器都不许变");
});

// ===================== X1 / X2 / X3 / X5 / X6 =====================

test("X2：4 个 topic 的 Transfer 是 NFT 形状 —— 不进代币表；已入表的要移出并留下原因", async () => {
  resetWarnings();
  const { db } = tempDb();
  const rpc = new FakeRpc();
  // 这个合约先发标准 ERC-20 Transfer（会被判成代币），后发 721 形状的 Transfer（X2 移出）
  rpc.set(A.nft, erc20Stub({ name: "Mixed", symbol: "MIX", decimals: 18, totalSupply: 1000n }));
  const t1 = txHash("nft1");
  const t2 = txHash("nft2");
  await ingestBlock(db, rpc, {
    number: 200, ts: T,
    txs: [{ hash: t1, from: A.w17, to: null, created: A.nft }],
    logs: [mkBuiltLog("erc20", "Transfer", { from: A.zero, to: A.w17, value: 1000n },
      { address: A.nft, blockNumber: 200, logIndex: 0, txHash: t1 })],
  });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tokens WHERE address = ?").get(A.nft).c, 1);

  // ERC-721 的 Transfer：tokenId 是 indexed，所以 4 个 topic、data 为空
  await ingestBlock(db, rpc, {
    number: 201, ts: T + 3,
    txs: [{ hash: t2, from: A.w17, to: A.nft }],
    logs: [mkRawLog({
      address: A.nft,
      topics: [TOPIC.Transfer, addr32(A.w17), addr32(A.w30), u256(7)],
      data: "0x",
      blockNumber: 201, logIndex: 0, txHash: t2,
    })],
  });
  const row = db.prepare("SELECT * FROM tokens WHERE address = ?").get(A.nft);
  assert.equal(Number(row.is_nft), 1);
  assert.equal(db.prepare("SELECT state FROM contract_probes WHERE address = ?").get(A.nft).state, "nft");
  const dem = db.prepare("SELECT * FROM token_events WHERE address = ? AND kind = 'DEMOTED'").get(A.nft);
  assert.equal(dem.rule, "X2");
  assert.match(dem.detail, /X2/);
});

test("X1：ERC-1155 的 TransferSingle 不进代币表", async () => {
  const { db } = tempDb();
  const rpc = new FakeRpc();
  const addr1155 = getAddress("0x0000000000000000000000000000000000001155");
  rpc.set(addr1155, erc20Stub({ name: "Multi", symbol: "M", decimals: 0, totalSupply: 1n }));
  const t = txHash("multi1");
  await ingestBlock(db, rpc, {
    number: 300, ts: T,
    txs: [{ hash: t, from: A.w17, to: null, created: addr1155 }],
    logs: [mkRawLog({
      address: addr1155,
      topics: [TOPIC.TransferSingle, addr32(A.w17), addr32(A.zero), addr32(A.w17)],
      data: u256(1) + u256(5).slice(2),
      blockNumber: 300, logIndex: 0, txHash: t,
    })],
  });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tokens WHERE address = ?").get(addr1155).c, 0);
  assert.equal(db.prepare("SELECT state FROM contract_probes WHERE address = ?").get(addr1155).state, "multi_token");
});

test("X3：decimals 返回垃圾值时写 NULL 并降级到 partial；metadata 缺失也只降级不否决", async () => {
  const { db } = tempDb();
  const rpc = new FakeRpc();
  const junk = getAddress("0x0000000000000000000000000000000000003333");
  const bare = getAddress("0x0000000000000000000000000000000000004444");
  rpc.set(junk, erc20Stub({ name: "Junk", symbol: "JNK", decimals: 200, totalSupply: 10n }));
  rpc.set(bare, { code: "0x60", calls: { [SELECTOR.totalSupply]: u256(10), [SELECTOR.balanceOf]: u256(0) } });
  const t1 = txHash("junk1");
  const t2 = txHash("bare1");
  await ingestBlock(db, rpc, {
    number: 400, ts: T,
    txs: [{ hash: t1, from: A.w17, to: null, created: junk }, { hash: t2, from: A.w17, to: null, created: bare }],
    logs: [
      mkBuiltLog("erc20", "Transfer", { from: A.zero, to: A.w17, value: 10n },
        { address: junk, blockNumber: 400, logIndex: 0, txHash: t1 }),
      mkBuiltLog("erc20", "Transfer", { from: A.zero, to: A.w17, value: 10n },
        { address: bare, blockNumber: 400, logIndex: 1, txHash: t2 }),
    ],
  });
  const j = db.prepare("SELECT * FROM tokens WHERE address = ?").get(junk);
  assert.equal(j.decimals, null, "decimals > 77 是垃圾值");
  assert.equal(j.detect_level, "partial");
  const b = db.prepare("SELECT * FROM tokens WHERE address = ?").get(bare);
  assert.ok(b, "没有 name/symbol/decimals 的代币照样进表 —— 藏起来就等于我们替 agent 决定了什么算代币");
  assert.equal(b.detect_level, "partial");
  assert.equal(b.name, null);
  assert.equal(b.symbol, null);
});

test("X5：totalSupply 恒为 0 且 Transfer 全是 0 -> zero_only，进表但折叠", async () => {
  const { db } = tempDb();
  const rpc = new FakeRpc();
  const evt = getAddress("0x0000000000000000000000000000000000005555");
  rpc.set(evt, erc20Stub({ name: "Eventy", symbol: "EVT", decimals: 18, totalSupply: 0n }));
  const t = txHash("evt1");
  await ingestBlock(db, rpc, {
    number: 500, ts: T,
    txs: [{ hash: t, from: A.w17, to: null, created: evt }],
    logs: [mkBuiltLog("erc20", "Transfer", { from: A.w17, to: A.w30, value: 0n },
      { address: evt, blockNumber: 500, logIndex: 0, txHash: t })],
  });
  const r = db.prepare("SELECT * FROM tokens WHERE address = ?").get(evt);
  assert.equal(Number(r.zero_only), 1);
  assert.equal(Number(r.holders), 0, "余额全是 0，没有持有人");
  const ev = db.prepare("SELECT * FROM token_events WHERE address = ? AND rule = 'X5'").get(evt);
  assert.equal(ev.kind, "DEMOTED");
});

test("X6：四个创世系统合约永远不进代币 / 交易对表", async () => {
  const { db } = tempDb();
  const rpc = new FakeRpc();
  const sys = getAddress("0x0000000000000000000000000000000000000101");
  rpc.set(sys, erc20Stub({ name: "L2Bridge", symbol: "SYS", decimals: 18, totalSupply: 1n }));
  const t = txHash("sys1");
  await ingestBlock(db, rpc, {
    number: 600, ts: T,
    txs: [{ hash: t, from: A.w17, to: sys }],
    logs: [mkBuiltLog("erc20", "Transfer", { from: A.zero, to: A.w17, value: 1n },
      { address: sys, blockNumber: 600, logIndex: 0, txHash: t })],
  });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tokens").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM contract_probes").get().c, 0);
});

// ===================== 探测失败 ≠ 不是代币 =====================

test("§7.5.1 第 8 条：探测失败只加 attempts 并留在 pending，绝不写 not_token", async () => {
  resetWarnings();
  const { db } = tempDb();
  const flaky = getAddress("0x0000000000000000000000000000000000006666");
  const down = new FakeRpc({}, { fail: [flaky] });
  const t = txHash("flaky1");
  const logs = [mkBuiltLog("erc20", "Transfer", { from: A.zero, to: A.w17, value: 5n },
    { address: flaky, blockNumber: 700, logIndex: 0, txHash: t })];
  await ingestBlock(db, down, { number: 700, ts: T, txs: [{ hash: t, from: A.w17, to: null, created: flaky }], logs });

  let pr = db.prepare("SELECT * FROM contract_probes WHERE address = ?").get(flaky);
  assert.equal(pr.state, "pending", "探测失败 ≠ 不是代币");
  assert.equal(Number(pr.attempts), 1);
  assert.equal(pr.last_error, null, "连续失败不到 10 次不写 last_error");
  assert.ok(listWarnings().includes("probe_unavailable"), "探测失败必须打告警，不许静默");

  // 节点恢复之后，同一个地址在下一批里被重新探到，并且补回之前漏掉的那条 Transfer
  const up = new FakeRpc();
  up.set(flaky, erc20Stub({ name: "Flaky", symbol: "FLK", decimals: 18, totalSupply: 5n }));
  const t2 = txHash("flaky2");
  await ingestBlock(db, up, {
    number: 701, ts: T + 3,
    txs: [{ hash: t2, from: A.w17, to: flaky }],
    logs: [mkBuiltLog("erc20", "Transfer", { from: A.w17, to: A.w30, value: 2n },
      { address: flaky, blockNumber: 701, logIndex: 0, txHash: t2 })],
  });
  pr = db.prepare("SELECT * FROM contract_probes WHERE address = ?").get(flaky);
  assert.equal(pr.state, "token");
  const tk = db.prepare("SELECT * FROM tokens WHERE address = ?").get(flaky);
  assert.equal(Number(tk.transfers), 2, "被认出来之后要把之前落库的那条 Transfer 回放补上");
  assert.equal(Number(tk.mints), 1);
  const b = db.prepare("SELECT balance FROM token_balances WHERE token = ? AND holder = ?").get(flaky, A.w17);
  assert.equal(b.balance, "3");
});

// ===================== P4：顺序无关 =====================

test("§7.2.3 P4：先建池后发币也能被认出来 —— 池子先停在 waiting_token，代币出现后自动补上", async () => {
  const { db } = tempDb();
  const rpc = new FakeRpc();
  const tkC = getAddress("0x0000000000000000000000000000000000007777");
  const tkD = getAddress("0x0000000000000000000000000000000000008888");
  const poolCD = getAddress("0x0000000000000000000000000000000000009999");
  rpc.set(poolCD, v2PairStub({ token0: tkC, token1: tkD, reserve0: 10n, reserve1: 20n }));
  rpc.set(tkC, { code: "0x60", calls: {} }); // 先只有代码，还不是「已识别代币」
  rpc.set(tkD, { code: "0x60", calls: {} });

  // b800：池子先出现（路径 B：只有 Sync，没有工厂）
  const t1 = txHash("pool1");
  await ingestBlock(db, rpc, {
    number: 800, ts: T,
    txs: [{ hash: t1, from: A.w21, to: poolCD }],
    logs: [mkBuiltLog("v2", "Sync", { reserve0: 10n, reserve1: 20n },
      { address: poolCD, blockNumber: 800, logIndex: 0, txHash: t1 })],
  });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pairs").get().c, 0);
  const cand = db.prepare("SELECT * FROM pair_candidates WHERE address = ?").get(poolCD);
  assert.equal(cand.state, "waiting_token");
  assert.equal(cand.token0, tkC);
  assert.match(cand.reason, /P4/);

  // b801：其中一边现在成了代币
  rpc.set(tkC, erc20Stub({ name: "Cee", symbol: "CEE", decimals: 18, totalSupply: 100n }));
  const t2 = txHash("pool2");
  await ingestBlock(db, rpc, {
    number: 801, ts: T + 3,
    txs: [{ hash: t2, from: A.w17, to: tkC }],
    logs: [mkBuiltLog("erc20", "Transfer", { from: A.zero, to: A.w17, value: 100n },
      { address: tkC, blockNumber: 801, logIndex: 0, txHash: t2 })],
  });
  const p = db.prepare("SELECT * FROM pairs WHERE address = ?").get(poolCD);
  assert.ok(p, "一边被认出来之后，池子要自动从候选里补上来");
  assert.equal(p.discovered_via, "event");
  assert.equal(p.factory, null);
  assert.equal(p.detect_level, "partial", "只有一边是已识别代币");
  assert.equal(db.prepare("SELECT state FROM pair_candidates WHERE address = ?").get(poolCD).state, "rejected");
});

// ===================== V3 =====================

test("§7.2.3：V3 池子按 fee + slot0 确认，储备用 balanceOf 读，来源写 balanceOf", async () => {
  const { db } = tempDb();
  const rpc = new FakeRpc();
  const tkE = getAddress("0x000000000000000000000000000000000000aaa1");
  const tkF = getAddress("0x000000000000000000000000000000000000aaa2");
  const poolV3 = getAddress("0x000000000000000000000000000000000000aaa3");
  const facV3 = getAddress("0x000000000000000000000000000000000000aaa4");
  rpc.set(tkE, erc20Stub({
    name: "E", symbol: "E", decimals: 18, totalSupply: 1000n, balances: { [poolV3]: 700n },
  }));
  rpc.set(tkF, erc20Stub({
    name: "F", symbol: "F", decimals: 18, totalSupply: 2000n, balances: { [poolV3]: 1400n },
  }));
  rpc.set(poolV3, v3PoolStub({ token0: tkE, token1: tkF, feePpm: 3000, tickSpacing: 60, factory: facV3 }));

  const t1 = txHash("v3a");
  await ingestBlock(db, rpc, {
    number: 900, ts: T,
    txs: [{ hash: t1, from: A.w17, to: null, created: tkE }],
    logs: [
      mkBuiltLog("erc20", "Transfer", { from: A.zero, to: A.w17, value: 1000n },
        { address: tkE, blockNumber: 900, logIndex: 0, txHash: t1 }),
      mkBuiltLog("erc20", "Transfer", { from: A.zero, to: A.w17, value: 2000n },
        { address: tkF, blockNumber: 900, logIndex: 1, txHash: t1 }),
    ],
  });
  const t2 = txHash("v3b");
  await ingestBlock(db, rpc, {
    number: 901, ts: T + 3,
    txs: [{ hash: t2, from: A.w21, to: facV3 }],
    logs: [
      mkBuiltLog("v3", "PoolCreated",
        { token0: tkE, token1: tkF, fee: 3000n, tickSpacing: 60n, pool: poolV3 },
        { address: facV3, blockNumber: 901, logIndex: 0, txHash: t2 }),
    ],
  });
  const p = db.prepare("SELECT * FROM pairs WHERE address = ?").get(poolV3);
  assert.equal(p.kind, "v3");
  assert.equal(Number(p.fee_ppm), 3000);
  assert.equal(Number(p.tick_spacing), 60);
  assert.equal(p.reserve_source, "balanceOf", "V3 没有 getReserves，池内余额是另一个东西");
  assert.equal(p.reserve0, "700");
  assert.equal(p.reserve1, "1400");
  assert.equal(db.prepare("SELECT kind FROM amm_factories WHERE address = ?").get(facV3).kind, "v3");

  // V3 的 Swap（有符号）
  const t3 = txHash("v3c");
  await ingestBlock(db, rpc, {
    number: 902, ts: T + 6,
    txs: [{ hash: t3, from: A.w30, to: poolV3 }],
    logs: [
      mkBuiltLog("v3", "Swap", {
        sender: A.w21, recipient: A.w30, amount0: 100n, amount1: -190n,
        sqrtPriceX96: 1n, liquidity: 1n, tick: 0n,
      }, { address: poolV3, blockNumber: 902, logIndex: 0, txHash: t3 }),
    ],
  });
  const s = db.prepare("SELECT * FROM swaps WHERE pair = ?").get(poolV3);
  assert.equal(s.side, "sell0");
  assert.equal(s.amount_in, "100");
  assert.equal(s.amount_out, "190");
  assert.equal(s.agent_id, null, "tx.from 不是已注册 agent 的钱包时 agent_id 是 NULL，不猜");
  assert.equal(s.sender, A.w21, "事件里的 sender 原样入库（通常是 router）");
  assert.equal(s.tx_from, A.w30, "归属取 tx.from");
});

// ===================== 刷新作业 =====================

test("§7.1.7：刷新作业重读 totalSupply，并用 balanceOf 对前 20 个持有者对拍出 balance_drift", async () => {
  const { db, rpc } = await scenario();
  assert.equal(Number(db.prepare("SELECT supply_stale FROM tokens WHERE address = ?").get(A.tokenA).supply_stale), 1);

  // 桩里登记每个持有者的真实 balanceOf，与推导余额一致 -> 不漂移
  rpc.set(A.tokenA, erc20Stub({
    name: "Agent Fuel", symbol: "FUEL", decimals: 18, totalSupply: e18(1000000),
    balances: {
      [A.w17]: e18(789000), [A.w21]: e18(100000), [A.w30]: e18(9000),
      [A.pair]: e18(101000), [A.dead]: e18(1000),
    },
  }));
  await refreshStaleTokens(db, { rpc, now: T + 100 });
  let a = db.prepare("SELECT * FROM tokens WHERE address = ?").get(A.tokenA);
  assert.equal(Number(a.supply_stale), 0);
  assert.equal(Number(a.balance_drift), 0);
  assert.equal(Number(a.drift_checked_at), T + 100);

  // 换成一个「收税代币」：链上 balanceOf 和按 Transfer 推出来的对不上 -> 必须置 balance_drift
  db.prepare("UPDATE tokens SET supply_stale = 1 WHERE address = ?").run(A.tokenA);
  rpc.set(A.tokenA, erc20Stub({
    name: "Agent Fuel", symbol: "FUEL", decimals: 18, totalSupply: e18(1000000),
    balances: { [A.w17]: e18(700000), [A.pair]: e18(101000), [A.w21]: e18(100000), [A.w30]: e18(9000), [A.dead]: e18(1000) },
  }));
  await refreshStaleTokens(db, { rpc, now: T + 200 });
  a = db.prepare("SELECT * FROM tokens WHERE address = ?").get(A.tokenA);
  assert.equal(Number(a.balance_drift), 1, "转账不守恒（收税 / rebase）时必须照实说对不上");
});

// ===================== feed =====================

test("§7.7：TOKEN_NEW / PAIR_NEW / TOKEN_FIRST_TRADE 进 feed；成交本身不进 feed", async () => {
  const { db } = await scenario();
  const kinds = db.prepare("SELECT kind, text_zh FROM feed WHERE kind LIKE 'TOKEN%' OR kind LIKE 'PAIR%'").all();
  const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.text_zh]));
  assert.ok(byKind.TOKEN_NEW);
  assert.match(byKind.TOKEN_NEW, /agent #(17|21) 发了一个代币 (FUEL|BACX)/);
  assert.ok(byKind.PAIR_NEW);
  assert.match(byKind.PAIR_NEW, /agent #21 建了一个交易对 FUEL\/BACX/);
  assert.ok(byKind.TOKEN_FIRST_TRADE);
  assert.match(byKind.TOKEN_FIRST_TRADE, /有了第一笔成交/);
  // 每个代币只进一次 TOKEN_NEW
  assert.equal(db.prepare("SELECT COUNT(*) c FROM feed WHERE kind = 'TOKEN_NEW'").get().c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM feed WHERE kind = 'PAIR_NEW'").get().c, 1);
  // 成交不进 feed（刻意的取舍：feed 是「发生了什么大事」，不是流水）
  assert.equal(db.prepare("SELECT COUNT(*) c FROM feed WHERE kind = 'SWAP'").get().c, 0);
});

// ===================== 文本清洗与返回值解码 =====================

test("X4：不可信文本截断 128 字节、非 UTF-8 换 U+FFFD、去控制字符、裁空白", () => {
  assert.equal(sanitizeText(Buffer.from("  hi  ")), "hi");
  assert.equal(sanitizeText(Buffer.from("a\u0000b\u0007c")), "abc");
  // 双向控制符（RLO 能把 "USDT" 之类的名字倒着显示）与零宽空格也去掉；C1 控制字符同样
  const RLO = String.fromCharCode(0x202e);
  const ZWSP = String.fromCharCode(0x200b);
  const C1 = String.fromCharCode(0x9b);
  assert.equal(sanitizeText(Buffer.from("US" + RLO + "DT" + ZWSP + C1)), "USDT");
  assert.equal(sanitizeText(Buffer.from("x".repeat(300))).length, 128);
  assert.ok(sanitizeText(Buffer.from([0xff, 0xfe, 0x41])).includes("A"));
  assert.ok(sanitizeText(Buffer.from([0xff, 0xfe, 0x41])).includes("�"));
});

test("返回值解码：长度不对就是 null，不许猜", () => {
  assert.equal(decodeUint256(u256(42)), 42n);
  assert.equal(decodeUint256("0x2a"), null, "不是 32 字节 -> null（N3 的判据）");
  assert.equal(decodeUint256("0x"), null);
  assert.equal(decodeAddress(addr32(A.w17)), A.w17);
  assert.equal(decodeAddress("0x" + "ff".repeat(32)), null, "高 12 字节不是 0 就不是一个干净的 address 返回值");
  assert.equal(decodeStringReturn(abiStr("FUEL")), "FUEL");
  assert.equal(decodeStringReturn(bytes32Str("BACX")), "BACX");
  assert.equal(decodeStringReturn("0x"), null);
});
