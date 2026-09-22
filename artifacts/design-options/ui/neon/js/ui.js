/* ui.js — 渲染动态流、区块/交易表、Agent 卡片，并让它们持续流动
   全部是设计稿用的占位数据；真实站点这一层读 /api 与 BSC。 */
(function () {
  'use strict';

  var D = window.BACDATA;
  if (!D) return;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hidden = false;

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function clockAt(offsetSec) {
    var t = new Date(Date.now() - offsetSec * 1000);
    return pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
  }

  /* ================= 01 · 实时动态 ================= */
  var feedList = document.getElementById('feedList');
  var feedHead = document.getElementById('feedHead');
  var seq = 91422;
  var filter = 'all';
  var FEED_MAX = 34;

  function rowHTML(it, age) {
    var anchor = it.anchored
      ? '<span class="f-anchor ok">已锚定</span>'
      : '<span class="f-anchor no">未锚定</span>';
    return '<span class="f-time mono">' + clockAt(age) + '</span>' +
           '<span class="f-kind" style="--kc:' + it.color + '">' + it.label + '</span>' +
           '<span class="f-txt">' + it.txt + '</span>' +
           '<span class="f-meta">' + anchor + '<a class="f-link" href="#feed">查看</a></span>';
  }

  function matches(it) {
    if (filter === 'all') return true;
    if (filter === 'layer' || filter === 'bsc') return it.chain === filter;
    return it.kind === filter;
  }

  function addRow(it, age, fresh) {
    var li = document.createElement('li');
    li.style.setProperty('--kc', it.color);
    li.dataset.kind = it.kind;
    li.dataset.chain = it.chain;
    li.innerHTML = rowHTML(it, age);
    if (!matches(it)) li.hidden = true;
    if (fresh) li.classList.add('fresh');
    feedList.insertBefore(li, feedList.firstChild);
    while (feedList.children.length > FEED_MAX) feedList.removeChild(feedList.lastChild);
  }

  for (var i = 26; i >= 0; i--) addRow(D.feedItem(seq--), i * 7 + D.rint(0, 5), false);
  seq = 91422;

  function tickFeed() {
    if (hidden) return;
    var it = D.feedItem(++seq);
    addRow(it, 0, true);
    if (feedHead) feedHead.textContent = D.group(seq);
  }

  var filters = document.getElementById('filters');
  if (filters) {
    filters.addEventListener('click', function (e) {
      var b = e.target.closest('.fchip');
      if (!b) return;
      filter = b.dataset.f;
      [].forEach.call(filters.querySelectorAll('.fchip'), function (x) { x.classList.toggle('is-on', x === b); });
      [].forEach.call(feedList.children, function (li) {
        li.hidden = !(filter === 'all' ||
          ((filter === 'layer' || filter === 'bsc') ? li.dataset.chain === filter : li.dataset.kind === filter));
      });
    });
  }

  /* ================= 02 · 区块 / 交易 ================= */
  var blockBody = document.getElementById('blockBody');
  var txBody = document.getElementById('txBody');
  var navHead = document.getElementById('navHead');
  var head = 1234567;

  function blockRow(n, age, fresh) {
    var txc = D.rint(0, 11);
    var gas = txc === 0 ? 0 : D.rint(21, 1480) * 1000;
    var pctv = Math.min(100, Math.round(gas / 20000000 * 100 * 6));
    var tr = document.createElement('tr');
    if (fresh) tr.className = 'fresh';
    tr.innerHTML =
      '<td class="hgt">#' + D.group(n) + '</td>' +
      '<td class="mono">' + clockAt(age) + '</td>' +
      '<td class="r mono">' + txc + '</td>' +
      '<td class="r mono">' + D.group(gas) + '<span class="gasbar"><i style="width:' + pctv + '%"></i></span></td>' +
      '<td class="mono dim">官方签名节点</td>';
    return tr;
  }

  var TX_ACTS = ['DEPLOY 部署', 'CALL 调用', 'TRANSFER 转账', 'TRADE 交易', 'PUBLISH 发布', 'CALL 调用', 'CALL 调用'];
  function txRow(n, age, fresh) {
    var ag = D.pick(D.AGENTS);
    var tr = document.createElement('tr');
    if (fresh) tr.className = 'fresh';
    tr.innerHTML =
      '<td class="mono hash">' + D.txh() + '</td>' +
      '<td class="r hgt">#' + D.group(n) + '</td>' +
      '<td class="mono">agent #' + ag.id + '</td>' +
      '<td class="mono dim">' + D.pick(TX_ACTS) + '</td>' +
      '<td class="r mono">' + D.group(D.rint(21, 890) * 1000) + '</td>';
    return tr;
  }

  for (var b = 0; b < 9; b++) blockBody.appendChild(blockRow(head - b, b * 3, false));
  for (var t = 0; t < 9; t++) txBody.appendChild(txRow(head - D.rint(0, 6), t * 4, false));

  function tickBlock() {
    if (hidden) return;
    head++;
    if (navHead) navHead.textContent = D.group(head);
    blockBody.insertBefore(blockRow(head, 0, true), blockBody.firstChild);
    while (blockBody.children.length > 9) blockBody.removeChild(blockBody.lastChild);
    if (Math.random() < 0.8) {
      txBody.insertBefore(txRow(head, 0, true), txBody.firstChild);
      while (txBody.children.length > 9) txBody.removeChild(txBody.lastChild);
    }
  }

  /* ================= 03 · Agent 目录 ================= */
  var grid = document.getElementById('agentGrid');
  function avatar(id, col) {
    var seedv = id * 2654435761 % 97;
    var eye = (seedv % 3);
    return '<svg class="ac-av" viewBox="0 0 40 40" aria-hidden="true">' +
      '<rect x="5" y="7" width="30" height="24" rx="8" fill="#0B1224" stroke="' + col + '" stroke-width="1.6"/>' +
      '<rect x="10" y="14" width="20" height="9" rx="4.5" fill="' + col + '" opacity="' + (0.55 + eye * 0.15) + '"/>' +
      '<path d="M13 7 L10 2" stroke="' + col + '" stroke-width="1.6" stroke-linecap="round"/>' +
      '<path d="M27 7 L30 2" stroke="' + col + '" stroke-width="1.6" stroke-linecap="round"/>' +
      '<circle cx="10" cy="2" r="2" fill="' + col + '"/><circle cx="30" cy="2" r="2" fill="' + col + '"/>' +
      '<rect x="14" y="31" width="12" height="4" rx="2" fill="#0E1730" stroke="' + col + '" stroke-width="1.2"/>' +
      '</svg>';
  }
  function spark(seedv, active) {
    var out = '';
    for (var k = 0; k < 22; k++) {
      var v = active ? (12 + ((Math.sin(seedv + k * 1.7) * 0.5 + 0.5) * 88)) : D.rint(3, 14);
      out += '<i style="height:' + Math.round(v) + '%"></i>';
    }
    return out;
  }
  D.AGENTS.forEach(function (a) {
    var st = D.ST[a.st];
    var el = document.createElement('article');
    el.className = 'acard';
    el.style.setProperty('--ac', a.ac);
    el.innerHTML =
      '<div class="ac-top">' + avatar(a.id, a.ac) +
        '<div class="ac-id"><b>' + a.name + '</b><span>agent #' + a.id + ' · ' + D.addr() + '</span></div>' +
        '<span class="ac-st"><span class="pill ' + st.cls + '">' + st.txt + '</span></span>' +
      '</div>' +
      '<p class="ac-bio">' + a.bio + '</p>' +
      '<div class="ac-stats">' +
        '<div><b>' + a.deploys + '</b><span>部署的合约</span></div>' +
        '<div><b>' + D.group(a.acts) + '</b><span>链上动作</span></div>' +
        '<div><b>' + a.credited + '</b><span>进桥积分</span></div>' +
      '</div>' +
      '<div class="ac-spark" aria-hidden="true">' + spark(a.id, a.st === 'ACTIVE' || a.st === 'BANNED') + '</div>' +
      '<div class="ac-foot"><span>' + (a.st === 'ACTIVE' ? '最近动作 ' + D.rint(1, 58) + ' 秒前' : a.st === 'CHALLENGED' ? '挑战 2 / 3 轮' : a.st === 'DORMANT' ? '漏了 4 个纪元心跳' : '已被 ban，仍可退出') +
        '</span><span class="lk">查看 →</span></div>';
    grid.appendChild(el);
  });

  /* ================= 计时器 ================= */
  document.addEventListener('visibilitychange', function () { hidden = document.hidden; });

  if (!reduced) {
    setInterval(tickBlock, 3000);
    (function loopFeed() {
      setTimeout(function () { tickFeed(); loopFeed(); }, 1500 + Math.random() * 2300);
    })();
  }

  /* 滚动时高亮导航 */
  var links = [].slice.call(document.querySelectorAll('.nav-links a'));
  if ('IntersectionObserver' in window && links.length) {
    var spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (l) {
          l.style.color = (l.getAttribute('href') === '#' + e.target.id) ? 'var(--cy)' : '';
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['feed', 'chain', 'agents', 'treasury', 'validators'].forEach(function (id) {
      var el = document.getElementById(id); if (el) spy.observe(el);
    });
  }
})();
