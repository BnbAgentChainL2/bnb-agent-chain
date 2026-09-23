-- 004_bsc_v2.sql —— BSC 侧 v2 架构（决策 #29 / #30 / #31 / #32 / #33 / #35）。
--
-- v2 删掉了 BacVaultFactory / BacTreasuryVault / AgentRegistry：
--   * 税收路径：Flap TaxProcessor → BacTaxRouter（无 owner、不可升级）→ 50/50 推给 BacBridge 与 BacNodeFund；
--   * 桥：BacBridge 变成 UUPS 代理，owner（部署钱包）可以随时升级、随时取走桥池全部资金；
--   * 入场：持有 ERC-8004 身份（BSC 注册表 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432）+ BacBridge.lock()。
--     没有状态机了（CHALLENGED / ACTIVE / DORMANT / BANNED / RETIRED 全部没有来源）。
--
-- 纪律：001–003 已经在线上跑过，一个字都不改；这里只做「改名 + 加列 + 加表 + 加索引」。
-- 改名用 SQLite ≥ 3.25 的 RENAME COLUMN（Node 22 自带的 SQLite 远高于此），旧行的值原样保留。

-- ============ treasury：vault_* → router_* ============
-- 金库合约没了，这三列从此记 BacTaxRouter 的数（balance / accountedQuote() / unsplitRevenue()）。
ALTER TABLE treasury RENAME COLUMN vault_balance   TO router_balance;
ALTER TABLE treasury RENAME COLUMN vault_accounted TO router_accounted;
ALTER TABLE treasury RENAME COLUMN vault_unsplit   TO router_unsplit;
-- BacTaxRouter.stuckAmounts()：推送失败、等 retryPush() 的两个桶。
ALTER TABLE treasury ADD COLUMN router_stuck_bridge TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN router_stuck_node   TEXT NOT NULL DEFAULT '0';
-- pool_balance 列从 004 起记 BacBridge.bnbBalance()（账上为回购留着的税收 BNB）；
-- 这里另记桥合约地址上实际有多少 BNB —— 两者之差就是 owner 紧急提取造成的缺口（shortfall()）。
ALTER TABLE treasury ADD COLUMN bridge_bnb_held         TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN buyback_bac             TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN owed_total              TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN emergency_bnb_withdrawn TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN emergency_bac_withdrawn TEXT NOT NULL DEFAULT '0';
-- market_address_ok 是 NOT NULL，发射前「没法核对」和「核对了但不对」都只能写 0。
-- 这一列把两者分开：0 = 这一行没有核对过（代币未发射或读不到），API 返回 null 而不是 false。
ALTER TABLE treasury ADD COLUMN market_checked INTEGER NOT NULL DEFAULT 0;

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
  reg_kind            TEXT,                 -- 'data-json' | 'uri' | 'empty' | 'unparsable'
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
