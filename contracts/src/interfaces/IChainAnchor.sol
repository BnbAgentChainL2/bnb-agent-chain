// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IChainAnchor
/// @notice Minimal interface of `ChainAnchor` (docs/01-CONTRACT-SPEC.md §6.1, verbatim ABI).
///         The enum and the struct live here so that every consumer (BacBridge,
///         ValidatorStaking, tests, off-chain code) shares one single type definition.
interface IChainAnchor {
    enum State {
        NONE,
        POSTED,
        FINAL,
        VETOED,
        DISPUTED
    }

    struct Anchor {
        bytes32 exitRoot; // leaf = keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, to, credits, 56777, bridge)), no epoch; bridge = the BacBridge proxy
        bytes32 l2BlockHash;
        uint64 l2Block;
        uint64 postedAt;
        uint64 finalizedAt;
        uint128 creditedInEpoch;
        uint128 exitCreditsInEpoch;
        uint128 feeBurnedInEpoch;
        uint128 circulating; // informational only: TOTAL_SUPPLY - L2Bridge - FeeSink - Signer @ l2Block
        uint32 exitCount;
        uint32 agreeingCount;
        State state;
    }

    function EPOCH() external view returns (uint64);
    function EPOCHS_PER_DAY() external view returns (uint64);
    function DAY() external view returns (uint64);
    function COMMIT_WINDOW() external view returns (uint64);
    /// @notice 「锚点等待」. Renamed from `CHALLENGE_WINDOW` by decision #18.
    function ANCHOR_WAIT() external view returns (uint64);

    function getAnchor(uint64 epoch) external view returns (Anchor memory);
    /// @notice The release tier, PER DAY. The caller divides by `EPOCHS_PER_DAY`.
    function releaseBpsFor(uint64 epoch) external view returns (uint16);
    /// @notice Hash-chain head over the FINAL anchors of `day`, and whether it is final.
    function dayHeadOf(uint64 day) external view returns (bytes32 head, bool sealedDay);
    function witnessCount() external view returns (uint32);
    function haltReason() external view returns (uint8);

    function vetoKey() external view returns (address);
    function relayer() external view returns (address);
    function admin() external view returns (address);

    function firstEpoch() external view returns (uint64);
    function lastPostedEpoch() external view returns (uint64);
    function lastFinalEpoch() external view returns (uint64);
    function lastFinalAt() external view returns (uint64);
    function lastFinalCirculating() external view returns (uint256);
    function cumulativeCredited() external view returns (uint256);
    function cumulativeExit() external view returns (uint256);
    function vetoCountInWindow() external view returns (uint8);
    function disputeCountInWindow() external view returns (uint8);
}
