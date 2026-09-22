// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @title IFlapCandyBox
/// @notice Interface for the Flap Candy Box data oracle service.
///         Consumers call requestData() to request off-chain data; the trusted fulfiller
///         calls fulfillData() to deliver the result via a callback.
interface IFlapCandyBox {
    // ═══════════════════════════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Lifecycle status of a data request.
    enum RequestStatus {
        PENDING, // 0 – created, waiting for fulfiller
        FULFILLED, // 1 – data delivered and consumer callback succeeded
        FAILED // 2 – data delivered but consumer callback reverted; eligible for retry
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    struct Subscription {
        bytes32 subscriptionId;
        string description;
        string responseStruct; // name of the ResponseData struct, e.g. "ResponseData"
        uint256 fee; // required msg.value per requestData() call (wei)
        uint32 maxLimit; // maximum allowed limit per request
        bool active;
    }

    struct OracleRequest {
        address consumer;
        bytes32 subscriptionId;
        uint64 timestamp; // caller's current timestamp; backend derives the previous day's range
        uint32 offset;
        uint32 limit;
        bytes extraParams;
        uint128 feePaid;
        RequestStatus status;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RESPONSE STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    struct AddressRecord {
        address wallet;
        uint256 tradeAmount;
    }

    /// @notice Paginated response payload delivered to consumers via onDataReceived().
    struct ResponseData {
        uint256 totalSize; // total records matching the query across all pages
        uint256 offset; // zero-based index of the first record in this page
        uint256 returnedCount; // actual number of records in this page
        bool isDesc; // true if sorted by tradeAmount descending
        uint64 startTime; // query window start (Unix timestamp)
        uint64 endTime; // query window end (Unix timestamp)
        uint256 totalAmount; // sum of tradeAmount across ALL matching records (not just this page)
        AddressRecord[] records;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event FlapSubscriptionRegistered(bytes32 indexed subscriptionId, string description, uint256 fee);
    event FlapSubscriptionFeeUpdated(bytes32 indexed subscriptionId, uint256 oldFee, uint256 newFee);
    event FlapSubscriptionLimitUpdated(bytes32 indexed subscriptionId, uint32 oldLimit, uint32 newLimit);
    event FlapDataRequested(
        bytes32 indexed subscriptionId,
        bytes32 indexed requestId,
        address indexed consumer,
        uint64 timestamp,
        uint32 offset,
        uint32 limit,
        uint256 feePaid,
        bytes extraParams
    );
    event FlapDataFulfilled(bytes32 indexed subscriptionId, bytes32 indexed requestId, bool success, bytes returnData);
    event FlapFulfillerUpdated(address indexed fulfiller, bool authorized);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error InvalidSubscription(bytes32 subscriptionId);
    error SubscriptionAlreadyExists(bytes32 subscriptionId);
    error InsufficientFee(uint256 required, uint256 provided);
    error FeePaidOverflow(uint256 provided);
    error LimitExceeded(uint32 requested, uint32 max);
    error AlreadyFulfilled(bytes32 requestId);
    error InvalidRequestId(bytes32 requestId);
    error InvalidFeeReceiver();
    error OnlyFulfiller();
    error RequestNotFailed(bytes32 requestId, RequestStatus status);
    error RetryFailed(bytes32 requestId, bytes returnData);

    // ═══════════════════════════════════════════════════════════════════════
    // WRITE
    // ═══════════════════════════════════════════════════════════════════════

    function requestData(
        bytes32 subscriptionId,
        uint64 timestamp,
        uint32 offset,
        uint32 limit,
        bytes calldata extraParams
    ) external payable returns (bytes32 requestId);

    /// @notice Deliver data for a pending request (fulfiller only).
    ///         Sets status to FULFILLED on callback success, FAILED on callback revert.
    function fulfillData(bytes32 requestId, bytes calldata data) external;

    /// @notice Retry delivery for a FAILED request (fulfiller only).
    ///         Reverts with RetryFailed if the consumer callback reverts again.
    function retryFulfillData(bytes32 requestId, bytes calldata data) external;

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════════════════════════════════════

    function getSubscription(bytes32 subscriptionId) external view returns (Subscription memory);
    function getSubscriptions() external view returns (Subscription[] memory);
    function getFee(bytes32 subscriptionId) external view returns (uint256);
    function getMaxLimit(bytes32 subscriptionId) external view returns (uint32);
    function getRequest(bytes32 requestId) external view returns (OracleRequest memory);
    function getMaxCallbackGas() external view returns (uint256);

    /// @notice Update the maxLimit for an existing subscription (admin only).
    function setSubscriptionLimit(bytes32 subscriptionId, uint32 newLimit) external;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSUMER BASE
// ═══════════════════════════════════════════════════════════════════════════

/// @notice Base contract for FlapCandyBox consumers.
/// @dev Inherit this to get address resolution and the onlyFlapCandyBox modifier for free.
abstract contract FlapCandyBoxConsumerBase {
    error FlapCandyBoxConsumerOnlyBox();
    error FlapCandyBoxConsumerUnsupportedChain(uint256 chainId);

    modifier onlyFlapCandyBox() {
        if (msg.sender != _getFlapCandyBox()) revert FlapCandyBoxConsumerOnlyBox();
        _;
    }

    /// @notice Returns the FlapCandyBox proxy address for the current chain.
    function _getFlapCandyBox() internal view virtual returns (address) {
        uint256 id = block.chainid;
        if (id == 56) {
            return 0x6255fbd731272a517022e99f6CaCf6A5De9414Ee; // BSC Mainnet
        } else if (id == 97) {
            return 0x8e6C16Bf07022a7Da9398B543f38846E9355Bd70; // BSC Testnet
        } else {
            revert FlapCandyBoxConsumerUnsupportedChain(id);
        }
    }

    function onDataReceived(bytes32 subscriptionId, bytes32 requestId, bytes calldata data)
        external
        virtual
        onlyFlapCandyBox
    {
        _onDataReceived(subscriptionId, requestId, data);
    }

    function _onDataReceived(bytes32 subscriptionId, bytes32 requestId, bytes calldata data) internal virtual;
}

/// @notice Minimal interface for consumers that prefer not to use the base contract.
interface IFlapCandyBoxConsumer {
    function onDataReceived(bytes32 subscriptionId, bytes32 requestId, bytes calldata data) external;
}
