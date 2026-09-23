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
  /* 层内创世系统合约：地址 → 给人看的名字（不是给机器看的常量名）。
     创世常量表里没有的地址一律按普通合约处理，不猜。 */
  var SYS_ZH = {
    L2_BRIDGE: '桥 · L2Bridge', L2_GATE: '入场 · L2Gate', AGENT_BOOK: 'AgentBook',
    FEE_SPLITTER: 'gas 分账合约', FEE_SINK: '黑洞地址 0x…dEaD',
    MULTICALL3: 'Multicall3', CREATE2: 'CREATE2 工厂'
  };
  var SYS = {};
  Object.keys(LAYER).forEach(function (k) { SYS[String(LAYER[k]).toLowerCase()] = SYS_ZH[k] || k; });

  var scheduled = false;
  function repaint() {
    if (scheduled) return;
    scheduled = true;
    (root.requestAnimationFrame || root.setTimeout)(function () { scheduled = false; UI.refresh(); }, 16);
  }

  /* ── 交易的种类与方法名（索引器不返回 input，只能按收据归类）───── */
  function txKind(t) {
    if (t.created || t.isCreate) return { type: 'deploy', method: '合约部署', kindLabel: 'created' };
    var to = String(t.to || '').toLowerCase();
    if (SYS[to]) {
      // 只有桥与入场那两个才归到「桥」这一类；其余系统地址是合约调用，别混进桥的筛选里
      var isBridge = to === String(LAYER.L2_BRIDGE || '').toLowerCase()
        || to === String(LAYER.L2_GATE || '').toLowerCase();
      // 没有 calldata 的就是往系统地址转账，方法栏写「转账」，别把地址名当方法名
      var bare = t.input !== null && t.input !== undefined && String(t.input).length <= 2;
      if (bare && !isBridge) return { type: 'transfer', method: '转账', kindLabel: 'system' };
      return { type: isBridge ? 'bridge' : 'call', method: SYS[to], kindLabel: 'system' };
    }
    // 有 calldata 就是合约调用；没有 calldata 才是纯转账（RPC 直读能分清，索引器不给 input 时退回按金额判）
    var hasInput = typeof t.input === 'string' && t.input.length > 2;
    if (hasInput) return { type: 'call', method: '合约调用', kindLabel: 'contract' };
    if (t.input === null || t.input === undefined) {
      if (t.value && t.value !== 0n) return { type: 'transfer', method: '转账', kindLabel: 'agent' };
      return { type: 'call', method: '合约调用', kindLabel: 'contract' };
    }
    return { type: 'transfer', method: '转账', kindLabel: 'agent' };
  }

  /** 两种来源同一个形状：索引器的 txItem 和 bac-layer 直读的 txRow 都走这里。
      读不到的字段一律 null，**不许拿 gas 上限冒充 gasUsed，也不许拿 1 gwei 估手续费**。 */
  function mapTx(t) {
    var k = txKind(t);
    return {
      hash: t.hash, block: t.block, idx: t.idx, ts: t.ts,
      agentId: t.agentId, fromAddr: t.from, to: t.to, created: t.created,
      toAgentId: null, toContractAgentId: null, toLabelKind: k.kindLabel,
      method: k.method, type: k.type,
      value: t.value, gasUsed: t.gasUsed,
      /* zeroBaseFee 下 feeBurned 恒为 0；真正的手续费是 feeToProposer（03 §3.7）。
         直读 RPC 时它 = gasUsed × effectiveGasPrice（有收据才有），没有收据就是 null。 */
      fee: t.feeToProposer !== undefined && t.feeToProposer !== null ? b(t.feeToProposer)
        : (t.fee !== undefined ? b(t.fee) : null),
      gasPrice: t.gasPrice !== undefined ? b(t.gasPrice) : null,
      effGasPrice: t.effGasPrice !== undefined ? b(t.effGasPrice) : null,
      ok: t.status === null || t.status === undefined ? null : t.status === 1,
      input: t.input === undefined ? null : t.input,
      logs: [],
      logsCount: t.logsCount === undefined ? null : t.logsCount,
      nonce: t.nonce === undefined ? null : t.nonce,
      source: t.source || null
    };
  }

  /** 区块同理：bac-layer 的 blockRow 自带 miner / feeTotal / parentHash / txs，直接用；
      索引器的 blockItem 字段少，缺的就是 null。extra 是详情页额外读到的东西。 */
  function mapBlock(bl, extra) {
    extra = extra || {};
    var prop = extra.proposer || bl.proposer || bl.miner || null;
    var official = extra.official !== undefined ? extra.official
      : (bl.official === undefined ? null : bl.official);
    var fee = extra.gasFees !== undefined ? b(extra.gasFees)
      : (bl.feeTotal !== undefined ? b(bl.feeTotal) : null);
    var txs = extra.txs !== undefined ? extra.txs
      : (bl.txs && bl.txs.length ? bl.txs.map(mapTx) : null);
    return {
      number: bl.number, hash: bl.hash,
      parent: extra.parentHash || bl.parentHash || null,
      ts: bl.ts,
      txCount: bl.txCount, gasUsed: bl.gasUsed, gasLimit: bl.gasLimit,
      baseFee: bl.baseFee === undefined ? null : bl.baseFee,
      fee: fee,
      proposer: prop,
      /* 阶段 1 只有官方节点出块；official === false 才是验证者出的块。
         RPC 分不出官方还是验证者（official 为 null）→ 按阶段 1 的事实算官方节点。 */
      proposerKind: prop ? (official === false ? 'validator' : 'official') : null,
      epoch: bl.epoch, size: extra.size || bl.size || null,
      stateRoot: extra.stateRoot || bl.stateRoot || null,
      extra: extra.extraData || bl.extraData || null,
      txs: txs,
      /* 层内块要等纪元锚点上 BSC 才算锚定；ChainAnchor 还没部署 → 一律未锚定 */
      anchored: extra.anchored === undefined ? !!bl.anchored : !!extra.anchored,
      source: bl.source || extra.source || null
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

    /* 层内链在出块 = 这个站是活的，哪怕 BSC 侧一个合约都还没部署。两个开关完全独立。 */
    VM.mode = (BAC.LIVE || BAC.LAYER_LIVE) ? 'live' : 'pre';
    VM.st.chain = cs.status;
    VM.st.blocks = bk.status;
    VM.st.txs = tx.status;
    VM.st.agents = ag.status;
    VM.st.epochs = ep.historyStatus || ep.status;
    VM.st.validators = va.status;
    VM.st.treasury = tr.status;
    VM.st.bridge = br.status;
    VM.st.feed = fd.status;
    /* 只有索引器算得出的那几段：它没上线时写 'noidx'（显示「—」+ 面板小标写明原因），
       **不写「发射后公布」** —— 链现在就在跑，那样说是骗人的。 */
    var idxOut = !!(BAC.state.indexer.degraded || BAC.state.indexer.error) || !BAC.HAS_INDEXER;
    VM.st.idx = idxOut ? 'noidx' : (BAC.state.indexer.ready ? 'ok' : 'loading');
    VM.st.contracts = VM.st.idx;          // 合约名录只有索引器有
    VM.st.daily = VM.st.idx;              // 没有日聚合端点：不画，也不编

    VM.layer = {
      live: !!ov.layerLive,
      source: cs.source,
      endpoint: cs.endpoint,
      primary: (BAC.layer && BAC.layer.isPrimary) ? BAC.layer.isPrimary() : null,
      note: cs.degradedNote || null,
      stale: !!(bk.stale || tx.stale),
      sections: cs.sections || null
    };

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

    /* TPS：拿**真实的时间跨度**除，不假设 3 秒一块。
       至少要两块、跨度要 > 0，否则就是 null（不知道），不编。 */
    var tps = null;
    if (VM.blocks.length >= 2) {
      var first = VM.blocks[0], last = VM.blocks[VM.blocks.length - 1];
      var span = (first.ts !== null && last.ts !== null) ? first.ts - last.ts : null;
      if (span !== null && span > 0) {
        var sum = 0, known = true;
        VM.blocks.forEach(function (x) {
          if (x.txCount === null || x.txCount === undefined) known = false; else sum += x.txCount;
        });
        if (known) tps = sum / span;
      }
    }
    var pool = cs.txpool || null;

    VM.chain = {
      chainId: cs.chainId, source: cs.source, endpoint: cs.endpoint,
      degraded: cs.degraded, degradedNote: cs.degradedNote,
      head: cs.head, headTs: cs.headTs, headHash: cs.headHash, miner: cs.miner,
      blockLagSec: cs.blockLagSec,
      // 实测出块间隔优先用最后两块的时间差，索引器给了窗口平均值就用它的
      blockTimeSec: cs.blockTimeSec !== null && cs.blockTimeSec !== undefined ? cs.blockTimeSec : cs.blockIntervalSec,
      blockIntervalSec: cs.blockIntervalSec,
      targetBlockTimeSec: cs.targetBlockTimeSec,
      gasLimit: cs.gasLimit, baseFee: cs.baseFee,
      gasPrice: cs.gasPrice === undefined ? null : cs.gasPrice,
      minGasPriceGwei: 1,
      epochLenSec: (BAC.C && BAC.C.EPOCH) || 86400,
      peers: cs.peers,
      // Besu 默认不开 TXPOOL API（实测 -32601）：读不到就是 null，不显示 0
      txPool: pool ? pool.pending : null,
      txPoolQueued: pool ? pool.queued : null,
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
  /** 索引器在正常供数吗？它有历史与搜索，能用就优先用它。 */
  function idxServing() {
    if (!BAC || !BAC.api || !BAC.HAS_INDEXER) return false;
    var I = BAC.state.indexer;
    return !!(I.ready && !I.degraded && !I.error);
  }
  /** 索引器不在时，区块和交易的详情**直接向层内节点要** —— 它们是真实存在的链上数据。 */
  function hasLayer() { return !!(BAC && BAC.layer && BAC.HAS_LAYER_RPC); }

  function load(kind, arg) {
    var key = kind + ':' + arg;
    if (inflight[key]) return;

    /* ── 区块 / 交易：索引器不在就走层内 RPC ───────────────── */
    if ((kind === 'block' || kind === 'tx') && !idxServing() && hasLayer()) {
      inflight[key] = true;
      var fin = function () { delete inflight[key]; repaint(); };
      if (kind === 'block') {
        BAC.layer.block(arg).then(function (row) {
          VM.detail.block = mapBlock(row);
          VM.detail.blockErr = null;
        }, function (e) {
          VM.detail.block = null;
          VM.detail.blockErr = { num: arg, code: (e && e.code) || 'error' };
        }).then(fin, fin);
      } else {
        BAC.layer.tx(arg).then(function (row) {
          VM.detail.tx = mapTx(row);
          VM.detail.txErr = null;
        }, function (e) {
          VM.detail.tx = null;
          VM.detail.txErr = { hash: arg, code: (e && e.code) || 'error' };
        }).then(fin, fin);
      }
      return;
    }

    if (!BAC || !BAC.api || !BAC.HAS_INDEXER) return;
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

  /* 演示模式的两个条件必须同时成立：BSC 侧没发射（BAC.LIVE === false）且 URL 带 ?demo=1。
     正式站点**永远不会**走到这里 —— 真实读数读不到时显示占位文字，绝不退回演示值。 */
  var DEMO_ON = !!(BAC && !BAC.LIVE && DEMO_WANTED && root.BAC_DEMO && root.BAC_DEMO.build);

  UI.shell.boot();

  if (!BAC || !BAC.view) {
    if (root.console) root.console.error('[BACBIND] 数据层没有加载：页面保持发射前状态');
  } else if (DEMO_ON) {
    VM.mode = 'demo';
    startDemo();
  } else {
    startLive();
  }

  root.BACBIND = {
    pull: pull, load: load, repaint: repaint,
    /* 详情页能不能按需再读一条。
       演示模式下没有任何真来源可问 → 直接说找不到，不要一直显示「读取中…」。
       索引器没上线但层内 RPC 答话时**照样能读**：区块和交易直接问层内节点。 */
    canLoad: !DEMO_ON && !!(BAC && ((BAC.api && BAC.HAS_INDEXER) || (BAC.layer && BAC.HAS_LAYER_RPC))),
    /* 区块 / 交易详情能不能读（不看索引器） */
    canLoadLayer: !DEMO_ON && !!(BAC && BAC.layer && BAC.HAS_LAYER_RPC),
    /* agent / 纪元 / 合约详情只有索引器给得出 */
    canLoadIndexed: !DEMO_ON && !!(BAC && BAC.api && BAC.HAS_INDEXER)
  };
})(typeof window !== 'undefined' ? window : globalThis);
