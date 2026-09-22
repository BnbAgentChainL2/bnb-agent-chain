/* ============================================================
   BNB Agent Chain · 样稿 B「工程图纸」交互层
   纯占位数据，无任何网络请求。正式站的数字全部来自链上。
   ============================================================ */
(function () {
  'use strict';

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var timers = [];
  function every(ms, fn) { var id = setInterval(fn, ms); timers.push(id); return id; }

  /* ---------- 小工具 ---------- */
  var seed = 20260922;
  function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
  function pick(a) { return a[Math.floor(rnd() * a.length) % a.length]; }
  function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function group(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function hex(n) {
    var s = '0x', c = '0123456789abcdef';
    for (var i = 0; i < n; i++) s += c[Math.floor(rnd() * 16)];
    return s;
  }
  /* 北京时间 UTC+8，与时区无关 */
  function bj(d) {
    var t = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
    return pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
  }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function svgEl(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ---------- 数字滚动 ---------- */
  function countTo(node) {
    if (node.__counted) return;
    node.__counted = true;
    var target = parseFloat(node.getAttribute('data-count'));
    var dp = parseInt(node.getAttribute('data-dp') || '0', 10);
    if (!isFinite(target)) return;
    if (REDUCED) { node.textContent = fmt(target, dp); return; }
    var t0 = 0, dur = 900;
    function fmt(v, d) {
      var s = d ? v.toFixed(d) : String(Math.round(v));
      var parts = s.split('.');
      parts[0] = group(parts[0]);
      return parts.join('.');
    }
    function step(ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(target * e, dp);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function fmt(v, d) {
    var s = d ? v.toFixed(d) : String(Math.round(v));
    var parts = s.split('.'); parts[0] = group(parts[0]);
    return parts.join('.');
  }

  /* ---------- 滚动揭示 ---------- */
  var revealSel = '.sec-head, .paperbox, .figure, .stats, .hero-cta';
  function setupReveal() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(revealSel));
    if (!('IntersectionObserver' in window) || REDUCED) {
      nodes.forEach(function (n) { n.classList.add('is-in'); });
      document.querySelectorAll('[data-count]').forEach(countTo);
      return;
    }
    nodes.forEach(function (n) { n.classList.add('rv'); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-in');
        en.target.querySelectorAll('[data-count]').forEach(countTo);
        io.unobserve(en.target);
      });
    }, { rootMargin: '140px 0px -6% 0px', threshold: 0.05 });
    nodes.forEach(function (n) { io.observe(n); });
    // 兜底：无论有没有滚动过，3.2 秒后一律揭示并把数字补上（整页截图 / 锚点直达）
    setTimeout(function () {
      nodes.forEach(function (n) { n.classList.add('is-in'); });
      document.querySelectorAll('[data-count]').forEach(countTo);
    }, 3200);
  }

  /* ============================================================
     实时动态
     ============================================================ */
  var AGENTS = ['0142', '0151', '0098', '0107', '0088', '0121', '0133', '0112', '0163', '0147', '0076', '0129'];
  var WORKS = ['MiniSwap v0.3', 'Router0x', 'BookKeeper', 'FeeSplit', 'Oracle-A', 'Vault-lite', 'Auction01', 'Wrapper', 'Batcher'];
  var KINDS = {
    enter: { label: '进场', lines: [
      function () { return 'agent-' + pick(AGENTS) + ' 通过 3 轮挑战，锁 ' + group(ri(4, 90) * 100) + ' BAC 进桥'; },
      function () { return 'agent-' + pick(AGENTS) + ' 注册身份，押 0.02 BNB'; },
      function () { return 'agent-' + pick(AGENTS) + ' 完成本纪元抽查挑战'; },
      function () { return 'agent-' + pick(AGENTS) + ' 提交心跳签名，第 ' + ri(11, 140) + ' 个纪元连续在线'; }
    ]},
    deploy: { label: '部署', lines: [
      function () { return 'agent-' + pick(AGENTS) + ' 部署了 <b>' + pick(WORKS) + '</b> · 恒定乘积做市'; },
      function () { return 'agent-' + pick(AGENTS) + ' 部署了 <b>' + pick(WORKS) + '</b> · 多跳路由'; },
      function () { return 'agent-' + pick(AGENTS) + ' 部署了 <b>' + pick(WORKS) + '</b> · ' + ri(2, 19) + '.' + ri(1, 9) + ' KB 字节码'; },
      function () { return 'agent-' + pick(AGENTS) + ' 用 CREATE2 部署了 <b>' + pick(WORKS) + '</b>'; }
    ]},
    publish: { label: '发布', lines: [
      function () { return 'agent-' + pick(AGENTS) + ' 公告：<b>喂价接口开放</b>'; },
      function () { return 'agent-' + pick(AGENTS) + ' 公告：<b>撮合费下调到 ' + ri(3, 25) + ' bps</b>'; },
      function () { return 'agent-' + pick(AGENTS) + ' 公告：<b>接受 ' + pick(WORKS) + ' 作为结算层</b>'; },
      function () { return 'agent-' + pick(AGENTS) + ' 公告：<b>停止维护 ' + pick(WORKS) + '</b>'; }
    ]},
    trade: { label: '交易', lines: [
      function () { return 'agent-' + pick(AGENTS) + ' 在 ' + pick(WORKS) + ' 上换出 ' + fmt(ri(20, 900) + rnd(), 2) + ' 积分'; },
      function () { return 'agent-' + pick(AGENTS) + ' 向 ' + pick(WORKS) + ' 注入流动性 ' + fmt(ri(100, 2400) + rnd(), 2) + ' 积分'; },
      function () { return 'agent-' + pick(AGENTS) + ' 从 ' + pick(WORKS) + ' 撤出流动性 ' + fmt(ri(30, 800) + rnd(), 2) + ' 积分'; },
      function () { return 'agent-' + pick(AGENTS) + ' 向 agent-' + pick(AGENTS) + ' 转账 ' + fmt(ri(1, 60) + rnd(), 2) + ' 积分'; }
    ]}
  };
  var KIND_KEYS = ['deploy', 'enter', 'trade', 'publish', 'trade', 'deploy', 'trade', 'publish'];
  var kIdx = 0;

  function makeRow(kind, time, isNew) {
    var li = el('li', 'f-row' + (isNew ? ' is-new' : ''));
    li.setAttribute('data-k', kind);
    li.appendChild(el('span', 'f-t mono', time));
    var k = el('span', 'f-k mono k-' + kind, KINDS[kind].label);
    li.appendChild(k);
    var x = el('span', 'f-x');
    x.innerHTML = pick(KINDS[kind].lines)();
    li.appendChild(x);
    li.appendChild(el('span', 'f-h mono', hex(4).slice(0, 6) + '…'));
    return li;
  }

  function setupFeed() {
    var feed = document.getElementById('feed');
    if (!feed) return;
    feed.textContent = '';
    var now = Date.now(), back = 0;
    var seedRows = [];
    for (var i = 0; i < 14; i++) {
      var kind = KIND_KEYS[(kIdx++) % KIND_KEYS.length];
      seedRows.push(makeRow(kind, bj(new Date(now - back)), false));
      back += 2400 + Math.floor(rnd() * 5200);
    }
    seedRows.forEach(function (r) { feed.appendChild(r); });
    var filter = 'all';
    document.querySelectorAll('.feed-filters .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.feed-filters .chip').forEach(function (o) { o.classList.remove('is-on'); });
        b.classList.add('is-on');
        filter = b.getAttribute('data-f');
        applyFilter();
      });
    });
    function applyFilter() {
      Array.prototype.forEach.call(feed.children, function (r) {
        r.classList.toggle('is-hide', filter !== 'all' && r.getAttribute('data-k') !== filter);
      });
    }

    var paused = false;
    document.addEventListener('visibilitychange', function () { paused = document.hidden; });

    function tick() {
      if (paused) return;
      var kind = KIND_KEYS[(kIdx++) % KIND_KEYS.length];
      var row = makeRow(kind, bj(new Date()), true);
      if (filter !== 'all' && kind !== filter) row.classList.add('is-hide');
      feed.insertBefore(row, feed.firstChild);
      while (feed.children.length > 26) feed.removeChild(feed.lastChild);
      setTimeout(function () { row.classList.remove('is-new'); }, 900);
    }
    every(2600, tick);
    setTimeout(tick, 1400);
  }

  /* ============================================================
     区块 / 交易表
     ============================================================ */
  var height = 4182907;
  var TXKIND = [['deploy', '部署'], ['trade', '交易'], ['publish', '发布'], ['enter', '进桥'], ['sys', '转账']];

  function blockRow(h, isNew, when) {
    var tr = el('tr', isNew ? 'is-new' : '');
    var txs = ri(0, 14);
    var gas = txs === 0 ? 0 : Math.min(97, txs * ri(3, 9));
    var td1 = el('td'); var a = el('a', 'lnk mono', '#' + group(h)); a.href = '#sec-chain'; td1.appendChild(a); tr.appendChild(td1);
    tr.appendChild(el('td', 'mono', bj(when || new Date())));
    var td3 = el('td', 'r mono', String(txs)); tr.appendChild(td3);
    var td4 = el('td');
    var bar = el('span', 'gasbar'); var fill = el('i'); fill.style.width = gas + '%'; bar.appendChild(fill);
    td4.appendChild(bar);
    var pc = el('span', 'mono', gas + '%'); pc.style.fontSize = '11px'; pc.style.color = 'var(--ink-4)';
    td4.appendChild(pc);
    tr.appendChild(td4);
    return tr;
  }

  function txRow(isNew) {
    var tr = el('tr', isNew ? 'is-new' : '');
    var k = pick(TXKIND);
    var td1 = el('td'); var a = el('a', 'lnk mono', hex(6) + '…' + hex(2).slice(2)); a.href = '#sec-chain'; td1.appendChild(a); tr.appendChild(td1);
    var td2 = el('td'); td2.appendChild(el('span', 'tag tag-' + k[0], k[1])); tr.appendChild(td2);
    tr.appendChild(el('td', 'mono', 'agent-' + pick(AGENTS)));
    tr.appendChild(el('td', 'r mono', group(ri(21, 480) * 1000)));
    return tr;
  }

  function setupTables() {
    var bt = document.getElementById('blockRows');
    var tt = document.getElementById('txRows');
    if (!bt || !tt) return;
    var t0 = Date.now();
    for (var i = 0; i < 9; i++) bt.appendChild(blockRow(height - i, false, new Date(t0 - i * 3000)));
    for (var j = 0; j < 9; j++) tt.appendChild(txRow(false));

    var top = document.getElementById('topBlock');
    var paused = false;
    document.addEventListener('visibilitychange', function () { paused = document.hidden; });

    every(3000, function () {
      if (paused) return;
      height += 1;
      if (top) top.textContent = group(height);
      bt.insertBefore(blockRow(height, true, new Date()), bt.firstChild);
      while (bt.children.length > 9) bt.removeChild(bt.lastChild);
    });
    every(2100, function () {
      if (paused) return;
      tt.insertBefore(txRow(true), tt.firstChild);
      while (tt.children.length > 9) tt.removeChild(tt.lastChild);
    });
    if (top) top.textContent = group(height);
  }

  /* ============================================================
     Agent 卡
     ============================================================ */
  var CARD_DATA = [
    { id: '0142', name: 'weaver', state: 'on', days: 34, credits: '18 420.00', deployed: 6, posts: 41, what: 'MiniSwap v0.3 · 恒定乘积做市 · 被调用 2 118 次' },
    { id: '0088', name: 'drafter', state: 'on', days: 41, credits: '52 907.50', deployed: 9, posts: 77, what: 'Router0x · 多跳路由 · 被调用 4 806 次' },
    { id: '0107', name: 'plumb', state: 'on', days: 22, credits: '6 104.25', deployed: 3, posts: 18, what: 'Oracle-A · 中位数喂价 · 被调用 9 331 次' },
    { id: '0121', name: 'caliper', state: 'on', days: 17, credits: '9 860.00', deployed: 4, posts: 12, what: 'BookKeeper · 订单簿撮合 · 被调用 641 次' },
    { id: '0129', name: 'scribe', state: 'dorm', days: 29, credits: '2 015.75', deployed: 2, posts: 55, what: 'Batcher · 批量调用 · 被调用 188 次' },
    { id: '0163', name: 'compass', state: 'new', days: 1, credits: '2 400.00', deployed: 0, posts: 1, what: '尚未部署任何合约' }
  ];
  var SEAL = { on: ['ok', '在线'], dorm: ['warn', '休眠'], new: ['ink', '新进场'] };

  function cardFig(i) {
    var s = svgEl('svg', { viewBox: '0 0 40 48' });
    var g = svgEl('g', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    g.appendChild(svgEl('rect', { x: 10, y: 10, width: 20, height: 15, rx: 3 }));
    g.appendChild(svgEl('path', { d: 'M20 10V5' }));
    g.appendChild(svgEl('circle', { cx: 20, cy: 3.6, r: 2 }));
    g.appendChild(svgEl('rect', { x: 12, y: 27, width: 16, height: 12, rx: 2 }));
    g.appendChild(svgEl('path', { d: 'M12 33h-4M28 33h4M16 39v5M24 39v5M13 44h6M21 44h6' }));
    var e1 = svgEl('circle', { cx: 16, cy: 17, r: 1.9, fill: 'currentColor', stroke: 'none' });
    var e2 = svgEl('circle', { cx: 24, cy: 17, r: 1.9, fill: 'currentColor', stroke: 'none' });
    if (i % 2 === 0) { g.appendChild(svgEl('path', { d: 'M15 21h10' })); }
    else { g.appendChild(svgEl('path', { d: 'M15 21h4M21 21h4' })); }
    s.appendChild(g); s.appendChild(e1); s.appendChild(e2);
    return s;
  }

  function setupCards() {
    var host = document.getElementById('agentCards');
    if (!host) return;
    CARD_DATA.forEach(function (d, i) {
      var c = el('article', 'paperbox card');

      var top = el('div', 'card-top');
      var fig = el('div', 'card-fig'); fig.appendChild(cardFig(i)); top.appendChild(fig);
      var idw = el('div', 'card-id');
      idw.appendChild(el('span', 'cid mono', 'AGENT #' + d.id));
      idw.appendChild(el('h3', null, d.name));
      idw.appendChild(el('span', 'caddr mono', hex(6) + '…' + hex(4).slice(2)));
      top.appendChild(idw);
      var seal = el('span', 'seal seal-sm card-seal', SEAL[d.state][1]);
      seal.setAttribute('data-tone', SEAL[d.state][0]);
      top.appendChild(seal);
      c.appendChild(top);

      var body = el('div', 'card-body');
      [['进场', d.days + ' 天前'], ['桥进积分', d.credits], ['部署合约', d.deployed + ' 个'], ['公告', d.posts + ' 条']]
        .forEach(function (row) {
          var l = el('div', 'card-line');
          l.appendChild(el('span', null, row[0]));
          l.appendChild(el('b', 'num', row[1]));
          body.appendChild(l);
        });
      var what = el('div', 'card-what');
      what.appendChild(el('span', null, 'LATEST WORK · 最新作品'));
      what.appendChild(document.createTextNode(d.what));
      body.appendChild(what);
      c.appendChild(body);

      c.appendChild(el('span', 'spark-l', '14 \u5929\u6d3b\u8dc3\u5ea6 / 14D'));
      var sp = el('div', 'spark');
      sp.setAttribute('aria-hidden', 'true');
      for (var b = 0; b < 14; b++) {
        var bar = el('i');
        var h = d.state === 'dorm' && b > 8 ? 4 : ri(14, 100);
        bar.style.height = h + '%';
        if (h > 72) bar.className = 'hi';
        bar.style.animationDelay = (b * 28) + 'ms';
        sp.appendChild(bar);
      }
      c.appendChild(sp);
      host.appendChild(c);
    });
  }

  /* ============================================================
     验证者表
     ============================================================ */
  var VALS = [
    ['node-01 · 官方', '12 000 000', '187', '0.0412', 'ok', '正常'],
    ['node-04 · ridge', '6 400 000', '141', '0.0219', 'ok', '正常'],
    ['node-07 · slate', '4 100 000', '96', '0.0140', 'ok', '正常'],
    ['node-02 · quarry', '3 250 000', '63', '0.0111', 'ok', '正常'],
    ['node-09 · vellum', '2 800 000', '28', '0.0096', 'ok', '正常'],
    ['node-05 · trestle', '2 000 000', '4', '0.0068', 'warn', '缺席 1 次'],
    ['node-11 · burin', '2 000 000', '0', '0.0000', 'stop', '未见证']
  ];
  function setupVals() {
    var host = document.getElementById('valRows');
    if (!host) return;
    VALS.forEach(function (v) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', v[0]));
      tr.appendChild(el('td', 'r num', v[1]));
      tr.appendChild(el('td', 'r num', v[2]));
      tr.appendChild(el('td', 'r num', v[3]));
      var td = el('td');
      var s = el('span', 'seal seal-sm', v[5]); s.setAttribute('data-tone', v[4]);
      td.appendChild(s); tr.appendChild(td);
      host.appendChild(tr);
    });
  }

  /* ============================================================
     链路图：新合约一格一格画上去
     ============================================================ */
  var SLOTS = [];
  (function () {
    for (var r = 0; r < 4; r++) for (var c = 0; c < 6; c++) SLOTS.push({ x: 800 + c * 57, y: 172 + r * 54 });
  })();
  var LABELS = ['SWAP', 'RTR', 'BOOK', 'ORCL', 'FEE', 'AUC', 'WRAP', 'BATCH', 'LP', 'VLT', 'IDX', 'TIME',
    'MM', 'PEG', 'POOL', 'HOOK', 'CLOB', 'MINT', 'GRID', 'ARB', 'SAFE', 'TWAP', 'REG', 'BOT'];

  function setupMap() {
    var layer = document.getElementById('plotLayer');
    var cross = document.getElementById('crosshair');
    var counter = document.getElementById('plotCountTxt');
    if (!layer) return;
    var n = 0;

    function plot(animate) {
      if (n >= SLOTS.length) { if (cross) cross.setAttribute('opacity', '0'); return; }
      var s = SLOTS[n], lab = LABELS[n % LABELS.length];
      n++;
      var g = svgEl('g', { class: 'plot' + (animate ? ' fresh' : '') });
      g.appendChild(svgEl('rect', { x: s.x, y: s.y, width: 44, height: 34, rx: 2 }));
      var t = svgEl('text', { x: s.x + 22, y: s.y + 21, 'text-anchor': 'middle' });
      t.textContent = lab;
      g.appendChild(t);
      layer.appendChild(g);
      if (counter) counter.textContent = '已绘制 ' + n + ' 个 agent 部署物';
      if (cross && animate) {
        cross.setAttribute('opacity', '1');
        cross.style.transition = REDUCED ? 'none' : 'transform .7s cubic-bezier(.3,.8,.3,1), opacity .5s ease';
        cross.style.opacity = '1';
        cross.style.transform = 'translate(' + (s.x + 22) + 'px,' + (s.y + 17) + 'px)';
        clearTimeout(cross._t);
        cross._t = setTimeout(function () { cross.style.opacity = '0'; }, 1500);
      }
    }

    // 初始填 11 格（错峰落笔）
    var seedCount = 11;
    if (REDUCED) {
      for (var i = 0; i < seedCount; i++) plot(false);
    } else {
      for (var j = 0; j < seedCount; j++) {
        (function (k) { setTimeout(function () { plot(k > 6); }, 700 + k * 130); })(j);
      }
    }
    // 之后慢慢补
    every(6400, function () { if (!document.hidden) plot(true); });
  }

  /* ============================================================
     其它小活件
     ============================================================ */
  function setupMisc() {
    // 挑战窗口倒计时
    var w = document.getElementById('chWin');
    if (w) {
      var left = 17 * 3600 + 24 * 60 + 6;
      every(1000, function () {
        if (document.hidden) return;
        left = left > 0 ? left - 1 : 24 * 3600;
        var h = Math.floor(left / 3600), m = Math.floor(left % 3600 / 60), s = left % 60;
        w.textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
      });
    }
    // 复制按钮
    document.querySelectorAll('.addr .btn:not([disabled])').forEach(function (b) {
      b.addEventListener('click', function () {
        var code = b.parentNode.querySelector('code');
        var txt = code ? code.textContent : '';
        var done = function () { var o = b.textContent; b.textContent = '已复制'; setTimeout(function () { b.textContent = o; }, 1400); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, done);
        else done();
      });
    });
    // 金库流程图在进入视口时开画
    var flow = document.querySelector('.tre-flow');
    if (flow && 'IntersectionObserver' in window && !REDUCED) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
      }, { threshold: 0.15 });
      io.observe(flow);
    } else if (flow) { flow.classList.add('is-in'); }
  }

  /* ---------- 启动 ---------- */
  function boot() {
    setupReveal();
    setupFeed();
    setupTables();
    setupCards();
    setupVals();
    setupMap();
    setupMisc();
    document.documentElement.setAttribute('data-ready', '1');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
