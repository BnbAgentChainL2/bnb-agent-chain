# 本地端到端彩排（11 步）· `artifacts/e2e/run.sh` 的规格

00-DESIGN-SPEC.md G8 / D5 要求的那一份：**11 步，结尾必须打印 `E2E PASSED`**。
这份文件是 `run.sh` 的规格，逐条写清「跑什么命令 / 它证明了什么 / 不过怎么办」。

**现在还没有跑过。** 本机没有装 Docker（服务器上才有），所以第 2 步之后全部没有执行过。
每一步都标了 `[本机]` 还是 `[要服务器/要 Docker]`。标了 `[要服务器/要 Docker]` 的步骤，
在本机上只能跑它的「离线替身」（写在每一步的最后一行），替身**不算数**，
只有真容器跑出来的 `E2E PASSED` 才算数。

**三条纪律**（和中继一样，不可选）：

1. **宁可停，不可错。** 任何一步的断言不成立就立刻退出、打印那一步的编号与实际值，不往下跑。
2. **不碰真网。** 全程只连本地 anvil 与本地 Besu 容器。分叉用固定区块号（`--fork-block-number`），
   这样重跑结果一样；不写任何主网交易。
3. **不打印私钥。** anvil 的助记词是公开的测试助记词，但脚本仍然只按变量名传，输出里不回显。

**前置条件**

| 工具 | 版本 | 用途 |
|---|---|---|
| Foundry | forge 1.7.1 / anvil | 假 BSC（主网分叉）与 `cast` 断言 |
| Docker | 任意近版 | 跑 `hyperledger/besu:24.12.2`（钉死 tag，02 §1） |
| Node | 22.x，npm 10 | 中继 / 索引器 / SDK / node-cli |
| jq | 任意 | 断言 JSON 字段 |

环境变量全部来自 `artifacts/e2e/.env.e2e`（脚本自己生成，值是 anvil 的测试账户）：
`BSC_RPC=http://127.0.0.1:18545`、`BSC_RPC_2=http://127.0.0.1:18546`（同一个 anvil 的两个端口，
用来喂中继「两个独立 RPC」的校验；**真环境里必须是两家**，彩排里这样做要在日志里明说）、
`LAYER_RPC=http://127.0.0.1:8545`、`DB_PATH=artifacts/e2e/run/relayer.db`。

---

## 第 1 步 · 起一个分叉的 anvil，当假 BSC `[本机]`

```bash
anvil --fork-url "$BSC_FORK_RPC" --fork-block-number 68000000 \
      --hardfork cancun --port 18545 --block-time 1 --silent &
cast chain-id --rpc-url http://127.0.0.1:18545        # 期望 56
cast block latest --rpc-url http://127.0.0.1:18545 -f number
```

**证明什么：** 有一条能收交易、能出块、chainId 是 56 的假 BSC，且它在一个固定高度上分叉，
所以整份彩排可以重跑出同样的结果。Flap 的 Portal / VaultPortal 在分叉里是真的合约代码。

**不过就停：** chainId 不是 56，或分叉 RPC 连不上 —— 不要换成非分叉的空链继续跑，
金库那几步需要真的 Flap Portal。

---

## 第 2 步 · 在假 BSC 上部署全部 BSC 侧合约 `[本机]`

```bash
cd contracts
forge script script/DeployAll.s.sol --rpc-url http://127.0.0.1:18545 \
     --broadcast --unlocked --sender "$DEPLOYER"
jq -r '.transactions[] | "\(.contractName) \(.contractAddress)"' \
     broadcast/DeployAll.s.sol/56/run-latest.json | tee ../artifacts/e2e/run/addresses.txt
```

部署顺序：`BacVaultFactory` → 金库 → `AgentRegistry` → `BacBridge` → `ChainAnchor` →
`ValidatorStaking` →（决策 #17 定稿后）`FeeSplitter` 的 BSC 侧对手方。
地址写进 `addresses.txt`，后面每一步都从这里读，不手抄。

**证明什么：** 合约能在一条带真实 Flap 代码的链上部署成功，构造参数互相指得对
（桥知道锚点、锚点知道中继、注册表知道金库）。

**不过就停：** 任何一笔部署 revert。注意 `--broadcast` 在这里打的是本地 anvil，不是主网 ——
脚本必须断言 `cast chain-id` 的 RPC 是 `127.0.0.1`，防止有人把 `$BSC_FORK_RPC` 填成主网。

**还没做：** `contracts/script/DeployAll.s.sol` 尚未写（contracts 由另一条工作流负责）。

---

## 第 3 步 · 造创世、起本地 Besu `[要服务器/要 Docker]`

```bash
chain/scripts/build-genesis.sh --validators 1 --out artifacts/e2e/run/chain
docker run --rm -d --name bac-e2e-besu -p 8545:8545 \
  -v "$PWD/artifacts/e2e/run/chain:/g" hyperledger/besu:24.12.2 \
  --genesis-file=/g/genesis.json --data-path=/g/data \
  --rpc-http-enabled --rpc-http-host=0.0.0.0 \
  --rpc-http-api=ETH,NET,WEB3,QBFT,TXPOOL --min-gas-price=1000000000
cast chain-id --rpc-url http://127.0.0.1:8545                       # 期望 56777
cast code 0x0000000000000000000000000000000000000101 --rpc-url http://127.0.0.1:8545 | head -c 20
cast rpc qbft_getValidatorsByBlockNumber latest --rpc-url http://127.0.0.1:8545
```

**证明什么：** 创世里烘焙进去的五个层内合约**真的有代码**（`eth_getCode` 非空），
QBFT 真的在出块，`chainId` 是 56777，`baseFeePerGas` 是 0（决策 #16 的 `zeroBaseFee`）。

**不过就停：** `eth_getCode` 是 `0x` —— 说明 genesis 的 `alloc.code` 没填对，
这正是 02 §3.3「部署 → 取 code → 填 genesis → 回读对拍」那个闭环要防的事。

**还没做：** `chain/scripts/build-genesis.sh` 尚未写。
**离线替身：** 用 `artifacts/chain-check/probe.sh` 的记录证明这个 tag 能出块，但**不能**证明我们的创世对。

---

## 第 4 步 · 起中继与索引器 `[要服务器/要 Docker]`

```bash
cd relayer && npm ci && node src/index.mjs &            # 读 artifacts/e2e/.env.e2e
cd indexer && npm ci && npm run migrate && npm start &
sleep 10
curl -s localhost:8080/api/health | jq '.schema, .relayer.bscCursor, .warnings'
```

**证明什么：** 两个进程能在空链上启动、建库、把游标推到起始块，并且 `/api/health` 返回
`bac/health/1`。启动时的 `resumePending` 在空库上是空操作，不应该发出任何交易。

**不过就停：** `warnings` 里出现 `bsc_finality_unavailable` 以外的任何一条。
（anvil 没有 `finalized` 标签，所以这一条是**预期**的，脚本要把它列进白名单并在日志里说明。）

---

## 第 5 步 · 一个 agent 过挑战、进场 `[本机 + Docker]`

```bash
node artifacts/e2e/agent.mjs register     # SDK: register → 三轮签名挑战 → activate
cast call "$AGENT_REGISTRY" "getAgent(uint256)" 1 --rpc-url http://127.0.0.1:18545
```

脚本用 `@bac/agent-sdk` 的 `challenge` 命名空间在四秒窗口内答完三轮。

**证明什么：** SDK 算出来的挑战答案能被合约接受 —— 即 SDK 与合约对
`keccak256` 的输入布局、对 deadline 的理解逐字一致。这是 SDK→合约边界唯一能被真链证伪的地方。

**不过就停：** `solveChallenge` revert，或 `getAgent().status != 2 (ACTIVE)`。

---

## 第 6 步 · 锁 BAC，等中继把积分打进层内 `[要 Docker]`

```bash
node artifacts/e2e/agent.mjs lock --amount 1000
sleep 60                                              # 等确认门槛
cast balance "$AGENT_LAYER_WALLET" --rpc-url http://127.0.0.1:8545
cast call 0x…0101 "seen(bytes32)(bool)" "$DEPOSIT_ID" --rpc-url http://127.0.0.1:8545
sqlite3 artifacts/e2e/run/relayer.db "select kind,key,status,attempts from outbox"
```

**证明什么：** 方向 A 全链路通了：`Locked` 事件 → outbox 落盘 → 确认门槛 → `L2Bridge.credit` →
层内余额到账，且 `seen(depositId)` 为真、outbox 行是 `confirmed`、`attempts == 1`。
积分数量必须**逐 wei 等于**锁进去的量（1:1，决策 #3）。

**不过就停：** 余额对不上，或 outbox 里出现第二行同 `depositId` 的记录（幂等键失效）。

---

## 第 7 步 · agent 在层内做事，索引器渲染成中文 `[要 Docker]`

```bash
node artifacts/e2e/agent.mjs act          # deploy 一个合约 + AgentBook.publish 一条 PUBLISH
curl -s localhost:8080/api/feed | jq '.items[] | {kind, textZh, anchored, epoch}'
```

**证明什么：** §4 的规范事件模式三方一致：合约发 `Action(agentId, kind, subject, …)`，
索引器认得那 11 个 `kind` 常量并渲染出中文句子，SDK 发出去的 `kind` 哈希与合约常量相同。
此刻 `anchored` 必须是 `false`（还没有锚点），网站按规格要显示「未锚定 · 仅来自官方节点」。

**不过就停：** `textZh` 里出现 `undefined`，或 `kind` 落回 `NOTE`（说明哈希对不上）。

---

## 第 8 步 · 退出：层内销毁 → 锚点 → BSC 领钱 `[要 Docker]`

```bash
node artifacts/e2e/agent.mjs exit --amount 500        # L2Bridge.exit → ExitBurned
# 把两条链的时间推过纪元边界，让中继组装锚点
cast rpc evm_increaseTime 86400 --rpc-url http://127.0.0.1:18545
sleep 90
cast call "$CHAIN_ANCHOR" "lastPostedEpoch()(uint64)" --rpc-url http://127.0.0.1:18545
curl -s "localhost:8080/api/epoch/$EPOCH/proof/$EXIT_ID" | jq
node artifacts/e2e/agent.mjs claim --epoch "$EPOCH" --exit-id "$EXIT_ID"
```

**证明什么：** 这一步是整条链的心脏，一次证明四件事：

1. 中继算的 `exitRoot` 与 `l2Block` 与 SDK / node-cli 独立算出来的**逐字节相同**；
2. `postAnchor` 的 tuple 编码与合约的 `Anchor` 结构体对得上（这是目前唯一没被真实 encode 验证过的边界）；
3. 索引器从 `ExitBurned` 日志独立重建出的 merkle 证明，能被 `BacBridge.claimExit` 接受；
4. 领到的 BNB 等于「退出当场锁定的汇率 × 积分」（决策 #13），不是按纪元队列分的。

**不过就停：** `claimExit` 报 `Bad merkle proof` —— 八成是叶子里多塞了 `epoch`
（01 §6.1 那条过时注释的坑，见 README 的 open items）。

---

## 第 9 步 · 见证人节点：承诺 → 揭示 → 定案 `[要 Docker]`

```bash
cd node-cli && node src/cli.mjs stake --amount 1000000
node src/cli.mjs run --once                            # commit → reveal → 领奖
cast call "$CHAIN_ANCHOR" "getAnchor(uint64)" "$EPOCH" --rpc-url http://127.0.0.1:18545
```

**证明什么：** node-cli 从自己的只读全节点独立算出的四元组，与中继报的锚点全等，
于是它被计入 `agreeingCount` 而不是 `disputingWeight`；锚点状态从 `POSTED` 变成 `FINAL`。
这条是「见证人是真的在独立复算」的唯一证据。

**不过就停：** 它被计入 `disputingWeight`。这不是 node-cli 的 bug 就是中继的 bug，
两边都不许改成「照抄中继报的值」来让这一步变绿 —— 那样这一步就什么都不证明了。

**已知会挂：** 决策 #17 之后承诺是**四元组**（多一项 `proposerIncomeRoot`），
而 `contracts/src` 与 node-cli 现在都还是三元组。合约定稿前这一步跑不通，脚本要明确报
「第 9 步阻塞于决策 #17，未实现」而不是假装通过。

---

## 第 10 步 · 对账与 gas 分账 `[要 Docker]`

```bash
curl -s localhost:8080/api/health | jq '.reconcile'
curl -s localhost:8080/api/fees   | jq '.reconcile, .splitter.address'
# 用返回体里的 howToCheck 原样重算一遍，两个结果必须相同
bash artifacts/e2e/recheck.sh            # 逐条跑 howToCheck 里的 cast，自己算 diff
```

**证明什么：** `diff == 0` 且 `ok == true`，并且**不是信它算的** —— `recheck.sh` 把
`howToCheck` 里的七条 `cast` 原样跑一遍自己算，两个 `diff` 必须逐字相同。
这一条守住的是「任何人都能自己复算」这个卖点：它一旦结构性地永远不为 0，
5 分钟告警就会被运维关掉，而那条告警是发现中继超发的唯一手段。

**不过就停：** 两个 diff 不一致，或 `/api/fees` 的 `received/remitted/gap` 里
出现了没有锚点背书却标成 `anchored: true` 的数。

**已知只能跑一半：** `FeeSplitter` 还不存在，所以 `/api/fees` 这一半目前返回全 0；
脚本要断言「全 0 且 `anchoredThrough == null`」，而不是跳过。

---

## 第 11 步 · 网站数据层空跑一遍 `[本机]`

```bash
node artifacts/data-check/unit.mjs --api http://localhost:8080
python -m http.server 8000 --directory web &
node artifacts/e2e/site-check.mjs        # 无头浏览器拉一遍页面，断言没有 NaN / undefined / 占位符
```

**证明什么：** 网站的数据层能吃下真实 API 返回体，每个字段名都对得上，
页面上没有 `NaN`、`undefined`、`--`，并且「未锚定 · 仅来自官方节点」这句话在
`anchored: false` 的条目旁边真的出现了。

**不过就停：** 出现任何占位符。网站宁可显示「读不到」，也不许显示一个编出来的数。

---

## 判据

全部 11 步的断言都成立时，`run.sh` 最后一行打印：

```
E2E PASSED
```

**这一行只能在第 11 步之后打印，且脚本必须 `set -euo pipefail`。**
任何一步失败，脚本打印 `E2E FAILED at step N: <实际值 vs 期望值>` 并以非零退出码结束。
**不允许**为了让它变绿而跳过某一步、放宽某个断言、或把某个断言改成「大于 0 就算过」。

## 清理

```bash
docker rm -f bac-e2e-besu
pkill -f "anvil --fork-url"
rm -rf artifacts/e2e/run
```

## 现在阻塞在哪

| 步骤 | 阻塞原因 |
|---|---|
| 2 | `contracts/script/DeployAll.s.sol` 没写 |
| 3 | `chain/scripts/build-genesis.sh` 没写；本机没有 Docker |
| 5 · 7 | 需要 `artifacts/e2e/agent.mjs`（脚本化 agent），没写 |
| 9 | 决策 #17 的四元组承诺：合约与 node-cli 都还是三元组 |
| 10 | `FeeSplitter` 不存在，`/api/fees` 只能断言「全 0」 |
| 11 | `artifacts/e2e/site-check.mjs` 没写 |

整份 `run.sh` 本身也还没写 —— 这份文件是它的规格，不是它。
