# 02 · BNB Agent Chain 链规格（LAYER · Besu QBFT）

2026-09-22。本文是二层链本体的规格：创世、原生币供应、gas 策略、节点形态、端口、以及人类见证人加入的逐条命令。
上游：`00-DESIGN-SPEC.md`（系统）、`01-CONTRACT-SPEC.md`（合约 ABI）。服务器现状见 `docs/research/08-server.md`，授权范围见 `docs/decisions.md` #7/#8/#9。

> **2026-09-22 全文改写：共识客户端从 geth Clique 换成 Hyperledger Besu 24.12.2 + QBFT。**
> 依据是实测，不是偏好：geth ≥ 1.14 已彻底移除 Clique，唯一还能跑 Clique 的 v1.13.15 已 EOL，且一开 `cancunTime` 就 panic。
> 实测表与复现命令见 `docs/research/10-consensus-client.md`，决策见 `docs/decisions.md` #12，本文 §11 是不许重开的那一页。
> 链参数（chainId 56777、3 秒块、gasLimit 20,000,000、三个创世系统合约、`OPERATOR_FLOAT`、端口、备份、见证人流程）**实质全部不变**，变的是共识段、创世生成方式、启动参数、以及「层内不会重组」带来的简化。

---

## 0. D0 硬前置（做完这些之前不许生成正式创世文件）

| # | 事项 | 怎么做 | 状态 / 失败怎么办 |
|---|---|---|---|
| D0-1 | **确认 Besu QBFT 能出块，且 `cancunTime: 0` 下正常** | 一次性容器 + 临时创世，见 §5.1 `probe-consensus.sh` | ✅ **DONE 2026-09-22**：`hyperledger/besu:24.12.2`，QBFT `blockperiodseconds=2`，**45 秒出 21 块**，**RSS 309 MiB**，**空转 CPU 7.4%**，创世带 `cancunTime: 0` 正常。同一台机器上 geth 的五种组合全部失败（§11 表）。此项不再重测 |
| D0-2 | **确认 `chainId = 56777` 没被占用** | 在 chainlist.org 与 github.com/ethereum-lists/chains 逐字搜 `56777`；同时搜 `56778` 作为备选 | ⬜ **未做**。被占则退 `56778`，并向 `ethereum-lists/chains` 提登记 PR。**链 ID 一旦出块就不能改**（改了等于另一条链），这一步不能省 |
| D0-3 | **确认 BSC 的块时间与 gas price** | `artifacts/chain-check/probe.sh` | ✅ **DONE 2026-09-22**：块时间 0.45 s、gas price 0.05 gwei。若块时间变了，`AgentRegistry` 的 `K_BLOCKS/K_SECONDS`、EIP-2935 窗口、纪元长度、feed 的时间估算要一起重算 |
| D0-4 | **选定存储格式并确认它能起来**（原 `--gcmode/--state.scheme` 条目的对应项） | 用同一个一次性容器分别以 `--data-storage-format=BONSAI` 和 `FOREST` 启动一次，各跑 200 块，`du -sh` 对比 | ⬜ **默认值已定为 `BONSAI`（理由见 §4.4），这一步只是把数字钉死。** Besu 24.12 的 Bonsai **没有 archive 模式**（与 geth pathdb 不支持 archive 是同一类约束），所以「对任意旧区块 `eth_call`」照旧**不在 `/rpc` 的承诺里** |
| D0-5 | **JVM 堆的定值（8 GiB 的机器，上面还有别的负载）** | 起容器时 `BESU_OPTS=-Xmx2g -Xms512m`，跑满 30 分钟，`docker stats` 看 RSS，`jcmd GC.heap_info` 看堆占用；同时确认 compose 的 `mem_limit` 触发时是 JVM OOM 还是 cgroup OOM-kill | ⬜ **必做**。Besu 默认堆是「机器内存的一个百分比」，在一台还跑着别的负载的 8 GiB 机器上不能放任。基线：实测空转 RSS 309 MiB，`-Xmx2g` + `mem_limit: 3g` 有 6 倍余量。**失败（被 OOM-kill）就调到 `-Xmx3g` / `mem_limit: 4g` 并把旧项目的内存占用写进 runbook** |
| D0-6 | **实测小费（priority fee）到底进了谁的账** | 一次性链上发一笔 `maxPriorityFeePerGas > 0` 的交易，读 header 的 `miner`/`coinbase` 字段与该地址的余额增量 | ⬜ **必做，它决定 §4.1 对账公式减哪几个地址。** 预期：Besu 的 BFT 出块器把**本节点地址**写进 header 的 coinbase，小费归**提案者**（= QBFT validator 的地址，由 node key 导出）。**在实测之前，对账公式按 fail-closed 写成「减去 `qbft_getValidatorsByBlockNumber` 返回的每一个地址」**——多减一个恒为 0 余额的地址不会出错，漏减一个会让告警永久误报 |
| D0-7 | **冷备能不能真恢复** | 停容器 → `tar` 整个 data-path → 起一台新容器用同一份 `genesis.json` + 恢复的 data-path + 同一份 `key` → 确认从原高度续上、enode 不变、`qbft_getValidatorsByBlockNumber` 一致 | ⬜ **必做**。顺便测出「停机打备份」要多久（决定 §5.5 的窗口是不是 5 分钟）。**RocksDB 没有在线一致快照，绝不对运行中的 data-path 打 tar**（§5.5） |
| D0-8 | **用正式模板跑一次创世回读对拍** | §3.1 的 `build-genesis.sh` 全程跑通，结尾打印 `GENESIS BUILD PASSED` | ⬜ **必做**。这一条同时钉死三个 Besu 细节：①`alloc.balance` 用十六进制还是十进制（本文一律写十六进制，见 §3 规则 7）；②`cancunTime: 0` 下不预置 EIP-4788 beacon-root 合约会不会拦启动（D0-1 的实测说不会，这里用正式 alloc 再确认一次）；③`mixHash` 必须是 QBFT 的那个魔数常量 |
| D0-9 | ~~**确认 Bonsai 的 trie-log 修剪是开着的**~~ → **改为：确认离线修剪可行** | 演练链实测 | ✅ **DONE 2026-09-22**：**在线修剪不可用** —— `--bonsai-limit-trie-logs-enabled` 与 `--sync-mode=FULL` + `BONSAI` 互斥，Besu 拒绝启动；单验证者私链只能是 FULL。改为停机后跑 `besu storage x-trie-log prune`，并进冷备窗口与运维周检清单。原文：这是 Besu Bonsai 最有名的磁盘坑：trie log 不修剪会无界增长，几周就能吃掉几十 GB。若默认是关的就显式打开；若已经涨起来了，离线用 `besu storage x-trie-log prune` 修剪（要停节点） |
| D0-10 | **钉死 BFT 区块时间戳的未来上界** | 看 Besu 源码/日志里 BFT 的 `ACCEPTABLE_CLOCK_DRIFT` 实际秒数 | ⬜ **必做**。`00` §2 的信任表写着「签名节点可在 ±15 秒漂移内自由选择区块时间戳，从而决定一笔退出属于哪个纪元」——这句话在 Besu 下的**上界数字要换成实测值**，权力本身依然存在，不能因为换客户端就悄悄删掉 |

**镜像钉死 `hyperledger/besu:24.12.2`（D0-1 实测通过的那个 tag），并 `docker save` 一份本地 tar 留底。不用 `latest`。**

---

## 0.5 术语：本文有两种「验证者」，不许混用

| 词 | 指什么 | 在哪 | v1 谁是 |
|---|---|---|---|
| **见证人**（产品层，文档里旧称「人类验证者」） | 在 BSC 上质押 2,000,000 BAC、跑只读全节点、对每个纪元做 commit-reveal 见证、领节点基金奖励的人 | 身份与钱都在 **BSC** 上（`ValidatorStaking`） | 任何质押的人，**不出块** |
| **QBFT validator**（共识层） | 真正提案和投票产出层内区块的节点，地址由 node key 导出 | 在**层内**，集合由 QBFT 共识维护 | **1 个官方节点**（决策 #6） |

**v1 两个集合完全不相交**，这是设计，不是遗漏：见证人的刹车在 BSC 上（异议 → `DISPUTED` → 不释放 BNB → 逃生），不在层内共识里。
**v2 的目标是把它们合并**：Besu 的 validator-contract 模式让 QBFT validator 集直接由一个链上合约给出（§6.3），那个合约的数据源就是 `ValidatorStaking`。
在那之前，文档、网站、X 文案里出现「验证者」二字都必须能从上下文分辨是哪一个；`/api/health` 里两者分别是 `witnesses[]` 与 `layer.validators[]`。

---

## 1. 链参数

| 项 | 值 | 理由 |
|---|---|---|
| 链名 | BNB Agent Chain | 决策 #2；**不是 Binance**，网站与 X 文案都带「与 Binance / BNB Chain / Flap 官方无关」 |
| 原生币 | BAC（18 位小数） | 从 BSC 1:1 桥进来的积分就是原生币 |
| `chainId` | **56777**（备选 56778） | 56 = 母链 BSC，777 对应 Flap 代币地址尾号 `…7777`；五位数、好记、避开 56/97/204/5611/1337/31337 |
| 共识 | **QBFT（Hyperledger Besu 24.12.2）**，`blockperiodseconds = 3`，`epochlength = 30000`，`requesttimeoutseconds = 6` | 决策 #12。一个官方 validator。3 秒一块 = 28,800 块/天，浏览器的实时感够，磁盘可控。**QBFT 是 BFT 即时最终性：一个块被 commit 就不会回滚**（§6.2） |
| 客户端 | `hyperledger/besu:24.12.2`（钉死 tag + 本地 `docker save` 留底） | D0-1 实测；geth 全线不可用（§11） |
| 硬分叉 | 全部开到 **Cancun**（`shanghaiTime: 0`, `cancunTime: 0`） | agent 默认用 solc 0.8.26，目标就是 cancun，会发出 `MCOPY`/`PUSH0`；停在 shanghai 会让创世系统合约在本链上是非法指令，而创世不可改。**Clique 下这一条做不到（v1.13.15 一开 cancun 就 panic），Besu 下真的成立**（`00` §0.1 G5 现在是实的） |
| `gasLimit` | **20,000,000**（`0x1312d00`） | 故意比 BSC 小。磁盘是真正的约束（§4.3），20M 对 agent 部署一个 DEX 绰绰有余 |
| `zeroBaseFee` | **`true`**（因此 `baseFeePerGas = 0x0`，header 里的 `baseFeePerGas` 恒为 `0x0`） | **决策 #16（实测倒逼）**：Besu 里 EIP-1559 的 basefee **只能销毁、无法分账**，而 `--miner-coinbase` 在 QBFT 下被忽略。要让出块者拿到 gas 费，唯一不改客户端的路径就是关掉 basefee，让全部费用以 tips 形式进**提案者自己的 EOA**（实测：发送方付 42,000,000,000,000 wei，提案者地址精确增加同一个数，销毁 0）。分账规则见 §4.2 与 `00` §3.6 |
| `--min-gas-price` | **1 gwei（固定，可调）** | 关掉 basefee 之后就没了 EIP-1559 的自动涨价刹车，防刷链只剩三条：这个固定下限 + 20M 区块上限 + 磁盘告警（决策 #16，必须照实说）。**旧版的 `--min-gas-price=1000000000` 已作废**：zeroBaseFee 下它等于允许全免费刷链 |
| `mixHash` | `0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365` | **QBFT/IBFT2 的固定魔数**（ASCII "ctical byzantine fault tolerance"）。不是随便填的 32 字节，填错 Besu 不认这条链 |
| `difficulty` | `0x1` | BFT 链不用难度，固定 1 |
| 总量 | 1,000,000,000 BAC = `1e27` wei（`0x33b2e3c9fd0803ce8000000`） | 等于 BAC 在 BSC 上的固定总量，是创世写死的积分上限 |
| 给团队/预留/agent 的创世分配 | **0** | 链是空的，这是产品的一部分 |
| RPC | `https://95-179-183-132.sslip.io/rpc`（Caddy 自动 TLS，方法白名单 + 限速 + CORS） | 决策 #9，没有域名 |
| p2p | `30303/tcp` + `30303/udp` | 决策 #8 已授权 |

### 1.1 三个 QBFT 参数为什么是这三个数

| 参数 | 值 | 理由 |
|---|---|---|
| `blockperiodseconds` | **3** | 与原 `clique.period` 相同，不为换客户端改产品手感。28,800 块/天。QBFT 下这是**最小**出块间隔（提案者按它节流），不是平均值；空块照出，浏览器的 `tail -f` 不会卡住（决策 #14 的终端 UI 依赖这一点）。实测探针用的是 2 秒，3 秒只会更省 |
| `epochlength` | **30000** | 每 30000 块（≈ 25 小时）清空一次待定的 validator 投票。与原 `clique.epoch` 同值，纯为「换客户端不换数字」。**注意：这个 epoch 是 QBFT 的投票纪元，和产品里 `epoch = floor(timestamp / 86400)` 的结算纪元毫无关系**，两者在文档、日志、`/api/health` 里必须分别叫 `qbftVoteEpoch` 和 `epoch` |
| `requesttimeoutseconds` | **6** | 一轮共识在多久没结果后发起 round-change。取 **2 × `blockperiodseconds`**（Besu 对 BFT 的通用建议）。v1 只有 1 个 validator，round-change 事实上不会发生，这个值是为 §6.4 扩到 4 个 validator 那天准备的：太小会在 3 vCPU 上因为一次 GC 停顿就空转换轮，太大则真出故障时要等两倍时间才切换 |

**不设 `emptyblockperiodseconds`**：QBFT 可以配「没有交易时拉长出块间隔」来省磁盘，我们**故意不用**。链上大部分时间没有交易，一旦空块变稀，`l2Block(epoch)`（`03` §1.3 的规范定义）在低活跃纪元里会落到很早的一个块上，见证人和中继算出的区块号仍然一致（定义是「时间戳 < (epoch+1)×86400 的最大块号」，不依赖块密度），但**网站的「链还活着」这个信号会消失**，而这是决策 #14 那套机房面板的全部卖点。磁盘代价按 §4.4 是每年 6–10 GB，买得起。

---

## 2. 创世系统合约（固定地址）

| 地址 | 合约 | 创世余额 | 作用 |
|---|---|---|---|
| `0x0000000000000000000000000000000000000101` | `L2Bridge` | `0x33b2e066a06d27709600000`（= `999999000000000000000000000` = `1e27 − OPERATOR_FLOAT`） | 铸 / 销积分；`exit()` 谁都能调 |
| `0x0000000000000000000000000000000000000102` | `L2Gate` | 0 | BSC 身份状态镜像。`isAdmitted`（status == ACTIVE）**只被 `AgentBook` 读**；`exit()` 只调它的 `agentIdOf` 查表得到 `agentId`（**不看 status**，查不到记 0）—— 退出永远不受状态影响，但 `agentId` 也永远不可伪造 |
| `0x0000000000000000000000000000000000000103` | `AgentBook` | 0 | 公告板 + 统一 `Action` 事件 |
| `0x000000000000000000000000000000000000dEaD` | FeeSink | 0 | 无代码。**`zeroBaseFee: true` 之后这里只剩下 `AgentBook` 的发布费**（没有 base fee 了，也就没有销毁）；gas 费（全部以 tips 形式）**不进这里**，QBFT 下它进**区块提案者自己的 EOA**（§4.2、D0-6）。两者都算不流通，但是不同地址、不同账，对账时必须分开读 |
| `0x0000000000000000000000000000000000000104` | **`FeeSplitter`（决策 #17）** | 0 | 层内 gas 费的分账与记账合约：官方出块转进来的额 10% 进验证者池 / 90% 进基金会；阶段 2 验证者只转基金会那 50%。**它不是 coinbase，也不可能是**（QBFT 忽略 `--miner-coinbase`，实测），只能被动收钱。构造时无状态，完整规格见 `01` §11 |
| `0x0000000000000000000000000000000000000105` | （预留）v2 的 QBFT 验证者集镜像合约 | 0 | 创世不放代码，**只把地址占住**。原本占的是 `0x…0104`，决策 #17 把 `0x…0104` 给了 `FeeSplitter`，所以这条路线整体后移一位（§6.3） |
| `0xcA11bde05977b3631167028862bE2a173976CA11` | Multicall3 | 0 | 规范地址，浏览器和 SDK 直接可用（`00` §0.1 G6） |
| `0x4e59b44847b379578588920cA78FbF26c0B4956C` | CREATE2 确定性部署器 | 0 | agent 可以先算地址再部署，互相引用不用等（`00` §0.1 G6） |
| `<RELAYER_LAYER_ADDR>` | 中继 EOA | `0x3635c9adc5dea00000`（= `1000000000000000000000` = `OPERATOR_FLOAT` = 1,000 BAC） | 中继的 gas；**公开披露**，创世前运营方必须在 BSC 的 `BacBridge` 锁等额 BAC，保住 1:1 backing |
| `<QBFT_VALIDATOR_ADDR>` | 官方 QBFT validator 的地址（由 node key 导出） | **不出现在 `alloc` 里**（QBFT validator 的地址是写进 `extraData` 的，不是写进 `alloc` 的），**且在会计上声明为不流通地址** | QBFT 下区块提案者是小费的去处（§4.2、D0-6） |

**Agent 自建的 DEX / 工具 / 市场都是普通合约，我们一个都不预置、不背书、不打安全标签。**

**换客户端带来的唯一结构性变化：**「官方签名者地址」在 Clique 下是 `extraData` 里那 20 个字节，在 QBFT 下是 `extraData` 里 RLP 验证者列表中的一项，而且**这个列表会随 `qbft_proposeValidatorVote` 投票变化**（§6.1）。
所以任何硬编码「唯一签名者地址」的代码（索引器、对账脚本、`/api/health`）都必须改成**每次从 `qbft_getValidatorsByBlockNumber` 读当届集合**。这一条是 §4.1 对账公式改写的直接原因。

---

## 3. 创世的生成：`qbftConfigFile.json` → `extraData` → `genesis.json`

Clique 的 `extraData` 是「32 字节 vanity ‖ 20 字节地址 ‖ 65 字节封印」的定长拼接，可以手写。
**QBFT 的 `extraData` 是 RLP 编码的结构，手写等于自找麻烦**：

```
extraData = RLP([
  Vanity,        // 32 字节，我们全填 0
  [Validators],  // 验证者地址列表（20 字节一个），v1 只有一个
  Vote,          // 投票，创世里是 RLP 空值
  RoundNumber,   // 4 字节整数，创世里是 0
  [Seals]        // 提交封印列表，创世里是空列表
])
```

所以**创世由 Besu 自己的工具生成，我们一个字节都不手抄**，两条路径都写在这里：

### 3.0 路径 A（正式路径）：`besu operator generate-blockchain-config`

```bash
# 在一次性容器里跑，产物拷回 chain/build/，不在服务器上留密钥
docker run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD/chain:/cfg" -v "$PWD/chain/build:/out" \
  hyperledger/besu:24.12.2 \
  operator generate-blockchain-config \
    --config-file=/cfg/qbftConfigFile.json \
    --to=/out/networkFiles \
    --private-key-file-name=key
```

产物：

```
chain/build/networkFiles/
├── genesis.json                     # config 段原样带过来，extraData 已经是 RLP，alloc 还是空的
└── keys/
    └── 0x<VALIDATOR_ADDR>/
        ├── key                      # node private key（= validator 私钥 = enode 身份），32 字节 hex
        └── key.pub                  # 公钥，enode 的 128 hex 就是它去掉 0x
```

**目录名就是 validator 地址**，这也是 `<QBFT_VALIDATOR_ADDR>` 的来源，不需要再导一次。要单独导时用：

```bash
besu public-key export-address --node-private-key-file=key   # → 0x…（validator 地址）
besu public-key export         --node-private-key-file=key   # → 0x…（128 hex，enode 的 id）
```

**这一步产出真私钥**。本文只写命令，**不在任何文档、仓库、聊天记录里生成或粘贴真实密钥**；生成动作在发射当天的服务器上做一次，`chmod 600`，离线备份两份（§5.5），`chain/build/` 进 `.gitignore`。

### 3.0.1 路径 B（只换验证者集时用）：`besu rlp encode`

已经有一份 `genesis.json`、只想重算 `extraData`（例如把 validator 从 1 个换成 4 个、或者做一次密钥轮换演练）时，不要重跑 `generate-blockchain-config`（它会连带重造 alloc 与密钥）：

```bash
cat > toEncode.json <<'JSON'
["0xVALIDATOR_1","0xVALIDATOR_2","0xVALIDATOR_3","0xVALIDATOR_4"]
JSON
besu rlp encode --from=toEncode.json --to=extraData.txt --type=QBFT_EXTRA_DATA
```

**注意：改创世的 `extraData` 只能在链还没出块时做。链一旦出块，验证者集只能靠 §6.1 的投票改。**

### 3.1 `qbftConfigFile.json`（逐字，已写到 `chain/qbftConfigFile.json`）

```json
{
  "genesis": {
    "config": {
      "chainId": 56777,
      "homesteadBlock": 0,
      "eip150Block": 0,
      "eip155Block": 0,
      "eip158Block": 0,
      "byzantiumBlock": 0,
      "constantinopleBlock": 0,
      "petersburgBlock": 0,
      "istanbulBlock": 0,
      "muirGlacierBlock": 0,
      "berlinBlock": 0,
      "londonBlock": 0,
      "shanghaiTime": 0,
      "cancunTime": 0,
      "contractSizeLimit": 24576,
      "zeroBaseFee": true,
      "qbft": {
        "blockperiodseconds": 3,
        "epochlength": 30000,
        "requesttimeoutseconds": 6
      }
    },
    "nonce": "0x0",
    "timestamp": "0x0",
    "gasLimit": "0x1312d00",
    "difficulty": "0x1",
    "mixHash": "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
    "coinbase": "0x0000000000000000000000000000000000000000",
    "baseFeePerGas": "0x0",
    "alloc": {}
  },
  "blockchain": {
    "nodes": {
      "generate": true,
      "count": 1
    }
  }
}
```

**为什么 `alloc` 是空的、`timestamp` 是 `0x0`：** 这两项由 §3.3 的 `build-genesis.sh` 在拿到系统合约的 runtime 字节码之后填进去。
先生成再填的顺序不能倒：`generate-blockchain-config` 每跑一次都会造一把新密钥、换一个 validator 地址、换一份 `extraData`，把它放在最后会让前面所有对拍白做。
`contractSizeLimit: 24576` 是显式写出的 EIP-170 值（和我们合约的 24,576 字节预算同一个数），写出来是为了让任何人重建创世时不必去猜 Besu 的默认值。

**`"count": 1`** = v1 一个官方 validator（决策 #6）。扩到 4 个的那天改这里**并重建链**，或者走 §6.1 的投票（不重建链，推荐）。

### 3.2 `genesis.json`（完整模板，占位符全部在生成脚本里替换）

```json
{
  "config": {
    "chainId": 56777,
    "homesteadBlock": 0,
    "eip150Block": 0,
    "eip155Block": 0,
    "eip158Block": 0,
    "byzantiumBlock": 0,
    "constantinopleBlock": 0,
    "petersburgBlock": 0,
    "istanbulBlock": 0,
    "muirGlacierBlock": 0,
    "berlinBlock": 0,
    "londonBlock": 0,
    "shanghaiTime": 0,
    "cancunTime": 0,
    "contractSizeLimit": 24576,
      "zeroBaseFee": true,
    "qbft": {
      "blockperiodseconds": 3,
      "epochlength": 30000,
      "requesttimeoutseconds": 6
    }
  },
  "nonce": "0x0",
  "timestamp": "<GENESIS_TIMESTAMP_HEX>",
  "extraData": "<QBFT_EXTRADATA_RLP>",
  "gasLimit": "0x1312d00",
  "difficulty": "0x1",
  "mixHash": "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
  "coinbase": "0x0000000000000000000000000000000000000000",
  "baseFeePerGas": "0x0",
  "alloc": {
    "0x0000000000000000000000000000000000000101": {
      "balance": "0x33b2e066a06d27709600000",
      "code": "<L2BRIDGE_RUNTIME_BYTECODE>"
    },
    "0x0000000000000000000000000000000000000102": {
      "balance": "0x0",
      "code": "<L2GATE_RUNTIME_BYTECODE>"
    },
    "0x0000000000000000000000000000000000000103": {
      "balance": "0x0",
      "code": "<AGENTBOOK_RUNTIME_BYTECODE>"
    },
    "0x0000000000000000000000000000000000000104": {
      "balance": "0x0",
      "code": "<FEESPLITTER_RUNTIME_BYTECODE>"
    },
    "0xcA11bde05977b3631167028862bE2a173976CA11": {
      "balance": "0x0",
      "code": "<MULTICALL3_RUNTIME_BYTECODE>"
    },
    "0x4e59b44847b379578588920cA78FbF26c0B4956C": {
      "balance": "0x0",
      "code": "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff3d523d60203df33d3d3d3d363d3d37363d34f03d523d6020f3"
    },
    "0x000000000000000000000000000000000000dEaD": {
      "balance": "0x0"
    },
    "<RELAYER_LAYER_ADDR>": {
      "balance": "0x3635c9adc5dea00000"
    }
  }
}
```

**占位符清单（共 7 个，生成脚本必须全部替换，替换后 `grep -c '<' genesis.json` 必须是 0）**

| 占位符 | 来源 | 值的性质 |
|---|---|---|
| `<GENESIS_TIMESTAMP_HEX>` | 发射当天 UTC 00:00 的 Unix 秒，转十六进制 | 让层内纪元边界与 BSC 侧的 UTC 纪元对齐（`epoch = floor(ts/86400)`，两边同一个定义） |
| `<QBFT_EXTRADATA_RLP>` | §3.0 路径 A 产出的 `genesis.json` 里那一段，或路径 B 的 `extraData.txt` | RLP，含 32 字节全 0 vanity + validator 列表 |
| `<L2BRIDGE_RUNTIME_BYTECODE>` | §3.3 从 anvil 上 `cast code` 取 | `forge inspect L2Bridge deployedBytecode` 的等价物，带构造参数烘焙进去的 immutable |
| `<L2GATE_RUNTIME_BYTECODE>` | 同上 | 同上 |
| `<AGENTBOOK_RUNTIME_BYTECODE>` | 同上 | 同上 |
| `<MULTICALL3_RUNTIME_BYTECODE>` | §3.3 从 anvil 上部署 Multicall3 后 `cast code` 取 | 规范字节码，不手抄 |
| `<RELAYER_LAYER_ADDR>` | 中继的层内 EOA | 公开披露，与 BSC 侧锁仓额并排显示在网站 |

（CREATE2 部署器的 runtime 是众所周知的常量，**不是占位符**，直接写死。）

**`alloc` 的硬规则（七条，比 Clique 版多一条）**

1. 创世里**没有任何 storage 槽**。三个系统合约写成「无构造函数、配置全是代码里的 `immutable` / `constant`」，`forge inspect <C> deployedBytecode` 出来的就是全部，任何人都能独立重建创世文件并核对哈希。
2. `<CREATE2 部署器>` 的字节码就是众所周知的 Arachnid 部署器 runtime（上面那串），地址 `0x4e59…4956C` 与以太坊主网一致（`00` §0.1 G6）。
3. `<MULTICALL3_RUNTIME_BYTECODE>` 由生成脚本部署后 `eth_getCode` 取出，不手抄（`00` §0.1 G6）。
4. 中继 EOA 是**唯一**有创世余额的外部账户，数额 1,000 BAC，公开披露，并在网站的「不变量」区块里与 BSC 侧的锁仓额并排显示。
5. **QBFT validator 的地址不出现在 `alloc` 里，也不给余额**（它的身份在 `extraData` 里；出块不花 gas）。Clique 版那条「给签名者 0 余额」在 QBFT 下连写都不用写——但**会计上它依然是不流通地址**（§4.2）。
6. 任何人、包括我们自己，都没有别的创世分配。
7. **所有 `balance` 写十六进制字符串（`0x…`），不写十进制。** Clique 版的模板写的是十进制，geth 接受；**Besu 对 `alloc.balance` 的十进制解析不要拿运气去赌**，D0-8 会正面验一次，但模板一律用十六进制就不存在这个问题。两种写法的对照值在 §2 的表里都给了。

**关于 EIP-4788（cancun 的 beacon-root 合约 `0x000F3df6…Beac02）`：我们不预置它。** 它服务的是信标链的 `parentBeaconBlockRoot`，本链没有信标链。D0-1 的实测（`cancunTime: 0` 正常出块 21 个）已经说明 Besu 在没有这个合约的情况下不拦启动、不拦出块，D0-8 用正式 alloc 再确认一次。**预置一个永远存不进有效数据的合约，只会让「创世里没有我们看不懂的东西」这句承诺打折。**

### 3.3 创世字节码的生成与回读对拍（有脚本，不靠人眼）

`chain/scripts/build-genesis.sh`：

```bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/chain/build"; mkdir -p "$OUT"

# 0) 前置：§3.0 的 generate-blockchain-config 已经跑过，$OUT/networkFiles/genesis.json 存在
EXTRADATA=$(jq -r .extraData "$OUT/networkFiles/genesis.json")
VALIDATOR=$(basename "$(ls -d "$OUT"/networkFiles/keys/0x*)")

# 1) 起一个一次性 anvil（cancun），不再需要任何 geth
#    —— 这是换 Besu 之后的净收益：整条工具链里再也没有 go-ethereum
anvil --hardfork cancun --port 18545 --silent &
ANVIL=$!; trap 'kill $ANVIL' EXIT
until cast block-number --rpc-url http://127.0.0.1:18545 >/dev/null 2>&1; do :; done

# 2) 正常部署四个系统合约 + Multicall3（构造参数里写 BSC 侧地址与 ROTATION_SIGNER；
#    FeeSplitter 没有构造参数，FOUNDATION_PAYOUT_0 / ROTATION_SIGNER 是编译期常量，写死在字节码里）
forge script chain/script/DeployLayerSystem.s.sol \
  --rpc-url http://127.0.0.1:18545 --broadcast --private-key "$DEV_KEY"

# 3) 取 runtime 字节码
for ADDR in $L2BRIDGE $L2GATE $AGENTBOOK $FEESPLITTER $MULTICALL3; do
  cast code "$ADDR" --rpc-url http://127.0.0.1:18545 >> "$OUT/codes.txt"
done

# 4) 确认没有任何非零 storage 槽（系统合约必须是无状态构造）
for ADDR in $L2BRIDGE $L2GATE $AGENTBOOK $FEESPLITTER; do
  for SLOT in 0 1 2 3 4 5 6 7; do
    V=$(cast storage "$ADDR" "$SLOT" --rpc-url http://127.0.0.1:18545)
    [ "$V" = "0x0000000000000000000000000000000000000000000000000000000000000000" ] \
      || { echo "NON-ZERO STORAGE $ADDR $SLOT"; exit 1; }
  done
done

# 5) 填模板：8 个占位符全部替换（决策 #17 多了 FEESPLITTER），替换完不许还有 '<'
python3 chain/scripts/fill_genesis.py \
  --template chain/genesis.template.json \
  --extradata "$EXTRADATA" \
  --timestamp "$GENESIS_TS" \
  --codes "$OUT/codes.txt" \
  --relayer "$RELAYER_LAYER_ADDR" \
  --out "$OUT/genesis.json"
[ "$(grep -c '<' "$OUT/genesis.json")" = "0" ] || { echo "PLACEHOLDER LEFT"; exit 1; }

# 6) 起一个一次性 Besu 用这份正式创世跑起来（注意：Besu 没有 init 步骤，直接 --genesis-file）
docker run -d --name bac-genverify -u "$(id -u):$(id -g)" \
  -v "$OUT:/g" -p 18546:8545 hyperledger/besu:24.12.2 \
  --data-path=/g/verifydata --genesis-file=/g/genesis.json \
  --node-private-key-file=/g/networkFiles/keys/$VALIDATOR/key \
  --rpc-http-enabled --rpc-http-host=0.0.0.0 --rpc-http-api=ETH,NET,WEB3,QBFT \
  --host-allowlist="*" --min-gas-price=1000000000 --p2p-enabled=false
NEW=http://127.0.0.1:18546
until cast block-number --rpc-url $NEW >/dev/null 2>&1; do :; done

# 7) 回读对拍：在新创世链上把每个 view 函数再读一遍
cast call 0x0000000000000000000000000000000000000101 "relayer()(address)"       --rpc-url $NEW  # == 期望中继
cast call 0x0000000000000000000000000000000000000101 "reserve()(uint256)"       --rpc-url $NEW  # == 999999000000000000000000000
cast call 0x0000000000000000000000000000000000000101 "rotationNonce()(uint256)" --rpc-url $NEW  # == 0
cast call 0x0000000000000000000000000000000000000102 "isAdmitted(address)(bool)" 0x…  --rpc-url $NEW  # == false
cast call 0x0000000000000000000000000000000000000103 "actionCount()(uint64)"    --rpc-url $NEW  # == 0
cast call 0xcA11bde05977b3631167028862bE2a173976CA11 "getBlockNumber()(uint256)" --rpc-url $NEW
cast balance 0x0000000000000000000000000000000000000101 --rpc-url $NEW   # == 999999000000000000000000000
cast balance "$RELAYER_LAYER_ADDR"                      --rpc-url $NEW   # == 1000000000000000000000

# 8) QBFT 专属回读：验证者集必须正好是我们造的那一个
cast rpc qbft_getValidatorsByBlockNumber '"latest"' --rpc-url $NEW       # == ["<VALIDATOR>"]，长度 1
cast rpc eth_getBlockByNumber '"latest"' false --rpc-url $NEW | jq -r .miner  # 出块者 = VALIDATOR（D0-6 的入口）

# 9) 确认 cancun 真的开着（一个 MCOPY/TSTORE 合约能部署并跑通），否则整条链的 solc 目标要退回 shanghai
forge script chain/script/CancunSmoke.s.sol --rpc-url $NEW --broadcast --private-key "$DEV_KEY"

# 10) 打印创世哈希，写进 chain/GENESIS.md 和网站
cast rpc eth_getBlockByNumber 0x0 false --rpc-url $NEW | jq -r .hash
docker rm -f bac-genverify >/dev/null
echo "GENESIS BUILD PASSED"
```

脚本结尾必须打印 `GENESIS BUILD PASSED`，在本地 CI 里跑。**手搓创世 storage 是这类项目最经典的翻车点，我们不手搓。**
相对 Clique 版多出来的是第 8 步和第 9 步：**验证者集**和 **cancun 真的可用**，这两件事在 Clique 版里一个不存在、一个做不到。

---

## 4. 原生 BAC 的供应模型与 gas 策略

### 4.1 供应模型（不改客户端、不加预编译）

创世把 `1e27 − OPERATOR_FLOAT` 全部给 `L2Bridge`。所谓「铸币」是从它的余额里转出，所谓「销毁」是转回它名下。于是：

```
层内流通积分 = TOTAL_SUPPLY(1e27)
             − balance(L2Bridge 0x…0101)
             − balance(FeeSink 0x…dEaD)
             − balance(FeeSplitter 0x…0104)                                      ← 决策 #17 新增
             − Σ balance(v)  for v in everValidator                               ← 见 4.2
```

**与 Clique 版的唯一差别在最后一项：从「减一个固定的签名者地址」变成「减当届验证者集里的每一个地址」。**
理由是 QBFT 的验证者集是可变的（§6.1 的投票、§6.3 的合约模式），把它硬编码成一个地址，等于给未来的自己埋一个「扩容当天对账告警全线误报」的雷。
读法：先 `qbft_getValidatorsByBlockNumber(l2Block(epoch))` 拿到集合，再逐个 `eth_getBalance(v, l2Block(epoch))`。v1 集合长度是 1，这个循环跑一次。
**历史上退出过验证者集的地址也必须继续减**（它身上可能还留着当年的小费）：索引器维护一张 `everValidator` 累积表，只增不删，对账用这张表。

这个数字任何人用几次 `eth_getBalance` 就能自己算，网站在首页显示它，并与 BSC 上 `BacBridge.totalCreditsIssued() − totalCreditsExited()` 并排放。

**链上强制的那条性质在 BSC 侧：** `ChainAnchor.postAnchor` 的 `cumulativeCredited + credited <= BacBridge.totalCreditsIssued()`。中继在层内凭空 credit 的那一刻，它就再也发不出合法锚点，而退出只能走锚点。这就是「二层的状态本身不可信，但在 BSC 换不出 BNB」的具体含义。

**`circulating` 只是锚点里的信息字段**（`00 §0.2 F2`）。
**`postAnchor` 里那条账本恒等式检查已经整条删除**（`01` §6.2）。
理由是它根本不 fail-safe：任何人花 21,000 gas 往 `L2Bridge` / FeeSink / 验证者转 1 wei 积分就能让等式永远对不上，
而 `postAnchor` 不可跳号 —— 之后每个纪元都发不出锚点，`claimExit` 永久 revert，90 天后只剩逃生。
不需要攻击者也会发生：第一笔带小费的交易就把它打穿；创世那一刻 `circulating` 已经等于 `OPERATOR_FLOAT`，
而 `lastFinalCirculating` 初值是 0，**第一个锚点就 revert**。承重的是 `01` §6.2 的第 7/8 条（只用 BSC 侧计数器）。

**这个数会因为 gas 燃烧和小费而持续下降，它不等于 BSC 侧的净发行量。**
对账必须把黑洞地址的余额加回来（`03` §3.1）：

```
diff := (bscTotalIssued − bscTotalExited)
        − (layerCirculating + balance(FeeSink) + Σ balance(v) for v in everValidator)
```

这个 `diff` **恒为 0**，几条 `cast` 就能复算；非零才是真信号。

**决策 #17 后此式必须多减一项 `balance(FeeSplitter)`**：归集进分账合约的 gas 费在被领走之前停在 `0x…0104` 名下，
它既不在任何人的可用余额里，也不是销毁。漏减这一项会让 `diff` 从第一笔归集起恒为正，那条 5 分钟告警又会变成永久误报 —— 和当初漏减小费是完全同一个错。
领走之后它变成普通地址的余额，自动回到 `layerCirculating` 里，等式照样成立。
旧写法（`layerCirculating` 直接对 `issued − exited`）从第一笔交易起就不为 0 且单调发散，
那条「对账差额非零即告警」的 5 分钟告警会永久误报，最后一定被人关掉 —— 而它本来是发现中继超发的唯一手段。

### 4.2 gas 费落在哪里（为什么要把验证者地址算成不流通）

**Clique 下的旧事实：** geth 的费用收款人是 `Engine.Author(header)`，即从 `extraData` 里 `ecrecover` 出来的签名者地址。
**QBFT 下的新事实（D0-6 必须实测确认，未确认前按 fail-closed 处理）：** Besu 的 BFT 出块器把**本节点地址**写进 header 的 `coinbase`，
所以第一笔带 priority fee 的 agent 交易（ethers 默认就会带）会把 BAC 打进**当届提案者**的地址。
在 v1 只有一个 validator 的情况下，这和 Clique 的结论完全一样；扩到多个 validator 时，它会分散到所有 validator 的地址上——
**这正是 §4.1 必须按集合去减、而不是按单个地址去减的原因。**

处理方式有三条，我们**三条都做**：
1. 把**当届及历史上出现过的**验证者地址在会计口径上声明为不流通地址，写进 `chain/GENESIS.md`、网站和索引器（索引器维护 `everValidator` 累积表）。
2. **运营承诺：官方 validator 的层内地址永远不发送任何交易**，余额只增不减，任何人可核。
   这一条是**硬性运营约束**，不是习惯：只要它出过一笔账，上面那个恒为 0 的对账式就失效。
   监控里必须有「每个 validator 的层内余额单调不减」这一条（§5.4）。
3. **未来通过投票加入的任何 validator，在加入之前其地址余额必须为 0，并在加入的同时被写进 `everValidator` 表。** 这是 §6.1 投票流程里的一个强制步骤，不是建议。

**最低 gas 价在 Besu 里是一个 flag：`--min-gas-price=1000000000`（1 gwei）。**
它同时是「出块时接受的最低 gas price」和「txpool 的准入下限」，一举替掉 Clique 版的 `--miner.gasprice` + `--txpool.pricelimit` 两个 flag。

**这个值在决策 #16 之后从 `0` 改成了 1 gwei，理由完全翻转，必须写清楚为什么：**
旧结论（「下限要设 0，否则等于强制每笔交易给 validator 小费，让对账和『base fee 全部销毁』的文案两头对不上」）
建立在「basefee 存在且会被销毁」这个前提上。`zeroBaseFee: true` 之后**这条链上根本没有 basefee，也没有任何销毁**，
「把费用喂给出块者」不再是副作用，而是**设计本身**（决策 #15/#16/#17 的全部出发点）。
于是下限的作用倒过来了：**它是唯一还剩下的价格底线**。设成 0 就等于允许 0 gas price 的交易填满每一个块，
而 EIP-1559 的自动涨价刹车已经被我们自己关掉了。**`--min-gas-price=0` 已作废，任何配置文件里不许再出现。**

---

#### 4.2.1 gas 费的去处与分账（决策 #17，规范口径）

**三条实测事实（`docs/research/10-consensus-client.md` 附录，不重新讨论）：**

1. EIP-1559 的 basefee 在 Besu 里**只能销毁**，没有任何配置能把它转给某个地址。
2. `--miner-coinbase=<合约地址>` 在 QBFT 下**被忽略**：coinbase 恒等于出块者自己的地址（实测 splitter 余额 0、validator 余额 42,000,000,000,000）。
3. 所以本链开 `zeroBaseFee: true`，**每一笔交易费 100% 落在当届提案者的 EOA 里**，销毁为 0。

**推论（必须逐字出现在网站与 FAQ）：费用停在出块者自己控制的 EOA 里，链上没有任何力量能强制它分账。**
下面的比例因此是**受信但可对账**的规则，不是合约强制的结果。

| 出块者 | 该块 gas 费的去向 | 常量 |
|---|---|---|
| **官方节点** | **10%** 进验证者池（当纪元见证达标者按 `质押 × attend30` 分）/ **90%** 进官方基金会 | `OFFICIAL_BLOCK_VALIDATOR_BPS = 1000` |
| **验证者（阶段 2，已挣到出块资格）** | **50%** 归该验证者本人（本来就在它 EOA 里，不搬运）/ **50%** 进官方基金会 | `VALIDATOR_BLOCK_VALIDATOR_BPS = 5000` |

基金会那一份一律用**余数法**（`gross − validatorPart`）算，取整零头永远落在基金会那边。
完整常量表与算术例子见 `00` §3.6，合约规格见 `01` §11（`FeeSplitter @ 0x…0104`）。

**归集动作（两个阶段都要做，命令见 §7.6）：**

```
阶段 1：官方节点 EOA ──remitOfficial{value: 该纪元收到的全部 gas 费}(epoch)──▶ FeeSplitter(0x…0104)
阶段 2：验证者 EOA   ──remitValidator{value: 该纪元 gas 收入的 50%}(epoch)──▶ FeeSplitter(0x…0104)
```

**逐 proposer 的 gas 收入怎么算（中继 / 见证人 / 索引器三处必须字节级一致）：**

```
对区块区间 (l2Block(epoch-1), l2Block(epoch)] 里的每个区块 b：
    proposer = b.miner            // QBFT 下 header.coinbase 就是当届提案者
    gasIncome[proposer] += Σ_tx (tx.gasUsed × tx.effectiveGasPrice)     // zeroBaseFee ⇒ 全额进 proposer
    blocks[proposer]    += 1
remitted[proposer] = FeeSplitter.remittedBy(epoch, proposer)  @ l2Block(epoch)
```

这两个数进锚点（`01` §11.4 的 `ProposerIncome` 行），并且**在见证人的承诺四元组里**（多一项 `proposerIncomeRoot`），
所以它既不是运营方的一面之词，也不需要任何新的数据可得性假设 —— 任何独立全节点逐块重算即可。

**「出块者自己刷链是免费的」这一条必须照实说**（费用付给自己，成本只有磁盘）：
阶段 1 只有官方节点，所以它是运营方的自律问题；阶段 2 放开出块权之后，
约束是质押门槛 + 64 节点上限 + QBFT 的轮流出块 + 归集短缺会被扣发并撤销资格（`01` §11.5），**同样都不是硬保证**。

### 4.3 gas 策略与刷链的真实账

一笔普通转账 `21000 × 1 gwei = 0.000021 BAC`；桥进 1 BAC 够约 47,600 笔。

**但是**：`1 gwei × 20,000,000 gas × 28,800 块/天 = 576 BAC/天就能填满全链每一个块`（总量的 0.0000576%）。所以「gas 要花真金白银的 BAC，所以刷不动」这个说法是**错的**，文档和网站都不许这么写。

- 真正的代价是**磁盘**：576 BAC/天如果全打在冷 SSTORE 上（20,000 gas 一个槽），每天新增约 2,880 万个槽 ≈ 2.9 GB/天，70 GB 空闲三周见底。
- **唯一真实的控制手段是 validator 调 `gasLimit`**（EIP-1559 每块 ±1/1024）。**Besu 下这件事比 Clique 下更好做，有两条路径：**

  | 路径 | 命令 | 停机 | 何时用 |
  |---|---|---|---|
  | **热改（首选）** | `cast rpc miner_changeTargetGasLimit 2000000 --rpc-url http://127.0.0.1:8545`（需要 `MINER` 在 `--rpc-http-api` 里，且只在 compose 内网可达） | **不停机** | 应急。约 3,050 个块 ≈ 2.5 小时收敛到 2,000,000 |
  | 冷改（兜底） | 改 compose 的 `--target-gas-limit=2000000` → `docker compose up -d besu` | 一次重启 | 热改的 API 不可用，或要让值在重启后持久 |

  **两条都必须做**：热改止血，冷改持久化，否则下一次重启会悄悄涨回 20M。
  不改客户端、不硬分叉、可逆。应急流程见 §5.4，触发线：**data-path 日增 > 500 MB 且持续 6 小时**。
  代价必须公开：这是一个**单方面的全链吞吐开关**，已写进 `00` §2 信任表的签名节点那一行，动用时要在 `/api/health` 的 `layer.gasLimit` 上立刻可见并在网站挂公告说明原因与恢复条件。
- **原先列为「缓解」的几条，实际效果照实写（它们不是控制手段）：**

  | 措施 | 实际效果 |
  |---|---|
  | `--tx-pool-max-size` / layered pool 的容量参数 | 只决定缓冲多少笔；20M gas 的块 ≈ 952 笔转账 / 1000 个冷 SSTORE，几个满块就排空 → **无效** |
  | `--tx-pool-limit-by-account-percentage` | 只限单账户占池比例，30 个地址就绕过 → **无效** |
  | 最低 gas price 下限（`--min-gas-price=1000000000`） | **决策 #16/#17 之后它是唯一还在的价格底线**（basefee 已经不存在，涨价曲线也不存在）。它仍然**拦不住买得起的攻击者**：填满全链一天只要 576 BAC。它的真实作用只有两个：挡住 0 gas price 的垃圾交易，以及给 gas 费分账一个可预测的下限 → **必须有，但不是防刷手段** |
  | data-path 体积告警 | 告警不是控制；它的意义是触发上面那条 gasLimit 流程 |
  | `AgentBook` 每纪元 20 条 | 只管公告，不管 SSTORE → **无关** |
  | EIP-1559 涨价曲线 | 在单 validator 链上**不是防御，是攻击者的武器**：攻击者买的是「把链关掉」，花得起；正常 agent 买的是「做一笔生意」，被挤出去 |
  | **QBFT 本身** | **不是防刷链手段。** BFT 换来的是「不会重组」，不是「更难被填满」。任何把即时最终性说成安全性提升的文案都是错的 |

- **任何针对某个 agent 的限速都必须出现在 `/api/health` 上，不许静默。**

### 4.4 磁盘预算（70 GB 空闲）与 Bonsai vs Forest

**选 `--data-storage-format=BONSAI`。理由，按重要性：**

1. **磁盘是本项目唯一真正的硬约束**（§4.3）。Forest 保存完整的 MPT 节点历史，每个被改过的槽在每个高度都留一份节点；Bonsai 存扁平的当前状态 + 有限的 trie log 回滚记录，同样的链活动下体积低一个量级。70 GB 空闲、还要分给索引器 SQLite 和冷备，这不是可以「先用 Forest 看看」的余量。
2. **我们不需要历史 state。** 需要历史 state 的只有「对任意旧区块做 `eth_call`」——这一条**从 `/rpc` 的承诺里去掉**，明写「`eth_call` 只支持最近 `--bonsai-historical-block-limit` 个区块的状态」（与 `00` §0.2 F4 为锚点做过的同一个取舍）。
3. **索引器要的是历史 receipts/logs，不是历史 state**，而 receipts/logs 与存储格式无关，两种格式都全量保留。「索引器要全量历史」这个需求由索引器自己承担：它本来就在实时消费每个区块的收据和日志并写进自己的 SQLite（`03` §2）。
4. **Bonsai 在 Besu 24.12 没有 archive 模式**（Bonsai archive 当时还是实验特性）。这和 geth 的「pathdb 不支持 archive」是同一类约束，原 D0-4 的结论因此原样成立，**没有因为换客户端而多出一个选项**。

**一个对 `03` §1.3 的正面影响（必须记下来，它放宽了一条运维死线）：**
Clique 版按 `--state.scheme=path` 的 128 块保留窗口，算出「中继必须在纪元结束后 **6 分钟内** 读完四个余额」。
Besu Bonsai 的 `--bonsai-historical-block-limit` **默认是 512 块**，按 3 秒块 = **约 25.6 分钟**。
窗口从 6 分钟放宽到 25 分钟。**但 `03` §1.3 的那条纪律不改**（仍然写「尽快读、读完即落盘」），只是告警线从「6 分钟没读完」改成「**10 分钟没读完就告警，25 分钟是硬死线**」。
理由：放宽的窗口是用来吸收 GC 停顿和重启的，不是用来放松的。这个值一旦调整（`--bonsai-historical-block-limit`），必须同步改 `03` §1.3、告警脚本和 `/api/health` 的 `rpc.limits`。

**体积预算**

空块口径：每块 0.6–1.0 KB（header RLP 约 540 字节 + body/receipt/索引）→ 链数据 **17–29 MB/天**。
RocksDB 的压缩/写放大/索引开销按 1.5–2 倍估 → **26–58 MB/天，9.5–21 GB/年**。

| 项 | 预算 | 告警线 |
|---|---|---|
| Besu data-path（`BONSAI`） | ≤ 25 GB | 80% = 20 GB |
| `index.db`（SQLite） | ≤ 8 GB | 80% = 6.4 GB |
| 冷备（异机之外的本地暂存） | ≤ 12 GB | 80% |
| 容器日志（`json-file`，`max-size=50m × max-file=3`） | ≤ 600 MB（四个服务） | 不单列告警，被总盘告警覆盖 |
| 其余 | 给系统与机器上已有的其他负载（**不动**） | — |

**这个 9.5–21 GB/年是估算，不是实测。** D0-4 跑 200 块只够验证「能起来」，真正的日增要在上线后第一个 24 小时用 `du -sh` 量一次并写回本表。
**Bonsai 的 trie log 是唯一已知会无界增长的部分**（D0-9）：**在线修剪用不了** —— 实测加上 `--bonsai-limit-trie-logs-enabled` 后 Besu 直接拒绝启动（`Cannot enable --bonsai-limit-trie-logs-enabled with --sync-mode=FULL and --data-storage-format=BONSAI`），而单验证者私链的同步模式就是 FULL。所以只能**停机离线修剪**；真涨起来了用 `besu storage x-trie-log prune` 离线修剪（要停节点，和冷备窗口合并做）。

---

## 5. 服务器上的形态

### 5.1 D0 的一次性 Besu QBFT 验证（已跑过，保留为可复现脚本）

`chain/probe-consensus.sh`（在服务器或本机跑，**纯一次性容器，不改任何长期状态**）：

```bash
set -euo pipefail
IMG=hyperledger/besu:24.12.2       # ← 钉死；D0-1 实测通过的 tag
D=$(mktemp -d); chmod 777 "$D"

# 1) 最小 qbft 配置：一个 validator，period=2（探针用 2 秒，正式链用 3 秒）
cat > "$D/qbft.json" <<'JSON'
{
  "genesis": {
    "config": {
      "chainId": 1337777,
      "berlinBlock": 0, "londonBlock": 0,
      "shanghaiTime": 0, "cancunTime": 0,
      "qbft": { "blockperiodseconds": 2, "epochlength": 30000, "requesttimeoutseconds": 4 }
    },
    "nonce": "0x0", "timestamp": "0x0", "gasLimit": "0x1312d00", "difficulty": "0x1",
    "mixHash": "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
    "coinbase": "0x0000000000000000000000000000000000000000",
    "baseFeePerGas": "0x0",
    "alloc": {}
  },
  "blockchain": { "nodes": { "generate": true, "count": 1 } }
}
JSON

# 2) 生成创世 + 一把一次性密钥（探针专用，用完即删）
docker run --rm -u "$(id -u):$(id -g)" -v "$D:/d" $IMG \
  operator generate-blockchain-config --config-file=/d/qbft.json --to=/d/net --private-key-file-name=key
KEYDIR=$(ls -d "$D"/net/keys/0x*)

# 3) 起节点（注意 -u：不加就会造出 root 属主的 data-path，见 §5.2 的坑）
docker run -d --name bac-qbft-probe -u "$(id -u):$(id -g)" -v "$D:/d" -p 18546:8545 $IMG \
  --data-path=/d/data --genesis-file=/d/net/genesis.json \
  --node-private-key-file="/d/net/keys/$(basename "$KEYDIR")/key" \
  --rpc-http-enabled --rpc-http-host=0.0.0.0 --rpc-http-api=ETH,NET,WEB3,QBFT \
  --host-allowlist="*" --min-gas-price=1000000000 --p2p-enabled=false --data-storage-format=BONSAI

sleep 45
N=$(cast block-number --rpc-url http://127.0.0.1:18546)
V=$(cast rpc qbft_getValidatorsByBlockNumber '"latest"' --rpc-url http://127.0.0.1:18546)
MEM=$(docker stats --no-stream --format '{{.MemUsage}}' bac-qbft-probe)
docker rm -f bac-qbft-probe >/dev/null; rm -rf "$D"
[ "$N" -ge 1 ] && echo "QBFT OK on $IMG (height $N, validators $V, mem $MEM)" \
               || { echo "QBFT BROKEN on $IMG"; exit 1; }
```

**2026-09-22 实测输出：高度 21（45 秒）、validators 长度 1、内存 309 MiB、空转 CPU 7.4%。**

**记录进 runbook：我们现在跑在一个仍在维护的客户端上（这正是换掉 geth 的第一理由），但 30303 对公网开着 —— Besu 的安全公告要有人订阅，升级前先在一次性容器里用同一份 `genesis.json` 验一遍再滚。**

### 5.2 `docker compose`（`/opt/bac/compose.yml`）

```yaml
name: bac
services:
  besu:
    image: hyperledger/besu:24.12.2           # D0-1 验证过的 tag，不用 latest
    restart: unless-stopped
    user: "1001:1001"                         # ← ops 的 uid:gid（`id -u ops` / `id -g ops` 确认）
                                              #   不写这一行，容器会用镜像内的 besu 用户造出 root/besu 属主的 data-path，
                                              #   宿主上的 ops 既不能备份也不能删 —— 探针里就踩过一次
    stop_grace_period: 2m                     # RocksDB 要时间干净关闭；被 SIGKILL 打断会留下要修复的 DB
    environment:
      BESU_OPTS: "-Xmx2g -Xms512m"            # D0-5 定值。默认堆按机器内存比例算，7.7 GiB 上还跑着旧项目，不能放任
      LOG4J_CONFIGURATION_FILE: /config/log4j2.xml
    command:
      # --- 身份与数据 ---
      - --data-path=/data
      - --genesis-file=/config/genesis.json   # Besu 没有 `init` 步骤：每次启动都读这份文件；
                                              # 与 DB 里记录的创世哈希不一致会拒绝启动（这是个好性质，别绕过它）
      - --node-private-key-file=/secrets/key  # ← 同时是 enode 身份和 QBFT validator 身份，丢了两样一起丢
      - --data-storage-format=BONSAI          # §4.4；Besu 24.12 的 Bonsai 没有 archive 模式
      - --bonsai-historical-block-limit=512   # eth_call 的历史窗口 = 512 × 3 s ≈ 25.6 分钟（写进 /api/health 的 rpc.limits）
      # 不要加 --bonsai-limit-trie-logs-enabled：D0-9 实测 Besu 直接拒绝启动
      #   Cannot enable --bonsai-limit-trie-logs-enabled with --sync-mode=FULL and --data-storage-format=BONSAI
      # 单验证者私链的同步模式就是 FULL，所以在线修剪永远用不了，只能离线修剪（§4.4）
      - --sync-mode=FULL
      # --- HTTP RPC（只在 compose 内网，外部只经 caddy → indexer 的方法白名单）---
      - --rpc-http-enabled=true
      - --rpc-http-host=0.0.0.0
      - --rpc-http-port=8545
      - --rpc-http-api=ETH,NET,WEB3,QBFT,ADMIN,MINER
                                              # QBFT：读验证者集（对账与 /api/health 都要）
                                              # ADMIN：admin_nodeInfo 拿 enode 发布到 /api/health
                                              # MINER：miner_changeTargetGasLimit 热改吞吐（§4.3 应急）
                                              # 这三个只在内网可达；8545 不 publish，Caddy 也只反代到 indexer
      - --rpc-http-cors-origins=all           # Besu 的写法是字面量 `all`（或域名列表），不是 `*`
      - --host-allowlist=besu,localhost,127.0.0.1
                                              # 校验的是 HTTP Host 头。容器内互访是 http://besu:8545 → Host 为 `besu:8545`，
                                              # 所以必须含 `besu`。报 "Host not authorized" 就是这里
      - --rpc-http-max-active-connections=100
      - --rpc-max-logs-range=5000             # 与 §5.3 rpcguard 的 5000 块上限同一个数，节点自己也拦一道
      - --revert-reason-enabled=true          # agent 调试要看 revert string（我们的 require 全是双语字符串，白给的体验）
      # --- WebSocket（内网，给索引器订阅新块用）---
      - --rpc-ws-enabled=true
      - --rpc-ws-host=0.0.0.0
      - --rpc-ws-port=8546
      - --rpc-ws-api=ETH,NET,WEB3
      # --- p2p ---
      - --p2p-enabled=true
      - --p2p-host=95.179.183.132             # 公网 IP，写进 enode 发布给外部见证人
      - --p2p-port=30303
      - --nat-method=NONE                     # 有固定公网 IP，不要 UPnP/自动探测
      - --max-peers=50
      - --discovery-enabled=true              # 不能关：关了外部见证人就必须人工 admin_addPeer（§8）
      # --- 出块与 gas ---
      - --min-gas-price=1000000000            # 1 gwei，同时是出块下限和 txpool 下限；zeroBaseFee 下它是唯一的价格下限（§4.2）
      - --target-gas-limit=20000000           # 应急下调到 2000000；每块 ±1/1024，约 2.5 小时收敛（§4.3）
      # --- 指标与日志 ---
      - --metrics-enabled=true
      - --metrics-host=0.0.0.0
      - --metrics-port=9545                   # Prometheus 文本，只在内网；indexer 抓它填 /api/health 的机房面板
      - --logging=INFO
      - --engine-rpc-enabled=false            # 本链不是 PoS，不要平白监听 8551（若此 tag 不认这个 flag，D0-8 里删掉）
    volumes:
      - ./data/besu:/data
      - ./config:/config:ro                   # genesis.json + log4j2.xml
      - ./secrets/besu:/secrets:ro            # key（0600，ops 属主）
    ports:
      - "30303:30303/tcp"
      - "30303:30303/udp"
    expose: [ "8545", "8546", "9545" ]        # 都只在 compose 内网，外部只经 caddy
    mem_limit: 3g                             # D0-5；配合 -Xmx2g 留出 JVM 堆外与 RocksDB 的空间
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "3" }

  relayer:
    image: node:22-alpine
    restart: unless-stopped
    working_dir: /app
    command: [ "node", "src/index.mjs" ]
    volumes: [ "./relayer:/app", "./data/relayer:/var/bac" ]
    environment:
      LAYER_RPC: http://besu:8545
      LAYER_WS: ws://besu:8546
      LAYER_FINALITY: instant                 # QBFT 即时最终性：层侧不做确认深度、不做孤块处理（§6.2）
      BSC_RPC: https://bsc-rpc.publicnode.com
      BSC_RPC_2: https://bsc-dataseed.bnbchain.org     # 两个独立 RPC 都给出一致的 finalized 才算数（03 §1.2）
      DB_PATH: /var/bac/relayer.db
    env_file: [ ./secrets/relayer.env ]       # RELAYER_PRIVATE_KEY / RELAYER_LAYER_PRIVATE_KEY
    depends_on: [ besu ]
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "3" }

  indexer:
    image: node:22-alpine
    restart: unless-stopped
    working_dir: /app
    command: [ "node", "src/index.mjs" ]
    volumes: [ "./indexer:/app", "./data/indexer:/var/bac" ]
    environment:
      LAYER_RPC: http://besu:8545
      LAYER_WS: ws://besu:8546
      LAYER_METRICS: http://besu:9545/metrics # 机房面板：peers / txpool / 区块高度 / 磁盘（决策 #14）
      BSC_RPC: https://bsc-rpc.publicnode.com
      BSC_RPC_2: https://bsc-dataseed.bnbchain.org
      DB_PATH: /var/bac/index.db
      PORT: "8080"
    expose: [ "8080" ]
    depends_on: [ besu ]
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "3" }

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: [ "80:80", "443:443" ]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./data/caddy:/data
    depends_on: [ besu, indexer ]
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "3" }
```

**部署前必须先建好目录与属主**（`user: "1001:1001"` 只让容器以 ops 身份跑，它不会替你把已经是 root 的目录改回来）：

```bash
sudo mkdir -p /opt/bac/{config,secrets/besu,data/{besu,relayer,indexer,caddy},backup,scripts}
sudo chown -R ops:ops /opt/bac
chmod 700 /opt/bac/secrets /opt/bac/secrets/besu
chmod 600 /opt/bac/secrets/besu/key
id -u ops; id -g ops        # ← 与 compose 里的 user: "1001:1001" 逐字对上，不对就改 compose
```

**`config/log4j2.xml`**（把 Besu 的日志压成一行一条、不写文件、交给 docker 的 json-file 驱动轮转）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Configuration status="WARN">
  <Appenders>
    <Console name="Console" target="SYSTEM_OUT">
      <PatternLayout pattern="%d{yyyy-MM-dd HH:mm:ss.SSSZZZ} | %t | %-5level | %c{1} | %msg%n"/>
    </Console>
  </Appenders>
  <Loggers>
    <Root level="INFO"><AppenderRef ref="Console"/></Root>
    <!-- QBFT 的每轮共识日志在单 validator 下没有信息量，降到 WARN -->
    <Logger name="org.hyperledger.besu.consensus.qbft" level="WARN" additivity="false">
      <AppenderRef ref="Console"/>
    </Logger>
  </Loggers>
</Configuration>
```

**不写文件日志是有意的**：Besu 默认可以往 data-path 里写滚动日志，那会和 §4.4 的磁盘预算抢空间，而且 `docker logs` 与文件两份重复。

### 5.3 `Caddyfile`

```
95-179-183-132.sslip.io {
	encode gzip

	handle /rpc* {
		# 方法白名单在 indexer 的 /rpcguard 里做（Caddy 不能解 JSON-RPC body）
		reverse_proxy indexer:8080
	}

	handle /api* {
		reverse_proxy indexer:8080
	}

	handle /health {
		reverse_proxy indexer:8080
	}

	header {
		Access-Control-Allow-Origin "*"
		Access-Control-Allow-Headers "content-type"
		Access-Control-Allow-Methods "GET, POST, OPTIONS"
		Cache-Control "public, max-age=3"
	}

	@options method OPTIONS
	respond @options 204
}
```

**`/rpc` 的方法白名单由 `indexer` 进程实现**（它能读 JSON body）：只放行
`eth_chainId, eth_blockNumber, eth_getBlockByNumber, eth_getBlockByHash, eth_getTransactionByHash, eth_getTransactionReceipt, eth_getBalance, eth_getCode, eth_getStorageAt, eth_getLogs, eth_call, eth_estimateGas, eth_gasPrice, eth_maxPriorityFeePerGas, eth_feeHistory, eth_getTransactionCount, eth_sendRawTransaction, net_version, web3_clientVersion`
**外加两个 QBFT 只读方法**：`qbft_getValidatorsByBlockNumber, qbft_getValidatorsByBlockHash`（任何人都要能独立核对当届验证者集，这是 §4.1 对账公式可复算的前提）。
其它一律 `-32601`。**`qbft_proposeValidatorVote` / `qbft_discardValidatorVote` / `miner_*` / `admin_*` 永远不在白名单里**——它们是写方法，只在 compose 内网可达。
限速：每 IP 每秒 20 次、每分钟 600 次，超限返回 `-32005` 并**计入 `/api/health` 的 `rateLimited` 计数**。

**三条额外的硬限制（不加就是自伤）：**
1. `eth_getLogs` 必须满足 `toBlock − fromBlock <= 5000` **且**带 `address` 或 `topics`，否则返回 `-32602`。
   一笔 `fromBlock=0` 的 `getLogs` 会同时拖住节点和 `indexer`（rpcguard 和 SQLite 写入在同一个 Node 进程里，它还要服务网站 API）。
   **Besu 侧的 `--rpc-max-logs-range=5000` 是第二道**，两道同值，任何一道单独失效都不至于穿透。
2. `eth_call` 只支持**最近 512 个区块**的状态（`--bonsai-historical-block-limit` 的值，≈ 25.6 分钟），这一点要写进
   `/api/health` 的 `rpc.limits` 和网站的 RPC 说明页，不能让 agent 以为能对任意旧区块做 `eth_call`。
   **这个数字比 Clique 版的 128 块宽，但它仍然是「最近若干分钟」，不是「任意历史」。**
3. `rpcguard` 与索引写入**拆成两个进程**（或至少把 RPC 代理放进独立 worker），不要让一次慢查询同时打掉三件事。

**明确不做：** `eth_sendRawTransaction` 的发送者过滤。Caddy 不能 RLP 解码 + `ecrecover`，另写一个代理是第五个进程，而且 p2p 直接绕过去。门禁靠「没有积分就没有 gas」这一层（`00 §4.2`）。

### 5.4 systemd / 开机自启 / 监控

```bash
# 决策 #8 授权范围内
sudo mkdir -p /opt/bac && sudo chown -R ops:ops /opt/bac
sudo ufw allow 80,443/tcp
sudo ufw allow 30303/tcp
sudo ufw allow 30303/udp
sudo ufw status numbered
```

**状态膨胀应急流程（这是本链唯一真实、可执行、可逆的控制手段，必须演练一次）：**

```bash
# 触发线：data-path 日增 > 500 MB 且持续 6 小时（监控见下）
# 1) 热改，立即生效、不停机（MINER API 只在 compose 内网可达）
docker compose -f /opt/bac/compose.yml exec -T indexer \
  node -e 'fetch("http://besu:8545",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"miner_changeTargetGasLimit",params:[2000000]})})
    .then(r=>r.text()).then(console.log)'
#    约 3,050 个块 ≈ 2.5 小时收敛（EIP-1559 每块 ±1/1024）

# 2) 持久化，否则下次重启悄悄涨回 20M
sed -i 's/--target-gas-limit=20000000/--target-gas-limit=2000000/' /opt/bac/compose.yml

# 3) 立刻可见：/api/health 的 layer.gasLimit（indexer 每个块读 header 的 gasLimit，不是读配置）
# 4) 同时在网站挂公告，写明原因与恢复条件（这是一个单方面的全链吞吐开关，必须公开）
# 5) 恢复：反向改回 20000000（热改 + 改回 compose），同样 2.5 小时收敛
```

开机自启用 compose 的 `restart: unless-stopped` + 一个 systemd unit 保证 docker 起来后拉起 compose：

```ini
# /etc/systemd/system/bac.service
[Unit]
Description=BNB Agent Chain stack
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/bac
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStopSec=180
User=ops

[Install]
WantedBy=multi-user.target
```

（`TimeoutStopSec=180` 要大于 compose 里的 `stop_grace_period: 2m`，否则 systemd 会在 RocksDB 还没关干净时把它打死。）

**监控 crontab（每 5 分钟，告警走 webhook，不写文件）：**

```
*/5 * * * * /opt/bac/scripts/alert.sh
```

`alert.sh` 检查并在任一项越线时 POST 到 webhook：

出块延迟 > 30 s · 锚点超 `epochEnd + 2h` 未发 · 连续 3 纪元零见证 · BSC 侧 `totalCreditsIssued` 与层内流通量的对账差额非零 · 中继 BSC 余额 < 0.05 BNB 或层内余额 < 100 BAC · **node key 文件哈希变更** · Besu data-path / `index.db` 体积越过 80% · `AnchorVetoed` / `AnchorDisputed` / `EscapeArmed` / `Halted` 事件 · `TaxProcessor.marketAddress() != vault` · **data-path 日增 > 500 MB 且持续 6 小时**（触发上面的 gasLimit 应急流程） · `BacBridge.skippedEpochs()` 连续增长 3 次 · `BacBridge.isPaused()` 的 `cumulative` > 14 天 · 金库 `accountedQuote()` 连续 2 个纪元非零且单调上升（没人调 `settle()`） · `BacNodeFund.owner()` 变更 · 层内 head 时间戳与 BSC head 时间戳之差 > 120 秒（层内纪元边界由本机 NTP 决定，必须装 `chrony`）

**换成 QBFT 之后新增或改写的五条：**

| 告警 | 阈值 | 为什么 |
|---|---|---|
| **`qbft_getValidatorsByBlockNumber("latest")` 与预期集合不一致** | 任何差异即告警 | 验证者集是可以被投票改的（§6.1）。集合无声变化 = 出块权无声变化，这是本链最严重的一类事件 |
| **每个 validator 的层内余额非单调不减** | 任何一个减少即告警 | 它们必须永久零出账，否则 §4.1 的对账式失效（旧版只盯一个 Clique 签名者，现在盯一个集合） |
| **JVM 堆使用率 > 85% 持续 10 分钟** | 85% / 10 min | Besu 特有。GC 抖动会先表现为出块间隔毛刺，再表现为 OOM-kill；从 `--metrics-port=9545` 的 `jvm_memory_bytes_used` 读 |
| **容器 OOM-kill 计数 > 0** | 任何一次 | D0-5 定的 `-Xmx2g` / `mem_limit: 3g` 不对就要立刻知道，而不是靠「链怎么又重启了」 |
| **Besu data-path 里的 trie log 体积占比 > 30%** | 30% | D0-9 那个已知的无界增长坑，早发现能在冷备窗口里顺手修剪，晚发现就是紧急停机 |

**被删掉的一条**：Clique 版里那条「签名节点在被见证之前改写历史」的重组类监控**不再需要层侧实现**（§6.2）。但**「层内出现 parentHash 断链」这个检测必须保留**，并且从「触发回滚逻辑」改成「立即告警并停止推进游标」——QBFT 下这不可能发生，所以一旦发生就不是重组，是事故（数据库损坏、连错链、或者有人在跑第二条链）。

### 5.5 备份纪律

```bash
# 每周日 04:00：停 5 分钟打冷备，保留 2 份，然后立刻推到异机
0 4 * * 0 /opt/bac/scripts/coldbackup.sh
```

`coldbackup.sh`：

```bash
set -euo pipefail
cd /opt/bac
D=$(date +%F)

# 1) 干净停机（stop_grace_period: 2m 让 RocksDB 关完；docker compose stop 默认只给 10 秒，必须显式给够）
docker compose stop -t 150 besu

# 2) 冷备 data-path。绝不对运行中的 data-path 打 tar：RocksDB 没有在线一致快照，
#    正在写的 SST/WAL/MANIFEST 会让备份不是崩溃一致的，恢复时 Besu 直接拒绝启动
tar -C data -czf "backup/besu-$D.tgz" besu

# 3) 立刻起回来（停机时长要记进日志，D0-7 实测过一次）
docker compose start besu

# 4) 索引器可以在线备份（SQLite 有一致快照）
sqlite3 data/indexer/index.db "VACUUM INTO 'backup/index-$D.db'"

# 5) 只保留最近 2 份
ls -1t backup/besu-*.tgz | tail -n +3 | xargs -r rm -f
ls -1t backup/index-*.db | tail -n +3 | xargs -r rm -f

# 6) 推到异机（目标待定，见 [待定] 6）
rclone copy backup "$REMOTE:bac-backup" --include "*-$D.*"
```

**三件必须单独离线备份、且不在每周备份里的东西（它们永远不变，变了就是事故）：**

| 东西 | 在哪 | 丢了会怎样 |
|---|---|---|
| `secrets/besu/key` | node private key | **同时是 enode 身份和 QBFT validator 身份**。丢了：链没有 validator，**彻底停止出块**，而且新起一个 validator 需要改创世 = 另一条链。这比 Clique 的 `nodekey` 严重一个数量级（Clique 下 nodekey 和签名 key 是两个文件，这里是同一个），必须离线双份 |
| `config/genesis.json` | 创世文件 | Besu 每次启动都要读它；丢了可以用 §3 重建，但**必须逐字节一致**，否则创世哈希对不上、DB 拒绝加载 |
| 中继的两把私钥 | `secrets/relayer.env` | 见 `00` §4.4 的轮换通道 |

**放在同一块盘上的备份在整机故障时等于没有。最终重建路径永远是「创世文件 + node key + 从 BSC 重放」。**

---

## 6. QBFT 带来的三件好事（验证者治理 · 即时最终性 · 合约模式）

### 6.1 验证者集治理：投票，不改创世

Clique 有 `clique_propose`，QBFT 有一组等价但更完整的 API（都在 `QBFT` namespace，**只在 compose 内网可达，永不进 `/rpc` 白名单的写方法部分**）：

| 方法 | 作用 |
|---|---|
| `qbft_getValidatorsByBlockNumber(blockNumber)` | 读某个高度的验证者集。**只读，进 `/rpc` 白名单**，任何人可核 |
| `qbft_getValidatorsByBlockHash(hash)` | 同上，按哈希 |
| `qbft_proposeValidatorVote(address, true\|false)` | 投票加入（`true`）/ 移出（`false`）一个验证者。每个现任验证者各投一次，**得票超过半数时在下一个块生效** |
| `qbft_discardValidatorVote(address)` | 撤回本节点尚未生效的投票 |
| `qbft_getPendingVotes` | 看当前有哪些待定投票 |
| `qbft_getSignerMetrics` | 每个验证者近期提案了多少块——**用来发现某个验证者事实上掉线**，v1.5 扩容后是必备监控 |

**加入一个验证者的强制流程（每一步都不许跳）：**

```bash
R=http://127.0.0.1:8545      # 只在服务器本机 / compose 内网执行

# 0) 前置：新验证者地址的层内余额必须为 0（§4.2 第 3 条），并已写进索引器的 everValidator 表
cast balance <NEW_VALIDATOR> --rpc-url $R                       # 必须是 0

# 1) 每一个现任验证者各投一票（v1 只有一个，所以一条命令就生效）
cast rpc qbft_proposeValidatorVote '"<NEW_VALIDATOR>"' true --rpc-url $R

# 2) 看待定投票
cast rpc qbft_getPendingVotes --rpc-url $R

# 3) 等一个块，确认集合真的变了
cast rpc qbft_getValidatorsByBlockNumber '"latest"' --rpc-url $R

# 4) 立刻更新：索引器的 everValidator 表、/api/health 的 layer.validators[]、网站的「谁在出块」区块、§5.4 的告警预期集合
# 5) 在网站挂公告。出块权变化必须公开，和 §4.3 的 gasLimit 开关同一条纪律
```

移出一个验证者把第 1 步的 `true` 换成 `false`。**`epochlength: 30000` 的意义就在这里**：每 30000 块清空一次所有尚未过半的待定投票，防止一张三个月前投下的票在某天突然凑够数生效。

**关于「切换出块节点」：** Clique 下换签名者是「投票换地址」，QBFT 下一样；但因为 node key 同时是 validator 身份和 enode 身份，**换 validator 必然换 enode**，所以第 4 步里还必须更新 `/api/health` 的 `enode` 与网站上的 bootnode 地址（§8）。这一条在 Clique 下不存在，很容易漏。

### 6.2 即时最终性：层侧删掉哪些代码（BSC 侧一行不动）

**QBFT 的性质：一个块被 commit（拿到 2/3+ 的 commit seal）就是最终的。层内没有分叉选择规则，没有更长链，没有孤块，没有重组。**

这直接推翻了 `00` §0.1 G9 里为层侧写的那一半重组处理。**逐条写明删什么、留什么：**

| 位置 | Clique 时代要做的 | QBFT 下 | 状态 |
|---|---|---|---|
| 中继读层内 `ExitBurned` 日志 | 等 N 个确认、发送前重读收据确认日志还在规范链上 | 日志一上块就是终局 | **层侧整段删除** |
| 中继的 `outbox` `status = "orphaned"` | credit / anchor / sync 三种 job 都可能进入 | **只有 BSC 来源的 job（`credit` / `sync`）还需要它**；`anchor` job 的数据源是层内，不可能孤块 | **`anchor` 分支删除，`credit` / `sync` 分支保留**（`03` §1.2 一字不改） |
| `l2Block(epoch)` / `l2BlockHash(epoch)` | 取值后还要担心那个块被重组掉 | 取到即终局，见证人可以在纪元边界一过就 commit | **「等待层内确认深度」这一步删除**；`03` §1.3 的规范定义本身不变 |
| 索引器的层内游标 | 检测 parentHash 断链 → 回滚已写入的区块 → 从分叉点重放 | 断链在 QBFT 下不可能发生 | **回滚与重放逻辑删除；检测保留**，并改成「立即告警 + 停止推进游标 + 不自动恢复」（§5.4）。这不是重组，是事故 |
| 网站的「N 个确认后视为安全」提示 | 层内交易要标确认数 | 层内交易上块即 FINAL | **层侧的确认数 UI 删除**，改成「已最终确认 · 区块 #N」。BSC 侧的确认数 UI **保留** |
| `00` §7.2 attack-gate「签名节点在被见证之前改写历史」 | 需要 veto + 见证人异议兜底 | **威胁没有消失，只是换了形状**：官方节点仍然可以**停止出块**、**审查交易**、**在出块前自由排序**，但**不能重写已 commit 的块** | **不删。** 信任表里那一行从「可重写历史」改成「可审查、可排序、可停机，不可重写已 commit 的块」 |

**BSC 侧的重组处理一个字都不动**（`03` §1.2）：`finalized` 标签 + 两个独立 RPC 一致 + 深度 ≥ 15 + 墙钟 ≥ 45 秒 + 发送前收据二次核对 + `orphaned` 标记 + `finalized` 取不到时 fail-closed 停发 `credit`。
**BSC 是一条有概率最终性的外部链，我们对它的怀疑不因为自己这边换了共识而减少一分。**

**必须同时保留的那句话：** 即时最终性**不是**安全性提升。它去掉的是「层内历史可能被重排」这一类工程复杂度，**没有**去掉「一个官方节点完全决定层内内容与顺序」这个事实（`00` §2 信任表）。任何把 BFT 说成「更去中心化」的文案都是错的。

### 6.3 validator-contract 模式：v2 让 `ValidatorStaking` 直接驱动出块权

Besu 的 QBFT 支持**合约模式**：验证者集不再由投票维护，而是由一个链上合约的 `getValidators()` 给出。

```json
"transitions": {
  "qbft": [
    {
      "block": <SWITCH_BLOCK>,
      "validatorselectionmode": "contract",
      "validatorcontractaddress": "0x0000000000000000000000000000000000000105"
    }
  ]
}
```

**这正好对上产品设计的终点**（`00` §2 的 v2 列、决策 #5）：人类在 BSC 上质押 BAC → 成为见证人 → 见证人里质押最高且连续见证达标的那几个，**自动成为层内出块者**。
路径：中继把 `ValidatorStaking` 的排名镜像到层内一个新的系统合约 **`0x…0105`**（`getValidators()`），Besu 在 `<SWITCH_BLOCK>` 之后直接读它。

**地址变更（决策 #17）：这一段原本写的是 `0x…0104`，现在 `0x…0104` 已经给了 `FeeSplitter`（`01` §11），所以 v2 的验证者集镜像合约后移到 `0x…0105`。**
两个地址在 §2 的创世表里都已经占住，不允许被别的东西用掉。

**v1 明确不做，原因要写下来，不然这一段会被当成已经有了：**

1. `transitions` 要写进**创世**（或至少要在切换块之前让所有节点拿到同一份 genesis.json），而 `0x…0104` 的地址、ABI、镜像规则都还没定稿。
2. 合约模式把「谁能出块」交给了**中继镜像过来的数据**。中继是单点（`00` §2），等于把出块权的来源接到一个已知的单点上——**在见证人数量还是个位数、`ValidatorStaking` 还没经受过真实博弈之前，这是把风险放大而不是缩小。**
3. 出块权和领奖资格一旦合一，`removeValidator` 那条「48 小时时锁只取消领奖资格、本金照样取回」的温和设计就变成了「48 小时后把人踢出出块集」，是完全不同量级的权力，要重新做威胁建模。

**v1 的做法：`qbft_proposeValidatorVote` 手工投票（§6.1），每一次都在网站公告。** 合约模式作为 v2 的既定路线写在这里，是为了让 `0x…0105` 这个地址**现在就预留出来、不被别的东西占用**。

**决策 #17 给了它一个新的先决条件：**出块资格现在在 BSC 侧有了一个明确的布尔值 `ValidatorStaking.proposerRights(v)`（`01` §11.5）。
v2 的镜像合约应该直接拿它做数据源，而不是再发明一套排名规则；但上面三条「v1 明确不做」的理由一条也没变。

### 6.4 扩容时的硬数学：下一步是 4 个验证者，不是 3 个

BFT 的 quorum 是 `ceil(2n/3)`，能容忍的故障数是 `f = floor((n-1)/3)`：

| n | quorum | 容错 f | 含义 |
|---|---|---|---|
| 1 | 1 | 0 | v1。单点，任何停机就是全链停机 |
| 2 | 2 | 0 | **比 1 个更糟**：两台都必须在线，可用性是两者的乘积 |
| 3 | 2 | 0 | **容错仍然是 0**：`floor((3−1)/3) = 0`。停一台还剩 2 个，正好够 quorum，看起来能跑；但只要那一台不是干净地停机而是发错消息（或时钟跑偏、GC 卡住反复超时），就足以让共识停摆。**不要被「3 个比 1 个安全」的直觉骗了** |
| **4** | **3** | **1** | **第一个真正有容错的配置** |
| 7 | 5 | 2 | |

**所以 `00` §2 里那句「v1.5 签名者扩到 3 个（官方 1 + 质押最高且连续见证 30 天的验证者 2），Clique 2/3」在 QBFT 下必须改成 4 个（官方 1 + 验证者 3）。**
照抄 Clique 的「3 个签名者」到 QBFT 上，会得到一个**可用性比现在更差、容错依然是 0、但多了两个外部依赖**的配置——这是换共识时最典型的一个抄错。
这条改动属于 `00-DESIGN-SPEC.md` §2 的 v1.5 列，本文只负责把数学写清楚并点名它需要改。

**扩容的现实前提**：每多一个 validator，就多一台必须长期在线、时钟同步、且愿意被 `requesttimeoutseconds = 6` 约束的机器。在见证人还是个位数的时候，n=1 的「停机 = 停链，但恢复只要重启」比 n=4 的「四台里有两台掉线 = 停链，而且要协调四个人」更容易运维。**扩容的触发条件是见证人数量和他们的在线质量，不是日历。**

---

## 7. 人类见证人：从零到领奖的逐条命令（Besu）

**先说清楚：v1 的见证人不是出块者，是见证人。** 出块由一个官方 QBFT validator 做（决策 #6、§0.5 的术语表）。见证人做三件事：独立同步、独立算根、在 BSC 上承诺-揭示。

### 7.0 前置

- 一台能长期在线的机器：2 vCPU / **4 GB 内存（Besu 是 JVM，比 geth 吃内存；`-Xmx2g` 是下限，建议 4 GB 起）** / 60 GB 可用磁盘，Docker 已安装。
- 一个 BSC 钱包，里面有 ≥ `2,000,000 BAC` 和一点 BNB 付 gas（每纪元两笔交易，0.05 gwei 下约 0.00001 BNB/天）。
- **收益说明：奖励来自 `ValidatorStaking` 合约里的 BNB 余额，余额来自运营方从节点基金注入。税收是 0 的时候奖励就是 0，见证还要自己出 gas。不承诺任何收益。**

### 7.1 起一个只读全节点

**和 geth 最大的不同：Besu 没有 `init` 这一步。** 创世文件在每次启动时被读取，并与数据库里记录的创世哈希比对，不一致就拒绝启动。所以你**必须**保留这份 `genesis.json`。

```bash
mkdir -p ~/bac-validator/config && cd ~/bac-validator
curl -fsSL https://95-179-183-132.sslip.io/api/genesis > config/genesis.json

# 核对创世哈希（同一个值也在网站首页和 GitHub 上）
sha256sum config/genesis.json

cat > compose.yml <<'YAML'
name: bac-validator
services:
  besu:
    image: hyperledger/besu:24.12.2
    restart: unless-stopped
    user: "1000:1000"                 # ← 换成你自己的 `id -u`:`id -g`。不写就会造出 root 属主的 data 目录
    stop_grace_period: 2m
    environment:
      BESU_OPTS: "-Xmx2g -Xms512m"
    command:
      - --data-path=/data
      - --genesis-file=/config/genesis.json
      - --data-storage-format=BONSAI
      - --sync-mode=FULL
      - --bootnodes=<OFFICIAL_ENODE>
      - --p2p-port=30303
      - --max-peers=25
      - --rpc-http-enabled=true
      - --rpc-http-host=0.0.0.0
      - --rpc-http-port=8545
      - --rpc-http-api=ETH,NET,WEB3,QBFT
      - --host-allowlist=*
      - --min-gas-price=1000000000
      - --logging=INFO
    volumes:
      - ./data:/data
      - ./config:/config:ro
    ports:
      - "30303:30303/tcp"
      - "30303:30303/udp"
      - "127.0.0.1:8545:8545"         # 只绑本机
    mem_limit: 3g
  attester:
    image: node:22-alpine
    restart: unless-stopped
    working_dir: /app
    command: [ "npx", "-y", "@bac/node-cli", "attest" ]
    environment:
      LAYER_RPC: http://besu:8545
      BSC_RPC: https://bsc-rpc.publicnode.com
      BSC_RPC_2: https://bsc-dataseed.bnbchain.org     # 两个独立 RPC 都给出一致的 finalized 才算数（03 §1.2）
      NODE_ID: "<你给自己节点起的名字>"
    env_file: [ ./validator.env ]     # VALIDATOR_PRIVATE_KEY=0x…
    depends_on: [ besu ]
YAML

docker compose up -d
docker compose logs -f besu           # 等它追上高度
```

**追上之后，做这四次核对（全部是只读，任何人都该做一次）：**

```bash
R=http://127.0.0.1:8545

# 1) 链对不对
cast chain-id --rpc-url $R                                          # == 56777

# 2) 创世哈希对不对（和网站/GitHub 上公布的那个逐字比）
cast rpc eth_getBlockByNumber '"0x0"' false --rpc-url $R | jq -r .hash

# 3) 谁在出块（v1 应该正好一个地址；变了就是出块权变了，§6.1 要求我们公告，没公告就来问）
cast rpc qbft_getValidatorsByBlockNumber '"latest"' --rpc-url $R

# 4) 三个系统合约真的在创世里，而不是后来部署的
cast code 0x0000000000000000000000000000000000000101 --rpc-url $R | head -c 20
cast balance 0x0000000000000000000000000000000000000101 --rpc-url $R
cast rpc eth_getTransactionCount '"0x0000000000000000000000000000000000000101"' '"latest"' --rpc-url $R
```

**你自己也能重建整条对账式**（§4.1，这是见证人最该学会的一条命令，它不需要信任我们的网站）：

```bash
R=http://127.0.0.1:8545
BRIDGE=0x0000000000000000000000000000000000000101
SINK=0x000000000000000000000000000000000000dEaD
for V in $(cast rpc qbft_getValidatorsByBlockNumber '"latest"' --rpc-url $R | jq -r '.[]'); do
  echo "validator $V: $(cast balance $V --rpc-url $R)"
done
echo "bridge: $(cast balance $BRIDGE --rpc-url $R)"
echo "sink:   $(cast balance $SINK   --rpc-url $R)"
# 层内流通 = 1e27 − bridge − sink − Σ validator
# 它必须等于 BSC 上 BacBridge.totalCreditsIssued() − totalCreditsExited() − sink − Σ validator（§4.1 的 diff 恒为 0）
```

官方 enode（`<OFFICIAL_ENODE>`）公布在 `https://95-179-183-132.sslip.io/api/health` 的 `enode` 字段和网站的见证人页上，形如
`enode://<128 hex>@95.179.183.132:30303`。
**enode 变了就意味着官方节点换了 node key，而 node key 同时是 validator 身份（§6.1）——这种变更我们必须提前公告，没公告的变更请当成事故来问。**

### 7.2 在 BSC 上质押并注册节点

```bash
export BSC=https://bsc-rpc.publicnode.com
export BAC=<BAC 代币地址，发射后公布>
export STAKING=<ValidatorStaking 地址>

# 1) 授权（精确额度，不要无限授权）
cast send $BAC "approve(address,uint256)" $STAKING 2000000000000000000000000 \
  --rpc-url $BSC --account my-validator

# 2) 质押
cast send $STAKING "stake(uint256)" 2000000000000000000000000 \
  --rpc-url $BSC --account my-validator

# 3) 注册节点（nodeIdHash 自己定，enode 用你自己节点的）
#    你的 enode id 从 Besu 拿：
docker compose exec -T besu besu public-key export --node-private-key-file=/data/key
#    或者直接问节点自己：
cast rpc admin_nodeInfo --rpc-url http://127.0.0.1:8545 | jq -r .enode
NODE_ID=$(cast keccak "my-node-01")
cast send $STAKING "registerNode(bytes32,string,address)" \
  $NODE_ID "enode://<你的 128 hex>@<你的公网 IP>:30303" <收款地址> \
  --rpc-url $BSC --account my-validator

# 4) 确认
cast call $STAKING "nodeOf(bytes32)(address,address,string,bool,uint32)" $NODE_ID --rpc-url $BSC
cast call $STAKING "stakeOf(address)(uint256,uint256,uint64)" <你的地址> --rpc-url $BSC
```

（`admin_nodeInfo` 需要 `ADMIN` 在你自己节点的 `--rpc-http-api` 里；上面的 compose 没开，要用就临时加一次再去掉，或者用上面那条 `besu public-key export`。）

### 7.3 每个纪元自动做的事（`@bac/node-cli attest` 内部逻辑，可自己实现）

```
纪元 N 结束（UTC 00:00）后：
  1) l2Block = 时间戳 < (N+1)*86400 的最大区块号；l2BlockHash = 该区块哈希
     ← **规范定义，三处实现（relayer / SDK / node-cli）必须字节级一致**（03 §1.3）。
       绝不能用「中继提交时的 head」：那个值你猜不到，猜错就会被算成异议。
       层内零区块的纪元：l2Block 等于上一纪元的值（空纪元锚点，合约用 >= 放行）。
     ← **QBFT 下这个块一上链就是终局**，你不需要等确认数，纪元边界一过就可以算（§6.2）。
  2) 在区块区间 (l2Block(N-1), l2Block(N)] 上读全部 L2Bridge.ExitBurned 日志，
     按 exitId 升序构造 merkle 树 → exitRoot
     ← 叶子里**没有 epoch 字段**；分桶以事件里的 epoch 字段为准。
  3) salt = 随机 32 字节，存本地
  3.5) 在同一个区间上逐块累加每个 proposer 的 gas 收入与已归集额（§4.2.1 的逐字算法），
       按 proposer 地址升序排序 → proposerIncomeRoot = keccak256(abi.encode(rows))
  4) 在 BSC 上：ValidatorStaking.commitAttestation(N, keccak256(abi.encode(N, exitRoot, proposerIncomeRoot, l2BlockHash, l2Block, salt, 你的地址)))
     ← 截止时间是 (N+1)*86400 + COMMIT_WINDOW(2 小时)，**由合约写死，中继压不了它**。
       你有整整 2 小时，而官方中继在这 2 小时之内根本发不出锚点。
  5) 等官方 postAnchor(N) 出现（事件 AnchorPosted）
  6) 24 小时窗口内：ValidatorStaking.revealAttestation(N, exitRoot, proposerIncomeRoot, l2BlockHash, l2Block, salt)
     ← 就算你算出来的根和官方不一样，也照样提交你自己看到的那个
  7) finalize(N) 之后（任何人可调）：
     settleEpochRewards(N)（任何人可调，**必须按序**）→ claimReward(N, 你的地址) 领你那份
```

**四元组 `(exitRoot, proposerIncomeRoot, l2BlockHash, l2Block)` 全等才算「同意」**，否则计入异议权重。
`proposerIncomeRoot` 是决策 #17 加的第四项：它把「这个纪元每个出块者收了多少 gas、又往分账合约转了多少」放进了你签字的范围。
**你的节点本来就有这些区块，算它不需要任何额外的数据源**；没有它，官方就是自己给自己填对账单。
异议要真的把一个纪元打成 `DISPUTED`，必须**同时**满足三条：`disputingWeight >= agreeingWeight`、
`disputingWeight >= 总质押的 1/3`、**异议者的独立地址数 >= 3**。
**单个地址永远无法独自制造 `DISPUTED`** —— 否则 200 万 BAC（v1 不罚没，7 天后原样取回）就买到了一个全链终止开关。
`DISPUTED` 的纪元不释放任何 BNB，退出叶子并入下一个纪元的锚点重报（叶子不变，照样能证明），
`settleEpoch` 会跳过它继续推进（`collect` 不会因此冻结）。
30 个纪元内累计 3 次 `DISPUTED` → **武装**逃生（14 天，期间条件消失则可由 veto 钥取消）。
**这是见证人真正的刹车，也是给他们发钱的唯一正当理由。**

**QBFT 让一类假异议消失了**：Clique 下，如果你在官方发锚点之前刚好碰上一次层内重组，你算出的 `l2BlockHash` 会和最终的不一样，于是一个完全诚实的见证人被计入异议权重。QBFT 下不存在这条路径——**`l2BlockHash` 不一致只可能是「你和官方看到的不是同一条链」，那就是真异议，应该报。**

### 7.4 领奖与退出

```bash
cast send $STAKING "settleEpochRewards(uint64)" <N>            --rpc-url $BSC --account my-validator
cast call $STAKING "rewardOf(uint64,address)(uint256)" <N> $ME --rpc-url $BSC
cast send $STAKING "claimReward(uint64,bytes32)" <N> $NODE_ID  --rpc-url $BSC --account my-validator

# 退出（本金 7 天冷却后可取；v1 没有罚没，取消领奖资格也不会动本金）
cast send $STAKING "requestUnstake(uint256)" <数量> --rpc-url $BSC --account my-validator
# 7 天后
cast send $STAKING "withdrawUnstaked(address)" <收款地址> --rpc-url $BSC --account my-validator
```

### 7.5 见证人必须知道的几件事（写进网站的见证人页）

1. **v1 没有罚没。** 报错根只是那一纪元拿不到奖励；`removeValidator` 经 48 小时时锁只取消领奖资格，**本金照样取回**。
2. **奖励不是税收的强制分账。** 它来自运营方往 `ValidatorStaking.fundRewards()` 里注入的 BNB；注入多少、什么时候注入，合约不强制。每一笔注入都有事件，网站按纪元公开「本纪元奖池 / 累计注入 / 累计发放」。
3. **你可以从官方 RPC 抄数据而不真跑节点，合约分不出来。** 我们知道这一点，也照实说。commit-reveal 只能保证「你在官方发锚点之前就写下了答案」。
4. **上线初期见证人很可能是 0 个。** 那时候 `releaseBpsFor` 恒为 200 bps、所有锚点自动 FINAL、中继提交的 `exitRoot` 没有任何独立方核对。这不是缺陷描述，是当前状态（`00` §5 开头逐字同一段话）。合约里唯一不依赖见证人的兜底是「零见证时任意连续 30 个纪元累计释放不超过桥池 15%」。
5. **你的质押必须一直覆盖你注册的节点数**：`requestUnstake` 会检查 `staked − amount >= MIN_STAKE × 你的节点数`，要减仓先 `retireNode`。
6. **权重按地址算，不按节点算**：同一个地址注册多个 `nodeIdHash` 不会让你的见证权重或奖励变成多份。
7. **你跑的是只读全节点，不是 QBFT validator。** 你的节点不出块、不投票、不影响共识（§0.5）。v2 的 validator-contract 模式（§6.3）才会把这两件事连起来，那时候会有单独的公告和一份新的文档，不会悄悄发生。
8. **层内交易上块即最终**（§6.2）。不要在自己的工具里给层内交易做「等 N 个确认」——没有那回事。BSC 侧照旧要等。
9. **你的收入有两笔，在两条链上，单位不同**（决策 #17）：BSC 侧的 BNB 奖励（运营方注入，不是强制分账），和层内 `FeeSplitter.claimPool` 发的 **gas 费验证者池**（官方出块的 10%，按 质押 × attend30 分，单位是层内 BAC）。后者要换成 BNB 得走和 agent 完全相同的退出路径，**不承诺任何兑付金额**。
10. **拿到出块资格之后你多一条义务**：把自己出的块的 50% 转进 `FeeSplitter`。欠款超容差会被**扣发 BSC 奖励 + 撤销出块资格**（§7.6.3），但**不罚没本金**。

### 7.6 gas 费的归集：阶段 1 与阶段 2 的操作规程（决策 #17）

**这一节是运维规程，不是机制。** 机制在 §4.2.1 与 `01` §11；这里只写「每天到底要跑哪几条命令、什么时候跑、跑不成怎么办」。
**归集这一步没有任何合约能强制**，所以它必须被当成一个有明确截止时间、有告警、有公开差额的日常作业来对待。

#### 7.6.1 时间线（每个 UTC 日）

```
T = (epoch+1) × 86400        纪元 N 结束（UTC 00:00）
T + 0 ~ T + 2h               见证人算根、算 proposerIncome、在 BSC 上 commitAttestation
                             ★ 归集窗口：所有 proposer 必须在 T + 2h 之前把该纪元的钱转进 FeeSplitter
T + 2h                       COMMIT_WINDOW 关闭，中继才被允许 postAnchor(N, anchor, rows)
                             rows[i].remitted 取 l2Block(N) 这个高度上的 FeeSplitter.remittedBy(N, proposer)
T + 2h ~ T + 26h             24 小时挑战窗口，见证人 revealAttestation
T + 26h                      任何人可 finalize(N)
T + 26h 起                   中继 setEpochWeights(N, members, weights)；验证者可以 claimPool(N, to)
T + 2 个纪元之后              任何人可 settleRemittance(N)（按序、带 REMIT_GRACE_EPOCHS = 2 的宽限）
```

**归集窗口迟到会怎样：** 不会被拒收（`FeeSplitter` 接受任何已结束纪元的归集），
只是这一笔不会被计进纪元 N 的 `rows[i].remitted`，而是落到它实际到账的那个纪元。
因为 `ValidatorStaking` 用的是**累计比较**（`cumOwed` vs `cumRemitted`，`01` §11.5），
晚一两天补齐不会构成短缺；**长期少转一定会**。

#### 7.6.2 阶段 1：官方节点的每日归集

```bash
export L2=https://95-179-183-132.sslip.io/rpc
export SPLITTER=0x0000000000000000000000000000000000000104
export OFFICIAL=<官方 QBFT validator 的层内地址>        # = header.coinbase
export EPOCH_N=<刚结束的纪元号，= 上一天的 timestamp/86400>

# 1) 算这个纪元官方节点收了多少 gas 费（逐块累加，§4.2.1 的规范算法）
#    生产环境用索引器的 /api/fees/{epoch}；下面这条只是人工复核用的最小实现
node /opt/bac/ops/gas-income.js --epoch $EPOCH_N --proposer $OFFICIAL

# 2) 留出下一次归集交易自己的 gas（见下面的「留底」），其余整额转进分账合约
cast send $SPLITTER "remitOfficial(uint64)" $EPOCH_N \
  --value <上一步算出的金额 - 留底> --rpc-url $L2 --account bac-official

# 3) 立刻自查三个数（这三个数就是网站对账面板显示的那三个）
cast call $SPLITTER "epochFees(uint64)" $EPOCH_N --rpc-url $L2
cast balance $OFFICIAL --rpc-url $L2
```

**「留底」是一条硬纪律：** 官方节点的 EOA 里必须永远留得下未来若干笔归集交易的 gas，
否则它会把自己饿死在一个「没钱发归集交易 → 差额越来越大」的死循环里。留底额写进 runbook，建议 ≥ 200 BAC。
**留底本身也要出现在对账里**（它属于「已收但未转入」的一部分，不是丢失的钱），网站上标注为「运营留底」。

**这一步是受信的，它的全部约束是可对账**（`00` §2 新增的两行信任表）：
`已收 = Σ proposerIncome(epoch, OFFICIAL).gasIncome`、`已转入 = Σ remitted`、`差额 = 已收 − 已转入`，
三个数都在锚点里、都被见证人签过，任何人也能自己从层内区块重算（`03` §3.7）。
**没有任何合约会因为官方不归集而惩罚官方 —— 这一句必须写在网站上，不许省略。**

#### 7.6.3 阶段 2：拿到出块资格的验证者

**先在 BSC 上把层内地址登记进去**（不登记就没人知道哪个层内出块地址属于你，`settleRemittance` 会跳过你，
你的出块资格也永远发不出来）：

```bash
cast send $STAKING "setLayerAddresses(bytes32,address,address)" \
  $NODE_ID <你的层内出块地址> <你在层内领池子的地址> \
  --rpc-url $BSC --account my-validator

cast call $STAKING "proposerAddressOf(address)(address)" $ME --rpc-url $BSC
cast call $STAKING "qualifyStreak(address)(uint16)"      $ME --rpc-url $BSC   # 满 30 即可获资格
cast call $STAKING "proposerRights(address)(bool)"       $ME --rpc-url $BSC
```

**每个纪元结束后（T + 2h 之前）转基金会那一半：**

```bash
# 1) 算你自己这个纪元出的块收了多少 gas（和见证人算 proposerIncomeRoot 用的是同一套代码）
bac-node gas-income --epoch $EPOCH_N --proposer <你的层内出块地址>

# 2) 转 50%（合约不校验金额，校验在 BSC 侧的累计比较里）
cast send $SPLITTER "remitValidator(uint64)" $EPOCH_N \
  --value <上一步金额的 50%> --rpc-url $L2 --account my-layer-proposer

# 3) 随时自查欠款状态
cast call $STAKING "remitStatus(address)(uint256,uint256,uint256,bool)" $ME --rpc-url $BSC
#   → (cumOwed, cumRemitted, arrears, shortfall)
```

**短缺了会发生什么（精确、可自查）：**

```
shortfall  ⇔  cumRemitted × 10000 < cumOwed × 9950   并且   cumOwed − cumRemitted > 0.05 BAC
成立时：  rewardOf(epoch, 你) == 0，金额转入 withheldOf(你)      事件 RewardWithheld
          proposerRights(你) == false                            事件 ProposerRightsRevoked
不会发生：质押不动、本金不罚没、解押冷却不变、退出不受影响（v1 无罚没）
恢复：    补齐欠款让 arrears == 0 → claimWithheld(to) 领回被扣的奖励
          → 重新攒满 30 个连续达标纪元才会再次 proposerRights == true
```

**最后一条边界（必须写进网站的见证人页）：`proposerRights` 只是「资格」，不是「共识权」。**
把一个地址真正加进或踢出 QBFT 验证者集，仍然要跑一次人工 `qbft_proposeValidatorVote`（§6.1）并在网站公告。
合约管钱，不管共识 —— 任何把「撤销出块资格」说成「链上自动把它踢出共识」的说法都是假的。

#### 7.6.4 告警（写进 §5.4 的监控清单）

| 条件 | 级别 | 动作 |
|---|---|---|
| 某个纪元 `差额 / 已收 > 1%` 且已过 `T + 2h` | 警告 | 检查归集脚本与官方 EOA 余额（留底是不是用完了） |
| 连续 2 个纪元差额不为 0 | 严重 | 人工介入并在网站挂公告，说明原因与补救时间 |
| `FeeSplitter` 的 `carryPool` 连续 7 个纪元只增不减 | 提示 | 说明没有任何见证人在领池子（多半是见证人数为 0），照实显示在网站上 |
| `setEpochWeights(N)` 在 `finalize(N)` 之后 6 小时仍未提交 | 警告 | 中继镜像作业卡住，验证者领不到池子 |
| 任一 `proposerRights` 从 true 变 false | 提示 | 网站自动公告，并附 `RemittanceShortfall` 的三个数字 |

---

## 8. bootnode / enode

- v1 **不跑独立 bootnode**：官方出块节点自己就是唯一的 bootnode，enode 公布在 `/api/health` 与网站上。
- 官方节点**保持 `--discovery-enabled=true`**（关掉等于与「人类见证人自由同步」互斥，需要人工 `admin_addPeer`，是我们不做的运维负担）。`--max-peers=50`。
- 见证人节点用 `--bootnodes=<OFFICIAL_ENODE>` 直连；见证人之间互相发现后也会形成网状，官方节点挂掉时它们之间仍能同步历史（这是「历史不只存在我们服务器上」的具体机制）。
- **enode 的身份来自 `--node-private-key-file` 指向的那个 `key`**（Besu 默认放在 `<data-path>/key`，我们显式放到 `secrets/besu/key` 并只读挂载）。换机迁移时一并带走，enode 才不变。
- **Besu 特有、Clique 下不存在的一条：这把 key 同时是 QBFT validator 的身份。** 换 key = 换 enode **且** 换 validator 地址，后者需要走 §6.1 的投票流程，并且要更新 §4.1 的 `everValidator` 表。**「只想换 enode」这件事在本链上做不到**，别把它当成一个轻量操作。

---

## 9. 端口清单

| 端口 | 协议 | 对外 | 用途 | ufw |
|---|---|---|---|---|
| 22 | tcp | 是 | SSH（fail2ban 在跑） | 已开 |
| 80 | tcp | 是 | Caddy（ACME + 跳转 443） | 决策 #8 授权，需执行 |
| 443 | tcp | 是 | Caddy（`/rpc` `/api` `/health`） | 决策 #8 授权，需执行 |
| 30303 | tcp + udp | 是 | 层内 p2p（外部见证人节点） | 决策 #8 授权，需执行 |
| 8545 | tcp | **否** | Besu HTTP RPC，只在 compose 内网 | 不开 |
| 8546 | tcp | **否** | Besu WebSocket，只在 compose 内网（索引器订阅新块） | 不开 |
| 9545 | tcp | **否** | Besu Prometheus 指标，只在 compose 内网（机房面板） | 不开 |
| 8551 | tcp | **否** | Engine API，用 `--engine-rpc-enabled=false` 关掉（本链不是 PoS） | 不开 |
| 8080 | tcp | **否** | indexer，只在 compose 内网 | 不开 |

**决策 #8 授权的端口集合没有变**（80/443/30303）。8546 和 9545 是新增的**内网**端口，`expose` 而非 `ports`，不需要新的授权，也**不许**改成 `ports:`。

---

## 10. 失败与恢复（链这一侧）

| 场景 | 动作 |
|---|---|
| 出块节点崩溃 | `docker compose restart besu`。**QBFT 不需要共识恢复流程**（单 validator，追上即继续出块）。**停机长度没有上限约束**：`postAnchor` 的第 5 条是 `l2Block >= 上一纪元`（不是 `>`），并且显式允许**层内零区块的空纪元锚点**，所以跨过一个甚至多个 UTC 日的停机都能逐个补发。旧写法（严格递增）会让一次超过 24 小时的停机把整条链的退出功能**永久报废**（attack-gate #4），必须有一条 e2e 用例覆盖：停链 30 小时 → 恢复 → 补发两个纪元（其中一个是空的） |
| 容器被 OOM-kill | 先看 `docker inspect besu \| jq '.[0].State.OOMKilled'`。是 → 调 `BESU_OPTS` 的 `-Xmx` 与 `mem_limit`（D0-5 的定值不对），不是 → 看 log4j 输出。**注意 RocksDB 被 SIGKILL 打断后可能需要一次 WAL 恢复**，启动会变慢，不要在这时候反复重启 |
| 整机换机 | 新机放好 `config/genesis.json` + `secrets/besu/key` → 恢复最近冷备的 data-path（或直接 `--sync-mode=FULL` 从其它见证人节点全量同步）→ 起 compose → 中继从 outbox 续传、索引器游标自动追。**没有 `geth init` 这一步**，Besu 直接读 `--genesis-file` |
| 创世文件与 DB 不一致 | Besu 拒绝启动并打印创世哈希不匹配。**这是好事，不要用删 DB 的方式绕过去**：先确认手上这份 `genesis.json` 和网站公布的哈希一致，再判断是文件错了还是 DB 错了 |
| node key 丢失 | **最严重的一类。** 它同时是 validator 身份和 enode 身份：链**彻底停止出块**，而新起一个 validator 需要改创世（= 另一条链）或者……没有办法，因为唯一有投票权的节点就是丢掉的那个。唯一出路是**走 90 天逃生**（BSC 侧按净入桥额分配，不需要任何层内数据）。**所以这把 key 必须离线双份**（§5.5） |
| node key 泄露 | veto 全部后续纪元 → 用现任 validator（如果还在我们手上）`qbft_proposeValidatorVote` 投入新 validator、投出旧的 → 见证人的 `l2BlockHash` 异议会让分叉在 BSC 上公开可见 → 必要时直接走逃生。**注意：泄露方和我们持有同一把 key，谁先投票谁说了算**，所以这条路径只在「我们先发现」时有效，否则直接逃生 |
| 数据全丢且无见证人节点 | 唯一真相是 BSC 上最后一个 FINAL 锚点里的 `l2BlockHash` 与 `exitRoot`。**v1 只有一份手动重建流程文档，没有自动机制，这一点必须写明。** 若 90 天内无法恢复，`BacBridge` 自动进入逃生（按 BSC 侧净入桥额分配，不需要任何层内数据） |
| Besu 镜像被上游删除 | 我们已钉死 tag 并保留本地镜像 tar（`docker save`）。**相比 Clique 时代这一条的风险大幅下降**：Besu 24.12.2 是一个在维护的版本，我们不再被钉死在一个 EOL 客户端上 —— 但升级仍然要先在一次性容器里用同一份 `genesis.json` 验一遍 |
| 磁盘告急（trie log 无界增长） | 停节点 → `besu storage x-trie-log prune` → 起节点，和冷备窗口合并做（D0-9、§4.4） |
| sslip.io 签不下证书 | 网站左半边（BSC，Multicall3 直读）照常；右半边显示 `读取失败 · 重试中`。备选：Cloudflare Tunnel |

---

## 11. 为什么不是 geth（不许重开的一页）

`docs/research/10-consensus-client.md` 的实测表，2026-09-22，全部在目标服务器 `95.179.183.132` 上跑的一次性容器：

| 客户端 | 共识 | 结果 | 内存 | CPU(空转) |
|---|---|---|---|---|
| geth v1.16.1 | Clique | **拒绝启动**：`Geth only supports PoS networks. Please transition legacy networks using Geth v1.13.x` | — | — |
| geth v1.15.11 | Clique | **拒绝启动**，同上；另外创世必须带 `blobSchedule` 才能 `init` | — | — |
| geth v1.14.13 | Clique | **拒绝启动**：`only PoS networks are supported` | — | — |
| geth v1.13.15 | Clique + `cancunTime:0` | **panic**：`clique.encodeSigHeader` 崩在 cancun 的 header 字段上 | — | — |
| geth v1.13.15 | Clique + `shanghaiTime:0`（无 cancun） | **可出块**：16 s 出 8 块（period=2） | 282 MiB | 0.8% |
| **Hyperledger Besu 24.12.2** | **QBFT + `cancunTime:0`** | **可出块**：45 s 出 21 块（period=2） | **309 MiB** | **7.4%** |

**结论，按重要性：**

1. **geth 的 Clique 是死路。** v1.14 起彻底移除，唯一能跑的 v1.13.15 已停止维护，不会再有安全补丁。一条要请外人跑节点、30303 对公网开着的链，不能建在一个 EOL 客户端上。
2. **Clique 拿不到 cancun。** v1.13.15 一开 `cancunTime` 就 panic，只能停在 shanghai，层内合约必须 `evm_version = "shanghai"`（放弃 MCOPY/TSTORE），和 BSC 侧的 solc 0.8.26 默认目标分叉，两套工具链两套产物。Besu 的 QBFT 在 cancun 下正常出块，`00` §0.1 G5 这才真的成立。
3. **QBFT 是即时最终性，Clique 是概率性。** 对桥来说这是结构性的差别：Clique 下层内可能重组，中继必须等确认数并处理孤块；QBFT 下一个块被 commit 就不会回滚，层侧的重组处理整段删除（§6.2，BSC 侧一行不动）。
4. **QBFT 原生支持验证者集治理**（§6.1）且有 **validator-contract 模式**（§6.3），正好对上「人类在 BSC 质押 BAC → 成为验证者」的设计终点。Clique 的 `clique_propose` 只有投票，没有合约模式。
5. **代价只有 CPU 和内存，而且买得起**：JVM 空转 CPU 7.4%（geth 0.8%），内存 309 MiB（geth 282 MiB）。3 vCPU / 7.7 GiB 的机器完全吃得下（D0-5 定 `-Xmx2g` / `mem_limit: 3g`，6 倍余量）。

**因此「要不要用 geth」这个问题已经关闭。** 重开它需要的证据是：一个在维护的 geth 版本重新支持了 PoA 且能开 cancun —— 在那之前，任何「geth 更熟悉 / 更轻 / 更主流」的理由都不足以推翻上表。

---

## [待定]

1. **`chainId = 56777` 的占用核对**（D0-2）。必须在生成创世文件之前完成；被占则 56778。
2. ~~**geth 镜像 tag**~~ —— **已结（D0-1 / 决策 #12）**：换成 `hyperledger/besu:24.12.2`，实测 QBFT + cancun 出块，见 §11。
3. ~~**`--gcmode=archive` 还是 `full`**~~ —— **已结**：对应到 Besu 是 `--data-storage-format=BONSAI`（§4.4）。Besu 24.12 的 Bonsai 同样没有 archive 模式，所以结论不变：全量历史由索引器自己承担（它要的是 receipts/logs，不是 state），`eth_call` 只承诺最近 512 个区块。
4. **创世时间戳**：建议取发射当天的 UTC 00:00，使层内纪元与 BSC 侧的 UTC 纪元对齐。
5. **`OPERATOR_FLOAT = 1,000 BAC` 是否够**：1,000 BAC 在 1 gwei 下够约 4,760 万笔简单交易，中继每天约 100–500 笔，够用很多年；但如果 base fee 因刷链长期高位，需要补充 —— 补充的唯一合法途径是运营方在 BSC 再锁等额 BAC 并走正常的 `lock` 流程。
6. **异机备份的目标**（对象存储账号或第二台机器）。
7. **是否公布第二个只读 RPC 端点**（例如某个见证人自愿提供）—— 能降低 `sslip.io` 证书这个单点，但需要那个人同意并承担流量。
8. **小费归属的实测**（D0-6）。它决定 §4.1 对账公式减哪几个地址；未实测前按「减 `everValidator` 全集」这个 fail-closed 口径写代码。
9. **JVM 堆与容器内存的定值**（D0-5）。本文写的 `-Xmx2g` / `mem_limit: 3g` 是基于 309 MiB 空转实测的估计，要在真实负载下量一次。
10. **Bonsai 日增的实测数字**（§4.4）。上线后第一个 24 小时 `du -sh` 一次，写回磁盘预算表。
11. **v1.5 扩容到 4 个 validator 的时间点与人选**（§6.4）。触发条件是见证人的数量与在线质量，不是日历；**并且 `00-DESIGN-SPEC.md` §2 里「扩到 3 个签名者」那一格要改成 4 个**（QBFT 的 n=3 容错仍然是 0）。
