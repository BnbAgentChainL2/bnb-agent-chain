// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

/// @title IFlapTriggerService
/// @author The Flap Team
/// @notice Interface for a generic trigger service that allows smart contracts to schedule
///         function calls to be executed by a trusted backend at a specified time or immediately.
///
/// @dev  ── OVERVIEW ──────────────────────────────────────────────────────────────
///
/// The FlapTriggerService acts as a decentralized scheduler that enables smart
/// contracts to request delayed or immediate function callbacks. This is useful for:
///   • Time-delayed operations (vesting unlocks, periodic distributions, etc.)
///   • Backend-coordinated operations requiring MEV protection
///   • Operations that need external computation before execution
///
///
/// ── WORKFLOW ───────────────────────────────────────────────────────────────────
///
/// 1. Call `getFee()` to determine the required native currency fee.
/// 2. Call `requestTrigger{value: fee}(executeAfter)` with the desired execution timestamp.
///    - Pass 0 for immediate execution.
///    - The service emits `FlapTriggerRequested` which the backend monitors.
/// 3. The backend calls `trigger(requestId)` once `executeAfter` has passed.
/// 4. FlapTriggerService calls back `requester.trigger(requestId)` within a bounded gas limit.
///
///
/// ── TIMING GUARANTEES ──────────────────────────────────────────────────────────
///
/// ⚠ IMPORTANT: Execution at `executeAfter` is NOT guaranteed. The service only
///   guarantees execution will happen **after** `executeAfter`. Integrators MUST
///   assume there can be an unpredictable delay.
///
///
/// ── REQUESTER IMPLEMENTATION GUIDE ─────────────────────────────────────────────
///
/// Implement `ITriggerReceiver` and call `requestTrigger()` with the required fee:
///
///   ```solidity
///   function scheduleOperation(uint256 executeAfter) external {
///       uint256 fee = triggerService.getFee();
///       uint256 requestId = IFlapTriggerService(triggerService)
///           .requestTrigger{value: fee}(uint64(executeAfter));
///       triggerData[requestId] = abi.encode(/* your data */);
///   }
///
///   function trigger(uint256 requestId) external {
///       require(msg.sender == address(triggerService), "Only trigger service");
///       bytes memory data = triggerData[requestId];
///       // ... execute the scheduled operation ...
///       delete triggerData[requestId];
///   }
///   ```
///
/// Deployed addresses:
///   BSC Mainnet (chainId=56): 0xcf4EE25035CF883895110f367F5BA8172416a7F9
interface IFlapTriggerService {
    // ═══════════════════════════════════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice The execution status of a trigger request.
    enum TriggerStatus {
        PENDING, // 0 - Request created, waiting to be executed
        EXECUTED, // 1 - Successfully executed by the backend
        FAILED // 2 - Execution attempted but the callback reverted
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Information about a trigger request (packed into two 32-byte storage slots).
    /// @param requester    The address of the contract that requested the trigger.
    /// @param executeAfter Unix timestamp after which this trigger may be executed (0 = immediate).
    /// @param status       Current execution status.
    /// @param feePaid      Native-currency fee paid by the requester (in wei).
    struct TriggerRequest {
        address requester; // 160 bits
        uint64 executeAfter; // 64 bits
        TriggerStatus status; // 8 bits — total slot 0: 232 bits
        uint128 feePaid; // 128 bits — slot 1
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a new trigger request is created.
    event FlapTriggerRequested(uint256 requestId, address indexed requester, uint64 executeAfter, uint256 gasFeesPaid);

    /// @notice Emitted when a trigger execution is attempted (success or failure).
    event FlapTriggerExecuted(uint256 requestId, bool success, bytes data);

    /// @notice Emitted when a trigger is skipped inside triggerMultiple() or trigger().
    event FlapTriggerSkipped(uint256 requestId, string reason);

    event FlapTriggerGasFeeUpdated(uint256 oldFee, uint256 newFee);
    event FlapTriggerMaxCallbackGasUpdated(uint256 oldLimit, uint256 newLimit);

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    error InsufficientGasFee(uint256 required, uint256 provided);
    error InvalidRequestStatus(uint256 requestId, TriggerStatus currentStatus);
    error TooEarly(uint256 requestId, uint64 executeAfter, uint256 currentTime);
    error InvalidRequestId(uint256 requestId);
    error OnlyTriggerRole();
    error InvalidGasFee();
    error InvalidGasLimit();
    error InvalidFeeReceiver();
    error RetryFailed(uint256 requestId, bytes data);
    error FeePaidOverflow(uint256 provided);

    // ═══════════════════════════════════════════════════════════════════════════════
    // WRITE METHODS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Request a trigger callback to be executed at or after a specified time.
    /// @dev `msg.value` must be >= `getFee()`.
    /// @param executeAfter Unix timestamp after which execution may occur (0 for immediate).
    /// @return requestId  Unique identifier for this trigger request.
    function requestTrigger(uint64 executeAfter) external payable returns (uint256 requestId);

    /// @notice Execute a single pending trigger request (called by backend with TRIGGER_ROLE).
    function trigger(uint256 requestId) external;

    /// @notice Execute multiple pending trigger requests in a single transaction.
    function triggerMultiple(uint256[] calldata requestIds) external;

    /// @notice Retry a previously failed trigger request (callable by anyone).
    function retryTrigger(uint256 requestId) external;

    // ═══════════════════════════════════════════════════════════════════════════════
    // VIEW METHODS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Get the required gas fee to request a trigger (in wei).
    function getFee() external view returns (uint256 gasFee);

    /// @notice Get the maximum gas forwarded to the requester's callback.
    function getMaxCallbackGas() external view returns (uint256 maxGas);

    /// @notice Get detailed information about a trigger request.
    function getRequest(uint256 requestId) external view returns (TriggerRequest memory request);

    /// @notice Get the total number of trigger requests ever created.
    function getRequestCount() external view returns (uint256 count);

    /// @notice Check whether a specific request is ready to be executed right now.
    function isRequestReady(uint256 requestId) external view returns (bool ready);

    /// @notice Get multiple requests by their IDs in a single call.
    function getRequests(uint256[] calldata requestIds) external view returns (TriggerRequest[] memory requests);

    /// @notice Get a paginated list of all requests, sorted newest first.
    function getRequestsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (TriggerRequest[] memory requests, uint256 total);

    /// @notice Get a paginated list of requests for a specific requester, sorted newest first.
    function getRequestsByRequesterPaginated(address requester, uint256 offset, uint256 limit)
        external
        view
        returns (TriggerRequest[] memory requests, uint256 total);
}

/// @title ITriggerReceiver
/// @notice Interface that requester contracts must implement to receive trigger callbacks.
/// @dev Any contract calling `requestTrigger()` on FlapTriggerService MUST implement this.
///      SECURITY: Always validate that `msg.sender == address(flapTriggerService)`.
interface ITriggerReceiver {
    /// @notice Callback function invoked by FlapTriggerService when a trigger executes.
    /// @dev MUST validate msg.sender is the FlapTriggerService address.
    ///      MUST complete within `getMaxCallbackGas()` gas limit.
    ///      MUST NOT assume execution happens exactly at the scheduled time.
    /// @param requestId The unique identifier of the trigger request being executed.
    function trigger(uint256 requestId) external;
}
