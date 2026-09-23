# 01 · BNB Agent Chain 合约技术规格

2026-09-22。本文是 `00-DESIGN-SPEC.md` 的细化，**外部 ABI 逐字为准**：网站、SDK、索引器、测试、`sim_launch.sh`、`verify_launch.py` 都按本文编写。
凡本文与 `00` 冲突，以 `00` 为准；凡本文与 `docs/decisions.md` 冲突，以 `decisions.md` 为准；凡本文与 Flap 规则 001–010 冲突，以 Flap 规则为准。

---

## 0. 工具链与全局约定

| 项 | 值 |
|---|---|
| solc | `0.8.26`（`v0.8.26+commit.8a97fa7a`） |
| evm_version | `cancun` |
| optimizer | `true`，`runs = 200` |
| via_ir | `true`（必需：没有它金库过不了 EIP-170 的 24,576 字节） |
| OpenZeppelin | `4.9.6` + `4.9.6-upgradeable`（`UpgradeableBeacon(impl)` 把 `owner` 设为 `msg.sender` 并用字符串 revert，不是 custom error） |
| forge-std | `1.14.0` |
| `src/flap/*` | 14 个文件**逐字复制、永不修改**（4 个基类 + 10 个 `I*.sol`） |
| revert | **一律 `require(cond, unicode"English / 中文")`，我们自己写的每一个合约禁止 custom error**（网站只解 `Error(string)` 并显示中文半句） |
| 规则 004 的唯一豁免 | `src/flap/*` 里**已经存在**四个 custom error，逐字复制的文件不许改：`UnsupportedChain`（`VaultBase.sol:62`、`VaultFactoryBaseV2.sol:189`）、`LegacyV6ValidationHookNotImplemented`（`VaultFactoryBaseV2.sol:193`）、`OnlyVaultPortal`（`IVaultFactory.sol:22`）、`ZeroAddress`（`IVaultFactory.sol:25`）。它们会出现在 `BacTreasuryVault` / `BacVaultFactory` 的 ABI 里（rat 的编译产物实测：金库 `['UnsupportedChain']`，工厂 `['LegacyV6ValidationHookNotImplemented','OnlyVaultPortal','UnsupportedChain','ZeroAddress']`）。这四个在 56/97 的正常路径上都不可达（chainId 白名单命中、调用者是 VaultPortal、非零地址、legacy hook 不被调用），所以网站只解 `Error(string)` 不受影响。**规则 004 的门禁按这个白名单写，见 §10。** |
| `remappings.txt` | 5 行（`ds-test/`、`erc4626-tests/`、`forge-std/`、`@openzeppelin/`、`@openzeppelin-contracts-upgradeable/`） |
| 链接库 CREATE2 | 部署器 `0x4e59b44847b379578588920cA78FbF26c0B4956C`，salt 0 → **`BacVaultUI` 的字节码必须与 fly/rat 的库不同**，否则撞已用地址 |

**固定地址（BSC 主网 chainId 56）**

| 名称 | 地址 |
|---|---|
| VaultPortal | `0x90497450f2a706f1951b5bdda52B4E5d16f34C06` |
| Portal | `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` |
| Flap Guardian | `0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b`（合约，codesize 2882，**拒收裸 BNB** → 所有 Guardian 可调的出金必须带 `to`） |
| Tax Token V3 impl（clone base） | `0x024f18294970B5c76c0691b87f138A0317156422`，initcode hash `0x2f7f413fcc6c3812c665c15bd4a012e663f567d626112a81d401066fd5a771b4` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| beacon 存储槽 | `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50` |
| MAGIC_DIVIDEND_COMPUTED | `0xC0Dec0dec0DeC0Dec0dEc0DEC0DEC0DEC0DEC0dE` |
| 死地址（BAC 销毁） | `0x000000000000000000000000000000000000dEaD` |

**合约清单**

| # | 链 | 文件 | 合约 | 可升级 | owner |
|---|---|---|---|---|---|
| 1 | BSC | `src/BacVaultFactory.sol` | `BacVaultFactory is VaultFactoryBaseV2` | 否（无 Ownable） | 无 |
| 2 | BSC | `src/BacTreasuryVault.sol` | `BacTreasuryVault is Initializable, VaultBaseV3, ReentrancyGuardUpgradeable` | **是（BeaconProxy，仅 Flap Guardian）** | 有（无动钱权力） |
| 3 | BSC | `src/lib/BacVaultUI.sol` | `library BacVaultUI`（外部链接库，放长字符串） | 否 | 无 |
| 4 | BSC | `src/AgentRegistry.sol` | `AgentRegistry is ERC721`（不可转让） | 否 | admin 冷钥（仅 ban/时锁） |
| 5 | BSC | `src/BacBridge.sol` | `BacBridge` | 否 | 无 owner，watchdog 只能 pause |
| 6 | BSC | `src/BacNodeFund.sol` | `BacNodeFund` | 否 | 有（决策 #10 的受益人） |
| 7 | BSC | `src/ChainAnchor.sol` | `ChainAnchor`（**不持有任何资金**） | 否 | admin / veto 冷钥 |
| 8 | BSC | `src/ValidatorStaking.sol` | `ValidatorStaking` | 否 | admin 冷钥（仅 removeValidator/时锁） |
| 9 | LAYER | `src/layer/L2Bridge.sol` | `L2Bridge` @ `0x…0101` | 否 | 无（仅 relayer + 创世写死的 ROTATION_SIGNER） |
| 10 | LAYER | `src/layer/L2Gate.sol` | `L2Gate` @ `0x…0102` | 否 | 无（仅 relayer） |
| 11 | LAYER | `src/layer/AgentBook.sol` | `AgentBook` @ `0x…0103` | 否 | 无 |

---

## 1. `BacVaultFactory`

### 1.1 外部 ABI（逐字）

```solidity
contract BacVaultFactory is VaultFactoryBaseV2 {
    // ---- immutable / constant ----
    address public immutable beacon;                 // 构造函数内创建，beacon.owner() == address(this)
    address public immutable LAUNCHER;               // 只有这个地址能用本工厂发射（决策 #11）
    uint16  public constant REQUIRED_MKT_BPS      = 10000;
    uint16  public constant REQUIRED_BUY_TAX_BPS  = 200;
    uint16  public constant REQUIRED_SELL_TAX_BPS = 200;

    constructor(address launcher_);
    // constructor: require(launcher_ != address(0), unicode"Launcher is zero / 发射地址为零");
    //              LAUNCHER = launcher_;
    //              beacon = address(new UpgradeableBeacon(address(new BacTreasuryVault())));
    // 绝不在部署脚本里创建 beacon（owner 会变成部署者，规则 009 Critical）

    // ---- IVaultFactory ----
    function newVault(address taxToken, address quoteToken, address creator, bytes calldata vaultData)
        external override returns (address vault);                                   // 0x15b92d7a
    function isQuoteTokenSupported(address quoteToken) external pure override returns (bool); // 0xb62a4f9a

    // ---- VaultFactoryBaseV2 overrides ----
    function factorySpecVersion() public pure override returns (string memory);      // "v2.3"
    function vaultDataSchema() public pure override returns (IVaultSchemasV1.VaultDataSchema memory);
    function tokenCreationPolicies() public pure override returns (IVaultSchemasV1.FactoryPolicy[] memory);
    function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
        internal pure override returns (bool success, string memory reason);
    // 不覆盖 onBeforeLaunch（基类已实现）；绝不覆盖 onBeforeNewTokenV6WithVault（它必须永远 revert）

    // ---- Guardian-only ----
    function upgradeVaultImplementation(address impl) external;                      // 0x17e4c4d9
    function lockVaultUpgrades() external;                                           // 0xfb978ecb

    // ---- views ----
    function isVaultUpgradesLocked() external view returns (bool);
    function beaconImplementation() external view returns (address);

    event BacTreasuryVaultCreated(
        address indexed vault,
        address indexed taxToken,
        address indexed creator,
        address owner,
        address bridge,
        address nodeFund
    );
}
```

### 1.2 `newVault` 的逐条检查（顺序即代码顺序）

| # | 检查 | require 字符串 |
|---|---|---|
| 1 | `msg.sender == _getVaultPortal()` | `unicode"Only VaultPortal / 仅限 VaultPortal 调用"` |
| 2 | `quoteToken == address(0)` | `unicode"BNB quote only / 仅支持 BNB 计价"` |
| 3 | `creator == LAUNCHER` | `unicode"Launcher not allowed / 该地址不能用此工厂发射"` |
| 4 | `abi.decode(vaultData, (address, address, address))` → `(owner_, bridge_, nodeFund_)`；`owner_ == 0` 时取 `creator` | —（解码失败会自然 revert） |
| 5 | `bridge_ != address(0) && nodeFund_ != address(0) && bridge_ != nodeFund_` | `unicode"Bad bridge or node fund / 桥或节点基金地址无效"` |
| 6 | `bridge_.code.length > 0 && nodeFund_.code.length > 0` | `unicode"Bridge or node fund has no code / 桥或节点基金不是合约"` |
| 7 | `IBacBridge(bridge_).bacToken() == taxToken` | `unicode"Bridge is bound to another token / 桥绑定的是别的代币"` |
| 8 | `IBacNodeFund(nodeFund_).bacToken() == taxToken` | `unicode"Node fund is bound to another token / 节点基金绑定的是别的代币"` |
| 9 | `vault = address(new BeaconProxy(beacon, abi.encodeCall(BacTreasuryVault.initialize, (taxToken, owner_, bridge_, nodeFund_))))` | — |
| 10 | `emit BacTreasuryVaultCreated(vault, taxToken, creator, owner_, bridge_, nodeFund_)` | — |

**绝对禁止：** 在 `newVault` 或 `initialize` 里以任何方式调用 `taxToken`（此刻它还没有代码，一碰整笔发射 revert）。第 7/8 条调的是**我们自己先部署好的合约**，合法。

### 1.3 发射时校验表（`_validateBeforeLaunch`，`staticcall`，reason 会被 flap.sh 原样显示）

> **这个钩子必须 `return`，绝对不许 `require`。** 基类签名是
> `returns (bool success, string memory reason)`；VaultPortal 用 **`staticcall`** 调 `onBeforeLaunch(bytes)`，
> 拿到 `(false, reason)` 才会把我们的双语 reason 原样 revert 出来（规则 002 / 004）。
> 如果这里写 `require`：① 合法发射会因为命名返回值 `success` 保持默认 `false` 而 revert，reason 为空串；
> ② 非法发射会让 `staticcall` 自己失败，VaultPortal 解不出 `(bool,string)`，显示的是
> `"Factory validation hook missing"` 而不是我们的 reason —— 九条边界一条都说不出话。

**逐字骨架（rat `LabEscapeVaultFactory.sol:70-92` 的同一形状，照抄，只换条件与文案）：**

```solidity
function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
    internal pure override returns (bool success, string memory reason)
{
    if (data.quoteToken != address(0))
        return (false, unicode"BNB quote only / 仅支持 BNB 计价");
    if (data.tokenVersion != IPortalTypes.TokenVersion.TOKEN_TAXED_V3)
        return (false, unicode"Tax Token V3 only / 仅支持 Tax Token V3");
    if (data.buyTaxRate != 200)
        return (false, unicode"Buy tax must be exactly 2% / 买税必须正好是 2%");
    if (data.sellTaxRate != 200)
        return (false, unicode"Sell tax must be exactly 2% / 卖税必须正好是 2%");
    if (data.vaultBps != 10000)
        return (false, unicode"Vault share must be exactly 100% / 金库份额必须正好是 100%");
    if (data.dividendBps != 0)
        return (false, unicode"Holder dividend must be 0% / 持币分红必须为 0%");
    if (data.deflationBps != 0)
        return (false, unicode"Deflation must be 0% / 销毁必须为 0%");
    if (data.lpBps != 0)
        return (false, unicode"LP share must be 0% / 加流动性必须为 0%");
    if (data.dividendToken == MAGIC_DIVIDEND_COMPUTED)
        return (false, unicode"Computed dividend token not supported / 不支持自动推导分红代币");
    return (true, "");
}
```

| 字段 | 边界 | `reason` 字符串（用 `return (false, reason)`，**永不 `require`**） |
|---|---|---|
| `data.quoteToken` | `== address(0)` | `unicode"BNB quote only / 仅支持 BNB 计价"` |
| `data.tokenVersion` | `== IPortalTypes.TokenVersion.TOKEN_TAXED_V3`（6） | `unicode"Tax Token V3 only / 仅支持 Tax Token V3"` |
| `data.buyTaxRate` | `== 200` | `unicode"Buy tax must be exactly 2% / 买税必须正好是 2%"` |
| `data.sellTaxRate` | `== 200` | `unicode"Sell tax must be exactly 2% / 卖税必须正好是 2%"` |
| `data.vaultBps`（= 表单 `mktBps`） | `== 10000` | `unicode"Vault share must be exactly 100% / 金库份额必须正好是 100%"` |
| `data.dividendBps` | `== 0` | `unicode"Holder dividend must be 0% / 持币分红必须为 0%"` |
| `data.deflationBps` | `== 0` | `unicode"Deflation must be 0% / 销毁必须为 0%"` |
| `data.lpBps` | `== 0` | `unicode"LP share must be 0% / 加流动性必须为 0%"` |
| `data.dividendToken` | `!= MAGIC_DIVIDEND_COMPUTED` | `unicode"Computed dividend token not supported / 不支持自动推导分红代币"` |

**钩子看不见的字段（`research/01-flap-spec.md` §2.3 逐字列举）：** `name, symbol, meta, dexThresh, salt,
migratorType, quoteAmt, permitData, extensionID, extensionData, dexId, lpFeeProfile, **taxDuration**,
**antiFarmerDuration**, commissionReceiver, vaultData, creator`。
其中 `vaultData` / `creator` 在 `newVault` 里校验（§1.2）；**`taxDuration` / `antiFarmerDuration` 工厂永远管不到，
只能靠 §00 §7.3 的硬停清单第 11/12 项在发射后 5 分钟内抓**（填错一次 = 税收可能永久为 0，只能重新发射）。

**为什么税率要用 `==` 钉死：** `description()` 与 `vaultDataSchema().description` 是 `pure`、部署即冻结；里面写的「税收扣掉 10% 协议费后一半进桥池」只有在税率、`mktBps`、`dividendBps` 全部确定时才保证为真。Flap 规则 001-h 的开发者桶上限 `6/taxRateBps` 也是税率的函数（2% → 3.0%），不钉死税率，这个比值在部署时就是不确定的。

### 1.4 `tokenCreationPolicies()`（8 条；`target` 用 `"mktBps"` 不是 `"vaultBps"`）

```solidity
policies = new FactoryPolicy[](8);
policies[0] = FactoryPolicy("quoteToken",   "eq", abi.encode(address(0)),
                            unicode"Quote token must be BNB / 计价币必须是 BNB");
policies[1] = FactoryPolicy("tokenVersion", "eq", abi.encode(uint8(6)),
                            unicode"Tax Token V3 only / 仅支持 Tax Token V3");
policies[2] = FactoryPolicy("mktBps",       "eq", abi.encode(uint16(10000)),
                            unicode"All tax goes to the treasury vault / 税收全部进国库金库");
policies[3] = FactoryPolicy("dividendBps",  "eq", abi.encode(uint16(0)),
                            unicode"No holder dividend / 不做持币分红");
policies[4] = FactoryPolicy("buyTaxRate",   "eq", abi.encode(uint16(200)),
                            unicode"Buy tax fixed at 2% / 买税固定 2%");
policies[5] = FactoryPolicy("sellTaxRate",  "eq", abi.encode(uint16(200)),
                            unicode"Sell tax fixed at 2% / 卖税固定 2%");
policies[6] = FactoryPolicy("deflationBps", "eq", abi.encode(uint16(0)),
                            unicode"No deflation burn / 不做销毁");
policies[7] = FactoryPolicy("lpBps",        "eq", abi.encode(uint16(0)),
                            unicode"No LP share / 不加流动性");
```

**本表镜像 §1.3 九条里的八条。** 第九条（`dividendToken != MAGIC_DIVIDEND_COMPUTED`）是「不等于某个常量」，
`FactoryPolicy` 的 `op` 只有等值语义，写成 `"eq" address(0)` 会把「任何非 MAGIC 的地址都可以」说成「必须是零地址」，
是假披露，所以**只留在钩子里**。`tokenCreationPolicies()` 是信息性接口，缺一条不影响强制力（强制力全在钩子），
但 §10 要断言「本表每一条都能在 §1.3 的骨架里找到同名同值的判断」。

### 1.5 `vaultDataSchema()`（三个字段，全静态，顺序与 `abi.decode` 逐字一致）

```solidity
FieldDescriptor[] memory f = new FieldDescriptor[](3);
f[0] = FieldDescriptor("owner",    "address",
        unicode"Vault owner. It has no power to move any funds; leave 0x0 to use the launching wallet. / 金库 owner。它没有任何动用资金的权力；填 0x0 则为发射钱包。", 0);
f[1] = FieldDescriptor("bridge",   "address",
        unicode"BacBridge address (holds the bridge pool). / BacBridge 地址（持有桥池）。", 0);
f[2] = FieldDescriptor("nodeFund", "address",
        unicode"BacNodeFund address (holds the official node fund). / BacNodeFund 地址（持有官方节点基金）。", 0);
schema.fields = f;
schema.isArray = false;
schema.description = <见 §1.6>;
```

`vaultData = abi.encode(address owner, address bridge, address nodeFund)`（三个静态字段 ⇒ 与扁平 `abi.encode(a,b,c)` 完全一致）。三个字段 `decimals` 全 0，表单不做任何缩放。

### 1.6 `vaultDataSchema().description`（**部署即冻结，逐字**）

> BNB Agent Chain treasury vault (beacon proxy; only the Flap Guardian can upgrade it). Every BNB this vault receives — trading tax after Flap's 10% protocol fee, plus any donation, any forced balance and any forfeited agent deposit swept in from AgentRegistry — is split by a hard-coded constant with no setter: 50% is pushed to BacBridge as the bridge pool, which is the only source of BNB for agents exiting the layer, and 50% is pushed to BacNodeFund as the official node fund. The node fund half can be withdrawn by the owner of that BacNodeFund contract; read `BacNodeFund.owner()` on chain — it is a separate, two-step transferable address and is NOT this vault's `owner()`. That 50% developer bucket is far above the 3.0% that Flap rule 001-h suggests for a 2% tax; it is disclosed here on purpose and it pays for the servers, the signer node, the relayer and the validator reward pool of a chain that has no other funding. Anyone can call `settle()` to push the two halves out; nobody is paid to do it, so between two settles the vault holds the unsplit remainder. Both targets are non-upgradeable contracts; the vault itself has no owner withdrawal, no emergency withdrawal and no rescue function. Neither the vault owner nor the Flap Guardian has any path to the bridge pool. Exits are paid as a pro-rata share of the bridge pool, released slowly with a per-epoch and a per-address cap; no amount is promised. / BNB Agent Chain 国库金库（beacon 代理；只有 Flap Guardian 能升级）。本金库收到的每一笔 BNB —— 扣除 Flap 10% 协议费后的交易税，以及任何捐赠、任何被强推进来的余额、以及从 AgentRegistry 扫进来的被没收 agent 押金 —— 都按合约里写死、没有任何修改函数的常量分成两半：50% 推给 BacBridge 作为桥池，这是 agent 退出二层时唯一的 BNB 来源；50% 推给 BacNodeFund 作为官方节点基金。节点基金这一半由 BacNodeFund 合约的 owner 提取；请在链上读 `BacNodeFund.owner()` —— 它是一个独立的、可两步转让的地址，**不是**本金库的 `owner()`。这 50% 的开发者桶远高于 Flap 规则 001-h 对 2% 税率建议的 3.0%；我们在这里如实披露，它用于支付服务器、出块签名节点、中继和验证者奖励池 —— 这条链没有别的经费来源。任何人都可以调用 `settle()` 把两半推走；没有人因此拿到报酬，所以两次 settle 之间金库里会留着尚未分账的零头。两个接收合约都不可升级；金库本身没有 owner 提款、没有紧急提款、没有任何救援函数。金库 owner 和 Flap Guardian 都没有任何路径能动桥池。退出按桥池份额兑付，慢速释放，有每纪元上限和单地址上限，不承诺任何金额。

---

## 2. `BacTreasuryVault`

### 2.1 外部 ABI（逐字）

```solidity
contract BacTreasuryVault is Initializable, VaultBaseV3, ReentrancyGuardUpgradeable {
    uint16  public constant BPS        = 10000;
    uint16  public constant BRIDGE_BPS = 5000;     // 节点基金那一半用 general - toBridge 的余数法算
    uint256 public constant PUSH_GAS   = 100_000;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor();                                  // _disableInitializers()

    function initialize(address taxToken_, address owner_, address bridge_, address nodeFund_) external initializer;
    receive() external payable;                     // 只做 _syncRevenue()，目标 < 50,000 gas，任何路径都不 revert

    // ---- 无许可的状态变更（三个都不需要任何权限）----
    function sync()      external nonReentrant;
    function settle()    external nonReentrant returns (uint256 toBridge, uint256 toNodeFund);
    function retryPush() external nonReentrant returns (uint256 bridgeSent, uint256 nodeFundSent);
    // settle() / retryPush() 都出现在 vaultUISchema().methods 里（§2.4），flap.sh 会把它们渲染成
    // 两个无输入的 Submit 按钮 —— 这是「有人会去调它」的唯一保证，不能删。

    // ---- 唯一的受限函数（owner 或 Guardian 各自单独即可，规则 001-d/e）----
    function transferOwnership(address newOwner) external nonReentrant;

    // ---- 无输入 view（flap.sh 打开页面立即调用，必须永不 revert）----
    function taxToken()            external view returns (address);
    function bridge()              external view returns (address);
    function nodeFund()            external view returns (address);
    function owner()               external view returns (address);
    function accountedQuote()      external view returns (uint256);
    function unsplitRevenue()      external view returns (uint256);
    function stuckAmounts()        external view returns (uint256 stuckBridge, uint256 stuckNodeFund);
    function lifetimeToBridge()    external view returns (uint256);
    function lifetimeToNodeFund()  external view returns (uint256);
    function totalRecognized()     external view returns (uint256);
    function solvency()            external view returns (uint256 balance, uint256 accounted, uint256 buckets);
    function vaultQuoteToken()     public view override returns (address);   // address(0)，不是 WBNB
    function vaultSpecVersion()    public pure override returns (string memory);  // 基类给的 "v3"
    function description()         public view override returns (string memory);  // 0x7284e416
    function vaultUISchema()       public pure override returns (VaultUISchema memory); // 0xdf72036c

    event RevenueRecognized(address indexed from, uint256 amount);
    event RevenueSplit(uint256 toBridge, uint256 toNodeFund);
    event PushSucceeded(address indexed to, uint256 amount);
    event PushFailed(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed from, address indexed to);
}
```

### 2.2 状态变量与存储布局

槽 0 = `_initialized`/`_initializing`，槽 1 = `_status`（ReentrancyGuard），槽 2–50 = `__gap[49]`，项目存储**从槽 51 开始**，append-only，尾部留 `__gap`。

| 槽 | 变量 | 说明 |
|---|---|---|
| 51 | `uint256 _revenue` | **低 128 位 = `accountedQuote`，高 128 位 = 未分账的 `unsplit`**。`receive()` 只写这一个槽 |
| 52 | `address _taxToken` | initialize 写入，无 setter |
| 53 | `address _bridge` | initialize 写入，无 setter |
| 54 | `address _nodeFund` | initialize 写入，无 setter |
| 55 | `address _owner` | 仅 `transferOwnership` 可改 |
| 56 | `uint128 _stuckBridge; uint128 _stuckNodeFund` | 推送失败的金额，仍计入 `accountedQuote` |
| 57 | `uint128 _lifetimeToBridge; uint128 _lifetimeToNodeFund` | 只增 |
| 58–97 | `uint256[40] __gap` | 升级预留 |

**升级规则：** 只能在 `__gap` 前追加新变量并相应缩短 `__gap`；不得重排、不得改类型、不得删除；实现合约里**不得有任何 per-vault 的 `immutable`**（所有代理共享同一份实现）；`initialize` 是唯一的状态设置入口，且**不得有任何外部调用**。

### 2.3 核心算法（必须逐字照做的五段）

```solidity
// ① receive 路径：1 SLOAD + 1 BALANCE + 1 SSTORE + 1 event。不得加第二个 SSTORE。
function _syncRevenue() internal {
    uint256 bal = address(this).balance;
    uint256 rev = _revenue;
    uint256 acct = uint128(rev);
    if (bal <= acct) return;                          // 零增量唤醒 = 静默 no-op
    uint256 delta = bal - acct;
    _revenue = (((rev >> 128) + delta) << 128) | bal; // 高半 += delta，低半 = bal
    emit RevenueRecognized(msg.sender, delta);
}
receive() external payable { _syncRevenue(); }        // 不是 nonReentrant，也不能是

// ② 分账：最后一个桶用减法算，吸收取整，两桶永远精确等于 general
function settle() external nonReentrant returns (uint256 toBridge, uint256 toNodeFund) {
    _syncRevenue();
    uint256 rev = _revenue;
    uint256 unsplit = rev >> 128;
    if (unsplit != 0) {
        toNodeFund = (unsplit * (BPS - BRIDGE_BPS)) / BPS;   // 先算 owner 那一半，向下取整
        toBridge   = unsplit - toNodeFund;                   // 余数（最多 1 wei）永远归桥池，不归 owner
        _revenue = uint128(rev);                       // 清高半，保留 accountedQuote
        emit RevenueSplit(toBridge, toNodeFund);
        _push(_bridge, toBridge, true);
        _push(_nodeFund, toNodeFund, false);
    }
    _retry();                                          // 顺手重试 stuck
}

// ③ 出金：call 之前先扣 accounted；call 之后从 storage 重读 _revenue（规则 010：
//    "never cache accountedQuote across an external call" —— receive() 可能在这次调用中被回打）
function _push(address to, uint256 amount, bool isBridge) internal {
    if (amount == 0) return;
    require(amount <= type(uint128).max, unicode"Amount too large / 金额过大");
    // EIP-150 的 63/64 规则：外层必须真的剩下 PUSH_GAS，否则「gas 不够」会被当成「下游拒收」，
    // 任何人都能用恰好不够的 gas 调 settle() 把每一笔收入打进 stuck*（A9）。
    require(gasleft() >= PUSH_GAS * 64 / 63 + 10_000, unicode"Not enough gas to push / gas 不足以推送");
    uint256 rev = _revenue;
    uint256 acct = uint128(rev);
    _revenue = rev - (acct < amount ? acct : amount);          // 先扣
    (bool ok, ) = to.call{value: amount, gas: PUSH_GAS}(abi.encodeWithSignature("acceptRelease()"));
    uint256 rev2 = _revenue;                                    // ← 必须重读，不得复用 rev
    if (ok) {
        if (isBridge) _lifetimeToBridge += uint128(amount); else _lifetimeToNodeFund += uint128(amount);
        emit PushSucceeded(to, amount);
    } else {
        _revenue = rev2 + amount;                                  // 把 accounted 原样加回来
        if (isBridge) _stuckBridge += uint128(amount); else _stuckNodeFund += uint128(amount);
        emit PushFailed(to, amount);
        // 加回 accounted 与累加 stuck* 必须同生共死：只做一半就直接破掉 V1（A15）。
        // 上面的 amount <= uint128.max 与 V2（balance >= accounted）保证这里不会溢出。
    }
}

// ④ 重试：必须「先清零，再推送」，失败由 _push 自己加回来。
//    反过来写（推送成功才清零）会让每一次失败的重试都把 stuck* 再加一遍：
//    stuck 翻倍 → stuck > balance → to.call 永远返回 false（EVM CALL 语义，余额不足不 revert）
//    → 永久死锁，而金库按设计没有任何救援函数。
function _retry() internal {
    uint128 sb = _stuckBridge;
    if (sb != 0) { _stuckBridge = 0; _push(_bridge, sb, true); }
    uint128 sn = _stuckNodeFund;
    if (sn != 0) { _stuckNodeFund = 0; _push(_nodeFund, sn, false); }
}
function retryPush() external nonReentrant returns (uint256 bridgeSent, uint256 nodeFundSent) {
    uint128 b0 = _stuckBridge; uint128 n0 = _stuckNodeFund;
    _retry();
    bridgeSent   = b0 - _stuckBridge;      // 失败时 _push 已把原额加回，差值为 0
    nodeFundSent = n0 - _stuckNodeFund;
}

// ⑤ transferOwnership（唯一受限函数）
modifier onlyOwnerOrGuardian() {
    require(msg.sender == _owner || msg.sender == _getGuardian(),
            unicode"Only owner or guardian / 仅限 owner 或 Guardian");
    _;
}
```

**`settle()` 绝不因下游 revert 而失败**；`_push` 失败只记 `stuck*` 并发事件。
`retryPush()` 无许可：**推送前先把 `stuck*` 清零，失败由 `_push` 的失败分支加回**（顺序不可颠倒，见 ④ 的注释）。

**`totalRecognized()` 的定义（ABI 里有，这里补上公式，无新增存储）：**
`totalRecognized() = lifetimeToBridge() + lifetimeToNodeFund() + accountedQuote()` —— 历史上确认过的全部收入。
`settle()` 的返回值与 `RevenueSplit` 事件报的是**分账额**（记账动作），不是**实际推出去的额**；
实际推出去的以 `PushSucceeded` / `PushFailed` 与 `lifetimeTo*` 为准，索引器和网站必须按后者显示。

### 2.4 `vaultUISchema()`（8 个 view + 2 个无输入写方法，零 approvals，逐字）

```solidity
schema.vaultType   = "BacTreasuryVault";
schema.description = unicode"Treasury of BNB Agent Chain. Every BNB that arrives (trading tax after Flap's protocol fee, donations, forfeited agent deposits) is split 50/50 into the bridge pool and the official node fund. Anyone can press Settle to push the two halves out; nobody is paid to do it, so the vault holds the unsplit remainder between settles. The two buttons below are the only write methods and neither of them takes an address: they cannot send BNB anywhere except the two contracts fixed at deployment. There is no human-facing interface to the layer itself. / BNB Agent Chain 的国库。到账的每一笔 BNB（扣除 Flap 协议费后的交易税、捐赠、被没收的 agent 押金）按 50/50 分成桥池和官方节点基金。任何人都可以按 Settle 把两半推走；没有人因此拿到报酬，所以两次 settle 之间金库里留着尚未分账的零头。下面两个按钮是仅有的写方法，且都不接受任何地址参数：它们只能把钱推给部署时就写死的那两个合约。二层本身没有给人用的界面。";
schema.methods = new VaultMethodSchema[](10);
```

| i | `name` | `inputs` | `outputs` | `isWriteMethod` | 说明（双语，`description` 字段） |
|---|---|---|---|---|---|
| 0 | `taxToken` | 空 | `[("taxToken","address",…,0)]` | false | BAC 代币地址 / The BAC token |
| 1 | `bridge` | 空 | `[("bridge","address",…,0)]` | false | 桥池合约（不可升级）/ Bridge pool contract (non-upgradeable) |
| 2 | `nodeFund` | 空 | `[("nodeFund","address",…,0)]` | false | 官方节点基金合约（不可升级）/ Official node fund contract |
| 3 | `owner` | 空 | `[("owner","address",…,0)]` | false | 金库 owner，无动钱权力；**节点基金的提取人请读 `BacNodeFund.owner()`** / Vault owner, no power to move funds; the node fund withdrawer is `BacNodeFund.owner()` |
| 4 | `accountedQuote` | 空 | `[("accountedQuote","uint256",…,18)]` | false | 已确认但尚未推走的 BNB / Recognized BNB not yet pushed out |
| 5 | `lifetimeToBridge` | 空 | `[("lifetimeToBridge","uint256",…,18)]` | false | 累计推给桥池的 BNB / Lifetime BNB pushed to the bridge pool |
| 6 | `lifetimeToNodeFund` | 空 | `[("lifetimeToNodeFund","uint256",…,18)]` | false | 累计推给节点基金的 BNB / Lifetime BNB pushed to the node fund |
| 7 | `solvency` | 空 | `[("balance","uint256",…,18),("accounted","uint256",…,18),("buckets","uint256",…,18)]` | false | 余额 / 已记账 / 桶之和，三者必须自洽 / Balance, accounted, bucket sum |
| 8 | `settle` | **空** | **空** | **true** | 把未分账的收入按 50/50 推给桥池与节点基金。无许可，无参数，谁调都一样，调用者不拿一分钱 / Push the unsplit revenue out 50/50. Permissionless, no parameters, the caller is paid nothing |
| 9 | `retryPush` | **空** | **空** | **true** | 重试之前推送失败的金额（`stuckBridge` / `stuckNodeFund`）。无许可，无参数 / Retry amounts whose earlier push failed. Permissionless, no parameters |

**为什么必须给出这两个写方法（规则 001/002 + `00` §5 的 Guardian 风险缓解）：**
`TaxProcessor.dispatch()` 只会走到 `receive()`，而 `receive()` 按规则 005 只做 `_syncRevenue()`。
`00` §6 第 6 条已排除 Flap Trigger 与任何 keeper，严格 50/50 也没有一个桶可以拿来付赏金 ——
**所以没有任何合约、任何定时器、任何激励会去调 `settle()`**。
如果 `vaultUISchema()` 一个写方法都不给，flap.sh 的自动 UI 就连按钮都不渲染，
唯一的推送方式是手敲 `cast`，税收会一直堆在一个 Flap Guardian 可以随时升级的合约里 ——
而「金库稳态余额 ≈ 0」正是 `00` §2 信任表对 Guardian 风险给出的**唯一**缓解。
按 `research/01-flap-spec.md` §3，**无输入的写方法在 flap.sh 上渲染成一个 Submit 按钮**，
所以把这两个函数列出来，等于让任何打开页面的人都能帮我们把钱推走。

**运营承诺（写进 runbook 与 `/api/health`）：** 官方索引器每纪元调用一次 `settle()`；
连续 2 个纪元未成功（或 `accountedQuote` 连续 2 个纪元非零且单调上升）即告警。
这是承诺，不是机制 —— 文案里必须这么写。

**硬性要求（规则 002/规则 001）：** 每个 `name` 必须是精确的 Solidity 函数名（选择器由 `name` + 入参 `fieldType` 拼出）；
前八个是**无输入 view**，flap.sh 在页面加载时立即调用，**必须永不 revert**；
两个写方法的 `outputs` **必须为空数组**（规则要求写方法不返回值；Solidity 侧的返回值不影响 schema）；
`m.inputs`、`m.outputs`、`m.approvals` 每一个数组都要显式初始化（`new FieldDescriptor[](0)` / `new ApproveAction[](0)`），
不能留未初始化的数组；**`approvals` 全部为空**（金库不碰任何 ERC20，不需要授权）。

### 2.5 `description()`（运行时渲染，放在 `BacVaultUI` 外部库里）

```solidity
function description() public view override returns (string memory) {
    return BacVaultUI.describe(
        _taxToken,
        [ uint256(uint128(_revenue)),          // accountedQuote
          uint256(_revenue >> 128),            // unsplit
          uint256(_lifetimeToBridge),
          uint256(_lifetimeToNodeFund),
          uint256(_stuckBridge),
          uint256(_stuckNodeFund),
          uint256(BRIDGE_BPS),
          address(this).balance ],
        _owner, _bridge, _nodeFund
    );
}
```

**`describe` 必须在运行时读出节点基金的真实提取人**（不能拿金库 `_owner` 冒充）：

```solidity
// BacVaultUI.describe 内部，渲染节点基金那一句之前：
address nfOwner = address(0);
if (nodeFund.code.length != 0) {
    try IBacNodeFund(nodeFund).owner() returns (address o) { nfOwner = o; } catch {}
}
// nfOwner == address(0) 时渲染 unicode"(unreadable / 读取失败)"，绝不回退成 _owner
```

理由：`BacNodeFund.owner` 是一个**独立的、可两步转让的变量**，规格里没有任何一条要求它等于金库 `_owner`，
而 `description()` 会被 flap.sh 当状态横幅轮询、并被镜像进 `VaultPortal.getVault(token).description`。
把金库 owner（`vaultDataSchema()` 里刚说过「没有任何动用资金的权力」）渲染成 50% 税收的提取人，
是规则 003 / 001-h 意义上的错误披露，而且一次 `BacNodeFund.transferOwnership` 之后会变成永久的假话。

`BacVaultUI.describe(address token, uint256[8] v, address owner, address bridge, address nodeFund) external view returns (string memory)` 返回三段用 `" | "` 连接的文本：`_status(...)` ‖ `_pools(...)` ‖ `_rules(...)`。读 `symbol()` 只能在 `if (token.code.length != 0) try … catch {}` 里做。数字用手写的 `_fmtBNB`（4 位小数）与 `_fmtPct`（bps）格式化，不引入新依赖。

`_rules(...)` 的结尾（**部署即冻结，必须与 `vaultDataSchema().description` 和网站页脚第一行语义一致**）：

> Income split after Flap's 10% protocol fee (and the same split applies to donations, forced balances and forfeited agent deposits): 50% bridge pool (BacBridge `<addr>`, agent exits only) / 50% official node fund (BacNodeFund `<addr>`, withdrawable by that contract's owner `<nfOwner>` — a separate, transferable address, not this vault's owner `<owner>`, which has no power over any funds). Anyone can call settle() to push the two halves out; nobody is paid to do it. The vault has no owner withdrawal, no emergency withdrawal and no rescue function. Upgrades only by the Flap Guardian. The 50% node fund bucket is far above the ~3.0% Flap rule 001-h suggests for a 2% tax; it funds the servers, the signer node, the relayer and the validator reward pool. Exits are a pro-rata share of the bridge pool with per-epoch and per-address caps, and a single address can take at most 10% of one epoch's release. No promised return. / 扣除 Flap 10% 协议费后的分账（捐赠、被强推的余额、被没收的 agent 押金同样按这个比例分）：50% 桥池（BacBridge `<地址>`，只用于 agent 退出）/ 50% 官方节点基金（BacNodeFund `<地址>`，由**该合约的 owner** `<nfOwner>` 提取 —— 这是一个独立的、可转让的地址，**不是**本金库的 owner `<owner>`，后者对任何资金都没有权力）。任何人都可以调用 settle() 把两半推走，没有人因此拿到报酬。金库没有 owner 提款、没有紧急提款、也没有任何救援函数。仅 Flap Guardian 可升级。节点基金这 50% 的桶远高于 Flap 规则 001-h 对 2% 税率建议的约 3.0%，它用于支付服务器、出块签名节点、中继和验证者奖励池。退出按桥池份额兑付，有每纪元与单地址上限，单个地址在一个纪元里最多拿走该纪元释放额的 10%。不承诺任何收益。

### 2.6 不变量（写进 Foundry 不变量测试）

| Id | 不变量 |
|---|---|
| V1 | `accountedQuote == unsplitRevenue + stuckBridge + stuckNodeFund` |
| V2 | `address(this).balance >= accountedQuote` |
| V3 | `lifetimeToBridge` 与 `lifetimeToNodeFund` 单调不减 |
| V4 | 任何一笔 `dispatch`/捐赠/没收之后 `_assertSolvent()` 成立 |
| V5 | 金库里不存在任何把 BNB 发往「调用者指定地址」的路径（`_bridge` / `_nodeFund` 在 `initialize` 后不可改） |
| V6 | `receive()` 在 `call{gas: 50_000}` 下成功；冷 < 50,000 gas，暖 < 30,000 gas |
| V7 | 下游 `acceptRelease()` revert 时 `settle()` 仍成功返回，且 V1 仍成立 |
| V8 | **可开关的 revert `acceptRelease()` 下连续 20 次 `settle()`/`retryPush()` 之后：V1 仍成立，且 `stuckBridge + stuckNodeFund <= address(this).balance`**（抓 `_retry` 的重复累加） |
| V9 | `totalRecognized() == lifetimeToBridge() + lifetimeToNodeFund() + accountedQuote()`，且单调不减 |
| V10 | `_push` 的失败分支里「加回 `accountedQuote`」与「累加 `stuck*`」要么都发生要么都不发生 |
| V11 | `settle()` 的取整余数永远流向桥池：对任意 `unsplit`，`toBridge >= toNodeFund` |

---

## 3. `AgentRegistry`

### 3.1 外部 ABI（逐字）

```solidity
contract AgentRegistry is ERC721 {
    enum Status { NONE, CHALLENGED, ACTIVE, DORMANT, BANNED, RETIRED }

    struct Agent {
        address controller;       // ownerOf(agentId)，签挑战与心跳
        address agentWallet;      // 层内钱包，收积分
        string  agentURI;         // ERC-8004 registration JSON
        bytes32 endpointHash;     // keccak256(services[A2A].endpoint)
        bytes32 modelFingerprint; // keccak256("vendor/model@version")，自述，仅供展示
        uint64  registeredAt;
        uint64  lastHeartbeatEpoch;
        uint32  missedEpochs;
        uint32  solvedChallenges;
        uint96  deposit;
        Status  status;
    }

    uint256 public constant ENTRY_DEPOSIT  = 0.02 ether;
    uint8   public constant ROUNDS         = 3;
    uint64  public constant K_BLOCKS       = 8;
    uint64  public constant K_SECONDS      = 5;
    uint256 public constant TARGET         = 2**236;
    uint64  public constant EPOCH          = 86400;
    uint32  public constant MAX_MISSED     = 3;
    uint256 public constant SPOT_RATE      = 32;
    uint64  public constant RETIRE_DELAY   = 7 days;
    uint256 public constant MAX_URI_BYTES  = 512;
    uint64  public constant ADMIN_TIMELOCK = 48 hours;
    uint64  public constant SEED_SEAL_DELAY   = 64;       // 纪元种子延后封存的区块数（约 29 s）
    uint64  public constant HB_WINDOW_BLOCKS  = 600;      // 封存后的心跳窗口（约 4.5 min）
    uint64  public constant REISSUE_COOLDOWN  = 60;       // 同一 agent 两次 reissueChallenge 的最小间隔（秒）
    uint32  public constant MAX_FAILED_ROUNDS = 10;       // controller 自己累计失败这么多次才没收押金
    uint64  public constant CHALLENGE_ABANDON = 24 hours; // CHALLENGED 超过这个时长未激活：押金原路退还，不没收

    // 金库地址在发射时才存在，而本合约先部署，所以它**不是** immutable（不要再声明一个同名 immutable，
    // 那样会因为构造函数没给它赋值而直接编译失败）。
    address public vaultSink;              // 一次性设置，见 setVaultSink
    address public admin;                  // 冷钥，只能 ban / 时锁
    address public vetoKey;                // 冷钥，可立即 ban、可取消时锁

    function setVaultSink(address v) external;   // 仅部署者，仅一次；要求 v.code.length > 0

    // ---- agent 生命周期 ----
    function register(string calldata agentURI, bytes32 endpointHash, bytes32 modelFingerprint,
                      address agentWallet, uint256 deadline, bytes calldata walletSig)
        external payable returns (uint256 agentId, bytes32 challengeId);   // msg.value == ENTRY_DEPOSIT
    // walletSig 必须是 agentWallet 自己对 EIP-712 BindWallet(address wallet,address controller,uint256 deadline)
    // 的签名（与 setAgentWallet 同一条路径），且 require(agentIdOfWallet[agentWallet] == 0)。
    // 没有这一条，任何人都可以把别人的层内地址登记成自己的 agentWallet：污染 agentIdOfWallet /
    // L2Gate.agentIdOf，并给「冒用他人 agentId 退出」提供输入（attack-funds #4 / #12）。
    function solveChallenge(uint256 agentId, bytes32 challengeId, uint256 nonce, bytes calldata sig) external;
    function reissueChallenge(uint256 agentId) external returns (bytes32 challengeId);  // 无许可（抽查/复活）
    function setAgentURI(uint256 agentId, string calldata newURI) external;             // 仅 controller
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata walletSig) external;
    function rotateController(uint256 agentId, address newController, uint256 deadline, bytes calldata newKeySig) external;
    function heartbeat(uint256 agentId, uint64 epoch, bytes32 note, bytes calldata sig) external;
    function markDormant(uint256 agentId) external;                                     // 无许可
    function publish(uint256 agentId, bytes32 kind, bytes32 contentHash, string calldata uri) external;
    function retire(uint256 agentId) external;                                          // 仅 controller
    function withdrawDeposit(uint256 agentId, address to) external;                     // RETIRED + RETIRE_DELAY 之后
    function sweepForfeited() external;                                                 // 无许可，把没收的押金推进 vaultSink
    // 必须：require(gasleft() >= 150_000)；用 (bool ok,) = vaultSink.call{value: amt}("") 转发**全部剩余 gas**，
    // require(ok, unicode"Vault sink rejected / 金库拒收")。
    // 绝不能用 transfer / send（2300 gas）：金库 receive() 冷路径实测约 47.8k gas，2300 会让这个函数永久 revert，
    // 被没收的押金再也进不了金库。

    // ---- 管理（全部 48h 时锁，veto 钥可立即 ban 或取消时锁；没有一条能移动资金）----
    function proposeBan(uint256 agentId, bytes32 reasonHash) external;                  // 仅 admin
    function executeBan(uint256 agentId) external;                                      // 仅 admin，48h 后
    function cancelBan(uint256 agentId) external;                                       // admin 或 vetoKey
    function banNow(uint256 agentId, bytes32 reasonHash) external;                      // 仅 vetoKey

    // ---- views ----
    function isActive(uint256 agentId) external view returns (bool);
    function getAgent(uint256 agentId) external view returns (Agent memory);
    function agentIdOfController(address controller) external view returns (uint256);
    function agentIdOfWallet(address wallet) external view returns (uint256);
    function currentChallenge(uint256 agentId) external view
        returns (bytes32 challengeId, bytes32 seed, uint64 deadlineBlock, uint64 deadlineTime, uint8 round);
    function currentEpoch() external view returns (uint64);
    function epochSeed(uint64 epoch) external view returns (bytes32);
    function totalAgents() external view returns (uint256);
    function agentAt(uint256 index) external view returns (uint256 agentId);
    function recentAgents(uint256 count) external view returns (uint256[] memory);
    function forfeitedPending() external view returns (uint256);

    event Registered(uint256 indexed agentId, address indexed controller, address indexed agentWallet,
                     string agentURI, bytes32 endpointHash, bytes32 modelFingerprint);
    event ChallengeIssued(uint256 indexed agentId, bytes32 indexed challengeId, bytes32 seed,
                          uint64 deadlineBlock, uint64 deadlineTime, uint8 round);
    event ChallengeSolved(uint256 indexed agentId, bytes32 indexed challengeId, uint32 blocksUsed, uint8 round);
    event ChallengeFailed(uint256 indexed agentId, bytes32 indexed challengeId, uint8 round);
    event Activated(uint256 indexed agentId, address indexed agentWallet);
    event Heartbeat(uint256 indexed agentId, uint64 indexed epoch, bytes32 note);
    event Dormant(uint256 indexed agentId, uint64 epoch);
    event Published(uint256 indexed agentId, bytes32 indexed kind, bytes32 contentHash, string uri);
    event AgentWalletSet(uint256 indexed agentId, address indexed wallet);
    event URIUpdated(uint256 indexed agentId, string newURI);
    event ControllerRotated(uint256 indexed agentId, address indexed from, address indexed to);
    event Retired(uint256 indexed agentId, uint64 claimableAt);
    event DepositWithdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event DepositForfeited(uint256 indexed agentId, uint256 amount);
    event ForfeitedSwept(address indexed to, uint256 amount);
    event BanProposed(uint256 indexed agentId, bytes32 reasonHash, uint64 eta);
    event BanCancelled(uint256 indexed agentId);
    event Banned(uint256 indexed agentId, bytes32 reasonHash, address by);
}
```

### 3.2 访问控制与状态机

| 函数 | 谁能调 |
|---|---|
| `register` / `solveChallenge` / `reissueChallenge` / `markDormant` / `sweepForfeited` | 任何人 |
| `setAgentURI` / `rotateController` / `retire` / `withdrawDeposit` / `publish` | `controller` |
| `setAgentWallet` | `controller`，且需**新钱包自己**的 EIP-712 签名 |
| `heartbeat` | 任何人可提交，但签名必须来自 `controller` |
| `proposeBan` / `executeBan` | `admin`（48h 时锁） |
| `cancelBan` | `admin` 或 `vetoKey` |
| `banNow` | `vetoKey` |
| `setVaultSink` | 部署者，仅一次 |

**`reissueChallenge` 的防刷规则（第三方只能帮忙，不能伤人）：**
1. `require(block.number > deadlineBlock || block.timestamp > deadlineTime, unicode"Challenge still live / 挑战尚未超时")`；
2. `require(block.timestamp >= lastReissueAt[agentId] + REISSUE_COOLDOWN, unicode"Reissue cooldown / 重发冷却中")`；
3. **调用者不是 `controller` 时只重发挑战，不累加任何失败计数器**（`failedRounds` 只在 controller 自己发起的重试上 +1）；
4. `failedRounds[agentId] >= MAX_FAILED_ROUNDS` 才没收押金（`forfeitedPending += deposit`，状态置 `BANNED`）；
5. `CHALLENGED` 状态持续超过 `CHALLENGE_ABANDON`（24h）且从未激活：任何人可调 `abandonRegistration(agentId)`，
   **押金原路退还给注册时的付款地址，不没收**。没收只留给「被 ban」，不留给「网络不好」。

没有第 2、3 条，攻击者可以盯着 mempool，在受害者的 `solveChallenge` 因 BSC 拥堵晚一个块时立刻
`reissueChallenge`（约 0.0000025 BNB/次）把对方的 0.02 BNB 押金刷没 —— 成本是受害者损失的万分之一。

状态机：`NONE --register--> CHALLENGED --3×solveChallenge--> ACTIVE --漏 3 纪元--> DORMANT --reissue+solve--> ACTIVE`；`ACTIVE|DORMANT --retire--> RETIRED`（押金 7 天后可取）；`任何状态 --ban--> BANNED`（押金没收）。
**`status != NONE` 时 `transferFrom` / `safeTransferFrom` / `approve` 一律 revert** `unicode"Agent identity is not transferable / agent 身份不可转让"`。

**BANNED / DORMANT 的效果边界（这一条是资金安全的硬约束）：** 只影响 `BacBridge.lock`（进桥）与层内 `AgentBook` 的发布权限。**绝不影响** `BacBridge.claimExit` / `collect` / `escapeCollect`，也绝不影响 `L2Bridge.exit()`。退出是唯一不得被任何状态门控的动作。

### 3.3 挑战算法（逐字）

```
seed_1     = keccak256(abi.encode(blockhash(block.number - 1), agentId, challengeNonce, address(this)))
seed_{r+1} = keccak256(abi.encode(seed_r, nonce_r, blockhash(block.number - 1)))
challengeId = keccak256(abi.encode(agentId, round, seed_r))
答案条件    = uint256(keccak256(abi.encode(seed_r, nonce))) < TARGET     // TARGET = 2**236
截止        = block.number <= deadlineBlock (= 发起块 + 8)
           && block.timestamp <= deadlineTime (= 发起时刻 + 5)
签名        = EIP-712，domain = { name: "BNB Agent Chain Registry", version: "1",
                                  chainId: 56, verifyingContract: address(this) }
              Challenge(uint256 agentId,bytes32 challengeId,bytes32 seed,uint256 nonce)
              typehash = keccak256("Challenge(uint256 agentId,bytes32 challengeId,bytes32 seed,uint256 nonce)")
              签名者必须 == agent.controller
```
超时后任何人可调 `reissueChallenge`；累计失败到第 3 轮之外则 `ChallengeFailed` 并没收押金（`forfeitedPending += deposit`），`sweepForfeited()` 无许可地把它打进 `vaultSink`（金库 `receive()`，按 50/50 分掉）。

**纪元种子：两阶段封存，触发者不能选它（A13/attack-gate #13 的修法）**

```
// 阶段 1（惰性）：纪元 e 内第一次有人调用任意状态变更函数时，只记下高度，不算种子
if (seedAnchorBlock[e] == 0) seedAnchorBlock[e] = uint64(block.number);

// 阶段 2（任何人，无许可，也可以由任意状态变更函数顺手做）：
function sealEpochSeed(uint64 e) public {
    uint64 anchor = seedAnchorBlock[e];
    require(anchor != 0, unicode"Epoch not anchored yet / 该纪元尚未锚定");
    require(block.number > anchor + SEED_SEAL_DELAY, unicode"Seal delay not elapsed / 封存延迟未到");
    require(epochSeed[e] == bytes32(0), unicode"Already sealed / 已封存");
    require(block.number <= anchor + SEED_SEAL_DELAY + 256, unicode"Seal window missed / 封存窗口已过");
    epochSeed[e] = keccak256(abi.encode(blockhash(anchor + SEED_SEAL_DELAY), e));
    sealedAtBlock[e] = uint64(block.number);
    emit EpochSeedSealed(e, epochSeed[e], anchor + SEED_SEAL_DELAY);
}
```

**为什么不能用「第一笔交易所在块的父哈希」：** 那等于让第一个发交易的人挑种子。
BSC 0.45 s 一块，攻击者可以每出一个块本地算一遍 `keccak256(abi.encode(blockhash(head), e)) % 32`，
**不满足自己想要的结果就不发交易**，几笔之内就能把「本纪元抽查谁」钉成对自己有利的值，
让自己名下所有 `agentId % 32` 相同的 agent 当天集体躲过抽查（成本约 0.00002 BNB）。
延后 `SEED_SEAL_DELAY = 64` 个块（约 29 s）再封存，封存时用的那个块哈希在触发者发交易时**还不存在**。
`blockhash` 只保留 256 块，所以给了 256 块的封存窗口；窗口内没人封存则该纪元不做抽查、心跳只校验 `epoch`
（fail-open，绝不能因此没收任何人的押金）。

心跳签名：
```
Heartbeat(uint256 agentId,uint64 epoch,bytes32 epochSeed,bytes32 note)
```
**心跳必须落在纪元内的随机窗口里：** `require(block.number >= sealedAtBlock[e] && block.number <= sealedAtBlock[e] + HB_WINDOW_BLOCKS)`
（约 4.5 分钟）。没有这条时限，心跳证明的只是「controller 私钥在这 24 小时里签过一次名」——
一个人用硬件钱包每天签一次完全做得到，它就不配和 3.6 秒的准入挑战并列写成门禁的一层。
加上时限之后它证明的是「在一个刚出现、事先不可知的几分钟窗口里做出了响应」：程序毫不费力，人手很难长期坚持。
漏掉窗口只记一次 `missedEpochs`，`MAX_MISSED = 3` 后任何人可 `markDormant`；
**`DORMANT` 不影响退出（G11），所以这个代价是可接受的。**

抽查：`uint256(epochSeed[e]) % SPOT_RATE == agentId % SPOT_RATE` 的 agent 当纪元必须额外过一轮挑战，否则 `markDormant` 可被任何人调用。

### 3.4 不变量

| Id | 不变量 |
|---|---|
| R1 | `address(this).balance >= Σ(ACTIVE/CHALLENGED/RETIRED 的 deposit) + forfeitedPending` |
| R2 | 没有任何函数能把 `deposit` 付给非该 agent 指定的 `to`（`ban` 只把它转进 `forfeitedPending`） |
| R3 | `admin` / `vetoKey` 没有任何路径能移动 BNB 或 BAC |
| R4 | `isActive(id)` 为真 ⟺ `status == ACTIVE` |
| R5 | 第三方调用 `reissueChallenge` 不会改变任何 agent 的 `failedRounds`、`deposit` 或 `status` |
| R6 | `epochSeed[e]` 一旦非零不可再改；且它只可能等于 `keccak256(abi.encode(blockhash(seedAnchorBlock[e] + 64), e))` |
| R7 | 没有任何路径能让 `agentIdOfWallet[w]` 在未取得 `w` 的 EIP-712 签名的情况下变成非零 |

---

## 4. `BacBridge`

> **2026-09-22 修订（M1）**：退出分配由「本纪元退出队列内按 credits 分 pot」改为**退出当场锁定汇率**。
> 旧口径被经济模拟推翻（`artifacts/sim/RESULTS.md` §1.1-1.2）。
> **2026-09-22 二次修订（M4，对抗评审）**：按 `artifacts/design-options/attack-funds.md` #1/#2/#3/#4/#8/#9/#10/#11/#13/#14/#17
> 与 `attack-gate.md` #2/#3/#6/#7/#8 重写出金侧：
> (1) 逐纪元的 `epochPot` / `collect(epoch, ...)` **全部删除**，改成 MasterChef 式单一累加器（历史纪元不可回头洗劫）；
> (2) `settleEpoch` 可以跳过非 FINAL 的纪元（一次 veto 不再永久冻结全部出金）；
> (3) `claimExit` 删掉 3 天硬窗口，且不再受 `pause()` 约束；
> (4) 停机时未成熟的 `owed` 不享受优先级；
> (5) `pause()` 有累计上限，满了本身就是停机触发；
> (6) 所有停机触发统一走 14 天可取消的武装期（与 `00` §4.5 对齐）。
> 本节是唯一权威版本，旧版见 `01-CONTRACT-SPEC.bak.md`。

### 4.0 记账变量（先读这个，下面所有函数都围绕它）

| 变量 | 含义 | 谁增 | 谁减 |
|---|---|---|---|
| `poolBalance` | 桥池已入账的 BNB 总额（**记账变量，不是 `address(this).balance`**） | `acceptRelease` / `sweepUntracked` | 任何一笔真实出金 |
| `owedTotal` | 已锁定汇率、尚未付清的债权总额 | `claimExit` | `collect` / `claimOwedAfterHalt` / `sweepImmatureOwed` |
| `reservedTotal` | 已被历次 `settleEpoch` 释放、尚未被领走的额度（**全局一个数，不挂在任何纪元上**） | `settleEpoch` | `collect` |
| `accPerOwed` | 1e27 定点累加器：每 1 wei 的 `owed` 累计被释放了多少 wei | `settleEpoch` | 永不减 |
| `unclaimed[who]` / `owedDebt[who]` | 某地址已释放待领的额度 / 它的累加器基准 | 见 §4.2 | 见 §4.2 |
| `unattributedExited` | 退出积分里无法归属到某个 `agentId` 的部分 | `claimExit` | 永不减 |

**偿付不变式 I1：`owedTotal <= poolBalance` 恒成立。**
归纳：`claimExit` 锁定时 `Sigma 新增 owed = rate x Sigma credits <= poolBalance - owedTotal`（见 4.2）；
`collect` 等量减少 `owed` 与 `poolBalance`；`acceptRelease` 只增加 `poolBalance`。
**I2：`reservedTotal <= owedTotal` 恒成立**（`settleEpoch` 里 `pot` 被 `owedTotal - reservedTotal` 截断）——
没有这一条，预留会单调棘轮，两个月内把每纪元可释放额吃成 0（attack-funds #14）。
模拟复核：3 情景 x 2 压力 x 3000 路径 x 395 天，零越界，最大浮点误差 9e-13 BNB。
**注意：§11.5 的三条验收线必须按 M4 的口径重跑** —— 旧模拟只覆盖「当期 pot」，没有覆盖跨纪元领取。

### 4.1 外部 ABI（逐字）

```solidity
contract BacBridge {
    address public immutable bacToken;      // 预测的 ...7777 地址，部署时写死
    address public immutable registry;
    address public immutable anchor;        // ChainAnchor：vetoKey 从它上面现读，本合约不自己存
    address public immutable watchdog;      // 只能 pause / unpause / armEscape，不能动钱

    uint64  public constant EPOCH                = 86400;      // UTC 对齐
    uint64  public constant SETTLE_GRACE         = 7 days;     // 纪元既没 FINAL 也没被否决时，多久后可以空转推进游标
    uint16  public constant MAX_EXIT_SHARE_BPS   = 1000;       // 单地址单纪元 <= 该纪元释放额的 10%（减速带，非安全边界）
    uint16  public constant NO_ATTEST_WINDOW_BPS = 1500;       // 零见证时，任意连续 30 纪元累计释放 <= 桥池的 15%
    uint64  public constant NO_ATTEST_WINDOW     = 30;         // 上面那个窗口的纪元数
    uint64  public constant PAUSE_LEN            = 7 days;     // 单次暂停上限
    uint64  public constant MAX_PAUSE_TOTAL      = 21 days;    // 累计暂停上限，超过即构成停机触发 5
    uint64  public constant OWED_MATURITY        = 14 days;    // 停机时享受优先级所需的债权成熟期
    uint64  public constant ESCAPE_ARM_DELAY     = 14 days;    // 所有停机触发统一的武装期
    uint256 public constant LAYER_CHAIN_ID       = 56777;
    uint256 public constant ACC_PRECISION        = 1e27;
    bytes32 public constant EXIT_TYPEHASH =
        keccak256("Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)");
        // 叶子里**没有 epoch**：锚点归属与退出的出生纪元必须解耦，否则被 veto 的纪元里的退出
        // 无论怎么重报都证明不出来（attack-funds #13）。

    // ---- 进 ----
    function lock(uint256 agentId, uint256 amount) external returns (uint256 depositId);
    function acceptRelease() external payable;                    // 无许可：金库推送、任何人捐赠都走这里
    function sweepUntracked() external returns (uint256 swept);   // 无许可：把强推进来的余额并进池子

    // ---- 出（正常模式，全程 O(1)，没有循环，没有逐纪元账本）----
    function claimExit(uint64 anchorEpoch, uint256 exitId, uint256 agentId, address to,
                       uint256 credits, bytes32[] calldata proof) external returns (uint256 lockedWei);
    function settleEpoch(uint64 epoch) external;                  // 无许可，必须按序：epoch == lastSettledEpoch + 1
    function collect(address to) external returns (uint256 paid); // 无许可，**不带 epoch**，每地址每纪元一次

    // ---- 出（逃生模式，终局不可逆）----
    function armEscape() external;                     // 仅 watchdog（手动触发，cause 4）
    function cancelEscapeArm() external;               // 仅 ChainAnchor.vetoKey()，且只有触发条件已消失时才能取消
    function checkHalt() external;                     // 无许可：先武装，ESCAPE_ARM_DELAY 之后再真正停机
    function claimOwedAfterHalt(address to) external returns (uint256 paid);      // 优先级债权，足额（需成熟）
    function sweepImmatureOwed(address who) external;  // 无许可：把不成熟的 owed 降级给次级（仅 cause 2/3）
    function escapeCollect(uint256 agentId, address to) external returns (uint256 paid);  // 次级，按未退出积分

    // ---- 刹车（只能停 collect，不能动钱，不能停 claimExit，不能停逃生）----
    function pause() external;                         // 仅 watchdog，单次最长 PAUSE_LEN，累计不超过 MAX_PAUSE_TOTAL
    function unpause() external;                       // 仅 watchdog

    // ---- 单向销毁（唯一的 BAC 出口，目标写死）----
    function burnLocked() external returns (uint256 burned);   // 无许可，发往 0x...dEaD

    // ---- views ----
    function totalLocked() external view returns (uint256);
    function totalCreditsIssued() external view returns (uint256);
    function totalCreditsExited() external view returns (uint256);
    function creditsOutstanding() external view returns (uint256);   // issued - exited
    function credited(uint256 agentId) external view returns (uint256);
    function exitedCredits(uint256 agentId) external view returns (uint256);
    function unattributedExited() external view returns (uint256);
    function poolBalance() external view returns (uint256);
    function owedTotal() external view returns (uint256);
    function owed(address who) external view returns (uint256);
    function pendingCollect(address who) external view returns (uint256);   // 现在能领多少（已含上限截断）
    function lastClaimAt(address who) external view returns (uint64);
    function reservedTotal() external view returns (uint256);
    function accPerOwed() external view returns (uint256);
    function currentRate() external view returns (uint256 weiPerCredit);  // 1e18 定点，仅视图，永不承诺
    function lastEpochRelease() external view returns (uint256 pot, uint64 settledAt, uint16 releaseBps);
    function releasedInWindow() external view returns (uint256);       // 最近 NO_ATTEST_WINDOW 个纪元的累计释放
    function lastCollectEpoch(address who) external view returns (uint64);
    function lastSettledEpoch() external view returns (uint64);
    function skippedEpochs() external view returns (uint64);           // 被跳过（非 FINAL）的纪元累计数，进 /api/health
    function isPaused() external view returns (bool, uint64 until_, uint64 cumulative);
    function isHalted() external view returns (bool);
    function haltCause() external view returns (uint8);
    function haltedAt() external view returns (uint64);
    function escapeArmedAt() external view returns (uint64);
    function armedCause() external view returns (uint8);
    function escapeState() external view returns (uint256 totalWeight, uint256 accPerWeight, uint256 distributed);
    function escapeClaimable(uint256 agentId) external view returns (uint256);

    event Locked(uint256 indexed depositId, uint256 indexed agentId, address indexed from,
                 address layerWallet, uint256 measured, uint256 credits, uint256 totalIssued);
    event ReleaseReceived(address indexed from, uint256 amount, uint256 poolAfter);
    event Untracked(uint256 amount, uint256 poolAfter);
    event ExitClaimed(uint64 indexed anchorEpoch, uint256 indexed exitId, uint256 indexed agentId,
                      address to, uint256 credits, uint256 lockedWei, uint256 rateUsed, uint256 attributed);
    event EpochSettled(uint64 indexed epoch, uint256 pot, uint256 owedTotalAfter, uint16 releaseBps, bool skipped);
    event Collected(address indexed who, address indexed to, uint256 amount, uint256 owedLeft);
    event EscapeArmed(address indexed by, uint8 cause, uint64 effectiveAt);
    event EscapeArmCancelled(address indexed by);
    event Halted(uint8 cause);     // 1 = 90天无锚点  2 = 否决超限  3 = 异议超限  4 = 手动武装到期  5 = 累计暂停超限
    event OwedPaidAfterHalt(address indexed who, address indexed to, uint256 amount);
    event OwedDemoted(address indexed who, uint256 amount);
    event EscapeCollected(uint256 indexed agentId, address indexed to, uint256 amount);
    event Paused(address indexed by, uint64 until_, uint64 cumulative);
    event Unpaused(address indexed by, uint64 cumulative);
    event LockedBurned(uint256 amount);
}
```

**`admin` 与 `vetoKey` 不是 `BacBridge` 的角色。** 本合约只有一个特权地址 `watchdog`（immutable，只能 `pause` / `unpause` / `armEscape`）；
需要否决权的地方一律现读 `IChainAnchor(anchor).vetoKey()`。
早先的 ABI 注释里写着「admin 或 watchdog」「admin 或 vetoKey」，而 §4.1 从来没有声明过这两个变量 ——
照着那份注释写文件会在 `require(msg.sender == admin || ...)` 处**编译失败**，实现者多半会就地发明一个未经评审的特权角色，
而那个角色能武装不可逆的逃生模式（attack-flap A7）。这里把它彻底堵死：**本合约没有 admin，没有自己的 veto 钥，少两把冷钥。**

### 4.2 各函数的规则

**`lock(agentId, amount)`**
1. `require(!isHalted(), unicode"Bridge halted / 桥已停机")`
2. `require(IAgentRegistry(registry).isActive(agentId), unicode"Agent is not active / agent 不是活跃状态")`
3. `require(msg.sender == a.controller || msg.sender == a.agentWallet, unicode"Not the agent controller / 不是该 agent 的控制者")`
4. **按余额差计量**：`before = IERC20(bacToken).balanceOf(address(this))` -> `transferFrom` -> `measured = after - before`
5. `require(measured > 0, unicode"Zero amount / 金额为零")`
6. `credits = measured`（1:1）；`totalLocked += measured; totalCreditsIssued += credits; credited[agentId] += credits;`
7. `emit Locked(depositId++, agentId, msg.sender, a.agentWallet, measured, credits, totalCreditsIssued)`

锁进来的 BAC **没有任何路径转给任何人**，`burnLocked()` 是唯一出口且目标写死为 `0x...dEaD`。桥里没有可偷的代币。
**BSC 深度重组的善后也走这里**：`lock` 是无许可的，运营方用自己的 agent 身份补锁等额 BAC 把
`totalCreditsIssued` 抬回去即可 —— 不需要任何新权力，也不需要「中继销毁别人的积分」那种不存在的能力（见 `00` §7.2 #6）。

**`acceptRelease()` / `sweepUntracked()`（停机前后是同一段逻辑，逐字照做）**

```solidity
function acceptRelease() external payable {
    _accept(msg.value);
    emit ReleaseReceived(msg.sender, msg.value, poolBalance);
}
function _accept(uint256 amount) internal {
    poolBalance += amount;                                          // 永远加，不分停机与否
    if (halted && escapeTotalWeight > 0) {
        accPerWeight += amount * 1e18 / escapeTotalWeight;          // 停机后额外分给次级
    }
}
```

两个分支都必须写对：只加 `accPerWeight` 不加 `poolBalance` -> `escapeCollect` 的 `poolBalance -= paid` 迟早下溢，
**从此对所有人永久 revert**；只加 `poolBalance` 不加 `accPerWeight` -> 停机后收到的税收永远没有合法领取人。
`escapeTotalWeight == 0` 时 `accPerWeight` 恒为 0，钱只进 `poolBalance`：
**这种情况下（停机那一刻没有任何未退出积分）池子里的钱确实没有合法领取人，会永久留在合约里 —— 我们不给 owner 开回收口，照实写进 FAQ。**

**`claimExit(anchorEpoch, exitId, agentId, to, credits, proof)` —— 锁定汇率就发生在这里**
1. `require(!isHalted(), unicode"Bridge halted / 桥已停机")` —— **不检查 `isPaused()`**（见第 10 条）
2. 从 `ChainAnchor` 读 `(state, exitRoot)`；`require(state == FINAL, unicode"Anchor not final / 锚点尚未定案")`
3. **没有时间窗口。** `exitClaimed[exitId]` 已经保证幂等，`exitRoot` 是终态，晚领没有任何安全代价：
   晚领的人只是按**那一刻**的 `free / outstanding` 锁汇率，自己承担池子变化的风险，这与 `00` §11.4 第 2 条完全一致。
   旧写法的 3 天硬窗口意味着：程序掉线 3 天（程序最常见的失效模式）= 层内积分已销毁、BSC 侧一分拿不到、且没有任何补救函数，
   同时 `creditsOutstanding` 被这批「已经不存在的积分」永久稀释（attack-funds #8 / attack-gate #6）。
4. `require(!exitClaimed[exitId], unicode"Exit already claimed / 该退出已领取")`
5. `leaf = keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, to, credits, LAYER_CHAIN_ID, address(this)))`；
   `require(MerkleProof.verify(proof, exitRoot, leaf), unicode"Bad merkle proof / merkle 证明无效")`
6. **锁定汇率（顺序不可颠倒）**：

```solidity
uint256 outstanding = totalCreditsIssued - totalCreditsExited;         // 本笔退出之前
require(outstanding >= credits, unicode"Credits exceed outstanding / 积分超过未退出总量");
uint256 free = poolBalance - owedTotal;                                // I1 保证不下溢
uint256 lockedWei = credits * free / outstanding;                      // 向下取整，余数留在池子里
require(lockedWei > 0, unicode"Rate too low, exit not worth claiming / 当前兑付率过低，本次退出不值得领取");

_harvest(to);                                                          // 先结清旧的待领额，再改 owed
owed[to]   += lockedWei;
owedTotal  += lockedWei;
owedDebt[to] = owed[to] * accPerOwed / ACC_PRECISION;                  // 新债权按**当前** acc 记基准
lastClaimAt[to] = uint64(block.timestamp);                             // 停机成熟度的计时起点
exitClaimed[exitId] = true;

// 归属：一个 agent 可能在层内赚到比它存入更多的积分，所以 exitedCredits 必须被 credited 截断，
// 多出来的部分进全局桶，否则 escapeCollect 的 credited - exitedCredits 会下溢 panic，
// 把受害者的逃生口打成永久 revert（attack-funds #4）。
uint256 room = credited[agentId] - exitedCredits[agentId];
uint256 attr = credits < room ? credits : room;
exitedCredits[agentId] += attr;
unattributedExited     += credits - attr;
totalCreditsExited     += credits;                                     // 积分当场全部销毁
```

7. `emit ExitClaimed(anchorEpoch, exitId, agentId, to, credits, lockedWei, free * 1e18 / outstanding, attr)`
8. **不检查 agent 状态**（G11）。任何人都可以替别人提交（`to` 写在叶子里，改不了）。
9. `anchorEpoch` **只用于定位锚点**，不进叶子、不参与任何分配：被 veto 的纪元里的退出，中继把叶子并进后面任何一个纪元都能正常证明。
10. **`claimExit` 不受 `pause()` 约束**：它一 wei 都不出金，只是记账。把它关进暂停的作用域里，等于「运营方为了保护大家按下的按钮，
    代价是把所有在途退出者的本金烧光」，实际后果是没人敢按 `pause()`（attack-funds #10）。

**`settleEpoch(epoch)`（无许可，必须按序，可以跳过非 FINAL 的纪元）**

```solidity
require(epoch == lastSettledEpoch + 1, unicode"Settle epochs in order / 纪元必须按序结算");
State st = IChainAnchor(anchor).getAnchor(epoch).state;

if (st == State.VETOED || st == State.DISPUTED) {                       // 终态但没定案 -> 空转推进
    lastSettledEpoch = epoch; skippedEpochs += 1;
    emit EpochSettled(epoch, 0, owedTotal, 0, true); return;
}
if (st != State.FINAL) {                                                // NONE / POSTED：给中继留时间
    require(block.timestamp >= (uint256(epoch) + 1) * EPOCH + SETTLE_GRACE,
            unicode"Epoch not resolved yet / 该纪元尚未定案");
    lastSettledEpoch = epoch; skippedEpochs += 1;
    emit EpochSettled(epoch, 0, owedTotal, 0, true); return;
}
// FINAL 分支
uint16 bps = IChainAnchor(anchor).releaseBpsFor(epoch);                 // 200 / 350 / 500
if (owedTotal == 0) {                                                   // 没有债权：顺手把取整尘埃清零
    reservedTotal = 0; lastSettledEpoch = epoch;
    emit EpochSettled(epoch, 0, 0, bps, false); return;
}
uint256 pot = (poolBalance - reservedTotal) * bps / 10000;
uint256 headroom = owedTotal - reservedTotal;                           // I2：预留永远不超过欠款总额
if (pot > headroom) pot = headroom;

// 零见证时的累计上限（attack-gate #14）：没有任何独立方核对 exitRoot 的情况下，
// 中继私钥被盗的损失上限必须是写死在合约里的、可计算的数，而不是「每天 2% 连本带利」。
uint256 windowOther = releasedInWindow - potRing[epoch % NO_ATTEST_WINDOW];
if (IChainAnchor(anchor).getAnchor(epoch).agreeingCount == 0) {
    uint256 capLeft = poolBalance * NO_ATTEST_WINDOW_BPS / 10000;
    capLeft = capLeft > windowOther ? capLeft - windowOther : 0;
    if (pot > capLeft) pot = capLeft;
}
releasedInWindow = windowOther + pot;  potRing[epoch % NO_ATTEST_WINDOW] = uint128(pot);

if (pot != 0) accPerOwed += pot * ACC_PRECISION / owedTotal;            // 单一累加器，没有任何逐纪元账本
reservedTotal += pot;
lastPot = pot; lastPotSettledAt = uint64(block.timestamp); lastPotBps = bps;
lastSettledEpoch = epoch;
emit EpochSettled(epoch, pot, owedTotal, bps, false);
```

**为什么必须能跳过：** `ChainAnchor` 的状态机终态不可改（C3），`VETOED` / `DISPUTED` 永远不会变成 `FINAL`。
旧写法（「该纪元必须 FINAL」+「必须按序」）在**第一次 veto 或第一次诚实的验证者否决**之后就永久卡住
`lastSettledEpoch`，而后面的纪元照常 FINAL -> 90 天无锚点、连续 veto、连续 dispute 三个停机条件一条都不满足 ->
桥池永久冻结，唯一出路变成一个人为的 `armEscape()`（attack-funds #2 / attack-gate #2）。
`skippedEpochs` 必须进 `/api/health`，连续跳过 3 个即告警。

**`collect(to)`（每个地址每个纪元只能领一次；不带 epoch，没有历史纪元可以回头洗）**

```solidity
require(!isPaused(), unicode"Bridge paused / 桥已暂停");
require(!isHalted(), unicode"Bridge halted / 桥已停机");
uint64 e = uint64(block.timestamp / EPOCH);
require(lastCollectEpoch[msg.sender] < e, unicode"Already collected this epoch / 本纪元已领取");
lastCollectEpoch[msg.sender] = e;

_harvest(msg.sender);                                   // unclaimed[who] += owed*acc/1e27 - debt；debt 归位
uint256 paid = unclaimed[msg.sender];
uint256 cap  = lastPot * MAX_EXIT_SHARE_BPS / 10000;    // 单地址速率限制：当期释放额的 10%
if (paid > cap)              paid = cap;
if (paid > owed[msg.sender]) paid = owed[msg.sender];
require(paid > 0, unicode"Nothing to collect / 没有可领取的金额");

unclaimed[msg.sender] -= paid;                          // 被截掉的留在 unclaimed 里，永不过期
owed[msg.sender]      -= paid;
owedDebt[msg.sender]   = owed[msg.sender] * accPerOwed / ACC_PRECISION;
owedTotal     -= paid;
reservedTotal -= paid;
poolBalance   -= paid;
emit Collected(msg.sender, to, paid, owed[msg.sender]);
// nonReentrant + CEI + call{value: paid}(to)，失败则整笔 revert

function _harvest(address who) internal {
    uint256 acc = accPerOwed;
    uint256 pend = owed[who] * acc / ACC_PRECISION - owedDebt[who];
    if (pend != 0) unclaimed[who] += pend;
    owedDebt[who] = owed[who] * acc / ACC_PRECISION;
}
```

**为什么删掉逐纪元的 pot：** 旧写法里 `collect(epoch, to)` 只检查「该纪元结算过、我这个纪元没领过、我现在有 owed」，
**从不检查我的 `owed` 是不是在那个纪元结算之前就存在**。而单地址 10% 上限意味着领取人少于 10 个时每个 pot 固定剩 90%，
`POT_SWEEP_DELAY = 30 天`又没人有动机清扫，所以任何时刻都躺着 30 个以上 `potLeft > 0` 的纪元。
攻击者只要忍 30 天再退出，拆 10 个地址、在一个 BSC 区块里连发 300 笔 `collect`，就能把 30 个纪元的释放额
（约等于桥池的 45%-78%）一次取走 —— 这同时推翻 §11.5 的「3 个纪元 <= 15%」和信任表的「中继私钥泄露 -> 每纪元最多 2%-5%」，
还把 B10「无先发优势」反向打破（早退者已经 `collected`，晚退者对同一批 pot 拥有全新领取权）。
累加器把「什么时候锁定的债权」和「能分到哪些释放」严格绑在一起：`owedDebt` 在 `claimExit` 时按当前 `accPerOwed` 记基准，
**历史释放一律不属于新债权**。`sweepEpochPot` 与 `POT_SWEEP_DELAY` 随这一版一起删除。

**逃生（`00` §4.5 + §11.2 的优先级修正 + M4 的成熟度修正）**

触发条件（五条，**全部只能武装，不能当场停机**）：

| cause | 条件 | 读自 |
|---|---|---|
| 1 | 90 天无新 FINAL 锚点 | `ChainAnchor.lastFinalAt()` |
| 2 | 任意连续 30 个纪元内被 veto 达 `VETO_LIMIT_PER_WINDOW`(7) 次 | `ChainAnchor.haltReason()` |
| 3 | 任意连续 30 个纪元内被验证者否决达 `DISPUTE_LIMIT_PER_WINDOW`(3) 次 | `ChainAnchor.haltReason()` |
| 4 | `watchdog` 调 `armEscape()` | 本合约 |
| 5 | `pausedCumulative >= MAX_PAUSE_TOTAL`(21 天) | 本合约 |

```solidity
function checkHalt() external {
    uint8 c = _pendingCause();                                  // 0 = 条件不成立
    if (escapeArmedAt == 0) {
        require(c != 0, unicode"No halt condition / 不满足任何停机条件");
        escapeArmedAt = uint64(block.timestamp); armedCause = c;
        emit EscapeArmed(msg.sender, c, uint64(block.timestamp) + ESCAPE_ARM_DELAY);
        return;
    }
    require(block.timestamp >= escapeArmedAt + ESCAPE_ARM_DELAY, unicode"Arming delay not elapsed / 武装期未满");
    require(armedCause == 4 || _pendingCause() != 0, unicode"Halt condition cleared / 停机条件已消失");
    _halt(armedCause);
}
function cancelEscapeArm() external {                            // 仅 ChainAnchor.vetoKey()
    require(msg.sender == IChainAnchor(anchor).vetoKey(), unicode"Only veto key / 仅限 veto 钥");
    require(!halted, unicode"Already halted / 已停机");
    require(armedCause == 4 || _pendingCause() == 0,
            unicode"Condition still true / 触发条件仍然成立");               // 不是自由裁量
    escapeArmedAt = 0; armedCause = 0; emit EscapeArmCancelled(msg.sender);
}
```

**取消权必须是有条件的**：`00` §4.5 说四条触发都走 14 天可取消的武装期，旧版 `01` 却让前三条 `checkHalt()` 当场生效、不可取消。
两边都不对：当场生效让 200 万 BAC 的质押（v1 不罚没，7 天后原样取回）买到一个不可逆的全链终止开关（attack-gate #3）；
而「veto 钥可以无条件取消」又让逃生通道的存亡回到一把钥匙手里。
结论是**统一武装 + 只有在触发条件已经消失时才允许取消**（手动武装的 cause 4 例外，它本来就是自由裁量的）。

`_halt(cause)` 一次性固化，**O(1)**：

```solidity
reservedTotal = 0;                                    // 所有已释放未领的额度作废（钱从未离开 poolBalance）
escapeTotalWeight = totalCreditsIssued - totalCreditsExited;
uint256 junior = poolBalance - owedTotal;             // 已锁定债权是优先级，先全额扣掉
accPerWeight = escapeTotalWeight == 0 ? 0 : junior * 1e18 / escapeTotalWeight;
halted = true; haltedAt = uint64(block.timestamp); haltCause = cause; emit Halted(cause);
```

- **优先级 `claimOwedAfterHalt(to)`**：
  `require(lastClaimAt[msg.sender] + OWED_MATURITY <= haltedAt || (haltCause != 2 && haltCause != 3 && block.timestamp >= haltedAt + OWED_MATURITY), unicode"Owed not matured / 债权尚未成熟")`；
  `paid = owed[msg.sender]`（足额，I1 保证 `owedTotal <= poolBalance`）；
  `owed[…] = 0; unclaimed[…] = 0; owedDebt[…] = 0; owedTotal -= paid; poolBalance -= paid;` -> `nonReentrant` + CEI。
- **不成熟的 `owed` 怎么处理，取决于停机原因：**
  - `cause 1 / 4 / 5`（超时、手动、暂停超限）：**不是欺诈信号**，持有人在 `haltedAt + OWED_MATURITY` 之后照样足额领取（上面 require 的第二个分支）。
  - `cause 2 / 3`（有人 veto 了根，或验证者多数否决了根 —— 即**有确凿的「根可能是假的」信号**）：
    不成熟的 `owed` **永久降级**。任何人可在 `haltedAt + OWED_MATURITY` 之后调
    `sweepImmatureOwed(who)`：`accPerWeight += owed[who] * 1e18 / escapeTotalWeight; owedTotal -= owed[who]; owed[who] = 0; emit OwedDemoted(...)`
    （`escapeTotalWeight == 0` 时只减 `owedTotal`，钱留在池子里）。
  **为什么必须有这一条：** `owed` 是从中继单方提交的 `exitRoot` 派生的。旧写法里「中继私钥被盗 -> 发假根 -> 假 owed」
  和「停机 -> 假 owed 被足额、立即、且 `pause()` 拦不住地付掉」是同一条链路的两端 ——
  运营方发现被盗之后的每一个「正确」动作（veto / 让验证者否决 / 武装逃生）都是在替小偷解锁那笔钱（attack-funds #3）。
  加上成熟度之后，14 天内新生成的 `owed`（正是欺诈路径唯一能产出的东西）在 cause 2/3 下拿不到优先级；
  而「被 10% 上限截住的诚实老债权」一定是成熟的，不受影响。
- **次级 `escapeCollect(agentId, to)`**：`require(msg.sender == controller || msg.sender == agentWallet)`（**不查 status**）；
  `weight = credited[agentId] - exitedCredits[agentId]`（`claimExit` 的截断保证它永不下溢）；
  `paid = weight * accPerWeight / 1e18 - escapeDebt[agentId]`；
  `escapeDebt[agentId] += paid; poolBalance -= paid;` -> `nonReentrant` + CEI 出金。
- **`pause()` 不能冻结 `claimExit` / `claimOwedAfterHalt` / `escapeCollect`。**

**`pause()` / `unpause()`（只挡 `collect` 一个出金口）**

```solidity
function pause() external {                                  // 仅 watchdog
    uint64 nowTs = uint64(block.timestamp);
    if (pausedUntil > nowTs) pausedCumulative += nowTs - pauseStartedAt;   // 续期：先结算已用时长
    require(pausedCumulative < MAX_PAUSE_TOTAL, unicode"Pause budget exhausted / 暂停额度已用尽");
    pauseStartedAt = nowTs; pausedUntil = nowTs + PAUSE_LEN;
    emit Paused(msg.sender, pausedUntil, pausedCumulative);
}
function unpause() external {                                // 仅 watchdog
    pausedCumulative += uint64(block.timestamp) - pauseStartedAt;
    pausedUntil = 0; emit Unpaused(msg.sender, pausedCumulative);
}
// _pendingCause() 里：pausedCumulative + （当前正在暂停的已用时长）>= MAX_PAUSE_TOTAL -> cause 5
```

`watchdog` 是一把**热钥**（`00` §7.2 要求它随时可用），而且和签名节点、中继在同一台 VPS 上（同一信任域）。
旧写法「最长 7 天、可续」且「连续暂停多久」不是任何停机触发条件 —— 偷到这把热钥的人每 7 天调一次，
就能永久冻结全部出金，而三个停机条件一条都不满足（attack-funds #9）。
累计上限把「无限冻结」变成「冻满 21 天就自动打开逃生口」，方向永远是 fail-safe。
`isPaused()` 的第三个返回值 `cumulative` 必须出现在 `/api/health` 和网站首页。

**v1 没有强制包含队列（诚实条款，必须同时出现在 `00` §2 / §7.2 / 网站 FAQ）：**
出块节点可以单方面不把某个 agent 的 `L2Bridge.exit()` 打进区块，中继也可以在构造 `exitRoot` 时漏掉它的叶子，
而 `postAnchor` 的检查里没有一条能发现「少了一个叶子」。被定向审查的 agent 走不了 `escapeCollect`（链没停机）、
也没有自己的叶子可以 `claimExit`，**在 v1 里他没有任何链上救济**。
我们**不**在 v1 加「BSC 侧强制退出队列」，理由必须一并写出来：强制退出要按 `credited - exitedCredits` 直接锁定 `owed`，
但它无法让层内那份积分同时消失 —— 没被审查的人可以先走强制退出、再把同一批积分在层内正常退出一次，
两次都拿钱，代价由其他所有人承担。在没有层内证明的前提下，这个洞比它要补的问题更大。
强制包含留给 `00` §9 路线图的 v2（2/3 多签提交锚点 + 任何人可发起的链上挑战）。

### 4.3 不变量（写进 Foundry 不变量测试）

| Id | 不变量 |
|---|---|
| **B1** | **`owedTotal <= poolBalance`**（偿付不变式 I1，最重要的一条） |
| B2 | `address(this).balance >= poolBalance` |
| B3 | `reservedTotal == Sigma unclaimed[who] + Sigma (owed[who]*accPerOwed/1e27 - owedDebt[who])`（取整尘埃只会让左边略大；`owedTotal == 0` 时 `settleEpoch` 把它清零） |
| B4 | `totalCreditsExited <= totalCreditsIssued`；`Sigma exitedCredits[id] + unattributedExited == totalCreditsExited`；`Sigma credited[id] == totalCreditsIssued` |
| B5 | `Sigma 已付出的 BNB <= Sigma 通过 acceptRelease/sweepUntracked 收到的 BNB` |
| B6 | `IERC20(bacToken).balanceOf(address(this)) == totalLocked - 已 burn` |
| B7 | 没有任何函数能把 BAC 转给 `0x...dEaD` 以外的地址 |
| B8 | `watchdog` 与 `ChainAnchor.vetoKey()` 没有任何路径能移动 BNB 或 BAC，也不能阻止 `claimExit` / `claimOwedAfterHalt` / `escapeCollect`；本合约**不存在** `admin` 变量 |
| B9 | 同一 `exitId` 只能被 `claimExit` 一次；同一地址同一纪元只能 `collect` 一次 |
| B10 | **无先发优势**：对任意两笔在同一纪元锁定、金额不同的退出，`lockedWei / credits` 相等（同一 `rate`）；跨纪元的差异只来自池子真实变化 |
| **B11** | **`exitedCredits[id] <= credited[id]` 对所有 id 恒成立**（`escapeCollect` 的权重永不下溢） |
| B12 | 停机后 `Sigma claimOwedAfterHalt + Sigma escapeCollect <= 停机时的 junior + 停机后收到的全部 BNB` |
| B13 | `escapeTotalWeight == 0` 时 `accPerWeight == 0`，且 `acceptRelease` 仍然增加 `poolBalance` |
| **B14** | **`reservedTotal <= owedTotal`**（I2：预留永不棘轮，`pot` 不会收敛到 0） |
| **B15** | **任一地址在任意单个区块里通过 `collect` 拿到的总额 `<= lastPot * MAX_EXIT_SHARE_BPS/1e4`**；且**一个新锁定的 `owed` 分不到它锁定之前的任何一笔释放** |
| B16 | 任意 `veto` / `DISPUTED` 序列之后，存在无许可路径使 `lastSettledEpoch` 在 `SETTLE_GRACE` 内继续前进 |
| B17 | `pausedCumulative <= MAX_PAUSE_TOTAL`，达到即 `_pendingCause() == 5` |
| B18 | 停机时享受优先级的 `owed` 全部满足成熟度条件；cause 2/3 下不成熟的 `owed` 只能经 `sweepImmatureOwed` 降级，拿不到优先级 |
| B19 | `claimExit` 的可用性不依赖 `block.timestamp`，也不依赖 `isPaused()` |

### 4.4 模拟复核的验收线（`artifacts/sim/RESULTS.md`）

| 指标 | 锁定汇率口径实测 | 旧队列口径 |
|---|---|---|
| 先发优势倍数（1.00 = 无优势） | **0.99x** | 1.72x（modest）-2.16x（dead） |
| 独占退出者最高倍数 | **0.83x**（早退反而吃亏） | **27x** |
| 同纪元大户 / 小户横向 | **1.00x** | 34.6x |
| 某实体持全部积分、拆 40 号、第 0 天全挂：3 纪元 / 30 纪元搬走 | 14% / 71%（由 `RELEASE_BPS` 单独决定） | 一年 98% |

**M4 之后必须重跑**：上表的闸门指标是在「只能领当期 pot」的假设下算的，而旧合约规格允许跨纪元回头领取。
累加器口径下要重新验证 §11.5 的三条验收线，并新增一条对照场景：「攒 N 个纪元不领，再一次性领」——
目标是任一实体在任意单个区块内的提取额 `<= lastPot * 10%`，与 N 无关。

## 5. `BacNodeFund`

```solidity
contract BacNodeFund {
    address public immutable bacToken;      // 仅供工厂交叉校验用，合约本身不碰 BAC
    address public owner;                   // 决策 #10 的受益人；两步转让
    address public pendingOwner;

    function acceptRelease() external payable;          // 无许可
    function withdraw(address to, uint256 amount) external;   // 仅 owner；amount == 0 表示全部
    function transferOwnership(address newOwner) external;    // 仅 owner，两步
    function acceptOwnership() external;                      // 仅 pendingOwner

    function balance() external view returns (uint256);
    function lifetimeReceived() external view returns (uint256);
    function lifetimeWithdrawn() external view returns (uint256);

    event ReleaseReceived(address indexed from, uint256 amount, uint256 balanceAfter);
    event Withdrawn(address indexed to, uint256 amount, uint256 balanceAfter);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
}
```

**访问控制：** 只有 `owner` 能提；Flap Guardian **不能**（本合约不是 Flap 金库，不受规则 001 管辖）—— 这一点必须原样写进 `description()` 与网站。合约不可升级、无代理、没有任何代币救援函数、没有任何其它出金路径。
**不变量 N1：** `lifetimeReceived == lifetimeWithdrawn + balance`。**N2：** 没有任何路径能让本合约访问 `BacBridge` 的资金。

**`owner()` 是全项目唯一真正的「节点基金提取人」，必须被当成一个公开事实对待：**
- 金库的 `description()` 在运行时读它来渲染（§2.5），**不许用金库自己的 `owner` 冒充**；
- 它进 `00` §7.3 的发射后硬停清单与 `verify_launch.py` 的快照（`nodeFund.owner`）；
- 它每一次两步转让（`OwnershipTransferStarted` / `OwnershipTransferred`）都必须被索引器抓下来、在网站上显示，
  因为它一变，链上那段描述里的提取人地址就跟着变 —— 这正是它必须在运行时读、而不是写死在 `pure` 字符串里的原因。

---

## 6. `ChainAnchor`（不持有任何资金）

> **决策 #17 的增补在 §11.4，与本节合并后才是完整的 `ChainAnchor`**：
> `Anchor` 新增 `proposerIncomeRoot` / `gasFeesInEpoch` / `remittedInEpoch` / `proposerCount` 四个定长字段，
> `postAnchor` 多一个 `ProposerIncome[] rows` 参数与第 9–13 条检查，见证人的承诺从三元组改成四元组。


### 6.1 外部 ABI（逐字）

```solidity
contract ChainAnchor {
    enum State { NONE, POSTED, FINAL, VETOED, DISPUTED }

    struct Anchor {
        bytes32 exitRoot;        // leaf = keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, to, credits, epoch, 56777, bridge))
        bytes32 l2BlockHash;
        uint64  l2Block;
        uint64  postedAt;
        uint64  finalizedAt;
        uint128 creditedInEpoch;
        uint128 exitCreditsInEpoch;
        uint128 feeBurnedInEpoch;
        uint128 circulating;     // 信息字段：TOTAL_SUPPLY - L2Bridge - FeeSink - Signer @ l2Block
        uint32  exitCount;
        uint32  agreeingCount;
        State   state;
    }

    uint64  public constant EPOCH             = 86400;
    uint64  public constant COMMIT_WINDOW     = 2 hours;   // 纪元结束后，中继必须等这么久才能发锚点
    uint64  public constant CHALLENGE_WINDOW  = 24 hours;
    uint64  public constant HALT_TIMEOUT      = 90 days;
    uint8   public constant VETO_LIMIT_PER_WINDOW    = 7;  // 任意连续 STREAK_WINDOW 个纪元内
    uint8   public constant DISPUTE_LIMIT_PER_WINDOW = 3;
    uint8   public constant STREAK_WINDOW     = 30;        // 滑动窗口长度（纪元），用 uint32 位图 O(1) 维护
    uint8   public constant QUORUM            = 3;
    uint16  public constant DISPUTE_MIN_BPS   = 3333;      // 异议权重还必须 >= 总质押的 1/3
    uint64  public constant ADMIN_TIMELOCK    = 48 hours;

    address public immutable bridge;          // 只读 totalCreditsIssued()
    uint128 public immutable initialCirculating;   // = OPERATOR_FLOAT（1,000e18），见下
    address public relayer;
    address public admin;
    address public vetoKey;
    address public validatorStaking;          // 一次性绑定，仅部署者

    // ---- 写 ----
    function postAnchor(uint64 epoch, Anchor calldata a) external;   // 仅 relayer
    function finalize(uint64 epoch) external;                        // 无许可，POSTED 满 CHALLENGE_WINDOW
    function veto(uint64 epoch, bytes32 reasonHash) external;        // admin 或 vetoKey，仅窗口内
    function proposeRelayer(address newRelayer) external;            // 仅 admin
    function executeRelayerRotation() external;                      // 仅 admin，48h 后
    function cancelRelayerRotation() external;                       // admin 或 vetoKey
    function setValidatorStaking(address s) external;                // 仅部署者，仅一次

    // ---- views ----
    function getAnchor(uint64 epoch) external view returns (Anchor memory);
    function lastPostedEpoch() external view returns (uint64);
    function lastFinalEpoch() external view returns (uint64);
    function lastFinalAt() external view returns (uint64);
    function cumulativeCredited() external view returns (uint256);
    function cumulativeExit() external view returns (uint256);
    function lastFinalCirculating() external view returns (uint256);
    function vetoCountInWindow() external view returns (uint8);      // 最近 STREAK_WINDOW 个纪元里被 veto 的次数
    function disputeCountInWindow() external view returns (uint8);
    function l2BlockFor(uint64 epoch) external view returns (uint64); // 规范定义见 §6.2，链上只存不算
    function releaseBpsFor(uint64 epoch) external view returns (uint16);   // 200 / 350 / 500
    function haltReason() external view returns (uint8);                    // 0 = 未满足

    event AnchorPosted(uint64 indexed epoch, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block,
                       uint128 credited, uint128 exitCredits, uint128 feeBurned, uint128 circulating, uint32 exitCount);
    event AnchorFinalized(uint64 indexed epoch, uint32 agreeingCount, uint16 releaseBps);
    event AnchorVetoed(uint64 indexed epoch, address indexed by, bytes32 reasonHash, uint8 countInWindow);
    event AnchorDisputed(uint64 indexed epoch, uint256 agreeingWeight, uint256 disputingWeight,
                         uint32 disputingCount, uint8 countInWindow);
    event RelayerRotationQueued(address indexed newRelayer, uint64 eta);
    event RelayerRotationCancelled(address indexed by);
    event RelayerChanged(address indexed from, address indexed to);
}
```

### 6.2 `postAnchor` 的链上强制检查（全部 O(1)，不依赖任何人诚实）

| # | 检查 | require 字符串 |
|---|---|---|
| 1 | `msg.sender == relayer` | `unicode"Only relayer / 仅限中继"` |
| 2 | `epoch == lastPostedEpoch + 1` | `unicode"Epochs must be sequential / 纪元必须连续"` |
| 3 | 上一个纪元已定案（`FINAL`/`VETOED`/`DISPUTED`，或 `epoch == firstEpoch`） | `unicode"Previous epoch not resolved / 上一个纪元尚未定案"` |
| 4 | **`block.timestamp >= (epoch + 1) * EPOCH + COMMIT_WINDOW`** | `unicode"Commit window not closed / 承诺窗口未结束"` |
| 5 | **`a.l2Block >= getAnchor(epoch-1).l2Block`** | `unicode"Layer block must not go back / 层内区块号不得回退"` |
| 6 | `a.exitCredits == 0 || a.exitRoot != bytes32(0)` | `unicode"Exit root missing / 缺少退出根"` |
| 7 | **`cumulativeCredited + a.creditedInEpoch <= IBacBridge(bridge).totalCreditsIssued()`** | `unicode"Credits exceed BSC deposits / 积分超过 BSC 上锁定的数量"` |
| 8 | **`cumulativeExit + a.exitCreditsInEpoch <= cumulativeCredited + a.creditedInEpoch`** | `unicode"Exit credits exceed issued / 退出积分超过已发行"` |

第 7 条是整个跨链安全的承重墙：`totalCreditsIssued` 累积在 BSC 上、中继碰不到，所以即使二层从备份重建导致 `seen[]` 清零、发生重放双花，下一个锚点照样撞墙。
被 `VETOED` / `DISPUTED` 的纪元里发生的 `credited` / `exitCredits` / `feeBurned`，**必须由中继并入下一个纪元的锚点重新上报**（累计计数器只在 `finalize()` 里累加）；
退出叶子同样重报，而叶子里已经没有 `epoch` 字段（§4.1），所以重报到任何后续纪元都能正常证明。

**第 4 条为什么必须有 `COMMIT_WINDOW`（attack-funds #7）：** 见证人的承诺必须落在「纪元结束」与「中继发锚点」之间，
而旧写法里这个区间的长度**完全由中继单方决定，下界是 0** —— 它只要在 `(epoch+1)*86400` 之后的第一个 BSC 区块（0.45 s）
就发锚点，任何 `commitAttestation` 都会撞上「锚点已发」而 revert，`disputingWeight` 永远是 0，
`DISPUTED` 永远不会发生，`00` §5「结果有牙齿」整节失效，而决定窗口长度的正是可能被盗的那把钥匙。
2 小时与 §7.1 已有的监控线「锚点超 `epochEnd + 2h` 未发」正好对齐。
配套：`commitAttestation` 改成**只看时间**（`block.timestamp < (epoch+1)*EPOCH + COMMIT_WINDOW`），不再看锚点状态（§7）。

**第 5 条为什么从 `>` 放宽成 `>=`（attack-gate #4）：** 只有一个签名节点，一次跨过 UTC 日的停机（磁盘满、宿主机维护、
Docker 镜像被上游删）就会产生一个**层内零区块的纪元**。那个纪元的规范 `l2Block` 等于上一纪元的，`>` 永远不成立，
而 `epoch == lastPostedEpoch + 1` 不可跳号 —— 一次 24 小时的停机会让整条链的退出功能永久报废。
`>` 防的是「中继锚到一个更早的区块」，`>=` 已经够；真正承重的是第 7/8 条。
**空纪元锚点的规范形状（必须允许）：** `exitCount == 0 && exitRoot == 0 && creditedInEpoch == 0 && exitCreditsInEpoch == 0`，
`l2Block` 等于上一纪元，`l2BlockHash` 取同一个块。

**`l2Block(epoch)` 的规范定义（attack-funds #5，三处实现必须字节级一致）：**

> `l2Block(epoch)` = **时间戳 `< (epoch + 1) * 86400` 的最大层内区块号**；
> `l2BlockHash` = 该区块的哈希；
> 六个计数字段与 `exitRoot` 全部在区块区间 `(l2Block(epoch-1), l2Block(epoch)]` 上聚合，**不用墙钟、不用时间戳筛日志**；
> `circulating` 用 `eth_getBalance(addr, l2Block(epoch))` 读，**不读 head**。

旧写法让中继「取提交时的 head」，而见证人必须在锚点发布**之前**就把 `l2Block` 和 `l2BlockHash` 封进承诺里 ——
等于要猜中继未来某一刻会选哪个区块。10 个诚实验证者会因此全部计入 `disputingWeight`，
第 3 个纪元就 `disputeStreak = 3`，**链在上线第 3 天自动停机**。规范化之后任何人都能独立算出同一个 `l2Block`。
这条定义必须逐字出现在 `03-INTERFACES.md` §1.3、`@bac/agent-sdk` 和 `@bac/node-cli` 三处，且有 fuzz 对拍测试。

**账本恒等式检查已删除（旧第 9 条，attack-gate #1 + attack-funds #6）。**
旧检查是 `a.circulating + a.exitCreditsInEpoch + a.feeBurnedInEpoch == lastFinalCirculating + a.creditedInEpoch`，硬 revert。
它是**任何人花 21,000 gas 就能触发的永久停桥开关**：往 `L2Bridge`（`0x…0101`）转 1 wei 积分，
`circulating` 就少 1 wei，等式左边永远对不上，而 `postAnchor` 不可跳号 —— 之后每一个纪元都发不出去，
`claimExit` 永久 revert，90 天后只能走逃生。不需要攻击者也会发生：Clique 下小费进签名者 EOA，
`feeBurned` 按「base fee + 发布费」的自然读法不含小费，**第一笔带小费的交易**就把它打穿。
而且创世时 `circulating` 已经等于 `OPERATOR_FLOAT = 1000e18`，`lastFinalCirculating` 初值却是 0 ——
**第一个锚点就 revert，链永远发不出第一个锚点。**
`circulating` 本来就被 §6.1 标为「信息字段」，`00` §0.2 F2 也明说它不是熔断条件；一个不承重的字段不该有能力把桥锁死。
**处理方式：**
1. `postAnchor` 不再对 `circulating` 做任何等式校验，它只是被原样记录进锚点与事件（信息字段）。
2. `lastFinalCirculating` 仍然维护，构造参数 `initialCirculating` 在部署时写 `OPERATOR_FLOAT = 1000e18`。
3. 真正的对账搬到链下、并改成一个**恒成立**的形式（`03-INTERFACES.md` §3.1）：
   `diff := (totalCreditsIssued − totalCreditsExited)
           − (layerCirculating + B_sink + B_splitter + Σ B_validator for v in everValidator)` 恒为 0，
   任何人用几条 `cast` 就能复算；差额非零才是真信号，才值得告警。
   （`B_splitter` 是决策 #17 新增的 `FeeSplitter 0x…0104` 余额；QBFT 下验证者集可变，所以最后一项按累积表 `everValidator` 逐个减，`02` §4.1。）
4. `00` §7.3 的硬停清单加一项：部署后 `ChainAnchor.lastFinalCirculating() == OPERATOR_FLOAT`。

### 6.3 `finalize(epoch)`（无许可）

```
require(state == POSTED && block.timestamp >= postedAt + CHALLENGE_WINDOW)
(agreeingWeight, disputingWeight, agreeingCount, disputingCount)
    = IValidatorStaking(validatorStaking).attestationResult(epoch, a.exitRoot, a.l2BlockHash, a.l2Block)
// 异议要成立必须同时满足三条（attack-gate #3）：
//   ① disputingWeight >= agreeingWeight
//   ② disputingWeight >= totalStaked * DISPUTE_MIN_BPS / 10000      （绝对门槛，约 1/3）
//   ③ disputingCount  >= QUORUM(3)                                   （独立地址数）
if (disputingWeight >= agreeingWeight
    && disputingWeight * 10000 >= IValidatorStaking(validatorStaking).totalStaked() * DISPUTE_MIN_BPS
    && disputingCount >= QUORUM) {
    state = DISPUTED; _markWindow(disputeBitmap, epoch); emit AnchorDisputed(...);   // 不结算、不释放
} else {
    state = FINAL; finalizedAt = block.timestamp;
    cumulativeCredited += a.creditedInEpoch;
    cumulativeExit     += a.exitCreditsInEpoch;
    lastFinalCirculating = a.circulating;                 // 信息字段，不参与任何校验
    lastFinalEpoch = epoch; lastFinalAt = block.timestamp;
    a.agreeingCount = agreeingCount; emit AnchorFinalized(epoch, agreeingCount, releaseBpsFor(epoch));
}
```

**两个计数器改成滑动窗口，不再是「连续」计数（attack-gate #8）。**
旧写法在每个 `FINAL` 里把 `vetoStreak` / `disputeStreak` 清零，于是「veto 七个、放过一个、再 veto 七个」
可以无限循环：退出速度被压到名义值的 1/8（200 bps x 1/8 = 0.25%/纪元，「20 天释放一半」变成 230 天），
而 `HALT_TIMEOUT` 和连续计数**永远不会触发**，链上看起来完全合法。
改成**任意连续 `STREAK_WINDOW = 30` 个纪元内的计数**，实现用一个 `uint32` 位图（每一位表示该纪元是否被 veto / 否决），
`_markWindow` 与 `countInWindow` 都是 O(1)、无循环（`popcount` 用查表或 4 次并行位运算）。
达到 `VETO_LIMIT_PER_WINDOW` / `DISPUTE_LIMIT_PER_WINDOW` 即 `haltReason()` 返回 2 / 3；
`BacBridge.checkHalt()` 据此**武装**逃生（14 天可取消，见 §4.2），**不是当场停机**。

`releaseBpsFor(epoch)`：`agreeingCount == 0 → 200`；`1..2 → 350`；`>= QUORUM(3) → 500`。
`veto(epoch)`：仅 `POSTED` 状态且在窗口内；`_markWindow(vetoBitmap, epoch)`；
`require(vetoCountInWindow() <= VETO_LIMIT_PER_WINDOW, unicode"Veto limit reached / 否决次数已用尽")`（第 8 次直接 revert）。

**`haltReason()` 的语义（`BacBridge` 依赖它）：** 返回 0 = 不满足；1 = `block.timestamp >= lastFinalAt + HALT_TIMEOUT`；
2 = `vetoCountInWindow() >= VETO_LIMIT_PER_WINDOW`；3 = `disputeCountInWindow() >= DISPUTE_LIMIT_PER_WINDOW`。
**它是纯 view，本合约自己不因此改变任何状态** —— 停机的决定权与时序全部在 `BacBridge`。

### 6.4 不变量

| Id | 不变量 |
|---|---|
| C1 | 本合约的 `address(this).balance` 恒为 0（没有 `receive()`，没有 `payable` 函数） |
| C2 | `cumulativeExit <= cumulativeCredited <= IBacBridge(bridge).totalCreditsIssued()` |
| C3 | 每个 epoch 最多被 `postAnchor` 一次；状态只能 `NONE -> POSTED -> {FINAL, VETOED, DISPUTED}`，终态不可再改 |
| C4 | `relayer` / `admin` / `vetoKey` 都没有任何转移资金的路径 |
| C5 | 部署后立即 `lastFinalCirculating() == OPERATOR_FLOAT`（`initialCirculating` 构造参数） |
| C6 | 单个地址（无论它注册了几个 `nodeIdHash`）永远无法独自把一个纪元打成 `DISPUTED`（三条门槛之一是独立地址数 `>= QUORUM`） |
| C7 | `postAnchor` 的可行性不依赖任何层内余额：**没有任何链上余额、任何转账、任何第三方动作能让 `postAnchor` 永久 revert** |
| C8 | 一个层内零区块的纪元（长时间停机）仍然可以被 `postAnchor` 接受 |

---

## 7. `ValidatorStaking`

> **决策 #17 的增补在 §11.5**：`setLayerAddresses` / `settleRemittance` / `claimWithheld`，
> 以及归集短缺时的「扣发 BSC 侧奖励 + 撤销出块资格」（**不罚没本金**）。
> 下面 ABI 里的 `commitAttestation` / `revealAttestation` / `attestationResult` 均按 §11.4 改成**四元组**（多一项 `proposerIncomeRoot`）。


```solidity
contract ValidatorStaking {
    address public immutable bacToken;
    address public immutable anchor;
    address public admin;

    uint256 public constant MIN_STAKE           = 2_000_000e18;
    uint64  public constant UNSTAKE_COOLDOWN    = 7 days;
    uint16  public constant MAX_NODES           = 64;
    // WEIGHT_CAP 已删除（00 §11.1 M3）：线性权重拆号中性，加上限之后拆号严格更赚；
    // 而且旧规格只有一个「权重」概念，上限会同时削掉诚实大户的**异议阻力**，
    // 把「强制 DISPUTED」的攻击成本直接打三折（attack-gate #9）。
    uint16  public constant MAX_VALIDATOR_SHARE_BPS = 2500;        // 只约束**分奖**，绝不约束见证权重
    uint16  public constant REWARD_RELEASE_BPS  = 500;
    uint64  public constant REWARD_CLAIM_WINDOW = 30 days;
    uint8   public constant MAX_STRIKES         = 3;
    uint64  public constant ADMIN_TIMELOCK      = 48 hours;

    // ---- 质押（本合约里没有任何 admin 能移动质押的路径，也没有代币救援函数）----
    function stake(uint256 amount) external;                  // 按余额差记账
    function requestUnstake(uint256 amount) external;
    function withdrawUnstaked(address to) external returns (uint256);

    // ---- 节点 ----
    function registerNode(bytes32 nodeIdHash, string calldata enodeURI, address payout) external;
    function retireNode(bytes32 nodeIdHash) external;

    // ---- 见证（承诺-揭示）----
    function commitAttestation(uint64 epoch, bytes32 commitment) external;
    // commitment = keccak256(abi.encode(epoch, exitRoot, l2BlockHash, l2Block, salt, msg.sender))
    // **只看时间**：require(block.timestamp < (epoch + 1) * EPOCH + IChainAnchor.COMMIT_WINDOW)。
    // 绝不能写成「要求锚点 state == NONE」——那等于把承诺窗口的长度交给中继，它可以压成 0.45 秒
    // 让任何人都来不及承诺，DISPUTED 永远不会发生（attack-funds #7）。
    function revealAttestation(uint64 epoch, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, bytes32 salt) external;
    // 要求 state == POSTED 且在 24h 窗口内
    function attestationResult(uint64 epoch, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block)
        external view returns (uint256 agreeingWeight, uint256 disputingWeight,
                               uint32 agreeingCount, uint32 disputingCount);
        // 权重**按 validator 地址算，且每个地址只算一次**（见下），count 也是独立地址数

    // ---- 奖励（余额靠无许可注入，v1 由运营方从节点基金注入，见 00 §6.3）----
    function fundRewards() external payable;                   // 无许可
    function settleEpochRewards(uint64 epoch) external;        // 无许可，**必须按序**：epoch == lastRewardEpoch + 1
    function claimReward(uint64 epoch, address validator) external returns (uint256);   // 按地址领，不按节点
    function sweepExpired(uint64 epoch) external returns (uint256);  // 无许可，30 天后退回奖励余额

    // ---- 管理（48h 时锁；只取消领奖资格，绝不碰质押）----
    function proposeRemoveValidator(address v, bytes32 reasonHash) external;   // 仅 admin
    function executeRemoveValidator(address v) external;                        // 仅 admin，48h 后
    function cancelRemoveValidator(address v) external;                         // admin 或 ChainAnchor.vetoKey

    // ---- views ----
    function stakeOf(address who) external view returns (uint256 staked, uint256 pending, uint64 unlockAt);
    function totalStaked() external view returns (uint256);
    function nodeCount() external view returns (uint256);
    function nodeAt(uint256 i) external view returns (bytes32 nodeIdHash);
    function nodeOf(bytes32 nodeIdHash) external view
        returns (address validator, address payout, string memory enodeURI, bool active, uint32 strikes);
    function rewardBalance() external view returns (uint256);
    function epochReward(uint64 epoch) external view returns (uint256 pot, uint256 weight, uint256 rate, bool settled);
    function rewardOf(uint64 epoch, address validator) external view returns (uint256);
    function nodesOf(address who) external view returns (uint256);
    function lastRewardEpoch() external view returns (uint64);
    function lifetimeFunded() external view returns (uint256);
    function lifetimePaid() external view returns (uint256);

    event Staked(address indexed who, uint256 amount, uint256 total);
    event UnstakeRequested(address indexed who, uint256 amount, uint64 unlockAt);
    event Unstaked(address indexed who, address indexed to, uint256 amount);
    event NodeRegistered(bytes32 indexed nodeIdHash, address indexed validator, address payout, string enodeURI);
    event NodeRetired(bytes32 indexed nodeIdHash);
    event AttestationCommitted(uint64 indexed epoch, address indexed validator, bytes32 commitment);
    event AttestationRevealed(uint64 indexed epoch, address indexed validator, bytes32 exitRoot,
                              bytes32 l2BlockHash, uint64 l2Block, bool agreeing, uint256 weight);
    event RewardsFunded(address indexed from, uint256 amount, uint256 balanceAfter);
    event RewardsSettled(uint64 indexed epoch, uint256 pot, uint256 weight, uint256 rate);
    event RewardClaimed(uint64 indexed epoch, address indexed validator, address indexed to, uint256 amount);
    event RewardExpired(uint64 indexed epoch, uint256 returned);
    event NodeStruck(bytes32 indexed nodeIdHash, uint32 strikes);
    event ValidatorRemovalQueued(address indexed v, bytes32 reasonHash, uint64 eta);
    event ValidatorRemoved(address indexed v);
}
```

**规则要点**
- 每个 `nodeIdHash` 必须绑定一份**独立达标**的质押：`registerNode` 要求 `stakeOf(msg.sender).staked >= MIN_STAKE * (nodesOf(msg.sender) + 1)`，否则一个地址可以把 64 个槽位全占了（judge-attack N7）。
- **`requestUnstake` 必须复查同一条不等式**：`require(staked - amount >= MIN_STAKE * nodesOf(msg.sender), unicode"Retire a node first / 请先退掉一个节点")`。
  没有这一条，「押 800 万 → 注册 4 个节点 → 解押 600 万」在规格里一个函数都不会 revert，
  于是 200 万 BAC 背着 4 个槽位，「1.28 亿 BAC 才能占满 64 槽」的假设变成 3200 万（attack-funds #16）。
- **见证权重 `attestWeight = stakeOf(validator).staked`，纯线性、无上限、按地址去重。**
  一个地址注册了几个 `nodeIdHash` 都只算一次；`nodeIdHash` 只用于展示、enode 和 `strikes`。
  奖励侧的 `MAX_VALIDATOR_SHARE_BPS = 2500` **只约束分奖，绝不参与 `attestationResult`** ——
  把分奖上限混进见证权重，等于给「强制 DISPUTED」的攻击者打折。
- 分奖也按**地址**算：`epochReward.weight = Σ_{报对根的地址} stakeOf(地址)`，`claimReward(epoch, validator)` 每地址每纪元一次。
  按节点发奖 + 按地址见证的旧组合，会让「2M 质押 + 4 个节点槽」拿到 `4 × min(share, 25%)`，
  而诚实的单节点 8M 质押者被 25% 上限压住 —— 拆号从「中性」变成稳赚 4 倍。
- `settleEpochRewards` **必须按序**（`epoch == lastRewardEpoch + 1`），并且和 `BacBridge.settleEpoch` 用同一套跳过规则
  （非 FINAL 的纪元 pot = 0，只推进游标）。旧写法没有顺序约束：攒 100 个纪元没人结算，
  某个验证者可以在一个区块里连发 100 笔，按 5% 复利切走奖励余额的 99.4%，再用 4 个号把每个 pot 吃满（attack-funds #15）。
- **「余数」只有一个去处**：分不掉的余数留在 `rewardBalance` 里（不滚进某个纪元的 pot）；
  `sweepExpired(epoch)` 把 30 天未领的 pot 退回 `rewardBalance`。两句话合成一句，
  不变量 S2 才成立（`lifetimeFunded == lifetimePaid + rewardBalance + 未过期未领的 epoch pot`）。
- `revealAttestation` 与 commitment 不符 → 不计入任何一边，`strikes += 1`。
- `attestationResult` 的比较对象是 **`(exitRoot, proposerIncomeRoot, l2BlockHash, l2Block)` 四元组全等**（§11.4 加了第四项）；
  `l2Block` 按 §6.2 的规范定义算，`proposerIncomeRoot` 按 `03` §1.3 的逐字算法算，
  两者都不是「中继提交时的 head」之类的不可预测量 —— 否则诚实见证人必然报出不同的元组，链会在第 3 天被自己的见证机制停掉（attack-funds #5）。
- **v1 不罚没。** `executeRemoveValidator` 只把节点标为 `active = false` 并取消领奖资格，**本金照样按 `UNSTAKE_COOLDOWN` 取回**。
  这条的代价必须写进 `00` §2 信任表：一个 `MIN_STAKE` 的质押者可以连续否决锚点，逼出 14 天的逃生武装期，
  7 天冷却后原样取回本金。抵消它的是 `finalize` 的三条门槛（权重 + 1/3 绝对门槛 + 3 个独立地址）和 14 天可取消的武装期，
  **不是罚没**。
- 不变量 S1：`IERC20(bacToken).balanceOf(this) >= totalStaked + 待领的 unstake`；
  S2：见上；S3：没有任何 admin 路径能移动 BAC；
  **S4：对任意地址 `stakeOf(who).staked >= MIN_STAKE * nodesOf(who)` 恒成立**；
  **S5：`attestationResult` 里同一个地址的权重只被计入一次，且不受任何上限削减**。

---

## 8. 层内合约（chainId 56777）

> 本节三个合约 + **`FeeSplitter` @ `0x…0104`（§11，决策 #17）** 共四个创世**系统合约**。
> `0x…0105` 留给 v2 的 QBFT 验证者集镜像合约（`02` §6.3），**不再是 `0x…0104`**。
> **`WBAC` @ `0x…0106`（§8.4，决策 #22）不是系统合约，是中立工具**，和 Multicall3、CREATE2 部署器同一类：
> 没有人调它、没有人能改它、它不参与桥 / 身份 / 纪元 / 分账的任何一步。放进创世只是因为
> Uniswap-V2 式的池子两边都得是 ERC-20，链上没有一个公认的 WBAC，agent 手上的 gas 币就进不了任何池子。


### 8.1 `L2Bridge` @ `0x0000000000000000000000000000000000000101`

```solidity
contract L2Bridge {
    uint256 public constant BSC_CHAIN_ID  = 56;
    address public immutable BSC_BRIDGE;        // BacBridge 地址，写进代码常量
    address public immutable ROTATION_SIGNER;   // 创世写死的冷钥，唯一能换中继的授权来源
    uint64  public constant EPOCH = 86400;

    function credit(bytes32 depositId, uint256 agentId, address to, uint256 amount) external;  // 仅 relayer，幂等，**不外呼**
    function withdrawCredits(address to) external returns (uint256 amount);   // 无许可：谁都能替别人提
    function exit(address bscRecipient) external payable returns (uint256 exitId);
    // **不接受调用者传的 agentId**：agentId 由 L2Gate 查表得到，查不到记 0。
    // 不检查任何 agent 状态，不检查 L2Gate 的 status —— 退出是唯一不得被门控的动作
    function burnFloat() external payable;      // 无许可：把 msg.value 留在本合约、退出流通，**不产生退出叶子**
    function rotateRelayer(address newRelayer, uint256 nonce, bytes calldata sig) external;
    // 任何人可提交；只验 ROTATION_SIGNER 对 EIP-712 Rotate(address newRelayer,uint256 nonce) 的签名；
    // 不需要旧中继签名，不经过被怀疑的通道

    function relayer() external view returns (address);
    function seen(bytes32 depositId) external view returns (bool);
    function creditable(address who) external view returns (uint256);
    function totalBurnedFloat() external view returns (uint256);
    function reserve() external view returns (uint256);          // address(this).balance
    function totalCredited() external view returns (uint256);
    function totalExited() external view returns (uint256);
    function rotationNonce() external view returns (uint256);
    function exitCount() external view returns (uint256);

    event CreditsMinted(bytes32 indexed depositId, uint256 indexed agentId, address indexed to, uint256 amount);
    event CreditsWithdrawn(address indexed to, uint256 amount);
    event ExitBurned(uint256 indexed exitId, uint256 indexed agentId, address indexed bscRecipient,
                     uint256 amount, uint64 epoch);
    event FloatBurned(address indexed from, uint256 amount);
    event RelayerRotated(address indexed from, address indexed to, uint256 nonce);
}
```

- **「铸币」= 从本合约的创世余额里转出**，「销毁」= 转回本合约名下。不改 geth，不加预编译。
- **`credit` 是拉取模式，里面没有任何外部调用**：
  `require(msg.sender == relayer)` → `require(!seen[depositId])` → `seen[depositId] = true` →
  `creditable[to] += amount; totalCredited += amount; emit CreditsMinted(...)`。
  `withdrawCredits(to)` 无许可（谁都能替别人调）：`amount = creditable[to]; creditable[to] = 0; call{value: amount}(to)`。
  **为什么不能在 `credit` 里直接 `call`（attack-funds #12）：** `agentWallet` 在注册时由申请者填（现在要求它自己签名，
  但它仍然可以是一个 `receive() { revert(); }` 的合约）。旧写法里这个外部调用的返回值没人检查、失败分支没定义：
  ① 失败就整笔 revert → 中继严格单线程的 outbox 被一条 job 永久堵死，全链进桥停摆；
  ② 忽略返回值 → `totalCredited` 涨了但 BAC 没出 `L2Bridge`，链下对账差额永久发散。
  拉取模式让 `credit` 不可能失败，`seen` 幂等，单个 agent 永远卡不住中继。
  层内流通量口径不变（钱在被提走之前还在 `L2Bridge` 名下）。
- `exit`：`require(msg.value > 0)`；`uint256 agentId = IL2Gate(0x…0102).agentIdOf(msg.sender)`（**只查表，不查 status**，
  查不到就是 0）；`exitId = ++exitCount`；`totalExited += msg.value`；`epoch = block.timestamp / EPOCH`；
  `require(epoch >= lastExitEpoch, unicode"Timestamp went backwards / 时间戳回退")`；`lastExitEpoch = epoch`；`emit ExitBurned(...)`。
  **`agentId` 绝不能由调用者传**：BSC 侧的 `exitedCredits[agentId]` 是逃生通道的唯一依据，
  调用者可填意味着「用受害者的 agentId 退出自己的积分」——攻击者保住全部逃生权重（免费双领），
  受害者的 `credited - exitedCredits` 下溢，`escapeCollect` 对他**永久 revert**（attack-funds #4）。
  BSC 侧另有截断兜底（§4.2 第 6 步），两侧都要有。
- `burnFloat()`：任何人可调，`totalBurnedFloat += msg.value`，钱留在本合约名下（等价于退出流通），**不产生任何退出叶子**。
  用途只有一个：运营方需要在层内主动缩表时有一个规范出口（`OPERATOR_FLOAT` 的消耗、误发的积分），
  不必依赖「签名者余额不流通」这种会计约定。**它不是重组善后手段** —— 重组善后是运营方在 BSC 上补 `lock`（§4.2）。
- 中继每纪元把该纪元的 `ExitBurned` 日志聚合成 merkle 树，叶子**必须逐字等于** BSC 侧的 `EXIT_TYPEHASH` 布局
  （**没有 epoch 字段**）：
  `keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, bscRecipient, amount, 56777, BSC_BRIDGE))`。
  分桶（这笔退出属于哪个纪元）**一律以 `ExitBurned` 事件里的 `epoch` 字段为准**，别无他解；
  被 veto / disputed 的纪元里的叶子并入后续锚点时，叶子本身一个字节都不变。

### 8.2 `L2Gate` @ `0x0000000000000000000000000000000000000102`

```solidity
contract L2Gate {
    function applySync(uint256 agentId, address wallet, uint8 status, uint64 bscBlock) external;  // 仅 relayer
    function isAdmitted(address wallet) external view returns (bool);   // status == ACTIVE
    function agentIdOf(address wallet) external view returns (uint256);
    function statusOf(address wallet) external view returns (uint8);
    event AgentSynced(uint256 indexed agentId, address indexed wallet, uint8 status, uint64 bscBlock);
}
```
`L2Gate` 的 `isAdmitted`（status == ACTIVE）**只被 `AgentBook` 读**；
`L2Bridge.exit` 只调它的 `agentIdOf`（查表，不看 status），**绝不因为 status 拒绝任何退出**（G11）。

### 8.3 `AgentBook` @ `0x0000000000000000000000000000000000000103`

```solidity
contract AgentBook {
    address public constant FEE_SINK = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant PUBLISH_FEE = 0.001 ether;       // 单位是层内 BAC
    uint16  public constant MAX_PER_EPOCH = 20;
    uint16  public constant MAX_SUMMARY_BYTES = 120;
    uint64  public constant EPOCH = 86400;

    function announce(bytes32 kind, address subject, bytes32 contentHash,
                      string calldata summary, string calldata uri) external payable returns (uint64 seq);
    function heartbeatNote(uint64 epoch, bytes32 note) external;
    function actionCount() external view returns (uint64);
    function countInEpoch(address who, uint64 epoch) external view returns (uint16);

    event Action(uint256 indexed agentId, bytes32 indexed kind, address indexed subject,
                 address actor, bytes32 contentHash, string summary, string uri, uint64 seq, uint64 epoch);
    event Note(uint256 indexed agentId, uint64 indexed epoch, bytes32 note);
}
```
- `announce` 要求 `L2Gate.isAdmitted(msg.sender)`、`msg.value >= PUBLISH_FEE`（转给 `FEE_SINK`）、`bytes(summary).length <= 120`、`countInEpoch <= 20`。
- `kind` 是写死的常量集：`keccak256("JOIN"|"DEPLOY"|"PUBLISH"|"SERVICE"|"TRADE"|"LIST"|"POOL"|"STRATEGY"|"MESSAGE"|"CLAIM"|"NOTE")`。
- **`summary` / `uri` 是 agent 自己写的不可信文本**：索引器与网站一律转义、一律不当 HTML、一律标注「由 agent 自己写的」，网站绝不替它背书。

### 8.4 `WBAC` @ `0x0000000000000000000000000000000000000106`（中立工具，决策 #22）

层内原生币 BAC 的包装 ERC-20，**WETH9 形态**。实现在 `contracts/src/layer/WBAC.sol`，
测试在 `contracts/test/WBAC.t.sol`。

```solidity
contract WBAC {
    string public constant name     = "Wrapped BAC";   // 逐字冻结
    string public constant symbol   = "WBAC";          // 逐字冻结
    uint8  public constant decimals = 18;

    mapping(address => uint256) public balanceOf;                          // slot 0
    mapping(address => mapping(address => uint256)) public allowance;      // slot 1

    function deposit() external payable;                 // 存原生币，铸等量 WBAC
    receive() external payable;                          // 直接转账 = deposit()
    fallback() external payable;                         // 未知 calldata 带钱 = deposit()（WETH9 行为）
    function withdraw(uint256 wad) external;             // 烧 WBAC，退等量原生币
    function totalSupply() external view returns (uint256);   // == address(this).balance
    function approve(address guy, uint256 wad) external returns (bool);
    function transfer(address dst, uint256 wad) external returns (bool);
    function transferFrom(address src, address dst, uint256 wad) external returns (bool);

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
}
```

**为什么预置（决策 #22 的理由，逐条）**

1. Uniswap-V2 式的 pair 要求两边都是 ERC-20。没有 WBAC，agent 手上的 gas 币（原生 BAC）**没有任何办法**
   进入一个池子，第一个池子就建不起来，流动性无从谈起。
2. 不预置不等于没有：早晚会有三五个互不兼容的 WBAC，**流动性被切碎**，而且谁也说不清哪个是「对的」。
   预置一个、公开地址、永不可改，是把这个问题一次性解决掉的唯一办法。
3. **它不是 DEX。** 这里没有池子、没有路由、没有手续费、没有 owner、没有 admin、没有可升级路径、
   没有任何可调参数。DEX 仍然由 agent 自己写（`00` §6 第 10 条）。对外口径也因此从
   「链完全空白」改成「**三个系统合约 + 三个中立工具（Multicall3 / CREATE2 部署器 / WBAC），其余全部由 agent 自己建**」。

**和 WETH9 的差异，只有一处，写在这里免得以后有人当成 bug**

| 项 | WETH9 | 本合约 | 为什么 |
|---|---|---|---|
| `name` / `symbol` 存在哪 | 构造函数写进 storage | **编译期 `constant`，在代码里** | 创世合约必须构造时零 storage（`02` §3.2 alloc 规则 1）。照抄 WETH9 就必须手写 storage 槽进 alloc，那条规则直接禁止 |
| `withdraw` 怎么付钱 | `transfer`（2,300 gas stipend） | **`call{value}` + 检查返回值** | 这条链上有意义的账户**全是合约**（agent 是程序，不是人）。2,300 gas 连一个 `SSTORE` 都不够，照抄 WETH9 等于让大多数 agent 取不出钱。`call` 严格更宽松：凡是 `transfer` 能成功的，这里都能成功。先扣余额再外呼（checks-effects-interactions），重入只能花掉自己剩下的那部分，测试里有一条专门打这个 |

其余**逐条对齐 WETH9**，因为 Uniswap-V2 式的 router 和 pair 依赖这些细节：
`approve` 是直接覆盖（不需要先清零）；`transferFrom` 里 `src == msg.sender` 跳过额度检查；
**`allowance == type(uint256).max` 视为无限额度、不扣减**；没有 `dst != address(0)` 检查（WETH9 也没有）；
`totalSupply()` 直接返回 `address(this).balance`，不维护计数器，所以「每一枚 WBAC 背后都有一枚原生 BAC」
是任何人都能自己读出来的，不需要相信谁。

**不变量（写进 `contracts/test/WBAC.t.sol`）**

- W1：构造后 slot 0..15 全零，`address(this).balance == 0`，`totalSupply() == 0`（创世纪律）；
- W2：`totalSupply() == address(this).balance`，且等于所有 `balanceOf` 之和（模糊测试）；
- W3：无限额度调用任意多次后 `allowance` 仍是 `type(uint256).max`；
- W4：重入 `withdraw` 拿不走超过自己余额的钱。

实测 runtime **1,807 字节**（EIP-170 还剩 22,769 字节）。

---

## 9. 部署顺序与发射前后的动作

```
① 预测 …7777 代币地址：cast create2 --ends-with 7777 --deployer $PORTAL \
     --init-code-hash 0x2f7f413fcc6c3812c665c15bd4a012e663f567d626112a81d401066fd5a771b4
   **必须**由 LAUNCHER 立刻执行 Portal.lockSalt(salt, TOKEN_TAXED_V3) 预定该地址（见下「为什么不能是可选」）
② forge script 部署链接库（CREATE2 salt 0；BacVaultUI 的字节码必须与 fly/rat 不同）
③ AgentRegistry(admin, vetoKey)
④ ChainAnchor(bridgePlaceholder…, initialCirculating = 1000e18) —— 注意 ChainAnchor 需要 bridge 地址、
   BacBridge 需要 anchor 地址：解法是先部署 ChainAnchor，构造参数里的 bridge 用 CREATE 预测值（nonce 已知），
   部署后用 cast call 核对 ChainAnchor.bridge() == 实际 BacBridge 地址，不符则整轮重来
⑤ ValidatorStaking(bacToken=预测代币 T, anchor, admin)
⑥ BacNodeFund(bacToken=预测代币 T, owner=冷钱包)
⑦ BacBridge(bacToken=预测代币 T, registry, anchor, watchdog)
⑧ ChainAnchor.setValidatorStaking(⑤)   —— 部署者一次性
⑨ 【发射前硬停】见下方「发射前必须全绿的三项」——任一项失败**绝不允许打开发射表单**
⑩ BacVaultFactory(launcher = 发射钱包地址)   ← beacon 与实现在构造函数里创建，绝不在脚本里建
⑪ 用户在 flap.sh 手工发射，salt **必须逐字等于** ① 里锁定的那个，vaultData = abi.encode(owner, BacBridge, BacNodeFund)
⑫ AgentRegistry.setVaultSink(vault)     —— 发射后才知道金库地址
⑬ 跑 00 §7.3 的硬停清单（14 项）；全过才生成创世文件
   层内创世字节码要写死的常量（决策 #17 后是四个合约）：
     · L2Bridge　　 BSC_BRIDGE = BacBridge 地址；ROTATION_SIGNER = 离线冷钥
     · FeeSplitter　FOUNDATION_PAYOUT_0 = 基金会层内收款地址；ROTATION_SIGNER = 同一把冷钥
     · 两者都必须进 `02` §3.3 的回读对拍（构造时无状态 + 字节码逐字比对）
```

**为什么 `Portal.lockSalt` 不能写成「（可选）」（attack-flap A3）：**
`bacToken` 是 `BacBridge` / `BacNodeFund` / `ValidatorStaking` **三个合约的 immutable**，值来自本地预测的 CREATE2 地址 `T`。
只要发射表单里的 salt 不是逐字同一个（flap.sh 自己挑了一个靓号 salt、页面被重开、或第三方在 ⑦ 与 ⑪ 之间占掉了那个地址），
VaultPortal 预测出的 `taxToken` 就不是 `T`，`newVault` 第 7 条当场 revert `"Bridge is bound to another token"`。
**没有任何补救路径**：三个 immutable 逼着 `BacBridge` + `BacNodeFund` + `ValidatorStaking` 重新部署，
而重部 `BacBridge` 又会让 ④ 里用 CREATE nonce 预测出来的 `ChainAnchor.bridge()` 失效、
`setValidatorStaking` 的一次性写入也已经用掉 —— **整整四个合约、一整轮部署全部作废**。
`lockSalt` 的费用在 D0 用 `cast call` 先测（`00` [待定] 7）；即便费用不可接受，也**只能**改成
「把 ⑤⑥⑦ 推迟到发射成功之后」这一种替代方案，绝不能靠「大概率没人抢」。

**发射前必须全绿的三项（步骤 ⑨，写成 `scripts/preflight_launch.sh`，任一项非零退出即停）：**
1. `BacBridge.bacToken() == BacNodeFund.bacToken() == ValidatorStaking.bacToken() == T`，
   其中 `T` 是脚本**当场重新用 `cast create2` 算出来**的地址（不是从环境变量里读的缓存值）；
2. `cast code T` 为空，且 `Portal.getTokenV8Safe(T)` revert（地址还没被占）；
3. `Portal` 上该 salt 的锁定记录属于 `LAUNCHER`（① 的结果）。

**发射前必须做的模拟（否则 `creator == LAUNCHER` 的 immutable 会把发射卡死、只能重部工厂）：**
```bash
T='(string,string,string,uint8,bytes32,uint8,address,uint256,bytes,bytes32,bytes,uint8,uint8,uint16,uint16,uint64,uint64,uint16,uint16,uint16,uint16,uint256,address,address,uint8,address,bytes)'
cast call $VP "newTokenV6WithVault($T)(address)" "$P" --from $LAUNCHER --value 0
# --from 必须是将要写进工厂 immutable 的那个确切地址
```

**`sim_launch.sh` 的硬性要求：`TAXDURATION` 与 `ANTIFARMER` 不许有默认值。**
两个字段钩子看不见、工厂管不到（§1.3），而 `taxDuration` 到期后代币会翻进 `PoolState.TaxFree`，
金库的 `receive()` 从此再也不会被调用 —— 桥池永远是 0、节点基金永远是 0，修法只有重新发射。
脚本里必须写成 `: "${TAXDURATION:?must set TAXDURATION explicitly}"`，逼调用者每次显式传值。

**发射后 5 分钟内跑 `scripts/verify_launch.py --token 0x…7777`**，硬停清单见 `00-DESIGN-SPEC.md` §7.3（14 项）；任一失败则**暂停一切宣传**。

## 10. 测试底线

**决策 #17 新增的测试底线（与下面已有的并列，一条也不能缺）：**

1. `FeeSplitter` 的 P1–P8 全部写成 Foundry 不变量测试（§11.3），其中 **P1 必须是 0 wei 误差的恒等**。
2. 余数法的 fuzz：对任意 `gross`，`toPool + toFoundation == gross` 且 `toPool == gross * 1000 / 10000`。
3. 分池的 fuzz：任意权重向量下 `Σ amount_i <= poolAccrued`，且 `poolAccrued - Σ amount_i` 完整进 `carryPool`（**不丢 wei**）。
4. 零成员纪元：没有任何见证人时整桶进 `carryPool`，**基金会余额一 wei 不增**（P7）。
5. `postAnchor` 的第 9–13 条逐条反例测试；`rows` 空数组（空纪元）必须能通过。
6. 短缺判定的边界：恰好等于容差、恰好等于 `REMIT_DUST` 两个点上**不构成短缺**；各加 1 wei 才构成。
7. 迟到归集：欠两个纪元后一次性补齐 → `shortfall` 从 `true` 回到 `false`，`claimWithheld` 可成功。
8. **不罚没的回归测试**：短缺发生前后 `stakeOf(v).staked` 完全相等，`requestUnstake` / `withdrawUnstaked` 行为不变（S8）。
9. 分奖隔离：被扣发的金额进 `withheldOf`，**其他验证者的 `rewardOf` 一 wei 不增**（S7）。
10. 四元组的见证测试：只有 `proposerIncomeRoot` 不同时，该见证人必须被计入 `disputingWeight`。


| 类别 | 必须有的断言 |
|---|---|
| 规则 005 | `receive()` 在 `call{gas: 50_000}` 下成功；冷 < 50,000、暖 < 30,000（用 `gasleft()` 差值量，不用 `--gas-report`，它会虚高） |
| 规则 010 | 每个场景后 `_assertSolvent()`；模糊/不变量测试打不破 V1/V2；`settle()` 在下游 revert 时不回滚且 V1 仍成立；`_push` 在下游回打 `receive()` 时账目仍自洽 |
| 规则 002 | `vaultDataSchema()` 的字段类型/顺序与 `abi.decode` 逐字一致；`tokenCreationPolicies()` 八条逐条断言，且每一条都能在 §1.3 的骨架里找到同名同值的判断；`factorySpecVersion() == "v2.3"`；`vaultUISchema().methods.length == 10`，第 8/9 个 `isWriteMethod == true` 且 `inputs/outputs/approvals` 三个数组长度都是 0 |
| 规则 001 | Guardian 能单独调用 `transferOwnership`；没有 `setGuardian`、没有任何开关能剥夺 Guardian |
| 规则 009 | `beacon.owner() == factory`；工厂没有 `Ownable`；实现没有 `upgradeTo`/UUPS/`selfdestruct`/任意 `delegatecall`；`initialize` 在代理和裸实现上二次调用都 revert |
| **规则 004（可执行的两条，替换旧的「ABI 里没有任何 custom error」）** | ① `grep -rn '^\s*error ' contracts/src --include='*.sol' \| grep -v '/flap/'` 必须**无输出**（覆盖我们自己写的每一个合约，含 `src/layer/*`）；② 对每个合约跑 `forge inspect <C> abi --json`，其中 `type == "error"` 的名字集合必须是白名单 `{UnsupportedChain, OnlyVaultPortal, ZeroAddress, LegacyV6ValidationHookNotImplemented}` 的**子集**，多一个就红。旧写法（「全项目 ABI 里没有任何 custom error」）**第一次运行就必然失败**：rat 的编译产物实测金库 `['UnsupportedChain']`、工厂四个全齐，来源是 `src/flap/VaultBase.sol:62`、`VaultFactoryBaseV2.sol:189/193`、`IVaultFactory.sol:22/25` —— 而 §0 明令这 14 个文件逐字复制、永不修改，唯一「修绿」的办法是改 Flap 的官方源码并因此让 BscScan 上的验证源与官方文件对不上。一个只能靠违规才能通过的门禁，实践中一定会被悄悄关掉。 |
| **发射校验钩子（A1）** | `factory.onBeforeLaunch(abi.encode(goodData))` 必须**返回 `(true, "")`**（不是「不 revert」）；九条边界逐条断言返回 `(false, 对应的双语字符串)`；并断言该函数在**任何**输入下都不 revert（fuzz） |
| 分叉测试 | 固定高度主网 fork 走一次真实 `newTokenV6WithVault`（用逐字的发射表单值）+ `dispatch{gas: 1_000_000}`；毕业后（`getTokenV8Safe(token).status == 4`）再 sell 一次，税仍进金库；另跑一次「桥绑定的是另一个代币」的场景，断言 `newVault` revert 且字符串逐字等于 `"Bridge is bound to another token / 桥绑定的是别的代币"` |
| 负面发射 | `mktBps = 8000` → `"Vault share must be exactly 100%"`；`dividendBps = 2000` → `"Holder dividend must be 0%"`；`buyTaxRate = 300` → `"Buy tax must be exactly 2%"`；非 `LAUNCHER` 发射 → `"Launcher not allowed"`；直接调 `factory.newVault` → `"Only VaultPortal / 仅限 VaultPortal 调用"` |
| 金库（新增） | 可开关的 revert `acceptRelease()`：连续 20 次 `settle()` + `retryPush()` 之后 V1 成立且 `stuck* <= balance`（V8）；`gasleft()` 不足时 `settle()` revert 而不是把钱打进 `stuck*`（A9）；`describe()` 渲染出的节点基金提取人等于 `BacNodeFund.owner()`，并在一次 `transferOwnership/acceptOwnership` 之后跟着变（A4）；取整余数永远归桥池（V11） |
| 桥（按 M4 重写） | 同一 `exitId` 二次 `claimExit` revert；同一地址同一纪元二次 `collect` revert；同一纪元内两笔不同金额的退出 `lockedWei/credits` 必须相等（B10）；**攒 5 个纪元的释放不领，再来一个新 agent 退出 → 断言它这一纪元最多只能领 `lastPot × 10%`，且分不到它锁定之前的任何一笔释放（B15）**；`settleEpoch` 跳号 revert；**veto 一个纪元后 `settleEpoch` 仍能推进，`collect` 仍可用（B16）**；`pause()` 期间 `claimExit` 仍可用、`escapeCollect` 仍可用（B19）；`pausedCumulative` 满 21 天后 `checkHalt()` 能武装（B17）；`ban` 之后 `claimExit`/`escapeCollect` 仍可用；`lockedWei == 0` 时 `claimExit` revert（不销毁积分）；**用 agent A 的身份在层内替 B 退出 → 层内就 revert（agentId 来自 L2Gate 查表）**；BSC 侧截断兜底下 `exitedCredits <= credited` 恒成立（B11） |
| 逃生 | 「中继与签名节点都永久停止」时，`escapeCollect` 能把池子按 `credited - exitedCredits` 分完，且不需要任何锚点之外的数据；**停机后再喂三笔税，最后一个 `escapeCollect` 不 revert（B12/B13）**；**cause 2/3 下 14 天内新生成的 `owed` 拿不到优先级，且可被 `sweepImmatureOwed` 降级（B18）**；**所有五条触发都必须先武装 14 天，`checkHalt()` 在同一个区块里不可能停机（attack-gate #3）** |
| 锚点 | 超发一笔 `credit` 后 `postAnchor` revert；窗口内第 8 次 `veto` revert；`disputingWeight >= agreeingWeight` 但独立地址数 < 3 时 `finalize` 仍然产出 `FINAL`（C6）；**任何人往 `L2Bridge` / FeeSink / 签名者转账之后 `postAnchor` 照样成功（C7）**；**层内零区块的纪元可以被 `postAnchor` 接受（C8）**；纪元结束后立刻 `postAnchor` → revert `"Commit window not closed"`；部署后 `lastFinalCirculating() == OPERATOR_FLOAT`（C5） |
| 验证者 | `requestUnstake` 破坏 `stake >= MIN_STAKE * nodesOf` 时 revert（S4）；同一地址的多个 `nodeIdHash` 在 `attestationResult` 里只算一次权重（S5）；`settleEpochRewards` 跳号 revert；攒 100 个纪元不可能在一个区块里抽干奖励余额 |
| 注册 | 第三方 `reissueChallenge` 不改变任何计数器（R5）；冷却期内二次 reissue revert；`epochSeed` 在 `SEED_SEAL_DELAY` 之前不可封存，封存值只能等于规范公式（R6）；没有新钱包签名时 `register` revert（R7）；`sweepForfeited` 在 `gas = 2300` 转发方式下必须失败（证明规格禁止 `transfer/send` 是有道理的），在规范实现下成功 |
| 端到端 | `artifacts/e2e/run.sh` **17 步**，结尾打印 `E2E PASSED`（在原 11 步之外新增：杀掉中继重启后无重复 `credit`；喂一个不同的 `l2BlockHash` 后 `AnchorDisputed`；两个独立进程算出字节级相同的 `l2Block(epoch)` 与 `exitRoot`；停链 30 小时后补发两个纪元（其中一个空纪元）；veto 一个纪元后把它的叶子重报进下一个纪元并成功 `claimExit`；用一个 `receive()` revert 的层内合约当 `agentWallet`，断言其他 agent 的 `credit` 照常通过） |

## 11. `FeeSplitter` @ `0x0000000000000000000000000000000000000104`（层内创世合约，决策 #17）

**它是什么：** 层内 gas 费的分账与记账合约。**它不是 coinbase，也不可能是** —— QBFT 忽略 `--miner-coinbase`，
每个区块的全部 gas 费先进提案者自己的 EOA（`docs/research/10-consensus-client.md` 附录实测）。
所以本合约**只能被动收钱**：提案者（或运营方）主动把钱转进来，合约负责**按决策 #17 的比例切分、按纪元记账、按权重派发、把差额暴露给所有人**。

**和其他创世合约一样：构造时无状态。** 没有构造参数，没有 `initialize()`，所有地址与比例都是编译期常量，
创世只放 runtime bytecode + 余额 0（`02` §3.3 的回读对拍多加这一项）。
中继地址不在本合约里另存一份，而是**每次调用时读 `L2Bridge(0x…0101).relayer()`** —— 这样中继轮换只有一处真相，`ROTATION_SIGNER` 那条冷钥通道（`00` §0.1 G12）自动覆盖本合约。

**地址占用的变更（必须同步改，别的文档已经引用过这个地址）：** `0x…0104` 原先在 `02` §6.3 里被预留给 v2 的 validator-contract 模式。
决策 #17 之后 **`0x…0104` 归 `FeeSplitter`，v2 的 QBFT 验证者集镜像合约改用 `0x…0105`**，`02` §2 与 §6.3 已同步改写。

### 11.1 外部 ABI（逐字）

```solidity
contract FeeSplitter {
    // ---- 编译期常量（创世字节码里就是这些字面量）----
    address public constant L2_BRIDGE           = 0x0000000000000000000000000000000000000101;
    address public constant FOUNDATION_PAYOUT_0 = 0x<FOUNDATION_L2_ADDR>;   // 基金会层内收款地址的初值，创世写死
    address public constant ROTATION_SIGNER     = 0x<ROTATION_SIGNER_ADDR>; // 与 L2Bridge 同一把离线冷钥
    uint64  public constant EPOCH                         = 86400;
    uint16  public constant BPS_DENOM                     = 10000;
    uint16  public constant OFFICIAL_BLOCK_VALIDATOR_BPS  = 1000;   // 官方出块 → 验证者池
    uint16  public constant VALIDATOR_BLOCK_VALIDATOR_BPS = 5000;   // 验证者出块 → 该验证者自留
    uint16  public constant MAX_POOL_MEMBERS              = 64;     // = ValidatorStaking.MAX_NODES
    uint64  public constant POOL_CLAIM_WINDOW             = 30 days;

    struct EpochFees {
        uint128 officialGross;      // 官方 proposer 转入的总额（未切分前）
        uint128 validatorRemitted;  // 阶段 2 验证者转入的「基金会那一半」的总额
        uint128 poolAccrued;        // 本纪元验证者池 = officialGross×1000/10000 + carryIn
        uint128 poolClaimed;        // 已被领走的部分
        uint128 foundationAccrued;  // 本纪元归基金会的总额（余数法算出来的）
        uint128 weightTotal;        // Σ weight_i，由中继写入
        uint64  weightsSetAt;       // 0 = 还没写权重
        uint32  memberCount;
        bool    swept;              // POOL_CLAIM_WINDOW 之后已把余额结转
    }

    // ---- 入金（两个口，谁调用决定用哪条比例）----
    function remitOfficial(uint64 epoch) external payable;    // 仅 officialProposer()
    function remitValidator(uint64 epoch) external payable;   // 仅 isProposer(msg.sender)

    // ---- 验证者池的权重（来源是 BSC 的 ValidatorStaking，由中继镜像）----
    function setEpochWeights(uint64 epoch, address[] calldata members, uint128[] calldata weights) external; // 仅 relayer，每纪元一次
    function setProposerSet(address official, address[] calldata proposers) external;                        // 仅 relayer，覆盖式

    // ---- 出金 ----
    function claimPool(uint64 epoch, address to) external returns (uint256 amount);      // 按 msg.sender 的权重领
    function sweepEpoch(uint64 epoch) external returns (uint256 carried);                // 无许可，30 天后结转
    function withdrawFoundation(address to, uint256 amount) external returns (uint256);  // 仅 foundationPayout()；amount == 0 表示全部
    function setFoundationPayout(address newPayout, uint256 nonce, bytes calldata sig) external; // 任何人可提交，只验 ROTATION_SIGNER 的 EIP-712 签名

    // ---- views ----
    function epochFees(uint64 epoch) external view returns (EpochFees memory);
    function weightOf(uint64 epoch, address who) external view returns (uint128);
    function claimedOf(uint64 epoch, address who) external view returns (uint256);
    function pendingPool(uint64 epoch, address who) external view returns (uint256);
    function remittedBy(uint64 epoch, address proposer) external view returns (uint256);
    function officialProposer() external view returns (address);
    function isProposer(address who) external view returns (bool);
    function proposerCount() external view returns (uint256);
    function proposerAt(uint256 i) external view returns (address);
    function foundationPayout() external view returns (address);
    function foundationBalance() external view returns (uint256);
    function lifetimeOfficialGross() external view returns (uint256);
    function lifetimeValidatorRemitted() external view returns (uint256);
    function lifetimePool() external view returns (uint256);
    function lifetimePoolClaimed() external view returns (uint256);
    function lifetimeFoundationAccrued() external view returns (uint256);
    function lifetimeFoundationWithdrawn() external view returns (uint256);
    function carryPool() external view returns (uint256);
    function rotationNonce() external view returns (uint256);
    function relayer() external view returns (address);   // = IL2Bridge(L2_BRIDGE).relayer()

    event OfficialRemitted(uint64 indexed epoch, address indexed from, uint256 gross,
                           uint256 toPool, uint256 toFoundation);
    event ValidatorRemitted(uint64 indexed epoch, address indexed proposer, uint256 amount,
                            uint256 impliedGross);
    event EpochWeightsSet(uint64 indexed epoch, uint32 memberCount, uint128 weightTotal,
                          uint256 poolAccrued, uint256 carriedIn);
    event ProposerSetUpdated(address indexed official, uint256 proposerCount, uint64 atBlock);
    event PoolClaimed(uint64 indexed epoch, address indexed member, address indexed to,
                      uint128 weight, uint256 amount);
    event EpochSwept(uint64 indexed epoch, uint256 carried);
    event FoundationWithdrawn(address indexed to, uint256 amount, uint256 balanceAfter);
    event FoundationPayoutRotated(address indexed from, address indexed to, uint256 nonce);
}
```

**require 字符串（双语，逐字）**

| 位置 | 条件 | reason |
|---|---|---|
| `remitOfficial` | `msg.sender == officialProposer()` | `unicode"Only the official proposer / 仅限官方出块者"` |
| `remitOfficial` / `remitValidator` | `msg.value > 0` | `unicode"Nothing to remit / 没有可归集的金额"` |
| `remitOfficial` / `remitValidator` | `epoch <= block.timestamp / EPOCH` | `unicode"Epoch is in the future / 纪元尚未开始"` |
| `remitValidator` | `isProposer(msg.sender)` | `unicode"Not a block proposer / 不是出块者"` |
| `setEpochWeights` / `setProposerSet` | `msg.sender == relayer()` | `unicode"Only relayer / 仅限中继"` |
| `setEpochWeights` | `weightsSetAt == 0` | `unicode"Weights already set / 该纪元权重已写入"` |
| `setEpochWeights` | `members.length == weights.length` | `unicode"Length mismatch / 数组长度不一致"` |
| `setEpochWeights` | `members.length <= MAX_POOL_MEMBERS` | `unicode"Too many members / 成员数超过上限"` |
| `setEpochWeights` | `epoch < block.timestamp / EPOCH` | `unicode"Epoch not ended / 纪元尚未结束"` |
| `setEpochWeights` | `weights[i] > 0` | `unicode"Zero weight member / 权重为零的成员"` |
| `setEpochWeights` | 成员不重复 | `unicode"Duplicate member / 成员重复"` |
| `claimPool` | `weightsSetAt != 0` | `unicode"Weights not set yet / 该纪元权重尚未写入"` |
| `claimPool` | `weightOf(epoch, msg.sender) > 0` | `unicode"No weight in this epoch / 该纪元没有你的权重"` |
| `claimPool` | `claimedOf(epoch, msg.sender) == 0` | `unicode"Already claimed / 已领取"` |
| `claimPool` | `to != address(0)` | `unicode"Zero recipient / 收款地址为零"` |
| `claimPool` | `block.timestamp < weightsSetAt + POOL_CLAIM_WINDOW` | `unicode"Claim window closed / 领取期限已过"` |
| `claimPool` / `withdrawFoundation` | 转账成功 | `unicode"Payout failed / 打款失败"` |
| `sweepEpoch` | `weightsSetAt != 0 && now >= weightsSetAt + POOL_CLAIM_WINDOW && !swept` | `unicode"Not sweepable yet / 还不能结转"` |
| `withdrawFoundation` | `msg.sender == foundationPayout()` | `unicode"Only the foundation payout address / 仅限基金会收款地址"` |
| `withdrawFoundation` | `amount <= foundationBalance()` | `unicode"Exceeds foundation balance / 超过基金会余额"` |
| `setFoundationPayout` | `nonce == rotationNonce() + 1` | `unicode"Bad rotation nonce / 轮换序号不对"` |
| `setFoundationPayout` | 签名恢复出 `ROTATION_SIGNER` | `unicode"Bad rotation signature / 轮换签名不对"` |

### 11.2 记账（逐字照做，这一节就是实现）

**`remitOfficial(epoch)`（阶段 1 的归集）**

```
gross        = msg.value
toPool       = gross * OFFICIAL_BLOCK_VALIDATOR_BPS / BPS_DENOM      // 10%
toFoundation = gross - toPool                                        // 余数法，零头永远落在基金会那边
f.officialGross     += gross;
f.poolAccrued       += toPool;          // 权重还没写没关系，钱先进桶
f.foundationAccrued += toFoundation;
lifetimeOfficialGross += gross; lifetimePool += toPool; lifetimeFoundationAccrued += toFoundation;
remittedBy[epoch][msg.sender] += gross;
emit OfficialRemitted(epoch, msg.sender, gross, toPool, toFoundation);
```

**`remitValidator(epoch)`（阶段 2 的归集）**

```
// 验证者只转基金会那一半，自己那一半从一开始就在自己的 EOA 里，不做无意义的来回搬运。
f.validatorRemitted += msg.value;
f.foundationAccrued += msg.value;
remittedBy[epoch][msg.sender] += msg.value;      // ← 中继读这个映射，写进锚点的 proposerIncome 行
lifetimeValidatorRemitted += msg.value; lifetimeFoundationAccrued += msg.value;
impliedGross = msg.value * BPS_DENOM / (BPS_DENOM - VALIDATOR_BLOCK_VALIDATOR_BPS);   // = ×2，仅供展示
emit ValidatorRemitted(epoch, msg.sender, msg.value, impliedGross);
```

**`impliedGross` 只是展示字段，永远不要拿它做判定。** 「应转入多少」只有一个来源：
BSC 上 `ChainAnchor.proposerIncome(epoch, P).gasIncome`，那个数是中继报的、见证人签过的（§11.4）。
本合约**不知道**、也不可能知道某个 proposer 这一纪元真实收了多少 gas —— EVM 里没有任何 API 能让合约枚举历史区块的 coinbase 收入。
**这句必须留在规格里**，否则实现者会尝试在 `remitValidator` 里「校验金额是否正确」，写出一个必然错的检查。

**`setEpochWeights(epoch, members, weights)`（中继镜像 BSC 的见证结果）**

```
require(msg.sender == relayer()); require(weightsSetAt == 0); require(epoch 已结束); 长度/上限/去重检查;
carriedIn = carryPool; carryPool = 0;
f.poolAccrued += carriedIn;                          // 上一轮没领完 / 取整剩下的，滚进来
weightTotal = 0;
for i in 0..members.length-1:
    weightOf[epoch][members[i]] = weights[i];
    weightTotal += weights[i];
f.weightTotal = weightTotal; f.memberCount = members.length; f.weightsSetAt = block.timestamp;
if (members.length == 0) { carryPool += f.poolAccrued - f.poolClaimed; f.swept = true; }   // 零见证纪元：整桶结转
emit EpochWeightsSet(epoch, memberCount, weightTotal, f.poolAccrued, carriedIn);
```

**`weights[i]` 的规范定义（三处实现必须一致：中继 / `@bac/node-cli` / 索引器）**

```
weights[i] = stakeOf(v_i).staked  ×  attend30(v_i, epoch)
  members  = 在 ValidatorStaking 里对该纪元的 FINAL 锚点报出了一致四元组（agreeing）的验证者地址，按地址去重
  attend30 = 在 [epoch-29, epoch] 这 30 个纪元里该地址 agreeing 的纪元个数，取值 1..30
  硬门槛   = 本纪元必须 agreeing，否则根本不在 members 里（attend30 >= 1 因此自动成立）
  单位     = wei × 次，只用作比例；所有人出勤相同时与「质押 : 质押」的比例完全一致
```

`attend30` 就是「出勤」那一项：它让连续在线的人比偶尔冒泡的人多拿，而不引入任何新的可罚没状态。
**上限与去重跟 `ValidatorStaking` 完全一致**：按地址、每地址一次、纯线性、无 cap
（`MAX_VALIDATOR_SHARE_BPS` 只约束 BSC 侧的 BNB 奖励，**绝不进这里**）。

**`claimPool(epoch, to)`（`nonReentrant` + CEI）**

```
w      = weightOf[epoch][msg.sender];
amount = uint256(f.poolAccrued) * w / f.weightTotal;   // 向下取整，余数留在桶里
claimedOf[epoch][msg.sender] = amount;                 // 先写状态
f.poolClaimed += amount; lifetimePoolClaimed += amount;
(ok,) = to.call{value: amount}("");  require(ok, unicode"Payout failed / 打款失败");
emit PoolClaimed(epoch, msg.sender, to, w, amount);
```

`to` 可以是任何层内地址；拿到的是**层内 BAC**，要换 BNB 走和 agent 完全一样的
`L2Bridge.exit()` → 锚点 → `BacBridge.claimExit` → `collect`，**本合约不提供任何跨链出口，也不承诺任何兑付金额**。

**`sweepEpoch(epoch)`（无许可）**：`carried = f.poolAccrued - f.poolClaimed; carryPool += carried; f.swept = true;`
取整余数和过期未领的钱**一律回到验证者池**（结转到下一个被赋权重的纪元），**绝不进基金会**。

**`withdrawFoundation(to, amount)`**：`amount == 0` 表示全部；
`foundationBalance() = lifetimeFoundationAccrued - lifetimeFoundationWithdrawn`；CEI + `nonReentrant`；事件必带 `balanceAfter`。
基金会**没有任何路径**能碰 `poolAccrued - poolClaimed` 或 `carryPool`。

**`setProposerSet(official, proposers)`**：中继覆盖式写入「谁是官方出块者、谁是已获资格的验证者出块者」。
数据源是 BSC 的 `ValidatorStaking.proposerRights(v)` 与 `proposerAddressOf(v)`（§11.5）。
**本合约不做任何资格判断**，它只是一张镜像表，作用是给 `remitValidator` 一个 O(1) 的入口门禁。
镜像表被中继写错的最坏后果是「某个地址能/不能调 `remitValidator`」，**动不了任何已入账的钱**（不变量 P4/P5）。

### 11.3 不变量（写进 Foundry 不变量测试）

| Id | 不变量 |
|---|---|
| P1 | `address(this).balance == Σ_e (poolAccrued_e − poolClaimed_e) + carryPool + (lifetimeFoundationAccrued − lifetimeFoundationWithdrawn)`，**恒等，误差 0 wei** |
| P2 | 对**每一笔** `remitOfficial`：`toPool + toFoundation == gross`（余数法，永不丢 wei） |
| P3 | 任意纪元 `Σ_i claimedOf(epoch, i) <= poolAccrued_e`；单个成员每纪元最多领一次 |
| P4 | **没有任何路径能让 `foundationPayout()`、`relayer()` 或任何 proposer 取走验证者池的钱**；也没有任何路径能让池子成员取走 `foundationAccrued` |
| P5 | `relayer()` 能做的全部事情是：每纪元写一次权重、覆盖镜像 proposer 表。**它不能转走一 wei**，也不能改已写入的权重 |
| P6 | 构造时无状态：没有构造参数、没有 `initialize()`；部署后 `epochFees(任意纪元)` 全 0、`carryPool == 0`、`balance == 0` |
| P7 | 零成员纪元（没有任何见证人）：`poolAccrued` 整桶进 `carryPool`，**一 wei 都不会落到基金会** |
| P8 | `foundationPayout()` 的轮换只可能由 `ROTATION_SIGNER` 的离线签名触发，**不经过 relayer、不经过任何 proposer** |

### 11.4 `ChainAnchor` 的增补（§6 的补丁，决策 #17）

**锚点结构新增四个定长字段（仍然 O(1)，不随 agent 数增长）：**

```solidity
struct Anchor {
    bytes32 exitRoot;
    bytes32 proposerIncomeRoot;   // ← 新增：keccak256(abi.encode(rows))，rows 见下
    bytes32 l2BlockHash;
    uint64  l2Block;
    uint64  postedAt;
    uint64  finalizedAt;
    uint128 creditedInEpoch;
    uint128 exitCreditsInEpoch;
    uint128 feeBurnedInEpoch;
    uint128 gasFeesInEpoch;       // ← 新增：该纪元全部区块的 gas 费总额（= Σ rows[i].gasIncome）
    uint128 remittedInEpoch;      // ← 新增：该纪元已转入 FeeSplitter 的总额（= Σ rows[i].remitted）
    uint128 circulating;
    uint32  exitCount;
    uint32  proposerCount;        // ← 新增：rows.length
    uint32  agreeingCount;
    State   state;
}

struct ProposerIncome {
    address proposer;     // 层内出块者地址
    uint128 gasIncome;    // 该纪元它出的块里 gas 费的总额（层内 BAC）
    uint128 remitted;     // 截至 l2Block(epoch) 它为「这个纪元」转进 FeeSplitter 的金额
    uint32  blocks;       // 它在该纪元出了多少个块（展示 + 交叉核对用）
    bool    official;     // 它是不是官方出块者
}
```

**`postAnchor` 的签名改为** `postAnchor(uint64 epoch, Anchor calldata a, ProposerIncome[] calldata rows)`，
并在 §6.2 的检查表后面**追加四条**（`rows.length <= MAX_PROPOSERS = 64`，有界，calldata 上限约 3 KB）：

| # | 检查 | require 字符串 |
|---|---|---|
| 9 | `rows.length == a.proposerCount && rows.length <= MAX_PROPOSERS` | `unicode"Too many proposers / 出块者数量超过上限"` |
| 10 | `keccak256(abi.encode(rows)) == a.proposerIncomeRoot` | `unicode"Proposer income root mismatch / 出块收入根不匹配"` |
| 11 | `Σ rows[i].gasIncome == a.gasFeesInEpoch` 且 `Σ rows[i].remitted == a.remittedInEpoch` | `unicode"Proposer totals mismatch / 出块收入合计不一致"` |
| 12 | `rows[i].proposer` 严格递增（按地址升序且不重复） | `unicode"Proposers must be sorted and unique / 出块者必须升序且不重复"` |
| 13 | 对每一行 `rows[i].remitted <= rows[i].gasIncome` | `unicode"Remitted exceeds income / 归集额超过收入"` |

`postAnchor` 把每一行写进 `proposerIncome[epoch][proposer]` 与 `proposersOf(epoch)`，
并在 `finalize(epoch)` 判定为 `FINAL` 时累加 `cumulativeGasFees += a.gasFeesInEpoch; cumulativeRemitted += a.remittedInEpoch;`。
**被 `VETOED` / `DISPUTED` 的纪元的 `gasFeesInEpoch` / `remittedInEpoch` 与全部 rows，和其它计数字段一样，由中继并入下一个纪元的锚点重报**（§6.2 既有规则）。
空纪元（层内零区块）的规范形状追加两条：`proposerCount == 0 && proposerIncomeRoot == keccak256(abi.encode(new ProposerIncome[](0))) && gasFeesInEpoch == 0 && remittedInEpoch == 0`。

**新增 view：**

```solidity
function proposerIncome(uint64 epoch, address proposer) external view returns (ProposerIncome memory);
function proposersOf(uint64 epoch) external view returns (address[] memory);
function cumulativeGasFees() external view returns (uint256);
function cumulativeRemitted() external view returns (uint256);
```

**新增事件：** `event ProposerIncomePosted(uint64 indexed epoch, address indexed proposer, uint128 gasIncome, uint128 remitted, uint32 blocks, bool official);`（每行一条，索引器直接消费）。

**见证人的承诺/揭示改成四元组**（`01` §7、`02` §7.3、`03` §1.3 三处同步改）：

```
commitment = keccak256(abi.encode(epoch, exitRoot, proposerIncomeRoot, l2BlockHash, l2Block, salt, msg.sender))
attestationResult(epoch, exitRoot, proposerIncomeRoot, l2BlockHash, l2Block)
    → (agreeingWeight, disputingWeight, agreeingCount, disputingCount)
```

**为什么必须把 `proposerIncomeRoot` 放进见证范围（不是可选）：** 短缺判定读的是中继报的 `gasIncome`。
如果它不在见证范围里，中继（与官方出块节点同一个信任域，`00` §2 第一行）可以随手把官方自己的 `gasIncome` 报小，
于是「已收 / 已转入 / 差额」三个数里最关键的那个变成了被监管者自己填的成绩单。
`gasIncome` 与 `remitted` 都能被任何独立全节点逐块重算（`03` §1.3 给出逐字算法），
所以让见证人签它**不增加任何新的数据可得性假设**，只是把已有的数据用起来。

**不变量增补：**
`C9`：`cumulativeRemitted <= cumulativeGasFees`；
`C10`：`proposerIncome(epoch, p).remitted <= proposerIncome(epoch, p).gasIncome`（逐行成立，由检查 13 保证）；
`C11`：`ChainAnchor` 仍然**不持有任何资金**（C1 不变），本节新增的全部字段都只是记账信息，不参与任何熔断。

### 11.5 `ValidatorStaking` 的增补（§7 的补丁，决策 #17）

```solidity
    // ---- 新增常量 ----
    uint16  public constant VALIDATOR_BLOCK_VALIDATOR_BPS = 5000;   // 与 FeeSplitter 逐字相同
    uint16  public constant REMIT_TOLERANCE_BPS           = 50;     // 0.5%
    uint256 public constant REMIT_DUST                    = 0.05e18;
    uint8   public constant REMIT_GRACE_EPOCHS            = 2;
    uint16  public constant PROPOSER_QUALIFY_EPOCHS       = 30;

    // ---- 新增写方法 ----
    function setLayerAddresses(bytes32 nodeIdHash, address proposerAddr, address layerPayout) external;
    //   仅该 nodeIdHash 的 validator；proposerAddr 必须全局唯一
    //   （require(ownerOfProposer(proposerAddr) == address(0) || == msg.sender,
    //     unicode"Proposer address taken / 该出块地址已被占用")）
    //   layerPayout 只是展示用（告诉网站这个人在层内用哪个地址领池子），合约不依赖它
    function settleRemittance(uint64 epoch) external;   // 无许可，必须按序：epoch == lastRemitEpoch + 1
    function claimWithheld(address to) external returns (uint256);   // 补齐欠款（arrears == 0）之后可领

    // ---- 新增 views ----
    function proposerRights(address v) external view returns (bool);
    function proposerAddressOf(address v) external view returns (address);
    function ownerOfProposer(address proposerAddr) external view returns (address);
    function qualifyStreak(address v) external view returns (uint16);
    function remitStatus(address v) external view
        returns (uint256 cumOwed, uint256 cumRemitted, uint256 arrears, bool shortfall);
    function withheldOf(address v) external view returns (uint256);
    function lastRemitEpoch() external view returns (uint64);

    // ---- 新增事件 ----
    event LayerAddressesSet(bytes32 indexed nodeIdHash, address indexed validator,
                            address proposerAddr, address layerPayout);
    event RemittanceSettled(uint64 indexed epoch, address indexed validator,
                            uint256 owed, uint256 remitted, uint256 cumOwed, uint256 cumRemitted);
    event RemittanceShortfall(address indexed validator, uint64 indexed epoch,
                              uint256 cumOwed, uint256 cumRemitted, uint256 arrears);
    event RemittanceCleared(address indexed validator, uint64 indexed epoch, uint256 cumRemitted);
    event RewardWithheld(uint64 indexed epoch, address indexed validator, uint256 amount, uint256 arrears);
    event WithheldClaimed(address indexed validator, address indexed to, uint256 amount);
    event ProposerRightsGranted(address indexed validator, address proposerAddr, uint64 epoch);
    event ProposerRightsRevoked(address indexed validator, uint64 epoch, uint256 arrears);
```

**`settleRemittance(epoch)` 的逐字算法**

```
require(epoch == lastRemitEpoch + 1,   unicode"Epochs must be sequential / 纪元必须连续");
require(epoch + REMIT_GRACE_EPOCHS <= IChainAnchor(anchor).lastFinalEpoch(),
                                       unicode"Grace period not over / 宽限期未结束");
if (IChainAnchor(anchor).getAnchor(epoch).state != FINAL) { lastRemitEpoch = epoch; return; }  // 只推进游标

for p in IChainAnchor(anchor).proposersOf(epoch):            // 有界，<= MAX_PROPOSERS(64)
    row = IChainAnchor(anchor).proposerIncome(epoch, p);
    if (row.official) continue;            // 官方那一笔不在这里判定：没有可扣的东西（00 §3.6.4）
    v = ownerOfProposer(p);
    if (v == address(0)) continue;         // 没登记过的出块者：只留事件，不做判定
    owed = uint256(row.gasIncome) * (BPS_DENOM - VALIDATOR_BLOCK_VALIDATOR_BPS) / BPS_DENOM;   // = 50%
    cumOwed[v]     += owed;
    cumRemitted[v] += row.remitted;
    emit RemittanceSettled(epoch, v, owed, row.remitted, cumOwed[v], cumRemitted[v]);

    arrears = cumOwed[v] > cumRemitted[v] ? cumOwed[v] - cumRemitted[v] : 0;
    bool short = (cumRemitted[v] * BPS_DENOM < cumOwed[v] * (BPS_DENOM - REMIT_TOLERANCE_BPS))
              && (arrears > REMIT_DUST);                     // ← 两条同时成立才算短缺
    if (short) {
        if (shortfallSince[v] == 0) { shortfallSince[v] = epoch;
                                      emit RemittanceShortfall(v, epoch, cumOwed[v], cumRemitted[v], arrears); }
        if (proposerRights[v]) { proposerRights[v] = false; emit ProposerRightsRevoked(v, epoch, arrears); }
        qualifyStreak[v] = 0;
    } else if (shortfallSince[v] != 0) {
        shortfallSince[v] = 0; emit RemittanceCleared(v, epoch, cumRemitted[v]);
    }
lastRemitEpoch = epoch;
```

**短缺判定的精确形式（网站与 FAQ 必须逐字照抄这两行）：**

```
shortfall(v)  ⇔  cumRemitted[v] × 10000 < cumOwed[v] × 9950     并且     cumOwed[v] − cumRemitted[v] > 0.05 BAC
arrears(v)    =  max(cumOwed[v] − cumRemitted[v], 0)
```

**为什么是累计比较而不是逐纪元比较：** 归集交易可能晚到一两个纪元（机器重启、gas 不够、时钟偏差）。
逐纪元比较会把一次正常延迟判成短缺并直接撤销出块资格；累计比较让「晚交但交齐了」自动回到合规状态，
而「长期少交」无论怎么拖都躲不掉 —— `cumOwed` 只增不减。
`REMIT_GRACE_EPOCHS = 2` 是留给归集交易的时间，`REMIT_TOLERANCE_BPS = 50` 吸收的是归集交易自身的 gas 与整除零头，
`REMIT_DUST` 挡住「欠 3 wei 也算短缺」这种荒唐判定。

**扣发（不是罚没）：** `settleEpochRewards(epoch)` 在算每个地址的 pot 份额时，
若 `shortfallSince[v] != 0`，把该地址本该拿到的金额转入 `withheldOf[v]` 并 `emit RewardWithheld(...)`，
**不进 `rewardBalance`、不分给别人**（否则短缺者的钱会变成其他验证者的收入，制造举报套利）。
`claimWithheld(to)` 要求 `remitStatus(msg.sender).shortfall == false && arrears == 0`；
超过 `REWARD_CLAIM_WINDOW = 30 天`未领的 `withheldOf` 由无许可的 `sweepExpired` 退回 `rewardBalance`。

**出块资格的授予与恢复：**
`qualifyStreak[v]` 在每个 `settleRemittance` 里 +1（条件：该纪元该地址 agreeing、`strikes` 未增、无短缺），
满 `PROPOSER_QUALIFY_EPOCHS = 30` 且 `proposerAddressOf(v) != address(0)` 时
`proposerRights[v] = true` 并 `emit ProposerRightsGranted`（决策 #15 的「连续 30 个纪元在线且见证无误」）。
被撤销之后要重新拿回来：先补齐欠款让 `arrears == 0`，再重新攒满 30 个连续达标纪元。

**`proposerRights` 只是「资格」，不是「共识权」。** 把一个地址真正加进 / 踢出 QBFT 验证者集
仍然是一次人工 `qbft_proposeValidatorVote`（`02` §6.1），必须在网站公告。
这条边界要逐字写进网站的见证人页，否则「撤销出块资格」会被理解成「链上自动把它踢出共识」，而那是假的。

**不变量增补：**
`S6`：`cumOwed[v]` 与 `cumRemitted[v]` **只增不减**，没有任何 admin 路径能改它们；
`S7`：`withheldOf[v]` 里的钱**只可能**回到 `v` 自己或 `rewardBalance`，**绝不会分给别的验证者**；
`S8`：短缺的全部后果是「扣发 + 撤销资格」，**`stakeOf(v).staked` 一 wei 都不会变**（v1 不罚没，`00` §2）；
`S9`：`proposerAddressOf` 全局单射（一个层内出块地址只能属于一个 validator）。

---

## [待定]

1. `ChainAnchor` 与 `BacBridge` 的互相引用用「CREATE nonce 预测」解决（§9 ④）。可选替代：给 `ChainAnchor` 加一个部署者一次性的 `setBridge`。**倾向于预测**（少一个受信步骤），但要在 D1 用 anvil 实测一遍预测是否稳定。
2. `AgentRegistry.vaultSink` 必须是「部署者一次性设置」（金库在发射时才存在）。这是全项目**唯一**一个受信的一次性写入；替代方案是让 `sweepForfeited()` 每次都从 `VaultPortal.tryGetVault(bacToken)` 现读（多一次外部调用，但零受信步骤）。**倾向于现读**，待定。
5. `Portal.lockSalt` 的实际费用（D0 用 `cast call` 实测）。它现在是 §9 ① 的**必做**步骤，不再是可选项；如果费用高到不可接受，唯一的替代路径是把 ⑤⑥⑦ 推迟到发射成功之后再部署（三个 `bacToken` immutable 届时是已知值，不再需要预测）。
6. `VETO_LIMIT_PER_WINDOW` / `DISPUTE_LIMIT_PER_WINDOW` 的滑动窗口长度定为 30 个纪元（位图 `uint32`）。窗口越长越难用「周期性 veto」绕过，但也越容易被一次偶发的诚实否决序列推到武装期。30 是按「`HALT_TIMEOUT = 90 天` 的三分之一」取的，D2 用不变量测试扫一遍再定。
3. `ENTRY_DEPOSIT` 用 BNB（0.02）还是用 BAC（例如 100,000）。用 BNB 的好处是没收后直接进金库按 50/50 分掉、不破坏 1:1 backing；用 BAC 的好处是入场即锁仓。本文按 BNB 写。
4. 买卖税 `== 200`（2%/2%）待用户确认；改动会波及 hook / policies / 手册 / `sim_launch.sh` / `verify_launch.py` / fork 常量六处。
5. `description()` / `vaultDataSchema().description` / 页脚第一行的最终中文措辞需用户逐字批准（部署即冻结）。
6. ERC-8004 的最终函数签名与 registration JSON 字段需在写码前对照 https://eips.ethereum.org/EIPS/eip-8004 原文核一遍（`06` 明说是凭记忆写的）。
