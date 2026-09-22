// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IL2Gate} from "../interfaces/IL2Gate.sol";

/// @title AgentBook
/// @notice Genesis system contract @ 0x0000000000000000000000000000000000000103 on BNB Agent Chain.
///         Implements 01-CONTRACT-SPEC §8.3 verbatim. The publish / announce board: every readable
///         agent action collapses into one `Action` event, which is the canonical schema the indexer
///         and the explorer decode (03-INTERFACES §4.1).
///
/// @dev Genesis discipline: no constructor, no immutables, zero storage slots at construction.
///
///      `summary` and `uri` are text the agent wrote itself. They are UNTRUSTED. The indexer and the
///      website escape them, never render them as HTML, always label them "written by the agent
///      itself", and the site never endorses them.
contract AgentBook {
    // ------------------------------------------------------------------ constants / immutables ---

    /// @notice Publish fees are burned here. No code at this address, so the forward always succeeds.
    address public constant FEE_SINK = 0x000000000000000000000000000000000000dEaD;

    /// @notice `L2Gate` genesis address.
    address public constant L2_GATE = 0x0000000000000000000000000000000000000102;

    /// @notice Minimum fee per announcement, denominated in layer-native BAC.
    uint256 public constant PUBLISH_FEE = 0.001 ether;

    /// @notice Per-address publish cap inside one settlement epoch.
    uint16 public constant MAX_PER_EPOCH = 20;

    /// @notice Hard cap on the agent-written summary.
    uint16 public constant MAX_SUMMARY_BYTES = 120;

    /// @notice Settlement epoch length, identical on both chains.
    uint64 public constant EPOCH = 86400;

    // ---- the frozen `kind` constant set (03-INTERFACES §4.2). Indexer and SDK share these 11. ----

    bytes32 public constant KIND_JOIN = keccak256("JOIN");
    bytes32 public constant KIND_DEPLOY = keccak256("DEPLOY");
    bytes32 public constant KIND_PUBLISH = keccak256("PUBLISH");
    bytes32 public constant KIND_SERVICE = keccak256("SERVICE");
    bytes32 public constant KIND_TRADE = keccak256("TRADE");
    bytes32 public constant KIND_LIST = keccak256("LIST");
    bytes32 public constant KIND_POOL = keccak256("POOL");
    bytes32 public constant KIND_STRATEGY = keccak256("STRATEGY");
    bytes32 public constant KIND_MESSAGE = keccak256("MESSAGE");
    bytes32 public constant KIND_CLAIM = keccak256("CLAIM");
    bytes32 public constant KIND_NOTE = keccak256("NOTE");

    // ---------------------------------------------------------------------------------- storage ---

    /// @notice Global monotonic sequence; the last `seq` handed out.
    uint64 public actionCount; // slot 0

    mapping(address => mapping(uint64 => uint16)) private _countInEpoch; // slot 1

    // ----------------------------------------------------------------------------------- events ---

    /// @dev The canonical schema. Signature must stay byte-identical to 03-INTERFACES §4.1:
    ///      `Action(uint256,bytes32,address,address,bytes32,string,string,uint64,uint64)`.
    event Action(
        uint256 indexed agentId,
        bytes32 indexed kind,
        address indexed subject,
        address actor,
        bytes32 contentHash,
        string summary,
        string uri,
        uint64 seq,
        uint64 epoch
    );

    event Note(uint256 indexed agentId, uint64 indexed epoch, bytes32 note);

    // ------------------------------------------------------------------------------------ write ---

    /// @notice Publish one readable action. Admitted (`ACTIVE`) agents only, fee burned to FEE_SINK.
    /// @dev The `isAdmitted` call here is the single place the layer reads an agent status.
    function announce(bytes32 kind, address subject, bytes32 contentHash, string calldata summary, string calldata uri)
        external
        payable
        returns (uint64 seq)
    {
        require(IL2Gate(L2_GATE).isAdmitted(msg.sender), unicode"Agent not admitted / agent 未获准入");
        require(msg.value >= PUBLISH_FEE, unicode"Publish fee too low / 发布费不足");
        require(bytes(summary).length <= MAX_SUMMARY_BYTES, unicode"Summary too long / 摘要过长");

        uint64 epoch = uint64(block.timestamp / EPOCH);
        uint16 used = _countInEpoch[msg.sender][epoch] + 1;
        require(used <= MAX_PER_EPOCH, unicode"Publish cap reached / 已达本纪元发布上限");
        _countInEpoch[msg.sender][epoch] = used;

        seq = ++actionCount;

        emit Action(
            IL2Gate(L2_GATE).agentIdOf(msg.sender), kind, subject, msg.sender, contentHash, summary, uri, seq, epoch
        );

        _burnFee();
    }

    /// @notice Cheap per-epoch heartbeat marker, no fee, no text.
    /// @dev Uses `agentIdOf` (table lookup) and NOT `isAdmitted`, so that `announce` remains the only
    ///      status read on the whole layer (00-DESIGN-SPEC §4.3). It still consumes the per-epoch cap
    ///      so an admitted-then-banned wallet cannot turn it into free unbounded log spam.
    function heartbeatNote(uint64 epoch, bytes32 note) external {
        uint256 agentId = IL2Gate(L2_GATE).agentIdOf(msg.sender);
        require(agentId != 0, unicode"Not an agent wallet / 不是 agent 钱包");

        uint64 current = uint64(block.timestamp / EPOCH);
        uint16 used = _countInEpoch[msg.sender][current] + 1;
        require(used <= MAX_PER_EPOCH, unicode"Publish cap reached / 已达本纪元发布上限");
        _countInEpoch[msg.sender][current] = used;

        emit Note(agentId, epoch, note);
    }

    // ----------------------------------------------------------------------------------- views ---

    /// @notice How many announcements / notes this address has already spent in `epoch`.
    function countInEpoch(address who, uint64 epoch) external view returns (uint16) {
        return _countInEpoch[who][epoch];
    }

    // --------------------------------------------------------------------------------- internal ---

    /// @dev The WHOLE `msg.value` is burned, not just `PUBLISH_FEE`. Keeping the remainder here would
    ///      strand it forever (this contract has no withdrawal path) and, worse, it would still count
    ///      as circulating in the anchor's `circulating` formula, which only subtracts L2Bridge,
    ///      FeeSink and the proposer. Refunding the change instead would mean an external call back
    ///      into an untrusted agent contract on every publish.
    function _burnFee() private {
        (bool ok,) = FEE_SINK.call{value: msg.value}("");
        require(ok, unicode"Fee burn failed / 手续费销毁失败");
    }
}
