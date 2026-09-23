# chain/ · 层的创世与节点配置

**规格在 `../docs/02-CHAIN-SPEC.md`，本目录只放能直接喂给工具的文件。**
两处说法不一致时以 `02-CHAIN-SPEC.md` 为准，并且要立刻把本目录改到一致——不许留两份真相。

共识客户端是 **Hyperledger Besu 24.12.2 + QBFT**，不是 geth Clique。
原因见 `../docs/research/10-consensus-client.md` 的实测表、`../docs/decisions.md` #12、以及 `02-CHAIN-SPEC.md` §11「为什么不是 geth」。这个问题已经关闭。

---

## 文件

| 文件 | 是什么 | 对应规格 |
|---|---|---|
| `qbftConfigFile.json` | 喂给 `besu operator generate-blockchain-config` 的输入模板。它产出 `genesis.json` 的 `config` 段、RLP 编码的 `extraData`，以及一把 node key | `02-CHAIN-SPEC.md` §3.1 |
| `genesis.template.json` | ✅ §3.2 的完整创世模板，**10 个占位符**（比原文多了 `FEESPLITTER`、`CREATE2_DEPLOYER` 与 `WBAC`，见 §3.2 的 2026-09-23 更正与决策 #22） | §3.2 |
| `build-genesis.sh` | ✅ 生成 + 校验。`--rehearsal` 是无 Docker 的本机演练。结尾打印 `GENESIS BUILD PASSED`（演练模式打印 `REHEARSAL COMPLETE`，永远不会冒充正式创世） | §3.3 |
| `verify-genesis.sh` | ✅ 回读对拍：用创世起一台一次性节点，逐字节比对 alloc 的代码与余额、读回所有 view、核对 QBFT 验证者集、证明 cancun 真的在跑、打印创世哈希 | §3.3 步骤 6–10 |
| `scripts/fill_genesis.py` | ✅ 填占位符并拒收任何可检测的错误（金额算术、十六进制余额、EIP-170、地址集合、UTC 零点、零 storage） | §3.3 |
| `scripts/statetrie.py` | ✅ 纯 Python 的 keccak-256 + RLP + 状态树。**不用任何客户端就能从 `genesis.json` 算出 stateRoot**，任何人可复算；自检把 keccak/RLP 对 `cast`、树根对 anvil 的真实 `stateRoot` 各验一遍 | 本目录新增 |
| `scripts/qbft_extradata.py` | ✅ QBFT `extraData` 的解码器（随时可用）与编码器（**仅演练用，未与 Besu 对拍**，正式链必须用 `besu rlp encode --type=QBFT_EXTRA_DATA`） | §3.0.1 |
| `docker-compose.yml` | ✅ 正式链的四个服务（besu + relayer + indexer + caddy），镜像全部钉死，以 ops 的 uid:gid 运行 | §5.2 |
| `Caddyfile` | ✅ 自动 TLS + `/rpc` `/api` `/health`。`handle_path` 加 `rewrite`，两条实测理由都写在文件里 | §5.3 |
| `config/log4j2.xml` | ✅ 一行一条日志、不写文件、交给 docker 的 json-file 轮转 | §5.2 |
| `OPERATIONS.md` | ✅ 运维手册：启动顺序、健康检查、磁盘阈值（按实测 3.8 GB/年）、每周冷备、季度离线 trie log 修剪、中继/索引器/Besu 挂了怎么办、怎么回滚 | §5.4 / §5.5 |
| `../contracts/script/DeployLayerSystem.s.sol` | ✅ 在一次性 anvil 上部署系统合约 + `WBAC` 供取 runtime 字节码。**只在 chainId 31337 上肯跑**（合约里 require 住了） | §3.3 步骤 2 |
| `../contracts/script/CancunProbe.sol` | ✅ 证明 MCOPY/TSTORE 真的能跑。整个探针在构造函数里，用 `eth_call --create` 执行：不发交易、不用私钥、不改状态 | §3.3 步骤 9 |
| `probe-consensus.sh` | **待建（已实测跑过一次，2026-09-22）。** 一次性容器验证 QBFT + cancun 能出块 | §5.1 |
| `build/` | 生成产物（`networkFiles/`、`codes.txt`、`genesis.json`、`genesis-manifest.json`）。**含真实私钥，必须在 `.gitignore` 里** | §3.0 |
| `GENESIS.md` | **待建。** 创世哈希、validator 地址、中继地址、不流通地址清单，公开发布 | §3.3 第 10 步 |

---|---|---|
| `qbftConfigFile.json` | 喂给 `besu operator generate-blockchain-config` 的输入模板。它产出 `genesis.json` 的 `config` 段、RLP 编码的 `extraData`，以及一把 node key | `02-CHAIN-SPEC.md` §3.1 |
| `genesis.template.json` | **待建。** §3.2 的完整创世模板，含 6 个占位符 | §3.2 |
| `scripts/build-genesis.sh` | **待建。** 生成 + 回读对拍，结尾必须打印 `GENESIS BUILD PASSED` | §3.3 |
| `scripts/fill_genesis.py` | **待建。** 把 6 个占位符替换进模板 | §3.3 |
| `probe-consensus.sh` | **待建（已实测跑过一次，2026-09-22）。** 一次性容器验证 QBFT + cancun 能出块 | §5.1 |
| `script/DeployLayerSystem.s.sol` | **待建。** 在一次性 anvil 上部署三个系统合约 + Multicall3，供取 runtime 字节码 | §3.3 |
| `build/` | 生成产物（`networkFiles/`、`codes.txt`、`genesis.json`）。**含真实私钥，必须在 `.gitignore` 里** | §3.0 |
| `GENESIS.md` | **待建。** 创世哈希、validator 地址、中继地址、不流通地址清单，公开发布 | §3.3 第 10 步 |

---

## `qbftConfigFile.json` 里每个值为什么是这个值

| 键 | 值 | 一句话 |
|---|---|---|
| `chainId` | `56777` | 决策 #2 / §1。**D0-2 还没做**：必须先在 chainlist.org 与 `ethereum-lists/chains` 确认没被占用，被占则 56778。链一出块就不能改 |
| `cancunTime` / `shanghaiTime` | `0` | solc 0.8.26 的默认目标是 cancun。geth Clique 在这一项上 panic，Besu QBFT 实测正常——这是换客户端的第二条理由 |
| `contractSizeLimit` | `24576` | EIP-170，显式写出来，免得重建创世的人去猜默认值 |
| `qbft.blockperiodseconds` | `3` | 与原 `clique.period` 同值，28,800 块/天 |
| `qbft.epochlength` | `30000` | 每 ~25 小时清空未过半的验证者投票。**这个 epoch 是 QBFT 投票纪元，和产品里 `epoch = floor(ts/86400)` 的结算纪元无关** |
| `qbft.requesttimeoutseconds` | `6` | `2 × blockperiodseconds`。v1 单 validator 用不上，是为扩容到 4 个那天准备的 |
| `gasLimit` | `0x1312d00` | 20,000,000。磁盘是真正的约束，不是 gas |
| `zeroBaseFee` / `baseFeePerGas` | `true` / `0x0` | **决策 #16（实测倒逼）**：Besu 里 basefee 只能销毁、无法分账，`--miner-coinbase` 在 QBFT 下被忽略。所以关掉 basefee，全部 gas 费以 tips 形式进出块者地址，再由 `FeeSplitter` 分账。本文件 2026-09-23 之前写的是 `0x3b9aca00`（1 gwei，全部销毁），那是决策 #16 之前的旧口径，已改 |
| `mixHash` | `0x6374…6365` | **QBFT/IBFT2 的固定魔数**（ASCII `ctical byzantine fault tolerance`）。不是随机 32 字节，填错 Besu 不认这条链 |
| `difficulty` | `0x1` | BFT 链不用难度 |
| `timestamp` | `0x0` | **占位。** 正式创世取发射当天 UTC 00:00，由 `build-genesis.sh` 填，使层内纪元与 BSC 的 UTC 纪元对齐 |
| `alloc` | `{}` | **故意留空。** 三个系统合约的 runtime 字节码要先从一次性 anvil 上取出来，由 `build-genesis.sh` 填进 §3.2 的模板。顺序不能倒：`generate-blockchain-config` 每跑一次就换一把密钥、换一份 `extraData` |
| `blockchain.nodes.count` | `1` | v1 一个官方 validator（决策 #6）。扩容走 `qbft_proposeValidatorVote` 投票，**不重建链**；而且下一步是 **4 个**不是 3 个（QBFT 的 n=3 容错仍然是 0，见 §6.4） |

---

## 用法

```bash
# 1) 生成 config 段 + extraData + node key（产物在 build/networkFiles/）
docker run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD:/cfg" -v "$PWD/build:/out" \
  hyperledger/besu:24.12.2 \
  operator generate-blockchain-config \
    --config-file=/cfg/qbftConfigFile.json \
    --to=/out/networkFiles \
    --private-key-file-name=key

# 2) 取 validator 地址（目录名就是它）
ls -d build/networkFiles/keys/0x*

# 3) 剩下的交给 build-genesis.sh：部署系统合约 → 取 runtime 字节码 → 填模板 →
#    算 stateRoot（不用客户端）→ GENESIS BUILD PASSED
bash build-genesis.sh

# 4) 回读对拍（要 Docker，在服务器上跑）：起一次性 Besu → 逐字节比 alloc →
#    读回所有 view → 核对验证者集 → 证明 cancun → 打印创世哈希
bash verify-genesis.sh --boot --genesis build/genesis.json

# 本机没有 Docker 时，先跑演练把前半段走通（产物叫 genesis.rehearsal.json，不是正式创世）
bash build-genesis.sh --rehearsal
```

`besu` 没有 `init` 这一步：`genesis.json` 在**每次启动**时被读取，并与数据库里记录的创世哈希比对，不一致就拒绝启动。
所以这份文件要和 node key 一起进离线备份（`02-CHAIN-SPEC.md` §5.5）。

只想重算 `extraData`（换验证者集、做轮换演练），不要重跑 `generate-blockchain-config`：

```bash
echo '["0xVALIDATOR_1","0xVALIDATOR_2","0xVALIDATOR_3","0xVALIDATOR_4"]' > toEncode.json
besu rlp encode --from=toEncode.json --to=extraData.txt --type=QBFT_EXTRA_DATA
```

**链一旦出块，验证者集只能靠 `qbft_proposeValidatorVote` 改，改 `extraData` 没有任何作用。**

---

## 三条不许违反的纪律

1. **本目录里不存在任何真实私钥。** `generate-blockchain-config` 产出的 `build/` 含 node key，`build/` 必须在 `.gitignore` 里。真密钥在发射当天于服务器上生成一次，`chmod 600`，离线双份。
2. **node key 同时是 enode 身份和 QBFT validator 身份。** 丢了不是「换个 enode」，是链**彻底停止出块**且只剩 90 天逃生（`02-CHAIN-SPEC.md` §10）。
3. **本目录的文件改了，`02-CHAIN-SPEC.md` 同步改。** 这份 README 是索引，不是第二份规格。
