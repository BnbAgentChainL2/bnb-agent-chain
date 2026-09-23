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
      // OpenZeppelin：ERC1967Upgrade 与 Ownable2StepUpgradeable
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
    // ChainAnchor：结构体按 contracts/src/interfaces/IChainAnchor.sol（12 个字段）
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
      'function epochReward(uint64 epoch) view returns (uint256 pot, uint256 weight, uint256 rate, bool settled)',
      'function rewardOf(uint64 epoch, address validator) view returns (uint256)',
      'function revealerCount(uint64 epoch) view returns (uint256)',
      'function MIN_VALIDATOR_STAKE() view returns (uint256)',
      // 决策 #17（01 §11.5）：归集对账三元组的链上来源（合约里还没有的，单条失败 = null）
      'function proposerRights(address v) view returns (bool)',
      'function proposerAddressOf(address v) view returns (address)',
      'function qualifyStreak(address v) view returns (uint16)',
      'function remitStatus(address v) view returns (uint256 cumOwed, uint256 cumRemitted, uint256 arrears, bool shortfall)',
      'function withheldOf(address v) view returns (uint256)',
      'function lastRemitEpoch() view returns (uint64)'
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

  /** multi() 的结果上挂一张不可枚举的失败表：key → 'revert'（合约拒绝，比如 ownerOf 对没铸过的编号）
      | 'error'（网络 / 解码）。Object.keys(out) 只看得到成功的那些。 */
  function failTable(out) {
    if (!out.__failed) Object.defineProperty(out, '__failed', { value: {}, enumerable: false });
    return out.__failed;
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
    var out = {}, failed = failTable(out), i = 0;
    function worker() {
      if (i >= calls.length) return Promise.resolve();
      var c = calls[i++];
      var data;
      try { data = iface(c.abiName).encodeFunctionData(c.fn, c.args); }
      catch (e) { failed[c.key] = 'error'; return worker(); }
      return withRead(function (p) { return p.call({ to: c.target, data: data }); })
        .then(function (ret) {
          var v = decode(c, ret);
          if (v === undefined) failed[c.key] = 'revert'; else out[c.key] = v;
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
    if (!calls.length) return Promise.resolve(out);
    return probeMulticall().then(function (ok) {
      if (!ok) return plainCalls(calls);
      var mc = iface('multicall3');
      var groups = chunk(calls, MC_CHUNK);
      var failed = out.__failed;
      return groups.reduce(function (chain, g) {
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
                  if (v === undefined) failed[usable[i].key] = 'revert'; else out[usable[i].key] = v;
                } catch (e) { failed[usable[i].key] = 'error'; }
              }
            })
            .catch(function () {
              // 整块失败：退回逐条，宁可慢也不要整页空白
              return plainCalls(usable).then(function (o) {
                Object.assign(out, o);
                Object.keys(o.__failed).forEach(function (k) { failed[k] = o.__failed[k]; });
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
  /** ethers Result / 数组 / 对象 通吃：先按名字取，取不到按下标。 */
  function pick(r, name, i) {
    if (r === undefined || r === null) return undefined;
    if (typeof r === 'object' && r[name] !== undefined) return r[name];
    if (i !== undefined && typeof r === 'object' && r[i] !== undefined) return r[i];
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
    if (kind === 'data' && uri.length <= URI_PARSE_MAX) {
      try {
        var body = uri.slice(uri.indexOf(',') + 1), text;
        if (/;base64,/i.test(uri.slice(0, uri.indexOf(',') + 1))) {
          var bytes = b64bytes(body);
          text = bytes ? utf8(bytes) : null;
        } else {
          text = decodeURIComponent(body);
        }
        var j = text ? JSON.parse(text) : null;
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

  /** 合约接线（不可变参数 + 互相核对）。升级之后（upgradeCount 变了）重读一次。 */
  function loadParams() {
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
      call(A.bridge, 'bridge', 'b.router', 'router'),
      call(A.bridge, 'bridge', 'b.extension', 'EXTENSION'),
      call(A.bridge, 'bridge', 'b.notice', 'OWNER_POWER_NOTICE'),
      call(A.bridge, 'bridge', 'b.idNotice', 'IDENTITY_LIMIT_NOTICE'),
      call(A.bridge, 'bridge', 'b.description', 'description')
    );
    if (isAddr(A.nodeFund)) calls.push(call(A.nodeFund, 'nodeFund', 'n.token', 'bacToken'));
    return multi(calls).then(function (o) {
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
          portal: addrOrNull(o['b.portal']), router: addrOrNull(o['b.router']),
          extension: addrOrNull(o['b.extension']),
          ownerPowerNotice: str(o['b.notice']), identityLimitNotice: str(o['b.idNotice']),
          description: str(o['b.description'])
        },
        nodeFund: { address: A.nodeFund, bacToken: addrOrNull(o['n.token']) },
        loaded: o['r.token'] !== undefined || o['b.token'] !== undefined
      };
      // 接线核对：任何一处对不上都是事故（税会进错地方），告警并列出是哪一处
      var mm = [];
      function chk(name, got, want) { if (got && want && !sameAddr(got, want)) mm.push(name); }
      chk('router.bacToken', p.router.bacToken, A.token);
      chk('router.bridge', p.router.bridge, A.bridge);
      chk('router.nodeFund', p.router.nodeFund, A.nodeFund);
      chk('bridge.bacToken', p.bridge.bacToken, A.token);
      chk('bridge.router', p.bridge.router, A.router);
      chk('bridge.identityRegistry', p.bridge.identityRegistry, CFG.identityRegistry);
      chk('bridge.portal', p.bridge.portal, CFG.flapPortal);
      chk('bridge.anchor', p.bridge.anchor, A.anchor);
      chk('nodeFund.bacToken', p.nodeFund.bacToken, A.token);
      p.wiring = { ok: p.loaded ? mm.length === 0 : null, mismatches: mm };
      if (mm.length) BAC.pushWarning('wiring_mismatch'); else BAC.clearWarning('wiring_mismatch');
      // 决策 #29a：链上那句必须与网站逐字一致
      p.noticeMatches = p.bridge.ownerPowerNotice === null ? null : p.bridge.ownerPowerNotice === TEXT.OWNER_POWER;
      if (p.noticeMatches === false) BAC.pushWarning('owner_notice_mismatch'); else BAC.clearWarning('owner_notice_mismatch');
      return p;
    });
  }

  /** 代币参数：只在 TOKEN_LIVE 之后读（发射前那个地址上没有代码，读了也是空）。 */
  function loadTokenParams() {
    var T = A.token;
    return multi([
      call(T, 'token', 't.name', 'name'),
      call(T, 'token', 't.symbol', 'symbol'),
      call(T, 'token', 't.decimals', 'decimals'),
      call(T, 'token', 't.totalSupply', 'totalSupply'),
      call(T, 'token', 't.taxRate', 'taxRate'),
      call(T, 'token', 't.buyTax', 'buyTaxRate'),
      call(T, 'token', 't.sellTax', 'sellTaxRate'),
      call(T, 'token', 't.processor', 'taxProcessor')
    ]).then(function (o) {
      var proc = addrOrNull(o['t.processor']);
      var tp = {
        address: T,
        name: str(o['t.name']), symbol: str(o['t.symbol']),
        decimals: o['t.decimals'] === undefined ? null : Number(o['t.decimals']),
        totalSupply: big(o['t.totalSupply']),
        taxRate: num(o['t.taxRate']), buyTaxRate: num(o['t.buyTax']), sellTaxRate: num(o['t.sellTax']),
        taxProcessor: proc,
        taxFeeRateBps: null, marketAddress: null, marketAddressOk: null,
        loaded: o['t.symbol'] !== undefined || o['t.processor'] !== undefined
      };
      if (!proc) return tp;
      return multi([
        call(proc, 'taxProcessor', 'p.market', 'marketAddress'),
        call(proc, 'taxProcessor', 'p.cfg', 'feeConfigV2')
      ]).then(function (p) {
        tp.marketAddress = str(p['p.market']);
        // 决策 #30 的硬检查：marketAddress 必须就是我们的 BacTaxRouter，否则税根本进不来
        tp.marketAddressOk = tp.marketAddress ? sameAddr(tp.marketAddress, A.router) : null;
        var cfg = p['p.cfg'];
        // feeConfigV2().feeRate = Flap 协议先抽走的那一层（实测 1000 = 10%），50/50 分的是剩下的部分
        if (cfg) tp.taxFeeRateBps = num(pick(cfg, 'feeRate', 4));
        if (tp.marketAddressOk === false) BAC.pushWarning('market_address_mismatch');
        else BAC.clearWarning('market_address_mismatch');
        return tp;
      }).catch(function () { return tp; });
    });
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
          call(A.staking, 'staking', 's.paid', 'lifetimePaid'),
          call(A.staking, 'staking', 's.lastRemit', 'lastRemitEpoch')
        );
      }
      if (isAddr(A.anchor)) {
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

  /** 第二跳：拿到 lastPostedEpoch 之后再读那个纪元的锚点与奖励。 */
  function readEpoch(epoch) {
    if (epoch === null || epoch === undefined || !BAC.CONTRACTS_LIVE) return Promise.resolve({});
    var calls = [];
    if (isAddr(A.anchor)) calls.push(call(A.anchor, 'anchor', 'e.anchor', 'getAnchor', [epoch]));
    if (isAddr(A.staking)) calls.push(call(A.staking, 'staking', 'e.reward', 'epochReward', [epoch]));
    return multi(calls);
  }

  /** ERC1967 实现槽：只在第一次、以及 upgradeCount 变了之后读（升级才会改它）。 */
  var implCache = { count: null, impl: null, raw: null };
  function readImplementation(upgradeCount) {
    if (!isAddr(A.bridge) || !BAC.CONTRACTS_LIVE) return Promise.resolve(null);
    var n = upgradeCount === undefined || upgradeCount === null ? null : Number(upgradeCount);
    if (implCache.raw !== null && n !== null && implCache.count === n) return Promise.resolve(implCache.impl);
    return withRead(function (p) {
      return typeof p.getStorage === 'function' ? p.getStorage(A.bridge, C.ERC1967_IMPL_SLOT)
        : p.send('eth_getStorageAt', [A.bridge, C.ERC1967_IMPL_SLOT, 'latest']);
    }).then(function (v) {
      implCache.raw = v; implCache.impl = addrFromSlot(v); implCache.count = n;
      return implCache.impl;
    }).catch(function () { return implCache.impl; });
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
    var a = ev.args || {};
    var base = {
      event: ev.name, contract: which,
      block: num(l.blockNumber), tx: str(l.transactionHash),
      logIndex: num(l.index !== undefined ? l.index : l.logIndex),
      ts: null, source: 'rpc'
    };
    function g(name, i) { return pick(a, name, i); }
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
          it = { kind: 'implementation', implementation: str(g('implementation', 0)) };
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
    var out = Object.assign(base, it);
    if (it.ts === undefined || it.ts === null) out.ts = null;
    return { list: list, item: out };
  }

  function byRecency(a, b) {
    if (a.block !== b.block) return (b.block || 0) - (a.block || 0);
    return (b.logIndex || 0) - (a.logIndex || 0);
  }

  /** 同一笔交易里的 BridgeUpgraded + Upgraded 是同一次升级：把 Upgraded 并进去（核对实现地址），不重复显示。
      单独的 Upgraded（代理部署时 ERC1967Proxy 构造函数发的）保留为「初始实现」。 */
  function mergeUpgrades(list) {
    var byTx = {};
    list.forEach(function (x) { if (x.kind === 'upgrade') byTx[x.tx] = x; });
    return list.filter(function (x) {
      if (x.kind !== 'implementation') return true;
      var u = byTx[x.tx];
      if (!u) return true;
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
        T[k] = arr.slice(0, CFG.timelineMax);
      });
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
      }
      T.complete = !!(dep && T.fromBlock !== null && T.fromBlock <= dep && !T.gaps.length);
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

    return multi(missing.map(function (id) {
      return call(A.bridge, 'bridge', 'd.' + id, 'deposits', [id]);
    })).then(function (o) {
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
      D.total = D.truncated ? null : list.length;          // 读的不是全部存入 → 总数不知道，不猜
      D.totalAtLeast = list.length;
      list = list.slice(0, CFG.agentsMax);

      var fresh = list.filter(function (ag) { return !idCache[ag.agentId]; });
      var toRead = due ? list : fresh;
      return readIdentities(toRead.map(function (ag) { return ag.agentId; })).then(function () {
        if (due) agentsAt = Date.now();
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
    var R = CFG.identityRegistry;
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
      // shortfall() 在发射前会 revert（它要读代币余额）：BNB 那一半用两个真实读数自己推；
      // BAC 那一半只有「账面是 0 且代币还不存在」时才确定是 0，否则不知道
      shortfall = {
        bnb: bnbBook > bnbHeld ? bnbBook - bnbHeld : 0n,
        bac: (!BAC.TOKEN_LIVE && bacAcc === 0n) ? 0n : null,
        source: 'derived'
      };
    } else shortfall = { bnb: null, bac: null, source: null };

    var venue = bs ? num(pick(bs, 'venue', 3)) : null;
    S.bridge = {
      address: A.bridge,
      // 账
      lockedBac: big(o['b.locked']),
      totalLocked: big(o['b.locked']),         // 旧键名 = lockedBac（v2 合约里没有 totalLocked()）
      totalBurned: big(o['b.burned']),
      totalIssued: big(o['b.issued']),
      totalExited: big(o['b.exited']),
      creditsOutstanding: big(o['b.outstanding']),
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
      // currentRate() 在 v2 是「每 1 积分折合多少 BAC」（1e18 定点），不再是 BNB
      bacPerCredit: big(o['b.rate']),
      weiPerCredit: big(o['b.rate']),          // 旧键名，含义已变：单位是 BAC，不是 BNB
      lastPot: rel ? big(pick(rel, 'pot', 0)) : null,
      lastPotSettledAt: rel ? num(pick(rel, 'settledAt', 1)) : null,
      lastPotBps: rel ? num(pick(rel, 'releaseBps', 2)) : null,
      paused: paused ? !!(pick(paused, 'paused', 0) === true) : null,
      pausedUntil: paused ? num(pick(paused, 'until_', 1)) : null,
      pausedCumulativeSec: paused ? num(pick(paused, 'cumulative', 2)) : null,
      halted: o['b.halted'] === undefined ? null : !!o['b.halted'],
      haltCause: num(o['b.haltCause']),
      pendingCause: num(o['b.pendingCause']),
      escapeArmedAt: num(o['b.escapeArmedAt']),
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
      extension: p ? p.bridge.extension : null,
      upgradeCount: num(o['b.upgrades']),
      lastUpgradeAt: num(o['b.lastUpgradeAt']),
      emergencyCount: num(o['b.emCount']),
      lastEmergencyAt: num(o['b.lastEmAt']),
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

    var er = epochData && epochData['e.reward'];
    S.staking = {
      totalStaked: big(o['s.staked']),
      nodeCount: num(o['s.nodes']),
      rewardBalance: big(o['s.rewardBal']),
      lifetimeFunded: big(o['s.funded']),
      lifetimePaid: big(o['s.paid']),
      lastRemitEpoch: num(o['s.lastRemit']),
      epochPot: er ? big(pick(er, 'pot', 0)) : null,
      epochWeight: er ? big(pick(er, 'weight', 1)) : null,
      epochSettled: er ? !!pick(er, 'settled', 3) : null,
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
    B.status = 'ok'; B.source = 'rpc';
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
        if (BAC.CONTRACTS_LIVE && !(S.params && S.params.loaded)) {
          jobs.push(loadParams().then(function (p) { S.params = p; }));
        }
        if (BAC.TOKEN_LIVE && !(S.tokenParams && S.tokenParams.loaded)) {
          jobs.push(loadTokenParams().then(function (tp) { S.tokenParams = tp; }));
        }
        return Promise.all(jobs);
      })
      .then(function () { return readLive(BAC.currentEpoch()); })
      .then(function (o) {
        var posted = o['a.posted'] === undefined ? null : Number(o['a.posted']);
        var upgrades = o['b.upgrades'] === undefined ? null : Number(o['b.upgrades']);
        // 升级过 → 接线参数可能变了，下一轮重读
        if (upgrades !== null && lastUpgradeCountSeen !== null && upgrades !== lastUpgradeCountSeen && S.params) S.params.loaded = false;
        if (upgrades !== null) lastUpgradeCountSeen = upgrades;
        return Promise.all([readEpoch(posted), readImplementation(upgrades)]).then(function (r) {
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
