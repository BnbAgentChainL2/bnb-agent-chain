// 只放看门狗真正用到的那几条 ABI（人类可读格式）。
// 来源：contracts/src/BacBridge.sol、contracts/src/ChainAnchor.sol、contracts/src/layer/L2Bridge.sol。
// **与合约源码不一致时以合约源码为准** —— 看门狗比较的是链上真实状态，抄错一个字段名
// 就会变成一条永远成立的误报。

/** BSC：BacBridge。写操作只有一个：pause() */
export const BAC_BRIDGE_ABI = [
  // --- 事件（影子账本的全部输入）---
  'event Locked(uint256 indexed depositId, uint256 indexed agentId, address indexed from, address layerWallet, uint256 measured, uint256 credits, uint256 totalIssued)',
  'event ReleaseReceived(address indexed from, uint256 amount, uint256 bnbAfter)',
  'event Untracked(uint256 amount, uint256 bnbAfter)',
  'event UntrackedBac(uint256 amount, uint256 buybackBacAfter)',
  'event BoughtBack(address indexed by, uint8 venue, uint256 bnbSpent, uint256 bacBought, uint256 buybackBacAfter)',
  'event BuybackSkipped(uint8 reason, uint256 budget)',
  'event ExitClaimed(uint64 indexed anchorEpoch, uint256 indexed exitId, uint256 indexed agentId, address to, uint256 credits, uint256 lockedBacAmt, uint256 rate, uint256 attributed)',
  'event EpochSettled(uint64 indexed epoch, uint256 pot, uint256 owedTotalAfter, uint16 releaseBps, bool skipped)',
  'event Collected(address indexed who, address indexed to, uint256 amount, uint256 owedLeft)',
  'event EpochOwedRevoked(uint64 indexed epoch, address indexed by, uint256 revoked)',
  'event Halted(uint8 cause)',
  'event OwedPaidAfterHalt(address indexed who, address indexed to, uint256 amount)',
  'event EscapeCollected(uint256 indexed agentId, address indexed to, uint256 bacPaid, uint256 bnbPaid)',
  'event Paused(address indexed by, uint64 until_, uint64 cumulative)',
  'event Unpaused(address indexed by, uint64 cumulative)',
  'event LockedBurned(uint256 amount)',
  // --- 两个桶与它们的账面 ---
  'function lockedBac() view returns (uint256)',
  'function totalBurned() view returns (uint256)',
  'function buybackBac() view returns (uint256)',
  'function bacAccounted() view returns (uint256)',
  'function bnbBalance() view returns (uint256)',
  'function buybackBudget() view returns (uint256)',
  'function buybackBacBought() view returns (uint256)',
  'function buybackBnbSpent() view returns (uint256)',
  // --- 积分与债权 ---
  'function totalCreditsIssued() view returns (uint256)',
  'function totalCreditsExited() view returns (uint256)',
  'function creditsOutstanding() view returns (uint256)',
  'function owedTotal() view returns (uint256)',
  'function reservedTotal() view returns (uint256)',
  'function releasedInWindow() view returns (uint256)',
  'function lastSettledEpoch() view returns (uint64)',
  'function skippedEpochs() view returns (uint64)',
  'function lastEpochRelease() view returns (uint256 pot, uint64 settledAt, uint16 releaseBps)',
  // --- 刹车 ---
  'function isPaused() view returns (bool, uint64, uint64)',
  'function isHalted() view returns (bool)',
  'function watchdog() view returns (address)',
  'function pause()',
  // --- 链上常量：启动时与 src/constants.mjs 逐一核对 ---
  'function EPOCH() view returns (uint64)',
  'function EPOCHS_PER_DAY() view returns (uint64)',
  'function ANCHOR_WAIT() view returns (uint64)',
  'function MIN_BUYBACK_BNB() view returns (uint256)',
  'function MAX_BUYBACK_BNB() view returns (uint256)',
  'function MAX_BUY_SLIPPAGE_BPS() view returns (uint16)',
  'function MAX_PAUSE_TOTAL() view returns (uint64)',
  'function DEAD() view returns (address)',
];

/** BSC：ChainAnchor。写操作只有 veto()，而且只在运维把 vetoKey 交给本进程时才用得到 */
export const CHAIN_ANCHOR_ABI = [
  'event AnchorPosted(uint64 indexed epoch, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, uint128 credited, uint128 exitCredits, uint128 feeBurned, uint128 circulating, uint32 exitCount)',
  'event AnchorFinalized(uint64 indexed epoch, uint32 agreeingCount, uint16 releaseBps)',
  'event AnchorVetoed(uint64 indexed epoch, address indexed by, bytes32 reasonHash, uint8 countInWindow)',
  'event AnchorDisputed(uint64 indexed epoch, uint256 agreeingWeight, uint256 disputingWeight, uint32 disputingCount, uint8 countInWindow)',
  'function getAnchor(uint64 epoch) view returns ((bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, uint64 postedAt, uint64 finalizedAt, uint128 creditedInEpoch, uint128 exitCreditsInEpoch, uint128 feeBurnedInEpoch, uint128 circulating, uint32 exitCount, uint32 agreeingCount, uint8 state))',
  'function lastPostedEpoch() view returns (uint64)',
  'function lastFinalEpoch() view returns (uint64)',
  'function releaseBpsFor(uint64 epoch) view returns (uint16)',
  'function relayer() view returns (address)',
  'function vetoKey() view returns (address)',
  'function EPOCH() view returns (uint64)',
  'function ANCHOR_WAIT() view returns (uint64)',
  'function veto(uint64 epoch, bytes32 reasonHash)',
];

/** BSC：BAC 代币。只读余额 —— 「两个桶 vs 真实余额」这条规则的另一半 */
export const ERC20_ABI = [
  'function balanceOf(address who) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
];

/** 层内：L2Bridge @ 0x…0101。退出叶子与入账的唯一来源 */
export const L2_BRIDGE_ABI = [
  'event CreditsMinted(bytes32 indexed depositId, uint256 indexed agentId, address indexed to, uint256 amount)',
  'event ExitBurned(uint256 indexed exitId, uint256 indexed agentId, address indexed bscRecipient, uint256 amount, uint64 epoch)',
  'event FloatBurned(address indexed from, uint256 amount)',
  'function seen(bytes32 depositId) view returns (bool)',
  'function totalCredited() view returns (uint256)',
  'function totalExited() view returns (uint256)',
];

/** PancakeSwap V2 router：回购滑点复算时的参考价 */
export const PANCAKE_ROUTER_ABI = ['function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])'];

/**
 * Flap Portal 的 lens。**故意不用 typed interface**：`getTokenV8Safe` 返回 18 个静态字段的
 * 扁平元组，合约自己是直接从 returndata 里挖三个 word 的（word 0 status、word 3 price、
 * word 12 buyTaxRate）。看门狗要复算的正是合约当时算的那三个数，所以读法必须一模一样。
 */
export const SEL_TOKEN_STATE = 'getTokenV8Safe(address)';

/** WBNB（BacBridge.WBNB，逐字） */
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
