// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {BacVaultFactory} from "../src/BacVaultFactory.sol";
import {BacTreasuryVault} from "../src/BacTreasuryVault.sol";
import {IVaultFactoryValidationV2} from "../src/flap/IVaultFactory.sol";
import {IPortalTypes, MAGIC_DIVIDEND_COMPUTED} from "../src/flap/IPortal.sol";
import {
    ApproveAction,
    FactoryPolicy,
    FieldDescriptor,
    VaultDataSchema,
    VaultMethodSchema,
    VaultUISchema
} from "../src/flap/IVaultSchemasV1.sol";

/* -------------------------------------------------------------------------- */
/*                                   mocks                                    */
/* -------------------------------------------------------------------------- */

/// @dev Stands in for `BacBridge` / `BacNodeFund`: exposes `bacToken()`, a two-step
///      `owner()` and a switchable `acceptRelease()` so push failures can be replayed.
contract MockReleaseTarget {
    address public bacToken;
    address public owner;
    address public pendingOwner;
    bool public rejecting;
    uint256 public lifetimeReceived;

    constructor(address bacToken_, address owner_) {
        bacToken = bacToken_;
        owner = owner_;
    }

    function setRejecting(bool v) external {
        rejecting = v;
    }

    function acceptRelease() external payable {
        require(!rejecting, "target rejects");
        lifetimeReceived += msg.value;
    }

    function transferOwnership(address newOwner) external {
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}

/// @dev A release target that pays part of the push straight back into the vault's
///      `receive()` while the push call is still open - the case rule 010 means by
///      "never cache accountedQuote across an external call".
contract MockBouncingTarget {
    address public bacToken;
    address public owner;
    uint256 public bounceBps;

    constructor(address bacToken_, uint256 bounceBps_) {
        bacToken = bacToken_;
        owner = address(0xF00D);
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

/// @dev A contract with code but without `bacToken()`.
contract MockNoBacToken {
    uint256 public x;
}

/// @dev Minimal token stand-in so `description()` can read a symbol.
contract MockToken {
    function symbol() external pure returns (string memory) {
        return "BAC";
    }
}

/* -------------------------------------------------------------------------- */
/*                                   tests                                    */
/* -------------------------------------------------------------------------- */

contract BacVaultTest is Test {
    // BNB testnet (97) addresses baked into the Flap base classes; unit tests run on 97
    // because `_getVaultPortal()` / `_getGuardian()` revert on 31337.
    address internal constant VAULT_PORTAL = 0x027e3704fC5C16522e9393d04C60A3ac5c0d775f;
    address internal constant GUARDIAN = 0x76Fa8C526f8Bc27ba6958B76DeEf92a0dbE46950;

    address internal constant LAUNCHER = address(0x1A);
    address internal constant VAULT_OWNER = address(0xB0B);
    address internal constant NODE_FUND_OWNER = address(0xC01D);
    address internal constant STRANGER = address(0xDEAD1);

    BacVaultFactory internal factory;
    BacTreasuryVault internal vault;
    MockReleaseTarget internal bridge;
    MockReleaseTarget internal nodeFund;
    address internal token;

    function setUp() public {
        vm.chainId(97);
        token = address(new MockToken());
        factory = new BacVaultFactory(LAUNCHER);
        bridge = new MockReleaseTarget(token, address(0xBBB));
        nodeFund = new MockReleaseTarget(token, NODE_FUND_OWNER);
        vault = BacTreasuryVault(payable(_launch(VAULT_OWNER)));
        vm.deal(address(this), 1_000 ether);
    }

    /// @dev Pays the vault the way the TaxProcessor does: a plain value transfer that
    ///      invokes `receive()` with real gas (never `transfer()`'s 2,300-gas stipend).
    function _fund(uint256 amount) internal {
        (bool ok,) = address(vault).call{value: amount}("");
        assertTrue(ok, "receive() rejected a payment");
    }

    function _launch(address owner_) internal returns (address v) {
        vm.prank(VAULT_PORTAL);
        v = factory.newVault(token, address(0), LAUNCHER, abi.encode(owner_, address(bridge), address(nodeFund)));
    }

    /// @dev V1 (`accountedQuote == unsplit + stuckBridge + stuckNodeFund`) and V2
    ///      (`balance >= accountedQuote`) after every scenario (rule 010).
    function _assertSolvent() internal view {
        (uint256 bal, uint256 accounted, uint256 buckets) = vault.solvency();
        assertEq(accounted, buckets, "V1 broken");
        assertGe(bal, accounted, "V2 broken");
        assertEq(
            vault.totalRecognized(),
            vault.lifetimeToBridge() + vault.lifetimeToNodeFund() + vault.accountedQuote(),
            "V9 broken"
        );
    }

    function _goodLaunchData() internal pure returns (IVaultFactoryValidationV2.LaunchValidationDataV1 memory d) {
        d.tokenVersion = IPortalTypes.TokenVersion.TOKEN_TAXED_V3;
        d.quoteToken = address(0);
        d.buyTaxRate = 200;
        d.sellTaxRate = 200;
        d.vaultBps = 10000;
        d.deflationBps = 0;
        d.dividendBps = 0;
        d.lpBps = 0;
        d.dividendToken = address(0);
        d.minimumShareBalance = 0;
    }

    function _hook(IVaultFactoryValidationV2.LaunchValidationDataV1 memory d)
        internal
        view
        returns (bool ok, string memory reason)
    {
        return factory.onBeforeLaunch(abi.encode(d));
    }

    /* ---------------------------------------------------------------- */
    /*                        wiring & rule 009                          */
    /* ---------------------------------------------------------------- */

    function test_launchWiring() public view {
        assertEq(vault.taxToken(), token);
        assertEq(vault.bridge(), address(bridge));
        assertEq(vault.nodeFund(), address(nodeFund));
        assertEq(vault.owner(), VAULT_OWNER);
        assertEq(vault.vaultQuoteToken(), address(0), "must be native BNB, never WBNB");
        assertEq(vault.vaultSpecVersion(), "v3");
        assertEq(factory.factorySpecVersion(), "v2.3");
        assertEq(factory.LAUNCHER(), LAUNCHER);
        assertEq(vault.BRIDGE_BPS(), 5000);
        assertEq(vault.BPS(), 10000);
        assertEq(vault.PUSH_GAS(), 100_000);
        assertTrue(factory.isQuoteTokenSupported(address(0)));
        assertFalse(factory.isQuoteTokenSupported(address(0x1234)));
    }

    function test_beaconOwnerIsFactory() public view {
        (bool ok, bytes memory ret) = factory.beacon().staticcall(abi.encodeWithSignature("owner()"));
        assertTrue(ok);
        assertEq(abi.decode(ret, (address)), address(factory), "rule 009: beacon owner must be the factory");
        assertFalse(factory.isVaultUpgradesLocked());
        assertTrue(factory.beaconImplementation() != address(0));
    }

    function test_guardianOnlyUpgradeAndLock() public {
        BacTreasuryVault newImpl = new BacTreasuryVault();

        vm.prank(STRANGER);
        vm.expectRevert(bytes(unicode"Only Guardian / 仅限 Guardian"));
        factory.upgradeVaultImplementation(address(newImpl));

        vm.prank(GUARDIAN);
        factory.upgradeVaultImplementation(address(newImpl));
        assertEq(factory.beaconImplementation(), address(newImpl));

        vm.prank(STRANGER);
        vm.expectRevert(bytes(unicode"Only Guardian / 仅限 Guardian"));
        factory.lockVaultUpgrades();

        vm.prank(GUARDIAN);
        factory.lockVaultUpgrades();
        assertTrue(factory.isVaultUpgradesLocked());

        // irreversible: the beacon has renounced its owner
        vm.prank(GUARDIAN);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        factory.upgradeVaultImplementation(address(newImpl));
    }

    function test_initializeIsSingleUseOnProxyAndImplementation() public {
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        vault.initialize(token, VAULT_OWNER, address(bridge), address(nodeFund));

        BacTreasuryVault bare = new BacTreasuryVault();
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        bare.initialize(token, VAULT_OWNER, address(bridge), address(nodeFund));
    }

    /// @dev V5: no path sends BNB to a caller-supplied address.
    function test_noWithdrawalSurface() public {
        string[6] memory sigs = [
            "withdraw(address,uint256)",
            "withdraw(uint256)",
            "emergencyWithdrawNative(address)",
            "emergencyWithdrawNative(address,uint256)",
            "emergencyWithdrawToken(address,address)",
            "rescue(address,uint256)"
        ];
        for (uint256 i; i < sigs.length; ++i) {
            (bool ok,) = address(vault).call(abi.encodeWithSignature(sigs[i], address(this), uint256(1)));
            assertFalse(ok, "vault must expose no withdrawal path");
        }
    }

    /* ---------------------------------------------------------------- */
    /*                    rule 005: the receive() ping                    */
    /* ---------------------------------------------------------------- */

    function test_receivePingUnder50kGas() public {
        // cold: first touch of every slot
        uint256 g0 = gasleft();
        (bool ok,) = address(vault).call{value: 1 ether, gas: 50_000}("");
        uint256 coldUsed = g0 - gasleft();
        assertTrue(ok, "receive() must succeed under call{gas: 50_000}");
        assertLt(coldUsed, 50_000, "cold receive() over budget");

        // warm
        g0 = gasleft();
        (ok,) = address(vault).call{value: 1 ether, gas: 50_000}("");
        uint256 warmUsed = g0 - gasleft();
        assertTrue(ok);
        assertLt(warmUsed, 30_000, "warm receive() over budget");

        assertEq(vault.accountedQuote(), 2 ether);
        assertEq(vault.unsplitRevenue(), 2 ether);
        _assertSolvent();
        emit log_named_uint("receive() cold gas", coldUsed);
        emit log_named_uint("receive() warm gas", warmUsed);
    }

    function test_zeroDeltaWakeIsSilentNoOp() public {
        (bool ok,) = address(vault).call{value: 0}("");
        assertTrue(ok, "a zero-value ping must never revert");
        assertEq(vault.accountedQuote(), 0);

        _fund(1 ether);
        vault.sync();
        assertEq(vault.accountedQuote(), 1 ether);
        vault.sync(); // second sync, nothing new
        assertEq(vault.accountedQuote(), 1 ether);
        assertEq(vault.unsplitRevenue(), 1 ether);
        _assertSolvent();
    }

    /* ---------------------------------------------------------------- */
    /*                        split arithmetic                            */
    /* ---------------------------------------------------------------- */

    function test_settleSplits5050AndPushes() public {
        _fund(1 ether);
        (uint256 toBridge, uint256 toNodeFund) = vault.settle();

        assertEq(toBridge, 0.5 ether);
        assertEq(toNodeFund, 0.5 ether);
        assertEq(address(bridge).balance, 0.5 ether);
        assertEq(address(nodeFund).balance, 0.5 ether);
        assertEq(bridge.lifetimeReceived(), 0.5 ether);
        assertEq(nodeFund.lifetimeReceived(), 0.5 ether);
        assertEq(vault.lifetimeToBridge(), 0.5 ether);
        assertEq(vault.lifetimeToNodeFund(), 0.5 ether);
        assertEq(vault.accountedQuote(), 0);
        assertEq(address(vault).balance, 0);
        assertEq(vault.totalRecognized(), 1 ether);
        _assertSolvent();
    }

    function test_settleOnEmptyVaultIsNoOp() public {
        (uint256 toBridge, uint256 toNodeFund) = vault.settle();
        assertEq(toBridge, 0);
        assertEq(toNodeFund, 0);
        _assertSolvent();
    }

    /// @dev V11: the rounding remainder always flows to the bridge pool.
    function testFuzz_splitRemainderAlwaysToBridge(uint96 amount) public {
        amount = uint96(bound(uint256(amount), 0, 1_000 ether));
        if (amount == 0) return;
        vm.deal(address(vault), amount);
        (uint256 toBridge, uint256 toNodeFund) = vault.settle();

        assertEq(toBridge + toNodeFund, amount, "the two halves must sum to the unsplit amount");
        assertGe(toBridge, toNodeFund, "V11: the remainder is the bridge pool's");
        assertLe(toBridge - toNodeFund, 1, "the remainder is at most 1 wei");
        assertEq(vault.lifetimeToBridge(), toBridge);
        assertEq(vault.lifetimeToNodeFund(), toNodeFund);
        _assertSolvent();
    }

    function test_oddWeiRemainderToBridge() public {
        vm.deal(address(vault), 3 wei);
        (uint256 toBridge, uint256 toNodeFund) = vault.settle();
        assertEq(toBridge, 2);
        assertEq(toNodeFund, 1);
        _assertSolvent();
    }

    function test_donationsAndForcedBalanceAreSplitTheSameWay() public {
        // a forced balance (selfdestruct-style) never invokes receive(); sync() recovers it
        vm.deal(address(vault), 4 ether);
        assertEq(vault.accountedQuote(), 0, "not recognized before a wake");
        vault.settle();
        assertEq(vault.lifetimeToBridge(), 2 ether);
        assertEq(vault.lifetimeToNodeFund(), 2 ether);
        _assertSolvent();
    }

    /* ---------------------------------------------------------------- */
    /*                      push-failure bookkeeping                      */
    /* ---------------------------------------------------------------- */

    function test_settleSurvivesRejectingBridge() public {
        bridge.setRejecting(true);
        _fund(1 ether);

        (uint256 toBridge, uint256 toNodeFund) = vault.settle(); // V7: must not revert
        assertEq(toBridge, 0.5 ether);
        assertEq(toNodeFund, 0.5 ether);

        (uint256 stuckBridge, uint256 stuckNodeFund) = vault.stuckAmounts();
        assertEq(stuckBridge, 0.5 ether, "the bridge half stays booked as stuck");
        assertEq(stuckNodeFund, 0);
        assertEq(vault.accountedQuote(), 0.5 ether, "the stuck half is still accounted for");
        assertEq(vault.unsplitRevenue(), 0);
        assertEq(vault.lifetimeToBridge(), 0);
        assertEq(vault.lifetimeToNodeFund(), 0.5 ether);
        assertEq(address(vault).balance, 0.5 ether);
        _assertSolvent();
    }

    function test_retryPushAfterTargetRecovers() public {
        bridge.setRejecting(true);
        nodeFund.setRejecting(true);
        _fund(1 ether);
        vault.settle();
        _assertSolvent();

        (uint256 bs, uint256 ns) = vault.retryPush(); // still rejecting: nothing moves
        assertEq(bs, 0);
        assertEq(ns, 0);
        (uint256 stuckBridge, uint256 stuckNodeFund) = vault.stuckAmounts();
        assertEq(stuckBridge, 0.5 ether);
        assertEq(stuckNodeFund, 0.5 ether);
        _assertSolvent();

        bridge.setRejecting(false);
        nodeFund.setRejecting(false);
        (bs, ns) = vault.retryPush();
        assertEq(bs, 0.5 ether);
        assertEq(ns, 0.5 ether);
        (stuckBridge, stuckNodeFund) = vault.stuckAmounts();
        assertEq(stuckBridge, 0);
        assertEq(stuckNodeFund, 0);
        assertEq(address(vault).balance, 0);
        assertEq(vault.accountedQuote(), 0);
        assertEq(vault.lifetimeToBridge(), 0.5 ether);
        assertEq(vault.lifetimeToNodeFund(), 0.5 ether);
        _assertSolvent();
    }

    /// @dev V8: 20 rounds against a permanently rejecting downstream must not double-book.
    function test_V8_twentyRoundsAgainstRejectingTargets() public {
        bridge.setRejecting(true);
        nodeFund.setRejecting(true);

        for (uint256 i; i < 20; ++i) {
            _fund(0.1 ether);
            vault.settle();
            vault.retryPush();
            (uint256 sb, uint256 sn) = vault.stuckAmounts();
            assertLe(sb + sn, address(vault).balance, "stuck* must never exceed the balance");
            _assertSolvent();
        }

        (uint256 stuckBridge, uint256 stuckNodeFund) = vault.stuckAmounts();
        assertEq(stuckBridge + stuckNodeFund, 2 ether, "no double-booking across retries");
        assertEq(address(vault).balance, 2 ether);

        bridge.setRejecting(false);
        nodeFund.setRejecting(false);
        vault.retryPush();
        assertEq(address(vault).balance, 0);
        assertEq(vault.accountedQuote(), 0);
        _assertSolvent();
    }

    /// @dev A9: with too little gas, `settle()` must revert rather than book the money
    ///      into `stuck*`. Sweeps gas limits because the exact trip point is compiler-set.
    function test_settleRevertsWhenGasIsTooLowInsteadOfBookingStuck() public {
        _fund(1 ether);

        bool sawGasRevert;
        for (uint256 g = 60_000; g <= 260_000; g += 10_000) {
            (bool ok, bytes memory ret) = address(vault).call{gas: g}(abi.encodeWithSignature("settle()"));
            if (ok) break; // enough gas: the happy path took over
            if (_isRevertString(ret, unicode"Not enough gas to push / gas 不足以推送")) sawGasRevert = true;
            (uint256 sb, uint256 sn) = vault.stuckAmounts();
            assertEq(sb + sn, 0, "a gas-starved settle() must not book anything as stuck");
        }
        assertTrue(sawGasRevert, "the PUSH_GAS floor never fired");
        _assertSolvent();
    }

    function _isRevertString(bytes memory ret, string memory expected) internal pure returns (bool) {
        if (ret.length < 4) return false;
        bytes4 sel;
        assembly {
            sel := mload(add(ret, 32))
        }
        if (sel != bytes4(0x08c379a0)) return false; // Error(string)
        bytes memory body = new bytes(ret.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = ret[i + 4];
        }
        return keccak256(bytes(abi.decode(body, (string)))) == keccak256(bytes(expected));
    }

    /// @dev Rule 010: the downstream target re-enters `receive()` inside `_push`, so the
    ///      cached `_revenue` is stale the moment the call returns. Bookkeeping must hold.
    function test_pushTargetReentersReceive() public {
        MockBouncingTarget bouncer = new MockBouncingTarget(token, 5000); // pays half back
        vm.prank(VAULT_PORTAL);
        BacTreasuryVault v = BacTreasuryVault(
            payable(factory.newVault(
                    token, address(0), LAUNCHER, abi.encode(VAULT_OWNER, address(bouncer), address(nodeFund))
                ))
        );

        (bool paid,) = address(v).call{value: 1 ether}("");
        assertTrue(paid);
        (uint256 toBridge, uint256 toNodeFund) = v.settle();
        assertEq(toBridge, 0.5 ether);
        assertEq(toNodeFund, 0.5 ether);

        // the bridge kept half of its half; the other quarter came back and is new revenue
        assertEq(address(bouncer).balance, 0.25 ether);
        assertEq(address(v).balance, 0.25 ether);
        assertEq(v.accountedQuote(), 0.25 ether, "the bounced BNB must be recognized exactly once");
        assertEq(v.unsplitRevenue(), 0.25 ether);
        assertEq(v.lifetimeToBridge(), 0.5 ether);

        (uint256 bal, uint256 accounted, uint256 buckets) = v.solvency();
        assertEq(accounted, buckets, "V1 broken after a re-entrant push");
        assertGe(bal, accounted, "V2 broken after a re-entrant push");

        // and it settles again cleanly
        v.settle();
        assertEq(address(v).balance, 0.0625 ether); // half of the bridge's 0.125 came back again
        (bal, accounted, buckets) = v.solvency();
        assertEq(accounted, buckets, "V1 broken on the second round");
        assertGe(bal, accounted, "V2 broken on the second round");
    }

    /* ---------------------------------------------------------------- */
    /*                          transferOwnership                         */
    /* ---------------------------------------------------------------- */

    function test_transferOwnershipByOwnerOrGuardianOnly() public {
        vm.prank(STRANGER);
        vm.expectRevert(bytes(unicode"Only owner or guardian / 仅限 owner 或 Guardian"));
        vault.transferOwnership(STRANGER);

        vm.prank(VAULT_OWNER);
        vault.transferOwnership(address(0xA11CE));
        assertEq(vault.owner(), address(0xA11CE));

        // rule 001: the Guardian can call every permissioned function on its own
        vm.prank(GUARDIAN);
        vault.transferOwnership(VAULT_OWNER);
        assertEq(vault.owner(), VAULT_OWNER);

        vm.prank(VAULT_OWNER);
        vm.expectRevert(bytes(unicode"Zero address / 地址为零"));
        vault.transferOwnership(address(0));
    }

    /* ---------------------------------------------------------------- */
    /*                    description() / schemas                         */
    /* ---------------------------------------------------------------- */

    function test_descriptionRendersLiveNodeFundOwner() public {
        _fund(1 ether);
        vault.sync();

        string memory d = vault.description();
        assertGt(bytes(d).length, 0);
        assertTrue(_contains(d, _addr(NODE_FUND_OWNER)), "the node fund withdrawer must be rendered");
        assertTrue(_contains(d, _addr(address(bridge))), "the bridge address must be rendered");
        assertTrue(_contains(d, "BAC"), "the token symbol is read at runtime");
        assertFalse(_contains(d, "0.0000 BNB, recognized 0.0000"), "live numbers must be rendered");

        // A4: after a two-step transfer the disclosed withdrawer follows
        nodeFund.transferOwnership(STRANGER);
        nodeFund.acceptOwnership();
        string memory d2 = vault.description();
        assertTrue(_contains(d2, _addr(STRANGER)), "the new withdrawer must be rendered");
        assertFalse(_contains(d2, _addr(NODE_FUND_OWNER)), "the old withdrawer must be gone");
        assertTrue(_contains(d2, _addr(VAULT_OWNER)), "the vault owner is still disclosed separately");
    }

    function test_descriptionNeverFallsBackToVaultOwnerWhenNodeFundIsUnreadable() public {
        address v2 = _launchWithTargets(new MockNoBacToken(), true);
        string memory d = BacTreasuryVault(payable(v2)).description();
        assertTrue(_contains(d, unicode"(unreadable / 读取失败)"), "must render the unreadable marker");
    }

    /// @dev Launches a second vault whose node fund has no `owner()`; the factory's
    ///      cross-check still has to pass, so the stand-in exposes `bacToken()`.
    function _launchWithTargets(MockNoBacToken, bool) internal returns (address) {
        MockNoOwner nf = new MockNoOwner(token);
        vm.prank(VAULT_PORTAL);
        return factory.newVault(token, address(0), LAUNCHER, abi.encode(VAULT_OWNER, address(bridge), address(nf)));
    }

    function test_vaultDataSchemaMatchesDecode() public view {
        VaultDataSchema memory s = factory.vaultDataSchema();
        assertFalse(s.isArray);
        assertGt(bytes(s.description).length, 0);
        assertEq(s.fields.length, 3);
        assertEq(s.fields[0].name, "owner");
        assertEq(s.fields[1].name, "bridge");
        assertEq(s.fields[2].name, "nodeFund");
        for (uint256 i; i < 3; ++i) {
            assertEq(s.fields[i].fieldType, "address");
            assertEq(s.fields[i].decimals, 0);
            assertGt(bytes(s.fields[i].description).length, 0);
        }
        // round trip: the schema's three static address fields == the factory's abi.decode
        bytes memory encoded = abi.encode(VAULT_OWNER, address(bridge), address(nodeFund));
        (address a, address b, address c) = abi.decode(encoded, (address, address, address));
        assertEq(a, VAULT_OWNER);
        assertEq(b, address(bridge));
        assertEq(c, address(nodeFund));
    }

    function test_vaultDataSchemaDisclosesTheNodeFundHalf() public view {
        string memory d = factory.vaultDataSchema().description;
        assertTrue(_contains(d, "BacNodeFund.owner()"), "decision #10 disclosure");
        assertTrue(_contains(d, unicode"节点基金"), "decision #10 disclosure, Chinese half");
        assertTrue(_contains(d, "50%"));
    }

    function test_tokenCreationPoliciesMirrorTheHook() public view {
        FactoryPolicy[] memory p = factory.tokenCreationPolicies();
        assertEq(p.length, 8);

        string[8] memory targets = [
            "quoteToken", "tokenVersion", "mktBps", "dividendBps", "buyTaxRate", "sellTaxRate", "deflationBps", "lpBps"
        ];
        for (uint256 i; i < 8; ++i) {
            assertEq(p[i].target, targets[i]);
            assertEq(p[i].operator, "eq");
            assertGt(bytes(p[i].description).length, 0);
        }
        assertEq(abi.decode(p[0].value, (address)), address(0));
        assertEq(abi.decode(p[1].value, (uint8)), 6);
        assertEq(abi.decode(p[2].value, (uint16)), 10000);
        assertEq(abi.decode(p[3].value, (uint16)), 0);
        assertEq(abi.decode(p[4].value, (uint16)), 200);
        assertEq(abi.decode(p[5].value, (uint16)), 200);
        assertEq(abi.decode(p[6].value, (uint16)), 0);
        assertEq(abi.decode(p[7].value, (uint16)), 0);

        // every policy value equals the constant the hook enforces
        assertEq(factory.REQUIRED_MKT_BPS(), abi.decode(p[2].value, (uint16)));
        assertEq(factory.REQUIRED_BUY_TAX_BPS(), abi.decode(p[4].value, (uint16)));
        assertEq(factory.REQUIRED_SELL_TAX_BPS(), abi.decode(p[5].value, (uint16)));
    }

    function test_vaultUISchema() public {
        VaultUISchema memory s = vault.vaultUISchema();
        assertEq(s.vaultType, "BacTreasuryVault");
        assertGt(bytes(s.description).length, 0);
        assertEq(s.methods.length, 10);

        string[10] memory names = [
            "taxToken",
            "bridge",
            "nodeFund",
            "owner",
            "accountedQuote",
            "lifetimeToBridge",
            "lifetimeToNodeFund",
            "solvency",
            "settle",
            "retryPush"
        ];
        for (uint256 i; i < 10; ++i) {
            VaultMethodSchema memory m = s.methods[i];
            assertEq(m.name, names[i]);
            assertGt(bytes(m.description).length, 0);
            assertEq(m.inputs.length, 0, "no method takes an input");
            assertEq(m.approvals.length, 0, "the vault touches no ERC20");
            assertFalse(m.isInputArray);
            assertFalse(m.isOutputArray);
            if (i < 8) {
                assertFalse(m.isWriteMethod);
                assertGt(m.outputs.length, 0);
                // an input-less view is called on page load: it must never revert
                (bool ok,) = address(vault).staticcall(abi.encodeWithSignature(string.concat(names[i], "()")));
                assertTrue(ok, "an input-less view reverted");
            } else {
                assertTrue(m.isWriteMethod, "settle/retryPush must be write methods");
                assertEq(m.outputs.length, 0, "write methods declare no outputs");
                (bool ok,) = address(vault).call(abi.encodeWithSignature(string.concat(names[i], "()")));
                assertTrue(ok, "a declared write method must exist and be callable by anyone");
            }
        }
        assertEq(s.methods[7].outputs.length, 3);
        assertEq(s.methods[7].outputs[0].name, "balance");
        assertEq(s.methods[7].outputs[1].name, "accounted");
        assertEq(s.methods[7].outputs[2].name, "buckets");
    }

    /* ---------------------------------------------------------------- */
    /*                   _validateBeforeLaunch (9 rows)                  */
    /* ---------------------------------------------------------------- */

    function test_hookAcceptsTheExactLaunchForm() public view {
        (bool ok, string memory reason) = _hook(_goodLaunchData());
        assertTrue(ok, "a valid launch must RETURN (true, \"\")");
        assertEq(reason, "");
    }

    function test_hookRejectsNonBnbQuote() public view {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d = _goodLaunchData();
        d.quoteToken = address(0x1234);
        (bool ok, string memory reason) = _hook(d);
        assertFalse(ok);
        assertEq(reason, unicode"BNB quote only / 仅支持 BNB 计价");
    }

    function test_hookRejectsNonV3Token() public view {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d = _goodLaunchData();
        d.tokenVersion = IPortalTypes.TokenVersion.TOKEN_TAXED_V2;
        (bool ok, string memory reason) = _hook(d);
        assertFalse(ok);
        assertEq(reason, unicode"Tax Token V3 only / 仅支持 Tax Token V3");
    }

    function test_hookRejectsWrongBuyTax() public view {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d = _goodLaunchData();
        d.buyTaxRate = 300;
        (bool ok, string memory reason) = _hook(d);
        assertFalse(ok);
        assertEq(reason, unicode"Buy tax must be exactly 2% / 买税必须正好是 2%");
    }

    function test_hookRejectsWrongSellTax() public view {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d = _goodLaunchData();
        d.sellTaxRate = 100;
        (bool ok, string memory reason) = _hook(d);
        assertFalse(ok);
        assertEq(reason, unicode"Sell tax must be exactly 2% / 卖税必须正好是 2%");
    }

    function test_hookRejectsPartialVaultShare() public view {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d = _goodLaunchData();
        d.vaultBps = 8000;
        (bool ok, string memory reason) = _hook(d);
        assertFalse(ok);
        assertEq(reason, unicode"Vault share must be exactly 100% / 金库份额必须正好是 100%");
    }

    function test_hookRejectsHolderDividend() public view {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d = _goodLaunchData();
        d.dividendBps = 2000;
        (bool ok, string memory reason) = _hook(d);
        assertFalse(ok);
        assertEq(reason, unicode"Holder dividend must be 0% / 持币分红必须为 0%");
    }

    function test_hookRejectsDeflation() public view {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d = _goodLaunchData();
        d.deflationBps = 500;
        (bool ok, string memory reason) = _hook(d);
        assertFalse(ok);
        assertEq(reason, unicode"Deflation must be 0% / 销毁必须为 0%");
    }

    function test_hookRejectsLpShare() public view {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d = _goodLaunchData();
        d.lpBps = 1000;
        (bool ok, string memory reason) = _hook(d);
        assertFalse(ok);
        assertEq(reason, unicode"LP share must be 0% / 加流动性必须为 0%");
    }

    function test_hookRejectsComputedDividendToken() public view {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d = _goodLaunchData();
        d.dividendToken = MAGIC_DIVIDEND_COMPUTED;
        (bool ok, string memory reason) = _hook(d);
        assertFalse(ok);
        assertEq(reason, unicode"Computed dividend token not supported / 不支持自动推导分红代币");
    }

    /// @dev The hook is reached by STATICCALL: it must never revert, on any input.
    function testFuzz_hookNeverReverts(
        uint8 version,
        address quote,
        uint16 buy,
        uint16 sell,
        uint16 vaultBps,
        uint16 deflation,
        uint16 dividend,
        uint16 lp,
        address dividendToken,
        uint256 minShare
    ) public view {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d;
        d.tokenVersion = IPortalTypes.TokenVersion(uint8(bound(uint256(version), 0, 7)));
        d.quoteToken = quote;
        d.buyTaxRate = buy;
        d.sellTaxRate = sell;
        d.vaultBps = vaultBps;
        d.deflationBps = deflation;
        d.dividendBps = dividend;
        d.lpBps = lp;
        d.dividendToken = dividendToken;
        d.minimumShareBalance = minShare;

        (bool callOk, bytes memory ret) =
            address(factory).staticcall(abi.encodeWithSignature("onBeforeLaunch(bytes)", abi.encode(d)));
        assertTrue(callOk, "onBeforeLaunch must never revert");
        (bool ok, string memory reason) = abi.decode(ret, (bool, string));
        if (ok) assertEq(reason, "");
        else assertGt(bytes(reason).length, 0);
    }

    /* ---------------------------------------------------------------- */
    /*                     newVault negative cases                        */
    /* ---------------------------------------------------------------- */

    function test_newVaultOnlyFromVaultPortal() public {
        vm.prank(STRANGER);
        vm.expectRevert(bytes(unicode"Only VaultPortal / 仅限 VaultPortal 调用"));
        factory.newVault(token, address(0), LAUNCHER, abi.encode(VAULT_OWNER, address(bridge), address(nodeFund)));
    }

    function test_newVaultRejectsErc20Quote() public {
        vm.prank(VAULT_PORTAL);
        vm.expectRevert(bytes(unicode"BNB quote only / 仅支持 BNB 计价"));
        factory.newVault(token, address(0x1234), LAUNCHER, abi.encode(VAULT_OWNER, address(bridge), address(nodeFund)));
    }

    function test_newVaultRejectsStrangerCreator() public {
        vm.prank(VAULT_PORTAL);
        vm.expectRevert(bytes(unicode"Launcher not allowed / 该地址不能用此工厂发射"));
        factory.newVault(token, address(0), STRANGER, abi.encode(VAULT_OWNER, address(bridge), address(nodeFund)));
    }

    function test_newVaultRejectsZeroOrEqualTargets() public {
        vm.prank(VAULT_PORTAL);
        vm.expectRevert(bytes(unicode"Bad bridge or node fund / 桥或节点基金地址无效"));
        factory.newVault(token, address(0), LAUNCHER, abi.encode(VAULT_OWNER, address(0), address(nodeFund)));

        vm.prank(VAULT_PORTAL);
        vm.expectRevert(bytes(unicode"Bad bridge or node fund / 桥或节点基金地址无效"));
        factory.newVault(token, address(0), LAUNCHER, abi.encode(VAULT_OWNER, address(bridge), address(0)));

        vm.prank(VAULT_PORTAL);
        vm.expectRevert(bytes(unicode"Bad bridge or node fund / 桥或节点基金地址无效"));
        factory.newVault(token, address(0), LAUNCHER, abi.encode(VAULT_OWNER, address(bridge), address(bridge)));
    }

    function test_newVaultRejectsCodelessTargets() public {
        vm.prank(VAULT_PORTAL);
        vm.expectRevert(bytes(unicode"Bridge or node fund has no code / 桥或节点基金不是合约"));
        factory.newVault(token, address(0), LAUNCHER, abi.encode(VAULT_OWNER, address(0xE0A), address(nodeFund)));
    }

    function test_newVaultRejectsBridgeBoundToAnotherToken() public {
        MockReleaseTarget other = new MockReleaseTarget(address(0xBAD), address(0));
        vm.prank(VAULT_PORTAL);
        vm.expectRevert(bytes(unicode"Bridge is bound to another token / 桥绑定的是别的代币"));
        factory.newVault(token, address(0), LAUNCHER, abi.encode(VAULT_OWNER, address(other), address(nodeFund)));
    }

    function test_newVaultRejectsNodeFundBoundToAnotherToken() public {
        MockReleaseTarget other = new MockReleaseTarget(address(0xBAD), address(0));
        vm.prank(VAULT_PORTAL);
        vm.expectRevert(bytes(unicode"Node fund is bound to another token / 节点基金绑定的是别的代币"));
        factory.newVault(token, address(0), LAUNCHER, abi.encode(VAULT_OWNER, address(bridge), address(other)));
    }

    function test_newVaultZeroOwnerFallsBackToCreator() public {
        vm.prank(VAULT_PORTAL);
        address v =
            factory.newVault(token, address(0), LAUNCHER, abi.encode(address(0), address(bridge), address(nodeFund)));
        assertEq(BacTreasuryVault(payable(v)).owner(), LAUNCHER);
    }

    function test_constructorRejectsZeroLauncher() public {
        vm.expectRevert(bytes(unicode"Launcher is zero / 发射地址为零"));
        new BacVaultFactory(address(0));
    }

    /* ---------------------------------------------------------------- */
    /*                              helpers                               */
    /* ---------------------------------------------------------------- */

    /// @dev `Strings.toHexString` renders lowercase; `vm.toString` renders EIP-55 checksummed.
    function _addr(address a) internal pure returns (string memory) {
        bytes memory h = bytes(vm.toString(a));
        for (uint256 i; i < h.length; ++i) {
            if (h[i] >= 0x41 && h[i] <= 0x5A) h[i] = bytes1(uint8(h[i]) + 32);
        }
        return string(h);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool hit = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }
}

/// @dev A release target that answers `bacToken()` but has no `owner()`, to prove
///      `describe()` renders "(unreadable)" instead of faking the vault owner.
contract MockNoOwner {
    address public bacToken;

    constructor(address bacToken_) {
        bacToken = bacToken_;
    }

    function acceptRelease() external payable {}
}
