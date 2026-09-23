# chain/OPERATIONS.md · 正式链运维手册

对象是 `/opt/bac` 上那一套 `chain/docker-compose.yml`（besu + relayer + indexer + **watchdog** + caddy）。
规格在 `../docs/02-CHAIN-SPEC.md`，实测数据在 `../docs/research/10-consensus-client.md` 与
`../docs/research/11-staging-overnight.md`。**本文与规格冲突时，以本文里标了「实测」的那几条为准，并立刻回改规格。**

所有阈值都来自 2026-09-22 夜间那 11.36 小时的演练链实测，不是估算：
**3.000 秒/块、data 目录 3.8 GB/年、RSS 318 → 468 MB 且增速衰减、CPU 中位 4.5%。**

> 本文只写变量名，不写任何私钥。`secrets/` 下的文件权限是 `600`，属主是 ops。

---

## 0. 上线前的一次性前置

```bash
# 目录与属主（容器里的 user: 只让进程以 ops 跑，不会替你修已经是 root 的目录）
sudo mkdir -p /opt/bac/{config,secrets/besu,data/{besu,relayer,indexer,watchdog,caddy,caddy-config},backup,scripts}
sudo chown -R ops:ops /opt/bac
chmod 700 /opt/bac/secrets /opt/bac/secrets/besu

# .env（compose 用 ${VAR:?} 强制要求，缺了直接起不来，不会悄悄用默认值）
cat > /opt/bac/.env <<'ENV'
BAC_UID=1001
BAC_GID=1001
BAC_PUBLIC_IP=95.179.183.132
BAC_SITE_HOST=95-179-183-132.sslip.io
BAC_BRIDGE=0x...
AGENT_REGISTRY=0x...
CHAIN_ANCHOR=0x...
BAC_TOKEN=0x...
LAYER_SIGNER_ADDRESS=0x...
# 看门狗：必须显式写 true 或 false，compose 用 ${WATCHDOG_ARMED:?} 强制要求。
# true = 它真的会发 pause() 交易；false = 演练，只告警不上链。没有默认值是故意的（见 §9）。
WATCHDOG_ARMED=true
# 可选：告警外发。留空 = 告警只进容器日志与非零退出码。
WATCHDOG_WEBHOOK_URL=
ENV
id -u ops; id -g ops          # 必须与 BAC_UID / BAC_GID 逐字相同

# 时钟。层内纪元边界由本机时间决定，漂了就会把一笔退出算进错的纪元
sudo apt-get install -y chrony && systemctl enable --now chrony && chronyc tracking

# 防火墙（决策 #8 的授权范围）
sudo ufw allow 80,443/tcp && sudo ufw allow 30303/tcp && sudo ufw allow 30303/udp && sudo ufw status numbered

# 创世与密钥就位
cp chain/build/genesis.json /opt/bac/config/genesis.json
cp chain/config/log4j2.xml  /opt/bac/config/log4j2.xml
cp chain/build/networkFiles/keys/0x<VALIDATOR>/key /opt/bac/secrets/besu/key
chmod 600 /opt/bac/secrets/besu/key
```

**先验创世，再起链。** 链一出块，创世就不能改了：

```bash
bash chain/verify-genesis.sh --boot --genesis /opt/bac/config/genesis.json
# 必须打印 GENESIS VERIFY PASSED，并记下 GENESIS HASH
```

`GENESIS HASH` 写进 `chain/GENESIS.md` 和网站。它是这条链的身份。

---

## 1. 启动顺序（不许打乱）

顺序是有理由的：索引器要有链才能索引，中继要有 BSC 侧合约地址才能跑，Caddy 要有上游才能签证书。

| 步 | 命令 | 通过标准 |
|---|---|---|
| 1 | `docker compose up -d besu` | `docker compose ps` 显示 `healthy`；`cast block-number --rpc-url http://127.0.0.1:8545` 在 90 秒内 > 0 |
| 2 | 核对验证者集 | `cast rpc qbft_getValidatorsByBlockNumber '"latest"'` 返回**正好一个**地址，且等于 `LAYER_SIGNER_ADDRESS` |
| 3 | `docker compose up -d indexer` | `curl -s localhost:8080/health` 返回 200 |
| 4 | `docker compose up -d relayer` | 日志出现首个扫描区间；**BSC 侧合约必须已经部署，地址已写进 `.env`** |
| 5 | `docker compose up -d watchdog` | 日志里出现 `启动自检` 那一行，且**没有** `启动自检未通过`；`docker compose ps` 显示 Up。**桥一旦有钱，这一步就不是可选的**（§9） |
| 6 | `docker compose up -d caddy` | `curl -sI https://$BAC_SITE_HOST/health` 返回 200，证书有效 |
| 7 | `sudo systemctl enable --now bac` | 重启机器后自动拉起 |

Besu 的 8545 / 8546 / 9545 **只在 compose 内网**。对外只有 Caddy 的 80/443 和 p2p 的 30303。
`ADMIN` / `MINER` / `qbft_propose*` 这些写方法永远不进 `/rpc` 白名单。

systemd unit：

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

`TimeoutStopSec=180` 必须大于 compose 里的 `stop_grace_period: 2m`，否则 systemd 会在 RocksDB 关干净之前把它打死。

---

## 2. 健康检查

### 2.1 每天看一眼（30 秒）

```bash
cd /opt/bac
docker compose ps                                        # 五个都 Up，besu 和 indexer 是 healthy
docker compose logs --tail 5 watchdog                     # 看门狗没退出就说明它还在盯（退出码 3 = 已跳闸）
cast block-number --rpc-url http://127.0.0.1:8545        # 每 3 秒 +1
curl -s https://$BAC_SITE_HOST/api/health | head -40     # 层内高度、纪元、锚点、对账差额
du -sh data/besu data/indexer                            # 与下表对照
```

### 2.2 出块正常的定义

```bash
# 连续两次，间隔 30 秒，差值应当是 10 ± 1 块
cast block-number --rpc-url http://127.0.0.1:8545; sleep 30; cast block-number --rpc-url http://127.0.0.1:8545
# 出块者必须是验证者集里的那个地址
cast rpc eth_getBlockByNumber '"latest"' false --rpc-url http://127.0.0.1:8545 | grep -o '"miner":"[^"]*"'
# zeroBaseFee 仍然生效
cast rpc eth_getBlockByNumber '"latest"' false --rpc-url http://127.0.0.1:8545 | grep -o '"baseFeePerGas":"[^"]*"'
```

### 2.3 必须一直成立的三条

1. **验证者集不变。** `qbft_getValidatorsByBlockNumber("latest")` 与预期集合任何差异都是最高级别事件：出块权无声变化。
2. **每个 validator 的层内余额单调不减。** 官方节点地址承诺永不发交易；它一旦出账，`02 §4.1` 的对账恒等式就失效，那条「差额非零即告警」会变成永久误报，最后被人关掉 —— 而它是发现中继超发的唯一手段。
3. **对账差额恒为 0。**
   `diff = (bscTotalIssued − bscTotalExited) − (layerCirculating + balance(FeeSink) + balance(FeeSplitter) + Σ balance(everValidator))`

### 2.4 告警项（`scripts/alert.sh`，crontab 每 5 分钟）

出块延迟 > 30 s · 锚点超 `epochEnd + 2h` 未发 · 连续 3 纪元零见证 · 对账差额非零 ·
中继 BSC 余额 < 0.05 BNB 或层内余额 < 100 BAC · node key 文件哈希变更 ·
验证者集与预期不一致 · 任一 validator 余额减少 · JVM 堆使用率 > 85% 持续 10 分钟 ·
容器 OOM-kill 计数 > 0 · 层内 head 与 BSC head 时间戳差 > 120 秒 ·
`data/besu` 或 `index.db` 越过下面的阈值 · 层内出现 parentHash 断链 ·
**watchdog 容器不在 Up 状态**（它自己会喊，但它死了就没人喊了）。

**最后一条要单独说：QBFT 下断链不可能发生，所以一旦发生就不是重组，是事故**（数据库损坏、连错链、或者有人在跑第二条链）。
处理方式是**立刻告警并停止推进索引游标**，不是回滚。

---

## 3. 磁盘阈值（基线是实测的 3.8 GB/年）

实测基线：`data` 目录 11.36 小时从 75 MB 涨到 80 MB，负载是每 20 秒一笔交易。
折合 **约 0.44 MB/小时 ≈ 10.5 MB/天 ≈ 3.8 GB/年**。机器空闲 69 GB。

| 项 | 正常 | 注意 | 告警 | 紧急 |
|---|---|---|---|---|
| `data/besu` 日增 | ≤ 15 MB/天 | > 50 MB/天（基线 5 倍） | > 200 MB/天 | **> 500 MB/天且持续 6 小时 → 走 §4 的 gasLimit 流程** |
| `data/besu` 总量 | ≤ 4 GB/年 | 10 GB | **20 GB** | 30 GB |
| `data/indexer/index.db` | — | 4 GB | **6.4 GB** | 8 GB |
| 根分区剩余 | > 40 GB | 25 GB | **15 GB** | 8 GB |
| 容器日志合计 | ≤ 600 MB（50m × 3 × 4 个服务） | — | — | — |

按 3.8 GB/年算，20 GB 的告警线大约在**第 5 年**才会碰到。所以磁盘告警响了，含义几乎一定是
「有人在刷链」而不是「链自然长大了」—— 先看 §4，不要先扩容。

**注意 trie log 的监控口径已经改过（实测）**：`data/database/trielogs` 目录**不存在**。
Bonsai 的 trie log 与状态同写在主 RocksDB 里（实测是 `data/database/000004.log`）。
所以盯的是 `data/database` 的整体增长，不是某个子目录。

---

## 4. 状态膨胀应急：唯一真实的控制手段

`1 gwei × 20,000,000 gas × 28,800 块/天 = 576 BAC/天就能填满全链每一个块`。
所以「gas 要花真钱所以刷不动」是错的，文档和网站都不许这么写。真正的约束是磁盘，
真正的手段只有一个：**validator 下调 gasLimit**。

```bash
# 触发线：data/besu 日增 > 500 MB 且持续 6 小时
# 1) 热改，立即生效、不停机（MINER API 只在 compose 内网可达）
docker compose exec -T indexer node -e 'fetch("http://besu:8545",{method:"POST",
  headers:{"content-type":"application/json"},
  body:JSON.stringify({jsonrpc:"2.0",id:1,method:"miner_changeTargetGasLimit",params:[2000000]})})
  .then(r=>r.text()).then(console.log)'
#    EIP-1559 每块 ±1/1024，约 3,050 块 ≈ 2.5 小时收敛到 2,000,000

# 2) 持久化，否则下次重启悄悄涨回 20M
sed -i 's/--target-gas-limit=20000000/--target-gas-limit=2000000/' /opt/bac/docker-compose.yml

# 3) 恢复时把两步反过来做一遍，同样 2.5 小时收敛
```

**两步都要做**：热改止血，冷改持久化。
这是一个**单方面的全链吞吐开关**，动用时必须在 `/api/health` 的 `layer.gasLimit` 上立刻可见，并在网站挂公告说明原因与恢复条件。

---

## 5. 每周冷备（周日 04:00）

```
0 4 * * 0 /opt/bac/scripts/coldbackup.sh
```

```bash
#!/usr/bin/env bash
# /opt/bac/scripts/coldbackup.sh
set -euo pipefail
cd /opt/bac
D=$(date +%F)

# 1) 干净停机。compose stop 默认只给 10 秒，必须显式给够，让 RocksDB 关完
docker compose stop -t 150 besu

# 2) 冷备 data-path。绝不对运行中的 data-path 打 tar：
#    RocksDB 没有在线一致快照，正在写的 SST/WAL/MANIFEST 会让备份不是崩溃一致的，
#    恢复时 Besu 直接拒绝启动 —— 而你会在真正需要它的那天才发现
tar -C data -czf "backup/besu-$D.tgz" besu

# 3) 立刻起回来，并把停机时长记进日志
docker compose start besu

# 4) 索引器可以在线备份（SQLite 有一致快照）
sqlite3 data/indexer/index.db "VACUUM INTO 'backup/index-$D.db'"

# 5) 只保留最近 2 份
ls -1t backup/besu-*.tgz | tail -n +3 | xargs -r rm -f
ls -1t backup/index-*.db | tail -n +3 | xargs -r rm -f

# 6) 推到异机。放在同一块盘上的备份，在整机故障时等于没有
rclone copy backup "$REMOTE:bac-backup" --include "*-$D.*"
```

**三件要单独离线备份、且不在每周备份里的东西**（它们永远不变，变了就是事故）：

| 东西 | 丢了会怎样 |
|---|---|
| `secrets/besu/key` | 同时是 enode 身份和 QBFT validator 身份。丢了 = 链**彻底停止出块**，而换一个 validator 要改创世 = 另一条链。**离线双份** |
| `config/genesis.json` | 每次启动都要读；必须逐字节一致，否则创世哈希对不上、DB 拒绝加载。可以用 `chain/build-genesis.sh` 重建，但要一模一样 |
| `secrets/relayer.env` | 中继两把私钥。轮换通道见 `00 §4.4` |

**最终重建路径永远是：创世文件 + node key + 从 BSC 重放。**

---

## 6. 季度离线维护：trie log 修剪

**实测结论（`docs/research/11`）：在线修剪用不了。**
`--bonsai-limit-trie-logs-enabled` 与 `--sync-mode=FULL` + `--data-storage-format=BONSAI` 不兼容，Besu 直接拒绝启动：

```
Cannot enable --bonsai-limit-trie-logs-enabled with --sync-mode=FULL and --data-storage-format=BONSAI
```

单验证者私链的同步模式就是 FULL，所以这个开关**永远不要加回 compose**。它不是「加了会有警告」，是「加了 3 点钟那次无人值守重启起不来」。

修剪只能离线做，和某一次冷备窗口合并，**每季度一次**：

```bash
cd /opt/bac
docker compose stop -t 150 besu                     # 必须先停，进程还活着时跑会损坏 DB
du -sh data/besu/database                           # 记下修剪前

docker run --rm -u "$(id -u):$(id -g)" \
  -v /opt/bac/data/besu:/data -v /opt/bac/config:/config:ro \
  hyperledger/besu:24.12.2 \
  --data-path=/data --genesis-file=/config/genesis.json --data-storage-format=BONSAI \
  storage x-trie-log prune

du -sh data/besu/database                           # 记下修剪后
docker compose start besu
cast block-number --rpc-url http://127.0.0.1:8545   # 确认从原高度续上
```

**做之前先打一份冷备**（§5 的第 2 步）。`x-trie-log` 带 `x-` 前缀，是实验命令；
如果它失败或把 DB 弄坏了，恢复路径是「解开刚才那份 tar」，不是「再跑一次」。

按 3.8 GB/年 的实测增长率，修剪**不是上线前的必做项**；季度做一次是为了不让它在第三年变成紧急停机。

---

## 7. 中继挂了 / 索引器挂了

两个都是 `restart: unless-stopped`，所以先看它是不是已经自己起来了：`docker compose ps`。

### 7.1 中继（relayer）

中继是**唯一能动钱的进程**，但它的每一步都是幂等的（`depositId` 幂等集、锚点不可跳号），所以
**重启本身是安全的，不会重复铸币**。真正要查的是时限：

```bash
docker compose logs --tail 200 relayer            # 看最后一次成功的方向与区间
cast balance $RELAYER_BSC --rpc-url $BSC_RPC      # < 0.05 BNB 就发不出锚点
cast balance $RELAYER_LAYER --rpc-url http://127.0.0.1:8545   # < 100 BAC 就 credit 不动
curl -s https://$BAC_SITE_HOST/api/health | grep -i anchor
```

按严重度分三档：

| 情况 | 处理 |
|---|---|
| 崩溃重启、几分钟内恢复 | 什么都不用做。漏掉的区间会被重扫 |
| **纪元结束后 10 分钟还没读完四个余额** | 告警。`--bonsai-historical-block-limit=512` 给了约 25.6 分钟的窗口，**25 分钟是硬死线**，过了就读不到那个高度的状态了 |
| 超过 `epochEnd + 2h` 还没发出锚点 | 人工介入。锚点**不可跳号**：这个纪元不发，后面每个纪元都发不出去，`claimExit` 会一直 revert |

**中继私钥不在容器镜像里，也不在这份文档里。** 只有 `secrets/relayer.env`，`600`，ops 属主。

### 7.2 索引器（indexer）

索引器是**只读**的：它没有任何私钥，挂了不会丢钱，只会让网站和 `/rpc` 变成 502。

```bash
docker compose logs --tail 200 indexer
docker compose restart indexer
curl -s localhost:8080/health
```

数据库损坏（SQLite 报 `database disk image is malformed`）时，不要修，重建：

```bash
docker compose stop indexer
mv data/indexer/index.db data/indexer/index.db.broken-$(date +%F)
cp backup/index-<最近一份>.db data/indexer/index.db   # 有备份就用备份，省掉大半回补
docker compose up -d indexer                          # 没备份就让它从头 ingest
```

从头回补要注意：**公共 BSC RPC 对 `eth_getLogs` 限窗**，索引器会自动收窗到 3000 块，
所以 BSC 侧的回补是按小时算的；层内是本机 RPC，按分钟算。
回补期间 `/api/*` 的数字会偏小，网站横幅要写「索引器回补中」，**不许显示演示数据**。

### 7.3 Besu 挂了

这是唯一会让链停下来的情况（v1 只有一个 validator）。

```bash
docker compose logs --tail 200 besu
```

| 日志里看到 | 原因 | 处理 |
|---|---|---|
| `Genesis block hash mismatch` / 拒绝加载 | `config/genesis.json` 被改过 | 换回离线备份的那一份，**逐字节一致**。不要改 DB |
| `Cannot enable --bonsai-limit-trie-logs-enabled ...` | 有人把那个 flag 加回来了 | 删掉它（§6） |
| OOM-kill（`docker inspect` 里 `OOMKilled: true`） | `-Xmx2g` / `mem_limit 3g` 不够 | 先看机器上还有什么在跑；实测 11 小时峰值 RSS 468 MB，突然翻四倍说明有别的事 |
| RocksDB 损坏 | 上次是被 SIGKILL 打断的 | 走 §8 的数据回滚 |

---

## 8. 回滚

按代价从小到大，**永远先试上面的**。

### 8.1 回滚配置（安全，随时可做）

```bash
cd /opt/bac
git -C /opt/bac/chain log --oneline -5      # 或者你自己的备份副本
cp docker-compose.yml.bak docker-compose.yml
docker compose up -d besu                   # 只重启被改的那个服务
```

每次改 compose 之前先 `cp docker-compose.yml docker-compose.yml.bak`。这条没有例外。

### 8.2 回滚镜像（安全）

所有 tag 都是钉死的，而且本地有 `docker save` 的底：

```bash
docker load -i /opt/bac/backup/besu-24.12.2.tar
sed -i 's|hyperledger/besu:.*|hyperledger/besu:24.12.2|' docker-compose.yml
docker compose up -d besu
```

**升级 Besu 之前**，先在一次性容器里用同一份 `genesis.json` 跑一遍
`bash chain/verify-genesis.sh --boot --genesis /opt/bac/config/genesis.json`，通过了再滚正式的。
30303 对公网开着，Besu 的安全公告要有人订阅。

### 8.3 回滚链数据（**最后手段，会造成分叉**）

```bash
docker compose stop -t 150 besu
mv data/besu data/besu.broken-$(date +%F)
mkdir -p data/besu && tar -C data -xzf backup/besu-<日期>.tgz
docker compose start besu
```

做之前必须想清楚这三件事：

1. **恢复 = 回到那个高度重新出块。** 任何已经被外部看到的、比快照新的区块，都会变成一条被我们自己抛弃的分叉。QBFT 的即时最终性在这里帮不了你 —— 它保证的是「共识不会回滚」，不是「运维不会拿旧备份覆盖」。
2. **已经进过锚点的高度不能回滚。** 锚点已经上了 BSC，回滚之后层内算出来的 Merkle 根与 BSC 上那个对不上，`claimExit` 会全线失败。**如果要回滚的高度低于最后一个锚点的 `l2Block(epoch)`，停下来，人工决策，不要自动执行。**
3. 回滚之后，索引器的游标比链头高，会立刻报 parentHash 断链（§2.4 最后一条）。这是对的：先停索引器，删 `index.db`，再让它重新 ingest。

### 8.4 无法回滚的东西

`chainId`、创世文件本身、创世里的代码与余额、node key。
这四样只要出块过一次就永久定死。**这就是 §0 那一步「先验创世，再起链」不许跳过的全部理由。**

---

## 9. 看门狗（watchdog）

决策 #25a：**锚点等待缩到 2 分钟之后，人工发现窗口等于零。** 剩下的闸门只有两道 ——
每天最多释放 2%–5% 的上限，和暂停开关。这个容器就是第二道闸门的执行者。

> **桥里一旦有钱，这个容器就是必开项。** 它没跑起来的时候，网站、FAQ、X 文案里
> 都不许说「有等待期保护」—— 2 分钟等待本身保护不了任何人，它保护的是一个自动程序的反应时间。

> **决策 #29b：它不是「最后的兜底」。** 桥改成可升级 + `emergencyWithdraw` 之后，
> owner 的权限在 `pause()`、停机逃生和这个进程之上。它对**中继私钥被盗**这一类攻击仍然有效，
> 文档与网站按这个口径写，不得拔高。

代码与完整设计在 `../watchdog/README.md`。这里只写运维要做的事。

### 9.1 上线前的一次性准备

```bash
# ① 看门狗那把热钥，单独一个文件，不和中继混在一起（两者信任级别不同）
install -m 600 -o ops -g ops /dev/null /opt/bac/secrets/watchdog.env
cat > /opt/bac/secrets/watchdog.env <<'ENV'
WATCHDOG_PRIVATE_KEY=
ENV
chmod 600 /opt/bac/secrets/watchdog.env
# 这把钥匙在 BacBridge 里是 immutable 的 `watchdog`，它能做的只有
# pause / unpause / armEscape / revokeEpochOwed —— **没有任何一条路径能动 BNB 或 BAC**。

# ② 现读链上，确认这把钥匙确实是那把钥匙（容器启动时也会自检，但这一步要先手动过一遍）
cast call $BAC_BRIDGE "watchdog()(address)" --rpc-url $BSC_RPC

# ③ 代码与数据目录
rsync -a --delete watchdog/ /opt/bac/watchdog/     # 不含 node_modules 也行：镜像里跑 npm ci
mkdir -p /opt/bac/data/watchdog && chown ops:ops /opt/bac/data/watchdog

# ④ 依赖（只有 ethers 一个）
docker run --rm -v /opt/bac/watchdog:/app -w /app node:22-alpine npm ci --omit=dev

# ⑤ 先演练一轮：WATCHDOG_ARMED=false，跑一次就退，确认它读得通两条链
docker compose run --rm -e WATCHDOG_ARMED=false watchdog node src/index.mjs --once
```

### 9.2 启动与通过标准

```bash
docker compose up -d watchdog
docker compose logs --tail 50 watchdog
```

必须看到：

- 一行 `启动自检`，里面 `bridgeWatchdog` 与 `myAddress` **相同**；
- **没有**任何 `启动自检未通过`；
- `onchain` 里的 `bridgeEpoch=600` / `epochsPerDay=144` / `anchorWait=120` —— 这三个数对不上
  就说明地址填错了，或者链上那份合约不是我们审过的那一份。容器会直接退出（码 4）。

如果 `LAYER_RPC_2` 是空的，会有一行 warn 说「层内只有一个 RPC 端点」。**这是预期的**：
官方只有一台出块节点，层侧的复核读因此只能排除瞬时读取错误，排不掉节点本身说谎。
这与信任表第一行是同一件事，不要因为多了一个看门狗就把它淡化掉。

### 9.3 退出码

| 码 | 含义 | 该做什么 |
|---|---|---|
| 0 | 正常退出（`--once` 跑完 / 收到 SIGTERM） | 无 |
| 2 | 配置有误 | 看日志第一行，改 `.env` 或 `secrets/watchdog.env` |
| 3 | **已跳闸** | 立刻按 §9.5 处理 |
| 4 | 启动自检没过 | 多半是那把钥匙不是 `BacBridge.watchdog()` |

compose 里是 `restart: "on-failure:3"`，不是 `unless-stopped`：跳闸之后它**故意停在那里**。
一个已经对这座桥下过结论的进程不该悄悄回去接着看。`docker compose ps -a` 上看得见它是 Exited(3)。

### 9.4 六条告警分别是什么意思

告警走三条路同时发：容器日志里的 `"alert":true` 行、非零退出码、以及（配了的话）webhook。
每一条都带一个 `compared` 字段，里面是它比较过的**每一个数**——不用相信结论，可以自己复算。

| 规则 ID | 一句话 | 会不会暂停 | 人该怎么理解 |
|---|---|---|---|
| `anchor_root` | 链上锚点里的 `exitRoot`（或 `l2Block` / `exitCredits` / `credited`）与看门狗从层内日志独立复算的结果不一致 | **会** | **这是最严重的一条**。它意味着中继发了一个不对应任何真实退出的根，也就是中继私钥可能已经泄露。 |
| `buckets` | 两个 BAC 桶与代币真实余额对不上，或 `lockedBac` 的增量与 `Locked` 事件之和对不上 | **会** | 两个桶的记账被破坏了，或者有 BAC 在账本之外离开了桥。**注意决策 #29：桥改成可升级 + `emergencyWithdraw` 之后，owner 的合法动作也会触发这条**——处理前先确认那笔变动是不是 owner 自己做的。 |
| `reconcile` | 对账恒等式 `diff < 0` | **会** | 层内的积分比 BSC 上锁定的多 = 超发。`diff > 0` 只告警（在途存款 / 在途退出会让它正常变正）。 |
| `release_cap` | 某一纪元的 `pot` 超过按链上算式复算的上限，或 `releaseBps` 不是 200/350/500 之一，或滚动 24 小时超过每天上限 | **会** | 那道「每天最多 2%–5%」的闸门失效了。 |
| `buyback` | 单笔回购花的 BNB 越界，或买到 0 个 BAC，或（读得到历史价时）滑点击穿下限 | **会** | 回购被夹了，或者链上那份合约不是我们审过的那一份。 |
| `cadence` | 锚点落后 ≥ 3 个纪元 | **绝不会** | 中继停摆是**可用性**问题，没有一分钱被多放出去。这时候 `pause()` 只会把「退出慢」变成「退出停」，还白吃掉 21 天暂停额度里的一段。按 §7.1 处理中继，不要去暂停桥。 |

另外三类只告警、不暂停的：`buyback` 读不到归档节点时的单价异常、
`reconcile` 的正方向差额、锚点里 `feeBurned` / `circulating` 两个信息字段对不上。

### 9.5 它跳闸了，人该做什么

**按顺序做，不要跳步。**

```bash
# ① 先确认桥真的被刹住了（看门狗会自己发 pause，但交易可能没上链）
cast call $BAC_BRIDGE "isPaused()(bool,uint64,uint64)" --rpc-url $BSC_RPC
# 第一个返回值必须是 true。是 false 的话，手动补一笔：
#   cast send $BAC_BRIDGE "pause()" --rpc-url $BSC_RPC --private-key <watchdog key>
# （这是唯一一个需要手动发交易的场景，且这把钥匙动不了任何钱）

# ② 看它到底比较了什么
docker compose logs watchdog | grep '"alert":true' | tail -20
sqlite3 /opt/bac/data/watchdog/watchdog.db \
  "SELECT rule,subject,state,detail FROM findings ORDER BY id DESC LIMIT 5;"

# ③ 自己复算一遍。以 anchor_root 为例（$EPOCH 是告警里的 subject）：
cast call $CHAIN_ANCHOR "getAnchor(uint64)" $EPOCH --rpc-url $BSC_RPC
#    再用 node-cli 从层内重算同一个纪元的根，两个数放一起看
```

然后按三种结论分岔：

| 结论 | 动作 |
|---|---|
| **确认是误报** | 先 `unpause()`，再修规则或容差。**`unpause()` 越早越好**：`pausedCumulative` 只累计真正暂停过的秒数，21 天的累计额度耗尽本身就是停机触发 5。然后把 `findings` 里那一行改成 `cleared`，重启容器。 |
| **确认是真的，而且锚点还没 FINAL（`postedAt + 120 s` 之内）** | 用 **veto 钥**立刻 `ChainAnchor.veto(epoch, reasonHash)`。这是**唯一零损失**的路径。120 秒基本上意味着冷钥来不及 —— 这正是模拟报告建议把 vetoKey 交给常驻进程的理由，见 `watchdog/README.md` §5①。 |
| **确认是真的，但锚点已经 FINAL** | 小偷的 `claimExit` 已经把资产桶锁成了他的 `owed`，`pause()` 只是延后。**在暂停期间**用看门狗钥匙调 `revokeEpochOwed(epoch, holders[])` 把那个锚点纪元锁定的债权整批作废。注意它会**误伤**同一纪元里的诚实退出者（他们要凭修正后的根重新 `claimExit`），所以 `holders` 要人来确认，看门狗**不会自动调它**。同时走 `ChainAnchor.proposeRelayer` 换中继（48 小时时锁）。 |

**跳闸之后不要做的事**：不要直接删 `findings` 表重启了事。那一行是唯一记录着
「当时链上是什么、我们算出来是什么」的地方；删了之后，事后复盘无从谈起。

### 9.6 它自己挂了怎么办

```bash
docker compose ps -a | grep watchdog     # Exited(3) = 跳闸；Exited(2)/(4) = 配置或自检
docker compose logs --tail 100 watchdog
docker compose up -d watchdog            # 游标在 SQLite 里，重启不会重扫也不会漏扫
```

**重启是安全的**：游标、重报集（被 veto 的纪元）、影子账本、以及没走完的告警都落在
`data/watchdog/watchdog.db` 里。崩在「已复核成立、pause 还没发出去」那一瞬间的话，
重启后它会**直接把那笔 pause 发出去**，而不是从头再探测一遍。

**它不在 Up 状态，就等于那道闸门不存在。** 所以 §2.4 的告警清单里专门有一条
「watchdog 容器不在 Up 状态」——它自己会喊，但它死了就没人喊了。

### 9.7 每周冷备要带上它

`§5` 的冷备脚本里，`data/watchdog/watchdog.db` 和 `data/indexer/index.db` 一样可以在线备份
（SQLite 有一致快照）。丢了它不会丢钱，但会丢掉「上次跳闸时链上到底是什么样」的全部记录，
以及重报集 —— 后者丢了之后，下一个合并了被否决纪元的合法锚点会被误判成伪造。

---

## 10. 每次动手之前

- 不广播、不部署、不发帖，除非用户当面逐项确认过。
- 任何改动先记下「改之前是什么」。`.bak`、`du -sh`、`cast block-number` 三个数，花不了十秒。
- 数字照实写。测出来 3.8 GB/年就写 3.8 GB/年，不写「约 4 GB」也不写「几乎不涨」。
