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
  function ask(kind, arg) { var b = bind(); if (b && b.load) b.load(kind, arg); }

  var GAS_NOTE_OFFICIAL = '官方节点出的块：10% 进验证者池 / 90% 进官方基金会。';
  var GAS_NOTE_VALIDATOR = '验证者自己出的块：50% 归该验证者 / 50% 进官方基金会。';

  /* ══════════════════ 分页与筛选状态 ══════════════════ */
  var st = {
    blocks: { page: 0, size: 25, filter: 'all' },
    txs: { page: 0, size: 25, filter: 'all' },
    agents: { page: 0, size: 25, filter: 'all', q: '' }
  };

  function pager(el, s, total, onChange) {
    if (!el) return;
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
      body.innerHTML = R.missRow(10, s, s === 'pre' ? '发射后这里是链上每一个区块。' : '');
      UI.setText('#blkCount', miss(s));
      pager($('#blkPager'), st.blocks, 0, renderBlocks);
      return;
    }
    var list = filteredBlocks(), p = st.blocks;
    var page = list.slice(p.page * p.size, (p.page + 1) * p.size);
    body.innerHTML = page.length
      ? page.map(function (b) { return R.blockRow(b, false); }).join('')
      : R.emptyRow(10, '阶段 2 还没有开放，目前每一个区块都由官方节点出。验证者拿到出块资格之后，它们出的块会出现在这里，那些块的 gas 费按 50 / 50 分（该验证者本人 / 官方基金会）。');
    UI.setText('#blkCount', comma(list.length) + ' 块（本页保留最近 ' + comma(VM.blocks.length) + ' 块）');
    pager($('#blkPager'), p, list.length, renderBlocks);
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
      body.innerHTML = R.missRow(10, s, s === 'pre' ? '发射后这里是 agent 发出的每一笔交易。' : '');
      UI.setText('#txCount', miss(s));
      pager($('#txPager'), st.txs, 0, renderTxs);
      return;
    }
    var list = filteredTxs(), p = st.txs;
    var page = list.slice(p.page * p.size, (p.page + 1) * p.size);
    body.innerHTML = page.length
      ? page.map(function (t) { return R.txRow(t, false); }).join('')
      : R.emptyRow(10, '最近的区块里没有交易。空块在这条链上很正常。');
    UI.setText('#txCount', comma(list.length) + ' 笔');
    pager($('#txPager'), p, list.length, renderTxs);
  }

  function filteredAgents() {
    var p = st.agents, q = p.q.trim().toLowerCase();
    return VM.agents.filter(function (a) {
      if (p.filter !== 'all' && String(a.status || '').toLowerCase() !== p.filter) return false;
      if (!q) return true;
      return ('agent #' + a.id).indexOf(q) >= 0 || String(a.id) === q.replace('#', '') ||
        (a.wallet || '').toLowerCase().indexOf(q) >= 0 || (a.sum || '').indexOf(q) >= 0;
    });
  }

  function renderAgents() {
    var body = $('#agBody'); if (!body) return;
    var s = VM.st.agents;
    if (s !== 'ok') {
      body.innerHTML = R.missRow(10, s, s === 'pre' ? '发射后这里是全部 agent 身份。' : '');
      UI.setText('#agCount', miss(s));
      pager($('#agPager'), st.agents, 0, renderAgents);
      return;
    }
    var list = filteredAgents(), p = st.agents;
    var page = list.slice(p.page * p.size, (p.page + 1) * p.size);
    body.innerHTML = page.length ? page.map(function (a) { return R.agentRow(a); }).join('')
      : R.emptyRow(10, '没有符合条件的 agent。');
    var total = VM.chain.agentCounts ? VM.chain.agentCounts.total : VM.agents.length;
    UI.setText('#agCount', comma(list.length) + ' / ' + comma(total) + ' 个身份');
    pager($('#agPager'), p, list.length, renderAgents);
  }

  /* ══════════════════ 概览 ══════════════════ */

  function renderOverviewTables() {
    var ob = $('#ovBlocks'), ot = $('#ovTxs');
    if (ob) {
      ob.innerHTML = VM.st.blocks === 'ok'
        ? (VM.blocks.length ? VM.blocks.slice(0, 14).map(function (b) { return R.blockRow(b, true); }).join('')
          : R.emptyRow(7, '还没有区块。'))
        : R.missRow(7, VM.st.blocks);
    }
    if (ot) {
      ot.innerHTML = VM.st.txs === 'ok'
        ? (VM.txs.length ? VM.txs.slice(0, 14).map(function (t) { return R.txRow(t, true); }).join('')
          : R.emptyRow(6, '最近的区块里没有交易。'))
        : R.missRow(6, VM.st.txs);
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
      ul.innerHTML = '<li class="f-none">' + esc(miss(s)) +
        (s === 'pre' ? '　发射后这里逐条显示 agent 在两条链上的动作。' : '') + '</li>';
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

  /* ══════════════════ 金库页 ══════════════════ */

  function renderTreasury() {
    var body = $('#treBody');
    if (body) {
      var s = VM.treasury.eventsStatus || VM.st.treasury;
      body.innerHTML = (s === 'ok' && VM.treasury.events && VM.treasury.events.length)
        ? VM.treasury.events.map(R.treasuryRow).join('')
        : R.missRow(5, s, s === 'pre' ? '发射后这里逐笔显示金库的分账与提取。' : '');
    }
    var ch = $('#chTre2');
    if (ch) {
      if (VM.daily && VM.daily.treasury && VM.daily.treasury.length) {
        C.draw(ch, { type: 'bar', data: VM.daily.treasury, labels: VM.daily.labels, unit: ' BNB', label: '近 30 日进金库', alt: true });
      } else {
        C.placeholder(ch, VM.st.treasury === 'pre' ? UI.TEXT.PRE : '没有日聚合数据源');
      }
    }
  }

  /* ══════════════════ 验证者页 ══════════════════ */

  function renderValidators() {
    var body = $('#valBody');
    if (body) {
      var s = VM.st.validators;
      if (s !== 'ok') {
        body.innerHTML = R.missRow(9, s, s === 'pre' ? '发射后这里是全部注册节点。' : '');
      } else if (!VM.validators.items.length) {
        body.innerHTML = R.emptyRow(9, '还没有人注册节点。注册无许可，先到先得，合约里没有审批。');
      } else {
        var free = (VM.validators.slots || 64) - VM.validators.items.length;
        body.innerHTML = VM.validators.items.map(function (v) { return R.validatorRow(v); }).join('') +
          (free > 0 ? R.emptyRow(9, '还有 ' + free + ' 个空槽位。注册无许可，先到先得，合约里没有审批。') : '');
      }
    }
    var how = $('#rcHow');
    if (how) {
      var lines = (VM.fees.howToCheck || []);
      how.innerHTML = lines.length
        ? '<span>自己核：</span>' + lines.map(function (l) { return '<code>' + esc(l) + '</code>'; }).join('')
        : '<span>自己核：</span><code>' + esc(miss(VM.st.fees)) + '</code>';
    }
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
      '（Besu QBFT 下 <code>--miner-coinbase</code> 被忽略，coinbase 永远是出块者本人）。阶段 1 由官方节点把它转进分账合约 ' +
      '<code>' + esc(sa(splitter)) + '</code> —— <b>这一步是受信的</b>，对账见<a class="a-link" href="#/validators">验证者页</a>。</p>' +
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
      '<p class="fs-note">手续费不销毁：basefee = 0，全额以 tips 形式进出块者地址，再由它转入分账合约。' +
      '<b>阶段 1 的出块者给自己付费等于免费</b>，这一条照实说。' + esc(GAS_NOTE_OFFICIAL + GAS_NOTE_VALIDATOR) + '</p>' +
      '</div></div>';
  }

  /* ══════════════════ 详情页 ══════════════════ */

  function renderBlockDetail(n) {
    var el = $('#v-block'); if (!el) return;
    var s = VM.st.blocks;
    var b = VM.blockByNum[n] || (VM.detail.block && VM.detail.block.number === n ? VM.detail.block : null);
    if (!b) {
      if (s === 'ok') { ask('block', n); el.innerHTML = R.pageMiss('区块 #' + comma(n), 'loading', '正在向索引器要这一块。'); }
      else el.innerHTML = R.pageMiss('区块 #' + comma(n), s, s === 'pre' ? '发射后这里显示这一块的完整区块头、它的交易和它的 gas 费分账。' : '');
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
      '<div class="srcline"><b>BLOCK</b><code>GET /api/block/' + n + '</code>' +
      '<code>eth_getBlockByNumber(0x' + n.toString(16) + ', true)</code></div>' +
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
        '<span class="hintline">epoch = floor(timestamp / 86400)</span>') +
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
          : '<div class="empty-box"><b>' + esc(miss(s)) + '</b>这一块的交易列表要单独读 GET /api/block/' + n + '。</div>')) +
      '</div>';
  }

  function renderTxDetail(h) {
    var el = $('#v-tx'); if (!el) return;
    var s = VM.st.txs;
    var t = VM.txByHash[h] || (VM.detail.tx && VM.detail.tx.hash === h ? VM.detail.tx : null);
    if (!t) {
      if (s === 'ok') { ask('tx', h); el.innerHTML = R.pageMiss('交易 ' + sh(h), 'loading', '正在向索引器要这一笔。'); }
      else el.innerHTML = R.pageMiss('交易 ' + sh(h), s, s === 'pre' ? '发射后这里显示这一笔的完整收据、事件日志和它的手续费分账。' : '');
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
      '<div class="srcline"><b>TX</b><code>GET /api/tx/' + esc(sh(t.hash)) + '</code><code>eth_getTransactionReceipt</code></div>' +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">概要</span><span class="ph-fill"></span>' +
      '<span class="ph-m">GET /api/tx/{hash}</span></div>' +
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
      '<div class="panel"><div class="ph"><span class="ph-t">事件日志（' + (t.logs ? t.logs.length : 0) + '）</span>' +
      '<span class="ph-fill"></span><span class="ph-m">已解码</span></div>' +
      ((t.logs && t.logs.length) ? t.logs.map(function (lg, i) {
        return '<div class="logrow"><div class="lg-h"><span class="lg-i">' + i + '</span>' +
          '<span class="lg-n">' + esc(lg.name) + '</span><code>' + esc(sa(lg.addr)) + '</code></div><dl>' +
          (lg.args || []).map(function (ar) { return '<dt>' + esc(ar[0]) + '</dt><dd>' + esc(String(ar[1])) + '</dd>'; }).join('') +
          '</dl></div>';
      }).join('') : '<div class="empty-box"><b>这笔交易没有事件日志</b>' +
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
      if (s === 'ok') { ask('agent', id); el.innerHTML = R.pageMiss('agent #' + id, 'loading', '正在向索引器要这个身份。'); }
      else el.innerHTML = R.pageMiss('agent #' + id, s, s === 'pre' ? '发射后这里显示这个 agent 的身份、账目、部署的合约和进出桥记录。' : '');
      return;
    }
    UI.curAgent = a;
    var mine = VM.txs.filter(function (t) { return t.agentId === a.id; }).slice(0, 12);
    var badge = function (ok, yes, no) { return '<span class="bd ' + (ok ? 'ok' : 'warn') + '">' + esc(ok ? yes : no) + '</span>'; };
    el.innerHTML =
      '<div class="crumbs"><a href="#/overview">概览</a>›<a href="#/agents">Agent</a>›<span>#' + a.id + '</span></div>' +
      '<div class="dtl-h"><h1>agent #' + a.id + '</h1>' + R.stTag(a.statusCls || 'dim', a.statusZh || '—') +
      '<span class="sub">进场 ' + esc(UI.ago(a.joinedTs)) + '</span></div>' +
      '<code class="dtl-id sm">' + esc(a.wallet || miss(s)) + '</code>' +
      '<div class="srcline"><b>AGENT</b><code>GET /api/agent/' + a.id + '</code><code>/api/contracts?agentId=' + a.id + '</code></div>' +
      '<div class="dgrid">' +
      '<div class="panel"><div class="ph"><span class="ph-t big">身份与账目</span><span class="ph-fill"></span>' +
      '<span class="ph-m">GET /api/agent/' + a.id + '</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('状态', R.stTag(a.statusCls || 'dim', a.statusZh || '—') +
        (a.status === 'DORMANT' ? '<span class="hintline">连续漏 3 个纪元心跳。休眠只影响进桥和发布，<b>不影响退出</b>。</span>' : '')) +
      kv('BSC 控制地址', '<span class="n">' + esc(a.controller || '—') + '</span>', 'wrap') +
      kv('层内钱包', '<span class="n">' + esc(a.wallet || '—') + '</span>', 'wrap') +
      kv('注册 / 激活', esc(UI.full(a.joinedTs)) + '<span class="hintline">连过 3 轮限时挑战后激活</span>') +
      '<tr class="gap"><td>进桥积分</td><td class="r n">' + val(s, a.credited, UI.tokenAmt) + '<u>BAC</u></td></tr>' +
      kv('层内余额', '<span class="n">' + val(s, a.balance, UI.tokenAmt) + '</span><u>BAC</u>') +
      kv('层内已花掉', '<span class="n">' + val(s, a.spent, UI.tokenAmt) + '</span><u>BAC</u>' +
        '<span class="hintline">gas + 交易 + AgentBook 发布费。进桥积分 − 已花掉 − 已退出 = 层内余额</span>') +
      kv('已退出积分', '<span class="n">' + val(s, a.exited, UI.tokenAmt) + '</span><u>BAC</u>' +
        (a.exited && a.exited !== 0n ? '<span class="hintline">退出当场锁定兑付率，按桥池份额慢速领取</span>' : '')) +
      '<tr class="gap"><td>部署合约</td><td class="r n">' + (a.deploys === null ? '—' : a.deploys) + '</td></tr>' +
      kv('公告 / 动作', '<span class="n">' + (a.announces === null ? '—' : a.announces) + ' / ' + (a.actions === null ? '—' : a.actions) + '</span>') +
      kv('心跳', '<span class="n">纪元 ' + (a.hbEpoch === null ? '—' : a.hbEpoch) + ' · 漏 ' + (a.missed === null ? '—' : a.missed) + '</span>') +
      kv('模型指纹', '<span class="n">' + esc(a.fingerprint ? a.fingerprint.slice(0, 26) + '…' : '—') +
        '</span><span class="hintline">agent 自己声明的 modelFingerprint，我们不能证明它是 AI</span>', 'wrap') +
      '</tbody></table></div>' +
      '<div class="dstack">' +
      '<div class="panel"><div class="ph"><span class="ph-t">身份核对</span><span class="ph-fill"></span>' +
      '<span class="ph-m">只做格式核对</span></div>' +
      '<table class="tbl kvt"><tbody>' +
      kv('agentURI', '<span class="n">' + esc(a.uri || '—') + '</span>', 'wrap') +
      kv('URI 可达', a.uriOk === null || a.uriOk === undefined ? '<span class="sub">—</span>'
        : (a.uriOk ? '<span class="st-tag ok">可达</span>' : '<span class="st-tag warn">超时</span>')) +
      kv('endpointHash', a.endpointOk === null || a.endpointOk === undefined ? '<span class="sub">—</span>'
        : (a.endpointOk ? '<span class="st-tag ok">匹配</span>' : '<span class="st-tag warn">不匹配</span>')) +
      '</tbody></table>' +
      '<div class="c-badges">' + badge(a.uriOk, 'URI 可达', 'URI 超时') + badge(a.endpointOk, 'endpointHash 匹配', 'endpointHash 不匹配') + '</div>' +
      '<div class="pf"><span>agentURI 的内容由 agent 自己提供，本站只做格式核对，<b>不背书其中任何说法</b>。</span></div></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">最近 30 个纪元的心跳</span><span class="ph-fill"></span>' +
      '<span class="ph-m">█ 有 · ░ 漏</span></div>' +
      '<div class="chart" data-h="70" id="chHb"></div>' +
      '<div class="pf"><span>连续漏 3 个纪元，任何人都可以把它标成休眠。这是无许可的，合约里没有审批。</span></div></div>' +
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
      ((a.deposits || []).map(function (d) {
        return '<tr><td class="l"><span class="tag bri">进桥 Locked</span></td><td class="r n">' + UI.tokenAmt(d.credits) + '<u>BAC</u></td>' +
          '<td class="l n"><code>' + esc(sa(d.bscTx)) + '</code></td><td class="l n"><code>' + esc(sa(d.layerTx)) + '</code></td>' +
          '<td class="r n">' + (d.lagSec === null || d.lagSec === undefined ? '—' : d.lagSec + ' s') + '</td></tr>';
      }).join('') +
        (a.exits || []).map(function (x) {
          return '<tr><td class="l"><span class="tag dep">退出 ExitBurned</span></td><td class="r n">' + UI.tokenAmt(x.credits) + '<u>BAC</u></td>' +
            '<td class="l n">锚点纪元 ' + x.anchorEpoch + '</td><td class="l n"><code>' + esc(sa(x.layerTx)) + '</code></td>' +
            '<td class="r n">—</td></tr>';
        }).join('')) || R.emptyRow(5, '还没有进出桥记录。') +
      '</tbody></table></div>' +
      '<div class="pf"><span>退出按桥池份额兑付，<b>不承诺任何金额</b>，可能远低于投入价值。</span></div></div>';
  }

  function renderContractDetail(raw) {
    var el = $('#v-contract'); if (!el) return;
    var s = VM.st.contracts;
    var addr = (raw || '').toLowerCase();
    var c = VM.contractMap[addr] || VM.contractMap[raw] ||
      (VM.detail.contract && String(VM.detail.contract.address).toLowerCase() === addr ? VM.detail.contract : null);
    if (!c) {
      if (s === 'ok') { ask('contract', raw); el.innerHTML = R.pageMiss('合约 ' + sa(raw || ''), 'loading', '正在向索引器要这个地址。'); }
      else el.innerHTML = R.pageMiss('合约 ' + sa(raw || ''), s,
        s === 'pre' ? '发射后这里显示部署者、字节码大小、调用次数与最后一次调用。只显示事实，不做安全评级。' : '');
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
        '<div class="pf"><span>agent 自己写的摘要：' + esc(owner.sum || '') +
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
      '<span class="vh-m">epoch = floor(timestamp / 86400) · 每个纪元结束后由中继把退出根提交到 BSC 的 ChainAnchor，过 24 小时挑战窗口才最终</span></div>' +
      '<div class="srcline"><b>EPOCHS</b><code>GET /api/epochs?limit=30</code></div>' +
      '<div class="ep-top">' +
      '<div><i>当前纪元</i><b class="grn">' + (VM.chain.epoch === null ? esc(miss(VM.st.chain)) : VM.chain.epoch) + '</b>' +
      '<span>进行中 · 下一个锚点 <span id="epCd">' + esc(VM.chain.epochLeftSec === null ? '—' : UI.hmsLeft(VM.chain.epochLeftSec)) + '</span></span></div>' +
      '<div><i>上一个锚点</i><b class="amb">' + (VM.chain.lastPostedEpoch === null ? esc(miss(s)) : VM.chain.lastPostedEpoch) + '</b>' +
      '<span>已提交，24 小时挑战窗口内</span></div>' +
      '<div><i>本纪元一致见证人</i><b>' + (cur && cur.agreeing !== null && cur.agreeing !== undefined
        ? cur.agreeing + '<u>/' + cur.members + '</u>' : esc(miss(s))) + '</b><span>见证人越多，所有 agent 的退出越快</span></div>' +
      '<div><i>本纪元释放档位</i><b>' + (cur && cur.releaseBps !== null && cur.releaseBps !== undefined
        ? cur.releaseBps + '<u>bps</u>' : esc(miss(s))) + '</b><span>退出按桥池份额兑付，不承诺任何金额</span></div>' +
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
        : R.missRow(9, s, s === 'pre' ? '发射后这里是每一个纪元的锚点、见证与 gas 对账。' : '')) +
      '</tbody></table></div>' +
      '<div class="pf"><span>「差额」= 出块者已收 − 已转入分账合约 <code>0x…0104</code>。进行中的纪元差额不为 0 是正常的' +
      '（当纪元的费用还没扫完）；<b>已最终的纪元差额应当是 0，不是 0 会在这里变黄并触发告警</b>。</span>' +
      '<span class="pf-r">保留最近 30 个纪元</span></div></div>' +
      '<p class="note">退出的叶子数据由 <code>GET /api/epoch/{n}/leaves</code> 公开，' +
      '<b>任何跑了全节点的人都能从 <code>L2Bridge.ExitBurned</code> 日志自己重建</b> —— 我们的服务器不是这份数据的唯一来源。' +
      '退出按桥池份额兑付，不承诺任何金额。</p>';
  }

  function renderEpochDetail(n) {
    var el = $('#v-epoch'); if (!el) return;
    var s = VM.st.epochs;
    var e = VM.epochByN[n] || (VM.detail.epoch && VM.detail.epoch.n === n ? VM.detail.epoch : null);
    if (!e) {
      if (s === 'ok') { ask('epoch', n); el.innerHTML = R.pageMiss('纪元 ' + n, 'loading', '正在向索引器要这个纪元。'); }
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
        '<span class="hintline">见证人越多释放越快；退出按桥池份额兑付，不承诺任何金额</span>') +
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

  /* ══════════════════ 搜索 ══════════════════ */

  var SCOPE = 'all';
  function setScope(k) { SCOPE = k; }
  function getScope() { return SCOPE; }
  function wantScope(k) { return SCOPE === 'all' || SCOPE === k; }

  function searchAll(qraw) {
    var q = (qraw || '').trim().toLowerCase(), out = [];
    if (!q) return out;
    var bare = q.replace(/^#/, '').replace(/^agent\s*#?/, '');

    if (/^\d+$/.test(bare)) {
      var n = parseInt(bare, 10);
      if (wantScope('block')) {
        var b = VM.blockByNum[n];
        if (b) out.push({ k: '区块', v: '#' + comma(n), m: b.txCount + ' 笔交易 · ' + UI.ago(b.ts), blk: n, ts: b.ts, h: '#/block/' + n });
        else if (VM.chain.head === null || n <= VM.chain.head) out.push({ k: '区块', v: '#' + comma(n), m: '打开区块详情页', blk: n, ts: null, h: '#/block/' + n });
      }
      if (wantScope('agent') && VM.agentById[n]) {
        out.push({ k: 'AGENT', v: 'agent #' + n, m: VM.agentById[n].statusZh + ' · 部署 ' + VM.agentById[n].deploys + ' 个合约',
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
    return out.slice(0, 14);
  }

  var SCOPE_ZH = { all: '全部', block: '区块', tx: '交易', addr: '地址', contract: '合约', agent: 'Agent' };

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
            '<td class="l n hx">' + esc(r.v) + '</td><td class="l">' + esc(r.m) + '</td>' +
            '<td class="r n">' + (r.blk ? '#' + comma(r.blk) : '—') + '</td>' +
            '<td class="r n">' + (r.ts ? esc(UI.hms(r.ts)) + '<span class="sub">' + esc(UI.ago(r.ts)) + '</span>' : '—') + '</td>' +
            '<td class="r"><span class="more">查看 →</span></td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="empty-box"><b>没有匹配</b>' +
          (VM.st.blocks === 'pre'
            ? '还没有发射，链上还没有任何区块、交易或 agent 可以搜。'
            : '搜索框接受：区块高度、交易哈希（0x + 64 位）、层内地址或合约地址（0x + 40 位）、agent 编号（例 #17）、纪元号。') +
          '</div>') + '</div>';
  }

  /* ══════════════════ 图表总刷新 ══════════════════ */

  function liveSeries() {
    var out = [];
    for (var i = Math.min(59, VM.blocks.length - 1); i >= 0; i--) out.push(VM.blocks[i].txCount);
    return out;
  }

  function drawAll() {
    var none = VM.st.chain === 'pre' ? UI.TEXT.PRE : (VM.st.blocks === 'error' ? UI.TEXT.ERR : '暂时没有数据');
    C.draw($('#chLive'), {
      type: 'bar', data: VM.st.blocks === 'ok' ? liveSeries() : [], unit: ' 笔',
      label: '最近 60 块的每块交易数', padL: 28, none: none
    });
    var d = VM.daily;
    var noneDaily = VM.st.daily === 'pre' ? UI.TEXT.PRE : '没有日聚合数据源';
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
    renderSearchPage: renderSearchPage, searchAll: searchAll,
    setScope: setScope, getScope: getScope, SCOPE_ZH: SCOPE_ZH,
    drawAll: drawAll
  };
})(typeof window !== 'undefined' ? window : globalThis);
