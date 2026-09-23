/* BNB Agent Chain · 可视层 · 工具（没有任何链代码，没有 fetch，没有 RPC）
   这一层只认 window.BACVM（视图模型）。链上数据怎么来的，由 js/ui/bind.js 一个人负责。
   格式化优先用数据层的 BAC.fmt（同一套口径），数据层没加载时用这里的同名实现兜底。 */
(function (root) {
  'use strict';

  var UI = root.BACUI = root.BACUI || {};
  if (UI.util) return;

  var DASH = '—';

  /* ── 状态文案（04-website-conventions.md §1.3，逐字）────────── */
  var TEXT = {
    PRE: '发射后公布',
    ERR: '读取失败 · 重试中',
    LOADING: '读取中…',
    NO_INDEXER: '索引器读不到：层内数据暂时不可用，BSC 侧数字仍然是实时的',
    RPC_DIRECT: '索引器读不到：区块与交易改由本站直接读层内节点，历史与搜索暂时不可用',
    NOT_ANCHORED: '未锚定 · 仅来自官方节点',
    ANCHORED: '已锚定',
    NO_SOURCE: '这一项还没有数据来源',
    /* 面板小标上的「这个数字是谁给的」 */
    SRC_RPC: '直读层内 RPC · 索引器未上线',
    SRC_IDX: '索引器 API',
    NO_IDX: '索引器未上线',
    /* 只有索引器算得出的那些聚合数：它没上线时，数字写「—」，原因写在这里 */
    NEED_IDX: '这个数要索引器把全链扫一遍才算得出来，索引器还没上线。',
    /* BSC 侧还不存在的合约 */
    NEED_BSC: '这一项在 BSC 上，代币还没发射，合约还没部署。'
  };

  /** 一段的状态 → 该显示什么。数值是 null 但整段 ok 时显示「—」（不知道 ≠ 0）。
      'noidx' = 这一项只有索引器算得出、索引器还没上线：显示「—」，**不显示「发射后公布」**
      （那是骗人的：链现在就在跑，只是这个聚合数没人算）。 */
  function miss(status) {
    if (status === 'pre') return TEXT.PRE;
    if (status === 'error') return TEXT.ERR;
    if (status === 'loading') return TEXT.LOADING;
    return DASH;
  }

  /** 面板小标：这一段的数字现在是谁给的。 */
  function srcLabel(source) {
    if (source === 'indexer') return TEXT.SRC_IDX;
    if (source === 'rpc') return TEXT.SRC_RPC;
    return TEXT.NO_IDX;
  }

  /** 有值就格式化，没值就按状态显示占位。**永远不把 null 当 0。** */
  function val(status, v, fmt) {
    if (v === null || v === undefined || v === '') return miss(status);
    try { return fmt ? fmt(v) : String(v); } catch (e) { return miss(status); }
  }

  /* ── 基础格式化 ──────────────────────────────────────────── */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function comma(n) {
    if (n === null || n === undefined) return DASH;
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function int(v) {
    if (v === null || v === undefined) return DASH;
    var n = typeof v === 'bigint' ? v : Math.trunc(Number(v));
    if (typeof n === 'number' && !isFinite(n)) return DASH;
    return comma(n.toString());
  }
  function sa(a) { return a && a.length >= 12 ? a.slice(0, 8) + '…' + a.slice(-4) : (a || DASH); }
  function sh(h) { return h && h.length >= 18 ? h.slice(0, 12) + '…' + h.slice(-6) : (h || DASH); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function big(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'bigint') return v;
    if (root.BAC && root.BAC.big) return root.BAC.big(v);
    try {
      if (typeof v === 'number') return isFinite(v) && Math.floor(v) === v ? BigInt(v) : null;
      var s = String(v).trim();
      if (/^0x[0-9a-fA-F]+$/.test(s) || /^-?\d+$/.test(s)) return BigInt(s);
    } catch (e) { return null; }
    return null;
  }

  /** wei → 字符串，向下取整，最多 dp 位小数，千分位分组。 */
  function units(v, dp, dec) {
    var b = big(v);
    if (b === null) return DASH;
    if (root.BAC && root.BAC.fmt) return root.BAC.fmt.units(b, dec === undefined ? 18 : dec, dp === undefined ? 4 : dp);
    dec = dec === undefined ? 18 : dec; dp = dp === undefined ? 4 : dp;
    var neg = b < 0n; if (neg) b = -b;
    var base = BigInt(10) ** BigInt(dec);
    var w = b / base, f = (b % base).toString().padStart(dec, '0').slice(0, dp).replace(/0+$/, '');
    return (neg ? '-' : '') + comma(w.toString()) + (f ? '.' + f : '');
  }
  function bac(v, dp) { return units(v, dp === undefined ? 6 : dp); }
  function bnb(v, dp) { return units(v, dp === undefined ? 4 : dp); }
  /** 大整数代币口径：≥1000 取 0 位小数 */
  function tokenAmt(v) {
    var b = big(v);
    if (b === null) return DASH;
    if (root.BAC && root.BAC.fmt) return root.BAC.fmt.token(b, 18);
    return units(b, 0);
  }
  function pct(bps) {
    if (bps === null || bps === undefined) return DASH;
    return (Math.round(Number(bps) / 100 * 100) / 100) + '%';
  }
  /** part / whole → 百分比（BigInt 精确） */
  function share(part, whole) {
    var p = big(part), w = big(whole);
    if (p === null || w === null || w === 0n) return DASH;
    return pct(Number(p * 10000n / w));
  }

  /* ── 时间：视图模型里的时间戳一律是**秒**，显示一律北京时间 ── */
  function d8(ts) { return new Date((Number(ts) + 8 * 3600) * 1000); }
  function hms(ts) {
    if (ts === null || ts === undefined) return DASH;
    var d = d8(ts);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }
  function ymd(ts) {
    if (ts === null || ts === undefined) return DASH;
    var d = d8(ts);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function full(ts) {
    if (ts === null || ts === undefined) return DASH;
    return ymd(ts) + ' ' + hms(ts) + ' (UTC+8)';
  }
  function md(ts) {
    if (ts === null || ts === undefined) return DASH;
    var d = d8(ts);
    return pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate());
  }
  function now() {
    if (root.BAC && root.BAC.time) return root.BAC.time.now();
    return Math.floor(Date.now() / 1000);
  }
  function ago(ts) {
    if (ts === null || ts === undefined) return DASH;
    var s = Math.max(0, now() - Number(ts));
    if (s < 5) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function hmsLeft(sec) {
    if (sec === null || sec === undefined) return DASH;
    var n = Math.max(0, Math.floor(Number(sec)));
    return pad2(Math.floor(n / 3600)) + ':' + pad2(Math.floor(n / 60) % 60) + ':' + pad2(n % 60);
  }

  /* ── DOM 小工具 ──────────────────────────────────────────── */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function setText(sel, v) { var el = typeof sel === 'string' ? $(sel) : sel; if (el) el.textContent = v; }
  function setHTML(sel, v) { var el = typeof sel === 'string' ? $(sel) : sel; if (el) el.innerHTML = v; }

  /** 取 VM 上的一条路径，任意一级缺失都返回 null（不抛）。 */
  function path(obj, p) {
    var cur = obj, parts = String(p).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return null;
      cur = cur[parts[i]];
    }
    return cur === undefined ? null : cur;
  }

  UI.util = true;
  UI.TEXT = TEXT;
  UI.DASH = DASH;
  UI.miss = miss;
  UI.srcLabel = srcLabel;
  UI.val = val;
  UI.esc = esc;
  UI.comma = comma;
  UI.int = int;
  UI.sa = sa;
  UI.sh = sh;
  UI.pad2 = pad2;
  UI.big = big;
  UI.units = units;
  UI.bac = bac;
  UI.bnb = bnb;
  UI.tokenAmt = tokenAmt;
  UI.pct = pct;
  UI.share = share;
  UI.hms = hms;
  UI.ymd = ymd;
  UI.full = full;
  UI.md = md;
  UI.ago = ago;
  UI.now = now;
  UI.hmsLeft = hmsLeft;
  UI.$ = $;
  UI.$$ = $$;
  UI.setText = setText;
  UI.setHTML = setHTML;
  UI.path = path;
  UI.reduced = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
})(typeof window !== 'undefined' ? window : globalThis);
