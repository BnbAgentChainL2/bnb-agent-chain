// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BacBridge} from "../src/BacBridge.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";
import {IChainAnchor} from "../src/interfaces/IChainAnchor.sol";
import {MockBAC, MockRegistry, MockAnchor} from "./BacBridge.t.sol";

/// @title BridgeHandler
/// @notice Bounded actor set + ghost variables for the `BacBridge` invariant run (§4.3, B1-B14).
///         Four actors, one agent id each, every call wrapped in try/catch so a revert never
///         corrupts a ghost. Everything the invariants assert about money is mirrored here.
contract BridgeHandler is Test {
    BacBridge public bridge;
    MockBAC public bac;
    MockRegistry public registry;
    MockAnchor public anchor;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant ACTORS = 4;

    address[4] internal actors;

    // ---- ghosts ----
    uint256 public gReceived; // BNB in via acceptRelease + sweepUntracked
    uint256 public gPaid; // BNB out via collect + claimOwedAfterHalt + escapeCollect
    uint256 public gReceivedAfterHalt;
    uint256 public gPaidAfterHalt;
    uint256 public gMinted; // BAC ever minted to actors
    uint256 public gDoubleClaim; // B9: must stay 0
    uint256 public gDoubleCollect; // B9: must stay 0
    bool public gB10Violated; // B10
    bool public gCapViolated; // B15
    uint256 public gHarvests; // every rebase can add at most 1 wei of floor dust (see B3)
    bool public gHaltRecorded;
    uint256 public gJuniorAtHalt;
    uint256 public gOwedAtHalt;

    uint256 internal nextExitId = 1;

    struct LastExit {
        uint64 epoch;
        uint256 exitId;
        uint256 agentId;
        address to;
        uint256 credits;
        bool set;
    }

    LastExit internal last;

    constructor(
        BacBridge bridge_,
        MockBAC bac_,
        MockRegistry registry_,
        MockAnchor anchor_,
        address[4] memory actors_
    ) {
        bridge = bridge_;
        bac = bac_;
        registry = registry_;
        anchor = anchor_;
        actors = actors_;
        vm.deal(address(this), 1_000_000 ether);
    }

    receive() external payable {}

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % ACTORS];
    }

    function _agentOf(uint256 seed) internal pure returns (uint256) {
        return (seed % ACTORS) + 1;
    }

    function _leaf(uint256 exitId, uint256 agentId, address to, uint256 credits) internal view returns (bytes32) {
        return keccak256(
            abi.encode(bridge.EXIT_TYPEHASH(), exitId, agentId, to, credits, bridge.LAYER_CHAIN_ID(), address(bridge))
        );
    }

    function _epoch() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp() / 86400);
    }

    function _noteHalt() internal {
        if (!gHaltRecorded && bridge.isHalted()) {
            gHaltRecorded = true;
            gOwedAtHalt = bridge.owedTotal();
            gJuniorAtHalt = bridge.poolBalance() - bridge.owedTotal();
        }
    }

    // ------------------------------------------------------------------ IN

    function lock(uint256 actorSeed, uint256 amount) public {
        address a = _actor(actorSeed);
        uint256 agentId = _agentOf(actorSeed);
        amount = bound(amount, 1e15, 500e18);
        bac.mint(a, amount);
        gMinted += amount;
        vm.startPrank(a);
        bac.approve(address(bridge), amount);
        try bridge.lock(agentId, amount) {} catch {}
        vm.stopPrank();
    }

    function release(uint256 amount) public {
        amount = bound(amount, 1e14, 20 ether);
        if (address(this).balance < amount) return;
        uint256 poolBefore = bridge.poolBalance();
        bridge.acceptRelease{value: amount}();
        // B13: the pool ALWAYS grows by the full amount, halted or not
        require(bridge.poolBalance() == poolBefore + amount, "acceptRelease lost money");
        gReceived += amount;
        if (bridge.isHalted()) gReceivedAfterHalt += amount;
    }

    /// @dev Simulates a force-pushed balance (selfdestruct / coinbase) and folds it in.
    function forcePushAndSweep(uint256 amount) public {
        amount = bound(amount, 1, 5 ether);
        vm.deal(address(bridge), address(bridge).balance + amount);
        try bridge.sweepUntracked() returns (uint256 swept) {
            gReceived += swept;
            if (bridge.isHalted()) gReceivedAfterHalt += swept;
        } catch {}
    }

    function burn() public {
        try bridge.burnLocked() {} catch {}
    }

    // ------------------------------------------------------------------ OUT (normal)

    function claimExit(uint256 actorSeed, uint256 creditsSeed) public {
        address to = _actor(actorSeed);
        uint256 agentId = _agentOf(actorSeed);
        uint256 outstanding = bridge.creditsOutstanding();
        if (outstanding == 0) return;
        uint256 credits = bound(creditsSeed, 1, outstanding);
        uint256 exitId = nextExitId;
        uint64 e = _epoch();
        anchor.setAnchor(e, _leaf(exitId, agentId, to, credits), 3, IChainAnchor.State.FINAL);
        bytes32[] memory proof = new bytes32[](0);
        try bridge.claimExit(e, exitId, agentId, to, credits, proof) {
            nextExitId++;
            gHarvests++;
            last = LastExit(e, exitId, agentId, to, credits, true);
        } catch {}
    }

    /// @dev B9: replaying the very same exit must always fail.
    function replayExit() public {
        if (!last.set) return;
        anchor.setAnchor(
            last.epoch, _leaf(last.exitId, last.agentId, last.to, last.credits), 3, IChainAnchor.State.FINAL
        );
        bytes32[] memory proof = new bytes32[](0);
        try bridge.claimExit(last.epoch, last.exitId, last.agentId, last.to, last.credits, proof) {
            gDoubleClaim++;
        } catch {}
    }

    /// @dev B10: two different-sized exits in the same block must share one per-credit rate.
    function b10Pair(uint256 actorSeed, uint256 sizeSeed) public {
        uint256 outstanding = bridge.creditsOutstanding();
        if (outstanding < 4e15) return;
        address to = _actor(actorSeed);
        uint256 agentId = _agentOf(actorSeed);
        uint256 cA = bound(sizeSeed, 1e15, outstanding / 2);
        uint256 cB = cA == outstanding / 2 ? cA / 2 + 1 : cA + 1e15;
        if (cB == 0 || cB > outstanding - cA) return;

        uint64 e = _epoch();
        bytes32[] memory proof = new bytes32[](0);
        uint256 idA = nextExitId;
        anchor.setAnchor(e, _leaf(idA, agentId, to, cA), 3, IChainAnchor.State.FINAL);
        uint256 lockedA;
        try bridge.claimExit(e, idA, agentId, to, cA, proof) returns (uint256 v) {
            lockedA = v;
            nextExitId++;
            gHarvests++;
        } catch {
            return;
        }
        uint256 idB = nextExitId;
        anchor.setAnchor(e, _leaf(idB, agentId, to, cB), 3, IChainAnchor.State.FINAL);
        uint256 lockedB;
        try bridge.claimExit(e, idB, agentId, to, cB, proof) returns (uint256 v) {
            lockedB = v;
            nextExitId++;
            gHarvests++;
            last = LastExit(e, idB, agentId, to, cB, true);
        } catch {
            return;
        }
        uint256 rateA = (lockedA * 1e18) / cA;
        uint256 rateB = (lockedB * 1e18) / cB;
        uint256 diff = rateA > rateB ? rateA - rateB : rateB - rateA;
        if (diff > 1e6) gB10Violated = true;
    }

    function settle(uint256 seed) public {
        uint64 e = bridge.lastSettledEpoch() + 1;
        if (e > _epoch()) return; // never settle an epoch that has not happened yet
        uint256 mode = seed % 5;
        if (mode == 0) {
            anchor.setAnchor(e, bytes32(uint256(1)), 0, IChainAnchor.State.FINAL); // zero witnesses
        } else if (mode == 1 || mode == 2) {
            anchor.setAnchor(e, bytes32(uint256(1)), 3, IChainAnchor.State.FINAL);
        } else if (mode == 3) {
            anchor.setAnchor(e, bytes32(0), 0, IChainAnchor.State.VETOED);
        } // mode 4: leave it NONE — only the grace path can advance it
        try bridge.settleEpoch(e) {} catch {}
    }

    function collect(uint256 actorSeed) public {
        address a = _actor(actorSeed);
        (uint256 pot,,) = bridge.lastEpochRelease();
        uint256 cap = (pot * bridge.MAX_EXIT_SHARE_BPS()) / 10000;
        vm.prank(a);
        try bridge.collect(a) returns (uint256 paid) {
            gPaid += paid;
            gHarvests++;
            if (paid > cap) gCapViolated = true; // B15
            // B9: a second collect in the same epoch must always fail
            vm.prank(a);
            try bridge.collect(a) returns (uint256 p2) {
                gDoubleCollect++;
                gPaid += p2;
            } catch {}
        } catch {}
    }

    // ------------------------------------------------------------------ brake / halt / escape

    function pause() public {
        vm.prank(bridge.watchdog());
        try bridge.pause() {} catch {}
    }

    function unpause() public {
        vm.prank(bridge.watchdog());
        try bridge.unpause() {} catch {}
    }

    function setHaltReason(uint256 seed) public {
        anchor.setHaltReason(uint8(seed % 4)); // 0..3
    }

    function armEscape() public {
        vm.prank(bridge.watchdog());
        try bridge.armEscape() {} catch {}
    }

    function cancelArm() public {
        vm.prank(anchor.vetoKey());
        try bridge.cancelEscapeArm() {} catch {}
    }

    function checkHalt() public {
        try bridge.checkHalt() {} catch {}
        _noteHalt();
    }

    function claimOwedAfterHalt(uint256 actorSeed) public {
        address a = _actor(actorSeed);
        vm.prank(a);
        try bridge.claimOwedAfterHalt(a) returns (uint256 paid) {
            gPaid += paid;
            gPaidAfterHalt += paid;
        } catch {}
    }

    function sweepImmatureOwed(uint256 actorSeed) public {
        try bridge.sweepImmatureOwed(_actor(actorSeed)) {} catch {}
    }

    function escapeCollect(uint256 actorSeed) public {
        address a = _actor(actorSeed);
        vm.prank(a);
        try bridge.escapeCollect(_agentOf(actorSeed), a) returns (uint256 paid) {
            gPaid += paid;
            gPaidAfterHalt += paid;
        } catch {}
    }

    // ------------------------------------------------------------------ time

    function warp(uint256 secs) public {
        secs = bound(secs, 1 hours, 3 days);
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    function warpEpochs(uint256 n) public {
        n = bound(n, 1, 5);
        vm.warp(vm.getBlockTimestamp() + n * 86400);
    }
}

/// @notice Invariants B1-B14 of docs/01-CONTRACT-SPEC.md §4.3, plus B15/B17 where they are cheap.
contract BacBridgeInvariantTest is Test {
    BacBridge internal bridge;
    MockBAC internal bac;
    MockRegistry internal registry;
    MockAnchor internal anchor;
    BridgeHandler internal handler;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal watchdog = makeAddr("watchdog");
    address internal vetoKey = makeAddr("vetoKey");

    function setUp() public {
        vm.warp(1_800_000_000);
        bac = new MockBAC();
        registry = new MockRegistry();
        anchor = new MockAnchor(vetoKey);
        bridge = new BacBridge(address(bac), address(registry), address(anchor), watchdog);

        address[4] memory actors = [makeAddr("a1"), makeAddr("a2"), makeAddr("a3"), makeAddr("a4")];
        for (uint256 i = 0; i < 4; i++) {
            registry.setAgent(i + 1, actors[i], address(uint160(0xA6E0 + i)), IAgentRegistry.Status.ACTIVE);
        }

        handler = new BridgeHandler(bridge, bac, registry, anchor, actors);

        bytes4[] memory selectors = new bytes4[](19);
        selectors[0] = BridgeHandler.lock.selector;
        selectors[1] = BridgeHandler.release.selector;
        selectors[2] = BridgeHandler.forcePushAndSweep.selector;
        selectors[3] = BridgeHandler.burn.selector;
        selectors[4] = BridgeHandler.claimExit.selector;
        selectors[5] = BridgeHandler.replayExit.selector;
        selectors[6] = BridgeHandler.b10Pair.selector;
        selectors[7] = BridgeHandler.settle.selector;
        selectors[8] = BridgeHandler.collect.selector;
        selectors[9] = BridgeHandler.pause.selector;
        selectors[10] = BridgeHandler.unpause.selector;
        selectors[11] = BridgeHandler.setHaltReason.selector;
        selectors[12] = BridgeHandler.armEscape.selector;
        selectors[13] = BridgeHandler.cancelArm.selector;
        selectors[14] = BridgeHandler.checkHalt.selector;
        selectors[15] = BridgeHandler.claimOwedAfterHalt.selector;
        selectors[16] = BridgeHandler.sweepImmatureOwed.selector;
        selectors[17] = BridgeHandler.escapeCollect.selector;
        selectors[18] = BridgeHandler.warpEpochs.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ---- helpers ----

    function _sumOwedSide() internal view returns (uint256 unclaimedSum, uint256 pendingSum) {
        for (uint256 i = 0; i < 4; i++) {
            address a = handler.actorAt(i);
            unclaimedSum += bridge.unclaimed(a);
            uint256 scaled = (bridge.owed(a) * bridge.accPerOwed()) / bridge.ACC_PRECISION();
            uint256 debt = bridge.owedDebt(a);
            if (scaled > debt) pendingSum += scaled - debt;
        }
    }

    // ================================================================== B1

    /// The solvency invariant. Everything else is a detail next to this one.
    function invariant_B1_OwedNeverExceedsPool() public view {
        assertLe(bridge.owedTotal(), bridge.poolBalance(), "B1: owedTotal > poolBalance");
    }

    // ================================================================== B2

    function invariant_B2_BalanceCoversPoolBalance() public view {
        assertGe(address(bridge).balance, bridge.poolBalance(), "B2: real balance below the book");
    }

    // ================================================================== B3

    /// Reserved wei is exactly the sum of what addresses may still harvest, up to rounding dust.
    /// Only meaningful before a halt: `_halt` voids every reservation by design.
    ///
    /// The spec says the dust "only makes the left side slightly bigger". That is almost true:
    /// a harvest credits `floor(owed*accNew/P) - floor(owed*accOld/P)`, and a difference of two
    /// floors can exceed the exact share by up to 1 wei. So the claims may sit at most one wei
    /// per harvest ABOVE `reservedTotal` — bounded, and `collect` clamps at `reservedTotal` so
    /// that dust can never underflow a payout.
    function invariant_B3_ReservedMatchesClaims() public view {
        if (bridge.isHalted()) return;
        (uint256 unclaimedSum, uint256 pendingSum) = _sumOwedSide();
        assertGe(
            bridge.reservedTotal() + handler.gHarvests(),
            unclaimedSum + pendingSum,
            "B3: reserved below the claims it backs by more than floor dust"
        );
        assertLe(
            unclaimedSum + pendingSum,
            bridge.owedTotal() + handler.gHarvests(),
            "B3: claims exceed the debt they are paid from"
        );
    }

    // ================================================================== B4

    function invariant_B4_CreditBookkeeping() public view {
        assertLe(bridge.totalCreditsExited(), bridge.totalCreditsIssued(), "B4: exited > issued");
        uint256 exitedSum;
        uint256 creditedSum;
        for (uint256 i = 1; i <= 4; i++) {
            exitedSum += bridge.exitedCredits(i);
            creditedSum += bridge.credited(i);
        }
        assertEq(exitedSum + bridge.unattributedExited(), bridge.totalCreditsExited(), "B4: exit attribution lost wei");
        assertEq(creditedSum, bridge.totalCreditsIssued(), "B4: credited sum != issued");
    }

    // ================================================================== B5

    function invariant_B5_PaidOutNeverExceedsTakenIn() public view {
        assertLe(handler.gPaid(), handler.gReceived(), "B5: paid out more than the pool ever received");
    }

    // ================================================================== B6 / B7

    function invariant_B6_LockedBacIsAllThere() public view {
        assertEq(bac.balanceOf(address(bridge)), bridge.totalLocked() - bridge.totalBurned(), "B6");
    }

    function invariant_B7_BacOnlyEverLeavesToDead() public view {
        assertEq(bac.balanceOf(DEAD), bridge.totalBurned(), "B7: dead address holds something else");
        uint256 actorsHold;
        for (uint256 i = 0; i < 4; i++) {
            actorsHold += bac.balanceOf(handler.actorAt(i));
        }
        // every minted wei is either still with an actor, locked in the bridge, or burned
        assertEq(
            actorsHold + bac.balanceOf(address(bridge)) + bac.balanceOf(DEAD),
            handler.gMinted(),
            "B7: BAC reached a third party"
        );
    }

    // ================================================================== B8

    function invariant_B8_PrivilegedRolesStayPoor() public view {
        assertEq(watchdog.balance, 0, "B8: watchdog received BNB");
        assertEq(vetoKey.balance, 0, "B8: veto key received BNB");
        assertEq(bac.balanceOf(watchdog), 0, "B8: watchdog received BAC");
        assertEq(bac.balanceOf(vetoKey), 0, "B8: veto key received BAC");
    }

    // ================================================================== B9

    function invariant_B9_NoDoubleClaimNoDoubleCollect() public view {
        assertEq(handler.gDoubleClaim(), 0, "B9: an exitId was claimed twice");
        assertEq(handler.gDoubleCollect(), 0, "B9: an address collected twice in one epoch");
    }

    // ================================================================== B10

    function invariant_B10_NoFirstMoverAdvantage() public view {
        assertFalse(handler.gB10Violated(), "B10: two same-epoch exits got different rates");
    }

    // ================================================================== B11

    function invariant_B11_ExitedNeverExceedsCredited() public view {
        for (uint256 i = 1; i <= 4; i++) {
            assertLe(bridge.exitedCredits(i), bridge.credited(i), "B11: escape weight would underflow");
        }
    }

    // ================================================================== B12

    /// @dev The spec writes "junior at halt + everything received after". Senior claims are paid
    ///      post-halt too and come out of `owedTotal`, so the bound must include it — that is the
    ///      whole pool at the halt, which is the safe reading.
    function invariant_B12_PostHaltPayoutsAreBounded() public view {
        if (!handler.gHaltRecorded()) return;
        assertLe(
            handler.gPaidAfterHalt(),
            handler.gJuniorAtHalt() + handler.gOwedAtHalt() + handler.gReceivedAfterHalt(),
            "B12: post-halt payouts exceeded the pot they can come from"
        );
    }

    // ================================================================== B13

    function invariant_B13_ZeroWeightMeansZeroAccumulator() public view {
        if (bridge.escapeTotalWeight() == 0) {
            assertEq(bridge.accPerWeight(), 0, "B13: junior accumulator moved with zero weight");
        }
    }

    // ================================================================== B14

    function invariant_B14_ReservedNeverRatchets() public view {
        assertLe(bridge.reservedTotal(), bridge.owedTotal(), "B14: reservation ratcheted past the debt");
    }

    // ================================================================== extras

    /// B15: nobody gets more than `lastPot * 10%` out of `collect` in one block.
    function invariant_B15_PerAddressRateLimit() public view {
        assertFalse(handler.gCapViolated(), "B15: per-address cap breached");
    }

    /// B17: the pause budget is bounded and exhausting it is a halt condition.
    function invariant_B17_PauseBudgetBounded() public view {
        (,, uint64 cumulative) = bridge.isPaused();
        if (cumulative >= bridge.MAX_PAUSE_TOTAL()) {
            assertTrue(bridge.isHalted() || bridge.pendingCause() != 0, "B17: exhausted budget is not a trigger");
        }
    }
}
