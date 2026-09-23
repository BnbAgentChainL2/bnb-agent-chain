/* 网站数据层的离线单测：node artifacts/data-check/unit.mjs [--only=<组名>] [--release]
   组：shape|fmt|rpc|multicall|config|stages|router|owner|agents|bsc|api|layer|degraded|review|release|abi
   --release：上线前用。web/site.config.js 里没有已锁定的代币地址（决策 #35）就算失败（平时只打印一条提醒）。
   规矩：
   - 不连服务器、不连主网、不需要任何私钥；ethers 与 fetch 全部是假的；
   - 把 web/site.config.js + web/js/data/*.js 放进 node:vm 的假 window 里跑；
   - 任何对 document / localStorage / navigator 的访问都直接判失败（数据层不许有 DOM 代码）。
   v2（决策 #29 / #30 / #31 / #35）：地址簿是 token / router / bridge / nodeFund / anchor / staking；
   BSC 侧三阶段（none / deployed / launched）由 eth_getCode 探针决定。 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', 'web');

const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
const verbose = process.argv.includes('--verbose');
const release = process.argv.includes('--release');

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
function eqAddr(name, got, want) {
  ok(name, typeof got === 'string' && typeof want === 'string' && got.toLowerCase() === want.toLowerCase(), String(got) + ' !== ' + String(want));
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
  /* 真 ethers v6：认不出 topic 就返回 null。假的：data 里就是 {name, args}。 */
  parseLog(log) {
    const d = dec(log.data);
    if (!this.frags.some(f => f.startsWith('event ' + d.name + '('))) return null;
    return { name: d.name, args: d.args };
  }
}

/** 一条假日志（地址 / 块 / 交易 / 事件名 / 参数）。 */
function mkLog(address, blockNumber, tx, index, name, args) {
  return { address, blockNumber, transactionHash: tx, index, topics: ['0x' + name], data: enc({ name, args }) };
}

/** 一条链的假后端：记录每次调用，按 fixtures 给结果。fixture 可以是函数 (args, target) → 结果。 */
function makeChain(fixtures, opts = {}) {
  const log = { calls: [], aggregate: [], getCode: 0, codeFor: [], getBlock: 0, getBlockNumber: 0, byUrl: {},
    getLogs: 0, logRanges: [], logUrls: [], getStorage: 0, blockFor: [] };
  const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
  function resultFor(fn, args, target) {
    const f = fixtures[fn];
    if (f === undefined) return undefined;
    return typeof f === 'function' ? f(args, target) : f;
  }
  function handleCall(tx, url) {
    const { fn, args } = dec(tx.data);
    if (tx.to === MC && fn === 'aggregate3') {
      const payload = args[0];
      log.aggregate.push(payload.length);
      const rows = payload.map(([target, allow, data]) => {
        const inner = dec(data);
        log.calls.push(inner.fn);
        const r = resultFor(inner.fn, inner.args, target);
        if (r === undefined || (opts.failFns || []).includes(inner.fn)) return [false, '0x'];
        return [true, enc(r)];
      });
      return enc([rows]);
    }
    log.calls.push(fn);
    const r = resultFor(fn, args, tx.to);
    if (r === undefined) throw Object.assign(new Error('execution reverted: no fixture'), { code: 'CALL_EXCEPTION', data: '0x' });
    return enc(r);
  }
  return { log, handleCall, MC };
}

const HEAD = 123456789;
const HEAD_TS = 1790000000;

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
    async getCode(a) {
      this._guard(); chain.log.getCode++;
      if (String(a).toLowerCase() === chain.MC.toLowerCase()) {
        // 探针本身没答上（网络抖动），不是「链上没有 Multicall3」
        if (behaviour.mcProbeFail > 0) { behaviour.mcProbeFail--; throw Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }); }
        return behaviour.noMulticall ? '0x' : '0x60806040';
      }
      chain.log.codeFor.push(String(a).toLowerCase());
      const m = behaviour.code || {};
      const k = String(a).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(m, k)) return typeof m[k] === 'function' ? m[k]() : m[k];
      return '0x60806040';
    }
    async getBlockNumber() { this._guard(); chain.log.getBlockNumber++; return behaviour.headNumber || HEAD; }
    async getBlock(tag) {
      this._guard(); chain.log.getBlock++;
      const head = behaviour.headNumber || HEAD, headTs = behaviour.headTs || HEAD_TS;
      if (tag === undefined || tag === 'latest') return { number: head, timestamp: headTs };
      chain.log.blockFor.push(Number(tag));
      return { number: Number(tag), timestamp: headTs - (head - Number(tag)) };
    }
    async getStorage(a, slot) {
      this._guard(); chain.log.getStorage++;
      chain.log.lastSlot = slot;
      return typeof behaviour.implSlot === 'function' ? behaviour.implSlot() : (behaviour.implSlot || '0x' + '0'.repeat(24) + 'a2'.repeat(20));
    }
    async getLogs(f) {
      this._guard(); chain.log.getLogs++;
      chain.log.logRanges.push([f.fromBlock, f.toBlock]);
      chain.log.logUrls.push(this.url);
      if (behaviour.logsFail) throw Object.assign(new Error('Archive requests require a personal token'), { code: 'SERVER_ERROR' });
      const addrs = (Array.isArray(f.address) ? f.address : [f.address]).map(x => String(x).toLowerCase());
      return (behaviour.logs || []).filter(l => addrs.includes(String(l.address).toLowerCase())
        && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
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

const FILES = ['site.config.js', 'js/data/bac-core.js', 'js/data/bac-chain.js', 'js/data/bac-layer.js', 'js/data/bac-api.js', 'js/data/bac-view.js'];
const SRC = Object.fromEntries(FILES.map(f => [f, readFileSync(join(WEB, f.split('/').join('/')), 'utf8')]));
const PROPOSED_CFG_PATH = join(HERE, 'site.config.proposed.js');
const PROPOSED_CFG = existsSync(PROPOSED_CFG_PATH) ? readFileSync(PROPOSED_CFG_PATH, 'utf8') : null;

function domTrap(name, hits) {
  return new Proxy({}, {
    get(t, k) { if (k !== Symbol.toPrimitive && k !== 'then') hits.push(name + '.' + String(k)); return undefined; },
    set(t, k) { hits.push(name + '.' + String(k) + '='); return true; }
  });
}

/** siteConfig：用哪份 site.config.js（默认是 web/ 里那份真的；'proposed' = 本目录里拟换上的那份）。
    rawConfig：为 true 时不往 BAC_CONFIG 里塞任何东西（测「配置文件原样加载」）。 */
function makeEnv({ config = {}, ethers, fetchImpl, autoStart = false, siteConfig = null, rawConfig = false } = {}) {
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
    BAC_CONFIG: rawConfig ? undefined : Object.assign({ autoStart }, config)
  };
  if (rawConfig) delete sandbox.BAC_CONFIG;
  vm.createContext(sandbox);
  vm.runInContext('var window = globalThis; var globalThisRef = globalThis;', sandbox);
  if (rawConfig) vm.runInContext('window.BAC_CONFIG = { autoStart: false };', sandbox);
  for (const f of FILES) {
    const src = f === 'site.config.js' && siteConfig === 'proposed' ? PROPOSED_CFG : SRC[f];
    vm.runInContext(src, sandbox, { filename: f });
  }
  return { sandbox, BAC: sandbox.BAC, domHits, timers, flush: () => { const t = timers.splice(0); t.forEach(x => x.fn()); } };
}

/* ══════════════════════════════════════════════════════
   固定测试数据
   ══════════════════════════════════════════════════════ */

const ADDR = {
  token: '0x2222222222222222222222222222222222222222',
  router: '0x1111111111111111111111111111111111111111',
  bridge: '0x3333333333333333333333333333333333333333',
  nodeFund: '0x4444444444444444444444444444444444444444',
  anchor: '0x6666666666666666666666666666666666666666',
  staking: '0x7777777777777777777777777777777777777777'
};
/* v1 形状的旧配置（现在 web/site.config.js 还是这个形状）：有 factory / vault / registry，没有 router */
const OLD_ADDR = {
  factory: '0x8888888888888888888888888888888888888888',
  vault: ADDR.router,
  token: ADDR.token, bridge: ADDR.bridge, nodeFund: ADDR.nodeFund,
  registry: '0x5555555555555555555555555555555555555555',
  anchor: ADDR.anchor, staking: ADDR.staking
};
const REAL_TOKEN = '0xA97452d175679B2bF5F25a9a382D22aff39b7777';
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
const PANCAKE = '0x10ED43C718714eb63d5aA57B78B54704E256024E';   // PancakeSwap V2 Router = BacBridge.router()
const PROC = '0x9999999999999999999999999999999999999999';
const OWNER = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const OTHER = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const WATCHDOG = '0x51b6D9a3665c74FFef80ca8d3898edB9DeBcDb55';
const IMPL1 = '0x' + 'a1'.repeat(20);
const IMPL2 = '0x' + 'a2'.repeat(20);
const EXT = '0x' + 'e7'.repeat(20);
const ZERO = '0x0000000000000000000000000000000000000000';
const MC_ADDR = '0xcA11bde05977b3631167028862bE2a173976CA11';
const OWNER_NOTICE = '项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。';
const AGENT_WALLET_17 = '0x' + 'be'.repeat(20);

const E18 = 1000000000000000000n;
const lc = (a) => String(a).toLowerCase();

/* ERC-8004 注册文件（持有人自述）：带一个外链图片 —— 数据层绝不能把它交给页面 */
const TOKEN_URI_17 = 'data:application/json;base64,' + Buffer.from(JSON.stringify({
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Clawbot 爪子', description: '我自己说我是个 AI', image: 'https://evil.example/track.png'
})).toString('base64');

const DEPOSITS = {
  0: [OWNER, 1789900000, 17n, 250000n * E18],
  1: [OTHER, 1789950000, 99n, 1000n * E18],
  2: [OWNER, 1789960000, 17n, 50000n * E18]
};

function ethBal(map) {
  return (args) => { const v = map[lc(args[0])]; return v === undefined ? undefined : [v]; };
}

/* 阶段 (c)：全部部署 + 代币已发射 */
const FIXTURES = {
  // BacTaxRouter
  bacToken: [ADDR.token], bridge: [ADDR.bridge], nodeFund: [ADDR.nodeFund], BRIDGE_BPS: [5000], PUSH_GAS: [100000n],
  accountedQuote: [500000000000000000n], unsplitRevenue: [500000000000000000n],
  lifetimeToBridge: [12n * E18], lifetimeToNodeFund: [12n * E18], totalRecognized: [24n * E18 + 500000000000000000n],
  stuckAmounts: [[0n, 0n]], solvency: [[500000000000000000n, 500000000000000000n, 500000000000000000n]],
  getEthBalance: ethBal({ [lc(ADDR.router)]: 500000000000000000n, [lc(ADDR.bridge)]: 9n * E18, [lc(ADDR.nodeFund)]: 400000000000000000n }),
  // token
  name: ['BNB Agent Chain'], symbol: ['BAC'], decimals: [18], totalSupply: [10n ** 27n],
  taxRate: [300], buyTaxRate: [300], sellTaxRate: [300], taxProcessor: [PROC],
  balanceOf: (args) => lc(args[0]) === lc(ADDR.bridge) ? [4n * E18] : [0n],
  // tax processor
  marketAddress: [ADDR.router],
  feeConfigV2: [[10000, 0, 0, 0, 1000, false, 0, ZERO]],
  marketQuoteBalance: [30000000000000000n], totalQuoteSentToMarketing: [27n * E18],
  // Flap Portal
  getTokenV8Safe: [[1, 10n * E18, 300000000n * E18, 2000000000n, 6, 0n, 0n, 0n, 800000000n * E18, ZERO, false,
    '0x' + '00'.repeat(32), 300n, 300n, ZERO, 400000000000000000n, 0, 0]],
  // BacBridge：接线
  owner: [OWNER], pendingOwner: [ZERO], identityRegistry: [REGISTRY], anchor: [ADDR.anchor], watchdog: [WATCHDOG],
  // BacBridge.router() 是 PancakeSwap V2 Router（DeployBac.s.sol 的 BAC_PANCAKE_ROUTER），不是 BacTaxRouter；
  // BacTaxRouter 根本没有 router()（别的合约问它就 revert）
  portal: [PORTAL], router: (args, target) => lc(target) === lc(ADDR.bridge) ? [PANCAKE] : undefined, EXTENSION: [EXT],
  OWNER_POWER_NOTICE: [OWNER_NOTICE], IDENTITY_LIMIT_NOTICE: ['我们要求持有 agent 身份，我们不能证明它是 AI。'],
  description: [OWNER_NOTICE + '……'],
  // BacBridge：账
  lockedBac: [5000000n * E18], totalBurned: [0n], totalCreditsIssued: [5000000n * E18], totalCreditsExited: [120000n * E18],
  creditsOutstanding: [4880000n * E18], depositId: [3n],
  deposits: (args) => DEPOSITS[Number(args[0])],
  buybackBac: [8n * E18], bnbBalance: [9n * E18], buybackBudget: [1n * E18], buybackBacBought: [100000n * E18],
  buybackBnbSpent: [2n * E18], bacAccounted: [5000008n * E18],
  buybackState: [[1n * E18, 500000000000000000n, 3, 1]],
  owedTotal: [4n * E18], reservedTotal: [1n * E18], releasedInWindow: [2n * E18],
  currentRate: [1800000000000n], lastEpochRelease: [[1n * E18, 1789999000, 350]],
  isPaused: [[false, 0, 0]], isHalted: [false], lastSettledEpoch: [2983332], skippedEpochs: [0],
  haltCause: [0], pendingCause: [0], escapeArmedAt: [0], escapeState: [[0n, 0n, 0n, 0n, 0n]],
  upgradeCount: [1n], lastUpgradeAt: [1789990000], emergencyBnbWithdrawn: [1n * E18], emergencyBacWithdrawn: [0n],
  emergencyCount: [1n], lastEmergencyAt: [1789995000],
  shortfall: [[0n, 0n]],
  credited: (args) => ({ 17: [300000n * E18], 99: [1000n * E18] })[Number(args[0])],
  exitedCredits: (args) => ({ 17: [0n], 99: [0n] })[Number(args[0])],
  agentController: (args) => ({ 17: [OWNER], 99: [OTHER] })[Number(args[0])],
  // ERC-8004 Identity Registry：ownerOf 对没铸过的 99 号 revert（fixture 返回 undefined = success false）
  ownerOf: (args) => Number(args[0]) === 17 ? [OWNER] : undefined,
  getMetadata: (args) => (Number(args[0]) === 17 && args[1] === 'agentWallet') ? [AGENT_WALLET_17] : undefined,
  tokenURI: (args) => Number(args[0]) === 17 ? [TOKEN_URI_17] : undefined,
  // node fund
  balance: [400000000000000000n], lifetimeReceived: [12n * E18], lifetimeWithdrawn: [11n * E18 + 600000000000000000n],
  // staking（ValidatorStaking.sol 里真有的读函数；01 §11.5 的 lastRemitEpoch / remitStatus … 合约里没有，不给夹具）
  totalStaked: [5000000n * E18], nodeCount: [2n], rewardBalance: [300000000000000000n],
  lifetimeFunded: [800000000000000000n], lifetimePaid: [500000000000000000n],
  // ValidatorStaking.dayReward(day)：奖池按天记（epochReward(epoch) 只是 dayReward(epoch / 144) 的别名）
  dayReward: (args) => Number(args[0]) === Math.floor(2983332 / 144) ? [[1n * E18, 5000000n * E18, 200000000n, true]] : [[0n, 0n, 0n, false]],
  // anchor（合约里的 12 字段 Anchor）。cumulativeGasFees / cumulativeRemitted 合约里没有，不给夹具
  firstEpoch: [2983000],
  lastPostedEpoch: [2983332], lastFinalEpoch: [2983331], lastFinalAt: [1789990000],
  cumulativeCredited: [5000000n * E18], cumulativeExit: [120000n * E18],
  haltReason: [0], vetoCountInWindow: [0], disputeCountInWindow: [0], releaseBpsFor: [350],
  getAnchor: [[
    '0x' + 'ab'.repeat(32),   // exitRoot
    '0x' + 'ef'.repeat(32),   // l2BlockHash
    1234501,                  // l2Block
    1789995000,               // postedAt
    0,                        // finalizedAt
    500000n * E18,            // creditedInEpoch
    120000n * E18,            // exitCreditsInEpoch
    3125000000000000n,        // feeBurnedInEpoch
    380000n * E18,            // circulating
    7,                        // exitCount
    2,                        // agreeingCount
    1                         // state = POSTED
  ]]
};

/* 阶段 (b)：合约刚部署完，代币还没发射 —— 全是真的 0，shortfall() 会 revert（它要读还不存在的代币）。
   锚点用**构造函数真实写下的值**（ChainAnchor.sol:215-224）：firstEpoch = e0、lastPostedEpoch = e0 − 1（占位）、
   lastFinalEpoch 不写（0）、lastFinalAt = 部署时间（停机计时的起点）；每个纪元的锚点都是空的（state NONE）。
   BacBridge.initialize 同理：lastSettledEpoch = 部署纪元，其余时间戳全是 0。 */
const E0 = 2983330;
const DEPLOY_TS = E0 * 600 + 17;
const EMPTY_ANCHOR = ['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), 0, 0, 0, 0n, 0n, 0n, 0n, 0, 0, 0];
const FIXTURES_DEPLOYED = Object.assign({}, FIXTURES, {
  accountedQuote: [0n], unsplitRevenue: [0n], lifetimeToBridge: [0n], lifetimeToNodeFund: [0n], totalRecognized: [0n],
  stuckAmounts: [[0n, 0n]], solvency: [[0n, 0n, 0n]],
  getEthBalance: ethBal({ [lc(ADDR.router)]: 0n, [lc(ADDR.bridge)]: 0n, [lc(ADDR.nodeFund)]: 0n }),
  lockedBac: [0n], totalCreditsIssued: [0n], totalCreditsExited: [0n], creditsOutstanding: [0n], depositId: [0n],
  buybackBac: [0n], bnbBalance: [0n], buybackBudget: [0n], buybackBacBought: [0n], buybackBnbSpent: [0n], bacAccounted: [0n],
  buybackState: [[0n, 0n, 0, 0]], owedTotal: [0n], reservedTotal: [0n], releasedInWindow: [0n], currentRate: [0n],
  lastEpochRelease: [[0n, 0, 0]], isPaused: [[false, 0, 0]], escapeArmedAt: [0], lastSettledEpoch: [E0],
  upgradeCount: [0n], lastUpgradeAt: [0], emergencyBnbWithdrawn: [0n], emergencyBacWithdrawn: [0n],
  emergencyCount: [0n], lastEmergencyAt: [0],
  shortfall: undefined,
  balance: [0n], lifetimeReceived: [0n], lifetimeWithdrawn: [0n],
  totalStaked: [0n], nodeCount: [0n], rewardBalance: [0n], lifetimeFunded: [0n], lifetimePaid: [0n],
  dayReward: [[0n, 0n, 0n, false]],
  firstEpoch: [E0], lastPostedEpoch: [E0 - 1], lastFinalEpoch: [0], lastFinalAt: [DEPLOY_TS],
  cumulativeCredited: [0n], cumulativeExit: [0n],
  getAnchor: [EMPTY_ANCHOR]
});

const LIVE_CONFIG = {
  addresses: ADDR,
  indexerBase: 'https://indexer.test',
  layerRpc: 'https://layer.test/rpc',
  rpcs: ['https://rpc-a.test', 'https://rpc-b.test'],
  logRpcs: ['https://logs.test'],
  pollMs: 999999, prelaunchPollMs: 999999, apiPollMs: 999999
};
/* 只测 BSC 那一半时：不配索引器、不配层内 RPC */
const BSC_ONLY = (addresses, extra = {}) => Object.assign({
  addresses, indexerBase: '', fallbackApi: '', layerRpc: '', fallbackRpc: '',
  rpcs: ['https://rpc-a.test'], logRpcs: ['https://logs.test'],
  pollMs: 999999, prelaunchPollMs: 999999, apiPollMs: 999999
}, extra);

/* 假索引器响应 */
const API_BODY = {
  '/api/health': {
    schema: 'bac/health/1', ok: true, now: 1790000000,
    layer: { chainId: 56777, head: 1234567, headTs: 1789999998, blockLagSec: 2, gasLimit: 20000000, baseFee: '0', peers: 3, enode: 'enode://x@1.2.3.4:30303', genesisHash: '0x' + '11'.repeat(32) },
    relayer: { lastPostedEpoch: 2983332, currentEpoch: 2983333, epochLag: 1 },
    reconcile: {
      bscTotalIssued: '5000000000000000000000000', bscTotalExited: '120000000000000000000000',
      layerCirculating: '4879996875000000000000000', feeSinkBalance: '3125000000000000', feeSplitterBalance: '0',
      validatorBalances: [],
      // 索引器 computeReconcile 的创世分配项（演练链：Hardhat 公开测试私钥账户的 1e24）
      genesisSupply: '1000000000000000000000000000',
      genesisAlloc: '1000000000000000000000000',
      genesisAllocAccounts: [{ addr: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', balance: '1000000000000000000000000' }],
      genesisSource: '/data/genesis.json',
      note: 'genesisAlloc 是创世时就不在 L2Bridge 里的余额。',
      formula: 'diff = (bscTotalIssued − bscTotalExited + genesisAlloc) − (layerCirculating + balance(FeeSink) + balance(FeeSplitter) + Σ balance(everValidator))',
      diff: '0', ok: true,
      howToCheck: ['cast call <BacBridge> "totalCreditsIssued()(uint256)"']
    },
    // 决策 #17 的 gas 归集对账（来自 FINAL 锚点，单位层内 BAC）
    gas: {
      officialBlockValidatorBps: 1000, validatorBlockValidatorBps: 5000, lastAnchoredEpoch: 2983331,
      received: '100000000000000000000', remitted: '90000000000000000000', gap: '10000000000000000000', gapBps: 1000,
      operatorFloatReserve: null, remitOverdueEpochs: null, poolPending: null, carryPool: null, foundationBalance: null, shortfalls: []
    },
    indexer: { layerCursor: 1234567, bscCursor: HEAD - 1000, dbBytes: 1 },
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
      { id: 91422, chain: 'layer', kind: 'DEPLOY', ts: 1789999950, block: 1234560, agentId: 17, textZh: 'agent #17 部署了一个新合约', tx: '0x' + 'aa'.repeat(32), anchored: false, epoch: 2983333 },
      { id: 91421, chain: 'bsc', kind: 'Locked', ts: 1789999900, block: 123456780, agentId: 17, textZh: 'agent #17 锁了 25 万 BAC', tx: '0x' + 'bb'.repeat(32), anchored: true, epoch: 2983331 }
    ],
    head: 91422, anchoredThrough: 2983331, updatedAt: 1790000000
  },
  '/api/blocks': {
    schema: 'bac/blocks/1',
    items: [
      { number: 1234567, hash: '0x' + '01'.repeat(32), ts: 1789999998, txCount: 2, gasUsed: 42000, gasLimit: 20000000, baseFee: '0', epoch: 2983333 },
      { number: 1234566, hash: '0x' + '02'.repeat(32), ts: 1789999995, txCount: 0, gasUsed: 0, gasLimit: 20000000, baseFee: '0', epoch: 2983333 }
    ]
  },
  '/api/block/1234567': {
    schema: 'bac/blocks/1', number: 1234567,
    txs: [{ hash: '0x' + 'cc'.repeat(32), block: 1234567, idx: 0, from: OWNER, to: null, value: '0', gasUsed: 21000, effGasPrice: '1000000000', feeBurned: '0', created: IMPL1, status: 1, agentId: 17, ts: 1789999998 }]
  },
  /* v2 索引器（indexer/src/api/handlers.js agentRow，bac/agents/2）：creditsLocked / creditsExited / layerWallets[]。
     故意混进一个 v1 的 status 字段：数据层必须把状态机字段作废成 null */
  '/api/agents': {
    schema: 'bac/agents/2', total: 42, page: 1, pageSize: 50,
    items: [{
      agentId: 17, holder: OWNER, agentWallet: AGENT_WALLET_17, identityExists: true, identityCheckedAt: 1789999000,
      registrationName: 'Clawbot 爪子', selfReported: true, controller: OWNER,
      layerWallets: [OTHER, OWNER], firstLockAt: 1789900044, firstLockBlock: 123450000, lockCount: 2,
      creditsLocked: '250000000000000000000000', creditsExited: '1000000000000000000',
      layerBalance: '249978000000000000000000', deploys: 3, announces: 11, lastLayerBlock: 1234560,
      tokens: 1, pairs: 0, swaps: 4,
      status: 2, statusName: 'ACTIVE'
    }],
    note: 'x'
  },
  '/api/validators': {
    schema: 'bac/validators/1', totalStaked: '5000000000000000000000000', rewardBalance: '300000000000000000',
    items: [
      { nodeId: 'my-node-01', validator: OWNER, payout: OWNER, enodeURI: 'enode://y@1.2.3.4:30303', active: true, strikes: 0, staked: '2000000000000000000000000', lastEpoch: 2983332, agreedEpochs: 30, disputedEpochs: 0, lifetimeClaimed: '100000000000000000', cumOwed: '54000000000000000000', cumRemitted: '50000000000000000000', proposerRights: true, qualifyStreak: 30 },
      { nodeId: 'my-node-02', validator: ZERO, payout: ZERO, enodeURI: '', active: false, strikes: 1, staked: '2000000000000000000000000', lastEpoch: 2983331, agreedEpochs: 12, disputedEpochs: 1, lifetimeClaimed: '0' }
    ]
  },
  '/api/epochs': {
    schema: 'bac/epochs/1',
    items: [{ epoch: 2983332, state: 'POSTED', exitRoot: '0x' + 'ab'.repeat(32), l2Block: 1234501, l2BlockHash: '0x' + 'ef'.repeat(32), credited: '500000000000000000000000', exitCredits: '120000000000000000000000', feeBurned: '3125000000000000', circulating: '380000000000000000000000', exitCount: 7, postedAt: 1789995000, agreeingCount: 2, agreeingWt: '5000000000000000000000000', disputingWt: '0', releaseBps: 350, pot: '1000000000000000000', rate: '0', gasFees: '54000000000000000000', remitted: '50000000000000000000', proposerCount: 1 }]
  },
  // v2（handlers.js rate，bac/rate/2）：兑付的是回购来的 BAC
  '/api/rate': { schema: 'bac/rate/2', unit: 'BAC', bacPerCredit: '1800000000000', source: 'BacBridge.currentRate()', buybackBac: '8000000000000000000', owedTotal: '4000000000000000000', creditsOutstanding: '4880000000000000000000000', lastPot: '1000000000000000000', note: '估算 · 不承诺任何金额 · 兑付的是回购来的 BAC，比直接拿 BNB 多损耗约 4%' },
  // 决策 #29c（handlers.js bridgeTimeline，bac/bridge-timeline/1）：索引器从部署块起的全量历史
  '/api/bridge/timeline': {
    schema: 'bac/bridge-timeline/1', scope: 'all', bridge: ADDR.bridge, nodeFund: ADDR.nodeFund,
    totals: { upgrades: 1, emergencyWithdrawals: 0, emergencyBnb: '0', emergencyBac: '0', emergencyOtherTokens: 0, ownerChanges: 1, nodeFundWithdrawals: 1, nodeFundWithdrawn: '2000000000000000000' },
    items: [
      { contract: 'BacNodeFund', event: 'Withdrawn', ts: 1789950000, block: HEAD - 20000, tx: '0x' + 'c3'.repeat(32), logIndex: 2,
        args: { to: OWNER, amount: '2000000000000000000', balanceAfter: '0' }, textZh: '节点基金提取了 2 BNB' },
      { contract: 'BacBridge', event: 'BridgeUpgraded', ts: 1789940000, block: HEAD - 30000, tx: '0x' + 'c2'.repeat(32), logIndex: 0,
        args: { newImplementation: IMPL2, previousImplementation: IMPL1, by: OWNER, upgradeNumber: '1', at: '1789940000',
          bnbBook: '0', lockedBacBook: '0', buybackBacBook: '0', owedTotalBook: '0' }, textZh: '桥合约第 1 次升级' },
      { contract: 'BacBridge', event: 'Upgraded', ts: 1789940000, block: HEAD - 30000, tx: '0x' + 'c2'.repeat(32), logIndex: 1,
        args: { implementation: IMPL2 }, textZh: '实现换成了 …' },
      { contract: 'BacBridge', event: 'OwnershipTransferred', ts: 1789900000, block: HEAD - 90000, tx: '0x' + 'c1'.repeat(32), logIndex: 1,
        args: { previousOwner: ZERO, newOwner: OWNER }, textZh: 'owner 设为部署钱包' },
      { contract: 'BacBridge', event: 'Initialized', ts: 1789900000, block: HEAD - 90000, tx: '0x' + 'c1'.repeat(32), logIndex: 0,
        args: { version: '1' }, textZh: '桥合约初始化' }
    ],
    note: OWNER_NOTICE, updatedAt: 1790000000
  }
};

/* v1 形状（线上还没换版的索引器）：数据层两版都得认 */
const API_AGENTS_V1 = {
  schema: 'bac/agents/1', total: 42, page: 1, pageSize: 50,
  items: [{ agentId: 17, controller: OWNER, wallet: OWNER, status: 2, statusName: 'ACTIVE', registeredAt: 1789900000, activatedAt: 1789900044, solved: 3, lastHeartbeatEpoch: 2983333, missed: 0, credited: '250000000000000000000000', exited: '0', layerBalance: '249978000000000000000000', deploys: 3, announces: 11, lastLayerBlock: 1234560, agentURI: 'https://x/agent.json', endpointHash: '0x' + '03'.repeat(32), modelFingerprint: '0x' + '04'.repeat(32) }]
};
const API_RATE_V1 = { schema: 'bac/rate/1', weiPerCredit: '1800000000000', poolBalance: '9000000000000000000', owedTotal: '4000000000000000000', creditsOutstanding: '4880000000000000000000000', lastPot: '1000000000000000000', note: '估算 · 不承诺任何金额' };

/* ── 假的层内 Besu 节点（真节点实测字段：miner 有值、baseFeePerGas 0x0、
      txpool_status 是 -32601 Method not found、批量数组体可用）────────── */
const NODE_MINER = '0x729d90c32ff111d9686fe04b201ecac7a7f7cf05';

function makeNode(opts = {}) {
  const head = opts.head ?? 0x12d687;          // 1234567
  const ts0 = opts.ts0 ?? 1789999998;
  const interval = opts.interval ?? 3;
  const txEvery = opts.txEvery ?? 7;           // 每 7 块有一笔交易（真链约 20 秒一笔）
  const log = { calls: [], methods: {}, requests: 0, byUrl: {} };
  const h64 = (n, tail = '0') => '0x' + n.toString(16).padStart(63, '0') + tail;

  function txAt(n, blockHash) {
    return {
      hash: h64(n, 'f'), blockHash, blockNumber: '0x' + n.toString(16), chainId: '0xddc9',
      from: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      to: '0x000000000000000000000000000000000000dead',
      gas: '0x5208', gasPrice: '0x3b9aca00', input: '0x', nonce: '0x890',
      transactionIndex: '0x0', type: '0x0', value: '0xe8d4a51000'
    };
  }
  function blockAt(n) {
    if (n < 0 || n > head) return null;
    const hash = h64(n, '0');
    const hasTx = n % txEvery === 0;
    return {
      number: '0x' + n.toString(16), hash, parentHash: h64(Math.max(0, n - 1), '0'),
      miner: NODE_MINER, timestamp: '0x' + (ts0 - (head - n) * interval).toString(16),
      gasLimit: '0x1312d00', gasUsed: hasTx ? '0x5208' : '0x0', baseFeePerGas: '0x0',
      size: '0x2f3', stateRoot: h64(1, '0'), extraData: '0xf87ea0',
      transactions: hasTx ? [txAt(n, hash)] : []
    };
  }
  function receiptFor(t, b) {
    return {
      transactionHash: t.hash, transactionIndex: '0x0', blockHash: b.hash, blockNumber: b.number,
      from: t.from, to: t.to, contractAddress: null, gasUsed: '0x5208',
      cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', status: '0x1', logs: [], type: '0x0'
    };
  }
  function nOf(p) { return p === 'latest' ? head : Number(BigInt(p)); }
  function nFromTxHash(hx) { return Number(BigInt('0x' + String(hx).slice(2, -1))); }
  function nFromBlockHash(hx) { return Number(BigInt(hx)); }

  function one(q) {
    log.calls.push(q.method);
    log.methods[q.method] = (log.methods[q.method] || 0) + 1;
    const R = (result) => ({ jsonrpc: '2.0', id: q.id, result });
    const E = (code, message) => ({ jsonrpc: '2.0', id: q.id, error: { code, message } });
    const strip = (b) => ({ ...b, transactions: b.transactions.map(t => t.hash) });
    switch (q.method) {
      case 'eth_chainId': return R('0xddc9');
      case 'eth_blockNumber': return R('0x' + head.toString(16));
      case 'eth_gasPrice': return R('0x3b9aca00');
      case 'net_peerCount': return R('0x0');
      case 'txpool_status': return opts.txpool ? R({ pending: '0x1', queued: '0x0' }) : E(-32601, 'Method not found');
      case 'eth_getBlockByNumber': {
        const b = blockAt(nOf(q.params[0]));
        return R(b ? (q.params[1] ? b : strip(b)) : null);
      }
      case 'eth_getBlockByHash': {
        const b = blockAt(nFromBlockHash(q.params[0]));
        return R(b ? (q.params[1] ? b : strip(b)) : null);
      }
      case 'eth_getBlockReceipts': {
        if (opts.noReceipts) return E(-32601, 'Method not found');
        const b = blockAt(nOf(q.params[0]));
        return R(b ? b.transactions.map(t => receiptFor(t, b)) : null);
      }
      case 'eth_getTransactionByHash': {
        const b = blockAt(nFromTxHash(q.params[0]));
        return R(b && b.transactions.length ? b.transactions[0] : null);
      }
      case 'eth_getTransactionReceipt': {
        const b = blockAt(nFromTxHash(q.params[0]));
        return R(b && b.transactions.length ? receiptFor(b.transactions[0], b) : null);
      }
      default: return E(-32601, 'Method not found');
    }
  }
  return {
    head, log,
    handle(body) { return Array.isArray(body) ? body.map(one) : one(body); }
  };
}

function makeFetch({ fail = false, only404 = [], layerRpcOk = true, node = null, rpcFail = {}, log = [], bodies = {} } = {}) {
  const N = node || makeNode();
  return async function (url, opts = {}) {
    log.push(url);
    const u = String(url);
    if (u.endsWith('/rpc')) {
      N.log.requests++;
      N.log.byUrl[u] = (N.log.byUrl[u] || 0) + 1;
      if (!layerRpcOk || rpcFail[u]) throw new Error('Failed to fetch');
      return { ok: true, status: 200, json: async () => N.handle(JSON.parse(opts.body || '{}')) };
    }
    if (fail) throw new Error('Failed to fetch');
    const path = String(url).replace('https://indexer.test', '').split('?')[0];
    if (only404.includes(path)) {
      return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: '没有这个东西' } }) };
    }
    const body = Object.prototype.hasOwnProperty.call(bodies, path) ? bodies[path] : API_BODY[path];
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
    'start', 'stop', 'refresh', 'statusName', 'statusZh', 'epochStateZh',
    'CONTRACTS_CONFIGURED', 'CONTRACTS_LIVE', 'TOKEN_CONFIGURED', 'TOKEN_LIVE', 'STAGE', 'STAGE_KNOWN', 'setStage', 'ADDRESS_KEYS']) {
    ok('BAC.' + k, B[k] !== undefined);
  }
  for (const k of ['units', 'token', 'bnb', 'compact', 'pct', 'share', 'int', 'addr', 'hash', 'duration', 'hms', 'beijing', 'ago', 'big', 'num'])
    ok('BAC.fmt.' + k, typeof B.fmt[k] === 'function');
  for (const k of ['tx', 'address', 'addressEvents', 'block', 'token', 'layerTx', 'layerBlock', 'agent', 'epoch', 'flap', 'api'])
    ok('BAC.links.' + k, typeof B.links[k] === 'function');
  for (const k of ['ABI', 'call', 'multi', 'chunk', 'withRead', 'loadParams', 'loadTokenParams', 'readLive', 'readEpoch', 'refresh',
    'start', 'stop', 'setFallbackProvider', 'probeCodes', 'syncLogs', 'syncAgents', 'decodeLog', 'readImplementation',
    'parseTokenURI', 'walletFromMetadata', 'addrFromSlot', 'shapePortal', 'shapeEvent', 'mergeTimeline', 'anchorFirstEpoch'])
    ok('BAC.chain.' + k, B.chain[k] !== undefined);
  for (const k of ['health', 'summary', 'feed', 'agents', 'agent', 'blocks', 'block', 'tx', 'contracts', 'epochs',
    'epoch', 'leaves', 'proof', 'rate', 'validators', 'treasury', 'bridgeTimeline', 'pull', 'shape', 'run', 'start', 'stop', 'degradedNote', 'layerRpcFallback'])
    ok('BAC.api.' + k, B.api[k] !== undefined);
  ok('BAC.api.pull.bridgeTimeline', typeof B.api.pull.bridgeTimeline === 'function');
  ok('BAC.state.ownerTimeline 骨架', Array.isArray(B.state.ownerTimeline.owner) && Array.isArray(B.state.ownerTimeline.nodeFund));
  for (const k of ['chainStats', 'feed', 'blocks', 'txs', 'agents', 'treasury', 'bridge', 'validators', 'epoch', 'overview',
    'stage', 'token', 'ownerPowers', 'contractStatus', 'tokenStatus'])
    ok('BAC.view.' + k, typeof B.view[k] === 'function');
  for (const k of ['head', 'latestBlocks', 'latestTxs', 'block', 'tx', 'gasPrice', 'peers', 'txpool',
    'send', 'call', 'endpoint', 'run', 'start', 'stop', 'period', 'stats', 'endpoints'])
    ok('BAC.layer.' + k, B.layer[k] !== undefined);
  eq('BAC.LAYER_LIVE 初始为 false', B.LAYER_LIVE, false);
  eq('BAC.HAS_LAYER_RPC', B.HAS_LAYER_RPC, true);
  ok('state.layer.sections 三段', B.state.layer.sections && B.state.layer.sections.head === 'loading');
  for (const k of ['live', 'prelaunch', 'stage', 'contractsLive', 'tokenLive', 'ready', 'loading', 'hidden', 'error', 'warnings', 'bsc', 'indexer', 'layer',
    'feed', 'blocks', 'txs', 'agentList', 'agentDir', 'timeline', 'validators', 'epochs', 'rate'])
    ok('BAC.state.' + k, B.state[k] !== undefined);
  for (const k of ['owner', 'flow', 'nodeFund', 'gaps'])
    ok('BAC.state.timeline.' + k + ' 是数组', Array.isArray(B.state.timeline[k]));
  ok('BAC.state.bsc.code 探针表', B.state.bsc.code && B.state.bsc.code.token === null);

  // 决策 #25a：锚点等待是给自动 watchdog 用的，不是给人用的（旧文案「任何人都能指出它是错的」与之矛盾）
  ok('锚点等待说明不再说「任何人都能指出」', !/任何人都能指出/.test(B.TEXT.ANCHOR_WAIT_NOTE), B.TEXT.ANCHOR_WAIT_NOTE);
  ok('锚点等待说明写明是给 watchdog 用的', /watchdog/.test(B.TEXT.ANCHOR_WAIT_NOTE) && /不是给人用的/.test(B.TEXT.ANCHOR_WAIT_NOTE));
  eq('必须逐字的发射前文案', B.TEXT.PRE, '发射后公布');
  eq('索引器挂但链还活着的文案', B.TEXT.RPC_DIRECT, '索引器读不到：区块与交易改由本站直接读层内节点，历史与搜索暂时不可用');
  eq('必须逐字的读取失败文案', B.TEXT.ERR, '读取失败 · 重试中');
  eq('未锚定文案', B.TEXT.NOT_ANCHORED, '未锚定 · 仅来自官方节点');
  eq('决策 #29a 逐字', B.TEXT.OWNER_POWER, OWNER_NOTICE);
  eq('决策 #31a 逐字', B.TEXT.IDENTITY_LIMIT, '我们要求持有 agent 身份，我们不能证明它是 AI。');
  eq('层内 FeeSplitter 地址', B.LAYER.FEE_SPLITTER, '0x0000000000000000000000000000000000000104');
  eq('层内 L2Bridge 地址', B.LAYER.L2_BRIDGE, '0x0000000000000000000000000000000000000101');
  eq('Multicall3 地址', B.C.MULTICALL3, MC_ADDR);
  eq('ERC-8004 注册表地址', B.C.ERC8004_IDENTITY, REGISTRY);
  eq('Flap Portal 地址', B.C.FLAP_PORTAL, PORTAL);
  eq('ERC1967 实现槽', B.C.ERC1967_IMPL_SLOT, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
  eq('Flap 协议费 1000 bps', B.C.FLAP_FEE_RATE_BPS, 1000);
  eq('层 chainId', B.C.LAYER_CHAIN_ID, 56777);
  eq('纪元 10 分钟（决策 #20，合约 EPOCH = 600）', B.C.EPOCH, 600);
  eq('承诺窗口 0（ChainAnchor.COMMIT_WINDOW）', B.C.COMMIT_WINDOW, 0);
  eq('分账常量 · 官方出块给验证者池', B.C.OFFICIAL_BLOCK_VALIDATOR_BPS, 1000);
  eq('分账常量 · 验证者出块自留', B.C.VALIDATOR_BLOCK_VALIDATOR_BPS, 5000);
  eq('路由分账 50/50', B.C.BRIDGE_BPS, 5000);

  // 配置形状
  eq('chainId', B.CFG.chainId, 56);
  ok('rpcs 是数组', Array.isArray(B.CFG.rpcs) && B.CFG.rpcs.length > 0);
  ok('layerRpc', typeof B.CFG.layerRpc === 'string');
  ok('indexerBase', typeof B.CFG.indexerBase === 'string');
  eq('地址簿只有 v2 的 6 个键', Object.keys(B.CFG.addresses).sort().join(','), 'anchor,bridge,nodeFund,router,staking,token');
  for (const k of ['factory', 'vault', 'registry']) ok('地址簿里没有 v1 的 ' + k, B.CFG.addresses[k] === undefined);
  eq('配了 router + bridge → CONTRACTS_CONFIGURED', B.CONTRACTS_CONFIGURED, true);
  eq('探针回来之前 BAC.LIVE = CONTRACTS_CONFIGURED', B.LIVE, true);
  eq('探针回来之前 CONTRACTS_LIVE = false', B.CONTRACTS_LIVE, false);

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
  const env = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
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
  eq('epochOf 按 600 秒', env.BAC.epochOf(1790000000), 2983333);
  ok('本纪元剩余 ≤ 600 秒', env.BAC.epochLeft() > 0 && env.BAC.epochLeft() <= 600);
  eq('BscScan 事件页链接', env.BAC.links.addressEvents(ADDR.bridge), 'https://bscscan.com/address/' + ADDR.bridge + '#events');
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
  eq('超时会换到第二个 RPC', got, HEAD);
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
  for (let i = 0; i < 200; i++) calls.push(env.BAC.chain.call(ADDR.bridge, 'bridge', 'k' + i, 'bnbBalance'));
  const out = await env.BAC.chain.multi(calls);
  eq('分了 3 块', chain.log.aggregate.length, 3);
  eq('第一块 80 条', chain.log.aggregate[0], 80);
  eq('第二块 80 条', chain.log.aggregate[1], 80);
  eq('最后一块 40 条', chain.log.aggregate[2], 40);
  eq('MC_CHUNK 就是 80', env.BAC.chain.MC_CHUNK, 80);
  eq('全部解出来了（失败表不可枚举）', Object.keys(out).length, 200);
  eq('值是 BigInt', out.k0, 9n * E18);

  // 逐条失败：success === false 的那条是 undefined，别的照常；失败原因记在 __failed
  const chain2 = makeChain(FIXTURES, { failFns: ['owedTotal'] });
  const env2 = makeEnv({ ethers: makeEthers(chain2), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  const out2 = await env2.BAC.chain.multi([
    env2.BAC.chain.call(ADDR.bridge, 'bridge', 'pool', 'bnbBalance'),
    env2.BAC.chain.call(ADDR.bridge, 'bridge', 'owed', 'owedTotal'),
    env2.BAC.chain.call(ADDR.bridge, 'bridge', 'res', 'reservedTotal')
  ]);
  eq('失败那条是 undefined', out2.owed, undefined);
  eq('失败那条记成 revert', out2.__failed.owed, 'revert');
  eq('同批其它条正常', out2.pool, 9n * E18);
  eq('同批第三条正常', out2.res, 1n * E18);

  // getCode 探针失败 → 退回逐条 eth_call
  const chain3 = makeChain(FIXTURES);
  const env3 = makeEnv({ ethers: makeEthers(chain3, { noMulticall: true }), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  const out3 = await env3.BAC.chain.multi([
    env3.BAC.chain.call(ADDR.bridge, 'bridge', 'pool', 'bnbBalance'),
    env3.BAC.chain.call(ADDR.bridge, 'bridge', 'owed', 'owedTotal'),
    env3.BAC.chain.call(REGISTRY, 'identity', 'own99', 'ownerOf', [99])
  ]);
  eq('探针跑了一次', chain3.log.getCode, 1);
  eq('没有用 aggregate3', chain3.log.aggregate.length, 0);
  eq('退路也拿到了数据', out3.pool, 9n * E18);
  eq('退路第二条', out3.owed, 4n * E18);
  eq('退路里的 revert 也记成 revert', out3.__failed.own99, 'revert');
});

/* ══════════════════════════════════════════════════════
   配置：新旧两种形状都能加载（旧的 web/site.config.js 还没换）
   ══════════════════════════════════════════════════════ */
await group('config', async () => {
  // 1. 现在 web/ 里那份真的 site.config.js，原样加载（不管它是新形状还是旧形状）
  const real = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(), rawConfig: true });
  ok('真实 site.config.js 能加载', !!real.BAC && !!real.BAC.CFG);
  eq('真实配置 · 地址簿只有 6 个键', Object.keys(real.BAC.CFG.addresses).sort().join(','), 'anchor,bridge,nodeFund,router,staking,token');
  eq('真实配置 · LIVE 初值 = CONTRACTS_CONFIGURED', real.BAC.LIVE, real.BAC.CONTRACTS_CONFIGURED);
  ok('真实配置 · 视图不抛', (() => { try { real.BAC.view.overview(); real.BAC.view.treasury(); real.BAC.view.bridge(); real.BAC.view.token(); real.BAC.view.ownerPowers(); real.BAC.view.agents({}); return true; } catch (e) { return false; } })());
  eq('真实配置 · 没碰 DOM', real.domHits.length, 0);

  // 2. v1 形状的旧配置：有 factory / vault / registry / guardian / vaultPortal
  const old = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(),
    config: { addresses: OLD_ADDR, guardian: '0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b', vaultPortal: '0x90497450f2a706f1951b5bdda52B4E5d16f34C06' }
  });
  const O = old.BAC;
  eq('旧配置 · vault 顶上 router', O.CFG.addresses.router, ADDR.router);
  ok('旧配置 · 没有 factory 键', O.CFG.addresses.factory === undefined);
  ok('旧配置 · 没有 registry 键', O.CFG.addresses.registry === undefined);
  eq('旧配置 · 记下了 v1 键', O.CFG.legacyKeys.slice().sort().join(','), 'factory,guardian,registry,vault,vaultPortal');
  eq('旧配置 · CFG.vault 是 router 的别名', O.CFG.vault, ADDR.router);
  eq('旧配置 · CONTRACTS_CONFIGURED', O.CONTRACTS_CONFIGURED, true);
  eq('旧配置 · overview 地址簿带 vault 别名', O.view.overview().addresses.vault, ADDR.router);
  eq('旧配置 · overview 地址簿带 ERC-8004 注册表', O.view.overview().addresses.identityRegistry, REGISTRY);
  eq('旧配置 · 注册表默认主网地址', O.CFG.identityRegistry, REGISTRY);
  eq('旧配置 · Portal 默认主网地址', O.CFG.flapPortal, PORTAL);
  deepStage(O);

  // 3. 旧配置全是 0x0（现在线上那份的真实形状）：阶段 none，只问块高
  const zeroChain = makeChain(FIXTURES);
  const zero = makeEnv({
    ethers: makeEthers(zeroChain), fetchImpl: makeFetch(),
    config: BSC_ONLY({ factory: '0x0', vault: '0x0', token: '0x0', bridge: '0x0', nodeFund: '0x0', registry: '0x0', anchor: '0x0', staking: '0x0' })
  });
  eq('全 0 旧配置 · LIVE = false', zero.BAC.LIVE, false);
  eq('全 0 旧配置 · 阶段一开始就确定是 none', zero.BAC.STAGE_KNOWN, true);
  await zero.BAC.chain.refresh({ reason: 'test' });
  eq('全 0 旧配置 · 只问了块高', zeroChain.log.getBlockNumber, 1);
  eq('全 0 旧配置 · 没有 eth_call', zeroChain.log.calls.length, 0);
  eq('全 0 旧配置 · 没探任何地址的代码', zeroChain.log.codeFor.length, 0);
  eq('全 0 旧配置 · 路由视图 pre', zero.BAC.view.treasury().status, 'pre');
  eq('全 0 旧配置 · 代币视图 pre', zero.BAC.view.token().status, 'pre');
  eq('全 0 旧配置 · 代币地址 null', zero.BAC.view.token().address, null);

  // 4. 乱写的配置不许让页面崩掉
  const junk = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(), config: { addresses: { router: 123, bridge: null, token: 'nope' } } });
  eq('乱写配置 · router 当没配', junk.BAC.CFG.addresses.router, '0x0');
  eq('乱写配置 · token 原样保留但不算地址', junk.BAC.TOKEN_CONFIGURED, false);
  eq('乱写配置 · CONTRACTS_CONFIGURED = false', junk.BAC.CONTRACTS_CONFIGURED, false);
  const junk2 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(), config: { addresses: null } });
  eq('addresses: null 也能加载', Object.keys(junk2.BAC.CFG.addresses).length, 6);

  // rpcs 写成字符串：以前 .slice() 还是字符串，withRead 的 list.forEach 同步抛出，整个 BSC 刷新停摆且不再排下一轮
  const sch = makeChain(FIXTURES);
  const sEnv = makeEnv({ ethers: makeEthers(sch), fetchImpl: makeFetch(),
    config: { addresses: ADDR, rpcs: 'https://rpc-a.test', logRpcs: 'https://logs.test', indexerBase: '', fallbackApi: '', layerRpc: '', fallbackRpc: '', pollMs: 999999, prelaunchPollMs: 999999 } });
  ok('rpcs 是字符串 → 当成一个的数组', Array.isArray(sEnv.BAC.CFG.rpcs) && sEnv.BAC.CFG.rpcs.join() === 'https://rpc-a.test');
  ok('logRpcs 是字符串 → 当成一个的数组', Array.isArray(sEnv.BAC.CFG.logRpcs) && sEnv.BAC.CFG.logRpcs.join() === 'https://logs.test');
  let sThrew = null;
  try { await sEnv.BAC.chain.refresh({ reason: 'test' }); } catch (e) { sThrew = e; }
  eq('rpcs 是字符串 · refresh 不抛', sThrew, null);
  eq('rpcs 是字符串 · 照常读到数', sEnv.BAC.view.bridge().owner, OWNER);
  const nEnv = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(),
    config: { addresses: ADDR, rpcs: 123, pollMs: 999999, prelaunchPollMs: 999999 } });
  eq('rpcs 是数字 → 空数组', nEnv.BAC.CFG.rpcs.length, 0);
  let nThrew = null;
  try { await nEnv.BAC.chain.refresh({ reason: 'test' }); } catch (e) { nThrew = e; }
  eq('rpcs 乱写 · refresh 不抛', nThrew, null);
  eq('rpcs 乱写 · 报「没有配置 RPC 地址」', nEnv.BAC.state.bsc.error, nEnv.BAC.TEXT.NO_RPC);
  ok('rpcs 乱写 · 仍然排了下一轮', nEnv.timers.length > 0);
  const mixed = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(),
    config: { rpcs: ['https://bsc-dataseed.bnbchain.org', '', null, 'https://bsc-rpc.publicnode.com'], logRpcs: undefined } });
  eq('rpcs 里的空串 / null 被丢掉', mixed.BAC.CFG.rpcs.join(','), 'https://bsc-dataseed.bnbchain.org,https://bsc-rpc.publicnode.com');
  eq('没写 logRpcs → 不拿 bsc-dataseed 扫日志（它回 -32005）', mixed.BAC.CFG.logRpcs.join(','), 'https://bsc-rpc.publicnode.com');
  const custom = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(),
    config: { rpcs: ['https://bsc-dataseed1.binance.org', 'https://my-node.example/rpc'], logRpcs: undefined } });
  eq('没写 logRpcs → 自己的节点照样可以扫日志', custom.BAC.CFG.logRpcs.join(','), 'https://my-node.example/rpc');

  // 5. 拟换上的新配置（artifacts/data-check/site.config.proposed.js）
  if (!PROPOSED_CFG) { ok('拟换上的配置文件存在', false); return; }
  const pc = makeChain(FIXTURES);
  const prop = makeEnv({
    ethers: makeEthers(pc, { code: { [lc(REAL_TOKEN)]: '0x' } }), fetchImpl: makeFetch(),
    siteConfig: 'proposed', rawConfig: true
  });
  const P = prop.BAC;
  eq('新配置 · 代币地址（决策 #35）', P.CFG.addresses.token, REAL_TOKEN);
  eq('新配置 · 其余地址都是 0x0', ['router', 'bridge', 'nodeFund', 'anchor', 'staking'].map(k => P.CFG.addresses[k]).join(','), '0x0,0x0,0x0,0x0,0x0');
  eq('新配置 · 没有 v1 键', P.CFG.legacyKeys.length, 0);
  eq('新配置 · eth_call 先走 bsc-dataseed', P.CFG.rpcs[0], 'https://bsc-dataseed.bnbchain.org');
  eq('新配置 · 日志只走 publicnode', P.CFG.logRpcs.join(','), 'https://bsc-rpc.publicnode.com');
  eq('新配置 · 显式演练链', P.CFG.rehearsal, true);
  eq('新配置 · deployBlock 未知', P.CFG.deployBlock, 0);
  eq('新配置 · 注册表', P.CFG.identityRegistry, REGISTRY);
  eq('新配置 · Portal', P.CFG.flapPortal, PORTAL);
  eq('新配置 · LIVE 初值 false（只有代币地址）', P.LIVE, false);
  eq('新配置 · 地址簿显示 CA', P.view.overview().addresses.token, REAL_TOKEN);
  eq('新配置 · 探针回来之前代币是 loading', P.view.token().status, 'loading');
  await P.chain.refresh({ reason: 'test' });
  eq('新配置 · 探了代币地址的代码', pc.log.codeFor.join(','), lc(REAL_TOKEN));
  eq('新配置 · 代币还没发射', P.TOKEN_LIVE, false);
  eq('新配置 · 阶段 none', P.STAGE, 'none');
  eq('新配置 · 代币视图 pre', P.view.token().status, 'pre');
  eq('新配置 · 代币视图仍给出 CA', P.view.token().address, REAL_TOKEN);
  eq('新配置 · 代币视图说明还没发射', P.view.token().note, P.TEXT.TOKEN_NOT_LAUNCHED);
  eq('新配置 · 没有 eth_call', pc.log.calls.length, 0);
});

/** 旧配置 + 全部有代码 → 探针之后是 launched，读的是 router 不是 vault */
function deepStage(O) { ok('旧配置 · 视图不抛', (() => { try { O.view.treasury(); O.view.bridge(); O.view.agents({}); return true; } catch (e) { return false; } })()); }

/* ══════════════════════════════════════════════════════
   三阶段：(a) 什么都没部署 (b) 合约部署了、代币没发射 (c) 代币发射了
   ══════════════════════════════════════════════════════ */
await group('stages', async () => {
  /* ── (a) 只有代币地址，地址上没有代码 ── */
  let launched = false;
  const ca = makeChain(FIXTURES);
  const a = makeEnv({
    ethers: makeEthers(ca, { code: { [lc(ADDR.token)]: () => (launched ? '0x6080' : '0x') } }),
    fetchImpl: makeFetch(),
    config: BSC_ONLY({ token: ADDR.token, router: '0x0', bridge: '0x0', nodeFund: '0x0', anchor: '0x0', staking: '0x0' }, { codeProbeMs: 10000 })
  });
  const A = a.BAC;
  let stageEvents = [];
  A.on('stage', s => stageEvents.push(s));
  eq('(a) 探针前 STAGE_KNOWN = false', A.STAGE_KNOWN, false);
  eq('(a) 探针前代币 loading（不是 pre）', A.view.token().status, 'loading');
  eq('(a) 合约没配 → 路由 pre', A.view.treasury().status, 'pre');
  await A.chain.refresh({ reason: 'test' });
  eq('(a) 阶段 none', A.STAGE, 'none');
  eq('(a) STAGE_KNOWN', A.STAGE_KNOWN, true);
  eq('(a) TOKEN_LIVE = false', A.TOKEN_LIVE, false);
  eq('(a) CONTRACTS_LIVE = false', A.CONTRACTS_LIVE, false);
  eq('(a) LIVE = false', A.LIVE, false);
  eq('(a) state.stage', A.state.stage, 'none');
  eq('(a) 只探了代币地址', ca.log.codeFor.join(','), lc(ADDR.token));
  eq('(a) 只问了块高', ca.log.getBlockNumber, 1);
  eq('(a) 没有任何 eth_call', ca.log.calls.length, 0);
  eq('(a) 没有 eth_getLogs', ca.log.getLogs, 0);
  eq('(a) 代币 pre', A.view.token().status, 'pre');
  eq('(a) 代币价格 null', A.view.token().portal, null);
  eq('(a) 桥 pre', A.view.bridge().status, 'pre');
  eq('(a) owner 权力 pre', A.view.ownerPowers().status, 'pre');
  eq('(a) agent 名录 pre', A.view.agents({}).status, 'pre');
  eq('(a) stage 视图', A.view.stage().stage, 'none');
  eq('(a) 广播了 stage 事件', stageEvents.length, 1);
  ok('(a) 下一轮最迟 codeProbeMs 醒来复探', a.timers.length > 0 && a.timers[a.timers.length - 1].ms <= 10000, JSON.stringify(a.timers.map(t => t.ms)));
  // 紧接着再刷一次：还没到复探时间，不再打 getCode
  await A.chain.refresh({ reason: 'test' });
  eq('(a) 复探有节流', ca.log.codeFor.length, 1);
  // 发射当天：地址上有代码了 → 不用改配置、不用重新部署网站，页面自己翻过来
  launched = true;
  await A.chain.refresh({ reason: 'test', forceProbe: true });
  eq('(a→c) 发射后 TOKEN_LIVE = true', A.TOKEN_LIVE, true);
  eq('(a→c) 阶段 launched', A.STAGE, 'launched');
  eq('(a→c) LIVE = true', A.LIVE, true);
  eq('(a→c) 代币视图 ok', A.view.token().status, 'ok');
  eq('(a→c) 代币 symbol', A.view.token().symbol, 'BAC');
  eq('(a→c) 合约还是 pre（没配）', A.view.treasury().status, 'pre');
  // 代码一旦探到就缓存：之后不再探
  const probes = ca.log.codeFor.length;
  await A.chain.refresh({ reason: 'test', forceProbe: true });
  eq('(a→c) 探到代码后不再复探', ca.log.codeFor.length, probes);

  /* ── (b) 合约部署了（有代码），代币没发射 ── */
  const cb = makeChain(FIXTURES_DEPLOYED);
  const b = makeEnv({
    ethers: makeEthers(cb, { code: { [lc(ADDR.token)]: '0x' } }),
    fetchImpl: makeFetch(), config: BSC_ONLY(ADDR)
  });
  const Bb = b.BAC;
  eq('(b) 探针前合约 loading', Bb.view.treasury().status, 'loading');
  await Bb.chain.refresh({ reason: 'test' });
  eq('(b) 阶段 deployed', Bb.STAGE, 'deployed');
  eq('(b) CONTRACTS_LIVE', Bb.CONTRACTS_LIVE, true);
  eq('(b) TOKEN_LIVE = false', Bb.TOKEN_LIVE, false);
  eq('(b) LIVE = true（合约的真实状态要显示）', Bb.LIVE, true);
  const tb = Bb.view.treasury();
  eq('(b) 路由视图 ok', tb.status, 'ok');
  eq('(b) 路由累计进桥池是真的 0（不是 null）', tb.lifetimeToBridge, 0n);
  eq('(b) 路由余额是真的 0', tb.routerBalance, 0n);
  eq('(b) 节点基金余额是真的 0', tb.nodeFundBalance, 0n);
  eq('(b) 协议费基数还不知道（代币没发射）', tb.taxFeeRateBps, null);
  eq('(b) 待分发税 null（TaxProcessor 还不存在）', tb.pendingTax, null);
  eq('(b) 路由视图的代币段 pre', tb.tokenStatus, 'pre');
  const bb = Bb.view.bridge();
  eq('(b) 桥视图 ok', bb.status, 'ok');
  eq('(b) 桥 owner 是真的', bb.owner, OWNER);
  eq('(b) 升级 0 次是真的', bb.upgradeCount, 0);
  eq('(b) 紧急提取 0 次是真的', bb.emergencyCount, 0);
  eq('(b) 锁仓是真的 0', bb.lockedBac, 0n);
  eq('(b) 桥里的 BAC 余额 null（代币没发射，读不了）', bb.bacHeld, null);
  eq('(b) shortfall() revert → 自己推', bb.shortfall.source, 'derived');
  eq('(b) 推出来的 BNB 缺口 0', bb.shortfall.bnb, 0n);
  eq('(b) 账面 0 且代币不存在 → BAC 缺口确定是 0', bb.shortfall.bac, 0n);
  eq('(b) 实现合约来自 ERC1967 槽', bb.implementation, IMPL2);
  eq('(b) 读的是 ERC1967 实现槽', cb.log.lastSlot, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
  eq('(b) 代币视图 pre', Bb.view.token().status, 'pre');
  eq('(b) 代币视图仍给 CA', Bb.view.token().address, ADDR.token);
  const opb = Bb.view.ownerPowers();
  eq('(b) owner 权力视图 ok', opb.status, 'ok');
  eq('(b) 时间线 ok', opb.timelineStatus, 'ok');
  eq('(b) 时间线是空的（真的没有过）', opb.items.length, 0);
  eq('(b) 计数器对得上 → 升级/提取没有缺', opb.upgradesAndWithdrawalsComplete, true);
  const agb = Bb.view.agents({});
  eq('(b) agent 名录 ok', agb.status, 'ok');
  eq('(b) agent 0 个是真的', agb.total, 0);
  eq('(b) 存入 0 笔', agb.depositsTotal, 0);
  ok('(b) 没读代币的任何函数', !cb.log.calls.some(fn => ['name', 'symbol', 'taxProcessor', 'getTokenV8Safe', 'balanceOf', 'marketQuoteBalance'].includes(fn)), cb.log.calls.join(','));
  ok('(b) 没有 shortfall 告警', !Bb.state.warnings.includes('bridge_shortfall'));
  // 锚点：构造函数的占位值不许冒充成一个上报过 / 定案过的锚点
  const epb = Bb.view.epoch();
  eq('(b) 锚点 · firstEpoch 读到了', epb.firstEpoch, E0);
  eq('(b) 锚点 · lastPostedEpoch 是占位 e0−1 → null（还没上报过）', epb.lastPosted, null);
  eq('(b) 锚点 · lastFinalEpoch 是 0 → null', epb.lastFinal, null);
  eq('(b) 锚点 · lastFinalAt 是部署时间，不是「上次定案时间」→ null', epb.lastFinalAt, null);
  eq('(b) 锚点 · 部署时间另作停机计时起点', epb.haltClockFrom, DEPLOY_TS);
  eq('(b) 锚点 · 没有锚点详情', epb.anchor, null);
  eq('(b) 锚点 · 没有锚点状态', epb.state, null);
  eq('(b) 链指标 · lastPostedEpoch null', Bb.view.chainStats().lastPostedEpoch, null);
  eq('(b) 链指标 · lastFinalEpoch null', Bb.view.chainStats().lastFinalEpoch, null);
  ok('(b) 没去读 e0−1 那个空锚点', !cb.log.calls.includes('getAnchor') && !cb.log.calls.includes('dayReward'), cb.log.calls.join(','));
  // 0 占位：时间戳 0 = 从来没有过，汇率 0 = 没有汇率
  eq('(b) 从没升级过 → lastUpgradeAt null（不是 1970）', bb.lastUpgradeAt, null);
  eq('(b) 从没提取过 → lastEmergencyAt null', bb.lastEmergencyAt, null);
  eq('(b) 从没暂停过 → pausedUntil null', bb.pausedUntil, null);
  eq('(b) 累计暂停 0 秒是真的 0', Bb.state.bsc.bridge.pausedCumulativeSec, 0);
  eq('(b) 没武装过逃生 → escapeArmedAt null', bb.escapeArmedAt, null);
  eq('(b) 没有在外积分 → 汇率 null（不是 0 BAC）', bb.bacPerCredit, null);
  eq('(b) 旧键 weiPerCredit 同样 null', bb.weiPerCredit, null);
  eq('(b) 从没释放过 → lastPot null', bb.lastPot, null);
  eq('(b) 从没释放过 → lastPotBps null', bb.lastPotBps, null);
  eq('(b) 从没释放过 → lastPotSettledAt null', Bb.state.bsc.bridge.lastPotSettledAt, null);
  eq('(b) owner 视图 · lastUpgradeAt null', opb.lastUpgradeAt, null);
  eq('(b) owner 视图 · lastEmergencyAt null', opb.lastEmergencyAt, null);
  eq('(b) 升级 0 次仍然是真的 0', opb.upgradeCount, 0);

  /* ── (b) 但 firstEpoch 那一条没读到：只信锚点记录自己（postedAt > 0 才算上报过）── */
  const cbf = makeChain(Object.assign({}, FIXTURES_DEPLOYED, { firstEpoch: undefined }));
  const bf = makeEnv({ ethers: makeEthers(cbf, { code: { [lc(ADDR.token)]: '0x' } }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await bf.BAC.chain.refresh({ reason: 'test' });
  eq('(b) firstEpoch 读不到 · 占位的 e0−1 的锚点是空的 → null', bf.BAC.view.epoch().lastPosted, null);
  eq('(b) firstEpoch 读不到 · lastFinalEpoch 0 → null', bf.BAC.view.epoch().lastFinal, null);
  eq('(b) firstEpoch 读不到 · lastFinalAt null', bf.BAC.view.epoch().lastFinalAt, null);
  eq('(b) firstEpoch 读不到 · 锚点详情 null', bf.BAC.view.epoch().anchor, null);

  /* ── (b) 第一个锚点上报之后：lastPostedEpoch = firstEpoch，照实显示 ── */
  const POSTED_ANCHOR = FIXTURES.getAnchor[0];
  const cb2 = makeChain(Object.assign({}, FIXTURES_DEPLOYED, { lastPostedEpoch: [E0], getAnchor: (args) => Number(args[0]) === E0 ? [POSTED_ANCHOR] : [EMPTY_ANCHOR] }));
  const b2 = makeEnv({ ethers: makeEthers(cb2, { code: { [lc(ADDR.token)]: '0x' } }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await b2.BAC.chain.refresh({ reason: 'test' });
  eq('(b) 第一个锚点 · lastPosted = firstEpoch', b2.BAC.view.epoch().lastPosted, E0);
  eq('(b) 第一个锚点 · 状态 POSTED', b2.BAC.view.epoch().state, 'POSTED');
  eq('(b) 第一个锚点 · 还没定案 → lastFinal null', b2.BAC.view.epoch().lastFinal, null);
  eq('(b) 第一个锚点 · 读的就是 e0 那个锚点', b2.BAC.view.epoch().anchor.postedAt, 1789995000);

  /* ── 接线核对：配置里没填的地址（'0x0'）不许拉响「税进错地方」的假警报 ── */
  const cw = makeChain(FIXTURES);
  const w = makeEnv({
    ethers: makeEthers(cw, { code: { [lc(ADDR.token)]: '0x' } }), fetchImpl: makeFetch(),
    config: BSC_ONLY({ token: '0x0', router: ADDR.router, bridge: ADDR.bridge, nodeFund: '0x0', anchor: '0x0', staking: '0x0' })
  });
  await w.BAC.chain.refresh({ reason: 'test' });
  eq('只填了 router + bridge · 接线核对通过', w.BAC.view.bridge().wiring.ok, true);
  eq('只填了 router + bridge · 没有对不上的项', w.BAC.view.bridge().wiring.mismatches.length, 0);
  ok('只填了 router + bridge · 没有 wiring_mismatch 告警', !w.BAC.state.warnings.includes('wiring_mismatch'), w.BAC.state.warnings.join(','));
  eqAddr('只填了 router + bridge · 桥的回购外盘 = PancakeSwap V2 Router', w.BAC.view.bridge().dexRouter, PANCAKE);
  eq('只填了 router + bridge · 没有没核对的项', w.BAC.view.bridge().wiring.unchecked.length, 0);
  // BacBridge.router() 是 PancakeSwap V2 Router：真部署（阶段 b）读回来就是它，不许报「税进错地方」
  const cw1 = makeChain(FIXTURES_DEPLOYED);
  const w1 = makeEnv({ ethers: makeEthers(cw1, { code: { [lc(ADDR.token)]: '0x' } }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await w1.BAC.chain.refresh({ reason: 'test' });
  eq('(b) 真部署 · 桥的 router() 是 Pancake → 接线核对通过', w1.BAC.view.bridge().wiring.ok, true);
  ok('(b) 真部署 · 没有 wiring_mismatch 假警报', !w1.BAC.state.warnings.includes('wiring_mismatch'), w1.BAC.state.warnings.join(','));
  ok('(b) 真部署 · 不再拿桥的 router() 和 BacTaxRouter 比', !w1.BAC.view.bridge().wiring.mismatches.includes('bridge.router'));
  eqAddr('(b) 真部署 · 桥的回购外盘暴露为 dexRouter', w1.BAC.view.bridge().dexRouter, PANCAKE);
  eqAddr('overview 地址簿带 Pancake 路由', w1.BAC.view.overview().addresses.pancakeRouter, PANCAKE);
  // 真对不上的还是要报：桥的回购外盘不是 Pancake
  const cw2 = makeChain(Object.assign({}, FIXTURES, { router: (args, target) => lc(target) === lc(ADDR.bridge) ? [OTHER] : undefined }));
  const w2 = makeEnv({
    ethers: makeEthers(cw2, { code: { [lc(ADDR.token)]: '0x' } }), fetchImpl: makeFetch(),
    config: BSC_ONLY({ token: '0x0', router: ADDR.router, bridge: ADDR.bridge, nodeFund: '0x0', anchor: '0x0', staking: '0x0' })
  });
  await w2.BAC.chain.refresh({ reason: 'test' });
  ok('桥的回购外盘不是 Pancake → 报 bridge.dexRouter', w2.BAC.view.bridge().wiring.mismatches.join() === 'bridge.dexRouter', w2.BAC.view.bridge().wiring.mismatches.join());
  ok('桥的回购外盘不对 → 告警', w2.BAC.state.warnings.includes('wiring_mismatch'));
  // 配置可以覆盖外盘地址（测试网）
  const w3 = makeEnv({
    ethers: makeEthers(makeChain(Object.assign({}, FIXTURES, { router: (args, target) => lc(target) === lc(ADDR.bridge) ? [OTHER] : undefined })), { code: { [lc(ADDR.token)]: '0x' } }),
    fetchImpl: makeFetch(), config: BSC_ONLY(ADDR, { pancakeRouter: OTHER })
  });
  await w3.BAC.chain.refresh({ reason: 'test' });
  eq('配置覆盖 pancakeRouter → 按它核对', w3.BAC.view.bridge().wiring.ok, true);
  // 桥的 router() 读回零地址（未初始化的代理就是这样）= 对不上，不是「没法核对」
  const w4 = makeEnv({
    ethers: makeEthers(makeChain(Object.assign({}, FIXTURES, { router: (args, target) => lc(target) === lc(ADDR.bridge) ? [ZERO] : undefined })), { code: { [lc(ADDR.token)]: '0x' } }),
    fetchImpl: makeFetch(), config: BSC_ONLY(ADDR)
  });
  await w4.BAC.chain.refresh({ reason: 'test' });
  ok('读回零地址 → 对不上', w4.BAC.view.bridge().wiring.mismatches.includes('bridge.dexRouter'), w4.BAC.view.bridge().wiring.mismatches.join());
  // 路由那一侧照旧核对：路由指向别的桥
  const w5 = makeEnv({ ethers: makeEthers(makeChain(Object.assign({}, FIXTURES_DEPLOYED, { bridge: [OTHER] })), { code: { [lc(ADDR.token)]: '0x' } }),
    fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await w5.BAC.chain.refresh({ reason: 'test' });
  ok('路由的 bridge() 仍然和配置的桥比', w5.BAC.view.bridge().wiring.mismatches.join() === 'router.bridge', w5.BAC.view.bridge().wiring.mismatches.join());
  // 代币发射了、配置里 router 还没填：marketAddress 没法核对 → null，不是 false，也不告警
  const cm = makeChain(FIXTURES);
  const m = makeEnv({ ethers: makeEthers(cm), fetchImpl: makeFetch(),
    config: BSC_ONLY({ token: ADDR.token, router: '0x0', bridge: '0x0', nodeFund: '0x0', anchor: '0x0', staking: '0x0' }) });
  await m.BAC.chain.refresh({ reason: 'test' });
  eq('router 没填 · 代币已发射', m.BAC.STAGE, 'launched');
  eq('router 没填 · marketAddressOk = null（没法核对）', m.BAC.view.token().marketAddressOk, null);
  ok('router 没填 · 没有 market_address_mismatch 告警', !m.BAC.state.warnings.includes('market_address_mismatch'));

  /* ── (a) 索引器回了 0 个 agent：状态是 pre，数字也必须是 null（页面先看数字再看状态） ── */
  const ca2 = makeChain(FIXTURES);
  const a2 = makeEnv({
    ethers: makeEthers(ca2, { code: { [lc(ADDR.token)]: '0x' } }),
    fetchImpl: makeFetch({ bodies: {
      '/api/agents': { schema: 'bac/agents/2', total: 0, page: 1, pageSize: 50, items: [] },
      '/api/summary': Object.assign({}, API_BODY['/api/summary'], { agents: { total: 0 } })
    } }),
    config: Object.assign(BSC_ONLY({ token: ADDR.token, router: '0x0', bridge: '0x0', nodeFund: '0x0', anchor: '0x0', staking: '0x0' }),
      { indexerBase: 'https://indexer.test' })
  });
  await a2.BAC.chain.refresh({ reason: 'test' });
  await a2.BAC.api.run({ once: true });
  const ag2 = a2.BAC.view.agents({});
  eq('(a) 索引器回 0 · 名录 pre', ag2.status, 'pre');
  eq('(a) 索引器回 0 · total null（不是 0）', ag2.total, null);
  eq('(a) 索引器回 0 · counts null', ag2.counts, null);
  eq('(a) 索引器回 0 · 没有条目', ag2.items.length, 0);
  // 演练用的索引器即使回了条目，阶段 (a) 也不许拿来当真的 agent
  const a3 = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES), { code: { [lc(ADDR.token)]: '0x' } }), fetchImpl: makeFetch(),
    config: Object.assign(BSC_ONLY({ token: ADDR.token, router: '0x0', bridge: '0x0', nodeFund: '0x0', anchor: '0x0', staking: '0x0' }),
      { indexerBase: 'https://indexer.test' })
  });
  await a3.BAC.chain.refresh({ reason: 'test' });
  await a3.BAC.api.run({ once: true });
  eq('(a) 索引器有条目 · 名录仍然 pre', a3.BAC.view.agents({}).status, 'pre');
  eq('(a) 索引器有条目 · 不列出来', a3.BAC.view.agents({}).items.length, 0);
  eq('(a) 索引器有条目 · total null', a3.BAC.view.agents({}).total, null);
  eq('(a) 什么都没部署 · 不去问 owner 时间线', a3.BAC.state.ownerTimeline.ready, false);

  /* ── (b') 配了地址、链上却没代码 → 当成还没部署，并告警 ── */
  const cn = makeChain(FIXTURES);
  const n = makeEnv({
    ethers: makeEthers(cn, { code: { [lc(ADDR.token)]: '0x', [lc(ADDR.router)]: '0x', [lc(ADDR.bridge)]: '0x' } }),
    fetchImpl: makeFetch(), config: BSC_ONLY(ADDR)
  });
  await n.BAC.chain.refresh({ reason: 'test' });
  eq("(b') 阶段 none", n.BAC.STAGE, 'none');
  eq("(b') 路由视图 pre", n.BAC.view.treasury().status, 'pre');
  ok("(b') 告警 contracts_no_code", n.BAC.state.warnings.includes('contracts_no_code'));
  eq("(b') 没有 eth_call", cn.log.calls.length, 0);

  /* ── (c) 全部有代码 ── */
  const cc = makeChain(FIXTURES);
  const c = makeEnv({ ethers: makeEthers(cc), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  const Cc = c.BAC;
  await Cc.chain.refresh({ reason: 'test' });
  eq('(c) 阶段 launched', Cc.STAGE, 'launched');
  const tk = Cc.view.token();
  eq('(c) 代币视图 ok', tk.status, 'ok');
  eq('(c) symbol', tk.symbol, 'BAC');
  eq('(c) 协议费来自 feeConfigV2().feeRate', tk.taxFeeRateBps, 1000);
  eq('(c) marketAddress 指向路由', tk.marketAddressOk, true);
  eq('(c) Portal 状态', tk.portal.statusName, 'Tradable');
  eq('(c) Portal 中文状态', tk.portal.statusZh, '内盘交易中');
  eq('(c) 价格（BNB/BAC，18 位定点）', tk.portal.price, 2000000000n);
  eq('(c) 进度', tk.portal.progress, 400000000000000000n);
  eq('(c) 待分发税', tk.pendingTax, 30000000000000000n);
  eq('(c) 累计进路由的税', tk.lifetimeTaxToRouter, 27n * E18);
  eq('(c) 桥里真实的 BAC', tk.bridgeBac, 4n * E18);
  ok('(c) 50/50 基数写清楚了', /10000 − 1000/.test(Cc.view.treasury().splitBaseNote), Cc.view.treasury().splitBaseNote);
  eq('(c) shortfall 来自合约', Cc.view.bridge().shortfall.source, 'contract');
  eq('(c) 代币参数读了 Portal', cc.log.calls.includes('getTokenV8Safe'), true);

  // marketAddress 对不上 → 告警
  const bad = makeEnv({
    ethers: makeEthers(makeChain(Object.assign({}, FIXTURES, { marketAddress: [ZERO] }))),
    fetchImpl: makeFetch(), config: BSC_ONLY(ADDR)
  });
  await bad.BAC.chain.refresh({ reason: 'test' });
  eq('marketAddress 不匹配', bad.BAC.view.token().marketAddressOk, false);
  ok('marketAddress 不匹配会告警', bad.BAC.state.warnings.includes('market_address_mismatch'));
  eq('全程没有碰 DOM', a.domHits.length + b.domHits.length + c.domHits.length, 0);
});

/* ══════════════════════════════════════════════════════
   BacTaxRouter：路由读数 + 税收流向时间线
   ══════════════════════════════════════════════════════ */
await group('router', async () => {
  const T1 = '0x' + 'f1'.repeat(32), T2 = '0x' + 'f2'.repeat(32), T3 = '0x' + 'f3'.repeat(32);
  const logs = [
    mkLog(ADDR.router, HEAD - 50, T1, 0, 'RevenueRecognized', { from: PROC, amount: 900000000000000000n }),
    mkLog(ADDR.router, HEAD - 40, T2, 3, 'RevenueSplit', { toBridge: 450000000000000000n, toNodeFund: 450000000000000000n }),
    mkLog(ADDR.bridge, HEAD - 40, T2, 4, 'ReleaseReceived', { from: ADDR.router, amount: 450000000000000000n, bnbAfter: 9n * E18 }),
    mkLog(ADDR.router, HEAD - 40, T2, 5, 'PushSucceeded', { to: ADDR.bridge, amount: 450000000000000000n }),
    mkLog(ADDR.router, HEAD - 40, T2, 6, 'PushFailed', { to: ADDR.nodeFund, amount: 450000000000000000n }),
    mkLog(ADDR.nodeFund, HEAD - 30, T3, 0, 'Withdrawn', { to: OWNER, amount: 1n * E18, balanceAfter: 0n }),
    mkLog('0x' + '12'.repeat(20), HEAD - 20, T3, 1, 'RevenueSplit', { toBridge: 1n, toNodeFund: 1n })   // 别人的合约：过滤掉
  ];
  const ch = makeChain(FIXTURES);
  const beh = { logs };
  const env = makeEnv({ ethers: makeEthers(ch, beh), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  const B = env.BAC;
  await B.chain.refresh({ reason: 'test' });

  const t = B.view.treasury();
  eq('路由视图 ok', t.status, 'ok');
  eq('路由余额（solvency.balance）', t.routerBalance, 500000000000000000n);
  eq('vaultBalance 是 routerBalance 的旧名', t.vaultBalance, t.routerBalance);
  eq('路由已记账', t.routerAccounted, 500000000000000000n);
  eq('路由未分账', t.routerUnsplit, 500000000000000000n);
  eq('vaultUnsplit 是旧名', t.vaultUnsplit, t.routerUnsplit);
  eq('路由三桶（solvency.buckets）', t.routerBuckets, 500000000000000000n);
  eq('累计进桥池', t.lifetimeToBridge, 12n * E18);
  eq('累计进节点基金', t.lifetimeToNodeFund, 12n * E18);
  eq('两桶相加', t.lifetimeTotal, 24n * E18);
  eq('累计认账', t.totalRecognized, 24n * E18 + 500000000000000000n);
  eq('卡住的桥池份额', t.stuckBridge, 0n);
  eq('卡住的节点基金份额', t.stuckNodeFund, 0n);
  eq('桥池 50%（合约常量）', t.bridgeBps, 5000);
  eq('节点基金 50%', t.nodeFundBps, 5000);
  eq('桥的 BNB 账', t.poolBalance, 9n * E18);
  eq('桥地址上真实 BNB（Multicall3.getEthBalance）', t.bridgeBnbHeld, 9n * E18);
  eq('节点基金余额', t.nodeFundBalance, 400000000000000000n);
  eq('节点基金已提', t.nodeFundWithdrawn, 11600000000000000000n);
  eq('节点基金 owner', t.nodeFundOwner, OWNER);
  eq('路由没有 owner', t.routerOwner, null);
  eq('旧键 vaultOwner = null', t.vaultOwner, null);
  ok('披露是决策 #29a 那句', t.disclosure.startsWith(OWNER_NOTICE), t.disclosure);
  ok('披露里没有「owner 动不了桥池」这种假话', !/不属于 owner|没有任何路径/.test(t.disclosure));
  eq('接线核对通过', t.wiring.ok, true);
  ok('没读 vault 的任何东西', !ch.log.calls.includes('taxToken'));

  // 时间线：只扫最近窗口，走日志 RPC
  eq('日志只走 logRpcs', ch.log.logUrls.every(u => u === 'https://logs.test'), true);
  eq('首轮只扫最近 5000 块', ch.log.logRanges[0][0], HEAD - 4999);
  eq('扫到链头', ch.log.logRanges[0][1], HEAD);
  const flow = t.flow;
  eq('流向时间线条数（别人的合约过滤掉）', flow.length, 5);
  eq('按新到旧排', flow[0].kind, 'push');
  eq('推送失败记成 ok=false', flow[0].ok, false);
  eq('推送失败的目标是节点基金', flow[0].target, 'nodeFund');
  eq('推送成功的目标是桥', flow[1].target, 'bridge');
  eq('桥收到', flow[2].kind, 'bridgeReceived');
  eq('分账', flow[3].kind, 'split');
  eq('分账 · 桥那一半', flow[3].toBridge, 450000000000000000n);
  eq('认账', flow[4].kind, 'recognized');
  eq('认账金额', flow[4].amount, 900000000000000000n);
  eq('没有时间戳的条目用块时间补上', flow[4].ts, HEAD_TS - 50);
  eq('交易哈希', flow[4].tx, T1);
  eq('节点基金时间线', t.nodeFundEvents.length, 1);
  eq('节点基金提取', t.nodeFundEvents[0].kind, 'withdraw');
  eq('节点基金提取金额', t.nodeFundEvents[0].amount, 1n * E18);
  eq('没配 deployBlock → 时间线不算全量', t.timelineComplete, false);

  // 第二轮只扫新块，不重复
  const before = flow.length;
  await B.chain.refresh({ reason: 'test' });
  eq('链头没动 → 不再打 eth_getLogs', ch.log.getLogs, 1);
  beh.headNumber = HEAD + 10;
  await B.chain.refresh({ reason: 'test' });
  eq('第二轮从 syncedTo+1 开始', ch.log.logRanges[1] && ch.log.logRanges[1][0], HEAD + 1);
  eq('第二轮扫到新链头', ch.log.logRanges[1] && ch.log.logRanges[1][1], HEAD + 10);
  eq('不重复加条目', B.view.treasury().flow.length, before);

  // 日志 RPC 挂了：时间线报错，但路由读数照常是真的
  const ch2 = makeChain(FIXTURES);
  const env2 = makeEnv({ ethers: makeEthers(ch2, { logsFail: true }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await env2.BAC.chain.refresh({ reason: 'test' });
  eq('日志挂了 → 时间线 error', env2.BAC.view.treasury().timelineStatus, 'error');
  eq('日志挂了 → 路由视图仍然 ok', env2.BAC.view.treasury().status, 'ok');
  eq('日志挂了 → 数字仍然是真的', env2.BAC.view.treasury().lifetimeToBridge, 12n * E18);

  // 接线错了（路由指向了别的桥）→ 告警并指出哪一处
  const ch3 = makeChain(Object.assign({}, FIXTURES, { bridge: [OTHER] }));
  const env3 = makeEnv({ ethers: makeEthers(ch3), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await env3.BAC.chain.refresh({ reason: 'test' });
  eq('接线不对 → wiring.ok = false', env3.BAC.view.treasury().wiring.ok, false);
  ok('接线不对 → 指出 router.bridge', env3.BAC.view.treasury().wiring.mismatches.includes('router.bridge'));
  ok('接线不对 → 告警', env3.BAC.state.warnings.includes('wiring_mismatch'));

  // 披露：50/50 的基数是扣掉 Flap 协议费之后到账的 BNB（HANDOFF §4），不是「税后 BNB」
  ok('披露写明扣掉 Flap 10% 协议费', t.disclosure.includes('扣掉 Flap 10% 协议费后到账 BNB 的 50%'), t.disclosure);
  ok('披露不再说「税后 BNB 的 50%」', !t.disclosure.includes('税后 BNB 的 50%'));
  const tPre = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(), config: BSC_ONLY({ token: '0x0' }) }).BAC.view.treasury();
  ok('阶段 (a) 的披露也按扣费后的基数写', tPre.disclosure.includes('扣掉 Flap 10% 协议费后到账 BNB 的 50%'), tPre.disclosure);

  /* ── 「时间线全了」必须是真的扫过 ── */
  // 部署块在窗口里、但日志 RPC 一直失败：一条日志都没看过，绝不能说全了
  const ch4 = makeChain(FIXTURES);
  const env4 = makeEnv({ ethers: makeEthers(ch4, { logsFail: true }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR, { deployBlock: HEAD - 100 }) });
  await env4.BAC.chain.refresh({ reason: 'test' });
  eq('日志全失败 · syncedTo 仍是 null', env4.BAC.state.timeline.syncedTo, null);
  eq('日志全失败 · 时间线不算全', env4.BAC.state.timeline.complete, false);
  eq('日志全失败 · owner 视图 complete = false', env4.BAC.view.ownerPowers().complete, false);
  eq('日志全失败 · 路由视图 timelineComplete = false', env4.BAC.view.treasury().timelineComplete, false);
  // 窗口比两块大：首轮只扫前两块，离链头还差 9000 块 → 不算全；下一轮追到链头才算
  const ch5 = makeChain(FIXTURES);
  const env5 = makeEnv({ ethers: makeEthers(ch5), fetchImpl: makeFetch(),
    config: BSC_ONLY(ADDR, { deployBlock: HEAD - 19000, logWindowBlocks: 20000, logChunkBlocks: 5000 }) });
  await env5.BAC.chain.refresh({ reason: 'test' });
  eq('大窗口 · 首轮从部署块扫起', env5.BAC.state.timeline.fromBlock, HEAD - 19000);
  eq('大窗口 · 首轮只扫了两块', env5.BAC.state.timeline.syncedTo, HEAD - 9001);
  eq('大窗口 · 没扫到链头 → 不算全', env5.BAC.state.timeline.complete, false);
  eq('大窗口 · caughtUp = false', env5.BAC.state.timeline.caughtUp, false);
  await env5.BAC.chain.refresh({ reason: 'test' });
  eq('大窗口 · 第二轮扫到链头', env5.BAC.state.timeline.syncedTo, HEAD);
  eq('大窗口 · 追上了才算全', env5.BAC.state.timeline.complete, true);
  // 已经全了之后某一轮失败：保持结论（那一轮的失败另有 status 标着）；但记了缺口就不再算全
  const beh6 = {};
  const env6 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES), beh6), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR, { deployBlock: HEAD - 100 }) });
  await env6.BAC.chain.refresh({ reason: 'test' });
  eq('从部署块扫到链头 → 全', env6.BAC.state.timeline.complete, true);
  beh6.logsFail = true; beh6.headNumber = HEAD + 5;
  await env6.BAC.chain.refresh({ reason: 'test' });
  eq('之后一轮失败 → 时间线 error', env6.BAC.view.treasury().timelineStatus, 'error');
  eq('之后一轮失败 → 仍是全的（到 syncedTo 为止）', env6.BAC.state.timeline.complete, true);
  beh6.headNumber = HEAD + 30000;
  await env6.BAC.chain.refresh({ reason: 'test' });
  eq('睡过头记了缺口、这一轮又失败 → 不算全', env6.BAC.state.timeline.complete, false);
});

/* ══════════════════════════════════════════════════════
   BacBridge 的 owner 权力（决策 #29 / #29c / #33）
   ══════════════════════════════════════════════════════ */
await group('owner', async () => {
  const TD = '0x' + 'd0'.repeat(32), TU = '0x' + 'd1'.repeat(32), TE = '0x' + 'd2'.repeat(32), TO = '0x' + 'd3'.repeat(32);
  const DEPLOY = HEAD - 4000;
  const logs = [
    // 部署：ERC1967Proxy 构造函数发 Upgraded(IMPL1)，initialize 发 OwnershipTransferred(0 → OWNER)
    mkLog(ADDR.bridge, DEPLOY, TD, 0, 'Upgraded', { implementation: IMPL1 }),
    mkLog(ADDR.bridge, DEPLOY, TD, 1, 'OwnershipTransferred', { previousOwner: ZERO, newOwner: OWNER }),
    mkLog(ADDR.bridge, DEPLOY, TD, 2, 'Initialized', { version: 1 }),
    // 升级：同一笔交易里 BridgeUpgraded + Upgraded
    mkLog(ADDR.bridge, HEAD - 300, TU, 0, 'BridgeUpgraded', { newImplementation: IMPL2, previousImplementation: IMPL1, by: OWNER,
      upgradeNumber: 1, at: 1789990000, bnbBook: 9n * E18, lockedBacBook: 5000000n * E18, buybackBacBook: 8n * E18, owedTotalBook: 4n * E18 }),
    mkLog(ADDR.bridge, HEAD - 300, TU, 1, 'Upgraded', { implementation: IMPL2 }),
    // 紧急提取 BNB
    mkLog(ADDR.bridge, HEAD - 200, TE, 0, 'EmergencyWithdraw', { by: OWNER, to: OWNER, token: ZERO, amount: 1n * E18,
      balanceAfter: 8n * E18, bookAtWithdraw: 9n * E18, lifetimeWithdrawn: 1n * E18, withdrawNumber: 1, at: 1789995000 }),
    // 换 owner 的第一步
    mkLog(ADDR.bridge, HEAD - 100, TO, 0, 'OwnershipTransferStarted', { previousOwner: OWNER, newOwner: OTHER }),
    // 桥的其它事件不上 owner 时间线
    mkLog(ADDR.bridge, HEAD - 90, TO, 1, 'Locked', { depositId: 0, agentId: 17, from: OWNER, layerWallet: OWNER, measured: 1n, credits: 1n, totalIssued: 1n })
  ];
  const ch = makeChain(FIXTURES);
  const env = makeEnv({ ethers: makeEthers(ch, { logs }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR, { deployBlock: DEPLOY }) });
  const B = env.BAC;
  await B.chain.refresh({ reason: 'test' });
  const op = B.view.ownerPowers();
  eq('owner 权力视图 ok', op.status, 'ok');
  eq('owner = 部署钱包', op.owner, OWNER);
  eq('没有待定 owner（零地址当没有）', op.pendingOwner, null);
  eqAddr('当前实现（ERC1967 槽）', op.implementation, IMPL2);
  eq('EXTENSION', op.extension, EXT);
  eq('升级次数（计数器，全量）', op.upgradeCount, 1);
  eq('最近一次升级时间', op.lastUpgradeAt, 1789990000);
  eq('紧急提取次数', op.emergencyCount, 1);
  eq('紧急提取累计 BNB', op.emergencyBnbWithdrawn, 1n * E18);
  eq('紧急提取累计 BAC', op.emergencyBacWithdrawn, 0n);
  eq('逐字披露', op.notice, OWNER_NOTICE);
  eq('时间线条数（Upgraded 并进 BridgeUpgraded，Locked 不上）', op.items.length, 6);
  const kinds = op.items.map(x => x.kind).join(',');
  eq('时间线顺序（新 → 旧）', kinds, 'ownershipStarted,emergency,upgrade,initialized,ownership,implementation');
  const up = op.items.find(x => x.kind === 'upgrade');
  eq('升级 · 新实现', up.newImplementation, IMPL2);
  eq('升级 · 旧实现', up.previousImplementation, IMPL1);
  eq('升级 · 谁升的', up.by, OWNER);
  eq('升级 · 第几次', up.number, 1);
  eq('升级 · 时间用事件里的 at', up.ts, 1789990000);
  eq('升级 · 当时桥里的 BNB 账', up.books.bnb, 9n * E18);
  eq('升级 · 当时锁仓', up.books.lockedBac, 5000000n * E18);
  eq('升级 · 同交易的 Upgraded 对上了', up.implementationConfirmed, true);
  const em = op.items.find(x => x.kind === 'emergency');
  eq('提取 · 资产 BNB', em.asset, 'BNB');
  eq('提取 · token 为 null', em.token, null);
  eq('提取 · 金额', em.amount, 1n * E18);
  eq('提取 · 提走后余额', em.balanceAfter, 8n * E18);
  eq('提取 · 当时账面', em.bookAtWithdraw, 9n * E18);
  eq('提取 · 第几次', em.number, 1);
  eq('提取 · 时间', em.ts, 1789995000);
  const init = op.items.find(x => x.kind === 'implementation');
  eq('部署时的初始实现', init.implementation, IMPL1);
  eq('和 Initialized(1) 同一笔 → 初始实现', init.initial, true);
  eq('初始实现不算没留痕的升级', init.unlogged, false);
  eq('没有没留痕的换实现', op.unlogged.total, 0);
  ok('没有 implementation_changed_unlogged 告警', !B.state.warnings.includes('implementation_changed_unlogged'), B.state.warnings.join(','));
  eqAddr('日志里最后一次换到的实现', op.loggedImplementation, IMPL2);
  eq('时间线全了 → 实现槽和日志对得上', op.implementationMatchesLog, true);
  eq('实现槽是这一轮读到的', op.implementationFresh, true);
  eq('部署时的初始实现 · 块时间', init.ts, HEAD_TS - 4000);
  const own = op.items.find(x => x.kind === 'ownership');
  eq('部署时 owner 从零地址给部署钱包', own.to, OWNER);
  eq('换 owner 第一步', op.items[0].to, OTHER);
  eq('计数器对上了（升级 1 / 提取 1 都看到了）', op.upgradesAndWithdrawalsComplete, true);
  eq('缺的升级 0', op.missing.upgrades, 0);
  eq('从部署块起扫 → 整条时间线全量', op.complete, true);
  eq('覆盖范围从部署块开始', op.coverage.fromBlock, DEPLOY);
  eq('BscScan 事件页', op.eventsUrl, 'https://bscscan.com/address/' + ADDR.bridge + '#events');
  eq('链上那句与网站逐字一致', B.view.bridge().noticeMatches, true);
  ok('owner 说明里讲清了窗口限制', /公共节点只给最近约 5000 个块/.test(op.note), op.note);

  // 窗口没覆盖到早年的升级：计数器说 3 次，只看到 1 次 → 缺 2 次，照实说
  const ch2 = makeChain(Object.assign({}, FIXTURES, { upgradeCount: [3n], emergencyCount: [2n] }));
  const env2 = makeEnv({ ethers: makeEthers(ch2, { logs }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await env2.BAC.chain.refresh({ reason: 'test' });
  const op2 = env2.BAC.view.ownerPowers();
  eq('缺 2 次升级', op2.missing.upgrades, 2);
  eq('缺 1 次提取', op2.missing.emergencies, 1);
  eq('升级/提取不全', op2.upgradesAndWithdrawalsComplete, false);
  eq('没配 deployBlock → 不算全量', op2.complete, false);

  // 实现槽每一轮都读（升级计数器是实现合约自己写的，不能拿它当「要不要重读」的信号）
  const slotsBefore = ch.log.getStorage;
  await B.chain.refresh({ reason: 'test' });
  eq('升级次数没变 → 照样重读实现槽', ch.log.getStorage, slotsBefore + 1);

  // 标签页睡过头超过窗口：记一段缺口
  B.state.timeline.syncedTo = HEAD - 20000;
  await B.chain.syncLogs(HEAD);
  eq('睡过头 → 记一段缺口', B.state.timeline.gaps.length, 1);
  eq('缺口范围', B.state.timeline.gaps[0].join(','), (HEAD - 19999) + ',' + (HEAD - 5000));
  eq('有缺口 → 不再算全量', B.view.ownerPowers().complete, false);

  // 链上那句被改了 → 告警
  const ch3 = makeChain(Object.assign({}, FIXTURES, { OWNER_POWER_NOTICE: ['桥池项目方动不了。'] }));
  const env3 = makeEnv({ ethers: makeEthers(ch3), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await env3.BAC.chain.refresh({ reason: 'test' });
  eq('链上那句和网站对不上', env3.BAC.view.bridge().noticeMatches, false);
  ok('对不上会告警', env3.BAC.state.warnings.includes('owner_notice_mismatch'));

  // 紧急提取之后账面 > 实物：shortfall 告警
  const ch4 = makeChain(Object.assign({}, FIXTURES, { shortfall: [[3n * E18, 0n]] }));
  const env4 = makeEnv({ ethers: makeEthers(ch4), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await env4.BAC.chain.refresh({ reason: 'test' });
  eq('shortfall · BNB', env4.BAC.view.bridge().shortfall.bnb, 3n * E18);
  ok('shortfall 告警', env4.BAC.state.warnings.includes('bridge_shortfall'));

  // 发射前（shortfall() revert），账面 5 BNB、实物 2 BNB → 自己推出 3 BNB 缺口
  const ch5 = makeChain(Object.assign({}, FIXTURES_DEPLOYED, {
    bnbBalance: [5n * E18],
    getEthBalance: ethBal({ [lc(ADDR.router)]: 0n, [lc(ADDR.bridge)]: 2n * E18, [lc(ADDR.nodeFund)]: 0n })
  }));
  const env5 = makeEnv({ ethers: makeEthers(ch5, { code: { [lc(ADDR.token)]: '0x' } }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await env5.BAC.chain.refresh({ reason: 'test' });
  eq('推出来的 BNB 缺口', env5.BAC.view.bridge().shortfall.bnb, 3n * E18);
  eq('推出来的 · 来源', env5.BAC.view.bridge().shortfall.source, 'derived');

  // 单元：ERC1967 槽解码
  eq('槽 → 地址', B.chain.addrFromSlot('0x' + '0'.repeat(24) + 'a2'.repeat(20)), IMPL2);
  eq('全零槽 → null', B.chain.addrFromSlot('0x' + '0'.repeat(64)), null);
  eq('乱码槽 → null', B.chain.addrFromSlot('nope'), null);

  /* ── 升级之后实现槽读失败：不许拿升级前的实现冒充现在的 ── */
  let upCount = 1n, slotFails = false;
  const ch6 = makeChain(Object.assign({}, FIXTURES, { upgradeCount: () => [upCount] }));
  const env6 = makeEnv({
    ethers: makeEthers(ch6, { implSlot: () => { if (slotFails) throw Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }); return '0x' + '0'.repeat(24) + 'a2'.repeat(20); } }),
    fetchImpl: makeFetch(), config: BSC_ONLY(ADDR)
  });
  await env6.BAC.chain.refresh({ reason: 'test' });
  eqAddr('实现槽 · 第一次读到', env6.BAC.view.bridge().implementation, IMPL2);
  slotFails = true;
  await env6.BAC.chain.refresh({ reason: 'test' });
  eqAddr('升级次数没变、槽读失败 → 用上一轮读到的', env6.BAC.view.bridge().implementation, IMPL2);
  eq('槽读失败 → 标成不是这一轮读到的', env6.BAC.view.bridge().implementationFresh, false);
  upCount = 2n;
  await env6.BAC.chain.refresh({ reason: 'test' });
  eq('升级次数变了、槽读失败 → 不知道现在的实现（null），不拿旧的冒充', env6.BAC.view.bridge().implementation, null);
  slotFails = false;
  await env6.BAC.chain.refresh({ reason: 'test' });
  eqAddr('槽又能读了 → 读回当前实现', env6.BAC.view.bridge().implementation, IMPL2);

  /* ── 决策 #29c 的完整历史：索引器 /api/bridge/timeline 与日志窗口合并 ── */
  // 日志窗口只有最近的一次紧急提取；索引器有部署时的初始化与 owner、窗口之外的第 1 次升级、节点基金的一次提取
  const winLogs = [
    mkLog(ADDR.bridge, HEAD - 200, TE, 0, 'EmergencyWithdraw', { by: OWNER, to: OWNER, token: ZERO, amount: 1n * E18,
      balanceAfter: 8n * E18, bookAtWithdraw: 9n * E18, lifetimeWithdrawn: 1n * E18, withdrawNumber: 1, at: 1789995000 })
  ];
  const idxTimeline = JSON.parse(JSON.stringify(API_BODY['/api/bridge/timeline']));
  // 索引器也摄取到了窗口里那一笔（同一个 tx:logIndex）→ 合并时只算一次
  idxTimeline.items.unshift({ contract: 'BacBridge', event: 'EmergencyWithdraw', ts: 1789995000, block: HEAD - 200, tx: TE, logIndex: 0,
    args: { by: OWNER, to: OWNER, token: ZERO, amount: '1000000000000000000', balanceAfter: '8000000000000000000',
      bookAtWithdraw: '9000000000000000000', lifetimeWithdrawn: '1000000000000000000', withdrawNumber: '1', at: '1789995000' }, textZh: '紧急提取了 1 BNB' });
  const IDX_CFG = Object.assign(BSC_ONLY(ADDR), { indexerBase: 'https://indexer.test' });
  const ch7 = makeChain(FIXTURES);   // upgradeCount 1 / emergencyCount 1
  const env7 = makeEnv({ ethers: makeEthers(ch7, { logs: winLogs }), fetchImpl: makeFetch({ bodies: { '/api/bridge/timeline': idxTimeline } }), config: IDX_CFG });
  // 先只有日志窗口：窗口外的那次升级看不到
  await env7.BAC.chain.refresh({ reason: 'test' });
  const w0 = env7.BAC.view.ownerPowers();
  eq('只有日志窗口 · 缺 1 次升级', w0.missing.upgrades, 1);
  eq('只有日志窗口 · 不算全', w0.complete, false);
  await env7.BAC.api.run({ once: true });
  const w1 = env7.BAC.view.ownerPowers();
  eq('索引器历史 · 段状态 ok', w1.historyStatus, 'ok');
  eq('合并后 · 升级看到了（窗口之外）', w1.missing.upgrades, 0);
  eq('合并后 · 提取只算一次（同 tx:logIndex 去重）', w1.items.filter(x => x.kind === 'emergency').length, 1);
  eq('合并后 · 升级/提取都对上计数器', w1.upgradesAndWithdrawalsComplete, true);
  eq('合并后 · 条数（提取 / 升级 / owner / 初始化；Upgraded 并进升级）', w1.items.length, 4);
  eq('合并后 · 顺序新 → 旧', w1.items.map(x => x.kind).join(','), 'emergency,upgrade,ownership,initialized');
  const up1 = w1.items.find(x => x.kind === 'upgrade');
  eq('索引器的升级 · 来源', up1.source, 'indexer');
  eq('索引器的升级 · 第几次（字符串 → 数字）', up1.number, 1);
  eq('索引器的升级 · 时间', up1.ts, 1789940000);
  eqAddr('索引器的升级 · 新实现', up1.newImplementation, IMPL2);
  eq('索引器的升级 · 同交易的 Upgraded 对上了', up1.implementationConfirmed, true);
  eq('索引器的升级 · 带着索引器的中文', up1.textZh, '桥合约第 1 次升级');
  eq('索引器的升级 · 账面是 BigInt', up1.books.bnb, 0n);
  eq('日志窗口那条优先（来源 rpc）', w1.items[0].source, 'rpc');
  eq('来源计数', JSON.stringify(w1.sources), JSON.stringify({ rpc: 1, indexer: 4 }));
  eq('索引器的累计数', w1.historyTotals.upgrades, 1);
  eq('从部署那一刻起（看得到 Initialized / owner 从零地址给出）', w1.coverage.fromDeploy, true);
  eq('索引器游标接上了日志窗口 → 全了', w1.complete, true);
  eq('全了 · 靠的是索引器', w1.completeVia, 'indexer');
  eq('节点基金时间线也合并了索引器的历史', env7.BAC.view.treasury().nodeFundEvents.filter(x => x.kind === 'withdraw').length, 1);
  ok('合并不改原始状态（日志窗口那条仍然只有 1 条）', env7.BAC.state.timeline.owner.length === 1);
  eq('合并 · 没有降级', env7.BAC.state.indexer.degraded, false);

  // 索引器游标落后于日志窗口起点：中间那段谁都没看过 → 不算全
  const env8 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES), { logs: winLogs }),
    fetchImpl: makeFetch({ bodies: { '/api/bridge/timeline': idxTimeline,
      '/api/health': Object.assign({}, API_BODY['/api/health'], { indexer: { layerCursor: 1, bscCursor: HEAD - 50000, dbBytes: 1 } }) } }),
    config: IDX_CFG });
  await env8.BAC.chain.refresh({ reason: 'test' });
  await env8.BAC.api.run({ once: true });
  eq('游标落后日志窗口 → 不算全', env8.BAC.view.ownerPowers().complete, false);
  eq('游标落后 · 覆盖范围照实给出', env8.BAC.view.ownerPowers().coverage.indexerThrough, HEAD - 50000);
  eq('游标落后 · 升级照样看得到', env8.BAC.view.ownerPowers().missing.upgrades, 0);
  // health 读不到（游标不知道）→ 不算全
  const env8b = makeEnv({ ethers: makeEthers(makeChain(FIXTURES), { logs: winLogs }),
    fetchImpl: makeFetch({ bodies: { '/api/bridge/timeline': idxTimeline, '/api/health': null } }), config: IDX_CFG });
  await env8b.BAC.chain.refresh({ reason: 'test' });
  await env8b.BAC.api.run({ once: true });
  eq('游标不知道 → 不算全', env8b.BAC.view.ownerPowers().complete, false);
  eq('游标不知道 · 历史照样合并进来', env8b.BAC.view.ownerPowers().missing.upgrades, 0);

  // 索引器回满了 limit 条：可能还有更早的 → 不算全
  const full = JSON.parse(JSON.stringify(idxTimeline));
  for (let i = 0; full.items.length < 10; i++) {
    full.items.push({ contract: 'BacBridge', event: 'Paused', ts: 1789800000 - i, block: HEAD - 95000 - i, tx: '0x' + (0xe0 + i).toString(16).repeat(32), logIndex: 0,
      args: { by: WATCHDOG, until_: '1789803600', cumulative: '3600' }, textZh: '暂停' });
  }
  const env9 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES), { logs: winLogs }),
    fetchImpl: makeFetch({ bodies: { '/api/bridge/timeline': full } }), config: Object.assign({}, IDX_CFG, { timelineMax: 10 }) });
  await env9.BAC.chain.refresh({ reason: 'test' });
  await env9.BAC.api.run({ once: true });
  eq('满了 limit → truncated', env9.BAC.state.ownerTimeline.truncated, true);
  eq('满了 limit → 不算全', env9.BAC.view.ownerPowers().complete, false);
  ok('暂停也上了时间线', env9.BAC.view.ownerPowers().items.some(x => x.kind === 'pause' && x.until === 1789803600));

  // 索引器盯的是别的桥：一条都不用，告警
  const other = JSON.parse(JSON.stringify(idxTimeline)); other.bridge = OTHER;
  const env10 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES), { logs: winLogs }),
    fetchImpl: makeFetch({ bodies: { '/api/bridge/timeline': other } }), config: IDX_CFG });
  await env10.BAC.chain.refresh({ reason: 'test' });
  await env10.BAC.api.run({ once: true });
  eq('别的桥 · 不合并', env10.BAC.view.ownerPowers().items.length, 1);
  eq('别的桥 · 累计数不用', env10.BAC.view.ownerPowers().historyTotals, null);
  ok('别的桥 · 告警', env10.BAC.state.warnings.includes('indexer_address_mismatch'));

  // 旧版索引器没有这个端点（404）：这一段报错，页面照旧只用日志窗口，**不算索引器挂了**
  const env11 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES), { logs: winLogs }),
    fetchImpl: makeFetch({ bodies: { '/api/bridge/timeline': null } }), config: IDX_CFG });
  await env11.BAC.chain.refresh({ reason: 'test' });
  await env11.BAC.api.run({ once: true });
  await env11.BAC.api.pull.bridgeTimeline({});
  eq('404 · 历史段 error', env11.BAC.view.ownerPowers().historyStatus, 'error');
  eq('404 · 只剩日志窗口那条', env11.BAC.view.ownerPowers().items.length, 1);
  eq('404 · 索引器没有被记成失败', env11.BAC.state.indexer.failures, 0);
  eq('404 · 没有降级', env11.BAC.state.indexer.degraded, false);
  eq('404 · 整页的索引器状态仍然 ok', env11.BAC.view.overview().indexer, 'ok');
});

/* ══════════════════════════════════════════════════════
   agent 名录：BacBridge.deposits + ERC-8004（决策 #31 / #31a）
   ══════════════════════════════════════════════════════ */
await group('agents', async () => {
  const ch = makeChain(FIXTURES);
  const env = makeEnv({ ethers: makeEthers(ch), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  const B = env.BAC;
  let agentEvents = 0;
  B.on('agents', () => agentEvents++);
  await B.chain.refresh({ reason: 'test' });
  const ag = B.view.agents({});
  eq('名录 ok', ag.status, 'ok');
  eq('来源是链上', ag.source, 'chain');
  eq('两个身份（17 锁了两次，99 一次）', ag.items.length, 2);
  eq('总数（读全了存入 → 知道）', ag.total, 2);
  eq('存入笔数（depositId）', ag.depositsTotal, 3);
  eq('没截断', ag.truncated, false);
  eq('状态机计数全部作废', ag.counts.active, null);
  eq('状态机计数 · total 还在', ag.counts.total, 2);
  ok('名录说明带决策 #31a', ag.note.includes('我们要求持有 agent 身份，我们不能证明它是 AI。'));
  ok('广播了 agents 事件', agentEvents > 0);

  const a17 = ag.items[0];
  eq('按最近一次锁入排（17 在前）', a17.agentId, 17);
  eq('身份编号', a17.identityId, 17);
  eq('身份存在（ownerOf 有返回）', a17.identityExists, true);
  eq('身份持有人', a17.identityOwner, OWNER);
  eq('agentWallet 是 20 个裸字节 → 地址', a17.agentWallet, AGENT_WALLET_17);
  eq('锁了两次', a17.deposits, 2);
  eq('读到的存入里一共锁了', a17.lockedTotal, 300000n * E18);
  eq('第一次锁入时间', a17.firstLockAt, 1789900000);
  eq('最近一次锁入时间', a17.lastLockAt, 1789960000);
  eq('兼容 mapAgent 的 activatedAt = 第一次锁入', a17.activatedAt, 1789900000);
  eq('桥上记的积分（credited）', a17.credited, 300000n * E18);
  eq('桥上记的退出（exitedCredits）', a17.exited, 0n);
  eq('逃生款控制人（agentController）', a17.controller, OWNER);
  eq('层内钱包 = 最近一次 lock 的调用者', a17.wallet, OWNER);
  eq('tokenURI 种类', a17.tokenURIKind, 'data');
  eq('自述 · 名字（UTF-8 解出来）', a17.selfReported.name, 'Clawbot 爪子');
  eq('自述 · 简介', a17.selfReported.description, '我自己说我是个 AI');
  eq('自述 · 有图（只记有没有）', a17.selfReported.hasImage, true);
  eq('自述 · 标注', a17.selfReported.note, '持有人自述 · 未经核对');
  ok('图片 URL 绝不以明文交给页面', !JSON.stringify(a17, (k, v) => typeof v === 'bigint' ? String(v) : v).includes('evil.example'), 'image url leaked');
  ok('解码后的字段里没有图片 URL', !JSON.stringify(a17.selfReported).includes('evil.example'));
  eq('v1 状态 · status = null', a17.status, null);
  eq('v1 状态 · statusName = null', a17.statusName, null);
  eq('v1 状态 · statusZh = null', a17.statusZh, null);
  eq('v1 状态 · 心跳 = null', a17.lastHeartbeatEpoch, null);
  eq('层内余额只有索引器给得出 → null', a17.layerBalance, null);
  eq('不可信标记', a17.untrusted, true);

  const a99 = ag.items[1];
  eq('没铸过的编号：ownerOf revert → 身份不存在', a99.identityExists, false);
  eq('没铸过的编号：持有人 null', a99.identityOwner, null);
  eq('没铸过的编号：agentWallet null', a99.agentWallet, null);
  eq('没铸过的编号：tokenURI null', a99.tokenURI, null);
  eq('没铸过的编号：自述 null', a99.selfReported, null);
  eq('没铸过的编号：桥上的积分照样是真的', a99.credited, 1000n * E18);

  // 读的是 ERC-8004 注册表，不是 v1 的 AgentRegistry
  ok('调了 ownerOf', ch.log.calls.includes('ownerOf'));
  ok('调了 getMetadata', ch.log.calls.includes('getMetadata'));
  ok('调了 tokenURI', ch.log.calls.includes('tokenURI'));
  ok('没调 v1 的 totalAgents / getAgent', !ch.log.calls.includes('totalAgents') && !ch.log.calls.includes('getAgent'));

  // 第二轮：存入没变、身份还没到复读时间 → 不再读 deposits / 注册表
  const n1 = ch.log.calls.filter(f => f === 'deposits').length, n2 = ch.log.calls.filter(f => f === 'ownerOf').length;
  await B.chain.refresh({ reason: 'test' });
  eq('存入缓存：不重读 deposits', ch.log.calls.filter(f => f === 'deposits').length, n1);
  eq('身份缓存：不重读 ownerOf', ch.log.calls.filter(f => f === 'ownerOf').length, n2);

  // 索引器给了同号条目：用它补层内数据，但状态机字段仍然是 null
  const env2 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  await env2.BAC.chain.refresh({ reason: 'test' });
  await env2.BAC.api.run({ once: true });
  const g2 = env2.BAC.view.agents({});
  eq('链上名录优先', g2.source, 'chain');
  eq('索引器补上层内余额', g2.items[0].layerBalance, 249978000000000000000000n);
  eq('索引器补上部署数', g2.items[0].deploys, 3);
  eq('补完仍然没有状态', g2.items[0].statusZh, null);

  // 截断：存入太多只读最近 depositsMax 笔 → 总数不知道（不猜），只给「至少」
  const many = {};
  for (let i = 0; i < 12; i++) many[i] = [OWNER, 1789900000 + i, BigInt(1000 + i), 1n * E18];
  const ch3 = makeChain(Object.assign({}, FIXTURES, { depositId: [12n], deposits: (args) => many[Number(args[0])], ownerOf: [OWNER] }));
  const env3 = makeEnv({ ethers: makeEthers(ch3), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR, { depositsMax: 10 }) });
  await env3.BAC.chain.refresh({ reason: 'test' });
  const g3 = env3.BAC.view.agents({});
  eq('截断 · 标记', g3.truncated, true);
  eq('截断 · 总数 null（不猜）', g3.total, null);
  eq('截断 · 至少', g3.totalAtLeast, 10);
  eq('截断 · 只读了最近 10 笔', ch3.log.calls.filter(f => f === 'deposits').length, 10);
  eq('截断 · 存入笔数仍是全量', g3.depositsTotal, 12);

  // 单元：agentWallet 的 20 字节解码（和合约 Erc8004Gate.walletOrZero 同一口径）
  const W = B.chain.walletFromMetadata;
  eq('20 字节 → 地址', W(AGENT_WALLET_17), AGENT_WALLET_17);
  eq('abi 编码的 32 字节不认（长度不对）', W('0x' + '0'.repeat(24) + 'be'.repeat(20)), null);
  eq('空字节 → 没设置', W('0x'), null);
  eq('零地址 → 没设置', W(ZERO), null);
  eq('非字符串 → null', W(undefined), null);

  // 单元：tokenURI 解析
  const P = B.chain.parseTokenURI;
  eq('ipfs', P('ipfs://bafy/x.json').kind, 'ipfs');
  eq('ipfs 不去拉 → 没有自述', P('ipfs://bafy/x.json').selfReported, null);
  eq('https', P('https://x/agent.json').kind, 'http');
  eq('url 编码的 JSON', P('data:application/json,' + encodeURIComponent('{"name":"n1"}')).selfReported.name, 'n1');
  eq('坏 base64 → 自述 null，不抛', P('data:application/json;base64,@@@').selfReported, null);
  eq('坏 JSON → 自述 null', P('data:application/json;base64,' + Buffer.from('{oops').toString('base64')).selfReported, null);
  eq('超长名字截到 200', P('data:application/json;base64,' + Buffer.from(JSON.stringify({ name: 'x'.repeat(500) })).toString('base64')).selfReported.name.length, 200);
  eq('空 → kind null', P('').kind, null);
  eq('原文 JSON 的 data URI', P('data:application/json,{"name":"n2"}').selfReported.name, 'n2');
  eq('gzip 压缩的（主网 #10 就是）→ 不解压，自述 null', P('data:application/json;enc=gzip;level=6;base64,H4sIAMtOg2kAA61a').selfReported, null);
  eq('gzip 压缩的 → kind 仍是 data', P('data:application/json;enc=gzip;level=6;base64,H4sIAMtOg2kAA61a').kind, 'data');

  // 身份查询以桥自己读的注册表为准（接线读回来的 identityRegistry）
  const ALT_REG = '0x' + '8e'.repeat(20);
  const ch4 = makeChain(Object.assign({}, FIXTURES, { identityRegistry: [ALT_REG],
    ownerOf: (args, target) => lc(target) === lc(ALT_REG) && Number(args[0]) === 17 ? [OTHER] : undefined }));
  const env4 = makeEnv({ ethers: makeEthers(ch4), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await env4.BAC.chain.refresh({ reason: 'test' });
  eq('查的是桥读的那个注册表', env4.BAC.view.agents({}).items[0].identityOwner, OTHER);
  ok('注册表和配置不一致会告警（接线核对）', env4.BAC.view.bridge().wiring.mismatches.includes('bridge.identityRegistry'));

  // 有一笔存入这一轮没读到 → 总数不知道（不猜），给「至少」
  const ch5 = makeChain(Object.assign({}, FIXTURES, { deposits: (args) => Number(args[0]) === 1 ? undefined : DEPOSITS[Number(args[0])] }));
  const env5 = makeEnv({ ethers: makeEthers(ch5), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await env5.BAC.chain.refresh({ reason: 'test' });
  eq('缺一笔存入 → 总数 null', env5.BAC.view.agents({}).total, null);
  eq('缺一笔存入 → 至少 1 个', env5.BAC.view.agents({}).totalAtLeast, 1);
  eq('全程没有碰 DOM', env.domHits.length + env2.domHits.length + env3.domHits.length, 0);
});

/* ══════════════════════════════════════════════════════
   BSC 侧其它读数（锚点 / 验证者 / 纪元）
   ══════════════════════════════════════════════════════ */
await group('bsc', async () => {
  const chain = makeChain(FIXTURES);
  const env = makeEnv({ ethers: makeEthers(chain), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  const B = env.BAC;
  await B.chain.refresh({ reason: 'test' });
  ok('BSC 段就绪', B.state.bsc.ready, B.state.bsc.errorDetail || '');
  eq('BSC 段没有错误', B.state.bsc.error, null);

  const br = B.view.bridge();
  eq('桥 · 已发行积分', br.totalIssued, 5000000n * E18);
  eq('桥 · 已退出积分', br.totalExited, 120000n * E18);
  eq('桥 · 锁仓（lockedBac）', br.lockedBac, 5000000n * E18);
  eq('桥 · totalLocked 是 lockedBac 的旧名', br.totalLocked, br.lockedBac);
  eq('桥 · BNB 账', br.bnbBalance, 9n * E18);
  eq('桥 · poolBalance 是 bnbBalance 的旧名', br.poolBalance, br.bnbBalance);
  eq('桥 · 回购桶', br.buybackBac, 8n * E18);
  eq('桥 · 回购场所', br.buyback.venueName, 'curve');
  eq('桥 · 每积分折合 BAC', br.bacPerCredit, 1800000000000n);
  eq('桥 · weiPerCredit 旧名（单位已改成 BAC）', br.weiPerCredit, br.bacPerCredit);
  eq('桥 · 单地址每纪元上限', br.maxExitShareBps, 1000);
  eq('桥 · 没有暂停', br.paused, false);
  eq('桥 · 没有停机', br.halted, false);
  eq('桥 · 身份注册表（接线读回来的）', br.identityRegistry, REGISTRY);
  ok('桥 · 兑付说明写的是回购的 BAC', /回购来的 BAC/.test(br.rateNote));

  const ep = B.view.epoch();
  eq('纪元 · 长度 600 秒', ep.lengthSec, 600);
  eq('纪元 · 上报到', ep.lastPosted, 2983332);
  eq('纪元 · 定案到', ep.lastFinal, 2983331);
  eq('纪元 · 锚点状态', ep.state, 'POSTED');
  eq('纪元 · 中文状态', ep.stateZh, '已上报 · 锚点等待中');
  eq('纪元 · 承诺窗口 0', ep.commitWindowSec, 0);
  eq('纪元 · 锚点等待 2 分钟', ep.anchorWaitSec, 120);
  eq('纪元 · 锚点等待（兼容字段名）', ep.challengeWindowSec, 120);
  eq('锚点 · exitCount（12 字段结构）', ep.anchor.exitCount, 7);
  eq('锚点 · agreeingCount', ep.anchor.agreeingCount, 2);
  eq('锚点 · l2Block', ep.anchor.l2Block, 1234501);
  eq('锚点 · 合约里没有的 gasFeesInEpoch → null', ep.anchor.gasFeesInEpoch, null);
  eq('锚点 · 合约里没有的 proposerIncomeRoot → null', ep.anchor.proposerIncomeRoot, null);

  const v0 = B.view.validators();
  eq('验证者 · 节点数', v0.nodeCount, 2);
  eq('验证者 · 总质押', v0.totalStaked, 5000000n * E18);
  // ChainAnchor / ValidatorStaking 里没有 gas 归集的读函数：链上直读给不出这三个数（不编），也不读那些不存在的函数
  eq('gas 三元组 · 只有链上直读 → null', v0.gas, null);
  eq('lastRemitEpoch · 合约里没有 → null', v0.lastRemitEpoch, null);
  ok('没调合约里不存在的函数', !chain.log.calls.some(fn => ['cumulativeGasFees', 'cumulativeRemitted', 'lastRemitEpoch', 'remitStatus',
    'proposerRights', 'proposerAddressOf', 'qualifyStreak', 'withheldOf'].includes(fn)), chain.log.calls.join(','));
  ok('读了 firstEpoch', chain.log.calls.includes('firstEpoch'));
  // 索引器 /api/health 的 gas 块（来自 FINAL 锚点）才是真实来源
  await B.api.run({ once: true });
  const v = B.view.validators();
  eq('gas 三元组 · 已收（索引器）', v.gas.collected, 100n * E18);
  eq('gas 三元组 · 已转入', v.gas.remitted, 90n * E18);
  eq('gas 三元组 · 差额', v.gas.shortfall, 10n * E18);
  eq('gas 三元组 · 不平', v.gas.ok, false);
  eq('gas 三元组 · 来源', v.gas.source, 'indexer');
  eq('gas 三元组 · 截至哪个锚点', v.gas.lastAnchoredEpoch, 2983331);
  eq('官方出块 → 验证者池 10%', v.gas.officialValidatorBps, 1000);
  eq('验证者出块 → 自留 50%', v.gas.validatorSelfBps, 5000);
  ok('链上不再自己拉 gas 告警', !B.state.warnings.includes('gas_remittance_shortfall'));
  ok('归集只能对账不能强制这句话在', /不能强制/.test(v.gasNote));
  ok('两笔钱不能相加这句话在', /两笔钱/.test(v.rewardNote));
  // 一个 FINAL 锚点都还没有：索引器给的占位 "0" 不是「已收 0」
  const envG = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)),
    fetchImpl: makeFetch({ bodies: { '/api/health': Object.assign({}, API_BODY['/api/health'],
      { gas: Object.assign({}, API_BODY['/api/health'].gas, { lastAnchoredEpoch: null, received: '0', remitted: '0', gap: '0' }) }) } }),
    config: LIVE_CONFIG });
  await envG.BAC.chain.refresh({ reason: 'test' });
  await envG.BAC.api.run({ once: true });
  eq('没有 FINAL 锚点 → gas 三元组 null', envG.BAC.view.validators().gas, null);

  const ov = B.view.overview();
  eq('overview · stage', ov.stage, 'launched');
  eq('overview · contractsLive', ov.contractsLive, true);
  eq('overview · tokenLive', ov.tokenLive, true);
  eq('overview · 地址簿 router', ov.addresses.router, ADDR.router);
  eq('overview · 地址簿 vault 别名', ov.addresses.vault, ADDR.router);
  eq('overview · Portal', ov.addresses.flapPortal, PORTAL);
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
  // 公式里有 genesisAlloc：它和它由哪些账户组成必须一起交给页面，否则 diff = 0 看不出那 1e24 从哪来
  eq('对账 · genesisAlloc', cs.reconcile.genesisAlloc, 1000000n * E18);
  eq('对账 · genesisSupply', cs.reconcile.genesisSupply, 10n ** 27n);
  eq('对账 · 创世分配账户', cs.reconcile.genesisAllocAccounts.length, 1);
  eq('对账 · 创世分配账户地址', cs.reconcile.genesisAllocAccounts[0].addr, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  eq('对账 · 创世分配账户余额是 BigInt', cs.reconcile.genesisAllocAccounts[0].balance, 1000000n * E18);
  eq('对账 · 创世文件来源', cs.reconcile.genesisSource, '/data/genesis.json');
  ok('对账 · 说明原样带上', /genesisAlloc/.test(cs.reconcile.note || ''), cs.reconcile.note);
  ok('对账 · 公式带 genesisAlloc', /genesisAlloc/.test(cs.reconcile.formula));
  eq('对账 · FeeSplitter 余额', cs.reconcile.feeSplitterBalance, 0n);

  const f = B.view.feed();
  eq('feed 条数', f.items.length, 2);
  eq('feed 按 id 倒序', f.items[0].id, 91422);
  eq('未锚定必须标注', f.items[0].anchorNote, '未锚定 · 仅来自官方节点');
  eq('已锚定的标注', f.items[1].anchorNote, '已锚定');
  eq('anchoredThrough', f.anchoredThrough, 2983331);
  eq('feed 文本不可信标记', f.items[0].untrusted, true);

  const bl = B.view.blocks();
  eq('区块条数', bl.items.length, 2);
  eq('区块 baseFee 是 BigInt', bl.items[0].baseFee, 0n);
  const tx = B.view.txs();
  eq('交易条数', tx.items.length, 1);
  eq('交易 value 是 BigInt', tx.items[0].value, 0n);
  eq('交易部署出的合约', tx.items[0].created, IMPL1);

  // 合约还没探到代码：名录退回索引器的条目；v1 状态机字段一律作废
  const ag = B.view.agents();
  eq('agent 名录条数（索引器）', ag.items.length, 1);
  eq('来源是索引器', ag.source, 'indexer');
  eq('agent 积分是 BigInt', ag.items[0].credited, 250000n * E18);
  eq('旧索引器发的 status 作废成 null', ag.items[0].status, null);
  eq('旧索引器发的 statusZh 作废成 null', ag.items[0].statusZh, null);
  eq('旧索引器发的心跳作废成 null', ag.items[0].lastHeartbeatEpoch, null);
  eq('旧 agentURI 作废成 null', ag.items[0].agentURI, null);
  eq('身份编号 = agentId', ag.items[0].identityId, 17);
  eq('总数取索引器', ag.total, 42);
  eq('计数只剩 total', ag.counts.active, null);
  ok('agentURI 不背书这句话在', /不背书/.test(ag.note));
  // v2 字段名（bac/agents/2）
  const a2 = ag.items[0];
  eq('v2 · 退出积分来自 creditsExited', a2.exited, 1n * E18);
  eq('v2 · 层内钱包 = layerWallets[0]', a2.wallet, OTHER);
  eq('v2 · layerWallets 全部带上', a2.layerWallets.join(','), [OTHER, OWNER].join(','));
  eq('v2 · 身份持有人来自 holder', a2.identityOwner, OWNER);
  eq('v2 · 身份存在', a2.identityExists, true);
  eq('v2 · agentWallet', a2.agentWallet, AGENT_WALLET_17);
  eq('v2 · 注册名', a2.registrationName, 'Clawbot 爪子');
  eq('v2 · 注册名放进自述（和链上名录同形状）', a2.selfReported.name, 'Clawbot 爪子');
  eq('v2 · 自述标注', a2.selfReported.note, '持有人自述 · 未经核对');
  eq('v2 · 锁入次数', a2.deposits, 2);
  eq('v2 · 第一次锁入时间', a2.activatedAt, 1789900044);
  eq('v2 · 混进来的 v1 status 仍然作废', a2.statusName, null);
  // v1 形状（线上旧索引器）照样认
  const v1 = B.api.shape.agentItem(API_AGENTS_V1.items[0]);
  eq('v1 · credited', v1.credited, 250000n * E18);
  eq('v1 · exited', v1.exited, 0n);
  eq('v1 · wallet', v1.wallet, OWNER);
  eq('v1 · layerWallets 退成一个', v1.layerWallets.join(), OWNER);
  eq('v1 · 身份存在不知道 → null', v1.identityExists, null);
  eq('v1 · 没有注册名 → 自述 null', v1.selfReported, null);
  eq('v1 · 状态机字段作废', v1.status, null);
  // /api/agent/{id} 的形状（bind.js 把 j.agent 交给 agentItem）
  const one = B.api.shape.agentItem({ agentId: 5, holder: OTHER, layerWallets: [null], creditsLocked: '7', creditsExited: '2', identityExists: false });
  eq('单个 agent · 积分', one.credited, 7n);
  eq('单个 agent · 退出', one.exited, 2n);
  eq('单个 agent · layerWallets 里的 null 丢掉', one.wallet, null);
  eq('单个 agent · 身份已不存在', one.identityExists, false);
  eq('agentItem(undefined) 不抛', B.api.shape.agentItem(undefined).agentId, null);

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
  eq('纪元历史 · 中文状态', eps.history[0].stateZh, '已上报 · 锚点等待中');

  eq('兑付率（v2 bacPerCredit）', B.state.rate.bacPerCredit, 1800000000000n);
  eq('兑付率 · 旧键 weiPerCredit 同值', B.state.rate.weiPerCredit, 1800000000000n);
  eq('兑付率 · 单位 BAC', B.state.rate.unit, 'BAC');
  eq('兑付率 · 回购桶（v2 buybackBac）', B.state.rate.buybackBac, 8n * E18);
  eq('兑付率 · 旧键 poolBalance = buybackBac', B.state.rate.poolBalance, 8n * E18);
  eq('兑付率 · 来源', B.state.rate.rateSource, 'BacBridge.currentRate()');
  eq('兑付率 · 段状态 ok', B.state.rate.status, 'ok');
  ok('兑付率带免责', /不承诺任何金额/.test(B.state.rate.note));
  // v1 形状（线上旧索引器）照样认；没有在外积分时 0 是「没有汇率」
  const envR1 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ bodies: { '/api/rate': API_RATE_V1 } }), config: LIVE_CONFIG });
  await envR1.BAC.api.pull.rate();
  eq('v1 兑付率', envR1.BAC.state.rate.bacPerCredit, 1800000000000n);
  eq('v1 池子', envR1.BAC.state.rate.poolBalance, 9n * E18);
  eq('v1 单位（那时兑付 BNB）', envR1.BAC.state.rate.unit, 'BNB');
  const envR0 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)),
    fetchImpl: makeFetch({ bodies: { '/api/rate': Object.assign({}, API_BODY['/api/rate'], { bacPerCredit: '0', creditsOutstanding: '0' }) } }), config: LIVE_CONFIG });
  await envR0.BAC.api.pull.rate();
  eq('没有在外积分 → 汇率 null（不是 0）', envR0.BAC.state.rate.bacPerCredit, null);
  // owner 权力的完整历史也拉了（配置里有桥合约）
  eq('owner 时间线 · 段状态 ok', B.state.ownerTimeline.status, 'ok');
  eq('owner 时间线 · 条数（Upgraded 并进升级）', B.state.ownerTimeline.owner.length, 3);
  eq('owner 时间线 · 节点基金', B.state.ownerTimeline.nodeFund.length, 1);
  eq('owner 时间线 · 保守游标取自 health', B.state.ownerTimeline.bscCursor, HEAD - 1000);

  // 单个端点 404 不该拖垮别的段
  const env2 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ only404: ['/api/validators'] }), config: LIVE_CONFIG });
  await env2.BAC.api.run({ once: true });
  eq('404 的段报错', env2.BAC.state.validators.error, '读取失败 · 重试中');
  eq('其它段照常', env2.BAC.state.feed.ready, true);
  eq('整体没有降级', env2.BAC.state.indexer.degraded, false);
});

/* ======================================================
   层内直读（bac-layer.js）：形状 / 换端点 / 请求数上限 / 后台退避 / 全挂时不编数
   ====================================================== */

/* 发射前的真实形态：BSC 一个合约都没有（router / bridge = 0x0），但层内那条链在出块。 */
const LAYER_ONLY_CONFIG = {
  addresses: { token: '0x0', router: '0x0', bridge: '0x0', nodeFund: '0x0', anchor: '0x0', staking: '0x0' },
  indexerBase: '', fallbackApi: '',                  // 索引器还没部署（主用和兜底都没有）
  layerRpc: 'https://layer.test/rpc',
  fallbackRpc: 'https://fallback.test/rpc',
  rpcs: ['https://rpc-a.test'], logRpcs: ['https://rpc-a.test'],
  pollMs: 999999, prelaunchPollMs: 999999, apiPollMs: 999999
};

await group('layer', async () => {
  /* -- 1. 形状：块 / 交易 / 链头 -------------------------- */
  const node = makeNode();
  const env = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES)),
    fetchImpl: makeFetch({ node }), config: LAYER_ONLY_CONFIG
  });
  const B = env.BAC;

  eq('发射前 BAC.LIVE 仍然是 false', B.LIVE, false);
  eq('没配索引器', B.HAS_INDEXER, false);
  eq('配了层内 RPC', B.HAS_LAYER_RPC, true);

  const h = await B.layer.head();
  eq('head · chainId', h.chainId, 56777);
  eq('head · 块高', h.number, 0x12d687);
  eq('head · 时间戳', h.timestamp, 1789999998);
  eq('head · gasLimit', h.gasLimit, 20000000);
  eq('head · baseFee 是 0（zeroBaseFee）', h.baseFeePerGas, 0n);
  eq('head · 出块间隔是实测的', h.blockIntervalSec, 3);
  eq('head · gasPrice 1 gwei', h.gasPrice, 1000000000n);
  eq('head · peers', h.peers, 0);
  eq('head · txpool 关着就是 null（不报错）', h.txpool, null);
  eq('head · 提案人就是 miner', h.miner, NODE_MINER);
  eq('head 只打 2 个请求', node.log.requests, 2);

  node.log.requests = 0;
  const bl = await B.layer.latestBlocks(10);
  eq('latestBlocks 条数', bl.length, 10);
  eq('latestBlocks 倒序', bl[0].number > bl[1].number, true);
  eq('区块 · 号', bl[0].number, 0x12d687);
  eq('区块 · 时间戳', bl[0].ts, 1789999998);
  eq('区块 · 出块人', bl[0].proposer, NODE_MINER);
  eq('区块 · gasLimit', bl[0].gasLimit, 20000000);
  eq('区块 · baseFee 是 BigInt 0', bl[0].baseFee, 0n);
  eq('区块 · 纪元是按时间戳算的（600 秒一个）', bl[0].epoch, Math.floor(1789999998 / 600));
  const emptyBlk = bl.find(x => x.txCount === 0);
  const withTx = bl.find(x => x.txCount > 0);
  ok('窗口里有空块', !!emptyBlk);
  ok('窗口里有带交易的块', !!withTx);
  eq('空块的手续费合计就是 0（这是事实，不是猜的）', emptyBlk.feeTotal, 0n);
  eq('有交易的块 · 手续费合计 = gasUsed x effGasPrice', withTx.feeTotal, 21000n * 1000000000n);
  eq('latestBlocks 打 3 个请求（块高 1 + 块 1 + 收据 1）', node.log.requests, 3);

  node.log.requests = 0;
  const txs = await B.layer.latestTxs(3);
  eq('latestTxs 条数', txs.length, 3);
  eq('交易 · 哈希长度', txs[0].hash.length, 66);
  eq('交易 · 所属块', txs[0].blockNumber, txs[0].block);
  eq('交易 · from', txs[0].from, '0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
  eq('交易 · to', txs[0].to, '0x000000000000000000000000000000000000dead');
  eq('交易 · value 是 BigInt', txs[0].value, 1000000000000n);
  eq('交易 · gas 上限', txs[0].gas, 21000);
  eq('交易 · gasPrice', txs[0].gasPrice, 1000000000n);
  eq('交易 · 不是部署合约', txs[0].isCreate, false);
  eq('交易 · 部署出的合约地址为空', txs[0].created, null);
  eq('交易 · 收据给了状态', txs[0].status, 1);
  eq('交易 · 手续费', txs[0].fee, 21000n * 1000000000n);
  eq('交易 · zeroBaseFee 销毁 0', txs[0].feeBurned, 0n);
  eq('交易 · agent 归属 RPC 读不出来 → null', txs[0].agentId, null);
  eq('交易 · 带上块时间', typeof txs[0].ts, 'number');
  eq('latestTxs 也是 3 个请求（交易从块里捡，不逐笔请求）', node.log.requests, 3);

  node.log.requests = 0;
  const one = await B.layer.block(0x12d682);   // 1234562，能被 7 整除 → 有交易
  eq('block() · 块号', one.number, 0x12d682);
  eq('block() · 带完整交易', one.txs.length, 1);
  eq('block() · 交易有状态', one.txs[0].status, 1);
  eq('block() · parentHash', typeof one.parentHash, 'string');
  eq('block() 只打 2 个请求', node.log.requests, 2);

  node.log.requests = 0;
  const t1 = await B.layer.tx(txs[0].hash);
  eq('tx() · 哈希对上', t1.hash, txs[0].hash);
  eq('tx() · 状态', t1.status, 1);
  eq('tx() · gasUsed 来自收据', t1.gasUsed, 21000);
  eq('tx() · 时间戳来自块头', typeof t1.ts, 'number');
  eq('tx() 只打 2 个请求', node.log.requests, 2);

  eq('批量上限 25', B.layer.MAX_BATCH, 25);
  let tooBig = null;
  try { await B.layer.send(new Array(26).fill({ method: 'eth_chainId' })); } catch (e) { tooBig = e; }
  ok('超过批量上限直接拒绝', !!tooBig);

  /* -- 2. 一轮完整轮询：请求数固定 3，状态与来源都标清楚 -- */
  const node2 = makeNode();
  const env2 = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES)),
    fetchImpl: makeFetch({ node: node2 }), config: LAYER_ONLY_CONFIG
  });
  const B2 = env2.BAC;
  await B2.layer.run({ once: true });

  eq('一轮完整轮询 = 3 个 HTTP 请求', node2.log.requests, 3);
  eq('一轮完整轮询 = 3 个批量体', B2.layer.stats.batches, 3);
  eq('LAYER_LIVE = true', B2.LAYER_LIVE, true);
  eq('state.layerLive', B2.state.layerLive, true);
  eq('层内段状态 ok', B2.state.layer.sections.head, 'ok');
  eq('区块段状态 ok', B2.state.layer.sections.blocks, 'ok');
  eq('交易段状态 ok', B2.state.layer.sections.txs, 'ok');
  eq('区块来源标成 rpc', B2.state.blocks.source, 'rpc');
  eq('交易来源标成 rpc', B2.state.txs.source, 'rpc');
  eq('块高落进 state', B2.state.layer.head, 0x12d687);
  eq('取了 blocksLimit 个块', B2.state.blocks.items.length, 20);
  eq('实测出块间隔', B2.state.layer.blockIntervalSec, 3);
  eq('窗口平均出块间隔', B2.state.layer.blockTimeSec, 3);
  eq('gasLimit 落进 state', B2.state.layer.gasLimit, 20000000);
  eq('baseFee 落进 state', B2.state.layer.baseFee, 0n);

  // 本轮最关键的一条：BSC 没发射，层内的块照样显示，不是「发射后公布」
  eq('BAC.LIVE 仍然是 false', B2.LIVE, false);
  eq('区块视图状态 = ok（不被 BAC.LIVE 挡住）', B2.view.blocks().status, 'ok');
  eq('交易视图状态 = ok', B2.view.txs().status, 'ok');
  eq('链指标状态 = ok', B2.view.chainStats().status, 'ok');
  eq('链指标标了来源', B2.view.chainStats().source, 'rpc');
  eq('链指标标了端点', B2.view.chainStats().endpoint, 'https://layer.test/rpc');
  eq('BSC 那一半照旧是「发射后公布」', B2.view.treasury().status, 'pre');
  eq('桥也还是「发射后公布」', B2.view.bridge().status, 'pre');
  eq('验证者也还是「发射后公布」', B2.view.validators().status, 'pre');
  eq('全程没有碰 DOM', env2.domHits.length, 0);

  // 索引器在供数时只做轻量探活（2 个请求），不抢它的活
  node2.log.requests = 0;
  B2.state.indexer.ready = true; B2.state.indexer.degraded = false; B2.state.indexer.error = null;
  B2.HAS_INDEXER = true;
  eq('索引器在供数 → 走探活', B2.layer.indexerServing(), true);
  await B2.layer.run({ once: true });
  eq('探活只打 2 个请求', node2.log.requests, 2);
  eq('探活不覆盖索引器的区块来源', B2.state.blocks.source, 'rpc');
  eq('探活把块高记在 rpcHead 上', B2.state.layer.rpcHead, 0x12d687);
  B2.HAS_INDEXER = false;
  B2.state.indexer.ready = false;

  /* -- 3. 主端点挂了：透明切到兜底，并且不再每轮去撞墙 -- */
  const node3 = makeNode();
  const env3 = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES)),
    fetchImpl: makeFetch({ node: node3, rpcFail: { 'https://layer.test/rpc': true } }),
    config: LAYER_ONLY_CONFIG
  });
  const B3 = env3.BAC;
  eq('端点清单：主在前兜底在后', B3.layer.endpoints.join(','), 'https://layer.test/rpc,https://fallback.test/rpc');
  await B3.layer.run({ once: true });

  eq('切到兜底后照样读到块高', B3.state.layer.head, 0x12d687);
  eq('在用的端点是兜底', B3.layer.endpoint(), 'https://fallback.test/rpc');
  eq('state 里也标了端点', B3.state.layer.endpoint, 'https://fallback.test/rpc');
  eq('不是主端点', B3.layer.isPrimary(), false);
  eq('主端点只撞了一次', node3.log.byUrl['https://layer.test/rpc'], 1);
  eq('其余都打在兜底上', node3.log.byUrl['https://fallback.test/rpc'], 3);

  await B3.layer.run({ once: true });
  eq('第二轮不再去撞主端点（退避中）', node3.log.byUrl['https://layer.test/rpc'], 1);
  eq('第二轮全打兜底', node3.log.byUrl['https://fallback.test/rpc'], 6);

  // 主端点恢复（退避到期）→ 自动换回主端点
  const node4 = makeNode();
  const env4 = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES)),
    fetchImpl: makeFetch({ node: node4 }), config: LAYER_ONLY_CONFIG
  });
  await env4.BAC.layer.run({ once: true });
  eq('主端点能用时就用主端点', env4.BAC.layer.endpoint(), 'https://layer.test/rpc');
  eq('主端点能用时兜底一个请求都不发', node4.log.byUrl['https://fallback.test/rpc'], undefined);

  /* -- 4. 后台标签页退到慢档 ---------------------------- */
  const node5 = makeNode();
  const env5 = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES)),
    fetchImpl: makeFetch({ node: node5 }), config: LAYER_ONLY_CONFIG
  });
  const B5 = env5.BAC;
  await B5.layer.run({ once: true });
  eq('前台：6 秒一轮（链 3 秒一块，不比它更快）', B5.layer.period(), 6000);
  ok('永远不比出块还快', B5.layer.period() >= 3000);
  const before = node5.log.requests;
  B5.setHidden(true);
  eq('切到后台：退到 60 秒一轮', B5.layer.period(), 60000);
  eq('切到后台不会立刻再打请求', node5.log.requests, before);
  B5.setHidden(false);
  eq('回到前台：恢复 6 秒', B5.layer.period(), 6000);

  /* -- 5. 两个端点全挂：报「读取失败」，绝不编数 -------- */
  const env6 = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES)),
    fetchImpl: makeFetch({ layerRpcOk: false }), config: LAYER_ONLY_CONFIG
  });
  const B6 = env6.BAC;
  await B6.layer.run({ once: true });

  eq('全挂 → LAYER_LIVE = false', B6.LAYER_LIVE, false);
  eq('全挂 → 层内段状态 error', B6.state.layer.sections.head, 'error');
  eq('全挂 → 区块段状态 error', B6.state.layer.sections.blocks, 'error');
  eq('全挂 → 交易段状态 error', B6.state.layer.sections.txs, 'error');
  eq('全挂 → 错误文案逐字', B6.state.layer.error, '读取失败 · 重试中');
  eq('全挂 → 块高仍是 null，不编', B6.state.layer.head, null);
  eq('全挂 → 时间戳仍是 null', B6.state.layer.headTs, null);
  eq('全挂 → 出块间隔仍是 null', B6.state.layer.blockIntervalSec, null);
  eq('全挂 → 一个区块都没有', B6.state.blocks.items.length, 0);
  eq('全挂 → 一笔交易都没有', B6.state.txs.items.length, 0);
  eq('全挂 → 来源为空', B6.state.layer.source, null);
  eq('全挂 → 区块视图是 error（不是 ok、也不是 pre）', B6.view.blocks().status, 'error');
  eq('全挂 → 链指标是 error', B6.view.chainStats().status, 'error');
  eq('全挂 → 链指标块高是 null', B6.view.chainStats().head, null);
  eq('全挂 → 告警记下来了', B6.state.warnings.includes('layer_rpc_down'), true);
  eq('全挂 → 两个端点各撞一次就停', B6.layer.stats.requests, 2);
  ok('全挂 → 退避后慢下来', B6.layer.period() >= 5000);
  eq('全挂 → 也没有碰 DOM', env6.domHits.length, 0);

  /* -- 6. 一个端点都没配：这是「没配」，不是「读取失败」-- */
  const env7 = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES)),
    fetchImpl: makeFetch({}), config: { indexerBase: '', fallbackApi: '', layerRpc: '', fallbackRpc: '' }
  });
  await env7.BAC.layer.run({ once: true });
  eq('没配端点 → prelaunch', env7.BAC.state.layer.sections.head, 'prelaunch');
  eq('没配端点 → 视图是 pre（显示「发射后公布」）', env7.BAC.view.blocks().status, 'pre');
  eq('没配端点 → 不发任何请求', env7.BAC.layer.stats.requests, 0);

  /* -- 7. 节点没开 eth_getBlockReceipts：安静降级，块照读 -- */
  const node8 = makeNode({ noReceipts: true });
  const env8 = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES)),
    fetchImpl: makeFetch({ node: node8 }), config: LAYER_ONLY_CONFIG
  });
  await env8.BAC.layer.run({ once: true });
  eq('收据读不到也拿到了块', env8.BAC.state.blocks.items.length, 20);
  eq('收据读不到 → 手续费合计是 null，不猜', env8.BAC.state.blocks.items.find(x => x.txCount > 0).feeTotal, null);
  eq('收据读不到 → 交易状态是 null，不猜', env8.BAC.state.txs.items[0].status, null);
  eq('收据读不到 → gasUsed 是 null，不用 gas 上限顶替', env8.BAC.state.txs.items[0].gasUsed, null);
  eq('收据读不到 → 区块视图仍然 ok', env8.BAC.view.blocks().status, 'ok');
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
  eq('降级提示语（链还活着）', B.api.degradedNote(), '索引器读不到：区块与交易改由本站直接读层内节点，历史与搜索暂时不可用');
  eq('feed（索引器独有）状态 = error', B.view.feed().status, 'error');

  // 层内那一半改由 bac-layer.js 直接读 RPC：**块和交易仍然是真数据**，只是来源不同
  eq('层内那段没有报错（RPC 读到了）', B.state.layer.error, null);
  eq('降级后层内数据来自 RPC', B.state.layer.source, 'rpc');
  eq('层内 RPC 读到的块高', B.state.layer.head, 0x12d687);
  eq('时间戳也是真读到的，不再是 null', B.state.layer.headTs, 1789999998);
  eq('区块列表来自 RPC', B.state.blocks.source, 'rpc');
  eq('区块视图状态 = ok（不是「发射后公布」）', B.view.blocks().status, 'ok');
  eq('交易视图状态 = ok', B.view.txs().status, 'ok');
  ok('确实读到了区块', B.view.blocks().items.length > 0);
  eq('出块间隔是实测出来的', B.view.chainStats().blockIntervalSec, 3);

  // BSC 一半必须仍然是真数
  eq('BSC 段仍然就绪', B.state.bsc.ready, true);
  eq('金库视图仍然 ok', B.view.treasury().status, 'ok');
  eq('金库数字仍然是真的', B.view.treasury().lifetimeToBridge, 12n * E18);
  eq('验证者的链上总量仍然在', B.view.validators().totalStaked, 5000000n * E18);
  eq('索引器挂了 → gas 三元组 null（链上没有这几个读函数，不编）', B.view.validators().gas, null);
  eq('链指标标了降级', B.view.chainStats().degraded, true);
  ok('链指标带降级说明', /直接读层内节点/.test(B.view.chainStats().degradedNote));
  eq('整页横幅', B.view.overview().degradedBanner, '索引器读不到：区块与交易改由本站直接读层内节点，历史与搜索暂时不可用');

  // 层内 RPC 也挂：source 回到 null，不许编数
  const env2 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ fail: true, layerRpcOk: false }), config: LIVE_CONFIG });
  await env2.BAC.api.run({ once: true });
  eq('两边都挂 → 来源为空', env2.BAC.state.layer.source, null);
  eq('两边都挂 → 块高仍是 null', env2.BAC.state.layer.head, null);
  eq('两边都挂 → LAYER_LIVE = false', env2.BAC.LAYER_LIVE, false);
  eq('两边都挂 → 提示语退回原来那句', env2.BAC.api.degradedNote(), '索引器读不到：层内数据暂时不可用，BSC 侧数字仍然是实时的');

  // 主用和兜底两个索引器地址都没配时不该发请求
  const log3 = [];
  const env3 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ log: log3 }), config: Object.assign({}, LIVE_CONFIG, { indexerBase: '', fallbackApi: '' }) });
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

/* ══════════════════════════════════════════════════════
   审查发现的回归：时间线截断 / 缺读补读 / 合约读不出来 / 实现槽每轮读 / 按天的奖池 /
   链上质押优先 / v1 索引器不当 v2 用 / Multicall3 探针不因一次抖动永久关掉
   （BacBridge.router() 是 Pancake 路由那一条在 stages 组里）
   ══════════════════════════════════════════════════════ */
await group('review', async () => {
  const NOTOKEN = { [lc(ADDR.token)]: '0x' };
  const IMPL3 = '0x' + 'a3'.repeat(20);
  const slotOf = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();

  /* ── 1. 时间线超过 timelineMax：扫描是全的，但列表丢过最旧的条目 → 不许说「全了」 ── */
  const many = [];
  for (let i = 0; i < 250; i++) {
    many.push(mkLog(ADDR.router, HEAD - 90 + Math.floor(i / 5), '0x' + (i + 1).toString(16).padStart(64, '0'), i % 5,
      'RevenueRecognized', { from: PROC, amount: 1n }));
  }
  const eT = makeEnv({ ethers: makeEthers(makeChain(FIXTURES_DEPLOYED), { logs: many, code: NOTOKEN }), fetchImpl: makeFetch(),
    config: BSC_ONLY(ADDR, { deployBlock: HEAD - 100 }) });
  await eT.BAC.chain.refresh({ reason: 'test' });
  const tT = eT.BAC.view.treasury();
  eq('截断 · 250 条流向只留 timelineMax 条', tT.flow.length, 200);
  eq('截断 · 扫描本身是全的（部署块扫到链头）', eT.BAC.state.timeline.complete, true);
  eq('截断 · 丢过条目 → timelineComplete = false', tT.timelineComplete, false);
  eq('截断 · 标出是哪条列表', tT.timelineTruncated.flow, true);
  eq('截断 · 节点基金那条没丢', tT.timelineTruncated.nodeFund, false);
  eq('截断 · 上限给出来', tT.timelineMax, 200);
  eq('截断 · 留下的是最新的', tT.flow[0].block, HEAD - 41);
  // 没超上限的对照：同样从部署块扫起 → 全
  const eT0 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES_DEPLOYED), { logs: many.slice(0, 20), code: NOTOKEN }), fetchImpl: makeFetch(),
    config: BSC_ONLY(ADDR, { deployBlock: HEAD - 100 }) });
  await eT0.BAC.chain.refresh({ reason: 'test' });
  eq('没超上限 · timelineComplete = true', eT0.BAC.view.treasury().timelineComplete, true);

  // owner 那条列表被截断：日志窗口那条路不算全；索引器的历史要覆盖到丢掉的最新那一块才算
  const pauses = [];
  for (let i = 0; i < 12; i++) {
    pauses.push(mkLog(ADDR.bridge, HEAD - 50 + i, '0x' + (0x100 + i).toString(16).padStart(64, '0'), 0, 'Paused',
      { by: WATCHDOG, until_: 1790003600, cumulative: 3600 }));
  }
  const eO = makeEnv({ ethers: makeEthers(makeChain(FIXTURES_DEPLOYED), { logs: pauses, code: NOTOKEN }), fetchImpl: makeFetch(),
    config: BSC_ONLY(ADDR, { deployBlock: HEAD - 100, timelineMax: 10 }) });
  await eO.BAC.chain.refresh({ reason: 'test' });
  const oO = eO.BAC.view.ownerPowers();
  eq('owner 截断 · 只留 10 条', oO.items.length, 10);
  eq('owner 截断 · 扫描是全的', eO.BAC.state.timeline.complete, true);
  eq('owner 截断 · complete = false', oO.complete, false);
  eq('owner 截断 · coverage.truncated', oO.coverage.truncated, true);
  eq('owner 截断 · 丢到哪一块', oO.coverage.droppedThrough, HEAD - 49);
  const idxCfg = (cursor) => ({
    ethers: makeEthers(makeChain(FIXTURES_DEPLOYED), { logs: pauses, code: NOTOKEN }),
    fetchImpl: makeFetch({ bodies: { '/api/health': Object.assign({}, API_BODY['/api/health'],
      { indexer: { layerCursor: 1, bscCursor: cursor, dbBytes: 1 } }) } }),
    config: Object.assign(BSC_ONLY(ADDR, { deployBlock: HEAD - 100, timelineMax: 10 }), { indexerBase: 'https://indexer.test' })
  });
  const eO2 = makeEnv(idxCfg(HEAD - 40));
  await eO2.BAC.chain.refresh({ reason: 'test' });
  await eO2.BAC.api.run({ once: true });
  eq('owner 截断 · 索引器覆盖到丢掉的块 → 全', eO2.BAC.view.ownerPowers().complete, true);
  eq('owner 截断 · 靠的是索引器', eO2.BAC.view.ownerPowers().completeVia, 'indexer');
  const eO3 = makeEnv(idxCfg(HEAD - 60));
  await eO3.BAC.chain.refresh({ reason: 'test' });
  await eO3.BAC.api.run({ once: true });
  eq('owner 截断 · 索引器没覆盖到丢掉的块 → 不全', eO3.BAC.view.ownerPowers().complete, false);

  /* ── 2. 接线参数：第一轮有两条没读到 → 不算核对通过；之后只补读缺的那几条 ── */
  const o3 = { failFns: ['nodeFund', 'OWNER_POWER_NOTICE'] };
  const cP = makeChain(FIXTURES_DEPLOYED, o3);
  const eP = makeEnv({ ethers: makeEthers(cP, { code: NOTOKEN }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eP.BAC.chain.refresh({ reason: 'test' });
  const p1 = eP.BAC.state.bsc.params;
  eq('缺读 · loaded = false', p1.loaded, false);
  ok('缺读 · missing 列出了没读到的', p1.missing.includes('r.nodeFund') && p1.missing.includes('b.notice'), p1.missing.join(','));
  eq('缺读 · 没核对过的不算通过（wiring.ok = null）', eP.BAC.view.bridge().wiring.ok, null);
  ok('缺读 · unchecked 列出 router.nodeFund', eP.BAC.view.bridge().wiring.unchecked.includes('router.nodeFund'), eP.BAC.view.bridge().wiring.unchecked.join(','));
  eq('缺读 · #29a 那句没读到 → null', eP.BAC.view.bridge().noticeMatches, null);
  ok('缺读 · 不算对不上，不告警', !eP.BAC.state.warnings.includes('wiring_mismatch'));
  o3.failFns = [];
  const bacTokenBefore = cP.log.calls.filter(f => f === 'bacToken').length;
  await eP.BAC.chain.refresh({ reason: 'test' });
  const p2 = eP.BAC.state.bsc.params;
  eq('补读 · loaded', p2.loaded, true);
  eq('补读 · complete', p2.complete, true);
  eqAddr('补读 · router.nodeFund 读到了', p2.router.nodeFund, ADDR.nodeFund);
  eq('补读 · 接线核对通过', eP.BAC.view.bridge().wiring.ok, true);
  eq('补读 · #29a 那句一致', eP.BAC.view.bridge().noticeMatches, true);
  eq('补读 · 只读缺的（bacToken 不重读）', cP.log.calls.filter(f => f === 'bacToken').length, bacTokenBefore);
  const nCalls = cP.log.calls.length;
  await eP.BAC.chain.refresh({ reason: 'test' });
  ok('读全了之后 · 不再读接线', !cP.log.calls.slice(nCalls).includes('OWNER_POWER_NOTICE') && !cP.log.calls.slice(nCalls).includes('identityRegistry'));

  // 代币参数：taxProcessor / marketAddress 没读到时不许把「硬检查」定格在 null
  const o4 = { failFns: ['taxProcessor'] };
  const cK = makeChain(FIXTURES, o4);
  const eK = makeEnv({ ethers: makeEthers(cK), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eK.BAC.chain.refresh({ reason: 'test' });
  eq('taxProcessor 没读到 · tokenParams.loaded = false', eK.BAC.state.bsc.tokenParams.loaded, false);
  eq('taxProcessor 没读到 · marketAddressOk = null', eK.BAC.view.token().marketAddressOk, null);
  eq('taxProcessor 没读到 · 待分发税没读', eK.BAC.view.token().pendingTax, null);
  o4.failFns = ['marketAddress'];
  await eK.BAC.chain.refresh({ reason: 'test' });
  eq('market 没读到 · loaded 仍是 false', eK.BAC.state.bsc.tokenParams.loaded, false);
  eq('market 没读到 · marketAddressOk = null', eK.BAC.view.token().marketAddressOk, null);
  eq('market 没读到 · 协议费读到了', eK.BAC.view.token().taxFeeRateBps, 1000);
  o4.failFns = [];
  await eK.BAC.chain.refresh({ reason: 'test' });
  eq('补读 · tokenParams.loaded', eK.BAC.state.bsc.tokenParams.loaded, true);
  eq('补读 · marketAddressOk = true', eK.BAC.view.token().marketAddressOk, true);
  eq('补读 · 待分发税', eK.BAC.view.token().pendingTax, 30000000000000000n);

  /* ── 3. 地址上有代码、合约一条都读不出来 → 「读取失败」，不是 ok 配一屏 null ── */
  const o6 = { failFns: Object.keys(FIXTURES_DEPLOYED) };
  const cF = makeChain(FIXTURES_DEPLOYED, o6);
  const eF = makeEnv({ ethers: makeEthers(cF, { code: NOTOKEN }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eF.BAC.chain.refresh({ reason: 'test' });
  eq('读不出 · 阶段仍是 deployed', eF.BAC.STAGE, 'deployed');
  eq('读不出 · bsc.error = NO_VAULT', eF.BAC.state.bsc.error, eF.BAC.TEXT.NO_VAULT);
  eq('读不出 · bsc.status error', eF.BAC.state.bsc.status, 'error');
  eq('读不出 · 路由视图 error', eF.BAC.view.treasury().status, 'error');
  eq('读不出 · 桥视图 error', eF.BAC.view.bridge().status, 'error');
  eq('读不出 · owner 视图 error', eF.BAC.view.ownerPowers().status, 'error');
  ok('读不出 · 告警 contract_reads_failed', eF.BAC.state.warnings.includes('contract_reads_failed'), eF.BAC.state.warnings.join(','));
  ok('读不出 · failedContracts 列出路由和桥', ['router', 'bridge'].every(k => eF.BAC.view.overview().failedContracts.includes(k)));
  o6.failFns = [];
  await eF.BAC.chain.refresh({ reason: 'test' });
  eq('恢复 · 路由视图 ok', eF.BAC.view.treasury().status, 'ok');
  eq('恢复 · bsc.error 清掉', eF.BAC.state.bsc.error, null);
  ok('恢复 · 告警清掉', !eF.BAC.state.warnings.includes('contract_reads_failed'));
  eq('恢复 · 真的 0', eF.BAC.view.treasury().lifetimeToBridge, 0n);
  // 只有桥读不出来：桥那一段 error，路由那一段照常 ok（部分失败的字段是 null）
  const BRIDGE_CORE_FNS = ['owner', 'lockedBac', 'totalCreditsIssued', 'creditsOutstanding', 'depositId', 'bnbBalance',
    'upgradeCount', 'emergencyCount', 'lastSettledEpoch'];
  const eF2 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES_DEPLOYED, { failFns: BRIDGE_CORE_FNS }), { code: NOTOKEN }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eF2.BAC.chain.refresh({ reason: 'test' });
  eq('只有桥读不出 · 桥视图 error', eF2.BAC.view.bridge().status, 'error');
  eq('只有桥读不出 · 路由视图照常 ok', eF2.BAC.view.treasury().status, 'ok');
  ok('只有桥读不出 · 告警', eF2.BAC.state.warnings.includes('contract_reads_failed'));
  // 节点全挂（网络）：同样走错误路径，但文案是「读取失败」，上一轮的真数保留并标成旧数
  let down = false;
  const eF3 = makeEnv({
    ethers: makeEthers(makeChain(FIXTURES_DEPLOYED), { code: NOTOKEN,
      'https://rpc-a.test': () => (down ? Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }) : null) }),
    fetchImpl: makeFetch(), config: BSC_ONLY(ADDR)
  });
  await eF3.BAC.chain.refresh({ reason: 'test' });
  eq('节点挂之前 · ok', eF3.BAC.view.treasury().status, 'ok');
  down = true;
  await eF3.BAC.chain.refresh({ reason: 'test' });
  eq('节点全挂 · 读取失败文案', eF3.BAC.state.bsc.error, eF3.BAC.TEXT.ERR);
  eq('节点全挂 · 路由视图 error', eF3.BAC.view.treasury().status, 'error');
  eq('节点全挂 · 标成旧数', eF3.BAC.state.bsc.stale, true);
  eq('节点全挂 · 上一轮的真数没被 null 盖掉', eF3.BAC.state.bsc.treasury.lifetimeToBridge, 0n);
  ok('节点全挂 · 不算合约读不出来（不拉那条告警）', !eF3.BAC.state.warnings.includes('contract_reads_failed'));

  /* ── 4. 实现槽每轮都读：槽变了、升级计数器没变 → 读到新实现、告警、记下来 ── */
  let slot = slotOf(IMPL2);
  const cS = makeChain(FIXTURES_DEPLOYED);
  const eS = makeEnv({ ethers: makeEthers(cS, { implSlot: () => slot, code: NOTOKEN }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eS.BAC.chain.refresh({ reason: 'test' });
  eqAddr('实现槽 · 第一次', eS.BAC.view.bridge().implementation, IMPL2);
  ok('实现槽 · 起初没有告警', !eS.BAC.state.warnings.includes('implementation_changed_unlogged'));
  slot = slotOf(IMPL3);
  await eS.BAC.chain.refresh({ reason: 'test' });
  eqAddr('计数器没变、槽变了 → 读到新实现', eS.BAC.view.bridge().implementation, IMPL3);
  eq('每一轮都读了槽', cS.log.getStorage, 2);
  ok('没留痕的换实现 → 告警', eS.BAC.state.warnings.includes('implementation_changed_unlogged'), eS.BAC.state.warnings.join(','));
  const sc = eS.BAC.view.ownerPowers().unlogged.slotChanges;
  eq('记下了一次', sc.length, 1);
  if (sc.length) { eqAddr('从', sc[0].from, IMPL2); eqAddr('到', sc[0].to, IMPL3); eq('当时的升级计数', sc[0].upgradeCount, 0); }
  const noticeReads = cS.log.calls.filter(f => f === 'OWNER_POWER_NOTICE').length;
  await eS.BAC.chain.refresh({ reason: 'test' });
  eq('换了实现 → 接线全部重读', cS.log.calls.filter(f => f === 'OWNER_POWER_NOTICE').length, noticeReads + 1);
  // 竞态：一次正常升级正好落在「读计数器」和「读槽」之间 → 读槽后再读一次计数器，变了就不是没留痕
  const seq = [0n, 0n, 1n];
  let slotR = slotOf(IMPL2);
  const eR = makeEnv({ ethers: makeEthers(makeChain(Object.assign({}, FIXTURES_DEPLOYED, { upgradeCount: () => [seq.length ? seq.shift() : 1n] })),
    { implSlot: () => slotR, code: NOTOKEN }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eR.BAC.chain.refresh({ reason: 'test' });
  slotR = slotOf(IMPL3);
  await eR.BAC.chain.refresh({ reason: 'test' });
  eqAddr('竞态 · 读到新实现', eR.BAC.view.bridge().implementation, IMPL3);
  ok('竞态 · 复查计数器已经变了 → 不告警', !eR.BAC.state.warnings.includes('implementation_changed_unlogged'), eR.BAC.state.warnings.join(','));
  eq('竞态 · 不记没留痕的换实现', eR.BAC.view.ownerPowers().unlogged.slotChanges.length, 0);
  await eR.BAC.chain.refresh({ reason: 'test' });
  ok('竞态 · 下一轮也不告警', !eR.BAC.state.warnings.includes('implementation_changed_unlogged'));
  // 正常升级（计数器跟着变）不告警
  let ups = 0n, slotB = slotOf(IMPL2);
  const eS2 = makeEnv({ ethers: makeEthers(makeChain(Object.assign({}, FIXTURES_DEPLOYED, { upgradeCount: () => [ups] })), { implSlot: () => slotB, code: NOTOKEN }),
    fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eS2.BAC.chain.refresh({ reason: 'test' });
  ups = 1n; slotB = slotOf(IMPL3);
  await eS2.BAC.chain.refresh({ reason: 'test' });
  eqAddr('正常升级 · 新实现', eS2.BAC.view.bridge().implementation, IMPL3);
  ok('正常升级 · 不告警', !eS2.BAC.state.warnings.includes('implementation_changed_unlogged'));
  // 单独的 Upgraded（不和 Initialized(1) 同一笔，也没有 BridgeUpgraded）= 没留痕的换实现，不是「初始实现」
  const lone = [mkLog(ADDR.bridge, HEAD - 30, '0x' + 'e5'.repeat(32), 0, 'Upgraded', { implementation: IMPL3 })];
  const eL = makeEnv({ ethers: makeEthers(makeChain(FIXTURES_DEPLOYED), { logs: lone, code: NOTOKEN }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eL.BAC.chain.refresh({ reason: 'test' });
  const oL = eL.BAC.view.ownerPowers();
  const imp = oL.items.find(x => x.kind === 'implementation');
  ok('单独的 Upgraded 上了时间线', !!imp);
  if (imp) { eq('单独的 Upgraded · 不是初始实现', imp.initial, false); eq('单独的 Upgraded · 没留痕', imp.unlogged, true); }
  eq('单独的 Upgraded · 计数', oL.unlogged.upgradedEvents, 1);
  ok('单独的 Upgraded · 告警', eL.BAC.state.warnings.includes('implementation_changed_unlogged'));
  // 时间线全了，但日志里最后一次换到的实现不是槽里那个 → 对不上
  const TDX = '0x' + 'd9'.repeat(32);
  const deployOnly = [
    mkLog(ADDR.bridge, HEAD - 80, TDX, 0, 'Upgraded', { implementation: IMPL1 }),
    mkLog(ADDR.bridge, HEAD - 80, TDX, 1, 'OwnershipTransferred', { previousOwner: ZERO, newOwner: OWNER }),
    mkLog(ADDR.bridge, HEAD - 80, TDX, 2, 'Initialized', { version: 1 })
  ];
  const eM2 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES_DEPLOYED), { logs: deployOnly, code: NOTOKEN }), fetchImpl: makeFetch(),
    config: BSC_ONLY(ADDR, { deployBlock: HEAD - 80 }) });
  await eM2.BAC.chain.refresh({ reason: 'test' });
  const oM2 = eM2.BAC.view.ownerPowers();
  eq('部署那笔的 Upgraded · 初始实现', oM2.items.find(x => x.kind === 'implementation').initial, true);
  eq('时间线全了', oM2.complete, true);
  eqAddr('日志里的实现', oM2.loggedImplementation, IMPL1);
  eq('槽里是另一个实现、日志里没有这次升级 → 对不上', oM2.implementationMatchesLog, false);

  /* ── 5. 奖池按「天」：读 dayReward(floor(epoch / 144))，不把一天的池子标成「本纪元」 ── */
  const cD = makeChain(FIXTURES);
  const eD = makeEnv({ ethers: makeEthers(cD), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eD.BAC.chain.refresh({ reason: 'test' });
  const vD = eD.BAC.view.validators();
  ok('奖池 · 读的是 dayReward', cD.log.calls.includes('dayReward'));
  ok('奖池 · 不读 epochReward', !cD.log.calls.includes('epochReward'));
  eq('奖池 · day = floor(lastPostedEpoch / 144)', vD.rewardDay, Math.floor(2983332 / 144));
  eq('奖池 · 那一天的池子', vD.dayPot, 1n * E18);
  eq('奖池 · 那一天的权重', vD.dayWeight, 5000000n * E18);
  eq('奖池 · 那一天已结算', vD.daySettled, true);
  eq('奖池 · 一天 144 个纪元', vD.epochsPerDay, 144);
  eq('奖池 · 没有「本纪元的奖池」→ epochPot null', vD.epochPot, null);
  eq('奖池 · epochSettled null', vD.epochSettled, null);
  const eAbi = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  ok('ABI · rewardOf 的第一个参数叫 day', eAbi.BAC.chain.ABI.staking.some(s => /rewardOf\(uint64 day,/.test(s)));

  /* ── 6. 总质押：链上直读优先；索引器的 "0" 不是测量值 ── */
  const V0 = { schema: 'bac/validators/1', items: [], totalStaked: '0', rewardBalance: '0' };
  const eV = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ bodies: { '/api/validators': V0 } }), config: LIVE_CONFIG });
  await eV.BAC.chain.refresh({ reason: 'test' });
  await eV.BAC.api.run({ once: true });
  eq('质押 · 链上 500 万、索引器 "0" → 显示链上的', eV.BAC.view.validators().totalStaked, 5000000n * E18);
  eq('质押 · 来源 chain', eV.BAC.view.validators().totalStakedSource, 'chain');
  eq('质押 · 奖励余额也取链上', eV.BAC.view.validators().rewardBalance, 300000000000000000n);
  const eV2 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES, { failFns: ['totalStaked'] })), fetchImpl: makeFetch(), config: LIVE_CONFIG });
  await eV2.BAC.chain.refresh({ reason: 'test' });
  await eV2.BAC.api.run({ once: true });
  eq('质押 · 链上那条没读到 → 才用索引器的', eV2.BAC.view.validators().totalStaked, 5000000n * E18);
  eq('质押 · 来源标成 indexer', eV2.BAC.view.validators().totalStakedSource, 'indexer');
  const eV3 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ bodies: { '/api/validators': V0 } }),
    config: Object.assign({}, LIVE_CONFIG, { addresses: Object.assign({}, ADDR, { staking: '0x0' }) }) });
  await eV3.BAC.chain.refresh({ reason: 'test' });
  await eV3.BAC.api.run({ once: true });
  eq('质押 · 本站没配 staking → 索引器的 "0" 不显示', eV3.BAC.view.validators().totalStaked, null);
  eq('质押 · 奖励余额同理', eV3.BAC.view.validators().rewardBalance, null);

  /* ── 7. agent 名录：v1 索引器（AgentRegistry）的条目和总数不当 v2 用；不是 ok 就不给数字 ── */
  const eA = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ bodies: { '/api/agents': API_AGENTS_V1 } }), config: LIVE_CONFIG });
  await eA.BAC.api.run({ once: true });
  const gA = eA.BAC.view.agents({});
  eq('v1 索引器 · 条目不用', gA.items.length, 0);
  eq('v1 索引器 · 总数不用（它数的是已删掉的 AgentRegistry）', gA.total, null);
  eq('v1 索引器 · 名录还在读链上（loading）', gA.status, 'loading');
  eq('v1 索引器 · counts null', gA.counts, null);
  // summary /1 的 agents.total 同样不用
  const eA2 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch({ bodies: { '/api/agents': null } }), config: LIVE_CONFIG });
  await eA2.BAC.api.run({ once: true });
  eq('summary /1 · 总数不用', eA2.BAC.view.agents({}).total, null);
  // 链上名录读失败（error）：不给数字
  const eA3 = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eA3.BAC.chain.refresh({ reason: 'test' });
  eA3.BAC.state.agentDir.error = eA3.BAC.TEXT.ERR; eA3.BAC.state.agentDir.status = 'error';
  eq('名录 error · status', eA3.BAC.view.agents({}).status, 'error');
  eq('名录 error · 不给总数', eA3.BAC.view.agents({}).total, null);
  eq('名录 error · 不给「至少」', eA3.BAC.view.agents({}).totalAtLeast, null);

  /* ── 8. Multicall3 探针：一次网络抖动不许让整页永久退成逐条 eth_call ── */
  const bM = { mcProbeFail: 1 };
  const cM = makeChain(FIXTURES);
  const eMc = makeEnv({ ethers: makeEthers(cM, bM), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  const m1 = await eMc.BAC.chain.multi([eMc.BAC.chain.call(ADDR.bridge, 'bridge', 'x', 'bnbBalance')]);
  eq('探针没答上 · 这一次逐条读', cM.log.aggregate.length, 0);
  eq('探针没答上 · 逐条照样读到', m1.x, 9n * E18);
  eq('探针没答上 · 不下「没有 Multicall3」的结论', eMc.BAC.chain._probeState.probed, false);
  ok('探针没答上 · 定了下次再探的时间', eMc.BAC.chain._probeState.retryAt > 0);
  await eMc.BAC.chain.multi([eMc.BAC.chain.call(ADDR.bridge, 'bridge', 'x', 'bnbBalance')]);
  eq('退避中 · 不反复探', cM.log.getCode, 1);
  eMc.BAC.chain._probeState.retryAt = 1;   // 退避到期
  await eMc.BAC.chain.multi([eMc.BAC.chain.call(ADDR.bridge, 'bridge', 'x', 'bnbBalance')]);
  eq('退避到期再探 · 用上 aggregate3', cM.log.aggregate.length, 1);
  eq('退避到期再探 · 这回定论了', eMc.BAC.chain._probeState.available, true);
  // 链上确实没有 Multicall3（逐条模式）：名录每轮最多逐条读 plainDepositsPerTick 笔，身份只给新出现的读几个
  const deps = {};
  for (let i = 0; i < 100; i++) deps[i] = [OWNER, 1789900000 + i, BigInt(2000 + i), 1n * E18];
  const cN = makeChain(Object.assign({}, FIXTURES, { depositId: [100n], deposits: (args) => deps[Number(args[0])], ownerOf: [OWNER] }));
  const eN = makeEnv({ ethers: makeEthers(cN, { noMulticall: true }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eN.BAC.chain.refresh({ reason: 'test' });
  eq('逐条模式 · 存入这一轮只读 40 笔', cN.log.calls.filter(f => f === 'deposits').length, 40);
  ok('逐条模式 · 身份只读几个（每个 6 条）', cN.log.calls.filter(f => f === 'ownerOf').length <= 6, String(cN.log.calls.filter(f => f === 'ownerOf').length));
  eq('逐条模式 · 没读全 → total null', eN.BAC.view.agents({}).total, null);
  eq('逐条模式 · 至少 40 个', eN.BAC.view.agents({}).totalAtLeast, 40);
  eq('逐条模式 · 标出身份暂停', eN.BAC.view.agents({}).identityPaused, true);
  eq('逐条模式 · 读的是最新的存入', eN.BAC.view.agents({}).items[0].lastDepositId, 99);
  await eN.BAC.chain.refresh({ reason: 'test' });
  eq('逐条模式 · 下一轮接着补 40 笔', cN.log.calls.filter(f => f === 'deposits').length, 80);
  // 逐条读的两个数可能不在同一个区块：推出来的 BNB 缺口不作数
  const eQ = makeEnv({ ethers: makeEthers(makeChain(FIXTURES_DEPLOYED), { noMulticall: true, code: NOTOKEN }), fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  await eQ.BAC.chain.refresh({ reason: 'test' });
  eq('逐条模式 · 推出来的 BNB 缺口不作数（null）', eQ.BAC.view.bridge().shortfall.bnb, null);
  eq('逐条模式 · BAC 那一半照旧确定是 0', eQ.BAC.view.bridge().shortfall.bac, 0n);

  eq('全程没有碰 DOM', eT.domHits.length + eP.domHits.length + eF.domHits.length + eS.domHits.length + eN.domHits.length, 0);
});

/* ══════════════════════════════════════════════════════
   发布前检查：web/site.config.js 必须带上已锁定的代币地址（决策 #35）。
   没有它 BAC.TOKEN_CONFIGURED = false：代币地址不探代码，发射当天页面不会自己翻到 launched。
   平时只打印提醒；--release 时算失败。
   ══════════════════════════════════════════════════════ */
await group('release', async () => {
  const real = makeEnv({ ethers: makeEthers(makeChain(FIXTURES)), fetchImpl: makeFetch(), rawConfig: true });
  const got = real.BAC.CFG.addresses.token;
  const tokenOk = typeof got === 'string' && got.toLowerCase() === REAL_TOKEN.toLowerCase();
  if (release) {
    ok('发布前 · web/site.config.js 的代币地址是已锁定的 CA', tokenOk, String(got));
    ok('发布前 · web/site.config.js 没有 v1 的键', real.BAC.CFG.legacyKeys.length === 0, real.BAC.CFG.legacyKeys.join(','));
  } else if (!tokenOk || real.BAC.CFG.legacyKeys.length) {
    console.log('  提醒：web/site.config.js 的 addresses.token = ' + got + '（已锁定的 CA 是 ' + REAL_TOKEN + '）'
      + (real.BAC.CFG.legacyKeys.length ? '，还有 v1 的键 ' + real.BAC.CFG.legacyKeys.join('/') : '')
      + '。上线前用 artifacts/data-check/site.config.proposed.js 换掉它；--release 会把这条算作失败。');
  }
});

/* ══════════════════════════════════════════════════════
   ABI 与 forge 编译产物逐条核对（有 contracts/out 时才核）
   上面的假 ethers 从不真正编码，selector / topic 的漂移在那里测不出来：这里用网站自带的
   真 ethers（web/vendor/ethers-6.13.4.umd.min.js）把数据层的每一条人类可读 ABI 和编译产物对一遍，
   再用编译产物真编一条日志，走数据层的 decodeLog 解回来。
   ══════════════════════════════════════════════════════ */
await group('abi', async () => {
  const OUT = join(HERE, '..', '..', 'contracts', 'out');
  const readAbi = (p) => { try { return JSON.parse(readFileSync(join(OUT, p), 'utf8')).abi; } catch (e) { return null; } };
  if (!existsSync(OUT) || !readAbi('BacBridge.sol/BacBridge.json')) {
    console.log('  （跳过：没有 contracts/out，先在 contracts/ 里 forge build）');
    return;
  }
  const esb = { console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout, Promise, BigInt, JSON, Math, Date, Number, String,
    Object, Array, Error, RegExp, isFinite, encodeURIComponent, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto };
  vm.createContext(esb);
  vm.runInContext('var window = globalThis; var self = globalThis;', esb);
  vm.runInContext(readFileSync(join(WEB, 'vendor', 'ethers-6.13.4.umd.min.js'), 'utf8'), esb, { filename: 'ethers.umd.js' });
  const RE = esb.ethers;
  ok('真 ethers 加载成功', !!RE && RE.version === '6.13.4', RE && RE.version);
  if (!RE) return;
  const env = makeEnv({ ethers: RE, fetchImpl: makeFetch(), config: BSC_ONLY(ADDR) });
  const ABI = env.BAC.chain.ABI;

  /* 我们自己的合约：每个函数（selector + 返回类型）、每个事件（topic + indexed + 参数名）都必须在编译产物里 */
  const OURS = {
    router: ['BacTaxRouter.sol/BacTaxRouter.json'],
    bridge: ['BacBridge.sol/BacBridge.json', 'BacBridge.sol/BacBridgeExtension.json'],   // 代理 → BacBridge，没有的 selector 委托给 EXTENSION
    nodeFund: ['BacNodeFund.sol/BacNodeFund.json'],
    anchor: ['ChainAnchor.sol/ChainAnchor.json'],
    staking: ['ValidatorStaking.sol/ValidatorStaking.json'],
    // 外部合约：用我们仓库里的接口文件（标准 ERC-20 / ERC-721 元数据函数另从 OZ 的接口取）
    identity: ['IERC8004Identity.sol/IErc8004Identity.json', 'IERC721Metadata.sol/IERC721Metadata.json'],
    portal: ['IPortal.sol/IPortal.json'],
    taxProcessor: ['ITaxProcessor.sol/ITaxProcessor.json'],
    token: ['IFlapTaxTokenV3.sol/IFlapTaxTokenV3.json', 'IERC20Metadata.sol/IERC20Metadata.json'],
    multicall3: ['IMulticall3.sol/IMulticall3.json']
  };
  const evSig = (e) => e.name + '(' + e.inputs.map(i => i.type + (i.indexed ? ' indexed' : '') + ' ' + i.name).join(',') + ')';
  for (const [name, files] of Object.entries(OURS)) {
    const abis = files.map(readAbi).filter(Boolean);
    if (!abis.length) { ok(name + ' · 编译产物存在', false, files.join(',')); continue; }
    const compiled = abis.map(a => new RE.Interface(a));
    const ours = new RE.Interface(ABI[name]);
    const missing = [], outDiff = [], evDiff = [];
    ours.forEachFunction(f => {
      let g = null;
      for (const I of compiled) { g = I.getFunction(f.selector); if (g) break; }
      if (!g) { missing.push(f.format('sighash')); return; }
      const o1 = f.outputs.map(x => x.format()).join(','), o2 = g.outputs.map(x => x.format()).join(',');
      if (o1 !== o2) outDiff.push(f.format('sighash') + ' 我们=' + o1 + ' 合约=' + o2);
    });
    ours.forEachEvent(e => {
      let g = null;
      for (const I of compiled) { g = I.getEvent(e.topicHash); if (g) break; }
      if (!g) { missing.push('event ' + e.format('sighash')); return; }
      if (evSig(e) !== evSig(g)) evDiff.push(evSig(e) + ' ≠ ' + evSig(g));
    });
    ok(name + ' · 每个函数 / 事件都在编译产物里', missing.length === 0, missing.join(' | '));
    ok(name + ' · 返回类型一致', outDiff.length === 0, outDiff.join(' | '));
    ok(name + ' · 事件的 indexed 与参数名一致', evDiff.length === 0, evDiff.join(' | '));
  }
  // 反过来：桥的 owner 权力事件（决策 #29c）一个都不能漏
  const bridgeOut = new RE.Interface(readAbi('BacBridge.sol/BacBridge.json'));
  const oursBridge = new RE.Interface(ABI.bridge);
  for (const ev of ['BridgeUpgraded', 'EmergencyWithdraw', 'Upgraded', 'OwnershipTransferred', 'OwnershipTransferStarted',
    'Paused', 'Unpaused', 'Halted', 'EscapeArmed', 'EscapeArmCancelled', 'EpochOwedRevoked', 'Initialized']) {
    ok('桥 · 时间线事件 ' + ev + ' 两边都有', !!bridgeOut.getEvent(ev) && !!oursBridge.getEvent(ev));
  }
  // 路由：决策 #32 之后没有 owner（ABI 里不许读 owner()）
  ok('路由 · 数据层不读 owner()', !ABI.router.some(s => / owner\(/.test(s)));

  /* 用编译产物真编日志 → 数据层 decodeLog 解回来（topic / 参数顺序 / indexed 一处不对就解不出来） */
  function realLog(address, file, name, values, block = HEAD - 10, logIndex = 0) {
    const I = new RE.Interface(readAbi(file));
    const ev = I.getEvent(name);
    const enc = I.encodeEventLog(ev, values);
    return { address, blockNumber: block, transactionHash: '0x' + 'ab'.repeat(32), index: logIndex, topics: enc.topics, data: enc.data };
  }
  const D = env.BAC.chain.decodeLog;
  const up = D(realLog(ADDR.bridge, 'BacBridge.sol/BacBridge.json', 'BridgeUpgraded',
    [IMPL2, IMPL1, OWNER, 2n, 1789990000n, 9n * E18, 5n * E18, 8n * E18, 4n * E18]));
  ok('真日志 · BridgeUpgraded 解得出来', !!up && up.item.kind === 'upgrade');
  if (up) {
    eqAddr('真日志 · 新实现', up.item.newImplementation, IMPL2);
    eq('真日志 · 第几次', up.item.number, 2);
    eq('真日志 · 时间（字段名 at 不撞 Array.prototype.at）', up.item.ts, 1789990000);
    eq('真日志 · 账面 owedTotal', up.item.books.owedTotal, 4n * E18);
  }
  const em = D(realLog(ADDR.bridge, 'BacBridge.sol/BacBridge.json', 'EmergencyWithdraw',
    [OWNER, OTHER, ZERO, 3n * E18, 6n * E18, 9n * E18, 3n * E18, 1n, 1789995000n]));
  ok('真日志 · EmergencyWithdraw 解得出来', !!em && em.item.kind === 'emergency');
  if (em) { eq('真日志 · 资产 BNB', em.item.asset, 'BNB'); eq('真日志 · 金额', em.item.amount, 3n * E18); eqAddr('真日志 · 收款人', em.item.to, OTHER); }
  const sp = D(realLog(ADDR.router, 'BacTaxRouter.sol/BacTaxRouter.json', 'RevenueSplit', [45n, 45n]));
  ok('真日志 · RevenueSplit 解得出来', !!sp && sp.item.kind === 'split' && sp.item.toBridge === 45n);
  const pf = D(realLog(ADDR.router, 'BacTaxRouter.sol/BacTaxRouter.json', 'PushFailed', [ADDR.nodeFund, 7n]));
  ok('真日志 · PushFailed 解得出来', !!pf && pf.item.kind === 'push' && pf.item.ok === false && pf.item.target === 'nodeFund');
  const wd = D(realLog(ADDR.nodeFund, 'BacNodeFund.sol/BacNodeFund.json', 'Withdrawn', [OWNER, 5n, 0n]));
  ok('真日志 · 节点基金 Withdrawn 解得出来', !!wd && wd.list === 'nodeFund' && wd.item.kind === 'withdraw' && wd.item.amount === 5n);
  const arm = D(realLog(ADDR.bridge, 'BacBridge.sol/BacBridge.json', 'EscapeArmed', [WATCHDOG, 1, 1791000000n]));
  ok('真日志 · EscapeArmed 解得出来', !!arm && arm.item.kind === 'escapeArmed' && arm.item.effectiveAt === 1791000000);
  const init = D(realLog(ADDR.bridge, 'BacBridge.sol/BacBridge.json', 'Initialized', [1]));
  ok('真日志 · Initialized 解得出来', !!init && init.item.kind === 'initialized' && init.item.version === 1);
  // 同签名不同合约：桥与节点基金的 ReleaseReceived 靠地址区分
  const rrB = D(realLog(ADDR.bridge, 'BacBridge.sol/BacBridge.json', 'ReleaseReceived', [ADDR.router, 1n, 2n]));
  const rrN = D(realLog(ADDR.nodeFund, 'BacNodeFund.sol/BacNodeFund.json', 'ReleaseReceived', [ADDR.router, 1n, 2n]));
  ok('真日志 · 桥的 ReleaseReceived 进税收流向', !!rrB && rrB.list === 'flow' && rrB.item.bnbAfter === 2n);
  ok('真日志 · 节点基金的 ReleaseReceived 进节点基金', !!rrN && rrN.list === 'nodeFund' && rrN.item.balanceAfter === 2n);
  // 真编码的 multicall 调用：锚点 firstEpoch 的 selector 与编译产物一致
  const anchorOut = new RE.Interface(readAbi('ChainAnchor.sol/ChainAnchor.json'));
  eq('firstEpoch() selector', new RE.Interface(ABI.anchor).getFunction('firstEpoch').selector, anchorOut.getFunction('firstEpoch').selector);
});

console.log('\n──────────────────────────────');
console.log('通过 ' + pass + ' · 失败 ' + fail);
if (failures.length) {
  console.log('\n失败清单:');
  failures.forEach(f => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
