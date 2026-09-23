# web/js/data · 网站数据层

这一层是**唯一碰链的代码**，暴露 `window.BAC`，**里面没有一行 DOM 代码**。
绑定层（`js/ui/bind.js`，另一个工作流负责）是它唯一的消费者。可视层不许自己发 RPC 或 fetch。

## 文件与加载顺序

```html
<script src="/site.config.js"></script>                       <!-- 同步，必须最先 -->
<script defer src="/vendor/ethers-6.13.4.umd.min.js"></script>
<script defer src="/js/data/bac-core.js"></script>            <!-- 配置 / 常量 / 格式化 / 事件总线 / 状态骨架 -->
<script defer src="/js/data/bac-chain.js"></script>           <!-- BSC 侧：RPC 轮换 + Multicall3 + 合约读 -->
<script defer src="/js/data/bac-layer.js"></script>           <!-- 层内：裸 JSON-RPC 直读块 / 交易（不经索引器） -->
<script defer src="/js/data/bac-api.js"></script>             <!-- 索引器 HTTP API：历史 / 搜索 / 聚合 / feed -->
<script defer src="/js/data/bac-view.js"></script>            <!-- 拼成页面要的视图模型 + BAC.start() -->
<!-- 之后才是 js/ui/*.js -->
```

缺依赖时每个文件只打印一条 `[BAC] …需要先加载 bac-core.js` 并什么都不做，不抛异常。

页面必须把可见性推给数据层（数据层不碰 `document`）：

```js
document.addEventListener('visibilitychange', function () { BAC.setHidden(document.hidden); });
```

## BSC 侧三阶段 + 层内开关（**最容易搞错的一条**）

v2（决策 #29 / #30 / #31 / #35）：没有 factory / vault / registry / vaultPortal 了。地址簿是
`token / router / bridge / nodeFund / anchor / staking`（`router` = BacTaxRouter，`bridge` = BacBridge 的 **ERC1967 代理**地址）。
旧配置（有 `vault` 没 `router`）照样能加载：`vault` 顶上 `router`，`factory` / `registry` / `guardian` / `vaultPortal`
只记进 `CFG.legacyKeys`，不参与任何判断。

代币地址已锁定（#35）但发射前**地址上没有代码**；BSC 合约会**先于**代币部署。所以 BSC 侧有三个阶段，
全部由 `bac-chain.js` 的 `eth_getCode` 探针决定（结果缓存、只从 false 翻到 true；没翻完之前每 `codeProbeMs`
= 2 分钟复探一次 → **发射当天不用改配置、不用重新部署网站**，开着的页面自己翻过来）：

```
BAC.STAGE = 'none'      (a) 什么都没部署（配置里只有代币地址，或全是 0x0）
          = 'deployed'  (b) router + bridge 有代码，代币没发射
          = 'launched'  (c) 代币地址上有代码
BAC.CONTRACTS_CONFIGURED  配置里 router + bridge 都填了（同步，加载时就定）
BAC.CONTRACTS_LIVE        router + bridge 地址上都有代码
BAC.TOKEN_LIVE            代币地址上有代码
BAC.LIVE                  兼容别名 = CONTRACTS_LIVE || TOKEN_LIVE（探针回来之前 = CONTRACTS_CONFIGURED）
BAC.LAYER_LIVE            层内那条链的 RPC 现在答不答话（和上面几个完全独立）
```

- 阶段 (b) 里合约自己的状态（0 余额、owner、升级 0 次、空时间线、0 个 agent）**是真的**，要照实显示，
  不许写「发射后公布」；只有价格 / 税率 / 内盘进度 / 待分发税 / 桥里的 BAC 这些**真的还不存在**的数才是 `'pre'`。
- 视图里两个状态函数：`contractStatus()`（合约那一半）和 `tokenStatus()`（代币那一半）。
  `statusOf()` 保留为 `contractStatus()` 的旧名。
- 层内的块高、区块、交易、gasLimit、baseFee **不许经过这几个开关**，走 `layerStatus()`，只看「读到没有」。

| 这一半 | 首选来源 | 退路 | 都挂了会怎样 |
|---|---|---|---|
| 税收路由 50/50、桥（含 owner 权力计数器）、验证者质押、纪元锚点、agent 名录（`deposits()` + ERC-8004） | **BSC 公共 RPC 直接读合约**（`bac-chain.js`，eth_call 走 `rpcs`，bsc-dataseed 在前） | 换一个公共 RPC | 整段显示「读取失败 · 重试中」 |
| owner 权力 / 税收流向 / 节点基金时间线 | **BSC 日志**（`logRpcs` = publicnode，只给最近约 6000 块）+ owner / 节点基金那两条再合并**索引器** `GET /api/bridge/timeline`（从部署块起的全量历史） | 索引器读不到：只剩日志窗口（更早的去 BscScan 事件页） | 时间线 `'error'`，**上面那些读数照常** |
| **层内块高 / 区块 / 交易** | 索引器（有历史与聚合） | **`bac-layer.js` 直接打层内 JSON-RPC** | 三段各自 `status='error'`，显示「读取失败 · 重试中」，数字保持 `null` |
| 实时动态 / 纪元历史 / 兑付率 / 搜索 / agent 的层内数据 | **索引器 HTTP API**（`bac-api.js`，`docs/03-INTERFACES.md` §3） | 没有退路（RPC 给不出这些） | 显示「读取失败 · 重试中」，**BSC 那半照常刷新** |

每一段都带一个 `source`：`'indexer'`（有历史与聚合）| `'rpc'`（本站直接读层内节点）| `null`（都读不到）。
绑定层要如实显示这个来源，`state.layer.endpoint` 是现在实际在用的那个地址。

`state.layer.sections` 是层内三段各自的状态：
`{ head, blocks, txs }`，取值 `'prelaunch' | 'loading' | 'ok' | 'error'`
（`'prelaunch'` 只在**一个层内 RPC 地址都没配**的时候出现 —— 那是「没配」，不是「读取失败」）。

### `bac-layer.js`（层内直读）

不走 ethers 的 provider 栈：ethers 会对未知链做网络探测和自己的重试，这里只要
「发一个 JSON-RPC、超时就换端点」，裸 fetch 更短、更可测。超时与退避仍然照约定 §1.3。

```js
BAC.layer.head()               // chainId / 块高 / 时间戳 / gasLimit / baseFee / gasPrice / peers / 实测出块间隔
BAC.layer.latestBlocks(n)      // 最近 n 个块：number hash ts miner(=QBFT 提案人) txCount gasUsed gasLimit feeTotal
BAC.layer.latestTxs(n)         // 最近 n 笔：hash blockNumber from to value gas gasPrice isCreate created status fee
BAC.layer.block(numberOrHash)  // 区块详情（带完整交易 + 收据）
BAC.layer.tx(hash)             // 交易详情
BAC.layer.gasPrice() / peers() / txpool()
BAC.layer.endpoint()           // 现在在用哪个 RPC 地址
```

**请求数是有硬上限的**（永远不会无界增长）：

| 动作 | HTTP 请求数 | 怎么来的 |
|---|---|---|
| 一轮完整轮询 | **3** | 元信息批量 1（chainId/blockNumber/gasPrice/peerCount/txpool_status）+ 区块批量 1 + 收据批量 1 |
| 索引器在供数时的探活 | **2** | `head()`：批量 1 + 上一块 1 |
| `head()` | 2 | 同上 |
| `latestBlocks(n)` / `latestTxs(n)` | 3（给了 `head` 就 2） | 块高 1 + 区块 1 + 收据 1 |
| `block()` / `tx()` | 2 | |

- 一个 JSON-RPC 数组体最多 **25** 条（`MAX_BATCH`），超了直接拒绝；
- 一轮最多为 **6** 个非空块取收据（`RECEIPT_BLOCKS`）；
- 一次逻辑调用最多打 **2** 个端点（主 → 兜底，`MAX_HOPS`），不做无限重试；
- 交易是从 `eth_getBlockByNumber(..., true)` 取回的块里捡出来的，**不逐笔请求**。

### 换端点（主域名 → 兜底 IP）

两条链路都是同一套：主用在前，兜底在后，网络层失败才换，JSON-RPC 自己报的
`error`（比如 `txpool_status` 的 `-32601 Method not found`）不算端点坏了。

```
CFG.layerRpc     → CFG.fallbackRpc      （bac-layer.js）
CFG.indexerBase  → CFG.fallbackApi      （bac-api.js）
```

退避用 `healthTable(5000)`：5 秒起、翻倍、封顶 120 秒，所以**主端点最长每 120 秒被复探一次**，
一旦它恢复就自动换回主端点。4xx（比如索引器还没部署、`/api/*` 返回 404）**不算端点坏了**，
不会因此切到兜底。

### 轮询节奏（`bac-layer.js`）

| 情况 | 间隔 |
|---|---|
| 索引器读不到，由 RPC 供数 | `layerPollMs` = 6000 ms（链 3 秒一块，**永远不比出块更快**） |
| 索引器在正常供数 | `layerIdlePollMs` = 60000 ms（只做轻量探活，不抢它的活） |
| 标签页切到后台 | `layerHiddenPollMs` = 60000 ms（`BAC.setHidden(true)`，不停轮询，只退到慢档） |
| 读失败之后 | `backoffMs(failures, 5000)`，封顶 120 秒 |

### 不许编的数

- 没取到收据 → `gasUsed` / `status` / `fee` / `feeTotal` 一律 `null`，**不许用 `gas` 上限冒充 `gasUsed`**；
- 空块的 `feeTotal` 是 `0n` —— 这是事实（块里没有交易），不是猜的；
- `txpool_status` 在 Besu 上默认是关的（实测 `-32601`）→ `txpool` 是 `null`，不报错、不显示 0；
- agent 归属、日志解码只有索引器知道 → RPC 供数时一律 `null`；
- 两个端点都挂 → 三段 `status='error'`，`head` / `headTs` / `blockIntervalSec` 保持 `null`，
  区块与交易列表保持空 —— **宁可显示「读取失败 · 重试中」，也不显示上一轮的数当成新的**。

## 必须逐字的文案

```
BAC.TEXT.PRE           = '发射后公布'                    // 这个数还不存在（合约没部署 / 代币没发射）
BAC.TEXT.OWNER_POWER   = '项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。'   // 决策 #29a
BAC.TEXT.IDENTITY_LIMIT= '我们要求持有 agent 身份，我们不能证明它是 AI。'                      // 决策 #31a
BAC.TEXT.ERR           = '读取失败 · 重试中'              // 读取失败
BAC.TEXT.NOT_ANCHORED  = '未锚定 · 仅来自官方节点'        // feed 里 anchored === false 的条目
BAC.TEXT.NO_INDEXER    = '索引器读不到：层内数据暂时不可用，BSC 侧数字仍然是实时的'
BAC.TEXT.RPC_DIRECT    = '索引器读不到：区块与交易改由本站直接读层内节点，历史与搜索暂时不可用'
```

`NO_INDEXER` 和 `RPC_DIRECT` 由 `BAC.api.degradedNote()` 二选一：
层内节点还答话（`BAC.LAYER_LIVE === true`）时说 `RPC_DIRECT` —— 块和交易仍然是真的，
不许说「层内数据暂时不可用」；层内节点也挂了才说 `NO_INDEXER`。

**永远不显示演示值。** `null` = 不知道，绑定层不许把它当 0 渲染。
金额一律是 `BigInt`（wei），只经 `BAC.fmt.*` 格式化；时间一律是秒，显示一律转北京时间（`BAC.fmt.beijing`）。

### 合约里的占位值（阶段 b 最容易被当成真数显示）

合约刚部署时有几处**不是 0 就是占位**的值，数据层一律翻成 `null`（「还没有过」），不交给页面当真数：

| 读数 | 合约里的初值 | 视图里 |
|---|---|---|
| `ChainAnchor.lastPostedEpoch` | 构造函数写 `firstEpoch − 1`（让第一个锚点能过「纪元连续」检查） | `< firstEpoch` → `null`；`firstEpoch` 没读到时只有那个纪元的锚点记录 `postedAt > 0` 才信；那个空锚点不去读 |
| `ChainAnchor.lastFinalEpoch` / `lastFinalAt` | `0` / **部署时间**（停机计时的起点） | 没有定案过 → 两个都是 `null`；部署时间另放 `epoch().haltClockFrom` |
| `BacBridge.lastUpgradeAt` / `lastEmergencyAt` | `0` | 次数是 0（或时间是 0）→ `null`，不许显示成 1970-01-01 |
| `isPaused().until_` / `escapeArmedAt` / `lastEpochRelease().settledAt` | `0` | `null`；`settledAt` 是 0 时 `lastPot` / `lastPotBps` 也一起 `null`（从来没释放过） |
| `currentRate()` | `creditsOutstanding = 0` 时直接 `return 0` | `bacPerCredit` / `weiPerCredit` = `null`（没有汇率，不是「每积分 0 BAC」） |

`pausedCumulativeSec`、升级 / 提取**次数**、余额这些 0 是**真的 0**，照实显示。
（`BacBridge.lastSettledEpoch` 初值是部署纪元：它是「结算游标」，语义上就是「之前的纪元都不用结算了」，原样给出。）

### 读不到 / 读不全时的硬规矩

- **接线参数逐条累积**（`state.bsc.params`）：某一条这一轮没读到，只把它留到下一轮补读（读到的不重读）。
  `params.missing` 列出还缺的 key；`loaded` = 接线核对与 #29a 那句要用的都读到了；`complete` = 全部读到（之后不再读）。
  没读到的那一项记进 `wiring.unchecked`，`wiring.ok = null` —— **没核对过绝不算通过**；读回零地址算对不上。
  升级过（`upgradeCount` 变了）或实现槽变了 → 清空重读。代币参数同理：`taxProcessor` / `marketAddress` /
  `feeConfigV2` 任何一条没读到，`tokenParams.loaded = false`，`marketAddressOk` 保持 `null` 并每轮补读。
- **地址上有代码、合约却一条核心读数都没返回**（ABI 对不上 / 代理地址填错 / 节点全挂）：记进
  `state.bsc.failedContracts`（`overview().failedContracts`）。路由和桥**都**读不出 → 走错误路径：
  `bsc.error = TEXT.NO_VAULT`（全是网络失败时是 `TEXT.ERR`），`status = 'error'`，上一轮的真数保留并标 `stale`，
  不拿 `null` 盖掉；只有一个读不出 → 那一段（`treasury()` 看路由、`bridge()` / `ownerPowers()` 看桥、
  `epoch()` 看锚点、`validators()` 看质押）是 `'error'`。非网络原因时告警 `contract_reads_failed`。
- **ERC1967 实现槽每轮都读**（一条 `eth_getStorageAt`）：`upgradeCount` 是实现合约自己写的，owner 能装任何实现（#29），
  所以不能拿它当「要不要重读」的信号。槽变了而同一轮的计数器没变 → `bridge().unloggedImplementationChanges` 记一条、
  告警 `implementation_changed_unlogged`。时间线里单独的 `Upgraded` 只有和 `Initialized(1)` 同一笔交易才是初始实现
  （`initial: true`），别的都是没留 `BridgeUpgraded` 的换实现（`unlogged: true`，同样告警）。
  `ownerPowers().implementationMatchesLog`：时间线全了时，日志里最后一次换到的实现必须就是槽里那个（不全时 `null`）。
- **时间线每条列表最多 `timelineMax` 条**：超了丢最旧的，`state.timeline.truncated[list]` 记下（这一页里补不回来），
  `droppedThrough[list]` 是丢掉的最新那一块。`treasury().timelineComplete` 在流向或节点基金那条丢过时是 `false`
  （另给 `timelineTruncated`）；`ownerPowers().complete` 在 owner 那条丢过时只能走索引器那条路，且要索引器游标 ≥ `droppedThrough`。
- **Multicall3 探针只在 getCode 真的答了才下结论**（`'0x'` = 没有）；探针本身没答上 → 这一轮逐条读，退避到期再探。
  逐条模式下 agent 名录每轮最多读 `plainDepositsPerTick`（40）笔存入（新的优先，没读全 `total = null`），
  身份的定时整批复读停掉、只给新身份读几个（`agents().identityPaused = true`）；
  推导的 BNB 缺口只在 `bnbBalance()` 与 `getEthBalance(bridge)` 出自同一块 `aggregate3`（同一区块）时才算，否则 `null`。
- **总质押 / 奖励余额链上直读优先**：索引器的 `totalStaked` 是它已索引行的求和（摄取落后、没配 staking 时就是 `"0"`），
  只在链上那条没读到、且本站配了 `staking` 时才顶上（`totalStakedSource` / `rewardBalanceSource` 标来源）。
- **agent 名录只认索引器 v2**（`bac/agents/2`、`bac/summary/2`）：v1 数的是已删掉的 AgentRegistry，编号也不是 ERC-8004 身份号，
  条目、总数、同号补数据一律不用。`status` 不是 `'ok'` 时 `total` / `totalAtLeast` / `counts` 一律 `null`。
- **验证者奖池按「天」记**：`ValidatorStaking.epochReward(epoch)` 其实是 `dayReward(epoch / 144)`。数据层直接读
  `dayReward(day)`，给 `validators().rewardDay / dayPot / dayWeight / daySettled`（最近一个上报纪元所在的那一天）；
  合约里没有「每纪元的奖池」，`epochPot` / `epochSettled` 恒为 `null`。

## 视图模型（绑定层直接用这几个）

每个都返回一个 `status`：`'pre' | 'loading' | 'error' | 'ok'`。

`chainStats()` / `blocks()` / `txs()` 走 `layerStatus()`（**不看 BSC 阶段**）；
合约那一半走 `contractStatus()`，代币那一半走 `tokenStatus()`。

```js
BAC.view.chainStats()   // 块高、实测出块间隔、gasLimit、baseFee、gasPrice、peers、txpool、source、endpoint、纪元、对账三件套
BAC.view.feed(limit)    // 实时动态；每条自带 anchorNote 与 untrusted 标记
BAC.view.blocks(limit)  // 最新区块
BAC.view.txs(limit)     // 最新交易
BAC.view.stage()        // 三阶段 + 每个地址的代码探针结果 + 旧配置残留键
BAC.view.token()        // 代币：CA（发射前就有）+ 发射后才有的名字 / 税率 / Portal 状态 / 价格 / 待分发税
BAC.view.treasury()     // BacTaxRouter：50/50 两桶、路由余额与三桶、卡住的份额、流向时间线、节点基金时间线、#29a 披露原文
BAC.view.bridge()       // 桥：锁仓 / 发行 / 退出 / BNB 账与实物 / 回购桶 / owner / 实现合约 / 升级与提取计数 / shortfall
BAC.view.ownerPowers()  // 决策 #29c：owner 权力时间线（日志窗口 + 索引器全量历史合并；升级 / 初始化 / 紧急提取 / 换 owner / 暂停 / 逃生武装）+ 计数器对账
BAC.view.agents(opts)   // ERC-8004 agent 名录：身份持有人 / agentWallet / tokenURI 自述 / 桥上积分；没有状态机
BAC.view.validators()   // 验证者 + 层内 gas 归集的「已收 / 已转入 / 差额」三元组（来源：索引器 /api/health 的 gas 块）
BAC.view.epoch()        // 当前纪元（600 秒）、firstEpoch、上报/定案进度（占位值已滤掉）、停机计时起点、锚点详情、纪元历史
BAC.view.overview()     // 整页横幅、阶段、警告、地址表（带 vault 旧名别名 + ERC-8004 注册表 + Flap Portal）
```

### 时间线为什么可能不全（照实说）

公共节点只给最近一个窗口的日志（publicnode 实测约 6000 块 ≈ 45 分钟，之外报
`Archive requests require a personal token`；bsc-dataseed 的 `eth_getLogs` 一律 `-32005`）。所以：

- 首轮只扫最近 `logWindowBlocks`（5000）块；配置了 `deployBlock` 且它还在窗口里 → 从部署块扫起；
  **只有真的从部署块扫到了链头**（`syncedTo ≥ head`，窗口比两块大时首轮追不上）、中间没有缺口，`complete` 才是 `true`；
  日志 RPC 失败（一条都没看过）绝不算全；
- 之后每轮只扫新块；标签页睡过头超过窗口 → 记进 `gaps`，`complete = false`；
- owner 权力与节点基金那两条再合并**索引器** `GET /api/bridge/timeline`（`state.ownerTimeline`，形状与日志条目一致，
  按 `tx:logIndex` 去重，日志窗口那条优先）。`ownerPowers().complete` 走索引器这条路时要**同时**满足：
  历史里看得到部署那一刻（`Initialized`，或 owner 从零地址给出）、应答没被 `limit` 截断、
  索引器的摄取游标（取发请求**之前**那次 `/api/health` 的值，偏保守）接得上日志窗口的起点、日志窗口这一轮扫到了链头；
  `completeVia` 说是哪条路。索引器盯的桥 / 节点基金地址和配置对不上 → 一条都不用，告警 `indexer_address_mismatch`；
  旧版索引器没有这个端点（404）→ `historyStatus = 'error'`，**不算索引器挂了**（4xx 一律不拉降级横幅）；
- **升级与紧急提取**另有全量的合约计数器（`upgradeCount` / `emergencyCount` / 累计提取额 / 最近一次时间），
  `ownerPowers().missing` 给出「计数器说 N 次、时间线里看到 M 次」的差，差不为 0 时页面必须写明并链到 `eventsUrl`（BscScan 事件页）。

### agent 名录（决策 #31 / #31a）

一个 agent = 一个锁进过桥的 ERC-8004 身份编号。来源是 `BacBridge.deposits(i)`（全量的链上记录，不靠日志；
只读最近 `depositsMax` 笔并缓存），再对每个身份读注册表：`ownerOf`（没铸过的编号会 revert → `identityExists: false`）、
`getMetadata(id, "agentWallet")`（**20 个裸字节**，别的长度一律 `null`）、`tokenURI`（持有人自述，只从 data: URI 里取
`name` / `description`，`image` 只记有没有，**绝不把 URL 交给页面**；ipfs / https 的注册文件不去拉；gzip 的不解压）。
v1 的 `status` / `statusName` / `statusZh` / 心跳 / 挑战这些字段一律 `null`。

开关：`BAC.start()` / `BAC.stop()` / `BAC.refresh()`（三个都会带上 `BAC.layer`）；
事件：`BAC.on('state'|'stage'|'timeline'|'feed'|'blocks'|'layer'|'health'|'agents'|'validators'|'epochs'|'summary', fn)`，
`state` / `feed` / `blocks` / `layer` / `health` 会重放给迟到的监听者。

## RPC 层（逐字照抄 `docs/research/04-website-conventions.md` §1.3）

- `FetchRequest` `timeout = 15000`，`retryFunc` 恒返回 `false`（429 直接失败换节点，不走 ethers 的长退避）；
- `JsonRpcProvider(req, net, { staticNetwork, batchMaxCount: 1, cacheTimeout: -1 })`；
- 每个 URL 独立指数退避：`min(120000, 15000 × 2^(fails−1))`，退避中的排到健康节点后面，但**不彻底放弃**；
- **revert 不换 RPC**（同一个 revert 在每个节点上都一样）；超时 / 限速 / HTML 响应才换；
- Multicall3 `aggregate3`，分块 **80**，逐条判 `success`（失败那条的 key 是 `undefined`，不影响同批其它条）；
  首次用 `getCode(0xcA11…CA11)` 探针：返回 `'0x'` 才判定没有、改 6 并发的逐条 `eth_call`；探针本身没答上（网络）
  只影响这一轮，退避（5 秒起翻倍）到期再探；整块失败也会退回逐条。
- 索引器用同一条退避公式，基数 5 秒（它是我们自己的服务，重试可以积极一点）；连续 **2** 次失败才宣布降级。

## 与文档的已知分歧（按规矩：以合约源码为准，在这里记一笔）

1. **`ChainAnchor.Anchor` 结构**：本层按 `contracts/src/interfaces/IChainAnchor.sol` 的 **12 字段**解码。
   SPEC §11.4 的 `proposerIncomeRoot` / `gasFeesInEpoch` / `remittedInEpoch` / `proposerCount` 合约里没有 → `null`；
   SPEC 的 `cumulativeGasFees()` / `cumulativeRemitted()` 合约里也没有 → **不读**（以前每轮都 revert）。
2. **`ValidatorStaking` 的 §11.5 增补**（`proposerRights` / `proposerAddressOf` / `qualifyStreak` / `remitStatus` /
   `withheldOf` / `lastRemitEpoch`）在 `contracts/src/ValidatorStaking.sol` 里不存在 → **不读**，`lastRemitEpoch` 恒为 `null`。
   决策 #17 的「已收 / 已转入 / 差额」因此只有一个真实来源：索引器 `/api/health` 的 `gas` 块（来自 FINAL 锚点，
   单位层内 BAC）。索引器读不到、或一个 FINAL 锚点都还没有（`lastAnchoredEpoch = null`，那时的 `"0"` 是占位）→ `validators().gas = null`。
   `unit.mjs` 的 `abi` 组用网站自带的真 ethers 把数据层每一条 ABI 和 `contracts/out` 逐条核对，再漂移就会红。
3. **`docs/03-INTERFACES.md` §3.7** 还没写：`/api/validators` 的归集字段按 `01 §11.5` 的名字读，索引器没给就是 `null`。
4. **索引器 v2 的字段名**（`indexer/src/api/handlers.js`）两版都认：
   `/api/agents`（`bac/agents/2`）`creditsLocked` / `creditsExited` / `layerWallets[]` / `holder` / `identityExists` /
   `registrationName`（→ `selfReported.name`，持有人自述）/ `lockCount`，旧名 `credited` / `exited` / `wallet` 兜底；
   `/api/rate`（`bac/rate/2`）`bacPerCredit` / `buybackBac` / `unit`，旧名 `weiPerCredit` / `poolBalance` 兜底
   （`state.rate` 两套键名都给，单位看 `unit`）；`/api/health` 的 `reconcile` 连同 `genesisSupply` / `genesisAlloc` /
   `genesisAllocAccounts` / `genesisSource` / `note` 一起转交（公式里有 `genesisAlloc`，不给就看不出 diff = 0 是怎么来的）；
   `GET /api/bridge/timeline` 见上面「时间线为什么可能不全」。v1 的状态字段一律作废成 `null`。
5. `BacBridge.shortfall()` 在代币发射前会 revert（它要读代币余额）：此时 BNB 缺口由 `bnbBalance()` 与
   `Multicall3.getEthBalance(bridge)` 两个真实读数推出（`shortfall.source = 'derived'`），BAC 缺口只在账面为 0 时确定为 0。
6. **配置防御**：`rpcs` / `logRpcs` 写成字符串当一个的数组，乱写当空数组（以前字符串会让 `withRead` 同步抛出、整个 BSC 刷新停摆）；
   没写 `logRpcs` 时从 `rpcs` 里挑、但**排除 bsc-dataseed**（它的 `eth_getLogs` 一律 `-32005`）。
   接线核对里配置还没填的地址（`'0x0'`）算「没法核对」，不算对不上；`marketAddressOk` 在 router 没填时是 `null`。
7. **`BacBridge.router()` 是 PancakeSwap V2 Router**（毕业后回购走外盘，`DeployBac.s.sol` 的 `BAC_PANCAKE_ROUTER`），
   **不是** BacTaxRouter。数据层把它叫 `bridge.dexRouter`，接线核对拿它和 `C.PANCAKE_V2_ROUTER`
   （`0x10ED43C718714eb63d5aA57B78B54704E256024E`，配置 `pancakeRouter` 可覆盖）比，报错名是 `bridge.dexRouter`；
   税收那一侧照旧核对 `router.bridge` / `router.nodeFund`。

## 测试

```bash
node artifacts/data-check/unit.mjs               # 全部（1238 条）
node artifacts/data-check/unit.mjs --only=layer  # shape|fmt|rpc|multicall|config|stages|router|owner|agents|bsc|api|layer|degraded|review|release|abi
node artifacts/data-check/unit.mjs --release     # 上线前：web/site.config.js 没有已锁定的代币地址（#35）或还有 v1 键就算失败
```

`layer` 这一组用一个假的 Besu 节点（字段照真节点实测：`miner` 有值、`baseFeePerGas` 是 `0x0`、
`txpool_status` 返回 `-32601`、批量数组体可用），验：形状、主端点 → 兜底的切换、
请求数上限、后台标签页退到慢档、两个端点全挂时 `status='error'` 且一个数都不编。

离线跑：假 ethers、假 fetch、`node:vm` 里的假 `window`；
`document` / `localStorage` / `navigator` 是陷阱对象，**碰一下就算失败**（数据层不许有 DOM 代码）。
