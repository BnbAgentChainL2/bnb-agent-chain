// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal interface of the layer-side `L2Gate` @ 0x…0102 (01-CONTRACT-SPEC §8.2).
/// @dev ABI copied verbatim from the spec. `isAdmitted` is the ONLY place the layer reads an
///      agent *status*; `agentIdOf` is a pure table lookup that never consults the status (G11).
///      Since decision #31 the only BSC fact left to feed `applySync` is `BacBridge.Locked`, and
///      the `status` argument has two live values: 0 NONE and 2 ACTIVE. What `applySync` must
///      become for ERC-8004 identities is still open — see `L2Gate`'s header.
interface IL2Gate {
    function applySync(uint256 agentId, address wallet, uint8 status, uint64 bscBlock) external;

    function isAdmitted(address wallet) external view returns (bool);

    function agentIdOf(address wallet) external view returns (uint256);

    function statusOf(address wallet) external view returns (uint8);
}
