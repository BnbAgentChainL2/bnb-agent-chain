// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

import {IPortalTypes} from "./IPortal.sol";

// Version marker passed to `resolveDividendToken(...)` when launch params are encoded as
// `IVaultPortalTypes.NewTokenV6WithVaultParams`.
uint8 constant DIVIDEND_TOKEN_LAUNCH_VERSION_V6 = 6;

// Version marker passed to `resolveDividendToken(...)` when launch params are encoded as
// `IVaultPortalTypes.NewTokenV7WithVaultParams`.
uint8 constant DIVIDEND_TOKEN_LAUNCH_VERSION_V7 = 7;

/// @title IVaultFactory
/// @notice Interface that all vault factory contracts must implement
/// @dev Each vault type must have a corresponding factory contract that implements this interface
interface IVaultFactory {
    /* ========== ERRORS ========== */

    /// @notice Thrown when caller is not the vault portal
    error OnlyVaultPortal();

    /// @notice Thrown when zero address is provided
    error ZeroAddress();

    /* ========== FUNCTIONS ========== */
    /// @notice Creates a new vault instance for a tax token
    /// @dev IMPORTANT: The taxToken does not exist yet when this method is called.
    ///      The VaultPortal predicts the token address and passes it here.
    ///      The actual token will be created AFTER the vault is created.
    /// @param taxToken The predicted address of the tax token (not yet deployed)
    /// @param quoteToken The quote token address (e.g., address(0) for native BNB)
    /// @param creator The original msg.sender to VaultPortal who initiated token creation
    /// @param vaultData Custom encoded data specific to this vault type
    /// @return vault The address of the newly created vault
    function newVault(address taxToken, address quoteToken, address creator, bytes calldata vaultData)
        external
        returns (address vault);

    /// @notice Checks if a quote token is supported by this vault factory
    /// @param quoteToken The quote token address to check
    /// @return supported True if the quote token is supported, false otherwise
    function isQuoteTokenSupported(address quoteToken) external view returns (bool supported);
}

/// @title IVaultFactoryDividendV23
/// @notice Optional factory-spec v2.3 extension for computed dividend-token resolution.
/// @dev    Only factories that explicitly opt into v2.3 need to implement this interface.
interface IVaultFactoryDividendV23 {
    /// @notice Resolve the dividend token for a predicted (not yet deployed) tax token.
    /// @dev    VaultPortal calls this only when the launcher supplied MAGIC_DIVIDEND_COMPUTED.
    /// @param predictedToken The CREATE2-predicted tax-token address.
    /// @param launchVersion The wrapper parameter version. Current callers use
    ///        `DIVIDEND_TOKEN_LAUNCH_VERSION_V6` for `NewTokenV6WithVaultParams`
    ///        and `DIVIDEND_TOKEN_LAUNCH_VERSION_V7` for `NewTokenV7WithVaultParams`.
    /// @param launchParams ABI-encoded wrapper launch params. Current callers pass
    ///        `abi.encode(NewTokenV6WithVaultParams)` or `abi.encode(NewTokenV7WithVaultParams)`.
    /// @return dividendToken The actual dividend token to forward into Portal.
    function resolveDividendToken(address predictedToken, uint8 launchVersion, bytes calldata launchParams)
        external
        view
        returns (address dividendToken);
}

/// @title IVaultFactoryValidationV2
/// @notice Optional validation extension introduced by factory spec v2.2.
/// @dev    Kept in the same file as `IVaultFactory` for discoverability, but intentionally
///         separated as its own interface because `onBeforeLaunch(...)` is not a mandatory
///         requirement for legacy vault factories.
interface IVaultFactoryValidationV2 {
    /// @notice Stable validation payload used by VaultPortal when talking to v2.2+ factories.
    /// @dev    This payload intentionally contains normalized launch semantics instead of
    ///         wrapper-specific structs such as `NewTokenV6WithVaultParams` or `NewTokenV7WithVaultParams`.
    struct LaunchValidationDataV1 {
        IPortalTypes.TokenVersion tokenVersion;
        address quoteToken;
        uint16 buyTaxRate;
        uint16 sellTaxRate;
        uint16 vaultBps;
        uint16 deflationBps;
        uint16 dividendBps;
        uint16 lpBps;
        address dividendToken;
        uint256 minimumShareBalance;
    }

    /// @notice Generic pre-launch validation hook.
    /// @param validationData ABI-encoded normalized launch payload.
    /// @return success True when the launch satisfies this factory's product constraints.
    /// @return reason Human-readable explanation when `success` is false.
    function onBeforeLaunch(bytes calldata validationData) external view returns (bool success, string memory reason);
}

