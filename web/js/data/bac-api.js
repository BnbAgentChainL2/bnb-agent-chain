/* BNB Agent Chain · 数据层 · 索引器客户端（层内数据 + feed）
   接口逐字按 docs/03-INTERFACES.md §3。所有金额字段都是十进制字符串的 wei，这里一律转 BigInt。
   降级模式（degraded）：索引器读不到时，
   - state.indexer.degraded = true，层内各段的 error 写「读取失败 · 重试中」；
   - **BSC 那一半照常刷新**，页面上金库/桥/验证者质押的数字仍然是实时的；
   - 层内那一半交给 bac-layer.js 直接读 RPC：块、交易、块高都还是真数据，只是标 source='rpc'
     （索引器独有的历史 / 搜索 / 聚合才是真的没有了）。
   宁可停，不可错：读不到就说读不到，不猜、不补、不显示上一次的数当成新的。 */
(function (root) {
  'use strict';

  var BAC = root.BAC;
  if (!BAC || !BAC.core) {
    if (root.console) root.console.error('[BAC] bac-api.js 需要先加载 bac-core.js');
    return;
  }
  if (BAC.api) return;

  var CFG = BAC.CFG, TEXT = BAC.TEXT, big = BAC.big, C = BAC.C;
  var apiHealth = BAC.healthTable(5000);   // 索引器是我们自己的，重试比公共 RPC 积极一点

  /* 索引器的端点清单：主域名在前，IP 兜底在后。
     主域名过期 / 还没解析出来 / 被劫持时自动落到兜底；主域名恢复后（退避到期）自动换回去。 */
  var API_EPS = [];
  (function () {
    [CFG.indexerBase, CFG.fallbackApi].forEach(function (u) {
      if (typeof u === 'string' && u && API_EPS.indexOf(u) < 0) API_EPS.push(u);
    });
  })();
  var BASE = API_EPS.length ? API_EPS[0] : '';
  var curBase = null;                      // 上一次成功的那个

  /** 挑一个还没试过、且不在退避窗口里的端点；全在退避里就挑最快到期的那个（不彻底放弃）。 */
  function pickBase(now, tried) {
    tried = tried || [];
    var order = API_EPS.slice();
    if (curBase && order.length > 1 && order[0] !== curBase && !apiHealth.healthy('base:' + order[0], now)) {
      order = [curBase].concat(order.filter(function (u) { return u !== curBase; }));
    }
    var best = null, bestUntil = Infinity, i, u;
    for (i = 0; i < order.length; i++) {
      u = order[i];
      if (tried.indexOf(u) >= 0) continue;
      if (apiHealth.healthy('base:' + u, now)) return u;
      var until = apiHealth.get('base:' + u).until;
      if (until < bestUntil) { bestUntil = until; best = u; }
    }
    return best;
  }

  function num(v) { return v === undefined || v === null ? null : Number(v); }
  function str(v) { return v === undefined || v === null ? null : String(v); }

  /* ══════════════════════════════════════════════════════
     1. fetch 封装：超时 / CORS / 统一错误形状
     ══════════════════════════════════════════════════════ */

  function qs(params) {
    if (!params) return '';
    var out = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return out.length ? '?' + out.join('&') : '';
  }

  /** GET 一个端点（单个 base，不含换端点逻辑）。失败抛错（错误里带 code），成功返回已解析的 JSON。 */
  function getFrom(base, path, params, opts) {
    opts = opts || {};
    if (!base) return Promise.reject(new Error('没有配置索引器地址'));
    var url = base + path + qs(params);
    var f = root.fetch;
    if (typeof f !== 'function') return Promise.reject(new Error('浏览器不支持 fetch'));

    var ctl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, opts.timeoutMs || CFG.apiTimeoutMs);

    return f(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      if (!res || !res.ok) {
        var e = new Error('HTTP ' + ((res && res.status) || 0));
        e.status = res && res.status;
        // 索引器的统一错误形状：{"error":{"code","message"}}
        return (res && typeof res.json === 'function' ? res.json().catch(function () { return null; }) : Promise.resolve(null))
          .then(function (body) {
            if (body && body.error && body.error.message) { e.message = body.error.message; e.apiCode = body.error.code; }
            throw e;
          });
      }
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  /** GET，带主域名 → 兜底 IP 的自动切换（最多试两个端点，不做无限重试）。 */
  function get(path, params, opts) {
    var tried = [], lastErr = null;
    function attempt() {
      var now = Date.now();
      var base = pickBase(now, tried);
      if (!base) return Promise.reject(lastErr || new Error('没有配置索引器地址'));
      tried.push(base);
      return getFrom(base, path, params, opts).then(function (j) {
        apiHealth.ok('base:' + base);
        curBase = base;
        BAC.state.indexer.endpoint = base;
        return j;
      }, function (err) {
        // 404 / 业务错误不算端点坏了：别因为一个端点没实现就切到兜底
        if (err && err.status && err.status >= 400 && err.status < 500) throw err;
        apiHealth.bad('base:' + base, err, now);
        lastErr = err;
        if (tried.length >= Math.min(2, API_EPS.length)) throw err;
        return attempt();
      });
    }
    return attempt();
  }

  /** 带退避的 GET：这个端点还在退避窗口里就直接拒绝，不打无用的请求。 */
  function fetchEndpoint(key, path, params, opts) {
    var now = Date.now();
    if (!apiHealth.healthy(key, now) && !(opts && opts.force)) {
      var e = new Error('索引器退避中');
      e.code = 'backoff';
      return Promise.reject(e);
    }
    return get(path, params, opts).then(function (j) {
      apiHealth.ok(key);
      markIndexerOk();
      return j;
    }, function (err) {
      apiHealth.bad(key, err, now);
      // 4xx = 索引器答话了，只是这个端点没有 / 参数不对（比如线上还是旧版索引器、没有 /api/bridge/timeline）：
      // 这个端点自己退避，但**不算索引器挂了**，不许因此拉起降级横幅
      if (!(err && err.status >= 400 && err.status < 500)) markIndexerFail(err);
      throw err;
    });
  }

  function markIndexerOk() {
    var I = BAC.state.indexer;
    I.ready = true; I.error = null; I.errorDetail = null; I.failures = 0;
    I.degraded = false; I.lastOkAt = Date.now(); I.updatedAt = Date.now();
    BAC.clearWarning('indexer_down');
  }

  function markIndexerFail(err) {
    var I = BAC.state.indexer;
    I.failures++;
    I.error = TEXT.ERR;
    I.errorDetail = BAC.errInfo(err).message;
    I.updatedAt = Date.now();
    // 连续两次失败才宣布降级：一次抖动不该让整页换脸
    if (I.failures >= 2) {
      I.degraded = true;
      BAC.pushWarning('indexer_down');
    }
    BAC.emit('state', BAC.state);
  }

  /** 索引器这一段失败了。
      但如果这一段**正由层内 RPC 直接供数**（source === 'rpc'，而且是新鲜的），
      就别把它改成「读取失败」—— 那上面显示的是真的链上数据，只是不从索引器来。 */
  function failSection(sec, err) {
    sec.failures++;
    if (sec.source === 'rpc' && sec.ready && (Date.now() - (sec.updatedAt || 0)) < 60000) return;
    sec.error = TEXT.ERR;
    sec.errorDetail = BAC.errInfo(err).message;
    sec.status = 'error';
    sec.stale = !!sec.ready;
    sec.updatedAt = Date.now();
  }
  function okSection(sec) {
    sec.ready = true; sec.error = null; sec.errorDetail = null; sec.failures = 0;
    sec.source = 'indexer'; sec.status = 'ok'; sec.stale = false;
    sec.updatedAt = Date.now();
  }

  /* ══════════════════════════════════════════════════════
     2. 形状转换（接口字段名 = 契约，改一个就要同时改索引器/API/SDK/测试）
     ══════════════════════════════════════════════════════ */

  function feedItem(it) {
    return {
      id: num(it.id),
      chain: str(it.chain),
      kind: str(it.kind),
      ts: num(it.ts),
      block: num(it.block),
      agentId: it.agentId === null || it.agentId === undefined ? null : Number(it.agentId),
      textZh: str(it.textZh) || '',          // 索引器已渲染好；summary 已转义，绑定层仍然只能当文本用
      tx: str(it.tx),
      anchored: !!it.anchored,
      epoch: num(it.epoch),
      // 展示用的锚定标注（03 §3.3 的硬要求）
      anchorNote: it.anchored ? TEXT.ANCHORED : TEXT.NOT_ANCHORED,
      untrusted: true                        // 文本里可能含 agent 自己写的 summary
    };
  }

  function blockItem(b) {
    return {
      number: num(b.number), hash: str(b.hash), ts: num(b.ts),
      txCount: num(b.txCount), gasUsed: num(b.gasUsed), gasLimit: num(b.gasLimit),
      baseFee: big(b.baseFee), epoch: num(b.epoch)
    };
  }

  function txItem(t) {
    return {
      hash: str(t.hash), block: num(t.block), idx: num(t.idx),
      from: str(t.from), to: str(t.to), value: big(t.value),
      gasUsed: num(t.gasUsed), effGasPrice: big(t.effGasPrice), feeBurned: big(t.feeBurned),
      created: str(t.created), status: num(t.status),
      agentId: t.agentId === null || t.agentId === undefined ? null : Number(t.agentId),
      ts: num(t.ts)
    };
  }

  /** 两个名字取第一个给了的（v2 新名在前，v1 旧名兜底）。 */
  function pickFirst(a, k1, k2) {
    if (a[k1] !== undefined && a[k1] !== null) return a[k1];
    return a[k2];
  }
  function strList(v) {
    return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x; }).map(String) : [];
  }

  /** 索引器的 agent 条目。两版都认：
        v1（bac/agents/1）credited / exited / wallet
        v2（bac/agents/2）creditsLocked / creditsExited / layerWallets[] / holder / identityExists / registrationName / lockCount
      v2（决策 #31）没有自研 AgentRegistry、没有状态机：
      status / statusName / statusZh / solved / lastHeartbeatEpoch / missed / endpointHash / modelFingerprint
      一律 null —— 哪怕旧索引器还在发这些字段，它们描述的是一个已经不存在的合约，不许再显示。
      ERC-8004 的几项（identityId / identityOwner / agentWallet / tokenURI）索引器给了就原样带上；
      registrationName 是持有人自己写的注册文件里的名字 → 放进 selfReported（和链上直读的名录同一个形状）。 */
  function agentItem(a) {
    a = a && typeof a === 'object' ? a : {};
    var id = a.identityId !== undefined && a.identityId !== null ? num(a.identityId) : num(a.agentId);
    var wallets = strList(a.layerWallets);
    var wallet = wallets.length ? wallets[0] : str(a.wallet);
    var regName = typeof a.registrationName === 'string' && a.registrationName ? a.registrationName.slice(0, 200) : null;
    return {
      agentId: num(a.agentId), identityId: id,
      controller: str(a.controller),
      wallet: wallet,                        // 层内钱包（v2 可能有多个：layerWallets，第一个 = 最早进场的那个）
      layerWallets: wallets.length ? wallets : (wallet ? [wallet] : []),
      identityOwner: str(a.identityOwner) || str(a.holder),
      identityExists: a.identityExists === undefined || a.identityExists === null ? null : !!a.identityExists,
      identityCheckedAt: num(a.identityCheckedAt),
      agentWallet: str(a.agentWallet),
      tokenURI: str(a.tokenURI),
      registrationName: regName,
      selfReported: regName ? { name: regName, description: null, hasImage: null, note: TEXT.SELF_REPORTED } : null,
      source: 'indexer',
      status: null, statusName: null, statusZh: null,
      registeredAt: null, activatedAt: num(a.activatedAt !== undefined ? a.activatedAt : a.firstLockAt),
      firstLockAt: num(a.firstLockAt),
      deposits: num(a.lockCount),
      solved: null, lastHeartbeatEpoch: null, missed: null,
      credited: big(pickFirst(a, 'creditsLocked', 'credited')),
      exited: big(pickFirst(a, 'creditsExited', 'exited')),
      layerBalance: big(a.layerBalance),
      deploys: num(a.deploys), announces: num(a.announces), lastLayerBlock: num(a.lastLayerBlock),
      agentURI: null, endpointHash: null, modelFingerprint: null,
      untrusted: true                        // tokenURI / 注册名是身份持有人自己写的
    };
  }

  function validatorItem(v) {
    // §3.6 给的字段 + 决策 #17 的归集三元组（03 §3.7 尚未落稿，缺字段一律 null，不猜）
    var owed = big(v.cumOwed), remitted = big(v.cumRemitted);
    var arrears = big(v.arrears);
    if (arrears === null && owed !== null && remitted !== null) arrears = owed > remitted ? owed - remitted : 0n;
    return {
      nodeId: str(v.nodeId), validator: str(v.validator), payout: str(v.payout),
      enodeURI: str(v.enodeURI), active: v.active === undefined ? null : !!v.active,
      strikes: num(v.strikes), staked: big(v.staked), lastEpoch: num(v.lastEpoch),
      agreedEpochs: num(v.agreedEpochs), disputedEpochs: num(v.disputedEpochs),
      lifetimeClaimed: big(v.lifetimeClaimed),
      // 层内 gas 归集（已收 / 已转入 / 差额）
      gas: {
        collected: owed,          // cumOwed = 它欠基金会的那一份（按已收 gas 算出来的）
        remitted: remitted,
        shortfall: arrears,
        shortfallFlag: v.shortfall === undefined ? null : !!v.shortfall,
        proposerRights: v.proposerRights === undefined ? null : !!v.proposerRights,
        proposerAddr: str(v.proposerAddr),
        qualifyStreak: num(v.qualifyStreak),
        withheld: big(v.withheld)
      }
    };
  }

  function epochItem(e) {
    return {
      epoch: num(e.epoch), state: str(e.state) || 'NONE', stateZh: BAC.epochStateZh(e.state),
      exitRoot: str(e.exitRoot), l2Block: num(e.l2Block), l2BlockHash: str(e.l2BlockHash),
      credited: big(e.credited), exitCredits: big(e.exitCredits), feeBurned: big(e.feeBurned),
      circulating: big(e.circulating), exitCount: num(e.exitCount),
      postedAt: num(e.postedAt), postedTx: str(e.postedTx), finalizedAt: num(e.finalizedAt),
      agreeingCount: num(e.agreeingCount), agreeingWeight: big(e.agreeingWt || e.agreeingWeight),
      disputingWeight: big(e.disputingWt || e.disputingWeight),
      releaseBps: num(e.releaseBps), pot: big(e.pot), rate: big(e.rate),
      settledAt: num(e.settledAt), rewardPot: big(e.rewardPot),
      // 决策 #17：纪元级的 gas 对账（索引器给了就用，没给是 null）
      gasFees: big(e.gasFees), remitted: big(e.remitted), proposerCount: num(e.proposerCount)
    };
  }

  /* ══════════════════════════════════════════════════════
     3. 端点
     ══════════════════════════════════════════════════════ */

  var api = {
    health: function () { return fetchEndpoint('health', '/api/health'); },
    summary: function () { return fetchEndpoint('summary', '/api/summary'); },
    feed: function (params) { return fetchEndpoint('feed', '/api/feed', params); },
    agents: function (params) { return fetchEndpoint('agents', '/api/agents', params); },
    agent: function (id) { return fetchEndpoint('agent', '/api/agent/' + encodeURIComponent(id)); },
    blocks: function (params) { return fetchEndpoint('blocks', '/api/blocks', params); },
    /* 区块 / 交易详情：索引器读不到就直接问层内 RPC（bac-layer.js）。
       返回的字段名和索引器一致，绑定层那边一行都不用改。
       RPC 给不出来的东西（agent 归属、日志解码）一律 null —— 不猜。 */
    block: function (n) {
      return fetchEndpoint('block', '/api/block/' + encodeURIComponent(n)).catch(function (e) {
        if (!BAC.layer) throw e;
        return BAC.layer.block(n);
      });
    },
    tx: function (h) {
      return fetchEndpoint('tx', '/api/tx/' + encodeURIComponent(h)).catch(function (e) {
        if (!BAC.layer) throw e;
        return BAC.layer.tx(h).then(function (t) { return { tx: t, decoded: [], source: 'rpc' }; });
      });
    },
    contracts: function (params) { return fetchEndpoint('contracts', '/api/contracts', params); },
    /* 单个合约「这是个什么」（03 §7.6 的新端点）：classified / classifiedZh 直接给页面用。
       索引器给不出就是给不出，前端显示「我们没能识别出这个合约是什么」，**不猜**。 */
    contract: function (a) { return fetchEndpoint('contract', '/api/contract/' + encodeURIComponent(a)); },

    /* ── agent 造出来的东西：代币 / 交易对 / 成交（决策 #19，03 §7.6）──────
       全部是**启发式解码**的结果：会漏也会错，每个返回体都带 detection 块，
       页面必须把那句话显示出来。金额是该代币自己的最小单位，随行返回 decimals，
       **不许和 BAC / BNB 的金额合并**，也**不许折算成任何法币**（这条链上没有法币计价，也没有预言机）。 */
    tokens: function (params) { return fetchEndpoint('tokens', '/api/tokens', params); },
    token: function (a) { return fetchEndpoint('token', '/api/token/' + encodeURIComponent(a)); },
    tokenHolders: function (a, params) {
      return fetchEndpoint('tokenHolders', '/api/token/' + encodeURIComponent(a) + '/holders', params);
    },
    tokenTransfers: function (a, params) {
      return fetchEndpoint('tokenTransfers', '/api/token/' + encodeURIComponent(a) + '/transfers', params);
    },
    pairs: function (params) { return fetchEndpoint('pairs', '/api/pairs', params); },
    pair: function (a) { return fetchEndpoint('pair', '/api/pair/' + encodeURIComponent(a)); },
    swaps: function (params) { return fetchEndpoint('swaps', '/api/swaps', params); },
    epochs: function (params) { return fetchEndpoint('epochs', '/api/epochs', params); },
    epoch: function (n) { return fetchEndpoint('epoch', '/api/epoch/' + encodeURIComponent(n)); },
    leaves: function (n) { return fetchEndpoint('leaves', '/api/epoch/' + encodeURIComponent(n) + '/leaves'); },
    proof: function (n, exitId) {
      return fetchEndpoint('proof', '/api/epoch/' + encodeURIComponent(n) + '/proof/' + encodeURIComponent(exitId));
    },
    rate: function () { return fetchEndpoint('rate', '/api/rate'); },
    validators: function () { return fetchEndpoint('validators', '/api/validators'); },
    treasury: function (params) { return fetchEndpoint('treasury', '/api/treasury', params); },
    // 决策 #29c：桥的每一次升级 / 紧急提取 / 换 owner / 暂停，外加节点基金的提取（索引器从部署块起全量摄取）
    bridgeTimeline: function (params) { return fetchEndpoint('bridgeTimeline', '/api/bridge/timeline', params); },
    // 决策 #17 的 gas 费分账（03 §3.7）。单位是层内 BAC，渲染时必须显示单位，
    // 并且不许和 BSC 侧的 BNB 税收（treasury）合成一个总额。
    fees: function () { return fetchEndpoint('fees', '/api/fees'); },
    feeEpoch: function (n) { return fetchEndpoint('feeEpoch', '/api/fees/' + encodeURIComponent(n)); },
    proposers: function (params) { return fetchEndpoint('proposers', '/api/proposers', params); },
    get: get,
    qs: qs,
    health_: apiHealth
  };

  /* ══════════════════════════════════════════════════════
     4. 拉取 + 落进 state
     ══════════════════════════════════════════════════════ */

  function pullHealth() {
    var L = BAC.state.layer;
    return api.health().then(function (j) {
      BAC.state.health = j;
      var l = j.layer || {};
      L.source = 'indexer';
      L.chainId = num(l.chainId);
      L.head = num(l.head);
      L.headTs = num(l.headTs);
      L.blockLagSec = num(l.blockLagSec);
      L.gasLimit = num(l.gasLimit);
      L.baseFee = big(l.baseFee);
      L.peers = num(l.peers);
      L.enode = str(l.enode);
      L.genesisHash = str(l.genesisHash);
      L.relayer = j.relayer || null;
      L.reconcile = j.reconcile ? {
        bscTotalIssued: big(j.reconcile.bscTotalIssued),
        bscTotalExited: big(j.reconcile.bscTotalExited),
        layerCirculating: big(j.reconcile.layerCirculating),
        feeSinkBalance: big(j.reconcile.feeSinkBalance),
        // 决策 #17：FeeSplitter 余额与逐个验证者余额分项列出，网站要逐项显示，不许合并
        feeSplitterBalance: big(j.reconcile.feeSplitterBalance),
        validatorBalances: (j.reconcile.validatorBalances || []).map(function (v) {
          return { addr: str(v.addr), balance: big(v.balance) };
        }),
        // 创世分配项（公式里的 genesisAlloc）：创世时就不在 L2Bridge 里的余额。不把它和它由哪些账户组成
        // 一起交给页面，页面上就只剩一个 diff = 0，看不出那 1e24 从哪来（演练链上是 Hardhat 公开测试私钥的账户）
        genesisSupply: big(j.reconcile.genesisSupply),
        genesisAlloc: big(j.reconcile.genesisAlloc),
        genesisAllocAccounts: (Array.isArray(j.reconcile.genesisAllocAccounts) ? j.reconcile.genesisAllocAccounts : [])
          .map(function (x) { return { addr: str(x && x.addr), balance: big(x && x.balance) }; }),
        genesisSource: str(j.reconcile.genesisSource),     // 索引器读的创世文件路径；null = 没读到（按设计值算）
        note: str(j.reconcile.note),
        formula: str(j.reconcile.formula),
        diff: big(j.reconcile.diff),
        ok: j.reconcile.ok === undefined ? null : !!j.reconcile.ok,
        howToCheck: (j.reconcile.howToCheck || []).slice()   // 原样转交：任何人可以自己复算
      } : null;
      // 决策 #17 的 gas 分账块（单位是层内 BAC，不是 BNB；绝不能和 BSC 侧税收相加）
      L.gas = j.gas ? {
        officialBlockValidatorBps: num(j.gas.officialBlockValidatorBps),
        validatorBlockValidatorBps: num(j.gas.validatorBlockValidatorBps),
        lastAnchoredEpoch: num(j.gas.lastAnchoredEpoch),
        received: big(j.gas.received),
        remitted: big(j.gas.remitted),
        gap: big(j.gas.gap),
        gapBps: num(j.gas.gapBps),
        operatorFloatReserve: big(j.gas.operatorFloatReserve),
        remitOverdueEpochs: num(j.gas.remitOverdueEpochs),
        poolPending: big(j.gas.poolPending),
        carryPool: big(j.gas.carryPool),
        foundationBalance: big(j.gas.foundationBalance),
        shortfalls: (j.gas.shortfalls || []).slice()
      } : null;
      L.anchorCommitWindowEndsAt = num(j.anchorCommitWindowEndsAt);
      (j.warnings || []).forEach(function (w) { BAC.pushWarning('indexer:' + w); });
      if (l.headTs) BAC.time.setChainTime(Number(l.headTs));
      okSection(L);
      L.sections.head = 'ok';
      L.endpoint = BAC.state.indexer.endpoint;
      BAC.emit('health', j);
      return j;
    }).catch(function (e) {
      failSection(L, e);
      L.sections.head = L.status;
      return layerRpcFallback().catch(function () { return null; });
    });
  }

  /** 索引器挂了的最后一跳：直接问层内 RPC。
      bac-layer.js 在的话交给它（它会读整套块头 + 区块 + 交易，并自己做主/兜底端点切换）；
      不在的话退回这里最小的一跳：只问一个块高，只为回答「链还活着吗」。 */
  function layerRpcFallback() {
    var L = BAC.state.layer;
    if (BAC.layer) return BAC.layer.run({ once: true }).then(function () { return L; });
    if (!CFG.layerRpc || typeof root.fetch !== 'function') return Promise.reject(new Error('没有层内 RPC'));
    var ctl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, CFG.apiTimeoutMs);
    return root.fetch(CFG.layerRpc, {
      method: 'POST', mode: 'cors', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      if (!res || !res.ok) throw new Error('HTTP ' + ((res && res.status) || 0));
      return res.json();
    }).then(function (j) {
      if (!j || !j.result) throw new Error('层内 RPC 没有返回 result');
      L.source = 'rpc';         // 标清楚：这个数不是索引器给的
      L.head = Number(BigInt(j.result));
      L.headTs = null;          // 不知道就是 null，不猜
      L.blockLagSec = null;
      L.error = TEXT.ERR;       // 层内数据整体仍然是「读取失败 · 重试中」
      L.updatedAt = Date.now();
      return L;
    }).catch(function (e) {
      clearTimeout(timer);
      L.source = null;
      throw e;
    });
  }

  function pullSummary() {
    return api.summary().then(function (j) {
      BAC.state.summary = j;
      BAC.emit('summary', j);
      return j;
    }).catch(function () { return null; });
  }

  function pullFeed(opts) {
    opts = opts || {};
    var F = BAC.state.feed;
    var params = { limit: CFG.feedLimit };
    if (!opts.initial && F.head) params.after = F.head;
    if (opts.kind) params.kind = opts.kind;
    if (opts.chain) params.chain = opts.chain;
    if (opts.agentId !== undefined && opts.agentId !== null) params.agentId = opts.agentId;
    return api.feed(params).then(function (j) {
      var fresh = (j.items || []).map(feedItem);
      if (opts.initial || !F.items.length) {
        F.items = fresh.slice().sort(function (a, b) { return b.id - a.id; }).slice(0, CFG.feedMax);
      } else if (fresh.length) {
        var seen = {};
        F.items.forEach(function (it) { seen[it.id] = 1; });
        var add = fresh.filter(function (it) { return !seen[it.id]; });
        F.items = add.concat(F.items).sort(function (a, b) { return b.id - a.id; }).slice(0, CFG.feedMax);
      }
      F.head = num(j.head) || (F.items.length ? F.items[0].id : null);
      F.anchoredThrough = num(j.anchoredThrough);
      okSection(F);
      BAC.emit('feed', { items: F.items, fresh: fresh, initial: !!opts.initial, error: null, head: F.head });
      return F.items;
    }).catch(function (e) {
      failSection(F, e);
      BAC.emit('feed', { items: F.items, fresh: [], initial: !!opts.initial, error: F.error, head: F.head });
      return F.items;
    });
  }

  function pullBlocks() {
    var B = BAC.state.blocks;
    return api.blocks({ limit: CFG.blocksLimit }).then(function (j) {
      B.items = (j.items || []).map(blockItem).sort(function (a, b) { return b.number - a.number; });
      okSection(B);
      BAC.state.layer.sections.blocks = 'ok';
      BAC.emit('blocks', B.items);
      return B.items;
    }).catch(function (e) {
      failSection(B, e);
      BAC.state.layer.sections.blocks = B.status;
      return B.items;
    });
  }

  /** 最近的交易：/api/blocks 不带交易，所以取最新的块再读它的交易列表。 */
  function pullTxs() {
    var T = BAC.state.txs, B = BAC.state.blocks;
    var head = B.items.length ? B.items[0].number : (BAC.state.layer.head || null);
    if (head === null) { return Promise.resolve(T.items); }
    return api.block(head).then(function (j) {
      var txs = (j.txs || []).map(txItem);
      // 头块可能是空块：往下找一块有交易的，最多找 3 块，找不到就如实显示「最近没有交易」
      if (!txs.length && B.items.length > 1) {
        return api.block(B.items[1].number).then(function (j2) {
          T.items = (j2.txs || []).map(txItem);
          okSection(T);
          return T.items;
        });
      }
      T.items = txs;
      okSection(T);
      BAC.state.layer.sections.txs = 'ok';
      return T.items;
    }).catch(function (e) {
      failSection(T, e);
      BAC.state.layer.sections.txs = T.status;
      return T.items;
    });
  }

  function pullAgents(params) {
    var G = BAC.state.agentList;
    var p = Object.assign({ page: 1, pageSize: CFG.agentsPageSize, sort: 'newest' }, params || {});
    return api.agents(p).then(function (j) {
      // 视图只认 bac/agents/2：/1 数的是已经删掉的 AgentRegistry（#31），编号也不是 ERC-8004 身份号
      G.schema = typeof j.schema === 'string' ? j.schema : null;
      G.items = (j.items || []).map(agentItem);
      G.total = num(j.total);
      G.page = num(j.page) || 1;
      okSection(G);
      BAC.emit('agents', G.items);
      return G.items;
    }).catch(function (e) { failSection(G, e); return G.items; });
  }

  function pullValidators() {
    var V = BAC.state.validators;
    return api.validators().then(function (j) {
      V.items = (j.items || []).map(validatorItem);
      V.totalStaked = big(j.totalStaked);
      V.rewardBalance = big(j.rewardBalance);
      okSection(V);
      BAC.emit('validators', V.items);
      return V.items;
    }).catch(function (e) { failSection(V, e); return V.items; });
  }

  function pullEpochs() {
    var E = BAC.state.epochs;
    return api.epochs({ limit: 30 }).then(function (j) {
      E.items = (j.items || []).map(epochItem).sort(function (a, b) { return b.epoch - a.epoch; });
      okSection(E);
      BAC.emit('epochs', E.items);
      return E.items;
    }).catch(function (e) { failSection(E, e); return E.items; });
  }

  /** 兑付率。两版都认：
        v2（bac/rate/2）bacPerCredit（BAC / 积分，1e18 定点）+ buybackBac（回购桶，BAC）+ unit
        v1（bac/rate/1）weiPerCredit + poolBalance（那时兑付的是 BNB）
      weiPerCredit / poolBalance 保留为旧键名，值与 bacPerCredit / buybackBac 相同，单位一律看 unit。
      没有在外的积分时合约 currentRate() 返回 0 —— 那是「没有汇率」，这里记成 null。 */
  function pullRate() {
    var R = BAC.state.rate;
    return api.rate().then(function (j) {
      var v2 = j.bacPerCredit !== undefined || j.buybackBac !== undefined;
      var rate = big(pickFirst(j, 'bacPerCredit', 'weiPerCredit'));
      var outstanding = big(j.creditsOutstanding);
      if (outstanding === 0n) rate = null;
      R.bacPerCredit = rate;
      R.weiPerCredit = rate;
      R.buybackBac = big(j.buybackBac);
      R.poolBalance = big(pickFirst(j, 'buybackBac', 'poolBalance'));
      R.unit = typeof j.unit === 'string' && j.unit ? j.unit : (v2 ? 'BAC' : (j.weiPerCredit !== undefined ? 'BNB' : null));
      R.rateSource = str(j.source);
      R.owedTotal = big(j.owedTotal);
      R.creditsOutstanding = outstanding;
      R.lastPot = big(j.lastPot);
      R.note = str(j.note) || '估算 · 不承诺任何金额';
      okSection(R);
      return R;
    }).catch(function (e) { failSection(R, e); return R; });
  }

  /** 决策 #29c 的完整时间线：索引器 /api/bridge/timeline。条目整形成和 BSC 日志时间线同一个形状
      （bac-chain.js 的 shapeEvent），视图层按 tx:logIndex 与日志窗口合并去重。
      旧版索引器没有这个端点（404）→ 这一段报错，但不算索引器挂了（见 fetchEndpoint）。 */
  function pullBridgeTimeline() {
    var O = BAC.state.ownerTimeline;
    if (!BAC.chain || typeof BAC.chain.shapeEvent !== 'function') return Promise.resolve(O);
    var limit = CFG.timelineMax;
    /* 索引器的 BSC 摄取游标：取**发请求之前**最近一次 /api/health 给的值（只会比这次应答实际覆盖到的更小 →
       拿它判断「索引器的历史 + 浏览器的日志窗口有没有接上」只会偏保守，不会多说）。 */
    var H = BAC.state.health;
    var cursorBefore = H && H.indexer && H.indexer.bscCursor !== undefined && H.indexer.bscCursor !== null
      ? Number(H.indexer.bscCursor) : null;
    if (cursorBefore !== null && !isFinite(cursorBefore)) cursorBefore = null;
    return api.bridgeTimeline({ scope: 'all', limit: limit }).then(function (j) {
      var owner = [], nodeFund = [];
      O.bscCursor = cursorBefore;
      // 索引器盯的必须就是本站配置里的那两个合约：对不上（比如它还指着演练用的地址）就一条都不用
      var A = CFG.addresses;
      function sameAs(got, want) {
        return !got || !BAC.isAddr(want) || String(got).toLowerCase() === String(want).toLowerCase();
      }
      var okBridge = sameAs(j.bridge, A.bridge), okFund = sameAs(j.nodeFund, A.nodeFund);
      O.addressMismatch = !(okBridge && okFund);
      (Array.isArray(j.items) ? j.items : []).forEach(function (r) {
        if (!r || typeof r !== 'object') return;
        var which = r.contract === 'BacBridge' ? 'bridge' : (r.contract === 'BacNodeFund' ? 'nodeFund' : null);
        if (!which || typeof r.event !== 'string') return;
        if ((which === 'bridge' && !okBridge) || (which === 'nodeFund' && !okFund)) return;
        var d = BAC.chain.shapeEvent(which, r.event, r.args && typeof r.args === 'object' ? r.args : {}, {
          block: num(r.block), tx: str(r.tx), logIndex: num(r.logIndex), ts: num(r.ts), source: 'indexer'
        });
        if (!d) return;
        d.item.textZh = str(r.textZh);   // 索引器渲染好的一句话（纯文本，绑定层只能当文本用）
        if (d.list === 'owner') owner.push(d.item);
        else if (d.list === 'nodeFund') nodeFund.push(d.item);
      });
      var t = j.totals || null;
      O.owner = BAC.chain.mergeTimeline([owner], true);
      O.nodeFund = BAC.chain.mergeTimeline([nodeFund], false);
      O.totals = t ? {
        upgrades: num(t.upgrades), emergencyWithdrawals: num(t.emergencyWithdrawals),
        emergencyBnb: big(t.emergencyBnb), emergencyBac: big(t.emergencyBac),
        emergencyOtherTokens: num(t.emergencyOtherTokens), ownerChanges: num(t.ownerChanges),
        nodeFundWithdrawals: num(t.nodeFundWithdrawals), nodeFundWithdrawn: big(t.nodeFundWithdrawn)
      } : null;
      O.limit = limit;
      // 返回满了 limit 条 = 可能还有更早的没给，不能拿它说「全了」
      O.truncated = (Array.isArray(j.items) ? j.items.length : 0) >= limit;
      O.bridgeAddress = str(j.bridge);
      O.nodeFundAddress = str(j.nodeFund);
      if (O.addressMismatch) {
        O.totals = null;   // 别的合约的累计数，不能拿来和本站的计数器对
        BAC.pushWarning('indexer_address_mismatch');
      } else BAC.clearWarning('indexer_address_mismatch');
      okSection(O);
      BAC.emit('timeline', BAC.state.timeline);
      return O;
    }).catch(function (e) { failSection(O, e); return O; });
  }

  /* ══════════════════════════════════════════════════════
     5. 轮询
     ══════════════════════════════════════════════════════ */

  var timer = null, started = false, tick = 0, inFlight = null;

  function period() {
    var I = BAC.state.indexer;
    if (BAC.state.hidden) return null;
    if (I.failures > 0) return Math.min(120000, BAC.backoffMs(I.failures, 5000));
    return CFG.apiPollMs;
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    var ms = period();
    if (ms === null) return;
    timer = setTimeout(run, ms);
  }

  function run(opts) {
    opts = opts || {};
    if (inFlight) return inFlight;
    if (!API_EPS.length) return Promise.resolve();
    var first = tick === 0;
    tick++;
    var health = pullHealth();              // 不会 reject（失败时自己退到层内 RPC）
    var jobs = [health, pullFeed({ initial: first }), pullBlocks()];
    // 慢速的几段每 5 轮拉一次，别把索引器打满
    if (first || tick % 5 === 0) {
      jobs.push(pullSummary(), pullValidators(), pullEpochs(), pullAgents(), pullRate());
      // owner 权力的完整历史：配置里有桥合约才问（阶段 a 什么都没部署，问了也是空）。
      // 排在 health 之后发：它要拿 health 里的摄取游标当「这份历史至少覆盖到哪」（先拿到的游标只会更小，偏保守）
      if (BAC.CONTRACTS_CONFIGURED) jobs.push(health.then(function () { return pullBridgeTimeline(); }));
    }
    inFlight = Promise.all(jobs)
      .then(function () { return pullTxs(); })
      .then(function () {
        BAC.emit('state', BAC.state);
        inFlight = null;
        if (!opts.once) schedule();
      })
      .catch(function (e) {
        BAC.logErr('api.run', e);
        inFlight = null;
        if (!opts.once) schedule();
      });
    return inFlight;
  }

  BAC.on('hidden', function (hidden) {
    if (hidden) { if (timer) { clearTimeout(timer); timer = null; } return; }
    var age = Date.now() - (BAC.state.indexer.updatedAt || 0);
    if (age > 5000) run(); else schedule();
  });

  BAC.api = Object.assign(api, {
    shape: {
      feedItem: feedItem, blockItem: blockItem, txItem: txItem,
      agentItem: agentItem, validatorItem: validatorItem, epochItem: epochItem
    },
    pull: {
      health: pullHealth, summary: pullSummary, feed: pullFeed, blocks: pullBlocks,
      txs: pullTxs, agents: pullAgents, validators: pullValidators, epochs: pullEpochs, rate: pullRate,
      bridgeTimeline: pullBridgeTimeline
    },
    layerRpcFallback: layerRpcFallback,
    run: run,
    start: function () { if (started) return; started = true; run(); },
    stop: function () { if (timer) { clearTimeout(timer); timer = null; } started = false; },
    /** 降级说明：给绑定层一句能直接显示的中文。
        层内节点还答话的时候不许说「层内数据暂时不可用」—— 块和交易照样是真的。 */
    degradedNote: function () {
      if (!BAC.state.indexer.degraded) return null;
      return BAC.LAYER_LIVE ? TEXT.RPC_DIRECT : TEXT.NO_INDEXER;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
