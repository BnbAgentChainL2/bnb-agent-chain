// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IAgentRegistry
/// @notice Minimal view of `AgentRegistry` (docs/01-CONTRACT-SPEC.md §3) used by `BacBridge`.
/// @dev `BacBridge` reads the registry in exactly two places: `lock` (entry is gated on
///      `isActive`) and `escapeCollect` (caller must be the controller or the agent wallet,
///      status is NOT consulted — G11: exiting is never gated on status). Only the members
///      `BacBridge` actually calls are declared here; extend this file, never overwrite it.
interface IAgentRegistry {
    enum Status {
        NONE,
        CHALLENGED,
        ACTIVE,
        DORMANT,
        BANNED,
        RETIRED
    }

    struct Agent {
        address controller;
        address agentWallet;
        string agentURI;
        bytes32 endpointHash;
        bytes32 modelFingerprint;
        uint64 registeredAt;
        uint64 lastHeartbeatEpoch;
        uint32 missedEpochs;
        uint32 solvedChallenges;
        uint96 deposit;
        Status status;
    }

    /// @notice True only for `Status.ACTIVE`. Gates entry into the bridge, never the exit.
    function isActive(uint256 agentId) external view returns (bool);

    /// @notice The full agent record; `BacBridge` uses `controller` and `agentWallet`.
    function getAgent(uint256 agentId) external view returns (Agent memory);
}
