// src/api/handlers.js —— 03 §3 的每一个端点。
// 每个 handler 都是纯函数：(ctx, params) -> { status, body }，不碰 socket，测试可以直接调。
// 字段名逐字对齐 03 §3，一个字母都不许改。
import { GENESIS_SUPPLY, FEE_SINK, FEE_SPLITTER, LAYER_SYSTEM_ADDRESSES, FLAP_TOKEN_STATUS } from "../abi.js";
import { identityOf, IDENTITY_NOTE } from "../identity.js";
import { renderEvent } from "../render.js";
import { listWarnings } from "../warnings.js";
import { root as exitRootOf, leafHash, proof as proofOf, ZERO_ROOT } from "../exit-tree.js";
import { anchoredThrough, anchoredThroughBlock } from "../store.js";
import { epochOf } from "../decode.js";
import * as B from "./built.js";
import { classifiedZh } from "../economy/constants.js";

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const badRequest = (m) => new ApiError("bad_request", m, 400);
export const notFound = (m) => new ApiError("not_found", m, 404);

const nowSec = () => Math.floor(Date.now() / 1000);

function intParam(v, def, { min = 0, max = Number.MAX_SAFE_INTEGER, name = "参数" } = {}) {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`${name} 必须是整数`);
  if (n < min || n > max) throw badRequest(`${name} 超出范围 ${min}..${max}`);
  return n;
}

const s = (v) => (v === null || v === undefined ? null : String(v));
const n = (v) => (v === null || v === undefined ? null : Number(v));

// ===================== §3.1 /api/health =====================

/**
 * reconcile.howToCheck 必须原样返回：任何人照这几条命令就能自己复算每一项（03 §3.1 + 创世分配项 + L2Bridge 计数）。
 * 第一条指向 /api/genesis —— 索引器实际读的就是这份文件（响应头 X-Genesis-Hash = reconcile.genesisFileHash）。
 */
export function howToCheck(cfg) {
  const bridge = (cfg.addresses && cfg.addresses.BacBridge) || "<BacBridge>";
  const rpc = cfg.bscRpc;
  const layerRpc = `${cfg.apiBase}/rpc`;
  const l2 = LAYER_SYSTEM_ADDRESSES.L2Bridge;
  return [
    `curl -s ${cfg.apiBase}/api/genesis   # 索引器用的那份创世文件（X-Genesis-Hash 即 genesisFileHash）；genesisSupply = Σ alloc.balance；bridgeAlloc = L2Bridge（0x…0101）那一项；genesisAlloc = 其余`,
    `cast call ${bridge} "totalCreditsIssued()(uint256)" --rpc-url ${rpc}`,
    `cast call ${bridge} "totalCreditsExited()(uint256)" --rpc-url ${rpc}`,
    `cast balance ${l2} --block <l2Bridge.block> --rpc-url ${layerRpc}`,
    `cast call ${l2} "totalCredited()(uint256)" --block <l2Bridge.block> --rpc-url ${layerRpc}`,
    `cast call ${l2} "totalExited()(uint256)" --block <l2Bridge.block> --rpc-url ${layerRpc}`,
    `cast call ${l2} "totalBurnedFloat()(uint256)" --block <l2Bridge.block> --rpc-url ${layerRpc}`,
    `cast balance ${FEE_SINK} --rpc-url ${layerRpc}`,
    `cast balance ${FEE_SPLITTER} --rpc-url ${layerRpc}`,
    `cast rpc qbft_getValidatorsByBlockNumber latest --rpc-url ${layerRpc}`,
    `cast balance <每一个历史出现过的 validator 地址> --rpc-url ${layerRpc}`,
  ];
}

/**
 * 公式（2026-09-23 复核后重写）。旧的 diff 只有一行：
 *   (bscTotalIssued − bscTotalExited + genesisAlloc) − (layerCirculating + FeeSink + FeeSplitter + Σ validator)
 * 把 layerCirculating = genesisSupply − B(L2Bridge) − FeeSink − FeeSplitter − Σ validator 代进去，FeeSink / FeeSplitter /
 * 验证者余额两边相消，剩下的是 bscTotalIssued − bscTotalExited − bridgeAlloc + B(L2Bridge) —— 它在正常运行里就不是 0：
 * 中继 credit() 之后、agent withdrawCredits() 之前（PULL 模式）、层内 exit() 之后、BSC claimExit() 之前、
 * burnFloat() 之后、以及任何人往 L2Bridge 直接转 1 wei，都会让它变正，而且可以被任何人永久地弄成非 0。
 * 一个正常运行时也响的告警会被运维关掉，而它是发现中继超发的手段。
 *
 * 所以现在按 L2Bridge **自己的计数**拆开（它们都是链上 public 变量，任何人都能读）：
 *   rawDiff = creditsPendingRelay + exitsPendingClaim + burnedFloat + creditableAndDonations
 *   creditsPendingRelay    = bscTotalIssued − L2Bridge.totalCredited            BSC 已发行、层内还没入账（中继延迟）
 *   exitsPendingClaim      = L2Bridge.totalExited − bscTotalExited              层内已销毁、BSC 还没兑付
 *   burnedFloat            = L2Bridge.totalBurnedFloat                          自愿销毁的浮存
 *   creditableAndDonations = B(L2Bridge) − (bridgeAlloc − totalCredited + totalExited + totalBurnedFloat)
 *                                                                               已入账未提走 + 直接转进来的币
 * 四项在正常运行里都 ≥ 0。告警只看**负的方向**：
 *   creditsPendingRelay < 0     层内入账超过 BSC 发行 —— 中继超发（reconcile_overmint）；
 *   exitsPendingClaim < 0       BSC 兑付超过层内销毁 —— 锚点 / 兑付出错（reconcile_overclaim）；
 *   creditableAndDonations < 0  L2Bridge 余额少于它的计数推出来的 —— 有币离开了 L2Bridge 而计数解释不了，
 *                               或创世文件与这条链对不上（reconcile_unexplained_outflow）。
 * diff = 负数项之和（正常是 0），ok = (diff == 0)。有输入读不到、又没有负数项时 diff / ok 是 null（不知道），不是 0 / true。
 * 已知局限（照实写在 note 里）：直接转进 L2Bridge 的币和未提走的积分合在一项，一笔等额的转入能盖住等额的来历不明流出 ——
 * 但那要真金白银地转进去；中继超发（creditsPendingRelay）两边都是计数，盖不住。
 */
export const RECONCILE_FORMULA =
  "rawDiff = (bscTotalIssued - bscTotalExited + genesisAlloc) - (layerCirculating + feeSinkBalance + feeSplitterBalance + sum(validatorBalances))" +
  " = bscTotalIssued - bscTotalExited - bridgeAlloc + l2Bridge.balance" +
  " = creditsPendingRelay + exitsPendingClaim + burnedFloat + creditableAndDonations;" +
  " creditsPendingRelay = bscTotalIssued - l2Bridge.totalCredited;" +
  " exitsPendingClaim = l2Bridge.totalExited - bscTotalExited;" +
  " burnedFloat = l2Bridge.totalBurnedFloat;" +
  " creditableAndDonations = l2Bridge.balance - (bridgeAlloc - l2Bridge.totalCredited + l2Bridge.totalExited + l2Bridge.totalBurnedFloat);" +
  " diff = sum of the negative terms (all four are >= 0 in normal operation); ok = (diff == 0)";

/** 每一项的含义与「变负意味着什么」，原样放进 reconcile.terms。 */
export const RECONCILE_TERMS = {
  creditsPendingRelay: {
    meaning: "BSC 上已经发行、层内还没入账的积分。中继要等 BSC 确认（约 1 分钟）才 credit()，所以锁仓之后短时间内为正是正常的。",
    ifNegative: "层内入账超过了 BSC 上的发行：中继超发。",
    warning: "reconcile_overmint",
  },
  exitsPendingClaim: {
    meaning: "层内已经 exit() 销毁、BSC 上还没 claimExit() 兑付的积分。退出的人不来领，它就一直为正。",
    ifNegative: "BSC 兑付的退出超过了层内销毁的：锚点或兑付出了问题（也可能是索引器接的层内链不是这座桥服务的那条）。",
    warning: "reconcile_overclaim",
  },
  burnedFloat: {
    meaning: "burnFloat() 自愿销毁回 L2Bridge 的浮存（运营方烧掉用不完的中继浮存）。它不产生退出，永远不能在 BSC 上兑付。",
    ifNegative: null,
    warning: null,
  },
  creditableAndDonations: {
    meaning:
      "已经 credit() 入账、还没被 withdrawCredits() 提走的积分（L2Bridge 是 PULL 模式），加上任何人直接转进 L2Bridge 的币" +
      "（receive() 谁都能转；演练链上那把公开的 Hardhat 测试私钥也能转）。两者都只会让它变大。",
    ifNegative: "L2Bridge 的余额比它自己的计数推出来的少：有币离开了 L2Bridge 而计数解释不了，或者创世文件与这条链对不上。",
    warning: "reconcile_unexplained_outflow",
  },
};

/** 负数项 -> 告警键（snapshot.js 用它打 / 清告警）。 */
export const RECONCILE_TERM_WARNINGS = Object.fromEntries(
  Object.entries(RECONCILE_TERMS)
    .filter(([, t]) => t.warning)
    .map(([k, t]) => [k, t.warning])
);

export const GENESIS_ALLOC_NOTE =
  "genesisAlloc 是创世文件里预置给 L2Bridge 以外地址的余额：这部分币从来没有经过 BSC 的桥，" +
  "所以必须单独加进公式，否则 rawDiff 永远等于它的相反数。它由哪些地址组成逐个列在 genesisAllocAccounts 里；" +
  "genesisSource 是索引器用的那份创世文件的公开下载地址（genesisFileHash 是它的 keccak256，与响应头 X-Genesis-Hash 相同），任何人都能下载复核。" +
  "演练链上它是唯一的预置测试账户（Hardhat 公开测试私钥，币没有任何价值）；正式链上它应当只有中继的运营浮存。";

export const RECONCILE_NOTE =
  "rawDiff 在正常运行里就不是 0：锁仓后中继还没入账、入账后 agent 还没提走（PULL 模式）、层内退出后还没在 BSC 领取、" +
  "运营方 burnFloat()、有人直接往 L2Bridge 转币，都会让它变大。所以它按 L2Bridge 自己的计数拆成 terms 里的四项逐项公开，" +
  "只有某一项变负（超发 / 超兑 / 来历不明的流出）才算对账不平：diff 是负数项之和，ok = (diff == 0)。" +
  "直接转进 L2Bridge 的币与未提走的积分合在 creditableAndDonations 一项里，一笔等额的转入能盖住等额的来历不明流出（但要真的转钱进去）；" +
  "中继超发看的是两边的计数，盖不住。FeeSink / FeeSplitter / 验证者余额在 rawDiff 里两边相消，它们只用来算 layerCirculating。";

const bigOrNull = (v) => (v === null || v === undefined || v === "" ? null : BigInt(v));

/**
 * 对账块。输入是快照里的 reconcile（字段见 snapshot.js），输出原样进 /api/health.reconcile。
 * 「合约地址上没有代码」时它的计数按 0 参与计算（合约不存在，不可能发生过入账 / 兑付），
 * 但发出去的读数仍是 null（什么也没读到），并把「按 0 计」的项逐个列在 structuralZeros 里。
 */
export function computeReconcile(r) {
  const structuralZeros = [];
  const bscAbsent = r.bscBridgeDeployed === false;
  const l2 = r.l2Bridge || {};
  const l2Absent = l2.hasCode === false;
  if (bscAbsent) structuralZeros.push("bscTotalIssued", "bscTotalExited");
  if (l2Absent) structuralZeros.push("l2Bridge.totalCredited", "l2Bridge.totalExited", "l2Bridge.totalBurnedFloat");

  const issued = bscAbsent ? 0n : bigOrNull(r.bscTotalIssued);
  const exited = bscAbsent ? 0n : bigOrNull(r.bscTotalExited);
  const circ = bigOrNull(r.layerCirculating);
  const sink = bigOrNull(r.feeSinkBalance);
  const splitter = bigOrNull(r.feeSplitterBalance);
  const genSupply = BigInt(r.genesisSupply ?? GENESIS_SUPPLY.toString());
  const genAlloc = BigInt(r.genesisAlloc ?? "0");
  const bridgeAlloc = r.bridgeAlloc === undefined || r.bridgeAlloc === null ? genSupply - genAlloc : BigInt(r.bridgeAlloc);
  const vals = (r.validatorBalances ?? []).map((v) => ({
    addr: v.addr,
    balance: BigInt(v.balance ?? "0").toString(),
  }));
  const vSum = vals.reduce((a, v) => a + BigInt(v.balance), 0n);

  const credited = l2Absent ? 0n : bigOrNull(l2.totalCredited);
  const l2Exited = l2Absent ? 0n : bigOrNull(l2.totalExited);
  const floatBurned = l2Absent ? 0n : bigOrNull(l2.totalBurnedFloat);
  const l2Balance = bigOrNull(l2.balance);

  const all = (...xs) => xs.every((x) => x !== null);
  const rawDiff =
    all(issued, exited, circ, sink, splitter) ? issued - exited + genAlloc - (circ + sink + splitter + vSum) : null;
  const termValues = {
    creditsPendingRelay: all(issued, credited) ? issued - credited : null,
    exitsPendingClaim: all(l2Exited, exited) ? l2Exited - exited : null,
    burnedFloat: floatBurned,
    creditableAndDonations:
      all(l2Balance, credited, l2Exited, floatBurned) ? l2Balance - (bridgeAlloc - credited + l2Exited + floatBurned) : null,
  };
  const values = Object.values(termValues);
  const negatives = values.filter((v) => v !== null && v < 0n);
  let diff;
  let ok;
  if (negatives.length) {
    diff = negatives.reduce((a, v) => a + v, 0n);
    ok = false;
  } else if (values.some((v) => v === null)) {
    diff = null;
    ok = null;
  } else {
    diff = 0n;
    ok = true;
  }
  const terms = {};
  for (const [k, t] of Object.entries(RECONCILE_TERMS)) {
    const v = termValues[k];
    terms[k] = {
      value: v === null ? null : v.toString(),
      alarm: v !== null && v < 0n,
      meaning: t.meaning,
      ifNegative: t.ifNegative,
    };
  }
  const missing = [];
  if (issued === null) missing.push("bscTotalIssued");
  if (exited === null) missing.push("bscTotalExited");
  if (l2Balance === null) missing.push("l2Bridge.balance");
  if (credited === null) missing.push("l2Bridge.totalCredited");
  if (l2Exited === null) missing.push("l2Bridge.totalExited");
  if (floatBurned === null) missing.push("l2Bridge.totalBurnedFloat");

  const str = (v) => (v === null || v === undefined ? null : String(v));
  const genesisRead = r.genesisSource !== null && r.genesisSource !== undefined;
  return {
    bscTotalIssued: bscAbsent ? null : str(r.bscTotalIssued),
    bscTotalExited: bscAbsent ? null : str(r.bscTotalExited),
    bscSource: r.bscSource ?? null,
    layerCirculating: circ === null ? null : circ.toString(),
    feeSinkBalance: sink === null ? null : sink.toString(),
    feeSplitterBalance: splitter === null ? null : splitter.toString(),
    validatorBalances: vals,
    genesisSupply: genSupply.toString(),
    genesisAlloc: genAlloc.toString(),
    bridgeAlloc: bridgeAlloc.toString(),
    genesisAllocAccounts: (r.genesisAllocAccounts ?? []).map((x) => ({ addr: x.addr, balance: String(x.balance) })),
    // 公开的下载地址（${apiBase}/api/genesis），不是服务器上的文件路径（决策 #6：运维细节不公开）
    genesisSource: r.genesisSource ?? null,
    genesisFileHash: r.genesisFileHash ?? null,
    l2Bridge: {
      address: l2.address ?? LAYER_SYSTEM_ADDRESSES.L2Bridge,
      block: l2.block === undefined || l2.block === null ? null : Number(l2.block),
      hasCode: l2.hasCode === undefined ? null : l2.hasCode,
      balance: str(l2.balance),
      totalCredited: l2Absent ? null : str(l2.totalCredited),
      totalExited: l2Absent ? null : str(l2.totalExited),
      totalBurnedFloat: l2Absent ? null : str(l2.totalBurnedFloat),
    },
    structuralZeros,
    missing,
    rawDiff: rawDiff === null ? null : rawDiff.toString(),
    terms,
    note:
      RECONCILE_NOTE +
      GENESIS_ALLOC_NOTE +
      (genesisRead ? "" : "（当前读不到创世文件：按设计值 1e27 全在 L2Bridge 计算，genesisAlloc 记 0。）") +
      (structuralZeros.length
        ? `（${structuralZeros.join("、")} 所在的合约地址上没有代码：合约不存在，不可能发生过入账或兑付，这几项按 0 计，读数本身是 null。）`
        : "") +
      (missing.length ? `（这一轮没读到：${missing.join("、")}，相关的项是 null。）` : ""),
    formula: RECONCILE_FORMULA,
    diff: diff === null ? null : diff.toString(),
    ok,
  };
}

/**
 * layerCirculating = genesisSupply − B_bridge − B_sink − B_splitter − Σ B_validator（03 §1.3）。
 * genesisSupply 取创世文件里全部 alloc 的和；读不到文件才退回设计值 1e27。
 */
export function layerCirculating({
  genesisSupply = GENESIS_SUPPLY,
  bridgeBalance,
  sinkBalance,
  splitterBalance = "0",
  validatorBalances = [],
}) {
  const vSum = validatorBalances.reduce((a, v) => a + BigInt(v.balance ?? v ?? "0"), 0n);
  return (
    BigInt(genesisSupply) -
    BigInt(bridgeBalance ?? "0") -
    BigInt(sinkBalance ?? "0") -
    BigInt(splitterBalance ?? "0") -
    vSum
  ).toString();
}

// ===================== BSC 侧 v2 的几个块（/api/health）=====================
// 形状固定：没部署 / 读不到的时候每个字段都在，值是 null —— 不是 0，也不是缺字段。

/** 决策 #29a 逐字定下的那句话。snapshot.js 拿它核对链上的 OWNER_POWER_NOTICE()，不一致就告警。 */
export const OWNER_POWER_NOTICE =
  "项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。";

/**
 * BSC 侧的数（treasury 行、桥的账）只在我们的合约部署之后才存在。stage = 'none'（链上没有我们的合约）时
 * 一律 null / 空：那时库里如果还有 treasury 行，只可能是旧版在合约不存在时写的一串 0（004 已经丢掉，这里再挡一道）。
 * stage = null（还没跑过快照 / 这一轮读不到 BSC）时照常给库里最后一次读数：v2 只在合约部署之后才写行。
 */
function bscMeasured(snapshot) {
  return !snapshot || snapshot.stage !== "none";
}

/**
 * treasury 最新一行。配了 BAC_BSC_START_BLOCK（部署块）时，比它更早的行一律不认 ——
 * 部署之前不可能有测量值。
 */
function latestTreasury(db, cfg) {
  const start = Number((cfg && cfg.bscStartBlock) || 0);
  return db.prepare("SELECT * FROM treasury WHERE bsc_block >= ? ORDER BY ts DESC LIMIT 1").get(start) || null;
}

/** health.bridge：桥代理的全部公开状态，外加 owner 的两项权力（决策 #29 / #29c / #33）。 */
export function bridgeBlock(cfg, snap = {}) {
  const b = (snap.bsc && snap.bsc.bridge) || {};
  const deployed = snap.bsc ? snap.bsc.bridgeDeployed ?? null : null;
  const v = (k) => (b[k] === undefined ? null : b[k]);
  return {
    address: (cfg.addresses && cfg.addresses.BacBridge) || null,
    deployed,
    proxy: "ERC1967 / UUPS",
    // 配置的地址是不是真的 ERC1967 代理（实现槽非空）。false = 多半把实现合约地址填成了桥：
    // 下面的读数一律是 null（实现合约自己的存储是空的，不是桥的真状态），并告警 bridge_not_proxy。
    isProxy: snap.bsc ? snap.bsc.bridgeIsProxy ?? null : null,
    owner: v("owner"),
    pendingOwner: v("pendingOwner"),
    implementation: v("implementation"),
    upgradeCount: v("upgradeCount"),
    lastUpgradeAt: v("lastUpgradeAt") || null,
    emergencyCount: v("emergencyCount"),
    lastEmergencyAt: v("lastEmergencyAt") || null,
    emergencyBnbWithdrawn: v("emergencyBnbWithdrawn"),
    emergencyBacWithdrawn: v("emergencyBacWithdrawn"),
    shortfall: b.shortfall || { bnbShort: null, bacShort: null, source: null },
    // 链上 OWNER_POWER_NOTICE 常量的原文（读不到是 null）；expected 是决策 #29a 逐字定下的那句，两者应当一致
    ownerPowerNotice: v("ownerPowerNotice"),
    ownerPowerNoticeExpected: OWNER_POWER_NOTICE,
    // 链上 description() 原文（桥对自己的一段说明，包含上面那句话；读不到是 null）
    description: v("description"),
    bacToken: v("bacToken"),
    identityRegistry: v("identityRegistry"),
    // 账（决策 #24：进桥的是 BAC，桥池收的是税收 BNB，退出兑付的是回购来的 BAC）
    bnbBalance: v("bnbBalance"),
    bnbHeld: v("bnbHeld"),
    lockedBac: v("lockedBac"),
    totalBurned: v("totalBurned"),
    buybackBac: v("buybackBac"),
    buybackBudget: v("buybackBudget"),
    buybackBacBought: v("buybackBacBought"),
    buybackBnbSpent: v("buybackBnbSpent"),
    currentRate: v("currentRate"),
    totalCreditsIssued: v("totalCreditsIssued"),
    totalCreditsExited: v("totalCreditsExited"),
    // 刹车 / 停机 / 逃生（仍然保留，但 owner 的权力在它们之上 —— 决策 #29b）
    paused: v("paused"),
    pausedUntil: v("pausedUntil"),
    pausedCumulativeSec: v("pausedCumulativeSec"),
    maxPauseTotalSec: 21 * 86400,
    halted: v("halted"),
    haltCause: v("haltCause"),
    pendingCause: v("pendingCause"),
    escapeArmedAt: v("escapeArmedAt") || null,
    armedCause: v("armedCause"),
    lastSettledEpoch: v("lastSettledEpoch"),
    skippedEpochs: v("skippedEpochs"),
    lastPot: v("lastPot"),
    releasedInWindow: v("releasedInWindow"),
    owedTotal: v("owedTotal"),
    reservedTotal: v("reservedTotal"),
  };
}

/** health.router：BacTaxRouter（决策 #30 / #32：无 owner、不可升级、没有 description()）。 */
export function routerBlock(cfg, snap = {}) {
  const t = (snap.bsc && snap.bsc.router) || {};
  const v = (k) => (t[k] === undefined ? null : t[k]);
  return {
    address: (cfg.addresses && cfg.addresses.BacTaxRouter) || null,
    deployed: snap.bsc ? snap.bsc.routerDeployed ?? null : null,
    owner: null,
    ownerNote: "这个合约没有 owner、没有管理员、没有升级入口、没有紧急提取；分账比例写死在代码里。",
    bridgeBps: v("bridgeBps"),
    feeNote: "Flap 先抽走 10% 协议费，到这里的是税的约 0.90 倍；50/50 按这个税后基数分。",
    balance: v("balance"),
    accountedQuote: v("accountedQuote"),
    unsplitRevenue: v("unsplitRevenue"),
    stuck: t.stuck || { bridge: null, nodeFund: null },
    lifetimeToBridge: v("lifetimeToBridge"),
    lifetimeToNodeFund: v("lifetimeToNodeFund"),
    totalRecognized: v("totalRecognized"),
    solvency: t.solvency || { balance: null, accounted: null, buckets: null },
    bridge: v("bridge"),
    nodeFund: v("nodeFund"),
    bacToken: v("bacToken"),
  };
}

/** health.nodeFund：官方节点基金（决策 #10：owner 可以随时提取这一半）。 */
export function nodeFundBlock(cfg, snap = {}) {
  const f = (snap.bsc && snap.bsc.nodeFund) || {};
  const v = (k) => (f[k] === undefined ? null : f[k]);
  return {
    address: (cfg.addresses && cfg.addresses.BacNodeFund) || null,
    deployed: snap.bsc ? snap.bsc.nodeFundDeployed ?? null : null,
    owner: v("owner"),
    pendingOwner: v("pendingOwner"),
    balance: v("balance"),
    lifetimeReceived: v("lifetimeReceived"),
    lifetimeWithdrawn: v("lifetimeWithdrawn"),
  };
}

/** health.identityRegistry：入场门禁读的是哪个 ERC-8004 注册表（决策 #31 / #31a）。 */
export function identityRegistryBlock(cfg, snap = {}) {
  const expected = (cfg.addresses && cfg.addresses.IdentityRegistry) || null;
  const onBridge = (snap.bsc && snap.bsc.bridge && snap.bsc.bridge.identityRegistry) || null;
  return {
    address: onBridge || expected,
    source: onBridge ? "BacBridge.identityRegistry()" : expected ? "config" : null,
    expected,
    matchesExpected: onBridge && expected ? onBridge.toLowerCase() === expected.toLowerCase() : null,
    standard: "ERC-8004",
    note: IDENTITY_NOTE,
  };
}

/** health.token：BAC 代币（决策 #35：地址已锁定；发射前这个地址上没有代码）。 */
export function tokenBlock(cfg, snap = {}) {
  const has = snap.bsc ? snap.bsc.tokenHasCode ?? null : null;
  const t = (snap.bsc && snap.bsc.token) || {};
  const v = (k) => (t[k] === undefined ? null : t[k]);
  return {
    address: (cfg.addresses && cfg.addresses.BacToken) || null,
    hasCode: has,
    launched: has,
    portal: (cfg.addresses && cfg.addresses.FlapPortal) || null,
    status: v("status"),
    statusName: t.status === undefined || t.status === null ? null : FLAP_TOKEN_STATUS[t.status] || null,
    price: v("price"),
    buyTaxBps: v("buyTaxBps"),
    sellTaxBps: v("sellTaxBps"),
    pool: v("pool"),
    progress: v("progress"),
    taxProcessor: v("taxProcessor"),
    marketAddress: v("marketAddress"),
    note:
      has === false
        ? "代币尚未发射：这个地址上还没有代码，价格、税率、交易数据都不存在，发射后公布。"
        : has === null
          ? "还没读到代币地址上的状态。"
          : "价格是 Flap Portal 的 getTokenV8Safe 读数（quote 单位，18 位小数），不是法币价格。",
  };
}

export function health(ctx) {
  const { db, cfg, snapshot = {} } = ctx;
  const snap = snapshot || {};
  const layer = snap.layer || {};
  const relayer = snap.relayer || {};
  const rec = computeReconcile(snap.reconcile || {});
  const idxLayer = cursorOf(db, "layer");
  const idxBsc = cursorOf(db, "bsc");
  const now = nowSec();

  const body = {
    // /2：v2 删掉了 vault 块，加了 stage / token / bridge / router / nodeFund / identityRegistry
    schema: "bac/health/2",
    // rec.ok 是 null（有输入没读到）时也不算 ok：没法担保的事不说成没事
    ok: rec.ok === true && listWarnings().length === 0,
    now,
    layer: {
      chainId: n(layer.chainId) ?? cfg.layerChainId,
      head: n(layer.head),
      headTs: n(layer.headTs),
      blockLagSec: n(layer.blockLagSec),
      // enode 来自 BAC_LAYER_ENODE（与公开的 node.json 同一条）；genesisHash 是链自己第 0 块的 hash
      enode: s(layer.enode) ?? cfg.layerEnode ?? null,
      genesisHash: s(layer.genesisHash),
      gasLimit: n(layer.gasLimit),
      baseFee: s(layer.baseFee),
      // 决策 #16：zeroBaseFee，链上没有 base fee，防刷靠固定 min-gas-price
      zeroBaseFee: true,
      minGasPrice: s(layer.minGasPrice) ?? "1000000000",
      peers: n(layer.peers),
    },
    relayer: {
      lastPostedEpoch: n(relayer.lastPostedEpoch),
      currentEpoch: n(relayer.currentEpoch) ?? epochOf(now),
      epochLag: n(relayer.epochLag),
      bscCursor: n(relayer.bscCursor),
      bscLagBlocks: n(relayer.bscLagBlocks),
      layerCursor: n(relayer.layerCursor),
      outboxNew: n(relayer.outboxNew),
      outboxSent: n(relayer.outboxSent),
      outboxOrphaned: n(relayer.outboxOrphaned),
      bscKeyBalance: s(relayer.bscKeyBalance),
      layerKeyBalance: s(relayer.layerKeyBalance),
    },
    reconcile: { ...rec, howToCheck: howToCheck(cfg) },
    // 决策 #17 的对账三联：已收 / 已转入 / 差额。单位全部是层内 BAC wei，不是 BNB。
    gas: gasBlock(ctx, snap),
    // BSC 侧处在哪个阶段：none | contracts_deployed | token_launched（读不到 BSC 是 null）
    stage: snap.stage ?? null,
    flap: {
      // 发射前 TaxProcessor 还不存在：这是 null（没法核对），不是 false（核对了但不对）
      marketAddressOk: snap.flap && snap.flap.marketAddressOk !== undefined ? snap.flap.marketAddressOk : null,
      checkedAt: snap.flap ? n(snap.flap.checkedAt) : null,
    },
    token: tokenBlock(cfg, snap),
    bridge: bridgeBlock(cfg, snap),
    router: routerBlock(cfg, snap),
    nodeFund: nodeFundBlock(cfg, snap),
    identityRegistry: identityRegistryBlock(cfg, snap),
    anchorCommitWindowEndsAt: n(snap.anchorCommitWindowEndsAt),
    rpc: {
      rateLimited24h: n((snap.rpc || {}).rateLimited24h) ?? 0,
      throttledAgents: (snap.rpc || {}).throttledAgents || [],
      limits: {
        ethGetLogsMaxRange: cfg.bscLogRangeMax,
        // §3.1 的示例里写的是 128，但 02 §5.3 明确把 Besu 的
        // --bonsai-historical-block-limit 定在 512，并注明「比 Clique 版的 128 块宽」。
        // 这里按 02 取 512，字段名不变（差异记在 README）。
        ethCallStateWindowBlocks: cfg.ethCallStateWindowBlocks ?? 512,
      },
    },
    indexer: {
      layerCursor: idxLayer,
      bscCursor: idxBsc,
      dbBytes: n(snap.dbBytes) ?? 0,
    },
    warnings: listWarnings(),
  };
  return { status: 200, body };
}

/**
 * `/api/health` 的 `gas` 块（03 §3.1，决策 #17）。
 * 数字全部来自 epochs 表里由 FINAL 锚点回填的逐 proposer 行；没有锚点就全部是 "0"，
 * 绝不拿官方节点的实时数冒充已锚定的数（§3.7 硬规则 2）。
 */
export function gasBlock(ctx, snap = {}) {
  const { db } = ctx;
  const row = db
    .prepare(
      `SELECT epoch, gas_fees, gas_remitted, gas_gap, pool_accrued, pool_claimed, foundation_accrued
         FROM epochs
        WHERE state = 'FINAL' AND gas_fees IS NOT NULL
        ORDER BY epoch DESC LIMIT 1`
    )
    .get();
  const received = BigInt((row && row.gas_fees) || "0");
  const remitted = BigInt((row && row.gas_remitted) || "0");
  const gap = received - remitted;
  const sp = snap.splitter || {};
  const shortfalls = db
    .prepare(
      `SELECT validator, proposer_addr AS proposer, cum_owed AS cumOwed, cum_remitted AS cumRemitted,
              arrears, rights, last_epoch AS lastEpoch
         FROM remittance WHERE shortfall = 1 ORDER BY validator`
    )
    .all();
  return {
    schemaNote: "决策 #17：gas 费按出块者分账。单位全部是层内 BAC wei，不是 BNB。",
    officialBlockValidatorBps: 1000,
    validatorBlockValidatorBps: 5000,
    lastAnchoredEpoch: row ? Number(row.epoch) : null,
    received: received.toString(),
    remitted: remitted.toString(),
    gap: gap.toString(),
    gapBps: received === 0n ? 0 : Number((gap * 10000n) / received),
    // 这五项要读层内 FeeSplitter，而快照还没有读它的代码（snap.splitter 从来没被赋值）：
    // 照实给 null（「没读」），不给 "0"（「读到了 0」）。
    operatorFloatReserve: s(sp.operatorFloatReserve),
    remitOverdueEpochs: n(sp.remitOverdueEpochs),
    poolPending: s(sp.poolPending),
    carryPool: s(sp.carryPool),
    foundationBalance: s(sp.foundationBalance),
    shortfalls: shortfalls.map((r) => ({
      validator: r.validator,
      proposer: r.proposer,
      cumOwed: s(r.cumOwed) ?? "0",
      cumRemitted: s(r.cumRemitted) ?? "0",
      arrears: s(r.arrears) ?? "0",
      // 03 §3.1 要求 rightsRevokedAt，但 §2 的 remittance 表没有对应列（文档内部不一致，
      // 记在仓库 README 的「待定」里）。出块资格已被撤销时退回 last_epoch，否则给 null，
      // 绝不编一个纪元号出来。
      rightsRevokedAt: Number(r.rights) === 0 ? n(r.lastEpoch) : null,
    })),
  };
}

function cursorOf(db, chain) {
  const row = db.prepare("SELECT last_block FROM cursor WHERE chain = ?").get(chain);
  return row ? Number(row.last_block) : 0;
}

// ===================== §3.2 /api/summary =====================

export function summary(ctx) {
  const { db, cfg } = ctx;
  const snapshot = ctx.snapshot || {};
  // stage = 'none'：链上没有我们的合约，BSC 侧的每一个数都不存在（null），库里残留的行一律不认。
  const measured = bscMeasured(snapshot);
  const t = measured ? latestTreasury(db, cfg) : null;
  const sb = (measured && snapshot.bridge) || {};
  const head = db.prepare("SELECT MAX(number) AS h FROM blocks").get();
  const txTotal = db.prepare("SELECT COUNT(*) AS c FROM txs").get();
  const contractsTotal = db.prepare("SELECT COUNT(*) AS c FROM contracts").get();
  const burned = db.prepare("SELECT fee_burned FROM txs").all();
  const burnedTotal = burned.reduce((acc, r) => acc + BigInt(r.fee_burned || "0"), 0n).toString();
  const totalAgents = Number(db.prepare("SELECT COUNT(*) AS c FROM agents").get().c);
  const idRead = db
    .prepare(
      "SELECT COUNT(*) AS c, SUM(CASE WHEN exists_on_registry = 1 THEN 1 ELSE 0 END) AS live FROM agent_identity WHERE checked_at IS NOT NULL"
    )
    .get();
  const ep = db.prepare("SELECT MAX(epoch) AS e FROM epochs WHERE state = 'POSTED' OR state = 'FINAL'").get();
  const epFinal = db.prepare("SELECT MAX(epoch) AS e FROM epochs WHERE state = 'FINAL'").get();
  const lastPosted = ep && ep.e != null ? Number(ep.e) : null;
  const lastState = lastPosted != null
    ? db.prepare("SELECT state, agreeing_count, disputing_wt FROM epochs WHERE epoch = ?").get(lastPosted)
    : null;
  const blockTimes = db.prepare("SELECT ts FROM blocks ORDER BY number DESC LIMIT 101").all();
  let blockTimeSec = null;
  if (blockTimes.length >= 2) {
    const span = Number(blockTimes[0].ts) - Number(blockTimes[blockTimes.length - 1].ts);
    blockTimeSec = Math.round((span / (blockTimes.length - 1)) * 10) / 10;
  }

  const body = {
    // /2：agents 块没有状态机分档了（challenged / active …），treasury 的 vault* 换成 router*
    schema: "bac/summary/2",
    layer: {
      head: head && head.h != null ? Number(head.h) : 0,
      blockTimeSec,
      txTotal: Number(txTotal.c),
      contractsTotal: Number(contractsTotal.c),
      circulating: s((snapshot.reconcile || {}).layerCirculating),
      burnedTotal,
    },
    // 决策 #31：一个 agent = 一个锁过桥的 ERC-8004 身份。没有状态机，所以只有「总数」和「身份读到了多少」。
    agents: {
      total: totalAgents,
      identityRead: Number(idRead.c || 0),
      identityPending: Math.max(0, totalAgents - Number(idRead.c || 0)),
      identityMissing: Number(idRead.c || 0) - Number(idRead.live || 0),
      note: IDENTITY_NOTE,
    },
    // 形状固定：合约没部署 / 没读到时每个字段都在，值是 null —— 不是 "0"。
    treasury: {
      taxFeeRateBps: n((snapshot.treasury || {}).taxFeeRateBps),
      routerBalance: t ? s(t.router_balance) : null,
      routerAccounted: t ? s(t.router_accounted) : null,
      lifetimeToBridge: t ? s(t.lifetime_to_bridge) : null,
      lifetimeToNodeFund: t ? s(t.lifetime_to_node) : null,
      poolBalance: t ? s(t.pool_balance) : null,
      nodeFundBalance: t ? s(t.node_fund_balance) : null,
      nodeFundWithdrawn: t ? s(t.node_fund_withdrawn) : null,
    },
    bridge: {
      totalLocked: t ? s(t.total_locked) : null,
      totalIssued: t ? s(t.total_issued) : null,
      totalExited: t ? s(t.total_exited) : null,
      buybackBac: t ? s(t.buyback_bac) : null,
      owedTotal: t ? s(t.owed_total) : null,
      emergencyBnbWithdrawn: t ? s(t.emergency_bnb_withdrawn) : null,
      emergencyBacWithdrawn: t ? s(t.emergency_bac_withdrawn) : null,
      lastSettledEpoch: n(sb.lastSettledEpoch),
      currentReleaseBps: n(sb.currentReleaseBps),
      paused: sb.paused ?? null,
      halted: sb.halted ?? null,
    },
    stage: snapshot.stage ?? null,
    validators: {
      nodes: validatorRows(db).length,
      totalStaked: validatorRows(db).reduce((a, v) => a + BigInt(v.staked || "0"), 0n).toString(),
      rewardBalance: t ? s(t.reward_balance) : null,
      lifetimeFunded: t ? s(t.reward_funded) : null,
      lifetimePaid: t ? s(t.reward_paid) : null,
    },
    // 决策 #17：层内 BAC 的 gas 费分账。**与上面的 treasury（BSC 上的 BNB 税收）单位不同、链不同、
    // 分法不同，网站上绝不允许相加成一个「总收入」**（03 §3.2 明令禁止）。
    gasFees: gasFeesSummary(db, t),
    // 决策 #19（03 §7.7）：agent 造出来的东西。**只有计数，没有金额** ——
    // 和 treasury / gasFees 一样，不得与任何 BAC / BNB 金额合并成一个「总量」。
    built: B.builtSummary(ctx),
    epoch: {
      // 与 lastPosted / lastFinal 同一个单位：600 秒的结算纪元（决策 #20）
      current: epochOf(nowSec()),
      lastPosted,
      lastFinal: epFinal && epFinal.e != null ? Number(epFinal.e) : null,
      state: lastState ? lastState.state : "NONE",
      agreeingCount: lastState ? n(lastState.agreeing_count) : null,
      disputingWeight: lastState ? s(lastState.disputing_wt) : null,
    },
    updatedAt: nowSec(),
  };
  return { status: 200, body };
}

/** §3.2 的 gasFees 块：全部从 epochs / proposer_income / treasury 三张表汇总，不预测、不年化。 */
export function gasFeesSummary(db, t) {
  // 金额是 wei（远超 2^63），SQLite 的 SUM 会直接溢出报错，所以逐行用 BigInt 加。
  const rows = db
    .prepare(
      `SELECT gas_fees, gas_remitted, pool_accrued, pool_claimed, foundation_accrued
         FROM epochs WHERE state = 'FINAL' AND gas_fees IS NOT NULL`
    )
    .all();
  const sum = (k) => rows.reduce((a, r) => a + BigInt(r[k] || "0"), 0n);
  const received = sum("gas_fees");
  const remitted = sum("gas_remitted");
  const proposers = db
    .prepare("SELECT official, COUNT(DISTINCT proposer) AS c FROM proposer_income GROUP BY official")
    .all();
  const byOfficial = Object.fromEntries(proposers.map((r) => [Number(r.official), Number(r.c)]));
  return {
    unit: "BAC",
    officialBlockValidatorBps: 1000,
    validatorBlockValidatorBps: 5000,
    lifetimeReceived: received.toString(),
    lifetimeRemitted: remitted.toString(),
    lifetimeGap: (received - remitted).toString(),
    lifetimeToPool: sum("pool_accrued").toString(),
    lifetimePoolClaimed: sum("pool_claimed").toString(),
    lifetimeToFoundation: sum("foundation_accrued").toString(),
    // FeeSplitter 的这两列还没有任何代码去读（treasury 里一直是 NULL）：照实给 null
    foundationWithdrawn: t ? s(t.lifetime_foundation_withdrawn) : null,
    carryPool: t ? s(t.splitter_pool_pending) : null,
    proposers: { official: byOfficial[1] || 0, validators: byOfficial[0] || 0 },
  };
}

// ===================== §3.3 /api/feed =====================

export function feed(ctx, q = {}) {
  const { db } = ctx;
  const limit = intParam(q.limit, 50, { min: 1, max: 200, name: "limit" });
  const after = q.after === undefined ? null : intParam(q.after, null, { name: "after" });
  const before = q.before === undefined ? null : intParam(q.before, null, { name: "before" });
  const where = [];
  const args = [];
  if (after !== null) {
    where.push("id > ?");
    args.push(after);
  }
  if (before !== null) {
    where.push("id < ?");
    args.push(before);
  }
  if (q.chain) {
    if (q.chain !== "bsc" && q.chain !== "layer") throw badRequest("chain 只能是 bsc 或 layer");
    where.push("chain = ?");
    args.push(q.chain);
  }
  if (q.kind) {
    const kinds = String(q.kind).split(",").map((x) => x.trim()).filter(Boolean);
    if (kinds.length === 0) throw badRequest("kind 不能为空");
    where.push(`kind IN (${kinds.map(() => "?").join(",")})`);
    args.push(...kinds);
  }
  if (q.agentId !== undefined) {
    where.push("agent_id = ?");
    args.push(intParam(q.agentId, null, { name: "agentId" }));
  }
  const sql = `SELECT * FROM feed ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ${
    after !== null ? "ASC" : "DESC"
  } LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit);
  const headRow = db.prepare("SELECT MAX(id) AS h FROM feed").get();
  return {
    status: 200,
    body: {
      schema: "bac/feed/1",
      items: rows.map((r) => ({
        id: Number(r.id),
        chain: r.chain,
        kind: r.kind,
        ts: Number(r.ts),
        block: Number(r.block),
        agentId: n(r.agent_id),
        textZh: r.text_zh,
        tx: r.tx,
        anchored: !!r.anchored,
        epoch: n(r.epoch),
      })),
      head: headRow && headRow.h != null ? Number(headRow.h) : 0,
      // 最新 FINAL 锚点的纪元号（600 秒纪元）与它承诺到的层内块高。
      // 条目的 anchored 按块高判断：block ≤ anchoredThroughBlock 才是 true（还没有 FINAL 锚点时是 null）。
      anchoredThrough: anchoredThrough(db),
      anchoredThroughBlock: anchoredThroughBlock(db),
      updatedAt: nowSec(),
    },
  };
}

// ===================== §3.4 /api/agents =====================

const AGENT_SORTS = {
  newest: "agent_id DESC",
  actions: "announces DESC, agent_id DESC",
  deploys: "deploys DESC, agent_id DESC",
  // credited 是旧名字，与 locked 同义（都按锁入的积分排）。
  // credited 是规范的十进制 wei 字符串（BigInt.toString，没有前导 0）：先按位数、再按字典序，就是按数值排。
  // 不许 CAST(... AS INTEGER)：SQLite 在 INT64_MAX（约 9.22 BAC 的 wei）处饱和，超过的全部并列，名次就乱了。
  locked: "length(credited) DESC, credited DESC, agent_id DESC",
  credited: "length(credited) DESC, credited DESC, agent_id DESC",
  // 决策 #19（§7.7）：按「发了多少币」「做了多少笔成交」排。
  // 这两个数不在 agents 表里，所以用子查询排 —— agents 表的列一个字都不动。
  tokens:
    "(SELECT COUNT(*) FROM tokens t WHERE t.creator_agent = agents.agent_id AND t.is_nft = 0 AND t.is_multi_token = 0) DESC, agent_id DESC",
  swaps: "(SELECT COUNT(*) FROM swaps sw WHERE sw.agent_id = agents.agent_id) DESC, agent_id DESC",
};

function walletsOf(db, agentId) {
  return db
    .prepare("SELECT wallet FROM agent_wallets WHERE agent_id = ? ORDER BY first_deposit_id ASC")
    .all(Number(agentId))
    .map((w) => w.wallet);
}

/**
 * /api/agents 的一行（决策 #31）：一个 agent = 一个锁过桥的 ERC-8004 身份 id。
 * holder / agentWallet 是注册表的链上事实（读不到就是 null，identityCheckedAt 也是 null）；
 * controller 是 BacBridge.agentController（第一次锁入的地址，逃生时能领钱的那个）；
 * layerWallets 是以这个身份进过桥的层内地址（Locked.layerWallet）。
 */
function agentRow(db, r, snapshot) {
  const balances = (snapshot && snapshot.layerBalances) || {};
  const idn = identityOf(db, Number(r.agent_id));
  const wallets = walletsOf(db, r.agent_id);
  const lockCount = Number(db.prepare("SELECT COUNT(*) AS c FROM deposits WHERE agent_id = ?").get(Number(r.agent_id)).c);
  return {
    agentId: Number(r.agent_id),
    holder: idn.holder,
    agentWallet: idn.agentWallet,
    identityExists: idn.exists,
    identityCheckedAt: idn.checkedAt,
    registrationName: idn.registration.name,
    selfReported: true,
    controller: r.controller,
    layerWallets: wallets.length ? wallets : [r.wallet],
    firstLockAt: n(r.registered_at),
    firstLockBlock: n(r.first_lock_block),
    lockCount,
    creditsLocked: r.credited,
    creditsExited: r.exited,
    layerBalance: balances[r.wallet] ?? null,
    deploys: Number(r.deploys),
    announces: Number(r.announces),
    lastLayerBlock: n(r.last_layer_tx),
    // 决策 #19（§7.7）：三个计数。它们是「agent 造了什么 / 做了多少交易」的入口。
    ...B.agentBuiltCounts(db, Number(r.agent_id)),
  };
}

export function agents(ctx, q = {}) {
  const { db, snapshot } = ctx;
  const page = intParam(q.page, 1, { min: 1, name: "page" });
  const pageSize = intParam(q.pageSize, 50, { min: 1, max: 200, name: "pageSize" });
  const sort = q.sort || "newest";
  if (!AGENT_SORTS[sort]) throw badRequest("sort 只能是 newest|actions|deploys|locked|tokens|swaps");
  if (q.status !== undefined && q.status !== "") {
    // 决策 #31：状态机整个删掉了。与其静默忽略、让调用方以为过滤生效了，不如直接告诉它。
    throw badRequest("status 参数已取消：决策 #31 之后没有 agent 状态机，agent 就是锁过桥的 ERC-8004 身份");
  }
  const total = Number(db.prepare("SELECT COUNT(*) AS c FROM agents").get().c);
  const rows = db
    .prepare(`SELECT * FROM agents ORDER BY ${AGENT_SORTS[sort]} LIMIT ? OFFSET ?`)
    .all(pageSize, (page - 1) * pageSize);
  return {
    status: 200,
    body: {
      schema: "bac/agents/2",
      total,
      page,
      pageSize,
      items: rows.map((r) => agentRow(db, r, snapshot)),
      note: IDENTITY_NOTE,
    },
  };
}

// ===================== §3.5 /api/agent/{id} =====================

export function agent(ctx, id) {
  const { db, snapshot } = ctx;
  const agentId = intParam(id, null, { name: "agentId" });
  const r = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId);
  if (!r) throw notFound(`没有 agent #${agentId}`);
  const deposits = db
    .prepare("SELECT * FROM deposits WHERE agent_id = ? ORDER BY deposit_id DESC")
    .all(agentId)
    .map((d) => ({
      depositId: Number(d.deposit_id),
      from: d.from_addr,
      layerWallet: d.layer_wallet,
      measured: d.measured,
      credits: d.credits,
      bscBlock: Number(d.bsc_block),
      bscTx: d.bsc_tx,
      layerTx: s(d.layer_tx),
      lagSec: n(d.lag_sec),
    }));
  const exits = db
    .prepare("SELECT * FROM exits WHERE agent_id = ? ORDER BY exit_id DESC")
    .all(agentId)
    .map((e) => ({
      exitId: Number(e.exit_id),
      credits: e.credits,
      bornEpoch: Number(e.born_epoch),
      anchorEpoch: n(e.anchor_epoch),
      layerTx: e.layer_tx,
      claimedTx: s(e.claimed_tx),
      // v2（决策 #24）：claimExit 锁定的是回购来的 BAC，不是 BNB。单位 BAC 的 wei。
      lockedBac: s(e.locked_wei),
      // 按退出单领了多少：Collected 事件只带 (who, to, amount, owedLeft)，没有 exitId，
      // 索引器没法把一笔领取归到某一笔退出上（collected_wei 从来没人写）。照实给 null，不给 "0"。
      collectedBac: null,
    }));
  const contracts = db
    .prepare("SELECT * FROM contracts WHERE agent_id = ? ORDER BY block DESC")
    .all(agentId)
    .map((c) => ({
      address: c.address,
      block: Number(c.block),
      codeSize: Number(c.code_size),
      callCount: Number(c.call_count),
      // 决策 #19（§7.7）：这个合约是个什么。判不出来就是 null + 一句照实说的中文。
      classified: B.classifiedOf(db, c.address),
      classifiedZh: classifiedZh(B.classifiedOf(db, c.address)),
      symbol: B.symbolOf(db, c.address),
    }));
  const actions = db
    .prepare("SELECT * FROM actions WHERE agent_id = ? ORDER BY seq DESC LIMIT 200")
    .all(agentId)
    .map((a) => ({
      seq: Number(a.seq),
      kind: a.kind,
      subject: s(a.subject),
      summary: a.summary,
      uri: a.uri,
      block: Number(a.block),
      tx: a.tx,
      ts: Number(a.ts),
    }));
  const weight = BigInt(r.credited || "0") - BigInt(r.exited || "0");
  return {
    status: 200,
    body: {
      schema: "bac/agent/2",
      agent: agentRow(db, r, snapshot),
      // ERC-8004 身份（决策 #31）。registration 是持有人自己写的，selfReported 恒为 true。
      identity: identityOf(db, agentId, (ctx.cfg && ctx.cfg.addresses && ctx.cfg.addresses.IdentityRegistry) || null),
      deposits,
      exits,
      contracts,
      actions,
      escape: {
        halted: (snapshot && snapshot.bridge && snapshot.bridge.halted) ?? null,
        controller: r.controller,
        // BacBridge.escapeClaimable 用的权重就是 credited − exitedCredits
        weight: (weight > 0n ? weight : 0n).toString(),
        // 逃生可领额只在停机后才有（escapeClaimable 在未停机时恒为 0,0）；索引器不代算，给 null
        claimable: null,
      },
      // 决策 #19（§7.7）：它造了什么、它交易了什么、它手上拿着什么。
      // holdings 的金额是**每个代币自己的最小单位**，不是 BAC 的 wei，不得与上面的 credited / exited 相加。
      ...B.agentBuilt(ctx, agentId),
      detection: B.detection(ctx),
    },
  };
}

// ===================== §3.6 区块 / 交易 / 合约 =====================

const blockOut = (b) => ({
  number: Number(b.number),
  hash: b.hash,
  ts: Number(b.ts),
  txCount: Number(b.tx_count),
  gasUsed: Number(b.gas_used),
  gasLimit: Number(b.gas_limit),
  baseFee: b.base_fee,
  epoch: Number(b.epoch),
});

export function blocks(ctx, q = {}) {
  const { db } = ctx;
  let rows;
  if (q.from !== undefined || q.to !== undefined) {
    const from = intParam(q.from, 0, { name: "from" });
    const to = intParam(q.to, from + 49, { name: "to" });
    if (to < from) throw badRequest("to 不能小于 from");
    rows = db.prepare("SELECT * FROM blocks WHERE number >= ? AND number <= ? ORDER BY number DESC LIMIT 200").all(from, to);
  } else {
    const limit = intParam(q.limit, 50, { min: 1, max: 200, name: "limit" });
    const head = q.head === undefined ? null : intParam(q.head, null, { name: "head" });
    rows =
      head === null
        ? db.prepare("SELECT * FROM blocks ORDER BY number DESC LIMIT ?").all(limit)
        : db.prepare("SELECT * FROM blocks WHERE number <= ? ORDER BY number DESC LIMIT ?").all(head, limit);
  }
  return { status: 200, body: { schema: "bac/blocks/1", items: rows.map(blockOut) } };
}

const txOut = (t) => ({
  hash: t.hash,
  block: Number(t.block),
  idx: Number(t.idx),
  from: t.from_addr,
  to: s(t.to_addr),
  value: t.value,
  gasUsed: Number(t.gas_used),
  effGasPrice: t.eff_gas_price,
  // 决策 #16：zeroBaseFee 之后链上没有 base fee，也没有任何销毁，所以这个字段恒为 "0"。
  // **旧字段保留但必须返回 "0"，不许删**，否则已经在用的 SDK 会静默拿到错的数（03 §3.7）。
  feeBurned: "0",
  // 决策 #17：这笔交易的 gas 费全额进出块者的 EOA。
  feeToProposer: (BigInt(t.gas_used || 0) * BigInt(t.eff_gas_price || "0")).toString(),
  created: s(t.created),
  status: Number(t.status),
  agentId: n(t.agent_id),
  ts: Number(t.ts),
});

export function block(ctx, num) {
  const { db } = ctx;
  const number = intParam(num, null, { name: "区块号" });
  const b = db.prepare("SELECT * FROM blocks WHERE number = ?").get(number);
  if (!b) throw notFound(`没有区块 ${number}`);
  const txs = db.prepare("SELECT * FROM txs WHERE block = ? ORDER BY idx ASC").all(number);
  // 决策 #19（§7.7）：每条交易追加两个计数，让区块页能一眼看出「这个块里有交易发生」。
  const countIn = (table, hash) =>
    Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE tx = ?`).get(hash).c);
  return {
    status: 200,
    body: {
      schema: "bac/block/1",
      ...blockOut(b),
      txs: txs.map((t) => ({
        ...txOut(t),
        swapCount: countIn("swaps", t.hash),
        transferCount: countIn("token_transfers", t.hash),
      })),
    },
  };
}

export function txByHash(ctx, hash) {
  const { db } = ctx;
  const h = String(hash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw badRequest("交易哈希必须是 0x 前缀的 66 字符");
  const t = db.prepare("SELECT * FROM txs WHERE hash = ?").get(h);
  if (!t) throw notFound(`没有交易 ${h}`);
  const logs = db
    .prepare("SELECT * FROM logs WHERE tx = ? ORDER BY log_index ASC")
    .all(h)
    .map((l) => ({ address: l.address, topics: JSON.parse(l.topics), data: l.data }));
  const dec = db
    .prepare("SELECT * FROM decoded_events WHERE tx = ? ORDER BY log_index ASC")
    .all(h)
    .map((d) => ({ event: d.event, args: JSON.parse(d.args) }));
  // 决策 #19（§7.7）：这笔交易里所有已识别代币的转账与成交。
  // 两者都可能为空数组；**空数组和 null 不是一回事，永远返回数组**。
  const transfers = db
    .prepare("SELECT * FROM token_transfers WHERE tx = ? ORDER BY log_index ASC")
    .all(h)
    .map(B.transferOut);
  const swapRows = db
    .prepare("SELECT * FROM swaps WHERE tx = ? ORDER BY log_index ASC")
    .all(h)
    .map((r) => B.swapOut(db, r));
  return {
    status: 200,
    body: {
      schema: "bac/tx/1",
      tx: txOut(t),
      logs,
      decoded: dec.length ? dec : null,
      transfers,
      swaps: swapRows,
      detection: B.detection(ctx),
    },
  };
}

/** 决策 #19（§7.6 末尾）：按分类过滤合约。判不出来的那一档写 none —— 它照样是 agent 造出来的东西。 */
const CLASSIFIED_SQL = {
  token:
    "EXISTS (SELECT 1 FROM tokens t WHERE t.address = contracts.address AND t.is_nft = 0 AND t.is_multi_token = 0)",
  pair: "EXISTS (SELECT 1 FROM pairs p WHERE p.address = contracts.address)",
  factory: "EXISTS (SELECT 1 FROM amm_factories f WHERE f.address = contracts.address)",
  nft:
    "(EXISTS (SELECT 1 FROM contract_probes pr WHERE pr.address = contracts.address AND pr.state = 'nft') OR EXISTS (SELECT 1 FROM tokens t WHERE t.address = contracts.address AND t.is_nft = 1))",
  multi_token:
    "(EXISTS (SELECT 1 FROM contract_probes pr WHERE pr.address = contracts.address AND pr.state = 'multi_token') OR EXISTS (SELECT 1 FROM tokens t WHERE t.address = contracts.address AND t.is_multi_token = 1))",
};

export function contracts(ctx, q = {}) {
  const { db } = ctx;
  const page = intParam(q.page, 1, { min: 1, name: "page" });
  const pageSize = intParam(q.pageSize, 50, { min: 1, max: 200, name: "pageSize" });
  const where = [];
  const args = [];
  if (q.agentId !== undefined) {
    where.push("agent_id = ?");
    args.push(intParam(q.agentId, null, { name: "agentId" }));
  }
  if (q.address !== undefined) {
    where.push("address = ?");
    args.push(B.addressParam(q.address, "address"));
  }
  if (q.classified !== undefined) {
    const k = String(q.classified);
    if (k === "none" || k === "null") {
      where.push(`NOT (${Object.values(CLASSIFIED_SQL).join(" OR ")})`);
    } else if (CLASSIFIED_SQL[k]) {
      where.push(CLASSIFIED_SQL[k]);
    } else {
      throw badRequest("classified 只能是 token|pair|factory|multi_token|nft|none");
    }
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM contracts ${whereSql}`).get(...args).c);
  const rows = db
    .prepare(`SELECT * FROM contracts ${whereSql} ORDER BY block DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  return {
    status: 200,
    body: {
      schema: "bac/contracts/1",
      total,
      items: rows.map((c) => ({
        address: c.address,
        deployer: c.deployer,
        agentId: n(c.agent_id),
        block: Number(c.block),
        ts: Number(c.ts),
        codeSize: Number(c.code_size),
        callCount: Number(c.call_count),
        lastCall: n(c.last_call),
        classified: B.classifiedOf(db, c.address),
        classifiedZh: classifiedZh(B.classifiedOf(db, c.address)),
        symbol: B.symbolOf(db, c.address),
      })),
      detection: B.detection(ctx),
    },
  };
}

// ===================== 纪元 =====================

function epochOut(db, e) {
  const atts = db.prepare("SELECT * FROM attestations WHERE epoch = ?").all(Number(e.epoch));
  return {
    epoch: Number(e.epoch),
    state: e.state,
    exitRoot: s(e.exit_root),
    l2Block: n(e.l2_block),
    l2BlockHash: s(e.l2_block_hash),
    credited: s(e.credited),
    exitCredits: s(e.exit_credits),
    feeBurned: s(e.fee_burned),
    circulating: s(e.circulating),
    exitCount: n(e.exit_count),
    postedAt: n(e.posted_at),
    postedTx: s(e.posted_tx),
    finalizedAt: n(e.finalized_at),
    agreeingCount: n(e.agreeing_count),
    agreeingWt: s(e.agreeing_wt),
    disputingWt: s(e.disputing_wt),
    releaseBps: n(e.release_bps),
    pot: s(e.pot),
    rate: s(e.rate),
    settledAt: n(e.settled_at),
    rewardPot: s(e.reward_pot),
    attestationCount: atts.length,
    agreeingAttestations: atts.filter((a) => a.agreeing === 1).length,
    disputingAttestations: atts.filter((a) => a.agreeing === 0).length,
  };
}

export function epochs(ctx, q = {}) {
  const { db } = ctx;
  let rows;
  if (q.from !== undefined || q.to !== undefined) {
    const from = intParam(q.from, 0, { name: "from" });
    const to = intParam(q.to, from, { name: "to" });
    if (to < from) throw badRequest("to 不能小于 from");
    rows = db.prepare("SELECT * FROM epochs WHERE epoch >= ? AND epoch <= ? ORDER BY epoch DESC").all(from, to);
  } else {
    const limit = intParam(q.limit, 30, { min: 1, max: 200, name: "limit" });
    rows = db.prepare("SELECT * FROM epochs ORDER BY epoch DESC LIMIT ?").all(limit);
  }
  return { status: 200, body: { schema: "bac/epochs/1", items: rows.map((e) => epochOut(db, e)) } };
}

export function epoch(ctx, num) {
  const { db } = ctx;
  const e = intParam(num, null, { name: "纪元号" });
  const row = db.prepare("SELECT * FROM epochs WHERE epoch = ?").get(e);
  if (!row) throw notFound(`没有纪元 ${e}`);
  const attestations = db
    .prepare("SELECT * FROM attestations WHERE epoch = ? ORDER BY validator ASC")
    .all(e)
    .map((a) => ({
      validator: a.validator,
      nodeId: s(a.node_id),
      exitRoot: s(a.exit_root),
      l2Block: n(a.l2_block),
      l2BlockHash: s(a.l2_block_hash),
      weight: s(a.weight),
      agreeing: a.agreeing === null || a.agreeing === undefined ? null : a.agreeing === 1,
    }));
  return { status: 200, body: { schema: "bac/epoch/1", ...epochOut(db, row), attestations } };
}

function leavesOf(db, e) {
  return db
    .prepare("SELECT exit_id, agent_id, to_addr, credits, born_epoch FROM exits WHERE anchor_epoch = ? ORDER BY exit_id ASC")
    .all(Number(e));
}

export function epochLeaves(ctx, num) {
  const { db, cfg } = ctx;
  const e = intParam(num, null, { name: "纪元号" });
  const row = db.prepare("SELECT * FROM epochs WHERE epoch = ?").get(e);
  if (!row) throw notFound(`没有纪元 ${e}`);
  const bridge = cfg.addresses && cfg.addresses.BacBridge;
  const rows = leavesOf(db, e);
  const leaves = rows.map((r) => ({
    exitId: Number(r.exit_id),
    agentId: Number(r.agent_id),
    to: r.to_addr,
    credits: r.credits,
    leaf: bridge
      ? leafHash(
          { exitId: BigInt(r.exit_id), agentId: BigInt(r.agent_id), to: r.to_addr, credits: BigInt(r.credits) },
          cfg.layerChainId,
          bridge
        )
      : null,
  }));
  return {
    status: 200,
    body: {
      schema: "bac/leaves/1",
      epoch: e,
      exitRoot: s(row.exit_root) ?? ZERO_ROOT,
      leaves,
      proofFor: `${cfg.apiBase}/api/epoch/${e}/proof/{exitId}`,
    },
  };
}

export function epochProof(ctx, num, exitIdRaw) {
  const { db, cfg } = ctx;
  const e = intParam(num, null, { name: "纪元号" });
  const exitId = intParam(exitIdRaw, null, { name: "exitId" });
  const row = db.prepare("SELECT * FROM epochs WHERE epoch = ?").get(e);
  if (!row) throw notFound(`没有纪元 ${e}`);
  const bridge = cfg.addresses && cfg.addresses.BacBridge;
  if (!bridge) throw notFound("没有配置 BacBridge 地址，无法给出证明");
  const rows = leavesOf(db, e);
  const mine = rows.find((r) => Number(r.exit_id) === exitId);
  if (!mine) throw notFound(`纪元 ${e} 的叶子里没有 exitId=${exitId}`);
  const leaves = rows.map((r) => ({
    exitId: BigInt(r.exit_id),
    agentId: BigInt(r.agent_id),
    to: r.to_addr,
    credits: BigInt(r.credits),
  }));
  const localRoot = exitRootOf(leaves, cfg.layerChainId, bridge);
  // 本地重算的根与链上锚点对不上就不发证明：发一个对不上的证明会让 claimExit revert，
  // 而用户的积分在层内早就销毁了（「宁可停，不可错」）。
  if (row.exit_root && localRoot.toLowerCase() !== String(row.exit_root).toLowerCase()) {
    throw new ApiError(
      "internal",
      `纪元 ${e} 的本地叶子重算出的 exitRoot 与链上锚点不一致，证明暂不可用`,
      500
    );
  }
  const p = proofOf(leaves, BigInt(exitId), cfg.layerChainId, bridge);
  return {
    status: 200,
    body: {
      schema: "bac/proof/2",
      exitId,
      agentId: Number(mine.agent_id),
      to: mine.to_addr,
      credits: mine.credits,
      anchorEpoch: e,
      bornEpoch: Number(mine.born_epoch),
      leaf: leafHash(
        { exitId: BigInt(mine.exit_id), agentId: BigInt(mine.agent_id), to: mine.to_addr, credits: BigInt(mine.credits) },
        cfg.layerChainId,
        bridge
      ),
      proof: p,
      exitRoot: s(row.exit_root) ?? localRoot,
      bridge,
      layerChainId: cfg.layerChainId,
    },
  };
}

// ===================== /api/rate =====================

/**
 * 决策 #24：退出兑付的是桥用 BNB 回购来的 BAC，所以汇率是「每 1 积分约多少 BAC」，不是 BNB。
 * 与 BacBridge.currentRate() 同一个口径：(buybackBac − owedTotal) × 1e18 / (issued − exited)，outstanding 为 0 时是 0。
 * 能读到链上 currentRate() 就用链上的；否则按同一公式现算 —— 四个输入必须来自同一次读数
 * （本轮快照读到的桥，或 treasury 最新一行），缺一个就不算。
 * 合约没部署（stage = 'none'）、或者既没有链上值也没有部署后的读数：一律 null，不给 "0"。
 */
export function rate(ctx) {
  const { db, cfg } = ctx;
  const snapshot = ctx.snapshot || {};
  const measured = bscMeasured(snapshot);
  const t = measured ? latestTreasury(db, cfg) : null;
  const br = (measured && snapshot.bridge) || {};
  const live = (measured && snapshot.bsc && snapshot.bsc.bridge) || {};
  const has = (...xs) => xs.every((x) => x !== null && x !== undefined);

  let basis = null;
  if (has(live.buybackBac, live.owedTotal, live.totalCreditsIssued, live.totalCreditsExited)) {
    basis = { buyback: live.buybackBac, owed: live.owedTotal, issued: live.totalCreditsIssued, exited: live.totalCreditsExited, from: "本轮快照读到的桥" };
  } else if (t && has(t.buyback_bac, t.owed_total, t.total_issued, t.total_exited)) {
    basis = { buyback: t.buyback_bac, owed: t.owed_total, issued: t.total_issued, exited: t.total_exited, from: "treasury 最新一行" };
  }
  let buyback = null;
  let owed = null;
  let outstanding = null;
  let computed = null;
  if (basis) {
    const bb = BigInt(basis.buyback);
    const ow = BigInt(basis.owed);
    const is = BigInt(basis.issued);
    const ex = BigInt(basis.exited);
    const out = is > ex ? is - ex : 0n;
    const free = bb > ow ? bb - ow : 0n;
    buyback = bb.toString();
    owed = ow.toString();
    outstanding = out.toString();
    computed = out > 0n ? ((free * 10n ** 18n) / out).toString() : "0";
  }
  const onChain = s(br.currentRate);
  const potRow = db.prepare("SELECT pot FROM epochs WHERE pot IS NOT NULL ORDER BY epoch DESC LIMIT 1").get();
  const lastPot = measured ? s(live.lastPot) ?? (potRow ? s(potRow.pot) : null) : null;
  return {
    status: 200,
    body: {
      schema: "bac/rate/2",
      unit: "BAC",
      bacPerCredit: onChain ?? computed,
      source:
        onChain !== null
          ? "BacBridge.currentRate()"
          : computed !== null
            ? `${basis.from}按 currentRate() 的公式现算`
            : null,
      buybackBac: buyback,
      owedTotal: owed,
      creditsOutstanding: outstanding,
      lastPot,
      note: "估算 · 不承诺任何金额 · 兑付的是回购来的 BAC，比直接拿 BNB 多损耗约 4%",
    },
  };
}

// ===================== /api/validators =====================

/** §2 没有 validators 表，所以这里从 decoded_events + attestations 现算，不新增表。 */
export function validatorRows(db) {
  const rows = db
    .prepare("SELECT event, args, block FROM decoded_events WHERE contract = 'ValidatorStaking' ORDER BY block ASC, log_index ASC")
    .all();
  const byValidator = new Map();
  const get = (v) => {
    if (!byValidator.has(v))
      byValidator.set(v, {
        nodeId: null,
        validator: v,
        payout: null,
        enodeURI: null,
        active: false,
        strikes: 0,
        staked: "0",
        lastEpoch: null,
        agreedEpochs: 0,
        disputedEpochs: 0,
        lifetimeClaimed: "0",
      });
    return byValidator.get(v);
  };
  const nodeOwner = new Map();
  for (const r of rows) {
    const a = JSON.parse(r.args);
    switch (r.event) {
      case "Staked":
        get(a.who).staked = String(a.total);
        break;
      case "Unstaked": {
        const v = get(a.who);
        v.staked = (BigInt(v.staked) - BigInt(a.amount) > 0n ? BigInt(v.staked) - BigInt(a.amount) : 0n).toString();
        break;
      }
      case "NodeRegistered": {
        const v = get(a.validator);
        v.nodeId = a.nodeIdHash;
        v.payout = a.payout;
        v.enodeURI = a.enodeURI;
        v.active = true;
        nodeOwner.set(a.nodeIdHash, a.validator);
        break;
      }
      case "NodeRetired": {
        const owner = nodeOwner.get(a.nodeIdHash);
        if (owner) get(owner).active = false;
        break;
      }
      case "NodeStruck": {
        const owner = nodeOwner.get(a.nodeIdHash);
        if (owner) get(owner).strikes = Number(a.strikes);
        break;
      }
      case "RewardClaimed": {
        const v = get(a.validator);
        v.lifetimeClaimed = (BigInt(v.lifetimeClaimed) + BigInt(a.amount)).toString();
        break;
      }
      case "ValidatorRemoved":
        get(a.v).active = false;
        break;
      default:
        break;
    }
  }
  for (const att of db.prepare("SELECT * FROM attestations").all()) {
    const v = get(att.validator);
    if (v.lastEpoch === null || Number(att.epoch) > v.lastEpoch) v.lastEpoch = Number(att.epoch);
    if (att.agreeing === 1) v.agreedEpochs += 1;
    if (att.agreeing === 0) v.disputedEpochs += 1;
  }
  return [...byValidator.values()].sort((a, b) => (a.validator < b.validator ? -1 : 1));
}

export function validators(ctx) {
  const { db, cfg } = ctx;
  const items = validatorRows(db);
  const t = bscMeasured(ctx.snapshot) ? latestTreasury(db, cfg) : null;
  return {
    status: 200,
    body: {
      schema: "bac/validators/1",
      items,
      totalStaked: items.reduce((a, v) => a + BigInt(v.staked || "0"), 0n).toString(),
      // ValidatorStaking.rewardBalance()；没部署 / 没读到是 null，不是 "0"
      rewardBalance: t ? s(t.reward_balance) : null,
    },
  };
}

// ===================== /api/treasury =====================

export function treasury(ctx, q = {}) {
  const { db, cfg } = ctx;
  const from = intParam(q.from, 0, { name: "from" });
  const to = intParam(q.to, 9999999999, { name: "to" });
  if (to < from) throw badRequest("to 不能小于 from");
  // stage = 'none'：链上没有我们的合约，不可能有任何测量值 —— 空数组，不把残留行当读数发出去。
  // 配了 BAC_BSC_START_BLOCK 时，比部署块更早的行一律不认。
  const start = Number((cfg && cfg.bscStartBlock) || 0);
  const rows = bscMeasured(ctx.snapshot)
    ? db
        .prepare("SELECT * FROM treasury WHERE ts >= ? AND ts <= ? AND bsc_block >= ? ORDER BY ts DESC LIMIT 2000")
        .all(from, to, start)
    : [];
  return {
    status: 200,
    body: {
      // /2：vault* 换成 router*，加了桥 v2 的几列；某一轮没读到的值是 null（004 起列可空），不是 "0"
      schema: "bac/treasury/2",
      items: rows.map((r) => ({
        ts: Number(r.ts),
        bscBlock: Number(r.bsc_block),
        routerBalance: s(r.router_balance),
        routerAccounted: s(r.router_accounted),
        routerUnsplit: s(r.router_unsplit),
        routerStuckBridge: s(r.router_stuck_bridge),
        routerStuckNodeFund: s(r.router_stuck_node),
        lifetimeToBridge: s(r.lifetime_to_bridge),
        lifetimeToNode: s(r.lifetime_to_node),
        // 004 起：BacBridge.bnbBalance()（账上为回购留着的税收 BNB）；bridgeBnbHeld 是合约地址上实际的 BNB
        poolBalance: s(r.pool_balance),
        bridgeBnbHeld: s(r.bridge_bnb_held),
        buybackBac: s(r.buyback_bac),
        owedTotal: s(r.owed_total),
        emergencyBnbWithdrawn: s(r.emergency_bnb_withdrawn),
        emergencyBacWithdrawn: s(r.emergency_bac_withdrawn),
        nodeFundBalance: s(r.node_fund_balance),
        nodeFundWithdrawn: s(r.node_fund_withdrawn),
        totalLocked: s(r.total_locked),
        totalIssued: s(r.total_issued),
        totalExited: s(r.total_exited),
        rewardBalance: s(r.reward_balance),
        rewardFunded: s(r.reward_funded),
        rewardPaid: s(r.reward_paid),
        // 发射前没法核对：null，不是 false
        marketAddressOk: Number(r.market_checked) === 1 && r.market_address_ok !== null ? Number(r.market_address_ok) === 1 : null,
      })),
    },
  };
}

// ===================== /api/bridge/timeline（决策 #29c） =====================

/** 进时间线的事件：桥的 owner 权力与刹车，外加节点基金的提取与 owner 变更（与 #29c 同一口径）。 */
const TIMELINE_EVENTS = {
  bridge: {
    contract: "BacBridge",
    events: [
      "BridgeUpgraded", "Upgraded", "EmergencyWithdraw", "Initialized",
      "OwnershipTransferStarted", "OwnershipTransferred",
      "Paused", "Unpaused", "Halted", "EscapeArmed", "EscapeArmCancelled", "EpochOwedRevoked",
    ],
  },
  nodeFund: {
    contract: "BacNodeFund",
    events: ["Withdrawn", "OwnershipTransferStarted", "OwnershipTransferred"],
  },
};

/**
 * GET /api/bridge/timeline?scope=bridge|nodeFund|all&limit=
 * 每一次升级、每一次紧急提取、每一次 owner 变更都按时间倒序列出，并给出累计数（决策 #29c：至少让人**看见**）。
 * 合约部署了但什么都没发生时，items 是空数组、计数是 0 —— 那是真的。
 */
export function bridgeTimeline(ctx, q = {}) {
  const { db, cfg } = ctx;
  const scope = q.scope || "all";
  if (!["bridge", "nodeFund", "all"].includes(scope)) throw badRequest("scope 只能是 bridge|nodeFund|all");
  const limit = intParam(q.limit, 200, { min: 1, max: 1000, name: "limit" });
  const groups = scope === "all" ? Object.values(TIMELINE_EVENTS) : [TIMELINE_EVENTS[scope]];
  const where = groups
    .map((g) => `(contract = '${g.contract}' AND event IN (${g.events.map((e) => `'${e}'`).join(",")}))`)
    .join(" OR ");
  const rows = db
    .prepare(`SELECT * FROM decoded_events WHERE chain = 'bsc' AND (${where}) ORDER BY block DESC, log_index DESC LIMIT ?`)
    .all(limit);
  const bacToken = cfg && cfg.addresses && cfg.addresses.BacToken;
  const items = rows.map((r) => {
    const args = JSON.parse(r.args);
    return {
      contract: r.contract,
      event: r.event,
      ts: Number(r.ts),
      block: Number(r.block),
      tx: r.tx,
      logIndex: Number(r.log_index),
      args,
      textZh: renderEvent({ contract: r.contract, event: r.event, args, agentId: n(r.agent_id) }, { bacToken }).textZh,
    };
  });
  // 累计数从全部事件算，不受 limit 影响
  const all = (contract, event) =>
    db
      .prepare("SELECT args FROM decoded_events WHERE chain = 'bsc' AND contract = ? AND event = ?")
      .all(contract, event)
      .map((r) => JSON.parse(r.args));
  const ew = all("BacBridge", "EmergencyWithdraw");
  const isBnb = (a) => /^0x0{40}$/i.test(String(a.token));
  const isBac = (a) => !!bacToken && String(a.token).toLowerCase() === String(bacToken).toLowerCase();
  const sum = (xs) => xs.reduce((acc, a) => acc + BigInt(a.amount || "0"), 0n).toString();
  const nfw = all("BacNodeFund", "Withdrawn");
  return {
    status: 200,
    body: {
      schema: "bac/bridge-timeline/1",
      scope,
      bridge: (cfg && cfg.addresses && cfg.addresses.BacBridge) || null,
      nodeFund: (cfg && cfg.addresses && cfg.addresses.BacNodeFund) || null,
      totals: {
        upgrades: all("BacBridge", "BridgeUpgraded").length,
        emergencyWithdrawals: ew.length,
        emergencyBnb: sum(ew.filter(isBnb)),
        emergencyBac: sum(ew.filter(isBac)),
        emergencyOtherTokens: ew.filter((a) => !isBnb(a) && !isBac(a)).length,
        // initialize() 里 OZ 发的 OwnershipTransferred(0x0 → owner) 是「第一次设 owner」，不是变更：
        // 新部署的桥这里必须是 0。那一条照样在 items 里。
        ownerChanges: all("BacBridge", "OwnershipTransferred").filter((a) => !/^0x0{40}$/i.test(String(a.previousOwner)))
          .length,
        nodeFundWithdrawals: nfw.length,
        nodeFundWithdrawn: sum(nfw),
      },
      items,
      note: OWNER_POWER_NOTICE,
      updatedAt: nowSec(),
    },
  };
}

// ===================== §3.7 gas 费分账的三个端点（决策 #17） =====================
//
// 三条硬规则，逐字照做：
//   1. 单位一律是层内 BAC（wei 十进制字符串），每个返回体带 "unit": "BAC"；
//   2. 每个数字都要能说出它从哪来：来自 FINAL 锚点的 anchored = true，
//      只来自官方节点实时数据的 anchored = false（网站必须写「未锚定 · 仅来自官方节点」）；
//   3. 不做任何收益预测：只返回已发生的金额与规则常量。

const FEE_RULES_NOTE =
  "官方节点出的块：10% 进验证者池 / 90% 进官方基金会；验证者出的块：50% 归该验证者 / 50% 进官方基金会。" +
  "基金会那一份用余数法算。费用先落在出块者自己的 EOA 里，转入分账合约这一步是受信的，差额公开在下面。";

/** GET /api/fees —— 全局的「已收 / 已转入 / 差额」三联 + 分账合约的存量。 */
export function fees(ctx) {
  const { db, cfg } = ctx;
  const snapshot = ctx.snapshot || {};
  const g = gasBlock(ctx, snapshot);
  const t = latestTreasury(db, cfg);
  const sum = gasFeesSummary(db, t);
  const sp = snapshot.splitter || {};
  return {
    status: 200,
    body: {
      schema: "bac/fees/1",
      unit: "BAC",
      rules: {
        zeroBaseFee: true,
        minGasPrice: s((snapshot.layer || {}).minGasPrice) ?? "1000000000",
        officialBlockValidatorBps: 1000,
        validatorBlockValidatorBps: 5000,
        note: FEE_RULES_NOTE,
      },
      reconcile: {
        received: sum.lifetimeReceived,
        remitted: sum.lifetimeRemitted,
        gap: sum.lifetimeGap,
        operatorFloatReserve: g.operatorFloatReserve,
        anchoredThrough: g.lastAnchoredEpoch,
        howToCheck: feesHowToCheck(cfg),
      },
      splitter: {
        address: FEE_SPLITTER,
        // 层内 FeeSplitter 地址上的余额（快照读到的）；还没有快照时是 null
        balance: s((snapshot.reconcile || {}).feeSplitterBalance),
        poolPending: g.poolPending,
        carryPool: g.carryPool,
        foundationBalance: g.foundationBalance,
        foundationPayout: s(sp.foundationPayout),
        // 这两列要读 FeeSplitter，还没有代码写它们：照实给 null
        lifetimeOfficialGross: t ? s(t.lifetime_official_gross) : null,
        lifetimeValidatorRemitted: t ? s(t.lifetime_validator_remitted) : null,
        lifetimePool: sum.lifetimeToPool,
        lifetimePoolClaimed: sum.lifetimePoolClaimed,
        lifetimeFoundationAccrued: sum.lifetimeToFoundation,
        lifetimeFoundationWithdrawn: sum.foundationWithdrawn,
      },
      updatedAt: nowSec(),
    },
  };
}

/** howToCheck 必须原样返回：任何人不必相信我们算好的 gap，他自己就能复算（§3.7）。 */
export function feesHowToCheck(cfg) {
  const layerRpc = `${cfg.apiBase}/rpc`;
  const anchor = (cfg.addresses && cfg.addresses.ChainAnchor) || "<ChainAnchor>";
  return [
    "对每个区块：Σ(gasUsed × effectiveGasPrice) 按 header.miner 分组，即 received",
    `cast call ${FEE_SPLITTER} "remittedBy(uint64,address)(uint256)" <epoch> <proposer> --rpc-url ${layerRpc}`,
    `cast call ${anchor} "proposerIncome(uint64,address)" <epoch> <proposer> --rpc-url ${cfg.bscRpc}`,
  ];
}

/** GET /api/fees/{epoch} —— 单个纪元的分账明细，逐行列出 weight / amount / 余数。 */
export function feeEpoch(ctx, epochParam) {
  const { db } = ctx;
  const e = intParam(epochParam, null, { name: "纪元号" });
  const row = db.prepare("SELECT * FROM epochs WHERE epoch = ?").get(e);
  if (!row) throw notFound(`没有纪元 ${e}`);
  const rows = db.prepare("SELECT * FROM proposer_income WHERE epoch = ? ORDER BY proposer ASC").all(e);
  const claims = db.prepare("SELECT * FROM pool_claims WHERE epoch = ? ORDER BY member ASC").all(e);
  const received = rows.reduce((a, r) => a + BigInt(r.gas_income || "0"), 0n);
  const remitted = rows.reduce((a, r) => a + BigInt(r.remitted || "0"), 0n);
  const accrued = BigInt(row.pool_accrued || "0");
  const claimed = claims.reduce((a, r) => a + BigInt(r.amount || "0"), 0n);
  const anchored = row.state === "FINAL" && rows.some((r) => Number(r.anchored) === 1);
  return {
    status: 200,
    body: {
      schema: "bac/fee-epoch/1",
      unit: "BAC",
      epoch: e,
      // §3.7 硬规则 2：见证人在四元组里签过才是 true
      anchored,
      anchorState: row.state,
      proposerIncomeRoot: s(row.proposer_income_root),
      received: received.toString(),
      remitted: remitted.toString(),
      gap: (received - remitted).toString(),
      split: {
        toPool: s(row.pool_accrued) ?? "0",
        toFoundation: s(row.foundation_accrued) ?? "0",
        fromOfficialBlocks: rows
          .filter((r) => Number(r.official) === 1)
          .reduce((a, r) => a + BigInt(r.gas_income || "0"), 0n)
          .toString(),
        fromValidatorBlocks: rows
          .filter((r) => Number(r.official) !== 1)
          .reduce((a, r) => a + BigInt(r.gas_income || "0"), 0n)
          .toString(),
      },
      pool: {
        accrued: accrued.toString(),
        carriedIn: "0",
        claimed: claimed.toString(),
        // 余数必须显示出来，哪怕只有 2 wei —— 这正是「余数去哪了」的答案（§3.7）
        remainder: (accrued - claimed).toString(),
        weightTotal: s(row.weight_total) ?? "0",
        weightsSetAt: n(row.weights_set_at),
        memberCount: n(row.member_count) ?? claims.length,
        members: claims.map((c) => ({
          validator: s(c.validator),
          layerPayout: c.member,
          // staked / attend30 由 BSC 侧的 ValidatorStaking 快照回填，没有就给 null，绝不编
          staked: null,
          attend30: null,
          weight: c.weight,
          amount: c.amount,
          claimedTx: c.layer_tx,
        })),
      },
      proposers: rows.map((r) => ({
        proposer: r.proposer,
        validator: s(r.validator),
        official: Number(r.official) === 1,
        blocks: Number(r.blocks),
        gasIncome: r.gas_income,
        remitted: r.remitted,
        gap: r.gap,
        // 官方行恒为 "0"（官方不自留）；验证者行 = gasIncome × 5000 / 10000
        selfKept: Number(r.official) === 1 ? "0" : ((BigInt(r.gas_income || "0") * 5000n) / 10000n).toString(),
      })),
      updatedAt: nowSec(),
    },
  };
}

/** GET /api/proposers —— 最近 N 个纪元里每个出块者的已收 / 已转入 / 差额。 */
export function proposers(ctx, q = {}) {
  const { db } = ctx;
  const epochs = intParam(q.epochs, 30, { min: 1, max: 3650, name: "epochs" });
  const top = db.prepare("SELECT MAX(epoch) AS e FROM proposer_income").get();
  const to = top && top.e != null ? Number(top.e) : null;
  const from = to === null ? null : Math.max(0, to - epochs + 1);
  // 金额是 wei，SQLite 的整数加法会溢出，所以只在 SQL 里分组，金额逐行用 BigInt 加。
  const rows =
    to === null
      ? []
      : db
          .prepare(
            `SELECT epoch, proposer, validator, official, blocks, gas_income, remitted
               FROM proposer_income WHERE epoch BETWEEN ? AND ? ORDER BY proposer ASC, epoch ASC`
          )
          .all(from, to);
  const byProposer = new Map();
  for (const r of rows) {
    const cur = byProposer.get(r.proposer) || {
      proposer: r.proposer,
      validator: s(r.validator),
      official: Number(r.official) === 1,
      blocks: 0,
      income: 0n,
      remit: 0n,
    };
    cur.blocks += Number(r.blocks);
    cur.income += BigInt(r.gas_income || "0");
    cur.remit += BigInt(r.remitted || "0");
    byProposer.set(r.proposer, cur);
  }
  const items = [...byProposer.values()].map((c) => {
    const gap = c.income - c.remit;
    const rem = db.prepare("SELECT rights, shortfall FROM remittance WHERE proposer_addr = ?").get(c.proposer);
    return {
      proposer: c.proposer,
      validator: c.validator,
      official: c.official,
      blocks: c.blocks,
      gasIncome: c.income.toString(),
      remitted: c.remit.toString(),
      gap: gap.toString(),
      gapBps: c.income === 0n ? 0 : Number((gap * 10000n) / c.income),
      rights: c.official ? true : rem ? Number(rem.rights) === 1 : false,
      shortfall: rem ? Number(rem.shortfall) === 1 : false,
      note: c.official
        ? "官方节点：合约层面没有任何机制会因为它不归集而惩罚它，差额只能靠公开对账约束。"
        : "验证者节点：归集短缺会扣发 BSC 侧奖励并撤销出块资格（v1 不罚没本金）。",
    };
  });
  return {
    status: 200,
    body: {
      schema: "bac/proposers/1",
      unit: "BAC",
      window: { from, to },
      items,
      updatedAt: nowSec(),
    },
  };
}
