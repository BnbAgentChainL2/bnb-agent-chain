// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

interface IVersioned {
    function version() external view returns (string memory);
}

interface IErc721Named {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function ownerOf(uint256 id) external view returns (address);
}

interface IErc8004Versioned {
    function getVersion() external view returns (string memory);
}

interface IPancakeRouterLike {
    function WETH() external view returns (address);
    function factory() external view returns (address);
}

interface IWbnbLike {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// @notice Toolchain smoke test: proves the BSC mainnet fork works and that every live contract
///         the BAC stack depends on since decisions #30 / #31 is where we think it is, before
///         anyone builds a fork suite on top of it: the plain Flap Portal (no VaultPortal any
///         more), the ERC-8004 Identity Registry, the PancakeSwap V2 router and WBNB.
contract ForkSmokeTest is Test {
    address internal constant PORTAL = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
    address internal constant GUARDIAN = 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b;
    address internal constant ERC8004_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    /// @dev The registry's EIP-1967 implementation as read on 2026-09-23 (research 12 §1.1).
    address internal constant ERC8004_IDENTITY_IMPL = 0x7274e874CA62410a93Bd8bf61c69d8045E399c02;
    address internal constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address internal constant PANCAKE_V2_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.bnbchain.org")));
    }

    function test_forkIsBSCMainnet() public view {
        assertEq(block.chainid, 56, "not BSC mainnet");
        assertGt(block.number, 123_000_000, "fork block too old");
    }

    function test_liveAddressesHaveCode() public view {
        assertGt(PORTAL.code.length, 0, "Portal has no code");
        assertEq(GUARDIAN.code.length, 2882, "Guardian code size changed since 2026-09-22");
        assertGt(ERC8004_IDENTITY.code.length, 0, "ERC-8004 identity registry has no code");
        assertGt(PANCAKE_V2_ROUTER.code.length, 0, "PancakeSwap V2 router has no code");
        assertGt(WBNB.code.length, 0, "WBNB has no code");
    }

    function test_portalVersionMatchesProbe() public view {
        // docs/research/12-erc8004-and-portal.md measured v5.24.0 on 2026-09-23. A change here
        // means the launch-form table (research 12 §2.3) must be re-verified before launching.
        assertEq(IVersioned(PORTAL).version(), "v5.24.0", "Portal upgraded, re-verify research 12 section 2.3");
    }

    function test_erc8004IdentityRegistry() public view {
        IErc721Named r = IErc721Named(ERC8004_IDENTITY);
        assertEq(r.name(), "AgentIdentity", "ERC-8004 registry name()");
        assertEq(r.symbol(), "AGENT", "ERC-8004 registry symbol()");
        assertTrue(r.ownerOf(1) != address(0), "agent #1 must exist (minted 2026-02-04)");
        // A UUPS proxy we do not control: its owner can swap the implementation at any time and
        // change what `ownerOf` means for our entry gate (research 12 §4.4 #16). Pinned, so a swap
        // shows up here as a red test before it shows up anywhere else.
        address impl = address(uint160(uint256(vm.load(ERC8004_IDENTITY, IMPL_SLOT))));
        assertEq(
            impl, ERC8004_IDENTITY_IMPL, "ERC-8004 registry implementation swapped: re-verify research 12 section 1"
        );
        assertEq(IErc8004Versioned(ERC8004_IDENTITY).getVersion(), "2.0.0", "ERC-8004 registry getVersion()");
    }

    function test_pancakeRouterAndWbnb() public view {
        IPancakeRouterLike r = IPancakeRouterLike(PANCAKE_V2_ROUTER);
        assertEq(r.WETH(), WBNB, "PancakeSwap V2 router's WETH() must be WBNB");
        assertEq(r.factory(), PANCAKE_V2_FACTORY, "PancakeSwap V2 factory");
        assertEq(IWbnbLike(WBNB).symbol(), "WBNB", "WBNB symbol");
        assertEq(IWbnbLike(WBNB).decimals(), 18, "WBNB decimals");
    }
}
