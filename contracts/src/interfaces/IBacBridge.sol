// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IBacBridge
/// @notice Minimal interface of `BacBridge` (docs/01-CONTRACT-SPEC.md §4.1), holding only
///         the members other contracts actually call. Extend this file, never overwrite it.
///         - `ChainAnchor` reads `totalCreditsIssued()` - that BSC-side counter is the
///           load-bearing wall of check #7 in §6.2.
///         - `BacVaultFactory` reads `bacToken()` to prove the bridge is bound to the token
///           being launched (§1.2 check 7).
///         - `BacTreasuryVault` pushes the bridge-pool half into `acceptRelease()` (§2.3).
interface IBacBridge {
    function totalCreditsIssued() external view returns (uint256);

    /// @notice The BAC token this bridge is bound to (immutable in `BacBridge`).
    function bacToken() external view returns (address);

    /// @notice Permissionless entry point that credits the bridge pool.
    function acceptRelease() external payable;
}
