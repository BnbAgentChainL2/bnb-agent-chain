// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BacBridge} from "../src/BacBridge.sol";
import {BacNodeFund} from "../src/BacNodeFund.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";
import {IChainAnchor} from "../src/interfaces/IChainAnchor.sol";

// ============================================================================
//                                  MOCKS
// ============================================================================

/// @dev Minimal ERC20 stand-in for BAC. Returns bool like FlapTaxTokenV3 does.
contract MockBAC {
    string public constant name = "BNB Agent Chain";
    string public constant symbol = "BAC";
    uint8 public constant decimals = 18;

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

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Minimal `AgentRegistry` stand-in: only `isActive` and `getAgent` are ever called.
contract MockRegistry {
    mapping(uint256 => IAgentRegistry.Agent) private agents;

    function setAgent(uint256 agentId, address controller, address wallet, IAgentRegistry.Status status) external {
        IAgentRegistry.Agent storage a = agents[agentId];
        a.controller = controller;
        a.agentWallet = wallet;
        a.status = status;
    }

    function setStatus(uint256 agentId, IAgentRegistry.Status status) external {
        agents[agentId].status = status;
    }

    function isActive(uint256 agentId) external view returns (bool) {
        return agents[agentId].status == IAgentRegistry.Status.ACTIVE;
    }

    function getAgent(uint256 agentId) external view returns (IAgentRegistry.Agent memory) {
        return agents[agentId];
    }
}

/// @dev Minimal `ChainAnchor` stand-in. `releaseBpsFor` reproduces §6.3: 0 → 200, 1-2 → 350, ≥3 → 500.
contract MockAnchor {
    mapping(uint64 => IChainAnchor.Anchor) private anchors;

    address public vetoKey;
    uint8 public haltReason;
    uint64 public lastFinalAt;

    constructor(address vetoKey_) {
        vetoKey = vetoKey_;
        lastFinalAt = uint64(block.timestamp);
    }

    function setAnchor(uint64 epoch, bytes32 root, uint32 agreeingCount, IChainAnchor.State state) external {
        IChainAnchor.Anchor storage a = anchors[epoch];
        a.exitRoot = root;
        a.agreeingCount = agreeingCount;
        a.state = state;
        if (state == IChainAnchor.State.FINAL) lastFinalAt = uint64(block.timestamp);
    }

    function setHaltReason(uint8 r) external {
        haltReason = r;
    }

    function getAnchor(uint64 epoch) external view returns (IChainAnchor.Anchor memory) {
        return anchors[epoch];
    }

    function releaseBpsFor(uint64 epoch) external view returns (uint16) {
        uint32 n = anchors[epoch].agreeingCount;
        if (n == 0) return 200;
        if (n < 3) return 350;
        return 500;
    }
}

// ============================================================================
//                                 FIXTURE
// ============================================================================

contract BacBridgeTestBase is Test {
    BacBridge internal bridge;
    MockBAC internal bac;
    MockRegistry internal registry;
    MockAnchor internal anchor;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal watchdog = makeAddr("watchdog");
    address internal vetoKey = makeAddr("vetoKey");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint64 internal constant T0 = 1_800_000_000; // a realistic wall clock, epoch 20833

    function setUp() public virtual {
        vm.warp(T0);
        bac = new MockBAC();
        registry = new MockRegistry();
        anchor = new MockAnchor(vetoKey);
        bridge = new BacBridge(address(bac), address(registry), address(anchor), watchdog);

        registry.setAgent(1, alice, makeAddr("aliceWallet"), IAgentRegistry.Status.ACTIVE);
        registry.setAgent(2, bob, makeAddr("bobWallet"), IAgentRegistry.Status.ACTIVE);
        registry.setAgent(3, carol, makeAddr("carolWallet"), IAgentRegistry.Status.ACTIVE);
    }

    // ---- helpers ----

    function _lock(address who, uint256 agentId, uint256 amount) internal {
        bac.mint(who, amount);
        vm.startPrank(who);
        bac.approve(address(bridge), amount);
        bridge.lock(agentId, amount);
        vm.stopPrank();
    }

    function _leaf(uint256 exitId, uint256 agentId, address to, uint256 credits) internal view returns (bytes32) {
        return keccak256(
            abi.encode(bridge.EXIT_TYPEHASH(), exitId, agentId, to, credits, bridge.LAYER_CHAIN_ID(), address(bridge))
        );
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Single-leaf tree: the root IS the leaf and the proof is empty.
    function _postSingle(uint64 epoch, bytes32 leaf, uint32 agreeing) internal {
        anchor.setAnchor(epoch, leaf, agreeing, IChainAnchor.State.FINAL);
    }

    function _claim(uint64 epoch, uint256 exitId, uint256 agentId, address to, uint256 credits)
        internal
        returns (uint256)
    {
        bytes32[] memory proof = new bytes32[](0);
        return bridge.claimExit(epoch, exitId, agentId, to, credits, proof);
    }

    function _curEpoch() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp() / 86400);
    }

    /// @dev Settle the next epoch as FINAL with `agreeing` witnesses.
    function _settleNext(uint32 agreeing) internal returns (uint256 pot) {
        uint64 e = bridge.lastSettledEpoch() + 1;
        anchor.setAnchor(e, bytes32(uint256(1)), agreeing, IChainAnchor.State.FINAL);
        bridge.settleEpoch(e);
        (pot,,) = bridge.lastEpochRelease();
    }

    function _warpEpochs(uint64 n) internal {
        vm.warp(vm.getBlockTimestamp() + uint256(n) * 86400);
    }
}

// ============================================================================
//                               ENTRY SIDE
// ============================================================================

contract BacBridgeEntryTest is BacBridgeTestBase {
    function test_LockMintsCreditsOneToOne() public {
        _lock(alice, 1, 100e18);
        assertEq(bridge.totalLocked(), 100e18);
        assertEq(bridge.totalCreditsIssued(), 100e18);
        assertEq(bridge.credited(1), 100e18);
        assertEq(bridge.creditsOutstanding(), 100e18);
        assertEq(bac.balanceOf(address(bridge)), 100e18);
    }

    function test_LockRejectsInactiveAgent() public {
        registry.setStatus(1, IAgentRegistry.Status.BANNED);
        bac.mint(alice, 1e18);
        vm.startPrank(alice);
        bac.approve(address(bridge), 1e18);
        vm.expectRevert(unicode"Agent is not active / agent 不是活跃状态");
        bridge.lock(1, 1e18);
        vm.stopPrank();
    }

    function test_LockRejectsStranger() public {
        bac.mint(bob, 1e18);
        vm.startPrank(bob);
        bac.approve(address(bridge), 1e18);
        vm.expectRevert(unicode"Not the agent controller / 不是该 agent 的控制者");
        bridge.lock(1, 1e18); // agent 1 belongs to alice
        vm.stopPrank();
    }

    function test_AgentWalletMayAlsoLock() public {
        address wallet = makeAddr("aliceWallet");
        bac.mint(wallet, 5e18);
        vm.startPrank(wallet);
        bac.approve(address(bridge), 5e18);
        bridge.lock(1, 5e18);
        vm.stopPrank();
        assertEq(bridge.credited(1), 5e18);
    }

    function test_BurnLockedOnlyReachesDeadAddress() public {
        _lock(alice, 1, 100e18);
        uint256 burned = bridge.burnLocked();
        assertEq(burned, 100e18);
        assertEq(bac.balanceOf(DEAD), 100e18);
        assertEq(bac.balanceOf(address(bridge)), 0);
        assertEq(bridge.totalBurned(), 100e18);
        // B6 after a burn: balance == totalLocked - burned
        assertEq(bac.balanceOf(address(bridge)), bridge.totalLocked() - bridge.totalBurned());
    }

    function test_AcceptReleaseAndSweepUntracked() public {
        vm.deal(address(this), 10 ether);
        bridge.acceptRelease{value: 4 ether}();
        assertEq(bridge.poolBalance(), 4 ether);

        // simulate a force-pushed balance (selfdestruct / coinbase)
        vm.deal(address(bridge), address(bridge).balance + 1 ether);
        assertEq(bridge.poolBalance(), 4 ether);
        uint256 swept = bridge.sweepUntracked();
        assertEq(swept, 1 ether);
        assertEq(bridge.poolBalance(), 5 ether);
        assertEq(bridge.sweepUntracked(), 0);
    }

    function test_PlainSendReverts() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(bridge).call{value: 1 ether}("");
        assertFalse(ok, "bridge must have no receive()");
    }
}

// ============================================================================
//                           EXIT SIDE / THE MONEY
// ============================================================================

contract BacBridgeExitTest is BacBridgeTestBase {
    function setUp() public override {
        super.setUp();
        _lock(alice, 1, 1000e18);
        vm.deal(address(this), 1000 ether);
        bridge.acceptRelease{value: 10 ether}();
    }

    /// B10: two different-sized exits in the SAME epoch get an identical lockedWei/credits ratio.
    function test_B10_SameEpochDifferentSizesShareOneRate() public {
        bytes32 leafA = _leaf(1, 1, alice, 100e18);
        bytes32 leafB = _leaf(2, 1, bob, 300e18);
        anchor.setAnchor(_curEpoch(), _hashPair(leafA, leafB), 3, IChainAnchor.State.FINAL);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = leafA;

        uint256 lockedA = bridge.claimExit(_curEpoch(), 1, 1, alice, 100e18, proofA);
        uint256 lockedB = bridge.claimExit(_curEpoch(), 2, 1, bob, 300e18, proofB);

        assertGt(lockedA, 0);
        assertGt(lockedB, 0);
        // identical per-credit rate, exact cross-multiplication
        assertEq(lockedA * 300e18, lockedB * 100e18, "B10: first-mover advantage");
        assertEq(lockedA, 1 ether);
        assertEq(lockedB, 3 ether);
        assertEq(bridge.owedTotal(), 4 ether);
        assertLe(bridge.owedTotal(), bridge.poolBalance(), "B1");
    }

    /// B10, awkward numbers: the per-credit rate may differ only by integer-division dust.
    function testFuzz_B10_RateIsSizeIndependent(uint256 cA, uint256 cB) public {
        cA = bound(cA, 1e15, 400e18);
        cB = bound(cB, 1e15, 400e18);
        bytes32 leafA = _leaf(1, 1, alice, cA);
        bytes32 leafB = _leaf(2, 1, bob, cB);
        anchor.setAnchor(_curEpoch(), _hashPair(leafA, leafB), 3, IChainAnchor.State.FINAL);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = leafA;

        uint256 lockedA = bridge.claimExit(_curEpoch(), 1, 1, alice, cA, proofA);
        uint256 lockedB = bridge.claimExit(_curEpoch(), 2, 1, bob, cB, proofB);

        uint256 rateA = (lockedA * 1e18) / cA;
        uint256 rateB = (lockedB * 1e18) / cB;
        uint256 diff = rateA > rateB ? rateA - rateB : rateB - rateA;
        assertLe(diff, 1e6, "B10: per-credit rate drifted beyond rounding dust");
    }

    function test_ClaimExitLocksRateAndBurnsCredits() public {
        bytes32 leaf = _leaf(7, 1, alice, 200e18);
        _postSingle(_curEpoch(), leaf, 3);
        uint256 locked = _claim(_curEpoch(), 7, 1, alice, 200e18);
        assertEq(locked, 2 ether); // 200/1000 of 10 BNB
        assertEq(bridge.owed(alice), 2 ether);
        assertEq(bridge.totalCreditsExited(), 200e18);
        assertEq(bridge.exitedCredits(1), 200e18);
        assertEq(bridge.unattributedExited(), 0);
        assertEq(bridge.creditsOutstanding(), 800e18);
    }

    function test_ExitIdCannotBeClaimedTwice() public {
        bytes32 leaf = _leaf(7, 1, alice, 200e18);
        _postSingle(_curEpoch(), leaf, 3);
        _claim(_curEpoch(), 7, 1, alice, 200e18);
        vm.expectRevert(unicode"Exit already claimed / 该退出已领取");
        _claim(_curEpoch(), 7, 1, alice, 200e18);
    }

    function test_ClaimExitRejectsNonFinalAnchor() public {
        bytes32 leaf = _leaf(7, 1, alice, 200e18);
        anchor.setAnchor(_curEpoch(), leaf, 3, IChainAnchor.State.POSTED);
        vm.expectRevert(unicode"Anchor not final / 锚点尚未定案");
        _claim(_curEpoch(), 7, 1, alice, 200e18);
    }

    function test_ClaimExitRejectsBadProof() public {
        _postSingle(_curEpoch(), _leaf(7, 1, alice, 200e18), 3);
        vm.expectRevert(unicode"Bad merkle proof / merkle 证明无效");
        _claim(_curEpoch(), 7, 1, alice, 201e18); // credits tampered
    }

    function test_ClaimExitRejectsZeroRate() public {
        BacBridge dry = new BacBridge(address(bac), address(registry), address(anchor), watchdog);
        bac.mint(alice, 10e18);
        vm.startPrank(alice);
        bac.approve(address(dry), 10e18);
        dry.lock(1, 10e18);
        vm.stopPrank();

        bytes32 leaf = keccak256(
            abi.encode(
                dry.EXIT_TYPEHASH(), uint256(1), uint256(1), alice, uint256(1e18), dry.LAYER_CHAIN_ID(), address(dry)
            )
        );
        anchor.setAnchor(_curEpoch(), leaf, 3, IChainAnchor.State.FINAL);
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(
            unicode"Rate too low, exit not worth claiming / 当前兑付率过低，本次退出不值得领取"
        );
        dry.claimExit(_curEpoch(), 1, 1, alice, 1e18, proof);
    }

    /// G11: a banned agent still gets out. `claimExit` never reads the registry at all.
    function test_BannedAgentCanStillExit() public {
        registry.setStatus(1, IAgentRegistry.Status.BANNED);
        bytes32 leaf = _leaf(7, 1, alice, 200e18);
        _postSingle(_curEpoch(), leaf, 3);
        uint256 locked = _claim(_curEpoch(), 7, 1, alice, 200e18);
        assertEq(locked, 2 ether);

        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        uint256 paid = bridge.collect(alice);
        assertGt(paid, 0, "a banned agent must still be able to collect");
    }

    function test_DormantAgentCanStillExit() public {
        registry.setStatus(1, IAgentRegistry.Status.DORMANT);
        bytes32 leaf = _leaf(8, 1, alice, 100e18);
        _postSingle(_curEpoch(), leaf, 3);
        assertGt(_claim(_curEpoch(), 8, 1, alice, 100e18), 0);
    }

    /// Anyone may submit someone else's exit; `to` is in the leaf and cannot be changed.
    function test_ThirdPartyMaySubmitExit() public {
        bytes32 leaf = _leaf(9, 1, alice, 100e18);
        _postSingle(_curEpoch(), leaf, 3);
        vm.prank(carol);
        _claim(_curEpoch(), 9, 1, alice, 100e18);
        assertEq(bridge.owed(alice), 1 ether);
        assertEq(bridge.owed(carol), 0);
    }

    /// Attribution is truncated at what the agent actually locked; the rest is global.
    function test_OverEarningAgentTruncatesAttribution() public {
        _lock(bob, 2, 100e18); // agent 2 credited 100
        // agent 2 exits 300 credits (it earned more inside the layer than it deposited)
        bytes32 leaf = _leaf(11, 2, bob, 300e18);
        _postSingle(_curEpoch(), leaf, 3);
        _claim(_curEpoch(), 11, 2, bob, 300e18);
        assertEq(bridge.exitedCredits(2), 100e18, "B11: exited must be capped by credited");
        assertEq(bridge.unattributedExited(), 200e18);
        assertLe(bridge.exitedCredits(2), bridge.credited(2), "B11");
    }
}

// ============================================================================
//                          SETTLE / COLLECT MECHANICS
// ============================================================================

contract BacBridgeSettleTest is BacBridgeTestBase {
    function setUp() public override {
        super.setUp();
        _lock(alice, 1, 1000e18);
        vm.deal(address(this), 1000 ether);
        bridge.acceptRelease{value: 10 ether}();
        bytes32 leaf = _leaf(1, 1, alice, 1000e18);
        _postSingle(_curEpoch(), leaf, 3);
        _claim(_curEpoch(), 1, 1, alice, 1000e18); // owed[alice] = 10 BNB
        assertEq(bridge.owed(alice), 10 ether);
    }

    function test_SettleEpochMustBeSequential() public {
        _warpEpochs(3);
        uint64 next = bridge.lastSettledEpoch() + 1;
        anchor.setAnchor(next + 1, bytes32(uint256(1)), 3, IChainAnchor.State.FINAL);
        vm.expectRevert(unicode"Settle epochs in order / 纪元必须按序结算");
        bridge.settleEpoch(next + 1);

        anchor.setAnchor(next, bytes32(uint256(1)), 3, IChainAnchor.State.FINAL);
        bridge.settleEpoch(next);
        assertEq(bridge.lastSettledEpoch(), next);

        vm.expectRevert(unicode"Settle epochs in order / 纪元必须按序结算");
        bridge.settleEpoch(next); // no replay of the same epoch either
    }

    /// B16: a veto / dispute can never freeze the cursor.
    function test_SettleSkipsTerminalNonFinalEpochs() public {
        _warpEpochs(2);
        uint64 e = bridge.lastSettledEpoch() + 1;
        anchor.setAnchor(e, bytes32(0), 0, IChainAnchor.State.VETOED);
        bridge.settleEpoch(e);
        assertEq(bridge.skippedEpochs(), 1);
        assertEq(bridge.lastSettledEpoch(), e);

        e = bridge.lastSettledEpoch() + 1;
        anchor.setAnchor(e, bytes32(0), 0, IChainAnchor.State.DISPUTED);
        bridge.settleEpoch(e);
        assertEq(bridge.skippedEpochs(), 2);

        // and a FINAL epoch after them still releases
        e = bridge.lastSettledEpoch() + 1;
        anchor.setAnchor(e, bytes32(uint256(1)), 3, IChainAnchor.State.FINAL);
        bridge.settleEpoch(e);
        (uint256 pot,,) = bridge.lastEpochRelease();
        assertEq(pot, 0.5 ether); // 5% of 10 BNB
    }

    /// B16: an epoch that is neither FINAL nor terminal advances after SETTLE_GRACE.
    function test_SettleWaitsGraceThenSkipsUnresolvedEpoch() public {
        uint64 e = bridge.lastSettledEpoch() + 1;
        _warpEpochs(1);
        vm.expectRevert(unicode"Epoch not resolved yet / 该纪元尚未定案");
        bridge.settleEpoch(e);

        vm.warp((uint256(e) + 1) * 86400 + uint256(bridge.SETTLE_GRACE()));
        bridge.settleEpoch(e);
        assertEq(bridge.lastSettledEpoch(), e);
        assertEq(bridge.skippedEpochs(), 1);
    }

    function test_ReleaseBpsTiers() public {
        _warpEpochs(1);
        assertEq(_settleNext(0), 0.2 ether, "0 witnesses -> 200 bps"); // 2% of 10 BNB
        _warpEpochs(1);
        assertEq(_settleNext(2), (10 ether - 0.2 ether) * 350 / 10000, "1-2 witnesses -> 350 bps");
        _warpEpochs(1);
        (uint256 reserved, uint16 bps) = (bridge.reservedTotal(), 500);
        _warpEpochs(0);
        assertEq(_settleNext(3), (10 ether - reserved) * bps / 10000, "3+ witnesses -> 500 bps");
    }

    /// The per-address cap truncates, and the remainder stays in `owed` forever (never forfeited).
    function test_CapTruncationLeavesRemainderInOwedForever() public {
        _warpEpochs(1);
        uint256 pot = _settleNext(3);
        assertEq(pot, 0.5 ether);

        uint256 cap = (pot * bridge.MAX_EXIT_SHARE_BPS()) / 10000;
        assertEq(cap, 0.05 ether);
        assertEq(bridge.pendingCollect(alice), cap, "pendingCollect must already be truncated");

        vm.prank(alice);
        uint256 paid = bridge.collect(alice);
        assertEq(paid, cap);
        assertEq(bridge.owed(alice), 10 ether - cap, "remainder stays in owed");
        assertEq(bridge.unclaimed(alice), pot - cap, "truncated wei stays in unclaimed, never forfeited");
        assertEq(bridge.reservedTotal(), pot - cap);
        assertLe(bridge.reservedTotal(), bridge.owedTotal(), "B14");

        // next epoch: the same address can collect the leftover, still capped
        _warpEpochs(1);
        uint256 pot2 = _settleNext(3);
        vm.prank(alice);
        uint256 paid2 = bridge.collect(alice);
        assertEq(paid2, (pot2 * bridge.MAX_EXIT_SHARE_BPS()) / 10000);
        assertGt(bridge.unclaimed(alice), 0, "leftover still there");
        assertEq(bridge.owed(alice), 10 ether - paid - paid2);
    }

    function test_DoubleCollectInSameEpochRejected() public {
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        bridge.collect(alice);
        vm.prank(alice);
        vm.expectRevert(unicode"Already collected this epoch / 本纪元已领取");
        bridge.collect(alice);

        // a new epoch unlocks it again
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        assertGt(bridge.collect(alice), 0);
    }

    /// B15: a freshly locked `owed` gets nothing from releases that happened before it existed.
    function test_NewOwedGetsNothingFromEarlierReleases() public {
        _warpEpochs(1);
        _settleNext(3); // 0.5 BNB released, all of it belongs to alice

        // bob locks and exits AFTER that release (fresh revenue, otherwise the rate is 0)
        bridge.acceptRelease{value: 10 ether}();
        _lock(bob, 2, 1000e18);
        bytes32 leaf = _leaf(2, 2, bob, 1000e18);
        _postSingle(_curEpoch(), leaf, 3);
        _claim(_curEpoch(), 2, 2, bob, 1000e18);
        assertGt(bridge.owed(bob), 0);

        assertEq(bridge.pendingCollect(bob), 0, "B15: no share of a pre-existing release");
        vm.prank(bob);
        vm.expectRevert(unicode"Nothing to collect / 没有可领取的金额");
        bridge.collect(bob);

        // alice, whose debt predates the release, can still collect
        vm.prank(alice);
        assertGt(bridge.collect(alice), 0);
    }

    /// Zero-witness ceiling: any 30 consecutive epochs release at most 15% of the pool.
    function test_ZeroWitnessWindowCap() public {
        uint256 released;
        for (uint64 i = 0; i < 30; i++) {
            _warpEpochs(1);
            released += _settleNext(0);
        }
        uint256 capTotal = (uint256(10 ether) * uint256(bridge.NO_ATTEST_WINDOW_BPS())) / 10000;
        emit log_named_uint("capTotal", capTotal);
        assertLe(released, capTotal + 1, "zero-witness window cap");
        assertEq(bridge.releasedInWindow(), released);
    }

    /// I2 / B14: reservations can never ratchet past the debt they serve.
    function test_ReservedNeverExceedsOwed() public {
        for (uint64 i = 0; i < 40; i++) {
            _warpEpochs(1);
            _settleNext(3);
            assertLe(bridge.reservedTotal(), bridge.owedTotal(), "B14");
            assertLe(bridge.owedTotal(), bridge.poolBalance(), "B1");
        }
    }

    function test_SettleWithZeroOwedClearsRoundingDust() public {
        // pay alice out completely through a halt-free path is slow; instead exit-free bridge:
        BacBridge fresh = new BacBridge(address(bac), address(registry), address(anchor), watchdog);
        vm.deal(address(this), 5 ether);
        fresh.acceptRelease{value: 5 ether}();
        _warpEpochs(1);
        uint64 e = fresh.lastSettledEpoch() + 1;
        anchor.setAnchor(e, bytes32(uint256(1)), 3, IChainAnchor.State.FINAL);
        fresh.settleEpoch(e);
        assertEq(fresh.reservedTotal(), 0);
        assertEq(fresh.accPerOwed(), 0);
    }
}

// ============================================================================
//                            PAUSE / HALT / ESCAPE
// ============================================================================

contract BacBridgeHaltTest is BacBridgeTestBase {
    function setUp() public override {
        super.setUp();
        _lock(alice, 1, 600e18);
        _lock(bob, 2, 400e18);
        vm.deal(address(this), 1000 ether);
        bridge.acceptRelease{value: 10 ether}();
    }

    function _aliceExits(uint256 credits, uint256 exitId) internal returns (uint256) {
        bytes32 leaf = _leaf(exitId, 1, alice, credits);
        _postSingle(_curEpoch(), leaf, 3);
        return _claim(_curEpoch(), exitId, 1, alice, credits);
    }

    /// `pause()` freezes `collect` and nothing else. B19: `claimExit` does not depend on it.
    function test_PauseBlocksCollectButNeverClaimExit() public {
        _aliceExits(100e18, 1);
        _warpEpochs(1);
        _settleNext(3);

        vm.prank(watchdog);
        bridge.pause();
        (bool paused,,) = bridge.isPaused();
        assertTrue(paused);

        vm.prank(alice);
        vm.expectRevert(unicode"Bridge paused / 桥已暂停");
        bridge.collect(alice);

        // claimExit still works while paused
        assertGt(_aliceExits(100e18, 2), 0, "claimExit must not be pausable");

        vm.prank(watchdog);
        bridge.unpause();
        vm.prank(alice);
        assertGt(bridge.collect(alice), 0);
    }

    function test_OnlyWatchdogCanPause() public {
        vm.expectRevert(unicode"Only watchdog / 仅限看门狗");
        bridge.pause();
        vm.prank(vetoKey);
        vm.expectRevert(unicode"Only watchdog / 仅限看门狗");
        bridge.unpause();
    }

    /// B17: the pause budget is bounded, and exhausting it IS halt cause 5.
    function test_PauseBudgetExhaustionBecomesHaltCause5() public {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(watchdog);
            bridge.pause();
            vm.warp(vm.getBlockTimestamp() + 7 days);
        }
        (,, uint64 cumulative) = bridge.isPaused();
        assertGe(cumulative, bridge.MAX_PAUSE_TOTAL(), "B17");
        assertEq(bridge.pendingCause(), 5);

        vm.prank(watchdog);
        vm.expectRevert(unicode"Pause budget exhausted / 暂停额度已用尽");
        bridge.pause();

        // and the escape hatch opens on its own
        bridge.checkHalt();
        assertEq(bridge.armedCause(), 5);
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
        assertEq(bridge.haltCause(), 5);
    }

    function test_ArmingIsNeverAnImmediateHalt() public {
        anchor.setHaltReason(1);
        bridge.checkHalt();
        assertEq(bridge.armedCause(), 1);
        assertFalse(bridge.isHalted());

        vm.expectRevert(unicode"Arming delay not elapsed / 武装期未满");
        bridge.checkHalt();

        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
    }

    function test_CancelEscapeArmOnlyWhenConditionCleared() public {
        anchor.setHaltReason(2);
        bridge.checkHalt();

        vm.prank(alice);
        vm.expectRevert(unicode"Only veto key / 仅限 veto 钥");
        bridge.cancelEscapeArm();

        vm.prank(vetoKey);
        vm.expectRevert(unicode"Condition still true / 触发条件仍然成立");
        bridge.cancelEscapeArm();

        anchor.setHaltReason(0);
        vm.prank(vetoKey);
        bridge.cancelEscapeArm();
        assertEq(bridge.escapeArmedAt(), 0);
        assertEq(bridge.armedCause(), 0);
    }

    function test_ManualArmIsCancellableAtDiscretion() public {
        vm.prank(watchdog);
        bridge.armEscape();
        assertEq(bridge.armedCause(), 4);
        vm.prank(vetoKey);
        bridge.cancelEscapeArm();
        assertEq(bridge.escapeArmedAt(), 0);
    }

    function _haltWith(uint8 cause) internal {
        if (cause == 4) {
            vm.prank(watchdog);
            bridge.armEscape();
        } else {
            anchor.setHaltReason(cause);
            bridge.checkHalt();
        }
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
        assertEq(bridge.haltCause(), cause);
    }

    function test_HaltFreezesNormalPathAndOpensEscape() public {
        _aliceExits(100e18, 1);
        _haltWith(1);

        vm.prank(alice);
        vm.expectRevert(unicode"Bridge halted / 桥已停机");
        bridge.collect(alice);
        uint64 nextEpoch = bridge.lastSettledEpoch() + 1; // hoisted: an inline call would eat the expectation
        vm.expectRevert(unicode"Bridge halted / 桥已停机");
        bridge.settleEpoch(nextEpoch);
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(unicode"Bridge halted / 桥已停机");
        bridge.claimExit(_curEpoch(), 99, 1, alice, 1e18, proof);

        bac.mint(alice, 1e18);
        vm.startPrank(alice);
        bac.approve(address(bridge), 1e18);
        vm.expectRevert(unicode"Bridge halted / 桥已停机");
        bridge.lock(1, 1e18);
        vm.stopPrank();

        (uint256 weight,,) = bridge.escapeState();
        assertEq(weight, 900e18, "junior weight = outstanding credits at halt");
    }

    /// @dev Arms first, exits inside the arming window, then halts: `owed` is younger than
    ///      `OWED_MATURITY` at `haltedAt` — exactly what a stolen relayer key could produce.
    function _armExitThenHalt(uint8 cause) internal {
        anchor.setHaltReason(cause);
        bridge.checkHalt();
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        _aliceExits(100e18, 1);
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
        assertEq(bridge.haltCause(), cause);
        assertGt(bridge.owed(alice), 0);
    }

    /// cause 1: an immature owed is still paid in full, `OWED_MATURITY` after the halt.
    function test_Cause1ImmatureOwedStillPaidAfterMaturity() public {
        _armExitThenHalt(1);

        vm.prank(alice);
        vm.expectRevert(unicode"Owed not matured / 债权尚未成熟");
        bridge.claimOwedAfterHalt(alice);

        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        uint256 expected = bridge.owed(alice);
        vm.prank(alice);
        uint256 paid = bridge.claimOwedAfterHalt(alice);
        assertEq(paid, expected);
        assertEq(bridge.owed(alice), 0);
        assertEq(bridge.owedTotal(), 0);
    }

    /// A matured owed is senior and paid immediately at the halt.
    function test_MaturedOwedIsPaidImmediately() public {
        _aliceExits(100e18, 1);
        vm.warp(vm.getBlockTimestamp() + 20 days); // owed matures
        _haltWith(1);
        uint256 expected = bridge.owed(alice);
        vm.prank(alice);
        assertEq(bridge.claimOwedAfterHalt(alice), expected);
    }

    /// cause 2/3: an immature owed loses priority forever and is demoted to the junior pot.
    function test_Cause2ImmatureOwedIsDemoted() public {
        _armExitThenHalt(2);

        vm.expectRevert(unicode"Owed not matured / 债权尚未成熟");
        bridge.sweepImmatureOwed(alice);
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());

        vm.prank(alice);
        vm.expectRevert(unicode"Owed not matured / 债权尚未成熟");
        bridge.claimOwedAfterHalt(alice);

        uint256 accBefore = bridge.accPerWeight();
        uint256 demoted = bridge.owed(alice);
        bridge.sweepImmatureOwed(alice); // permissionless
        assertEq(bridge.owed(alice), 0);
        assertEq(bridge.owedTotal(), 0);
        assertGt(bridge.accPerWeight(), accBefore, "demoted wei went to the junior accumulator");
        assertGt(demoted, 0);
    }

    function test_MaturedOwedIsNotDemotableUnderCause2() public {
        _aliceExits(100e18, 1);
        vm.warp(vm.getBlockTimestamp() + 20 days);
        _haltWith(2);
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        vm.expectRevert(unicode"Owed already matured / 该债权已成熟");
        bridge.sweepImmatureOwed(alice);
    }

    /// The junior path: weight is `credited - exitedCredits`, status is never consulted.
    function test_EscapeCollectPaysJuniorProRata() public {
        _haltWith(4);
        (uint256 weight,,) = bridge.escapeState();
        assertEq(weight, 1000e18);

        registry.setStatus(1, IAgentRegistry.Status.BANNED); // must not matter
        uint256 beforeBal = alice.balance;
        vm.prank(alice);
        uint256 paid = bridge.escapeCollect(1, alice);
        assertEq(paid, 6 ether, "600/1000 of the 10 BNB pool");
        assertEq(alice.balance - beforeBal, paid);

        vm.prank(bob);
        assertEq(bridge.escapeCollect(2, bob), 4 ether);

        vm.prank(alice);
        vm.expectRevert(unicode"Nothing to collect / 没有可领取的金额");
        bridge.escapeCollect(1, alice);
    }

    /// B13 + attack-funds #11: revenue received after a halt reaches the junior claimants.
    function test_PostHaltRevenueFlowsToJunior() public {
        _haltWith(4);
        vm.prank(alice);
        bridge.escapeCollect(1, alice);

        bridge.acceptRelease{value: 2 ether}();
        assertEq(bridge.poolBalance(), 4 ether + 2 ether);
        vm.prank(alice);
        uint256 paid = bridge.escapeCollect(1, alice);
        assertEq(paid, 1.2 ether, "600/1000 of the new 2 BNB");
    }

    /// B13: with no outstanding credits at the halt, money still lands in `poolBalance`.
    function test_ZeroWeightHaltKeepsAccPerWeightZero() public {
        // every agent's credits leave, so `credited - exitedCredits` is 0 for all of them
        _postSingle(_curEpoch(), _leaf(1, 1, alice, 600e18), 3);
        _claim(_curEpoch(), 1, 1, alice, 600e18);
        _postSingle(_curEpoch(), _leaf(2, 2, bob, 400e18), 3);
        _claim(_curEpoch(), 2, 2, bob, 400e18);
        assertEq(bridge.creditsOutstanding(), 0);
        assertEq(bridge.unattributedExited(), 0);
        _haltWith(4);
        (uint256 weight, uint256 acc,) = bridge.escapeState();
        assertEq(weight, 0);
        assertEq(acc, 0, "B13");

        uint256 poolBefore = bridge.poolBalance();
        bridge.acceptRelease{value: 1 ether}();
        assertEq(bridge.poolBalance(), poolBefore + 1 ether, "B13");
        assertEq(bridge.accPerWeight(), 0, "B13");
    }

    /// Regression (found by the invariant run): with an over-earning agent the junior weights
    /// sum to MORE than `issued - exited`, so the spec's literal denominator over-distributes
    /// the escape pot and drives `poolBalance` below `owedTotal`.
    function test_EscapeWeightCoversOverEarningAgents() public {
        // agent 2 locked 400 but exits 600 credits: 200 land in `unattributedExited`
        bytes32 leaf = _leaf(1, 2, bob, 600e18);
        _postSingle(_curEpoch(), leaf, 3);
        _claim(_curEpoch(), 1, 2, bob, 600e18);
        assertEq(bridge.unattributedExited(), 200e18);
        assertEq(bridge.creditsOutstanding(), 400e18);

        _haltWith(4);
        (uint256 weight,,) = bridge.escapeState();
        uint256 sumOfWeights =
            (bridge.credited(1) - bridge.exitedCredits(1)) + (bridge.credited(2) - bridge.exitedCredits(2));
        assertEq(weight, sumOfWeights, "escape denominator must be the sum of the weights");
        assertEq(weight, 600e18);

        uint256 poolAtHalt = bridge.poolBalance();
        vm.prank(alice);
        uint256 paidA = bridge.escapeCollect(1, alice);
        vm.prank(bob);
        (bool ok, bytes memory ret) =
            address(bridge).call(abi.encodeWithSignature("escapeCollect(uint256,address)", uint256(2), bob));
        uint256 paidB = ok ? abi.decode(ret, (uint256)) : 0; // weight 0 -> nothing to collect
        assertLe(paidA + paidB, poolAtHalt, "junior pot over-distributed");
        assertLe(bridge.owedTotal(), bridge.poolBalance(), "B1");

        // the senior claim must still be payable in full afterwards
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        uint256 senior = bridge.owed(bob);
        vm.prank(bob);
        assertEq(bridge.claimOwedAfterHalt(bob), senior);
    }

    /// B8: no privileged role has any path to the money.
    function test_NoPrivilegedPathToFunds() public {
        _aliceExits(100e18, 1);
        uint256 wdBefore = watchdog.balance;
        uint256 vkBefore = vetoKey.balance;

        vm.startPrank(watchdog);
        bridge.pause();
        bridge.unpause();
        bridge.armEscape();
        vm.stopPrank();

        vm.prank(vetoKey);
        bridge.cancelEscapeArm();

        assertEq(watchdog.balance, wdBefore);
        assertEq(vetoKey.balance, vkBefore);
        assertEq(bac.balanceOf(watchdog), 0);
        assertEq(bac.balanceOf(vetoKey), 0);
        // and there is simply no owner / admin entry point
        (bool ok,) = address(bridge).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "BacBridge must have no owner()");
        (ok,) = address(bridge).call(abi.encodeWithSignature("admin()"));
        assertFalse(ok, "BacBridge must have no admin()");
    }

    /// The watchdog cannot stop the escape path once halted.
    function test_PauseCannotFreezeEscapePath() public {
        _aliceExits(100e18, 1);
        vm.prank(watchdog);
        bridge.pause();
        _haltWith(4);
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());

        vm.prank(alice);
        assertGt(bridge.claimOwedAfterHalt(alice), 0, "pause must not freeze the senior claim");
        vm.prank(bob);
        assertGt(bridge.escapeCollect(2, bob), 0, "pause must not freeze the junior claim");
    }
}

// ============================================================================
//                               BacNodeFund
// ============================================================================

contract BacNodeFundTest is Test {
    BacNodeFund internal fund;
    MockBAC internal bac;
    address internal owner = makeAddr("nodeFundOwner");
    address internal stranger = makeAddr("stranger");
    address internal payoutTo = makeAddr("projectWallet");

    function setUp() public {
        bac = new MockBAC();
        fund = new BacNodeFund(address(bac), owner);
        vm.deal(address(this), 100 ether);
    }

    function test_AcceptReleaseTracksLifetime() public {
        fund.acceptRelease{value: 3 ether}();
        fund.acceptRelease{value: 1 ether}();
        assertEq(fund.balance(), 4 ether);
        assertEq(fund.lifetimeReceived(), 4 ether);
        assertEq(fund.lifetimeWithdrawn(), 0);
    }

    function test_OwnerWithdrawsPartialAndAll() public {
        fund.acceptRelease{value: 5 ether}();
        vm.prank(owner);
        fund.withdraw(payoutTo, 2 ether);
        assertEq(payoutTo.balance, 2 ether);
        assertEq(fund.balance(), 3 ether);

        vm.prank(owner);
        fund.withdraw(payoutTo, 0); // 0 == everything
        assertEq(payoutTo.balance, 5 ether);
        assertEq(fund.balance(), 0);
        // N1
        assertEq(fund.lifetimeReceived(), fund.lifetimeWithdrawn() + fund.balance());
    }

    function test_OnlyOwnerCanWithdraw() public {
        fund.acceptRelease{value: 1 ether}();
        vm.prank(stranger);
        vm.expectRevert(unicode"Only owner / 仅限 owner");
        fund.withdraw(stranger, 1 ether);

        vm.prank(owner);
        vm.expectRevert(unicode"Amount exceeds balance / 金额超过余额");
        fund.withdraw(payoutTo, 2 ether);

        BacNodeFund empty = new BacNodeFund(address(bac), owner);
        vm.prank(owner);
        vm.expectRevert(unicode"Nothing to withdraw / 没有可提取的金额");
        empty.withdraw(payoutTo, 0);

        vm.prank(owner);
        vm.expectRevert(unicode"Zero recipient / 收款地址为零");
        fund.withdraw(address(0), 1);
    }

    function test_TwoStepOwnershipTransfer() public {
        address next = makeAddr("newOwner");
        vm.prank(stranger);
        vm.expectRevert(unicode"Only owner / 仅限 owner");
        fund.transferOwnership(next);

        vm.prank(owner);
        fund.transferOwnership(next);
        assertEq(fund.owner(), owner, "owner does not change until accepted");
        assertEq(fund.pendingOwner(), next);

        vm.prank(stranger);
        vm.expectRevert(unicode"Only pending owner / 仅限待定 owner");
        fund.acceptOwnership();

        vm.prank(next);
        fund.acceptOwnership();
        assertEq(fund.owner(), next);
        assertEq(fund.pendingOwner(), address(0));

        fund.acceptRelease{value: 1 ether}();
        vm.prank(next);
        fund.withdraw(payoutTo, 0);
        assertEq(payoutTo.balance, 1 ether);
    }

    function test_NoPlainReceiveAndNoBridgePath() public {
        (bool ok,) = address(fund).call{value: 1 ether}("");
        assertFalse(ok, "node fund must have no receive()");
        // N2: there is no function that takes a bridge address or moves BAC
        (ok,) = address(fund).call(abi.encodeWithSignature("rescueToken(address,uint256)", address(bac), 1));
        assertFalse(ok);
        (ok,) = address(fund).call(abi.encodeWithSignature("sweep(address)", address(bac)));
        assertFalse(ok);
    }

    function testFuzz_LifetimeIdentityHolds(uint96 inA, uint96 inB, uint96 out) public {
        vm.deal(address(this), uint256(inA) + uint256(inB));
        fund.acceptRelease{value: inA}();
        fund.acceptRelease{value: inB}();
        uint256 bal = fund.balance();
        uint256 amount = bal == 0 ? 0 : uint256(out) % (bal + 1);
        if (amount > 0) {
            vm.prank(owner);
            fund.withdraw(payoutTo, amount);
        }
        assertEq(fund.lifetimeReceived(), fund.lifetimeWithdrawn() + fund.balance(), "N1");
    }
}
