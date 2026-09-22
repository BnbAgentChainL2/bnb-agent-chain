# BNB Agent Chain — contracts

Solidity sources for **BNB Agent Chain** (token *BNB Agent Chain* / `BAC`).

Everything here implements `../docs/01-CONTRACT-SPEC.md` verbatim. That document, together
with `../docs/00-DESIGN-SPEC.md` (trust model, money flow, §11 economy constants),
`../docs/02-CHAIN-SPEC.md` (layer chain) and `../docs/03-INTERFACES.md` (relayer / indexer /
API / SDK), is authoritative. **When this README and the specs disagree, the specs win.**

---

## 1. What each contract is

### 1.1 BSC side — agent identity

| Contract | File | Role |
|---|---|---|
| `AgentRegistry` | `src/AgentRegistry.sol` | Soulbound ERC-721 agent identity. `register` takes `ENTRY_DEPOSIT = 0.02 BNB` and issues a 3-round chained challenge; solving all three activates the agent. Also holds heartbeat / dormancy, controller rotation (EIP-712, new-key signature), publish, retire + deposit withdrawal, forfeiture, and the 48h-timelock ban path with a `vetoKey` cancel. Spec §3. |

Notes that matter when you read the code:

* The EIP-712 domain pins `chainId = 56` literally (spec §3.3), so the separator is identical on
  mainnet, on a fork and on anvil. `domainSeparator()` is exposed for the SDK and tests.
* `rotateController`'s typehash is
  `RotateController(uint256 agentId,address newController,uint256 deadline)` — the spec did not
  name one. **This must be mirrored in `03-INTERFACES.md` before the SDK ships.**
* Forfeiture fires at `failedRounds >= MAX_FAILED_ROUNDS (10)` and **only for agents that were
  never activated**. An activated agent's deposit can be taken by `ban` alone.
* `sweepForfeited()` forwards all remaining gas with `call{value:}("")` and requires
  `gasleft() >= 150_000`. Never use `transfer` / `send` against the vault — the 2,300-gas
  stipend cannot pay for its cold `receive()`.

### 1.2 BSC side — the bridge and the money

| Contract | File | Role |
|---|---|---|
| `BacBridge` | `src/BacBridge.sol` | The BAC / layer-credit bridge and the bridge pool. `lock` (entry, gated on `AgentRegistry.isActive`), `claimExit` (Merkle proof against a FINAL `ChainAnchor` anchor, **rate locked at claim time**), `settleEpoch` (sequential, `releaseBps` read from `ChainAnchor`), `collect` (O(1) accumulator, no per-epoch ledger). Plus the irreversible escape mode (`armEscape` to 14-day delay to `checkHalt` to `claimOwedAfterHalt` / `escapeCollect`), the watchdog brake (`pause` / `unpause`, capped at 21 days cumulative) and the one-way `burnLocked()`. Spec §4. |
| `BacNodeFund` | `src/BacNodeFund.sol` | The official node fund. Permissionless `acceptRelease()` in, two-step-ownable `withdraw` out. Deliberately tiny. Spec §5. |

`BacBridge` **has no `admin` and no veto key of its own.** Its only privileged immutable is
`watchdog`, which can `pause` / `unpause` / `armEscape` and can never move money. Anything
needing veto authority reads `IChainAnchor(anchor).vetoKey()` live.

### 1.3 BSC side — the anchor and its witnesses

| Contract | File | Role |
|---|---|---|
| `ChainAnchor` | `src/ChainAnchor.sol` | The relayer posts one anchor per epoch (`postAnchor`); it matures through `COMMIT_WINDOW` / `CHALLENGE_WINDOW` to `FINAL`, or is `VETOED` / `DISPUTED`. `releaseBpsFor(epoch)` returns **200 / 350 / 500 bps** by how many independent witnesses agreed; `haltReason()` is the pure view `BacBridge` polls. Check #7 (`cumulativeCredited + creditedInEpoch <= IBacBridge(bridge).totalCreditsIssued()`) is the load-bearing wall of cross-chain safety. Spec §6. |
| `ValidatorStaking` | `src/ValidatorStaking.sol` | BAC staking, node registration (`MIN_STAKE = 2,000,000 BAC` per node, `MAX_NODES = 64`) and the commit-reveal attestation that `ChainAnchor` **pulls** through `attestationResult(...)`. Rewards are funded permissionlessly and settled sequentially. `WEIGHT_CAP` is deleted; `MAX_VALIDATOR_SHARE_BPS = 2500` constrains the **reward split only, never witness weight**. Spec §7. |

### 1.4 BSC side — the Flap launch pair

| Contract | File | Role |
|---|---|---|
| `BacVaultFactory` | `src/BacVaultFactory.sol` | The Flap `VaultFactoryBaseV2` factory. `factorySpecVersion()` returns `"v2.3"`. **The `UpgradeableBeacon` is created inside the constructor**, so `beacon.owner() == address(this)` — never move it into a deploy script. `newVault` runs the §1.2 pre-launch checks (including `IBacBridge(bridge).bacToken() == taxToken` and the same for the node fund) and deploys a `BeaconProxy`. Spec §1. |
| `BacTreasuryVault` | `src/BacTreasuryVault.sol` | The tax recipient (`VaultBaseV3`, `vaultSpecVersion() == "v3"`). Recognizes revenue by **rule 010** only — `address(this).balance - accountedQuote`, baseline decremented before every external call and re-read after — then `settle()` splits 50/50 and pushes to `BacBridge.acceptRelease()` and `BacNodeFund.acceptRelease()`. A failed push books into `stuckBridge` / `stuckNodeFund`, and `retryPush()` clears the bucket **first**. Its owner has **no power over any funds**. Spec §2. |
| `BacVaultUI` | `src/lib/BacVaultUI.sol` | **External linked library.** Renders `description()` and `vaultUISchema()` for flap.sh, keeping the frozen brand strings out of the vault's runtime code. `describe` reads `IBacNodeFund(nodeFund).owner()` at runtime (code-length check, then try/catch) so the disclosed withdrawer can never be faked. |

`accountedQuote` and the unsplit balance share one storage slot (high 128 / low 128), which is
why `receive()` is a single SLOAD + SSTORE. It must stay cheap (< 30k warm, succeeding under
`call{gas: 50_000}`) and it must never revert.

### 1.5 Layer side (chain id 56777)

| Contract | File | Role |
|---|---|---|
| `L2Bridge` | `src/layer/L2Bridge.sol` | Mints layer credits from a BSC deposit; burns them on exit into the Merkle leaf `BacBridge.claimExit` verifies. |
| `L2Gate` | `src/layer/L2Gate.sol` | Mirrors `AgentRegistry` status onto the layer; `isAdmitted(addr)` is the single place the layer reads an agent's status. |
| `AgentBook` | `src/layer/AgentBook.sol` | The one canonical `Action(uint256,bytes32,address,address,bytes32,string,string,uint64,uint64)` event plus the 11 frozen `kind` constants of `03-INTERFACES.md` §4. Per-epoch publish cap, fee burned to `FEE_SINK`. |

### 1.6 Interfaces

`src/interfaces/` holds the minimal, **shared** views used across the group boundary:
`IAgentRegistry`, `IBacBridge`, `IBacNodeFund`, `IChainAnchor`, `IValidatorStaking`,
`IL2Bridge`, `IL2Gate`. `IChainAnchor` owns the single `State` enum and `Anchor` struct, so the
anchor, the bridge, the staking contract and the tests all speak one type.

**Extend these files, never overwrite them.** `IBacBridge` in particular is shared: `ChainAnchor`
needs `totalCreditsIssued()`, `BacVaultFactory` needs `bacToken()`, `BacTreasuryVault` pushes to
`acceptRelease()`. Dropping any one of the three breaks a different group's build.

### 1.7 Frozen, do not edit

`src/flap/*.sol` are Flap's own sources, copied byte-identical from the previous projects.
`test/FlapBSCFixture.sol` and `test/lib/VanityHelper.sol` are the mainnet-fork fixture.
None of these are edited, and `forge fmt` is never run over them (see §4).

---

## 2. Build

The toolchain is already pinned in `foundry.toml` — **do not change it**: solc 0.8.26,
`evm_version = "cancun"`, optimizer on at 200 runs, `via_ir = true`. Dependencies in `lib/`:
OpenZeppelin 4.9.6, OpenZeppelin-upgradeable 4.9.6, forge-std 1.14.0, with `remappings.txt`
present.

```bash
cd contracts
forge build
forge build --sizes      # runtime / initcode size table
```

`via_ir` is required, not optional: it is what keeps the vault pair inside EIP-170.

---

## 3. Test

```bash
forge test                                           # everything, 248 tests
forge test -vv                                       # with logs
forge test --match-contract BacBridgeInvariantTest   # the B1-B17 invariant run
forge test --match-path 'test/smoke/*'               # BSC mainnet fork smoke (read-only)
```

| Suite | File | Covers |
|---|---|---|
| `AgentRegistry` | `test/AgentRegistry.t.sol` | registration, the 3-round chained challenge, soulbound transfer paths, rotation, heartbeat / dormancy, forfeiture, ban timelock, `sweepForfeited` gas rules |
| `BacBridge` + `BacNodeFund` | `test/BacBridge.t.sol` | lock / exit / settle / collect, escape mode, pause budget, burn, node fund |
| Bridge invariants | `test/BacBridgeInvariant.t.sol` | B1-B17 under a fuzzing handler |
| Vault pair | `test/BacVault.t.sol` | rule 010 accounting, `receive()` gas floor, stuck / retry, launch validation, V1 / V2 / V9 solvency after every scenario |
| `ChainAnchor` | `test/ChainAnchor.t.sol` | post / finalize / veto / dispute, the §6.2 check table, `releaseBpsFor` |
| `ValidatorStaking` | `test/ValidatorStaking.t.sol` | staking plus the per-node stake inequality, commit-reveal, reward settlement and expiry |
| Layer | `test/Layer.t.sol` | `L2Bridge` mint / burn, `L2Gate` admission, `AgentBook` event schema and caps |
| Fork smoke | `test/smoke/ForkSmoke.t.sol` | BSC mainnet fork reachable, live Flap addresses have code, `Portal.version() == v5.24.0`, `VaultPortal.version() == 1.15.0` |

Two conventions the suites rely on, both a consequence of `via_ir`:

* test code reads `vm.getBlockTimestamp()`, never `block.timestamp` — via-IR caches
  `block.timestamp` inside a test function and silently collapses multi-warp loops;
* fund a vault with `call{value:}("")`, never `payable(vault).transfer()`.

**Nothing here broadcasts.** No script is run with `--broadcast`, nothing is deployed, and the
fork tests are read-only.

---

## 4. Format

```bash
forge fmt src/*.sol src/interfaces src/layer src/lib test/*.t.sol
```

Scope it like that. A bare `forge fmt` would also rewrite `src/flap/*.sol`,
`test/FlapBSCFixture.sol` and `test/lib/VanityHelper.sol`, which must stay byte-identical to
their upstream copies.

---

## 5. Size table

The EIP-170 runtime limit is 24,576 bytes; the EIP-3860 initcode limit is 49,152.
Measured with `forge build --sizes` on the toolchain above.

| Contract | Runtime (B) | Initcode (B) | Runtime margin (B) |
|---|---:|---:|---:|
| `AgentRegistry` | 22,358 | 23,723 | 2,218 |
| `BacBridge` | 15,466 | 16,176 | 9,110 |
| `ValidatorStaking` | 14,411 | 15,692 | 10,165 |
| `BacVaultFactory` | 13,062 | 21,139 | 11,514 |
| `BacVaultUI` *(linked library)* | 12,193 | 12,223 | 12,383 |
| `ChainAnchor` | 8,072 | 8,967 | 16,504 |
| `BacTreasuryVault` | 6,365 | 6,557 | 18,211 |
| `L2Bridge` | 4,825 | 5,350 | 19,751 |
| `AgentBook` | 2,972 | 2,998 | 21,604 |
| `L2Gate` | 1,695 | 1,721 | 22,881 |
| `BacNodeFund` | 1,651 | 2,045 | 22,925 |

**`AgentRegistry` is the one to watch: 2,218 bytes of headroom.** Any new bilingual require
string or view function there should go into an external linked library the way `BacVaultUI`
does for the vault (`../docs/research/02-contracts-skeleton.md` §7.5), not into the contract.

---

## 6. Rules this code is held to

* **No custom errors in our contracts.** Every `require` carries a bilingual string written
  exactly as the spec writes it: `unicode"English / 中文"`.
  `grep -rn '^\s*error ' src --include='*.sol' | grep -v '/flap/'` must stay empty — it is.
  The five errors that still appear in `forge inspect` output (`UnsupportedChain`,
  `ZeroAddress`, `OnlyVaultPortal`, `LegacyV6ValidationHookNotImplemented` on the factory;
  `UnsupportedChain` on the vault) are inherited from the frozen Flap base classes and are
  exactly the four-item whitelist of `00-DESIGN-SPEC.md` revision #6. None of our code reverts
  with them, and they are unreachable on chain 56 / 97.
* **No owner path may ever touch the bridge pool.** `BacBridge` has no `admin`. The vault owner
  can only hand ownership on. The node-fund owner can only withdraw the node fund.
* **Rule 010** for the vault: recognize revenue only as `address(this).balance - accountedQuote`,
  never cache `accountedQuote` across an external call, decrement before every external call.
* **The beacon is born in the factory constructor**, so `beacon.owner() == factory`.

---

## 7. Deployment notes (nothing here is deployed yet)

No deploy script exists — that is a later stage. Two things are already known:

1. `BacVaultUI` must be deployed by CREATE2 (`0x4e59b44847b379578588920cA78FbF26c0B4956C`,
   salt 0) **before** the factory, and verification needs
   `--libraries src/lib/BacVaultUI.sol:BacVaultUI:<addr>`. Its bytecode differs from the fly/rat
   libraries (different strings), so the salt-0 address cannot collide.
2. The deployment order and the pre-launch green-light checklist are `01-CONTRACT-SPEC.md` §9 and
   `00-DESIGN-SPEC.md` §7.3 (14 hard-stop items). The frozen Chinese brand strings in §1.6 / §2.4
   / §2.5 still need the user's verbatim approval before deploy: deploying freezes them, and
   changing one word later means redeploying both the factory and the library.
