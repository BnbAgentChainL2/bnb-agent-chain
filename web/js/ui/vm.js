/* BNB Agent Chain · 可视层 · 视图模型（唯一的数据出口）
   ─────────────────────────────────────────────────────────────
   页面上**每一个**数字都从这里读，只有两个人写它：
     js/ui/bind.js       —— 把 window.BAC（数据层）的真实读数搬进来；
     js/ui/demo-data.js  —— 只有在「没有配置合约地址 且 URL 带 ?demo=1」时才被调用，
                            用来给人看设计稿，绝不会出现在正式站点上。
   约定（04-website-conventions.md §1.3）：
     - 金额一律 BigInt（wei）；时间戳一律**秒**；未知一律 null，**null ≠ 0**；
     - 每一段自带 status：'pre' 发射前 / 'loading' 读取中 / 'error' 读取失败 / 'ok' 有真实数据；
     - 渲染时 status 决定占位文字：发射后公布 / 读取中… / 读取失败 · 重试中。 */
(function (root) {
  'use strict';

  if (root.BACVM) return;

  function empty() {
    return {
      /* 'pre' | 'demo' | 'live' —— 只影响「能不能显示这些数字」的判断，不影响排版 */
      mode: 'pre',
      /* 每一段的状态，渲染器照它选占位文案 */
      st: {
        chain: 'pre', blocks: 'pre', txs: 'pre', agents: 'pre', epochs: 'pre',
        validators: 'pre', treasury: 'pre', bridge: 'pre', feed: 'pre',
        contracts: 'pre', fees: 'pre', daily: 'pre'
      },

      /* ── 链指标（顶部状态条 / 状态栏 / 概览）────────────────── */
      chain: {
        chainId: 56777, source: null, degraded: false, degradedNote: null,
        head: null, headTs: null, blockLagSec: null,
        blockTimeSec: null, targetBlockTimeSec: 3,
        gasLimit: null, baseFee: null, minGasPriceGwei: 1,
        peers: null, txPool: null,
        txTotal: null, contractsTotal: null,
        circulating: null, burnedTotal: null, totalSupply: null,
        epoch: null, epochLeftSec: null, lastPostedEpoch: null, lastFinalEpoch: null,
        tps: null, tx24h: null, blocks24h: null,
        agentCounts: null,          // {total,active,dormant,banned,challenged,retired}
        nodeCount: null, nodeSlots: 64, totalStaked: null,
        bridgePool: null
      },

      /* ── 决策 #17：gas 费归集对账（已收 / 已转入 / 差额）──────── */
      fees: {
        received: null, remitted: null, gap: null,
        anchoredThrough: null, howToCheck: [],
        officialValidatorBps: 1000, validatorSelfBps: 5000,
        splitterBalance: null, poolPending: null, poolRemainder: null,
        lifetimePool: null, lifetimePoolClaimed: null,
        lifetimeFoundationAccrued: null, lifetimeValidatorSelfKept: null,
        epochPool: null
      },

      /* ── 列表 ────────────────────────────────────────────── */
      blocks: [], blockByNum: {},
      txs: [], txByHash: {},
      agents: [], agentById: {},
      contracts: [], contractMap: {}, contractAddrs: [],
      epochs: [], epochByN: {},
      feed: [],

      validators: {
        items: [], nodeCount: null, slots: 64, totalStaked: null,
        rewardBalance: null, epochPot: null, lifetimeFunded: null, lifetimePaid: null,
        minStake: null, agreeingCount: null, memberCount: null, releaseBps: null
      },

      treasury: {
        bridgeBps: 5000, nodeFundBps: 5000, taxFeeRateBps: null,
        lifetimeTotal: null, toBridge: null, toNodeFund: null,
        vaultBalance: null, vaultUnsplit: null, stuckBridge: null, stuckNodeFund: null,
        poolBalance: null, nodeFundBalance: null, nodeFundWithdrawn: null,
        releaseBps: null, releasable: null, owedTotal: null,
        disclosure: null, splitBaseNote: null,
        events: [], eventsStatus: 'pre'
      },

      bridge: {
        totalLocked: null, totalIssued: null, totalExited: null,
        creditsOutstanding: null, poolBalance: null, owedTotal: null,
        weiPerCredit: null, lastPot: null, releaseBps: null,
        paused: null, halted: null
      },

      /* 30 日序列：索引器目前没有日聚合端点，正式站点一律为 null（见 README / 报告） */
      daily: null,

      /* 地址簿（全部来自 site.config.js / 创世常量，不是链上读数） */
      addresses: {},
      layerAddresses: {},
      links: { explorer: '', flapUrl: '', x: '', siteUrl: '' },

      /* 详情页缓存：bind.js 按需填，渲染器只读 */
      detail: { block: null, tx: null, agent: null, epoch: null, contract: null },

      updatedAt: null,
      warnings: []
    };
  }

  var VM = empty();
  VM.empty = empty;
  /** 换数据源（发射前 ↔ demo）时整体重置，避免两套数据混在一起。 */
  VM.reset = function () {
    var fresh = empty();
    Object.keys(fresh).forEach(function (k) { VM[k] = fresh[k]; });
    return VM;
  };
  root.BACVM = VM;
})(typeof window !== 'undefined' ? window : globalThis);
