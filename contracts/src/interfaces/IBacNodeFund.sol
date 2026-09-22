// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IBacNodeFund
/// @notice Minimal view of `BacNodeFund` (docs/01-CONTRACT-SPEC.md §5) used by the
///         vault pair: the factory cross-checks the token binding at launch, the vault
///         pushes the node-fund half into `acceptRelease()`, and `BacVaultUI.describe`
///         reads `owner()` at runtime so the disclosed withdrawer is never faked.
/// @dev Only the members the Flap pair actually calls are declared here. Extend this
///      file (never overwrite it) when another contract needs more of §5.
interface IBacNodeFund {
    /// @notice The BAC token this node fund is bound to (immutable in `BacNodeFund`).
    function bacToken() external view returns (address);

    /// @notice The one and only address that can withdraw the node fund (two-step transferable).
    function owner() external view returns (address);

    /// @notice Permissionless entry point that credits the official node fund.
    function acceptRelease() external payable;
}
