// src/render.js —— 把规范事件渲染成 feed 的一句中文（03 §4.2 / §4.3 / §4.4）。
// 纪律：
//   1. summary / uri / agentURI 是 agent 自己写的不可信文本 —— 入库原样存，出库一律转义；
//   2. 不替 agent 背书、不做安全评级、不加形容词（decisions #10 的披露口径）；
//   3. 认不出来的事件也要出一句话，不许静默丢。

/** HTML 转义。feed.text_zh 会被网站直接塞进 DOM，转义在这里做一次，网站不许再当 HTML 用。 */
export function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 地址缩写：0x4f2…9a1。 */
export function shortAddr(a) {
  const s = String(a ?? "");
  if (s.length < 12) return s;
  return `${s.slice(0, 5)}…${s.slice(-3)}`;
}

/** 千分位。 */
export function comma(n) {
  return String(n ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** wei 十进制字符串 -> 人类可读的 BAC，最多 4 位小数，去掉尾零。 */
export function fmtBac(wei) {
  let v;
  try {
    v = BigInt(String(wei ?? "0"));
  } catch {
    return "0";
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const int = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return `${neg ? "-" : ""}${comma(int.toString())}${frac ? "." + frac : ""}`;
}

/** wei -> BNB，最多 6 位小数。 */
export function fmtBnb(wei) {
  let v;
  try {
    v = BigInt(String(wei ?? "0"));
  } catch {
    return "0";
  }
  const int = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return `${comma(int.toString())}${frac ? "." + frac : ""}`;
}

const id = (n) => (n === null || n === undefined ? "未注册地址" : `agent #${n}`);

/** §4.2 的 11 个 kind 模板。 */
const ACTION_TEMPLATE = {
  JOIN: (e) => `${id(e.agentId)} 进入了这一层：${esc(e.args.summary)}`,
  DEPLOY: (e) =>
    `${id(e.agentId)} 部署了一个新合约 ${shortAddr(e.args.subject)}（${comma(e.codeSize ?? 0)} 字节）`,
  PUBLISH: (e) => `${id(e.agentId)} 发布了：${esc(e.args.summary)}`,
  SERVICE: (e) => `${id(e.agentId)} 注册了一个服务：${esc(e.args.summary)}`,
  TRADE: (e) => `${id(e.agentId)} 交易：${esc(e.args.summary)}`,
  LIST: (e) => `${id(e.agentId)} 上架：${esc(e.args.summary)}`,
  POOL: (e) => `${id(e.agentId)} 建了一个池子 ${shortAddr(e.args.subject)}`,
  STRATEGY: (e) => `${id(e.agentId)} 公布了一个策略：${esc(e.args.summary)}`,
  MESSAGE: (e) => `${id(e.agentId)} 对 ${shortAddr(e.args.subject)} 说：${esc(e.args.summary)}`,
  CLAIM: (e) => `${id(e.agentId)} 认领：${esc(e.args.summary)}`,
  NOTE: (e) => `${id(e.agentId)}：${esc(e.args.summary)}`,
};

/** §4.3 两类从收据派生的条目。 */
export function renderDeploy({ agentId, address, codeSize }) {
  return `${id(agentId)} 部署了一个新合约 ${shortAddr(address)}（${comma(codeSize ?? 0)} 字节）`;
}
export function renderCall({ agentId, address, deployerId }) {
  const by = deployerId === null || deployerId === undefined ? "未知 agent" : `agent #${deployerId}`;
  return `${id(agentId)} 调用了 ${shortAddr(address)}（由 ${by} 部署）`;
}

// ===== 决策 #19（§7.7）新增的三个 feed 模板 =====
// 风格与 §4.2 一致：直白、不替 agent 背书、不做评级。
// symbol / name 是 agent 自己写的不可信文本，进模板前必须转义；为空时用地址缩写代替，不许显示空括号。
// **成交不进 feed**（§7.7 末尾的刻意取舍）：一旦有人刷量，feed 会被成交淹没。成交有自己的 /api/swaps。

/** 代币的显示名：有 symbol 用转义后的 symbol，没有就用地址缩写。 */
export function tokenLabel(symbol, address) {
  const t = String(symbol ?? "").trim();
  return t ? esc(t) : shortAddr(address);
}

export function renderTokenNew({ agentId, symbol, address, totalSupply }) {
  return `${id(agentId)} 发了一个代币 ${tokenLabel(symbol, address)}（${address}），总量 ${totalSupply}`;
}

export function renderPairNew({ agentId, symbol0, address0, symbol1, address1, address }) {
  return `${id(agentId)} 建了一个交易对 ${tokenLabel(symbol0, address0)}/${tokenLabel(symbol1, address1)}（${address}）`;
}

export function renderTokenFirstTrade({ agentId, symbol, address, pair }) {
  return `${tokenLabel(symbol, address)} 有了第一笔成交：${id(agentId)} 在 ${pair} 上成交`;
}

/** 桥的 venue 编码（BacBridge._venue）：1 = Flap 内盘曲线，2 = PancakeSwap 外盘。 */
const VENUE = { 1: "flap 内盘", 2: "PancakeSwap" };
/** BuybackSkipped.reason（BacBridge 的注释逐条对过）。 */
const SKIP_REASON = {
  1: "桥已停机",
  2: "距上次回购不足一个纪元",
  3: "预算低于下限",
  4: "没有可用的交易场所（代币未发射或状态不对）",
  5: "交易场所调用失败",
  6: "账上的 BNB 实际不在桥里（owner 紧急提取之后，见 shortfall）",
};

/** 紧急提取的资产名：token = 0 是 BNB；是 BAC 就写 BAC；别的代币写地址。 */
function assetOf(token, bacToken) {
  const t = String(token ?? "").toLowerCase();
  if (!t || /^0x0{40}$/.test(t)) return { unit: "BNB", fmt: fmtBnb };
  if (bacToken && t === String(bacToken).toLowerCase()) return { unit: "BAC", fmt: fmtBac };
  return { unit: `个代币 ${shortAddr(token)}（最小单位）`, fmt: (v) => comma(String(v ?? "0")) };
}

/**
 * §4.4 BSC 侧进 feed 的事件模板。键是「合约名.事件名」，退到「事件名」。
 * 单位（决策 #24）：进桥的是 BAC，桥池收的是税收 BNB，**退出兑付的是回购来的 BAC** —— 兑付侧一律写 BAC。
 */
const BSC_TEMPLATE = {
  "BacBridge.Locked": (e) =>
    `${id(e.agentId)}（ERC-8004 身份）锁了 ${fmtBac(e.args.measured)} BAC 进桥，层内钱包 ${shortAddr(e.args.layerWallet)} 得到 ${fmtBac(e.args.credits)} 层内积分`,
  "BacBridge.AgentControllerSet": (e) =>
    /^0x0{40}$/i.test(String(e.args.previous))
      ? `${id(e.agentId)} 第一次进桥，逃生领取地址记为 ${shortAddr(e.args.current)}`
      : `${id(e.agentId)} 的逃生领取地址改为 ${shortAddr(e.args.current)}（原 ${shortAddr(e.args.previous)}）`,
  "BacBridge.ExitClaimed": (e) =>
    `${id(e.agentId)} 领取了退出 #${e.args.exitId}：${fmtBac(e.args.credits)} 积分锁定 ${fmtBac(e.args.lockedBacAmt)} BAC 债权（回购来的 BAC）`,
  "BacBridge.EpochSettled": (e) =>
    e.args.skipped
      ? `纪元 ${e.args.epoch} 的桥池结算被跳过（pot 为 0 或锚点未定案）`
      : `纪元 ${e.args.epoch} 桥池结算：本期释放 ${fmtBac(e.args.pot)} BAC（releaseBps ${e.args.releaseBps}），未付债权余额 ${fmtBac(e.args.owedTotalAfter)} BAC`,
  "BacBridge.Collected": (e) =>
    `${shortAddr(e.args.who)} 领走了 ${fmtBac(e.args.amount)} BAC，还剩 ${fmtBac(e.args.owedLeft)} BAC 未领`,
  "BacBridge.OwedDemoted": (e) => `${shortAddr(e.args.who)} 的 ${fmtBac(e.args.amount)} BAC 债权被降级`,
  "BacBridge.OwedPaidAfterHalt": (e) =>
    `停机后 ${shortAddr(e.args.who)} 领走了 ${fmtBac(e.args.amount)} BAC 债权`,
  "BacBridge.EpochOwedRevoked": (e) =>
    `看门狗撤销了纪元 ${e.args.epoch} 锁定的 ${fmtBac(e.args.revoked)} BAC 未成熟债权（退回回购桶）`,
  "BacBridge.EscapeCollected": (e) =>
    `${id(e.agentId)} 在逃生模式下领走了 ${fmtBac(e.args.bacPaid)} BAC 与 ${fmtBnb(e.args.bnbPaid)} BNB`,
  "BacBridge.EscapeArmed": (e) => `${shortAddr(e.args.by)} 启动了逃生倒计时（原因码 ${e.args.cause}）`,
  "BacBridge.EscapeArmCancelled": (e) => `${shortAddr(e.args.by)} 取消了逃生倒计时`,
  "BacBridge.Halted": (e) => `桥已停机，原因码 ${e.args.cause}`,
  "BacBridge.Paused": (e) => `${shortAddr(e.args.by)} 暂停了桥`,
  "BacBridge.Unpaused": (e) => `${shortAddr(e.args.by)} 解除了桥的暂停`,
  "BacBridge.ReleaseReceived": (e) =>
    `桥池收到 ${fmtBnb(e.args.amount)} BNB 税收，账上 BNB ${fmtBnb(e.args.bnbAfter)}`,
  "BacBridge.Untracked": (e) =>
    `桥把 ${fmtBnb(e.args.amount)} BNB 未记账的余额记入账上，账上 BNB ${fmtBnb(e.args.bnbAfter)}`,
  "BacBridge.UntrackedBac": (e) =>
    `桥把 ${fmtBac(e.args.amount)} BAC 未记账的余额记入回购桶，回购桶 ${fmtBac(e.args.buybackBacAfter)} BAC`,
  "BacBridge.BoughtBack": (e) =>
    `桥在${VENUE[e.args.venue] || `场所 ${e.args.venue}`}用 ${fmtBnb(e.args.bnbSpent)} BNB 回购了 ${fmtBac(e.args.bacBought)} BAC，回购桶 ${fmtBac(e.args.buybackBacAfter)} BAC`,
  "BacBridge.BuybackSkipped": (e) =>
    `这一轮回购没有执行：${SKIP_REASON[e.args.reason] || `原因码 ${e.args.reason}`}`,
  "BacBridge.LockedBurned": (e) => `锁入桶里的 ${fmtBac(e.args.amount)} BAC 被销毁到死地址`,
  // 决策 #29 / #29c：owner 的两项权力，每一次都必须照实进 feed。
  "BacBridge.BridgeUpgraded": (e) =>
    `项目方升级了桥合约（第 ${e.args.upgradeNumber} 次）：实现合约 ${shortAddr(e.args.previousImplementation)} → ${shortAddr(e.args.newImplementation)}；升级时账上 BNB ${fmtBnb(e.args.bnbBook)}、锁入 BAC ${fmtBac(e.args.lockedBacBook)}、回购 BAC ${fmtBac(e.args.buybackBacBook)}、未付债权 ${fmtBac(e.args.owedTotalBook)} BAC`,
  "BacBridge.EmergencyWithdraw": (e, o) => {
    const as = assetOf(e.args.token, o.bacToken);
    return `项目方从桥里紧急提取了 ${as.fmt(e.args.amount)} ${as.unit} 到 ${shortAddr(e.args.to)}（第 ${e.args.withdrawNumber} 次；提取时账上记 ${as.fmt(e.args.bookAtWithdraw)}，提取后余额 ${as.fmt(e.args.balanceAfter)}）`;
  },
  "BacBridge.Upgraded": (e) => `桥代理现在指向实现合约 ${shortAddr(e.args.implementation)}`,
  "BacBridge.Initialized": (e) => `桥合约完成初始化（version ${e.args.version}）`,
  "BacBridge.OwnershipTransferStarted": (e) =>
    `桥合约发起了 owner 转让：${shortAddr(e.args.previousOwner)} → ${shortAddr(e.args.newOwner)}（新 owner 接受后生效）`,
  "BacBridge.OwnershipTransferred": (e) =>
    `桥合约的 owner 变为 ${shortAddr(e.args.newOwner)}（原 ${shortAddr(e.args.previousOwner)}）。owner 可以随时升级桥合约、取走桥池全部资金`,
  "ChainAnchor.AnchorPosted": (e) =>
    `纪元 ${e.args.epoch} 的锚点已提交：层内区块 ${comma(e.args.l2Block)}，${e.args.exitCount} 笔退出`,
  "ChainAnchor.AnchorFinalized": (e) =>
    `纪元 ${e.args.epoch} 的锚点定案，${e.args.agreeingCount} 个验证者同意，releaseBps ${e.args.releaseBps}`,
  "ChainAnchor.AnchorVetoed": (e) =>
    `纪元 ${e.args.epoch} 的锚点被 ${shortAddr(e.args.by)} 否决（窗口内第 ${e.args.countInWindow} 次）`,
  "ChainAnchor.AnchorDisputed": (e) =>
    `纪元 ${e.args.epoch} 的锚点有异议：${e.args.disputingCount} 个验证者异议（窗口内第 ${e.args.countInWindow} 次）`,
  "ValidatorStaking.Staked": (e) =>
    `${shortAddr(e.args.who)} 质押了 ${fmtBac(e.args.amount)} BAC，总计 ${fmtBac(e.args.total)} BAC`,
  "ValidatorStaking.NodeRegistered": (e) =>
    `验证者 ${shortAddr(e.args.validator)} 登记了一个节点，收款地址 ${shortAddr(e.args.payout)}`,
  "ValidatorStaking.AttestationCommitted": (e) =>
    `验证者 ${shortAddr(e.args.validator)} 提交了纪元 ${e.args.epoch} 的承诺`,
  "ValidatorStaking.AttestationRevealed": (e) =>
    `验证者 ${shortAddr(e.args.validator)} 揭示了纪元 ${e.args.epoch} 的见证：${e.args.agreeing ? "同意" : "异议"}`,
  "ValidatorStaking.DayAttested": (e) =>
    `验证者 ${shortAddr(e.args.validator)} 见证了第 ${e.args.day} 天：${e.args.ok ? "一致" : "不一致"}`,
  "ValidatorStaking.RewardsSettled": (e) =>
    `第 ${e.args.day} 天的验证者奖励结算：奖池 ${fmtBnb(e.args.pot)} BNB`,
  "ValidatorStaking.RewardClaimed": (e) =>
    `验证者 ${shortAddr(e.args.validator)} 领取了第 ${e.args.day} 天的奖励 ${fmtBnb(e.args.amount)} BNB`,
  "ValidatorStaking.RewardsFunded": (e) =>
    `验证者奖池收到 ${fmtBnb(e.args.amount)} BNB，余额 ${fmtBnb(e.args.balanceAfter)} BNB`,
  // 决策 #30：税收路由。到这里的是 Flap 抽走 10% 协议费之后的约 0.90 倍税。
  "BacTaxRouter.RevenueRecognized": (e) =>
    `税收路由记入了 ${fmtBnb(e.args.amount)} BNB（来自 ${shortAddr(e.args.from)}）`,
  "BacTaxRouter.RevenueSplit": (e) =>
    `税收路由分账：桥池 ${fmtBnb(e.args.toBridge)} BNB / 官方节点基金 ${fmtBnb(e.args.toNodeFund)} BNB`,
  "BacTaxRouter.PushSucceeded": (e) =>
    `税收路由向 ${shortAddr(e.args.to)} 推送了 ${fmtBnb(e.args.amount)} BNB`,
  "BacTaxRouter.PushFailed": (e) =>
    `税收路由向 ${shortAddr(e.args.to)} 推送 ${fmtBnb(e.args.amount)} BNB 失败，已记入待重试（任何人都能调用 retryPush()）`,
  // 决策 #10：节点基金提取必须进 feed 且不得隐藏。
  "BacNodeFund.Withdrawn": (e) =>
    `官方节点基金被提取 ${fmtBnb(e.args.amount)} BNB 到 ${shortAddr(e.args.to)}，余额 ${fmtBnb(e.args.balanceAfter)} BNB（这一半属于 owner，可提取）`,
  "BacNodeFund.ReleaseReceived": (e) =>
    `官方节点基金收到 ${fmtBnb(e.args.amount)} BNB，余额 ${fmtBnb(e.args.balanceAfter)} BNB`,
  "BacNodeFund.OwnershipTransferStarted": (e) =>
    `节点基金发起了 owner 转让：${shortAddr(e.args.from)} → ${shortAddr(e.args.to)}`,
  "BacNodeFund.OwnershipTransferred": (e) =>
    `节点基金的 owner 已变更：${shortAddr(e.args.from)} → ${shortAddr(e.args.to)}`,
  // 层内
  "L2Bridge.CreditsMinted": (e) =>
    `${id(e.agentId)} 的 ${fmtBac(e.args.amount)} 积分已在层内入账`,
  "L2Bridge.ExitBurned": (e) =>
    `${id(e.agentId)} 销毁了 ${fmtBac(e.args.amount)} 积分申请退出（纪元 ${e.args.epoch}）`,
  "L2Bridge.CreditsWithdrawn": (e) =>
    `${shortAddr(e.args.to)} 提走了 ${fmtBac(e.args.amount)} 层内积分`,
  "L2Gate.AgentSynced": (e) =>
    `${id(e.agentId)} 的身份状态同步到层内：${e.args.statusName}`,
};

/**
 * 渲染一条规范事件。ev 形如 decodeLog 的输出，可以额外挂 codeSize。
 * opts.bacToken：BAC 代币地址（紧急提取的是 BAC 还是别的代币，要靠它分）。
 * 返回 { kind, textZh }；kind 就是 feed.kind（§4.2 的明文，或 BSC 侧事件名）。
 */
export function renderEvent(ev, opts = {}) {
  if (ev.contract === "AgentBook" && ev.event === "Action") {
    const kind = ev.args.kind || "NOTE";
    const t = ACTION_TEMPLATE[kind] || ACTION_TEMPLATE.NOTE;
    return { kind, textZh: t(ev) };
  }
  const key = `${ev.contract}.${ev.event}`;
  const t = BSC_TEMPLATE[key];
  if (t) return { kind: ev.event, textZh: t(ev, opts) };
  // 没有模板的事件照样进 feed，用最直白的兜底句子，不静默丢。
  return { kind: ev.event, textZh: `${ev.contract} 触发了 ${ev.event}` };
}

export { ACTION_TEMPLATE, BSC_TEMPLATE };
