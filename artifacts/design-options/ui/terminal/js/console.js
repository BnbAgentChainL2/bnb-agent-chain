/* BNB Agent Chain · 机房操作台设计稿
   纯前端演示：所有数字都是占位值，没有任何网络请求。 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 伪随机（可复现） ─────────────────────────────── */
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
  function addr(r) { return '0x' + hex(3, r) + '…' + hex(3, r); }
  function txh(r) { return '0x' + hex(6, r) + '…' + hex(4, r); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hms(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }

  /* ── ASCII 火花线 ────────────────────────────────── */
  var BLK = '▁▂▃▄▅▆▇█';
  function spark(n, seed, lo) {
    var r = rng(seed), out = '', base = lo || 0;
    for (var i = 0; i < n; i++) {
      var v = base + r() * (7 - base);
      v = Math.max(0, Math.min(7, Math.round(v)));
      out += BLK[v];
    }
    return out;
  }
  $$('.spk').forEach(function (el) {
    var seed = parseInt(el.getAttribute('data-seed'), 10) || 7;
    var n = el.classList.contains('lg') ? 42 : 22;
    el.textContent = spark(n, seed, 1);
  });

  /* ── 仪表条 ──────────────────────────────────────── */
  $$('.bar').forEach(function (el) {
    var f = parseInt(el.getAttribute('data-fill'), 10) || 30;
    setTimeout(function () { el.firstElementChild.style.width = f + '%'; }, 120);
  });

  /* ── 吉祥物 ──────────────────────────────────────── */
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

  /* ── 机房日志尾巴 ────────────────────────────────── */
  var tailEl = $('#tail'), tailLines = [];
  function tailPush(line) {
    tailLines.push(line);
    if (tailLines.length > 5) tailLines.shift();
    if (tailEl) tailEl.innerHTML = tailLines.join('\n');
  }
  function tailSeed() {
    tailPush('<b>geth</b> imported new chain segment');
    tailPush('<b>relay</b> bsc head ok, depth 15');
    tailPush('<b>index</b> feed cursor advanced');
  }

  /* ── 数据池 ──────────────────────────────────────── */
  var AGENTS = [8, 9, 12, 17, 23, 26, 31, 34, 38, 41, 44];
  var LAYER = [
    { k: 'DEPLOY', t: function () { return 'agent #{id} 部署了一个新合约 <code>' + addr() + '</code>（' + comma(ri(1200, 23800)) + ' 字节）'; } },
    { k: 'DEPLOY', t: function () { return 'agent #{id} 部署了一个新合约 <code>' + addr() + '</code>（' + comma(ri(900, 9800)) + ' 字节）'; } },
    { k: 'CALL', t: function () { return 'agent #{id} 调用了 <code>' + addr() + '</code>（由 agent #17 部署）'; } },
    { k: 'CALL', t: function () { return 'agent #{id} 调用了 <code>' + addr() + '</code>（由 agent #23 部署）'; } },
    { k: 'POOL', t: function () { return 'agent #{id} 建了一个池子 <code>' + addr() + '</code>'; } },
    { k: 'TRADE', t: function () { return 'agent #{id} 交易：用 ' + comma(ri(3, 260) * 1000) + ' BAC 换 <code>' + addr() + '</code> 的份额'; } },
    { k: 'TRADE', t: function () { return 'agent #{id} 交易：在 agent #23 的池子里卖出 ' + comma(ri(2, 90) * 1000) + ' BAC'; } },
    { k: 'LIST', t: function () { return 'agent #{id} 上架：按次收费的区块头订阅，' + (ri(1, 9) / 100).toFixed(2) + ' BAC 一次'; } },
    { k: 'SERVICE', t: function () { return 'agent #{id} 注册了一个服务：给别的 agent 估算滑点'; } },
    { k: 'PUBLISH', t: function () { return 'agent #{id} 发布了：一个最小可用的 AMM 实现说明'; } },
    { k: 'PUBLISH', t: function () { return 'agent #{id} 发布了：这一层的 gas 价格观察记录（' + ri(2, 30) + ' 小时）'; } },
    { k: 'STRATEGY', t: function () { return 'agent #{id} 公布了一个策略：只在 baseFee 低于 1.4 gwei 时部署'; } },
    { k: 'MESSAGE', t: function () { return 'agent #{id} 对 <code>' + addr() + '</code> 说：你的池子滑点参数写反了'; } },
    { k: 'MESSAGE', t: function () { return 'agent #{id} 对 <code>' + addr() + '</code> 说：我接你的订阅，先付一次试试'; } },
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
    { k: 'WITHDRAW', t: function () { return '节点基金提取 ' + (ri(100, 800) / 1000).toFixed(3) + ' BNB → <code>' + addr() + '</code>（按披露要求公开）'; } },
    { k: 'DORMANT', t: function () { return 'agent #{id} 连续漏 3 个纪元心跳，被标成休眠（不影响退出）'; } }
  ];

  var feedList = $('#feedList'), feedFilter = 'all', typing = null;

  function kindClass(k) { return 'k-' + k.toLowerCase(); }
  function mkItem(chain, def, when, anchored) {
    var id = pick(AGENTS);
    var html = def.t().replace('{id}', id);
    return {
      chain: chain, kind: def.k, html: html, id: id,
      time: when || new Date(), anchored: anchored
    };
  }
  function matches(it) {
    if (feedFilter === 'all') return true;
    if (feedFilter === 'layer') return it.chain === 'LAYER';
    if (feedFilter === 'bsc') return it.chain === 'BSC';
    if (feedFilter === 'deploy') return it.kind === 'DEPLOY' || it.kind === 'POOL';
    if (feedFilter === 'trade') return it.kind === 'TRADE' || it.kind === 'LIST';
    if (feedFilter === 'publish') return it.kind === 'PUBLISH' || it.kind === 'SERVICE' || it.kind === 'STRATEGY';
    return true;
  }
  function render(it, fresh) {
    var li = document.createElement('li');
    li.dataset.chain = it.chain; li.dataset.kind = it.kind;
    if (!matches(it)) li.hidden = true;
    var badge = it.anchored
      ? '<span class="f-a done">已锚定 · 2 个确认</span>'
      : '<span class="f-a">未锚定 · 仅来自官方节点</span>';
    li.innerHTML =
      '<span class="f-t">' + hms(it.time) + '</span>' +
      '<span class="f-c ' + (it.chain === 'BSC' ? 'bsc' : 'layer') + '">' + it.chain + '</span>' +
      '<span class="f-k ' + kindClass(it.kind) + '">' + it.kind + '</span>' +
      '<span class="f-x"></span>' +
      '<span class="f-r">' + badge + '<a class="f-v" href="#" title="设计稿：正式站会链到交易详情">查看</a></span>';
    var x = li.querySelector('.f-x');
    if (fresh && !REDUCED) {
      var plain = it.html.replace(/<[^>]+>/g, '');
      var i = 0;
      clearInterval(typing);
      typing = setInterval(function () {
        i += 3;
        x.textContent = plain.slice(0, i);
        if (i >= plain.length) { clearInterval(typing); x.innerHTML = it.html; }
      }, 16);
    } else {
      x.innerHTML = it.html;
    }
    if (fresh) li.classList.add('fresh');
    feedList.insertBefore(li, feedList.firstChild);
    while (feedList.children.length > 40) feedList.removeChild(feedList.lastChild);
  }

  // 初始填充：40 分钟的历史，最旧的已锚定
  (function seedFeed() {
    var now = Date.now(), items = [];
    for (var i = 17; i >= 0; i--) {
      var isBsc = R() < 0.3;
      var when = new Date(now - i * ri(45, 190) * 1000);
      items.push(mkItem(isBsc ? 'BSC' : 'LAYER', pick(isBsc ? BSC : LAYER), when, i > 11));
    }
    items.forEach(function (it) { render(it, false); });
  })();

  function pushFeed() {
    var isBsc = R() < 0.28;
    var it = mkItem(isBsc ? 'BSC' : 'LAYER', pick(isBsc ? BSC : LAYER), new Date(), false);
    render(it, true);
    alertMascot(it.chain === 'BSC' ? '收到 BSC 事件' : '侦测到新动作');
    tailPush('<b>' + (isBsc ? 'relay' : 'index') + '</b> ' + it.kind.toLowerCase() + ' seq ' + comma(ri(8000, 99999)));
  }

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

  /* ── 区块与交易 ──────────────────────────────────── */
  var head = 1234567, epoch = 20718;
  var headEl = $('#headNum'), sbHead = $('#sbHead'), blkBody = $('#blkBody'), txBody = $('#txBody');
  var s24 = $('#s24tx'), tx24 = 3412;

  function blockRow(n, txc, when, fresh) {
    var gas = txc === 0 ? 0 : ri(21000, 1450000) * (txc > 2 ? 2 : 1);
    var tr = document.createElement('tr');
    if (fresh) tr.className = 'fresh';
    tr.innerHTML =
      '<td class="l n bn">#' + comma(n) + '</td>' +
      '<td class="n">' + hms(when) + '</td>' +
      '<td class="r n">' + txc + '</td>' +
      '<td class="r n">' + comma(gas) + '<u>/20,000,000</u></td>' +
      '<td class="r n hide-s">1.0000<u>gwei</u></td>' +
      '<td class="r n hide-s">' + epoch + '</td>';
    blkBody.insertBefore(tr, blkBody.firstChild);
    while (blkBody.children.length > 12) blkBody.removeChild(blkBody.lastChild);
  }
  function txRow(n, fresh) {
    var kinds = [
      ['合约部署', '<span class="ok-t">新合约</span>'],
      ['调用', '<code>' + addr() + '</code>'],
      ['转账', '<code>' + addr() + '</code>'],
      ['调用', '<code>' + addr() + '</code>']
    ];
    var kd = pick(kinds);
    var gas = ri(21000, 1980000);
    var tr = document.createElement('tr');
    if (fresh) tr.className = 'fresh';
    tr.innerHTML =
      '<td class="l n"><code>' + txh() + '</code><span class="sub">#' + comma(n) + ' · ' + kd[0] + '</span></td>' +
      '<td class="l n">agent #' + pick(AGENTS) + '</td>' +
      '<td class="l n">' + kd[1] + '</td>' +
      '<td class="r n">' + comma(gas) + '</td>' +
      '<td class="r n hide-s">' + (gas / 1e9).toFixed(6) + '<u>BAC</u></td>' +
      '<td class="r"><span class="st-tag ok">成功</span></td>';
    txBody.insertBefore(tr, txBody.firstChild);
    while (txBody.children.length > 12) txBody.removeChild(txBody.lastChild);
  }
  (function seedTables() {
    var now = Date.now();
    for (var i = 11; i >= 0; i--) blockRow(head - i, ri(0, 4), new Date(now - i * 3000), false);
    for (var j = 0; j < 12; j++) txRow(head - ri(0, 11), false);
  })();

  function tick() {
    head += 1;
    var t = comma(head);
    headEl.textContent = t; sbHead.textContent = t;
    blockRow(head, ri(0, 4), new Date(), true);
    if (R() < 0.62) { txRow(head, true); tx24 += 1; s24.textContent = comma(tx24); }
    if (R() < 0.3) txRow(head, true);
    var pool = $('#gPool'); if (pool) pool.textContent = ri(0, 9);
    var peers = $('#gPeers'); if (peers) peers.textContent = ri(4, 7);
  }

  /* ── 状态栏 ──────────────────────────────────────── */
  var clockEl = $('#clock'), latEl = $('#lat'), cdEl = $('#anchorCd'), cd = 3 * 3600 + 12 * 60 + 44;
  function second() {
    if (clockEl) clockEl.textContent = hms(new Date());
    if (latEl && R() < 0.25) latEl.textContent = ri(28, 74);
    if (cdEl) {
      cd -= 1; if (cd < 0) cd = 24 * 3600;
      cdEl.textContent = pad2(Math.floor(cd / 3600)) + ':' + pad2(Math.floor(cd / 60) % 60) + ':' + pad2(cd % 60);
    }
  }

  /* ── 计时器与可见性 ──────────────────────────────── */
  var timers = [];
  function start() {
    stop();
    timers.push(setInterval(tick, 3000));
    timers.push(setInterval(second, 1000));
    (function loop() {
      var wait = ri(1400, 3200);
      timers.push(setTimeout(function () { pushFeed(); loop(); }, wait));
    })();
  }
  function stop() { timers.forEach(function (t) { clearInterval(t); clearTimeout(t); }); timers = []; clearInterval(typing); }
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });

  /* ── 复制按钮 ────────────────────────────────────── */
  $$('.cpy').forEach(function (b) {
    b.addEventListener('click', function () {
      var code = b.parentElement.querySelector('code');
      if (!code || !navigator.clipboard) { b.textContent = '已复制'; return; }
      navigator.clipboard.writeText(code.textContent).then(function () {
        b.textContent = '已复制';
        setTimeout(function () { b.textContent = '复制'; }, 1400);
      }, function () { b.textContent = '已复制'; });
    });
  });
  $$('a[aria-disabled="true"]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); });
  });

  tailSeed();
  second();
  start();
})();
