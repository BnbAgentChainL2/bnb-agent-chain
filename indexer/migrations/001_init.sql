-- 001_init.sql
-- BNB Agent Chain 索引器数据库。
-- 表名与列名逐字抄自 docs/03-INTERFACES.md §2，一个字母都不许改：
-- 改一个字段名就要同时改索引器、API、网站数据层、SDK 与它们的测试。
--
-- 本文件里只有两处是 §2 之外的补充，都标了「§2 之外的补充」：
--   1. schema_migrations —— 迁移版本表，没有它就没法判断一个 db 文件跑到第几版；
--   2. logs / decoded_events —— §3.6 的 GET /api/tx/{hash} 要求返回 logs[] 与 decoded[]，
--      而 §2 的表里没有任何地方存原始日志。离线测试不能回头去问 RPC，所以必须落库。

-- ============ 游标 ============
CREATE TABLE IF NOT EXISTS cursor (
  chain       TEXT PRIMARY KEY,        -- 'bsc' | 'layer'
  last_block  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ============ 层内链数据 ============
CREATE TABLE IF NOT EXISTS blocks (
  number      INTEGER PRIMARY KEY,
  hash        TEXT NOT NULL,
  parent_hash TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  tx_count    INTEGER NOT NULL,
  gas_used    INTEGER NOT NULL,
  gas_limit   INTEGER NOT NULL,
  base_fee    TEXT NOT NULL,           -- wei 十进制字符串
  epoch       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_epoch ON blocks(epoch);

CREATE TABLE IF NOT EXISTS txs (
  hash        TEXT PRIMARY KEY,
  block       INTEGER NOT NULL,
  idx         INTEGER NOT NULL,
  from_addr   TEXT NOT NULL,
  to_addr     TEXT,                    -- NULL = 合约部署
  value       TEXT NOT NULL,
  gas_used    INTEGER NOT NULL,
  eff_gas_price TEXT NOT NULL,
  fee_burned  TEXT NOT NULL,           -- gas_used * base_fee
  created     TEXT,                    -- 部署出来的合约地址，NULL 表示不是部署
  status      INTEGER NOT NULL,        -- 1 成功 0 失败
  agent_id    INTEGER,                 -- 由 from_addr 解析，未注册地址为 NULL
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS txs_block ON txs(block DESC, idx DESC);
CREATE INDEX IF NOT EXISTS txs_from  ON txs(from_addr, block DESC);
CREATE INDEX IF NOT EXISTS txs_agent ON txs(agent_id, block DESC);

CREATE TABLE IF NOT EXISTS contracts (
  address     TEXT PRIMARY KEY,
  deployer    TEXT NOT NULL,
  agent_id    INTEGER,
  tx          TEXT NOT NULL,
  block       INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  code_size   INTEGER NOT NULL,
  call_count  INTEGER NOT NULL DEFAULT 0,
  last_call   INTEGER                  -- 区块号
);
CREATE INDEX IF NOT EXISTS contracts_agent ON contracts(agent_id, block DESC);

CREATE TABLE IF NOT EXISTS actions (   -- AgentBook.Action 的落库
  seq          INTEGER PRIMARY KEY,
  agent_id     INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- JOIN | DEPLOY | ... 明文，不是 hash
  kind_hash    TEXT NOT NULL,
  subject      TEXT,
  content_hash TEXT NOT NULL,
  summary      TEXT NOT NULL,          -- agent 自己写的不可信文本，渲染时必须转义
  uri          TEXT NOT NULL,
  block        INTEGER NOT NULL,
  tx           TEXT NOT NULL,
  epoch        INTEGER NOT NULL,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_agent ON actions(agent_id, seq DESC);
CREATE INDEX IF NOT EXISTS actions_kind  ON actions(kind, seq DESC);

-- ============ BSC 侧 ============
CREATE TABLE IF NOT EXISTS agents (
  agent_id      INTEGER PRIMARY KEY,
  controller    TEXT NOT NULL,
  wallet        TEXT NOT NULL,
  agent_uri     TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  model_fp      TEXT NOT NULL,
  status        INTEGER NOT NULL,      -- 0..5，同 AgentRegistry.Status
  registered_at INTEGER NOT NULL,
  activated_at  INTEGER,
  solved        INTEGER NOT NULL DEFAULT 0,
  last_hb_epoch INTEGER,
  missed        INTEGER NOT NULL DEFAULT 0,
  credited      TEXT NOT NULL DEFAULT '0',   -- BacBridge.credited(agentId)
  exited        TEXT NOT NULL DEFAULT '0',   -- BacBridge.exitedCredits(agentId)
  deploys       INTEGER NOT NULL DEFAULT 0,
  announces     INTEGER NOT NULL DEFAULT 0,
  last_layer_tx INTEGER                      -- 层内区块号
);
CREATE INDEX IF NOT EXISTS agents_status ON agents(status, agent_id DESC);

CREATE TABLE IF NOT EXISTS deposits (
  deposit_id    INTEGER PRIMARY KEY,   -- BacBridge 的自增计数器
  layer_key     TEXT NOT NULL UNIQUE,  -- 中继用的 keccak depositId
  agent_id      INTEGER NOT NULL,
  from_addr     TEXT NOT NULL,
  layer_wallet  TEXT NOT NULL,
  measured      TEXT NOT NULL,
  credits       TEXT NOT NULL,
  bsc_block     INTEGER NOT NULL,
  bsc_tx        TEXT NOT NULL,
  layer_block   INTEGER,
  layer_tx      TEXT,
  lag_sec       INTEGER
);

CREATE TABLE IF NOT EXISTS exits (
  exit_id       INTEGER PRIMARY KEY,   -- 层内 L2Bridge 的自增
  agent_id      INTEGER NOT NULL,
  to_addr       TEXT NOT NULL,
  credits       TEXT NOT NULL,
  born_epoch    INTEGER NOT NULL,      -- ExitBurned 事件里的 epoch（分桶用，不进叶子哈希）
  anchor_epoch  INTEGER,               -- 最终被哪个锚点收录（被 veto 的纪元会重报，两者可以不同）
  layer_tx      TEXT NOT NULL,
  layer_block   INTEGER NOT NULL,
  claimed_tx    TEXT,                  -- BSC 上的 claimExit
  claimed_at    INTEGER,               -- 时间戳；claimExit 没有领取窗口
  locked_wei    TEXT,                  -- claimExit 当场锁定的债权
  collected_wei TEXT NOT NULL DEFAULT '0'   -- 累计已 collect 走的部分（owed 永不过期）
);
CREATE INDEX IF NOT EXISTS exits_epoch ON exits(born_epoch, exit_id);
CREATE INDEX IF NOT EXISTS exits_agent ON exits(agent_id, exit_id DESC);

CREATE TABLE IF NOT EXISTS epochs (
  epoch          INTEGER PRIMARY KEY,
  state          TEXT NOT NULL,        -- NONE | POSTED | FINAL | VETOED | DISPUTED
  exit_root      TEXT,
  l2_block       INTEGER,
  l2_block_hash  TEXT,
  credited       TEXT,
  exit_credits   TEXT,
  fee_burned     TEXT,
  circulating    TEXT,
  exit_count     INTEGER,
  posted_at      INTEGER,
  posted_tx      TEXT,
  finalized_at   INTEGER,
  agreeing_count INTEGER,
  agreeing_wt    TEXT,
  disputing_wt   TEXT,
  release_bps    INTEGER,
  pot            TEXT,
  rate           TEXT,
  settled_at     INTEGER,
  reward_pot     TEXT
);

CREATE TABLE IF NOT EXISTS attestations (
  epoch         INTEGER NOT NULL,
  validator     TEXT NOT NULL,
  node_id       TEXT,
  committed_tx  TEXT,
  revealed_tx   TEXT,
  exit_root     TEXT,
  l2_block      INTEGER,
  l2_block_hash TEXT,
  weight        TEXT,
  agreeing      INTEGER,               -- 1 同意 0 异议 NULL 未揭示
  PRIMARY KEY (epoch, validator)
);

CREATE TABLE IF NOT EXISTS treasury (  -- 金库 / 桥池 / 节点基金的时间序列快照，每次 refresh 一行
  ts                  INTEGER PRIMARY KEY,
  bsc_block           INTEGER NOT NULL,
  vault_balance       TEXT NOT NULL,
  vault_accounted     TEXT NOT NULL,
  vault_unsplit       TEXT NOT NULL,
  lifetime_to_bridge  TEXT NOT NULL,
  lifetime_to_node    TEXT NOT NULL,
  pool_balance        TEXT NOT NULL,
  node_fund_balance   TEXT NOT NULL,
  node_fund_withdrawn TEXT NOT NULL,
  total_locked        TEXT NOT NULL,
  total_issued        TEXT NOT NULL,
  total_exited        TEXT NOT NULL,
  reward_balance      TEXT NOT NULL,
  reward_funded       TEXT NOT NULL,
  reward_paid         TEXT NOT NULL,
  market_address_ok   INTEGER NOT NULL   -- TaxProcessor.marketAddress() == vault
);

CREATE TABLE IF NOT EXISTS feed (      -- 唯一一张为展示而生的表
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  chain     TEXT NOT NULL,             -- 'bsc' | 'layer'
  kind      TEXT NOT NULL,             -- 见 §4.2 的 kind 集合
  ts        INTEGER NOT NULL,
  block     INTEGER NOT NULL,
  agent_id  INTEGER,
  text_zh   TEXT NOT NULL,             -- 已经渲染好的中文句子（summary 已转义）
  tx        TEXT NOT NULL,
  anchored  INTEGER NOT NULL DEFAULT 0,-- 0 = 未锚定，网站必须标「仅来自官方节点」
  epoch     INTEGER
);
CREATE INDEX IF NOT EXISTS feed_id ON feed(id DESC);
CREATE INDEX IF NOT EXISTS feed_agent ON feed(agent_id, id DESC);

-- ============ §2 之外的补充（见文件头说明）============

-- 迁移版本表。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- feed 的幂等键。feed.id 是自增主键，重启重放同一个区块会再插一行，
-- 所以每条 feed 必须有一个稳定的去重键（chain:tx:logIndex:kind）。
-- 它不进 §2 的 feed 表，单独放这里，feed 表的列一个字都不动。
CREATE TABLE IF NOT EXISTS feed_key (
  uniq    TEXT PRIMARY KEY,
  feed_id INTEGER NOT NULL
);

-- 原始日志。GET /api/tx/{hash} 的 logs[] 直接从这里出。
-- uniq = chain:txHash:logIndex，是幂等写入的键：重启重放同一个区块不会产生第二行。
CREATE TABLE IF NOT EXISTS logs (
  uniq      TEXT PRIMARY KEY,
  chain     TEXT NOT NULL,             -- 'bsc' | 'layer'
  block     INTEGER NOT NULL,
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  address   TEXT NOT NULL,
  topics    TEXT NOT NULL,             -- JSON 数组
  data      TEXT NOT NULL,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_tx ON logs(tx, log_index);
CREATE INDEX IF NOT EXISTS logs_block ON logs(chain, block);

-- 解码结果。GET /api/tx/{hash} 的 decoded[] 从这里出；解不开的日志这里没有行，decoded 就是 null。
CREATE TABLE IF NOT EXISTS decoded_events (
  uniq      TEXT PRIMARY KEY,          -- 与 logs.uniq 同值
  chain     TEXT NOT NULL,
  block     INTEGER NOT NULL,
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  contract  TEXT NOT NULL,             -- AgentRegistry | BacBridge | ...
  event     TEXT NOT NULL,             -- Locked | ExitBurned | ...
  args      TEXT NOT NULL,             -- JSON，金额一律十进制字符串
  agent_id  INTEGER,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decoded_tx ON decoded_events(tx, log_index);
CREATE INDEX IF NOT EXISTS decoded_event ON decoded_events(event, block DESC);
