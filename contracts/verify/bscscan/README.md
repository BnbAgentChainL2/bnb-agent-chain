# BscScan 源码验证 / BscScan source verification

> **不要运行本文件里任何 `verify-contract` 命令，除非用户明确说「发」。**
> **Do NOT run any `verify-contract` command here without the user's explicit go-ahead.**
> 验证会把源码公开发布，且不可撤回。本目录里的 JSON 是**离线生成**的编译器输入，生成它们不碰网络。

> **本目录现有的 4 个 `*.json` 已过期，上传前必须重新生成（第 4 节）。**
> 它们生成于 v2 改造之前：`9-BacBridge.json` 还是旧的「不可升级、4 个构造参数」版本，
> 其余三个的源码此后也改过（注释与 NatSpec 也算字节）。**等最终一次 `forge build` 之后**，
> 按第 4 节把全部文件重新生成一遍，再去上传。缺的 `10-` `11-` `12-` 也在那一步生成。
> The four JSON files here predate the v2 rewrite and are stale. Regenerate all of them
> (section 4) after the final build, and only then upload.

本目录的 `*.json` 是 Solidity **Standard-Json-Input**，即 BscScan 手工验证接受的那种形状
（`language` / `sources` / `settings`，`settings` 带 `remappings` `optimizer` `metadata`
`outputSelection` `evmVersion` `viaIR` `libraries`）。

编译设置全部来自 `contracts/foundry.toml`，与生产部署逐字一致：

| 项 | 值 |
|---|---|
| 编译器 | `v0.8.26+commit.8a97fa7a` |
| optimizer | enabled，`runs = 200` |
| viaIR | `true` |
| evmVersion | `cancun` |
| bytecodeHash | `ipfs`（`appendCBOR: true`） |
| License | MIT |

决策 #30 删掉了金库工厂、金库实现、`BacVaultUI` 库和 beacon；决策 #31 删掉了我们自己的
`AgentRegistry`。**这些合约一个都不会部署，也就没有东西要验证**，旧的 `1-` `2-` `3-` `4-` `5-` `10-BeaconProxy`
已从本目录删除。现在**没有任何链接库**，所有 JSON 的 `settings.libraries` 都应为空。

---

## 0. 文件与对应的合约

部署顺序见 `script/DeployBac.s.sol`（`docs/01-CONTRACT-SPEC.md` §9）。

| 文件 | 合约 | 部署方式 | 构造参数 |
|---|---|---|---|
| `6-ChainAnchor.json` | `src/ChainAnchor.sol:ChainAnchor` | forge script，部署者 CREATE（nonce n） | `abi.encode(address bridgeProxy, address relayer, address admin, address vetoKey, uint128 initialCirculating)` |
| `7-ValidatorStaking.json` | `src/ValidatorStaking.sol:ValidatorStaking` | forge script（n+1） | `abi.encode(address bacToken, address anchor, address admin)` |
| `8-BacNodeFund.json` | `src/BacNodeFund.sol:BacNodeFund` | forge script（n+2） | `abi.encode(address bacToken, address owner)` |
| `9-BacBridge.json` | `src/BacBridge.sol:BacBridge`（**实现合约**） | forge script（n+3） | **无** |
| `10-BacBridgeExtension.json` | `src/BacBridge.sol:BacBridgeExtension` | **由 `BacBridge` 实现的构造函数创建**（用实现合约自己的 nonce） | **无** |
| `11-ERC1967Proxy.json` | OZ `ERC1967Proxy`（**桥的地址 = 这个代理**） | forge script（n+4） | `abi.encode(address implementation, bytes initializeCalldata)` |
| `12-BacTaxRouter.json` | `src/BacTaxRouter.sol:BacTaxRouter` | forge script（n+6） | `abi.encode(address bacToken, address bridgeProxy, address nodeFund)` |

合约地址**不在** JSON 里；JSON 只是编译器输入。地址在上传页面上填。
所有地址都从 `forge script` 输出里的 `bac.*=` 行或 `BAC_DEPLOY_JSON` 那一行复制：
`bac.bacBridge`（代理）、`bac.bacBridgeImplementation`、`bac.bacBridgeExtension`。

### 桥是代理：三个地址，验三次

- **`bac.bacBridge` 是代理**，也是中继、索引器、网站、SDK、`ChainAnchor`、`BacTaxRouter` 里唯一应该出现的桥地址。
- **`bac.bacBridgeImplementation` 是实现**。它的存储永远是空的（构造函数里 `_disableInitializers()`），
  直接读它的 `bacToken()` 会得到 `0x0`——别把这个地址贴到任何地方。
- **`bac.bacBridgeExtension` 是扩展**。实现合约放不下 EIP-170 的 24,576 字节，冷门路径
  （owner 紧急提取、`setAgentController`、看门狗工具、停机逃生）搬到了这里，由实现 `delegatecall`。
  它拒绝被直接调用，也拒绝被设成代理的实现。它的地址由实现合约的 nonce 决定，**每次升级都会换一个新的**。

验证顺序：**先实现，再扩展，最后代理**。代理验完后，在 BscScan 代理地址页面
**Contract → More Options → Is this a proxy? → Verify**，BscScan 会读 EIP-1967 实现槽，
把「Read as Proxy / Write as Proxy」挂到实现合约的 ABI 上。
`ERC1967Proxy` 的字节码通常会被 BscScan 自动识别为「Similar Match」，识别到了就不用再传 `11-`。

**每一次升级之后都要重做**：新实现合约 + 它的新扩展合约各验一次，再在代理页面上重新点一次
「Is this a proxy?」。项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。
（决策 #29a）——验证是让人能**看见**升级后跑的是什么代码的唯一办法。

## 1. 链接库

**没有。** `BacVaultUI` 随决策 #30 删除；`src/lib/Erc8004Gate.sol` 是 `internal` 库，编译时内联进
`BacBridge`，不单独部署、不链接。重新生成后如果任何 JSON 的 `settings.libraries` 不为空，说明源码不对，停下来查。

## 2. 手工上传（不需要 API key，推荐）

BscScan 合约页 → **Verify and Publish** →
Compiler Type **Solidity (Standard-Json-Input)** →
Compiler **v0.8.26+commit.8a97fa7a** →
License **MIT** → 上传对应的 JSON → 需要构造参数的再填。

需要填「Constructor Arguments ABI-encoded（不带 `0x`）」的只有下面这些。命令只做本地 ABI 编码，不上链：

```bash
cd "D:/CLAUDE DODODODODOODODODODODODOODODO/Agent CHAIN/contracts"
# 这些值从 forge script 的输出 / 广播日志里复制，不要手打
TOKEN=0x...  ANCHOR=0x...  STAKING=0x...  NODEFUND=0x...  ROUTER=0x...
BRIDGE=0x...            # bac.bacBridge            —— 代理
IMPL=0x...              # bac.bacBridgeImplementation
OWNER=0x... ADMIN=0x... VETO=0x... RELAYER=0x... WATCHDOG=0x... FUNDOWNER=0x...
REGISTRY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432     # ERC-8004 Identity Registry (BSC)
PORTAL=0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0       # Flap Portal
PANCAKE=0x10ED43C718714eb63d5aA57B78B54704E256024E      # PancakeSwap V2 router

cast abi-encode 'constructor(address,address,address,address,uint128)' \
     $BRIDGE $RELAYER $ADMIN $VETO 1000000000000000000000                          # 6-ChainAnchor
cast abi-encode 'constructor(address,address,address)' $TOKEN $ANCHOR $ADMIN       # 7-ValidatorStaking
cast abi-encode 'constructor(address,address)' $TOKEN $FUNDOWNER                   # 8-BacNodeFund
                                                                                   # 9-BacBridge：无
                                                                                   # 10-BacBridgeExtension：无
# 11-ERC1967Proxy：实现地址 + initialize 的 calldata（与 DeployBac.s.sol 逐字一致，7 个参数，顺序不能换）
INIT=$(cast calldata 'initialize(address,address,address,address,address,address,address)' \
       $OWNER $TOKEN $REGISTRY $ANCHOR $WATCHDOG $PORTAL $PANCAKE)
cast abi-encode 'constructor(address,bytes)' $IMPL $INIT
cast abi-encode 'constructor(address,address,address)' $TOKEN $BRIDGE $NODEFUND    # 12-BacTaxRouter
```

更稳的做法：不要自己拼，直接从广播日志里拿部署交易的构造参数——
`broadcast/DeployBac.s.sol/56/run-latest.json` 里每笔 `CREATE` 的 `transaction.input`
去掉创建码前缀之后就是构造参数；`ERC1967Proxy` 那一笔里就有 forge 实际发出去的 `INIT`。

## 3. 用 forge 提交（需要 Etherscan V2 API key；同样只在用户说「发」之后）

```bash
export ETHERSCAN_API_KEY=<key>      # 只在 shell 里敲，不要写进任何文件
cd "D:/CLAUDE DODODODODOODODODODODODOODODO/Agent CHAIN/contracts"
EXT=0x...   # bac.bacBridgeExtension

forge verify-contract $ANCHOR   src/ChainAnchor.sol:ChainAnchor            --chain 56 --watch \
  --constructor-args $(cast abi-encode 'constructor(address,address,address,address,uint128)' $BRIDGE $RELAYER $ADMIN $VETO 1000000000000000000000)
forge verify-contract $STAKING  src/ValidatorStaking.sol:ValidatorStaking  --chain 56 --watch \
  --constructor-args $(cast abi-encode 'constructor(address,address,address)' $TOKEN $ANCHOR $ADMIN)
forge verify-contract $NODEFUND src/BacNodeFund.sol:BacNodeFund            --chain 56 --watch \
  --constructor-args $(cast abi-encode 'constructor(address,address)' $TOKEN $FUNDOWNER)
forge verify-contract $IMPL     src/BacBridge.sol:BacBridge                --chain 56 --watch
forge verify-contract $EXT      src/BacBridge.sol:BacBridgeExtension       --chain 56 --watch
forge verify-contract $BRIDGE   lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy \
  --chain 56 --watch --constructor-args $(cast abi-encode 'constructor(address,bytes)' $IMPL $INIT)
forge verify-contract $ROUTER   src/BacTaxRouter.sol:BacTaxRouter          --chain 56 --watch \
  --constructor-args $(cast abi-encode 'constructor(address,address,address)' $TOKEN $BRIDGE $NODEFUND)
```

Sourcify（不需要 key）把上面每条的 `--watch` 换成 `--verifier sourcify`，
结果在 `https://repo.sourcify.dev/contracts/full_match/56/<address>/`。
然后别忘了第 0 节的「Is this a proxy?」。

## 4. 重新生成本目录（**最终 build 之后必须做一次**；源码一变就要再做）

```bash
cd "D:/CLAUDE DODODODODOODODODODODODOODODO/Agent CHAIN/contracts"
A=0x0000000000000000000000000000000000000001   # 占位地址；JSON 里不含地址

forge verify-contract $A src/ChainAnchor.sol:ChainAnchor --chain 56 --show-standard-json-input > verify/bscscan/6-ChainAnchor.json
forge verify-contract $A src/ValidatorStaking.sol:ValidatorStaking --chain 56 --show-standard-json-input > verify/bscscan/7-ValidatorStaking.json
forge verify-contract $A src/BacNodeFund.sol:BacNodeFund --chain 56 --show-standard-json-input > verify/bscscan/8-BacNodeFund.json
forge verify-contract $A src/BacBridge.sol:BacBridge --chain 56 --show-standard-json-input > verify/bscscan/9-BacBridge.json
forge verify-contract $A src/BacBridge.sol:BacBridgeExtension --chain 56 --show-standard-json-input > verify/bscscan/10-BacBridgeExtension.json
forge verify-contract $A lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy --chain 56 --show-standard-json-input > verify/bscscan/11-ERC1967Proxy.json
forge verify-contract $A src/BacTaxRouter.sol:BacTaxRouter --chain 56 --show-standard-json-input > verify/bscscan/12-BacTaxRouter.json
```

`--show-standard-json-input` 只打印编译器输入，不联网、不提交。
`9-` 和 `10-` 的 `sources` 相同（同一个 `src/BacBridge.sol`），上传时区别只在「合约名」一栏。

## 5. 注意事项

- `src/flap/*.sol` 这 14 个文件与 Flap 上游逐字一致，会原样出现在 `sources` 里。**永远不要**对它们跑
  `forge fmt`：格式一改，字节就不一样，BscScan 上的源码与官方文件对不上。
- `ChainAnchor` 的第一个参数和 `BacTaxRouter` 的第二个参数都是**桥的代理地址**，不是实现地址。
  实现地址填进去的话，`ChainAnchor` 读到的 `totalCreditsIssued()` 永远是 0，`BacTaxRouter` 的构造函数
  本来就会拒绝（实现的 `bacToken()` 是 `0x0`）。
- `ChainAnchor` 的 `initialCirculating` 是 `uint128`，值固定为 `OPERATOR_FLOAT = 1000e18`
  （`1000000000000000000000`）。
- `BacTaxRouter` 与 `BacNodeFund` 不可升级、没有代理，验一次就是永久的；桥每升级一次就要多验两个合约。
