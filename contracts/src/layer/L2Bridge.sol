// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IL2Gate} from "../interfaces/IL2Gate.sol";

/// @title L2Bridge
/// @notice Genesis system contract @ 0x0000000000000000000000000000000000000101 on BNB Agent Chain
///         (chainId 56777). Implements 01-CONTRACT-SPEC §8.1 verbatim.
///
/// @dev Genesis discipline (02-CHAIN-SPEC §2 / §3.2 "alloc 的硬规则" 1):
///      the runtime bytecode produced by this source is pasted straight into `genesis.alloc` and the
///      genesis file carries NO storage slots at all. Therefore every configuration value is an
///      `immutable` (baked into the runtime code by the constructor) or a `constant`, and the
///      constructor writes ZERO storage slots. `Layer.t.sol::test_statelessConstruction` asserts it.
///
///      "Minting" is a transfer out of this contract's genesis balance; "burning" is a transfer back
///      into it. No client fork, no precompile.
///
///      Every revert in this file is `require(cond, unicode"English / 中文")` — rule 004: our own
///      contracts declare no custom errors, because the explorer only decodes `Error(string)`.
contract L2Bridge {
    // ------------------------------------------------------------------ constants / immutables ---

    /// @notice The mother chain: BSC mainnet.
    uint256 public constant BSC_CHAIN_ID = 56;

    /// @notice Settlement epoch length, identical to the BSC side: `epoch = floor(ts / 600)`, the
    ///         same 10-minute epoch as `ChainAnchor.EPOCH` and `BacBridge.EPOCH` (decision #20).
    /// @dev The relayer buckets every exit into an anchor by the `epoch` field of `ExitBurned`
    ///      and nothing else (01-CONTRACT-SPEC §8.1), and `ChainAnchor.postAnchor` only accepts
    ///      600-second epochs, so this number has to be the BSC one exactly. It is a constant in
    ///      the genesis bytecode: getting it wrong here means a new genesis, not a transaction.
    uint64 public constant EPOCH = 600;

    /// @notice Layer chainId, part of the exit-leaf domain separation on the BSC side.
    uint256 public constant LAYER_CHAIN_ID = 56777;

    /// @notice `L2Gate` genesis address. Fixed by 02-CHAIN-SPEC §2, so it is a constant, not a param.
    address public constant L2_GATE = 0x0000000000000000000000000000000000000102;

    /// @notice Leaf type hash — byte-for-byte the BSC-side `BacBridge.EXIT_TYPEHASH` (no `epoch`
    ///         field; anchor bucketing and exit birth epoch are decoupled, attack-funds #13).
    bytes32 public constant EXIT_TYPEHASH = keccak256(
        "Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)"
    );

    /// @notice EIP-712 type hash of the relayer rotation message.
    bytes32 public constant ROTATE_TYPEHASH = keccak256("Rotate(address newRelayer,uint256 nonce)");

    /// @notice EIP-712 domain name used by `rotateRelayer`.
    string public constant EIP712_NAME = "BNB Agent Chain L2Bridge";

    /// @notice EIP-712 domain version used by `rotateRelayer`.
    string public constant EIP712_VERSION = "1";

    /// @notice `BacBridge` on BSC. Informational on this side; it is the exit-leaf domain anchor.
    /// @dev Since decision #29 `BacBridge` is an ERC1967 (UUPS) proxy, and this MUST be the
    ///      PROXY address, never the implementation's: `claimExit` rebuilds the leaf with
    ///      `address(this)`, which under the proxy's delegatecall is the proxy. Baking the
    ///      implementation here would make every exit leaf unprovable on BSC. An upgrade keeps
    ///      the proxy address, so leaves stay valid across upgrades; a NEW proxy would not, and
    ///      this immutable can only be changed by a new genesis.
    address public immutable BSC_BRIDGE;

    /// @notice Cold key hard-wired at genesis: the ONLY authority that can point `relayer()`
    ///         somewhere else. It cannot mint, cannot move funds, cannot touch anything on BSC (G12).
    address public immutable ROTATION_SIGNER;

    /// @notice The relayer written into genesis. `relayer()` falls back to this while no rotation has
    ///         happened, which is what keeps the constructor from writing a storage slot.
    address public immutable GENESIS_RELAYER;

    // ---------------------------------------------------------------------------------- storage ---
    // Every slot below is zero after construction. Do not reorder without updating the storage test.

    /// @notice Idempotency set. The key is the relayer-computed
    ///         `keccak256(abi.encode(56, bscBridgeAddr, bscTxHash, logIndex))` — NOT the BSC-side
    ///         `Locked.depositId` counter (03-INTERFACES §1.2).
    mapping(bytes32 => bool) public seen; // slot 0

    /// @notice Pull-mode balances credited by the relayer, claimed by `withdrawCredits`.
    mapping(address => uint256) public creditable; // slot 1

    /// @notice Sum of every `credit` ever accepted.
    uint256 public totalCredited; // slot 2

    /// @notice Sum of every `exit` ever burned.
    uint256 public totalExited; // slot 3

    /// @notice Sum of every `burnFloat` ever accepted (voluntary supply shrink, never an exit leaf).
    uint256 public totalBurnedFloat; // slot 4

    /// @notice Next expected rotation nonce.
    uint256 public rotationNonce; // slot 5

    address private _relayerOverride; // slot 6 (bytes 0..19)

    /// @notice Number of exits ever burned; the last `exitId` handed out.
    uint64 public exitCount; // slot 6 (bytes 20..27)

    uint64 private _lastExitEpoch; // slot 7

    // ----------------------------------------------------------------------------------- events ---

    event CreditsMinted(bytes32 indexed depositId, uint256 indexed agentId, address indexed to, uint256 amount);
    event CreditsWithdrawn(address indexed to, uint256 amount);
    event ExitBurned(
        uint256 indexed exitId, uint256 indexed agentId, address indexed bscRecipient, uint256 amount, uint64 epoch
    );
    event FloatBurned(address indexed from, uint256 amount);
    event RelayerRotated(address indexed from, address indexed to, uint256 nonce);

    // ------------------------------------------------------------------------------ construction ---

    /// @dev Writes no storage. All three arguments land in the runtime bytecode as immutables, which
    ///      is exactly what `chain/scripts/build-genesis.sh` step 3 copies with `cast code`.
    constructor(address bscBridge, address rotationSigner, address genesisRelayer) {
        require(bscBridge != address(0), unicode"Zero BSC bridge / BSC 桥地址为零");
        require(rotationSigner != address(0), unicode"Zero rotation signer / 轮换签名者为零");
        require(genesisRelayer != address(0), unicode"Zero genesis relayer / 创世中继地址为零");
        BSC_BRIDGE = bscBridge;
        ROTATION_SIGNER = rotationSigner;
        GENESIS_RELAYER = genesisRelayer;
    }

    /// @notice Plain transfers are accepted and simply sit in the reserve (i.e. out of circulation).
    /// @dev Anybody may transfer here; `postAnchor` on BSC must stay green regardless (C7). No state
    ///      is written, so this can never be a griefing lever.
    receive() external payable {}

    // -------------------------------------------------------------------------------------- in ---

    /// @notice Relayer-only, idempotent, PULL MODE — contains no external call at all.
    /// @dev `to` is the `layerWallet` of a BSC `BacBridge.Locked` event, i.e. the address that
    ///      passed the ERC-8004 entry gate (decision #31), and it may be a contract whose
    ///      `receive()` reverts. Pushing here would either revert the whole call (one job
    ///      permanently wedges the strictly single-threaded outbox and the entire chain stops
    ///      taking deposits) or silently drop the value (`totalCredited` grows
    ///      while no BAC leaves this contract, so off-chain reconciliation diverges forever).
    ///      attack-funds #12. Delivery is a separate, permissionless `withdrawCredits`.
    function credit(bytes32 depositId, uint256 agentId, address to, uint256 amount) external {
        require(msg.sender == relayer(), unicode"Only relayer / 仅限中继调用");
        require(!seen[depositId], unicode"Deposit already credited / 该存款已入账");
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        require(amount > 0, unicode"Amount must be positive / 金额必须为正");
        seen[depositId] = true;
        creditable[to] += amount;
        totalCredited += amount;
        emit CreditsMinted(depositId, agentId, to, amount);
    }

    /// @notice Permissionless: anybody may deliver anybody else's credited balance.
    /// @dev Checks-effects-interactions; the balance is zeroed and the event emitted before the call,
    ///      so a reentrant caller finds nothing left to claim.
    function withdrawCredits(address to) external returns (uint256 amount) {
        amount = creditable[to];
        require(amount > 0, unicode"Nothing to withdraw / 没有可提取的积分");
        creditable[to] = 0;
        emit CreditsWithdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        require(ok, unicode"Credit transfer failed / 积分转账失败");
    }

    // ------------------------------------------------------------------------------------- out ---

    /// @notice Burn layer credits and mint the right to claim on BSC. Permissionless.
    /// @dev NEVER gated by any status — not by `L2Gate.statusOf`, not by anything else (G11). Exit is
    ///      the one action no state machine may block.
    ///
    ///      `agentId` is NOT a caller-supplied argument: it is looked up from `L2Gate` (table lookup
    ///      only, the status is never read). If the caller could pass it, an attacker would exit its
    ///      own credits under a victim's agentId — keeping its own full escape weight while the
    ///      victim's `credited - exitedCredits` is spent down (attack-funds #4). The BSC side
    ///      clamps attribution at what that id locked (§4.2 step 6), so it can no longer
    ///      underflow, but the victim would still lose escape weight; both sides carry the guard.
    ///      A caller `L2Gate` has no row for exits with agentId 0: the exit is paid normally and
    ///      lands in `unattributedExited` on BSC, while the identity the credits entered under
    ///      keeps its escape weight. So `L2Gate` has to learn every entering wallet — since
    ///      decision #31 that means from `BacBridge.Locked` (see `L2Gate`'s header).
    function exit(address bscRecipient) external payable returns (uint256 exitId) {
        require(msg.value > 0, unicode"Exit amount must be positive / 退出金额必须为正");
        require(bscRecipient != address(0), unicode"Zero BSC recipient / BSC 收款地址为零");

        uint256 agentId = IL2Gate(L2_GATE).agentIdOf(msg.sender);

        exitId = ++exitCount;
        totalExited += msg.value;

        uint64 epoch = uint64(block.timestamp / EPOCH);
        require(epoch >= _lastExitEpoch, unicode"Timestamp went backwards / 时间戳回退");
        _lastExitEpoch = epoch;

        emit ExitBurned(exitId, agentId, bscRecipient, msg.value, epoch);
    }

    /// @notice Permissionless voluntary supply shrink: the value stays under this contract's name and
    ///         leaves circulation. Produces NO exit leaf, so nothing becomes claimable on BSC.
    /// @dev The only intended user is the operator burning `OPERATOR_FLOAT` leftovers or
    ///      mis-credited float. It is explicitly NOT the reorg remedy — that remedy is the operator
    ///      posting an equal `lock` on BSC (00-DESIGN-SPEC §4.2).
    function burnFloat() external payable {
        require(msg.value > 0, unicode"Burn amount must be positive / 销毁金额必须为正");
        totalBurnedFloat += msg.value;
        emit FloatBurned(msg.sender, msg.value);
    }

    // -------------------------------------------------------------------------------- rotation ---

    /// @notice Point `relayer()` at a new address. Anybody may submit; only the genesis-fixed
    ///         `ROTATION_SIGNER` cold key can authorise.
    /// @dev Deliberately does NOT require the old relayer's signature and deliberately does NOT go
    ///      through the relayer's own channel: if it did, a stolen relayer key would be unrecoverable
    ///      (G12 / agentnative N4).
    function rotateRelayer(address newRelayer, uint256 nonce, bytes calldata sig) external {
        require(newRelayer != address(0), unicode"Zero relayer / 中继地址为零");
        address current = relayer();
        require(newRelayer != current, unicode"Relayer unchanged / 中继未变化");
        require(nonce == rotationNonce, unicode"Bad rotation nonce / 轮换随机数不对");

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(ROTATE_TYPEHASH, newRelayer, nonce)))
        );
        require(_recover(digest, sig) == ROTATION_SIGNER, unicode"Not rotation signer / 不是轮换签名者");

        rotationNonce = nonce + 1;
        _relayerOverride = newRelayer;
        emit RelayerRotated(current, newRelayer, nonce);
    }

    /// @notice EIP-712 domain separator, computed on the fly.
    /// @dev NOT an immutable on purpose: immutables are baked into the runtime bytecode at the
    ///      deploy address, and this contract's runtime bytecode is lifted off a throwaway anvil
    ///      deployment and pasted at 0x…0101 in genesis. A baked `address(this)` would be the anvil
    ///      address and every rotation signature would then verify against the wrong domain.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(EIP712_NAME)),
                keccak256(bytes(EIP712_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    // ----------------------------------------------------------------------------------- views ---

    /// @notice The address currently allowed to call `credit` (and, via this getter, `L2Gate`'s
    ///         `applySync`). Reads the genesis immutable until a rotation has happened.
    function relayer() public view returns (address) {
        address o = _relayerOverride;
        return o == address(0) ? GENESIS_RELAYER : o;
    }

    /// @notice Everything this contract holds: the un-minted float plus everything burned back in.
    function reserve() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Convenience mirror of the canonical exit leaf so SDK / node-cli / indexer can assert
    ///         they build the exact same bytes. Pure, reads nothing.
    function exitLeaf(uint256 exitId, uint256 agentId, address to, uint256 credits) external view returns (bytes32) {
        return keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, to, credits, LAYER_CHAIN_ID, BSC_BRIDGE));
    }

    // --------------------------------------------------------------------------------- internal ---

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, unicode"Bad signature length / 签名长度不对");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            unicode"Malleable signature / 签名可延展"
        );
        require(v == 27 || v == 28, unicode"Bad signature v / 签名 v 值不对");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), unicode"Bad signature / 签名无效");
        return signer;
    }
}
