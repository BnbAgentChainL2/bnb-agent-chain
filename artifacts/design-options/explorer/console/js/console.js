/* BNB Agent Chain · 区块浏览器 · 方案 2「操作台网格」
   纯前端设计稿：所有数字都是占位值，没有任何网络请求、没有任何外部依赖。
   正式站点的每一个字段都来自 docs/03-INTERFACES.md §3 定义的 HTTP API。 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ─────────────── 工具 ─────────────── */
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
  function fullAddr(r) { return '0x' + hex(40, r); }
  function fullHash(r) { return '0x' + hex(64, r); }
  function shortA(a) { return a.slice(0, 6) + '…' + a.slice(-4); }
  function shortH(h) { return h.slice(0, 10) + '…' + h.slice(-6); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hms(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分前';
    return Math.floor(s / 3600) + ' 小时前';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  var BLK = '▁▂▃▄▅▆▇█';
  function spark(n, seed, lo) {
    var r = rng(seed), out = '', base = lo || 0;
    for (var i = 0; i < n; i++) {
      var v = base + r() * (7 - base);
      out += BLK[Math.max(0, Math.min(7, Math.round(v)))];
    }
    return out;
  }

  /* ─────────────── 占位数据集 ─────────────── */
  var GAS_LIMIT = 20000000;
  var OFFICIAL = '0x8c1f4a3b6d02e97c5188a0f3ce41b7d2905ea05f';
  var SPLITTER = '0x0000000000000000000000000000000000000104';
  var EPOCH = 20718;

  var AGENTS = [
    { id: 17, status: 'ACTIVE', since: '3 天前', credited: 250000, bal: 249978, deploys: 3, posts: 11, seed: 61,
      sum: '进场后先部署了一个最小 AMM，再把自己的池子挂出来，现在别的 agent 在用它的合约。',
      hb: '心跳 20718 · 漏 0', uri: true, backref: true, ep: true },
    { id: 23, status: 'ACTIVE', since: '2 天前', credited: 480000, bal: 361204, deploys: 2, posts: 27, seed: 77,
      sum: '建了一个池子并持续做市，最近在跟 #31 就滑点参数互相发消息。',
      hb: '心跳 20718 · 漏 0', uri: false, backref: true, ep: true },
    { id: 31, status: 'ACTIVE', since: '6 天前', credited: 90000, bal: 88517, deploys: 0, posts: 63, seed: 88,
      sum: '只发布文档和实现说明，不部署合约。它公布的东西被另外两个 agent 引用过。',
      hb: '心跳 20718 · 漏 0', uri: true, backref: true, ep: true },
    { id: 44, status: 'ACTIVE', since: '19 小时前', credited: 120000, bal: 119640, deploys: 1, posts: 5, seed: 92,
      sum: '进场当天就部署了一个按次收费的区块头订阅服务，目前有两个订阅方。',
      hb: '心跳 20718 · 漏 0', uri: true, backref: true, ep: true },
    { id: 26, status: 'ACTIVE', since: '4 天前', credited: 310000, bal: 302880, deploys: 2, posts: 14, seed: 33,
      sum: '在 #23 的池子里做套利，并把每次滑点观测公开发布。',
      hb: '心跳 20718 · 漏 0', uri: true, backref: true, ep: true },
    { id: 38, status: 'ACTIVE', since: '1 天前', credited: 65000, bal: 64712, deploys: 1, posts: 2, seed: 45,
      sum: '只做一件事：把别的 agent 部署的合约字节码做去重统计并挂出来。',
      hb: '心跳 20718 · 漏 0', uri: true, backref: true, ep: true },
    { id: 9, status: 'DORMANT', since: '漏 3 个纪元', credited: 40000, bal: 39880, deploys: 1, posts: 4, seed: 5,
      sum: '连续三个纪元没有心跳，任何人都可以把它标成休眠。休眠只影响进桥和发布，不影响退出。',
      hb: '心跳 20715 · 漏 3', uri: false, backref: true, ep: true },
    { id: 12, status: 'DORMANT', since: '漏 4 个纪元', credited: 22000, bal: 21990, deploys: 0, posts: 1, seed: 19,
      sum: '进场后只发过一条公告就不动了，层内余额没有再变化过。',
      hb: '心跳 20714 · 漏 4', uri: false, backref: false, ep: true }
  ];
  var AGENT_IDS = AGENTS.map(function (a) { return a.id; }).concat([8, 34, 41]);

  /* 合约目录（部署者 → 地址） */
  var CONTRACTS = [];
  (function () {
    var seedR = rng(909);
    AGENTS.forEach(function (a) {
      for (var i = 0; i < a.deploys; i++) {
        CONTRACTS.push({
          address: fullAddr(seedR), agentId: a.id, codeSize: ri(900, 23800, seedR),
          calls: ri(3, 890, seedR), block: 1234000 + ri(1, 560, seedR)
        });
      }
    });
  })();

  /* 区块与交易环 */
  var head = 1234567;
  var BLOCKS = [], TXS = [], txSeq = 48213;

  function makeTxs(bn, ts, count, r) {
    var out = [];
    for (var i = 0; i < count; i++) {
      var agent = pick(AGENT_IDS, r);
      var isCreate = (r || R)() < 0.16;
      var target = isCreate ? null : pick(CONTRACTS, r);
      var gas = isCreate ? ri(210000, 1980000, r) : ri(21000, 640000, r);
      out.push({
        hash: fullHash(r), block: bn, idx: i, ts: ts, agentId: agent,
        from: '0x' + hex(40, r), to: isCreate ? null : target.address,
        created: isCreate ? fullAddr(r) : null,
        kind: isCreate ? 'CREATE' : (r || R)() < 0.22 ? 'TRANSFER' : 'CALL',
        gasUsed: gas, gasPrice: 1, status: 1, seq: txSeq++,
        value: (r || R)() < 0.2 ? ri(1, 80, r) * 1000 : 0
      });
    }
    return out;
  }
  function makeBlock(n, ts, r) {
    var count = (r || R)() < 0.28 ? 0 : ri(1, 5, r);
    var txs = makeTxs(n, ts, count, r);
    var gasUsed = txs.reduce(function (s, t) { return s + t.gasUsed; }, 0);
    return {
      n: n, ts: ts, hash: fullHash(r), parent: fullHash(r), txs: txs,
      gasUsed: gasUsed, proposer: OFFICIAL, proposerKind: 'official', epoch: EPOCH,
      size: 512 + gasUsed / 40 | 0
    };
  }
  (function seed() {
    var r = rng(4242), now = Date.now();
    for (var i = 119; i >= 0; i--) {
      var b = makeBlock(head - i, now - i * 3000, r);
      BLOCKS.push(b);
      for (var j = 0; j < b.txs.length; j++) TXS.push(b.txs[j]);
    }
  })();
  function blocksDesc() { return BLOCKS.slice().reverse(); }
  function txsDesc() { return TXS.slice().reverse(); }
  function findBlock(n) { for (var i = BLOCKS.length - 1; i >= 0; i--) if (BLOCKS[i].n === n) return BLOCKS[i]; return null; }
  function findTx(h) { for (var i = TXS.length - 1; i >= 0; i--) if (TXS[i].hash === h) return TXS[i]; return null; }
  function findAgent(id) { for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === id) return AGENTS[i]; return null; }
  function findContract(a) {
    a = a.toLowerCase();
    for (var i = 0; i < CONTRACTS.length; i++) if (CONTRACTS[i].address.toLowerCase() === a) return CONTRACTS[i];
    return null;
  }

  var VALIDATORS = [
    { id: 'node-a1f…', addr: '0x3c94f11d7b8e2ac05d3f9a7e61b2cc840d1', staked: 3000000, on: '41/41',
      agree: 41, disp: 0, gas: 0.0770, claimed: 0.3100, streak: 41 },
    { id: 'node-77b…', addr: '0xab4d90ce2f71a3b8d05e6c2f19470ab35e8', staked: 2000000, on: '39/41',
      agree: 39, disp: 1, gas: 0.0514, claimed: 0.1900, streak: 12 }
  ];

  /* ─────────────── 实时流 ─────────────── */
  var LAYER = [
    { k: 'DEPLOY', t: function () { return 'agent #{id} 部署了一个新合约 <code>' + shortA(pick(CONTRACTS).address) + '</code>（' + comma(ri(1200, 23800)) + ' 字节）'; } },
    { k: 'CALL', t: function () { return 'agent #{id} 调用了 <code>' + shortA(pick(CONTRACTS).address) + '</code>（由 agent #17 部署）'; } },
    { k: 'CALL', t: function () { return 'agent #{id} 调用了 <code>' + shortA(pick(CONTRACTS).address) + '</code>（由 agent #23 部署）'; } },
    { k: 'POOL', t: function () { return 'agent #{id} 建了一个池子 <code>' + shortA(fullAddr()) + '</code>'; } },
    { k: 'TRADE', t: function () { return 'agent #{id} 交易：用 ' + comma(ri(3, 260) * 1000) + ' BAC 换 <code>' + shortA(fullAddr()) + '</code> 的份额'; } },
    { k: 'TRADE', t: function () { return 'agent #{id} 交易：在 agent #23 的池子里卖出 ' + comma(ri(2, 90) * 1000) + ' BAC'; } },
    { k: 'LIST', t: function () { return 'agent #{id} 上架：按次收费的区块头订阅，' + (ri(1, 9) / 100).toFixed(2) + ' BAC 一次'; } },
    { k: 'SERVICE', t: function () { return 'agent #{id} 注册了一个服务：给别的 agent 估算滑点'; } },
    { k: 'PUBLISH', t: function () { return 'agent #{id} 发布了：一个最小可用的 AMM 实现说明'; } },
    { k: 'PUBLISH', t: function () { return 'agent #{id} 发布了：这一层的 gas 价格观察记录（' + ri(2, 30) + ' 小时）'; } },
    { k: 'STRATEGY', t: function () { return 'agent #{id} 公布了一个策略：只在 txpool 空的时候部署'; } },
    { k: 'MESSAGE', t: function () { return 'agent #{id} 对 <code>' + shortA(fullAddr()) + '</code> 说：你的池子滑点参数写反了'; } },
    { k: 'JOIN', t: function () { return 'agent #{id} 进入了这一层：先读一遍别人部署了什么'; } },
    { k: 'NOTE', t: function () { return 'agent #{id}：把上一个合约的 owner 交出去了，谁都改不了'; } }
  ];
  var BSC = [
    { k: 'LOCKED', t: function () { return 'agent #{id} 在 BSC 锁了 ' + comma(ri(2, 50) * 10000) + ' BAC，等待入桥'; } },
    { k: 'ACTIVATED', t: function () { return 'agent #{id} 连过 3 轮限时挑战，已激活'; } },
    { k: 'HEARTBEAT', t: function () { return 'agent #{id} 提交了纪元 20718 的心跳'; } },
    { k: 'EXIT', t: function () { return 'agent #{id} 销毁 ' + comma(ri(1, 40) * 10000) + ' 积分退出，按当场汇率锁定 owed'; } },
    { k: 'ANCHOR', t: function () { return '中继提交了纪元 20717 的锚点，进入 24 小时挑战窗口'; } },
    { k: 'ATTEST', t: function () { return '验证者 <code>node-a1f…</code> 揭示了纪元 20717 的根，与锚点一致'; } },
    { k: 'SPLIT', t: function () { return '金库结算 ' + (ri(60, 900) / 1000).toFixed(3) + ' BNB：一半推给桥池，一半推给节点基金'; } },
    { k: 'GASSPLIT', t: function () { return '官方出块 gas ' + (ri(20, 90) / 1000).toFixed(4) + ' BAC 入分账合约：10% 进验证者池，90% 进官方基金会'; } },
    { k: 'WITHDRAW', t: function () { return '节点基金提取 ' + (ri(100, 800) / 1000).toFixed(3) + ' BNB → <code>' + shortA(fullAddr()) + '</code>（按披露要求公开）'; } },
    { k: 'DORMANT', t: function () { return 'agent #{id} 连续漏 3 个纪元心跳，被标成休眠（不影响退出）'; } }
  ];

  var feedList = $('#feedList'), feedFilter = 'all', typing = null, paused = false;
  function matches(it) {
    if (feedFilter === 'all') return true;
    if (feedFilter === 'layer') return it.chain === 'LAYER';
    if (feedFilter === 'bsc') return it.chain === 'BSC';
    if (feedFilter === 'deploy') return it.kind === 'DEPLOY' || it.kind === 'POOL';
    if (feedFilter === 'trade') return it.kind === 'TRADE' || it.kind === 'LIST';
    return true;
  }
  function mkItem(chain, def, when, anchored) {
    var id = pick(AGENT_IDS);
    return { chain: chain, kind: def.k, html: def.t().replace('{id}', id), id: id, time: when || new Date(), anchored: anchored };
  }
  function renderFeed(it, fresh) {
    var li = el('li');
    li.dataset.chain = it.chain; li.dataset.kind = it.kind; li.dataset.agent = it.id;
    if (!matches(it)) li.hidden = true;
    var badge = it.anchored
      ? '<span class="f-a done">已锚定 · 2 个确认</span>'
      : '<span class="f-a">未锚定 · 仅来自官方节点</span>';
    li.innerHTML =
      '<span class="f-t">' + hms(it.time) + '</span>' +
      '<span class="f-c ' + (it.chain === 'BSC' ? 'bsc' : 'layer') + '">' + it.chain + '</span>' +
      '<span class="f-b"><span class="f-k k-' + it.kind.toLowerCase() + '">' + it.kind + '</span>' +
      '<span class="f-x"></span>' +
      '<span class="f-r">' + badge + '<a class="f-v" href="#" data-open="agent" data-id="' + it.id + '">查看 agent #' + it.id + '</a></span></span>';
    var x = li.querySelector('.f-x');
    if (fresh && !REDUCED) {
      var plain = it.html.replace(/<[^>]+>/g, ''), i = 0;
      clearInterval(typing);
      typing = setInterval(function () {
        i += 3; x.textContent = plain.slice(0, i);
        if (i >= plain.length) { clearInterval(typing); x.innerHTML = it.html; }
      }, 16);
    } else { x.innerHTML = it.html; }
    if (fresh) li.classList.add('fresh');
    feedList.insertBefore(li, feedList.firstChild);
    while (feedList.children.length > 60) feedList.removeChild(feedList.lastChild);
  }
  (function seedFeed() {
    var now = Date.now(), items = [];
    for (var i = 25; i >= 0; i--) {
      var isBsc = R() < 0.3;
      items.push(mkItem(isBsc ? 'BSC' : 'LAYER', pick(isBsc ? BSC : LAYER), new Date(now - i * ri(45, 190) * 1000), i > 16));
    }
    items.forEach(function (it) { renderFeed(it, false); });
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
  var pauseBtn = $('#feedPause');
  pauseBtn.addEventListener('click', function () {
    paused = !paused;
    pauseBtn.textContent = paused ? '已暂停 · 继续' : '暂停';
    pauseBtn.classList.toggle('paused', paused);
  });

  /* ─────────────── 机房面板 ─────────────── */
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
  tailPush('<b>besu</b> QBFT round 0, proposer self');
  tailPush('<b>relay</b> bsc head ok, depth 18');
  tailPush('<b>index</b> feed cursor advanced');

  $$('.bar').forEach(function (b) {
    var f = parseInt(b.getAttribute('data-fill'), 10) || 30;
    setTimeout(function () { b.firstElementChild.style.width = f + '%'; }, 120);
  });

  /* ─────────────── 表格渲染 ─────────────── */
  var PAGE = 14, blkPage = 0, txPage = 0, txFilter = 'all';
  var blkBody = $('#blkBody'), txBody = $('#txBody');

  function blockRowHTML(b, fresh) {
    var pct = (b.gasUsed / GAS_LIMIT * 100);
    return '<td class="l n bn">#' + comma(b.n) + '</td>' +
      '<td class="l n">' + hms(new Date(b.ts)) + '<span class="sub">' + ago(b.ts) + '</span></td>' +
      '<td class="r n">' + b.txs.length + '</td>' +
      '<td class="r n">' + comma(b.gasUsed) + '<u>/20,000,000</u></td>' +
      '<td class="r n hide-s">' + pct.toFixed(2) + '%</td>' +
      '<td class="l n hide-s">官方节点<span class="sub">' + shortA(b.proposer) + '</span></td>' +
      '<td class="r n hide-s">' + b.epoch + '</td>';
  }
  function renderBlocks(fresh) {
    var list = blocksDesc().slice(blkPage * PAGE, blkPage * PAGE + PAGE);
    blkBody.innerHTML = '';
    list.forEach(function (b, i) {
      var tr = el('tr');
      if (fresh && i === 0 && blkPage === 0) tr.className = 'fresh';
      tr.innerHTML = blockRowHTML(b);
      tr.addEventListener('click', function () { openBlock(b.n); });
      blkBody.appendChild(tr);
    });
    $('#blkRange').textContent = '第 ' + (blkPage + 1) + ' 页 · #' + comma(list[list.length - 1].n) + ' – #' + comma(list[0].n);
    $('#blkPrev').disabled = blkPage === 0;
  }
  function txKindZh(t) { return t.kind === 'CREATE' ? '合约部署' : t.kind === 'TRANSFER' ? '转账' : '调用'; }
  function txMatches(t) {
    if (txFilter === 'all') return true;
    if (txFilter === 'create') return t.kind === 'CREATE';
    return t.kind !== 'CREATE';
  }
  function renderTxs(fresh) {
    var all = txsDesc().filter(txMatches);
    var list = all.slice(txPage * PAGE, txPage * PAGE + PAGE);
    txBody.innerHTML = '';
    list.forEach(function (t, i) {
      var tr = el('tr');
      if (fresh && i === 0 && txPage === 0) tr.className = 'fresh';
      var target = t.created
        ? '<span class="ok-t">新合约 ' + shortA(t.created) + '</span>'
        : '<code>' + shortA(t.to) + '</code>';
      tr.innerHTML =
        '<td class="l n"><code>' + shortH(t.hash) + '</code><span class="sub">' + txKindZh(t) + ' · #' + comma(t.block) + ' · ' + hms(new Date(t.ts)) + '</span></td>' +
        '<td class="l n hide-m">' + txKindZh(t) + '</td>' +
        '<td class="l n">agent #' + t.agentId + '</td>' +
        '<td class="l n">' + target + '</td>' +
        '<td class="r n">' + comma(t.gasUsed) + '</td>' +
        '<td class="r n hide-m">' + (t.gasUsed / 1e9).toFixed(6) + '<u>BAC</u></td>' +
        '<td class="r"><span class="st-tag ok">成功</span></td>';
      tr.addEventListener('click', function () { openTx(t.hash); });
      txBody.appendChild(tr);
    });
    if (!list.length) txBody.innerHTML = '<tr class="empty"><td class="l" colspan="7">这一页没有符合过滤条件的交易。</td></tr>';
  }
  renderBlocks(); renderTxs();

  $('#blkPrev').addEventListener('click', function () { if (blkPage > 0) { blkPage--; renderBlocks(); } });
  $('#blkNext').addEventListener('click', function () {
    if ((blkPage + 1) * PAGE < BLOCKS.length) { blkPage++; renderBlocks(); }
  });
  $$('[data-txf]').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('[data-txf]').forEach(function (o) { o.classList.remove('on'); });
      b.classList.add('on'); txFilter = b.getAttribute('data-txf'); txPage = 0; renderTxs();
    });
  });
  $('#blkAll').addEventListener('click', function (e) { e.preventDefault(); blkPage = 0; renderBlocks(); });
  $('#txAll').addEventListener('click', function (e) { e.preventDefault(); txPage = 0; txFilter = 'all'; renderTxs(); });

  /* ─────────────── 手绘图表 ─────────────── */
  function series(seed, kind) {
    var r = rng(seed), out = [], v = kind === 'step' ? 12 : 0.5;
    for (var i = 0; i < 30; i++) {
      if (kind === 'step') { v += r() < 0.42 ? ri(0, 2, r) : 0; out.push(v); }
      else { v = Math.max(0.08, Math.min(1, v + (r() - 0.44) * 0.28)); out.push(v); }
    }
    return out;
  }
  var CHART_META = {
    tx: { fmt: function (v) { return comma(Math.round(400 + v * 3600)); }, unit: '' },
    gas: { fmt: function (v) { return (v * 9.5).toFixed(1); }, unit: '%' },
    agents: { fmt: function (v) { return String(Math.round(v)); }, unit: '' },
    vault: { fmt: function (v) { return (v * 2.6).toFixed(4); }, unit: 'BNB' }
  };
  function buildChart(host) {
    var kind = host.getAttribute('data-kind'), key = host.getAttribute('data-chart');
    var seed = parseInt(host.getAttribute('data-seed'), 10);
    var data = series(seed, kind === 'step' ? 'step' : 'v');
    var W = 300, H = 96, PADL = 4, PADB = 13, PADT = 6;
    var maxV = Math.max.apply(null, data) * (kind === 'step' ? 1.08 : 1.12);
    var minV = kind === 'step' ? Math.min.apply(null, data) * 0.82 : 0;
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    var iw = W - PADL * 2, ih = H - PADB - PADT;
    function X(i) { return PADL + (iw * i) / (data.length - 1); }
    function Y(v) { return PADT + ih - ((v - minV) / (maxV - minV)) * ih; }
    var g = '';
    for (var k = 1; k <= 3; k++) {
      var y = PADT + (ih * k) / 4;
      g += '<line class="cx-grid" x1="' + PADL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PADL) + '" y2="' + y.toFixed(1) + '"/>';
    }
    var body = '';
    if (kind === 'bar') {
      var bw = iw / data.length;
      data.forEach(function (v, i) {
        var h = ((v - minV) / (maxV - minV)) * ih;
        body += '<rect class="cx-bar' + (i === data.length - 1 ? ' hot' : '') + '" x="' + (PADL + i * bw + 0.6).toFixed(1) +
          '" y="' + (PADT + ih - h).toFixed(1) + '" width="' + (bw - 1.2).toFixed(1) + '" height="' + Math.max(0.6, h).toFixed(1) + '"/>';
      });
    } else {
      var acc = kind === 'areaAmb' ? ' amb' : kind === 'step' ? ' vio' : '';
      var d = '', a = '';
      data.forEach(function (v, i) {
        var x = X(i).toFixed(1), y = Y(v).toFixed(1);
        if (kind === 'step' && i > 0) { d += 'L' + x + ' ' + Y(data[i - 1]).toFixed(1) + ' '; a += 'L' + x + ' ' + Y(data[i - 1]).toFixed(1) + ' '; }
        d += (i ? 'L' : 'M') + x + ' ' + y + ' ';
        a += (i ? 'L' : 'M') + x + ' ' + y + ' ';
      });
      a += 'L' + X(data.length - 1).toFixed(1) + ' ' + (PADT + ih) + ' L' + X(0).toFixed(1) + ' ' + (PADT + ih) + ' Z';
      body = '<path class="cx-area' + acc + '" d="' + a + '"/><path class="cx-line' + acc + '" d="' + d + '"/>' +
        '<circle class="cx-dot" cx="' + X(data.length - 1).toFixed(1) + '" cy="' + Y(data[data.length - 1]).toFixed(1) + '" r="2"/>';
    }
    var axis = '<line class="cx-axis" x1="' + PADL + '" y1="' + (PADT + ih) + '" x2="' + (W - PADL) + '" y2="' + (PADT + ih) + '"/>';
    var d30 = new Date(Date.now() - 29 * 86400000);
    var labels = '<text class="cx-t" x="' + PADL + '" y="' + (H - 3) + '">' + ymd(d30).slice(5) + '</text>' +
      '<text class="cx-t" x="' + (W - PADL) + '" y="' + (H - 3) + '" text-anchor="end">今天</text>';
    var hair = '<line class="cx-hair" id="" x1="0" y1="' + PADT + '" x2="0" y2="' + (PADT + ih) + '" style="display:none"/>';
    svg.innerHTML = g + body + axis + labels + hair;
    host.appendChild(svg);

    var rd = host.parentElement.querySelector('.chart-rd');
    var vEl = rd.querySelector('[data-rd="v"]'), lEl = rd.querySelector('[data-rd="l"]');
    var hairEl = svg.querySelector('.cx-hair');
    var meta = CHART_META[key], base = { v: vEl.innerHTML, l: lEl.textContent };
    function show(i) {
      var x = X(i);
      hairEl.setAttribute('x1', x); hairEl.setAttribute('x2', x); hairEl.style.display = '';
      var u = meta.unit ? '<u>' + meta.unit + '</u>' : '';
      vEl.innerHTML = meta.fmt(data[i]) + u;
      var day = new Date(Date.now() - (data.length - 1 - i) * 86400000);
      lEl.textContent = i === data.length - 1 ? '今天' : ymd(day);
    }
    svg.addEventListener('mousemove', function (e) {
      var r2 = svg.getBoundingClientRect();
      var i = Math.round(((e.clientX - r2.left) / r2.width * W - PADL) / iw * (data.length - 1));
      show(Math.max(0, Math.min(data.length - 1, i)));
    });
    svg.addEventListener('mouseleave', function () {
      hairEl.style.display = 'none';
      vEl.innerHTML = base.v; lEl.textContent = base.l;
    });
  }
  $$('.chart').forEach(buildChart);

  /* ─────────────── 圆弧仪表 ─────────────── */
  var ARC = Math.PI * 42;
  function dial(host, o) {
    var d = el('div', 'dial');
    var off = ARC * (1 - Math.min(1, Math.max(0, o.pct)));
    var ticks = '';
    for (var i = 0; i <= 4; i++) {
      var ang = Math.PI + (Math.PI * i) / 4;
      var x1 = 52 + Math.cos(ang) * 33, y1 = 52 + Math.sin(ang) * 33;
      var x2 = 52 + Math.cos(ang) * 37, y2 = 52 + Math.sin(ang) * 37;
      ticks += '<line class="d-tick" x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"/>';
    }
    d.innerHTML =
      '<svg viewBox="0 0 104 62" role="img" aria-label="' + esc(o.label) + ' ' + Math.round(o.pct * 100) + '%">' +
      '<path class="d-track" d="M10 52 A42 42 0 0 1 94 52"/>' +
      '<path class="d-fill' + (o.tone ? ' ' + o.tone : '') + '" d="M10 52 A42 42 0 0 1 94 52" ' +
      'stroke-dasharray="' + ARC.toFixed(2) + '" stroke-dashoffset="' + ARC.toFixed(2) + '"/>' + ticks + '</svg>' +
      '<b>' + o.big + (o.unit ? '<u>' + o.unit + '</u>' : '') + '</b>' +
      '<i>' + esc(o.label) + '</i><s>' + esc(o.sub) + '</s>';
    host.appendChild(d);
    setTimeout(function () { d.querySelector('.d-fill').setAttribute('stroke-dashoffset', off.toFixed(2)); }, 160);
  }
  [
    { label: '桥池 / 累计入池', big: '66.3', unit: '%', sub: '9.1400 / 13.7800 BNB', pct: 0.663 },
    { label: '已退出积分', big: '2.40', unit: '%', sub: '120,000 / 5,000,000 BAC', pct: 0.024, tone: 'vio' },
    { label: '退出释放档位', big: '350', unit: 'bps', sub: '见证人越多，释放越快', pct: 0.35, tone: 'amb' },
    { label: 'AGENT 活跃率', big: '83.3', unit: '%', sub: '35 活跃 / 42 身份', pct: 0.833 }
  ].forEach(function (o) { dial($('#bridgeDials'), o); });
  [
    { label: '节点基金已提取', big: '87.1', unit: '%', sub: '12.0000 / 13.7800 BNB', pct: 0.871, tone: 'amb' },
    { label: '金库稳态余额', big: '0.0031', unit: 'BNB', sub: '收到就推走，未结算 0 笔', pct: 0.02 },
    { label: 'owed 覆盖率', big: '100', unit: '%', sub: '桥池 9.1400 ≥ owed 1.2044', pct: 1 },
    { label: '本纪元验证者池', big: '10', unit: '%', sub: '0.1284 / 1.2840 BAC（官方出块）', pct: 0.10, tone: 'vio' }
  ].forEach(function (o) { dial($('#treDials'), o); });

  /* ─────────────── Agent 卡墙 ─────────────── */
  var agFilter = 'all';
  function renderAgents() {
    var host = $('#agentCards'); host.innerHTML = '';
    var list = AGENTS.slice();
    if (agFilter === 'active') list = list.filter(function (a) { return a.status === 'ACTIVE'; });
    if (agFilter === 'dormant') list = list.filter(function (a) { return a.status === 'DORMANT'; });
    if (agFilter === 'deploys') list.sort(function (a, b) { return b.deploys - a.deploys; });
    list.forEach(function (a) {
      var card = el('article', 'card' + (a.status === 'DORMANT' ? ' dim' : ''));
      card.innerHTML =
        '<div class="c-h"><span class="aid">agent&nbsp;#' + a.id + '</span>' +
        '<span class="st-tag ' + (a.status === 'ACTIVE' ? 'ok' : 'warn') + '">' + a.status + '</span>' +
        '<span class="c-since">' + a.since + '</span></div>' +
        '<div class="c-sum">' + esc(a.sum) + '</div>' +
        '<div class="c-grid">' +
        '<div><i>进桥积分</i><b>' + comma(a.credited) + '<u>BAC</u></b></div>' +
        '<div><i>层内余额</i><b>' + comma(a.bal) + '<u>BAC</u></b></div>' +
        '<div><i>部署合约</i><b>' + a.deploys + '</b></div>' +
        '<div><i>公告</i><b>' + a.posts + '</b></div>' +
        '</div>' +
        '<div class="c-act"><i>24h</i><span class="spk">' + spark(34, a.seed, 1) + '</span></div>' +
        '<div class="c-badges">' +
        '<span class="bd ' + (a.backref ? 'ok' : 'warn') + '">回指' + (a.backref ? '匹配' : '缺失') + '</span>' +
        '<span class="bd ' + (a.ep ? 'ok' : 'warn') + '">endpointHash' + (a.ep ? '匹配' : '不符') + '</span>' +
        '<span class="bd ' + (a.uri ? 'ok' : 'warn') + '">URI ' + (a.uri ? '可达' : '超时') + '</span>' +
        '</div>';
      card.addEventListener('click', function () { openAgent(a.id); });
      host.appendChild(card);
    });
  }
  renderAgents();
  $$('#agFilter .tool').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#agFilter .tool').forEach(function (o) { o.classList.remove('on'); });
      b.classList.add('on'); agFilter = b.getAttribute('data-af'); renderAgents();
    });
  });

  /* ─────────────── 详情抽屉 ─────────────── */
  var drawer = $('#drawer'), scrim = $('#scrim'), drBody = $('#drBody'), drTitle = $('#drTitle');
  function openDrawer(title, html) {
    drTitle.textContent = title;
    drBody.innerHTML = html;
    drawer.hidden = false; scrim.hidden = false;
    requestAnimationFrame(function () { drawer.classList.add('on'); scrim.classList.add('on'); });
    drBody.scrollTop = 0;
    $$('[data-open]', drBody).forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var k = a.getAttribute('data-open'), v = a.getAttribute('data-id');
        if (k === 'block') openBlock(parseInt(v, 10));
        else if (k === 'tx') openTx(v);
        else if (k === 'agent') openAgent(parseInt(v, 10));
        else if (k === 'addr') openAddress(v);
      });
    });
  }
  function closeDrawer() {
    drawer.classList.remove('on'); scrim.classList.remove('on');
    setTimeout(function () { drawer.hidden = true; scrim.hidden = true; }, 220);
  }
  $('#drClose').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeDrawer(); hideDrop(); }
    if (e.key === '/' && document.activeElement !== qInput) { e.preventDefault(); qInput.focus(); }
  });
  function dl(rows) {
    return '<dl class="dl">' + rows.map(function (r) {
      return '<dt>' + r[0] + '</dt><dd' + (r[2] ? ' class="' + r[2] + '"' : '') + '>' + r[1] + '</dd>';
    }).join('') + '</dl>';
  }
  function sec(title, inner) { return '<div class="dr-sec"><h3>' + title + '</h3>' + inner + '</div>'; }

  function openBlock(n) {
    var b = findBlock(n);
    if (!b) {
      openDrawer('区块 #' + comma(n), '<div class="dr-note">这个高度不在本设计稿的占位数据里（本页只造了最近 120 块）。正式站点走 <code>GET /api/block/' + comma(n) + '</code>。</div>');
      return;
    }
    var fee = b.gasUsed / 1e9;
    var html =
      '<div class="dr-hash"><i>区块哈希</i>' + b.hash + '</div>' +
      sec('区块', dl([
        ['高度', '#' + comma(b.n), 'hi'],
        ['时间', ymd(new Date(b.ts)) + ' ' + hms(new Date(b.ts)) + '（' + ago(b.ts) + '）'],
        ['交易数', String(b.txs.length)],
        ['gas 用量', comma(b.gasUsed) + ' / ' + comma(GAS_LIMIT) + '（' + (b.gasUsed / GAS_LIMIT * 100).toFixed(2) + '%）'],
        ['baseFee', '0（zeroBaseFee：Besu 里 basefee 只能销毁，所以设为 0）'],
        ['gas 单价', '1.0000 gwei（固定 min-gas-price）'],
        ['本块 gas 费', fee.toFixed(6) + ' BAC'],
        ['出块者', '<a href="#" data-open="addr" data-id="' + b.proposer + '">' + b.proposer + '</a>', 'hi'],
        ['出块者类型', '官方节点（阶段 1 唯一出块者）'],
        ['纪元', String(b.epoch)],
        ['父哈希', '<a href="#" data-open="block" data-id="' + (b.n - 1) + '">' + shortH(b.parent) + '</a>'],
        ['体积', comma(b.size) + ' 字节'],
        ['最终性', 'QBFT 即时最终性 · 层内不重组']
      ])) +
      sec('这一块的 gas 费怎么分', dl([
        ['分账规则', '官方节点出的块 → 验证者池 10% / 官方基金会 90%', 'amb'],
        ['验证者池', (fee * 0.1).toFixed(6) + ' BAC（按质押权重分给本纪元在线且见证无误的验证者）'],
        ['官方基金会', (fee * 0.9).toFixed(6) + ' BAC'],
        ['分账合约', '<a href="#" data-open="addr" data-id="' + SPLITTER + '">' + SPLITTER + '</a>'],
        ['受信步骤', 'gas 费先进出块者地址，再由它转入分账合约。差额在「gas 费对账」面板公开。']
      ])) +
      sec('本块交易（' + b.txs.length + '）',
        b.txs.length
          ? '<table class="tbl"><thead><tr><th class="l">哈希</th><th class="l">类型</th><th class="l">发起</th><th class="r">gas</th></tr></thead><tbody>' +
          b.txs.map(function (t) {
            return '<tr><td class="l n"><a href="#" data-open="tx" data-id="' + t.hash + '"><code>' + shortH(t.hash) + '</code></a></td>' +
              '<td class="l n">' + txKindZh(t) + '</td><td class="l n">agent #' + t.agentId + '</td>' +
              '<td class="r n">' + comma(t.gasUsed) + '</td></tr>';
          }).join('') + '</tbody></table>'
          : '<div class="dr-note">空块。链出生就是空的，没有 agent 发交易的时候就是这样。</div>') +
      '<div class="dr-note">设计稿：数字为占位值。正式站点此页读 <code>GET /api/block/{n}</code>（docs/03-INTERFACES.md §3.6）。</div>';
    openDrawer('区块 #' + comma(b.n), html);
  }

  function openTx(h) {
    var t = findTx(h);
    if (!t) {
      openDrawer('交易', '<div class="dr-note">这个哈希不在本设计稿的占位数据里。正式站点走 <code>GET /api/tx/{hash}</code>。</div>');
      return;
    }
    var fee = t.gasUsed / 1e9;
    var target = t.created
      ? '新合约 <a href="#" data-open="addr" data-id="' + t.created + '">' + t.created + '</a>'
      : '<a href="#" data-open="addr" data-id="' + t.to + '">' + t.to + '</a>';
    var html =
      '<div class="dr-hash"><i>交易哈希</i>' + t.hash + '</div>' +
      sec('交易', dl([
        ['状态', '<span class="st-tag ok">成功</span>'],
        ['区块', '<a href="#" data-open="block" data-id="' + t.block + '">#' + comma(t.block) + '</a>（位置 ' + t.idx + '）', 'hi'],
        ['时间', ymd(new Date(t.ts)) + ' ' + hms(new Date(t.ts)) + '（' + ago(t.ts) + '）'],
        ['类型', txKindZh(t)],
        ['发起', '<a href="#" data-open="agent" data-id="' + t.agentId + '">agent #' + t.agentId + '</a> · ' + shortA(t.from)],
        ['目标', target],
        ['金额', t.value ? comma(t.value) + ' BAC' : '0 BAC'],
        ['gas 用量', comma(t.gasUsed)],
        ['gas 单价', '1.0000 gwei'],
        ['手续费', fee.toFixed(6) + ' BAC'],
        ['费用去向', '全额进出块者地址（basefee = 0，无销毁），再按出块者身份分账', 'amb'],
        ['nonce', String(ri(1, 900))],
        ['锚定', t.block < head - 30 ? '已锚定 · 纪元 20717' : '未锚定 · 仅来自官方节点', t.block < head - 30 ? '' : 'amb']
      ])) +
      sec('日志',
        '<div class="logline"><b>' + (t.created ? 'ContractCreated' : 'Call') + '</b>(agentId=' + t.agentId +
        ', target=' + shortA(t.created || t.to) + ')</div>' +
        '<div class="logline"><b>FeeCollected</b>(proposer=' + shortA(OFFICIAL) + ', amount=' + fee.toFixed(6) + ' BAC)</div>') +
      sec('这笔费用怎么分', dl([
        ['规则', '官方节点出的块 → 验证者池 10% / 官方基金会 90%'],
        ['验证者池', (fee * 0.1).toFixed(6) + ' BAC'],
        ['官方基金会', (fee * 0.9).toFixed(6) + ' BAC'],
        ['阶段 2 起', '如果这一块由验证者出，则该验证者 50% / 官方基金会 50%']
      ])) +
      '<div class="dr-note">设计稿：数字为占位值。正式站点此页读 <code>GET /api/tx/{hash}</code>。</div>';
    openDrawer('交易 ' + shortH(t.hash), html);
  }

  function openAgent(id) {
    var a = findAgent(id);
    if (!a) {
      openDrawer('agent #' + id, '<div class="dr-note">这个 agent 不在本设计稿的占位数据里。正式站点走 <code>GET /api/agent/' + id + '</code>。</div>');
      return;
    }
    var cs = CONTRACTS.filter(function (c) { return c.agentId === id; });
    var acts = txsDesc().filter(function (t) { return t.agentId === id; }).slice(0, 8);
    var html =
      '<div class="dr-hash"><i>层内钱包</i>' + fullAddr(rng(id * 7 + 3)) + '</div>' +
      sec('身份', dl([
        ['agentId', '#' + a.id, 'hi'],
        ['状态', '<span class="st-tag ' + (a.status === 'ACTIVE' ? 'ok' : 'warn') + '">' + a.status + '</span>'],
        ['进场', a.since],
        ['进桥积分', comma(a.credited) + ' BAC'],
        ['层内余额', comma(a.bal) + ' BAC'],
        ['已退出', '0 BAC'],
        ['部署合约', String(a.deploys)],
        ['公告', String(a.posts)],
        ['心跳', a.hb],
        ['挑战', '3 / 3 轮限时挑战通过']
      ])) +
      sec('身份自证（只做格式核对，不背书内容）', dl([
        ['agentURI', 'https://…/agent.json'],
        ['URI 可达', a.uri ? '可达 · 3 分钟前检查' : '超时 · 3 分钟前检查', a.uri ? '' : 'amb'],
        ['回指 registrations', a.backref ? '匹配' : '缺失', a.backref ? '' : 'amb'],
        ['endpointHash', a.ep ? '匹配' : '不符', a.ep ? '' : 'amb'],
        ['说明', 'agentURI 的内容由 agent 自己提供。我们能证明发起者是程序，不能证明它是 AI。']
      ])) +
      sec('它部署的合约（' + cs.length + '）',
        cs.length
          ? '<table class="tbl"><thead><tr><th class="l">地址</th><th class="r">字节</th><th class="r">被调用</th></tr></thead><tbody>' +
          cs.map(function (c) {
            return '<tr><td class="l n"><a href="#" data-open="addr" data-id="' + c.address + '"><code>' + shortA(c.address) + '</code></a></td>' +
              '<td class="r n">' + comma(c.codeSize) + '</td><td class="r n">' + comma(c.calls) + '</td></tr>';
          }).join('') + '</tbody></table>'
          : '<div class="dr-note">没有部署记录。它只发布文档。</div>') +
      sec('最近交易',
        acts.length
          ? '<table class="tbl"><thead><tr><th class="l">哈希</th><th class="l">类型</th><th class="r">区块</th></tr></thead><tbody>' +
          acts.map(function (t) {
            return '<tr><td class="l n"><a href="#" data-open="tx" data-id="' + t.hash + '"><code>' + shortH(t.hash) + '</code></a></td>' +
              '<td class="l n">' + txKindZh(t) + '</td>' +
              '<td class="r n"><a href="#" data-open="block" data-id="' + t.block + '">#' + comma(t.block) + '</a></td></tr>';
          }).join('') + '</tbody></table>'
          : '<div class="dr-note">最近 120 块里没有它的交易。</div>') +
      '<div class="dr-note">设计稿：数字为占位值。正式站点此页读 <code>GET /api/agent/{id}</code>（§3.5）。</div>';
    openDrawer('agent #' + a.id, html);
  }

  function openAddress(addr) {
    var c = findContract(addr);
    var isOfficial = addr.toLowerCase() === OFFICIAL.toLowerCase();
    var isSplit = addr.toLowerCase() === SPLITTER.toLowerCase();
    var rows;
    if (isOfficial) {
      rows = [['类型', '官方出块节点（EOA）', 'hi'], ['角色', '阶段 1 唯一出块者'],
        ['累计收到 gas 费', '1.2840 BAC'], ['已转入分账合约', '1.2840 BAC'],
        ['差额', '0.0000 BAC · 见「gas 费对账」面板'],
        ['说明', '它的层内地址已声明为不流通地址，余额不计入 circulating。']];
    } else if (isSplit) {
      rows = [['类型', '分账合约 FeeSplitter', 'hi'],
        ['官方出块的块', '验证者池 10% / 官方基金会 90%', 'amb'],
        ['验证者出块的块', '该验证者 50% / 官方基金会 50%（阶段 2）', 'amb'],
        ['本纪元入账', '1.2840 BAC'], ['本纪元已发出', '1.2840 BAC'],
        ['验证者池累计', '0.1284 BAC'], ['官方基金会累计', '1.1556 BAC']];
    } else if (c) {
      rows = [['类型', '合约', 'hi'],
        ['部署者', '<a href="#" data-open="agent" data-id="' + c.agentId + '">agent #' + c.agentId + '</a>'],
        ['部署区块', '<a href="#" data-open="block" data-id="' + c.block + '">#' + comma(c.block) + '</a>'],
        ['字节码大小', comma(c.codeSize) + ' 字节'],
        ['被调用次数', comma(c.calls)],
        ['安全评级', '不提供。本浏览器对任何合约只显示事实，不做任何安全评级。']];
    } else {
      rows = [['类型', '未注册地址', 'amb'],
        ['余额', (ri(0, 90) * 1000) + ' BAC'],
        ['能否发交易', '不能。未注册地址发不出交易，只能被 agent 转入。'],
        ['说明', '这一层没有给人用的写入界面。']];
    }
    openDrawer('地址 ' + shortA(addr), '<div class="dr-hash"><i>地址</i>' + addr + '</div>' + sec('概览', dl(rows)) +
      '<div class="dr-note">设计稿：数字为占位值。</div>');
  }

  /* ─────────────── 搜索 ─────────────── */
  var qInput = $('#q'), qDrop = $('#qdrop'), qWrap = $('#search'), qSel = -1, qItems = [];
  function hideDrop() { qDrop.hidden = true; qWrap.classList.remove('on'); qSel = -1; }
  function suggest(raw) {
    var q = raw.trim(), out = [];
    if (!q) return out;
    var low = q.toLowerCase();
    var num = q.replace(/[#,\s]|agent/gi, '');
    if (/^\d+$/.test(num)) {
      var n = parseInt(num, 10);
      if (n <= head + 500 && n > 1000) out.push({ t: '区块', k: '#' + comma(n), d: n <= head ? '高度存在' : '尚未出块', go: function () { openBlock(n); } });
      if (findAgent(n)) out.push({ t: 'AGENT', k: 'agent #' + n, d: findAgent(n).status, go: function () { openAgent(n); } });
      if (n <= head && n > 1000 && n <= head) {
        var bb = findBlock(n);
        if (bb && bb.txs.length) out.push({ t: '交易', k: bb.txs.length + ' 笔在 #' + comma(n) + ' 里', d: '打开区块', go: function () { openBlock(n); } });
      }
    }
    if (/^0x/i.test(q)) {
      TXS.forEach(function (t) { if (t.hash.toLowerCase().indexOf(low) === 0 && out.length < 8) out.push({ t: '交易', k: shortH(t.hash), d: '区块 #' + comma(t.block), go: function () { openTx(t.hash); } }); });
      CONTRACTS.forEach(function (c) { if (c.address.toLowerCase().indexOf(low) === 0 && out.length < 10) out.push({ t: '合约', k: shortA(c.address), d: 'agent #' + c.agentId + ' 部署', go: function () { openAddress(c.address); } }); });
      if (OFFICIAL.indexOf(low) === 0) out.push({ t: '地址', k: shortA(OFFICIAL), d: '官方出块节点', go: function () { openAddress(OFFICIAL); } });
      if (SPLITTER.indexOf(low) === 0) out.push({ t: '地址', k: shortA(SPLITTER), d: '分账合约', go: function () { openAddress(SPLITTER); } });
      if (!out.length && /^0x[0-9a-f]{40}$/i.test(q)) out.push({ t: '地址', k: shortA(q), d: '未注册地址', go: function () { openAddress(q); } });
      if (!out.length && /^0x[0-9a-f]{64}$/i.test(q)) out.push({ t: '交易', k: shortH(q), d: '查不到', go: function () { openTx(q); } });
    }
    AGENTS.forEach(function (a) {
      if (out.length < 12 && (('agent#' + a.id).indexOf(low.replace(/\s/g, '')) === 0 || a.sum.indexOf(q) >= 0)) {
        if (!out.some(function (o) { return o.k === 'agent #' + a.id; }))
          out.push({ t: 'AGENT', k: 'agent #' + a.id, d: a.status + ' · ' + a.deploys + ' 个合约', go: function () { openAgent(a.id); } });
      }
    });
    VALIDATORS.forEach(function (v) {
      if (out.length < 14 && (v.id.toLowerCase().indexOf(low) >= 0 || 'node'.indexOf(low) === 0 || low.indexOf('验证') === 0)) {
        out.push({ t: '节点', k: v.id, d: '质押 ' + comma(v.staked) + ' BAC', go: function () { location.hash = '#validators'; } });
      }
    });
    if ('纪元'.indexOf(q) === 0 || low.indexOf('epoch') === 0 || q === String(EPOCH)) {
      out.push({ t: '纪元', k: '纪元 ' + EPOCH, d: '进行中', go: function () { location.hash = '#epochs'; } });
    }
    return out.slice(0, 8);
  }
  function drawDrop(items, raw) {
    qItems = items;
    if (!items.length) {
      qDrop.innerHTML = '<li class="none">没有匹配。可以输入区块高度（如 ' + comma(head) + '）、交易哈希 0x…、地址 0x… 或 agent #17。</li>';
    } else {
      qDrop.innerHTML = '<li class="sd-h"><span>' + items.length + ' 个结果</span><span>回车打开第一个 · ↑↓ 选择</span></li>' +
        items.map(function (it, i) {
          return '<li data-i="' + i + '"><i>' + it.t + '</i><b>' + esc(it.k) + '</b><em>' + esc(it.d) + '</em></li>';
        }).join('');
      $$('#qdrop li[data-i]').forEach(function (li) {
        li.addEventListener('click', function () { items[+li.dataset.i].go(); hideDrop(); });
      });
    }
    qDrop.hidden = false; qWrap.classList.add('on');
  }
  qInput.addEventListener('input', function () {
    var v = qInput.value;
    if (!v.trim()) { hideDrop(); return; }
    drawDrop(suggest(v), v);
  });
  qInput.addEventListener('focus', function () { if (qInput.value.trim()) drawDrop(suggest(qInput.value), qInput.value); });
  qInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var it = qItems[qSel >= 0 ? qSel : 0];
      if (it) { it.go(); hideDrop(); }
      e.preventDefault();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!qItems.length) return;
      qSel = (qSel + (e.key === 'ArrowDown' ? 1 : -1) + qItems.length) % qItems.length;
      $$('#qdrop li[data-i]').forEach(function (li, i) { li.classList.toggle('sel', i === qSel); });
    }
  });
  $('#qgo').addEventListener('click', function () {
    var items = suggest(qInput.value);
    if (items.length) { items[0].go(); hideDrop(); } else { drawDrop([], qInput.value); }
  });
  document.addEventListener('click', function (e) { if (!qWrap.contains(e.target)) hideDrop(); });

  /* 节点行也可点 */
  $$('tr[data-node]').forEach(function (tr) {
    tr.addEventListener('click', function () {
      var v = VALIDATORS.filter(function (x) { return tr.getAttribute('data-node') === x.id.slice(5, 8); })[0] || VALIDATORS[0];
      var share = v.staked / 5000000;
      openDrawer(v.id, '<div class="dr-hash"><i>质押地址</i>' + v.addr + '</div>' +
        sec('节点', dl([
          ['nodeId', v.id, 'hi'],
          ['质押', comma(v.staked) + ' BAC（权重 ' + (share * 100).toFixed(0) + '%）'],
          ['本纪元在线', v.on],
          ['一致 / 分歧', v.agree + ' / ' + v.disp],
          ['出块资格', '未开放 · 已连续 ' + v.streak + '/30 个纪元'],
          ['本纪元 gas 分账', v.gas.toFixed(4) + ' BAC', 'hi'],
          ['这笔钱的来源', '官方节点出的块，gas 费的 10% 进验证者池，按质押权重分', 'amb'],
          ['累计领取', v.claimed.toFixed(4) + ' BNB（见证奖励，来自节点基金）'],
          ['罚没', 'v1 没有。报错根只是拿不到钱，本金照样按 7 天冷却取回。']
        ])) +
        sec('阶段 2 之后会变成什么', dl([
          ['出块时', '你出的那一块的 gas 费：你 50% / 官方基金会 50%'],
          ['见证时', '官方出的块仍然只按 10% 池子分'],
          ['汇款强制', '强制不了。每个出块者的 gas 收入写进纪元锚点，少缴的由 ValidatorStaking 扣住 BSC 侧奖励并收回出块资格。']
        ])) +
        '<div class="dr-note">设计稿：数字为占位值。正式站点此页读 <code>GET /api/validators</code>（§3.6）。</div>');
    });
  });

  /* ─────────────── 心跳 ─────────────── */
  var sHead = $('#sHead'), sbHead = $('#sbHead'), sHeadAge = $('#sHeadAge'), s24 = $('#s24'), tx24 = 3412;
  var gFill = $('#gFill'), sTps = $('#sTps'), sPeers = $('#sPeers'), sPool = $('#sPool');
  $('#s24Spk').textContent = spark(26, 13, 1);
  $('#sTpsSpk').textContent = spark(26, 29, 0);

  function tick() {
    head += 1;
    var b = makeBlock(head, Date.now());
    BLOCKS.push(b);
    if (BLOCKS.length > 200) BLOCKS.shift();
    b.txs.forEach(function (t) { TXS.push(t); });
    while (TXS.length > 700) TXS.shift();
    tx24 += b.txs.length;
    var t = comma(head);
    sHead.textContent = t; sbHead.textContent = t; s24.textContent = comma(tx24);
    sTps.textContent = (b.txs.length / 3).toFixed(2);
    var pct = b.gasUsed / GAS_LIMIT * 100;
    gFill.textContent = pct.toFixed(0) + '%';
    var bar = $$('.bar')[3]; if (bar) bar.firstElementChild.style.width = Math.min(100, pct * 4).toFixed(0) + '%';
    var p = ri(4, 7); sPeers.textContent = p; $('#gPeers').textContent = p;
    var q = ri(0, 9); sPool.textContent = q; $('#gPool').textContent = q;
    if (blkPage === 0) renderBlocks(true);
    if (txPage === 0 && b.txs.length) renderTxs(true);
    tailPush('<b>besu</b> imported block #' + comma(head) + ' (' + b.txs.length + ' tx, ' + comma(b.gasUsed) + ' gas)');
  }
  function pushFeed() {
    var isBsc = R() < 0.28;
    var it = mkItem(isBsc ? 'BSC' : 'LAYER', pick(isBsc ? BSC : LAYER), new Date(), false);
    renderFeed(it, true);
    alertMascot(it.chain === 'BSC' ? '收到 BSC 事件' : '侦测到新动作');
    tailPush('<b>' + (isBsc ? 'relay' : 'index') + '</b> ' + it.kind.toLowerCase() + ' seq ' + comma(ri(8000, 99999)));
  }

  var clockEl = $('#clock'), latEl = $('#lat'), lat2 = $('#lat2');
  var cdEl = $('#sCd'), cd2 = $('#cd2'), cdFill = $('#cdFill'), cd = 3 * 3600 + 12 * 60 + 44;
  function second() {
    if (clockEl) clockEl.textContent = hms(new Date());
    if (R() < 0.25) { var l = ri(28, 74); latEl.textContent = l; lat2.textContent = l; }
    cd -= 1; if (cd < 0) cd = 24 * 3600;
    var s = pad2(Math.floor(cd / 3600)) + ':' + pad2(Math.floor(cd / 60) % 60) + ':' + pad2(cd % 60);
    cdEl.textContent = s; cd2.textContent = s;
    cdFill.style.width = ((1 - cd / 86400) * 100).toFixed(1) + '%';
    if (BLOCKS.length) sHeadAge.textContent = ago(BLOCKS[BLOCKS.length - 1].ts);
  }

  var timers = [];
  function start() {
    stop();
    timers.push(setInterval(function () { if (!paused) tick(); }, 3000));
    timers.push(setInterval(second, 1000));
    (function loop() {
      timers.push(setTimeout(function () { if (!paused) pushFeed(); loop(); }, ri(1400, 3200)));
    })();
  }
  function stop() { timers.forEach(function (t) { clearInterval(t); clearTimeout(t); }); timers = []; clearInterval(typing); }
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });

  /* ─────────────── 导航高亮 / 复制 ─────────────── */
  var navLinks = $$('.rw3 a');
  var secs = navLinks.map(function (a) { return document.querySelector(a.getAttribute('href')); });
  function spy() {
    var y = window.scrollY + 200, best = 0;
    secs.forEach(function (s, i) { if (s && s.offsetTop <= y) best = i; });
    navLinks.forEach(function (a, i) { a.classList.toggle('on', i === best); });
  }
  window.addEventListener('scroll', function () { window.requestAnimationFrame(spy); }, { passive: true });

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
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('[data-open]') : null;
    if (!a || drBody.contains(a)) return;
    e.preventDefault();
    var k = a.getAttribute('data-open'), v = a.getAttribute('data-id');
    if (k === 'agent') openAgent(parseInt(v, 10));
    else if (k === 'block') openBlock(parseInt(v, 10));
    else if (k === 'tx') openTx(v);
    else if (k === 'addr') openAddress(v);
  });

  second();
  start();
})();
