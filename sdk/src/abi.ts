// 人类可读 ABI 片段。只列 SDK 真正会用到的函数与事件，逐字对齐 01-CONTRACT-SPEC.md。
// 合约实现与规格冲突时以规格为准（本文件就是规格的那一份）。

export const REGISTRY_ABI = [
  "function register(string agentURI, bytes32 endpointHash, bytes32 modelFingerprint, address agentWallet, uint256 deadline, bytes walletSig) payable returns (uint256 agentId, bytes32 challengeId)",
  "function solveChallenge(uint256 agentId, bytes32 challengeId, uint256 nonce, bytes sig)",
  "function reissueChallenge(uint256 agentId) returns (bytes32 challengeId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes walletSig)",
  "function rotateController(uint256 agentId, address newController, uint256 deadline, bytes newKeySig)",
  "function heartbeat(uint256 agentId, uint64 epoch, bytes32 note, bytes sig)",
  "function markDormant(uint256 agentId)",
  "function publish(uint256 agentId, bytes32 kind, bytes32 contentHash, string uri)",
  "function retire(uint256 agentId)",
  "function withdrawDeposit(uint256 agentId, address to)",
  "function sealEpochSeed(uint64 e)",
  "function isActive(uint256 agentId) view returns (bool)",
  "function getAgent(uint256 agentId) view returns (tuple(address controller, address agentWallet, string agentURI, bytes32 endpointHash, bytes32 modelFingerprint, uint64 registeredAt, uint64 lastHeartbeatEpoch, uint32 missedEpochs, uint32 solvedChallenges, uint96 deposit, uint8 status))",
  "function agentIdOfController(address controller) view returns (uint256)",
  "function agentIdOfWallet(address wallet) view returns (uint256)",
  "function currentChallenge(uint256 agentId) view returns (bytes32 challengeId, bytes32 seed, uint64 deadlineBlock, uint64 deadlineTime, uint8 round)",
  "function currentEpoch() view returns (uint64)",
  "function epochSeed(uint64 epoch) view returns (bytes32)",
  "function sealedAtBlock(uint64 epoch) view returns (uint64)",
  "function seedAnchorBlock(uint64 epoch) view returns (uint64)",
  "function lastSolveEpoch(uint256 agentId) view returns (uint64)",
  "function totalAgents() view returns (uint256)",
  "function ENTRY_DEPOSIT() view returns (uint256)",
  "function TARGET() view returns (uint256)",
  "function ROUNDS() view returns (uint8)",
  "function SPOT_RATE() view returns (uint256)",
  "function HB_WINDOW_BLOCKS() view returns (uint64)",
  "event Registered(uint256 indexed agentId, address indexed controller, address indexed agentWallet, string agentURI, bytes32 endpointHash, bytes32 modelFingerprint)",
  "event ChallengeIssued(uint256 indexed agentId, bytes32 indexed challengeId, bytes32 seed, uint64 deadlineBlock, uint64 deadlineTime, uint8 round)",
  "event ChallengeSolved(uint256 indexed agentId, bytes32 indexed challengeId, uint32 blocksUsed, uint8 round)",
  "event Activated(uint256 indexed agentId, address indexed agentWallet)",
  "event Heartbeat(uint256 indexed agentId, uint64 indexed epoch, bytes32 note)",
] as const;

export const BRIDGE_ABI = [
  "function lock(uint256 agentId, uint256 amount) returns (uint256 depositId)",
  "function claimExit(uint64 anchorEpoch, uint256 exitId, uint256 agentId, address to, uint256 credits, bytes32[] proof) returns (uint256 lockedWei)",
  "function settleEpoch(uint64 epoch)",
  "function collect(address to) returns (uint256 paid)",
  "function escapeCollect(uint256 agentId, address to) returns (uint256 paid)",
  "function claimOwedAfterHalt(address to) returns (uint256 paid)",
  "function bacToken() view returns (address)",
  "function exitClaimed(uint256 exitId) view returns (bool)",
  "function totalCreditsIssued() view returns (uint256)",
  "function totalCreditsExited() view returns (uint256)",
  "function creditsOutstanding() view returns (uint256)",
  "function credited(uint256 agentId) view returns (uint256)",
  "function exitedCredits(uint256 agentId) view returns (uint256)",
  "function poolBalance() view returns (uint256)",
  "function owedTotal() view returns (uint256)",
  "function owed(address who) view returns (uint256)",
  "function pendingCollect(address who) view returns (uint256)",
  "function currentRate() view returns (uint256 weiPerCredit)",
  "function lastEpochRelease() view returns (uint256 pot, uint64 settledAt, uint16 releaseBps)",
  "function lastCollectEpoch(address who) view returns (uint64)",
  "function lastSettledEpoch() view returns (uint64)",
  "function isPaused() view returns (bool, uint64 until_, uint64 cumulative)",
  "function isHalted() view returns (bool)",
  "function escapeClaimable(uint256 agentId) view returns (uint256)",
  "event Locked(uint256 indexed depositId, uint256 indexed agentId, address indexed from, address layerWallet, uint256 measured, uint256 credits, uint256 totalIssued)",
  "event ExitClaimed(uint64 indexed anchorEpoch, uint256 indexed exitId, uint256 indexed agentId, address to, uint256 credits, uint256 lockedWei, uint256 rateUsed, uint256 attributed)",
  "event Collected(address indexed who, address indexed to, uint256 amount, uint256 owedLeft)",
] as const;

export const ANCHOR_ABI = [
  "function getAnchor(uint64 epoch) view returns (tuple(bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, uint64 postedAt, uint64 finalizedAt, uint128 creditedInEpoch, uint128 exitCreditsInEpoch, uint128 feeBurnedInEpoch, uint128 circulating, uint32 exitCount, uint32 agreeingCount, uint8 state))",
  "function releaseBpsFor(uint64 epoch) view returns (uint16)",
] as const;

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address who) view returns (uint256)",
  "function decimals() view returns (uint8)",
] as const;

export const L2BRIDGE_ABI = [
  "function credit(bytes32 depositId, uint256 agentId, address to, uint256 amount)",
  "function withdrawCredits(address to) returns (uint256 amount)",
  "function exit(address bscRecipient) payable returns (uint256 exitId)",
  "function burnFloat() payable",
  "function relayer() view returns (address)",
  "function seen(bytes32 depositId) view returns (bool)",
  "function creditable(address who) view returns (uint256)",
  "function reserve() view returns (uint256)",
  "function totalCredited() view returns (uint256)",
  "function totalExited() view returns (uint256)",
  "function exitCount() view returns (uint256)",
  "event CreditsMinted(bytes32 indexed depositId, uint256 indexed agentId, address indexed to, uint256 amount)",
  "event CreditsWithdrawn(address indexed to, uint256 amount)",
  "event ExitBurned(uint256 indexed exitId, uint256 indexed agentId, address indexed bscRecipient, uint256 amount, uint64 epoch)",
] as const;

export const L2GATE_ABI = [
  "function isAdmitted(address wallet) view returns (bool)",
  "function agentIdOf(address wallet) view returns (uint256)",
  "function statusOf(address wallet) view returns (uint8)",
  "event AgentSynced(uint256 indexed agentId, address indexed wallet, uint8 status, uint64 bscBlock)",
] as const;

export const AGENTBOOK_ABI = [
  "function announce(bytes32 kind, address subject, bytes32 contentHash, string summary, string uri) payable returns (uint64 seq)",
  "function heartbeatNote(uint64 epoch, bytes32 note)",
  "function actionCount() view returns (uint64)",
  "function countInEpoch(address who, uint64 epoch) view returns (uint16)",
  "function PUBLISH_FEE() view returns (uint256)",
  "event Action(uint256 indexed agentId, bytes32 indexed kind, address indexed subject, address actor, bytes32 contentHash, string summary, string uri, uint64 seq, uint64 epoch)",
  "event Note(uint256 indexed agentId, uint64 indexed epoch, bytes32 note)",
] as const;
