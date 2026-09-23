/* BNB Agent Chain · 可视层 · 行与单元格渲染
   只读 window.BACVM，任何一个字段是 null 都按「不知道」渲染，绝不当成 0。 */
(function (root) {
  'use strict';

  var UI = root.BACUI;
  if (!UI || !UI.util) {
    if (root.console) root.console.error('[BACUI] rows.js 需要先加载 js/ui/util.js');
    return;
  }
  if (UI.rows) return;

  var VM = root.BACVM;
  var esc = UI.esc, comma = UI.comma, sa = UI.sa, sh = UI.sh, bac = UI.bac, val = UI.val, miss = UI.miss;

  var GASLIMIT_FALLBACK = 20000000;

  /* ── 通用小件 ─────────────────────────────────────────── */

  /** 整行占位：列表读不到时不留空表，明说为什么。
      状态（「发射后公布」）和说明分成两段各自成行：两段各有各的译文，
      拼成一个文本节点时英文里只剩一个空格，读起来是一句没标点的长句。
      说明文字包在 .em-t 里：表格在手机上能横向滚动，说明不能跟着滚出视口（见 bac.css .tbl .empty）。 */
  function missRow(cols, status, extra) {
    return '<tr class="empty"><td class="l" colspan="' + cols + '"><div class="em-t">' +
      '<b class="em-st">' + esc(miss(status)) + '</b>' +
      (extra ? '<span class="em-x">' + esc(extra) + '</span>' : '') + '</div></td></tr>';
  }
  function emptyRow(cols, text) {
    return '<tr class="empty"><td class="l" colspan="' + cols + '"><div class="em-t">' + esc(text) + '</div></td></tr>';
  }

  function stTag(cls, text) { return '<span class="st-tag ' + cls + '">' + esc(text) + '</span>'; }

  function methodTag(t) {
    var cls = { deploy: 'dep', call: 'call', transfer: 'xfer', bridge: 'bri' }[t.type] || 'call';
    var m = t.method || '—';
    return '<span class="tag ' + cls + '">' + esc(m.length > 20 ? m.slice(0, 18) + '…' : m) + '</span>';
  }

  /** 交易的「目标」列：部署 / 合约 / agent 钱包 / 系统合约，各有各的说法。 */
  function toCell(t) {
    if (t.toLabelKind === 'created' || (t.type === 'deploy' && t.created)) {
      return '<span class="ok-t">新合约 ' + esc(sa(t.created || t.to)) + '</span>';
    }
    if (!t.to) return '<span class="sub">—</span>';
    if (t.toLabelKind === 'contract') {
      return '<a class="a-link" href="#/contract/' + esc(t.to) + '"><code>' + esc(sa(t.to)) + '</code></a>' +
        (t.toContractAgentId ? '<span class="sub">agent #' + t.toContractAgentId + ' 部署</span>' : '');
    }
    if (t.toLabelKind === 'agent' && t.toAgentId) {
      return '<code>' + esc(sa(t.to)) + '</code><span class="sub">agent #' + t.toAgentId + '</span>';
    }
    /* 系统地址：显示它**准确的名字**（bind.js 从创世常量表里带过来的），
       不要一律写成「层内系统合约」—— 0x…dEaD 根本不是合约，它是黑洞地址。 */
    if (t.toLabelKind === 'system' || t.toLabelKind === 'sink') {
      return '<code>' + esc(sa(t.to)) + '</code><span class="sub">' +
        esc(t.toLabel || (t.toLabelKind === 'sink' ? '黑洞地址 · 打进去的 BAC 永久销毁' : '层内系统合约')) + '</span>';
    }
    return '<code>' + esc(sa(t.to)) + '</code>';
  }

  /** 出块者列。阶段 1 全部是官方节点；proposer 读不到时如实说读不到。 */
  function propCell(b, status) {
    if (!b.proposerKind) {
      return '<td class="l"><span class="sub">' + esc(miss(status === 'ok' ? 'ok' : status)) + '</span></td>';
    }
    var official = b.proposerKind === 'official';
    return '<td class="l">' + stTag(official ? 'ok' : 'vio', official ? '官方节点' : '验证者') +
      '<span class="sub">' + esc(b.proposer ? sa(b.proposer) : '—') + (official ? ' · 不流通地址' : '') + '</span></td>';
  }

  /** 这条链的区块列表最该有的一列：这一块的 gas 费怎么分。 */
  function splitCell(b) {
    if (!b.proposerKind) return '<td class="r"><span class="spl">—</span></td>';
    return b.proposerKind === 'official'
      ? '<td class="r"><span class="spl o">10 / 90</span></td>'
      : '<td class="r"><span class="spl v">50 / 50</span></td>';
  }

  function gasCell(b) {
    var limit = b.gasLimit || VM.chain.gasLimit || GASLIMIT_FALLBACK;
    var p = (b.gasUsed === null || b.gasUsed === undefined) ? null : (b.gasUsed / limit * 100);
    return '<td class="r n">' + (b.gasUsed === null || b.gasUsed === undefined ? '—' : comma(b.gasUsed)) + '</td>' +
      '<td class="r n hide-m">' + (p === null ? '—' : p.toFixed(2) + '%') + '</td>';
  }

  function anchorCell(b) {
    return '<td class="r">' + (b.anchored
      ? '<span class="anc done">已锚定</span>'
      : '<span class="anc">待锚定</span>') + '</td>';
  }

  /* ── 区块行 ───────────────────────────────────────────── */
  function blockRow(b, compact, status) {
    var st = status || VM.st.blocks;
    if (compact) {
      return '<tr data-go="#/block/' + b.number + '">' +
        '<td class="l n bn">#' + comma(b.number) + '</td>' +
        '<td class="n">' + esc(UI.hms(b.ts)) + '<span class="ago">' + esc(UI.ago(b.ts)) + '</span></td>' +
        '<td class="l">' + (b.proposerKind
          ? stTag(b.proposerKind === 'official' ? 'ok' : 'vio', b.proposerKind === 'official' ? '官方节点' : '验证者')
          : '<span class="sub">—</span>') + '</td>' +
        '<td class="r n">' + (b.txCount === null || b.txCount === undefined ? '—' : b.txCount) + '</td>' +
        '<td class="r n">' + (b.gasUsed === null || b.gasUsed === undefined ? '—' : comma(b.gasUsed)) + '</td>' +
        '<td class="r n">' + val(st, b.fee, bac) + '</td>' +
        splitCell(b) + '</tr>';
    }
    return '<tr data-go="#/block/' + b.number + '">' +
      '<td class="l n bn">#' + comma(b.number) + '</td>' +
      '<td class="n">' + esc(UI.hms(b.ts)) + '<span class="sub">' + esc(UI.ago(b.ts)) + '</span></td>' +
      propCell(b, st) +
      '<td class="r n">' + (b.txCount === null || b.txCount === undefined ? '—' : b.txCount) + '</td>' +
      gasCell(b) +
      '<td class="r n">' + val(st, b.fee, bac) + '</td>' +
      splitCell(b) +
      '<td class="r n hide-m">' + (b.epoch === null || b.epoch === undefined ? '—'
        : '<a class="a-link" href="#/epoch/' + b.epoch + '">' + b.epoch + '</a>') + '</td>' +
      anchorCell(b) + '</tr>';
  }

  /* ── 交易行 ───────────────────────────────────────────── */
  function txRow(t, compact, status) {
    var st = status || VM.st.txs;
    var okTag = t.ok === null || t.ok === undefined
      ? '<span class="sub">—</span>'
      : (t.ok ? stTag('ok', '成功') : stTag('bad', '失败'));
    var who = t.agentId ? 'agent #' + t.agentId
      : (t.fromAddr ? '<code>' + esc(sa(t.fromAddr)) + '</code><span class="sub">未注册</span>' : '—');
    if (compact) {
      return '<tr data-go="#/tx/' + esc(t.hash) + '">' +
        '<td class="l n"><code>' + esc(sh(t.hash)) + '</code></td>' +
        '<td class="l">' + methodTag(t) + '</td>' +
        '<td class="l n">' + (t.agentId ? '#' + t.agentId : '—') + '</td>' +
        '<td class="l n tgt oneline">' + toCell(t) + '</td>' +
        '<td class="r n">' + val(st, t.fee, bac) + '</td>' +
        '<td class="r">' + okTag + '</td></tr>';
    }
    return '<tr data-go="#/tx/' + esc(t.hash) + '">' +
      '<td class="l n"><code>' + esc(sh(t.hash)) + '</code></td>' +
      '<td class="l">' + methodTag(t) + '</td>' +
      '<td class="r n bn">#' + comma(t.block) + '</td>' +
      '<td class="n">' + esc(UI.hms(t.ts)) + '<span class="sub">' + esc(UI.ago(t.ts)) + '</span></td>' +
      '<td class="l n">' + who + '</td>' +
      '<td class="l n">' + toCell(t) + '</td>' +
      '<td class="r n hide-m">' + (t.value && t.value !== 0n ? UI.tokenAmt(t.value) + '<u>BAC</u>' : '0') + '</td>' +
      '<td class="r n">' + (t.gasUsed === null || t.gasUsed === undefined ? '—' : comma(t.gasUsed)) + '</td>' +
      '<td class="r n">' + val(st, t.fee, bac) + '</td>' +
      '<td class="r">' + okTag + '</td></tr>';
  }

  /* ── agent 行 ─────────────────────────────────────────── */
  function hbSpark(a) {
    if (!a.hb || !a.hb.length) return '<span class="sub">—</span>';
    var s = '';
    for (var i = 0; i < a.hb.length; i++) s += a.hb[i] ? '█' : '░';
    return '<span class="spk">' + s + '</span>';
  }

  function agentRow(a, status) {
    var st = status || VM.st.agents;
    return '<tr data-go="#/agent/' + a.id + '">' +
      '<td class="l n">agent #' + a.id + '</td>' +
      '<td class="l">' + stTag(a.statusCls || 'dim', a.statusZh || '—') + '</td>' +
      '<td class="l n hide-m"><code>' + esc(a.wallet ? sa(a.wallet) : '—') + '</code></td>' +
      '<td class="n">' + esc(UI.ago(a.joinedTs)) + '</td>' +
      '<td class="r n">' + val(st, a.credited, UI.tokenAmt) + '<u>BAC</u></td>' +
      '<td class="r n">' + val(st, a.balance, UI.tokenAmt) + '<u>BAC</u></td>' +
      '<td class="r n">' + (a.deploys === null || a.deploys === undefined ? '—' : a.deploys) + '</td>' +
      '<td class="r n hide-m">' + (a.announces === null || a.announces === undefined ? '—' : a.announces) + '</td>' +
      '<td class="r n hide-m">' + (a.hbEpoch === null || a.hbEpoch === undefined ? '—' : a.hbEpoch) +
      (a.missed ? '<span class="sub">漏 ' + a.missed + '</span>' : '') + '</td>' +
      '<td class="r n hide-m">' + hbSpark(a) + '</td></tr>';
  }

  /* ── 验证者行 ─────────────────────────────────────────── */
  function validatorRow(v, status) {
    var st = status || VM.st.validators;
    return '<tr>' +
      '<td class="l"><code>' + esc(v.nodeId || '—') + '</code><span class="sub">' + esc(v.addr ? sa(v.addr) : '—') + '</span></td>' +
      '<td class="r n">' + val(st, v.stake, UI.tokenAmt) + '</td>' +
      '<td class="r n">' + (v.agreed === null || v.agreed === undefined ? '—' : v.agreed + '/' + (v.attend30 || v.agreed)) + '</td>' +
      '<td class="r n">' + (v.agreed === null || v.agreed === undefined ? '—' : v.agreed) + '</td>' +
      '<td class="r n">' + (v.disputed === null || v.disputed === undefined ? '—' : v.disputed) + '</td>' +
      '<td class="r n hide-m">' + (v.blocks === null || v.blocks === undefined ? '—' : v.blocks) +
      (v.rights ? '' : '<span class="sub">阶段 1</span>') + '</td>' +
      '<td class="r n hide-m">' + val(st, v.gasPoolPending, function (x) { return bac(x, 5); }) + '<u>BAC</u></td>' +
      '<td class="r n hide-m">' + val(st, v.lifetimeClaimedBnb, UI.bnb) + '<u>BNB</u></td>' +
      '<td class="r">' + (v.active === null || v.active === undefined
        ? '<span class="sub">—</span>'
        : stTag(v.active ? 'ok' : 'warn', v.active ? '在线' : '离线')) + '</td>' +
      '</tr>';
  }

  /* ── 纪元行 ───────────────────────────────────────────── */
  function epStateTag(e) {
    return '<span class="ep-state ' + (e.stateCls || 'open') + '">' + esc(e.stateEn || 'NONE') + ' · ' + esc(e.stateZh || '—') + '</span>';
  }

  function epochRow(e, status) {
    var st = status || VM.st.epochs;
    var gapCls = (e.gasGap === null || e.gasGap === undefined) ? '' : (e.gasGap > 0n ? 'amb' : 'grn');
    return '<tr data-go="#/epoch/' + e.n + '">' +
      '<td class="l n bn">' + e.n + '</td>' +
      '<td class="l">' + epStateTag(e) + '</td>' +
      '<td class="r n">' + (e.agreeing === null || e.agreeing === undefined ? '—' : e.agreeing + ' / ' + (e.members === null ? '—' : e.members)) + '</td>' +
      '<td class="r n hide-m">' + (e.releaseBps === null || e.releaseBps === undefined ? '—' : e.releaseBps + '<u>bps</u>') + '</td>' +
      '<td class="r n">' + (e.exits === null || e.exits === undefined ? '—' : e.exits) + '</td>' +
      '<td class="r n hide-m">' + val(st, e.gasFees, bac) + '<u>BAC</u></td>' +
      '<td class="r n hide-m">' + val(st, e.gasRemitted, bac) + '<u>BAC</u></td>' +
      '<td class="r n ' + gapCls + '">' + val(st, e.gasGap, bac) + '</td>' +
      '<td class="l n hide-m">' + (e.anchorTx ? '<code>' + esc(sa(e.anchorTx)) + '</code>' : '<span class="anc">未提交</span>') + '</td>' +
      '</tr>';
  }

  /* ── 税收路由 / 桥池 / 节点基金事件行 ─────────────────────
     钱离开的事件（节点基金提取、桥的紧急提取）和规则被改的事件（桥合约升级）用同一个醒目色，
     决策 #29c 要求它们在时间线上一眼可见。 */
  function treasuryRow(ev) {
    var out = /Withdraw|Upgraded/.test(String(ev.name || ''));
    return '<tr><td class="l n">' + esc(UI.ymd(ev.ts)) + ' ' + esc(UI.hms(ev.ts)) + '</td>' +
      '<td class="l"><span class="tag ' + (out ? 'bri' : 'dep') + '">' + esc(ev.name) + '</span></td>' +
      '<td class="r n">' + val('ok', ev.amount, UI.bnb) + '<u>BNB</u></td>' +
      '<td class="l">' + esc(ev.note || '') + '</td>' +
      '<td class="r n">' + (ev.tx ? '<code>' + esc(sa(ev.tx)) + '</code>' : '—') + '</td></tr>';
  }

  /* ── 键值行（详情页共用）─────────────────────────────── */
  function kv(k, v, cls) {
    return '<tr><td>' + k + '</td><td class="r ' + (cls || '') + '">' + v + '</td></tr>';
  }

  function notFound(what, why) {
    return '<div class="crumbs"><a href="#/overview">概览</a>›<span>未找到</span></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">NOT FOUND</span><span class="ph-fill"></span></div>' +
      '<div class="empty-box"><b>找不到 ' + esc(what) + '</b>' + esc(why) + '</div></div>';
  }

  /** 发射前 / 读取失败时的整页占位，用在所有详情页上。 */
  function pageMiss(title, status, note) {
    return '<div class="crumbs"><a href="#/overview">概览</a>›<span>' + esc(title) + '</span></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">' + esc(title) + '</span><span class="ph-fill"></span></div>' +
      '<div class="empty-box"><b>' + esc(miss(status)) + '</b>' + esc(note || '') + '</div></div>';
  }

  UI.rows = {
    missRow: missRow, emptyRow: emptyRow, stTag: stTag, methodTag: methodTag,
    toCell: toCell, propCell: propCell, splitCell: splitCell, gasCell: gasCell,
    blockRow: blockRow, txRow: txRow, agentRow: agentRow, hbSpark: hbSpark,
    validatorRow: validatorRow, epochRow: epochRow, epStateTag: epStateTag,
    treasuryRow: treasuryRow, kv: kv, notFound: notFound, pageMiss: pageMiss
  };
})(typeof window !== 'undefined' ? window : globalThis);
