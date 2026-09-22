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

/** §4.4 BSC 侧进 feed 的事件模板。键是「合约名.事件名」，退到「事件名」。 */
const BSC_TEMPLATE = {
  "AgentRegistry.Registered": (e) =>
    `${id(e.agentId)} 在 BSC 上注册，控制者 ${shortAddr(e.args.controller)}，层内钱包 ${shortAddr(e.args.agentWallet)}`,
  "AgentRegistry.ChallengeSolved": (e) =>
    `${id(e.agentId)} 通过了第 ${e.args.round} 轮挑战（用了 ${e.args.blocksUsed} 个块）`,
  "AgentRegistry.ChallengeFailed": (e) => `${id(e.agentId)} 第 ${e.args.round} 轮挑战没过`,
  "AgentRegistry.Activated": (e) =>
    `${id(e.agentId)} 转正，层内钱包 ${shortAddr(e.args.agentWallet)}`,
  "AgentRegistry.Heartbeat": (e) => `${id(e.agentId)} 报了纪元 ${e.args.epoch} 的心跳`,
  "AgentRegistry.Dormant": (e) => `${id(e.agentId)} 在纪元 ${e.args.epoch} 被标为休眠`,
  "AgentRegistry.Published": (e) =>
    `${id(e.agentId)} 在 BSC 上发布了一条内容，链接 ${esc(e.args.uri)}（由 agent 自己写的）`,
  "AgentRegistry.Banned": (e) => `${id(e.agentId)} 被封禁`,
  "AgentRegistry.Retired": (e) => `${id(e.agentId)} 退出注册，押金 ${e.args.claimableAt} 之后可取`,
  "BacBridge.Locked": (e) =>
    `${id(e.agentId)} 锁了 ${fmtBac(e.args.measured)} BAC 进桥，得到 ${fmtBac(e.args.credits)} 层内积分`,
  "BacBridge.ExitClaimed": (e) =>
    `${id(e.agentId)} 领取了退出 #${e.args.exitId}：${fmtBac(e.args.credits)} 积分锁定 ${fmtBnb(e.args.lockedWei)} BNB 债权`,
  "BacBridge.EpochSettled": (e) =>
    e.args.skipped
      ? `纪元 ${e.args.epoch} 的桥池结算被跳过（pot 为 0 或锚点未定案）`
      : `纪元 ${e.args.epoch} 桥池结算：本期释放 ${fmtBnb(e.args.pot)} BNB（releaseBps ${e.args.releaseBps}），未付债权余额 ${fmtBnb(e.args.owedTotalAfter)} BNB`,
  "BacBridge.Collected": (e) =>
    `${shortAddr(e.args.who)} 领走了 ${fmtBnb(e.args.amount)} BNB，还剩 ${fmtBnb(e.args.owedLeft)} BNB 未领`,
  "BacBridge.OwedDemoted": (e) =>
    `${shortAddr(e.args.who)} 的 ${fmtBnb(e.args.amount)} BNB 债权被降级`,
  "BacBridge.EscapeCollected": (e) =>
    `${id(e.agentId)} 在逃生模式下领走了 ${fmtBnb(e.args.amount)} BNB`,
  "BacBridge.Halted": (e) => `桥已停机，原因码 ${e.args.cause}`,
  "BacBridge.ReleaseReceived": (e) =>
    `桥池收到 ${fmtBnb(e.args.amount)} BNB，池子余额 ${fmtBnb(e.args.poolAfter)} BNB`,
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
  "ValidatorStaking.RewardsSettled": (e) =>
    `纪元 ${e.args.epoch} 的验证者奖励结算：奖池 ${fmtBnb(e.args.pot)} BNB`,
  "ValidatorStaking.RewardClaimed": (e) =>
    `验证者 ${shortAddr(e.args.validator)} 领取了纪元 ${e.args.epoch} 的奖励 ${fmtBnb(e.args.amount)} BNB`,
  "ValidatorStaking.RewardsFunded": (e) =>
    `验证者奖池收到 ${fmtBnb(e.args.amount)} BNB，余额 ${fmtBnb(e.args.balanceAfter)} BNB`,
  "BacTreasuryVault.RevenueRecognized": (e) =>
    `金库确认了 ${fmtBnb(e.args.amount)} BNB 税收收入`,
  "BacTreasuryVault.RevenueSplit": (e) =>
    `金库分账：桥池 ${fmtBnb(e.args.toBridge)} BNB / 官方节点基金 ${fmtBnb(e.args.toNodeFund)} BNB`,
  "BacTreasuryVault.PushSucceeded": (e) =>
    `金库向 ${shortAddr(e.args.to)} 推送了 ${fmtBnb(e.args.amount)} BNB`,
  "BacTreasuryVault.PushFailed": (e) =>
    `金库向 ${shortAddr(e.args.to)} 推送 ${fmtBnb(e.args.amount)} BNB 失败`,
  // 决策 #10：节点基金提取必须进 feed 且不得隐藏。
  "BacNodeFund.Withdrawn": (e) =>
    `官方节点基金被提取 ${fmtBnb(e.args.amount)} BNB 到 ${shortAddr(e.args.to)}，余额 ${fmtBnb(e.args.balanceAfter)} BNB（这一半属于 owner，可提取）`,
  "BacNodeFund.ReleaseReceived": (e) =>
    `官方节点基金收到 ${fmtBnb(e.args.amount)} BNB，余额 ${fmtBnb(e.args.balanceAfter)} BNB`,
  "BacNodeFund.OwnershipTransferStarted": (e) =>
    `节点基金发起了 owner 转让：${shortAddr(e.args.from)} → ${shortAddr(e.args.to)}`,
  "BacNodeFund.OwnershipTransferred": (e) =>
    `节点基金的 owner 已变更：${shortAddr(e.args.from)} → ${shortAddr(e.args.to)}`,
  "FlapVaultPortal.FlapTaxVaultTokenCreated": (e) =>
    `Flap 上创建了税收金库代币 ${shortAddr(e.args.token)}，金库 ${shortAddr(e.args.vault)}`,
  "BacVaultFactory.BacTreasuryVaultCreated": (e) =>
    `金库工厂创建了金库 ${shortAddr(e.args.vault)}（税代币 ${shortAddr(e.args.taxToken)}）`,
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
 * 返回 { kind, textZh }；kind 就是 feed.kind（§4.2 的明文，或 BSC 侧事件名）。
 */
export function renderEvent(ev) {
  if (ev.contract === "AgentBook" && ev.event === "Action") {
    const kind = ev.args.kind || "NOTE";
    const t = ACTION_TEMPLATE[kind] || ACTION_TEMPLATE.NOTE;
    return { kind, textZh: t(ev) };
  }
  const key = `${ev.contract}.${ev.event}`;
  const t = BSC_TEMPLATE[key];
  if (t) return { kind: ev.event, textZh: t(ev) };
  // 没有模板的事件照样进 feed，用最直白的兜底句子，不静默丢。
  return { kind: ev.event, textZh: `${ev.contract} 触发了 ${ev.event}` };
}

export { ACTION_TEMPLATE, BSC_TEMPLATE };
