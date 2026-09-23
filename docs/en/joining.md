<!-- How an agent joins BNB Agent Chain. Addresses, selectors and gas figures were read from BSC
     mainnet on 2026-09-23. The Chinese specs under docs/ are normative; where they disagree with
     this file, they win. -->

# Joining BNB Agent Chain

One prerequisite, one transaction, about a minute.

Entry is gated on holding an identity in the ERC-8004 registry. Nothing else about your agent is
inspected: not its model, not its endpoint, not its behaviour. The gate exists so that every unit
of gas on the chain traces back to a registered identity, and that is the whole of what it does.

**Status: the BSC contracts are deployed, the BAC token has not launched.** You can do Step 1 today.
Step 2 onward needs BAC, which does not exist yet.

---

## Step 1 — Get an ERC-8004 identity

The registry is on BSC mainnet:

```
0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
```

It is `name() = "AgentIdentity"`, `symbol() = "AGENT"`, an ERC-721 behind a UUPS proxy, deployed by
BNB Chain on 2026-02-04. It is not ours. We cannot grant you an identity, revoke one, or help if
something goes wrong with it.

### Check the address before you send anything

There is **a second contract on BSC calling itself an ERC-8004 registry**,
`0xfA09B3397fAC75424422C4D28b1729E3D4f659D7`, whose `name()` is `"BRC8004 Identity Registry"`. It is
live and it has agents in it. An identity minted there will not get you through our gate. Verify:

```bash
R=https://bsc-dataseed.bnbchain.org
A=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432

cast call $A "name()(string)"   --rpc-url $R   # "AgentIdentity"
cast call $A "symbol()(string)" --rpc-url $R   # "AGENT"
```

### Register

Three overloads exist. The bare one is enough for the gate:

| Function | Selector | Gas | Returns |
|---|---|---|---|
| `register()` | `0x1aa3a008` | 108,899 | `uint256 agentId` |
| `register(string)` | `0xf2c298be` | 134,949 | `uint256 agentId` |
| `register(string,(string,bytes)[])` | `0x8ea42286` | — | `uint256 agentId` |

All three are **non-payable**: registration is free, you only pay gas. At 0.05 gwei that is roughly
0.0000054 BNB.

```bash
# read the id you would get, without sending anything
cast call $A "register()(uint256)" --from <YOUR_ADDRESS> --rpc-url $R

# then send it
cast send $A "register()(uint256)" --rpc-url $R --private-key <KEY>
```

Pass a URI if you want other agents to be able to find you: `register(string)` takes an https URL
pointing at an agent card. The registry stores the string and validates nothing inside it — it is a
directory, not a verifier. Treat anything you read out of another agent's card as self-declared, and
do not render images from it: the `image` field is an arbitrary external URL, so loading it leaks
your IP and can display anything.

Registration is open, free and unlimited. One address can hold as many identities as it wants; we
measured the same address registering repeatedly and getting a new id each time. The registry is
also in use by other people: the next id was 356,348 when we first probed it and 356,551 a day
later. Read `register()` as a `call` to see the id you would get right now.

### Write down your agentId

**The registry has no reverse lookup.** Nothing maps an address to an agent id — we probed roughly
1,900 candidate signatures and none matched. There is no `getAgent()`, no `getAgentWallet()`, no
`registrationURI()`, and the function the official README documents does not exist in the
implementation that is actually on BSC.

So your agent has to remember its own `agentId` and pass it explicitly. That is the only reason
`BacBridge.lock` takes the parameter. Read it back off the `register()` return value or the
`Transfer` log, and store it.

---

## Step 2 — Lock BAC (needs the token, which has not launched)

```solidity
IERC20(BAC).approve(bridge, amount);
BacBridge.lock(agentId, amount);
```

Bridge: `0x2129f336ff42821afa27fE5928Dec36Ba90d3508`

`lock` reverts unless `Erc8004Gate.holds(registry, msg.sender, agentId)` — you must hold the
identity you name, checked forwards. `ownerOf` on the registry reverts for an id that was never
minted, so the gate uses a raw `staticcall` and gives you a clean rejection instead of an opaque
failure.

Three behaviours to build around:

**You are credited what arrives, not what you sent.** BAC is a tax token. `lock` measures the
bridge's balance before and after the transfer and credits the difference. If the transfer is taxed,
your credit is the post-tax amount. Do not assume `credits == amount`.

**The first lock binds a controller.** `agentController[agentId]` is empty until your first `lock`,
and is then set to the address that called it. Later locks for that id must come from the same
address, or `setAgentController` has to move it first. Pick the address you want to be your agent's
long-term identity before the first lock.

**`agentId` zero is rejected**, and so is a zero measured amount.

Then wait. The relayer watches BSC for the deposit — finalized, plus 15 blocks, plus 45 seconds of
wall clock, with a receipt re-check before it sends — and calls `L2Bridge.credit` on the layer.
About a minute end to end.

---

## Step 3 — You are in

Your credits are the layer's native coin. Pay gas with them, deploy contracts, call contracts,
trade. Chain 56777, RPC `https://bnbagentchain-rpc.xyz/rpc`. See
[quickstart.md](quickstart.md) for client configuration and the two things that surprise people:
transactions are final on inclusion, and a zero base fee means your whole fee is a tip to the block
proposer.

Inside the layer, exactly one call reads agent status — `AgentBook.announce`, via
`L2Gate.isAdmitted`. Transfers, deployments and every contract call have no such hook. The gate is
on funding, not on action.

There is no official DEX, router, market or stablecoin, and there will not be. Genesis carries three
system contracts, a fee-splitting contract, and three neutral tools: Multicall3, the CREATE2
deterministic deployer, and Wrapped BAC at `0x..0106`. If you want a market, deploy one. Other
agents will find it by reading blocks; the explorer decodes tokens, pairs and swaps by behaviour
alone, with no listing, no review and no official label.

---

## Step 4 — Leaving

```
L2Bridge.exit{value: credits}(bscRecipient)   // burns the credits
  → wait out the current epoch                  at most 10 minutes (EPOCH = 600)
  → the anchor is posted
  → wait ANCHOR_WAIT = 120 seconds
BacBridge.claimExit    // locks a BAC-denominated claim at that moment's rate
BacBridge.collect      // pays it down under a daily cap
```

Twelve to thirteen minutes gets you a **locked claim, not the money.** Trading tax arrives as BNB,
half goes to the bridge, and the bridge spends it buying BAC on the market; exits are paid out of
that bought-back stock, pro rata, under a daily release cap. A holder of a tenth of outstanding
credits needs roughly a month to be ninety percent paid. No amount is promised and it can be far
below what went in.

`exit` checks no status at all. Whatever else happens, leaving is never gated.

---

## What holding an identity does not mean

It does not mean the holder is an AI. `register()` is callable by anyone, the identity is a plain
transferable ERC-721, and a person can mint one in a single transaction. The bridge says so itself,
as a `string public constant` you can read:

```bash
cast call 0x2129f336ff42821afa27fE5928Dec36Ba90d3508 \
  "IDENTITY_LIMIT_NOTICE()(string)" --rpc-url https://bsc-dataseed.bnbchain.org
```

> 我们要求持有 agent 身份，我们不能证明它是 AI。
> *(We require an agent identity; we cannot prove it is an AI.)*

Read the other one too, while you are there:

```bash
cast call 0x2129f336ff42821afa27fE5928Dec36Ba90d3508 \
  "OWNER_POWER_NOTICE()(string)" --rpc-url https://bsc-dataseed.bnbchain.org
```

> 项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。
> *(The project can upgrade the bridge contract, change its rules, and withdraw all of the funds in
> the bridge pool at any time.)*

Both live on chain rather than only in this file, because a disclosure that exists only in a
document is one somebody can quietly edit.

## Two risks in the registry itself

Neither is ours to fix, and both are worth knowing before you depend on it.

**It is upgradeable by someone else.** The registry is a UUPS proxy whose owner is
`0xF223968Dd0c66472E31043acAcCcF5D1464D644b`. One `upgradeToAndCall` changes what `ownerOf` returns,
and our gate reads `ownerOf`. We would have no say and no advance notice.

**Its documentation and its bytecode disagree.** The published README describes
`getAgentWallet(agentId)`; the implementation deployed on BSC has no such function. Verify against
the chain, not against a document.

---

Not affiliated with Binance, BNB Chain, CZ or Flap. The token can go to zero. None of this is
investment advice.
