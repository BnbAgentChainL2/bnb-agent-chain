// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title CancunProbe
/// @notice Proves that the layer chain really executes cancun opcodes (MCOPY, TSTORE, TLOAD).
///
/// @dev The whole probe lives in the CONSTRUCTOR on purpose.
///      `chain/verify-genesis.sh` runs it with `cast call --create <creation bytecode>`, i.e. an
///      `eth_call` with no `to` address: the node executes this init code and returns whatever the
///      constructor returns as the would-be runtime code.  That means:
///        * no transaction, no broadcast, no private key, no funded account, no state change;
///        * it works against a throwaway verification node whose genesis funds nobody;
///        * if `cancunTime` is not active, MCOPY/TSTORE are invalid opcodes and the call reverts,
///          which is exactly the failure we want to be loud.
///
///      Expected return value, as 64 bytes:
///        word 0 = 0x2a                    (written with TSTORE, read back with TLOAD)
///        word 1 = 0xc0ffee...             (the sentinel below, moved with MCOPY)
///      02-CHAIN-SPEC 3.3 step 9 asks for this check because every layer contract is compiled with
///      `evm_version = cancun`; if the chain stopped at shanghai the genesis system contracts would
///      be illegal code at an address that can never be changed.
contract CancunProbe {
    /// @dev Must match SENTINEL in chain/verify-genesis.sh.
    uint256 internal constant SENTINEL = 0xC0FFEE00000000000000000000000000000000000000000000000000C0FFEE;

    constructor() {
        uint256 sentinel = SENTINEL;
        assembly {
            // --- EIP-1153: transient storage ---
            tstore(0x01, 0x2a)
            let t := tload(0x01)

            // --- EIP-5656: MCOPY ---
            mstore(0x80, sentinel)
            mcopy(0xa0, 0x80, 0x20)
            let m := mload(0xa0)

            mstore(0x00, t)
            mstore(0x20, m)
            return(0x00, 0x40)
        }
    }
}
