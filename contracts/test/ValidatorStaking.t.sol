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

    uint64 internal constant EPOCH = 600; // decision #20
    uint64 internal constant EPOCHS_PER_DAY = 144;
    uint64 internal constant DAY = 86400;
    uint64 internal constant ANCHOR_WAIT = 120; // decision #25
    uint256 internal constant MIN_STAKE = 2_000_000e18;
    bytes32 internal constant SALT = keccak256("salt");

    uint64 internal e0;
    uint64 internal d0;
    bytes32 internal root = keccak256("exitRoot");
    bytes32 internal blockHash = keccak256("l2BlockHash");
    uint64 internal l2Block = 777;

    function setUp() public {
        vm.warp(uint256(200) * DAY); // an epoch boundary that is also a day boundary
        bac = new MockBAC();
        bridge = new MockBridge();
        anchor = new ChainAnchor(address(bridge), relayer, admin, vetoKey, 1000e18);
        vs = new ValidatorStaking(address(bac), address(anchor), admin);
        anchor.setValidatorStaking(address(vs));
        e0 = anchor.firstEpoch();
        d0 = e0 / EPOCHS_PER_DAY;
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

    /// @dev COMMIT_WINDOW is 0: the deadline is the end of the epoch, which is also the
    ///      earliest instant `postAnchor` accepts.
    function _commitTime(uint64 epoch) internal pure returns (uint256) {
        return (uint256(epoch) + 1) * EPOCH - 1;
    }

    function _postTime(uint64 epoch) internal pure returns (uint256) {
        return (uint256(epoch) + 1) * EPOCH;
    }

    function _postAnchor(uint64 epoch, bytes32 r, bytes32 h, uint64 b) internal {
        if (block.timestamp < _postTime(epoch)) vm.warp(_postTime(epoch));
        IChainAnchor.Anchor memory a;
        a.exitRoot = r;
        a.l2BlockHash = h;
        a.l2Block = b;
        a.circulating = 1000e18;
        vm.prank(relayer);
        anchor.postAnchor(epoch, a);
    }

    function _finalize(uint64 epoch) internal {
        vm.warp(uint256(anchor.getAnchor(epoch).postedAt) + ANCHOR_WAIT);
        anchor.finalize(epoch);
    }

    /// @dev Post + finalize every epoch from `lastPostedEpoch + 1` through `target`.
    function _runTo(uint64 target) internal {
        uint64 e = anchor.lastPostedEpoch() + 1;
        for (; e <= target; ++e) {
            _postAnchor(e, keccak256(abi.encode("r", e)), keccak256(abi.encode("h", e)), 1000 + (e - e0));
            _finalize(e);
        }
    }

    /// @dev Anchor and finalize every epoch of `day`, then post one more so the day is
    ///      sealed and `dayHeadOf` can never change again.
    function _sealDay(uint64 day) internal {
        uint64 lastOfDay = (day + 1) * EPOCHS_PER_DAY - 1;
        _runTo(lastOfDay + 1);
    }

    function _attest(address who, uint64 day) internal {
        (bytes32 head,) = anchor.dayHeadOf(day);
        vm.prank(who);
        vs.attestDay(day, head);
    }

    function _nodeInfo(bytes32 id) internal view returns (address validator, address payout, bool active, uint32 s) {
        (validator, payout,, active, s) = vs.nodeOf(id);
    }

    function _emptyAnchor() internal view returns (IChainAnchor.Anchor memory a) {
        a.l2BlockHash = blockHash;
        a.l2Block = l2Block;
        a.circulating = 1000e18;
    }

    /// @dev One live (per-epoch) agreeing round. It credits `epoch`'s DAY for everyone
    ///      who agreed, which is what makes the two cadences pay the same.
    function _agreeingRound(uint64 epoch, uint64 blk, address[] memory who) internal {
        bytes32 r = keccak256(abi.encode("root", epoch));
        vm.warp(_commitTime(epoch));
        for (uint256 i; i < who.length; ++i) {
            _commit(who[i], epoch, r, blockHash, blk);
        }
        _postAnchor(epoch, r, blockHash, blk);
        for (uint256 i; i < who.length; ++i) {
            _reveal(who[i], epoch, r, blockHash, blk);
        }
        _finalize(epoch);
    }

    function _settleDay(uint64 day) internal {
        if (block.timestamp < (uint256(day) + 2) * DAY) vm.warp((uint256(day) + 2) * DAY);
        vs.settleDayRewards(day);
    }

    // ------------------------------------------------------------------
    // the clock mirrors (decisions #20 / #25 / #18)
    // ------------------------------------------------------------------

    function test_clockMirrorsMatchTheAnchor() public view {
        assertEq(vs.EPOCH(), anchor.EPOCH());
        assertEq(vs.EPOCHS_PER_DAY(), anchor.EPOCHS_PER_DAY());
        assertEq(vs.DAY(), anchor.DAY());
        assertEq(vs.COMMIT_WINDOW(), anchor.COMMIT_WINDOW());
        assertEq(vs.ANCHOR_WAIT(), anchor.ANCHOR_WAIT());
        assertEq(vs.ANCHOR_WAIT(), 120);
    }

    /// @dev The constructor refuses to bind to an anchor whose clock differs - that is
    ///      the only thing stopping a half-migrated deployment.
    function test_constructorRejectsAClockMismatch() public {
        BadClockAnchor bad = new BadClockAnchor();
        vm.expectRevert(unicode"Epoch length mismatch / 纪元长度不一致");
        new ValidatorStaking(address(bac), address(bad), admin);
    }

    function test_terminology_noChallengeWindowInTheAbi() public {
        (bool ok,) = address(vs).staticcall(abi.encodeWithSignature("CHALLENGE_WINDOW()"));
        assertFalse(ok, unicode"CHALLENGE_WINDOW 必须已经改名为 ANCHOR_WAIT");
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

    /// @dev Unchanged by decision #20 on purpose: the cooldown is a DURATION and has
    ///      nothing to do with the epoch length.
    function test_unstakeCooldownIsSevenDays() public {
        assertEq(vs.UNSTAKE_COOLDOWN(), 7 days);
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
    // the daily batch: one transaction covers all 144 epochs of a day
    // ------------------------------------------------------------------

    function test_attestDay_coversAWholeDayInOneCall() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _sealDay(d0);

        (bytes32 head, bool sealedDay) = anchor.dayHeadOf(d0);
        assertTrue(sealedDay);

        uint256 gasBefore = gasleft();
        vm.prank(v1);
        vs.attestDay(d0, head);
        uint256 used = gasBefore - gasleft();

        assertEq(vs.dayAttesters(d0), 1);
        assertEq(vs.dayWeightOf(d0, v1), MIN_STAKE);
        assertEq(vs.witnessRoster(), 1);
        // 144 epochs of coverage for one transaction: this is the whole point of the
        // batch (RESULTS-buyback.md §4.1 - per-epoch witnessing costs 5.2x the old line)
        assertLt(used, 200_000, "one batch must stay in the same order as one reveal");
    }

    function test_attestDay_wrongHeadStrikesAndCreditsNothing() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _sealDay(d0);

        vm.prank(v1);
        vs.attestDay(d0, keccak256("a head from a chain I did not run"));

        (,,, uint32 strikes) = _nodeInfo(keccak256("n1"));
        assertEq(strikes, 1, "a wrong head costs a strike");
        assertEq(vs.dayAttesters(d0), 0);
        assertEq(vs.dayWeightOf(d0, v1), 0);

        // and it is one shot: the validator cannot retry with the right head
        (bytes32 head,) = anchor.dayHeadOf(d0);
        vm.prank(v1);
        vm.expectRevert(unicode"Already attested / 本日已见证");
        vs.attestDay(d0, head);
    }

    function test_attestDay_requiresTheDayToBeOverSealedAndInsideTheWindow() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));

        // day not over
        vm.prank(v1);
        vm.expectRevert(unicode"Day not over yet / 本日尚未结束");
        vs.attestDay(d0, keccak256("x"));

        // day over but the relayer has not anchored all of it
        _runTo(e0 + 10);
        vm.warp(uint256(d0 + 1) * DAY);
        vm.prank(v1);
        vm.expectRevert(unicode"Day not anchored yet / 本日尚未锚定完毕");
        vs.attestDay(d0, keccak256("x"));

        // sealed, but the batch shows up a day late
        _sealDay(d0);
        (bytes32 head,) = anchor.dayHeadOf(d0);
        vm.warp(uint256(d0 + 1) * DAY + vs.ATTEST_WINDOW());
        vm.prank(v1);
        vm.expectRevert(unicode"Attest window closed / 见证窗口已结束");
        vs.attestDay(d0, head);
    }

    function test_attestDay_requiresARegisteredNode() public {
        _stake(v1, MIN_STAKE); // staked, but never registered a node
        _sealDay(d0);
        (bytes32 head,) = anchor.dayHeadOf(d0);
        vm.prank(v1);
        vm.expectRevert(unicode"Register a node first / 请先注册节点");
        vs.attestDay(d0, head);
    }

    /// @dev The head is reproducible from the anchors alone, which is exactly what lets
    ///      a node operator compute it without trusting anybody - and, stated honestly,
    ///      also what stops a batch from proving the operator ran a node at all.
    function test_attestDay_headIsTheChainOfThatDaysFinalAnchors() public {
        _sealDay(d0);
        bytes32 h;
        for (uint64 e = e0; e < (d0 + 1) * EPOCHS_PER_DAY; ++e) {
            IChainAnchor.Anchor memory a = anchor.getAnchor(e);
            if (a.state != IChainAnchor.State.FINAL) continue;
            h = keccak256(abi.encode(h, e, a.exitRoot, a.l2BlockHash, a.l2Block));
        }
        (bytes32 head,) = anchor.dayHeadOf(d0);
        assertEq(head, h, "recomputable off chain from the anchors alone");
    }

    // ------------------------------------------------------------------
    // the live per-epoch path (commit / reveal), still intact
    // ------------------------------------------------------------------

    /// @dev Revision 34: the commit deadline is a pure clock check, so the relayer can
    ///      never squeeze it. With COMMIT_WINDOW = 0 the deadline is the end of the
    ///      epoch, which is the EARLIEST instant `postAnchor` will accept - so an
    ///      accepted commitment provably predates any anchor for that epoch.
    function test_commitDeadlineIsTheEarliestPossiblePost() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));

        vm.warp(_commitTime(e0)); // one second before the epoch ends
        _commit(v1, e0, root, blockHash, l2Block);
        assertEq(vs.commitmentOf(e0, v1), keccak256(abi.encode(e0, root, blockHash, l2Block, SALT, v1)));

        vm.warp(_postTime(e0)); // the instant the epoch ends
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2"));
        vm.prank(v2);
        vm.expectRevert(unicode"Commit window closed / 承诺窗口已结束");
        vs.commitAttestation(e0, keccak256("too late"));

        // the two windows are exactly complementary: commit requires `<` that instant,
        // postAnchor requires `>=` it. No gap, no overlap.
        vm.prank(relayer);
        anchor.postAnchor(e0, _emptyAnchor());
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.POSTED));
    }

    function test_commitRequiresARegisteredNode() public {
        _stake(v1, MIN_STAKE);
        vm.warp(_commitTime(e0));
        vm.prank(v1);
        vm.expectRevert(unicode"Register a node first / 请先注册节点");
        vs.commitAttestation(e0, keccak256("x"));
    }

    function test_revealOutsideTheAnchorWaitReverts() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        vm.warp(_commitTime(e0));
        _commit(v1, e0, root, blockHash, l2Block);
        _postAnchor(e0, root, blockHash, l2Block);

        vm.warp(uint256(anchor.getAnchor(e0).postedAt) + ANCHOR_WAIT);
        vm.prank(v1);
        vm.expectRevert(unicode"Anchor wait is over / 锚点等待已结束");
        vs.revealAttestation(e0, root, blockHash, l2Block, SALT);
    }

    function test_badRevealCountsForNeitherSideAndStrikes() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        vm.warp(_commitTime(e0));
        _commit(v1, e0, root, blockHash, l2Block);
        _postAnchor(e0, root, blockHash, l2Block);

        vm.prank(v1);
        vs.revealAttestation(e0, keccak256("other root"), blockHash, l2Block, SALT);

        (,,, uint32 strikes) = _nodeInfo(keccak256("n1"));
        assertEq(strikes, 1, "a mismatching reveal costs a strike");
        assertEq(vs.revealerCount(e0), 0, "counted on neither side");
        assertEq(vs.dayAttesters(d0), 0, "and credits no day");

        (uint256 aw, uint256 dw, uint32 ac, uint32 dc) = vs.attestationResult(e0, root, blockHash, l2Block);
        assertEq(aw, 0);
        assertEq(dw, 0);
        assertEq(ac, 0);
        assertEq(dc, 0);
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
        _reveal(v1, e0, root, blockHash, l2Block);

        (uint256 aw,, uint32 ac,) = vs.attestationResult(e0, root, blockHash, l2Block);
        assertEq(aw, 4 * MIN_STAKE, "purely linear, uncapped (WEIGHT_CAP is deleted)");
        assertEq(ac, 1, "four nodeIdHashes, one address, one count");

        vm.prank(v1);
        vm.expectRevert(unicode"Already revealed / 本纪元已揭示");
        vs.revealAttestation(e0, root, blockHash, l2Block, SALT);
    }

    // ------------------------------------------------------------------
    // disputes: still reachable at COMMIT_WINDOW = 0
    // ------------------------------------------------------------------

    function _threeDisputers() internal {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2"));
        _stakeAndRegister(v3, MIN_STAKE, keccak256("n3"));
    }

    /// @dev The direct path. `disputeAnchor` takes no prior commitment because at
    ///      COMMIT_WINDOW = 0 a blind commitment for epoch N can only be filed before N
    ///      is over - before its triple exists. Requiring one would have made DISPUTED
    ///      unreachable, which is the one safety property that must survive decision #25.
    function test_disputeAnchor_threeAddressesForceDisputed() public {
        _threeDisputers();
        _postAnchor(e0, root, blockHash, l2Block);

        bytes32 honest = keccak256("honest");
        vm.prank(v1);
        vs.disputeAnchor(e0, honest, blockHash, l2Block);
        vm.prank(v2);
        vs.disputeAnchor(e0, honest, blockHash, l2Block);
        vm.prank(v3);
        vs.disputeAnchor(e0, honest, blockHash, l2Block);

        (uint256 aw, uint256 dw,, uint32 dc) = vs.attestationResult(e0, root, blockHash, l2Block);
        assertEq(aw, 0);
        assertEq(dw, 3 * MIN_STAKE);
        assertEq(dc, 3);

        _finalize(e0);
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.DISPUTED));
        assertEq(anchor.disputeCountInWindow(), 1);
        assertEq(anchor.cumulativeCredited(), 0, "a DISPUTED epoch settles nothing");
    }

    function test_disputeAnchor_isNotAFreeAgreeingVote() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _postAnchor(e0, root, blockHash, l2Block);

        vm.prank(v1);
        vm.expectRevert(unicode"Not a dispute / 与锚点一致，不构成异议");
        vs.disputeAnchor(e0, root, blockHash, l2Block);

        // and it never pays: disputing credits no day
        vm.prank(v1);
        vs.disputeAnchor(e0, keccak256("other"), blockHash, l2Block);
        assertEq(vs.dayAttesters(d0), 0, "disputing is not witnessing and is never paid");
    }

    function test_disputeAnchor_onlyInsideTheAnchorWaitAndOncePerEpoch() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _postAnchor(e0, root, blockHash, l2Block);

        vm.prank(v1);
        vs.disputeAnchor(e0, keccak256("other"), blockHash, l2Block);
        vm.prank(v1);
        vm.expectRevert(unicode"Already revealed / 本纪元已揭示");
        vs.disputeAnchor(e0, keccak256("other2"), blockHash, l2Block);

        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2"));
        vm.warp(uint256(anchor.getAnchor(e0).postedAt) + ANCHOR_WAIT);
        vm.prank(v2);
        vm.expectRevert(unicode"Anchor wait is over / 锚点等待已结束");
        vs.disputeAnchor(e0, keccak256("other"), blockHash, l2Block);
    }

    function test_twoDisputersCannotForceDisputed() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2"));
        _postAnchor(e0, root, blockHash, l2Block);

        bytes32 honest = keccak256("honest");
        vm.prank(v1);
        vs.disputeAnchor(e0, honest, blockHash, l2Block);
        vm.prank(v2);
        vs.disputeAnchor(e0, honest, blockHash, l2Block);
        _finalize(e0);

        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.FINAL), "C6");
    }

    /// @dev The commit-reveal route to a dispute still works too, when a witness had a
    ///      commitment in before the epoch closed.
    function test_commitRevealCanStillForceDisputed() public {
        _threeDisputers();
        bytes32 honest = keccak256("honest");
        vm.warp(_commitTime(e0));
        _commit(v1, e0, honest, blockHash, l2Block);
        _commit(v2, e0, honest, blockHash, l2Block);
        _commit(v3, e0, honest, blockHash, l2Block);

        _postAnchor(e0, root, blockHash, l2Block);
        _reveal(v1, e0, honest, blockHash, l2Block);
        _reveal(v2, e0, honest, blockHash, l2Block);
        _reveal(v3, e0, honest, blockHash, l2Block);
        _finalize(e0);

        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.DISPUTED));
    }

    function test_threeDisputedEpochsArmHaltReasonThree() public {
        _threeDisputers();
        for (uint64 i; i < 3; ++i) {
            uint64 e = e0 + i;
            _postAnchor(e, keccak256(abi.encode("relayer", e)), blockHash, 1000 + i);
            bytes32 honest = keccak256(abi.encode("honest", e));
            vm.prank(v1);
            vs.disputeAnchor(e, honest, blockHash, 1000 + i);
            vm.prank(v2);
            vs.disputeAnchor(e, honest, blockHash, 1000 + i);
            vm.prank(v3);
            vs.disputeAnchor(e, honest, blockHash, 1000 + i);
            _finalize(e);
            assertEq(uint8(anchor.getAnchor(e).state), uint8(IChainAnchor.State.DISPUTED));
        }
        assertEq(anchor.disputeCountInWindow(), 3);
        assertEq(anchor.haltReason(), 3);
    }

    // ------------------------------------------------------------------
    // the rolling roster drives the release tier
    // ------------------------------------------------------------------

    function test_witnessRoster_drivesReleaseBpsNotThisEpochsCount() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2"));
        _stakeAndRegister(v3, MIN_STAKE, keccak256("n3"));

        assertEq(vs.witnessRoster(), 0);
        assertEq(anchor.releaseBpsFor(e0), 200, "no roster, lowest tier");

        _sealDay(d0);
        _attest(v1, d0);
        assertEq(vs.witnessRoster(), 1);
        assertEq(anchor.releaseBpsFor(e0), 350);
        _attest(v2, d0);
        _attest(v3, d0);
        assertEq(vs.witnessRoster(), 3);

        // the tier applies to epochs being settled RIGHT NOW, including epochs of the
        // day that has only just started - which is the whole point of a rolling roster
        uint64 nowEpoch = uint64(block.timestamp / EPOCH);
        assertEq(anchor.releaseBpsFor(nowEpoch), 500, "5%/day, not 5%/epoch");
        assertEq(anchor.getAnchor(e0).agreeingCount, 0, "nobody revealed live for e0");
    }

    function test_witnessRoster_spansTheRollingDayBoundary() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1"));
        _sealDay(d0);
        _attest(v1, d0);
        assertEq(vs.witnessRoster(), 1);

        // still on the roster a day later ...
        vm.warp(uint256(d0 + 2) * DAY);
        assertEq(vs.witnessRoster(), 1);
        // ... and off it once the node has been quiet for three days
        vm.warp(uint256(d0 + 3) * DAY);
        assertEq(vs.witnessRoster(), 0, "a node that stopped attesting leaves the roster");
        assertEq(anchor.releaseBpsFor(e0), 200);
    }

    // ------------------------------------------------------------------
    // rewards: one pot per DAY
    // ------------------------------------------------------------------

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
        _settleDay(d0);

        (uint256 pot, uint256 weight, uint256 rate, bool settled) = vs.dayReward(d0);
        assertTrue(settled);
        assertEq(pot, 5 ether, "REWARD_RELEASE_BPS = 500, per DAY");
        assertEq(weight, 5 * MIN_STAKE, "2M+2M+2M+4M");
        assertGt(rate, 0);

        // linear: 2M of 10M is exactly 20% of the pot
        assertEq(vs.rewardOf(d0, v1), 1 ether);
        assertEq(vs.rewardOf(d0, v2), 1 ether);
        assertEq(vs.rewardOf(d0, v3), 1 ether);
        // 40% of the weight, but MAX_VALIDATOR_SHARE_BPS caps the SPLIT at 25%
        assertEq(vs.rewardOf(d0, v4), 1.25 ether);

        // what the cap shaved off stays in rewardBalance, it never rolls into a pot
        assertEq(vs.rewardBalance(), 100 ether - 4.25 ether);
        // the explorer's epoch-shaped question still answers
        (uint256 pot2,,,) = vs.epochReward(e0);
        assertEq(pot2, pot);
    }

    /// @dev The release rate is 5% of the reward balance a DAY, not per epoch. Per epoch
    ///      it would be 720% a day and the pot would be gone before lunch.
    function test_rewardReleaseIsPerDayNotPerEpoch() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();

        _agreeingRound(e0, 1000, who);
        _agreeingRound(e0 + 1, 1001, who);
        _agreeingRound(e0 + 2, 1002, who);
        // three epochs attested inside one day - still exactly one pot
        _settleDay(d0);
        (uint256 pot,,,) = vs.dayReward(d0);
        assertEq(pot, 5 ether, "one day, one 5% slice");
        assertEq(vs.rewardBalance(), 100 ether - 4.25 ether);
    }

    function test_claimAndSweepKeepInvariantS2() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();
        _agreeingRound(e0, 1000, who);
        _settleDay(d0);

        uint256 before = v1.balance;
        assertEq(vs.claimReward(d0, v1), 1 ether, "anyone may push the claim");
        assertEq(v1.balance, before + 1 ether);
        assertEq(vs.rewardOf(d0, v1), 0, "claimed once per address per day");
        vm.expectRevert(unicode"Nothing to claim / 没有可领取的金额");
        vs.claimReward(d0, v1);

        // S2 before the sweep
        assertEq(
            vs.lifetimeFunded(),
            vs.lifetimePaid() + vs.rewardBalance() + 3.25 ether,
            "funded == paid + balance + unexpired escrow"
        );

        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(unicode"Reward expired / 奖励已过期");
        vs.claimReward(d0, v2);
        assertEq(vs.sweepExpired(d0), 3.25 ether);
        assertEq(vs.lifetimeFunded(), vs.lifetimePaid() + vs.rewardBalance(), "S2 after the sweep");
    }

    function test_settleDayRewardsMustBeSequential() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();
        _agreeingRound(e0, 1000, who);

        vm.warp(uint256(d0 + 3) * DAY);
        vm.expectRevert(unicode"Settle days in order / 天数必须按序结算");
        vs.settleDayRewards(d0 + 1);

        vs.settleDayRewards(d0);
        assertEq(vs.lastRewardDay(), d0);

        vm.expectRevert(unicode"Settle days in order / 天数必须按序结算");
        vs.settleDayRewards(d0);
    }

    function test_settleDayRewardsWaitsForTheAttestWindow() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();
        _agreeingRound(e0, 1000, who);

        vm.warp(uint256(d0 + 2) * DAY - 1);
        vm.expectRevert(unicode"Attest window still open / 见证窗口尚未结束");
        vs.settleDayRewards(d0);

        vm.warp(uint256(d0 + 2) * DAY);
        vs.settleDayRewards(d0);
        assertEq(vs.lastRewardDay(), d0);
    }

    /// @dev attack-funds #15: a backlog of unsettled periods may not be compounded away
    ///      in one block. The gate is now time, and it is one call a day, not 144.
    function test_cannotDrainRewardBalanceInOneBlock() public {
        address[] memory who = _four();
        vs.fundRewards{value: 100 ether}();
        _agreeingRound(e0, 1000, who);
        _settleDay(d0);

        vm.expectRevert(unicode"Attest window still open / 见证窗口尚未结束");
        vs.settleDayRewards(d0 + 1);

        assertGt(vs.rewardBalance(), 95 ether, "only one 5% slice could be taken");
    }

    function test_aDayNobodyAttestedPaysNothingAndKeepsThePot() public {
        _four();
        vs.fundRewards{value: 100 ether}();

        _settleDay(d0);
        (uint256 pot,,, bool settled) = vs.dayReward(d0);
        assertEq(pot, 0, "no witnesses, no pot leaves the balance");
        assertTrue(settled);
        assertEq(vs.rewardBalance(), 100 ether, "nothing left the balance");
        assertEq(vs.lastRewardDay(), d0, "the cursor still advances");
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
        _reveal(v1, e0, anchored, blockHash, l2Block);
        _reveal(v2, e0, keccak256("wrong"), blockHash, l2Block);
        _finalize(e0);

        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.FINAL));
        _settleDay(d0);
        // v1 is the only agreeing address, so it carries 100% of the weight - and the
        // 25% split cap still applies. The other 75% stays in rewardBalance; it is never
        // rolled into another day's pot (that is what makes S2 hold).
        assertEq(vs.rewardOf(d0, v1), 1.25 ether, "MAX_VALIDATOR_SHARE_BPS caps the split");
        assertEq(vs.rewardOf(d0, v2), 0, "a wrong root earns nothing");
        assertEq(vs.rewardBalance(), 100 ether - 1.25 ether);
    }

    // ------------------------------------------------------------------
    // the cadence promise: follow it and you are fully paid; exceed it and you are not
    // penalised (decision #20a)
    // ------------------------------------------------------------------

    function test_attestingMoreOftenIsNeitherRewardedNorPenalised() public {
        _stakeAndRegister(v1, MIN_STAKE, keccak256("n1")); // the eager one
        _stakeAndRegister(v2, MIN_STAKE, keccak256("n2")); // once a day, as designed
        vs.fundRewards{value: 100 ether}();

        // v1 also runs the old per-epoch cadence for the first three epochs of the day
        address[] memory eager = new address[](1);
        eager[0] = v1;
        _agreeingRound(e0, 1000, eager);
        _agreeingRound(e0 + 1, 1001, eager);
        _agreeingRound(e0 + 2, 1002, eager);
        assertEq(vs.dayAttesters(d0), 1, "three live reveals are still one day credit");

        _sealDay(d0);
        _attest(v1, d0); // and the batch on top: accepted, no strike, no extra credit
        _attest(v2, d0);
        assertEq(vs.dayAttesters(d0), 2);

        (,,, uint32 strikes) = _nodeInfo(keccak256("n1"));
        assertEq(strikes, 0, "attesting more often is not a strike");

        _settleDay(d0);
        assertEq(vs.rewardOf(d0, v1), vs.rewardOf(d0, v2), "same stake, same pay");
        // half the weight each would be 2.5 ether, but MAX_VALIDATOR_SHARE_BPS caps a
        // single address at 25% of the pot; the rest stays in rewardBalance (S2)
        assertEq(vs.rewardOf(d0, v1), 1.25 ether, "capped at 25% of a 5 ether pot");
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

        _settleDay(d0);
        assertEq(vs.rewardOf(d0, v1), 0, "reward eligibility is cancelled");

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
        _postAnchor(e0, root, blockHash, l2Block);
        bytes32 honest = keccak256("honest");
        vm.prank(v1);
        vs.disputeAnchor(e0, honest, blockHash, l2Block);
        vm.prank(v2);
        vs.disputeAnchor(e0, honest, blockHash, l2Block);
        vm.prank(v3);
        vs.disputeAnchor(e0, honest, blockHash, l2Block);

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

/// @dev An anchor whose clock does not match the staking contract's mirrors.
contract BadClockAnchor {
    function EPOCH() external pure returns (uint64) {
        return 86400;
    }

    function EPOCHS_PER_DAY() external pure returns (uint64) {
        return 1;
    }

    function DAY() external pure returns (uint64) {
        return 86400;
    }

    function COMMIT_WINDOW() external pure returns (uint64) {
        return 2 hours;
    }

    function ANCHOR_WAIT() external pure returns (uint64) {
        return 24 hours;
    }

    function firstEpoch() external pure returns (uint64) {
        return 1;
    }
}
