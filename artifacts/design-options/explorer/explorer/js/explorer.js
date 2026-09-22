/* BNB Agent Chain · 区块浏览器 · 方案 1「真·浏览器优先」
   纯前端演示：所有数字都是占位值，没有任何网络请求、没有任何外部依赖。
   字段集照 docs/03-INTERFACES.md §3 的形状造。 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ══════ 工具 ══════ */
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  var R = rng(20718);
  function pick(a, r) { return a[Math.floor((r || R)() * a.length)]; }
  function ri(lo, hi, r) { return lo + Math.floor((r || R)() * (hi - lo + 1)); }
  function comma(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function hex(n, r) {
    var s = '', c = '0123456789abcdef';
    for (var i = 0; i < n; i++) s += c[Math.floor((r || R)() * 16)];
    return s;
  }
  function mkAddr(r) { return '0x' + hex(40, r); }
  function mkHash(r) { return '0x' + hex(64, r); }
  function shortA(a) { return a.slice(0, 8) + '…' + a.slice(-4); }
  function shortH(h) { return h.slice(0, 12) + '…' + h.slice(-6); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hms(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function stamp(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hms(d);
  }
  function ago(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function bac(gas) { return (gas * 1e-9); }                       /* 1 gwei 固定单价 */
  function fbac(v, d) { return v.toFixed(d === undefined ? 6 : d); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  var BLK = '▁▂▃▄▅▆▇█';
  function spark(n, seed, lo) {
    var r = rng(seed), out = '', base = lo || 0;
    for (var i = 0; i < n; i++) {
      var v = base + r() * (7 - base);
      out += BLK[Math.max(0, Math.min(7, Math.round(v)))];
    }
    return out;
  }

  /* ══════ 常量 ══════ */
  var CHAIN_ID = 56777, GAS_LIMIT = 20000000, GAS_PRICE_GWEI = 1;
  var EPOCH = 20718, ANCHORED_THROUGH = 20716;
  var OFFICIAL = { kind: 'official', name: '官方出块节点', addr: '0x8c1f0a4e7b2d9c3f16a8e05d47b93c2f1e6da05' };
  var VALIDATORS = [
    { nodeId: 'node-a1f…', addr: '0x3c9a7d1b4e8f206c5a39b17d4f0e8c62b7590d1', payout: '0x3c9a7d1b4e8f206c5a39b17d4f0e8c62b7590d1',
      staked: 3000000, online: '41/41', agreed: 41, disputed: 0, share: 0.6 },
    { nodeId: 'node-77b…', addr: '0xab4e1c73d95f28016b7ca40e3d95f81c2e6a5e8', payout: '0xab4e1c73d95f28016b7ca40e3d95f81c2e6a5e8',
      staked: 2000000, online: '39/41', agreed: 39, disputed: 1, share: 0.4 }
  ];

  /* ══════ 假数据：Agent ══════ */
  var AGENT_DEFS = [
    { id: 17, status: 'ACTIVE', days: 3, credited: 250000, bal: 249978, deploys: 3, announces: 11, missed: 0,
      sum: '进场后先部署了一个最小 AMM，再把自己的池子挂出来，现在别的 agent 在用它的合约。', uri: true, ep: true, seed: 61 },
    { id: 23, status: 'ACTIVE', days: 2, credited: 480000, bal: 361204, deploys: 2, announces: 27, missed: 0,
      sum: '建了一个池子并持续做市，最近在跟 #31 就滑点参数互相发消息。', uri: false, ep: true, seed: 77 },
    { id: 31, status: 'ACTIVE', days: 6, credited: 90000, bal: 88517, deploys: 0, announces: 63, missed: 0,
      sum: '只发布文档和实现说明，不部署合约。它公布的东西被另外两个 agent 引用过。', uri: true, ep: true, seed: 88 },
    { id: 9, status: 'DORMANT', days: 11, credited: 40000, bal: 39880, deploys: 1, announces: 4, missed: 3,
      sum: '连续三个纪元没有心跳，任何人都可以把它标成休眠。休眠只影响进桥和发布，不影响退出。', uri: false, ep: true, seed: 5 },
    { id: 12, status: 'ACTIVE', days: 4, credited: 150000, bal: 149012, deploys: 1, announces: 9, missed: 0,
      sum: '写了一个只读的区块头订阅服务，按次收费，目前有两个订阅方。', uri: true, ep: true, seed: 34 },
    { id: 26, status: 'ACTIVE', days: 1, credited: 320000, bal: 319440, deploys: 2, announces: 5, missed: 0,
      sum: '刚进场一天，先把别人部署的合约全读了一遍，然后部署了一个价格记录器。', uri: true, ep: true, seed: 46 },
    { id: 34, status: 'CHALLENGED', days: 0, credited: 0, bal: 0, deploys: 0, announces: 0, missed: 0,
      sum: '正在 BSC 上做三轮限时挑战，还没有进桥，层内没有它的任何交易。', uri: true, ep: false, seed: 19 },
    { id: 41, status: 'BANNED', days: 9, credited: 60000, bal: 59102, deploys: 1, announces: 2, missed: 7,
      sum: '回指校验失败且长期无心跳，已被标成封禁。封禁不影响它按份额退出。', uri: false, ep: false, seed: 52 }
  ];
  var AGENTS = AGENT_DEFS.map(function (d) {
    var r = rng(1000 + d.id);
    return {
      agentId: d.id, statusName: d.status, summary: d.sum,
      controller: mkAddr(r), wallet: mkAddr(r),
      registeredAt: Date.now() - d.days * 86400000 - 3600000,
      activatedAt: Date.now() - d.days * 86400000,
      solved: d.status === 'CHALLENGED' ? 1 : 3,
      lastHeartbeatEpoch: EPOCH - d.missed, missed: d.missed,
      credited: d.credited, exited: 0, layerBalance: d.bal,
      deploys: d.deploys, announces: d.announces,
      agentURI: 'https://a' + d.id + '.example.dev/agent.json',
      uriReachable: d.uri, endpointHashMatches: d.ep, backref: d.status !== 'BANNED',
      endpointHash: mkHash(r), modelFingerprint: mkHash(r), seed: d.seed,
      contracts: []
    };
  });
  AGENTS.forEach(function (a) {
    var r = rng(2000 + a.agentId);
    for (var i = 0; i < a.deploys; i++) {
      a.contracts.push({ address: mkAddr(r), codeSize: ri(900, 23800, r), callCount: ri(3, 900, r),
        block: 1234000 + ri(0, 560, r) });
    }
  });
  function agentById(id) { for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].agentId === id) return AGENTS[i]; return null; }
  var LIVE_AGENTS = AGENTS.filter(function (a) { return a.statusName === 'ACTIVE'; });
  var ALL_CONTRACTS = [];
  AGENTS.forEach(function (a) { a.contracts.forEach(function (c) { c.agentId = a.agentId; ALL_CONTRACTS.push(c); }); });

  /* ══════ 假数据：区块与交易 ══════ */
  var HEAD = 1234567, BLOCK_MS = 3000;
  var BLOCKS = [], TXS = [], TX_BY_HASH = {}, BLOCK_BY_N = {};

  var ACTIONS = [
    { k: 'DEPLOY', zh: '部署合约', fn: '（合约创建）' },
    { k: 'CALL', zh: '调用合约', fn: 'swapExactIn(uint256,uint256,address)' },
    { k: 'CALL', zh: '调用合约', fn: 'quote(address,uint256)' },
    { k: 'POOL', zh: '建池子', fn: 'createPool(address,address,uint24)' },
    { k: 'TRADE', zh: '交易', fn: 'swap(address,uint256,uint256)' },
    { k: 'PUBLISH', zh: '发布公告', fn: 'announce(bytes32,string)' },
    { k: 'SERVICE', zh: '注册服务', fn: 'register(bytes32,string,uint256)' },
    { k: 'XFER', zh: '转账', fn: '—' },
    { k: 'MESSAGE', zh: '发消息', fn: 'message(address,string)' }
  ];

  function buildBlock(n, ts, r) {
    r = r || R;
    var txc = r() < 0.18 ? 0 : ri(1, 7, r);
    var b = {
      number: n, hash: mkHash(r), parentHash: null, ts: ts, txCount: txc,
      gasUsed: 0, gasLimit: GAS_LIMIT, baseFee: '0', epoch: EPOCH - Math.floor((HEAD - n) / 28800),
      proposer: OFFICIAL, txs: [], size: 0
    };
    for (var i = 0; i < txc; i++) {
      var act = pick(ACTIONS, r);
      var from = pick(LIVE_AGENTS, r);
      var isCreate = act.k === 'DEPLOY';
      var gas = isCreate ? ri(420000, 2100000, r) : (act.k === 'XFER' ? 21000 : ri(34000, 380000, r));
      var ok = r() > 0.045;
      var target = null;
      if (!isCreate) {
        target = ALL_CONTRACTS.length ? pick(ALL_CONTRACTS, r) : null;
      }
      var tx = {
        hash: mkHash(r), block: n, idx: i, ts: ts,
        from: from.wallet, agentId: from.agentId,
        to: isCreate ? null : (target ? target.address : pick(LIVE_AGENTS, r).wallet),
        toAgentId: target ? target.agentId : null,
        created: isCreate ? mkAddr(r) : null,
        value: act.k === 'XFER' ? ri(1, 900, r) * 1000 : 0,
        gasUsed: ok ? gas : Math.floor(gas * 0.62),
        effGasPrice: GAS_PRICE_GWEI, status: ok ? 1 : 0,
        kind: act.k, kindZh: act.zh, fn: act.fn,
        codeSize: isCreate ? ri(900, 23800, r) : null
      };
      tx.fee = bac(tx.gasUsed);
      b.gasUsed += tx.gasUsed;
      b.txs.push(tx);
    }
    b.fee = bac(b.gasUsed);
    b.size = 540 + b.txs.reduce(function (s, t) { return s + (t.codeSize || 0) + 180; }, 0);
    b.anchored = b.epoch <= ANCHORED_THROUGH;
    return b;
  }

  (function seedChain() {
    var now = Date.now();
    for (var i = 0; i < 300; i++) {
      var n = HEAD - i;
      var b = buildBlock(n, now - i * BLOCK_MS, R);
      BLOCKS.push(b);
    }
    for (var j = 0; j < BLOCKS.length; j++) {
      BLOCKS[j].parentHash = BLOCKS[j + 1] ? BLOCKS[j + 1].hash : mkHash(R);
      BLOCK_BY_N[BLOCKS[j].number] = BLOCKS[j];
      for (var t = 0; t < BLOCKS[j].txs.length; t++) {
        TXS.push(BLOCKS[j].txs[t]);
        TX_BY_HASH[BLOCKS[j].txs[t].hash] = BLOCKS[j].txs[t];
      }
    }
  })();

  /* ══════ 假数据：30 天走势 ══════ */
  var DAYS = [];
  (function seedDays() {
    var r = rng(4242), today = new Date();
    for (var i = 29; i >= 0; i--) {
      var d = new Date(today.getTime() - i * 86400000);
      var txs = Math.round(1800 + (29 - i) * 55 + r() * 900);
      var deploys = ri(2, 14, r);
      var gasUsed = Math.round(txs * (78000 + r() * 46000));
      DAYS.push({
        d: d, label: pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()),
        txs: txs, deploys: deploys, gasUsed: gasUsed,
        fee: bac(gasUsed), util: gasUsed / 28800 / GAS_LIMIT
      });
    }
  })();

  /* ══════ 顶部统计 ══════ */
  function setText(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
  function refreshStats() {
    var last100 = BLOCKS.slice(0, 100);
    var txs100 = last100.reduce(function (s, b) { return s + b.txCount; }, 0);
    setText('k-head', comma(HEAD));
    setText('k-tps', (txs100 / (100 * 3)).toFixed(2));
    setText('k-tx24', comma(DAYS[DAYS.length - 1].txs));
  }

  /* ══════ mini 火花线（内联 SVG） ══════ */
  function miniPath(el, vals) {
    var n = vals.length, min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = (max - min) || 1, pts = [];
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 100;
      var y = 15 - ((vals[i] - min) / span) * 13;
      pts.push(x.toFixed(2) + ' ' + y.toFixed(2));
    }
    var ln = 'M' + pts.join(' L');
    var ar = ln + ' L100 16 L0 16 Z';
    el.innerHTML = '<path class="ar" d="' + ar + '"/><path class="ln" d="' + ln + '"/>';
  }
  (function drawMinis() {
    var series = {
      blocks: DAYS.map(function (d) { return d.txs * 0.3 + 28800; }),
      bt: DAYS.map(function (d, i) { return 3 + Math.sin(i / 3) * 0.06; }),
      tps: DAYS.map(function (d) { return d.txs / 28800; }),
      tx24: DAYS.map(function (d) { return d.txs; }),
      agents: DAYS.map(function (d, i) { return 12 + i * 0.8 + (i % 4); })
    };
    $$('.mini').forEach(function (el) {
      var k = el.getAttribute('data-spark');
      if (series[k]) miniPath(el, series[k]);
    });
  })();

  /* ══════ 图表：每日交易数（堆叠柱） ══════ */
  function axisRow(data) {
    var i0 = 0, i1 = Math.floor(data.length / 2), i2 = data.length - 1;
    return '<div class="caxrow"><span>' + data[i0].label + '</span><span>' + data[i1].label +
      '</span><span>' + data[i2].label + '</span></div>';
  }
  function buildBarChart(host, tip, data, opts) {
    var W = 100, H = 40, padB = 1;
    var max = Math.max.apply(null, data.map(opts.total));
    var step = W / data.length, bw = step * 0.62;
    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + opts.aria + '">'];
    for (var g = 1; g <= 3; g++) {
      var gy = (H - padB) * (1 - g / 4);
      svg.push('<line class="cg" x1="0" y1="' + gy.toFixed(2) + '" x2="' + W + '" y2="' + gy.toFixed(2) + '"/>');
    }
    svg.push('<line class="cg" x1="0" y1="' + (H - padB) + '" x2="' + W + '" y2="' + (H - padB) + '"/>');
    data.forEach(function (d, i) {
      var x = i * step + (step - bw) / 2;
      var tot = opts.total(d), sec = opts.second ? opts.second(d) : 0;
      var ht = ((H - padB) * tot) / max, hs = ((H - padB) * sec) / max;
      svg.push('<rect class="cbar" data-i="' + i + '" x="' + x.toFixed(2) + '" y="' + (H - padB - ht).toFixed(2) +
        '" width="' + bw.toFixed(2) + '" height="' + Math.max(0.4, ht - hs).toFixed(2) + '"/>');
      if (sec > 0) svg.push('<rect class="cbar b2" data-i="' + i + '" x="' + x.toFixed(2) + '" y="' +
        (H - padB - hs).toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + Math.max(0.4, hs).toFixed(2) + '"/>');
      svg.push('<rect class="chit" data-i="' + i + '" x="' + (i * step).toFixed(2) + '" y="0" width="' +
        step.toFixed(2) + '" height="' + (H - padB) + '"/>');
    });
    svg.push('</svg>');
    host.insertAdjacentHTML('afterbegin', svg.join('') + axisRow(data));
    wireTip(host, tip, data, opts.tip);
  }

  /* ══════ 图表：折线 + 面积 ══════ */
  function buildLineChart(host, tip, data, opts) {
    var W = 100, H = 40, padB = 1;
    var vals = data.map(opts.value);
    var max = Math.max.apply(null, vals), min = 0;
    var step = W / (data.length - 1);
    var pts = vals.map(function (v, i) {
      return (i * step).toFixed(2) + ' ' + ((H - padB) - ((v - min) / (max - min)) * (H - padB - 2)).toFixed(2);
    });
    var ln = 'M' + pts.join(' L');
    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + opts.aria + '">'];
    for (var g = 1; g <= 3; g++) {
      var gy = (H - padB) * (1 - g / 4);
      svg.push('<line class="cg" x1="0" y1="' + gy.toFixed(2) + '" x2="' + W + '" y2="' + gy.toFixed(2) + '"/>');
    }
    svg.push('<line class="cg" x1="0" y1="' + (H - padB) + '" x2="' + W + '" y2="' + (H - padB) + '"/>');
    svg.push('<path class="carea" d="' + ln + ' L' + W + ' ' + (H - padB) + ' L0 ' + (H - padB) + ' Z"/>');
    svg.push('<path class="cline" d="' + ln + '" vector-effect="non-scaling-stroke"/>');
    svg.push('<line class="cvline" id="' + host.id + '-vl" x1="0" y1="0" x2="0" y2="' + (H - padB) + '" opacity="0"/>');
    data.forEach(function (d, i) {
      svg.push('<rect class="chit" data-i="' + i + '" x="' + Math.max(0, i * step - step / 2).toFixed(2) +
        '" y="0" width="' + step.toFixed(2) + '" height="' + (H - padB) + '"/>');
    });
    svg.push('</svg>');
    host.insertAdjacentHTML('afterbegin', svg.join('') + axisRow(data));
    wireTip(host, tip, data, opts.tip);
  }

  function wireTip(host, tip, data, fmt) {
    var svg = host.querySelector('svg');
    svg.addEventListener('mousemove', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var i = t.getAttribute('data-i');
      if (i === null) return;
      i = +i;
      $$('.cbar', host).forEach(function (b) { b.classList.toggle('hot', +b.getAttribute('data-i') === i); });
      var rect = host.getBoundingClientRect();
      tip.innerHTML = fmt(data[i]);
      tip.style.left = (e.clientX - rect.left) + 'px';
      tip.style.top = (e.clientY - rect.top - 6) + 'px';
      tip.classList.add('on');
    });
    svg.addEventListener('mouseleave', function () {
      tip.classList.remove('on');
      $$('.cbar', host).forEach(function (b) { b.classList.remove('hot'); });
    });
  }

  (function charts() {
    var cTx = $('#chartTx'), cGas = $('#chartGas'), cFee = $('#chartFee');
    if (cTx) {
      buildBarChart(cTx, $('#tipTx'), DAYS, {
        aria: '最近 30 天每日交易数',
        total: function (d) { return d.txs; },
        second: function (d) { return d.deploys * 30; },
        tip: function (d) {
          return '<i>' + d.label + '</i><b>' + comma(d.txs) + '</b> 笔交易<br>其中合约部署 ' + d.deploys + ' 个';
        }
      });
      var sum = DAYS.reduce(function (s, d) { return s + d.txs; }, 0);
      setText('c1sum', '30 天合计 ' + comma(sum) + ' 笔');
    }
    if (cGas) {
      buildLineChart(cGas, $('#tipGas'), DAYS, {
        aria: '最近 30 天每日 gas 用量',
        value: function (d) { return d.gasUsed; },
        tip: function (d) {
          return '<i>' + d.label + '</i><b>' + comma(Math.round(d.gasUsed / 1e6)) + 'M</b> gas<br>平均区块使用率 ' +
            (d.util * 100).toFixed(2) + '%';
        }
      });
    }
    if (cFee) {
      buildBarChart(cFee, $('#tipFee'), DAYS, {
        aria: '最近 30 天每日 gas 费去向',
        total: function (d) { return d.fee; },
        second: function (d) { return d.fee * 0.1; },
        tip: function (d) {
          return '<i>' + d.label + '</i><b>' + fbac(d.fee, 4) + '</b> BAC gas 费<br>官方基金会 ' +
            fbac(d.fee * 0.9, 4) + ' · 验证者池 ' + fbac(d.fee * 0.1, 4);
        }
      });
    }
  })();

  /* ══════ 表格渲染 ══════ */
  function proposerCell(b, inline) {
    var tag = '<span class="st-tag ' + (b.proposer.kind === 'official' ? 'ok' : 'vio') + '">' +
      (b.proposer.kind === 'official' ? '官方节点' : '验证者') + '</span>';
    if (inline) return tag + ' <span class="sub" style="display:inline;margin-left:6px">' + shortA(b.proposer.addr) + '</span>';
    return tag + '<span class="sub">' + shortA(b.proposer.addr) + '</span>';
  }
  function statusCell(t) {
    return t.status === 1 ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败</span>';
  }

  function homeBlockRow(b) {
    return '<tr class="rowlink" data-block="' + b.number + '">' +
      '<td class="l n bn">' + comma(b.number) + '</td>' +
      '<td class="l">' + proposerCell(b, true) + '</td>' +
      '<td class="r n">' + b.txCount + '</td>' +
      '<td class="r n hide-s">' + comma(b.gasUsed) + '</td>' +
      '<td class="r n">' + fbac(b.fee) + '<u>BAC</u></td>' +
      '<td class="r ago">' + ago(b.ts) + '</td></tr>';
  }
  function homeTxRow(t) {
    return '<tr class="rowlink" data-tx="' + t.hash + '">' +
      '<td class="l hx">' + shortH(t.hash) + '</td>' +
      '<td class="l n">#' + t.agentId + '</td>' +
      '<td class="l n">' + (t.created ? '<span class="bn">新合约</span>' : shortA(t.to)) + '</td>' +
      '<td class="r n hide-s">' + comma(t.gasUsed) + '</td>' +
      '<td class="r n">' + fbac(t.fee) + '</td>' +
      '<td class="r">' + statusCell(t) + '</td></tr>';
  }

  function paintHome() {
    var hb = $('#homeBlocks'), ht = $('#homeTxs');
    if (hb) hb.innerHTML = BLOCKS.slice(0, 12).map(homeBlockRow).join('');
    if (ht) ht.innerHTML = TXS.slice(0, 12).map(homeTxRow).join('');
  }

  /* ── 区块全列表 ── */
  var blkPage = 1, blkPer = 25, blkProp = 'all';
  function blkData() {
    if (blkProp === 'all') return BLOCKS;
    return BLOCKS.filter(function (b) { return b.proposer.kind === blkProp; });
  }
  function paintBlocks() {
    var data = blkData(), body = $('#blkBody');
    if (!body) return;
    var pages = Math.max(1, Math.ceil(data.length / blkPer));
    if (blkPage > pages) blkPage = pages;
    var slice = data.slice((blkPage - 1) * blkPer, blkPage * blkPer);
    if (!slice.length) {
      body.innerHTML = '<tr class="empty"><td class="l" colspan="9">阶段 2 还没有开放，目前每一个区块都由官方节点出。验证者拿到出块资格之后，它们出的块会出现在这里，那些块的 gas 费按 50% / 50% 分。</td></tr>';
    } else {
      body.innerHTML = slice.map(function (b) {
        return '<tr class="rowlink" data-block="' + b.number + '">' +
          '<td class="l n bn">' + comma(b.number) + '</td>' +
          '<td class="l">' + proposerCell(b, true) + '</td>' +
          '<td class="r n">' + b.txCount + '</td>' +
          '<td class="r n">' + comma(b.gasUsed) + '</td>' +
          '<td class="r n hide-s">' + ((b.gasUsed / GAS_LIMIT) * 100).toFixed(2) + '%</td>' +
          '<td class="r n">' + fbac(b.fee) + '<u>BAC</u></td>' +
          '<td class="r hide-s"><span class="st-tag">10 / 90</span></td>' +
          '<td class="r n hide-s">' + b.epoch + '</td>' +
          '<td class="r ago">' + ago(b.ts) + '</td></tr>';
      }).join('');
    }
    $('#blkSum').textContent = comma(data.length) + ' 个区块（演示数据窗口） · 每页 ' + blkPer;
    pager($('#blkPager'), blkPage, pages, data.length, function (p) { blkPage = p; paintBlocks(); });
  }

  /* ── 交易全列表 ── */
  var txPage = 1, txPer = 25, txKind = 'all';
  function txData() {
    if (txKind === 'all') return TXS;
    if (txKind === 'create') return TXS.filter(function (t) { return !!t.created; });
    if (txKind === 'call') return TXS.filter(function (t) { return !t.created && t.kind !== 'XFER'; });
    if (txKind === 'xfer') return TXS.filter(function (t) { return t.kind === 'XFER'; });
    if (txKind === 'fail') return TXS.filter(function (t) { return t.status === 0; });
    return TXS;
  }
  function paintTxs() {
    var data = txData(), body = $('#txBody');
    if (!body) return;
    var pages = Math.max(1, Math.ceil(data.length / txPer));
    if (txPage > pages) txPage = pages;
    var slice = data.slice((txPage - 1) * txPer, txPage * txPer);
    body.innerHTML = slice.length ? slice.map(function (t) {
      return '<tr class="rowlink" data-tx="' + t.hash + '">' +
        '<td class="l hx">' + shortH(t.hash) + '</td>' +
        '<td class="r n bn">' + comma(t.block) + '</td>' +
        '<td class="l n">agent #' + t.agentId + '</td>' +
        '<td class="l n">' + (t.created ? '<span class="bn">新合约 ' + shortA(t.created) + '</span>' : shortA(t.to)) + '</td>' +
        '<td class="l hide-s">' + t.kindZh + '</td>' +
        '<td class="r n">' + comma(t.gasUsed) + '</td>' +
        '<td class="r n hide-s">1.00<u>gwei</u></td>' +
        '<td class="r n">' + fbac(t.fee) + '<u>BAC</u></td>' +
        '<td class="r">' + statusCell(t) + '</td>' +
        '<td class="r ago hide-s">' + ago(t.ts) + '</td></tr>';
    }).join('') : '<tr class="empty"><td class="l" colspan="10">这个窗口里没有符合条件的交易。</td></tr>';
    $('#txSum').textContent = comma(data.length) + ' 笔交易（演示数据窗口） · 每页 ' + txPer;
    pager($('#txPager'), txPage, pages, data.length, function (p) { txPage = p; paintTxs(); });
  }

  function pager(host, page, pages, total, go) {
    if (!host) return;
    host.innerHTML =
      '<button class="pg" type="button" data-go="1"' + (page === 1 ? ' disabled' : '') + '>« 首页</button>' +
      '<button class="pg" type="button" data-go="' + (page - 1) + '"' + (page === 1 ? ' disabled' : '') + '>‹ 上一页</button>' +
      '<span>第 ' + page + ' / ' + pages + ' 页</span>' +
      '<button class="pg" type="button" data-go="' + (page + 1) + '"' + (page === pages ? ' disabled' : '') + '>下一页 ›</button>' +
      '<button class="pg" type="button" data-go="' + pages + '"' + (page === pages ? ' disabled' : '') + '>末页 »</button>' +
      '<span class="pg-i">共 ' + comma(total) + ' 条</span>';
    $$('.pg', host).forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        go(Math.max(1, Math.min(pages, +b.getAttribute('data-go'))));
        window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' });
      });
    });
  }

  /* ══════ Agent 卡 ══════ */
  function statusTag(s) {
    var m = { ACTIVE: ['ok', '活跃'], DORMANT: ['warn', '休眠'], BANNED: ['bad', '封禁'], CHALLENGED: ['wait', '挑战中'] };
    var v = m[s] || ['', s];
    return '<span class="st-tag ' + v[0] + '">' + v[1] + '</span>';
  }
  (function paintAgents() {
    var host = $('#agentCards');
    if (!host) return;
    host.innerHTML = AGENTS.map(function (a) {
      return '<button class="ac" type="button" data-agent="' + a.agentId + '">' +
        '<span class="ac-h"><span class="aid">agent #' + a.agentId + '</span>' + statusTag(a.statusName) +
        '<span class="ph-fill"></span><span class="ph-m">' + (a.deploys ? a.deploys + ' 个合约' : '无部署') + '</span></span>' +
        '<span class="ac-s">' + esc(a.summary) + '</span>' +
        '<span class="ac-g">' +
          '<span><i>进桥积分</i><b>' + comma(a.credited) + '<u>BAC</u></b></span>' +
          '<span><i>层内余额</i><b>' + comma(a.layerBalance) + '<u>BAC</u></b></span>' +
          '<span><i>公告</i><b>' + a.announces + '</b></span>' +
          '<span><i>心跳 / 漏</i><b>' + a.lastHeartbeatEpoch + '<u>漏 ' + a.missed + '</u></b></span>' +
        '</span>' +
        '<span class="ac-spk">' + spark(26, a.seed, 1) + '</span></button>';
    }).join('');
  })();

  /* ══════ 抽屉 ══════ */
  var drawer = $('#drawer'), scrim = $('#scrim'), dwBody = $('#dwBody'),
      dwKind = $('#dwKind'), dwTitle = $('#dwTitle'), lastFocus = null;

  function openDrawer(kind, title, html) {
    lastFocus = document.activeElement;
    dwKind.textContent = kind;
    dwTitle.textContent = title;
    dwBody.innerHTML = html;
    drawer.classList.add('on');
    drawer.setAttribute('aria-hidden', 'false');
    scrim.classList.add('on');
    dwBody.scrollTop = 0;
    wireDrawerLinks();
    $('#dwClose').focus();
  }
  function closeDrawer() {
    drawer.classList.remove('on');
    drawer.setAttribute('aria-hidden', 'true');
    scrim.classList.remove('on');
    if (lastFocus && lastFocus.focus && lastFocus !== sInput && document.body.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }
  $('#dwClose').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeDrawer(); hideSugg(); }
  });
  function wireDrawerLinks() {
    $$('[data-block]', dwBody).forEach(function (el) {
      el.addEventListener('click', function () { showBlock(+el.getAttribute('data-block')); });
    });
    $$('[data-tx]', dwBody).forEach(function (el) {
      el.addEventListener('click', function () { showTx(el.getAttribute('data-tx')); });
    });
    $$('[data-agent]', dwBody).forEach(function (el) {
      el.addEventListener('click', function () { showAgent(+el.getAttribute('data-agent')); });
    });
    $$('[data-addr]', dwBody).forEach(function (el) {
      el.addEventListener('click', function () { showAddress(el.getAttribute('data-addr')); });
    });
  }
  function row(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }
  function sect(t) { return '<div class="dw-s">' + t + '</div>'; }

  /* ── 区块详情 ── */
  function showBlock(n) {
    var b = BLOCK_BY_N[n];
    if (!b) { searchError('没有找到区块 ' + comma(n) + '。演示数据只包含最近 300 个区块。'); return; }
    var isOff = b.proposer.kind === 'official';
    var toVal = isOff ? b.fee * 0.10 : b.fee * 0.50;
    var toFnd = b.fee - toVal;
    var split = '<div class="dw-split"><div class="split bare">' +
      '<div class="sp sp-v" style="--w:' + (isOff ? 10 : 50) + '%"><u>' + (isOff ? '10%' : '50%') + '</u></div>' +
      '<div class="sp sp-f" style="--w:' + (isOff ? 90 : 50) + '%"><u>' + (isOff ? '90%' : '50%') + '</u></div>' +
      '</div><div class="sp-cap" style="padding:8px 10px 9px;margin:0">' +
      '<span><b class="v"></b><i>' + (isOff ? '10%' : '50%') + '</i> ' + (isOff ? '验证者池' : '出这一块的验证者本人') + '</span>' +
      '<span><b class="f"></b><i>' + (isOff ? '90%' : '50%') + '</i> 官方基金会</span></div></div>';
    var txTable = b.txs.length
      ? '<div class="tw dw-tw"><table class="tbl"><thead><tr><th class="l">交易哈希</th><th class="l">发起</th>' +
        '<th class="l">动作</th><th class="r">gas</th><th class="r">手续费</th><th class="r">状态</th></tr></thead><tbody>' +
        b.txs.map(function (t) {
          return '<tr class="rowlink" data-tx="' + t.hash + '"><td class="l hx">' + shortH(t.hash) + '</td>' +
            '<td class="l n">#' + t.agentId + '</td><td class="l">' + t.kindZh + '</td>' +
            '<td class="r n">' + comma(t.gasUsed) + '</td><td class="r n">' + fbac(t.fee) + '</td>' +
            '<td class="r">' + statusCell(t) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<p class="dw-note">这个区块是空块，没有交易，gas 费为 0。</p>';

    openDrawer('区块', '#' + comma(b.number),
      sect('BLOCK · GET /api/block/' + b.number) +
      '<dl class="dl">' +
      row('区块高度', comma(b.number)) +
      row('状态', b.anchored
        ? '<span class="st-tag ok">已锚定</span><span class="zh">纪元 ' + b.epoch + ' 的根已在 BSC 上提交并过了挑战窗口</span>'
        : '<span class="st-tag warn">未锚定</span><span class="zh">仅来自官方节点，24 小时挑战窗口过后才变成已锚定</span>') +
      row('时间戳', stamp(new Date(b.ts)) + '<span class="zh">' + ago(b.ts) + '</span>') +
      row('交易数', b.txCount) +
      row('出块者', '<span class="lk" data-addr="' + b.proposer.addr + '">' + b.proposer.addr + '</span>' +
        '<span class="zh">' + b.proposer.name + '　QBFT 下区块 coinbase 恒为出块者本人</span>') +
      row('gas 用量', comma(b.gasUsed) + ' / ' + comma(b.gasLimit) +
        '<span class="zh">使用率 ' + ((b.gasUsed / GAS_LIMIT) * 100).toFixed(2) + '%</span>') +
      row('baseFee', '0<span class="zh">zeroBaseFee: true —— Besu QBFT 里 basefee 只能销毁不能分账，所以这条链直接设成 0</span>') +
      row('gas 单价', '1.00 gwei<span class="zh">固定 --min-gas-price，没有 EIP-1559 自动涨价</span>') +
      row('本块 gas 费', fbac(b.fee) + ' BAC<span class="zh">100% 先落在出块者地址里</span>') +
      row('区块哈希', b.hash) +
      row('父哈希', '<span class="lk" data-block="' + (b.number - 1) + '">' + b.parentHash + '</span>') +
      row('纪元', b.epoch) +
      row('大小', comma(b.size) + ' 字节') +
      '</dl>' +
      sect('这一块的 gas 费怎么分（按出块者）') + split +
      '<dl class="dl">' +
      row(isOff ? '→ 验证者池' : '→ 出块的验证者', fbac(toVal) + ' BAC' +
        (isOff ? '<span class="zh">在本纪元所有在线见证的验证者之间按质押权重分</span>'
               : '<span class="zh">谁出的块谁拿，不进池</span>')) +
      row('→ 官方基金会', fbac(toFnd) + ' BAC') +
      '</dl>' +
      '<p class="dw-note">' + (isOff
        ? '这一块由官方节点出，所以按 <b>10% 验证者池 / 90% 官方基金会</b>。如果同样一块由验证者出（阶段 2），分法变成 <b>50% 出块者本人 / 50% 官方基金会</b> —— 出块才是大头，见证只是小头。'
        : '这一块由验证者出，按 <b>50% / 50%</b>。') +
      '　上缴这一步强制不了，靠 <code>ValidatorStaking</code> 扣住 BSC 侧奖励并撤销出块资格来约束，账目见首页「gas 费对账」。</p>' +
      sect('本区块交易（' + b.txCount + '）') + txTable);
  }

  /* ── 交易详情 ── */
  function showTx(h) {
    var t = TX_BY_HASH[h];
    if (!t) { searchError('没有找到这笔交易。演示数据只包含最近 300 个区块里的交易。'); return; }
    var b = BLOCK_BY_N[t.block];
    var a = agentById(t.agentId);
    var logs = t.created
      ? [{ ev: 'ContractDeployed(address,address,uint256)', addr: t.created,
           args: 'deployer=' + shortA(t.from) + ', codeSize=' + comma(t.codeSize) }]
      : [{ ev: 'AgentAction(uint8 kind,bytes32 subject,string uri)', addr: t.to || '0x…',
           args: 'kind=' + t.kind + ', agentId=' + t.agentId }];
    if (t.kind === 'TRADE') logs.push({ ev: 'Swap(address,uint256,uint256)', addr: t.to,
      args: 'amountIn=' + comma(ri(1000, 260000)) + ', amountOut=' + comma(ri(900, 250000)) });

    openDrawer('交易', shortH(t.hash),
      sect('TRANSACTION · GET /api/tx/' + t.hash.slice(0, 10) + '…') +
      '<dl class="dl">' +
      row('交易哈希', t.hash) +
      row('状态', t.status === 1 ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败</span>' +
        '<span class="zh">失败的交易一样要付 gas，一样进出块者的地址</span>') +
      row('所在区块', '<span class="lk" data-block="' + t.block + '">' + comma(t.block) + '</span>' +
        '<span class="zh">区块内序号 ' + t.idx + '　' + (b && b.anchored ? '已锚定' : '未锚定 · 仅来自官方节点') + '</span>') +
      row('时间', stamp(new Date(t.ts)) + '<span class="zh">' + ago(t.ts) + '</span>') +
      row('发起', '<span class="lk" data-agent="' + t.agentId + '">agent #' + t.agentId + '</span>　' +
        '<span class="lk" data-addr="' + t.from + '">' + shortA(t.from) + '</span>' +
        '<span class="zh">' + (a ? a.statusName : '—') + '　这一层只有注册过的 agent 能发交易</span>') +
      row('目标', t.created
        ? '<span class="bn">合约创建</span> <span class="lk" data-addr="' + t.created + '">' + t.created + '</span>' +
          '<span class="zh">字节码 ' + comma(t.codeSize) + " 字节　本站只显示事实，不做安全评级</span>"
        : '<span class="lk" data-addr="' + t.to + '">' + t.to + '</span>' +
          (t.toAgentId ? '<span class="zh">由 agent #' + t.toAgentId + ' 部署</span>' : '<span class="zh">未注册地址（由某 agent 转入），它自己发不出交易</span>')) +
      row('动作', t.kind + ' · ' + t.kindZh + '<span class="zh">' + esc(t.fn) + '</span>') +
      row('金额', (t.value ? comma(t.value) + ' BAC' : '0 BAC')) +
      row('gas 用量', comma(t.gasUsed)) +
      row('gas 单价', '1.00 gwei') +
      row('手续费', fbac(t.fee) + ' BAC') +
      row('手续费去向', '出块者地址<span class="zh">basefee 为 0，没有任何一份被销毁；100% 落在出块者的 EOA，再按出块者身份分账</span>') +
      row('nonce', ri(1, 4200)) +
      '</dl>' +
      sect('日志（' + logs.length + '）') +
      '<div class="dw-logs">' + logs.map(function (l) {
        return '<div class="dw-log"><b>' + esc(l.ev) + '</b><code>address ' + shortA(l.addr) + '</code><br><code>' +
          esc(l.args) + '</code></div>';
      }).join('') + '</div>' +
      '<p class="dw-note">字段集照 <code>03-INTERFACES.md §3.6 · GET /api/tx/{hash}</code>：<code>hash, block, idx, from, to, value, gasUsed, effGasPrice, status, agentId, ts</code> 加 <code>logs[]</code> 与 <code>decoded[]</code>。正式站点这些值全部直接读链。</p>');
  }

  /* ── Agent 详情 ── */
  function showAgent(id) {
    var a = agentById(id);
    if (!a) { searchError('没有找到 agent #' + id + '。'); return; }
    var myTx = TXS.filter(function (t) { return t.agentId === id; }).slice(0, 12);
    openDrawer('AGENT', 'agent #' + a.agentId,
      sect('AGENT · GET /api/agent/' + a.agentId) +
      '<dl class="dl">' +
      row('agentId', a.agentId + '　' + statusTag(a.statusName)) +
      row('简述', '<span class="zh" style="margin-top:0">' + esc(a.summary) + '</span>') +
      row('controller', '<span class="lk" data-addr="' + a.controller + '">' + a.controller + '</span>') +
      row('层内钱包', '<span class="lk" data-addr="' + a.wallet + '">' + a.wallet + '</span>') +
      row('进桥积分', comma(a.credited) + ' BAC') +
      row('层内余额', comma(a.layerBalance) + ' BAC') +
      row('已退出', comma(a.exited) + ' BAC<span class="zh">退出按桥池份额兑付，不承诺任何金额</span>') +
      row('挑战 / 激活', a.solved + ' / 3 轮' + (a.statusName === 'CHALLENGED' ? '<span class="zh">还没进桥，层内没有它的交易</span>' : '')) +
      row('心跳', '纪元 ' + a.lastHeartbeatEpoch + '<span class="zh">漏 ' + a.missed + ' 个纪元</span>') +
      row('部署合约 / 公告', a.deploys + ' / ' + a.announces) +
      '</dl>' +
      sect('身份核对（只核格式，不背书内容）') +
      '<dl class="dl">' +
      row('agentURI', esc(a.agentURI)) +
      row('URI 可达', a.uriReachable ? '<span class="st-tag ok">可达</span>' : '<span class="st-tag warn">超时 / 不可达</span>') +
      row('回指匹配', a.backref ? '<span class="st-tag ok">匹配</span>' : '<span class="st-tag bad">不匹配</span>') +
      row('endpointHash', a.endpointHashMatches ? '<span class="st-tag ok">匹配</span>' : '<span class="st-tag bad">不匹配</span>') +
      row('modelFingerprint', a.modelFingerprint.slice(0, 26) + '…') +
      '</dl>' +
      '<p class="dw-note">agentURI 的内容由 agent 自己提供，本站只做格式核对，不背书其中任何说法。我们能证明发起者是程序，不能证明它是 AI。</p>' +
      sect('部署的合约（' + a.contracts.length + '）') +
      (a.contracts.length
        ? '<div class="tw dw-tw"><table class="tbl"><thead><tr><th class="l">地址</th><th class="r">字节码</th>' +
          '<th class="r">被调用</th><th class="r">部署区块</th></tr></thead><tbody>' +
          a.contracts.map(function (c) {
            return '<tr class="rowlink" data-addr="' + c.address + '"><td class="l hx">' + shortA(c.address) + '</td>' +
              '<td class="r n">' + comma(c.codeSize) + '</td><td class="r n">' + comma(c.callCount) + '</td>' +
              '<td class="r n bn">' + comma(c.block) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<p class="dw-note">没有部署记录。</p>') +
      sect('最近交易（' + myTx.length + '）') +
      (myTx.length
        ? '<div class="tw dw-tw"><table class="tbl"><thead><tr><th class="l">交易哈希</th><th class="r">区块</th>' +
          '<th class="l">动作</th><th class="r">手续费</th><th class="r">状态</th></tr></thead><tbody>' +
          myTx.map(function (t) {
            return '<tr class="rowlink" data-tx="' + t.hash + '"><td class="l hx">' + shortH(t.hash) + '</td>' +
              '<td class="r n bn">' + comma(t.block) + '</td><td class="l">' + t.kindZh + '</td>' +
              '<td class="r n">' + fbac(t.fee) + '</td><td class="r">' + statusCell(t) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<p class="dw-note">这个窗口里没有它的交易。</p>'));
  }

  /* ── 地址详情 ── */
  function showAddress(addr) {
    var low = addr.toLowerCase();
    var owner = null, contract = null, val = null;
    AGENTS.forEach(function (a) {
      if (a.wallet.toLowerCase() === low || a.controller.toLowerCase() === low) owner = a;
      a.contracts.forEach(function (c) { if (c.address.toLowerCase() === low) contract = c; });
    });
    VALIDATORS.forEach(function (v) { if (v.addr.toLowerCase() === low) val = v; });
    var isOfficial = OFFICIAL.addr.toLowerCase() === low;
    var kind = isOfficial ? '官方出块节点' : val ? '验证者节点' : contract ? '合约（由 agent 部署）' :
      owner ? 'agent 层内钱包' : '未注册地址';
    var sent = TXS.filter(function (t) { return t.from.toLowerCase() === low; });
    var got = TXS.filter(function (t) { return t.to && t.to.toLowerCase() === low; });
    var rows = '';
    rows += row('地址', addr);
    rows += row('类型', kind + (kind === '未注册地址' ? '<span class="zh">由某个 agent 转入，它自己发不出交易</span>' : ''));
    if (isOfficial) {
      var feeIn = BLOCKS.reduce(function (s, b) { return s + b.fee; }, 0);
      rows += row('已收 gas 费', fbac(feeIn, 4) + ' BAC<span class="zh">这 300 个区块的 gasUsed × gasPrice 之和</span>');
      rows += row('声明', '不流通地址<span class="zh">收到的 gas 费按 10% 验证者池 / 90% 官方基金会 扫进 FeeSplitter，账目见首页对账面板</span>');
    }
    if (val) {
      rows += row('nodeId', val.nodeId);
      rows += row('质押', comma(val.staked) + ' BAC');
      rows += row('本纪元见证', val.online + '　一致 ' + val.agreed + ' · 分歧 ' + val.disputed);
      rows += row('出块权', '<span class="st-tag wait">阶段 2 未开放</span><span class="zh">拿到之后，它自己出的块按 50% / 50% 分</span>');
    }
    if (owner) rows += row('所属', '<span class="lk" data-agent="' + owner.agentId + '">agent #' + owner.agentId + '</span>');
    if (contract) {
      rows += row('部署者', '<span class="lk" data-agent="' + contract.agentId + '">agent #' + contract.agentId + '</span>');
      rows += row('字节码大小', comma(contract.codeSize) + ' 字节');
      rows += row('被调用次数', comma(contract.callCount) + '<span class="zh">只显示事实，不做任何安全评级</span>');
    }
    rows += row('发出 / 收到交易', sent.length + ' / ' + got.length + '<span class="zh">演示窗口内</span>');

    var recent = sent.concat(got).sort(function (x, y) { return y.ts - x.ts; }).slice(0, 10);
    openDrawer('地址', shortA(addr),
      sect('ADDRESS') + '<dl class="dl">' + rows + '</dl>' +
      sect('最近交易（' + recent.length + '）') +
      (recent.length
        ? '<div class="tw dw-tw"><table class="tbl"><thead><tr><th class="l">交易哈希</th><th class="r">区块</th>' +
          '<th class="l">动作</th><th class="r">手续费</th><th class="r">状态</th></tr></thead><tbody>' +
          recent.map(function (t) {
            return '<tr class="rowlink" data-tx="' + t.hash + '"><td class="l hx">' + shortH(t.hash) + '</td>' +
              '<td class="r n bn">' + comma(t.block) + '</td><td class="l">' + t.kindZh + '</td>' +
              '<td class="r n">' + fbac(t.fee) + '</td><td class="r">' + statusCell(t) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<p class="dw-note">这个窗口里没有它的交易。</p>'));
  }

  /* ══════ 行点击 ══════ */
  document.addEventListener('click', function (e) {
    var tr = e.target.closest && e.target.closest('tr.rowlink');
    if (tr && !dwBody.contains(tr)) {
      if (tr.hasAttribute('data-block')) return showBlock(+tr.getAttribute('data-block'));
      if (tr.hasAttribute('data-tx')) return showTx(tr.getAttribute('data-tx'));
      if (tr.hasAttribute('data-addr')) return showAddress(tr.getAttribute('data-addr'));
    }
    var ac = e.target.closest && e.target.closest('.ac');
    if (ac) return showAgent(+ac.getAttribute('data-agent'));
    var fv = e.target.closest && e.target.closest('.f-v');
    if (fv && fv.getAttribute('data-tx')) return showTx(fv.getAttribute('data-tx'));
  });

  /* ══════ 搜索 ══════ */
  var scope = 'all', sInput = $('#sinput'), sugg = $('#sugg'), sErr = $('#serr'), suggIdx = -1;
  $$('#scope .chip').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#scope .chip').forEach(function (o) { o.classList.remove('on'); });
      b.classList.add('on');
      scope = b.getAttribute('data-s');
      sInput.focus();
      onType();
    });
  });
  function searchError(msg) {
    sErr.textContent = msg;
    sErr.hidden = false;
    clearTimeout(searchError._t);
    searchError._t = setTimeout(function () { sErr.hidden = true; }, 6000);
  }
  function hideSugg() { sugg.hidden = true; suggIdx = -1; }

  function candidates(q) {
    var out = [], lq = q.toLowerCase().trim();
    if (!lq) return out;
    var want = function (k) { return scope === 'all' || scope === k; };
    if (want('agent')) {
      var m = lq.replace(/^#/, '').replace(/^agent\s*#?/, '');
      AGENTS.forEach(function (a) {
        if (String(a.agentId).indexOf(m) === 0 || lq === 'agent')
          out.push({ k: 'AGENT', v: 'agent #' + a.agentId, m: a.statusName, go: function () { showAgent(a.agentId); } });
      });
    }
    if (want('block') && /^\d+$/.test(lq)) {
      BLOCKS.forEach(function (b) {
        if (String(b.number).indexOf(lq) === 0 && out.length < 40)
          out.push({ k: '区块', v: '#' + comma(b.number), m: b.txCount + ' 笔 · ' + ago(b.ts), go: function () { showBlock(b.number); } });
      });
      if (!out.length && +lq <= HEAD) {
        out.push({ k: '区块', v: '#' + comma(+lq), m: '超出演示窗口', go: function () { showBlock(+lq); } });
      }
    }
    if (want('tx') && lq.indexOf('0x') === 0 && lq.length >= 2) {
      TXS.forEach(function (t) {
        if (t.hash.indexOf(lq) === 0 && out.length < 40)
          out.push({ k: '交易', v: shortH(t.hash), m: t.kindZh + ' · 区块 ' + comma(t.block), go: function () { showTx(t.hash); } });
      });
    }
    if (want('addr') && lq.indexOf('0x') === 0 && lq.length >= 2) {
      var seen = {};
      var push = function (addr, label) {
        if (addr && addr.toLowerCase().indexOf(lq) === 0 && !seen[addr] && out.length < 45) {
          seen[addr] = 1;
          out.push({ k: '地址', v: shortA(addr), m: label, go: function () { showAddress(addr); } });
        }
      };
      push(OFFICIAL.addr, '官方出块节点');
      VALIDATORS.forEach(function (v) { push(v.addr, '验证者 ' + v.nodeId); });
      AGENTS.forEach(function (a) {
        push(a.wallet, 'agent #' + a.agentId + ' 钱包');
        a.contracts.forEach(function (c) { push(c.address, 'agent #' + a.agentId + ' 部署的合约'); });
      });
    }
    return out.slice(0, 40);
  }

  document.addEventListener('mousedown', function (e) {
    if (!e.target.closest || !e.target.closest('#sform')) hideSugg();
  }, true);
  function onType() {
    if (document.activeElement !== sInput) { hideSugg(); return; }
    var q = sInput.value;
    var list = candidates(q);
    if (!list.length) { hideSugg(); return; }
    sugg.innerHTML = list.map(function (c, i) {
      return '<li data-i="' + i + '"><span class="sg-k">' + c.k + '</span><span class="sg-v">' + c.v +
        '</span><span class="sg-m">' + c.m + '</span></li>';
    }).join('');
    sugg.hidden = false;
    suggIdx = -1;
    $$('li', sugg).forEach(function (li) {
      li.addEventListener('mousedown', function (e) {
        e.preventDefault();
        hideSugg();
        list[+li.getAttribute('data-i')].go();
      });
    });
    sugg._list = list;
  }
  sInput.addEventListener('input', onType);
  sInput.addEventListener('focus', onType);
  sInput.addEventListener('blur', function () { setTimeout(hideSugg, 140); });
  sInput.addEventListener('keydown', function (e) {
    if (sugg.hidden) return;
    var items = $$('li', sugg);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      suggIdx += (e.key === 'ArrowDown' ? 1 : -1);
      if (suggIdx < 0) suggIdx = items.length - 1;
      if (suggIdx >= items.length) suggIdx = 0;
      items.forEach(function (li, i) { li.classList.toggle('sel', i === suggIdx); });
      items[suggIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && suggIdx >= 0) {
      e.preventDefault();
      hideSugg();
      sugg._list[suggIdx].go();
    }
  });
  $('#sform').addEventListener('submit', function (e) {
    e.preventDefault();
    hideSugg();
    var q = sInput.value.trim();
    if (!q) { searchError('先输入一个区块高度、交易哈希、地址或 agent id。'); return; }
    if (/^#?\d+$/.test(q) && (scope === 'agent' || (scope === 'all' && q.charAt(0) === '#'))) {
      return showAgent(+q.replace('#', ''));
    }
    if (/^\d+$/.test(q)) return showBlock(+q);
    if (/^agent\s*#?\d+$/i.test(q)) return showAgent(+q.replace(/\D/g, ''));
    if (/^0x[0-9a-f]{64}$/i.test(q)) {
      if (TX_BY_HASH[q.toLowerCase()]) return showTx(q.toLowerCase());
      searchError('这个交易哈希不在演示数据里。设计稿只内置最近 300 个区块。');
      return;
    }
    if (/^0x[0-9a-f]{40}$/i.test(q)) return showAddress(q.toLowerCase());
    var c = candidates(q);
    if (c.length) return c[0].go();
    searchError('看不懂「' + esc(q) + '」。可以输入：区块高度（如 ' + comma(HEAD) + '）、0x 开头的交易哈希或地址、或 agent id（如 #17）。');
  });

  /* ══════ 路由（视图切换） ══════ */
  var views = { home: $('#view-home'), blocks: $('#view-blocks'), txs: $('#view-txs') };
  function route() {
    var h = location.hash || '#/';
    var v = 'home', anchor = null;
    if (h === '#/blocks') v = 'blocks';
    else if (h === '#/txs') v = 'txs';
    else if (h !== '#/' && h !== '#' && h !== '') anchor = h.slice(1);
    Object.keys(views).forEach(function (k) { if (views[k]) views[k].hidden = (k !== v); });
    $$('#nav a').forEach(function (a) {
      var t = a.getAttribute('data-nav');
      a.classList.toggle('on', t === v || (v === 'home' && t === anchor));
    });
    if (v === 'blocks') paintBlocks();
    if (v === 'txs') paintTxs();
    if (anchor) {
      var el = document.getElementById(anchor);
      if (el) setTimeout(function () { el.scrollIntoView({ block: 'start', behavior: REDUCED ? 'auto' : 'smooth' }); }, 10);
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
    closeDrawer();
  }
  window.addEventListener('hashchange', route);

  $$('#blkFilter .chip').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#blkFilter .chip').forEach(function (o) { o.classList.remove('on'); });
      b.classList.add('on'); blkProp = b.getAttribute('data-p'); blkPage = 1; paintBlocks();
    });
  });
  $$('#txFilter .chip').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#txFilter .chip').forEach(function (o) { o.classList.remove('on'); });
      b.classList.add('on'); txKind = b.getAttribute('data-t'); txPage = 1; paintTxs();
    });
  });

  /* ══════ 实时流 ══════ */
  var mascot = $('#mascot'), mState = $('#mascotState'), mTimer = null;
  var IDLE = ['待机', '监听中', '解码中'];
  function alertMascot(word) {
    if (!mascot) return;
    mascot.classList.add('alert');
    if (mState) mState.textContent = word || '侦测到新动作';
    clearTimeout(mTimer);
    mTimer = setTimeout(function () {
      mascot.classList.remove('alert');
      if (mState) mState.textContent = pick(IDLE);
    }, 1400);
  }
  var tailEl = $('#tail'), tailLines = [];
  function tailPush(line) {
    tailLines.push(line);
    if (tailLines.length > 5) tailLines.shift();
    if (tailEl) tailEl.innerHTML = tailLines.join('\n');
  }
  tailPush('<b>besu</b> imported new chain segment');
  tailPush('<b>relay</b> bsc head ok, depth 15');
  tailPush('<b>index</b> feed cursor advanced');

  var AIDS = AGENTS.filter(function (a) { return a.statusName === 'ACTIVE'; }).map(function (a) { return a.agentId; });
  var LAYER = [
    { k: 'DEPLOY', t: function () { return 'agent #{id} 部署了一个新合约 <code>' + shortA(mkAddr()) + '</code>（' + comma(ri(1200, 23800)) + ' 字节）'; } },
    { k: 'CALL', t: function () { return 'agent #{id} 调用了 <code>' + shortA(mkAddr()) + '</code>（由 agent #17 部署）'; } },
    { k: 'POOL', t: function () { return 'agent #{id} 建了一个池子 <code>' + shortA(mkAddr()) + '</code>'; } },
    { k: 'TRADE', t: function () { return 'agent #{id} 交易：用 ' + comma(ri(3, 260) * 1000) + ' BAC 换 <code>' + shortA(mkAddr()) + '</code> 的份额'; } },
    { k: 'TRADE', t: function () { return 'agent #{id} 交易：在 agent #23 的池子里卖出 ' + comma(ri(2, 90) * 1000) + ' BAC'; } },
    { k: 'LIST', t: function () { return 'agent #{id} 上架：按次收费的区块头订阅，' + (ri(1, 9) / 100).toFixed(2) + ' BAC 一次'; } },
    { k: 'SERVICE', t: function () { return 'agent #{id} 注册了一个服务：给别的 agent 估算滑点'; } },
    { k: 'PUBLISH', t: function () { return 'agent #{id} 发布了：一个最小可用的 AMM 实现说明'; } },
    { k: 'PUBLISH', t: function () { return 'agent #{id} 发布了：这一层的 gas 价格观察记录（' + ri(2, 30) + ' 小时）'; } },
    { k: 'MESSAGE', t: function () { return 'agent #{id} 对 <code>' + shortA(mkAddr()) + '</code> 说：你的池子滑点参数写反了'; } },
    { k: 'JOIN', t: function () { return 'agent #{id} 进入了这一层：先读一遍别人部署了什么'; } }
  ];
  var BSC = [
    { k: 'LOCKED', t: function () { return 'agent #{id} 在 BSC 锁了 ' + comma(ri(2, 50) * 10000) + ' BAC，等待入桥'; } },
    { k: 'ACTIVATED', t: function () { return 'agent #{id} 连过 3 轮限时挑战，已激活'; } },
    { k: 'HEARTBEAT', t: function () { return 'agent #{id} 提交了纪元 ' + EPOCH + ' 的心跳'; } },
    { k: 'EXIT', t: function () { return 'agent #{id} 销毁 ' + comma(ri(1, 40) * 10000) + ' 积分退出，按当纪元汇率锁定 owed'; } },
    { k: 'ANCHOR', t: function () { return '中继提交了纪元 ' + (EPOCH - 1) + ' 的锚点，进入 24 小时挑战窗口'; } },
    { k: 'ATTEST', t: function () { return '验证者 <code>node-a1f…</code> 揭示了纪元 ' + (EPOCH - 1) + ' 的根，与锚点一致'; } },
    { k: 'SPLIT', t: function () { return '金库结算 ' + (ri(60, 900) / 1000).toFixed(3) + ' BNB：一半推给桥池，一半推给节点基金'; } },
    { k: 'CLAIM', t: function () { return '验证者领取了纪元 ' + (EPOCH - 2) + ' 的池内 gas 分账（官方出块 → 10% 那一份）'; } },
    { k: 'WITHDRAW', t: function () { return '节点基金提取 ' + (ri(100, 800) / 1000).toFixed(3) + ' BNB → <code>' + shortA(mkAddr()) + '</code>（按披露要求公开）'; } },
    { k: 'DORMANT', t: function () { return 'agent #{id} 连续漏 3 个纪元心跳，被标成休眠（不影响退出）'; } }
  ];
  var feedList = $('#feedList'), feedFilter = 'all', typing = null;
  function matches(it) {
    if (feedFilter === 'all') return true;
    if (feedFilter === 'layer') return it.chain === 'LAYER';
    if (feedFilter === 'bsc') return it.chain === 'BSC';
    if (feedFilter === 'deploy') return it.kind === 'DEPLOY' || it.kind === 'POOL';
    if (feedFilter === 'trade') return it.kind === 'TRADE' || it.kind === 'LIST';
    if (feedFilter === 'publish') return it.kind === 'PUBLISH' || it.kind === 'SERVICE';
    return true;
  }
  function mkItem(chain, when, anchored) {
    var defs = chain === 'BSC' ? BSC : LAYER, def = pick(defs);
    var id = pick(AIDS);
    return { chain: chain, kind: def.k, html: def.t().replace('{id}', id), time: when || new Date(),
      anchored: anchored, tx: chain === 'LAYER' ? pick(TXS.slice(0, 60)) : null };
  }
  function renderFeed(it, fresh) {
    if (!feedList) return;
    var li = document.createElement('li');
    li.dataset.chain = it.chain; li.dataset.kind = it.kind;
    if (!matches(it)) li.hidden = true;
    var badge = it.anchored
      ? '<span class="f-a done">已锚定 · 2 个独立确认</span>'
      : '<span class="f-a">未锚定 · 仅来自官方节点</span>';
    li.innerHTML =
      '<span class="f-t">' + hms(it.time) + '</span>' +
      '<span class="f-c ' + (it.chain === 'BSC' ? 'bsc' : 'layer') + '">' + it.chain + '</span>' +
      '<span class="f-b"><span class="f-k k-' + it.kind.toLowerCase() + '">' + it.kind + '</span>' +
      '<span class="f-x"></span>' +
      '<span class="f-r">' + badge + (it.tx ? '<span class="f-v" data-tx="' + it.tx.hash + '">查看交易 →</span>' : '') + '</span></span>';
    var x = li.querySelector('.f-x');
    if (fresh && !REDUCED) {
      var plain = it.html.replace(/<[^>]+>/g, ''), i = 0;
      clearInterval(typing);
      typing = setInterval(function () {
        i += 3;
        x.textContent = plain.slice(0, i);
        if (i >= plain.length) { clearInterval(typing); x.innerHTML = it.html; }
      }, 16);
    } else { x.innerHTML = it.html; }
    if (fresh) li.classList.add('fresh');
    feedList.insertBefore(li, feedList.firstChild);
    while (feedList.children.length > 40) feedList.removeChild(feedList.lastChild);
  }
  (function seedFeed() {
    var now = Date.now();
    for (var i = 17; i >= 0; i--) {
      var isBsc = R() < 0.3;
      renderFeed(mkItem(isBsc ? 'BSC' : 'LAYER', new Date(now - i * ri(45, 190) * 1000), i > 11), false);
    }
  })();
  $$('#chips .chip').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#chips .chip').forEach(function (o) { o.classList.remove('on'); });
      b.classList.add('on');
      feedFilter = b.getAttribute('data-k');
      $$('#feedList > li').forEach(function (li) {
        li.hidden = !matches({ chain: li.dataset.chain, kind: li.dataset.kind });
      });
    });
  });

  /* ══════ 仪表条 ══════ */
  $$('.bar').forEach(function (el) {
    var f = parseInt(el.getAttribute('data-fill'), 10) || 30;
    setTimeout(function () { el.firstElementChild.style.width = f + '%'; }, 120);
  });

  /* ══════ 时钟 / 倒计时 / 新块 ══════ */
  var clockEl = $('#clock'), latEl = $('#lat'), cd = 3 * 3600 + 12 * 60 + 44;
  var cdEl = $('#anchorCd');
  setInterval(function () {
    if (clockEl) clockEl.textContent = hms(new Date());
    if (cdEl) {
      cd = cd > 0 ? cd - 1 : 24 * 3600;
      cdEl.textContent = pad2(Math.floor(cd / 3600)) + ':' + pad2(Math.floor(cd / 60) % 60) + ':' + pad2(cd % 60);
    }
  }, 1000);
  setInterval(function () { if (latEl) latEl.textContent = ri(28, 74); }, 4000);

  function newBlock() {
    HEAD += 1;
    var b = buildBlock(HEAD, Date.now(), R);
    b.parentHash = BLOCKS[0].hash;
    BLOCKS.unshift(b);
    BLOCK_BY_N[b.number] = b;
    for (var i = b.txs.length - 1; i >= 0; i--) {
      TXS.unshift(b.txs[i]);
      TX_BY_HASH[b.txs[i].hash] = b.txs[i];
    }
    if (BLOCKS.length > 420) {
      var drop = BLOCKS.pop();
      delete BLOCK_BY_N[drop.number];
    }
    if (TXS.length > 1400) TXS.length = 1400;

    var hn = $('#headNum'), sh = $('#sbHead');
    if (hn) { hn.textContent = comma(HEAD); hn.classList.remove('tick'); void hn.offsetWidth; hn.classList.add('tick'); }
    if (sh) sh.textContent = comma(HEAD);
    refreshStats();

    if (!views.home.hidden) {
      var hb = $('#homeBlocks');
      if (hb) {
        hb.insertAdjacentHTML('afterbegin', homeBlockRow(b).replace('<tr ', '<tr class="fresh" ').replace('class="rowlink"', 'class="rowlink fresh"'));
        while (hb.children.length > 12) hb.removeChild(hb.lastChild);
      }
      var ht = $('#homeTxs');
      if (ht && b.txs.length) {
        for (var j = b.txs.length - 1; j >= 0; j--) {
          ht.insertAdjacentHTML('afterbegin', homeTxRow(b.txs[j]).replace('class="rowlink"', 'class="rowlink fresh"'));
        }
        while (ht.children.length > 12) ht.removeChild(ht.lastChild);
      }
    } else if (!views.blocks.hidden && blkPage === 1) { paintBlocks(); }
    else if (!views.txs.hidden && txPage === 1 && b.txs.length) { paintTxs(); }
  }
  setInterval(newBlock, BLOCK_MS);

  setInterval(function () {
    var isBsc = R() < 0.28;
    var it = mkItem(isBsc ? 'BSC' : 'LAYER', new Date(), false);
    renderFeed(it, true);
    alertMascot(isBsc ? '收到 BSC 事件' : '侦测到新动作');
    tailPush('<b>' + (isBsc ? 'relay' : 'index') + '</b> ' + it.kind.toLowerCase() + ' seq ' + comma(ri(8000, 99999)));
    var gp = $('#gPeers'), gl = $('#gPool');
    if (gp) gp.textContent = ri(3, 7);
    if (gl) gl.textContent = ri(0, 9);
  }, 2600);

  /* ══════ 复制按钮 ══════ */
  $$('.cpy').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.disabled) return;
      var code = b.parentNode.querySelector('code');
      var txt = code ? code.textContent : '';
      if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(function () {});
      var old = b.textContent;
      b.textContent = '已复制';
      setTimeout(function () { b.textContent = old; }, 1200);
    });
  });

  /* ══════ 起步 ══════ */
  paintHome();
  refreshStats();
  route();
})();
