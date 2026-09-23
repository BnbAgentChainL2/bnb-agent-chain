// 看门狗的常量。**全部来自合约源码与 docs/**，不许在别处硬编码第二份。
// 来源：contracts/src/BacBridge.sol、contracts/src/ChainAnchor.sol、
//       docs/01-CONTRACT-SPEC.md §4/§6、docs/03-INTERFACES.md §1.3/§3.1、
//       artifacts/sim/RESULTS-buyback.md §3（探测延迟预算）。
//
// 这里的每一个数字都有两份来源（合约 + 文档）。启动时 `preflight.mjs` 会把其中
// 会被误配的那几个**现读链上常量再核一遍**：数字对不上就拒绝启动，因为一个按错误
// 纪元长度算区间的看门狗会在第一个纪元就误报。

// ---------------------------------------------------------------- 链上时钟

/** 纪元长度，秒（决策 #20；BacBridge.EPOCH / ChainAnchor.EPOCH） */
export const EPOCH = 600;

/** 144。释放率与回购预算的除数（BacBridge.EPOCHS_PER_DAY） */
export const EPOCHS_PER_DAY = 144;

/** 「锚点等待」120 秒（决策 #25；ChainAnchor.ANCHOR_WAIT）。**不是「挑战窗口」**（决策 #18） */
export const ANCHOR_WAIT = 120;

/** 0（ChainAnchor.COMMIT_WINDOW）。中继仍必须等本纪元结束，只是不再额外等 */
export const COMMIT_WINDOW = 0;

/** 层内链 ID（BacBridge.LAYER_CHAIN_ID） */
export const LAYER_CHAIN_ID = 56777;

/** BSC 主链 ID */
export const BSC_CHAIN_ID = 56;

/** 层内总量 1e27 wei（02 §2：L2Bridge 创世余额 + OPERATOR_FLOAT） */
export const LAYER_TOTAL_SUPPLY = 1000000000000000000000000000n;

/** 退出叶子的 typehash 源串（BacBridge.EXIT_TYPEHASH，逐字；**里面没有 epoch 字段**） */
export const EXIT_TYPEHASH_SOURCE =
  'Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)';

// ------------------------------------------------------------ 桥的经济常量

/** BacBridge.BUYBACK_DAILY_BPS */
export const BUYBACK_DAILY_BPS = 2000n;
/** BacBridge.MIN_BUYBACK_BNB = 0.01 ether */
export const MIN_BUYBACK_BNB = 10000000000000000n;
/** BacBridge.MAX_BUYBACK_BNB = 0.5 ether */
export const MAX_BUYBACK_BNB = 500000000000000000n;
/** BacBridge.MAX_BUY_SLIPPAGE_BPS */
export const MAX_BUY_SLIPPAGE_BPS = 300n;
/** BacBridge.BUYBACK_QUOTE_REF = 0.001 ether */
export const BUYBACK_QUOTE_REF = 1000000000000000n;
/** BacBridge.MAX_EXIT_SHARE_BPS（单地址单纪元领取上限） */
export const MAX_EXIT_SHARE_BPS = 1000n;
/** BacBridge.MAX_PAUSE_TOTAL = 21 days，秒 */
export const MAX_PAUSE_TOTAL = 21 * 86400;
/** BacBridge.PAUSE_LEN = 7 days，秒 */
export const PAUSE_LEN = 7 * 86400;

/** ChainAnchor 的三档释放率（**按天**，消费方要除以 EPOCHS_PER_DAY） */
export const RELEASE_DAILY_BPS = { NONE: 200n, FEW: 350n, QUORUM: 500n };
/** 链上唯一合法的三个取值，别的值说明合约被换了或读错了 */
export const RELEASE_DAILY_BPS_SET = [200n, 350n, 500n];

/** 死地址：lockedBac 唯一的出口（BacBridge.DEAD） */
export const DEAD = '0x000000000000000000000000000000000000dEaD';

/** 锚点状态枚举，顺序与 IChainAnchor.State 逐字一致 */
export const ANCHOR_STATE = ['NONE', 'POSTED', 'FINAL', 'VETOED', 'DISPUTED'];

// -------------------------------------------------------- 探测延迟与轮询

// 预算（artifacts/sim/RESULTS-buyback.md §3.3，逐字）：
//   探测延迟 L + 上链延迟 I(≈7 s：签名 1 s + 2 个 BSC 块) + 30 s 安全余量 < 120 s
//   ⇒ L ≤ 83 s。工程指标取 **轮询间隔 ≤ 10 s、端到端探测延迟 ≤ 30 s**。
/** 模拟给出的硬上限，秒。README 里的达成值必须小于它 */
export const LATENCY_BUDGET_SEC = 83;
/** 工程指标：端到端探测延迟目标，秒 */
export const LATENCY_TARGET_SEC = 30;
/** 默认轮询间隔，毫秒（≤ 10 s 是模拟给的指标） */
export const DEFAULT_POLL_MS = 5000;
/** 慢规则（对账 / 桶 / 释放率）的默认间隔：它们没有 120 秒窗口，读多了只是浪费 RPC */
export const DEFAULT_SLOW_POLL_MS = 30000;

// ------------------------------------------------------------ 规则与告警

/** 规则 ID。日志、告警、README 与运维手册里必须用同一套字符串 */
export const RULE = {
  /** 锚点里的 exitRoot / l2Block / 计数字段 vs 看门狗自己从层内日志复算的结果 */
  ANCHOR_ROOT: 'anchor_root',
  /** 层内 vs BSC 的对账恒等式（03 §3.1 的 diff） */
  RECONCILE: 'reconcile',
  /** 两个 BAC 桶 vs 代币真实余额，以及桶之间的结构性不等式 */
  BUCKETS: 'buckets',
  /** 每一笔回购 vs 它自己的滑点上限与单次上限 */
  BUYBACK: 'buyback',
  /** 释放率 vs 每天 2%–5% 的上限 */
  RELEASE_CAP: 'release_cap',
  /** 中继活性：锚点迟到。**只告警，永不暂停** */
  CADENCE: 'cadence',
};

/** 严重度。只有 CRITICAL 会触发 pause()，而且必须先通过一次独立复核 */
export const SEVERITY = { OK: 'ok', SKIP: 'skip', WARN: 'warn', CRITICAL: 'critical' };

/** 复核（confirm）与跳闸（trip）之间的生命周期，落在 SQLite 里，重启后接着走 */
export const FINDING_STATE = {
  PENDING_CONFIRM: 'pending_confirm',
  PENDING_TRIP: 'pending_trip',
  TRIPPED: 'tripped',
  CLEARED: 'cleared',
};

/** 进程退出码。跳闸后必须是非零，运维脚本按它判断 */
export const EXIT = { OK: 0, CONFIG: 2, TRIPPED: 3, PREFLIGHT: 4 };
