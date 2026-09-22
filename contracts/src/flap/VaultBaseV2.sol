// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

import {VaultBase} from "./VaultBase.sol";
import {VaultUISchema} from "./IVaultSchemasV1.sol";

/// @title VaultBaseV2
/// @author The Flap Team
/// @notice Extended abstract base contract for vault implementations that adds
///         on-chain UI schema discovery via `vaultUISchema()`.
///
/// @dev  ── MOTIVATION ───────────────────────────────────────────────────────
///
/// The protocol is designed so that anyone can introduce new vault types.
/// Each vault implementation exposes a different set of user-facing view
/// and write methods — a generic UI rendering a vault page has no way to
/// know which methods to display, what each parameter means, or how to
/// format the results without inspecting each vault's source code.
///
/// Existing vault types (FlapXVault, SplitVault, SnowBallVault,
/// BlackHoleVault) already have purpose-built UIs.  `VaultBaseV2` exists
/// to support **future** vault implementations: by requiring every new
/// vault to override `vaultUISchema()`, the UI can automatically generate
/// a full interaction page for any vault type — even ones that did not
/// exist when the UI was built.
///
/// `vaultUISchema()` returns a `VaultUISchema` struct (defined in
/// `IVaultSchemasV1.sol`) that fully describes the methods the UI should
/// render.
///
///
/// ── BACKWARDS COMPATIBILITY ────────────────────────────────────────────────
///
/// `VaultBaseV2` inherits from the original `VaultBase` contract and adds only
/// the new `vaultUISchema()` abstract method.  Existing vaults that extend
/// `VaultBase` are unaffected.  New or upgraded vault implementations should
/// extend `VaultBaseV2` instead of `VaultBase` to gain UI schema support.
///
///
/// ── HOW TO IMPLEMENT ───────────────────────────────────────────────────────
///
/// 1. **Inherit from VaultBaseV2** instead of VaultBase.
///    All obligations from VaultBase still apply (implement `description()`,
///    use `_getPortal()`, `_getGuardian()`, handle `receive()`, etc.).
///
/// 2. **Override `vaultUISchema()`** to return a `VaultUISchema` describing
///    every user-facing method your vault exposes.
///
///    For each method include:
///      - `name`          – the Solidity function name (e.g. "claim")
///      - `description`   – human-readable explanation
///      - `inputs`        – ordered FieldDescriptor[] for parameters
///      - `outputs`       – ordered FieldDescriptor[] for return values
///      - `approvals`     – ApproveAction[] for any ERC-20 approvals required
///                          before calling a write method
///      - `isInputArray`  – true if input is tuple[]
///      - `isOutputArray` – true if output is tuple[]
///      - `isWriteMethod` – true for state-changing, false for view
///
/// 3. **MANDATE: Guardian access to privileged functions**
///    If your vault exposes any privileged / role-gated functions (e.g.
///    functions that should only be called by an operator or admin), the
///    Guardian address returned by `_getGuardian()` **must** also be
///    granted the required role(s).  Furthermore, the Guardian's role
///    **must not** be revocable by any other account — only the Guardian
///    itself may renounce its own access.
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
///    (This mandate is inherited from VaultBase — see its documentation
///    for the canonical requirement.)
///
///
/// ── EXAMPLE: Hypothetical DonationVault (view + write, no approvals) ───
///
///   function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
///       schema.vaultType = "DonationVault";
///       schema.description = "Collects BNB donations and lets a designated charity withdraw.";
///       schema.methods = new VaultMethodSchema[](2);
///
///       // View: totalDonated()
///       schema.methods[0].name = "totalDonated";
///       schema.methods[0].description = "Returns the total BNB donated so far.";
///       schema.methods[0].outputs = new FieldDescriptor[](1);
///       schema.methods[0].outputs[0] = FieldDescriptor("total", "uint256", "Total BNB donated", 18);
///
///       // Write: withdraw()
///       schema.methods[1].name = "withdraw";
///       schema.methods[1].description = "Withdraws accumulated donations to the charity address. Only the charity can call.";
///       schema.methods[1].approvals = new ApproveAction[](0);
///       schema.methods[1].isWriteMethod = true;
///   }
///
///
/// ── EXAMPLE: Hypothetical StakingVault (illustrating approve actions) ──────
///
///   function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
///       schema.vaultType = "StakingVault";
///       schema.description = "Stakes tax tokens or LP tokens to earn rewards.";
///       schema.methods = new VaultMethodSchema[](3);
///
///       // View: stakedBalance(address)
///       schema.methods[0].name = "stakedBalance";
///       schema.methods[0].description = "Returns the staked balance for a given user.";
///       schema.methods[0].inputs = new FieldDescriptor[](1);
///       schema.methods[0].inputs[0] = FieldDescriptor("user", "address", "The user address to query", 0);
///       schema.methods[0].outputs = new FieldDescriptor[](1);
///       schema.methods[0].outputs[0] = FieldDescriptor("balance", "uint256", "Staked token balance", 18);
///
///       // Write: deposit(uint256) — requires ERC-20 approval of the tax token
///       schema.methods[1].name = "deposit";
///       schema.methods[1].description = "Stake tax tokens into the vault to earn rewards.";
///       schema.methods[1].inputs = new FieldDescriptor[](1);
///       schema.methods[1].inputs[0] = FieldDescriptor("amount", "uint256", "Amount of tax tokens to stake", 18);
///       schema.methods[1].approvals = new ApproveAction[](1);
///       // The UI will:
///       //   (1) call vault.taxToken() to get the token address
///       //   (2) call token.approve(vault, amount) where amount comes from the "amount" input field
///       schema.methods[1].approvals[0] = ApproveAction("taxToken", "amount");
///       schema.methods[1].isWriteMethod = true;
///
///       // Write: depositLP(uint256) — requires ERC-20 approval of the LP token
///       schema.methods[2].name = "depositLP";
///       schema.methods[2].description = "Stake LP tokens into the vault to earn boosted rewards.";
///       schema.methods[2].inputs = new FieldDescriptor[](1);
///       schema.methods[2].inputs[0] = FieldDescriptor("amount", "uint256", "Amount of LP tokens to stake", 18);
///       schema.methods[2].approvals = new ApproveAction[](1);
///       schema.methods[2].approvals[0] = ApproveAction("lpToken", "amount");
///       schema.methods[2].isWriteMethod = true;
///   }
///
///
/// ── EXAMPLE: Vault with no user-facing methods ─────────────────────────────
///
///   function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
///       schema.vaultType = "SinkVault";
///       schema.description = "A vault that permanently locks all received BNB. No methods available.";
///       schema.methods = new VaultMethodSchema[](0);
///   }
///
abstract contract VaultBaseV2 is VaultBase {
    /// @notice Returns the UI schema describing which methods the UI should
    ///         render for this vault.
    ///
    /// @dev Each vault implementation **must** override this to describe its
    ///      own user-facing methods.
    ///
    ///      The returned `VaultUISchema` struct contains:
    ///        - `vaultType`   – e.g. "FlapXVault", "SplitVault"
    ///        - `description` – overall explanation of the vault
    ///        - `methods`     – ordered array of `VaultMethodSchema`, each
    ///                          describing one view or write method with its
    ///                          inputs, outputs, required approvals, and
    ///                          array flags.
    ///
    ///      The UI renders methods in the order they appear in the array.
    ///      See the VaultMethodSchema and VaultUISchema docs in
    ///      IVaultSchemasV1.sol for the full rendering algorithm.
    ///
    /// @return schema The complete UI schema for this vault.
    function vaultUISchema() public pure virtual returns (VaultUISchema memory schema);
}
