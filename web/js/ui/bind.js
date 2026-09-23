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
    FEE_SPLITTER: 'gas 分账合约', FEE_SINK: '黑洞地址 · 打进去的 BAC 永久销毁',
    MULTICALL3: 'Multicall3 · 中立工具', CREATE2: 'CREATE2 部署器 · 中立工具'
  };
  /* 0x…dEaD 不是系统合约，它就是个没人有私钥的地址。这张表里为 false 的条目
     在页面上不许写成「层内系统合约」（表格里那一行原来就是这么写的，是错的）。 */
  var SYS_IS_CONTRACT = { FEE_SINK: false };
  var SYS = {}, SYS_KIND = {};
  Object.keys(LAYER).forEach(function (k) {
    var a = String(LAYER[k]).toLowerCase();
    SYS[a] = SYS_ZH[k] || k;
    SYS_KIND[a] = SYS_IS_CONTRACT[k] === false ? 'sink' : 'system';
  });

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
      if (bare && !isBridge) return { type: 'transfer', method: '转账', kindLabel: SYS_KIND[to], label: SYS[to] };
      return { type: isBridge ? 'bridge' : 'call', method: SYS[to], kindLabel: SYS_KIND[to], label: SYS[to] };
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
      /* 这个地址在创世常量表里的准确名字（黑洞地址 / Multicall3 / 桥…）。
         表格里的「目标」列显示它，不许一律写成「层内系统合约」。 */
      toLabel: k.label || null,
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

  /** 纪元号一律按合约的定义从块时间算：floor(ts / EPOCH)，EPOCH = 600（决策 #20，数据层 BAC.C.EPOCH）。
      索引器 /api/blocks 给的 epoch 目前还是按天编号（floor(ts / 86400)），直接用它会和页头的当前纪元对不上。
      块时间读不到才退回数据源给的那个。 */
  function epochOf(ts, given) {
    var len = BAC && BAC.C && BAC.C.EPOCH;
    if (ts !== null && ts !== undefined && len) return Math.floor(Number(ts) / len);
    return given === undefined ? null : given;
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
      epoch: epochOf(bl.ts, bl.epoch), size: extra.size || bl.size || null,
      stateRoot: extra.stateRoot || bl.stateRoot || null,
      extra: extra.extraData || bl.extraData || null,
      txs: txs,
      /* 层内块要等纪元锚点上 BSC 才算锚定；ChainAnchor 还没部署 → 一律未锚定 */
      anchored: extra.anchored === undefined ? !!bl.anchored : !!extra.anchored,
      source: bl.source || extra.source || null
    };
  }

  /* 决策 #29a 的那句，逐字 + 节点基金那一半。数据层 v2 的 treasury.disclosure 也是这一句开头（后半句带
     Flap 协议费的实测比例）；这里固定一份，让页面文案不随协议费读数跳动。 */
  var DISCLOSURE = '项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。'
    + '节点基金这一半（税后 BNB 的 50%）由 BacNodeFund 的 owner 随时提取，用于服务器与节点搭建。';

  /** 可选字段只读、不猜：数据层没给就是 null。 */
  function opt(v) { return v === undefined || v === null || v === '' ? null : String(v); }

  function mapAgent(a) {
    function nb(x) { return x === undefined ? null : x; }
    var credited = nb(a.credited), exited = nb(a.exited), bal = nb(a.layerBalance);
    var spent = (credited !== null && exited !== null && bal !== null) ? credited - exited - bal : null;
    var sr = a.selfReported || null;
    return {
      /* v2（决策 #31）没有状态机：名录里的每一条都是锁进过桥的 ERC-8004 身份编号，
         没有休眠、封禁、入场验证中（L2Gate 里那几个状态码已经没有来源）。统一显示「已进场」。 */
      id: a.agentId, status: 'ENTERED', statusZh: '已进场', statusCls: 'ok',
      wallet: opt(a.wallet), controller: opt(a.controller),
      /* 决策 #31：一个 agent = 一个锁进过 BacBridge 的 ERC-8004 身份编号（BacBridge.lock(agentId, …)）。 */
      identityId: a.identityId === undefined || a.identityId === null ? null : Number(a.identityId),
      /* ownerOf 回滚（编号没铸过 / 已销毁）→ identityExists === false；null = 这一轮没读到 */
      identityExists: a.identityExists === undefined ? null : a.identityExists,
      holder: opt(a.identityOwner) || opt(a.holder),
      /* ERC-8004 getMetadata(id, "agentWallet")：数据层只收 20 个裸字节，别的长度一律 null */
      agentWallet: opt(a.agentWallet),
      /* 持有人自述（tokenURI 里的 name / description）：不可信文本，页面一律转义并标「持有人自述」。
         图片 URL 数据层从不交出来（hasImage 只说有没有）。 */
      selfName: sr && sr.name ? String(sr.name) : null,
      selfDesc: sr && sr.description ? String(sr.description) : null,
      selfHasImage: sr && sr.hasImage !== undefined ? sr.hasImage : null,
      uriKind: opt(a.tokenURIKind),
      uriTruncated: !!a.tokenURITruncated,
      joinedTs: nb(a.firstLockAt) !== null ? a.firstLockAt : (a.activatedAt || a.registeredAt || null),
      lastLockTs: nb(a.lastLockAt),
      depositCount: a.deposits === undefined || a.deposits === null || typeof a.deposits === 'object' ? null : Number(a.deposits),
      lockedTotal: nb(a.lockedTotal),
      credited: credited, exited: exited, spent: spent, balance: bal,
      deploys: nb(a.deploys), announces: nb(a.announces), actions: null,
      hbEpoch: nb(a.lastHeartbeatEpoch), missed: nb(a.missed),
      /* ERC-8004 的注册文件是 tokenURI；数据层还按旧名 agentURI 给的时候照旧读它。都是持有人自述。 */
      uri: opt(a.tokenURI) || opt(a.agentURI), uriOk: null,
      source: a.source || null,
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

  /* ── agent 造出来的东西：代币 / 交易对 / 成交（决策 #19，03 §7）────────
     纪律（03 §7.0）：
       ① 全部是**启发式判定**，会漏也会错 → detection 块原样带给页面，页面必须显示；
       ② 代币金额是**该代币自己的最小单位**，带自己的 decimals，decimals 未知就是 null，
          **不许默认当 18**，也**不许**和 BAC / BNB 的金额放进同一个合计；
       ③ 名字 / 符号是部署者自己写的不可信文本，原样带过去，渲染时一律转义；
       ④ 这条链上没有法币、没有稳定币、没有预言机 → 价格只有「1 token0 折合多少 token1」，
          任何 $ 金额 / 市值 / 涨跌幅都不存在，也不许在页面上出现。 */
  function mapDetection(d) {
    if (!d) return null;
    return {
      method: d.method || null,
      note: d.note || null,
      rulesUrl: d.rulesUrl || null,
      unclassified: d.unclassifiedContracts === undefined || d.unclassifiedContracts === null
        ? null : n(d.unclassifiedContracts)
    };
  }
  function dec(v) { return v === undefined || v === null ? null : Number(v); }
  function tokenRef(t) {
    if (!t) return null;
    return {
      address: t.address || null, symbol: t.symbol || null, name: t.name || null,
      decimals: dec(t.decimals), known: t.known === undefined ? null : !!t.known
    };
  }
  function mapToken(t) {
    if (!t) return null;
    var c = t.creator || {};
    return {
      address: t.address || null, name: t.name || null, symbol: t.symbol || null,
      decimals: dec(t.decimals),
      /* nameTrusted 恒为 false：它存在的唯一目的是让前端没法忘记这件事 */
      nameTrusted: false,
      totalSupply: b(t.totalSupply), supplyBlock: n(t.supplyBlock),
      agentId: c.agentId === undefined || c.agentId === null ? null : Number(c.agentId),
      wallet: c.wallet || null,
      deployTx: t.deployTx || null, deployBlock: n(t.deployBlock), deployTs: n(t.deployTs),
      holders: n(t.holders), transfers: n(t.transfers), mints: n(t.mints), burns: n(t.burns),
      pairCount: n(t.pairCount), swapCount: n(t.swapCount),
      firstTs: n(t.firstTs), lastTs: n(t.lastTs),
      detectLevel: t.detectLevel || null,
      balanceDrift: !!t.balanceDrift, zeroOnly: !!t.zeroOnly,
      sameNameCount: n(t.sameNameCount)
    };
  }
  function mapPair(p2) {
    if (!p2) return null;
    var c = p2.creator || {}, f = p2.factory || {};
    return {
      address: p2.address || null, kind: p2.kind || null,
      discoveredVia: p2.discoveredVia || null,
      factory: f.address || null, factoryAgentId: f.creatorAgentId === undefined ? null : n(f.creatorAgentId),
      token0: tokenRef(p2.token0), token1: tokenRef(p2.token1),
      agentId: c.agentId === undefined || c.agentId === null ? null : Number(c.agentId),
      wallet: c.wallet || null,
      deployTx: p2.deployTx || null, deployBlock: n(p2.deployBlock), deployTs: n(p2.deployTs),
      reserve0: b(p2.reserve0), reserve1: b(p2.reserve1),
      reserveSource: p2.reserveSource || null, reserveBlock: n(p2.reserveBlock),
      feePpm: p2.feePpm === undefined ? null : n(p2.feePpm),
      tickSpacing: p2.tickSpacing === undefined ? null : n(p2.tickSpacing),
      swapCount: n(p2.swapCount), vol0: b(p2.vol0), vol1: b(p2.vol1),
      volSkipped: n(p2.volSkipped), mintCount: n(p2.mintCount), burnCount: n(p2.burnCount),
      /* price_1_per_0 的 ×10^-18 定点十进制字符串。**它是兑换比，不是行情价。** */
      lastPrice: b(p2.lastPrice), lastPriceBlock: n(p2.lastPriceBlock),
      firstTs: n(p2.firstTs), lastTs: n(p2.lastTs),
      detectLevel: p2.detectLevel || null
    };
  }
  function mapSwap(x) {
    if (!x) return null;
    var pr = x.pair || {};
    return {
      cursor: x.cursor || null, block: n(x.block), ts: n(x.ts), epoch: n(x.epoch),
      tx: x.tx || null, logIndex: n(x.logIndex),
      pair: { address: pr.address || null, kind: pr.kind || null,
        token0: tokenRef(pr.token0), token1: tokenRef(pr.token1) },
      agentId: x.agentId === undefined || x.agentId === null ? null : Number(x.agentId),
      txFrom: x.txFrom || null, sender: x.sender || null, recipient: x.recipient || null,
      tokenIn: x.tokenIn || null, amountIn: b(x.amountIn),
      tokenOut: x.tokenOut || null, amountOut: b(x.amountOut),
      /* side 固定相对 token0：sell0 = token0 进池子，buy0 = token0 出池子。
         页面显示「买 / 卖」时必须把基准代币写在表头上。 */
      side: x.side || null, price1Per0: b(x.price1Per0),
      normalized: x.normalized === undefined ? null : !!x.normalized
    };
  }
  function mapTransfer(x) {
    if (!x) return null;
    return {
      cursor: x.cursor || null, block: n(x.block), ts: n(x.ts), tx: x.tx || null,
      logIndex: n(x.logIndex), from: x.from || null, to: x.to || null,
      fromAgentId: x.fromAgentId === undefined || x.fromAgentId === null ? null : Number(x.fromAgentId),
      toAgentId: x.toAgentId === undefined || x.toAgentId === null ? null : Number(x.toAgentId),
      value: b(x.value), kind: x.kind || null
    };
  }
  function mapHolder(x) {
    if (!x) return null;
    return {
      rank: n(x.rank), address: x.address || null,
      agentId: x.agentId === undefined || x.agentId === null ? null : Number(x.agentId),
      balance: b(x.balance),
      shareBps: x.shareBps === undefined || x.shareBps === null ? null : Number(x.shareBps),
      isContract: x.isContract === undefined ? null : !!x.isContract,
      /* role === 'pair' 的持有人必须标成「交易对合约（池子里的钱）」，
         否则「第一大户占 62%」这句话是误导（03 §7.6）。 */
      role: x.role || null
    };
  }
  function mapHolding(x) {
    if (!x) return null;
    return {
      token: x.token || null, symbol: x.symbol || null, decimals: dec(x.decimals),
      balance: b(x.balance),
      shareBps: x.shareBps === undefined || x.shareBps === null ? null : Number(x.shareBps),
      balanceDrift: !!x.balanceDrift
    };
  }

  /* ── 块高只进不退 ─────────────────────────────────────────
     数据层会在「直读节点」和「索引器」两个来源之间切换，索引器通常落后几块。
     切过去的那一下，块高会从 21,902 掉回 21,898 —— 页面上的块高倒着走是错的。
     这里记住本次会话见过的最高块（连同它的时间 / 哈希 / 出块者），新读数更低、
     且那个最高块是 HEAD_FRESH_MS 之内见到的，就继续显示它。超过这个时间还没被追上
     （比如演练链整条重建），就相信新读数，不把一个过期的高度一直钉在页面上。
     只改显示，不编数：显示的永远是某一刻真实读到的一个块。 */
  var HEAD_FRESH_MS = 90 * 1000;
  var headHi = null;   // {head, headTs, headHash, miner, chainId, seenAt}
  function monotonicHead(cs) {
    var h = cs.head;
    var out = { head: h, headTs: cs.headTs, headHash: cs.headHash, miner: cs.miner, blockLagSec: cs.blockLagSec };
    if (typeof h !== 'number' || !isFinite(h)) return out;
    var nowMs = Date.now();
    var same = headHi && headHi.chainId === cs.chainId;
    if (same && h < headHi.head && nowMs - headHi.seenAt < HEAD_FRESH_MS) {
      out.head = headHi.head; out.headTs = headHi.headTs; out.headHash = headHi.headHash; out.miner = headHi.miner;
      out.blockLagSec = typeof headHi.headTs === 'number' ? Math.max(0, Math.floor(nowMs / 1000) - headHi.headTs) : null;
      return out;
    }
    /* 更高的块（或换了链、或旧的最高块已过期）：记下它，从现在起算新鲜期。同一块再读到一次不重置。 */
    if (!same || h !== headHi.head) {
      headHi = { head: h, headTs: cs.headTs, headHash: cs.headHash, miner: cs.miner, chainId: cs.chainId, seenAt: nowMs };
    }
    return out;
  }

  /* ── 从 window.BAC 拉一份完整的视图模型 ───────────────────── */
  function pull() {
    if (!BAC || !BAC.view) return;
    var v = BAC.view;
    var cs = v.chainStats(), ag = v.agents({}), tr = v.treasury(), br = v.bridge(),
      va = v.validators(), ep = v.epoch(), fd = v.feed(), bk = v.blocks(), tx = v.txs(), ov = v.overview();
    /* v2 的三个新视图（数据层没有它们时按「发射后公布」处理，不猜） */
    var sg = v.stage ? v.stage() : null, tk = v.token ? v.token() : null, op = v.ownerPowers ? v.ownerPowers() : null;
    /* 质押合约没部署（site.config.js 里 staking 地址没配）时，索引器 /api/validators 仍会给出默认的 totalStaked = "0"：
       那不是「总质押 0 BAC」，是这份账还不存在。这时总质押 / 节点数一律置 null，页面按状态写「发射后公布」，绝不写 0。 */
    var stA = ov.addresses ? ov.addresses.staking : null;
    var stakingLive = typeof stA === 'string' && /^0x[0-9a-fA-F]{40}$/.test(stA) && /[1-9a-f]/i.test(stA.slice(2));
    var stakedTotal = stakingLive ? va.totalStaked : null;
    var stakeNodes = stakingLive ? va.nodeCount : null;

    /* 层内链在出块 = 这个站是活的，哪怕 BSC 侧一个合约都还没部署。两个开关完全独立。 */
    VM.mode = (BAC.LIVE || BAC.LAYER_LIVE) ? 'live' : 'pre';
    /* 演练链：配置里显式写了 rehearsal 就照它。没写时退回「代币还没发射」——
       BSC 合约会先于代币部署，那时层内仍然是演练链（HANDOFF §2），不能拿「合约配没配」去猜。 */
    var cfgRehearsal = BAC.CFG && typeof BAC.CFG.rehearsal === 'boolean' ? BAC.CFG.rehearsal : null;
    VM.rehearsal = cfgRehearsal === null ? !BAC.TOKEN_LIVE : cfgRehearsal;
    VM.st.chain = cs.status;
    VM.st.blocks = bk.status;
    VM.st.txs = tx.status;
    VM.st.agents = ag.status;
    VM.st.epochs = ep.historyStatus || ep.status;
    VM.st.validators = va.status;
    /* 合约那一半（contractStatus）：阶段 a 'pre'，阶段 b 起是真数（包括真的 0） */
    VM.st.treasury = tr.status;
    VM.st.bridge = br.status;
    /* 代币那一半（tokenStatus）：阶段 a、b 都是 'pre'（价格 / 税率 / 待分发税这些数真的还不存在） */
    VM.st.token = tk ? tk.status : (tr.tokenStatus || 'pre');
    /* 时间线：税收流向 + 节点基金（treasury().timelineStatus）/ 项目方权限记录（ownerPowers().timelineStatus） */
    VM.st.timeline = tr.timelineStatus || tr.status;
    VM.st.owner = op ? (op.status !== 'ok' ? op.status : (op.timelineStatus || op.status)) : br.status;
    VM.st.feed = fd.status;

    VM.stage = {
      stage: sg ? sg.stage : (ov.stage || 'none'),
      known: sg ? !!sg.known : !!ov.stageKnown,
      contractsLive: sg ? !!sg.contractsLive : !!ov.contractsLive,
      tokenLive: sg ? !!sg.tokenLive : !!ov.tokenLive,
      tokenAddress: sg ? sg.tokenAddress : (ov.tokenAddress || null)
    };
    /* 只有索引器算得出的那几段：它读不到时写 'noidx'（显示「—」+ 面板小标写明原因），
       **不写「发射后公布」** —— 链现在就在跑，那样说是骗人的。 */
    var idxOut = !!(BAC.state.indexer.degraded || BAC.state.indexer.error) || !BAC.HAS_INDEXER;
    VM.st.idx = idxOut ? 'noidx' : (BAC.state.indexer.ready ? 'ok' : 'loading');
    VM.st.contracts = VM.st.idx;          // 合约名录只有索引器有
    /* 代币 / 交易对 / 成交：要把全链日志解一遍才有，只有索引器给得出 */
    VM.st.built = VM.st.idx;
    VM.st.daily = VM.st.idx;              // 没有日聚合端点：不画，也不编

    VM.layer = {
      live: !!ov.layerLive,
      source: cs.source,
      endpoint: cs.endpoint,
      /* 配置里的公开 RPC（site.config.js 的 layerRpc）：横幅上让人去核对的是它，
         不是 endpoint —— 数据源切到索引器之后 endpoint 是索引器的根地址，不是 RPC */
      rpc: (BAC.CFG && BAC.CFG.layerRpc) || null,
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
    VM.agentsMeta = {
      total: ag.total === undefined ? null : ag.total,
      totalAtLeast: ag.totalAtLeast === undefined ? null : ag.totalAtLeast,
      truncated: !!ag.truncated, itemsTruncated: !!ag.itemsTruncated,
      identityPaused: !!ag.identityPaused, source: ag.source || null
    };

    VM.epochs = (ep.history || []).map(mapEpoch);
    VM.epochByN = {};
    VM.epochs.forEach(function (x) { VM.epochByN[x.n] = x; });

    VM.feed = fd.items.map(function (it) {
      return { id: it.id, chain: it.chain === 'bsc' ? 'BSC' : 'LAYER', kind: it.kind, ts: it.ts,
        textZh: it.textZh, anchored: it.anchored, tx: it.tx, agentId: it.agentId };
    });

    VM.validators = {
      items: (va.items || []).map(mapValidator),
      nodeCount: stakeNodes, slots: 64, totalStaked: stakedTotal,
      rewardBalance: va.rewardBalance, epochPot: va.epochPot,
      lifetimeFunded: va.lifetimeFunded, lifetimePaid: va.lifetimePaid,
      minStake: va.minStake,
      agreeingCount: ep.vetoCountInWindow === null ? null : null,
      memberCount: stakeNodes, releaseBps: ep.releaseBps
    };

    /* 浏览器读得到的日志窗口有多长（公共节点只给最近约 5000–6000 块）：时间线不全时照实写「约 N 分钟」 */
    var winBlocks = (BAC.CFG && BAC.CFG.logWindowBlocks) || null;
    var bscBlockSec = (BAC.C && BAC.C.BSC_BLOCK_TIME) || null;
    var windowMin = winBlocks && bscBlockSec ? Math.round(winBlocks * bscBlockSec / 60) : null;
    var addrs = ov.addresses || {};
    function evUrl(a) {
      return BAC.isAddr && BAC.isAddr(a) && BAC.links && BAC.links.addressEvents ? BAC.links.addressEvents(a) : null;
    }
    function u(x) { return x === undefined ? null : x; }

    VM.treasury = {
      bridgeBps: tr.bridgeBps, nodeFundBps: tr.nodeFundBps, taxFeeRateBps: u(tr.taxFeeRateBps),
      lifetimeTotal: u(tr.lifetimeTotal), toBridge: u(tr.lifetimeToBridge), toNodeFund: u(tr.lifetimeToNodeFund),
      /* BacTaxRouter 自己的数（v1 的 vault* 旧键名保留同值，给还没换名的插槽） */
      routerBalance: u(tr.routerBalance), routerUnsplit: u(tr.routerUnsplit), routerAccounted: u(tr.routerAccounted),
      vaultBalance: u(tr.routerBalance), vaultUnsplit: u(tr.routerUnsplit),
      stuckBridge: u(tr.stuckBridge), stuckNodeFund: u(tr.stuckNodeFund),
      poolBalance: u(tr.poolBalance), bridgeBnbHeld: u(tr.bridgeBnbHeld),
      nodeFundBalance: u(tr.nodeFundBalance), nodeFundReceived: u(tr.nodeFundReceived),
      nodeFundWithdrawn: u(tr.nodeFundWithdrawn), nodeFundOwner: u(tr.nodeFundOwner),
      releaseBps: br.lastPotBps === undefined ? null : br.lastPotBps,
      releasable: u(br.lastPot), owedTotal: u(br.owedTotal),
      // 代币那一半：st.token（代币没发射时是「发射后公布」）
      pendingTax: tk ? u(tk.pendingTax) : u(tr.pendingTax),
      lifetimeTaxToRouter: tk ? u(tk.lifetimeTaxToRouter) : u(tr.lifetimeTaxToRouter),
      disclosure: DISCLOSURE, splitBaseNote: u(tr.splitBaseNote),
      // 时间线（最近窗口的 BSC 日志 + 节点基金那条的索引器历史），条目原样
      flow: (tr.flow || []).slice(),
      nodeFundEvents: (tr.nodeFundEvents || []).slice(),
      timelineComplete: !!tr.timelineComplete,
      timelineTruncated: tr.timelineTruncated || null,
      windowMin: windowMin,
      routerEventsUrl: evUrl(addrs.router),
      nodeFundEventsUrl: evUrl(addrs.nodeFund),
      /* 旧的合并事件表已拆成上面两条时间线 + 项目方权限记录；留空只为兼容 */
      events: [], eventsStatus: VM.st.timeline
    };

    var sf = br.shortfall || {};
    VM.bridge = {
      address: u(br.address),
      totalLocked: u(br.totalLocked), totalIssued: u(br.totalIssued), totalExited: u(br.totalExited),
      creditsOutstanding: u(br.creditsOutstanding), poolBalance: u(br.poolBalance), owedTotal: u(br.owedTotal),
      // 含义已变：BAC / 积分（1e18 定点），不是 BNB（数据层 bacPerCredit；weiPerCredit 是旧名）
      weiPerCredit: u(br.bacPerCredit !== undefined ? br.bacPerCredit : br.weiPerCredit),
      bacPerCredit: u(br.bacPerCredit !== undefined ? br.bacPerCredit : br.weiPerCredit),
      lastPot: u(br.lastPot), releaseBps: u(br.lastPotBps),
      lockedBac: u(br.lockedBac), buybackBac: u(br.buybackBac),
      bnbBalance: u(br.bnbBalance), bnbHeld: u(br.bnbHeld),
      paused: u(br.paused), halted: u(br.halted),
      // 决策 #29：owner 权力 —— 谁、现在的实现、做过几次（计数器是合约里的全量）
      owner: u(br.owner), pendingOwner: u(br.pendingOwner), implementation: u(br.implementation),
      upgradeCount: u(br.upgradeCount), lastUpgradeAt: u(br.lastUpgradeAt),
      emergencyCount: u(br.emergencyCount), lastEmergencyAt: u(br.lastEmergencyAt),
      emergencyBnbWithdrawn: u(br.emergencyBnbWithdrawn), emergencyBacWithdrawn: u(br.emergencyBacWithdrawn),
      shortfallBnb: u(sf.bnb), shortfallBac: u(sf.bac), shortfallSource: u(sf.source),
      noticeMatches: u(br.noticeMatches)
    };

    /* 项目方权限记录（决策 #29c）。complete = 整条时间线从部署起都在；不全时页面必须写明并链到 BscScan 事件页。 */
    VM.owner = op ? {
      items: (op.items || []).slice(),
      complete: !!op.complete, completeVia: op.completeVia || null,
      missing: op.missing || { upgrades: null, emergencies: null },
      seen: op.seen || { upgrades: 0, emergencies: 0 },
      upgradesAndWithdrawalsComplete: !!op.upgradesAndWithdrawalsComplete,
      eventsUrl: op.eventsUrl || evUrl(addrs.bridge),
      coverage: op.coverage || null,
      unlogged: op.unlogged || null,
      implementationMatchesLog: op.implementationMatchesLog === undefined ? null : op.implementationMatchesLog,
      historyStatus: op.historyStatus || null,
      windowMin: windowMin
    } : VM.empty().owner;

    /* 代币：CA 已锁定（决策 #35），其余字段发射后才有 */
    var pt = tk && tk.portal ? tk.portal : null;
    VM.token = tk ? {
      address: tk.address || null, launched: !!tk.launched, explorerUrl: tk.explorerUrl || null,
      name: u(tk.name), symbol: u(tk.symbol),
      taxRate: u(tk.taxRate), buyTaxRate: u(tk.buyTaxRate), sellTaxRate: u(tk.sellTaxRate),
      taxFeeRateBps: u(tk.taxFeeRateBps), marketAddressOk: u(tk.marketAddressOk),
      portalStatusZh: pt ? u(pt.statusZh) : null, price: pt ? u(pt.price) : null, progress: pt ? u(pt.progress) : null,
      bridgeBac: u(tk.bridgeBac), pendingTax: u(tk.pendingTax), lifetimeTaxToRouter: u(tk.lifetimeTaxToRouter)
    } : VM.empty().token;

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
    var hd = monotonicHead(cs);

    VM.chain = {
      chainId: cs.chainId, source: cs.source, endpoint: cs.endpoint,
      degraded: cs.degraded, degradedNote: cs.degradedNote,
      head: hd.head, headTs: hd.headTs, headHash: hd.headHash, miner: hd.miner,
      blockLagSec: hd.blockLagSec,
      // 实测出块间隔优先用最后两块的时间差，索引器给了窗口平均值就用它的
      blockTimeSec: cs.blockTimeSec !== null && cs.blockTimeSec !== undefined ? cs.blockTimeSec : cs.blockIntervalSec,
      blockIntervalSec: cs.blockIntervalSec,
      targetBlockTimeSec: cs.targetBlockTimeSec,
      gasLimit: cs.gasLimit, baseFee: cs.baseFee,
      gasPrice: cs.gasPrice === undefined ? null : cs.gasPrice,
      minGasPriceGwei: 1,
      epochLenSec: (BAC.C && BAC.C.EPOCH) || 600,
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
      nodeCount: stakeNodes, nodeSlots: 64, totalStaked: stakedTotal,
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
     这里直接问数据层要，读不到就保持 null，**不猜**。BSC 合约（ChainAnchor 等）部署之后才问（CONTRACTS_LIVE）。 */
  var feesAt = 0;
  function pullFees() {
    if (!BAC || !BAC.api || !BAC.api.fees || !BAC.HAS_INDEXER || !(BAC.CONTRACTS_LIVE || BAC.LIVE)) return;
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
        var raw = j.agent || j;
        var a = mapAgent(BAC.api.shape.agentItem(raw));
        /* 整形函数（bac-api.js 的 agentItem）只认已删除的旧注册表的字段；ERC-8004 的几项（身份编号 / 持有人 / tokenURI）
           索引器给了就从原始应答里捡，没给就保持 null —— 不猜，不补。 */
        if (raw.identityId !== undefined && raw.identityId !== null) a.identityId = Number(raw.identityId);
        a.holder = opt(raw.identityOwner) || opt(raw.holder) || a.holder;
        a.uri = opt(raw.tokenURI) || a.uri;
        /* 03 §7.7：它发的币 / 它建的池 / 它的成交 / 它持有的代币。
           索引器没给这几块就是 null，页面写「这个 agent 还没…」，不编数。 */
        var bt = j.built || null, tr = j.trades || null;
        a.built = bt ? {
          tokens: (bt.tokens || []).map(mapToken),
          pairs: (bt.pairs || []).map(mapPair),
          factories: (bt.factories || []).slice()
        } : null;
        a.trades = tr ? {
          swapCount: n(tr.swapCount), firstTs: n(tr.firstTs), lastTs: n(tr.lastTs),
          pairs: (tr.pairs || []).map(function (x) { return { address: x.address, swaps: n(x.swaps) }; }),
          recent: (tr.recent || []).map(mapSwap)
        } : null;
        a.holdings = j.holdings ? j.holdings.map(mapHolding) : null;
        a.holdingsTruncated = !!j.holdingsTruncated;
        if (j.detection) VM.built.detection = mapDetection(j.detection);
        VM.detail.agent = a;
      }).then(done, done);
    } else if (kind === 'epoch') {
      BAC.api.epoch(arg).then(function (j) {
        VM.detail.epoch = mapEpoch(BAC.api.shape.epochItem(j.epoch || j));
      }).then(done, done);
    } else if (kind === 'contract') {
      /* 03 §7.6 的新端点能回答「这是个什么」（classified / classifiedZh）。
         它不在（索引器还是老版本）就退回 /api/contracts?address= —— 那时 classified 是 null，
         页面照实写「我们没能识别出这个合约是什么」，不猜。 */
      var takeContract = function (it, extra) {
        if (!it) return;
        extra = extra || {};
        VM.detail.contract = {
          address: it.address, deployer: it.deployer, agentId: n(it.agentId), block: n(it.block),
          codeSize: n(it.codeSize), calls: n(it.callCount), lastCallTs: n(it.lastCall),
          classified: extra.classified !== undefined ? extra.classified : (it.classified || null),
          classifiedZh: extra.classifiedZh !== undefined ? extra.classifiedZh : (it.classifiedZh || null),
          symbol: it.symbol || null,
          token: extra.token || null, pair: extra.pair || null,
          events: extra.events || []
        };
      };
      /* 两个端点都回了错误（例如索引器对普通地址回 500）：记下来，页面停在「找不到」并如实说原因，
         不在每次重画时再问一遍。成功读到就清掉。 */
      var cAddr = String(arg || '').toLowerCase();
      var contractFail = function (e) {
        VM.detail.contractErr = { addr: cAddr, status: (e && e.status) || null, at: Date.now() };
      };
      (BAC.api.contract ? BAC.api.contract(arg).then(function (j) {
        takeContract(j.contract || {}, {
          classified: j.classified || null,
          classifiedZh: j.classifiedZh || null,
          token: mapToken(j.token), pair: mapPair(j.pair),
          events: (j.events || []).map(function (e) {
            return { kind: e.kind || null, rule: e.rule || null, block: n(e.block), ts: n(e.ts) };
          })
        });
        if (j.detection) VM.built.detection = mapDetection(j.detection);
      }, function () {
        return BAC.api.contracts({ address: arg }).then(function (j) { takeContract((j.items || [])[0]); });
      }) : BAC.api.contracts({ address: arg }).then(function (j) { takeContract((j.items || [])[0]); })
      ).then(function () {
        if (VM.detail.contract && String(VM.detail.contract.address).toLowerCase() === cAddr) VM.detail.contractErr = null;
        else contractFail({ status: 404 });
      }, contractFail).then(done, done);

    /* ── agent 造出来的东西（决策 #19）：列表与详情 ─────────────────
       读不到就是读不到：VM.built 保持空，页面显示设计过的空状态，
       不显示转圈，也不编一行出来。 */
    } else if (kind === 'tokens') {
      BAC.api.tokens({ pageSize: 50, sort: 'newest' }).then(function (j) {
        VM.built.detection = mapDetection(j.detection) || VM.built.detection;
        VM.built.tokens = (j.items || []).map(mapToken);
        VM.built.tokensTotal = n(j.total);
        VM.built.tokensAt = Date.now(); VM.built.tokensErr = false;
      }, function () { VM.built.tokensAt = Date.now(); VM.built.tokensErr = true; }).then(done, done);
    } else if (kind === 'pairs') {
      BAC.api.pairs({ pageSize: 50, sort: 'newest' }).then(function (j) {
        VM.built.detection = mapDetection(j.detection) || VM.built.detection;
        VM.built.pairs = (j.items || []).map(mapPair);
        VM.built.pairsTotal = n(j.total);
        VM.built.pairsAt = Date.now(); VM.built.pairsErr = false;
      }, function () { VM.built.pairsAt = Date.now(); VM.built.pairsErr = true; }).then(done, done);
    } else if (kind === 'swaps') {
      BAC.api.swaps({ limit: 50 }).then(function (j) {
        VM.built.detection = mapDetection(j.detection) || VM.built.detection;
        VM.built.swaps = (j.items || []).map(mapSwap);
        VM.built.swapsNext = j.next || null;
        VM.built.swapsAt = Date.now(); VM.built.swapsErr = false;
      }, function () { VM.built.swapsAt = Date.now(); VM.built.swapsErr = true; }).then(done, done);
    } else if (kind === 'token') {
      BAC.api.token(arg).then(function (j) {
        var sc = j.supplyCheck || {};
        VM.built.detection = mapDetection(j.detection) || VM.built.detection;
        VM.built.tokenDetail = {
          address: (j.token && j.token.address) || arg,
          token: mapToken(j.token),
          supplyCheck: {
            onchain: b(sc.onchainTotalSupply), derived: b(sc.derivedHolderSum),
            drift: b(sc.drift), checkedAt: n(sc.driftCheckedAt), note: sc.note || null
          },
          topHolders: (j.topHolders || []).map(mapHolder),
          pairs: (j.pairs || []).map(function (x) {
            return { address: x.address || null, kind: x.kind || null, other: tokenRef(x.other),
              reserve0: b(x.reserve0), reserve1: b(x.reserve1), swapCount: n(x.swapCount) };
          }),
          recentTransfers: (j.recentTransfers || []).map(mapTransfer),
          events: (j.events || []).map(function (e) {
            return { kind: e.kind || null, rule: e.rule || null, block: n(e.block), ts: n(e.ts) };
          })
        };
        VM.built.tokenErr = null;
      }, function (e) {
        VM.built.tokenDetail = null;
        VM.built.tokenErr = { address: arg, code: (e && e.code) || 'error' };
      }).then(done, done);
    } else if (kind === 'pair') {
      BAC.api.pair(arg).then(function (j) {
        var pz = j.price || {};
        VM.built.detection = mapDetection(j.detection) || VM.built.detection;
        VM.built.pairDetail = {
          address: (j.pair && j.pair.address) || arg,
          pair: mapPair(j.pair),
          price: { price1Per0: b(pz.price1Per0), price0Per1: b(pz.price0Per1),
            source: pz.source || null, atBlock: n(pz.atBlock), note: pz.note || null },
          recentSwaps: (j.recentSwaps || []).map(mapSwap),
          liquidity: (j.liquidity || []).map(function (x) {
            return { tx: x.tx || null, block: n(x.block), ts: n(x.ts),
              agentId: x.agentId === undefined || x.agentId === null ? null : Number(x.agentId),
              kind: x.kind || null, amount0: b(x.amount0), amount1: b(x.amount1) };
          }),
          v3Note: j.v3Note || null
        };
        VM.built.pairErr = null;
      }, function (e) {
        VM.built.pairDetail = null;
        VM.built.pairErr = { address: arg, code: (e && e.code) || 'error' };
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

  /* 搜索框按名字 / 符号找代币（决策 #19）：唯一的网络入口在这里，可视层自己不发请求。
     只问 /api/tokens?q=（索引器做的是前缀字面匹配，不做模糊、不做排名）。
     0x 开头和纯数字不走这里 —— 那两种 searchAll 本地就能判。
     索引器不在或演示模式：status = 'noidx'，搜索框退回只匹配已经载入的那一页。 */
  var searchSeq = 0;
  function searchTokens(raw, done) {
    var q = String(raw || '').trim();
    done = typeof done === 'function' ? done : function () {};
    if (!q || q.length < 2 || /^0x/i.test(q) || /^#?\d+$/.test(q)) {
      VM.search = { q: q, items: [], status: 'idle' };
      return done();
    }
    if (DEMO_ON || !BAC || !BAC.api || !BAC.api.tokens || !BAC.HAS_INDEXER) {
      VM.search = { q: q, items: [], status: 'noidx' };
      return done();
    }
    if (VM.search.q === q && (VM.search.status === 'ok' || VM.search.status === 'loading')) return done();
    var seq = ++searchSeq;
    VM.search = { q: q, items: [], status: 'loading' };
    BAC.api.tokens({ q: q, pageSize: 8, sort: 'activity' }).then(function (j) {
      if (seq !== searchSeq) return;
      VM.search = { q: q, items: (j.items || []).map(mapToken), status: 'ok' };
    }, function () {
      if (seq !== searchSeq) return;
      VM.search = { q: q, items: [], status: 'error' };
    }).then(done, done);
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
    pull: pull, load: load, repaint: repaint, searchTokens: searchTokens,
    /* 详情页能不能按需再读一条。
       演示模式下没有任何真来源可问 → 直接说找不到，不要一直显示「读取中…」。
       索引器读不到但层内 RPC 答话时**照样能读**：区块和交易直接问层内节点。 */
    canLoad: !DEMO_ON && !!(BAC && ((BAC.api && BAC.HAS_INDEXER) || (BAC.layer && BAC.HAS_LAYER_RPC))),
    /* 区块 / 交易详情能不能读（不看索引器） */
    canLoadLayer: !DEMO_ON && !!(BAC && BAC.layer && BAC.HAS_LAYER_RPC),
    /* agent / 纪元 / 合约详情只有索引器给得出 */
    canLoadIndexed: !DEMO_ON && !!(BAC && BAC.api && BAC.HAS_INDEXER)
  };
})(typeof window !== 'undefined' ? window : globalThis);
