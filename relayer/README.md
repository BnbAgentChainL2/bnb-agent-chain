# BAC 官方中继（relayer）

`docs/03-INTERFACES.md` §1 的实现。**一个 Node 22 进程 + 一个 SQLite 文件 + 两条 EOA 私钥**，
不是协议，不是多签，不是 committee。第一版中继受信任，这一点在网站页脚和文档里明说。

```
relayer/
  src/
    index.mjs      进程入口：四个循环（扫 BSC / 组装锚点 / 发送 / 输出状态）+ 优雅关闭
    config.mjs     环境变量（私钥只按变量名读，读完立刻注册进日志擦除表）
    chains.mjs     两条链的适配器 —— **所有网络调用只出现在这个文件里**
    scan.mjs       方向 A / C：BSC 日志 → outbox（先落盘，再推游标）
    finality.mjs   方向 A 的三段确认状态机 + fail-closed（纯函数）
    anchorMath.mjs l2Block(epoch) 的规范算术 + 锚点排序（纯函数）
    anchorJob.mjs  方向 B：把一个纪元组装成 AnchorJob
    sender.mjs     唯一发交易的地方：二次核对、一次一笔、加价重发、parked、重启续传
    status.mjs     /api/health 形状的状态对象（给索引器用）
    db.mjs         SQLite（表结构照抄 03 §1.5）
    ids.mjs        depositId / 退出叶子 / merkle 根与证明
    log.mjs        结构化日志 + 私钥擦除
  test/            node:test，全部离线（临时 SQLite + 假链，不碰网络）
```

## 跑起来

```bash
npm install            # 只有一个依赖：ethers 6.13.4（精确钉住，与网站 vendored 的那份一致）
cp .env.example .env   # 填变量；私钥用 secrets/relayer.env，别提交
npm start              # = node src/index.mjs，与 02-CHAIN-SPEC §5 的 compose command 一致
npm test               # = node --test test/*.test.mjs
```

SQLite 用 Node 22 内置的 `node:sqlite`，**没有原生编译**，`node:22-alpine` 直接能跑
（会打一行 `ExperimentalWarning: SQLite is an experimental feature`，属正常）。

## 三个方向

### 方向 A：BSC → 层（存款）

触发 `BacBridge.Locked`，三条确认条件**必须同时满足**：

| 条件 | 值 | 代码 |
|---|---|---|
| 两个独立 BSC RPC 给出一致的 `finalized` 且已覆盖该区块 | `BSC_RPC` / `BSC_RPC_2` | `finality.mjs` |
| 深度 | `>= 15` 块 | `CONFIRM.DEPTH` |
| 距首次看见的墙钟 | `>= 45` 秒 | `CONFIRM.WALL_SEC` |

**`finalized` 取不到时（fail-closed，不是退回一个更弱的条件）：**
- 兜底门槛 **深度 >= 1200 块 且 >= 600 秒**（旧的「深度 >= 120」按实测 0.45 s 块时间只有 54 秒，
  比它要兜底的 45 秒规则强 9 秒 —— 等于没有兜底）；
- **连续 10 分钟取不到 `finalized`：停止发 `credit`**，`/api/health` 打 `warnings: ["bsc_finality_unavailable"]`。
  `credit` 迟到几分钟只是体验问题，`credit` 发错是不可恢复的。

**「两个 RPC 一致」的可执行读法**：两边的 `finalized` 高度天然会差几个块，比高度必然假阳性。
本实现在**共同高度**（两边 `finalized` 的较小者）上比区块哈希 —— 这才是在问「你们俩在同一条链上吗」。
不一致时打 `bsc_finality_disagreement` 并退回兜底路径。深度一律用两个 RPC 里**较小**的 head 算。

`depositId = keccak256(abi.encode(56, bscBridgeAddr, bscTxHash, logIndex))`。
**它不是 `Locked` 事件里那个自增计数器**：BSC 合约拿不到自己的 tx.hash，所以两者不是同一个值，
层内 `seen[]` 的键永远是这个 keccak（`ids.mjs::depositKey`，测试里与手算的 `abi.encode` 对拍）。

**重组处理**：发送前用 `eth_getTransactionReceipt` 重读；收据没了 / `blockHash` 变了 / 那条日志不在了
→ `status = "orphaned"`，不发，打告警。
深于最终性的重组（几乎不可能）没有自动回滚：中继在 `L2Bridge` 里能调的只有 `credit`，销毁只有持有者自己 `exit`。
预案是**运营方在 BSC 上用自己的 agent 身份补 `lock` 等额 BAC**（无许可，不动任何用户的积分），把
`totalCreditsIssued` 抬回去，锚点立刻能继续发。

### 方向 B：层 → BSC（锚点，一个纪元一次）

```
l2Block(epoch)     = 时间戳 < (epoch + 1) * 86400 的最大层内区块号
l2BlockHash(epoch) = 该区块的哈希
六个计数字段与 exitRoot 全部在区块区间 (l2Block(epoch-1), l2Block(epoch)] 上聚合
circulating        = 在 l2Block(epoch) 这个高度上读四个余额，**不读 head**
```

**绝不能用「提交时的 head」**：见证人必须在锚点发布之前就把 `l2Block` 封进承诺里，让他们猜一个未来区块号
等于让 10 个诚实验证者全部计入 `disputingWeight`，第 3 个纪元就触发停机。

- 排序：`epoch == lastPostedEpoch + 1`，上一个纪元已定案（`FINAL`/`VETOED`/`DISPUTED`），
  且已过 `COMMIT_WINDOW = 2h`。落后多个纪元时先发最老的，**绝不跳号**。
- 被 `VETOED` / `DISPUTED` 的纪元：三个计数字段与**全部退出叶子**并入下一个锚点重报，
  **叶子本身一个字节都不变**（叶子里没有 `epoch` 字段），用户用新锚点的 `anchorEpoch` 就能证明。
- 空纪元（长时间停机）：`l2Block(epoch) == l2Block(epoch-1)`，`exitCount = 0`、`exitRoot = 0`、计数字段为 0。
- `feeBurnedInEpoch := ΔB_FeeSink + ΔB_出块者`。**小费不进 FeeSink**（zeroBaseFee 下全部 gas 费以 tips
  形式进出块者 EOA，实测），两个地址必须分别读再相加。
- **6 分钟状态窗口**：`--state.scheme=path` 默认只保留 128 个状态 ≈ 6.4 分钟，所以纪元一结束就组装并落盘
  （发交易可以晚到承诺窗口之后）。晚了就打 `layer_state_window_missed`。

**层侧没有任何重组处理**，这是故意的：QBFT 是即时最终性，块一 commit 就不会回滚
（`docs/research/10-consensus-client.md` 实测：Besu 24.12.2 + QBFT + cancun，45 s 出 21 块，309 MiB）。
所以 `anchor` 这种 job 不可能变成 `orphaned`；BSC 来源的 `credit` / `sync` 仍然保留全套重组处理。

### 方向 C：BSC → 层（状态镜像）

`Activated` / `Dormant` / `Banned` / `AgentWalletSet` / `Retired` → `L2Gate.applySync`。
状态取**现读**（同一段区块里连着变两次时，镜像的是最终状态）。
用与 `credit` 同一套确认判定：它同样以 BSC 日志为来源，发错会让被 ban 的 agent 继续发公告。
退出（`L2Bridge.exit`）永远不看 status，所以这条判定不影响任何人取钱。

## outbox 纪律（03 §1.1，逐条）

1. **先把待办写进 SQLite 并提交事务，再推进游标。** 崩在两步之间 = 重扫一段 = `UNIQUE(kind,key)` 去重；
   反过来崩一次就永久漏掉一笔存款。
2. 发送前 `eth_getTransactionReceipt` 二次核对源日志仍在规范链上。
3. **一次只发一笔**，`await tx.wait(1)` 之后才发下一笔，**不做 nonce 管理器**（重发复用同一个 nonce）。
4. 所有写操作靠链上的幂等键兜底：`seen[depositId]`、`epoch == lastPostedEpoch + 1`、
   `L2Gate.syncedAt(agentId)`。**重发是安全的**，每次发送前和 park 之前都会再查一次幂等键。
5. 60 秒未上链按 **1.25 倍**加价重发，最多 **3** 次；之后 `parked` 并告警，**不阻塞后续 job**。

**队列头的 job 只是「还没到确认时间」时会被跳过，而不是堵住整条队列**：堵住的代价是锚点被一笔没确认够的
存款拖过承诺窗口，而跳过是安全的（每条 job 的幂等键互相独立）。真正卡住的 job 由 `parked` 兜底。

**崩溃重启**：启动时对每条 `status = 'sent'` 的记录 ——
① 链上幂等键已满足 → `confirmed`（**不重发**）；② 收据已存在且成功 → `confirmed`；③ 都没有 → 退回 `new` 重发。
游标只从 SQLite 读，不从链上猜。

## 状态输出

`status.mjs` 导出 `/api/health` 形状的对象（`relayer` / `reconcile` / `anchorCommitWindowEndsAt` /
`pendingCredits` / `warnings`），进程每 15 秒写一份到 `${DB_PATH%.db}-status.json`，索引器读它拼进 `/api/health`。

对账公式**只能是这一个**：

```
diff = (bscTotalIssued − bscTotalExited)
     − (layerCirculating + feeSinkBalance + feeSplitterBalance + Σ validatorBalances)
layerCirculating = 1e27 − B(L2Bridge) − B(FeeSink) − B(FeeSplitter 0x…0104) − Σ B(everValidator)
```

决策 #17 之后加了两项：归集进 `FeeSplitter` 但还没被领走的 gas 费，以及**逐个**验证者的余额
（QBFT 的验证者集可变，旧的单个 `signerBalance` 已经不够用，字段改成 `validatorBalances[]` 数组）。
漏减 `FeeSplitter` 会让 `diff` 从第一笔归集起恒为正，和当初漏减小费是同一个错。

`everValidator` 累积表从环境变量 `LAYER_VALIDATORS`（逗号分隔）读，留空时退回
`LAYER_SIGNER_ADDRESS` 那一个地址 —— 这就是阶段 1 的真实情况。

`reconcile.howToCheck` 里的**七条** `cast` 原样返回：**任何人都能自己复算 `diff`，不需要相信我们算好的布尔值。**

## 安全

- **私钥只按变量名从环境读**（`RELAYER_PRIVATE_KEY` / `RELAYER_LAYER_PRIVATE_KEY`），
  不打印、不落盘、不进日志：`log.mjs` 在输出前把注册过的秘密值替换成 `[REDACTED]`（有测试）。
- 启动时校验：两个 BSC RPC 不能是同一个；`LAYER_FINALITY` 必须是 `instant`。
- 中继在 BSC 上只会发一种交易：`ChainAnchor.postAnchor`；在层内只会发 `L2Bridge.credit` 与 `L2Gate.applySync`。
  它没有任何转移资金的路径。

## 测试

```
npm test    # 86 个用例，全部离线：临时 SQLite 文件 + 假 provider，不需要服务器 / 主网 / 有钱的钥匙
```

覆盖：确认状态机的每一条分支（含三条 fail-closed 分支与「停发前一秒仍走兜底」的边界）、
`depositId` 与叶子/根/证明的对拍、outbox 幂等与「先落盘再推游标」、锚点排序（跳号、窗口、未定案、追赶）、
锚点组装（正常 / 空纪元 / veto 重报 / 事件 epoch 不一致就停）、加价重发与 parked、
**发送中途崩溃后重启不重复发送**、对账公式与 health 形状、私钥不进日志。

## 与文档的出入（实现时发现的，已按 SPEC 优先处理）

1. **`03 §3.1` 的样例数字对不上它自己的公式。** 样例里
   `issued − exited = 4,880,000e18`，而 `layerCirculating + feeSink = 4,879,996.878125e18`，`diff` 实际是
   `3.121875e18`，但样例写的是 `"diff": "0"`。公式本身是对的（代码按公式实现），错的是样例里
   `layerCirculating` 少了三位（应为 `4879999996875000000000000`）。建议改文档的样例数字。
2. **`01 §6.1` 的 `Anchor` 结构注释里的 leaf 布局仍然带 `epoch`**（`… credits, epoch, 56777, bridge`），
   与同文件 §4.1 的 `EXIT_TYPEHASH`、§8.1 与 `03 §1.3` 的「叶子里没有 epoch」矛盾。
   本实现按 **`EXIT_TYPEHASH`（没有 epoch）**，与 `contracts/src/layer/L2Bridge.sol` 一致。
3. **`01 §8.2` 的 `L2Gate` ABI 没有 `syncedAt(agentId)`，但 `contracts/src/layer/L2Gate.sol` 有。**
   本实现只把它当方向 C 的幂等兜底，读不到就退回比较 `statusOf(wallet)`，不依赖它做任何判定。
4. **`02 §2` 把 `0x…0104` 留给 v2 的 validator-contract 模式，而决策 #17 把 `FeeSplitter` 放在 `0x…0104`、
   把 validator-contract 挪到 `0x…0105`。** `03-INTERFACES.md` 里也还没有决策 #17 提到的 §3.7。
   中继目前不碰这两个地址（锚点里也还没有逐 proposer 的 gas 字段），等文档定稿再加。
5. `03 §3.1` 的 `howToCheck` 与 `02` 里把出块者地址称作 `CLIQUE_SIGNER`，而链已经换成 Besu QBFT。
   环境变量两个名字都认，优先 `LAYER_SIGNER_ADDRESS`。
