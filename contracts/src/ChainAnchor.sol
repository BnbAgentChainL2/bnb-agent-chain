// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IChainAnchor} from "./interfaces/IChainAnchor.sol";
import {IBacBridge} from "./interfaces/IBacBridge.sol";
import {IValidatorStaking} from "./interfaces/IValidatorStaking.sol";

/// @title ChainAnchor
/// @notice The clock of BNB Agent Chain: one anchor every 600 seconds, posted by the
///         relayer, held for a 120-second ANCHOR WAIT, finalized by anyone. It holds no
///         funds at all (no `receive()`, no `payable` function, invariant C1).
///
/// @dev Implements docs/01-CONTRACT-SPEC.md §6 including every entry of the revision
///      record that touches it:
///        - #30: the ledger identity check is DELETED. `circulating` is informational
///               only; the load-bearing checks are #7/#8 which use the BSC-side counter
///               `IBacBridge.totalCreditsIssued()` only. `initialCirculating` is a
///               constructor parameter so that C5 holds from block 0.
///        - #32: check #5 is `>=`, so an epoch with zero layer blocks (a signer outage
///               that crosses an epoch boundary) can still be anchored (C8).
///        - #34: check #4 forces the relayer to wait `COMMIT_WINDOW` after the epoch
///               ends. `COMMIT_WINDOW` is now 0, so the rule degenerates to "the epoch
///               must actually be over" - which is still the whole point of the check:
///               the relayer can never post an anchor for an epoch that has not ended.
///        - #35: veto / dispute counting is a sliding-window bitmap (O(1), no loops).
///
///      Decisions #20 / #25 (2026-09-23) rewrote the clock:
///        - EPOCH 86400 -> 600 seconds.
///        - CHALLENGE_WINDOW 24 hours -> ANCHOR_WAIT 120 seconds, and per decision #18
///          the name 「挑战窗口」 is gone from the code, the events and the require
///          strings; it is 「锚点等待」 everywhere.
///        - COMMIT_WINDOW 2 hours -> 0. Its stated purpose was to give witnesses two
///          hours to commit before the anchor was posted; attestation is now post-hoc
///          and batched (one round per day, §7), so that purpose is gone, and the two
///          hours would otherwise be 90% of the advertised 12-13 minute exit.
///        - Everything whose intent was a DURATION is still written as a duration
///          (`HALT_TIMEOUT = 90 days`, `STREAK_WINDOW = 30 days`). Nothing in this
///          contract counts epochs where it meant time: at 144 epochs per day that
///          would silently divide every window by 144.
///        - `releaseBpsFor` no longer reads this epoch's `agreeingCount`. A daily
///          attestation batch lands up to two days after `settleEpoch` runs (which is
///          two minutes after the anchor finalizes), so per-epoch counting would report
///          zero witnesses forever and pin the release tier at its lowest step. It now
///          reads the rolling witness roster out of `ValidatorStaking`.
///        - The returned bps is a PER-DAY rate. The bridge divides it by
///          `EPOCHS_PER_DAY`; 200/350/500 per epoch would be 288%-720% per day.
contract ChainAnchor {
    // `State` and `Anchor` are the shared definitions in `IChainAnchor`, so the bridge,
    // the staking contract and the tests all speak one type. The external ABI of
    // `postAnchor` / `getAnchor` is byte-identical to §6.1.

    // ---------------------------------------------------------------------
    // constants (§6.1, verbatim)
    // ---------------------------------------------------------------------

    /// @notice 600 seconds (decision #20). 144 of them per day.
    uint64 public constant EPOCH = 600;

    /// @notice Only ever used as a divisor / bucket size. The release tier is quoted per
    ///         DAY and cannot be expressed as an integer bps per epoch (2%/day is
    ///         1.3889 bps per epoch), so the division has to happen at the consumer.
    uint64 public constant EPOCHS_PER_DAY = 144;

    /// @notice EPOCH * EPOCHS_PER_DAY. Every "30 days" window below is measured in these.
    uint64 public constant DAY = 86400;

    /// @notice 0 (decision #25 / §7 batched attestation). The relayer must still wait
    ///         for the epoch to be over; it just no longer waits on top of that.
    uint64 public constant COMMIT_WINDOW = 0;

    /// @notice 「锚点等待」 - 120 seconds between POSTED and FINAL (decision #25).
    ///         Renamed from CHALLENGE_WINDOW per decision #18: 「挑战」 was being used
    ///         for two unrelated things (this wait, and an agent's entry verification).
    ///         2 minutes is not a human reaction window. It is a window for an automated
    ///         watchdog, and that is what the docs and the site have to say.
    uint64 public constant ANCHOR_WAIT = 120;

    /// @notice A duration, not an epoch count (12,960 epochs would be the same thing
    ///         today and the wrong thing the next time EPOCH moves).
    uint64 public constant HALT_TIMEOUT = 90 days;

    /// @notice 7 vetoes inside any 30-DAY window. Before decision #20 the window was
    ///         "30 epochs", which was 30 days; left as 30 epochs it would now be 5
    ///         hours, and a thief could post a bad root every 5 hours forever without
    ///         ever tripping the limit while a watchdog vetoing 7 bad roots in one
    ///         afternoon would force-arm the escape hatch. The count is per VETO, not
    ///         per day: 7 vetoes on one day still reach the limit.
    uint8 public constant VETO_LIMIT_PER_WINDOW = 7;
    uint8 public constant DISPUTE_LIMIT_PER_WINDOW = 3;

    /// @notice Sliding window length for the two counters above, in DAYS.
    uint8 public constant STREAK_WINDOW_DAYS = 30;

    uint8 public constant QUORUM = 3;
    uint16 public constant DISPUTE_MIN_BPS = 3333; // dispute weight must also be >= 1/3 of total stake
    uint64 public constant ADMIN_TIMELOCK = 48 hours;

    /// @notice Release tiers, PER DAY, by the rolling witness roster (0 / 1-2 / >=3).
    ///         Re-verified at the new cadence by artifacts/sim (RESULTS-buyback.md §2):
    ///         40 sybils dumping everything at epoch 0 extract 13.60% in 3 days
    ///         (budget 15%) and 71.53% in 30 days (budget 80%). 300/500/800 reaches
    ///         20.84% in 3 days and was rejected; 500/750/1000 reaches 25.33%.
    uint16 public constant RELEASE_DAILY_BPS_NONE = 200;
    uint16 public constant RELEASE_DAILY_BPS_FEW = 350;
    uint16 public constant RELEASE_DAILY_BPS_QUORUM = 500;

    // ---------------------------------------------------------------------
    // immutables / roles
    // ---------------------------------------------------------------------

    /// @notice The `BacBridge` PROXY (decision #29), read-only: `totalCreditsIssued()`.
    /// @dev Never the implementation: its storage is empty, `totalCreditsIssued()` would read 0
    ///      and check #7 would reject every anchor that credits anything. And since the owner
    ///      can upgrade the bridge at any time, check #7 is exactly as strong as the bridge's
    ///      owner key — an upgrade can change the number it reads.
    address public immutable bridge;
    uint128 public immutable initialCirculating; // = OPERATOR_FLOAT (1,000e18)
    uint64 public immutable firstEpoch; // the first anchorable epoch (deployment epoch)
    address public immutable deployer; // may call setValidatorStaking once, nothing else

    address public relayer;
    address public admin;
    address public vetoKey;
    address public validatorStaking; // bound once, by the deployer

    address public pendingRelayer;
    uint64 public pendingRelayerEta;

    // ---------------------------------------------------------------------
    // anchor state
    // ---------------------------------------------------------------------

    mapping(uint64 => IChainAnchor.Anchor) private _anchors;

    uint64 public lastPostedEpoch;
    uint64 public lastFinalEpoch;
    uint64 public lastFinalAt;
    uint256 public cumulativeCredited;
    uint256 public cumulativeExit;
    uint256 public lastFinalCirculating;

    /// @notice Running hash chain over every FINAL anchor, in order. This is what a
    ///         validator's daily batch attests to: one word instead of 144 anchor
    ///         reads, which is what makes 100% epoch coverage cost one transaction a
    ///         day instead of 288 (§7 / decision #20a).
    bytes32 public finalHead;

    /// @notice `finalHead` as of the last FINAL anchor of that day.
    mapping(uint64 => bytes32) private _dayHead;

    // sliding windows over DAYS: lane k of `_lanes` is the day `_markDay - k`,
    // one saturating uint8 counter per lane, 30 lanes in one word (revision 35).
    uint256 private _vetoLanes;
    uint64 private _vetoMarkDay;
    uint256 private _disputeLanes;
    uint64 private _disputeMarkDay;

    uint256 private constant LANE_MASK = (uint256(1) << 240) - 1; // 30 lanes * 8 bits

    // ---------------------------------------------------------------------
    // events (§6.1, verbatim)
    // ---------------------------------------------------------------------

    event AnchorPosted(
        uint64 indexed epoch,
        bytes32 exitRoot,
        bytes32 l2BlockHash,
        uint64 l2Block,
        uint128 credited,
        uint128 exitCredits,
        uint128 feeBurned,
        uint128 circulating,
        uint32 exitCount
    );
    event AnchorFinalized(uint64 indexed epoch, uint32 agreeingCount, uint16 releaseBps);
    event AnchorVetoed(uint64 indexed epoch, address indexed by, bytes32 reasonHash, uint8 countInWindow);
    event AnchorDisputed(
        uint64 indexed epoch,
        uint256 agreeingWeight,
        uint256 disputingWeight,
        uint32 disputingCount,
        uint8 countInWindow
    );
    event RelayerRotationQueued(address indexed newRelayer, uint64 eta);
    event RelayerRotationCancelled(address indexed by);
    event RelayerChanged(address indexed from, address indexed to);
    event ValidatorStakingSet(address indexed staking);

    // ---------------------------------------------------------------------
    // constructor
    // ---------------------------------------------------------------------

    /// @param bridge_ the BacBridge ERC1967 proxy (CREATE-predicted at deploy time, see §9 step 4)
    /// @param relayer_ the official relayer key
    /// @param admin_ cold key: relayer rotation (48h timelock)
    /// @param vetoKey_ cold key: veto, and cancelling a queued rotation
    /// @param initialCirculating_ OPERATOR_FLOAT = 1000e18 (C5)
    constructor(address bridge_, address relayer_, address admin_, address vetoKey_, uint128 initialCirculating_) {
        require(bridge_ != address(0), unicode"Bridge is zero / 桥地址为零");
        require(relayer_ != address(0), unicode"Relayer is zero / 中继地址为零");
        require(admin_ != address(0), unicode"Admin is zero / 管理员地址为零");
        require(vetoKey_ != address(0), unicode"Veto key is zero / veto 钥地址为零");

        bridge = bridge_;
        relayer = relayer_;
        admin = admin_;
        vetoKey = vetoKey_;
        initialCirculating = initialCirculating_;
        deployer = msg.sender;

        // C5: the informational circulating figure starts at OPERATOR_FLOAT, never at 0.
        lastFinalCirculating = initialCirculating_;

        uint64 e0 = uint64(block.timestamp / EPOCH);
        firstEpoch = e0;
        lastPostedEpoch = e0 - 1; // so that check #2 accepts `firstEpoch` first

        uint64 d0 = uint64(block.timestamp / DAY);
        _vetoMarkDay = d0;
        _disputeMarkDay = d0;

        // halt cause 1 is "no new FINAL anchor for HALT_TIMEOUT"; the clock has to start
        // at deployment, otherwise `haltReason()` returns 1 in the very first block.
        lastFinalAt = uint64(block.timestamp);
    }

    // ---------------------------------------------------------------------
    // write: postAnchor (§6.2)
    // ---------------------------------------------------------------------

    /// @notice Post the anchor of one epoch. Every check is O(1) and none of them
    ///         depends on anybody being honest (§6.2).
    function postAnchor(uint64 epoch, IChainAnchor.Anchor calldata a) external {
        // 1
        require(msg.sender == relayer, unicode"Only relayer / 仅限中继");
        // 2
        require(epoch == lastPostedEpoch + 1, unicode"Epochs must be sequential / 纪元必须连续");
        // 3
        if (epoch != firstEpoch) {
            IChainAnchor.State prev = _anchors[epoch - 1].state;
            require(
                prev == IChainAnchor.State.FINAL || prev == IChainAnchor.State.VETOED
                    || prev == IChainAnchor.State.DISPUTED,
                unicode"Previous epoch not resolved / 上一个纪元尚未定案"
            );
        }
        // 4 - the epoch has to be over. COMMIT_WINDOW is 0 now, but the term stays in
        //     the expression so that the rule and the constant cannot drift apart.
        require(
            block.timestamp >= (uint256(epoch) + 1) * EPOCH + COMMIT_WINDOW,
            unicode"Epoch not over yet / 本纪元尚未结束"
        );
        // 5 - `>=`, not `>`: an epoch with zero layer blocks must stay anchorable (C8)
        require(
            a.l2Block >= _anchors[epoch - 1].l2Block,
            unicode"Layer block must not go back / 层内区块号不得回退"
        );
        // 6
        require(a.exitCreditsInEpoch == 0 || a.exitRoot != bytes32(0), unicode"Exit root missing / 缺少退出根");
        // 7 - the load-bearing wall of the whole cross-chain design
        require(
            cumulativeCredited + a.creditedInEpoch <= IBacBridge(bridge).totalCreditsIssued(),
            unicode"Credits exceed BSC deposits / 积分超过 BSC 上锁定的数量"
        );
        // 8
        require(
            cumulativeExit + a.exitCreditsInEpoch <= cumulativeCredited + a.creditedInEpoch,
            unicode"Exit credits exceed issued / 退出积分超过已发行"
        );
        // NOTE: there is deliberately NO ledger identity check here (revision 30).
        // `circulating` is recorded as-is and never compared against anything on chain.

        IChainAnchor.Anchor storage s = _anchors[epoch];
        s.exitRoot = a.exitRoot;
        s.l2BlockHash = a.l2BlockHash;
        s.l2Block = a.l2Block;
        s.postedAt = uint64(block.timestamp);
        s.finalizedAt = 0;
        s.creditedInEpoch = a.creditedInEpoch;
        s.exitCreditsInEpoch = a.exitCreditsInEpoch;
        s.feeBurnedInEpoch = a.feeBurnedInEpoch;
        s.circulating = a.circulating;
        s.exitCount = a.exitCount;
        s.agreeingCount = 0;
        s.state = IChainAnchor.State.POSTED;

        lastPostedEpoch = epoch;

        emit AnchorPosted(
            epoch,
            a.exitRoot,
            a.l2BlockHash,
            a.l2Block,
            a.creditedInEpoch,
            a.exitCreditsInEpoch,
            a.feeBurnedInEpoch,
            a.circulating,
            a.exitCount
        );
    }

    // ---------------------------------------------------------------------
    // write: finalize (§6.3) - permissionless
    // ---------------------------------------------------------------------

    function finalize(uint64 epoch) external {
        IChainAnchor.Anchor storage s = _anchors[epoch];
        require(s.state == IChainAnchor.State.POSTED, unicode"Anchor not posted / 锚点不处于已提交状态");
        require(
            block.timestamp >= uint256(s.postedAt) + ANCHOR_WAIT, unicode"Anchor wait not over / 锚点等待未结束"
        );

        uint256 agreeingWeight;
        uint256 disputingWeight;
        uint32 agreeingCount;
        uint32 disputingCount;
        uint256 totalStaked_;

        address vs = validatorStaking;
        if (vs != address(0)) {
            (agreeingWeight, disputingWeight, agreeingCount, disputingCount) =
                IValidatorStaking(vs).attestationResult(epoch, s.exitRoot, s.l2BlockHash, s.l2Block);
            totalStaked_ = IValidatorStaking(vs).totalStaked();
        }

        // A dispute only stands if all three thresholds are met (attack-gate #3):
        //   1) weight majority  2) >= 1/3 of the total stake  3) >= QUORUM distinct addresses
        if (
            disputingWeight >= agreeingWeight && disputingWeight != 0
                && disputingWeight * 10000 >= totalStaked_ * DISPUTE_MIN_BPS && disputingCount >= QUORUM
        ) {
            s.state = IChainAnchor.State.DISPUTED;
            (_disputeLanes, _disputeMarkDay) = _mark(_disputeLanes, _disputeMarkDay, epoch / EPOCHS_PER_DAY);
            emit AnchorDisputed(epoch, agreeingWeight, disputingWeight, disputingCount, disputeCountInWindow());
            return;
        }

        s.state = IChainAnchor.State.FINAL;
        s.finalizedAt = uint64(block.timestamp);
        s.agreeingCount = agreeingCount;

        cumulativeCredited += s.creditedInEpoch;
        cumulativeExit += s.exitCreditsInEpoch;
        lastFinalCirculating = s.circulating; // informational, never validated
        lastFinalEpoch = epoch;
        lastFinalAt = uint64(block.timestamp);

        // extend the hash chain the daily batch attestation checks itself against
        bytes32 h = keccak256(abi.encode(finalHead, epoch, s.exitRoot, s.l2BlockHash, s.l2Block));
        finalHead = h;
        _dayHead[epoch / EPOCHS_PER_DAY] = h;

        emit AnchorFinalized(epoch, agreeingCount, releaseBpsFor(epoch));
    }

    // ---------------------------------------------------------------------
    // write: veto (§6.3)
    // ---------------------------------------------------------------------

    function veto(uint64 epoch, bytes32 reasonHash) external {
        require(
            msg.sender == admin || msg.sender == vetoKey, unicode"Only admin or veto key / 仅限管理员或 veto 钥"
        );
        IChainAnchor.Anchor storage s = _anchors[epoch];
        require(s.state == IChainAnchor.State.POSTED, unicode"Anchor not posted / 锚点不处于已提交状态");
        require(
            block.timestamp < uint256(s.postedAt) + ANCHOR_WAIT, unicode"Anchor wait is over / 锚点等待已结束"
        );

        s.state = IChainAnchor.State.VETOED;
        (_vetoLanes, _vetoMarkDay) = _mark(_vetoLanes, _vetoMarkDay, epoch / EPOCHS_PER_DAY);

        uint8 count = vetoCountInWindow();
        // the 8th veto inside any 30-day window reverts; the 7th arms escape (haltReason 2)
        require(count <= VETO_LIMIT_PER_WINDOW, unicode"Veto limit reached / 否决次数已用尽");

        emit AnchorVetoed(epoch, msg.sender, reasonHash, count);
    }

    // ---------------------------------------------------------------------
    // write: admin (48h timelock, none of it can move a single wei - C4)
    // ---------------------------------------------------------------------

    function proposeRelayer(address newRelayer) external {
        require(msg.sender == admin, unicode"Only admin / 仅限管理员");
        require(newRelayer != address(0), unicode"Relayer is zero / 中继地址为零");
        pendingRelayer = newRelayer;
        pendingRelayerEta = uint64(block.timestamp) + ADMIN_TIMELOCK;
        emit RelayerRotationQueued(newRelayer, pendingRelayerEta);
    }

    function executeRelayerRotation() external {
        require(msg.sender == admin, unicode"Only admin / 仅限管理员");
        address next = pendingRelayer;
        require(next != address(0), unicode"No rotation queued / 没有待执行的轮换");
        require(block.timestamp >= pendingRelayerEta, unicode"Timelock not elapsed / 时锁未到期");

        address prev = relayer;
        relayer = next;
        pendingRelayer = address(0);
        pendingRelayerEta = 0;
        emit RelayerChanged(prev, next);
    }

    function cancelRelayerRotation() external {
        require(
            msg.sender == admin || msg.sender == vetoKey, unicode"Only admin or veto key / 仅限管理员或 veto 钥"
        );
        require(pendingRelayer != address(0), unicode"No rotation queued / 没有待执行的轮换");
        pendingRelayer = address(0);
        pendingRelayerEta = 0;
        emit RelayerRotationCancelled(msg.sender);
    }

    /// @notice One-shot binding of ValidatorStaking, deployer only (§9 step 8).
    function setValidatorStaking(address s) external {
        require(msg.sender == deployer, unicode"Only deployer / 仅限部署者");
        require(validatorStaking == address(0), unicode"Already set / 已经设置过");
        require(s != address(0), unicode"Staking is zero / 质押合约地址为零");
        validatorStaking = s;
        emit ValidatorStakingSet(s);
    }

    // ---------------------------------------------------------------------
    // views
    // ---------------------------------------------------------------------

    function getAnchor(uint64 epoch) external view returns (IChainAnchor.Anchor memory) {
        return _anchors[epoch];
    }

    /// @notice The canonical `l2Block(epoch)` (§6.2) is computed off chain; the chain
    ///         only stores what was anchored.
    function l2BlockFor(uint64 epoch) external view returns (uint64) {
        return _anchors[epoch].l2Block;
    }

    /// @notice The day a given epoch belongs to.
    function dayOf(uint64 epoch) public pure returns (uint64) {
        return epoch / EPOCHS_PER_DAY;
    }

    /// @notice The hash chain head as of the last FINAL anchor of `day`, and whether it
    ///         can still change. A day is sealed once an epoch beyond it has been
    ///         posted: check #2 and check #3 of `postAnchor` together mean every epoch
    ///         of that day is already FINAL, VETOED or DISPUTED, so nothing can extend
    ///         the chain inside it any more.
    /// @dev This is the entire on-chain cost of a validator's daily batch: one word to
    ///      compare instead of 144 `getAnchor` reads.
    function dayHeadOf(uint64 day) public view returns (bytes32 head, bool sealedDay) {
        uint64 lastEpochOfDay = (day + 1) * EPOCHS_PER_DAY - 1;
        return (_dayHead[day], lastPostedEpoch > lastEpochOfDay);
    }

    /// @notice The rolling witness roster: how many distinct validator addresses have
    ///         filed an attestation recently. 0 when no staking contract is bound.
    function witnessCount() public view returns (uint32) {
        address vs = validatorStaking;
        if (vs == address(0)) return 0;
        return IValidatorStaking(vs).witnessRoster();
    }

    /// @notice 200 / 350 / 500 bps PER DAY by the rolling witness roster.
    /// @dev The `epoch` argument is kept for ABI compatibility with `BacBridge` and the
    ///      explorer, but the tier is deliberately NOT a function of that epoch any
    ///      more (RESULTS-buyback.md §4.1 B5): a daily batch lands long after
    ///      `settleEpoch` runs, so reading `_anchors[epoch].agreeingCount` at settle
    ///      time reports 0 witnesses for every epoch, forever.
    ///      The consumer must divide by `EPOCHS_PER_DAY`; this is a daily rate.
    function releaseBpsFor(uint64 epoch) public view returns (uint16) {
        epoch; // silence the unused-parameter warning without changing the ABI
        uint32 n = witnessCount();
        if (n == 0) return RELEASE_DAILY_BPS_NONE;
        if (n < QUORUM) return RELEASE_DAILY_BPS_FEW;
        return RELEASE_DAILY_BPS_QUORUM;
    }

    /// @notice 0 = no halt condition; 1 = no FINAL anchor for HALT_TIMEOUT;
    ///         2 = veto limit inside the window; 3 = dispute limit inside the window.
    /// @dev Pure view. This contract never changes state because of it - the halt
    ///      decision and its 14-day arming delay live entirely in `BacBridge`.
    function haltReason() external view returns (uint8) {
        if (block.timestamp >= uint256(lastFinalAt) + HALT_TIMEOUT) return 1;
        if (vetoCountInWindow() >= VETO_LIMIT_PER_WINDOW) return 2;
        if (disputeCountInWindow() >= DISPUTE_LIMIT_PER_WINDOW) return 3;
        return 0;
    }

    function vetoCountInWindow() public view returns (uint8) {
        return _countInWindow(_vetoLanes, _vetoMarkDay);
    }

    function disputeCountInWindow() public view returns (uint8) {
        return _countInWindow(_disputeLanes, _disputeMarkDay);
    }

    // ---------------------------------------------------------------------
    // sliding window over 30 DAYS (revision 35, re-based by decision #20)
    // ---------------------------------------------------------------------
    //
    // One word, 30 lanes of 8 bits. Lane k counts the events of day `markDay - k`, so
    // the window slides by shifting left. Counting events (not days) keeps the original
    // meaning of "7 vetoes per window": a day-bitmap would collapse seven vetoes in one
    // afternoon into a single bit.

    function _mark(uint256 lanes, uint64 markDay, uint64 day) private pure returns (uint256, uint64) {
        if (day >= markDay) {
            uint64 shift = day - markDay;
            lanes = shift >= STREAK_WINDOW_DAYS ? 0 : ((lanes << (uint256(shift) * 8)) & LANE_MASK);
            uint256 c = lanes & 0xff;
            if (c < 255) lanes = (lanes & ~uint256(0xff)) | (c + 1);
            return (lanes, day);
        }
        uint64 back = markDay - day;
        if (back < STREAK_WINDOW_DAYS) {
            uint256 sh = uint256(back) * 8;
            uint256 c = (lanes >> sh) & 0xff;
            if (c < 255) lanes = (lanes & ~(uint256(0xff) << sh)) | ((c + 1) << sh);
        }
        return (lanes, markDay);
    }

    /// @dev Counts the events that fall inside the last STREAK_WINDOW_DAYS days measured
    ///      from the *current* day, so an old burst ages out on its own. One SLOAD plus
    ///      at most 30 register-only iterations; no storage reads inside the loop.
    function _countInWindow(uint256 lanes, uint64 markDay) private view returns (uint8) {
        uint64 cur = uint64(block.timestamp / DAY);
        uint64 age = cur > markDay ? cur - markDay : 0;
        if (age >= STREAK_WINDOW_DAYS) return 0;
        uint256 keep = uint256(STREAK_WINDOW_DAYS) - uint256(age);
        uint256 total;
        for (uint256 i; i < keep; ++i) {
            total += (lanes >> (i * 8)) & 0xff;
            if (total >= 255) return 255;
        }
        return uint8(total);
    }
}
