# 评审 · 可交付性与运行成本（judge-buildable）

2026-09-22。评审视角**只有一个**：这东西能不能被写出来、测出来、部到那一台 3 vCPU / 7.7 GB / 70 GB 空闲的机器上，然后不用天天看着它。
不评安全模型是否优雅，不评 agent 体验，不评叙事。凡是"需要一套我们没有的基础设施"或"一句话带过的工程"，一律扣分。

| 方案 | 分数 |
|---|---|
| **arch-ship** | **7 / 10** |
| arch-agentnative | 4 / 10 |
| arch-security | 3 / 10 |

---

## 0. 先算账：三份方案共用的硬数字

这些数字是我自己算的，三份方案里对得上的我说对得上，对不上的我点名。

**磁盘（period = 3，28,800 块/天）。** 一个 Clique 空块的 header RLP 约 540 字节（extraData 117 字节），加上 body/receipt/hash 索引与 freezer 之前的 KV 开销，全算进去每块 0.6–1.0 KB：**17–29 MB/天，6.3–10.5 GB/年**。

- arch-ship 写"空块加索引大约 30 MB/天、约 11 GB/年"——**对的**，而且偏保守，是三份里唯一算对的。
- arch-agentnative 写"空链约 10 MB/天、3.6 GB/年，70 GB 够跑很多年"——**乐观 2–3 倍**（10 MB/天等于每块 350 字节，header 本身就超了）。
- arch-security **一个磁盘数字都没有**，只在失败模式 6 写"极端情况撑大存储属于运营成本（70 GB 空闲）"。70 GB 也不是全给这条链的：indexer 的 SQLite（每天 28,800 行 blocks + txs + feed）另算 2–4 GB/年，备份另算。

**刷链的真实成本。** basefee 1 gwei + gasLimit 30M：填满一个块 0.03 BAC，**填满一整天的每一个块 864 BAC**（总量 1e9 的 0.00009%）。gasLimit 20M（arch-security）也就 576 BAC/天。所以三份方案里"gas 要花真金白银的 BAC，所以刷不动"这个论证（arch-ship §9"刷量要花真钱"）**在发射价位上不成立**。真正致命的不是钱，是磁盘：如果这 864 BAC/天全打在冷 SSTORE 上（20k gas 一个槽），**每天新增 4,300 万个存储槽 ≈ 4.3 GB/天**，70 GB 空闲两周内见底。唯一真的刹车是 EIP-1559 满块时 +12.5%/块（60 块 ≈ 3 分钟涨约 1000 倍），**而只有 arch-agentnative 点名了这条刹车**（§3.3"base fee 在持续满块时指数上涨"）。三份都没有给 chaindata 体积设阈值告警，也都没有磁盘预算表。

**BSC 侧的钱。** 09 号实测 gas price 0.05 gwei；03 号记录 rat 的 3 个库 + 工厂共 4 笔交易 11,897,394 gas ≈ 0.0006 BNB。

- **部署成本对三份方案都是噪音**（0.0006–0.0015 BNB）。谁的合约多一倍，部署也就多 0.0006 BNB。这条不作为区分项，谁拿"合约少所以便宜"当卖点都不加分。
- 中继的年度 gas（按 0.05 gwei / 按 3 gwei 两档）：
  - arch-ship（4 笔 anchor/天，约 60k gas）：**0.004 / 0.26 BNB/年**。
  - arch-security（1 笔 postAnchor/天，18 KB calldata ≈ 400k gas）：**0.007 / 0.44 BNB/年**。
  - arch-agentnative（48 笔 submitEpochRoots/天，约 150k gas）：**0.13 / 7.9 BNB/年**，再加下面那条 Trigger 兜底。
- arch-ship §6.2 写"每天 4 笔 BSC 交易，约 0.0006 BNB"——按 0.05 gwei 实测应是 0.000012 BNB/天，它是按 3 gwei 算的，**保守 50 倍，不扣分**，但发射后要按 09 的实测口径改。

**真正花钱的是人天，不是 BNB。** 这条对排序影响最大：arch-ship 自己定了"合约总量 < 1200 行 Solidity"和一周排期；arch-security 的合约面（ChainAnchor 的 veto/时锁/通胀证明、BacBridge 的 merkle 逃生 + MasterChef 累加器、commit-reveal 见证）我估是 ship 的 2.5–3.5 倍；arch-agentnative 除了 6 个 BSC 合约 + 7 个创世合约，还要交一个 8 模块的 TypeScript SDK 和一个 MCP 服务端。

---

## 1. arch-ship —— 7 / 10

**它赢在哪（都是可以指着看的东西）**

- §11 是三份里**唯一一份真的端到端验收脚本**：11 步，从 `anvil --fork-url` + 真实 `newTokenV6WithVault`，到 `docker compose up geth` 跑本地创世，到"杀掉 relayer 重启 → 断言 outbox 续传、没有重复 `credit`"，结尾打印 `E2E PASSED`。另外两份加起来没有一行本地 docker 端到端。
- §3.4 的创世字节码生成法是整份文档里工程味最重的一段：`geth --dev` 正常部署 → `eth_getCode` 取 runtime → `eth_getStorageAt` 取 slot → 填 genesis → `geth init` → `cast call` 把每个 view 在新链上再读一遍对拍，并且明说"这一步有脚本，在本地 CI 里跑，不靠人眼"。手搓创世 storage 是这类项目最经典的翻车点，它是唯一给了闭环验证的。
- §4.1 的中继是"一个进程 + 一个 SQLite + 先写 outbox 再推游标 + `await tx.wait(1)` 一次一笔、**不做 nonce 管理器**"。这是在 3 vCPU 上最不会半夜炸的形态：没有 nonce 乱序、没有 gas bump 状态机、崩了重启就续。
- §4.5 "**没有 Prometheus，没有 Grafana**"——在这台机器上这是对的，机器上还有别的负载在跑，系统负载很低是因为没人往上堆东西。
- §2.1 `vaultBps` 用 `==` 不用 `>=`（"某个更早的同类项目 就是这么被迫改了两次"）。发射是一次性、不可撤销的手工动作，把表单容错做成硬相等是可交付性上的加分项，不是洁癖。
- §2.1 让工厂校验 `IAgentBridge(bridge).bacToken() == taxToken`：在不碰 taxToken 的前提下堵住"发射表单粘错地址"，唯一一份正面解掉这个坑的。
- §7.1 SQLite + 轮询、§7.2 `node:http` + `better-sqlite3` 无框架、§7.2 明写 `Access-Control-Allow-Origin: *`。**三份里只有它记得 CORS**——忘了这个头，Vercel 上的站直接是白的。

**扣分（按严重程度）**

1. **中继在二层没有 gas，第一笔 `credit` 就发不出去。** §3.1 明写"alloc：除了两个系统合约，没有任何账户有余额"，同时 `baseFeePerGas: "0x3b9aca00"`（1 gwei）。中继 EOA 余额 0 → txpool 直接 insufficient funds → 桥进方向完全不通。这是**上线第一分钟就死**的 bug。arch-security 解对了（`OPERATOR_FLOAT = 1_000e18` 写进 alloc，并且"创世前运营方必须在 BSC 锁等额 BAC"保住 1:1 backing），必须照抄。
2. **整份文档没有公开 `/rpc`。** §7.2 的 API 清单里没有 `/rpc`，§1 的图把 geth 8545 标成"内网"。那 agent 怎么发交易？只能自己跑一个全节点走 30303 gossip。这既违反决策 #9（"RPC/API 用 `https://95-179-183-132.sslip.io`"），也等于要求每个 agent 先部署一台服务器才能进场。另外两份都有 `/rpc`。好在改起来只是 Caddy 加一段。
3. **备份方案数学错了，而且备出来的可能是坏的。** §9 "geth 数据目录每 6 小时 `tar` 一份到 `/opt/bac/backup`（保留 4 份，约 2 GB）"：按它自己算的 11 GB/年，两个月后 4 份 tar 就是 10 GB+，一年后 40 GB+，把 70 GB 吃穿；而且对**正在运行的** geth datadir 打 tar 不是崩溃一致的（pebble/leveldb 正在写），而恢复流程"恢复 datadir → 起中继"依赖的正是这份可能打不开的备份。3 vCPU 上每 6 小时全量 tar 十几 GB 的 I/O 本身也不免费。
4. **`--gcmode=full` + 定期 `snapshot prune-state`（§3.1）是两件对不上的事。** `geth snapshot prune-state` 是 hash 方案的**离线**操作，要停节点、要接近 state 体积的临时空间、在这台机器上要跑几小时——"定期"跑它等于定期停链几小时。要么改 `--state.scheme=path`（就不需要 prune-state），要么把停机窗口写进 runbook。
5. **告警没有出口。** §4.5 "任一项超阈值就写 `/opt/bac/ALERT` 并让浏览器首页挂黄条"——写文件不是告警。而 §9 对中继私钥泄漏的全部指望是"watchdog 调 `BridgeLock.pause()`"，也就是指望一个人在几小时内看见。一个 webhook 是十行代码。
6. **BSC 的 RPC 退路是已知坏的。** §7.1 "`bsc-rpc.publicnode.com` 为主、`bsc-dataseed.bnbchain.org` 轮换"——09 号实测 dataseed 对 `eth_getLogs` **在任何跨度上都返回 -32005**。这个"轮换"退不了。而中继每 3 秒一次 getLogs = 28,800 次/天打同一个免费端点，限流是迟早的事：要么降到 15 秒一轮，要么备一个付费 key。
7. 没有钉死 geth 镜像 tag（见下面 agentnative 的加分项）。对 ship 这是致命级遗漏，只是修起来是一行。

---

## 2. arch-agentnative —— 4 / 10

**它对的地方（有两条是全场最重要的）**

- §3.1 "**新版 go-ethereum 正在移除 Clique，compose 必须钉死一个确认能跑 Clique 的镜像 tag，出创世前先起一个一次性容器验证能出块**"。这是整场评审里最重要的一句话，也是唯一一句。整个项目建立在 Clique 上，而 Clique 正在被上游删掉；这件事不先验证，后面所有工作都可能归零。另外两份都默认 `docker compose up geth` 就有 Clique。
- §3.1 开到 Cancun 并给了正确理由："因为 agent 会用 solc 0.8.26 编译，需要 PUSH0 和 transient storage"。这直接击中 arch-security 的一个硬伤（见下）。
- 每纪元的中继工作量是**从 header 和 log 里取**：`layerStateRoot` "直接取该纪元最后一个区块的 stateRoot"，exitRoot / livenessRoot 来自日志。不需要遍历状态、不需要 debug API、不需要归档节点。比 arch-security 的做法便宜一个数量级。
- `finalizeValidatorEpoch` 数众数被 `MAX_NODES = 64` 有界，并明写理由"O(n) 必须有界"。
- 创世预置 Multicall3 规范地址 + `0x4e59…` CREATE2 部署器：几乎零成本，省掉浏览器和每个 agent 的一堆麻烦。
- §9 明说层内 relayer 写在创世 storage 里，**所以 `BridgeMinter` 必须预留 `rotateRelayer(address)`**。唯一一份想到"中继私钥泄漏了、层内那一侧怎么换钥匙"的。

**扣分**

1. **没有测试计划，没有排期，没有验收标准。** 全文没有一处 `forge` / `anvil` / 分叉测试 / e2e。只有文末六条"写码前必须验证"。在这个项目里，主网分叉上跑一次真实 `newTokenV6WithVault` 是不可跳过的（03 号整章在讲这件事），它一个字没提。
2. **交付面是三份里最大的。** 6 个 BSC 合约 + 7 个创世系统合约（BridgeMinter / Mirror / AgentBook / ServiceDirectory / Reputation / Multicall3 / CREATE2）+ `@bac/agent-sdk` 八个模块 + `bac-mcp` MCP 服务端。SDK 和 MCP 单独就是几周的活，交付之后还要长期跟版本。**在"一周能不能上线"这个尺度上，这是自杀。**
3. **30 分钟一个纪元 = 48 笔/天的时钟开销，而兜底是花钱的。** `EPOCH_LEN = 1800`，`sealEpoch` 靠"验证者每 12 小时本来就要发交易，顺手把种子封了"——12 小时一次的人去封 30 分钟一个的纪元，48 个里有 46 个没人封，于是掉进 Flap Trigger 兜底：**48 × 0.0002 BNB/天 = 3.5 BNB/年**，而 `OPS_CAP = 1 ether`（§2.2，opsPool 存量上限 1 BNB，超出自动进 validatorPool）。**预算结构上就付不起自己的时钟。** 再加 48 笔 `submitEpochRoots`（3 gwei 行情下 7.9 BNB/年），这是三份里唯一一份运行成本可能超过税收的。
4. **Caddy 做不了 §5.5 说的那件事。** "caddy 对 `eth_sendRawTransaction` 做发送者检查：不是 ACTIVE agent 的钱包直接拒绝"——Caddy 不能 RLP 解码一笔交易、ecrecover 出发送者、再去查链上状态。这需要另写一个代理服务（第五个进程），文档里不存在。而且它自己在 §5 承认"直接用 p2p 把交易 gossip 给签名节点"就绕过去了。
5. **`--nodiscover` + 静态 peer 白名单和"人类验证者自由同步"是互斥的。** §5 的缓解手段是签名节点只连已质押注册的 enode——那每来一个验证者就要有人（或某个没写进设计的进程）去 `admin_addPeer`。要么人工运维，要么又是一个组件。
6. **`registerNode` 无许可 + `MAX_NODES = 64` + 看不出每个 nodeId 要单独质押** = 一个人可以把 64 个槽全占了，别人永远注册不进来。这是要人工处理的 DoS。
7. **7 个创世合约的初始 storage 靠手填**（§3.1"直接写进 slot"），却没有 ship 那套"部署 → 取 code/storage → 回读对拍"的生成脚本。合约数是 ship 的 3.5 倍，翻车概率也是。
8. "每天把 chaindata 快照哈希发到 BSC …任何人可以拿自己的节点对"（§7）——**chaindata 的字节哈希在两台节点上永远不相等**（LevelDB/Pebble 的文件布局与节点自身有关），能对的只有 `layerStateRoot`。这句话要删掉。
9. 和 ship 一样的**中继无 gas** 问题："给任何人（包括我们自己）的创世分配是 0"（§3.1）。

---

## 3. arch-security —— 3 / 10

这是三份里写得最用心的安全文档，**也是最难建、最贵、最容易被一次普通运维事故打死的一份。**按我的视角，它的逃生舱和数据可得性是全场最好的主意——但它把这些主意接在了自动扳机上。

**它对的地方（必须抢过来）**

- §2.4 把整份快照原文当 **calldata 留在 BSC 上**："这让数据可得性等于 BSC 的数据可得性——服务器全毁也不影响逃生"。18 KB ≈ 288k gas，0.05 gwei 下 0.000015 BNB/天。**这是全场最物有所值的一笔钱。**
- §2.5 的逃生：用最后一个 FINAL 锚点的 `balanceRoot` 做 merkle 证明登记，"**逃生不需要中继、不需要 L2 活着、不需要服务器存在**"。只有它回答了"这台 VPS 哪天没了，桥池里的 BNB 怎么办"。
- §3 的创世哲学："无构造函数、配置全是代码里的 immutable 常量，创世不需要预置任何 storage 槽，`forge inspect <C> deployedBytecode` 出来的就是全部，任何人都能独立重建创世文件并核对哈希"——可复现创世比 ship 的"复制一份部署出来的 storage"更干净。
- `OPERATOR_FLOAT = 1_000e18` 写进 alloc 并公开披露，**唯一一份让中继有 gas 的**。
- gasLimit 20M "故意比 BSC 小"，方向对（虽然按上面的算术，20M 也拦不住 2.9 GB/天）。
- §10.8 砍掉 Flap Trigger："少一个外部依赖、少 1.75 BNB/年、少一类'回调没触发'的故障"。对照 agentnative 的 3.5 BNB/年时钟账单，这一刀砍得对。

**扣分（每一条都是我会拿去否掉这个方案的理由）**

1. **它会在上线第 14 天自杀。** §2.4："停机触发（**不可逆**）：…连续 `NO_ATTEST_EPOCHS = 14` 纪元零见证"，而 `EPOCH = 86400s`，也就是 **14 天**。同时 `MIN_VALIDATOR_STAKE = 2,000,000 BAC`，发射当天没有任何人质押。同一节里释放档位却写着"`attestations == 0 → 200 bps`"——**把零见证同时当作正常稳态和不可逆死亡条件**。按文档字面执行，这条链发射两周后自动进入不可逆逃生，项目结束。
2. **I3 恒等式 + Clique 小费归属 = 一笔交易就能永久停桥。** §3 的 I3 在 `postAnchor` 里 O(1) 强制，"破裂即 `Halted(4)`"（不可逆）；而 `流通积分 = 总量 - balance(L2Bridge) - balance(FeeSink)`，恒等式成立的前提是**所有 gas 都被销毁**。文档自己在括号里写了"（Clique 下小费归属需在 devnet 实测确认）"——实测结论会是：geth 的费用收款人是 `Engine.Author(header)`，Clique 下那是从 extraData 里 ecrecover 出来的**签名者地址**，不是 `--miner.etherbase`。于是第一笔带 priority fee 的 agent 交易（ethers 默认就会带）把 BAC 打进签名者 EOA，那笔钱既不在 L2Bridge 也不在 FeeSink，`circulating` 无端上升，**恒等式破裂 → Halted(4) → 桥永久死亡**。把一个"需要实测确认"的假设接在不可逆熔断上，是这份文档最危险的设计。
3. **中继每个纪元要遍历全状态算 `balanceRoot`，而文档一个字都没说怎么遍历。** `leaf = keccak(wallet, spendable, pendingExit)` 要求枚举链上**所有**账户余额。EVM 节点没有这个接口：要么 `debug_accountRange`（要开 debug、要状态在手），要么自己跟踪每一笔内部转账（需要 trace）。这是整份方案里工作量最大的一个组件，也是唯一一个完全没有设计的组件。附带一个没人回答的问题：agent 把积分放在自己造的 DEX 合约里时，那笔钱在逃生模式下谁来领？合约在 BSC 上没有对应的控制者。
4. **而且它给自己留了 6 分钟的窗口。** §9.6 写 `--state.scheme=path`（path 方案只保留最近约 128 个状态 = 3 秒块下 **6.4 分钟**），§2.4 写 `epoch == lastPostedEpoch + 1` 且"不可回填、不可跳号"，§4 写"漏发一个纪元则后面全发不出去——故意的"。三条叠起来：**中继每天只有约 6 分钟能读到纪元边界那个状态；错过一次，这条桥永远锚不上，直接走 §9.1 的不可逆逃生。**
5. **创世停在 shanghai，工具链却是 cancun。** §3："`shanghaiTime 0`（v1 停在 shanghai：不要 blob/tstore，少一层活动部件）"，§2："solc 0.8.26 / evm cancun"。solc 0.8.26 在 cancun 目标下会常规发出 `MCOPY`——**创世系统合约的字节码在这条链上是非法指令**，第一次调用就 revert，而创世不可改。连带后果：每个用默认配置的 agent（0.8.26 默认目标就是 cancun）部署出来的合约全是坏的。
6. **"签名节点的 txpool 白名单"（§5.4）和"④ 不改 geth"（§10）直接打架。** geth 没有发送者白名单这个功能（`--txpool.locals` 是优先级不是过滤）。要么改 geth（违反自己的切割线），要么另写一个 RPC 代理（文档里不存在），而且 p2p 一样绕过去。
7. **没有本地端到端演练。** 附录"测试底线"是一串 Foundry 断言（都对、都该做），但"起 geth + 起中继 + 跑一个纪元 + 锚上 BSC + 走一次逃生"没有任何脚本、没有任何排期。这份方案里最容易错的三样东西（创世字节码、balanceRoot 枚举、I3 记账）恰好全部在 Foundry 测不到的那一侧。
8. **快照 calldata 没有上限。** 36 字节/agent，geth 的 `txMaxSize` 是 128 KB，**到约 3,640 个 agent 时 `postAnchor` 就发不出去了**；配上"不可跳号"，那一刻桥永久死亡。得有 `MAX_AGENTS` 或分片提交。
9. **`INFLATION_BOUNTY = 0.05 BNB` 从节点基金付，但 `ChainAnchor` 标题写着"不持有任何资金"**（§2.4）。谁付？没写。
10. **信任模型依赖三把互相独立的冷钥（relayer / admin / veto），而这是一个人的项目。** §8 的每一行安全保证都建立在"veto 钥能在窗口内作废中继的锚点"上；现实里这三把钥匙会躺在同一台机器或同一个抽屉里。文档在 §0 承认了"签名节点和中继私钥在同一台服务器上，是同一个信任域"，但后面九节仍然按三个独立主体写。
11. `_validateBeforeLaunch` 用 `vaultBps < 1000` 拒绝（§2.1）。规则底线确实是 `>= 1000`，但发射是一次性手工动作、某个更早的同类项目 在表单上错过两次——这里应该像另外两份一样钉死 `== 10000`。
12. "创世哈希、系统合约源码、每纪元快照镜像到 GitHub + **IPFS** + BSC calldata 三处"（§3）——IPFS 固定服务是我们没有的基础设施（要账号、要付费、要有人盯着 pin 没掉）。BSC calldata 那一份已经够了，IPFS 这条要么删掉要么说清楚谁来 pin。

---

## 4. 赢家：arch-ship

理由只有一条：**只有它给出了"怎么知道我们做完了"的判据**——一个 11 步、结尾打印 `E2E PASSED` 的本地脚本，和一张 D1–D7 的表。另外两份是设计，它是设计 + 施工方案。在一台已经跑着别人项目的 3 vCPU 机器上，进程最少（4 个容器）、每日链上交易最少（4 笔）、代码量最小（< 1200 行）、故障模式最钝（没有任何不可逆的自动扳机）、也是唯一算对磁盘的。

它的两个"上线即死"bug（中继无 gas、没有公开 RPC）加起来大概半天的修改量。arch-security 的两个（第 14 天自杀、I3 + Clique 小费）是要重新设计熔断和记账；arch-agentnative 的（SDK + MCP + 48 纪元时钟 + Caddy 过滤器）是要重新砍交付范围。

---

## 5. 赢家必须吸收的东西

按"不抄就出事"排序。

1. **[agentnative §3.1] 先验证 Clique 还活着。** 在写任何创世文件之前，起一个一次性容器，钉死镜像 tag（`ethereum/client-go:v1.13.x` / `v1.14.x`），确认它能用 Clique 出第 1 块。这是 D0 的第一件事，不是 D3 的一部分。同时写进 runbook：我们被钉在一个不再更新的客户端上，而 30303 对公网开着——补丁窗口要有人管。
2. **[security §3] 创世给中继一个公开的 `OPERATOR_FLOAT`**（1,000 BAC 量级），并在创世之前在 BSC 上锁等额 BAC 保住 1:1 backing。ship 现在的 alloc 让中继一笔交易都发不出去。
3. **[decision #9] 加 `/rpc`。** Caddy 反代 + 方法白名单（`eth,net,web3`，按 security §7 的写法）+ 限速 + CORS。同时保留 ship 的判断：**不要**在 Caddy 里做发送者过滤（做不到，也绕得过），门禁靠"没有积分就没有 gas"这一层。
4. **[security §2.4/§2.5] 把快照原文写进 BSC calldata，并建一个 merkle 逃生口——但换掉扳机。** 三处改动：① `MAX_AGENTS`（或分片提交）保证锚点交易永远 < 128 KB；② 熔断 fuse 从 14 天拉到 **60–90 天**，且**零见证永远不触发熔断**（零见证只降释放档位，这本来就是 security 自己那张档位表的意思）；③ 逃生必须由 watchdog / Guardian **手动武装**，自动触发只保留"90 天无锚点"这一条。
5. **[security §2.4 简化版] 在锚点交易里加一条 O(1) 的链上不变式**：`creditedTotal <= BridgeLock.lockedTotal`。ship 现在只在 indexer 里对拍（§7.3 第 2 条），那是"我们说的"；放进 `anchor()` 的 require 里，它就变成"中继超发的那一刻就再也发不出合法锚点"。不需要快照、不需要求和、不需要欺诈证明，几百 gas。
6. **[agentnative §3.1] 创世开到 Cancun**（ship 已经是 `cancunTime: 0`，保持），并在文档里写明理由：agent 默认用 solc 0.8.26，目标就是 cancun。
7. **[agentnative] 锚点同时记 `blockHash` 和该块的 `stateRoot`。** 两个都是 header 字段，中继零额外成本，但验证者的见证从"哈希一样"变成"状态一样"，价值差很多。
8. **[agentnative §3.2] 创世预置 Multicall3（`0xcA11…CA11`）和 CREATE2 部署器（`0x4e59…`）。** 几 KB 字节码，省掉浏览器、SDK 和每个 agent 的一堆特判。
9. **[agentnative §4] BSC 确认深度改用 `finalized` 标签**（BEP-126 快速最终性），120 块只作为取不到 finalized 时的退路。ship 的 54 秒是白等的。
10. **[security §9 + 自查] 修掉备份方案。** 不要对活着的 datadir 打 tar。改成：每周停节点 5 分钟打一份冷备（保留 2 份）+ 依赖"创世 + 重放"重建；SQLite 用 `VACUUM INTO`（ship 已经写对）。同时给 `/opt/bac` 设磁盘预算（chaindata ≤ 25 GB、index ≤ 8 GB、backup ≤ 12 GB）和 80% 告警。
11. **[agentnative §9] 层内中继密钥要能换。** `L2Bridge` 留 `rotateRelayer`，走 BSC 侧时锁授权。不然中继私钥一泄漏，整条链只能重启。
12. **告警要有出口。** ship 的 `ALERT` 文件改成一个 webhook（Telegram / 邮件），把 §4.5 那张阈值表和 security §4 的监控表（出块延迟 > 30 s、锚点逾期、两把钥匙余额、对账差额）合并成一份 runbook。
13. **[agentnative §7] "官方节点限速某个 agent 是中心化手段，必须记录在 `/api/health` 上，不许静默。"** 这句话照抄。ship §9 对刷链的回答就是 `--txpool.accountslots` / `--txpool.pricelimit`，那就是限速，要公开。
14. **[agentnative §3.3 + 本文 §0] 把刷链的账写进文档并加监控。** basefee 1 gwei 下填满全链一天只要 864 BAC；真正的刹车是 EIP-1559 的涨价曲线，真正的代价是磁盘。gasLimit 从 30M 降到 **20M**（抄 security），加 chaindata 体积告警，`--txpool.accountslots` 写进 compose。
15. **[security 附录] 把它的测试底线并进 ship 的 E2E**：`receive()` 在 `call{gas:50_000}` 下成功且冷 < 60k、派发在下游 revert 时不回滚、每场景后 `_assertSolvent()`、模糊测试打不破记账恒等式。

---

## 6. 致命缺陷清单（任意方案）

**arch-security**

- F1. `NO_ATTEST_EPOCHS = 14` × `EPOCH = 1 day` + `MIN_VALIDATOR_STAKE = 2,000,000 BAC`：**发射后第 14 天自动进入不可逆逃生**，除非在那之前有人质押 200 万 BAC 并跑 commit-reveal。同一份文档又把 `attestations == 0` 当成正常档位。
- F2. I3 恒等式在 `postAnchor` 里硬校验、破裂即不可逆 `Halted(4)`，而"小费也被烧掉"这个前提在 Clique 下**是错的**（费用给 `Author(header)` = 签名者，不是 `--miner.etherbase`）。第一笔带 tip 的交易就可能杀死桥。
- F3. `balanceRoot` 要求枚举全链账户余额，**实现方式完全没写**；叠加 `--state.scheme=path`（128 个状态 ≈ 6.4 分钟）和"不可跳号"，中继每天只有约 6 分钟的窗口，错过一次就永久锚不上。
- F4. `shanghaiTime 0` + `solc 0.8.26 / evm cancun`：创世系统合约里的 `MCOPY` 在这条链上是非法指令，而创世不可改。
- F5. 快照 calldata 无上限，`txMaxSize` 128 KB 在约 3,640 个 agent 处变成硬墙，而锚点不可跳号。
- F6. "签名节点的 txpool 白名单" vs "不改 geth"——geth 没这个功能。

**arch-agentnative**

- F7. 30 分钟纪元 + Flap Trigger 兜底 = 最坏 **3.5 BNB/年**的纯时钟开销，而 `OPS_CAP = 1 ether`。预算结构上付不起自己的时钟，而时钟是唯一不能停的东西。
- F8. Caddy 无法 RLP 解码 + ecrecover，`/rpc` 的发送者过滤是一个**不存在的组件**；文档自己承认 p2p 绕得过。
- F9. 无测试计划、无排期、无验收判据，却是交付面最大的一份（SDK + MCP + 7 个创世合约）。
- F10. 创世给我们自己的分配是 0 → 中继在层内没有 gas，第一笔 `mint` 就发不出去（同 F11）。

**arch-ship**

- F11. §3.1 alloc 没给中继余额 + `baseFeePerGas` 1 gwei → **第一笔 `credit` 就发不出去**，桥进方向死。
- F12. 全文没有公开 `/rpc`，agent 必须自建全节点才能发交易，违反决策 #9。
- F13. 6 小时一次对活 datadir 打 tar、保留 4 份"约 2 GB"：一年后 40 GB+，且备份可能不是崩溃一致的，而恢复流程依赖它。

**三份都有**

- F14. `95-179-183-132.sslip.io` 的证书是整个右半边网站的单点：Vercel 是 HTTPS，混合内容会被浏览器拦死，所以 Caddy 签不下证书 = 层内数据全黑。三份都没写备选（Cloudflare Tunnel，或把 `/api` 代理到 Vercel 的 serverless），也没提 sslip.io 作为共享域名的签发限额风险。三份里只有 ship 记得 `Access-Control-Allow-Origin`。
- F15. "gas 要花真金白银的 BAC 所以刷不动"是错的：1 gwei × 30M gas × 28,800 块 = **864 BAC/天就能填满全链**；打在冷 SSTORE 上是 **4.3 GB/天**，70 GB 两周见底。三份都没有磁盘预算、没有 chaindata 体积告警，只有 agentnative 点名了 EIP-1559 涨价这个真正的刹车。
- F16. 三份都把 Flap AI Oracle 的回调上限写成 1,000,000 gas（security §5、ship §5.3、agentnative §5.6），09 号实测是 **8,000,000**，而且**没有 `getFee()`**，价格来自 `getModel(id).price`（gemini-3-flash = 0.005 BNB）。三份都没把 oracle 放进关键路径，所以不致命，但写码前要按 09 改口径。
