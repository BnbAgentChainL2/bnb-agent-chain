// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ChainAnchor} from "../src/ChainAnchor.sol";
import {ValidatorStaking} from "../src/ValidatorStaking.sol";
import {IChainAnchor} from "../src/interfaces/IChainAnchor.sol";

/// @dev Minimal BAC stand-in: the real token is the Flap Tax Token V3 at ...7777.
contract MockBAC {
    string public name = "BNB Agent Chain";
    string public symbol = "BAC";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockBridge {
    uint256 public totalCreditsIssued = 1_000_000e18;
}

contract ValidatorStakingTest is Test {
    MockBAC internal bac;
    MockBridge internal bridge;
    ChainAnchor internal anchor;
    ValidatorStaking internal vs;

    address internal relayer = address(0xBEEF);
    address internal admin = address(0xA11CE);
    address internal vetoKey = address(0xCAFE);

    address internal v1 = address(0x101);
    address internal v2 = address(0x102);
    address internal v3 = address(0x103);
    address internal v4 = address(0x104);

    uint64 internal constant EPOCH = 86400;
    uint256 internal constant MIN_STAKE = 2_000_000e18;
    bytes32 internal constant SALT = keccak256("salt");

    uint64 internal e0;
    bytes32 internal root = keccak256("exitRoot");
    bytes32 internal blockHash = keccak256("l2BlockHash");
    uint64 internal l2Block = 777;

    function setUp() public {
        vm.warp(uint256(20000) * EPOCH);
        bac = new MockBAC();
        bridge = new MockBridge();
        anchor = new ChainAnchor(address(bridge), relayer, admin, vetoKey, 1000e18);
        vs = new ValidatorStaking(address(bac), address(anchor), admin);
        anchor.setValidatorStaking(address(vs));
        e0 = anchor.firstEpoch();
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _fund(address who, uint256 amount) internal {
        bac.mint(who, amount);
        vm.prank(who);
        bac.approve(address(vs), type(uint256).max);
    }

    function _stake(address who, uint256 amount) internal {
        _fund(who, amount);
        vm.prank(who);
        vs.stake(amount);
    }

    function _node(address who, bytes32 id) internal {
        vm.prank(who);
        vs.registerNode(id, "enode://abc@1.2.3.4:30303", who);
    }

    function _stakeAndRegister(address who, uint256 amount, bytes32 id) internal {
        _stake(who, amount);
        _node(who, id);
    }

    function _commit(address who, uint64 epoch, bytes32 r, bytes32 h, uint64 b) internal {
        vm.prank(who);
        vs.commitAttestation(epoch, keccak256(abi.encode(epoch, r, h, b, SALT, who)));
    }

    function _reveal(address who, uint64 epoch, bytes32 r, bytes32 h, uint64 b) internal {
        vm.prank(who);
        vs.revealAttestation(epoch, r, h, b, SALT);
    }

    function _postTime(uint64 epoch) internal pure returns (uint256) {
        return (uint256(epoch) + 1) * EPOCH + 2 hours + 1;
    }

    function _commitTime(uint64 epoch) internal pure returns (uint256) {
        return (uint256(epoch) + 1) * EPOCH + 1 hours;
    }

    function _postAnchor(uint64 epoch, bytes32 r, bytes32 h, uint64 b) internal {
        vm.warp(_postTime(epoch));
        IChainAnchor.Anchor memory a;
        a.exitRoot = r;
        a.l2BlockHash = h;
        a.l2Block = b;
        a.circulating = 1000e18;
        vm.prank(relayer);
        anchor.postAnchor(epoch, a);
    }

    function _finalize(uint64 epoch) internal {
        vm.warp(_postTime(epoch) + 24 hours);
        anchor.finalize(epoch);
    }

    // ------------------------------------------------------------------
    // staking + S4
    // ------------------------------------------------------------------

    function test_stakeIsMeasuredByBalanceDelta() public {
        _stake(v1, MIN_STAKE);
        (uint256 staked, uint256 pending, uint64 unlockAt) = vs.stakeOf(v1);
        assertEq(staked, MIN_STAKE);
        assertEq(pending, 0);
        assertEq(unlockAt, 0);
        assertEq(vs.totalStaked(), MIN_STAKE);
        assertEq(bac.balanceOf(address(vs)), MIN_STAKE);
    }

    function test_unstakeCooldownIsSevenDays() public {
        _stake(v1, MIN_STAKE);
        vm.prank(v1);
        vs.requestUnstake(MIN_STAKE);
        (, uint256 pending, uint64 unlockAt) = vs.stakeOf(v1);
        assertEq(pending, MIN_STAKE);
        assertEq(unlockAt, uint64(block.timestamp) + 7 days);
        assertEq(vs.totalStaked(), 0, "stake leaves totalStaked immediately");

        vm.prank(v1);
        vm.expectRevert(unicode"Cooldown not elapsed / 冷却期未满");
        vs.withdrawUnstaked(v1);

        vm.warp(block.timestamp + 7 days);
        vm.prank(v1);
        assertEq(vs.withdrawUnstaked(v1), MIN_STAKE);
        assertEq(bac.balanceOf(v1), MIN_STAKE);
    }

    /// @dev S4 / revision 38: "stake 8M, register 4 nodes, unstake 6M" must revert.
    function test_requestUnstakeRechecksTheNodeInequality() public {
        _stake(v1, 4 * MIN_STAKE);
        _node(v1, keccak256("n1"));
        _node(v1, keccak256("n2"));
        _node(v1, keccak256("n3"));
        _node(v1, keccak256("n4"));
        assertEq(vs.nodesOf(v1), 4);

        vm.prank(v1);
        vm.expectRevert(unicode"Retire a node first / 请先退掉一个节点");
        vs.requestUnstake(3 * MIN_STAKE);

        vm.prank(v1);
        vs.retireNode(keccak256("n4"));
        vm.prank(v1);
        vs.requestUnstake(MIN_STAKE); // now exactly 3 slots are still backed
        (uint256 staked,,) = vs.stakeOf(v1);
        assertEq(staked, 3 * MIN_STAKE);
    }

    function test_registerNodeNeedsIndependentStakePerSlot() public {
        _stake(v1, MIN_STAKE);
        _node(v1, keccak256("n1"));

        vm.prank(v1);
        vm.expectRevert(unicode"Stake below minimum / 质押低于门槛");
        vs.registerNode(keccak256("n2"), "enode://x@1.1.1.1:30303", v1);

        _stake(v1, MIN_STAKE);
        _node(v1, keccak256("n2"));
        assertEq(vs.nodesOf(v1), 2);
        assertEq(vs.nodeCount(), 2);
    }

    function test_nodeIdCannotBeRegisteredTwice() public {
        _stakeAndRegister(v1, 2 * MIN_STAKE, keccak256("n1"));
        vm.prank(v1);
        vm.expectRevert(unicode"Node already registered / 该节点已注册");
        vs.registerNode(keccak256("n1"), "enode://x@1.1.1.1:30303", v1);
    }

    // ------------------------------------------------------------------
    // commit-reveal
    // ------------------------------------------------------------------

    /// @dev Revision 34: the commit window is a pure clock check. The relayer cannot
    ///      post before it closes either, so a witness always gets the full 2 hours.
    function test_commitWindowIsTimeOnly() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));

        vm.warp((uint256(e0) + 1) * EPOCH + 2 hours);
        vm.prank(v1);
        vm.expectRevert(unicode"Commit window closed / 承诺窗口已结束");
        vs.commitAttestation(e0, keccak256("whatever"));

        // The two windows are exactly complementary: commit requires `<` that instant,
        // postAnchor requires `>=` it. No gap, no overlap, and the length of the commit
        // window is a constant the relayer cannot touch.
        vm.prank(relayer);
        anchor.postAnchor(e0, _emptyAnchor());
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.POSTED));

        // ... and `commitAttestation` looks at nothing but the clock: one second before
        // the deadline it still accepts a commitment, POSTED anchor or not.
        vm.warp((uint256(e0) + 1) * EPOCH + 2 hours - 1);
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2"));
        _commit(v2, e0, root, blockHash, l2Block);
        assertEq(vs.commitmentOf(e0, v2), keccak256(abi.encode(e0, root, blockHash, l2Block, SALT, v2)));
    }

    function _emptyAnchor() internal view returns (IChainAnchor.Anchor memory a) {
        a.l2BlockHash = blockHash;
        a.l2Block = l2Block;
        a.circulating = 1000e18;
    }

    function test_commitRequiresARegisteredNode() public {
        _stake(v1, MIN_STAKE);
        vm.warp(_commitTime(e0));
        vm.prank(v1);
        vm.expectRevert(unicode"Register a node first / 请先注册节点");
        vs.commitAttestation(e0, keccak256("x"));
    }

    function test_revealOutsideTheChallengeWindowReverts() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        vm.warp(_commitTime(e0));
        _commit(v1, e0, root, blockHash, l2Block);
        _postAnchor(e0, root, blockHash, l2Block);

        vm.warp(_postTime(e0) + 24 hours);
        vm.prank(v1);
        vm.expectRevert(unicode"Challenge window closed / 挑战窗口已结束");
        vs.revealAttestation(e0, root, blockHash, l2Block, SALT);
    }

    function test_badRevealCountsForNeitherSideAndStrikes() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        vm.warp(_commitTime(e0));
        _commit(v1, e0, root, blockHash, l2Block);
        _postAnchor(e0, root, blockHash, l2Block);

        vm.warp(_postTime(e0) + 1 hours);
        vm.prank(v1);
        vs.revealAttestation(e0, keccak256("other root"), blockHash, l2Block, SALT);

        (,,, uint32 strikes) = _nodeInfo(keccak256("n1"));
        assertEq(strikes, 1, "a mismatching reveal costs a strike");
        assertEq(vs.revealerCount(e0), 0, "counted on neither side");

        (uint256 aw, uint256 dw, uint32 ac, uint32 dc) = vs.attestationResult(e0, root, blockHash, l2Block);
        assertEq(aw, 0);
        assertEq(dw, 0);
        assertEq(ac, 0);
        assertEq(dc, 0);
    }

    function _nodeInfo(bytes32 id) internal view returns (address validator, address payout, bool active, uint32 s) {
        (validator, payout,, active, s) = vs.nodeOf(id);
    }

    /// @dev S5: one address, four node slots, ONE weight entry, and no cap of any kind.
    function test_weightIsPerAddressAndCountedOnce() public {
        _stake(v1, 4 * MIN_STAKE);
        _node(v1, keccak256("n1"));
        _node(v1, keccak256("n2"));
        _node(v1, keccak256("n3"));
        _node(v1, keccak256("n4"));

        vm.warp(_commitTime(e0));
        _commit(v1, e0, root, blockHash, l2Block);
        _postAnchor(e0, root, blockHash, l2Block);
        vm.warp(_postTime(e0) + 1 hours);
        _reveal(v1, e0, root, blockHash, l2Block);

        (uint256 aw,, uint32 ac,) = vs.attestationResult(e0, root, blockHash, l2Block);
        assertEq(aw, 4 * MIN_STAKE, "purely linear, uncapped (WEIGHT_CAP is deleted)");
        assertEq(ac, 1, "four nodeIdHashes, one address, one count");

        vm.prank(v1);
        vm.expectRevert(unicode"Already revealed / 本纪元已揭示");
        vs.revealAttestation(e0, root, blockHash, l2Block, SALT);
    }

    // ------------------------------------------------------------------
    // dispute-forced DISPUTED epochs (real finalize, real weights)
    // ------------------------------------------------------------------

    function _threeDisputers() internal {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2"));
        _stakeAndRegister(v3, MIN_STAKE, keccak256("n3"));
    }

    function _disputeRound(uint64 epoch, uint64 blk) internal {
        bytes32 honest = keccak256(abi.encode("honest", epoch));
        vm.warp(_commitTime(epoch));
        _commit(v1, epoch, honest, blockHash, blk);
        _commit(v2, epoch, honest, blockHash, blk);
        _commit(v3, epoch, honest, blockHash, blk);

        // the relayer anchors a DIFFERENT root
        _postAnchor(epoch, keccak256(abi.encode("relayer", epoch)), blockHash, blk);

        vm.warp(_postTime(epoch) + 1 hours);
        _reveal(v1, epoch, honest, blockHash, blk);
        _reveal(v2, epoch, honest, blockHash, blk);
        _reveal(v3, epoch, honest, blockHash, blk);

        _finalize(epoch);
    }

    function test_threeHonestWitnessesForceDisputed() public {
        _threeDisputers();
        _disputeRound(e0, 1000);

        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.DISPUTED));
        assertEq(anchor.disputeCountInWindow(), 1);
        assertEq(anchor.cumulativeCredited(), 0, "a DISPUTED epoch settles nothing");
    }

    function test_twoDisputersCannotForceDisputed() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2"));

        bytes32 honest = keccak256("honest");
        vm.warp(_commitTime(e0));
        _commit(v1, e0, honest, blockHash, l2Block);
        _commit(v2, e0, honest, blockHash, l2Block);
        _postAnchor(e0, root, blockHash, l2Block);
        vm.warp(_postTime(e0) + 1 hours);
        _reveal(v1, e0, honest, blockHash, l2Block);
        _reveal(v2, e0, honest, blockHash, l2Block);
        _finalize(e0);

        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.FINAL), "C6");
    }

    function test_threeDisputedEpochsArmHaltReasonThree() public {
        _threeDisputers();
        _disputeRound(e0, 1000);
        _disputeRound(e0 + 1, 1001);
        _disputeRound(e0 + 2, 1002);
        assertEq(anchor.disputeCountInWindow(), 3);
        assertEq(anchor.haltReason(), 3);
    }

    // ------------------------------------------------------------------
    // rewards
    // ------------------------------------------------------------------

    function _agreeingRound(uint64 epoch, uint64 blk, address[] memory who) internal {
        bytes32 r = keccak256(abi.encode("root", epoch));
        vm.warp(_commitTime(epoch));
        for (uint256 i; i < who.length; ++i) {
            _commit(who[i], epoch, r, blockHash, blk);
        }
        _postAnchor(epoch, r, blockHash, blk);
        vm.warp(_postTime(epoch) + 1 hours);
        for (uint256 i; i < who.length; ++i) {
            _reveal(who[i], epoch, r, blockHash, blk);
        }
        _finalize(epoch);
    }

    function _four() internal returns (address[] memory who) {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1")); // 2M -> 20%
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2")); // 2M -> 20%
        _stakeAndRegister(v3, MIN_STAKE, keccak256("n3")); // 2M -> 20%
        _stakeAndRegister(v4, 2 * MIN_STAKE, keccak256("n4")); // 4M -> 40%, capped to 25%
        who = new address[](4);
        who[0] = v1;
        who[1] = v2;
        who[2] = v3;
        who[3] = v4;
    }

    function test_rewardSplitIsLinearAndCappedAt25Percent() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();
        assertEq(vs.rewardBalance(), 100 ether);

        _agreeingRound(e0, 1000, who);
        vs.settleEpochRewards(e0);

        (uint256 pot, uint256 weight, uint256 rate, bool settled) = vs.epochReward(e0);
        assertTrue(settled);
        assertEq(pot, 5 ether, "REWARD_RELEASE_BPS = 500");
        assertEq(weight, 10 * MIN_STAKE / 2, "2M+2M+2M+4M");
        assertGt(rate, 0);

        // linear: 2M of 10M is exactly 20% of the pot
        assertEq(vs.rewardOf(e0, v1), 1 ether);
        assertEq(vs.rewardOf(e0, v2), 1 ether);
        assertEq(vs.rewardOf(e0, v3), 1 ether);
        // 40% of the weight, but MAX_VALIDATOR_SHARE_BPS caps the SPLIT at 25%
        assertEq(vs.rewardOf(e0, v4), 1.25 ether);

        // what the cap shaved off stays in rewardBalance, it never rolls into a pot
        assertEq(vs.rewardBalance(), 100 ether - 4.25 ether);
    }

    function test_claimAndSweepKeepInvariantS2() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();
        _agreeingRound(e0, 1000, who);
        vs.settleEpochRewards(e0);

        uint256 before = v1.balance;
        assertEq(vs.claimReward(e0, v1), 1 ether, "anyone may push the claim");
        assertEq(v1.balance, before + 1 ether);
        assertEq(vs.rewardOf(e0, v1), 0, "claimed once per address per epoch");
        vm.expectRevert(unicode"Nothing to claim / 没有可领取的金额");
        vs.claimReward(e0, v1);

        // S2 before the sweep
        assertEq(
            vs.lifetimeFunded(),
            vs.lifetimePaid() + vs.rewardBalance() + 3.25 ether,
            "funded == paid + balance + unexpired escrow"
        );

        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(unicode"Reward expired / 奖励已过期");
        vs.claimReward(e0, v2);
        assertEq(vs.sweepExpired(e0), 3.25 ether);
        assertEq(vs.lifetimeFunded(), vs.lifetimePaid() + vs.rewardBalance(), "S2 after the sweep");
    }

    function test_settleEpochRewardsMustBeSequential() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();
        _agreeingRound(e0, 1000, who);

        vm.expectRevert(unicode"Settle epochs in order / 纪元必须按序结算");
        vs.settleEpochRewards(e0 + 1);

        vs.settleEpochRewards(e0);
        assertEq(vs.lastRewardEpoch(), e0);

        vm.expectRevert(unicode"Settle epochs in order / 纪元必须按序结算");
        vs.settleEpochRewards(e0);
    }

    /// @dev attack-funds #15: 100 unsettled epochs may not be compounded away in one block.
    function test_cannotDrainRewardBalanceInOneBlock() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();
        _agreeingRound(e0, 1000, who);
        vs.settleEpochRewards(e0);

        // epoch e0+1 was never anchored: it can only be skipped after SETTLE_GRACE
        vm.expectRevert(unicode"Epoch not resolved yet / 该纪元尚未定案");
        vs.settleEpochRewards(e0 + 1);

        uint256 balanceAfterOne = vs.rewardBalance();
        assertGt(balanceAfterOne, 95 ether, "only one 5% slice could be taken");
    }

    function test_skippedEpochsAdvanceTheCursorWithoutAPot() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();

        // e0 is vetoed -> terminal, not FINAL
        _postAnchor(e0, root, blockHash, 1000);
        vm.prank(vetoKey);
        anchor.veto(e0, keccak256("nope"));

        vs.settleEpochRewards(e0);
        (uint256 pot,,, bool settled) = vs.epochReward(e0);
        assertEq(pot, 0, "a VETOED epoch pays nothing");
        assertTrue(settled);
        assertEq(vs.rewardBalance(), 100 ether, "nothing left the balance");

        _agreeingRound(e0 + 1, 1001, who);
        vs.settleEpochRewards(e0 + 1);
        (uint256 pot2,,,) = vs.epochReward(e0 + 1);
        assertEq(pot2, 5 ether);
    }

    function test_nonAgreeingWitnessGetsNothing() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2"));
        vs.fundRewards{value: 100 ether}();

        bytes32 anchored = keccak256("anchored");
        vm.warp(_commitTime(e0));
        _commit(v1, e0, anchored, blockHash, l2Block);
        _commit(v2, e0, keccak256("wrong"), blockHash, l2Block);
        _postAnchor(e0, anchored, blockHash, l2Block);
        vm.warp(_postTime(e0) + 1 hours);
        _reveal(v1, e0, anchored, blockHash, l2Block);
        _reveal(v2, e0, keccak256("wrong"), blockHash, l2Block);
        _finalize(e0);

        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.FINAL));
        vs.settleEpochRewards(e0);
        // v1 is the only agreeing address, so it carries 100% of the weight - and the
        // 25% split cap still applies. The other 75% stays in rewardBalance; it is never
        // rolled into another epoch's pot (that is what makes S2 hold).
        assertEq(vs.rewardOf(e0, v1), 1.25 ether, "MAX_VALIDATOR_SHARE_BPS caps the split");
        assertEq(vs.rewardOf(e0, v2), 0, "a wrong root earns nothing");
        assertEq(vs.rewardBalance(), 100 ether - 1.25 ether);
    }

    function test_releaseBpsFollowsTheWitnessCount() public {
        address[] memory three = new address[](3);
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2"));
        _stakeAndRegister(v3, MIN_STAKE, keccak256("n3"));
        three[0] = v1;
        three[1] = v2;
        three[2] = v3;

        _agreeingRound(e0, 1000, three);
        assertEq(anchor.getAnchor(e0).agreeingCount, 3);
        assertEq(anchor.releaseBpsFor(e0), 500, "3 independent witnesses -> 5%/epoch");
    }

    // ------------------------------------------------------------------
    // removal never touches principal (§7, v1 does not slash)
    // ------------------------------------------------------------------

    function test_removeValidatorCancelsRewardsButNeverTouchesPrincipal() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();
        _agreeingRound(e0, 1000, who);

        vm.prank(admin);
        vs.proposeRemoveValidator(v1, keccak256("reason"));
        vm.prank(admin);
        vm.expectRevert(unicode"Timelock not elapsed / 时锁未到期");
        vs.executeRemoveValidator(v1);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        vs.executeRemoveValidator(v1);
        assertTrue(vs.removed(v1));
        (,, bool active,) = _nodeInfo(keccak256("n1"));
        assertFalse(active, "the node is deactivated");

        vs.settleEpochRewards(e0);
        assertEq(vs.rewardOf(e0, v1), 0, "reward eligibility is cancelled");

        // ... but the stake is still the validator's, on the ordinary cooldown
        assertEq(bac.balanceOf(address(vs)), 5 * MIN_STAKE);
        vm.prank(v1);
        vs.retireNode(keccak256("n1"));
        vm.prank(v1);
        vs.requestUnstake(MIN_STAKE);
        vm.warp(block.timestamp + 7 days);
        vm.prank(v1);
        assertEq(vs.withdrawUnstaked(v1), MIN_STAKE);
        assertEq(bac.balanceOf(v1), MIN_STAKE, "principal returned in full");
    }

    function test_vetoKeyCanCancelARemoval() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        vm.prank(admin);
        vs.proposeRemoveValidator(v1, bytes32(0));
        vm.prank(vetoKey);
        vs.cancelRemoveValidator(v1);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        vm.expectRevert(unicode"No removal queued / 没有待执行的移除");
        vs.executeRemoveValidator(v1);
    }

    /// @dev Removal must NOT reduce witness weight: otherwise admin could soften any
    ///      dispute by removing the disputers, which is exactly the power the spec
    ///      refuses to grant ("it only cancels reward eligibility").
    function test_removalDoesNotTouchWitnessWeight() public {
        _threeDisputers();
        vm.warp(_commitTime(e0));
        bytes32 honest = keccak256("honest");
        _commit(v1, e0, honest, blockHash, l2Block);
        _commit(v2, e0, honest, blockHash, l2Block);
        _commit(v3, e0, honest, blockHash, l2Block);
        _postAnchor(e0, root, blockHash, l2Block);
        vm.warp(_postTime(e0) + 1 hours);
        _reveal(v1, e0, honest, blockHash, l2Block);
        _reveal(v2, e0, honest, blockHash, l2Block);
        _reveal(v3, e0, honest, blockHash, l2Block);

        vm.prank(admin);
        vs.proposeRemoveValidator(v1, bytes32(0));
        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        vs.executeRemoveValidator(v1);

        (, uint256 dw,, uint32 dc) = vs.attestationResult(e0, root, blockHash, l2Block);
        assertEq(dw, 3 * MIN_STAKE, "S5: weight is untouched by removal");
        assertEq(dc, 3);
    }

    receive() external payable {}
}
