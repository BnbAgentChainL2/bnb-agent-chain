// 常量：全部来自 docs/，不许在别处硬编码第二份。
// 01-CONTRACT-SPEC.md §4.1 / §6.1 / §8.1，02-CHAIN-SPEC.md §2，03-INTERFACES.md §1。

/** 层内链 ID（01 §4.1 LAYER_CHAIN_ID） */
export const LAYER_CHAIN_ID = 56777;

/** BSC 主链 ID（退出叶子与 depositId 的域分隔用的就是它） */
export const BSC_CHAIN_ID = 56;

/** 纪元长度，秒。epoch = floor(timestamp / 86400)，两条链同一个定义（03 开头的约定） */
export const EPOCH = 86400;

/** 承诺窗口：纪元结束后中继必须等这么久才能发锚点（01 §6.1 COMMIT_WINDOW = 2 hours） */
export const COMMIT_WINDOW = 2 * 3600;

/** 层内总量 1e27 wei（02 §2：L2Bridge 创世余额 + OPERATOR_FLOAT） */
export const LAYER_TOTAL_SUPPLY = 1000000000000000000000000000n;

/** 方向 A 的三段确认门槛（03 §1.2） */
export const CONFIRM = {
  /** 深度 >= 15 块 */
  DEPTH: 15,
  /** 距首次看见 >= 45 秒墙钟 */
  WALL_SEC: 45,
  /** finalized 取不到时的兜底深度（>= 1200 块，按实测 0.45 s 块时间约 9 分钟） */
  FALLBACK_DEPTH: 1200,
  /** finalized 取不到时的兜底墙钟（>= 600 秒） */
  FALLBACK_WALL_SEC: 600,
  /** 连续这么久取不到 finalized 就完全停止发 credit（10 分钟） */
  OUTAGE_HALT_SEC: 600,
};

/** 发送纪律（03 §1.1） */
export const SEND = {
  /** 60 秒未上链就加价重发 */
  WAIT_MS: 60_000,
  /** 加价倍数 1.25x（用整数分数避免浮点） */
  BUMP_NUM: 125n,
  BUMP_DEN: 100n,
  /** 同一条 job 最多发 3 次，之后 parked（不阻塞后面的 job） */
  MAX_ATTEMPTS: 3,
};

/**
 * 纪元结束后读四个余额的时限：Besu `--state.scheme=path` 默认只保留 128 个状态 ≈ 6.4 分钟
 * （03 §1.3 的运维约束）。读完落盘即可，发交易可以晚到 COMMIT_WINDOW 之后。
 */
export const LAYER_STATE_WINDOW_SEC = 360;

/** 退出叶子的 typehash（01 §4.1，逐字；**里面没有 epoch 字段**） */
export const EXIT_TYPEHASH_SOURCE =
  'Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)';

/** AgentRegistry.Status（01 §3.1，与 L2Gate.applySync 的 status 编码完全一致） */
export const AGENT_STATUS_NAMES = ['NONE', 'CHALLENGED', 'ACTIVE', 'DORMANT', 'BANNED', 'RETIRED'];

/** outbox / anchors 的状态字面量（03 §1.5） */
export const OUTBOX_STATUS = {
  NEW: 'new',
  SENT: 'sent',
  CONFIRMED: 'confirmed',
  ORPHANED: 'orphaned',
  FAILED: 'failed',
  PARKED: 'parked',
};

/** 告警字符串：只许用这里列出的，网站与 /api/health 按字符串匹配 */
export const WARN = {
  /** 连续 10 分钟拿不到 BSC finalized：已停止发 credit（03 §1.2，逐字） */
  BSC_FINALITY_UNAVAILABLE: 'bsc_finality_unavailable',
  /** 两个 BSC RPC 的 finalized 不在同一条链上：同样不发 credit */
  BSC_FINALITY_DISAGREEMENT: 'bsc_finality_disagreement',
  /** 源日志在发送前复核时消失（BSC 重组）：该 job 已 orphaned */
  BSC_LOG_ORPHANED: 'bsc_log_orphaned',
  /** 有 job 连续失败到 parked，需要人看 */
  OUTBOX_PARKED: 'outbox_parked',
  /** 纪元结束后 6 分钟内没读完四个余额，状态可能已被裁剪 */
  LAYER_STATE_WINDOW_MISSED: 'layer_state_window_missed',
  /** 锚点落后：上一个纪元过了承诺窗口还没发出去 */
  ANCHOR_OVERDUE: 'anchor_overdue',
  /** 链下对账差额非零（03 §3.1 的 diff） */
  RECONCILE_MISMATCH: 'reconcile_mismatch',
  /** 中继余额过低（02 §5.4：BSC < 0.05 BNB 或层内 < 100 BAC） */
  RELAYER_BALANCE_LOW: 'relayer_balance_low',
  /** ExitBurned 事件里的 epoch 与区块区间推出的纪元不一致：停，不猜 */
  EXIT_EPOCH_MISMATCH: 'exit_epoch_mismatch',
};

/** 02 §5.4 的余额告警线 */
export const BALANCE_FLOOR = {
  BSC_WEI: 50000000000000000n, // 0.05 BNB
  LAYER_WEI: 100000000000000000000n, // 100 BAC
};
