// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ChainAnchor} from "../src/ChainAnchor.sol";
import {IChainAnchor} from "../src/interfaces/IChainAnchor.sol";

/// @dev Stand-in for `BacBridge`: ChainAnchor only ever reads `totalCreditsIssued()`.
contract MockBridge {
    uint256 public totalCreditsIssued;

    function setIssued(uint256 v) external {
        totalCreditsIssued = v;
    }
}

/// @dev Stand-in for `ValidatorStaking`, so the anchor tests can drive every branch of
///      `finalize` without a full attestation round (that is covered in
///      ValidatorStaking.t.sol). `witnessRoster` is what the release tier now reads.
contract MockStaking {
    uint256 public agreeingWeight;
    uint256 public disputingWeight;
    uint32 public agreeingCount;
    uint32 public disputingCount;
    uint256 public totalStaked;
    uint32 public witnessRoster;

    function set(uint256 aw, uint256 dw, uint32 ac, uint32 dc, uint256 ts) external {
        agreeingWeight = aw;
        disputingWeight = dw;
        agreeingCount = ac;
        disputingCount = dc;
        totalStaked = ts;
    }

    function setRoster(uint32 n) external {
        witnessRoster = n;
    }

    function attestationResult(uint64, bytes32, bytes32, uint64)
        external
        view
        returns (uint256, uint256, uint32, uint32)
    {
        return (agreeingWeight, disputingWeight, agreeingCount, disputingCount);
    }
}

contract ChainAnchorTest is Test {
    ChainAnchor internal anchor;
    MockBridge internal bridge;
    MockStaking internal staking;

    address internal relayer = address(0xBEEF);
    address internal admin = address(0xA11CE);
    address internal vetoKey = address(0xCAFE);

    uint128 internal constant OPERATOR_FLOAT = 1000e18;
    uint64 internal constant EPOCH = 600; // decision #20
    uint64 internal constant EPOCHS_PER_DAY = 144;
    uint64 internal constant DAY = 86400;
    uint64 internal constant ANCHOR_WAIT = 120; // decision #25
    uint64 internal e0; // first anchorable epoch

    function setUp() public {
        // land exactly on an epoch boundary that is also a day boundary, so that the
        // day arithmetic in the tests is easy to read
        vm.warp(uint256(200) * DAY);
        bridge = new MockBridge();
        bridge.setIssued(1_000_000e18);
        staking = new MockStaking();
        anchor = new ChainAnchor(address(bridge), relayer, admin, vetoKey, OPERATOR_FLOAT);
        e0 = anchor.firstEpoch();
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /// @dev COMMIT_WINDOW is 0, so the earliest legal post is the instant the epoch ends.
    function _postTime(uint64 epoch) internal pure returns (uint256) {
        return (uint256(epoch) + 1) * EPOCH;
    }

    function _mk(uint64 l2Block, uint128 credited, uint128 exitCredits)
        internal
        pure
        returns (IChainAnchor.Anchor memory a)
    {
        a.exitRoot = exitCredits == 0 ? bytes32(0) : keccak256(abi.encode("root", l2Block));
        a.l2BlockHash = keccak256(abi.encode("hash", l2Block));
        a.l2Block = l2Block;
        a.creditedInEpoch = credited;
        a.exitCreditsInEpoch = exitCredits;
        a.feeBurnedInEpoch = 1e15;
        a.circulating = OPERATOR_FLOAT;
        a.exitCount = exitCredits == 0 ? 0 : 1;
    }

    function _post(uint64 epoch, uint64 l2Block) internal {
        if (block.timestamp < _postTime(epoch)) vm.warp(_postTime(epoch));
        vm.prank(relayer);
        anchor.postAnchor(epoch, _mk(l2Block, 0, 0));
    }

    function _finalize(uint64 epoch) internal {
        vm.warp(uint256(anchor.getAnchor(epoch).postedAt) + ANCHOR_WAIT);
        anchor.finalize(epoch);
    }

    function _veto(uint64 epoch) internal {
        vm.prank(vetoKey);
        anchor.veto(epoch, keccak256("because"));
    }

    /// @dev Post + finalize every epoch in `[from, to]`, in order and in real time.
    function _run(uint64 from, uint64 to) internal {
        for (uint64 e = from; e <= to; ++e) {
            _post(e, 100 + (e - e0));
            _finalize(e);
        }
    }

    // ------------------------------------------------------------------
    // the clock itself (decisions #20 / #25 / #18)
    // ------------------------------------------------------------------

    function test_clock_constants() public view {
        assertEq(anchor.EPOCH(), 600, unicode"纪元 10 分钟");
        assertEq(anchor.EPOCHS_PER_DAY(), 144);
        assertEq(anchor.DAY(), 86400);
        assertEq(uint256(anchor.EPOCH()) * anchor.EPOCHS_PER_DAY(), anchor.DAY());
        assertEq(anchor.ANCHOR_WAIT(), 120, unicode"锚点等待 2 分钟");
        assertEq(anchor.COMMIT_WINDOW(), 0);
        // durations stay durations: at 144 epochs a day an epoch count would be 1/144th
        assertEq(anchor.HALT_TIMEOUT(), 90 days);
        assertEq(anchor.STREAK_WINDOW_DAYS(), 30);
    }

    /// @dev The number the product promises: burn -> wait out the epoch (<= 600 s) ->
    ///      anchor -> 120 s -> FINAL. Nothing in this contract can stretch it.
    function test_clock_worstCaseAnchorLatencyIsUnderThirteenMinutes() public {
        uint256 burnAt = _postTime(e0) - EPOCH; // the first second of epoch e0
        vm.warp(burnAt);
        _post(e0, 100);
        _finalize(e0);
        uint256 elapsed = block.timestamp - burnAt;
        assertEq(elapsed, uint256(EPOCH) + ANCHOR_WAIT, "600 + 120 seconds");
        assertLt(elapsed, 13 minutes);
    }

    // ------------------------------------------------------------------
    // deployment / C1 / C5
    // ------------------------------------------------------------------

    function test_deploy_lastFinalCirculatingIsOperatorFloat() public view {
        assertEq(anchor.lastFinalCirculating(), OPERATOR_FLOAT, "C5");
        assertEq(address(anchor).balance, 0, "C1");
        assertEq(anchor.lastPostedEpoch(), e0 - 1);
        assertEq(anchor.haltReason(), 0, "no halt at birth");
    }

    function test_deploy_hasNoPayableEntryPoint() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(anchor).call{value: 1 wei}("");
        assertFalse(ok, "C1: the anchor must not accept value");
    }

    // ------------------------------------------------------------------
    // postAnchor: the eight O(1) checks (§6.2)
    // ------------------------------------------------------------------

    function test_postAnchor_happyPath() public {
        _post(e0, 100);
        IChainAnchor.Anchor memory a = anchor.getAnchor(e0);
        assertEq(uint8(a.state), uint8(IChainAnchor.State.POSTED));
        assertEq(a.l2Block, 100);
        assertEq(anchor.lastPostedEpoch(), e0);
    }

    function test_postAnchor_onlyRelayer() public {
        vm.warp(_postTime(e0));
        vm.expectRevert(unicode"Only relayer / 仅限中继");
        anchor.postAnchor(e0, _mk(100, 0, 0));
    }

    function test_postAnchor_mustBeSequential() public {
        vm.warp(_postTime(e0 + 1));
        vm.prank(relayer);
        vm.expectRevert(unicode"Epochs must be sequential / 纪元必须连续");
        anchor.postAnchor(e0 + 1, _mk(100, 0, 0));
    }

    function test_postAnchor_previousMustBeResolved() public {
        _post(e0, 100);
        vm.warp(_postTime(e0 + 1));
        vm.prank(relayer);
        vm.expectRevert(unicode"Previous epoch not resolved / 上一个纪元尚未定案");
        anchor.postAnchor(e0 + 1, _mk(101, 0, 0));
    }

    /// @dev COMMIT_WINDOW is 0 now, but check #4 still exists and still bites: the
    ///      relayer can never anchor an epoch that is not over. This is also what keeps
    ///      `commitAttestation` honest - an accepted commitment provably predates any
    ///      possible anchor for that epoch.
    function test_postAnchor_epochMustBeOver() public {
        vm.warp(_postTime(e0) - 1); // one second before the epoch ends
        vm.prank(relayer);
        vm.expectRevert(unicode"Epoch not over yet / 本纪元尚未结束");
        anchor.postAnchor(e0, _mk(100, 0, 0));

        vm.warp(_postTime(e0)); // the instant it ends: accepted
        vm.prank(relayer);
        anchor.postAnchor(e0, _mk(100, 0, 0));
        assertEq(anchor.lastPostedEpoch(), e0);
    }

    /// @dev C8 / revision 32: a signer outage that crosses an epoch boundary produces an
    ///      epoch with zero layer blocks. `>=` must accept it or the chain's exits die.
    function test_postAnchor_zeroBlockEpochIsAccepted() public {
        _post(e0, 100);
        _finalize(e0);
        _post(e0 + 1, 100); // same l2Block, same hash: nothing happened in the layer
        assertEq(uint8(anchor.getAnchor(e0 + 1).state), uint8(IChainAnchor.State.POSTED));
        assertEq(anchor.l2BlockFor(e0 + 1), 100);
    }

    function test_postAnchor_layerBlockMustNotGoBack() public {
        _post(e0, 100);
        _finalize(e0);
        vm.warp(_postTime(e0 + 1));
        vm.prank(relayer);
        vm.expectRevert(unicode"Layer block must not go back / 层内区块号不得回退");
        anchor.postAnchor(e0 + 1, _mk(99, 0, 0));
    }

    function test_postAnchor_exitRootMissing() public {
        vm.warp(_postTime(e0));
        IChainAnchor.Anchor memory a = _mk(100, 0, 5e18);
        a.exitRoot = bytes32(0);
        vm.prank(relayer);
        vm.expectRevert(unicode"Exit root missing / 缺少退出根");
        anchor.postAnchor(e0, a);
    }

    function test_postAnchor_creditsCannotExceedBscDeposits() public {
        bridge.setIssued(10e18);
        vm.warp(_postTime(e0));
        vm.prank(relayer);
        vm.expectRevert(unicode"Credits exceed BSC deposits / 积分超过 BSC 上锁定的数量");
        anchor.postAnchor(e0, _mk(100, 11e18, 0));
    }

    /// @dev The cumulative counter only moves on FINAL, so an over-issue is caught even
    ///      after a legitimate epoch has been anchored.
    function test_postAnchor_cumulativeCreditsAreEnforcedAcrossEpochs() public {
        bridge.setIssued(10e18);
        vm.warp(_postTime(e0));
        vm.prank(relayer);
        anchor.postAnchor(e0, _mk(100, 10e18, 0));
        _finalize(e0);
        assertEq(anchor.cumulativeCredited(), 10e18);

        vm.warp(_postTime(e0 + 1));
        vm.prank(relayer);
        vm.expectRevert(unicode"Credits exceed BSC deposits / 积分超过 BSC 上锁定的数量");
        anchor.postAnchor(e0 + 1, _mk(101, 1, 0));
    }

    function test_postAnchor_exitCreditsCannotExceedIssued() public {
        bridge.setIssued(10e18);
        vm.warp(_postTime(e0));
        vm.prank(relayer);
        vm.expectRevert(unicode"Exit credits exceed issued / 退出积分超过已发行");
        anchor.postAnchor(e0, _mk(100, 1e18, 2e18));
    }

    /// @dev C7 + revision 30: the deleted ledger identity check means no balance, no
    ///      transfer and no third party can make `postAnchor` revert. `circulating` is
    ///      recorded verbatim even when it is nonsense.
    function test_postAnchor_circulatingIsInformationalOnly() public {
        vm.warp(_postTime(e0));
        IChainAnchor.Anchor memory a = _mk(100, 1e18, 0);
        a.circulating = 123456789; // someone sent 1 wei into the layer bridge, etc.
        vm.prank(relayer);
        anchor.postAnchor(e0, a);
        assertEq(anchor.getAnchor(e0).circulating, 123456789);

        _finalize(e0);
        assertEq(anchor.lastFinalCirculating(), 123456789, "recorded, never validated");
    }

    // ------------------------------------------------------------------
    // finalize (§6.3)
    // ------------------------------------------------------------------

    function test_finalize_requiresPostedAndTheAnchorWait() public {
        vm.expectRevert(unicode"Anchor not posted / 锚点不处于已提交状态");
        anchor.finalize(e0);

        _post(e0, 100);
        vm.warp(uint256(anchor.getAnchor(e0).postedAt) + ANCHOR_WAIT - 1);
        vm.expectRevert(unicode"Anchor wait not over / 锚点等待未结束");
        anchor.finalize(e0);
    }

    function test_finalize_withoutValidatorsIsFinalAt200Bps() public {
        _post(e0, 100);
        _finalize(e0);
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.FINAL));
        assertEq(anchor.getAnchor(e0).agreeingCount, 0);
        assertEq(anchor.releaseBpsFor(e0), 200, "per DAY, not per epoch");
        assertEq(anchor.lastFinalEpoch(), e0);
    }

    // ------------------------------------------------------------------
    // the release ladder now reads the ROLLING ROSTER (RESULTS-buyback.md §4.1 B5)
    // ------------------------------------------------------------------

    function test_releaseBpsLadder_readsTheRollingRoster() public {
        anchor.setValidatorStaking(address(staking));

        staking.setRoster(0);
        assertEq(anchor.releaseBpsFor(e0), 200, "no witnesses");
        staking.setRoster(1);
        assertEq(anchor.releaseBpsFor(e0), 350, "1 witness");
        staking.setRoster(2);
        assertEq(anchor.releaseBpsFor(e0), 350, "2 witnesses");
        staking.setRoster(3);
        assertEq(anchor.releaseBpsFor(e0), 500, "QUORUM witnesses");
        assertEq(anchor.witnessCount(), 3);
    }

    /// @dev The regression this change exists for: a batched daily attestation lands
    ///      long after `settleEpoch` runs, so this epoch's `agreeingCount` is 0 at the
    ///      moment the bridge asks. Reading it would pin the release tier at 200 bps
    ///      per day forever, no matter how many nodes are actually running.
    function test_releaseBps_isNotThisEpochsAgreeingCount() public {
        anchor.setValidatorStaking(address(staking));
        staking.setRoster(5); // five nodes are up and attesting daily
        staking.set(0, 0, 0, 0, 100e18); // nobody revealed live for THIS epoch

        _post(e0, 100);
        _finalize(e0);

        assertEq(anchor.getAnchor(e0).agreeingCount, 0, "no live reveal for this epoch");
        assertEq(anchor.releaseBpsFor(e0), 500, "the roster is what pays");
    }

    function test_releaseBps_isZeroRosterWhenStakingIsUnbound() public view {
        assertEq(anchor.validatorStaking(), address(0));
        assertEq(anchor.witnessCount(), 0);
        assertEq(anchor.releaseBpsFor(e0), 200);
    }

    // ------------------------------------------------------------------
    // dispute thresholds (unchanged)
    // ------------------------------------------------------------------

    /// @dev C6: a single address (however many nodeIdHashes it holds) can never force a
    ///      DISPUTED epoch, because one of the three thresholds is the distinct address count.
    function test_finalize_disputeNeedsQuorumOfAddresses() public {
        anchor.setValidatorStaking(address(staking));
        // majority weight AND above the 1/3 absolute floor, but only 2 distinct addresses
        staking.set(10e18, 90e18, 1, 2, 100e18);
        _post(e0, 100);
        _finalize(e0);
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.FINAL), "C6");
        assertEq(anchor.disputeCountInWindow(), 0);
    }

    function test_finalize_disputeNeedsOneThirdOfTotalStake() public {
        anchor.setValidatorStaking(address(staking));
        // 3 addresses and a weight majority, but only 10% of the total stake
        staking.set(1e18, 10e18, 1, 3, 100e18);
        _post(e0, 100);
        _finalize(e0);
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.FINAL));
    }

    function test_finalize_disputedWhenAllThreeThresholdsAreMet() public {
        anchor.setValidatorStaking(address(staking));
        staking.set(10e18, 40e18, 1, 3, 100e18);
        _post(e0, 100);
        _finalize(e0);

        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.DISPUTED));
        assertEq(anchor.disputeCountInWindow(), 1);
        // a DISPUTED epoch settles nothing and releases nothing
        assertEq(anchor.cumulativeCredited(), 0);
        assertEq(anchor.lastFinalEpoch(), 0);
    }

    function test_haltReason3_afterThreeDisputesInWindow() public {
        anchor.setValidatorStaking(address(staking));
        staking.set(10e18, 40e18, 1, 3, 100e18);

        for (uint64 i; i < 3; ++i) {
            _post(e0 + i, 100 + i);
            _finalize(e0 + i);
            assertEq(uint8(anchor.getAnchor(e0 + i).state), uint8(IChainAnchor.State.DISPUTED));
        }
        assertEq(anchor.disputeCountInWindow(), 3);
        assertEq(anchor.haltReason(), 3, "dispute limit inside the window");
    }

    // ------------------------------------------------------------------
    // veto + the 30-DAY sliding window (revision 35, re-based by decision #20)
    // ------------------------------------------------------------------

    function test_veto_onlyAdminOrVetoKey_andOnlyInsideTheWait() public {
        _post(e0, 100);
        vm.expectRevert(unicode"Only admin or veto key / 仅限管理员或 veto 钥");
        anchor.veto(e0, bytes32(0));

        vm.warp(uint256(anchor.getAnchor(e0).postedAt) + ANCHOR_WAIT);
        vm.prank(admin);
        vm.expectRevert(unicode"Anchor wait is over / 锚点等待已结束");
        anchor.veto(e0, bytes32(0));
    }

    /// @dev THE revision-35 test: "veto seven, let one through, veto seven more".
    ///      Under the old consecutive counter (reset on every FINAL) this loop ran
    ///      forever and never tripped a halt condition.
    function test_veto_slidingWindowClosesTheLetOneThroughBypass() public {
        uint64 e = e0;
        for (uint64 i; i < 7; ++i) {
            _post(e, 100 + e - e0);
            _veto(e);
            e += 1;
        }
        assertEq(anchor.vetoCountInWindow(), 7);
        assertEq(anchor.haltReason(), 2, "veto limit reached inside the window");

        // let one epoch through: under the old rule this reset the streak to 0
        _post(e, 100 + e - e0);
        _finalize(e);
        e += 1;
        assertEq(anchor.vetoCountInWindow(), 7, "a FINAL epoch must NOT clear the window");
        assertEq(anchor.haltReason(), 2);

        // the next veto inside the same 30-day window is refused outright
        _post(e, 100 + e - e0);
        vm.prank(vetoKey);
        vm.expectRevert(unicode"Veto limit reached / 否决次数已用尽");
        anchor.veto(e, bytes32(0));
    }

    /// @dev The whole reason the window had to be re-based. Those seven vetoes happen
    ///      inside 70 minutes - one single day. A window of "30 epochs" would now be 5
    ///      hours and a day bitmap would collapse them into one bit; either way the
    ///      limit would stop meaning "7 vetoes a month". It has to still be 7 here.
    function test_veto_sevenInsideOneDayStillReachesTheLimit() public {
        uint64 e = e0;
        for (uint64 i; i < 7; ++i) {
            _post(e, 100 + e - e0);
            _veto(e);
            e += 1;
        }
        // 7 vetoes, 7 consecutive epochs, 70 minutes of wall clock, one calendar day
        assertLt(block.timestamp - uint256(200) * DAY, 1 hours + 20 minutes);
        assertEq(anchor.vetoCountInWindow(), 7, "counted per veto, not per day");
        assertEq(anchor.haltReason(), 2);
    }

    /// @dev Five hours is nothing now. The window has to be long enough that a thief
    ///      who posts one bad root every few hours still trips it, which is exactly
    ///      what "30 epochs" would have stopped doing.
    function test_veto_spreadOverDaysStillAccumulates() public {
        uint64 e = e0;
        for (uint64 i; i < 7; ++i) {
            // one veto every 3 days: 18 days total, still inside a 30-day window
            vm.warp(uint256(200) * DAY + uint256(i) * 3 * DAY);
            e = uint64(block.timestamp / EPOCH);
            if (e <= anchor.lastPostedEpoch()) e = anchor.lastPostedEpoch() + 1;
            _post(e, 100 + i);
            _veto(e);
        }
        assertEq(anchor.vetoCountInWindow(), 7, "7 vetoes across 18 days is still 7");
        assertEq(anchor.haltReason(), 2);
    }

    /// @dev The window is a window: once the burst is more than 30 DAYS old it ages out
    ///      on its own and vetoing becomes possible again.
    function test_veto_windowAgesOut() public {
        uint64 e = e0;
        for (uint64 i; i < 7; ++i) {
            _post(e, 100 + e - e0);
            _veto(e);
            e += 1;
        }
        assertEq(anchor.vetoCountInWindow(), 7);

        vm.warp(uint256(229) * DAY); // 29 days later: still inside
        assertEq(anchor.vetoCountInWindow(), 7, "29 days is inside a 30-day window");

        vm.warp(uint256(230) * DAY); // 30 days later: aged out
        assertEq(anchor.vetoCountInWindow(), 0, "the burst aged out of the window");
        assertEq(anchor.haltReason(), 0);
    }

    function test_vetoedEpochIsTerminalAndCannotBeFinalized() public {
        _post(e0, 100);
        _veto(e0);
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.VETOED));
        vm.warp(block.timestamp + ANCHOR_WAIT);
        vm.expectRevert(unicode"Anchor not posted / 锚点不处于已提交状态");
        anchor.finalize(e0);
        // and the relayer can keep going: a vetoed epoch counts as resolved
        _post(e0 + 1, 101);
        assertEq(uint8(anchor.getAnchor(e0 + 1).state), uint8(IChainAnchor.State.POSTED));
    }

    // ------------------------------------------------------------------
    // the daily hash chain the batched attestation checks itself against
    // ------------------------------------------------------------------

    function test_dayHead_extendsOnEveryFinalAndOnlyOnFinal() public {
        assertEq(anchor.finalHead(), bytes32(0));

        _post(e0, 100);
        _finalize(e0);
        bytes32 h1 = anchor.finalHead();
        assertTrue(h1 != bytes32(0));

        // a vetoed epoch must not extend the chain
        _post(e0 + 1, 101);
        _veto(e0 + 1);
        assertEq(anchor.finalHead(), h1, "VETOED does not extend the chain");

        _post(e0 + 2, 102);
        _finalize(e0 + 2);
        assertTrue(anchor.finalHead() != h1);

        // and it is reproducible off chain from the anchors alone
        IChainAnchor.Anchor memory a = anchor.getAnchor(e0 + 2);
        assertEq(anchor.finalHead(), keccak256(abi.encode(h1, e0 + 2, a.exitRoot, a.l2BlockHash, a.l2Block)));
    }

    function test_dayHead_isNotSealedUntilTheDayIsFullyAnchored() public {
        uint64 day = anchor.dayOf(e0);
        uint64 lastOfDay = (day + 1) * EPOCHS_PER_DAY - 1;

        (, bool sealed0) = anchor.dayHeadOf(day);
        assertFalse(sealed0, "nothing anchored yet");

        _run(e0, lastOfDay);
        (bytes32 head1, bool sealed1) = anchor.dayHeadOf(day);
        assertFalse(sealed1, "the day's last epoch is anchored but the day is not sealed");
        assertEq(head1, anchor.finalHead());

        // one epoch beyond the day: check #2 + check #3 mean every epoch of the day is
        // resolved, so the head can never change again
        _post(lastOfDay + 1, 999);
        (bytes32 head2, bool sealed2) = anchor.dayHeadOf(day);
        assertTrue(sealed2, "sealed");
        assertEq(head2, head1, "and frozen at the day's last FINAL anchor");

        _finalize(lastOfDay + 1);
        (bytes32 head3,) = anchor.dayHeadOf(day);
        assertEq(head3, head1, "the next day's anchors do not touch it");
        assertEq(anchor.dayOf(lastOfDay + 1), day + 1);
    }

    // ------------------------------------------------------------------
    // halt cause 1 - a DURATION, not an epoch count
    // ------------------------------------------------------------------

    function test_haltReason1_afterNinetyDaysWithoutFinal() public {
        assertEq(anchor.haltReason(), 0);
        vm.warp(block.timestamp + 90 days);
        assertEq(anchor.haltReason(), 1);
    }

    /// @dev 90 days is 12,960 epochs now. If the constant had been written as an epoch
    ///      count it would have become 90 * 600 seconds = 15 hours.
    function test_haltReason1_isNinetyDaysNotNinetyEpochs() public {
        _post(e0, 100);
        _finalize(e0);
        vm.warp(block.timestamp + 90 * uint256(EPOCH));
        assertEq(anchor.haltReason(), 0, "90 epochs is 15 hours and must not halt");
        assertEq(anchor.HALT_TIMEOUT() / EPOCH, 12960);
    }

    function test_haltReason1_clockRestartsOnEveryFinal() public {
        _post(e0, 100);
        _finalize(e0);
        uint64 finalAt = anchor.lastFinalAt();
        vm.warp(uint256(finalAt) + 90 days - 1);
        assertEq(anchor.haltReason(), 0);
        vm.warp(uint256(finalAt) + 90 days);
        assertEq(anchor.haltReason(), 1);
    }

    // ------------------------------------------------------------------
    // admin paths (C4: none of them moves a wei)
    // ------------------------------------------------------------------

    function test_relayerRotationRespectsTheTimelock() public {
        address newRelayer = address(0xD00D);
        vm.prank(admin);
        anchor.proposeRelayer(newRelayer);

        vm.prank(admin);
        vm.expectRevert(unicode"Timelock not elapsed / 时锁未到期");
        anchor.executeRelayerRotation();

        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        anchor.executeRelayerRotation();
        assertEq(anchor.relayer(), newRelayer);
    }

    function test_vetoKeyCanCancelARelayerRotation() public {
        vm.prank(admin);
        anchor.proposeRelayer(address(0xD00D));
        vm.prank(vetoKey);
        anchor.cancelRelayerRotation();
        assertEq(anchor.pendingRelayer(), address(0));

        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        vm.expectRevert(unicode"No rotation queued / 没有待执行的轮换");
        anchor.executeRelayerRotation();
    }

    function test_setValidatorStakingIsDeployerOnlyAndOneShot() public {
        vm.prank(admin);
        vm.expectRevert(unicode"Only deployer / 仅限部署者");
        anchor.setValidatorStaking(address(staking));

        anchor.setValidatorStaking(address(staking));
        assertEq(anchor.validatorStaking(), address(staking));

        vm.expectRevert(unicode"Already set / 已经设置过");
        anchor.setValidatorStaking(address(0xBAD));
    }

    // ------------------------------------------------------------------
    // 「挑战」 must be gone from the surface (decision #18)
    // ------------------------------------------------------------------

    function test_terminology_noChallengeWindowInTheAbi() public {
        (bool ok,) = address(anchor).staticcall(abi.encodeWithSignature("CHALLENGE_WINDOW()"));
        assertFalse(ok, unicode"CHALLENGE_WINDOW 必须已经改名为 ANCHOR_WAIT");
        (bool ok2, bytes memory out) = address(anchor).staticcall(abi.encodeWithSignature("ANCHOR_WAIT()"));
        assertTrue(ok2);
        assertEq(abi.decode(out, (uint64)), 120);
    }
}
