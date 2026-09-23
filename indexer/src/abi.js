// src/abi.js —— 事件 ABI 片段。
// v2（决策 #29 / #30 / #31 / #32）：AgentRegistry / BacTreasuryVault / BacVaultFactory / VaultPortal 已删除，
// 这里不再有它们的事件。每一条签名都与 contracts/out/*.json 里 forge 生成的 ABI 逐条对过（2026-09-23），
// 包括参数名 —— 参数名决定了 decoded_events.args 的键，改一个名字就等于改 /api/tx 的返回体。
// 规矩：SPEC 与实现不一致时，以**已编译的合约**为准（v2 的 SPEC 还没追平），并在 README 记一条。
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

/**
 * 层内 L2Gate 的状态码（L2Gate.AgentSynced.status）。
 * 它的 BSC 来源（AgentRegistry 的状态机）已被决策 #31 删除：BSC 上只剩「没进过桥 / 进过桥」两种事实，
 * 所以只有 NONE 与 ACTIVE 还可能出现；其余四个是层内合约 ABI 里留下的死码，只用来把旧日志解成可读名字。
 */
export const STATUS_NAME = {
  0: "NONE",
  1: "CHALLENGED",
  2: "ACTIVE",
  3: "DORMANT",
  4: "BANNED",
  5: "RETIRED",
};

export const EVENT_ABIS = {
  // BacBridge 是 ERC1967 / UUPS 代理（决策 #29）。事件都从**代理地址**发出（实现合约的代码在代理的存储上跑），
  // 所以 OpenZeppelin 的 Upgraded / Initialized / OwnershipTransferred / OwnershipTransferStarted 也在这里。
  BacBridge: [
    "event Locked(uint256 indexed depositId, uint256 indexed agentId, address indexed from, address layerWallet, uint256 measured, uint256 credits, uint256 totalIssued)",
    "event ReleaseReceived(address indexed from, uint256 amount, uint256 bnbAfter)",
    "event Untracked(uint256 amount, uint256 bnbAfter)",
    "event UntrackedBac(uint256 amount, uint256 buybackBacAfter)",
    "event BoughtBack(address indexed by, uint8 venue, uint256 bnbSpent, uint256 bacBought, uint256 buybackBacAfter)",
    "event BuybackSkipped(uint8 reason, uint256 budget)",
    "event ExitClaimed(uint64 indexed anchorEpoch, uint256 indexed exitId, uint256 indexed agentId, address to, uint256 credits, uint256 lockedBacAmt, uint256 rateUsed, uint256 attributed)",
    "event EpochSettled(uint64 indexed epoch, uint256 pot, uint256 owedTotalAfter, uint16 releaseBps, bool skipped)",
    "event Collected(address indexed who, address indexed to, uint256 amount, uint256 owedLeft)",
    "event EpochOwedRevoked(uint64 indexed epoch, address indexed by, uint256 revoked)",
    "event EscapeArmed(address indexed by, uint8 cause, uint64 effectiveAt)",
    "event EscapeArmCancelled(address indexed by)",
    "event Halted(uint8 cause)",
    "event OwedPaidAfterHalt(address indexed who, address indexed to, uint256 amount)",
    "event OwedDemoted(address indexed who, uint256 amount)",
    "event EscapeCollected(uint256 indexed agentId, address indexed to, uint256 bacPaid, uint256 bnbPaid)",
    "event Paused(address indexed by, uint64 until_, uint64 cumulative)",
    "event Unpaused(address indexed by, uint64 cumulative)",
    "event LockedBurned(uint256 amount)",
    "event AgentControllerSet(uint256 indexed agentId, address indexed previous, address indexed current)",
    // 决策 #29c：升级与紧急提取必须留痕
    "event BridgeUpgraded(address indexed newImplementation, address indexed previousImplementation, address indexed by, uint64 upgradeNumber, uint64 at, uint256 bnbBook, uint256 lockedBacBook, uint256 buybackBacBook, uint256 owedTotalBook)",
    "event EmergencyWithdraw(address indexed by, address indexed to, address indexed token, uint256 amount, uint256 balanceAfter, uint256 bookAtWithdraw, uint256 lifetimeWithdrawn, uint64 withdrawNumber, uint64 at)",
    // OpenZeppelin 4.9（ERC1967UpgradeUpgradeable / Initializable / Ownable2StepUpgradeable）
    "event Upgraded(address indexed implementation)",
    "event AdminChanged(address previousAdmin, address newAdmin)",
    "event BeaconUpgraded(address indexed beacon)",
    "event Initialized(uint8 version)",
    "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
    "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  ],
  // 决策 #30 / #32：Flap 的收款地址。没有 owner、没有 description()，只有这四个事件。
  BacTaxRouter: [
    "event RevenueRecognized(address indexed from, uint256 amount)",
    "event RevenueSplit(uint256 toBridge, uint256 toNodeFund)",
    "event PushSucceeded(address indexed to, uint256 amount)",
    "event PushFailed(address indexed to, uint256 amount)",
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
  // 奖励按「天」结算（经济模拟的第三个救命发现：每天见证一次），所以这几个事件的参数名是 day，不是 epoch。
  ValidatorStaking: [
    "event Staked(address indexed who, uint256 amount, uint256 total)",
    "event UnstakeRequested(address indexed who, uint256 amount, uint64 unlockAt)",
    "event Unstaked(address indexed who, address indexed to, uint256 amount)",
    "event NodeRegistered(bytes32 indexed nodeIdHash, address indexed validator, address payout, string enodeURI)",
    "event NodeRetired(bytes32 indexed nodeIdHash)",
    "event AttestationCommitted(uint64 indexed epoch, address indexed validator, bytes32 commitment)",
    "event AttestationRevealed(uint64 indexed epoch, address indexed validator, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, bool agreeing, uint256 weight)",
    "event DayAttested(uint64 indexed day, address indexed validator, bytes32 head, bool ok, uint256 weight)",
    "event DayCredited(uint64 indexed day, address indexed validator, uint256 weight)",
    "event RewardsFunded(address indexed from, uint256 amount, uint256 balanceAfter)",
    "event RewardsSettled(uint64 indexed day, uint256 pot, uint256 weight, uint256 rate)",
    "event RewardClaimed(uint64 indexed day, address indexed validator, address indexed to, uint256 amount)",
    "event RewardExpired(uint64 indexed day, uint256 returned)",
    "event NodeStruck(bytes32 indexed nodeIdHash, uint32 strikes)",
    "event ValidatorRemovalQueued(address indexed v, bytes32 reasonHash, uint64 eta)",
    "event ValidatorRemovalCancelled(address indexed v, address indexed by)",
    "event ValidatorRemoved(address indexed v)",
  ],
  BacNodeFund: [
    "event ReleaseReceived(address indexed from, uint256 amount, uint256 balanceAfter)",
    "event Withdrawn(address indexed to, uint256 amount, uint256 balanceAfter)",
    "event OwnershipTransferStarted(address indexed from, address indexed to)",
    "event OwnershipTransferred(address indexed from, address indexed to)",
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
  BacBridge: "bsc",
  BacTaxRouter: "bsc",
  ChainAnchor: "bsc",
  ValidatorStaking: "bsc",
  BacNodeFund: "bsc",
  L2Bridge: "layer",
  L2Gate: "layer",
  AgentBook: "layer",
};

/**
 * BSC 上那些**只读 view、不摄日志**的地址（config 的地址簿里有，但 eth_getLogs 不带它们）：
 * 代币本身（发射后 Transfer 会淹没 logs 表）、Flap 的 TaxProcessor / Portal、ERC-8004 注册表（35 万个身份的事件）。
 */
export const READ_ONLY_BSC = ["BacToken", "TaxProcessor", "FlapPortal", "IdentityRegistry"];

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
/** 设计上的创世总量 1e27 wei（全在 L2Bridge 里）。**对账以创世文件为准**，读不到文件才退回这个数（见 src/genesis.js）。 */
export const GENESIS_SUPPLY = 10n ** 27n;

// ===== BSC 主网上的固定事实（只在 bscChainId = 56 时作默认值；环境变量可以覆盖）=====

/** ERC-8004 Identity Registry（决策 #31；docs/research/12 §1.9）。UUPS 代理，owner 不是我们。 */
export const BSC_IDENTITY_REGISTRY = getAddress("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
/** Flap Portal（普通版，v5.24.0）。决策 #30 之后用它读代币状态，不再用 VaultPortal。 */
export const BSC_FLAP_PORTAL = getAddress("0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0");
/** BAC 代币地址（决策 #35，lockSalt 已上链）。**发射前这个地址上没有代码。** */
export const BSC_BAC_TOKEN = getAddress("0xA97452d175679B2bF5F25a9a382D22aff39b7777");

/** EIP-1967 实现槽：bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)。 */
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** Flap Portal 的 TokenStatus（IPortal.sol）。 */
export const FLAP_TOKEN_STATUS = {
  0: "Invalid",
  1: "Tradable",
  2: "InDuel",
  3: "Killed",
  4: "DEX",
  5: "Staged",
};
