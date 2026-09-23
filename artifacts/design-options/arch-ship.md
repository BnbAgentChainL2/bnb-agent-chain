# 架构方案 · ship-it（最小可上线版）

架构师：**ship**。2026-09-22。

一句话：**一条 3 秒出块的 Clique 单签名链 + 一个中继进程 + 一个索引进程，全部跑在一台 3 vCPU 的机器上；BSC 侧只放 5 个不可升级的小合约（其中金库/工厂是 Flap 规范强制的那一对）；这条链出生时除了两个系统合约之外什么都没有，DEX、工具、市场全部由 agent 自己部署。**

取舍原则：① 能砍就砍，凡是"要写一个协议"的地方一律先写"一个进程"；② 每个保留的组件都必须能在本地用 `anvil` + 一个本地 geth 容器跑通端到端，跑不通就不进主网；③ 单签名 PoA + 官方中继在 v1 就是**中心化**的，不粉饰，写进 `description()`、写进网站页脚、写进第 8 节并给出降低路径；④ 合约总量目标 < 1200 行 Solidity（不含 Flap 那 14 个只读文件）。

---

## 1. 组件图

```
                           BSC 主网 (chainId 56)
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                                                                              │
 │  flap.sh VaultPortal 0x90497450f2a706f1951b5bdda52B4E5d16f34C06              │
 │        │ newTokenV6WithVault(params)                                         │
 │        │  1. staticcall onBeforeLaunch(abi.encode(LaunchValidationDataV1))   │
 │        │  2. call newVault(predictedToken, address(0), creator, vaultData)   │
 │        ▼                                                                     │
 │  ┌──────────────────────┐  constructor 内 new UpgradeableBeacon(new Vault)   │
 │  │ AgentChainVaultFactory│──── new BeaconProxy ───► ┌────────────────────┐   │
 │  │  (无 owner，无升级权) │   beacon.owner()==factory│ AgentChainVault    │   │
 │  └──────────────────────┘                          │ = 国库（唯一资金池）│   │
 │        ▲ Guardian 0x9e27..8a4b 可 upgradeTo/lock   └────────────────────┘   │
 │                                                        ▲   │   │   │         │
 │  FlapTaxTokenV3 "BAC" (…7777)                          │   │   │   │         │
 │        │ TaxProcessor.dispatch{gas:1e6}()              │   │   │   │         │
 │        └── 原生 BNB 转账 ──► vault.receive() ──────────┘   │   │   │         │
 │                                 记账 50% bridgePool         │   │   │         │
 │                                       40% validatorPool     │   │   │         │
 │                                       10% opsPool           │   │   │         │
 │                                                             │   │   │         │
 │  ┌───────────────┐  lock(agentId, amount) 拉 BAC            │   │   │         │
 │  │ BridgeLock    │◄─── agent 的 BSC 地址                     │   │   │         │
 │  │ (无 owner)    │──── payRedemption(to, amt) ──────────────┘   │   │         │
 │  │               │◄─── recordExit(exitId,…) ◄── 中继            │   │         │
 │  └───────────────┘──── claim(agentId) ──► agent 收 BNB          │   │         │
 │        ▲ bacToken() == 预测的代币地址（工厂用它校验 vaultData） │   │         │
 │                                                                 │   │         │
 │  ┌───────────────┐  register{value:0.01 BNB}(wallet,uri,hash)   │   │         │
 │  │ AgentRegistry │◄─── agent 的控制私钥                          │   │         │
 │  │ (无 owner)    │  solve(agentId, challengeId, nonce, sig)      │   │         │
 │  │               │──── 没通过的押金 ── 原生转账 ────────────────┘   │         │
 │  └───────────────┘                                                  │         │
 │        ▲ isActive(agentId) 被 BridgeLock 读                          │         │
 │                                                                      │         │
 │  ┌──────────────────┐ stake / requestUnstake（人类验证者）            │         │
 │  │ ValidatorStaking │◄─── 人类的 BSC 钱包                            │         │
 │  │ (无 owner)       │  attest(epoch, layerBlockHash) ◄── 验证节点     │         │
 │  │                  │  anchor(epoch, hash, number)   ◄── 中继         │         │
 │  │                  │──── closeEpoch 时 payNodeReward(this, amt) ────┘         │
 │  └──────────────────┘──── claimRewards(epoch) ──► 人类收 BNB                   │
 └──────────────────────────────────────────────────────────────────────────────┘
        ▲ eth_getLogs (3000 块窗口)          ▲ eth_call / Multicall3
        │                                     │
 ┌──────┼─────────────────────────────────────┼────────────────────────────────┐
 │      │      服务器 95.179.183.132 · /opt/bac · docker compose          │
 │  ┌───┴─────────┐      ┌──────────────┐      ┌──────────┐    ┌────────────┐  │
 │  │ relayer     │      │ indexer      │      │ geth     │    │ caddy      │  │
 │  │ node:22     │      │ node:22      │      │ Clique   │    │ 自动 TLS   │  │
 │  │ 1 进程      │      │ + SQLite     │      │ 1 signer │    │ 反代       │  │
 │  │ sqlite 游标 │      │ 轮询，不是   │      │ period=3 │    │ :443       │  │
 │  └─┬────────┬──┘      │ 事件订阅     │      └────┬─────┘    └─────┬──────┘  │
 │    │        │         └───┬──────┬───┘           │ :8545 (内网)   │         │
 │    │        │             │      │               │ :30303 (公网)  │         │
 │    │        └─ eth_sendRawTransaction ───────────►│                │         │
 │    │          credit(depositId,to,amt)            │                │         │
 │    │        ◄─ eth_getLogs ExitRequested ─────────┤                │         │
 │    └─ eth_sendRawTransaction ──► BSC              │                │         │
 │       recordExit / anchor                         │                │         │
 └───────────────────────────────────────────────────┼────────────────┼─────────┘
                                                     │                │
                       LAYER: BNB Agent Chain, chainId 56888, 3s 出块  │
 ┌───────────────────────────────────────────────────┴──────────┐     │
 │ 创世 alloc 只有两个系统合约，没有任何 EOA 预留余额：         │     │
 │  0x…0BaC  L2Bridge     余额 1e27 wei（= 1,000,000,000 BAC）  │     │
 │           credit() 只有中继能调；exit() 谁都能调             │     │
 │           isAgent(addr) 记录谁被桥入过                       │     │
 │  0x…0B0A  AnnounceBoard  announce(kind, contentHash, uri)    │     │
 │           require(L2Bridge.isAgent(msg.sender))              │     │
 │                                                              │     │
 │  其余全空。agent 自己部署 DEX、工具、市场。                  │     │
 └──────────────────────────────────────────────────────────────┘     │
        ▲ enode p2p :30303                                            │
        │                                                             │
 ┌──────┴────────────┐                              ┌─────────────────┴──────┐
 │ 人类验证节点       │  attest(epoch,hash) ──► BSC  │ Vercel 静态站（只读）  │
 │ geth 全节点 + 一个 │                              │ 左半边读 BSC 公共 RPC  │
 │ 30 行的 attester   │                              │ 右半边读官方 /api/*    │
 └────────────────────┘                              └────────────────────────┘
```

---

## 2. BSC 合约清单

工具链固定：solc 0.8.26、evm `cancun`、optimizer 200、`via_ir = true`、OZ 4.9.6、所有 revert 用双语 `require(cond, unicode"English / 中文")`，不用 custom error。

### 2.1 `AgentChainVaultFactory is VaultFactoryBaseV2`

作用：Flap 规范要求的工厂；它唯一的产物是国库金库。**没有 `Ownable`，没有 owner**，beacon 在 constructor 里创建所以 `beacon.owner() == factory`，升级权只在 Guardian 手上（规则 009）。

```solidity
address public immutable beacon;
constructor() { beacon = address(new UpgradeableBeacon(address(new AgentChainVault()))); }

function newVault(address taxToken, address quoteToken, address creator, bytes calldata vaultData)
    external override returns (address vault);                                   // 0x15b92d7a
function isQuoteTokenSupported(address quoteToken) external pure override returns (bool);
function factorySpecVersion() public pure override returns (string memory);      // "v2.3"
function vaultDataSchema() public pure override returns (VaultDataSchema memory);
function tokenCreationPolicies() public pure override returns (FactoryPolicy[] memory);
function upgradeVaultImplementation(address impl) external;                      // 仅 _getGuardian()
function lockVaultUpgrades() external;                                           // 仅 _getGuardian()
function isVaultUpgradesLocked() external view returns (bool);
function beaconImplementation() external view returns (address);
function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
    internal pure override returns (bool success, string memory reason);

event AgentChainVaultCreated(address indexed vault, address indexed taxToken, address indexed creator,
                             address owner, address bridge, address staking);
```

`vaultData = abi.encode(address owner, address bridge, address staking)`，三个字段 `fieldType "address"`、`decimals 0`、`isArray=false`。`newVault` 里的检查（任何一条不过，发射交易直接回滚）：`msg.sender == _getVaultPortal()`、`quoteToken == address(0)`、`owner == address(0)` 时取 `creator`、`bridge.code.length > 0 && staking.code.length > 0`、**`IAgentBridge(bridge).bacToken() == taxToken`**、**`IValidatorStaking(staking).bacToken() == taxToken`**、`IAgentBridge(bridge).vault() == address(0)`（理由串双语，例如 `unicode"Bridge is bound to another token / 桥绑定的是别的代币"`）。

后三条为什么成立：`taxToken` 在这里只是**预测地址**（还没有 code），但 `BridgeLock` 和 `ValidatorStaking` 是先部署的，构造参数里已经写死了这个预测地址。所以工厂可以在不碰 taxToken 的前提下，验证发射表单里粘贴的桥/质押地址确实是为这个代币准备的 —— 这正面解掉了 fly/rat 上"发射人把表单填错、事后只能重新发射"那一类坑。规则禁止的是调用 taxToken 本身，调用我们自己的合约没问题。

`_validateBeforeLaunch` 拒绝（双语理由字符串，会被 flap.sh 原样显示）：

| 条件 | 理由（英文半句） |
|---|---|
| `quoteToken != address(0)` | `"BNB quote only"` |
| `tokenVersion != TOKEN_TAXED_V3` | `"Tax Token V3 only"` |
| `buyTaxRate == 0 && sellTaxRate == 0` | `"Tax must not be zero"` |
| `buyTaxRate > 1000 \|\| sellTaxRate > 1000` | `"Tax must be <= 10%"` |
| **`vaultBps != 10000`** | `"Vault share must be exactly 100%"` |
| `dividendBps != 0` | `"Holder dividend must be 0%"` |
| `dividendToken == MAGIC_DIVIDEND_COMPUTED` | `"Computed dividend token not supported"` |

`vaultBps` 用 `==` 不用 `>=`：国库的 50/50 分账是这个项目的全部叙事，税收必须 100% 进金库，否则网站和文案要重写（某个更早的同类项目 就是这么被迫改了两次）。`tokenCreationPolicies()` 镜像四条：`("quoteToken","eq",abi.encode(address(0)))`、`("tokenVersion","eq",abi.encode(uint8(6)))`、`("mktBps","eq",abi.encode(uint16(10000)))`、`("dividendBps","eq",abi.encode(uint16(0)))`。

### 2.2 `AgentChainVault is Initializable, VaultBaseV3, ReentrancyGuardUpgradeable`

作用：**整个项目唯一的 BNB 资金池**。税收进来，按常数分三个桶，桥和质押合约按规则往外付。

```solidity
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() { _disableInitializers(); }
function initialize(address taxToken_, address owner_, address bridge_, address staking_) external initializer;

receive() external payable;                                          // 只做 _syncRevenue()
function sync() external nonReentrant;                               // 无权限，谁都能调
function vaultQuoteToken() public pure override returns (address);   // address(0)，不是 WBNB
function description() public view override returns (string memory);
function vaultUISchema() public pure override returns (VaultUISchema memory);

function payRedemption(address to, uint256 amount) external nonReentrant returns (uint256 paid);
function payNodeReward(address to, uint256 amount) external nonReentrant returns (uint256 paid);
function withdrawOps(address to, uint256 amount) external nonReentrant;

function taxToken() external view returns (address);
function bridge() external view returns (address);
function staking() external view returns (address);
function owner() external view returns (address);
function pools() external view returns (uint256 bridgePool, uint256 validatorPool, uint256 opsPool);
function accountedQuote() external view returns (uint256);
function pendingRevenue() external view returns (uint256);
function solvency() external view returns (uint256 balance, uint256 accounted, uint256 buckets);
function lifetimeIn() external view returns (uint256);
function lifetimeOut() external view returns (uint256 redeemed, uint256 nodePaid, uint256 ops);

event RevenueRecognized(address indexed from, uint256 amount);
event RevenueSplit(uint256 toBridgePool, uint256 toValidatorPool, uint256 toOpsPool);
event RedemptionPaid(address indexed to, uint256 amount);
event NodeRewardPaid(address indexed to, uint256 amount);
event OpsWithdrawn(address indexed by, address indexed to, uint256 amount);
event OwnershipTransferred(address indexed from, address indexed to);
```

谁能调：`payRedemption` 只有 `bridge`；`payNodeReward` 只有 `staking`；`withdrawOps` 是 `owner` **或** Guardian（各自单独即可，规则 001-d/e），必须带 `to`，因为主网 Guardian 是一个拒收原生 BNB 的代理合约；`sync()` 无权限；其余是 view。

分账常数，**没有 setter**（规则 001-g / 003）：

```
BRIDGE_BPS    = 5000   // 50% 桥池：给退出的 agent 兑 BNB
VALIDATOR_BPS = 4000   // 40% 节点基金 → 验证者奖励
OPS_BPS       = 1000   // 10% 节点基金 → 官方基础设施（服务器、中继 gas、域名/证书）
```

用户拍板的是"50% 桥池 / 50% 官方节点基金，节点基金付验证者 + 官方基础设施"。上面就是把"官方基础设施"写成节点基金里一个**固定、事先声明、不可改**的子桶：节点基金 = 4000 + 1000 = 5000。`opsPool` 就是规则 003 允许的那种"常数、预先披露的桶"，它是 owner 唯一能碰的钱。

规则 010 记账：一个 `uint256 _revenue`，低 128 位是 `accountedQuote`，高 128 位是还没分桶的 `unsplit`。`receive()` 只做 `bal = address(this).balance; if (bal <= acct) return; _revenue = ((unsplit + (bal-acct)) << 128) | bal; emit RevenueRecognized(...)` —— 1 次 SLOAD + 1 次 balance + 1 次 SSTORE + 1 个 event，目标冷启动 < 55,000 gas、热 < 15,000 gas，必须能在 `call{gas: 50_000}` 下成功，**任何路径都不 revert**（`receive()` revert 一次，那笔 dispatch 的份额就永久没了）。分桶发生在 `_settle()`，它是 `payRedemption` / `payNodeReward` / `withdrawOps` / `sync()` 的第一行。每一笔出账都在 `call{value}` **之前**同时扣 `bucket` 和 `accountedQuote`。

**这个金库没有 `emergencyWithdrawNative`、没有 `emergencyWithdrawToken`、没有任何清仓函数。** 规则 009 明确说 BeaconProxy 金库不需要应急函数；某个更早的同类项目 的 owner 全额提款被点名"do not copy"，而且在主网上真的被用来搬走了 29,951,480.8 个用户质押的代币。砍掉它，v1 的信任故事直接强一档：owner 能拿走的只有 `opsPool`，一分不多。代价是如果桥的逻辑出 bug 把 BNB 锁死，只能靠 Guardian 升级实现来救 —— 这条要写进 `description()`。

`description()` 放在 `AgentChainUI` 外部链接库里（via-IR + 链接库省字节码），必须说清楚：三个桶的比例、owner 只能提 `opsPool`、Guardian 可以随时升级实现、桥和质押合约不可升级且无 owner、当前 `pools()` 的三个数。`vaultDataSchema().description` 同样。两段文字在部署那一刻冻结，改一个字要重新部署工厂（某个更早的同类项目 为了改个名字重部过一次）。

### 2.3 `AgentRegistry`（门禁，无 owner，不可升级）

```solidity
enum Status { NONE, CHALLENGED, ACTIVE, DORMANT }
struct Agent {
    address controller; address agentWallet; bytes32 endpointHash; bytes32 agentURIHash;
    uint64 registeredAt; uint64 activatedAt; uint32 solved; uint32 failed; Status status;
}
uint256 public constant ENTRY_DEPOSIT = 0.01 ether;
uint8   public constant ROUNDS   = 3;
uint64  public constant K_BLOCKS = 8;      // BSC 0.45s/块 → 约 3.6 秒
uint64  public constant K_SECS   = 5;
uint256 public constant TARGET   = 2**236; // 约 0.2–1 秒 CPU

function register(address agentWallet, string calldata agentURI, bytes32 endpointHash)
    external payable returns (uint64 agentId, bytes32 challengeId);
function solve(uint64 agentId, bytes32 challengeId, uint256 nonce, bytes calldata sig) external;
function markFailed(uint64 agentId) external;                       // 无权限，过期后谁都能调
function reissue(uint64 agentId) external;                          // 无权限，抽查用
function setAgentURI(uint64 agentId, string calldata newURI) external;        // 仅 controller
function rotateController(uint64 agentId, address newController, uint256 deadline, bytes calldata newKeySig) external;
function setAgentWallet(uint64 agentId, address newWallet, uint256 deadline, bytes calldata walletSig) external;

function isActive(uint64 agentId) external view returns (bool);
function getAgent(uint64 agentId) external view returns (Agent memory);
function agentIdOf(address controller) external view returns (uint64);
function agentOfWallet(address wallet) external view returns (uint64);
function currentChallenge(uint64 agentId) external view
    returns (bytes32 challengeId, bytes32 seed, uint64 deadlineBlock, uint64 deadlineTime, uint8 round);
function totalAgents() external view returns (uint64);
function agentAt(uint64 index) external view returns (uint64 agentId);
function recentAgents(uint64 count) external view returns (uint64[] memory);

event Registered(uint64 indexed agentId, address indexed controller, address indexed agentWallet,
                 string agentURI, bytes32 endpointHash);
event ChallengeIssued(uint64 indexed agentId, bytes32 indexed challengeId, bytes32 seed,
                      uint64 deadlineBlock, uint64 deadlineTime, uint8 round);
event ChallengeSolved(uint64 indexed agentId, bytes32 indexed challengeId, uint32 blocksUsed);
event ChallengeFailed(uint64 indexed agentId, bytes32 indexed challengeId, uint8 round);
event Activated(uint64 indexed agentId, address indexed agentWallet);
event Dormant(uint64 indexed agentId);
event URIUpdated(uint64 indexed agentId, string newURI);
event ControllerRotated(uint64 indexed agentId, address indexed from, address indexed to);
event DepositForfeited(uint64 indexed agentId, uint256 amount);
```

`agentId` 是 `uint64` 计数器，**不是 ERC-721，不可转让**。理由：省字节码、省一份 OZ 依赖，而且不可转让堵住了"买一个已激活身份"的口子。`agentURI` 保持 ERC-8004 的 JSON 形状（`registrations[]` 指回 `(eip155:56, thisRegistry, agentId)`），这样以后 8004 的索引器能读，但 v1 **不建** Reputation Registry 和 Validation Registry。

押金流向：`solve` 走到第 3 轮成功 → 退还给 `controller`；`markFailed` → 押金用 `call{value, gas: 60_000}` 直接打进 `AgentChainVault`，走 `receive()`，被 50/40/10 分掉，`emit DepositForfeited`。不另外发明一个池子。

历史放在合约里（`agentAt` / `recentAgents` / 计数器），因为免费的公共 BSC RPC 只保留约 75 分钟的日志，网站不能靠 `eth_getLogs` 回溯。

### 2.4 `BridgeLock`（无 owner，不可升级）

```solidity
address public immutable bacToken;      // 预测的 …7777 代币地址，部署时写死
address public immutable registry;
address public vault;                   // bindVault() 一次性从 VaultPortal 读出来缓存

uint64  public constant EPOCH_LEN          = 1 days;
uint16  public constant EPOCH_CAP_BPS      = 200;   // 每纪元最多放出桥池的 2%
uint16  public constant ADDR_CAP_BPS       = 50;    // 单地址单纪元最多 0.5%
uint64  public constant PAUSE_LEN          = 7 days;
uint64  public constant EXIT_COOLDOWN      = 1 hours;

function bindVault() external;                        // 无权限；读 IVaultPortal.getVault(bacToken).vault
function lock(uint64 agentId, uint256 amount) external returns (uint256 depositId);
function recordExit(uint256 exitId, uint64 agentId, uint256 amount, bytes32 layerTxHash) external; // 仅 relayer
function claim(uint64 agentId) external returns (uint256 paid);
function claimable(uint64 agentId) external view returns (uint256);
function owed(uint64 agentId) external view returns (uint256 total, uint256 paid);
function poolStats() external view
    returns (uint256 pool, uint256 lockedTotal, uint256 creditedTotal, uint256 exitedTotal,
             uint256 outstanding, uint256 reserved, uint64 epoch, uint256 epochPaid);
function pause() external;                            // watchdog：vault.owner() 或 Flap Guardian
function unpause() external;
function relayer() external view returns (address);
function setRelayer(address r) external;              // 仅 admin（冷钱包），带 2 天时间锁

event Locked(uint256 indexed depositId, uint64 indexed agentId, address indexed agentWallet,
             uint256 amount, uint256 lockedTotal);
event ExitRecorded(uint256 indexed exitId, uint64 indexed agentId, address indexed to,
                   uint256 burned, uint256 entitlement, uint64 epoch);
event Claimed(uint64 indexed agentId, address indexed to, uint256 amount);
event Paused(address indexed by, uint64 until_);
event RelayerRotationQueued(address indexed newRelayer, uint64 eta);
event RelayerChanged(address indexed from, address indexed to);
```

`lock` 的规则：`require(IAgentRegistry(registry).isActive(agentId))`；`require(msg.sender == controller || msg.sender == agentWallet)`；**按余额差记账**（`before/after balanceOf(this)`，BAC 是税代币，虽然钱包↔合约转账目前不收税，但不赌这一点）；`lockedTotal += delta`；`emit Locked`。进桥的 BAC 永远留在桥合约里，退出不退 BAC 退 BNB —— 也就是说**桥是 BAC 的单向出口**，这一点必须在网站上用一句白话写清楚，但不能顺势说任何关于价格的话。

`recordExit` 的规则：只有中继能调；`exitId` 去重；按记录那一刻快照算份额

```
entitlement = burned * (bridgePool - reserved) / outstanding
owed[agentId] += entitlement;  reserved += entitlement;  outstanding -= burned;
```

池子随税收增长，所以**退得越早，比例越低**。这是故意的，反挤兑，而且不需要任何额外机制。

`claim` 的规则：`min(owed - paid, 桥池 * ADDR_CAP_BPS / 10000 - 本纪元本地址已领, 桥池 * EPOCH_CAP_BPS / 10000 - 本纪元全局已领)`，然后 `IAgentChainVault(vault).payRedemption(to, amount)`。领不完的留在 `owed` 里下个纪元继续领。`EXIT_COOLDOWN` 防止同一地址在一个区块里反复调。

**这两个上限是整个信任模型的承重墙**：不管二层那边发生什么、不管中继密钥有没有泄漏，BNB 离开 BSC 的速度都被钉死在每天 2%。

### 2.5 `ValidatorStaking`（无 owner，不可升级）

```solidity
address public immutable bacToken;
address public vault;                                  // bindVault() 同上
uint64  public constant EPOCH_LEN        = 6 hours;
uint64  public constant GRACE            = 30 minutes; // 纪元结束后还能提交见证的时间
uint256 public constant MIN_STAKE        = 5_000_000 ether;   // 0.5% 总量
uint64  public constant UNSTAKE_DELAY    = 7 days;
uint16  public constant RELEASE_BPS      = 100;        // 每纪元放 validatorPool 的 1%
uint16  public constant MAX_SHARE_BPS    = 2000;       // 单地址单纪元最多拿 20%

function stake(uint256 amount) external;                          // 余额差记账
function requestUnstake(uint256 amount) external;
function withdrawStake() external returns (uint256);
function anchor(uint64 epoch, uint64 layerBlockNumber, bytes32 layerBlockHash) external;  // 仅 relayer
function attest(uint64 epoch, bytes32 layerBlockHash) external;   // 质押 >= MIN_STAKE 的地址
function closeEpoch(uint64 epoch) external;                       // 无权限，纪元结束 + GRACE 之后
function claimRewards(uint64 epoch) external returns (uint256);
function rewardOf(uint64 epoch, address v) external view returns (uint256);
function epochInfo(uint64 epoch) external view
    returns (bytes32 anchorHash, uint64 anchorNumber, bytes32 majorityHash,
             uint256 majorityStake, uint256 totalAttestStake, uint256 reward, bool closed, bool forked);
function validatorInfo(address v) external view
    returns (uint256 staked, uint256 pendingUnstake, uint64 unlockAt, uint64 lastAttested);
function totalStaked() external view returns (uint256);
function validatorCount() external view returns (uint256);
function validatorAt(uint256 i) external view returns (address);

event Staked(address indexed v, uint256 amount, uint256 total);
event UnstakeRequested(address indexed v, uint256 amount, uint64 unlockAt);
event StakeWithdrawn(address indexed v, uint256 amount);
event Anchored(uint64 indexed epoch, uint64 layerBlockNumber, bytes32 layerBlockHash);
event Attested(uint64 indexed epoch, address indexed v, bytes32 layerBlockHash, uint256 stake);
event EpochClosed(uint64 indexed epoch, bytes32 majorityHash, uint256 majorityStake, uint256 reward, bool forked);
event RewardClaimed(uint64 indexed epoch, address indexed v, uint256 amount);
```

`closeEpoch(epoch)`：按质押权重数每个 `layerBlockHash` 的票，票数最多的是 `majorityHash`；`forked = (majorityHash != anchorHash)`；`reward = validatorPool * RELEASE_BPS / 10000`，通过 `vault.payNodeReward(address(this), reward)` 一次性托管进本合约；只有投了 `majorityHash` 的验证者按质押比例分，单地址不超过 `MAX_SHARE_BPS`，分不掉的余数留到下一纪元。`forked == true` 时**照常发奖**（验证者做了本职工作）并且 `emit EpochClosed(..., forked=true)`，浏览器首页直接挂红条。

---

## 3. LAYER 侧

### 3.1 创世配置

```json
{
  "config": {
    "chainId": 56888,
    "homesteadBlock": 0, "eip150Block": 0, "eip155Block": 0, "eip158Block": 0,
    "byzantiumBlock": 0, "constantinopleBlock": 0, "petersburgBlock": 0,
    "istanbulBlock": 0, "berlinBlock": 0, "londonBlock": 0,
    "shanghaiTime": 0, "cancunTime": 0,
    "clique": { "period": 3, "epoch": 30000 }
  },
  "difficulty": "0x1",
  "gasLimit": "0x1c9c380",
  "baseFeePerGas": "0x3b9aca00",
  "extradata": "0x" + 64个0 + <签名节点地址20字节> + 130个0,
  "alloc": {
    "0x0000000000000000000000000000000000000BaC": {
      "balance": "1000000000000000000000000000",
      "code": "0x<L2Bridge 的 runtime bytecode>",
      "storage": { "0x00": "<relayer>", "0x01": "<admin>", "0x02": "<watchdog>" }
    },
    "0x0000000000000000000000000000000000000B0A": {
      "balance": "0",
      "code": "0x<AnnounceBoard 的 runtime bytecode>"
    }
  }
}
```

**chainId = 56888**。理由：含 `56` 便于记忆和"建在 BSC 之上"的表述；5 位数不会和 EIP-155 的任何历史约定冲突；不是 1337/31337/5611/204 这些已被本地链和 opBNB 占用的号。**硬门槛：生成创世文件之前必须在 chainlist.org 和 github.com/ethereum-lists/chains 上逐字搜 `56888`，撞了就换 `56889`。** 创世之后 chainId 实际上改不了（改了等于另一条链），所以这一步不能省。

**period = 3 秒**。理由：1 个签名节点，3 秒出块对浏览器的实时流足够"活"，一天 28,800 块，空块加索引大约 30 MB/天、约 11 GB/年，服务器还剩 70 GB，够撑到我们真的需要考虑扩容。用 `--gcmode=full` + 定期 `snapshot prune-state`。不用 `period = 0`（按需出块）：时间戳会变得不可预测，浏览器的"链是活的"这件事也就没法展示了。

**gasLimit = 30,000,000**（`0x1c9c380`），和 BSC/以太坊主网同量级，agent 部署自己的 DEX 时不会撞墙，现成工具（hardhat/foundry/ethers）的默认值都能直接用。

**alloc：除了两个系统合约，没有任何账户有余额。签名节点账户余额是 0**（Clique 出块不花 gas）。这就是"链是空的"这句话在技术上的确切含义。

### 3.2 原生 BAC 从哪来

EVM 里没法凭空铸造原生币，除非改 geth。改 geth 要自己维护一个分叉、每次上游升级都要重新打补丁 —— **砍掉**。

取而代之：`L2Bridge` 在创世时就持有 `1e27 wei = 1,000,000,000 BAC`，正好等于 Flap Tax Token V3 的固定总量。所谓"铸"其实是从这个储备里**转账**，所谓"销"是把原生币转回储备。于是：

```
二层流通中的 BAC  =  1e27  −  L2Bridge 余额  ≤  BSC 上被锁进 BridgeLock 的 BAC
```

左边这个不变式，索引器每个轮询周期算一次，浏览器首页显示，任何人都能用两个 `eth_call` 复算。BAC 在 BSC 侧还有销毁税（`deflationBps`，我们设 0）和进桥即退出流通的效果，所以 1e27 这个上限是保守的。不需要任何 geth 修改，不需要任何预言机。

### 3.3 Gas 经济

`londonBlock: 0`，EIP-1559 开着（现代工具默认要它）。base fee 被烧掉 —— 烧掉的是二层积分，而那些积分在 BSC 侧对应的 BNB 还留在桥池里，于是**被烧掉的 gas 等于所有还没退出的 agent 集体分掉了一点 BNB**。官方签名节点把 priority fee 下限设为 0，不从二层收任何费。一句话写在网站上：**"在这条链上花掉的 gas 不进任何人的口袋，它只会让还留在链上的积分背后的 BNB 变多一点。"**

防垃圾交易就靠这个：gas 必须用桥进来的 BAC 付，而 BAC 要么在市场上买，要么等别的 agent 给。链上没有水龙头。

### 3.4 两个系统合约

```solidity
// 0x0000000000000000000000000000000000000BaC
contract L2Bridge {
    uint256 public constant MAX_CREDIT_PER_TX  = 50_000_000 ether;
    uint256 public constant MAX_CREDIT_PER_DAY = 100_000_000 ether;
    function credit(uint256 depositId, address to, uint256 amount) external;   // 仅 relayer
    function exit(address bscRecipient) external payable returns (uint256 exitId);
    function isAgent(address a) external view returns (bool);
    function stats() external view returns (uint256 reserve, uint256 creditedTotal, uint256 exitedTotal,
                                            uint256 dayCredited, uint64 day, bool paused);
    function setRelayer(address r) external;      // 仅 admin
    function pause() external; function unpause() external;   // admin 或 watchdog
    event Credited(uint256 indexed depositId, address indexed to, uint256 amount, uint256 creditedTotal);
    event ExitRequested(uint256 indexed exitId, address indexed from, address indexed bscRecipient, uint256 amount);
    event RelayerChanged(address indexed from, address indexed to);
    event PausedSet(bool paused);
}

// 0x0000000000000000000000000000000000000B0A
contract AnnounceBoard {
    function announce(bytes32 kind, bytes32 contentHash, string calldata uri) external returns (uint256 seq);
    function count() external view returns (uint256);
    event Announced(uint256 indexed seq, address indexed agent, bytes32 indexed kind,
                    bytes32 contentHash, string uri);
}
```

`kind` 是 `keccak256("DEX")` / `"TOKEN"` / `"TOOL"` / `"POST"` / `"SERVICE"` 之类，浏览器按它分类。`announce` 要求 `L2Bridge.isAgent(msg.sender)` —— 这是 BSC 门禁在二层的影子：只有被桥入过的地址才能在公告板上说话。

创世字节码怎么生成（照抄这个顺序，不要手搓 storage）：本地 `geth --dev` 起一个链 → 正常部署这两个合约（构造函数里写 relayer/admin/watchdog）→ `eth_getCode` 取 runtime → `eth_getStorageAt` 取 slot 0/1/2 → 填进 `genesis.json` → `geth init` → 用 `cast call` 把每个 view 函数在新创世链上再读一遍对拍。这一步有脚本，在本地 CI 里跑，不靠人眼。

---

## 4. 中继（relayer）

**一个 Node 进程，一个 SQLite 文件，两条 EOA 私钥（BSC 一条、二层一条，可以是同一把，但分开更好排查）。不是协议，不是多签，不是 committee。**

### 4.1 BSC → LAYER（进桥）

1. 每 3 秒 `eth_getLogs`，范围 `[cursor+1, head - 120]`，窗口 ≤ 3000 块，只过滤 `BridgeLock.Locked`。**120 个确认 ≈ 54 秒**（BSC 0.45 秒出块）。
2. 对每条日志：先写 SQLite `outbox(kind='credit', deposit_id, to, amount, status='new')` **并提交事务**，再推进 `cursor`。
3. 发送前二次核对：用 `eth_getTransactionReceipt` 重新读那笔交易，确认它仍在规范链上且 `blockNumber <= head - 120`。重组导致日志消失 → 把 outbox 行标成 `orphaned`，不发。
4. 发送：`L2Bridge.credit(depositId, to, amount)`，一次只发一笔，`await tx.wait(1)` 之后才发下一笔（**不做 nonce 管理器**，慢但不会乱序；二层 3 秒一块，吞吐够用几百倍）。
5. `depositId` 在 `L2Bridge` 里去重，所以重发是安全的；进程崩了重启就从 outbox 里 `status='new'/'sent'` 的行继续。

中继**签的东西**：只有这一个交易，字段是 `(depositId, to, amount)`。它不签任何离线消息，不产生任何需要别人验证的签名 —— 这是"一个进程而不是一个协议"的意思。

### 4.2 LAYER → BSC（退出）

1. 每 3 秒读二层 `L2Bridge.ExitRequested`，范围 `[cursor+1, head - 12]`（12 块 ≈ 36 秒）。二层只有一个签名节点，**它的"最终性"等于官方节点的诚实**，12 块只挡住进程重启导致的重放，挡不住恶意重写。这一条要写进信任模型。
2. outbox → `BridgeLock.recordExit(exitId, agentId, amount, layerTxHash)`，同样一次一笔、`exitId` 去重。
3. 中继**不搬 BNB**。它只是"登记"。真正的 BNB 由 agent 自己调 `claim()` 拉走，而且被单地址/单纪元上限卡着。

### 4.3 锚点

每个 6 小时纪元结束后，中继调 `ValidatorStaking.anchor(epoch, layerBlockNumber, layerBlockHash)`，取纪元边界那一块的哈希。一天 4 笔，约 0.0006 BNB/天，从 `opsPool` 出。

### 4.4 中继能偷什么，不能偷什么

| 能 | 不能 |
|---|---|
| 在二层给自己 `credit` 凭空的积分（上限：单笔 5000 万 BAC、单日 1 亿 BAC，储备 10 亿 BAC 封顶） | 动 BSC 上金库里的一分 BNB —— `payRedemption` 只有 `BridgeLock` 能调，`BridgeLock` 只按 `owed` 和两个上限付 |
| 在 BSC 上 `recordExit` 登记一笔假的退出，把 `owed` 记到自己头上 | 绕过 `EPOCH_CAP_BPS = 2%/天` 和 `ADDR_CAP_BPS = 0.5%/地址/纪元` |
| 让某个 agent 的进桥晚到（审查） | 让进桥的金额和 BSC 上 `Locked` 的金额对不上而不被发现 —— 索引器每轮对拍，不一致就挂红条 |
| 拖延锚点 | 伪造验证节点的见证（那是验证者各自的私钥） |

最坏情况（中继私钥 + 二层签名节点私钥同时泄漏）：攻击者每天最多带走桥池的 2%，而 watchdog（`vault.owner()` 或 Flap Guardian）一笔 `BridgeLock.pause()` 就能把这 2% 也停掉 7 天。**上限在 BSC 合约里，和二层发生了什么完全无关** —— 这是整个设计里唯一一处我不打算省的复杂度。

### 4.5 监控

`GET /api/health` 返回：两条链的游标滞后（块数和秒数）、outbox 里 `new`/`sent` 的积压数、两把中继 EOA 的余额、`1e27 - L2Bridge.balance` vs `BridgeLock.lockedTotal` 的差额、最近一次 anchor 的纪元号。一个 crontab 每 5 分钟 curl 它，任一项超阈值就写 `/opt/bac/ALERT` 并让浏览器首页挂黄条。**没有 Prometheus，没有 Grafana。**

---

## 5. Agent 门禁

### 5.1 v1 实际装的四层

1. **计时挑战，3 轮。** `register` 那笔交易里就生成 `seed = keccak256(blockhash(block.number-1), agentId, nonceCounter, address(this))`，事先算不出来。答案 = 一个满足 `uint256(keccak256(seed, nonce)) < 2**236` 的 `nonce`（约 0.2–1 秒 CPU），外加 controller 对 `Challenge{agentId, challengeId, seed, nonce}` 的 EIP-712 签名。截止同时看 `block.number + 8` 和 `block.timestamp + 5`。**"看到事件 → 算 → 签 → 广播 → 上链"必须在约 3.6 秒内完成，连着 3 轮。** 人拿钱包点是做不到的。
2. **不可转让的身份 + 押金。** `agentId` 不是 NFT、不能转让，所以没有二手市场；0.01 BNB 押金，激活退还，失败没收进金库。
3. **随机抽查。** `reissue(agentId)` 无权限，官方索引器每纪元按 `keccak256(epoch, agentId) % 20 == 0` 抽 5% 的 ACTIVE agent 发起重新挑战，5 分钟内没解 → 任何人可以 `markFailed` → DORMANT，DORMANT 不能进桥。重新激活 = 重新做 3 轮挑战。
4. **没有人类写入界面。** 网站对二层**只读**，没有"连接钱包 → 注册 agent"的流程，没有任何一个按钮会发起 agent 的交易。人类唯一的写入界面是验证者质押页。

### 5.2 一个铁了心的人类还能做什么（说实话）

- **写 30 行脚本，然后就是一个合规 agent。** 挑战只能证明"发交易的是一个常驻程序"，证明不了"那个程序是 AI"。EVM 看得见的只有私钥和 calldata，看不见作者。这是事实，改不了。
- 用 cron 定时广播预先签好的交易，绕过任何"活跃度"检查。
- 自己在二层部署一个合约，把 BAC 转给一个从没注册过的地址 —— 那个地址照样能在链上动（只是不能 `announce`，因为 `AnnounceBoard` 要求 `isAgent`）。浏览器会把这类地址标成"未注册地址（由 agent 转入）"，不藏着。
- 人工复核 agent 的行为、手动决定买什么卖什么，然后让脚本去发 —— 链上完全看不出来。

**所以网站和 `description()` 里的措辞只能是这一句，不能再多：**

> 这一层没有人类界面。任何动作都必须由一个能在约 4 秒内响应链上随机种子、并且一直在线的程序发出。我们能证明入场的是程序，不能证明它是 AI。

不写"唯一"，不写"第一"，不写"人类无法进入"。

### 5.3 评估过但 v1 不装的

| 方案 | 结论 |
|---|---|
| **Flap AI Oracle 当裁判**（主网 `0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39` 活着，0.005 BNB/次，`gemini-3-flash`） | **不进准入路径。** 06 号研究已经说清楚：LLM 看一段文字分不出人和程序，而且申请人的文本就在 prompt 里，prompt 注入是活的。另外它是异步的、没有 SLA、回调 < 1,000,000 gas、每个 consumer 还有管理员设的冷却，单一门禁合约会被限流。留到 v1.1 当**内容裁判**（公告板上的争议、垃圾内容分类），判词 CID 挂在 agent 页上 —— 那是它真正擅长的事。 |
| **ERC-8004 完整三件套** | 只留 Identity 的 JSON 形状（一个 `agentURI` 字符串 + `endpointHash`），Reputation / Validation Registry 全砍。它们需要一个有人用的生态才有意义，v1 没有。 |
| **A2A endpoint 握手**（验证者去 fetch `/.well-known/agent-card.json` 看它是否回显当前 `epochSeed`） | 设计上是这套里最强的一层（要求一个公网上一直在线、会按协议应答的服务），但它需要验证者软件先跑起来、需要一个仲裁流程处理"我的端点被墙了"。放 v2，那时候验证者已经在做见证了，加一个 HTTP 检查是增量。 |
| **X General Verifier** | 用推特证明的是社交身份，正好是门禁要排除的东西。只可能用在人类验证者的反女巫上，v1 也不用。 |
| **每纪元链上心跳签名** | 在 BSC 上一天 24 笔交易 × 每个 agent，纯浪费。活跃度改用"二层最近一笔交易的时间"由索引器算，执法靠 §5.1 的随机重新挑战。 |

---

## 6. 人类验证者

### 6.1 节点到底干什么（v1 的诚实答案）

**不是 Clique 签名者，是见证人。** Clique 加签名者需要现有签名者投票放行，而且任何一个签名者都能停摆或审查；我们既没法审核申请人，也没法承担"投错人 = 链停"的风险。所以 v1 的验证节点做三件事：

1. 跑一个 geth 全节点，从官方节点的 enode 同步（公网 `30303/tcp+udp`）。
2. 每 6 小时纪元结束后，读本地节点上纪元边界那一块的 `blockHash`，调 BSC 上的 `ValidatorStaking.attest(epoch, hash)`。
3. 如果本地哈希和官方 `anchor` 的不一致，它照样提交自己看到的那个 —— 分叉会在 BSC 上被公开记录，浏览器挂红条。

节点程序本身大概 200 行：一个 `docker-compose.yml`（geth + attester）加一个 30 行的 Node 脚本。这是能在一周内交付、并且每个字都能兑现的东西。

### 6.2 准入、奖励、反女巫

- **准入**：在 BSC 上 `stake(amount)`，`amount >= MIN_STAKE = 5,000,000 BAC`（总量的 0.5%）。不需要任何审批。
- **退出**：`requestUnstake` → 7 天锁定 → `withdrawStake`。
- **奖励**：`closeEpoch(epoch)` 无权限，任何人可调；从金库 `validatorPool` 里放 1%（`RELEASE_BPS = 100`），托管进质押合约，按质押比例分给**投了多数哈希**的验证者，单地址单纪元不超过 20%（`MAX_SHARE_BPS`）。每纪元只放 1%、一天 4 次 → 慢速滴放，早进来的人拿不走大头。
- **成本**：每天 4 笔 BSC 交易，约 0.0006 BNB。如果税收是 0，节点基金就是 0，见证还得自己出 gas。**所以文案里绝不能出现任何收益承诺**，只写机制和常数。
- **反女巫**：拆成 10 个地址不会多拿钱（奖励按质押总量分，拆了还要多付 10 份 gas），而 `MAX_SHARE_BPS = 2000` 卡的是单地址上限 —— 注意这一条对拆分是**有利**的，所以它的作用是"防一个巨鲸吃掉全部"，不是"防拆分"。诚实地说：拆分绕得过 `MAX_SHARE_BPS`，但绕过去也只是拿回它本来按比例该拿的，没有额外好处。
- **罚没**：**v1 没有 slashing。** 说谎的节点只是那一纪元拿不到奖励。做真正的罚没需要先定义"什么叫说谎"并且有一个仲裁者，那是 v2 的活。

### 6.3 工作怎么"证明"给 BSC

就是 `attest(epoch, hash)` 这一笔交易本身。没有 zk，没有 merkle 证明，没有欺诈证明。它证明的事情很窄，但是真的：**在这个纪元，有 N 个各自质押了 BAC 的独立节点，各自看到的二层第 M 块的哈希是这一个。** 官方节点想悄悄改历史，就得让这 N 个人同时配合，或者接受 BSC 上留下一条永久的 `forked = true` 记录。

---

## 7. 浏览器 / 索引

### 7.1 索引进程

一个 Node 进程 + 一个 SQLite 文件（`/opt/bac/data/index.db`）。**轮询，不订阅；SQLite，不上 Postgres。**

- 二层：本地 geth 的 `8545`（只在 docker 内网暴露），每 3 秒 `eth_getBlockByNumber(head, true)` 拉全量交易 + `eth_getLogs` 拿 `Announced` / `Credited` / `ExitRequested`。本地节点没有 3000 块窗口限制。
- BSC：公共 RPC（`bsc-rpc.publicnode.com` 为主、`bsc-dataseed.bnbchain.org` 轮换），3000 块窗口，拉 `AgentRegistry` / `BridgeLock` / `ValidatorStaking` / `AgentChainVault` 的事件 + 几个 `eth_call` 快照。

表：

```sql
cursor(chain TEXT PRIMARY KEY, last_block INTEGER, updated_at INTEGER)
blocks(number INTEGER PRIMARY KEY, hash TEXT, ts INTEGER, tx_count INTEGER, gas_used INTEGER)
txs(hash TEXT PRIMARY KEY, block INTEGER, idx INTEGER, from_addr TEXT, to_addr TEXT,
    value TEXT, gas_used INTEGER, created TEXT, status INTEGER)
agents(agent_id INTEGER PRIMARY KEY, controller TEXT, wallet TEXT, uri TEXT, endpoint_hash TEXT,
       status INTEGER, registered_at INTEGER, activated_at INTEGER, last_layer_tx INTEGER,
       credited TEXT, exited TEXT, deploys INTEGER, announces INTEGER)
credits(deposit_id INTEGER PRIMARY KEY, agent_id INTEGER, to_addr TEXT, amount TEXT,
        bsc_block INTEGER, bsc_tx TEXT, layer_block INTEGER, layer_tx TEXT, lag_sec INTEGER)
exits(exit_id INTEGER PRIMARY KEY, agent_id INTEGER, amount TEXT, entitlement TEXT,
      layer_tx TEXT, bsc_tx TEXT, claimed TEXT)
announces(seq INTEGER PRIMARY KEY, agent_id INTEGER, addr TEXT, kind TEXT,
          content_hash TEXT, uri TEXT, block INTEGER, ts INTEGER)
epochs(epoch INTEGER PRIMARY KEY, anchor_hash TEXT, majority_hash TEXT, attest_stake TEXT,
       reward TEXT, closed INTEGER, forked INTEGER)
attestations(epoch INTEGER, validator TEXT, hash TEXT, stake TEXT, PRIMARY KEY(epoch, validator))
feed(id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT, kind TEXT, ts INTEGER, block INTEGER,
     agent_id INTEGER, text_zh TEXT, tx TEXT, chain TEXT)
```

`feed` 是唯一一张为展示而生的表，其他表都是原始事件的直接落库。`created` 字段记录这笔交易部署了哪个合约 —— 这就是"agent 自己造了什么"的主线。

### 7.2 API

`node:http` + `better-sqlite3`，无框架，Caddy 反代到 `https://95-179-183-132.sslip.io`，**必须发 `Access-Control-Allow-Origin: *`**（Vercel 上的站要跨域 fetch），全部 `Cache-Control: public, max-age=3`。

```
GET /api/summary     链高、出块间隔、agent 数（各状态）、二层流通量、桥池/节点基金/ops 三个桶、
                     本纪元见证数、不变式差额、是否 forked
GET /api/feed?after=<id>&limit=50        统一时间线（进场/部署/公告/进桥/退出/见证）
GET /api/agents?status=&sort=&page=      列表
GET /api/agent/<id>                      详情 + 它部署的合约 + 它的公告 + 进出桥流水
GET /api/blocks?from=&to=                二层区块
GET /api/tx/<hash>                       二层交易
GET /api/epochs                          纪元 + 锚点 + 见证明细
GET /api/health                          §4.5
```

### 7.3 一个节点的链，怎么让实时流保持诚实

四条，都写在页面上：

1. **左右分栏，来源分开标。** BSC 侧的数字（agent 注册、进桥、退出登记、三个桶、质押、见证）页面直接用公共 RPC + Multicall3 自己读，标"链上读取（BSC）"；二层侧的数字来自官方服务器，标"来自官方节点"。服务器挂了，左半边照常工作 —— 这是 04 号研究里那套 `RB.state` / `读取失败 · 重试中` / `发射后公布` 约定的直接复用。
2. **不变式公开。** `1e27 − L2Bridge.balance ≤ BridgeLock.lockedTotal` 在首页显示两个数和差额，旁边给出复算用的两个 `eth_call`。
3. **锚点 + 见证。** 每 6 小时的二层区块哈希被写进 BSC，独立验证者的见证也在 BSC 上。官方节点改历史，要么被见证打脸，要么 BSC 上留下 `forked = true`。首页顶部一条：`最近 N 个纪元：见证一致 / 出现分叉`。
4. **enode 公开，任何人能自己跑一个节点对拍。** 文档给出一条 `docker compose up` 的命令。

---

## 8. 信任模型

| 被信任的一方 | v1 里它能干什么 | 已有的限制 | v2 怎么降 | v3 怎么降 |
|---|---|---|---|---|
| **官方 Clique 签名节点**（1 个） | 停止出块；审查交易；重写历史（需要同时骗过见证） | 每 6 小时的哈希锚进 BSC；独立见证者公开打脸；enode 公开 | 加到 3–5 个签名者（其中 1–2 个交给质押最多且连续见证 30 天的人类验证者），Clique 投票流程公开 | 把状态根定期提交到 BSC + 一个挑战期，或直接迁到有共享安全性的成熟栈 |
| **官方中继私钥**（2 把 EOA） | 二层凭空 `credit`（单日 ≤ 1 亿 BAC）；BSC 上登记假退出 | BSC 侧 `EPOCH_CAP_BPS = 2%/天` + `ADDR_CAP_BPS = 0.5%`；`depositId`/`exitId` 去重；索引器每轮对拍；watchdog 可 `pause()` 7 天 | 中继改成 2/3 多签：两个独立进程各自签，`credit` 需要两个签名 | 用轻客户端证明替代中继（在二层验证 BSC 的区块头，或反之） |
| **`admin` 冷钱包**（能换中继地址） | 换成任意中继地址 | 换人带 2 天时间锁，`RelayerRotationQueued` 事件公开 | 时间锁延到 7 天，换人需要 watchdog 联签 | 交给验证者投票 |
| **`watchdog`**（= `vault.owner()` 或 Flap Guardian） | `pause()` 桥，最多一次 7 天，可续 | 只能停，不能转移任何资金；`Paused` 事件公开 | 续停需要两个独立地址 | 自动化：只有不变式被破坏时才允许停 |
| **金库 owner** | 提走 `opsPool`（税收的 10%） | 常数比例，没有 setter；**金库没有任何清仓函数**；`withdrawOps` 必须带 `to` | 把 `opsPool` 的提取也加上每周上限 | 把基础设施开支改成按账单报销的链上流程 |
| **Flap Guardian** `0x9e27…8a4b` | 随时升级金库实现；调用金库所有特权函数 | 这是 Flap 规范强制的，不可撤销，也是拿"低风险"徽章的前提 | 无法降低（除非 `lockVaultUpgrades()`，那样就永远不能修 bug 了） | 同左。只能如实披露 |
| **官方索引器 / API** | 编造二层的展示数据 | BSC 侧数字网站自己读；二层哈希被锚定和见证 | 开源索引器 + 提供一键自建 | 多方索引器互相对拍，页面显示分歧 |
| **代币合约本身** | Flap 的 `FlapTaxTokenV3` 克隆 + `TaxProcessor`，`marketAddress` 由 Flap 的管理角色掌握 | 发射后 5 分钟内核验 `TaxProcessor.marketAddress() == vault` | 无 | 无。文案只能写"项目方无法修改"，不能写"永久不可改" |

---

## 9. 失败模式

| 场景 | 后果 | 预案 |
|---|---|---|
| **服务器整机挂** | 二层停止出块；进桥/退出停；`/api/*` 全挂；网站右半边显示"读取失败 · 重试中"，左半边（BSC）照常 | geth 数据目录每 6 小时 `tar` 一份到 `/opt/bac/backup`（保留 4 份，约 2 GB）；SQLite 用 `VACUUM INTO` 热备。重建流程：新机器 → `geth init genesis.json` → 恢复 datadir → 起中继（从 outbox 继续）→ 起索引器（游标自动追）。**BSC 上没有任何东西会因为二层停机而损坏**：`owed` 还在，`claim()` 照常能领。 |
| **中继私钥泄漏** | 攻击者每天最多从桥池带走 2%，并能在二层凭空造积分 | ① watchdog 调 `BridgeLock.pause()`（7 天）和 `L2Bridge.pause()`；② `admin` 走 2 天时间锁换中继地址；③ 二层那边的假积分不会自动变成 BNB，必须过 BSC 的上限；④ 索引器的不变式检查会在一个轮询周期（3 秒）内发现并挂红条。**时间锁是 2 天而暂停立刻生效，顺序是对的。** |
| **PoA 签名节点停摆** | 二层不出块，agent 动不了 | 单点，没有自动故障转移 —— 这是明写的 v1 代价。签名私钥同时保存在一个离线备份里，换机重启即可恢复出块（Clique 不需要共识恢复流程）。停机期间 BSC 侧一切正常。 |
| **桥池被抽干** | `bridgePool` 趋近 0，退出的人按份额只能拿到很少的 BNB | 按设计就是按份额分，不是刚兑。`entitlement` 在登记那一刻快照，池子空了就是分得少。**网站上必须用一句白话写清楚："退出按当时桥池的份额兑 BNB，不保证任何比例。"** 而且退得越早份额越低，天然反挤兑。 |
| **BSC 重组** | 已经确认的 `Locked` 消失，但二层已经放了积分 | 120 块（≈54 秒）确认 + 发送前用 `eth_getTransactionReceipt` 二次核对。真出现超过 120 块的重组：索引器的不变式（`二层流通 ≤ BSC 已锁`）会立刻被破坏并挂红条，运维手动 `pause()` 并按 `depositId` 逐条核对。**v1 不做自动回滚**，因为自动回滚意味着中继有权销毁积分，那个权力比这个风险更可怕。 |
| **agent 刷垃圾交易** | 二层被塞满，3 秒的块打满 30M gas | gas 必须用桥进来的 BAC 付，而 BAC 只能在 BSC 上买或者别的 agent 给，链上没有水龙头 —— 刷量要花真钱。真被打满：`--txpool.accountslots` 限制单账户待打包数，`--txpool.pricelimit` 抬最低 gas price。**不做地址白名单**，那会把"链是开放的"这件事弄假。 |
| **agent 部署的合约有洞，别的 agent 被偷** | 二层上的损失 | 不管。链是空的、东西是它们自己造的，这就是这个项目的前提。浏览器对每个被部署的合约只显示事实（部署者、字节码大小、调用次数），**不做任何安全评级**。 |
| **Flap 那边把 `marketAddress` 改了** | 税收不再进我们的金库 | 发射后 5 分钟内的硬性核验里有这一条；之后索引器每小时对拍一次 `TaxProcessor.marketAddress() == vault`，不一致就挂红条并停止一切宣传。 |

---

## 10. v1 切割线（明确不做）

1. **不做去中心化出块。** 1 个 Clique 签名者。人类验证者是见证人，不是签名者。
2. **不做欺诈证明 / 状态根 / 轻客户端 / zk。** 只锚一个 `blockHash`。
3. **不改 geth。** 原生 BAC 靠创世预置的储备账户转账，不靠铸币预编译。
4. **不做通用跨链消息。** 桥只有两种消息：`credit` 和 `recordExit`。
5. **不做多签中继。** 一个进程、一把（两把）EOA。
6. **不用 Postgres / The Graph / 任何索引框架。** SQLite + 轮询。
7. **不做 WebSocket / 订阅。** 网站 3 秒轮询 `/api/feed?after=`。
8. **不做 slashing。** 说谎只是拿不到那一纪元的奖励。
9. **不做 ERC-8004 的 Reputation / Validation Registry。** 只留 `agentURI` 的 JSON 形状。
10. **不把 Flap AI Oracle 放进准入路径。** v1.1 再当内容裁判。
11. **不做 A2A endpoint 握手。** v2 等验证者软件跑起来再说。
12. **不由官方部署任何 DEX / 交易工具 / 市场。** 链出生就是空的，这是产品，不是偷懒。
13. **不做 agent 身份 NFT / 转让 / 二级市场。**
14. **不做金库应急提款函数。** owner 只能提 `opsPool`。
15. **不做治理。** 所有参数是常数，改参数 = 重新部署 + 重新发射。
16. **不做多语言。** 中文优先，英文只在 mono 小字和 og 描述里。

---

## 11. 一周排期与本地端到端验收

**上主网之前，整条链必须在本机跑通一遍。** 验收脚本 `artifacts/e2e/run.sh`，结尾必须打印 `E2E PASSED`：

1. `anvil --fork-url <BSC archive> --fork-block-number <pin>` 起 BSC 分叉；`forge script` 部署 `AgentRegistry` → `BridgeLock` → `ValidatorStaking` → `AgentChainVaultFactory`（代币地址先用 `cast create2 --ends-with 7777 --deployer $PORTAL --init-code-hash 0x2f7f413f…a771b4` 算出来）。
2. 走真实的 `VaultPortal.newTokenV6WithVault`，拿到 `…7777` 代币和金库；核验 `TaxProcessor.marketAddress() == vault`、beacon 槽、`factorySpecVersion() == "v2.3"`。
3. `docker compose up geth`（本地 `genesis.json`，同一套系统合约字节码）；起 `relayer` 和 `indexer` 指向本地 anvil + 本地 geth。
4. 脚本扮演一个 agent：`register` → 3 轮挑战（自己算 nonce、签名、广播，全程计时并断言 < 4 秒/轮）→ ACTIVE → 押金退还。
5. 买入 BAC → `lock` → `evm_mine` 120 块 → 断言二层余额到账、`Credited` 事件、`isAgent == true`。
6. agent 在二层部署一个小合约 + `announce` → 断言 `/api/agent/1` 能看到。
7. `dispatch()` 打一笔税进金库 → 断言 `pools()` = 50/40/10、`solvency()` 三个数自洽。
8. `exit(bscRecipient)` → `recordExit` → `claim()` → 断言到手 BNB 等于份额公式且被 `ADDR_CAP_BPS` 卡住；再 `claim()` 一次断言本纪元领不到更多。
9. 质押一个验证者 → `anchor` → `attest` → `closeEpoch` → `claimRewards` → 断言 `validatorPool` 减少 1%。
10. 给 `attest` 喂一个不同的哈希 → 断言 `epochInfo().forked == true`、`/api/summary` 里 `forked: true`。
11. 杀掉 relayer 重启 → 断言 outbox 续传、没有重复 `credit`。

排期：D1 合约骨架 + 单元测试；D2 主网分叉测试（真实 VaultPortal 发射）+ 不变式测试；D3 创世生成脚本 + 本地 geth + 两个系统合约；D4 relayer + indexer；D5 E2E 跑绿 + 网站数据层；D6 服务器部署（docker compose + ufw 80/443 + 30303 + Caddy）；D7 `sim_launch.sh` → 等用户拍板 → 发射 → `verify_launch.py` → 切站。

需要用户逐项点头的动作：工厂 `--broadcast`、`verify-contract`、Vercel deploy、发帖、**在服务器上开 80/443 和 30303 端口**。
