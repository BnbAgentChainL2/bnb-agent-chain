/* BNB Agent Chain · 数据层 · 视图模型（把两侧的原始状态拼成页面真正要的那几块）
   这里仍然没有一行 DOM 代码：只返回数据 + 一个 status。
   status 的四个值，绑定层照它选显示什么（约定 §1.3 的 miss() 规则）：
     'pre'     → 这个数还不存在（合约没部署 / 代币没发射），显示「发射后公布」
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

  /** 不看发射与否，只看这一段自己读到没有。 */
  function plainStatus(sec) {
    if (!sec) return 'loading';
    if (sec.status === 'prelaunch') return 'pre';
    if (sec.error) return 'error';
    if (!sec.ready) return 'loading';
    return 'ok';
  }

  /** 合约那一半（BacTaxRouter / BacBridge / BacNodeFund / ChainAnchor / ValidatorStaking）的状态。
      阶段 (a) 什么都没部署 → 'pre'；配了地址但探针还没回来 → 'loading'（探失败 → 'error'）；
      配了地址、链上却没代码 → 'pre'（还没部署）；有代码之后才看这一段自己读到没有。
      **只管 BSC 那一半**，层内的块、交易、链指标不许经过它 —— 见 layerStatus()。 */
  function contractStatus(sec) {
    if (!BAC.CONTRACTS_CONFIGURED) return 'pre';
    if (!BAC.CONTRACTS_LIVE) {
      var c = BAC.state.bsc.code || {};
      if (c.router === false || c.bridge === false) return 'pre';
      return BAC.state.bsc.error ? 'error' : 'loading';
    }
    return plainStatus(sec);
  }

  /** 代币那一半（价格 / 税率 / 内盘进度 / 待分发税 …）：代币地址上有代码之后才存在。
      阶段 (a)(b) 都是 'pre'（「发射后公布」）—— 这些数**真的还不存在**。 */
  function tokenStatus(sec) {
    if (!BAC.TOKEN_CONFIGURED) return 'pre';
    if (!BAC.TOKEN_LIVE) {
      var c = BAC.state.bsc.code || {};
      if (c.token === false) return 'pre';
      return BAC.state.bsc.error ? 'error' : 'loading';
    }
    return plainStatus(sec);
  }

  /** 兼容旧名：statusOf = 合约那一半的状态（v1 里它看 BAC.LIVE = isAddr(vault)）。 */
  function statusOf(sec) { return contractStatus(sec); }

  function bscStatus() { return contractStatus(BAC.state.bsc); }
  /** 某一个合约那一段：整体 ok、但这一轮这个合约一条核心读数都没返回（ABI 对不上 / 地址填错）→ 'error'，
      不许拿一屏 null 报 'ok'。部分读数失败的仍然是 'ok'，失败那几个字段是 null。 */
  function sectionStatus(name) {
    var st = bscStatus();
    if (st !== 'ok') return st;
    var f = BAC.state.bsc.failedContracts || [];
    return f.indexOf(name) >= 0 ? 'error' : st;
  }
  function sameAddr(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
  /** 已经确定 BSC 合约不存在（没配地址，或配了但链上没代码）。探针还没回来不算。 */
  function contractsAbsent() {
    if (!BAC.CONTRACTS_CONFIGURED) return true;
    var c = BAC.state.bsc.code || {};
    return c.router === false || c.bridge === false;
  }
  /** 索引器给的那几段（feed / 纪元历史 / 兑付率 / 验证者列表）：合约确定不存在时是 'pre'，
      否则只看索引器自己读到没有 —— 不等 BSC 探针（BSC 的 RPC 挂了不该拖累索引器的数据）。 */
  function idxStatus(sec) {
    if (!BAC.HAS_INDEXER) return 'pre';
    if (contractsAbsent()) return 'pre';
    return plainStatus(sec);
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

  /* ── Agent 名录（决策 #31：ERC-8004）─────────────────────
     一个 agent = 一个锁进过桥的 ERC-8004 身份编号。首选 BSC 链上直接读的名录
     （BacBridge.deposits + 注册表的 ownerOf / agentWallet / tokenURI），索引器给了同号条目就用它补层内数据。
     v1 的状态机（CHALLENGED / ACTIVE / DORMANT / BANNED / RETIRED）已经不存在：counts 里除 total 外一律 null。 */
  var LAYER_FIELDS = ['layerBalance', 'deploys', 'announces', 'lastLayerBlock'];
  function enrich(row, idx) {
    if (!idx) return row;
    var out = Object.assign({}, row);
    LAYER_FIELDS.forEach(function (k) { if (out[k] === null && idx[k] !== undefined) out[k] = idx[k]; });
    return out;
  }
  function agents(opts) {
    var G = BAC.state.agentList, D = BAC.state.agentDir, S = BAC.state.summary, B = BAC.state.bsc;
    /* 索引器只认 v2：bac/agents/1、bac/summary/1 数的是已经删掉的自研 AgentRegistry 里的 agent（#31），
       编号也不是 ERC-8004 身份号 —— 条目、总数、同号补数据一律不用。 */
    var idxV2 = G.schema === 'bac/agents/2';
    var idxItems = idxV2 ? (G.items || []) : [];
    var byId = {};
    idxItems.forEach(function (x) { byId[x.agentId] = x; });
    var chainOk = BAC.CONTRACTS_LIVE && D.ready;
    var items, source, status;
    if (chainOk) {
      items = D.items.map(function (x) { return enrich(x, byId[x.agentId]); });
      source = 'chain'; status = contractStatus(D);
    } else if (idxItems.length) {
      items = idxItems.slice(); source = 'indexer'; status = idxStatus(G);
    } else {
      items = []; source = null;
      status = BAC.CONTRACTS_CONFIGURED ? contractStatus(D) : (BAC.HAS_INDEXER ? idxStatus(G) : 'pre');
    }
    var sumV2 = !!(S && S.schema === 'bac/summary/2');
    var idxTotal = sumV2 && S.agents && S.agents.total !== undefined && S.agents.total !== null ? Number(S.agents.total) : null;
    var total = chainOk ? D.total : (idxV2 && G.total !== null && G.total !== undefined ? G.total : idxTotal);
    // 'pre' = 桥合约还不存在（阶段 a）：这时候「进场过几个 agent」这个数不存在。索引器哪怕回了 0
    // （或者演练用的条目），也不能和「发射后公布」一起出现 —— 页面先看数字再看 status，会把 0 画出来
    if (status === 'pre') { items = []; source = null; }
    // 同理：还在读（loading）/ 读失败（error）时不给任何数字 —— 只有 'ok' 才有「一共几个」
    var numeric = status === 'ok';
    if (!numeric) total = null;
    if (opts && opts.limit) items = items.slice(0, opts.limit);
    return {
      status: status,
      source: source,                     // 'chain' | 'indexer' | null
      items: items,
      total: total,                        // null = 不知道（读的不是全部存入时不猜；status 不是 ok 时也是 null）
      totalAtLeast: (chainOk && numeric) ? D.totalAtLeast : null,
      identityPaused: chainOk ? !!D.identityPaused : false,   // Multicall3 用不了：身份字段这一轮没读（null = 不知道）
      depositsTotal: B.bridge ? B.bridge.depositsTotal : null,   // BacBridge.depositId()，全量
      truncated: chainOk ? !!D.truncated : false,          // 存入太多，只读了最近 depositsMax 笔
      itemsTruncated: chainOk ? !!D.itemsTruncated : false,  // 身份太多，只列了最近 agentsMax 个
      page: G.page,
      pageSize: CFG.agentsPageSize,
      // 状态机计数已作废（v2 没有这套状态）：只保留 total，其余 null —— 页面不许显示成 0
      counts: total === null ? null : {
        total: total, challenged: null, active: null, dormant: null, banned: null, retired: null
      },
      totalFromChain: (chainOk && numeric) ? D.total : null,
      identityRegistry: CFG.identityRegistry,
      note: 'tokenURI（注册文件）与其中的名字、简介都是身份持有人自己写的，本站只原样转义显示，不背书其中任何说法。'
        + TEXT.IDENTITY_LIMIT
    };
  }

  /* ── 税收路由 · 50/50（决策 #30：BacTaxRouter，没有金库了）──────────── */
  /** 决策 #29a 的那句 + 节点基金那一半（决策 #10）。50/50 的基数是**扣掉 Flap 协议费之后**到账的 BNB
      （HANDOFF §4：1 BNB 税 → 路由只收到约 0.9 BNB，节点基金拿其中一半 ≈ 税的 45%）。
      协议费发射后以 feeConfigV2().feeRate 的真实读数为准，发射前用 Portal 实测的 1000 bps。 */
  function disclosureText(feeBps) {
    var fee = feeBps === null || feeBps === undefined ? C.FLAP_FEE_RATE_BPS : feeBps;
    return TEXT.OWNER_POWER + '节点基金这一半（扣掉 Flap ' + BAC.fmt.pct(fee) + ' 协议费后到账 BNB 的 50%）'
      + '由 BacNodeFund 的 owner 随时提取，用于服务器与节点搭建。';
  }

  /** 节点基金时间线：BSC 日志窗口 + 索引器的全量历史（只有提取和换 owner），按 tx:logIndex 合并。 */
  function nodeFundTimeline() {
    var T = BAC.state.timeline, O = BAC.state.ownerTimeline;
    var idx = (O && O.ready && !O.addressMismatch) ? O.nodeFund : [];
    return BAC.chain && BAC.chain.mergeTimeline ? BAC.chain.mergeTimeline([T.nodeFund, idx], false) : T.nodeFund.slice();
  }

  function treasury() {
    var B = BAC.state.bsc, t = B.treasury, p = B.params, tp = B.tokenParams, T = BAC.state.timeline;
    var st = sectionStatus('router');
    var base = {
      status: st,
      tokenStatus: tokenStatus(B),
      bridgeBps: C.BRIDGE_BPS, nodeFundBps: C.NODE_FUND_BPS,
      portalFeeRateBps: C.FLAP_FEE_RATE_BPS,
      disclosure: disclosureText(t ? t.taxFeeRateBps : null),
      routerOwner: null,
      routerNote: 'BacTaxRouter 没有 owner、没有管理员、没有升级入口：任何人都能调 settle() 触发分账，分账比例写死在代码里。'
    };
    if (!t) return base;
    var toBridge = t.lifetimeToBridge, toNode = t.lifetimeToNodeFund;
    var lifetimeTotal = (toBridge !== null && toNode !== null) ? toBridge + toNode : null;
    var bps = t.bridgeBps !== null && t.bridgeBps !== undefined ? t.bridgeBps : C.BRIDGE_BPS;
    return Object.assign(base, {
      // 分账比例：合约常量（BacTaxRouter.BRIDGE_BPS），不是文案
      bridgeBps: bps,
      nodeFundBps: C.BPS - bps,
      // 50/50 的基数：Flap 先抽走 feeRate，剩下的才进路由。feeRate 是代币发射后才读得到的真实值
      taxFeeRateBps: t.taxFeeRateBps,
      splitBaseNote: t.taxFeeRateBps === null ? null
        : '50/50 分的是扣掉 Flap 协议费之后的部分：(10000 − ' + t.taxFeeRateBps + ')/10000',
      // 路由自己的数（合约已部署就是真的，哪怕全是 0）
      routerBalance: t.routerBalance,
      routerAccounted: t.routerAccounted,
      routerUnsplit: t.routerUnsplit,
      routerBuckets: t.routerBuckets,
      vaultBalance: t.routerBalance,          // 旧键名 = routerBalance
      vaultAccounted: t.routerAccounted,      // 旧键名 = routerAccounted
      vaultUnsplit: t.routerUnsplit,          // 旧键名 = routerUnsplit
      totalRecognized: t.totalRecognized,
      stuckBridge: t.stuckBridge,
      stuckNodeFund: t.stuckNodeFund,
      // 两个桶
      lifetimeToBridge: toBridge,
      lifetimeToNodeFund: toNode,
      lifetimeTotal: lifetimeTotal,
      poolBalance: t.poolBalance,             // 桥的 BNB 账（BacBridge.bnbBalance）
      bridgeBnbHeld: t.bridgeBnbHeld,         // 桥地址上真实的 BNB
      nodeFundBalance: t.nodeFundBalance,
      nodeFundReceived: t.nodeFundReceived,
      nodeFundWithdrawn: t.nodeFundWithdrawn,
      nodeFundOwner: t.nodeFundOwner,
      nodeFundPendingOwner: t.nodeFundPendingOwner,
      vaultOwner: null,                       // 旧键名：路由没有 owner
      // 代币发射后才有的数
      pendingTax: t.pendingTax,
      lifetimeTaxToRouter: t.lifetimeTaxToRouter,
      marketAddressOk: tp ? tp.marketAddressOk : null,
      wiring: p ? p.wiring : null,
      // 时间线（最近窗口的日志）：税收 → 路由 → 分账 → 推送；节点基金的到账 / 提取 / 换 owner
      flow: T.flow.slice(),
      nodeFundEvents: nodeFundTimeline(),
      timelineStatus: contractStatus(T),
      // 「全了」= 从部署块扫到了链头、没有缺口，**而且**两条列表都没因为超过 timelineMax 丢过最旧的条目
      timelineComplete: !!T.complete && !(T.truncated && (T.truncated.flow || T.truncated.nodeFund)),
      timelineTruncated: { flow: !!(T.truncated && T.truncated.flow), nodeFund: !!(T.truncated && T.truncated.nodeFund) },
      timelineMax: CFG.timelineMax,
      settleNote: '路由的稳态余额取决于有没有人调 settle()：没有任何合约或定时器会自动调它。'
    });
  }

  /* ── 桥（BacBridge：UUPS 代理，owner 可升级 + 紧急提取，决策 #29）──────── */
  function bridge() {
    var B = BAC.state.bsc, b = B.bridge;
    var st = sectionStatus('bridge');
    if (!b) return { status: st, tokenStatus: tokenStatus(B), notice: TEXT.OWNER_POWER, maxExitShareBps: C.MAX_EXIT_SHARE_BPS };
    var p = B.params;
    return {
      status: st,
      tokenStatus: tokenStatus(B),
      address: b.address,
      // 账（合约部署后就是真的，哪怕全是 0）
      lockedBac: b.lockedBac,
      totalLocked: b.totalLocked,
      totalBurned: b.totalBurned,
      totalIssued: b.totalIssued,
      totalExited: b.totalExited,
      creditsOutstanding: b.creditsOutstanding,
      depositsTotal: b.depositsTotal,
      bnbBalance: b.bnbBalance,
      poolBalance: b.poolBalance,
      bnbHeld: b.bnbHeld,
      buybackBac: b.buybackBac,
      buybackBudget: b.buybackBudget,
      buybackBacBought: b.buybackBacBought,
      buybackBnbSpent: b.buybackBnbSpent,
      bacAccounted: b.bacAccounted,
      bacHeld: b.bacHeld,
      buyback: b.buyback,
      owedTotal: b.owedTotal,
      reservedTotal: b.reservedTotal,
      releasedInWindow: b.releasedInWindow,
      bacPerCredit: b.bacPerCredit,
      weiPerCredit: b.weiPerCredit,       // 旧键名，含义已变：BAC / 积分（1e18 定点），不是 BNB
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
      // owner 权力：谁、现在的实现、做过几次（计数器是全量的）
      owner: b.owner,
      pendingOwner: b.pendingOwner,
      implementation: b.implementation,
      implementationFresh: !!b.implementationFresh,
      unloggedImplementationChanges: (b.unloggedImplementationChanges || []).slice(),
      extension: b.extension,
      // BacBridge.router()：PancakeSwap V2 Router（毕业后回购走外盘），不是税收路由
      dexRouter: p ? p.bridge.dexRouter : null,
      upgradeCount: b.upgradeCount,
      lastUpgradeAt: b.lastUpgradeAt,
      emergencyCount: b.emergencyCount,
      lastEmergencyAt: b.lastEmergencyAt,
      emergencyBnbWithdrawn: b.emergencyBnbWithdrawn,
      emergencyBacWithdrawn: b.emergencyBacWithdrawn,
      shortfall: b.shortfall,
      identityRegistry: p ? p.bridge.identityRegistry : null,
      wiring: p ? p.wiring : null,
      notice: TEXT.OWNER_POWER,
      onchainNotice: p ? p.bridge.ownerPowerNotice : null,
      noticeMatches: p ? p.noticeMatches : null,
      description: p ? p.bridge.description : null,
      rateStatus: idxStatus(BAC.state.rate),
      rateNote: '估算 · 不承诺任何金额。退出拿的是桥用税收 BNB 回购来的 BAC，按份额兑付，可能远低于投入价值。'
    };
  }

  /* ── owner 权力时间线（决策 #29c：每一次升级与提取都要能看见）──────────
     计数器（upgradeCount / emergencyCount / 累计提取额）直接读合约，是全量的；
     逐条记录来自 BSC 日志，公共节点只给最近一个窗口 —— 缺几条就照实说缺几条，并给出 BscScan 事件页。 */
  function ownerPowers() {
    var B = BAC.state.bsc, b = B.bridge || {}, T = BAC.state.timeline, O = BAC.state.ownerTimeline;
    /* 两个来源合并：BSC 日志窗口（最近约 40 分钟，新鲜）+ 索引器 /api/bridge/timeline（从部署起的全量历史）。
       索引器那份读到过一次就一直可用（链上事件不会消失），这一轮失败只是没有更新的部分。 */
    var idxUsable = !!(O && O.ready && !O.addressMismatch);
    var idxItems = idxUsable ? O.owner : [];
    var items = BAC.chain && BAC.chain.mergeTimeline ? BAC.chain.mergeTimeline([T.owner, idxItems], true) : T.owner.slice();
    var seenUp = items.filter(function (x) { return x.kind === 'upgrade'; }).length;
    var seenEm = items.filter(function (x) { return x.kind === 'emergency'; }).length;
    function miss(total, seen) {
      if (total === null || total === undefined) return null;
      return total > seen ? total - seen : 0;
    }
    var missing = { upgrades: miss(b.upgradeCount, seenUp), emergencies: miss(b.emergencyCount, seenEm) };
    var countersCovered = missing.upgrades === 0 && missing.emergencies === 0;
    var blocks = CFG.logWindowBlocks;
    function v(x) { return x === undefined ? null : x; }
    /* 「整条时间线全了」两条路：
       ① 日志窗口自己从部署块扫起、扫到链头、没有缺口（T.complete）；
       ② 索引器的历史从部署那一刻开始（看得到 initialize 发的 Initialized，或 owner 从零地址给出去的那一条）、
          没被 limit 截断、它的摄取游标和日志窗口接得上（窗口起点 ≤ 游标 + 1，窗口里的缺口都在游标之前），
          而且日志窗口这一轮扫到了链头。任何一条不满足就不说「全了」。 */
    var ZERO_RE = /^0x0{40}$/i;
    var fromDeploy = items.some(function (x) {
      return x.kind === 'initialized' || (x.kind === 'ownership' && typeof x.from === 'string' && ZERO_RE.test(x.from));
    });
    var cur = idxUsable ? O.bscCursor : null;
    var joined = cur !== null && cur !== undefined && T.fromBlock !== null && T.fromBlock <= cur + 1
      && T.gaps.every(function (g) { return g[1] <= cur; });
    /* 日志窗口那条 owner 列表超过 timelineMax 时丢过最旧的条目（这一页里补不回来）：
       ① 自己那条路就不能再说全了；② 走索引器那条路，要索引器的历史覆盖到丢掉的最新那一块才行。 */
    var cut = !!(T.truncated && T.truncated.owner);
    var droppedThrough = T.droppedThrough ? T.droppedThrough.owner : null;
    var droppedCovered = !cut || (cur !== null && cur !== undefined && droppedThrough !== null && droppedThrough <= cur);
    var viaRpc = !!T.complete && !cut;
    var viaIndexer = !!(idxUsable && plainStatus(O) === 'ok' && !O.truncated && fromDeploy
      && joined && T.caughtUp && plainStatus(T) === 'ok' && droppedCovered);
    var complete = viaRpc || viaIndexer;
    /* #29c 靠的信号不能只由 owner 控制：
       - 时间线里单独的 Upgraded（不和 Initialized(1) 同一笔、同一笔里也没有 BridgeUpgraded）= 没留痕的换实现；
       - 本页读实现槽时看到槽变了、升级计数器没变（bac-chain.js readImplementation）；
       - 时间线全了的时候，日志里最后一次换到的实现必须就是现在实现槽里的那个。 */
    var lastImpl = null;
    for (var i = 0; i < items.length; i++) {
      var x = items[i];
      if (x.kind === 'upgrade') { lastImpl = x.newImplementation; break; }
      if (x.kind === 'implementation') { lastImpl = x.implementation; break; }
    }
    var implNow = v(b.implementation);
    var unloggedEvents = items.filter(function (x) { return x.kind === 'implementation' && x.unlogged === true; }).length;
    var slotChanges = (b.unloggedImplementationChanges || []).slice();
    return {
      status: sectionStatus('bridge'),
      timelineStatus: contractStatus(T),
      // 索引器那份全量历史的状态（旧版索引器没有这个端点 → 'error'，页面照旧只用日志窗口）
      historyStatus: idxStatus(O),
      historyTotals: idxUsable ? O.totals : null,
      sources: { rpc: T.owner.length, indexer: idxItems.length },
      owner: v(b.owner),
      pendingOwner: v(b.pendingOwner),
      implementation: v(b.implementation),
      extension: v(b.extension),
      upgradeCount: v(b.upgradeCount),
      lastUpgradeAt: v(b.lastUpgradeAt),
      emergencyCount: v(b.emergencyCount),
      lastEmergencyAt: v(b.lastEmergencyAt),
      emergencyBnbWithdrawn: v(b.emergencyBnbWithdrawn),
      emergencyBacWithdrawn: v(b.emergencyBacWithdrawn),
      shortfall: b.shortfall || { bnb: null, bac: null, source: null },
      notice: TEXT.OWNER_POWER,
      items: items,
      seen: { upgrades: seenUp, emergencies: seenEm },
      missing: missing,
      // 升级与紧急提取两类：计数器对上了就是全的（哪怕日志窗口没覆盖到部署块）
      upgradesAndWithdrawalsComplete: countersCovered,
      // 整条时间线（含换 owner / 暂停）：见上面两条路，任何一条成立才算全
      complete: complete,
      completeVia: viaRpc ? 'rpc' : (viaIndexer ? 'indexer' : null),
      coverage: {
        fromBlock: T.fromBlock, syncedTo: T.syncedTo, deployBlock: T.deployBlock, windowBlocks: blocks, gaps: T.gaps.slice(),
        indexerThrough: cur === undefined ? null : cur, fromDeploy: fromDeploy,
        // 日志窗口那条列表超过 timelineMax 丢过最旧的条目；droppedThrough = 丢掉的最新那一块
        truncated: cut, droppedThrough: cut ? droppedThrough : null, timelineMax: CFG.timelineMax
      },
      implementationFresh: !!b.implementationFresh,
      // 日志里最后一次换到的实现（null = 时间线里一次都没看到）
      loggedImplementation: lastImpl,
      // 现在的实现槽和日志对不对得上：只有整条时间线全了、而且升级计数器和日志里的升级次数一致时才下结论
      // （一次升级正落在「扫日志」和「读槽」之间时两边会差一轮，那时计数器也对不上 → null，不报假的「对不上」）
      implementationMatchesLog: (complete && implNow && lastImpl && missing.upgrades === 0 && b.upgradeCount === seenUp)
        ? sameAddr(implNow, lastImpl) : null,
      unlogged: { upgradedEvents: unloggedEvents, slotChanges: slotChanges, total: unloggedEvents + slotChanges.length },
      eventsUrl: BAC.isAddr(CFG.addresses.bridge) ? BAC.links.addressEvents(CFG.addresses.bridge) : null,
      note: '次数、最近一次的时间和累计提取额直接读桥合约的计数器，是全量的。逐条记录来自索引器的全量历史'
        + '与 BSC 日志：公共节点只给最近约 ' + blocks + ' 个块（约 ' + Math.round(blocks * C.BSC_BLOCK_TIME / 60) + ' 分钟），'
        + '索引器读不到时更早的记录请到 BscScan 的事件页核对。'
    };
  }

  /* ── 代币（阶段 c 之前一律 'pre'：价格 / 税率 / 交易这些数还不存在）─────── */
  function token() {
    var B = BAC.state.bsc, tp = B.tokenParams, tk = B.token;
    var addr = BAC.isAddr(CFG.addresses.token) ? CFG.addresses.token : null;
    return {
      status: tokenStatus(B),
      address: addr,                                   // 合约地址（CA）：已锁定，发射前就可以公开
      launched: BAC.TOKEN_LIVE,
      codeKnown: B.code ? B.code.token !== null : false,
      note: BAC.TOKEN_LIVE ? null : (addr ? TEXT.TOKEN_NOT_LAUNCHED : null),
      explorerUrl: addr ? BAC.links.token(addr) : null,
      flapUrl: CFG.flapUrl || null,
      name: tp ? tp.name : null,
      symbol: tp ? tp.symbol : null,
      decimals: tp ? tp.decimals : null,
      totalSupply: tp ? tp.totalSupply : null,
      taxRate: tp ? tp.taxRate : null,
      buyTaxRate: tp ? tp.buyTaxRate : null,
      sellTaxRate: tp ? tp.sellTaxRate : null,
      taxProcessor: tp ? tp.taxProcessor : null,
      marketAddress: tp ? tp.marketAddress : null,
      marketAddressOk: tp ? tp.marketAddressOk : null,
      taxFeeRateBps: tp ? tp.taxFeeRateBps : null,
      portal: tk ? tk.portal : null,                    // {status, statusName, statusZh, price, progress, pool, reserve, …}
      priceNote: '价格是 Flap Portal 给的「每个 BAC 折合多少 BNB」（18 位定点），不是法币价格。',
      bridgeBac: tk ? tk.bridgeBac : null,
      pendingTax: tk ? tk.pendingTax : null,
      lifetimeTaxToRouter: tk ? tk.lifetimeTaxToRouter : null,
      flapPortal: CFG.flapPortal
    };
  }

  /* ── 三阶段（横幅 / 各面板用来选文案）──────────────────────────── */
  function stage() {
    var c = BAC.state.bsc.code || {};
    function v(x) { return x === undefined ? null : x; }
    return {
      stage: BAC.STAGE,                     // 'none' | 'deployed' | 'launched'
      known: BAC.STAGE_KNOWN,
      contractsConfigured: BAC.CONTRACTS_CONFIGURED,
      contractsLive: BAC.CONTRACTS_LIVE,
      tokenConfigured: BAC.TOKEN_CONFIGURED,
      tokenLive: BAC.TOKEN_LIVE,
      code: { token: v(c.token), router: v(c.router), bridge: v(c.bridge) },
      tokenAddress: BAC.isAddr(CFG.addresses.token) ? CFG.addresses.token : null,
      legacyConfig: (CFG.legacyKeys || []).slice()
    };
  }

  /* ── 验证者（含 gas 归集对账三元组）──────────────────── */
  function validators() {
    var V = BAC.state.validators, B = BAC.state.bsc;
    var s = B.staking;
    /* 决策 #17 的「已收 / 已转入 / 差额」：ChainAnchor / ValidatorStaking 里没有对应的读函数（编译产物核对过），
       所以唯一真实来源是索引器 /api/health 的 gas 块（来自 FINAL 锚点，单位是层内 BAC）。索引器读不到就是 null。 */
    var L = BAC.state.layer, lg = L && L.gas ? L.gas : null;
    // 一个 FINAL 锚点都还没有（lastAnchoredEpoch = null）时索引器给的是占位 "0"：那不是「已收 0」，是还没有这笔账
    if (lg && (lg.lastAnchoredEpoch === null || lg.lastAnchoredEpoch === undefined || contractsAbsent())) lg = null;
    var chainGas = lg ? {
      collected: lg.received, remitted: lg.remitted, shortfall: lg.gap,
      epochCollected: null, epochRemitted: null,
      officialValidatorBps: lg.officialBlockValidatorBps !== null ? lg.officialBlockValidatorBps : C.OFFICIAL_BLOCK_VALIDATOR_BPS,
      validatorSelfBps: lg.validatorBlockValidatorBps !== null ? lg.validatorBlockValidatorBps : C.VALIDATOR_BLOCK_VALIDATOR_BPS,
      lastAnchoredEpoch: lg.lastAnchoredEpoch,
      source: 'indexer'
    } : null;
    /* 总质押 / 奖励余额：**链上直读优先**（ValidatorStaking.totalStaked() / rewardBalance() 是真的测量值）。
       索引器的 totalStaked 不是测量值，是它已经索引到的验证者行的求和：摄取落后、或它没配 staking 地址时就是 "0"。
       所以只在链上这个数没读到、而且本站配了 staking 地址时才拿索引器的顶上（来源另标）。 */
    var stakingCfg = BAC.isAddr(CFG.addresses.staking);
    function pickNum(chainV, idxV) {
      if (chainV !== null && chainV !== undefined) return { v: chainV, src: 'chain' };
      if (stakingCfg && idxV !== null && idxV !== undefined) return { v: idxV, src: 'indexer' };
      return { v: null, src: null };
    }
    var ts = pickNum(s ? s.totalStaked : null, V.totalStaked);
    var rb = pickNum(s ? s.rewardBalance : null, V.rewardBalance);
    return {
      status: V.items.length ? idxStatus(V) : sectionStatus('staking'),
      items: V.items.slice(),
      itemsStatus: idxStatus(V),
      // 链上直接读到的总量（索引器挂了也有）
      nodeCount: s ? s.nodeCount : null,
      totalStaked: ts.v,
      totalStakedSource: ts.src,            // 'chain' | 'indexer' | null
      rewardBalance: rb.v,
      rewardBalanceSource: rb.src,
      lifetimeFunded: s ? s.lifetimeFunded : null,
      lifetimePaid: s ? s.lifetimePaid : null,
      minStake: C.MIN_VALIDATOR_STAKE,
      /* 奖池按「天」记（ValidatorStaking.dayReward(day)，144 个纪元一天）：rewardDay 是最近一个上报纪元所在的那一天。
         合约里没有「每个纪元的奖池」—— epochPot / epochSettled 恒为 null，不许把一天的池子标成「本纪元」。 */
      rewardDay: s ? s.rewardDay : null,
      dayPot: s ? s.dayPot : null,
      dayWeight: s ? s.dayWeight : null,
      daySettled: s ? s.daySettled : null,
      epochsPerDay: C.EPOCHS_PER_DAY,
      epochPot: null,
      epochSettled: null,
      lastRemitEpoch: null,     // 合约里没有这个读函数
      // 决策 #17：层内 gas 费的「已收 / 已转入 / 差额」，截至最近一个 FINAL 锚点的累计口径（来源：索引器）
      gas: chainGas ? {
        collected: chainGas.collected,
        remitted: chainGas.remitted,
        shortfall: chainGas.shortfall,
        epochCollected: chainGas.epochCollected,
        epochRemitted: chainGas.epochRemitted,
        officialValidatorBps: chainGas.officialValidatorBps,   // 官方出块 → 验证者池 10%
        validatorSelfBps: chainGas.validatorSelfBps,           // 验证者出块 → 自留 50%
        lastAnchoredEpoch: chainGas.lastAnchoredEpoch,
        source: chainGas.source,
        ok: chainGas.shortfall === null || chainGas.shortfall === undefined ? null : chainGas.shortfall === 0n
      } : null,
      gasNote: '归集是受信但可对账的：合约不能强制任何人把 gas 费转进 FeeSplitter，'
        + '能保证的只有「已收 / 已转入 / 差额」三个数是公开的、任何人都能自己重算。',
      rewardNote: 'BSC 侧的 BNB 奖励和层内 gas 费验证者池是两笔钱、两个合约、两种单位，不能相加。'
    };
  }

  /* ── 纪元 ─────────────────────────────────────────────── */
  function epoch() {
    var B = BAC.state.bsc, a = B.anchor, E = BAC.state.epochs;
    var st = sectionStatus('anchor');
    var cur = BAC.currentEpoch();
    return {
      status: st,
      current: cur,
      leftSec: BAC.epochLeft(),
      lengthSec: C.EPOCH,
      // null = 一个锚点都还没上报 / 定案过（构造函数的占位值已经在数据层滤掉，不会出现在这里）
      firstEpoch: a && a.firstEpoch !== undefined ? a.firstEpoch : null,
      lastPosted: a ? a.lastPostedEpoch : null,
      lastFinal: a ? a.lastFinalEpoch : null,
      lastFinalAt: a ? a.lastFinalAt : null,
      // 「多久没有新的 FINAL 锚点就停机」的计时起点：还没有 FINAL 锚点时就是锚点合约的部署时间
      haltClockFrom: a && a.haltClockFrom !== undefined ? a.haltClockFrom : null,
      commitWindowSec: C.COMMIT_WINDOW,
      // 锚点等待（决策 #18 术语 / #25 时长）。字段名 challengeWindowSec 保留为兼容别名，
      // 页面一律读 anchorWaitSec，显示文案一律是「锚点等待」。
      anchorWaitSec: C.CHALLENGE_WINDOW,
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
      live: s.live,                     // 兼容：= contractsLive || tokenLive（探针回来之前 = 配置里填了合约）
      prelaunch: s.prelaunch,
      stage: BAC.STAGE,                 // 'none' | 'deployed' | 'launched'
      stageKnown: BAC.STAGE_KNOWN,
      contractsLive: BAC.CONTRACTS_LIVE,
      tokenLive: BAC.TOKEN_LIVE,
      tokenAddress: BAC.isAddr(CFG.addresses.token) ? CFG.addresses.token : null,
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
      /* 地址簿（全部来自 site.config.js / 主网常量，不是链上读数）。
         vault 是 router 的旧名（index.html 的 data-addr="vault" 那一行还在读它），换完插槽就删。
         identityRegistry / flapPortal 是 BNB Chain / Flap 的主网合约，现在就真实存在。 */
      addresses: Object.assign({}, CFG.addresses, {
        vault: CFG.addresses.router,
        identityRegistry: CFG.identityRegistry,
        flapPortal: CFG.flapPortal,
        pancakeRouter: CFG.pancakeRouter      // 桥毕业后回购走的外盘（BacBridge.router()）
      }),
      failedContracts: (s.bsc.failedContracts || []).slice(),
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
    contractStatus: contractStatus,
    tokenStatus: tokenStatus,
    layerStatus: layerStatus,
    stage: stage,
    token: token,
    ownerPowers: ownerPowers,
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
