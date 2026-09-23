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
      markIndexerFail(err);
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

  function agentItem(a) {
    return {
      agentId: num(a.agentId), controller: str(a.controller), wallet: str(a.wallet),
      status: num(a.status), statusName: str(a.statusName) || BAC.statusName(a.status),
      statusZh: BAC.statusZh(a.status),
      registeredAt: num(a.registeredAt), activatedAt: num(a.activatedAt),
      solved: num(a.solved), lastHeartbeatEpoch: num(a.lastHeartbeatEpoch), missed: num(a.missed),
      credited: big(a.credited), exited: big(a.exited), layerBalance: big(a.layerBalance),
      deploys: num(a.deploys), announces: num(a.announces), lastLayerBlock: num(a.lastLayerBlock),
      agentURI: str(a.agentURI), endpointHash: str(a.endpointHash), modelFingerprint: str(a.modelFingerprint),
      untrusted: true                        // agentURI 是 agent 自己写的
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
    epochs: function (params) { return fetchEndpoint('epochs', '/api/epochs', params); },
    epoch: function (n) { return fetchEndpoint('epoch', '/api/epoch/' + encodeURIComponent(n)); },
    leaves: function (n) { return fetchEndpoint('leaves', '/api/epoch/' + encodeURIComponent(n) + '/leaves'); },
    proof: function (n, exitId) {
      return fetchEndpoint('proof', '/api/epoch/' + encodeURIComponent(n) + '/proof/' + encodeURIComponent(exitId));
    },
    rate: function () { return fetchEndpoint('rate', '/api/rate'); },
    validators: function () { return fetchEndpoint('validators', '/api/validators'); },
    treasury: function (params) { return fetchEndpoint('treasury', '/api/treasury', params); },
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

  function pullRate() {
    var R = BAC.state.rate;
    return api.rate().then(function (j) {
      R.weiPerCredit = big(j.weiPerCredit);
      R.poolBalance = big(j.poolBalance);
      R.owedTotal = big(j.owedTotal);
      R.creditsOutstanding = big(j.creditsOutstanding);
      R.lastPot = big(j.lastPot);
      R.note = str(j.note) || '估算 · 不承诺任何金额';
      okSection(R);
      return R;
    }).catch(function (e) { failSection(R, e); return R; });
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
    var jobs = [pullHealth(), pullFeed({ initial: first }), pullBlocks()];
    // 慢速的几段每 5 轮拉一次，别把索引器打满
    if (first || tick % 5 === 0) jobs.push(pullSummary(), pullValidators(), pullEpochs(), pullAgents(), pullRate());
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
      txs: pullTxs, agents: pullAgents, validators: pullValidators, epochs: pullEpochs, rate: pullRate
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
