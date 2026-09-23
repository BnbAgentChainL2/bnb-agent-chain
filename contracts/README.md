# BNB Agent Chain — contracts

Solidity sources for **BNB Agent Chain** (token *BNB Agent Chain* / `BAC`), v2 architecture
(decisions #29–#35, 2026-09-23).

`../docs/decisions.md` is the authority: later rows override earlier ones, and it overrides every
other document, this README included. The specs (`../docs/00-DESIGN-SPEC.md`,
`01-CONTRACT-SPEC.md`, `02-CHAIN-SPEC.md`, `03-INTERFACES.md`) still describe parts of the v1
design (vault factory, `AgentRegistry`, the per-owed accumulator); where they disagree with
`decisions.md` or with the code, they are the ones that are out of date.

**Nothing here is deployed.** The only mainnet action so far is `Portal.lockSalt` (decision #35).

---

## 1. What each contract is

### 1.1 The one thing to know first: the owner can take everything

Decision #29 made the bridge upgradeable and gave its owner an emergency withdrawal, with no
timelock. The sentence the chain, the site and every X post must carry word for word (#29a):

> 项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。

It is `BacBridge.OWNER_POWER_NOTICE`, and `BacBridge.description()` returns it verbatim. The owner
is the deployer hot wallet `0x934a…2844` (decision #33). Two consequences that go beyond that
sentence and are disclosed separately:

* **Standing allowances.** Whatever code the owner puts behind the proxy can also spend every BAC
  allowance a user has left on the bridge address, BAC that never entered the pool included.
  `description()` and `lock`'s NatSpec say: approve exactly the amount, right before `lock`, and
  reset the allowance if `lock` fails. (The SDK does not do this yet — `docs/04` §0-i.)
* `pause()`, the watchdog, the halt / escape path and the two-bucket books are all still
  implemented, but none of them is a backstop above the owner (decision #29b).

These statements are **false** and must not appear anywhere: 「桥池只用于 agent 退出兑付，项目方和
Flap Guardian 都动不了」「进桥的 BAC 永久锁死」「不可升级」「owner 没有任何路径能移动桥池资金」.

### 1.2 BSC side — tax in, bridge, node fund

| Contract | File | Role |
|---|---|---|
| `BacTaxRouter` | `src/BacTaxRouter.sol` | The Flap `beneficiary` of the plain-Portal launch (decision #30, `newTokenV6`). `receive()` only books the BNB (one SSTORE, must succeed under `call{gas: 50_000}`); permissionless `settle()` pushes 50/50 to `BacBridge.acceptRelease()` and `BacNodeFund.acceptRelease()`, each with `PUSH_GAS = 100_000`. Failed pushes are booked in `stuckBridge` / `stuckNodeFund` and `retryPush()` delivers them. **No owner, no upgrade, no setter, and no `description()`** (decision #32: this contract is immutable, so it freezes no text). Its constructor refuses a bridge / node fund bound to another token, which also rejects the bare bridge implementation. |
| `BacBridge` | `src/BacBridge.sol` | Behind an OpenZeppelin `ERC1967Proxy` (UUPS). **Always use the proxy address.** Entry `lock(agentId, amount)` is gated on holding an ERC-8004 identity (decision #31) on `0x8004A169…a432`; the first depositor of an id becomes its `agentController`, and only that controller may lock more under the id (hand-over via `setAgentController`). Exits: `claimExit` (Merkle proof against a FINAL `ChainAnchor` anchor, rate locked at claim time), `settleEpoch` (sequential, daily release rate / 144), `collect` (paid in bought-back BAC). `buyback()` spends a bounded slice of the BNB bucket on the Flap curve or PancakeSwap V2. Owner: `upgradeTo` / `upgradeToAndCall`, `emergencyWithdrawBnb`, `emergencyWithdrawToken` — all logged (`BridgeUpgraded`, `EmergencyWithdraw`), the books are never written down, `shortfall()` shows the hole. `renounceOwnership` is disabled. |
| `BacBridgeExtension` | `src/BacBridge.sol` | Not deployed by hand: the `BacBridge` implementation's constructor deploys it (`EXTENSION()`), and the bridge reaches it by DELEGATECALL for `settleEpoch`, the owner withdrawals, `setAgentController`, the watchdog tools (`pause`, `unpause`, `revokeEpochOwed`, `armEscape`, `cancelEscapeArm`) and the halt / escape path (`checkHalt`, `claimOwedAfterHalt`, `sweepImmatureOwed`, `escapeCollect`). It exists only because one contract would exceed EIP-170. It refuses direct calls and refuses to be an upgrade target. |
| `BacNodeFund` | `src/BacNodeFund.sol` | The official node fund. Permissionless `acceptRelease()` in, two-step-ownable `withdraw` out: its owner can withdraw this half at any time (decision #10). |

How the bridge's money works, in one paragraph: BAC locked on entry sits in `lockedBac`, which no
exit path reads; exits are paid only from `buybackBac`, the BAC bought back with the bridge's tax
BNB, and every exit payout checks that what stays behind still covers the unburned deposits.
An exit locks `credits * (buybackBac - owedTotal) / outstanding` BAC at claim time; each settled
epoch releases a pot of `(buybackBac - reservedTotal) * dailyBps / (10000 * 144)`, capped at the
owed no pot has reached yet, as the same fraction of every address's unreleased owed (the
`ReleasePoint` index). `collect` is limited to 10% of the release rate's per-epoch amount per
elapsed epoch (up to 144). Taking BAC out costs roughly 4% more than BNB would (decision #24b).

### 1.3 BSC side — the anchor and its witnesses

| Contract | File | Role |
|---|---|---|
| `ChainAnchor` | `src/ChainAnchor.sol` | One anchor per 10-minute epoch from the relayer; FINAL after the 120-second wait (decision #25), or VETOED / DISPUTED. `releaseBpsFor(epoch)` returns 200 / 350 / 500 bps **per day** by independent witness count; `haltReason()` is what the bridge polls. Check #7 (`cumulativeCredited + creditedInEpoch <= bridge.totalCreditsIssued()`) is only as strong as the bridge owner key, since the owner can upgrade the bridge. |
| `ValidatorStaking` | `src/ValidatorStaking.sol` | BAC staking, node registration and the daily commit-reveal attestation `ChainAnchor` pulls. |

### 1.4 Layer side (chain id 56777, genesis-predeployed)

| Contract | File | Role |
|---|---|---|
| `L2Bridge` | `src/layer/L2Bridge.sol` | Credits layer BAC from a BSC `Locked` event; burns it on exit into the leaf `BacBridge.claimExit` verifies. `EPOCH = 600`, matching `ChainAnchor`. `BSC_BRIDGE` must be the proxy address. |
| `L2Gate` | `src/layer/L2Gate.sol` | Wallet → agent-id admission. Its old feed (`AgentRegistry`) was deleted by #31 and its code is not yet changed to match; how it should be fed from `BacBridge.Locked` is an open decision that has to be settled before genesis (see the contract header). |
| `AgentBook` | `src/layer/AgentBook.sol` | The canonical `Action` event, per-window publish cap. |
| `WBAC` | `src/layer/WBAC.sol` | `Wrapped BAC` / `WBAC`, WETH9-shaped (decisions #22 / #26). |

### 1.5 Interfaces and helpers

`src/interfaces/`: `IBacBridge`, `IBacNodeFund`, `IChainAnchor`, `IValidatorStaking`,
`IERC8004Identity`, `IPancakeV2Router`, `IL2Bridge`, `IL2Gate`. `IBacBridge` is shared:
`ChainAnchor` reads `totalCreditsIssued()`, `BacTaxRouter` reads `bacToken()` and pushes to
`acceptRelease()` by raw selector — every bridge upgrade must keep those signatures, and keep
`acceptRelease()` under the router's `PUSH_GAS`.

`src/lib/Erc8004Gate.sol` is the never-reverting ERC-8004 holder check (owner or the
signature-proven `agentWallet`).

### 1.6 Frozen, do not edit

`src/flap/*.sol` are Flap's own sources, byte-identical to upstream. `test/lib/VanityHelper.sol`
is the vanity-salt helper of the fork fixture. Neither is ever formatted (see §4).

---

## 2. Build

Pinned in `foundry.toml` — **do not change it**: solc 0.8.26, `evm_version = "cancun"`, optimizer
200 runs, `via_ir = true`. Dependencies in `lib/`: OpenZeppelin 4.9.6 (`@openzeppelin/`),
OpenZeppelin-upgradeable 4.9.6 (`@openzeppelin-contracts-upgradeable/`), forge-std.

```bash
cd contracts
forge build
forge build --sizes      # runtime / initcode size table
```

`via_ir` is required: without it `BacBridge` is 25,399 bytes, over EIP-170.

---

## 3. Test

```bash
forge test --no-match-path 'test/{BacForkLaunch.t.sol,smoke/*}'        # everything but the forks: 324 tests
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org forge test --match-path 'test/smoke/*'           # 5
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org forge test --match-path 'test/BacForkLaunch.t.sol' -vv   # 9
```

`--no-match-path` may be given only once, hence the `{…,…}` glob. A bare `forge test` also runs
the fork suites (they fall back to a public RPC when `BSC_RPC_URL` is unset).

| Suite | File | Tests | Covers |
|---|---|---:|---|
| `BacBridge` + `BacNodeFund` | `test/BacBridge.t.sol` | 138 | entry gate and controller rule, the two buckets, buyback, exit / settle / collect, the release index and collect cap, revoke, pause / halt / escape (legs settled separately), UUPS upgrade and storage layout, ownership, emergency withdrawals and `shortfall()`, `description()`, node fund |
| Bridge invariants | `test/BacBridgeInvariant.t.sol` | 31 | B1–B17 with the owner idle, plus a second suite with the owner withdrawing, refilling and upgrading |
| `BacTaxRouter` | `test/BacTaxRouter.t.sol` | 23 | `receive()` gas, split, stuck / retry, constructor cross-checks, proxy wiring, no `description()` |
| `ChainAnchor` | `test/ChainAnchor.t.sol` | 40 | post / finalize / veto / dispute, check table, `releaseBpsFor` |
| `ValidatorStaking` | `test/ValidatorStaking.t.sol` | 38 | staking, commit-reveal, rewards |
| Layer | `test/Layer.t.sol` | 35 | `L2Bridge`, `L2Gate`, `AgentBook` |
| `WBAC` | `test/WBAC.t.sol` | 19 | wrap / unwrap / ERC-20 |
| Fork launch | `test/BacForkLaunch.t.sol` | 9 | the whole plain-Portal path on a BSC mainnet fork: deploy order, launch with the locked salt, real tax → router → split, real ERC-8004 entry, anchor, buyback, exit, upgrade, emergency withdrawal, graduation |
| Fork smoke | `test/smoke/ForkSmoke.t.sol` | 5 | Portal version, ERC-8004 registry implementation, PancakeSwap, WBNB |

Conventions: test code reads `vm.getBlockTimestamp()`, never `block.timestamp` (via-IR caches it
inside a test function); fund contracts with `call{value:}("")`.

**Nothing here broadcasts.** `script/DeployBac.s.sol` only simulates unless both `--broadcast`
and `BAC_BROADCAST=I_HAVE_READ_SECTION_9` are given.

---

## 4. Format

```bash
forge fmt test/BacBridge.t.sol test/BacBridgeInvariant.t.sol   # only files that were fmt-clean before
```

Always name the files. A bare `forge fmt` rewrites `src/flap/*.sol`, which must stay
byte-identical to upstream.

---

## 5. Size table

EIP-170 runtime limit 24,576 bytes. `forge build --sizes`, 2026-09-23.

| Contract | Runtime (B) | Margin (B) |
|---|---:|---:|
| `BacBridge` (implementation) | 22,350 | 2,226 |
| `BacBridgeExtension` | 19,486 | 5,090 |
| `ValidatorStaking` | 16,925 | 7,651 |
| `ChainAnchor` | 8,871 | 15,705 |
| `L2Bridge` | 4,823 | 19,753 |
| `AgentBook` | 2,972 | 21,604 |
| `BacTaxRouter` | 2,867 | 21,709 |
| `WBAC` | 1,807 | 22,769 |
| `L2Gate` | 1,695 | 22,881 |
| `BacNodeFund` | 1,651 | 22,925 |

**`BacBridge` is the one to watch.** Every future bridge upgrade has to re-check both bridge
numbers; new rarely-called code belongs in the extension.

---

## 6. Rules this code is held to

* **No custom errors in our contracts.** Every `require` carries `unicode"English / 中文"`.
  `grep -rn '^\s*error ' src --include='*.sol' | grep -v '/flap/'` must stay empty.
* **The owner powers are disclosed, logged and counted, never hidden.** Every upgrade emits
  `BridgeUpgraded` with the replaced implementation and the books; every withdrawal emits
  `EmergencyWithdraw` and adds to `emergencyBnbWithdrawn` / `emergencyBacWithdrawn`; the books
  are never written down, so `shortfall()` is exact (decision #29c).
* **No NON-owner path pays an exit out of `lockedBac`** — proved by both invariant suites.
* **Storage is append-only.** One layout, in `BacBridgeCore`, shared by the bridge and its
  extension; a new version adds variables just above `__gap` and shrinks it. The layout is
  pinned by `BacBridgeUpgradeTest`.
* **No exit path reads the ERC-8004 registry.** Entry is gated on identity; the escape is gated on
  `agentController`, recorded at entry.

---

## 7. Deployment

`script/DeployBac.s.sol` (dry run by default) deploys, in 7 transactions: `ChainAnchor`,
`ValidatorStaking`, `BacNodeFund`, the `BacBridge` implementation (its constructor creates the
extension), the `ERC1967Proxy` with `initialize`, `setValidatorStaking`, `BacTaxRouter`. It then
checks the proxy's implementation slot, owner, the #29a notice, the extension, every
`bacToken()`, that the bare implementation holds no state, and that the router has no
`description()`. The launch runbook itself is kept out of this repository. BscScan verification:
`verify/bscscan/README.md` (the JSON there must be regenerated from the final build).
