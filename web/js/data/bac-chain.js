/* BNB Agent Chain · 数据层 · BSC 侧（直接读合约）
   这一半永远不依赖索引器：索引器挂了，这里照常工作（降级模式的定义见 bac-api.js）。
   RPC 层逐字照抄 docs/research/04-website-conventions.md §1.3：
   FetchRequest timeout 15000 + retryFunc 返回 false；JsonRpcProvider staticNetwork /
   batchMaxCount 1 / cacheTimeout -1；每个 URL 独立指数退避、上限 120 秒；
   遇到 revert 不换 RPC；Multicall3 aggregate3 分块 80，逐条判失败，首次用 getCode 探针。

   v2 模型（决策 #29 / #30 / #31 / #33 / #35）：
   - 没有 BacVaultFactory / BacTreasuryVault / beacon / AgentRegistry / VaultPortal 了；
   - 税：Flap TaxProcessor → BacTaxRouter（无 owner）→ 50/50 → BacBridge.acceptRelease() / BacNodeFund.acceptRelease()；
   - BacBridge 是 UUPS（ERC1967）代理，owner 可随时升级、随时紧急提取全部桥池（#29a）；
   - 入场门禁 = ERC-8004 Identity Registry（BNB Chain 官方），agent = 锁进过桥的身份编号，没有状态机；
   - 代币地址已锁定（#35），但发射前地址上没有代码：三阶段见 bac-core.js 的 BAC.STAGE。
   eth_call 走 CFG.rpcs（bsc-dataseed 在前），eth_getLogs 只走 CFG.logRpcs（publicnode）。 */
(function (root) {
  'use strict';

  var BAC = root.BAC;
  if (!BAC || !BAC.core) {
    if (root.console) root.console.error('[BAC] bac-chain.js 需要先加载 bac-core.js');
    return;
  }
  if (BAC.chain) return;

  var CFG = BAC.CFG, C = BAC.C, TEXT = BAC.TEXT, big = BAC.big, isAddr = BAC.isAddr;
  var MC_CHUNK = 80;

  /* ══════════════════════════════════════════════════════
     1. ABI（ethers v6 人类可读串）
        以 contracts/src 为准（BacTaxRouter.sol / BacBridge.sol / BacNodeFund.sol / ChainAnchor.sol /
        IErc8004Identity.sol / flap/IPortal.sol）。与 SPEC 的差异见 README「已知分歧」。
     ══════════════════════════════════════════════════════ */

  var ABI = Object.freeze({
    // BacTaxRouter：没有 owner，没有 setter（决策 #30 / #32）
    router: [
      'function bacToken() view returns (address)',
      'function bridge() view returns (address)',
      'function nodeFund() view returns (address)',
      'function BRIDGE_BPS() view returns (uint16)',
      'function PUSH_GAS() view returns (uint256)',
      'function accountedQuote() view returns (uint256)',
      'function unsplitRevenue() view returns (uint256)',
      'function lifetimeToBridge() view returns (uint256)',
      'function lifetimeToNodeFund() view returns (uint256)',
      'function totalRecognized() view returns (uint256)',
      'function stuckAmounts() view returns (uint256 stuckBridge, uint256 stuckNodeFund)',
      'function solvency() view returns (uint256 balance, uint256 accounted, uint256 buckets)',
      'event RevenueRecognized(address indexed from, uint256 amount)',
      'event RevenueSplit(uint256 toBridge, uint256 toNodeFund)',
      'event PushSucceeded(address indexed to, uint256 amount)',
      'event PushFailed(address indexed to, uint256 amount)'
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
    // Flap 普通 Portal v5.24.0：代币状态（TokenStatus: 0 Invalid 1 Tradable 2 InDuel 3 Killed 4 DEX 5 Staged）
    portal: [
      'function getTokenV8Safe(address token) view returns (tuple(uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)'
    ],
    // BacBridge（ERC1967 代理）。只列本站读的；owner 权力的事件逐字照 BacBridge.sol。
    bridge: [
      'function owner() view returns (address)',
      'function pendingOwner() view returns (address)',
      'function bacToken() view returns (address)',
      'function identityRegistry() view returns (address)',
      'function anchor() view returns (address)',
      'function watchdog() view returns (address)',
      'function portal() view returns (address)',
      // PancakeSwap V2 Router（毕业后回购走外盘），不是 BacTaxRouter —— 数据层叫它 dexRouter
      'function router() view returns (address)',
      'function EXTENSION() view returns (address)',
      'function OWNER_POWER_NOTICE() view returns (string)',
      'function IDENTITY_LIMIT_NOTICE() view returns (string)',
      'function description() view returns (string)',
      'function lockedBac() view returns (uint256)',
      'function totalBurned() view returns (uint256)',
      'function totalCreditsIssued() view returns (uint256)',
      'function totalCreditsExited() view returns (uint256)',
      'function creditsOutstanding() view returns (uint256)',
      'function depositId() view returns (uint256)',
      'function deposits(uint256) view returns (address from, uint64 at, uint256 agentId, uint256 amount)',
      'function buybackBac() view returns (uint256)',
      'function bnbBalance() view returns (uint256)',
      'function buybackBudget() view returns (uint256)',
      'function buybackBacBought() view returns (uint256)',
      'function buybackBnbSpent() view returns (uint256)',
      'function bacAccounted() view returns (uint256)',
      'function buybackState() view returns (uint256 budget, uint256 spendable, uint64 epochsWaited, uint8 venue)',
      'function owedTotal() view returns (uint256)',
      'function reservedTotal() view returns (uint256)',
      'function releasedInWindow() view returns (uint256)',
      'function currentRate() view returns (uint256 bacPerCredit)',
      'function lastEpochRelease() view returns (uint256 pot, uint64 settledAt, uint16 releaseBps)',
      'function isPaused() view returns (bool paused, uint64 until_, uint64 cumulative)',
      'function isHalted() view returns (bool)',
      'function lastSettledEpoch() view returns (uint64)',
      'function skippedEpochs() view returns (uint64)',
      'function haltCause() view returns (uint8)',
      'function pendingCause() view returns (uint8)',
      'function escapeArmedAt() view returns (uint64)',
      'function escapeState() view returns (uint256 totalWeight, uint256 accBac, uint256 accBnb, uint256 distBac, uint256 distBnb)',
      'function escapeClaimable(uint256 agentId) view returns (uint256 bac, uint256 bnb)',
      'function pendingCollect(address who) view returns (uint256)',
      'function credited(uint256 agentId) view returns (uint256)',
      'function exitedCredits(uint256 agentId) view returns (uint256)',
      'function agentController(uint256 agentId) view returns (address)',
      'function exitClaimed(uint256 exitId) view returns (bool)',
      'function upgradeCount() view returns (uint64)',
      'function lastUpgradeAt() view returns (uint64)',
      'function emergencyBnbWithdrawn() view returns (uint256)',
      'function emergencyBacWithdrawn() view returns (uint256)',
      'function emergencyCount() view returns (uint64)',
      'function lastEmergencyAt() view returns (uint64)',
      'function shortfall() view returns (uint256 bnbShort, uint256 bacShort)',
      'function MAX_EXIT_SHARE_BPS() view returns (uint16)',
      'function MAX_PAUSE_TOTAL() view returns (uint64)',
      'event Locked(uint256 indexed depositId, uint256 indexed agentId, address indexed from, address layerWallet, uint256 measured, uint256 credits, uint256 totalIssued)',
      'event ReleaseReceived(address indexed from, uint256 amount, uint256 bnbAfter)',
      'event BoughtBack(address indexed by, uint8 venue, uint256 bnbSpent, uint256 bacBought, uint256 buybackBacAfter)',
      'event BridgeUpgraded(address indexed newImplementation, address indexed previousImplementation, address indexed by, uint64 upgradeNumber, uint64 at, uint256 bnbBook, uint256 lockedBacBook, uint256 buybackBacBook, uint256 owedTotalBook)',
      'event EmergencyWithdraw(address indexed by, address indexed to, address indexed token, uint256 amount, uint256 balanceAfter, uint256 bookAtWithdraw, uint256 lifetimeWithdrawn, uint64 withdrawNumber, uint64 at)',
      'event AgentControllerSet(uint256 indexed agentId, address indexed previous, address indexed current)',
      'event Paused(address indexed by, uint64 until_, uint64 cumulative)',
      'event Unpaused(address indexed by, uint64 cumulative)',
      'event Halted(uint8 cause)',
      'event EscapeArmed(address indexed by, uint8 cause, uint64 effectiveAt)',
      'event EscapeArmCancelled(address indexed by)',
      'event EpochOwedRevoked(uint64 indexed epoch, address indexed by, uint256 revoked)',
      // OpenZeppelin：Initializable、ERC1967Upgrade 与 Ownable2StepUpgradeable
      'event Initialized(uint8 version)',
      'event Upgraded(address indexed implementation)',
      'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
      'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)'
    ],
    nodeFund: [
      'function balance() view returns (uint256)',
      'function lifetimeReceived() view returns (uint256)',
      'function lifetimeWithdrawn() view returns (uint256)',
      'function owner() view returns (address)',
      'function pendingOwner() view returns (address)',
      'function bacToken() view returns (address)',
      'event ReleaseReceived(address indexed from, uint256 amount, uint256 balanceAfter)',
      'event Withdrawn(address indexed to, uint256 amount, uint256 balanceAfter)',
      'event OwnershipTransferStarted(address indexed from, address indexed to)',
      'event OwnershipTransferred(address indexed from, address indexed to)'
    ],
    /* ERC-8004 Identity Registry（contracts/src/interfaces/IERC8004Identity.sol，签名来自链上反汇编）：
       ownerOf 对没铸过的编号会 revert；getMetadata(id,"agentWallet") 的值是 20 个裸字节（不是 abi 编码的地址）；
       tokenURI 是持有人自己写的注册文件，谁都没核对过。 */
    identity: [
      'function name() view returns (string)',
      'function ownerOf(uint256 agentId) view returns (address)',
      'function getMetadata(uint256 agentId, string key) view returns (bytes)',
      'function tokenURI(uint256 agentId) view returns (string)'
    ],
    /* ChainAnchor：结构体按 contracts/src/interfaces/IChainAnchor.sol（12 个字段）。
       构造函数写的是占位值：lastPostedEpoch = firstEpoch − 1（让第一个锚点能过「纪元连续」检查）、
       lastFinalEpoch 不写（0）、lastFinalAt = 部署时间（停机计时从部署开始）。所以必须读 firstEpoch 才分得清
       「真的上报过」和「构造函数的占位」。SPEC 里的 cumulativeGasFees / cumulativeRemitted 合约里没有，不读。 */
    anchor: [
      'function firstEpoch() view returns (uint64)',
      'function lastPostedEpoch() view returns (uint64)',
      'function lastFinalEpoch() view returns (uint64)',
      'function lastFinalAt() view returns (uint64)',
      'function cumulativeCredited() view returns (uint256)',
      'function cumulativeExit() view returns (uint256)',
      'function haltReason() view returns (uint8)',
      'function vetoCountInWindow() view returns (uint8)',
      'function disputeCountInWindow() view returns (uint8)',
      'function releaseBpsFor(uint64 epoch) view returns (uint16)',
      'function getAnchor(uint64 epoch) view returns (tuple(bytes32 exitRoot,bytes32 l2BlockHash,uint64 l2Block,uint64 postedAt,uint64 finalizedAt,uint128 creditedInEpoch,uint128 exitCreditsInEpoch,uint128 feeBurnedInEpoch,uint128 circulating,uint32 exitCount,uint32 agreeingCount,uint8 state))'
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
      // 奖池按「天」记：epochReward(epoch) 其实就是 dayReward(epoch / 144)，给的是整天的池子。
      // 数据层直接读 dayReward(day) 并标成「天」，不把一天的池子标成「本纪元」。
      'function dayReward(uint64 day) view returns (uint256 pot, uint256 weight, uint256 rate, bool settled)',
      'function rewardOf(uint64 day, address validator) view returns (uint256)',
      'function revealerCount(uint64 epoch) view returns (uint256)',
      'function MIN_VALIDATOR_STAKE() view returns (uint256)'
      // 01 §11.5 的 proposerRights / proposerAddressOf / qualifyStreak / remitStatus / withheldOf / lastRemitEpoch
      // 在 ValidatorStaking.sol 里不存在（编译产物核对过），读了每轮都是 revert，所以不列。
      // 决策 #17 的 gas 归集对账改由索引器 /api/health 的 gas 块提供（来自 FINAL 锚点）。
    ],
    multicall3: [
      'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[] returnData)',
      'function getEthBalance(address addr) view returns (uint256 balance)'
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
    var list = logs ? CFG.logRpcs : CFG.rpcs;
    return Array.isArray(list) ? list.slice() : [];
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

  /* probed / available：只有 getCode 真的答了才定论（'0x' = 没有 Multicall3，整页改逐条）。
     探针本身没答上（网络错误）不下结论：这一轮先逐条读，retryAt 之后再探（退避同 RPC 那条公式）。 */
  var mcState = { probed: false, available: null, failures: 0, retryAt: 0 };

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

  /** multi() 的结果上挂一张不可枚举的失败表：key → 'revert'（合约拒绝，比如 ownerOf 对没铸过的编号）
      | 'error'（网络 / 解码）。Object.keys(out) 只看得到成功的那些。 */
  function failTable(out) {
    if (!out.__failed) Object.defineProperty(out, '__failed', { value: {}, enumerable: false });
    return out.__failed;
  }
  /** 另一张不可枚举的表：key → 读到它的那一批（aggregate3 的块号 0,1,2…；逐条 eth_call 是 -1）。
      同一块 aggregate3 里的读数来自同一个区块；-1 的每条可能落在不同区块上。 */
  function srcTable(out) {
    if (!out.__src) Object.defineProperty(out, '__src', { value: {}, enumerable: false });
    return out.__src;
  }

  /** Multicall3 是否存在：getCode 答了才定论；探针没答上 → 这一轮先逐条读，退避到期再探（不因一次网络抖动整页永久逐条）。 */
  function probeMulticall() {
    if (mcState.probed) return Promise.resolve(mcState.available);
    if (mcState.retryAt && Date.now() < mcState.retryAt) return Promise.resolve(false);
    return withRead(function (p) { return p.getCode(C.MULTICALL3); })
      .then(function (code) {
        mcState.probed = true;
        mcState.available = !!(code && code !== '0x');
        mcState.failures = 0; mcState.retryAt = 0;
        return mcState.available;
      })
      .catch(function () {
        mcState.failures++;
        mcState.retryAt = Date.now() + BAC.backoffMs(mcState.failures, 5000);
        return false;
      });
  }

  /** 逐条 eth_call 的退路，最多 6 条并发。 */
  function plainCalls(calls) {
    var out = {}, failed = failTable(out), src = srcTable(out), i = 0;
    function worker() {
      if (i >= calls.length) return Promise.resolve();
      var c = calls[i++];
      var data;
      try { data = iface(c.abiName).encodeFunctionData(c.fn, c.args); }
      catch (e) { failed[c.key] = 'error'; return worker(); }
      return withRead(function (p) { return p.call({ to: c.target, data: data }); })
        .then(function (ret) {
          var v = decode(c, ret);
          if (v === undefined) failed[c.key] = 'revert'; else { out[c.key] = v; src[c.key] = -1; }
        })
        .catch(function (e) { failed[c.key] = BAC.isRevert(e) ? 'revert' : 'error'; })
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

  /** 一批读。返回 { key: 值 }；某一条失败时该 key 是 undefined（逐条判失败），原因在 out.__failed[key]。 */
  function multi(calls) {
    var out = {};
    failTable(out);
    var src = srcTable(out);
    if (!calls.length) return Promise.resolve(out);
    return probeMulticall().then(function (ok) {
      if (!ok) return plainCalls(calls);
      var mc = iface('multicall3');
      var groups = chunk(calls, MC_CHUNK);
      var failed = out.__failed;
      return groups.reduce(function (chain, g, gi) {
        return chain.then(function () {
          var payload = [];
          var usable = [];
          g.forEach(function (c) {
            try {
              payload.push([c.target, true, iface(c.abiName).encodeFunctionData(c.fn, c.args)]);
              usable.push(c);
            } catch (e) { failed[c.key] = 'error'; /* 编码不了就跳过，等于这条失败 */ }
          });
          if (!payload.length) return;
          var data = mc.encodeFunctionData('aggregate3', [payload]);
          return withRead(function (p) { return p.call({ to: C.MULTICALL3, data: data }); })
            .then(function (ret) {
              var res = mc.decodeFunctionResult('aggregate3', ret)[0];
              for (var i = 0; i < usable.length; i++) {
                var row = res[i];
                if (!row || row[0] !== true) { failed[usable[i].key] = 'revert'; continue; } // success === false
                try {
                  var v = decode(usable[i], row[1]);
                  if (v === undefined) failed[usable[i].key] = 'revert'; else { out[usable[i].key] = v; src[usable[i].key] = gi; }
                } catch (e) { failed[usable[i].key] = 'error'; }
              }
            })
            .catch(function () {
              // 整块失败：退回逐条，宁可慢也不要整页空白
              return plainCalls(usable).then(function (o) {
                Object.assign(out, o);
                Object.keys(o.__failed).forEach(function (k) { failed[k] = o.__failed[k]; });
                Object.keys(o.__src).forEach(function (k) { src[k] = o.__src[k]; });
              });
            });
        });
      }, Promise.resolve()).then(function () { return out; });
    });
  }

  /* ══════════════════════════════════════════════════════
     4. 小工具：取值、地址、字节
     ══════════════════════════════════════════════════════ */

  var A = CFG.addresses;

  function num(v) { return v === undefined || v === null ? null : Number(v); }
  function str(v) { return v === undefined || v === null ? null : String(v); }
  function lc(a) { return typeof a === 'string' ? a.toLowerCase() : null; }
  function sameAddr(a, b) { return !!a && !!b && lc(a) === lc(b); }
  /** 读到的地址：零地址当「没有」（null），不当成一个地址显示。 */
  function addrOrNull(v) { var s = str(v); return isAddr(s) ? s : null; }
  /** ethers Result / 数组 / 对象 通吃：先按名字取，取不到按下标。
      按名字取到的是函数就不算：Result 是数组，字段名和 Array.prototype 撞车时（比如
      BacBridge.deposits 的 `at`）名字拿到的是 Array.prototype.at，必须改用下标。 */
  function pick(r, name, i) {
    if (r === undefined || r === null || typeof r !== 'object') return undefined;
    var v;
    try { v = r[name]; } catch (e) { v = undefined; }
    if (v !== undefined && typeof v !== 'function') return v;
    if (i !== undefined && r[i] !== undefined) return r[i];
    return undefined;
  }

  /** ERC-8004 getMetadata(id, "agentWallet") 的值：必须是 20 个裸字节（0x + 40 位十六进制），
      别的长度（包括空 = 没设置）一律 null —— 和合约 Erc8004Gate.walletOrZero 同一个口径，不猜。 */
  function walletFromMetadata(v) {
    if (typeof v !== 'string') return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
    return isAddr(v) ? v : null;
  }

  /** ERC1967 实现槽（32 字节）→ 地址；全零 = 不是代理 / 没设置 → null。 */
  function addrFromSlot(v) {
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) return null;
    var h = v.slice(2).padStart(64, '0');
    var a = '0x' + h.slice(24);
    return isAddr(a) ? a : null;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  /** base64 → 字节数组（不依赖 atob，node:vm 与浏览器同一份代码）。非法输入返回 null。 */
  function b64bytes(s) {
    s = String(s).replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    s = s.replace(/=+$/, '');
    if (/[^A-Za-z0-9+/]/.test(s)) return null;
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      buf = (buf << 6) | B64.indexOf(s.charAt(i));
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
    }
    return out;
  }
  /** UTF-8 字节 → 字符串（坏字节换成 U+FFFD，不抛）。 */
  function utf8(bytes) {
    var s = '', i = 0;
    while (i < bytes.length) {
      var c = bytes[i++], cp;
      if (c < 0x80) cp = c;
      else if (c >= 0xc0 && c < 0xe0 && i < bytes.length) cp = ((c & 0x1f) << 6) | (bytes[i++] & 0x3f);
      else if (c >= 0xe0 && c < 0xf0 && i + 1 < bytes.length) { cp = ((c & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
      else if (c >= 0xf0 && i + 2 < bytes.length) { cp = ((c & 0x07) << 18) | ((bytes[i] & 0x3f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3; }
      else cp = 0xfffd;
      s += String.fromCodePoint(cp);
    }
    return s;
  }

  var URI_KEEP = 2048;          // tokenURI 最多保留多少字符给页面（data: URI 可能很长）
  var URI_PARSE_MAX = 262144;   // 超过 256 KB 的注册文件不解析
  function clip(s, n) { return typeof s === 'string' ? (s.length > n ? s.slice(0, n) : s) : null; }

  /** ERC-8004 的 tokenURI（EIP-8004 注册文件）。**全部是持有人自述**：
      只从 data: URI 里取 name / description 两个字符串（截断），`image` 只记「有没有」，
      **绝不把它的 URL 交给页面去加载**；ipfs:// / https:// 的注册文件本站不去拉。 */
  function parseTokenURI(uri) {
    if (typeof uri !== 'string' || !uri) return { kind: null, selfReported: null };
    var kind = /^data:application\/json;base64,/i.test(uri) ? 'data'
      : (/^data:application\/json[;,]/i.test(uri) ? 'data'
        : (/^ipfs:\/\//i.test(uri) ? 'ipfs' : (/^https?:\/\//i.test(uri) ? 'http' : 'other')));
    var sr = null;
    // 主网上真有人把注册文件 gzip 之后再 base64（#10：data:application/json;enc=gzip;…）：本站不解压，照实说解不出来
    var header = kind === 'data' ? uri.slice(0, uri.indexOf(',') + 1) : '';
    if (kind === 'data' && uri.length <= URI_PARSE_MAX && !/enc=gzip/i.test(header)) {
      try {
        var body = uri.slice(uri.indexOf(',') + 1), text = null, j = null;
        if (/;base64,/i.test(header)) {
          var bytes = b64bytes(body);
          text = bytes ? utf8(bytes) : null;
          j = text ? JSON.parse(text) : null;
        } else {
          // 不带 base64 的：先当原文解析，不行再按 URL 编码解
          try { j = JSON.parse(body); } catch (e1) { j = JSON.parse(decodeURIComponent(body)); }
        }
        if (j && typeof j === 'object') {
          sr = {
            name: typeof j.name === 'string' ? clip(j.name, 200) : null,
            description: typeof j.description === 'string' ? clip(j.description, 1000) : null,
            hasImage: typeof j.image === 'string' && j.image.length > 0,
            note: TEXT.SELF_REPORTED
          };
        }
      } catch (e) { sr = null; }
    }
    return { kind: kind, selfReported: sr };
  }

  var PORTAL_STATUS = ['Invalid', 'Tradable', 'InDuel', 'Killed', 'DEX', 'Staged'];
  var PORTAL_STATUS_ZH = ['无效', '内盘交易中', '对决中', '已终止', '已上 DEX', '待开放'];
  var VENUE = ['none', 'curve', 'pancakeV2'];

  /* ══════════════════════════════════════════════════════
     5. 三阶段探针：地址上有没有代码（eth_getCode，结果缓存，只从 false 翻到 true）
     ══════════════════════════════════════════════════════ */

  function probeCodes(force) {
    var P = BAC.state.bsc.code;
    var need = [];
    if (isAddr(A.token) && P.token !== true) need.push('token');
    if (isAddr(A.router) && P.router !== true) need.push('router');
    if (isAddr(A.bridge) && P.bridge !== true) need.push('bridge');
    if (!need.length) {
      if (!BAC.STAGE_KNOWN) BAC.setStage(false, false);
      return Promise.resolve(false);
    }
    if (!force && P.at && Date.now() - P.at < CFG.codeProbeMs) return Promise.resolve(false);
    P.at = Date.now();
    var resolved = 0;
    return Promise.all(need.map(function (k) {
      return withRead(function (p) { return p.getCode(A[k]); })
        .then(function (code) { P[k] = !!(code && code !== '0x'); resolved++; })
        .catch(function () { /* 探失败：保持原值（null = 不知道），下一轮再探 */ });
    })).then(function () {
      if (!resolved) { P.at = null; return false; }
      BAC.setStage(P.router === true && P.bridge === true, P.token === true);
      // 配置里填了地址、链上却没有代码：要么还没部署，要么地址填错了
      if ((P.router === false || P.bridge === false) && BAC.CONTRACTS_CONFIGURED) BAC.pushWarning('contracts_no_code');
      else BAC.clearWarning('contracts_no_code');
      return true;
    });
  }

  /* ══════════════════════════════════════════════════════
     6. 读 BSC：接线参数（一次）+ 代币参数（发射后一次）+ 活数据（每轮）
     ══════════════════════════════════════════════════════ */

  /* 接线参数与代币参数：**逐个 key 累积**。某一条这一轮没读到（网络抖动 / 那一条 revert），只把它留到下一轮补读，
     已经读到的不重读；没读到的那一项绝不当成「核对通过」（wiring.ok = null，不是 true）。
     升级过（upgradeCount 变了）或实现槽变了 → 清空重读（接线可能跟着实现一起变了）。 */
  var paramRaw = {};        // key → 读到的原始值（接线参数）
  var tokenRaw = {};        // key → 读到的原始值（代币参数）
  function resetParams() {
    paramRaw = {};
    var P = BAC.state.bsc.params;
    if (P) P.complete = false;   // 下一轮 liveTick 看到 complete = false 就会全部重读
  }

  // 接线核对与决策 #29a 那句要用到的 key：这些都读到了 loaded 才是 true。
  // 其余（PUSH_GAS / watchdog / EXTENSION / 两段说明文字 / firstEpoch）缺了照样每轮补读，只是不挡 loaded。
  var PARAM_REQUIRED = ['r.token', 'r.bridge', 'r.nodeFund', 'r.bps', 'b.token', 'b.identity', 'b.anchor', 'b.portal',
    'b.dexRouter', 'b.notice', 'n.token'];

  function paramCalls() {
    var calls = [];
    if (isAddr(A.router)) calls.push(
      call(A.router, 'router', 'r.token', 'bacToken'),
      call(A.router, 'router', 'r.bridge', 'bridge'),
      call(A.router, 'router', 'r.nodeFund', 'nodeFund'),
      call(A.router, 'router', 'r.bps', 'BRIDGE_BPS'),
      call(A.router, 'router', 'r.pushGas', 'PUSH_GAS')
    );
    if (isAddr(A.bridge)) calls.push(
      call(A.bridge, 'bridge', 'b.token', 'bacToken'),
      call(A.bridge, 'bridge', 'b.identity', 'identityRegistry'),
      call(A.bridge, 'bridge', 'b.anchor', 'anchor'),
      call(A.bridge, 'bridge', 'b.watchdog', 'watchdog'),
      call(A.bridge, 'bridge', 'b.portal', 'portal'),
      // BacBridge.router() 是 PancakeSwap V2 Router（毕业后回购走外盘），**不是** BacTaxRouter
      call(A.bridge, 'bridge', 'b.dexRouter', 'router'),
      call(A.bridge, 'bridge', 'b.extension', 'EXTENSION'),
      call(A.bridge, 'bridge', 'b.notice', 'OWNER_POWER_NOTICE'),
      call(A.bridge, 'bridge', 'b.idNotice', 'IDENTITY_LIMIT_NOTICE'),
      call(A.bridge, 'bridge', 'b.description', 'description')
    );
    if (isAddr(A.nodeFund)) calls.push(call(A.nodeFund, 'nodeFund', 'n.token', 'bacToken'));
    if (isAddr(A.anchor)) calls.push(call(A.anchor, 'anchor', 'a.first', 'firstEpoch'));
    return calls;
  }

  /** 合约接线（不可变参数 + 互相核对）。只读还缺的那几条，结果与之前读到的合在一起整形。 */
  function loadParams() {
    var all = paramCalls();
    var need = all.filter(function (c) { return paramRaw[c.key] === undefined; });
    return multi(need).then(function (o) {
      need.forEach(function (c) { if (o[c.key] !== undefined) paramRaw[c.key] = o[c.key]; });
      return shapeParams(paramRaw, all);
    });
  }

  function shapeParams(o, all) {
    var keys = all.map(function (c) { return c.key; });
    var missing = keys.filter(function (k) { return o[k] === undefined; });
    var bps = num(o['r.bps']);
    var p = {
      router: {
        address: A.router,
        bacToken: addrOrNull(o['r.token']), bridge: addrOrNull(o['r.bridge']), nodeFund: addrOrNull(o['r.nodeFund']),
        bridgeBps: bps, nodeFundBps: bps === null ? null : C.BPS - bps,
        pushGas: num(o['r.pushGas']),
        owner: null            // 没有 owner：合约里不存在任何检查 msg.sender 的函数（决策 #30）
      },
      bridge: {
        address: A.bridge,
        bacToken: addrOrNull(o['b.token']), identityRegistry: addrOrNull(o['b.identity']),
        anchor: addrOrNull(o['b.anchor']), watchdog: addrOrNull(o['b.watchdog']),
        portal: addrOrNull(o['b.portal']),
        dexRouter: addrOrNull(o['b.dexRouter']),     // BacBridge.router() = PancakeSwap V2 Router
        extension: addrOrNull(o['b.extension']),
        ownerPowerNotice: str(o['b.notice']), identityLimitNotice: str(o['b.idNotice']),
        description: str(o['b.description'])
      },
      nodeFund: { address: A.nodeFund, bacToken: addrOrNull(o['n.token']) },
      // 不可变：第一个能锚定的纪元（部署所在纪元）。null = 没读到（readLive 也会补读）
      anchor: { address: A.anchor, firstEpoch: num(o['a.first']) },
      missing: missing,
      // loaded：接线核对与 #29a 那句要用的每一条都读到了；complete：连说明文字这些也都读到了（之后不再读）
      loaded: keys.length > 0 && PARAM_REQUIRED.every(function (k) { return keys.indexOf(k) < 0 || o[k] !== undefined; }),
      complete: missing.length === 0
    };
    /* 接线核对：任何一处对不上都是事故（税会进错地方），告警并列出是哪一处。
       - 配置里那一项还没填（'0x0'）= 没法核对，不算对不上（否则没填的地址会拉响「税进错地方」的假警报）；
       - 那一条还没读到 = 没核对过，记进 unchecked，wiring.ok = null —— **绝不算通过**；
       - 读回来是零地址 = 对不上（未初始化的代理就是这样）。 */
    var mm = [], unchecked = [], checked = 0;
    function chk(name, key, want) {
      if (keys.indexOf(key) < 0 || !isAddr(want)) return;
      var got = o[key];
      if (got === undefined) { unchecked.push(name); return; }
      checked++;
      if (!sameAddr(str(got), want)) mm.push(name);
    }
    chk('router.bacToken', 'r.token', A.token);
    chk('router.bridge', 'r.bridge', A.bridge);
    chk('router.nodeFund', 'r.nodeFund', A.nodeFund);
    chk('bridge.bacToken', 'b.token', A.token);
    chk('bridge.dexRouter', 'b.dexRouter', CFG.pancakeRouter);
    chk('bridge.identityRegistry', 'b.identity', CFG.identityRegistry);
    chk('bridge.portal', 'b.portal', CFG.flapPortal);
    chk('bridge.anchor', 'b.anchor', A.anchor);
    chk('nodeFund.bacToken', 'n.token', A.token);
    p.wiring = {
      ok: mm.length ? false : ((unchecked.length || !checked) ? null : true),
      mismatches: mm,
      unchecked: unchecked
    };
    if (mm.length) BAC.pushWarning('wiring_mismatch'); else BAC.clearWarning('wiring_mismatch');
    // 决策 #29a：链上那句必须与网站逐字一致（没读到 = null，不是「一致」）
    p.noticeMatches = p.bridge.ownerPowerNotice === null ? null : p.bridge.ownerPowerNotice === TEXT.OWNER_POWER;
    if (p.noticeMatches === false) BAC.pushWarning('owner_notice_mismatch'); else BAC.clearWarning('owner_notice_mismatch');
    return p;
  }

  function tokenCalls() {
    var T = A.token;
    return [
      call(T, 'token', 't.name', 'name'),
      call(T, 'token', 't.symbol', 'symbol'),
      call(T, 'token', 't.decimals', 'decimals'),
      call(T, 'token', 't.totalSupply', 'totalSupply'),
      call(T, 'token', 't.taxRate', 'taxRate'),
      call(T, 'token', 't.buyTax', 'buyTaxRate'),
      call(T, 'token', 't.sellTax', 'sellTaxRate'),
      call(T, 'token', 't.processor', 'taxProcessor')
    ];
  }
  function processorCalls(proc) {
    return [
      call(proc, 'taxProcessor', 'p.market', 'marketAddress'),
      call(proc, 'taxProcessor', 'p.cfg', 'feeConfigV2')
    ];
  }

  /** 代币参数：只在 TOKEN_LIVE 之后读（发射前那个地址上没有代码，读了也是空）。同样逐个 key 累积、缺的下一轮补。
      taxProcessor / marketAddress / feeConfigV2 任何一条没读到，loaded 都是 false（决策 #30 的硬检查不许停在 null 上）。 */
  function loadTokenParams() {
    var need = tokenCalls().filter(function (c) { return tokenRaw[c.key] === undefined; });
    return multi(need).then(function (o) {
      need.forEach(function (c) { if (o[c.key] !== undefined) tokenRaw[c.key] = o[c.key]; });
      var proc = addrOrNull(tokenRaw['t.processor']);
      if (!proc) return null;
      var pc = processorCalls(proc).filter(function (c) { return tokenRaw[c.key] === undefined; });
      return multi(pc).then(function (p) {
        pc.forEach(function (c) { if (p[c.key] !== undefined) tokenRaw[c.key] = p[c.key]; });
      });
    }).catch(function () { /* 这一轮没读成：缺的下一轮补 */ }).then(function () { return shapeTokenParams(tokenRaw); });
  }

  function shapeTokenParams(o) {
    var T = A.token;
    var proc = addrOrNull(o['t.processor']);
    var keys = tokenCalls().map(function (c) { return c.key; });
    if (proc) keys = keys.concat(['p.market', 'p.cfg']);
    var missing = keys.filter(function (k) { return o[k] === undefined; });
    var tp = {
      address: T,
      name: str(o['t.name']), symbol: str(o['t.symbol']),
      decimals: o['t.decimals'] === undefined ? null : Number(o['t.decimals']),
      totalSupply: big(o['t.totalSupply']),
      taxRate: num(o['t.taxRate']), buyTaxRate: num(o['t.buyTax']), sellTaxRate: num(o['t.sellTax']),
      taxProcessor: proc,
      taxFeeRateBps: null, marketAddress: null, marketAddressOk: null,
      missing: missing,
      // 硬检查要用的三条（taxProcessor，以及它的 marketAddress / feeConfigV2）都读到了才算 loaded
      loaded: o['t.processor'] !== undefined && (!proc || (o['p.market'] !== undefined && o['p.cfg'] !== undefined)),
      complete: missing.length === 0
    };
    if (proc && o['p.market'] !== undefined) {
      tp.marketAddress = str(o['p.market']);
      // 决策 #30 的硬检查：marketAddress 必须就是我们的 BacTaxRouter，否则税根本进不来。
      // 配置里还没填 router = 没法核对（null），不是「对不上」
      tp.marketAddressOk = isAddr(A.router) ? sameAddr(tp.marketAddress, A.router) : null;
    }
    // feeConfigV2().feeRate = Flap 协议先抽走的那一层（实测 1000 = 10%），50/50 分的是剩下的部分
    if (proc && o['p.cfg'] !== undefined) tp.taxFeeRateBps = num(pick(o['p.cfg'], 'feeRate', 4));
    if (tp.marketAddressOk === false) BAC.pushWarning('market_address_mismatch');
    else BAC.clearWarning('market_address_mismatch');
    return tp;
  }

  /** 每次刷新都读的活数据。 */
  function readLive(epochHint) {
    var epoch = epochHint === null || epochHint === undefined ? BAC.currentEpoch() : epochHint;
    var calls = [];

    if (BAC.CONTRACTS_LIVE) {
      if (isAddr(A.router)) {
        calls.push(
          call(A.router, 'router', 'v.accounted', 'accountedQuote'),
          call(A.router, 'router', 'v.unsplit', 'unsplitRevenue'),
          call(A.router, 'router', 'v.toBridge', 'lifetimeToBridge'),
          call(A.router, 'router', 'v.toNode', 'lifetimeToNodeFund'),
          call(A.router, 'router', 'v.recognized', 'totalRecognized'),
          call(A.router, 'router', 'v.stuck', 'stuckAmounts'),
          call(A.router, 'router', 'v.solvency', 'solvency'),
          call(C.MULTICALL3, 'multicall3', 'bal.router', 'getEthBalance', [A.router])
        );
      }
      if (isAddr(A.bridge)) {
        calls.push(
          call(A.bridge, 'bridge', 'b.owner', 'owner'),
          call(A.bridge, 'bridge', 'b.pendingOwner', 'pendingOwner'),
          call(A.bridge, 'bridge', 'b.locked', 'lockedBac'),
          call(A.bridge, 'bridge', 'b.burned', 'totalBurned'),
          call(A.bridge, 'bridge', 'b.issued', 'totalCreditsIssued'),
          call(A.bridge, 'bridge', 'b.exited', 'totalCreditsExited'),
          call(A.bridge, 'bridge', 'b.outstanding', 'creditsOutstanding'),
          call(A.bridge, 'bridge', 'b.depositId', 'depositId'),
          call(A.bridge, 'bridge', 'b.buybackBac', 'buybackBac'),
          call(A.bridge, 'bridge', 'b.bnbBook', 'bnbBalance'),
          call(A.bridge, 'bridge', 'b.budget', 'buybackBudget'),
          call(A.bridge, 'bridge', 'b.bought', 'buybackBacBought'),
          call(A.bridge, 'bridge', 'b.spent', 'buybackBnbSpent'),
          call(A.bridge, 'bridge', 'b.bacAccounted', 'bacAccounted'),
          call(A.bridge, 'bridge', 'b.buybackState', 'buybackState'),
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
          call(A.bridge, 'bridge', 'b.escape', 'escapeState'),
          // owner 权力（决策 #29 / #29c）：计数器是全量的，日志只看得到最近一个窗口
          call(A.bridge, 'bridge', 'b.upgrades', 'upgradeCount'),
          call(A.bridge, 'bridge', 'b.lastUpgradeAt', 'lastUpgradeAt'),
          call(A.bridge, 'bridge', 'b.emBnb', 'emergencyBnbWithdrawn'),
          call(A.bridge, 'bridge', 'b.emBac', 'emergencyBacWithdrawn'),
          call(A.bridge, 'bridge', 'b.emCount', 'emergencyCount'),
          call(A.bridge, 'bridge', 'b.lastEmAt', 'lastEmergencyAt'),
          // 发射前 shortfall() 会 revert（它要读代币余额，而代币地址上还没有代码）→ 由下面两个数自己推
          call(A.bridge, 'bridge', 'b.shortfall', 'shortfall'),
          call(C.MULTICALL3, 'multicall3', 'bal.bridge', 'getEthBalance', [A.bridge])
        );
      }
      if (isAddr(A.nodeFund)) {
        calls.push(
          call(A.nodeFund, 'nodeFund', 'n.balance', 'balance'),
          call(A.nodeFund, 'nodeFund', 'n.received', 'lifetimeReceived'),
          call(A.nodeFund, 'nodeFund', 'n.withdrawn', 'lifetimeWithdrawn'),
          call(A.nodeFund, 'nodeFund', 'n.owner', 'owner'),
          call(A.nodeFund, 'nodeFund', 'n.pendingOwner', 'pendingOwner')
        );
      }
      if (isAddr(A.staking)) {
        calls.push(
          call(A.staking, 'staking', 's.staked', 'totalStaked'),
          call(A.staking, 'staking', 's.nodes', 'nodeCount'),
          call(A.staking, 'staking', 's.rewardBal', 'rewardBalance'),
          call(A.staking, 'staking', 's.funded', 'lifetimeFunded'),
          call(A.staking, 'staking', 's.paid', 'lifetimePaid')
        );
      }
      if (isAddr(A.anchor)) {
        calls.push(
          call(A.anchor, 'anchor', 'a.posted', 'lastPostedEpoch'),
          call(A.anchor, 'anchor', 'a.final', 'lastFinalEpoch'),
          call(A.anchor, 'anchor', 'a.finalAt', 'lastFinalAt'),
          call(A.anchor, 'anchor', 'a.cumCredited', 'cumulativeCredited'),
          call(A.anchor, 'anchor', 'a.cumExit', 'cumulativeExit'),
          call(A.anchor, 'anchor', 'a.haltReason', 'haltReason'),
          call(A.anchor, 'anchor', 'a.vetoes', 'vetoCountInWindow'),
          call(A.anchor, 'anchor', 'a.disputes', 'disputeCountInWindow'),
          call(A.anchor, 'anchor', 'a.releaseBps', 'releaseBpsFor', [epoch])
        );
        // firstEpoch 是不可变的，接线参数里读到过就不再读；没读到（那一条失败了）就每轮补一次
        if (anchorFirstEpoch() === null) calls.push(call(A.anchor, 'anchor', 'a.first', 'firstEpoch'));
      }
    }

    // 代币发射之后才存在的那些数（价格 / 内盘进度 / 待分发税 / 桥里真实的 BAC）
    if (BAC.TOKEN_LIVE && isAddr(A.token)) {
      calls.push(call(CFG.flapPortal, 'portal', 'tk.portal', 'getTokenV8Safe', [A.token]));
      if (isAddr(A.bridge)) calls.push(call(A.token, 'token', 'tk.bridgeBac', 'balanceOf', [A.bridge]));
      var tp = BAC.state.bsc.tokenParams;
      if (tp && tp.taxProcessor) {
        calls.push(
          call(tp.taxProcessor, 'taxProcessor', 'tk.pendingTax', 'marketQuoteBalance'),
          call(tp.taxProcessor, 'taxProcessor', 'tk.sentToRouter', 'totalQuoteSentToMarketing')
        );
      }
    }
    return multi(calls);
  }

  /* ChainAnchor.firstEpoch：不可变，读到一次就缓存（接线参数里读，失败了由 readLive 补读）。 */
  var anchorFirst = null;
  function anchorFirstEpoch() {
    if (anchorFirst !== null) return anchorFirst;
    var p = BAC.state.bsc.params;
    var v = p && p.anchor ? p.anchor.firstEpoch : null;
    if (v !== null && v !== undefined && isFinite(Number(v))) anchorFirst = Number(v);
    return anchorFirst;
  }
  function noteFirstEpoch(v) {
    if (anchorFirst === null && v !== undefined && v !== null && isFinite(Number(v))) anchorFirst = Number(v);
  }

  /** 纪元 → ValidatorStaking 的「天」（奖池按天记，144 个纪元一天）。 */
  function dayOf(epoch) {
    if (epoch === null || epoch === undefined || !isFinite(Number(epoch))) return null;
    return Math.floor(Number(epoch) / C.EPOCHS_PER_DAY);
  }

  /** 第二跳：拿到 lastPostedEpoch 之后再读那个纪元的锚点，以及它所在那一天的奖池（dayReward(day)）。
      firstEpoch 之前的纪元一个锚点都不可能有（构造函数的占位 firstEpoch − 1 就是这种），不读。 */
  function readEpoch(epoch) {
    if (epoch === null || epoch === undefined || !BAC.CONTRACTS_LIVE) return Promise.resolve({});
    var first = anchorFirstEpoch();
    if (first !== null && Number(epoch) < first) return Promise.resolve({});
    var calls = [];
    if (isAddr(A.anchor)) calls.push(call(A.anchor, 'anchor', 'e.anchor', 'getAnchor', [epoch]));
    if (isAddr(A.staking)) calls.push(call(A.staking, 'staking', 'e.dayReward', 'dayReward', [dayOf(epoch)]));
    return multi(calls);
  }

  /** ERC1967 实现槽：**每一轮都读**（一条 eth_getStorageAt，很便宜）。
      upgradeCount 是实现合约自己在 _authorizeUpgrade 里写的，而 owner 可以装任何实现（#29）：新实现完全可以改槽
      却不加计数、不发 BridgeUpgraded。所以计数器不能当「要不要重读」的信号 —— #29c 要让 owner 的动作看得见，
      它依赖的信号就不能由 owner 控制。槽变了而同一轮读到的计数器没变 → 一次没留痕的换实现：告警并记下来。 */
  var implCache = { count: null, impl: null, raw: null, fresh: false };
  var implChanges = [];      // 本页看到的「槽变了、计数器没变」：{ from, to, upgradeCount, block, detectedAt }
  function readImplementation(upgradeCount, block) {
    if (!isAddr(A.bridge) || !BAC.CONTRACTS_LIVE) return Promise.resolve(null);
    var n = upgradeCount === undefined || upgradeCount === null ? null : Number(upgradeCount);
    return withRead(function (p) {
      return typeof p.getStorage === 'function' ? p.getStorage(A.bridge, C.ERC1967_IMPL_SLOT)
        : p.send('eth_getStorageAt', [A.bridge, C.ERC1967_IMPL_SLOT, 'latest']);
    }).then(function (v) {
      var impl = addrFromSlot(v);
      var prev = { raw: implCache.raw, impl: implCache.impl, count: implCache.count };
      implCache.raw = v; implCache.impl = impl; implCache.count = n; implCache.fresh = true;
      if (prev.raw === null || lc(prev.impl) === lc(impl)) return impl;
      resetParams();       // 实现换了：接线可能跟着变了，下一轮全部重读
      if (n === null || prev.count === null || n !== prev.count) return impl;   // 计数器跟着变了 = 正常升级
      /* 槽变了、计数器看起来没变。计数器是在读槽**之前**读的：一次正常升级恰好落在两次读之间也会是这个样子。
         所以读槽之后再读一次计数器 —— 还是没变，才是真的没留痕。 */
      return multi([call(A.bridge, 'bridge', 'u.recheck', 'upgradeCount')]).then(function (o2) {
        var n2 = o2['u.recheck'] === undefined ? null : Number(o2['u.recheck']);
        if (n2 !== null) implCache.count = n2;
        if (n2 !== null && n2 === prev.count) {
          implChanges.push({ from: prev.impl, to: impl, upgradeCount: n2,
            block: block === undefined ? null : block, detectedAt: Math.floor(Date.now() / 1000) });
          BAC.pushWarning('implementation_changed_unlogged');
        }
        return impl;
      });
    }).catch(function () {
      implCache.fresh = false;
      // 读失败：缓存只有在「升级次数没变」时才可能还是当前实现（照样标成不是这一轮读到的）；
      // 升级过了（或次数不知道）就不能拿旧实现冒充现在的
      return (implCache.raw !== null && n !== null && implCache.count === n) ? implCache.impl : null;
    });
  }

  /* ══════════════════════════════════════════════════════
     7. BSC 日志 → 三条时间线（owner 权力 / 税收流向 / 节点基金）
        公共节点只给最近一个窗口（publicnode 实测约 6000 块，之外报 "Archive requests require a
        personal token"；bsc-dataseed 的 eth_getLogs 一律 -32005）。所以：
        - 首次只扫最近 logWindowBlocks 块（配置了 deployBlock 且还在窗口里就从 deployBlock 扫 → 全量）；
        - 之后每轮只扫新块；标签页睡过头超过窗口 → 记一段 gap，complete = false；
        - 「全量吗」由视图拿合约计数器（upgradeCount / emergencyCount）来对，缺几条就说缺几条。
     ══════════════════════════════════════════════════════ */

  var blockTs = {};                  // 块号 → 时间戳（秒），读到过就不再读
  var seenLog = {};                  // tx:logIndex → true（去重）

  function logKey(l) { return String(l.transactionHash) + ':' + String(l.index !== undefined ? l.index : l.logIndex); }

  function ifaceForAddr(a) {
    if (sameAddr(a, A.router)) return 'router';
    if (sameAddr(a, A.bridge)) return 'bridge';
    if (sameAddr(a, A.nodeFund)) return 'nodeFund';
    return null;
  }

  function targetName(a) {
    if (sameAddr(a, A.bridge)) return 'bridge';
    if (sameAddr(a, A.nodeFund)) return 'nodeFund';
    if (sameAddr(a, A.router)) return 'router';
    return 'other';
  }

  /** 一条原始日志 → { list: 'owner'|'flow'|'nodeFund', item } 或 null（不认识 / 不上时间线）。 */
  function decodeLog(l) {
    var which = ifaceForAddr(l.address);
    if (!which) return null;
    var ev;
    try { ev = iface(which).parseLog({ topics: l.topics, data: l.data }); } catch (e) { ev = null; }
    if (!ev || !ev.name) return null;
    return shapeEvent(which, ev.name, ev.args || {}, {
      block: num(l.blockNumber), tx: str(l.transactionHash),
      logIndex: num(l.index !== undefined ? l.index : l.logIndex),
      ts: null, source: 'rpc'
    });
  }

  /** 一个已解码的事件（名字 + 参数）→ 时间线条目。BSC 日志（ethers Result，名字或下标都能取）和
      索引器 /api/bridge/timeline（普通对象，按名字取，金额是十进制字符串）共用这一份，两边形状一模一样。
      which = 'bridge' | 'router' | 'nodeFund'；base 里带 block / tx / logIndex / ts / source。 */
  function shapeEvent(which, name, a, base) {
    base = Object.assign({ event: name, contract: which, block: null, tx: null, logIndex: null, ts: null, source: null }, base || {});
    base.event = name; base.contract = which;
    var ev = { name: name };
    function g(n, i) { return pick(a, n, i); }
    var it = null, list = null;

    if (which === 'bridge') {
      list = 'owner';
      switch (ev.name) {
        case 'BridgeUpgraded':
          it = { kind: 'upgrade', newImplementation: str(g('newImplementation', 0)), previousImplementation: str(g('previousImplementation', 1)),
            by: str(g('by', 2)), number: num(g('upgradeNumber', 3)), ts: num(g('at', 4)),
            books: { bnb: big(g('bnbBook', 5)), lockedBac: big(g('lockedBacBook', 6)), buybackBac: big(g('buybackBacBook', 7)), owedTotal: big(g('owedTotalBook', 8)) },
            implementationConfirmed: null };
          break;
        case 'Upgraded':
          // initial / unlogged 由 mergeUpgrades 定：和 Initialized(1) 同一笔交易 = 代理部署时的初始实现；
          // 否则（同一笔里也没有 BridgeUpgraded）= 一次没留 BridgeUpgraded 的换实现
          it = { kind: 'implementation', implementation: str(g('implementation', 0)), initial: null, unlogged: null };
          break;
        case 'EmergencyWithdraw': {
          var tok = str(g('token', 2));
          it = { kind: 'emergency', by: str(g('by', 0)), to: str(g('to', 1)), token: isAddr(tok) ? tok : null,
            asset: !isAddr(tok) ? 'BNB' : (sameAddr(tok, A.token) ? 'BAC' : 'TOKEN'),
            amount: big(g('amount', 3)), balanceAfter: big(g('balanceAfter', 4)), bookAtWithdraw: big(g('bookAtWithdraw', 5)),
            lifetimeWithdrawn: big(g('lifetimeWithdrawn', 6)), number: num(g('withdrawNumber', 7)), ts: num(g('at', 8)) };
          break;
        }
        case 'OwnershipTransferStarted':
          it = { kind: 'ownershipStarted', from: str(g('previousOwner', 0)), to: str(g('newOwner', 1)) };
          break;
        case 'OwnershipTransferred':
          it = { kind: 'ownership', from: str(g('previousOwner', 0)), to: str(g('newOwner', 1)) };
          break;
        case 'Paused':
          it = { kind: 'pause', by: str(g('by', 0)), until: num(g('until_', 1)), cumulative: num(g('cumulative', 2)) };
          break;
        case 'Unpaused':
          it = { kind: 'unpause', by: str(g('by', 0)), cumulative: num(g('cumulative', 1)) };
          break;
        case 'Halted':
          it = { kind: 'halt', cause: num(g('cause', 0)) };
          break;
        case 'EscapeArmed':
          it = { kind: 'escapeArmed', by: str(g('by', 0)), cause: num(g('cause', 1)), effectiveAt: num(g('effectiveAt', 2)) };
          break;
        case 'EscapeArmCancelled':
          it = { kind: 'escapeArmCancelled', by: str(g('by', 0)) };
          break;
        case 'EpochOwedRevoked':
          it = { kind: 'owedRevoked', epoch: num(g('epoch', 0)), by: str(g('by', 1)), revoked: big(g('revoked', 2)) };
          break;
        case 'Initialized':
          // 代理部署时 initialize() 发的（version 1）：时间线从这里开始才算从部署起
          it = { kind: 'initialized', version: num(g('version', 0)) };
          break;
        case 'ReleaseReceived':
          list = 'flow';
          it = { kind: 'bridgeReceived', from: str(g('from', 0)), amount: big(g('amount', 1)), bnbAfter: big(g('bnbAfter', 2)) };
          break;
        case 'BoughtBack': {
          list = 'flow';
          var vn = num(g('venue', 1));
          it = { kind: 'buyback', by: str(g('by', 0)), venue: vn, venueName: VENUE[vn] || null,
            bnbSpent: big(g('bnbSpent', 2)), bacBought: big(g('bacBought', 3)), buybackBacAfter: big(g('buybackBacAfter', 4)) };
          break;
        }
        default: return null;   // Locked / ExitClaimed / … 不上 owner 时间线（agent 名录走 deposits()）
      }
    } else if (which === 'router') {
      list = 'flow';
      switch (ev.name) {
        case 'RevenueRecognized':
          it = { kind: 'recognized', from: str(g('from', 0)), amount: big(g('amount', 1)) };
          break;
        case 'RevenueSplit':
          it = { kind: 'split', toBridge: big(g('toBridge', 0)), toNodeFund: big(g('toNodeFund', 1)) };
          break;
        case 'PushSucceeded':
        case 'PushFailed': {
          var to = str(g('to', 0));
          it = { kind: 'push', ok: ev.name === 'PushSucceeded', to: to, target: targetName(to), amount: big(g('amount', 1)) };
          break;
        }
        default: return null;
      }
    } else {
      list = 'nodeFund';
      switch (ev.name) {
        case 'ReleaseReceived':
          it = { kind: 'received', from: str(g('from', 0)), amount: big(g('amount', 1)), balanceAfter: big(g('balanceAfter', 2)) };
          break;
        case 'Withdrawn':
          it = { kind: 'withdraw', to: str(g('to', 0)), amount: big(g('amount', 1)), balanceAfter: big(g('balanceAfter', 2)) };
          break;
        case 'OwnershipTransferStarted':
          it = { kind: 'ownershipStarted', from: str(g('from', 0)), to: str(g('to', 1)) };
          break;
        case 'OwnershipTransferred':
          it = { kind: 'ownership', from: str(g('from', 0)), to: str(g('to', 1)) };
          break;
        default: return null;
      }
    }
    // 事件里自带时间（BridgeUpgraded.at / EmergencyWithdraw.at）就用它，否则用来源给的块时间（没有就是 null）
    var baseTs = base.ts === undefined ? null : base.ts;
    var out = Object.assign(base, it);
    if (out.ts === undefined || out.ts === null) out.ts = baseTs;
    return { list: list, item: out };
  }

  function byRecency(a, b) {
    if (a.block !== b.block) return (b.block || 0) - (a.block || 0);
    return (b.logIndex || 0) - (a.logIndex || 0);
  }

  /** 同一条时间线的几个来源（BSC 日志窗口 / 索引器全量）合并：按 tx:logIndex 去重（排在前面的来源优先，
      后面的只补它缺的时间戳），新 → 旧排序；owner 那条再把同一笔交易里的 BridgeUpgraded + Upgraded 并成一次升级。
      **不改入参**（条目都是拷贝）。 */
  function mergeTimeline(lists, isOwner) {
    var seen = {}, out = [];
    (lists || []).forEach(function (arr) {
      (arr || []).forEach(function (x) {
        if (!x || typeof x !== 'object') return;
        var k = String(x.tx) + ':' + String(x.logIndex);
        var prev = seen[k];
        if (prev) {
          if ((prev.ts === null || prev.ts === undefined) && x.ts !== null && x.ts !== undefined) prev.ts = x.ts;
          return;
        }
        var c = Object.assign({}, x);
        seen[k] = c;
        out.push(c);
      });
    });
    out.sort(byRecency);
    return isOwner ? mergeUpgrades(out) : out;
  }

  /** 同一笔交易里的 BridgeUpgraded + Upgraded 是同一次升级：把 Upgraded 并进去（核对实现地址），不重复显示。
      单独的 Upgraded：只有和 Initialized(1) 在同一笔交易里（代理部署：ERC1967Proxy 构造函数发 Upgraded，
      紧接着 initialize() 发 Initialized）才是「初始实现」（initial = true）；别的一律是一次没留 BridgeUpgraded 的
      换实现（unlogged = true）—— owner 能装任何实现（#29），新实现不发 BridgeUpgraded 也照样能升级。 */
  function mergeUpgrades(list) {
    var byTx = {}, initTx = {};
    list.forEach(function (x) {
      if (x.kind === 'upgrade') byTx[x.tx] = x;
      if (x.kind === 'initialized' && x.version === 1) initTx[x.tx] = true;
    });
    return list.filter(function (x) {
      if (x.kind !== 'implementation') return true;
      var u = byTx[x.tx];
      if (!u) {
        x.initial = !!initTx[x.tx];
        x.unlogged = !x.initial;
        return true;
      }
      u.implementationConfirmed = sameAddr(u.newImplementation, x.implementation);
      return false;
    });
  }

  function addLogs(logs) {
    var T = BAC.state.timeline;
    var added = 0;
    (logs || []).forEach(function (l) {
      var k = logKey(l);
      if (seenLog[k]) return;
      var d = decodeLog(l);
      seenLog[k] = true;
      if (!d) return;
      if (d.item.ts === null && blockTs[d.item.block] !== undefined) d.item.ts = blockTs[d.item.block];
      T[d.list].push(d.item);
      added++;
    });
    if (added) {
      ['owner', 'flow', 'nodeFund'].forEach(function (k) {
        var arr = T[k].sort(byRecency);
        if (k === 'owner') arr = mergeUpgrades(arr);
        if (arr.length > CFG.timelineMax) {
          // 超出上限：丢最旧的那些，记下「这条列表不全了」以及丢到了哪个块（这一页里再也补不回来）
          T.truncated[k] = true;
          arr.slice(CFG.timelineMax).forEach(function (x) {
            if (x.block !== null && x.block !== undefined && (T.droppedThrough[k] === null || x.block > T.droppedThrough[k])) {
              T.droppedThrough[k] = x.block;
            }
          });
        }
        T[k] = arr.slice(0, CFG.timelineMax);
      });
      if (T.owner.some(function (x) { return x.unlogged === true; })) BAC.pushWarning('implementation_changed_unlogged');
    }
    return added;
  }

  /** 给时间线上缺时间戳的条目补块时间：每轮最多 blockTsPerRefresh 个块，新的优先，读过的缓存。 */
  function fillTimestamps() {
    var T = BAC.state.timeline;
    var want = [];
    ['owner', 'flow', 'nodeFund'].forEach(function (k) {
      T[k].forEach(function (x) {
        if (x.ts !== null || x.block === null) return;
        if (blockTs[x.block] !== undefined) { x.ts = blockTs[x.block]; return; }
        if (want.indexOf(x.block) < 0) want.push(x.block);
      });
    });
    want.sort(function (a, b) { return b - a; });
    want = want.slice(0, CFG.blockTsPerRefresh);
    return want.reduce(function (chain, n) {
      return chain.then(function () {
        return withRead(function (p) { return p.getBlock(n); }).then(function (b) {
          if (b && b.timestamp !== undefined && b.timestamp !== null) blockTs[n] = Number(b.timestamp);
        }).catch(function () { /* 读不到就保持 null，不估算 */ });
      });
    }, Promise.resolve()).then(function () {
      ['owner', 'flow', 'nodeFund'].forEach(function (k) {
        T[k].forEach(function (x) { if (x.ts === null && blockTs[x.block] !== undefined) x.ts = blockTs[x.block]; });
      });
    });
  }

  var LOG_CHUNKS_PER_REFRESH = 2;

  function syncLogs(head) {
    var T = BAC.state.timeline;
    var addrs = [A.router, A.bridge, A.nodeFund].filter(isAddr);
    if (!BAC.CONTRACTS_LIVE || !addrs.length || head === null || head === undefined) return Promise.resolve();
    if (!(CFG.logRpcs || []).length) {
      T.error = TEXT.NO_RPC; T.status = 'error';
      return Promise.resolve();
    }
    var W = CFG.logWindowBlocks, dep = CFG.deployBlock || 0;
    var start;
    if (T.syncedTo === null) {
      start = Math.max(dep, head - W + 1, 0);
      T.fromBlock = start;
    } else {
      start = T.syncedTo + 1;
      if (head - start + 1 > W) {
        // 标签页睡过头：中间这段公共节点已经不给了，照实记成缺口
        var ns = head - W + 1;
        T.gaps.push([start, ns - 1]);
        start = ns;
      }
    }
    T.deployBlock = dep || null;
    var ranges = [];
    for (var f = start; f <= head && ranges.length < LOG_CHUNKS_PER_REFRESH; f += CFG.logChunkBlocks) {
      ranges.push([f, Math.min(head, f + CFG.logChunkBlocks - 1)]);
    }
    return ranges.reduce(function (chain, r) {
      return chain.then(function (okSoFar) {
        if (!okSoFar) return false;
        return withRead(function (p) {
          return p.getLogs({ address: addrs, fromBlock: r[0], toBlock: r[1] });
        }, { logs: true }).then(function (logs) {
          addLogs(logs);
          T.syncedTo = r[1];
          return true;
        }).catch(function (e) {
          T.failures++;
          T.error = TEXT.ERR;
          T.errorDetail = BAC.errInfo(e).message;
          T.status = 'error';
          T.stale = !!T.ready;
          return false;
        });
      });
    }, Promise.resolve(true)).then(function (ok) {
      if (ok) {
        T.ready = true; T.error = null; T.errorDetail = null; T.failures = 0;
        T.status = 'ok'; T.stale = false; T.source = 'rpc'; T.updatedAt = Date.now();
        // 「全量」必须是真的扫过：从部署块（或更早）起、一直扫到链头、中间没有缺口。
        // 窗口比两块大时，首轮只扫了前两块，离链头还差着 —— 那不叫全量。
        T.caughtUp = T.syncedTo !== null && T.syncedTo >= head;
        T.complete = !!(dep && T.fromBlock !== null && T.fromBlock <= dep && T.caughtUp && !T.gaps.length);
      } else {
        T.caughtUp = false;
        // 失败：第一轮都没扫成（一条日志都没看过）或者这一轮记了缺口 → 绝不能说「全了」；
        // 否则保持上一轮的结论（它只可能在一次真正扫到链头的成功之后才是 true，这一轮的失败另有 status / stale 标着）
        T.complete = !!(T.complete && T.syncedTo !== null && !T.gaps.length);
      }
      return fillTimestamps();
    });
  }

  /* ══════════════════════════════════════════════════════
     8. agent 名录：BacBridge.deposits(i) + ERC-8004 注册表
        一个 agent = 一个锁进过桥的 ERC-8004 身份编号（没有 CHALLENGED / ACTIVE 这套状态机了）。
        deposits(i) 是全量的链上记录（不靠日志），只读最近 depositsMax 笔；每条都缓存（写进去就不会变）。
     ══════════════════════════════════════════════════════ */

  var depCache = {};        // depositId → { from, at, agentId, amount }
  var idCache = {};         // agentId → { owner, exists, wallet, uri, credited, exited, controller }
  var agentsAt = 0;

  function syncAgents(depositTotal, force) {
    var D = BAC.state.agentDir;
    if (!BAC.CONTRACTS_LIVE || !isAddr(A.bridge)) return Promise.resolve();
    if (depositTotal === null || depositTotal === undefined) return Promise.resolve();
    var total = Number(depositTotal);
    D.depositsTotal = total;
    var lo = Math.max(0, total - CFG.depositsMax);
    D.truncated = lo > 0;
    var missing = [];
    for (var i = lo; i < total; i++) if (!depCache[i]) missing.push(i);
    var due = force || !agentsAt || (Date.now() - agentsAt >= CFG.agentsPollMs);
    var mcOk = false;

    /* Multicall3 用不了（探针没答上、退避中，或链上没有）时，名录会退成逐条 eth_call：400 笔存入 + 每个身份 6 条，
       一轮就是上千个请求，公共节点必然限速。所以：存入每轮最多逐条读 plainDepositsPerTick 笔（新的优先，
       没读全之前 total 是 null、只给「至少」）；身份的定时整批复读停掉，只给新身份读几个，其余字段保持 null（不知道）。 */
    return probeMulticall().then(function (ok) {
      mcOk = ok === true;
      if (!mcOk && missing.length > CFG.plainDepositsPerTick) missing = missing.slice(-CFG.plainDepositsPerTick);
      return multi(missing.map(function (id) {
        return call(A.bridge, 'bridge', 'd.' + id, 'deposits', [id]);
      }));
    }).then(function (o) {
      missing.forEach(function (id) {
        var d = o['d.' + id];
        if (!d) return;
        depCache[id] = {
          id: id, from: str(pick(d, 'from', 0)), at: num(pick(d, 'at', 1)),
          agentId: str(pick(d, 'agentId', 2)), amount: big(pick(d, 'amount', 3))
        };
      });
      D.depositsRead = 0;
      var agents = {};
      for (var j = lo; j < total; j++) {
        var dp = depCache[j];
        if (!dp || dp.agentId === null) continue;
        D.depositsRead++;
        var ag = agents[dp.agentId] || (agents[dp.agentId] = {
          agentId: dp.agentId, deposits: 0, lockedTotal: 0n, firstLockAt: null, lastLockAt: null,
          lastDepositId: null, lastFrom: null
        });
        ag.deposits++;
        if (dp.amount !== null) ag.lockedTotal += dp.amount;
        if (dp.at !== null && (ag.firstLockAt === null || dp.at < ag.firstLockAt)) ag.firstLockAt = dp.at;
        if (ag.lastDepositId === null || j > ag.lastDepositId) { ag.lastDepositId = j; ag.lastLockAt = dp.at; ag.lastFrom = dp.from; }
      }
      var list = Object.keys(agents).map(function (k) { return agents[k]; })
        .sort(function (a, b) { return (b.lastDepositId || 0) - (a.lastDepositId || 0); });
      // 读的不是全部存入（截断了，或有几笔这一轮没读到）→ 总数不知道，不猜，只给「至少」
      var allRead = D.depositsRead === total - lo;
      D.total = (!D.truncated && allRead) ? list.length : null;
      D.totalAtLeast = list.length;
      D.itemsTruncated = list.length > CFG.agentsMax;
      list = list.slice(0, CFG.agentsMax);

      var fresh = list.filter(function (ag) { return !idCache[ag.agentId]; });
      // 逐条模式：定时的整批复读停掉，只给新出现的身份读几个（每个 6 条，总数和存入的逐条上限同一量级）
      var idCap = Math.max(1, Math.floor(CFG.plainDepositsPerTick / 6));
      var toRead = mcOk ? (due ? list : fresh) : fresh.slice(0, idCap);
      D.identityPaused = !mcOk && (due || fresh.length > toRead.length);
      return readIdentities(toRead.map(function (ag) { return ag.agentId; })).then(function () {
        if (due && mcOk) agentsAt = Date.now();
        D.identityAt = agentsAt || null;
        D.items = list.map(agentRow);
        D.ready = true; D.error = null; D.errorDetail = null; D.failures = 0;
        D.status = 'ok'; D.stale = false; D.source = 'chain'; D.updatedAt = Date.now();
        BAC.emit('agents', D.items);
      });
    }).catch(function (e) {
      D.failures++;
      D.error = TEXT.ERR; D.errorDetail = BAC.errInfo(e).message;
      D.status = 'error'; D.stale = !!D.ready;
    });
  }

  function readIdentities(ids) {
    if (!ids.length) return Promise.resolve();
    // 以桥自己的门禁为准（桥读的是哪个注册表，就查哪个）；接线还没读到时用配置 / 主网常量
    var P = BAC.state.bsc.params;
    var R = (P && P.bridge && P.bridge.identityRegistry) || CFG.identityRegistry;
    var calls = [];
    ids.forEach(function (id) {
      calls.push(
        call(R, 'identity', 'o.' + id, 'ownerOf', [id]),
        call(R, 'identity', 'w.' + id, 'getMetadata', [id, 'agentWallet']),
        call(R, 'identity', 'u.' + id, 'tokenURI', [id]),
        call(A.bridge, 'bridge', 'c.' + id, 'credited', [id]),
        call(A.bridge, 'bridge', 'x.' + id, 'exitedCredits', [id]),
        call(A.bridge, 'bridge', 'k.' + id, 'agentController', [id])
      );
    });
    return multi(calls).then(function (o) {
      var failed = o.__failed || {};
      ids.forEach(function (id) {
        var owner = o['o.' + id];
        var uri = o['u.' + id];
        var parsed = parseTokenURI(typeof uri === 'string' ? uri : null);
        idCache[id] = {
          // ownerOf 对没铸过（或已销毁）的编号会 revert：那就是「这个身份现在不存在」，不是读取失败
          exists: owner !== undefined ? true : (failed['o.' + id] === 'revert' ? false : null),
          owner: addrOrNull(owner),
          wallet: walletFromMetadata(o['w.' + id]),
          walletKnown: o['w.' + id] !== undefined,
          uri: typeof uri === 'string' ? clip(uri, URI_KEEP) : null,
          uriTruncated: typeof uri === 'string' && uri.length > URI_KEEP,
          uriKind: parsed.kind,
          selfReported: parsed.selfReported,
          credited: big(o['c.' + id]),
          exited: big(o['x.' + id]),
          controller: addrOrNull(o['k.' + id])
        };
      });
    });
  }

  /** 一行 agent。字段名尽量沿用 bac-api.js 的 agentItem，绑定层的 mapAgent 一行不用改；
      v1 状态机的字段（status / statusName / statusZh / solved / lastHeartbeatEpoch / missed …）一律 null：
      v2 没有这套状态，不许显示成「活跃」或别的任何状态。 */
  function agentRow(ag) {
    var id = idCache[ag.agentId] || {};
    var n = Number(ag.agentId);
    return {
      agentId: isFinite(n) && n <= Number.MAX_SAFE_INTEGER ? n : ag.agentId,
      identityId: isFinite(n) && n <= Number.MAX_SAFE_INTEGER ? n : ag.agentId,
      source: 'chain',
      // ERC-8004（BNB Chain 官方注册表）
      identityExists: id.exists === undefined ? null : id.exists,
      identityOwner: id.owner || null,
      agentWallet: id.wallet || null,
      tokenURI: id.uri || null,
      tokenURIKind: id.uriKind || null,
      tokenURITruncated: !!id.uriTruncated,
      selfReported: id.selfReported || null,     // {name, description, hasImage, note}：持有人自述
      // BacBridge
      controller: id.controller || null,         // agentController：halt 后能领逃生款的地址
      wallet: ag.lastFrom,                       // 最近一次 lock 的调用者 = 层内收到原生币的钱包
      credited: id.credited === undefined ? null : id.credited,
      exited: id.exited === undefined ? null : id.exited,
      lockedTotal: ag.lockedTotal,               // 读到的那些存入里一共锁了多少 BAC
      deposits: ag.deposits,
      firstLockAt: ag.firstLockAt,
      lastLockAt: ag.lastLockAt,
      lastDepositId: ag.lastDepositId,
      activatedAt: ag.firstLockAt,               // 兼容 mapAgent 的 joinedTs：第一次锁入的时间
      registeredAt: null,
      // ↓ v1 AgentRegistry 状态机：v2 不存在，一律 null
      status: null, statusName: null, statusZh: null,
      solved: null, lastHeartbeatEpoch: null, missed: null,
      endpointHash: null, modelFingerprint: null, agentURI: null,
      // ↓ 层内数据：只有索引器给得出，视图层会用索引器的同号条目补上
      layerBalance: null, deploys: null, announces: null, lastLayerBlock: null,
      untrusted: true
    };
  }

  /* ══════════════════════════════════════════════════════
     9. 组装到 state
     ══════════════════════════════════════════════════════ */

  var ANCHOR_STATE = ['NONE', 'POSTED', 'FINAL', 'VETOED', 'DISPUTED'];

  /** ChainAnchor.Anchor：合约里是 12 个字段（IChainAnchor.sol）。SPEC §11.4 的 15/16 字段版本
      （proposerIncomeRoot / gasFeesInEpoch / remittedInEpoch / proposerCount）合约里没有 → null。 */
  function shapeAnchor(a) {
    if (!a) return null;
    function f(name, i) { var v = pick(a, name, i); return v; }
    var sixteen = !(a.exitRoot !== undefined) && a.length === 16;   // 旧 SPEC 形状（只为兼容测试夹具 / 老索引器）
    if (sixteen) {
      return {
        exitRoot: str(a[0]), proposerIncomeRoot: str(a[1]), l2BlockHash: str(a[2]), l2Block: num(a[3]),
        postedAt: num(a[4]), finalizedAt: num(a[5]), creditedInEpoch: big(a[6]), exitCreditsInEpoch: big(a[7]),
        feeBurnedInEpoch: big(a[8]), gasFeesInEpoch: big(a[9]), remittedInEpoch: big(a[10]), circulating: big(a[11]),
        exitCount: num(a[12]), proposerCount: num(a[13]), agreeingCount: num(a[14]),
        state: ANCHOR_STATE[Number(a[15])] || 'NONE'
      };
    }
    return {
      exitRoot: str(f('exitRoot', 0)),
      proposerIncomeRoot: null,
      l2BlockHash: str(f('l2BlockHash', 1)),
      l2Block: num(f('l2Block', 2)),
      postedAt: num(f('postedAt', 3)),
      finalizedAt: num(f('finalizedAt', 4)),
      creditedInEpoch: big(f('creditedInEpoch', 5)),
      exitCreditsInEpoch: big(f('exitCreditsInEpoch', 6)),
      feeBurnedInEpoch: big(f('feeBurnedInEpoch', 7)),
      gasFeesInEpoch: null,
      remittedInEpoch: null,
      circulating: big(f('circulating', 8)),
      exitCount: num(f('exitCount', 9)),
      proposerCount: null,
      agreeingCount: num(f('agreeingCount', 10)),
      state: ANCHOR_STATE[Number(f('state', 11))] || 'NONE'
    };
  }

  function shapePortal(s) {
    if (!s) return null;
    var st = num(pick(s, 'status', 0));
    return {
      status: st,
      statusName: st === null ? null : (PORTAL_STATUS[st] || 'Unknown'),
      statusZh: st === null ? null : (PORTAL_STATUS_ZH[st] || '未知'),
      reserve: big(pick(s, 'reserve', 1)),                 // 内盘曲线里的报价币（BNB）
      circulatingSupply: big(pick(s, 'circulatingSupply', 2)),
      price: big(pick(s, 'price', 3)),                     // 每个代币折合多少 BNB（18 位定点），不是法币价格
      tokenVersion: num(pick(s, 'tokenVersion', 4)),
      dexSupplyThresh: big(pick(s, 'dexSupplyThresh', 8)),
      quoteToken: str(pick(s, 'quoteTokenAddress', 9)),
      buyTaxRate: num(pick(s, 'buyTaxRate', 12)),
      sellTaxRate: num(pick(s, 'sellTaxRate', 13)),
      pool: addrOrNull(pick(s, 'pool', 14)),
      progress: big(pick(s, 'progress', 15)),             // 0..1e18 = 离上 DEX 的进度
      dexId: num(pick(s, 'dexId', 17))
    };
  }

  function apply(o, epochData, epoch, impl) {
    var S = BAC.state.bsc;
    var p = S.params, tp = S.tokenParams;
    var dec = (tp && tp.decimals) || 18;

    // 税收路由 / 桥池 / 节点基金：50/50 的两桶 + 路由里还没分的那部分
    var stuck = o['v.stuck'];
    var solv = o['v.solvency'];
    var routerBal = solv ? big(pick(solv, 'balance', 0)) : big(o['bal.router']);
    S.treasury = {
      routerBalance: routerBal,
      routerAccounted: big(o['v.accounted']),
      routerUnsplit: big(o['v.unsplit']),
      routerBuckets: solv ? big(pick(solv, 'buckets', 2)) : null,
      // ↓ 旧键名（v1 叫 vault*），值现在是 BacTaxRouter 的，页面插槽还在读它们
      vaultBalance: routerBal,
      vaultAccounted: big(o['v.accounted']),
      vaultUnsplit: big(o['v.unsplit']),
      vaultBuckets: solv ? big(pick(solv, 'buckets', 2)) : null,
      lifetimeToBridge: big(o['v.toBridge']),
      lifetimeToNodeFund: big(o['v.toNode']),
      totalRecognized: big(o['v.recognized']),
      stuckBridge: stuck ? big(pick(stuck, 'stuckBridge', 0)) : null,
      stuckNodeFund: stuck ? big(pick(stuck, 'stuckNodeFund', 1)) : null,
      poolBalance: big(o['b.bnbBook']),        // 桥的 BNB 账（bnbBalance），用来回购
      bridgeBnbHeld: big(o['bal.bridge']),     // 桥地址上真实的 BNB（紧急提取之后可能少于账面）
      nodeFundBalance: big(o['n.balance']),
      nodeFundReceived: big(o['n.received']),
      nodeFundWithdrawn: big(o['n.withdrawn']),
      nodeFundOwner: addrOrNull(o['n.owner']),
      nodeFundPendingOwner: addrOrNull(o['n.pendingOwner']),
      bridgeBps: (p && p.router.bridgeBps !== null) ? p.router.bridgeBps : C.BRIDGE_BPS,
      taxFeeRateBps: tp ? tp.taxFeeRateBps : null,
      pendingTax: big(o['tk.pendingTax']),         // TaxProcessor 里还没 dispatch 的税（发射后才有）
      lifetimeTaxToRouter: big(o['tk.sentToRouter']),
      decimals: 18   // 税收是 BNB
    };

    var paused = o['b.paused'], rel = o['b.lastRelease'], esc = o['b.escape'], bs = o['b.buybackState'];
    var bnbBook = big(o['b.bnbBook']), bnbHeld = big(o['bal.bridge']);
    var bacAcc = big(o['b.bacAccounted']);
    var sf = o['b.shortfall'];
    var shortfall;
    if (sf) {
      shortfall = { bnb: big(pick(sf, 'bnbShort', 0)), bac: big(pick(sf, 'bacShort', 1)), source: 'contract' };
    } else if (bnbBook !== null && bnbHeld !== null) {
      // shortfall() 在发射前会 revert（它要读代币余额）：BNB 那一半用两个真实读数自己推 ——
      // 但只有两个数出自同一块 aggregate3（同一个区块）才推；逐条读的可能分属两个区块，推出来的差不作数。
      // BAC 那一半只有「账面是 0 且代币还不存在」时才确定是 0，否则不知道
      var src = o.__src || {};
      var sameBlock = src['b.bnbBook'] !== undefined && src['b.bnbBook'] >= 0 && src['b.bnbBook'] === src['bal.bridge'];
      shortfall = {
        bnb: !sameBlock ? null : (bnbBook > bnbHeld ? bnbBook - bnbHeld : 0n),
        bac: (!BAC.TOKEN_LIVE && bacAcc === 0n) ? 0n : null,
        source: 'derived'
      };
    } else shortfall = { bnb: null, bac: null, source: null };

    var venue = bs ? num(pick(bs, 'venue', 3)) : null;
    /* 合约里的 0 占位：时间戳 0 = 「从来没有过」，不是 1970-01-01；绝不能交给页面当时间显示。
       currentRate() 在 creditsOutstanding = 0 时直接 return 0 —— 那是「没有汇率」，不是「每积分 0 BAC」。 */
    var outstanding = big(o['b.outstanding']);
    var rate = outstanding === 0n ? null : big(o['b.rate']);
    var upCount = num(o['b.upgrades']), emCount = num(o['b.emCount']);
    var potAt = rel ? tsOrNull(pick(rel, 'settledAt', 1)) : null;   // settleEpoch 真正发过一次 pot 才会写
    S.bridge = {
      address: A.bridge,
      // 账
      lockedBac: big(o['b.locked']),
      totalLocked: big(o['b.locked']),         // 旧键名 = lockedBac（v2 合约里没有 totalLocked()）
      totalBurned: big(o['b.burned']),
      totalIssued: big(o['b.issued']),
      totalExited: big(o['b.exited']),
      creditsOutstanding: outstanding,
      depositsTotal: num(o['b.depositId']),
      bnbBalance: bnbBook,
      poolBalance: bnbBook,                    // 旧键名 = bnbBalance（v2 合约里没有 poolBalance()）
      bnbHeld: bnbHeld,
      buybackBac: big(o['b.buybackBac']),
      buybackBudget: big(o['b.budget']),
      buybackBacBought: big(o['b.bought']),
      buybackBnbSpent: big(o['b.spent']),
      bacAccounted: bacAcc,
      bacHeld: big(o['tk.bridgeBac']),         // 代币发射后才有：桥地址上真实的 BAC
      buyback: bs ? {
        budget: big(pick(bs, 'budget', 0)), spendable: big(pick(bs, 'spendable', 1)),
        epochsWaited: num(pick(bs, 'epochsWaited', 2)), venue: venue, venueName: venue === null ? null : (VENUE[venue] || null)
      } : null,
      owedTotal: big(o['b.owed']),
      reservedTotal: big(o['b.reserved']),
      releasedInWindow: big(o['b.released']),
      // currentRate() 在 v2 是「每 1 积分折合多少 BAC」（1e18 定点），不再是 BNB；没有在外的积分时是 null（没有汇率）
      bacPerCredit: rate,
      weiPerCredit: rate,                      // 旧键名，含义已变：单位是 BAC，不是 BNB
      // 从来没发过 pot（settledAt = 0）：「上一次释放」不存在，三个数一起是 null
      lastPot: potAt === null ? null : big(pick(rel, 'pot', 0)),
      lastPotSettledAt: potAt,
      lastPotBps: potAt === null ? null : num(pick(rel, 'releaseBps', 2)),
      paused: paused ? !!(pick(paused, 'paused', 0) === true) : null,
      pausedUntil: paused ? tsOrNull(pick(paused, 'until_', 1)) : null,          // 0 = 从没暂停过
      pausedCumulativeSec: paused ? num(pick(paused, 'cumulative', 2)) : null,   // 累计暂停秒数：0 就是真的 0
      halted: o['b.halted'] === undefined ? null : !!o['b.halted'],
      haltCause: num(o['b.haltCause']),
      pendingCause: num(o['b.pendingCause']),
      escapeArmedAt: tsOrNull(o['b.escapeArmedAt']),                             // 0 = 没有武装过
      escapeTotalWeight: esc ? big(pick(esc, 'totalWeight', 0)) : null,
      escapeDistributedBac: esc ? big(pick(esc, 'distBac', 3)) : null,
      escapeDistributedBnb: esc ? big(pick(esc, 'distBnb', 4)) : null,
      escapeDistributed: esc ? big(pick(esc, 'distBac', 3)) : null,
      lastSettledEpoch: num(o['b.settled']),
      skippedEpochs: num(o['b.skipped']),
      // owner 权力（决策 #29 / #33）
      owner: addrOrNull(o['b.owner']),
      pendingOwner: addrOrNull(o['b.pendingOwner']),
      implementation: impl || null,
      // 这一轮真的读到了实现槽（false = 这一轮没读成，implementation 是上一轮的或 null）
      implementationFresh: !!implCache.fresh,
      // 本页看到的「实现槽变了、升级计数器没变」（没有 BridgeUpgraded 的换实现）
      unloggedImplementationChanges: implChanges.map(function (x) { return Object.assign({}, x); }),
      extension: p ? p.bridge.extension : null,
      dexRouter: p ? p.bridge.dexRouter : null,     // BacBridge.router() = PancakeSwap V2 Router
      upgradeCount: upCount,
      lastUpgradeAt: upCount === 0 ? null : tsOrNull(o['b.lastUpgradeAt']),     // 一次都没升级过 → null
      emergencyCount: emCount,
      lastEmergencyAt: emCount === 0 ? null : tsOrNull(o['b.lastEmAt']),        // 一次都没提取过 → null
      emergencyBnbWithdrawn: big(o['b.emBnb']),
      emergencyBacWithdrawn: big(o['b.emBac']),
      shortfall: shortfall,
      decimals: dec
    };
    if ((shortfall.bnb !== null && shortfall.bnb > 0n) || (shortfall.bac !== null && shortfall.bac > 0n)) BAC.pushWarning('bridge_shortfall');
    else BAC.clearWarning('bridge_shortfall');

    // v2 没有注册表了：agent 总数只能从 deposits 数出来（见 state.agentDir），这里只留存入笔数
    S.agents = {
      total: BAC.state.agentDir.total,
      depositsTotal: num(o['b.depositId'])
    };

    S.token = BAC.TOKEN_LIVE ? {
      address: A.token,
      portal: shapePortal(o['tk.portal']),
      bridgeBac: big(o['tk.bridgeBac']),
      pendingTax: big(o['tk.pendingTax']),
      lifetimeTaxToRouter: big(o['tk.sentToRouter'])
    } : null;

    var er = epochData && epochData['e.dayReward'];
    S.staking = {
      totalStaked: big(o['s.staked']),
      nodeCount: num(o['s.nodes']),
      rewardBalance: big(o['s.rewardBal']),
      lifetimeFunded: big(o['s.funded']),
      lifetimePaid: big(o['s.paid']),
      lastRemitEpoch: null,     // ValidatorStaking 里没有 lastRemitEpoch()（01 §11.5 还没落地），不读、不猜
      // 奖池按「天」记（144 个纪元一天）：这是最近一个上报纪元所在那一天的池子 —— 不是「本纪元」的奖池
      rewardDay: er ? dayOf(epoch) : null,
      dayPot: er ? big(pick(er, 'pot', 0)) : null,
      dayWeight: er ? big(pick(er, 'weight', 1)) : null,
      dayRate: er ? big(pick(er, 'rate', 2)) : null,
      daySettled: er ? !!pick(er, 'settled', 3) : null,
      minStake: C.MIN_VALIDATOR_STAKE
    };

    /* 锚点：分清「真的上报过 / 定案过」和构造函数的占位。
       - lastPostedEpoch < firstEpoch（构造函数写的 firstEpoch − 1）= 一个锚点都还没上报 → null；
         firstEpoch 没读到时，只有那个纪元的锚点记录自己证明上报过（postedAt > 0）才信，否则 null；
       - lastFinalEpoch 构造函数不写（0），< firstEpoch = 一个都还没定案 → lastFinalEpoch / lastFinalAt 都是 null；
       - lastFinalAt 在没有定案时是**部署时间**（停机计时的起点），不是「上一个锚点定案的时间」，
         原值另放在 haltClockFrom 里，给「多久没有新锚点就停机」的倒计时用。 */
    noteFirstEpoch(o['a.first']);
    var first = anchorFirstEpoch();
    var anchor = shapeAnchor(epochData && epochData['e.anchor']);
    var postedRaw = num(o['a.posted']);
    var posted;
    if (postedRaw === null) posted = null;
    else if (first !== null) posted = postedRaw >= first ? postedRaw : null;
    else posted = (anchor && anchor.postedAt) ? postedRaw : null;
    if (posted === null || (epoch !== null && epoch !== undefined && Number(epoch) !== posted)) anchor = null;
    var finalRaw = num(o['a.final']);
    var finalEpoch = (finalRaw === null || finalRaw === 0 || (first !== null && finalRaw < first)) ? null : finalRaw;
    S.anchor = {
      firstEpoch: first,
      lastPostedEpoch: posted,
      lastFinalEpoch: finalEpoch,
      lastFinalAt: finalEpoch === null ? null : tsOrNull(o['a.finalAt']),
      haltClockFrom: tsOrNull(o['a.finalAt']),
      currentEpoch: BAC.currentEpoch(),
      epochLeftSec: BAC.epochLeft(),
      cumulativeCredited: big(o['a.cumCredited']),
      cumulativeExit: big(o['a.cumExit']),
      haltReason: num(o['a.haltReason']),
      vetoCountInWindow: num(o['a.vetoes']),
      disputeCountInWindow: num(o['a.disputes']),
      releaseBps: num(o['a.releaseBps']),
      anchorEpoch: anchor ? posted : null,
      anchor: anchor,
      // 决策 #17 的 gas 归集对账：ChainAnchor 里没有 cumulativeGasFees / cumulativeRemitted，链上读不到，
      // 由视图层改用索引器 /api/health 的 gas 块（来自 FINAL 锚点）。这里不编。
      gas: null
    };
    BAC.clearWarning('gas_remittance_shortfall');
  }

  /** 合约里的时间戳：0 = 「从来没有过」→ null（不许显示成 1970-01-01）。 */
  function tsOrNull(v) {
    var n = num(v);
    return n === null || !isFinite(n) || n <= 0 ? null : n;
  }

  /* ══════════════════════════════════════════════════════
     10. 刷新循环
     ══════════════════════════════════════════════════════ */

  var timer = null, inFlight = null, started = false;

  function pollMs() {
    return BAC.LIVE ? CFG.pollMs : CFG.prelaunchPollMs;
  }

  function schedule(ms) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (BAC.state.hidden) return;
    timer = setTimeout(function () { refresh({ reason: 'poll' }); }, ms === undefined ? pollMs() : ms);
  }

  function markOk(reason) {
    var S = BAC.state, B = S.bsc;
    B.ready = true; B.error = null; B.errorDetail = null; B.failures = 0;
    B.status = 'ok'; B.source = 'rpc'; B.stale = false;
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
    B.status = 'error';
    S.loading = false;
    S.error = B.error;
    S.errorDetail = info.message;
    S.reason = reason || null;
    BAC.emit('state', S);
  }

  /** 什么都还没部署时（阶段 a）：只问块高 + 到点复探一下代码。其余一律保持 null。 */
  function prelaunchTick() {
    return withRead(function (p) { return p.getBlockNumber(); })
      .then(function (n) {
        BAC.state.bsc.block = { number: Number(n), timestamp: null, at: Date.now() };
        markOk('prelaunch');
      })
      .catch(function (e) { markFail(e, 'prelaunch'); });
  }

  var lastUpgradeCountSeen = null;

  /* 每个合约的「核心读数」。地址上有代码、这一轮却一条都没返回 = 这个合约读不出来
     （ABI 和网站对不上 / 代理地址填错 / 节点全挂），绝不能报 status 'ok' 配一屏 null。 */
  var CORE_KEYS = {
    router: ['v.accounted', 'v.unsplit', 'v.toBridge', 'v.toNode', 'v.recognized', 'v.stuck', 'v.solvency'],
    bridge: ['b.owner', 'b.locked', 'b.issued', 'b.outstanding', 'b.depositId', 'b.bnbBook', 'b.upgrades', 'b.emCount', 'b.settled'],
    nodeFund: ['n.balance', 'n.received', 'n.withdrawn', 'n.owner'],
    anchor: ['a.posted', 'a.final', 'a.finalAt', 'a.cumCredited', 'a.cumExit'],
    staking: ['s.staked', 's.nodes', 's.rewardBal', 's.funded', 's.paid']
  };
  function failedContracts(o) {
    if (!BAC.CONTRACTS_LIVE) return [];
    return Object.keys(CORE_KEYS).filter(function (name) {
      return isAddr(A[name]) && CORE_KEYS[name].every(function (k) { return o[k] === undefined; });
    });
  }
  /** 那几个合约的核心读数是不是全都败在网络上（而不是合约拒绝 / 返回空 / 解不出来）。 */
  function onlyNetwork(o, names) {
    var f = o.__failed || {};
    return names.length > 0 && names.every(function (name) {
      return CORE_KEYS[name].every(function (k) { return f[k] === 'error'; });
    });
  }

  /** 路由和桥一条核心读数都没返回：走错误路径。上一轮的真实读数原样保留、标成旧数（stale），不拿 null 盖掉。 */
  function markReadFail(o, failed, reason) {
    var S = BAC.state, B = S.bsc;
    var net = onlyNetwork(o, failed);
    B.failures++;
    B.error = net ? TEXT.ERR : TEXT.NO_VAULT;
    B.errorDetail = net ? '合约读数全部败在网络上：' + failed.join(' / ')
      : '合约地址上有代码，但这些合约一条核心读数都没返回：' + failed.join(' / ');
    B.status = 'error';
    B.stale = !!B.ready;
    S.loading = false;
    S.error = B.error;
    S.errorDetail = B.errorDetail;
    S.reason = reason || null;
    BAC.emit('state', S);
  }

  function liveTick(opts) {
    var S = BAC.state.bsc;
    var head = null;
    return Promise.resolve()
      .then(function () {
        return withRead(function (prov) { return prov.getBlock('latest'); }).catch(function () { return null; });
      })
      .then(function (blk) {
        if (blk) {
          head = Number(blk.number);
          S.block = { number: head, timestamp: Number(blk.timestamp), at: Date.now() };
          BAC.time.setChainTime(Number(blk.timestamp));
        }
        var jobs = [];
        // 接线 / 代币参数：还有没读到的 key 就每轮补读那几条（读到的不重读）
        if (BAC.CONTRACTS_LIVE && !(S.params && S.params.complete)) {
          jobs.push(loadParams().then(function (p) { S.params = p; }));
        }
        if (BAC.TOKEN_LIVE && !(S.tokenParams && S.tokenParams.complete)) {
          jobs.push(loadTokenParams().then(function (tp) { S.tokenParams = tp; }));
        }
        return Promise.all(jobs);
      })
      .then(function () { return readLive(BAC.currentEpoch()); })
      .then(function (o) {
        var failed = failedContracts(o);
        S.failedContracts = failed;
        if (failed.length && !onlyNetwork(o, failed)) BAC.pushWarning('contract_reads_failed');
        else BAC.clearWarning('contract_reads_failed');
        if (failed.indexOf('router') >= 0 && failed.indexOf('bridge') >= 0) {
          markReadFail(o, failed, opts.reason);
          return syncLogs(head).catch(function (e) { BAC.logErr('syncLogs', e); })
            .then(function () { BAC.emit('timeline', BAC.state.timeline); BAC.emit('state', BAC.state); });
        }
        noteFirstEpoch(o['a.first']);
        var posted = o['a.posted'] === undefined ? null : Number(o['a.posted']);
        // 构造函数的占位（firstEpoch − 1）不是上报过的锚点：那个纪元的锚点是空的，不读（readEpoch 里也会挡）
        var first = anchorFirstEpoch();
        if (posted !== null && first !== null && posted < first) posted = null;
        var upgrades = o['b.upgrades'] === undefined ? null : Number(o['b.upgrades']);
        // 升级过 → 接线参数可能变了，下一轮全部重读（实现槽变了也一样，见 readImplementation）
        if (upgrades !== null && lastUpgradeCountSeen !== null && upgrades !== lastUpgradeCountSeen) resetParams();
        if (upgrades !== null) lastUpgradeCountSeen = upgrades;
        return Promise.all([readEpoch(posted), readImplementation(upgrades, head)]).then(function (r) {
          apply(o, r[0], posted, r[1]);
          markOk(opts.reason || 'refresh');
          var dep = o['b.depositId'];
          // 日志与 agent 名录各自记各自的错，失败不拖垮上面这些真实读数
          return Promise.all([
            syncLogs(head).catch(function (e) { BAC.logErr('syncLogs', e); }),
            syncAgents(dep === undefined ? null : dep).catch(function (e) { BAC.logErr('syncAgents', e); })
          ]).then(function () { BAC.emit('timeline', BAC.state.timeline); BAC.emit('state', BAC.state); });
        });
      });
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

    var job = probeCodes(opts.forceProbe)
      .catch(function () { return false; })
      .then(function () {
        if (!BAC.LIVE) return prelaunchTick();
        return liveTick(opts);
      })
      .catch(function (err) { markFail(err, opts.reason); })
      .then(function () {
        inFlight = null;
        var f = BAC.state.bsc.failures;
        var next = f > 0 ? Math.min(pollMs(), BAC.backoffMs(f, 3000)) : pollMs();
        // 阶段还没翻完（代币没发射 / 合约还没部署）：至少每 codeProbeMs 醒一次去复探
        var pendingProbe = (BAC.TOKEN_CONFIGURED && !BAC.TOKEN_LIVE) || (BAC.CONTRACTS_CONFIGURED && !BAC.CONTRACTS_LIVE);
        if (pendingProbe) next = Math.min(next, CFG.codeProbeMs);
        schedule(next);
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
    probeCodes: probeCodes,
    loadParams: loadParams,
    loadTokenParams: loadTokenParams,
    readLive: readLive,
    readEpoch: readEpoch,
    readImplementation: readImplementation,
    syncLogs: syncLogs,
    syncAgents: syncAgents,
    decodeLog: decodeLog,
    shapeEvent: shapeEvent,
    mergeTimeline: mergeTimeline,
    anchorFirstEpoch: anchorFirstEpoch,
    shapeAnchor: shapeAnchor,
    shapePortal: shapePortal,
    parseTokenURI: parseTokenURI,
    walletFromMetadata: walletFromMetadata,
    addrFromSlot: addrFromSlot,
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
