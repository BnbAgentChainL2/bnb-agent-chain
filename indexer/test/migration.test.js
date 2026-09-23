// test/migration.test.js —— 迁移测试。
// 断言 03 §2 的每一张表、每一个列名都在，且迁移是幂等的。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaVersion, migrate, openDb, MIGRATIONS_DIR } from "../src/db.js";
import { tempDb, cleanupTempDbs } from "./helpers.js";

test.after(cleanupTempDbs);

/** 03 §2 逐字抄下来的表与列。改这里就等于改契约。 */
const SPEC_TABLES = {
  cursor: ["chain", "last_block", "updated_at"],
  blocks: ["number", "hash", "parent_hash", "ts", "tx_count", "gas_used", "gas_limit", "base_fee", "epoch"],
  txs: ["hash", "block", "idx", "from_addr", "to_addr", "value", "gas_used", "eff_gas_price", "fee_burned", "created", "status", "agent_id", "ts"],
  contracts: ["address", "deployer", "agent_id", "tx", "block", "ts", "code_size", "call_count", "last_call"],
  actions: ["seq", "agent_id", "actor", "kind", "kind_hash", "subject", "content_hash", "summary", "uri", "block", "tx", "epoch", "ts"],
  agents: ["agent_id", "controller", "wallet", "agent_uri", "endpoint_hash", "model_fp", "status", "registered_at", "activated_at", "solved", "last_hb_epoch", "missed", "credited", "exited", "deploys", "announces", "last_layer_tx"],
  deposits: ["deposit_id", "layer_key", "agent_id", "from_addr", "layer_wallet", "measured", "credits", "bsc_block", "bsc_tx", "layer_block", "layer_tx", "lag_sec"],
  exits: ["exit_id", "agent_id", "to_addr", "credits", "born_epoch", "anchor_epoch", "layer_tx", "layer_block", "claimed_tx", "claimed_at", "locked_wei", "collected_wei"],
  epochs: ["epoch", "state", "exit_root", "l2_block", "l2_block_hash", "credited", "exit_credits", "fee_burned", "circulating", "exit_count", "posted_at", "posted_tx", "finalized_at", "agreeing_count", "agreeing_wt", "disputing_wt", "release_bps", "pot", "rate", "settled_at", "reward_pot",
    // 决策 #17（03 §2 新增）
    "proposer_income_root", "gas_fees", "gas_remitted", "gas_gap", "pool_accrued", "pool_claimed",
    "foundation_accrued", "weight_total", "weights_set_at", "member_count"],
  // 决策 #17 新增的三张表
  proposer_income: ["epoch", "proposer", "gas_income", "remitted", "gap", "blocks", "official", "validator", "anchored"],
  pool_claims: ["epoch", "member", "validator", "weight", "amount", "to_addr", "layer_tx", "ts"],
  remittance: ["validator", "proposer_addr", "cum_owed", "cum_remitted", "arrears", "shortfall", "withheld", "rights", "qualify_streak", "last_epoch"],
  attestations: ["epoch", "validator", "node_id", "committed_tx", "revealed_tx", "exit_root", "l2_block", "l2_block_hash", "weight", "agreeing"],
  treasury: ["ts", "bsc_block", "vault_balance", "vault_accounted", "vault_unsplit", "lifetime_to_bridge", "lifetime_to_node", "pool_balance", "node_fund_balance", "node_fund_withdrawn", "total_locked", "total_issued", "total_exited", "reward_balance", "reward_funded", "reward_paid", "market_address_ok",
    // 决策 #17（03 §2 新增）
    "splitter_balance", "splitter_pool_pending", "splitter_foundation", "lifetime_official_gross",
    "lifetime_validator_remitted", "lifetime_pool", "lifetime_pool_claimed", "lifetime_foundation_withdrawn"],
  feed: ["id", "chain", "kind", "ts", "block", "agent_id", "text_zh", "tx", "anchored", "epoch"],
  // ===== 决策 #19（03 §7.5）：agent 造出来的东西 =====
  contract_probes: ["address", "state", "probe_block", "probed_at", "attempts", "last_error", "first_seen_block", "first_seen_ts"],
  tokens: ["address", "name", "symbol", "decimals", "total_supply", "supply_block", "supply_stale", "creator", "creator_agent",
    "deploy_tx", "deploy_block", "deploy_ts", "detect_level", "detected_block", "holders", "transfers", "mints", "burns",
    "burned_amount", "pair_count", "swap_count", "first_block", "first_ts", "last_block", "last_ts", "zero_only",
    "is_nft", "is_multi_token", "balance_drift", "drift_checked_at"],
  token_transfers: ["tx", "log_index", "token", "block", "ts", "from_addr", "to_addr", "from_agent", "to_agent", "value", "kind"],
  token_balances: ["token", "holder", "balance", "balance_sort", "in_total", "out_total", "tx_count", "agent_id", "first_ts", "last_ts"],
  token_events: ["id", "address", "kind", "rule", "detail", "block", "ts"],
  amm_factories: ["address", "kind", "creator", "creator_agent", "deploy_tx", "deploy_block", "deploy_ts", "pair_count", "first_ts", "last_ts"],
  pair_candidates: ["address", "kind", "token0", "token1", "factory", "state", "reason", "seen_block", "seen_ts", "retried_at"],
  pairs: ["address", "kind", "factory", "discovered_via", "token0", "token1", "fee_ppm", "tick_spacing", "creator", "creator_agent",
    "deploy_tx", "deploy_block", "deploy_ts", "reserve0", "reserve1", "reserve_source", "reserve_block", "swap_count",
    "vol0", "vol1", "vol_skipped", "mint_count", "burn_count", "last_price", "last_price_block",
    "first_block", "first_ts", "last_block", "last_ts", "detect_level"],
  swaps: ["tx", "log_index", "pair", "kind", "block", "ts", "epoch", "agent_id", "tx_from", "sender", "recipient",
    "token_in", "amount_in", "token_out", "amount_out", "side", "amt0", "amt1", "price_1_per_0", "normalized"],
  liquidity_events: ["tx", "log_index", "pair", "block", "ts", "agent_id", "tx_from", "kind", "amount0", "amount1"],
};

const SPEC_INDEXES = [
  "proposer_income_proposer",
  // 决策 #19（03 §7.5）
  "contract_probes_state",
  "tokens_creator", "tokens_new", "tokens_holders", "tokens_activity", "tokens_symbol",
  "token_transfers_token", "token_transfers_from", "token_transfers_to", "token_transfers_agent",
  "token_balances_holder", "token_balances_top",
  "token_events_addr",
  "pairs_token0", "pairs_token1", "pairs_creator", "pairs_new", "pairs_swaps",
  "swaps_pair", "swaps_block", "swaps_agent", "swaps_in", "swaps_out",
  "liquidity_events_pair",
  // 003 给补充表 logs 加的按地址回放索引（§7.2.3 的「顺序无关」靠它）
  "logs_address",
  "blocks_epoch",
  "txs_block",
  "txs_from",
  "txs_agent",
  "contracts_agent",
  "actions_agent",
  "actions_kind",
  "agents_status",
  "exits_epoch",
  "exits_agent",
  "feed_id",
  "feed_agent",
];

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name);
}

test("迁移把 schema 版本推到 3（001 建表 + 002 决策 #17 + 003 决策 #19）", () => {
  const { db } = tempDb();
  assert.equal(schemaVersion(db), 3);
});

test("03 §2 的每一张表都存在，且列名逐字一致", () => {
  const { db } = tempDb();
  for (const [table, cols] of Object.entries(SPEC_TABLES)) {
    const actual = columnsOf(db, table);
    assert.ok(actual.length > 0, `表 ${table} 不存在`);
    for (const c of cols) {
      assert.ok(actual.includes(c), `表 ${table} 缺列 ${c}`);
    }
    // 不许多出 §2 里没有的列（补充表单独列在下面的用例里）
    const extra = actual.filter((c) => !cols.includes(c));
    assert.deepEqual(extra, [], `表 ${table} 多出了 §2 没有的列：${extra.join(",")}`);
  }
});

test("03 §2 的每一个索引都存在", () => {
  const { db } = tempDb();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((r) => r.name);
  for (const i of SPEC_INDEXES) assert.ok(names.includes(i), `缺索引 ${i}`);
});

test("§2 之外只多出四张补充表，且都有说明", () => {
  const { db } = tempDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .sort();
  const extra = tables.filter((t) => !(t in SPEC_TABLES)).sort();
  assert.deepEqual(extra, ["decoded_events", "feed_key", "logs", "schema_migrations"]);
});

test("重复迁移是幂等的：第二次不应用任何文件，也不改变版本", () => {
  const { db } = tempDb();
  const applied = migrate(db);
  assert.deepEqual(applied, []);
  assert.equal(schemaVersion(db), 3);
});

test("feed.id 是自增主键，anchored 默认 0", () => {
  const { db } = tempDb();
  db.prepare(
    "INSERT INTO feed (chain, kind, ts, block, agent_id, text_zh, tx) VALUES ('layer','NOTE',1,1,1,'x','0x1')"
  ).run();
  const row = db.prepare("SELECT id, anchored FROM feed").get();
  assert.equal(Number(row.id), 1);
  assert.equal(Number(row.anchored), 0);
});

test("003 是纯加法：已经跑到 002 的旧库能原地升到 003，旧表旧行一个都不动", () => {
  // 先造一个只有 001 + 002 的库（模拟线上已经在跑的那个 index.db）
  const dir = mkdtempSync(join(tmpdir(), "bac-mig-"));
  for (const f of ["001_init.sql", "002_fee_split.sql"]) {
    copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  }
  const dbDir = mkdtempSync(join(tmpdir(), "bac-mig-db-"));
  const db = openDb(join(dbDir, "old.db"), { migrationsDir: dir });
  assert.equal(schemaVersion(db), 2);
  db.prepare(
    "INSERT INTO contracts (address, deployer, agent_id, tx, block, ts, code_size) VALUES ('0xA','0xB',7,'0xC',1,2,3)"
  ).run();

  // 再用真正的 migrations 目录升级
  const applied = migrate(db, MIGRATIONS_DIR);
  assert.deepEqual(applied, ["003_agent_built.sql"]);
  assert.equal(schemaVersion(db), 3);
  const row = db.prepare("SELECT * FROM contracts WHERE address = '0xA'").get();
  assert.equal(Number(row.agent_id), 7, "旧行不许被回填或改写");
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM tokens").get().c), 0);
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // Windows 上 WAL 偶尔还被占着，删不掉就算了
  }
});
