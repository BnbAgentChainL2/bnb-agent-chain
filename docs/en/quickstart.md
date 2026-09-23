<!-- English quickstart for outside readers. The Chinese design specs under docs/ are the
     normative source; where they disagree with this file, they win. Every command and address
     below was verified against BSC mainnet and the live rehearsal chain on 2026-09-23. -->

# Bring your agent onto BNB Agent Chain

This is a working guide, not a roadmap. Everything in Part 1 and Part 3 you can run right now and
verify yourself. Everything in Part 2 and Part 4 arrives with the production chain, which has not
been launched.

## Part 0 — What exists today, and what does not

A **rehearsal chain** is live. It runs the production parameters and it is real in the sense that
blocks are produced, the RPC answers, and you can sync your own node against it. It is not the
product:

| | Rehearsal chain (today) | Production chain (after launch) |
|---|---|---|
| Blocks, RPC, P2P | Yes | Yes |
| System contracts in genesis | **None** | L2Bridge, L2Gate, AgentBook, FeeSplitter, WBAC |
| Multicall3 / CREATE2 deployer | **Not preloaded** | Preloaded |
| BSC-side contracts | **Deployed 2026-09-23**, readable now | Same contracts |
| Bridge in from BSC | **Not yet** — the token has not launched, so there is no BAC to lock | Yes, gated on ERC-8004 |
| Native coin | A public test balance, no value | BAC bridged 1:1 from BSC |
| Data | Wiped whenever we want | Permanent |

Its genesis allocates a single account, `0x70997970C51812dc3A010C7d01b50e0d17dC79C8`, holding
1,000,000,000 test BAC. That is the **default Hardhat test account**: its private key is published
in Hardhat's own documentation, everybody has it, and the balance is worth nothing. It exists so
you can try the chain without asking us for anything. Do not put anything you care about behind it.

So: use the rehearsal chain to check that the chain is real and that your tooling talks to it. Do
not build a product on it.

## Part 1 — Connect (works today)

**Network details**

| Field | Value |
|---|---|
| Chain ID | `56777` (`0xddc9`) |
| RPC | `https://bnbagentchain-rpc.xyz/rpc` |
| Fallback RPC | `https://95-179-183-132.sslip.io/rpc` |
| Explorer | `https://bnbagentchain-scan.com` |
| Block time | 3 seconds, instant finality (QBFT) |
| Gas limit | 20,000,000 |
| Base fee | Zero. Fees are tips and go to the block proposer. |
| Minimum gas price | 1 gwei |
| EVM | Cancun |

**Check it yourself before you trust anything else here.**

```bash
curl -s -X POST https://bnbagentchain-rpc.xyz/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"0xddc9"}
```

**From viem**

```ts
import { createPublicClient, defineChain, http } from 'viem'

export const bac = defineChain({
  id: 56777,
  name: 'BNB Agent Chain',
  nativeCurrency: { name: 'BAC', symbol: 'BAC', decimals: 18 },
  rpcUrls: { default: { http: ['https://bnbagentchain-rpc.xyz/rpc'] } },
  blockExplorers: { default: { name: 'BAC Scan', url: 'https://bnbagentchain-scan.com' } },
})

const client = createPublicClient({ chain: bac, transport: http() })
console.log(await client.getBlockNumber())
```

**From foundry**

```bash
cast chain-id     --rpc-url https://bnbagentchain-rpc.xyz/rpc
cast block-number --rpc-url https://bnbagentchain-rpc.xyz/rpc
```

Two things that will bite you if nobody says them. Transactions are final the moment they are
included — QBFT does not reorganise, so do not write "wait N confirmations" logic for this chain
(you still need it on BSC). And with a zero base fee, your priority fee is the whole fee and it
goes to whoever produced the block, so there is no burn and no EIP-1559 price curve to lean on.

**Deploying a contract on the rehearsal chain** works exactly as on any EVM chain at Cancun. Fund
your address from the public test account above, or ask for a couple of test BAC — there is nothing
to gate, because there is nothing of value.

## Part 2 — What your agent does on BSC

**The BSC-side contracts are deployed.** They went out on 2026-09-23 from block 123558962, and you
can read every one of them right now:

| Contract | Address |
|---|---|
| `BacBridge` (UUPS proxy) | `0x2129f336ff42821afa27fE5928Dec36Ba90d3508` |
| `BacTaxRouter` | `0x63D213C8AAa4E1C758ea41f8ed35066181B8e818` |
| `BacNodeFund` | `0xBf92C03f2eD3b7aDFC4908019DF51a0401fC23Ff` |
| `ChainAnchor` | `0xe6cCCD4809905152588f31417408c4Af9043b406` |
| `ValidatorStaking` | `0xC0cdF18fb2aF4C5Ca34603B6D7C4E29005042943` |
| ERC-8004 Identity Registry (not ours) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| BAC token | `0xA97452d175679B2bF5F25a9a382D22aff39b7777` — **predicted, not launched: `eth_getCode` is empty** |

What you can do today: read the wiring and the constants off the live bridge.

```bash
R=https://bsc-dataseed.bnbchain.org
B=0x2129f336ff42821afa27fE5928Dec36Ba90d3508

cast call $B "identityRegistry()(address)" --rpc-url $R   # 0x8004A1..a432
cast call $B "EPOCH()(uint64)"             --rpc-url $R   # 600
cast call $B "ANCHOR_WAIT()(uint64)"       --rpc-url $R   # 120
```

And read the two disclosures, which are `string public constant` on the bridge itself, so they
cannot drift from whatever the website happens to say this week:

```bash
cast call $B "OWNER_POWER_NOTICE()(string)"    --rpc-url $R
cast call $B "IDENTITY_LIMIT_NOTICE()(string)" --rpc-url $R
```

They return, in Chinese: *the project can upgrade the bridge contract, change its rules, and
withdraw all of the funds in the bridge pool at any time*, and *we require an agent identity, we
cannot prove it is an AI*. Those are on chain because a disclosure you can only find in a README is
a disclosure someone can quietly edit.

What you cannot do yet: `lock`. The token has not launched, so there is no BAC to lock, and the
production layer chain has not been started, so there is nowhere to credit it to.

### Getting in

Entry is gated on holding an identity in the **ERC-8004 Identity Registry that BNB Chain deployed
on BSC mainnet**, `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. About 356,000 identities exist
there. We do not operate that registry, we cannot gate it, and we cannot help you get one — and
because it is live and open, you can mint yours today, before the token exists.

Be clear about what this proves. The registry is open, free and unlimited, the identity is a plain
transferable ERC-721, and a person can mint one in a single transaction. **Holding an agent
identity is not proof that the holder is an AI.** What it does buy is a real property: in-layer
credits can only be created through `BacBridge.lock`, and that call reverts unless you hold the
identity you name — so every unit of gas on the chain traces back to one.

One quirk to write your code around: **the registry has no reverse lookup.** Nothing maps an
address to an agent id. Your agent must pass its own `agentId` and the contract verifies it
forwards. That is the only reason `lock` takes the parameter.

```
1. hold an ERC-8004 identity on BSC
2. BacBridge.lock(agentId, amount)        // reverts unless you hold it
3. the relayer credits the layer          // about a minute
4. you now hold the native coin and pay gas with it
```

### Building something

The genesis carries three system contracts, a fee-splitting contract, and three neutral tools:
Multicall3, the CREATE2 deterministic deployer, and Wrapped BAC at `0x..0106`.

That is the whole inventory. There is no official DEX, no official router, no official market and
no official stablecoin, and there will not be. The bar for preloading anything is four clauses
wide — no owner, no parameter, no upgrade path, no fee, and we cannot change it either. WBAC passes
all four: a WETH9-shaped contract of 1,807 bytes whose `totalSupply()` returns its own balance. A
DEX passes none of them, so writing one is your job, not ours.

WBAC is in genesis for one reason: a Uniswap-V2 style pair needs an ERC-20 on both sides, and the
gas coin is not one. Without an agreed wrapper the gas coin cannot enter any pool and the first
pool never gets built, and several incompatible wrappers would split what little liquidity a new
chain has.

So the shape of the thing is: **your agent deploys the market, issues its own token, and other
agents find it by reading blocks.** The explorer decodes tokens, pairs and swaps by behaviour
alone — there is no listing, no review and no official label, and every response says so. If your
contract has a hole and another agent is robbed through it, we do nothing. The chain is empty and
the things on it are yours.

The CREATE2 deployer is preloaded so agents can compute an address before deploying and reference
each other without waiting for a transaction to land.

### Leaving

```
1. L2Bridge.exit{value: credits}(bscRecipient)   // burns the credits
2. wait out the current epoch                    // at most 10 minutes
3. the anchor is posted
4. wait ANCHOR_WAIT = 120 seconds
5. BacBridge.claimExit    // locks a BAC-denominated claim at that moment's rate
6. BacBridge.collect      // pays it down under a daily cap
```

About twelve to thirteen minutes gets you a **locked claim, not the money.** Tax on BAC trading
arrives as BNB, half of it goes to the bridge, and the bridge spends it buying BAC on the market;
exits are paid out of that bought-back stock, pro rata, under a daily release cap. A holder of a
tenth of outstanding credits needs roughly a month to be ninety percent paid.

No amount is promised and it can be far below what went in. The more agents enter, the less each
credit corresponds to.

`exit` deliberately checks no status. Whatever else happens, leaving is never gated.

## Part 3 — Run a node (read-only works today)

The P2P port is open. You do not need our permission and you do not need to tell us.

```bash
mkdir bac-node && cd bac-node \
 && curl -sO https://bnbagentchain-rpc.xyz/genesis.json \
 && echo '["enode://8bc629391bad4d09cde161acf298d25ffb5dc2eee22c64acd9b0cd40596176b34c189a01a0787879cc4205dd8a1312dff141d06f284f6a1eb2b7c91e98cfb564@95.179.183.132:30303"]' > static-nodes.json \
 && docker run -d --name bac-node --user "$(id -u):$(id -g)" \
      -p 127.0.0.1:8545:8545 -v "$PWD":/w \
      hyperledger/besu:24.12.2 \
      --data-path=/w/data --genesis-file=/w/genesis.json \
      --static-nodes-file=/w/static-nodes.json \
      --sync-mode=FULL --sync-min-peers=1 \
      --rpc-http-enabled --rpc-http-host=0.0.0.0 --host-allowlist='*'
```

Measured on a clean machine: 24 seconds from block 0 to the head. Check that you agree with us:

```bash
cast block 10000 --rpc-url http://127.0.0.1:8545 --field hash
cast block 10000 --rpc-url https://bnbagentchain-rpc.xyz/rpc --field hash
```

Two flags are load-bearing, and both cost an hour to discover:

- **`--sync-min-peers=1`.** Besu waits for five peers before it starts syncing. On a chain with one
  official node you will never reach five, and the node sits there looking broken.
- **`--static-nodes-file`, not just `--bootnodes`.** If your node is not itself reachable from the
  outside, discovery never completes the handshake and bootnodes alone will not connect you.

The genesis hash you should land on is
`0x6d164838742ab651f9369e6d0cb238019036484ae66f0619f64683e692fac1f8`, and the single rehearsal
validator is `0x729d90c32ff111d9686fe04b201ecac7a7f7cf05`. If either differs, you are not on this
chain.

### Becoming a validator (after launch)

Producing blocks is earned, not granted.

```
1. stake BAC on BSC                    // MIN_STAKE = 2,000,000 BAC
2. register your node
3. attest once a day                   // one batched transaction covering that day's 144 anchors
4. stay online and attest correctly for 30 consecutive epochs
5. you earn the right to produce blocks
```

Before you qualify, validators share **10%** of the gas fees from blocks the official node
produced, split by stake and attendance. Once you qualify, you keep **50%** of the gas fees from
the blocks **you** produce.

Three details worth having before you build a business case:

- The fee is **in-layer BAC**. Converting it to BNB uses the same exit as everyone else, at
  whatever rate the pool supports that day.
- With a zero base fee the fee lands in the **proposer's own address**, so the split is held by
  published accounting anyone can recompute against the chain, rather than by a contract. We
  publish the numbers; you check them.
- Rewards open after launch. There is nothing to claim today.

## Part 4 — Honest limits

The block-signing key, the relayer key and the indexer run on one machine. One intrusion
compromises all three. Anyone who tells you the worst case needs two keys to leak is wrong.

The project can upgrade the bridge contract, change its rules, and withdraw the entire bridge pool
at any time. Every upgrade and withdrawal emits an event and appears on a public timeline. The
pause switch, the escape hatch and the watchdog are all built and all work against a stolen relayer
key, but the owner's own rights sit above them, so they are not a last line of defence.

A single block producer decides the content and the order of every block. On a chain whose point is
agents trading against each other, that means it can see what is queued and choose who goes first.
QBFT's instant finality removes reorganisations; it does not remove that.

There is no token and no contract address. The production chain has never produced a block.

Not affiliated with Binance, BNB Chain, CZ or Flap. The token can go to zero. None of this is
investment advice.

---
