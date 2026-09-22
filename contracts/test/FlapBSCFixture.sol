// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

import {IPortal, IPortalTypes, IPortalTradeV2, IPortalCommonTypes} from "../src/flap/IPortal.sol";
import {IVaultPortal, IVaultPortalTypes} from "../src/flap/IVaultPortal.sol";
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
///    IVaultPortal vp = IVaultPortal(payable(VAULT_PORTAL));
///    ```
///
/// 3. Launch a V3 tax token via VaultPortal using the helper:
///
///    ```solidity
///    bytes32 salt = _findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL);
///    IVaultPortalTypes.NewTokenV6WithVaultParams memory params =
///        _buildV3TaxTokenParams(salt, address(myVaultFactory), myVaultData);
///    // Customise params before calling:
///    //   params.buyTaxRate = 300;   // override 3%
///    //   params.mktBps     = 10000; // all market allocation → vault
///    address token = IVaultPortal(payable(VAULT_PORTAL)).newTokenV6WithVault{value: params.quoteAmt}(params);
///    ```
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
/// 6. Dispatch tax to the vault (replicates what happens after each trade):
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
///   PORTAL               = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0
///   VAULT_PORTAL         = 0x90497450f2a706f1951b5bdda52B4E5d16f34C06
///   FLAP_ORACLE          = 0x6C88a672086f4A5dD8D73A93193c78a68cE4bDbe
///   FLAP_AI_PROVIDER     = 0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39
///   FLAP_TRIGGER_SERVICE = 0xcf4EE25035CF883895110f367F5BA8172416a7F9
///   FLAP_GUARDIAN        = 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b
///   TOKEN_IMPL_TAXED_V3  = 0x024f18294970B5c76c0691b87f138A0317156422
///   FLAP_BLACK_HOLE      = 0x00576E4Fb32296Cd973A0d413D0379609400DEad
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
    ///          bonding-curve buy, DEX migration, and vault dispatch.
    ///        • Acts as a regression guard: if a future code change causes gas consumption
    ///          to suddenly explode, the test will revert here rather than silently passing
    ///          with an unrealistic gas allowance.
    ///
    ///      IMPORTANT FOR VAULT DEVELOPERS:
    ///      Your vault's `initialize()` (called during `newTokenV6WithVault`) and any
    ///      callback invoked by the Flap protocol MUST complete within this budget.
    ///      If your vault performs heavy initialisation, consider deferring work to the
    ///      first `dispatch()` call or a lazy-init pattern.
    ///
    ///      The `_dispatchTax()` helper uses a tighter 1_000_000 gas cap because dispatch
    ///      is expected to be a simple BNB transfer fan-out; if your vault's `receive()`
    ///      or fallback does significant work, it must complete within that limit.
    uint256 internal constant MAX_OP_GAS = 10_000_000;

    // ──────────────────────────────────────────────────────────────────────────
    //  Protocol Addresses — BSC Mainnet
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Flap Portal contract (bonding-curve token launcher and DEX router).
    address internal constant PORTAL = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;

    /// @notice VaultPortal contract (creates V2/V3 tax tokens with associated vaults).
    /// @dev This is distinct from Portal. VaultPortal wraps Portal to attach a vault to each token.
    address payable internal constant VAULT_PORTAL = payable(0x90497450f2a706f1951b5bdda52B4E5d16f34C06);

    /// @notice Flap General Oracle for off-chain signature verification (e.g., social proofs).
    address internal constant FLAP_ORACLE = 0x6C88a672086f4A5dD8D73A93193c78a68cE4bDbe;

    /// @notice FlapAIProvider — commit-and-reveal AI reasoning oracle.
    /// @dev Consumers call reason() to submit prompts; the backend calls fulfillReasoning() to deliver results.
    address internal constant FLAP_AI_PROVIDER = 0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39;

    /// @notice FlapTriggerService — on-chain scheduler for MEV-protected delayed callbacks.
    address internal constant FLAP_TRIGGER_SERVICE = 0xcf4EE25035CF883895110f367F5BA8172416a7F9;

    /// @notice FlapGuardian — multisig with admin authority over VaultPortal and service contracts.
    address internal constant FLAP_GUARDIAN = 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b;

    /// @notice Known holder of FULFILLER_ROLE on FlapAIProvider (BSC mainnet).
    /// @dev This is the backend operator account that calls fulfillReasoning() in production.
    ///      Used by _fulfillAIRequest() and _refundAIRequest() helpers to simulate oracle behaviour.
    address internal constant FLAP_AI_FULFILLER = 0xA46710203Eafb2bF2Fe7061D628a0185eC6Aec26;

    /// @notice Known holder of TRIGGER_ROLE on FlapTriggerService (BSC mainnet).
    /// @dev This is the backend operator account that calls trigger() in production.
    ///      Used by _executeTrigger() and _executeTriggers() helpers to simulate scheduled callbacks.
    address internal constant FLAP_TRIGGER_OPERATOR = 0x80c83995FA87B20671B436aaA3a5211C02c1152e;

    /// @notice FlapXVaultFactory deployed on BSC mainnet.
    address internal constant FLAP_X_VAULT_FACTORY = 0x025549F52B03cF36f9e1a337c02d3AA7Af66ab32;

    /// @notice SplitVaultFactory deployed on BSC mainnet.
    address internal constant SPLIT_VAULT_FACTORY = 0xfab75Dc774cB9B38b91749B8833360B46a52345F;

    /// @notice SnowBallFactory deployed on BSC mainnet.
    address internal constant SNOWBALL_FACTORY = 0x036BEAA74113B7A03Bf9Fe09812fB7C9De9198b4;

    // Token implementation addresses (used in vanity salt search)

    /// @notice V1 tax token implementation (legacy).
    address internal constant TOKEN_IMPL_TAXED_V1 = 0x29e6383F0ce68507b5A72a53c2B118a118332aA8;

    /// @notice V2 tax token implementation.
    address internal constant TOKEN_IMPL_TAXED_V2 = 0xae562c6A05b798499507c6276C6Ed796027807BA;

    /// @notice V3 tax token implementation — use this for new launches via newTokenV6WithVault().
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
    IVaultPortal internal vaultPortal;
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
        vaultPortal = IVaultPortal(VAULT_PORTAL);
        flapOracle = IFlapOracle(FLAP_ORACLE);
        flapAIProvider = IFlapAIProvider(FLAP_AI_PROVIDER);
        flapTriggerService = IFlapTriggerService(FLAP_TRIGGER_SERVICE);

        _labelDeployedAddresses();
    }

    /// @notice Register human-readable labels for all deployed addresses.
    /// @dev Improves trace output readability in forge test -vvv.
    function _labelDeployedAddresses() internal {
        vm.label(PORTAL, "Portal");
        vm.label(VAULT_PORTAL, "VaultPortal");
        vm.label(FLAP_ORACLE, "FlapOracle");
        vm.label(FLAP_AI_PROVIDER, "FlapAIProvider");
        vm.label(FLAP_TRIGGER_SERVICE, "FlapTriggerService");
        vm.label(FLAP_GUARDIAN, "FlapGuardian");
        vm.label(FLAP_X_VAULT_FACTORY, "FlapXVaultFactory");
        vm.label(SPLIT_VAULT_FACTORY, "SplitVaultFactory");
        vm.label(SNOWBALL_FACTORY, "SnowBallFactory");
        vm.label(TOKEN_IMPL_TAXED_V1, "TokenImpl:TaxedV1");
        vm.label(TOKEN_IMPL_TAXED_V2, "TokenImpl:TaxedV2");
        vm.label(TOKEN_IMPL_TAXED_V3, "TokenImpl:TaxedV3");
        vm.label(TOKEN_IMPL_V2, "TokenImpl:V2");
        vm.label(FLAP_BLACK_HOLE, "FlapBlackHole");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Token Launch Helpers
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Build a scaffold `NewTokenV6WithVaultParams` for a V3 tax token with sensible defaults.
    /// @dev The returned struct uses symmetric 5% buy/sell tax, full market allocation (mktBps=10000),
    ///      no dividend, no commission, BNB as the quote token, and FOUR_FIFTHS graduation threshold.
    ///      You can override any field before passing to `newTokenV6WithVault()`.
    ///
    ///      Usage pattern:
    ///        ```solidity
    ///        bytes32 salt = _findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL);
    ///        IVaultPortalTypes.NewTokenV6WithVaultParams memory p =
    ///            _buildV3TaxTokenParams("MyToken", "MTK", salt, address(factory), vaultData);
    ///        p.buyTaxRate = 300;   // override: 3% buy tax
    ///        p.mktBps     = 5000; // override: 50% to vault, 50% to LP
    ///        address token = vaultPortal.newTokenV6WithVault{value: p.quoteAmt}(p);
    ///        ```
    ///
    /// @param name        Token name (e.g., "My Token").
    /// @param symbol      Token symbol (e.g., "MTK").
    /// @param salt        Vanity salt — must produce a token address ending in 0x7777 (VANITY_7777).
    ///                    Use `_findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL)`.
    /// @param vaultFactory Address of the registered VaultFactory to use.
    /// @param vaultData   ABI-encoded constructor arguments expected by the VaultFactory.
    /// @return params     A fully populated struct ready to pass to `vaultPortal.newTokenV6WithVault()`.
    function _buildV3TaxTokenParams(
        string memory name,
        string memory symbol,
        bytes32 salt,
        address vaultFactory,
        bytes memory vaultData
    ) internal pure returns (IVaultPortalTypes.NewTokenV6WithVaultParams memory params) {
        params = IVaultPortalTypes.NewTokenV6WithVaultParams({
                name: name,
                symbol: symbol,
                meta: "",
                dexThresh: IPortalCommonTypes.DexThreshType.FOUR_FIFTHS,
                salt: salt,
                migratorType: IPortalTypes.MigratorType.V2_MIGRATOR,
                quoteToken: address(0), // BNB
                quoteAmt: 0,
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
                // allocation: all market revenue flows to the vault
                mktBps: 10000, // 100% of remainder → vault
                deflationBps: 0,
                dividendBps: 0,
                lpBps: 0,
                minimumShareBalance: 0,
                dividendToken: address(0),
                commissionReceiver: address(0),
                tokenVersion: IPortalTypes.TokenVersion.TOKEN_TAXED_V3,
                vaultFactory: vaultFactory,
                vaultData: vaultData
            });
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
    ///        - market share → vault (the marketAddress)
    ///        - dividends    → dividendAddress
    ///      The vault's BNB balance will increase after this call.
    /// @param token Address of the FlapTaxTokenV3 whose tax should be dispatched.
    function _dispatchTax(address token) internal {
        address taxProcessor = IFlapTaxTokenV3(token).taxProcessor();
        ITaxProcessor(taxProcessor).dispatch{gas: 1_000_000}();
    }

    /// @notice Return the accumulated market quote balance for a token's TaxProcessor.
    /// @dev This is the BNB amount that will flow to the vault on the next `dispatch()`.
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

