// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IErc8004Identity
/// @notice The three members of the ERC-8004 Identity Registry that this project reads.
///
/// @dev EVERY signature here was taken from the disassembled dispatcher of the implementation
///      actually deployed on BSC, not from the ERC-8004 README
///      (docs/research/12-erc8004-and-portal.md §1.2). The README's `getAgentWallet(uint256)`
///      DOES NOT EXIST in the v2.0.0 implementation on BSC: code written against it compiles and
///      then reverts on every call. Do not add a member to this file without disassembling first.
///
///      Registry addresses (§1.9):
///        BSC mainnet (56)  Identity 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
///                          Reputation 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
///        BSC testnet (97)  Identity 0x8004A818BFB912233c491871b3d84c89A494BD9e
///                          Reputation 0x8004B663056A597Dffe9eCcC1965A193B7388713
///      There is NO Validation Registry on BSC. Do not reference one.
///
///      WARNING, and it has to stay in the copy: an ERC-8004 identity does not prove that its
///      holder is an AI. `register()` is open, free (108,899 gas, non-payable), unlimited per
///      address, and the token is a plain transferable ERC-721. Ten thousand identities cost about
///      0.054 BNB. The gate keeps out a passer-by's address; it does not keep out a human, and it
///      is not a sybil defence. 我们要求持有 agent 身份，我们不能证明它是 AI。
interface IErc8004Identity {
    /// @notice ERC-721 owner. REVERTS (`ERC721NonexistentToken`) for an id that was never minted,
    ///         which is why every call site in this repo goes through `Erc8004Gate`'s staticcall
    ///         rather than through this interface directly.
    function ownerOf(uint256 agentId) external view returns (address);

    /// @notice Arbitrary metadata. Only the reserved key `"agentWallet"` is trusted by this
    ///         project: it can be written solely through `setAgentWallet`, which requires a
    ///         signature from the wallet itself, and a plain `setMetadata` on that key reverts
    ///         `"reserved key"` (measured on mainnet). Every OTHER key is holder-writable prose
    ///         and must never gate anything.
    /// @return The raw value. For `"agentWallet"` it is 20 bare bytes, NOT an abi-encoded address.
    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory);

    /// @notice The EIP-8004 registration file, as a `data:application/json;base64,...` URI.
    /// @dev Entirely self-reported by the registrant and checked by nobody. Anything rendered from
    ///      it must be labelled as such, and its `image` URL must never be loaded directly.
    function tokenURI(uint256 agentId) external view returns (string memory);
}
