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

    /* 已进场 agent：v2（决策 #31）没有状态机，数据层的 counts 里只有 total 是真的，
       active / dormant / banned 一律 null —— 只写进场过的身份数，不拼「休眠 · 封禁」。
       下面那行小字（算的是什么）写死在 index.html 里。 */
    var ag = c.agentCounts;
    var agTotal = ag && ag.total !== null && ag.total !== undefined ? ag.total : null;
    UI.setHTML('#ssAgents', agTotal !== null ? comma(agTotal) : esc(miss(VM.st.agents)));

    UI.setHTML('#ssVal', c.nodeCount !== null && c.nodeCount !== undefined
      ? comma(c.nodeCount) + '<u>/' + (c.nodeSlots || 64) + '</u>'
      : esc(miss(VM.st.validators)));
    /* 总质押：质押合约没部署时 bind.js 已经把它置成 null（索引器那边的默认 0 不是「质押了 0」，是没有这份账），
       这里只在真有数时才写数字；发射前写「质押发射后开放」，不写 0。 */
    UI.setText('#ssValSub', VM.validators.totalStaked !== null && VM.validators.totalStaked !== undefined
      ? '质押 ' + UI.tokenAmt(VM.validators.totalStaked) + ' BAC'
      : (VM.st.validators === 'pre' ? '质押发射后开放' : miss(VM.st.validators)));

    /* peers / txpool：Besu 默认不开 TXPOOL API（实测 -32601），读不到就写「—」，不写 0 */
    UI.setHTML('#ssPeers', (c.peers !== null && c.peers !== undefined) || (c.txPool !== null && c.txPool !== undefined)
      ? (c.peers == null ? '—' : c.peers) + '<u>/' + (c.txPool == null ? '—' : c.txPool) + '</u>'
      : esc(miss(s)));

    UI.setHTML('#ssBlockTime', c.blockTimeSec !== null && c.blockTimeSec !== undefined
      ? Number(c.blockTimeSec).toFixed(1) + '<u>s</u>'
      : esc(miss(s)));

    /* gas 单价：eth_gasPrice 的真实读数，读不到才按状态显示占位 —— 不再写死 1.0000 */
    UI.setHTML('#ssGasPrice', c.gasPrice !== null && c.gasPrice !== undefined
      ? esc(UI.units(c.gasPrice, 4, 9)) + '<u>gwei</u>'
      : esc(miss(s)));

    UI.setHTML('#ssPool', c.bridgePool !== null && c.bridgePool !== undefined
      ? UI.bnb(c.bridgePool) + '<u>BNB</u>'
      : esc(miss(VM.st.treasury)));

    var epLink = $('#ssEpoch');
    if (epLink) {
      if (c.epoch == null) epLink.textContent = miss(s);
      else epLink.innerHTML = '<a href="#/epoch/' + c.epoch + '">' + c.epoch + '</a>';
    }
    UI.setText('#ssEpochSub', c.lastPostedEpoch != null ? c.lastPostedEpoch + ' 锚点等待中' : miss(VM.st.epochs));

    /* 顶栏 HEAD + 状态栏 */
    UI.setText('#headNum', c.head == null ? miss(s) : comma(c.head));
    UI.setText('#sbHead', c.head == null ? miss(s) : comma(c.head));
    UI.setText('#sbEpoch', c.epoch == null ? miss(s) : String(c.epoch));
    UI.setText('#sbAnchor', c.lastPostedEpoch == null ? miss(VM.st.epochs) : c.lastPostedEpoch + ' POSTED');
    UI.setText('#ssHeadAgo', c.headTs == null ? '' : UI.ago(c.headTs));

    /* 三个服务灯：只有真读到才点亮，读不到就是灰的。
       NODE = 层内出块节点（现在就在出块）；RELAY = 中继（要 BSC 的 ChainAnchor，还没部署）；
       INDEX = 索引器（已部署在同一台主机上，答话才点亮）。 */
    setLed('#ledNode', VM.st.chain === 'ok' ? 'ok' : (VM.st.chain === 'error' ? 'bad' : 'idle'));
    setLed('#ledRelay', VM.st.epochs === 'ok' ? 'ok' : (VM.st.epochs === 'error' ? 'bad' : 'idle'));
    setLed('#ledIndex', VM.st.idx === 'ok' ? 'ok' : 'idle');

    /* LIVE 看的是**层内链在不在出块**，不是 BSC 侧发射了没有 */
    var live = $('#sbLive');
    if (live) {
      var isLive = VM.mode === 'live' && VM.st.chain === 'ok';
      live.className = 'sb-k ' + (isLive ? 'ok' : (VM.st.chain === 'error' ? 'bad' : 'idle'));
      live.innerHTML = '<b></b>' + (VM.mode === 'demo' ? 'DEMO' : (isLive ? 'LIVE' : (VM.st.chain === 'error' ? 'DOWN' : 'WAIT')));
      live.title = VM.mode === 'demo' ? '演示模式'
        : (isLive ? '层内链正在出块（chainId ' + (VM.chain.chainId || '—') + '）' : '还没读到层内块高');
    }

    /* 首屏链头卡片上的那颗呼吸点：同一个判断 —— 读到了才金，读失败是红，还没读到是灰 */
    var hl = $('#heroLive');
    if (hl) {
      hl.classList.remove('bad', 'idle');
      if (VM.st.chain === 'error') hl.classList.add('bad');
      else if (VM.st.chain !== 'ok') hl.classList.add('idle');
    }

    paintSource();
    paintBars();
    paintAddrs();
  }

  /** 「这个数字是谁给的」：面板小标 [data-src] 与页脚 / 状态栏的端点地址。
      直读 RPC 时必须如实写「直读层内 RPC · 索引器读不到 / 读取中」，不许装成索引器给的；
      索引器第一轮还没回来（'loading'）时不许说它读不到。 */
  function paintSource() {
    var src = VM.layer && VM.layer.source ? VM.layer.source : null;
    var label = VM.mode === 'demo' ? '演示模式 · 不连任何节点' : UI.srcLabel(src);
    $$('[data-src]').forEach(function (el) {
      var kind = el.getAttribute('data-src');
      if (kind === 'layer') el.textContent = label;
      else if (kind === 'idx') el.textContent = UI.idxLabel();
      else if (kind === 'bsc') el.textContent = VM.mode === 'demo' ? '演示模式' : 'BSC · 合约未部署';
      else if (kind === 'endpoint') el.textContent = shortEp(VM.layer && VM.layer.endpoint);
    });
    UI.setText('#sbRpc', shortEp(VM.layer && VM.layer.endpoint));
    UI.setText('#navRpc', shortEp(VM.layer && VM.layer.endpoint));
  }

  /** 端点地址只显示主机名，够核对又不至于撑破一行。 */
  function shortEp(u) {
    if (!u) return '—';
    try { return String(u).replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
    catch (e) { return String(u); }
  }

  /** 顶部横幅：说清楚现在**哪一半是实时的、哪一半还不存在**，不夸大。
      现在出块的是演练链 —— 这一条必须照实写在最前面：创世预置了测试 BAC（桥里是 0），
      预置账户的私钥是公开的 Hardhat 测试私钥（谁都能发交易），发射时重建、数据清空；
      v1 只有官方一个验证者，但演练链的只读同步已经公开（HANDOFF §2），验证者发射后才开放。
      数据源照实说：索引器在供数时区块与交易来自同一台主机上的索引 API，不是「直接读节点」；
      「索引器读不到」只在 VM.st.idx === 'noidx' 时说，'loading'（第一轮还没回来）不算。
      每一句单独一个元素：翻译表按整句匹配，句子之间不拼成一个文本节点。
      手机上（≤620px）只留加粗那句和公开 RPC，其余（.bar-x）收在「详情」后面 ——
      否则英文下这条横幅有近 300px 高，会把首屏的决策 #29a 那句挤到折线以下。 */
  function paintBars() {
    var bar = $('#stateBar');
    if (bar) {
      var html = null;
      if (VM.mode === 'demo') html = null;                      // 演示模式有自己的横幅
      else if (VM.st.chain === 'error') html = esc(UI.TEXT.ERR + '：层内节点两个地址都没答话，区块与交易暂时读不到。');
      else if (VM.rehearsal || VM.st.idx === 'noidx') {
        /* 给人去核对的是**配置里的公开 RPC**：数据源切到索引器之后 VM.layer.endpoint 是索引器的根地址，
           对它 POST eth_blockNumber 会 405。只有真在直读 RPC 时（可能是兜底 IP），才写实际在用的那个。 */
        var ly = VM.layer || {};
        var ep = (ly.source === 'rpc' && ly.endpoint) || ly.rpc || '—';
        html = (VM.rehearsal
          ? '<b>现在出块的是演练链。</b>'
            + '<span class="bar-x">创世里预置了测试用的 BAC（没有一枚是从 BSC 桥过来的），预置账户用的是公开的 Hardhat 测试私钥，'
            + '任何人都能用它发交易，币没有任何价值；正式发射时会用新的创世重建这条链，现在的区块、交易和余额届时全部清空。</span>'
            + '<span class="bar-x">v1 只有一个官方验证者节点。演练链的同步已经公开，任何人都能照 </span>'
            + '<code class="bar-x">' + esc(UI.NODE_JSON) + '</code>'
            + '<span class="bar-x"> 自己跑一个只读节点（没有任何奖励）；质押 BAC 做验证者、分 gas 费发射后开放。</span>'
          : '')
          + '<span>区块、交易、块高、gas 是本站从层内节点（及同一台主机上的索引 API）读到的真数据，任何人都能向同一个公开 RPC 自己核对：</span>'
          + '<code>' + esc(ep) + '</code><span>。</span> '
          + (VM.st.idx === 'noidx' ? '<span class="bar-x">索引器现在读不到，所以历史检索、agent 名录、日聚合曲线暂时没有。</span>' : '')
          + (VM.st.treasury === 'pre'
            ? '<span class="bar-x">BSC 侧的代币还没发射，税收路由 / 桥 / 质押 / 锚点合约都还不存在，那些数字写「' + esc(UI.TEXT.PRE) + '」。</span>'
            : '')
          + '<button class="bar-more" type="button" aria-controls="stateBar">'
          + '<span class="bm-o">详情</span><span class="bm-c">收起</span></button>';
      }
      /* 每次刷新都会走到这里：内容没变就不动 DOM，免得翻译层每 6 秒重译一遍 */
      if (html) {
        bar.hidden = false;
        if (bar._src !== html) { bar._src = html; bar.innerHTML = html; }
        var mb = bar.querySelector('.bar-more');
        if (mb) mb.setAttribute('aria-expanded', bar.classList.contains('open') ? 'true' : 'false');
      } else { bar.hidden = true; bar._src = null; }
    }
    /* 旧的降级横幅只在数据层真的给了降级说明、且和上面那条不重复时才出现 */
    var warn = $('#degradedBar');
    if (warn) {
      var note = VM.chain.degradedNote;
      var dup = bar && !bar.hidden;
      if (note && !dup && VM.mode !== 'demo') { warn.hidden = false; warn.textContent = note; }
      else warn.hidden = true;
    }
    /* 演示横幅的文字只在演示模式下写进去：index.html 里那个元素是空的（见那里的注释） */
    var demoBar = $('#demoBar');
    if (demoBar) {
      var demo = VM.mode === 'demo';
      demoBar.hidden = !demo;
      if (demo && !demoBar.firstChild) {
        /* 正式站点的数据来源照实写：索引器在线时区块与交易经本项目自己的索引 API 转手，不是「每一个数字都直接来自链上」 */
        demoBar.innerHTML = '<span>演示模式（</span><code>?demo=1</code>'
          + '<span>）：页面上的数字是占位值，只为看排版。正式站点不显示占位值：块高、区块与交易来自层内节点，索引器在线时经本项目自己的索引 API（同一台主机）转手，不在线时由浏览器直读公开 RPC；agent 名录、代币与交易对只有索引器给得出；BSC 侧的合约读数由浏览器经公开 BSC RPC 直接读。</span>';
      } else if (!demo && demoBar.firstChild) demoBar.textContent = '';
    }
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
    var len = VM.chain.epochLenSec || 600;
    var s = left === null || left === undefined ? miss(VM.st.chain) : UI.hmsLeft(left);
    ['#ssAnchor', '#anchorCd', '#cd2', '#epCd', '#heroCd'].forEach(function (sel) { UI.setText(sel, s); });
    var fill = $('#cdFill');
    /* 进度条按纪元真实长度算（纪元长度是数据层的常量 EPOCH = 600，改了这里跟着走，不写死） */
    if (fill) {
      var pctDone = (left === null || left === undefined) ? 0
        : Math.max(0, Math.min(100, (1 - left / len) * 100));
      fill.style.width = pctDone.toFixed(1) + '%';
    }
  }

  /* ══════════════════ 路由 ══════════════════ */

  var PARENT = {
    block: 'blocks', tx: 'txs', agent: 'agents', search: '', contract: 'agents', epoch: 'epochs',
    /* agent 造出来的东西：详情页高亮回到它自己的列表页（决策 #19） */
    token: 'tokens', pair: 'pairs', swaps: 'pairs'
  };
  var TITLES = {
    overview: 'BNB Agent Chain · 区块浏览器', blocks: '区块 · BAC', txs: '交易 · BAC',
    agents: 'Agent 目录 · BAC', treasury: '金库 · BAC', validators: '验证者 · BAC',
    epochs: '纪元与锚点 · BAC', contract: '合约 · BAC', search: '搜索 · BAC', tx: '交易 · BAC',
    tokens: '代币 · BAC', token: '代币详情 · BAC', pairs: '交易对 · BAC',
    pair: '交易对详情 · BAC', swaps: '成交流水 · BAC'
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
    /* agent 造出来的东西（决策 #19 / 03 §7.8） */
    else if (v === 'tokens') P.renderTokens();
    else if (v === 'token') P.renderTokenDetail(arg);
    else if (v === 'pairs') P.renderPairs();
    else if (v === 'pair') P.renderPairDetail(arg);
    else if (v === 'swaps') P.renderSwaps();
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
    if (VM.st.blocks === 'pre') return '还没有发射：链上还没有区块、交易或 agent 可以搜。';
    var base = '可以输入：区块高度、0x 开头的交易哈希 / 地址 / 合约地址、agent 编号（如 #17）、纪元号。';
    /* 现在是直读层内节点（索引器读不到或还没回话）：块高和完整交易哈希能直接查，其余的等索引器 —— 照实说 */
    if (VM.layer && VM.layer.source === 'rpc') {
      base += '现在是直读层内节点，能查的是区块高度和完整交易哈希。';
    }
    return base;
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
      /* 顶部横幅在手机上的「详情 / 收起」：只切一个 class，内容不重画 */
      var mb = e.target.closest('#stateBar .bar-more');
      if (mb) {
        var open = mb.parentElement.classList.toggle('open');
        mb.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
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
