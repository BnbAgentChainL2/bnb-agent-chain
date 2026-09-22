/* 网站数据层的离线单测：node artifacts/data-check/unit.mjs [--only=shape|fmt|rpc|multicall|bsc|api|degraded]
   规矩：
   - 不连服务器、不连主网、不需要任何私钥；ethers 与 fetch 全部是假的；
   - 把 web/site.config.js + web/js/data/*.js 放进 node:vm 的假 window 里跑；
   - 任何对 document / localStorage / navigator 的访问都直接判失败（数据层不许有 DOM 代码）。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', 'web');

const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
const verbose = process.argv.includes('--verbose');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; if (verbose) console.log('  ok   ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' → ' + detail : '')); }
}
function eq(name, got, want) {
  const g = typeof got === 'bigint' ? got.toString() + 'n' : JSON.stringify(got);
  const w = typeof want === 'bigint' ? want.toString() + 'n' : JSON.stringify(want);
  ok(name, got === want, g + ' !== ' + w);
}
async function group(name, fn) {
  if (only && only !== name) return;
  console.log('\n[' + name + ']');
  try { await fn(); } catch (e) { fail++; failures.push(name + ' 抛异常: ' + e.message); console.log('  FAIL ' + name + ' 抛异常 → ' + e.stack); }
}

/* ══════════════════════════════════════════════════════
   假 ethers：编码就是把 {fn,args} 塞进十六进制 JSON，解码原样取回。
   够用来验分块、逐条失败、探针退路和轮换，不需要真的 ABI 编解码器。
   ══════════════════════════════════════════════════════ */

function enc(v) {
  return '0x' + Buffer.from(JSON.stringify(v, (k, x) => typeof x === 'bigint' ? { __b: x.toString() } : x)).toString('hex');
}
function dec(h) {
  return JSON.parse(Buffer.from(String(h).slice(2), 'hex').toString(), (k, x) => (x && x.__b !== undefined) ? BigInt(x.__b) : x);
}

class FakeInterface {
  constructor(frags) { this.frags = frags; }
  encodeFunctionData(fn, args = []) {
    if (!this.frags.some(f => f.includes(' ' + fn + '('))) throw new Error('unknown fn ' + fn);
    return enc({ fn, args });
  }
  decodeFunctionResult(fn, data) { return dec(data); }
}

/** 一条链的假后端：记录每次调用，按 fixtures 给结果。 */
function makeChain(fixtures, opts = {}) {
  const log = { calls: [], aggregate: [], getCode: 0, getBlock: 0, getBlockNumber: 0, byUrl: {} };
  const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
  function resultFor(fn, args) {
    const f = fixtures[fn];
    if (f === undefined) return undefined;
    return typeof f === 'function' ? f(args) : f;
  }
  function handleCall(tx, url) {
    const { fn, args } = dec(tx.data);
    if (tx.to === MC && fn === 'aggregate3') {
      const payload = args[0];
      log.aggregate.push(payload.length);
      const rows = payload.map(([target, allow, data]) => {
        const inner = dec(data);
        log.calls.push(inner.fn);
        const r = resultFor(inner.fn, inner.args);
        if (r === undefined || (opts.failFns || []).includes(inner.fn)) return [false, '0x'];
        return [true, enc(r)];
      });
      return enc([rows]);
    }
    log.calls.push(fn);
    const r = resultFor(fn, args);
    if (r === undefined) throw Object.assign(new Error('execution reverted: no fixture'), { code: 'CALL_EXCEPTION', data: '0x' });
    return enc(r);
  }
  return { log, handleCall, MC };
}

function makeEthers(chain, behaviour = {}) {
  const created = [];
  class FetchRequest {
    constructor(url) { this.url = url; this.timeout = null; this.retryFunc = null; }
  }
  class Network {
    constructor(name, chainId) { this.name = name; this.chainId = chainId; }
  }
  class JsonRpcProvider {
    constructor(req, net, opts) {
      this.url = req.url; this.req = req; this.net = net; this.opts = opts;
      created.push(this);
    }
    _guard() {
      const b = behaviour[this.url];
      if (typeof b === 'function') { const e = b(); if (e) throw e; }
    }
    async getCode() { this._guard(); chain.log.getCode++; return behaviour.noMulticall ? '0x' : '0x60806040'; }
    async getBlockNumber() { this._guard(); chain.log.getBlockNumber++; return behaviour.headNumber || 123456789; }
    async getBlock() {
      this._guard(); chain.log.getBlock++;
      return { number: behaviour.headNumber || 123456789, timestamp: behaviour.headTs || 1790000000 };
    }
    async call(tx) {
      this._guard();
      chain.log.byUrl[this.url] = (chain.log.byUrl[this.url] || 0) + 1;
      return chain.handleCall(tx, this.url);
    }
  }
  return { FetchRequest, Network, JsonRpcProvider, Interface: FakeInterface, _created: created };
}

/* ══════════════════════════════════════════════════════
   假环境
   ══════════════════════════════════════════════════════ */

const FILES = ['site.config.js', 'js/data/bac-core.js', 'js/data/bac-chain.js', 'js/data/bac-api.js', 'js/data/bac-view.js'];
const SRC = Object.fromEntries(FILES.map(f => [f, readFileSync(join(WEB, f.split('/').join('/')), 'utf8')]));

function domTrap(name, hits) {
  return new Proxy({}, {
    get(t, k) { if (k !== Symbol.toPrimitive && k !== 'then') hits.push(name + '.' + String(k)); return undefined; },
    set(t, k) { hits.push(name + '.' + String(k) + '='); return true; }
  });
}

function makeEnv({ config = {}, ethers, fetchImpl, autoStart = false } = {}) {
  const domHits = [];
  const timers = [];
  const sandbox = {
    console: { log() {}, error(...a) { if (verbose) console.error('   [page]', ...a); }, warn() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Promise, BigInt, JSON, Math, Date, Number, String, Object, Array, Error, RegExp, isFinite, encodeURIComponent,
    document: domTrap('document', domHits),
    localStorage: domTrap('localStorage', domHits),
    navigator: domTrap('navigator', domHits),
    ethers,
    fetch: fetchImpl,
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
    BAC_CONFIG: Object.assign({ autoStart }, config)
  };
  vm.createContext(sandbox);
  vm.runInContext('var window = globalThis; var globalThisRef = globalThis;', sandbox);
  for (const f of FILES) vm.runInContext(SRC[f], sandbox, { filename: f });
  return { sandbox, BAC: sandbox.BAC, domHits, timers, flush: () => { const t = timers.splice(0); t.forEach(x => x.fn()); } };
}

/* ══════════════════════════════════════════════════════
   固定测试数据
   ══════════════════════════════════════════════════════ */

const ADDR = {
  vault: '0x1111111111111111111111111111111111111111',
  token: '0x2222222222222222222222222222222222222222',
  bridge: '0x3333333333333333333333333333333333333333',
  nodeFund: '0x4444444444444444444444444444444444444444',
  registry: '0x5555555555555555555555555555555555555555',
  anchor: '0x6666666666666666666666666666666666666666',
  staking: '0x7777777777777777777777777777777777777777',
  factory: '0x8888888888888888888888888888888888888888'
};
const PROC = '0x9999999999999999999999999999999999999999';
const OWNER = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const ZERO = '0x0000000000000000000000000000000000000000';

const E18 = 1000000000000000000n;

const FIXTURES = {
  // vault
  taxToken: [ADDR.token], bridge: [ADDR.bridge], nodeFund: [ADDR.nodeFund], owner: [OWNER],
  BRIDGE_BPS: [5000], description: ['BAC 金库'],
  accountedQuote: [0n], unsplitRevenue: [500000000000000000n],
  lifetimeToBridge: [12n * E18], lifetimeToNodeFund: [12n * E18], totalRecognized: [24n * E18],
  stuckAmounts: [[0n, 0n]], solvency: [[500000000000000000n, 0n, 0n]],
  // token
  name: ['BNB Agent Chain'], symbol: ['BAC'], decimals: [18], totalSupply: [10n ** 27n],
  taxRate: [1000], buyTaxRate: [1000], sellTaxRate: [1000], taxProcessor: [PROC],
  // tax processor
  marketAddress: [ADDR.vault],
  feeConfigV2: [[100, 0, 0, 0, 300, false, 0, ZERO]],
  // bridge
  totalLocked: [5000000n * E18], totalCreditsIssued: [5000000n * E18], totalCreditsExited: [120000n * E18],
  totalBurned: [0n], creditsOutstanding: [4880000n * E18], poolBalance: [9n * E18],
  owedTotal: [4n * E18], reservedTotal: [1n * E18], releasedInWindow: [2n * E18],
  currentRate: [1800000000000n], lastEpochRelease: [[1n * E18, 1789999000, 350]],
  isPaused: [[false, 0, 0]], isHalted: [false], lastSettledEpoch: [20716], skippedEpochs: [0],
  haltCause: [0], pendingCause: [0], escapeArmedAt: [0], escapeState: [[0n, 0n, 0n]],
  // node fund
  balance: [400000000000000000n], lifetimeReceived: [12n * E18], lifetimeWithdrawn: [11n * E18 + 600000000000000000n],
  // registry
  totalAgents: [42n], currentEpoch: [20718],
  // staking
  totalStaked: [5000000n * E18], nodeCount: [2n], rewardBalance: [300000000000000000n],
  lifetimeFunded: [800000000000000000n], lifetimePaid: [500000000000000000n], lastRemitEpoch: [20716],
  epochReward: [[1n * E18, 5000000n * E18, 200000000n, true]],
  // anchor
  lastPostedEpoch: [20717], lastFinalEpoch: [20716], lastFinalAt: [1789990000],
  cumulativeCredited: [5000000n * E18], cumulativeExit: [120000n * E18],
  cumulativeGasFees: [100n * E18], cumulativeRemitted: [90n * E18],
  haltReason: [0], vetoCountInWindow: [0], disputeCountInWindow: [0], releaseBpsFor: [350],
  getAnchor: [[
    '0x' + 'ab'.repeat(32),   // exitRoot
    '0x' + 'cd'.repeat(32),   // proposerIncomeRoot
    '0x' + 'ef'.repeat(32),   // l2BlockHash
    1234501,                  // l2Block
    1789995000,               // postedAt
    0,                        // finalizedAt
    500000n * E18,            // creditedInEpoch
    120000n * E18,            // exitCreditsInEpoch
    3125000000000000n,        // feeBurnedInEpoch
    54n * E18,                // gasFeesInEpoch
    50n * E18,                // remittedInEpoch
    380000n * E18,            // circulating
    7,                        // exitCount
    1,                        // proposerCount
    2,                        // agreeingCount
    1                         // state = POSTED
  ]]
};

const LIVE_CONFIG = {
  addresses: ADDR,
  indexerBase: 'https://indexer.test',
  layerRpc: 'https://layer.test/rpc',
  rpcs: ['https://rpc-a.test', 'https://rpc-b.test'],
  logRpcs: ['https://rpc-a.test'],
  pollMs: 999999, prelaunchPollMs: 999999, apiPollMs: 999999
};

/* 假索引器响应 */
const API_BODY = {
  '/api/health': {
    schema: 'bac/health/1', ok: true, now: 1790000000,
    layer: { chainId: 56777, head: 1234567, headTs: 1789999998, blockLagSec: 2, gasLimit: 20000000, baseFee: '0', peers: 3, enode: 'enode://x@1.2.3.4:30303', genesisHash: '0x' + '11'.repeat(32) },
    relayer: { lastPostedEpoch: 20717, currentEpoch: 20718, epochLag: 1 },
    reconcile: {
      bscTotalIssued: '5000000000000000000000000', bscTotalExited: '120000000000000000000000',
      layerCirculating: '4879996875000000000000000', feeSinkBalance: '3125000000000000', signerBalance: '0',
      formula: 'diff = (bscTotalIssued - bscTotalExited) - (layerCirculating + feeSinkBalance + signerBalance)',
      diff: '0', ok: true,
      howToCheck: ['cast call <BacBridge> "totalCreditsIssued()(uint256)"']
    },
    anchorCommitWindowEndsAt: 1790007200, warnings: []
  },
  '/api/summary': {
    schema: 'bac/summary/1',
    layer: { head: 1234567, blockTimeSec: 3.0, txTotal: 48213, contractsTotal: 37, circulating: '4880000000000000000000000', burnedTotal: '912500000000000000' },
    agents: { total: 42, challenged: 2, active: 35, dormant: 4, banned: 1, retired: 0 },
    treasury: { taxFeeRateBps: 300 },
    updatedAt: 1790000000
  },
  '/api/feed': {
    schema: 'bac/feed/1',
    items: [
      { id: 91422, chain: 'layer', kind: 'DEPLOY', ts: 1789999950, block: 1234560, agentId: 17, textZh: 'agent #17 部署了一个新合约', tx: '0x' + 'aa'.repeat(32), anchored: false, epoch: 20718 },
      { id: 91421, chain: 'bsc', kind: 'Locked', ts: 1789999900, block: 123456780, agentId: 17, textZh: 'agent #17 锁了 25 万 BAC', tx: '0x' + 'bb'.repeat(32), anchored: true, epoch: 20716 }
    ],
    head: 91422, anchoredThrough: 20716, updatedAt: 1790000000
  },
  '/api/blocks': {
    schema: 'bac/blocks/1',
    items: [
      { number: 1234567, hash: '0x' + '01'.repeat(32), ts: 1789999998, txCount: 2, gasUsed: 42000, gasLimit: 20000000, baseFee: '0', epoch: 20718 },
      { number: 1234566, hash: '0x' + '02'.repeat(32), ts: 1789999995, txCount: 0, gasUsed: 0, gasLimit: 20000000, baseFee: '0', epoch: 20718 }
    ]
  },
  '/api/block/1234567': {
    schema: 'bac/blocks/1', number: 1234567,
    txs: [{ hash: '0x' + 'cc'.repeat(32), block: 1234567, idx: 0, from: OWNER, to: null, value: '0', gasUsed: 21000, effGasPrice: '1000000000', feeBurned: '0', created: ADDR.factory, status: 1, agentId: 17, ts: 1789999998 }]
  },
  '/api/agents': {
    schema: 'bac/agents/1', total: 42, page: 1, pageSize: 50,
    items: [{ agentId: 17, controller: OWNER, wallet: OWNER, status: 2, statusName: 'ACTIVE', registeredAt: 1789900000, activatedAt: 1789900044, solved: 3, lastHeartbeatEpoch: 20718, missed: 0, credited: '250000000000000000000000', exited: '0', layerBalance: '249978000000000000000000', deploys: 3, announces: 11, lastLayerBlock: 1234560, agentURI: 'https://x/agent.json', endpointHash: '0x' + '03'.repeat(32), modelFingerprint: '0x' + '04'.repeat(32) }]
  },
  '/api/validators': {
    schema: 'bac/validators/1', totalStaked: '5000000000000000000000000', rewardBalance: '300000000000000000',
    items: [
      { nodeId: 'my-node-01', validator: OWNER, payout: OWNER, enodeURI: 'enode://y@1.2.3.4:30303', active: true, strikes: 0, staked: '2000000000000000000000000', lastEpoch: 20717, agreedEpochs: 30, disputedEpochs: 0, lifetimeClaimed: '100000000000000000', cumOwed: '54000000000000000000', cumRemitted: '50000000000000000000', proposerRights: true, qualifyStreak: 30 },
      { nodeId: 'my-node-02', validator: ZERO, payout: ZERO, enodeURI: '', active: false, strikes: 1, staked: '2000000000000000000000000', lastEpoch: 20716, agreedEpochs: 12, disputedEpochs: 1, lifetimeClaimed: '0' }
    ]
  },
  '/api/epochs': {
    schema: 'bac/epochs/1',
    items: [{ epoch: 20717, state: 'POSTED', exitRoot: '0x' + 'ab'.repeat(32), l2Block: 1234501, l2BlockHash: '0x' + 'ef'.repeat(32), credited: '500000000000000000000000', exitCredits: '120000000000000000000000', feeBurned: '3125000000000000', circulating: '380000000000000000000000', exitCount: 7, postedAt: 1789995000, agreeingCount: 2, agreeingWt: '5000000000000000000000000', disputingWt: '0', releaseBps: 350, pot: '1000000000000000000', rate: '0', gasFees: '54000000000000000000', remitted: '50000000000000000000', proposerCount: 1 }]
  },
  '/api/rate': { schema: 'bac/rate/1', weiPerCredit: '1800000000000', poolBalance: '9000000000000000000', owedTotal: '4000000000000000000', creditsOutstanding: '4880000000000000000000000', lastPot: '1000000000000000000', note: '估算 · 不承诺任何金额' }
};

function makeFetch({ fail = false, only404 = [], layerRpcOk = true, log = [] } = {}) {
  return async function (url, opts = {}) {
    log.push(url);
    if (String(url).endsWith('/rpc')) {
      if (!layerRpcOk) throw new Error('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x12d687' }) };
    }
    if (fail) throw new Error('Failed to fetch');
    const path = String(url).replace('https://indexer.test', '').split('?')[0];
    if (only404.includes(path)) {
      return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: '没有这个东西' } }) };
    }
    const body = API_BODY[path];
    if (!body) return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: '没有这个端点' } }) };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
}

/* ══════════════════════════════════════════════════════
   测试
   ══════════════════════════════════════════════════════ */

await group('shape', async () => {
  const chain = makeChain(FIXTURES);
  const env = makeEnv({ ethers: makeEthers(chain), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  const B = env.BAC;

  ok('window.BAC 存在', !!B);
  ok('加载时没有碰 DOM', env.domHits.length === 0, env.domHits.join(','));

  for (const k of ['CFG', 'C', 'LAYER', 'TEXT', 'ZERO', 'LIVE', 'HAS_INDEXER', 'state', 'fmt', 'links', 'time',
    'isAddr', 'big', 'errInfo', 'isRevert', 'backoffMs', 'healthTable', 'ethersReady', 'epochOf', 'currentEpoch',
    'epochLeft', 'on', 'off', 'emit', 'setHidden', 'pushWarning', 'clearWarning', 'chain', 'api', 'view',
    'start', 'stop', 'refresh', 'statusName', 'statusZh', 'epochStateZh']) {
    ok('BAC.' + k, B[k] !== undefined);
  }
  for (const k of ['units', 'token', 'bnb', 'compact', 'pct', 'share', 'int', 'addr', 'hash', 'duration', 'hms', 'beijing', 'ago', 'big', 'num'])
    ok('BAC.fmt.' + k, typeof B.fmt[k] === 'function');
  for (const k of ['tx', 'address', 'block', 'token', 'layerTx', 'layerBlock', 'agent', 'epoch', 'flap', 'api'])
    ok('BAC.links.' + k, typeof B.links[k] === 'function');
  for (const k of ['ABI', 'call', 'multi', 'chunk', 'withRead', 'loadParams', 'readLive', 'readEpoch', 'refresh', 'start', 'stop', 'setFallbackProvider'])
    ok('BAC.chain.' + k, B.chain[k] !== undefined);
  for (const k of ['health', 'summary', 'feed', 'agents', 'agent', 'blocks', 'block', 'tx', 'contracts', 'epochs',
    'epoch', 'leaves', 'proof', 'rate', 'validators', 'treasury', 'pull', 'shape', 'run', 'start', 'stop', 'degradedNote', 'layerRpcFallback'])
    ok('BAC.api.' + k, B.api[k] !== undefined);
  for (const k of ['chainStats', 'feed', 'blocks', 'txs', 'agents', 'treasury', 'bridge', 'validators', 'epoch', 'overview'])
    ok('BAC.view.' + k, typeof B.view[k] === 'function');
  for (const k of ['live', 'prelaunch', 'ready', 'loading', 'hidden', 'error', 'warnings', 'bsc', 'indexer', 'layer',
    'feed', 'blocks', 'txs', 'agentList', 'validators', 'epochs', 'rate'])
    ok('BAC.state.' + k, B.state[k] !== undefined);

  eq('必须逐字的发射前文案', B.TEXT.PRE, '发射后公布');
  eq('必须逐字的读取失败文案', B.TEXT.ERR, '读取失败 · 重试中');
  eq('未锚定文案', B.TEXT.NOT_ANCHORED, '未锚定 · 仅来自官方节点');
  eq('层内 FeeSplitter 地址', B.LAYER.FEE_SPLITTER, '0x0000000000000000000000000000000000000104');
  eq('层内 L2Bridge 地址', B.LAYER.L2_BRIDGE, '0x0000000000000000000000000000000000000101');
  eq('Multicall3 地址', B.C.MULTICALL3, '0xcA11bde05977b3631167028862bE2a173976CA11');
  eq('层 chainId', B.C.LAYER_CHAIN_ID, 56777);
  eq('分账常量 · 官方出块给验证者池', B.C.OFFICIAL_BLOCK_VALIDATOR_BPS, 1000);
  eq('分账常量 · 验证者出块自留', B.C.VALIDATOR_BLOCK_VALIDATOR_BPS, 5000);
  eq('金库分账 50/50', B.C.BRIDGE_BPS, 5000);

  // 配置形状
  eq('chainId', B.CFG.chainId, 56);
  ok('rpcs 是数组', Array.isArray(B.CFG.rpcs) && B.CFG.rpcs.length > 0);
  ok('layerRpc', typeof B.CFG.layerRpc === 'string');
  ok('indexerBase', typeof B.CFG.indexerBase === 'string');
  for (const k of ['factory', 'vault', 'token', 'bridge', 'nodeFund', 'registry', 'anchor', 'staking'])
    ok('addresses.' + k, B.CFG.addresses[k] !== undefined);
  eq('BAC.LIVE = isAddr(vault)', B.LIVE, true);

  // ethers 的三条硬规定
  await B.chain.refresh({ reason: 'test' });
  const p = env.sandbox.ethers._created[0];
  eq('FetchRequest.timeout', p.req.timeout, 15000);
  eq('retryFunc 立即返回 false', await p.req.retryFunc(), false);
  eq('batchMaxCount', p.opts.batchMaxCount, 1);
  eq('cacheTimeout', p.opts.cacheTimeout, -1);
  ok('staticNetwork 已设置', !!p.opts.staticNetwork);
});

await group('fmt', async () => {
  const env = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch() });
  const f = env.BAC.fmt;
  eq('units 整数分组', f.units(1234500000000000000000n), '1,234.5');
  eq('units 向下取整', f.units(1999999999999999999n, 18, 2), '1.99');
  eq('units 尘埃', f.units(1n), '<0.0001');
  eq('units null', f.units(null), '—');
  eq('token ≥1000 → 0 位', f.token(1234500000000000000000n), '1,234');
  eq('token <1 → 4 位', f.token(500000000000000n), '0.0005');
  eq('bnb 4 位', f.bnb(1500000000000000000n), '1.5');
  eq('compact 万', f.compact(125000n * 10n ** 18n), '12.5 万');
  eq('compact 亿', f.compact(320000000n * 10n ** 18n), '3.2 亿');
  eq('pct(1000)', f.pct(1000), '10%');
  eq('share 精确', f.share(1n, 2n), '50%');
  eq('int', f.int(48213), '48,213');
  eq('addr', f.addr('0x1234567890abcdef1234567890abcdef12345678'), '0x1234…5678');
  eq('duration 天', f.duration(3 * 86400 + 4 * 3600), '3 天 4 小时');
  eq('duration 分', f.duration(125), '2 分 5 秒');
  eq('hms', f.hms(3661), '01:01:01');
  eq('beijing 是 UTC+8', f.beijing(0, { year: true }), '1970年1月1日 08:00');
  eq('ago', f.ago(120), '2 分钟前');
  eq('big 十进制字符串', f.big('1000000000000000000'), 1000000000000000000n);
  eq('big 0x 字符串', f.big('0xff'), 255n);
  eq('big 非法 → null', f.big('abc'), null);
  eq('big 浮点 → null', f.big(1.5), null);
  eq('epochOf', env.BAC.epochOf(1790000000), 20717);
});

await group('rpc', async () => {
  const B0 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch() }).BAC;
  eq('退避 1 次', B0.backoffMs(1, 15000), 15000);
  eq('退避 2 次', B0.backoffMs(2, 15000), 30000);
  eq('退避 3 次', B0.backoffMs(3, 15000), 60000);
  eq('退避 4 次', B0.backoffMs(4, 15000), 120000);
  eq('退避封顶 120 秒', B0.backoffMs(9, 15000), 120000);
  eq('索引器基数 5 秒', B0.backoffMs(1, 5000), 5000);

  const h = B0.healthTable(15000);
  eq('初始是健康的', h.healthy('a', 1000), true);
  h.bad('a', new Error('x'), 1000);
  eq('失败后进入退避', h.healthy('a', 1000 + 14999), false);
  eq('退避到期后恢复可用', h.healthy('a', 1000 + 15001), true);
  h.bad('a', new Error('x'), 1000);
  eq('第二次失败翻倍', h.get('a').until - 1000, 30000);
  h.ok('a');
  eq('成功后计数归零', h.get('a').fails, 0);

  // revert 不换 RPC，超时换
  const chain = makeChain(FIXTURES);
  let aCalls = 0;
  const behaviour = {
    'https://rpc-a.test': () => { aCalls++; return Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }); }
  };
  const env = makeEnv({ ethers: makeEthers(chain, behaviour), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  const got = await env.BAC.chain.withRead(p => p.getBlockNumber());
  eq('超时会换到第二个 RPC', got, 123456789);
  ok('第一个 RPC 被标记为不健康', !env.BAC.chain.rpcHealth.healthy('https://rpc-a.test'));

  const chain2 = makeChain(FIXTURES);
  const env2 = makeEnv({ ethers: makeEthers(chain2), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  let tries = 0;
  let threw = null;
  try {
    await env2.BAC.chain.withRead(() => {
      tries++;
      throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x08c379a0' });
    });
  } catch (e) { threw = e; }
  ok('revert 会抛出', !!threw);
  eq('revert 不轮换 RPC（只试一次）', tries, 1);
  eq('isRevert 认得 CALL_EXCEPTION', env2.BAC.isRevert(threw), true);
  eq('isRevert 不把限速当 revert', env2.BAC.isRevert(new Error('rate limit exceeded')), false);
  eq('errInfo 限速', env2.BAC.errInfo(new Error('-32005 limit exceeded')).code, 'ratelimited');
  eq('errInfo 取中文那半', env2.BAC.errInfo({ code: 'CALL_EXCEPTION', data: '0x', reason: 'Only relayer / 仅限中继' }).message, '仅限中继');
});

await group('multicall', async () => {
  // 分块 80
  const chain = makeChain(FIXTURES);
  const env = makeEnv({ ethers: makeEthers(chain), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  const calls = [];
  for (let i = 0; i < 200; i++) calls.push(env.BAC.chain.call(ADDR.bridge, 'bridge', 'k' + i, 'poolBalance'));
  const out = await env.BAC.chain.multi(calls);
  eq('分了 3 块', chain.log.aggregate.length, 3);
  eq('第一块 80 条', chain.log.aggregate[0], 80);
  eq('第二块 80 条', chain.log.aggregate[1], 80);
  eq('最后一块 40 条', chain.log.aggregate[2], 40);
  eq('MC_CHUNK 就是 80', env.BAC.chain.MC_CHUNK, 80);
  eq('全部解出来了', Object.keys(out).length, 200);
  eq('值是 BigInt', out.k0, 9n * E18);

  // 逐条失败：success === false 的那条是 undefined，别的照常
  const chain2 = makeChain(FIXTURES, { failFns: ['owedTotal'] });
  const env2 = makeEnv({ ethers: makeEthers(chain2), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  const out2 = await env2.BAC.chain.multi([
    env2.BAC.chain.call(ADDR.bridge, 'bridge', 'pool', 'poolBalance'),
    env2.BAC.chain.call(ADDR.bridge, 'bridge', 'owed', 'owedTotal'),
    env2.BAC.chain.call(ADDR.bridge, 'bridge', 'res', 'reservedTotal')
  ]);
  eq('失败那条是 undefined', out2.owed, undefined);
  eq('同批其它条正常', out2.pool, 9n * E18);
  eq('同批第三条正常', out2.res, 1n * E18);

  // getCode 探针失败 → 退回逐条 eth_call
  const chain3 = makeChain(FIXTURES);
  const env3 = makeEnv({ ethers: makeEthers(chain3, { noMulticall: true }), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  const out3 = await env3.BAC.chain.multi([
    env3.BAC.chain.call(ADDR.bridge, 'bridge', 'pool', 'poolBalance'),
    env3.BAC.chain.call(ADDR.bridge, 'bridge', 'owed', 'owedTotal')
  ]);
  eq('探针跑了一次', chain3.log.getCode, 1);
  eq('没有用 aggregate3', chain3.log.aggregate.length, 0);
  eq('退路也拿到了数据', out3.pool, 9n * E18);
  eq('退路第二条', out3.owed, 4n * E18);
});

await group('bsc', async () => {
  // 发射前：唯一的 RPC 调用是 eth_blockNumber，所有段保持 null
  const chainPre = makeChain(FIXTURES);
  const pre = makeEnv({ ethers: makeEthers(chainPre), fetchImpl: makeFetch(), config: { indexerBase: '' } });
  eq('发射前 LIVE = false', pre.BAC.LIVE, false);
  eq('发射前 prelaunch = true', pre.BAC.state.prelaunch, true);
  await pre.BAC.chain.refresh({ reason: 'test' });
  eq('发射前只问了块高', chainPre.log.getBlockNumber, 1);
  eq('发射前没有 eth_call', chainPre.log.calls.length, 0);
  eq('发射前金库是 null', pre.BAC.state.bsc.treasury, null);
  eq('发射前视图状态 = pre', pre.BAC.view.treasury().status, 'pre');
  eq('发射前 feed 状态 = pre', pre.BAC.view.feed().status, 'pre');
  eq('发射前 overview.prelaunch', pre.BAC.view.overview().prelaunch, true);

  // 发射后
  const chain = makeChain(FIXTURES);
  const env = makeEnv({ ethers: makeEthers(chain), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  const B = env.BAC;
  await B.chain.refresh({ reason: 'test' });
  ok('BSC 段就绪', B.state.bsc.ready, B.state.bsc.errorDetail || '');
  eq('BSC 段没有错误', B.state.bsc.error, null);

  const p = B.state.bsc.params;
  eq('symbol', p.symbol, 'BAC');
  eq('taxFeeRateBps 来自 feeConfigV2().feeRate', p.taxFeeRateBps, 300);
  eq('marketAddress 指向金库', p.marketAddressOk, true);

  const t = B.view.treasury();
  eq('金库视图状态', t.status, 'ok');
  eq('桥池那一半 5000 bps', t.bridgeBps, 5000);
  eq('节点基金那一半 5000 bps', t.nodeFundBps, 5000);
  eq('累计进桥池', t.lifetimeToBridge, 12n * E18);
  eq('累计进节点基金', t.lifetimeToNodeFund, 12n * E18);
  eq('两桶相加', t.lifetimeTotal, 24n * E18);
  eq('桥池余额', t.poolBalance, 9n * E18);
  eq('节点基金余额', t.nodeFundBalance, 400000000000000000n);
  eq('节点基金已提', t.nodeFundWithdrawn, 11600000000000000000n);
  ok('决策 #10 的披露在', /owner 可以提取节点基金这一半/.test(t.disclosure));
  ok('50/50 的基数写清楚了', /10000 − 300/.test(t.splitBaseNote), t.splitBaseNote);

  const br = B.view.bridge();
  eq('桥 · 已发行积分', br.totalIssued, 5000000n * E18);
  eq('桥 · 已退出积分', br.totalExited, 120000n * E18);
  eq('桥 · 当前兑付率', br.weiPerCredit, 1800000000000n);
  eq('桥 · 单地址每纪元上限', br.maxExitShareBps, 1000);
  eq('桥 · 没有暂停', br.paused, false);
  eq('桥 · 没有停机', br.halted, false);

  const ep = B.view.epoch();
  eq('纪元 · 上报到', ep.lastPosted, 20717);
  eq('纪元 · 定案到', ep.lastFinal, 20716);
  eq('纪元 · 锚点状态', ep.state, 'POSTED');
  eq('纪元 · 中文状态', ep.stateZh, '已上报 · 挑战窗口内');
  eq('纪元 · 承诺窗口 2 小时', ep.commitWindowSec, 7200);
  eq('纪元 · 挑战窗口 24 小时', ep.challengeWindowSec, 86400);
  eq('锚点 · exitCount', ep.anchor.exitCount, 7);
  eq('锚点 · 该纪元 gas 费', ep.anchor.gasFeesInEpoch, 54n * E18);
  eq('锚点 · 该纪元已归集', ep.anchor.remittedInEpoch, 50n * E18);

  const v = B.view.validators();
  eq('验证者 · 节点数', v.nodeCount, 2);
  eq('验证者 · 总质押', v.totalStaked, 5000000n * E18);
  eq('gas 三元组 · 已收', v.gas.collected, 100n * E18);
  eq('gas 三元组 · 已转入', v.gas.remitted, 90n * E18);
  eq('gas 三元组 · 差额', v.gas.shortfall, 10n * E18);
  eq('gas 三元组 · 不平', v.gas.ok, false);
  eq('官方出块 → 验证者池 10%', v.gas.officialValidatorBps, 1000);
  eq('验证者出块 → 自留 50%', v.gas.validatorSelfBps, 5000);
  ok('差额 ≠ 0 会告警', B.state.warnings.includes('gas_remittance_shortfall'));
  ok('归集只能对账不能强制这句话在', /不能强制/.test(v.gasNote));
  ok('两笔钱不能相加这句话在', /两笔钱/.test(v.rewardNote));

  // marketAddress 对不上时必须告警
  const bad = makeEnv({
    ethers: makeEthers(makeChain(Object.assign({}, FIXTURES, { marketAddress: [ZERO] }))),
    fetchImpl: makeFetch(), config: LIVE_CONFIG
  });
  await bad.BAC.chain.refresh({ reason: 'test' });
  eq('marketAddress 不匹配', bad.BAC.state.bsc.params.marketAddressOk, false);
  ok('marketAddress 不匹配会告警', bad.BAC.state.warnings.includes('market_address_mismatch'));
});

await group('api', async () => {
  const chain = makeChain(FIXTURES);
  const log = [];
  const env = makeEnv({ ethers: makeEthers(chain), fetchImpl: makeFetch({ log }), config: LIVE_CONFIG });
  const B = env.BAC;
  await B.api.run({ once: true });

  eq('层内数据来自索引器', B.state.layer.source, 'indexer');
  eq('层内块高', B.state.layer.head, 1234567);
  eq('层内 chainId', B.state.layer.chainId, 56777);
  eq('索引器就绪', B.state.indexer.ready, true);
  eq('没有进降级', B.state.indexer.degraded, false);

  const cs = B.view.chainStats();
  eq('链指标 · 状态', cs.status, 'ok');
  eq('链指标 · 块高', cs.head, 1234567);
  eq('链指标 · gasLimit', cs.gasLimit, 20000000);
  eq('链指标 · 出块间隔', cs.blockTimeSec, 3);
  eq('链指标 · 交易总数', cs.txTotal, 48213);
  eq('链指标 · 流通量是 BigInt', cs.circulating, 4880000n * E18);
  eq('对账 diff', cs.reconcile.diff, 0n);
  eq('对账结论', cs.reconcile.ok, true);
  ok('howToCheck 原样透传', Array.isArray(cs.reconcile.howToCheck) && cs.reconcile.howToCheck.length === 1);

  const f = B.view.feed();
  eq('feed 状态', f.status, 'ok');
  eq('feed 条数', f.items.length, 2);
  eq('feed 按 id 倒序', f.items[0].id, 91422);
  eq('未锚定必须标注', f.items[0].anchorNote, '未锚定 · 仅来自官方节点');
  eq('已锚定的标注', f.items[1].anchorNote, '已锚定');
  eq('anchoredThrough', f.anchoredThrough, 20716);
  eq('feed 文本不可信标记', f.items[0].untrusted, true);

  const bl = B.view.blocks();
  eq('区块条数', bl.items.length, 2);
  eq('区块 baseFee 是 BigInt', bl.items[0].baseFee, 0n);
  const tx = B.view.txs();
  eq('交易条数', tx.items.length, 1);
  eq('交易 value 是 BigInt', tx.items[0].value, 0n);
  eq('交易部署出的合约', tx.items[0].created, ADDR.factory);

  const ag = B.view.agents();
  eq('agent 名录条数', ag.items.length, 1);
  eq('agent 积分是 BigInt', ag.items[0].credited, 250000n * E18);
  eq('agent 状态中文', ag.items[0].statusZh, '活跃');
  eq('agent 计数', ag.counts.active, 35);
  ok('agentURI 不背书这句话在', /不背书/.test(ag.note));

  const v = B.view.validators();
  eq('验证者条数', v.items.length, 2);
  eq('验证者 · 已收（cumOwed）', v.items[0].gas.collected, 54n * E18);
  eq('验证者 · 已转入', v.items[0].gas.remitted, 50n * E18);
  eq('验证者 · 差额自己算出来', v.items[0].gas.shortfall, 4n * E18);
  eq('验证者 · 出块资格', v.items[0].gas.proposerRights, true);
  eq('没给归集字段的那个是 null（不猜）', v.items[1].gas.collected, null);
  eq('没给归集字段就没有差额', v.items[1].gas.shortfall, null);
  eq('没给出块资格就是 null', v.items[1].gas.proposerRights, null);

  const eps = B.view.epoch();
  eq('纪元历史条数', eps.history.length, 1);
  eq('纪元历史 · gasFees', eps.history[0].gasFees, 54n * E18);
  eq('纪元历史 · 中文状态', eps.history[0].stateZh, '已上报 · 挑战窗口内');

  eq('兑付率', B.state.rate.weiPerCredit, 1800000000000n);
  ok('兑付率带免责', /不承诺任何金额/.test(B.state.rate.note));

  // 单个端点 404 不该拖垮别的段
  const env2 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ only404: ['/api/validators'] }), config: LIVE_CONFIG });
  await env2.BAC.api.run({ once: true });
  eq('404 的段报错', env2.BAC.state.validators.error, '读取失败 · 重试中');
  eq('其它段照常', env2.BAC.state.feed.ready, true);
  eq('整体没有降级', env2.BAC.state.indexer.degraded, false);
});

await group('degraded', async () => {
  // 索引器全挂：BSC 那一半必须照常工作
  const chain = makeChain(FIXTURES);
  const env = makeEnv({ ethers: makeEthers(chain), fetchImpl: makeFetch({ fail: true, layerRpcOk: true }), config: LIVE_CONFIG });
  const B = env.BAC;
  await B.chain.refresh({ reason: 'test' });
  await B.api.run({ once: true });
  await B.api.run({ once: true });   // 第二次失败才宣布降级

  eq('索引器失败被记下来', B.state.indexer.ready, false);
  eq('进入降级模式', B.state.indexer.degraded, true);
  eq('降级告警', B.state.warnings.includes('indexer_down'), true);
  eq('降级提示语', B.api.degradedNote(), '索引器读不到：层内数据暂时不可用，BSC 侧数字仍然是实时的');
  eq('层内那段报「读取失败 · 重试中」', B.state.layer.error, '读取失败 · 重试中');
  eq('feed 状态 = error', B.view.feed().status, 'error');

  // 退到层内 RPC：只回答「链还活着吗」，并标清来源
  eq('降级后块高来自层内 RPC', B.state.layer.source, 'rpc');
  eq('层内 RPC 读到的块高', B.state.layer.head, 0x12d687);
  eq('不知道的时间戳就是 null', B.state.layer.headTs, null);

  // BSC 一半必须仍然是真数
  eq('BSC 段仍然就绪', B.state.bsc.ready, true);
  eq('金库视图仍然 ok', B.view.treasury().status, 'ok');
  eq('金库数字仍然是真的', B.view.treasury().lifetimeToBridge, 12n * E18);
  eq('验证者的链上总量仍然在', B.view.validators().totalStaked, 5000000n * E18);
  eq('gas 三元组仍然在', B.view.validators().gas.shortfall, 10n * E18);
  eq('链指标标了降级', B.view.chainStats().degraded, true);
  ok('链指标带降级说明', /BSC 侧数字仍然是实时的/.test(B.view.chainStats().degradedNote));
  eq('整页横幅', B.view.overview().degradedBanner, '索引器读不到：层内数据暂时不可用，BSC 侧数字仍然是实时的');

  // 层内 RPC 也挂：source 回到 null，不许编数
  const env2 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ fail: true, layerRpcOk: false }), config: LIVE_CONFIG });
  await env2.BAC.api.run({ once: true });
  eq('两边都挂 → 来源为空', env2.BAC.state.layer.source, null);
  eq('两边都挂 → 块高仍是 null', env2.BAC.state.layer.head, null);

  // 没配索引器时不该发请求
  const log3 = [];
  const env3 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ log: log3 }), config: Object.assign({}, LIVE_CONFIG, { indexerBase: '' }) });
  await env3.BAC.api.run({ once: true });
  eq('没配索引器就不发请求', log3.length, 0);
  eq('HAS_INDEXER = false', env3.BAC.HAS_INDEXER, false);

  // 全程没有碰 DOM
  eq('降级流程也没有碰 DOM', env.domHits.length, 0);

  // setHidden 不依赖 document
  B.setHidden(true);
  eq('隐藏状态记下来了', B.state.hidden, true);
  B.setHidden(false);
  eq('恢复可见', B.state.hidden, false);
});

console.log('\n──────────────────────────────');
console.log('通过 ' + pass + ' · 失败 ' + fail);
if (failures.length) {
  console.log('\n失败清单:');
  failures.forEach(f => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
