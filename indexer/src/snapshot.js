// src/snapshot.js —— 定期把两条链的 view 读成一个内存快照，供 /api/health 与 /api/summary 用，
// 并往 treasury 表写一行时间序列（03 §2 的「每次刷新一行」）。
//
// 纪律：
//   - 任何一个读失败都不许让整个 /api/health 挂掉：读不到就留 null 并打一条告警；
//   - reconcile 的五个数必须逐项可见（03 §3.1），不许只给一个布尔值。
import { Interface, getAddress } from "ethers";
import { Rpc } from "./rpc.js";
import { warn, clearWarning } from "./warnings.js";
import { layerCirculating } from "./api/handlers.js";
import { LAYER_SYSTEM_ADDRESSES, FEE_SINK, FEE_SPLITTER } from "./abi.js";
import { upsert } from "./db.js";

const VIEWS = new Interface([
  // BacBridge
  "function totalLocked() view returns (uint256)",
  "function totalCreditsIssued() view returns (uint256)",
  "function totalCreditsExited() view returns (uint256)",
  "function poolBalance() view returns (uint256)",
  "function owedTotal() view returns (uint256)",
  "function reservedTotal() view returns (uint256)",
  "function lastSettledEpoch() view returns (uint64)",
  "function isPaused() view returns (bool, uint64, uint64)",
  "function isHalted() view returns (bool)",
  "function pendingCause() view returns (uint8)",
  "function currentRate() view returns (uint256)",
  // BacNodeFund
  "function balance() view returns (uint256)",
  "function lifetimeReceived() view returns (uint256)",
  "function lifetimeWithdrawn() view returns (uint256)",
  "function owner() view returns (address)",
  // BacTreasuryVault
  "function accountedQuote() view returns (uint256)",
  "function unsplitRevenue() view returns (uint256)",
  "function lifetimeToBridge() view returns (uint256)",
  "function lifetimeToNodeFund() view returns (uint256)",
  // ValidatorStaking
  "function rewardBalance() view returns (uint256)",
  "function lifetimeFunded() view returns (uint256)",
  "function lifetimePaid() view returns (uint256)",
  "function nodeCount() view returns (uint256)",
  // TaxProcessor（Flap）
  "function marketAddress() view returns (address)",
  // ChainAnchor
  "function releaseBpsFor(uint64) view returns (uint16)",
]);

async function readView(rpc, to, fn, args = []) {
  if (!to) return null;
  const data = VIEWS.encodeFunctionData(fn, args);
  const out = await rpc.ethCall(to, data);
  if (!out || out === "0x") return null;
  const dec = VIEWS.decodeFunctionResult(fn, out);
  return dec.length === 1 ? dec[0] : dec;
}

const str = (v) => (v === null || v === undefined ? null : v.toString());

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

/**
 * 拉一次快照。layerRpc / bscRpc 可以注入（测试里用假的，不碰网络）。
 * 返回的对象直接挂到 ctx.snapshot 上。
 */
export async function refreshSnapshot(db, cfg, { layerRpc, bscRpc, signerAddress = null } = {}) {
  const L = layerRpc || new Rpc(cfg.layerRpc, { name: "layer" });
  const B = bscRpc || new Rpc(cfg.bscRpc, { name: "bsc" });
  const A = cfg.addresses || {};
  const now = Math.floor(Date.now() / 1000);
  const snap = { rpc: { rateLimited24h: B.rateLimited24h ? B.rateLimited24h() : 0, throttledAgents: [] } };

  // ===== 层内 =====
  try {
    const head = await L.blockNumber();
    const hb = await L.getBlockByNumber(head, false);
    const peers = await L.netPeerCount().catch(() => null);
    const bBridge = await L.getBalance(LAYER_SYSTEM_ADDRESSES.L2Bridge);
    const bSink = await L.getBalance(FEE_SINK);
    const bSplitter = await L.getBalance(FEE_SPLITTER);
    // everValidator：QBFT 的验证者集可变，对账要按累积表逐个读（03 §1.3 / §3.1）。
    // 读不到验证者集就退回配置里的那一个出块者地址；读不到就是空集合，分项会少，
    // 但不会把差额藏起来 —— diff 非零一定会打告警。
    const everValidator = await readValidators(L, cfg, signerAddress);
    const vBalances = [];
    for (const v of everValidator) {
      vBalances.push({ addr: v, balance: BigInt(await L.getBalance(v)).toString() });
    }
    snap.layer = {
      chainId: cfg.layerChainId,
      head,
      headTs: Number(BigInt(hb.timestamp)),
      blockLagSec: now - Number(BigInt(hb.timestamp)),
      enode: null,
      genesisHash: null,
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
    clearWarning("layer_rpc_unavailable");
  } catch (e) {
    warn("layer_rpc_unavailable", String(e && e.message ? e.message : e));
  }

  // ===== BSC 侧 view =====
  let bsc = {};
  try {
    const bscBlock = await B.blockNumber();
    bsc = {
      bscBlock,
      totalLocked: str(await readView(B, A.BacBridge, "totalLocked")),
      totalIssued: str(await readView(B, A.BacBridge, "totalCreditsIssued")),
      totalExited: str(await readView(B, A.BacBridge, "totalCreditsExited")),
      poolBalance: str(await readView(B, A.BacBridge, "poolBalance")),
      owedTotal: str(await readView(B, A.BacBridge, "owedTotal")),
      reservedTotal: str(await readView(B, A.BacBridge, "reservedTotal")),
      lastSettledEpoch: Number(await readView(B, A.BacBridge, "lastSettledEpoch")),
      halted: !!(await readView(B, A.BacBridge, "isHalted")),
      haltCause: Number(await readView(B, A.BacBridge, "pendingCause")),
      nodeFundBalance: str(await readView(B, A.BacNodeFund, "balance")),
      nodeFundWithdrawn: str(await readView(B, A.BacNodeFund, "lifetimeWithdrawn")),
      nodeFundOwner: await readView(B, A.BacNodeFund, "owner"),
      vaultAccounted: str(await readView(B, A.BacTreasuryVault, "accountedQuote")),
      vaultUnsplit: str(await readView(B, A.BacTreasuryVault, "unsplitRevenue")),
      lifetimeToBridge: str(await readView(B, A.BacTreasuryVault, "lifetimeToBridge")),
      lifetimeToNodeFund: str(await readView(B, A.BacTreasuryVault, "lifetimeToNodeFund")),
      rewardBalance: str(await readView(B, A.ValidatorStaking, "rewardBalance")),
      rewardFunded: str(await readView(B, A.ValidatorStaking, "lifetimeFunded")),
      rewardPaid: str(await readView(B, A.ValidatorStaking, "lifetimePaid")),
    };
    const paused = await readView(B, A.BacBridge, "isPaused");
    if (paused) {
      bsc.paused = !!paused[0];
      bsc.pausedUntil = Number(paused[1]);
      bsc.pausedCumulativeSec = Number(paused[2]);
    }
    if (A.BacTreasuryVault) {
      const vb = await B.getBalance(A.BacTreasuryVault);
      bsc.vaultBalance = BigInt(vb).toString();
    }
    if (A.TaxProcessor && A.BacTreasuryVault) {
      const market = await readView(B, A.TaxProcessor, "marketAddress");
      bsc.marketAddressOk = market
        ? getAddress(market) === getAddress(A.BacTreasuryVault)
        : null;
    }
    clearWarning("bsc_rpc_unavailable");
  } catch (e) {
    warn("bsc_rpc_unavailable", String(e && e.message ? e.message : e));
  }

  // ===== 对账三元组（03 §3.1）=====
  const lb = snap.layerBalancesRaw;
  snap.reconcile = {
    bscTotalIssued: bsc.totalIssued ?? "0",
    bscTotalExited: bsc.totalExited ?? "0",
    layerCirculating: lb
      ? layerCirculating({
          bridgeBalance: lb.bridge,
          sinkBalance: lb.sink,
          splitterBalance: lb.splitter,
          validatorBalances: lb.validators,
        })
      : "0",
    feeSinkBalance: lb ? lb.sink : "0",
    feeSplitterBalance: lb ? lb.splitter : "0",
    validatorBalances: lb ? lb.validators : [],
  };

  snap.bridge = {
    paused: bsc.paused ?? null,
    pausedUntil: bsc.pausedUntil ?? null,
    pausedCumulativeSec: bsc.pausedCumulativeSec ?? null,
    maxPauseTotalSec: 21 * 86400,
    halted: bsc.halted ?? null,
    haltCause: bsc.haltCause ?? null,
    escapeArmedAt: null,
    armedCause: null,
    lastSettledEpoch: bsc.lastSettledEpoch ?? null,
    skippedEpochs: null,
    lastPot: null,
    releasedInWindow: null,
    owedTotal: bsc.owedTotal ?? null,
    reservedTotal: bsc.reservedTotal ?? null,
    poolBalance: bsc.poolBalance ?? null,
  };
  snap.vault = {
    accountedQuote: bsc.vaultAccounted ?? null,
    lastSettleAt: null,
    settleOverdueEpochs: null,
    nodeFundOwner: bsc.nodeFundOwner ?? null,
  };
  snap.flap = { marketAddressOk: bsc.marketAddressOk ?? null, checkedAt: now };

  // ===== treasury 时间序列 =====
  if (bsc.bscBlock !== undefined) {
    upsert(
      db,
      "treasury",
      {
        ts: now,
        bsc_block: bsc.bscBlock,
        vault_balance: bsc.vaultBalance ?? "0",
        vault_accounted: bsc.vaultAccounted ?? "0",
        vault_unsplit: bsc.vaultUnsplit ?? "0",
        lifetime_to_bridge: bsc.lifetimeToBridge ?? "0",
        lifetime_to_node: bsc.lifetimeToNodeFund ?? "0",
        pool_balance: bsc.poolBalance ?? "0",
        node_fund_balance: bsc.nodeFundBalance ?? "0",
        node_fund_withdrawn: bsc.nodeFundWithdrawn ?? "0",
        total_locked: bsc.totalLocked ?? "0",
        total_issued: bsc.totalIssued ?? "0",
        total_exited: bsc.totalExited ?? "0",
        reward_balance: bsc.rewardBalance ?? "0",
        reward_funded: bsc.rewardFunded ?? "0",
        reward_paid: bsc.rewardPaid ?? "0",
        market_address_ok: bsc.marketAddressOk ? 1 : 0,
      },
      ["ts"]
    );
  }

  // 对账不平就打告警 —— 这条告警是发现中继超发的唯一手段，不许静默。
  const issued = BigInt(snap.reconcile.bscTotalIssued);
  const exited = BigInt(snap.reconcile.bscTotalExited);
  const circ = BigInt(snap.reconcile.layerCirculating);
  const vSum = (snap.reconcile.validatorBalances || []).reduce((a, v) => a + BigInt(v.balance), 0n);
  const diff =
    issued -
    exited -
    (circ + BigInt(snap.reconcile.feeSinkBalance) + BigInt(snap.reconcile.feeSplitterBalance) + vSum);
  if (diff !== 0n) warn("reconcile_diff_nonzero", `对账差额 ${diff.toString()} wei`);
  else clearWarning("reconcile_diff_nonzero");

  return snap;
}
