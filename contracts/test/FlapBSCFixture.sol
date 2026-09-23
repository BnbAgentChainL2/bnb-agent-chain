// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

import {IPortal, IPortalTypes, IPortalTradeV2, IPortalCommonTypes} from "../src/flap/IPortal.sol";
import {IFlapOracle} from "../src/flap/IFlapOracle.sol";
import {IFlapAIProvider} from "../src/flap/IFlapAIProvider.sol";
import {IFlapTriggerService, ITriggerReceiver} from "../src/flap/IFlapTriggerService.sol";
import {ITaxProcessor} from "../src/flap/ITaxProcessor.sol";
import {IFlapTaxTokenV3} from "../src/flap/IFlapTaxTokenV3.sol";
import {VanityHelper} from "./lib/VanityHelper.sol";

// ============================================================
//  FlapBSCFixture
// ============================================================

/// @title FlapBSCFixture
/// @notice Foundry test fixture for mainnet-fork testing against BSC mainnet (chainId=56).
///
/// @dev ── HOW TO USE ────────────────────────────────────────────────────────────────
///
/// 1. Fork BSC mainnet in your `setUp()`:
///
///    ```solidity
///    function setUp() public {
///        _forkBSCMainnet();          // pins the fork to a recent block
///        _labelDeployedAddresses();  // registers human-readable labels in traces
///    }
///    ```
///
/// 2. All Flap protocol addresses are available as constants (see below).
///    Use them directly:
///
///    ```solidity
///    IPortal p = IPortal(PORTAL);
///    ```
///
/// 3. Launch a V3 tax token through the PLAIN Portal (BNB Agent Chain decision #30: no
///    VaultPortal, no vault factory, no vault — the tax `beneficiary` is any address, a contract
///    included, and the Portal does not look at it):
///
///    ```solidity
///    bytes32 salt = _findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL);
///    IPortalTypes.NewTokenV6Params memory params =
///        _buildV3TaxTokenParams("MyToken", "MTK", salt, address(myTaxReceiver));
///    // Customise params before calling:
///    //   params.buyTaxRate = 300;   // override 3%
///    address token = IPortal(PORTAL).newTokenV6{value: params.quoteAmt}(params);
///    ```
///
///    `_buildV3TaxTokenParamsV7` builds the equivalent `newTokenV7` form (one
///    `MARKETING_OR_VAULT` fee slot whose `marketingAddress` is the beneficiary).
///
/// 4. Simulate backend fulfillment of a FlapAIProvider request:
///
///    ```solidity
///    _fulfillAIRequest(requestId, choice, "ipfs://QmXxx");
///    ```
///
/// 5. Simulate backend execution of a FlapTriggerService request:
///
///    ```solidity
///    _executeTrigger(requestId);
///    ```
///
/// 6. Dispatch tax to the beneficiary (replicates what happens after each trade):
///
///    ```solidity
///    ITaxProcessor(IFlapTaxTokenV3(token).taxProcessor()).dispatch();
///    ```
///
/// 7. ── PRANK CONVENTION (IMPORTANT) ────────────────────────────────────────
///
///    Always use `vm.startPrank(user)` / `vm.stopPrank()` to wrap any block of
///    user actions.  NEVER use bare `vm.prank(user)`.
///
///    REASON: Several fixture helpers (e.g. `_sell()`, `_buyOnBC()`) issue more
///    than one external call internally (e.g. `approve` then `swapExactInput`).
///    `vm.prank()` only covers the *next* external call, so the second and
///    subsequent calls inside a helper will revert or execute as the wrong
///    sender, causing silent mis-attribution or unexpected reverts.
///
///    ✅  Correct:
///
///        ```solidity
///        vm.startPrank(user1);
///        _sell(token, amount);   // approve + swapExactInput — both covered
///        vm.stopPrank();
///        ```
///
///    ❌  Wrong:
///
///        ```solidity
///        vm.prank(user1);
///        _sell(token, amount);   // only approve is pranked; swapExactInput is not!
///        ```
///
///    This rule also applies when you need to chain two operations for the same
///    user in a row (e.g. transfer tokens to the token contract and then sell):
///
///        ```solidity
///        vm.startPrank(user1);
///        IERC20(token).transfer(token, seedAmount);
///        _sell(token, remainder);
///        vm.stopPrank();
///        ```
///
/// ── DEPLOYED ADDRESSES (BSC Mainnet) ──────────────────────────────────────────────
///
///   PORTAL               = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0   (version() = "v5.24.0")
///   FLAP_ORACLE          = 0x6C88a672086f4A5dD8D73A93193c78a68cE4bDbe
///   FLAP_AI_PROVIDER     = 0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39
///   FLAP_TRIGGER_SERVICE = 0xcf4EE25035CF883895110f367F5BA8172416a7F9
///   FLAP_GUARDIAN        = 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b
///   TOKEN_IMPL_TAXED_V3  = 0x024f18294970B5c76c0691b87f138A0317156422
///   FLAP_BLACK_HOLE      = 0x00576E4Fb32296Cd973A0d413D0379609400DEad
///   ERC8004_IDENTITY     = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432   (name() = "AgentIdentity")
///   ERC8004_REPUTATION   = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
///   PANCAKE_V2_ROUTER    = 0x10ED43C718714eb63d5aA57B78B54704E256024E
///   WBNB                 = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
///
abstract contract FlapBSCFixture is Test, VanityHelper {
    // ──────────────────────────────────────────────────────────────────────────
    //  Gas Budget Constant
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Maximum gas allowed for any single protocol operation in tests.
    ///
    /// @dev WHY 10 MILLION?
    ///
    ///      BNB Chain (BSC) runs with a very short block interval (~3 seconds) but a
    ///      deliberately constrained block gas limit (~140 M gas at time of writing, versus
    ///      Ethereum L1's ~36 M but with 12-second blocks).  In practice, each individual
    ///      protocol transaction must fit well within a single block so that validators can
    ///      include it reliably.
    ///
    ///      10_000_000 (10 M) gas is a conservative per-operation ceiling that:
    ///        • Is well below the BSC block gas limit, leaving room for other txs in the
    ///          same block and ensuring the operation is never excluded due to block fullness.
    ///        • Is generous enough to accommodate complex operations such as token launch,
    ///          bonding-curve buy, DEX migration, and tax dispatch.
    ///        • Acts as a regression guard: if a future code change causes gas consumption
    ///          to suddenly explode, the test will revert here rather than silently passing
    ///          with an unrealistic gas allowance.
    ///
    ///      The `_dispatchTax()` helper uses a tighter 1_000_000 gas cap because dispatch
    ///      is expected to be a simple BNB transfer fan-out. The beneficiary's `receive()` is
    ///      reached inside that dispatch with ~63/64 of the remaining gas (measured: the live
    ///      TaxProcessor sets no 50,000 cap; our tests use 50k as a conservative budget of our
    ///      own), and a revert there forfeits the share for good, so it must do nothing but
    ///      bookkeeping.
    uint256 internal constant MAX_OP_GAS = 10_000_000;

    // ──────────────────────────────────────────────────────────────────────────
    //  Protocol Addresses — BSC Mainnet
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Flap Portal contract (bonding-curve token launcher and DEX router).
    address internal constant PORTAL = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;

    /// @notice The `version()` string the live Portal answered on 2026-09-23. A different answer
    ///         means Flap upgraded the Portal: the launch-form table in
    ///         docs/research/12-erc8004-and-portal.md §2.3 must be re-measured before launching.
    string internal constant PORTAL_VERSION = "v5.24.0";

    /// @notice `Portal.SALT_LOCK_FEE()` — only paid by a separate `lockSalt` call.
    uint256 internal constant SALT_LOCK_FEE = 0.01 ether;

    /// @notice PancakeSwap V2 router on BSC mainnet. `BacBridge` uses it for the buyback once
    ///         BAC has graduated off the curve (a TAX token always migrates with a V2 migrator).
    address internal constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;

    /// @notice Wrapped BNB. The TaxProcessor books the quote as WBNB but pays native BNB.
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    /// @notice ERC-8004 Identity Registry on BSC mainnet (UUPS proxy, ERC-721 "AgentIdentity" /
    ///         "AGENT"), the address the erc-8004/erc-8004-contracts repository lists for chain 56.
    /// @dev Registration is open, free (non-payable) and unlimited, and the token is transferable:
    ///      holding one proves control of an identity, NOT that the holder is an AI. A second,
    ///      unrelated contract on BSC also calls itself an ERC-8004 registry
    ///      (0xfA09B3397fAC75424422C4D28b1729E3D4f659D7, "BRC8004 Identity Registry") — it is not
    ///      this one. See docs/research/12-erc8004-and-portal.md §1.
    address internal constant ERC8004_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    /// @notice ERC-8004 Reputation Registry on BSC mainnet (points back at `ERC8004_IDENTITY`).
    address internal constant ERC8004_REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    /// @notice Flap General Oracle for off-chain signature verification (e.g., social proofs).
    address internal constant FLAP_ORACLE = 0x6C88a672086f4A5dD8D73A93193c78a68cE4bDbe;

    /// @notice FlapAIProvider — commit-and-reveal AI reasoning oracle.
    /// @dev Consumers call reason() to submit prompts; the backend calls fulfillReasoning() to deliver results.
    address internal constant FLAP_AI_PROVIDER = 0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39;

    /// @notice FlapTriggerService — on-chain scheduler for MEV-protected delayed callbacks.
    address internal constant FLAP_TRIGGER_SERVICE = 0xcf4EE25035CF883895110f367F5BA8172416a7F9;

    /// @notice FlapGuardian — Flap's multisig with admin authority over its service contracts.
    address internal constant FLAP_GUARDIAN = 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b;

    /// @notice Known holder of FULFILLER_ROLE on FlapAIProvider (BSC mainnet).
    /// @dev This is the backend operator account that calls fulfillReasoning() in production.
    ///      Used by _fulfillAIRequest() and _refundAIRequest() helpers to simulate oracle behaviour.
    address internal constant FLAP_AI_FULFILLER = 0xA46710203Eafb2bF2Fe7061D628a0185eC6Aec26;

    /// @notice Known holder of TRIGGER_ROLE on FlapTriggerService (BSC mainnet).
    /// @dev This is the backend operator account that calls trigger() in production.
    ///      Used by _executeTrigger() and _executeTriggers() helpers to simulate scheduled callbacks.
    address internal constant FLAP_TRIGGER_OPERATOR = 0x80c83995FA87B20671B436aaA3a5211C02c1152e;

    // Token implementation addresses (used in vanity salt search)

    /// @notice V1 tax token implementation (legacy).
    address internal constant TOKEN_IMPL_TAXED_V1 = 0x29e6383F0ce68507b5A72a53c2B118a118332aA8;

    /// @notice V2 tax token implementation.
    address internal constant TOKEN_IMPL_TAXED_V2 = 0xae562c6A05b798499507c6276C6Ed796027807BA;

    /// @notice V3 tax token implementation — `TOKEN_TAXED_V3`, the version `newTokenV6` launches.
    /// @dev This is the implementation address passed to _findVanitySalt() to predict token addresses.
    address internal constant TOKEN_IMPL_TAXED_V3 = 0x024f18294970B5c76c0691b87f138A0317156422;

    /// @notice Non-tax token implementation (V2).
    address internal constant TOKEN_IMPL_V2 = 0x8B4329947e34B6d56D71A3385caC122BaDe7d78D;

    /// @notice Legacy Flap black hole address (burn target for deflation tokens).
    address internal constant FLAP_BLACK_HOLE = 0x00576E4Fb32296Cd973A0d413D0379609400DEad;

    // ──────────────────────────────────────────────────────────────────────────
    //  Interface handles — convenience wrappers for the deployed contracts
    // ──────────────────────────────────────────────────────────────────────────

    IPortal internal portal;
    IFlapOracle internal flapOracle;
    IFlapAIProvider internal flapAIProvider;
    IFlapTriggerService internal flapTriggerService;

    // ──────────────────────────────────────────────────────────────────────────
    //  Fork Setup
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Create and select a BSC mainnet fork, initialise interface handles, and label addresses.
    /// @dev Call this in your test's `setUp()`.  Requires the `BSC_RPC_URL` environment variable or
    ///      the `--fork-url` flag on the forge command line.
    ///
    ///      Example setUp():
    ///        ```solidity
    ///        function setUp() public {
    ///            _forkBSCMainnet();
    ///        }
    ///        ```
    function _forkBSCMainnet() internal {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.bnbchain.org"));
        vm.createSelectFork(rpcUrl);

        portal = IPortal(PORTAL);
        flapOracle = IFlapOracle(FLAP_ORACLE);
        flapAIProvider = IFlapAIProvider(FLAP_AI_PROVIDER);
        flapTriggerService = IFlapTriggerService(FLAP_TRIGGER_SERVICE);

        _labelDeployedAddresses();
    }

    /// @notice Register human-readable labels for all deployed addresses.
    /// @dev Improves trace output readability in forge test -vvv.
    function _labelDeployedAddresses() internal {
        vm.label(PORTAL, "Portal");
        vm.label(PANCAKE_V2_ROUTER, "PancakeV2Router");
        vm.label(WBNB, "WBNB");
        vm.label(ERC8004_IDENTITY, "ERC8004:Identity");
        vm.label(ERC8004_REPUTATION, "ERC8004:Reputation");
        vm.label(FLAP_ORACLE, "FlapOracle");
        vm.label(FLAP_AI_PROVIDER, "FlapAIProvider");
        vm.label(FLAP_TRIGGER_SERVICE, "FlapTriggerService");
        vm.label(FLAP_GUARDIAN, "FlapGuardian");
        vm.label(TOKEN_IMPL_TAXED_V1, "TokenImpl:TaxedV1");
        vm.label(TOKEN_IMPL_TAXED_V2, "TokenImpl:TaxedV2");
        vm.label(TOKEN_IMPL_TAXED_V3, "TokenImpl:TaxedV3");
        vm.label(TOKEN_IMPL_V2, "TokenImpl:V2");
        vm.label(FLAP_BLACK_HOLE, "FlapBlackHole");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Token Launch Helpers
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Build a scaffold plain-Portal `NewTokenV6Params` for a V3 tax token.
    /// @dev Symmetric 5% buy/sell tax, the whole market allocation to `beneficiary`
    ///      (mktBps=10000), no dividend, no commission, BNB quote, FOUR_FIFTHS threshold and
    ///      V2 migrator. The last two, and `dexId = DEX0`, were measured on 2026-09-23 as the
    ///      ONLY values the live Portal accepts (research 12 §2.3). Override any field before
    ///      passing it to `newTokenV6()`.
    ///
    ///      THE PORTAL DOES NOT CHECK `beneficiary` — not that it is a contract, not that it is
    ///      yours. Only address(0) is refused, and not by the Portal: the TaxProcessor's
    ///      initializer reverts "TaxProcessor: zero wallet1 address" (measured on a mainnet fork,
    ///      `BacForkLaunchTest.test_fork_plainPortalGuardsAndGaps`). Any non-zero address passed
    ///      here receives the tax for the life of the token.
    ///
    /// @param name        Token name (e.g., "My Token").
    /// @param symbol      Token symbol (e.g., "MTK").
    /// @param salt        Vanity salt — must produce a token address ending in 0x7777 (VANITY_7777).
    ///                    Use `_findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL)`.
    /// @param beneficiary The tax receiver (`TaxProcessor.marketAddress`).
    /// @return params     A fully populated struct ready to pass to `portal.newTokenV6()`.
    function _buildV3TaxTokenParams(string memory name, string memory symbol, bytes32 salt, address beneficiary)
        internal
        pure
        returns (IPortalTypes.NewTokenV6Params memory params)
    {
        params = IPortalTypes.NewTokenV6Params({
            name: name,
            symbol: symbol,
            meta: "",
            dexThresh: IPortalCommonTypes.DexThreshType.FOUR_FIFTHS,
            salt: salt,
            migratorType: IPortalTypes.MigratorType.V2_MIGRATOR,
            quoteToken: address(0), // BNB
            quoteAmt: 0,
            beneficiary: beneficiary,
            permitData: "",
            extensionID: bytes32(0),
            extensionData: "",
            dexId: IPortalTypes.DEXId.DEX0,
            lpFeeProfile: IPortalTypes.V3LPFeeProfile.LP_FEE_PROFILE_STANDARD,
            // tax fields (symmetric 5%)
            buyTaxRate: 500, // 5%
            sellTaxRate: 500, // 5%
            taxDuration: uint64(100 * 365 days),
            antiFarmerDuration: uint64(1 days),
            // allocation: all market revenue flows to the beneficiary
            mktBps: 10000, // 100% of remainder -> beneficiary
            deflationBps: 0,
            dividendBps: 0,
            lpBps: 0,
            minimumShareBalance: 0,
            dividendToken: address(0),
            commissionReceiver: address(0),
            tokenVersion: IPortalTypes.TokenVersion.TOKEN_TAXED_V3
        });
    }

    /// @notice The same form as `_buildV3TaxTokenParams`, spelled as `NewTokenV7Params`.
    /// @dev V7 has no `beneficiary` field: per Flap's docs, the first `MARKETING_OR_VAULT` slot's
    ///      `marketingAddress` becomes the primary beneficiary. The other three slots stay `NONE`.
    ///      V7 also has no `lpFeeProfile`.
    function _buildV3TaxTokenParamsV7(string memory name, string memory symbol, bytes32 salt, address beneficiary)
        internal
        pure
        returns (IPortalTypes.NewTokenV7Params memory params)
    {
        params.name = name;
        params.symbol = symbol;
        params.dexThresh = IPortalCommonTypes.DexThreshType.FOUR_FIFTHS;
        params.salt = salt;
        params.migratorType = IPortalTypes.MigratorType.V2_MIGRATOR;
        params.quoteToken = address(0);
        params.dexId = IPortalTypes.DEXId.DEX0;
        params.buyTaxRate = 500;
        params.sellTaxRate = 500;
        params.taxDuration = uint64(100 * 365 days);
        params.antiFarmerDuration = uint64(1 days);
        params.tokenVersion = IPortalTypes.TokenVersion.TOKEN_TAXED_V3;
        params.feeConfigs[0] = IPortalTypes.FeeConfig({
            feeType: IPortalTypes.FeeType.MARKETING_OR_VAULT,
            bps: 10000,
            marketingAddress: beneficiary,
            dividendToken: address(0),
            minimumShareBalance: 0
        });
    }

    /// @notice Fails unless the live Portal still answers the version this fixture was measured on.
    function _assertPortalVersion() internal view {
        (bool ok, bytes memory ret) = PORTAL.staticcall(abi.encodeWithSignature("version()"));
        require(ok, "Portal has no version()");
        assertEq(abi.decode(ret, (string)), PORTAL_VERSION, "Portal upgraded: re-verify research 12 section 2.3");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  ERC-8004 Helpers
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Mint a real ERC-8004 identity on the live registry, owned by `holder`.
    /// @dev `register(string agentURI)` (selector 0xf2c298be) is open, free and non-payable and
    ///      returns the new, sequential agent id. This goes through the real registry proxy on
    ///      the fork — nothing is mocked. Wrapped in start/stopPrank (see PRANK CONVENTION).
    function _registerAgent(address holder, string memory agentURI) internal returns (uint256 agentId) {
        vm.startPrank(holder);
        (bool ok, bytes memory ret) = ERC8004_IDENTITY.call(abi.encodeWithSignature("register(string)", agentURI));
        vm.stopPrank();
        require(ok && ret.length == 32, "ERC-8004 register(string) failed");
        agentId = abi.decode(ret, (uint256));
    }

    /// @notice `ownerOf(agentId)` on the live registry, or address(0) when it reverts.
    function _identityOwner(uint256 agentId) internal view returns (address) {
        (bool ok, bytes memory ret) = ERC8004_IDENTITY.staticcall(abi.encodeWithSignature("ownerOf(uint256)", agentId));
        if (!ok || ret.length != 32) return address(0);
        return abi.decode(ret, (address));
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  FlapAIProvider Simulation Helpers
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Simulate the FlapAIProvider backend fulfilling a pending reasoning request.
    /// @dev Pranks as an address that holds FULFILLER_ROLE on the deployed FlapAIProvider.
    ///      FULFILLER_ROLE is a bytes32 role on the AccessControl-protected FlapAIProvider contract.
    ///      We use `vm.prank` to impersonate the known guardian which holds this role on mainnet,
    ///      or we grant it via storage manipulation for unit-test environments.
    ///
    ///      In fork tests this call reaches the live FlapAIProvider, so the consumer's
    ///      `fulfillReasoning(requestId, choice)` callback will be invoked exactly as the
    ///      backend would invoke it.
    ///
    /// @param requestId              The pending request ID returned by `reason()`.
    /// @param choice                 The choice index to deliver (0..numOfChoices-1).
    /// @param reasoningDetailsIpfsCid IPFS CID of the reasoning proof (can be any non-empty string in tests).
    function _fulfillAIRequest(uint256 requestId, uint8 choice, string memory reasoningDetailsIpfsCid) internal {
        vm.prank(FLAP_AI_FULFILLER);
        flapAIProvider.fulfillReasoning(requestId, choice, reasoningDetailsIpfsCid);
    }

    /// @notice Simulate the FlapAIProvider backend refunding a pending request.
    /// @param requestId The pending request ID to refund.
    function _refundAIRequest(uint256 requestId) internal {
        vm.prank(FLAP_AI_FULFILLER);
        flapAIProvider.refundRequest(requestId);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  FlapTriggerService Simulation Helpers
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Simulate the FlapTriggerService backend executing a pending trigger.
    /// @dev Pranks as an address that holds TRIGGER_ROLE on the deployed FlapTriggerService.
    ///      The requester's `trigger(requestId)` callback is invoked with the same gas cap
    ///      as the real backend (`getMaxCallbackGas()`).
    ///
    ///      If the request has an `executeAfter` timestamp in the future, use `vm.warp()`
    ///      to advance time before calling this helper:
    ///        ```solidity
    ///        vm.warp(block.timestamp + 1 days);
    ///        _executeTrigger(requestId);
    ///        ```
    ///
    /// @param requestId The pending request ID returned by `requestTrigger()`.
    function _executeTrigger(uint256 requestId) internal {
        vm.prank(FLAP_TRIGGER_OPERATOR);
        flapTriggerService.trigger(requestId);
    }

    /// @notice Simulate the FlapTriggerService backend executing multiple triggers in a batch.
    /// @param requestIds Array of pending request IDs to execute.
    function _executeTriggers(uint256[] memory requestIds) internal {
        vm.prank(FLAP_TRIGGER_OPERATOR);
        flapTriggerService.triggerMultiple(requestIds);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Tax Dispatch Helpers
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Dispatch accumulated tax revenue from a token's TaxProcessor to its receivers.
    /// @dev Calls `ITaxProcessor(taxProcessor).dispatch()` which flushes:
    ///        - protocol fee → feeReceiver
    ///        - commission   → commissionReceiver (if set)
    ///        - market share → the beneficiary (the marketAddress), as a plain native transfer
    ///        - dividends    → dividendAddress
    ///      The beneficiary's BNB balance will increase after this call.
    /// @param token Address of the FlapTaxTokenV3 whose tax should be dispatched.
    function _dispatchTax(address token) internal {
        address taxProcessor = IFlapTaxTokenV3(token).taxProcessor();
        ITaxProcessor(taxProcessor).dispatch{gas: 1_000_000}();
    }

    /// @notice Return the accumulated market quote balance for a token's TaxProcessor.
    /// @dev This is the BNB amount that will flow to the beneficiary on the next `dispatch()`.
    /// @param token Address of the FlapTaxTokenV3.
    function _pendingMarketBalance(address token) internal view returns (uint256) {
        address taxProcessor = IFlapTaxTokenV3(token).taxProcessor();
        return ITaxProcessor(taxProcessor).marketQuoteBalance();
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Trade Helpers
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Buy a token on the bonding curve using BNB.
    /// @param token     The token address to buy.
    /// @param bnbAmount Amount of BNB to spend (in wei).
    /// @return received Amount of tokens received.
    function _buyOnBC(address token, uint256 bnbAmount) internal returns (uint256 received) {
        IPortalTradeV2.ExactInputParams memory p = IPortalTradeV2.ExactInputParams({
            inputToken: address(0), // BNB
            outputToken: token,
            inputAmount: bnbAmount,
            minOutputAmount: 0,
            permitData: ""
        });
        received = portal.swapExactInput{value: bnbAmount, gas: MAX_OP_GAS}(p);
    }

    /// @notice Sell tokens on the bonding curve (or DEX if graduated) for BNB.
    /// @dev Approves the portal before selling.
    /// @param token       The token address to sell.
    /// @param tokenAmount Amount of tokens to sell.
    /// @return received   Amount of BNB received.
    function _sell(address token, uint256 tokenAmount) internal returns (uint256 received) {
        IERC20(token).approve(address(portal), tokenAmount);
        IPortalTradeV2.ExactInputParams memory p = IPortalTradeV2.ExactInputParams({
            inputToken: token,
            outputToken: address(0), // BNB
            inputAmount: tokenAmount,
            minOutputAmount: 0,
            permitData: ""
        });
        received = portal.swapExactInput{gas: MAX_OP_GAS}(p);
    }
}

