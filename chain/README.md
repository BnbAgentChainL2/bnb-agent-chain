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
| `baseFeePerGas` | `0x3b9aca00` | 1 gwei，EIP-1559，base fee 全部销毁 |
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

# 3) 剩下的交给 scripts/build-genesis.sh：部署系统合约 → 取 runtime 字节码 →
#    填模板 → 起一次性 Besu → 回读对拍 → 打印创世哈希 → GENESIS BUILD PASSED
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
