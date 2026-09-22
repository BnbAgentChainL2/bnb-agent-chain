// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

interface IVersioned {
    function version() external view returns (string memory);
}

/// @notice Toolchain smoke test: proves the BSC mainnet fork works and the live Flap
///         addresses in docs/research/09-chain-truth.md are reachable before anyone
///         builds a fork suite on top of them.
contract ForkSmokeTest is Test {
    address internal constant PORTAL = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
    address internal constant VAULT_PORTAL = 0x90497450f2a706f1951b5bdda52B4E5d16f34C06;
    address internal constant GUARDIAN = 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b;
    address internal constant AI_PROVIDER = 0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.bnbchain.org")));
    }

    function test_forkIsBSCMainnet() public view {
        assertEq(block.chainid, 56, "not BSC mainnet");
        assertGt(block.number, 123_000_000, "fork block too old");
    }

    function test_flapAddressesHaveCode() public view {
        assertGt(PORTAL.code.length, 0, "Portal has no code");
        assertGt(VAULT_PORTAL.code.length, 0, "VaultPortal has no code");
        assertEq(GUARDIAN.code.length, 2882, "Guardian code size changed since 2026-09-22");
        assertGt(AI_PROVIDER.code.length, 0, "AI provider has no code");
    }

    function test_portalVersionMatchesProbe() public view {
        // docs/research/09-chain-truth.md recorded v5.24.0 on 2026-09-22. A change here
        // means the launch enforcement table must be re-verified before launching.
        assertEq(IVersioned(PORTAL).version(), "v5.24.0", "Portal upgraded, re-verify 01-flap-spec");
        assertEq(IVersioned(VAULT_PORTAL).version(), "1.15.0", "VaultPortal upgraded, re-verify");
    }
}
