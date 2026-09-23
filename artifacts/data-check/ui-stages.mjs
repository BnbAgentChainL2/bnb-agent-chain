/* 可视层三阶段验收：node artifacts/data-check/ui-stages.mjs [--shots]
   用真的 web/（index.html + js/data/* + js/ui/*）在 Chromium 里跑，只把 vendor/ethers 换成一个假的
   （和 unit.mjs 同一套「十六进制 JSON」编码 + 固定夹具），所有外部请求一律掐断。
   三个阶段各开一页，核对：
     none     合约 / 代币的数一律「发射后公布」；
     deployed 合约的数是真的（包括真的 0、owner、升级 0 次），代币的数「发射后公布」；
     launched 全部是真数；项目方权限记录、税收流向、ERC-8004 名录都画出来。
   另外：中英切换后没有漏译的中文（BACI18N.untranslated）、390px 下不横向溢出、页面没有报错。
   不连主网、不需要私钥、不部署、不提交。 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import http from 'node:http';
import fs from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WEB = join(ROOT, 'web');
const require = createRequire(join(ROOT, 'artifacts', 'site-shots', 'package.json'));
const { chromium } = require('playwright');
const SHOTS = process.argv.includes('--shots');
const OUT = join(HERE, 'out');
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' → ' + detail : '')); }
}

/* ── 静态服务器 ───────────────────────────────────── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  let f = join(WEB, decodeURIComponent(q.url.split('?')[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});
await new Promise(res => srv.listen(0, '127.0.0.1', res));
const PORT = srv.address().port;
const BASE = 'http://127.0.0.1:' + PORT + '/';

/* ── 浏览器里的假 ethers（夹具与 unit.mjs 的 FIXTURES / FIXTURES_DEPLOYED 同形） ── */
const FAKE_ETHERS = (stage) => `
(function () {
  var STAGE = ${JSON.stringify(stage)};
  function hex(s) { var b = new TextEncoder().encode(s), o = '0x'; for (var i = 0; i < b.length; i++) o += b[i].toString(16).padStart(2, '0'); return o; }
  function unhex(h) { h = String(h).slice(2); var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return new TextDecoder().decode(a); }
  function enc(v) { return hex(JSON.stringify(v, function (k, x) { return typeof x === 'bigint' ? { __b: x.toString() } : x; })); }
  function dec(h) { return JSON.parse(unhex(h), function (k, x) { return (x && x.__b !== undefined) ? BigInt(x.__b) : x; }); }
  var E18 = 1000000000000000000n;
  var lc = function (a) { return String(a).toLowerCase(); };
  var A = window.__ADDR || {};
  var TOKEN = '0xA97452d175679B2bF5F25a9a382D22aff39b7777';
  var REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
  var PANCAKE = '0x10ED43C718714eb63d5aA57B78B54704E256024E', PROC = '0x9999999999999999999999999999999999999999';
  var OWNER = '0x934a6678120b85652D2CC818C69774ea17012844', OTHER = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
  var WATCHDOG = '0x51b6D9a3665c74FFef80ca8d3898edB9DeBcDb55', ZERO = '0x0000000000000000000000000000000000000000';
  var IMPL1 = '0x' + 'a1'.repeat(20), IMPL2 = '0x' + 'a2'.repeat(20), EXT = '0x' + 'e7'.repeat(20);
  var NOTICE = '项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。';
  var HEAD = 123456789, HEAD_TS = Math.floor(Date.now() / 1000);
  var WALLET17 = '0x' + 'be'.repeat(20);
  var URI17 = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Clawbot 爪子 <b>x</b>',
    description: '我自己说我是个 AI', image: 'https://evil.example/track.png' }))));
  var DEPOSITS = { 0: [OWNER, HEAD_TS - 100000, 17n, 250000n * E18], 1: [OTHER, HEAD_TS - 50000, 99n, 1000n * E18], 2: [OWNER, HEAD_TS - 40000, 17n, 50000n * E18] };
  function ethBal(map) { return function (args) { var v = map[lc(args[0])]; return v === undefined ? undefined : [v]; }; }
  var bal = {}; bal[lc(A.router)] = 500000000000000000n; bal[lc(A.bridge)] = 8n * E18; bal[lc(A.nodeFund)] = 400000000000000000n;
  var F = {
    bacToken: [TOKEN], bridge: [A.bridge], nodeFund: [A.nodeFund], BRIDGE_BPS: [5000], PUSH_GAS: [100000n],
    accountedQuote: [500000000000000000n], unsplitRevenue: [500000000000000000n],
    lifetimeToBridge: [12n * E18], lifetimeToNodeFund: [12n * E18], totalRecognized: [24n * E18 + 500000000000000000n],
    stuckAmounts: [[0n, 450000000000000000n]], solvency: [[500000000000000000n, 500000000000000000n, 500000000000000000n]],
    getEthBalance: ethBal(bal),
    name: ['BNB Agent Chain'], symbol: ['BAC'], decimals: [18], totalSupply: [10n ** 27n],
    taxRate: [200], buyTaxRate: [200], sellTaxRate: [200], taxProcessor: [PROC],
    balanceOf: function (args) { return lc(args[0]) === lc(A.bridge) ? [4n * E18] : [0n]; },
    marketAddress: [A.router], feeConfigV2: [[10000, 0, 0, 0, 1000, false, 0, ZERO]],
    marketQuoteBalance: [30000000000000000n], totalQuoteSentToMarketing: [27n * E18],
    getTokenV8Safe: [[1, 10n * E18, 300000000n * E18, 31000000000n, 6, 0n, 0n, 0n, 800000000n * E18, ZERO, false,
      '0x' + '00'.repeat(32), 200n, 200n, ZERO, 420000000000000000n, 0, 0]],
    owner: [OWNER], pendingOwner: [ZERO], identityRegistry: [REGISTRY], anchor: [A.anchor], watchdog: [WATCHDOG],
    portal: [PORTAL], router: function (args, target) { return lc(target) === lc(A.bridge) ? [PANCAKE] : undefined; }, EXTENSION: [EXT],
    OWNER_POWER_NOTICE: [NOTICE], IDENTITY_LIMIT_NOTICE: ['我们要求持有 agent 身份，我们不能证明它是 AI。'], description: [NOTICE],
    lockedBac: [5000000n * E18], totalBurned: [0n], totalCreditsIssued: [5000000n * E18], totalCreditsExited: [120000n * E18],
    creditsOutstanding: [4880000n * E18], depositId: [3n],
    deposits: function (args) { return DEPOSITS[Number(args[0])]; },
    buybackBac: [8n * E18], bnbBalance: [9n * E18], buybackBudget: [1n * E18], buybackBacBought: [100000n * E18],
    buybackBnbSpent: [2n * E18], bacAccounted: [5000008n * E18], buybackState: [[1n * E18, 500000000000000000n, 3, 1]],
    owedTotal: [4n * E18], reservedTotal: [1n * E18], releasedInWindow: [2n * E18],
    currentRate: [1800000000000n], lastEpochRelease: [[1n * E18, HEAD_TS - 1000, 350]],
    isPaused: [[false, 0, 0]], isHalted: [false], lastSettledEpoch: [Math.floor(HEAD_TS / 600) - 1], skippedEpochs: [0],
    haltCause: [0], pendingCause: [0], escapeArmedAt: [0], escapeState: [[0n, 0n, 0n, 0n, 0n]],
    upgradeCount: [1n], lastUpgradeAt: [HEAD_TS - 900], emergencyBnbWithdrawn: [1n * E18], emergencyBacWithdrawn: [0n],
    emergencyCount: [1n], lastEmergencyAt: [HEAD_TS - 600], shortfall: [[1n * E18, 0n]],
    credited: function (args) { return ({ 17: [300000n * E18], 99: [1000n * E18] })[Number(args[0])]; },
    exitedCredits: function (args) { return ({ 17: [0n], 99: [0n] })[Number(args[0])]; },
    agentController: function (args) { return ({ 17: [OWNER], 99: [OTHER] })[Number(args[0])]; },
    ownerOf: function (args) { return Number(args[0]) === 17 ? [OWNER] : undefined; },
    getMetadata: function (args) { return (Number(args[0]) === 17 && args[1] === 'agentWallet') ? [WALLET17] : undefined; },
    tokenURI: function (args) { return Number(args[0]) === 17 ? [URI17] : undefined; },
    balance: [400000000000000000n], lifetimeReceived: [12n * E18], lifetimeWithdrawn: [11n * E18 + 600000000000000000n],
    totalStaked: [5000000n * E18], nodeCount: [2n], rewardBalance: [300000000000000000n],
    lifetimeFunded: [800000000000000000n], lifetimePaid: [500000000000000000n],
    dayReward: [[1n * E18, 5000000n * E18, 200000000n, true]],
    firstEpoch: [Math.floor(HEAD_TS / 600) - 300],
    lastPostedEpoch: [Math.floor(HEAD_TS / 600) - 1], lastFinalEpoch: [Math.floor(HEAD_TS / 600) - 2], lastFinalAt: [HEAD_TS - 700],
    cumulativeCredited: [5000000n * E18], cumulativeExit: [120000n * E18],
    haltReason: [0], vetoCountInWindow: [0], disputeCountInWindow: [0], releaseBpsFor: [350],
    getAnchor: [['0x' + 'ab'.repeat(32), '0x' + 'ef'.repeat(32), 1234501, HEAD_TS - 800, 0, 500000n * E18, 120000n * E18,
      3125000000000000n, 380000n * E18, 7, 2, 1]]
  };
  var E0 = Math.floor(HEAD_TS / 600) - 10, DEPLOY_TS = E0 * 600 + 17;
  if (STAGE === 'deployed') {
    var b0 = {}; b0[lc(A.router)] = 0n; b0[lc(A.bridge)] = 0n; b0[lc(A.nodeFund)] = 0n;
    Object.assign(F, {
      accountedQuote: [0n], unsplitRevenue: [0n], lifetimeToBridge: [0n], lifetimeToNodeFund: [0n], totalRecognized: [0n],
      stuckAmounts: [[0n, 0n]], solvency: [[0n, 0n, 0n]], getEthBalance: ethBal(b0),
      lockedBac: [0n], totalCreditsIssued: [0n], totalCreditsExited: [0n], creditsOutstanding: [0n], depositId: [0n],
      buybackBac: [0n], bnbBalance: [0n], buybackBudget: [0n], buybackBacBought: [0n], buybackBnbSpent: [0n], bacAccounted: [0n],
      buybackState: [[0n, 0n, 0, 0]], owedTotal: [0n], reservedTotal: [0n], releasedInWindow: [0n], currentRate: [0n],
      lastEpochRelease: [[0n, 0, 0]], lastSettledEpoch: [E0],
      upgradeCount: [0n], lastUpgradeAt: [0], emergencyBnbWithdrawn: [0n], emergencyBacWithdrawn: [0n],
      emergencyCount: [0n], lastEmergencyAt: [0], shortfall: undefined,
      balance: [0n], lifetimeReceived: [0n], lifetimeWithdrawn: [0n],
      totalStaked: [0n], nodeCount: [0n], rewardBalance: [0n], lifetimeFunded: [0n], lifetimePaid: [0n],
      dayReward: [[0n, 0n, 0n, false]],
      firstEpoch: [E0], lastPostedEpoch: [E0 - 1], lastFinalEpoch: [0], lastFinalAt: [DEPLOY_TS],
      cumulativeCredited: [0n], cumulativeExit: [0n],
      getAnchor: [['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), 0, 0, 0, 0n, 0n, 0n, 0n, 0, 0, 0]]
    });
  }
  function mkLog(address, blockNumber, tx, index, name, args) {
    return { address: address, blockNumber: blockNumber, transactionHash: tx, index: index, topics: ['0x' + name], data: enc({ name: name, args: args }) };
  }
  var DEPLOY = window.__DEPLOY || (HEAD - 3000);
  var T = function (c) { return '0x' + c.repeat(32); };
  var LOGS = STAGE === 'none' ? [] : [
    mkLog(A.bridge, DEPLOY, T('d0'), 0, 'Upgraded', { implementation: IMPL1 }),
    mkLog(A.bridge, DEPLOY, T('d0'), 1, 'OwnershipTransferred', { previousOwner: ZERO, newOwner: OWNER }),
    mkLog(A.bridge, DEPLOY, T('d0'), 2, 'Initialized', { version: 1 })
  ];
  if (STAGE === 'launched') {
    LOGS = LOGS.concat([
      mkLog(A.bridge, HEAD - 300, T('d1'), 0, 'BridgeUpgraded', { newImplementation: IMPL2, previousImplementation: IMPL1, by: OWNER,
        upgradeNumber: 1, at: HEAD_TS - 900, bnbBook: 9n * E18, lockedBacBook: 5000000n * E18, buybackBacBook: 8n * E18, owedTotalBook: 4n * E18 }),
      mkLog(A.bridge, HEAD - 300, T('d1'), 1, 'Upgraded', { implementation: IMPL2 }),
      mkLog(A.bridge, HEAD - 200, T('d2'), 0, 'EmergencyWithdraw', { by: OWNER, to: OWNER, token: ZERO, amount: 1n * E18,
        balanceAfter: 8n * E18, bookAtWithdraw: 9n * E18, lifetimeWithdrawn: 1n * E18, withdrawNumber: 1, at: HEAD_TS - 600 }),
      mkLog(A.router, HEAD - 50, T('e1'), 0, 'RevenueRecognized', { from: PROC, amount: 900000000000000000n }),
      mkLog(A.router, HEAD - 40, T('e2'), 3, 'RevenueSplit', { toBridge: 450000000000000000n, toNodeFund: 450000000000000000n }),
      mkLog(A.bridge, HEAD - 40, T('e2'), 4, 'ReleaseReceived', { from: A.router, amount: 450000000000000000n, bnbAfter: 9n * E18 }),
      mkLog(A.router, HEAD - 40, T('e2'), 5, 'PushSucceeded', { to: A.bridge, amount: 450000000000000000n }),
      mkLog(A.router, HEAD - 40, T('e2'), 6, 'PushFailed', { to: A.nodeFund, amount: 450000000000000000n }),
      mkLog(A.bridge, HEAD - 35, T('e3'), 0, 'BoughtBack', { by: OTHER, venue: 1, bnbSpent: 100000000000000000n, bacBought: 3000n * E18, buybackBacAfter: 8n * E18 }),
      mkLog(A.nodeFund, HEAD - 30, T('e4'), 0, 'Withdrawn', { to: OWNER, amount: 1n * E18, balanceAfter: 0n }),
      mkLog(A.nodeFund, HEAD - 29, T('e5'), 0, 'ReleaseReceived', { from: A.router, amount: 450000000000000000n, balanceAfter: 400000000000000000n })
    ]);
  }
  var MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
  function result(fn, args, target) { var f = F[fn]; if (f === undefined) return undefined; return typeof f === 'function' ? f(args, target) : f; }
  function handle(tx) {
    var d = dec(tx.data);
    if (lc(tx.to) === lc(MC) && d.fn === 'aggregate3') {
      return enc([d.args[0].map(function (row) {
        var inner = dec(row[2]); var r = result(inner.fn, inner.args, row[0]);
        return r === undefined ? [false, '0x'] : [true, enc(r)];
      })]);
    }
    var r = result(d.fn, d.args, tx.to);
    if (r === undefined) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x' });
    return enc(r);
  }
  function Interface(frags) { this.frags = frags; }
  Interface.prototype.encodeFunctionData = function (fn, args) {
    if (!this.frags.some(function (f) { return f.indexOf(' ' + fn + '(') >= 0; })) throw new Error('unknown fn ' + fn);
    return enc({ fn: fn, args: args || [] });
  };
  Interface.prototype.decodeFunctionResult = function (fn, data) { return dec(data); };
  Interface.prototype.parseLog = function (log) {
    var d = dec(log.data);
    if (!this.frags.some(function (f) { return f.indexOf('event ' + d.name + '(') === 0; })) return null;
    return { name: d.name, args: d.args };
  };
  function FetchRequest(url) { this.url = url; }
  function Network(n, id) { this.name = n; this.chainId = id; }
  function JsonRpcProvider(req) { this.url = req.url; }
  JsonRpcProvider.prototype.getCode = function (a) {
    if (lc(a) === lc(MC)) return Promise.resolve('0x6080');
    if (lc(a) === lc(TOKEN)) return Promise.resolve(STAGE === 'launched' ? '0x6080' : '0x');
    return Promise.resolve(STAGE === 'none' ? '0x' : '0x6080');
  };
  JsonRpcProvider.prototype.getBlockNumber = function () { return Promise.resolve(HEAD); };
  JsonRpcProvider.prototype.getBlock = function (tag) {
    if (tag === undefined || tag === 'latest') return Promise.resolve({ number: HEAD, timestamp: HEAD_TS });
    return Promise.resolve({ number: Number(tag), timestamp: HEAD_TS - (HEAD - Number(tag)) * 3 });
  };
  JsonRpcProvider.prototype.getStorage = function () { return Promise.resolve('0x' + '0'.repeat(24) + (STAGE === 'launched' ? 'a2' : 'a1').repeat(20)); };
  JsonRpcProvider.prototype.getLogs = function (f) {
    var addrs = (Array.isArray(f.address) ? f.address : [f.address]).map(lc);
    return Promise.resolve(LOGS.filter(function (l) { return addrs.indexOf(lc(l.address)) >= 0 && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock; }));
  };
  JsonRpcProvider.prototype.call = function (tx) { try { return Promise.resolve(handle(tx)); } catch (e) { return Promise.reject(e); } };
  JsonRpcProvider.prototype.send = function () { return Promise.reject(new Error('not supported')); };
  window.ethers = { FetchRequest: FetchRequest, Network: Network, JsonRpcProvider: JsonRpcProvider, Interface: Interface };
})();`;

const ADDR = {
  token: '0xA97452d175679B2bF5F25a9a382D22aff39b7777',
  router: '0x1111111111111111111111111111111111111111',
  bridge: '0x3333333333333333333333333333333333333333',
  nodeFund: '0x4444444444444444444444444444444444444444',
  anchor: '0x6666666666666666666666666666666666666666',
  staking: '0x7777777777777777777777777777777777777777'
};
const HEAD = 123456789;

async function openStage(browser, stage, { lang = 'zh', width = 1440, route = 'overview', deployBlock = HEAD - 3000 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'zh-CN' });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errs.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.route('**/vendor/ethers-6.13.4.umd.min.js', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_ETHERS(stage) }));
  if (stage !== 'none') {
    await page.addInitScript(({ addr, deploy, cfgDeploy }) => {
      window.__ADDR = addr; window.__DEPLOY = deploy;
      window.BAC_CONFIG = { addresses: addr, deployBlock: cfgDeploy, pollMs: 600000, codeProbeMs: 600000 };
    }, { addr: ADDR, deploy: HEAD - 3000, cfgDeploy: deployBlock });
  } else {
    await page.addInitScript(() => { window.__ADDR = {}; });
  }
  await page.goto(BASE + '?lang=' + lang + '#/' + route);
  await page.waitForTimeout(2500);
  return { page, errs };
}

const txt = (page, sel) => page.$eval(sel, el => el.textContent.trim()).catch(() => null);
const visible = (page, sel) => page.$eval(sel, el => !el.hidden && getComputedStyle(el).display !== 'none').catch(() => null);
const PRE = '发射后公布';
const OWNER_SENTENCE = '项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。';
const ID_SENTENCE = '我们要求持有 agent 身份，我们不能证明它是 AI';

const browser = await chromium.launch();
try {
  for (const stage of ['none', 'deployed', 'launched']) {
    console.log('\n[' + stage + ']');
    const { page, errs } = await openStage(browser, stage, { route: 'treasury' });
    const st = await page.evaluate(() => window.BAC && window.BAC.STAGE);
    ok(stage + ' · 数据层阶段', st === stage, st);
    const vmStage = await page.evaluate(() => window.BACVM.stage.stage);
    ok(stage + ' · VM.stage', vmStage === stage, vmStage);

    const slot = (k) => txt(page, '#v-treasury [data-vm="' + k + '"]');
    const upg = await slot('bridge.upgradeCount');
    const owner = await slot('bridge.owner');
    const routerBal = await slot('treasury.routerBalance');
    const pending = await slot('treasury.pendingTax');
    const price = await slot('token.price');
    const mkt = await slot('token.marketAddressOk');
    const notice = await slot('bridge.noticeMatches');
    const sfBnb = await slot('bridge.shortfallBnb');
    if (stage === 'none') {
      for (const [k, v] of Object.entries({ upg, owner, routerBal, pending, price, sfBnb })) ok('none · ' + k + ' = 发射后公布', v === PRE, v);
    } else if (stage === 'deployed') {
      ok('deployed · 升级次数是真的 0', upg === '0', upg);
      ok('deployed · owner 是真地址', /^0x934a6678120b85652D2CC818C69774ea17012844$/i.test(owner || ''), owner);
      ok('deployed · 路由余额是真的 0', routerBal === '0', routerBal);
      ok('deployed · 待分发税 = 发射后公布', pending === PRE, pending);
      ok('deployed · 价格 = 发射后公布', price === PRE, price);
      ok('deployed · 税收接收地址核对 = 发射后公布', mkt === PRE, mkt);
      ok('deployed · BNB 缺口是真的 0（推导）', sfBnb === '0', sfBnb);
      ok('deployed · 链上声明逐字一致', notice === '与 #29a 逐字一致', notice);
    } else {
      ok('launched · 升级 1 次', upg === '1', upg);
      ok('launched · 路由余额', routerBal === '0.5', routerBal);
      ok('launched · 待分发税是真数', pending !== PRE && pending !== '—' && pending !== null, pending);
      ok('launched · 价格是真数', price !== PRE && !!price, price);
      ok('launched · 税收接收地址一致', /^一致/.test(mkt || ''), mkt);
      ok('launched · BNB 缺口 1', sfBnb === '1', sfBnb);
    }
    const ownBody = await txt(page, '#ownBody');
    const ownCov = await txt(page, '#ownCov');
    const flowBody = await txt(page, '#flowBody');
    const nfBody = await txt(page, '#nfBody');
    const tkState = await txt(page, '#tkState');
    if (stage === 'none') {
      ok('none · 权限记录 = 发射后公布', (ownBody || '').startsWith(PRE), ownBody);
      ok('none · 流向时间线 = 发射后公布', (flowBody || '').startsWith(PRE), flowBody);
      ok('none · 代币状态', tkState === '地址已锁定 · 尚未发射', tkState);
    } else {
      ok(stage + ' · 权限记录有初始 owner', /初始 owner/.test(ownBody || ''), ownBody);
      ok(stage + ' · 权限记录有初始实现', /初始实现/.test(ownBody || ''), ownBody);
      ok(stage + ' · 完整性说明（从部署块扫起 → 完整）', /这条时间线是完整的/.test(ownCov || ''), ownCov);
      ok(stage + ' · 计数器对账', /合约计数器（全量）/.test(ownCov || ''), ownCov);
    }
    if (stage === 'deployed') {
      ok('deployed · 流向时间线为空（真的没有）', /没有税收流水/.test(flowBody || ''), flowBody);
      ok('deployed · 代币状态', tkState === '地址已锁定 · 尚未发射', tkState);
    }
    if (stage === 'launched') {
      ok('launched · 权限记录有升级', /升级桥合约/.test(ownBody || ''), ownBody);
      ok('launched · 权限记录有紧急提取', /紧急提取/.test(ownBody || ''), ownBody);
      ok('launched · 流向时间线', /50\/50 分账/.test(flowBody || '') && /推送失败/.test(flowBody || '') && /回购 BAC/.test(flowBody || ''), flowBody);
      ok('launched · 节点基金时间线', /项目方提取/.test(nfBody || '') && /节点基金到账/.test(nfBody || ''), nfBody);
      ok('launched · 代币状态', tkState === '已发射', tkState);
    }

    // 概览：#29a 首屏 + 页脚；桥面板的升级次数
    await page.goto(BASE + '?lang=zh#/overview'); await page.waitForTimeout(1500);
    const heroOwn = await txt(page, '.hero-disc li.own');
    ok(stage + ' · 首屏逐字 #29a', (heroOwn || '').includes(OWNER_SENTENCE), heroOwn);
    const footOwn = await txt(page, '.a-warn.f-own');
    ok(stage + ' · 页脚逐字 #29a', footOwn === OWNER_SENTENCE, footOwn);
    const caNote = await visible(page, '.hero-disc .ca-n');
    ok(stage + ' · CA 「尚未发射」注只在发射前出现', caNote === (stage !== 'launched'), caNote);
    const ovUpg = await txt(page, '#v-overview [data-vm="bridge.upgradeCount"]');
    ok(stage + ' · 概览桥面板升级次数', ovUpg === (stage === 'none' ? PRE : (stage === 'deployed' ? '0' : '1')), ovUpg);
    const bscSrc = await txt(page, '#v-overview [data-src="bsc"]');
    ok(stage + ' · BSC 来源小标', bscSrc === ({ none: 'BSC · 合约未部署', deployed: 'BSC · 合约直读 · 代币未发射', launched: 'BSC · 合约直读' })[stage], bscSrc);
    const cd2 = await page.$$eval('#v-overview .epgrid [data-stage]', els => els.filter(e => !e.hidden).map(e => e.textContent));
    ok(stage + ' · 纪元格只露一句', cd2.length === 1, JSON.stringify(cd2));

    // Agent 名录
    await page.goto(BASE + '?lang=zh#/agents'); await page.waitForTimeout(1500);
    const agRows = await page.$$eval('#agBody tr', trs => trs.map(t => t.textContent));
    const agCount = await txt(page, '#agCount');
    const notes = await page.$$eval('#v-agents p.note', ps => ps.filter(p => !p.hidden).map(p => p.textContent.slice(0, 12)));
    ok(stage + ' · 名录说明只露一段', notes.length === 1, JSON.stringify(notes));
    if (stage === 'none') {
      ok('none · 名录空（发射前）', agRows.length === 1 && /还没有任何 agent 进场/.test(agRows[0]), agRows[0]);
      ok('none · 计数', agCount === '0 个身份', agCount);
    } else if (stage === 'deployed') {
      ok('deployed · 名录是真的 0', agRows.length === 1 && /还没有任何 ERC-8004 身份锁进过 BacBridge/.test(agRows[0]), agRows[0]);
    } else {
      ok('launched · 名录两条', agRows.length === 2, agRows.length);
      const r17 = agRows.find(r => r.startsWith('#17')) || '';
      ok('launched · #17 自述名字转义显示', r17.includes('Clawbot 爪子 <b>x</b>') && r17.includes('持有人自述'), r17);
      ok('launched · #99 注册表查不到', /注册表里查不到这个身份/.test(agRows.find(r => r.startsWith('#99')) || ''), agRows.join(' | '));
      const imgs = await page.$$eval('img', is => is.map(i => i.getAttribute('src')).filter(s => /evil/.test(s || '')));
      ok('launched · 不加载自述图片', imgs.length === 0, imgs.join(','));
      await page.goto(BASE + '?lang=zh#/agent/17'); await page.waitForTimeout(1200);
      const det = await txt(page, '#v-agent');
      ok('launched · agent 详情有 agentWallet', /0xbebebebe/i.test(det || ''), (det || '').slice(0, 200));
      ok('launched · agent 详情有 #31a', (det || '').includes(ID_SENTENCE), '');
      ok('launched · agent 详情有自述简介', (det || '').includes('我自己说我是个 AI'), '');
    }
    ok(stage + ' · 页面没有报错', errs.length === 0, errs.slice(0, 3).join(' | '));

    // 英文：各页没有漏译
    const en = await openStage(browser, stage, { lang: 'en', route: 'overview' });
    for (const r of ['overview', 'treasury', 'agents', 'validators', 'epochs'].concat(stage === 'launched' ? ['agent/17'] : [])) {
      await en.page.goto(BASE + '?lang=en#/' + r); await en.page.waitForTimeout(1200);
      const left = await en.page.evaluate(() => {
        const vis = new Set();
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) {
          const n = w.currentNode, p = n.parentElement;
          if (!p || p.closest('[translate="no"],[data-i18n-ignore],script,style,noscript,.self-n,.sym,.f-x')) continue;
          if (p.closest('[hidden]') || !p.offsetParent && getComputedStyle(p).position !== 'fixed') continue;
          const v = n.data.replace(/\s+/g, ' ').trim();
          if (/[㐀-鿿]/.test(v)) vis.add(v);
        }
        return Array.from(vis);
      });
      ok(stage + ' · en · ' + r + ' 没有漏译', left.length === 0, JSON.stringify(left.slice(0, 12)));
    }
    ok(stage + ' · en · 页面没有报错', en.errs.length === 0, en.errs.slice(0, 3).join(' | '));
    await en.page.close();

    // 390px 不横向溢出
    const m = await openStage(browser, stage, { width: 390, route: 'treasury' });
    for (const r of ['treasury', 'agents', 'overview']) {
      await m.page.goto(BASE + '?lang=zh#/' + r); await m.page.waitForTimeout(900);
      const ov = await m.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(stage + ' · 390px · ' + r + ' 不溢出', ov <= 0, ov);
      if (SHOTS) await m.page.screenshot({ path: join(OUT, stage + '-390-' + r + '.png'), fullPage: true });
    }
    await m.page.close();
    if (SHOTS) {
      for (const r of ['treasury', 'agents']) {
        await page.goto(BASE + '?lang=zh#/' + r); await page.waitForTimeout(900);
        await page.screenshot({ path: join(OUT, stage + '-1440-' + r + '.png'), fullPage: true });
      }
    }
    await page.close();
  }

  // 部署块没配（deployBlock = 0）：浏览器不能证明时间线从部署起就全了 → 必须照实说「可能不完整」并给 BscScan
  console.log('\n[launched · deployBlock 未知]');
  for (const lang of ['zh', 'en']) {
    const u = await openStage(browser, 'launched', { lang, route: 'treasury', deployBlock: 0 });
    const cov = await u.page.$eval('#ownCov', el => el.textContent).catch(() => '');
    const link = await u.page.$eval('#ownCov a', a => a.href).catch(() => null);
    if (lang === 'zh') {
      ok('不全 · 说明「可能不完整」', /这条时间线可能不完整/.test(cov), cov);
      ok('不全 · 链到 BscScan 桥合约事件页', link === 'https://bscscan.com/address/' + ADDR.bridge + '#events', link);
      const fc = await u.page.$eval('#flowCov', el => el.textContent).catch(() => '');
      ok('不全 · 流向时间线说明只看得到最近窗口', /只显示本站读得到的最近约/.test(fc), fc);
    } else {
      const left = await u.page.evaluate(() => window.BACI18N.untranslated().filter(s => {
        return !/Clawbot|我自己说/.test(s);
      }));
      const vis = await u.page.evaluate(() => {
        const out = [];
        document.querySelectorAll('#v-treasury *').forEach(el => {
          if (el.children.length || el.closest('[hidden],[translate="no"]')) return;
          if (/[㐀-鿿]/.test(el.textContent)) out.push(el.textContent.trim());
        });
        return out;
      });
      ok('不全 · en · 金库页没有漏译', vis.length === 0, JSON.stringify(vis.slice(0, 10)) + ' / ' + left.length);
    }
    ok('不全 · ' + lang + ' · 没有报错', u.errs.length === 0, u.errs.join(' | '));
    await u.page.close();
  }

  // 演示模式：新面板不报错
  console.log('\n[demo]');
  const dp = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const derr = [];
  dp.on('pageerror', e => derr.push(e.message));
  await dp.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await dp.route('**/vendor/ethers-6.13.4.umd.min.js', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_ETHERS('none') }));
  await dp.addInitScript(() => { window.__ADDR = {}; });
  for (const r of ['treasury', 'agents', 'agent/3', 'overview']) {
    await dp.goto(BASE + '?demo=1&lang=zh#/' + r); await dp.waitForTimeout(1200);
  }
  ok('demo · 页面没有报错', derr.length === 0, derr.slice(0, 3).join(' | '));
  await dp.close();
} finally {
  await browser.close();
  srv.close();
}
console.log('\n──────────────────────────────\n通过 ' + pass + ' · 失败 ' + fail);
process.exit(fail ? 1 : 0);
