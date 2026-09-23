/* BNB Agent Chain · 绑定层 —— **唯一** 读 window.BAC 的文件（04-website-conventions.md §1.1）
   它把数据层的视图模型搬进 window.BACVM，再叫可视层重画。可视层不认识 BAC，也不认识 fetch / RPC。
   演示数据只有两个条件同时成立才会启用：没有配置合约地址（BAC.LIVE === false）且 URL 带 ?demo=1。 */
(function (root) {
  'use strict';

  var VM = root.BACVM, UI = root.BACUI;
  if (!VM || !UI || !UI.shell) {
    if (root.console) root.console.error('[BACBIND] 需要先加载 js/ui/vm.js 与 js/ui/shell.js');
    return;
  }
  var BAC = root.BAC;
  var DEMO_WANTED = /(^|[?&])demo=1(&|$)/.test(root.location.search);

  /* ── 小工具 ───────────────────────────────────────────── */
  function n(v) { return v === undefined || v === null ? null : Number(v); }
  function b(v) { return (BAC && BAC.big) ? BAC.big(v) : (typeof v === 'bigint' ? v : null); }
  var LAYER = (BAC && BAC.LAYER) || {};
  var SYS = {};
  Object.keys(LAYER).forEach(function (k) { SYS[String(LAYER[k]).toLowerCase()] = k; });

  var scheduled = false;
  function repaint() {
    if (scheduled) return;
    scheduled = true;
    (root.requestAnimationFrame || root.setTimeout)(function () { scheduled = false; UI.refresh(); }, 16);
  }

  /* ── 交易的种类与方法名（索引器不返回 input，只能按收据归类）───── */
  function txKind(t) {
    if (t.created) return { type: 'deploy', method: '合约部署', kindLabel: 'created' };
    var to = String(t.to || '').toLowerCase();
    if (SYS[to]) return { type: 'bridge', method: SYS[to], kindLabel: 'system' };
    if (t.value && t.value !== 0n) return { type: 'transfer', method: '转账', kindLabel: 'agent' };
    return { type: 'call', method: '合约调用', kindLabel: 'contract' };
  }

  function mapTx(t) {
    var k = txKind(t);
    return {
      hash: t.hash, block: t.block, idx: t.idx, ts: t.ts,
      agentId: t.agentId, fromAddr: t.from, to: t.to, created: t.created,
      toAgentId: null, toContractAgentId: null, toLabelKind: k.kindLabel,
      method: k.method, type: k.type,
      value: t.value, gasUsed: t.gasUsed,
      /* zeroBaseFee 下 feeBurned 恒为 0；真正的手续费是 feeToProposer（03 §3.7），
         数据层还没解码它 —— 读不到就是 null，绝不用 gasUsed × 1 gwei 顶替。 */
      fee: t.feeToProposer !== undefined ? b(t.feeToProposer) : null,
      ok: t.status === null || t.status === undefined ? null : t.status === 1,
      input: null, logs: [], nonce: null
    };
  }

  function mapBlock(bl, extra) {
    extra = extra || {};
    var prop = extra.proposer || null;
    return {
      number: bl.number, hash: bl.hash, parent: extra.parentHash || null, ts: bl.ts,
      txCount: bl.txCount, gasUsed: bl.gasUsed, gasLimit: bl.gasLimit,
      fee: extra.gasFees !== undefined ? b(extra.gasFees) : null,
      proposer: prop,
      proposerKind: prop ? (extra.official === false ? 'validator' : 'official') : null,
      epoch: bl.epoch, size: extra.size || null,
      stateRoot: extra.stateRoot || null, extra: extra.extraData || null,
      txs: extra.txs || null,
      anchored: extra.anchored === undefined ? false : !!extra.anchored
    };
  }

  function mapAgent(a) {
    var spent = (a.credited !== null && a.exited !== null && a.layerBalance !== null)
      ? a.credited - a.exited - a.layerBalance : null;
    return {
      id: a.agentId, status: a.statusName, statusZh: a.statusZh,
      statusCls: ({ ACTIVE: 'ok', DORMANT: 'warn', BANNED: 'bad', CHALLENGED: 'wait', RETIRED: 'dim' })[a.statusName] || 'dim',
      wallet: a.wallet, controller: a.controller,
      joinedTs: a.activatedAt || a.registeredAt,
      credited: a.credited, exited: a.exited, spent: spent, balance: a.layerBalance,
      deploys: a.deploys, announces: a.announces, actions: null,
      hbEpoch: a.lastHeartbeatEpoch, missed: a.missed,
      uri: a.agentURI, uriOk: null, endpointOk: null,
      endpointHash: a.endpointHash, fingerprint: a.modelFingerprint,
      sum: null, hb: [], contracts: [], deposits: [], exits: []
    };
  }

  function mapValidator(v) {
    var g = v.gas || {};
    var e = v.earned || {};
    return {
      nodeId: v.nodeId, addr: v.validator, payout: v.payout,
      stake: v.staked, active: v.active, agreed: v.agreedEpochs, disputed: v.disputedEpochs,
      strikes: v.strikes, lastEpoch: v.lastEpoch,
      blocks: (e.gasSelfProposed && e.gasSelfProposed.blocks !== undefined) ? n(e.gasSelfProposed.blocks) : null,
      epochGas: null,
      lifetimeClaimedBnb: v.lifetimeClaimed,
      gasPoolLifetime: (e.gasPool && e.gasPool.lifetimeClaimed !== undefined) ? b(e.gasPool.lifetimeClaimed) : null,
      gasPoolPending: (e.gasPool && e.gasPool.pending !== undefined) ? b(e.gasPool.pending) : null,
      selfKept: (e.gasSelfProposed && e.gasSelfProposed.lifetimeKept !== undefined) ? b(e.gasSelfProposed.lifetimeKept) : null,
      attend30: (e.gasPool && e.gasPool.attend30 !== undefined) ? n(e.gasPool.attend30) : null,
      rights: g.proposerRights, qualifyStreak: g.qualifyStreak,
      cumOwed: g.collected, cumRemitted: g.remitted, arrears: g.shortfall, shortfall: g.shortfallFlag
    };
  }

  function mapEpoch(e) {
    var cls = { FINAL: 'final', POSTED: 'posted', VETOED: 'bad', DISPUTED: 'bad' }[e.state] || 'open';
    return {
      n: e.epoch, stateEn: e.state, stateZh: e.stateZh, stateCls: cls,
      exits: e.exitCount, exitRoot: e.exitRoot, proposerIncomeRoot: e.proposerIncomeRoot || null,
      anchorTx: e.postedTx, postedAt: e.postedAt,
      agreeing: e.agreeingCount, members: null,
      releaseBps: e.releaseBps,
      gasFees: e.gasFees, gasRemitted: e.remitted,
      gasGap: (e.gasFees !== null && e.remitted !== null) ? (e.gasFees - e.remitted) : null,
      poolAccrued: null, foundationAccrued: null, poolClaimed: null, poolRemainder: null,
      pot: e.pot, rate: e.rate, blocks: null
    };
  }

  /* ── 从 window.BAC 拉一份完整的视图模型 ───────────────────── */
  function pull() {
    if (!BAC || !BAC.view) return;
    var v = BAC.view;
    var cs = v.chainStats(), ag = v.agents({}), tr = v.treasury(), br = v.bridge(),
      va = v.validators(), ep = v.epoch(), fd = v.feed(), bk = v.blocks(), tx = v.txs(), ov = v.overview();

    VM.mode = BAC.LIVE ? 'live' : 'pre';
    VM.st.chain = cs.status;
    VM.st.blocks = bk.status;
    VM.st.txs = tx.status;
    VM.st.agents = ag.status;
    VM.st.epochs = ep.historyStatus || ep.status;
    VM.st.validators = va.status;
    VM.st.treasury = tr.status;
    VM.st.bridge = br.status;
    VM.st.feed = fd.status;
    VM.st.contracts = bk.status;          // 合约名录和层内数据同源
    VM.st.daily = BAC.LIVE ? 'error' : 'pre';   // 没有日聚合端点：不画，也不编

    VM.blocks = bk.items.map(function (x) { return mapBlock(x); });
    VM.blockByNum = {};
    VM.blocks.forEach(function (x) { VM.blockByNum[x.number] = x; });

    VM.txs = tx.items.map(mapTx);
    VM.txByHash = {};
    VM.txs.forEach(function (x) { VM.txByHash[x.hash] = x; });

    VM.agents = ag.items.map(mapAgent);
    VM.agentById = {};
    VM.agents.forEach(function (x) { VM.agentById[x.id] = x; });

    VM.epochs = (ep.history || []).map(mapEpoch);
    VM.epochByN = {};
    VM.epochs.forEach(function (x) { VM.epochByN[x.n] = x; });

    VM.feed = fd.items.map(function (it) {
      return { id: it.id, chain: it.chain === 'bsc' ? 'BSC' : 'LAYER', kind: it.kind, ts: it.ts,
        textZh: it.textZh, anchored: it.anchored, tx: it.tx, agentId: it.agentId };
    });

    VM.validators = {
      items: (va.items || []).map(mapValidator),
      nodeCount: va.nodeCount, slots: 64, totalStaked: va.totalStaked,
      rewardBalance: va.rewardBalance, epochPot: va.epochPot,
      lifetimeFunded: va.lifetimeFunded, lifetimePaid: va.lifetimePaid,
      minStake: va.minStake,
      agreeingCount: ep.vetoCountInWindow === null ? null : null,
      memberCount: va.nodeCount, releaseBps: ep.releaseBps
    };

    VM.treasury = {
      bridgeBps: tr.bridgeBps, nodeFundBps: tr.nodeFundBps, taxFeeRateBps: tr.taxFeeRateBps,
      lifetimeTotal: tr.lifetimeTotal, toBridge: tr.lifetimeToBridge, toNodeFund: tr.lifetimeToNodeFund,
      vaultBalance: tr.vaultBalance, vaultUnsplit: tr.vaultUnsplit,
      stuckBridge: tr.stuckBridge, stuckNodeFund: tr.stuckNodeFund,
      poolBalance: tr.poolBalance, nodeFundBalance: tr.nodeFundBalance,
      nodeFundWithdrawn: tr.nodeFundWithdrawn,
      releaseBps: br.lastPotBps === undefined ? null : br.lastPotBps,
      releasable: br.lastPot, owedTotal: br.owedTotal,
      disclosure: tr.disclosure, splitBaseNote: tr.splitBaseNote,
      /* GET /api/treasury 还没有进数据层的状态机：事件表只能显示占位 */
      events: [], eventsStatus: BAC.LIVE ? 'error' : 'pre'
    };

    VM.bridge = {
      totalLocked: br.totalLocked, totalIssued: br.totalIssued, totalExited: br.totalExited,
      creditsOutstanding: br.creditsOutstanding, poolBalance: br.poolBalance, owedTotal: br.owedTotal,
      weiPerCredit: br.weiPerCredit, lastPot: br.lastPot, releaseBps: br.lastPotBps,
      paused: br.paused, halted: br.halted
    };

    var last20 = VM.blocks.slice(0, 20);
    var tps = last20.length === 20 && last20[0].txCount !== null
      ? last20.reduce(function (s, x) { return s + (x.txCount || 0); }, 0) / 60 : null;

    VM.chain = {
      chainId: cs.chainId, source: cs.source, degraded: cs.degraded, degradedNote: cs.degradedNote,
      head: cs.head, headTs: cs.headTs, blockLagSec: cs.blockLagSec,
      blockTimeSec: cs.blockTimeSec, targetBlockTimeSec: cs.targetBlockTimeSec,
      gasLimit: cs.gasLimit, baseFee: cs.baseFee, minGasPriceGwei: 1,
      peers: cs.peers, txPool: null,                        // txpool 深度：索引器没这个字段
      txTotal: cs.txTotal, contractsTotal: cs.contractsTotal,
      circulating: cs.circulating, burnedTotal: cs.burnedTotal, totalSupply: cs.totalSupply,
      epoch: cs.epoch, epochLeftSec: cs.epochLeftSec,
      lastPostedEpoch: cs.lastPostedEpoch, lastFinalEpoch: cs.lastFinalEpoch,
      tps: tps, tx24h: null, blocks24h: null,               // 24h 聚合：没有端点
      agentCounts: ag.counts || (ag.total !== null ? { total: ag.total, active: null, dormant: null, banned: null, challenged: null, retired: null } : null),
      nodeCount: va.nodeCount, nodeSlots: 64, totalStaked: va.totalStaked,
      bridgePool: br.poolBalance,
      reconcile: cs.reconcile
    };

    var g = va.gas || {};
    VM.fees = {
      received: g.collected === undefined ? null : g.collected,
      remitted: g.remitted === undefined ? null : g.remitted,
      gap: g.shortfall === undefined ? null : g.shortfall,
      anchoredThrough: fd.anchoredThrough,
      howToCheck: (cs.reconcile && cs.reconcile.howToCheck) || [],
      officialValidatorBps: g.officialValidatorBps || 1000,
      validatorSelfBps: g.validatorSelfBps || 5000,
      splitterBalance: null, poolPending: null, poolRemainder: null,
      lifetimePool: null, lifetimePoolClaimed: null,
      lifetimeFoundationAccrued: null, lifetimeValidatorSelfKept: null,
      epochPool: g.epochCollected === undefined ? null : g.epochCollected
    };
    VM.st.fees = VM.st.validators;

    VM.addresses = ov.addresses || {};
    VM.layerAddresses = ov.layerAddresses || {};
    VM.links = { explorer: ov.explorer, flapUrl: ov.flapUrl, x: ov.x, siteUrl: ov.siteUrl };
    VM.warnings = ov.warnings || [];
    VM.updatedAt = ov.updatedAt;

    pullFees();
    repaint();
  }

  /* /api/fees 目前只有裸端点（bac-api.js 有 api.fees()，bac-view.js 还没有对应的 view）：
     这里直接问数据层要，读不到就保持 null，**不猜**。 */
  var feesAt = 0;
  function pullFees() {
    if (!BAC || !BAC.api || !BAC.api.fees || !BAC.HAS_INDEXER || !BAC.LIVE) return;
    var t = Date.now();
    if (t - feesAt < 20000) return;
    feesAt = t;
    BAC.api.fees().then(function (j) {
      var r = j.reconcile || {}, sp = j.splitter || {}, ru = j.rules || {};
      VM.fees.received = b(r.received);
      VM.fees.remitted = b(r.remitted);
      VM.fees.gap = b(r.gap);
      VM.fees.anchoredThrough = n(r.anchoredThrough);
      VM.fees.howToCheck = (r.howToCheck || []).slice();
      VM.fees.officialValidatorBps = n(ru.officialBlockValidatorBps) || 1000;
      VM.fees.validatorSelfBps = n(ru.validatorBlockValidatorBps) || 5000;
      VM.fees.splitterBalance = b(sp.balance);
      VM.fees.poolPending = b(sp.poolPending);
      VM.fees.lifetimePool = b(sp.lifetimePool);
      VM.fees.lifetimePoolClaimed = b(sp.lifetimePoolClaimed);
      VM.fees.lifetimeFoundationAccrued = b(sp.lifetimeFoundationAccrued);
      VM.fees.lifetimeValidatorSelfKept = b(sp.lifetimeValidatorRemitted);
      VM.st.fees = 'ok';
      repaint();
    }).catch(function () { /* 读不到就保持上一轮的 null，页面显示「读取失败 · 重试中」 */ });
  }

  /* ── 详情页按需加载 ───────────────────────────────────── */
  var inflight = {};
  function load(kind, arg) {
    if (!BAC || !BAC.api || !BAC.HAS_INDEXER) return;
    var key = kind + ':' + arg;
    if (inflight[key]) return;
    inflight[key] = true;
    var done = function () { delete inflight[key]; repaint(); };

    if (kind === 'block') {
      BAC.api.block(arg).then(function (j) {
        var bl = BAC.api.shape.blockItem(j);
        VM.detail.block = mapBlock(bl, {
          proposer: j.proposer || null, gasFees: j.gasFees, parentHash: j.parentHash,
          stateRoot: j.stateRoot, extraData: j.extraData, size: j.size,
          official: j.official, anchored: j.anchored,
          txs: (j.txs || []).map(function (t) { return mapTx(BAC.api.shape.txItem(t)); })
        });
      }).then(done, done);
    } else if (kind === 'tx') {
      BAC.api.tx(arg).then(function (j) {
        var t = mapTx(BAC.api.shape.txItem(j.tx || j));
        if (j.tx && j.tx.feeToProposer !== undefined) t.fee = b(j.tx.feeToProposer);
        t.logs = (j.decoded || []).map(function (d) {
          return { name: d.event, addr: d.address || '', args: Object.keys(d.args || {}).map(function (k2) { return [k2, d.args[k2]]; }) };
        });
        VM.detail.tx = t;
      }).then(done, done);
    } else if (kind === 'agent') {
      BAC.api.agent(arg).then(function (j) {
        var a = mapAgent(BAC.api.shape.agentItem(j.agent || j));
        VM.detail.agent = a;
      }).then(done, done);
    } else if (kind === 'epoch') {
      BAC.api.epoch(arg).then(function (j) {
        VM.detail.epoch = mapEpoch(BAC.api.shape.epochItem(j.epoch || j));
      }).then(done, done);
    } else if (kind === 'contract') {
      BAC.api.contracts({ address: arg }).then(function (j) {
        var it = (j.items || [])[0];
        if (it) {
          VM.detail.contract = {
            address: it.address, deployer: it.deployer, agentId: n(it.agentId), block: n(it.block),
            codeSize: n(it.codeSize), calls: n(it.callCount), lastCallTs: n(it.lastCall)
          };
        }
      }).then(done, done);
    } else { delete inflight[key]; }
  }

  /* ── 启动 ─────────────────────────────────────────────── */
  function startLive() {
    ['state', 'feed', 'blocks', 'health', 'agents', 'validators', 'epochs', 'summary'].forEach(function (ev) {
      BAC.on(ev, pull);
    });
    document.addEventListener('visibilitychange', function () { BAC.setHidden(document.hidden); });
    pull();
  }

  function startDemo() {
    var d = root.BAC_DEMO.build();
    Object.keys(d).forEach(function (k) { VM[k] = d[k]; });
    repaint();
    setInterval(function () {
      root.BAC_DEMO.tick(VM);
      repaint();
    }, 3000);
  }

  UI.shell.boot();

  if (!BAC || !BAC.view) {
    if (root.console) root.console.error('[BACBIND] 数据层没有加载：页面保持发射前状态');
  } else if (!BAC.LIVE && DEMO_WANTED && root.BAC_DEMO && root.BAC_DEMO.build) {
    startDemo();
  } else {
    startLive();
  }

  root.BACBIND = {
    pull: pull, load: load, repaint: repaint,
    /* 演示模式下没有索引器可问：详情页直接说找不到，不要一直显示「读取中…」 */
    canLoad: !!(BAC && BAC.api && BAC.HAS_INDEXER) && !(!BAC.LIVE && DEMO_WANTED && root.BAC_DEMO)
  };
})(typeof window !== 'undefined' ? window : globalThis);
