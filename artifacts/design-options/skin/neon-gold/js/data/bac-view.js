/* BNB Agent Chain · 数据层 · 视图模型（把两侧的原始状态拼成页面真正要的那几块）
   这里仍然没有一行 DOM 代码：只返回数据 + 一个 status。
   status 的四个值，绑定层照它选显示什么（约定 §1.3 的 miss() 规则）：
     'pre'     → 发射前，显示「发射后公布」
     'loading' → 还没读到第一份数据，显示「读取中…」
     'error'   → 读取失败，显示「读取失败 · 重试中」
     'ok'      → 有真实数据
   任何一个字段是 null 都表示「不知道」，绑定层不许把它当 0。 */
(function (root) {
  'use strict';

  var BAC = root.BAC;
  if (!BAC || !BAC.core) {
    if (root.console) root.console.error('[BAC] bac-view.js 需要先加载 bac-core.js');
    return;
  }
  if (BAC.view) return;

  var CFG = BAC.CFG, C = BAC.C, TEXT = BAC.TEXT;

  /** 一段的状态：发射前 → pre；出错 → error；没数据 → loading；否则 ok。
      **BAC.LIVE 只管 BSC 那一半。** 层内的块、交易、链指标不许经过它 —— 见 layerStatus()。 */
  function statusOf(sec) {
    if (!BAC.LIVE) return 'pre';
    return plainStatus(sec);
  }

  /** 不看发射与否，只看这一段自己读到没有。 */
  function plainStatus(sec) {
    if (!sec) return 'loading';
    if (sec.status === 'prelaunch') return 'pre';
    if (sec.error) return 'error';
    if (!sec.ready) return 'loading';
    return 'ok';
  }

  function bscStatus() { return statusOf(BAC.state.bsc); }
  function idxStatus(sec) {
    if (!BAC.HAS_INDEXER) return 'pre';
    return statusOf(sec);
  }

  /** 层内那一半（链指标 / 区块 / 交易）的状态。
      层内链现在就在出块，它的数据既可能来自索引器，也可能是 bac-layer.js 直接读 RPC 读到的，
      **和 BSC 有没有发射完全无关**。两条路都没配才是 'pre'。 */
  function layerStatus(sec) {
    if (!BAC.HAS_INDEXER && !BAC.HAS_LAYER_RPC) return 'pre';
    return plainStatus(sec);
  }

  /** 降级提示：索引器挂了但层内节点还答话时，说的是另一句话（块和交易仍然是真的）。 */
  function degradedNote() {
    if (!BAC.state.indexer.degraded) return null;
    if (BAC.api && BAC.api.degradedNote) return BAC.api.degradedNote();
    return BAC.LAYER_LIVE ? TEXT.RPC_DIRECT : TEXT.NO_INDEXER;
  }

  /* ── 链指标（顶部那条 8 格）───────────────────────────── */
  function chainStats() {
    var L = BAC.state.layer, S = BAC.state.summary, B = BAC.state.bsc;
    var a = B.anchor || {};
    var sum = S || {};
    var layerSum = sum.layer || {};
    return {
      status: layerStatus(L),
      // 'indexer'（有历史与聚合）| 'rpc'（本站直接读层内节点）| null（都读不到）
      source: L.source,
      endpoint: L.endpoint,                     // 现在实际在用哪个 RPC / API 地址
      layerLive: !!BAC.LAYER_LIVE,              // 层内链在不在出块；和「BSC 发射了没有」无关
      chainId: L.chainId !== null ? L.chainId : C.LAYER_CHAIN_ID,
      head: L.head,
      headTs: L.headTs,
      headHash: L.headHash !== undefined ? L.headHash : null,
      miner: L.miner !== undefined ? L.miner : null,
      blockLagSec: L.blockLagSec,
      // 实测出块间隔（最后两块的时间差）；索引器给了 blockTimeSec 就用它的
      blockIntervalSec: L.blockIntervalSec !== undefined ? L.blockIntervalSec : null,
      gasPrice: L.gasPrice !== undefined ? L.gasPrice : null,
      txpool: L.txpool !== undefined ? L.txpool : null,
      sections: L.sections || null,
      blockTimeSec: layerSum.blockTimeSec !== undefined ? Number(layerSum.blockTimeSec)
        : (L.blockTimeSec !== undefined ? L.blockTimeSec : null),
      targetBlockTimeSec: C.BLOCK_PERIOD,
      gasLimit: L.gasLimit !== null && L.gasLimit !== undefined ? L.gasLimit : C.GAS_LIMIT,
      baseFee: L.baseFee,                       // zeroBaseFee：这个数应该是 0
      peers: L.peers,
      txTotal: layerSum.txTotal !== undefined ? Number(layerSum.txTotal) : null,
      contractsTotal: layerSum.contractsTotal !== undefined ? Number(layerSum.contractsTotal) : null,
      circulating: BAC.big(layerSum.circulating),
      burnedTotal: BAC.big(layerSum.burnedTotal),
      totalSupply: C.TOTAL_SUPPLY,
      // 纪元
      epoch: a.currentEpoch !== undefined && a.currentEpoch !== null ? a.currentEpoch : BAC.currentEpoch(),
      epochLeftSec: BAC.epochLeft(),
      lastPostedEpoch: a.lastPostedEpoch !== undefined ? a.lastPostedEpoch : null,
      lastFinalEpoch: a.lastFinalEpoch !== undefined ? a.lastFinalEpoch : null,
      // 对账（任何人都能自己复算，howToCheck 原样透传）
      reconcile: L.reconcile || null,
      degraded: !!BAC.state.indexer.degraded,
      degradedNote: degradedNote()
    };
  }

  /* ── 实时动态 ─────────────────────────────────────────── */
  function feed(limit) {
    var F = BAC.state.feed;
    var items = limit ? F.items.slice(0, limit) : F.items.slice();
    return {
      status: idxStatus(F),
      items: items,
      head: F.head,
      anchoredThrough: F.anchoredThrough,
      empty: F.ready && !items.length,
      emptyNote: '最近一段时间没有链上记录。',
      // 每条 item 自带 anchorNote：未锚定的必须显示「未锚定 · 仅来自官方节点」
      note: '动态里的文字由 agent 自己写，本站原样转义显示，不做任何背书。'
    };
  }

  /* ── 最新区块 / 最新交易 ──────────────────────────────── */
  function blocks(limit) {
    var B = BAC.state.blocks;
    return {
      status: layerStatus(B),
      source: B.source,                          // 'indexer' | 'rpc'
      stale: !!B.stale,
      items: limit ? B.items.slice(0, limit) : B.items.slice(),
      empty: B.ready && !B.items.length
    };
  }

  function txs(limit) {
    var T = BAC.state.txs;
    return {
      status: layerStatus(T),
      source: T.source,
      stale: !!T.stale,
      items: limit ? T.items.slice(0, limit) : T.items.slice(),
      empty: T.ready && !T.items.length,
      // 层内平均 20 秒才有一笔交易，空是常态，不是故障
      emptyNote: '最近的区块里没有交易。'
    };
  }

  /* ── Agent 名录 ──────────────────────────────────────── */
  function agents(opts) {
    var G = BAC.state.agentList, S = BAC.state.summary, B = BAC.state.bsc;
    var counts = (S && S.agents) || null;
    return {
      status: idxStatus(G),
      items: opts && opts.limit ? G.items.slice(0, opts.limit) : G.items.slice(),
      total: G.total !== null ? G.total : (B.agents ? B.agents.total : null),
      page: G.page,
      pageSize: CFG.agentsPageSize,
      counts: counts ? {
        total: Number(counts.total), challenged: Number(counts.challenged), active: Number(counts.active),
        dormant: Number(counts.dormant), banned: Number(counts.banned), retired: Number(counts.retired)
      } : null,
      // 名录挂了也还有一个数：BSC 上的 AgentRegistry.totalAgents() 是直接读的
      totalFromChain: B.agents ? B.agents.total : null,
      note: 'agentURI 与简介都是 agent 自己写的，本站只做格式核对，不背书其中任何说法。'
    };
  }

  /* ── 金库 · 50/50 ─────────────────────────────────────── */
  function treasury() {
    var B = BAC.state.bsc, t = B.treasury, p = B.params;
    var st = bscStatus();
    if (!t) return { status: st, bridgeBps: C.BRIDGE_BPS, nodeFundBps: C.NODE_FUND_BPS };
    var toBridge = t.lifetimeToBridge, toNode = t.lifetimeToNodeFund;
    var lifetimeTotal = (toBridge !== null && toNode !== null) ? toBridge + toNode : null;
    return {
      status: st,
      // 分账比例：合约常量，不是文案
      bridgeBps: t.bridgeBps !== null && t.bridgeBps !== undefined ? t.bridgeBps : C.BRIDGE_BPS,
      nodeFundBps: (t.bridgeBps !== null && t.bridgeBps !== undefined) ? (C.BPS - t.bridgeBps) : C.NODE_FUND_BPS,
      // 50/50 的基数：Flap 先抽走 taxFeeRateBps，剩下的才进金库（03 §3.2）
      taxFeeRateBps: t.taxFeeRateBps,
      splitBaseNote: t.taxFeeRateBps === null ? null
        : '50/50 分的是扣掉 Flap 协议费之后的部分：(10000 − ' + t.taxFeeRateBps + ')/10000',
      // 金库自己的数
      vaultBalance: t.vaultBalance,
      vaultAccounted: t.vaultAccounted,
      vaultUnsplit: t.vaultUnsplit,
      totalRecognized: t.totalRecognized,
      stuckBridge: t.stuckBridge,
      stuckNodeFund: t.stuckNodeFund,
      // 两个桶
      lifetimeToBridge: toBridge,
      lifetimeToNodeFund: toNode,
      lifetimeTotal: lifetimeTotal,
      poolBalance: t.poolBalance,
      nodeFundBalance: t.nodeFundBalance,
      nodeFundReceived: t.nodeFundReceived,
      nodeFundWithdrawn: t.nodeFundWithdrawn,
      nodeFundOwner: t.nodeFundOwner,
      vaultOwner: p ? p.vaultOwner : null,
      marketAddressOk: p ? p.marketAddressOk : null,
      // 决策 #10 的披露，必须逐字显示
      disclosure: 'owner 可以提取节点基金这一半（税收 BNB 的 50%）。桥池那一半不属于 owner，合约里没有任何路径让 owner 动它。',
      settleNote: '金库的稳态余额取决于有没有人调 settle()：没有任何合约或定时器会自动调它。'
    };
  }

  /* ── 桥 ──────────────────────────────────────────────── */
  function bridge() {
    var B = BAC.state.bsc, b = B.bridge, R = BAC.state.rate;
    var st = bscStatus();
    if (!b) return { status: st };
    return {
      status: st,
      totalLocked: b.totalLocked,
      totalIssued: b.totalIssued,
      totalExited: b.totalExited,
      creditsOutstanding: b.creditsOutstanding,
      poolBalance: b.poolBalance,
      owedTotal: b.owedTotal,
      reservedTotal: b.reservedTotal,
      releasedInWindow: b.releasedInWindow,
      weiPerCredit: b.weiPerCredit,
      lastPot: b.lastPot,
      lastPotBps: b.lastPotBps,
      lastSettledEpoch: b.lastSettledEpoch,
      skippedEpochs: b.skippedEpochs,
      paused: b.paused,
      pausedUntil: b.pausedUntil,
      halted: b.halted,
      haltCause: b.haltCause,
      escapeArmedAt: b.escapeArmedAt,
      maxExitShareBps: C.MAX_EXIT_SHARE_BPS,
      // 索引器给的估算（挂了就用链上 currentRate()）
      rateStatus: idxStatus(R),
      rateNote: '估算 · 不承诺任何金额。退出按桥池份额兑付，可能远低于投入价值。'
    };
  }

  /* ── 验证者（含 gas 归集对账三元组）──────────────────── */
  function validators() {
    var V = BAC.state.validators, B = BAC.state.bsc;
    var s = B.staking, a = B.anchor;
    var chainGas = a && a.gas ? a.gas : null;
    return {
      status: V.items.length ? idxStatus(V) : bscStatus(),
      items: V.items.slice(),
      itemsStatus: idxStatus(V),
      // 链上直接读到的总量（索引器挂了也有）
      nodeCount: s ? s.nodeCount : null,
      totalStaked: V.totalStaked !== null ? V.totalStaked : (s ? s.totalStaked : null),
      rewardBalance: V.rewardBalance !== null ? V.rewardBalance : (s ? s.rewardBalance : null),
      lifetimeFunded: s ? s.lifetimeFunded : null,
      lifetimePaid: s ? s.lifetimePaid : null,
      minStake: C.MIN_VALIDATOR_STAKE,
      epochPot: s ? s.epochPot : null,
      epochSettled: s ? s.epochSettled : null,
      lastRemitEpoch: s ? s.lastRemitEpoch : null,
      // 决策 #17：层内 gas 费的「已收 / 已转入 / 差额」，全链累计口径
      gas: chainGas ? {
        collected: chainGas.collected,
        remitted: chainGas.remitted,
        shortfall: chainGas.shortfall,
        epochCollected: chainGas.epochCollected,
        epochRemitted: chainGas.epochRemitted,
        officialValidatorBps: chainGas.officialValidatorBps,   // 官方出块 → 验证者池 10%
        validatorSelfBps: chainGas.validatorSelfBps,           // 验证者出块 → 自留 50%
        ok: chainGas.shortfall === null ? null : chainGas.shortfall === 0n
      } : null,
      gasNote: '归集是受信但可对账的：合约不能强制任何人把 gas 费转进 FeeSplitter，'
        + '能保证的只有「已收 / 已转入 / 差额」三个数是公开的、任何人都能自己重算。',
      rewardNote: 'BSC 侧的 BNB 奖励和层内 gas 费验证者池是两笔钱、两个合约、两种单位，不能相加。'
    };
  }

  /* ── 纪元 ─────────────────────────────────────────────── */
  function epoch() {
    var B = BAC.state.bsc, a = B.anchor, E = BAC.state.epochs;
    var st = bscStatus();
    var cur = BAC.currentEpoch();
    return {
      status: st,
      current: cur,
      leftSec: BAC.epochLeft(),
      lengthSec: C.EPOCH,
      lastPosted: a ? a.lastPostedEpoch : null,
      lastFinal: a ? a.lastFinalEpoch : null,
      lastFinalAt: a ? a.lastFinalAt : null,
      commitWindowSec: C.COMMIT_WINDOW,
      challengeWindowSec: C.CHALLENGE_WINDOW,
      releaseBps: a ? a.releaseBps : null,
      vetoCountInWindow: a ? a.vetoCountInWindow : null,
      disputeCountInWindow: a ? a.disputeCountInWindow : null,
      haltReason: a ? a.haltReason : null,
      anchor: a ? a.anchor : null,
      state: a && a.anchor ? a.anchor.state : null,
      stateZh: a && a.anchor ? BAC.epochStateZh(a.anchor.state) : null,
      // 历史来自索引器
      historyStatus: idxStatus(E),
      history: E.items.slice()
    };
  }

  /* ── 整页状态（横幅用）──────────────────────────────── */
  function overview() {
    var s = BAC.state;
    return {
      live: s.live,
      prelaunch: s.prelaunch,
      layerLive: !!BAC.LAYER_LIVE,
      layerSource: s.layer.source,
      layerEndpoint: s.layer.endpoint,
      bsc: bscStatus(),
      indexer: idxStatus(s.indexer),
      layer: layerStatus(s.layer),
      degraded: !!s.indexer.degraded,
      banner: s.live && s.error ? TEXT.ERR : null,
      degradedBanner: degradedNote(),
      warnings: s.warnings.slice(),
      updatedAt: s.updatedAt,
      addresses: Object.assign({}, CFG.addresses),
      layerAddresses: Object.assign({}, BAC.LAYER),
      explorer: CFG.explorer,
      flapUrl: CFG.flapUrl,
      x: CFG.x,
      siteUrl: CFG.siteUrl
    };
  }

  BAC.view = {
    statusOf: statusOf,
    plainStatus: plainStatus,
    layerStatus: layerStatus,
    chainStats: chainStats,
    feed: feed,
    blocks: blocks,
    txs: txs,
    agents: agents,
    treasury: treasury,
    bridge: bridge,
    validators: validators,
    epoch: epoch,
    overview: overview
  };

  /* ── 顶层开关 ─────────────────────────────────────────── */

  BAC.start = function () {
    if (BAC.chain) BAC.chain.start();
    if (BAC.api && BAC.HAS_INDEXER) BAC.api.start();
    // 层内直读：索引器在不在都要跑（它在就只做慢速探活，不在就由它供整套块与交易）
    if (BAC.layer && BAC.HAS_LAYER_RPC) BAC.layer.start();
  };
  BAC.stop = function () {
    if (BAC.chain) BAC.chain.stop();
    if (BAC.api) BAC.api.stop();
    if (BAC.layer) BAC.layer.stop();
  };
  BAC.refresh = function (opts) {
    var jobs = [];
    if (BAC.chain) jobs.push(BAC.chain.refresh(opts || { reason: 'manual' }));
    if (BAC.api && BAC.HAS_INDEXER) jobs.push(BAC.api.run({ once: true }));
    if (BAC.layer && BAC.HAS_LAYER_RPC) jobs.push(BAC.layer.run({ once: true }));
    return Promise.all(jobs);
  };

  if (CFG.autoStart && typeof root.setTimeout === 'function') {
    root.setTimeout(function () { BAC.start(); }, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
