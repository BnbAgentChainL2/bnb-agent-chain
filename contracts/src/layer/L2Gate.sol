// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IL2Bridge} from "../interfaces/IL2Bridge.sol";

/// @title L2Gate
/// @notice Genesis system contract @ 0x0000000000000000000000000000000000000102 on BNB Agent Chain.
///         Implements 01-CONTRACT-SPEC §8.2 verbatim: the layer's table of which wallet entered as
///         which agent, written by the relayer (03-INTERFACES §1.4, direction C).
///
/// @dev Genesis discipline: no constructor, no immutables, zero storage slots at construction.
///
///      WHERE THE ROWS COME FROM — PENDING REDESIGN (decision #31). This contract was written as a
///      mirror of our own BSC agent registry and its status machine. Decision #31 deleted both:
///      entry is now `BacBridge.lock(agentId, amount)` by an address that holds ERC-8004 identity
///      `agentId`, and the only BSC fact left to mirror is the `Locked` event's
///      `(agentId, layerWallet)`. Nothing can make an agent dormant, banned or retired any more,
///      so of the six status codes below only NONE and ACTIVE still have a source. Two properties
///      of the old registry that this code relies on no longer hold on ERC-8004: one address can
///      hold many identities, and one identity can enter from two addresses (its ERC-721 owner
///      and its signature-proven `agentWallet`). Fed naively from `Locked`, `applySync` would
///      therefore revert on an address's second identity ("Wallet bound to another agent" — a
///      wedge for the relayer's single-threaded outbox) and would unbind an identity's first
///      wallet when its second one enters. Mirroring `Locked` into this code as it stands is only
///      safe if the relayer skips both cases, and every wallet it skips then exits unattributed.
///      The code is deliberately left unchanged until its replacement is agreed, and that has to
///      happen before the production genesis is built: this bytecode is frozen there.
///
///      Two consumers, and only two:
///        * `AgentBook.announce` reads `isAdmitted` — the ONLY place on this entire chain where an
///          agent *status* is consulted (00-DESIGN-SPEC §4.2/§4.3).
///        * `L2Bridge.exit` reads `agentIdOf` — a pure table lookup that ignores the status, so no
///          status can ever block an exit (G11), yet nobody can exit under somebody else's id.
///
///      There is deliberately no hook here for plain transfers, contract deploys or arbitrary calls:
///      credits are freely transferable once minted and the layer cannot tell a program's
///      transaction from a human's.
contract L2Gate {
    // ------------------------------------------------------------------ constants / immutables ---

    /// @notice `L2Bridge` genesis address, the single source of truth for `relayer()`.
    /// @dev Reading the relayer from `L2Bridge` (instead of keeping a second copy here) means the one
    ///      cold-key rotation channel of G12 covers every relayer-gated function on the layer. A
    ///      second local copy would be a second thing to rotate, and the one nobody remembers to
    ///      rotate is the one that gets stolen.
    address public constant L2_BRIDGE = 0x0000000000000000000000000000000000000101;

    /// @notice Status encoding of 03-INTERFACES §1.4. Its BSC source was deleted by decision #31;
    ///         only NONE (never entered) and ACTIVE (entered) can still be produced by anything on
    ///         BSC. CHALLENGED / DORMANT / BANNED / RETIRED are dead codes kept only because the
    ///         ABI still carries them.
    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_CHALLENGED = 1;
    uint8 public constant STATUS_ACTIVE = 2;
    uint8 public constant STATUS_DORMANT = 3;
    uint8 public constant STATUS_BANNED = 4;
    uint8 public constant STATUS_RETIRED = 5;

    // ---------------------------------------------------------------------------------- storage ---

    struct AgentInfo {
        address wallet; // bytes 0..19
        uint8 status; // byte 20
        uint64 bscBlock; // bytes 21..28  — last BSC block this row was synced from
    }

    /// @notice agentId => last mirrored row.
    mapping(uint256 => AgentInfo) private _agents; // slot 0

    /// @notice wallet => agentId, one agent per wallet and one wallet per agent. The deleted
    ///         registry guaranteed that pairing (its R7); ERC-8004 does not (see the header).
    mapping(address => uint256) private _walletAgentId; // slot 1

    // ----------------------------------------------------------------------------------- events ---

    event AgentSynced(uint256 indexed agentId, address indexed wallet, uint8 status, uint64 bscBlock);

    // ------------------------------------------------------------------------------------ write ---

    /// @notice Relayer-only mirror write. Its original BSC triggers were status events of the
    ///         registry decision #31 deleted; the only remaining trigger is `BacBridge.Locked`.
    /// @dev `bscBlock` is monotonic per agent: the relayer's outbox is strictly single threaded, but
    ///      a `parked` job that is retried later must never be able to resurrect a stale status.
    ///      Per AGENT, not per wallet — with two wallets per identity a retried older row is
    ///      rejected as stale even though it names a different wallet (see the header).
    function applySync(uint256 agentId, address wallet, uint8 status, uint64 bscBlock) external {
        require(msg.sender == IL2Bridge(L2_BRIDGE).relayer(), unicode"Only relayer / 仅限中继调用");
        require(agentId != 0, unicode"Zero agent id / agent 编号为零");
        require(status <= STATUS_RETIRED, unicode"Unknown agent status / 未知的 agent 状态");

        AgentInfo storage a = _agents[agentId];
        require(bscBlock >= a.bscBlock, unicode"Stale sync / 同步消息过期");

        address old = a.wallet;
        if (old != address(0) && old != wallet) {
            _walletAgentId[old] = 0;
        }
        if (wallet != address(0)) {
            uint256 bound = _walletAgentId[wallet];
            require(
                bound == 0 || bound == agentId, unicode"Wallet bound to another agent / 钱包已绑定别的 agent"
            );
            _walletAgentId[wallet] = agentId;
        }

        a.wallet = wallet;
        a.status = status;
        a.bscBlock = bscBlock;

        emit AgentSynced(agentId, wallet, status, bscBlock);
    }

    // ----------------------------------------------------------------------------------- views ---

    /// @notice True only for `ACTIVE`. Read by `AgentBook.announce` and by nothing else.
    function isAdmitted(address wallet) external view returns (bool) {
        return statusOf(wallet) == STATUS_ACTIVE;
    }

    /// @notice Table lookup, status-blind. 0 means "this gate holds no row for this address".
    function agentIdOf(address wallet) external view returns (uint256) {
        return _walletAgentId[wallet];
    }

    /// @notice Mirrored status of the agent this wallet belongs to, or `NONE` if unknown.
    function statusOf(address wallet) public view returns (uint8) {
        uint256 id = _walletAgentId[wallet];
        if (id == 0) return STATUS_NONE;
        return _agents[id].status;
    }

    /// @notice The wallet currently mirrored for this agent (address(0) if never synced).
    function walletOf(uint256 agentId) external view returns (address) {
        return _agents[agentId].wallet;
    }

    /// @notice The BSC block height the row for this agent was last synced from.
    function syncedAt(uint256 agentId) external view returns (uint64) {
        return _agents[agentId].bscBlock;
    }
}
