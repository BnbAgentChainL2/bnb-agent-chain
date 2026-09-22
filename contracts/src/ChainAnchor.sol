// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IChainAnchor} from "./interfaces/IChainAnchor.sol";
import {IBacBridge} from "./interfaces/IBacBridge.sol";
import {IValidatorStaking} from "./interfaces/IValidatorStaking.sol";

/// @title ChainAnchor
/// @notice The clock of BNB Agent Chain: one anchor per UTC day, posted by the relayer,
///         challengeable for 24h, finalized by anyone. It holds no funds at all
///         (no `receive()`, no `payable` function, invariant C1).
///
/// @dev Implements docs/01-CONTRACT-SPEC.md §6 including every entry of the revision
///      record that touches it:
///        - #30: the ledger identity check is DELETED. `circulating` is informational
///               only; the load-bearing checks are #7/#8 which use the BSC-side counter
///               `IBacBridge.totalCreditsIssued()` only. `initialCirculating` is a
///               constructor parameter so that C5 holds from block 0.
///        - #32: check #5 is `>=`, so an epoch with zero layer blocks (a signer outage
///               that crosses a UTC day) can still be anchored (C8).
///        - #34: check #4 forces the relayer to wait `COMMIT_WINDOW` after the epoch
///               ends, so witnesses always have 2 hours to commit.
///        - #35: veto / dispute counting is a 30-epoch sliding window bitmap (uint32,
///               O(1), no loops), not a "consecutive + reset on FINAL" streak.
contract ChainAnchor {
    // `State` and `Anchor` are the shared definitions in `IChainAnchor`, so the bridge,
    // the staking contract and the tests all speak one type. The external ABI of
    // `postAnchor` / `getAnchor` is byte-identical to §6.1.

    // ---------------------------------------------------------------------
    // constants (§6.1, verbatim)
    // ---------------------------------------------------------------------

    uint64 public constant EPOCH = 86400;
    uint64 public constant COMMIT_WINDOW = 2 hours; // relayer must wait this long after the epoch ends
    uint64 public constant CHALLENGE_WINDOW = 24 hours;
    uint64 public constant HALT_TIMEOUT = 90 days;
    uint8 public constant VETO_LIMIT_PER_WINDOW = 7; // inside any STREAK_WINDOW consecutive epochs
    uint8 public constant DISPUTE_LIMIT_PER_WINDOW = 3;
    uint8 public constant STREAK_WINDOW = 30; // sliding window length in epochs (uint32 bitmap)
    uint8 public constant QUORUM = 3;
    uint16 public constant DISPUTE_MIN_BPS = 3333; // dispute weight must also be >= 1/3 of total stake
    uint64 public constant ADMIN_TIMELOCK = 48 hours;

    // ---------------------------------------------------------------------
    // immutables / roles
    // ---------------------------------------------------------------------

    address public immutable bridge; // read-only: totalCreditsIssued()
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

    // sliding windows: bit k of `_bits` is the epoch `_markEpoch - k` (revision 35)
    uint32 private _vetoBits;
    uint64 private _vetoMarkEpoch;
    uint32 private _disputeBits;
    uint64 private _disputeMarkEpoch;

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

    /// @param bridge_ BacBridge (CREATE-predicted at deploy time, see §9 step 4)
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
        _vetoMarkEpoch = e0;
        _disputeMarkEpoch = e0;

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
        // 4 - the commit window is written into the contract, the relayer cannot squeeze it
        require(
            block.timestamp >= (uint256(epoch) + 1) * EPOCH + COMMIT_WINDOW,
            unicode"Commit window not closed / 承诺窗口未结束"
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
            block.timestamp >= uint256(s.postedAt) + CHALLENGE_WINDOW,
            unicode"Challenge window not closed / 挑战窗口未结束"
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
            (_disputeBits, _disputeMarkEpoch) = _mark(_disputeBits, _disputeMarkEpoch, epoch);
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
            block.timestamp < uint256(s.postedAt) + CHALLENGE_WINDOW,
            unicode"Challenge window closed / 挑战窗口已结束"
        );

        s.state = IChainAnchor.State.VETOED;
        (_vetoBits, _vetoMarkEpoch) = _mark(_vetoBits, _vetoMarkEpoch, epoch);

        uint8 count = vetoCountInWindow();
        // the 8th veto inside any 30-epoch window reverts; the 7th arms escape (haltReason 2)
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

    /// @notice 200 / 350 / 500 bps by the number of independent witnesses that agreed.
    function releaseBpsFor(uint64 epoch) public view returns (uint16) {
        uint32 n = _anchors[epoch].agreeingCount;
        if (n == 0) return 200;
        if (n < QUORUM) return 350;
        return 500;
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
        return _countInWindow(_vetoBits, _vetoMarkEpoch);
    }

    function disputeCountInWindow() public view returns (uint8) {
        return _countInWindow(_disputeBits, _disputeMarkEpoch);
    }

    // ---------------------------------------------------------------------
    // sliding window bitmap (revision 35) - O(1), no loops
    // ---------------------------------------------------------------------

    /// @dev bit k of `bits` represents the epoch `markEpoch - k`.
    function _mark(uint32 bits, uint64 markEpoch, uint64 epoch) private pure returns (uint32, uint64) {
        if (epoch >= markEpoch) {
            uint64 shift = epoch - markEpoch;
            bits = shift >= 32 ? 0 : (bits << uint32(shift));
            bits |= 1;
            return (bits, epoch);
        }
        uint64 back = markEpoch - epoch;
        if (back < 32) bits |= uint32(1) << uint32(back);
        return (bits, markEpoch);
    }

    /// @dev Counts the marks that fall inside the last STREAK_WINDOW epochs measured
    ///      from the *current* epoch, so an old burst ages out on its own.
    function _countInWindow(uint32 bits, uint64 markEpoch) private view returns (uint8) {
        uint64 cur = uint64(block.timestamp / EPOCH);
        uint64 age = cur > markEpoch ? cur - markEpoch : 0;
        if (age >= STREAK_WINDOW) return 0;
        uint32 mask = uint32((uint256(1) << (uint256(STREAK_WINDOW) - age)) - 1);
        return _popcount(bits & mask);
    }

    function _popcount(uint32 x) private pure returns (uint8) {
        unchecked {
            x = x - ((x >> 1) & 0x55555555);
            x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
            x = (x + (x >> 4)) & 0x0f0f0f0f;
            return uint8((x * 0x01010101) >> 24);
        }
    }
}
