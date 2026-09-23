// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Erc8004Gate
/// @notice The entry gate of BNB Agent Chain (decision #31): holding an ERC-8004 agent identity.
///
/// @dev An `internal`-only library, so it is inlined into its caller and never deployed, never
///      linked and never upgradeable on its own.
///
///      WHY EVERY CALL IS A RAW `staticcall`
///      `ownerOf(id)` REVERTS for an id that was never minted (`ERC721NonexistentToken(uint256)`,
///      selector 0x7e273289). Through a normal interface call that revert bubbles up and a caller
///      who mistyped their agent id gets an opaque failure instead of a clean, bilingual "you do
///      not hold this identity". Worse, in `escapeCollect` it would turn a wrong id into a failed
///      escape rather than a rejected one. So: staticcall, check `ok`, check the return length,
///      and only then decode.
///
///      NO REVERSE LOOKUP EXISTS. The registry has 31 public functions and not one of them maps an
///      address to an agent id (about 1,900 candidate signatures probed, zero hits — see
///      docs/research/12-erc8004-and-portal.md §1.3). The caller therefore has to name their own
///      `agentId` and the contract verifies it forwards. That is why `BacBridge.lock` takes an
///      `agentId` parameter at all.
///
///      WHAT THIS GATE IS AND IS NOT
///      It proves that `who` controls agent identity `agentId` on the ERC-8004 registry. It does
///      NOT prove that `who` is an AI: the registry is open, free and unlimited, the token is a
///      transferable ERC-721, and a human can mint one in a single transaction. The honest line
///      that has to survive into every piece of copy is 「我们要求持有 agent 身份，我们不能证明它是 AI」.
///      The real brakes on abuse remain the daily release cap and the per-address exit limit.
library Erc8004Gate {
    /// @dev `ownerOf(uint256)`.
    bytes4 internal constant SEL_OWNER_OF = 0x6352211e;
    /// @dev `getMetadata(uint256,string)`.
    bytes4 internal constant SEL_GET_METADATA = 0xcb4799f2;
    /// @dev The one metadata key this project trusts; `setAgentWallet` is the only writer and it
    ///      demands a signature from the wallet itself (EIP-712 / ERC-1271).
    string internal constant WALLET_KEY = "agentWallet";

    /// @notice The identity's ERC-721 owner, or `address(0)` when the id does not exist.
    /// @dev Never reverts. A registry without code, a reverting registry and an unminted id all
    ///      return zero, so an entry attempt gets a clean refusal rather than a bubbled error.
    function ownerOrZero(address registry, uint256 agentId) internal view returns (address) {
        (bool ok, bytes memory ret) = registry.staticcall(abi.encodeWithSelector(SEL_OWNER_OF, agentId));
        if (!ok || ret.length != 32) return address(0);
        return abi.decode(ret, (address));
    }

    /// @notice The signature-proven operating wallet of the identity, or `address(0)`.
    /// @dev The value comes back as 20 BARE bytes, not an abi-encoded address (measured on
    ///      mainnet). Anything of another length is treated as "not set" rather than guessed at.
    function walletOrZero(address registry, uint256 agentId) internal view returns (address) {
        (bool ok, bytes memory ret) =
            registry.staticcall(abi.encodeWithSelector(SEL_GET_METADATA, agentId, WALLET_KEY));
        if (!ok || ret.length < 64) return address(0);
        bytes memory value = abi.decode(ret, (bytes));
        if (value.length != 20) return address(0);
        return address(bytes20(value));
    }

    /// @notice True when `who` either owns identity `agentId` or is its proven `agentWallet`.
    ///
    /// @dev Deliberately NOT `isAuthorizedOrOwner(address,uint256)`. That function also returns
    ///      true for anyone the holder ever passed to `approve` or `setApprovalForAll`, which
    ///      would let one identity hand entry rights to an unbounded set of addresses. `ownerOf`
    ///      is compared strictly; the second branch is the normal cold-key-holds-the-NFT,
    ///      hot-key-does-the-work shape and is safe because that key is signature-gated.
    function holds(address registry, address who, uint256 agentId) internal view returns (bool) {
        if (who == address(0) || agentId == 0) return false;
        if (ownerOrZero(registry, agentId) == who) return true;
        return walletOrZero(registry, agentId) == who;
    }

    /// @notice True when identity `agentId` has ever been minted.
    function exists(address registry, uint256 agentId) internal view returns (bool) {
        return ownerOrZero(registry, agentId) != address(0);
    }
}
