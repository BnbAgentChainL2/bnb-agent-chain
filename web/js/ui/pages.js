/* BNB Agent Chain · 可视层 · 各个页面的渲染
   规矩：这里只读 window.BACVM；要更多数据时只向 window.BACBIND 要（它才是唯一碰 window.BAC 的人）。
   这一层不认识 fetch，也不认识 RPC。 */
(function (root) {
  'use strict';

  var UI = root.BACUI;
  if (!UI || !UI.rows) {
    if (root.console) root.console.error('[BACUI] pages.js 需要先加载 js/ui/rows.js');
    return;
  }
  if (UI.pages) return;

  var VM = root.BACVM, R = UI.rows, C = UI.charts;
  var $ = UI.$, $$ = UI.$$, esc = UI.esc, comma = UI.comma, sa = UI.sa, sh = UI.sh;
  var bac = UI.bac, bnb = UI.bnb, val = UI.val, miss = UI.miss, kv = R.kv;

  function bind() { return root.BACBIND || null; }
  /** 能不能按需再读一条？演示模式下不能，直接说找不到，不要一直转圈。 */
  function canAsk() { var b = bind(); return !!(b && b.load && b.canLoad); }
  /** 区块 / 交易：索引器不在也能读 —— 直接问层内节点，它们是真实存在的链上数据。 */
  function canAskLayer() { var b = bind(); return !!(b && b.load && b.canLoadLayer); }
  /** agent / 纪元 / 合约：只有索引器给得出。 */
  function canAskIdx() { var b = bind(); return !!(b && b.load && b.canLoadIndexed); }
  function ask(kind, arg) { var b = bind(); if (b && b.load) b.load(kind, arg); }

  /** 现在是不是本站直接读层内节点（而不是索引器）。 */
  function onRpc() { return VM.layer && VM.layer.source === 'rpc'; }
  /** 详情页顶上的来源行：如实写这一页的数字是怎么来的，两种来源不混为一谈。 */
  function srcLine(tag, idxPath, rpcCall) {
    return '<div class="srcline"><b>' + esc(tag) + '</b>' +
      (onRpc()
        ? '<code>' + esc(rpcCall) + '</code><code>' + esc(UI.srcLabel('rpc')) + '</code>'
        : '<code>' + esc(idxPath) + '</code><code>' + esc(rpcCall) + '</code>') +
      '</div>';
  }
  function askNote(what) {
    return onRpc() ? ('正在直接读层内节点要' + what + '。') : ('正在向索引器要' + what + '。');
  }

  var GAS_NOTE_OFFICIAL = '官方节点出的块：10% 进验证者池 / 90% 进官方基金会。';
  var GAS_NOTE_VALIDATOR = '验证者自己出的块：50% 归该验证者 / 50% 进官方基金会。';

  /* 决策 #31a：进场门禁那一句必须逐字（链上 BacBridge.IDENTITY_LIMIT_NOTICE 就是它）。
     项目方权限那一句：项目所有者 2026-09-23 决定从网站上全部去掉，不要加回来。 */
  var ID_LIMIT = '我们要求持有 agent 身份，我们不能证明它是 AI。';
  /* 决策 #31：入场门禁读的 ERC-8004 身份注册表（BSC，ERC-721，name() = "AgentIdentity"）。
     只写地址和标准名，不写「官方」：我们用这个注册表，不代表任何人为我们背书。 */
  var ID_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

  /* ══════════════════ 分页与筛选状态 ══════════════════ */
  var st = {
    blocks: { page: 0, size: 25, filter: 'all' },
    txs: { page: 0, size: 25, filter: 'all' },
    agents: { page: 0, size: 25, filter: 'all', q: '' }
  };

  /** layerDirect：这个列表在直读模式下真的是从层内节点读的（只有区块、交易两页）。
      agent 名录从来不来自层内节点，传 false —— 不能把「直读层内节点」的说明套到它头上。 */
  function pager(el, s, total, onChange, layerDirect) {
    if (!el) return;
    /* 直读层内节点时只有最近一窗口的块（本站一轮最多取 20 块左右），
       「首页 / 末页 / 每页 100 条」这些控件点了也没有第二页可去 ——
       与其画一排点不动的按钮，不如把为什么说清楚。索引器恢复供数后自动换回分页。 */
    if (layerDirect && onRpc()) {
      /* 索引器已经部署在同一台主机上；走到这里只说明这一轮数据是直读节点拿到的。
         三种情况分开说：还在读取 / 确实读不到（'noidx'）/ 索引器正常但这一轮恰好走的直读 ——
         最后一种不能说它「没有答话」，那是假话（INDEX 灯是绿的）。 */
      var why = VM.st.idx === 'loading'
        ? '索引器还在读取，读到后自动换成可翻页的完整历史。'
        : VM.st.idx === 'noidx'
          ? '索引器现在没有答话，恢复后自动换回可翻页的完整历史与搜索。'
          : '下一轮从索引器取数时自动换回可翻页的完整历史。';
      el.innerHTML = '<span class="pg-note">这一轮是直读层内节点读到的最近 ' + comma(total) +
        ' 条，没有更早的可以翻。' + why + '</span>' +
        '<span class="pg-fill"></span><span>显示全部 ' + comma(total) + ' 条</span>';
      el.onclick = null;
      return;
    }
    var pages = Math.max(1, Math.ceil(total / s.size));
    if (s.page >= pages) s.page = pages - 1;
    var from = total ? s.page * s.size + 1 : 0, to = Math.min(total, (s.page + 1) * s.size);
    el.innerHTML =
      '<button class="pg" data-p="first"' + (s.page === 0 ? ' disabled' : '') + '>« 首页</button>' +
      '<button class="pg" data-p="prev"' + (s.page === 0 ? ' disabled' : '') + '>‹ 上一页</button>' +
      '<span>第 ' + (s.page + 1) + ' / ' + pages + ' 页</span>' +
      '<button class="pg" data-p="next"' + (s.page >= pages - 1 ? ' disabled' : '') + '>下一页 ›</button>' +
      '<button class="pg" data-p="last"' + (s.page >= pages - 1 ? ' disabled' : '') + '>末页 »</button>' +
      '<span class="pg-fill"></span>' +
      '<span>显示 ' + comma(from) + '–' + comma(to) + ' / 共 ' + comma(total) + ' 条</span>' +
      '<span class="pg-size">' + [25, 50, 100].map(function (n) {
        return '<button data-s="' + n + '"' + (s.size === n ? ' class="on"' : '') + '>' + n + '</button>';
      }).join('') + '</span>';
    el.onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.p) {
        if (b.dataset.p === 'first') s.page = 0;
        if (b.dataset.p === 'prev') s.page = Math.max(0, s.page - 1);
        if (b.dataset.p === 'next') s.page = Math.min(pages - 1, s.page + 1);
        if (b.dataset.p === 'last') s.page = pages - 1;
      } else if (b.dataset.s) { s.size = +b.dataset.s; s.page = 0; }
      onChange();
    };
  }

  /* ══════════════════ 列表页 ══════════════════ */

  function filteredBlocks() {
    var f = st.blocks.filter;
    if (f === 'all') return VM.blocks;
    return VM.blocks.filter(function (b) { return b.proposerKind === f; });
  }

  function renderBlocks() {
    var body = $('#blkBody'); if (!body) return;
    var s = VM.st.blocks;
    if (s !== 'ok') {
      body.innerHTML = R.missRow(10, s, s === 'loading' ? '正在读层内节点。' : '');
      UI.setText('#blkCount', miss(s));
      pager($('#blkPager'), st.blocks, 0, renderBlocks, true);
      return;
    }
    var list = filteredBlocks(), p = st.blocks;
    var page = list.slice(p.page * p.size, (p.page + 1) * p.size);
    body.innerHTML = page.length
      ? page.map(function (b) { return R.blockRow(b, false); }).join('')
      : R.emptyRow(10, '阶段 2 还没有开放，目前每一个区块都由官方节点出。验证者拿到出块资格之后，它们出的块会出现在这里，那些块的 gas 费按 50 / 50 分（该验证者本人 / 官方基金会）。');
    /* 直读 RPC 时只有最近这一窗口的块 —— 这一条必须说清楚，不能让人以为是全量 */
    UI.setText('#blkCount', VM.layer.source === 'rpc'
      ? comma(list.length) + ' 块 · 只有最近 ' + comma(VM.blocks.length) + ' 块（直读层内节点，历史要等索引器）'
      : comma(list.length) + ' 块（本页保留最近 ' + comma(VM.blocks.length) + ' 块）');
    pager($('#blkPager'), p, list.length, renderBlocks, true);
  }

  function filteredTxs() {
    var f = st.txs.filter;
    return VM.txs.filter(function (t) {
      if (f === 'failed') return t.ok === false;
      if (f === 'all') return true;
      return t.type === f;
    });
  }

  function renderTxs() {
    var body = $('#txBody'); if (!body) return;
    var s = VM.st.txs;
    if (s !== 'ok') {
      body.innerHTML = R.missRow(10, s, s === 'loading' ? '正在读层内节点。' : '');
      UI.setText('#txCount', miss(s));
      pager($('#txPager'), st.txs, 0, renderTxs, true);
      return;
    }
    var list = filteredTxs(), p = st.txs;
    var page = list.slice(p.page * p.size, (p.page + 1) * p.size);
    body.innerHTML = page.length
      ? page.map(function (t) { return R.txRow(t, false); }).join('')
      : R.emptyRow(10, '最近的区块里没有交易。空块在这条链上很正常。');
    UI.setText('#txCount', VM.layer.source === 'rpc'
      ? comma(list.length) + ' 笔 · 只有最近 ' + comma(VM.blocks.length) + ' 块里的（直读层内节点）'
      : comma(list.length) + ' 笔');
    pager($('#txPager'), p, list.length, renderTxs, true);
  }

  function filteredAgents() {
    var p = st.agents, q = p.q.trim().toLowerCase();
    return VM.agents.filter(function (a) {
      if (p.filter !== 'all' && String(a.status || '').toLowerCase() !== p.filter) return false;
      if (!q) return true;
      var idNo = String(a.identityId === null || a.identityId === undefined ? a.id : a.identityId);
      return ('agent #' + a.id).indexOf(q) >= 0 || idNo === q.replace('#', '') ||
        [a.wallet, a.holder, a.agentWallet].some(function (x) { return (x || '').toLowerCase().indexOf(q) >= 0; }) ||
        (a.selfName || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  var AG_COLS = 8;
  function renderAgents() {
    var body = $('#agBody'); if (!body) return;
    var s = VM.st.agents;
    if (s !== 'ok') {
      /* 进场记录在 BSC 的 BacBridge 里（门禁读 ERC-8004 身份注册表），代币还没发射、桥还没部署 →
         **没有任何 agent 进场过**。照实说，不编身份。 */
      body.innerHTML = s === 'pre'
        ? R.emptyRow(AG_COLS, '还没有任何 agent 进场。进场要持有 ERC-8004 agent 身份（BSC 身份注册表 ' + ID_REGISTRY
          + '），再把 BAC 锁进 BSC 上的 BacBridge；代币还没发射、桥还没部署，所以现在一条进场记录都没有 —— '
          + '这不是读取失败，是真的还没有人进场。' + ID_LIMIT
          + '层内那条链（演练链）本身已经在出块了，区块和交易在「区块」「交易」两页都是实时的。')
        : R.missRow(AG_COLS, s, '');
      UI.setText('#agCount', s === 'pre' ? '0 个身份' : miss(s));
      /* 没有列表就没有可翻的页：'pre' 时照实写 0 条（真的还没有人进场），读取中 / 读不到时什么都不画。 */
      var agp = $('#agPager');
      if (agp) { agp.onclick = null; agp.innerHTML = s === 'pre' ? '<span class="pg-fill"></span><span>共 0 条</span>' : ''; }
      return;
    }
    var list = filteredAgents(), p = st.agents, m = VM.agentsMeta || {};
    var page = list.slice(p.page * p.size, (p.page + 1) * p.size);
    body.innerHTML = page.length ? page.map(function (a) { return R.agentRow(a); }).join('')
      : (VM.agents.length
        ? R.emptyRow(AG_COLS, '没有符合条件的 agent。')
        /* 阶段 b / c：桥合约在，名录读到了，就是一个都还没有 —— 这是真的 0，不是读取失败 */
        : R.emptyRow(AG_COLS, '还没有任何 ERC-8004 身份锁进过 BacBridge。' + ID_LIMIT));
    /* 一共几个：名录读全了才给 total；只读了最近一批存入时 total 是 null，只能说「至少」 */
    var total = m.total !== null && m.total !== undefined ? m.total
      : (VM.chain.agentCounts && VM.chain.agentCounts.total !== null ? VM.chain.agentCounts.total : null);
    UI.setText('#agCount', total !== null
      ? comma(list.length) + ' / ' + comma(total) + ' 个身份'
      : (m.totalAtLeast !== null && m.totalAtLeast !== undefined
        ? comma(list.length) + ' / 至少 ' + comma(m.totalAtLeast) + ' 个身份'
        : comma(list.length) + ' 个身份'));
    pager($('#agPager'), p, list.length, renderAgents, false);
    /* 读不全 / 身份字段这一轮没读，照实补一句在分页条后面 */
    var agp2 = $('#agPager');
    if (agp2 && (m.truncated || m.itemsTruncated || m.identityPaused)) {
      agp2.insertAdjacentHTML('beforeend', '<span class="pg-note">' + esc(
        m.identityPaused ? '这一轮没能批量读身份注册表，持有人 / agentWallet / 名字暂时写「—」。'
          : '存入记录太多，只读了最近一批：上面不是全部身份。') + '</span>');
    }
  }

  /* ══════════════════ 概览 ══════════════════ */

  function renderOverviewTables() {
    var ob = $('#ovBlocks'), ot = $('#ovTxs');
    if (ob) {
      ob.innerHTML = VM.st.blocks === 'ok'
        ? (VM.blocks.length ? VM.blocks.slice(0, 14).map(function (b) { return R.blockRow(b, true); }).join('')
          : R.emptyRow(7, '还没有区块。'))
        : R.missRow(7, VM.st.blocks, VM.st.blocks === 'loading' ? '正在读层内节点。' : '');
    }
    if (ot) {
      ot.innerHTML = VM.st.txs === 'ok'
        ? (VM.txs.length ? VM.txs.slice(0, 14).map(function (t) { return R.txRow(t, true); }).join('')
          : R.emptyRow(6, '最近的区块里没有交易。空块在这条链上很正常。'))
        : R.missRow(6, VM.st.txs, VM.st.txs === 'loading' ? '正在读层内节点。' : '');
    }
  }

  /* 实时动态：文本是 agent 自己写的，**一律当纯文本插入**，不解析 HTML。 */
  var feedFilter = 'all';
  function feedMatches(it) {
    if (feedFilter === 'all') return true;
    if (feedFilter === 'layer') return it.chain === 'LAYER';
    if (feedFilter === 'bsc') return it.chain === 'BSC';
    if (feedFilter === 'deploy') return it.kind === 'DEPLOY' || it.kind === 'POOL';
    if (feedFilter === 'trade') return it.kind === 'TRADE' || it.kind === 'LIST';
    if (feedFilter === 'publish') return it.kind === 'PUBLISH' || it.kind === 'SERVICE' || it.kind === 'STRATEGY';
    return true;
  }
  function setFeedFilter(k) { feedFilter = k; renderFeed(); }

  function renderFeed() {
    var ul = $('#feedList'); if (!ul) return;
    var s = VM.st.feed;
    if (s !== 'ok') {
      ul.innerHTML = '<li class="f-none">' + esc(s === 'pre' ? '还没有 agent 动态' : miss(s)) +
        (s === 'pre' ? '　动态要把交易按 agent 归类，这要 BSC 上 BacBridge 的进场记录（按 ERC-8004 身份编号）；'
          + '桥合约还没部署，这些记录现在还不存在。层内的原始区块与交易在「区块」「交易」两页是实时的。' : '') + '</li>';
      return;
    }
    if (!VM.feed.length) { ul.innerHTML = '<li class="f-none">最近一段时间没有链上记录。</li>'; return; }
    ul.innerHTML = '';
    VM.feed.slice(0, 40).forEach(function (it) {
      var li = document.createElement('li');
      li.dataset.chain = it.chain; li.dataset.kind = it.kind;
      if (!feedMatches(it)) li.hidden = true;
      var badge = it.anchored
        ? '<span class="f-a done">' + esc(UI.TEXT.ANCHORED) + '</span>'
        : '<span class="f-a">' + esc(UI.TEXT.NOT_ANCHORED) + '</span>';
      var href = it.tx ? '#/tx/' + it.tx : '#/validators';
      li.innerHTML =
        '<span class="f-t">' + esc(UI.hms(it.ts)) + '</span>' +
        '<span class="f-c ' + (it.chain === 'BSC' ? 'bsc' : 'layer') + '">' + esc(it.chain) + '</span>' +
        '<span class="f-k k-' + esc(String(it.kind).toLowerCase()) + '">' + esc(it.kind) + '</span>' +
        '<span class="f-x"></span>' +
        '<span class="f-r">' + badge + '<a class="f-v" href="' + esc(href) + '">查看</a></span>';
      /* textZh 由 agent 自己写，**用 textContent 插入**，本站不做任何背书也不解析标记 */
      li.querySelector('.f-x').textContent = it.textZh || '';
      ul.appendChild(li);
    });
  }

  /* ══════════════════ 金库页（税收路由 → 桥池 / 节点基金）══════════════════
     决策 #30：没有金库工厂了。税收 BNB 进 BacTaxRouter（Flap 先抽 10% 协议费，到这里是约 0.90 倍），
     它按 50/50 推给 BacBridge（桥池）和 BacNodeFund（节点基金）。
     决策 #29c：桥合约的每一次升级与紧急提取都要按时间线公开，和节点基金提取同一个口径。 */

  /** 一条 BSC 时间线的表身：读不到按状态占位；读到了但这一段为空，照实说「这一段没有」（不是「从来没有」）。 */
  function tlBody(el, status, items, rowFn, preNote, emptyNote) {
    if (!el) return;
    if (status !== 'ok') { el.innerHTML = R.missRow(5, status, status === 'pre' ? preNote : ''); return; }
    el.innerHTML = items && items.length ? items.map(rowFn).join('') : R.emptyRow(5, emptyNote);
  }
  function htmlOnce(el, html) {
    if (el && el._src !== html) { el._src = html; el.innerHTML = html; }
  }
  /** BscScan 事件页的外链（只是一个链接，本站不去读它）。 */
  function scanLink(url, text) {
    return url ? '<a class="a-link" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(text) + '</a>' : '';
  }
  /** 时间线全不全：全了就说全了；不全就说只看得到最近约 N 分钟，并给出 BscScan 事件页。 */
  function tlCoverage(complete, truncated, windowMin, url, what) {
    if (complete) return '<span class="cov-ok">从部署块起的每一条都在这里。</span>';
    return '<span class="cov-part">' +
      (windowMin ? '<span>只显示本站读得到的最近约</span> <b>' + windowMin + '</b> <span>分钟的 BSC 日志（公共节点不给更早的）。</span>'
        : '<span>只显示本站读得到的最近一段 BSC 日志（公共节点不给更早的）。</span>') +
      (truncated ? ' <span>条目太多，只保留了最新的一批。</span>' : '') +
      (url ? ' <span>更早的记录请到</span> ' + scanLink(url, what) + ' <span>核对。</span>' : '') + '</span>';
  }

  function renderTreasury() {
    var T = VM.treasury || {};
    var ts = VM.st.timeline;
    tlBody($('#flowBody'), ts, T.flow, R.flowRow,
      '合约部署后，这里逐笔显示税收到账、BacTaxRouter 的 50/50 分账、推送与桥池回购。',
      '这一段时间里没有税收流水。');
    tlBody($('#nfBody'), ts, T.nodeFundEvents, R.nodeFundRow,
      '合约部署后，这里逐笔显示节点基金的每一笔到账和每一次提取。',
      '这一段时间里节点基金没有到账，也没有提取。');
    var trunc = T.timelineTruncated || {};
    /* 说明行内容没变就不动 DOM（翻译层不必每轮重译） */
    htmlOnce($('#flowCov'), '<span>税收 → BacTaxRouter → 50/50 → 桥池与节点基金，每一步都发事件。</span>' +
      (ts === 'ok' ? ' ' + tlCoverage(T.timelineComplete, trunc.flow, T.windowMin, T.routerEventsUrl, 'BscScan 上税收路由的事件页') : ''));
    htmlOnce($('#nfCov'), '<span>节点基金的每一笔提取都发事件、都按时间列在这里，不隐藏（决策 #10 的披露要求）。</span>' +
      (ts === 'ok' ? ' ' + tlCoverage(T.timelineComplete, trunc.nodeFund, T.windowMin, T.nodeFundEventsUrl, 'BscScan 上节点基金的事件页') : ''));
    renderOwnerPowers();
    var tk = $('#tkState');
    if (tk) tk.textContent = VM.mode === 'demo' ? '演示模式' : (VM.token && VM.token.launched ? '已发射' : '地址已锁定 · 尚未发射');
  }

  /** 项目方权限记录（决策 #29c）：升级 / 紧急提取 / 换 owner / 暂停的时间线 + 这条时间线全不全。
      计数器（升级次数、紧急提取次数）是合约里的全量；逐条记录来自浏览器读得到的日志窗口 + 索引器历史。
      缺的时候照实说缺几条，并给 BscScan 桥合约的事件页。 */
  function renderOwnerPowers() {
    var O = VM.owner || {}, s = VM.st.owner;
    tlBody($('#ownBody'), s, O.items, R.ownerRow,
      '桥合约部署后，这里逐条显示它的每一次升级、紧急提取、换 owner 与暂停。',
      '这一段时间里没有升级、紧急提取、换 owner 或暂停。');
    var cov = $('#ownCov'); if (!cov) return;
    if (s !== 'ok') { htmlOnce(cov, ''); return; }
    var B = VM.bridge || {}, miss0 = O.missing || {}, seen = O.seen || {};
    var html = '';
    if (O.complete) {
      html += '<p class="note"><b>这条时间线是完整的：</b><span>' +
        (O.completeVia === 'indexer' ? '从桥合约部署起的每一条都在下面（索引器的全量历史 + 本站读到的 BSC 日志）。'
          : '从桥合约部署起的每一条都在下面（本站直接读到的 BSC 日志）。') + '</span></p>';
    } else {
      html += '<p class="note warn-n"><b>这条时间线可能不完整：</b>' +
        (O.windowMin ? '<span>浏览器只读得到最近约</span> <b>' + O.windowMin + '</b> <span>分钟的 BSC 日志（公共节点不给更早的），索引器的全量历史这一轮没能补齐。</span>'
          : '<span>浏览器只读得到最近一段 BSC 日志（公共节点不给更早的），索引器的全量历史这一轮没能补齐。</span>') +
        (O.eventsUrl ? ' <span>完整记录请到</span> ' + scanLink(O.eventsUrl, 'BscScan 上桥合约的事件页') + ' <span>核对。</span>' : '') + '</p>';
    }
    /* 计数器对账：合约说做过几次 vs 时间线里看到几次 */
    if (B.upgradeCount !== null && B.upgradeCount !== undefined) {
      html += '<p class="note"><b>合约计数器（全量）：</b><span>桥合约升级</span> <b>' + comma(B.upgradeCount) + '</b> <span>次，紧急提取</span> <b>' +
        comma(B.emergencyCount === null || B.emergencyCount === undefined ? '—' : B.emergencyCount) + '</b> <span>次；下面的时间线里看到升级</span> <b>' +
        comma(seen.upgrades || 0) + '</b> <span>次，紧急提取</span> <b>' + comma(seen.emergencies || 0) + '</b> <span>次。</span>' +
        ((miss0.upgrades || miss0.emergencies)
          ? ' <b class="bad-t">缺</b> <b>' + comma(miss0.upgrades || 0) + '</b> <span>次升级、</span><b>' + comma(miss0.emergencies || 0) +
            '</b> <span>次紧急提取的逐条记录，请到 BscScan 核对。</span>'
          : (O.upgradesAndWithdrawalsComplete ? ' <span>升级与紧急提取的逐条记录一条不缺。</span>' : '')) + '</p>';
    }
    var un = O.unlogged && O.unlogged.total ? O.unlogged.total : 0;
    if (un) {
      html += '<p class="note warn-n"><b>发现</b> <b>' + un + '</b> <b>次没有留下 BridgeUpgraded 事件的换实现。</b>' +
        '<span>owner 可以装任何实现合约（决策 #29），新实现不发 BridgeUpgraded 也照样能生效。</span></p>';
    }
    if (O.implementationMatchesLog === false) {
      html += '<p class="note warn-n"><b>现在的实现合约和日志里最后一次换到的实现对不上。</b></p>';
    }
    htmlOnce(cov, html);
  }

  /* ══════════════════ 验证者页 ══════════════════ */

  function renderValidators() {
    var body = $('#valBody');
    if (body) {
      var s = VM.st.validators;
      if (s !== 'ok') {
        /* 决策 #15 / #17：验证者节点是**发射后开放**的事，现在只有官方节点在出块 —— 不许写成现在就能当验证者。
           演练链的只读同步已经公开（HANDOFF §2），那种节点不出块、没有奖励，照实说。 */
        body.innerHTML = R.missRow(9, s, s === 'pre'
          ? '这里会是全部注册节点。现在只有官方节点在出块；演练链的只读同步现在就开放（' + UI.NODE_JSON
            + '，没有任何奖励），在 BSC 上质押 BAC、跑验证者节点发射后开放。'
          : '');
      } else if (!VM.validators.items.length) {
        body.innerHTML = R.emptyRow(9, '还没有人注册节点。注册无许可，先到先得，合约里没有审批。');
      } else {
        var free = (VM.validators.slots || 64) - VM.validators.items.length;
        body.innerHTML = VM.validators.items.map(function (v) { return R.validatorRow(v); }).join('') +
          (free > 0 ? R.emptyRow(9, '还有 ' + free + ' 个空槽位。注册无许可，先到先得，合约里没有审批。') : '');
      }
    }
    renderLayerGas();
    var how = $('#rcHow');
    if (how) {
      var lines = (VM.fees.howToCheck || []);
      how.innerHTML = lines.length
        ? '<span>自己核：</span>' + lines.map(function (l) { return '<code>' + esc(l) + '</code>'; }).join('')
        : '<span>自己核：</span><code>' + esc(miss(VM.st.fees)) + '</code>';
    }
  }

  /** 验证者页上「现在就能核」的那一半：把本站读回来的真实区块里的手续费加起来。
      这一段**不经过任何服务**，也不依赖 BSC —— 它就是层内链此刻的事实。
      没取到收据的块手续费是 null，会如实说「已知 n / m 块」，绝不拿 gas 上限估。 */
  function renderLayerGas() {
    var el = $('#valLive'); if (!el) return;
    var s = VM.st.blocks;
    if (s !== 'ok' || !VM.blocks.length) {
      el.innerHTML = '<div class="empty-box"><b>' + esc(miss(s)) + '</b>' +
        esc(s === 'loading' ? '正在读层内节点。' : '层内节点没答话，这一段暂时算不出来。') + '</div>';
      return;
    }
    var total = 0n, known = 0, txs = 0, nonEmpty = 0;
    var first = VM.blocks[0], last = VM.blocks[VM.blocks.length - 1];
    VM.blocks.forEach(function (b) {
      if (b.txCount) { nonEmpty++; txs += b.txCount; }
      if (b.fee !== null && b.fee !== undefined) { total += b.fee; known++; }
    });
    var span = (first.ts !== null && last.ts !== null) ? first.ts - last.ts : null;
    var poolBps = VM.fees.officialValidatorBps || 1000;
    var toPool = total * BigInt(poolBps) / 10000n;
    var toFound = total - toPool;
    /* 一个收据都没取到（索引器供数时的区块列表不带每块手续费）：合计、10%、90% 都是未知，写「—」，
       绝不能拿初始值 0 冒充「这一窗口手续费是 0」。只取到一部分时，合计明说是「已知 n 块」的，不冒充整窗口。 */
    var none = known === 0, partial = known > 0 && known < VM.blocks.length;
    function amt(x) { return none ? '—' : bac(x, 9); }
    el.innerHTML =
      '<div class="datum"><span class="d-l">' + (partial ? '已知 ' + known + ' 块的手续费合计' : '这一窗口的手续费合计') + '</span>' +
      '<b class="grn">' + esc(amt(total)) + '</b>' + (none ? '' : '<u>BAC</u>') +
      '<i>已取到收据 ' + known + ' / ' + VM.blocks.length + ' 块' +
      (span !== null ? ' · 跨度 ' + span + ' 秒' : '') + '</i></div>' +
      '<div class="mini">' +
      '<div class="mi"><i>区块</i><b>' + comma(VM.blocks.length) + '<u>块</u></b></div>' +
      '<div class="mi"><i>其中非空块</i><b>' + comma(nonEmpty) + '<u>块</u></b></div>' +
      '<div class="mi"><i>交易</i><b>' + comma(txs) + '<u>笔</u></b></div>' +
      '<div class="mi"><i>→ 验证者池 ' + (poolBps / 100) + '%</i><b>' + esc(amt(toPool)) + (none ? '' : '<u>BAC</u>') + '</b></div>' +
      '<div class="mi"><i>→ 官方基金会 ' + (100 - poolBps / 100) + '%</i><b>' + esc(amt(toFound)) + (none ? '' : '<u>BAC</u>') + '</b></div>' +
      '</div>' +
      (none
        ? '<p class="note">' + (onRpc()
          ? '这一窗口的 ' + VM.blocks.length + ' 个块一个收据都还没取到，'
          : '这一轮的区块来自索引器，它的区块列表不带每块的手续费，') +
          '所以上面的合计和两份分成都写「—」，不写 0 —— <b>没取到就是没取到，不拿 gas 上限估</b>。</p>'
        : partial
          ? '<p class="note">有 ' + (VM.blocks.length - known) + ' 个块还没取到收据（本站一轮最多为最近几个非空块取收据），' +
            '它们的手续费没有计入上面的合计 —— <b>没取到就是没取到，不拿 gas 上限估</b>。</p>'
          : '');
  }

  /* ══════════════════ 「这一块的 gas 费去哪了」 ══════════════════ */

  /** 决策 #17 的分账面板：按出块者分，不是一刀切。 */
  function feeSplitPanel(b, s) {
    var official = b.proposerKind !== 'validator';
    var fee = b.fee === null || b.fee === undefined ? null : b.fee;
    var selfBps = official ? (VM.fees.officialValidatorBps || 1000) : (VM.fees.validatorSelfBps || 5000);
    var toSelf = fee === null ? null : fee * BigInt(selfBps) / 10000n;
    var toFound = fee === null || toSelf === null ? null : fee - toSelf;
    var splitter = VM.layerAddresses.FEE_SPLITTER || '0x0000000000000000000000000000000000000104';
    var found = VM.layerAddresses.FOUNDATION || '0x0000000000000000000000000000000000000105';
    var selfPct = (selfBps / 100) + '%', foundPct = (100 - selfBps / 100) + '%';
    return '<div class="panel"><div class="ph"><span class="ph-t big">这一块的 gas 费去哪了</span>' +
      '<span class="ph-fill"></span><span class="ph-m">出块者决定分法</span></div><div class="feesplit">' +
      '<div class="fs-top"><span>出块者：<b>' + (b.proposerKind ? (official ? '官方节点' : '验证者') : esc(miss(s))) + '</b> ' +
      '<code>' + esc(b.proposer ? sa(b.proposer) : '—') + '</code></span>' +
      '<span>本块手续费合计 <b>' + val(s, fee, function (x) { return bac(x) + ' BAC'; }) + '</b></span></div>' +
      '<div class="fsbar"><div class="fsb v" style="width:' + selfPct + '"><u>' + selfPct + '</u></div>' +
      '<div class="fsb f" style="width:' + foundPct + '"><u>' + foundPct + '</u><span>官方基金会</span></div></div>' +
      '<div class="fs-rows">' +
      '<div class="fs-row"><span>→ ' + (official
        ? '验证者池 ' + selfPct + '（本纪元所有在线且见证无误的验证者按质押 × 出勤分）'
        : '出这一块的验证者本人 ' + selfPct) + '</span><b>' +
      val(s, toSelf, function (x) { return bac(x, 9); }) + ' BAC</b></div>' +
      '<div class="fs-row"><span>→ 官方基金会 ' + foundPct + ' <code>' + esc(sa(found)) + '</code></span><b>' +
      val(s, toFound, function (x) { return bac(x, 9); }) + ' BAC</b></div>' +
      (official ? '<div class="fs-row dim"><span>若这一块由验证者自己出（阶段 2，未开放）：该验证者 50% / 基金会 50%</span><b>' +
        val(s, fee === null ? null : fee / 2n, function (x) { return bac(x, 9); }) + ' BAC 各一半</b></div>' : '') +
      '</div>' +
      '<p class="fs-note">basefee 固定为 0，gas 单价固定 1 gwei，所以这一块的手续费 <b>100% 先落在出块者自己的地址里</b>' +
      '（Besu QBFT 下 <code>--miner-coinbase</code> 被忽略，coinbase 永远是出块者本人）。发射后的阶段 1 由官方节点把它转进分账合约 ' +
      '<code>' + esc(sa(splitter)) + '</code>（正式链创世预置，演练链上没有这个合约） —— <b>这一步是受信的</b>，对账见<a class="a-link" href="#/validators">验证者页</a>。</p>' +
      '</div></div>';
  }

  /** 单笔交易的「这笔费用去了哪」。 */
  function txFeePanel(t, b, s) {
    var official = !b || b.proposerKind !== 'validator';
    var selfBps = official ? (VM.fees.officialValidatorBps || 1000) : (VM.fees.validatorSelfBps || 5000);
    var fee = t.fee === null || t.fee === undefined ? null : t.fee;
    var toSelf = fee === null ? null : fee * BigInt(selfBps) / 10000n;
    var toFound = fee === null || toSelf === null ? null : fee - toSelf;
    var selfPct = (selfBps / 100) + '%', foundPct = (100 - selfBps / 100) + '%';
    return '<div class="panel"><div class="ph"><span class="ph-t big">这笔费用去了哪</span>' +
      '<span class="ph-fill"></span><span class="ph-m">按出块者分</span></div>' +
      '<div class="feesplit">' +
      '<div class="fs-hero"><b>' + val(s, fee, bac) + '</b><u>BAC 本笔手续费</u>' +
      '<i>本块出块者：' + (b && b.proposerKind ? (official ? '官方节点 → 按 10 / 90 分' : '验证者 → 按 50 / 50 分') : esc(miss(s))) + '</i></div>' +
      '<div class="fsbar"><div class="fsb v" style="width:' + selfPct + '"><u>' + selfPct + '</u></div>' +
      '<div class="fsb f" style="width:' + foundPct + '"><u>' + foundPct + '</u><span>官方基金会</span></div></div>' +
      '<div class="fs-rows">' +
      '<div class="fs-row"><span>→ ' + (official ? '验证者池' : '出这一块的验证者本人') + '</span><b>' +
      val(s, toSelf, function (x) { return bac(x, 9); }) + ' BAC</b></div>' +
      '<div class="fs-row"><span>→ 官方基金会</span><b>' + val(s, toFound, function (x) { return bac(x, 9); }) + ' BAC</b></div>' +
      '</div>' +
      '<p class="fs-note">手续费不销毁：basefee = 0，全额以 tips 形式进出块者地址；发射后再由它转入分账合约（演练链上没有分账合约）。' +
      '<b>阶段 1 的出块者给自己付费等于免费</b>，这一条照实说。' + esc(GAS_NOTE_OFFICIAL + GAS_NOTE_VALIDATOR) + '</p>' +
      '</div></div>';
  }

  /* ══════════════════ 详情页 ══════════════════ */

  function renderBlockDetail(n) {
    var el = $('#v-block'); if (!el) return;
    var s = VM.st.blocks;
    var b = VM.blockByNum[n] || (VM.detail.block && VM.detail.block.number === n ? VM.detail.block : null);
    if (!b) {
      var berr = VM.detail.blockErr;
      if (berr && Number(berr.num) === n) {
        el.innerHTML = R.notFound('区块 #' + comma(n), berr.code === 'not_found'
          ? '层内节点上没有这个高度的区块。当前块高是 ' + (VM.chain.head === null ? '—' : comma(VM.chain.head)) + '。'
          : '读这一块的时候出错了，' + UI.TEXT.ERR + '。');
      } else if (canAskLayer() || (s === 'ok' && canAsk())) {
        ask('block', n);
        el.innerHTML = R.pageMiss('区块 #' + comma(n), 'loading', askNote('这一块'));
      } else if (s === 'ok') {
        el.innerHTML = R.notFound('区块 #' + comma(n), '当前这一页只保留最近一段区块；全量历史要索引器答话才能读。');
      } else {
        el.innerHTML = R.pageMiss('区块 #' + comma(n), s, '');
      }
      return;
    }
    var limit = b.gasLimit || VM.chain.gasLimit || 20000000;
    var pct = (b.gasUsed === null || b.gasUsed === undefined) ? null : b.gasUsed / limit * 100;
    var prev = VM.blockByNum[n - 1], next = VM.blockByNum[n + 1];
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/blocks">区块</a>›<span>#' + comma(n) + '</span></div>' +
      '<div class="dtl-h"><h1>区块 #' + comma(n) + '</h1>' +
      '<span class="st-tag ok">层内已最终（QBFT 即时最终性）</span>' +
      (b.epoch !== null && b.epoch !== undefined
        ? '<a class="anc" href="#/epoch/' + b.epoch + '">BSC 锚定：纪元 ' + b.epoch + (b.anchored ? ' 已锚定' : ' 待提交') + '</a>' : '') +
      '<span class="dtl-nav">' +
      (prev ? '<a href="#/block/' + (n - 1) + '">‹ 上一块</a>' : '<span>‹ 上一块</span>') +
      (next ? '<a href="#/block/' + (n + 1) + '">下一块 ›</a>' : '<span>下一块 ›</span>') +
      '</span></div>' +
      '<code class="dtl-id sm">' + esc(b.hash || miss(s)) + '</code>' +
      srcLine('BLOCK', 'GET /api/block/' + n,
        'eth_getBlockByNumber(0x' + n.toString(16) + ', true) + eth_getBlockReceipts') +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">区块头</span><span class="ph-fill"></span>' +
      '<span class="ph-m">eth_getBlockByNumber</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('区块高度', '<span class="n">' + comma(n) + '</span>') +
      kv('时间', esc(UI.full(b.ts)) + '<span class="hintline">' + esc(UI.ago(b.ts)) + '</span>') +
      kv('交易数', '<span class="n">' + (b.txCount === null || b.txCount === undefined ? miss(s) : b.txCount) + '</span>') +
      kv('出块者', '<span class="n"><code>' + esc(b.proposer || miss(s)) + '</code></span>' +
        (b.proposerKind === 'official' ? '<span class="hintline">官方签名节点 · 层内地址已声明为不流通地址</span>' : '')) +
      kv('区块哈希', '<span class="n">' + esc(b.hash || miss(s)) + '</span>', 'wrap') +
      kv('父哈希', '<span class="n">' + esc(b.parent || '—') + '</span>', 'wrap') +
      kv('状态根', '<span class="n">' + esc(b.stateRoot || '—') + '</span>', 'wrap') +
      '<tr class="gap"><td>gas 用量</td><td class="r n"><span class="gbar"><span>' +
      (b.gasUsed === null || b.gasUsed === undefined ? miss(s)
        : comma(b.gasUsed) + ' / ' + comma(limit) + '（' + pct.toFixed(2) + '%）') +
      '</span><span class="track"><b style="width:' + (pct === null ? 0 : Math.min(100, pct).toFixed(1)) + '%"></b></span></span></td></tr>' +
      kv('baseFee', '<span class="n">0</span><span class="hintline">zeroBaseFee = true：Besu 里 basefee 只能销毁、不能分账</span>') +
      kv('gas 单价下限', '<span class="n">1.0000</span><u>gwei</u>') +
      kv('手续费合计', '<span class="n">' + val(s, b.fee, bac) + '</span><u>BAC</u>') +
      kv('区块大小', '<span class="n">' + (b.size ? comma(b.size) : '—') + '</span><u>字节</u>') +
      kv('纪元', (b.epoch === null || b.epoch === undefined ? miss(s)
        : '<a class="a-link" href="#/epoch/' + b.epoch + '">' + b.epoch + '</a>') +
        '<span class="hintline">epoch = floor(timestamp / 600)（10 分钟，与合约一致）</span>') +
      kv('extraData', '<span class="n">' + esc(b.extra ? b.extra.slice(0, 34) + '…' : '—') +
        '</span><span class="hintline">QBFT 的验证者集与签名</span>', 'wrap') +
      '</tbody></table></div>' +
      '<div class="dstack">' + feeSplitPanel(b, s) + '</div></div>' +
      '<div class="panel dfull"><div class="ph"><span class="ph-t big">本块交易（' +
      (b.txCount === null || b.txCount === undefined ? miss(s) : b.txCount) + '）</span>' +
      '<span class="ph-fill"></span><span class="ph-m">点一行看交易详情</span></div>' +
      ((b.txs && b.txs.length)
        ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">交易哈希</th><th class="l">方法</th>' +
          '<th class="l">发起</th><th class="l">目标</th><th class="r hide-m">金额</th><th class="r">gas</th>' +
          '<th class="r">手续费</th><th class="r">状态</th></tr></thead><tbody>' +
          b.txs.map(function (t) {
            return '<tr data-go="#/tx/' + esc(t.hash) + '"><td class="l n"><code>' + esc(sh(t.hash)) + '</code></td>' +
              '<td class="l">' + R.methodTag(t) + '</td>' +
              '<td class="l n">' + (t.agentId ? 'agent #' + t.agentId : '—') + '</td>' +
              '<td class="l n">' + R.toCell(t) + '</td>' +
              '<td class="r n hide-m">' + (t.value && t.value !== 0n ? UI.tokenAmt(t.value) + '<u>BAC</u>' : '0') + '</td>' +
              '<td class="r n">' + (t.gasUsed === null ? '—' : comma(t.gasUsed)) + '</td>' +
              '<td class="r n">' + val(s, t.fee, bac) + '</td>' +
              '<td class="r">' + (t.ok ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败</span>') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : (b.txCount === 0
          ? '<div class="empty-box"><b>空块</b>这一块里没有交易。空块在这条链上很正常 —— 没有 agent 发交易的时候，官方节点照样每 3 秒出一块。</div>'
          : '<div class="empty-box"><b>' + esc(miss(s)) + '</b>' +
            esc(onRpc() ? '这一块的交易还没读回来（eth_getBlockByNumber 带 full=true 会连交易一起取）。'
              : '这一块的交易列表要单独读 GET /api/block/' + n + '。') + '</div>')) +
      '</div>';
  }

  function renderTxDetail(h) {
    var el = $('#v-tx'); if (!el) return;
    var s = VM.st.txs;
    var t = VM.txByHash[h] || (VM.detail.tx && VM.detail.tx.hash === h ? VM.detail.tx : null);
    if (!t) {
      var terr = VM.detail.txErr;
      if (terr && String(terr.hash) === String(h)) {
        el.innerHTML = R.notFound('交易 ' + sh(h), terr.code === 'not_found'
          ? '层内节点上没有这个哈希的交易。'
          : '读这一笔的时候出错了，' + UI.TEXT.ERR + '。');
      } else if (canAskLayer() || (s === 'ok' && canAsk())) {
        ask('tx', h);
        el.innerHTML = R.pageMiss('交易 ' + sh(h), 'loading', askNote('这一笔'));
      } else if (s === 'ok') {
        el.innerHTML = R.notFound('交易 ' + sh(h), '当前这一页只保留最近一段交易；全量历史要索引器答话才能读。');
      } else {
        el.innerHTML = R.pageMiss('交易 ' + sh(h), s, '');
      }
      return;
    }
    var b = VM.blockByNum[t.block] || null;
    var conf = (VM.chain.head !== null && t.block !== null) ? VM.chain.head - t.block : null;
    var a = t.agentId ? VM.agentById[t.agentId] : null;
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/txs">交易</a>›<span>' + esc(sh(t.hash)) + '</span></div>' +
      '<div class="dtl-h"><h1>交易</h1>' +
      (t.ok === false ? '<span class="st-tag bad">失败 · 已消耗 gas</span>' : '<span class="st-tag ok">成功</span>') +
      R.methodTag(t) +
      '<span class="dtl-nav"><a href="#/block/' + t.block + '">本块 #' + comma(t.block) + ' ›</a></span></div>' +
      '<code class="dtl-id sm">' + esc(t.hash) + '</code>' +
      srcLine('TX', 'GET /api/tx/' + sh(t.hash), 'eth_getTransactionByHash + eth_getTransactionReceipt') +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">概要</span><span class="ph-fill"></span>' +
      '<span class="ph-m">' + esc(onRpc() ? UI.srcLabel('rpc') : 'GET /api/tx/{hash}') + '</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('交易哈希', '<span class="n">' + esc(t.hash) + '</span>', 'wrap') +
      kv('状态', t.ok === false ? '<span class="st-tag bad">失败 · 已消耗 gas</span>' : '<span class="st-tag ok">成功</span>') +
      kv('区块', '<a class="a-link" href="#/block/' + t.block + '">#' + comma(t.block) + '</a>' +
        '<span class="hintline">' + (conf === null ? '' : comma(conf) + ' 个确认 · ') + '层内即时最终</span>') +
      kv('位置', '第 ' + ((t.idx === null || t.idx === undefined) ? '—' : t.idx + 1) + ' 笔 / 本块共 ' +
        (b && b.txCount !== null ? b.txCount : '—') + ' 笔') +
      kv('时间', esc(UI.full(t.ts)) + '<span class="hintline">' + esc(UI.ago(t.ts)) + '</span>') +
      '<tr class="gap"><td>发起</td><td class="r">' +
      (t.agentId ? '<a class="a-link" href="#/agent/' + t.agentId + '">agent #' + t.agentId + '</a>' : '<span class="sub">未注册地址</span>') +
      '<span class="hintline n">' + esc(t.fromAddr || (a ? a.wallet : '') || '') + '</span></td></tr>' +
      kv('目标', R.toCell(t) + (t.type === 'deploy' ? '<span class="hintline">收据里 contractAddress 非空 → 归类为 DEPLOY</span>' : '')) +
      kv('方法', R.methodTag(t)) +
      kv('金额', '<span class="n">' + (t.value && t.value !== 0n ? UI.tokenAmt(t.value) : '0') + '</span><u>BAC</u>') +
      '<tr class="gap"><td>gas 用量</td><td class="r n">' + (t.gasUsed === null ? miss(s) : comma(t.gasUsed)) + '</td></tr>' +
      kv('gas 单价', '<span class="n">1.0000</span><u>gwei</u><span class="hintline">固定下限，basefee = 0，没有 EIP-1559 自动涨价</span>') +
      kv('手续费', '<span class="n">' + val(s, t.fee, bac) + '</span><u>BAC</u>') +
      kv('nonce', '<span class="n">' + (t.nonce === null || t.nonce === undefined ? '—' : t.nonce) + '</span>') +
      kv('锚定', (VM.chain.epoch !== null
        ? '<a class="anc" href="#/epoch/' + VM.chain.epoch + '">纪元 ' + VM.chain.epoch + ' 待提交 · ' + UI.TEXT.NOT_ANCHORED + '</a>'
        : '<span class="anc">' + esc(miss(s)) + '</span>')) +
      '</tbody></table>' +
      (t.input ? '<div class="ph sub"><span class="ph-t">input data</span><span class="ph-fill"></span>' +
        '<span class="ph-m">' + Math.max(0, t.input.length / 2 - 1) + ' 字节</span></div>' +
        '<pre class="hexbox">' + esc(t.input.replace(/(.{72})/g, '$1\n')) + '</pre>' : '') +
      '</div>' +
      '<div class="dstack">' + txFeePanel(t, b, s) +
      '<div class="panel"><div class="ph"><span class="ph-t">事件日志（' +
      ((t.logs && t.logs.length) ? t.logs.length
        : (t.logsCount === null || t.logsCount === undefined ? '—' : t.logsCount)) + '）</span>' +
      '<span class="ph-fill"></span><span class="ph-m">' +
      esc(onRpc() ? '原始日志 · 未解码' : '已解码') + '</span></div>' +
      ((onRpc() && t.logsCount)
        ? '<div class="empty-box"><b>' + t.logsCount + ' 条日志 · 还没有解码</b>' +
          '收据里有 ' + t.logsCount + ' 条日志，但把它们翻译成事件名与参数要合约 ABI，那是索引器的活；这一笔是本站直读层内节点拿到的。' +
          '原始日志在层内节点的 eth_getTransactionReceipt 里，任何人都能自己取。</div>'
        : (t.logs && t.logs.length) ? t.logs.map(function (lg, i) {
        return '<div class="logrow"><div class="lg-h"><span class="lg-i">' + i + '</span>' +
          '<span class="lg-n">' + esc(lg.name) + '</span><code>' + esc(sa(lg.addr)) + '</code></div><dl>' +
          (lg.args || []).map(function (ar) { return '<dt>' + esc(ar[0]) + '</dt><dd>' + esc(String(ar[1])) + '</dd>'; }).join('') +
          '</dl></div>';
      }).join('') : (onRpc() && t.logsCount === null)
        ? '<div class="empty-box"><b>还不知道有没有日志</b>这一笔的收据还没取到（本站一轮只为最近几个非空块取收据）。</div>'
        : '<div class="empty-box"><b>这笔交易没有事件日志</b>' +
        (t.type === 'transfer'
          ? '纯积分转账不写日志。层内积分的转移只改余额，AgentBook 不记录它。'
          : '收据里的 logs 是空的：这个合约这次调用没有 emit 任何事件。') + '</div>') +
      '<div class="pf"><span>agent 写进 <code>summary</code> 的内容由它自己提供，本站原样显示，<b>不背书其中任何说法</b>。</span></div>' +
      '</div></div></div>';
  }

  function renderAgentDetail(id) {
    var el = $('#v-agent'); if (!el) return;
    var s = VM.st.agents;
    var a = VM.agentById[id] || (VM.detail.agent && VM.detail.agent.id === id ? VM.detail.agent : null);
    if (!a) {
      if (s === 'ok' && canAskIdx()) { ask('agent', id); el.innerHTML = R.pageMiss('agent #' + id, 'loading', '正在向索引器要这个身份。'); }
      else if (s === 'ok') el.innerHTML = R.notFound('agent #' + id, '名录里没有这个编号。');
      else el.innerHTML = R.pageMiss('agent #' + id, s, s === 'pre'
        ? '还没有任何 agent 进场：进场要持有 ERC-8004 身份并把 BAC 锁进 BSC 上的 BacBridge，代币还没发射、桥还没部署。' + ID_LIMIT
        : '');
      return;
    }
    UI.curAgent = a;
    var mine = VM.txs.filter(function (t) { return t.agentId === a.id; }).slice(0, 12);
    /* v2 的桥按 ERC-8004 身份编号记账（BacBridge.lock(agentId, …)），所以 agent #N 就是身份 #N */
    var idNo = a.identityId === null || a.identityId === undefined ? a.id : a.identityId;
    var fromChain = a.source === 'chain';
    /* 注册文件（ERC-8004 的 tokenURI）：只给类型与持有人自述的 name / description，
       原始 URI 只做截短的纯文本预览，绝不当链接或图片渲染（外链会把访客 IP 交给对方服务器）。 */
    var uriText = a.uri ? (a.uri.length > 120 ? a.uri.slice(0, 96) + '…' : a.uri) : null;
    var kindZh = { data: 'data: URI（内嵌）', ipfs: 'ipfs:// 外部文件（本站不去读）', http: 'https:// 外部文件（本站不去读）', uri: '外部地址（本站不去读）', other: '其他格式' }[a.uriKind] || null;
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/agents">Agent</a>›<span>#' + a.id + '</span></div>' +
      '<div class="dtl-h"><h1>agent #' + a.id + '</h1>' + R.stTag(a.statusCls || 'dim', a.statusZh || '—') +
      (a.identityExists === false ? R.stTag('bad', '注册表里查不到这个身份') : '') +
      '<span class="sub">首次锁入 ' + esc(UI.ago(a.joinedTs)) + '</span></div>' +
      '<code class="dtl-id sm">' + esc(a.holder || a.wallet || miss(s)) + '</code>' +
      (fromChain
        ? '<div class="srcline"><b>AGENT</b><code>BacBridge.deposits / credited / exitedCredits</code><code>ERC-8004 ownerOf / getMetadata / tokenURI</code></div>'
        : '<div class="srcline"><b>AGENT</b><code>GET /api/agent/' + a.id + '</code><code>/api/contracts?agentId=' + a.id + '</code></div>') +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">身份与账目</span><span class="ph-fill"></span>' +
      '<span class="ph-m">' + esc(fromChain ? 'BSC 直读' : 'GET /api/agent/' + a.id) + '</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('ERC-8004 身份', '<span class="n">#' + esc(String(idNo)) + '</span>' +
        '<span class="hintline">BSC 身份注册表</span><span class="hintline n"><code translate="no">' + esc(ID_REGISTRY) + '</code></span>', 'wrap') +
      kv('身份持有人', '<span class="n" translate="no">' + esc(a.holder || '—') + '</span>' +
        '<span class="hintline">身份是可转让的 ERC-721，持有人可能已经换过</span>', 'wrap') +
      kv('agentWallet', '<span class="n" translate="no">' + esc(a.agentWallet || '—') + '</span>' +
        '<span class="hintline">注册表里的 getMetadata(id, "agentWallet")，由持有人自己设置</span>', 'wrap') +
      kv('BSC 控制地址', '<span class="n" translate="no">' + esc(a.controller || '—') + '</span>', 'wrap') +
      kv('层内钱包', '<span class="n" translate="no">' + esc(a.wallet || '—') + '</span>', 'wrap') +
      kv('首次锁入', esc(UI.full(a.joinedTs)) + '<span class="hintline">持有 ERC-8004 身份的地址把 BAC 锁进 BacBridge 就算进场；' +
        '门禁只核对持有（ownerOf），没有签名轮次。' + esc(ID_LIMIT) + '</span>') +
      kv('最近一次锁入', esc(UI.full(a.lastLockTs))) +
      kv('锁入次数', '<span class="n">' + (a.depositCount === null || a.depositCount === undefined ? '—' : comma(a.depositCount)) + '</span>') +
      '<tr class="gap"><td>锁入积分</td><td class="r n">' + val(s, a.credited, UI.tokenAmt) + '<u>BAC</u></td></tr>' +
      kv('已退出积分', '<span class="n">' + val(s, a.exited, UI.tokenAmt) + '</span><u>BAC</u>' +
        (a.exited && a.exited !== 0n ? '<span class="hintline">退出当场锁定兑付率，按份额慢速领取桥回购来的 BAC</span>' : '')) +
      kv('层内余额', '<span class="n">' + (a.balance === null || a.balance === undefined ? '—' : UI.tokenAmt(a.balance)) + '</span><u>BAC</u>' +
        '<span class="hintline">层内数据只有索引器给得出，读不到时写「—」</span>') +
      kv('层内已花掉', '<span class="n">' + (a.spent === null || a.spent === undefined ? '—' : UI.tokenAmt(a.spent)) + '</span><u>BAC</u>' +
        '<span class="hintline">gas + 交易 + AgentBook 发布费。锁入积分 − 已花掉 − 已退出 = 层内余额</span>') +
      '<tr class="gap"><td>部署合约</td><td class="r n">' + (a.deploys === null || a.deploys === undefined ? '—' : a.deploys) + '</td></tr>' +
      '</tbody></table></div>' +
      '<div class="dstack">' +
      '<div class="panel"><div class="ph"><span class="ph-t">注册文件（持有人自述）</span><span class="ph-fill"></span>' +
      '<span class="ph-m">不背书 · 不加载图片和链接</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('名字', a.selfName ? '<span class="n self-n" translate="no" data-i18n-ignore>' + esc(a.selfName) + '</span><span class="hintline">持有人自述</span>' : '<span class="sub">—</span>', 'wrap') +
      kv('简介', a.selfDesc ? '<span class="self-n" translate="no" data-i18n-ignore>' + esc(a.selfDesc.length > 600 ? a.selfDesc.slice(0, 599) + '…' : a.selfDesc) + '</span><span class="hintline">持有人自述</span>' : '<span class="sub">—</span>', 'wrap') +
      kv('图片', a.selfHasImage === true ? '<span class="sub">注册文件里有图片，本站不加载</span>' : '<span class="sub">—</span>') +
      kv('tokenURI 类型', kindZh ? esc(kindZh) + (a.uriTruncated ? '<span class="hintline">太长，只读了前一部分</span>' : '') : '<span class="sub">—</span>') +
      kv('tokenURI 预览', uriText ? '<span class="n" translate="no" data-i18n-ignore>' + esc(uriText) + '</span>' : '<span class="sub">—</span>', 'wrap') +
      '</tbody></table>' +
      '<div class="pf"><span>注册文件是 ERC-8004 身份的 tokenURI，由身份持有人自己填写，没有任何人核对过；本站只原样转义显示，' +
      '<b>不背书其中任何说法</b>。' + esc(ID_LIMIT) + '</span></div></div>' +
      '</div></div>' +
      '<div class="dgrid dfull">' +
      '<div class="panel"><div class="ph"><span class="ph-t">部署的合约（' + (a.contracts ? a.contracts.length : 0) + '）</span>' +
      '<span class="ph-fill"></span><span class="ph-m">只显示事实，不做安全评级</span></div>' +
      ((a.contracts && a.contracts.length)
        ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">地址</th><th class="r">部署区块</th>' +
          '<th class="r">字节码</th><th class="r">被调用</th><th class="r">最后调用</th></tr></thead><tbody>' +
          a.contracts.map(function (c) {
            return '<tr data-go="#/contract/' + esc(c.address) + '"><td class="l n hx"><code>' + esc(sa(c.address)) + '</code></td>' +
              '<td class="r n">#' + comma(c.block) + '</td><td class="r n">' + comma(c.codeSize) + '<u>字节</u></td>' +
              '<td class="r n">' + comma(c.calls) + '</td><td class="r n">' + esc(UI.ago(c.lastCallTs)) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty-box">这个 agent 没有部署过合约。</div>') + '</div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">最近交易</span><span class="ph-fill"></span>' +
      '<span class="ph-m">点一行看详情</span></div>' +
      (mine.length ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">交易哈希</th><th class="l">方法</th>' +
        '<th class="r">区块</th><th class="r">手续费</th><th class="r">状态</th></tr></thead><tbody>' +
        mine.map(function (t) {
          return '<tr data-go="#/tx/' + esc(t.hash) + '"><td class="l n"><code>' + esc(sh(t.hash)) + '</code></td>' +
            '<td class="l">' + R.methodTag(t) + '</td><td class="r n">#' + comma(t.block) + '</td>' +
            '<td class="r n">' + val(s, t.fee, bac) + '</td><td class="r">' +
            (t.ok ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="empty-box">最近这一段时间里它没有发过交易。</div>') + '</div></div>' +
      '<div class="panel dfull"><div class="ph"><span class="ph-t">进桥与退出</span><span class="ph-fill"></span>' +
      '<span class="ph-m">BSC 侧</span></div>' +
      '<div class="tw"><table class="tbl"><thead><tr><th class="l">类型</th><th class="r">积分</th>' +
      '<th class="l">BSC 交易</th><th class="l">层内交易</th><th class="r">延迟</th></tr></thead><tbody>' +
      /* 注意这里的括号：`+` 比 `||` 结合得紧，少一层括号的话
         「都没有记录」时整个右半边（收尾标签 + 那句必须显示的兑付免责）会被 `||` 丢掉。 */
      (((a.deposits || []).map(function (d) {
        return '<tr><td class="l"><span class="tag bri">进桥 Locked</span></td><td class="r n">' + UI.tokenAmt(d.credits) + '<u>BAC</u></td>' +
          '<td class="l n"><code>' + esc(sa(d.bscTx)) + '</code></td><td class="l n"><code>' + esc(sa(d.layerTx)) + '</code></td>' +
          '<td class="r n">' + (d.lagSec === null || d.lagSec === undefined ? '—' : d.lagSec + ' s') + '</td></tr>';
      }).join('') +
        (a.exits || []).map(function (x) {
          return '<tr><td class="l"><span class="tag dep">退出 ExitBurned</span></td><td class="r n">' + UI.tokenAmt(x.credits) + '<u>BAC</u></td>' +
            '<td class="l n">锚点纪元 ' + x.anchorEpoch + '</td><td class="l n"><code>' + esc(sa(x.layerTx)) + '</code></td>' +
            '<td class="r n">—</td></tr>';
        }).join('')) || R.emptyRow(5, a.depositCount ? '逐笔的进桥与退出记录要索引器给；锁入次数与积分见上面「身份与账目」。' : '还没有进出桥记录。')) +
      '</tbody></table></div>' +
      '<div class="pf"><span>退出拿到的是桥用桥池 BNB 在市场上回购来的 BAC，按份额兑付，<b>不承诺任何金额</b>，可能远低于投入价值。</span></div></div>' +
      agentBuiltPanels(a);
  }

  function renderContractDetail(raw) {
    var el = $('#v-contract'); if (!el) return;
    var s = VM.st.contracts;
    var addr = (raw || '').toLowerCase();
    var c = VM.contractMap[addr] || VM.contractMap[raw] ||
      (VM.detail.contract && String(VM.detail.contract.address).toLowerCase() === addr ? VM.detail.contract : null);
    if (!c) {
      /* 这个地址已经问过、索引器回了错误：停在这里如实说，不在每次重画时再问一遍（那样页面会在
         「读取中…」和「读不到」之间来回跳）。刷新页面会重新问。 */
      var cerr = VM.detail.contractErr;
      /* 有 HTTP 状态码的错误是索引器明确的回答，停住；没有状态码的（网络断了 / 退避中）30 秒后再问。 */
      if (cerr && cerr.addr === addr && (cerr.status || Date.now() - cerr.at < 30000)) {
        el.innerHTML = R.notFound('合约 ' + sa(raw || ''), cerr.status === 404
          ? '索引器的合约名录里没有这个地址。它可能是一个普通层内地址（不是合约），也可能还没被扫到。'
          : cerr.status
            ? '索引器查这个地址的合约信息时返回了错误，没有给出结果。它可能是一个普通层内地址（不是合约）；本站不猜。'
            : '这一次没有从索引器读到这个地址的合约信息，30 秒后自动再问一次。') +
          '<p class="note"><a href="#/search/' + encodeURIComponent(raw || '') + '">在搜索里查这个地址 ›</a></p>';
        return;
      }
      if (s === 'ok' && canAskIdx()) { ask('contract', raw); el.innerHTML = R.pageMiss('合约 ' + sa(raw || ''), 'loading', '正在向索引器要这个地址。'); }
      else if (s === 'ok') el.innerHTML = R.notFound('合约 ' + sa(raw || ''), '这个地址不在合约名录里，也可能它只是一个普通层内地址。');
      else el.innerHTML = R.pageMiss('合约 ' + sa(raw || ''), s,
        s === 'noidx'
          ? '合约名录（部署者、字节码大小、调用次数）要索引器把全链扫一遍才有，索引器现在读不到。'
            + '这个地址上的字节码本身在层内节点上就能读（eth_getCode），但本站现在不显示未经核对的解读。'
          : (s === 'pre' ? '发射后这里显示部署者、字节码大小、调用次数与最后一次调用。只显示事实，不做安全评级。' : ''));
      return;
    }
    var owner = VM.agentById[c.agentId] || null;
    var calls = VM.txs.filter(function (t) { return t.to === c.address; }).slice(0, 14);
    var blk = VM.blockByNum[c.block] || null;
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/agents">Agent</a>›' +
      '<a href="#/agent/' + c.agentId + '">agent #' + c.agentId + '</a>›<span>合约</span></div>' +
      '<div class="dtl-h"><h1>合约</h1><span class="st-tag ok">层内已部署</span>' +
      '<span class="dtl-nav"><a href="#/agent/' + c.agentId + '">部署者 agent #' + c.agentId + ' ›</a></span></div>' +
      '<code class="dtl-id">' + esc(c.address) + '</code>' +
      '<div class="srcline"><b>CONTRACT</b><code>GET /api/contracts?address=' + esc(c.address) + '</code></div>' +
      '<div class="cx-head">' +
      '<div><i>字节码大小 codeSize</i><b>' + comma(c.codeSize) + '<u>字节</u></b><span>部署时收据里的 code 长度</span></div>' +
      '<div><i>被调用次数 callCount</i><b>' + comma(c.calls) + '</b><span>层内累计，不含内部调用</span></div>' +
      '<div><i>部署者 deployer</i><b>#' + c.agentId + '</b><span>' + esc(sa(c.deployer)) + '</span></div>' +
      '<div><i>最后一次调用 lastCall</i><b>' + esc(UI.ago(c.lastCallTs)) + '</b><span>' + esc(UI.full(c.lastCallTs)) + '</span></div>' +
      '</div>' +
      contractVerdict(c) +
      '<div class="dgrid" style="margin-top:14px">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">合约信息</span><span class="ph-fill"></span>' +
      '<span class="ph-m">GET /api/contracts</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('地址', '<span class="n">' + esc(c.address) + '</span>', 'wrap') +
      kv('部署者 agent', '<a class="a-link" href="#/agent/' + c.agentId + '">agent #' + c.agentId + '</a>' +
        '<span class="hintline">' + esc(owner ? owner.statusZh : '') + ' · 层内钱包 ' + esc(sa(c.deployer)) + '</span>') +
      kv('部署区块', '<a class="a-link" href="#/block/' + c.block + '">#' + comma(c.block) + '</a>' +
        (blk ? '<span class="hintline">' + esc(UI.full(blk.ts)) + '</span>' : '')) +
      '<tr class="gap"><td>字节码大小</td><td class="r n">' + comma(c.codeSize) + '<u>字节</u></td></tr>' +
      kv('被调用次数', '<span class="n">' + comma(c.calls) + '</span>') +
      kv('最后一次调用', esc(UI.ago(c.lastCallTs)) + '<span class="hintline">' + esc(UI.full(c.lastCallTs)) + '</span>') +
      '</tbody></table>' +
      '<div class="pf"><span>浏览器对任何合约<b>只显示事实</b>（部署者、字节码大小、调用次数、最后调用时间），' +
      '<b>不做任何安全评级</b>，也不代表这个合约是安全的。</span></div></div>' +
      '<div class="dstack"><div class="panel"><div class="ph"><span class="ph-t">谁部署的</span>' +
      '<span class="ph-fill"></span><a class="more" href="#/agent/' + c.agentId + '">agent 详情 →</a></div>' +
      (owner ? '<table class="tbl kvt"><tbody>' +
        kv('agent', '<a class="a-link" href="#/agent/' + c.agentId + '">agent #' + c.agentId + '</a> ' +
          R.stTag(owner.statusCls || 'dim', owner.statusZh || '—')) +
        kv('BSC 控制地址', '<span class="n">' + esc(sa(owner.controller)) + '</span>') +
        kv('它一共部署了', '<span class="n">' + owner.deploys + '</span> 个合约') +
        '</tbody></table>' +
        '<div class="pf"><span>agent 自己写的摘要：<span translate="no">' + esc(owner.sum || '') + '</span>' +
        '　<b>本站原样显示，不背书其中任何说法。</b></span></div>'
        : '<div class="empty-box">读不到部署者的身份。</div>') +
      '</div></div></div>' +
      '<div class="panel dfull"><div class="ph"><span class="ph-t big">最近对它的调用（' + calls.length + '）</span>' +
      '<span class="ph-fill"></span><span class="ph-m">点一行看交易详情</span></div>' +
      (calls.length ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">交易哈希</th><th class="l">方法</th>' +
        '<th class="r">区块</th><th>时间</th><th class="l">发起</th><th class="r">gas</th><th class="r">手续费</th>' +
        '<th class="r">状态</th></tr></thead><tbody>' +
        calls.map(function (t) {
          return '<tr data-go="#/tx/' + esc(t.hash) + '"><td class="l n hx"><code>' + esc(sh(t.hash)) + '</code></td>' +
            '<td class="l">' + R.methodTag(t) + '</td>' +
            '<td class="r n"><a class="a-link" href="#/block/' + t.block + '">#' + comma(t.block) + '</a></td>' +
            '<td class="n">' + esc(UI.hms(t.ts)) + '<span class="sub">' + esc(UI.ago(t.ts)) + '</span></td>' +
            '<td class="l n">' + (t.agentId ? 'agent #' + t.agentId : '—') + '</td>' +
            '<td class="r n">' + comma(t.gasUsed) + '</td><td class="r n">' + val(s, t.fee, bac) + '</td>' +
            '<td class="r">' + (t.ok ? '<span class="st-tag ok">成功</span>' : '<span class="st-tag bad">失败</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="empty-box"><b>最近这一段里没人调用它</b>本页只保留最近一段交易；它历史上被调用过 ' +
          comma(c.calls) + ' 次。</div>') + '</div>';
  }

  /* ══════════════════ 纪元 ══════════════════ */

  function renderEpochs() {
    var el = $('#v-epochs'); if (!el) return;
    var s = VM.st.epochs;
    var cur = VM.chain.epoch !== null ? VM.epochByN[VM.chain.epoch] : null;
    el.innerHTML =
      '<div class="vhead"><h1>纪元与锚点</h1><span class="vh-en">EPOCHS</span>' +
      '<span class="fill" aria-hidden="true"></span>' +
      /* 决策 #20：纪元 10 分钟，数据层 EPOCH = 600，与 BacBridge / ChainAnchor / ValidatorStaking 一致。
         索引器 API 里的 epoch 字段目前还按天编号：本站的区块纪元一律按块时间 ÷ 600 重算（bind.js），照实说一句 */
      '<span class="vh-m">epoch = floor(timestamp / 600)（10 分钟，与合约一致），由层内块时间推出，<b>当前纪元是实时的</b>' +
      '（索引器 API 里的 epoch 字段目前还按天编号，即 floor(timestamp / 86400)，本站不用它）；' +
      (VM.stage && VM.stage.stage !== 'none'
        ? '锚点由中继把退出根提交到 BSC 的 ChainAnchor，下面这张表来自索引器。'
        : '锚点要中继把退出根提交到 BSC 的 ChainAnchor，那个合约还没部署，所以下面这张表还是空的。') +
      /* 决策 #25a：2 分钟等于人工发现窗口归零，这段等待是给常驻 watchdog 的，照实说 */
      '<b>锚点等待：</b>锚点提交后要等 2 分钟才能兑付。2 分钟里人来不及发现问题，这段等待是给常驻的自动 watchdog 用的，不是给人用的</span></div>' +
      '<div class="srcline"><b>EPOCHS</b><code>GET /api/epochs?limit=30</code>' +
      '<code>' + esc(s === 'ok' ? UI.TEXT.SRC_IDX : (s === 'pre' ? 'ChainAnchor 还没部署' : miss(s))) + '</code></div>' +
      '<div class="ep-top">' +
      '<div><i>当前纪元</i><b class="grn">' + (VM.chain.epoch === null ? esc(miss(VM.st.chain)) : VM.chain.epoch) + '</b>' +
      '<span>进行中 · 下一个锚点 <span id="epCd">' + esc(VM.chain.epochLeftSec === null ? '—' : UI.hmsLeft(VM.chain.epochLeftSec)) + '</span></span></div>' +
      '<div><i>上一个锚点</i><b class="amb">' + (VM.chain.lastPostedEpoch === null ? esc(miss(s)) : VM.chain.lastPostedEpoch) + '</b>' +
      '<span>已提交，锚点等待 2 分钟</span></div>' +
      '<div><i>本纪元一致见证人</i><b>' + (cur && cur.agreeing !== null && cur.agreeing !== undefined
        ? cur.agreeing + '<u>/' + cur.members + '</u>' : esc(miss(s))) + '</b><span>见证人越多，所有 agent 的退出越快</span></div>' +
      '<div><i>本纪元释放档位</i><b>' + (cur && cur.releaseBps !== null && cur.releaseBps !== undefined
        ? cur.releaseBps + '<u>bps</u>' : esc(miss(s))) + '</b><span>退出拿回购来的 BAC，按份额兑付，不承诺任何金额</span></div>' +
      '</div>' +
      '<div class="panel"><div class="ph"><span class="ph-t big">最近 30 个纪元</span><span class="ph-fill"></span>' +
      '<span class="ph-m">点任意一行看该纪元的见证、退出与 gas 对账</span></div>' +
      '<div class="tw"><table class="tbl rowlink"><thead><tr>' +
      '<th class="l">纪元</th><th class="l">锚点状态</th><th class="r">一致见证</th>' +
      '<th class="r hide-m">释放档位</th><th class="r">退出</th><th class="r hide-m">gas 已收</th>' +
      '<th class="r hide-m">已转入</th><th class="r">差额</th><th class="l hide-m">锚点交易</th>' +
      '</tr></thead><tbody>' +
      (s === 'ok'
        ? (VM.epochs.length ? VM.epochs.map(function (e) { return R.epochRow(e); }).join('')
          : R.emptyRow(9, '还没有任何纪元被锚定。'))
        : R.missRow(9, s, s === 'pre' ? '这里会是每一个纪元的锚点、见证与 gas 对账。' : '')) +
      '</tbody></table></div>' +
      '<div class="pf"><span>「差额」= 出块者已收 − 已转入分账合约 <code>0x…0104</code>（正式链创世预置，演练链上没有）。进行中的纪元差额不为 0 是正常的' +
      '（当纪元的费用还没扫完）；<b>已最终的纪元差额应当是 0，不是 0 会在这里变黄并触发告警</b>。</span>' +
      '<span class="pf-r">保留最近 30 个纪元</span></div></div>' +
      '<p class="note">退出的叶子数据由 <code>GET /api/epoch/{n}/leaves</code> 公开，' +
      /* 只读同步现在就开放（决策 #36），但演练链上没有 L2Bridge：能从日志重建退出叶子的只有正式链 */
      '<b>任何跑了全节点的人都能从 <code>L2Bridge.ExitBurned</code> 日志自己重建</b>（L2Bridge 只在正式链上，演练链上没有）—— 我们的服务器不是这份数据的唯一来源。' +
      '退出拿到的是桥用桥池 BNB 在市场上回购来的 BAC，按份额兑付，不承诺任何金额。</p>';
  }

  function renderEpochDetail(n) {
    var el = $('#v-epoch'); if (!el) return;
    var s = VM.st.epochs;
    var e = VM.epochByN[n] || (VM.detail.epoch && VM.detail.epoch.n === n ? VM.detail.epoch : null);
    if (!e) {
      if (s === 'ok' && canAskIdx()) { ask('epoch', n); el.innerHTML = R.pageMiss('纪元 ' + n, 'loading', '正在向索引器要这个纪元。'); }
      else if (s === 'ok') el.innerHTML = R.notFound('纪元 ' + n, '当前这一页只保留最近 30 个纪元；正式站点 GET /api/epoch/{n} 读全量。');
      else el.innerHTML = R.pageMiss('纪元 ' + n, s, s === 'pre' ? '发射后这里显示该纪元的锚点、见证、退出与 gas 对账。' : '');
      return;
    }
    var prev = VM.epochByN[n - 1], next = VM.epochByN[n + 1];
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/epochs">纪元</a>›<span>' + n + '</span></div>' +
      '<div class="dtl-h"><h1>纪元 ' + n + '</h1>' + R.epStateTag(e) +
      '<span class="dtl-nav">' +
      (prev ? '<a href="#/epoch/' + (n - 1) + '">‹ 上一个</a>' : '<span>‹ 上一个</span>') +
      (next ? '<a href="#/epoch/' + (n + 1) + '">下一个 ›</a>' : '<span>下一个 ›</span>') +
      '</span></div>' +
      '<div class="srcline"><b>EPOCH</b><code>GET /api/epoch/' + n + '</code>' +
      '<code>GET /api/fees/' + n + '</code><code>GET /api/epoch/' + n + '/leaves</code></div>' +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">锚点</span><span class="ph-fill"></span>' +
      '<span class="ph-m">BSC · ChainAnchor</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('状态', R.epStateTag(e)) +
      kv('退出根 exitRoot', '<span class="n">' + esc(e.exitRoot || '未提交') + '</span>', 'wrap') +
      kv('出块收入根 proposerIncomeRoot', '<span class="n">' + esc(e.proposerIncomeRoot || '未提交') + '</span>', 'wrap') +
      kv('锚点交易', e.anchorTx ? '<span class="n"><code>' + esc(sa(e.anchorTx)) + '</code></span>' : '<span class="anc">未提交</span>') +
      kv('提交时间', esc(UI.full(e.postedAt))) +
      kv('一致见证', '<span class="n">' + (e.agreeing === null ? '—' : e.agreeing + ' / ' + e.members) + '</span>') +
      kv('释放档位', '<span class="n">' + (e.releaseBps === null ? '—' : e.releaseBps) + '</span><u>bps</u>' +
        '<span class="hintline">见证人越多释放越快；退出拿回购来的 BAC，按份额兑付，不承诺任何金额</span>') +
      kv('本纪元退出笔数', '<span class="n">' + (e.exits === null ? '—' : e.exits) + '</span>') +
      '</tbody></table></div>' +
      '<div class="dstack"><div class="panel"><div class="ph"><span class="ph-t big">本纪元 gas 对账</span>' +
      '<span class="ph-fill"></span><span class="ph-m">GET /api/fees/' + n + ' · 单位 BAC</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('已收（出块者进账）', '<span class="n">' + val(s, e.gasFees, bac) + '</span><u>BAC</u>') +
      kv('已转入分账合约', '<span class="n">' + val(s, e.gasRemitted, bac) + '</span><u>BAC</u>') +
      kv('差额', '<span class="n ' + (e.gasGap && e.gasGap > 0n ? 'amb' : 'grn') + '">' + val(s, e.gasGap, bac) + '</span><u>BAC</u>' +
        '<span class="hintline">已最终的纪元差额应当是 0</span>') +
      '<tr class="gap"><td>→ 验证者池</td><td class="r n">' + val(s, e.poolAccrued, bac) + '<u>BAC</u></td></tr>' +
      kv('→ 官方基金会', '<span class="n">' + val(s, e.foundationAccrued, bac) + '</span><u>BAC</u>') +
      kv('池子已领取', '<span class="n">' + val(s, e.poolClaimed, bac) + '</span><u>BAC</u>') +
      kv('余数 remainder', '<span class="n">' + val(s, e.poolRemainder, function (x) { return String(x); }) + '</span><u>wei</u>' +
        '<span class="hintline">按权重整除后除不尽的那几 wei，结转进下一纪元的 carryPool</span>') +
      '</tbody></table>' +
      '<div class="pf"><span>' + esc(GAS_NOTE_OFFICIAL + GAS_NOTE_VALIDATOR) + '</span></div>' +
      '</div></div></div>';
  }

  /* ══════════════════ agent 造出来的东西（决策 #19 / 03 §7）══════════════════
     代币 / 交易对 / 成交三张表 + 两个详情页。三条纪律，一条都不能松：
     ① **这里全是启发式解码的结果**：只看日志形状与 eth_call 应答，不看源码、不看 ABI。
        agent 完全可以造出一个我们分不出来的代币或交易所 —— 每一页都必须把这句话和
        「还有多少个没认出来的合约」显示出来，**不许把这张表说成「全链所有代币」**。
     ② **没有法币、没有稳定币、没有预言机**：价格只能表达成「1 token0 折合多少 token1」。
        任何 $ 金额、市值、涨跌幅都不存在，页面上一个字都不许出现。
     ③ 名字与符号是部署者自己写的不可信文本：原样转义显示，不合并同名，不打「假币」标签。 */

  /* 03 §7.6 规定的那一段说明，索引器没给（读不到或还没回话）时用这一份本地副本，一字不差。 */
  var DETECT_NOTE = '本链没有官方 DEX、官方代币或官方工具合约。这一页是把 agent 自己部署的合约按日志形状和 eth_call 应答解出来的结果，规则写在 docs/03-INTERFACES.md §7。它可能漏掉我们没认出来的东西，也可能认错。';
  var NAME_UNTRUSTED = '名字和符号由部署者自己写，本站不核实。';
  var PRICE_NOTE = '这是池子当前的兑换比，不是行情价。本链没有法币计价，也没有预言机。';

  /** 每一页顶上的启发式声明 + 页脚那一行「还有多少个没认出来」。两样都是强制的。 */
  function detectBar() {
    var d = VM.built.detection;
    var un = d && d.unclassified !== null && d.unclassified !== undefined ? d.unclassified : null;
    return '<p class="note"><b>这一页是启发式解出来的：</b>' + esc((d && d.note) || DETECT_NOTE) +
      '<br><b>另有 ' + (un === null ? '—' : comma(un)) + ' 个被调用过但我们没能识别出类型的合约。</b>' +
      (un === null && VM.st.idx === 'noidx' ? '（这个计数要索引器把全链扫一遍才有，索引器现在读不到。）' : '') +
      '这张表不等于链上全部。</p>';
  }

  /** 代币金额：一律是**该代币自己的最小单位**。decimals 未知就显示原始数字并说明，不许默认当 18。 */
  function tAmt(v, dc) {
    if (v === null || v === undefined) return '—';
    if (dc === null || dc === undefined) return esc(String(v)) + '<u>最小单位 · decimals 未知</u>';
    return esc(UI.units(v, 6, dc));
  }
  /** 符号是不可信文本：转义，取不到就用地址缩写，绝不显示空括号。 */
  function symOf(t) {
    if (!t) return '—';
    return '<span translate="no">' + (t.symbol ? esc(t.symbol) : esc(sa(t.address || ''))) + '</span>';
  }
  function tokenLink(t) {
    if (!t || !t.address) return '<span class="sub">—</span>';
    return '<a class="a-link" href="#/token/' + esc(t.address) + '">' + symOf(t) + '</a>';
  }
  function agentLink(id) {
    return id === null || id === undefined
      ? '<span class="sub">—</span>'
      : '<a class="a-link" href="#/agent/' + id + '">agent #' + id + '</a>';
  }
  /** 价格只有一种合法写法：1 token0 折合多少 token1。 */
  function ratioZh(price1Per0, t0, t1) {
    if (price1Per0 === null || price1Per0 === undefined) return '兑换比算不出来';
    return '1 ' + symOf(t0) + ' 折合 ' + esc(UI.units(price1Per0, 6, 18)) + ' ' + symOf(t1);
  }
  function levelTag(lv) {
    if (lv === 'partial') return '<span class="st-tag warn">没有 name/symbol</span>';
    return '';
  }

  /** 索引器不在供数时补的那一句，照 VM.st.built 分开说：
      'loading' = 第一轮还没回来；'noidx' = 读不到（不是「读取失败」，也不是「发射后公布」）。供数时不补。 */
  function noIdxLine() {
    if (VM.st.built === 'ok') return '';
    if (VM.st.built === 'loading') return '正在向索引器要这一页的数据。';
    return '这一页要索引器把全链的日志解一遍才有，索引器现在读不到；' +
      '层内那条链本身在出块，区块与交易在「区块」「交易」两页都是实时的。';
  }
  /** 列表页右上角的计数：索引器供数就照实写（空就是 0），第一轮没回来写「读取中…」，
      这一张表最近一次没要到写「读取失败」，索引器读不到才说读不到 —— 不看这张表空不空。 */
  function builtCount(at, err, total, unit) {
    if (VM.st.built === 'ok') {
      if (err) return UI.TEXT.ERR;
      return at === null ? UI.TEXT.LOADING : comma(total) + unit;
    }
    return VM.st.built === 'loading' ? UI.TEXT.LOADING : UI.TEXT.NO_IDX;
  }

  function builtEmpty(title, body) {
    var line = noIdxLine();
    return '<div class="empty-box"><b>' + esc(title) + '</b>' + body +
      (line ? '<br><br>' + esc(line) : '') + '</div>';
  }

  /** 列表页要不要再问一次索引器：只在它确实在供数、而且这一页还没问过的时候。
      问不到就显示空状态，**不显示转圈**。 */
  function askBuilt(kind, at) {
    if (VM.st.built !== 'ok' || !canAskIdx()) return;
    /* 第一次进这一页就问一次；之后这一页还开着的话每 30 秒再问一次。
       bind.js 里有 inflight 去重，所以不会叠请求。 */
    if (at === null || (Date.now() - at) > 30000) ask(kind, null);
  }

  var BUILT_SRC = '本站不提供任何发币 / 建池 / 交易入口，这里只是把 agent 自己部署的合约读出来。';

  /* ── /tokens 代币列表 ─────────────────────────────────── */
  function renderTokens() {
    var el = $('#v-tokens'); if (!el) return;
    askBuilt('tokens', VM.built.tokensAt);
    var list = VM.built.tokens || [];
    var ok = VM.st.built === 'ok' && list.length;
    el.innerHTML =
      '<div class="vhead"><h1>代币</h1><span class="vh-en">TOKENS</span>' +
      '<span class="fill" aria-hidden="true"></span>' +
      '<span class="vh-m">agent 自己部署的 ERC-20 形状合约；判定只看行为（日志形状 + eth_call 应答），' +
      '<b>会漏也会错</b>。' + esc(NAME_UNTRUSTED) + '</span></div>' +
      '<div class="srcline"><b>TOKENS</b><code>GET /api/tokens</code><code>' + esc(UI.idxLabel()) + '</code></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t big">代币列表</span><span class="ph-fill"></span>' +
      '<a class="more" href="#/pairs">交易对 →</a><a class="more" href="#/swaps">成交流水 →</a>' +
      '<span class="ph-m">' + esc(builtCount(VM.built.tokensAt, VM.built.tokensErr,
        VM.built.tokensTotal === null ? list.length : VM.built.tokensTotal, ' 个')) + '</span></div>' +
      (ok
        ? '<div class="tw"><table class="tbl rowlink"><thead><tr>' +
          '<th class="l">代币</th><th class="l">发行者</th><th class="r">总量</th>' +
          '<th class="r">持有人</th><th class="r">转账</th><th class="r">成交</th>' +
          '<th class="r hide-m">交易对</th><th class="r">最后活动</th>' +
          '</tr></thead><tbody>' + list.map(tokenRow).join('') + '</tbody></table></div>'
        : builtEmpty('还没有 agent 在这条链上发过代币。',
            /* 正式链创世的设计（决策 #22），不是现在这条演练链：演练链创世里只有一个测试账户，系统合约与中立工具一个都没有（eth_getCode 实测为 0x） */
            '这条链上没有官方 DEX，也没有任何官方发行的代币：正式链的创世只会预置三个系统合约和几个中立工具' +
            '（Multicall3、CREATE2 部署器、WBAC 包装币），没有一个是拿来给人炒的；现在跑的演练链创世里这些都没有。第一个代币要等某个 agent 自己部署出来。' +
            '<br>正式发射后只有 agent 能在这一层发交易，到时这一页要么是空的，要么上面每一行都是某个 agent 自己造的。' +
            '演练链上没有这道门：测试私钥是公开的，谁都能在上面发币。' +
            '<br><br>agent 想发一个，自己用 <code>@bac/agent-sdk</code> 部署合约就行；' + esc(BUILT_SRC))) +
      '</div>' + detectBar();
  }

  function tokenRow(t) {
    return '<tr data-go="#/token/' + esc(t.address) + '">' +
      '<td class="l"><b class="sym">' + symOf(t) + '</b>' +
      '<span class="sub" translate="no">' + esc(t.name || sa(t.address)) + '</span>' + levelTag(t.detectLevel) +
      (t.sameNameCount ? '<span class="sub">链上还有 ' + t.sameNameCount + ' 个同名代币</span>' : '') + '</td>' +
      '<td class="l n">' + agentLink(t.agentId) + '</td>' +
      '<td class="r n">' + tAmt(t.totalSupply, t.decimals) + '</td>' +
      '<td class="r n">' + (t.holders === null ? '—' : comma(t.holders)) + '</td>' +
      '<td class="r n">' + (t.transfers === null ? '—' : comma(t.transfers)) + '</td>' +
      '<td class="r n">' + (t.swapCount === null ? '—' : comma(t.swapCount)) + '</td>' +
      '<td class="r n hide-m">' + (t.pairCount === null ? '—' : comma(t.pairCount)) + '</td>' +
      '<td class="r n">' + esc(UI.ago(t.lastTs)) + '</td></tr>';
  }

  /* ── /token/{address} 代币详情 ────────────────────────── */
  function renderTokenDetail(raw) {
    var el = $('#v-token'); if (!el) return;
    var a = String(raw || '');
    var d = VM.built.tokenDetail;
    var err = VM.built.tokenErr;
    if (!d || String(d.address).toLowerCase() !== a.toLowerCase()) {
      if (err && String(err.address).toLowerCase() === a.toLowerCase()) {
        /* 404 不写「页面不存在」：这个地址可能只是没被判成代币，把人接到合约页去 */
        el.innerHTML = '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/tokens">代币</a>›<span>' + esc(sa(a)) + '</span></div>' +
          '<div class="panel"><div class="ph"><span class="ph-t">' + esc(sa(a)) + '</span><span class="ph-fill"></span></div>' +
          builtEmpty('这个地址没有被识别为代币',
            '它可能不是代币，也可能是我们的规则没认出来 —— 两种都有可能，我们不装作知道是哪一种。' +
            '<br><br><a class="btn ghost" href="#/contract/' + esc(a) + '">去看这个地址的合约页</a>') +
          '</div>' + detectBar();
        return;
      }
      if (VM.st.built === 'ok' && canAskIdx()) { ask('token', a); el.innerHTML = R.pageMiss('代币 ' + sa(a), 'loading', '正在向索引器要这个代币。'); return; }
      el.innerHTML = '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/tokens">代币</a>›<span>' + esc(sa(a)) + '</span></div>' +
        '<div class="panel"><div class="ph"><span class="ph-t">' + esc(sa(a)) + '</span><span class="ph-fill"></span></div>' +
        builtEmpty('现在还查不到这个地址的代币信息',
          '这不是「没有这个代币」，是我们现在没有能回答这个问题的数据源。') + '</div>' + detectBar();
      return;
    }
    var t = d.token || {}, sc = d.supplyCheck || {};
    var drift = sc.drift !== null && sc.drift !== undefined && sc.drift !== 0n;
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/tokens">代币</a>›<span>' + symOf(t) + '</span></div>' +
      '<div class="dtl-h"><h1>' + symOf(t) + '</h1>' +
      (t.detectLevel === 'partial' ? '<span class="st-tag warn">没有 name/symbol</span>' : '<span class="st-tag ok">识别为代币</span>') +
      '<span class="sub" translate="no">' + esc(t.name || '') + '</span></div>' +
      '<code class="dtl-id sm">' + esc(t.address || a) + '</code>' +
      '<div class="srcline"><b>TOKEN</b><code>GET /api/token/' + esc(sa(t.address || a)) + '</code></div>' +
      '<p class="note"><b>' + esc(NAME_UNTRUSTED) + '</b>同名同符号的代币不合并、不去重、不打假标签，只按地址区分。' +
      (t.detectLevel === 'partial'
        ? '<br>这个合约没有实现 name/symbol/decimals，下面按最小单位显示原始数字。' : '') + '</p>' +
      '<div class="cx-head">' +
      '<div><i>持有人</i><b>' + (t.holders === null ? '—' : comma(t.holders)) + '</b><span>按 Transfer 事件推出来的</span></div>' +
      '<div><i>转账数</i><b>' + (t.transfers === null ? '—' : comma(t.transfers)) + '</b><span>含铸造与销毁</span></div>' +
      '<div><i>成交数</i><b>' + (t.swapCount === null ? '—' : comma(t.swapCount)) + '</b><span>我们能解码出来的 Swap</span></div>' +
      '<div><i>交易对</i><b>' + (t.pairCount === null ? '—' : comma(t.pairCount)) + '</b><span>含这个代币的池子</span></div>' +
      '</div>' +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">代币信息</span><span class="ph-fill"></span>' +
      '<span class="ph-m">GET /api/token/{address}</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('符号 / 名字', symOf(t) + ' · <span translate="no">' + esc(t.name || '—') + '</span><span class="hintline">' + esc(NAME_UNTRUSTED) + '</span>') +
      kv('地址', '<span class="n">' + esc(t.address || a) + '</span>', 'wrap') +
      kv('decimals', '<span class="n">' + (t.decimals === null ? '未知' : t.decimals) + '</span>') +
      kv('总量', '<span class="n">' + tAmt(t.totalSupply, t.decimals) + '</span>') +
      kv('发行者', agentLink(t.agentId) + '<span class="hintline n">' + esc(t.wallet || '') + '</span>') +
      kv('部署交易', t.deployTx ? '<a class="a-link" href="#/tx/' + esc(t.deployTx) + '"><code>' + esc(sh(t.deployTx)) + '</code></a>' : '—') +
      kv('部署时间', esc(UI.full(t.deployTs))) +
      '</tbody></table></div>' +
      '<div class="dstack"><div class="panel ' + (drift ? 'warnbox' : '') + '">' +
      '<div class="ph"><span class="ph-t">总量对账 supplyCheck</span><span class="ph-fill"></span>' +
      '<span class="ph-m">' + (drift ? '不一致' : '一致') + '</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('链上 totalSupply()', '<span class="n">' + tAmt(sc.onchain, t.decimals) + '</span>') +
      kv('按转账推出来的合计', '<span class="n">' + tAmt(sc.derived, t.decimals) + '</span>') +
      kv('差额', '<span class="n">' + tAmt(sc.drift, t.decimals) + '</span>') +
      '</tbody></table>' +
      '<div class="pf"><span>' + esc(sc.note ||
        'onchain 是 totalSupply() 的返回值；derived 是按 Transfer 事件推出来的余额之和。两者不一致说明这个代币的转账不守恒（收税或 rebase），以链上为准。') +
      '</span></div></div></div></div>' +
      '<div class="panel dfull"><div class="ph"><span class="ph-t big">前 10 持有人</span><span class="ph-fill"></span>' +
      '<span class="ph-m">按余额倒序</span></div>' +
      ((d.topHolders && d.topHolders.length)
        ? '<div class="tw"><table class="tbl"><thead><tr><th class="l">#</th><th class="l">地址</th>' +
          '<th class="l">身份</th><th class="r">余额</th><th class="r">占总量</th></tr></thead><tbody>' +
          d.topHolders.map(function (h) {
            return '<tr><td class="l n">' + (h.rank === null ? '—' : h.rank) + '</td>' +
              '<td class="l n"><code>' + esc(sa(h.address)) + '</code></td>' +
              '<td class="l">' + (h.role === 'pair'
                ? '<span class="st-tag vio">交易对合约（池子里的钱）</span>'
                : (h.agentId !== null ? agentLink(h.agentId)
                  : (h.role === 'factory' ? '<span class="sub">交易对工厂</span>'
                    : (h.role === 'token' ? '<span class="sub">另一个代币合约</span>' : '<span class="sub">—</span>')))) + '</td>' +
              '<td class="r n">' + tAmt(h.balance, t.decimals) + '</td>' +
              '<td class="r n">' + (h.shareBps === null ? '—' : (h.shareBps / 100).toFixed(2) + '%') + '</td></tr>';
          }).join('') + '</tbody></table></div>' +
          '<div class="pf"><span><b>「交易对合约」那一行是池子里的钱，不是某个人的仓位</b>' +
          '——不这么标的话「第一大户占 XX%」是误导。</span></div>'
        : builtEmpty('这个代币还没有任何转账。', '它被部署出来了，但还没有人用过。')) + '</div>' +
      '<div class="dgrid dfull">' +
      '<div class="panel"><div class="ph"><span class="ph-t">它的交易对</span><span class="ph-fill"></span>' +
      '<a class="more" href="#/pairs">全部交易对 →</a></div>' +
      ((d.pairs && d.pairs.length)
        ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">交易对</th><th class="l">类型</th>' +
          '<th class="r">对手方储备</th><th class="r">成交</th></tr></thead><tbody>' +
          d.pairs.map(function (x) {
            return '<tr data-go="#/pair/' + esc(x.address) + '"><td class="l n"><code>' + esc(sa(x.address)) + '</code></td>' +
              '<td class="l"><span class="tag call">' + esc(x.kind || '—') + '</span></td>' +
              '<td class="r n">' + tAmt(x.reserve1, x.other ? x.other.decimals : null) + ' ' + symOf(x.other) + '</td>' +
              '<td class="r n">' + (x.swapCount === null ? '—' : comma(x.swapCount)) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty-box">还没有人给这个代币建过池子。</div>') + '</div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">最近转账</span><span class="ph-fill"></span>' +
      '<span class="ph-m">最多 20 条</span></div>' +
      ((d.recentTransfers && d.recentTransfers.length)
        ? '<div class="tw"><table class="tbl"><thead><tr><th>时间</th><th class="l">从</th><th class="l">到</th>' +
          '<th class="r">数量</th><th class="l">类型</th></tr></thead><tbody>' +
          d.recentTransfers.map(function (x) {
            return '<tr><td class="n">' + esc(UI.hms(x.ts)) + '<span class="sub">' + esc(UI.ago(x.ts)) + '</span></td>' +
              '<td class="l n"><code>' + esc(sa(x.from)) + '</code></td>' +
              '<td class="l n"><code>' + esc(sa(x.to)) + '</code></td>' +
              '<td class="r n">' + tAmt(x.value, t.decimals) + '</td>' +
              '<td class="l"><span class="tag ' + (x.kind === 'mint' ? 'dep' : (x.kind === 'burn' ? 'bri' : 'xfer')) + '">' +
              esc({ mint: '铸造', burn: '销毁', transfer: '转账' }[x.kind] || x.kind || '—') + '</span></td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty-box">还没有转账。</div>') + '</div></div>' +
      detectBar();
  }

  /* ── /pairs 交易对列表 ────────────────────────────────── */
  function renderPairs() {
    var el = $('#v-pairs'); if (!el) return;
    askBuilt('pairs', VM.built.pairsAt);
    var list = VM.built.pairs || [];
    var ok = VM.st.built === 'ok' && list.length;
    el.innerHTML =
      '<div class="vhead"><h1>交易对</h1><span class="vh-en">PAIRS</span>' +
      '<span class="fill" aria-hidden="true"></span>' +
      '<span class="vh-m">agent 自己部署的池子；<b>储备是池子里现在的两种代币，不是任何法币金额</b>。' +
      '本链没有法币计价，也没有预言机。</span></div>' +
      '<div class="srcline"><b>PAIRS</b><code>GET /api/pairs</code><code>' + esc(UI.idxLabel()) + '</code></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t big">交易对列表</span><span class="ph-fill"></span>' +
      '<a class="more" href="#/tokens">代币 →</a><a class="more" href="#/swaps">成交流水 →</a>' +
      '<span class="ph-m">' + esc(builtCount(VM.built.pairsAt, VM.built.pairsErr,
        VM.built.pairsTotal === null ? list.length : VM.built.pairsTotal, ' 个')) + '</span></div>' +
      (ok
        ? '<div class="tw"><table class="tbl rowlink"><thead><tr>' +
          '<th class="l">交易对</th><th class="l">类型</th><th class="l">建池人</th>' +
          '<th class="r">储备</th><th class="r">成交</th><th class="r">最后成交</th><th class="l hide-m">来源</th>' +
          '</tr></thead><tbody>' + list.map(pairRow).join('') + '</tbody></table></div>'
        : builtEmpty('还没有 agent 建过交易对。',
            '这条链上没有官方 DEX。要出现第一个交易对，得有某个 agent 自己把 AMM 合约部署上来，再往里放两种代币。' +
            '<br><br>' + esc(BUILT_SRC))) +
      '</div>' + detectBar();
  }

  function pairRow(p) {
    var v3 = p.kind === 'v3';
    return '<tr data-go="#/pair/' + esc(p.address) + '">' +
      '<td class="l"><b class="sym">' + symOf(p.token0) + '/' + symOf(p.token1) + '</b>' +
      '<span class="sub">' + esc(sa(p.address)) + '</span>' +
      ((p.token0 && p.token0.known === false) || (p.token1 && p.token1.known === false)
        ? '<span class="st-tag warn">有一边没被判成代币</span>' : '') + '</td>' +
      '<td class="l"><span class="tag call">' + esc(p.kind || '—') + '</span></td>' +
      '<td class="l n">' + agentLink(p.agentId) + '</td>' +
      '<td class="r n">' + tAmt(p.reserve0, p.token0 ? p.token0.decimals : null) + ' ' + symOf(p.token0) +
      '<span class="sub">' + tAmt(p.reserve1, p.token1 ? p.token1.decimals : null) + ' ' + symOf(p.token1) + '</span>' +
      '<span class="sub">' + (v3 ? '池内余额（V3 不显示 tick 深度）' : '储备') + '</span></td>' +
      '<td class="r n">' + (p.swapCount === null ? '—' : comma(p.swapCount)) + '</td>' +
      '<td class="r n">' + esc(UI.ago(p.lastTs)) + '</td>' +
      '<td class="l hide-m">' + (p.discoveredVia === 'factory'
        ? '<span class="sub">工厂事件</span>'
        : '<span class="sub" title="这个池子没有对应的工厂事件，是靠它自己发的 Swap/Sync 事件认出来的。">只看到事件</span>') +
      '</td></tr>';
  }

  /* ── /pair/{address} 交易对详情 ───────────────────────── */
  function renderPairDetail(raw) {
    var el = $('#v-pair'); if (!el) return;
    var a = String(raw || '');
    var d = VM.built.pairDetail, err = VM.built.pairErr;
    if (!d || String(d.address).toLowerCase() !== a.toLowerCase()) {
      if (err && String(err.address).toLowerCase() === a.toLowerCase()) {
        el.innerHTML = '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/pairs">交易对</a>›<span>' + esc(sa(a)) + '</span></div>' +
          '<div class="panel"><div class="ph"><span class="ph-t">' + esc(sa(a)) + '</span><span class="ph-fill"></span></div>' +
          builtEmpty('这个地址没有被识别为交易对',
            '它可能不是池子，也可能是我们的规则没认出来。' +
            '<br><br><a class="btn ghost" href="#/contract/' + esc(a) + '">去看这个地址的合约页</a>') +
          '</div>' + detectBar();
        return;
      }
      if (VM.st.built === 'ok' && canAskIdx()) { ask('pair', a); el.innerHTML = R.pageMiss('交易对 ' + sa(a), 'loading', '正在向索引器要这个池子。'); return; }
      el.innerHTML = '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/pairs">交易对</a>›<span>' + esc(sa(a)) + '</span></div>' +
        '<div class="panel"><div class="ph"><span class="ph-t">' + esc(sa(a)) + '</span><span class="ph-fill"></span></div>' +
        builtEmpty('现在还查不到这个地址的交易对信息',
          '这不是「没有这个池子」，是我们现在没有能回答这个问题的数据源。') + '</div>' + detectBar();
      return;
    }
    var p = d.pair || {}, pz = d.price || {};
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/pairs">交易对</a>›<span>' +
      symOf(p.token0) + '/' + symOf(p.token1) + '</span></div>' +
      '<div class="dtl-h"><h1>' + tokenLink(p.token0) + ' / ' + tokenLink(p.token1) + '</h1>' +
      '<span class="tag call">' + esc(p.kind || '—') + '</span>' +
      (p.feePpm !== null && p.feePpm !== undefined ? '<span class="sub">费率 ' + p.feePpm + ' ppm</span>' : '') + '</div>' +
      '<code class="dtl-id sm">' + esc(p.address || a) + '</code>' +
      '<div class="srcline"><b>PAIR</b><code>GET /api/pair/' + esc(sa(p.address || a)) + '</code></div>' +
      '<div class="cx-head">' +
      '<div><i>兑换比</i><b>' + ratioZh(pz.price1Per0, p.token0, p.token1) + '</b><span>' + esc(PRICE_NOTE) + '</span></div>' +
      '<div><i>' + (p.kind === 'v3' ? '池内余额' : '储备') + ' ' + symOf(p.token0) + '</i><b>' +
      tAmt(p.reserve0, p.token0 ? p.token0.decimals : null) + '</b><span>来源 ' + esc(p.reserveSource || '—') + '</span></div>' +
      '<div><i>' + (p.kind === 'v3' ? '池内余额' : '储备') + ' ' + symOf(p.token1) + '</i><b>' +
      tAmt(p.reserve1, p.token1 ? p.token1.decimals : null) + '</b><span>区块 #' + (p.reserveBlock === null ? '—' : comma(p.reserveBlock)) + '</span></div>' +
      '<div><i>成交数</i><b>' + (p.swapCount === null ? '—' : comma(p.swapCount)) + '</b><span>我们能解码出来的那些</span></div>' +
      '</div>' +
      '<p class="note"><b>' + esc(PRICE_NOTE) + '</b>' +
      '这一页不画 K 线：没有法币计价、没有外部行情源，画出来的线是编的。要看逐笔成交价，看下面那张成交表。' +
      (d.v3Note ? '<br>' + esc(d.v3Note) : '') + '</p>' +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">池子信息</span><span class="ph-fill"></span>' +
      '<span class="ph-m">GET /api/pair/{address}</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('token0', tokenLink(p.token0) + '<span class="hintline n">' + esc((p.token0 && p.token0.address) || '') + '</span>') +
      kv('token1', tokenLink(p.token1) + '<span class="hintline n">' + esc((p.token1 && p.token1.address) || '') + '</span>') +
      kv('类型', esc(p.kind || '—')) +
      kv('工厂', p.factory ? '<code class="n">' + esc(sa(p.factory)) + '</code>' :
        '<span class="sub">没有工厂事件 —— 这个池子是靠它自己发的 Swap/Sync 事件认出来的</span>') +
      kv('建池人', agentLink(p.agentId) + '<span class="hintline n">' + esc(p.wallet || '') + '</span>') +
      kv('创建交易', p.deployTx ? '<a class="a-link" href="#/tx/' + esc(p.deployTx) + '"><code>' + esc(sh(p.deployTx)) + '</code></a>' : '—') +
      kv('创建时间', esc(UI.full(p.deployTs))) +
      '</tbody></table></div>' +
      '<div class="dstack"><div class="panel"><div class="ph"><span class="ph-t">加 / 撤流动性</span>' +
      '<span class="ph-fill"></span><span class="ph-m">时间线</span></div>' +
      ((d.liquidity && d.liquidity.length)
        ? '<div class="tw"><table class="tbl"><thead><tr><th>时间</th><th class="l">动作</th><th class="l">谁</th>' +
          '<th class="r">' + symOf(p.token0) + '</th><th class="r">' + symOf(p.token1) + '</th></tr></thead><tbody>' +
          d.liquidity.map(function (x) {
            return '<tr><td class="n">' + esc(UI.hms(x.ts)) + '<span class="sub">' + esc(UI.ago(x.ts)) + '</span></td>' +
              '<td class="l"><span class="tag ' + (x.kind === 'add' ? 'dep' : 'bri') + '">' + esc(x.kind === 'add' ? '加流动性' : '撤流动性') + '</span></td>' +
              '<td class="l n">' + agentLink(x.agentId) + '</td>' +
              '<td class="r n">' + tAmt(x.amount0, p.token0 ? p.token0.decimals : null) + '</td>' +
              '<td class="r n">' + tAmt(x.amount1, p.token1 ? p.token1.decimals : null) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty-box">还没有人往这个池子里加过流动性。</div>') + '</div></div></div>' +
      '<div class="panel dfull"><div class="ph"><span class="ph-t big">最近成交</span><span class="ph-fill"></span>' +
      '<a class="more" href="#/swaps">全部成交 →</a></div>' +
      ((d.recentSwaps && d.recentSwaps.length)
        ? swapTable(d.recentSwaps, p.token0)
        : builtEmpty('这个交易对还没有成交。', '池子建好了，但还没有 agent 在这里买过东西。')) + '</div>' +
      detectBar();
  }

  /* ── /swaps 成交流水 ──────────────────────────────────── */
  function swapTable(list, base) {
    return '<div class="tw"><table class="tbl"><thead><tr>' +
      '<th>时间</th><th class="l">agent</th><th class="l">交易对</th>' +
      '<th class="l">方向（以 ' + symOf(base) + ' 为基准）</th>' +
      '<th class="r">卖出</th><th class="r">买入</th><th class="r">成交价</th><th class="l">交易</th>' +
      '</tr></thead><tbody>' + list.map(swapRow).join('') + '</tbody></table></div>';
  }

  function swapRow(x) {
    var p = x.pair || {}, t0 = p.token0, t1 = p.token1;
    /* normalized === false：整行变灰，方向与数量写「形状不标准」，只给交易哈希，**不隐藏** */
    if (x.normalized === false) {
      return '<tr class="dim"><td class="n">' + esc(UI.hms(x.ts)) + '</td>' +
        '<td class="l n">' + agentLink(x.agentId) + '</td>' +
        '<td class="l n"><code>' + esc(sa(p.address)) + '</code></td>' +
        '<td class="l"><span class="sub">形状不标准</span></td>' +
        '<td class="r"><span class="sub">形状不标准</span></td>' +
        '<td class="r"><span class="sub">形状不标准</span></td>' +
        '<td class="r"><span class="sub">—</span></td>' +
        '<td class="l n"><a class="a-link" href="#/tx/' + esc(x.tx) + '"><code>' + esc(sh(x.tx)) + '</code></a></td></tr>';
    }
    var sell0 = x.side === 'sell0';
    var inTok = sell0 ? t0 : t1, outTok = sell0 ? t1 : t0;
    return '<tr><td class="n">' + esc(UI.hms(x.ts)) + '<span class="sub">' + esc(UI.ago(x.ts)) + '</span></td>' +
      '<td class="l n">' + agentLink(x.agentId) + '</td>' +
      '<td class="l n"><a class="a-link" href="#/pair/' + esc(p.address) + '">' + symOf(t0) + '/' + symOf(t1) + '</a></td>' +
      '<td class="l">' + (sell0
        ? '<span class="st-tag bad">卖出 ' + symOf(t0) + '</span>'
        : '<span class="st-tag ok">买入 ' + symOf(t0) + '</span>') + '</td>' +
      '<td class="r n">' + tAmt(x.amountIn, inTok ? inTok.decimals : null) + ' ' + symOf(inTok) + '</td>' +
      '<td class="r n">' + tAmt(x.amountOut, outTok ? outTok.decimals : null) + ' ' + symOf(outTok) + '</td>' +
      '<td class="r n">' + ratioZh(x.price1Per0, t0, t1) + '</td>' +
      '<td class="l n"><a class="a-link" href="#/tx/' + esc(x.tx) + '"><code>' + esc(sh(x.tx)) + '</code></a></td></tr>';
  }

  function renderSwaps() {
    var el = $('#v-swaps'); if (!el) return;
    askBuilt('swaps', VM.built.swapsAt);
    var list = VM.built.swaps || [];
    var ok = VM.st.built === 'ok' && list.length;
    el.innerHTML =
      '<div class="vhead"><h1>成交流水</h1><span class="vh-en">SWAPS</span>' +
      '<span class="fill" aria-hidden="true"></span>' +
      '<span class="vh-m">只统计我们能解码出来的 Swap 事件；成交价一律写成「1 token0 折合多少 token1」，' +
      '<b>本链没有法币计价，也没有预言机</b>。</span></div>' +
      '<div class="srcline"><b>SWAPS</b><code>GET /api/swaps</code><code>' + esc(UI.idxLabel()) + '</code></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t big">成交</span><span class="ph-fill"></span>' +
      '<a class="more" href="#/tokens">代币 →</a><a class="more" href="#/pairs">交易对 →</a>' +
      '<span class="ph-m">' + esc(builtCount(VM.built.swapsAt, VM.built.swapsErr, list.length, ' 笔')) + '</span></div>' +
      (ok
        ? swapTable(list, list[0].pair ? list[0].pair.token0 : null)
        : builtEmpty('还没有成交。',
            '成交要等两件事同时发生：有 agent 发了币，有 agent 建了池子并放了流动性进去。' +
            '<br>这一页只统计我们能解码出来的 Swap 事件；agent 用别的方式换东西，我们看不见。')) +
      '</div>' +
      '<p class="note"><b>成交不进「实时动态」。</b>动态是「发生了什么大事」的时间线，' +
      '一旦有人开始刷量它会被成交淹没 —— 这是刻意的取舍，成交只在这一页。</p>' +
      detectBar();
  }

  /* ── agent 详情页的四块增量（03 §7.8.6）────────────────── */
  function agentBuiltPanels(a) {
    var bt = a.built || null, tr = a.trades || null, hd = a.holdings;
    function cards(list, kind) {
      return '<div class="tw"><table class="tbl rowlink"><thead><tr>' +
        (kind === 'token'
          ? '<th class="l">代币</th><th class="r">总量</th><th class="r">持有人</th><th class="r">成交</th>'
          : '<th class="l">交易对</th><th class="l">类型</th><th class="r">成交</th><th class="r">建于</th>') +
        '</tr></thead><tbody>' +
        list.map(function (x) {
          return kind === 'token'
            ? '<tr data-go="#/token/' + esc(x.address) + '"><td class="l"><b class="sym">' + symOf(x) + '</b>' +
              '<span class="sub">' + esc(sa(x.address)) + '</span></td>' +
              '<td class="r n">' + tAmt(x.totalSupply, x.decimals) + '</td>' +
              '<td class="r n">' + (x.holders === null ? '—' : comma(x.holders)) + '</td>' +
              '<td class="r n">' + (x.swapCount === null ? '—' : comma(x.swapCount)) + '</td></tr>'
            : '<tr data-go="#/pair/' + esc(x.address) + '"><td class="l"><b class="sym">' +
              symOf(x.token0) + '/' + symOf(x.token1) + '</b><span class="sub">' + esc(sa(x.address)) + '</span></td>' +
              '<td class="l"><span class="tag call">' + esc(x.kind || '—') + '</span></td>' +
              '<td class="r n">' + (x.swapCount === null ? '—' : comma(x.swapCount)) + '</td>' +
              '<td class="r n">' + esc(UI.ago(x.deployTs)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    return '<div class="dgrid dfull">' +
      '<div class="panel"><div class="ph"><span class="ph-t">它发的币</span><span class="ph-fill"></span>' +
      '<a class="more" href="#/tokens">全部代币 →</a></div>' +
      ((bt && bt.tokens.length) ? cards(bt.tokens, 'token')
        : '<div class="empty-box">这个 agent 还没发过代币。' + (noIdxLine() ? '<br>' + esc(noIdxLine()) : '') + '</div>') + '</div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">它建的池</span><span class="ph-fill"></span>' +
      '<a class="more" href="#/pairs">全部交易对 →</a></div>' +
      ((bt && bt.pairs.length) ? cards(bt.pairs, 'pair')
        : '<div class="empty-box">这个 agent 还没建过交易对。' + (noIdxLine() ? '<br>' + esc(noIdxLine()) : '') + '</div>') + '</div>' +
      '</div>' +
      '<div class="dgrid dfull">' +
      '<div class="panel"><div class="ph"><span class="ph-t">它的成交</span><span class="ph-fill"></span>' +
      '<span class="ph-m">' + (tr && tr.swapCount !== null ? comma(tr.swapCount) + ' 笔' : '—') + '</span></div>' +
      ((tr && tr.recent && tr.recent.length)
        ? swapTable(tr.recent, tr.recent[0].pair ? tr.recent[0].pair.token0 : null) +
          '<div class="pf"><span>按交易对分布：' +
          (tr.pairs || []).map(function (x) { return esc(sa(x.address)) + ' ' + x.swaps + ' 笔'; }).join('　') + '</span></div>'
        : '<div class="empty-box">这个 agent 还没有做过成交。' + (noIdxLine() ? '<br>' + esc(noIdxLine()) : '') + '</div>') + '</div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">它持有的代币</span><span class="ph-fill"></span>' +
      '<span class="ph-m">' + (a.holdingsTruncated ? '只列前 20 个' : '余额按转账推出来') + '</span></div>' +
      ((hd && hd.length)
        ? '<div class="tw"><table class="tbl"><thead><tr><th class="l">代币</th><th class="r">余额</th>' +
          '<th class="r">占总量</th></tr></thead><tbody>' +
          hd.map(function (x) {
            return '<tr><td class="l"><a class="a-link" href="#/token/' + esc(x.token) + '">' + symOf(x) + '</a>' +
              (x.balanceDrift ? '<span class="sub">这个代币的转账不守恒，余额是推出来的，以链上为准</span>' : '') + '</td>' +
              '<td class="r n">' + tAmt(x.balance, x.decimals) + '</td>' +
              '<td class="r n">' + (x.shareBps === null ? '—' : (x.shareBps / 100).toFixed(2) + '%') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty-box">这个 agent 名下还没有任何代币余额。' + (noIdxLine() ? '<br>' + esc(noIdxLine()) : '') + '</div>') + '</div>' +
      '</div>' + detectBar();
  }

  /* ── 合约详情页顶上那一行结论（03 §7.8.7）──────────────── */
  var CLASSIFIED_UNKNOWN = '我们没能识别出这个合约是什么。它照样是 agent 造出来的东西，只是不在我们的解码规则里。';
  function contractVerdict(c) {
    var zh = c.classifiedZh || null;
    var demoted = (c.events || []).filter(function (e) { return e.kind === 'DEMOTED'; })[0];
    return '<div class="panel dfull"><div class="ph"><span class="ph-t big">这是个什么</span>' +
      '<span class="ph-fill"></span><span class="ph-m">启发式判定 · 会漏也会错</span></div>' +
      '<div class="verdict"><b>' + esc(zh || CLASSIFIED_UNKNOWN) + '</b>' +
      (c.classified === 'token' ? '<a class="btn ghost" href="#/token/' + esc(c.address) + '">查看代币页</a>' : '') +
      (c.classified === 'pair' ? '<a class="btn ghost" href="#/pair/' + esc(c.address) + '">查看交易对页</a>' : '') +
      '</div>' +
      (demoted ? '<div class="pf"><span>曾被识别为代币，后因规则 ' + esc(demoted.rule || 'X2') +
        ' 移出（' + esc(UI.full(demoted.ts)) + '）。</span></div>' : '') +
      '<div class="pf"><span>判定只看行为（日志形状 + <code>eth_call</code> 应答），不看源码、不看 ABI、不看谁部署的：' +
      '解码规则写在 <code>docs/03-INTERFACES.md §7</code>。<b>本站不做任何安全评级。</b></span></div></div>';
  }

  /* ══════════════════ 搜索 ══════════════════ */

  var SCOPE = 'all';
  function setScope(k) { SCOPE = k; }
  function getScope() { return SCOPE; }
  function wantScope(k) { return SCOPE === 'all' || SCOPE === k; }

  /* 按名字搜得到的固定条目（决策 #22 / #35）：层内原生币、BSC 侧的 BAC、创世预置的中立工具与系统合约。
     地址都是创世 / Portal 锁定下来的常量，不是链上读回来的。
     **现在跑的是演练链，它的创世里这些合约一个都没有**（eth_getCode 实测 0x）：
     rehearsal 为真时说明文字必须照实说「还没有」，链接指向解释这件事的那一页，
     不能指向一个打开就是「找不到」的详情页，更不能让人以为现在链上有个 WBAC 可以买。 */
  var NAMED = [
    { a: ['bac', 'bnb agent chain', '原生币', 'gas'], t: 'token', ad: null,
      v: 'BAC · 层内原生币', m: 'agent 在这一层付 gas 用的币：把 BSC 上的 BAC 锁进桥换来的',
      pre: 'agent 在这一层付 gas 用的币：把 BSC 上的 BAC 锁进桥换来的', page: '#/overview' },
    { a: ['bac', 'bnb agent chain'], t: 'token', ad: null,
      v: 'BAC · BSC 侧代币', m: 'CA 0xA97452d175679B2bF5F25a9a382D22aff39b7777（BSC 主网）',
      pre: 'CA 0xA974…7777 已锁定；发射前这个地址上没有合约，不要往里转账', page: '#/treasury' },
    { a: ['wbac', 'wrapped bac', '包装币', '包装'], t: 'token',
      ad: '0x0000000000000000000000000000000000000106',
      v: 'WBAC · Wrapped BAC', m: '层内包装币：创世预置的中立工具，1:1 包装原生 BAC',
      pre: '正式链创世预置的包装币（0x…0106）；现在跑的演练链上还没有', page: '#/tokens' },
    { a: ['multicall3', 'multicall'], t: 'contract', ad: '0xcA11bde05977b3631167028862bE2a173976CA11',
      v: 'Multicall3', m: '创世预置的中立工具：一次调用批量读多个合约',
      pre: '正式链创世预置的中立工具；现在跑的演练链上还没有', page: '#/tokens' },
    { a: ['create2', 'create2 部署器', '部署器'], t: 'contract', ad: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
      v: 'CREATE2 部署器', m: '创世预置的中立工具：确定性地址部署',
      pre: '正式链创世预置的中立工具；现在跑的演练链上还没有', page: '#/tokens' },
    { a: ['l2bridge', '层内桥'], t: 'contract', ad: '0x0000000000000000000000000000000000000101',
      v: 'L2Bridge · 层内桥', m: '系统合约：层内一侧的进出场记账',
      pre: '正式链创世的系统合约；现在跑的演练链上还没有', page: '#/treasury' },
    { a: ['l2gate', '入场门禁', '门禁'], t: 'contract', ad: '0x0000000000000000000000000000000000000102',
      v: 'L2Gate · 入场门禁', m: '系统合约：层内只有 agent 能发交易这条规则由它执行',
      pre: '正式链创世的系统合约；现在跑的演练链上还没有（演练链上谁都能发交易）', page: '#/agents' },
    { a: ['agentbook', 'agent 名录', '名录'], t: 'contract', ad: '0x0000000000000000000000000000000000000103',
      v: 'AgentBook · Agent 名录', m: '系统合约：层内的 agent 名册',
      pre: '正式链创世的系统合约；现在跑的演练链上还没有', page: '#/agents' },
    { a: ['feesplitter', 'gas 分账', '分账'], t: 'contract', ad: '0x0000000000000000000000000000000000000104',
      v: 'FeeSplitter · gas 分账', m: '系统合约：出块者的 gas 费按决策 #17 分账',
      pre: '正式链创世的系统合约；现在跑的演练链上还没有', page: '#/validators' }
  ];

  function searchAll(qraw) {
    var q = (qraw || '').trim().toLowerCase(), out = [];
    if (!q) return out;
    var bare = q.replace(/^#/, '').replace(/^agent\s*#?/, '');

    if (/^\d+$/.test(bare)) {
      var n = parseInt(bare, 10);
      if (wantScope('block')) {
        var b = VM.blockByNum[n];
        if (b) out.push({ k: '区块', v: '#' + comma(n), m: b.txCount + ' 笔交易 · ' + UI.ago(b.ts), blk: n, ts: b.ts, h: '#/block/' + n });
        else if (VM.chain.head === null || n <= VM.chain.head) {
          out.push({ k: '区块', v: '#' + comma(n),
            m: onRpc() ? '直接读层内节点打开这一块' : '打开区块详情页', blk: n, ts: null, h: '#/block/' + n });
        }
      }
      if (wantScope('agent') && VM.agentById[n]) {
        out.push({ k: 'AGENT', v: 'agent #' + n, m: VM.agentById[n].deploys === null || VM.agentById[n].deploys === undefined
            ? VM.agentById[n].statusZh + ' · ERC-8004 身份'
            : VM.agentById[n].statusZh + ' · 部署 ' + VM.agentById[n].deploys + ' 个合约',
          blk: null, ts: VM.agentById[n].joinedTs, h: '#/agent/' + n });
      }
      if (wantScope('block') && VM.epochByN[n]) {
        out.push({ k: '纪元', v: '纪元 ' + n, m: VM.epochByN[n].stateZh, blk: null, ts: null, h: '#/epoch/' + n });
      }
    }

    if (q.indexOf('0x') === 0 && q.length >= 3) {
      var CAP = SCOPE === 'all' ? 5 : 12, nTx = 0, nAd = 0, nCo = 0;
      if (wantScope('tx')) {
        Object.keys(VM.txByHash).forEach(function (hh) {
          if (hh.indexOf(q) === 0 && nTx < CAP) {
            nTx++;
            var t = VM.txByHash[hh];
            out.push({ k: '交易', v: sh(hh), m: (t.method || '') + ' · 区块 #' + comma(t.block), blk: t.block, ts: t.ts, h: '#/tx/' + hh });
          }
        });
      }
      /* 完整的 32 字节哈希：本页缓存里没有也能开 —— 详情页直接问层内节点要这一笔。
         注意只有「最近」不是限制来源，它是全链的：eth_getTransactionByHash 读的是全量。 */
      if (wantScope('tx') && /^0x[0-9a-f]{64}$/.test(q) && !VM.txByHash[q] && !VM.blockByNum[q]) {
        out.push({ k: '交易', v: sh(q), m: '本页缓存里没有，打开后直接向层内节点查这一笔',
          blk: null, ts: null, h: '#/tx/' + q });
      }
      if (wantScope('addr')) {
        VM.agents.forEach(function (a) {
          if (a.wallet && a.wallet.toLowerCase().indexOf(q) === 0 && nAd < CAP) {
            nAd++;
            out.push({ k: '地址', v: sa(a.wallet), m: 'agent #' + a.id + ' 的层内钱包', blk: null, ts: a.joinedTs, h: '#/agent/' + a.id });
          }
        });
        Object.keys(VM.layerAddresses).forEach(function (key) {
          var ad = String(VM.layerAddresses[key] || '').toLowerCase();
          if (ad && ad.indexOf(q) === 0) {
            out.push({ k: '地址', v: sa(ad), m: '层内系统地址 ' + key, blk: null, ts: null, h: '#/validators' });
          }
        });
      }
      if (wantScope('contract')) {
        VM.contractAddrs.forEach(function (c) {
          if (c.toLowerCase().indexOf(q) === 0 && nCo < CAP) {
            nCo++;
            var cc = VM.contractMap[c];
            out.push({ k: '合约', v: sa(c), m: 'agent #' + cc.agentId + ' 部署 · 被调用 ' + comma(cc.calls) + ' 次',
              blk: cc.block, ts: null, h: '#/contract/' + c });
          }
        });
      }
    }
    /* ── 文字搜索（决策 #19 / #22）：代币的名字和符号，以及上面那张表里的固定条目 ──
       代币的名字和符号是发它的 agent 自己写的，本站不核实、也不翻译：
       raw 标记让搜索框和结果页把它包进 translate="no"。同名代币很多，说明里一律带上地址。 */
    var isText = !/^0x/.test(q) && !/^\d+$/.test(bare);
    if (isText) {
      NAMED.forEach(function (e) {
        if (!wantScope(e.t)) return;
        var hit = false;
        for (var i = 0; i < e.a.length; i++) { if (e.a[i].indexOf(q) >= 0) { hit = true; break; } }
        if (!hit) return;
        out.push({
          k: e.t === 'token' ? '代币' : '合约', v: e.v,
          m: VM.rehearsal ? e.pre : e.m, blk: null, ts: null,
          h: (!e.ad || VM.rehearsal) ? e.page : (e.t === 'token' ? '#/token/' : '#/contract/') + e.ad
        });
      });
    }
    if (wantScope('token')) {
      var seenTok = {};
      var pushToken = function (t) {
        var ad = String((t && t.address) || '').toLowerCase();
        if (!ad || seenTok[ad]) return;
        seenTok[ad] = 1;
        out.push({
          k: '代币', raw: true,
          /* 没有符号就用短地址当标题：这一格是 translate="no"，放中文进去英文版会原样露出来 */
          v: (t.symbol || sa(ad)) + (t.name ? ' · ' + t.name : ''),
          m: (t.agentId === null || t.agentId === undefined ? '部署者未知' : 'agent #' + t.agentId + ' 部署') +
            ' · 持有人 ' + comma(t.holders || 0) + ' · ' + sa(ad),
          blk: t.deployBlock || null, ts: t.deployTs || null, h: '#/token/' + ad
        });
      };
      /* 索引器按名字/符号在全链里找到的（bind.js 异步填进 VM.search），先放；
         再补上本页已经载入的那一批 —— 索引器不在时就只剩后者。 */
      if (VM.search && VM.search.q && VM.search.q.toLowerCase() === q) VM.search.items.forEach(pushToken);
      (VM.built.tokens || []).forEach(function (t) {
        if (!t) return;
        var ok = isText
          ? (String(t.symbol || '').toLowerCase().indexOf(q) >= 0 || String(t.name || '').toLowerCase().indexOf(q) >= 0)
          : String(t.address || '').toLowerCase().indexOf(q) === 0;
        if (ok) pushToken(t);
      });
    }
    return out.slice(0, 14);
  }

  var SCOPE_ZH = { all: '全部', block: '区块', tx: '交易', addr: '地址', contract: '合约', agent: 'Agent', token: '代币' };

  function renderSearchPage(q) {
    var el = $('#v-search'); if (!el) return;
    var res = searchAll(q);
    el.innerHTML = '<div class="crumbs"><a href="#/overview">概览</a>›<span>搜索</span></div>' +
      '<div class="dtl-h"><h1>搜索</h1><span class="sub">“' + esc(q) + '”</span></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t big">结果（' + res.length + '）</span>' +
      '<span class="ph-fill"></span><span class="ph-m">范围：' + esc(SCOPE_ZH[SCOPE]) + '</span></div>' +
      (res.length ? '<div class="tw"><table class="tbl rowlink"><thead><tr><th class="l">类型</th><th class="l">结果</th>' +
        '<th class="l">说明</th><th class="r">区块</th><th class="r">时间</th><th class="r">打开</th></tr></thead><tbody>' +
        res.map(function (r) {
          return '<tr data-go="' + esc(r.h) + '"><td class="l"><span class="tag">' + esc(r.k) + '</span></td>' +
            /* 代币的名字和符号是部署者自己写的：原样显示，不翻译 */
            '<td class="l n hx"' + (r.raw ? ' translate="no"' : '') + '>' + esc(r.v) + '</td>' +
            '<td class="l">' + esc(r.m) + '</td>' +
            '<td class="r n">' + (r.blk ? '#' + comma(r.blk) : '—') + '</td>' +
            '<td class="r n">' + (r.ts ? esc(UI.hms(r.ts)) + '<span class="sub">' + esc(UI.ago(r.ts)) + '</span>' : '—') + '</td>' +
            '<td class="r"><span class="more">查看 →</span></td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="empty-box"><b>没有匹配</b>' +
          (VM.st.blocks === 'pre'
            ? '还没有发射，链上还没有任何区块、交易或 agent 可以搜。'
            : '搜索框接受：区块高度、交易哈希（0x + 64 位）、层内地址或合约地址（0x + 40 位）、agent 编号（例 #17）、纪元号、代币名或符号。' +
              (onRpc() ? '　现在是直读层内节点：区块高度与完整交易哈希可以直接查，' +
                '按地址找历史、按前缀模糊匹配要等索引器。' : '')) +
          '</div>') + searchNote(q) + '</div>';
  }

  /* 按名字找代币只有索引器答得出来（/api/tokens?q=）：它在读、没答话或答错了，都照实说一句，
     免得「没有匹配」被读成「这条链上没有这个代币」。 */
  function searchNote(qraw) {
    var q = String(qraw || '').trim();
    if (!q || /^0x/i.test(q) || /^#?\d+$/.test(q)) return '';
    var s = VM.search && VM.search.status;
    if (s === 'loading') return '<p class="pf"><span>正在问索引器按名字找代币…</span></p>';
    if (s === 'noidx') return '<p class="pf"><span>索引器现在没有答话：按名字找代币要等它恢复，这一轮只匹配了本页已经载入的那一批。</span></p>';
    if (s === 'error') return '<p class="pf"><span>索引器这次没答上来：按名字找代币失败了，这一轮只匹配了本页已经载入的那一批。</span></p>';
    return '';
  }

  /* ══════════════════ 图表总刷新 ══════════════════ */

  function liveSeries() {
    var out = [];
    for (var i = Math.min(59, VM.blocks.length - 1); i >= 0; i--) out.push(VM.blocks[i].txCount);
    return out;
  }

  function drawAll() {
    var none = VM.st.blocks === 'error' ? UI.TEXT.ERR
      : (VM.st.blocks === 'loading' ? UI.TEXT.LOADING : '暂时没有数据');
    C.draw($('#chLive'), {
      type: 'bar', data: VM.st.blocks === 'ok' ? liveSeries() : [], unit: ' 笔',
      label: '每块交易数（本站读到的这一窗口）', padL: 28, none: none
    });
    var d = VM.daily;
    /* 日聚合要把全链按天卷起来，只有索引器做得到 —— 没有就照实说，不画假曲线。
       照索引器的状态分开说：在供数但还没有日聚合端点 / 第一轮还没回来 / 读不到。 */
    var noneDaily = VM.st.daily === 'pre' ? UI.TEXT.PRE
      : (VM.st.daily === 'ok' ? '索引器暂无日聚合数据'
        : (VM.st.daily === 'loading' ? UI.TEXT.LOADING : '索引器读不到 · 没有日聚合数据'));
    C.draw($('#chTx'), { type: 'bar', data: d ? d.tx : [], labels: d ? d.labels : null, unit: ' 笔', label: '近 30 日交易数', none: noneDaily });
    C.draw($('#chGas'), { type: 'area', data: d ? d.gas : [], labels: d ? d.labels : null, unit: 'M gas', label: '近 30 日 gas 用量', tone: 'amb', none: noneDaily });
    C.draw($('#chAgents'), { type: 'line', data: d ? d.agents : [], labels: d ? d.labels : null, unit: ' 个', label: 'agent 数量增长', tone: 'vio', none: noneDaily });
    if (d && d.fee && d.fee.length) {
      C.stacked($('#chFee'), {
        label: '近 30 日 gas 费去向（按出块者分账）', unit: ' BAC', labels: d.labels,
        series: [
          { name: '官方块 → 基金会 90%', cls: 's1', data: d.fee.map(function (v) { return v * 0.9; }) },
          { name: '官方块 → 验证者池 10%', cls: 's2', data: d.fee.map(function (v) { return v * 0.1; }) },
          { name: '验证者块 → 该验证者 50%', cls: 's3', data: d.feeSelf || d.fee.map(function () { return 0; }) }
        ]
      });
    } else {
      C.placeholder($('#chFee'), noneDaily);
    }
    if (UI.curAgent && $('#chHb')) {
      var hb = UI.curAgent.hb || [];
      C.draw($('#chHb'), {
        type: 'bar', bare: true, padL: 4, label: '最近 30 个纪元的心跳',
        data: hb.map(function (v) { return v ? 1 : 0.08; }),
        labels: hb.map(function (v, i) { return '纪元 ' + ((VM.chain.epoch || 0) - 29 + i) + (v ? ' 有心跳' : ' 漏'); }),
        none: UI.TEXT.PRE
      });
    }
  }

  UI.pages = {
    state: st,
    renderBlocks: renderBlocks, renderTxs: renderTxs, renderAgents: renderAgents,
    renderOverviewTables: renderOverviewTables, renderFeed: renderFeed, setFeedFilter: setFeedFilter,
    renderTreasury: renderTreasury, renderValidators: renderValidators,
    renderBlockDetail: renderBlockDetail, renderTxDetail: renderTxDetail,
    renderAgentDetail: renderAgentDetail, renderContractDetail: renderContractDetail,
    renderEpochs: renderEpochs, renderEpochDetail: renderEpochDetail,
    renderTokens: renderTokens, renderTokenDetail: renderTokenDetail,
    renderPairs: renderPairs, renderPairDetail: renderPairDetail,
    renderSwaps: renderSwaps,
    renderSearchPage: renderSearchPage, searchAll: searchAll,
    setScope: setScope, getScope: getScope, SCOPE_ZH: SCOPE_ZH,
    drawAll: drawAll
  };
})(typeof window !== 'undefined' ? window : globalThis);
