// src/snapshot.js —— 定期把两条链的 view 读成一个内存快照，供 /api/health 与 /api/summary 用，
// 并往 treasury 表写一行时间序列（03 §2 的「每次刷新一行」）。
//
// 纪律：
//   - 任何一个读失败都不许让整个 /api/health 挂掉：读不到就留 null 并打一条告警；
//   - reconcile 的每一项都必须逐项可见（03 §3.1），不许只给一个布尔值；
//   - BSC 侧有三种状态，必须分开说（决策 #35）：
//       none              我们的合约还没部署（或地址没配）：所有链上数都是 null，不是 0；
//       contracts_deployed 合约部署了、BAC 代币还没发射（代币地址上没有代码）：
//                          合约自己的状态（余额 0、owner、升级次数、空时间线）是**真的**，照实返回；
//                          价格 / 税率 / 交易这些数**根本不存在**，返回 null，网站写「发射后公布」；
//       token_launched    代币地址上有代码了。
import { Interface, getAddress, ZeroAddress } from "ethers";
import { Rpc, FailoverRpc, isRevertError, FAILOVER_PRIMARY_OPTS, FAILOVER_LAST_OPTS } from "./rpc.js";
import { warn, clearWarning } from "./warnings.js";
import { layerCirculating, computeReconcile, RECONCILE_TERM_WARNINGS, OWNER_POWER_NOTICE } from "./api/handlers.js";
import {
  LAYER_SYSTEM_ADDRESSES,
  FEE_SINK,
  FEE_SPLITTER,
  EIP1967_IMPLEMENTATION_SLOT,
} from "./abi.js";
import { upsert } from "./db.js";
import { readGenesisAlloc, fallbackGenesis } from "./genesis.js";
import { refreshIdentities } from "./identity.js";

// 每个合约一个 Interface：同名函数（owner() / bacToken() / balance()）在不同合约上返回的东西不一样，
// 分开写才不会拿错一个 ABI 去解另一个合约的返回值。签名逐条对过 contracts/out/*.json（2026-09-23）。
export const VIEWS = {
  bridge: new Interface([
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
    "function bacToken() view returns (address)",
    "function identityRegistry() view returns (address)",
    "function OWNER_POWER_NOTICE() view returns (string)",
    "function description() view returns (string)",
    "function totalCreditsIssued() view returns (uint256)",
    "function totalCreditsExited() view returns (uint256)",
    "function lockedBac() view returns (uint256)",
    "function totalBurned() view returns (uint256)",
    "function buybackBac() view returns (uint256)",
    "function bnbBalance() view returns (uint256)",
    "function buybackBudget() view returns (uint256)",
    "function buybackBacBought() view returns (uint256)",
    "function buybackBnbSpent() view returns (uint256)",
    "function owedTotal() view returns (uint256)",
    "function reservedTotal() view returns (uint256)",
    "function lastSettledEpoch() view returns (uint64)",
    "function skippedEpochs() view returns (uint64)",
    "function lastPot() view returns (uint256)",
    "function releasedInWindow() view returns (uint256)",
    "function escapeArmedAt() view returns (uint64)",
    "function armedCause() view returns (uint8)",
    "function isPaused() view returns (bool, uint64, uint64)",
    "function isHalted() view returns (bool)",
    "function pendingCause() view returns (uint8)",
    "function haltCause() view returns (uint8)",
    "function currentRate() view returns (uint256)",
    "function bacAccounted() view returns (uint256)",
    "function shortfall() view returns (uint256, uint256)",
    "function upgradeCount() view returns (uint64)",
    "function lastUpgradeAt() view returns (uint64)",
    "function emergencyCount() view returns (uint64)",
    "function lastEmergencyAt() view returns (uint64)",
    "function emergencyBnbWithdrawn() view returns (uint256)",
    "function emergencyBacWithdrawn() view returns (uint256)",
  ]),
  router: new Interface([
    "function accountedQuote() view returns (uint256)",
    "function unsplitRevenue() view returns (uint256)",
    "function stuckAmounts() view returns (uint256, uint256)",
    "function lifetimeToBridge() view returns (uint256)",
    "function lifetimeToNodeFund() view returns (uint256)",
    "function totalRecognized() view returns (uint256)",
    "function solvency() view returns (uint256, uint256, uint256)",
    "function bridge() view returns (address)",
    "function nodeFund() view returns (address)",
    "function bacToken() view returns (address)",
    "function BRIDGE_BPS() view returns (uint16)",
  ]),
  nodeFund: new Interface([
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
    "function balance() view returns (uint256)",
    "function lifetimeReceived() view returns (uint256)",
    "function lifetimeWithdrawn() view returns (uint256)",
  ]),
  staking: new Interface([
    "function rewardBalance() view returns (uint256)",
    "function lifetimeFunded() view returns (uint256)",
    "function lifetimePaid() view returns (uint256)",
  ]),
  token: new Interface([
    "function taxProcessor() view returns (address)",
    "function balanceOf(address) view returns (uint256)",
  ]),
  taxProcessor: new Interface(["function marketAddress() view returns (address)"]),
  // 层内创世合约 L2Bridge（0x…0101）的三个公开计数，对账按它们拆项（contracts/src/layer/L2Bridge.sol）
  l2Bridge: new Interface([
    "function totalCredited() view returns (uint256)",
    "function totalExited() view returns (uint256)",
    "function totalBurnedFloat() view returns (uint256)",
  ]),
  portal: new Interface([
    "function getTokenV8Safe(address) view returns ((uint8 status, uint256 reserve, uint256 circulatingSupply, uint256 price, uint8 tokenVersion, uint256 r, uint256 h, uint256 k, uint256 dexSupplyThresh, address quoteTokenAddress, bool nativeToQuoteSwapEnabled, bytes32 extensionID, uint256 buyTaxRate, uint256 sellTaxRate, address pool, uint256 progress, uint8 lpFeeProfile, uint8 dexId))",
  ]),
};

const str = (v) => (v === null || v === undefined ? null : v.toString());
const num = (v) => (v === null || v === undefined ? null : Number(v));
const addrOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const a = getAddress(String(v));
  return a === ZeroAddress ? null : a;
};

/**
 * 读一个 view。合约 revert（函数不存在 / 代币还没代码时的 typed call）返回 undefined，
 * 由调用方决定写 null；网络错误照样往外抛 —— 那是 bsc_rpc_unavailable，不是「这个数不存在」。
 */
async function view(rpc, iface, to, fn, args = [], tag = "latest") {
  if (!to) return undefined;
  let out;
  try {
    out = await rpc.ethCall(to, iface.encodeFunctionData(fn, args), tag);
  } catch (e) {
    if (isRevertError(e)) return undefined;
    throw e;
  }
  if (!out || out === "0x") return undefined;
  const dec = iface.decodeFunctionResult(fn, out);
  return dec.length === 1 ? dec[0] : dec;
}

async function hasCode(rpc, a) {
  if (!a) return null;
  const code = await rpc.getCode(a);
  return !!code && code !== "0x";
}

/** EIP-1967 实现槽里的地址（桥代理当前指向的实现合约）。 */
async function implementationOf(rpc, proxy) {
  if (!proxy || !rpc.getStorageAt) return null;
  const word = await rpc.getStorageAt(proxy, EIP1967_IMPLEMENTATION_SLOT);
  if (!word || !/^0x[0-9a-fA-F]+$/.test(word)) return null;
  const hex = word.slice(2).padStart(64, "0").slice(-40);
  return addrOrNull("0x" + hex);
}

/**
 * everValidator 累积表：先问层内 RPC 的 qbft_getValidatorsByBlockNumber，
 * 再并上配置里写死的历史验证者（cfg.everValidators）与当前出块者地址。
 * 读不到就退回后两者 —— 宁可分项少一个，也不许静默把余额算进流通量。
 */
export async function readValidators(L, cfg = {}, signerAddress = null) {
  const out = [];
  const push = (a) => {
    if (!a) return;
    const x = getAddress(a);
    if (!out.includes(x)) out.push(x);
  };
  try {
    const live = await L.call("qbft_getValidatorsByBlockNumber", ["latest"]);
    if (Array.isArray(live)) live.forEach(push);
  } catch {
    // 读不到就算了，下面还有两个来源
  }
  (cfg.everValidators || []).forEach(push);
  push(signerAddress);
  return out;
}

// 创世区块的 hash 永远不变：读到一次就缓存。键是 RPC 的 URL（真 Rpc 每轮新建一个对象）；
// 注入的假 RPC 没有 url，就用对象本身作键，测试之间不会串。
const genesisHashCache = new Map();
async function genesisHashOf(L, key) {
  if (genesisHashCache.has(key)) return genesisHashCache.get(key);
  const b0 = await L.getBlockByNumber(0, false);
  const h = b0 && b0.hash ? String(b0.hash).toLowerCase() : null;
  if (h) genesisHashCache.set(key, h);
  return h;
}
export function resetGenesisHashCache() {
  genesisHashCache.clear();
}

/**
 * 快照用的 BSC 只读 RPC：BSC_RPC 为主，配了 BSC_RPC_2 就在网络错误 / 限速时换它（rpc.js 的 FailoverRpc）。
 * 快照只做 eth_call / getCode / getBalance / getStorageAt / blockNumber，不取日志。
 * 两路都配了时：主 RPC 用短预算（5 秒、重试 1 次）—— 它后面还有第二个兜底，没必要在它身上耗 135 秒；
 * 而且对象按 URL 缓存、跨快照复用：换到第二个之后下一轮直接走第二个（10 分钟后再回头试主 RPC），
 * rateLimited24h 也因此真的是 24 小时的累计，而不是「这一轮新建的对象从 0 数起」。
 */
const readRpcCache = new Map();
export function bscReadRpc(cfg) {
  const key = `${cfg.bscRpc}\n${cfg.bscRpc2 || ""}`;
  if (readRpcCache.has(key)) return readRpcCache.get(key);
  let rpc;
  if (!cfg.bscRpc2 || cfg.bscRpc2 === cfg.bscRpc) {
    rpc = new Rpc(cfg.bscRpc, { name: "bsc" });
  } else {
    rpc = new FailoverRpc(
      [new Rpc(cfg.bscRpc, { name: "bsc", ...FAILOVER_PRIMARY_OPTS }), new Rpc(cfg.bscRpc2, { name: "bsc2", ...FAILOVER_LAST_OPTS })],
      { name: "bsc" }
    );
  }
  readRpcCache.set(key, rpc);
  return rpc;
}
export function resetReadRpcCache() {
  readRpcCache.clear();
}

const eqAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** 接线核对会打的四个告警键。 */
export const WIRING_WARNINGS = [
  "identity_registry_mismatch",
  "owner_notice_mismatch",
  "bac_token_mismatch",
  "router_wiring_mismatch",
];

/**
 * 接线核对（决策 #29a / #31 / #32 / #35）：读到的值和该有的值不一致就打告警
 * （进 /api/health.warnings，health.ok 变 false）—— 只把不一致摆在返回体里、ok 却还是 true，等于没核。
 * 地址只比**读到了**的（view revert 的不猜）；但 #29a 那句话必须能在链上读到，读不到也算不一致。
 * 返回这一轮触发了哪些告警键。
 */
export function checkWiring(cfg, bsc) {
  const A = cfg.addresses || {};
  const hits = {};
  // 配置的桥地址不是代理（bridge_not_proxy 已经在喊）：它的读数不是桥的状态，不拿来核
  const b = bsc.bridgeDeployed && bsc.bridgeIsProxy !== false ? bsc.bridge || {} : null;
  const t = bsc.routerDeployed ? bsc.router || {} : null;

  // 入场门禁读的注册表必须是 BNB Chain 官方的 ERC-8004 Identity Registry（0x8004…），不是长得像的别家
  if (b && b.identityRegistry && A.IdentityRegistry && !eqAddr(b.identityRegistry, A.IdentityRegistry)) {
    hits.identity_registry_mismatch = `BacBridge.identityRegistry() = ${b.identityRegistry}，应为 ${A.IdentityRegistry}（ERC-8004 官方注册表）`;
  }
  // 决策 #29a / #32：桥上必须逐字写着那句话（OWNER_POWER_NOTICE()，或 description() 里包含它）
  if (b) {
    const notice = b.ownerPowerNotice ?? null;
    const desc = b.description ?? null;
    const ok =
      notice === OWNER_POWER_NOTICE ||
      (notice === null && typeof desc === "string" && desc.includes(OWNER_POWER_NOTICE));
    if (!ok) {
      hits.owner_notice_mismatch =
        notice === null && desc === null
          ? "BacBridge 上读不到 OWNER_POWER_NOTICE() / description()，无法核对决策 #29a 那句话"
          : `BacBridge 上的 owner 权力说明与决策 #29a 不逐字一致：${JSON.stringify(notice ?? desc).slice(0, 200)}`;
    }
  }
  // 决策 #35：所有 BSC 合约的 bacToken 都绑定锁定的那个代币地址
  if (A.BacToken) {
    const bad = [];
    if (b && b.bacToken && !eqAddr(b.bacToken, A.BacToken)) bad.push(`BacBridge.bacToken() = ${b.bacToken}`);
    if (t && t.bacToken && !eqAddr(t.bacToken, A.BacToken)) bad.push(`BacTaxRouter.bacToken() = ${t.bacToken}`);
    if (bad.length) hits.bac_token_mismatch = `${bad.join("；")}，应为 ${A.BacToken}`;
  }
  // 路由推钱的两个去处必须就是配置里的桥（代理）和节点基金
  if (t) {
    const bad = [];
    if (t.bridge && A.BacBridge && !eqAddr(t.bridge, A.BacBridge)) {
      bad.push(`BacTaxRouter.bridge() = ${t.bridge}，配置是 ${A.BacBridge}`);
    }
    if (t.nodeFund && A.BacNodeFund && !eqAddr(t.nodeFund, A.BacNodeFund)) {
      bad.push(`BacTaxRouter.nodeFund() = ${t.nodeFund}，配置是 ${A.BacNodeFund}`);
    }
    if (bad.length) hits.router_wiring_mismatch = bad.join("；");
  }

  for (const key of WIRING_WARNINGS) {
    if (hits[key]) warn(key, hits[key]);
    else clearWarning(key);
  }
  return Object.keys(hits);
}

/**
 * 桥的缺口（owner 紧急提取造成的「账上有、手里没有」），与 BacBridge.shortfall() 同一个公式：
 *   bnbShort = max(0, bnbBalance − address(bridge).balance)
 *   bacShort = max(0, bacAccounted − BAC.balanceOf(bridge))
 * 代币发射后直接调 shortfall()；它失败了就读代币的 balanceOf 在链下按同一公式重算，**读不到就是 null** ——
 * 绝不拿 bacAccounted 冒充缺口（那等于不看余额就宣称桥里的 BAC 全丢了）。
 * 发射前代币地址上没有代码：shortfall() 对它的 balanceOf 必然 revert，而桥里也不可能有 BAC（lock 都成功不了），
 * 此时 bacShort = bacAccounted（按构造就是 0）；bacAccounted 读不到就是 null。
 */
async function shortfallOf(B, A, b, tokenHasCode) {
  const big = (v) => (v === null || v === undefined ? null : BigInt(v));
  const short = (book, held) => (book === null || held === null ? null : (book > held ? book - held : 0n).toString());
  const bnbShort = short(big(b.bnbBalance), big(b.bnbHeld));
  if (tokenHasCode) {
    const sf = await view(B, VIEWS.bridge, A.BacBridge, "shortfall");
    if (sf) return { bnbShort: sf[0].toString(), bacShort: sf[1].toString(), source: "BacBridge.shortfall()" };
    const bal = await view(B, VIEWS.token, A.BacToken, "balanceOf", [A.BacBridge]);
    return {
      bnbShort,
      bacShort: bal === undefined ? null : short(big(b.bacAccounted), BigInt(bal)),
      source:
        bal === undefined
          ? "shortfall() 调用失败，BAC.balanceOf(bridge) 也读不到：BAC 缺口未知"
          : "shortfall() 调用失败：按它的公式用 bacAccounted() 与 BAC.balanceOf(bridge) 在链下重算",
    };
  }
  return {
    bnbShort,
    bacShort: b.bacAccounted ?? null,
    source: "按 shortfall() 的公式在链下重算（BAC 代币尚未发射，shortfall() 对它的 balanceOf 必然 revert；桥里不可能有 BAC）",
  };
}

/** BSC 侧所处的阶段（见文件头）。 */
export function stageOf({ bridgeDeployed, routerDeployed, tokenHasCode }) {
  if (!bridgeDeployed && !routerDeployed) return "none";
  if (!tokenHasCode) return "contracts_deployed";
  return "token_launched";
}

/**
 * 拉一次快照。layerRpc / bscRpc 可以注入（测试里用假的，不碰网络）。
 * 返回的对象直接挂到 ctx.snapshot 上。
 */
export async function refreshSnapshot(db, cfg, { layerRpc, bscRpc, signerAddress = null, now: nowIn = null } = {}) {
  const L = layerRpc || new Rpc(cfg.layerRpc, { name: "layer" });
  const B = bscRpc || bscReadRpc(cfg);
  const A = cfg.addresses || {};
  const now = nowIn ?? Math.floor(Date.now() / 1000);
  const snap = { rpc: { rateLimited24h: B.rateLimited24h ? B.rateLimited24h() : 0, throttledAgents: [] } };

  if ((cfg.legacyEnvSet || []).length) {
    warn(
      "legacy_address_env_set",
      `这些环境变量对应的合约已被决策 #30 / #31 删除，索引器不再读它们：${cfg.legacyEnvSet.join(", ")}`
    );
  } else {
    clearWarning("legacy_address_env_set");
  }

  // ===== 层内 =====
  try {
    const head = await L.blockNumber();
    const hb = await L.getBlockByNumber(head, false);
    const peers = await L.netPeerCount().catch(() => null);
    // 余额与 L2Bridge 的计数全部钉在同一个块（head）上读：对账的四项必须是同一时刻的，
    // 否则两次读之间有人 withdrawCredits()，creditableAndDonations 就会假性变负。
    const bBridge = await L.getBalance(LAYER_SYSTEM_ADDRESSES.L2Bridge, head);
    const bSink = await L.getBalance(FEE_SINK, head);
    const bSplitter = await L.getBalance(FEE_SPLITTER, head);
    // everValidator：QBFT 的验证者集可变，对账要按累积表逐个读（03 §1.3 / §3.1）。
    const everValidator = await readValidators(L, cfg, signerAddress);
    const vBalances = [];
    for (const v of everValidator) {
      vBalances.push({ addr: v, balance: BigInt(await L.getBalance(v, head)).toString() });
    }
    // L2Bridge 自己的三个计数（对账拆项用）。地址上没有代码（演练链的创世没有系统合约）时 hasCode = false，
    // 计数不去读 —— computeReconcile 按 0 计并在 structuralZeros 里写明。读失败只影响对账，不拖垮层内其余读数。
    const l2 = {
      address: LAYER_SYSTEM_ADDRESSES.L2Bridge,
      block: head,
      hasCode: null,
      balance: BigInt(bBridge).toString(),
      totalCredited: null,
      totalExited: null,
      totalBurnedFloat: null,
    };
    try {
      const code = await L.getCode(LAYER_SYSTEM_ADDRESSES.L2Bridge, head);
      l2.hasCode = !!code && code !== "0x";
      if (l2.hasCode) {
        for (const k of ["totalCredited", "totalExited", "totalBurnedFloat"]) {
          l2[k] = str(await view(L, VIEWS.l2Bridge, LAYER_SYSTEM_ADDRESSES.L2Bridge, k, [], head));
        }
      }
      clearWarning("l2bridge_read_failed");
    } catch (e) {
      warn("l2bridge_read_failed", `读 L2Bridge 的代码 / 计数失败：${String(e && e.message ? e.message : e)}`);
    }
    let genesisHash = null;
    try {
      genesisHash = await genesisHashOf(L, L.url || L);
    } catch {
      genesisHash = null;
    }
    snap.layer = {
      chainId: cfg.layerChainId,
      head,
      headTs: Number(BigInt(hb.timestamp)),
      blockLagSec: now - Number(BigInt(hb.timestamp)),
      // enode 来自配置（BAC_LAYER_ENODE，与公开的 node.json 同一条）；genesisHash 是链自己的第 0 块 hash。
      enode: cfg.layerEnode ?? null,
      genesisHash,
      gasLimit: Number(BigInt(hb.gasLimit)),
      baseFee: hb.baseFeePerGas ? BigInt(hb.baseFeePerGas).toString() : "0",
      peers,
    };
    snap.layerBalancesRaw = {
      bridge: BigInt(bBridge).toString(),
      sink: BigInt(bSink).toString(),
      splitter: BigInt(bSplitter).toString(),
      validators: vBalances,
      l2Bridge: l2,
    };
    if (!cfg.layerEnode) warn("layer_enode_unset", "没有配置 BAC_LAYER_ENODE（或格式不对），/api/health 的 layer.enode 为 null");
    else clearWarning("layer_enode_unset");
    clearWarning("layer_rpc_unavailable");
  } catch (e) {
    warn("layer_rpc_unavailable", String(e && e.message ? e.message : e));
  }

  // ===== BSC 侧 =====
  const bsc = { ok: false };
  try {
    bsc.bscBlock = await B.blockNumber();

    // --- 部署了没有：看地址上有没有代码，不看地址配没配 ---
    bsc.bridgeDeployed = !!(await hasCode(B, A.BacBridge));
    bsc.routerDeployed = !!(await hasCode(B, A.BacTaxRouter));
    bsc.nodeFundDeployed = !!(await hasCode(B, A.BacNodeFund));
    bsc.tokenHasCode = A.BacToken ? !!(await hasCode(B, A.BacToken)) : null;

    // --- BacBridge（UUPS 代理）---
    // 先看 EIP-1967 实现槽：空的就说明 BAC_ADDR_BRIDGE 填的不是代理（多半是实现合约）。实现合约自己的存储是空的，
    // 它的 owner() / 余额 / 计数读出来都是 0 或 null，却会被当成「合约部署了、状态是真的」发出去；它也从来不发 Locked 事件。
    // 所以这种情况下不读它的任何 view、不写进 treasury、不拿来核接线，只打 bridge_not_proxy（health.ok 随之为 false）。
    const bridgeImpl = bsc.bridgeDeployed ? await implementationOf(B, A.BacBridge) : null;
    bsc.bridgeIsProxy = bsc.bridgeDeployed ? bridgeImpl !== null : null;
    if (bsc.bridgeDeployed && !bsc.bridgeIsProxy) {
      warn(
        "bridge_not_proxy",
        `BAC_ADDR_BRIDGE = ${A.BacBridge} 上有代码，但 EIP-1967 实现槽是空的：这不是 ERC1967 代理（多半把实现合约地址填成了桥）。` +
          "它的读数不是桥的真状态，这一轮一律不当测量值用；它也不会发 Locked 事件，BSC 摄入对它取不到任何日志。改成代理地址后重启。"
      );
    } else {
      clearWarning("bridge_not_proxy");
    }
    if (bsc.bridgeDeployed && bsc.bridgeIsProxy) {
      const V = VIEWS.bridge;
      const r = (fn) => view(B, V, A.BacBridge, fn);
      const b = {};
      b.owner = addrOrNull(await r("owner"));
      b.pendingOwner = addrOrNull(await r("pendingOwner"));
      b.implementation = bridgeImpl;
      b.bacToken = addrOrNull(await r("bacToken"));
      b.identityRegistry = addrOrNull(await r("identityRegistry"));
      b.ownerPowerNotice = (await r("OWNER_POWER_NOTICE")) ?? null;
      b.description = (await r("description")) ?? null;
      for (const k of [
        "totalCreditsIssued", "totalCreditsExited", "lockedBac", "totalBurned", "buybackBac", "bnbBalance",
        "buybackBudget", "buybackBacBought", "buybackBnbSpent", "owedTotal", "reservedTotal", "lastPot",
        "releasedInWindow", "currentRate", "bacAccounted", "emergencyBnbWithdrawn", "emergencyBacWithdrawn",
      ]) {
        b[k] = str(await r(k));
      }
      for (const k of [
        "lastSettledEpoch", "skippedEpochs", "escapeArmedAt", "armedCause", "pendingCause", "haltCause",
        "upgradeCount", "lastUpgradeAt", "emergencyCount", "lastEmergencyAt",
      ]) {
        b[k] = num(await r(k));
      }
      const halted = await r("isHalted");
      b.halted = halted === undefined ? null : !!halted;
      const paused = await r("isPaused");
      if (paused) {
        b.paused = !!paused[0];
        b.pausedUntil = Number(paused[1]);
        b.pausedCumulativeSec = Number(paused[2]);
      }
      b.bnbHeld = BigInt(await B.getBalance(A.BacBridge)).toString();
      b.shortfall = await shortfallOf(B, A, b, bsc.tokenHasCode);
      bsc.bridge = b;
    }

    // --- BacTaxRouter（无 owner、不可升级，决策 #30 / #32）---
    if (bsc.routerDeployed) {
      const V = VIEWS.router;
      const r = (fn) => view(B, V, A.BacTaxRouter, fn);
      const t = {};
      t.balance = BigInt(await B.getBalance(A.BacTaxRouter)).toString();
      for (const k of ["accountedQuote", "unsplitRevenue", "lifetimeToBridge", "lifetimeToNodeFund", "totalRecognized"]) {
        t[k] = str(await r(k));
      }
      const stuck = await r("stuckAmounts");
      t.stuck = stuck ? { bridge: stuck[0].toString(), nodeFund: stuck[1].toString() } : null;
      const sol = await r("solvency");
      t.solvency = sol ? { balance: sol[0].toString(), accounted: sol[1].toString(), buckets: sol[2].toString() } : null;
      t.bridge = addrOrNull(await r("bridge"));
      t.nodeFund = addrOrNull(await r("nodeFund"));
      t.bacToken = addrOrNull(await r("bacToken"));
      t.bridgeBps = num(await r("BRIDGE_BPS"));
      bsc.router = t;
    }

    // --- BacNodeFund ---
    if (bsc.nodeFundDeployed) {
      const V = VIEWS.nodeFund;
      const r = (fn) => view(B, V, A.BacNodeFund, fn);
      bsc.nodeFund = {
        owner: addrOrNull(await r("owner")),
        pendingOwner: addrOrNull(await r("pendingOwner")),
        balance: str(await r("balance")),
        lifetimeReceived: str(await r("lifetimeReceived")),
        lifetimeWithdrawn: str(await r("lifetimeWithdrawn")),
      };
    }

    // --- ValidatorStaking ---
    if (A.ValidatorStaking && (await hasCode(B, A.ValidatorStaking))) {
      const r = (fn) => view(B, VIEWS.staking, A.ValidatorStaking, fn);
      bsc.staking = {
        rewardBalance: str(await r("rewardBalance")),
        lifetimeFunded: str(await r("lifetimeFunded")),
        lifetimePaid: str(await r("lifetimePaid")),
      };
    }

    // --- BAC 代币与 Flap（只在代币地址上有代码之后才有意义）---
    if (bsc.tokenHasCode) {
      const tk = {};
      tk.taxProcessor = A.TaxProcessor ?? addrOrNull(await view(B, VIEWS.token, A.BacToken, "taxProcessor"));
      const st = A.FlapPortal ? await view(B, VIEWS.portal, A.FlapPortal, "getTokenV8Safe", [A.BacToken]) : undefined;
      if (st) {
        tk.status = Number(st.status);
        tk.price = st.price.toString();
        tk.buyTaxBps = Number(st.buyTaxRate);
        tk.sellTaxBps = Number(st.sellTaxRate);
        tk.pool = addrOrNull(st.pool);
        tk.progress = st.progress.toString();
        tk.tokenVersion = Number(st.tokenVersion);
      }
      if (tk.taxProcessor && A.BacTaxRouter) {
        const market = await view(B, VIEWS.taxProcessor, tk.taxProcessor, "marketAddress");
        tk.marketAddress = addrOrNull(market);
        tk.marketAddressOk = market === undefined ? null : getAddress(market) === getAddress(A.BacTaxRouter);
      }
      bsc.token = tk;
    }
    bsc.ok = true;
    clearWarning("bsc_rpc_unavailable");
  } catch (e) {
    warn("bsc_rpc_unavailable", String(e && e.message ? e.message : e));
  }

  snap.stage = bsc.ok
    ? stageOf({ bridgeDeployed: bsc.bridgeDeployed, routerDeployed: bsc.routerDeployed, tokenHasCode: bsc.tokenHasCode })
    : null;
  // 接线核对只在这一轮 BSC 读成功时做；读失败时保留上一轮的结论（bsc_rpc_unavailable 已经在喊了）。
  if (bsc.ok) checkWiring(cfg, bsc);

  // ===== 对账（03 §3.1 + 创世分配项）=====
  const gen = readGenesisAlloc(cfg.genesisPath);
  if (!gen) warn("genesis_unreadable", `读不到创世文件 ${cfg.genesisPath}：对账按设计值（1e27 全在 L2Bridge）计算，genesisAlloc 记 0`);
  else clearWarning("genesis_unreadable");
  const g = gen || fallbackGenesis();
  const lb = snap.layerBalancesRaw;
  const bb = bsc.bridge || {};
  // BSC 侧的发行 / 兑付：这一轮读不到 BSC、或配置的桥不是代理时是 null（不知道），不是 "0"；
  // 桥还没部署时 bscBridgeDeployed = false，computeReconcile 按 0 计并写进 structuralZeros（没有桥就不可能发行过）。
  const bscIssuance = !bsc.ok
    ? { deployed: null, issued: null, exited: null, source: "这一轮读不到 BSC" }
    : !bsc.bridgeDeployed
      ? { deployed: false, issued: null, exited: null, source: "BacBridge 还没部署（地址上没有代码）" }
      : !bsc.bridge
        ? { deployed: true, issued: null, exited: null, source: "BAC_ADDR_BRIDGE 不是 ERC1967 代理，读数不作数（bridge_not_proxy）" }
        : { deployed: true, issued: bb.totalCreditsIssued ?? null, exited: bb.totalCreditsExited ?? null, source: "BacBridge 代理的 totalCreditsIssued() / totalCreditsExited()" };
  snap.reconcile = {
    bscBridgeDeployed: bscIssuance.deployed,
    bscTotalIssued: bscIssuance.issued,
    bscTotalExited: bscIssuance.exited,
    bscSource: bscIssuance.source,
    layerCirculating: lb
      ? layerCirculating({
          genesisSupply: g.supply,
          bridgeBalance: lb.bridge,
          sinkBalance: lb.sink,
          splitterBalance: lb.splitter,
          validatorBalances: lb.validators,
        })
      : null,
    // 层内 RPC 这一轮读不到：这些是 null（没读到），不是 "0"
    feeSinkBalance: lb ? lb.sink : null,
    feeSplitterBalance: lb ? lb.splitter : null,
    validatorBalances: lb ? lb.validators : [],
    genesisSupply: g.supply,
    genesisAlloc: g.genesisAlloc,
    bridgeAlloc: g.bridgeAlloc,
    genesisAllocAccounts: g.accounts,
    // 公开的下载地址 + 文件的 keccak256（= /api/genesis 的 X-Genesis-Hash），**不是**服务器上的文件路径（决策 #6）
    genesisSource: gen ? `${cfg.apiBase}/api/genesis` : null,
    genesisFileHash: gen ? gen.hash : null,
    l2Bridge: lb ? lb.l2Bridge : null,
  };

  // ===== 给 handlers 的原始块（形状由 handlers 固定，这里只放读到的值）=====
  snap.bsc = {
    checkedAt: now,
    bscBlock: bsc.bscBlock ?? null,
    ok: bsc.ok,
    bridgeDeployed: bsc.bridgeDeployed ?? null,
    bridgeIsProxy: bsc.bridgeIsProxy ?? null,
    routerDeployed: bsc.routerDeployed ?? null,
    nodeFundDeployed: bsc.nodeFundDeployed ?? null,
    tokenHasCode: bsc.tokenHasCode ?? null,
    bridge: bsc.bridge || null,
    router: bsc.router || null,
    nodeFund: bsc.nodeFund || null,
    staking: bsc.staking || null,
    token: bsc.token || null,
  };
  // 旧字段：summary / rate 还按这个名字读
  snap.bridge = bsc.bridge
    ? {
        paused: bb.paused ?? null,
        halted: bb.halted ?? null,
        lastSettledEpoch: bb.lastSettledEpoch ?? null,
        owedTotal: bb.owedTotal ?? null,
        buybackBac: bb.buybackBac ?? null,
        currentRate: bb.currentRate ?? null,
      }
    : null;
  snap.flap = {
    marketAddressOk: bsc.token ? bsc.token.marketAddressOk ?? null : null,
    checkedAt: now,
  };

  // ===== ERC-8004 身份（只读锁过桥的那些 id）=====
  const registry = (bsc.bridge && bsc.bridge.identityRegistry) || A.IdentityRegistry || null;
  if (bsc.ok && registry) {
    try {
      await refreshIdentities(db, B, {
        registry,
        now,
        bscBlock: bsc.bscBlock ?? null,
        max: cfg.identityBatch ?? 10,
        staleSec: cfg.identityRefreshSec ?? 3600,
      });
    } catch (e) {
      warn("identity_read_failed", String(e && e.message ? e.message : e));
    }
  }

  // ===== treasury 时间序列 =====
  // 只在 BSC 读成功、且至少有一个我们的合约已经部署时写一行：合约都不存在时写一串 0 就是在编数据。
  // 同理，没部署的合约 / 这一轮 revert 的 view 写 NULL（004 起这些列可空），"0" 只留给链上真的读到的 0。
  // 配置的桥地址不是代理时它不算「部署了」：它的读数不是桥的状态（bridge_not_proxy）。
  if (bsc.ok && (bsc.bridge || bsc.routerDeployed || bsc.nodeFundDeployed)) {
    const rt = bsc.router || {};
    const nf = bsc.nodeFund || {};
    const st = bsc.staking || {};
    const tk = bsc.token || {};
    upsert(
      db,
      "treasury",
      {
        ts: now,
        bsc_block: bsc.bscBlock,
        router_balance: rt.balance ?? null,
        router_accounted: rt.accountedQuote ?? null,
        router_unsplit: rt.unsplitRevenue ?? null,
        router_stuck_bridge: rt.stuck ? rt.stuck.bridge : null,
        router_stuck_node: rt.stuck ? rt.stuck.nodeFund : null,
        lifetime_to_bridge: rt.lifetimeToBridge ?? null,
        lifetime_to_node: rt.lifetimeToNodeFund ?? null,
        pool_balance: bb.bnbBalance ?? null,
        bridge_bnb_held: bb.bnbHeld ?? null,
        buyback_bac: bb.buybackBac ?? null,
        owed_total: bb.owedTotal ?? null,
        emergency_bnb_withdrawn: bb.emergencyBnbWithdrawn ?? null,
        emergency_bac_withdrawn: bb.emergencyBacWithdrawn ?? null,
        node_fund_balance: nf.balance ?? null,
        node_fund_withdrawn: nf.lifetimeWithdrawn ?? null,
        total_locked: bb.lockedBac ?? null,
        total_issued: bb.totalCreditsIssued ?? null,
        total_exited: bb.totalCreditsExited ?? null,
        reward_balance: st.rewardBalance ?? null,
        reward_funded: st.lifetimeFunded ?? null,
        reward_paid: st.lifetimePaid ?? null,
        market_address_ok: tk.marketAddressOk === true ? 1 : tk.marketAddressOk === false ? 0 : null,
        market_checked: tk.marketAddressOk === true || tk.marketAddressOk === false ? 1 : 0,
      },
      ["ts"]
    );
  }

  // 对账告警（这条告警是发现中继超发的手段，不许静默）。只看**负的方向**：
  // rawDiff 在正常运行里就不是 0（见 handlers.js 的 computeReconcile），拿它 ≠ 0 告警只会让运维学会无视它。
  const rec = computeReconcile(snap.reconcile);
  for (const [term, key] of Object.entries(RECONCILE_TERM_WARNINGS)) {
    const t = rec.terms[term];
    if (t && t.alarm) warn(key, `${term} = ${t.value} wei：${t.ifNegative}`);
    else clearWarning(key);
  }
  // 有输入没读到、又没有任何一项变负：不知道平不平，照实说（health.ok 随之为 false），不当成平
  if (rec.ok === null) warn("reconcile_incomplete", `对账缺输入：${rec.missing.join("、")}`);
  else clearWarning("reconcile_incomplete");

  return snap;
}
