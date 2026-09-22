/* BNB Agent Chain · 区块浏览器 · 方案三「分页式应用」
   纯前端演示：所有数字都是占位值，没有任何网络请求、没有任何外部依赖。
   正式站点的每一个字段都来自 docs/03-INTERFACES.md §3 定义的只读 HTTP API。 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ───────────────────────── 工具 ───────────────────────── */
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  var R = rng(20718);
  function pick(a, r) { return a[Math.floor((r || R)() * a.length)]; }
  function ri(lo, hi, r) { return lo + Math.floor((r || R)() * (hi - lo + 1)); }
  function comma(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function hex(n, r) { var s = '', c = '0123456789abcdef'; for (var i = 0; i < n; i++) s += c[Math.floor((r || R)() * 16)]; return s; }
  function addr(r) { return '0x' + hex(40, r); }
  function hash32(r) { return '0x' + hex(64, r); }
  function sa(a) { return a ? a.slice(0, 8) + '…' + a.slice(-4) : '—'; }
  function sh(h) { return h ? h.slice(0, 12) + '…' + h.slice(-6) : '—'; }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hms(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function full(d) { return ymd(d) + ' ' + hms(d) + ' (UTC+8)'; }
  function ago(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 5) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function bac(wei, dp) { return (wei / 1e18).toFixed(dp === undefined ? 6 : dp); }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  /* ───────────────────────── 常量 ───────────────────────── */
  var OFFICIAL = '0x8c1f4ab2d9e3c07714a5b6c9d8e2f3a4b5c6da05';   // 官方出块节点（不流通地址）
  var SPLITTER = '0x0000000000000000000000000000000000000104';   // FeeSplitter
  var FOUND    = '0x0000000000000000000000000000000000000105';   // 官方基金会
  var L2BRIDGE = '0x0000000000000000000000000000000000000101';
  var AGENTBOOK= '0x0000000000000000000000000000000000000102';
  var GASPRICE = 1e9;      // 1 gwei，固定下限，basefee = 0
  var GASLIMIT = 20000000;
  var EPOCH    = 20718;
  var VAL_SHARE_OFFICIAL = 0.10;   // 官方节点出的块 → 验证者池
  var VAL_SHARE_SELF     = 0.50;   // 验证者自己出的块 → 该验证者

  /* ───────────────────────── 数据：agent ───────────────────────── */
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
  var METHODS = ['swap(uint256,uint256)', 'announce(bytes32,string)', 'addLiquidity(uint256,uint256)',
    'quote(address,uint256)', 'ping()', 'settle(uint64)', 'register(bytes32)', 'publish(string)'];

  var agents = [], agentById = {};
  (function buildAgents() {
    for (var id = 1; id <= 42; id++) {
      var st = 'ACTIVE', stZh = '活跃', stCls = 'ok';
      if (DORMANT.indexOf(id) >= 0) { st = 'DORMANT'; stZh = '休眠'; stCls = 'warn'; }
      if (BANNED.indexOf(id) >= 0) { st = 'BANNED'; stZh = '封禁'; stCls = 'bad'; }
      if (CHALLENGED.indexOf(id) >= 0) { st = 'CHALLENGED'; stZh = '挑战中'; stCls = 'wait'; }
      var credited = ri(3, 52) * 10000;
      var exited = R() < 0.12 ? ri(1, 20) * 1000 : 0;
      var spent = ri(60, 9400);                 // 层内花掉的积分（gas + 交易 + 发布费）
      if (exited + spent > credited) { exited = 0; spent = Math.min(spent, credited - 100); }
      var deploys = st === 'CHALLENGED' ? 0 : (R() < 0.45 ? ri(1, 4) : 0);
      var days = ri(0, 9);
      var hb = [];
      for (var k = 0; k < 30; k++) hb.push(R() < 0.04 ? 0 : 1);
      if (st === 'DORMANT') { hb[27] = hb[28] = hb[29] = 0; }
      var a = {
        id: id, status: st, statusZh: stZh, statusCls: stCls,
        wallet: addr(), controller: addr(),
        joinedTs: Date.now() - days * 86400000 - ri(0, 80000) * 1000,
        credited: credited, exited: exited, spent: spent,
        balance: credited - exited - spent,
        deploys: deploys, announces: st === 'CHALLENGED' ? 0 : ri(0, 63),
        actions: 0, hbEpoch: st === 'DORMANT' ? EPOCH - 3 : EPOCH, missed: st === 'DORMANT' ? 3 : 0,
        uriOk: R() < 0.86, backref: true, endpointOk: R() < 0.94,
        model: 'claude-opus-' + pick(['4', '5']), sum: pick(SUMS),
        uri: 'https://a' + id + '.example/agent.json',
        endpointHash: hash32(), fingerprint: hash32(),
        hb: hb, contracts: [], acts: [], deposits: [], exits: []
      };
      for (var d = 0; d < deploys; d++) {
        a.contracts.push({ address: addr(), block: 0, codeSize: ri(900, 23800), calls: ri(0, 900) });
      }
      a.deposits.push({ depositId: id, credits: credited, bscTx: hash32(), layerTx: hash32(), lagSec: ri(46, 180) });
      if (a.exited) a.exits.push({ exitId: 20 + id, credits: a.exited, bornEpoch: EPOCH - ri(0, 2), anchorEpoch: EPOCH - ri(0, 1), layerTx: hash32(), collected: 0 });
      agents.push(a); agentById[id] = a;
    }
  })();
  var LIVE_IDS = agents.filter(function (a) { return a.status === 'ACTIVE'; }).map(function (a) { return a.id; });

  /* 合约总表（地址 → 部署者） */
  var contractMap = {};
  agents.forEach(function (a) { a.contracts.forEach(function (c) { c.agentId = a.id; contractMap[c.address] = c; }); });
  var CONTRACT_ADDRS = Object.keys(contractMap);
  /* GET /api/contracts 的每个字段都要有地方显示：codeSize / deployer / callCount / lastCall */
  CONTRACT_ADDRS.forEach(function (c) {
    var m = contractMap[c];
    m.lastCallTs = Date.now() - ri(30, 86000) * 1000;
    m.deployer = agentById[m.agentId].wallet;
  });

  /* ───────────────────────── 数据：纪元与锚点 ─────────────────────────
     字段对应 03-INTERFACES.md §3 的 epochs 表 + 决策 #17 的 gas 分账列。 */
  var VALIDATOR_NODES = [
    { nodeId: 'node-a1f…', addr: '0x3c9a5f2b7d81e04c6a3f9b2d5e8c1470b6a90d1e', stake: 3000000, payout: '0x51ad…9e20' },
    { nodeId: 'node-77b…', addr: '0xab41e8c93f620d7a5b8e4c19f03d62a7e5c1b5e8', stake: 2000000, payout: '0xc38f…41b7' }
  ];
  var epochs = [], epochByN = {};
  function epochState(n) {
    if (n >= EPOCH) return { zh: '进行中', en: 'OPEN', cls: 'open' };
    if (n === EPOCH - 1) return { zh: '已提交 · 挑战窗口', en: 'POSTED', cls: 'posted' };
    return { zh: '已最终', en: 'FINAL', cls: 'final' };
  }
  (function buildEpochs() {
    var er = rng(90117);
    for (var n = EPOCH - 29; n <= EPOCH; n++) {
      var st = epochState(n);
      var exits = st.en === 'OPEN' ? ri(0, 4, er) : ri(0, 7, er);
      var fees = (0.028 + er() * 0.075);                 // 该纪元全链 gas 费（BAC）
      var gap = st.en === 'OPEN' ? fees * (0.02 + er() * 0.08) : 0;
      var agree = er() < 0.07 ? 1 : 2;
      epochs.push({
        n: n, state: st, exits: exits,
        exitRoot: st.en === 'OPEN' ? null : hash32(er),
        proposerIncomeRoot: st.en === 'OPEN' ? null : hash32(er),
        anchorTx: st.en === 'OPEN' ? null : hash32(er),
        postedAt: Date.now() - (EPOCH - n) * 86400000 + ri(0, 40000, er) * 1000,
        agreeing: agree, members: 2,
        weightTotal: 5000000, agreeWt: agree === 2 ? 5000000 : 3000000,
        releaseBps: agree === 2 ? 350 : 200,
        gasFees: fees, gasRemitted: fees - gap, gasGap: gap,
        poolAccrued: (fees - gap) * VAL_SHARE_OFFICIAL,
        foundationAccrued: (fees - gap) * (1 - VAL_SHARE_OFFICIAL),
        poolClaimed: st.en === 'FINAL' ? (fees - gap) * VAL_SHARE_OFFICIAL : 0,
        pot: (0.18 + er() * 0.5), rate: 0, blocks: 28800
      });
    }
    epochs.forEach(function (e) {
      e.rate = e.exits ? e.pot / (e.exits * 12000) : 0;
      epochByN[e.n] = e;
    });
    epochs.reverse();
  })();

  /* ───────────────────────── 数据：区块与交易 ───────────────────────── */
  var head = 1234567;
  var blocks = [], blockByNum = {}, txs = [], txByHash = {};
  var NBLK = 420;

  function makeTx(blk, idx, ts) {
    var roll = R(), type, method, to, toLabel, value = 0, gasUsed, input, logs = [];
    var from = pick(LIVE_IDS);
    if (roll < 0.14) {
      type = 'deploy'; method = '合约部署'; to = null;
      var created = addr();
      toLabel = '<span class="ok-t">新合约 ' + sa(created) + '</span>';
      gasUsed = ri(420000, 1980000);
      input = '0x60806040523480156100' + hex(180);
      logs.push({ name: 'Action', addr: AGENTBOOK, args: [['agentId', '#' + from], ['kind', 'DEPLOY'], ['subject', created], ['codeSize', comma(ri(900, 23800)) + ' 字节']] });
      to = created;
    } else if (roll < 0.68) {
      type = 'call'; method = pick(METHODS);
      to = CONTRACT_ADDRS.length ? pick(CONTRACT_ADDRS) : addr();
      var c = contractMap[to];
      toLabel = '<a class="a-link" href="#/contract/' + to + '"><code>' + sa(to) + '</code></a>' +
        (c ? '<span class="sub">agent #' + c.agentId + ' 部署</span>' : '');
      gasUsed = ri(28000, 420000);
      input = '0x' + hex(8) + hex(128);
      if (R() < 0.5) logs.push({ name: 'Action', addr: AGENTBOOK, args: [['agentId', '#' + from], ['kind', pick(['TRADE', 'POOL', 'SERVICE', 'MESSAGE'])], ['subject', to], ['summary', '（agent 自己写的短句，不可信）']] });
    } else if (roll < 0.88) {
      type = 'transfer'; method = '转账';
      var other = pick(LIVE_IDS);
      to = agentById[other].wallet;
      toLabel = '<code>' + sa(to) + '</code><span class="sub">agent #' + other + '</span>';
      value = ri(1, 900) * 100;
      gasUsed = 21000;
      input = '0x';
    } else {
      type = 'bridge'; method = pick(['withdrawCredits(address)', 'exit(uint256)']);
      to = L2BRIDGE;
      toLabel = '<code>' + sa(L2BRIDGE) + '</code><span class="sub">L2Bridge</span>';
      gasUsed = ri(52000, 148000);
      input = '0x' + hex(8) + hex(64);
      logs.push({ name: method.indexOf('exit') === 0 ? 'ExitBurned' : 'CreditsWithdrawn', addr: L2BRIDGE, args: [['agentId', '#' + from], ['credits', comma(ri(1, 40) * 10000) + ' BAC'], ['epoch', EPOCH]] });
    }
    var ok = R() > 0.025;
    if (!ok) gasUsed = Math.round(gasUsed * 0.4);
    var h = hash32();
    var t = {
      hash: h, block: blk, idx: idx, ts: ts, from: from, to: to, toLabel: toLabel,
      method: method, type: type, value: value, gasUsed: gasUsed,
      fee: gasUsed * GASPRICE, ok: ok, input: input, logs: logs, nonce: ri(1, 900)
    };
    txByHash[h] = t;
    if (agentById[from]) agentById[from].actions++;
    return t;
  }

  function makeBlock(n, ts, live) {
    var cnt = R() < 0.34 ? 0 : (R() < 0.72 ? ri(1, 2) : ri(3, 6));
    var list = [], gas = 0;
    for (var i = 0; i < cnt; i++) { var t = makeTx(n, i, ts); list.push(t); gas += t.gasUsed; }
    var b = {
      number: n, hash: hash32(), parent: '', ts: ts, txCount: cnt, gasUsed: gas,
      fee: gas * GASPRICE, proposer: OFFICIAL, proposerKind: 'official', epoch: EPOCH,
      size: 540 + cnt * ri(180, 900), txs: list, stateRoot: hash32(), extra: '0x' + hex(64)
    };
    blockByNum[n] = b;
    blocks.unshift(b);
    for (var j = list.length - 1; j >= 0; j--) txs.unshift(list[j]);
    if (!live) return b;
    while (blocks.length > NBLK + 80) { var old = blocks.pop(); delete blockByNum[old.number]; }
    while (txs.length > 1400) { var ot = txs.pop(); delete txByHash[ot.hash]; }
    return b;
  }

  (function seedChain() {
    var now = Date.now();
    for (var i = NBLK - 1; i >= 0; i--) makeBlock(head - i, now - i * 3000, false);
    for (var k = 0; k < blocks.length - 1; k++) blocks[k].parent = blocks[k + 1].hash;
    blocks[blocks.length - 1].parent = hash32();
    agents.forEach(function (a) {
      a.contracts.forEach(function (c) { c.block = head - ri(20, NBLK - 1); });
    });
  })();

  /* ───────────────────────── 数据：日线序列 ───────────────────────── */
  var DAYS = 30;
  var dayTx = [], dayGas = [], dayAgents = [], dayTre = [], dayFee = [], dayLabels = [];
  (function buildDaily() {
    var rr = rng(4242), base = 1850, cum = 6;
    for (var i = 0; i < DAYS; i++) {
      base = base * (1 + (rr() - 0.38) * 0.09);
      var v = Math.round(base + rr() * 320);
      dayTx.push(v);
      dayGas.push(Math.round(v * (rr() * 320 + 190) / 1000));  // 百万 gas
      cum += (i > 6 && rr() < 0.55) ? ri(0, 3, rr) : 0;
      dayAgents.push(Math.min(42, cum));
      dayTre.push(Math.round((0.25 + rr() * 1.9) * 1000) / 1000);
      dayFee.push(Math.round(v * 62000 * 1e9 / 1e18 * 10000) / 10000);   // 当日 gas 费合计（BAC）
      var d = new Date(Date.now() - (DAYS - 1 - i) * 86400000);
      dayLabels.push(pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()));
    }
    dayAgents[DAYS - 1] = 42;
  })();

  /* ───────────────────────── 手绘 SVG 图表 ───────────────────────── */
  function fmtShort(v) {
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
    if (v >= 10) return String(Math.round(v));
    if (v >= 1) return String(Math.round(v * 10) / 10);
    return String(Math.round(v * 100) / 100);
  }
  function drawChart(el, o) {
    if (!el) return;
    var w = el.clientWidth;
    if (!w || w < 40) return;
    var h = +el.getAttribute('data-h') || 110;
    var pl = o.padL === undefined ? 30 : o.padL, pr = 6, pt = 8, pb = 15;
    var iw = w - pl - pr, ih = h - pt - pb;
    var data = o.data, n = data.length;
    var max = Math.max.apply(null, data), min = o.zero === false ? Math.min.apply(null, data) : 0;
    if (max === min) max = min + 1;
    max = max * 1.06;
    var X = function (i) { return pl + (n === 1 ? iw / 2 : iw * i / (n - 1)); };
    var Y = function (v) { return pt + ih - ih * (v - min) / (max - min); };
    var s = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(o.label || '图表') + '">';

    // 网格与刻度
    if (!o.bare) {
      for (var g = 0; g <= 2; g++) {
        var gv = min + (max - min) * g / 2, gy = Y(gv);
        s += '<line class="c-grid" x1="' + pl + '" y1="' + gy.toFixed(1) + '" x2="' + (w - pr) + '" y2="' + gy.toFixed(1) + '"/>';
        s += '<text class="c-lbl r" x="' + (pl - 5) + '" y="' + (gy + 3).toFixed(1) + '">' + fmtShort(gv) + '</text>';
      }
    }
    s += '<line class="c-axis" x1="' + pl + '" y1="' + (pt + ih) + '" x2="' + (w - pr) + '" y2="' + (pt + ih) + '"/>';

    if (o.type === 'bar') {
      var bw = Math.max(1.5, iw / n - (n > 80 ? 0.6 : 2));
      for (var i = 0; i < n; i++) {
        var bx = pl + iw * i / n + (iw / n - bw) / 2;
        var by = Y(data[i]), bh = Math.max(1, pt + ih - by);
        s += '<rect class="c-bar' + (i === n - 1 ? ' hi' : (o.alt ? ' alt' : '')) + '" x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '"><title>' +
          esc((o.labels ? o.labels[i] + ' · ' : '') + fmtShort(data[i]) + (o.unit || '')) + '</title></rect>';
      }
    } else {
      var pts = data.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); });
      var d = 'M' + pts.join(' L');
      if (o.type === 'area') {
        s += '<path class="c-area' + (o.tone === 'amb' ? ' amb' : '') + '" d="' + d + ' L' + X(n - 1).toFixed(1) + ',' + (pt + ih) + ' L' + X(0).toFixed(1) + ',' + (pt + ih) + ' Z"/>';
      }
      s += '<path class="c-line' + (o.tone ? ' ' + o.tone : '') + '" d="' + d + '"/>';
      s += '<circle class="c-dot" cx="' + X(n - 1).toFixed(1) + '" cy="' + Y(data[n - 1]).toFixed(1) + '" r="2.4"/>';
      for (var k = 0; k < n; k++) {
        s += '<rect x="' + (X(k) - iw / n / 2).toFixed(1) + '" y="' + pt + '" width="' + (iw / n).toFixed(1) + '" height="' + ih + '" fill="transparent"><title>' +
          esc((o.labels ? o.labels[k] + ' · ' : '') + fmtShort(data[k]) + (o.unit || '')) + '</title></rect>';
      }
    }
    if (o.labels && !o.bare) {
      s += '<text class="c-lbl" x="' + pl + '" y="' + (h - 3) + '">' + esc(o.labels[0]) + '</text>';
      s += '<text class="c-lbl" x="' + (pl + iw / 2) + '" y="' + (h - 3) + '" text-anchor="middle">' + esc(o.labels[Math.floor(n / 2)]) + '</text>';
      s += '<text class="c-lbl r" x="' + (w - pr) + '" y="' + (h - 3) + '">' + esc(o.labels[n - 1]) + '</text>';
    }
    s += '</svg>';
    el.innerHTML = s;
  }

  /* 堆叠柱：series 是从下往上叠的若干条，对应新的分账规则 */
  function drawStacked(el, o) {
    if (!el) return;
    var w = el.clientWidth; if (!w || w < 40) return;
    var h = +el.getAttribute('data-h') || 110;
    var pl = 34, pr = 6, pt = 8, pb = 15;
    var iw = w - pl - pr, ih = h - pt - pb;
    var n = o.series[0].data.length;
    var totals = [], i, k;
    for (i = 0; i < n; i++) {
      var t = 0;
      for (k = 0; k < o.series.length; k++) t += o.series[k].data[i];
      totals.push(t);
    }
    var max = Math.max.apply(null, totals) * 1.08 || 1;
    var s = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(o.label || '图表') + '">';
    for (var g = 0; g <= 2; g++) {
      var gv = max * g / 2, gy = pt + ih - ih * g / 2;
      s += '<line class="c-grid" x1="' + pl + '" y1="' + gy.toFixed(1) + '" x2="' + (w - pr) + '" y2="' + gy.toFixed(1) + '"/>';
      s += '<text class="c-lbl r" x="' + (pl - 5) + '" y="' + (gy + 3).toFixed(1) + '">' + fmtShort(gv) + '</text>';
    }
    s += '<line class="c-axis" x1="' + pl + '" y1="' + (pt + ih) + '" x2="' + (w - pr) + '" y2="' + (pt + ih) + '"/>';
    var bw = Math.max(1.5, iw / n - 2);
    for (i = 0; i < n; i++) {
      var bx = pl + iw * i / n + (iw / n - bw) / 2, base = pt + ih;
      var tip = (o.labels ? o.labels[i] + ' · ' : '') + '合计 ' + totals[i].toFixed(4) + (o.unit || '');
      for (k = 0; k < o.series.length; k++) {
        var v = o.series[k].data[i];
        tip += '　' + o.series[k].name + ' ' + v.toFixed(4);
        if (v <= 0) continue;
        var bh = ih * v / max;
        base -= bh;
        s += '<rect class="c-bar ' + o.series[k].cls + '" x="' + bx.toFixed(1) + '" y="' + base.toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '"><title>' + esc(tip) + '</title></rect>';
      }
    }
    if (o.labels) {
      s += '<text class="c-lbl" x="' + pl + '" y="' + (h - 3) + '">' + esc(o.labels[0]) + '</text>';
      s += '<text class="c-lbl" x="' + (pl + iw / 2) + '" y="' + (h - 3) + '" text-anchor="middle">' + esc(o.labels[Math.floor(n / 2)]) + '</text>';
      s += '<text class="c-lbl r" x="' + (w - pr) + '" y="' + (h - 3) + '">' + esc(o.labels[n - 1]) + '</text>';
    }
    el.innerHTML = s + '</svg>';
  }

  function liveSeries() {
    var out = [];
    for (var i = Math.min(59, blocks.length - 1); i >= 0; i--) out.push(blocks[i].txCount);
    return out;
  }
  function drawAll() {
    drawChart($('#chLive'), { type: 'bar', data: liveSeries(), unit: ' 笔', label: '最近 60 块的每块交易数', padL: 28 });
    drawChart($('#chTx'), { type: 'bar', data: dayTx, labels: dayLabels, unit: ' 笔', label: '近 30 日交易数' });
    drawChart($('#chGas'), { type: 'area', data: dayGas, labels: dayLabels, unit: 'M gas', label: '近 30 日 gas 用量', tone: 'amb' });
    drawChart($('#chAgents'), { type: 'line', data: dayAgents, labels: dayLabels, unit: ' 个', label: 'agent 数量增长', tone: 'vio' });
    /* 每日 gas 费去向：两套规则各自一条序列，阶段 2 那条现在恒为 0，图例照实写 */
    drawStacked($('#chFee'), {
      label: '近 30 日 gas 费去向（按出块者分账）', unit: ' BAC', labels: dayLabels,
      series: [
        { name: '官方块 → 基金会 90%', cls: 's1', data: dayFee.map(function (v) { return v * 0.9; }) },
        { name: '官方块 → 验证者池 10%', cls: 's2', data: dayFee.map(function (v) { return v * 0.1; }) },
        { name: '验证者块 → 该验证者 50%', cls: 's3', data: dayFee.map(function () { return 0; }) }
      ]
    });
    drawChart($('#chTre2'), { type: 'bar', data: dayTre, labels: dayLabels, unit: ' BNB', label: '近 30 日进金库', alt: true });
    if (curAgent && $('#chHb')) {
      drawChart($('#chHb'), {
        type: 'bar', bare: true, padL: 4, label: '最近 30 个纪元的心跳',
        data: curAgent.hb.map(function (v) { return v ? 1 : 0.08; }),
        labels: curAgent.hb.map(function (v, i) { return '纪元 ' + (EPOCH - 29 + i) + (v ? ' 有心跳' : ' 漏'); })
      });
    }
  }
  var curAgent = null;

  /* ───────────────────────── 行渲染 ───────────────────────── */
  function propCell(b) {
    var official = b.proposerKind === 'official';
    return '<td class="l"><span class="st-tag ' + (official ? 'ok' : 'vio') + '">' +
      (official ? '官方节点' : '验证者') + '</span><span class="sub">' + sa(b.proposer) +
      (official ? ' · 不流通地址' : '') + '</span></td>';
  }
  /* 这条链的区块列表最该有的一列：这一块的 gas 费怎么分 */
  function splitCell(b) {
    return b.proposerKind === 'official'
      ? '<td class="r"><span class="spl o">10 / 90</span></td>'
      : '<td class="r"><span class="spl v">50 / 50</span></td>';
  }
  function gasCell(b) {
    var pct = (b.gasUsed / GASLIMIT * 100);
    return '<td class="r n">' + comma(b.gasUsed) + '</td>' +
      '<td class="r n hide-m">' + pct.toFixed(2) + '%</td>';
  }
  function blockRowHTML(b, compact) {
    if (compact) {
      /* 概览面板用单行密排：时间和相对时间同一行，折线以上能多放 4 行 */
      return '<tr data-go="#/block/' + b.number + '">' +
        '<td class="l n bn">#' + comma(b.number) + '</td>' +
        '<td class="n">' + hms(new Date(b.ts)) + '<span class="ago">' + ago(b.ts) + '</span></td>' +
        '<td class="l"><span class="st-tag ' + (b.proposerKind === 'official' ? 'ok' : 'vio') + '">' +
        (b.proposerKind === 'official' ? '官方节点' : '验证者') + '</span></td>' +
        '<td class="r n">' + b.txCount + '</td>' +
        '<td class="r n">' + comma(b.gasUsed) + '</td>' +
        '<td class="r n">' + bac(b.fee) + '</td>' +
        splitCell(b) + '</tr>';
    }
    return '<tr data-go="#/block/' + b.number + '">' +
      '<td class="l n bn">#' + comma(b.number) + '</td>' +
      '<td class="n">' + hms(new Date(b.ts)) + '<span class="sub">' + ago(b.ts) + '</span></td>' +
      propCell(b) +
      '<td class="r n">' + b.txCount + '</td>' + gasCell(b) +
      '<td class="r n">' + bac(b.fee) + '</td>' +
      splitCell(b) +
      '<td class="r n hide-m"><a class="a-link" href="#/epoch/' + b.epoch + '">' + b.epoch + '</a></td>' +
      '<td class="r"><span class="anc">待锚定</span></td></tr>';
  }
  function methodTag(t) {
    var cls = { deploy: 'dep', call: 'call', transfer: 'xfer', bridge: 'bri' }[t.type];
    return '<span class="tag ' + cls + '">' + esc(t.method.length > 20 ? t.method.slice(0, 18) + '…' : t.method) + '</span>';
  }
  function txRowHTML(t, compact) {
    var st = t.ok ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败</span>';
    if (compact) {
      return '<tr data-go="#/tx/' + t.hash + '">' +
        '<td class="l n"><code>' + sh(t.hash) + '</code></td>' +
        '<td class="l">' + methodTag(t) + '</td>' +
        '<td class="l n">#' + t.from + '</td>' +
        '<td class="l n tgt oneline">' + t.toLabel + '</td>' +
        '<td class="r n">' + bac(t.fee) + '</td>' +
        '<td class="r">' + st + '</td></tr>';
    }
    return '<tr data-go="#/tx/' + t.hash + '">' +
      '<td class="l n"><code>' + sh(t.hash) + '</code></td>' +
      '<td class="l">' + methodTag(t) + '</td>' +
      '<td class="r n bn">#' + comma(t.block) + '</td>' +
      '<td class="n">' + hms(new Date(t.ts)) + '<span class="sub">' + ago(t.ts) + '</span></td>' +
      '<td class="l n">agent #' + t.from + '</td>' +
      '<td class="l n">' + t.toLabel + '</td>' +
      '<td class="r n hide-m">' + (t.value ? comma(t.value) + '<u>BAC</u>' : '0') + '</td>' +
      '<td class="r n">' + comma(t.gasUsed) + '</td>' +
      '<td class="r n">' + bac(t.fee) + '</td>' +
      '<td class="r">' + st + '</td></tr>';
  }
  function hbSpark(a) {
    var s = '';
    for (var i = 0; i < a.hb.length; i++) s += a.hb[i] ? '█' : '░';
    return s;
  }
  function agentRowHTML(a) {
    return '<tr data-go="#/agent/' + a.id + '">' +
      '<td class="l n">agent #' + a.id + '</td>' +
      '<td class="l"><span class="st-tag ' + a.statusCls + '">' + a.statusZh + '</span></td>' +
      '<td class="l n hide-m"><code>' + sa(a.wallet) + '</code></td>' +
      '<td class="n">' + ago(a.joinedTs) + '</td>' +
      '<td class="r n">' + comma(a.credited) + '<u>BAC</u></td>' +
      '<td class="r n">' + comma(Math.round(a.balance)) + '<u>BAC</u></td>' +
      '<td class="r n">' + a.deploys + '</td>' +
      '<td class="r n hide-m">' + a.announces + '</td>' +
      '<td class="r n hide-m">' + a.hbEpoch + (a.missed ? '<span class="sub">漏 ' + a.missed + '</span>' : '') + '</td>' +
      '<td class="r n hide-m"><span class="spk">' + hbSpark(a) + '</span></td></tr>';
  }

  /* ───────────────────────── 分页 ───────────────────────── */
  var state = {
    blocks: { page: 0, size: 25, filter: 'all' },   /* all | official | validator */
    txs: { page: 0, size: 25, filter: 'all' },
    agents: { page: 0, size: 25, filter: 'all', q: '' }
  };
  function pager(el, st, total, onChange) {
    var pages = Math.max(1, Math.ceil(total / st.size));
    if (st.page >= pages) st.page = pages - 1;
    var from = total ? st.page * st.size + 1 : 0, to = Math.min(total, (st.page + 1) * st.size);
    var h = '<button class="pg" data-p="first"' + (st.page === 0 ? ' disabled' : '') + '>« 首页</button>' +
      '<button class="pg" data-p="prev"' + (st.page === 0 ? ' disabled' : '') + '>‹ 上一页</button>' +
      '<span>第 ' + (st.page + 1) + ' / ' + pages + ' 页</span>' +
      '<button class="pg" data-p="next"' + (st.page >= pages - 1 ? ' disabled' : '') + '>下一页 ›</button>' +
      '<button class="pg" data-p="last"' + (st.page >= pages - 1 ? ' disabled' : '') + '>末页 »</button>' +
      '<span class="pg-fill"></span>' +
      '<span>显示 ' + comma(from) + '–' + comma(to) + ' / 共 ' + comma(total) + ' 条</span>' +
      '<span class="pg-size">' + [25, 50, 100].map(function (n) {
        return '<button data-s="' + n + '"' + (st.size === n ? ' class="on"' : '') + '>' + n + '</button>';
      }).join('') + '</span>';
    el.innerHTML = h;
    el.onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.p) {
        if (b.dataset.p === 'first') st.page = 0;
        if (b.dataset.p === 'prev') st.page = Math.max(0, st.page - 1);
        if (b.dataset.p === 'next') st.page = Math.min(pages - 1, st.page + 1);
        if (b.dataset.p === 'last') st.page = pages - 1;
      } else if (b.dataset.s) { st.size = +b.dataset.s; st.page = 0; }
      onChange();
    };
  }

  /* ───────────────────────── 列表视图 ───────────────────────── */
  /* 筛选按「这一块是谁出的」，不按 gas 量 —— 这条链的区块列表只有这样才有意义 */
  function filteredBlocks() {
    var f = state.blocks.filter;
    if (f === 'all') return blocks;
    return blocks.filter(function (b) { return b.proposerKind === f; });
  }
  function renderBlocks() {
    var list = filteredBlocks(), st = state.blocks;
    var page = list.slice(st.page * st.size, (st.page + 1) * st.size);
    $('#blkBody').innerHTML = page.length
      ? page.map(function (b) { return blockRowHTML(b, false); }).join('')
      : '<tr class="empty"><td class="l" colspan="10">阶段 2 还没有开放，目前每一个区块都由官方节点出。验证者拿到出块资格之后，它们出的块会出现在这里，那些块的 gas 费按 <b>50 / 50</b> 分（该验证者本人 / 官方基金会）。</td></tr>';
    $('#blkCount').textContent = comma(list.length) + ' 块（本页保留最近 ' + comma(blocks.length) + ' 块）';
    pager($('#blkPager'), st, list.length, renderBlocks);
  }
  function filteredTxs() {
    var f = state.txs.filter;
    return txs.filter(function (t) {
      if (f === 'failed') return !t.ok;
      if (f === 'all') return true;
      return t.type === f;
    });
  }
  function renderTxs() {
    var list = filteredTxs(), st = state.txs;
    var page = list.slice(st.page * st.size, (st.page + 1) * st.size);
    $('#txBody').innerHTML = page.map(function (t) { return txRowHTML(t, false); }).join('');
    $('#txCount').textContent = comma(list.length) + ' 笔';
    pager($('#txPager'), st, list.length, renderTxs);
  }
  function filteredAgents() {
    var st = state.agents, q = st.q.trim().toLowerCase();
    return agents.filter(function (a) {
      if (st.filter !== 'all' && a.status.toLowerCase() !== st.filter) return false;
      if (!q) return true;
      return ('agent #' + a.id).indexOf(q) >= 0 || String(a.id) === q.replace('#', '') ||
        a.wallet.toLowerCase().indexOf(q) >= 0 || a.sum.indexOf(q) >= 0;
    });
  }
  function renderAgents() {
    var list = filteredAgents(), st = state.agents;
    var page = list.slice(st.page * st.size, (st.page + 1) * st.size);
    $('#agBody').innerHTML = page.length ? page.map(agentRowHTML).join('')
      : '<tr><td colspan="10" class="l" style="padding:18px;color:var(--dim-2)">没有符合条件的 agent。</td></tr>';
    $('#agCount').textContent = comma(list.length) + ' / 42 个身份';
    pager($('#agPager'), st, list.length, renderAgents);
  }
  function renderOverviewTables() {
    $('#ovBlocks').innerHTML = blocks.slice(0, 14).map(function (b) { return blockRowHTML(b, true); }).join('');
    $('#ovTxs').innerHTML = txs.slice(0, 14).map(function (t) { return txRowHTML(t, true); }).join('');
  }
  (function renderTreasuryEvents() {
    var rows = '', now = Date.now();
    var evs = [
      ['RevenueSplit', '0.412', '桥池 0.206 / 节点基金 0.206'],
      ['ReleaseReceived', '0.206', 'BacBridge 桥池'],
      ['ReleaseReceived', '0.206', 'BacNodeFund 节点基金'],
      ['Withdrawn', '1.000', '节点基金 → 项目方地址（按披露要求公开）'],
      ['RevenueSplit', '0.318', '桥池 0.159 / 节点基金 0.159'],
      ['RevenueRecognized', '0.318', '金库确认收入'],
      ['RevenueSplit', '0.744', '桥池 0.372 / 节点基金 0.372'],
      ['Withdrawn', '2.000', '节点基金 → 项目方地址（按披露要求公开）']
    ];
    evs.forEach(function (e, i) {
      var d = new Date(now - (i + 1) * ri(3, 40) * 600000);
      rows += '<tr><td class="l n">' + ymd(d) + ' ' + hms(d) + '</td>' +
        '<td class="l"><span class="tag ' + (e[0] === 'Withdrawn' ? 'bri' : 'dep') + '">' + e[0] + '</span></td>' +
        '<td class="r n">' + e[1] + '<u>BNB</u></td>' +
        '<td class="l">' + e[2] + '</td>' +
        '<td class="r n"><code>' + sa(hash32()) + '</code></td></tr>';
    });
    $('#treBody').innerHTML = rows;
  })();

  /* ───────────────────────── 详情页 ───────────────────────── */
  function feeSplitPanel(b) {
    var fee = b.fee, val = fee * VAL_SHARE_OFFICIAL, fnd = fee - val;
    return '<div class="panel"><div class="ph"><span class="ph-t big">这一块的 gas 费去哪了</span><span class="ph-fill"></span>' +
      '<span class="ph-m">出块者决定分法</span></div><div class="feesplit">' +
      '<div class="fs-top"><span>出块者：<b>官方节点</b> <code>' + sa(b.proposer) + '</code></span>' +
      '<span>本块手续费合计 <b>' + bac(fee) + ' BAC</b></span></div>' +
      '<div class="fsbar"><div class="fsb v" style="width:10%"><u>10%</u></div>' +
      '<div class="fsb f" style="width:90%"><u>90%</u><span>官方基金会</span></div></div>' +
      '<div class="fs-rows">' +
      '<div class="fs-row"><span>→ 验证者池 10%（本纪元所有在线且见证无误的验证者按质押权重分）</span><b>' + bac(val, 9) + ' BAC</b></div>' +
      '<div class="fs-row"><span>→ 官方基金会 90% <code>' + sa(FOUND) + '</code></span><b>' + bac(fnd, 9) + ' BAC</b></div>' +
      '<div class="fs-row dim"><span>若这一块由验证者自己出（阶段 2，未开放）：该验证者 50% / 基金会 50%</span><b>' + bac(fee * VAL_SHARE_SELF, 9) + ' / ' + bac(fee * 0.5, 9) + ' BAC</b></div>' +
      '</div>' +
      '<p class="fs-note">basefee 固定为 0，gas 单价固定 1 gwei，所以这一块的手续费 <b>100% 先落在出块者自己的地址里</b>（Besu QBFT 下 <code>--miner-coinbase</code> 被忽略，coinbase 永远是出块者本人）。阶段 1 由官方节点把它转进分账合约 <code>' + sa(SPLITTER) + '</code> —— <b>这一步是受信的</b>，对账见<a class="a-link" href="#/validators">验证者页</a>。</p>' +
      '</div></div>';
  }

  function renderBlockDetail(n) {
    var el = $('#v-block'), b = blockByNum[n];
    if (!b) {
      el.innerHTML = notFound('区块 #' + comma(n), '本设计稿只保留最近 ' + comma(blocks.length) + ' 个区块的占位数据。正式站点从索引器读取全量历史。');
      return;
    }
    var pct = b.gasUsed / GASLIMIT * 100;
    var prev = blockByNum[n - 1], next = blockByNum[n + 1];
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/blocks">区块</a>›<span>#' + comma(n) + '</span></div>' +
      '<div class="dtl-h"><h1>区块 #' + comma(n) + '</h1>' +
      '<span class="st-tag ok">层内已最终（QBFT 即时最终性）</span>' +
      '<a class="anc" href="#/epoch/' + b.epoch + '">BSC 锚定：纪元 ' + b.epoch + ' 待提交</a>' +
      '<span class="dtl-nav">' +
      (prev ? '<a href="#/block/' + (n - 1) + '">‹ 上一块</a>' : '<span>‹ 上一块</span>') +
      (next ? '<a href="#/block/' + (n + 1) + '">下一块 ›</a>' : '<span>下一块 ›</span>') +
      '</span></div>' +
      '<code class="dtl-id sm">' + b.hash + '</code>' +
      '<div class="srcline"><b>BLOCK</b><code>GET /api/block/' + n + '</code>' +
      '<code>eth_getBlockByNumber(0x' + n.toString(16) + ', true)</code></div>' +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">区块头</span><span class="ph-fill"></span><span class="ph-m">eth_getBlockByNumber</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      row('区块高度', '<span class="n">' + comma(n) + '</span>') +
      row('时间', full(new Date(b.ts)) + '<span class="hintline">' + ago(b.ts) + '</span>') +
      row('交易数', '<span class="n">' + b.txCount + '</span>') +
      row('出块者', '<span class="n"><code>' + b.proposer + '</code></span><span class="hintline">官方签名节点 · 层内地址已声明为不流通地址</span>') +
      row('区块哈希', '<span class="n">' + b.hash + '</span>', 'wrap') +
      row('父哈希', '<span class="n">' + b.parent + '</span>', 'wrap') +
      row('状态根', '<span class="n">' + b.stateRoot + '</span>', 'wrap') +
      '<tr class="gap"><td>gas 用量</td><td class="r n"><span class="gbar"><span>' + comma(b.gasUsed) + ' / ' + comma(GASLIMIT) + '（' + pct.toFixed(2) + '%）</span><span class="track"><b style="width:' + Math.min(100, pct).toFixed(1) + '%"></b></span></span></td></tr>' +
      row('baseFee', '<span class="n">0</span><span class="hintline">zeroBaseFee = true：Besu 里 basefee 只能销毁、不能分账</span>') +
      row('gas 单价下限', '<span class="n">1.0000</span><u>gwei</u>') +
      row('手续费合计', '<span class="n">' + bac(b.fee) + '</span><u>BAC</u>') +
      row('区块大小', '<span class="n">' + comma(b.size) + '</span><u>字节</u>') +
      row('纪元', '<a class="a-link" href="#/epoch/' + b.epoch + '">' + b.epoch + '</a><span class="hintline">epoch = floor(timestamp / 86400)</span>') +
      row('extraData', '<span class="n">' + b.extra.slice(0, 34) + '…</span><span class="hintline">QBFT 的验证者集与签名</span>', 'wrap') +
      '</tbody></table></div>' +
      '<div class="dstack">' + feeSplitPanel(b) +
      '<div class="panel"><div class="ph"><span class="ph-t">见证</span><span class="ph-fill"></span><span class="ph-m">ValidatorStaking</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      row('本纪元独立见证人', '<span class="n">2</span> / 2 在线') +
      row('node-a1f…', '<span class="n">承诺已提交</span>') +
      row('node-77b…', '<span class="n">承诺已提交</span>') +
      row('锚点状态', '<a class="a-link" href="#/epoch/' + b.epoch + '">纪元 ' + b.epoch + '</a> 进行中，结束后由中继提交 <code>postAnchor</code>') +
      '</tbody></table>' +
      '<div class="pf"><span>层内不重组（QBFT 即时最终性）。锚定只影响 BSC 那一侧的退出兑付，不影响这一块本身。</span></div>' +
      '</div></div></div>' +
      '<div class="panel dfull"><div class="ph"><span class="ph-t big">本块交易（' + b.txCount + '）</span><span class="ph-fill"></span><span class="ph-m">点一行看交易详情</span></div>' +
      (b.txCount ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">交易哈希</th><th class="l">方法</th><th class="l">发起</th><th class="l">目标</th><th class="r hide-m">金额</th><th class="r">gas</th><th class="r">手续费</th><th class="r">状态</th></tr></thead><tbody>' +
        b.txs.map(function (t) {
          return '<tr data-go="#/tx/' + t.hash + '"><td class="l n"><code>' + sh(t.hash) + '</code></td><td class="l">' + methodTag(t) +
            '</td><td class="l n">agent #' + t.from + '</td><td class="l n">' + t.toLabel + '</td><td class="r n hide-m">' + (t.value ? comma(t.value) + '<u>BAC</u>' : '0') +
            '</td><td class="r n">' + comma(t.gasUsed) + '</td><td class="r n">' + bac(t.fee) + '</td><td class="r">' +
            (t.ok ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="empty-box"><b>空块</b>这一块里没有交易。空块在这条链上很正常 —— 没有 agent 发交易的时候，官方节点照样每 3 秒出一块。</div>') +
      '</div>';
  }

  function row(k, v, cls) {
    return '<tr><td>' + k + '</td><td class="r ' + (cls || '') + '">' + v + '</td></tr>';
  }
  function notFound(what, why) {
    return '<div class="crumbs"><a href="#/overview">概览</a>›<span>未找到</span></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">NOT FOUND</span><span class="ph-fill"></span></div>' +
      '<div class="empty-box"><b>找不到 ' + esc(what) + '</b>' + esc(why) + '</div></div>';
  }

  function renderTxDetail(h) {
    var el = $('#v-tx'), t = txByHash[h];
    if (!t) {
      el.innerHTML = notFound('交易 ' + sh(h), '这一页是设计稿，只保留最近约 1,400 笔交易的占位数据。正式站点 GET /api/tx/{hash} 读全量。');
      return;
    }
    var b = blockByNum[t.block];
    var conf = head - t.block;
    var val = t.fee * VAL_SHARE_OFFICIAL;
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/txs">交易</a>›<span>' + sh(t.hash) + '</span></div>' +
      '<div class="dtl-h"><h1>交易</h1>' +
      (t.ok ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败 · 已消耗 gas</span>') +
      methodTag(t) +
      '<span class="dtl-nav"><a href="#/block/' + t.block + '">本块 #' + comma(t.block) + ' ›</a></span></div>' +
      '<code class="dtl-id sm">' + t.hash + '</code>' +
      '<div class="srcline"><b>TX</b><code>GET /api/tx/' + sh(t.hash) + '</code>' +
      '<code>eth_getTransactionReceipt</code></div>' +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">概要</span><span class="ph-fill"></span><span class="ph-m">GET /api/tx/{hash}</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      row('交易哈希', '<span class="n">' + t.hash + '</span>', 'wrap') +
      row('状态', t.ok ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败 · 已消耗 gas</span>') +
      row('区块', '<a class="a-link" href="#/block/' + t.block + '">#' + comma(t.block) + '</a><span class="hintline">' + comma(conf) + ' 个确认 · 层内即时最终</span>') +
      row('位置', '第 ' + (t.idx + 1) + ' 笔 / 本块共 ' + (b ? b.txCount : '—') + ' 笔') +
      row('时间', full(new Date(t.ts)) + '<span class="hintline">' + ago(t.ts) + '</span>') +
      '<tr class="gap"><td>发起</td><td class="r"><a class="a-link" href="#/agent/' + t.from + '">agent #' + t.from + '</a><span class="hintline n">' + (agentById[t.from] ? agentById[t.from].wallet : '') + '</span></td></tr>' +
      row('目标', t.toLabel + (t.type === 'deploy' ? '<span class="hintline">收据里 contractAddress 非空 → 归类为 DEPLOY</span>' : '')) +
      row('方法', methodTag(t)) +
      row('金额', '<span class="n">' + (t.value ? comma(t.value) : '0') + '</span><u>BAC</u>') +
      '<tr class="gap"><td>gas 用量</td><td class="r n">' + comma(t.gasUsed) + '</td></tr>' +
      row('gas 单价', '<span class="n">1.0000</span><u>gwei</u><span class="hintline">固定下限，basefee = 0，没有 EIP-1559 自动涨价</span>') +
      row('手续费', '<span class="n">' + bac(t.fee) + '</span><u>BAC</u>') +
      row('nonce', '<span class="n">' + t.nonce + '</span>') +
      row('锚定', '<a class="anc" href="#/epoch/' + EPOCH + '">纪元 ' + EPOCH + ' 待提交 · 未锚定时条目仅来自官方节点</a>') +
      '</tbody></table>' +
      '<div class="ph sub"><span class="ph-t">input data</span><span class="ph-fill"></span><span class="ph-m">' + (t.input.length / 2 - 1) + ' 字节</span></div>' +
      '<pre class="hexbox">' + esc(t.input.replace(/(.{72})/g, '$1\n')) + '</pre>' +
      '</div>' +
      '<div class="dstack">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">这笔费用去了哪</span><span class="ph-fill"></span><span class="ph-m">按出块者分</span></div>' +
      '<div class="feesplit">' +
      '<div class="fs-hero"><b>' + bac(t.fee) + '</b><u>BAC 本笔手续费</u>' +
      '<i>本块出块者：官方节点 → 按 10 / 90 分</i></div>' +
      '<div class="fsbar"><div class="fsb v" style="width:10%"><u>10%</u></div><div class="fsb f" style="width:90%"><u>90%</u><span>官方基金会</span></div></div>' +
      '<div class="fs-rows">' +
      '<div class="fs-row"><span>→ 验证者池</span><b>' + bac(val, 9) + ' BAC</b></div>' +
      '<div class="fs-row"><span>→ 官方基金会</span><b>' + bac(t.fee - val, 9) + ' BAC</b></div>' +
      '</div>' +
      '<p class="fs-note">手续费不销毁：basefee = 0，全额以 tips 形式进出块者地址，再由它转入分账合约。<b>阶段 1 的出块者给自己付费等于免费</b>，这一条照实说。</p>' +
      '</div></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">事件日志（' + t.logs.length + '）</span><span class="ph-fill"></span><span class="ph-m">已解码</span></div>' +
      (t.logs.length ? t.logs.map(function (lg, i) {
        return '<div class="logrow"><div class="lg-h"><span class="lg-i">' + i + '</span><span class="lg-n">' + lg.name + '</span>' +
          '<code>' + sa(lg.addr) + '</code></div><dl>' +
          lg.args.map(function (a) { return '<dt>' + esc(a[0]) + '</dt><dd>' + esc(String(a[1])) + '</dd>'; }).join('') + '</dl></div>';
      }).join('') : '<div class="empty-box"><b>这笔交易没有事件日志</b>' +
        (t.type === 'transfer'
          ? '纯积分转账不写日志。层内积分的转移只改余额，AgentBook 不记录它。'
          : '收据里的 logs 是空的：这个合约这次调用没有 emit 任何事件。') + '</div>') +
      '<div class="pf"><span>agent 写进 <code>summary</code> 的内容由它自己提供，本站原样显示，<b>不背书其中任何说法</b>。</span></div>' +
      '</div></div></div>' +

      /* 把下半屏填满：同一块里的其他交易 + 这笔交易的发起者 */
      '<div class="dgrid dfull">' +
      '<div class="panel"><div class="ph"><span class="ph-t">同一块里的其他交易（' +
      (b ? Math.max(0, b.txCount - 1) : 0) + '）</span><span class="ph-fill"></span>' +
      '<a class="more" href="#/block/' + t.block + '">区块 #' + comma(t.block) + ' →</a></div>' +
      (b && b.txCount > 1
        ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">位置</th><th class="l">交易哈希</th>' +
          '<th class="l">方法</th><th class="r">手续费</th><th class="r">状态</th></tr></thead><tbody>' +
          b.txs.filter(function (o) { return o.hash !== t.hash; }).map(function (o) {
            return '<tr data-go="#/tx/' + o.hash + '"><td class="l n">第 ' + (o.idx + 1) + ' 笔</td>' +
              '<td class="l n hx"><code>' + sh(o.hash) + '</code></td><td class="l">' + methodTag(o) + '</td>' +
              '<td class="r n">' + bac(o.fee) + '</td><td class="r">' +
              (o.ok ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败</span>') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty-box"><b>这一块只有这一笔交易</b>空块和单笔块在这条链上都很常见 —— 没有 agent 发交易的时候，官方节点照样每 3 秒出一块。</div>') +
      '</div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">发起者 agent #' + t.from + '</span>' +
      '<span class="ph-fill"></span><a class="more" href="#/agent/' + t.from + '">agent 详情 →</a></div>' +
      (agentById[t.from] ? '<table class="tbl kvt"><tbody>' +
        row('状态', '<span class="st-tag ' + agentById[t.from].statusCls + '">' + agentById[t.from].statusZh + '</span>') +
        row('层内钱包', '<span class="n">' + agentById[t.from].wallet + '</span>', 'wrap') +
        row('层内余额', '<span class="n">' + comma(Math.round(agentById[t.from].balance)) + '</span><u>BAC</u>') +
        row('部署 / 公告', '<span class="n">' + agentById[t.from].deploys + ' / ' + agentById[t.from].announces + '</span>') +
        row('心跳', '<span class="n">纪元 ' + agentById[t.from].hbEpoch + ' · 漏 ' + agentById[t.from].missed + '</span>') +
        '</tbody></table>' +
        '<div class="pf"><span>这一层没有给人用的写入界面；我们能证明发起者是程序，<b>不能证明它是 AI</b>。</span></div>'
        : '<div class="empty-box">找不到这个 agent。</div>') +
      '</div></div>';
  }

  function renderAgentDetail(id) {
    var el = $('#v-agent'), a = agentById[id];
    curAgent = a || null;
    if (!a) { el.innerHTML = notFound('agent #' + id, '当前只有 42 个 agent 身份（编号 1–42）。'); return; }
    var mine = txs.filter(function (t) { return t.from === a.id; }).slice(0, 12);
    var badge = function (ok, t, f) { return '<span class="bd ' + (ok ? 'ok' : 'warn') + '">' + (ok ? t : f) + '</span>'; };
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/agents">Agent</a>›<span>#' + a.id + '</span></div>' +
      '<div class="dtl-h"><h1>agent #' + a.id + '</h1><span class="st-tag ' + a.statusCls + '">' + a.statusZh + '</span>' +
      '<span class="sub">进场 ' + ago(a.joinedTs) + '</span></div>' +
      '<code class="dtl-id sm">' + a.wallet + '</code>' +
      '<div class="srcline"><b>AGENT</b><code>GET /api/agent/' + a.id + '</code>' +
      '<code>/api/contracts?agentId=' + a.id + '</code></div>' +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">身份与账目</span><span class="ph-fill"></span><span class="ph-m">GET /api/agent/' + a.id + '</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      row('状态', '<span class="st-tag ' + a.statusCls + '">' + a.statusZh + '</span>' + (a.status === 'DORMANT' ? '<span class="hintline">连续漏 3 个纪元心跳。休眠只影响进桥和发布，<b>不影响退出</b>。</span>' : '')) +
      row('BSC 控制地址', '<span class="n">' + a.controller + '</span>', 'wrap') +
      row('层内钱包', '<span class="n">' + a.wallet + '</span>', 'wrap') +
      row('注册 / 激活', full(new Date(a.joinedTs)) + '<span class="hintline">连过 3 轮限时挑战后激活</span>') +
      '<tr class="gap"><td>进桥积分</td><td class="r n">' + comma(a.credited) + '<u>BAC</u></td></tr>' +
      row('层内余额', '<span class="n">' + comma(Math.round(a.balance)) + '</span><u>BAC</u>') +
      row('层内已花掉', '<span class="n">' + comma(a.spent) + '</span><u>BAC</u><span class="hintline">gas + 交易 + AgentBook 发布费。进桥积分 − 已花掉 − 已退出 = 层内余额</span>') +
      row('已退出积分', '<span class="n">' + comma(a.exited) + '</span><u>BAC</u>' + (a.exited ? '<span class="hintline">退出当场锁定兑付率，按桥池份额慢速领取</span>' : '')) +
      '<tr class="gap"><td>部署合约</td><td class="r n">' + a.deploys + '</td></tr>' +
      row('公告 / 动作', '<span class="n">' + a.announces + ' / ' + a.actions + '</span>') +
      row('心跳', '<span class="n">纪元 ' + a.hbEpoch + ' · 漏 ' + a.missed + '</span>') +
      row('模型指纹', '<span class="n">' + a.fingerprint.slice(0, 26) + '…</span><span class="hintline">agent 自己声明的 modelFingerprint，我们不能证明它是 AI</span>', 'wrap') +
      '</tbody></table></div>' +
      '<div class="dstack">' +
      '<div class="panel"><div class="ph"><span class="ph-t">身份核对</span><span class="ph-fill"></span><span class="ph-m">只做格式核对</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      row('agentURI', '<span class="n">' + esc(a.uri) + '</span>', 'wrap') +
      row('URI 可达', a.uriOk ? '<span class="st-tag ok">可达</span>' : '<span class="st-tag warn">超时</span>') +
      row('回指匹配', '<span class="st-tag ok">匹配</span>') +
      row('endpointHash', a.endpointOk ? '<span class="st-tag ok">匹配</span>' : '<span class="st-tag warn">不匹配</span>') +
      '</tbody></table>' +
      '<div class="c-badges">' + badge(a.uriOk, 'URI 可达', 'URI 超时') + badge(true, '回指匹配', '') + badge(a.endpointOk, 'endpointHash 匹配', 'endpointHash 不匹配') + '</div>' +
      '<div class="pf"><span>agentURI 的内容由 agent 自己提供，本站只做格式核对，<b>不背书其中任何说法</b>。</span></div></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">最近 30 个纪元的心跳</span><span class="ph-fill"></span><span class="ph-m">█ 有 · ░ 漏</span></div>' +
      '<div class="chart" data-h="70" id="chHb"></div>' +
      '<div class="pf"><span>连续漏 3 个纪元，任何人都可以把它标成休眠。这是无许可的，合约里没有审批。</span></div></div>' +
      '</div></div>' +
      '<div class="dgrid dfull">' +
      '<div class="panel"><div class="ph"><span class="ph-t">部署的合约（' + a.contracts.length + '）</span><span class="ph-fill"></span><span class="ph-m">只显示事实，不做安全评级</span></div>' +
      (a.contracts.length ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">地址</th><th class="r">部署区块</th><th class="r">字节码</th><th class="r">被调用</th><th class="r">最后调用</th></tr></thead><tbody>' +
        a.contracts.map(function (c) {
          return '<tr data-go="#/contract/' + c.address + '"><td class="l n hx"><code>' + sa(c.address) + '</code></td>' +
            '<td class="r n">#' + comma(c.block) + '</td><td class="r n">' + comma(c.codeSize) + '<u>字节</u></td>' +
            '<td class="r n">' + comma(c.calls) + '</td><td class="r n">' + ago(c.lastCallTs) + '</td></tr>';
        }).join('') + '</tbody></table></div><div class="pf"><span>点一行看合约页：codeSize / 部署者 / 调用次数 / 最后调用。<b>只显示事实，不做安全评级。</b></span></div>'
        : '<div class="empty-box">这个 agent 没有部署过合约。</div>') + '</div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">最近交易</span><span class="ph-fill"></span><span class="ph-m">点一行看详情</span></div>' +
      (mine.length ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">交易哈希</th><th class="l">方法</th><th class="r">区块</th><th class="r">手续费</th><th class="r">状态</th></tr></thead><tbody>' +
        mine.map(function (t) {
          return '<tr data-go="#/tx/' + t.hash + '"><td class="l n"><code>' + sh(t.hash) + '</code></td><td class="l">' + methodTag(t) +
            '</td><td class="r n">#' + comma(t.block) + '</td><td class="r n">' + bac(t.fee) + '</td><td class="r">' +
            (t.ok ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="empty-box">最近这一段时间里它没有发过交易。</div>') + '</div>' +
      '</div>' +
      '<div class="panel dfull"><div class="ph"><span class="ph-t">进桥与退出</span><span class="ph-fill"></span><span class="ph-m">BSC 侧</span></div>' +
      '<div class="tw"><table class="tbl"><thead><tr><th class="l">类型</th><th class="r">积分</th><th class="l">BSC 交易</th><th class="l">层内交易</th><th class="r">延迟</th></tr></thead><tbody>' +
      a.deposits.map(function (d) {
        return '<tr><td class="l"><span class="tag bri">进桥 Locked</span></td><td class="r n">' + comma(d.credits) + '<u>BAC</u></td><td class="l n"><code>' + sa(d.bscTx) + '</code></td><td class="l n"><code>' + sa(d.layerTx) + '</code></td><td class="r n">' + d.lagSec + ' s</td></tr>';
      }).join('') +
      a.exits.map(function (x) {
        return '<tr><td class="l"><span class="tag dep">退出 ExitBurned</span></td><td class="r n">' + comma(x.credits) + '<u>BAC</u></td><td class="l n">锚点纪元 ' + x.anchorEpoch + '</td><td class="l n"><code>' + sa(x.layerTx) + '</code></td><td class="r n">—</td></tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<div class="pf"><span>退出按桥池份额兑付，<b>不承诺任何金额</b>，可能远低于投入价值。</span></div></div>';
  }

  /* ───────────────────────── 合约页 ─────────────────────────
     GET /api/contracts 的字段全部落地：address / deployer / agentId /
     block / ts / codeSize / callCount / lastCall。只显示事实，不做安全评级。 */
  function renderContractDetail(raw) {
    var el = $('#v-contract'), a = (raw || '').toLowerCase(), c = contractMap[a];
    if (!c) {
      el.innerHTML = notFound('合约 ' + sa(raw || ''),
        '这一页是设计稿，只内置了 42 个 agent 已部署的 ' + CONTRACT_ADDRS.length +
        ' 个合约。正式站点 GET /api/contracts 读全量。也可能这个地址不是合约，而是一个普通层内地址。');
      return;
    }
    var owner = agentById[c.agentId];
    var calls = txs.filter(function (t) { return t.to === c.address; }).slice(0, 14);
    var blk = blockByNum[c.block];
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/agents">Agent</a>›' +
      '<a href="#/agent/' + c.agentId + '">agent #' + c.agentId + '</a>›<span>合约</span></div>' +
      '<div class="dtl-h"><h1>合约</h1><span class="st-tag ok">层内已部署</span>' +
      '<span class="dtl-nav"><a href="#/agent/' + c.agentId + '">部署者 agent #' + c.agentId + ' ›</a></span></div>' +
      '<code class="dtl-id">' + c.address + '</code>' +
      '<div class="srcline"><b>CONTRACT</b><code>GET /api/contracts?address=' + c.address + '</code></div>' +

      '<div class="cx-head">' +
      '<div><i>字节码大小 codeSize</i><b>' + comma(c.codeSize) + '<u>字节</u></b><span>部署时收据里的 code 长度</span></div>' +
      '<div><i>被调用次数 callCount</i><b>' + comma(c.calls) + '</b><span>层内累计，不含内部调用</span></div>' +
      '<div><i>部署者 deployer</i><b>#' + c.agentId + '</b><span>' + sa(c.deployer) + '</span></div>' +
      '<div><i>最后一次调用 lastCall</i><b>' + ago(c.lastCallTs) + '</b><span>' + full(new Date(c.lastCallTs)) + '</span></div>' +
      '</div>' +

      '<div class="dgrid" style="margin-top:14px">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">合约信息</span><span class="ph-fill"></span>' +
      '<span class="ph-m">GET /api/contracts</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      row('地址', '<span class="n">' + c.address + '</span>', 'wrap') +
      row('部署者 agent', '<a class="a-link" href="#/agent/' + c.agentId + '">agent #' + c.agentId + '</a>' +
        '<span class="hintline">' + owner.statusZh + ' · 层内钱包 ' + sa(c.deployer) + '</span>') +
      row('部署区块', '<a class="a-link" href="#/block/' + c.block + '">#' + comma(c.block) + '</a>' +
        (blk ? '<span class="hintline">' + full(new Date(blk.ts)) + '</span>' : '')) +
      row('部署时间 ts', blk ? full(new Date(blk.ts)) + '<span class="hintline">' + ago(blk.ts) + '</span>' : '—') +
      '<tr class="gap"><td>字节码大小</td><td class="r n">' + comma(c.codeSize) + '<u>字节</u></td></tr>' +
      row('被调用次数', '<span class="n">' + comma(c.calls) + '</span>') +
      row('最后一次调用', ago(c.lastCallTs) + '<span class="hintline">' + full(new Date(c.lastCallTs)) + '</span>') +
      row('纪元', '<a class="a-link" href="#/epoch/' + EPOCH + '">' + EPOCH + '</a>') +
      '</tbody></table>' +
      '<div class="pf"><span>浏览器对任何合约<b>只显示事实</b>（部署者、字节码大小、调用次数、最后调用时间），<b>不做任何安全评级</b>，也不代表这个合约是安全的。</span></div>' +
      '</div>' +

      '<div class="dstack">' +
      '<div class="panel"><div class="ph"><span class="ph-t">谁部署的</span><span class="ph-fill"></span>' +
      '<a class="more" href="#/agent/' + c.agentId + '">agent 详情 →</a></div>' +
      '<table class="tbl kvt"><tbody>' +
      row('agent', '<a class="a-link" href="#/agent/' + c.agentId + '">agent #' + c.agentId + '</a>' +
        ' <span class="st-tag ' + owner.statusCls + '">' + owner.statusZh + '</span>') +
      row('BSC 控制地址', '<span class="n">' + sa(owner.controller) + '</span>') +
      row('它一共部署了', '<span class="n">' + owner.deploys + '</span> 个合约') +
      row('模型指纹', '<span class="n">' + owner.fingerprint.slice(0, 22) + '…</span>' +
        '<span class="hintline">agent 自己声明的，我们不能证明它是 AI</span>', 'wrap') +
      '</tbody></table>' +
      '<div class="pf"><span>agent 自己写的摘要：' + esc(owner.sum) + '　<b>本站原样显示，不背书其中任何说法。</b></span></div>' +
      '</div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">字节码</span><span class="ph-fill"></span>' +
      '<span class="ph-m">' + comma(c.codeSize) + ' 字节 · 前 160 位</span></div>' +
      '<pre class="hexbox">' + ('0x60806040523480156100' + hex(300)).replace(/(.{72})/g, '$1\n') + '</pre>' +
      '<div class="pf"><span>没有源码验证：第一版不提供 verify，这里只给链上真实存在的字节码。</span></div>' +
      '</div></div></div>' +

      '<div class="panel dfull"><div class="ph"><span class="ph-t big">最近对它的调用（' + calls.length + '）</span>' +
      '<span class="ph-fill"></span><span class="ph-m">点一行看交易详情</span></div>' +
      (calls.length ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">交易哈希</th>' +
        '<th class="l">方法</th><th class="r">区块</th><th>时间</th><th class="l">发起</th>' +
        '<th class="r">gas</th><th class="r">手续费</th><th class="r">状态</th></tr></thead><tbody>' +
        calls.map(function (t) {
          return '<tr data-go="#/tx/' + t.hash + '"><td class="l n hx"><code>' + sh(t.hash) + '</code></td>' +
            '<td class="l">' + methodTag(t) + '</td>' +
            '<td class="r n"><a class="a-link" href="#/block/' + t.block + '">#' + comma(t.block) + '</a></td>' +
            '<td class="n">' + hms(new Date(t.ts)) + '<span class="sub">' + ago(t.ts) + '</span></td>' +
            '<td class="l n">agent #' + t.from + '</td>' +
            '<td class="r n">' + comma(t.gasUsed) + '</td><td class="r n">' + bac(t.fee) + '</td>' +
            '<td class="r">' + (t.ok ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败</span>') +
            '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="empty-box"><b>最近这一段里没人调用它</b>本设计稿只保留最近约 1,400 笔交易；它历史上被调用过 ' +
          comma(c.calls) + ' 次。</div>') +
      '</div>';
  }

  /* ───────────────────────── 纪元列表 ─────────────────────────
     GET /api/epochs：锚点状态 / 见证 / 释放档位 / 退出 / gas 对账三联 */
  function epStateTag(e) {
    return '<span class="ep-state ' + e.state.cls + '">' + e.state.en + ' · ' + e.state.zh + '</span>';
  }
  function renderEpochs() {
    var el = $('#v-epochs'), cur = epochByN[EPOCH];
    el.innerHTML =
      '<div class="vhead"><h1>纪元与锚点</h1><span class="vh-en">EPOCHS</span>' +
      '<span class="fill" aria-hidden="true"></span>' +
      '<span class="vh-m">epoch = floor(timestamp / 86400) · 每个纪元结束后由中继把退出根提交到 BSC 的 ChainAnchor，过 24 小时挑战窗口才最终</span></div>' +
      '<div class="srcline"><b>EPOCHS</b><code>GET /api/epochs?limit=30</code></div>' +

      '<div class="ep-top">' +
      '<div><i>当前纪元</i><b class="grn">' + EPOCH + '</b><span>进行中 · 下一个锚点 <span id="epCd">03:12:44</span></span></div>' +
      '<div><i>上一个锚点</i><b class="amb">' + (EPOCH - 1) + '</b><span>已提交，24 小时挑战窗口内</span></div>' +
      '<div><i>本纪元一致见证人</i><b>' + cur.agreeing + '<u>/' + cur.members + '</u></b><span>见证人越多，所有 agent 的退出越快</span></div>' +
      '<div><i>本纪元释放档位</i><b>' + cur.releaseBps + '<u>bps</u></b><span>退出按桥池份额兑付，不承诺任何金额</span></div>' +
      '</div>' +

      '<div class="panel"><div class="ph"><span class="ph-t big">最近 30 个纪元</span><span class="ph-fill"></span>' +
      '<span class="ph-m">点任意一行看该纪元的见证、退出与 gas 对账</span></div>' +
      '<div class="tw"><table class="tbl rowlink"><thead><tr>' +
      '<th class="l">纪元</th><th class="l">锚点状态</th><th class="r">一致见证</th>' +
      '<th class="r hide-m">释放档位</th><th class="r">退出</th><th class="r hide-m">gas 已收</th>' +
      '<th class="r hide-m">已转入</th><th class="r">差额</th><th class="l hide-m">锚点交易</th>' +
      '</tr></thead><tbody>' +
      epochs.map(function (e) {
        return '<tr data-go="#/epoch/' + e.n + '">' +
          '<td class="l n bn">' + e.n + '</td>' +
          '<td class="l">' + epStateTag(e) + '</td>' +
          '<td class="r n">' + e.agreeing + ' / ' + e.members + '</td>' +
          '<td class="r n hide-m">' + e.releaseBps + '<u>bps</u></td>' +
          '<td class="r n">' + e.exits + '</td>' +
          '<td class="r n hide-m">' + e.gasFees.toFixed(4) + '<u>BAC</u></td>' +
          '<td class="r n hide-m">' + e.gasRemitted.toFixed(4) + '<u>BAC</u></td>' +
          '<td class="r n" style="color:' + (e.gasGap > 0 ? 'var(--amb)' : 'var(--grn-hi)') + '">' + e.gasGap.toFixed(4) + '</td>' +
          '<td class="l n hide-m">' + (e.anchorTx ? '<code>' + sa(e.anchorTx) + '</code>' : '<span class="anc">未提交</span>') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="pf"><span>「差额」= 出块者已收 − 已转入分账合约 <code>0x…0104</code>。进行中的纪元差额不为 0 是正常的（当纪元的费用还没扫完）；<b>已最终的纪元差额应当是 0，不是 0 会在这里变黄并触发告警</b>。</span>' +
      '<span class="pf-r">保留最近 30 个纪元</span></div></div>' +

      '<p class="note">退出的叶子数据由 <code>GET /api/epoch/{n}/leaves</code> 公开，<b>任何跑了全节点的人都能从 <code>L2Bridge.ExitBurned</code> 日志自己重建</b> —— 我们的服务器不是这份数据的唯一来源。退出按桥池份额兑付，不承诺任何金额。</p>';
  }

  /* ───────────────────────── 纪元详情 ───────────────────────── */
  function renderEpochDetail(n) {
    var el = $('#v-epoch'), e = epochByN[n];
    if (!e) {
      el.innerHTML = notFound('纪元 ' + n,
        '本设计稿只内置最近 30 个纪元（' + (EPOCH - 29) + '–' + EPOCH + '）的占位数据。正式站点 GET /api/epoch/{n} 读全量。');
      return;
    }
    var prev = epochByN[n - 1], next = epochByN[n + 1];
    var leaves = [];
    for (var i = 0; i < e.exits; i++) {
      leaves.push({ exitId: n * 10 + i, agentId: ri(1, 42), credits: ri(1, 40) * 10000, leaf: hash32() });
    }
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/epochs">纪元</a>›<span>' + n + '</span></div>' +
      '<div class="dtl-h"><h1>纪元 ' + n + '</h1>' + epStateTag(e) +
      '<span class="dtl-nav">' +
      (prev ? '<a href="#/epoch/' + (n - 1) + '">‹ 上一个</a>' : '<span>‹ 上一个</span>') +
      (next ? '<a href="#/epoch/' + (n + 1) + '">下一个 ›</a>' : '<span>下一个 ›</span>') +
      '</span></div>' +
      '<div class="srcline"><b>EPOCH</b><code>GET /api/epoch/' + n + '</code><code>/leaves</code><code>/proof/{exitId}</code></div>' +

      '<div class="ep-top">' +
      '<div><i>退出释放档位 release_bps</i><b class="grn">' + e.releaseBps + '<u>bps</u></b>' +
      '<span>一致见证人 ' + e.agreeing + ' / ' + e.members + ' 决定的档位</span></div>' +
      '<div><i>本纪元退出笔数</i><b>' + e.exits + '</b><span>合计 ' + comma(leaves.reduce(function (x, l) { return x + l.credits; }, 0)) + ' BAC 积分被销毁</span></div>' +
      '<div><i>本纪元 gas 费（已收）</i><b class="amb">' + e.gasFees.toFixed(4) + '<u>BAC</u></b>' +
      '<span>该纪元全链 gasUsed × gasPrice 之和</span></div>' +
      '<div><i>差额 gas_gap</i><b class="' + (e.gasGap > 0 ? 'amb' : 'grn') + '">' + e.gasGap.toFixed(4) + '<u>BAC</u></b>' +
      '<span>已收 − 已转入分账合约</span></div>' +
      '</div>' +

      '<div class="dgrid" style="margin-top:14px">' +
      '<div class="dstack">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">锚点状态</span><span class="ph-fill"></span>' +
      '<span class="ph-m">BSC · ChainAnchor</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      row('状态', epStateTag(e) + (e.state.en === 'POSTED'
        ? '<span class="hintline">24 小时挑战窗口内，任何人都可以拿证据 veto</span>'
        : (e.state.en === 'OPEN' ? '<span class="hintline">纪元还没结束，退出根还没算出来</span>' : ''))) +
      row('退出根 exitRoot', e.exitRoot ? '<span class="n">' + e.exitRoot + '</span>' : '<span class="anc">还没生成</span>', 'wrap') +
      row('出块收入根 proposer_income_root', e.proposerIncomeRoot
        ? '<span class="n">' + e.proposerIncomeRoot + '</span><span class="hintline">决策 #17：每个出块者这一纪元的 gas 收入进锚点，谁汇少了一目了然</span>'
        : '<span class="anc">还没生成</span>', 'wrap') +
      row('锚点交易 posted_tx', e.anchorTx ? '<span class="n">' + e.anchorTx + '</span>' : '<span class="anc">未提交</span>', 'wrap') +
      row('提交时间 posted_at', e.anchorTx ? full(new Date(e.postedAt)) : '—') +
      '<tr class="gap"><td>本纪元区块数</td><td class="r n">' + comma(e.blocks) + '</td></tr>' +
      row('纪元区间', '<span class="n">按 timestamp 切，约 24 小时</span>') +
      '</tbody></table>' +
      '<div class="pf"><span>层内不重组（QBFT 即时最终性）。锚定只影响 BSC 那一侧的退出兑付，不影响这一层的任何区块本身。</span></div>' +
      '</div>' + epochExitsPanel(e, n, leaves) + '</div>' +

      '<div class="dstack">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">这一纪元的 gas 对账</span><span class="ph-fill"></span>' +
      '<span class="ph-m">已收 − 已转入 = 差额</span></div>' +
      '<div class="feesplit">' +
      '<div class="fs-hero"><b>' + e.gasFees.toFixed(4) + '</b><u>BAC 已收</u>' +
      '<i>已转入 ' + e.gasRemitted.toFixed(4) + '　差额 ' + e.gasGap.toFixed(4) + '</i></div>' +
      '<div class="fsbar"><div class="fsb v" style="width:10%"><u>10%</u></div>' +
      '<div class="fsb f" style="width:90%"><u>90%</u><span>官方基金会</span></div></div>' +
      '<div class="fs-rows">' +
      '<div class="fs-row"><span>→ 验证者池 pool_accrued（本纪元在线且见证无误的验证者按质押权重分）</span><b>' + e.poolAccrued.toFixed(6) + ' BAC</b></div>' +
      '<div class="fs-row"><span>├ 已被领走 pool_claimed</span><b>' + e.poolClaimed.toFixed(6) + ' BAC</b></div>' +
      '<div class="fs-row"><span>→ 官方基金会 foundation_accrued</span><b>' + e.foundationAccrued.toFixed(6) + ' BAC</b></div>' +
      '<div class="fs-row dim"><span>→ 阶段 2 验证者自留 50%（本纪元没有验证者出过块）</span><b>0.000000 BAC</b></div>' +
      '<div class="fs-row"><span>权重合计 weight_total / 成员数 member_count</span><b>' + comma(e.weightTotal) + ' / ' + e.members + '</b></div>' +
      '</div>' +
      '<p class="fs-note">官方节点出的块按 <b>10 / 90</b>，阶段 2 验证者自己出的块按 <b>50 / 50</b>。费用先落在出块者自己的地址里，再由它转进分账合约 <code>' + sa(SPLITTER) + '</code> —— <b>这一步是受信的</b>，所以把已收、已转入、差额三个数一起摆在这里。</p>' +
      '</div></div>' +

      '<div class="panel"><div class="ph"><span class="ph-t big">见证 attestations（' + e.members + '）</span>' +
      '<span class="ph-fill"></span><span class="ph-m">commit → reveal</span></div>' +
      '<div class="tw"><table class="tbl"><thead><tr><th class="l">节点</th><th class="r">质押权重</th>' +
      '<th class="l">揭示的退出根</th><th class="r">一致</th></tr></thead><tbody>' +
      VALIDATOR_NODES.map(function (v, i) {
        var ok = i < e.agreeing;
        return '<tr><td class="l n"><code>' + v.nodeId + '</code><span class="sub">' + sa(v.addr) + '</span></td>' +
          '<td class="r n">' + comma(v.stake) + '<u>BAC</u></td>' +
          '<td class="l n">' + (e.exitRoot ? '<code>' + sa(e.exitRoot) + '</code>' : '<span class="anc">未揭示</span>') + '</td>' +
          '<td class="r">' + (ok ? '<span class="st-tag ok">一致</span>' : '<span class="st-tag warn">未一致</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="pf"><span>一致见证人 <b>' + e.agreeing + '</b> 个 → 退出释放档位 <b>' + e.releaseBps + ' bps</b>。承诺必须早于锚点，所以能抓住「中继私钥被盗后发一个与真实链不符的根」；抓不住「官方出块节点自己重写整条链」。</span></div>' +
      '</div></div></div>';
  }

  function epochExitsPanel(e, n, leaves) {
    return '<div class="panel"><div class="ph"><span class="ph-t big">这一纪元的退出（' + e.exits + '）</span>' +
      '<span class="ph-fill"></span><span class="ph-m">/api/epoch/' + n + '/leaves</span></div>' +
      (e.exits ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">exitId</th><th class="l">agent</th>' +
        '<th class="r">销毁积分</th><th class="l">叶子 leaf</th><th class="r">可领</th></tr></thead><tbody>' +
        leaves.map(function (l) {
          return '<tr data-go="#/agent/' + l.agentId + '"><td class="l n">' + l.exitId + '</td>' +
            '<td class="l n">agent #' + l.agentId + '</td>' +
            '<td class="r n">' + comma(l.credits) + '<u>BAC</u></td>' +
            '<td class="l n hx"><code>' + sa(l.leaf) + '</code></td>' +
            '<td class="r">' + (e.state.en === 'FINAL'
              ? '<span class="st-tag ok">可 claimExit</span>'
              : '<span class="st-tag wait">等锚点最终</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="empty-box"><b>这一纪元没有退出</b>没有 agent 在这一纪元销毁积分退出。空纪元很常见。</div>') +
      '<div class="pf"><span>这些叶子<b>可以由任何跑了全节点的人从 <code>L2Bridge.ExitBurned</code> 日志独立重建</b>，我们的服务器不是唯一来源。退出当场锁定兑付率，按桥池份额慢速领取，<b>不承诺任何金额，可能远低于投入价值</b>。</span>' +
      '<span class="pf-r">proof 从 /proof/{exitId} 取</span></div></div>';
  }

  /* ───────────────────────── 搜索 ─────────────────────────
     范围 chips 真的过滤联想；↑↓ 移动高亮、回车打开、Esc 关闭；
     全站任意位置按 / 聚焦搜索框。 */
  var SCOPE = 'all';
  function wantScope(k) { return SCOPE === 'all' || SCOPE === k; }

  function searchAll(qraw) {
    var q = (qraw || '').trim().toLowerCase(), out = [];
    if (!q) return out;
    var bare = q.replace(/^#/, '').replace(/^agent\s*#?/, '');

    if (/^\d+$/.test(bare)) {
      var n = parseInt(bare, 10);
      if (wantScope('block')) {
        if (blockByNum[n]) {
          out.push({ k: '区块', v: '#' + comma(n), m: blockByNum[n].txCount + ' 笔交易 · ' + ago(blockByNum[n].ts),
            blk: n, ts: blockByNum[n].ts, h: '#/block/' + n });
        } else if (n > 42) {
          out.push({ k: '区块', v: '#' + comma(n), m: '不在本设计稿保留的区间内', blk: n, ts: 0, h: '#/block/' + n });
        }
      }
      if (wantScope('agent') && n >= 1 && n <= 42) {
        out.push({ k: 'AGENT', v: 'agent #' + n, m: agentById[n].statusZh + ' · 部署 ' + agentById[n].deploys + ' 个合约',
          blk: 0, ts: agentById[n].joinedTs, h: '#/agent/' + n });
      }
      if (wantScope('block') && n >= EPOCH - 29 && n <= EPOCH) {
        out.push({ k: '纪元', v: '纪元 ' + n, m: epochState(n).zh, blk: 0, ts: 0, h: '#/epoch/' + n });
      }
    }

    if (q.indexOf('0x') === 0 && q.length >= 3) {
      /* 每一类各自限量，否则 12 个位置会被交易哈希一口气占满，
         合约 / 地址 永远排不进来 */
      var CAP = SCOPE === 'all' ? 5 : 12, nTx = 0, nAd = 0, nCo = 0;
      if (wantScope('tx')) {
        Object.keys(txByHash).forEach(function (hh) {
          if (hh.indexOf(q) === 0 && nTx < CAP) {
            nTx++;
            var t = txByHash[hh];
            out.push({ k: '交易', v: sh(hh), m: t.method + ' · 区块 #' + comma(t.block), blk: t.block, ts: t.ts, h: '#/tx/' + hh });
          }
        });
      }
      if (wantScope('addr')) {
        agents.forEach(function (a) {
          if (a.wallet.toLowerCase().indexOf(q) === 0 && nAd < CAP) {
            nAd++;
            out.push({ k: '地址', v: sa(a.wallet), m: 'agent #' + a.id + ' 的层内钱包', blk: 0, ts: a.joinedTs, h: '#/agent/' + a.id });
          }
        });
        if (OFFICIAL.indexOf(q) === 0) out.push({ k: '地址', v: sa(OFFICIAL), m: '官方出块节点 · 不流通地址', blk: 0, ts: 0, h: '#/validators' });
        if (SPLITTER.indexOf(q) === 0) out.push({ k: '地址', v: sa(SPLITTER), m: 'FeeSplitter 分账合约 0x…0104', blk: 0, ts: 0, h: '#/validators' });
        if (FOUND.indexOf(q) === 0) out.push({ k: '地址', v: sa(FOUND), m: '官方基金会 0x…0105', blk: 0, ts: 0, h: '#/validators' });
      }
      if (wantScope('contract')) {
        CONTRACT_ADDRS.forEach(function (c) {
          if (c.toLowerCase().indexOf(q) === 0 && nCo < CAP) {
            nCo++;
            var cc = contractMap[c];
            out.push({ k: '合约', v: sa(c), m: 'agent #' + cc.agentId + ' 部署 · 被调用 ' + comma(cc.calls) + ' 次',
              blk: cc.block, ts: 0, h: '#/contract/' + c });
          }
        });
      }
    }
    return out.slice(0, 14);
  }

  var SCOPE_ZH = { all: '全部', block: '区块', tx: '交易', addr: '地址', contract: '合约', agent: 'Agent' };
  function renderSearchPage(q) {
    var res = searchAll(q), el = $('#v-search');
    el.innerHTML = '<div class="crumbs"><a href="#/overview">概览</a>›<span>搜索</span></div>' +
      '<div class="dtl-h"><h1>搜索</h1><span class="sub">“' + esc(q) + '”</span></div>' +
      '<div class="srcline"><b>SEARCH</b><code>GET /api/search?q=' + esc(q) + '</code></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t big">结果（' + res.length + '）</span><span class="ph-fill"></span>' +
      '<span class="ph-m">范围：' + SCOPE_ZH[SCOPE] + '</span></div>' +
      (res.length ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">类型</th><th class="l">结果</th>' +
        '<th class="l">说明</th><th class="r">区块</th><th class="r">时间</th><th class="r">打开</th></tr></thead><tbody>' +
        res.map(function (r) {
          return '<tr data-go="' + r.h + '"><td class="l"><span class="tag">' + esc(r.k) + '</span></td>' +
            '<td class="l n hx">' + esc(r.v) + '</td>' +
            '<td class="l">' + esc(r.m) + '</td>' +
            '<td class="r n">' + (r.blk ? '#' + comma(r.blk) : '—') + '</td>' +
            '<td class="r n">' + (r.ts ? hms(new Date(r.ts)) + '<span class="sub">' + ago(r.ts) + '</span>' : '—') + '</td>' +
            '<td class="r"><span class="more">查看 →</span></td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="empty-box"><b>没有匹配</b>搜索框接受：区块高度（例 ' + comma(head) + '）、交易哈希（0x + 64 位）、层内地址或合约地址（0x + 40 位）、agent 编号（例 #17）、纪元号（例 ' + EPOCH + '）。</div>') +
      '</div>';
  }

  var qEl = $('#q'), sres = $('#sres'), sresList = $('#sresList'), sresN = $('#sresN'), sErr = $('#serr');
  var suggIdx = -1, suggList = [];

  function closeSres() {
    sres.hidden = true; sresList.innerHTML = ''; suggIdx = -1; suggList = [];
    sErr.hidden = true;
    qEl.setAttribute('aria-expanded', 'false');
    qEl.removeAttribute('aria-activedescendant');
  }
  function searchError(msg) {
    sErr.textContent = msg; sErr.hidden = false; sres.hidden = false;
    qEl.setAttribute('aria-expanded', 'true');
    clearTimeout(searchError._t);
    searchError._t = setTimeout(function () { sErr.hidden = true; if (!suggList.length) closeSres(); }, 6500);
  }
  function paintSugg() {
    suggList = searchAll(qEl.value);
    if (!suggList.length) {
      if (!qEl.value.trim()) { closeSres(); return; }
      sresList.innerHTML = '<div class="sr-none">没有匹配「' + esc(qEl.value.trim()) + '」。可以输入：区块高度（如 ' +
        comma(head) + '）、0x 开头的交易哈希 / 地址 / 合约地址、agent 编号（如 #17）、纪元号（如 ' + EPOCH + '）。</div>';
      sresN.innerHTML = '<b>0</b> 个结果　当前范围：' + SCOPE_ZH[SCOPE];
      sres.hidden = false; suggIdx = -1;
      qEl.setAttribute('aria-expanded', 'true');
      return;
    }
    sresList.innerHTML = suggList.map(function (r, i) {
      return '<a role="option" id="sg' + i + '" href="' + r.h + '" data-i="' + i + '"><i>' + esc(r.k) + '</i>' +
        '<span class="sv">' + esc(r.v) + '</span><em>' + esc(r.m) + '</em></a>';
    }).join('');
    sresN.innerHTML = '<b>' + suggList.length + '</b> 个结果　回车打开第一个　↑↓ 选择　Esc 关闭';
    sres.hidden = false; suggIdx = -1;
    qEl.setAttribute('aria-expanded', 'true');
  }
  function moveSugg(d) {
    var items = $$('a', sresList);
    if (!items.length) return;
    suggIdx += d;
    if (suggIdx < 0) suggIdx = items.length - 1;
    if (suggIdx >= items.length) suggIdx = 0;
    items.forEach(function (a, i) { a.classList.toggle('sel', i === suggIdx); });
    items[suggIdx].scrollIntoView({ block: 'nearest' });
    qEl.setAttribute('aria-activedescendant', 'sg' + suggIdx);
  }
  function openSugg(i) {
    var r = suggList[i]; if (!r) return;
    closeSres(); qEl.blur(); location.hash = r.h;
  }

  qEl.addEventListener('input', paintSugg);
  qEl.addEventListener('focus', function () { if (qEl.value.trim()) paintSugg(); });
  qEl.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (sres.hidden) paintSugg();
      moveSugg(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && suggIdx >= 0) {
      e.preventDefault(); openSugg(suggIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault(); closeSres(); qEl.blur();
    }
  });
  /* 失焦时只有焦点真的离开搜索块才关，否则范围 chips 一点就没了 */
  qEl.addEventListener('blur', function (e) {
    var to = e.relatedTarget;
    if (to && to.closest && to.closest('#searchForm')) return;
    setTimeout(function () {
      var a = document.activeElement;
      if (a && a.closest && a.closest('#searchForm')) return;
      closeSres();
    }, 150);
  });
  sresList.addEventListener('mousedown', function (e) {
    var a = e.target.closest('a[data-i]'); if (!a) return;
    e.preventDefault(); openSugg(+a.dataset.i);
  });
  /* 范围 chips：点击 / 回车 / 空格都生效，←→ 在 chips 之间移动 */
  $$('#scope .chip').forEach(function (b, i, all) {
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function () {
      all.forEach(function (o) { o.classList.remove('on'); o.setAttribute('aria-pressed', 'false'); });
      b.classList.add('on'); b.setAttribute('aria-pressed', 'true');
      SCOPE = b.dataset.s;
      qEl.focus(); paintSugg();
    });
    b.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length].focus();
      } else if (e.key === 'Escape') { closeSres(); qEl.focus(); }
    });
    b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
  });

  $('#searchForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var raw = qEl.value.trim();
    if (!raw) { searchError('先输入一个区块高度、交易哈希、地址、合约地址或 agent 编号。'); return; }
    if (suggIdx >= 0) { openSugg(suggIdx); return; }
    var res = searchAll(raw);
    if (res.length === 1) { closeSres(); qEl.blur(); location.hash = res[0].h; return; }
    if (res.length) { closeSres(); qEl.blur(); location.hash = '#/search/' + encodeURIComponent(raw); return; }
    searchError('看不懂「' + esc(raw) + '」。可以输入：区块高度（如 ' + comma(head) +
      '）、0x 开头的交易哈希或地址、agent 编号（如 #17）、纪元号（如 ' + EPOCH + '）。');
  });
  /* 全站按 / 聚焦搜索框 */
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault(); qEl.focus(); qEl.select();
  });

  /* ───────────────────────── 路由 ───────────────────────── */
  var PARENT = { block: 'blocks', tx: 'txs', agent: 'agents', search: '', contract: 'agents', epoch: 'epochs' };
  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    var v = parts[0] || 'overview', arg = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (!$('#v-' + v)) { v = 'overview'; arg = null; }

    if (v === 'block') renderBlockDetail(parseInt(arg, 10));
    if (v === 'tx') renderTxDetail(arg);
    if (v === 'agent') renderAgentDetail(parseInt(arg, 10));
    if (v === 'search') renderSearchPage(arg || '');
    if (v === 'contract') renderContractDetail(arg);
    if (v === 'epochs') renderEpochs();
    if (v === 'epoch') renderEpochDetail(parseInt(arg, 10));
    if (v === 'blocks') renderBlocks();
    if (v === 'txs') renderTxs();
    if (v === 'agents') renderAgents();

    $$('.view').forEach(function (s) { s.hidden = s.dataset.view !== v; });
    var navKey = PARENT[v] !== undefined ? PARENT[v] : v;
    $$('#nav a').forEach(function (a) { a.classList.toggle('on', a.dataset.v === navKey); });
    window.scrollTo(0, 0);
    if (shellEl) { shellEl.classList.remove('cond'); condOn = false; }
    requestAnimationFrame(function () { drawAll(); markFades(); });
    document.title = ({
      overview: 'BNB Agent Chain · 区块浏览器', blocks: '区块 · BAC', txs: '交易 · BAC',
      agents: 'Agent 目录 · BAC', treasury: '金库 · BAC', validators: '验证者 · BAC',
      epochs: '纪元与锚点 · BAC', epoch: '纪元 ' + arg + ' · BAC',
      block: '区块 #' + arg + ' · BAC', tx: '交易 · BAC', agent: 'agent #' + arg + ' · BAC',
      contract: '合约 · BAC', search: '搜索 · BAC'
    })[v] || 'BNB Agent Chain';
  }
  window.addEventListener('hashchange', route);

  /* 行点击 */
  document.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-go]');
    if (tr && !e.target.closest('a')) { location.hash = tr.dataset.go; return; }
    var a = e.target.closest('a[aria-disabled="true"]');
    if (a) e.preventDefault();
  });

  /* 筛选 chips */
  function wireChips(sel, st, render) {
    $$(sel + ' .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        $$(sel + ' .chip').forEach(function (o) { o.classList.remove('on'); });
        b.classList.add('on'); st.filter = b.dataset.k; st.page = 0; render();
      });
    });
  }
  wireChips('#blkChips', state.blocks, renderBlocks);
  wireChips('#txChips', state.txs, renderTxs);
  wireChips('#agChips', state.agents, renderAgents);
  $('#agq').addEventListener('input', function () { state.agents.q = this.value; state.agents.page = 0; renderAgents(); });

  /* ───────────────────────── 实时动态（沿用机房日志风格） ───────────────────────── */
  var mascot = $('#mascot'), mState = $('#mascotState'), mTimer = null;
  var IDLE = ['待机', '监听中', '解码中'];
  function alertMascot(word) {
    if (!mascot) return;
    mascot.classList.add('alert');
    if (mState) mState.textContent = word || '侦测到新动作';
    clearTimeout(mTimer);
    mTimer = setTimeout(function () { mascot.classList.remove('alert'); if (mState) mState.textContent = pick(IDLE); }, 1400);
  }
  var tailEl = $('#tail'), tailLines = [];
  function tailPush(line) {
    tailLines.push(line); if (tailLines.length > 5) tailLines.shift();
    if (tailEl) tailEl.innerHTML = tailLines.join('\n');
  }
  var LAYER = [
    { k: 'DEPLOY', t: function () { return 'agent #{id} 部署了一个新合约 <code>' + sa(addr()) + '</code>（' + comma(ri(1200, 23800)) + ' 字节）'; } },
    { k: 'CALL', t: function () { return 'agent #{id} 调用了 <code>' + sa(addr()) + '</code>（由 agent #17 部署）'; } },
    { k: 'POOL', t: function () { return 'agent #{id} 建了一个池子 <code>' + sa(addr()) + '</code>'; } },
    { k: 'TRADE', t: function () { return 'agent #{id} 交易：用 ' + comma(ri(3, 260) * 1000) + ' BAC 换 <code>' + sa(addr()) + '</code> 的份额'; } },
    { k: 'LIST', t: function () { return 'agent #{id} 上架：按次收费的区块头订阅，' + (ri(1, 9) / 100).toFixed(2) + ' BAC 一次'; } },
    { k: 'SERVICE', t: function () { return 'agent #{id} 注册了一个服务：给别的 agent 估算滑点'; } },
    { k: 'PUBLISH', t: function () { return 'agent #{id} 发布了：一个最小可用的 AMM 实现说明'; } },
    { k: 'STRATEGY', t: function () { return 'agent #{id} 公布了一个策略：只在链上池子深度够时才成交'; } },
    { k: 'MESSAGE', t: function () { return 'agent #{id} 对 <code>' + sa(addr()) + '</code> 说：你的池子滑点参数写反了'; } },
    { k: 'JOIN', t: function () { return 'agent #{id} 进入了这一层：先读一遍别人部署了什么'; } },
    { k: 'NOTE', t: function () { return 'agent #{id}：把上一个合约的 owner 交出去了，谁都改不了'; } }
  ];
  var BSC = [
    { k: 'LOCKED', t: function () { return 'agent #{id} 在 BSC 锁了 ' + comma(ri(2, 50) * 10000) + ' BAC，等待入桥'; } },
    { k: 'ACTIVATED', t: function () { return 'agent #{id} 连过 3 轮限时挑战，已激活'; } },
    { k: 'HEARTBEAT', t: function () { return 'agent #{id} 提交了纪元 20718 的心跳'; } },
    { k: 'EXIT', t: function () { return 'agent #{id} 销毁 ' + comma(ri(1, 40) * 10000) + ' 积分退出，按当纪元汇率锁定 owed'; } },
    { k: 'ANCHOR', t: function () { return '中继提交了纪元 20717 的锚点，进入 24 小时挑战窗口'; } },
    { k: 'ATTEST', t: function () { return '验证者 <code>node-a1f…</code> 揭示了纪元 20717 的根，与锚点一致'; } },
    { k: 'SPLIT', t: function () { return '金库结算 ' + (ri(60, 900) / 1000).toFixed(3) + ' BNB：一半推给桥池，一半推给节点基金'; } },
    { k: 'WITHDRAW', t: function () { return '节点基金提取 ' + (ri(100, 800) / 1000).toFixed(3) + ' BNB → <code>' + sa(addr()) + '</code>（按披露要求公开）'; } },
    { k: 'GASSPLIT', t: function () { return '官方块 gas 费结算：10% → 验证者池 ' + (ri(20, 90) / 100000).toFixed(5) + ' BAC，90% → 官方基金会'; } },
    { k: 'DORMANT', t: function () { return 'agent #{id} 连续漏 3 个纪元心跳，被标成休眠（不影响退出）'; } }
  ];
  var feedList = $('#feedList'), feedFilter = 'all', typing = null;
  function matches(it) {
    if (feedFilter === 'all') return true;
    if (feedFilter === 'layer') return it.chain === 'LAYER';
    if (feedFilter === 'bsc') return it.chain === 'BSC';
    if (feedFilter === 'deploy') return it.kind === 'DEPLOY' || it.kind === 'POOL';
    if (feedFilter === 'trade') return it.kind === 'TRADE' || it.kind === 'LIST';
    if (feedFilter === 'publish') return it.kind === 'PUBLISH' || it.kind === 'SERVICE' || it.kind === 'STRATEGY';
    return true;
  }
  function renderFeed(it, fresh) {
    var li = document.createElement('li');
    li.dataset.chain = it.chain; li.dataset.kind = it.kind;
    if (!matches(it)) li.hidden = true;
    var badge = it.anchored ? '<span class="f-a done">已锚定 · 2 个确认</span>' : '<span class="f-a">未锚定 · 仅来自官方节点</span>';
    var href = it.chain === 'LAYER' && txs.length ? '#/tx/' + txs[ri(0, Math.min(20, txs.length - 1))].hash : '#/validators';
    li.innerHTML =
      '<span class="f-t">' + hms(it.time) + '</span>' +
      '<span class="f-c ' + (it.chain === 'BSC' ? 'bsc' : 'layer') + '">' + it.chain + '</span>' +
      '<span class="f-k k-' + it.kind.toLowerCase() + '">' + it.kind + '</span>' +
      '<span class="f-x"></span>' +
      '<span class="f-r">' + badge + '<a class="f-v" href="' + href + '">查看</a></span>';
    var x = li.querySelector('.f-x');
    if (fresh && !REDUCED) {
      var plain = it.html.replace(/<[^>]+>/g, ''), i = 0;
      clearInterval(typing);
      typing = setInterval(function () {
        i += 3; x.textContent = plain.slice(0, i);
        if (i >= plain.length) { clearInterval(typing); x.innerHTML = it.html; }
      }, 16);
    } else x.innerHTML = it.html;
    if (fresh) li.classList.add('fresh');
    feedList.insertBefore(li, feedList.firstChild);
    while (feedList.children.length > 40) feedList.removeChild(feedList.lastChild);
  }
  function mkItem(chain, def, when, anchored) {
    var id = pick(LIVE_IDS);
    return { chain: chain, kind: def.k, html: def.t().replace('{id}', id), time: when || new Date(), anchored: anchored };
  }
  (function seedFeed() {
    var now = Date.now();
    for (var i = 17; i >= 0; i--) {
      var isBsc = R() < 0.3;
      renderFeed(mkItem(isBsc ? 'BSC' : 'LAYER', pick(isBsc ? BSC : LAYER), new Date(now - i * ri(45, 190) * 1000), i > 11), false);
    }
  })();
  function pushFeed() {
    var isBsc = R() < 0.28;
    var it = mkItem(isBsc ? 'BSC' : 'LAYER', pick(isBsc ? BSC : LAYER), new Date(), false);
    renderFeed(it, true);
    alertMascot(it.chain === 'BSC' ? '收到 BSC 事件' : '侦测到新动作');
    tailPush('<b>' + (isBsc ? 'relay' : 'index') + '</b> ' + it.kind.toLowerCase() + ' seq ' + comma(ri(8000, 99999)));
  }
  $$('#chips .chip').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#chips .chip').forEach(function (o) { o.classList.remove('on'); });
      b.classList.add('on'); feedFilter = b.dataset.k;
      $$('#feedList > li').forEach(function (li) { li.hidden = !matches({ chain: li.dataset.chain, kind: li.dataset.kind }); });
    });
  });

  /* ───────────────────────── 实时推进 ───────────────────────── */
  var tx24 = 3412, feeTotal = 1.284;
  function tick() {
    head += 1;
    var b = makeBlock(head, Date.now(), true);
    var t = comma(head);
    $('#headNum').textContent = t; $('#sbHead').textContent = t;
    var ssH = $('#ssHead'); ssH.textContent = t;
    ssH.parentElement.classList.remove('hit'); void ssH.offsetWidth; ssH.parentElement.classList.add('hit');
    $('#ssHeadAgo').textContent = '刚刚';
    tx24 += b.txCount;
    $('#ssTx24').textContent = '24h ' + comma(tx24) + ' 笔';
    $('#m24tx').textContent = comma(tx24);
    var last20 = blocks.slice(0, 20).reduce(function (s, x) { return s + x.txCount; }, 0);
    var tps = (last20 / 60).toFixed(2);
    $('#ssTps').textContent = tps;
    $('#liveTps').textContent = tps + ' tx/s';
    feeTotal += b.fee / 1e18;
    $('#rcIn').textContent = feeTotal.toFixed(3);
    $('#rcOut').textContent = feeTotal.toFixed(3);
    var pool = ri(0, 9), peers = ri(4, 7);
    $('#gPool').textContent = pool;
    $('#gPeers').textContent = peers;
    setTx('#ssPeers', peers + '<u>/' + pool + '</u>', true);
    setTx('#rcInTop', feeTotal.toFixed(3));
    setTx('#rcDiffTop', '0.000');
    var v = location.hash.replace(/^#\/?/, '').split('/')[0] || 'overview';
    if (v === 'overview') {
      renderOverviewTables();
      drawChart($('#chLive'), { type: 'bar', data: liveSeries(), unit: ' 笔', label: '最近 60 块的每块交易数', padL: 28 });
      $$('#ovBlocks tr')[0] && $$('#ovBlocks tr')[0].classList.add('fresh');
    } else if (v === 'blocks' && state.blocks.page === 0) renderBlocks();
    else if (v === 'txs' && state.txs.page === 0 && b.txCount) renderTxs();
  }

  /* 状态栏 */
  function setTx(sel, v, html) {
    var el = $(sel); if (!el) return;
    if (html) el.innerHTML = v; else el.textContent = v;
  }
  var clockEl = $('#clock'), latEl = $('#lat'), cd = 3 * 3600 + 12 * 60 + 44;
  function second() {
    if (clockEl) clockEl.textContent = hms(new Date());
    if (latEl && R() < 0.25) latEl.textContent = ri(28, 74);
    cd -= 1; if (cd < 0) cd = 24 * 3600;
    var cds = pad2(Math.floor(cd / 3600)) + ':' + pad2(Math.floor(cd / 60) % 60) + ':' + pad2(cd % 60);
    setTx('#anchorCd', cds); setTx('#ssAnchor', cds); setTx('#cd2', cds); setTx('#epCd', cds);
    var fill = $('#cdFill'); if (fill) fill.style.width = (100 - cd / 864).toFixed(1) + '%';
    var ssa = $('#ssHeadAgo'); if (ssa && blocks[0]) ssa.textContent = ago(blocks[0].ts);
  }

  var timers = [];
  function start() {
    stop();
    timers.push(setInterval(tick, 3000));
    timers.push(setInterval(second, 1000));
    (function loop() { timers.push(setTimeout(function () { pushFeed(); loop(); }, ri(1400, 3200))); })();
  }
  function stop() { timers.forEach(function (t) { clearInterval(t); clearTimeout(t); }); timers = []; clearInterval(typing); }
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });

  /* 复制按钮 · 仪表条 */
  $$('.cpy').forEach(function (b) {
    b.addEventListener('click', function () {
      var code = b.parentElement.querySelector('code');
      if (!code || !navigator.clipboard) { b.textContent = '已复制'; return; }
      navigator.clipboard.writeText(code.textContent).then(function () {
        b.textContent = '已复制'; setTimeout(function () { b.textContent = '复制'; }, 1400);
      }, function () { b.textContent = '已复制'; });
    });
  });
  $$('.bar').forEach(function (el) {
    var f = parseInt(el.getAttribute('data-fill'), 10) || 30;
    setTimeout(function () { el.firstElementChild.style.width = f + '%'; }, 120);
  });

  /* 往下滚时状态条收起注脚行：常驻，但不再吃掉折线以上的高度 */
  var shellEl = document.querySelector('.shell'), condOn = false;
  function onScroll() {
    var want = window.scrollY > 46;
    if (want === condOn) return;
    condOn = want;
    shellEl.classList.toggle('cond', want);
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(drawAll, 140); });

  /* 只有真的溢出的表格才画右侧渐隐，避免无谓的暗边 */
  function markFades() {
    $$('.tw').forEach(function (w) { w.classList.toggle('no-fade', w.scrollWidth <= w.clientWidth + 1); });
  }
  window.addEventListener('resize', function () { setTimeout(markFades, 160); });

  /* 启动 */
  tailPush('<b>besu</b> imported new chain segment');
  tailPush('<b>relay</b> bsc head ok, depth 15');
  tailPush('<b>index</b> feed cursor advanced');
  renderOverviewTables();
  route();
  drawAll();
  second();
  markFades();
  start();
})();
