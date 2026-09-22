// 常量：链参数、合约常量、创世系统地址。
// 全部逐字来自 docs/02-CHAIN-SPEC.md §1/§2 与 docs/01-CONTRACT-SPEC.md §6/§7。
// 这里的每一个数字改动都必须同时改中继、SDK 和它们的测试。

export const LAYER_CHAIN_ID = 56777;            // 02 §1
export const BSC_CHAIN_ID = 56;

// —— 纪元与窗口（01 §6.1 ChainAnchor 的常量，单位秒）——
export const EPOCH = 86400;                     // epoch = floor(timestamp / 86400)
export const COMMIT_WINDOW = 2 * 3600;          // 纪元结束后，中继必须等 2 小时才能发锚点
export const CHALLENGE_WINDOW = 24 * 3600;      // POSTED 之后的挑战窗口
export const HALT_TIMEOUT = 90 * 86400;

// —— ValidatorStaking 常量（01 §7）——
export const MIN_STAKE = 2000000n * 10n ** 18n; // 2,000,000 BAC
export const UNSTAKE_COOLDOWN = 7 * 86400;
export const REWARD_CLAIM_WINDOW = 30 * 86400;

// —— 层内创世系统合约（02 §2）——
export const L2_BRIDGE = '0x0000000000000000000000000000000000000101';
export const L2_GATE = '0x0000000000000000000000000000000000000102';
export const AGENT_BOOK = '0x0000000000000000000000000000000000000103';
export const FEE_SINK = '0x000000000000000000000000000000000000dEaD';
export const TOTAL_SUPPLY = 10n ** 27n;         // 1,000,000,000 BAC

// —— 默认端点（02 §1、决策 #9）——
export const DEFAULT_API_BASE = 'https://95-179-183-132.sslip.io';
export const DEFAULT_LAYER_RPC = 'http://127.0.0.1:8545';   // 见证人只读自己的节点
export const DEFAULT_BSC_RPC = 'https://bsc-rpc.publicnode.com';
export const DEFAULT_BSC_RPC_2 = 'https://bsc-dataseed.bnbchain.org';

// —— 容器（02 §7.1，D0-1 实测过的 tag，不许用 latest）——
export const BESU_IMAGE = 'hyperledger/besu:24.12.2';
export const DEFAULT_P2P_PORT = 30303;
export const DEFAULT_RPC_PORT = 8545;

// —— 私钥只从环境变量按名字读，程序里永不打印、永不落盘 ——
export const ENV_VALIDATOR_KEY = 'VALIDATOR_PRIVATE_KEY';

// —— 创世哈希的核对出处（start 拒绝启动时原样打印）——
export const GENESIS_SOURCES = [
  `${DEFAULT_API_BASE}/api/genesis  的响应头 X-Genesis-Hash`,
  `${DEFAULT_API_BASE}/api/health   的 layer.genesisHash`,
  '仓库里的 chain/GENESIS.md 与网站见证人页（三处必须是同一个值）',
];

// —— 锚点迟发的告警线：纪元结束 + COMMIT_WINDOW 之后再等这么久还没锚点就告警（02 §7.1 的监控线）——
export const ANCHOR_OVERDUE_GRACE = 3600;

// —— 时钟偏移门槛（doctor）。上界待 D0-10 实测 Besu 的 ACCEPTABLE_CLOCK_DRIFT 后收紧 ——
export const CLOCK_SKEW_WARN_SEC = 5;
export const CLOCK_SKEW_FAIL_SEC = 30;

// —— 磁盘门槛（02 §4.4 的磁盘预算）——
export const DISK_FREE_WARN_BYTES = 20 * 1024 ** 3;
export const DISK_FREE_FAIL_BYTES = 10 * 1024 ** 3;
