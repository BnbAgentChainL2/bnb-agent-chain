// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {WBAC} from "../src/layer/WBAC.sol";

/// @dev A receiver whose `receive()` writes a storage slot. Under WETH9's `transfer` payout this
///      would run out of the 2,300 gas stipend and make `withdraw` impossible. On an agent-only
///      chain that receiver is the normal case, not the exotic one.
contract HungryReceiver {
    uint256 public received;
    uint256 private _pad;

    receive() external payable {
        received += msg.value;
        _pad = block.number; // a second cold SSTORE, well past any stipend
    }

    function wrap(address payable wbac) external payable {
        WBAC(wbac).deposit{value: msg.value}();
    }

    function unwrap(address payable wbac, uint256 wad) external {
        WBAC(wbac).withdraw(wad);
    }
}

/// @dev Re-enters `withdraw` from inside the payout. Checks-effects-interactions must hold.
contract Reentrant {
    WBAC internal immutable W;
    bool internal entered;

    constructor(address payable w) {
        W = WBAC(w);
    }

    function wrap() external payable {
        W.deposit{value: msg.value}();
    }

    function unwrap(uint256 wad) external {
        W.withdraw(wad);
    }

    receive() external payable {
        if (!entered) {
            entered = true;
            // Only whatever is left may be taken; the first leg was already debited.
            W.withdraw(W.balanceOf(address(this)));
        }
    }
}

/// @notice GROUP E2 — WBAC, the layer's wrapped native coin (01-CONTRACT-SPEC §8.4, 决策 #22).
///
/// @dev Like `Layer.t.sol`, the behavioural tests run against the contract AT ITS GENESIS ADDRESS:
///      the runtime bytecode is lifted off a throwaway deployment and `vm.etch`-ed to 0x…0106,
///      exactly the way `chain/build-genesis.sh` fills `genesis.alloc`. An etched instance starts
///      with no storage and no balance, which is the state a genesis account really has.
contract WBACTest is Test {
    address internal constant WBAC_ADDR = 0x0000000000000000000000000000000000000106;

    WBAC internal w;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal router = address(0x520);

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    function setUp() public {
        WBAC template = new WBAC();
        vm.etch(WBAC_ADDR, address(template).code);
        w = WBAC(payable(WBAC_ADDR));

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // ------------------------------------------------------------------ genesis discipline ------

    /// @notice THE genesis assertion: constructing WBAC writes no storage at all.
    /// @dev `name` / `symbol` / `decimals` are `constant`, so they live in the code. WETH9 keeps
    ///      them in storage and writes them in its constructor — a contract built that way cannot
    ///      be pasted into `genesis.alloc` without hand-writing storage slots, which
    ///      02-CHAIN-SPEC §3.2 alloc rule 1 forbids outright.
    function test_ConstructionWritesNoStorage() public {
        WBAC fresh = new WBAC();
        for (uint256 slot = 0; slot < 16; slot++) {
            assertEq(vm.load(address(fresh), bytes32(slot)), bytes32(0), "non-zero storage slot after construction");
        }
        assertEq(address(fresh).balance, 0, "fresh WBAC holds coin");
        assertEq(fresh.totalSupply(), 0, "fresh WBAC has supply");
    }

    /// @dev The same assertion against the etched genesis account, and a few hashed slots for good
    ///      measure: a mapping slot is keccak-derived, so slots 0..15 alone would not catch a
    ///      constructor that pre-credited somebody.
    function test_GenesisAccountIsClean() public view {
        for (uint256 slot = 0; slot < 16; slot++) {
            assertEq(vm.load(WBAC_ADDR, bytes32(slot)), bytes32(0));
        }
        assertEq(vm.load(WBAC_ADDR, keccak256(abi.encode(alice, uint256(0)))), bytes32(0));
        assertEq(vm.load(WBAC_ADDR, keccak256(abi.encode(bob, uint256(0)))), bytes32(0));
        assertEq(WBAC_ADDR.balance, 0);
        assertEq(w.balanceOf(alice), 0);
        assertEq(w.totalSupply(), 0);
    }

    function test_RuntimeFitsUnderEip170() public {
        WBAC fresh = new WBAC();
        uint256 size = address(fresh).code.length;
        assertGt(size, 0);
        assertLt(size, 24576, "WBAC runtime over the EIP-170 limit");
        emit log_named_uint("WBAC runtime bytes", size);
    }

    function test_Metadata() public view {
        assertEq(w.name(), "Wrapped BAC");
        assertEq(w.symbol(), "WBAC");
        assertEq(w.decimals(), 18);
    }

    // -------------------------------------------------------------------- deposit / withdraw ----

    function test_DepositMintsOneForOne() public {
        vm.expectEmit(true, false, false, true, WBAC_ADDR);
        emit Deposit(alice, 3 ether);
        vm.prank(alice);
        w.deposit{value: 3 ether}();

        assertEq(w.balanceOf(alice), 3 ether);
        assertEq(w.totalSupply(), 3 ether);
        assertEq(WBAC_ADDR.balance, 3 ether);
        assertEq(alice.balance, 97 ether);
    }

    function test_ReceiveDeposits() public {
        vm.prank(alice);
        (bool ok,) = WBAC_ADDR.call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(w.balanceOf(alice), 2 ether);
        assertEq(w.totalSupply(), 2 ether);
    }

    /// @dev WETH9's payable fallback: unknown calldata carrying value is a deposit.
    function test_FallbackWithUnknownCalldataDeposits() public {
        vm.prank(alice);
        (bool ok,) = WBAC_ADDR.call{value: 1 ether}(abi.encodeWithSignature("notAFunction()"));
        assertTrue(ok);
        assertEq(w.balanceOf(alice), 1 ether);
    }

    function test_WithdrawBurnsAndPaysNative() public {
        vm.startPrank(alice);
        w.deposit{value: 5 ether}();

        vm.expectEmit(true, false, false, true, WBAC_ADDR);
        emit Withdrawal(alice, 2 ether);
        w.withdraw(2 ether);
        vm.stopPrank();

        assertEq(w.balanceOf(alice), 3 ether);
        assertEq(w.totalSupply(), 3 ether);
        assertEq(alice.balance, 97 ether);
    }

    function test_WithdrawOverBalanceReverts() public {
        vm.startPrank(alice);
        w.deposit{value: 1 ether}();
        vm.expectRevert(bytes(unicode"Insufficient WBAC balance / WBAC 余额不足"));
        w.withdraw(1 ether + 1);
        vm.stopPrank();
    }

    /// @notice The deliberate WETH9 deviation, proved: a receiver that writes storage can still
    ///         withdraw. Under WETH9's 2,300 gas `transfer` this call reverts.
    function test_WithdrawReachesAnExpensiveReceiver() public {
        HungryReceiver hungry = new HungryReceiver();
        vm.deal(address(this), 4 ether);

        // The coin comes from this test, not from `hungry`: it starts with nothing, so the balance
        // it ends with is exactly what `withdraw` paid it.
        hungry.wrap{value: 4 ether}(payable(WBAC_ADDR));
        assertEq(w.balanceOf(address(hungry)), 4 ether);

        hungry.unwrap(payable(WBAC_ADDR), 4 ether);
        assertEq(w.balanceOf(address(hungry)), 0);
        assertEq(hungry.received(), 4 ether);
        assertEq(address(hungry).balance, 4 ether);
    }

    /// @dev Re-entering the payout can only take what is still credited: the first leg was debited
    ///      before the call, so the books stay exact and nothing is minted out of thin air.
    function test_ReentrantWithdrawCannotOverdraw() public {
        Reentrant r = new Reentrant(payable(WBAC_ADDR));
        vm.deal(address(this), 6 ether);
        r.wrap{value: 6 ether}();

        r.unwrap(2 ether); // re-enters and takes the remaining 4

        assertEq(w.balanceOf(address(r)), 0);
        assertEq(address(r).balance, 6 ether);
        assertEq(w.totalSupply(), 0);
        assertEq(WBAC_ADDR.balance, 0);
    }

    // ------------------------------------------------------------------------- ERC-20 surface ---

    function test_TransferNeedsNoSelfApproval() public {
        vm.startPrank(alice);
        w.deposit{value: 4 ether}();

        vm.expectEmit(true, true, false, true, WBAC_ADDR);
        emit Transfer(alice, bob, 1 ether);
        assertTrue(w.transfer(bob, 1 ether));
        vm.stopPrank();

        assertEq(w.balanceOf(alice), 3 ether);
        assertEq(w.balanceOf(bob), 1 ether);
        assertEq(w.allowance(alice, alice), 0, "self transfer must not touch allowance");
    }

    function test_TransferOverBalanceReverts() public {
        vm.startPrank(alice);
        w.deposit{value: 1 ether}();
        vm.expectRevert(bytes(unicode"Insufficient WBAC balance / WBAC 余额不足"));
        w.transfer(bob, 2 ether);
        vm.stopPrank();
    }

    function test_ApproveOverwritesAndEmits() public {
        vm.startPrank(alice);
        vm.expectEmit(true, true, false, true, WBAC_ADDR);
        emit Approval(alice, router, 7 ether);
        assertTrue(w.approve(router, 7 ether));
        assertEq(w.allowance(alice, router), 7 ether);

        // WETH9 semantics: a plain overwrite, no "must set to zero first".
        assertTrue(w.approve(router, 1 ether));
        assertEq(w.allowance(alice, router), 1 ether);
        vm.stopPrank();
    }

    function test_TransferFromSpendsAllowance() public {
        vm.startPrank(alice);
        w.deposit{value: 5 ether}();
        w.approve(router, 3 ether);
        vm.stopPrank();

        vm.prank(router);
        assertTrue(w.transferFrom(alice, bob, 2 ether));

        assertEq(w.allowance(alice, router), 1 ether);
        assertEq(w.balanceOf(alice), 3 ether);
        assertEq(w.balanceOf(bob), 2 ether);
    }

    function test_TransferFromOverAllowanceReverts() public {
        vm.startPrank(alice);
        w.deposit{value: 5 ether}();
        w.approve(router, 1 ether);
        vm.stopPrank();

        vm.prank(router);
        vm.expectRevert(bytes(unicode"Insufficient WBAC allowance / WBAC 授权额度不足"));
        w.transferFrom(alice, bob, 2 ether);
    }

    /// @notice The infinite-allowance convention Uniswap-V2-style routers rely on.
    function test_InfiniteAllowanceIsNotDecremented() public {
        vm.startPrank(alice);
        w.deposit{value: 9 ether}();
        w.approve(router, type(uint256).max);
        vm.stopPrank();

        vm.startPrank(router);
        w.transferFrom(alice, bob, 4 ether);
        w.transferFrom(alice, bob, 5 ether);
        vm.stopPrank();

        assertEq(w.allowance(alice, router), type(uint256).max, "infinite allowance was decremented");
        assertEq(w.balanceOf(bob), 9 ether);
        assertEq(w.balanceOf(alice), 0);
    }

    /// @dev WETH9 has no zero-address guard; a pair that routes to address(0) simply burns. Kept
    ///      identical so WBAC behaves like every other WETH9 an agent has integrated against.
    function test_TransferToZeroBehavesLikeWeth9() public {
        vm.startPrank(alice);
        w.deposit{value: 1 ether}();
        assertTrue(w.transfer(address(0), 1 ether));
        vm.stopPrank();

        assertEq(w.balanceOf(address(0)), 1 ether);
        assertEq(w.totalSupply(), 1 ether, "coin stays backed even when the WBAC is stranded");
    }

    // ------------------------------------------------------------------------------ invariant ---

    /// @dev totalSupply() == address(this).balance is structural, not a counter someone maintains.
    function testFuzz_SupplyAlwaysEqualsBackingCoin(uint96 a, uint96 b, uint96 out) public {
        vm.assume(a > 0 && b > 0);
        vm.deal(alice, uint256(a));
        vm.deal(bob, uint256(b));

        vm.prank(alice);
        w.deposit{value: a}();
        vm.prank(bob);
        w.deposit{value: b}();

        uint256 take = uint256(out) % (uint256(a) + 1);
        vm.prank(alice);
        w.withdraw(take);

        assertEq(w.totalSupply(), WBAC_ADDR.balance);
        assertEq(w.totalSupply(), w.balanceOf(alice) + w.balanceOf(bob));
    }
}
