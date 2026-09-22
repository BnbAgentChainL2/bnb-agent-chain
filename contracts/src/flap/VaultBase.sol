// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

/// @title VaultBase
/// @notice Abstract base contract for all vault implementations
/// @author The Flap Team
/// @dev How to implement your own vault contract:
///
/// 1. **Inherit from this base contract**
///    - All vault implementations must extend this contract
///
/// 2. **Implement the description() method**
///    - This method should return a dynamic string describing the vault's current state
///    - The description should change based on vault state (e.g., balance, streaming status, etc.)
///    - Example: "Flap Tax Vault for TOKEN, this vault automatically buyback tokens, we have bought back 3.2M tokens. Developed by Alice (twitter.com/alice)"
///
/// 3. **Use _getPortal() for Portal interactions**
///    - Call this internal method to get the Portal address for the current chain
///    - The method reverts if the current chain is not supported
///    - Currently only BNB Chain (chain ID 56) and BNB Testnet (chain ID 97) are supported
///
/// 4. **Use _getGuardian() for Guardian address**
///    - Call this internal method to get the Guardian address for the current chain
///    - The Guardian is a privileged address that can always call permissioned functions if you have any
///    - The method reverts if the current chain is not supported
///    - Currently only BNB Chain (chain ID 56) and BNB Testnet (chain ID 97) are supported
///
/// 5. **Handle tax token revenue**
///    - Implement a receive() function to accept BNB from the tax token
///    - Process the revenue according to your vault's logic (accumulate, stream, buyback, etc.)
///
/// 6. **MANDATE: Guardian access to permissioned functions**
///    - If you have any permissioned functions that should be triggered by an external address,
///      and it is not suitable to make them public (e.g. buyback which may be sandwich attacked),
///      you MUST ALSO give the guardian address the permissions alongside other allowed addresses as a backup.
///    - The guardian can always call permissioned functions and must have the necessary roles/permissions.
///    - The guardian's role MUST NOT be revocable by any other account — only the guardian itself
///      may renounce its own access.
///
///    When using OpenZeppelin's `AccessControl`, override `revokeRole()` to enforce this:
///
///      ```
///      function revokeRole(bytes32 role, address account)
///          public
///          override
///          onlyRole(getRoleAdmin(role))
///      {
///          address guardian = _getGuardian();
///          if (account == guardian) {
///              revert CannotRevokeGuardianRole();
///          }
///          super.revokeRole(role, account);
///      }
///      ```
///
///    This ensures that the Guardian always retains a backup path to call
///    permissioned functions, regardless of any admin action.
///
abstract contract VaultBase {
    /// @notice Error thrown when the current chain is not supported
    error UnsupportedChain(uint256 chainId);

    /// @notice Get the Portal address for the current chain
    /// @dev Currently supports BNB Chain (chain ID 56) and BNB Testnet (chain ID 97)
    /// @return portal The Portal contract address
    function _getPortal() internal view returns (address portal) {
        uint256 chainId = block.chainid;
        if (chainId == 56) {
            // BNB Chain Portal
            return 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
        } else if (chainId == 97) {
            // BNB Testnet Portal
            return 0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9;
        } else if (chainId == 4663 || chainId == 46630) {
            // Robinhood Chain Portal
            return 0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09;
        }
        revert UnsupportedChain(chainId);
    }

    /// @notice Get the Guardian address for the current chain
    /// @dev Currently supports BNB Chain (chain ID 56) and BNB Testnet (chain ID 97)
    /// @return guardian The Guardian contract address
    function _getGuardian() internal view returns (address guardian) {
        uint256 chainId = block.chainid;
        if (chainId == 56) {
            // BNB Chain Guardian address
            return 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b;
        } else if (chainId == 97) {
            // BNB Testnet Guardian address
            return 0x76Fa8C526f8Bc27ba6958B76DeEf92a0dbE46950;
        } else if (chainId == 4663 || chainId == 46630) {
            // Robinhood Chain Guardian address
            return 0x0000b48720d3B4ED6BC5031768B07F2b59270000;
        }
        revert UnsupportedChain(chainId);
    }

    /// @notice Returns a description of the vault
    /// @dev This method should be overridden by implementing contracts to provide
    ///      a dynamic description based on the vault's current state
    /// @return A string describing the vault's current state and configuration
    function description() public view virtual returns (string memory);
}
