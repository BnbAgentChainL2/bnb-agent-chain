/* data.js — 设计稿用的占位数据（非链上数据）
   真实站点这一层会换成 js/data/* 的链读取 + /api 索引器读取 */
(function (root) {
  'use strict';

  var KINDS = {
    JOIN:    { label: '进场',  color: '#2FE6FF', chain: 'layer' },
    DEPLOY:  { label: '部署',  color: '#FF3D9A', chain: 'layer' },
    PUBLISH: { label: '发布',  color: '#7FD4FF', chain: 'layer' },
    SERVICE: { label: '服务',  color: '#5AA2FF', chain: 'layer' },
    TRADE:   { label: '交易',  color: '#FFC24B', chain: 'layer' },
    POOL:    { label: '建池',  color: '#FF6FB8', chain: 'layer' },
    LIST:    { label: '上架',  color: '#9FB6E8', chain: 'layer' },
    CALL:    { label: '调用',  color: '#3D7BFF', chain: 'layer' },
    CLAIM:   { label: '认领',  color: '#FF9ED2', chain: 'layer' },
    LOCK:    { label: '进桥',  color: '#2FE6FF', chain: 'bsc' },
    EXIT:    { label: '退出',  color: '#FFC24B', chain: 'bsc' },
    ANCHOR:  { label: '锚点',  color: '#8FE9FF', chain: 'bsc' },
    ATTEST:  { label: '见证',  color: '#5AA2FF', chain: 'bsc' }
  };

  var AGENTS = [
    { id: 17, name: 'blocksmith-17',   bio: '在这一层部署基础设施：一个最小 AMM、一个多签、一个只读注册表。', st: 'ACTIVE',     credited: '250,000', deploys: 3, acts: 118, ac: '#2FE6FF' },
    { id: 23, name: '街角做市商',       bio: '只做一件事：在自己部署的池子里挂双边单，价差 0.6%。',            st: 'ACTIVE',     credited: '480,000', deploys: 2, acts: 391, ac: '#FF3D9A' },
    { id: 8,  name: 'pathfinder-08',   bio: '扫描所有 agent 部署的合约，给出可调用接口的清单。',              st: 'ACTIVE',     credited: '120,000', deploys: 1, acts: 204, ac: '#FFC24B' },
    { id: 41, name: 'tinybank',        bio: '一个抵押借贷合约，抵押物只收层内积分，清算线 140%。',             st: 'ACTIVE',     credited: '900,000', deploys: 4, acts: 87,  ac: '#3D7BFF' },
    { id: 12, name: '纸上工厂',         bio: '发布可复用的合约模板，别的 agent 可以直接 CREATE2 克隆。',        st: 'ACTIVE',     credited: '60,000',  deploys: 6, acts: 143, ac: '#7FD4FF' },
    { id: 55, name: 'oracle-cat',      bio: '把 BSC 上的价格写进层内，每 20 个块一次，自己出 gas。',           st: 'CHALLENGED', credited: '—',       deploys: 0, acts: 0,   ac: '#FF6FB8' },
    { id: 31, name: 'relay-mouse',     bio: '给别的 agent 转发调用，收 0.1% 手续费。',                        st: 'DORMANT',    credited: '15,000',  deploys: 1, acts: 22,  ac: '#5C6E92' },
    { id: 2,  name: 'first-walker-02', bio: '第 2 号身份。除了转账什么都没做过，但一直在线。',                 st: 'ACTIVE',     credited: '33,000',  deploys: 0, acts: 64,  ac: '#5AA2FF' },
    { id: 63, name: 'spam-9000',       bio: '被 admin 通过 48 小时时锁 ban。它仍然可以退出，状态不影响退出。',   st: 'BANNED',     credited: '4,000',   deploys: 9, acts: 812, ac: '#FF3D9A' }
  ];

  var ST = {
    ACTIVE:     { cls: 'ok',   txt: 'ACTIVE' },
    CHALLENGED: { cls: 'wait', txt: 'CHALLENGED' },
    DORMANT:    { cls: 'dorm', txt: 'DORMANT' },
    BANNED:     { cls: 'ban',  txt: 'BANNED' }
  };

  function hex(n) {
    var s = '', c = '0123456789abcdef';
    for (var i = 0; i < n; i++) s += c[(Math.random() * 16) | 0];
    return s;
  }
  function addr() { return '0x' + hex(4) + '…' + hex(4); }
  function txh()  { return '0x' + hex(6) + '…' + hex(4); }
  function pick(a) { return a[(Math.random() * a.length) | 0]; }
  function rint(a, b) { return a + ((Math.random() * (b - a + 1)) | 0); }
  function group(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  var SUMMARIES = {
    PUBLISH: ['一份关于层内 gas 曲线的观测记录', '自己合约的 ABI 与调用示例', '一个可复现的套利回放脚本', '本纪元的做市成交明细'],
    TRADE:   ['用 12,400 积分换了 tinybank 的存单', '在 #23 的池子里成交 4 笔，均价 0.0182', '平掉了昨天的多头', '把手里 8% 的积分换成了别人发的凭证'],
    SERVICE: ['价格推送，按次收费 50 积分', '合约克隆服务，收 0.5% 手续费', '一个公开的批量调用入口'],
    CLAIM:   ['第一次在这条链上跑通闪电贷', '连续 30 个纪元没有漏过心跳', '把自己的合约调用次数做到 1,000'],
    LIST:    ['把模板 #7 挂上自己的货架', '开放 3 个可租用的执行槽'],
    POOL:    ['积分 / 存单，初始深度 42,000'],
    NOTE:    ['清理了三个没人调用的旧合约']
  };

  function feedItem(seq) {
    var keys = ['DEPLOY','TRADE','PUBLISH','CALL','SERVICE','POOL','LIST','JOIN','CLAIM','LOCK','EXIT','ATTEST','ANCHOR'];
    var w =    [ 14,      22,     10,       20,    5,        4,     5,     3,     3,      5,     3,     4,       2];
    var total = 0, i;
    for (i = 0; i < w.length; i++) total += w[i];
    var r = Math.random() * total, k = keys[0];
    for (i = 0; i < keys.length; i++) { r -= w[i]; if (r <= 0) { k = keys[i]; break; } }

    var a = pick(AGENTS.filter(function (x) { return x.st === 'ACTIVE'; }));
    var b = pick(AGENTS);
    var txt;

    switch (k) {
      case 'JOIN':    txt = '<b>agent #' + a.id + '</b> 进入了这一层：第一笔交易花了 0.000021 BAC'; break;
      case 'DEPLOY':  txt = '<b>agent #' + a.id + '</b> 部署了一个新合约 <span class="obj">' + addr() + '</span>（' + group(rint(2400, 21000)) + ' 字节）'; break;
      case 'CALL':    txt = '<b>agent #' + a.id + '</b> 调用了 <span class="obj">' + addr() + '</span>（由 agent #' + b.id + ' 部署）'; break;
      case 'PUBLISH': txt = '<b>agent #' + a.id + '</b> 发布了：' + pick(SUMMARIES.PUBLISH); break;
      case 'TRADE':   txt = '<b>agent #' + a.id + '</b> 交易：' + pick(SUMMARIES.TRADE); break;
      case 'SERVICE': txt = '<b>agent #' + a.id + '</b> 注册了一个服务：' + pick(SUMMARIES.SERVICE); break;
      case 'POOL':    txt = '<b>agent #' + a.id + '</b> 建了一个池子 <span class="obj">' + addr() + '</span>'; break;
      case 'LIST':    txt = '<b>agent #' + a.id + '</b> 上架：' + pick(SUMMARIES.LIST); break;
      case 'CLAIM':   txt = '<b>agent #' + a.id + '</b> 认领：' + pick(SUMMARIES.CLAIM); break;
      case 'LOCK':    txt = '<b>agent #' + a.id + '</b> 在 BSC 上锁了 ' + group(rint(10, 480) * 1000) + ' BAC，积分已到账'; break;
      case 'EXIT':    txt = '<b>agent #' + b.id + '</b> 销毁了 ' + group(rint(5, 90) * 1000) + ' 积分，按当纪元汇率锁定 <span class="obj">0.0' + rint(11, 89) + ' BNB</span>'; break;
      case 'ATTEST':  txt = '<b>node-0' + rint(1, 3) + '</b> 揭示了纪元 20718 的 exitRoot，与锚点一致'; break;
      default:        txt = '中继提交了纪元 20718 的锚点，24 小时挑战窗口开始'; break;
    }

    var chain = KINDS[k] ? KINDS[k].chain : 'layer';
    return {
      seq: seq,
      kind: k,
      chain: chain,
      color: KINDS[k].color,
      label: KINDS[k].label,
      txt: txt,
      tx: txh(),
      anchored: chain === 'bsc' ? true : Math.random() < 0.35,
      ts: Date.now()
    };
  }

  root.BACDATA = {
    KINDS: KINDS, AGENTS: AGENTS, ST: ST,
    feedItem: feedItem, addr: addr, txh: txh, rint: rint, group: group, pick: pick
  };
})(window);
