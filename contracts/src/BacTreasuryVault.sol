// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin-contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import {VaultBaseV3} from "./flap/VaultBaseV3.sol";
import {VaultUISchema} from "./flap/IVaultSchemasV1.sol";
import {BacVaultUI} from "./lib/BacVaultUI.sol";

/// @title BacTreasuryVault
/// @notice The BNB Agent Chain treasury vault (docs/01-CONTRACT-SPEC.md §2).
///         Every BNB that arrives — trading tax after Flap's 10% protocol fee, donations,
///         forced balances, forfeited agent deposits — is split by a hard-coded constant
///         with no setter: 50% is pushed to `BacBridge` (the bridge pool, the only source
///         of BNB for agents exiting the layer) and 50% to `BacNodeFund` (the official
///         node fund, withdrawable by that contract's own owner — decision #10).
/// @dev Beacon proxy behind a beacon created inside `BacVaultFactory`'s constructor, so
///      the only upgrade authority is the Flap Guardian (rule 009). The vault has no
///      owner withdrawal, no emergency withdrawal and no rescue function; no path lets
///      the owner or the Guardian touch the bridge pool.
contract BacTreasuryVault is Initializable, VaultBaseV3, ReentrancyGuardUpgradeable {
    uint16 public constant BPS = 10000;
    /// @dev The node-fund half is computed as `unsplit - toBridge`, so the rounding
    ///      remainder (at most 1 wei) always flows to the bridge pool (V11).
    uint16 public constant BRIDGE_BPS = 5000;
    uint256 public constant PUSH_GAS = 100_000;

    /* ------------------------------------------------------------------ */
    /*  storage — slot 0 Initializable, slot 1 _status, slots 2-50 gap[49] */
    /*  project storage starts at slot 51, append-only, trailing __gap     */
    /* ------------------------------------------------------------------ */

    /// @dev slot 51 — low 128 bits = accountedQuote, high 128 bits = unsplit revenue.
    ///      `receive()` writes this slot and nothing else.
    uint256 private _revenue;
    address private _taxToken; // slot 52
    address private _bridge; // slot 53
    address private _nodeFund; // slot 54
    address private _owner; // slot 55
    uint128 private _stuckBridge; // slot 56
    uint128 private _stuckNodeFund; // slot 56
    uint128 private _lifetimeToBridge; // slot 57
    uint128 private _lifetimeToNodeFund; // slot 57
    uint256[40] private __gap; // slots 58-97

    event RevenueRecognized(address indexed from, uint256 amount);
    event RevenueSplit(uint256 toBridge, uint256 toNodeFund);
    event PushSucceeded(address indexed to, uint256 amount);
    event PushFailed(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed from, address indexed to);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice The only state setter. Called by `BacVaultFactory.newVault` through the
    ///         BeaconProxy constructor. Makes no external call of any kind: the tax token
    ///         has no code yet at this point and touching it would revert the whole launch.
    function initialize(address taxToken_, address owner_, address bridge_, address nodeFund_) external initializer {
        require(
            taxToken_ != address(0) && owner_ != address(0) && bridge_ != address(0) && nodeFund_ != address(0),
            unicode"Zero address / 地址为零"
        );
        require(bridge_ != nodeFund_, unicode"Bad bridge or node fund / 桥或节点基金地址无效");
        __ReentrancyGuard_init();
        _taxToken = taxToken_;
        _bridge = bridge_;
        _nodeFund = nodeFund_;
        _owner = owner_;
    }

    /// @notice Revenue wake-up. Rule 005: 1 SLOAD + 1 BALANCE + 1 SSTORE + 1 event,
    ///         no loop, no external call, and it MUST NEVER revert. Not `nonReentrant`
    ///         (and it must not be: the push targets may hand BNB straight back).
    receive() external payable {
        _syncRevenue();
    }

    /* ------------------------------------------------------------------ */
    /*                    permissionless state changes                     */
    /* ------------------------------------------------------------------ */

    /// @notice Neutral, side-effect-free recognition entry (rule 010).
    function sync() external nonReentrant {
        _syncRevenue();
    }

    /// @notice Splits everything recognized-but-unsplit 50/50 and pushes both halves out.
    ///         Permissionless, unpaid, and it never fails because a target rejected the
    ///         transfer — a failed push is booked into `stuckBridge` / `stuckNodeFund`.
    /// @return toBridge The amount booked for the bridge pool (the accounting move).
    /// @return toNodeFund The amount booked for the node fund (the accounting move).
    function settle() external nonReentrant returns (uint256 toBridge, uint256 toNodeFund) {
        _syncRevenue();
        uint256 rev = _revenue;
        uint256 unsplit = rev >> 128;
        if (unsplit != 0) {
            toNodeFund = (unsplit * (BPS - BRIDGE_BPS)) / BPS; // rounds down
            toBridge = unsplit - toNodeFund; // remainder always to the bridge pool
            _revenue = uint128(rev); // clear the high half, keep accountedQuote
            emit RevenueSplit(toBridge, toNodeFund);
            _push(_bridge, toBridge, true);
            _push(_nodeFund, toNodeFund, false);
        }
        _retry();
    }

    /// @notice Retries amounts whose earlier push failed. Permissionless.
    function retryPush() external nonReentrant returns (uint256 bridgeSent, uint256 nodeFundSent) {
        uint128 b0 = _stuckBridge;
        uint128 n0 = _stuckNodeFund;
        _retry();
        bridgeSent = b0 - _stuckBridge; // on failure `_push` added the amount back: delta 0
        nodeFundSent = n0 - _stuckNodeFund;
    }

    /* ------------------------------------------------------------------ */
    /*                     the only restricted function                    */
    /* ------------------------------------------------------------------ */

    modifier onlyOwnerOrGuardian() {
        require(
            msg.sender == _owner || msg.sender == _getGuardian(),
            unicode"Only owner or guardian / 仅限 owner 或 Guardian"
        );
        _;
    }

    /// @notice Hands the (fund-powerless) vault ownership to another address. The owner
    ///         and the Flap Guardian can each do this alone (rule 001-d/e).
    function transferOwnership(address newOwner) external nonReentrant onlyOwnerOrGuardian {
        require(newOwner != address(0), unicode"Zero address / 地址为零");
        address old = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    /* ------------------------------------------------------------------ */
    /*                       input-less views (never revert)               */
    /* ------------------------------------------------------------------ */

    function taxToken() external view returns (address) {
        return _taxToken;
    }

    function bridge() external view returns (address) {
        return _bridge;
    }

    function nodeFund() external view returns (address) {
        return _nodeFund;
    }

    function owner() external view returns (address) {
        return _owner;
    }

    /// @notice Recognized BNB that has not been pushed out yet.
    function accountedQuote() external view returns (uint256) {
        return uint128(_revenue);
    }

    /// @notice Recognized BNB that has not been split yet.
    function unsplitRevenue() external view returns (uint256) {
        return _revenue >> 128;
    }

    function stuckAmounts() external view returns (uint256 stuckBridge, uint256 stuckNodeFund) {
        return (_stuckBridge, _stuckNodeFund);
    }

    function lifetimeToBridge() external view returns (uint256) {
        return _lifetimeToBridge;
    }

    function lifetimeToNodeFund() external view returns (uint256) {
        return _lifetimeToNodeFund;
    }

    /// @notice All revenue ever recognized = pushed out + still held.
    function totalRecognized() external view returns (uint256) {
        return uint256(_lifetimeToBridge) + uint256(_lifetimeToNodeFund) + uint128(_revenue);
    }

    function solvency() external view returns (uint256 balance, uint256 accounted, uint256 buckets) {
        uint256 rev = _revenue;
        balance = address(this).balance;
        accounted = uint128(rev);
        buckets = (rev >> 128) + _stuckBridge + _stuckNodeFund;
    }

    /// @notice Native BNB, never WBNB.
    function vaultQuoteToken() public pure override returns (address) {
        return address(0);
    }

    /// @notice Runtime-rendered status banner; flap.sh polls it and VaultPortal mirrors it.
    function description() public view override returns (string memory) {
        return BacVaultUI.describe(
            _taxToken,
            [
                uint256(uint128(_revenue)), // accountedQuote
                uint256(_revenue >> 128), // unsplit
                uint256(_lifetimeToBridge),
                uint256(_lifetimeToNodeFund),
                uint256(_stuckBridge),
                uint256(_stuckNodeFund),
                uint256(BRIDGE_BPS),
                address(this).balance
            ],
            _owner,
            _bridge,
            _nodeFund
        );
    }

    /// @notice The on-chain UI schema (8 input-less views + 2 input-less write methods).
    function vaultUISchema() public pure override returns (VaultUISchema memory) {
        return BacVaultUI.vaultUISchema();
    }

    /* ------------------------------------------------------------------ */
    /*                              internals                              */
    /* ------------------------------------------------------------------ */

    /// @dev Rule 010: recognize by delta only; a zero-delta wake is a silent no-op.
    function _syncRevenue() internal {
        uint256 bal = address(this).balance;
        uint256 rev = _revenue;
        uint256 acct = uint128(rev);
        if (bal <= acct) return;
        uint256 delta = bal - acct;
        _revenue = (((rev >> 128) + delta) << 128) | bal;
        emit RevenueRecognized(msg.sender, delta);
    }

    /// @dev Rule 010: decrement the baseline BEFORE the external call, and re-read
    ///      `_revenue` from storage afterwards — `receive()` may have run inside it.
    function _push(address to, uint256 amount, bool isBridge) internal {
        if (amount == 0) return;
        require(amount <= type(uint128).max, unicode"Amount too large / 金额过大");
        // EIP-150's 63/64 rule: the caller must really have PUSH_GAS left, otherwise
        // "out of gas" would be mistaken for "the target refused" and anyone could
        // book every payment into stuck* by calling settle() with just too little gas.
        require(gasleft() >= PUSH_GAS * 64 / 63 + 10_000, unicode"Not enough gas to push / gas 不足以推送");
        uint256 rev = _revenue;
        uint256 acct = uint128(rev);
        _revenue = rev - (acct < amount ? acct : amount);
        (bool ok,) = to.call{value: amount, gas: PUSH_GAS}(abi.encodeWithSignature("acceptRelease()"));
        uint256 rev2 = _revenue; // MUST be re-read; `rev` is stale after the call
        if (ok) {
            if (isBridge) {
                _lifetimeToBridge += uint128(amount);
            } else {
                _lifetimeToNodeFund += uint128(amount);
            }
            emit PushSucceeded(to, amount);
        } else {
            // Adding the baseline back and booking stuck* must happen together (V10).
            _revenue = rev2 + amount;
            if (isBridge) {
                _stuckBridge += uint128(amount);
            } else {
                _stuckNodeFund += uint128(amount);
            }
            emit PushFailed(to, amount);
        }
    }

    /// @dev Zero the bucket FIRST, then push; `_push`'s failure branch adds it back.
    ///      Written the other way round (zero only on success) every failed retry would
    ///      book stuck* a second time until stuck > balance and the call can never
    ///      succeed again — a permanent deadlock in a vault with no rescue function.
    function _retry() internal {
        uint128 sb = _stuckBridge;
        if (sb != 0) {
            _stuckBridge = 0;
            _push(_bridge, sb, true);
        }
        uint128 sn = _stuckNodeFund;
        if (sn != 0) {
            _stuckNodeFund = 0;
            _push(_nodeFund, sn, false);
        }
    }
}
