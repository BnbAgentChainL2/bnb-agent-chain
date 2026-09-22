// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

// ============================================================
//                    IFlapAIProvider Interface
// ============================================================

/// @title IFlapAIProvider
/// @notice Oracle interface for the FlapAIProvider commit-and-reveal AI reasoning service.
/// @dev The FlapAIProvider operates as a commit-and-reveal oracle inspired by Chainlink VRF.
///      Consumers (Vault contracts) submit a reasoning request on-chain by calling `reason()`,
///      which emits an event. The off-chain oracle backend picks up the event, feeds the prompt
///      to an LLM, and posts the result back via `fulfillReasoning()`. If the backend cannot
///      process the request, it calls `refundRequest()` to return the BNB fee and notify the
///      consumer. Consumers must extend `FlapAIConsumerBase` to receive callbacks securely.
///
///      TOOL CALLING: The oracle backend supports tool calling, allowing the LLM to fetch
///      real-time external data (e.g. token market data, prices) before producing its choice.
///      Consumers embed tool invocations in the prompt using a structured format; the backend
///      executes the tools and injects their results into the LLM context automatically.
///      For the full list of supported tools, see:
///        https://docs.flap.sh/flap/developers/preview/flap-ai-oracle
///
///      Example — `ave_token_info` tool:
///        "I am managing a vault for token 0x....7777, "
///        "my main goal is to use my fund to market making for this token. "
///        "Check the market data (use ave_token_info tool) of this token and then decide what to do: "
///        "(0) buy tokens to support the floor "
///        "(1) sell my holdings to gain more funds for future market making "
///        "(2) generate volumes only (i.e: buy and then sell immediately)."
///
/// Deployed addresses:
///   BSC Mainnet (chainId=56): 0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39
///   BSC Testnet (chainId=97): 0xFfddcE44e8cFf7703Fd85118524bfC8B2f70b744
interface IFlapAIProvider {
    // ----------------------------------------------------------------
    //  Structs
    // ----------------------------------------------------------------

    /// @notice Represents a registered LLM model.
    /// @param name   Human-readable name of the model (e.g. "gpt-4").
    /// @param price  Per-request fee in native currency (BNB), in wei.
    /// @param enabled Whether the model currently accepts new requests.
    struct Model {
        string name;
        uint256 price;
        bool enabled;
    }

    /// @notice Lifecycle state of an AI reasoning request.
    /// @dev NONE      = default, request was never created.
    ///      PENDING   = request submitted on-chain, awaiting oracle fulfillment.
    ///      FULFILLED = oracle fulfilled the request and consumer callback succeeded.
    ///      UNDELIVERED = oracle fulfilled but consumer callback reverted (result stored but not delivered).
    ///      REFUNDED  = oracle refunded the request fee to the consumer.
    enum RequestStatus {
        NONE,
        PENDING,
        FULFILLED,
        UNDELIVERED,
        REFUNDED
    }

    /// @notice Stores all data for a single AI reasoning request.
    /// @dev Tightly packed into two 32-byte storage slots.
    /// @param consumer     Address of the consuming contract that submitted the request.
    /// @param modelId      ID of the LLM model used (max 65535 distinct models).
    /// @param numOfChoices Number of choices the LLM can pick from (valid range 0..numOfChoices-1).
    /// @param timestamp    `block.timestamp` when the request was submitted via `reason()`.
    /// @param feePaid      BNB amount paid with the request (full `msg.value`), capped at uint128.
    /// @param status       Current lifecycle status of the request.
    /// @param choice       The LLM's chosen action index; only valid when status is FULFILLED or UNDELIVERED.
    /// @param reserved     Reserved for future upgrades.
    struct Request {
        // slot 0 — immutable after reason()
        address consumer; // 160 bits
        uint16 modelId; //  16 bits
        uint8 numOfChoices; //   8 bits
        uint64 timestamp; //  64 bits
        // slot 1 — written by fulfillReasoning() / refundRequest()
        uint128 feePaid; // 128 bits
        RequestStatus status; //   8 bits
        uint8 choice; //   8 bits
        uint112 reserved; // 112 bits
    }

    /// @notice Rate limit configuration for a consumer.
    struct RateLimit {
        bool enabled; // 1 byte
        uint64 lastRequestTime; // 8 bytes
        uint32 cooldown; // 4 bytes
        uint152 reserved; // 19 bytes
    }

    /// @notice Read-only summary of a request, used exclusively by explorer view functions.
    struct RequestView {
        uint256 requestId;
        address consumer;
        uint16 modelId;
        uint8 numOfChoices;
        uint64 timestamp;
        uint128 feePaid;
        RequestStatus status;
        uint8 choice;
        string reasoningCid;
    }

    // ----------------------------------------------------------------
    //  Custom Errors
    // ----------------------------------------------------------------

    error FlapAIProviderPromptExceedsMaxLength(uint256 promptLength, uint256 maxPromptLength);
    error FlapAIProviderInvalidNumOfChoices(uint8 numOfChoices);
    error FlapAIProviderRequestNotPending(uint256 requestId);
    error FlapAIProviderChoiceOutOfRange(uint8 choice, uint8 numOfChoices);
    error FlapAIProviderInsufficientFee(uint256 sent, uint256 required);
    error FlapAIProviderModelNotRegistered(uint256 modelId);
    error FlapAIProviderModelIdTooLarge(uint256 modelId);
    error FlapAIProviderCallbackGasLimitTooLow(uint256 provided, uint256 minimum);
    error FlapAIProviderModelAlreadyRegistered(uint256 modelId);
    error FlapAIProviderWithdrawFailed();
    error FlapAIProviderZeroAddress();
    error FlapAIProviderRateLimitExceeded(address consumer, uint32 waitTime);
    error FlapAIProviderRequestNotUndelivered(uint256 requestId);
    error FlapAIProviderConsumerHasNoCode(address consumer);

    // ----------------------------------------------------------------
    //  Events
    // ----------------------------------------------------------------

    event FlapAIProviderRequestMade(
        uint256 requestId, address consumer, uint256 modelId, string prompt, uint8 numOfChoices, uint256 feePaid
    );
    event FlapAIProviderRequestFulfilled(
        uint256 requestId, address consumer, uint8 choice, string reasoningDetailsIpfsCid
    );
    event FlapAIProviderRequestUndelivered(
        uint256 requestId, address consumer, uint8 choice, string reasoningDetailsIpfsCid, bytes reason
    );
    event FlapAIProviderRequestRefunded(uint256 requestId, address consumer, uint256 refundAmount);
    event FlapAIProviderRefundUndelivered(uint256 requestId, address consumer, uint256 refundAmount, bytes reason);
    event FlapAIProviderMaxPromptLengthUpdated(uint256 oldMaxPromptLength, uint256 newMaxPromptLength);
    event FlapAIProviderCallbackGasLimitUpdated(uint256 oldCallbackGasLimit, uint256 newCallbackGasLimit);
    event FlapAIProviderModelRegistered(uint256 modelId, string name, uint256 price);
    event FlapAIProviderModelReplaced(uint256 indexed modelId, string name, uint256 price);
    event FlapAIProviderFeesWithdrawn(address indexed recipient, uint256 amount);
    event FlapAIProviderRateLimitConfigured(address indexed consumer, bool enabled, uint32 cooldown);

    // ----------------------------------------------------------------
    //  Functions
    // ----------------------------------------------------------------

    /// @notice Submit an AI reasoning request to the oracle.
    /// @param modelId      ID of the LLM model to use for this request.
    /// @param prompt       Combined system + user prompt with choice meanings embedded.
    /// @param numOfChoices Number of choices the LLM may return (valid responses are 0..numOfChoices-1).
    /// @return requestId   Unique identifier for this request.
    function reason(uint256 modelId, string calldata prompt, uint8 numOfChoices)
        external
        payable
        returns (uint256 requestId);

    /// @notice Return the full Model struct for a registered model.
    function getModel(uint256 modelId) external view returns (Model memory model);

    /// @notice Fulfill a pending AI reasoning request (called by oracle backend with FULFILLER_ROLE).
    /// @param requestId              The ID of the pending request to fulfill.
    /// @param choice                 The LLM's chosen action (must be < numOfChoices).
    /// @param reasoningDetailsIpfsCid IPFS CID of the full reasoning proof document.
    function fulfillReasoning(uint256 requestId, uint8 choice, string calldata reasoningDetailsIpfsCid) external;

    /// @notice Refund a pending request when the oracle cannot process it (called by oracle backend).
    function refundRequest(uint256 requestId) external;

    /// @notice Manually retry the consumer callback for an UNDELIVERED request (callable by anyone).
    function retryUndelivered(uint256 requestId) external;

    function maxPromptLength() external view returns (uint256);
    function setMaxPromptLength(uint256 newMaxPromptLength) external;
    function callbackGasLimit() external view returns (uint256);
    function setCallbackGasLimit(uint256 newCallbackGasLimit) external;

    function registerModel(uint256 modelId, string calldata name, uint256 price) external;
    function replaceModel(uint256 modelId, string calldata name, uint256 price) external;
    function withdrawStuckFee(address payable recipient, uint256 amount) external;
    function setConsumerRateLimit(address consumer, bool enabled, uint32 cooldown) external;
    function getConsumerRateLimit(address consumer)
        external
        view
        returns (bool enabled, uint64 lastRequestTime, uint32 cooldown);

    function getTotalRequests() external view returns (uint256 total);
    function getTotalRequestsByConsumer(address consumer) external view returns (uint256 total);
    function getRequest(uint256 requestId) external view returns (RequestView memory view_);
    function getRecentRequests(uint256 offset, uint256 limit) external view returns (RequestView[] memory views);
    function getRequestsByConsumer(address consumer, uint256 offset, uint256 limit)
        external
        view
        returns (RequestView[] memory views);
}

// ============================================================
//                FlapAIConsumerBase Abstract Contract
// ============================================================

/// @title FlapAIConsumerBase
/// @notice Base contract for contracts consuming FlapAIProvider responses.
/// @dev Inheritors must override:
///        - `_fulfillReasoning(uint256 requestId, uint8 choice)`: executes the action chosen by the LLM.
///        - `_onFlapAIRequestRefunded(uint256 requestId)`: handles refund cleanup or retry logic.
///        - `lastRequestId()`: returns the consumer's most recent pending request ID (0 if none).
///      The `onlyFlapAIProvider` modifier ensures only the FlapAIProvider can invoke callbacks.
///      The provider address is resolved at runtime via `_getFlapAIProvider()` using `block.chainid`.
abstract contract FlapAIConsumerBase {
    error FlapAIConsumerOnlyProvider();
    error FlapAIConsumerUnsupportedChain(uint256 chainId);

    modifier onlyFlapAIProvider() {
        if (msg.sender != _getFlapAIProvider()) revert FlapAIConsumerOnlyProvider();
        _;
    }

    /// @notice Returns the FlapAIProvider proxy address for the current chain.
    function _getFlapAIProvider() internal view virtual returns (address) {
        uint256 id = block.chainid;
        if (id == 56) {
            return 0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39;
        } else if (id == 97) {
            return 0xFfddcE44e8cFf7703Fd85118524bfC8B2f70b744;
        } else {
            revert FlapAIConsumerUnsupportedChain(id);
        }
    }

    /// @notice Returns the most recent pending request ID (0 if none).
    function lastRequestId() public view virtual returns (uint256);

    /// @notice Called by FlapAIProvider to deliver the LLM's chosen action.
    function fulfillReasoning(uint256 requestId, uint8 choice) external onlyFlapAIProvider {
        _fulfillReasoning(requestId, choice);
    }

    /// @notice Called by FlapAIProvider when a request is refunded (BNB delivered via msg.value).
    function onFlapAIRequestRefunded(uint256 requestId) external payable onlyFlapAIProvider {
        _onFlapAIRequestRefunded(requestId);
    }

    function _fulfillReasoning(uint256 requestId, uint8 choice) internal virtual;
    function _onFlapAIRequestRefunded(uint256 requestId) internal virtual;
}
