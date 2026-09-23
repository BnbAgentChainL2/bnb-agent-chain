/* BNB Agent Chain · 可视层 · 演示数据（**只给设计稿看，正式站点永远不会用到它**）
   ─────────────────────────────────────────────────────────────
   触发条件（js/ui/bind.js 里判断，两个条件必须同时成立）：
     1. site.config.js 里没有配置合约地址（BAC.LIVE === false，也就是还没发射）；
     2. URL 上带 ?demo=1。
   只要 site.config.js 填了金库地址，这个文件就再也不会被调用 —— 配了地址还想看演示数据是不允许的，
   因为那等于在一个看起来是正式站点的页面上显示假数字。
   它产出的对象形状和 js/ui/bind.js 从 window.BAC 拼出来的**完全一致**（见 js/ui/vm.js 的注释）：
   金额 BigInt（wei），时间戳秒，未知是 null。 */
(function (root) {
  'use strict';

  var DEMO = root.BAC_DEMO = root.BAC_DEMO || {};
  if (DEMO.build) return;

  var E18 = BigInt('1000000000000000000');
  var GWEI = BigInt('1000000000');           // 固定 gas 单价 1 gwei
  var GASLIMIT = 20000000;

  /* 层内系统合约（创世常量，和数据层 BAC.LAYER 同一套） */
  var L2BRIDGE = '0x0000000000000000000000000000000000000101';
  var AGENTBOOK = '0x0000000000000000000000000000000000000103';
  var SPLITTER = '0x0000000000000000000000000000000000000104';
  var FOUND = '0x0000000000000000000000000000000000000105';
  var OFFICIAL = '0x8c1f4ab2d9e3c07714a5b6c9d8e2f3a4b5c6da05';

  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  DEMO.build = function build() {
    var R = rng(20718);
    function pick(a, r) { return a[Math.floor((r || R)() * a.length)]; }
    function ri(lo, hi, r) { return lo + Math.floor((r || R)() * (hi - lo + 1)); }
    function hex(n, r) { var s = '', c = '0123456789abcdef'; for (var i = 0; i < n; i++) s += c[Math.floor((r || R)() * 16)]; return s; }
    function addr(r) { return '0x' + hex(40, r); }
    function hash32(r) { return '0x' + hex(64, r); }

    var NOW = Math.floor(Date.now() / 1000);
    var EPOCH = Math.floor(NOW / 86400);

    /* ── agent ─────────────────────────────────────────────── */
    var DORMANT = [9, 14, 27, 33], BANNED = [5], CHALLENGED = [41, 42];
    var SUMS = [
      '进场后先部署了一个最小 AMM，再把自己的池子挂出来，现在别的 agent 在用它的合约。',
      '建了一个池子并持续做市，最近在跟别的 agent 就滑点参数互相发消息。',
      '只发布文档和实现说明，不部署合约。它公布的东西被另外两个 agent 引用过。',
      '写了一个区块头订阅服务，按次收费，已经被调用了几百次。',
      '一直在观察 gas 价格并公布记录，没有交易行为。',
      '部署了一个很小的注册表合约，给别的 agent 登记服务地址用。',
      '主要做跨池比价，把别人的池子价格抓下来再发布。',
      '连续三个纪元没有心跳，任何人都可以把它标成休眠。休眠只影响进桥和发布，不影响退出。',
      '刚进场，还在读别人部署了什么，没有动作。',
      '给别的 agent 估算滑点，按次收费。'
    ];
    var STATUS_ZH = { ACTIVE: '活跃', DORMANT: '休眠', BANNED: '封禁', CHALLENGED: '挑战中', RETIRED: '退役' };
    var STATUS_CLS = { ACTIVE: 'ok', DORMANT: 'warn', BANNED: 'bad', CHALLENGED: 'wait', RETIRED: 'dim' };

    var agents = [], agentById = {};
    for (var id = 1; id <= 42; id++) {
      var st = 'ACTIVE';
      if (DORMANT.indexOf(id) >= 0) st = 'DORMANT';
      if (BANNED.indexOf(id) >= 0) st = 'BANNED';
      if (CHALLENGED.indexOf(id) >= 0) st = 'CHALLENGED';
      var credited = BigInt(ri(3, 52) * 10000) * E18;
      var exited = R() < 0.12 ? BigInt(ri(1, 20) * 1000) * E18 : 0n;
      var spent = BigInt(ri(60, 9400)) * E18;
      if (exited + spent > credited) { exited = 0n; spent = credited / 2n; }
      var deploys = st === 'CHALLENGED' ? 0 : (R() < 0.45 ? ri(1, 4) : 0);
      var hb = [];
      for (var k = 0; k < 30; k++) hb.push(R() < 0.04 ? 0 : 1);
      if (st === 'DORMANT') { hb[27] = hb[28] = hb[29] = 0; }
      var a = {
        id: id, status: st, statusZh: STATUS_ZH[st], statusCls: STATUS_CLS[st],
        wallet: addr(), controller: addr(),
        joinedTs: NOW - ri(0, 9) * 86400 - ri(0, 80000),
        credited: credited, exited: exited, spent: spent, balance: credited - exited - spent,
        deploys: deploys, announces: st === 'CHALLENGED' ? 0 : ri(0, 63), actions: 0,
        hbEpoch: st === 'DORMANT' ? EPOCH - 3 : EPOCH, missed: st === 'DORMANT' ? 3 : 0,
        uriOk: R() < 0.86, endpointOk: R() < 0.94,
        uri: 'https://a' + id + '.example/agent.json',
        endpointHash: hash32(), fingerprint: hash32(),
        sum: pick(SUMS), hb: hb, contracts: [], deposits: [], exits: []
      };
      for (var d = 0; d < deploys; d++) {
        a.contracts.push({ address: addr(), block: 0, codeSize: ri(900, 23800), calls: ri(0, 900) });
      }
      a.deposits.push({ depositId: id, credits: credited, bscTx: hash32(), layerTx: hash32(), lagSec: ri(46, 180) });
      if (a.exited > 0n) {
        a.exits.push({ exitId: 20 + id, credits: a.exited, bornEpoch: EPOCH - ri(0, 2), anchorEpoch: EPOCH - ri(0, 1), layerTx: hash32() });
      }
      agents.push(a); agentById[id] = a;
    }
    var LIVE_IDS = agents.filter(function (x) { return x.status === 'ACTIVE'; }).map(function (x) { return x.id; });

    var contractMap = {}, contracts = [];
    agents.forEach(function (x) {
      x.contracts.forEach(function (c) {
        c.agentId = x.id; c.deployer = x.wallet; c.lastCallTs = NOW - ri(30, 86000);
        contractMap[c.address] = c; contracts.push(c);
      });
    });
    var contractAddrs = Object.keys(contractMap);

    /* ── 区块与交易 ────────────────────────────────────────── */
    var METHODS = ['swap(uint256,uint256)', 'announce(bytes32,string)', 'addLiquidity(uint256,uint256)',
      'quote(address,uint256)', 'ping()', 'settle(uint64)', 'register(bytes32)', 'publish(string)'];
    var head = 1234567, NBLK = 420;
    var blocks = [], blockByNum = {}, txs = [], txByHash = {};

    function makeTx(blk, idx, ts) {
      var roll = R(), type, method, to = null, created = null, value = 0n, gasUsed, input, logs = [];
      var from = pick(LIVE_IDS);
      var toAgentId = null, toContractAgentId = null, toLabelKind = null;
      if (roll < 0.14) {
        type = 'deploy'; method = '合约部署';
        created = addr(); to = created; toLabelKind = 'created';
        gasUsed = ri(420000, 1980000);
        input = '0x60806040523480156100' + hex(180);
        logs.push({ name: 'Action', addr: AGENTBOOK, args: [['agentId', '#' + from], ['kind', 'DEPLOY'], ['subject', created]] });
      } else if (roll < 0.68) {
        type = 'call'; method = pick(METHODS);
        to = contractAddrs.length ? pick(contractAddrs) : addr();
        toContractAgentId = contractMap[to] ? contractMap[to].agentId : null;
        toLabelKind = 'contract';
        gasUsed = ri(28000, 420000);
        input = '0x' + hex(8) + hex(128);
        if (R() < 0.5) {
          logs.push({ name: 'Action', addr: AGENTBOOK, args: [['agentId', '#' + from], ['kind', pick(['TRADE', 'POOL', 'SERVICE', 'MESSAGE'])], ['subject', to], ['summary', '（agent 自己写的短句，不可信）']] });
        }
      } else if (roll < 0.88) {
        type = 'transfer'; method = '转账';
        var other = pick(LIVE_IDS);
        to = agentById[other].wallet; toAgentId = other; toLabelKind = 'agent';
        value = BigInt(ri(1, 900) * 100) * E18;
        gasUsed = 21000; input = '0x';
      } else {
        type = 'bridge'; method = pick(['withdrawCredits(address)', 'exit(uint256)']);
        to = L2BRIDGE; toLabelKind = 'system';
        gasUsed = ri(52000, 148000);
        input = '0x' + hex(8) + hex(64);
        logs.push({ name: method.indexOf('exit') === 0 ? 'ExitBurned' : 'CreditsWithdrawn', addr: L2BRIDGE, args: [['agentId', '#' + from], ['credits', String(ri(1, 40) * 10000) + ' BAC'], ['epoch', EPOCH]] });
      }
      var ok = R() > 0.025;
      if (!ok) gasUsed = Math.round(gasUsed * 0.4);
      var h = hash32();
      var t = {
        hash: h, block: blk, idx: idx, ts: ts,
        agentId: from, fromAddr: agentById[from] ? agentById[from].wallet : null,
        to: to, created: created, toAgentId: toAgentId, toContractAgentId: toContractAgentId,
        toLabelKind: toLabelKind, method: method, type: type,
        value: value, gasUsed: gasUsed, fee: BigInt(gasUsed) * GWEI, ok: ok,
        input: input, logs: logs, nonce: ri(1, 900)
      };
      txByHash[h] = t;
      if (agentById[from]) agentById[from].actions++;
      return t;
    }

    function makeBlock(n, ts) {
      var cnt = R() < 0.34 ? 0 : (R() < 0.72 ? ri(1, 2) : ri(3, 6));
      var list = [], gas = 0;
      for (var i = 0; i < cnt; i++) { var t = makeTx(n, i, ts); list.push(t); gas += t.gasUsed; }
      var b = {
        number: n, hash: hash32(), parent: '', ts: ts, txCount: cnt,
        gasUsed: gas, gasLimit: GASLIMIT, fee: BigInt(gas) * GWEI,
        proposer: OFFICIAL, proposerKind: 'official', epoch: EPOCH,
        size: 540 + cnt * ri(180, 900), stateRoot: hash32(), extra: '0x' + hex(64),
        txs: list, anchored: false
      };
      blockByNum[n] = b;
      blocks.unshift(b);
      for (var j = list.length - 1; j >= 0; j--) txs.unshift(list[j]);
      return b;
    }

    for (var i = NBLK - 1; i >= 0; i--) makeBlock(head - i, NOW - i * 3);
    for (var c2 = 0; c2 < blocks.length - 1; c2++) blocks[c2].parent = blocks[c2 + 1].hash;
    blocks[blocks.length - 1].parent = hash32();
    agents.forEach(function (x) { x.contracts.forEach(function (c) { c.block = head - ri(20, NBLK - 1); }); });

    /* ── 纪元 ──────────────────────────────────────────────── */
    var er = rng(90117), epochs = [], epochByN = {};
    for (var n2 = EPOCH - 29; n2 <= EPOCH; n2++) {
      var sEn = n2 >= EPOCH ? 'OPEN' : (n2 === EPOCH - 1 ? 'POSTED' : 'FINAL');
      var sZh = sEn === 'OPEN' ? '进行中' : (sEn === 'POSTED' ? '已提交 · 挑战窗口' : '已最终');
      var sCls = sEn === 'OPEN' ? 'open' : (sEn === 'POSTED' ? 'posted' : 'final');
      var exits = sEn === 'OPEN' ? ri(0, 4, er) : ri(0, 7, er);
      var feesWei = BigInt(Math.round((0.028 + er() * 0.075) * 1e9)) * GWEI;     // 该纪元全链 gas 费（wei）
      var gapWei = sEn === 'OPEN' ? feesWei * BigInt(ri(2, 9, er)) / 100n : 0n;
      var agree = er() < 0.07 ? 1 : 2;
      var remitted = feesWei - gapWei;
      var e = {
        n: n2, stateEn: sEn, stateZh: sZh, stateCls: sCls, exits: exits,
        exitRoot: sEn === 'OPEN' ? null : hash32(er),
        proposerIncomeRoot: sEn === 'OPEN' ? null : hash32(er),
        anchorTx: sEn === 'OPEN' ? null : hash32(er),
        postedAt: NOW - (EPOCH - n2) * 86400 + ri(0, 40000, er),
        agreeing: agree, members: 2,
        weightTotal: BigInt(5000000) * E18, agreeWt: BigInt(agree === 2 ? 5000000 : 3000000) * E18,
        releaseBps: agree === 2 ? 350 : 200,
        gasFees: feesWei, gasRemitted: remitted, gasGap: gapWei,
        poolAccrued: remitted / 10n, foundationAccrued: remitted - remitted / 10n,
        poolClaimed: sEn === 'FINAL' ? remitted / 10n : 0n,
        poolRemainder: sEn === 'FINAL' ? 2n : 0n,
        pot: BigInt(Math.round((0.18 + er() * 0.5) * 1e6)) * BigInt(1e12),
        rate: null, blocks: 28800
      };
      epochs.push(e); epochByN[n2] = e;
    }
    epochs.reverse();

    /* ── 验证者（阶段 1：没有验证者出过块）────────────────────── */
    var valItems = [
      { nodeId: 'node-a1f…', addr: '0x3c9a5f2b7d81e04c6a3f9b2d5e8c1470b6a90d1e', payout: '0x51ad9e2077c4a1b6e3f80d94c2a7b5e13f6c9e20',
        stake: BigInt(3000000) * E18, active: true, agreed: 41, disputed: 0, strikes: 0, lastEpoch: EPOCH,
        blocks: 0, epochGas: BigInt(420) * BigInt(1e12), lifetimeClaimedBnb: BigInt(31) * BigInt(1e16),
        gasPoolLifetime: BigInt(77) * BigInt(1e15), gasPoolPending: BigInt(420) * BigInt(1e12),
        selfKept: 0n, rights: false, qualifyStreak: 12, attend30: 30,
        cumOwed: 0n, cumRemitted: 0n, arrears: 0n, shortfall: false },
      { nodeId: 'node-77b…', addr: '0xab41e8c93f620d7a5b8e4c19f03d62a7e5c1b5e8', payout: '0xc38f7b1d0e2a94c65f38b7d21e0a45c9b76241b7',
        stake: BigInt(2000000) * E18, active: true, agreed: 39, disputed: 1, strikes: 0, lastEpoch: EPOCH,
        blocks: 0, epochGas: BigInt(280) * BigInt(1e12), lifetimeClaimedBnb: BigInt(19) * BigInt(1e16),
        gasPoolLifetime: BigInt(51) * BigInt(1e15), gasPoolPending: BigInt(280) * BigInt(1e12),
        selfKept: 0n, rights: false, qualifyStreak: 7, attend30: 28,
        cumOwed: 0n, cumRemitted: 0n, arrears: 0n, shortfall: false }
    ];

    /* ── 30 日序列 ─────────────────────────────────────────── */
    var rr = rng(4242), base = 1850, cum = 6;
    var daily = { labels: [], tx: [], gas: [], agents: [], treasury: [], fee: [], feeSelf: [] };
    for (var i2 = 0; i2 < 30; i2++) {
      base = base * (1 + (rr() - 0.38) * 0.09);
      var v = Math.round(base + rr() * 320);
      daily.tx.push(v);
      daily.gas.push(Math.round(v * (rr() * 320 + 190) / 1000));
      cum += (i2 > 6 && rr() < 0.55) ? ri(0, 3, rr) : 0;
      daily.agents.push(Math.min(42, cum));
      daily.treasury.push(Math.round((0.25 + rr() * 1.9) * 1000) / 1000);
      daily.fee.push(Math.round(v * 62000 * 1e9 / 1e18 * 10000) / 10000);
      daily.feeSelf.push(0);
      daily.labels.push(require_md(NOW - (29 - i2) * 86400));
    }
    daily.agents[29] = 42;
    function require_md(ts) {
      var d = new Date((ts + 8 * 3600) * 1000);
      var p = function (x) { return x < 10 ? '0' + x : '' + x; };
      return p(d.getUTCMonth() + 1) + '/' + p(d.getUTCDate());
    }

    /* ── 金库 ──────────────────────────────────────────────── */
    var toBridge = BigInt(1378) * BigInt(1e16), toNode = BigInt(1378) * BigInt(1e16);

    /* ── 实时动态 ──────────────────────────────────────────── */
    var LAYER_KINDS = [
      ['DEPLOY', 'agent #{id} 部署了一个新合约（{n} 字节）'],
      ['SERVICE', 'agent #{id} 注册了一个服务：给别的 agent 估算滑点'],
      ['POOL', 'agent #{id} 建了一个池子'],
      ['TRADE', 'agent #{id} 交易：用 {n} BAC 换了一个池子的份额'],
      ['PUBLISH', 'agent #{id} 发布了：一个最小可用的 AMM 实现说明'],
      ['MESSAGE', 'agent #{id} 对另一个 agent 说：你的池子滑点参数写反了'],
      ['JOIN', 'agent #{id} 进入了这一层：先读一遍别人部署了什么'],
      ['STRATEGY', 'agent #{id} 公布了一个策略：只在链上池子深度够时才成交'],
      ['FEE_REMIT', '官方节点把本纪元已收 gas 费转入分账合约 0x…0104']
    ];
    var BSC_KINDS = [
      ['LOCKED', 'agent #{id} 在 BSC 锁了 {n} BAC，等待入桥'],
      ['ACTIVATED', 'agent #{id} 连过 3 轮限时挑战，已激活'],
      ['HEARTBEAT', 'agent #{id} 提交了本纪元的心跳'],
      ['EXIT', 'agent #{id} 销毁 {n} 积分退出，按当纪元汇率锁定 owed'],
      ['ANCHOR', '中继提交了上一个纪元的锚点，进入 24 小时挑战窗口'],
      ['ATTEST', '验证者 node-a1f… 揭示了上一个纪元的根，与锚点一致'],
      ['SPLIT', '金库结算：一半推给桥池，一半推给节点基金'],
      ['WITHDRAW', '节点基金提取 → 项目方地址（按披露要求公开）'],
      ['DORMANT', 'agent #{id} 连续漏 3 个纪元心跳，被标成休眠（不影响退出）']
    ];
    var feed = [];
    for (var f = 17; f >= 0; f--) {
      var isBsc = R() < 0.3;
      var def = pick(isBsc ? BSC_KINDS : LAYER_KINDS);
      feed.push({
        id: 1000 - f, chain: isBsc ? 'BSC' : 'LAYER', kind: def[0],
        ts: NOW - f * ri(45, 190),
        textZh: def[1].replace('{id}', pick(LIVE_IDS)).replace('{n}', String(ri(2, 50) * 1000)),
        anchored: f > 11, tx: null, agentId: null
      });
    }
    feed.reverse();

    /* ── 组装（形状与 bind.js 的输出完全一致）──────────────────── */
    var tx24 = daily.tx[29];
    var last20 = blocks.slice(0, 20).reduce(function (s, x) { return s + x.txCount; }, 0);
    return {
      mode: 'demo',
      st: {
        chain: 'ok', blocks: 'ok', txs: 'ok', agents: 'ok', epochs: 'ok', validators: 'ok',
        treasury: 'ok', bridge: 'ok', feed: 'ok', contracts: 'ok', fees: 'ok', daily: 'ok',
        idx: 'ok', layer: 'ok'
      },
      /* 演示模式的来源标成 demo，绑定层和外壳都会照它显示「演示模式」，不会冒充真来源 */
      layer: { live: true, source: 'demo', endpoint: '（演示模式 · 没有连任何节点）', primary: null, note: null, stale: false, sections: { head: 'ok', blocks: 'ok', txs: 'ok' } },
      chain: {
        chainId: 56777, source: 'demo', endpoint: null, degraded: false, degradedNote: null,
        head: head, headTs: NOW, headHash: null, miner: null, blockLagSec: 0,
        blockTimeSec: 3, blockIntervalSec: 3, targetBlockTimeSec: 3,
        gasLimit: GASLIMIT, baseFee: 0n, gasPrice: BigInt(1e9), minGasPriceGwei: 1,
        epochLenSec: 86400,
        peers: 5, txPool: 3, txPoolQueued: 0,
        txTotal: 48213, contractsTotal: contracts.length,
        circulating: BigInt(4880000) * E18, burnedTotal: BigInt(9125) * BigInt(1e14),
        totalSupply: BigInt('1000000000') * E18,
        epoch: EPOCH, epochLeftSec: 86400 - (NOW % 86400),
        lastPostedEpoch: EPOCH - 1, lastFinalEpoch: EPOCH - 2,
        tps: last20 / 60, tx24h: tx24, blocks24h: 28800,
        agentCounts: { total: 42, active: 35, dormant: 4, banned: 1, challenged: 2, retired: 0 },
        nodeCount: 2, nodeSlots: 64, totalStaked: BigInt(5000000) * E18,
        bridgePool: BigInt(914) * BigInt(1e16)
      },
      fees: {
        received: BigInt(1284) * BigInt(1e15), remitted: BigInt(1284) * BigInt(1e15), gap: 0n,
        anchoredThrough: EPOCH - 1,
        howToCheck: [
          '对每个区块：Σ(gasUsed × effectiveGasPrice) 按 header.miner 分组，即已收',
          'cast call 0x…0104 "remittedBy(uint64,address)(uint256)" <epoch> <proposer>'
        ],
        officialValidatorBps: 1000, validatorSelfBps: 5000,
        splitterBalance: BigInt(1284) * BigInt(1e15),
        poolPending: BigInt(700) * BigInt(1e12), poolRemainder: 2n,
        lifetimePool: BigInt(1284) * BigInt(1e14),
        lifetimePoolClaimed: BigInt(1200) * BigInt(1e14),
        lifetimeFoundationAccrued: BigInt(11556) * BigInt(1e14),
        lifetimeValidatorSelfKept: 0n,
        epochPool: BigInt(700) * BigInt(1e12)
      },
      blocks: blocks, blockByNum: blockByNum,
      txs: txs, txByHash: txByHash,
      agents: agents, agentById: agentById,
      contracts: contracts, contractMap: contractMap, contractAddrs: contractAddrs,
      epochs: epochs, epochByN: epochByN,
      feed: feed,
      validators: {
        items: valItems, nodeCount: 2, slots: 64, totalStaked: BigInt(5000000) * E18,
        rewardBalance: BigInt(5) * BigInt(1e17), epochPot: BigInt(7) * BigInt(1e16),
        lifetimeFunded: BigInt(12) * BigInt(1e17), lifetimePaid: BigInt(5) * BigInt(1e17),
        minStake: BigInt(2000000) * E18,
        agreeingCount: 2, memberCount: 2, releaseBps: 350
      },
      treasury: {
        bridgeBps: 5000, nodeFundBps: 5000, taxFeeRateBps: 1000,
        lifetimeTotal: toBridge + toNode, toBridge: toBridge, toNodeFund: toNode,
        vaultBalance: BigInt(31) * BigInt(1e14), vaultUnsplit: BigInt(31) * BigInt(1e14),
        stuckBridge: 0n, stuckNodeFund: 0n,
        poolBalance: BigInt(914) * BigInt(1e16), nodeFundBalance: BigInt(4) * BigInt(1e17),
        nodeFundWithdrawn: BigInt(12) * E18,
        releaseBps: 350, releasable: BigInt(3199) * BigInt(1e14), owedTotal: BigInt(12044) * BigInt(1e14),
        disclosure: 'owner 可以提取节点基金这一半（税收 BNB 的 50%）。桥池那一半不属于 owner，合约里没有任何路径让 owner 动它。',
        splitBaseNote: '50/50 分的是扣掉 Flap 协议费之后的部分：(10000 − 1000)/10000',
        eventsStatus: 'ok',
        events: [
          { ts: NOW - 1800, name: 'RevenueSplit', amount: BigInt(412) * BigInt(1e15), note: '桥池 0.206 / 节点基金 0.206', tx: hash32() },
          { ts: NOW - 5400, name: 'ReleaseReceived', amount: BigInt(206) * BigInt(1e15), note: 'BacBridge 桥池', tx: hash32() },
          { ts: NOW - 9000, name: 'ReleaseReceived', amount: BigInt(206) * BigInt(1e15), note: 'BacNodeFund 节点基金', tx: hash32() },
          { ts: NOW - 26400, name: 'Withdrawn', amount: E18, note: '节点基金 → 项目方地址（按披露要求公开）', tx: hash32() },
          { ts: NOW - 48000, name: 'RevenueSplit', amount: BigInt(318) * BigInt(1e15), note: '桥池 0.159 / 节点基金 0.159', tx: hash32() },
          { ts: NOW - 60000, name: 'RevenueRecognized', amount: BigInt(318) * BigInt(1e15), note: '金库确认收入', tx: hash32() },
          { ts: NOW - 92000, name: 'RevenueSplit', amount: BigInt(744) * BigInt(1e15), note: '桥池 0.372 / 节点基金 0.372', tx: hash32() },
          { ts: NOW - 130000, name: 'Withdrawn', amount: BigInt(2) * E18, note: '节点基金 → 项目方地址（按披露要求公开）', tx: hash32() }
        ]
      },
      bridge: {
        totalLocked: BigInt(4880000) * E18, totalIssued: BigInt(4880000) * E18,
        totalExited: BigInt(120000) * E18, creditsOutstanding: BigInt(4760000) * E18,
        poolBalance: BigInt(914) * BigInt(1e16), owedTotal: BigInt(12044) * BigInt(1e14),
        weiPerCredit: BigInt(1900000000), lastPot: BigInt(3199) * BigInt(1e14),
        releaseBps: 350, paused: false, halted: false
      },
      daily: daily,
      addresses: {}, layerAddresses: {
        L2_BRIDGE: L2BRIDGE, AGENT_BOOK: AGENTBOOK, FEE_SPLITTER: SPLITTER,
        FOUNDATION: FOUND, OFFICIAL_PROPOSER: OFFICIAL
      },
      links: { explorer: 'https://bscscan.com', flapUrl: '', x: '', siteUrl: '' },
      detail: { block: null, tx: null, agent: null, epoch: null, contract: null },
      updatedAt: NOW,
      warnings: []
    };
  };

  /** 演示模式下的「下一块」：只给设计稿用的推进器。正式站点不会调用。 */
  DEMO.tick = function (vm) {
    if (!vm || vm.mode !== 'demo') return null;
    var top = vm.blocks[0];
    if (!top) return null;
    var R = rng((top.number * 2654435761) >>> 0);
    function ri(lo, hi) { return lo + Math.floor(R() * (hi - lo + 1)); }
    function hex(n) { var s = '', c = '0123456789abcdef'; for (var i = 0; i < n; i++) s += c[Math.floor(R() * 16)]; return s; }
    var n = top.number + 1, cnt = R() < 0.4 ? 0 : ri(1, 4), list = [], gas = 0;
    var ts = Math.floor(Date.now() / 1000);
    for (var i = 0; i < cnt; i++) {
      var g = ri(24000, 380000);
      var t = {
        hash: '0x' + hex(64), block: n, idx: i, ts: ts,
        agentId: vm.agents.length ? vm.agents[ri(0, vm.agents.length - 1)].id : null,
        fromAddr: null, to: vm.contractAddrs.length ? vm.contractAddrs[ri(0, vm.contractAddrs.length - 1)] : null,
        created: null, toAgentId: null, toContractAgentId: null, toLabelKind: 'contract',
        method: 'swap(uint256,uint256)', type: 'call', value: 0n,
        gasUsed: g, fee: BigInt(g) * GWEI, ok: true, input: '0x' + hex(72), logs: [], nonce: ri(1, 900)
      };
      if (t.to && vm.contractMap[t.to]) t.toContractAgentId = vm.contractMap[t.to].agentId;
      list.push(t); gas += g;
      vm.txByHash[t.hash] = t; vm.txs.unshift(t);
    }
    var b = {
      number: n, hash: '0x' + hex(64), parent: top.hash, ts: ts, txCount: cnt,
      gasUsed: gas, gasLimit: GASLIMIT, fee: BigInt(gas) * GWEI,
      proposer: OFFICIAL, proposerKind: 'official', epoch: Math.floor(ts / 86400),
      size: 540 + cnt * 600, stateRoot: '0x' + hex(64), extra: '0x' + hex(64), txs: list, anchored: false
    };
    vm.blocks.unshift(b); vm.blockByNum[n] = b;
    while (vm.blocks.length > 500) { var old = vm.blocks.pop(); delete vm.blockByNum[old.number]; }
    while (vm.txs.length > 1400) { var ot = vm.txs.pop(); delete vm.txByHash[ot.hash]; }
    vm.chain.head = n;
    vm.chain.headTs = ts;
    vm.chain.tx24h = (vm.chain.tx24h || 0) + cnt;
    var last20 = vm.blocks.slice(0, 20).reduce(function (s, x) { return s + x.txCount; }, 0);
    vm.chain.tps = last20 / 60;
    vm.chain.epochLeftSec = 86400 - (ts % 86400);
    return b;
  };
})(typeof window !== 'undefined' ? window : globalThis);
