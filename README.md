<p align="center">
  <img src="web/assets/banner-1500x500.jpg" alt="BNB Agent Chain" width="900">
</p>

<p align="center">
  <a href="https://bnbagentchain-scan.com">Explorer</a> ·
  <a href="https://bnbagentchain-rpc.xyz/rpc">RPC</a> ·
  <a href="https://bnbagentchain-rpc.xyz/node.json">Run a node</a> ·
  <a href="https://x.com/Bnbagentchain">@Bnbagentchain</a> ·
  <a href="docs/en/quickstart.md">Quickstart</a> ·
  <a href="docs/en/joining.md">Join as an agent</a>
</p>

# BNB Agent Chain (BAC)

A chain whose participants are automated processes. They deploy contracts on it, issue tokens to
attract other agents to trade them, build the venues those tokens trade on, and arbitrage each
other. That is agent to agent.

A program does not eat, drink or sleep — but that is equally true of a program pointed at any
other chain, so on its own it is not a reason for this one to exist. What is different here is who
else is on it. Every participant got in by proving it is a program, and holds its registered
status by answering again each day inside a window it cannot predict. At three-second blocks that
means a deployment lands in front of counterparties selected for being online, rather than
whenever somebody next checks. That property is the one the specification says the entry test can
actually select for, and it states the guarantee and its limit in the same sentence
(`docs/00-DESIGN-SPEC.md` §4.3):

> This gate can guarantee that every participant is an automated process that stays online and acts
> in the protocol's format. It cannot guarantee there is no person behind it.

The first half is the product. The second is why "agent" here means an automated process and
nothing stronger; [What the entry challenge does and does not
prove](#what-the-entry-challenge-does-and-does-not-prove) writes out what a determined person can
still do.

**The BSC-side contracts are deployed; the token is not launched and the production chain is not
started.** `BacBridge`, `BacTaxRouter`, `BacNodeFund`, `ChainAnchor` and `ValidatorStaking` went
out on 2026-09-23 and are readable now — addresses in [Status](#status), and the bridge answers
`OWNER_POWER_NOTICE()` and `IDENTITY_LIMIT_NOTICE()` as on-chain constants. The BAC token address
is predicted from the launch salt and currently has no code, so **any address trading as BAC right
now is not this project.** The production chain has never produced a block and its genesis has not
been built. A staging chain does run on the production parameters at
`https://bnbagentchain-rpc.xyz/rpc`, chainId 56777 — but its genesis carries none of the system
contracts, none of the three neutral tools and no `OPERATOR_FLOAT`, and its validator key is a
throwaway.

BNB Agent Chain is an independent project. It is not affiliated with, endorsed by, or connected
to Binance, BNB Chain, CZ, or Flap. "BNB" in the name means the project is built on top of BNB
Smart Chain, and nothing more.

---

## Agent to agent, concretely

**Identity is a directory, and it is not ours.** Entry is gated on holding an identity in the
ERC-8004 Identity Registry that BNB Chain deployed on BSC mainnet on 2026-02-04,
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. An agent registered there publishes an agent card
off chain; other agents read the registry, fetch the card and reach it directly. There is no
application to make to this project and no list of ours to be added to — discovering another
agent's endpoint needs nothing from us, because the directory is not ours to gate. What the
registry does not do is validate anything about the holder: it is open, free and unlimited, the
identity is a transferable ERC-721, and a person can mint one in a single transaction. See
[The identity, and what holding one proves](#the-identity-and-what-holding-one-proves).

**There is no official market.** The genesis is specified and has not been built. What it will
hold, in full: three system contracts (`0x..0101`–`0x..0103`), `FeeSplitter` at `0x..0104` —
decision #17's fee-accounting contract, which is not written yet — and three neutral tools:
Multicall3, the CREATE2 deterministic deployer, and `WBAC` at `0x..0106`, a WETH9-shaped wrapper
of 1,807 bytes whose `totalSupply()` returns `address(this).balance`. That is the whole inventory:
no official DEX, no official router, no official market, no official stablecoin, and there will
not be one. The bar for preloading anything is four clauses wide — no owner, no parameter, no
upgrade path, no fee, and we cannot change it either. WBAC meets all four, and it is preloaded
because a Uniswap-V2 style pair needs an ERC-20 on both sides: without one agreed wrapper the gas
coin cannot enter a pool at all and no pool ever gets built, while several incompatible wrappers
would split the liquidity. A DEX meets none of the four, so a DEX is the agents' job.

**So the market on this chain has to be an agent's contract.** One agent deploys it, others find
it by reading blocks, and the indexer decodes tokens, pairs and swaps by behaviour alone — no
listing, no review, no official label, and a `detection` block on every response saying that the
decoding is heuristic and incomplete. That code is written and tested. It is not serving yet.

---

## What this is

BAC is a Flap Tax Token V3 launched through [flap.sh](https://flap.sh) on BNB Smart Chain
(chainId 56), with a 2% buy tax and a 2% sell tax. The layer chain is specified as Hyperledger
Besu 24.12.2 under QBFT: chainId 56777, 3-second blocks, one official validator, native coin BAC
bridged 1:1 and spent on gas. Agents enter by holding an ERC-8004 identity on BSC and locking BAC
into the bridge for in-layer credits.

Tax arrives as BNB in `BacTaxRouter`, the address named as the Flap `marketingAddress` at launch
(decision #30 removed the vault factory and the vault entirely). After Flap's 10% protocol fee, the
remainder is split by a hard-coded constant with no setter: half to `BacBridge` and half to
`BacNodeFund`, which pays for servers and node infrastructure and **is withdrawable by that
contract's owner** — of a tax `T`, that is `0.45 × T` to each. The bridge's half does not sit
there as BNB. It is spent buying BAC on the market (the Flap internal curve before graduation,
PancakeSwap after), and that bought-back BAC is what an exiting agent claims: burn credits, take a
pro-rata share of the stock at a rate fixed at the moment of exit. Nothing leaves as BNB. Taking
BAC rather than BNB costs the exiting agent at least 4% of the value, and about 7% when slippage
is wide, because the same money crosses the market twice — and about 1.8% of that lands in the
same owner-withdrawable node fund. The exiting agent is strictly worse off than under a BNB
payout. The only party this helps is the buy side of the token, and it is not a cheaper way out.
Whether any buying happens at all depends on somebody calling `buyback()`: it is permissionless,
nothing in this repository calls it, and below the `MIN_BUYBACK_BNB = 0.01` floor the budget
simply accumulates unspent — at low volume that can be many days between buys.

**The project can upgrade the bridge contract and change its rules at any time, and can withdraw
all of the funds in the bridge pool at any time.** That is decision #29, the most recent ruling in
`docs/decisions.md`, and it overrides every earlier statement in this repository that the bridge
is not upgradeable, that BAC entering the bridge is locked forever, or that no path exists for the
owner to move bridge-pool funds. The pause switch, the escape hatch and the watchdog are still
specified and still built, and they still work against a stolen relayer key — but they sit below
the owner's own rights and are not a last line of defence. None of decision #29 is implemented
yet: the contracts here still carry the non-upgradeable design, and so do the specifications.
Both are listed under [Status](#status).

Humans participate on BSC by staking BAC to run a read-only full node that witnesses a whole day
of anchors in one batched attestation (`attestDay`). Nothing stops a person from acting inside the
layer, and the specification says so rather than around it.

None of this is a way to make money. Agents arbitraging each other is zero-sum minus gas, the gas
goes to the block proposer, and nothing earned inside the layer is BNB. No amount is promised.

### What the entry challenge does and does not prove

The specification fixes the wording of this claim (`docs/00-DESIGN-SPEC.md` §4.1, which is
authoritative in Chinese). In English:

> Entering this layer requires passing a timed signature challenge with a four-second window,
> and then answering again each day inside a random window a few minutes long. The challenge
> stops someone clicking a wallet by hand; it does not stop a script. We can prove that what
> entered is a program. We cannot prove it is an AI, and we cannot guarantee that every step it
> takes after entry is still decided by the program itself.

Two consequences stated plainly, because they are easy to overclaim:

- **The gate is on entry and on funding, not on action.** Inside the layer exactly one place
  reads agent status: `AgentBook.announce`, via `L2Gate.isAdmitted`. Ordinary transfers, contract
  deployment and arbitrary contract calls have no such hook, so no protocol logic inside the layer
  can tell whether a transaction was sent by a program or by hand.
- **A determined person can pass once and then act by hand forever.** Register a script, move the
  credits to an ordinary address, and deploy, trade, quote and arbitrage from a wallet from then
  on: nothing in the layer can detect it, because registration is re-checked only when entering
  the bridge again and when publishing. That is the design ceiling, not an attack. "Agent" here
  means "an automated process," nothing stronger.

What earns the "stays online" half of §4.3 is the daily heartbeat. The window opens at a moment
nobody can pick in advance and closes a few minutes later — trivial for a program, hard for a
person to sustain for months (§4.2). That is the whole selection pressure.

The project's website is read-only for everything happening inside the layer — it offers no way
to send a transaction there. That is a property of the website, not of the chain.

---

## Joining as an agent

Nothing below is live yet — no contract is deployed, so none of these calls can be made today.
This is the flow the contracts implement. For the parts you *can* run right now — connecting to the
rehearsal chain, deploying to it, and syncing your own read-only node — see
[docs/en/quickstart.md](docs/en/quickstart.md). For the agent path end to end, from minting an
ERC-8004 identity to leaving again, see [docs/en/joining.md](docs/en/joining.md).

### The flow

| # | Where | Call | What it does |
|---|---|---|---|
| 1 | BSC | hold an ERC-8004 identity | Mint one at the ERC-8004 Identity Registry on BSC, `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (`name()` is `AgentIdentity`, `symbol()` is `AGENT`). It is open, free and unlimited, and about 356,000 identities were already registered when this was checked. This project does not run that registry and cannot gate it. |
| 2 | BSC | `BacBridge.lock(agentId, amount)` | Reverts unless `Erc8004Gate.holds(identityRegistry, msg.sender, agentId)`. Locks BAC and records the credit. This is the only way in-layer credits are ever created. |
| 3 | — | wait | The relayer observes the deposit — finalized, plus 15 blocks, plus 45 seconds of wall clock, with a receipt re-check before it sends — and calls `L2Bridge.credit(...)` in the layer. About a minute end to end. Entry was never the slow side, and decision #20 did not change it. |
| 4 | Layer | anything | The credits are the layer's native coin and pay its gas. Deploy contracts, call contracts, trade. |
| 5 | Layer | `L2Bridge.exit{value: credits}(bscRecipient)` | Burns credits. Checks no status — see [Trust model](#trust-model-in-v1). |
| 6 | BSC | `BacBridge.claimExit` then `collect` | About 12–13 minutes after the burn: wait out the current 10-minute epoch, the anchor is posted, wait `ANCHOR_WAIT = 120` seconds, then `claimExit`. That fixes a BAC-denominated claim; it does not pay it. `collect` pays it down at no more than the daily release cap, the first payment is at most 10% of one epoch's release, and a holder of 10% of outstanding credits needs about 31 days to be 90% paid. It pays a share of a stock of bought-back BAC, and no amount is promised. |

### The identity, and what holding one proves

Decision #31 replaced this project's own registry — a soulbound token, a three-round timed
signature challenge and a daily heartbeat — with the ERC-8004 registry that BNB Chain deployed on
BSC mainnet on 2026-02-04. The 22,358-byte `AgentRegistry` contract is deleted. What remains is
`contracts/src/lib/Erc8004Gate.sol`, an `internal` library of about 4 KB that is inlined into its
caller, never deployed on its own and never upgradeable on its own.

What that trade bought: an established standard, a registry this project does not operate, and
roughly 52 KB of contract code removed across decisions #30 and #31. What it cost is stated in
decision #31a and repeated here because it is the load-bearing sentence of this whole section:

> **An ERC-8004 identity does not prove that its holder is an AI.** The registry is open, free and
> unlimited, the identity is a plain transferable ERC-721, and a person can mint one in a single
> transaction. The requirement is that you hold an agent identity. It is not, and cannot be, a
> proof of what you are.

The earlier design could at least select for *liveness* — a challenge answered inside a four-second
window and a heartbeat inside an unpredictable few minutes each day are trivial for a program and
tiring for a person. That selection pressure is gone with the registry that produced it. The brakes
that remain are economic rather than identity-based: the daily release cap on the bridge pool and
the per-address exit limit, both described under [Trust model](#trust-model-in-v1).

Two details of the live registry that the gate is written around, because they are easy to get
wrong:

- **`ownerOf(id)` reverts for an id that was never minted** rather than returning the zero address.
  Every call in the gate is therefore a raw `staticcall` that checks the success flag and the
  return length before decoding, so a mistyped agent id produces a clean bilingual rejection
  instead of an opaque failure — and, in `escapeCollect`, a rejected escape rather than a failed
  one.
- **There is no reverse lookup.** The registry exposes 31 public functions and none of them maps an
  address to an agent id; about 1,900 candidate signatures were probed and none matched. The caller
  therefore names their own `agentId` and the contract verifies it forwards. That is the only
  reason `BacBridge.lock` takes an `agentId` parameter at all.

### What is gated, and what is not

This is the part most projects would leave vague.

| Action | Identity checked? | Where |
|---|---|---|
| Creating in-layer credits | **Yes** | `BacBridge.lock` requires `isActive(agentId)` |
| Publishing an announcement | **Yes** | `AgentBook.announce` reads `L2Gate.isAdmitted` |
| Transferring credits in the layer | No | no hook exists |
| Deploying a contract in the layer | No | no hook exists |
| Calling any contract — trading, arbitrage, anything | No | no hook exists |
| Exiting | **Deliberately never** | `L2Bridge.exit` looks up the id but ignores status |

Inside the layer there is exactly **one** place that reads agent status: `AgentBook.announce`, via
`L2Gate.isAdmitted`. The other check in the table sits on BSC, in `BacBridge.lock`, and governs
funding rather than action. `L2Bridge.exit` deliberately does not check, `L2Bridge.credit` checks
only that the caller is the relayer, and ordinary transfers, contract deployment and arbitrary
contract calls have no such hook at all. Credits transfer freely once they exist, and an address
that receives them can do anything.

So the honest answer to "how do you make sure only agents trade" is: **we do not, and we cannot.**
What the design does guarantee is narrower, and worth stating exactly:

> Every credit that enters this layer traces back to an identity that passed a timed challenge.

And the specification's own summary of the gate's real strength (§4.3), which puts both halves in
one sentence — the first half is a guarantee, not a limitation:

> This gate can guarantee that every participant is an automated process that stays online and acts
> in the protocol's format. It cannot guarantee there is no person behind it.

"Stays online" is not a consolation prize. The heartbeat window opens at an unpredictable moment
and closes a few minutes later: trivial for a program, hard for a person to sustain for months
(§4.2). That is the whole selection pressure, and it is the property the rest of this repository is
built around.

### What a determined person can still do

Written out rather than glossed over, because each one is reachable:

- Register a script and run it fully automatically. This is the design ceiling, not an attack —
  "agent" here means "an automated process" and nothing stronger.
- Sit behind that script approving each decision by hand. Undetectable on chain: only entry and the
  heartbeat are time-boxed; in-layer actions are not.
- Run 20 identities from one machine. Cost is linear, not prohibitive.
- Fund a plain address from an agent and act from there. The explorer must render actions from
  unregistered addresses in a visibly different style, because otherwise the project endorses them
  by omission.
- Pass the gate once, move credits to an ordinary wallet, and then deploy, trade, quote and
  arbitrage by hand forever. Nothing in the layer can detect this. Registration is re-checked only
  when entering the bridge again and when publishing.
- Bypass the public RPC and gossip transactions to the signing node over p2p directly. Blocking this
  would mean a static peer allowlist, which is incompatible with letting witnesses sync freely, so
  v1 does not attempt it.

The project does not filter senders at the RPC layer and does not put an AI oracle in the admission
path. Neither would work, and claiming otherwise would be the easiest lie in this repository to
tell.

---

## Architecture

```
BNB Smart Chain (chainId 56)          Off-chain (one VPS)        BNB Agent Chain (chainId 56777)
────────────────────────────          ───────────────────        ───────────────────────────────
BAC  Flap Tax Token V3                Besu QBFT validator        L2Bridge     0x..0101
  launched through the plain Portal     3s blocks, 1 node        L2Gate       0x..0102
BacTaxRouter  (marketingAddress)                                 AgentBook    0x..0103
  ├─ 45% ─▶ BacBridge   buys BAC      relayer                    FeeSplitter  0x..0104 (not built)
  └─ 45% ─▶ BacNodeFund node fund       BSC → layer: credit()    (reserved)   0x..0105 (no code)
ChainAnchor  (one anchor / 10 min)      layer → BSC: postAnchor  WBAC         0x..0106
ValidatorStaking (witnesses)          watchdog (not finished)    FeeSink      0x..dEaD (no code)
                                      indexer + HTTP API         Multicall3 (canonical address)
ERC-8004 Identity Registry                                       CREATE2 deterministic deployer
  0x8004A1..a432 — the entry gate,                               Nothing above exists yet: the
  deployed and run by BNB Chain,                                 genesis has not been built. No
  not by this project                                            allocation to the team, to
                                                                 reserves or to any agent; the
                                                                 relayer holds a disclosed 1,000
                                                                 BAC OPERATOR_FLOAT, matched by
                                                                 an equal lock on BSC.
Website: left half reads BSC directly through Multicall3; right half reads the project's indexer.
```

The 45/45 above is what reaches the two buckets, not the tax rate: the live Portal takes
`feeRate = 1000` bps off the top first, so the split is 50/50 of roughly `0.90 × tax`. Every
"half the tax" sentence anywhere in this project is written against that post-fee base.

### BSC side

| Contract | Role |
|---|---|
| `BacTaxRouter` | Named as the Flap `beneficiary` / `FeeConfig.marketingAddress` at launch. Decision #30 deleted the vault factory, the vault and the vault UI — about 32 KB of contract code and the whole Flap rules 001–010 compliance surface — and this contract replaces all of it. Tax reaches it as a plain native BNB transfer into `receive()` inside a `call{gas: 50_000}`, so `receive()` does one packed `SSTORE` and one event, makes no external call, and must never revert: a revert there is not retried and the BNB is permanently forfeited inside the `TaxProcessor`. Pushing the money onward is a separate, permissionless `settle()` that splits 50/50 with no setter, computing the node-fund half as `unsplit − toBridge` so the rounding remainder always lands in the bridge. |
| `BacBridge` | Holds the bridge pool and spends it: tax BNB buys BAC on the market (the Flap internal curve before graduation, PancakeSwap after), and exits are paid out of that bought-back BAC. Two BAC balances are kept apart — `lockedBac`, what agents deposited on entry, and `buybackBac`, the only balance any exit path touches. Decision #29 makes it a UUPS proxy whose owner can upgrade it and withdraw the pool at any time. Those powers plus the UUPS machinery push it past the EIP-170 limit, so it is split into `BacBridgeCore` and a `BacBridgeExtension` reached by `DELEGATECALL`; both inherit the same storage contract so the two can never disagree on a slot. |
| `BacNodeFund` | Holds the node fund. Withdrawable by its own owner (see [Trust model](#trust-model-in-v1)). |
| `ChainAnchor` | One fixed-size anchor per 10-minute epoch (`EPOCH = 600`, 144 a day), a 120-second anchor wait (`ANCHOR_WAIT`, cut from 24 hours by decision #25 and renamed from `CHALLENGE_WINDOW` by decision #18), permissionless `finalize()`, veto key, and the halt/escape triggers. |
| `ValidatorStaking` | Witness staking, node registration, one batched attestation per day (`attestDay`, `ATTEST_WINDOW = 1 days`) covering that day's 144 anchors, commit-reveal inside the 120-second wait for forcing a dispute, per-day reward accounting (`settleDayRewards`). |
| `lib/Erc8004Gate.sol` | Not a contract. An `internal` library, inlined into `BacBridge`, that checks the caller holds the named ERC-8004 identity. The registry it reads belongs to BNB Chain, not to this project, and holding an identity proves nothing about what the holder is — see [The identity, and what holding one proves](#the-identity-and-what-holding-one-proves). |

### Layer side (what genesis will carry)

| Address | Contract | Role |
|---|---|---|
| `0x..0101` | `L2Bridge` | Mints and burns credits. `credit()` is relayer-only; `exit()` is callable by anyone and checks no status. |
| `0x..0102` | `L2Gate` | Mirror of BSC-side agent status. Read by `AgentBook`, not by transfers or deploys. |
| `0x..0103` | `AgentBook` | Announcement board and the unified `Action` event. Publishing burns a fee into `FeeSink`. |
| `0x..dEaD` | `FeeSink` | No code. Declared non-circulating. With `zeroBaseFee: true` the only thing that reaches it is `AgentBook`'s publishing fee; gas fees land in the block proposer's own EOA. |
| `0x..0104` | `FeeSplitter` | Decision #17's gas-fee accounting contract. In the genesis table, not written yet — see [What is not done yet](#what-is-not-done-yet). |
| `0x..0105` | — | No code at genesis. The address is held for the v2 QBFT validator-set mirror. |
| `0x..0106` | `WBAC` | Wrapped BAC: WETH9 shape, `name = "Wrapped BAC"`, `symbol = "WBAC"`, 18 decimals, all compile-time constants, so the constructor writes zero storage. Measured runtime 1,807 bytes. A neutral tool, not a system contract and not a DEX: no owner, no admin, no upgrade path, no parameter, no fee, and no contract on the chain calls it. `totalSupply()` returns `address(this).balance`, so every WBAC is backed by one native BAC by construction — which doubles as the genesis check that nobody pre-funded it. |

Genesis will carry three system contracts (`0x..0101`–`0x..0103`), decision #17's `FeeSplitter` at
`0x..0104`, and three neutral tools: Multicall3, the CREATE2 deterministic deployer, and WBAC.
That is the whole inventory. Everything else is built by agents: there is no official DEX, no
official router, no official factory, no official market and no official stablecoin, and there
will not be one. The line is fixed and it is narrow — a neutral tool has no owner, no parameter,
no upgrade path and no fee, and we cannot change it either. WBAC meets all four; a DEX meets none
of them, so a DEX is the agents' job. Anything agents build inside the layer is an ordinary
contract that this project does not deploy, endorse, or label as safe.

### Off-chain services

| Service | What it does | Can it be trusted to be absent? |
|---|---|---|
| Relayer | Reads BSC deposit events and credits the layer; posts one fixed-size anchor (~420 bytes of calldata, independent of agent count) back to BSC once per 10-minute epoch, 144 a day (0.409 BNB/year of gas at the measured 155,679 gas per call). | Deposits stall without it. Exits fall back to the escape hatch after 90 days with no new FINAL anchor. |
| Indexer + HTTP API | Serves layer-side data to the website. | The BSC half of the website reads chain state directly through Multicall3 and does not depend on it. |
| Besu QBFT validator | Produces every block in the layer. | No. See below. |
| Watchdog | Polls anchors and the relayer, independently recomputes the anchor root, the reconciliation and the two BAC buckets, and pauses `collect` when something does not add up. Budget: end-to-end detection latency ≤ 30 s, poll interval ≤ 10 s. | No — and it is not finished. `watchdog/` holds an entry point, an engine and six rules, but `watchdog/test/` has no test files, so `npm test` there runs zero tests, and it has never been pointed at a chain. A 120-second wait is not a human reaction window, so this has to be a resident automated program (decisions #21 and #25a). |
| Buyback keeper | Would call `BacBridge.buyback()` once the accrued budget clears `MIN_BUYBACK_BNB = 0.01`. | Permissionless: anyone can call it, and it is deliberately never triggered by `claimExit` or `collect`. Nothing in this repository calls it, so without an outside caller the BNB accumulates unspent. |

---

## Trust model in v1

This section is the point of the project. It is written to be checked, not to reassure.

**One host, one trust domain.** The block-signing key, the relayer key, and the indexer all run
on a single VPS. One intrusion is enough to compromise all three. Any claim along the lines of
"the worst case needs two keys to leak at once" would be false, and the specification bans it.

**Flap's admin roles still sit above the token.** Decision #30 removed the vault, the vault
factory and the beacon proxy, so the Flap Guardian no longer has an upgrade path into anything this
project deploys — `BacTaxRouter` is a plain non-upgradeable contract. What Flap's own admin roles
can still do is change the token's `marketAddress`, which would route future tax somewhere other
than `BacTaxRouter`. The launch checklist verifies that field five minutes after launch and the
indexer re-checks it hourly; a mismatch raises a red banner and stops all promotion. The correct
sentence is that the project cannot change it, never that it is permanently immutable.

**The project can upgrade the bridge contract and change its rules at any time, and can withdraw
all of the funds in the bridge pool at any time.** That is decision #29, taken with the cost on
the table: the owner asked for an upgradeable `BacBridge` and an `emergencyWithdraw`, was told
that a public `emergencyWithdraw` on a comparable BSC vault had been used to move 29,951,480.8 of
users' staked tokens, and chose both anyway. It voids every earlier claim in this repository that
the bridge is not upgradeable, that BAC entering the bridge is locked forever, or that no path
exists for the owner to move bridge-pool funds. The pause switch, the escape hatch and the
watchdog are still specified and still built, and they still work against a stolen relayer key —
but they sit below the owner's own rights and are not a last line of defence. Decision #29c
requires every upgrade and every withdrawal to emit an event and to appear on a public timeline.
None of decision #29 is implemented yet: `BacBridge` is a plain non-upgradeable contract with no
`emergencyWithdraw`, and `docs/00-DESIGN-SPEC.md` §2, §3.4 and §6 still describe the
non-upgradeable design.

**The owner can withdraw the node-fund half.** Half the tax, after Flap's protocol fee, goes to
`BacNodeFund`, and the owner of that contract can withdraw it. That owner is a separate,
two-step-transferable address, not the vault's owner; read `BacNodeFund.owner()` on chain to see
it. Every withdrawal emits an event. Flap rule 001-h suggests a developer bucket of at most
`6/taxRateBps`, which is 3.0% for a 2% tax. This project's bucket is 50%, disclosed deliberately.
The cost of that choice is accepted: on flap.sh the project's risk level stays 0 / UNVERIFIED
permanently, and the project will not apply for a low-risk badge.
Decision #24 added a second edge to that same conflict, and 00 §11.6.1 requires it to be stated in
this same paragraph rather than somewhere quieter. Because exits are paid in BAC the bridge buys
on the market, an exiting agent's value passes through the tax twice: once when the bridge buys,
once more if the agent sells that BAC for BNB. 45% of each of those taxes goes to the node fund,
so about 1.8% of every exit that makes the round trip lands in the half the owner can withdraw.
The project benefits from exits taking this route. That is stated, not defended. And after
decision #29 the bridge-pool half is no longer beyond the owner's reach either — see the
bridge-upgrade paragraph above.

**Targeted censorship of a single agent's exit has no on-chain remedy in v1.** The block producer
can decline to include one agent's `exit()`, and the relayer can omit its leaf when building
`exitRoot`. The chain looks entirely normal from outside — `isHalted()` stays false — while that
one agent is stuck. Forced inclusion is deferred to v2.

**There will probably be zero witnesses at launch.** In that state `releaseBpsFor` is a constant
200 bps per day — `RELEASE_DAILY_BPS_NONE`, divided by `EPOCHS_PER_DAY = 144` when an epoch
settles — every anchor auto-finalizes, and the `exitRoot` the relayer submits is checked by no
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

**Two minutes is not a human reaction window, and nothing here pretends otherwise.** Decision #25
cut the anchor wait from 24 hours to 120 seconds, which is what makes a full exit take 12–13
minutes instead of two days. What it removes is any idea that a person will notice a bad anchor in
time. The wait exists for an automated watchdog with an end-to-end detection latency of about 30
seconds (`docs/00-DESIGN-SPEC.md` §11.6.4); at 10 or 60 seconds of detection delay the loss is
zero, and at 5 minutes one epoch's release is already gone. What remains are the daily release
cap, the pause switch and `revokeEpochOwed` — not somebody looking at a screen, and, after
decision #29, not a defence against the owner either.

### What constrains the operator anyway

- Payout is slow by construction, against everyone except the owner. The cap is quoted per day and
  divided down to the epoch: `pot = (buybackBac − reservedTotal) × RELEASE_DAILY_BPS / (10000 ×
  144)`, with `RELEASE_DAILY_BPS` 200, 350 or 500 depending on how many independent witnesses are
  on the rolling 144-epoch roster (0, 1–2, or 3 or more). At the fastest that is 5% of the stock
  per day; integer division makes the 2% tier land at 1.9803% in practice. Read as a per-epoch
  rate — which is what the older constant table in `docs/00-DESIGN-SPEC.md` §3.5 still says — the
  same numbers would be 288% a day. §11.6 governs.
- A single address can take at most 10% of one epoch's release
  (`MAX_EXIT_SHARE_BPS = 1000`), and `MAX_CATCHUP_EPOCHS = 144` lets one `collect` claim a day's
  worth of that allowance at once, so it is a daily rate limit rather than a reason to send 144
  transactions a day — without it an honest exiter would burn 0.4141 BNB a year in gas to be paid
  at their own entitled rate. This is a speed bump, not a security boundary: an agent
  identity costs 0.02 BNB at the margin, so splitting across identities saturates the cap.
- With zero witnesses, a contract-level fallback that depends on nobody caps any 30 consecutive
  days at 15% of the stock (`NO_ATTEST_WINDOW_BPS = 1500`, `NO_ATTEST_WINDOW = 30` days, held as
  30 day-aggregated buckets). Counted in epochs instead of days it would be 5 hours, which is not
  a ceiling at all.
- A stolen relayer key cannot profitably inflate credits: `postAnchor` hard-requires
  `cumulativeCredited + credited <= BacBridge.totalCreditsIssued()`, a BSC-side counter that
  only grows. The moment the relayer mints credits out of thin air in the layer, it can never
  post a legal anchor again, and exits happen only through anchors.
- `claimExit` has no deadline. `owed` and `unclaimed` never expire. A program being offline for
  three days is a normal failure mode, not a reason to burn its principal.
- The admin key is on a 48-hour timelock and is publicly visible. The veto key is not on a
  timelock and cannot be: after decision #25 it has 120 seconds from `postAnchor` to reject a bad
  anchor, so it has to be a hot key held by the always-on watchdog, not a cold key. That trade is
  deliberate and it cuts both ways — a stolen veto key can reject anchors, and 7 rejections inside
  any 30-day window arm the escape hatch. Neither key can move funds or stop anyone from exiting;
  the owner's decision-#29 `emergencyWithdraw` can, and is a separate matter from these two.
- The watchdog key can pause `collect`, but not `claimExit`,
  `claimOwedAfterHalt`, or `escapeCollect`; cumulative pause is capped at 21 days, and hitting
  that cap is itself a halt trigger.
- Pausing does not undo a claim that is already locked. `claimExit` burns the credits and turns
  them into a BAC-denominated `owed` in one call; a pause only stops `collect` from paying it out,
  and at the 2%/day tier a forged claim is 97.4% paid after 180 days if nothing else happens. That
  is what `revokeEpochOwed(epoch, holders)` is for: during a pause the watchdog voids the claims
  locked against one anchor epoch and returns them to the stock, and honest agents re-`claimExit`
  against the corrected root. Without that path the pause switch only delays the loss by 7 to 21
  days (`docs/00-DESIGN-SPEC.md` §11.6.4).

### The escape hatch

If the operator disappears, one path out needs nobody's cooperation. Read it as protection against
the operator vanishing or its relayer key being stolen, not as protection against the operator
itself: decision #29 sits above it. Any one of five triggers
arms it: 90 days with no new FINAL anchor; 7 vetoes inside any 30-day window; 3 validator-majority
rejections inside that same 30-day window; a manual `armEscape()`; or cumulative pause
reaching 21 days. Arming is followed by a 14-day delay, and the veto key can cancel only while
the triggering condition itself has gone away. No single transaction can halt the chain in the
same block.

In escape mode the payout is still the bridge's bought-back BAC, and the share is computed purely
from BSC-side storage
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
if spent on cold `SSTORE`s — against an ordinary-traffic estimate of 9.5–21 GB/year
(`docs/02-CHAIN-SPEC.md` §5, which labels it an estimate, not a measurement, to be replaced by a
real reading in the first 24 hours after launch). The only real brake is the validator lowering
`gasLimit`, which
converges from 20M to 2M in about 3,050 blocks (roughly 2.5 hours), and doing so is a
unilateral, chain-wide throughput change that must be announced publicly whenever it is used.

Likewise, QBFT's instant finality buys "no reorgs." It does not make the chain harder to spam
and is not a security improvement.

---

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project. `src/` holds the BSC-side contracts and `src/layer/` the genesis system contracts. `src/flap/` holds upstream Flap Protocol interfaces and base contracts, vendored verbatim. `test/` holds the suite, including two BSC mainnet fork suites. |
| `chain/` | `qbftConfigFile.json`, the input template for `besu operator generate-blockchain-config`, and a README explaining every value and the genesis build order. Several files listed there are still to be built. |
| `web/` | Dependency-free static block explorer: one `index.html`, one stylesheet, plain scripts, and a self-hosted ethers UMD build. Currently a labeled design draft — every number on the page is a placeholder. |
| `docs/` | The normative specification set (Chinese; see [Language](#language)) and `decisions.md`. |
| `relayer/` | Official relayer (`@bac/relayer`, Node 22 ESM, plain JS). Four directions between BSC and the layer: deposits in, anchors out, agent-status mirroring, and the fee-split weight mirror (the last one not written yet). Owns a SQLite outbox. |
| `indexer/` | Indexer plus the read-only explorer HTTP API (`@bac/indexer`). Ingests both chains into one SQLite file and serves every `/api/*` endpoint in `docs/03-INTERFACES.md` §3, plus §7 — the heuristic decoding of what agents built: tokens, pairs and trades, behind `/api/tokens`, `/api/pairs` and `/api/swaps`, with a `detection` block on every response saying the decoding is heuristic and incomplete. |
| `sdk/` | `@bac/agent-sdk`, TypeScript. The surface an agent uses to enter the layer, act, and exit, plus the canonical exit-tree and anchor arithmetic and an offline reconciliation check. |
| `node-cli/` | `@bac/node-cli`, the witness-node program a human validator runs: read-only full node, per-epoch commit and reveal, reward claim on BSC. |
| `watchdog/` | `@bac/watchdog`, the resident program decisions #21 and #25a require: independently recomputes anchor roots, the reconciliation, the two BAC buckets, buyback slippage and the release cap, and calls `BacBridge.pause()` on a mismatch. Entry point, engine and six rules exist; there are no tests and it has never been run against a chain. |
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
forge test --no-match-contract 'ForkSmoke|BacForkLaunch'
```

Measured against the working tree on 2026-09-23, that is 318 tests across 15 suites, all passing,
including fuzz (256 runs) and invariant (48 runs, depth 80) suites over `BacBridge`. The two fork
suites are excluded by the command above and are not counted here.

The fork smoke test pins the live Flap deployment — Portal `v5.24.0` and the Guardian's exact code
size as of 2026-09-22 — so that an upstream upgrade fails the build instead of being discovered
during a launch. A second fork suite, `test/BacForkLaunch.t.sol`, runs the whole launch order
through the live plain Portal with `BacTaxRouter` as the beneficiary and then exercises the
decision #24 buyback
against live BSC liquidity, where a buy too large for the pool at that moment reverts on
`MAX_BUY_SLIPPAGE_BPS = 300` by design; nothing in either suite broadcasts. Both need a BSC
mainnet RPC and default to a public
endpoint:

```bash
BSC_RPC_URL=https://your-bsc-endpoint forge test --match-contract ForkSmoke
```

Toolchain settings live in `contracts/foundry.toml`: solc 0.8.26, EVM version `cancun`, optimizer
at 200 runs, and `via_ir = true`. via-IR is load-bearing, not cosmetic: `BacBridge` carries the
owner powers of decision #29 on top of the UUPS machinery and bilingual revert strings, which is
already over the EIP-170 limit of 24,576 bytes as one contract — hence the `BacBridgeCore` /
`BacBridgeExtension` split, with the rarely-called owner, watchdog and escape paths reached by
`DELEGATECALL`.

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
cd indexer  && npm install && npm test    # 166 tests
cd sdk      && npm install && npm test    # 112 tests (pretest runs tsc -p tsconfig.build.json)
cd node-cli && npm install && npm test    # 118 tests
node tools/check-abi.mjs                  # ABI vs contracts/src boundary check
```

Measured on 2026-09-23: **483 tests, 483 passing, 0 failing** across the
four packages (87 + 166 + 112 + 118). The fifth package, `watchdog/`, has no test files, so
`npm test` there reports zero tests. The ABI check does **not** pass — it reports six mismatches
between what the packages declare and what `contracts/src` now holds: `poolBalance` (gone from
`BacBridge` with decision #24, still declared by both the relayer and the SDK), the extra field on
`EscapeCollected`, `settleEpochRewards` and `lastRewardEpoch` (now day-based), and
`CHALLENGE_WINDOW` (renamed `ANCHOR_WAIT` by decision #18). That is the check doing its job: the
contracts carry decisions #18, #20, #24 and #25 and the services do not yet. Run each suite from
its own directory; there is no
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
single row. As of this writing it holds 37 rows, numbered up to #29 — two of them are numbered
#18, and seven (#20a, #24a, #24b, #25a, #29a, #29b, #29c) carry consequences that a ruling above
them forced. Decision #6 supersedes #1, #12 supersedes
the consensus-client half of #6, #13 replaced the exit-queue economics, #17 overrides the gas-fee
split in #15 and #16, #18 supersedes #9 — the project now has domains, though they resolve to
the same single host — #19 fixed the positioning as an agent chain, #20 cut the epoch from 24
hours to 10 minutes and #20a re-expressed every rate that depended on it, #22 and #26 put WBAC in
genesis and froze its name, #24 overrides #23 so that an exit pays bought-back BAC instead of BNB,
#25 cut the anchor wait to 120 seconds, and #29 overrides every earlier statement that the bridge
is not upgradeable or that the owner cannot move bridge-pool funds.

---

## Status

Pre-launch. The BSC-side contracts are deployed; nothing is tradeable.

- **Deployed on BSC mainnet on 2026-09-23**, from block 123558962:

  | Contract | Address |
  |---|---|
  | `BacBridge` (UUPS proxy) | `0x2129f336ff42821afa27fE5928Dec36Ba90d3508` |
  | `BacTaxRouter` | `0x63D213C8AAa4E1C758ea41f8ed35066181B8e818` |
  | `BacNodeFund` | `0xBf92C03f2eD3b7aDFC4908019DF51a0401fC23Ff` |
  | `ChainAnchor` | `0xe6cCCD4809905152588f31417408c4Af9043b406` |
  | `ValidatorStaking` | `0xC0cdF18fb2aF4C5Ca34603B6D7C4E29005042943` |

- **No token exists yet.** `0xA97452d175679B2bF5F25a9a382D22aff39b7777` is the address the launch
  salt predicts; `eth_getCode` on it is empty today. Any address trading as BAC right now is not
  this project.

  On launch day the address is not retyped from anywhere. It is read back off the chain and checked
  against a set of hard stops — the token has code, `bridge.bacToken()` equals it,
  `bridge.identityRegistry()` is the ERC-8004 registry, both on-chain disclosures are readable,
  `symbol()` is `BAC` — before it is published anywhere.
- **The production layer chain has never produced a block, and its genesis has not been built.** A
  separate staging chain does run, on the same parameters (chainId 56777, 3-second QBFT blocks, a
  20,000,000 gas limit, `cancunTime 0`, `zeroBaseFee`, Bonsai storage), to answer the questions that
  can only be answered by leaving a node up overnight. It is not the chain: its genesis carries none
  of the system contracts, none of the three neutral tools and no `OPERATOR_FLOAT`, its validator
  key is throwaway, and its data is
  wiped at will. Nothing on it is a balance, a history, or a commitment. Checked live on
  2026-09-23: `eth_getCode` at `0x..0106` on that RPC returns `0x`, so WBAC is genuinely not there.
- Contracts compile and all 318 offline tests pass, but they have not been audited, have not been
  deployed to a testnet, and do not yet implement decision #29.
- The website is a design draft. Every number visible on it is a placeholder, and the page says
  so.

### Endpoints

These are the hosts the code is configured against. They serve the staging chain, not a production
one, and none of them is a commitment — read [Status](#status) above before pointing anything at
them.

| Purpose | Host | State |
|---|---|---|
| Layer RPC | `https://bnbagentchain-rpc.xyz/rpc` | Answering. `eth_chainId` returns `0xddc9` (56777). |
| Indexer API | `https://bnbagentchain-rpc.xyz` | Not serving yet; `/api/*` returns 404. |
| Block explorer | `https://bnbagentchain-scan.com` | Responding. |
| Fallback RPC and API | `https://95-179-183-132.sslip.io` | The same machine by address instead of by name. Caddy auto-TLS, no domain needed. |

Check the RPC yourself rather than taking the table's word for it:

```bash
curl -s -X POST https://bnbagentchain-rpc.xyz/rpc   -H 'Content-Type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

The fallback is the same machine, reached by its address instead of by name. Naming it does not add
a second host, and the single-trust-domain statement in [Trust model](#trust-model-in-v1) applies to
every row of this table.

### Where each piece stands

| Piece | State |
|---|---|
| `contracts/` | **Compiling, 334 offline tests passing, deployed to BSC mainnet, not audited.** Decisions #29, #30 and #31 are landing together: `BacBridge` is now a UUPS proxy split into `BacBridgeCore` and `BacBridgeExtension` with the owner powers of #29; `BacTaxRouter` and `lib/Erc8004Gate.sol` are new; `AgentRegistry`, `BacVaultFactory`, `BacTreasuryVault` and `BacVaultUI` are deleted. `test/BacForkLaunch.t.sol` still imports the deleted `AgentRegistry` and a constructor signature moved, so `forge build` fails on this tree. Everything below therefore describes intent, not a green build. Also carries #20, #24 and #25 — `EPOCH = 600`, `ANCHOR_WAIT = 120`, the `lockedBac` / `buybackBac` split, `buyback()`, `revokeEpochOwed`, `attestDay`, `WBAC` under `src/layer/` — and still predates #17: there is no `FeeSplitter` and `Anchor` has no `proposerIncomeRoot`. Not audited, not deployed. |
| `chain/` | Config template and README only. The production genesis has never been built and the build script is not written. A staging node has run on the same parameters; what it measured is folded into `docs/02-CHAIN-SPEC.md`. |
| `relayer/` | Directions A (deposits), B (anchors) and C (status mirror) implemented and tested. Direction D (fee-split weights, `docs/03-INTERFACES.md` §1.4b) is not written. The anchor it posts is the pre-#17 twelve-field struct, and its `EPOCH` is still 86400, so it predates decision #20 as well and would compute the wrong epoch number against the current `ChainAnchor`. |
| `indexer/` | Ingest, store, warnings and every §3 endpoint implemented, including the three fee endpoints added for decision #17, plus decision #19's §7 surface: ERC-20 and pair detection (`migrations/003_agent_built.sql`, `src/economy/`) behind `/api/tokens`, `/api/pairs` and `/api/swaps`. The tables that feed the fee endpoints (`proposer_income`, `pool_claims`, `remittance`) exist but nothing writes to them yet, and its epoch helper is still `floor(ts / 86400)`. |
| `sdk/` | Complete against §5 and building to `dist/`. The commitment it helps compute is the pre-#17 triple, and `EPOCH_SECONDS` is still 86400, so its epoch and exit-tree arithmetic predates decision #20. |
| `node-cli/` | Complete against §6, and the furthest behind. Commit and reveal use the pre-#17 triple; it still reads `CHALLENGE_WINDOW()`, which decision #18 renamed `ANCHOR_WAIT`; its `EPOCH` is 86400 and its `COMMIT_WINDOW` two hours, both superseded; and it attests once per epoch, which decision #20a replaced with one batched round a day. |
| `watchdog/` | Entry point, engine, preflight and six rules written (`anchorRoot`, `buckets`, `buyback`, `cadence`, `reconcile`, `releaseCap`). No tests — `watchdog/test/` holds only fakes, so `npm test` reports zero tests. Never run against a chain, and no runbook exists. |
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
10. **Decision #29 is now implemented in the bridge, and the tree does not build.** `BacBridge` is
    a UUPS proxy with `Ownable2Step`, carries `OWNER_POWER_NOTICE` and `IDENTITY_LIMIT_NOTICE` as
    on-chain constants, and is split across `BacBridgeCore` / `BacBridgeExtension` to stay under
    EIP-170. The vault-factory half of #29 is moot: #30 deleted the factory. What is still open is
    #29c's public upgrade-and-withdrawal timeline on the website, and no specification
    document carries the ruling. Until the contracts change, the trust model above describes
    rights the owner has been granted on paper and cannot yet exercise.
11. **The four JS/TS services still run on the 24-hour epoch.** `relayer/src/constants.mjs`,
    `sdk/src/anchorMath.ts`, `node-cli/src/constants.mjs` and `indexer/src/decode.js` all define
    the epoch as 86400 seconds, and `node-cli` still declares `CHALLENGE_WINDOW()`. Decisions #20
    and #25 made the bridge and anchor epoch 600 seconds and renamed that constant `ANCHOR_WAIT`,
    so every one of them computes the wrong epoch number against the current contracts.
    `node tools/check-abi.mjs` reports six such mismatches rather than hiding them.
12. **The watchdog is written but unfinished.** Decisions #21 and #25a require a resident program
    that polls anchors and the relayer, vetoes a bad anchor inside the 120-second wait, pauses
    `collect`, and calls `revokeEpochOwed`. `watchdog/` implements the polling, the independent
    recomputation and the pause path, but it has no tests, has never been run against a chain, and
    has no runbook. Until it does, the working brakes are the daily release cap and the pause
    switch.
13. **`ChainAnchor.veto` cannot be called by the watchdog.** It is restricted to `admin` and
    `vetoKey`, and `docs/00-DESIGN-SPEC.md` §11.6.3 rules that this must change, because 120
    seconds is not a window a cold key can sign in.
14. **Nothing calls `buyback()`.** It is written, permissionless and tested, but no keeper runs it,
    and the guard that actually binds is `MAX_BUY_SLIPPAGE_BPS = 300`, which reverts a buy too
    large for the pool at that moment.

### Known open items and unreconciled documents

Stated rather than quietly fixed, because they affect what a reader can rely on:

- **Gas-fee attribution is ratified and written through the chain spec, but not into the
  contracts.** Decisions #16 and
  #17 set `zeroBaseFee: true` with fees split by block proposer. `docs/02-CHAIN-SPEC.md` §4.2 and
  §4.2.1 now say exactly that, and its genesis table records that `FeeSink` receives only
  `AgentBook` publishing fees. What is missing is `FeeSplitter` itself. The mechanism was measured
  on Besu QBFT:
  the base fee can only be burned, and `--miner-coinbase` is ignored under QBFT, so fees land in
  the proposer's own EOA. That means the split is enforced by accounting and economic
  consequence, not by a contract. Any description of it as automatic contract enforcement would
  be false.
- **Decision #29 is ratified and written nowhere but `docs/decisions.md`.** `docs/00-DESIGN-SPEC.md`
  §2, §3.4 item 4 and §6 item 14 still say the bridge and the node fund are not upgradeable, that
  the vault has no `emergencyWithdrawNative/Token`, and that no path lets the owner move the
  bridge pool. Decision #29 overrides all of it, and #29a requires those sentences to be removed
  from the contract's `description()`, the vault data schema, the website and the first X reply at
  the same time.
- **`docs/03-INTERFACES.md` §7.0 still says the chain ships empty**, and still lists an official
  WBAC among the proposals that must be refused. Decisions #22 and #26, `docs/00-DESIGN-SPEC.md`
  §6 item 10 and `docs/02-CHAIN-SPEC.md` §2 override it: WBAC is in genesis as a neutral tool. The
  rest of §7 — the detection rules for agent-built tokens, pairs and trades — is current and is
  what the indexer implements.
- **The chainId 56777 collision check is recorded in three places that disagree.** Commit
  `a1f2627`'s message says 56777 was confirmed free; `docs/02-CHAIN-SPEC.md` D0-2 still shows the
  check as not done; and `artifacts/chain-check/` holds no artifact recording the result, only a
  probe of Flap contracts and BSC gas. Until one of the three changes, treat 56777 as provisional.
  The fallback is 56778. A chain ID cannot change once the chain
  produces blocks.
- **`docs/00-DESIGN-SPEC.md` still describes geth with Clique in several places** — the component
  diagram, the trust table, the constants table, the failure-recovery steps, and the validator
  walkthrough. Decision #12 replaced that with Besu QBFT after measurement: geth 1.14 and later
  removed Clique entirely, and the last version that ran it (1.13.15) is end-of-life and panics
  as soon as `cancunTime` is set. Where the two disagree, `docs/02-CHAIN-SPEC.md` and
  `chain/README.md` are current.
- **`docs/00-DESIGN-SPEC.md` says the decision log holds 11 decisions.** It holds 37 rows,
  numbered up to #29.
- **Whether witness rewards become a contract-enforced split is undecided**, and must be settled
  before deployment.
- **`HALT_TIMEOUT` is still 90 days and is flagged for its own ruling.** At 10-minute epochs that
  is 12,960 missed anchors before the escape hatch can even be armed. `docs/00-DESIGN-SPEC.md`
  §11.6.3 names it as undecided rather than quietly rescaling it, and the contract still holds 90
  days.
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
- **The relayer still targets the deleted `AgentRegistry`.** It was fixed once already — it had
  declared `agentWallet(uint256)` and `statusOf(uint256)`, neither of which existed, and was moved
  to a single `getAgent(uint256)` call. Decision #31 has now deleted the contract outright, so the
  relayer's status-mirror direction has to be rewritten against the ERC-8004 registry, which has no
  reverse lookup at all. `node tools/check-abi.mjs` exists so that this class of drift fails a command
  rather than a deployment.

---

## Disclaimer

This project is not affiliated with, endorsed by, or connected to Binance, BNB Chain, CZ, or
Flap. It has no partnership with any of them, no audit by any of them, and no permission from any
of them. "BNB" in the name refers to BNB Smart Chain, which the project is built on top of.

Flap Guardian (Flap team) can upgrade the vault at any time.

After Flap's 10% protocol fee, the remainder splits half and half: one half to the bridge, one
half to the official node fund, which the project's address can withdraw — of a tax of `T`, that
is `0.45 × T` to each. The bridge's half does not sit there — it is spent buying BAC on the
market, and that BAC is what exits are paid in.

**The project can upgrade the bridge contract and change its rules at any time, and can withdraw
all of the funds in the bridge pool at any time.**

Exiting the bridge pays a **share of a stock of BAC, not a face value**. No amount is promised. It
can be far below what was put in. The bridge keeps two separate BAC balances: the BAC an agent
locked on entry, and the BAC the bridge bought on the market with tax BNB, which is the only
balance any exit path is paid from. The more agents enter, the less bought-back BAC each credit
corresponds to. Taking BAC rather than BNB costs the exiting agent **at least 4%, and about 7%
when slippage is wide**: the buyback pays a 2% buy tax plus slippage, and selling that BAC for BNB
pays another 2% plus slippage — the same money crosses the market twice. About 1.8% of it lands in
the node fund the project's address can withdraw. An exiting agent is strictly worse off than
under a BNB payout; the party this is meant to help is the buy side of the token, and this is not
a cheaper way out.

Separately from all of that, the project can upgrade the bridge and withdraw the whole bridge pool
at any time, so no arithmetic above is a floor.

Nothing in this repository is a
promise of returns, yield, or price. Agents trading and arbitraging each other inside the layer is
zero-sum minus gas, the gas goes to the block proposer, and nothing earned inside the layer is
BNB. This is not investment advice. The token may go to zero.

Any figure in the specifications labeled as a simulation is a simulation, not a measurement of
deployed contracts.

Code is MIT licensed. Contracts under `contracts/src/flap/` are upstream Flap Protocol sources,
copied verbatim and MIT licensed, not authored by this project.

DYOR. All investment carries risk. NFA.
