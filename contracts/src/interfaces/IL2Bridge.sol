// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal interface of the layer-side `L2Bridge` @ 0x…0101 (01-CONTRACT-SPEC §8.1).
/// @dev Only the members other layer contracts actually call are declared here. `relayer()` is the
///      single source of truth for "who is the relayer" on the layer: `L2Gate` reads it so that the
///      one cold-key rotation channel (G12) covers every relayer-gated function on the chain.
interface IL2Bridge {
    function credit(bytes32 depositId, uint256 agentId, address to, uint256 amount) external;

    function withdrawCredits(address to) external returns (uint256 amount);

    function exit(address bscRecipient) external payable returns (uint256 exitId);

    function burnFloat() external payable;

    function rotateRelayer(address newRelayer, uint256 nonce, bytes calldata sig) external;

    function relayer() external view returns (address);

    function seen(bytes32 depositId) external view returns (bool);

    function creditable(address who) external view returns (uint256);

    function totalBurnedFloat() external view returns (uint256);

    function reserve() external view returns (uint256);

    function totalCredited() external view returns (uint256);

    function totalExited() external view returns (uint256);

    function rotationNonce() external view returns (uint256);

    function exitCount() external view returns (uint64);
}
