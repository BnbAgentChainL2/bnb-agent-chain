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
///      `finalize` without a full commit-reveal round (that is covered in ValidatorStaking.t.sol).
contract MockStaking {
    uint256 public agreeingWeight;
    uint256 public disputingWeight;
    uint32 public agreeingCount;
    uint32 public disputingCount;
    uint256 public totalStaked;

    function set(uint256 aw, uint256 dw, uint32 ac, uint32 dc, uint256 ts) external {
        agreeingWeight = aw;
        disputingWeight = dw;
        agreeingCount = ac;
        disputingCount = dc;
        totalStaked = ts;
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
    uint64 internal constant EPOCH = 86400;
    uint64 internal e0; // first anchorable epoch

    function setUp() public {
        vm.warp(uint256(20000) * EPOCH); // land exactly on an epoch boundary
        bridge = new MockBridge();
        bridge.setIssued(1_000_000e18);
        staking = new MockStaking();
        anchor = new ChainAnchor(address(bridge), relayer, admin, vetoKey, OPERATOR_FLOAT);
        e0 = anchor.firstEpoch();
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _postTime(uint64 epoch) internal pure returns (uint256) {
        return (uint256(epoch) + 1) * EPOCH + 2 hours + 1;
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
        vm.warp(_postTime(epoch));
        vm.prank(relayer);
        anchor.postAnchor(epoch, _mk(l2Block, 0, 0));
    }

    function _finalize(uint64 epoch) internal {
        vm.warp(_postTime(epoch) + anchor.CHALLENGE_WINDOW());
        anchor.finalize(epoch);
    }

    function _veto(uint64 epoch) internal {
        vm.prank(vetoKey);
        anchor.veto(epoch, keccak256("because"));
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

    function test_postAnchor_commitWindowMustBeClosed() public {
        vm.warp((uint256(e0) + 1) * EPOCH); // the instant the epoch ends
        vm.prank(relayer);
        vm.expectRevert(unicode"Commit window not closed / 承诺窗口未结束");
        anchor.postAnchor(e0, _mk(100, 0, 0));

        vm.warp((uint256(e0) + 1) * EPOCH + 2 hours - 1); // one second short
        vm.prank(relayer);
        vm.expectRevert(unicode"Commit window not closed / 承诺窗口未结束");
        anchor.postAnchor(e0, _mk(100, 0, 0));
    }

    /// @dev C8 / revision 32: a signer outage that crosses a UTC day produces an epoch
    ///      with zero layer blocks. `>=` must accept it or the chain's exits die forever.
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

    function test_finalize_requiresPostedAndWindow() public {
        vm.expectRevert(unicode"Anchor not posted / 锚点不处于已提交状态");
        anchor.finalize(e0);

        _post(e0, 100);
        vm.warp(_postTime(e0) + 24 hours - 1);
        vm.expectRevert(unicode"Challenge window not closed / 挑战窗口未结束");
        anchor.finalize(e0);
    }

    function test_finalize_withoutValidatorsIsFinalAt200Bps() public {
        _post(e0, 100);
        _finalize(e0);
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.FINAL));
        assertEq(anchor.getAnchor(e0).agreeingCount, 0);
        assertEq(anchor.releaseBpsFor(e0), 200);
        assertEq(anchor.lastFinalEpoch(), e0);
    }

    function test_releaseBpsLadder() public {
        anchor.setValidatorStaking(address(staking));

        staking.set(1, 0, 1, 0, 100);
        _post(e0, 100);
        _finalize(e0);
        assertEq(anchor.releaseBpsFor(e0), 350, "1 witness");

        staking.set(1, 0, 2, 0, 100);
        _post(e0 + 1, 101);
        _finalize(e0 + 1);
        assertEq(anchor.releaseBpsFor(e0 + 1), 350, "2 witnesses");

        staking.set(1, 0, 3, 0, 100);
        _post(e0 + 2, 102);
        _finalize(e0 + 2);
        assertEq(anchor.releaseBpsFor(e0 + 2), 500, "QUORUM witnesses");
    }

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
    // veto + the 30-epoch sliding window (revision 35)
    // ------------------------------------------------------------------

    function test_veto_onlyAdminOrVetoKey_andOnlyInsideTheWindow() public {
        _post(e0, 100);
        vm.expectRevert(unicode"Only admin or veto key / 仅限管理员或 veto 钥");
        anchor.veto(e0, bytes32(0));

        vm.warp(_postTime(e0) + 24 hours);
        vm.prank(admin);
        vm.expectRevert(unicode"Challenge window closed / 挑战窗口已结束");
        anchor.veto(e0, bytes32(0));
    }

    /// @dev THE revision-35 test: "veto seven, let one through, veto seven more".
    ///      Under the old consecutive counter (reset on every FINAL) this loop ran
    ///      forever and never tripped a halt condition. With a sliding window the
    ///      8th veto inside 30 epochs reverts and haltReason is already 2.
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

        // the next veto inside the same 30-epoch window is refused outright
        _post(e, 100 + e - e0);
        vm.prank(vetoKey);
        vm.expectRevert(unicode"Veto limit reached / 否决次数已用尽");
        anchor.veto(e, bytes32(0));
    }

    /// @dev The window is a window: once the burst is more than STREAK_WINDOW epochs
    ///      old it ages out on its own and vetoing becomes possible again.
    function test_veto_windowAgesOut() public {
        uint64 e = e0;
        for (uint64 i; i < 7; ++i) {
            _post(e, 100 + e - e0);
            _veto(e);
            e += 1;
        }
        assertEq(anchor.vetoCountInWindow(), 7);

        vm.warp(uint256(e0 + 40) * EPOCH); // 40 epochs after the first veto
        assertEq(anchor.vetoCountInWindow(), 0, "the burst aged out of the window");
        assertEq(anchor.haltReason(), 0);
    }

    function test_vetoedEpochIsTerminalAndCannotBeFinalized() public {
        _post(e0, 100);
        _veto(e0);
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.VETOED));
        vm.warp(_postTime(e0) + 24 hours);
        vm.expectRevert(unicode"Anchor not posted / 锚点不处于已提交状态");
        anchor.finalize(e0);
        // and the relayer can keep going: a vetoed epoch counts as resolved
        _post(e0 + 1, 101);
        assertEq(uint8(anchor.getAnchor(e0 + 1).state), uint8(IChainAnchor.State.POSTED));
    }

    // ------------------------------------------------------------------
    // halt cause 1
    // ------------------------------------------------------------------

    function test_haltReason1_afterNinetyDaysWithoutFinal() public {
        assertEq(anchor.haltReason(), 0);
        vm.warp(block.timestamp + 90 days);
        assertEq(anchor.haltReason(), 1);
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
}
