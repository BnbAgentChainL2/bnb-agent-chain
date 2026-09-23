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
      /* 'pre' | 'demo' | 'live' —— 只影响「能不能显示这些数字」的判断，不影响排版。
         注意：层内那条链**现在就在出块**，所以只要层内 RPC 答话就是 'live'，
         哪怕 BSC 侧的代币还没发射。两者完全独立。 */
      mode: 'pre',
      /* 现在出块的是不是**演练链**（HANDOFF §2）：创世预置了测试用 BAC、桥里是 0，
         发射时用新创世重建，数据全部清空。BSC 侧合约地址没配（BAC.LIVE === false）就一定是演练链；
         bind.js 负责写它，外壳横幅照它如实披露。 */
      rehearsal: true,
      /* 每一段的状态，渲染器照它选占位文案。
         'pre'   发射后公布（BSC 侧那些还不存在的合约）
         'loading' 读取中…  'error' 读取失败 · 重试中  'ok' 有真实数据
         'noidx' 这一项只有索引器算得出，索引器现在读不到 → 显示「—」，来源写在面板小标上
         索引器相关的几段初值是 'loading'：第一轮应答回来之前不知道它在不在，不许先说它读不到。 */
      st: {
        chain: 'loading', blocks: 'loading', txs: 'loading', agents: 'pre', epochs: 'pre',
        validators: 'pre', treasury: 'pre', bridge: 'pre', feed: 'pre',
        contracts: 'loading', fees: 'pre', daily: 'loading', idx: 'loading', layer: 'loading',
        /* agent 造出来的东西（代币 / 交易对 / 成交）：只有索引器解得出来 */
        built: 'loading'
      },

      /* ── 层内直读的来源信息（面板小标上如实写清楚数字是谁给的）───── */
      layer: {
        live: false,
        source: null,          // 'indexer' | 'rpc' | null
        endpoint: null,        // 现在实际在用的那个地址（索引器供数时是索引器的根地址）
        rpc: null,             // 配置里的公开 RPC：给人自己核对用的就是它
        primary: null,         // 用的是主域名还是兜底 IP
        note: null,            // 降级说明（索引器读不到时的那一句）
        stale: false,
        sections: null         // {head, blocks, txs}
      },

      /* ── 链指标（顶部状态条 / 状态栏 / 概览）────────────────── */
      chain: {
        chainId: 56777, source: null, endpoint: null, degraded: false, degradedNote: null,
        head: null, headTs: null, headHash: null, miner: null, blockLagSec: null,
        blockTimeSec: null, blockIntervalSec: null, targetBlockTimeSec: 3,
        gasLimit: null, baseFee: null, gasPrice: null, minGasPriceGwei: 1,
        epochLenSec: 600,           // 决策 #20：纪元 10 分钟（bind.js 用数据层的 BAC.C.EPOCH 覆盖）
        peers: null, txPool: null, txPoolQueued: null,
        txTotal: null, contractsTotal: null,
        circulating: null, burnedTotal: null, totalSupply: null,
        epoch: null, epochLeftSec: null, lastPostedEpoch: null, lastFinalEpoch: null,
        tps: null, tx24h: null, blocks24h: null,
        agentCounts: null,          // {total, …}：v2 没有状态机，只有 total 是真的，其余键一律 null
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

      /* 税收 → BacTaxRouter → 50/50 → BacBridge 桥池 / BacNodeFund（决策 #30，没有金库工厂了）。
         vaultBalance / vaultUnsplit 两个键名沿用旧名，是因为 index.html 的插槽还在读它们；
         disclosure 由 bind.js 写成决策 #29a 的那句，不照搬数据层的旧文案。 */
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

      /* ── agent 造出来的东西：代币 / 交易对 / 成交（决策 #19，03 §7）──────
         全部是**启发式解码**的结果：会漏也会错。detection 是索引器原样给的那一块，
         页面必须把 note 与 unclassifiedContracts 显示出来，不许把列表说成「全链所有代币」。
         金额一律是**该代币自己的最小单位**（BigInt），带自己的 decimals，
         decimals 未知就是 null（页面显示原始最小单位，不许默认当 18）。
         这条链上没有法币、没有稳定币、没有预言机 → **任何 $ 金额 / 市值 / 涨跌幅都不存在**，
         价格只能表达成「1 token0 折合多少 token1」。 */
      built: {
        detection: null,        // {method, note, rulesUrl, unclassifiedContracts}
        tokens: [], tokensTotal: null, tokensAt: null,
        pairs: [], pairsTotal: null, pairsAt: null,
        swaps: [], swapsNext: null, swapsAt: null,
        /* 列表最近一次向索引器要的时候失败了没有：失败 ≠ 0 个，计数格要写「读取失败」 */
        tokensErr: false, pairsErr: false, swapsErr: false,
        tokenDetail: null,      // {token, supplyCheck, topHolders, pairs, recentTransfers, events}
        pairDetail: null,       // {pair, price, recentSwaps, liquidity, v3Note}
        tokenErr: null, pairErr: null
      },

      /* 30 日序列：索引器目前没有日聚合端点，正式站点一律为 null（见 README / 报告） */
      daily: null,

      /* 地址簿（全部来自 site.config.js / 创世常量，不是链上读数） */
      addresses: {},
      layerAddresses: {},
      links: { explorer: '', flapUrl: '', x: '', siteUrl: '' },

      /* 详情页缓存：bind.js 按需填，渲染器只读。
         blockErr / txErr 记的是「这一条确实读过、但节点说没有或读失败了」——
         有它才能显示「找不到」，没有它就只会一直转圈。 */
      detail: { block: null, tx: null, agent: null, epoch: null, contract: null,
        blockErr: null, txErr: null },

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
