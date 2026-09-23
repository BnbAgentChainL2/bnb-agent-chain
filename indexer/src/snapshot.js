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
import { Rpc, isRevertError } from "./rpc.js";
import { warn, clearWarning } from "./warnings.js";
import { layerCirculating } from "./api/handlers.js";
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
  token: new Interface(["function taxProcessor() view returns (address)"]),
  taxProcessor: new Interface(["function marketAddress() view returns (address)"]),
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
async function view(rpc, iface, to, fn, args = []) {
  if (!to) return undefined;
  let out;
  try {
    out = await rpc.ethCall(to, iface.encodeFunctionData(fn, args));
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
  const B = bscRpc || new Rpc(cfg.bscRpc, { name: "bsc" });
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
    const bBridge = await L.getBalance(LAYER_SYSTEM_ADDRESSES.L2Bridge);
    const bSink = await L.getBalance(FEE_SINK);
    const bSplitter = await L.getBalance(FEE_SPLITTER);
    // everValidator：QBFT 的验证者集可变，对账要按累积表逐个读（03 §1.3 / §3.1）。
    const everValidator = await readValidators(L, cfg, signerAddress);
    const vBalances = [];
    for (const v of everValidator) {
      vBalances.push({ addr: v, balance: BigInt(await L.getBalance(v)).toString() });
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
    if (bsc.bridgeDeployed) {
      const V = VIEWS.bridge;
      const r = (fn) => view(B, V, A.BacBridge, fn);
      const b = {};
      b.owner = addrOrNull(await r("owner"));
      b.pendingOwner = addrOrNull(await r("pendingOwner"));
      b.implementation = await implementationOf(B, A.BacBridge);
      b.bacToken = addrOrNull(await r("bacToken"));
      b.identityRegistry = addrOrNull(await r("identityRegistry"));
      b.ownerPowerNotice = (await r("OWNER_POWER_NOTICE")) ?? null;
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
      // shortfall() 里有一个对 BAC 代币的 typed call：代币没代码时它必然 revert。
      // 那时桥里不可能有 BAC（lock 都成功不了），BAC 侧的缺口按合约自己的公式算：max(0, bacAccounted − 0)。
      const sf = bsc.tokenHasCode ? await r("shortfall") : undefined;
      if (sf) {
        b.shortfall = { bnbShort: sf[0].toString(), bacShort: sf[1].toString(), source: "BacBridge.shortfall()" };
      } else if (b.bnbBalance !== null) {
        const book = BigInt(b.bnbBalance);
        const held = BigInt(b.bnbHeld);
        const bacBook = BigInt(b.bacAccounted ?? "0");
        b.shortfall = {
          bnbShort: (book > held ? book - held : 0n).toString(),
          bacShort: bacBook.toString(),
          source: bsc.tokenHasCode
            ? "按 shortfall() 的公式在链下重算（shortfall() 调用失败）"
            : "按 shortfall() 的公式在链下重算（BAC 代币尚未发射，shortfall() 对它的 balanceOf 必然 revert；桥里不可能有 BAC）",
        };
      }
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

  // ===== 对账（03 §3.1 + 创世分配项）=====
  const gen = readGenesisAlloc(cfg.genesisPath);
  if (!gen) warn("genesis_unreadable", `读不到创世文件 ${cfg.genesisPath}：对账按设计值（1e27 全在 L2Bridge）计算，genesisAlloc 记 0`);
  else clearWarning("genesis_unreadable");
  const g = gen || fallbackGenesis();
  const lb = snap.layerBalancesRaw;
  const bb = bsc.bridge || {};
  snap.reconcile = {
    bscTotalIssued: bb.totalCreditsIssued ?? "0",
    bscTotalExited: bb.totalCreditsExited ?? "0",
    layerCirculating: lb
      ? layerCirculating({
          genesisSupply: g.supply,
          bridgeBalance: lb.bridge,
          sinkBalance: lb.sink,
          splitterBalance: lb.splitter,
          validatorBalances: lb.validators,
        })
      : "0",
    feeSinkBalance: lb ? lb.sink : "0",
    feeSplitterBalance: lb ? lb.splitter : "0",
    validatorBalances: lb ? lb.validators : [],
    genesisSupply: g.supply,
    genesisAlloc: g.genesisAlloc,
    genesisAllocAccounts: g.accounts,
    genesisSource: g.source,
  };

  // ===== 给 handlers 的原始块（形状由 handlers 固定，这里只放读到的值）=====
  snap.bsc = {
    checkedAt: now,
    bscBlock: bsc.bscBlock ?? null,
    ok: bsc.ok,
    bridgeDeployed: bsc.bridgeDeployed ?? null,
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

  // ===== treasury 时间序列（只在 BSC 读成功时写一行）=====
  if (bsc.ok) {
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
        router_balance: rt.balance ?? "0",
        router_accounted: rt.accountedQuote ?? "0",
        router_unsplit: rt.unsplitRevenue ?? "0",
        router_stuck_bridge: (rt.stuck && rt.stuck.bridge) ?? "0",
        router_stuck_node: (rt.stuck && rt.stuck.nodeFund) ?? "0",
        lifetime_to_bridge: rt.lifetimeToBridge ?? "0",
        lifetime_to_node: rt.lifetimeToNodeFund ?? "0",
        pool_balance: bb.bnbBalance ?? "0",
        bridge_bnb_held: bb.bnbHeld ?? "0",
        buyback_bac: bb.buybackBac ?? "0",
        owed_total: bb.owedTotal ?? "0",
        emergency_bnb_withdrawn: bb.emergencyBnbWithdrawn ?? "0",
        emergency_bac_withdrawn: bb.emergencyBacWithdrawn ?? "0",
        node_fund_balance: nf.balance ?? "0",
        node_fund_withdrawn: nf.lifetimeWithdrawn ?? "0",
        total_locked: bb.lockedBac ?? "0",
        total_issued: bb.totalCreditsIssued ?? "0",
        total_exited: bb.totalCreditsExited ?? "0",
        reward_balance: st.rewardBalance ?? "0",
        reward_funded: st.lifetimeFunded ?? "0",
        reward_paid: st.lifetimePaid ?? "0",
        market_address_ok: tk.marketAddressOk ? 1 : 0,
        market_checked: tk.marketAddressOk === true || tk.marketAddressOk === false ? 1 : 0,
      },
      ["ts"]
    );
  }

  // 对账不平就打告警 —— 这条告警是发现中继超发的唯一手段，不许静默。
  const r = snap.reconcile;
  const vSum = (r.validatorBalances || []).reduce((a, v) => a + BigInt(v.balance), 0n);
  const diff =
    BigInt(r.bscTotalIssued) -
    BigInt(r.bscTotalExited) +
    BigInt(r.genesisAlloc) -
    (BigInt(r.layerCirculating) + BigInt(r.feeSinkBalance) + BigInt(r.feeSplitterBalance) + vSum);
  if (lb && diff !== 0n) warn("reconcile_diff_nonzero", `对账差额 ${diff.toString()} wei`);
  else clearWarning("reconcile_diff_nonzero");

  return snap;
}
