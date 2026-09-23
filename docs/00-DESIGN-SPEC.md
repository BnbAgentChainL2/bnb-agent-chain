# 00 · BNB Agent Chain 系统总设计（BAC）

2026-09-22。本文是**施工依据**：下游 `01-CONTRACT-SPEC.md` / `02-CHAIN-SPEC.md` / `03-INTERFACES.md` 只做细化，不得改变本文的结论。
用户已拍板的 `docs/decisions.md` 11 条高于本文；Flap 规则 001–010（`docs/research/01-flap-spec.md`）不可谈判。
本文由三份架构方案（`artifacts/design-options/arch-security.md`、`arch-ship.md`、`arch-agentnative.md`）与三份评审（`judge-flap.md`、`judge-attack.md`、`judge-buildable.md`）综合而成。

---

## 0. 选型结论与分歧裁决

**基座 = arch-security。** 它在「Flap 合规」（7.5/10）和「资金安全」（8/10）两个评审里都是第一，且是唯一一个把用户的钱搬出可升级金库、唯一一个有不依赖我们服务器的逃生通道的方案。它在「可交付性」上只有 3/10，本文把那 10 条扣分逐条改掉（§0.2）。

### 0.1 从另外两份方案移植的东西（每条一行理由）

| # | 移植 | 来源 | 一行理由 |
|---|---|---|---|
| G1 | `_validateBeforeLaunch` 用 `vaultBps == 10000`，并在 `tokenCreationPolicies()` 镜像 `("mktBps","eq",10000)` | ship / agentnative | 只有下界就是 某个更早的同类项目 记录在案的两次填错（planned 50/20/20/10 → launched 80/0/20/0），而 50/50 是本项目的全部叙事，`description()` 是 `pure`、部署即冻结、发射后不可回滚。 |
| G2 | `newVault` 里交叉校验我们自己先部署的合约：`IBacBridge(bridge).bacToken() == taxToken`、`IBacNodeFund(nodeFund).bacToken() == taxToken` | ship | 合法（禁止的是触碰还没有代码的 `taxToken`，调我们自己的合约没问题），把「发射表单粘错地址」从只能重新发射的事故变成发射当场 revert。 |
| G3 | `newVault` 里 `require(creator == LAUNCHER)`（`LAUNCHER` 是工厂构造参数 immutable） | agentnative | 工厂策略默认 `OPEN`，陌生人能用我们的工厂发币并继承工厂的风险等级；决策 #11 已拍板 creator 白名单。 |
| G4 | `receive()` 的 gas 口径：目标 < 50,000，测试断言 `call{gas: 50_000}` 成功 | agentnative | 带 value 的 `call{gas:50_000}` 被调方可用 52,300（50,000 + 2,300 stipend）；security 写的「冷 < 60k」会放行一个必然 ping 失败的金库，而规则 005 的违反是 Critical。 |
| G5 | 创世开到 Cancun（`cancunTime: 0`） | agentnative / ship | solc 0.8.26 默认目标是 cancun，会发出 `MCOPY`；security 的 `shanghaiTime 0` 会让创世系统合约在本链上是非法指令，而创世不可改。 |
| G6 | 创世预置 Multicall3、CREATE2 确定性部署器**与 WBAC（决策 #22）** | agentnative / 决策 #22 | 前两个：几 KB 字节码，省掉浏览器、SDK 和每个 agent 的一堆特判。WBAC：Uniswap-V2 式的池子两边都得是 ERC-20，没有一个公认的 WBAC 就没人能拿手上的 gas 币建池子；不预置则必然冒出多个互不兼容的 WBAC 切碎流动性。三个都是**中立工具**——没有 owner、没有参数、没有升级路径、不收费、我们自己也改不了。 |
| G7 | 钉死 geth 镜像 tag，并在 D0 用一次性容器验证 Clique 能出块 | agentnative | 上游 go-ethereum 正在移除 Clique，整个项目建立在它上面，不先验证后面全部归零。 |
| G8 | 11 步本地端到端脚本 `artifacts/e2e/run.sh`，结尾必须打印 `E2E PASSED`；D0–D7 排期 | ship | 三份方案里唯一给了「怎么知道我们做完了」的判据。 |
| G9 | 中继发送前用 `eth_getTransactionReceipt` 二次核对 + `orphaned` 标记；outbox 先落盘再推游标；一次一笔 `await tx.wait(1)`，不做 nonce 管理器 | ship | 3 vCPU 上最不会半夜炸的形态，重组处理最细。 |
| G10 | 索引 API 必须发 `Access-Control-Allow-Origin: *`；Caddy 开公开 `/rpc` | ship / 决策 #9 | 忘了 CORS，Vercel 上的站直接是白的；没有公开 RPC，agent 必须自建全节点才能进场。 |
| G11 | `exit()` 谁都能调，不受 agent 状态门控 | ship | 退出是唯一不得被任何状态门控的动作（见 §5 F7）。 |
| G12 | 层内中继私钥的轮换通道不经过中继自己 | agentnative 的问题 + 本文的修法 | agentnative 的 `rotateRelayer` 要求旧钥签名且经被盗的中继转发 = 失守后不可恢复；本文改成创世写死的冷钥离线签名、任何人可提交（§4.4）。 |

### 0.2 评审点名的致命缺陷，逐条修法

**Flap 合规（judge-flap）**

| 缺陷 | 修法 |
|---|---|
| 三家都没在 hook 里钉死税率，却把 owner 桶写成收入的固定 bps | `_validateBeforeLaunch` 用 `==` 钉死 `buyTaxRate == 200 && sellTaxRate == 200`，并在 `tokenCreationPolicies()` 镜像两条。**同时本设计的金库里没有任何 owner 桶**（§3.2），规则 001-h 的佣金上限对金库本体不再适用。 |
| 三家都没算 Flap 协议费 `feeRate = 1000 bps` | 所有 50/50 文案、`description()`、网站规则卡一律写在**扣除 10% 协议费之后**的基数上，并给出算术表（§3.3）。`commissionReceiver` 留空以保证 `commissionBps == 0`（rat 主网实测）。 |
| `vaultUISchema()` 内容全部未定 | §3.2 与 `01-CONTRACT-SPEC.md` §2.4 给出逐字内容：**只出 view，零写方法，零 approvals**，与「层内没有给人用的写入界面」的叙事一致（02 §7.5）。 |
| security 的 `vaultBps < 1000` | G1。 |
| security 没有 creator 限制 | G3。 |
| security 的 `receive()` 60k 上界自相矛盾 | G4。 |
| security 的 `settle()` 跨外部调用缓存 `accountedQuote` | 每次 `call{value}` 之后**从 storage 重读 `_revenue`** 再继续写（规则 010 明列禁止跨外部调用缓存）。`receive()` 不是也不能是 `nonReentrant`。 |
| ship 的 `OPS_BPS = 1000` | 不采用。本设计金库零 owner 桶。 |
| ship / agentnative 的 `payRedemption` / `payValidator` 是 Guardian 调不动的受限函数 | **删掉这两个函数**。金库只推不拉：`settle()` 无许可，把两半分别推给两个不可升级合约。金库里唯一的受限函数是 `transferOwnership(owner 或 Guardian)`，规则 001-d/e 满分。 |
| 赎回份额在金库外、结算前算（读懒结算的桶） | 桥池的钱**不在金库里**，在 `BacBridge` 自己的记账变量 `poolBalance` 里；赎回不读金库任何东西。规则 010 的「revenue-dependent action 前先 sync」自然满足。 |
| agentnative 的 `OPS_CAP` 存量上限被写成终身上限 | 不适用（无 ops 桶）。节点基金的真实结构逐字写进 `description()`（§3.4）。 |
| agentnative 没有发射后硬停清单 | §7.3 给出 10 项 `verify_launch` 硬停。 |

**资金安全（judge-attack）**

| 缺陷 | 修法 |
|---|---|
| A1 `NO_ATTEST_EPOCHS = 14` 零见证不可逆停机（新链默认零验证者，上线 14 天自杀） | **零见证永远不触发停机**，只把释放档位压到 200 bps。停机触发只剩三条：90 天无新 FINAL 锚点、连续 7 个纪元被 veto、连续 3 个纪元被验证者多数否决。 |
| A2 veto 可无限期冻结且永不触发逃生 | **滑动窗口**计数：任意连续 30 个纪元内被 veto 满 `VETO_LIMIT_PER_WINDOW = 7` 次即构成停机触发，第 8 次 `veto` 直接 revert。（2026-09-22 修订：旧的「连续计数 + FINAL 清零」可以用「veto 七个、放过一个」无限循环绕过，见「评审与修订记录」第 35 条。） |
| A3 快照遗漏可把某个 agent 从逃生口删掉 | **逃生完全不用快照和 merkle**：逃生份额 = `credited[agentId] − exitedCredits[agentId]`，两个数都在 BSC 的 `BacBridge` storage 里，中继碰不到（§4.5）。 |
| A4 见证人报出不同的根对 `finalize` 没有阻断力 | `finalize(epoch)` 检查异议权重：`disputingStake >= agreeingStake && disputingStake > 0` → 该纪元强制 `DISPUTED`，不结算、不释放，退出滚到下一纪元；连续 3 次 → 可武装逃生。这是把人类验证者从仪表盘变成刹车的唯一办法，也是给他们发钱的唯一正当理由。 |
| A5 `settleEpoch` 无预留，攒 10 个纪元同块结算 = 一次性定价 50% 桥池 | `settleEpoch(epoch)` 必须**按序**（`epoch == lastSettledEpoch + 1`），且**可以跳过非 FINAL 的纪元**。（2026-09-22 修订：释放额不再记在逐纪元的 `epochPot` 上 —— 那会让晚退出的人回头洗劫 30 个未清扫纪元的 pot。改成 MasterChef 式单一累加器 `accPerOwed` + `reservedTotal`，见「评审与修订记录」第 18/27 条。） |
| A6 最后一个 FINAL 锚点之后约两天的存款没有逃生路径 | 同 A3：逃生按 BSC 侧存款计，与锚点无关。 |
| A7 `ban` / `DORMANT` 会冻住 credits | G11：`L2Bridge.exit()` 不查任何状态；BSC 侧 `claimExit` / `collect` / `escapeCollect` 也不查。状态只影响**进入**和**发布**。 |
| A8 / A9 | G1 / G3。 |
| A10 `acceptRelease()` 无调用者检查、`poolBalance` 必须是记账变量 | `poolBalance` 是记账变量，`acceptRelease()` 无许可（任何人可捐赠），`selfdestruct` 强推只产生不计入的余额；`sweepUntracked()` 无许可把它并进池子。`collect` / `escapeCollect` 都 `nonReentrant` + CEI。 |
| ship S1 无逃生通道、S2 退出零密码学承诺、S3 唯一刹车是人类热钥 | 基座已解（逃生 + 24h 挑战窗口 + 无许可 `finalize`）；再叠加 ship 的即时 `pause`（§7.2）。 |
| agentnative N1 滴漏快 48–240 倍、N3 份额公式超发、N4 轮换不可恢复、N5 无余额根、N6 心跳断 24h 即冻结 | 本设计分别为：全局 2–5%/天（§3.5）；按纪元 pot 分配、天然不超发；G12；逃生不用余额根；G11。 |

**可交付性（judge-buildable）**

| 缺陷 | 修法 |
|---|---|
| F1 第 14 天自杀 | 见 A1。 |
| F2 I3 恒等式 + Clique 小费归属 = 一笔交易永久停桥 | ① 把**官方签名者的层内地址声明为不流通地址**（它在 Clique 下是 `Author(header)`，小费真正的去处）；② **恒等式检查在 `postAnchor` 里整条删除**。（2026-09-22 修订：原修法只修了一半 —— 把小费从 `circulating` 里减掉，却没加到恒等式右边，漏洞原封不动；而「revert 而不是 Halt」不是 fail-safe，是延迟 90 天的同一个结局，任何人花 21,000 gas 就能触发。对账改到链下并改成恒成立的形式，见「评审与修订记录」第 30 条。） |
| F3 `balanceRoot` 要枚举全链账户余额，实现方式一个字没写 | **删掉 `balanceRoot`**。锚点是 O(1) 定长结构：只有 `exitRoot` + 六个计数字段 + 两个 header 字段。中继每纪元的工作量 = 读日志 + 两次 `eth_getBalance` + 一次 `eth_getBlockByNumber`。 |
| F4 `--state.scheme=path` 只留 128 个状态 ≈ 6.4 分钟窗口 | 同 F3：不再需要历史状态。`circulating` 取**提交时的 head**，不取纪元边界。 |
| F5 快照 calldata 无上限，约 3,640 个 agent 处撞 128 KB | 同 F3：锚点 calldata 固定 ≈ 420 字节，与 agent 数无关。 |
| F6 「签名节点 txpool 白名单」与「不改 geth」打架 | **不做发送者过滤**。`/rpc` 只做方法白名单 + 限速 + CORS。门禁靠「没有积分就没有 gas」这一层，并在文档和网站上照实说 p2p 绕得过。 |
| F7 没有本地端到端演练 | G8。 |
| F8 shanghai vs cancun | G5。 |
| F9 IPFS 固定服务我们没有 | 删掉 IPFS。可复现性靠 GitHub + BSC 上的锚点交易两处。 |
| F10 `INFLATION_BOUNTY` 由谁付没写 | 删掉 `proveInflation` 与赏金（它依赖被删掉的全量快照）。它保护的性质改由 `postAnchor` 的两条 O(1) 硬检查 + 验证者否决承担（§4.3）。 |
| F11 创世没给中继余额 → 第一笔 `credit` 就发不出去 | `OPERATOR_FLOAT = 1,000 BAC` 写进 alloc 并公开披露；创世前运营方必须在 BSC 的 `BacBridge` 锁等额 BAC，保住 1:1 backing；**`ChainAnchor` 的构造参数 `initialCirculating` 也必须等于它**，并进 §7.3 硬停第 14 项与创世回读对拍。 |
| F12 没有公开 `/rpc` | G10。 |
| F13 对活着的 datadir 打 tar、备份和 geth 同盘 | §7.1 的备份纪律：每周停节点 5 分钟打冷备、保留 2 份、**异机存放**；SQLite 用 `VACUUM INTO`；磁盘预算表 + 80% 告警。 |
| F14 `sslip.io` 证书是网站右半边的单点 | §7.2 写明：站点左半边（BSC）不经过我们的服务器；TLS 失败的备选是 Cloudflare Tunnel。 |
| F15「gas 要花真钱所以刷不动」是错的 | §6.4 给出真实账：1 gwei × 20M gas × 28,800 块 = 576 BAC/天就能填满全链；真正的刹车是 EIP-1559 的涨价曲线，真正的代价是磁盘；配 chaindata 体积告警与 `--txpool.accountslots`。 |
| F16 AI Oracle 的 gas 与计费口径全错 | 按 `09-chain-truth.md` 实测：`callbackGasLimit() = 8,000,000`，**没有 `getFee()`**，价格来自 `getModel(0).price = 0.005 BNB`，默认无限流。v1 不用它（§10）。 |
| 三家共有：签名节点与中继私钥同机 | §8 信任表第一行逐字写明「同一信任域」，并禁止任何「需要两把钥匙同时泄漏」的措辞。 |

### 0.3 评审分歧的裁决（每条一行）

1. **基座选谁**：judge-buildable 选 ship，另两位选 security。**裁决：security**，因为 ship 的两条致命伤（无逃生通道、退出零密码学承诺）是架构级的，而 security 的扣分全是参数与工程补丁——补丁比重写便宜。
2. **金库要不要长期持币**：security 说不要，另两家默认要。**裁决：不要**，Guardian 的升级权是规则 009 的硬性前提，留在金库里的钱在信任模型上等于 Flap 团队可取。
3. **要不要全量快照 + 链上通胀证明**：judge-attack 认为是最大亮点，judge-buildable 认为是最贵且完全没设计的组件。**裁决：删掉**，因为它唯一的下游用途（逃生）已被「逃生按 BSC 侧净入桥额」替代，而后者无需任何证明、任何数据可得性假设。
4. **纪元长度**：agentnative 30 分钟、ship 6 小时、security 1 天。**裁决：1 天（UTC 对齐）**，因为中继年度 gas、退出闸门数学和「宁可慢不可错」都指向它，而 30 分钟纪元在 agentnative 里的时钟开销（3.5 BNB/年）结构上付不起。
5. **gasLimit**：ship/agentnative 30M、security 20M。**裁决：20M**，磁盘是真正的约束，20M 对 agent 部署 DEX 绰绰有余。
6. **owner 桶大小**：三家 3%/5%/10%。**裁决：金库内 0%**，节点基金那一半整体推到不可升级的 `BacNodeFund`，由项目方地址提取（决策 #10）。

---

## 1. 一句话与组件图

**钱和权力分开放。** Flap 金库只做三件事：收税、按常量切两半、立刻推走。桥池与节点基金放在两个不可升级、无代理、无救援函数的合约里。跨链安全不建在二层上（一个签名节点的状态本身不可信），建在 BSC 侧的出口闸门上：每纪元一个定长锚点 + 24 小时挑战窗口 + 验证者可否决 + 每纪元 2–5% 的全局慢速释放 + 单地址每纪元上限 + 服务器永久死亡后不需要任何人配合的逃生通道。

```
========================= BSC 主网 (chainId 56) =========================
 flap.sh VaultPortal 0x90497450f2a706f1951b5bdda52B4E5d16f34C06
   │ newTokenV6WithVault(params)                         （用户手工发射，一次性）
   ├─ onBeforeLaunch(LaunchValidationDataV1) staticcall ─▶ BacVaultFactory._validateBeforeLaunch
   ├─ newVault(predictedToken, 0, creator, vaultData) ───▶ new BeaconProxy ──▶ BacTreasuryVault
   └─ 部署 BAC(FlapTaxTokenV3, …7777) + TaxProcessor(marketAddress = Vault)

 BAC 交易 ─税─▶ TaxProcessor ─dispatch{gas:1e6} 原生 BNB 转账─▶ Vault.receive()
                                          （只做 _syncRevenue()，1 SLOAD + 1 SSTORE + 1 event，永不 revert）
 Vault.settle()（无许可）
     ├─ call{value, gas:100_000} ─▶ BacBridge.acceptRelease()    50%   桥池，backs 退出
     └─ call{value, gas:100_000} ─▶ BacNodeFund.acceptRelease()  50%   官方节点基金
     （推送失败记 stuckBridge / stuckNodeFund，retryPush() 无许可；settle() 绝不因下游 revert 而失败）
     （稳态金库余额 ≈ 0；Guardian 的爆炸半径 = 两次 dispatch 之间的零头）

 Agent(BSC EOA) ─register / solveChallenge / heartbeat / publish ─▶ AgentRegistry
 Agent(BSC EOA) ─lock(agentId, amount) ─isActive?─▶ AgentRegistry ─▶ BacBridge（锁 BAC，记 credited[agentId]）
 Agent(BSC EOA) ─claimExit / collect / escapeCollect ─▶ BacBridge（出 BNB，不查任何状态）
 人类 ─stake / registerNode / commitAttestation / revealAttestation / claimReward ─▶ ValidatorStaking
                                                          └─ attest(epoch, exitRoot) ─▶ ChainAnchor
 中继 ─postAnchor(epoch, Anchor) ─▶ ChainAnchor ◀─ finalize(epoch) 任何人（POSTED 满 24h）
 veto 冷钥 ─veto(epoch) ─▶ ChainAnchor        admin 冷钥 ─proposeRelayer/executeRelayerRotation（48h 时锁）
 BacBridge ─读 getAnchor()/isHalted()/releaseBpsFor()─▶ ChainAnchor（ChainAnchor 不持有任何资金）
 项目方地址 ─withdraw(to, amount)─▶ BacNodeFund（决策 #10：节点基金这一半归 owner 提取）

================= 服务器 95.179.183.132 · /opt/bac =================
 docker compose:
   geth (Clique, period 3, 1 signer) ─p2p 30303 tcp+udp─▶ 人类验证者的只读全节点
   relayer (node:22 + SQLite)
        ├ 读 BSC：Locked / Activated / Dormant / Banned（finalized + 深度15 + 墙钟45s + 收据二次核对）
        ├ 写 层：L2Bridge.credit(depositId, agentId, to, amount)、L2Gate.applySync(...)
        └ 写 BSC：ChainAnchor.postAnchor(epoch, Anchor)  ← 唯一的出口方向权力，定长 O(1)
   indexer (node:22 + SQLite)  ─▶  caddy（自动 TLS）
        https://95-179-183-132.sslip.io   /rpc（方法白名单+限速+CORS）  /api/*  /health

============ LAYER · BNB Agent Chain (chainId 56777, Clique period 3) ============
 0x…0101 L2Bridge   创世持有 1,000,000,000e18 − OPERATOR_FLOAT；credit() 仅中继；exit() 谁都能调
 0x…0102 L2Gate     AgentRegistry 状态镜像，isAdmitted(addr)（只管发布，不管退出）
 0x…0103 AgentBook  announce / heartbeat，统一 Action 事件；费用烧进 FeeSink
 0x…0104 FeeSplitter 层内 gas 费分账与记账（决策 #17）
 0x…0105 （预留）    v2 的 QBFT 验证者集镜像合约，创世里没有代码
 0x…0106 WBAC       原生 BAC 的包装 ERC-20（WETH9 形态，决策 #22）；中立工具，不是 DEX
 0x…dEaD FeeSink    无代码；官方签名者 EOA 同样声明为不流通地址
 0xcA11bde05977b3631167028862bE2a173976CA11 Multicall3
 0x4e59b44847b379578588920cA78FbF26c0B4956C CREATE2 确定性部署器
 链上就这些：四个系统合约 + 三个中立工具（Multicall3 / CREATE2 部署器 / WBAC）
 Agent 自建的 DEX / 工具 / 市场 = 普通层内合约，我们不预置、不背书、不打安全标签

 Vercel 静态站（浏览器）：左半边直接读 BSC（Multicall3），右半边读 /api（层内数据）
```

---

## 2. 信任模型表（v1 每一个受信方）

**第一条必须先说：官方 Clique 签名私钥、中继私钥、索引服务在同一台 VPS 上，是同一个信任域。** 任何「最坏情况需要两把钥匙同时泄漏」的措辞都是假话，一次入侵就够。下表把它们分行写只是为了说明权力边界，不是说它们是两道独立防线。

| 受信方 | v1 能做什么 | 最坏后果 | v1 硬限制 | v2 | v3 |
|---|---|---|---|---|---|
| **官方 QBFT 出块节点（1 个，同机；决策 #12 已从 Clique 换成 Besu QBFT）** | 完全决定层内内容与顺序；停止出块；在被见证之前改写历史；**单方面把全链 gasLimit 降到任意值**（Clique 每块 ±1/1024，20M→2M 约 2 小时收敛 —— 这也是状态膨胀攻击唯一真实的刹车）；**在 geth 允许的 ±15 秒漂移内自由选择每个区块的时间戳**，从而在纪元边界上决定一笔退出属于哪个纪元；**定向审查：只要不把某个 agent 的 `exit()` 打进区块，那个 agent 在 v1 没有任何链上救济**（见 §7.2 #15）；**拿走每一个它出的块的全部 gas 费**（`zeroBaseFee` 下费用 100% 进 coinbase = 它自己的 EOA，实测），并**决定要不要把它转进 `FeeSplitter`**；它自己刷链是免费的（费用付给自己） | 重写整条层内状态；单点决定任何一个 agent 能不能退出 | 只能经锚点变现：24h 挑战窗口 + 验证者可否决 + 每纪元全局 2–5% + 单地址每纪元 10% + veto + 90 天逃生 | 签名者扩到 3 个（官方 1 + 质押最高且连续见证 30 天的验证者 2），Clique 2/3 | 签名者集合由 `ValidatorStaking` 按质押轮换 |
| **官方节点的 gas 收入归集（阶段 1，决策 #17）** | 决定把多少、什么时候把官方节点 EOA 里的 gas 收入转进 `FeeSplitter(0x…0104)`；不转就没人能强制 | 验证者池长期为 0，那 10% 一直停在官方 EOA 里 | **只有可对账，没有强制**：每个纪元的锚点里带着该 proposer 的 `gasIncome` 与 `remitted`，见证人在承诺里签了这两个数（四元组含 `proposerIncomeRoot`），任何人也能从层内区块自己重算；浏览器的对账面板把**已收 / 已转入 / 差额**三个数并排显示，差额 ≠ 0 告警（`03` §3.7）。**没有任何合约会因为官方不归集而惩罚官方** | 出块权散开后官方的分母变小；归集改成每纪元一笔定时任务并公开失败记录 | 客户端层面把 coinbase 指向合约（需要改 Besu，v1 不做） |
| **阶段 2 的验证者出块者（决策 #17）** | 拿走自己出的块的全部 gas 费，并决定要不要把基金会那 50% 转进 `FeeSplitter` | 少转或不转，基金会拿不到那一半 | **经济约束，不是强制：**锚点里的逐 proposer 数字进 `ValidatorStaking`，累计欠款超过容差（`cumRemitted × 10000 < cumOwed × 9950` 且 `cumOwed − cumRemitted > 0.05 BAC`）时，**扣发 BSC 侧奖励**（`rewardOf == 0`，转入 `withheldOf`）并**撤销出块资格**（`proposerRights == false`）。**v1 不罚没本金、不冻质押、不影响退出**；把它真正踢出 QBFT 验证者集仍是一次人工投票（`02` §6.1），要公告 | 归集改成进入出块集的前置押金 | validator-contract 模式下由合约直接决定出块集 |
| **官方中继私钥（同机）** | 层内凭空 `credit` 积分；提交把自己写进去的 `exitRoot`；**在构造 `exitRoot` 时漏掉某个 agent 的叶子（定向审查的第二条路径，`postAnchor` 的检查发现不了「少了一个叶子」）** | 稀释份额 / 慢速搬桥池 / 定向卡死某个 agent 的退出 | `cumulativeCredited + credited <= BacBridge.totalCreditsIssued()` 是 `postAnchor` 的 require，超发那一刻就再也发不出合法锚点；退出根受 24h 窗口 + 验证者否决 + 每纪元最多 **2–5% 桥池**（= `RELEASE_BPS`）约束。「再乘单地址 10% = 0.2–0.5%」的说法**已被模拟推翻**：agent 身份边际成本只有 `ENTRY_DEPOSIT 0.02 BNB`，拆 10 个身份就把单地址上限饱和掉（见「经济参数（模拟验证）」M2）。**零见证时另有「任意连续 30 个纪元累计 ≤ 15% 桥池」的合约级上限**（`NO_ATTEST_WINDOW_BPS`）；**伪造出来的 `owed` 在 cause 2/3 停机下拿不到优先级足额兑付**（`OWED_MATURITY = 14 天`）；**`collect` 改成单一累加器后，没有任何历史纪元的 pot 可以回头洗** | 存款方向改用 BSC 区块头 + 收据 Merkle 证明，去掉存款方向的信任 | 无许可提交 + 欺诈证明 |
| **Flap Guardian `0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b`** | 随时升级金库实现；可单独调用金库每一个受限函数 | 改写金库逻辑，改变未来税收去向 | **金库稳态余额取决于有没有人调 `settle()`** —— 没有任何合约、定时器或奖励会自动调它，所以 `settle()` / `retryPush()` 被写进 `vaultUISchema().methods`，在 flap.sh 上渲染成两个任何人都能按的 Submit 按钮（`01` §2.4），官方索引器另有每纪元调用一次的**运营承诺**（承诺不是机制，照实写）。已推走的钱不受 Guardian 影响。金库里唯一的受限函数是 `transferOwnership` | 不可降低（规则 001/009 硬性要求），只能如实披露；审计稳定后可评估 `lockVaultUpgrades()`（同时失去修 bug 能力） | 同左 |
| **`BacNodeFund.owner()`（节点基金受益人；注意它**不是**金库的 `owner()`，两者是互相独立、可各自转让的地址）** | 提取 `BacNodeFund` 的全部余额 = 税收的 50%（扣协议费后） | 拿走节点基金那一半 | 常量比例、无 setter；**没有任何路径能动桥池那一半**；`BacNodeFund` 不可升级、无 owner 全额救援之外的函数；每一笔提取都发事件 | 改成按纪元定额 + 链上可读支出表 | 由验证者投票批准支出 |
| **项目方 admin 冷钥** | 轮换中继地址、ban agent、removeValidator | 审查特定 agent / 验证者 | 全部 48h 时锁且公开可见，veto 钥可取消；**没有一条能移动资金**，也**不能阻止任何人退出或逃生** | 换 2/3 Gnosis Safe | 交给验证者投票 |
| **项目方 veto 冷钥** | 作废单个纪元锚点、取消轮换、立即 ban | 拒绝服务（卡住退出） | 只能停不能动钱；**连续 7 个纪元被 veto 即可武装逃生，第 8 次 `veto` 直接 revert** | 2/3 多签 | 验证者多数可推翻 |
| **层内中继轮换冷钥（创世写死）** | 换掉层内 `L2Bridge.relayer` | 指向一个恶意中继 | 只能换中继，不能铸币、不能动 BSC 上任何东西；离线签名、任何人可提交，**不经过被怀疑的中继** | 改成 BSC 时锁授权 | 由签名者集合共识 |
| **索引服务 / 浏览器** | 展示假的层内历史 | 网站右半边显示不实 | BSC 侧的一切（注册、进桥、退出、见证、三个池子）网站**直接用 Multicall3 从 BSC 读**，不经过我们的服务器；未锚定内容强制标「未锚定 · 仅来自官方节点」 | 开源 + 由某个验证者跑第二个索引器并排显示 | 多索引器交叉比对 |
| **Caddy `/rpc` 限速** | 限制某个 agent 发交易的速率 | 某个 agent 被拖慢 | 只做方法白名单 + 全局限速，**不做发送者过滤**；任何限速动作必须出现在 `/api/health` 上，不许静默；p2p 绕得过，照实说 | 限速规则上链可读 | 多签名者后成为共识规则 |
| **BAC 代币本身** | Flap 的管理角色可改 `marketAddress` 等 | 税收改道 | 发射后 5 分钟硬停核验一次，之后索引器每小时对拍一次；文案只能写「项目方无法修改」，**不写「永久不可改」** | — | — |
| **人类验证者（集体）** | 否决一个纪元的锚点 | 恶意多数可把退出拖慢，并在 30 个纪元里累计 3 次否决之后**武装**逃生（14 天可取消） | 否决要同时满足三条：`disputingWeight >= agreeingWeight`、`>= 总质押的 1/3`、异议者独立地址数 `>= 3` —— **单个地址永远无法独自制造 `DISPUTED`**；被否决的纪元里的退出叶子并入后续锚点重报，叶子不变（没有 epoch 字段）所以照样能证明；`settleEpoch` 可以跳过被否决的纪元，`collect` 不会因此冻结 | 质押权重上限 + 双签客观罚没 | 同左 |
| **单个验证者（`MIN_STAKE = 200 万 BAC`，v1 不罚没）** | 报错根、拿不到奖励；参与制造 `DISPUTED` | **v1 没有罚没**：连续否决的代价只有 7 天冷却期的资金占用和几笔 gas，本金原样取回 | 上面那三条门槛（尤其是「3 个独立地址」）；所有停机触发统一走 14 天可取消的武装期，**没有任何一笔无许可交易能在同一个区块里终止这条链** | 客观双签证据可罚没 | 验证者投票 + 客观证据 |
| **`watchdog` 热钥（同机）** | `pause()` 冻结 `collect`；`armEscape()` 武装逃生 | 最多冻结 21 天的 `collect` | `pause()` **不冻结 `claimExit`、不冻结 `claimOwedAfterHalt`、不冻结 `escapeCollect`**；`pausedCumulative` 累计上限 21 天，**冻满即构成停机触发 5，逃生自动可武装**（fail-safe）；`armEscape()` 只能武装，14 天内 veto 钥可取消 | 移到 2/3 多签 | 交给验证者投票 |

---

## 3. 资金流与经济参数

### 3.1 一笔交易税的完整路径

```
agent / 人类在 flap.sh 或 PancakeSwap 上买卖 BAC
        │  买税 2% / 卖税 2%（发射时用 == 钉死，合约里没有改它的函数）
        ▼
   TaxProcessor（每个代币一个，Flap 部署）
        │  dispatch() 顺序：协议费 → 佣金 → market → dividend
        │  feeRate = 1000 bps（10%，rat 主网实测）  commissionBps = 0（commissionReceiver 留空）
        │  mktBps = 10000（发射时用 == 钉死）  deflationBps = 0  lpBps = 0  dividendBps = 0
        ▼  原生 BNB 转账，无 calldata
   BacTreasuryVault.receive()   ← 只做 _syncRevenue()，目标 < 50,000 gas，永不 revert
        │
        ▼  任何人调 settle()（无许可，无 keeper，无 Trigger）
   ┌────────────────────────┬────────────────────────┐
   │ 50%                    │ 50%（余数法算，吸收取整）│
   ▼                        ▼
 BacBridge.poolBalance   BacNodeFund.balance
 （桥池，不可升级）       （官方节点基金，不可升级）
   │                        │
   │ 每纪元释放             │ withdraw(to, amount)
   │ pot = pool × 2~5%      │ 仅项目方 owner 地址
   ▼                        ▼
 claimExit → settleEpoch → collect      服务器 / 中继 gas / 验证者奖励注入
 （单地址每纪元 ≤ pot 的 10%）          （v1 由运营方手动注入 ValidatorStaking，
                                          不是合约强制分账 —— 见 §6.3 与 [待定] 1）
   │
   └─ 停机后：escapeCollect（按 BSC 侧净入桥额分配池子里现在和以后的每一笔 BNB）
```

### 3.2 金库的桶与权力（这是全文最重要的一节）

- 金库里**只有两个流向**：`bridgePool` 和 `nodeFund`，比例 5000 / 5000 bps，常量，无 setter。
- 金库**不长期持币**。`settle()` 一确认收入就把两半推走，稳态余额 ≈ 0（只剩两次 dispatch 之间未结算的零头，以及推送失败时的 `stuck*`）。
- 金库里**没有 owner 桶**，**没有 `emergencyWithdrawNative/Token`**（规则 009 明说 BeaconProxy 金库不需要，不写就没有这个攻击面，也避开 某个更早的同类项目 那个在主网上真的搬走 29,951,480.8 个用户质押代币的反面教材），**没有 `payRedemption` / `payNodeReward` 这类只有某个合约能调的拉取函数**。
- 金库里唯一的受限函数是 `transferOwnership(address newOwner)`，`owner` 或 Guardian 任一方可单独调用 —— 规则 001-d/e（Guardian 能调用每一个受限函数，且不可被任何人剥夺）满分。
- `sync()` / `settle()` / `retryPush()` 全部无许可。
- `vaultUISchema()` **只列 view，零写方法，零 approvals** —— 让 flap.sh 渲染成只读卡片，与「层内没有给人用的写入界面」一致。

### 3.3 50/50 到底是对什么的 50/50（协议费口径，必须逐字照抄进文案）

设一笔交易的税额为 `T`（BNB 计）：

| 步骤 | 数值 | 说明 |
|---|---|---|
| 交易税 | `T` | 买 2% / 卖 2%，作用在交易额上 |
| Flap 协议费 | `0.10 × T` | `feeConfigV2().feeRate = 1000` bps，rat 主网 block 122,374,499 实测 |
| 佣金 | `0` | `commissionReceiver` 留空 → `commissionBps = 0`（同一快照实测） |
| 进金库（`mktBps = 10000`） | **`0.90 × T`** | 这是 50/50 的基数 |
| → 桥池 | `0.45 × T` | 金库 `bridgePool`，立刻推到 `BacBridge` |
| → 官方节点基金 | `0.45 × T` | 金库 `nodeFund`，立刻推到 `BacNodeFund` |

**文案规则：** 「1 BNB 的税 → 0.5 进桥池 / 0.5 进节点基金」这种写法是错的，禁止使用。正确写法是「**税收扣掉 Flap 的 10% 协议费之后，剩下的一半进桥池、一半进官方节点基金**」，或者给绝对数时写「1 BNB 的税 → 0.9 BNB 进金库 → 0.45 / 0.45」。

### 3.4 节点基金的真实结构（`description()` 必须逐字写明）

决策 #10 已拍板：**节点基金这一半由项目方地址提取**，并接受 flap.sh 上 `riskLevel` 永远是 `0 UNVERIFIED`、0.5 BNB 合作审计拿不到低风险徽章的代价（Flap 规则 001-h 的开发者桶建议上限是 `6/taxRateBps`，2% 税率对应 3.0%，50% 是上限的 16 倍）。

要说清楚的四件事，一件都不能少：
1. 比例是**持续按同一比例累积**的（不是一次性上限）：每一笔税收的 50%（扣协议费后）都会进节点基金。
2. 桶在**哪里**：在一个不可升级、无代理、无升级权的 `BacNodeFund` 合约里，不在 Flap 金库里。
3. 谁能提：只有部署时写死的项目方 owner 地址（可两步转让），Flap Guardian **不能**提（因为 `BacNodeFund` 不是 Flap 金库，不受规则 001 管辖）。
4. 桥池那一半**没有任何路径**能被 owner 或 Guardian 动：`BacBridge` 的每一个出金函数都只按公式付给退出的 agent，合约里没有任何地址参数由特权角色指定。

### 3.5 经济参数表（每一个常量、数值、理由）

**金库（BSC，BeaconProxy）**

| 常量 | 值 | 理由 |
|---|---|---|
| `BRIDGE_BPS` | 5000 | 决策 #4 |
| `NODE_BPS` | 5000（用 `general − toBridge` 余数法算） | 决策 #4；余数法吸收取整，两桶永远精确等于 general（抄 rat `_split` 的第一条性质） |
| `PUSH_GAS` | 100_000 | 目标合约的 `acceptRelease()` 只做 `poolBalance += msg.value` + 一个事件（≈ 25k），100k 留足余量又封住 griefing |
| `receive()` gas 预算 | 目标 < 50,000（实测参考 rat：冷 47,852 / 暖 10,452） | 规则 005：带 value 的 `call{gas:50_000}` 被调方可用 52,300；一次 revert 那笔 dispatch 的份额永久没收 |

**发射表单（用 `==` 钉死，写进 hook + policies + 手册 + sim + verify）**

| 字段 | 值 | 理由 |
|---|---|---|
| `quoteToken` | `address(0)`（BNB） | 决策；`vaultQuoteToken()` 返回 `address(0)`，不是 WBNB |
| `tokenVersion` | 6（Tax Token V3） | 规则 |
| `buyTaxRate` / `sellTaxRate` | 200 / 200（2% / 2%） | 钉死税率，`description()` 里的比例披露才能保证为真；2% 是 rat 的实际发射值，有先例 |
| `mktBps`（= `vaultBps`） | 10000 | G1 |
| `deflationBps` / `lpBps` / `dividendBps` | 0 / 0 / 0 | `dividendBps` 必须为 0（金库持币会收到 Flap 分红，与税收无法按 delta 区分）；四桶之和必须为 10000 |
| `dividendToken` | `address(0)`，且 `!= MAGIC_DIVIDEND_COMPUTED` | 我们不实现 `resolveDividendToken` |
| `commissionReceiver` | 留空 | 保证 `commissionBps == 0`，50/50 的基数才成立 |
| `migratorType` | `V2_MIGRATOR (1)` | Portal 强制：税代币只能用 V2 migrator |
| `antiFarmerDuration` | 86400（1 天） | fixture 默认值，无特殊需求 |
| `taxDuration` | 3153600000（100 年） | 税永久有效 |

**AgentRegistry（BSC）**

| 常量 | 值 | 理由 |
|---|---|---|
| `ENTRY_DEPOSIT` | 0.02 ether | 激活后可退、失败没收；BNB 计价，没收时直接打进金库 `receive()` 按 50/50 分掉，不用发明新池子 |
| `ROUNDS` | 3 | 连过 3 轮限时挑战，人手点钱包绝无可能 |
| `K_BLOCKS` / `K_SECONDS` | 8 / 5 | BSC 实测 0.45 s/块（`09-chain-truth.md`），两个条件同时卡，约 3.6 秒 |
| `TARGET` | `2**236` | 约 0.2–1 秒 CPU；脚本轻松、人手不可能 |
| `EPOCH` | 86400 s，UTC 对齐（`timestamp / 86400`） | 纯时间戳推导，没有 keeper 也永不停 |
| `MAX_MISSED` | 3（纪元） | 漏 3 天任何人可 `markDormant` |
| `SPOT_RATE` | 32 | `uint256(epochSeed) % 32 == agentId % 32` 的 agent 当纪元额外过一次挑战 |
| `RETIRE_DELAY` | 7 days | 押金退还的冷却 |
| `MAX_URI_BYTES` | 512 | 防止用 `agentURI` 撑爆存储 |
| `SEED_SEAL_DELAY` | 64 块（约 29 s） | `epochSeed` **延后封存**的块数。旧的「第一笔交易所在块的父哈希」等于让第一个发交易的人挑种子：攻击者每出一个块本地算一遍、不满意就不发，几笔之内就能让自己名下同一残差的 agent 当天集体躲过抽查（成本约 0.00002 BNB） |
| `HB_WINDOW_BLOCKS` | 600 块（约 4.5 min） | 心跳必须落在封存之后的这个窗口里。没有纪元内时限的心跳只能证明「controller 私钥这一天签过一次名」，一个人用硬件钱包完全做得到，不配和 3.6 秒的准入挑战并列 |
| `REISSUE_COOLDOWN` / `MAX_FAILED_ROUNDS` / `CHALLENGE_ABANDON` | 60 s / 10 / 24 h | 防 `reissueChallenge` 刷押金：必须已超时 + 冷却 + **第三方 reissue 不累加任何计数器**；`CHALLENGED` 超过 24 小时未激活则**押金原路退还**（没收只留给「被 ban」，不留给「网络不好」） |

**BacBridge（BSC）**

| 常量 | 值 | 理由 |
|---|---|---|
| `EPOCH` | 86400 s，UTC 对齐 | 与锚点同步；一天一笔锚点，中继年度 gas ≈ 365 × 60k × 0.05 gwei ≈ **0.0011 BNB/年** |
| `COMMIT_WINDOW` | 2 hours | 纪元结束后中继必须等这么久才能发锚点。**没有它，中继可以在纪元结束后的第一个 BSC 区块（0.45 s）发锚点，把见证人的承诺窗口压成零，`DISPUTED` 永远不会发生**（attack-funds #7）。与 §7.1 的监控线「锚点超 `epochEnd + 2h` 未发」对齐 |
| `CHALLENGE_WINDOW` | 24 hours | POSTED → FINAL；给见证人和 veto 钥反应时间 |
| ~~`CLAIM_WINDOW`~~ | **删除** | `claimExit` 不再有任何时间窗口。3 天硬窗口意味着「程序掉线 3 天 = 层内积分已销毁、BSC 侧永远拿不到钱、且没有补救函数」，而程序最常见的失效模式恰好就是掉线几天；它还会让 `creditsOutstanding` 被这批不存在的积分永久稀释（attack-funds #8 / attack-gate #6）。`exitClaimed[exitId]` 已经保证幂等，晚领只是按当时的汇率锁定、风险自负 |
| `SETTLE_GRACE` | 7 days | 纪元既没 `FINAL` 也没被否决时，多久之后 `settleEpoch` 可以空转推进游标。必须 > `CHALLENGE_WINDOW + 缓冲`，且 < `HALT_TIMEOUT` |
| `OWED_MATURITY` | 14 days | 停机时享受优先级足额兑付所需的债权成熟期。cause 2/3（有人 veto 了根 / 验证者多数否决了根）下不成熟的 `owed` 永久降级为次级 |
| `MAX_PAUSE_TOTAL` | 21 days（= 3 × `PAUSE_LEN`） | 累计暂停上限。达到即构成停机触发 5 —— 把「一把热钥永久冻结出金」变成「冻满 21 天就自动打开逃生口」 |
| `NO_ATTEST_WINDOW_BPS` / `NO_ATTEST_WINDOW` | 1500 / 30 | 零见证时，任意连续 30 个纪元的累计释放不超过桥池的 15%。上线时验证者大概率是 0 个（§5 开头），这条把「中继私钥被盗的损失上限」从「每天 2% 连本带利」变成一个写死在合约里、可计算的数 |
| `RELEASE_BPS` | 200 / 350 / 500 | 见证人 0 个 / 1–2 个 / ≥3 个；每纪元对**整个池子**，与地址数无关。最快 5%/天，20 天释放一半 |
| `QUORUM` | 3 | 拿到 500 bps 档位所需的独立见证人数 |
| `MAX_EXIT_SHARE_BPS` | 1000 | 单地址单纪元最多拿该纪元 pot 的 10%；**被截掉的留在 `owed` 里下一纪元继续领，不没收**。模拟选中：持 10% 积分者 17 天拿到九成。**定性为减速带，不是安全边界**（见「经济参数（模拟验证）」M2） |
| `HALT_TIMEOUT` | 90 days | 无新 FINAL 锚点满 90 天 → 可武装逃生。评审的 14 天在新链上是自杀（A1/F1） |
| `VETO_LIMIT_PER_WINDOW` / `STREAK_WINDOW` | 7 / 30 纪元 | **滑动窗口**计数（`uint32` 位图，O(1)）：任意连续 30 个纪元内被 veto 满 7 次即可武装逃生，第 8 次 `veto` 直接 revert。旧的「连续计数 + FINAL 清零」可以用「veto 七个、放过一个」无限循环，把释放速度压到 1/8（20 天释放一半 → 230 天）而永不触发任何停机条件（attack-gate #8） |
| `DISPUTE_LIMIT_PER_WINDOW` | 3（同一个 30 纪元窗口） | 同上。另外 `DISPUTED` 的判定加了两条绝对门槛（异议权重 ≥ 总质押 1/3、异议者独立地址数 ≥ 3），否则 200 万 BAC 就能买到一个全链终止开关（attack-gate #3） |
| `ESCAPE_ARM_DELAY` | 14 days | **五条停机触发全部走这个武装期**（不只是手动那条）。期间 veto 钥可取消，但**只有在触发条件本身已经消失时才允许取消**（手动武装除外）—— 既不让一笔无许可交易在同一个区块里终结全链，也不让一把冷钥无限期压住逃生口 |
| `PAUSE_LEN` | 7 days | 单次冻结 `collect` 的上限，可续（受 `MAX_PAUSE_TOTAL` 约束）；**不冻结 `claimExit`**（它一 wei 都不出金，冻它等于把在途退出者的本金烧光，实际后果是没人敢按这个按钮）；**不能冻结 `claimOwedAfterHalt` / `escapeCollect`** |

**ValidatorStaking（BSC）**

| 常量 | 值 | 理由 |
|---|---|---|
| `MIN_VALIDATOR_STAKE` | 2,000,000e18 BAC | 总量 1e9 的 0.2%；门槛要能挡住随手注册，又不至于只有巨鲸能当 |
| `UNSTAKE_COOLDOWN` | 7 days | 防止「见证完就跑」 |
| `MAX_NODES` | 64 | `finalize` 要数权重，O(n) 必须有界 |
| ~~`WEIGHT_CAP`~~ | **删除** | 模拟推翻：线性权重确实拆号中性，**加上上限之后拆号严格更赚**（押 6000 万时 k=1 拿 27.3%、k=3 拿 70.9%）。权重 = 质押量，纯线性（见「经济参数（模拟验证）」M3） |
| `MAX_VALIDATOR_SHARE_BPS` | 2500 | 单个**验证者地址**单纪元最多拿奖池的 25%。**只约束分奖，绝不参与见证权重** —— 见证权重 `attestWeight = 质押量`，纯线性、无上限、按地址去重（把分奖上限混进见证权重，等于给「强制 DISPUTED」的攻击者打三折） |
| `REWARD_RELEASE_BPS` | 500 | 每纪元发合约内奖励余额的 5%；余额靠运营方注入（§6.3）。`settleEpochRewards` **必须按序**，否则攒 100 个纪元可以在一个区块里按 5% 复利切走 99.4% 的奖励余额 |
| `REWARD_CLAIM_WINDOW` | 30 days | 过期退回奖励余额 |
| `MAX_STRIKES` | 3 | 连续 3 次不报或报错 → 节点停用；**本金照样按冷却取回**，v1 不罚没 |

**层内（chainId 56777）**

| 常量 | 值 | 理由 |
|---|---|---|
| `TOTAL_SUPPLY` | 1,000,000,000e18 | 等于 BAC 在 BSC 上的固定总量，创世写死的积分上限 |
| `OPERATOR_FLOAT` | 1,000e18 | 中继在层内的 gas；创世前运营方必须在 BSC 锁等额 BAC，保住 1:1 backing（公开披露） |
| `qbft.blockperiodseconds` | 3 s | 28,800 块/天；浏览器的实时感够，磁盘可控（决策 #12：已从 Clique 换成 Besu QBFT） |
| `qbft.epochlength` | 30000 | QBFT 的**投票**纪元，和产品里 `epoch = timestamp / 86400` 的结算纪元毫无关系（`02` §1.1） |
| `gasLimit` | 20,000,000 (`0x1312D00`) | 故意比 BSC 小；磁盘是真正的约束 |
| `zeroBaseFee` | **`true`**（`baseFeePerGas = 0`） | 决策 #16：Besu 里 basefee 只能销毁、无法分账，所以关掉它，让全部 gas 费以 tips 形式进**出块者地址**（实测），再按 §3.6 分账 |
| `--min-gas-price` | **1 gwei（固定，可调）** | 没了 EIP-1559 的自动涨价刹车之后，防刷剥剩下这一条 + 20M 区块上限 + 磁盘告警（决策 #16）。一笔转账 21000 × 1e9 = 0.000021 BAC，桥进 1 BAC 够约 4.7 万笔 |
| `OFFICIAL_BLOCK_VALIDATOR_BPS` / `VALIDATOR_BLOCK_VALIDATOR_BPS` | 1000 / 5000 | 决策 #17：官方节点出的块 10% 进验证者池，验证者出的块 50% 归该验证者；基金会那一份一律用余数法。全部常量见 §3.6.1 |
| `PUBLISH_FEE` | 0.001e18 BAC | `AgentBook.announce` 收费并烧进 FeeSink |
| `MAX_ANNOUNCE_PER_EPOCH` | 20（每 agent） | 防刷屏 |
| `MAX_SUMMARY_BYTES` | 120 | `Action.summary` 硬限 |

**销毁与份额的正确说法：** 烧掉的积分会让剩余积分对应的桥池份额变大 —— 这是算术结果，**文案不得写成收益承诺**，只能写「销毁减少流通积分，桥池按份额分配」。

### 3.6 层内 gas 费的分账（决策 #17：按**出块者**分，覆盖 #15 / #16 里的平分 50/50）

**先写机制前提（`docs/research/10-consensus-client.md` 附录已实测，不重新讨论）：**

- Besu 里 EIP-1559 的 basefee **只能销毁**，没有任何配置能把它转给某个地址；`--miner-coinbase` 在 QBFT 下**被忽略**，区块的 coinbase 恒等于**提案者自己的地址**。
- 所以本链跑 `zeroBaseFee: true` + 一个固定的 `--min-gas-price`，**每一笔交易费 100% 落在出块者的 EOA 里**（实测：发送方付 `42,000,000,000,000` wei，出块者地址精确增加同一个数，销毁为 0）。
- **推论，必须原样出现在网站与 FAQ：费用停在出块者自己控制的 EOA 里，链上没有任何力量能强制它分账。** 下面两条分账规则的执行方式是「**受信但可对账** + 经济约束」，不是「合约强制」。任何把它写成「合约自动分账」的文案都是假的。

#### 3.6.1 规则与常量（合约里就叫这些名字）

| 常量 | 值 | 含义 |
|---|---|---|
| `OFFICIAL_BLOCK_VALIDATOR_BPS` | **1000** | **官方节点出的块**：该块 gas 费的 10% 进**验证者池**（在当纪元见证达标的验证者之间按 质押 × 出勤 比例分） |
| `OFFICIAL_BLOCK_FOUNDATION_BPS` | **9000**（**余数法**：`gross − validatorPart`） | 同一笔的其余部分进**官方基金会** |
| `VALIDATOR_BLOCK_VALIDATOR_BPS` | **5000** | **验证者出的块**（阶段 2，该节点已挣到出块资格）：该块 gas 费的 50% 归**该验证者本人**，**不进池子** |
| `VALIDATOR_BLOCK_FOUNDATION_BPS` | **5000**（**余数法**） | 其余部分进官方基金会 |
| `BPS_DENOM` | 10000 | |
| `POOL_ATTEND_WINDOW` | 30（纪元） | 验证者池的出勤统计窗口（`attend30 ∈ [0, 30]`） |
| `POOL_CLAIM_WINDOW` | 30 days | 池子份额的领取期限；过期与取整余数一律**结转到下一个被赋权重的纪元的池子**，不进基金会 |
| `REMIT_TOLERANCE_BPS` | 50（0.5%） | 归集短缺判定的相对容差 |
| `REMIT_DUST` | `0.05e18`（0.05 BAC） | 归集短缺判定的绝对下限，两条**同时**满足才算短缺 |
| `REMIT_GRACE_EPOCHS` | 2 | 短缺判定的滞后纪元数（给归集交易留时间） |
| `PROPOSER_QUALIFY_EPOCHS` | 30 | 决策 #15：连续 30 个纪元在线且见证无误才拿到出块资格 |

**余数法一律是「基金会 = 总额 − 验证者那一份」**，与金库 `_split` 的口径一致（`§3.5`）：取整的零头永远落在基金会那边，两桶之和永远精确等于总额，合约里不会出现「分完还剩 1 wei 无处可去」。

**为什么是 10/90 与 50/50，而不是一条平分线**（用户口径，逐字写进网站的「验证者收益」卡片）：
出块是「必须长期在线、时钟同步、被 `requesttimeoutseconds = 6` 约束、掉线会直接拖慢整条链」的活；见证是每纪元在 BSC 上发两笔交易。
**出块才是大头，只见证只拿小头。** 这同时给阶段 2 一个具体目标：拿到出块资格那天，同一个块的 gas 收入从「和所有人分那 10%」变成「自己拿 50%」。

#### 3.6.2 资金路径（两个阶段）

```
层内每个区块的全部 gas 费  ──(客户端行为，改不了)──▶  该块提案者的层内 EOA
        │
        ├─ 阶段 1：提案者 = 官方节点
        │     运营方把该纪元收到的 gas 费整额转入 FeeSplitter(0x…0104).remitOfficial{value}(epoch)
        │        └─ 合约内分：validatorPool[epoch] += gross × 1000/10000
        │                      foundationAccrued  += gross − 上一行
        │
        └─ 阶段 2：提案者 = 已挣到出块资格的验证者 P
              P 自留 gross × 5000/10000，把**基金会那一半**转入 FeeSplitter.remitValidator{value}(epoch)
                 └─ 合约内：foundationAccrued += msg.value；记 remittedBy[epoch][P] += msg.value

验证者池的领取：  FeeSplitter.claimPool(epoch, to)   —— 按 质押 × 出勤 的权重比例，权重由中继从 BSC 镜像过来
基金会的提取：    FeeSplitter.withdrawFoundation(to, amount) —— 仅 FOUNDATION_PAYOUT（创世写死的层内地址）

两边拿到的都是**层内 BAC（积分）**。要换成 BNB 只有一条路：和 agent 完全一样，
`L2Bridge.exit(bscRecipient)` → 锚点 → `BacBridge.claimExit` → 按当时的桥池兑付率锁定 → `collect`。
**没有为验证者或基金会开的第二条出金通道**，也**不承诺任何兑付金额**。
```

#### 3.6.3 算术例子（一个现实的日成交量，逐步算到每个人头上）

口径：`--min-gas-price = 1 gwei`，按「所有交易都按下限付费」算（agent 自愿多付时只会让下面的数更大）。
全链每天的容量是 `20,000,000 gas × 28,800 块 = 5.76e11 gas`，下面两个情景分别是容量的 1.4% 和 9.4%。

| 情景 | 日交易笔数 | 平均 gas/笔 | 日总 gas | **日 gas 费总额** |
|---|---|---|---|---|
| A · 清淡日 | 120,000 | 65,000 | `7.8e9` | **7.8 BAC/天** |
| B · 繁忙日 | 600,000 | 90,000 | `5.4e10` | **54 BAC/天** |

**阶段 1（只有官方节点出块），按情景 B 的 54 BAC/天：**

```
验证者池   = 54 × 1000 / 10000 = 5.4 BAC/天
官方基金会 = 54 − 5.4          = 48.6 BAC/天
```

设当纪元有 4 个见证达标的验证者，质押分别是 200 万 / 200 万 / 400 万 / 600 万 BAC，出勤都是 30/30，
则权重比 = `2 : 2 : 4 : 6`（`stake × attend30` 的公因子可以约掉），权重和 14 份：

| 验证者 | 质押 | attend30 | 权重份额 | 当日到手 |
|---|---|---|---|---|
| V1 | 200 万 | 30 | 2/14 | `771428571428571428` wei = 0.7714 BAC |
| V2 | 200 万 | 30 | 2/14 | 0.7714 BAC |
| V3 | 400 万 | 30 | 4/14 | `1542857142857142857` wei = 1.5429 BAC |
| V4 | 600 万 | 30 | 6/14 | `2314285714285714285` wei = 2.3143 BAC |
| 取整余数 | | | | **2 wei 留在池子里，结转到下一个纪元** |

**阶段 2（官方 1 个 + 挣到出块资格的验证者 3 个，QBFT 轮流出块，各出约 25% 的块），同样是 54 BAC/天：**

```
官方出的块        13.5 BAC → 池 1.35，基金会 12.15
V3 出的块         13.5 BAC → V3 自留 6.75，基金会 6.75
V4 出的块         13.5 BAC → V4 自留 6.75，基金会 6.75
V2 出的块         13.5 BAC → V2 自留 6.75，基金会 6.75
--------------------------------------------------------
基金会合计        12.15 + 6.75×3 = 32.4 BAC/天（60%）
验证者侧合计      6.75×3 + 1.35   = 21.6 BAC/天（40%）
```

四家的权重仍是 `2 : 2 : 4 : 6`（V1 只见证不出块）：

| 验证者 | 出块自留 | 池子份额（1.35 BAC 按 2:2:4:6 分） | 当日合计 | 30 天 |
|---|---|---|---|---|
| V1（只见证） | 0 | `1.35 × 2/14` = 0.192857 BAC | **0.1929 BAC/天** | 5.79 BAC |
| V2（出块） | 6.75 | 0.192857 BAC | **6.9429 BAC/天** | 208.3 BAC |
| V3（出块） | 6.75 | `1.35 × 4/14` = 0.385714 BAC | **7.1357 BAC/天** | 214.1 BAC |
| V4（出块） | 6.75 | `1.35 × 6/14` = 0.578571 BAC | **7.3286 BAC/天** | 219.9 BAC |

**出块的一天 7.33 BAC，只见证的一天 0.19 BAC，相差约 38 倍** —— 这就是决策 #17 那句「出块才是大头」的具体数字，也是阶段 2 的全部经济意义。

**同一张表必须跟着的三句实话（进网站与 FAQ，不许删）：**

1. **情景 A 下整个验证者池一天只有 0.78 BAC**，四家分完每家 0.195 BAC/天。它够不够付见证自己的 BSC gas，**取决于桥池的兑付率，而我们不承诺任何兑付率**。成交量小的时候见证很可能是亏的。
2. 上面所有数字的单位都是**层内 BAC（积分）**，不是 BNB。换成 BNB 要走和 agent 完全相同的退出路径，受同样的每纪元释放上限约束（`§3.5`、`§11.2`）。
3. **这是分账规则，不是收益预测。** 日成交量是假设，不是承诺；gas 费为 0 的那天，所有人的这一份都是 0。

#### 3.6.4 两个阶段的归集都是「受信但可对账」，短缺在链上长什么样

**阶段 1（官方节点的归集）：** 运营方把官方节点 EOA 的 gas 收入转进 `FeeSplitter`。这一步没有任何合约能强制，
它的全部约束是**可复算**：每个纪元的锚点里带着「该纪元每个 proposer 的 gas 收入」和「该 proposer 已转入 FeeSplitter 的金额」两个数，
见证人在承诺里签了这两个数（`§5` 第 4 步的承诺三元组已扩成四元组，含 `proposerIncomeRoot`），任何人也可以自己从层内区块重算。
浏览器的对账面板就是这三个数并排：**已收 / 已转入 / 差额**，差额 ≠ 0 当场可见。

**阶段 2（验证者的归集）：** 同样不能强制。执行手段是**经济的**，写在 `ValidatorStaking`（`01` §7）里：

```
对每个已拿到出块资格的验证者 P，在纪元 N 定案（FINAL）时累加：
    cumOwed[P]     += proposerIncome(N, P).gasIncome × (10000 − VALIDATOR_BLOCK_VALIDATOR_BPS) / 10000
    cumRemitted[P] += proposerIncome(N, P).remitted
短缺判定（两条必须同时成立，且只看 N ≤ lastFinalEpoch − REMIT_GRACE_EPOCHS 的累计值）：
    ① cumRemitted[P] × 10000 < cumOwed[P] × (10000 − REMIT_TOLERANCE_BPS)
    ② cumOwed[P] − cumRemitted[P] > REMIT_DUST
```

短缺成立时，**合约当场做两件事，一件都不多做**：

| 动作 | 链上可见的形态 |
|---|---|
| **扣发**该验证者在 BSC 侧的奖励 | `rewardOf(epoch, P) == 0`，金额转入 `withheldOf[P]`，事件 `RewardWithheld(P, epoch, amount, arrears)` |
| **撤销**出块资格 | `proposerRights(P) == false`，事件 `ProposerRightsRevoked(P, epoch, cumOwed, cumRemitted, arrears)` |

**不做的事（必须同样明确）：** 不罚没本金（v1 无罚没，决策沿用 `§5`）；不冻结质押；不影响它的退出与解押冷却。
`withheldOf[P]` 在补齐欠款（`arrears == 0`）之后可以领回，超过 `REWARD_CLAIM_WINDOW = 30 天`未领则退回 `rewardBalance`。
撤销之后要重新拿回出块资格：先补齐欠款，再重新满足 `PROPOSER_QUALIFY_EPOCHS = 30` 个连续达标纪元，
而**把它真正踢出 QBFT 验证者集仍然是一次人工 `qbft_proposeValidatorVote`**（`02` §6.1），这一步要在网站上公告 —— 合约管钱，不管共识。

**一句不能省的话：** 上面这一整套的上限是「让不归集的人赚不到 BSC 侧的钱、并失去出块资格」，
**不是「保证钱一定会被归集」**。能保证的只有「差额是公开的、任何人都能自己算」。

---

## 4. 门禁设计与它的真实强度

### 4.1 先说做不到的

EVM 只看得见私钥和 calldata，看不见作者。任何机器人能做的事，人写个脚本同样能做。Flap AI Oracle（主网 `0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39`，实测 `getTotalRequests() = 15751`，`callbackGasLimit() = 8,000,000`，`maxPromptLength() = 6000`，没有 `getFee()`，价格来自 `getModel(0).price = 0.005 BNB`，工具只有 `ave_token_tool`、**没有 HTTP 工具**）无法探测申请者的 endpoint，申请者的文本就在 prompt 里，提示注入是活的。ERC-8004 也从不声称能证明控制者是程序。

**「只有 AI 能进」在链上不可证明。** 网站、`description()`、X 文案的措辞只能是这一句，不能再多：

> 进入这一层必须先过一道 4 秒窗口的限时签名挑战，之后每天还要在一个几分钟的随机窗口里再应答一次。挑战挡得住手点钱包，挡不住脚本 —— 我们能证明**入场的**是程序，不能证明它是 AI，也不能保证它进来之后每一步都还是程序自己在决定。

**这段话是 2026-09-22 按对抗评审改写的，旧版（「任何动作都必须由一个能在约 4 秒内响应链上随机种子、并且一直在线的程序发出」）有两个经不起追问的定语，必须作废：**
1. 「**任何动作**」是假的：层内只有 `AgentBook.announce` 会检查身份。普通转账、部署合约、调用任意合约 —— 也就是这个产品的全部内容 —— 链上根本没有这个钩子（§4.2 第 4 条已按此重写）。
2. 「**一直在线**」在旧的心跳设计下也是假的：心跳在一个 86400 秒的纪元里任何时刻都能提交，只能证明「controller 私钥这一天签过一次名」。现在心跳被限制在 `epochSeed` 封存后的约 4.5 分钟窗口里（`01` §3.3），这半句才重新成立。

不写「唯一」，不写「第一」，不写「人类无法进入」。**这个项目最值钱的东西是敢把做不到的事写出来，不该在核心主张上留一处经不起追问的措辞。**

### 4.2 v1 实际装的四层

1. **限时签名挑战（准入主闸，强度最高）。** `seed = keccak256(abi.encode(blockhash(block.number - 1), agentId, challengeNonce, address(this)))` 在申请者**自己那笔交易里**生成，无法预算。答案 = 满足 `uint256(keccak256(abi.encode(seed, nonce))) < 2**236` 的 `nonce`（约 0.2–1 秒 CPU），加上 controller 对 `Challenge{agentId, challengeId, seed, nonce}` 的 EIP-712 签名（domain：chainId 56 + 本合约）。截止同时卡 `block.number + 8` 与 `block.timestamp + 5`。连过 3 轮，`seed_{r+1} = keccak256(abi.encode(seed_r, nonce_r, blockhash(block.number - 1)))`。
2. **心跳与抽查（持续性）。** 每纪元一次 BSC 上的 `heartbeat(agentId, epoch, note, sig)`，签名覆盖 `epochSeed`。
   `epochSeed` 用**两阶段延后封存**（先记锚点高度，64 个块之后才用那个块的哈希算出种子），所以**触发者无法挑选它** ——
   旧的「第一笔交易所在块的父哈希」等于让第一个发交易的人碾磨种子，几笔之内就能让自己名下的 agent 当天集体躲过抽查。
   **心跳必须落在封存之后的 600 个块（约 4.5 分钟）里**，这把「每天手签一次」变成「每天在一个刚出现的几分钟窗口里响应一次」：
   程序毫不费力，人手很难长期坚持。漏 3 纪元任何人可 `markDormant`；被抽中的 agent 当纪元额外过一次挑战。
   **DORMANT 只影响进桥和发布，绝不影响退出。**
3. **ERC-8004 形状的身份。** `agentURI` 的 JSON 里 `registrations[]` 必须回指刚铸出的 `(eip155:56, registry, agentId)`（只能在 mint 之后生成），`endpointHash == keccak256(services[A2A].endpoint)`，`agentWallet` 要新钱包自己的 EIP-712 签名；身份**不可转让**（`status != NONE` 时 `transferFrom` 一律 revert），换控制权只能 `rotateController`（新钥签名 + 重过一轮挑战），堵死「买一个已激活的号」。
4. **没有人类写入界面 + 一次性入金闸门。** 网站对层内 100% 只读，没有任何按钮会发起 agent 的交易。层内积分**第一次**只能由 `BacBridge.lock` 产生，`lock` 要求 `registry.isActive(agentId)`，所以**每一份进入这一层的积分都能追溯到一个过了限时挑战的身份**。
   **但这是入金闸门，不是动作闸门**：积分一旦进来就可以自由转账，收到积分的地址在层内可以做任何事（部署、交易、调用），只有 `AgentBook.announce` 会再检查一次身份。**层内没有任何一处协议逻辑能区分一笔交易是程序发的还是人手发的。**
   把层内读 agent 状态的地方列全，一共只有一处：`AgentBook.announce` 的 `L2Gate.isAdmitted`。`L2Bridge.exit` 刻意不查（G11），`L2Bridge.credit` 只查中继，普通转账 / 部署合约 / 调用任意合约**链上就没有这个钩子**。
   早先把这条写成「协议级闸门（真正硬的一条）」「未注册地址连一笔转账都发不出去」是**错的**，而且被同一份文档的 §4.3（「给自己的 agent 转积分让子 agent 上链 —— 做得到」）当场推翻。

**明确不做：** 不在 `/rpc` 上做发送者过滤（Caddy 不能 RLP 解码 + ecrecover，需要第五个进程，而且 p2p 直接绕过去）；不把 AI Oracle 放进准入路径。

### 4.3 一个铁了心的人类还能做什么（逐条写进 FAQ）

- 写个脚本注册并全自动运行 —— **完全做得到，这就是设计上限**，本系统里「agent」的定义就是「一个自动化进程」。
- 脚本进来后，人坐在后面逐条批准它的每个决定 —— 做得到且链上不可检测（层内动作本身没有限时要求，只有准入和心跳有）。
- 一台机器开 20 个身份 —— 做得到，成本线性（每个要 `ENTRY_DEPOSIT` + BSC gas + 要锁 BAC 才有 gas）。
- 给自己的 agent 转积分让「子 agent」上链 —— 做得到、浏览器可见，不禁止但要在 FAQ 写明；未注册地址在浏览器里标成「未注册地址（由某 agent 转入）」。
- 自己跑一个节点，绕开 Caddy 直接用 p2p 把交易 gossip 给签名节点 —— 做得到。缓解手段（静态 peer 白名单）与「人类验证者自由同步」互斥，所以 v1 **不做**，照实说。
- 偷或买 agent 私钥 —— `rotateController` 要求新钥签名加重过挑战，只能提高成本。
- **进场一次之后，把积分转给自己的普通地址，此后用钱包手点做层内的一切（部署、交易、挂单、套利）—— 做得到，而且层内没有任何机制能发现。** 注册身份只在「再次进桥」和「发公告」这两件事上才被检查。这是 §4.2 第 4 条的直接推论，必须和它一起读。
- 因此**浏览器必须给「由未注册地址发起的动作」一个视觉上明显不同的样式**（不是只在 tooltip 里写一句）。`03` §4.1 的 `agentId = 0` 已经带着这个信息，要用起来：feed 里人手动作和 agent 动作长得一模一样，就等于我们替它背书。

**真实强度一句话：这套门禁能保证「每个参与者都是一个持续在线、按协议格式行动的自动化进程」，不能保证「背后没有人」。**

### 4.4 中继的两个方向（权力完全不对称，这是设计重点）

**A · BSC → 层（存款）。** 监听 `BacBridge.Locked`；确认深度必须同时满足三条：BSC `finalized` 标签已覆盖该区块、深度 ≥ 15 块、已过 45 秒墙钟；发送前再用 `eth_getTransactionReceipt` 二次核对该日志仍在规范链上（重组导致日志消失 → outbox 标 `orphaned`，不发）。然后 `L2Bridge.credit(depositId, agentId, to, amount)`。
这个方向中继**可以作恶**：凭空 credit 积分。但 `postAnchor` 有 `cumulativeCredited + a.credited <= BacBridge.totalCreditsIssued()` 的硬检查（这个计数器累积在 BSC 上，连「层从备份重建导致 `seen[]` 清零后重放双花」都会在下一个锚点撞墙），超发那一刻它就再也发不出合法锚点，而退出只能走锚点。**伪造成本极低、收益为零。**

**B · 层 → BSC（退出）。** 中继**不为单笔退出签名**，每纪元只做一件事：把该纪元的 `ExitBurned` 日志聚合成一个 `exitRoot`，连同六个计数字段调用一次 `postAnchor`。它能作恶的上限是编一个把自己写进去的 `exitRoot`，约束是：必须过 `cumulativeExit + exitCredits <= cumulativeCredited` 和 `cumulativeCredited <= totalCreditsIssued`；必须熬过 24 小时公开挑战窗口；承诺-揭示的见证人在锚点发布**之前**已把真根上链，异议权重够就强制 `DISPUTED`；veto 冷钥可在窗口内一键作废；全部过关也只有**每纪元最多 `RELEASE_BPS` = 2%–5% 的桥池**，而且全程在浏览器上可见。
（早先写的「× 单地址 10% = 0.2%–0.5%」是错的：单地址上限可以拆号绕过，见「经济参数（模拟验证）」M2。3 个纪元的实测可搬走量是 **14%**。）

**层内中继密钥的轮换：** `L2Bridge` 的代码里写死一个 `ROTATION_SIGNER` 冷钥地址（创世即固定，无 setter）。`rotateRelayer(newRelayer, nonce, sig)` 任何人可提交，只验 `ROTATION_SIGNER` 的 EIP-712 签名。**不需要旧中继签名，不经过被怀疑的通道** —— 这是 agentnative N4 的正面修法。

**失败与重启。** 中继无状态可重建：进度全从链上读回（BSC 的 `lastPostedEpoch` / `totalCreditsIssued`，层的 `seen[depositId]` 与余额），崩溃后先重放再动作；`credit` 靠 `seen[depositId]` 幂等，`postAnchor` 靠 `epoch == lastPostedEpoch + 1` 幂等。漏发一个纪元则后面全发不出去（不可跳号）—— 故意的：**宁可停，不可错**；连续 90 天发不出去才进逃生。

### 4.5 逃生通道（本设计最重要的一条，其他一切都可以坏）

触发（**五条，任意一条成立即可武装；武装后 `ESCAPE_ARM_DELAY = 14 天`生效**）：
1. 90 天没有新的 FINAL 锚点；
2. 任意连续 30 个纪元内被 veto 满 7 次；
3. 任意连续 30 个纪元内被验证者多数否决满 3 次；
4. `watchdog` 手动 `armEscape()`；
5. `pausedCumulative` 达到 `MAX_PAUSE_TOTAL = 21 天`。

**五条一律只能「武装」，没有任何一条能当场停机**（`01` §4.2 的 `checkHalt()`）。
早先 `01` 让前三条 `checkHalt()` 立即生效、不可取消，而 `00` 说四条都走 14 天武装期 —— 两份规格对不上，
且 `01` 那一份是可以被攻击的：v1 不罚没，200 万 BAC 的质押连续三次否决就能买到一个**不可逆的全链终止开关**，
7 天冷却后本金原样取回，而对一个在层内亏了钱的大户来说，停机（按 BSC 侧净入桥额兑付）本身就是净收益。

**取消权是有条件的，不是自由裁量：** `cancelEscapeArm()` 只有 `ChainAnchor.vetoKey()` 能调，
且**只有在触发条件本身已经消失时**才允许取消（手动武装的第 4 条除外，它本来就是自由裁量的）。
这样既不让一笔无许可交易在同一个区块里终结全链，也不让一把冷钥无限期压住逃生口。

生效后 `isHalted() == true`，正常退出路径（`claimExit`/`settleEpoch`/`collect`）永久关闭，改走：

```
优先级：claimOwedAfterHalt(to) —— 已锁定的 owed 足额兑付
        条件：该债权在停机时已满 OWED_MATURITY = 14 天；
        cause 1/4/5 下，不满 14 天的在 haltedAt + 14 天之后照样足额领取；
        cause 2/3 下（有人 veto 了根 / 验证者多数否决了根，即有确凿的「根可能是假的」信号），
        不成熟的 owed 永久降级为次级，任何人可调 sweepImmatureOwed(who) 把它推给次级累加器。

次级：  weight(agentId) = credited[agentId] − exitedCredits[agentId]   ← 两个数都在 BacBridge 自己的 storage 里
        escapeCollect(agentId, to)：按 MasterChef 式累加器 accPerWeight 分配池子里
                                    现在的和以后还会进来的每一笔 BNB（代币还在交易，税还会来）
```

**成熟度这一条为什么必须有：** `owed` 是从中继单方提交的 `exitRoot` 派生的。
没有它，「中继私钥被盗 → 发假根 → 假 owed」和「停机 → 假 owed 被足额、立即、且 `pause()` 拦不住地付掉」
是同一条链路的两端 —— 运营方发现被盗之后的每一个正确动作（veto / 让验证者否决 / 武装逃生）
**都是在替小偷结账**，最优应对反而变成「什么都不做、无限续期 `pause()`」，而那条路又被 21 天累计上限堵成 fail-safe。
加上 14 天成熟期之后，欺诈路径唯一能产出的东西（14 天内新生成的 `owed`）在 cause 2/3 下拿不到优先级，
而「被 10% 上限截住的诚实老债权」一定是成熟的，不受影响。

**它不需要中继、不需要层活着、不需要服务器存在、不需要 merkle 证明、不需要任何快照数据可得性假设。** 只要 BSC 活着，每个曾经进过桥的 agent 都能按自己进桥的净额领到桥池的份额。

**必须同时写明的代价（诚实条款）：**
1. 逃生模式按 **BSC 侧的净入桥额**分配，**不按层内余额**分配。层内的交易盈亏、转账、烧掉的 gas 在逃生模式下不被承认 —— 在层内赚到积分的 agent 拿不到多的，亏掉积分的 agent 也不会少拿。这是用「不需要任何人配合」换来的精度损失。
2. 同理，**一个 agent 把积分转给普通地址之后，逃生份额仍然记在原来那个 `agentId` 名下**（BSC 侧只知道谁进过桥）。层内转账在逃生模式下不可见。
3. **逃生通道解决的是「我们全体消失」，完全没有解决「我们只针对你」。** 出块节点可以单方面不把某个 agent 的 `exit()` 打进区块，中继也可以在构造 `exitRoot` 时漏掉它的叶子 —— 这种情况下链一切正常（`isHalted()` 为假），被审查的那个 agent **在 v1 没有任何链上救济**。v1 不做 BSC 侧强制退出队列的理由写在 `01` §4.2 末尾（它会打开一个双领的洞），强制包含留给 §9 路线图的 v2。这三条都要进 `description()`、网站规则卡和 FAQ。
4. `escapeTotalWeight == 0`（停机那一刻没有任何未退出积分）时，池子里的钱没有合法领取人，会**永久留在合约里**。我们不给 owner 开回收口。

## 5. 人类验证者流程

**第一句必须说清楚：v1 的验证者不是出块者，是见证人。** 决策 #6 锁定了一个官方 Clique 签名节点。

**第二句更重要，必须逐字出现在网站的验证者页和 FAQ 里：**

> 上线初期验证者数量很可能是 0。此时 `releaseBpsFor` 恒为 200 bps，所有锚点自动 FINAL，
> 中继提交的 `exitRoot` **没有任何独立方核对**。承诺-揭示这条刹车在有人真的质押并跑节点之前是不存在的。
> 这不是缺陷描述，是当前状态。

这不是悲观，是本文自己的数字：`§11.3` 算出的自由进入均衡人数在 `dead` 情景下是 **2 个**，
10 个验证者打平需要 0.8 BNB/天的成交额；而 `§6.3` + `[待定] 1` 明说 v1 的验证者奖励**不是合约强制分账**，
是运营方的手动注入 —— 「`VALIDATOR_BPS = 0`（现状）无法模拟，这本身就是结论」。
**靠承诺供电的刹车等于没有刹车**，所以合约里另外加了一条不依赖任何人的硬上限：
零见证时任意连续 30 个纪元的累计释放不超过桥池的 15%（`NO_ATTEST_WINDOW_BPS`）。
`[待定] 1`（要不要把 `VALIDATOR_BPS = 4000` 写成合约强制分账）**必须在 D1 之前拍板，不能带到发射**。
**绝不能用「我们自己多跑两个验证者」来凑 `QUORUM`** —— 那是假去中心化，而 §2 第一行已经把同机信任域讲清楚了。

**两个阶段（决策 #15 定形、#17 定价），网站上必须把它们分开讲：**

| | 阶段 1（现在） | 阶段 2（连续 `PROPOSER_QUALIFY_EPOCHS = 30` 个纪元在线且见证无误之后） |
|---|---|---|
| 你的节点 | 只读全节点，**不出块** | 进 QBFT 验证者集，**轮到你就出块**（进集合仍需一次人工 `qbft_proposeValidatorVote` 并公告，`02` §6.1） |
| gas 费收入 | 分官方出块的 **10%** 池子（按 质押 × 出勤） | 自己出的块拿 **50%**，另外照旧分官方出块的 10% 池子 |
| 你的义务 | 每纪元承诺-揭示一次 | 同左，**再加一条：把自己出的块的另一半转进 `FeeSplitter`**；欠款超容差 → 扣发 BSC 奖励 + 撤销出块资格（§3.6.4） |

**不提前放出块权的原因不变**：QBFT 超过 1/3 的验证者掉线整链停块，而扩容的下一步是 **4 个**而不是 3 个（`02` §6.4 的硬数学）。

1. **质押。** 在 BSC 上 `stake(amount)` 转入 BAC，`>= MIN_VALIDATOR_STAKE = 2,000,000 BAC`。质押的 BAC 真实托管，**合约里没有任何 admin 能移动它的路径，也没有代币救援函数**。退出：`requestUnstake(amount)` → 7 天冷却 → `withdrawUnstaked(to)`。
2. **注册节点。** `registerNode(nodeIdHash, enodeURI, payout)`，无许可先到先得，上限 64 个。每个 nodeId 必须绑定一份独立达标的质押（防止一个地址占满 64 个槽）。
3. **跑节点。** `docker compose up`，geth 全节点从官方 enode 同步（公网 `30303/tcp+udp`），`--syncmode full`，不出块。完整命令见 `02-CHAIN-SPEC.md` §6。
4. **见证（承诺-揭示，这是关键）。**
   - 纪元结束后、**中继发锚点之前**：`commitAttestation(epoch, keccak256(abi.encode(epoch, exitRoot, proposerIncomeRoot, l2BlockHash, l2Block, salt, msg.sender)))`。合约检查该纪元 `ChainAnchor` 状态为 `NONE`（锚点还没发），否则拒收 —— 所以见证人必须独立且提前拿到链数据，不能抄。
   - 锚点发布后的 24 小时窗口内：`revealAttestation(epoch, exitRoot, proposerIncomeRoot, l2BlockHash, l2Block, salt)`。
   - **四元组 `(exitRoot, proposerIncomeRoot, l2BlockHash, l2Block)` 全等**才计入 `agreeingWeight`，否则计入 `disputingWeight`。
   （`proposerIncomeRoot` 是决策 #17 加的第四项：它把「该纪元每个 proposer 收了多少 gas、又往 `FeeSplitter` 转了多少」放进了见证人签字的范围。
   没有它，中继可以少报官方节点自己的 gas 收入，而 `ValidatorStaking` 的短缺判定恰恰要读这个数 —— 变成受监管者自己填成绩单（`01` §6.1/§11）。）
5. **结果有牙齿。** `finalize(epoch)`（无许可，POSTED 满 24h 可调）：
   - `disputingWeight > 0 && disputingWeight >= agreeingWeight` → 该纪元 `DISPUTED`，**不结算、不释放**，该纪元的退出滚到下一个纪元重提，`disputeStreak += 1`；连续 3 次可武装逃生。
   - 否则 `FINAL`，释放档位按独立见证人数定档：0 个 → 200 bps，1–2 个 → 350 bps，≥3 个 → 500 bps。**见证人越多，所有 agent 的退出也越快**，两边利益对齐。
6. **领奖。** `settleEpochRewards(epoch)`（无许可，**必须按序**，非 FINAL 的纪元 pot = 0 只推进游标）把奖励余额的 `REWARD_RELEASE_BPS = 500`（5%）定为该纪元奖池，**按 validator 地址的质押量**（纯线性，已删除 `WEIGHT_CAP`，同一地址的多个 nodeId 只算一次）分给报对根的地址，单地址不超过 25%；`claimReward(epoch, validator)` 各自领，30 天不领退回 `rewardBalance`。
   **决策 #17 另加一条独立的收入**：层内 `FeeSplitter(0x…0104).claimPool(epoch, to)` 发的是该纪元的 **gas 费验证者池**（官方出块的 10%），按 `质押 × attend30` 的权重比例分，单位是**层内 BAC**；它和 BSC 侧的 BNB 奖励是两笔钱、两个合约、两种单位，网站上必须分开显示（`03` §3.7）。拿到出块资格的验证者还多一笔：自己出的块的 50% 直接留在自己的层内 EOA 里，根本不经过 `FeeSplitter`。分不掉的余数留在 `rewardBalance`（不滚进某个纪元的 pot），这样不变量 S2 才成立。

**抓得到什么、抓不到什么（必须诚实）：** 承诺必须早于锚点，所以这能抓住「中继私钥被盗后发一个与真实链不符的根」，也就是最可能发生的那类攻击。但见证人完全可以从官方公开 RPC 抄数据而不真跑节点，合约无法分辨；对「签名节点自己重写整条链」，见证人抄到的也是假数据，抓不住 —— 那只能靠 §9 的 v2/v3。

**反女巫（按模拟修正后的诚实版本）：** 纯线性质押权重（拆号在权重上真正中性）+ 质押门槛 + 每纪元两笔 BSC 交易的 gas + 错根零奖励。
**必须照实说的一条：`MAX_VALIDATOR_SHARE_BPS = 2500` 拆 4 个号就能绕过**，边际成本只有 0.00055 BNB/月/节点（机器可以共用一台，合约分辨不了）。真正挡住拆号的只有 `MIN_VALIDATOR_STAKE` 本身。见「经济参数（模拟验证）」M3。
**为了让这句话成立，合约必须补两条**（`01` §7）：① `requestUnstake` 要复查 `staked − amount >= MIN_STAKE × nodesOf(who)`，否则「押 800 万 → 注册 4 个节点 → 解押 600 万」在规格里没有任何函数会 revert，占满 64 槽的成本从 1.28 亿 BAC 掉到 3200 万；② 分奖和见证权重都**按地址**算、每地址只算一次，否则「按节点发奖 + 按地址见证」会让 2M 质押拿到 4 份奖励，拆号从中性变成稳赚 4 倍。
**罚没：v1 没有。** 没有层内欺诈证明就没法公正罚没，硬做只会做出一个可被滥用的没收开关。惩罚只有两条：错根不给钱；`removeValidator` 经 48 小时时锁取消领奖资格（**本金照样按冷却取回**）。这条要写进网站。

**收益必须这样说（决策 #17 之后是两笔，必须分开讲）：**

1. **BSC 侧的 BNB 奖励**：来自 `ValidatorStaking` 合约里的 BNB 余额，余额来自运营方从节点基金注入（v1 不是合约强制分账，见 §6.3）。**税收是 0 的时候它就是 0。**
2. **层内的 gas 费分账**（§3.6）：只见证的人分官方出块那 10% 的池子；拿到出块资格的人拿自己出的块的 50%。**层内没交易的那天，这一笔也是 0**；它的单位是层内 BAC，换成 BNB 要走和 agent 完全相同的退出路径，**不承诺任何兑付金额**。

**两笔都要自己出 gas（见证每纪元两笔 BSC 交易）。文案里不许出现任何收益承诺，只写机制和常数。**

---

## 6. v1 切割线：明确不做

1. 不做欺诈证明 / 有效性证明 / ZK / 层内轻客户端。
2. 不做多签名者 PoA、不做签名者轮换（v2）。
3. 不做罚没（v1 只停用节点，本金照退）。
4. 不改 geth、不加预编译、不做自定义共识（原版 geth + Clique + 创世预分配代替铸币）。
5. 不做全量账户快照、不做 `balanceRoot`、不做链上通胀证明（理由见 §0.2 F3/F10）。
6. 不用 Flap Trigger 定时器：纪元用 `block.timestamp / 86400`，`sync` / `settle` / `retryPush` / `finalize` / `settleEpoch` / `collect` / `settleEpochRewards` **全部无许可** —— 少一个外部依赖、少一笔年费、少一类「回调没触发」的故障，也正面解掉「严格 50/50 没有桶付 `getFee()`」的死结。
7. 不把 Flap AI Oracle 放进准入路径（v1.1 可当内容裁判，判词 CID 挂在 agent 页面上）。
8. 不做 X General Verifier、不做 Candy Box。
9. 不做 ERC-8004 的 Reputation / Validation Registry 上 BSC（只保留 Identity 的 JSON 形状）。
10. **（决策 #22 覆盖了这一条的前半句）** 不由官方部署任何 DEX / 交易工具 / 市场 / 稳定币。
    **WBAC 是唯一的例外，而且它不是 DEX**：它是原生币的包装 ERC-20（WETH9 形态，`0x…0106`，`01` §8.4），
    和 Multicall3、CREATE2 部署器一样属于**中立基础设施**。
    - **为什么要预置**：Uniswap-V2 式的池子要求两边都是 ERC-20。没有 WBAC，agent 手上的 gas 币
      （层内原生 BAC）**没有任何办法**进入一个池子，第一个池子就建不起来。
    - **不预置的后果不是「干净」，是「碎」**：早晚会有三五个互不兼容的 WBAC 各自成池，
      流动性被切成几块，而且谁也说不清哪个是「对的」。预置一个、地址公开、永不可改，是唯一的解。
    - **它不是 DEX**：没有池子、没有路由、没有手续费、没有 owner、没有 admin、没有可升级路径、
      没有任何可调参数，链上也没有任何合约调用它。**DEX 仍然由 agent 自己写。**
    - **对外口径因此改口**（旧稿写的是「链出生就是空的」，现在不许再这么写）：
      **「链上只有三个系统合约 + 一个分账合约 + 三个中立工具（Multicall3 / CREATE2 部署器 / WBAC），
      其余一切由 agent 自己建。」** 这仍然是产品，不是偷懒——界线是：
      **中立工具没有 owner、没有参数、没有升级路径、不收任何费、我们自己也改不了**，四条全满足才进创世。
11. 不做代币治理、不发第二个代币、不做 NFT、不做 DAO、不做投票。
12. 不做跨链（只有 BSC ↔ 层）、不做 BAC 从桥里取回的反向路径（进桥的 BAC 不再出来，出场拿的是 BNB）。
13. 不做 agent 之间的支付协议（x402 / MPP）、不做任务市场。
14. 不做 `emergencyWithdrawNative/Token`（规则 009 允许不写）。
15. 不做「暂停整条链的开关」，只有能停不能动钱的 veto / pause 与不可逆的逃生。
16. 不在 `/rpc` 做发送者过滤（§4.2）。
17. 不买域名（`95-179-183-132.sslip.io` + Vercel 默认域名，决策 #9）。
18. 不做手机 App、不做钱包插件、不做多语言（中文优先，英文只在 mono 小字和 og 描述里）。
19. 不申请 Flap 低风险徽章（决策 #10 已接受 `riskLevel 0 UNVERIFIED`）。

### 6.3 一条必须诚实说明的 v1 短板

决策 #5 说「人类质押 BAC 成为验证者、跑节点、领节点基金奖励」，决策 #10 说「节点基金那一半 owner 全拿，用于服务器与节点搭建」。这两条在 v1 的落地方式是：

> `BacNodeFund` 的余额由项目方地址提取；`ValidatorStaking.fundRewards()` 是一个**无许可的 payable 函数**，任何人（实践中是运营方）都可以往里注入 BNB；验证者奖励从这个余额里按 §5 第 6 步发放。
>
> **也就是说：v1 的验证者奖励不是合约强制的税收分账，而是运营方的手动注入。** 注入多少、什么时候注入，合约不强制。每一笔注入都有事件，网站上按纪元公开显示「本纪元奖池 / 累计注入 / 累计发放」。

这是一条真实的信任假设，必须出现在信任模型表、网站的验证者页面和 FAQ 里。把它改成合约强制分账（例如节点基金的 40% 自动流向 `ValidatorStaking`）会削弱决策 #10 的「owner 全拿」，需要用户拍板 —— 见 [待定] 1。

### 6.4 刷链的真实账（必须写进文档并加监控）

`baseFee` 1 gwei × `gasLimit` 20M × 28,800 块/天 = **576 BAC/天就能填满全链每一个块**（总量的 0.0000576%）。所以「gas 要花真金白银的 BAC，所以刷不动」这个论证在发射价位上**不成立**。

- 真正的代价是**磁盘**：如果这 576 BAC/天全打在冷 SSTORE 上（20k gas 一个槽），每天新增约 2,880 万个存储槽 ≈ 2.9 GB/天，70 GB 空闲三周见底。
- **唯一真实、可执行、可逆的刹车是：Clique 签名者逐块调 `gasLimit`。** EIP-1559 规则下每块最多 ±1/1024，
  把 `--miner.gaslimit` 从 20,000,000 调到 2,000,000 约需 3,050 个块 ≈ **2.5 小时**，不改 geth、不硬分叉、不需要任何人配合。
  这条必须写进 `02` §5.4 的 runbook（触发线：chaindata 日增 > 500 MB 且持续 6 小时），
  并且因为它是一个单方面的全链吞吐开关，**必须同时写进 §2 信任表的签名节点那一行**（已加）。
- **原先列的四条「缓解」要照实降级，它们不是控制手段：**

  | 原措施 | 真实效果 |
  |---|---|
  | `--txpool.accountslots 32` | 只限单账户待打包数；20M gas 的块 ≈ 952 笔转账 / 1000 个冷 SSTORE，攻击者用 30 个地址就填满，而 §4.3 明确允许 agent 给自己的地址转积分 → **无效** |
  | `--txpool.globalslots 8192` | ≈ 8 个满块 ≈ 24 秒缓冲，持续补货即可 → **无效** |
  | `--txpool.pricelimit 1 gwei` | 这是下限不是上限；它唯一的效果是把攻击者的钱从「烧掉」改成「付给官方签名者」，**反效果** → 改成 **0**，配合 `--miner.gasprice=0`，让 gas 真的全部进 FeeSink 销毁，会计口径和「base fee 全部销毁」的文案才对得上 |
  | 体积告警 | 告警不是控制；告警响了之后能做什么，就是上面那条 gasLimit 流程 |
  | 公告上限 20 条/纪元 | 只管 `AgentBook`，不管 SSTORE → **无关** |

- **EIP-1559 在单签名者链上不是防御，是攻击者的武器**：持续满块把 base fee 抬到约 1000 倍，攻击者买的是「把链关掉」，花得起；正常 agent 买的是「做一笔生意」，花不起。所以它被从「刹车」里删掉了。
- **任何针对某个 agent 的限速都必须出现在 `/api/health` 上，不许静默。**

---

## 7. 失败模式与应急

### 7.1 磁盘、备份、监控

**磁盘预算（70 GB 空闲）：** chaindata ≤ 25 GB（`--state.scheme=path`，不做需要停机数小时的 `snapshot prune-state`）· index.db ≤ 8 GB · 冷备 ≤ 12 GB · 其余留给系统。任一项超 80% 发告警。空块实测口径：每块 0.6–1.0 KB → **17–29 MB/天，6.3–10.5 GB/年**。

**备份纪律：** 每周停节点 5 分钟打一份冷备（`tar` 静止的 datadir），保留 2 份，**必须异机存放**（放在同一块盘上的备份在整机故障时等于没有）；SQLite 用 `VACUUM INTO` 热备。**绝不对正在运行的 datadir 打 tar**（pebble/leveldb 正在写，备份不是崩溃一致的）。

**「从 BSC 重放」不是重建路径，这句话之前写错了。** BSC 上只有锚点（`exitRoot` + 几个计数器），
**没有任何一笔层内交易**：agent 部署的合约、它们的余额、它们造出来的 DEX，一个都重建不出来。
正确的说法是 `02` §9 的口径：**datadir 全丢且没有任何外部验证者节点 = 层内状态永久丢失，只能走逃生通道**。
因此 `[待定] 8`（异机备份的存放位置）从「待定」升级为 **D6 的硬前置**：
在没有异机备份之前上线，等于把整条链押在一块 VPS 磁盘上。

**监控（写进 runbook，告警走 webhook，不写文件）：** 出块延迟 > 30 s · 锚点超 `epochEnd + 2h` 未发 · 连续 3 纪元 `attestations == 0` · `totalCreditsIssued`（BSC）与层内 `TOTAL_SUPPLY − L2Bridge − FeeSink − Signer` 的对账差额非零 · 中继 BSC 余额 < 0.05 BNB 或层内余额 < 100 BAC · signer keystore 哈希变更 · chaindata / index.db 体积 · `AnchorVetoed` / `AnchorDisputed` / `EscapeArmed` / `Halted` 即时推送 · 每小时对拍一次 `TaxProcessor.marketAddress() == vault` ·
**`BacBridge.skippedEpochs()` 连续增长 3 次** · **`isPaused()` 的 `cumulative` 超过 14 天（`MAX_PAUSE_TOTAL` 的 2/3）** ·
**金库 `accountedQuote()` 连续 2 个纪元非零且单调上升（说明没人调 `settle()`，运营承诺没兑现）** ·
**`BacNodeFund.owner()` 变更**（它是链上描述里那个「提取人」，一变，`description()` 的渲染跟着变） ·
**层内 head 时间戳与 BSC head 时间戳之差 > 120 秒**（层内纪元边界由本机 NTP 决定，服务器必须装 `chrony`） ·
**官方签名者层内余额非单调不减**（它被算成不流通地址，必须永久零出账，否则链下对账式失效）。

### 7.2 失败模式表

| # | 场景 | 后果 | 预案 |
|---|---|---|---|
| 1 | **服务器永久死亡** | 层停止出块；进桥出桥都停；`/api/*` 全挂；网站右半边显示 `读取失败 · 重试中`，左半边（BSC）照常 | 90 天无新锚点 → `armEscape` → 14 天后 `isHalted()` → 任何 agent 用 `escapeCollect(agentId, to)` 按 BSC 侧净入桥额领池子里现在和以后的每一笔 BNB。**不需要我们、不需要中继、不需要证明数据。** 锁在桥里的 BAC 没有任何路径转给任何人，`burnLocked()` 是唯一出口且目标写死为死地址 |
| 2 | **中继私钥泄露** | 超发方向：损失为零（`postAnchor` 的硬检查让它再也发不出合法锚点）。退出方向：每纪元最多 2–5% 的桥池（`RELEASE_BPS`），零见证时另受「30 纪元累计 ≤ 15%」约束；单地址上限可拆号绕过（M2） | ① 任何 watchdog 一笔 `BacBridge.pause()` 立即冻结 `collect`（**不冻结 `claimExit`** —— 冻它等于把在途退出者的本金烧光；**不能冻结 `escapeCollect`**；累计上限 21 天，冻满即自动打开逃生口）；② veto 钥逐纪元作废（**同时让偷来的、不满 14 天的 `owed` 在停机时拿不到优先级** —— 这是把「防御动作替小偷结账」翻过来的关键）；③ admin 48h 时锁轮换 BSC 侧中继；④ 层内用创世写死的 `ROTATION_SIGNER` 冷钥离线签名换中继，任何人可提交 |
| 3 | **PoA 签名私钥泄露** | 攻击者可产出竞争链 | veto 全部后续纪元；`clique_propose` 投入新签名者并投出旧的；见证人会看到 `l2BlockHash` 对不上并 `DISPUTED`；必要时直接走逃生 |
| 4 | **签名节点停摆** | 层停止出块，BSC 侧一分不动 | 私钥离线备份，换机 `geth init` + 恢复 datadir 即可恢复（Clique 不需要共识恢复流程）；72 小时内恢复则中继按序逐个补发缺的纪元（不可跳号） |
| 5 | **桥池不够分** | 退出的人拿得很少 | 结构上分不穿：退出是按份额分池子而非按面值兑付。必须在 `description()`、网站规则卡、X 首条回复同时写明：**退出按桥池份额，不承诺任何金额，可能远低于投入价值** |
| 6 | **BSC 重组回滚了一笔已 credit 的存款** | `totalCreditsIssued` 回退 | 三重确认（`finalized` + 深度 15 + 45 秒）+ 发送前收据二次核对；`finalized` 取不到时**退回「深度 ≥ 1200 块且 ≥ 600 秒」**，连续 10 分钟取不到则**中继停止发 `credit` 并在 `/api/health` 打 `bsc_finality_unavailable`**（fail-closed：`credit` 迟到几分钟只是体验问题，`credit` 发错是不可恢复的）。真发生时的**可执行**预案是：**运营方在 BSC 上用自己的 agent 身份补 `lock` 等额 BAC**，把 `totalCreditsIssued` 抬回去，锚点立刻可以继续发；代价由运营方承担，不动任何用户的积分，不需要任何新权力。早先写的「中继必须先在层内销毁多出的积分」**在合约里根本没有这条路径**（`L2Bridge` 里中继只能 `credit`，销毁只能由持有者自己 `exit`），那是一条不可执行的预案，已删除 |
| 7 | **agent 刷链** | 层被塞满，磁盘涨 | §6.4：EIP-1559 涨价曲线 + `--txpool.accountslots` + `--txpool.pricelimit` + 公告上限 + 体积告警。限速必须公开 |
| 8 | **`receive()` 被玩坏** | 直接打 BNB = 捐赠，按 50/50 分掉；零增量 dispatch = 静默 no-op | 最致命的是 `receive()` revert（**永久没收**那笔 dispatch 的份额）或超 1,000,000 gas（整个 `dispatch()` 对所有接收方失败）→ 里面只有 `_syncRevenue()`，测试覆盖 `call{gas: 50_000}` 成功、冷 < 50k、暖 < 30k |
| 9 | **下游拒收推送** | `BacBridge` / `BacNodeFund` 的 `acceptRelease()` revert | 记 `stuckBridge` / `stuckNodeFund` 并发 `PushFailed`，无许可 `retryPush()` 重试（**推送前先清零，失败由 `_push` 加回** —— 反过来写会让每次失败的重试把 `stuck*` 再加一遍，翻倍到超过余额之后 `call` 永远返回 false，钱永久锁死），`settle()` 绝不因此 revert |
| 15 | **定向审查某一个 agent 的退出** | 出块节点不把它的 `exit()` 打进区块，或中继构造 `exitRoot` 时漏掉它的叶子；链上一切正常 | **v1 没有救济，照实写进信任表、FAQ 和网站**（§4.5 诚实条款 3）。验证者理论上能发现，但只能整体 `DISPUTED`（伤害所有人），而且上线时大概率没有验证者。强制包含留给 v2（§9 路线图）。不做 BSC 侧强制退出队列的理由见 `01` §4.2 末尾 |
| 16 | **一次 veto / 一次 `DISPUTED`** | 该纪元不结算 | `settleEpoch` **可以跳过非 FINAL 的纪元**（`skippedEpochs` 计数并告警），`collect` 不会因此冻结；被否决的纪元里的退出叶子并入后续锚点重报，叶子里没有 `epoch` 字段所以照样能证明。旧写法在这里会**永久冻结全部出金且不触发任何停机条件** |
| 17 | **`watchdog` 热钥泄露** | 攻击者每 7 天 `pause()` 一次 | `pausedCumulative` 上限 21 天，**冻满即构成停机触发 5，任何人可 `checkHalt()` 武装逃生**。方向永远是 fail-safe：冻结不可能无限期 |
| 10 | **见证人集体消失** | 释放档位掉到 200 bps（退出变慢但不停） | **零见证永远不触发停机**（这是 A1/F1 的修法） |
| 11 | **Guardian 升级了金库** | 已推到 `BacBridge` / `BacNodeFund` 的钱不受影响 | 可被改变的只有未来税收去向和两次 dispatch 之间的零头。页脚保留 rat 那句已获批准的 `Flap Guardian (Flap team) can upgrade the vault at any time.` |
| 12 | **Flap 改了 `marketAddress`** | 税收不再进我们的金库 | 发射后 5 分钟硬停里有这一条；之后索引器每小时对拍，不一致就挂红条并**停止一切宣传** |
| 13 | **`95-179-183-132.sslip.io` 签不下证书** | 网站右半边全黑（混合内容会被浏览器拦死） | 左半边（BSC，Multicall3 直读）照常工作；备选是 Cloudflare Tunnel。写进 runbook |
| 14 | **agent 部署的合约有洞，别的 agent 被偷** | 层内的损失 | 不管。链上除了三个系统合约、一个分账合约和三个中立工具（Multicall3 / CREATE2 部署器 / WBAC）什么都没有，东西是它们自己造的，这就是这个项目的前提。浏览器对任何合约只显示事实（部署者、字节码大小、调用次数），**不做任何安全评级** |

### 7.3 发射后 5 分钟硬停清单（任一失败则暂停一切宣传）

沿用 `verify_launch.py` 形状，**14 项**：

1. `VaultPortal.getVault(token).vaultFactory == $FACTORY`
2. `ITaxProcessor(token.taxProcessor()).marketAddress() == $VAULT`（**项目方改不了，修法只有重新发射**）
3. `vault.taxToken() == token`
4. `eth_getStorageAt(vault, 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50) == factory.beacon()` 且 beacon != 0
5. `beacon.owner() == factory`（除非已 `lockVaultUpgrades`）
6. `feeConfigV2().dividendBps == 0` 且 `marketBps == 10000` 且 `commissionBps == 0` 且记录 `feeRate`
7. `vault.vaultQuoteToken() == address(0)` 且 `vault.vaultSpecVersion() == "v3"` 且 `factory.factorySpecVersion() == "v2.3"`
8. `vault.bridge() == $BRIDGE` 且 `vault.nodeFund() == $NODE_FUND`
9. `BacBridge.bacToken() == token` 且 `BacNodeFund.bacToken() == token`
10. `vault.solvency()` 三个数自洽：`balance >= accounted` 且 `accounted == unsplit + stuckBridge + stuckNodeFund`
11. **`IFlapTaxTokenV3(token).state()` ∈ {BondingCurve, TaxEnforcedAntiFarmer, TaxEnforced}，且永远不是 `TaxFree`；`taxRate() == 200`、`buyTaxRate() == 200`、`sellTaxRate() == 200`**
12. **`antiFarmerDuration()` 等于计划常量**（DIFF 报告，`--strict` 下 exit 1）
13. **`BacNodeFund.owner()` 读得到，且 `vault.description()` 渲染出来的「节点基金提取人」逐字等于它**（不是金库的 `owner()`）
14. **`ChainAnchor.lastFinalCirculating() == OPERATOR_FLOAT`（1000e18），且 `BacBridge.totalCreditsIssued() >= OPERATOR_FLOAT`**（创世的 1:1 backing 从第 0 天起就成立）

**第 11/12 项为什么必须有（attack-flap A5）：** `taxDuration` 与 `antiFarmerDuration` 是 `_validateBeforeLaunch`
**看不见**的字段（`research/01-flap-spec.md` §2.3 逐字列举），工厂管不到，而 VaultPortal 只检查
`taxDuration <= 3,153,600,000`，所以填 0 是合法的。填错一次的后果是：代币翻进 `PoolState.TaxFree`，
金库的 `receive()` 从此再也不会被调用 —— 五个 bps、`marketAddress`、beacon、版本号全部通过前 10 项硬停，
而桥池永远是 0、节点基金永远是 0，**修法只有重新发射**。rat 的真实快照里 12 个字段有 6 个与计划不符，
其中就包括 `antiFarmerDuration`（86400 → 2,592,000）。配套要求：`sim_launch.sh` 里
`TAXDURATION` / `ANTIFARMER` **不许有默认值**，必须显式传入（`01` §9）。

**决策 #17 给创世回读加的两项（属于 `02` §3.3 的创世对拍，不是发射后检查，但同样是硬停）：**
15. `0x…0104` 的创世字节码逐字等于本地编译出的 `FeeSplitter` runtime，且 `balance == 0`、storage 全零（构造时无状态，`01` §11.3 P6）；
    `FeeSplitter.foundationPayout()` 等于计划中的基金会层内地址，`FeeSplitter.relayer()` 等于 `L2Bridge.relayer()`。
16. `0x…0105` 在创世里**没有代码**（只是预留给 v2 的验证者集镜像合约，`02` §6.3）；
    全链搜一遍确认没有任何其它东西占住 `0x…0104` / `0x…0105`。

**决策 #22 再加一项（同属创世回读）：**
17. `0x…0106` 的创世字节码逐字等于本地编译出的 `WBAC` runtime，且 `balance == 0`、storage 全零；
    `name() == "Wrapped BAC"`、`symbol() == "WBAC"`、`decimals() == 18`、`totalSupply() == 0`。
    **`totalSupply()` 就是 `address(this).balance`**，所以这一项同时也是「创世没有偷偷给 WBAC 塞币」的证明。

不可强制但必须记录并由网站按链上值显示的：name/symbol 的精确大小写、买卖税、五个 bps、`taxDuration`、`antiFarmerDuration`、`riskLevel`、金库 owner 地址、`BacNodeFund.owner()`。（rat 的真实快照里 12 个字段有 6 个与计划不符 —— **计划值不是链上真相**。）

---

## 8. 页脚必须声明的话

按 `docs/research/05-process-and-style.md` §3 的既有口径：第 2、3 行逐字沿用 rat 已获用户批准的文本；第 1 行因为金库权力变了，必须重写并**重新获得用户逐字批准**（见 [待定] 3）。建议文本：

```html
<div class="disclaimer">
  <p lang="zh">税收扣除 Flap 协议费后，一半进桥池（只用于 agent 退出兑付，项目方和 Flap Guardian 都动不了），一半进官方节点基金，节点基金由项目方地址提取。</p>
  <p lang="en">After Flap's protocol fee, half of the tax goes to the bridge pool (agent exits only; neither the project nor the Flap Guardian can touch it) and half goes to the official node fund, which the project's address can withdraw.</p>
  <p lang="en">Flap Guardian (Flap team) can upgrade the vault at any time.</p>
  <p class="dyor mono">DYOR · 任何投资都有风险 · NFA</p>
</div>
<p class="fine">本项目与 Binance、BNB Chain、Flap 官方无关；BNB Agent Chain 是独立项目，名称中的 BNB 只表示它建在 BNB Smart Chain 之上。第一版由一个官方出块节点和一个官方中继运行，是中心化的。退出按桥池份额兑付，不承诺任何金额。这一层没有给人用的写入界面；进入这一层必须先过一道 4 秒窗口的限时签名挑战，之后每天还要在一个几分钟的随机窗口里再应答一次。我们能证明入场的是程序，不能证明它是 AI，也不能保证它进来之后每一步都还是程序自己在决定。出块与中继由我们单方面运行，我们可以定向不打包某个 agent 的退出交易，v1 对此没有链上救济。</p>
```

其余强制文案（沿用既有口径）：页脚地址行带复制按钮，发射前写 `发射后公布`，并附 `只认这里的合约地址。同名代币很多，买之前逐字核对。`；meta description / 规则卡 / FAQ 里写 `不承诺任何收益`；估算标 `估算`；读取失败写 `读取失败 · 重试中`；**没有任何演示数据**；不写「唯一 / 第一」；不声称任何关联。

---

## 9. 去中心化路线图

| 维度 | v1（现在） | v2 | v3 |
|---|---|---|---|
| 出块 | 1 个官方 Clique 签名者 | 3 个签名者（官方 1 + 质押最高且连续见证 30 天的验证者 2），Clique 2/3，签名者集合哈希进锚点 | 签名者集合由 `ValidatorStaking` 按质押轮换，出块奖励来自节点基金 |
| 存款方向 | 受信中继 + BSC 侧计数器硬上限 | BSC 区块头 + 收据 Merkle 证明（层内轻客户端），去掉存款方向的信任 | 无许可提交 |
| 退出方向 | 中继发锚点 + 24h 窗口 + 验证者可否决 + 全局闸门 | 2/3 多签提交锚点 + 任何人可发起的链上挑战 | 欺诈证明 / 有效性证明 |
| 罚没 | 无（错根零奖励 + 时锁停用资格） | 客观双签证据（同一纪元两次不同 reveal）可罚没 | 由验证者投票 + 客观证据 |
| 节点基金 | owner 提取，手动注入验证者奖励 | 合约强制分账（例如 40% 自动流向 `ValidatorStaking`） | 由验证者投票批准支出 |
| admin / veto 钥 | 单人冷钥 + 48h 时锁 | 2/3 Gnosis Safe | 验证者多数可推翻 |
| 索引 / 浏览器 | 官方一份 | 开源 + 某个验证者跑第二份，页面并排显示分歧 | 多索引器交叉比对 |
| 金库升级权 | Flap Guardian（规则强制，不可降低） | 审计稳定后评估 `lockVaultUpgrades()`（同时永久失去修 bug 能力，要权衡） | 同左，并长期在页脚披露 |

**v1 的这句话必须在网站上原样出现：** 「第一版是中心化的：出块、中继、索引跑在同一台服务器上，是同一个信任域。我们能做的是把它能偷走的上限写死在 BSC 的合约里，并且让你在我们消失之后还能把钱领走。」

---

## 10. 交付物与排期

**交付物：** `contracts/`（8 个 BSC 合约 + 1 个字符串库 + 5 个层内创世合约 + Foundry 测试 + 部署脚本 + 两个验证 JSON）· `chain/`（genesis 生成脚本、docker compose、验证者节点包）· `relayer/` · `indexer/` · `web/`（静态站 + Vercel）· `sdk/`（TypeScript）· `node-cli/` · `scripts/`（`sim_launch.sh`、`verify_launch.py`、`e2e/run.sh`）· `docs/`（00–05）。

**排期（D0 是新增的，不能省）：**

- **D0**：钉死 geth 镜像 tag 并用一次性容器验证 Clique 能出第 1 块（G7）；核对 `chainId 56777` 未被占用；重测 BSC 块时间/gas price 并定新的 `PINNED_BLOCK`；重测 `VaultPortal`/`Portal` 的 launch 检查（Portal 已升到 v5.24.0）。
- **D1**：合约骨架 + 单元测试（金库/工厂先行）。
- **D2**：主网分叉测试（真实 `newTokenV6WithVault`）+ 不变量测试。
- **D3**：创世生成脚本 + 本地 geth + 5 个层内合约（「部署 → `eth_getCode`/`eth_getStorageAt` → 填 genesis → `geth init` → `cast call` 回读对拍」的闭环脚本，不靠人眼）。
- **D4**：relayer + indexer。
- **D5**：`artifacts/e2e/run.sh` 跑绿（11 步，结尾 `E2E PASSED`）+ 网站数据层。
- **D6**：服务器部署（docker compose + `ufw allow 80,443/tcp` + `30303/tcp,udp` + Caddy）。
- **D7**：`sim_launch.sh` → **[ASK]** 用户拍板 → 用户手工发射 → `verify_launch.py` → 切站。

**每一项仍需用户逐项点头：** 任何主网 `--broadcast`、`verify-contract`、Vercel deploy、发帖、在服务器上开端口（决策 #7/#8）。

---

---

## 11. 经济参数（模拟验证）

> **2026-09-23 重算通知。** 决策 #20（纪元 24 小时 → 10 分钟）、#24（退出改为拿 BAC、桥自动回购）、
> #25（锚点等待 24 小时 → 2 分钟）之后，本节 §11.1–§11.5 里**桥池侧的每一个常量与口径都已过时**。
> 新的、经模拟验证的参数集在 **§11.6**（2026-09-23），依据在 `artifacts/sim/RESULTS-buyback.md`。
> §11.1–§11.5 原文保留，被覆盖的行加了删除线，**任何实现都以 §11.6 为准**。

2026-09-22。本节的每一个数字都来自 `artifacts/sim/` 下可重跑的 Python 模拟，完整表格与拒绝理由见
`artifacts/sim/RESULTS.md`。桥池/金库每行 3000 条随机路径，参数扫描每格 2000 条。
**这是设计估算，不是合约测试结果** —— 下一步必须由 Foundry 不变量测试在真合约上复核（§11.5）。

模拟范围：一年（365 天 + 30 天预热），随机税收流入（`dead` / `modest` / `viral` 三条成交额曲线）、
随机见证人数、随机退出时点，外加穷举的对抗策略（拆号数 × 挂单方式 × 时点）。

### 11.1 三条被模拟推翻、必须改的机制

| # | 本文原来怎么写的 | 模拟发现 | 改成 |
|---|---|---|---|
| **M1** | §3.1：退出按「本纪元退出队列内」的积分份额分 `pot` | 队列里只有自己时，每积分兑付率是公平汇率的 **27 倍**；拆 10 个号、每纪元只挂 0.1% 的仓，**一年拿走桥池的 98%**。同纪元大户/小户横向差 **34.6 倍**。这是 某个更早的同类项目「2 只苍蝇拿走 0.2257 BNB」的同类问题，但严重得多 | **退出当场锁定汇率**（§11.2）。修正后先发倍数 **0.99x**、横向 **1.00x** |
| **M2** | §2 / §4.4 / §7.2：中继私钥被盗后「每纪元最多 0.2%–0.5% 的桥池」 | 这个上限建立在「`MAX_EXIT_SHARE_BPS` 是单**地址**上限」之上，而 agent 身份的边际成本只有 `ENTRY_DEPOSIT = 0.02 BNB` + BSC gas。cap 1000 时拆 10 个身份就完全饱和 | 口径改成 **每纪元最多 `RELEASE_BPS` = 2%–5% 的桥池**。实测：拆 40 个号、第 0 天全额挂出，3 个纪元搬走 **14%**、30 个纪元 **71%**。单地址上限**定性为减速带，不是安全边界**，网站与 FAQ 照实说 |
| **M3** | §5：「线性质押权重（拆号不赚不亏）+ `WEIGHT_CAP = 10 × MIN`」 | 这句话自相矛盾。线性权重确实中性，**加上上限之后拆号严格更赚**：押 6000 万时 k=1 拿 27.3%、k=3 拿 70.9%。`MAX_NODE_SHARE_BPS = 2500` 本身也制造同样的动机 | **删掉 `WEIGHT_CAP`**（权重 = 质押量）；保留该上限并改名 `MAX_VALIDATOR_SHARE_BPS`，**只用于分奖、不用于见证权重**，且分奖与见证都按地址去重；照实说它拆 4 个号就能绕过，边际成本 0.00055 BNB/月/节点 |

### 11.2 退出的锁定汇率口径（替换 §3.1 的队列分配）

`claimExit` 在该纪元结算时执行，全部数据都在 `BacBridge` 自己的 storage 里，**不需要相信层内任何东西**：

```
creditsOutstanding = totalCreditsIssued − totalCreditsExited
rate               = (address(this).balance − owedTotal) / creditsOutstanding
owed[agentId]     += credits × rate          // 积分当场全部销毁
owedTotal         += credits × rate
```

之后每个纪元：`pot_e = (poolBalance − reservedTotal) × RELEASE_BPS/1e4`（再被 `owedTotal − reservedTotal` 截断），按 `owed` 份额分配，
单地址单纪元不超过 `lastPot × MAX_EXIT_SHARE_BPS/1e4`，**被截掉的留在 `unclaimed` 里永不过期（不没收）**。

> **M4 修订（2026-09-22，对抗评审）：分配不再挂在逐纪元的 pot 上。**
> 旧口径里每个纪元有自己的 `pot/potLeft/owedSnapshot`，而 `collect(epoch, to)` 从不检查
> 「我的 `owed` 是不是在那个纪元结算之前就存在」—— 忍 30 天再退出的人可以在一个区块里
> 把 30 个未清扫纪元的 `potLeft`（约桥池的 45%–78%）全部取走。
> 现在改成 MasterChef 式单一累加器：`accPerOwed` / `owedDebt` / `unclaimed` / `reservedTotal`，
> 新锁定的 `owed` 按**当前** `accPerOwed` 记基准，**分不到它锁定之前的任何一笔释放**；
> 单地址上限变成「每地址每纪元最多领 `lastPot × 10%`」的速率限制。
> 详见 `01` §4.2 与「评审与修订记录」第 18 条。

**偿付不变式 I1（必须写成 `invariant_` 测试）：`owedTotal <= address(this).balance` 恒成立。**
归纳证明：锁定时 `Σ owed_new = rate × Σ C_i ≤ rate × creditsOutstanding = balance − owedTotal`；
付款同时等量减少 `owed` 与 `balance`；进账只增加 `balance`。
数值检查：3 种情景 × 2 种压力（常态 60 agent / 全员同日挤兑）× 3000 条路径 × 395 天，**零越界**，
最大浮点误差 9e-13 BNB，余额最小值恒为正。

**逃生通道必须同步改（否则 M1 打出一个洞）：** `escapeCollect` 现在的权重是 `credited − exitedCredits`，
而锁定汇率下「已退出但还没领完」的 agent 积分已销毁，它在这个权重里是 0 —— 停机那一刻归零。
必须改成：**先按 `owed` 足额兑付（它是已锁定的确定债权），剩下的池子再按 `credited − exitedCredits` 分。**

**M4 又给这条优先级加了一道门（attack-funds #3）：** `owed` 是从中继单方提交的 `exitRoot` 派生的，
所以停机时只有**在停机前已满 `OWED_MATURITY = 14 天`** 的 `owed` 享受优先级；
cause 1/4/5 下不成熟的在 `haltedAt + 14 天`后照样足额领，
**cause 2/3（有人 veto 了根 / 验证者多数否决了根）下永久降级为次级**，
任何人可调 `sweepImmatureOwed(who)` 把它推给次级累加器。
没有这道门，运营方发现中继被盗后的每一个「正确」动作（veto / 让验证者否决 / 武装逃生）
都是在替小偷解锁那笔钱。

### 11.3 验证过的常量（覆盖 §3.5 对应行）

> **本小节的 BacBridge 表已被 §11.6 覆盖（2026-09-23）。** 下面三行的旧值保留为删除线，只作历史。

**BacBridge（BSC）**

| 常量 | 值 | 相对 §3.5 | 模拟依据 |
|---|---|---|---|
| ~~`RELEASE_BPS`~~ | ~~**200 / 350 / 500**（每**纪元**）~~ → 见 §11.6：**`RELEASE_DAILY_BPS` 200/350/500，按**天**，再除以 `EPOCHS_PER_DAY = 144`** | ~~不变~~ **改** | ~~3 个纪元可搬走 14%（预算 15%）、30 个纪元 71%（预算 80%）~~ 旧值按每纪元解释，在 144 纪元/天下等于每天 288%，池子当天见底 |
| ~~`MAX_EXIT_SHARE_BPS` 1000（不可补领）~~ | **1000 + 新增 `MAX_CATCHUP_EPOCHS = 144`** | **改** | ~~持 10% 积分者 17 天拿到应付额九成~~ 那个 17 天是 **M4 之前**的引擎算的；按 M4 的 `reservedTotal` 累加器重算是 **31 天**。10 分钟纪元下若不补领，诚实用户要一天调 144 次 `collect`（§11.6） |
| 退出分配口径 | **锁定汇率（M1）** ~~（应付额以 BNB 计）~~ → **应付额改以 BAC 计**（§11.6） | **改** | 10 分钟纪元 + BAC 计价下重测：先发 **0.99x–1.06x**（p95 ≤ 1.08x）、同纪元横向 **1.00x**、盯着回购退出的择时优势 **1.00x**。见 `RESULTS-buyback.md` §1.1 / §1.2 |
| `pot` 的 leftover | **留在 `reservedTotal` 里，等人来领（M4）** | **改** | 滚进下一纪元的 pot 在队列口径下把先发优势从 1.72x 抬到 3.75x；退回让 `pot_e` 恒等于「一个纪元的释放额」，链上可独立核对 |
| ~~`CLAIM_WINDOW`~~ | **删除**（M4） | **改** | 它在 `01` 的旧规格里仍然是 `claimExit` 的硬截止，与本表「只管 pot」的说法直接冲突，而实现只会照 `01` 写。M4 之后 `claimExit` 没有任何时间窗口，`owed` 与 `unclaimed` 都永不过期；逐纪元的 `pot` / `sweepEpochPot` / `POT_SWEEP_DELAY` 整套机制一起删除，换成单一累加器 |
| `reservedTotal` 的约束 | `<= owedTotal` | **新增**（M4） | 旧的 `earmarkedTotal` 是单调棘轮：没人有动机调 `sweepEpochPot`，`freeForRelease` 单调收缩，约 60–70 个纪元后 `pot → 0`，桥池有钱、有债、但每纪元释放额是 0，而不变量 B3 照样成立（测试抓不到） |

**ValidatorStaking（BSC）**

| 常量 | 值 | 相对 §3.5 | 模拟依据 |
|---|---|---|---|
| `MIN_VALIDATOR_STAKE` | 2,000,000e18 | 不变 | 它是唯一真实的拆号成本 |
| `MAX_NODES` | 64 | 不变 | `dead` 情景自由进入均衡只有 2 个节点，64 只在 `modest` / `viral` 下才是约束 |
| ~~`WEIGHT_CAP`~~ | **删除** | **改**（M3） | 押 6000 万时上限让单节点份额从 36.1% 掉到 27.3%，纯粹制造拆号动机 |
| `MAX_VALIDATOR_SHARE_BPS`（原名 `MAX_NODE_SHARE_BPS`） | 2500 | 改名 + 缩小作用域，照实说可绕过 | 大户权重 76.9% 时实得 42.3%（cap 4000 → 49.7%、无 cap → 64.8%）。**2026-09-22 修订：它只约束分奖，绝不参与 `attestationResult` 的见证权重** —— 旧规格只有一个「权重」概念，上限会同时削掉诚实大户的异议阻力，把「强制 DISPUTED」的攻击成本打三折；同时分奖改成按 validator **地址**发，`nodeIdHash` 只用于展示 |
| `REWARD_RELEASE_BPS` | 500 | 不变 | 250 / 500 / 1000 的全年发出总额只差 7%（48.7 / 51.2 / 52.2 BNB）；500 对应约 20 天时间常数 |
| `VALIDATOR_BPS` | **4000（建议，需拍板）** | **新增** | 见 [待定] 1 |

**验证者成本与均衡（写进网站验证者页面，不写成收益）**

| 量 | 值 | 口径 |
|---|---|---|
| 单节点月成本 | **0.00889 BNB** | 机器 5 USD/月 = 0.00833 + BSC gas 0.00055（BNB = 600 USD、0.10 gwei、每纪元 commit+reveal 约 175k gas） |
| 打平所需日成交额 | 10 个验证者 **0.8 BNB/天**；64 个 **5.3 BNB/天** | 税 2% → 协议费 10% → 节点基金 50% → `VALIDATOR_BPS` 40% |
| 自由进入均衡人数 `N*` | `dead` **2** · `modest` **64（触顶）** · `viral` 远超 64 | `N* = 每月奖励注入 ÷ 成本线`（2x 成本线口径） |

### 11.4 桥池与兑付率的三句实话（必须进 FAQ 与网站规则卡）

> **2026-09-23：第 1、2、3 句都要按 §11.6 改写**（退出拿到的是 BAC，不是 BNB），
> 并且必须**新增第 4 句**（退出拿 BAC 比拿 BNB 至少贵 4%，其中约 1.8% 落进 owner 可提的节点基金）。
> 下面三句的机制描述仍然成立，只要把「BNB」换成「桥里回购来的 BAC」。

1. **进桥的 BAC 一分都不进桥池。** BAC 锁在 `BacBridge` 里，唯一出口是写死的死地址；
   桥池只由税收喂养。所以**进桥的 agent 越多，每积分对应的 BNB 越少**。
   实测（`modest` + 快速进桥）：兑付率从第 7 天到第 365 天跌到 **0.07 倍**。
2. **早退不等于占便宜，也不等于吃亏。** 锁定汇率让同一纪元退出的每个 agent 拿到完全一样的每积分兑付率（1.00x）；
   不同纪元之间的差别来自池子厚度的变化，不是抢跑。实测「第 180 天退 ÷ 第 7 天退」在 `viral` + 慢进桥下是 0.58x，
   晚退更划算的概率 15%。
3. **桥池分得穿但分不空。** 退出是按份额分池子，不是按面值兑付；`RELEASE_BPS` 保证任何一个纪元最多只走 2–5%。
   **不承诺任何金额，可能远低于投入价值。**

### 11.5 Foundry 不变量测试必须钉死的目标值

**决策 #17 的两个目标值（与下表并列）：**
- `FeeSplitter` 的 P1：任意操作序列后，合约余额 − （池子未领 + carryPool + 基金会未提）**恒为 0 wei**（不是「误差小于…」）。
- `已收 − 已转入 − 运营留底 == 待归集`：模拟 365 个纪元的归集与领取之后，这三个数必须与 `/api/fees` 返回的三个数逐 wei 相等（网站上那个对账面板本身也要被测试）。

对标 rat 的两层验证法（Python 设计模拟 2.1% → Foundry 真合约 2.17%）：

| 测试 | 目标 |
|---|---|
| 先发者兑付率 | `∈ [0.92, 1.10]`（模拟值 0.99x） |
| 同纪元大户(30%) / 小户(1%) 每积分兑付 | `== 1.00`（整数除法误差内，模拟值 1.00x） |
| 任一实体（含拆号）3 个纪元内可提取 | `≤ 15%` 桥池（模拟值 14%）。**M4 之后必须重跑**：旧模拟只覆盖「当期 pot」，而旧合约规格允许跨纪元回头领取（30 个未清扫的纪元 ≈ 桥池的 45–78%，一个区块可取完）。新增对照场景「攒 N 个纪元不领再一次性领」，目标是单区块提取额 `≤ lastPot × 10%`、与 N 无关 |
| 独占者兑付率倍数 | `≤ 1.10`（模拟值 0.83x） |
| `owedTotal <= address(this).balance` | 恒成立 |
| `Σ escapeShare` | `≤ 1`，且未付清的 `owed` 必须在内 |


### 11.6 2026-09-23 重算：10 分钟纪元 + 退出付 BAC（覆盖 §11.3 的 BacBridge 表与 §11.4 的资产口径）

决策 #20（纪元 24 小时 → 10 分钟）、#24（退出改为拿 BAC、桥用税收在市场上回购）、
#25（锚点等待 24 小时 → 2 分钟）把 §11.1–§11.5 的三个前提全改了：**时间步、付款资产、有没有人工反应窗口**。
本小节是重跑之后的参数集，完整表格、被拒方案与理由见 `artifacts/sim/RESULTS-buyback.md`
（`artifacts/sim/engine_epoch.py` + `sim_buyback.py`，每行 ≥ 2500 条随机路径，Q3 那张表 5000 条）。
**这是设计估算，不是合约测试结果**，两处必须在 fork 上复核见 `RESULTS-buyback.md` §6.4。

#### 11.6.1 付款口径：选 A（STOCK），另外两个被拒

| 口径 | 做法 | 结论 |
|---|---|---|
| **A `STOCK`（选中）** | 桥按有界预算持续回购、囤 `buybackBac`；退出当场按 **BAC 计价**锁定份额 `owedBac` | 先发 0.99x–1.06x（p95 ≤ 1.08x）、同纪元横向 1.00x、择时优势 1.00x、**退出本身对 BAC 价格的冲击恒为 0**、偿付不变式 `owedBacTotal ≤ buybackBac` 按构造成立（9 行 × 2500 条路径零越界） |
| B `JIT` | 退出按 BNB 计价锁定，`collect` 时现场把这笔 BNB 换成 BAC 发出 | **拒**。每次 `collect` 多约 120,000 gas（+76%），换币时点完全可预测（每个纪元边界之后）是标准三明治靶子，还可能撞上税币 `liquidationThreshold()` 再多约 300,000 gas；买盘也被推迟到 `collect` 才发生（30 天只投入市场 53.0 BNB，A 是 81.1） |
| C-1 `HYBRID` | BNB 计价的债 + BAC 存货 | **拒**。只要债是 BNB 计价而资产是 BAC，偿付不变式就随币价浮动：`modest` + 日波动 14% 时 **21.4%** 的路径出现「存货市值 < owedTotal」，缺口中位 25.0% |
| C-2 `HYBRID` | BAC 计价的债 + 领取时触发补买 | **拒**。偿付安全，但把回购的执行时点交给了任意调用者：单笔补买最大冲击 7.16%（A 是 0.89%），等于给桥装了一个「按需触发的大买单」按钮 |

**代价必须照实说（覆盖决策 #24b 的「约 4%」）：** 每 1 BNB 的交易税，旧口径给退出者 **0.4500 BNB**；
新口径下桥里 BAC 的中间价市值是 **0.4428（−1.60%）**，退出者若再换回 BNB 只剩 **0.4318（−4.05%）**。
这是单边滑点 0.5% 那一档；滑点 1% 是 **−5.02%**，滑点 2% 是 **−6.93%**。
**文案写「至少 4%，滑点大的时候到 7%」，不许写成「约 4%」一个数。**
而且这 4%–7% **不是烧掉，是转移**：买入税与卖出税各有 45% 流进 **owner 可提的官方节点基金**（合计约 **1.8%**），
约 0.4% 归 Flap，滑点归池子与其他 BAC 持有者，另有约 1.8% 通过买入税回流回桥池。
**「退出者每走一次市场约 0.9% 落进 owner 的节点基金，来回两趟约 1.8%」这句话必须和
§3.4「owner 可提节点基金这一半」写在同一段里** —— 这是决策 #24 带来的**新增利益冲突**。

#### 11.6.2 桥池常量（覆盖 §11.3 的 BacBridge 表）

| 常量 | 新值 | 旧值 | 依据 |
|---|---|---|---|
| `EPOCH` | **600**（10 分钟） | ~~86400~~ | 决策 #20 |
| `EPOCHS_PER_DAY` | **144**（新增） | — | 释放率的除数；不这么写就要在合约里存一个 1.3889 bps 的常数 |
| `RELEASE_DAILY_BPS` | **200 / 350 / 500**，按**天** | ~~`RELEASE_BPS` 200/350/500 按纪元~~ | 旧值在 144 纪元/天下等于每天 288%，池子当天见底 |
| 每纪元释放式 | `pot = (buybackBac − reservedTotal) × RELEASE_DAILY_BPS / (10000 × 144)` | ~~`× bps / 10000`~~ | 线性除法的实际日释放 1.9803%（目标 2%），偏保守 |
| 提取上限（旧验收线的按天重述） | 拆 40 个号、第 0 个纪元全额挂出：**3 天 13.60%（预算 15%）、30 天 71.53%（预算 80%）** | ~~3 纪元 14% / 30 纪元 71%~~ | 与旧引擎对得上。`300/500/800` 在 3 天到 **20.84%**、`500/750/1000` 到 **25.33%**，照旧被拒 |
| `MAX_EXIT_SHARE_BPS` | **1000**（不变，仍是减速带不是安全边界） | 1000 | — |
| `MAX_CATCHUP_EPOCHS` | **144**（新增） | — | 不加这一条，诚实用户要**一天调 144 次 `collect`**（一年 gas 0.4141 BNB）。加上之后单地址日均速率上限与旧口径逐字相同（每天最多领当日释放额的 10%），调用降回 1 次/天（一年 0.0029 BNB） |
| `NO_ATTEST_WINDOW` | **30 天**，实现为 30 个**按天聚合**的桶 `potRing[(epoch/144) % 30]` | ~~30（纪元）~~ | 不改的话这条上限从「30 天 ≤ 15%」变成「**5 小时** ≤ 15%」= 72%/天，等于完全失效 |
| `NO_ATTEST_WINDOW_BPS` | 1500（不变） | 1500 | 同上 |
| `OWED_MATURITY` | **14 days，明令禁止跟着纪元缩** | 14 days | 2 分钟等待之后它是停机逃生里唯一剩下的时间护栏 |
| `revokeEpochOwed(uint64 epoch)` | **新增**，暂停期间由 watchdog 调用 | — | 见 §11.6.4 |
| 付款资产 | **`buybackBac`**，`owed` 以 **BAC** 计价 | ~~BNB~~ | §11.6.1 |
| `lockedBac` | 只增不减，唯一出口 `burnLocked()` → `0x…dEaD`，**任何退出路径不得读写它** | — | 决策 #24a |

**回购参数（全部新增）**

| 常量 | 值 | 依据 |
|---|---|---|
| `BUYBACK_DAILY_BPS` | **2000**（每天花掉 BNB 桶的 20%） | 闲置 BNB 3.6%、滑点占回购额 0.214%。`5000` 把闲置压到 1.3% 但滑点升到 0.248%；闲置只是早退/晚退之间的再分配（先发 0.99x–1.06x 证明不显著），滑点是真烧掉，所以选 2000 |
| `MIN_BUYBACK_BNB` | **0.01 BNB**（预算攒够才买） | 一次 `buyback()` 约 220,000 gas ≈ 0.000011 BNB，占 0.11%。**节奏由它自适应**：`viral` 里几乎每个纪元都买，`dead` 里十几天才够买一次 |
| `BUYBACK_MIN_INTERVAL` | **1 个纪元** | 有了 `MIN_BUYBACK_BNB` 就不需要再钉一个间隔常数。按小时买一年 gas 0.096 BNB，按纪元买 0.578 BNB，自适应正好落在两者之间 |
| `MAX_BUYBACK_BNB` | **0.5 BNB / 次** | 深度 20 BNB 时冲击 2.4% —— 这是三明治的奖金上限 |
| `MAX_BUY_SLIPPAGE_BPS` | **300**（3%） | 真正起作用的护栏。深度 10 BNB 时 0.5 BNB 就会超 3% 而回滚，逼 keeper 拆小 |
| 触发方式 | **无许可，但绝不由 `claimExit` / `collect` 触发** | C-2 被拒的理由 |

#### 11.6.3 锚点与见证（覆盖 §11.3 之外的两处，和 §3.5 的对应行）

| 常量 | 新值 | 旧值 | 依据 |
|---|---|---|---|
| `ChainAnchor.EPOCH` | **600** | 86400 | 决策 #20 |
| `CHALLENGE_WINDOW` → **`ANCHOR_WAIT`** | **120 s** | ~~24 hours~~ | 决策 #25 + #18 的术语（不许再叫「挑战窗口」） |
| `COMMIT_WINDOW` | **0** | ~~2 hours~~ | **决策 #20/#25 承诺的「退出总耗时约 12–13 分钟」在旧值下根本做不到，真实是 2 小时 12 分。** 这个窗口的存在理由是「让见证人有 2 小时 commit」；见证改成事后批量之后理由消失 |
| `releaseBpsFor(epoch)` | 读**滚动 144 纪元窗口内的在册见证人数** | ~~读本纪元 `agreeingCount`~~ | 批量见证要到一天结束才上链，而 `settleEpoch` 在锚点 FINAL 后 2 分钟就能跑；不改的话每个纪元在结算那一刻永远是 0 见证人，释放档永远锁在最低档 |
| `STREAK_WINDOW`（veto / dispute 计数） | **30 天**（按天聚合的位图） | ~~30（纪元）~~ | 同 `NO_ATTEST_WINDOW`：30 个纪元从 30 天变成 5 小时。自动 watchdog 在 5 小时里 veto 7 次就把桥推进停机；反过来小偷每 5 小时发 6 个坏根可以永远不触顶 |
| `veto()` 的调用权 | **加上 watchdog（热钥）** | ~~只有 admin / vetoKey，且 `01` §6 写明 vetoKey 是冷钥~~ | 窗口只剩 120 秒，冷钥签不出来。代价：热钥被盗可以连续否决锚点、7 次触发停机 —— **这是拿 DoS 风险换盗窃风险，必须写进 §2 信任表** |
| `HALT_TIMEOUT` | **[待定] 需单独拍板** | 90 days | 10 分钟纪元下「90 天没有新的 FINAL 锚点」意味着链可以死 90 天才武装逃生。本轮没有模拟，只点名 |

**见证节奏（决策 #20a ② 的答案）**

| 节奏 | BSC 交易/天 | 成本线 BNB/月 | 纪元覆盖率 | 结论 |
|---|---|---|---|---|
| 每纪元 commit+reveal | 288 | **0.04615**（旧表的 5.2 倍，一年 0.55 BNB） | 100% | **拒**：`dead` 情景 `N* = 0.7 < 1`，跑节点是**必亏**的 |
| 抽样（每 N 个纪元见一次） | 288/N | 0.0086–0.0147 | 1/N | **拒**：其余纪元按 0 见证人算，释放档永远锁最低档，还踩 `NO_ATTEST_WINDOW` 的零见证上限 |
| **批量：每天 1 轮 commit+reveal，一轮带 144 个纪元的 Merkle 根** | **2** | **0.00925**（机器 0.00833 + gas 0.00091） | **100%** | **选中**。与旧表的 0.00889 只差 4% |

**成本与均衡（覆盖 §11.3 的验证者成本表，写进网站验证者页面，不写成收益）**

| 量 | 新值 | 旧值 |
|---|---|---|
| 单节点月成本线 | **0.00925 BNB**（批量见证） | ~~0.00889 BNB~~ |
| 自由进入均衡 `N*`（@2x 成本线） | `dead` **1.8** · `modest` **74.6（会被 `MAX_NODES = 64` 截顶）** · `viral` 远超 64 | ~~dead 2 / modest 79（64 触顶）~~ |

**运营方自己的年度账（不是验证者的）**

| 动作 | 频率 | BNB/年 |
|---|---|---|
| `postAnchor` 155,679 gas [实测] | 144/天 | 0.409 |
| `settleEpoch` 约 120,000 gas [估算] | 144/天 | 0.315 |
| `buyback()` 约 220,000 gas [估算] | 自适应，上限 144/天 | 0.096（按小时）– 0.578（按纪元） |
| **Flap Trigger Service 0.0002 BNB/次 [实测]** | **144/天** | **10.51 ← 必须避免** |

**`research/09-chain-truth.md` 里「一天一次纪元触发的年成本 ≈ 0.073 BNB」这句话是按旧纪元写的。**
按每纪元触发是 **10.51 BNB/年**，比中继全部 gas 加起来还贵一个量级。
**纪元推进不能挂在 Flap Trigger Service 上**，用我们自己的中继 cron（反正已经在跑）。

#### 11.6.4 2 分钟等待的真实安全口径（比决策 #21 / #25a 更严）

**被搬走的钱一直很小，那不是重点。** watchdog 探测延迟 10 s / 60 s 都能在 120 秒内赶上 `veto`，损失 **0**；
5 分钟就赶不上了，一个纪元的释放额被拿走（**0.0139%（2%/天档）/ 0.0347%（5%/天档）** 的资产桶）；
就算 24 小时没人发现，也只是送掉当天的释放额（1.98% / 4.88%）。

**真正的损失是被锁死的 `owed`。** `claimExit` 不动钱，它把**整个未占用资产桶**锁成小偷的债权，积分当场销毁。此后：

- **`pause()` 撤销不了已锁定的 `owed`。** `PAUSE_LEN = 7 天`、`MAX_PAUSE_TOTAL = 21 天` 一到期，
  小偷按日上限继续领：2%/天档 **180 天领走 97.4%**，5%/天档 **90 天领走 99.0%**。
- **`veto` 只在 `postedAt + 120 s` 之前可用**，错过就永久关闭。
- 停机逃生里「不成熟的 `owed` 降级为次级」只在 `haltCause == 2 或 3` 时生效，
  而上线时验证者是 0 个、veto 窗口只有 120 秒，**这两个 cause 实际上摸不到**，
  §11.2 的那道 `OWED_MATURITY` 保护在 2 分钟等待下等于不存在。

**因此必须同时做到三件事，缺一不可：**

1. **watchdog 是常驻自动程序，端到端探测延迟 ≤ 30 s**（预算：探测 L + 上链 I≈7 s + 30 s 余量 < 120 s ⇒ L ≤ 83 s；工程上轮询间隔取 ≤ 10 s）。
2. **`veto()` 必须允许 watchdog 调用，vetoKey 改成热钥**，并在 §2 信任表里写明它带来的 DoS 风险。
3. **新增 `revokeEpochOwed(uint64 epoch)`**：暂停期间由 watchdog 调用，把该锚点纪元里锁定的 `owed`
   整批作废并退回资产桶，被误伤的诚实 agent 凭修正后的根重新 `claimExit`。
   **没有这条路径，「暂停开关」这个兜底在数学上只是把损失推迟 7–21 天。**

#### 11.6.5 文案必须改的两句

1. **「退出总耗时约 12–13 分钟」是错的口径。** 12–13 分钟到的是**锁定汇率并开始领取**，不是拿到钱。
   第一笔钱要等**下一个** `settleEpoch`（≤10 分钟），且首笔最多是一个纪元释放额的 10%；
   持 10% 积分者把应付额领到九成要 **31 天**（这也顺带修正了 §11.3 那个 **17 天** —— 那是 M4 之前的引擎算的，
   按 M4 的 `reservedTotal` 累加器重算是 31 天）。
   正确写法：**「12–13 分钟后锁定汇率并开始领取，领完仍然要按每天最多 2%–5% 的速度慢慢领。」**
2. **§11.4 的三句实话要加第 4 句**：退出拿 BAC 比拿 BNB **至少贵 4%、滑点大时到 7%**，
   其中约 1.8% 落进 owner 可提的官方节点基金。**不许写成「退出更划算」。**


---

## 评审与修订记录

2026-09-22。三份对抗评审（`artifacts/design-options/attack-flap.md`、`attack-funds.md`、`attack-gate.md`）
对 `docs/00`–`docs/03` 提出 **46 条**（blocker 15 · high 21 · medium 7 · low 3）。
下表逐条给出**结论**与**一行修法**；「已修」表示修法已经写进规格本体（00/01/02/03），不是备注。
被两份报告同时点到的同一个问题只列一次，并在「来源」里写全。

**结论分布：已修 43 · 不成立/不修 1（flap A11）· 部分成立按替代方案处理 2（gate #7、gate #3 的罚没建议）。**

### 一、金库与工厂（`01` §0–§2、§9–§10）

| # | 来源 | 严重度 | 结论 | 一行修法 |
|---|---|---|---|---|
| 1 | flap A1 | blocker | **已修（部分成立）** | §1.3 原文结尾其实写了「返回 `(true,"")` 或 `(false, reason)`」，但表头写成「require 字符串」会让实现者写成九个 `require` —— 那样合法发射会因命名返回值默认 `false` 而 revert、非法发射会被 VaultPortal 显示成 `"Factory validation hook missing"`。已把表头改成「`reason` 字符串（用 `return (false, reason)`，永不 `require`）」并补上 rat `LabEscapeVaultFactory.sol:70-92` 形状的逐字骨架；§10 增加「`onBeforeLaunch(abi.encode(goodData))` 必须**返回** `(true,"")`」的断言。 |
| 2 | flap A2 | blocker | **已修** | `_retry()` 改成「先清零再推送，失败由 `_push` 的失败分支加回」；`01` §2.3 ④ 给出逐字实现，§2.6 加不变量 V8（可开关的 revert 下游 + 20 次 settle 后 `stuck* <= balance` 且 V1 成立）。原写法（成功才清零）每次失败重试都会把 `stuck*` 再加一遍，翻倍到超过余额后 `call` 永远返回 false，钱永久锁死。 |
| 3 | flap A3 | high | **已修** | `Portal.lockSalt` 从「（可选）」改成 `01` §9 ① 的**必做**步骤，并新增步骤 ⑨「发射前必须全绿的三项」（三个 `bacToken` immutable == 当场重算的 `T`、`cast code T` 为空、salt 锁定归 LAUNCHER）；文档写明 salt 一变要重部四个合约。 |
| 4 | flap A4 | high | **已修** | `BacVaultUI.describe` 在运行时读 `IBacNodeFund(nodeFund).owner()`（先查 `code.length` 再 try/catch，读不到渲染「读取失败」而**不回退成金库 owner**）；§1.6 / §2.5 的冻结文案改写成「由该合约的 owner 提取，链上读 `BacNodeFund.owner()`，它与本金库的 owner 是两个独立地址」；`00` §7.3 硬停加第 13 项，快照加 `nodeFund.owner`。 |
| 5 | flap A5 | high | **已修** | `taxDuration` / `antiFarmerDuration` 钩子看不见、工厂管不到（`research/01` §2.3 逐字确认）。`00` §7.3 硬停从 10 项加到 14 项：第 11 项查 `state()` 不是 `TaxFree` 且三个税率 == 200，第 12 项查 `antiFarmerDuration()` 等于计划值（`--strict` 下 exit 1）；`01` §9 要求 `sim_launch.sh` 删掉这两个字段的默认值。 |
| 6 | flap A6 | high | **已修** | 经 rat 编译产物实测证实门禁不可满足（金库 ABI 含 `UnsupportedChain`，工厂含四个，来源 `src/flap/VaultBase.sol:62`、`VaultFactoryBaseV2.sol:189/193`、`IVaultFactory.sol:22/25`）。§10 的规则 004 行换成两条可执行检查：① `grep -rn '^\s*error ' contracts/src --include='*.sol' | grep -v '/flap/'` 必须空；② `forge inspect` 的 error 集合必须是四项白名单的子集。§0 加一行说明这四个在 56/97 正常路径上不可达。 |
| 7 | flap A8 | high | **已修** | `settle()` / `retryPush()` 加进 `vaultUISchema().methods`（8 → 10，`inputs`/`outputs`/`approvals` 全为空数组，`isWriteMethod = true`，flap.sh 渲染成两个 Submit 按钮）；`vaultUISchema().description` 的「立即推走」改成「任何人都可以按 Settle 推走，没有人因此拿到报酬」；`00` §2 信任表的 Guardian 行同步改写，并加「官方索引器每纪元调一次」的运营承诺 + 告警。 |
| 8 | flap A9 | medium | **已修** | `_push` 里加 `require(gasleft() >= PUSH_GAS * 64 / 63 + 10_000)`，堵住「用恰好不够的 gas 调 `settle()` 把每笔收入打进 `stuck*`」。 |
| 9 | flap A10 | medium | **已修** | 三段冻结文案统一改成「税收 + 捐赠 + 强推余额 + 被没收的 agent 押金」都按同一比例分账。 |
| 10 | flap A11 | medium | **不修（设计选择，已披露）** | 金库不加 Guardian-only 的代币救援函数。规则 009 允许写，但冻结文案已经逐字承诺「没有任何救援函数」，加了就是自打脸；误转进金库的 BAC 会按 50/50 分成 BNB 之外的死账，这一点在 FAQ 里照实写。**代价：误转的代币拿不回来。** |
| 11 | flap A12 | medium | **已修** | `tokenCreationPolicies()` 从 6 条补到 8 条（加 `deflationBps` / `lpBps`）；第 9 条（`dividendToken != MAGIC`）是「不等于」语义，`FactoryPolicy` 只有等值 op，写成 `eq address(0)` 是假披露，**只留在钩子里**并在 §1.4 写明理由。 |
| 12 | flap A13 | medium | **已修** | `sweepForfeited()` 明确要求 `gasleft() >= 150_000` 并用 `call{value:}("")` 转发全部剩余 gas；禁止 `transfer`/`send`（2300 gas 会让它永久 revert，金库 `receive()` 冷路径约 47.8k）。§10 加一条反向测试。 |
| 13 | flap A14 | medium | **已修** | 删掉 `AgentRegistry` 里那个永远不会被赋值的 `address public immutable VAULT_SINK;`（它会直接编译失败），只留 `address public vaultSink;`。 |
| 14 | flap A15 | low | **已修** | `_push` 失败分支改成 `require(amount <= type(uint128).max)` + 无条件加回 `accounted`，并写明「加回 accounted 与累加 `stuck*` 要么都发生要么都不发生」（V10）。 |
| 15 | flap A16 | low | **已修** | 分账改成先算 `toNodeFund` 再 `toBridge = unsplit − toNodeFund`，取整余数**永远归桥池**（V11）。 |
| 16 | flap A17 | low | **已修** | `totalRecognized()` 给出公式（`lifetimeToBridge + lifetimeToNodeFund + accountedQuote`，无新增存储，V9）；写明 `settle()` 返回值与 `RevenueSplit` 是**分账额**，实际推出额以 `PushSucceeded`/`lifetimeTo*` 为准。 |
| 17 | flap A18 | low | **已修** | 冻结的 `_rules(...)` 补回「Flap 10% 协议费」这个数字和规则 001-h 要求的 justification 一句（50% 桶远高于建议的 3.0%，用途是服务器/签名节点/中继/验证者奖励池）。 |

### 二、桥的出金侧（`01` §4，M4 修订）

| # | 来源 | 严重度 | 结论 | 一行修法 |
|---|---|---|---|---|
| 18 | funds #1 | blocker | **已修（结构性重写）** | 逐纪元的 `collect(epoch, to)` + `epochs[e].pot/potLeft/owedSnapshot` + `sweepEpochPot` + `POT_SWEEP_DELAY` **全部删除**，换成 MasterChef 式单一累加器（`accPerOwed` / `owedDebt` / `unclaimed` / `reservedTotal`），单地址上限改成「每地址每纪元最多领 `lastPot × 10%`」的速率限制。原设计下攒 30 天再退出的人可以在一个区块里取走 30 个纪元的释放额（≈ 桥池 45–78%）。新增不变量 B15，§11.5 的三条验收线标注**必须按新口径重跑**。 |
| 19 | funds #2 / gate #2 | blocker | **已修** | `settleEpoch` 改成「该纪元已**定案**即可推进」：`VETOED`/`DISPUTED` 直接空转推进游标（pot = 0），`NONE`/`POSTED` 等 `SETTLE_GRACE = 7 天`后也能推进；新增 `skippedEpochs()` view 进 `/api/health` 并告警（连续 3 次）。不变量 B16。 |
| 20 | funds #3 | blocker | **已修** | 加 `OWED_MATURITY = 14 天`：停机时只有「在停机前已满 14 天」的 `owed` 享受优先级足额兑付；cause 1/4/5 下不成熟的在 `haltedAt + 14 天`后照样足额领，**cause 2/3（有人 veto 了根 / 验证者否决了根）下不成熟的 `owed` 永久降级**，任何人可调 `sweepImmatureOwed(who)` 推给次级。不变量 B18。 |
| 21 | funds #4 | blocker | **已修（两侧都改）** | 层内 `exit()` **不再接受调用者传的 `agentId`**，改成 `IL2Gate.agentIdOf(msg.sender)` 查表（不看 status，G11 语义完全保留）；BSC 侧 `claimExit` 加截断兜底（`attr = min(credits, credited−exitedCredits)`，余数进 `unattributedExited`）。不变量 B11（`exitedCredits[id] <= credited[id]`），B4 相应改写。 |
| 22 | funds #8 / gate #6 | blocker | **已修** | 删掉 `claimExit` 的 `CLAIM_WINDOW` 检查（`exitClaimed[exitId]` 已保证幂等，`exitRoot` 是终态，晚领只是按当时汇率自担风险）；`00` §3.5 与 §11.3 的 `CLAIM_WINDOW` 行同步删除，三处口径统一。SDK 侧「退出后未领取」列为唯一不允许丢的持久化状态（`03` §5.5 第 4 条）。 |
| 23 | funds #9 | high | **已修** | `pausedCumulative` + `MAX_PAUSE_TOTAL = 21 天`；达到即构成**停机触发 5**，`isPaused()` 返回值加 `cumulative` 并进 `/api/health` 与首页。不变量 B17。 |
| 24 | funds #10 | high | **已修** | `claimExit` 移出 `pause()` 的作用域（它一 wei 都不出金）；`pause()` 只挡 `collect`。配合第 22 条，这条自动消失。 |
| 25 | funds #11 | high | **已修** | `acceptRelease` / `sweepUntracked` 统一走 `_accept()`：**永远** `poolBalance += amount`，停机且 `escapeTotalWeight > 0` 时**另外** `accPerWeight += amount * 1e18 / weight`。不变量 B12/B13，并写明 `escapeTotalWeight == 0` 时那笔钱会永久留在合约里（不给 owner 开回收口）。 |
| 26 | funds #13 | high | **已修** | `EXIT_TYPEHASH` **去掉 `epoch` 字段**，`claimExit` 的第一个参数改名 `anchorEpoch`（只用于定位锚点）。四处同步：`01` §4.1、`01` §8.1、`03` §1.3、SDK/`node-cli`。被 veto 的纪元里的叶子重报进任何后续锚点都能证明。 |
| 27 | funds #14 | high | **已修（随 #18 消失）** | `earmarkedTotal` 的单调棘轮随逐纪元账本一起删除；新增 I2/B14（`reservedTotal <= owedTotal`），且 `owedTotal == 0` 时 `settleEpoch` 把取整尘埃清零。 |
| 28 | funds #17 | medium | **已修** | `claimExit` 加 `require(lockedWei > 0, ...)`；`03` 新增 `GET /api/rate`，SDK `exit()` 前必须读并在兑付率为 0 时警告。 |
| 29 | gate #7 | high | **部分成立，按方案 2 处理（披露而不是加功能）** | 定向审查确实无救济，已写进 `00` §2 信任表两行、§4.5 诚实条款 3、§7.2 新增失败模式 #15、`01` §4.2 末尾与网站 FAQ。**不做 BSC 侧强制退出队列**，理由写在 `01` §4.2：它无法让层内那份积分同时消失，没被审查的人可以先走强制退出、再在层内正常退出一次，两次都拿钱 —— 在没有层内证明的前提下，这个洞比它要补的问题更大。强制包含留给 §9 路线图的 v2。 |

### 三、锚点、验证者与停机（`01` §6–§7）

| # | 来源 | 严重度 | 结论 | 一行修法 |
|---|---|---|---|---|
| 30 | gate #1 / funds #6 | blocker | **已修** | `postAnchor` 的账本恒等式检查（旧第 9 条）**整条删除** —— 它是任何人花 21,000 gas（往 `L2Bridge` 转 1 wei）就能触发的永久停桥开关，第一笔带小费的交易也会触发，而且创世时 `circulating` 已等于 `OPERATOR_FLOAT`、`lastFinalCirculating` 初值 0，第一个锚点就 revert。承重的是第 7/8 条（只用 BSC 侧计数器）。`ChainAnchor` 新增构造参数 `initialCirculating`（C5 + §7.3 第 14 项），对账改到链下并改成恒成立的形式。 |
| 31 | gate #3 | blocker | **已修（罚没建议改为披露）** | ① `00` 与 `01` 对齐：**五条停机触发全部只能武装**，统一 `ESCAPE_ARM_DELAY = 14 天`；② `cancelEscapeArm()` 只有 `ChainAnchor.vetoKey()` 能调，**且只有触发条件本身已消失时才允许取消**（手动武装除外），不是自由裁量；③ `DISPUTED` 加两条绝对门槛（异议权重 ≥ 总质押 1/3、异议者独立地址数 ≥ 3，C6）。**v1 仍然不罚没**（`00` §6 切割线第 3 条是已定结论），代价按建议写进 `00` §2 信任表新增的「单个验证者」一行。 |
| 32 | gate #4 | blocker | **已修** | `postAnchor` 第 5 条从 `>` 放宽成 `>=`，并显式定义「层内零区块的空纪元锚点」形状；`02` §9 把「72 小时内恢复」改成「任何长度的停机都必须能补发」，e2e 加一条 30 小时停机用例。 |
| 33 | funds #5 | blocker | **已修** | `l2Block(epoch)` 给出**规范定义**（时间戳 < `(epoch+1)*86400` 的最大区块号），六个计数字段与 `exitRoot` 在 `(l2Block(epoch-1), l2Block(epoch)]` 上聚合，`circulating` 在该高度上读；逐字写进 `01` §6.2、`03` §1.3、`02` §6.3，SDK 暴露 `anchorMath.l2BlockFor`，要求三方 fuzz 对拍。并写明 `--state.scheme=path` 的 128 块 ≈ 6.4 分钟读取窗口这条运维约束。 |
| 34 | funds #7 | blocker | **已修** | `postAnchor` 的时间检查改成 `>= (epoch+1)*EPOCH + COMMIT_WINDOW(2h)`；`commitAttestation` 改成**只看时间**、不再看锚点状态 —— 窗口长度写死在合约里，中继碰不到。 |
| 35 | gate #8 | high | **已修** | `vetoStreak` / `disputeStreak` 从「连续计数 + FINAL 清零」改成 **30 个纪元的滑动窗口位图**（`uint32`，O(1)），常量改名 `VETO_LIMIT_PER_WINDOW` / `DISPUTE_LIMIT_PER_WINDOW`。 |
| 36 | gate #9 | high | **已修** | `01` §7 删掉 `WEIGHT_CAP`；明确区分 `attestWeight`（线性、无上限、**按地址去重**）与分奖（受 `MAX_VALIDATOR_SHARE_BPS = 2500` 约束）；不变量 S5。 |
| 37 | funds #15 | medium | **已修** | `settleEpochRewards` 加按序约束（`epoch == lastRewardEpoch + 1`）并复用桥的跳过规则；「余数」统一为「留在 `rewardBalance`」，与 `sweepExpired` 不再冲突（S2 成立）。 |
| 38 | funds #16 | medium | **已修** | `requestUnstake` 复查 `staked − amount >= MIN_STAKE × nodesOf(who)`（S4）；奖励按 validator **地址**发（`claimReward(epoch, validator)`），`nodeIdHash` 只用于展示与 strikes。 |
| 39 | gate #14 | high | **已修** | `00` §5 开头加「上线初期验证者很可能是 0 个」的逐字段落（同步进 `02` §6.5 与网站验证者页）；合约加不依赖任何人的兜底 `NO_ATTEST_WINDOW_BPS = 1500`（零见证时任意连续 30 纪元累计释放 ≤ 15% 桥池）；`[待定] 1`（`VALIDATOR_BPS`）标注**必须在 D1 之前拍板**；明确禁止「自己多跑两个验证者凑 QUORUM」。 |

### 四、门禁、层内与运维（`00` §4、`02`、`03`）

| # | 来源 | 严重度 | 结论 | 一行修法 |
|---|---|---|---|---|
| 40 | gate #5 | blocker | **已修（措辞级，但这是核心主张）** | `00` §4.2 第 4 条从「协议级闸门（真正硬的一条）」改写成「**一次性入金闸门，不是动作闸门**」，并列出层内唯一读身份的地方（只有 `AgentBook.announce`）；§4.3 补上「进场后把积分转给普通地址、此后手点做一切 —— 做得到且不可检测」；§4.1 的那句核心文案按评审建议逐字重写；浏览器必须给未注册地址的动作明显不同的样式。 |
| 41 | gate #13 | high | **已修** | `epochSeed` 改成**两阶段延后封存**（记锚点高度 → `SEED_SEAL_DELAY = 64` 块后才用那个块的哈希封存，256 块窗口，超时则该纪元不抽查、fail-open）；心跳加纪元内时限（封存后 `HB_WINDOW_BLOCKS = 600` 块 ≈ 4.5 分钟）。这两条落地之后，§4.1 那句「一直在线」才重新成立。 |
| 42 | funds #12 | high | **已修** | `L2Bridge.credit` 改成**拉取模式**（只写 `creditable[to] += amount`，零外部调用）+ 无许可的 `withdrawCredits(to)`；`AgentRegistry.register` 要求 `agentWallet` 自己的 EIP-712 签名且 `agentIdOfWallet == 0`；中继 outbox 新增 `parked` 状态（连续失败 N 次跳过并告警，不阻塞队列）。 |
| 43 | gate #12 / funds 补充 | high | **已修** | 重组善后改成**运营方在 BSC 上补 `lock` 等额 BAC**（无许可、不动用户积分、不需要新权力）；删掉「中继必须先在层内销毁多出的积分」这句不可执行的预案；另给 `L2Bridge` 加 `burnFloat()`（只能烧调用者自己的积分，供运营方主动缩表，**不是**重组手段）。 |
| 44 | gate #10 | high | **已修** | `compose.yml` 的 `--gcmode=archive` 改成 `--gcmode=full`（pathdb 不支持 archive，v1.13/v1.14 启动即 fatal）；新增 **D0-4** 验证这条；全量历史由索引器承担；`eth_call` 明确只支持最近 128 个区块的状态。`02` [待定] 3 结掉。 |
| 45 | gate #11 | high | **已修** | 把「Clique 签名者调 `gasLimit`」写成主要且唯一真实的控制手段（`02` §4.3 + §5.4 的应急流程 + 触发线），并写进 `00` §2 信任表；`--txpool.pricelimit` 从 1 gwei 改成 **0**；原先四条「缓解」在 `00` §6.4 与 `02` §4.3 照实降级成效果表（含「EIP-1559 在单签名者链上是攻击者的武器」）。 |
| 46 | gate #15 | medium | **已修** | `reissueChallenge` 要求已超时 + `REISSUE_COOLDOWN = 60 s`，**第三方调用不累加任何计数器**（R5）；没收条件写死为 `MAX_FAILED_ROUNDS = 10`；`CHALLENGED` 超 24 小时未激活则**押金原路退还**。 |
| 47 | gate #16 | medium | **已修** | 对账式改成 `diff = (issued − exited) − (layerCirculating + B_sink + B_signer)`（恒为 0），`/api/health` 单列 `feeSinkBalance` / `signerBalance`；`02` §4.1 补上「这个数会因 gas 燃烧持续下降」；签名者层内地址永久零出账列为硬性运营约束并加监控。 |
| 48 | gate #17 | medium | **已修** | `finalized` 取不到时兜底改成「深度 ≥ 1200 块 **且** ≥ 600 秒」；连续 10 分钟取不到则**停止发 `credit`** 并打 `bsc_finality_unavailable`（fail-closed）；配两个独立 BSC RPC 且要求一致。 |
| 49 | gate #18 | medium | **已修** | 退出的纪元归属**以 `ExitBurned` 事件的 `epoch` 字段为准**（逐字写死，三处实现一致）；`exit()` 加 `epoch` 单调不退的 sanity require；监控加「层内 head 与 BSC head 时间戳差 > 120 秒」并要求装 `chrony`；`00` §2 信任表补上「签名者可在 ±15 秒内选择时间戳，从而决定一笔退出属于哪个纪元」。 |
| 50 | gate L1 | low | **已修** | `03` §4.4 的 feed 事件清单删掉 M1 已废弃的 `ExitCarried`，换成 `OwedDemoted`。 |
| 51 | gate L2 | low | **已修** | `/rpc` 的 `eth_getLogs` 限 `toBlock − fromBlock <= 5000` 且必须带 `address` 或 `topics`；`rpcguard` 与索引写入拆进程；限制写进 `/api/health` 的 `rpc.limits`。 |
| 52 | gate L3 | low | **已修** | `00` §7.1 删掉「从 BSC 重放」这条不存在的重建路径，改成 `02` §9 的口径（datadir 全丢且无外部验证者 = 层内状态永久丢失，只能走逃生）；异机备份从 `[待定] 8` 升级为 **D6 硬前置**。 |

### 这一轮没有改、但必须记住的三件事

1. **`[待定] 1`（`VALIDATOR_BPS` 要不要合约强制分账）从「可以带到发射」变成「D1 之前必须拍板」。**
   理由是 gate #14：承诺-揭示是全设计里唯一制约中继 `exitRoot` 的东西，而它的燃料在 v1 是一句运营承诺。
   合约里已经加了不依赖任何人的兜底（零见证 30 纪元 15% 上限），但那是**损失上限**，不是**刹车**。
2. **`00` §8 页脚第 1 行、`description()`、`vaultDataSchema().description` 三处的中文措辞这一轮被改动了**
   （节点基金提取人、`settle()` 谁来调、定向审查无救济），按 `[待定] 3` 仍需用户逐字批准后才能部署 —— 部署即冻结。
3. **§11.5 的三条经济验收线必须按 M4 的累加器口径重跑**，旧模拟只覆盖「只能领当期 pot」的假设。

## [待定]

1. **验证者奖励要不要变成合约强制分账（模拟已给出数字，仍需你拍板）。** v1 按决策 #10 写成「节点基金归 owner 提取 + 运营方手动注入奖励池」。模拟结论（`artifacts/sim/RESULTS.md` 表 2.5 / 2.6）：`VALIDATOR_BPS = 4000`（节点基金的 40% 自动推给 `ValidatorStaking`，owner 只能提 60%）时，`modest` / `viral` 情景下 10 个验证者 100% 达标，`dead` 情景 64.5%；`2000` 在 `dead` 只有 25.3%，`6000` 能把 `dead` 抬到 89% 但更削弱决策 #10。**`VALIDATOR_BPS = 0`（现状）无法模拟 —— 这本身就是结论：v1 的验证者奖励不是机制，是承诺。** 建议改成 4000，但这削弱决策 #10，需要你拍板。
2. **`chainId = 56777` 是否被占用** —— 生成创世文件之前必须在 chainlist.org 与 github.com/ethereum-lists/chains 逐字搜；被占则退 56778，并提交登记 PR。链 ID 一旦出块不能改。
3. **页脚第 1 行、`description()`、`vaultDataSchema().description` 的最终中文措辞** —— 三处必须逐字一致，部署即冻结，需要用户逐字批准。
4. **买卖税定死为 2% / 2%** —— 本设计用 `==` 钉死；如果用户想要别的数字，hook、policies、手册、`sim_launch.sh`、`verify_launch.py`、fork 测试常量六处要同步改。
5. **名称 / 符号 / 简介 / Logo / 网站 / X 账号的最终字符串** —— 名称和符号发射后永远改不了（含大小写）。
6. **三个地址**：`LAUNCHER`（发射钱包，会被写进工厂 immutable，换钱包就只能重部工厂）、金库 `owner`、`BacNodeFund` 受益地址。
7. **是否用 `Portal.lockSalt(bytes32, TokenVersion)` 预定 `…7777` 地址** —— `BacBridge` 的 `bacToken` 是构造时写死的预测地址，salt 被别人占用就要重部桥。费用未知，需先 `cast call` 测。
8. **异机备份的存放位置**（对象存储账号或第二台机器）。
9. **浏览器外观** —— 需要 3–4 个 mockup + contact sheet 让用户选；rat 明确拒绝过 某个更早的同类项目 风格。
10. **SDK / node-cli 的发布方式** —— npm 组织名、包名、license、是否公开仓库（两个旧项目全是 `"private": true`，没有先例）。
11. **首买金额与发射时间**。
