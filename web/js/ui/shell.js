/* BNB Agent Chain · 可视层 · 外壳（顶栏 / 链指标条 / 路由 / 搜索 / 状态栏）
   页面上所有「单个数字」的插槽都用 data-vm 标出来，由这里统一刷新：
     <b data-vm="chain.head" data-st="chain" data-fmt="int">发射后公布</b>
   data-st 指哪一段的状态，data-fmt 指怎么格式化。取不到值时按状态显示
   「发射后公布」/「读取中…」/「读取失败 · 重试中」，**永远不显示演示值**。 */
(function (root) {
  'use strict';

  var UI = root.BACUI;
  if (!UI || !UI.pages) {
    if (root.console) root.console.error('[BACUI] shell.js 需要先加载 js/ui/pages.js');
    return;
  }
  if (UI.shell) return;

  var VM = root.BACVM, P = UI.pages;
  var $ = UI.$, $$ = UI.$$, esc = UI.esc, comma = UI.comma, miss = UI.miss;

  /* ══════════════════ data-vm 插槽 ══════════════════ */

  var FMT = {
    int: UI.int,
    comma: UI.comma,
    bac: function (v) { return UI.bac(v, 6); },
    bac4: function (v) { return UI.bac(v, 4); },
    bac5: function (v) { return UI.bac(v, 5); },
    bnb: UI.bnb,
    token: UI.tokenAmt,
    pct: UI.pct,
    bps: function (v) { return String(v); },
    gwei: function (v) { return UI.units(v, 4, 9); },
    ago: UI.ago,
    hms: UI.hms,
    left: UI.hmsLeft,
    tps: function (v) { return Number(v).toFixed(2); },
    sec: function (v) { return Number(v).toFixed(1); },
    raw: function (v) { return String(v); }
  };

  function paintSlots() {
    $$('[data-vm]').forEach(function (el) {
      var p = el.getAttribute('data-vm');
      var sKey = el.getAttribute('data-st') || 'chain';
      var f = el.getAttribute('data-fmt') || 'raw';
      var status = VM.st[sKey] || 'pre';
      var v = UI.path(VM, p);
      el.textContent = UI.val(status, v, FMT[f] || FMT.raw);
    });
  }

  /* ══════════════════ 链指标条 / 状态栏 ══════════════════ */

  function paintStrip() {
    var c = VM.chain, s = VM.st.chain;

    /* 复合插槽：一个格子里两个数，单独拼 */
    var ag = c.agentCounts;
    UI.setHTML('#ssAgents', ag
      ? comma(ag.active) + '<u>/' + comma(ag.total) + '</u>'
      : esc(miss(VM.st.agents)));
    UI.setText('#ssAgentsSub', ag
      ? ag.dormant + ' 休眠 · ' + ag.banned + ' 封禁'
      : miss(VM.st.agents));

    UI.setHTML('#ssVal', c.nodeCount !== null && c.nodeCount !== undefined
      ? comma(c.nodeCount) + '<u>/' + (c.nodeSlots || 64) + '</u>'
      : esc(miss(VM.st.validators)));
    UI.setText('#ssValSub', VM.validators.totalStaked !== null && VM.validators.totalStaked !== undefined
      ? '质押 ' + UI.tokenAmt(VM.validators.totalStaked) + ' BAC'
      : miss(VM.st.validators));

    UI.setHTML('#ssPeers', (c.peers !== null && c.peers !== undefined) || (c.txPool !== null && c.txPool !== undefined)
      ? (c.peers == null ? '—' : c.peers) + '<u>/' + (c.txPool == null ? '—' : c.txPool) + '</u>'
      : esc(miss(s)));

    UI.setHTML('#ssBlockTime', c.blockTimeSec !== null && c.blockTimeSec !== undefined
      ? Number(c.blockTimeSec).toFixed(1) + '<u>s</u>'
      : esc(miss(s)));

    UI.setHTML('#ssGasPrice', '1.0000<u>gwei</u>');

    UI.setHTML('#ssPool', c.bridgePool !== null && c.bridgePool !== undefined
      ? UI.bnb(c.bridgePool) + '<u>BNB</u>'
      : esc(miss(VM.st.treasury)));

    var epLink = $('#ssEpoch');
    if (epLink) {
      if (c.epoch == null) epLink.textContent = miss(s);
      else epLink.innerHTML = '<a href="#/epoch/' + c.epoch + '">' + c.epoch + '</a>';
    }
    UI.setText('#ssEpochSub', c.lastPostedEpoch != null ? c.lastPostedEpoch + ' 挑战窗口' : miss(VM.st.epochs));

    /* 顶栏 HEAD + 状态栏 */
    UI.setText('#headNum', c.head == null ? miss(s) : comma(c.head));
    UI.setText('#sbHead', c.head == null ? miss(s) : comma(c.head));
    UI.setText('#sbEpoch', c.epoch == null ? miss(s) : String(c.epoch));
    UI.setText('#sbAnchor', c.lastPostedEpoch == null ? miss(VM.st.epochs) : c.lastPostedEpoch + ' POSTED');
    UI.setText('#ssHeadAgo', c.headTs == null ? '' : UI.ago(c.headTs));

    /* 三个服务灯：只有真读到才点亮，读不到就是灰的 */
    setLed('#ledNode', VM.st.chain === 'ok' ? 'ok' : (VM.st.chain === 'error' ? 'bad' : 'idle'));
    setLed('#ledRelay', VM.st.epochs === 'ok' ? 'ok' : (VM.st.epochs === 'error' ? 'bad' : 'idle'));
    setLed('#ledIndex', VM.chain.degraded ? 'bad' : (VM.st.feed === 'ok' ? 'ok' : 'idle'));

    var live = $('#sbLive');
    if (live) {
      live.className = 'sb-k ' + (VM.mode === 'live' && VM.st.chain === 'ok' ? 'ok' : 'idle');
      live.innerHTML = '<b></b>' + (VM.mode === 'demo' ? 'DEMO' : (VM.mode === 'live' ? 'LIVE' : 'PRE'));
    }

    /* 降级横幅：索引器挂了也要把 BSC 那一半照常显示，并说清楚 */
    var warn = $('#degradedBar');
    if (warn) {
      if (VM.chain.degradedNote) { warn.hidden = false; warn.textContent = VM.chain.degradedNote; }
      else warn.hidden = true;
    }
    var demoBar = $('#demoBar');
    if (demoBar) demoBar.hidden = VM.mode !== 'demo';

    paintAddrs();
  }

  /** 页脚地址行：发射前是「发射后公布」，配好地址之后逐字显示并可复制。
      只认这里的地址 —— 所以它必须来自 site.config.js，而不是写死在 HTML 里。 */
  function paintAddrs() {
    $$('.addr[data-addr]').forEach(function (row) {
      var key = row.getAttribute('data-addr');
      var a = VM.addresses ? VM.addresses[key] : null;
      var code = row.querySelector('code');
      var btn = row.querySelector('.cpy');
      var ok = typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && /[1-9a-f]/.test(a.slice(2));
      if (code) code.textContent = ok ? a : UI.TEXT.PRE;
      if (btn) btn.disabled = !ok;
    });
  }

  function setLed(sel, kind) {
    var el = $(sel); if (!el) return;
    el.classList.remove('ok', 'bad', 'idle');
    el.classList.add(kind);
  }

  /* 倒计时：纪元剩余秒数，每秒本地递减，来源仍然是链上时间 */
  function paintCountdown() {
    var left = VM.chain.epochLeftSec;
    var s = left === null || left === undefined ? miss(VM.st.chain) : UI.hmsLeft(left);
    ['#ssAnchor', '#anchorCd', '#cd2', '#epCd'].forEach(function (sel) { UI.setText(sel, s); });
    var fill = $('#cdFill');
    if (fill) fill.style.width = (left === null ? 0 : (100 - left / 864)).toFixed(1) + '%';
  }

  /* ══════════════════ 路由 ══════════════════ */

  var PARENT = { block: 'blocks', tx: 'txs', agent: 'agents', search: '', contract: 'agents', epoch: 'epochs' };
  var TITLES = {
    overview: 'BNB Agent Chain · 区块浏览器', blocks: '区块 · BAC', txs: '交易 · BAC',
    agents: 'Agent 目录 · BAC', treasury: '金库 · BAC', validators: '验证者 · BAC',
    epochs: '纪元与锚点 · BAC', contract: '合约 · BAC', search: '搜索 · BAC', tx: '交易 · BAC'
  };
  var curView = 'overview', curArg = null;

  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    var v = parts[0] || 'overview', arg = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (!$('#v-' + v)) { v = 'overview'; arg = null; }
    curView = v; curArg = arg;

    renderView(v, arg);

    $$('.view').forEach(function (sec) { sec.hidden = sec.dataset.view !== v; });
    var navKey = PARENT[v] !== undefined ? PARENT[v] : v;
    $$('#nav a').forEach(function (a) { a.classList.toggle('on', a.dataset.v === navKey); });
    root.scrollTo(0, 0);
    if (shellEl) { shellEl.classList.remove('cond'); condOn = false; }
    requestAnimationFrame(function () { P.drawAll(); markFades(); });
    document.title = TITLES[v] ||
      ({ epoch: '纪元 ' + arg + ' · BAC', block: '区块 #' + arg + ' · BAC', agent: 'agent #' + arg + ' · BAC' })[v] ||
      'BNB Agent Chain';
  }

  function renderView(v, arg) {
    if (v === 'overview') { P.renderOverviewTables(); P.renderFeed(); }
    else if (v === 'blocks') P.renderBlocks();
    else if (v === 'txs') P.renderTxs();
    else if (v === 'agents') P.renderAgents();
    else if (v === 'treasury') P.renderTreasury();
    else if (v === 'validators') P.renderValidators();
    else if (v === 'epochs') P.renderEpochs();
    else if (v === 'epoch') P.renderEpochDetail(parseInt(arg, 10));
    else if (v === 'block') P.renderBlockDetail(parseInt(arg, 10));
    else if (v === 'tx') P.renderTxDetail(arg);
    else if (v === 'agent') P.renderAgentDetail(parseInt(arg, 10));
    else if (v === 'contract') P.renderContractDetail(arg);
    else if (v === 'search') P.renderSearchPage(arg || '');
  }

  /** 数据变了：重画当前页 + 所有插槽。bind.js 每次拿到新数据都调它。 */
  function refresh() {
    paintSlots();
    paintStrip();
    paintCountdown();
    renderView(curView, curArg);
    P.drawAll();
    markFades();
  }

  /* ══════════════════ 搜索框 ══════════════════ */

  var qEl, sres, sresList, sresN, sErr, suggIdx = -1, suggList = [];

  function closeSres() {
    if (!sres) return;
    sres.hidden = true; sresList.innerHTML = ''; suggIdx = -1; suggList = [];
    sErr.hidden = true;
    qEl.setAttribute('aria-expanded', 'false');
    qEl.removeAttribute('aria-activedescendant');
  }
  function searchError(msg) {
    if (!sErr) return;
    sErr.textContent = msg; sErr.hidden = false; sres.hidden = false;
    qEl.setAttribute('aria-expanded', 'true');
    clearTimeout(searchError._t);
    searchError._t = setTimeout(function () { sErr.hidden = true; if (!suggList.length) closeSres(); }, 6500);
  }
  function hintText() {
    return VM.st.blocks === 'pre'
      ? '还没有发射：链上还没有区块、交易或 agent 可以搜。'
      : '可以输入：区块高度、0x 开头的交易哈希 / 地址 / 合约地址、agent 编号（如 #17）、纪元号。';
  }
  function paintSugg() {
    if (!qEl) return;
    suggList = P.searchAll(qEl.value);
    if (!suggList.length) {
      if (!qEl.value.trim()) { closeSres(); return; }
      sresList.innerHTML = '<div class="sr-none">没有匹配「' + esc(qEl.value.trim()) + '」。' + esc(hintText()) + '</div>';
      sresN.innerHTML = '<b>0</b> 个结果　当前范围：' + esc(P.SCOPE_ZH[P.getScope()]);
      sres.hidden = false; suggIdx = -1;
      qEl.setAttribute('aria-expanded', 'true');
      return;
    }
    sresList.innerHTML = suggList.map(function (r, i) {
      return '<a role="option" id="sg' + i + '" href="' + esc(r.h) + '" data-i="' + i + '"><i>' + esc(r.k) + '</i>' +
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

  function wireSearch() {
    qEl = $('#q'); sres = $('#sres'); sresList = $('#sresList'); sresN = $('#sresN'); sErr = $('#serr');
    if (!qEl) return;
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
    $$('#scope .chip').forEach(function (b, i, all) {
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        all.forEach(function (o) { o.classList.remove('on'); o.setAttribute('aria-pressed', 'false'); });
        b.classList.add('on'); b.setAttribute('aria-pressed', 'true');
        P.setScope(b.dataset.s);
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
      var res = P.searchAll(raw);
      if (res.length === 1) { closeSres(); qEl.blur(); location.hash = res[0].h; return; }
      if (res.length) { closeSres(); qEl.blur(); location.hash = '#/search/' + encodeURIComponent(raw); return; }
      searchError('看不懂「' + raw + '」。' + hintText());
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault(); qEl.focus(); qEl.select();
    });
  }

  /* ══════════════════ 交互杂项 ══════════════════ */

  function wireChips(sel, s, render) {
    $$(sel + ' .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        $$(sel + ' .chip').forEach(function (o) { o.classList.remove('on'); });
        b.classList.add('on'); s.filter = b.dataset.k; s.page = 0; render();
      });
    });
  }

  var shellEl = null, condOn = false;
  function onScroll() {
    if (!shellEl) return;
    var want = root.scrollY > 46;
    if (want === condOn) return;
    condOn = want;
    shellEl.classList.toggle('cond', want);
  }
  function markFades() {
    $$('.tw').forEach(function (w) { w.classList.toggle('no-fade', w.scrollWidth <= w.clientWidth + 1); });
  }

  function wireRest() {
    shellEl = document.querySelector('.shell');

    document.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-go]');
      if (tr && !e.target.closest('a')) { location.hash = tr.dataset.go; return; }
      var a = e.target.closest('a[aria-disabled="true"]');
      if (a) e.preventDefault();
    });

    wireChips('#blkChips', P.state.blocks, P.renderBlocks);
    wireChips('#txChips', P.state.txs, P.renderTxs);
    wireChips('#agChips', P.state.agents, P.renderAgents);
    var agq = $('#agq');
    if (agq) agq.addEventListener('input', function () { P.state.agents.q = this.value; P.state.agents.page = 0; P.renderAgents(); });

    $$('#chips .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#chips .chip').forEach(function (o) { o.classList.remove('on'); });
        b.classList.add('on');
        P.setFeedFilter(b.dataset.k);
      });
    });

    $$('.cpy').forEach(function (b) {
      b.addEventListener('click', function () {
        var code = b.parentElement.querySelector('code');
        if (!code || !navigator.clipboard) { b.textContent = '已复制'; return; }
        navigator.clipboard.writeText(code.textContent).then(function () {
          b.textContent = '已复制'; setTimeout(function () { b.textContent = '复制'; }, 1400);
        }, function () { b.textContent = '已复制'; });
      });
    });

    root.addEventListener('scroll', onScroll, { passive: true });
    var rt;
    root.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { P.drawAll(); markFades(); }, 140);
    });
    root.addEventListener('hashchange', route);
  }

  /* 本地秒表：只驱动时钟和纪元倒计时，不产生任何链上数字 */
  var secTimer = null;
  function startClock() {
    if (secTimer) clearInterval(secTimer);
    secTimer = setInterval(function () {
      var el = $('#clock');
      if (el) el.textContent = UI.hms(UI.now());
      if (VM.chain.epochLeftSec != null && VM.chain.epochLeftSec > 0) VM.chain.epochLeftSec -= 1;
      paintCountdown();
      var ssa = $('#ssHeadAgo');
      if (ssa && VM.chain.headTs != null) ssa.textContent = UI.ago(VM.chain.headTs);
    }, 1000);
  }

  function boot() {
    wireSearch();
    wireRest();
    refresh();
    route();
    startClock();
  }

  UI.shell = {
    boot: boot, refresh: refresh, route: route,
    paintSlots: paintSlots, paintStrip: paintStrip, markFades: markFades
  };
  UI.refresh = refresh;
})(typeof window !== 'undefined' ? window : globalThis);
