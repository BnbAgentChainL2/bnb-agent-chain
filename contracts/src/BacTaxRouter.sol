// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";

/// @title BacTaxRouter
/// @notice The address we name as the Flap `beneficiary` / `FeeConfig.marketingAddress` when BAC is
///         launched through the plain Portal (`newTokenV6`). Decision #30 removed the vault factory
///         and the vault: this contract replaces both, and it is the ONLY thing standing between the
///         token's `TaxProcessor` and the two buckets.
///
///         HOW THE MONEY ARRIVES. `TaxProcessor.dispatch()` is permissionless and pays, in order,
///         the protocol fee, the commission, then `marketAddress` (us), then the dividend contract.
///         Our share arrives as a PLAIN NATIVE BNB TRANSFER: no selector, no callback, no return
///         value — it lands in `receive()`. `feeRate = 1000` bps on the live Portal, so the protocol
///         takes 10% off the top first and what reaches this contract is about `0.90 x tax`. Every
///         "half of the tax goes to the bridge" number in any piece of copy has to be written
///         against that post-fee base, never against the gross tax.
///
///         WHY `receive()` IS ONLY BOOKKEEPING. The dispatch reaches us inside `call{gas: 50_000}`
///         (52,300 usable with the value stipend). Two onward transfers do not fit in that budget,
///         and a revert here is not retried: `marketQuoteBalance` is zeroed by the dispatch and the
///         BNB stays behind in the TaxProcessor as WBNB, permanently forfeited. So `receive()` does
///         exactly one packed SSTORE and one event, makes no external call, and MUST NEVER REVERT.
///         Pushing the money onward is a separate, permissionless `settle()`.
///
///         THE SPLIT. 50/50, a hard-coded constant with no setter: half to `BacBridge` (the bridge
///         pool that pays agent exits), half to `BacNodeFund` (the official node fund, which its own
///         owner may withdraw at any time — decision #10). The node-fund half is computed as
///         `unsplit - toBridge`, so the at-most-1-wei rounding remainder always lands in the bridge
///         pool. The push happens immediately, so this contract holds ~nothing at rest.
///
///         THIS CONTRACT HAS NO OWNER. No admin, no upgrade path, no emergency withdrawal, no
///         rescue function, no setter of any kind — there is not one function here that checks
///         `msg.sender`. The only two addresses it can ever pay are the two immutables fixed at
///         construction. That is not true of what it pays INTO: the project can upgrade the bridge
///         contract, change the rules, and take the entire bridge pool at any time (decision #29),
///         and `description()` says so in the words the site and the X posts have to repeat.
///
///         FAILURE IS BOOKED, NEVER SWALLOWED. If a push fails (a paused or reverting target) the
///         amount goes back into the book and into `stuckBridge` / `stuckNodeFund`, and anyone can
///         call `retryPush()` later. No path exists that can strand the money.
contract BacTaxRouter is ReentrancyGuard {
    uint16 public constant BPS = 10000;
    /// @dev The one number that decides the split. No setter exists, here or anywhere else.
    uint16 public constant BRIDGE_BPS = 5000;
    /// @notice Gas handed to each downstream `acceptRelease()`. `BacBridge.acceptRelease` writes
    ///         two storage slots on the post-halt path, so 2300 is nowhere near enough.
    /// @dev Since decision #29 the bridge is an ERC1967 proxy, so every push also pays the
    ///      proxy's implementation-slot read and its DELEGATECALL. This constant is frozen while
    ///      the bridge can be upgraded at will: any future bridge implementation whose
    ///      `acceptRelease()` needs more than this, or reverts, sends every bridge half into
    ///      `stuckBridge` until an implementation that fits is installed. The money is not lost —
    ///      `retryPush()` delivers it then — but that is a constraint on every bridge upgrade.
    uint256 public constant PUSH_GAS = 100_000;

    /// @notice The BAC token this router is bound to. Its address is the mined ...7777 CREATE2
    ///         address and has NO CODE when this contract is deployed, so nothing here may call it.
    address public immutable bacToken;
    /// @notice The bridge pool. Receives `BRIDGE_BPS` plus the rounding remainder.
    /// @dev The `BacBridge` PROXY address. The bare implementation cannot be wired here by
    ///      mistake: its storage is never initialised, so its `bacToken()` is address(0) and the
    ///      constructor's cross-check rejects it.
    address public immutable bridge;
    /// @notice The official node fund (decision #10: its owner can withdraw this half).
    address public immutable nodeFund;

    /* ------------------------------------------------------------------ */
    /*                               storage                               */
    /* ------------------------------------------------------------------ */

    /// @dev One packed slot: low 128 bits = `accountedQuote` (the balance baseline), high 128 bits
    ///      = revenue recognized but not yet split. `receive()` touches this slot and nothing else.
    uint256 private _revenue;
    uint128 private _stuckBridge;
    uint128 private _stuckNodeFund;
    uint128 private _lifetimeToBridge;
    uint128 private _lifetimeToNodeFund;

    event RevenueRecognized(address indexed from, uint256 amount);
    event RevenueSplit(uint256 toBridge, uint256 toNodeFund);
    event PushSucceeded(address indexed to, uint256 amount);
    event PushFailed(address indexed to, uint256 amount);

    /// @param bacToken_ the predicted BAC token address (no code yet at this point)
    /// @param bridge_   a deployed and initialised `BacBridge` proxy
    /// @param nodeFund_ a deployed `BacNodeFund`
    /// @dev Both downstreams must already exist and must already be bound to the same `bacToken_`.
    ///      This constructor is the only place that check can be made. Flap's Portal accepts any
    ///      `beneficiary` without looking at it (it even accepts address(0) — measured, research 12
    ///      §2.4), and once BAC is launched this project has no way to change the beneficiary, so a
    ///      router wired to the wrong pair would mean launching the token again.
    constructor(address bacToken_, address bridge_, address nodeFund_) {
        require(bacToken_ != address(0), unicode"Zero BAC token / BAC 代币地址为零");
        require(bridge_ != address(0) && nodeFund_ != address(0), unicode"Zero address / 地址为零");
        require(bridge_ != nodeFund_, unicode"Bridge and node fund must differ / 桥与节点基金不能是同一个地址");
        require(bridge_.code.length > 0, unicode"Bridge has no code / 桥地址没有代码");
        require(nodeFund_.code.length > 0, unicode"Node fund has no code / 节点基金地址没有代码");
        require(
            _boundToken(bridge_) == bacToken_, unicode"BacBridge.bacToken() mismatch / 桥绑定的代币不是 T"
        );
        require(
            _boundToken(nodeFund_) == bacToken_, unicode"BacNodeFund.bacToken() mismatch / 节点基金绑定的代币不是 T"
        );
        bacToken = bacToken_;
        bridge = bridge_;
        nodeFund = nodeFund_;
    }

    /* ------------------------------------------------------------------ */
    /*                            money coming in                          */
    /* ------------------------------------------------------------------ */

    /// @notice The tax entry point. 1 SLOAD + SELFBALANCE + 1 SSTORE + 1 event, no loop, no external
    ///         call — and it MUST NEVER REVERT, because a reverting recipient forfeits that dispatch
    ///         permanently. Deliberately NOT `nonReentrant`: a downstream `acceptRelease()` is
    ///         allowed to hand BNB straight back while a push is still open.
    receive() external payable {
        _syncRevenue();
    }

    /// @notice Same bookkeeping under the name the two downstream contracts use, so anything that
    ///         pays a "release" into any BAC contract can use one calling convention.
    function acceptRelease() external payable {
        _syncRevenue();
    }

    /// @notice Recognize a balance that arrived outside `receive()` — a `selfdestruct` push, a
    ///         coinbase payment, or a plain transfer that landed before this contract had code.
    ///         Side-effect free and permissionless; a zero delta is a silent no-op.
    function sync() external nonReentrant {
        _syncRevenue();
    }

    /* ------------------------------------------------------------------ */
    /*                           money going out                           */
    /* ------------------------------------------------------------------ */

    /// @notice Splits everything recognized-but-unsplit 50/50 and pushes both halves out, then
    ///         retries anything stuck from before. Permissionless and unpaid. It does not fail
    ///         because a target rejected the transfer — that is booked into `stuck*` instead.
    /// @return toBridge amount booked for the bridge pool (the accounting move, not the transfer)
    /// @return toNodeFund amount booked for the node fund
    function settle() external nonReentrant returns (uint256 toBridge, uint256 toNodeFund) {
        return _settle();
    }

    /// @notice `settle()` under the name `docs/research/12-erc8004-and-portal.md` §2.7 gave it.
    function flush() external nonReentrant returns (uint256 toBridge, uint256 toNodeFund) {
        return _settle();
    }

    /// @notice Retries amounts whose earlier push failed. Permissionless.
    /// @return bridgeSent how much of the stuck bridge amount actually left this time
    /// @return nodeFundSent how much of the stuck node-fund amount actually left this time
    function retryPush() external nonReentrant returns (uint256 bridgeSent, uint256 nodeFundSent) {
        uint128 b0 = _stuckBridge;
        uint128 n0 = _stuckNodeFund;
        _retry();
        bridgeSent = b0 - _stuckBridge; // on failure `_push` put the amount back: delta 0
        nodeFundSent = n0 - _stuckNodeFund;
    }

    /* ------------------------------------------------------------------ */
    /*                                views                                */
    /* ------------------------------------------------------------------ */

    /// @notice BNB this contract has recognized and not pushed out yet (the balance baseline).
    function accountedQuote() external view returns (uint256) {
        return uint128(_revenue);
    }

    /// @notice BNB recognized but not split yet.
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

    /// @notice Everything ever recognized = pushed out + still held.
    function totalRecognized() external view returns (uint256) {
        return uint256(_lifetimeToBridge) + uint256(_lifetimeToNodeFund) + uint128(_revenue);
    }

    /// @notice The three numbers the site's solvency line is drawn from. `balance >= accounted`
    ///         always (untracked BNB is simply not booked yet) and `buckets <= accounted` always.
    function solvency() external view returns (uint256 balance, uint256 accounted, uint256 buckets) {
        uint256 rev = _revenue;
        balance = address(this).balance;
        accounted = uint128(rev);
        buckets = (rev >> 128) + _stuckBridge + _stuckNodeFund;
    }

    /// @notice The on-chain disclosure (decisions #10, #24b, #29a, #31a). The bare Portal path gives
    ///         the token itself no `description()`, so this is where the sentence that decision #29a
    ///         makes mandatory lives. The site's first screen, the footer and the first reply under
    ///         every X post must carry it word for word identical to the string below.
    function description() external pure returns (string memory) {
        return unicode"BNB Agent Chain (BAC) 交易税路由 BacTaxRouter。\n"
        unicode"本合约是 BAC 代币在 flap 上填写的收款地址（beneficiary / marketingAddress）。"
        unicode"Flap 协议先抽走 10% 协议费，到这里的是税后的约 0.90 倍；"
        unicode"到账后按 50/50 分成两半：一半推给桥合约 BacBridge 的桥池，一半推给官方节点基金 BacNodeFund。"
        unicode"分账比例写死在代码里，没有 setter。\n"
        unicode"项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。\n"
        unicode"官方节点基金这一半由 BacNodeFund 的 owner 随时提取，用于服务器与节点搭建。\n"
        unicode"本路由合约自己没有 owner、没有管理员、没有升级入口、没有紧急提取，任何人都可以触发它的分账。\n"
        unicode"入场要求持有 ERC-8004 agent 身份（我们读的是 ERC-8004 官方仓库列出的 BSC 注册表 "
        unicode"0x8004A169FB4a3325136EB29fA0ceB6D2e539a432）。我们要求持有 agent 身份，我们不能证明它是 AI。\n"
        unicode"退出拿到的是桥用 BNB 在市场上回购来的 BAC，比直接拿 BNB 多烧掉约 4%，退出者严格更亏。\n"
        unicode"不承诺任何收益。\n"
        unicode"EN: BacTaxRouter is the Flap tax beneficiary of BAC. It splits every BNB it receives "
        unicode"50/50 between the bridge pool and the official node fund, holds nothing at rest and "
        unicode"has no owner. The project can upgrade the bridge contract, change its rules, and "
        unicode"withdraw the entire bridge pool at any time. Entry requires holding an ERC-8004 agent "
        unicode"identity; that identity does not prove the holder is an AI.";
    }

    /* ------------------------------------------------------------------ */
    /*                              internals                              */
    /* ------------------------------------------------------------------ */

    /// @dev The whole of `settle()` / `flush()`. Both wrappers are `nonReentrant`, so this runs
    ///      once at a time even though a downstream may call back in.
    function _settle() internal returns (uint256 toBridge, uint256 toNodeFund) {
        _syncRevenue();
        uint256 rev = _revenue;
        uint256 unsplit = rev >> 128;
        if (unsplit != 0) {
            toNodeFund = (unsplit * (BPS - BRIDGE_BPS)) / BPS; // rounds down
            toBridge = unsplit - toNodeFund; // the <=1 wei remainder always goes to the bridge pool
            _revenue = uint128(rev); // clear the high half, keep the baseline
            emit RevenueSplit(toBridge, toNodeFund);
            _push(bridge, toBridge, true);
            _push(nodeFund, toNodeFund, false);
        }
        _retry();
    }

    /// @dev Recognize by delta only. A zero-delta wake is a silent no-op, never a revert.
    function _syncRevenue() internal {
        uint256 bal = address(this).balance;
        uint256 rev = _revenue;
        uint256 acct = uint128(rev);
        if (bal <= acct) return;
        uint256 delta = bal - acct;
        _revenue = (((rev >> 128) + delta) << 128) | bal;
        emit RevenueRecognized(msg.sender, delta);
    }

    /// @dev Decrement the baseline BEFORE the external call, and re-read `_revenue` from storage
    ///      afterwards — `receive()` may have run inside that call and rewritten the slot.
    function _push(address to, uint256 amount, bool isBridge) internal {
        if (amount == 0) return;
        require(amount <= type(uint128).max, unicode"Amount too large / 金额过大");
        // EIP-150's 63/64 rule: the caller must really have `PUSH_GAS` to give. Without this check
        // "out of gas" and "the target refused" are indistinguishable, and anyone could book every
        // payment into `stuck*` by calling `settle()` with just too little gas.
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
            // Putting the baseline back and booking `stuck*` has to happen together.
            _revenue = rev2 + amount;
            if (isBridge) {
                _stuckBridge += uint128(amount);
            } else {
                _stuckNodeFund += uint128(amount);
            }
            emit PushFailed(to, amount);
        }
    }

    /// @dev Zero the bucket FIRST, then push; `_push`'s failure branch adds it back. Written the
    ///      other way round (zero only on success) every failed retry would book `stuck*` a second
    ///      time until `stuck > balance` and no call could ever succeed again — a permanent
    ///      deadlock in a contract with no rescue function.
    function _retry() internal {
        uint128 sb = _stuckBridge;
        if (sb != 0) {
            _stuckBridge = 0;
            _push(bridge, sb, true);
        }
        uint128 sn = _stuckNodeFund;
        if (sn != 0) {
            _stuckNodeFund = 0;
            _push(nodeFund, sn, false);
        }
    }

    /// @dev `bacToken()` on a downstream, read without importing an interface so a target that does
    ///      not implement it fails the constructor check instead of reverting the deployment with an
    ///      undecodable error.
    function _boundToken(address target) internal view returns (address) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("bacToken()"));
        require(ok && ret.length == 32, unicode"Target has no bacToken() / 目标合约没有 bacToken()");
        return abi.decode(ret, (address));
    }
}
