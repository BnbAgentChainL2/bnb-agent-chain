// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BacBridge} from "../src/BacBridge.sol";
import {IChainAnchor} from "../src/interfaces/IChainAnchor.sol";
import {
    MockBAC,
    MockErc8004,
    MockAnchor,
    MockPortal,
    MockRouter,
    BacBridgeV2Mock,
    deployBacBridge
} from "./BacBridge.t.sol";

/// @title BridgeHandler
/// @notice Bounded actor set + ghost variables for the `BacBridge` invariant run (§4.3, B1-B14,
///         plus the two-bucket separation of decision #24a②). Four actors, one agent id each,
///         every call wrapped in try/catch so a revert never corrupts a ghost.
///
///         The OWNER actions at the bottom (decision #29: emergency withdrawals, refills,
///         upgrades) are only targeted by `BacBridgeOwnerInvariantTest`. The plain suite never
///         calls them, so it keeps proving the original, stricter statements unchanged.
contract BridgeHandler is Test {
    BacBridge public bridge;
    MockBAC public bac;
    MockErc8004 public identity;
    MockAnchor public anchor;
    MockPortal public portal;
    MockRouter public router;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant ACTORS = 4;
    uint64 internal constant E = 600;
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address[4] internal actors;

    // ---- ghosts ----
    uint256 public gBnbIn; // BNB in via acceptRelease + sweepUntracked
    uint256 public gBnbOut; // BNB out via escapeCollect
    uint256 public gBnbInAfterHalt;
    uint256 public gBnbOutAfterHalt;
    uint256 public gBacIntoBuyback; // every wei that ever entered the PAYOUT bucket
    uint256 public gBacPaidOut; // every wei ever paid to an exiting address
    uint256 public gBacPaidAfterHalt;
    uint256 public gMinted; // BAC ever minted to actors
    uint256 public gDoubleClaim; // B9: must stay 0
    uint256 public gDoubleCollect; // B9: must stay 0
    bool public gB10Violated; // B10
    bool public gCapViolated; // B15
    bool public gBuybackTouchedDeposits; // decision #24a②: must stay false
    uint256 public gHarvests; // every rebase can add at most 1 wei of floor dust (see B3)
    bool public gHaltRecorded;
    uint256 public gJuniorBacAtHalt;
    uint256 public gJuniorBnbAtHalt;
    uint256 public gOwedAtHalt;

    // ---- ghosts added with decision #29 ----
    uint256 public gBnbForced; // every wei force-pushed (the owner's BNB refills included)
    uint256 public gBnbSwept; // the part of it `sweepUntracked` booked as revenue
    uint256 public gBacDonated; // every BAC wei sent in outside `lock` / `buyback` (refills included)
    uint256 public gBacSwept; // the part of it `sweepUntrackedBac` booked
    uint256 public gBacRefilled; // BAC the owner's treasury sent back
    bool public gExitDippedIntoDeposits; // a NON-owner payout left less BAC than the unburned deposits
    bool public gSweepReverted; // requirement 2: the sweeps may never revert
    bool public gBuybackBricked; // requirement 2: buyback may only revert on its slippage bound
    bool public gUpgradeMovedState;
    uint256 public gUpgrades;

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

    // ---- owner tools (only the owner suite sets and targets them) ----
    address public owner;
    address public treasury;
    address public implV1;
    address public implV2;

    constructor(
        BacBridge bridge_,
        MockBAC bac_,
        MockErc8004 identity_,
        MockAnchor anchor_,
        MockPortal portal_,
        MockRouter router_,
        address[4] memory actors_
    ) {
        bridge = bridge_;
        bac = bac_;
        identity = identity_;
        anchor = anchor_;
        portal = portal_;
        router = router_;
        actors = actors_;
        vm.deal(address(this), 1_000_000 ether);
    }

    receive() external payable {}

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    /// @dev Not a fuzz target: the owner suite calls it once from `setUp`.
    function setOwnerTools(address owner_, address treasury_, address implV1_, address implV2_) external {
        owner = owner_;
        treasury = treasury_;
        implV1 = implV1_;
        implV2 = implV2_;
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
        return uint64(vm.getBlockTimestamp() / E);
    }

    function _noteHalt() internal {
        if (!gHaltRecorded && bridge.isHalted()) {
            gHaltRecorded = true;
            gOwedAtHalt = bridge.owedTotal();
            gJuniorBacAtHalt = bridge.buybackBac() - bridge.owedTotal();
            gJuniorBnbAtHalt = bridge.bnbBalance();
        }
    }

    /// @dev Requirement 5, checked right after every successful non-owner BAC payout.
    function _checkDepositsCovered() internal {
        if (bac.balanceOf(address(bridge)) < bridge.lockedBac() - bridge.totalBurned()) {
            gExitDippedIntoDeposits = true;
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
        uint256 poolBefore = bridge.bnbBalance();
        bridge.acceptRelease{value: amount}();
        // B13: the book ALWAYS grows by the full amount, halted or not
        require(bridge.bnbBalance() == poolBefore + amount, "acceptRelease lost money");
        gBnbIn += amount;
        if (bridge.isHalted()) gBnbInAfterHalt += amount;
    }

    /// @dev Simulates a force-pushed balance (selfdestruct / coinbase) and folds it in. It is also
    ///      how the owner puts BNB back after an emergency withdrawal: there is no `receive`, and
    ///      `acceptRelease` would book it as new revenue.
    function forcePushAndSweep(uint256 amount) public {
        amount = bound(amount, 1, 5 ether);
        vm.deal(address(bridge), address(bridge).balance + amount);
        gBnbForced += amount;
        try bridge.sweepUntracked() returns (uint256 swept) {
            gBnbIn += swept;
            gBnbSwept += swept;
            if (bridge.isHalted()) gBnbInAfterHalt += swept;
        } catch {
            gSweepReverted = true;
        }
    }

    /// @dev A stray BAC transfer. It may only ever become a donation to the PAYOUT bucket.
    function donateBac(uint256 amount) public {
        amount = bound(amount, 1e12, 50e18);
        bac.mint(address(bridge), amount);
        gMinted += amount;
        gBacDonated += amount;
        _sweepBac();
    }

    function _sweepBac() internal {
        uint256 lockedBefore = bridge.lockedBac();
        try bridge.sweepUntrackedBac() returns (uint256 swept) {
            gBacIntoBuyback += swept;
            gBacSwept += swept;
        } catch {
            gSweepReverted = true;
        }
        if (bridge.lockedBac() != lockedBefore) gBuybackTouchedDeposits = true;
    }

    /// @dev The whole point: a permissionless, scheduled, bounded buy that files into `buybackBac`.
    function buyback(uint256 seed) public {
        // the venue is read from chain state, so shake it: curve / DEX / broken / slippery
        uint256 mode = seed % 6;
        portal.setStatus(mode == 1 ? 4 : 1);
        portal.setBroken(mode == 2);
        portal.setExtraSlip(mode == 3 ? 500 : 0);
        router.setBroken(mode == 4);
        uint256 lockedBefore = bridge.lockedBac();
        uint256 bucketBefore = bridge.buybackBac();
        try bridge.buyback(0, 0) returns (uint256 bought) {
            gBacIntoBuyback += bought;
            require(bridge.buybackBac() == bucketBefore + bought, "buyback mis-filed");
        } catch {
            // mode 3 is a fill worse than the slippage bound: the one designed revert
            if (mode != 3) gBuybackBricked = true;
        }
        portal.setBroken(false);
        portal.setExtraSlip(0);
        router.setBroken(false);
        if (bridge.lockedBac() != lockedBefore) gBuybackTouchedDeposits = true;
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

    /// @dev A whole exit in one step: claim, one epoch later settle it FINAL, then collect. Single
    ///      `claimExit` / `settle` / `collect` calls in the right order and by the right actor are
    ///      rare enough that without this the payout paths were almost never reached successfully
    ///      (measured: under 3 successful collects per 80-call run).
    function exitCycle(uint256 actorSeed, uint256 creditsSeed) public {
        claimExit(actorSeed, creditsSeed);
        vm.warp(vm.getBlockTimestamp() + E);
        uint64 e = bridge.lastSettledEpoch() + 1;
        if (e <= _epoch()) {
            anchor.setAnchor(e, bytes32(uint256(1)), 3, IChainAnchor.State.FINAL);
            try bridge.settleEpoch(e) {} catch {}
        }
        collect(actorSeed);
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
        } // mode 4: leave it NONE - only the grace path can advance it
        try bridge.settleEpoch(e) {} catch {}
    }

    function collect(uint256 actorSeed) public {
        address a = _actor(actorSeed);
        (uint256 pot,,) = bridge.lastEpochRelease();
        uint64 span = _epoch() - bridge.lastCollectEpoch(a);
        if (span > bridge.MAX_CATCHUP_EPOCHS()) span = uint64(bridge.MAX_CATCHUP_EPOCHS());
        uint256 cap = (pot * bridge.MAX_EXIT_SHARE_BPS() * span) / 10000;
        vm.prank(a);
        try bridge.collect(a) returns (uint256 paid) {
            gBacPaidOut += paid;
            gHarvests++;
            _checkDepositsCovered();
            if (paid > cap) gCapViolated = true; // B15
            // B9: a second collect in the same epoch must always fail
            vm.prank(a);
            try bridge.collect(a) returns (uint256 p2) {
                gDoubleCollect++;
                gBacPaidOut += p2;
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

    /// @dev The watchdog's 120-second tool: void immature owed locked against one anchor epoch.
    function revokeEpochOwed(uint256 actorSeed) public {
        if (!last.set) return;
        address[] memory who = new address[](1);
        who[0] = _actor(actorSeed);
        vm.prank(bridge.watchdog());
        try bridge.revokeEpochOwed(last.epoch, who) {} catch {}
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
            gBacPaidOut += paid;
            gBacPaidAfterHalt += paid;
            _checkDepositsCovered();
        } catch {}
    }

    function sweepImmatureOwed(uint256 actorSeed) public {
        try bridge.sweepImmatureOwed(_actor(actorSeed)) {} catch {}
    }

    /// @dev The escape claim is `agentController`'s, whichever actor the fuzzer picked.
    function escapeCollect(uint256 actorSeed) public {
        uint256 agentId = _agentOf(actorSeed);
        address a = bridge.agentController(agentId);
        if (a == address(0)) a = _actor(actorSeed);
        vm.prank(a);
        try bridge.escapeCollect(agentId, a) returns (uint256 bacPaid, uint256 bnbPaid) {
            gBacPaidOut += bacPaid;
            gBacPaidAfterHalt += bacPaid;
            gBnbOut += bnbPaid;
            gBnbOutAfterHalt += bnbPaid;
            _checkDepositsCovered();
        } catch {}
    }

    /// @dev An agent hands its escape claim to another actor (never outside the actor set, so
    ///      the BAC conservation check B7 still sees every holder).
    function setController(uint256 agentSeed, uint256 toSeed) public {
        uint256 agentId = _agentOf(agentSeed);
        address current = bridge.agentController(agentId);
        if (current == address(0)) return;
        vm.prank(current);
        try bridge.setAgentController(agentId, _actor(toSeed)) {} catch {}
    }

    // ------------------------------------------------------------------ time

    function warp(uint256 secs) public {
        secs = bound(secs, 1 hours, 3 days);
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    function warpEpochs(uint256 n) public {
        n = bound(n, 1, 500);
        vm.warp(vm.getBlockTimestamp() + n * E);
    }

    // ------------------------------------------------------------------ OWNER (decision #29)

    /// @dev Part or all (seed 0 mod 4) of the physical BNB, to a treasury outside the actor set.
    function ownerWithdrawBnb(uint256 seed) public {
        uint256 bal = address(bridge).balance;
        if (bal == 0) return;
        uint256 amount = seed % 4 == 0 ? 0 : bound(seed, 1, bal);
        vm.prank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), amount);
    }

    /// @dev Part or all of the physical BAC — deposits and buyback bucket alike. Biased towards
    ///      the case that matters for requirement 5: the bought-back part (or half of it) gone,
    ///      the deposits still sitting right there for a careless exit to dip into.
    function ownerWithdrawBac(uint256 seed) public {
        uint256 bal = bac.balanceOf(address(bridge));
        if (bal == 0) return;
        uint256 held = bridge.lockedBac() - bridge.totalBurned();
        uint256 surplus = bal > held ? bal - held : 0;
        uint256 mode = seed % 5;
        uint256 amount;
        if (mode == 0) amount = 0; // everything
        else if (mode == 1) amount = surplus; // exactly the payout part
        else if (mode == 2) amount = surplus / 2;
        else amount = bound(seed, 1, bal);
        if (amount == 0 && mode != 0) return;
        vm.prank(owner);
        bridge.emergencyWithdrawToken(address(bac), treasury, amount);
    }

    /// @dev Requirement 5 under pressure: the owner takes exactly the bought-back part (or half
    ///      of it), leaving the deposits in place, and then every payout path is tried by every
    ///      actor. Each success is checked against the unburned deposits.
    function ownerTakesPayoutThenExitsTry(uint256 seed) public {
        uint256 bal = bac.balanceOf(address(bridge));
        uint256 held = bridge.lockedBac() - bridge.totalBurned();
        uint256 surplus = bal > held ? bal - held : 0;
        uint256 amount = seed % 2 == 0 ? surplus : surplus / 2;
        if (amount != 0) {
            vm.prank(owner);
            bridge.emergencyWithdrawToken(address(bac), treasury, amount);
        }
        for (uint256 i = 0; i < ACTORS; i++) {
            collect(i);
            claimOwedAfterHalt(i);
            escapeCollect(i);
        }
    }

    /// @dev The owner sends BAC back with a plain transfer, then anyone sweeps.
    function ownerRefillBac(uint256 amount) public {
        uint256 held = bac.balanceOf(treasury);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(treasury);
        bac.transfer(address(bridge), amount);
        gBacDonated += amount;
        gBacRefilled += amount;
        _sweepBac();
    }

    /// @dev Upgrade to V2 or back to V1, and check that no book moved across it.
    function ownerUpgrade() public {
        address next = _implNow() == implV1 ? implV2 : implV1;
        bytes32 before = _bookHash();
        vm.prank(owner);
        bridge.upgradeTo(next);
        gUpgrades++;
        if (_bookHash() != before) gUpgradeMovedState = true;
    }

    function _implNow() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(bridge), IMPL_SLOT))));
    }

    function _bookHash() internal view returns (bytes32) {
        bytes memory a = abi.encode(
            bridge.bnbBalance(),
            bridge.lockedBac(),
            bridge.buybackBac(),
            bridge.owedTotal(),
            bridge.reservedTotal(),
            bridge.accPerOwed(),
            bridge.totalCreditsIssued(),
            bridge.totalCreditsExited(),
            bridge.totalBurned(),
            bridge.buybackBudget()
        );
        bytes memory b = abi.encode(
            bridge.lastSettledEpoch(),
            bridge.isHalted(),
            bridge.escapeTotalWeight(),
            bridge.accPerWeightBac(),
            bridge.accPerWeightBnb(),
            bridge.emergencyBnbWithdrawn(),
            bridge.emergencyBacWithdrawn(),
            bridge.depositId(),
            bridge.owner()
        );
        return keccak256(abi.encode(a, b));
    }
}

/// @notice Invariants B1-B14 of docs/01-CONTRACT-SPEC.md §4.3, plus B15/B17 where they are cheap,
///         plus the bucket separation that decision #24a② calls non-negotiable. The owner never
///         acts in this suite (see `BacBridgeOwnerInvariantTest` for that), so every statement
///         here is the strict, pre-#29 one.
contract BacBridgeInvariantTest is Test {
    BacBridge internal bridge;
    MockBAC internal bac;
    MockErc8004 internal identity;
    MockAnchor internal anchor;
    MockPortal internal portal;
    MockRouter internal router;
    BridgeHandler internal handler;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal watchdog = makeAddr("watchdog");
    address internal vetoKey = makeAddr("vetoKey");
    address internal owner = makeAddr("owner");

    function setUp() public {
        vm.warp(1_800_000_000);
        bac = new MockBAC();
        identity = new MockErc8004();
        anchor = new MockAnchor(vetoKey);
        portal = new MockPortal();
        router = new MockRouter(portal);
        bridge = deployBacBridge(
            new BacBridge(),
            owner,
            address(bac),
            address(identity),
            address(anchor),
            watchdog,
            address(portal),
            address(router)
        );

        address[4] memory actors = [makeAddr("a1"), makeAddr("a2"), makeAddr("a3"), makeAddr("a4")];
        for (uint256 i = 0; i < 4; i++) {
            identity.mint(i + 1, actors[i]);
        }

        handler = new BridgeHandler(bridge, bac, identity, anchor, portal, router, actors);

        bytes4[] memory selectors = new bytes4[](24);
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
        selectors[19] = BridgeHandler.buyback.selector;
        selectors[20] = BridgeHandler.donateBac.selector;
        selectors[21] = BridgeHandler.revokeEpochOwed.selector;
        selectors[22] = BridgeHandler.setController.selector;
        selectors[23] = BridgeHandler.exitCycle.selector;

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

    /// The solvency invariant, now structural: debt and asset are the same unit, so no price move
    /// can break it. Everything else is a detail next to this one.
    function invariant_B1_OwedNeverExceedsTheBuybackBucket() public view {
        assertLe(bridge.owedTotal(), bridge.buybackBac(), "B1: owedTotal > buybackBac");
    }

    // ================================================================== B2

    function invariant_B2_BalancesCoverTheBooks() public view {
        assertGe(address(bridge).balance, bridge.bnbBalance(), "B2: real BNB balance below the book");
        assertGe(bac.balanceOf(address(bridge)), bridge.bacAccounted(), "B2: real BAC balance below the book");
    }

    // ================================================================== two buckets

    /// Decision #24a②, the whole point of the redesign. Two statements:
    ///   1. the BAC balance is EXACTLY the two buckets minus what was burned, and
    ///   2. every wei ever paid to an exiting address came out of the buyback bucket — the total
    ///      paid out can never exceed the total that was ever bought back or donated.
    function invariant_Buckets_ExitsAreNeverPaidFromDeposits() public view {
        assertEq(
            bac.balanceOf(address(bridge)),
            bridge.lockedBac() + bridge.buybackBac() - bridge.totalBurned(),
            "buckets: balance != lockedBac + buybackBac - burned"
        );
        assertLe(
            handler.gBacPaidOut(), handler.gBacIntoBuyback(), "buckets: more BAC was paid out than was ever bought back"
        );
        // credits are minted 1:1 with the measured deposit, so this is the deposit bucket's
        // independent witness: if a single wei of `lockedBac` came from anywhere but `lock`,
        // or a payout ever reduced it, the two numbers part company.
        assertEq(bridge.lockedBac(), bridge.totalCreditsIssued(), "buckets: lockedBac != credits ever issued");
        assertFalse(handler.gBuybackTouchedDeposits(), "buckets: a market path moved lockedBac");
        assertFalse(handler.gExitDippedIntoDeposits(), "buckets: an exit payout left less than the deposits");
    }

    /// The deposit bucket is always physically present: what has not been burned is still here.
    function invariant_Buckets_DepositsAreStillHeld() public view {
        assertLe(bridge.totalBurned(), bridge.lockedBac(), "a burn exceeded the deposits");
        assertGe(
            bac.balanceOf(address(bridge)),
            bridge.lockedBac() - bridge.totalBurned(),
            "part of the deposit bucket has left the contract"
        );
    }

    // ================================================================== B3

    /// Reserved BAC is exactly the sum of what addresses may still harvest, up to rounding dust.
    /// Only meaningful before a halt: `_halt` voids every reservation by design.
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
        assertLe(handler.gBnbOut(), handler.gBnbIn(), "B5: paid out more BNB than ever came in");
        assertLe(handler.gBacPaidOut(), handler.gBacIntoBuyback(), "B5: paid out more BAC than ever came in");
    }

    // ================================================================== B6 / B7

    function invariant_B6_BacBooksAreExact() public view {
        assertEq(bridge.bacAccounted(), bridge.lockedBac() - bridge.totalBurned() + bridge.buybackBac(), "B6");
        assertEq(bac.balanceOf(address(bridge)), bridge.bacAccounted(), "B6");
    }

    function invariant_B7_BurnOnlyEverReachesDead() public view {
        assertEq(bac.balanceOf(DEAD), bridge.totalBurned(), "B7: dead address holds something else");
        uint256 actorsHold;
        for (uint256 i = 0; i < 4; i++) {
            actorsHold += bac.balanceOf(handler.actorAt(i));
        }
        // every BAC in existence is with an actor, on the bridge's books, or burned. Actors may
        // now legitimately hold BAC: that is what an exit pays them.
        assertEq(
            actorsHold + bac.balanceOf(address(bridge)) + bac.balanceOf(DEAD),
            bac.totalSupply(),
            "B7: BAC reached a third party"
        );
    }

    // ================================================================== B8

    function invariant_B8_PrivilegedRolesStayPoor() public view {
        assertEq(watchdog.balance, 0, "B8: watchdog received BNB");
        assertEq(vetoKey.balance, 0, "B8: veto key received BNB");
        assertEq(bac.balanceOf(watchdog), 0, "B8: watchdog received BAC");
        assertEq(bac.balanceOf(vetoKey), 0, "B8: veto key received BAC");
        // the owner never acts in this suite, so nothing may ever have reached it either
        assertEq(owner.balance, 0, "B8: owner received BNB without acting");
        assertEq(bac.balanceOf(owner), 0, "B8: owner received BAC without acting");
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

    function invariant_B12_PostHaltPayoutsAreBounded() public view {
        if (!handler.gHaltRecorded()) return;
        assertLe(
            handler.gBacPaidAfterHalt(),
            handler.gJuniorBacAtHalt() + handler.gOwedAtHalt() + handler.gBacIntoBuyback(),
            "B12: post-halt BAC payouts exceeded the pot they can come from"
        );
        assertLe(
            handler.gBnbOutAfterHalt(),
            handler.gJuniorBnbAtHalt() + handler.gBnbInAfterHalt(),
            "B12: post-halt BNB payouts exceeded the pot they can come from"
        );
    }

    // ================================================================== B13

    function invariant_B13_ZeroWeightMeansZeroAccumulators() public view {
        if (bridge.escapeTotalWeight() == 0) {
            assertEq(bridge.accPerWeightBac(), 0, "B13: junior BAC accumulator moved with zero weight");
            assertEq(bridge.accPerWeightBnb(), 0, "B13: junior BNB accumulator moved with zero weight");
        }
    }

    // ================================================================== B14

    function invariant_B14_ReservedNeverRatchets() public view {
        assertLe(bridge.reservedTotal(), bridge.owedTotal(), "B14: reservation ratcheted past the debt");
    }

    // ================================================================== extras

    /// B15: nobody gets more than `lastPot * 10%` per elapsed epoch out of `collect`.
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

    /// The BNB bucket is only ever spent on the market or on a junior escape claim, and the
    /// accrued budget can never promise more than the bucket holds.
    function invariant_BuybackBudgetIsBounded() public view {
        assertLe(bridge.buybackBudget(), bridge.bnbBalance(), "buyback budget exceeds the BNB bucket");
        assertLe(bridge.buybackBnbSpent(), handler.gBnbIn(), "spent more BNB on the market than ever arrived");
    }

    // ================================================================== decision #29, owner idle

    /// Without an owner action nothing is ever missing and no owner counter ever moves.
    function invariant_NoOwnerActionNoShortfall() public view {
        (uint256 bnbShort, uint256 bacShort) = bridge.shortfall();
        assertEq(bnbShort, 0, "BNB shortfall without an emergency withdrawal");
        assertEq(bacShort, 0, "BAC shortfall without an emergency withdrawal");
        assertEq(bridge.emergencyBnbWithdrawn() + bridge.emergencyBacWithdrawn(), 0);
        assertEq(uint256(bridge.emergencyCount()), 0);
        assertEq(uint256(bridge.upgradeCount()), 0);
    }

    /// The BNB book is exactly what came in minus what left through the two legal exits.
    function invariant_BnbBookIsExact() public view {
        assertEq(
            bridge.bnbBalance(),
            handler.gBnbIn() - handler.gBnbOut() - bridge.buybackBnbSpent(),
            "bnbBalance drifted from its inflows and outflows"
        );
    }

    /// Requirement 2: the permissionless sweeps never revert, and buyback only on its slippage bound.
    function invariant_NothingPermissionlessBricks() public view {
        assertFalse(handler.gSweepReverted(), "a sweep reverted");
        assertFalse(handler.gBuybackBricked(), "buyback reverted outside its slippage bound");
    }
}

/// @notice The same handler with the OWNER let loose (decision #29): emergency withdrawals of
///         BNB and BAC — partial and total, at any time, halted or not — refills, and upgrades
///         to a V2 and back. Owner paths are exempt from the bucket promises by design; what this
///         suite proves is that they are EXEMPT AND ACCOUNTED, and that every NON-owner path
///         still behaves: no exit is ever paid out of `lockedBac`, the books are never written
///         down behind anyone's back, `shortfall()` is exactly book minus balance and never more
///         than the owner took, nothing permissionless reverts where it must not, and an upgrade
///         moves no book.
contract BacBridgeOwnerInvariantTest is Test {
    BacBridge internal bridge;
    MockBAC internal bac;
    MockErc8004 internal identity;
    MockAnchor internal anchor;
    MockPortal internal portal;
    MockRouter internal router;
    BridgeHandler internal handler;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal watchdog = makeAddr("watchdog");
    address internal vetoKey = makeAddr("vetoKey");
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_800_000_000);
        bac = new MockBAC();
        identity = new MockErc8004();
        anchor = new MockAnchor(vetoKey);
        portal = new MockPortal();
        router = new MockRouter(portal);
        BacBridge v1 = new BacBridge();
        BacBridgeV2Mock v2 = new BacBridgeV2Mock();
        bridge = deployBacBridge(
            v1, owner, address(bac), address(identity), address(anchor), watchdog, address(portal), address(router)
        );

        address[4] memory actors = [makeAddr("a1"), makeAddr("a2"), makeAddr("a3"), makeAddr("a4")];
        for (uint256 i = 0; i < 4; i++) {
            identity.mint(i + 1, actors[i]);
        }

        handler = new BridgeHandler(bridge, bac, identity, anchor, portal, router, actors);
        handler.setOwnerTools(owner, treasury, address(v1), address(v2));

        bytes4[] memory selectors = new bytes4[](24);
        selectors[0] = BridgeHandler.lock.selector;
        selectors[1] = BridgeHandler.release.selector;
        selectors[2] = BridgeHandler.forcePushAndSweep.selector;
        selectors[3] = BridgeHandler.burn.selector;
        selectors[4] = BridgeHandler.claimExit.selector;
        selectors[5] = BridgeHandler.settle.selector;
        selectors[6] = BridgeHandler.collect.selector;
        selectors[7] = BridgeHandler.pause.selector;
        selectors[8] = BridgeHandler.unpause.selector;
        selectors[9] = BridgeHandler.setHaltReason.selector;
        selectors[10] = BridgeHandler.armEscape.selector;
        selectors[11] = BridgeHandler.checkHalt.selector;
        selectors[12] = BridgeHandler.claimOwedAfterHalt.selector;
        selectors[13] = BridgeHandler.escapeCollect.selector;
        selectors[14] = BridgeHandler.warpEpochs.selector;
        selectors[15] = BridgeHandler.buyback.selector;
        selectors[16] = BridgeHandler.donateBac.selector;
        selectors[17] = BridgeHandler.setController.selector;
        selectors[18] = BridgeHandler.ownerWithdrawBnb.selector;
        selectors[19] = BridgeHandler.ownerWithdrawBac.selector;
        selectors[20] = BridgeHandler.ownerRefillBac.selector;
        selectors[21] = BridgeHandler.ownerUpgrade.selector;
        selectors[22] = BridgeHandler.exitCycle.selector;
        selectors[23] = BridgeHandler.ownerTakesPayoutThenExitsTry.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// B1 is a statement about the books, so the owner cannot break it: nothing is written down.
    function invariant_Owner_B1_OwedNeverExceedsTheBuybackBucket() public view {
        assertLe(bridge.owedTotal(), bridge.buybackBac(), "B1: owedTotal > buybackBac");
    }

    /// The owner's BNB take is accounted to the wei: physical + withdrawn == book + unbooked
    /// force-sends, the book itself is never written down, and the counter is what left.
    function invariant_Owner_BnbIsExactlyAccounted() public view {
        assertEq(
            address(bridge).balance + bridge.emergencyBnbWithdrawn(),
            bridge.bnbBalance() + (handler.gBnbForced() - handler.gBnbSwept()),
            "BNB: balance + owner take != book + unbooked force-sends"
        );
        assertEq(
            bridge.bnbBalance(),
            handler.gBnbIn() - handler.gBnbOut() - bridge.buybackBnbSpent(),
            "an owner withdrawal wrote the BNB book down"
        );
        assertEq(treasury.balance, bridge.emergencyBnbWithdrawn(), "the BNB counter must equal what left");
    }

    /// The same for BAC: physical + withdrawn == book + unbooked refills and donations.
    function invariant_Owner_BacIsExactlyAccounted() public view {
        assertEq(
            bac.balanceOf(address(bridge)) + bridge.emergencyBacWithdrawn(),
            bridge.bacAccounted() + (handler.gBacDonated() - handler.gBacSwept()),
            "BAC: balance + owner take != book + unbooked refills"
        );
        assertEq(
            bac.balanceOf(treasury) + handler.gBacRefilled(),
            bridge.emergencyBacWithdrawn(),
            "the BAC counter must equal what left"
        );
    }

    /// `shortfall()` is exactly the book minus the physical balance, per asset, and never more
    /// than what the owner took.
    function invariant_Owner_ShortfallIsExact() public view {
        (uint256 bnbShort, uint256 bacShort) = bridge.shortfall();
        uint256 bal = address(bridge).balance;
        assertEq(bnbShort, bridge.bnbBalance() > bal ? bridge.bnbBalance() - bal : 0, "bnbShort");
        uint256 bacBal = bac.balanceOf(address(bridge));
        uint256 book = bridge.bacAccounted();
        assertEq(bacShort, book > bacBal ? book - bacBal : 0, "bacShort");
        assertLe(bnbShort, bridge.emergencyBnbWithdrawn(), "a BNB hole nobody dug");
        assertLe(bacShort, bridge.emergencyBacWithdrawn(), "a BAC hole nobody dug");
    }

    /// Decision #24a② for every NON-owner path, with the owner active: payouts only ever come out
    /// of bought-back BAC, never out of the unburned deposits, and nothing but `lock` moves
    /// `lockedBac`.
    function invariant_Owner_NonOwnerPathsKeepTheBuckets() public view {
        assertFalse(handler.gExitDippedIntoDeposits(), "an exit was paid out of lockedBac");
        assertLe(handler.gBacPaidOut(), handler.gBacIntoBuyback(), "more BAC paid out than ever bought back");
        assertEq(bridge.lockedBac(), bridge.totalCreditsIssued(), "lockedBac moved by something other than lock");
        assertFalse(handler.gBuybackTouchedDeposits(), "a market path moved lockedBac");
        assertLe(bridge.totalBurned(), bridge.lockedBac(), "a burn exceeded the deposits");
        assertEq(bac.balanceOf(DEAD), bridge.totalBurned(), "the burn reached something other than DEAD");
    }

    /// Requirement 2: after any owner withdrawal the permissionless paths still skip or refuse
    /// cleanly — the sweeps never revert, buyback reverts only on its slippage bound.
    function invariant_Owner_NothingPermissionlessBricks() public view {
        assertFalse(handler.gSweepReverted(), "a sweep reverted (underflow after a withdrawal?)");
        assertFalse(handler.gBuybackBricked(), "buyback reverted outside its slippage bound");
    }

    /// Decision #29c: every upgrade is counted, and none of them moves a book.
    function invariant_Owner_UpgradesAreCountedAndMoveNoBook() public view {
        assertEq(uint256(bridge.upgradeCount()), handler.gUpgrades(), "an upgrade was not counted");
        assertFalse(handler.gUpgradeMovedState(), "an upgrade moved a book");
        assertEq(bridge.owner(), owner, "ownership changed hands");
    }

    /// Credits and escape weights are pure book-keeping: B4 / B11 / B13 / B14 hold regardless.
    function invariant_Owner_CreditAndEscapeBooks() public view {
        assertLe(bridge.totalCreditsExited(), bridge.totalCreditsIssued(), "B4");
        uint256 creditedSum;
        for (uint256 i = 1; i <= 4; i++) {
            assertLe(bridge.exitedCredits(i), bridge.credited(i), "B11");
            creditedSum += bridge.credited(i);
        }
        assertEq(creditedSum, bridge.totalCreditsIssued(), "B4");
        if (bridge.escapeTotalWeight() == 0) {
            assertEq(bridge.accPerWeightBac(), 0, "B13");
            assertEq(bridge.accPerWeightBnb(), 0, "B13");
        }
        assertLe(bridge.reservedTotal(), bridge.owedTotal(), "B14");
        assertLe(bridge.buybackBudget(), bridge.bnbBalance(), "budget above the book");
    }

    /// B7 with the owner in the picture: every BAC is with an actor, the bridge, the owner's
    /// treasury, or dead — and the two non-owner roles never received a wei.
    function invariant_Owner_B7_BacConservedAndRolesStayPoor() public view {
        uint256 actorsHold;
        for (uint256 i = 0; i < 4; i++) {
            actorsHold += bac.balanceOf(handler.actorAt(i));
        }
        assertEq(
            actorsHold + bac.balanceOf(address(bridge)) + bac.balanceOf(DEAD) + bac.balanceOf(treasury),
            bac.totalSupply(),
            "B7: BAC reached a third party"
        );
        assertEq(bac.balanceOf(watchdog) + bac.balanceOf(vetoKey), 0, "B8");
        assertEq(watchdog.balance + vetoKey.balance, 0, "B8");
    }
}
