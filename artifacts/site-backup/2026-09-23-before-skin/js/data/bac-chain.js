/* BNB Agent Chain · 数据层 · BSC 侧（直接读合约）
   这一半永远不依赖索引器：索引器挂了，这里照常工作（降级模式的定义见 bac-api.js）。
   RPC 层逐字照抄 docs/research/04-website-conventions.md §1.3：
   FetchRequest timeout 15000 + retryFunc 返回 false；JsonRpcProvider staticNetwork /
   batchMaxCount 1 / cacheTimeout -1；每个 URL 独立指数退避、上限 120 秒；
   遇到 revert 不换 RPC；Multicall3 aggregate3 分块 80，逐条判失败，首次用 getCode 探针。 */
(function (root) {
  'use strict';

  var BAC = root.BAC;
  if (!BAC || !BAC.core) {
    if (root.console) root.console.error('[BAC] bac-chain.js 需要先加载 bac-core.js');
    return;
  }
  if (BAC.chain) return;

  var CFG = BAC.CFG, C = BAC.C, TEXT = BAC.TEXT, big = BAC.big;
  var MC_CHUNK = 80;

  /* ══════════════════════════════════════════════════════
     1. ABI（ethers v6 人类可读串）
        以 docs/01-CONTRACT-SPEC.md 为准。与 contracts/src 的差异见 README「已知分歧」。
     ══════════════════════════════════════════════════════ */

  var ABI = Object.freeze({
    vault: [
      'function taxToken() view returns (address)',
      'function bridge() view returns (address)',
      'function nodeFund() view returns (address)',
      'function owner() view returns (address)',
      'function accountedQuote() view returns (uint256)',
      'function unsplitRevenue() view returns (uint256)',
      'function lifetimeToBridge() view returns (uint256)',
      'function lifetimeToNodeFund() view returns (uint256)',
      'function totalRecognized() view returns (uint256)',
      'function stuckAmounts() view returns (uint256 stuckBridge, uint256 stuckNodeFund)',
      'function solvency() view returns (uint256 balance, uint256 accounted, uint256 buckets)',
      'function BRIDGE_BPS() view returns (uint16)',
      'function description() view returns (string)'
    ],
    token: [
      'function name() view returns (string)',
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
      'function taxRate() view returns (uint16)',
      'function buyTaxRate() view returns (uint16)',
      'function sellTaxRate() view returns (uint16)',
      'function taxProcessor() view returns (address)'
    ],
    taxProcessor: [
      'function marketAddress() view returns (address)',
      'function feeConfigV2() view returns (tuple(uint16 marketBps,uint16 deflationBps,uint16 lpBps,uint16 dividendBps,uint16 feeRate,bool isWeth,uint16 commissionBps,address dividendToken))',
      'function marketQuoteBalance() view returns (uint256)',
      'function totalQuoteSentToMarketing() view returns (uint256)'
    ],
    bridge: [
      'function totalLocked() view returns (uint256)',
      'function totalCreditsIssued() view returns (uint256)',
      'function totalCreditsExited() view returns (uint256)',
      'function totalBurned() view returns (uint256)',
      'function creditsOutstanding() view returns (uint256)',
      'function poolBalance() view returns (uint256)',
      'function owedTotal() view returns (uint256)',
      'function reservedTotal() view returns (uint256)',
      'function releasedInWindow() view returns (uint256)',
      'function currentRate() view returns (uint256 weiPerCredit)',
      'function lastEpochRelease() view returns (uint256 pot, uint64 settledAt, uint16 releaseBps)',
      'function isPaused() view returns (bool paused, uint64 until_, uint64 cumulative)',
      'function isHalted() view returns (bool)',
      'function lastSettledEpoch() view returns (uint64)',
      'function skippedEpochs() view returns (uint64)',
      'function haltCause() view returns (uint8)',
      'function pendingCause() view returns (uint8)',
      'function escapeArmedAt() view returns (uint64)',
      'function escapeState() view returns (uint256 totalWeight, uint256 accPerWeight_, uint256 distributed)',
      'function escapeClaimable(uint256 agentId) view returns (uint256)',
      'function pendingCollect(address who) view returns (uint256)',
      'function credited(uint256 agentId) view returns (uint256)',
      'function exitedCredits(uint256 agentId) view returns (uint256)',
      'function exitClaimed(uint256 exitId) view returns (bool)',
      'function MAX_EXIT_SHARE_BPS() view returns (uint16)',
      'function MAX_PAUSE_TOTAL() view returns (uint64)'
    ],
    nodeFund: [
      'function balance() view returns (uint256)',
      'function lifetimeReceived() view returns (uint256)',
      'function lifetimeWithdrawn() view returns (uint256)',
      'function owner() view returns (address)'
    ],
    registry: [
      'function totalAgents() view returns (uint256)',
      'function currentEpoch() view returns (uint64)',
      'function isActive(uint256 agentId) view returns (bool)',
      'function agentAt(uint256 index) view returns (uint256)',
      'function recentAgents(uint256 count) view returns (uint256[])',
      'function agentIdOfWallet(address) view returns (uint256)',
      'function getAgent(uint256 agentId) view returns (tuple(address controller,address agentWallet,string agentURI,bytes32 endpointHash,bytes32 modelFingerprint,uint64 registeredAt,uint64 lastHeartbeatEpoch,uint32 missedEpochs,uint32 solvedChallenges,uint96 deposit,uint8 status))',
      'function ENTRY_DEPOSIT() view returns (uint256)'
    ],
    // 01-CONTRACT-SPEC.md §11.4：Anchor 是 15 个字段（决策 #17 新增 4 个）
    anchor: [
      'function lastPostedEpoch() view returns (uint64)',
      'function lastFinalEpoch() view returns (uint64)',
      'function lastFinalAt() view returns (uint64)',
      'function cumulativeCredited() view returns (uint256)',
      'function cumulativeExit() view returns (uint256)',
      'function cumulativeGasFees() view returns (uint256)',
      'function cumulativeRemitted() view returns (uint256)',
      'function haltReason() view returns (uint8)',
      'function vetoCountInWindow() view returns (uint8)',
      'function disputeCountInWindow() view returns (uint8)',
      'function releaseBpsFor(uint64 epoch) view returns (uint16)',
      'function getAnchor(uint64 epoch) view returns (tuple(bytes32 exitRoot,bytes32 proposerIncomeRoot,bytes32 l2BlockHash,uint64 l2Block,uint64 postedAt,uint64 finalizedAt,uint128 creditedInEpoch,uint128 exitCreditsInEpoch,uint128 feeBurnedInEpoch,uint128 gasFeesInEpoch,uint128 remittedInEpoch,uint128 circulating,uint32 exitCount,uint32 proposerCount,uint32 agreeingCount,uint8 state))',
      'function proposerIncome(uint64 epoch, address proposer) view returns (tuple(address proposer,uint128 gasIncome,uint128 remitted,uint32 blocks,bool official))',
      'function proposersOf(uint64 epoch) view returns (address[])'
    ],
    staking: [
      'function totalStaked() view returns (uint256)',
      'function nodeCount() view returns (uint256)',
      'function nodeAt(uint256 i) view returns (bytes32)',
      'function nodeOf(bytes32 nodeIdHash) view returns (address validator, address payout, string enodeURI, bool active, uint32 strikes)',
      'function stakeOf(address who) view returns (uint256 staked, uint256 pending, uint64 unlockAt)',
      'function rewardBalance() view returns (uint256)',
      'function lifetimeFunded() view returns (uint256)',
      'function lifetimePaid() view returns (uint256)',
      'function epochReward(uint64 epoch) view returns (uint256 pot, uint256 weight, uint256 rate, bool settled)',
      'function rewardOf(uint64 epoch, address validator) view returns (uint256)',
      'function revealerCount(uint64 epoch) view returns (uint256)',
      'function MIN_VALIDATOR_STAKE() view returns (uint256)',
      // 决策 #17（01 §11.5）：归集对账三元组的链上来源
      'function proposerRights(address v) view returns (bool)',
      'function proposerAddressOf(address v) view returns (address)',
      'function qualifyStreak(address v) view returns (uint16)',
      'function remitStatus(address v) view returns (uint256 cumOwed, uint256 cumRemitted, uint256 arrears, bool shortfall)',
      'function withheldOf(address v) view returns (uint256)',
      'function lastRemitEpoch() view returns (uint64)'
    ],
    factory: [
      'function isVaultUpgradesLocked() view returns (bool)',
      'function beaconImplementation() view returns (address)'
    ],
    multicall3: [
      'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[] returnData)'
    ]
  });

  /* ══════════════════════════════════════════════════════
     2. RPC 层
     ══════════════════════════════════════════════════════ */

  var E = null;                       // ethers 命名空间
  var providers = {};                 // url → JsonRpcProvider
  var rpcHealth = BAC.healthTable(15000);
  var fallbackProvider = null;        // 钱包 provider（本轮网站只读，留口子）
  var IF = {};                        // 名字 → ethers.Interface

  function ethersNS() {
    if (!E) E = root.ethers;
    return E;
  }

  function providerFor(url) {
    if (providers[url]) return providers[url];
    var e = ethersNS();
    if (!e) return null;
    var req = new e.FetchRequest(url);
    req.timeout = CFG.rpcTimeoutMs;              // 15000
    req.retryFunc = function () { return Promise.resolve(false); }; // 429 直接失败换 RPC，不走 ethers 的长退避
    var net = new e.Network(CFG.chainName, CFG.chainId);
    var p = new e.JsonRpcProvider(req, net, {
      staticNetwork: net,
      batchMaxCount: 1,
      cacheTimeout: -1                            // -1：不重放 250ms 内的陈旧/失败结果
    });
    providers[url] = p;
    return p;
  }

  function urlList(logs) {
    var list = (logs ? CFG.logRpcs : CFG.rpcs) || [];
    return list.slice();
  }

  /** 健康的排前面，退避中的排后面（但仍然会被试到，不彻底放弃）。 */
  function ordered(list, now) {
    var good = [], bad = [];
    list.forEach(function (u) { (rpcHealth.healthy(u, now) ? good : bad).push(u); });
    return good.concat(bad);
  }

  /** 对每个候选 RPC 依次尝试；revert 立即抛出（换 RPC 没有意义）。 */
  function withRead(fn, opts) {
    opts = opts || {};
    var list = ordered(urlList(opts.logs), Date.now());
    if (!list.length && fallbackProvider) list = ['__wallet__'];
    if (!list.length) return Promise.reject(new Error(TEXT.NO_RPC));

    var i = 0, lastErr = null;
    function next() {
      if (i >= list.length) return Promise.reject(lastErr || new Error(TEXT.ERR));
      var url = list[i++];
      var p = url === '__wallet__' ? fallbackProvider : providerFor(url);
      if (!p) { lastErr = new Error('ethers 未就绪'); return next(); }
      return Promise.resolve()
        .then(function () { return fn(p, url); })
        .then(function (v) { rpcHealth.ok(url); return v; })
        .catch(function (e) {
          if (BAC.isRevert(e)) throw e;            // revert 在每个节点上都一样
          rpcHealth.bad(url, e);
          lastErr = e;
          return next();
        });
    }
    return next();
  }

  /* ══════════════════════════════════════════════════════
     3. Multicall3
     ══════════════════════════════════════════════════════ */

  var mcState = { probed: false, available: null };

  function iface(name) {
    var e = ethersNS();
    if (!IF[name]) IF[name] = new e.Interface(ABI[name]);
    return IF[name];
  }

  /** 一次调用的描述符。key 是回读时用的名字。 */
  function call(target, abiName, key, fn, args) {
    return { target: target, abiName: abiName, key: key, fn: fn, args: args || [] };
  }

  function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /** Multicall3 是否存在（首次用 getCode 探一次，探不到就退回逐条 eth_call）。 */
  function probeMulticall() {
    if (mcState.probed) return Promise.resolve(mcState.available);
    return withRead(function (p) { return p.getCode(C.MULTICALL3); })
      .then(function (code) {
        mcState.probed = true;
        mcState.available = !!(code && code !== '0x');
        return mcState.available;
      })
      .catch(function () { mcState.probed = true; mcState.available = false; return false; });
  }

  /** 逐条 eth_call 的退路，最多 6 条并发。 */
  function plainCalls(calls) {
    var out = {}, i = 0;
    function worker() {
      if (i >= calls.length) return Promise.resolve();
      var c = calls[i++];
      var data;
      try { data = iface(c.abiName).encodeFunctionData(c.fn, c.args); }
      catch (e) { return worker(); }
      return withRead(function (p) { return p.call({ to: c.target, data: data }); })
        .then(function (ret) { out[c.key] = decode(c, ret); })
        .catch(function () { /* 单条失败 = out[key] 保持 undefined */ })
        .then(worker);
    }
    var n = Math.min(6, calls.length) || 1;
    var jobs = [];
    for (var k = 0; k < n; k++) jobs.push(worker());
    return Promise.all(jobs).then(function () { return out; });
  }

  function decode(c, ret) {
    if (ret === '0x' || ret === undefined || ret === null) return undefined;
    var r = iface(c.abiName).decodeFunctionResult(c.fn, ret);
    return r.length === 1 ? r[0] : r;
  }

  /** 一批读。返回 { key: 值 }；某一条失败时该 key 是 undefined（逐条判失败）。 */
  function multi(calls) {
    if (!calls.length) return Promise.resolve({});
    return probeMulticall().then(function (ok) {
      if (!ok) return plainCalls(calls);
      var mc = iface('multicall3');
      var groups = chunk(calls, MC_CHUNK);
      var out = {};
      return groups.reduce(function (chain, g) {
        return chain.then(function () {
          var payload = [];
          var usable = [];
          g.forEach(function (c) {
            try {
              payload.push([c.target, true, iface(c.abiName).encodeFunctionData(c.fn, c.args)]);
              usable.push(c);
            } catch (e) { /* 编码不了就跳过，等于这条失败 */ }
          });
          if (!payload.length) return;
          var data = mc.encodeFunctionData('aggregate3', [payload]);
          return withRead(function (p) { return p.call({ to: C.MULTICALL3, data: data }); })
            .then(function (ret) {
              var res = mc.decodeFunctionResult('aggregate3', ret)[0];
              for (var i = 0; i < usable.length; i++) {
                var row = res[i];
                if (!row || row[0] !== true) continue;   // success === false → 这一条失败
                try { out[usable[i].key] = decode(usable[i], row[1]); } catch (e) { /* 留空 */ }
              }
            })
            .catch(function (e) {
              // 整块失败：退回逐条，宁可慢也不要整页空白
              return plainCalls(usable).then(function (o) { Object.assign(out, o); });
            });
        });
      }, Promise.resolve()).then(function () { return out; });
    });
  }

  /* ══════════════════════════════════════════════════════
     4. 读 BSC：一次 refresh 的全部内容
     ══════════════════════════════════════════════════════ */

  var A = CFG.addresses;

  function num(v) { return v === undefined || v === null ? null : Number(v); }
  function str(v) { return v === undefined || v === null ? null : String(v); }

  /** 一次性读的静态参数（代币元数据、税率、金库配置），只在第一次成功后缓存。 */
  function loadParams() {
    var calls = [
      call(A.vault, 'vault', 'v.taxToken', 'taxToken'),
      call(A.vault, 'vault', 'v.bridge', 'bridge'),
      call(A.vault, 'vault', 'v.nodeFund', 'nodeFund'),
      call(A.vault, 'vault', 'v.owner', 'owner'),
      call(A.vault, 'vault', 'v.bridgeBps', 'BRIDGE_BPS'),
      call(A.token, 'token', 't.name', 'name'),
      call(A.token, 'token', 't.symbol', 'symbol'),
      call(A.token, 'token', 't.decimals', 'decimals'),
      call(A.token, 'token', 't.totalSupply', 'totalSupply'),
      call(A.token, 'token', 't.taxRate', 'taxRate'),
      call(A.token, 'token', 't.buyTax', 'buyTaxRate'),
      call(A.token, 'token', 't.sellTax', 'sellTaxRate'),
      call(A.token, 'token', 't.processor', 'taxProcessor')
    ];
    return multi(calls).then(function (o) {
      var proc = o['t.processor'];
      var params = {
        vault: A.vault,
        vaultOwner: str(o['v.owner']),
        taxToken: str(o['v.taxToken']),
        bridgeAddr: str(o['v.bridge']),
        nodeFundAddr: str(o['v.nodeFund']),
        bridgeBps: num(o['v.bridgeBps']),
        nodeFundBps: o['v.bridgeBps'] === undefined ? null : C.BPS - Number(o['v.bridgeBps']),
        name: str(o['t.name']),
        symbol: str(o['t.symbol']),
        decimals: o['t.decimals'] === undefined ? null : Number(o['t.decimals']),
        totalSupply: big(o['t.totalSupply']),
        taxRate: num(o['t.taxRate']),
        buyTaxRate: num(o['t.buyTax']),
        sellTaxRate: num(o['t.sellTax']),
        taxProcessor: str(proc),
        taxFeeRateBps: null,
        marketAddress: null,
        marketAddressOk: null
      };
      if (!BAC.isAddr(str(proc))) return params;
      return multi([
        call(str(proc), 'taxProcessor', 'p.market', 'marketAddress'),
        call(str(proc), 'taxProcessor', 'p.cfg', 'feeConfigV2')
      ]).then(function (p) {
        params.marketAddress = str(p['p.market']);
        // 决策 #10 的硬检查：marketAddress 必须就是我们的金库，否则税收根本进不来
        params.marketAddressOk = params.marketAddress
          ? params.marketAddress.toLowerCase() === String(A.vault).toLowerCase() : null;
        var cfg = p['p.cfg'];
        if (cfg) {
          // feeConfigV2().feeRate = Flap 协议先抽走的那一层，网站所有 50/50 说明都写在
          // (10000 - taxFeeRateBps)/10000 的基数上（03 §3.2）
          params.taxFeeRateBps = num(cfg.feeRate !== undefined ? cfg.feeRate : cfg[4]);
        }
        if (params.marketAddressOk === false) BAC.pushWarning('market_address_mismatch');
        else BAC.clearWarning('market_address_mismatch');
        return params;
      }).catch(function () { return params; });
    });
  }

  /** 每次刷新都读的活数据。 */
  function readLive(epochHint) {
    var epoch = epochHint === null || epochHint === undefined ? BAC.currentEpoch() : epochHint;
    var calls = [];

    if (BAC.isAddr(A.vault)) {
      calls.push(
        call(A.vault, 'vault', 'v.accounted', 'accountedQuote'),
        call(A.vault, 'vault', 'v.unsplit', 'unsplitRevenue'),
        call(A.vault, 'vault', 'v.toBridge', 'lifetimeToBridge'),
        call(A.vault, 'vault', 'v.toNode', 'lifetimeToNodeFund'),
        call(A.vault, 'vault', 'v.recognized', 'totalRecognized'),
        call(A.vault, 'vault', 'v.stuck', 'stuckAmounts'),
        call(A.vault, 'vault', 'v.solvency', 'solvency')
      );
    }
    if (BAC.isAddr(A.bridge)) {
      calls.push(
        call(A.bridge, 'bridge', 'b.locked', 'totalLocked'),
        call(A.bridge, 'bridge', 'b.issued', 'totalCreditsIssued'),
        call(A.bridge, 'bridge', 'b.exited', 'totalCreditsExited'),
        call(A.bridge, 'bridge', 'b.burned', 'totalBurned'),
        call(A.bridge, 'bridge', 'b.outstanding', 'creditsOutstanding'),
        call(A.bridge, 'bridge', 'b.pool', 'poolBalance'),
        call(A.bridge, 'bridge', 'b.owed', 'owedTotal'),
        call(A.bridge, 'bridge', 'b.reserved', 'reservedTotal'),
        call(A.bridge, 'bridge', 'b.released', 'releasedInWindow'),
        call(A.bridge, 'bridge', 'b.rate', 'currentRate'),
        call(A.bridge, 'bridge', 'b.lastRelease', 'lastEpochRelease'),
        call(A.bridge, 'bridge', 'b.paused', 'isPaused'),
        call(A.bridge, 'bridge', 'b.halted', 'isHalted'),
        call(A.bridge, 'bridge', 'b.settled', 'lastSettledEpoch'),
        call(A.bridge, 'bridge', 'b.skipped', 'skippedEpochs'),
        call(A.bridge, 'bridge', 'b.haltCause', 'haltCause'),
        call(A.bridge, 'bridge', 'b.pendingCause', 'pendingCause'),
        call(A.bridge, 'bridge', 'b.escapeArmedAt', 'escapeArmedAt'),
        call(A.bridge, 'bridge', 'b.escape', 'escapeState')
      );
    }
    if (BAC.isAddr(A.nodeFund)) {
      calls.push(
        call(A.nodeFund, 'nodeFund', 'n.balance', 'balance'),
        call(A.nodeFund, 'nodeFund', 'n.received', 'lifetimeReceived'),
        call(A.nodeFund, 'nodeFund', 'n.withdrawn', 'lifetimeWithdrawn'),
        call(A.nodeFund, 'nodeFund', 'n.owner', 'owner')
      );
    }
    if (BAC.isAddr(A.registry)) {
      calls.push(
        call(A.registry, 'registry', 'r.total', 'totalAgents'),
        call(A.registry, 'registry', 'r.epoch', 'currentEpoch')
      );
    }
    if (BAC.isAddr(A.staking)) {
      calls.push(
        call(A.staking, 'staking', 's.staked', 'totalStaked'),
        call(A.staking, 'staking', 's.nodes', 'nodeCount'),
        call(A.staking, 'staking', 's.rewardBal', 'rewardBalance'),
        call(A.staking, 'staking', 's.funded', 'lifetimeFunded'),
        call(A.staking, 'staking', 's.paid', 'lifetimePaid'),
        call(A.staking, 'staking', 's.lastRemit', 'lastRemitEpoch')
      );
    }
    if (BAC.isAddr(A.anchor)) {
      calls.push(
        call(A.anchor, 'anchor', 'a.posted', 'lastPostedEpoch'),
        call(A.anchor, 'anchor', 'a.final', 'lastFinalEpoch'),
        call(A.anchor, 'anchor', 'a.finalAt', 'lastFinalAt'),
        call(A.anchor, 'anchor', 'a.cumCredited', 'cumulativeCredited'),
        call(A.anchor, 'anchor', 'a.cumExit', 'cumulativeExit'),
        call(A.anchor, 'anchor', 'a.cumGas', 'cumulativeGasFees'),
        call(A.anchor, 'anchor', 'a.cumRemitted', 'cumulativeRemitted'),
        call(A.anchor, 'anchor', 'a.haltReason', 'haltReason'),
        call(A.anchor, 'anchor', 'a.vetoes', 'vetoCountInWindow'),
        call(A.anchor, 'anchor', 'a.disputes', 'disputeCountInWindow'),
        call(A.anchor, 'anchor', 'a.releaseBps', 'releaseBpsFor', [epoch])
      );
    }
    return multi(calls);
  }

  /** 第二跳：拿到 lastPostedEpoch 之后再读那个纪元的锚点与奖励。 */
  function readEpoch(epoch) {
    if (epoch === null || epoch === undefined) return Promise.resolve({});
    var calls = [];
    if (BAC.isAddr(A.anchor)) calls.push(call(A.anchor, 'anchor', 'e.anchor', 'getAnchor', [epoch]));
    if (BAC.isAddr(A.staking)) calls.push(call(A.staking, 'staking', 'e.reward', 'epochReward', [epoch]));
    return multi(calls);
  }

  /* ══════════════════════════════════════════════════════
     5. 组装到 state
     ══════════════════════════════════════════════════════ */

  var ANCHOR_STATE = ['NONE', 'POSTED', 'FINAL', 'VETOED', 'DISPUTED'];

  function shapeAnchor(a) {
    if (!a) return null;
    return {
      exitRoot: str(a.exitRoot !== undefined ? a.exitRoot : a[0]),
      proposerIncomeRoot: str(a.proposerIncomeRoot !== undefined ? a.proposerIncomeRoot : a[1]),
      l2BlockHash: str(a.l2BlockHash !== undefined ? a.l2BlockHash : a[2]),
      l2Block: num(a.l2Block !== undefined ? a.l2Block : a[3]),
      postedAt: num(a.postedAt !== undefined ? a.postedAt : a[4]),
      finalizedAt: num(a.finalizedAt !== undefined ? a.finalizedAt : a[5]),
      creditedInEpoch: big(a.creditedInEpoch !== undefined ? a.creditedInEpoch : a[6]),
      exitCreditsInEpoch: big(a.exitCreditsInEpoch !== undefined ? a.exitCreditsInEpoch : a[7]),
      feeBurnedInEpoch: big(a.feeBurnedInEpoch !== undefined ? a.feeBurnedInEpoch : a[8]),
      gasFeesInEpoch: big(a.gasFeesInEpoch !== undefined ? a.gasFeesInEpoch : a[9]),
      remittedInEpoch: big(a.remittedInEpoch !== undefined ? a.remittedInEpoch : a[10]),
      circulating: big(a.circulating !== undefined ? a.circulating : a[11]),
      exitCount: num(a.exitCount !== undefined ? a.exitCount : a[12]),
      proposerCount: num(a.proposerCount !== undefined ? a.proposerCount : a[13]),
      agreeingCount: num(a.agreeingCount !== undefined ? a.agreeingCount : a[14]),
      state: ANCHOR_STATE[Number(a.state !== undefined ? a.state : a[15])] || 'NONE'
    };
  }

  function apply(o, params, epochData, epoch) {
    var S = BAC.state.bsc;

    if (params) S.params = params;

    var dec = (S.params && S.params.decimals) || 18;

    // 金库 / 桥池 / 节点基金：50/50 的两桶 + 金库里还没分的那部分
    var stuck = o['v.stuck'];
    var solv = o['v.solvency'];
    S.treasury = {
      vaultBalance: solv ? big(solv[0] !== undefined ? solv[0] : solv.balance) : null,
      vaultAccounted: big(o['v.accounted']),
      vaultUnsplit: big(o['v.unsplit']),
      vaultBuckets: solv ? big(solv[2] !== undefined ? solv[2] : solv.buckets) : null,
      lifetimeToBridge: big(o['v.toBridge']),
      lifetimeToNodeFund: big(o['v.toNode']),
      totalRecognized: big(o['v.recognized']),
      stuckBridge: stuck ? big(stuck[0]) : null,
      stuckNodeFund: stuck ? big(stuck[1]) : null,
      poolBalance: big(o['b.pool']),
      nodeFundBalance: big(o['n.balance']),
      nodeFundReceived: big(o['n.received']),
      nodeFundWithdrawn: big(o['n.withdrawn']),
      nodeFundOwner: str(o['n.owner']),
      bridgeBps: (S.params && S.params.bridgeBps) || C.BRIDGE_BPS,
      taxFeeRateBps: S.params ? S.params.taxFeeRateBps : null,
      decimals: 18   // 税收是 BNB
    };

    var paused = o['b.paused'], rel = o['b.lastRelease'], esc = o['b.escape'];
    S.bridge = {
      totalLocked: big(o['b.locked']),
      totalIssued: big(o['b.issued']),
      totalExited: big(o['b.exited']),
      totalBurned: big(o['b.burned']),
      creditsOutstanding: big(o['b.outstanding']),
      poolBalance: big(o['b.pool']),
      owedTotal: big(o['b.owed']),
      reservedTotal: big(o['b.reserved']),
      releasedInWindow: big(o['b.released']),
      weiPerCredit: big(o['b.rate']),
      lastPot: rel ? big(rel[0]) : null,
      lastPotSettledAt: rel ? num(rel[1]) : null,
      lastPotBps: rel ? num(rel[2]) : null,
      paused: paused ? !!(paused[0] === true || paused.paused === true) : null,
      pausedUntil: paused ? num(paused[1]) : null,
      pausedCumulativeSec: paused ? num(paused[2]) : null,
      halted: o['b.halted'] === undefined ? null : !!o['b.halted'],
      haltCause: num(o['b.haltCause']),
      pendingCause: num(o['b.pendingCause']),
      escapeArmedAt: num(o['b.escapeArmedAt']),
      escapeTotalWeight: esc ? big(esc[0]) : null,
      escapeDistributed: esc ? big(esc[2]) : null,
      lastSettledEpoch: num(o['b.settled']),
      skippedEpochs: num(o['b.skipped']),
      decimals: dec
    };

    S.agents = {
      total: num(o['r.total']),
      registryEpoch: num(o['r.epoch'])
    };

    var er = epochData && epochData['e.reward'];
    S.staking = {
      totalStaked: big(o['s.staked']),
      nodeCount: num(o['s.nodes']),
      rewardBalance: big(o['s.rewardBal']),
      lifetimeFunded: big(o['s.funded']),
      lifetimePaid: big(o['s.paid']),
      lastRemitEpoch: num(o['s.lastRemit']),
      epochPot: er ? big(er[0]) : null,
      epochWeight: er ? big(er[1]) : null,
      epochSettled: er ? !!er[3] : null,
      minStake: C.MIN_VALIDATOR_STAKE
    };

    var anchor = shapeAnchor(epochData && epochData['e.anchor']);
    var cumGas = big(o['a.cumGas']), cumRem = big(o['a.cumRemitted']);
    S.anchor = {
      lastPostedEpoch: num(o['a.posted']),
      lastFinalEpoch: num(o['a.final']),
      lastFinalAt: num(o['a.finalAt']),
      currentEpoch: BAC.currentEpoch(),
      epochLeftSec: BAC.epochLeft(),
      cumulativeCredited: big(o['a.cumCredited']),
      cumulativeExit: big(o['a.cumExit']),
      haltReason: num(o['a.haltReason']),
      vetoCountInWindow: num(o['a.vetoes']),
      disputeCountInWindow: num(o['a.disputes']),
      releaseBps: num(o['a.releaseBps']),
      anchorEpoch: epoch === undefined ? null : epoch,
      anchor: anchor,
      // 决策 #17 的对账三元组（累计口径）：已收 / 已转入 / 差额
      gas: {
        collected: cumGas,
        remitted: cumRem,
        shortfall: (cumGas !== null && cumRem !== null) ? (cumGas > cumRem ? cumGas - cumRem : 0n) : null,
        epochCollected: anchor ? anchor.gasFeesInEpoch : null,
        epochRemitted: anchor ? anchor.remittedInEpoch : null,
        officialValidatorBps: C.OFFICIAL_BLOCK_VALIDATOR_BPS,
        validatorSelfBps: C.VALIDATOR_BLOCK_VALIDATOR_BPS
      }
    };

    if (S.anchor.gas.shortfall !== null && S.anchor.gas.shortfall > 0n) BAC.pushWarning('gas_remittance_shortfall');
    else BAC.clearWarning('gas_remittance_shortfall');
  }

  /* ══════════════════════════════════════════════════════
     6. 刷新循环
     ══════════════════════════════════════════════════════ */

  var timer = null, inFlight = null, started = false;

  function pollMs() {
    return BAC.state.prelaunch ? CFG.prelaunchPollMs : CFG.pollMs;
  }

  function schedule(ms) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (BAC.state.hidden) return;
    timer = setTimeout(function () { refresh({ reason: 'poll' }); }, ms === undefined ? pollMs() : ms);
  }

  function markOk(reason) {
    var S = BAC.state, B = S.bsc;
    B.ready = true; B.error = null; B.errorDetail = null; B.failures = 0;
    B.updatedAt = Date.now();
    S.ready = true; S.error = null; S.errorDetail = null; S.loading = false;
    S.updatedAt = B.updatedAt; S.reason = reason || null;
    BAC.emit('state', S);
  }

  function markFail(e, reason) {
    var S = BAC.state, B = S.bsc;
    B.failures++;
    var info = BAC.errInfo(e);
    B.error = info.message === TEXT.NO_RPC ? TEXT.NO_RPC : TEXT.ERR;
    B.errorDetail = info.message;
    S.loading = false;
    S.error = B.error;
    S.errorDetail = info.message;
    S.reason = reason || null;
    BAC.emit('state', S);
  }

  /** 发射前唯一的 RPC 调用：eth_blockNumber。其余一律保持 null。 */
  function prelaunchTick() {
    return withRead(function (p) { return p.getBlockNumber(); })
      .then(function (n) {
        BAC.state.bsc.block = { number: Number(n), timestamp: null, at: Date.now() };
        markOk('prelaunch');
      })
      .catch(function (e) { markFail(e, 'prelaunch'); })
      .then(function () { schedule(); });
  }

  function refresh(opts) {
    opts = opts || {};
    if (inFlight) return inFlight;                  // 同一时刻只有一次在跑
    var e = ethersNS();
    if (!e) {
      return BAC.ethersReady().then(function () { return refresh(opts); })
        .catch(function (err) { markFail(err, 'ethers'); });
    }
    if (!CFG.rpcs.length) { markFail(new Error(TEXT.NO_RPC), 'config'); schedule(); return Promise.resolve(); }

    BAC.state.loading = true;
    BAC.emit('state', BAC.state);

    if (!BAC.LIVE) { inFlight = prelaunchTick().then(function () { inFlight = null; }); return inFlight; }

    var params = BAC.state.bsc.params;
    var job = Promise.resolve()
      .then(function () { return params ? params : loadParams(); })
      .then(function (p) {
        params = p;
        return withRead(function (prov) { return prov.getBlock('latest'); }).catch(function () { return null; });
      })
      .then(function (blk) {
        if (blk) {
          BAC.state.bsc.block = { number: Number(blk.number), timestamp: Number(blk.timestamp), at: Date.now() };
          BAC.time.setChainTime(Number(blk.timestamp));
        }
        return readLive(BAC.currentEpoch());
      })
      .then(function (o) {
        var posted = o['a.posted'] === undefined ? null : Number(o['a.posted']);
        return readEpoch(posted).then(function (ed) {
          apply(o, params, ed, posted);
          markOk(opts.reason || 'refresh');
        });
      })
      .catch(function (err) { markFail(err, opts.reason); })
      .then(function () {
        inFlight = null;
        var f = BAC.state.bsc.failures;
        schedule(f > 0 ? Math.min(pollMs(), BAC.backoffMs(f, 3000)) : pollMs());
      });

    inFlight = job;
    return job;
  }

  BAC.on('hidden', function (hidden) {
    if (hidden) { if (timer) { clearTimeout(timer); timer = null; } return; }
    var age = Date.now() - (BAC.state.bsc.updatedAt || 0);
    if (age > 5000) refresh({ reason: 'unhide' }); else schedule();
  });

  BAC.chain = {
    ABI: ABI,
    MC_CHUNK: MC_CHUNK,
    call: call,
    multi: multi,
    chunk: chunk,
    withRead: withRead,
    providerFor: providerFor,
    rpcHealth: rpcHealth,
    loadParams: loadParams,
    readLive: readLive,
    readEpoch: readEpoch,
    shapeAnchor: shapeAnchor,
    refresh: refresh,
    setFallbackProvider: function (p) { fallbackProvider = p || null; },
    start: function () {
      if (started) return;
      started = true;
      refresh({ reason: 'start' });
    },
    stop: function () { if (timer) { clearTimeout(timer); timer = null; } started = false; },
    _probeState: mcState
  };
})(typeof window !== 'undefined' ? window : globalThis);
