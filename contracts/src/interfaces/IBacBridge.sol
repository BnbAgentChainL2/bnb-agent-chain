// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IBacBridge
/// @notice Minimal interface of `BacBridge` (docs/01-CONTRACT-SPEC.md §4.1), holding only
///         the members other contracts actually call. Extend this file, never overwrite it.
///         - `ChainAnchor` reads `totalCreditsIssued()` - that BSC-side counter is the
///           load-bearing wall of check #7 in §6.2.
///         - `BacTaxRouter`'s constructor reads `bacToken()` to prove the bridge is bound to the
///           token being launched, and `settle()` pushes the bridge-pool half into
///           `acceptRelease()` (decision #30). The router calls both by raw selector, so these
///           two signatures must survive every upgrade of the bridge unchanged.
/// @dev Since decision #29 `BacBridge` sits behind an ERC1967 (UUPS) proxy. Every address that
///      is cast to this interface anywhere must be the PROXY: the implementation's own storage is
///      never initialised, so on it `bacToken()` returns address(0) and `totalCreditsIssued()`
///      returns 0.
interface IBacBridge {
    function totalCreditsIssued() external view returns (uint256);

    /// @notice The BAC token this bridge is bound to (proxy storage, written once by
    ///         `initialize`, no setter; changing it would take an upgrade).
    function bacToken() external view returns (address);

    /// @notice Permissionless entry point that credits the bridge pool.
    function acceptRelease() external payable;
}
