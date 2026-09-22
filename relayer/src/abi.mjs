// 只放中继真正用到的那几条 ABI（人类可读格式）。
// 来源：01-CONTRACT-SPEC.md §3.1 / §4.1 / §6.1 / §8.1 —— 与 contracts/src 不一致时以 SPEC 为准。

/** BSC：BacBridge（只读 + 事件；中继在 BSC 侧只写 ChainAnchor.postAnchor） */
export const BAC_BRIDGE_ABI = [
  'event Locked(uint256 indexed depositId, uint256 indexed agentId, address indexed from, address layerWallet, uint256 measured, uint256 credits, uint256 totalIssued)',
  'function totalCreditsIssued() view returns (uint256)',
  'function totalCreditsExited() view returns (uint256)',
  'function creditsOutstanding() view returns (uint256)',
  'function poolBalance() view returns (uint256)',
  'function owedTotal() view returns (uint256)',
  'function reservedTotal() view returns (uint256)',
  'function lastSettledEpoch() view returns (uint64)',
  'function skippedEpochs() view returns (uint64)',
  'function isPaused() view returns (bool, uint64, uint64)',
  'function isHalted() view returns (bool)',
];

/** BSC：AgentRegistry（方向 C 的五个事件，03 §1.4） */
export const AGENT_REGISTRY_ABI = [
  'event Activated(uint256 indexed agentId, address indexed agentWallet)',
  'event Dormant(uint256 indexed agentId, uint64 epoch)',
  'event Banned(uint256 indexed agentId, bytes32 reasonHash, address by)',
  'event AgentWalletSet(uint256 indexed agentId, address indexed wallet)',
  'event Retired(uint256 indexed agentId, uint64 claimableAt)',
  // 方向 C 发送前现读最终状态。**AgentRegistry 上没有 agentWallet(uint256) / statusOf(uint256)**
  // 这两个函数（01 §5 的 views 只有 getAgent / isActive / agentIdOfWallet / agentIdOfController，
  // contracts/src/AgentRegistry.sol 亦然），所以这里读 getAgent 的结构体，
  // 字段顺序与 01 §5 的 struct Agent 逐字一致。
  'function getAgent(uint256 agentId) view returns ((address controller, address agentWallet, string agentURI, bytes32 endpointHash, bytes32 modelFingerprint, uint64 registeredAt, uint64 lastHeartbeatEpoch, uint32 missedEpochs, uint32 solvedChallenges, uint96 deposit, uint8 status))',
  'function isActive(uint256 agentId) view returns (bool)',
  'function agentIdOfWallet(address wallet) view returns (uint256)',
];

/** BSC：ChainAnchor（中继唯一的 BSC 写操作） */
export const CHAIN_ANCHOR_ABI = [
  'function postAnchor(uint64 epoch, (bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, uint64 postedAt, uint64 finalizedAt, uint128 creditedInEpoch, uint128 exitCreditsInEpoch, uint128 feeBurnedInEpoch, uint128 circulating, uint32 exitCount, uint32 agreeingCount, uint8 state) a)',
  'function getAnchor(uint64 epoch) view returns ((bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, uint64 postedAt, uint64 finalizedAt, uint128 creditedInEpoch, uint128 exitCreditsInEpoch, uint128 feeBurnedInEpoch, uint128 circulating, uint32 exitCount, uint32 agreeingCount, uint8 state))',
  'function lastPostedEpoch() view returns (uint64)',
  'function lastFinalEpoch() view returns (uint64)',
  'function cumulativeCredited() view returns (uint256)',
  'function cumulativeExit() view returns (uint256)',
  'function relayer() view returns (address)',
];

/** 层内：L2Bridge @ 0x…0101 */
export const L2_BRIDGE_ABI = [
  'function credit(bytes32 depositId, uint256 agentId, address to, uint256 amount)',
  'function withdrawCredits(address to) returns (uint256)',
  'function seen(bytes32 depositId) view returns (bool)',
  'function creditable(address who) view returns (uint256)',
  'function totalCredited() view returns (uint256)',
  'function totalExited() view returns (uint256)',
  'function relayer() view returns (address)',
  'event CreditsMinted(bytes32 indexed depositId, uint256 indexed agentId, address indexed to, uint256 amount)',
  'event ExitBurned(uint256 indexed exitId, uint256 indexed agentId, address indexed bscRecipient, uint256 amount, uint64 epoch)',
  'event FloatBurned(address indexed from, uint256 amount)',
];

/** 层内：L2Gate @ 0x…0102 */
export const L2_GATE_ABI = [
  'function applySync(uint256 agentId, address wallet, uint8 status, uint64 bscBlock)',
  'function isAdmitted(address wallet) view returns (bool)',
  'function agentIdOf(address wallet) view returns (uint256)',
  'function statusOf(address wallet) view returns (uint8)',
  // syncedAt 在 01 §8.2 的 ABI 列表里没有，但 contracts/src/layer/L2Gate.sol 有；
  // 中继只把它当**幂等兜底**用（读失败就退回 statusOf 比较），不依赖它做任何判定。
  'function syncedAt(uint256 agentId) view returns (uint64)',
];

/** 事件 topic0 与解码用的接口在 chains.mjs 里按需构造 */
