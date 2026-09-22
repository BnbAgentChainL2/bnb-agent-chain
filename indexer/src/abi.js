// src/abi.js —— 事件 ABI 片段。
// 逐字抄自 docs/01-CONTRACT-SPEC.md（§3.1 AgentRegistry / §4.1 BacBridge / §5 BacNodeFund /
// §6.1 ChainAnchor / §7 ValidatorStaking / §8.1 L2Bridge / §8.2 L2Gate / §9 AgentBook / §2.1 金库），
// 并与 contracts/src 下的实现逐条对过（2026-09-22，两边一致）。
// 规矩：SPEC 与实现不一致时以 SPEC 为准，并在 README 的「与实现的差异」里记一条。
import { id as keccakId, Interface, getAddress } from "ethers";

/** §4.2 的 11 个 kind 明文。写死，SDK 与索引器共用。 */
export const ACTION_KINDS = [
  "JOIN",
  "DEPLOY",
  "PUBLISH",
  "SERVICE",
  "TRADE",
  "LIST",
  "POOL",
  "STRATEGY",
  "MESSAGE",
  "CLAIM",
  "NOTE",
];

/** kind 明文 -> keccak256(明文)；以及反向表。 */
export const KIND_HASH = Object.fromEntries(ACTION_KINDS.map((k) => [k, keccakId(k)]));
export const HASH_KIND = Object.fromEntries(ACTION_KINDS.map((k) => [keccakId(k), k]));

/** AgentRegistry.Status 的编码（03 §1.4）。 */
export const STATUS_NAME = {
  0: "NONE",
  1: "CHALLENGED",
  2: "ACTIVE",
  3: "DORMANT",
  4: "BANNED",
  5: "RETIRED",
};
export const STATUS_CODE = Object.fromEntries(
  Object.entries(STATUS_NAME).map(([k, v]) => [v.toLowerCase(), Number(k)])
);

export const EVENT_ABIS = {
  AgentRegistry: [
    "event Registered(uint256 indexed agentId, address indexed controller, address indexed agentWallet, string agentURI, bytes32 endpointHash, bytes32 modelFingerprint)",
    "event ChallengeIssued(uint256 indexed agentId, bytes32 indexed challengeId, bytes32 seed, uint64 deadlineBlock, uint64 deadlineTime, uint8 round)",
    "event ChallengeSolved(uint256 indexed agentId, bytes32 indexed challengeId, uint32 blocksUsed, uint8 round)",
    "event ChallengeFailed(uint256 indexed agentId, bytes32 indexed challengeId, uint8 round)",
    "event Activated(uint256 indexed agentId, address indexed agentWallet)",
    "event Heartbeat(uint256 indexed agentId, uint64 indexed epoch, bytes32 note)",
    "event Dormant(uint256 indexed agentId, uint64 epoch)",
    "event Published(uint256 indexed agentId, bytes32 indexed kind, bytes32 contentHash, string uri)",
    "event AgentWalletSet(uint256 indexed agentId, address indexed wallet)",
    "event URIUpdated(uint256 indexed agentId, string newURI)",
    "event ControllerRotated(uint256 indexed agentId, address indexed from, address indexed to)",
    "event Retired(uint256 indexed agentId, uint64 claimableAt)",
    "event DepositWithdrawn(uint256 indexed agentId, address indexed to, uint256 amount)",
    "event DepositForfeited(uint256 indexed agentId, uint256 amount)",
    "event ForfeitedSwept(address indexed to, uint256 amount)",
    "event BanProposed(uint256 indexed agentId, bytes32 reasonHash, uint64 eta)",
    "event BanCancelled(uint256 indexed agentId)",
    "event Banned(uint256 indexed agentId, bytes32 reasonHash, address by)",
    "event EpochSeedSealed(uint64 indexed epoch, bytes32 seed, uint64 sourceBlock)",
    "event RegistrationAbandoned(uint256 indexed agentId, address indexed to, uint256 amount)",
    "event VaultSinkSet(address indexed vaultSink)",
  ],
  BacBridge: [
    "event Locked(uint256 indexed depositId, uint256 indexed agentId, address indexed from, address layerWallet, uint256 measured, uint256 credits, uint256 totalIssued)",
    "event ReleaseReceived(address indexed from, uint256 amount, uint256 poolAfter)",
    "event Untracked(uint256 amount, uint256 poolAfter)",
    "event ExitClaimed(uint64 indexed anchorEpoch, uint256 indexed exitId, uint256 indexed agentId, address to, uint256 credits, uint256 lockedWei, uint256 rateUsed, uint256 attributed)",
    "event EpochSettled(uint64 indexed epoch, uint256 pot, uint256 owedTotalAfter, uint16 releaseBps, bool skipped)",
    "event Collected(address indexed who, address indexed to, uint256 amount, uint256 owedLeft)",
    "event EscapeArmed(address indexed by, uint8 cause, uint64 effectiveAt)",
    "event EscapeArmCancelled(address indexed by)",
    "event Halted(uint8 cause)",
    "event OwedPaidAfterHalt(address indexed who, address indexed to, uint256 amount)",
    "event OwedDemoted(address indexed who, uint256 amount)",
    "event EscapeCollected(uint256 indexed agentId, address indexed to, uint256 amount)",
    "event Paused(address indexed by, uint64 until_, uint64 cumulative)",
    "event Unpaused(address indexed by, uint64 cumulative)",
    "event LockedBurned(uint256 amount)",
  ],
  ChainAnchor: [
    "event AnchorPosted(uint64 indexed epoch, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, uint128 credited, uint128 exitCredits, uint128 feeBurned, uint128 circulating, uint32 exitCount)",
    "event AnchorFinalized(uint64 indexed epoch, uint32 agreeingCount, uint16 releaseBps)",
    "event AnchorVetoed(uint64 indexed epoch, address indexed by, bytes32 reasonHash, uint8 countInWindow)",
    "event AnchorDisputed(uint64 indexed epoch, uint256 agreeingWeight, uint256 disputingWeight, uint32 disputingCount, uint8 countInWindow)",
    "event RelayerRotationQueued(address indexed newRelayer, uint64 eta)",
    "event RelayerRotationCancelled(address indexed by)",
    "event RelayerChanged(address indexed from, address indexed to)",
    "event ValidatorStakingSet(address indexed staking)",
  ],
  ValidatorStaking: [
    "event Staked(address indexed who, uint256 amount, uint256 total)",
    "event UnstakeRequested(address indexed who, uint256 amount, uint64 unlockAt)",
    "event Unstaked(address indexed who, address indexed to, uint256 amount)",
    "event NodeRegistered(bytes32 indexed nodeIdHash, address indexed validator, address payout, string enodeURI)",
    "event NodeRetired(bytes32 indexed nodeIdHash)",
    "event AttestationCommitted(uint64 indexed epoch, address indexed validator, bytes32 commitment)",
    "event AttestationRevealed(uint64 indexed epoch, address indexed validator, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, bool agreeing, uint256 weight)",
    "event RewardsFunded(address indexed from, uint256 amount, uint256 balanceAfter)",
    "event RewardsSettled(uint64 indexed epoch, uint256 pot, uint256 weight, uint256 rate)",
    "event RewardClaimed(uint64 indexed epoch, address indexed validator, address indexed to, uint256 amount)",
    "event RewardExpired(uint64 indexed epoch, uint256 returned)",
    "event NodeStruck(bytes32 indexed nodeIdHash, uint32 strikes)",
    "event ValidatorRemovalQueued(address indexed v, bytes32 reasonHash, uint64 eta)",
    "event ValidatorRemovalCancelled(address indexed v, address indexed by)",
    "event ValidatorRemoved(address indexed v)",
  ],
  BacTreasuryVault: [
    "event RevenueRecognized(address indexed from, uint256 amount)",
    "event RevenueSplit(uint256 toBridge, uint256 toNodeFund)",
    "event PushSucceeded(address indexed to, uint256 amount)",
    "event PushFailed(address indexed to, uint256 amount)",
    "event OwnershipTransferred(address indexed from, address indexed to)",
  ],
  BacNodeFund: [
    "event ReleaseReceived(address indexed from, uint256 amount, uint256 balanceAfter)",
    "event Withdrawn(address indexed to, uint256 amount, uint256 balanceAfter)",
    "event OwnershipTransferStarted(address indexed from, address indexed to)",
    "event OwnershipTransferred(address indexed from, address indexed to)",
  ],
  BacVaultFactory: [
    "event BacTreasuryVaultCreated(address indexed vault, address indexed taxToken, address indexed creator, address owner, address bridge, address nodeFund)",
  ],
  // Flap 的 VaultPortal 事件，决策 #10 的披露链路要它进 feed（03 §4.4 最后一条）。
  FlapVaultPortal: [
    "event FlapTaxVaultTokenCreated(address indexed token, address indexed vault, address indexed vaultFactory)",
  ],
  // ===== 层内 =====
  L2Bridge: [
    "event CreditsMinted(bytes32 indexed depositId, uint256 indexed agentId, address indexed to, uint256 amount)",
    "event CreditsWithdrawn(address indexed to, uint256 amount)",
    "event ExitBurned(uint256 indexed exitId, uint256 indexed agentId, address indexed bscRecipient, uint256 amount, uint64 epoch)",
    "event FloatBurned(address indexed from, uint256 amount)",
    "event RelayerRotated(address indexed from, address indexed to, uint256 nonce)",
  ],
  L2Gate: [
    "event AgentSynced(uint256 indexed agentId, address indexed wallet, uint8 status, uint64 bscBlock)",
  ],
  AgentBook: [
    "event Action(uint256 indexed agentId, bytes32 indexed kind, address indexed subject, address actor, bytes32 contentHash, string summary, string uri, uint64 seq, uint64 epoch)",
    "event Note(uint256 indexed agentId, uint64 indexed epoch, bytes32 note)",
  ],
};

/** 合约名 -> ethers Interface。 */
export const IFACES = Object.fromEntries(
  Object.entries(EVENT_ABIS).map(([name, abi]) => [name, new Interface(abi)])
);

/** 哪些合约在哪条链上。地址未知时按链过滤能少一半误判。 */
export const CONTRACT_CHAIN = {
  AgentRegistry: "bsc",
  BacBridge: "bsc",
  ChainAnchor: "bsc",
  ValidatorStaking: "bsc",
  BacTreasuryVault: "bsc",
  BacNodeFund: "bsc",
  BacVaultFactory: "bsc",
  FlapVaultPortal: "bsc",
  L2Bridge: "layer",
  L2Gate: "layer",
  AgentBook: "layer",
};

/** topic0 -> [{contract, name, fragment}]，同签名跨合约会有多个候选，靠地址消歧。 */
export const TOPIC0 = (() => {
  const m = new Map();
  for (const [contract, iface] of Object.entries(IFACES)) {
    iface.forEachEvent((frag) => {
      const t0 = frag.topicHash;
      if (!m.has(t0)) m.set(t0, []);
      m.get(t0).push({ contract, name: frag.name, fragment: frag });
    });
  }
  return m;
})();

/** 02 §4.1 的层内创世地址。 */
export const LAYER_SYSTEM_ADDRESSES = {
  L2Bridge: getAddress("0x0000000000000000000000000000000000000101"),
  L2Gate: getAddress("0x0000000000000000000000000000000000000102"),
  AgentBook: getAddress("0x0000000000000000000000000000000000000103"),
};

/** 费用沉淀地址（03 §3.1 的 reconcile 要单独读它）。 */
export const FEE_SINK = getAddress("0x000000000000000000000000000000000000dEaD");
/** 决策 #17 的 gas 费分账合约（层内创世合约 @ 0x…0104）。对账公式必须减它。 */
export const FEE_SPLITTER = getAddress("0x0000000000000000000000000000000000000104");
/** 创世总量 1e27 wei。 */
export const GENESIS_SUPPLY = 10n ** 27n;
