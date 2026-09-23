// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IBacNodeFund
/// @notice Minimal view of `BacNodeFund` (docs/01-CONTRACT-SPEC.md §5): `BacTaxRouter`'s
///         constructor cross-checks `bacToken()` before launch, `BacTaxRouter.settle()` pushes
///         the node-fund half into `acceptRelease()` (decision #30), and the site reads
///         `owner()` so the address it names as the withdrawer (decision #10) is read from
///         the chain, never typed in.
/// @dev Only those members are declared here; the router itself calls them by raw selector.
///      Extend this file (never overwrite it) when another contract needs more of §5.
interface IBacNodeFund {
    /// @notice The BAC token this node fund is bound to (immutable in `BacNodeFund`).
    function bacToken() external view returns (address);

    /// @notice The one and only address that can withdraw the node fund (two-step transferable).
    function owner() external view returns (address);

    /// @notice Permissionless entry point that credits the official node fund.
    function acceptRelease() external payable;
}
