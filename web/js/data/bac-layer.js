/* BNB Agent Chain · 数据层 · 层内直读（不经索引器，直接打 JSON-RPC）
   ─────────────────────────────────────────────────────────────
   为什么要单独有这个文件：
   - 层内这条链**现在就在出块**（Besu QBFT，3 秒一块，chainId 56777），索引器还没部署。
     索引器读不到的时候，区块和交易必须照常显示 —— 它们是真实存在的链上数据。
     「发射后公布」只留给 BSC 侧那些**还不存在**的合约（金库 / 桥 / 质押 / 锚点）。
   - 不走 ethers 的 provider 栈：ethers 会对未知链做网络探测与自己的重试，
     这里要的只是「发一个 JSON-RPC、超时就换端点」，裸 fetch 更短、更可测、也更少意外。
     超时与退避仍然照 docs/research/04-website-conventions.md §1.3 的那一套。
   规矩照旧：本文件没有一行 DOM 代码；读不到就是 null，绝不编数、绝不用上一轮的数冒充新数。

   加载顺序：site.config.js → ethers → bac-core.js → bac-chain.js → **bac-layer.js** → bac-api.js → bac-view.js */
(function (root) {
  'use strict';

  var BAC = root.BAC;
  if (!BAC || !BAC.core) {
    if (root.console) root.console.error('[BAC] bac-layer.js 需要先加载 bac-core.js');
    return;
  }
  if (BAC.layer) return;

  var CFG = BAC.CFG, TEXT = BAC.TEXT, big = BAC.big;

  /* ══════════════════════════════════════════════════════
     1. 请求数的硬上限（任何一条路径都不许发无界数量的请求）
     ══════════════════════════════════════════════════════ */

  var MAX_BATCH = 25;       // 一个 JSON-RPC 数组体里最多放几条
  var MAX_BLOCKS = 25;      // latestBlocks(n) 的 n 上限
  var MAX_TXS = 25;         // latestTxs(n) 的 n 上限
  var RECEIPT_BLOCKS = 6;   // 一轮最多为几个非空块取收据（只为拿 status / gasUsed / 手续费）
  var MAX_HOPS = 2;         // 一次逻辑调用最多打几个端点（主 → 兜底），不做无限重试
  var REQ_FULL = 3;         // 一轮完整轮询的请求数：元信息 1 + 区块 1 + 收据 1
  var REQ_HEAD = 2;         // 一次 head()：批量 1 + 上一块 1

  /* ══════════════════════════════════════════════════════
     2. 端点：主用在前，兜底在后
        主域名（bnbagentchain-rpc.xyz）没解析出来时自动落到 sslip.io 那个 IP 端点，
        主域名一旦能用又会自动换回去（退避到期后 pickEndpoint 天然优先主端点）。
     ══════════════════════════════════════════════════════ */

  var EPS = [];
  function pushEp(u) { if (typeof u === 'string' && u && EPS.indexOf(u) < 0) EPS.push(u); }
  pushEp(CFG.layerRpc);
  pushEp(CFG.fallbackRpc);

  var epHealth = BAC.healthTable(5000);   // 基数 5 秒，翻倍，封顶 120 秒（= 主端点最长 120 秒复探一次）
  var current = null;                     // 上一次成功的端点
  var stats = { requests: 0, batches: 0, failovers: 0, byUrl: {} };

  function pickEndpoint(now, tried) {
    tried = tried || [];
    var order = EPS.slice();
    // 主端点还在退避里时，优先用上一次成功的那个，别每轮都去撞墙
    if (current && order.length > 1 && order[0] !== current && !epHealth.healthy(order[0], now)) {
      order = [current].concat(order.filter(function (u) { return u !== current; }));
    }
    var best = null, bestUntil = Infinity, i, u;
    for (i = 0; i < order.length; i++) {
      u = order[i];
      if (tried.indexOf(u) >= 0) continue;
      if (epHealth.healthy(u, now)) return u;
      var until = epHealth.get(u).until;
      if (until < bestUntil) { bestUntil = until; best = u; }
    }
    return best;   // 全都在退避里也不彻底放弃：挑最快到期的那个
  }

  /* ══════════════════════════════════════════════════════
     3. 裸 JSON-RPC：超时 / 失败换端点 / 批量
     ══════════════════════════════════════════════════════ */

  function post(url, payload, timeoutMs) {
    var f = root.fetch;
    if (typeof f !== 'function') return Promise.reject(new Error('浏览器不支持 fetch'));
    var ctl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timer = root.setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs || CFG.layerTimeoutMs);
    stats.requests++;
    stats.byUrl[url] = (stats.byUrl[url] || 0) + 1;
    return f(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      root.clearTimeout(timer);
      if (!res || !res.ok) {
        var e = new Error('HTTP ' + ((res && res.status) || 0));
        e.status = res && res.status;
        throw e;
      }
      return res.json();
    }, function (err) {
      root.clearTimeout(timer);
      throw err;
    });
  }

  /** 一次发一批 [{method, params}]，按请求顺序返回 [{result} | {error}]。
      网络层失败（超时 / HTTP 错 / 不是 JSON）才换端点；
      JSON-RPC 自己报的 error（比如方法没开）只是这一条的事，不算端点坏了。 */
  function send(items, opts) {
    opts = opts || {};
    if (!EPS.length) return Promise.reject(new Error('没有配置层内 RPC 地址'));
    if (!items || !items.length) return Promise.resolve([]);
    if (items.length > MAX_BATCH) return Promise.reject(new Error('一次最多 ' + MAX_BATCH + ' 条 JSON-RPC'));

    var body = items.map(function (it, i) {
      return { jsonrpc: '2.0', id: i + 1, method: it.method, params: it.params || [] };
    });
    var payload = body.length === 1 ? body[0] : body;
    var tried = [], lastErr = null;
    stats.batches++;

    function attempt() {
      var now = Date.now();
      var url = pickEndpoint(now, tried);
      if (!url) return Promise.reject(lastErr || new Error('层内 RPC 都读不到'));
      tried.push(url);
      return post(url, payload, opts.timeoutMs).then(function (j) {
        var arr = (j && Object.prototype.toString.call(j) === '[object Array]') ? j : [j];
        if (!arr.length || arr[0] === null || arr[0] === undefined) throw new Error('层内 RPC 返回了空响应');
        var byId = {};
        arr.forEach(function (r) { if (r && r.id !== undefined && r.id !== null) byId[r.id] = r; });
        var out = body.map(function (q, i) {
          return byId[q.id] || arr[i] || { error: { code: -1, message: '没有对应的响应' } };
        });
        epHealth.ok(url);
        if (current !== url) { if (current) stats.failovers++; current = url; }
        BAC.state.layer.endpoint = url;
        return out;
      }, function (err) {
        epHealth.bad(url, err, now);
        lastErr = err;
        if (tried.length >= Math.min(MAX_HOPS, EPS.length)) throw err;
        return attempt();
      });
    }
    return attempt();
  }

  function okRow(r) { return !!(r && !r.error); }

  function unwrap(r) {
    if (!r) throw new Error('层内 RPC 没有返回响应');
    if (r.error) {
      var e = new Error(r.error.message || 'JSON-RPC 错误');
      e.code = 'rpc';
      e.rpcCode = r.error.code;
      throw e;
    }
    return r.result;
  }

  /** 单条调用。 */
  function call(method, params, opts) {
    return send([{ method: method, params: params || [] }], opts).then(function (rs) { return unwrap(rs[0]); });
  }

  /* ══════════════════════════════════════════════════════
     4. 形状转换（字段名对齐索引器 docs/03-INTERFACES.md §3，
        这样索引器上线后同一批绑定代码不用改；RPC 读不出来的字段一律 null）
     ══════════════════════════════════════════════════════ */

  function hnum(h) {
    if (h === null || h === undefined) return null;
    if (typeof h === 'number') return isFinite(h) ? h : null;
    var b = big(h);
    return b === null ? null : Number(b);
  }
  function hbig(h) { return big(h); }
  function hex(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) return '0x0';
    return '0x' + Math.floor(v).toString(16);
  }
  function isHash(s) { return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s); }

  /** 一笔交易。收据（r）没拿到的字段一律 null —— 不用 gas 上限冒充 gasUsed。 */
  function txRow(t, blockTs, r, idx, baseFee) {
    if (!t) return null;
    var bn = hnum(t.blockNumber);
    var gasUsed = r ? hnum(r.gasUsed) : null;
    var eff = r ? hbig(r.effectiveGasPrice) : null;
    if (eff === null && r) eff = hbig(t.gasPrice);       // 有收据但没给 effectiveGasPrice：legacy 交易就是 gasPrice
    var fee = (gasUsed !== null && eff !== null) ? BigInt(gasUsed) * eff : null;
    // zeroBaseFee：baseFeePerGas 实测就是 0x0，销毁额 = gasUsed × baseFee = 0；
    // baseFee 不知道的时候就是 null，不默认成 0。
    var burned = (gasUsed !== null && baseFee !== null && baseFee !== undefined)
      ? BigInt(gasUsed) * baseFee : null;
    return {
      hash: t.hash || null,
      block: bn, blockNumber: bn, blockHash: t.blockHash || null,
      idx: t.transactionIndex !== undefined && t.transactionIndex !== null
        ? hnum(t.transactionIndex) : (idx === undefined ? null : idx),
      from: t.from || null,
      to: t.to === undefined ? null : t.to,
      value: hbig(t.value),
      gas: hnum(t.gas),
      gasPrice: hbig(t.gasPrice),
      nonce: hnum(t.nonce),
      type: t.type === undefined ? null : hnum(t.type),
      input: t.input === undefined ? null : t.input,
      // 是不是部署合约：to 为空就是部署；合约地址要收据才知道
      isCreate: !t.to,
      created: (r && r.contractAddress) ? r.contractAddress : null,
      gasUsed: gasUsed,
      effGasPrice: eff,
      feeBurned: burned,
      // zeroBaseFee 下手续费整笔归出块人（决策 #17 的分账基数）
      fee: fee,
      feeToProposer: fee,
      status: r ? (hnum(r.status) === 1 ? 1 : 0) : null,
      logsCount: r && r.logs ? r.logs.length : null,
      agentId: null,        // agent 归属只有索引器知道，RPC 读不出来 → null，不猜
      ts: blockTs === undefined ? null : blockTs,
      source: 'rpc'
    };
  }

  /** 一个区块。full=true 取回来的块自带完整交易对象，顺手转成交易行。 */
  function blockRow(b) {
    if (!b) return null;
    var ts = hnum(b.timestamp);
    var list = b.transactions || [];
    var full = list.length > 0 && typeof list[0] === 'object';
    var baseFee = hbig(b.baseFeePerGas);
    return {
      number: hnum(b.number),
      hash: b.hash || null,
      ts: ts, timestamp: ts,
      txCount: list.length,
      gasUsed: hnum(b.gasUsed),
      gasLimit: hnum(b.gasLimit),
      baseFee: baseFee,                       // zeroBaseFee：实测恒为 0n
      epoch: ts === null ? null : BAC.epochOf(ts),
      miner: b.miner || null,
      proposer: b.miner || null,              // QBFT：miner 就是这一块的提案人
      parentHash: b.parentHash || null,
      stateRoot: b.stateRoot || null,
      extraData: b.extraData || null,
      size: hnum(b.size),
      txHashes: full ? list.map(function (t) { return t.hash; }) : list.slice(),
      // 这一块的手续费合计：空块就是实打实的 0；有交易但还没取收据 → null（不拿 gas 上限估）
      feeTotal: list.length === 0 ? 0n : null,
      txs: full ? list.map(function (t, i) { return txRow(t, ts, null, i, baseFee); }) : [],
      anchored: false,                        // 层内块要等纪元锚点上 BSC 才算锚定
      official: null,                         // 是不是官方节点出的块，RPC 分不出来
      source: 'rpc'
    };
  }

  /** 把 eth_getBlockReceipts 的结果贴回区块里，并算出这一块的手续费合计。 */
  function applyReceipts(b, list) {
    if (!b || !list || !list.length) return b;
    var byHash = {};
    list.forEach(function (r) { if (r && r.transactionHash) byHash[String(r.transactionHash).toLowerCase()] = r; });
    var total = 0n, allKnown = true;
    b.txs = (b.txs || []).map(function (t) {
      var r = byHash[String(t.hash || '').toLowerCase()];
      if (!r) { allKnown = false; return t; }
      var gasUsed = hnum(r.gasUsed);
      var eff = hbig(r.effectiveGasPrice);
      if (eff === null) eff = t.gasPrice;
      t.gasUsed = gasUsed;
      t.effGasPrice = eff;
      t.created = r.contractAddress || null;
      t.status = hnum(r.status) === 1 ? 1 : 0;
      t.logsCount = r.logs ? r.logs.length : null;
      t.fee = (gasUsed !== null && eff !== null) ? BigInt(gasUsed) * eff : null;
      t.feeToProposer = t.fee;
      t.feeBurned = (gasUsed !== null && b.baseFee !== null) ? BigInt(gasUsed) * b.baseFee : null;
      if (t.fee === null) allKnown = false; else total += t.fee;
      return t;
    });
    b.feeTotal = allKnown ? total : null;
    return b;
  }

  /** 为最近的几个非空块批量取收据：一次请求，最多 RECEIPT_BLOCKS 条。
      节点没开 eth_getBlockReceipts 就安静降级（手续费与状态保持 null）。 */
  function fillReceipts(blocks) {
    var targets = [];
    for (var i = 0; i < blocks.length && targets.length < RECEIPT_BLOCKS; i++) {
      if (blocks[i] && blocks[i].txCount > 0) targets.push(blocks[i]);
    }
    if (!targets.length) return Promise.resolve(blocks);
    return send(targets.map(function (b) {
      return { method: 'eth_getBlockReceipts', params: [hex(b.number)] };
    })).then(function (rs) {
      rs.forEach(function (r, i) {
        if (!okRow(r) || !r.result || typeof r.result.length !== 'number') return;
        applyReceipts(targets[i], r.result);
      });
      return blocks;
    }, function () { return blocks; });
  }

  /* ══════════════════════════════════════════════════════
     5. 对外的读接口
     ══════════════════════════════════════════════════════ */

  /** 链头：chainId、块高、时间戳、gasLimit、baseFee，以及**实测**出块间隔（拿最后两块的时间差）。
      请求数固定 2。 */
  function head() {
    return send([
      { method: 'eth_chainId' },
      { method: 'eth_getBlockByNumber', params: ['latest', false] },
      { method: 'eth_gasPrice' },
      { method: 'net_peerCount' },
      { method: 'txpool_status' }
    ]).then(function (rs) {
      var b = okRow(rs[1]) ? rs[1].result : null;
      if (!b) throw new Error('层内 RPC 没有返回最新区块');
      var row = blockRow(b);
      var info = {
        endpoint: current,
        chainId: okRow(rs[0]) ? hnum(rs[0].result) : null,
        number: row.number, head: row.number, hash: row.hash,
        timestamp: row.ts, headTs: row.ts,
        gasLimit: row.gasLimit, gasUsed: row.gasUsed,
        baseFeePerGas: row.baseFee, baseFee: row.baseFee,
        miner: row.miner, proposer: row.miner, txCount: row.txCount,
        gasPrice: okRow(rs[2]) ? hbig(rs[2].result) : null,
        peers: okRow(rs[3]) ? hnum(rs[3].result) : null,
        // Besu 默认不开 TXPOOL API（实测返回 -32601 Method not found）：读不到就是 null，不报错
        txpool: (okRow(rs[4]) && rs[4].result) ? {
          pending: hnum(rs[4].result.pending), queued: hnum(rs[4].result.queued)
        } : null,
        blockIntervalSec: null,
        at: Date.now()
      };
      if (row.number === null || row.number <= 0) return info;
      return call('eth_getBlockByNumber', [hex(row.number - 1), false]).then(function (pb) {
        var pts = pb ? hnum(pb.timestamp) : null;
        if (pts !== null && info.timestamp !== null) info.blockIntervalSec = info.timestamp - pts;
        return info;
      }, function () { return info; });
    });
  }

  /** 最近 n 个块。请求数：1（块）+ 最多 1（收据）；给了 opts.head 就不再多问一次块高。 */
  function latestBlocks(n, opts) {
    opts = opts || {};
    n = Math.max(1, Math.min(MAX_BLOCKS, Number(n) || Math.min(MAX_BLOCKS, CFG.blocksLimit)));
    var headP = (opts.head !== undefined && opts.head !== null)
      ? Promise.resolve(Number(opts.head))
      : call('eth_blockNumber').then(function (h) { return hnum(h); });
    return headP.then(function (h) {
      if (h === null || !isFinite(h)) throw new Error('层内 RPC 没有返回块高');
      var want = Math.min(n, h + 1);
      var items = [];
      for (var i = 0; i < want; i++) items.push({ method: 'eth_getBlockByNumber', params: [hex(h - i), true] });
      return send(items);
    }).then(function (rs) {
      var out = [];
      rs.forEach(function (r) { if (okRow(r) && r.result) out.push(blockRow(r.result)); });
      out.sort(function (a, b) { return b.number - a.number; });
      if (opts.receipts === false) return out;
      return fillReceipts(out);
    });
  }

  /** 最近 n 笔交易：从最近的块里捡，块本身是 full=true 取的，不再逐笔请求。
      请求数和 latestBlocks 一样（最多 3，含块高那一次）。 */
  function latestTxs(n, opts) {
    opts = opts || {};
    n = Math.max(1, Math.min(MAX_TXS, Number(n) || 10));
    var scan = Math.max(n, Math.min(MAX_BLOCKS, opts.scan || CFG.blocksLimit));
    return latestBlocks(scan, opts).then(function (blocks) { return collectTxs(blocks, n); });
  }

  function collectTxs(blocks, n) {
    var out = [];
    for (var i = 0; i < blocks.length && out.length < n; i++) {
      var b = blocks[i];
      if (!b || !b.txs || !b.txs.length) continue;
      for (var j = 0; j < b.txs.length && out.length < n; j++) out.push(b.txs[j]);
    }
    return out;
  }

  /** 区块详情（详情页用）。numberOrHash 可以是十进制数、0x 块号、块哈希或 'latest'。 */
  function block(numberOrHash) {
    var id = numberOrHash, method, params;
    if (isHash(id)) { method = 'eth_getBlockByHash'; params = [id, true]; }
    else if (id === 'latest' || id === 'pending' || id === 'earliest') { method = 'eth_getBlockByNumber'; params = [id, true]; }
    else { method = 'eth_getBlockByNumber'; params = [typeof id === 'string' && /^0x/i.test(id) ? id : hex(Number(id)), true]; }
    return call(method, params).then(function (b) {
      if (!b) { var e = new Error('没有这个区块'); e.code = 'not_found'; throw e; }
      var row = blockRow(b);
      return fillReceipts([row]).then(function () { return row; });
    });
  }

  /** 交易详情（详情页用）。请求数 2：交易 + 收据一批，再补一次块头拿时间戳。 */
  function tx(hash) {
    return send([
      { method: 'eth_getTransactionByHash', params: [hash] },
      { method: 'eth_getTransactionReceipt', params: [hash] }
    ]).then(function (rs) {
      var t = okRow(rs[0]) ? rs[0].result : null;
      if (!t) { var e = new Error('没有这笔交易'); e.code = 'not_found'; throw e; }
      var r = okRow(rs[1]) ? rs[1].result : null;
      var bn = hnum(t.blockNumber);
      if (bn === null) return txRow(t, null, r, null, null);   // 还在交易池里：没有块，也没有时间
      return call('eth_getBlockByNumber', [hex(bn), false]).then(function (b) {
        return txRow(t, b ? hnum(b.timestamp) : null, r, null, b ? hbig(b.baseFeePerGas) : null);
      }, function () { return txRow(t, null, r, null, null); });
    });
  }

  function gasPrice() { return call('eth_gasPrice').then(function (h) { return hbig(h); }); }
  function peers() { return call('net_peerCount').then(function (h) { return hnum(h); }, function () { return null; }); }
  /** txpool_status 在 Besu 上默认是关的：读不到就当不知道，安静返回 null。 */
  function txpool() {
    return call('txpool_status').then(function (j) {
      return j ? { pending: hnum(j.pending), queued: hnum(j.queued) } : null;
    }, function () { return null; });
  }

  /* ══════════════════════════════════════════════════════
     6. 落进 state.layer（每段自带 status），并发事件
     ══════════════════════════════════════════════════════ */

  function setStatus(name, st) {
    var L = BAC.state.layer;
    L.sections[name] = st;
    if (name === 'head') L.status = st;
    if (name === 'blocks') BAC.state.blocks.status = st;
    if (name === 'txs') BAC.state.txs.status = st;
  }

  function okSection(sec) {
    sec.ready = true; sec.error = null; sec.errorDetail = null; sec.failures = 0;
    sec.stale = false; sec.updatedAt = Date.now();
  }
  function failSec(sec, err) {
    sec.failures++;
    sec.error = TEXT.ERR;
    sec.errorDetail = BAC.errInfo(err).message;
    sec.stale = !!sec.ready;       // 之前读到过 → 现在显示的是旧数，必须标出来
    sec.updatedAt = Date.now();
  }

  /** 索引器正在正常供数吗？它有历史、有搜索、有聚合，能用就优先用它。 */
  function indexerServing() {
    var I = BAC.state.indexer;
    return !!(BAC.HAS_INDEXER && I.ready && !I.degraded && !I.error);
  }

  function writeMeta(L, meta) {
    if (meta.chainId !== null && meta.chainId !== undefined) L.chainId = meta.chainId;
    if (meta.gasPrice !== undefined) L.gasPrice = meta.gasPrice;
    if (meta.peers !== undefined) L.peers = meta.peers;
    if (meta.txpool !== undefined) L.txpool = meta.txpool;
  }

  function writeBlocks(blocks) {
    var L = BAC.state.layer, B = BAC.state.blocks, T = BAC.state.txs;
    var top = blocks.length ? blocks[0] : null;
    if (!top) throw new Error('层内 RPC 没有返回任何区块');

    // 实测出块间隔：最后两块的时间差；窗口够长时再给一个窗口平均值（比单次抖动稳）
    var interval = null, avg = null;
    if (blocks.length >= 2 && blocks[0].ts !== null && blocks[1].ts !== null) {
      interval = blocks[0].ts - blocks[1].ts;
      var last = blocks[blocks.length - 1];
      if (last.ts !== null && blocks.length > 2) {
        avg = Math.round(((blocks[0].ts - last.ts) / (blocks.length - 1)) * 1000) / 1000;
      }
    }

    L.source = 'rpc';
    L.endpoint = current;
    L.head = top.number;
    L.headTs = top.ts;
    L.headHash = top.hash;
    L.miner = top.miner;
    L.gasLimit = top.gasLimit;
    L.baseFee = top.baseFee;
    L.blockIntervalSec = interval;
    L.blockTimeSec = avg !== null ? avg : interval;
    L.blockLagSec = top.ts === null ? null : Math.max(0, Math.floor(Date.now() / 1000) - top.ts);
    if (top.ts !== null) BAC.time.setChainTime(top.ts);
    okSection(L); setStatus('head', 'ok');

    B.items = blocks; B.source = 'rpc';
    okSection(B); setStatus('blocks', 'ok');

    T.items = collectTxs(blocks, Math.min(MAX_TXS, CFG.blocksLimit)); T.source = 'rpc';
    okSection(T); setStatus('txs', 'ok');

    BAC.LAYER_LIVE = true;
    BAC.state.layerLive = true;
    BAC.clearWarning('layer_rpc_down');
  }

  function markFail(err, sections) {
    var L = BAC.state.layer;
    BAC.LAYER_LIVE = false;
    BAC.state.layerLive = false;
    failSec(L, err); setStatus('head', 'error');
    if (sections !== 'head') {
      failSec(BAC.state.blocks, err); setStatus('blocks', 'error');
      failSec(BAC.state.txs, err); setStatus('txs', 'error');
    }
    if (L.source === 'rpc') L.source = null;
    BAC.pushWarning('layer_rpc_down');
  }

  function emitAll() {
    BAC.emit('layer', BAC.state.layer);
    BAC.emit('blocks', BAC.state.blocks.items);
    BAC.emit('state', BAC.state);
  }

  /** 完整一轮：元信息 1 个请求 + 区块 1 个 + 收据最多 1 个 = 最多 3 个。 */
  function pullFull() {
    return send([
      { method: 'eth_chainId' },
      { method: 'eth_blockNumber' },
      { method: 'eth_gasPrice' },
      { method: 'net_peerCount' },
      { method: 'txpool_status' }
    ]).then(function (rs) {
      var h = okRow(rs[1]) ? hnum(rs[1].result) : null;
      if (h === null) throw new Error('层内 RPC 没有返回块高');
      var meta = {
        chainId: okRow(rs[0]) ? hnum(rs[0].result) : null,
        gasPrice: okRow(rs[2]) ? hbig(rs[2].result) : null,
        peers: okRow(rs[3]) ? hnum(rs[3].result) : null,
        txpool: (okRow(rs[4]) && rs[4].result)
          ? { pending: hnum(rs[4].result.pending), queued: hnum(rs[4].result.queued) } : null
      };
      var n = Math.max(2, Math.min(MAX_BLOCKS, CFG.blocksLimit));
      return latestBlocks(n, { head: h }).then(function (blocks) {
        writeMeta(BAC.state.layer, meta);
        writeBlocks(blocks);
        return blocks;
      });
    });
  }

  /** 索引器在供数时只做轻量探活：2 个请求，只更新「链还活着吗 / 用的是哪个端点」，
      不去覆盖索引器写好的块与交易。 */
  function pullProbe() {
    return head().then(function (info) {
      var L = BAC.state.layer;
      L.endpoint = info.endpoint;
      L.rpcHead = info.number;
      L.rpcHeadTs = info.timestamp;
      L.rpcAt = info.at;
      if (info.blockIntervalSec !== null) L.blockIntervalSec = info.blockIntervalSec;
      if (L.chainId === null || L.chainId === undefined) L.chainId = info.chainId;
      if (L.gasPrice === null || L.gasPrice === undefined) L.gasPrice = info.gasPrice;
      BAC.LAYER_LIVE = true;
      BAC.state.layerLive = true;
      BAC.clearWarning('layer_rpc_down');
      return info;
    });
  }

  /* ══════════════════════════════════════════════════════
     7. 轮询（链 3 秒一块，不许比它更快；后台标签页退到慢档）
     ══════════════════════════════════════════════════════ */

  var timer = null, started = false, inFlight = null;

  function period() {
    var L = BAC.state.layer;
    if (!EPS.length) return null;
    if (BAC.state.hidden) return CFG.layerHiddenPollMs;          // 后台标签页：慢档
    if (L.failures > 0) return Math.min(120000, BAC.backoffMs(L.failures, 5000));
    if (indexerServing()) return CFG.layerIdlePollMs;            // 索引器在供数：只慢速探活
    return CFG.layerPollMs;
  }

  function schedule() {
    if (timer) { root.clearTimeout(timer); timer = null; }
    var ms = period();
    BAC.layer.nextDelayMs = ms;
    if (ms === null) return;
    timer = root.setTimeout(function () { run(); }, ms);
  }

  function run(opts) {
    opts = opts || {};
    if (inFlight) return inFlight;
    if (!EPS.length) {
      // 连兜底 RPC 都没配：这不是「读取失败」，是根本没配（发射前的默认形态）
      setStatus('head', 'prelaunch'); setStatus('blocks', 'prelaunch'); setStatus('txs', 'prelaunch');
      return Promise.resolve();
    }
    var probeOnly = indexerServing();
    var job = probeOnly ? pullProbe() : pullFull();
    inFlight = job.then(function () {
      inFlight = null;
      emitAll();
      if (!opts.once) schedule();
    }, function (e) {
      markFail(e, probeOnly ? 'head' : 'all');
      inFlight = null;
      emitAll();
      if (!opts.once) schedule();
    });
    return inFlight;
  }

  BAC.on('hidden', function (hidden) {
    if (hidden) { schedule(); return; }                          // 切后台：不停，退到慢档
    var age = Date.now() - (BAC.state.layer.updatedAt || 0);
    if (age > CFG.layerPollMs) run(); else schedule();
  });

  BAC.layer = {
    // 常量（测试与文档会直接引用）
    MAX_BATCH: MAX_BATCH, MAX_BLOCKS: MAX_BLOCKS, MAX_TXS: MAX_TXS,
    RECEIPT_BLOCKS: RECEIPT_BLOCKS, MAX_HOPS: MAX_HOPS,
    REQ_FULL: REQ_FULL, REQ_HEAD: REQ_HEAD,
    endpoints: EPS.slice(),
    /** 现在在用哪个端点（给绑定层显示「数据来自哪里」）。 */
    endpoint: function () { return current; },
    isPrimary: function () { return !!current && current === EPS[0]; },
    health_: epHealth,
    stats: stats,
    // 裸接口
    send: send, call: call,
    // 读接口
    head: head, latestBlocks: latestBlocks, latestTxs: latestTxs,
    block: block, tx: tx, gasPrice: gasPrice, peers: peers, txpool: txpool,
    shape: { blockRow: blockRow, txRow: txRow },
    pull: { full: pullFull, probe: pullProbe },
    period: period,
    nextDelayMs: null,
    run: run,
    start: function () { if (started) return; started = true; run(); },
    stop: function () { if (timer) { root.clearTimeout(timer); timer = null; } started = false; },
    indexerServing: indexerServing
  };
})(typeof window !== 'undefined' ? window : globalThis);
