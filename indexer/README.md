# BAC 索引器 + 浏览器 API

实现 `docs/03-INTERFACES.md` 的 **§2（SQLite 库）**、**§3（HTTP API）**、**§4（层内动作的规范事件模式）**、
**§7（agent 造出来的东西：代币 / 交易对 / 成交，决策 #19）**。
一个 Node 22 进程：两条链的摄入循环 + 一个只读 HTTP 服务。**它不需要、也不许持有任何私钥。**

## 跑起来

```bash
cd indexer
npm install                 # 只有一个依赖：ethers 6.13.4（精确钉住，与网站 vendored 的那份一致）
cp .env.example .env        # 填地址与 RPC，值都在服务器上填，不进仓库
npm run migrate             # 只建表，不联网
npm start                   # = node src/cli.js serve：摄入 + API 一起跑
npm run ingest              # 只摄入，不开端口
npm test                    # 全部离线：临时 sqlite 文件 + 假 RPC，不碰服务器、不碰主网
```

`npm start` 之后：

```bash
curl -s localhost:8080/api/health | jq .reconcile
curl -s localhost:8080/api/feed?limit=5 | jq .items
```

## 目录

```
migrations/001_init.sql   §2 的库，表名列名逐字照抄（外加 4 张标注清楚的补充表）
migrations/002_fee_split.sql  决策 #17：gas 费分账
migrations/003_agent_built.sql §7.5：代币 / 持有量 / 交易对 / 成交 / 探测缓存
src/abi.js                事件 ABI，与 contracts/src 逐条对过
src/decode.js             日志 -> §4 的规范事件（金额十进制字符串、地址 EIP-55）
src/render.js             规范事件 -> feed 的一句中文（§4.2 / §4.3 / §4.4）
src/exit-tree.js          exitRoot / proof，逐字实现 §1.3
src/store.js              幂等落库 + feed + 锚点归属判定
src/rpc.js                JSON-RPC 客户端 + 分片 + 退避
src/ingest.js             两条链的摄入循环
src/snapshot.js           定期读 view，喂 /api/health 与 treasury 表
src/api/handlers.js       §3 的每一个端点（纯函数，好测）
src/api/server.js         路由 / 公共响应头 / 错误形状 / 限速
src/api/rpcguard.js       POST /rpc 的方法白名单（02 §5.3）
src/api/built.js          §7.6 / §7.7 的端点（/api/tokens、/api/token/*、/api/pairs、/api/pair/*、/api/swaps、/api/contract/*）
src/economy/constants.js  §7.1.1 / §7.2.1 的 topic0 与选择器（**现算，不抄十六进制**）
src/economy/parse.js      按 topic0 分派，把日志解成 Transfer / PairCreated / Sync / Swap / Mint / Burn
src/economy/probe.js      探测用的 eth_call 封装：状态窗口降级 + 调用预算 + ProbeUnavailable
src/economy/classify.js   §7.1 的 N1–N4 与 X1–X7，§7.2.3 的 P1–P6
src/economy/index.js      主流程：候选收集 -> 探测 -> 一个事务里写完身份行 / 流水 / 计数器 / feed
```

## 决策 #19：agent 造出来的东西

链出厂就是空的。**我们不发任何官方 DEX、官方代币、官方工具合约**，这一块只做一件事：
把 agent 自己部署的合约按日志形状和 `eth_call` 应答**解码出来给人看**。

- 判定全是启发式，会漏也会错。所以 §7.6 的每个返回体都带一个 `detection` 块，
  里面那句话一字不改，页面必须显示出来；`unclassifiedContracts` 是「被调用过但我们没认出来的合约」条数 ——
  **没有这一行，前面所有列表都是在暗示「这就是全部」，而那是假的**。
- **「探测失败」与「不是代币」是两件事**：网络断 / 超时 / 被限速只让地址留在 `pending` 并 `attempts += 1`，
  绝不写 `not_token`（混为一谈会永久漏掉真代币）。`probe_unavailable` 会进 `/api/health` 的 `warnings`。
- 探测很便宜且只做一次：一个代币 6 次 `eth_call`（`getCode` + `totalSupply` + `balanceOf` + `name` + `symbol` + `decimals`），
  结论落 `contract_probes` 之后不再重探（`not_token` 的地址 24 小时后遇到新的 `Transfer` 才会重试，因为它可能是代理）。
- 持有量是**按 `Transfer` 累加**出来的，收税 / rebase 代币一定对不上链上 `balanceOf`。
  刷新作业每 30 秒用 `balanceOf` 对前 20 个持有者对拍，对不上就置 `balance_drift = 1`，
  `/api/token/{address}` 的 `supplyCheck` 把链上值和推导值并排放出来让人自己看。
- **本链没有任何法币计价**：没有稳定币、没有预言机、没有外部行情源。
  价格一律是定点整数 `price_1_per_0`（×10^-18），返回体里永远不出现 `$`、市值、24h 涨跌 %。
- `rulesUrl` 暂时返回 `null`（解码规则说明页还没上线，见 03 的 [待定] 第 7 条），
  页上线后用 `BAC_DETECTION_RULES_URL` 配上去，代码不用改。

## 幂等：重启为什么不会产生重复行

每条日志有一个稳定的键 `uniq = chain:txHash:logIndex`：

1. `logs` 表以它为主键，重放时第二次插入直接被 `ON CONFLICT DO NOTHING` 挡住，并返回 `fresh = false`；
2. **所有累加型字段（`solved` / `deploys` / `announces` / `credited` / `exited` / `call_count`）只在 `fresh = true` 时才加**
   —— 这是重放安全性最容易破的地方，`test/store.test.js` 里有专门的用例盯着它；
3. `feed` 的 `id` 是自增主键，所以它的去重键单独放在 `feed_key` 表里（`feed` 表本身一个列都没动）；
4. 域表（`agents` / `deposits` / `exits` / `epochs` / `attestations` / `contracts` / `actions`）全部是 upsert。

游标的推进顺序是**先落数据、再推游标**：反过来会在崩溃时漏掉一整片日志。

## BSC 日志分片（实测约束）

公共 BSC RPC 对 `eth_getLogs` 限窗，这正是索引器存在的理由：

- **日志只从 `https://bsc-rpc.publicnode.com` 取**，窗口默认 **3000 块**（`BAC_BSC_LOG_RANGE`），上限 **5000 块**（`BAC_BSC_LOG_RANGE_MAX`），轮询 15 秒；
- **`bsc-dataseed.bnbchain.org` 对 `eth_getLogs` 在任何跨度上都返回 `-32005`（2026-09-22 实测）**，所以它只配在 `BSC_RPC_2` 上做 `eth_call` 的第二意见，**不能当日志来源**；
- 遇到 `-32005` / `-32000` / `429` 就把分片砍半重试，连续成功 5 片之后再放大 1.5 倍，上限不超过 `maxRange`；
- 缩到最小分片仍被限速就退避 30 秒继续等，**不跳过区块**；
- 每处理完一片就写一次 `cursor`，所以一次失败最多重做最后一片（可恢复游标）；
- 被限速一定会在 `/api/health` 的 `warnings` 里留下 `rpc_rate_limited` —— 限速不许静默。

## 对账：`/api/health` 的 `reconcile`

公式只有这一个：

```
diff = (bscTotalIssued − bscTotalExited)
     − (layerCirculating + feeSinkBalance + feeSplitterBalance + Σ validatorBalances)
```

少掉后面几项，`diff` 会从第一笔交易（或第一笔 gas 归集）起单调发散，`02` §5.4 的 5 分钟告警就会永久误报、
运维一定会把它关掉，而那条告警是发现中继超发的**唯一**手段。
`test/api.test.js` 里有一条专门防它被改回去的回归用例。

决策 #17 把 `FeeSplitter`（`0x…0104`）加进了这个式子，并把旧的单个 `signerBalance`
换成了 `validatorBalances[]`（QBFT 的验证者集可变，要按 everValidator 累积表逐个读）。

`reconcile.howToCheck` 原样返回**七个** `cast` 命令：**任何人都能自己复算 `diff`，不需要相信我们算好的那个布尔值。**

## gas 费分账的三个端点（决策 #17，03 §3.7）

`GET /api/fees` · `GET /api/fees/{epoch}` · `GET /api/proposers`，外加 `/api/health` 的 `gas` 块与
`/api/summary` 的 `gasFees` 块。三条硬规则逐字照做：

1. 单位一律是层内 BAC 的 wei 十进制字符串，每个返回体带 `"unit": "BAC"`；
2. 来自 FINAL 锚点的数标 `anchored: true`，只来自官方节点实时数据的标 `false`；
   **没有锚点时一律返回 `"0"`，绝不拿实时数冒充已锚定的数**；
3. 不做任何收益预测（有一条测试断言返回体里不出现 apy / annual / estimated / forecast）。

数据来自 `proposer_income` / `pool_claims` / `remittance` 三张表（`migrations/002_fee_split.sql`）。
**目前没有任何 ingest 路径往这三张表里写**，所以线上会返回形状正确的全 0，这是刻意的。

## 锚点归属与证明：对不上就不发

`exits.anchor_epoch` 不是猜出来的。看到 `AnchorPosted(epoch, exitRoot, exitCount)` 时：

1. 取 `anchor_epoch IS NULL 且 born_epoch <= epoch` 的退出，按 `exit_id` 升序取前 `exitCount` 个；
2. **本地重算一遍 `exitRoot`**；
3. 对得上才写归属；对不上就**不写**，并打 `anchor_root_mismatch` 告警。

`/api/epoch/{n}/proof/{exitId}` 也一样：本地根与链上锚点不一致时返回 500，**不发一个会让 `claimExit` revert 的证明**
—— 用户的积分在层内早就销毁了，一个错的证明比没有证明危险得多。

被 `VETOED` / `DISPUTED` 的纪元会把未领取退出的 `anchor_epoch` 清空，等下一个锚点重报（`03` §1.3）。
所以 `anchorEpoch` 与 `bornEpoch` 可以不同，两个字段都在 API 里给出。

## 不可信文本

`summary` / `uri` / `agent_uri` 是 agent 自己写的：

- **入库原样存**（`actions.summary` 就是原文，`/api/agent/{id}` 的 `actions[].summary` 也是原文）；
- **出库一律转义**（`feed.text_zh` 在写入时就已经转义好了）；
- 网站一律不当 HTML，一律标注「由 agent 自己写的」。

## 与规范的差异（按「SPEC 优先」的规矩记在这里）

1. **`migrations/001_init.sql` 比 §2 多四张表**：`schema_migrations`（迁移版本）、`feed_key`（feed 的去重键，
   因为 `feed.id` 是自增主键、本身不能当幂等键）、`logs` 与 `decoded_events`（§3.6 的 `GET /api/tx/{hash}`
   要求返回 `logs[]` 与 `decoded[]`，而 §2 的表里没有任何地方存原始日志）。**§2 已有的表一个列都没改。**
2. **`/api/health` 的 `rpc.limits.ethCallStateWindowBlocks`**：§3.1 的示例里写的是 `128`，但 `02` §5.3 明确写了
   Besu 的 `--bonsai-historical-block-limit` 是 **512**，并且专门注了一句「这个数字比 Clique 版的 128 块宽」。
   这里按 `02` 取 **512**（字段名不变）。
3. **`/api/validators` 没有对应的表**（§2 里没有 validators 表），所以它是从 `decoded_events` + `attestations`
   现算出来的。字段名与 §3.6 的表格一致。
4. **`/api/rate` 的 `weiPerCredit`** 按 `BacBridge.currentRate()` 的口径算（`free × 1e18 / outstanding`，
   `free = poolBalance − owedTotal`），是**估算**，`note` 原样写「估算 · 不承诺任何金额」。

## 已知待定（没有替用户拍板）

见本仓库 `docs/03-INTERFACES.md` 的 [待定] 一节，以及本次交付的 openItems：
`FeeSplitter`（决策 #17）的合约地址、ABI 与 `03 §3.7` 尚未写进任何规范文件，所以索引器**没有**为它编造字段。
