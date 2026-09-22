// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BacNodeFund
/// @notice The official node fund (docs/01-CONTRACT-SPEC.md §5, decision #10): the half of the
///         tax revenue that the project address may withdraw, held in its own non-upgradeable
///         contract so the disclosure is a public on-chain fact.
///
///         Only `owner` can withdraw. The Flap Guardian cannot — this is not a Flap vault and is
///         not governed by Flap rule 001. There is no proxy, no upgrade path, no token-rescue
///         function and no second way out. This contract holds no BAC: `bacToken` exists solely
///         so `BacVaultFactory.newVault` can cross-check the token binding at launch (G2).
///
///         N2: there is no path from this contract to `BacBridge`'s pool. The bridge-pool half of
///         the revenue is pushed straight to `BacBridge` by the vault and never passes through here.
contract BacNodeFund {
    address public immutable bacToken;

    address public owner;
    address public pendingOwner;

    uint256 public lifetimeReceived;
    uint256 public lifetimeWithdrawn;

    event ReleaseReceived(address indexed from, uint256 amount, uint256 balanceAfter);
    event Withdrawn(address indexed to, uint256 amount, uint256 balanceAfter);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    constructor(address bacToken_, address owner_) {
        require(bacToken_ != address(0), unicode"Zero BAC token / BAC 代币地址为零");
        require(owner_ != address(0), unicode"Zero owner / owner 地址为零");
        bacToken = bacToken_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice Permissionless: the vault pushes the node-fund half here; anyone may donate.
    /// @dev Deliberately the only payable entry point — there is no `receive()`, so a plain send
    ///      reverts instead of quietly landing outside `lifetimeReceived`.
    function acceptRelease() external payable {
        lifetimeReceived += msg.value;
        emit ReleaseReceived(msg.sender, msg.value, address(this).balance);
    }

    /// @notice Owner-only withdrawal (decision #10). `amount == 0` means the whole balance.
    function withdraw(address to, uint256 amount) external {
        require(msg.sender == owner, unicode"Only owner / 仅限 owner");
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        uint256 bal = address(this).balance;
        if (amount == 0) amount = bal;
        require(amount > 0, unicode"Nothing to withdraw / 没有可提取的金额");
        require(amount <= bal, unicode"Amount exceeds balance / 金额超过余额");

        lifetimeWithdrawn += amount;
        emit Withdrawn(to, amount, bal - amount);
        (bool ok,) = to.call{value: amount}("");
        require(ok, unicode"BNB transfer failed / BNB 转账失败");
    }

    /// @notice Step 1 of the two-step transfer. Every change is indexed and shown on the site,
    ///         because the vault's `description()` renders this address at runtime.
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, unicode"Only owner / 仅限 owner");
        require(newOwner != address(0), unicode"Zero owner / owner 地址为零");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2 of the two-step transfer.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, unicode"Only pending owner / 仅限待定 owner");
        address from = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(from, owner);
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
