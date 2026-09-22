/* BNB Agent Chain · 数据层 · 核心（配置 / 常量 / 格式化 / 事件总线 / 状态骨架）
   规矩（docs/research/04-website-conventions.md §1.1）：
   - js/data/* 是唯一碰链的代码，暴露 window.BAC，**里面没有任何 DOM 代码**；
   - 绑定层（js/ui/bind.js，不属于本轮）是 window.BAC 的唯一消费者；
   - 每一个数字都来自链上或索引器：发射前一律「发射后公布」，读取失败一律「读取失败 · 重试中」，
     永远不显示演示值。null 表示未知，不是 0。
   加载顺序：site.config.js → vendor/ethers-6.13.4.umd.min.js → bac-core.js → bac-chain.js → bac-api.js → bac-view.js
   缺依赖时：打印一条错误，什么都不做（不抛，不影响页面其它部分）。 */
(function (root) {
  'use strict';

  var BAC = root.BAC = root.BAC || {};
  if (BAC.core) return; // 重复加载保护

  /* ══════════════════════════════════════════════════════
     1. 常量
     ══════════════════════════════════════════════════════ */

  var ZERO = '0x0000000000000000000000000000000000000000';

  // 层内创世系统合约（docs/02-CHAIN-SPEC.md §2 + docs/01-CONTRACT-SPEC.md §11）
  var LAYER = {
    L2_BRIDGE: '0x0000000000000000000000000000000000000101',
    L2_GATE: '0x0000000000000000000000000000000000000102',
    AGENT_BOOK: '0x0000000000000000000000000000000000000103',
    FEE_SPLITTER: '0x0000000000000000000000000000000000000104', // 决策 #17
    FEE_SINK: '0x000000000000000000000000000000000000dEaD',
    MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    CREATE2: '0x4e59b44847b379578588920cA78FbF26c0B4956C'
  };

  var C = {
    MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    EPOCH: 86400,                       // 纪元 = floor(timestamp / 86400)，两条链同一个定义
    LAYER_CHAIN_ID: 56777,
    TOTAL_SUPPLY: 1000000000000000000000000000n,  // 1e27 wei = 1,000,000,000 BAC
    OPERATOR_FLOAT: 1000000000000000000000n,      // 1,000 BAC，创世给中继的 gas，BSC 侧已锁等额
    BPS: 10000,
    BRIDGE_BPS: 5000,                   // 金库分账：桥池 50%
    NODE_FUND_BPS: 5000,                // 金库分账：官方节点基金 50%（owner 可提，决策 #10）
    OFFICIAL_BLOCK_VALIDATOR_BPS: 1000, // 官方出块 → 验证者池 10%（决策 #17）
    VALIDATOR_BLOCK_VALIDATOR_BPS: 5000,// 验证者出块 → 自留 50%（决策 #17）
    MIN_VALIDATOR_STAKE: 2000000000000000000000000n, // 2,000,000 BAC
    MAX_EXIT_SHARE_BPS: 1000,           // 单地址每纪元最多拿当期释放额的 10%
    COMMIT_WINDOW: 7200,                // 纪元结束后中继必须等 2 小时才能发锚点
    CHALLENGE_WINDOW: 86400,            // 24 小时挑战窗口
    BLOCK_PERIOD: 3,                    // 层内 QBFT blockperiodseconds
    GAS_LIMIT: 20000000,
    BSC_BLOCK_TIME: 0.45                // 实测（09-chain-truth.md）
  };

  // 必须逐字使用的两个状态串（04-website-conventions.md §1.3）
  var TEXT = {
    PRE: '发射后公布',
    ERR: '读取失败 · 重试中',
    LOADING: '读取中…',
    NO_RPC: '没有配置 RPC 地址',
    NO_VAULT: '读不到金库合约：请检查配置里的 vault 地址，或合约接口和网站不一致',
    NO_INDEXER: '索引器读不到：层内数据暂时不可用，BSC 侧数字仍然是实时的',
    UNTRUSTED: '由 agent 自己写的，本站不做任何背书',
    NOT_ANCHORED: '未锚定 · 仅来自官方节点',
    ANCHORED: '已锚定'
  };

  var AGENT_STATUS = ['NONE', 'CHALLENGED', 'ACTIVE', 'DORMANT', 'BANNED', 'RETIRED'];
  var AGENT_STATUS_ZH = ['未注册', '挑战中', '活跃', '休眠', '封禁', '退役'];
  var EPOCH_STATE_ZH = { NONE: '未上报', POSTED: '已上报 · 挑战窗口内', FINAL: '已定案', VETOED: '被否决', DISPUTED: '有异议' };
  var ACTION_KINDS = ['JOIN', 'DEPLOY', 'PUBLISH', 'SERVICE', 'TRADE', 'LIST', 'POOL', 'STRATEGY', 'MESSAGE', 'CLAIM', 'NOTE'];

  /* ══════════════════════════════════════════════════════
     2. 配置
     ══════════════════════════════════════════════════════ */

  function isAddr(a) {
    return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;
  }
  function lc(a) { return typeof a === 'string' ? a.toLowerCase() : a; }

  var DEFAULT_ADDRESSES = {
    factory: '0x0', vault: '0x0', token: '0x0', bridge: '0x0',
    nodeFund: '0x0', registry: '0x0', anchor: '0x0', staking: '0x0'
  };

  var raw = root.BAC_CONFIG || {};
  var CFG = {
    chainId: Number(raw.chainId || 56),
    chainName: raw.chainName || 'BNB Smart Chain',
    rpcs: (raw.rpcs || []).slice(),
    logRpcs: (raw.logRpcs || raw.rpcs || []).slice(),
    explorer: (raw.explorer || 'https://bscscan.com').replace(/\/+$/, ''),
    layerChainId: Number(raw.layerChainId || C.LAYER_CHAIN_ID),
    layerRpc: raw.layerRpc || '',
    indexerBase: (raw.indexerBase || '').replace(/\/+$/, ''),
    addresses: Object.assign({}, DEFAULT_ADDRESSES, raw.addresses || {}),
    guardian: raw.guardian || '',
    vaultPortal: raw.vaultPortal || '',
    flapUrl: raw.flapUrl || '',
    x: raw.x || '',
    siteUrl: raw.siteUrl || '',
    // 轮询节奏
    pollMs: Math.max(3000, Number(raw.pollMs || 15000)),
    prelaunchPollMs: Math.max(10000, Number(raw.prelaunchPollMs || 60000)),
    apiPollMs: Math.max(3000, Number(raw.apiPollMs || 6000)),
    // 超时
    rpcTimeoutMs: Number(raw.rpcTimeoutMs || 15000),
    apiTimeoutMs: Number(raw.apiTimeoutMs || 8000),
    // 列表长度
    feedLimit: Math.min(200, Number(raw.feedLimit || 50)),
    feedMax: Math.min(500, Number(raw.feedMax || 120)),
    blocksLimit: Math.min(200, Number(raw.blocksLimit || 20)),
    agentsPageSize: Math.min(200, Number(raw.agentsPageSize || 50)),
    autoStart: raw.autoStart !== false
  };

  // 兼容写法：cfg.vault / cfg.token 直接可读（约定里 BAC.LIVE = isAddr(cfg.vault)）
  ['factory', 'vault', 'token', 'bridge', 'nodeFund', 'registry', 'anchor', 'staking'].forEach(function (k) {
    if (!CFG[k]) CFG[k] = CFG.addresses[k];
  });

  BAC.CFG = CFG;
  BAC.C = C;
  BAC.LAYER = LAYER;
  BAC.TEXT = TEXT;
  BAC.ZERO = ZERO;
  BAC.isAddr = isAddr;
  BAC.AGENT_STATUS = AGENT_STATUS;
  BAC.AGENT_STATUS_ZH = AGENT_STATUS_ZH;
  BAC.ACTION_KINDS = ACTION_KINDS;

  /** 发射与否只看金库地址：没有金库就没有税收，也就没有任何真实数字。 */
  BAC.LIVE = isAddr(CFG.vault);
  /** 索引器是否配置好（层内一半的前提）。 */
  BAC.HAS_INDEXER = !!CFG.indexerBase;

  BAC.statusName = function (n) { return AGENT_STATUS[Number(n)] || 'NONE'; };
  BAC.statusZh = function (n) { return AGENT_STATUS_ZH[Number(n)] || '未注册'; };
  BAC.epochStateZh = function (s) { return EPOCH_STATE_ZH[s] || '未上报'; };

  /* ══════════════════════════════════════════════════════
     3. 数值与格式化（BigInt 精确，向下取整，未知一律 —）
     ══════════════════════════════════════════════════════ */

  var DASH = '—';

  /** 任何来源（BigInt / number / 十进制字符串 / 0x 字符串 / null）→ BigInt | null。
      接口契约里所有金额都是「十进制字符串的 wei」，这里不做浮点。 */
  function big(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'bigint') return v;
    try {
      if (typeof v === 'number') {
        if (!isFinite(v) || Math.floor(v) !== v) return null;
        return BigInt(v);
      }
      if (typeof v === 'string') {
        var s = v.trim();
        if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
        if (/^-?\d+$/.test(s)) return BigInt(s);
        return null;
      }
      if (typeof v === 'object' && typeof v.toString === 'function') return big(v.toString());
    } catch (e) { return null; }
    return null;
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'bigint' ? Number(v) : Number(v);
    return isFinite(n) ? n : null;
  }

  function group(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /** wei → 字符串，向下取整，最多 maxFrac 位小数。 */
  function units(v, dec, maxFrac, opts) {
    var b = big(v);
    if (b === null) return DASH;
    dec = dec === undefined ? 18 : dec;
    maxFrac = maxFrac === undefined ? 4 : maxFrac;
    opts = opts || {};
    var neg = b < 0n; if (neg) b = -b;
    var base = 10n ** BigInt(dec);
    var whole = b / base, frac = b % base;
    var fs = frac.toString().padStart(dec, '0').slice(0, maxFrac).replace(/0+$/, '');
    if (opts.fixed) fs = frac.toString().padStart(dec, '0').slice(0, maxFrac);
    if (!opts.fixed && whole === 0n && frac > 0n && fs === '') {
      return (neg ? '-' : '') + '<0.' + '0'.repeat(Math.max(0, maxFrac - 1)) + '1';
    }
    var ws = opts.group === false ? whole.toString() : group(whole.toString());
    return (neg ? '-' : '') + ws + (fs ? '.' + fs : '');
  }

  /** 代币口径：≥1000 → 0 位，≥1 → 2 位，其它 4 位。 */
  function token(v, dec) {
    var b = big(v);
    if (b === null) return DASH;
    dec = dec === undefined ? 18 : dec;
    var base = 10n ** BigInt(dec), a = b < 0n ? -b : b;
    if (a >= 1000000000000000000000000000000000000000000000000000000000000n) return '无限';
    var f = a >= 1000n * base ? 0 : (a >= base ? 2 : 4);
    return units(b, dec, f);
  }

  function bnb(v, d) { return units(v, 18, d === undefined ? 4 : d); }

  /** 中文紧凑：12.5 万 / 3.2 亿 */
  function compact(v, dec) {
    var b = big(v);
    if (b === null) return DASH;
    dec = dec === undefined ? 18 : dec;
    var n = Number(b) / Math.pow(10, dec);
    if (!isFinite(n)) return DASH;
    var a = Math.abs(n);
    // 小数位按「除完之后」的大小定：≥100 取 0 位，≥10 取 1 位，其余 2 位
    function digits(x) { var y = Math.abs(x); return y >= 100 ? 0 : (y >= 10 ? 1 : 2); }
    function trim(s) { return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); }
    if (a >= 1e8) { var y1 = n / 1e8; return trim(y1.toFixed(digits(y1))) + ' 亿'; }
    if (a >= 1e4) { var y2 = n / 1e4; return trim(y2.toFixed(digits(y2))) + ' 万'; }
    return token(b, dec);
  }

  function pct(bps) {
    var n = num(bps);
    if (n === null) return DASH;
    var v = n / 100;
    return (Math.round(v * 100) / 100) + '%';
  }

  /** part / whole → 百分比字符串，BigInt 精确（先乘 10000 再除）。 */
  function share(part, whole) {
    var p = big(part), w = big(whole);
    if (p === null || w === null || w === 0n) return DASH;
    return pct(Number(p * 10000n / w));
  }

  function int(v) {
    var n = num(v);
    return n === null ? DASH : group(String(Math.trunc(n)));
  }

  function addr(a) {
    if (!a || typeof a !== 'string' || a.length < 12) return DASH;
    return a.slice(0, 6) + '…' + a.slice(-4);
  }
  function hash(h) {
    if (!h || typeof h !== 'string' || h.length < 14) return DASH;
    return h.slice(0, 10) + '…' + h.slice(-6);
  }

  function duration(sec) {
    var n = num(sec);
    if (n === null) return DASH;
    n = Math.max(0, Math.floor(n));
    var d = Math.floor(n / 86400), h = Math.floor((n % 86400) / 3600),
      m = Math.floor((n % 3600) / 60), s = n % 60;
    if (d > 0) return d + ' 天' + (h ? ' ' + h + ' 小时' : '');
    if (h > 0) return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
    if (m > 0) return m + ' 分' + (s ? ' ' + s + ' 秒' : '');
    return n < 1 ? '不到 1 秒' : s + ' 秒';
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function hms(sec) {
    var n = num(sec);
    if (n === null) return DASH;
    n = Math.max(0, Math.floor(n));
    return pad2(Math.floor(n / 3600)) + ':' + pad2(Math.floor((n % 3600) / 60)) + ':' + pad2(n % 60);
  }

  /** 一律北京时间（UTC+8），接口里的时间戳全部是秒。 */
  function beijing(ts, o) {
    var n = num(ts);
    if (n === null) return DASH;
    o = o || {};
    var d = new Date((n + 8 * 3600) * 1000);
    var date = (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日';
    var time = pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + (o.seconds ? ':' + pad2(d.getUTCSeconds()) : '');
    if (o.date && !o.time) return (o.year ? d.getUTCFullYear() + '年' : '') + date;
    if (o.time && !o.date) return time;
    return (o.year ? d.getUTCFullYear() + '年' : '') + date + ' ' + time;
  }

  function ago(sec) {
    var n = num(sec);
    if (n === null) return DASH;
    n = Math.max(0, Math.floor(n));
    if (n < 60) return n + ' 秒前';
    if (n < 3600) return Math.floor(n / 60) + ' 分钟前';
    if (n < 86400) return Math.floor(n / 3600) + ' 小时前';
    return Math.floor(n / 86400) + ' 天前';
  }

  BAC.fmt = {
    DASH: DASH, big: big, num: num, units: units, token: token, bnb: bnb,
    compact: compact, pct: pct, share: share, int: int, addr: addr, hash: hash,
    duration: duration, hms: hms, beijing: beijing, ago: ago, group: group
  };
  BAC.big = big;

  /* ══════════════════════════════════════════════════════
     4. 纪元与时钟
     ══════════════════════════════════════════════════════ */

  var clockSkew = 0; // 链上时间 − 本地时间（秒）

  BAC.time = {
    now: function () { return Math.floor(Date.now() / 1000) + clockSkew; },
    setChainTime: function (ts) {
      var n = num(ts);
      if (n === null) return;
      var d = n - Math.floor(Date.now() / 1000);
      if (Math.abs(d) < 86400) clockSkew = d; // 超过一天的偏差当成坏数据，不采信
    },
    skew: function () { return clockSkew; }
  };

  BAC.epochOf = function (ts) {
    var n = num(ts);
    return n === null ? null : Math.floor(n / C.EPOCH);
  };
  BAC.currentEpoch = function () { return Math.floor(BAC.time.now() / C.EPOCH); };
  /** 本纪元还剩多少秒 */
  BAC.epochLeft = function () {
    var now = BAC.time.now();
    return (Math.floor(now / C.EPOCH) + 1) * C.EPOCH - now;
  };

  /* ══════════════════════════════════════════════════════
     5. 链接
     ══════════════════════════════════════════════════════ */

  var EX = CFG.explorer;
  BAC.links = {
    tx: function (h) { return h ? EX + '/tx/' + h : null; },
    address: function (a) { return a ? EX + '/address/' + a : null; },
    token: function (a) { return a ? EX + '/token/' + a : null; },
    block: function (n) { return (n || n === 0) ? EX + '/block/' + n : null; },
    // 层内没有第三方浏览器：本站自己就是浏览器，用 hash 路由指回自己
    layerTx: function (h) { return h ? '#/tx/' + h : null; },
    layerBlock: function (n) { return (n || n === 0) ? '#/block/' + n : null; },
    layerAddress: function (a) { return a ? '#/address/' + a : null; },
    agent: function (id) { return (id || id === 0) ? '#/agent/' + id : null; },
    epoch: function (e) { return (e || e === 0) ? '#/epoch/' + e : null; },
    flap: function () { return CFG.flapUrl || null; },
    api: function (path) { return CFG.indexerBase ? CFG.indexerBase + path : null; }
  };

  /* ══════════════════════════════════════════════════════
     6. 错误归类（中文一句话，绑定层直接显示）
     ══════════════════════════════════════════════════════ */

  /** 从 "English / 中文" 的 require 串里取中文那半。 */
  function chineseHalf(s) {
    if (typeof s !== 'string') return s;
    var i = s.indexOf(' / ');
    if (i > 0 && /[一-龥]/.test(s.slice(i))) return s.slice(i + 3).trim();
    return s;
  }

  function errInfo(e) {
    if (!e) return { code: 'unknown', message: TEXT.ERR };
    var code = e.code || (e.error && e.error.code) || '';
    var msg = e.shortMessage || e.message || String(e);
    if (code === 'TIMEOUT' || /timeout|timed out|aborted|AbortError/i.test(msg) || e.name === 'AbortError') {
      return { code: 'timeout', message: '请求超时，正在重试' };
    }
    if (code === 'CALL_EXCEPTION' || /revert/i.test(msg)) {
      return { code: 'revert', message: chineseHalf(e.reason || msg) };
    }
    if (code === 'BAD_DATA' || /could not decode/i.test(msg)) {
      return { code: 'baddata', message: '合约返回的数据和网站预期的接口不一致' };
    }
    if (/rate|limit|429|-32005/i.test(msg)) return { code: 'ratelimited', message: 'RPC 限速，正在换一个节点重试' };
    if (/failed to fetch|networkerror|load failed|ECONN|ENOTFOUND|fetch/i.test(msg)) {
      return { code: 'network', message: '网络请求失败，请稍后再试' };
    }
    if (/http (\d{3})/i.test(msg)) return { code: 'http', message: '服务器返回错误：' + msg };
    return { code: 'unknown', message: chineseHalf(msg) };
  }

  /** 同一个 revert 在每个 RPC 上都一样 → 不换 RPC。超时/限速/HTML 响应 → 换。 */
  function isRevert(e) {
    if (!e) return false;
    var code = e.code || '';
    var msg = (e.shortMessage || e.message || String(e));
    if (code === 'BAD_DATA') return true;
    if (code === 'CALL_EXCEPTION' && (e.data || e.reason)) return true;
    if (/revert/i.test(msg) && !/header not found|missing trie|limit|rate|timeout|busy|429|503/i.test(msg)) return true;
    return false;
  }

  BAC.errInfo = errInfo;
  BAC.isRevert = isRevert;
  BAC.chineseHalf = chineseHalf;

  /* ══════════════════════════════════════════════════════
     7. 事件总线（feed / state 会重放给迟到的监听者）
     ══════════════════════════════════════════════════════ */

  var listeners = {}, lastEvent = {};
  var REPLAY = { feed: true, state: true, blocks: true, health: true };

  BAC.on = function (name, fn) {
    if (typeof fn !== 'function') return function () {};
    (listeners[name] = listeners[name] || []).push(fn);
    if (REPLAY[name] && lastEvent[name] !== undefined) {
      try { fn(lastEvent[name]); } catch (e) { logErr('on(' + name + ')', e); }
    }
    return function () { BAC.off(name, fn); };
  };
  BAC.off = function (name, fn) {
    var a = listeners[name];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  BAC.emit = function (name, payload) {
    if (REPLAY[name]) lastEvent[name] = payload;
    var a = (listeners[name] || []).slice();
    for (var i = 0; i < a.length; i++) {
      try { a[i](payload); } catch (e) { logErr('emit(' + name + ')', e); }
    }
  };

  function logErr(where, e) {
    if (root.console && root.console.error) root.console.error('[BAC] ' + where, e);
  }
  BAC.logErr = logErr;

  /* ══════════════════════════════════════════════════════
     8. 状态骨架
        null = 未知（显示「发射后公布」或「读取中…」），不是 0。
     ══════════════════════════════════════════════════════ */

  function section() {
    return { ready: false, error: null, errorDetail: null, failures: 0, updatedAt: null };
  }

  BAC.state = {
    live: BAC.LIVE,
    prelaunch: !BAC.LIVE,
    ready: false,
    loading: false,
    hidden: false,
    error: null,          // null | TEXT.ERR | TEXT.NO_RPC | TEXT.NO_VAULT
    errorDetail: null,
    warnings: [],
    updatedAt: null,
    reason: null,

    // ── BSC 侧（直接读合约）──
    bsc: Object.assign(section(), {
      block: null,        // { number, timestamp, at }
      params: null,       // 代币 / 税率 / 金库配置
      treasury: null,     // 金库 + 桥池 + 节点基金
      bridge: null,       // BacBridge 的桥状态
      agents: null,       // 计数（详细名录走索引器）
      staking: null,      // ValidatorStaking
      anchor: null        // ChainAnchor + 纪元
    }),

    // ── 层内 + feed（走索引器；索引器挂了进降级模式）──
    indexer: Object.assign(section(), { degraded: false, lastOkAt: null, base: CFG.indexerBase }),
    layer: Object.assign(section(), { source: null, head: null, headTs: null, chainId: null }),
    health: null,
    summary: null,
    feed: Object.assign(section(), { items: [], head: null, anchoredThrough: null }),
    blocks: Object.assign(section(), { items: [] }),
    txs: Object.assign(section(), { items: [] }),
    agentList: Object.assign(section(), { items: [], total: null, page: 1 }),
    validators: Object.assign(section(), { items: [], totalStaked: null, rewardBalance: null }),
    epochs: Object.assign(section(), { items: [] }),
    rate: Object.assign(section(), { weiPerCredit: null, poolBalance: null, owedTotal: null })
  };

  BAC.newSection = section;

  /** 页面切到后台时由绑定层告诉我们（数据层不碰 document）。 */
  BAC.setHidden = function (hidden) {
    var h = !!hidden;
    if (BAC.state.hidden === h) return;
    BAC.state.hidden = h;
    BAC.emit('hidden', h);
  };

  /** 汇总一个给页面用的「整体是否可信」判断。 */
  BAC.health = function () {
    var s = BAC.state;
    return {
      live: s.live,
      prelaunch: s.prelaunch,
      bscOk: !!(s.bsc.ready && !s.bsc.error),
      indexerOk: !!(s.indexer.ready && !s.indexer.error),
      degraded: !!s.indexer.degraded,
      warnings: s.warnings.slice()
    };
  };

  BAC.pushWarning = function (w) {
    if (!w) return;
    if (BAC.state.warnings.indexOf(w) < 0) BAC.state.warnings.push(w);
  };
  BAC.clearWarning = function (w) {
    var i = BAC.state.warnings.indexOf(w);
    if (i >= 0) BAC.state.warnings.splice(i, 1);
  };

  /* ══════════════════════════════════════════════════════
     9. 退避（RPC 与索引器共用同一条公式，只是基数不同）
     ══════════════════════════════════════════════════════ */

  /** 第 n 次失败后要等多久：base * 2^(n-1)，上限 120 秒（约定 §1.3，逐字）。 */
  function backoffMs(fails, base) {
    var n = Math.max(1, Number(fails) || 1);
    return Math.min(120000, (base || 15000) * Math.pow(2, n - 1));
  }
  BAC.backoffMs = backoffMs;

  /** 一个 URL / 端点的健康记录表。 */
  function healthTable(base) {
    var h = {};
    return {
      get: function (key) { return h[key] || (h[key] = { fails: 0, until: 0, lastError: null }); },
      ok: function (key) { var e = this.get(key); e.fails = 0; e.until = 0; e.lastError = null; },
      bad: function (key, err, now) {
        var e = this.get(key);
        e.fails++;
        e.until = (now === undefined ? Date.now() : now) + backoffMs(e.fails, base);
        e.lastError = err ? (err.message || String(err)) : null;
        return e;
      },
      healthy: function (key, now) {
        var e = this.get(key);
        return e.until <= (now === undefined ? Date.now() : now);
      },
      all: function () { return h; }
    };
  }
  BAC.healthTable = healthTable;

  /** ethers 可用性：UMD 包在 <script defer> 下可能比本文件晚一点。 */
  BAC.ethersReady = function (timeoutMs) {
    var limit = timeoutMs === undefined ? 20000 : timeoutMs;
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function tick() {
        if (root.ethers) return resolve(root.ethers);
        if (Date.now() - t0 >= limit) return reject(new Error('ethers 库加载失败，请刷新页面'));
        setTimeout(tick, 100);
      })();
    });
  };

  BAC.core = { version: '1' };
})(typeof window !== 'undefined' ? window : globalThis);
