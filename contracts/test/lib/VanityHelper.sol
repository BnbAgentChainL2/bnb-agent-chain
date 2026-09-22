// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";

/// @title VanityHelper
/// @notice Utility for finding CREATE2 salts that produce vanity address suffixes.
/// @dev Used in tests and scripts to deterministically find a salt that results in an address
///      ending with specific hex bytes (e.g., 0x8888, 0x7777, 0x1111).
///      The token implementation address and the portal (deployer) address together with the
///      salt determine the final token address via ClonesUpgradeable.cloneDeterministic.
contract VanityHelper {
    bytes32 private salt = keccak256(abi.encodePacked(block.number));

    enum VanityType {
        VANITY_8888,
        VANITY_7777,
        VANITY_1111
    }

    /// @notice Find a salt whose predicted clone address ends with the requested vanity suffix.
    /// @param t      Which 2-byte suffix to target (8888 / 7777 / 1111).
    /// @param impl   The implementation contract address (e.g., tokenImplTaxedV3).
    /// @param portal The deployer / factory contract that will call cloneDeterministic.
    /// @return The first salt found that produces the desired suffix.
    function _findVanitySalt(VanityType t, address impl, address portal) internal returns (bytes32) {
        salt = bytes32(uint256(salt) + 1);
        while (true) {
            address predicted = ClonesUpgradeable.predictDeterministicAddress(address(impl), salt, address(portal));
            if (
                (t == VanityType.VANITY_8888 && _endsWith8888(predicted))
                    || (t == VanityType.VANITY_7777 && _endsWith7777(predicted))
                    || (t == VanityType.VANITY_1111 && _endsWith1111(predicted))
            ) {
                return salt;
            }
            salt = bytes32(uint256(salt) + 1);
        }
        return bytes32(0);
    }

    /// @notice Find a salt whose predicted clone address ends with a custom 2-byte suffix.
    /// @param suffix Two bytes to match at positions [18] and [19] of the predicted address.
    /// @param impl   The implementation contract address.
    /// @param portal The deployer / factory contract.
    /// @return The first salt found that produces the desired suffix.
    function _findVanitySaltV2(bytes2 suffix, address impl, address portal) internal returns (bytes32) {
        salt = bytes32(uint256(salt) + 1);
        while (true) {
            address predicted = ClonesUpgradeable.predictDeterministicAddress(address(impl), salt, address(portal));
            bytes20 addrBytes = bytes20(predicted);
            if (addrBytes[18] == suffix[0] && addrBytes[19] == suffix[1]) {
                return salt;
            }
            salt = bytes32(uint256(salt) + 1);
        }
        return bytes32(0);
    }

    /// @notice rat adaptation (the only change against 某个更早的同类项目's copy): restart the search from `seed`.
    /// @dev Suites that fork inside setUp() are constructed before the fork, so the default seed
    ///      keccak256(block.number) is the same for all of them and can land on a mainnet address that is
    ///      already staged (VaultPortal reverts TokenAlreadyStaged). Seed from fork data instead.
    function _seedVanitySalt(bytes32 seed) internal {
        salt = seed;
    }

    function _predictAddress(address impl, bytes32 _salt, address portal) internal pure returns (address) {
        return ClonesUpgradeable.predictDeterministicAddress(address(impl), _salt, address(portal));
    }

    function _endsWith8888(address addr) internal pure returns (bool) {
        bytes20 addrBytes = bytes20(addr);
        return addrBytes[18] == 0x88 && addrBytes[19] == 0x88;
    }

    function _endsWith7777(address addr) internal pure returns (bool) {
        bytes20 addrBytes = bytes20(addr);
        return addrBytes[18] == 0x77 && addrBytes[19] == 0x77;
    }

    function _endsWith1111(address addr) internal pure returns (bool) {
        bytes20 addrBytes = bytes20(addr);
        return addrBytes[18] == 0x11 && addrBytes[19] == 0x11;
    }
}
