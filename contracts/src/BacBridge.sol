// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/utils/cryptography/MerkleProof.sol";
import {Initializable} from "@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin-contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin-contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {Erc8004Gate} from "./lib/Erc8004Gate.sol";
import {IChainAnchor} from "./interfaces/IChainAnchor.sol";

/// @title BacBridgeCore
/// @notice Everything `BacBridge` and `BacBridgeExtension` must agree on byte for byte: the
///         constants, the ONE storage layout, the owner rules and the internal helpers both of
///         them call. Never deployed on its own. (Events are declared on `BacBridge`, so that
///         `BacBridge.EventName` resolves; the extension carries copies of the ones it emits.)
/// @dev Why two contracts at all: with the owner powers of decision #29, the UUPS machinery and
///      the bilingual revert strings, a single bridge compiles to about 29 KB of runtime code —
///      over the 24,576-byte EIP-170 limit. The rarely-called paths (owner withdrawals, watchdog
///      tools, the halt / escape machinery) and the keeper's once-per-epoch `settleEpoch`
///      therefore live in `BacBridgeExtension`, which the implementation deploys from its own
///      constructor and reaches by DELEGATECALL. Both inherit
///      this contract and nothing else declares storage, so the two can never disagree on a slot.
abstract contract BacBridgeCore is Initializable, Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    // ------------------------------------------------------------------ constants

    /// @notice Decision #29a, word for word. The chain, the site and every X post must agree.
    string public constant OWNER_POWER_NOTICE =
        unicode"项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。";
    /// @notice Decision #31a, word for word.
    string public constant IDENTITY_LIMIT_NOTICE = unicode"我们要求持有 agent 身份，我们不能证明它是 AI。";

    /// @notice 10 minutes (decision #20). Everything "per day" below divides by `EPOCHS_PER_DAY`.
    uint64 public constant EPOCH = 600;
    /// @notice 144. Only ever used as the release / buyback divisor: the per-epoch rate is not
    ///         expressible in integer bps, so the contract stores the daily rate and divides.
    uint64 public constant EPOCHS_PER_DAY = 144;
    /// @notice The anchor's waiting period (decision #25). Enforced by `ChainAnchor`; mirrored
    ///         here so that the bridge's own ABI states the number the product promises.
    uint64 public constant ANCHOR_WAIT = 120;

    uint64 public constant SETTLE_GRACE = 7 days;
    /// @notice Per-address speed limit of `collect`: 10% of what the daily release rate lets the
    ///         whole bucket release in one epoch, i.e. `buybackBac * lastPotBps / (10000 * 144)`.
    /// @dev    Measured against the RATE, not against the last pot. A pot is clamped to the owed
    ///         that no pot has reached yet, so it drops to 0 as soon as everything owed has been
    ///         released — and a cap of "10% of the last pot" would then lock every address out of
    ///         BAC that is already reserved for it (review finding, 2026-09-23).
    uint16 public constant MAX_EXIT_SHARE_BPS = 1000;
    /// @notice How many epochs of the per-address speed limit one `collect` may claim at once.
    ///         Without it an honest exiter would have to call `collect` 144 times a day to be paid
    ///         at their own entitled rate; with it, once a day is bit-for-bit the same rate limit.
    uint64 public constant MAX_CATCHUP_EPOCHS = 144;
    uint16 public constant NO_ATTEST_WINDOW_BPS = 1500;
    /// @notice The zero-witness ceiling window, in DAYS (day-aggregated buckets). As 30 epochs it
    ///         would be 5 hours, i.e. 15% per 5 hours = no ceiling at all.
    uint64 public constant NO_ATTEST_WINDOW = 30;
    uint64 public constant PAUSE_LEN = 7 days;
    uint64 public constant MAX_PAUSE_TOTAL = 21 days;
    /// @notice Explicitly does NOT shrink with the epoch. After the wait drops to 120 s this is
    ///         the only remaining time guard in the halt / escape / revoke path.
    uint64 public constant OWED_MATURITY = 14 days;
    uint64 public constant ESCAPE_ARM_DELAY = 14 days;

    /// @notice Spend 20% of the BNB bucket per day. Idle BNB 3.6%, slippage 0.214% of volume.
    uint16 public constant BUYBACK_DAILY_BPS = 2000;
    /// @notice Accrue the budget, buy only when it clears this floor. One buyback is ~220,000 gas
    ///         ~= 0.000011 BNB = 0.11% of the buy. This single constant makes the cadence
    ///         self-adapting: near-every-epoch when viral, about twice a month when dead.
    uint256 public constant MIN_BUYBACK_BNB = 0.01 ether;
    /// @notice At 20 BNB quote depth this is 2.4% impact — the sandwicher's maximum prize per call.
    uint256 public constant MAX_BUYBACK_BNB = 0.5 ether;
    /// @notice The guard that actually binds: at 10 BNB depth a 0.5 BNB buy already exceeds 3% and
    ///         the call reverts, forcing the keeper to split.
    uint16 public constant MAX_BUY_SLIPPAGE_BPS = 300;
    uint64 public constant BUYBACK_MIN_INTERVAL = 1;
    /// @notice Reference size used to read a near-spot price off the DEX (impact is negligible).
    uint256 public constant BUYBACK_QUOTE_REF = 0.001 ether;
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    /// @dev The four venue selectors, spelled out so that the buyback needs no interface import
    ///      and pays no ABI-decoding code for struct fields it never reads. Signatures are
    ///      `src/flap/IPortal.sol` (`IPortalLens`, `IPortalTrade`) and
    ///      `src/interfaces/IPancakeV2Router.sol`, verbatim.
    bytes4 internal constant SEL_TOKEN_STATE = bytes4(keccak256("getTokenV8Safe(address)"));
    /// @dev `IPortalTrade.buy` is DEAD on the live Portal - it reverts `FeatureDisabled()`
    ///      (measured on a mainnet fork, v5.23.1). `IPortalTradeV2.swapExactInput` is the entry
    ///      point that actually trades a V3 tax token on the curve.
    bytes4 internal constant SEL_SWAP_EXACT_IN =
        bytes4(keccak256("swapExactInput((address,address,uint256,uint256,bytes))"));
    bytes4 internal constant SEL_AMOUNTS_OUT = bytes4(keccak256("getAmountsOut(uint256,address[])"));
    bytes4 internal constant SEL_SWAP_ETH =
        bytes4(keccak256("swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)"));

    uint256 public constant LAYER_CHAIN_ID = 56777;
    /// @notice The release index (`ReleasePoint.p`) restarts at this value and is kept in
    ///         [RELEASE_FLOOR, RELEASE_ONE] by multiplying it by `RELEASE_RESCALE` (and counting
    ///         that in `scale`) whenever it falls below the floor. 36 digits of headroom make the
    ///         rounding of one pot worth far less than 1 wei on any BAC-sized debt.
    uint256 public constant RELEASE_ONE = 1e45;
    uint256 public constant RELEASE_FLOOR = 1e36;
    uint256 public constant RELEASE_RESCALE = 1e9;
    bytes32 public constant EXIT_TYPEHASH = keccak256(
        "Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)"
    );

    /// @notice The only destination a NON-owner call can send locked BAC to (see `burnLocked`).
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ==================================================================
    //   STORAGE. Append-only below this line, and never reorder: every
    //   slot is fixed by the proxy for the life of the bridge. A new
    //   version adds its variables at the END of this block, just above
    //   `__gap`, and shrinks `__gap` by the same number of slots.
    // ==================================================================

    // ------------------------------------------------------------------ wiring

    /// @dev These six were `immutable` while the bridge was not upgradeable. Under a proxy an
    ///      immutable lives in the IMPLEMENTATION's code, not in storage, so every upgrade would
    ///      silently re-bake all six from whatever the new implementation's constructor was
    ///      handed. A BAC token address or an identity registry that can change by accident
    ///      during an upgrade is precisely the failure this project cannot afford, so they are
    ///      storage, written once in `initialize` and given no setter.
    address public bacToken;
    /// @notice The ERC-8004 Identity Registry this bridge takes its entry gate from (decision #31).
    /// @dev On BSC mainnet that is 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 — the address listed
    ///      by the erc-8004/erc-8004-contracts repository, NOT merely "the official one": a second
    ///      contract on BSC also calls itself an ERC-8004 identity registry
    ///      (0xfA09B3397fAC75424422C4D28b1729E3D4f659D7, name() = "BRC8004 Identity Registry"), so
    ///      the copy names the address and never just the word "official".
    ///
    ///      It is a UUPS proxy whose owner can replace the implementation at any time. That means
    ///      this bridge has outsourced its entry rule to a contract we neither control nor govern;
    ///      the watchdog therefore watches the registry's EIP-1967 implementation slot and pauses
    ///      on a change. No setter here: repointing the gate takes an upgrade, which is itself
    ///      logged by `BridgeUpgraded` and shown on the public timeline.
    address public identityRegistry;
    address public anchor;
    address public watchdog;
    /// @notice Flap Portal. Read-only for venue detection, plus `buy()` while BAC is on the curve.
    address public portal;
    /// @notice PancakeSwap V2 router, used only once BAC has graduated to the DEX.
    address public router;

    // ------------------------------------------------------------------ entry-side accounting

    /// @notice Bucket 1: everything ever deposited on entry. The ordinary way it leaves is
    ///         `burnLocked()` to `DEAD`, and no EXIT path reads it — but since decision #29
    ///         `emergencyWithdrawToken` reaches it like everything else here.
    uint256 public lockedBac;
    uint256 public totalBurned;

    uint256 public totalCreditsIssued;
    uint256 public totalCreditsExited;
    uint256 public depositId;

    mapping(uint256 => uint256) public credited;
    mapping(uint256 => uint256) public exitedCredits;
    uint256 public unattributedExited;

    // ------------------------------------------------------------------ the two payout buckets

    /// @notice Bucket 2: BAC bought on the market. The ONLY source an exit may be paid from.
    uint256 public buybackBac;
    /// @notice Tax BNB held for the buyback (rule 010: recognised revenue, never the raw balance).
    uint256 public bnbBalance;
    /// @notice The part of `bnbBalance` already accrued as buyback budget but not yet spent.
    uint256 public buybackBudget;
    uint64 public lastBuybackEpoch;
    uint256 public buybackBacBought;
    uint256 public buybackBnbSpent;

    // ------------------------------------------------------------------ exit-side accounting (BAC)

    /// @dev A point of the release index. Every pot releases the SAME fraction
    ///      `pot / (owedTotal - reservedTotal)` of every address's still-unreleased owed, so what
    ///      an address has left unreleased is `unreleased_then * p_now / p_then`:
    ///        - `p`      the running product of `(1 - that fraction)` over every pot, rescaled;
    ///        - `scale`  how often `p` was multiplied by `RELEASE_RESCALE` to stay above the floor;
    ///        - `gen`    how many FULL releases (a pot equal to everything unreleased) there have
    ///                   been. A full release sets `p` back to `RELEASE_ONE`; a snapshot from an
    ///                   older generation has nothing unreleased left.
    ///      This replaced a MasterChef accumulator over the whole `owedTotal`, which kept handing
    ///      part of every pot to owed that was already released — BAC that `collect` could then
    ///      never pay, sitting in `reservedTotal` while later exiters were starved (review finding
    ///      and the B3 invariant failure of 2026-09-23).
    struct ReleasePoint {
        uint160 p;
        uint48 scale;
        uint48 gen;
    }

    uint256 public owedTotal;
    /// @notice Released-but-not-yet-collected BAC. `owedTotal - reservedTotal` is the owed that no
    ///         pot has reached yet, and it is what a pot is shared out over.
    uint256 public reservedTotal;
    ReleasePoint public releaseIndex;

    mapping(address => uint256) public owed;
    /// @notice Released to `who` and not yet collected, as of `who`'s last harvest. Never above `owed`.
    mapping(address => uint256) public unclaimed;
    /// @notice `releaseIndex` as of `who`'s last harvest.
    mapping(address => ReleasePoint) public releaseSnap;
    mapping(address => uint64) public lastClaimAt;
    mapping(address => uint64) public lastCollectEpoch;
    mapping(uint256 => bool) public exitClaimed;
    /// @notice How much owed each address locked against one anchor epoch — the ledger
    ///         `revokeEpochOwed` needs to void exactly one forged anchor and nothing else.
    mapping(uint64 => mapping(address => uint256)) public epochOwed;

    uint64 public lastSettledEpoch;
    uint64 public skippedEpochs;
    uint256 public lastPot;
    uint64 public lastPotSettledAt;
    uint16 public lastPotBps;

    /// @dev One day-aggregated bucket of the zero-witness window.
    struct DayPot {
        uint128 amount;
        uint64 day;
    }

    uint256 public releasedInWindow;
    mapping(uint256 => DayPot) internal potRing;

    // ------------------------------------------------------------------ brake / halt / escape

    uint64 public pauseStartedAt;
    uint64 public pausedUntil;
    uint64 public pausedCumulative;

    bool internal halted;
    uint8 public haltCause;
    uint64 public haltedAt;
    uint64 public escapeArmedAt;
    uint8 public armedCause;

    uint256 public escapeTotalWeight;
    uint256 public accPerWeightBac;
    uint256 public accPerWeightBnb;
    uint256 public escapeDistributedBac;
    uint256 public escapeDistributedBnb;
    mapping(uint256 => uint256) public escapeDebtBac;
    mapping(uint256 => uint256) public escapeDebtBnb;

    // ------------------------------------------------------------------ entry records (#31)

    /// @notice One row per `lock()`, so the explorer can attribute layer activity to the ERC-8004
    ///         identity that paid for it without replaying every log, and so the identity behind a
    ///         deposit survives even if that identity is later transferred, burned or the registry
    ///         is upgraded under us.
    struct Deposit {
        address from;
        uint64 at;
        uint256 agentId;
        uint256 amount;
    }

    mapping(uint256 => Deposit) public deposits;

    /// @notice Who may call `escapeCollect` for an agent id. Written at that id's FIRST entry and
    ///         thereafter moved only by its current holder, via `setAgentController`.
    /// @dev    Deliberately NOT a live ERC-8004 read. An identity is a transferable ERC-721 held
    ///         on a third-party UUPS proxy: if the escape path asked the registry "does this
    ///         address still hold the identity?", then selling the NFT, losing it, or an upstream
    ///         implementation swap would strand the deposit behind it. Entry is gated on identity
    ///         (decision #31); the exit never is, and that rule is load-bearing.
    mapping(uint256 => address) public agentController;

    // ------------------------------------------------------------------ owner powers (#29)

    /// @notice Lifetime BNB / BAC taken out by the two emergency withdrawals. The books above are
    ///         NOT written down when the owner withdraws: they go on saying what the bridge owed,
    ///         and these counters say what left THROUGH THOSE TWO FUNCTIONS, so the public timeline
    ///         (#29c) can show both numbers side by side instead of one quietly rewritten one.
    /// @dev    They are NOT the complete record of money leaving the bridge. An upgrade can move
    ///         the whole pool without touching them: `upgradeToAndCall` runs arbitrary new code in
    ///         the same transaction, after `BridgeUpgraded` has already snapshotted the books, and
    ///         that code can also rewrite the books themselves (so `shortfall()` would read 0).
    ///         Anyone reconstructing withdrawals must also diff the bridge's PHYSICAL BNB and BAC
    ///         balances around every `BridgeUpgraded` / `Upgraded` transaction (review finding,
    ///         2026-09-23). Decision #29a already discloses the power; this is about not
    ///         overstating what the counters prove.
    uint256 public emergencyBnbWithdrawn;
    uint256 public emergencyBacWithdrawn;
    uint64 public emergencyCount;
    uint64 public lastEmergencyAt;
    uint64 public upgradeCount;
    uint64 public lastUpgradeAt;

    // ------------------------------------------------------------------ v1.1: per-debt maturity

    /// @dev One point of an address's claim history: `cum` is the total BAC ever locked for it by
    ///      `claimExit` up to and including time `at`.
    struct ClaimPoint {
        uint64 at;
        uint192 cum;
    }

    /// @notice Every `claimExit` in favour of an address, as a running total (one point per block).
    /// @dev    Maturity is a property of each DEBT, not of the address. With the single per-address
    ///         `lastClaimAt` that v1 used, anybody could send a dust exit to someone else's address
    ///         (`L2Bridge.exit` lets the exiter name any recipient and `claimExit` is
    ///         permissionless) and make that address's whole, long-matured claim immature again:
    ///         demotable by `sweepImmatureOwed` after a cause-2/3 halt and revocable by the watchdog
    ///         (review finding, 2026-09-23). The history lets `_maturedOwed` count only what was
    ///         really claimed before the cut-off, whatever was added afterwards.
    ///         Added by the first upgrade (slot 350); `lastClaimAt` is still written, for display.
    mapping(address => ClaimPoint[]) internal claimHistory;
    /// @notice BAC paid to an address against its owed (`collect`, `claimOwedAfterHalt`). Payments
    ///         are counted against the OLDEST debt first, which can only ever make the matured part
    ///         smaller, never larger. Slot 351.
    mapping(address => uint256) public owedPaid;

    /// @dev Room for the next versions. Adding a variable ABOVE this line is a storage-layout
    ///      break; adding one immediately above it and dropping `__gap` by the same count is not.
    ///      42 in the first deployed version; the two mappings above took slots 350 and 351.
    uint256[40] private __gap;

    // ==================================================================
    //  OWNER RULES  (decision #29) — shared, so they hold in both contracts
    // ==================================================================

    /// @notice DISABLED, deliberately. Renouncing would freeze upgrades and both emergency
    ///         withdrawals forever, and decision #29 keeps those powers on purpose ("资金卡死就 g 了"):
    ///         a bridge whose bug can no longer be fixed and whose money can no longer be moved is
    ///         the exact outcome the owner powers exist to prevent. Handing the powers on is
    ///         `transferOwnership` + `acceptOwnership`; giving them up needs an upgrade, which is
    ///         logged. OpenZeppelin's `transferOwnership(address(0))` only clears a pending
    ///         transfer: address zero can never accept.
    function renounceOwnership() public pure override {
        revert(unicode"Renounce disabled / 已禁用放弃所有权");
    }

    /// @dev Bilingual wording for `onlyOwner`, the same as `BacNodeFund`.
    function _checkOwner() internal view override {
        require(owner() == msg.sender, unicode"Only owner / 仅限 owner");
    }

    /// @notice Step two of an ownership transfer; only the pending owner may call it.
    function acceptOwnership() public override {
        require(pendingOwner() == msg.sender, unicode"Only pending owner / 仅限待定 owner");
        _transferOwnership(msg.sender);
    }

    function _noteEmergency() internal returns (uint64 n) {
        n = ++emergencyCount;
        lastEmergencyAt = uint64(block.timestamp);
    }

    // ==================================================================
    //  SHARED READS
    // ==================================================================

    /// @notice The BAC this contract's books account for: locked-not-yet-burned plus the buyback
    ///         bucket. `balanceOf(bridge)` is never below it (rule 010).
    function bacAccounted() public view returns (uint256) {
        return lockedBac - totalBurned + buybackBac;
    }

    function isPaused() public view returns (bool, uint64 until_, uint64 cumulative) {
        return (pausedUntil > block.timestamp, pausedUntil, pausedCumulative + _pauseUsed());
    }

    function isHalted() public view returns (bool) {
        return halted;
    }

    // ==================================================================
    //  SHARED INTERNALS
    // ==================================================================

    /// @dev The single accounting path for incoming BNB. `bnbBalance` ALWAYS grows; once halted
    ///      the same wei is additionally handed to the junior accumulator, otherwise post-halt
    ///      revenue would have no legal claimant (or `escapeCollect` would underflow, §4.2).
    function _accept(uint256 amount) internal {
        bnbBalance += amount;
        if (halted && escapeTotalWeight > 0) {
            accPerWeightBnb += (amount * 1e18) / escapeTotalWeight;
        }
    }

    /// @dev The single accounting path into `buybackBac`, with the same post-halt rule.
    function _acceptBac(uint256 amount) internal {
        buybackBac += amount;
        if (halted && escapeTotalWeight > 0) {
            accPerWeightBac += (amount * 1e18) / escapeTotalWeight;
        }
    }

    /// @dev What of `who`'s owed no pot has reached yet. At `who`'s last harvest that was exactly
    ///      `owed - unclaimed` (every path that changes either of them harvests first); every pot
    ///      since then kept the fraction `p_now / p_then` of it. Rounds DOWN, so an address is
    ///      never shown less released than it really is by more than 1 wei.
    function _unreleased(address who) internal view returns (uint256 u) {
        u = owed[who] - unclaimed[who];
        if (u == 0) return 0;
        ReleasePoint memory g = releaseIndex;
        ReleasePoint memory s = releaseSnap[who];
        // generation first: a snapshot from before a full release may carry a larger `scale`
        if (g.gen != s.gen) return 0;
        uint256 d = g.scale - s.scale;
        // four rescales shrink the ratio below 1e-27: under 1 wei of any BAC-sized debt
        if (d > 3) return 0;
        return (u * g.p) / s.p / (RELEASE_RESCALE ** d);
    }

    /// @dev Releases `pot` out of `headroom` (= `owedTotal - reservedTotal`, the owed no pot has
    ///      reached yet, `0 < pot <= headroom`): every address's unreleased part shrinks by the
    ///      same fraction `pot / headroom`. A pot equal to the headroom is a full release: a new
    ///      generation, so every older snapshot reads as fully released, and `p` starts over.
    function _advanceRelease(uint256 pot, uint256 headroom) internal {
        ReleasePoint memory g = releaseIndex;
        if (pot == headroom) {
            g = ReleasePoint(uint160(RELEASE_ONE), 0, g.gen + 1);
        } else {
            uint256 p = (uint256(g.p) * (headroom - pot)) / headroom;
            // p >= RELEASE_FLOOR / headroom, far above 0 for any BAC-sized debt; the guard only
            // keeps the loop below finite if that were ever false
            if (p == 0) p = 1;
            while (p < RELEASE_FLOOR) {
                p *= RELEASE_RESCALE;
                ++g.scale;
            }
            g.p = uint160(p);
        }
        releaseIndex = g;
    }

    /// @dev Moves everything released since `who`'s last harvest into `unclaimed`, then re-bases.
    function _harvest(address who) internal {
        uint256 u = owed[who] - unclaimed[who];
        if (u != 0) unclaimed[who] += u - _unreleased(who);
        releaseSnap[who] = releaseIndex;
    }

    /// @dev Appends `amount` of new debt for `to` to its claim history, at the current time. The
    ///      first point of an address that already holds owed from before the history existed (an
    ///      upgrade over live claims) carries that old debt at its old `lastClaimAt`, so the upgrade
    ///      itself can never make an existing claim younger. Call BEFORE `owed[to]` grows.
    function _noteClaim(address to, uint256 amount) internal {
        ClaimPoint[] storage h = claimHistory[to];
        uint256 n = h.length;
        uint256 cum;
        if (n == 0) {
            cum = owed[to] + owedPaid[to];
            if (cum != 0) {
                h.push(ClaimPoint(lastClaimAt[to], uint192(cum)));
                n = 1;
            }
        } else {
            cum = h[n - 1].cum;
        }
        cum += amount;
        if (n != 0 && h[n - 1].at == uint64(block.timestamp)) {
            h[n - 1].cum = uint192(cum);
        } else {
            h.push(ClaimPoint(uint64(block.timestamp), uint192(cum)));
        }
    }

    /// @dev The part of `owed[who]` that was claimed at or before `cutoff` and has not been paid:
    ///      the matured, senior part when `cutoff` is `OWED_MATURITY` before the moment that
    ///      matters. Payments are counted against the oldest debt first; a revoke or a demotion
    ///      shrinks `owed` itself, and the `min` keeps the result within it.
    function _maturedOwed(address who, uint256 cutoff) internal view returns (uint256) {
        uint256 o = owed[who];
        if (o == 0) return 0;
        ClaimPoint[] storage h = claimHistory[who];
        uint256 hi = h.length;
        uint256 claimed;
        if (hi == 0) {
            // owed from before the history existed: one debt, dated by `lastClaimAt`
            if (lastClaimAt[who] <= cutoff) claimed = o + owedPaid[who];
        } else {
            // the last point at or before `cutoff` (binary search over a sorted history)
            uint256 lo;
            while (lo < hi) {
                uint256 mid = (lo + hi) / 2;
                if (h[mid].at <= cutoff) lo = mid + 1;
                else hi = mid;
            }
            if (lo != 0) claimed = h[lo - 1].cum;
        }
        uint256 paid = owedPaid[who];
        if (claimed <= paid) return 0;
        claimed -= paid;
        return claimed < o ? claimed : o;
    }

    /// @dev `t - OWED_MATURITY`, floored at 0.
    function _maturityCutoff(uint256 t) internal pure returns (uint256) {
        return t > OWED_MATURITY ? t - OWED_MATURITY : 0;
    }

    /// @dev Time of the current (or last, expired-but-unsettled) pause that is not yet counted.
    function _pauseUsed() internal view returns (uint64) {
        if (pausedUntil == 0) return 0;
        uint64 end = uint64(block.timestamp) < pausedUntil ? uint64(block.timestamp) : pausedUntil;
        return end > pauseStartedAt ? end - pauseStartedAt : 0;
    }

    function _pendingCause() internal view returns (uint8) {
        uint8 r = IChainAnchor(anchor).haltReason();
        if (r != 0) return r;
        if (pausedCumulative + _pauseUsed() >= MAX_PAUSE_TOTAL) return 5;
        return 0;
    }

    function _payout(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, unicode"BNB transfer failed / BNB 转账失败");
    }

    function _pullBac(address from, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            bacToken.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), unicode"BAC transferFrom failed / BAC 转入失败");
    }

    function _pushBac(address to, uint256 amount) internal {
        _pushToken(bacToken, to, amount);
    }

    /// @dev Every BAC payout to an EXITER goes through here. What stays behind must still cover
    ///      the unburned deposits, so an exit can only ever be paid out of bought-back BAC that is
    ///      physically present. Without an owner withdrawal this always holds (B6); after one
    ///      (#29) it turns "the payout bucket is gone" into a clean refusal instead of quietly
    ///      paying the exit out of `lockedBac`.
    function _payExitBac(address to, uint256 amount) internal {
        require(
            IERC20(bacToken).balanceOf(address(this)) >= lockedBac - totalBurned + amount,
            unicode"Bridge short of BAC / 桥内 BAC 不足"
        );
        _pushToken(bacToken, to, amount);
    }

    function _pushToken(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), unicode"Token transfer failed / 代币转出失败");
    }
}

/// @title BacBridge
/// @notice BSC side of the BNB Agent Chain bridge (docs/01-CONTRACT-SPEC.md §4, decisions #20/#24/#25).
///
///         TWO BAC BUCKETS, strictly separated (decision #24a②, kept by #29b② for clean books):
///           - `lockedBac`   what agents deposited on entry. No exit path reads it; its only
///                           non-owner way out is `burnLocked()` to the hard-coded dead address.
///                           It is NOT locked forever: the owner's `emergencyWithdrawToken` and
///                           any upgrade reach it like everything else here (decision #29).
///           - `buybackBac`  BAC bought back on the market with the bridge's tax BNB. This is the
///                           ONLY bucket an exit can ever be paid from.
///         Every function below that moves BAC names its bucket explicitly, every BAC payout to an
///         exiter checks that what stays behind still covers the unburned deposits
///         (`_payExitBac`), and the invariant suite proves no NON-owner call path can pay an exit
///         out of `lockedBac`. Owner withdrawals are exempt by design and counted on their own.
///
///         MONEY MODEL (model A = STOCK of the buyback simulation, artifacts/sim/RESULTS-buyback.md):
///         BNB arrives from `BacTaxRouter`'s tax split, is spent on a bounded, permissionless,
///         scheduled buyback, and the BAC it buys piles up in `buybackBac`. An exit locks a
///         BAC-denominated share of that stock at claim time (M1) — `lockedBacAmt = credits *
///         free / outstanding` with `free = buybackBac - owedTotal` — and that debt is released
///         through a single O(1) release index (M4, `ReleasePoint`): each pot releases the same
///         fraction of every address's not-yet-released owed. Because the debt and the asset are
///         the same unit, `owedTotal <= buybackBac` holds by construction: the bridge cannot
///         become insolvent by a price move. An exit never touches the market, so its price
///         impact is exactly zero.
///
///         HONEST COST (decision #24b): taking BAC out instead of BNB costs roughly 4% more in
///         total — the buyback pays ~2% buy tax plus slippage, and an exiter who then wants BNB
///         pays ~2% sell tax plus slippage. The exiter is strictly worse off; the only beneficiary
///         is the buy pressure. Nothing in this contract makes an exit cheaper.
///
///         ANCHOR WAIT (decisions #18/#25): the anchor's waiting period is 120 seconds and is
///         called a wait, never a challenge. At 120 s there is effectively no human reaction
///         window: the only remaining brakes are the daily release cap and `pause()`, so the
///         watchdog has to be an always-on automated process. `revokeEpochOwed` exists because at
///         that speed `pause()` alone would only delay a loss, not stop it.
///
///         ENTRY GATE (decision #31): entry requires holding an ERC-8004 agent identity on the
///         registry named by `identityRegistry`. We deleted our own registry and its timed
///         signature challenge for it. Be exact about what this buys: ERC-8004 is BNB Chain's
///         published standard with a real ecosystem and a reputation trail, and that is its whole
///         value. It does NOT detect humans — the identity is an ordinary transferable ERC-721
///         that anyone can mint for about 0.0000054 BNB, without limit.
///         「我们要求持有 agent 身份，我们不能证明它是 AI」.
///
///         ══════════════════════════════════════════════════════════════════════════════════
///         OWNER POWERS (decision #29). 项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的
///         全部资金。
///         ══════════════════════════════════════════════════════════════════════════════════
///         That sentence is decision #29a, it is the literal truth of this contract, and
///         `description()` returns it verbatim so the site's first screen, the footer and the
///         first reply under every X post can be diffed against the chain character for
///         character. The owner holds `_authorizeUpgrade` and the two `emergencyWithdraw*`, with NO
///         timelock, because the user was told the cost — a comparable BSC vault's
///         `emergencyWithdraw` was used to move 29,951,480.8 user-staked tokens and is Flap's own
///         cautionary example, and upgradeability alone would have addressed the stated fear
///         better — and chose immediate anyway.
///
///         The power reaches beyond the pool: the code behind this proxy can be anything, so it
///         can also spend every BAC allowance users have left standing on this address. Hence
///         the allowance sentence in `description()` and on `lock`: approve exactly the amount,
///         right before locking, never a standing or unlimited approval.
///
///         Everything the earlier design promised here is withdrawn. These four statements are
///         FALSE and must not appear in any contract string, page, document or post:
///         「桥池只用于 agent 退出兑付，项目方和 Flap Guardian 都动不了」「进桥的 BAC 永久锁死」
///         「不可升级」「owner 没有任何路径能移动桥池资金」.
///
///         `watchdog` can still pause `collect`, void immature owed locked against one anchor
///         epoch while paused, and arm the escape hatch; the veto key is still read live from
///         `ChainAnchor`. Neither of them can move BNB or BAC to itself — but neither of them is
///         a backstop above the owner any more (decision #29b).
///
///         DEPLOYMENT. An OpenZeppelin `ERC1967Proxy` (UUPS) over this implementation. The
///         implementation's constructor disables initializers, so the bare implementation can
///         never be initialised or owned by anyone; `initialize` runs exactly once, through the
///         proxy. Ownership is two-step and cannot be renounced (see `renounceOwnership`).
///
///         WHAT AN EMERGENCY WITHDRAWAL DOES TO THE BOOKS: nothing. `bnbBalance`, `buybackBac`,
///         `lockedBac`, `owed` and every escape accumulator keep saying what the bridge owes;
///         `shortfall()` says how much of that is no longer physically here. The consequences are
///         deliberate and every path is written for them: the sweeps return 0 instead of
///         underflowing, `buyback` spends only BNB that is actually present and otherwise skips,
///         and an exit payout fails — first come, first served — exactly when the money it would
///         be paid from is gone (`escapeCollect` settles its BAC and BNB legs separately, so a hole
///         in one asset never strands the other). Sending the asset back refills the hole: BAC by
///         plain transfer, BNB by force-send (there is no `receive`, and `acceptRelease` books its
///         value as new revenue) or by an upgrade.
///
///         THE EVENTS ARE NOT THE WHOLE STORY. `EmergencyWithdraw` and the `emergency*` counters
///         record the two emergency functions and nothing else. An upgrade can move every wei
///         in the same transaction (`upgradeToAndCall` runs new code after `BridgeUpgraded` has
///         snapshotted the books), and new code can rewrite the books and `shortfall()` with it.
///         A complete withdrawal record therefore has to diff the bridge's physical BNB and BAC
///         balances around every upgrade as well (#29c).
///
///         MATURITY IS PER DEBT (v1.1). `OWED_MATURITY` is measured from the claim of each debt,
///         through `claimHistory`, not from an address's latest claim: a dust exit that anybody
///         routes to your address adds a young debt of its own and leaves your older, matured
///         claim senior (see `_maturedOwed`).
contract BacBridge is BacBridgeCore {
    /// @notice The code of the rarely-called paths (see `BacBridgeCore`). Fixed per
    ///         implementation: deployed by this implementation's constructor, so it can only ever
    ///         change together with the implementation, i.e. through a logged upgrade.
    address public immutable EXTENSION;

    // ------------------------------------------------------------------ events

    event Locked(
        uint256 indexed depositId,
        uint256 indexed agentId,
        address indexed from,
        address layerWallet,
        uint256 measured,
        uint256 credits,
        uint256 totalIssued
    );
    event ReleaseReceived(address indexed from, uint256 amount, uint256 bnbAfter);
    event Untracked(uint256 amount, uint256 bnbAfter);
    event UntrackedBac(uint256 amount, uint256 buybackBacAfter);
    event BoughtBack(address indexed by, uint8 venue, uint256 bnbSpent, uint256 bacBought, uint256 buybackBacAfter);
    /// @dev 1 halted, 2 interval not elapsed, 3 budget below the floor, 4 venue unavailable,
    ///      5 the venue call itself reverted, 6 the BNB the book counts is not physically here
    ///      (an owner emergency withdrawal, see `shortfall()`). A skip is never a revert
    ///      (requirement 2).
    event BuybackSkipped(uint8 reason, uint256 budget);
    event ExitClaimed(
        uint64 indexed anchorEpoch,
        uint256 indexed exitId,
        uint256 indexed agentId,
        address to,
        uint256 credits,
        uint256 lockedBacAmt,
        uint256 rateUsed,
        uint256 attributed
    );
    event EpochSettled(uint64 indexed epoch, uint256 pot, uint256 owedTotalAfter, uint16 releaseBps, bool skipped);
    event Collected(address indexed who, address indexed to, uint256 amount, uint256 owedLeft);
    event EpochOwedRevoked(uint64 indexed epoch, address indexed by, uint256 revoked);
    event EscapeArmed(address indexed by, uint8 cause, uint64 effectiveAt);
    event EscapeArmCancelled(address indexed by);
    event Halted(uint8 cause);
    event OwedPaidAfterHalt(address indexed who, address indexed to, uint256 amount);
    event OwedDemoted(address indexed who, uint256 amount);
    event EscapeCollected(uint256 indexed agentId, address indexed to, uint256 bacPaid, uint256 bnbPaid);
    event Paused(address indexed by, uint64 until_, uint64 cumulative);
    event Unpaused(address indexed by, uint64 cumulative);
    event LockedBurned(uint256 amount);
    event AgentControllerSet(uint256 indexed agentId, address indexed previous, address indexed current);

    /// @notice Decision #29c. Every upgrade leaves a trace carrying the whole state of the books
    ///         at the moment the owner authorised it, so the site's timeline can show what was in
    ///         the bridge when the rules changed, not merely that they changed.
    event BridgeUpgraded(
        address indexed newImplementation,
        address indexed previousImplementation,
        address indexed by,
        uint64 upgradeNumber,
        uint64 at,
        uint256 bnbBook,
        uint256 lockedBacBook,
        uint256 buybackBacBook,
        uint256 owedTotalBook
    );

    /// @notice Decision #29c. `token` is `address(0)` for native BNB. `bookAtWithdraw` is what the
    ///         bridge's own accounting said it was holding of that asset at the moment it left.
    event EmergencyWithdraw(
        address indexed by,
        address indexed to,
        address indexed token,
        uint256 amount,
        uint256 balanceAfter,
        uint256 bookAtWithdraw,
        uint256 lifetimeWithdrawn,
        uint64 withdrawNumber,
        uint64 at
    );

    // ------------------------------------------------------------------ upgrade gate

    /// @dev UUPS gate. Owner-only, no timelock (decision #29). Every upgrade is logged with the
    ///      implementation it replaces and the state of the books at that moment (#29c).
    ///      `lockedBacBook` is the part of the deposit bucket still held (`lockedBac - totalBurned`),
    ///      the same figure `bacAccounted()` counts. OpenZeppelin then refuses any new
    ///      implementation that is not itself UUPS, so an upgrade cannot strand the proxy.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        uint64 n = ++upgradeCount;
        lastUpgradeAt = uint64(block.timestamp);
        emit BridgeUpgraded(
            newImplementation,
            _getImplementation(),
            msg.sender,
            n,
            uint64(block.timestamp),
            bnbBalance,
            lockedBac - totalBurned,
            buybackBac,
            owedTotal
        );
    }

    // ------------------------------------------------------------------ construction

    /// @dev The implementation is never used directly: it only lends its code to the proxy.
    ///      Disabling initializers here means nobody can initialise, own or upgrade the bare
    ///      implementation contract.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
        EXTENSION = address(new BacBridgeExtension());
    }

    /// @notice Runs once, through the proxy, in the same transaction that deploys it.
    /// @dev Seven parameters: the owner, the four of §9 step ⑦ and the two venue addresses the
    ///      buyback needs. No wiring address has a setter, so no role short of an upgrade (which
    ///      `BridgeUpgraded` logs publicly) can point the buyback at a contract of its own. Which
    ///      venue is used is decided per call from chain state
    ///      (`IPortalLens.getTokenV8Safe(bac).status`), never from a stored flag.
    ///      The settle cursor starts at the deploy epoch: epoch numbers are `timestamp / 600`, so
    ///      without a starting point the strictly-sequential `settleEpoch` would have to walk
    ///      millions of empty epochs.
    function initialize(
        address owner_,
        address bacToken_,
        address identityRegistry_,
        address anchor_,
        address watchdog_,
        address portal_,
        address router_
    ) external initializer {
        require(owner_ != address(0), unicode"Zero owner / owner 地址为零");
        require(bacToken_ != address(0), unicode"Zero BAC token / BAC 代币地址为零");
        require(identityRegistry_ != address(0), unicode"Zero identity registry / 身份注册表地址为零");
        require(anchor_ != address(0), unicode"Zero anchor / 锚点地址为零");
        require(watchdog_ != address(0), unicode"Zero watchdog / 看门狗地址为零");
        require(portal_ != address(0), unicode"Zero portal / Portal 地址为零");
        require(router_ != address(0), unicode"Zero router / 路由地址为零");
        bacToken = bacToken_;
        identityRegistry = identityRegistry_;
        anchor = anchor_;
        watchdog = watchdog_;
        portal = portal_;
        router = router_;
        lastSettledEpoch = uint64(block.timestamp / EPOCH);
        lastBuybackEpoch = uint64(block.timestamp / EPOCH);
        releaseIndex.p = uint160(RELEASE_ONE);
        __ReentrancyGuard_init();
        // Straight to `owner_`: `__Ownable_init` would first make the deployer (or the proxy's
        // creator) owner for one line, which is one more `OwnershipTransferred` for the public
        // timeline to explain and nothing else.
        _transferOwnership(owner_);
    }

    // ==================================================================
    //                               IN
    // ==================================================================

    /// @notice Lock BAC and mint 1:1 layer credits against ERC-8004 identity `agentId`.
    ///         The BAC lands in `lockedBac`.
    ///
    /// @dev The caller names their own `agentId` because the ERC-8004 registry has NO
    ///      address-to-id reverse lookup (docs/research/12-erc8004-and-portal.md §1.3); the
    ///      contract then verifies it forwards. Whoever passes the gate — the NFT holder or the
    ///      signature-proven `agentWallet` — is the address credited on the layer, so there is no
    ///      third party who can redirect somebody else's credits.
    ///
    ///      The gate proves control of an agent identity. It does NOT prove the holder is an AI:
    ///      registration is open, free and unlimited and the token is transferable. The daily
    ///      release cap and the per-address exit limit remain the only real brakes.
    ///
    ///      Measured by balance difference, so a fee-on-transfer BAC can never over-credit.
    ///
    ///      The FIRST successful lock for an `agentId` makes the caller its `agentController`,
    ///      the one address that may `escapeCollect` for it after a halt, and from then on only
    ///      that controller may lock more under the id. Every deposit under an id adds to ONE
    ///      escape claim, so letting anybody else deposit would hand their money's escape share
    ///      to the controller: a seller who entered with 1 wei and then sold the identity would
    ///      collect the buyer's whole deposit after a halt, and an `agentWallet` that locked 1 wei
    ///      first would capture its owner's (review finding, 2026-09-23). A buyer, or the owner
    ///      behind an `agentWallet`, therefore has the current controller hand the claim over with
    ///      `setAgentController` first; the refusal below says so.
    ///
    ///      ALLOWANCES: the BAC is pulled with `transferFrom`, so the caller approves this
    ///      address first. This address is an upgradeable proxy (decision #29), and whatever code
    ///      the owner puts behind it can spend every allowance still standing on it, BAC that
    ///      never entered the pool included. Approve exactly `amount`, immediately before `lock`,
    ///      and set the allowance back to 0 if `lock` fails; `description()` says the same.
    function lock(uint256 agentId, uint256 amount) external nonReentrant returns (uint256 id) {
        require(!isHalted(), unicode"Bridge halted / 桥已停机");
        require(agentId != 0, unicode"Zero agent id / agent 身份编号为零");
        require(
            Erc8004Gate.holds(identityRegistry, msg.sender, agentId),
            unicode"Not the ERC-8004 identity holder / 不是该 ERC-8004 身份的持有人"
        );
        address ctrl = agentController[agentId];
        require(
            ctrl == address(0) || ctrl == msg.sender,
            unicode"Another address controls this agent id, see setAgentController / 该身份已由其他地址控制，见 setAgentController"
        );
        address layerWallet = msg.sender;

        uint256 before = IERC20(bacToken).balanceOf(address(this));
        _pullBac(msg.sender, amount);
        uint256 measured = IERC20(bacToken).balanceOf(address(this)) - before;
        require(measured > 0, unicode"Zero amount / 金额为零");

        uint256 credits = measured;
        lockedBac += measured;
        totalCreditsIssued += credits;
        credited[agentId] += credits;
        if (ctrl == address(0)) {
            agentController[agentId] = msg.sender;
            emit AgentControllerSet(agentId, address(0), msg.sender);
        }

        id = depositId++;
        deposits[id] = Deposit(msg.sender, uint64(block.timestamp), agentId, measured);
        emit Locked(id, agentId, msg.sender, layerWallet, measured, credits, totalCreditsIssued);
    }

    /// @notice Permissionless: `BacTaxRouter` pushes the bridge half here; anyone may donate.
    function acceptRelease() external payable {
        _accept(msg.value);
        emit ReleaseReceived(msg.sender, msg.value, bnbBalance);
    }

    /// @notice Permissionless: fold force-pushed (selfdestruct / coinbase) BNB into the book.
    /// @dev `nonReentrant`: both sweeps recognise revenue as `balance - accounted`, so a sweep
    ///      re-entered from inside `buyback`'s swap (or `lock`'s `transferFrom`) would book the
    ///      very same wei twice - once here and once when the outer call measures its own delta.
    ///      After an owner withdrawal the balance can sit BELOW the book (#29, `shortfall()`); then
    ///      there is nothing untracked, a force-send only narrows the hole, and this returns 0.
    function sweepUntracked() external nonReentrant returns (uint256 swept) {
        uint256 bal = address(this).balance;
        if (bal <= bnbBalance) return 0;
        swept = bal - bnbBalance;
        _accept(swept);
        emit Untracked(swept, bnbBalance);
    }

    /// @notice Permissionless: fold BAC that arrived outside `lock` / `buyback` into `buybackBac`.
    /// @dev Rule 010 for the BAC side. A donation can only ever enlarge the bucket that PAYS
    ///      exits; there is no path from here into `lockedBac`.
    function sweepUntrackedBac() external nonReentrant returns (uint256 swept) {
        uint256 bal = IERC20(bacToken).balanceOf(address(this));
        uint256 accounted = bacAccounted();
        if (bal <= accounted) return 0;
        swept = bal - accounted;
        _acceptBac(swept);
        emit UntrackedBac(swept, buybackBac);
    }

    // ==================================================================
    //                             BUYBACK
    // ==================================================================

    /// @notice Permissionless. Spends a bounded slice of the BNB bucket on BAC and files what it
    ///         buys into `buybackBac`. Fires ONLY on its own schedule — never from `claimExit`,
    ///         never from `collect`, never from `settleEpoch`. That is the whole reason the
    ///         "top up on demand" variant was rejected: it hands the execution timing of a large
    ///         buy to any caller, which is exactly the shape a sandwicher wants.
    /// @param minBacOut an extra, caller-supplied floor. The contract's own floor below is
    ///        enforced regardless, so passing 0 is safe.
    /// @param maxSpend an extra, caller-supplied size limit (0 = no limit). `MAX_BUY_SLIPPAGE_BPS`
    ///        is the guard that actually binds, and on a thin pool a full `MAX_BUYBACK_BNB` buy
    ///        breaches it and reverts — measured on a live PancakeSwap pair. The keeper then has
    ///        to split the buy, and this is what lets it. A griefer can hold every call down to
    ///        `MIN_BUYBACK_BNB`, which delays the buying but loses nothing: the unspent budget
    ///        stays accrued and the next epoch can spend it.
    /// @dev Never reverts when there is simply nothing to do or the venue is unavailable: it
    ///        emits `BuybackSkipped` and returns 0, so no caller's settlement path can be taken
    ///        down by an unavailable market.
    function buyback(uint256 minBacOut, uint256 maxSpend) external nonReentrant returns (uint256 bought) {
        if (halted) {
            emit BuybackSkipped(1, buybackBudget);
            return 0;
        }
        uint64 e = uint64(block.timestamp / EPOCH);
        uint64 elapsed = e > lastBuybackEpoch ? e - lastBuybackEpoch : 0;
        if (elapsed < BUYBACK_MIN_INTERVAL) {
            emit BuybackSkipped(2, buybackBudget);
            return 0;
        }
        if (elapsed > EPOCHS_PER_DAY) elapsed = EPOCHS_PER_DAY; // one call accrues at most one day
        lastBuybackEpoch = e;

        uint256 budget = buybackBudget + (bnbBalance * BUYBACK_DAILY_BPS * elapsed) / (10000 * EPOCHS_PER_DAY);
        if (budget > bnbBalance) budget = bnbBalance;
        buybackBudget = budget;

        uint256 spend = budget > MAX_BUYBACK_BNB ? MAX_BUYBACK_BNB : budget;
        if (maxSpend != 0 && spend > maxSpend) spend = maxSpend;
        // #29: the owner may have withdrawn BNB the book still counts. Spend only what is
        // physically here, so the hole (`shortfall()`) neither grows nor bricks the schedule.
        uint256 held = address(this).balance;
        if (spend > held) {
            spend = held;
            if (spend < MIN_BUYBACK_BNB) {
                emit BuybackSkipped(6, budget);
                return 0;
            }
        }
        if (spend < MIN_BUYBACK_BNB) {
            emit BuybackSkipped(3, budget);
            return 0;
        }

        // Venue and reference price both come from chain state, in this transaction.
        (uint8 venue, uint256 expectedGross, uint256 buyTaxBps) = _venue(spend);
        if (venue == 0) {
            emit BuybackSkipped(4, budget);
            return 0;
        }
        uint256 floorOut = (expectedGross * (10000 - buyTaxBps) * (10000 - MAX_BUY_SLIPPAGE_BPS)) / 1e8;
        if (floorOut < minBacOut) floorOut = minBacOut;

        // Rule 010: the whole outflow leaves the book BEFORE the external call, and the book is
        // never re-derived from `address(this).balance` afterwards. Both venues consume the full
        // `msg.value`; if one ever refunded, that wei would simply be untracked balance and
        // `sweepUntracked()` folds it back. Re-deriving the spend from the balance would let a
        // `acceptRelease` reentered during the swap be counted twice.
        uint256 bacBefore = IERC20(bacToken).balanceOf(address(this));
        bnbBalance -= spend;
        buybackBudget = budget - spend;

        if (!_execute(venue, spend, minBacOut)) {
            bnbBalance += spend;
            buybackBudget = budget;
            emit BuybackSkipped(5, budget);
            return 0;
        }

        bought = IERC20(bacToken).balanceOf(address(this)) - bacBefore;
        require(bought >= floorOut, unicode"Buyback slippage too high / 回购滑点超过上限");

        buybackBac += bought;
        buybackBacBought += bought;
        buybackBnbSpent += spend;
        emit BoughtBack(msg.sender, venue, spend, bought, buybackBac);
    }

    /// @dev venue 1 = the flap bonding curve, 2 = PancakeSwap V2, 0 = unavailable (no-op).
    ///      `expectedGross` is what `spend` would buy at the pre-trade price, before BAC's own
    ///      buy tax; the caller compares the measured result against it.
    ///
    ///      The venue is read from chain state on every call — `IPortalLens.getTokenV8Safe(BAC)`
    ///      — never from a stored flag, so nobody has to (or can) tell the bridge that BAC has
    ///      graduated. `getTokenV8Safe` returns a struct of 18 STATIC fields, i.e. a flat
    ///      18 x 32 = 576-byte tuple, so the three words this contract needs are read straight out
    ///      of the returndata: word 0 `status`, word 3 `price`, word 12 `buyTaxRate`. Decoding the
    ///      whole struct through the typed interface costs ~4 KB of runtime code for fields that
    ///      are never used. `Safe` in the name means exactly this: new enum variants can be added
    ///      upstream without breaking the decode.
    function _venue(uint256 spend) internal view returns (uint8 venue, uint256 expectedGross, uint256 buyTaxBps) {
        (bool ok, bytes memory ret) = portal.staticcall(abi.encodeWithSelector(SEL_TOKEN_STATE, bacToken));
        if (!ok || ret.length < 576) return (0, 0, 0);
        uint256 status;
        uint256 price;
        assembly ("memory-safe") {
            status := mload(add(ret, 32))
            price := mload(add(ret, 128))
            buyTaxBps := mload(add(ret, 416))
        }
        if (buyTaxBps >= 10000) return (0, 0, 0);
        if (status == 1) {
            // Tradable: still on the curve. `price` is quote per token, 18 decimals.
            if (price == 0) return (0, 0, 0);
            return (1, (spend * 1e18) / price, buyTaxBps);
        }
        if (status != 4) return (0, 0, 0);
        // Graduated. A TAX token always migrates with a V2 migrator, so the pool is a V2 pair and
        // a negligible reference trade gives the pre-trade price without decoding reserves.
        (ok, ret) = router.staticcall(abi.encodeWithSelector(SEL_AMOUNTS_OUT, BUYBACK_QUOTE_REF, _path()));
        if (!ok || ret.length < 128) return (0, 0, 0);
        uint256 refOut; // amounts[1] of a `uint256[]` return: offset, length, amounts[0], amounts[1]
        assembly ("memory-safe") {
            refOut := mload(add(ret, 128))
        }
        if (refOut == 0) return (0, 0, 0);
        return (2, (spend * refOut) / BUYBACK_QUOTE_REF, buyTaxBps);
    }

    /// @dev Returns false instead of bubbling, so an unavailable venue is a no-op and not a revert.
    function _execute(uint8 venue, uint256 spend, uint256 minBacOut) internal returns (bool ok) {
        bytes memory data = venue == 1
            // ExactInputParams is a DYNAMIC struct (it carries a `bytes`), so the calldata is
            // head(offset to the struct) followed by the struct body: inputToken = 0 (BNB),
            // outputToken = BAC, inputAmount, minOutputAmount, offset of permitData inside the
            // struct (0xa0), permitData.length = 0.
            ? abi.encodeWithSelector(
                SEL_SWAP_EXACT_IN,
                uint256(0x20),
                uint256(0),
                uint256(uint160(bacToken)),
                spend,
                minBacOut,
                uint256(0xa0),
                uint256(0)
            )
            : abi.encodeWithSelector(SEL_SWAP_ETH, minBacOut, _path(), address(this), block.timestamp);
        (ok,) = (venue == 1 ? portal : router).call{value: spend}(data);
    }

    function _path() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = WBNB;
        path[1] = bacToken;
    }

    // ==================================================================
    //                          OUT (normal mode)
    // ==================================================================

    /// @notice Burn layer credits against a FINAL anchor and lock the redemption rate (M1).
    /// @dev No time window, no status check, not gated by `pause()` — this function moves zero
    ///      BAC. The rate is a share of `buybackBac` only: `lockedBac` is not read here, and the
    ///      subtraction `buybackBac - owedTotal` is what makes `owedTotal <= buybackBac` a
    ///      structural fact rather than something a price move could break.
    function claimExit(
        uint64 anchorEpoch,
        uint256 exitId,
        uint256 agentId,
        address to,
        uint256 credits,
        bytes32[] calldata proof
    ) external returns (uint256 lockedBacAmt) {
        require(!isHalted(), unicode"Bridge halted / 桥已停机");
        IChainAnchor.Anchor memory an = IChainAnchor(anchor).getAnchor(anchorEpoch);
        require(an.state == IChainAnchor.State.FINAL, unicode"Anchor not final / 锚点尚未定案");
        require(!exitClaimed[exitId], unicode"Exit already claimed / 该退出已领取");

        bytes32 leaf = keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, to, credits, LAYER_CHAIN_ID, address(this)));
        require(MerkleProof.verify(proof, an.exitRoot, leaf), unicode"Bad merkle proof / merkle 证明无效");

        uint256 outstanding = totalCreditsIssued - totalCreditsExited;
        require(outstanding >= credits, unicode"Credits exceed outstanding / 积分超过未退出总量");
        uint256 free = buybackBac - owedTotal;
        lockedBacAmt = (credits * free) / outstanding;
        require(
            lockedBacAmt > 0,
            unicode"Rate too low, exit not worth claiming / 当前兑付率过低，本次退出不值得领取"
        );

        // Harvest first: the new debt joins `to`'s unreleased part at the CURRENT index, so it gets
        // no share of any pot settled before it existed (B15).
        _harvest(to);
        // The new debt gets its OWN age; `to`'s older debt keeps its own (`_maturedOwed`). Anyone
        // can submit an exit that pays `to`, so this line must never make `to`'s old claims young.
        _noteClaim(to, lockedBacAmt);
        owed[to] += lockedBacAmt;
        owedTotal += lockedBacAmt;
        epochOwed[anchorEpoch][to] += lockedBacAmt;
        lastClaimAt[to] = uint64(block.timestamp); // display only since v1.1; maturity is per debt
        exitClaimed[exitId] = true;

        // Attribution is truncated at what this agent actually put in, so the escape weight
        // (`credited - exitedCredits`) can never underflow (attack-funds #4).
        uint256 room = credited[agentId] - exitedCredits[agentId];
        uint256 attr = credits < room ? credits : room;
        exitedCredits[agentId] += attr;
        unattributedExited += credits - attr;
        totalCreditsExited += credits;

        emit ExitClaimed(anchorEpoch, exitId, agentId, to, credits, lockedBacAmt, (free * 1e18) / outstanding, attr);
    }

    /// @notice Permissionless, once per address per epoch, capped at `MAX_EXIT_SHARE_BPS` (10%) of
    ///         the release rate's per-epoch amount for each epoch that has passed since this
    ///         address last collected (up to 144, i.e. one day) — see `_collectCap`.
    /// @dev Pays BAC out of `buybackBac`. `lockedBac` is not readable from here at all.
    ///      Truncated wei stays in `unclaimed` and is collectable in a later epoch; it is never
    ///      forfeited, and the cap never falls to 0 while BAC is reserved. After an owner
    ///      emergency withdrawal (#29) the payout fails when the bought-back BAC it is owed from
    ///      is physically gone — never by dipping into the deposits (`_payExitBac`).
    function collect(address to) external nonReentrant returns (uint256 paid) {
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        (bool paused,,) = isPaused();
        require(!paused, unicode"Bridge paused / 桥已暂停");
        require(!isHalted(), unicode"Bridge halted / 桥已停机");

        uint64 e = uint64(block.timestamp / EPOCH);
        uint64 last = lastCollectEpoch[msg.sender];
        require(last < e, unicode"Already collected this epoch / 本纪元已领取");
        uint64 span = e - last;
        if (span > MAX_CATCHUP_EPOCHS) span = MAX_CATCHUP_EPOCHS;
        lastCollectEpoch[msg.sender] = e;

        _harvest(msg.sender);
        paid = unclaimed[msg.sender]; // never above `owed[msg.sender]`
        uint256 cap = _collectCap(span);
        if (paid > cap) paid = cap;
        // Dust guard: `unclaimed` rounds in the address's favour by up to 1 wei per harvest, so
        // it can exceed its exact share of `reservedTotal` by that much. Without this clamp that
        // dust would make `reservedTotal -= paid` underflow and permanently brick `collect` for
        // the last claimant. The clamped wei stays in `unclaimed`, exactly like cap dust.
        if (paid > reservedTotal) paid = reservedTotal;
        require(paid > 0, unicode"Nothing to collect / 没有可领取的金额");

        // `owed - unclaimed` (the unreleased part) does not change, so the snapshot stays valid
        unclaimed[msg.sender] -= paid;
        owed[msg.sender] -= paid;
        owedPaid[msg.sender] += paid;
        owedTotal -= paid;
        reservedTotal -= paid;
        buybackBac -= paid;

        emit Collected(msg.sender, to, paid, owed[msg.sender]);
        _payExitBac(to, paid);
    }

    /// @dev The per-address cap for `span` epochs: 10% of what the last settled daily release
    ///      rate (`lastPotBps`) lets the whole bucket release in one epoch, times `span`. It never
    ///      reads the pot itself, which is 0 whenever every owed wei is already released: with a
    ///      "10% of the last pot" cap the last exiters could never collect what is reserved for
    ///      them. It is 0 only before the first release, when there is nothing to collect anyway.
    function _collectCap(uint64 span) internal view returns (uint256) {
        return (buybackBac * lastPotBps * MAX_EXIT_SHARE_BPS * span) / (1e8 * uint256(EPOCHS_PER_DAY));
    }

    // ==================================================================
    //                         ONE-WAY BAC BURN
    // ==================================================================

    /// @notice Permissionless. The only way a NON-owner call can move `lockedBac`: to `DEAD`.
    ///         (The owner's `emergencyWithdrawToken` reaches it too — decision #29.)
    /// @dev It burns `lockedBac - totalBurned` and never one wei more, so `buybackBac` — the
    ///      bucket that pays exits — is untouched. If an owner withdrawal has cut into the
    ///      deposits themselves, the transfer fails and so does the burn.
    function burnLocked() external nonReentrant returns (uint256 burned) {
        burned = lockedBac - totalBurned;
        require(burned > 0, unicode"Nothing to burn / 没有可销毁的 BAC");
        totalBurned += burned;
        _pushBac(DEAD, burned);
        emit LockedBurned(burned);
    }

    // ==================================================================
    //                              VIEWS
    // ==================================================================

    function creditsOutstanding() external view returns (uint256) {
        return totalCreditsIssued - totalCreditsExited;
    }

    /// @notice Would `who` be allowed through the entry gate as agent `agentId` right now?
    /// @dev Never reverts, including for an id that was never minted. A front end should call
    ///      this before `lock` so a mistyped id is a "no" on screen rather than a failed
    ///      transaction. A `true` here means "controls this ERC-8004 identity" and nothing more —
    ///      it is not a claim that the holder is an AI.
    function holdsIdentity(address who, uint256 agentId) external view returns (bool) {
        return Erc8004Gate.holds(identityRegistry, who, agentId);
    }

    /// @notice The ERC-8004 owner of `agentId`, or `address(0)` when that id does not exist.
    function identityOwner(uint256 agentId) external view returns (address) {
        return Erc8004Gate.ownerOrZero(identityRegistry, agentId);
    }

    /// @notice The signature-proven `agentWallet` of `agentId`, or `address(0)` when unset.
    function identityWallet(uint256 agentId) external view returns (address) {
        return Erc8004Gate.walletOrZero(identityRegistry, agentId);
    }

    /// @notice What `collect` would pay right now, every clamp already applied.
    function pendingCollect(address who) external view returns (uint256 amount) {
        uint64 e = uint64(block.timestamp / EPOCH);
        uint64 last = lastCollectEpoch[who];
        if (last >= e) return 0;
        uint64 span = e - last;
        if (span > MAX_CATCHUP_EPOCHS) span = MAX_CATCHUP_EPOCHS;
        amount = owed[who] - _unreleased(who);
        uint256 cap = _collectCap(span);
        if (amount > cap) amount = cap;
        if (amount > reservedTotal) amount = reservedTotal;
    }

    /// @notice The part of `who`'s owed that no pot has reached yet. `owed(who)` minus this is
    ///         what has been released to `who` and not yet collected, before the speed limit.
    function unreleasedOwed(address who) external view returns (uint256) {
        return _unreleased(who);
    }

    /// @notice The matured (senior) part of `who`'s owed: debt claimed at least `OWED_MATURITY`
    ///         before the halt, or before now while the bridge runs. This part can never be revoked
    ///         by the watchdog or demoted by `sweepImmatureOwed`, and after a halt it is what
    ///         `claimOwedAfterHalt` pays at once. Each debt ages on its own: a later exit paid to
    ///         `who` (by anyone) does not make older debt young again.
    function maturedOwed(address who) external view returns (uint256) {
        return _maturedOwed(who, _maturityCutoff(halted ? haltedAt : block.timestamp));
    }

    /// @notice 1e18-fixed BAC per credit. A view only — nothing is ever promised.
    function currentRate() external view returns (uint256 bacPerCredit) {
        uint256 outstanding = totalCreditsIssued - totalCreditsExited;
        if (outstanding == 0) return 0;
        return ((buybackBac - owedTotal) * 1e18) / outstanding;
    }

    /// @notice What the books say the bridge holds minus what it actually holds, per asset; 0
    ///         when nothing is missing. It becomes non-zero when funds leave without the books: an
    ///         owner emergency withdrawal (#29), which deliberately leaves the books alone, or
    ///         upgraded code that moved funds and kept these books. `bacShort` is measured against
    ///         `bacAccounted()`, i.e. unburned deposits plus the buyback bucket.
    /// @dev    Only as honest as the implementation answering it. An upgrade can take funds AND
    ///         rewrite the books it is computed from, and then this reads (0, 0) over an empty pool.
    ///         An independent check compares the physical balances with the books as they were
    ///         logged before the upgrade (`BridgeUpgraded`).
    function shortfall() external view returns (uint256 bnbShort, uint256 bacShort) {
        uint256 bal = address(this).balance;
        if (bnbBalance > bal) bnbShort = bnbBalance - bal;
        bal = IERC20(bacToken).balanceOf(address(this));
        uint256 book = bacAccounted();
        if (book > bal) bacShort = book - bal;
    }

    /// @notice The bridge's own one-paragraph account of itself. It carries `OWNER_POWER_NOTICE`
    ///         (decision #29a) and `IDENTITY_LIMIT_NOTICE` (decision #31a) word for word, so the
    ///         site and the X copy can be diffed against the chain.
    /// @dev The allowance sentence is there because the #29a sentence bounds the owner's taking
    ///      power at the pool, and an upgrade reaches further: new code behind this proxy can spend
    ///      every BAC allowance a user has left standing on it (review finding, 2026-09-23).
    function description() external pure returns (string memory) {
        return string.concat(
            OWNER_POWER_NOTICE,
            IDENTITY_LIMIT_NOTICE,
            unicode"锁入 BAC 进层，层内得到等量原生币付 gas；出层销毁原生币，按份额领取用税收 BNB 回购的 BAC，"
            unicode"每日释放有上限，不承诺任何金额，比拿 BNB 多损耗约 4%。第一版出块、中继、索引由项目方中心化运行。"
            unicode"只按本次锁入的数量授权 BAC，不要给桥留授权额度：升级后的合约能花掉任何剩余授权。 "
            unicode"Owner can upgrade this contract and withdraw all funds at any time. Entry needs an ERC-8004 agent "
            unicode"identity, which does not prove the holder is an AI. Exits pay bought-back BAC at a capped daily rate; "
            unicode"no amount is promised. v1 is run centrally by the project. Approve only the exact amount you lock: "
            unicode"an upgraded contract can spend any allowance left on the bridge."
        );
    }

    function lastEpochRelease() external view returns (uint256 pot, uint64 settledAt, uint16 releaseBps) {
        return (lastPot, lastPotSettledAt, lastPotBps);
    }

    /// @notice What the next `buyback()` would accrue and spend, without sending anything.
    function buybackState()
        external
        view
        returns (uint256 budget, uint256 spendable, uint64 epochsWaited, uint8 venue)
    {
        uint64 e = uint64(block.timestamp / EPOCH);
        epochsWaited = e > lastBuybackEpoch ? e - lastBuybackEpoch : 0;
        uint64 el = epochsWaited > EPOCHS_PER_DAY ? EPOCHS_PER_DAY : epochsWaited;
        budget = buybackBudget + (bnbBalance * BUYBACK_DAILY_BPS * el) / (10000 * uint256(EPOCHS_PER_DAY));
        if (budget > bnbBalance) budget = bnbBalance;
        spendable = budget > MAX_BUYBACK_BNB ? MAX_BUYBACK_BNB : budget;
        if (spendable > address(this).balance) spendable = address(this).balance;
        if (spendable < MIN_BUYBACK_BNB) spendable = 0;
        (venue,,) = _venue(spendable == 0 ? MIN_BUYBACK_BNB : spendable);
    }

    function escapeState()
        external
        view
        returns (uint256 totalWeight, uint256 accBac, uint256 accBnb, uint256 distBac, uint256 distBnb)
    {
        return (escapeTotalWeight, accPerWeightBac, accPerWeightBnb, escapeDistributedBac, escapeDistributedBnb);
    }

    function escapeClaimable(uint256 agentId) external view returns (uint256 bac, uint256 bnb) {
        if (!halted) return (0, 0);
        uint256 weight = credited[agentId] - exitedCredits[agentId];
        uint256 grossBac = (weight * accPerWeightBac) / 1e18;
        uint256 grossBnb = (weight * accPerWeightBnb) / 1e18;
        bac = grossBac > escapeDebtBac[agentId] ? grossBac - escapeDebtBac[agentId] : 0;
        bnb = grossBnb > escapeDebtBnb[agentId] ? grossBnb - escapeDebtBnb[agentId] : 0;
    }

    /// @notice 0 = no condition. 1/2/3 come from `ChainAnchor`, 5 from our own pause budget.
    ///         Cause 4 is the manual arm and never appears here.
    function pendingCause() external view returns (uint8) {
        return _pendingCause();
    }

    // ==================================================================
    //   DELEGATED to `EXTENSION`. Same selectors, same arguments, same
    //   return values, same events and revert strings: each call runs the
    //   extension's code against THIS contract's storage and balance, with
    //   `msg.sender` unchanged. Full documentation is on
    //   `BacBridgeExtension`; the one-liners below say who may call.
    // ==================================================================

    /// @notice Permissionless, strictly sequential: settle the next epoch's release.
    function settleEpoch(uint64 /* epoch */) external {
        _delegate();
    }

    /// @notice Owner-only. Send BNB out (0 = everything). Books are not written down (#29).
    function emergencyWithdrawBnb(address payable /* to */, uint256 /* amount */) external {
        _delegate();
    }

    /// @notice Owner-only. Send any ERC-20, BAC included, out (0 = everything) (#29).
    function emergencyWithdrawToken(address /* token */, address /* to */, uint256 /* amount */) external {
        _delegate();
    }

    /// @notice Only the current `agentController[agentId]`: hand the escape claim on.
    function setAgentController(uint256 /* agentId */, address /* newController */) external {
        _delegate();
    }

    /// @notice Watchdog-only, while paused: void immature owed of one anchor epoch.
    function revokeEpochOwed(uint64 /* epoch */, address[] calldata /* holders */) external returns (uint256 /* revoked */) {
        _delegate();
    }

    /// @notice Watchdog-only. Freezes `collect` only.
    function pause() external {
        _delegate();
    }

    /// @notice Watchdog-only.
    function unpause() external {
        _delegate();
    }

    /// @notice Watchdog-only manual arm of the escape hatch (cause 4).
    function armEscape() external {
        _delegate();
    }

    /// @notice Veto key only, once the trigger is gone.
    function cancelEscapeArm() external {
        _delegate();
    }

    /// @notice Permissionless: arm, then after `ESCAPE_ARM_DELAY` halt for good.
    function checkHalt() external {
        _delegate();
    }

    /// @notice After a halt: the senior (matured) claim, paid in BAC.
    function claimOwedAfterHalt(address /* to */) external returns (uint256 /* paid */) {
        _delegate();
    }

    /// @notice After a cause-2/3 halt: demote an immature claim to the junior pot. Permissionless.
    function sweepImmatureOwed(address /* who */) external {
        _delegate();
    }

    /// @notice After a halt: the junior claim of `agentId`, BAC and BNB. Only its `agentController`.
    function escapeCollect(uint256 /* agentId */, address /* to */)
        external
        returns (uint256 /* bacPaid */, uint256 /* bnbPaid */)
    {
        _delegate();
    }

    /// @dev Forwards the untouched calldata to `EXTENSION` by DELEGATECALL and hands back its
    ///      return data or its revert verbatim. Never returns to the caller's Solidity code. The
    ///      stubs above are deliberately NOT `nonReentrant`: the extension's own functions take
    ///      the lock, in this contract's storage.
    /// @custom:oz-upgrades-unsafe-allow delegatecall
    function _delegate() private {
        address ext = EXTENSION;
        assembly ("memory-safe") {
            let p := mload(0x40)
            calldatacopy(p, 0, calldatasize())
            let ok := delegatecall(gas(), ext, p, calldatasize(), 0, 0)
            returndatacopy(p, 0, returndatasize())
            if iszero(ok) { revert(p, returndatasize()) }
            return(p, returndatasize())
        }
    }
}

/// @title BacBridgeExtension
/// @notice The rarely-called half of `BacBridge`: the keeper's `settleEpoch`, the owner's
///         emergency withdrawals, the agent controller hand-over, the watchdog's tools and the
///         whole halt / escape machinery.
/// @dev Deployed by the `BacBridge` implementation's constructor and only ever executed by
///      DELEGATECALL from it, i.e. in the bridge proxy's storage, with the bridge's balance and
///      the original `msg.sender`. Every entry point refuses a direct call (`onlyDelegated`):
///      called on its own it would be reading an empty storage of its own. It shares its whole
///      storage layout with the bridge through `BacBridgeCore` and declares none of its own.
contract BacBridgeExtension is BacBridgeCore {
    address private immutable SELF = address(this);

    // ------------------------------------------------------------------ events
    // Byte-for-byte copies of the `BacBridge` declarations of the events this code emits. They
    // live on `BacBridge` so that `BacBridge.EventName` works for every consumer; the copies
    // here only let this code emit them. `BacBridgeUpgradeTest` checks every selector matches.

    event EpochSettled(uint64 indexed epoch, uint256 pot, uint256 owedTotalAfter, uint16 releaseBps, bool skipped);
    event EpochOwedRevoked(uint64 indexed epoch, address indexed by, uint256 revoked);
    event EscapeArmed(address indexed by, uint8 cause, uint64 effectiveAt);
    event EscapeArmCancelled(address indexed by);
    event Halted(uint8 cause);
    event OwedPaidAfterHalt(address indexed who, address indexed to, uint256 amount);
    event OwedDemoted(address indexed who, uint256 amount);
    event EscapeCollected(uint256 indexed agentId, address indexed to, uint256 bacPaid, uint256 bnbPaid);
    event Paused(address indexed by, uint64 until_, uint64 cumulative);
    event Unpaused(address indexed by, uint64 cumulative);
    event AgentControllerSet(uint256 indexed agentId, address indexed previous, address indexed current);
    event EmergencyWithdraw(
        address indexed by,
        address indexed to,
        address indexed token,
        uint256 amount,
        uint256 balanceAfter,
        uint256 bookAtWithdraw,
        uint256 lifetimeWithdrawn,
        uint64 withdrawNumber,
        uint64 at
    );

    modifier onlyDelegated() {
        require(address(this) != SELF, unicode"Call the bridge, not the extension / 请调用桥合约，而非扩展合约");
        _;
    }

    /// @dev Refuses to be an upgrade TARGET. OpenZeppelin's UUPS check asks the new implementation
    ///      for this value, so pointing the bridge proxy at the extension by mistake — which would
    ///      leave it without `lock`, `collect` or any way back — is refused as "not UUPS".
    function proxiableUUID() external view override notDelegated returns (bytes32) {
        revert(unicode"Not an implementation / 扩展合约不能作为实现合约");
    }

    /// @dev Unreachable: `upgradeTo` is `onlyProxy`, and `proxiableUUID` above keeps this contract
    ///      from ever being a proxy's implementation. Owner-gated anyway, never open.
    function _authorizeUpgrade(address) internal view override {
        _checkOwner();
    }

    // ==================================================================
    //                    OWNER POWERS  (decision #29)
    // ==================================================================

    /// @notice Owner-only: send `amount` BNB (0 = the whole balance) to `to`. No timelock.
    /// @dev Takes the PHYSICAL balance, untracked wei included, and deliberately does not touch
    ///      `bnbBalance` or any accumulator — see the contract NatSpec and `shortfall()`.
    function emergencyWithdrawBnb(address payable to, uint256 amount) external onlyDelegated onlyOwner nonReentrant {
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        // A withdrawal to the bridge itself moves nothing, yet would be logged and counted as one.
        require(to != address(this), unicode"Recipient is the bridge / 收款地址不能是桥本身");
        uint256 bal = address(this).balance;
        if (amount == 0) amount = bal;
        require(amount != 0, unicode"Nothing to withdraw / 没有可提取的金额");
        require(amount <= bal, unicode"Amount exceeds balance / 金额超过余额");
        emergencyBnbWithdrawn += amount;
        uint64 n = _noteEmergency();
        emit EmergencyWithdraw(
            msg.sender, to, address(0), amount, bal - amount, bnbBalance, emergencyBnbWithdrawn, n, uint64(block.timestamp)
        );
        _payout(to, amount);
    }

    /// @notice Owner-only: send `amount` of any ERC-20 (0 = the whole balance) to `to`, BAC
    ///         included — deposits and the buyback bucket alike. No timelock.
    /// @dev For BAC the amount is added to `emergencyBacWithdrawn` and `bookAtWithdraw` is
    ///      `bacAccounted()`; the books are not written down. For any other token the bridge keeps
    ///      no books, so both `bookAtWithdraw` and `lifetimeWithdrawn` are emitted as 0.
    function emergencyWithdrawToken(address token, address to, uint256 amount) external onlyDelegated onlyOwner nonReentrant {
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        // A self-transfer succeeds and moves nothing: without this it would log a withdrawal that
        // never happened (with a false `balanceAfter`) and inflate the lifetime counters, as often
        // as the owner liked (review finding, 2026-09-23).
        require(to != address(this), unicode"Recipient is the bridge / 收款地址不能是桥本身");
        // A typed call: a `token` without code reverts here instead of "succeeding" silently.
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (amount == 0) amount = bal;
        require(amount != 0, unicode"Nothing to withdraw / 没有可提取的金额");
        require(amount <= bal, unicode"Amount exceeds balance / 金额超过余额");
        uint256 book;
        uint256 lifetime;
        if (token == bacToken) {
            book = bacAccounted();
            lifetime = (emergencyBacWithdrawn += amount);
        }
        uint64 n = _noteEmergency();
        emit EmergencyWithdraw(msg.sender, to, token, amount, bal - amount, book, lifetime, n, uint64(block.timestamp));
        _pushToken(token, to, amount);
    }

    // ==================================================================
    //                    SETTLEMENT
    // ==================================================================

    /// @notice Permissionless, strictly sequential. Non-FINAL epochs advance the cursor with pot 0.
    /// @dev The release rate is written PER DAY and divided down to the epoch here. The old
    ///      per-epoch reading of 200/350/500 bps would be 288%/day at 144 epochs/day and would
    ///      empty the bucket the same day. `lastPot` records the pot as released, 0 included
    ///      (0 whenever every owed wei is already released); `collect`'s speed limit reads the
    ///      rate `lastPotBps`, never the pot, so a 0 pot cannot lock anyone out of reserved BAC.
    function settleEpoch(uint64 epoch) external onlyDelegated {
        require(!isHalted(), unicode"Bridge halted / 桥已停机");
        require(epoch == lastSettledEpoch + 1, unicode"Settle epochs in order / 纪元必须按序结算");

        IChainAnchor.Anchor memory an = IChainAnchor(anchor).getAnchor(epoch);
        IChainAnchor.State st = an.state;

        if (st == IChainAnchor.State.VETOED || st == IChainAnchor.State.DISPUTED) {
            lastSettledEpoch = epoch;
            skippedEpochs += 1;
            emit EpochSettled(epoch, 0, owedTotal, 0, true);
            return;
        }
        if (st != IChainAnchor.State.FINAL) {
            require(
                block.timestamp >= (uint256(epoch) + 1) * EPOCH + SETTLE_GRACE,
                unicode"Epoch not resolved yet / 该纪元尚未定案"
            );
            lastSettledEpoch = epoch;
            skippedEpochs += 1;
            emit EpochSettled(epoch, 0, owedTotal, 0, true);
            return;
        }

        uint16 bps = IChainAnchor(anchor).releaseBpsFor(epoch);
        if (owedTotal == 0) {
            reservedTotal = 0; // rounding dust can never ratchet (I2)
            lastSettledEpoch = epoch;
            emit EpochSettled(epoch, 0, 0, bps, false);
            return;
        }

        uint256 pot = ((buybackBac - reservedTotal) * bps) / (10000 * uint256(EPOCHS_PER_DAY));
        uint256 headroom = owedTotal - reservedTotal;
        if (pot > headroom) pot = headroom;

        // Zero-witness ceiling: with nobody independently checking `exitRoot`, the loss from a
        // stolen relayer key must be a number written in the contract (attack-gate #14). The
        // window is 30 DAY buckets, not 30 epochs — 30 epochs is 5 hours and no ceiling at all.
        uint64 day = epoch / EPOCHS_PER_DAY;
        DayPot storage dp = potRing[day % NO_ATTEST_WINDOW];
        if (dp.day != day) {
            releasedInWindow -= dp.amount;
            dp.amount = 0;
            dp.day = day;
        }
        if (an.agreeingCount == 0) {
            uint256 capLeft = (buybackBac * NO_ATTEST_WINDOW_BPS) / 10000;
            capLeft = capLeft > releasedInWindow ? capLeft - releasedInWindow : 0;
            if (pot > capLeft) pot = capLeft;
        }
        require(uint256(dp.amount) + pot <= type(uint128).max, unicode"Pot too large / 释放额过大");
        dp.amount += uint128(pot);
        releasedInWindow += pot;

        // The pot is shared out over the owed it has NOT reached yet (`headroom`), as one equal
        // fraction of every address's unreleased part — never over owed already released.
        if (pot != 0) _advanceRelease(pot, headroom);
        reservedTotal += pot;
        lastPot = pot;
        lastPotSettledAt = uint64(block.timestamp);
        lastPotBps = bps;
        lastSettledEpoch = epoch;
        emit EpochSettled(epoch, pot, owedTotal, bps, false);
    }

    // ==================================================================
    //                    AGENT CONTROLLER  (decision #31)
    // ==================================================================

    /// @notice Move the escape claim of `agentId` to `newController`. Only its current controller.
    /// @dev The ERC-8004 registry is not consulted: whoever controls the claim now decides where
    ///      it goes, whether or not they still hold the identity.
    function setAgentController(uint256 agentId, address newController) external onlyDelegated {
        address prev = agentController[agentId];
        require(msg.sender == prev, unicode"Only the agent controller / 仅限该 agent 的控制地址");
        require(newController != address(0), unicode"Zero controller / 控制地址为零");
        agentController[agentId] = newController;
        emit AgentControllerSet(agentId, prev, newController);
    }

    // ==================================================================
    //                    WATCHDOG  (decision #25a)
    // ==================================================================

    /// @notice Watchdog-only, and only while paused: void owed that was locked against ONE anchor
    ///         epoch and return it to `buybackBac`'s free part.
    /// @dev At a 120-second wait, `pause()` alone only delays a loss — the forged exits have
    ///      already locked their rate and will be payable the moment the pause lifts. This is the
    ///      function that actually undoes them. Two hard limits keep it from being a power over
    ///      honest money: only debts younger than `OWED_MATURITY` can be touched (the matured part
    ///      of an address's owed is never revoked), and the voided BAC goes back to the bucket —
    ///      there is no recipient parameter and no path to the caller.
    ///
    ///      Maturity is per debt (`_maturedOwed`): what can be revoked from `who` is at most the
    ///      part of its owed that is still young. Under v1 one fresh claim made the whole address
    ///      young, so a dust exit routed to an honest address let this reach its matured claim.
    function revokeEpochOwed(uint64 epoch, address[] calldata holders) external onlyDelegated returns (uint256 revoked) {
        require(msg.sender == watchdog, unicode"Only watchdog / 仅限看门狗");
        require(!halted, unicode"Already halted / 已停机");
        (bool paused,,) = isPaused();
        require(paused, unicode"Bridge not paused / 桥未处于暂停");

        uint256 cutoff = _maturityCutoff(block.timestamp);
        for (uint256 i; i < holders.length; ++i) {
            address who = holders[i];
            uint256 amount = epochOwed[epoch][who];
            if (amount == 0) continue;
            // A matured claim is senior and untouchable, exactly as it is after a halt.
            uint256 young = owed[who];
            if (young == 0) continue;
            // Zeroed even when only part is taken: the rest of this epoch's debt is matured or
            // already paid, and neither can ever become revocable again.
            epochOwed[epoch][who] = 0;
            if (amount > young) amount = young;
            // Fold everything already released for this address into one number first, so the
            // part of `reservedTotal` that was standing behind the revoked debt can be handed
            // back exactly. Clamping `reservedTotal` to `owedTotal` instead would cut into the
            // backing of OTHER addresses' claims and break B3.
            // The revoke takes the unreleased part first (it simply leaves the headroom) and only
            // then the released one, whose reservation is handed back to the bucket.
            _harvest(who);
            owed[who] -= amount;
            owedTotal -= amount;
            uint256 held = unclaimed[who];
            if (held > owed[who]) {
                uint256 drop = held - owed[who];
                unclaimed[who] = owed[who];
                reservedTotal = reservedTotal > drop ? reservedTotal - drop : 0;
            }
            revoked += amount;
        }
        // Belt and braces: `settleEpoch` computes `owedTotal - reservedTotal` and must never
        // underflow. After the per-address hand-back above this is already true (up to dust).
        if (reservedTotal > owedTotal) reservedTotal = owedTotal;
        emit EpochOwedRevoked(epoch, msg.sender, revoked);
    }

    /// @notice Watchdog-only. Freezes `collect` ONLY — never `claimExit`, never the escape path.
    function pause() external onlyDelegated {
        require(msg.sender == watchdog, unicode"Only watchdog / 仅限看门狗");
        pausedCumulative += _pauseUsed();
        pausedUntil = 0;
        require(pausedCumulative < MAX_PAUSE_TOTAL, unicode"Pause budget exhausted / 暂停额度已用尽");
        pauseStartedAt = uint64(block.timestamp);
        pausedUntil = uint64(block.timestamp) + PAUSE_LEN;
        emit Paused(msg.sender, pausedUntil, pausedCumulative);
    }

    /// @notice Watchdog-only. Settles the time actually spent paused into the cumulative budget.
    function unpause() external onlyDelegated {
        require(msg.sender == watchdog, unicode"Only watchdog / 仅限看门狗");
        require(pausedUntil != 0, unicode"Not paused / 未处于暂停");
        pausedCumulative += _pauseUsed();
        pausedUntil = 0;
        pauseStartedAt = 0;
        emit Unpaused(msg.sender, pausedCumulative);
    }

    // ==================================================================
    //                          OUT (escape mode)
    // ==================================================================

    /// @notice Watchdog-only manual arm (cause 4). Arming is never an immediate halt.
    function armEscape() external onlyDelegated {
        require(msg.sender == watchdog, unicode"Only watchdog / 仅限看门狗");
        require(!halted, unicode"Already halted / 已停机");
        require(escapeArmedAt == 0, unicode"Already armed / 已武装");
        escapeArmedAt = uint64(block.timestamp);
        armedCause = 4;
        emit EscapeArmed(msg.sender, 4, uint64(block.timestamp) + ESCAPE_ARM_DELAY);
    }

    /// @notice Only `ChainAnchor.vetoKey()`, and only once the trigger itself is gone.
    function cancelEscapeArm() external onlyDelegated {
        require(msg.sender == IChainAnchor(anchor).vetoKey(), unicode"Only veto key / 仅限 veto 钥");
        require(!halted, unicode"Already halted / 已停机");
        require(escapeArmedAt != 0, unicode"Nothing armed / 尚未武装");
        require(armedCause == 4 || _pendingCause() == 0, unicode"Condition still true / 触发条件仍然成立");
        escapeArmedAt = 0;
        armedCause = 0;
        emit EscapeArmCancelled(msg.sender);
    }

    /// @notice Permissionless: first arms, then (after `ESCAPE_ARM_DELAY`) halts for good.
    function checkHalt() external onlyDelegated {
        require(!halted, unicode"Already halted / 已停机");
        uint8 c = _pendingCause();
        if (escapeArmedAt == 0) {
            require(c != 0, unicode"No halt condition / 不满足任何停机条件");
            escapeArmedAt = uint64(block.timestamp);
            armedCause = c;
            emit EscapeArmed(msg.sender, c, uint64(block.timestamp) + ESCAPE_ARM_DELAY);
            return;
        }
        require(
            block.timestamp >= escapeArmedAt + ESCAPE_ARM_DELAY, unicode"Arming delay not elapsed / 武装期未满"
        );
        require(armedCause == 4 || _pendingCause() != 0, unicode"Halt condition cleared / 停机条件已消失");
        _halt(armedCause);
    }

    /// @dev O(1), one-shot. Senior debt is carved out of `buybackBac` first; what is left of that
    ///      bucket AND the whole unconverted BNB bucket become the junior pot. Both assets are
    ///      distributed, because at `BUYBACK_DAILY_BPS = 2000` about 3.6% of the money is BNB that
    ///      has not been converted yet — stranding it would be a real loss, not an accounting one.
    ///
    ///      The junior denominator is `Σ_id (credited[id] - exitedCredits[id])`, which is
    ///      `issued - exited + unattributedExited`. §4.2 writes `issued - exited`, but that is the
    ///      same number only while `unattributedExited == 0`: an agent that exits more credits
    ///      than it locked has its attribution truncated (revision #21), and each truncated wei
    ///      lands in `unattributedExited` — subtracted from the total but never from any weight.
    ///      Using the spec's literal figure makes the weights sum to MORE than the denominator,
    ///      so `escapeCollect` pays out more than the junior pot and the buckets underflow.
    function _halt(uint8 cause) internal {
        reservedTotal = 0;
        buybackBudget = 0;
        escapeTotalWeight = totalCreditsIssued - totalCreditsExited + unattributedExited;
        uint256 juniorBac = buybackBac - owedTotal;
        accPerWeightBac = escapeTotalWeight == 0 ? 0 : (juniorBac * 1e18) / escapeTotalWeight;
        accPerWeightBnb = escapeTotalWeight == 0 ? 0 : (bnbBalance * 1e18) / escapeTotalWeight;
        halted = true;
        haltedAt = uint64(block.timestamp);
        haltCause = cause;
        emit Halted(cause);
    }

    /// @notice Senior claim after a halt: matured `owed` is paid in full, in BAC.
    /// @dev Pays the part of the caller's owed that was claimed at least `OWED_MATURITY` before the
    ///      halt, debt by debt (`_maturedOwed`). The younger rest stays owed: under cause 2/3 it is
    ///      demoted by `sweepImmatureOwed`, under any other cause it is paid by a later call once
    ///      `OWED_MATURITY` has passed since the halt.
    function claimOwedAfterHalt(address to) external onlyDelegated nonReentrant returns (uint256 paid) {
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        require(halted, unicode"Bridge not halted / 桥尚未停机");
        uint256 o = owed[msg.sender];
        require(o > 0, unicode"Nothing to collect / 没有可领取的金额");
        paid = haltCause != 2 && haltCause != 3 && block.timestamp >= haltedAt + OWED_MATURITY
            ? o
            : _maturedOwed(msg.sender, _maturityCutoff(haltedAt));
        require(paid > 0, unicode"Owed not matured / 债权尚未成熟");

        owed[msg.sender] = o - paid;
        owedPaid[msg.sender] += paid;
        if (unclaimed[msg.sender] > o - paid) unclaimed[msg.sender] = o - paid;
        owedTotal -= paid;
        buybackBac -= paid;

        emit OwedPaidAfterHalt(msg.sender, to, paid);
        _payExitBac(to, paid);
    }

    /// @notice Permissionless: under cause 2/3 an immature `owed` is demoted to the junior pot.
    /// @dev cause 2/3 are the only "the root may be forged" signals; the fraud path can only ever
    ///      produce `owed` younger than `OWED_MATURITY` (attack-funds #3).
    ///      Demotes ONLY the immature part: the debt claimed less than `OWED_MATURITY` before the
    ///      halt. The matured part stays owed and payable by `claimOwedAfterHalt`, whatever was
    ///      added to the same address later — v1 demoted the whole address as soon as any part
    ///      of it was young, so a dust exit sent to someone else's address took their senior
    ///      claim into the junior pot (review finding, 2026-09-23).
    function sweepImmatureOwed(address who) external onlyDelegated {
        require(halted, unicode"Bridge not halted / 桥尚未停机");
        require(haltCause == 2 || haltCause == 3, unicode"Halt cause keeps priority / 该停机原因保留优先级");
        require(block.timestamp >= haltedAt + OWED_MATURITY, unicode"Owed not matured / 债权尚未成熟");
        uint256 o = owed[who];
        require(o > 0, unicode"Nothing to demote / 没有可降级的债权");
        uint256 amount = o - _maturedOwed(who, _maturityCutoff(haltedAt));
        require(amount > 0, unicode"Owed already matured / 该债权已成熟");

        owed[who] = o - amount;
        if (unclaimed[who] > o - amount) unclaimed[who] = o - amount;
        owedTotal -= amount;
        if (escapeTotalWeight > 0) accPerWeightBac += (amount * 1e18) / escapeTotalWeight;
        emit OwedDemoted(who, amount);
    }

    /// @notice Junior claim after a halt: pro-rata BAC and BNB on credits that never left.
    ///         Only `agentController[agentId]` may call it.
    /// @dev G11 — getting out is never gated on anything but proving whose credits these are,
    ///      and that proof is the controller recorded at entry, NOT a live ERC-8004 read. The
    ///      identity is a transferable ERC-721 on a third-party upgradeable proxy: selling it,
    ///      losing it, or an upstream implementation swap must not strand (or hand to a buyer) the
    ///      deposit behind it. The claim moves only when its controller says so
    ///      (`setAgentController`). There is no status to be "banned" out of here and no role
    ///      that can block this call.
    ///
    ///      After an owner emergency withdrawal (#29) the books still promise the share while the
    ///      asset may simply not be here. The two legs are therefore settled ONE BY ONE: a leg is
    ///      paid (and its debt advanced) only if its asset is physically here — BAC only out of
    ///      what stays above the unburned deposits, BNB only out of the actual balance — and a leg
    ///      that is not payable keeps its debt untouched, collectable after a refill. A hole in
    ///      one asset therefore never strands the other. First come, first served per asset.
    function escapeCollect(uint256 agentId, address to)
        external
        onlyDelegated
        nonReentrant
        returns (uint256 bacPaid, uint256 bnbPaid)
    {
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        require(halted, unicode"Bridge not halted / 桥尚未停机");
        require(msg.sender == agentController[agentId], unicode"Only the agent controller / 仅限该 agent 的控制地址");

        uint256 weight = credited[agentId] - exitedCredits[agentId];
        bacPaid = (weight * accPerWeightBac) / 1e18 - escapeDebtBac[agentId];
        bnbPaid = (weight * accPerWeightBnb) / 1e18 - escapeDebtBnb[agentId];
        require(bacPaid > 0 || bnbPaid > 0, unicode"Nothing to collect / 没有可领取的金额");
        if (IERC20(bacToken).balanceOf(address(this)) < lockedBac - totalBurned + bacPaid) bacPaid = 0;
        if (address(this).balance < bnbPaid) bnbPaid = 0;
        require(bacPaid > 0 || bnbPaid > 0, unicode"Bridge short of funds / 桥内资金不足");

        if (bacPaid > 0) {
            escapeDebtBac[agentId] += bacPaid;
            escapeDistributedBac += bacPaid;
            buybackBac -= bacPaid;
        }
        if (bnbPaid > 0) {
            escapeDebtBnb[agentId] += bnbPaid;
            escapeDistributedBnb += bnbPaid;
            bnbBalance -= bnbPaid;
        }

        emit EscapeCollected(agentId, to, bacPaid, bnbPaid);
        if (bacPaid > 0) _payExitBac(to, bacPaid);
        if (bnbPaid > 0) _payout(to, bnbPaid);
    }
}
