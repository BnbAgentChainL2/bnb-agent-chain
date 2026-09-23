-- 003_agent_built.sql —— 决策 #19「agent 造出来的东西」在 03-INTERFACES.md §7.5 定义的表。
-- 表名与列名逐字抄自 §7.5，一个字母都不许改：改一个字段名就要同时改索引器、API、网站数据层与它们的测试。
--
-- 纪律（§7.5.1 第 7 条）：迁移是纯加法 —— 不改名、不删列、不回填，跑在 002_fee_split.sql 之后。
-- 这里的所有代币金额都是**该代币自己的最小单位**的十进制字符串，**不是 BAC 的 wei**，
-- 不得与 BAC / BNB 的金额放进同一个合计里（§7.0 第 5 条）。

-- ============ 探测缓存：每个候选地址只探一次 ============
CREATE TABLE contract_probes (
  address          TEXT PRIMARY KEY,
  state            TEXT NOT NULL,       -- 'pending'|'token'|'pair'|'factory'|'not_token'|'multi_token'|'nft'
  probe_block      INTEGER,             -- 实际探测成功的高度（可能是 head，见 §7.1.6）
  probed_at        INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  first_seen_block INTEGER NOT NULL,
  first_seen_ts    INTEGER NOT NULL
);
CREATE INDEX contract_probes_state ON contract_probes(state, address);

-- ============ 代币 ============
CREATE TABLE tokens (
  address        TEXT PRIMARY KEY,
  name           TEXT,                  -- agent 自己写的，不可信；出库一律转义
  symbol         TEXT,
  decimals       INTEGER,               -- NULL = 没实现或返回垃圾值（X3）
  total_supply   TEXT NOT NULL DEFAULT '0',   -- 该代币最小单位的十进制字符串，**不是 BAC 的 wei**
  supply_block   INTEGER,               -- total_supply 读自哪个高度
  supply_stale   INTEGER NOT NULL DEFAULT 0,
  creator        TEXT,                  -- 部署者地址，未知为 NULL
  creator_agent  INTEGER,               -- agent_id，未注册/未知为 NULL
  deploy_tx      TEXT,
  deploy_block   INTEGER,
  deploy_ts      INTEGER,
  detect_level   TEXT NOT NULL,         -- 'full' | 'partial'
  detected_block INTEGER NOT NULL,      -- 第一次被判成代币的高度
  holders        INTEGER NOT NULL DEFAULT 0,
  transfers      INTEGER NOT NULL DEFAULT 0,
  mints          INTEGER NOT NULL DEFAULT 0,
  burns          INTEGER NOT NULL DEFAULT 0,
  burned_amount  TEXT NOT NULL DEFAULT '0',
  pair_count     INTEGER NOT NULL DEFAULT 0,
  swap_count     INTEGER NOT NULL DEFAULT 0,
  first_block    INTEGER NOT NULL,      -- 第一条 Transfer
  first_ts       INTEGER NOT NULL,
  last_block     INTEGER NOT NULL,      -- 最后一条 Transfer 或 Swap
  last_ts        INTEGER NOT NULL,
  zero_only      INTEGER NOT NULL DEFAULT 0,   -- X5
  is_nft         INTEGER NOT NULL DEFAULT 0,   -- X2（置 1 时该行同时被移出列表口径）
  is_multi_token INTEGER NOT NULL DEFAULT 0,   -- X1
  balance_drift  INTEGER NOT NULL DEFAULT 0,   -- §7.1.7：推导余额与 balanceOf 对不上
  drift_checked_at INTEGER
);
CREATE INDEX tokens_creator  ON tokens(creator_agent, deploy_block DESC);
CREATE INDEX tokens_new      ON tokens(deploy_block DESC);
CREATE INDEX tokens_holders  ON tokens(holders DESC, address);
CREATE INDEX tokens_activity ON tokens(last_block DESC);
CREATE INDEX tokens_symbol   ON tokens(symbol);

CREATE TABLE token_transfers (
  tx         TEXT NOT NULL,
  log_index  INTEGER NOT NULL,
  token      TEXT NOT NULL,
  block      INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  from_addr  TEXT NOT NULL,
  to_addr    TEXT NOT NULL,
  from_agent INTEGER,
  to_agent   INTEGER,
  value      TEXT NOT NULL,             -- 最小单位
  kind       TEXT NOT NULL,             -- 'mint' | 'burn' | 'transfer'
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX token_transfers_token ON token_transfers(token, block DESC, log_index DESC);
CREATE INDEX token_transfers_from  ON token_transfers(from_addr, block DESC);
CREATE INDEX token_transfers_to    ON token_transfers(to_addr, block DESC);
CREATE INDEX token_transfers_agent ON token_transfers(from_agent, block DESC);

CREATE TABLE token_balances (
  token        TEXT NOT NULL,
  holder       TEXT NOT NULL,
  balance      TEXT NOT NULL,           -- 最小单位；由 Transfer 推导，可能与 balanceOf 不符（§7.1.7）
  balance_sort REAL NOT NULL DEFAULT 0, -- = Number(balance)，**只用于 ORDER BY**，绝不展示、绝不进 API
  in_total     TEXT NOT NULL DEFAULT '0',
  out_total    TEXT NOT NULL DEFAULT '0',
  tx_count     INTEGER NOT NULL DEFAULT 0,
  agent_id     INTEGER,
  first_ts     INTEGER NOT NULL,
  last_ts      INTEGER NOT NULL,
  PRIMARY KEY (token, holder)
);
CREATE INDEX token_balances_holder ON token_balances(holder, token);
CREATE INDEX token_balances_top    ON token_balances(token, balance_sort DESC, holder);

CREATE TABLE token_events (             -- 降级 / 移出的审计线索，页面上要照实说
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  kind    TEXT NOT NULL,                -- 'DETECTED' | 'DEMOTED' | 'RELEVEL'
  rule    TEXT,                         -- 'X2' | 'X5' | …
  detail  TEXT,
  block   INTEGER NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE INDEX token_events_addr ON token_events(address, id DESC);

-- ============ 工厂 / 交易对 ============
CREATE TABLE amm_factories (
  address       TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,          -- 'v2' | 'v3'
  creator       TEXT,
  creator_agent INTEGER,
  deploy_tx     TEXT,
  deploy_block  INTEGER,
  deploy_ts     INTEGER,
  pair_count    INTEGER NOT NULL DEFAULT 0,
  first_ts      INTEGER NOT NULL,
  last_ts       INTEGER NOT NULL
);

CREATE TABLE pair_candidates (          -- 等两边代币被认出来的池子（§7.2.3 P4）
  address    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  token0     TEXT,
  token1     TEXT,
  factory    TEXT,
  state      TEXT NOT NULL,             -- 'waiting_token' | 'rejected'
  reason     TEXT,
  seen_block INTEGER NOT NULL,
  seen_ts    INTEGER NOT NULL,
  retried_at INTEGER
);

CREATE TABLE pairs (
  address          TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,       -- 'v2' | 'v3'
  factory          TEXT,                -- agent 部署的工厂；路径 B 下为 NULL
  discovered_via   TEXT NOT NULL,       -- 'factory' | 'event'
  token0           TEXT NOT NULL,
  token1           TEXT NOT NULL,
  fee_ppm          INTEGER,             -- V3 的 fee()，百万分之一；V2 为 NULL（V2 费率写死在代码里，读不出来）
  tick_spacing     INTEGER,
  creator          TEXT,
  creator_agent    INTEGER,
  deploy_tx        TEXT,
  deploy_block     INTEGER,
  deploy_ts        INTEGER,
  reserve0         TEXT NOT NULL DEFAULT '0',
  reserve1         TEXT NOT NULL DEFAULT '0',
  reserve_source   TEXT NOT NULL,       -- 'getReserves' | 'balanceOf'
  reserve_block    INTEGER,
  swap_count       INTEGER NOT NULL DEFAULT 0,
  vol0             TEXT NOT NULL DEFAULT '0',
  vol1             TEXT NOT NULL DEFAULT '0',
  vol_skipped      INTEGER NOT NULL DEFAULT 0,   -- normalized = 0 的成交条数
  mint_count       INTEGER NOT NULL DEFAULT 0,
  burn_count       INTEGER NOT NULL DEFAULT 0,
  last_price       TEXT,                -- price_1_per_0，×10^-18 定点
  last_price_block INTEGER,
  first_block      INTEGER NOT NULL,
  first_ts         INTEGER NOT NULL,
  last_block       INTEGER NOT NULL,
  last_ts          INTEGER NOT NULL,
  detect_level     TEXT NOT NULL        -- 'full'（两边都是已识别代币）| 'partial'（只有一边是）
);
CREATE INDEX pairs_token0  ON pairs(token0, swap_count DESC);
CREATE INDEX pairs_token1  ON pairs(token1, swap_count DESC);
CREATE INDEX pairs_creator ON pairs(creator_agent, deploy_block DESC);
CREATE INDEX pairs_new     ON pairs(deploy_block DESC);
CREATE INDEX pairs_swaps   ON pairs(swap_count DESC, address);

CREATE TABLE swaps (
  tx            TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  pair          TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- 'v2' | 'v3'
  block         INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  epoch         INTEGER NOT NULL,
  agent_id      INTEGER,                -- 来自 tx.from，不是 sender（§7.3）
  tx_from       TEXT NOT NULL,
  sender        TEXT NOT NULL,          -- 事件里的原始 sender（通常是 router 合约）
  recipient     TEXT,                   -- V2 的 to / V3 的 recipient
  token_in      TEXT,
  amount_in     TEXT,
  token_out     TEXT,
  amount_out    TEXT,
  side          TEXT NOT NULL,          -- 'sell0' | 'buy0' | 'unknown'
  amt0          TEXT NOT NULL,          -- 绝对变动量，供量能统计
  amt1          TEXT NOT NULL,
  price_1_per_0 TEXT,                   -- ×10^-18 定点十进制字符串，算不出为 NULL
  normalized    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX swaps_pair  ON swaps(pair, block DESC, log_index DESC);
CREATE INDEX swaps_block ON swaps(block DESC, log_index DESC);
CREATE INDEX swaps_agent ON swaps(agent_id, block DESC);
CREATE INDEX swaps_in    ON swaps(token_in, block DESC);
CREATE INDEX swaps_out   ON swaps(token_out, block DESC);

CREATE TABLE liquidity_events (         -- V2 / V3 的 Mint & Burn，统一成加 / 撤流动性
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  pair      TEXT NOT NULL,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  agent_id  INTEGER,
  tx_from   TEXT NOT NULL,
  kind      TEXT NOT NULL,              -- 'add' | 'remove'
  amount0   TEXT NOT NULL,
  amount1   TEXT NOT NULL,
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX liquidity_events_pair ON liquidity_events(pair, block DESC, log_index DESC);

-- §2 之外的补充：logs 表按地址回放的索引。
-- 为什么需要它：一个池子可能「先建池、后发币」，在两边代币还没被认出来之前它停在 pair_candidates 里，
-- 期间的 Swap / Sync 日志无处可落。等它被确认成交易对时，我们要按地址把已落库的原始日志回放一遍，
-- 没有这个索引就得全表扫（§7.2.3「顺序无关」那一条的实现代价）。
CREATE INDEX logs_address ON logs(address, block, log_index);
