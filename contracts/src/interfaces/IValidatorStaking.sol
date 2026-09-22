// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IValidatorStaking
/// @notice Minimal interface of `ValidatorStaking` (docs/01-CONTRACT-SPEC.md §7).
///         Only the members `ChainAnchor` actually calls are declared here.
interface IValidatorStaking {
    /// @dev Weight is counted **per validator address, once** and is never capped (S5).
    function attestationResult(uint64 epoch, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block)
        external
        view
        returns (uint256 agreeingWeight, uint256 disputingWeight, uint32 agreeingCount, uint32 disputingCount);

    function totalStaked() external view returns (uint256);
}
