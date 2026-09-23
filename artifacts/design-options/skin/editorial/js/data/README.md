# web/js/data · 网站数据层

这一层是**唯一碰链的代码**，暴露 `window.BAC`，**里面没有一行 DOM 代码**。
绑定层（`js/ui/bind.js`，另一个工作流负责）是它唯一的消费者。可视层不许自己发 RPC 或 fetch。

## 文件与加载顺序

```html
<script src="/site.config.js"></script>                       <!-- 同步，必须最先 -->
<script defer src="/vendor/ethers-6.13.4.umd.min.js"></script>
<script defer src="/js/data/bac-core.js"></script>            <!-- 配置 / 常量 / 格式化 / 事件总线 / 状态骨架 -->
<script defer src="/js/data/bac-chain.js"></script>           <!-- BSC 侧：RPC 轮换 + Multicall3 + 合约读 -->
<script defer src="/js/data/bac-api.js"></script>             <!-- 索引器 HTTP API：层内数据 + feed -->
<script defer src="/js/data/bac-view.js"></script>            <!-- 拼成页面要的视图模型 + BAC.start() -->
<!-- 之后才是 js/ui/*.js -->
```

缺依赖时每个文件只打印一条 `[BAC] …需要先加载 bac-core.js` 并什么都不做，不抛异常。

页面必须把可见性推给数据层（数据层不碰 `document`）：

```js
document.addEventListener('visibilitychange', function () { BAC.setHidden(document.hidden); });
```

## 两侧数据源

| 这一半 | 来源 | 挂了会怎样 |
|---|---|---|
| 金库 50/50、桥、验证者质押、纪元锚点、agent 计数 | **BSC 公共 RPC 直接读合约**（`bac-chain.js`） | 换 RPC 重试；整段显示「读取失败 · 重试中」 |
| 层内块 / 交易 / agent 名录 / 实时动态 / 纪元历史 / 兑付率 | **索引器 HTTP API**（`bac-api.js`，`docs/03-INTERFACES.md` §3） | **进降级模式**：层内那半显示「读取失败 · 重试中」，**BSC 那半照常刷新** |

降级模式（`state.indexer.degraded`）还有最后一跳：如果配了 `layerRpc`，直接向它要一次
`eth_blockNumber`，只为回答「链还活着吗」，并把 `state.layer.source` 标成 `'rpc'`（正常时是 `'indexer'`）。
这一跳**不会**伪造时间戳、peers、交易数 —— 不知道的一律是 `null`。

## 必须逐字的文案

```
BAC.TEXT.PRE           = '发射后公布'                    // 发射前
BAC.TEXT.ERR           = '读取失败 · 重试中'              // 读取失败
BAC.TEXT.NOT_ANCHORED  = '未锚定 · 仅来自官方节点'        // feed 里 anchored === false 的条目
BAC.TEXT.NO_INDEXER    = '索引器读不到：层内数据暂时不可用，BSC 侧数字仍然是实时的'
```

**永远不显示演示值。** `null` = 不知道，绑定层不许把它当 0 渲染。
金额一律是 `BigInt`（wei），只经 `BAC.fmt.*` 格式化；时间一律是秒，显示一律转北京时间（`BAC.fmt.beijing`）。

## 视图模型（绑定层直接用这几个）

每个都返回一个 `status`：`'pre' | 'loading' | 'error' | 'ok'`。

```js
BAC.view.chainStats()   // 块高、出块间隔、gasLimit、baseFee、peers、纪元、对账三件套（含 howToCheck 原样透传）
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

开关：`BAC.start()` / `BAC.stop()` / `BAC.refresh()`；事件：`BAC.on('state'|'feed'|'blocks'|'health'|'agents'|'validators'|'epochs'|'summary', fn)`，
`state` / `feed` / `blocks` / `health` 会重放给迟到的监听者。

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
node artifacts/data-check/unit.mjs              # 全部
node artifacts/data-check/unit.mjs --only=rpc   # shape|fmt|rpc|multicall|bsc|api|degraded
```

离线跑：假 ethers、假 fetch、`node:vm` 里的假 `window`；
`document` / `localStorage` / `navigator` 是陷阱对象，**碰一下就算失败**（数据层不许有 DOM 代码）。
