-- 004_bsc_v2.sql —— BSC 侧 v2 架构（决策 #29 / #30 / #31 / #32 / #33 / #35）。
--
-- v2 删掉了 BacVaultFactory / BacTreasuryVault / AgentRegistry：
--   * 税收路径：Flap TaxProcessor → BacTaxRouter（无 owner、不可升级）→ 50/50 推给 BacBridge 与 BacNodeFund；
--   * 桥：BacBridge 变成 UUPS 代理，owner（部署钱包）可以随时升级、随时取走桥池全部资金；
--   * 入场：持有 ERC-8004 身份（BSC 注册表 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432）+ BacBridge.lock()。
--     没有状态机了（CHALLENGED / ACTIVE / DORMANT / BANNED / RETIRED 全部没有来源）。
--
-- 纪律：001–003 已经在线上跑过，文件一个字都不改；别的表只做「改名 + 加列 + 加表 + 加索引」。
-- 唯一的例外是 treasury：它的旧行没有一行是测量值（见下），整张表重建。

-- ============ treasury：丢掉全部旧行，按 v2 重建 ============
-- 001–003 时代的快照只要读得到 BSC 块号就每 30 秒写一行，没部署的合约一律写 "0"（`?? "0"`）。
-- 而 BSC 上从来没有部署过我们的任何合约 —— 线上 /api/treasury 的 753 行全是 "0"，没有一行是真读数。
-- 留着它们，stage = 'none' 时 /api/summary、/api/rate、/api/treasury 就会把这串 0 当成测量值发出去，
-- 部署之后这些 0 还会一直混在历史曲线里。所以整张表丢掉重建（不是 DELETE 了事）：
--   * 列改成可空：NULL = 这一轮没读到 / 那个合约还没部署；"0" 只表示链上真的读到了 0；
--   * vault_* 改名 router_*（金库合约没了，这三列记 BacTaxRouter 的 balance / accountedQuote() / unsplitRevenue()）；
--   * 加上 v2 桥的几列。
-- v2 的快照只在至少一个我们的合约已经部署时才写行（src/snapshot.js），所以重建后的每一行都是部署后的读数。
--
-- **旧行是删掉，不是改名保留**：升级之后 treasury 里没有任何 v1 的历史，也没有 treasury_v1 之类的备份表。
-- 这只在旧行全是占位的 "0" 时才成立，所以先核一遍：只要有一行的任何一列不是 "0"（或 market_address_ok 不是 0），
-- 下面这个 CHECK 就失败，整个迁移回滚（src/db.js 的 migrate 包在一个事务里），索引器拒绝启动 ——
-- 宁可停，不可把一行真读数悄悄删掉。遇到这种情况：先把 treasury 导出来（sqlite3 index.db ".mode csv" "SELECT * FROM treasury"），
-- 人工确认之后再手工 DROP，然后重启。
CREATE TEMP TABLE m004_treasury_guard (
  nonzero_rows INTEGER NOT NULL,
  CONSTRAINT "004 refuses to drop treasury: it has rows with non-zero values; export them first, see migrations/004_bsc_v2.sql"
    CHECK (nonzero_rows = 0)
);
INSERT INTO m004_treasury_guard (nonzero_rows)
  SELECT COUNT(*) FROM treasury
   WHERE vault_balance <> '0' OR vault_accounted <> '0' OR vault_unsplit <> '0'
      OR lifetime_to_bridge <> '0' OR lifetime_to_node <> '0' OR pool_balance <> '0'
      OR node_fund_balance <> '0' OR node_fund_withdrawn <> '0' OR total_locked <> '0'
      OR total_issued <> '0' OR total_exited <> '0' OR reward_balance <> '0'
      OR reward_funded <> '0' OR reward_paid <> '0' OR market_address_ok <> 0
      OR splitter_balance <> '0' OR splitter_pool_pending <> '0' OR splitter_foundation <> '0'
      OR lifetime_official_gross <> '0' OR lifetime_validator_remitted <> '0' OR lifetime_pool <> '0'
      OR lifetime_pool_claimed <> '0' OR lifetime_foundation_withdrawn <> '0';
DROP TABLE m004_treasury_guard;
DROP TABLE treasury;
CREATE TABLE treasury (  -- BacTaxRouter / 桥池 / 节点基金的时间序列快照，每次 refresh 一行（部署之后才有）
  ts                            INTEGER PRIMARY KEY,
  bsc_block                     INTEGER NOT NULL,
  router_balance                TEXT,     -- BacTaxRouter 地址上的 BNB
  router_accounted              TEXT,     -- accountedQuote()
  router_unsplit                TEXT,     -- unsplitRevenue()
  router_stuck_bridge           TEXT,     -- stuckAmounts()[0]：推给桥失败、等 retryPush() 的
  router_stuck_node             TEXT,     -- stuckAmounts()[1]：推给节点基金失败的
  lifetime_to_bridge            TEXT,     -- lifetimeToBridge()
  lifetime_to_node              TEXT,     -- lifetimeToNodeFund()
  pool_balance                  TEXT,     -- BacBridge.bnbBalance()：账上为回购留着的税收 BNB
  bridge_bnb_held               TEXT,     -- 桥合约地址上实际的 BNB；与上一列之差 = owner 紧急提取造成的缺口
  buyback_bac                   TEXT,     -- BacBridge.buybackBac()
  owed_total                    TEXT,     -- BacBridge.owedTotal()
  emergency_bnb_withdrawn       TEXT,
  emergency_bac_withdrawn       TEXT,
  node_fund_balance             TEXT,
  node_fund_withdrawn           TEXT,
  total_locked                  TEXT,     -- BacBridge.lockedBac()
  total_issued                  TEXT,
  total_exited                  TEXT,
  reward_balance                TEXT,
  reward_funded                 TEXT,
  reward_paid                   TEXT,
  market_address_ok             INTEGER,  -- TaxProcessor.marketAddress() == BacTaxRouter；没核对过是 NULL
  market_checked                INTEGER NOT NULL DEFAULT 0,  -- 1 = 这一行核对过 marketAddress（发射前恒为 0）
  -- 决策 #17 的 FeeSplitter 列（002 加的）。还没有任何代码读 FeeSplitter，所以它们一直是 NULL，API 照实给 null。
  splitter_balance              TEXT,
  splitter_pool_pending         TEXT,
  splitter_foundation           TEXT,
  lifetime_official_gross       TEXT,
  lifetime_validator_remitted   TEXT,
  lifetime_pool                 TEXT,
  lifetime_pool_claimed         TEXT,
  lifetime_foundation_withdrawn TEXT
);

-- ============ 纪元单位：86400 → 600（决策 #20）============
-- ChainAnchor.EPOCH = L2Bridge.EPOCH = BacBridge.EPOCH = 600，epochs 表的主键就是这个编号；
-- 旧代码按 86400 给 blocks / feed / swaps 算纪元，与 epochs 表不是一个单位（src/decode.js 的 epochOf）。
-- AgentBook.EPOCH 仍是 86400：actions.epoch 存的是它的天序号，不动。
UPDATE blocks SET epoch = CAST(ts / 600 AS INTEGER);
UPDATE swaps  SET epoch = CAST(ts / 600 AS INTEGER);
UPDATE feed   SET epoch = CAST(ts / 600 AS INTEGER) WHERE chain = 'layer';
-- 旧版的 anchored 是拿两种单位的纪元号比出来的，不可信：层内全部清零，BSC 摄入下一轮按块高
-- （层内块 ≤ 最新 FINAL 锚点的 l2Block）重新标（src/store.js 的 markAnchored）。
UPDATE feed   SET anchored = 0 WHERE chain = 'layer';

-- ============ agents：一个 agent = 一个锁过桥的 ERC-8004 身份 ============
-- 旧的 status / solved / missed / last_hb_epoch / agent_uri / endpoint_hash / model_fp 列留着不删
-- （纯加法纪律），但 v2 不再写它们：新行 status 一律写 2，只表示「已经锁过桥」。
ALTER TABLE agents ADD COLUMN first_lock_block INTEGER;

-- 哪些地址以哪个身份进过桥（BacBridge.Locked 的 layerWallet）。
-- ERC-8004 下一个身份可以从两个地址进（NFT 持有人 / 签名证明过的 agentWallet），
-- 一个地址也可以持有多个身份，所以这是多对多，不能塞进 agents.wallet 一列。
CREATE TABLE agent_wallets (
  wallet           TEXT NOT NULL,           -- EIP-55，层内收到积分的地址（= 过门禁的那个地址）
  agent_id         INTEGER NOT NULL,
  first_deposit_id INTEGER NOT NULL,        -- 这个地址以这个身份第一次锁入的 depositId
  first_bsc_block  INTEGER NOT NULL,
  first_ts         INTEGER NOT NULL,
  PRIMARY KEY (wallet, agent_id)
);
CREATE INDEX agent_wallets_agent ON agent_wallets(agent_id, first_deposit_id);

-- ERC-8004 身份的链上读数（只读锁过桥的那些 agentId，不去扫 35 万个身份）。
-- holder / agent_wallet 是注册表里的事实；token_uri 与 reg_json 是**持有人自己写的**，没有任何人核实过。
CREATE TABLE agent_identity (
  agent_id            INTEGER PRIMARY KEY,
  registry            TEXT NOT NULL,        -- 读的是哪个注册表
  exists_on_registry  INTEGER,              -- 1 = ownerOf 有值；0 = ownerOf revert（未铸造 / 已销毁）；NULL = 还没读成功过
  holder              TEXT,                 -- ownerOf(agentId)
  agent_wallet        TEXT,                 -- getMetadata(agentId, "agentWallet")，20 字节裸值；未设置为 NULL
  token_uri           TEXT,                 -- tokenURI(agentId) 原文，超长截断
  token_uri_truncated INTEGER NOT NULL DEFAULT 0,
  reg_kind            TEXT,                 -- 'data-json' | 'uri'（只有 https: / ipfs: / ar:）| 'text'（别的一切）| 'empty' | 'unparsable'
  reg_json            TEXT,                 -- 从 data: 注册文件里抽出的少数字段（JSON），只在 reg_kind='data-json' 时有
  checked_at          INTEGER,
  checked_bsc_block   INTEGER,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT
);
CREATE INDEX agent_identity_checked ON agent_identity(checked_at);

-- ============ 桥的公开时间线（决策 #29c）============
-- 升级 / 紧急提取 / owner 变更都已经落在 decoded_events 里，时间线端点按合约 + 事件名取，这个索引给它用。
CREATE INDEX decoded_contract_event ON decoded_events(contract, event, block);
