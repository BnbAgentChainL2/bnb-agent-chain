// 只保留本程序真正会调用的函数与事件（ABI 以 docs/01-CONTRACT-SPEC.md 为准）。
// 合约实现在 contracts/ 由另一个工作流在写；两边不一致时以 SPEC 为准，并在 README 的「已知偏差」里记一笔。

export const VALIDATOR_STAKING_ABI = [
  // 质押
  'function stake(uint256 amount)',
  'function requestUnstake(uint256 amount)',
  'function withdrawUnstaked(address to) returns (uint256)',
  // 节点
  'function registerNode(bytes32 nodeIdHash, string enodeURI, address payout)',
  'function retireNode(bytes32 nodeIdHash)',
  // 见证（承诺-揭示）
  'function commitAttestation(uint64 epoch, bytes32 commitment)',
  'function revealAttestation(uint64 epoch, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, bytes32 salt)',
  'function attestationResult(uint64 epoch, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block) view returns (uint256 agreeingWeight, uint256 disputingWeight, uint32 agreeingCount, uint32 disputingCount)',
  // 奖励
  'function fundRewards() payable',
  'function settleEpochRewards(uint64 epoch)',
  'function claimReward(uint64 epoch, address validator) returns (uint256)',
  'function sweepExpired(uint64 epoch) returns (uint256)',
  // views
  'function stakeOf(address who) view returns (uint256 staked, uint256 pending, uint64 unlockAt)',
  'function totalStaked() view returns (uint256)',
  'function nodeCount() view returns (uint256)',
  'function nodeOf(bytes32 nodeIdHash) view returns (address validator, address payout, string enodeURI, bool active, uint32 strikes)',
  'function nodesOf(address who) view returns (uint256)',
  'function rewardBalance() view returns (uint256)',
  'function epochReward(uint64 epoch) view returns (uint256 pot, uint256 weight, uint256 rate, bool settled)',
  'function rewardOf(uint64 epoch, address validator) view returns (uint256)',
  'function lastRewardEpoch() view returns (uint64)',
  'function lifetimeFunded() view returns (uint256)',
  'function lifetimePaid() view returns (uint256)',
  // 事件
  'event AttestationCommitted(uint64 indexed epoch, address indexed validator, bytes32 commitment)',
  'event AttestationRevealed(uint64 indexed epoch, address indexed validator, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, bool agreeing, uint256 weight)',
  'event RewardClaimed(uint64 indexed epoch, address indexed validator, address indexed to, uint256 amount)',
];

// ChainAnchor.Anchor 结构（01 §6.1，字段顺序即 abi 顺序，不许调换）
export const CHAIN_ANCHOR_ABI = [
  'function getAnchor(uint64 epoch) view returns (tuple(bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, uint64 postedAt, uint64 finalizedAt, uint128 creditedInEpoch, uint128 exitCreditsInEpoch, uint128 feeBurnedInEpoch, uint128 circulating, uint32 exitCount, uint32 agreeingCount, uint8 state))',
  'function lastPostedEpoch() view returns (uint64)',
  'function lastFinalEpoch() view returns (uint64)',
  'function lastFinalAt() view returns (uint64)',
  'function releaseBpsFor(uint64 epoch) view returns (uint16)',
  'function haltReason() view returns (uint8)',
  'function COMMIT_WINDOW() view returns (uint64)',
  'function CHALLENGE_WINDOW() view returns (uint64)',
];

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address who) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// 层内 L2Bridge（01 §8.1）：见证人只读 ExitBurned 日志重建 exitRoot
export const L2_BRIDGE_ABI = [
  'event ExitBurned(uint256 indexed exitId, uint256 indexed agentId, address indexed bscRecipient, uint256 amount, uint64 epoch)',
];

/** ChainAnchor.State 的数字 -> 名字（01 §6.1 enum 顺序） */
export const ANCHOR_STATE = ['NONE', 'POSTED', 'FINAL', 'VETOED', 'DISPUTED'];
