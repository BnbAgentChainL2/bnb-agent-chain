// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title WBAC — Wrapped BAC
/// @notice Genesis neutral tool @ 0x0000000000000000000000000000000000000106 on BNB Agent Chain.
///         A WETH9-shaped wrapper around the layer's native coin (01-CONTRACT-SPEC §8.4,
///         02-CHAIN-SPEC §2, 决策 #22).
///
///         为什么它在创世里 / Why this is predeployed:
///         Uniswap-V2 式的池子要求两边都是 ERC-20。没有一个公认的 WBAC，agent 手上的 gas 币
///         （层内原生 BAC）就没办法进任何池子，流动性起不来；而只要没预置，早晚会冒出好几个互不
///         兼容的 WBAC，把本来就很薄的流动性切碎。所以它和 Multicall3、CREATE2 部署器一样，
///         属于**中立基础设施**，不是产品。
///
///         它不是 DEX。这里没有池子、没有路由、没有手续费、没有管理员、没有可升级路径、没有任何
///         参数可以被谁改。DEX 仍然由 agent 自己写（00-DESIGN-SPEC §6）。
///
/// @dev Genesis discipline (identical to L2Bridge / L2Gate / AgentBook / FeeSplitter):
///      no constructor, no constructor arguments, no immutables, and **zero storage writes during
///      construction** — `name` / `symbol` / `decimals` are compile-time `constant`s living in the
///      code, not in storage, so the runtime bytecode can be pasted straight into `genesis.alloc`
///      and the account carries no storage at block 0. `contracts/test/WBAC.t.sol` asserts that.
///      (WETH9 itself writes `name` and `symbol` in its constructor; that is the one place where
///      copying it verbatim would have been wrong here.)
///
///      Storage layout — frozen by genesis, never change the order:
///        slot 0: balanceOf
///        slot 1: allowance
///
///      `totalSupply()` is `address(this).balance`, exactly as in WETH9: every WBAC in existence is
///      backed 1:1 by native BAC sitting in this contract, and the invariant is readable by anyone
///      without trusting a counter. (Same caveat as WETH9: coin force-sent by `SELFDESTRUCT` would
///      raise `totalSupply()` above the sum of balances. Nobody can mint against it — it is simply
///      donated to the contract and unreachable.)
contract WBAC {
    // ------------------------------------------------------------------------------- metadata ---

    /// @notice Plain literal, frozen at genesis.
    string public constant name = "Wrapped BAC";

    /// @notice Plain literal, frozen at genesis.
    string public constant symbol = "WBAC";

    /// @notice 18, same as the native coin.
    uint8 public constant decimals = 18;

    // -------------------------------------------------------------------------------- storage ---

    /// @dev slot 0
    mapping(address => uint256) public balanceOf;

    /// @dev slot 1
    mapping(address => mapping(address => uint256)) public allowance;

    // --------------------------------------------------------------------------------- events ---

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    // ------------------------------------------------------------------------ deposit/withdraw ---

    /// @notice Wrap `msg.value` native BAC into the same number of WBAC.
    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    /// @notice Plain native transfers wrap, exactly like WETH9's payable fallback.
    receive() external payable {
        deposit();
    }

    /// @notice Unknown calldata with value also wraps — WETH9 behaves this way and some routers and
    ///         helper contracts rely on it. Unknown calldata with no value is a zero-value deposit,
    ///         which is what WETH9 does too, so nothing that works against WETH9 breaks here.
    fallback() external payable {
        deposit();
    }

    /// @notice Burn `wad` WBAC and send back the same number of native BAC.
    /// @dev Checks-effects-interactions: the balance is debited before the transfer, so re-entering
    ///      `withdraw` can only ever spend what is left.
    ///
    ///      DELIBERATE DEVIATION FROM WETH9 (the only one): WETH9 pays out with `transfer`, which
    ///      forwards a 2,300 gas stipend. On this chain every account that matters is a contract —
    ///      agents are programs, not people — and a 2,300 gas stipend cannot cover a `receive()`
    ///      that writes one storage slot. Copying `transfer` here would brick withdrawals for most
    ///      agents. `call` with a checked return value is strictly more permissive: everything that
    ///      succeeds under `transfer` also succeeds here.
    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, unicode"Insufficient WBAC balance / WBAC 余额不足");
        balanceOf[msg.sender] -= wad;
        (bool sent,) = msg.sender.call{value: wad}("");
        require(sent, unicode"Native transfer failed / 原生币转账失败");
        emit Withdrawal(msg.sender, wad);
    }

    // ----------------------------------------------------------------------------- ERC-20 core ---

    /// @notice Native BAC held here, which is by construction the sum of all balances.
    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice WETH9 approve semantics: a plain overwrite, no zero-first dance, no return-value
    ///         quirks. `type(uint256).max` means "infinite" to `transferFrom` (see below).
    function approve(address guy, uint256 wad) external returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    /// @notice WETH9 allowance handling, kept byte-for-byte in behaviour because Uniswap-V2-style
    ///         routers and pairs depend on it:
    ///           * a third-party spender holding `type(uint256).max` is NOT decremented (the
    ///             infinite-allowance convention);
    ///           * `src == msg.sender` skips the allowance check entirely, so `transfer` needs no
    ///             self-approval;
    ///           * insufficient balance and insufficient allowance both revert.
    ///         There is deliberately no `dst != address(0)` check: WETH9 has none, and adding one
    ///         would make this wrapper behave differently from every other WETH9 an agent has seen.
    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, unicode"Insufficient WBAC balance / WBAC 余额不足");

        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, unicode"Insufficient WBAC allowance / WBAC 授权额度不足");
            allowance[src][msg.sender] -= wad;
        }

        balanceOf[src] -= wad;
        balanceOf[dst] += wad;

        emit Transfer(src, dst, wad);
        return true;
    }
}
