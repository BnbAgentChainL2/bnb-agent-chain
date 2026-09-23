// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol";

import {BacTaxRouter} from "../src/BacTaxRouter.sol";

/* -------------------------------------------------------------------------- */
/*                                   mocks                                    */
/* -------------------------------------------------------------------------- */

/// @dev Stands in for `BacBridge` / `BacNodeFund`: `bacToken()` for the constructor cross-check
///      and a switchable `acceptRelease()` so a push failure can be replayed on demand.
contract MockReleaseTarget {
    address public bacToken;
    bool public rejecting;
    bool public burning;
    uint256 public lifetimeReceived;
    uint256 public sink;

    constructor(address bacToken_) {
        bacToken = bacToken_;
    }

    function setRejecting(bool v) external {
        rejecting = v;
    }

    /// @dev Burns every wei of gas it is handed instead of reverting cleanly — the "downstream is
    ///      in an infinite loop" case, which must still be booked as a failed push and not take
    ///      the whole `settle()` down with it.
    function setBurning(bool v) external {
        burning = v;
    }

    function acceptRelease() external payable {
        require(!rejecting, "target rejects");
        if (burning) {
            // solhint-disable-next-line no-empty-blocks
            while (true) {
                sink++;
            }
        }
        lifetimeReceived += msg.value;
    }
}

/// @dev Pays part of the push straight back into the router's `receive()` while the push call is
///      still open — the case the "never cache the baseline across an external call" rule is for.
contract MockBouncingTarget {
    address public bacToken;
    uint256 public bounceBps;

    constructor(address bacToken_, uint256 bounceBps_) {
        bacToken = bacToken_;
        bounceBps = bounceBps_;
    }

    function acceptRelease() external payable {
        uint256 back = (msg.value * bounceBps) / 10000;
        if (back != 0) {
            (bool ok,) = msg.sender.call{value: back}("");
            require(ok, "bounce failed");
        }
    }
}

/// @dev Calls back into `settle()` from inside the push. Must hit the reentrancy guard and make
///      the push fail cleanly (booked into `stuck*`), never double-split.
contract MockReenteringTarget {
    address public bacToken;
    BacTaxRouter public router;

    constructor(address bacToken_) {
        bacToken = bacToken_;
    }

    function setRouter(BacTaxRouter r) external {
        router = r;
    }

    function acceptRelease() external payable {
        router.settle();
    }
}

/// @dev Decision #29 made `BacBridge` an implementation behind an OpenZeppelin `ERC1967Proxy`: its
///      wiring lives in PROXY storage, written once by `initialize`, and the implementation's own
///      constructor disables initializers. This stand-in has exactly that shape, plus an
///      `acceptRelease()` that writes two slots like the bridge's post-halt path, so the router can
///      be tested against the address it will really be handed — the proxy.
contract MockBridgeImpl is Initializable {
    address public bacToken;
    uint256 public bnbBalance;
    uint256 public releases;

    constructor() {
        _disableInitializers();
    }

    function initialize(address bacToken_) external initializer {
        bacToken = bacToken_;
    }

    function acceptRelease() external payable {
        bnbBalance += msg.value;
        releases += 1;
    }
}

/// @dev Has code, but no `bacToken()`.
contract MockNoBacToken {
    uint256 public x;
}

/// @dev `bacToken()` answers a different token.
contract MockWrongToken {
    function bacToken() external pure returns (address) {
        return address(0xBAD);
    }
}

/* -------------------------------------------------------------------------- */
/*                                   tests                                    */
/* -------------------------------------------------------------------------- */

contract BacTaxRouterTest is Test {
    address internal constant TOKEN = address(0x7777);
    address internal constant STRANGER = address(0xDEAD1);

    BacTaxRouter internal router;
    MockReleaseTarget internal bridge;
    MockReleaseTarget internal nodeFund;

    event RevenueRecognized(address indexed from, uint256 amount);
    event RevenueSplit(uint256 toBridge, uint256 toNodeFund);
    event PushSucceeded(address indexed to, uint256 amount);
    event PushFailed(address indexed to, uint256 amount);

    function setUp() public {
        bridge = new MockReleaseTarget(TOKEN);
        nodeFund = new MockReleaseTarget(TOKEN);
        router = new BacTaxRouter(TOKEN, address(bridge), address(nodeFund));
        vm.deal(address(this), 10_000 ether);
    }

    /* ---------------------------------------------------------------- */
    /*                             invariants                            */
    /* ---------------------------------------------------------------- */

    /// @dev The three properties that must hold after every single call in this file.
    function _assertSolvent() internal view {
        (uint256 bal, uint256 accounted, uint256 buckets) = router.solvency();
        assertEq(accounted, buckets, "V1: accountedQuote != unsplit + stuck");
        assertGe(bal, accounted, "V2: balance < accountedQuote");
        assertEq(
            router.totalRecognized(),
            router.lifetimeToBridge() + router.lifetimeToNodeFund() + router.accountedQuote(),
            "V9: totalRecognized != pushed out + still held"
        );
        assertEq(
            bridge.lifetimeReceived() + nodeFund.lifetimeReceived(),
            router.lifetimeToBridge() + router.lifetimeToNodeFund(),
            "V3: what the targets received != what the router booked as sent"
        );
    }

    /* ---------------------------------------------------------------- */
    /*                            construction                           */
    /* ---------------------------------------------------------------- */

    function test_constructor_wiring() public view {
        assertEq(router.bacToken(), TOKEN, "bacToken");
        assertEq(router.bridge(), address(bridge), "bridge");
        assertEq(router.nodeFund(), address(nodeFund), "nodeFund");
        assertEq(router.BRIDGE_BPS(), 5000, "the split is 50/50 and has no setter");
        assertEq(router.BPS(), 10000, "BPS");
        assertEq(router.PUSH_GAS(), 100_000, "PUSH_GAS");
        assertEq(router.accountedQuote(), 0, "starts empty");
        assertEq(router.unsplitRevenue(), 0, "starts empty");
        assertEq(address(router).balance, 0, "starts empty");
    }

    function test_constructor_rejectsBadWiring() public {
        vm.expectRevert(bytes(unicode"Zero BAC token / BAC 代币地址为零"));
        new BacTaxRouter(address(0), address(bridge), address(nodeFund));

        vm.expectRevert(bytes(unicode"Zero address / 地址为零"));
        new BacTaxRouter(TOKEN, address(0), address(nodeFund));

        vm.expectRevert(bytes(unicode"Zero address / 地址为零"));
        new BacTaxRouter(TOKEN, address(bridge), address(0));

        vm.expectRevert(bytes(unicode"Bridge and node fund must differ / 桥与节点基金不能是同一个地址"));
        new BacTaxRouter(TOKEN, address(bridge), address(bridge));

        vm.expectRevert(bytes(unicode"Bridge has no code / 桥地址没有代码"));
        new BacTaxRouter(TOKEN, address(0xE0A), address(nodeFund));

        vm.expectRevert(bytes(unicode"Node fund has no code / 节点基金地址没有代码"));
        new BacTaxRouter(TOKEN, address(bridge), address(0xE0A));

        MockNoBacToken blind = new MockNoBacToken();
        vm.expectRevert(bytes(unicode"Target has no bacToken() / 目标合约没有 bacToken()"));
        new BacTaxRouter(TOKEN, address(blind), address(nodeFund));

        // Both downstreams must already be pinned to the very token we are about to launch. Flap
        // accepts any beneficiary unchecked and it cannot be changed after launch, so this
        // constructor is the only place a mis-wired router can still be stopped.
        MockWrongToken wrong = new MockWrongToken();
        vm.expectRevert(bytes(unicode"BacBridge.bacToken() mismatch / 桥绑定的代币不是 T"));
        new BacTaxRouter(TOKEN, address(wrong), address(nodeFund));

        vm.expectRevert(bytes(unicode"BacNodeFund.bacToken() mismatch / 节点基金绑定的代币不是 T"));
        new BacTaxRouter(TOKEN, address(bridge), address(wrong));
    }

    /// @notice Decision #29: the bridge the router is wired to is an ERC1967 proxy. The constructor's
    ///         `bacToken()` cross-check has to read the PROXY's storage, a push has to clear the
    ///         proxy's extra implementation-slot read and DELEGATECALL inside `PUSH_GAS`, and the bare
    ///         implementation — whose own storage is empty — has to be refused outright.
    function test_bridgeBehindAnErc1967Proxy() public {
        MockBridgeImpl impl = new MockBridgeImpl();
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(MockBridgeImpl.initialize, (TOKEN)));
        MockBridgeImpl viaProxy = MockBridgeImpl(address(proxy));
        assertEq(viaProxy.bacToken(), TOKEN, "the wiring lives in proxy storage");
        assertEq(impl.bacToken(), address(0), "the implementation's own storage is empty");

        vm.expectRevert(bytes(unicode"BacBridge.bacToken() mismatch / 桥绑定的代币不是 T"));
        new BacTaxRouter(TOKEN, address(impl), address(nodeFund));

        BacTaxRouter r = new BacTaxRouter(TOKEN, address(proxy), address(nodeFund));
        assertEq(r.bridge(), address(proxy), "wired to the proxy");

        (bool ok,) = address(r).call{value: 10 ether}("");
        assertTrue(ok);
        vm.expectEmit(true, true, true, true, address(r));
        emit PushSucceeded(address(proxy), 5 ether);
        r.settle();

        (uint256 sb, uint256 sn) = r.stuckAmounts();
        assertEq(sb, 0, "the push through the proxy fits PUSH_GAS");
        assertEq(sn, 0, "node fund half delivered");
        assertEq(viaProxy.bnbBalance(), 5 ether, "booked in the proxy's storage");
        assertEq(viaProxy.releases(), 1, "one release");
        assertEq(address(proxy).balance, 5 ether, "the BNB sits at the proxy address");
        assertEq(address(impl).balance, 0, "and never at the implementation");
        assertEq(r.lifetimeToBridge(), 5 ether, "booked as sent");
    }

    /* ---------------------------------------------------------------- */
    /*                     the 50,000-gas dispatch ping                  */
    /* ---------------------------------------------------------------- */

    /// @notice The single most expensive thing in this contract to get wrong. `TaxProcessor.dispatch`
    ///         pays the beneficiary inside `call{gas: 50_000}`; if `receive()` reverts or runs out,
    ///         that dispatch's share is forfeited permanently and is never retried.
    function test_receive_succeedsUnder50kGas() public {
        uint256 g = gasleft();
        (bool ok,) = address(router).call{value: 1 ether, gas: 50_000}("");
        uint256 coldUsed = g - gasleft();
        assertTrue(ok, "receive() must succeed under call{gas: 50_000}");
        assertLt(coldUsed, 50_000, "cold receive() over the 50,000-gas budget");

        g = gasleft();
        (ok,) = address(router).call{value: 1 ether, gas: 50_000}("");
        uint256 warmUsed = g - gasleft();
        assertTrue(ok, "warm receive() must succeed under call{gas: 50_000}");
        assertLt(warmUsed, 30_000, "warm receive() over the 30,000-gas budget");

        assertEq(router.accountedQuote(), 2 ether, "both sends recognized");
        assertEq(router.unsplitRevenue(), 2 ether, "both sends booked as unsplit");
        _assertSolvent();

        // research 12 §5.3: the router may not be more expensive than the tax recipient it
        // replaced, whose cold receive() was measured at 45,365 gas.
        assertLe(coldUsed, 45_365, "cold receive() over the 45,365-gas ceiling of research 12 section 5.3");

        emit log_named_uint("GAS receive() cold (first payment ever, zero -> non-zero SSTORE)", coldUsed);
        emit log_named_uint("GAS receive() warm", warmUsed);
        emit log_named_uint("ceiling (research 12 section 5.3)", 45_365);
    }

    /// @dev The same ping through `acceptRelease()`, the calling convention `BacBridge` and
    ///      `BacNodeFund` share, so anything that pays a "release" into any BAC contract uses one
    ///      name.
    function test_acceptRelease_recognizesAndIsCheap() public {
        uint256 g = gasleft();
        (bool ok,) = address(router).call{value: 1 ether, gas: 50_000}(abi.encodeWithSignature("acceptRelease()"));
        uint256 used = g - gasleft();
        assertTrue(ok, "acceptRelease() must succeed under call{gas: 50_000}");
        assertEq(router.unsplitRevenue(), 1 ether, "acceptRelease did not recognize");
        _assertSolvent();
        emit log_named_uint("GAS acceptRelease() cold", used);
    }

    /// @dev `receive()` must never revert, whatever the state. Zero-value wakes included.
    function test_receive_neverReverts() public {
        (bool ok,) = address(router).call{value: 0}("");
        assertTrue(ok, "a zero-value wake must not revert");
        assertEq(router.accountedQuote(), 0, "a zero delta books nothing");

        (ok,) = address(router).call{value: 1 wei}("");
        assertTrue(ok, "1 wei must not revert");

        router.settle();
        (ok,) = address(router).call{value: 1 wei}("");
        assertTrue(ok, "a wake after a settle must not revert");
        _assertSolvent();
    }

    /* ---------------------------------------------------------------- */
    /*                          split arithmetic                         */
    /* ---------------------------------------------------------------- */

    function test_settle_splits5050() public {
        (bool ok,) = address(router).call{value: 10 ether}("");
        assertTrue(ok);

        vm.expectEmit(true, true, true, true, address(router));
        emit RevenueSplit(5 ether, 5 ether);
        vm.prank(STRANGER); // permissionless
        (uint256 toBridge, uint256 toNodeFund) = router.settle();

        assertEq(toBridge, 5 ether, "bridge half");
        assertEq(toNodeFund, 5 ether, "node fund half");
        assertEq(bridge.lifetimeReceived(), 5 ether, "bridge received");
        assertEq(nodeFund.lifetimeReceived(), 5 ether, "node fund received");
        assertEq(address(router).balance, 0, "the router holds nothing at rest");
        assertEq(router.accountedQuote(), 0, "everything pushed");
        assertEq(router.unsplitRevenue(), 0, "nothing left unsplit");
        assertEq(router.lifetimeToBridge(), 5 ether, "lifetimeToBridge");
        assertEq(router.lifetimeToNodeFund(), 5 ether, "lifetimeToNodeFund");
        assertEq(router.totalRecognized(), 10 ether, "totalRecognized");
        _assertSolvent();
    }

    /// @notice The rounding remainder. An odd wei cannot be halved, and the extra wei must land in
    ///         the bridge pool every single time — never in the half the project can withdraw.
    function test_settle_oddWeiRemainderGoesToTheBridge() public {
        (bool ok,) = address(router).call{value: 3 wei}("");
        assertTrue(ok);
        (uint256 toBridge, uint256 toNodeFund) = router.settle();
        assertEq(toNodeFund, 1 wei, "node fund gets floor(50%)");
        assertEq(toBridge, 2 wei, "the remainder goes to the bridge pool");
        assertEq(toBridge + toNodeFund, 3 wei, "not a wei lost");
        _assertSolvent();
    }

    function test_settle_oneWei() public {
        (bool ok,) = address(router).call{value: 1 wei}("");
        assertTrue(ok);
        (uint256 toBridge, uint256 toNodeFund) = router.settle();
        assertEq(toNodeFund, 0, "floor(0.5 wei) = 0");
        assertEq(toBridge, 1 wei, "the whole wei goes to the bridge pool");
        _assertSolvent();
    }

    function testFuzz_settle_splitIsExactAndNeverFavoursTheNodeFund(uint96 amount) public {
        vm.assume(amount > 0);
        vm.deal(address(this), uint256(amount));
        (bool ok,) = address(router).call{value: uint256(amount)}("");
        assertTrue(ok);

        (uint256 toBridge, uint256 toNodeFund) = router.settle();
        assertEq(toBridge + toNodeFund, uint256(amount), "the split must not lose or invent a wei");
        assertEq(toNodeFund, uint256(amount) / 2, "node fund gets exactly floor(50%)");
        assertEq(toBridge, uint256(amount) - uint256(amount) / 2, "bridge gets the rest");
        assertGe(toBridge, toNodeFund, "the bridge half is never the smaller one");
        assertLe(toBridge - toNodeFund, 1, "the two halves differ by at most the 1-wei remainder");
        assertEq(address(router).balance, 0, "nothing kept");
        _assertSolvent();
    }

    /// @dev Accounting is incremental, never absolute: many small dispatches, one settle.
    function test_settle_accumulatesManyDispatches() public {
        uint256 total;
        for (uint256 i = 1; i <= 20; ++i) {
            (bool ok,) = address(router).call{value: i * 1 gwei}("");
            assertTrue(ok);
            total += i * 1 gwei;
        }
        assertEq(router.unsplitRevenue(), total, "every dispatch recognized");
        (uint256 toBridge, uint256 toNodeFund) = router.settle();
        assertEq(toBridge + toNodeFund, total, "one settle pays out everything accrued");
        _assertSolvent();

        // second round: the book must not re-count the first one
        (bool ok2,) = address(router).call{value: 7 ether}("");
        assertTrue(ok2);
        router.settle();
        assertEq(router.totalRecognized(), total + 7 ether, "totalRecognized across rounds");
        assertEq(router.lifetimeToBridge() + router.lifetimeToNodeFund(), total + 7 ether, "everything pushed");
        _assertSolvent();
    }

    function test_settle_isANoOpWhenThereIsNothing() public {
        (uint256 a, uint256 b) = router.settle();
        assertEq(a, 0, "nothing to send");
        assertEq(b, 0, "nothing to send");
        assertEq(router.totalRecognized(), 0, "nothing recognized");
        _assertSolvent();
    }

    function test_flush_isSettleUnderTheOtherName() public {
        (bool ok,) = address(router).call{value: 4 ether}("");
        assertTrue(ok);
        (uint256 toBridge, uint256 toNodeFund) = router.flush();
        assertEq(toBridge, 2 ether, "flush bridge half");
        assertEq(toNodeFund, 2 ether, "flush node fund half");
        assertEq(address(router).balance, 0, "flush pushes everything out");
        _assertSolvent();
    }

    /// @dev Force-pushed BNB (selfdestruct, coinbase, a transfer that landed before the code did)
    ///      is recognized by `sync()` and split like any other revenue.
    function test_sync_foldsForcedBalance() public {
        vm.deal(address(router), 8 ether); // no code ran: nothing is booked
        assertEq(router.accountedQuote(), 0, "a forced balance starts unbooked");
        (uint256 bal, uint256 accounted,) = router.solvency();
        assertEq(bal, 8 ether, "balance");
        assertEq(accounted, 0, "accounted");

        vm.prank(STRANGER);
        router.sync();
        assertEq(router.unsplitRevenue(), 8 ether, "sync folds the forced balance in");
        router.settle();
        assertEq(bridge.lifetimeReceived(), 4 ether, "forced balance split too");
        _assertSolvent();
    }

    /* ---------------------------------------------------------------- */
    /*                      push failure and retry                       */
    /* ---------------------------------------------------------------- */

    function test_push_failureIsBookedAndRetryable() public {
        (bool ok,) = address(router).call{value: 10 ether}("");
        assertTrue(ok);
        bridge.setRejecting(true);

        vm.expectEmit(true, true, true, true, address(router));
        emit PushFailed(address(bridge), 5 ether);
        router.settle();

        (uint256 sb, uint256 sn) = router.stuckAmounts();
        assertEq(sb, 5 ether, "the failed half is booked as stuck");
        assertEq(sn, 0, "the node fund half went out");
        assertEq(address(router).balance, 5 ether, "the money is still here, not lost");
        assertEq(router.accountedQuote(), 5 ether, "the baseline was put back");
        assertEq(router.lifetimeToBridge(), 0, "a failed push is not booked as sent");
        assertEq(nodeFund.lifetimeReceived(), 5 ether, "one side failing must not block the other");
        _assertSolvent();

        // a retry while the target is still rejecting must not double-book
        vm.prank(STRANGER);
        (uint256 sent,) = router.retryPush();
        assertEq(sent, 0, "nothing could be sent");
        (sb,) = router.stuckAmounts();
        assertEq(sb, 5 ether, "still exactly one stuck amount, not two");
        _assertSolvent();

        // ...and once the target recovers, anyone can push it through
        bridge.setRejecting(false);
        vm.prank(STRANGER);
        (sent,) = router.retryPush();
        assertEq(sent, 5 ether, "the retry delivered the whole stuck amount");
        (sb, sn) = router.stuckAmounts();
        assertEq(sb, 0, "nothing stuck any more");
        assertEq(sn, 0, "nothing stuck any more");
        assertEq(bridge.lifetimeReceived(), 5 ether, "the bridge got its half in the end");
        assertEq(address(router).balance, 0, "the router is empty again");
        assertEq(router.lifetimeToBridge(), 5 ether, "booked as sent only now");
        _assertSolvent();
    }

    function test_push_bothSidesCanFailAndBothRecover() public {
        (bool ok,) = address(router).call{value: 6 ether}("");
        assertTrue(ok);
        bridge.setRejecting(true);
        nodeFund.setRejecting(true);
        router.settle();

        (uint256 sb, uint256 sn) = router.stuckAmounts();
        assertEq(sb, 3 ether, "bridge stuck");
        assertEq(sn, 3 ether, "node fund stuck");
        assertEq(address(router).balance, 6 ether, "nothing left the contract");
        _assertSolvent();

        // a settle with fresh revenue while both are down: the old stuck amounts must not be lost
        (ok,) = address(router).call{value: 2 ether}("");
        assertTrue(ok);
        router.settle();
        (sb, sn) = router.stuckAmounts();
        assertEq(sb, 4 ether, "3 + 1");
        assertEq(sn, 4 ether, "3 + 1");
        _assertSolvent();

        bridge.setRejecting(false);
        nodeFund.setRejecting(false);
        (uint256 a, uint256 b) = router.retryPush();
        assertEq(a, 4 ether, "bridge retry");
        assertEq(b, 4 ether, "node fund retry");
        assertEq(address(router).balance, 0, "everything is out");
        _assertSolvent();
    }

    /// @dev A downstream that burns every wei of gas it is given must not take `settle()` down.
    ///      This is why the push is gas-capped at `PUSH_GAS` instead of forwarding everything.
    function test_push_survivesAGasBurningTarget() public {
        (bool ok,) = address(router).call{value: 4 ether}("");
        assertTrue(ok);
        bridge.setBurning(true);

        router.settle();
        (uint256 sb,) = router.stuckAmounts();
        assertEq(sb, 2 ether, "the gas burner's half is booked as stuck");
        assertEq(nodeFund.lifetimeReceived(), 2 ether, "the other half still went out");
        _assertSolvent();

        bridge.setBurning(false);
        router.retryPush();
        assertEq(bridge.lifetimeReceived(), 2 ether, "recovered");
        _assertSolvent();
    }

    /// @dev The griefing guard: calling `settle()` with too little gas must REVERT, not silently
    ///      book every payment into `stuck*` (which is what an out-of-gas push looks like from the
    ///      outside if you do not check `gasleft()` first).
    function test_settle_revertsRatherThanFakeAStuckPush() public {
        (bool ok,) = address(router).call{value: 4 ether}("");
        assertTrue(ok);

        (bool sent,) = address(router).call{gas: 90_000}(abi.encodeWithSignature("settle()"));
        assertFalse(sent, "a gas-starved settle must revert");

        (uint256 sb, uint256 sn) = router.stuckAmounts();
        assertEq(sb, 0, "nothing may be booked as stuck by a gas-starved call");
        assertEq(sn, 0, "nothing may be booked as stuck by a gas-starved call");
        assertEq(router.unsplitRevenue(), 4 ether, "the revenue is untouched");
        _assertSolvent();

        router.settle(); // with a normal gas budget it just works
        assertEq(bridge.lifetimeReceived(), 2 ether, "bridge half");
        _assertSolvent();
    }

    /* ---------------------------------------------------------------- */
    /*                    reentrancy / bounced payments                  */
    /* ---------------------------------------------------------------- */

    /// @dev A target that hands half the push straight back must not be able to make the router
    ///      double-count: the returned wei is recognized as NEW revenue exactly once.
    function test_push_bouncedPaymentIsRecognizedExactlyOnce() public {
        MockBouncingTarget bouncer = new MockBouncingTarget(TOKEN, 5000); // returns 50%
        BacTaxRouter r = new BacTaxRouter(TOKEN, address(bouncer), address(nodeFund));

        (bool ok,) = address(r).call{value: 8 ether}("");
        assertTrue(ok);
        r.settle();

        // 4 ETH was pushed to the bouncer, which sent 2 ETH back; 4 ETH went to the node fund.
        assertEq(address(r).balance, 2 ether, "the bounced half is sitting here");
        assertEq(r.accountedQuote(), 2 ether, "the bounce was recognized once");
        assertEq(r.unsplitRevenue(), 2 ether, "and is waiting to be split");
        assertEq(r.lifetimeToBridge(), 4 ether, "the push itself counted as sent");
        assertEq(r.lifetimeToNodeFund(), 4 ether, "node fund half");
        assertEq(r.totalRecognized(), 10 ether, "8 in + 2 bounced back = 10 recognized");

        (uint256 bal, uint256 accounted, uint256 buckets) = r.solvency();
        assertEq(accounted, buckets, "V1");
        assertGe(bal, accounted, "V2");
    }

    /// @dev A target that calls `settle()` back must hit the reentrancy guard. The push then fails
    ///      cleanly and is booked as stuck — no double split, no lost wei.
    function test_push_reentrantTargetIsRejectedAndBooked() public {
        MockReenteringTarget evil = new MockReenteringTarget(TOKEN);
        BacTaxRouter r = new BacTaxRouter(TOKEN, address(evil), address(nodeFund));
        evil.setRouter(r);

        (bool ok,) = address(r).call{value: 6 ether}("");
        assertTrue(ok);
        r.settle();

        (uint256 sb,) = r.stuckAmounts();
        assertEq(sb, 3 ether, "the reentrant push failed and was booked");
        assertEq(nodeFund.lifetimeReceived(), 3 ether, "the honest side was paid");
        assertEq(address(r).balance, 3 ether, "the money stayed here");
        assertEq(r.lifetimeToBridge(), 0, "nothing was booked as sent to the reentrant target");

        (uint256 bal, uint256 accounted, uint256 buckets) = r.solvency();
        assertEq(accounted, buckets, "V1");
        assertGe(bal, accounted, "V2");
    }

    /* ---------------------------------------------------------------- */
    /*                    no owner, no way out, no setter                */
    /* ---------------------------------------------------------------- */

    /// @notice There is no privileged path on this contract. Not one function checks `msg.sender`,
    ///         so there is nothing to test by pranking: what has to be proved is that the usual
    ///         escape hatches simply do not exist in the ABI, and that the contract has no
    ///         fallback that could hide one.
    function test_noOwnerPathExistsOnTheRouter() public {
        (bool ok,) = address(router).call{value: 10 ether}("");
        assertTrue(ok);

        string[14] memory absent = [
            "owner()",
            "pendingOwner()",
            "admin()",
            "transferOwnership(address)",
            "acceptOwnership(address)",
            "renounceOwnership()",
            "withdraw(address,uint256)",
            "withdraw(uint256)",
            "emergencyWithdraw()",
            "emergencyWithdraw(address)",
            "rescue(address,uint256)",
            "sweep(address)",
            "setBridge(address)",
            "setNodeFund(address)"
        ];
        for (uint256 i; i < absent.length; ++i) {
            (bool hit,) = address(router).call(abi.encodeWithSignature(absent[i], address(this), uint256(1 ether)));
            assertFalse(hit, string.concat("this selector must not exist: ", absent[i]));
        }

        // the upgrade surface: no proxy, no implementation slot, no upgrade entry point
        (bool up,) = address(router).call(abi.encodeWithSignature("upgradeTo(address)", address(this)));
        assertFalse(up, "upgradeTo must not exist");
        assertEq(
            vm.load(address(router), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc),
            bytes32(0),
            "the EIP-1967 implementation slot must be empty: this is not a proxy"
        );

        // an unknown selector has no fallback to land in, so it reverts and moves nothing
        (bool fb,) = address(router).call(abi.encodeWithSelector(bytes4(0xdeadbeef)));
        assertFalse(fb, "there must be no fallback function");

        // ...and after all of that the money is still exactly where it was
        assertEq(address(router).balance, 10 ether, "no call above moved a wei");
        assertEq(router.unsplitRevenue(), 10 ether, "and the book is unchanged");
        _assertSolvent();

        // the only two addresses this contract can ever pay are immutable
        router.settle();
        assertEq(bridge.lifetimeReceived() + nodeFund.lifetimeReceived(), 10 ether, "all of it went downstream");
        assertEq(address(this).balance > 0, true, "sanity");
    }

    /// @dev Every state-changing entry point is callable by anybody, including a random address.
    function test_everyWriteIsPermissionless() public {
        (bool ok,) = address(router).call{value: 2 ether}("");
        assertTrue(ok);

        vm.startPrank(STRANGER);
        router.sync();
        router.settle();
        router.retryPush();
        router.flush();
        vm.stopPrank();

        assertEq(bridge.lifetimeReceived(), 1 ether, "a stranger settled it");
        _assertSolvent();
    }

    /* ---------------------------------------------------------------- */
    /*                            disclosure                             */
    /* ---------------------------------------------------------------- */

    /// @notice Decision #29a: this exact sentence must be on chain, and word for word identical on
    ///         the site's first screen, in the footer and in the first reply under every X post.
    function test_description_carriesTheMandatoryDisclosures() public view {
        bytes memory d = bytes(router.description());
        assertTrue(
            _contains(d, bytes(unicode"项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。")),
            unicode"decision #29a sentence missing from description()"
        );
        assertTrue(
            _contains(d, bytes(unicode"我们要求持有 agent 身份，我们不能证明它是 AI")),
            unicode"decision #31a sentence missing from description()"
        );
        assertTrue(
            _contains(d, bytes(unicode"owner 随时提取")), unicode"decision #10 node-fund disclosure missing"
        );
        assertTrue(_contains(d, bytes(unicode"多烧掉约 4%")), unicode"decision #24b cost disclosure missing");
        assertTrue(
            _contains(d, bytes("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432")),
            "the ERC-8004 registry address must be spelled out, not just called official"
        );
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || hay.length < needle.length) return false;
        for (uint256 i; i <= hay.length - needle.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }

    receive() external payable {}
}
