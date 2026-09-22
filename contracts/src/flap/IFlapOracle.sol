// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

/// @title IFlapOracle
/// @notice Interface for the Flap General Oracle used to verify off-chain signatures on-chain.
/// @dev The FlapOracle is deployed on each supported chain and exposes a single `verify()` method.
///      Vault contracts (e.g., FlapXVault) use it to validate backend-signed payloads before
///      executing privileged operations such as social-proof claims.
///
/// Deployed addresses (BSC Mainnet chainId=56):
///   0x6C88a672086f4A5dD8D73A93193c78a68cE4bDbe
interface IFlapOracle {
    /// @notice Verify an EIP-712 structured-data signature against the oracle's signing key.
    /// @param structHash The EIP-712 struct hash of the data to verify (keccak256 of the encoded struct).
    /// @param signature  The ECDSA signature produced by the oracle signer over the full EIP-712 digest.
    /// @return valid True if the recovered signer matches the oracle's registered signer address.
    function verify(bytes32 structHash, bytes calldata signature) external view returns (bool valid);

    /// @notice Returns the current signer address registered in the oracle.
    /// @return The address whose private key signs oracle payloads.
    function signer() external view returns (address);
}
