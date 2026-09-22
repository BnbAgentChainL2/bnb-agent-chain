# `@bac/node-cli` —— BNB Agent Chain 见证人节点程序

给**只会 Docker 的人**用的一套命令：把只读全节点跑起来、每个纪元诚实见证、在 BSC 上领到该领的钱。

先把三件事说清楚，免得你花了机器钱才发现不是想要的东西：

1. **你跑的不是出块节点。** v1 出块由一个官方 QBFT validator 做，见证人跑的是**只读全节点**，
   不出块、不投票、不影响共识（`docs/02-CHAIN-SPEC.md` §0.5）。
2. **奖励不是强制分账。** 它来自运营方往 `ValidatorStaking.fundRewards()` 里注入的 BNB。
   注入多少、什么时候注入，合约不强制。**税收是 0 的时候奖励就是 0，而你还要自己出 gas。不承诺任何收益。**
3. **你可以从官方 RPC 抄数据而不真跑节点，合约分不出来。** 我们知道这一点，也照实说。
   commit-reveal 只能保证「你在官方发锚点之前就写下了答案」。但抄来的答案在官方出错的那天一文不值 ——
   见证人的全部价值就在那一天。

---

## 0. 你需要准备什么

| 项 | 要求 |
|---|---|
| 机器 | 2 vCPU / **4 GB 内存**（Besu 是 JVM，`-Xmx2g` 是下限）/ 60 GB 可用磁盘，Docker 已装 |
| 端口 | `30303/tcp` **和** `30303/udp` 能进能出（udp 是节点发现，少了它 peers 会是 0） |
| 时间 | 机器必须开 NTP。承诺截止时间是按**你本机的钟**算的 |
| BSC 钱包 | `≥ 2,000,000 BAC`（`MIN_STAKE`）+ 一点 BNB 付 gas |
| Node | 22+（只有 `ethers@6.13.4` 一个依赖；也可以只用 compose 里的 `attester` 容器） |

```bash
node -v        # v22 或更高
docker compose version
id -u; id -g   # 记住这两个数，下面要用（不要用 root）
```

---

## 1. 安装

npm 的发布方式还没定（`docs/03-INTERFACES.md` §[待定] 1），现在以本地包的形式交付：

```bash
cd node-cli
npm install                     # 只装 ethers@6.13.4
node src/cli.mjs --help
# 想有 `bac-node` 这个命令：npm link（可选）
alias bac-node="node $(pwd)/src/cli.mjs"
```

---

## 2. `bac-node init` —— 生成密钥、拉创世、写 compose

```bash
mkdir -p ~/bac-validator && cd ~/bac-validator
bac-node init --node-id my-node-01 --p2p-host <你的公网 IP> --payout 0x<你的 BSC 收款地址>
```

它会做这些事，一件不多：

```
  [ok]   已生成节点密钥：/home/me/bac-validator/secrets/key（0600）
  [warn] 立刻离线备份这个文件两份。丢了它 = 换 enode；在官方节点上丢了它 = 整条链停止出块
  [ok]   已写入 /home/me/bac-validator/config/genesis.json
         sha256 3f2a…（和网站上公布的那个逐字比一遍）
  [ok]   官方 enode：enode://<128 hex>@95.179.183.132:30303

你的 enode（注册节点时要填的就是这一行）：
  enode://<你的 128 hex>@<你的公网 IP>:30303

写好的文件：
  ~/bac-validator/bac-node.json
  ~/bac-validator/compose.yml
  ~/bac-validator/config/genesis.json
  ~/bac-validator/secrets/key（0600，绝不外传）
```

**输出里出现的是 enode，不是私钥。** 本程序从不打印、不落盘、不上传任何私钥。

创世哈希有三个出处，**三处必须逐字相同**，对不上就别启动、直接来问：

- `https://95-179-183-132.sslip.io/api/genesis` 的响应头 `X-Genesis-Hash`
- `https://95-179-183-132.sslip.io/api/health` 的 `layer.genesisHash`
- 仓库里的 `chain/GENESIS.md` 与网站见证人页

把你的 BSC 私钥填进 `validator.env`（init 已经建好，`0600`）：

```bash
echo 'VALIDATOR_PRIVATE_KEY=0x你的私钥' > validator.env && chmod 600 validator.env
```

---

## 3. `bac-node start` —— 起节点（创世哈希是硬门槛）

```bash
bac-node start
```

```
  [ok]   genesis.json sha256 3f2a… 与记录一致
  docker: Docker Compose version v2.29.0
  [ok]   容器已拉起，正在等节点回应 RPC …
  [ok]   创世哈希 0x9c1e… 与公布值一致
  [ok]   chainId 56777

起来了。接下来：
  bac-node status    看同步进度与本纪元的见证状态
  bac-node doctor    把常见故障查一遍
  docker compose logs -f besu    看它追块
```

**核对失败会长这样，而且没有跳过开关：**

```
  [FAIL] 本地节点的创世哈希 0x77aa… 与公布的 0x9c1e… 不一致 —— 你连的不是这条链，已停止。
         创世哈希的核对出处（三处必须逐字相同）：
           - https://95-179-183-132.sslip.io/api/genesis  的响应头 X-Genesis-Hash
           - https://95-179-183-132.sslip.io/api/health   的 layer.genesisHash
           - 仓库里的 chain/GENESIS.md 与网站见证人页（三处必须是同一个值）
  [warn] 已经把容器停回去，以免你在错的链上继续同步和见证
```

一共查两道：**启动前**比对 `config/genesis.json` 的 sha256（防文件被换），**启动后**比对节点自己报的 0 号区块哈希（权威）。
不肯自己从 `genesis.json` 算区块哈希，是因为 QBFT 的 `extraData` 是 RLP 结构、cancun 又加了 header 字段，
自己算错一次就会拒绝一个本来好好的节点。让节点算、我们比对，是唯一不会误伤的做法。

停：

```bash
bac-node stop     # docker compose stop，给 RocksDB 2 分钟干净关闭，别急着 Ctrl-C
```

---

## 4. `bac-node doctor` —— 一次把常见坑查完

**节点起来之后、质押之前先跑一次。** 每一条都对应一个我们真踩过或真推演过的故障：

```
bac-node doctor
```

```
  [ok]   配置校验：没有问题
  [ok]   docker compose 可用：Docker Compose version v2.29.0
  [ok]   besu 容器：状态 running
  [ok]   本地层内 RPC：head #1234567
  [ok]   链 ID：56777
  [ok]   创世哈希：0x9c1e…
  [FAIL] 对端数：0 个对端：你在自说自话，高度不会涨
         怎么办：bootnodes 填对了吗（/api/health 的 layer.enode）？30303 的 tcp 和 udp 都要能出去；
                 nat-method=NONE 时 p2pHost 要是你的公网 IP
  [warn] 同步进度：落后官方 300 个块
  [FAIL] 时钟偏移：本机时间与链上头部差 42 秒（头部时间戳 1790000000）
         怎么办：开 NTP（timedatectl set-ntp true）。钟不准会让你在承诺窗口边缘发出必然 revert 的交易
  [ok]   BSC RPC：可达
  [FAIL] data 目录属主：data 目录属于 root，但你不是 root
         怎么办：compose 里必须写 user: "<id -u>:<id -g>"；已经错了就 sudo chown -R $(id -u):$(id -g) ./data
  [ok]   节点密钥：在，且权限收紧
  [FAIL] 磁盘余量：只剩 6.2 GB
         怎么办：磁盘满会让 RocksDB 损坏。先清日志；trie log 涨疯了就停节点跑 besu storage x-trie-log prune

3 项失败、1 条提醒 —— 失败项修完再谈见证
```

退出码：有任何 `[FAIL]` 就是 1，全过是 0（可以直接塞进监控）。

查的项目：配置校验 · docker 可用 · 容器状态 · 层内 RPC · chainId · **创世哈希** · 对端数 ·
同步进度 · **时钟偏移** · BSC RPC（两个）· **data 目录属主** · 节点密钥与权限 · **磁盘余量** · 质押与节点注册。

---

## 5. 质押并注册节点（BSC 侧）

这几条**默认只打印将要发的交易**，加 `--yes` 才真发。

```bash
bac-node stake --amount 2000000          # 先看一遍
bac-node stake --amount 2000000 --yes    # 确认无误再发（approve 用精确额度，不做无限授权）

bac-node register --node-id my-node-01 --payout 0x<收款地址> --yes
```

```
  你的 BAC 余额 5,000,000，要质押 2,000,000
  将要发的交易：
    from     0x…
    to       0x…（ValidatorStaking）
    gasLimit 63000   gasPrice 50000000 wei   nonce 7
  [warn] 以上都是 --dry-run。确认无误后加 --yes 真发
```

几条合约规则，程序会提前拦住你，省得白烧 gas：

- **每个节点都要一份独立达标的质押**：注册第 N 个节点需要 `N × 2,000,000 BAC`。
- **权重按地址算，不按节点算**：同一个地址注册多个节点，见证权重和奖励**不会**变成多份。
- **减仓前要先退节点**：`requestUnstake` 会检查 `staked − amount >= MIN_STAKE × 你的节点数`。

---

## 6. `bac-node attest` —— 每纪元的承诺与揭示

```bash
bac-node attest              # 常驻（compose 里的 attester 服务跑的就是它）
bac-node attest --once       # 跑一趟就退出，适合 cron / systemd timer
bac-node attest --once --dry-run   # 只算不发，第一次用它看看算出来的根长什么样
```

cron（每 10 分钟一趟，足够覆盖 2 小时的承诺窗口和 24 小时的揭示窗口）：

```cron
*/10 * * * * cd /home/me/bac-validator && /usr/bin/node /path/to/node-cli/src/cli.mjs attest --once >> attest.log 2>&1
```

systemd timer：

```ini
# /etc/systemd/system/bac-attest.service
[Service]
Type=oneshot
User=me
WorkingDirectory=/home/me/bac-validator
EnvironmentFile=/home/me/bac-validator/validator.env
ExecStart=/usr/bin/node /path/to/node-cli/src/cli.mjs attest --once

# /etc/systemd/system/bac-attest.timer
[Timer]
OnCalendar=*:0/10
Persistent=true
[Install]
WantedBy=timers.target
```

它按纪元推进，每一步都打印在做什么：

```
  见证地址 0x…
  纪元 20718 → commit：可以承诺纪元 20718
    区间 (1234400, 1234501]，退出 7 笔
    exitRoot 0xab…
    l2Block  1234501  hash 0x9c…
    commitment 0x4d…
  [ok]   已广播 0x…
  [ok]   已上链，区块 45678901
  [ok]   纪元 20718 已承诺。截止时间是 2026-09-23 10:00:00 (北京时间)，你赶在了前面
```

**时序（合约写死，中继压不了它）：**

```
纪元 N 结束（UTC 00:00）
  └─ 0 ~ 2 小时：commitAttestation(N, commitment)      ← 截止 (N+1)*86400 + COMMIT_WINDOW，严格小于
  └─ 2 小时之后：官方才被允许 postAnchor(N)
  └─ 锚点 POSTED 起 24 小时内：revealAttestation(N, …)
  └─ finalize(N) → settleEpochRewards(N) → claimReward(N, 你)
```

**三条不许绕开的纪律：**

1. **本地头部时间戳没越过纪元边界，就不承诺。** `l2Block(N)` 的定义是「时间戳 `< (N+1)*86400` 的最大区块号」，
   节点还没追到边界时这个值随时会变，承诺一个会变的值等于自己制造异议。程序这时打印 `wait_sync` 并等着。
2. **链上有承诺但本地 `salt` 丢了或对不上 → 停下来告警，不揭示。** 揭示与承诺不符会记一次 `strike`。
   最常见的原因是**同一把私钥在两台机器上各跑了一份 attest** —— 先停掉一台。
3. **就算你算出来的根和官方不一样，也照样揭示你自己看到的那一个。** QBFT 下层内不会重组，
   所以不一致不是「等等就好」，是真分歧，该报就报：

```
  [FAIL]   与链上锚点不一致：照实揭示你自己算出来的那一个。
           链上 exitRoot 0xee… l2Block 1234501
           本地 exitRoot 0xab… l2Block 1234501
```

`salt` 存在 `state/epoch-<N>.json`（`0600`）。**它在揭示之前是秘密**：
程序会打印 `commitment`（链上公开值），但**永远不打印 `salt`**。备份这个目录，丢了就揭示不了那一纪元。

---

## 7. `bac-node verify` —— 任何人都能跑的独立核验

不需要质押、不发交易、不需要私钥。只用你自己的全节点 + 一次 BSC `eth_call`：

```bash
bac-node verify --epoch 20716
```

```
epoch 20716
  local   exitRoot 0xab…  l2Block 1234501  l2BlockHash 0x9c…
  onchain exitRoot 0xab…  l2Block 1234501  l2BlockHash 0x9c…
  state   FINAL   exitCount 链上 7 / 本地 7
  MATCH
```

`MISMATCH` 时退出码是 1，锚点还没发时是 2。`--json` 输出机器可读的版本。

---

## 8. `bac-node status` —— 一屏看完

```bash
bac-node status
```

```
本地节点
  [ok]   高度 #1234567，块时间 2026-09-23 08:00:00 (北京时间)（落后本机时钟 1 秒）
  [ok]   对端 5 个
  [ok]   官方高度 #1234570，你落后 3 个块（约 9 秒）

见证身份
  地址 0x…
  质押 2,000,000 BAC
  [ok]   节点 my-node-01：active，strikes 0

见证进度
  当前纪元 20718，14 小时 12 分 后结束
  纪元 20717：锚点 FINAL · claimable — 可以 settleEpochRewards + claimReward
  纪元 20718：锚点 NONE · wait_epoch_end — 纪元 20718 还没结束，等到边界再算

收益
    纪元 20717：待领 0.0031 BNB
  [ok]   最近 10 个纪元待领合计 0.0031 BNB（1 个纪元）
    用 bac-node claim --epoch <N> 领。30 天不领会被 sweepExpired 退回奖池
```

---

## 9. `bac-node claim` —— 领奖

```bash
bac-node claim --epoch 20716              # 先看一遍
bac-node claim --epoch 20716 --dry-run    # 同上
bac-node claim --epoch 20716              # 真发（claim 不需要 --yes，它只是把你的钱取走）
```

`settleEpochRewards` **必须按序**（`epoch == lastRewardEpoch + 1`），所以程序会先把落下的纪元逐个补齐再领。
补得太多（默认超过 30 个）会停下来让你确认 —— 那通常意味着很久没人结算过，值得先问一句。

**领奖有 30 天窗口**：过期的 pot 会被任何人 `sweepExpired` 退回奖池。

---

## 10. 退出

```bash
bac-node retire --node-id my-node-01 --yes      # 减仓前先退节点
bac-node unstake --amount 2000000 --yes         # 冷却 7 天
# 7 天后
bac-node withdraw --to 0x<收款地址> --yes
```

**v1 没有罚没。** 报错根只是那一纪元拿不到奖励；`removeValidator` 经 48 小时时锁也只取消领奖资格，**本金照样取回**。

---

## 11. 常见故障速查

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| `peers` 一直是 0 | `30303/udp` 没开，或 `p2pHost` 不是公网 IP | 两个协议都要开；`nat-method=NONE` 时必须填对公网 IP |
| Besu 启动就退，日志里是创世哈希不匹配 | `genesis.json` 和 DB 记录的不是同一条链 | **不要删 DB 绕过去**。先确认手上的 `genesis.json` 与公布的哈希一致 |
| `data` 目录是 root 的，删不掉也备份不了 | compose 少了 `user:` | `sudo chown -R $(id -u):$(id -g) ./data`，并确认 compose 里有 `user:` |
| 容器被 OOM-kill | `-Xmx` 和 `mem_limit` 不匹配 | `docker inspect besu \| jq '.[0].State.OOMKilled'`；调 `BESU_OPTS` 与 `mem_limit` |
| 磁盘一直涨 | Bonsai 的 trie log 没修剪 | 确认 `--bonsai-limit-trie-logs-enabled=true`；已经涨起来了就停节点 `besu storage x-trie-log prune` |
| `commit` 交易 revert | 错过了 2 小时承诺窗口，或者机器时钟偏了 | `bac-node doctor` 看时钟；错过就是错过，下一纪元再来 |
| 揭示后出现 `strike` | 同一把私钥在两台机器上各跑了一份 attest | 停掉一台，并确认 `state/` 目录没有被两边同时写 |
| `salt` 丢了 | `state/` 没备份 | 那一纪元拿不到奖励。**不要猜一个 salt 去试** —— 揭示不符会吃 strike |

---

## 12. 安全与隐私

- **私钥只从环境变量按名字读**（`VALIDATOR_PRIVATE_KEY`），程序从不打印、不落盘、不上传。
  错误输出还会把任何 32 字节十六进制串遮成 `0x<已隐藏>`，防止误贴。
- **节点密钥 `secrets/key` 同时是 enode 身份**，`0600`，换机迁移要带走。它不是 BSC 私钥，两者不要混。
- **`state/epoch-*.json` 里有 `salt`**，揭示之前是秘密，`0600`，要备份。
- `compose.yml` 里**没有任何密钥**，只有 `env_file: [ ./validator.env ]`。

---

## 13. 开发与测试

```bash
npm test          # node --test test/
```

全部测试**离线可跑**：假链、假 BSC、假 docker、内存文件系统。不需要服务器、不需要 docker、不需要有钱的私钥。

```
test/attest-state.test.mjs   见证时序状态机（承诺/揭示窗口的每一个边界）
test/doctor.test.mjs         doctor 的每一条检查（伪造坏环境）
test/config.test.mjs         配置校验 + compose 生成
test/exit-tree.test.mjs      exitRoot 的构造（叶子里没有 epoch、排序对法、奇数上浮）
test/anchor-math.test.mjs    l2Block(epoch) 的规范定义、空纪元、二分
test/genesis-gate.test.mjs   创世门禁 + start 的拒绝路径
test/attest-flow.test.mjs    commit/reveal 端到端（含「salt 不进日志」）
test/cli-docker.test.mjs     参数解析、docker 命令拼装、init 产物
```

**`l2Block(epoch)` 与 `exitRoot` 的定义在中继、`@bac/agent-sdk`、本包三处必须字节级一致**
（`docs/03-INTERFACES.md` §1.3）。本包把它们放在 `src/anchor-math.mjs` 与 `src/exit-tree.mjs`，
并从 `src/index.mjs` 导出，另外两处应当直接复用或对拍。

---

## 14. 命令一览

| 命令 | 做什么 |
|---|---|
| `bac-node init` | 生成节点密钥、拉创世并核对哈希、写 `compose.yml`、打印你的 enode |
| `bac-node start` | `docker compose up -d` + 启动前后各核对一次创世哈希 |
| `bac-node stop` | `docker compose stop`（给 RocksDB 2 分钟） |
| `bac-node status` | 高度 / 对端 / 与官方的差 / 本纪元见证状态 / 收益 |
| `bac-node doctor` | 常见故障一次查完，有 `[FAIL]` 退出码 1 |
| `bac-node attest [--once]` | 每纪元 commit → 等锚点 → reveal |
| `bac-node verify --epoch N` | 独立核验，`MATCH` / `MISMATCH` |
| `bac-node stake --amount N [--yes]` | approve + stake |
| `bac-node register [--yes]` | `registerNode` |
| `bac-node claim --epoch N` | `settleEpochRewards`（按序补齐）+ `claimReward` |
| `bac-node unstake --amount N [--yes]` | `requestUnstake`（冷却 7 天） |
| `bac-node withdraw [--yes]` | `withdrawUnstaked` |
| `bac-node retire [--yes]` | `retireNode` |

---

## 15. 已知偏差与待定（读过再用）

本包按 `docs/01-CONTRACT-SPEC.md` / `02-CHAIN-SPEC.md` / `03-INTERFACES.md` 实现。
下面是**文档之间自相矛盾、或者还没写完**的地方，以及本包的取舍 —— 不是 bug，是需要你知道的选择。

| # | 情况 | 本包怎么做 |
|---|---|---|
| 1 | `01 §6.1` 的 `Anchor` 结构注释里，叶子布局**还带着 `epoch` 字段**；但 `01 §4.1`、`01 §8.1`、`03 §1.3` 三处明确说叶子里**没有 `epoch`** | 按**没有 epoch** 实现（三处正文一致，§6.1 那一行是没改到的旧注释）。被 veto 的纪元重报时叶子一个字节都不变，正是靠这一条 |
| 2 | `02 §7.4` 写 `claimReward(uint64,bytes32)`（按 nodeIdHash 领），`01 §7` 写 `claimReward(uint64 epoch, address validator)`（按地址领），且 `01 §7` 明确「奖励按地址算不按节点算」 | 按 **`01` 的 `(uint64, address)`** 实现（任务规定合约口径以 `01` 为准）。`02 §7.4` 那条 `cast` 示例需要跟着改 |
| 3 | 决策 #17（gas 费按出块者分账、层内新增 `FeeSplitter @ 0x…0104`、锚点里新增逐 proposer 的 gas 收入字段）已拍板，但 `01 §11` / `03 §3.7` 还没写出来 | 本包**一个字节都没实现它**。`getAnchor` 的 ABI 就是现在 `01 §6.1` 的 12 个字段；等锚点结构真的加字段，`src/abi.mjs`、`verify`、`attest` 要一起改 |
| 4 | 创世哈希无法从 `genesis.json` 离线算出来（QBFT 的 `extraData` 是 RLP 结构，cancun 又加了 header 字段） | 两层核对：启动前比 `genesis.json` 的 **sha256**（防文件被换），启动后比**节点自己报的 0 号区块哈希**（权威）。不自己算，因为算错一次就会拒绝一个本来好好的节点 |
| 5 | `@bac/node-cli` 的发布方式未定（`03 §[待定] 1`） | 以本地包交付。生成的 `compose.yml` 里 `attester` 服务把 `./node-cli` 只读挂进容器（**要带上 `node_modules`**），而不是 `npx -y @bac/node-cli` |
| 6 | D0-10「Besu 的 BFT `ACCEPTABLE_CLOCK_DRIFT` 实测值」还没测 | `doctor` 暂用 **偏移 ≥ 5 秒提醒、≥ 30 秒失败**。实测出来以后把 `src/constants.mjs` 的两个常量收紧 |
| 7 | `l2Block(epoch)` 的第一个纪元：上一纪元早于创世时，区间下界没有规定 | 取 `from = 0`（**含创世块**）。中继与 SDK 必须用同一条规则，否则第一个锚点就会对不上 |
| 8 | 见证人如何拿到 `exitCount` 超大纪元的全部日志（`03 §[待定] 5` 的分页阈值未定） | 按 `--rpc-max-logs-range=5000` 分块拉，不依赖任何分页 API |

**还没解决、需要决策的：**

- **`bac-node claim` 的 `payout` 语义**：`01 §7` 里 `claimReward(epoch, validator)` 没有收款地址参数，
  钱是打到 `registerNode` 时登记的 `payout`，还是打到 `validator` 本人？本包按「打到合约自己决定的地方」描述，
  不替它承诺。合约定稿后要把 README 里那句话改成确定的说法。
- **多节点单地址的展示**：`/api/validators` 的 `lifetimeClaimed` 是按节点还是按地址？
  本包按接口给的每一项分别打印，没有合计。
