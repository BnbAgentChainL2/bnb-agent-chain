# 06 · 教程文章：接入、开发、跑节点（EN / 中文）

写于 2026-09-23。所有命令与数值均在写作当天对 `https://bnbagentchain-rpc.xyz` 实测过。

**发布前必读**：这篇里每一条命令读者都会照抄。演练链的创世 `alloc` 里**只有一个测试账户，没有任何系统合约**——L2Bridge、WBAC、Multicall3、CREATE2 部署器都不在上面。所以全文必须分「今天能做的」和「发射后才有的」两轨，混写会让照做的人撞墙并在评论区拆穿。

---

## English

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

## 中文

# 把你的 agent 接进 BNB Agent Chain

这是一份能照着跑的指南，不是路线图。第 1 部分和第 3 部分现在就能执行并自己验证；第 2 部分和第 4
部分要等正式链，而正式链还没发射。

## 第 0 部分 — 今天有什么，没有什么

一条**演练链**正在运行。它跑的是正式参数，而且是真的：在出块、RPC 能应答、你能自己同步一个节点。
但它不是产品：

| | 演练链（今天） | 正式链（发射后） |
|---|---|---|
| 出块、RPC、P2P | 有 | 有 |
| 创世里的系统合约 | **一个都没有** | L2Bridge、L2Gate、AgentBook、FeeSplitter、WBAC |
| Multicall3 / CREATE2 部署器 | **未预置** | 已预置 |
| BSC 侧合约 | **2026-09-23 已部署**，现在就能读 | 同一批合约 |
| 从 BSC 进桥 | **还不能**——代币未发射，没有 BAC 可锁 | 能，凭 ERC-8004 身份 |
| 原生币 | 一个公开测试余额，没有价值 | 从 BSC 1:1 桥进来的 BAC |
| 数据 | 我们想清就清 | 永久 |

它的创世只分配了一个账户 `0x70997970C51812dc3A010C7d01b50e0d17dC79C8`，余额 10 亿测试 BAC。
那是 **Hardhat 的默认测试账户**：私钥印在 Hardhat 自己的文档里，人手一份，余额一文不值。它存在的
意义是让你不用找我们要任何东西就能试这条链。**别在它后面放任何你在乎的东西。**

所以：用演练链确认「这条链是真的」和「我的工具能连上」。**不要在它上面建产品。**

## 第 1 部分 — 连接（今天就能做）

**网络参数**

| 字段 | 值 |
|---|---|
| Chain ID | `56777`（`0xddc9`） |
| RPC | `https://bnbagentchain-rpc.xyz/rpc` |
| 备用 RPC | `https://95-179-183-132.sslip.io/rpc` |
| 浏览器 | `https://bnbagentchain-scan.com` |
| 出块 | 3 秒一块，即时最终性（QBFT） |
| Gas 上限 | 20,000,000 |
| Base fee | 零。费用以 tips 形式全额进出块者地址。 |
| 最低 gas price | 1 gwei |
| EVM | Cancun |

**在信这里的任何别的东西之前，先自己验一下。**

```bash
curl -s -X POST https://bnbagentchain-rpc.xyz/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"0xddc9"}
```

**viem**

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

**foundry**

```bash
cast chain-id     --rpc-url https://bnbagentchain-rpc.xyz/rpc
cast block-number --rpc-url https://bnbagentchain-rpc.xyz/rpc
```

两件没人说就会坑到你的事。**交易上块即最终**——QBFT 不会重组，所以不要给这条链写「等 N 个确认」的
逻辑（BSC 那边照旧要等）。以及 base fee 为零，你付的优先费就是全部费用，而且**全部进出块者的地址**，
没有销毁，也没有 EIP-1559 的涨价曲线可以依赖。

**在演练链上部署合约**和任何 Cancun 级别的 EVM 链一模一样。从上面那个公开测试账户给自己的地址打点
币即可——没有什么需要门禁，因为上面没有任何有价值的东西。

## 第 2 部分 — 你的 agent 在 BSC 上做什么

**BSC 侧合约已经部署。** 2026-09-23 从区块 123558962 起陆续上链，每一个现在都能读：

| 合约 | 地址 |
|---|---|
| `BacBridge`（UUPS 代理） | `0x2129f336ff42821afa27fE5928Dec36Ba90d3508` |
| `BacTaxRouter` | `0x63D213C8AAa4E1C758ea41f8ed35066181B8e818` |
| `BacNodeFund` | `0xBf92C03f2eD3b7aDFC4908019DF51a0401fC23Ff` |
| `ChainAnchor` | `0xe6cCCD4809905152588f31417408c4Af9043b406` |
| `ValidatorStaking` | `0xC0cdF18fb2aF4C5Ca34603B6D7C4E29005042943` |
| ERC-8004 Identity Registry（不是我们的） | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| BAC 代币 | `0xA97452d175679B2bF5F25a9a382D22aff39b7777` —— **预测地址，尚未发射：`eth_getCode` 是空的** |

今天能做的：把接线和常量从链上读出来。

```bash
R=https://bsc-dataseed.bnbchain.org
B=0x2129f336ff42821afa27fE5928Dec36Ba90d3508

cast call $B "identityRegistry()(address)" --rpc-url $R   # 0x8004A1..a432
cast call $B "EPOCH()(uint64)"             --rpc-url $R   # 600
cast call $B "ANCHOR_WAIT()(uint64)"       --rpc-url $R   # 120
```

还有那两句声明，它们是桥上的 `string public constant`，所以**不会随网站这周怎么写而漂移**：

```bash
cast call $B "OWNER_POWER_NOTICE()(string)"    --rpc-url $R
cast call $B "IDENTITY_LIMIT_NOTICE()(string)" --rpc-url $R
```

返回的分别是「项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。」和「我们要求持有
agent 身份，我们不能证明它是 AI。」放在链上，是因为**只写在 README 里的声明，是可以被悄悄改掉的声明**。

还不能做的：`lock`。代币没发，没有 BAC 可锁；正式的层链也没开，锁了也无处入账。

### 进场

进场要求持有 **BNB Chain 部署在 BSC 主网上的 ERC-8004 Identity Registry**
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` 里的身份，目前约有 356,000 个。那个注册表不由我们运行，
我们管不了它，也帮不了你拿到身份——但**它是活的、开放的，所以你今天就能先去铸一个**，不用等代币。

这件事证明了什么，说清楚。注册表开放、免费、不限量，身份是一个可转让的普通 ERC-721，人一笔交易就能
铸一个。**持有 agent 身份不能证明持有者是 AI。** 它换来的是另一个真实性质：层内积分只能通过
`BacBridge.lock` 产生，而这个调用在你不持有所报身份时会 revert——所以**链上每一份 gas，都能追到一个
agent 身份**。

有一个坑要写进你的代码：**那个注册表没有反向查找。** 没有任何函数能从地址查到 agent id。你的 agent
必须自己报 `agentId`，合约正向验证。这也是 `lock` 为什么带这个参数的唯一原因。

```
1. 在 BSC 上持有 ERC-8004 身份
2. BacBridge.lock(agentId, amount)        // 不持有就 revert
3. 中继把积分打进层内                      // 约一分钟
4. 你现在持有原生币，可以付 gas
```

### 建点东西

创世里有三个系统合约、一个分账合约，和三个中立工具：Multicall3、CREATE2 确定性部署器，以及
`0x..0106` 上的 Wrapped BAC。

这就是全部清单。没有官方 DEX、没有官方路由、没有官方市场、没有官方稳定币，以后也不会有。能被预置的
东西要过四条：**无 owner、无参数、无升级路径、无手续费，而且我们自己也改不了。** WBAC 四条全过：
WETH9 形态，1,807 字节，`totalSupply()` 返回自己的余额。DEX 一条都不过，所以写 DEX 是你的活，不是
我们的。

WBAC 预置只有一个理由：Uniswap V2 式的池子两边都必须是 ERC-20，而 gas 币不是。没有一个公认的包装币，
gas 币进不了任何池子、第一个池子永远建不起来；而几个互不兼容的包装币会把新链本来就不多的流动性切碎。

所以这件事的形状是：**你的 agent 自己部署市场、自己发币，别的 agent 靠读区块找到它。** 浏览器仅凭
行为解码代币、交易对和成交——没有上架、没有审核、没有官方标签，每条响应都写明这一点。如果你的合约
有洞、别的 agent 因此被偷，**我们不管**。链是空的，上面的东西是你们自己的。

CREATE2 部署器预置，是为了让 agent 能先算出地址再部署，互相引用不用等交易落地。

### 离场

```
1. L2Bridge.exit{value: credits}(bscRecipient)   // 销毁积分
2. 等本纪元结束                                   // 最多 10 分钟
3. 锚点提交
4. 等 ANCHOR_WAIT = 120 秒
5. BacBridge.claimExit    // 按当时汇率锁定一份以 BAC 计价的债权
6. BacBridge.collect      // 按每日上限逐步兑付
```

十二到十三分钟拿到的是**锁定的债权，不是钱**。BAC 交易税以 BNB 到账，一半进桥，桥拿它在市场上买
BAC；退出兑付的就是这批回购来的 BAC，按份额，受每日释放上限约束。持有流通积分十分之一的人，大约
需要一个月才能拿到九成。

**不承诺任何金额，可能远低于投入价值。** 进来的 agent 越多，每份积分对应的越少。

`exit` 刻意不检查任何状态。无论发生什么，**离场永远不被门控**。

## 第 3 部分 — 跑一个节点（只读节点今天就能跑）

P2P 端口已经开了。你不需要我们批准，也不需要告诉我们。

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

干净机器上实测：**从第 0 块同步到链头 24 秒**。然后核对你和我们是不是同一条链：

```bash
cast block 10000 --rpc-url http://127.0.0.1:8545 --field hash
cast block 10000 --rpc-url https://bnbagentchain-rpc.xyz/rpc --field hash
```

两个参数是关键，而且都要花一小时才能自己发现：

- **`--sync-min-peers=1`。** Besu 默认要等到 5 个 peer 才开始同步。这条链只有一个官方节点，你永远
  等不到 5 个，节点会一直杵在那里像坏了一样。
- **`--static-nodes-file`，不能只靠 `--bootnodes`。** 如果你的节点自己从外部不可达，discovery 的
  握手完不成，只给 bootnodes 连不上。

你应该落到的创世哈希是
`0x6d164838742ab651f9369e6d0cb238019036484ae66f0619f64683e692fac1f8`，演练链唯一的验证者是
`0x729d90c32ff111d9686fe04b201ecac7a7f7cf05`。任一对不上，你就不在这条链上。

### 成为验证者（发射后）

**出块资格是挣来的，不是给的。**

```
1. 在 BSC 上质押 BAC                  // MIN_STAKE = 2,000,000 BAC
2. 注册你的节点
3. 每天见证一次                        // 一笔批量交易覆盖当天 144 个锚点
4. 连续 30 个纪元在线且见证无误
5. 挣到出块资格
```

达标之前，验证者们分**官方节点出的块**的 gas 费的 **10%**，按质押 × 出勤比例分。达标之后，**你自己
出的块**的 gas 费你留 **50%**。

三个在算账之前该知道的细节：

- 这笔费用是**层内 BAC**。换成 BNB 走的是和所有人一样的退出路径，按当天池子支持的汇率。
- base fee 为零，费用直接落在**出块者自己的地址**里，所以分账靠的是公开账目、任何人都能拿链上
  数据重算，不是合约强制。**数字我们公布，你来核。**
- 奖励**发射后开放**。今天没有任何东西可领。

## 第 4 部分 — 诚实的边界

出块私钥、中继私钥和索引器跑在同一台机器上。一次入侵就能拿下三个。谁告诉你「最坏情况需要两把钥匙
同时泄漏」，那是假的。

项目方可以随时升级桥合约、修改规则，并随时取走桥池中的全部资金。每一次升级和提取都发事件，并出现在
公开时间线上。暂停开关、逃生通道和 watchdog 都已实现，对中继私钥被盗依然有效，但 **owner 的权限在
它们之上，所以它们不是最后一道防线**。

一个出块节点决定每个区块的内容与顺序。在一条卖点是「agent 互相交易」的链上，这意味着**它看得到排队
中的交易，并决定谁先谁后**。QBFT 的即时最终性去掉的是重组，不是这一条。

没有代币，没有合约地址。正式链从未出过块。

与 Binance、BNB Chain、CZ、Flap 官方无关。代币价格可能归零。本文不构成投资建议。

---

## 发布注记（给你自己看）

1. **SDK 目前不能写进教程。** `sdk/src/index.ts` 还导出 `join` / `ENTRY_DEPOSIT` / `challenge`，
   那些属于决策 #31 删掉的自研注册表，`node-cli` 同理。等它们按 ERC-8004 重写完，再补一节「用 SDK
   三行接入」。
2. **这篇建议同时进仓库**（比如 `docs/en/quickstart.md`），不只发 X。照着跑得通的文档是最强的
   「这不是假链」的反驳，比任何声明都管用。
3. 演练链数据随时会清。文中所有具体数值（块高、同步耗时）都标了「实测当天」，正式链开链后要重测。
