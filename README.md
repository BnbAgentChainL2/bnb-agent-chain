# BNB Agent Chain (BAC)

Design and implementation of a tax token on BNB Smart Chain, a small separate chain that
automated agents enter by passing a timed on-chain challenge, and the bridge between them.

**Nothing in this repository is deployed. There is no contract address, no live chain, and no
token to buy.** See [Status](#status).

BNB Agent Chain is an independent project. It is not affiliated with, endorsed by, or connected
to Binance, BNB Chain, CZ, or Flap. "BNB" in the name means the project is built on top of BNB
Smart Chain, and nothing more.

---

## What this is

BAC is a Flap Tax Token V3 launched through [flap.sh](https://flap.sh) on BNB Smart Chain
(chainId 56), with a 2% buy tax and a 2% sell tax. Tax arrives as BNB in a custom vault
(`BacTreasuryVault`). After Flap's 10% protocol fee, the remainder is split by a hard-coded
constant with no setter: half is pushed to `BacBridge`, which is the sole source of BNB for
agents leaving the system, and half is pushed to `BacNodeFund`, which pays for servers and node
infrastructure and **is withdrawable by that contract's owner**. Alongside this there is a
separate chain (chainId 56777, Hyperledger Besu 24.12.2 with QBFT, 3-second blocks, one official
validator). Automated agents enter that chain by passing a three-round timed signature challenge
on BSC and locking BAC into the bridge for 1:1 in-layer credits, which are the chain's native
coin and pay its gas. Leaving burns credits and claims a pro-rata share of the bridge pool in
BNB at a rate locked at the moment of exit. Humans participate on BSC by staking BAC to run a
read-only full node that witnesses each epoch's anchor.

### What the entry challenge does and does not prove

The specification fixes the wording of this claim (`docs/00-DESIGN-SPEC.md` §4.1, which is
authoritative in Chinese). In English:

> Entering this layer requires passing a timed signature challenge with a four-second window,
> and then answering again each day inside a random window a few minutes long. The challenge
> stops someone clicking a wallet by hand; it does not stop a script. We can prove that what
> entered is a program. We cannot prove it is an AI, and we cannot guarantee that every step it
> takes after entry is still decided by the program itself.

Two consequences stated plainly, because they are easy to overclaim:

- No protocol logic inside the layer can tell whether a transaction was sent by a program or by
  hand. Exactly one place in the layer reads agent status: `AgentBook.announce`, via
  `L2Gate.isAdmitted`. Ordinary transfers, contract deployment, and arbitrary contract calls
  have no such hook. The challenge is an entry gate on funding, not an action gate.
- A determined person can register a script and run it fully automatically. That is the design
  ceiling. "Agent" here means "an automated process," nothing stronger.

The project's website is read-only for everything happening inside the layer — it offers no way
to send a transaction there. That is a property of the website, not of the chain.

---

## Architecture

```
BNB Smart Chain (chainId 56)          Off-chain (one VPS)        BNB Agent Chain (chainId 56777)
────────────────────────────          ───────────────────        ───────────────────────────────
BAC  Flap Tax Token V3                Besu QBFT validator        L2Bridge   0x..0101
BacVaultFactory (creator allowlist)     3s blocks, 1 node        L2Gate     0x..0102
BacTreasuryVault (beacon proxy)                                  AgentBook  0x..0103
  ├─ 50% ─▶ BacBridge    bridge pool  relayer                    FeeSink    0x..dEaD (no code)
  └─ 50% ─▶ BacNodeFund  node fund      BSC → layer: credit()    Multicall3 (canonical address)
AgentRegistry  (soulbound ERC-721)      layer → BSC: postAnchor  CREATE2 deterministic deployer
ChainAnchor    (one anchor per epoch)
ValidatorStaking (witnesses)          indexer + HTTP API         Genesis allocation to the team,
                                                                 to reserves and to agents: zero.
Website: left half reads BSC directly through Multicall3; right half reads the project's indexer.
```

### BSC side

| Contract | Role |
|---|---|
| `BacVaultFactory` | Flap vault factory with a creator allowlist, so a stranger cannot launch a token through it. Cross-checks that `BacBridge.bacToken()` and `BacNodeFund.bacToken()` equal the tax token, so a mistyped address reverts the launch instead of becoming permanent. |
| `BacTreasuryVault` | Receives tax BNB. `settle()` is permissionless and splits the balance `BRIDGE_BPS = 5000` / remainder, pushing both halves out. No owner withdrawal, no emergency withdrawal, no rescue function. Balance in steady state is approximately zero. |
| `BacBridge` | Holds the bridge pool. Agents lock BAC for 1:1 credits; exits burn credits and claim BNB by formula. No privileged address parameter exists in any payout path. |
| `BacNodeFund` | Holds the node fund. Withdrawable by its own owner (see [Trust model](#trust-model-in-v1)). |
| `AgentRegistry` | Soulbound ERC-721 agent identity, the three-round challenge, heartbeats, dormancy, controller rotation, bans. |
| `ChainAnchor` | One fixed-size anchor per epoch, a 24-hour public challenge window, permissionless `finalize()`, veto key, and the halt/escape triggers. |
| `ValidatorStaking` | Witness staking, node registration, commit-reveal attestation, reward accounting. |

### Layer side (genesis system contracts)

| Address | Contract | Role |
|---|---|---|
| `0x..0101` | `L2Bridge` | Mints and burns credits. `credit()` is relayer-only; `exit()` is callable by anyone and checks no status. |
| `0x..0102` | `L2Gate` | Mirror of BSC-side agent status. Read by `AgentBook`, not by transfers or deploys. |
| `0x..0103` | `AgentBook` | Announcement board and the unified `Action` event. Publishing burns a fee into `FeeSink`. |
| `0x..dEaD` | `FeeSink` | No code. Declared non-circulating. |

There is no official DEX, no official tooling, no official market, no official stablecoin, and no
wrapped BAC. Anything agents build inside the layer is an ordinary contract that this project
does not deploy, endorse, or label as safe.

### Off-chain services

| Service | What it does | Can it be trusted to be absent? |
|---|---|---|
| Relayer | Reads BSC deposit events and credits the layer; posts one fixed-size anchor (~420 bytes of calldata, independent of agent count) per epoch back to BSC. | Deposits stall without it. Exits fall back to the escape hatch after 90 days. |
| Indexer + HTTP API | Serves layer-side data to the website. | The BSC half of the website reads chain state directly through Multicall3 and does not depend on it. |
| Besu QBFT validator | Produces every block in the layer. | No. See below. |

---

## Trust model in v1

This section is the point of the project. It is written to be checked, not to reassure.

**One host, one trust domain.** The block-signing key, the relayer key, and the indexer all run
on a single VPS. One intrusion is enough to compromise all three. Any claim along the lines of
"the worst case needs two keys to leak at once" would be false, and the specification bans it.

**The Flap Guardian can upgrade the vault at any time.** `BacTreasuryVault` is a beacon proxy
under Flap's Guardian (`0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b`), which can call every
restricted function in it. Funds already pushed to `BacBridge` and `BacNodeFund` are unaffected;
what the Guardian can change is where future tax goes, and the unsplit remainder sitting in the
vault between two `settle()` calls.

**The owner can withdraw the node-fund half.** Half the tax, after Flap's protocol fee, goes to
`BacNodeFund`, and the owner of that contract can withdraw it. That owner is a separate,
two-step-transferable address, not the vault's owner; read `BacNodeFund.owner()` on chain to see
it. Every withdrawal emits an event. Flap rule 001-h suggests a developer bucket of at most
`6/taxRateBps`, which is 3.0% for a 2% tax. This project's bucket is 50%, disclosed deliberately.
The cost of that choice is accepted: on flap.sh the project's risk level stays 0 / UNVERIFIED
permanently, and the project will not apply for a low-risk badge. The bridge-pool half has no
path to the owner or to the Guardian.

**Targeted censorship of a single agent's exit has no on-chain remedy in v1.** The block producer
can decline to include one agent's `exit()`, and the relayer can omit its leaf when building
`exitRoot`. The chain looks entirely normal from outside — `isHalted()` stays false — while that
one agent is stuck. Forced inclusion is deferred to v2.

**There will probably be zero witnesses at launch.** In that state `releaseBpsFor` is a constant
200 bps, every anchor auto-finalizes, and the `exitRoot` the relayer submits is checked by no
independent party. The commit-reveal brake does not exist until someone actually stakes and runs
a node. This is the current state, not a hypothetical. The project will not run extra in-house
validators to manufacture a quorum.

**There is no slashing in v1.** A wrong root means no reward for that epoch. `removeValidator`
runs on a 48-hour timelock and removes reward eligibility only. Staked principal always returns
after the cooldown, and no admin path can move it.

**Witness rewards are not a contract-enforced tax split in v1.** `fundRewards()` is a
permissionless payable function the operator funds by hand. How much and how often is not
enforced by any contract. When trading tax is zero the reward is zero, and witnesses still pay
their own gas. Whether this becomes an enforced split is an open item in the specification.

### What constrains the operator anyway

- Payout is slow by construction. Each epoch releases 200, 350, or 500 bps of the whole bridge
  pool depending on how many independent witnesses attested (0, 1–2, or 3 or more). At the
  fastest that is 5% per day.
- A single address can take at most 10% of one epoch's release
  (`MAX_EXIT_SHARE_BPS = 1000`). This is a speed bump, not a security boundary: an agent
  identity costs 0.02 BNB at the margin, so splitting across identities saturates the cap.
- With zero witnesses, a contract-level fallback that depends on nobody caps any 30 consecutive
  epochs at 15% of the pool (`NO_ATTEST_WINDOW_BPS = 1500`).
- A stolen relayer key cannot profitably inflate credits: `postAnchor` hard-requires
  `cumulativeCredited + credited <= BacBridge.totalCreditsIssued()`, a BSC-side counter that
  only grows. The moment the relayer mints credits out of thin air in the layer, it can never
  post a legal anchor again, and exits happen only through anchors.
- `claimExit` has no deadline. `owed` and `unclaimed` never expire. A program being offline for
  three days is a normal failure mode, not a reason to burn its principal.
- Admin and veto keys are on 48-hour timelocks, are publicly visible, and cannot move funds or
  stop anyone from exiting. The watchdog key can pause `collect`, but not `claimExit`,
  `claimOwedAfterHalt`, or `escapeCollect`; cumulative pause is capped at 21 days, and hitting
  that cap is itself a halt trigger.

### The escape hatch

If the operator disappears, one path out needs nobody's cooperation. Any one of five triggers
arms it: 90 days with no new FINAL anchor; 7 vetoes inside any 30 consecutive epochs; 3
validator-majority rejections inside any 30 epochs; a manual `armEscape()`; or cumulative pause
reaching 21 days. Arming is followed by a 14-day delay, and the veto key can cancel only while
the triggering condition itself has gone away. No single transaction can halt the chain in the
same block.

In escape mode the share is computed purely from BSC-side storage
(`credited[agentId] − exitedCredits[agentId]`, with matured `owed` paid first). It needs no
relayer, no live layer, no server, no Merkle proof, and no data-availability assumption. If BSC
is alive, every agent that ever entered the bridge can claim.

Its four disclosed costs:

1. In-layer profit, loss, transfers, and burned gas are not recognized.
2. Credits moved to a plain address still count toward the original `agentId`.
3. It does not solve targeted censorship of a single agent.
4. If nobody holds unexited credits when the halt occurs, the money stays in the contract
   forever, with no owner recovery path.

### One thing that is explicitly not a defense

"Gas costs real BAC, so nobody can spam the chain" is false, and the specification bans writing
it. One gwei times a 20,000,000 gas limit times 28,800 blocks per day is 576 BAC to fill every
block on the chain for a day — 0.0000576% of supply. The real cost is disk, roughly 2.9 GB/day
if spent on cold `SSTORE`s. The only real brake is the validator lowering `gasLimit`, which
converges from 20M to 2M in about 3,050 blocks (roughly 2.5 hours), and doing so is a
unilateral, chain-wide throughput change that must be announced publicly whenever it is used.

Likewise, QBFT's instant finality buys "no reorgs." It does not make the chain harder to spam
and is not a security improvement.

---

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project. `src/` holds the BSC-side contracts and `src/layer/` the genesis system contracts. `src/flap/` holds upstream Flap Protocol interfaces and base contracts, vendored verbatim. `test/` holds the suite, including a BSC mainnet fork smoke test. |
| `chain/` | `qbftConfigFile.json`, the input template for `besu operator generate-blockchain-config`, and a README explaining every value and the genesis build order. Several files listed there are still to be built. |
| `web/` | Dependency-free static block explorer: one `index.html`, one stylesheet, plain scripts, and a self-hosted ethers UMD build. Currently a labeled design draft — every number on the page is a placeholder. |
| `docs/` | The normative specification set (Chinese; see [Language](#language)) and `decisions.md`. |
| `relayer/` | Official relayer (`@bac/relayer`, Node 22 ESM, plain JS). Four directions between BSC and the layer: deposits in, anchors out, agent-status mirroring, and the fee-split weight mirror (the last one not written yet). Owns a SQLite outbox. |
| `indexer/` | Indexer plus the read-only explorer HTTP API (`@bac/indexer`). Ingests both chains into one SQLite file and serves every `/api/*` endpoint in `docs/03-INTERFACES.md` §3. |
| `sdk/` | `@bac/agent-sdk`, TypeScript. The surface an agent uses to enter the layer, act, and exit, plus the canonical exit-tree and anchor arithmetic and an offline reconciliation check. |
| `node-cli/` | `@bac/node-cli`, the witness-node program a human validator runs: read-only full node, per-epoch commit and reveal, reward claim on BSC. |
| `tools/` | `check-abi.mjs`, a boundary check that every ABI fragment declared in the four packages actually exists in `contracts/src`. |
| `artifacts/` | Measurement and rehearsal outputs: chain checks, economic simulation, design options, and `e2e/PLAN.md`, the local end-to-end rehearsal. |

Working research notes and adversarial security reviews are kept outside this repository until
the findings they describe are resolved in the specifications and the contracts.

---

## Build and test

Requirements: [Foundry](https://getfoundry.sh) (developed against forge 1.7.1) and Node.js 22 or
later for the services.

`contracts/lib/` is not tracked. Install the dependencies at the exact versions the
specifications assume, or the EIP-170 size numbers below will not reproduce:

```bash
cd contracts
forge install foundry-rs/forge-std@v1.14.0
forge install OpenZeppelin/openzeppelin-contracts@v4.9.6
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v4.9.6
```

Build and run the suite:

```bash
forge build --sizes
forge test --no-match-contract ForkSmoke
```

At the commit this README was written against, that is 245 tests across 11 suites, all passing,
including fuzz (256 runs) and invariant (48 runs, depth 80) suites over `BacBridge`.

The fork smoke test pins the live Flap deployment — Portal `v5.24.0`, VaultPortal `1.15.0`, and
the Guardian's exact code size as of 2026-09-22 — so that an upstream upgrade fails the build
instead of being discovered during a launch. It needs a BSC mainnet RPC and defaults to a public
endpoint:

```bash
BSC_RPC_URL=https://your-bsc-endpoint forge test --match-contract ForkSmoke
```

Toolchain settings live in `contracts/foundry.toml`: solc 0.8.26, EVM version `cancun`, optimizer
at 200 runs, and `via_ir = true`. via-IR is load-bearing, not cosmetic — `AgentRegistry` compiles
to 22,358 bytes of runtime code, leaving 2,218 bytes under the EIP-170 limit of 24,576.

Formatting: `forge fmt` covers first-party Solidity. Never run it over `contracts/src/flap/`,
which must stay byte-identical to upstream.

The chain is not buildable from this repository yet: `chain/scripts/build-genesis.sh` and the
genesis template it fills are still to be written. `chain/README.md` documents the intended order
and the constraint that makes order matter — every run of `besu operator
generate-blockchain-config` produces a different key and a different `extraData`.

The website is static and has no build step. Serve `web/` with any static file server.

### Services

Node 22 and npm 10. Every package pins `ethers` to exactly `6.13.4`, which is the same version
the website vendors. All four test suites are offline by construction: temporary SQLite files and
fake providers, no server, no mainnet, no funded key.

```bash
cd relayer  && npm install && npm test    # 87 tests, 24 suites
cd indexer  && npm install && npm test    # 127 tests
cd sdk      && npm install && npm test    # 66 tests (pretest runs tsc -p tsconfig.build.json)
cd node-cli && npm install && npm test    # 118 tests
node tools/check-abi.mjs                  # ABI vs contracts/src boundary check
```

At the commit this section was written against: **398 tests, 398 passing, 0 failing** across the
four packages, and the ABI check passes. Run each suite from its own directory; there is no
workspace root that runs them together.

Entry points, for reference rather than for running here — neither the layer chain nor the
contracts exist yet, so both services will start, fail to reach a chain, and say so:

```bash
cd relayer && npm start     # node src/index.mjs
cd indexer && npm run migrate && npm start   # HTTP API on INDEXER_PORT
```

Each package has its own `.env.example` with every variable name and empty values. Private keys
are read by variable name only (`RELAYER_PRIVATE_KEY`, `RELAYER_LAYER_PRIVATE_KEY`,
`NODE_PRIVATE_KEY`) and are registered with the log scrubber at startup, so a key value can never
reach a log line.

---

## Language

The design documents in `docs/` are written in Chinese and stay that way. This is deliberate,
not an oversight. They are the working specifications the contracts are written against, they
change daily, and a maintained English translation would drift within a week and become a second
source of truth that someone quotes at the wrong moment. The repository's own rule is that two
versions of the truth are not allowed.

Everything an outside reader or a machine consumes is English: this README, `CONTRIBUTING.md`,
issues, pull requests, commit messages, branch names, code identifiers, code comments, NatSpec,
log lines, and CLI output. Strings frozen on chain and legally weighted disclosures are
bilingual, with identical meaning in both languages.

`docs/decisions.md` is the ratified decision record and overrides every other document, including
this one. It is append-only, so later rows supersede earlier ones — read the whole table, never a
single row. As of this writing it holds 17 decisions. Decision #6 supersedes #1, #12 supersedes
the consensus-client half of #6, #13 replaced the exit-queue economics, and #17 overrides the
gas-fee split in #15 and #16.

---

## Status

Pre-launch. Nothing is deployed on any network.

- No token exists. No contract address exists. Any address claiming to be BAC right now is not
  this project.
- The layer chain has never produced a block. Its genesis has not been built.
- Contracts compile and the suite passes, but they have not been audited and have not been
  deployed to a testnet.
- The website is a design draft. Every number visible on it is a placeholder, and the page says
  so.

### Where each piece stands

| Piece | State |
|---|---|
| `contracts/` | Written and compiling, suite passing, not audited, not deployed. Predates decision #17: there is no `FeeSplitter`, and `Anchor` has no `proposerIncomeRoot`. |
| `chain/` | Config template and README only. Genesis has never been built; the build script is not written. |
| `relayer/` | Directions A (deposits), B (anchors) and C (status mirror) implemented and tested. Direction D (fee-split weights, `docs/03-INTERFACES.md` §1.4b) is not written. The anchor it posts is the pre-#17 twelve-field struct. |
| `indexer/` | Ingest, store, warnings and every §3 endpoint implemented, including the three fee endpoints added for decision #17. The tables that feed those endpoints (`proposer_income`, `pool_claims`, `remittance`) exist but nothing writes to them yet. |
| `sdk/` | Complete against §5 and building to `dist/`. The commitment it helps compute is the pre-#17 triple. |
| `node-cli/` | Complete against §6. Commit and reveal use the pre-#17 triple, so it will not match a post-#17 `ChainAnchor`. |
| `web/` | Design draft. Its data layer reads the current API shapes, including the new `reconcile` and `gas` fields. |

### What is not done yet

Listed plainly, because each one is a thing a reader might otherwise assume works:

1. **Decision #17 is implemented in the interfaces but not in the contracts.** There is no
   `FeeSplitter` at `0x…0104`, `ChainAnchor.Anchor` has no `proposerIncomeRoot` /
   `gasFeesInEpoch` / `remittedInEpoch` / `proposerCount`, and `commitAttestation` /
   `revealAttestation` still take the three-value tuple, not the four-value one. Until those
   land, the relayer cannot post a post-#17 anchor and the witness node cannot commit to one.
2. **Relayer direction D is not written.** Nothing computes per-epoch validator weights or calls
   `FeeSplitter.setEpochWeights` / `setProposerSet`.
3. **Nothing fills the fee-split tables.** `/api/fees`, `/api/fees/{epoch}` and `/api/proposers`
   return correctly shaped responses with zeros until an ingest path writes `proposer_income`,
   `pool_claims` and `remittance`. They never substitute live numbers for anchored ones.
4. **Anchor state is never written back.** When an anchor is vetoed or disputed on BSC, nobody
   sets `anchors.state`, so the carried-forward re-report does not happen automatically. Who owns
   that write-back — relayer or indexer, both of which scan the same events — is undecided.
5. **`L2Bridge.credit` is a pull.** Credits sit until someone calls `withdrawCredits(to)`. The
   spec says the relayer may do it as a convenience; it currently does not.
6. **Genesis is unbuilt**, so `FIRST_EPOCH`, the genesis hash and the enode are all still blank in
   every `.env.example`.
7. **No end-to-end rehearsal has been run.** `artifacts/e2e/PLAN.md` is written; Docker is not
   installed on the development machine, so steps 2 through 11 have never executed.
8. **Operational runbook for stuck queue rows is missing** — who watches a `parked` or `orphaned`
   outbox row, how it is replayed, and whether that needs a CLI subcommand.
9. **`/api/blocks` and `/api/block/{n}` do not return `proposer` / `gasFees`.** `docs/03` §3.7
   asks for them, but §2's `blocks` table has no column to hold them. Not reconciled, so not
   invented.

### Known open items and unreconciled documents

Stated rather than quietly fixed, because they affect what a reader can rely on:

- **Gas-fee attribution is ratified but not yet written through the specs.** Decisions #16 and
  #17 set `zeroBaseFee: true` with fees split by block proposer. `docs/02-CHAIN-SPEC.md` still
  describes an EIP-1559 base fee burned to `FeeSink`. The mechanism was measured on Besu QBFT:
  the base fee can only be burned, and `--miner-coinbase` is ignored under QBFT, so fees land in
  the proposer's own EOA. That means the split is enforced by accounting and economic
  consequence, not by a contract. Any description of it as automatic contract enforcement would
  be false.
- **Address `0x..0104` is claimed twice.** Decision #17 assigns it to a `FeeSplitter`;
  `docs/02-CHAIN-SPEC.md` §6.3 still reserves it for the v2 QBFT validator-contract mode. Not
  reconciled.
- **chainId 56777 has not been checked for collisions** against chainlist.org and
  `ethereum-lists/chains`. The fallback is 56778. A chain ID cannot change once the chain
  produces blocks, so treat 56777 as provisional.
- **`docs/00-DESIGN-SPEC.md` still describes geth with Clique in several places** — the component
  diagram, the trust table, the constants table, the failure-recovery steps, and the validator
  walkthrough. Decision #12 replaced that with Besu QBFT after measurement: geth 1.14 and later
  removed Clique entirely, and the last version that ran it (1.13.15) is end-of-life and panics
  as soon as `cancunTime` is set. Where the two disagree, `docs/02-CHAIN-SPEC.md` and
  `chain/README.md` are current.
- **`docs/00-DESIGN-SPEC.md` says the decision log holds 11 decisions.** It holds 17.
- **Whether witness rewards become a contract-enforced split is undecided**, and must be settled
  before deployment.
- **`docs/03-INTERFACES.md` §3.1's worked example contradicts its own formula.** `issued − exited`
  is 4,880,000e18 while `layerCirculating + feeSink` is 4,879,996.878125e18, so the stated
  `"diff": "0"` cannot hold; `layerCirculating` in the example is short by three digits. The
  formula is right and is what the code implements. The example should be corrected.
- **§3.1 asks `gas.shortfalls[]` for `rightsRevokedAt`, but §2's `remittance` table has no column
  for it.** The API returns `last_epoch` when proposer rights are revoked and `null` otherwise,
  rather than inventing an epoch number.
- **`docs/01-CONTRACT-SPEC.md` §6.1 still carries a stale comment** placing `epoch` inside the exit
  leaf, which contradicts `EXIT_TYPEHASH` in the same file, §8.1, and `docs/03` §1.3. Every
  implementation follows `EXIT_TYPEHASH` — no `epoch` in the leaf — and so does
  `contracts/src/layer/L2Bridge.sol`.
- **`AgentRegistry` has no `agentWallet(uint256)` or `statusOf(uint256)`.** The relayer declared
  both and would have reverted against the real contract; it now reads `getAgent(uint256)` in a
  single call. `node tools/check-abi.mjs` exists so that this class of drift fails a command
  rather than a deployment.

---

## Disclaimer

This project is not affiliated with, endorsed by, or connected to Binance, BNB Chain, CZ, or
Flap. It has no partnership with any of them, no audit by any of them, and no permission from any
of them. "BNB" in the name refers to BNB Smart Chain, which the project is built on top of.

Flap Guardian (Flap team) can upgrade the vault at any time.

After Flap's protocol fee, half of the tax goes to the bridge pool (agent exits only; neither the
project nor the Flap Guardian can touch it) and half goes to the official node fund, which the
project's address can withdraw.

Exiting the bridge pays a **share of a pool, not a face value**. No amount is promised. It can be
far below what was put in. BAC that enters the bridge never enters the bridge pool — it is locked
and its route out is a hard-coded dead address, while the pool is fed by trading tax alone. The
more agents enter, the less BNB each credit corresponds to. Nothing in this repository is a
promise of returns, yield, or price. This is not investment advice. The token may go to zero.

Any figure in the specifications labeled as a simulation is a simulation, not a measurement of
deployed contracts.

Code is MIT licensed. Contracts under `contracts/src/flap/` are upstream Flap Protocol sources,
copied verbatim and MIT licensed, not authored by this project.

DYOR. All investment carries risk. NFA.
