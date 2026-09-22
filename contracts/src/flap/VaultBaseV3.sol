// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

import {VaultBaseV2} from "./VaultBaseV2.sol";

/// @title VaultBaseV3
/// @author The Flap Team
/// @notice Extended abstract base contract for vault implementations that adds
///         support for ERC20 quote tokens (stablecoins, tokenized equities / RWA)
///         as the vault's revenue currency, via `vaultQuoteToken()` discovery and
///         a normative balance-delta accounting model.
///
/// @dev  ── MOTIVATION ───────────────────────────────────────────────────────
///
/// Every pre-V3 vault is driven by its `receive()` function: when the token's
/// TaxProcessor dispatches tax revenue in the native gas token (BNB / ETH),
/// the value transfer itself invokes `receive()` and the vault's logic runs.
///
/// ERC20 revenue breaks that assumption. An ERC20 `transfer` executes the
/// token contract's code, NOT the recipient's — the vault receives the funds
/// but is never invoked. No `receive()`, no `fallback()`, nothing. This is the
/// single reason vault-enabled launches were historically restricted to native
/// quote tokens.
///
/// V3 closes the gap with two coordinated mechanisms:
///
///   1. **The wake call ("ping"), sent by the protocol.** After every ERC20
///      quote payout, the TaxProcessor calls the recipient wallet with empty
///      calldata and zero value — `wallet.call{value: 0}("")` —
///      which invokes the vault's `receive()` exactly like a native transfer
///      would. The vault gets execution; the funds are already there.
///
///   2. **Balance-delta accounting, implemented by the vault (YOU).** Because
///      the wake call carries no value, `msg.value` is useless for ERC20
///      revenue. The vault must instead compare its current quote balance
///      against a stored baseline to recognize new revenue. The normative
///      model is specified below.
///
///
/// ── BACKWARDS COMPATIBILITY ────────────────────────────────────────────────
///
/// `VaultBaseV3` inherits from `VaultBaseV2` and adds only the new
/// `vaultQuoteToken()` abstract method and the `vaultSpecVersion()` marker.
/// Existing vaults that extend `VaultBase` or `VaultBaseV2` are unaffected —
/// they remain native-only and keep working unchanged. New or upgraded vault
/// implementations should extend `VaultBaseV3` instead of `VaultBaseV2` to
/// gain ERC20 quote support; native-only vaults may also adopt V3 (declare
/// `address(0)`) to benefit from the explicit currency declaration.
///
///
/// ── THE PING CONTRACT (what the protocol guarantees) ──────────────────────
///
/// The TaxProcessor's dispatch upholds four invariants; design your vault
/// against them:
///
///   1. **Transfer first, ping after.** When your `receive()` runs, the
///      revenue is already in your balance.
///   2. **Ping failures are ignored.** If your `receive()` reverts, dispatch
///      proceeds without you — the funds still arrive, but your logic did not
///      run and you will only recognize the revenue on the next wake. Do not
///      rely on reverting to refuse revenue.
///   3. **Ping gas is the dispatcher's, not yours.** The protocol does not
///      cap the wake call — it forwards the dispatch caller's remaining gas
///      (EIP-150), and dispatch is permissionless. The protocol's keeper runs
///      the ENTIRE dispatch (swaps, dividends, burn, up to four wallet
///      payouts) under one fixed gas budget; a heavy `receive()` makes the
///      keeper's dispatch of your token fail until someone re-dispatches with
///      a higher gas limit. Keep `receive()` lightweight: update accounting,
///      emit an event, return. Put heavy work — swaps, staking, buybacks —
///      behind explicit public functions driven by your own automation or the
///      protocol's keeper/trigger services.
///   4. **You may be pinged spuriously.** The same wallet can occupy several
///      payout slots and be pinged more than once per dispatch, and anyone
///      can call your `receive()` at any time. A wake that finds no new
///      revenue MUST be a silent no-op (see accounting model, rule 2).
///
/// Native revenue is unchanged: it still arrives as a plain value transfer
/// invoking `receive()`. A V3 vault handles both currencies with the same
/// code path — the accounting model below is currency-agnostic.
///
///
/// ── NORMATIVE ACCOUNTING MODEL (what YOUR vault must implement) ───────────
///
/// Maintain a baseline of already-recognized revenue, e.g.:
///
///   ```solidity
///   uint256 public accountedQuote; // recognized-and-not-yet-spent revenue
///
///   receive() external payable { _syncRevenue(); }
///
///   function _syncRevenue() internal {
///       address quoteToken = vaultQuoteToken();
///       uint256 bal = quoteToken == address(0)
///           ? address(this).balance
///           : IERC20(quoteToken).balanceOf(address(this));
///       if (bal <= accountedQuote) return;            // rule 2: idempotent no-op
///       uint256 newRevenue = bal - accountedQuote;
///       accountedQuote = bal;                          // rule 1: advance baseline
///       _onRevenue(newRevenue);                        // lightweight only (ping law 3)
///   }
///   ```
///
/// Rules:
///
///   1. **Recognize by delta, never by raw balance.** Crediting
///      `balanceOf(this)` as "new revenue" double-counts everything already
///      recognized. Only `balance - accountedQuote` is new.
///   2. **Zero-delta wakes are silent no-ops.** Required by ping law 4.
///   3. **Every outflow MUST decrement `accountedQuote`** by the amount
///      spent, in the same transaction. Forgetting this leaves the baseline
///      above the real balance, and `bal <= accountedQuote` then suppresses
///      revenue recognition forever — the vault deadlocks. This is the
///      single most dangerous mistake a V3 vault can make.
///   4. **Direct transfers are credited late, and that is fine.** Funds sent
///      to the vault outside dispatch (donations, airdrops, misdirected
///      transfers) trigger no ping; they are recognized on the next wake and
///      are indistinguishable from revenue. Treat them as donations. If your
///      vault's economics require exact per-payout amounts, do not infer them
///      from deltas — wait for a typed-callback spec revision (see FUTURE
///      EXTENSIONS).
///   5. **Recognize before you act.** Any function whose behavior depends on
///      available revenue — spending it, paying it out, or gating on it —
///      MUST run the sync routine first, so its outcome never depends on
///      whether a ping happened to arrive beforehand. This applies to every
///      custom function you add to your vault. Exposing a permissionless
///      `sync()` wrapper is RECOMMENDED: it is the neutral, side-effect-free
///      recognition entry for keepers and UIs, and the recovery path when
///      revenue arrives without a wake call (direct transfers, or pings
///      administratively disabled on the processor).
///
///
/// ── HOW TO IMPLEMENT ──────────────────────────────────────────────────────
///
/// 1. **Inherit from VaultBaseV3.** All obligations from VaultBase and
///    VaultBaseV2 still apply (implement `description()` and
///    `vaultUISchema()`, use `_getPortal()` / `_getGuardian()`, honor the
///    Guardian mandate).
///
/// 2. **Override `vaultQuoteToken()`** to return the revenue currency this
///    vault instance accounts for — `address(0)` for the native gas token,
///    the ERC20 address otherwise. It MUST equal the quote token of the tax
///    token this vault serves, MUST be immutable for the life of the vault
///    (set it once at initialization from the factory's `newVault`
///    parameters), and MUST NOT revert. VaultPortal cross-checks it at
///    launch; lenses and UIs read it to label the vault and to warn when a
///    vault is wired to a token with a different quote.
///
/// 3. **Implement `receive()` with the accounting model above.** Present even
///    if your quote is an ERC20 — the wake call lands there.
///
/// 4. **Keep `vaultSpecVersion()` at the default** unless a later spec
///    revision instructs otherwise.
///
/// 5. **Factory-side requirements** (see VaultFactoryBaseV2):
///      - `isQuoteTokenSupported(quote)` MUST answer truthfully for your
///        vault implementation. This is enforced on-chain at launch: the
///        VaultPortal rejects any launch whose quote your factory does not
///        support. Misdeclaring support strands your users' tax revenue in a
///        vault that ignores it.
///      - `factorySpecVersion()` MUST return "v2.3" (or higher) so the
///        VaultPortal applies the V3 validation flow.
///      - `newVault(taxToken, quoteToken, creator, vaultData)` receives the
///        launch quote token — pass it into your vault's initializer.
///      - Creation-time first buys in an ERC20 quote are funded by the
///        launcher, not the vault: the VaultPortal pulls `quoteAmt` from the
///        launching user (via an EIP-2612 permit signed with the VaultPortal
///        as spender, or a prior approval) and refunds any partial fill.
///        Frontends integrating your factory should request that approval or
///        permit; the vault itself plays no part in launch funding.
///
///
/// ── FUTURE EXTENSIONS (non-normative) ─────────────────────────────────────
///
/// A later spec revision may add a typed revenue callback in the spirit of
/// ERC721's `onERC721Received`:
///
///   ```solidity
///   interface IFlapRevenueReceiver {
///       function onFlapRevenue(address quoteToken, uint256 amount) external;
///   }
///   ```
///
/// Dispatch would prefer the typed callback (exact amounts, no delta
/// ambiguity) and fall back to the zero-value ping. The balance-delta
/// baseline remains the source of truth regardless — transfers can always
/// arrive without a callback — so vaults written against this spec stay
/// correct unchanged.
///
abstract contract VaultBaseV3 is VaultBaseV2 {
    /// @notice The revenue currency this vault accounts for.
    /// @dev MUST equal the quote token of the tax token this vault serves:
    ///      `address(0)` for the native gas token, the ERC20 address
    ///      otherwise. MUST be stable for the life of the vault and MUST NOT
    ///      revert. Consumed by the VaultPortal launch cross-check and by
    ///      lens/UI discovery.
    /// @return quoteToken The revenue currency (`address(0)` = native).
    function vaultQuoteToken() public view virtual returns (address quoteToken);

    /// @notice The vault-side spec revision this implementation conforms to.
    /// @dev Distinct from the factory-side `factorySpecVersion()` ("v2.x"
    ///      series): this string versions the VAULT contract surface.
    ///      Lenses read it to distinguish V3 vaults from legacy ones (which
    ///      implement neither this method nor `vaultQuoteToken()`).
    /// @return The spec version string, "v3" for this revision.
    function vaultSpecVersion() public pure virtual returns (string memory) {
        return "v3";
    }
}
