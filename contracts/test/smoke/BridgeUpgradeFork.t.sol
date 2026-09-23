// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {BacBridge} from "../../src/BacBridge.sol";

/// @notice Rehearses, on a BSC mainnet fork, the one upgrade decision #38 plans before the launch:
///         the LIVE bridge proxy (decision #39) moved from the deployed v1 implementation to the
///         current `BacBridge` source (v1.1: per-debt maturity, the emergency self-recipient
///         guard). It proves the storage layout is upgrade-compatible AGAINST THE REAL DEPLOYED
///         STATE, not only against a test deployment: every sequential slot is read raw before and
///         after, and only the upgrade counters may move.
/// @dev    Fork test: lives under `test/smoke/`, excluded from the non-fork run. Nothing is sent —
///         the owner is impersonated with a prank inside the forked EVM, no key is read.
contract BridgeUpgradeForkTest is Test {
    // decision #39 / deployments/bsc-mainnet.json
    address internal constant PROXY = 0x2129f336ff42821afa27fE5928Dec36Ba90d3508;
    address internal constant IMPL_V1 = 0xe825be69C9870F01A536d15a6ec58bC2eb45e4b2;
    address internal constant OWNER = 0x934a6678120b85652D2CC818C69774ea17012844;
    address internal constant BAC_TOKEN = 0xA97452d175679B2bF5F25a9a382D22aff39b7777;
    address internal constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant ANCHOR = 0xe6cCCD4809905152588f31417408c4Af9043b406;
    address internal constant WATCHDOG = 0x51b6D9a3665c74FFef80ca8d3898edB9DeBcDb55;

    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 internal constant COUNTERS_SLOT = 349;
    uint256 internal constant LAST_SLOT = 391; // v1: __gap[42] at 350..391; v1.1: 350, 351 + __gap[40]

    string internal constant NOTICE_29A = unicode"项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。";

    BacBridge internal bridge = BacBridge(PROXY);

    function setUp() public {
        vm.createSelectFork(vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.bnbchain.org")));
    }

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(PROXY, IMPL_SLOT))));
    }

    function test_fork_liveProxyUpgradesToV11WithEverySlotIntact() public {
        // ── it is our bridge, as deployed ────────────────────────────────────────────────────
        assertEq(bridge.owner(), OWNER, "live owner");
        assertEq(bridge.bacToken(), BAC_TOKEN, "live bacToken");
        assertEq(bridge.identityRegistry(), IDENTITY);
        assertEq(bridge.anchor(), ANCHOR);
        assertEq(bridge.watchdog(), WATCHDOG);
        address before = _impl();
        if (before != IMPL_V1) emit log_named_address("NOTE: the live proxy is already past v1, at", before);
        // v1.1 also dates debt from before its claim history by `lastClaimAt`, but the plan
        // (decision #38) is to upgrade while nothing is owed; say so if that ever changes
        if (bridge.owedTotal() != 0) emit log_named_uint("NOTE: live owedTotal at upgrade time", bridge.owedTotal());

        // ── raw snapshot of every sequential slot ────────────────────────────────────────────
        bytes32[] memory snap = new bytes32[](LAST_SLOT + 1);
        for (uint256 s = 0; s <= LAST_SLOT; s++) {
            snap[s] = vm.load(PROXY, bytes32(s));
        }
        uint64 upgradesBefore = bridge.upgradeCount();

        // ── the upgrade: owner-only ──────────────────────────────────────────────────────────
        BacBridge v11 = new BacBridge();
        assertLe(address(v11).code.length, 24_576, "EIP-170");
        assertLe(v11.EXTENSION().code.length, 24_576, "EIP-170 (extension)");

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bytes(unicode"Only owner / 仅限 owner"));
        bridge.upgradeTo(address(v11));

        vm.recordLogs();
        vm.prank(OWNER);
        bridge.upgradeTo(address(v11));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawBridgeUpgraded;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == PROXY && logs[i].topics[0] == BacBridge.BridgeUpgraded.selector) {
                sawBridgeUpgraded = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(v11), "new implementation");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), before, "replaced implementation");
            }
        }
        assertTrue(sawBridgeUpgraded, "BridgeUpgraded must be logged (#29c)");
        assertEq(_impl(), address(v11));

        // ── every slot intact; only the upgrade half of the counters slot moved ─────────────
        for (uint256 s = 0; s <= LAST_SLOT; s++) {
            if (s == COUNTERS_SLOT) continue;
            assertEq(vm.load(PROXY, bytes32(s)), snap[s], string.concat("slot moved: ", vm.toString(s)));
        }
        uint256 w = uint256(vm.load(PROXY, bytes32(COUNTERS_SLOT)));
        uint256 old = uint256(snap[COUNTERS_SLOT]);
        assertEq(w & type(uint128).max, old & type(uint128).max, "the emergency counters did not move");
        assertEq(uint64(w >> 128), upgradesBefore + 1, "upgradeCount");
        assertEq(uint64(w >> 192), vm.getBlockTimestamp(), "lastUpgradeAt");

        // ── the wiring reads back through the new code, and the disclosure is unchanged ─────
        assertEq(bridge.owner(), OWNER);
        assertEq(bridge.bacToken(), BAC_TOKEN);
        assertEq(bridge.OWNER_POWER_NOTICE(), NOTICE_29A);
        assertEq(bridge.EXTENSION(), v11.EXTENSION());

        // ── v1.1 behaviour is live ───────────────────────────────────────────────────────────
        assertEq(bridge.maturedOwed(OWNER), 0);
        assertEq(bridge.owedPaid(OWNER), 0);
        vm.startPrank(OWNER);
        vm.expectRevert(bytes(unicode"Recipient is the bridge / 收款地址不能是桥本身"));
        bridge.emergencyWithdrawBnb(payable(PROXY), 0);
        vm.expectRevert(bytes(unicode"Recipient is the bridge / 收款地址不能是桥本身"));
        bridge.emergencyWithdrawToken(BAC_TOKEN, PROXY, 0);
        vm.stopPrank();

        // the delegated paths reach the NEW extension
        vm.prank(WATCHDOG);
        bridge.pause();
        (bool paused,,) = bridge.isPaused();
        assertTrue(paused);
    }
}
