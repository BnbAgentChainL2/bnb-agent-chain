-- 002_fee_split.sql —— 决策 #17（层内 gas 费按出块者分账）在 03-INTERFACES.md §2 新增的表与列。
-- 全部是加法：没有改名、没有删列，旧行不需要回填（新列留 NULL 表示「还没有锚点报过这个数」）。
-- 单位一律是层内 BAC 的 wei 十进制字符串，不是 BNB。

-- ===== epochs：逐纪元的 gas 分账汇总（由 FINAL 锚点回填）=====
ALTER TABLE epochs ADD COLUMN proposer_income_root TEXT;
ALTER TABLE epochs ADD COLUMN gas_fees             TEXT;   -- 该纪元全链 gas 费总额（已收）
ALTER TABLE epochs ADD COLUMN gas_remitted         TEXT;   -- 已转入 FeeSplitter 的总额
ALTER TABLE epochs ADD COLUMN gas_gap              TEXT;   -- 已收 − 已转入，可为正
ALTER TABLE epochs ADD COLUMN pool_accrued         TEXT;   -- FeeSplitter.epochFees(epoch).poolAccrued
ALTER TABLE epochs ADD COLUMN pool_claimed         TEXT;
ALTER TABLE epochs ADD COLUMN foundation_accrued   TEXT;
ALTER TABLE epochs ADD COLUMN weight_total         TEXT;
ALTER TABLE epochs ADD COLUMN weights_set_at       INTEGER;
ALTER TABLE epochs ADD COLUMN member_count         INTEGER;

-- ===== 逐纪元逐 proposer 的 gas 收入与归集 =====
CREATE TABLE IF NOT EXISTS proposer_income (
  epoch       INTEGER NOT NULL,
  proposer    TEXT NOT NULL,               -- 层内出块地址
  gas_income  TEXT NOT NULL,               -- 已收
  remitted    TEXT NOT NULL,               -- 已转入
  gap         TEXT NOT NULL,               -- 差额 = gas_income − remitted
  blocks      INTEGER NOT NULL,
  official    INTEGER NOT NULL,            -- 1 = 官方节点
  validator   TEXT,                        -- BSC 侧 validator 地址，未登记为 NULL
  anchored    INTEGER NOT NULL DEFAULT 0,  -- 1 = 已进 FINAL 锚点；0 = 仅来自官方节点，网站必须标注
  PRIMARY KEY (epoch, proposer)
);
CREATE INDEX IF NOT EXISTS proposer_income_proposer ON proposer_income(proposer, epoch DESC);

-- ===== 验证者池的领取明细（FeeSplitter.PoolClaimed）=====
CREATE TABLE IF NOT EXISTS pool_claims (
  epoch      INTEGER NOT NULL,
  member     TEXT NOT NULL,                -- 层内领取地址（= validator 登记的 layerPayout）
  validator  TEXT,                         -- BSC 侧地址，由 ValidatorStaking 的登记表反查
  weight     TEXT NOT NULL,                -- 质押 × attend30
  amount     TEXT NOT NULL,
  to_addr    TEXT NOT NULL,
  layer_tx   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (epoch, member)
);

-- ===== 归集欠款状态（BSC 侧 ValidatorStaking，每次 settleRemittance 后刷新）=====
CREATE TABLE IF NOT EXISTS remittance (
  validator      TEXT PRIMARY KEY,
  proposer_addr  TEXT,
  cum_owed       TEXT NOT NULL DEFAULT '0',
  cum_remitted   TEXT NOT NULL DEFAULT '0',
  arrears        TEXT NOT NULL DEFAULT '0',
  shortfall      INTEGER NOT NULL DEFAULT 0,
  withheld       TEXT NOT NULL DEFAULT '0',
  rights         INTEGER NOT NULL DEFAULT 0,   -- proposerRights
  qualify_streak INTEGER NOT NULL DEFAULT 0,
  last_epoch     INTEGER
);

-- ===== treasury：FeeSplitter 的时间序列列（与 BSC 侧 BNB 税收严格分开，不许相加）=====
ALTER TABLE treasury ADD COLUMN splitter_balance              TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN splitter_pool_pending         TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN splitter_foundation           TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN lifetime_official_gross       TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN lifetime_validator_remitted   TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN lifetime_pool                 TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN lifetime_pool_claimed         TEXT NOT NULL DEFAULT '0';
ALTER TABLE treasury ADD COLUMN lifetime_foundation_withdrawn TEXT NOT NULL DEFAULT '0';
