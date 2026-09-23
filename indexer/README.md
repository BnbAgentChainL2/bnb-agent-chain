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
migrations/004_bsc_v2.sql BSC 侧 v2：treasury 整张重建（旧行删除、不保留；有非 0 旧行时迁移失败），agent_wallets / agent_identity 两张表
src/abi.js                事件 ABI，与 contracts/out 的编译产物逐条对过（test/decode.test.js 有自动核对）
src/genesis.js            从创世文件读出 genesisSupply / bridgeAlloc / genesisAlloc 与文件哈希（对账的创世分配项）
src/text.js               不可信文本的字符清洗（控制字符 / 双向控制符 / 零宽字符）与链接 scheme 白名单，X4 与 ERC-8004 身份共用
src/identity.js           ERC-8004 身份读数（ownerOf / getMetadata("agentWallet") / tokenURI）与注册文件解析
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

- **日志只从 `BSC_RPC` 取**，窗口默认 **3000 块**（`BAC_BSC_LOG_RANGE`），上限 **5000 块**（`BAC_BSC_LOG_RANGE_MAX`），轮询 15 秒；
- **`https://bsc-rpc.publicnode.com` 只给最近约 7k–20k 块（1–2.5 小时）的日志**：更老的一段返回
  `-32602 Archive requests require a personal token…`（2026-09-23 只读探测：链头 123540779 往回 3000 / 7000 块 OK，20000 块报错）。
  所以它只够「一直在线、紧跟链头」的日常摄入；**首次回填、或停机超过这个窗口之后的追赶，必须用能查历史的、带密钥的日志 RPC**。
  这个错误不是限速：不砍分片、不重试，游标停在原地、不跳过任何区块，`/api/health` 告警 `bsc_log_history_unavailable`；
- **`BAC_BSC_START_BLOCK` 必须设成部署交易所在的块**（或略早几块），并且落在日志 RPC 能查到的窗口之内。
  配了 BSC 合约地址却留成 0，BSC 摄入拒绝启动并告警 `bsc_start_block_unset`（从第 0 块扫只会永远卡在第一片上）；
- **`bsc-dataseed.bnbchain.org` 对 `eth_getLogs` 在任何跨度上都返回 `-32005`（2026-09-22 实测）**，所以它只配在 `BSC_RPC_2` 上，
  给快照的只读 view（`eth_call` / `getCode` / `getBalance` / `getStorageAt`）在主 RPC 出网络错误或限速时兜底（`FailoverRpc`），
  **不能当日志来源**（`eth_getLogs` 永远只走 `BSC_RPC`）。两路都配了时主 RPC 只给 **5 秒超时、重试 1 次**
  （Rpc 的默认值是 20 秒 × 6 次加退避，约 135 秒才轮到第二个，快照每 30 秒要串行打 60–90 个 `eth_call`），
  第二个给 10 秒、重试 2 次；这个对象跨快照复用，换到第二个之后一直用它，**10 分钟后**再回头试主 RPC；
- 遇到 `-32005` / `-32000` / `429` 就把分片砍半重试，连续成功 5 片之后再放大 1.5 倍，上限不超过 `maxRange`；
- 缩到最小分片仍被限速就退避 30 秒继续等，**不跳过区块**；
- 每处理完一片就写一次 `cursor`，所以一次失败最多重做最后一片（可恢复游标）；
- 被限速一定会在 `/api/health` 的 `warnings` 里留下 `rpc_rate_limited` —— 限速不许静默。

## BSC 侧 v2（决策 #29 / #30 / #31 / #32 / #33 / #35）

- **没有金库、没有工厂、没有我们自己的注册表了。** 税收路径是 Flap TaxProcessor → `BacTaxRouter`（无 owner、不可升级）
  → 50/50 推给 `BacBridge` 与 `BacNodeFund`。`/api/health` 的 `vault` 块换成了 `router` 块。
- **`BacBridge` 是 UUPS 代理**，owner（部署钱包）可以随时升级、随时取走桥池全部资金。
  `/api/health.bridge` 给出 owner / 实现合约地址（读 EIP-1967 槽）/ 升级次数 / 紧急提取次数与累计额 / `shortfall`；
  每一次升级、紧急提取、owner 变更都在 `GET /api/bridge/timeline` 里按时间倒序公开（决策 #29c）。
- **一个 agent = 一个锁过桥的 ERC-8004 身份 id**（`BacBridge.Locked` 带着 `agentId`）。没有状态机。
  索引器只对这些 id 读注册表（`ownerOf` / `getMetadata(id,"agentWallet")` / `tokenURI`），每轮快照读一小批；
  注册文件是持有人自己写的，API 一律 `selfReported: true`，外部链接不抓取、图片不加载。
  **只有 `https:` / `ipfs:` / `ar:` 算链接**：`tokenURI` 是别的东西（裸字符串、`0x…`、`http:`、`javascript:`）时
  `kind = 'text'`，清洗后放在 `registration.text`（`javascript:` / `data:` 这类连文本都不给），不放进 `uri`；
  `image` 不是这三种 scheme 就丢掉，`services[].endpoint` 照样给出（ERC-8004 允许 ENS 名、`did:` 之类）但只有这三种标
  `linkable: true`，`javascript:` / `vbscript:` / `data:` / `file:` / `blob:` 丢掉；丢掉了什么列在 `registration.dropped`。
  名字、介绍、服务名等文本去掉控制字符、双向控制符（RLO 之类）与零宽字符（`src/text.js`，与代币名的 X4 同一张字符表）。
  这套清洗存库前做一次、出库时再做一次，旧规则存下的行发出去也是干净的。
  **持有 ERC-8004 身份不能证明对方是 AI**，这句话跟着每一个身份块走。
- **三个阶段**（`/api/health.stage`）：`none`（合约还没部署）→ `contracts_deployed`（部署了、代币地址上还没有代码）
  → `token_launched`。第二阶段里合约自己的状态（0 余额、owner、0 次升级、空时间线）是真的，照实返回；
  价格 / 税率 / marketAddress 核对这些**根本不存在**，返回 `null`。合约都不存在时不写 treasury 行（写一串 0 就是编数据）。
- **treasury 表在 004 里整张重建**：001–003 时代的快照在合约根本不存在时每 30 秒写一行 `"0"`（线上几百行全是），
  没有一行是测量值，所以**全部删除 —— 不是改名保留，升级后没有任何 v1 的 treasury 历史，也没有备份表**。
  删之前 004 先核一遍：只要有一行的任何一列不是 `"0"`（或 `market_address_ok` 不是 0），迁移就失败、整体回滚、索引器拒绝启动
  （错误信息里有 `004 refuses to drop treasury`）；那时先把 treasury 导出来、人工确认，再手工处理。
  列改成可空 —— 某一轮没读到的 view 写 `NULL`，API 给 `null`，`"0"` 只表示链上真的读到了 0。
  `stage = 'none'` 时 `/api/summary` 的 treasury / bridge 块全是 `null`、`/api/rate` 的 `bacPerCredit` 是 `null`、
  `/api/treasury` 是空数组；配了 `BAC_BSC_START_BLOCK` 时比部署块更早的行一律不认。
- **接线核对**：桥读的 ERC-8004 注册表不是 `0x8004A169…a432`、桥上的 `OWNER_POWER_NOTICE()`（或 `description()`）
  与决策 #29a 那句话不逐字一致、桥 / 路由的 `bacToken()` 不是锁定的代币地址、路由的 `bridge()` / `nodeFund()` 不是配置里的地址 ——
  各自打一条告警（`identity_registry_mismatch` / `owner_notice_mismatch` / `bac_token_mismatch` / `router_wiring_mismatch`），
  `/api/health.ok` 随之变 `false`。
- **`BAC_ADDR_BRIDGE` 必须是代理**：地址上有代码但 EIP-1967 实现槽是空的（多半填成了实现合约）时打 `bridge_not_proxy`，
  `/api/health.bridge.isProxy = false`，它的 view 一个都不读、不写 treasury、不拿来核接线、对账里的 BSC 发行量是 `null` ——
  实现合约自己的存储是空的，读出来的「0 余额、没有 owner」不是桥的真状态，它也从来不发 `Locked` 事件。
- **`shortfall`**：代币发射后调 `BacBridge.shortfall()`；它调不通就用 `BAC.balanceOf(bridge)` 按同一公式在链下重算，
  也读不到就是 `null`（绝不拿账面 `bacAccounted` 冒充缺口）。
- **ERC-8004 身份读数**：`tokenURI` 按 `bytes` 解、宽松转 UTF-8 —— 持有人往注册文件里塞非法 UTF-8 只会让它自己记成
  `unparsable`，不会卡住别的身份；某一个身份解码失败只记在它自己身上，这一轮接着读别的，下一轮它排在最后。
- **纪元单位统一成 600 秒**（决策 #20：`ChainAnchor.EPOCH = L2Bridge.EPOCH = BacBridge.EPOCH = 600`）：
  `blocks.epoch` / `feed.epoch` / `swaps.epoch` / `summary.epoch.current` 与 `epochs` 表同一个编号（004 把旧行按 `ts / 600` 重算）。
  `AgentBook.EPOCH` 仍是 86400，它的天序号只留在 `actions.epoch`。
  **层内条目是否「已锚定」按块高判断**：块 ≤ 最新 FINAL 锚点的 `l2Block` 才算（`/api/feed.anchoredThroughBlock`），不拿纪元号比。
  注意：`relayer/` 与 `sdk/` 的 `epochOf` 在写这段时仍是 86400，要与合约的 600 对齐（不在本目录的改动范围内）。
- **schema 标签**：v2 改了形状的端点都升到了 `/2`：`bac/health/2`、`bac/summary/2`、`bac/treasury/2`、`bac/agents/2`、`bac/agent/2`、`bac/rate/2`。
- BSC 只对我们自己的合约跑 `eth_getLogs`；代币、Portal、TaxProcessor、ERC-8004 注册表只读 view。
- `eth_call` 被合约 revert 是确定性结果，不重试（以前会重试 5 次、白等 15 秒）。

## 对账：`/api/health` 的 `reconcile`

旧公式（03 §3.1，加创世分配项）现在叫 `rawDiff`：

```
rawDiff = (bscTotalIssued − bscTotalExited + genesisAlloc)
        − (layerCirculating + feeSinkBalance + feeSplitterBalance + Σ validatorBalances)
layerCirculating = genesisSupply − B(L2Bridge) − B(FeeSink) − B(FeeSplitter) − Σ B(validator)
```

把 `layerCirculating` 代进去，FeeSink / FeeSplitter / 验证者余额两边相消，剩下
`rawDiff = bscTotalIssued − bscTotalExited − bridgeAlloc + B(L2Bridge)`。**它在正常运行里就不是 0**：
锁仓后中继还没 `credit()`、`credit()` 后 agent 还没 `withdrawCredits()`（L2Bridge 是 PULL 模式）、层内 `exit()` 后还没在 BSC
`claimExit()`、运营方 `burnFloat()`、任何人往 L2Bridge 直接转 1 wei（`receive()` 谁都能转；演练链上那把公开的 Hardhat 私钥也能），
都会让它变正 —— 以前拿「`diff ≠ 0`」告警，任何人都能免费把 `health.ok` 永久弄成 `false`，运维只会学会无视它。

所以现在按 **L2Bridge 自己的计数**（`totalCredited()` / `totalExited()` / `totalBurnedFloat()`，和余额钉在同一个块上读）
把 `rawDiff` 拆成四项，逐项放进 `reconcile.terms`：

| 项 | 公式 | 正常 | 变负意味着（告警键） |
|---|---|---|---|
| `creditsPendingRelay` | `bscTotalIssued − L2Bridge.totalCredited` | ≥ 0（中继延迟约 1 分钟） | 层内入账超过 BSC 发行：**中继超发**（`reconcile_overmint`） |
| `exitsPendingClaim` | `L2Bridge.totalExited − bscTotalExited` | ≥ 0（没人来领就一直为正） | BSC 兑付超过层内销毁（`reconcile_overclaim`） |
| `burnedFloat` | `L2Bridge.totalBurnedFloat` | ≥ 0 | 不可能 |
| `creditableAndDonations` | `B(L2Bridge) − (bridgeAlloc − totalCredited + totalExited + totalBurnedFloat)` | ≥ 0（已入账未提走 + 直接转进来的币） | 有币离开 L2Bridge 而计数解释不了，或创世文件与链对不上（`reconcile_unexplained_outflow`） |

`diff` = 负数项之和（正常运行里是 `"0"`），`ok = (diff == 0)`。有输入没读到、又没有负数项时 `diff` / `ok` 是 `null`
（不知道平不平），并告警 `reconcile_incomplete`，`health.ok` 为 `false` —— 这一轮读不到 BSC 时 `bscTotalIssued` 是 `null`，
不再拿 `"0"` 冒充（那样会把层内每一笔入账都误报成超发）。层内 RPC 读不到时 `layerCirculating` 等也是 `null`，不是 `"0"`。

合约地址上没有代码时（BSC 桥还没部署；演练链的创世没有系统合约，0x…0101 上没有 L2Bridge），它的计数按 0 参与计算
（合约不存在，不可能发生过入账 / 兑付），但发出去的读数是 `null`，按 0 计的项逐个列在 `structuralZeros` 里。

已知局限（`note` 里照实写着）：未提走的积分和直接转入合在 `creditableAndDonations` 一项里，一笔等额的转入能盖住等额的来历不明流出
—— 但那要真金白银地转进去；中继超发看的是两边的计数，盖不住。

**创世分配项**：`genesisSupply` 是创世文件里全部 alloc 的和，`bridgeAlloc` 是 L2Bridge 那一项，`genesisAlloc` 是其余部分 ——
从来没有经过 BSC 桥的币（演练链上是唯一的预置测试账户 `0x7099…79C8`，正式链上应当只有中继的运营浮存）。
`genesisAllocAccounts` 逐个列出地址；**`genesisSource` 是公开的下载地址 `${BAC_API_BASE}/api/genesis`，`genesisFileHash`
是那份文件的 keccak256（与 `/api/genesis` 的响应头 `X-Genesis-Hash` 逐字相同）** —— 以前这里给的是服务器上的文件路径，
路径里有登录用户名（决策 #6 不许公开），现在本机路径只在进程内用。读不到创世文件（`BAC_GENESIS_PATH`）时
退回「1e27 全在桥里」并告警 `genesis_unreadable`。

`reconcile.howToCheck` 原样返回**十一条**命令（一条取 `/api/genesis` + 十个 `cast`，L2Bridge 的三个计数和余额带 `--block <l2Bridge.block>`）：
**任何人都能自己复算每一项，不需要相信我们算好的那个布尔值。**

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
4. **`/api/rate` 的 `bacPerCredit`**（决策 #24：退出兑付的是回购来的 BAC，单位 BAC）按 `BacBridge.currentRate()` 的口径算
   （`free × 1e18 / outstanding`，`free = buybackBac − owedTotal`，`outstanding = totalCreditsIssued − totalCreditsExited`，
   outstanding 为 0 时是 0）。读得到链上 `currentRate()` 就用链上的，否则用同一次读数的四个输入现算；
   合约没部署或者一个读数都没有时是 `null`。它是**估算**，`note` 原样写「估算 · 不承诺任何金额」。
5. **按退出单领了多少（`/api/agent/{id}` 的 `exits[].collectedBac`）恒为 `null`**：`Collected` 事件只带
   `(who, to, amount, owedLeft)`、没有 `exitId`，没法把一笔领取归到某一笔退出上。
6. **`/api/health.gas` 的 `operatorFloatReserve` / `remitOverdueEpochs` / `poolPending` / `carryPool` / `foundationBalance`，
   以及 `/api/fees.splitter` 的 `lifetimeOfficialGross` / `lifetimeValidatorRemitted`、`/api/summary.gasFees` 的
   `foundationWithdrawn` / `carryPool` 都是 `null`**：它们要读层内 FeeSplitter，而快照还没有读它的代码。`null` = 没读，不是 0。

## 已知待定（没有替用户拍板）

见本仓库 `docs/03-INTERFACES.md` 的 [待定] 一节，以及本次交付的 openItems：
`FeeSplitter`（决策 #17）的合约地址、ABI 与 `03 §3.7` 尚未写进任何规范文件，所以索引器**没有**为它编造字段。
