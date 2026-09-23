# BscScan 源码验证 / BscScan source verification

> **不要运行本文件里任何 `verify-contract` 命令，除非用户明确说「发」。**
> **Do NOT run any `verify-contract` command here without the user's explicit go-ahead.**
> 验证会把源码公开发布，且不可撤回。本目录里的 JSON 是**离线生成**的编译器输入，生成它们不碰网络。

本目录的 10 个 `*.json` 是 Solidity **Standard-Json-Input**，即 BscScan 手工验证接受的那种形状
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

生成于 2026-09-23，用 forge 1.7.1。

---

## 0. 文件与对应的合约

| 文件 | 合约 | 部署方式 | 构造参数 | 链接库 |
|---|---|---|---|---|
| `1-BacVaultUI.json` | `src/lib/BacVaultUI.sol:BacVaultUI` | forge script，CREATE2 经 `0x4e59b44847b379578588920cA78FbF26c0B4956C`，salt 0 | 无 | 无 |
| `2-BacVaultFactory.json` | `src/BacVaultFactory.sol:BacVaultFactory` | forge script，部署者 CREATE | `abi.encode(address launcher)` | BacVaultUI（嵌在金库实现的创建码里） |
| `3-BacTreasuryVault.json` | `src/BacTreasuryVault.sol:BacTreasuryVault` | **工厂构造函数里创建** | 无 | BacVaultUI |
| `4-UpgradeableBeacon.json` | OZ `UpgradeableBeacon` | **工厂构造函数里创建** | `abi.encode(address implementation)` | 无 |
| `5-AgentRegistry.json` | `src/AgentRegistry.sol:AgentRegistry` | forge script | `abi.encode(address admin, address vetoKey)` | 无 |
| `6-ChainAnchor.json` | `src/ChainAnchor.sol:ChainAnchor` | forge script | `abi.encode(address bridge, address relayer, address admin, address vetoKey, uint128 initialCirculating)` | 无 |
| `7-ValidatorStaking.json` | `src/ValidatorStaking.sol:ValidatorStaking` | forge script | `abi.encode(address bacToken, address anchor, address admin)` | 无 |
| `8-BacNodeFund.json` | `src/BacNodeFund.sol:BacNodeFund` | forge script | `abi.encode(address bacToken, address owner)` | 无 |
| `9-BacBridge.json` | `src/BacBridge.sol:BacBridge` | forge script | `abi.encode(address bacToken, address registry, address anchor, address watchdog)` | 无 |
| `10-BeaconProxy.json` | OZ `BeaconProxy`（金库代理） | **发射交易中由工厂创建** | `abi.encode(address beacon, bytes initializeCalldata)` | 无 |

合约地址**不在** JSON 里；JSON 只是编译器输入。地址在上传页面上填。

## 1. 链接库地址（**上传前必须核对**）

`2-` 和 `3-` 的 `settings.libraries` 里写着：

```
"src/lib/BacVaultUI.sol": { "BacVaultUI": "0x15317a084ab6B63A975e97ecd74caaEe8a8FB6ed" }
```

这个地址来自 2026-09-23 的 anvil 分叉演练（CREATE2、salt 0，只取决于库的字节码，所以主网上
**源码不变时地址相同**）。真部署完成后，从广播日志里读出实际地址：

```bash
python -c "import json;print(json.load(open(r'broadcast/DeployBac.s.sol/56/run-latest.json'))['libraries'])"
```

如果与上面那一行不同（只要 `src/lib/BacVaultUI.sol` 改过一个字节就会不同），
**必须重新生成 `2-` 和 `3-`**（见第 4 节），否则 BscScan 会比对失败。

## 2. 手工上传（不需要 API key，推荐）

BscScan 合约页 → **Verify and Publish** →
Compiler Type **Solidity (Standard-Json-Input)** →
Compiler **v0.8.26+commit.8a97fa7a** →
License **MIT** → 上传对应的 JSON → 需要构造参数的再填。

需要填「Constructor Arguments ABI-encoded（不带 `0x`）」的只有下面这些。命令只做本地 ABI 编码，不上链：

```bash
cd "D:/CLAUDE DODODODODOODODODODODODOODODO/Agent CHAIN/contracts"
# 这些值从 forge script 的输出 / 广播日志里复制，不要手打
FACTORY=0x...   BEACON=0x...   IMPL=0x...   VAULT=0x...
REGISTRY=0x...  ANCHOR=0x...   STAKING=0x... NODEFUND=0x... BRIDGE=0x... TOKEN=0x...
ADMIN=0x... VETO=0x... RELAYER=0x... WATCHDOG=0x... FUNDOWNER=0x... LAUNCHER=0x... VAULTOWNER=0x...

cast abi-encode 'constructor(address)' $LAUNCHER                                   # 2-BacVaultFactory
cast abi-encode 'constructor(address)' $IMPL                                       # 4-UpgradeableBeacon
cast abi-encode 'constructor(address,address)' $ADMIN $VETO                        # 5-AgentRegistry
cast abi-encode 'constructor(address,address,address,address,uint128)' \
     $BRIDGE $RELAYER $ADMIN $VETO 1000000000000000000000                          # 6-ChainAnchor
cast abi-encode 'constructor(address,address,address)' $TOKEN $ANCHOR $ADMIN       # 7-ValidatorStaking
cast abi-encode 'constructor(address,address)' $TOKEN $FUNDOWNER                   # 8-BacNodeFund
cast abi-encode 'constructor(address,address,address,address)' \
     $TOKEN $REGISTRY $ANCHOR $WATCHDOG                                            # 9-BacBridge

# 10-BeaconProxy（金库代理，发射之后才存在）
INIT=$(cast calldata 'initialize(address,address,address,address)' $TOKEN $VAULTOWNER $BRIDGE $NODEFUND)
cast abi-encode 'constructor(address,bytes)' $BEACON $INIT
```

`3-BacTreasuryVault`（实现）和 `1-BacVaultUI`（库）**没有构造参数**，留空。

`$VAULTOWNER` 必须是**发射当时**的 owner：工厂 `BacTreasuryVaultCreated` 事件里的 `owner` 字段
（vaultData 里填了 `0x0` 时它等于发射钱包）。

## 3. 用 forge 提交（需要 Etherscan V2 API key；同样只在用户说「发」之后）

```bash
export ETHERSCAN_API_KEY=<key>      # 只在 shell 里敲，不要写进任何文件
cd "D:/CLAUDE DODODODODOODODODODODODOODODO/Agent CHAIN/contracts"
UI=0x<BacVaultUI>
LIBS="--libraries src/lib/BacVaultUI.sol:BacVaultUI:$UI"

forge verify-contract $UI       src/lib/BacVaultUI.sol:BacVaultUI          --chain 56 --watch
forge verify-contract $FACTORY  src/BacVaultFactory.sol:BacVaultFactory    --chain 56 --watch $LIBS \
  --constructor-args $(cast abi-encode 'constructor(address)' $LAUNCHER)
forge verify-contract $IMPL     src/BacTreasuryVault.sol:BacTreasuryVault  --chain 56 --watch $LIBS
forge verify-contract $BEACON   lib/openzeppelin-contracts/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon \
  --chain 56 --watch --constructor-args $(cast abi-encode 'constructor(address)' $IMPL)
forge verify-contract $REGISTRY src/AgentRegistry.sol:AgentRegistry        --chain 56 --watch \
  --constructor-args $(cast abi-encode 'constructor(address,address)' $ADMIN $VETO)
forge verify-contract $ANCHOR   src/ChainAnchor.sol:ChainAnchor            --chain 56 --watch \
  --constructor-args $(cast abi-encode 'constructor(address,address,address,address,uint128)' $BRIDGE $RELAYER $ADMIN $VETO 1000000000000000000000)
forge verify-contract $STAKING  src/ValidatorStaking.sol:ValidatorStaking  --chain 56 --watch \
  --constructor-args $(cast abi-encode 'constructor(address,address,address)' $TOKEN $ANCHOR $ADMIN)
forge verify-contract $NODEFUND src/BacNodeFund.sol:BacNodeFund            --chain 56 --watch \
  --constructor-args $(cast abi-encode 'constructor(address,address)' $TOKEN $FUNDOWNER)
forge verify-contract $BRIDGE   src/BacBridge.sol:BacBridge                --chain 56 --watch \
  --constructor-args $(cast abi-encode 'constructor(address,address,address,address)' $TOKEN $REGISTRY $ANCHOR $WATCHDOG)
forge verify-contract $VAULT    lib/openzeppelin-contracts/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy \
  --chain 56 --watch --constructor-args $(cast abi-encode 'constructor(address,bytes)' $BEACON $INIT)
```

Sourcify（不需要 key）把上面每条的 `--watch` 换成 `--verifier sourcify`，
结果在 `https://repo.sourcify.dev/contracts/full_match/56/<address>/`。

## 4. 重新生成本目录（源码或库地址一变就要做）

```bash
cd "D:/CLAUDE DODODODODOODODODODODODOODODO/Agent CHAIN/contracts"
UI=0x<真实的 BacVaultUI 地址>
LIBS="--libraries src/lib/BacVaultUI.sol:BacVaultUI:$UI"
A=0x0000000000000000000000000000000000000001   # 占位地址；JSON 里不含地址

forge verify-contract $A src/lib/BacVaultUI.sol:BacVaultUI --chain 56 --show-standard-json-input > verify/bscscan/1-BacVaultUI.json
forge verify-contract $A src/BacVaultFactory.sol:BacVaultFactory --chain 56 $LIBS --show-standard-json-input > verify/bscscan/2-BacVaultFactory.json
forge verify-contract $A src/BacTreasuryVault.sol:BacTreasuryVault --chain 56 $LIBS --show-standard-json-input > verify/bscscan/3-BacTreasuryVault.json
forge verify-contract $A lib/openzeppelin-contracts/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon --chain 56 --show-standard-json-input > verify/bscscan/4-UpgradeableBeacon.json
forge verify-contract $A src/AgentRegistry.sol:AgentRegistry --chain 56 --show-standard-json-input > verify/bscscan/5-AgentRegistry.json
forge verify-contract $A src/ChainAnchor.sol:ChainAnchor --chain 56 --show-standard-json-input > verify/bscscan/6-ChainAnchor.json
forge verify-contract $A src/ValidatorStaking.sol:ValidatorStaking --chain 56 --show-standard-json-input > verify/bscscan/7-ValidatorStaking.json
forge verify-contract $A src/BacNodeFund.sol:BacNodeFund --chain 56 --show-standard-json-input > verify/bscscan/8-BacNodeFund.json
forge verify-contract $A src/BacBridge.sol:BacBridge --chain 56 --show-standard-json-input > verify/bscscan/9-BacBridge.json
forge verify-contract $A lib/openzeppelin-contracts/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy --chain 56 --show-standard-json-input > verify/bscscan/10-BeaconProxy.json
```

`--show-standard-json-input` 只打印编译器输入，不联网、不提交。

## 5. 注意事项

- `src/flap/*.sol` 这 14 个文件与 Flap 上游逐字一致，会原样出现在 `sources` 里。**永远不要**对它们跑
  `forge fmt`：格式一改，字节就不一样，BscScan 上的源码与官方文件对不上。
- 金库实现（`3-`）和工厂（`2-`）都要带 `--libraries`：金库的 `description()` / `vaultUISchema()`
  在运行时 `delegatecall` 这个库，工厂的创建码里嵌着金库的创建码。
- `ChainAnchor` 的 `initialCirculating` 是 `uint128`，值固定为 `OPERATOR_FLOAT = 1000e18`
  （`1000000000000000000000`）。
- 验证顺序无所谓，但先验库再验工厂，BscScan 页面上的链接更好看。
