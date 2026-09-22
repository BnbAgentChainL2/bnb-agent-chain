# 评审 · Flap 合规与金库正确性（judge-flap）

2026-09-22。评审视角**只有一条**：这一对 `Factory + Vault` 放到 flap.sh 上会不会在发射那一刻 revert、会不会在 `verify_launch` 的硬停上挂掉、规则 010 的账在 50/50 加出金之后还平不平、owner 桶是不是 Flap 认的那种"常量、预先披露、不碰用户钱"的桶、Guardian 的权力是不是完整且不可剥夺、Flap 的审计员会不会给低风险徽章。其余一切（跨链安全、门禁强度、浏览器、排期）**不计分**。

依据逐行核对：`docs/research/01-flap-spec.md`（含 §8 补录）、`docs/research/02-contracts-skeleton.md`（含 §7 补录）。

---

## 0. 结论

| 方案 | 分数 | 一句话 |
|---|---|---|
| **arch-security** | **7.5** | 金库本身写得最干净、规则 010 最严、Guardian 权力最完整、owner 桶最小；但工厂的 hook 少了两道闸（`vaultBps >= 1000` + 无 `creator` 限制），这正是 某个更早的同类项目 栽过两次的那个坑。两处都是一行改动。 |
| arch-agentnative | 6.5 | hook 和 `newVault` 的闸门是三家里最硬的（`vaultBps == 10000` + `creator == LAUNCHER`），`receive()` 的 gas 目标是唯一写对的；但 `payRedemption/payValidator` 把 Guardian 关在门外，`OPS_CAP` 是存量上限不是终身上限，而且**完全没有发射后硬停清单**。 |
| arch-ship | 5.0 | `newVault` 里交叉校验桥/质押绑定的预测代币地址是整份评审里最好的一个点子；但 `OPS_BPS = 1000`（税收的 10% 归 owner）单独一条就足以毁掉低风险徽章，`receive()` 的 gas 目标自相矛盾，`pause()` 可续期而没有逃生口。 |

**赢家：arch-security**，条件是必须把下面"必须吸收"的几条从两个败者身上原样移植过来。

---

## 1. arch-security · 7.5

### 过的（逐条核对，不是复述）

* **规则 009 满分。** beacon 在构造函数里建（`beacon.owner() == factory`）、工厂无 `Ownable`、`upgradeVaultImplementation` / `lockVaultUpgrades` 只认 `_getGuardian()`、**不写 `emergencyWithdrawNative/Token`**。`[CL]:477-500` 明说 BeaconProxy 金库不需要应急函数；不写就没有 某个更早的同类项目 那个攻击面。三家都做到了，但只有这一家把"不写"的理由写对了（"规则 009 允许不写，不写就没有这个攻击面"）。
* **规则 001-d/e 满分，而且是三家里唯一的。** 全部受限函数只有 `withdrawOps(to, amount)` 和 `transferOwnership(newOwner)`，两个都是"owner 或 Guardian"（各自单独即可）；`sync()` / `settle()` / `retryPush()` 全部无许可。**没有任何一个受限函数是 Guardian 调不动的**——这一点 ship 和 agentnative 都破了。出金带 `to` 参数，对上了"主网 Guardian 是代理合约、拒收裸 BNB"（`01 §5.1`）。
* **规则 010 结构上最干净。** 一个 `uint256 _revenue`（低 128 = `accountedQuote`，高 128 = 未分账 general），不变量写死为 `accountedQuote == unsplit + opsBucket + stuckBridge + stuckValidators` 且 `balance >= accountedQuote`，出金一律"同一笔交易内在 `call{value}` 之前 `accountedQuote -= amount`"。**关键优势：金库不长期持币**，推出去之后桥池/验证者池归两个不可升级合约自己记账，所以不存在"别的合约读金库里一个懒结算的桶"这条跨合约陈旧读（ship 和 agentnative 都有，见 §2/§3）。
* **推送失败不回滚 `settle()`。** `call{value,gas:60_000}` 失败记 `stuckBridge/stuckValidators`，"仍计入 buckets 与 accounted"，无许可 `retryPush()`。这是把规则 005"永不 revert"的精神正确地外推到了出金侧。
* **`verify_launch` 硬停清单是三家里唯一完整的。** 十项：`getVault(token).vaultFactory == FACTORY` · `TaxProcessor(token.taxProcessor()).marketAddress() == vault` · `vault.taxToken() == token` · `eth_getStorageAt(vault, 0xa3f0ad74…3d50) == factory.beacon()` · `beacon.owner() == factory` · `feeConfigV2().dividendBps == 0` · `vaultQuoteToken() == 0x0` · `bridge()/validatorPayout()` 正确 · `bridge.vault() == vault && staking.vault() == vault` · `solvency()` 三数自洽。对得上 `01 §4.4` 和 `rat/artifacts/verify/launch-snapshot.json` 的形状。
* **owner 桶最小（3%），三家里唯一落在可辩护区间的那个。**
* **不用 Flap Trigger**（§10 第 8 条），规则 008 整条不适用，也就没有 `02 §7.3` 里"严格 50/50 没有桶付 `getFee()`"那个死结。

### 挂的

1. **`vaultBps < 1000` 拒绝——只有下界。** 原文：

   > `_validateBeforeLaunch` 双语拒绝：… / `vaultBps < 1000`（`"Vault share must be >= 10% / 金库份额必须 >= 10%"`）/ …

   `02-contracts-skeleton.md:105` 用整整一段写了这条的后果：**"Vault share only lower-bounded：IMFLY planned 50/20/20/10, launched 80/0/20/0; 某个更早的同类项目 launched 10000/0/0/0 … the site had to be rewritten"**，并明说 **"If the split matters, enforce `==` in hook **and** policies"**。本项目的**全部叙事**就是"每一笔税收 50% 桥池 / 50% 节点基金"。只有下界 = 发射表单里 `mktBps` 填成 5000 也能过，网站、`description()`、X 文案全部作废且无法回滚（`pure` 字符串冻结在部署那一刻）。ship 和 agentnative 都用了 `== 10000`，这一家没有。**扣 1.0。**

2. **`newVault` 不认 `creator`，也不绑代币——陌生人能用我们的工厂发射并继承我们的徽章。** 原文：

   > `newVault` 检查：`msg.sender == _getVaultPortal()`、`quoteToken == address(0)`、`bridge`/`validatorPayout` 非零且 `code.length > 0` 且两者不同、`opsOwner == 0 → creator`

   `[CL]:593-594,749`：**工厂策略默认 `OPEN`，陌生人能用我们的工厂发射**。这里只校验"有代码且不相同"，于是任何人都可以发一个币、把 `bridge` 和 `validatorPayout` 指向自己控制的两个合约、拿走 97% 的税，而这个金库的 `description()` 会照常显示我们写死的"50% 桥池 / 47% 验证者 / 3% 运维"。审计是**按工厂**做的（0.5 BNB/工厂），**代币继承工厂的风险等级**（`01 §5.4`）。一个带低风险徽章、描述与实际去向不符的金库，是规则 003 的直球。**扣 1.0。**

3. **`receive()` 的测试阈值写错，且与自己要求的 `{gas:50_000}` 自相矛盾。** 原文：

   > `receive()` 在 `call{gas:50_000}` 下成功且冷 < 60k

   带 value 的 `call{gas: 50_000}` 里被调方实际可用 = 50,000 + 2,300（value stipend）= **52,300**。冷 60k 跑不完。规则 005 的原文是 "target < 50k, must succeed with `{gas: 50_000}`"，rat 实测冷 47,852 / 暖 10,452（`02 §1.2`）。60k 这个上界会放行一个必然失败 ping 的金库。**扣 0.3。**

4. **`settle()` 的失败回滚可能踩"跨外部调用缓存 `accountedQuote`"。** 规则 010 明列禁止项：**"never cache `accountedQuote` across an external call"**（`[CL]:116-131`）。`settle()` 先扣 `accountedQuote`，做两次 `call{value,gas:60_000}`，失败后要把钱记回 `stuck*` 并恢复 accounted——如果用的是调用前缓存的 `_revenue` 写回，而被调方在这 60k 里往 `receive()` 打了一笔（`receive()` 不是也不能是 `nonReentrant`），缓存写回就会把新识别的收入抹掉。文档没写"调用后重读"。**扣 0.2。**

5. **3% 的"不需特批"没有依据。** 原文：

   > 3% 落在 Flap 对 ≥2% 税率建议的佣金区间（≤3.0%）内，不需特批

   规则 001-h 的公式是 `fee = taxRateBps <= 100 ? 6% : 6/taxRateBps`（`01 §6`：1%→6.0%、2%→3.0%、3%→2.0%、5%→1.2%、10%→0.6%）。上限随税率**下降**，不是"≥2% 就一律 ≤3.0%"。3% 只在税率 **≤ 2%** 时成立；而这家的 hook 只要求"买卖税同为 0 或任一 > 1000"拒绝，**根本没钉死税率**。fork fixture 的默认是 buy/sell 500（5%），那里的上限是 1.2%，3% 是 2.5 倍。**扣 0.2。**（这条三家都犯，见 §4 第 1 条。）

---

## 2. arch-ship · 5.0

### 过的

* **`vaultBps != 10000` 拒绝 + 策略 `("mktBps","eq",abi.encode(uint16(10000)))`。** hook 和 `tokenCreationPolicies()` 双侧一致，对上了 `02:105` 和 Flap 自家 IndexVault 工厂的写法。理由也写对了："国库的 50/50 分账是这个项目的全部叙事 … 某个更早的同类项目 就是这么被迫改了两次"。
* **`newVault` 里交叉校验桥/质押绑定的预测代币地址——本次评审里最好的单点。** 原文：

  > **`IAgentBridge(bridge).bacToken() == taxToken`**、**`IValidatorStaking(staking).bacToken() == taxToken`**、`IAgentBridge(bridge).vault() == address(0)`

  这是**合法的**：规则禁止的是在 `newVault`/`initialize` 里碰 `taxToken`（此刻无代码），调用我们自己先部署好的合约没问题，而且先查了 `code.length > 0`。效果是把"发射表单粘错桥地址"从一条发射后只能靠重新发射修复的错误，变成一条**发射时就 revert 的错误**——正面解掉了 `rat/artifacts/verify/launch-snapshot.json` 里那六条 planned-vs-typed 不符。这一条必须被赢家吸收。
* 无 `emergencyWithdraw*`，理由引用准确（"某个更早的同类项目 的 owner 全额提款被点名 do not copy，而且在主网上真的被用来搬走了 29,951,480.8 个用户质押的代币"）。
* 规则 010 的基本形状对：一个 `_revenue` 打包槽、`_settle()` 是 `payRedemption/payNodeReward/withdrawOps/sync()` 的第一行、出账在 `call{value}` 之前同扣 bucket 与 accounted。
* E2E 验收第 2、7 步走真实 `newTokenV6WithVault` + `dispatch()` 并断言 `marketAddress == vault`、beacon 槽、`factorySpecVersion() == "v2.3"`。

### 挂的

1. **`OPS_BPS = 1000`：税收的 10% 是 owner 独占桶。徽章杀手。** 原文：

   > `OPS_BPS       = 1000   // 10% 节点基金 → 官方基础设施（服务器、中继 gas、域名/证书）`
   > `withdrawOps` 是 `owner` **或** Guardian

   `01 §8.3` 把这个场景直接点名了：**"An Agent-Chain 'node fund' that only the owner can withdraw is a dev bucket … must be justified to Flap and described in `description()`"**，并给出 `[CL]` 的合规形状：更宽的 owner 提款应当 **(a) 不含用户负债、(b) ≥ 72 小时时锁 + 可取消、(c) 在 `description()` 披露、(d) 动工前先跟 Flap 谈**。ship 只做到 (c)。按 `6/taxRateBps`：税率 2% 时上限 3%（超 3.3 倍），5% 时上限 1.2%（超 8.3 倍），10% 时上限 0.6%（超 16 倍）。**没有任何现实税率能让 10% 合规**（需要 ≤ 0.6% 的税率，而 hook 只要求"不为零"）。**扣 2.0。**
2. **`receive()` 的 gas 目标高于它自己要求的预算。** 原文：

   > 目标冷启动 < 55,000 gas、热 < 15,000 gas，必须能在 `call{gas: 50_000}` 下成功

   52,300 是天花板（50,000 + 2,300 stipend）。"冷 < 55,000"和"`{gas:50_000}` 下成功"不可能同时成立。规则 005 的违反是 **Critical**：一次 revert 那笔 dispatch 的份额**永久没收**（`marketQuoteBalance` 清零、钱留在 TaxProcessor 里、无重试）。**扣 0.5。**
3. **`payRedemption` / `payNodeReward` 是 Guardian 调不动的受限函数。** 原文：

   > 谁能调：`payRedemption` 只有 `bridge`；`payNodeReward` 只有 `staking`

   规则 001-d：**"Guardian can call every permissioned function"**，001-e：不可被任何人撤销。这两个函数动的是金库里的真钱，却把 Guardian 关在门外。`flap-vault-spec-checker` 会把每一个 `require(msg.sender == X)` 当成受限路径来数。**扣 0.5。**
4. **赎回额度在金库之外、结算之前算出来——规则 010 的"revenue-dependent action 必须先 sync"被跨合约绕过。** 原文：

   > `entitlement = burned * (bridgePool - reserved) / outstanding`

   `BridgeLock.recordExit` 读的是金库里那个**懒结算**的 `bridgePool`（`_settle()` 只在 `payRedemption/payNodeReward/withdrawOps/sync()` 里跑）。刚到账但还没分桶的 `unsplit`、以及还没被 `receive()` 识别的余额，都不在里面。修法是现成的：先调无许可的 `vault.sync()`，或者照 rat 的 `freeBalance()` / `_projected()`（`RATV:734-745`）暴露一个含未分账与未识别部分的投影视图。**扣 0.5。**
5. **没有逃生口，而 `pause()` 可无限续期。** 原文：

   > `pause()` 桥，最多一次 7 天，可续 … 只能停，不能转移任何资金

   watchdog = `vault.owner()` **或** Flap Guardian。"可续" = 无上限。ship 全文没有 halt/escape/逃生机制（security 有 `isHalted()` + 逃生，agentnative 有 `haltExit` + `HALT_EPOCHS = 336`）。结果：owner 可以永久冻结赎回，同时税收继续往同一个金库里累积。规则 003 把 "privileged paths that let insiders extract value at users' expense" 和 "controls that favor insiders" 都算进 fairness 审查范围，"dev" = 任何特权角色。**扣 0.3。**
6. `bindVault()` 用 `IVaultPortal.getVault(bacToken).vault`——`getVault` 在未找到时 **revert `VaultNotFound`**（`01 §2.5`），`tryGetVault` 才是不 revert 的那个。无许可函数，发射前被人点一下就 revert，无害，但该用 `tryGetVault`。**扣 0.2。**

---

## 3. arch-agentnative · 6.5

### 过的

* **闸门是三家里最硬的。** `vaultBps == 10000`（理由引用准确："某个更早的同类项目 两次把比例填错就是因为只有下界"）+ `creator == LAUNCHER`（immutable）+ `IBacBridge(bridge).factory() == address(this)`。`creator == LAUNCHER` 彻底封死了 `[CL]:593-594` 那个"策略默认 OPEN、陌生人能用我们的工厂发射"的洞——**三家里唯一做到的**。
* **`receive()` 的 gas 目标是唯一写对的。** 原文："目标 < 50k gas，`{gas: 50_000}` 必须跑得通（规则 005：`receive()` 一 revert，这一次 dispatch 的份额**永久作废**）"。和 `[CL]:424-442` 的数字逐字一致。
* **规则 010 的不变量写全了**：`accountedQuote == bridgePool + validatorPool + opsPool + unsplit` 且 `balance >= accountedQuote`，出金"在 `call{value:}` 之前先 `bucket -= x; accountedQuote -= x;`"。
* **`OPS_CAP` 溢出自动进 `validatorPool`**，形状对上了 rat `_split` 的两个性质（`02 §7.1`）：最后一个桶用"减法"算、有上限的桶溢出进最后一个桶。三家里唯一给 owner 桶加了任何形式天花板的。
* **规则 008 写对了，而且回答了 `02 §7.3` 的死结。** `BacEpochClock.trigger`：`msg.sender == service`、地址按 chainid 硬编码无 setter、先删 `requestId` 再动作、≤ 2,000,000 gas、`executeAfter` 只是下界、`rearmTrigger()` 无许可。`02 §7.3` 明确警告"严格 50/50 会留不下任何桶来付 `getFee()`"——这家用 5% ops 桶 + 无许可 `sealEpoch()` 兜底两条路同时解掉了。
* 唯一点名 CREATE2 salt-0 库地址撞车（"库字节码必须和 fly/rat 不同"，`02 §5`）和 `src/flap/*` 14 个文件逐字复制的。

### 挂的

1. **`payRedemption` / `payValidator` 同样把 Guardian 关在门外。** 原文："`payRedemption(address to, uint256 amount) external nonReentrant;   // 仅 bridge`"、"`payValidator … // 仅 nodeFund`"。与 ship 同病，规则 001-d。**扣 0.7。**
2. **`OPS_CAP = 1 ether` 是存量上限，不是终身上限——而披露文案会让人以为是终身的。** 原文：

   > `uint256 public constant OPS_CAP    = 1 ether; // opsPool 存量上限，超出部分自动进 validatorPool`
   > "…存量上限 1 BNB，超出部分自动进验证者奖励池"

   owner 提完 1 BNB 之后 `opsPool` 会以 5% 的速率重新填满，**终身取用量无上限**。`description()` 和 `vaultDataSchema().description` 都是 `pure`、部署即冻结（`01 §3`），写成"存量上限 1 BNB"是一句会被读成承诺的话。规则 003 + 001-h 要求把真实结构写清楚。正确写法："节点基金的 10%（= 税收的 5%）持续计入运维桶，桶内余额上限 1 BNB，超出部分转入验证者奖励池；owner 可随时提取桶内余额，提完会继续按同一比例累积"。**扣 0.6。**
3. **5% 仍然超过 `6/taxRateBps` 上限（除非税率 ≤ 1.2%），而 hook 没钉死税率。** 与 security 第 5 条同因。**扣 0.2。**
4. **赎回份额同样在金库外、结算前算。** 原文："开票时一次性固定 `owed = bridgePool * credits / outstandingCredits`"。与 ship 第 4 条同病。**扣 0.5。**
5. **完全没有发射后硬停清单。** 全文找不到 `verify_launch` 形状的 5 分钟核验（security 有 10 项、ship 有 5 项 + 每小时复查 `marketAddress`）。本评审视角里"verify_launch 硬停"是明列的计分项，而 `01 §4.4` 的清单（`marketAddress`、beacon 槽 `0xa3f0ad74…3d50`、`feeConfigV2()`、`vaultQuoteToken()`、`vaultSpecVersion()`）恰恰是**发射后唯一能发现"税收根本没进我们金库"的手段**，而且 `marketAddress` 项目方改不了、修法只有重新发射。文档最后列的是 6 条"需要用户拍板"的开放问题，不是核验。**扣 0.5。**
6. `creator == LAUNCHER` 是 immutable：发射钱包换一个，发射就 revert，只能重新部署工厂（某个更早的同类项目 为了改个名字重部过一次，`02 §5`）。必须配一条发射前用**那个确切地址**做的 `cast call` 模拟（`01 §4.4` 的 `--from $LAUNCHER`）。**扣 0.2。**

---

## 4. 三家共有的致命项（与名次无关，必须在写码前解决）

1. **没有一家在 hook 里钉死税率，却都把 owner 桶写成收入的固定 bps。** 规则 001-h 的开发者桶上限是 `6/taxRateBps`，是税率的函数：1%→6.0%、2%→3.0%、3%→2.0%、5%→1.2%、10%→0.6%。三家的 hook 都只写"买卖税不同时为 0、各 ≤ 1000"。于是 `ops_bps / ceiling(taxRate)` 这个比值**在部署时不确定**，写在 `pure` 的 `description()` 里的披露就无法保证为真。fork fixture 的默认是 500（5%），上限 1.2%：security 3% 超 2.5 倍、agentnative 5% 超 4.2 倍、ship 10% 超 8.3 倍。
   **修法**：`_validateBeforeLaunch` 里 `require(data.buyTaxRate == TAX_BPS && data.sellTaxRate == TAX_BPS)`，`tokenCreationPolicies()` 镜像 `("buyTaxRate","eq",…)`、`("sellTaxRate","eq",…)`，然后按 `6/TAX_BPS` 反推 ops 桶，或者明确写"超过建议上限，已向 Flap 说明"并在 `description()` 里逐字写出这句话。
2. **没有一家提到 Flap 的协议费 `feeRate = 1000` bps。** `01 §8.1`（实测 `rat/artifacts/verify/launch-snapshot.json` → `feeConfigV2.feeRate: 1000`，另一个更早的项目 主网 block 122,374,499）：**协议先拿走税的 10%，`mktBps` 作用在余额上**。`dispatch()` 的顺序是 fee → commission → market → dividend。所以"每一笔 BNB 税收 50% 进桥池"这句话在三家的文案里都少算了 10%。`01 §8.1` 的原话："Any '1 BNB of tax → 0.5 bridge / 0.5 node fund' copy must be written against the post-fee number, not the raw tax."
   **修法**：所有经济学文案、`description()`、网站规则卡统一写成"税收扣除 Flap 协议费后进入金库，金库再按 50/50 分账"；`commissionReceiver` 留空以保证 `commissionBps == 0`（同一快照实测）。
3. **没有一家写出 `vaultUISchema()` 的具体内容。** 规则 002/UI（`01 §3`）：`name` 必须是精确的 Solidity 函数名、参数类型必须是允许类型之一（选择器由 `name` + `fieldType` 拼出来）、**无输入的 view 在页面加载时立刻被调用，必须永不 revert**、写方法 `outputs` 必须为空、每个数组都要初始化。`02 §7.5` 还点明："For an agent-only vault this file is where 'no human write method' becomes visible: a treasury vault ships views only"。三家都只说"有 `vaultUISchema()`"，内容未定 = 无法核验。一个国库金库应当只出 view（`sync()` / `settle()` 虽然无许可，但列进 schema 会让 flap.sh 给人类渲染按钮，和"层内无人类界面"的叙事直接打架）。

---

## 5. 赢家必须吸收的东西

从 **arch-ship** 拿：

* `_validateBeforeLaunch` 里 `vaultBps == 10000`，`tokenCreationPolicies()` 里 `("mktBps","eq",abi.encode(uint16(10000)))`。照抄理由段落。
* `newVault` 里对我们自己合约的交叉校验：`IAgentBridge(bridge).bacToken() == taxToken`、`IValidatorStaking(staking).bacToken() == taxToken`、`bridge.vault() == address(0)`，先查 `code.length > 0`。把 security 那条"发射后 5 分钟核验 `vault.bridge()/validatorPayout()` 正确"升级成"发射时就 revert"。

从 **arch-agentnative** 拿：

* `newVault` 里 `require(creator == LAUNCHER)`（`LAUNCHER` 为 immutable 构造参数），关掉 OPEN 策略下的陌生人发射。配套：发射前必须用那个确切地址跑 `cast call $VP "newTokenV6WithVault(…)" "$P" --from $LAUNCHER --value 0`。
* `receive()` 的正确数字：目标 **< 50k**（不是 < 60k），测试断言 `{gas: 50_000}` 成功（可用预算 52,300 = 50,000 + 2,300 value stipend），参照 rat 实测冷 47,852 / 暖 10,452。
* 无许可 `bindVault()`：从 `VaultPortal.tryGetVault(token)` 读出 vault 并 `require(vaultInfo.vaultFactory == FACTORY)`，替掉 security 的"一次性、仅部署者、由部署者传 vault 地址"——后者是一个可以把桥绑到任意金库上的受信步骤。
* 把 ops 桶在 `description()` 里的措辞改成真实结构（比例 + 桶上限 + 溢出去向 + "提完会继续累积"），不要写成会被读成终身上限的话。

从两家都拿（本评审新增）：

* hook 里用 `==` 钉死 `buyTaxRate` / `sellTaxRate`，并据此把 ops 桶压到 `6/taxRateBps` 以下，或明确写"已向 Flap 说明的偏离"。
* 所有 50/50 的数字改写在**扣除 10% 协议费之后**的基数上。
* `settle()` 的失败回滚必须**在外部调用之后重读** `_revenue`，不得写回调用前的缓存（规则 010 明列禁止）。

---

## 6. 不在本视角内但顺手记一笔

security 把金库掏空的设计（稳态余额 ≈ 3% ops）意味着 flap.sh 上那张金库卡片永远显示接近 0 的池子，`description()` 里的数字也永远接近 0。这不是合规问题，但会让金库看起来像是坏的。建议 `description()` 优先展示 `lifetimeToBridge / lifetimeToValidators / lifetimeToOps` 三个累计数，而不是当前余额。
