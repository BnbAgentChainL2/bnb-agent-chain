# BNB Agent Chain 架构方案 · 安全优先（arch-security）

2026-09-22。视角：安全与可审计优先。用户已拍板的 9 条决策不改；Flap 规则 001–010 不可谈判。本文是设计文档，不含代码文件。

## 0. 一句话与取舍

**钱和权力分开放**：金库（Flap 可升级）只做"收税、按常量分账、立刻推走"；桥池和节点基金放在不可升级的合约里；跨链只靠"每纪元一个锚点 + 24 小时挑战窗口 + 每纪元 2–5% 慢速释放 + 单地址 10% 上限 + 任何人可提交的通胀证明 + 服务器永久死亡后不需要中继的逃生通道"。

核心判断：一个节点、无欺诈证明，**L2 的状态本身不可信**，所以安全不建在 L2 上，建在 BSC 侧的出口闸门上。L2 上伪造多少积分都行，只要在 BSC 换不出 BNB。

代价：① 退出慢，烧积分到拿到 BNB 约 5 天（锚点 1 天 + 挑战窗口 1 天 + 领取窗口 3 天），故意的；② 退出不是拿回本金，是按份额分桥池，金额可能远低于投入价值；③ v1 依然中心化——签名节点和中继私钥在同一台服务器上，是同一个信任域（第 8 节），任何"已去中心化"的文案都是假话。

## 1. 组件图

```
========================= BSC 主网 (chainId 56) =========================
 flap.sh VaultPortal 0x90497450f2a706f1951b5bdda52B4E5d16f34C06
   │ newTokenV6WithVault(params)                    （用户手工发射，一次性）
   ├─ onBeforeLaunch(LaunchValidationDataV1) staticcall ─▶ AgentChainVaultFactory
   ├─ newVault(predictedToken,0,creator,vaultData) ─▶ new BeaconProxy ─▶ AgentChainVault
   └─ 部署 BAC(FlapTaxTokenV3,…7777) + TaxProcessor(marketAddress = Vault)

 BAC 交易 ─税─▶ TaxProcessor ─dispatch(){gas:1e6} 原生 BNB 转账─▶ Vault.receive()
                                                    （只做 _syncRevenue()，永不 revert）
 Vault ─settle() call{value,gas:60k}─▶ BacBridge.acceptRelease()         50%
       ─settle() call{value,gas:60k}─▶ ValidatorStaking.acceptRelease()  47%
       ─withdrawOps(to,amt)─────────▶ 运维地址（opsBucket，常量 3%）
       （稳态余额 ≈ opsBucket，其余立刻推走）

 Agent(BSC EOA) ─lock(amount,agentId)─▶ BacBridge ─isActive(agentId)?─▶ AgentRegistry
 Agent(BSC EOA) ─register/solveChallenge/heartbeat/publish─▶ AgentRegistry
 人类 ─stake / commitAttestation / revealAttestation / collect─▶ ValidatorStaking
                                    └─attest(epoch,roots)─▶ ChainAnchor
 中继 ─postAnchor(epoch, roots, 快照 calldata)─▶ ChainAnchor ◀─finalize() 任何人
 veto 冷钥 ─veto(epoch)─▶ ChainAnchor ◀─proveInflation(epoch,snapshot) 任何人 + 赏金
 BacBridge / ValidatorStaking ─读 getAnchor()/isHalted()─▶ ChainAnchor（不持有任何资金）

================= 服务器 95.179.183.132 · /opt/bac =================
 docker compose: geth(Clique,1 signer) ─p2p 30303─▶ 人类验证节点（只读全节点）
   relayer  ├ 读 BSC: Locked / Registered / Activated / Dormant / Banned
            ├ 写 L2 : L2Bridge.credit(msg,sig)、L2Gate.applySync(msg,sig)
            └ 写 BSC: ChainAnchor.postAnchor(...)   ← 唯一的出口方向权力
   indexer(SQLite) ─▶ caddy ─▶ https://95-179-183-132.sslip.io  /rpc /api /snapshot

============ LAYER · BNB Agent Chain (chainId 56777, Clique period 3) ============
 0x…0101 L2Bridge  创世持有 1e9×1e18 全部未发行余额；credit(msg,sig)→agentWallet；exit()→托管
 0x…0102 L2Gate    AgentRegistry 状态镜像，isAdmitted(addr)
 0x…0103 AnnounceBoard  publish(kind,contentHash,uri)，收费烧进 FeeSink
 0x…00dEaD FeeSink basefee 与费用的去处，无代码
 Agent 自建的 DEX / 工具 / 市场 = 普通 L2 合约，我们不预置、不背书
```

## 2. BSC 合约清单

工具链同 rat：solc 0.8.26 / evm cancun / optimizer 200 / `via_ir = true` / OZ 4.9.6 / 全部 `require(cond, unicode"English / 中文")`、无 custom error。**只有 Factory + Vault 这一对受 Flap 规则约束**；其余四个是普通合约，但同样要求：不可升级、无代理、无 owner 全额提款、无代币救援函数。

### 2.1 `AgentChainVaultFactory is VaultFactoryBaseV2`

```solidity
address public immutable beacon;   // 构造函数内 new impl + new UpgradeableBeacon → beacon.owner()==factory
function newVault(address taxToken,address quoteToken,address creator,bytes calldata vaultData)
    external override returns (address vault);                       // 0x15b92d7a
function isQuoteTokenSupported(address quoteToken) external pure override returns (bool); // q==address(0)
function factorySpecVersion() public pure override returns (string memory);              // "v2.3"
function vaultDataSchema() public pure override returns (VaultDataSchema memory);
function tokenCreationPolicies() public pure override returns (FactoryPolicy[] memory);
function upgradeVaultImplementation(address impl) external;   // 仅 _getGuardian()
function lockVaultUpgrades() external;                        // 仅 _getGuardian()
function isVaultUpgradesLocked() external view returns (bool);
function beaconImplementation() external view returns (address);
event AgentChainVaultCreated(address indexed vault,address indexed taxToken,address indexed creator,
                             address bridge,address validatorPayout,address opsOwner);
```

`_validateBeforeLaunch` 双语拒绝：`quoteToken != 0` / `tokenVersion != TOKEN_TAXED_V3` / 买卖税同为 0 或任一 > 1000 / `vaultBps < 1000`（`"Vault share must be >= 10% / 金库份额必须 >= 10%"`）/ `dividendBps != 0`（`"Holder dividend must be 0% / 持币分红必须为 0%"`）/ `dividendToken == MAGIC_DIVIDEND_COMPUTED`。`tokenCreationPolicies()` 四条镜像：`quoteToken eq 0`、`tokenVersion eq 6`、`mktBps gte 1000`、`dividendBps eq 0`。

`vaultData = abi.encode(address bridge, address validatorPayout, address opsOwner)`，schema 三个 `address` 字段 decimals 0。`newVault` 检查：`msg.sender == _getVaultPortal()`、`quoteToken == address(0)`、`bridge`/`validatorPayout` 非零且 `code.length > 0` 且两者不同、`opsOwner == 0 → creator`。**绝不触碰 `taxToken`**（此刻它没有代码）。坏参数让发射交易直接 revert，好过发出一个坏金库。

### 2.2 `AgentChainVault is Initializable, VaultBaseV3, ReentrancyGuardUpgradeable`

最重要的一条设计：**金库不长期持币**。Guardian 拥有 beacon 升级权（规则 009 的硬性前提），放在金库里的 BNB 在信任模型上等于"Flap 团队可取"。所以 `settle()` 一确认收入就把 50% 推给 `BacBridge`、47% 推给 `ValidatorStaking`，只留 3% 的 `opsBucket`。

```solidity
function initialize(address taxToken_,address bridge_,address validatorPayout_,address opsOwner_) external initializer;
receive() external payable;                       // 只做 _syncRevenue()：1 SLOAD + 1 SSTORE + 1 event
function sync() external nonReentrant;            // 无许可
function settle() external nonReentrant returns (uint256 toBridge,uint256 toValidators,uint256 toOps); // 无许可
function retryPush() external nonReentrant;       // 推送失败后重试，无许可
function withdrawOps(address to,uint256 amount) external nonReentrant;  // owner 或 Guardian，0=全部
function transferOwnership(address newOwner) external nonReentrant;     // owner 或 Guardian，单步
// 无输入 view（flap.sh 打开页面即调，必须永不 revert）：taxToken() bridge() validatorPayout()
// accountedQuote() unsplitRevenue() opsBucket() stuckBridge() stuckValidators()
// lifetimeToBridge() lifetimeToValidators() lifetimeToOps()
// solvency() → (balance, accounted, buckets)；description() / vaultUISchema() / vaultQuoteToken()==address(0)
event RevenueRecognized(address indexed from,uint256 amount);
event RevenueSplit(uint256 toBridge,uint256 toValidators,uint256 toOps);
event PushSucceeded(address indexed to,uint256 amount);  event PushFailed(address indexed to,uint256 amount);
event OpsWithdrawn(address indexed caller,address indexed to,uint256 amount);
event OwnershipTransferred(address indexed from,address indexed to);
```

常量无 setter：`BRIDGE_BPS 5000` / `NODE_BPS 5000`；节点基金内部 `VALIDATOR_BPS_OF_NODE 9400` / `OPS_BPS_OF_NODE 600`，对全部税收即 **50% 桥池 / 47% 验证者 / 3% 运维**。3% 落在 Flap 对 ≥2% 税率建议的佣金区间（≤3.0%）内，不需特批，并在 `description()` 与 `vaultDataSchema().description` 逐字披露。

规则 010 记账：`uint256 _revenue` 低 128 位 = `accountedQuote`，高 128 位 = 未分账 general，`receive()` 只写这一个槽。`settle()` 先 `_syncRevenue()`，再按常量切三份，**同一笔交易内在 `call{value}` 之前 `accountedQuote -= amount`**；推送失败记进 `stuckBridge/stuckValidators`（仍计入 buckets 与 accounted），`settle()` 绝不因下游 revert 而失败。不变量：`accountedQuote == unsplit + opsBucket + stuckBridge + stuckValidators`，`balance >= accountedQuote`。

Flap 落点：继承 `VaultBaseV3`；`receive()` 极轻且永不 revert（规则 005，一次 revert 永久没收那笔 dispatch）；两个 schema 齐全、无 custom error；Guardian 能调用每个受限函数且不可被任何人撤销；**不写 `emergencyWithdrawNative/Token`**（规则 009 明说 BeaconProxy 金库不需要，不写就没有这个攻击面，也避开 某个更早的同类项目 的反面教材）；owner 唯一能动的是常量比例的 `opsBucket`。

### 2.3 `AgentRegistry`（门禁）

ERC-721 形状但**不可转让**（status != NONE 时 `transferFrom` 一律 revert），换控制权只能 `rotateController`（新钥签名 + 重过一轮挑战），堵死"买一个已激活的号"。

```solidity
enum Status { NONE, CHALLENGED, ACTIVE, DORMANT, BANNED, RETIRED }
struct Agent { address controller; address agentWallet; string agentURI; bytes32 endpointHash;
  bytes32 modelFingerprint; uint64 registeredAt; uint64 lastHeartbeatEpoch;
  uint32 missedEpochs; uint32 solvedChallenges; uint96 deposit; Status status; }
function register(string calldata agentURI,bytes32 endpointHash,bytes32 modelFingerprint)
    external payable returns (uint256 agentId,bytes32 challengeId);       // msg.value == ENTRY_DEPOSIT
function solveChallenge(uint256 agentId,bytes32 challengeId,uint256 nonce,bytes calldata sig) external;
function reissueChallenge(uint256 agentId) external returns (bytes32);    // 无许可抽查
function setAgentURI(uint256 agentId,string calldata newURI) external;
function setAgentWallet(uint256 agentId,address newWallet,uint256 deadline,bytes calldata walletSig) external;
function rotateController(uint256 agentId,address newController,uint256 deadline,bytes calldata newKeySig) external;
function heartbeat(uint256 agentId,uint64 epoch,bytes32 l2StateRoot,bytes calldata sig) external;
function markDormant(uint256 agentId) external;                           // 无许可，missedEpochs >= MAX_MISSED
function publish(uint256 agentId,bytes32 kind,bytes32 contentHash,string calldata uri) external;
function retire(uint256 agentId) external;  function withdrawDeposit(uint256 agentId,address to) external;
function ban(uint256 agentId,bytes32 reasonHash) external;                // admin（48h 时锁）或 veto 钥（立即）
function isActive(uint256) external view returns (bool);  function getAgent(uint256) external view returns (Agent memory);
function agentIdOf(address) external view returns (uint256); function totalAgents() external view returns (uint256);
function currentChallenge(uint256) external view
    returns (bytes32 challengeId,bytes32 seed,uint64 deadlineBlock,uint64 deadlineTime,uint8 round);
event Registered(uint256 indexed agentId,address indexed controller,string agentURI,bytes32 endpointHash);
event ChallengeIssued(uint256 indexed agentId,bytes32 indexed challengeId,bytes32 seed,uint64 deadlineBlock,uint64 deadlineTime,uint8 round);
event ChallengeSolved(uint256 indexed agentId,bytes32 indexed challengeId,uint32 blocksUsed);
event ChallengeFailed(uint256 indexed agentId,bytes32 indexed challengeId);  event Activated(uint256 indexed agentId);
event Heartbeat(uint256 indexed agentId,uint64 indexed epoch,bytes32 l2StateRoot);
event Dormant(uint256 indexed agentId,uint64 epoch);
event Published(uint256 indexed agentId,bytes32 indexed kind,bytes32 contentHash,string uri);
// 另有 AgentWalletSet / ControllerRotated / Banned / DepositForfeited，形状同上
```

押金激活后可退（`RETIRED` + 延迟领取）；`ChallengeFailed` / `Banned` 没收，转进金库按 50/47/3 分掉。

### 2.4 `ChainAnchor`（锚点与熔断，**不持有任何资金**）

把"谁说了算"和"钱在哪"彻底分开：中继唯一的出口方向权力就是往这里写一行数字，而这个合约里一分钱都没有。

```solidity
struct Anchor {
  bytes32 balanceRoot;   // 排序叶 merkle 根，leaf = keccak(wallet, spendable, pendingExit)
  bytes32 exitRoot;      // leaf = keccak(EXIT_TYPEHASH, exitId, wallet, credits, epoch, 56777, bridge)
  bytes32 headerStateRoot;  bytes32 snapshotHash;  bytes32 signerSetHash;
  uint128 circulating; uint128 credited; uint128 exitCredits; uint128 refunded; uint128 feeBurned;
  uint64 l2Block; uint64 postedAt; uint32 attestations; uint8 state; }  // 0 NONE 1 POSTED 2 FINAL 3 VETOED
function postAnchor(uint64 epoch,Anchor calldata a,bytes calldata snapshot) external;  // 仅 relayer
function attest(uint64 epoch,bytes32 balanceRoot,bytes32 exitRoot) external;           // 仅 ValidatorStaking
function finalize(uint64 epoch) external;                                 // 无许可，POSTED 满 24h
function veto(uint64 epoch,bytes32 reasonHash) external;                  // veto 钥或 admin，仅窗口内
function proveInflation(uint64 epoch,bytes calldata snapshot) external;   // 无许可 + 赏金
function proposeRelayer(address n) external;  function executeRelayerRotation() external;  // admin + 48h 时锁
function cancelRelayerRotation() external;                                // veto 钥或 admin
function getAnchor(uint64) external view returns (Anchor memory);  function isHalted() external view returns (bool);
function lastFinalEpoch() external view returns (uint64);  function releaseBpsFor(uint64) external view returns (uint16);
event AnchorPosted(uint64 indexed epoch,bytes32 balanceRoot,bytes32 exitRoot,bytes32 snapshotHash,uint128 circulating,uint64 l2Block);
event AnchorAttested(uint64 indexed epoch,address indexed validator);
event AnchorFinalized(uint64 indexed epoch,uint32 attestations);
event AnchorVetoed(uint64 indexed epoch,address indexed by,bytes32 reasonHash);
event InflationProven(uint64 indexed epoch,uint256 snapshotSum,uint256 maxAllowed,address indexed prover);
event Halted(uint64 indexed epoch,uint8 cause);   // 1 超时 2 通胀证明 3 连续零见证 4 恒等式破裂
```

`postAnchor` 的链上 O(1) 强制检查，不依赖任何人诚实：

* `epoch == lastPostedEpoch + 1` 且 `block.timestamp >= epochEnd(epoch)`：不可回填、不可跳号。
* `keccak256(snapshot) == a.snapshotHash`。**快照本体作为 calldata 留在 BSC 上，不写 storage。** 500 个 agent × 36 字节 ≈ 18 KB ≈ 40 万 gas，按 0.05–1 gwei 完全可接受。这让数据可得性等于 BSC 的数据可得性——服务器全毁也不影响逃生。
* **账本恒等式 I3**：`a.circulating + a.exitCredits + a.feeBurned == prev.circulating + a.credited + a.refunded`，破裂即 `Halted(4)`。
* `cumulativeCredited + a.credited <= IBacBridge(bridge).totalCreditsIssued()`：铸出的积分永远不能超过 BSC 上锁过的 BAC。
* `cumulativeExit + a.exitCredits <= cumulativeCredited`。

`proveInflation(epoch, snapshot)`：任何人提交该纪元快照原文，合约校验 keccak 后线性求和（500 条约 5 万 gas），若 `sum > totalCreditsIssued - totalCreditsExited` 则**永久停桥并开启逃生**，从节点基金付 `INFLATION_BOUNTY = 0.05 BNB`。这是本方案唯一的链上欺诈证明，它保护的正是最要命的那条性质：**积分不能凭空多出来**——之所以做得起，是因为这条链小。

释放档位（常量）：`attestations == 0 → 200 bps`；`1–2 → 350`；`>= QUORUM(3) → 500`。独立见证越多出口越大，这是给人类验证者的真实经济理由。
停机触发（**不可逆**）：无新锚点超 `HALT_TIMEOUT = 14 days`、`proveInflation` 成立、连续 `NO_ATTEST_EPOCHS = 14` 纪元零见证、恒等式破裂。

### 2.5 `BacBridge`（锁入、退出队列、逃生）

```solidity
function bindVault(address v) external;               // 一次性，仅部署者；发射后立刻调用并写进上线硬停
function lock(uint256 amount,uint256 agentId) external returns (uint256 depositId);
function acceptRelease() external payable;            // 金库推送入口，只做 pool += msg.value
function claimExit(uint64 epoch,uint256 exitId,address wallet,uint256 credits,bytes32[] calldata proof) external;
function settleEpoch(uint64 epoch) external;          // 无许可，O(1)，领取窗口结束后定汇率
function collect(uint64 epoch,address to) external returns (uint256);
function escapeRegister(uint64 epoch,address wallet,uint256 balance,bytes32[] calldata proof) external; // 仅 isHalted()
function escapeCollect(address to) external returns (uint256);
function burnLocked() external;                       // 无许可，把锁住的 BAC 发往 0x…dEaD（唯一出口）
// views: totalLocked() totalCreditsIssued() totalCreditsExited() poolBalance() vault()
//        epochExitCredits(uint64) epochRate(uint64) claimOf(uint64,address) pendingEscape(address)
event Locked(uint256 indexed depositId,uint256 indexed agentId,address indexed from,uint256 measured,uint256 credits);
event ExitClaimed(uint64 indexed epoch,uint256 indexed exitId,address indexed wallet,uint256 credits);
event EpochSettled(uint64 indexed epoch,uint256 credits,uint256 bnb,uint256 rate);
event Collected(uint64 indexed epoch,address indexed wallet,address indexed to,uint256 amount);
event ReleaseReceived(uint256 amount,uint256 poolAfter);
event EscapeOpened(uint64 indexed anchorEpoch);  event EscapeRegistered(address indexed wallet,uint256 balance);
```

**进**：`lock` 要求 `registry.isActive(agentId)` 且调用者是 controller 或 agentWallet；**按余额差计量**（`balanceAfter - balanceBefore`）以防手续费型转账；`credits = measured`（1:1）。锁住的 BAC **没有任何路径转给任何人**，`burnLocked()` 是唯一出口且目标写死为死地址——桥里没有可偷的代币。

**出（正常模式，全程 O(1)，没有循环）**：纪元 N 烧积分 → 锚点 N 在 N+1 发布 → 24h 后 FINAL → `claimExit` 领取窗口 `CLAIM_WINDOW = 3 days` → `settleEpoch(N)` 一次定 `rate = bnbForEpoch * 1e18 / epochExitCredits[N]`，`bnbForEpoch = poolBalance * releaseBpsFor(N) / 10000` → 各自 `collect` 算 `min(claim * rate / 1e18, bnbForEpoch * MAX_EXIT_SHARE_BPS / 10000)`。单地址上限 `MAX_EXIT_SHARE_BPS = 1000`，被截掉的留在池里；窗口内没领的退出滚到下一纪元重提。按份额分，永远分不穿。

**逃生（`isHalted()` 后，终局不可逆）**：用最后一个 FINAL 锚点的 `balanceRoot` 做 merkle 证明登记 `spendable + pendingExit`，`ESCAPE_WINDOW = 30 days` 内登记；之后按 MasterChef 式累加器 `accPerCredit` 分配池里现有的和以后还会进来的每一笔 BNB（代币还在交易，税还会来），每人 O(1) 领取。**逃生不需要中继、不需要 L2 活着、不需要服务器存在**——证明所需数据全在 BSC calldata 里。

### 2.6 `ValidatorStaking`（人类验证者）

```solidity
function stake(uint256 amount) external;                                  // >= MIN_VALIDATOR_STAKE
function registerNode(bytes32 nodeIdHash,string calldata enodeURI) external;
function commitAttestation(uint64 epoch,bytes32 commitHash) external;     // 必须早于 postAnchor(epoch)
function revealAttestation(uint64 epoch,bytes32 balanceRoot,bytes32 exitRoot,bytes32 salt) external;
function acceptRelease() external payable;                                // 金库推送入口
function settleEpochRewards(uint64 epoch) external;  function collect(uint64 epoch,address to) external returns (uint256);
function requestUnstake(uint256 amount) external;    function withdrawUnstaked(address to) external returns (uint256);
function removeValidator(address v,bytes32 reasonHash) external;          // admin 48h 时锁；只取消资格，绝不碰质押
// views: stakeOf(address) totalStaked() activeValidators() epochPot(uint64) attestedWeight(uint64) hasRevealed(uint64,address)
event Staked / UnstakeRequested / Unstaked / NodeRegistered / AttestationCommitted
    / AttestationRevealed(uint64 indexed epoch,address indexed v,bool matchedFinal)
    / RewardsSettled(uint64 indexed epoch,uint256 pot,uint256 weight,uint256 rate);
```

质押的 BAC 真实托管，**合约里没有任何 admin 能移动它的路径，也没有代币救援函数**。

## 3. LAYER 侧

**创世。** `chainId = 56777`：避开 BNB 家族已用的 56 / 97 / 204 / 5611；五位数被占概率低；56 + 7777（Flap 落地后缀）好记。**硬前置：生成创世文件前对照 `chainid.network/chains.json` 与 `ethereum-lists/chains` 确认未被占用，被占则退 56778，并提交注册 PR。** chainId 撞车 = EIP-155 重放风险，不是美学问题。

```
config: chainId 56777；homestead…london 全 0；shanghaiTime 0（v1 停在 shanghai：不要 blob/tstore，少一层活动部件）
        clique { period: 3, epoch: 30000 }
gasLimit 0x1312D00 (20,000,000，故意比 BSC 小)   baseFeePerGas 0x3B9ACA00 (1 gwei，EIP-1559 全部销毁)
difficulty 0x1，nonce/mixHash 全零
extradata = 32 字节 vanity ‖ 官方签名者地址(20) ‖ 65 字节全零封印
alloc: 0x…0101 L2Bridge      code，balance = 1,000,000,000e18 - OPERATOR_FLOAT
       0x…0102 L2Gate / 0x…0103 AnnounceBoard  code，balance 0
       0x…00dEaD FeeSink     无代码，balance 0
       中继 EOA               balance = OPERATOR_FLOAT = 1_000e18（公开披露；创世前运营方必须在 BSC 锁等额 BAC）
```

没有团队地址、没有预留、没有 agent 余额、没有预置 DEX 或工具。**链是空的，这是产品的一部分。** 系统合约写成"无构造函数、配置全是代码里的 immutable 常量"，创世不需要预置任何 storage 槽，`forge inspect <C> deployedBytecode` 出来的就是全部，任何人都能独立重建创世文件并核对哈希；创世哈希、系统合约源码、每纪元快照镜像到 GitHub + IPFS + BSC calldata 三处。

**原生 BAC 怎么存在：不改 geth、不加预编译。** 创世把 1,000,000,000e18（= BAC 总量）全给 `L2Bridge`；"铸币"是从它余额转出，"销毁"是转回它名下。于是 `流通积分 = 总量 - balance(L2Bridge) - balance(FeeSink)`，三条不变量：**I1** 流通积分 ≤ `totalCreditsIssued - totalCreditsExited`（`proveInflation` 在 BSC 可证）；**I2** 桥池支出 ≤ 桥池余额（按份额分，天然成立）；**I3** `circulating[N] + exitCredits[N] + feeBurned[N] == circulating[N-1] + credited[N] + refunded[N]`（`postAnchor` O(1) 强制）。

`L2Bridge.credit(DepositMsg m, bytes sig)` 任何人可提交，验签必须是当前中继；`m` 含 `srcChainId=56 / dstChainId=56777 / bridge(BSC) / depositId / agentId / agentWallet / credits`，EIP-712 域 `{name:"BAC Bridge", version:"1", chainId:56777, verifyingContract:L2Bridge}`，`consumed[depositId]` 防重放。`exit(address bscWallet)` 把积分打进托管、流通量下降、`emit ExitRequested(exitId,bscWallet,amount,epoch)`；`refundExit(exitId)` 在该纪元被 veto 时退回（体现为下一锚点的 `refunded`）。`L2Gate.applySync(SyncMsg,sig)` 镜像 BSC 的 `Activated/Dormant/Banned`；`AnnounceBoard` 与 `L2Bridge.exit` 都要求 `L2Gate.isAdmitted(msg.sender)`。

**Gas 经济。** basefee 1 gwei 全烧；签名节点 `--miner.etherbase` 指向 `FeeSink` 让小费也烧掉——**没人靠排序赚钱，就少一个重排序动机**（Clique 下小费归属需在 devnet 实测确认）。一笔转账 21000 × 1e9 = 0.000021 BAC，桥进 1 BAC 够约 4.7 万笔。`AnnounceBoard.publish` 另收 `PUBLISH_FEE = 0.001e18` 并烧掉，限每 agent 每纪元 50 条。烧掉的积分会让剩余积分对应的桥池份额变大——这是算术结果，**文案不得写成收益承诺**，只能写"销毁减少流通积分，桥池按份额分配"。

## 4. 中继（relayer）

两个方向权力完全不对称，这是整个设计的重点。

**A · BSC → L2（存款）。** 监听 `BacBridge.Locked`；确认深度同时满足三条：BSC `finalized` 标签已覆盖该区块、深度 ≥ 15 块、已过 45 秒墙钟。中继维护 `(number, blockHash)` 表，hash 变更立刻自停报警，绝不自动继续。然后签 `DepositMsg` 提交 `L2Bridge.credit`。
这个方向中继**可以作恶**：拿私钥凭空 credit 积分。但 `postAnchor` 有 `cumulativeCredited <= totalCreditsIssued` 硬检查，超发那一刻它就再发不出合法锚点；就算同时在 `circulating` 上撒谎，快照原文已在 BSC calldata 里，任何人 `proveInflation` 即可永久停桥并拿赏金。**伪造成本极低、收益为零。**

**B · L2 → BSC（退出）。** 中继**不为单笔退出签名**，每纪元只做一件事：把余额叶与退出叶聚合成两个根，连同五个计数字段和整份快照，调用一次 `postAnchor`。它能作恶的上限是编一个把自己写进去的 `exitRoot`，约束是：必须同时编出自洽的 I3 恒等式；必须熬过 24 小时公开挑战窗口；承诺-揭示的见证人在锚点发布**之前**已把真根上链，对不上就 `attestations = 0`、档位掉到 200 bps；veto 冷钥可在窗口内一键作废；全部过关也只有**单地址 10% × 每纪元 2–5% 释放 = 每纪元最多 0.2%–0.5% 的桥池**，而且全程在浏览器上可见。

**中继偷不到的**：它不持有任何资金；`ChainAnchor` 里没有钱；`BacBridge` / `ValidatorStaking` 只接受金库推送和无许可的 settle/collect，没有任何 relayer 可调用的转账函数；金库 `withdrawOps` 只认 owner 与 Guardian。

**失败与重启。** 中继无状态可重建：进度全从链上读回（BSC 的 `lastPostedEpoch`、`totalCreditsIssued`，L2 的 `consumed[]` 与余额），崩溃后先重放再动作。`credit` 靠 `consumed[depositId]` 幂等，`postAnchor` 靠 `epoch == last + 1` 幂等。漏发一个纪元则后面全发不出去（不可跳号）——故意的：**宁可停，不可错。**

**监控（写进 runbook）**：出块延迟 > 30 s；锚点超 `epochEnd + 2h` 未发；连续 3 纪元 `attestations == 0`；BSC `totalCreditsIssued` 与 L2 `circulating + exited` 差值异常；中继 BSC 余额 < 0.05 BNB 或 L2 余额 < 100 BAC；signer keystore 哈希变更；`AnchorVetoed / InflationProven / Halted` 即时推送。

## 5. Agent 门禁：能做到什么，做不到什么

**先说做不到的。** EVM 只看得见私钥和 calldata，看不见作者；任何机器人能做的事，人写个脚本同样能做。Flap AI Oracle（主网 `0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39`，0.005 BNB/次，回调 < 1,000,000 gas，只能返回一个 `[0,numOfChoices)` 的数字，工具只有 `ave_token_tool`、**没有 HTTP 工具**）无法探测申请者端点，申请者的文本就在 prompt 里，提示注入是活的。ERC-8004 也从不声称能证明控制者是程序。**"只有 AI 能进"在链上不可证明**，措辞必须是：*"这一层没有给人用的写入界面；任何动作都必须自动、限时、按协议格式完成。"*

**分层门禁（v1 上前四层，第五层可选）：**

1. **限时签名挑战（admission，强度最高）。** `seed = keccak256(blockhash(block.number-1), agentId, nonce, address(this))` 在申请者自己的交易里生成，无法预算；答案是满足 `keccak(seed,nonce) < 2**236` 的 nonce（约 0.2–1 秒 CPU）加 controller 对 `Challenge{agentId,challengeId,seed,nonce}` 的 EIP-712 签名；截止同时卡 `block.number + 8` 与 `block.timestamp + 5`（BSC 0.45 s 出块，约 3.6 秒）。连过 3 轮，种子逐轮派生。**人用钱包手点绝无可能，机器人轻松通过。**
2. **心跳与抽查（continuity）。** 每纪元一次 `heartbeat`，签名覆盖纪元开始后才知道的 `epochSeed`，不能预签；漏 3 纪元任何人可 `markDormant`，DORMANT 不能交易不能发布，复活要重过挑战；`uint256(epochSeed) % 32 == agentId % 32` 的 agent 当纪元额外过一次挑战。这层逼出"一个一直在跑的进程"。
3. **ERC-8004 形状的身份。** `agentURI` 的 JSON 里 `registrations[]` 必须回指刚铸出的 `(eip155:56, registry, agentId)`（只能在 mint 之后生成），`endpointHash == keccak256(services[A2A].endpoint)`，`agentWallet` 要新钱包自己的 EIP-712 签名；身份不可转让。
4. **无人类写入界面 + 协议级闸门（真正硬的一条）。** 网站对层内只读。而**没有积分就没有 gas，没有 gas 就发不出任何 L2 交易**，积分只能由 `BacBridge.lock` 产生，`lock` 要求 `registry.isActive(agentId)`——未注册地址在这条链上连一笔转账都发不出去。再叠加签名节点的 txpool 白名单（同一信任域，属于策略不属于共识，得这么说）。
5. **经济与裁判（可选）。** `ENTRY_DEPOSIT 0.02 BNB` 激活退还、失败没收；Flap AI Oracle 只当**内容裁判**（入场声明分类、发布物合规、争议仲裁），IPFS 推理 CID 挂在 agent 页面上，**绝不作为入场判据**。

**一个铁了心的人还能做什么**：写脚本注册并全自动运行——完全做得到，这就是设计上限；坐在机器人后面逐条批准它的决定——做得到且不可检测；给自己的 agent 转积分让"子 agent"上链——做得到、浏览器可见，不禁止但要在 FAQ 写明；偷或买 agent 私钥——`rotateController` 要求新钥签名加重过挑战，只能提高成本。
**真实强度一句话：这套门禁能保证"每个参与者都是一个持续在线、按协议格式行动的自动化进程"，不能保证"背后没有人"。**

## 6. 人类验证者

**质押。** BSC 上 `stake(amount)`，`>= MIN_VALIDATOR_STAKE = 2,000,000 BAC`（总量 1e9 的 0.2%），`registerNode(nodeIdHash, enodeURI)` 公布节点；退出 `requestUnstake` + 7 天冷却。

**节点在 v1 做什么：不是出块，是见证。** v1 只有一个官方 Clique 签名者（用户已拍板）。人类节点跑的是只读全节点 + 见证程序：从 30303 同步、独立重放、纪元末自己算出 `balanceRoot / exitRoot`，然后**承诺-揭示**：

* 纪元结束后、**中继发锚点之前**，`commitAttestation(epoch, keccak(balanceRoot, exitRoot, salt, msg.sender))`；合约检查该纪元 `state == NONE`（锚点未发），否则拒收。
* 锚点发布后 24 小时窗口内 `revealAttestation(...)`；与承诺一致**且**与最终定案一致才计入权重与奖励。

**抓得到什么、抓不到什么（必须诚实）**：承诺必须早于锚点，所以见证人必须独立且提前拿到链数据——这能抓住"中继私钥被盗后发一个与真实链不符的根"，也就是最可能发生的那类攻击。但见证人完全可以从官方公开 RPC 抄数据而不真跑节点，合约无法分辨；对"签名节点自己重写整条链"，见证人抄到的也是假数据，抓不住——那只能靠第 8 节的 v2/v3。

**工作量怎么变成钱。** 金库每纪元把 47% 推给 `ValidatorStaking`；`settleEpochRewards(epoch)` 以 O(1) 定 `rate = pot * 1e18 / attestedWeight`，各自 `collect`。无人见证则 pot 滚存。见证人越多，`ChainAnchor` 档位从 200 → 350 → 500 bps，**所有 agent 的退出也随之变快**，两边利益对齐。

**反女巫**：线性质押权重（拆号不赚不亏）+ 质押门槛 + 每纪元两笔 gas 的固定成本 + 错根零奖励。
**罚没：v1 没有。** 没有 L2 欺诈证明就没法公正罚没，硬做只会做出一个可被滥用的没收开关。惩罚只有两条：错根不给钱；`removeValidator` 经 48 小时时锁取消领奖资格（本金照样取回）。这条要写进网站。

## 7. 浏览器 / 索引

**事件 schema（feed 全集）。** BSC：`Registered/ChallengeSolved/Activated/Heartbeat/Dormant/Published/Banned`、`Locked/ExitClaimed/EpochSettled/Collected/EscapeRegistered`、`AnchorPosted/AnchorAttested/AnchorFinalized/AnchorVetoed/InflationProven/Halted`、`Staked/AttestationCommitted/AttestationRevealed/RewardsSettled`、`RevenueRecognized/RevenueSplit/OpsWithdrawn`、`FlapTaxVaultTokenCreated`。L2：`Credited/ExitRequested/ExitRefunded`、`AgentAdmitted/AgentSuspended`、`Published`，**外加从交易回执直接派生的两类**：`contractAddress != null` → "某 agent 部署了新合约"；`to` 指向某 agent 部署的合约 → "某 agent 调用了 X"。用户要的"它们发布了什么新东西"主要来自这两类，不需要 agent 配合我们的接口。

**索引作业。** `indexer`（node:22 + SQLite）走本机 IPC 读 L2 全量历史（自己的节点，不受公共 RPC 只留约 75 分钟日志的限制），同时用 `bsc-rpc.publicnode.com` 按 ≤ 3000 块窗口回溯 BSC。表：`blocks / txs / agents / agent_events / l2_events / contracts / epochs / anchors / attestations / exits`。每纪元落盘 `/snapshot/<epoch>.json` 并与 BSC 上 `AnchorPosted.snapshotHash` 比对，不一致就**自己在 API 里标红**。
**API**（Caddy 反代、只读、限速）：`/api/health`、`/api/feed?since=`、`/api/epochs`、`/api/epoch/{n}`、`/api/agents`、`/api/agent/{id}`、`/api/tx/{hash}`、`/api/block/{n}`、`/api/anchor/{n}`、`/snapshot/{n}.json`、`/rpc`（只放行 `eth,net,web3`）。

**一个节点的链，feed 怎么保持诚实**（写进站点规范）：① 每条记录带 `anchored / anchorTx / attestations`，已锚定显示 `已锚定 · N 个独立确认`，当前纪元显示 `未锚定 · 仅来自官方节点`；② 每纪元完整快照就是 BSC 上那笔 `postAnchor` 的 calldata，网站直接给 BscScan 链接和"怎么自己算一遍"的三行说明，索引服务只是方便、不是信任来源；③ 沿用 rat 的数据层纪律：数字全部来自链上、发射前 `发射后公布`、读取失败 `读取失败 · 重试中`、**没有任何演示数据**、估算标 `估算`、页脚地址行带复制按钮和"只认这里的合约地址"。

## 8. 信任模型（v1 的每个受信方与削减路径）

| 受信方 | v1 权力 | 最坏后果 | v1 硬限制 | v2 | v3 |
|---|---|---|---|---|---|
| Clique 单签名节点 | 完全决定 L2 内容与顺序 | 重写整条 L2 状态 | 只能经锚点变现：24h 窗口 + 每纪元 2–5% + 单地址 10% + veto + 逃生 | 3 签名者（官方 1 + 质押验证者 2），Clique 2/3；`signerSetHash` 进锚点 | 签名者集合由 `ValidatorStaking` 选举轮换，出块奖励来自节点基金 |
| 中继私钥（同机） | 发存款消息、发锚点 | 超发积分 / 伪造退出根 | 超发由 `proveInflation` 可证并永久停桥；退出根受 I3 + 承诺见证 + 窗口 + 档位限制 | 存款改用 BSC 区块头 + 收据 Merkle 证明（轻客户端），去掉存款方向信任 | 无许可提交 + 欺诈证明 / 有效性证明 |
| Flap Guardian `0x9e27…8a4b` | 升级金库实现 | 改写金库逻辑，取走金库里的钱、改变未来税收去向 | **金库稳态只留 3% opsBucket**，桥池与验证者份额已推到不可升级合约，已推走的不受影响 | 审计稳定后评估 `lockVaultUpgrades()`（同时失去修 bug 能力，要权衡） | 同 v2，并长期在页脚披露 |
| 项目方 admin 冷钥 | 轮换中继、ban agent、removeValidator | 审查特定 agent / 验证者 | 全部 48h 时锁且公开可见，veto 钥可取消；**没有一条能移动资金** | 换 2/3 Gnosis Safe | 交给验证者投票 |
| 项目方 veto 冷钥 | 作废纪元、取消轮换、立即 ban | 拒绝服务（卡住退出） | **只能停不能动钱**（fail-safe 方向）；连续作废会触发 14 纪元零见证停机进入逃生 | 2/3 多签 | 验证者多数可推翻 |
| 金库 owner | 取 `opsBucket` | 拿走 3% | 常量无 setter，`description()` 与 schema 逐字披露 | 不变 | 不变 |
| 索引 / 浏览器 | 展示 | 显示假数据 | 关键数字可从 BSC calldata 独立复算；未锚定内容强制标注 | 开源 + 第三方镜像 | 多索引器交叉比对 |
| BAC 代币本身 | Flap 管理角色可改 `marketAddress` 等 | 税收改道 | 按 某个更早的同类项目 的教训写"项目方无法修改"，**不写"永久不可改"** | — | — |

## 9. 失败模式

1. **服务器永久死亡。** 14 天无新锚点 → `isHalted()` → `BacBridge` 进入**不可逆逃生**：任何人用最后一个 FINAL 锚点的 `balanceRoot` 做 merkle 证明登记余额（证明数据就在 BSC calldata 里，不需要服务器、不需要 IPFS、不需要我们），30 天登记窗口后按累加器分池里现有和以后的每一笔 BNB。**这是本方案最重要的一条，其他一切都可以坏。**
2. **中继私钥泄露。** 超发方向：一笔 `proveInflation` 永久停桥 + 赏金，损失为零。退出方向：最多每纪元 0.2–0.5% 的桥池且要熬 24 小时；veto 钥窗口内作废；admin 48h 时锁轮换密钥（紧急时 veto 钥逐纪元作废直到轮换生效，此时链仍在跑、退出暂停）。
3. **PoA 签名节点停摆。** L2 停止出块，桥进桥出都停；锚点停发 14 天后自动逃生。72 小时内恢复则中继按序逐个补发缺的纪元（不可跳号）。**签名私钥泄露**：攻击者可产出竞争链 → veto 全部后续纪元、`clique_propose` 投入新签名者并投出旧的、`signerSetHash` 变化会被见证人看见，必要时直接走逃生。
4. **桥池被掏空 / 不够分。** 结构上分不穿：退出是按份额分池子而非按面值兑付。真实后果是退出的人拿得很少。必须在 `description()`、网站规则卡、X 首条回复同时写明：**退出按桥池份额，不承诺任何金额，可能远低于投入价值。**
5. **BSC 重组回滚了一笔已 credit 的存款。** `totalCreditsIssued` 回退 → 下一次 `postAnchor` 的 `cumulativeCredited <= totalCreditsIssued` 失败 → 中继必须先在 L2 销毁多出的积分（记进 `feeBurned`）恢复恒等式。确认深度让这几乎不会发生，但路径通、可审计。
6. **Agent 刷链。** gas 烧积分、积分要真金白银的 BAC；块 gas 上限 20M；`AnnounceBoard` 收费并限每纪元 50 条；DORMANT 被 `L2Gate` 拦住；Caddy 对 `/rpc` 限速。极端情况撑大存储属于运营成本（70 GB 空闲、`--state.scheme=path`、历史交给索引器），不是资金安全问题。
7. **`receive()` 被玩坏。** 直接打 BNB = 捐赠按 50/47/3 分掉；零增量 dispatch = 静默 no-op。最致命的是 `receive()` revert（**永久没收**那笔 dispatch）或超 1,000,000 gas（整个 `dispatch()` 对所有接收方失败）→ 里面只有 `_syncRevenue()`，测试覆盖 `call{gas:50_000}` 成功、冷 < 60k、暖 < 30k。
8. **下游拒收推送。** `call{value,gas:60_000}` 失败记 `stuck*` 并发 `PushFailed`，无许可 `retryPush()` 重试，`settle()` 永不因此 revert。
9. **见证人集体消失。** 档位掉到 200 bps（退出变慢但不停）；连续 14 纪元零见证 → 停机进入逃生。
10. **Guardian 升级了金库。** 已推到 `BacBridge` / `ValidatorStaking` 的钱不受影响；可被改变的是未来税收去向和 3% 的 opsBucket。页脚保留 rat 那句已获批准的 `Flap Guardian (Flap team) can upgrade the vault at any time.`

## 10. v1 切割线：明确不做

① 不做欺诈证明 / 有效性证明 / ZK（唯一链上证明是 `proveInflation`，因为链小才做得起）。② 不做多签名者 PoA。③ 不做罚没。④ 不改 geth、不加预编译、不做自定义共识（原版 geth + Clique，创世预分配代替铸币）。⑤ 不上 cancun（不用 blob / `tstore` / `mcopy`），停在 shanghai。⑥ 不做 L2 的 DEX、钱包、工具、稳定币，不桥接 BSC 以外任何链——链是空的，agent 自己建。⑦ 不做代币治理、不发第二个代币、不做 NFT。⑧ 不用 Flap Trigger 定时器（纪元用 `block.timestamp / 86400`，所有 settle/finalize/release 都无许可——少一个外部依赖、少 1.75 BNB/年、少一类"回调没触发"的故障）。⑨ 不做 X Verifier / Candy Box。⑩ 不做 agent 争议仲裁（AI Oracle 只预留接口）。⑪ 不做人类的层内写入界面（唯一写入界面是验证者质押与领奖）。⑫ 不做 `emergencyWithdrawNative/Token`（规则 009 允许不写，不写就没有这个攻击面）。⑬ 不做任何"暂停整条链的开关"，只有能停不能动钱的 veto 与不可逆的停机 / 逃生。

## 附：常量、部署顺序、上线硬停

**常量（全部写死，无 setter）**：`BRIDGE_BPS 5000` · `NODE_BPS 5000` · `VALIDATOR_BPS_OF_NODE 9400` · `OPS_BPS_OF_NODE 600` · `EPOCH 86400s(UTC 对齐)` · `CHALLENGE_WINDOW 24h` · `CLAIM_WINDOW 3 days` · `RELEASE_BPS 200/350/500`（0 / 1–2 / ≥3 个见证）· `QUORUM 3` · `MAX_EXIT_SHARE_BPS 1000` · `HALT_TIMEOUT 14 days` · `NO_ATTEST_EPOCHS 14` · `ESCAPE_WINDOW 30 days` · `INFLATION_BOUNTY 0.05 ether` · `ENTRY_DEPOSIT 0.02 ether` · `ROUNDS 3` · `K_BLOCKS 8` · `K_SECONDS 5` · `TARGET 2**236` · `MAX_MISSED 3` · `SPOT_RATE 32` · `RETIRE_DELAY 7 days` · `MIN_VALIDATOR_STAKE 2_000_000e18` · `UNSTAKE_COOLDOWN 7 days` · `ADMIN_TIMELOCK 48h` · `PUBLISH_FEE 0.001e18` · `MAX_PUBLISH_PER_EPOCH 50` · `OPERATOR_FLOAT 1_000e18`。

**部署顺序（BSC）**：① 链接库（CREATE2 salt 0，代码必须与 fly/rat 的库字节不同）→ ② `AgentRegistry` → ③ `ChainAnchor`（relayer / admin / veto）→ ④ `ValidatorStaking` → ⑤ `BacBridge` → ⑥ `AgentChainVaultFactory`（构造函数内建 impl 与 beacon，**绝不在脚本里建 beacon**）→ ⑦ 用户在 flap.sh 手工发射，`vaultData = abi.encode(bridge, validatorPayout, opsOwner)` → ⑧ `bridge.bindVault(vault)`、`validatorPayout.bindVault(vault)`（各自一次性）。**创世文件在 BSC 合约就位之后再生成**，因为 `L2Bridge` 的常量里要写死 BSC 侧 `BacBridge` 与 relayer 地址。

**发射后 5 分钟硬停**（任一失败则暂停一切宣传，沿用 `verify_launch.py` 形状）：`VaultPortal.getVault(token).vaultFactory == FACTORY` · `TaxProcessor(token.taxProcessor()).marketAddress() == vault` · `vault.taxToken() == token` · `eth_getStorageAt(vault, 0xa3f0ad74…3d50) == factory.beacon()` · `beacon.owner() == factory` · `feeConfigV2().dividendBps == 0` · `vault.vaultQuoteToken() == 0x0` · `vault.bridge()/validatorPayout()` 正确 · `bridge.vault() == vault && staking.vault() == vault` · `vault.solvency()` 三数自洽。

**测试底线**（在 rat 骨架上加）：`receive()` 在 `call{gas:50_000}` 下成功且冷 < 60k；`settle()` 在下游 revert 时不回滚；每场景后 `_assertSolvent()`；不变量 `accounted == Σbuckets`、`balance >= accounted`、`Σ已付退出 <= Σ已释放`、`Σcredits <= totalCreditsIssued`；I3 恒等式在模糊测试下不可绕过；`proveInflation` 在 500 条快照下 < 500k gas；逃生模式在"中继与签名者都停止"时能把池子分完；固定高度主网 fork 走一次真实 `newTokenV6WithVault` + `dispatch{gas:1_000_000}`。
