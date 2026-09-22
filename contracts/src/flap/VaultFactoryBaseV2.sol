// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

import {IVaultFactory, IVaultFactoryValidationV2} from "./IVaultFactory.sol";
import {VaultDataSchema, FactoryPolicy} from "./IVaultSchemasV1.sol";
import {IVaultPortalTypes} from "./IVaultPortal.sol";

/// @title VaultFactoryBaseV2
/// @author The Flap Team
/// @notice Extended abstract base contract for vault factory implementations
///         that adds:
///           1. On-chain UI schema discovery via `vaultDataSchema()`
///           2. A `_getGuardian()` helper (mirrors VaultBase's pattern)
///           3. (v2.1) Policy discovery via `tokenCreationPolicies()` so the
///                    UI can surface validation hints before a transaction
///           4. (v2.2) `factorySpecVersion()` to identify the spec revision
///           5. (v2.2) `onBeforeLaunch(bytes)` for wrapper-agnostic pre-launch validation
///
/// @dev  ── MOTIVATION ───────────────────────────────────────────────────────
///
/// The protocol is designed so that anyone can introduce new vault types.
/// Any contract that implements `VaultFactoryBaseV2` can be passed to
/// VaultPortal to launch tokens — no on-chain registration is required.
/// Each factory decodes the
/// opaque `vaultData` bytes parameter in `newVault()` differently — a
/// generic UI has no way to know what fields to render without inspecting
/// each factory's source code.
///
/// Existing factories (FlapXVaultFactory, SplitVaultFactory,
/// SnowBallFactory) already have purpose-built UIs.  `VaultFactoryBaseV2`
/// exists to support **future** factories: by requiring every new factory
/// to override `vaultDataSchema()`, the UI can automatically generate a
/// creation form for any vault type — even ones that did not exist when
/// the UI was built.
///
/// `vaultDataSchema()` returns a `VaultDataSchema` struct (defined in
/// `IVaultSchemasV1.sol`) that fully describes the shape of `vaultData`.
///
///
/// ── BACKWARDS COMPATIBILITY ────────────────────────────────────────────────
///
/// `VaultFactoryBaseV2` is a new abstract contract that implements the
/// existing `IVaultFactory` interface.  Existing factory contracts that
/// directly implement `IVaultFactory` are unaffected.  New or upgraded
/// factory implementations should extend `VaultFactoryBaseV2` instead of
/// implementing `IVaultFactory` directly, to gain:
///   - `vaultDataSchema()` for UI auto-generation
///   - `_getGuardian()` for guardian address resolution
///
///
/// ── HOW TO IMPLEMENT ───────────────────────────────────────────────────────
///
/// 1. **Inherit from VaultFactoryBaseV2**.
///    All obligations from `IVaultFactory` still apply (implement `newVault()`
///    and `isQuoteTokenSupported()`).
///
/// 2. **Override `vaultDataSchema()`** to return a `VaultDataSchema`
///    describing the fields your factory expects in the `vaultData` parameter.
///
///    The schema has three components:
///      - `description` – free-form string explaining what the vault does
///        and what data is required (shown to the user in the UI).
///      - `fields`      – ordered array of `FieldDescriptor`, each describing
///        one component of the ABI-encoded tuple.
///      - `isArray`     – true if `vaultData` is an array of tuples.
///
///    The current spec supports two shapes:
///      • A single tuple    (`isArray == false`)  – e.g. `(string)`
///      • An array of tuples (`isArray == true`)  – e.g. `(address,uint16)[]`
///
///    If `fields` is empty and `isArray` is false, the factory ignores
///    `vaultData` entirely.
///
/// 3. **MANDATE: Guardian access to privileged functions**
///    If your factory (or the vaults it creates) exposes any privileged /
///    role-gated functions, the Guardian address returned by `_getGuardian()`
///    **must** also be granted the required role(s).  Furthermore, the
///    Guardian's role **must not** be revocable by any other account — only
///    the Guardian itself may renounce its own access.
///
///    When using OpenZeppelin's `AccessControl`, override `revokeRole()` to
///    enforce this invariant:
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
///
/// ── HOW THE UI USES VaultDataSchema ────────────────────────────────────────
///
///   1. UI obtains the factory address (e.g. from the token-launch event
///      or a directory service).
///   2. UI calls factory.vaultDataSchema() → gets VaultDataSchema.
///   3. For each field in schema.fields, UI renders an input widget:
///        "string"   → text input
///        "address"  → address input (with checksum validation)
///        "uint16"   → number input (0–65535)
///        "uint256"  → big-number input
///        "time"     → date/time picker input (alias for uint256;
///                      value is a Unix timestamp in seconds).
///                      When used in outputs, rendered as a
///                      human-readable time string or countdown clock
///        "bool"     → checkbox
///        "bytes"    → hex input
///        "bytes32"  → hex input (32 bytes)
///      For numeric fields, if field.decimals > 0 the UI multiplies the
///      user's input by 10^decimals before encoding.
///        e.g. decimals=18: user types "1" → encoded value is 1e18
///      If decimals == 0 the raw value is used as-is.
///   4. If schema.isArray == true, UI renders an "Add Row" button for
///      dynamic array entries.
///   5. UI encodes the user input via:
///        If isArray: abi.encode(tuple[])
///        Else:       abi.encode(tuple)
///      using the fieldType values to construct the ABI type string.
///   6. Encoded bytes are passed as `vaultData` in NewTaxTokenWithVaultParams.
///
///
/// ── EXAMPLE: Hypothetical StakingVaultFactory (single tuple) ────────────
///
///   function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
///       schema.description = "Creates a staking vault. The creator specifies "
///           "a reward rate and lock duration at launch time.";
///       schema.fields = new FieldDescriptor[](2);
///       schema.fields[0] = FieldDescriptor(
///           "rewardRateBps",                              // name
///           "uint16",                                     // fieldType
///           "Annual reward rate in basis points",         // description
///           0                                             // decimals (raw value)
///       );
///       schema.fields[1] = FieldDescriptor(
///           "lockDuration",                               // name
///           "uint256",                                    // fieldType
///           "Lock duration in seconds",                   // description
///           0                                             // decimals
///       );
///       schema.isArray = false;
///   }
///
///
/// ── EXAMPLE: Hypothetical MultiPayeeFactory (array of tuples) ──────────
///
///   function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
///       schema.description = "Creates a vault that distributes received BNB "
///           "among a dynamic set of payees by basis-point shares.";
///       schema.fields = new FieldDescriptor[](2);
///       schema.fields[0] = FieldDescriptor(
///           "payee",                                      // name
///           "address",                                    // fieldType
///           "Payee wallet address",                       // description
///           0                                             // decimals
///       );
///       schema.fields[1] = FieldDescriptor(
///           "bps",                                        // name
///           "uint16",                                     // fieldType
///           "Basis points share (10000 = 100%)",          // description
///           0                                             // decimals (raw value)
///       );
///       schema.isArray = true;  // vaultData = abi.encode((address,uint16)[])
///   }
///
///
/// ── EXAMPLE: Factory that ignores vaultData ────────────────────────────────
///
///   function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
///       schema.description = "Creates a vault with no configurable parameters. "
///           "No user input is required — vaultData is ignored.";
///       schema.fields = new FieldDescriptor[](0);
///       schema.isArray = false;
///   }
///
abstract contract VaultFactoryBaseV2 is IVaultFactory, IVaultFactoryValidationV2 {
    /// @notice Error thrown when the current chain is not supported by
    ///         `_getGuardian()`.
    error UnsupportedChain(uint256 chainId);

    /// @notice Error thrown when the deprecated legacy V6 validation hook is
    ///         reached without a factory-specific override.
    error LegacyV6ValidationHookNotImplemented();

    /// @notice Returns the schema describing the `vaultData` bytes expected
    ///         by this factory's `newVault()` method.
    ///
    /// @dev Each factory implementation **must** override this to describe the
    ///      fields it expects.
    ///
    ///      The returned `VaultDataSchema` struct contains:
    ///        - `description` – what the vault does and what data is needed
    ///        - `fields`      – ordered `FieldDescriptor[]` for each tuple
    ///                          component
    ///        - `isArray`     – whether `vaultData` is a tuple array
    ///
    ///      If the factory ignores `vaultData`, return an empty schema
    ///      (fields = [], isArray = false).
    ///
    ///      See the `VaultDataSchema` and `FieldDescriptor` docs in
    ///      `IVaultSchemasV1.sol` for the full specification and UI rendering
    ///      algorithm.
    ///
    /// @return schema The vault data schema for this factory.
    function vaultDataSchema() public pure virtual returns (VaultDataSchema memory schema);

    /// @notice Deprecated legacy hook called by VaultPortal immediately before a new V6
    ///         tax token is created via `newTokenV6WithVault`.
    ///
    /// @dev    This hook is no longer allowed by default.
    ///
    ///         Any factory that still intends to use the legacy v2.1 validation surface
    ///         MUST explicitly override this function. The base implementation always
    ///         reverts with `LegacyV6ValidationHookNotImplemented()` so that new factories
    ///         do not accidentally opt into the old path.
    ///
    ///         New factories should prefer the normalized `onBeforeLaunch(bytes)` flow and
    ///         keep `factorySpecVersion()` at the default `"v2.2"`.
    ///
    ///         Override this function only when a factory intentionally stays on the legacy
    ///         V6-only validation path.
    ///
    ///         ── RETURN VALUE CONTRACT ──────────────────────────────────────────────
    ///
    ///         The caller (VaultPortal) MUST invoke this hook via a low-level call so
    ///         it can distinguish between the three possible outcomes:
    ///
    ///           1. **Hook selector missing entirely** — the low-level call reverts with
    ///              empty returndata (no selector match on the target contract).
    ///              VaultPortal may treat this as absence of legacy support.
    ///
    ///           2. **Hook implemented, validation passed** — returns `(true, "")`.
    ///              VaultPortal continues with token creation.
    ///
    ///           3. **Hook implemented, validation failed** — returns `(false, reason)`
    ///              where `reason` is a human-readable explanation.
    ///              VaultPortal MUST revert, surfacing `reason` to the caller.
    ///
    ///         Pseudo-code for the caller:
    ///
    ///           ```
    ///           (bool callOk, bytes memory ret) = factory.call(
    ///               abi.encodeCall(IVaultFactoryBaseV2.onBeforeNewTokenV6WithVault, (params))
    ///           );
    ///           if (callOk) {
    ///               (bool passed, string memory reason) = abi.decode(ret, (bool, string));
    ///               if (!passed) revert HookRejected(reason);
    ///           } else if (ret.length > 0) {
    ///               // Unexpected revert with error data — bubble it up.
    ///               assembly { revert(add(ret, 32), mload(ret)) }
    ///           }
    ///           // ret.length == 0: selector missing on target contract.
    ///           ```
    ///
    ///         Example use-cases for overrides:
    ///           - Reject unsupported quote tokens
    ///           - Enforce minimum/maximum tax rates
    ///           - Restrict allowed migrator types
    ///           - Require a specific Dividend bps
    ///
    /// @param params The full set of token creation parameters passed to
    ///               `VaultPortal.newTokenV6WithVault`.
    /// @return success True if the params pass all factory-specific constraints.
    /// @return reason  Human-readable explanation if `success` is false; empty otherwise.
    function onBeforeNewTokenV6WithVault(IVaultPortalTypes.NewTokenV6WithVaultParams calldata params)
        external
        virtual
        returns (bool, string memory)
    {
        params = params;
        revert LegacyV6ValidationHookNotImplemented();
    }

    /// @notice Optional wrapper-agnostic pre-launch validation hook introduced in spec v2.2.
    /// @dev    The default implementation decodes the normalized payload and forwards it to
    ///         `_validateBeforeLaunch(...)`. Legacy factories that must stay on the older V6
    ///         hook path should override `factorySpecVersion()` and return `"v2.1"`.
    function onBeforeLaunch(bytes calldata validationData)
        external
        view
        virtual
        override
        returns (bool success, string memory reason)
    {
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory data =
            abi.decode(validationData, (IVaultFactoryValidationV2.LaunchValidationDataV1));
        return _validateBeforeLaunch(data);
    }

    /// @notice Internal validation hook for spec-v2.2+ factories.
    /// @dev    Concrete factories can override this when they want the generic `onBeforeLaunch(...)`
    ///         path. The default implementation is a no-op so older factories remain source-compatible.
    function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
        internal
        view
        virtual
        returns (bool success, string memory reason)
    {
        data = data;
        return (true, "");
    }

    /// @notice Returns the version of the VaultFactoryBaseV2 specification that
    ///         this contract conforms to.
    ///
    /// @dev    The default return value is `"v2.2"`, meaning new factories that inherit this
    ///         base opt into the normalized `onBeforeLaunch(...)` validation generation by default.
    ///         Legacy factories that must keep the older V6 hook semantics should override this
    ///         and return `"v2.1"`.
    ///
    ///         The UI SHOULD call this via a low-level `staticcall` before
    ///         calling `tokenCreationPolicies()`.  A revert (or the absence of
    ///         this selector) indicates a pre-v2.1 factory that does not
    ///         support policy discovery.
    ///
    /// @return The spec version string, defaulting to "v2.2".
    function factorySpecVersion() public pure virtual returns (string memory) {
        return "v2.2";
    }

    /// @notice Returns the list of constraints this factory enforces on
    ///         token-creation parameters passed to `newTokenV6WithVault`.
    ///
    /// @dev    The policies returned here are **informational only** — they are
    ///         intended for UI rendering (inline validation hints, error
    ///         messages). The actual enforcement happens in whichever validation
    ///         hook the factory uses: `onBeforeLaunch(bytes)` for spec-v2.2+
    ///         factories, or `onBeforeNewTokenV6WithVault(...)` for explicitly
    ///         legacy v2.1 factories.
    ///
    ///         The default implementation returns an empty array, meaning the
    ///         factory declares no machine-readable constraints.  Factories that
    ///         override either validation hook SHOULD also override this method
    ///         to describe their constraints in policy form.
    ///
    ///         Policies are ordered from most to least important; the UI MAY
    ///         display them in this order.
    ///
    ///         See `FactoryPolicy` in `IVaultSchemasV1.sol` for the full struct
    ///         specification, supported operators, and encoding rules.
    ///
    /// @return policies  An array of FactoryPolicy structs describing the
    ///                   constraints.
    function tokenCreationPolicies() public pure virtual returns (FactoryPolicy[] memory policies) {
        return new FactoryPolicy[](0);
    }

    /// @notice Get the VaultPortal address for the current chain.
    ///
    /// @dev Returns the canonical VaultPortal proxy address for the chain
    ///      this contract is deployed on.
    ///
    ///      Currently supports:
    ///        - BNB Chain   (chain ID 56)  → 0x90497450f2a706f1951b5bdda52B4E5d16f34C06
    ///        - BNB Testnet (chain ID 97)  → 0x027e3704fC5C16522e9393d04C60A3ac5c0d775f
    ///
    ///      Reverts with `UnsupportedChain` if called on an unknown chain.
    ///
    /// @return vaultPortal The VaultPortal contract address for the current chain.
    function _getVaultPortal() internal view returns (address vaultPortal) {
        uint256 chainId = block.chainid;
        if (chainId == 56) {
            // BNB Chain VaultPortal address
            return 0x90497450f2a706f1951b5bdda52B4E5d16f34C06;
        } else if (chainId == 97) {
            // BNB Testnet VaultPortal address
            return 0x027e3704fC5C16522e9393d04C60A3ac5c0d775f;
        } else if (chainId == 4663 || chainId == 46630) {
            // Robinhood Chain — VaultPortal address
            return 0xe9F7AB7DE8FB8756acbB6a1cd13316a43308197B;
        }
        revert UnsupportedChain(chainId);
    }

    /// @notice Get the Guardian address for the current chain.
    ///
    /// @dev Mirrors the `_getGuardian()` helper in `VaultBase`.  The Guardian
    ///      is a privileged address that can always call permissioned functions
    ///      as a backup mechanism.
    ///
    ///      Currently supports:
    ///        - BNB Chain   (chain ID 56)  → 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b
    ///        - BNB Testnet (chain ID 97)  → 0x76Fa8C526f8Bc27ba6958B76DeEf92a0dbE46950
    ///
    ///      Reverts with `UnsupportedChain` if called on an unknown chain.
    ///
    /// @return guardian The Guardian contract address for the current chain.
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
}
