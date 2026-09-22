// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

/// @notice Fee configuration struct (returned by feeConfig() for backward compatibility).
struct PackedFeeConfig {
    uint16 marketBps;
    uint16 deflationBps;
    uint16 lpBps;
    uint16 dividendBps;
    uint16 feeRate;
    bool isWeth;
}

/// @notice Fee configuration struct (V2 — includes commission bps and dividend token).
struct PackedFeeConfigV2 {
    uint16 marketBps;
    uint16 deflationBps;
    uint16 lpBps;
    uint16 dividendBps;
    uint16 feeRate;
    bool isWeth;
    uint16 commissionBps;
    address dividendToken;
}

/// @notice Initialization parameters for TaxProcessor.
struct TaxProcessorInitParams {
    address quoteToken;
    address router;
    address feeReceiver;
    address marketAddress;
    address dividendAddress;
    address taxToken;
    uint16 feeRate;
    uint16 marketBps;
    uint16 deflationBps;
    uint16 lpBps;
    uint16 dividendBps;
    // V3 fields (pass zeros for V2 tokens)
    address dividendToken;
    address commissionReceiver;
    uint16 commissionBps;
    address converter;
    uint256 liqExpectedOutputAmount;
}

/// @notice Interface for an external tax processor that receives and distributes tax revenue.
/// @dev Deployed per-token by the Portal when launching a V2/V3 tax token.
///      After each trade on the bonding curve or DEX, the Portal calls `processBondingCurveTax()`
///      or `processTaxTokens()`. Accumulated balances are distributed via `dispatch()`.
///
///      Call `dispatch()` periodically (or after buying tokens) to send funds to:
///        - feeReceiver: protocol fee
///        - commissionReceiver: commission (V3 only, if set)
///        - marketAddress: vault / beneficiary (the main tax revenue recipient)
///        - dividendAddress: dividend contract
interface ITaxProcessor {
    // --- Initialization ---

    function initialize(TaxProcessorInitParams memory params) external;

    // --- Core Tax Processing ---

    /// @notice Process tax tokens by computing fees, splitting remainder, and handling distribution.
    function processTaxTokens(uint256 taxAmount) external returns (int8 liqThresholdDirection);

    /// @notice Process bonding curve tax by accepting quote tokens and distributing them.
    function processBondingCurveTax(uint256 quoteAmount) external;

    /// @notice Dispatch accumulated balances to receivers and dividend contract.
    /// @dev Call this to flush pending balances:
    ///        - fee → feeReceiver
    ///        - commission → commissionReceiver (if set)
    ///        - market → marketAddress (vault)
    ///        - dividend → dividendAddress
    function dispatch() external;

    // --- View: Addresses ---

    function getQuoteToken() external view returns (address);
    function weth() external view returns (address);
    function flapBlackHole() external view returns (address);
    function taxToken() external view returns (address);
    function router() external view returns (address);
    function feeReceiver() external view returns (address);
    function marketAddress() external view returns (address);
    function dividendAddress() external view returns (address);
    function commissionReceiver() external view returns (address);
    function converter() external view returns (address);
    function dividendToken() external view returns (address);
    function swapRegistry() external view returns (address);

    // --- View: Balances ---

    function feeQuoteBalance() external view returns (uint256);
    function lpQuoteBalance() external view returns (uint256);
    function marketQuoteBalance() external view returns (uint256);
    function pendingDividendQuoteTokenBalance() external view returns (uint256);
    function dividendQuoteBalance() external view returns (uint256);
    function dividendTokenBalance() external view returns (uint256);
    function commissionQuoteBalance() external view returns (uint256);

    // --- View: Config ---

    function feeConfig() external view returns (PackedFeeConfig memory);
    function feeConfigV2() external view returns (PackedFeeConfigV2 memory);
    function commissionBps() external view returns (uint16);
    function liqExpectedOutputAmount() external view returns (uint256);
    function requiresMEVProtection() external view returns (bool);

    // --- View: Totals ---

    function totalDividendTokenSent() external view returns (uint256);
    function totalQuoteSentToDividend() external view returns (uint256);
    function totalQuoteAddedToLiquidity() external view returns (uint256);
    function totalTokenAddedToLiquidity() external view returns (uint256);
    function totalQuoteSentToMarketing() external view returns (uint256);
}
