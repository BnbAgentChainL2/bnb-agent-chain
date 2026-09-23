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

## 两个开关，两半数据（**最容易搞错的一条**）

```
BAC.LIVE        = isAddr(cfg.vault)   // BSC 上的代币发射了没有
BAC.LAYER_LIVE  = 层内那条链的 RPC 现在答不答话
```

**这两个开关完全独立，谁也不许管谁。**

- `BAC.LIVE` 只挡 **BSC 侧**：金库 / 桥 / 验证者质押 / 纪元锚点 / agent 注册表。
  这些合约现在**真的还不存在**，所以它们显示「发射后公布」是对的。
- 层内那条链**现在就在出块**（Besu QBFT，3 秒一块，chainId 56777）。
  它的块高、区块、交易、gasLimit、baseFee **不许经过 `BAC.LIVE`**，
  否则页面会把真实存在的链上数据写成「发射后公布」—— 这是骗人。
  层内那一半走 `bac-view.js` 里的 `layerStatus()`，只看「读到没有」。

| 这一半 | 首选来源 | 退路 | 都挂了会怎样 |
|---|---|---|---|
| 金库 50/50、桥、验证者质押、纪元锚点、agent 计数 | **BSC 公共 RPC 直接读合约**（`bac-chain.js`） | 换一个公共 RPC | 整段显示「读取失败 · 重试中」 |
| **层内块高 / 区块 / 交易** | 索引器（有历史与聚合） | **`bac-layer.js` 直接打层内 JSON-RPC** | 三段各自 `status='error'`，显示「读取失败 · 重试中」，数字保持 `null` |
| agent 名录 / 实时动态 / 纪元历史 / 兑付率 / 搜索 | **索引器 HTTP API**（`bac-api.js`，`docs/03-INTERFACES.md` §3） | 没有退路（RPC 给不出这些） | 显示「读取失败 · 重试中」，**BSC 那半照常刷新** |

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
BAC.TEXT.PRE           = '发射后公布'                    // 发射前
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

## 视图模型（绑定层直接用这几个）

每个都返回一个 `status`：`'pre' | 'loading' | 'error' | 'ok'`。

`chainStats()` / `blocks()` / `txs()` 走 `layerStatus()`（**不看 `BAC.LIVE`**），
其余都走 `statusOf()`（发射前一律 `'pre'`）。

```js
BAC.view.chainStats()   // 块高、实测出块间隔、gasLimit、baseFee、gasPrice、peers、txpool、source、endpoint、纪元、对账三件套
BAC.view.feed(limit)    // 实时动态；每条自带 anchorNote 与 untrusted 标记
BAC.view.blocks(limit)  // 最新区块
BAC.view.txs(limit)     // 最新交易
BAC.view.agents(opts)   // agent 名录 + 各状态计数；totalFromChain 是 BSC 上直接读的兜底
BAC.view.treasury()     // 金库：50/50 两桶、金库真实余额、决策 #10 的披露原文
BAC.view.bridge()       // 桥：锁仓/发行/退出/桥池/兑付率/暂停停机
BAC.view.validators()   // 验证者 + 层内 gas 归集的「已收 / 已转入 / 差额」三元组
BAC.view.epoch()        // 当前纪元、上报/定案进度、锚点详情、纪元历史
BAC.view.overview()     // 整页横幅、警告、地址表
```

开关：`BAC.start()` / `BAC.stop()` / `BAC.refresh()`（三个都会带上 `BAC.layer`）；
事件：`BAC.on('state'|'feed'|'blocks'|'layer'|'health'|'agents'|'validators'|'epochs'|'summary', fn)`，
`state` / `feed` / `blocks` / `layer` / `health` 会重放给迟到的监听者。

## RPC 层（逐字照抄 `docs/research/04-website-conventions.md` §1.3）

- `FetchRequest` `timeout = 15000`，`retryFunc` 恒返回 `false`（429 直接失败换节点，不走 ethers 的长退避）；
- `JsonRpcProvider(req, net, { staticNetwork, batchMaxCount: 1, cacheTimeout: -1 })`；
- 每个 URL 独立指数退避：`min(120000, 15000 × 2^(fails−1))`，退避中的排到健康节点后面，但**不彻底放弃**；
- **revert 不换 RPC**（同一个 revert 在每个节点上都一样）；超时 / 限速 / HTML 响应才换；
- Multicall3 `aggregate3`，分块 **80**，逐条判 `success`（失败那条的 key 是 `undefined`，不影响同批其它条）；
  首次用 `getCode(0xcA11…CA11)` 探针，探不到就退回 6 并发的逐条 `eth_call`；整块失败也会退回逐条。
- 索引器用同一条退避公式，基数 5 秒（它是我们自己的服务，重试可以积极一点）；连续 **2** 次失败才宣布降级。

## 与文档的已知分歧（按规矩：以 SPEC 为准，在这里记一笔）

1. **`ChainAnchor.Anchor` 结构**：本层按 `docs/01-CONTRACT-SPEC.md` §11.4 的 **15 字段**版本解码
   （多了 `proposerIncomeRoot` / `gasFeesInEpoch` / `remittedInEpoch` / `proposerCount`）。
   `contracts/src/ChainAnchor.sol` 目前仍是决策 #17 之前的 12 字段版本。
   合约按 SPEC 改完之前，`getAnchor()` 这一条会解码失败 —— 它在 Multicall3 里是**单独一条**，
   失败只会让锚点详情为空，不会拖垮同批其它读数。
2. **`ValidatorStaking` 的 §11.5 增补**（`proposerRights` / `remitStatus` / `withheldOf` / `lastRemitEpoch`）
   在 `contracts/src/ValidatorStaking.sol` 里还不存在，同理：单条失败 → 对应字段为 `null`。
3. **`docs/03-INTERFACES.md` §3.7**（决策 #17 点名的「验证者 gas 对账」API 章节）**还没写**。
   本层对 `/api/validators` 的每个条目按 `01 §11.5` 的字段名读 `cumOwed` / `cumRemitted` / `arrears` /
   `shortfall` / `proposerRights` / `proposerAddr` / `qualifyStreak` / `withheld`：
   **索引器没给就是 `null`，绝不猜、绝不用 0 顶替**。§3.7 定稿后如果字段名不同，改这一处 + 测试。

## 测试

```bash
node artifacts/data-check/unit.mjs               # 全部（486 条）
node artifacts/data-check/unit.mjs --only=layer  # shape|fmt|rpc|multicall|bsc|api|layer|degraded
```

`layer` 这一组用一个假的 Besu 节点（字段照真节点实测：`miner` 有值、`baseFeePerGas` 是 `0x0`、
`txpool_status` 返回 `-32601`、批量数组体可用），验：形状、主端点 → 兜底的切换、
请求数上限、后台标签页退到慢档、两个端点全挂时 `status='error'` 且一个数都不编。

离线跑：假 ethers、假 fetch、`node:vm` 里的假 `window`；
`document` / `localStorage` / `navigator` 是陷阱对象，**碰一下就算失败**（数据层不许有 DOM 代码）。
