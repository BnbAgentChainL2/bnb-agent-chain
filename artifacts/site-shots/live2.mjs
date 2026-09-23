/* BNB Agent Chain · 真链验证 + 截图（live2）
   用法：node live2.mjs
   打真实 https://bnbagentchain-rpc.xyz/rpc（或兜底 sslip.io），不做任何网络 mock。
   断言全部在代码里，不靠肉眼看图。 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile, mkdir } from 'fs/promises';
import { extname, join } from 'path';

const WEB = 'D:/CLAUDE DODODODODOODODODODODODOODODO/Agent CHAIN/web';
const OUT = 'D:/CLAUDE DODODODODOODODODODODODOODODO/Agent CHAIN/artifacts/site-shots/out/live2';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2'
};

await mkdir(OUT, { recursive: true });

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const p = join(WEB, rel === '/' ? 'index.html' : rel);
  try {
    const b = await readFile(p);
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(b);
  } catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log('serve', base, '->', WEB);

const browser = await chromium.launch({ args: ['--disable-gpu'] });
const problems = [];
const report = {};

function newPage(w, h, tag) {
  return browser.newPage({
    viewport: { width: w, height: h }, deviceScaleFactor: 1,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: w < 500, hasTouch: w < 500
  }).then(page => {
    page.on('console', m => { if (m.type() === 'error') problems.push(`[console] ${tag} ${m.text()}`); });
    page.on('pageerror', e => problems.push(`[pageerror] ${tag} ${e.message}`));
    page.on('requestfailed', r => problems.push(`[request] ${tag} ${r.url()} ${r.failure()?.errorText}`));
    return page;
  });
}

/* 等到 VM 里真的有块高为止，最多 40 秒 */
async function waitLive(page, ms = 40000) {
  try {
    await page.waitForFunction(() => {
      const vm = window.BACVM;
      return vm && vm.chain && typeof vm.chain.head === 'number' && vm.chain.head > 0
        && vm.blocks && vm.blocks.length > 0;
    }, null, { timeout: ms });
    return true;
  } catch { return false; }
}

/* ═════════════ 1. 主场：真数据断言 ═════════════ */
const page = await newPage(1440, 1000, 'main');
await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
const arrived = await waitLive(page);
report.dataArrived = arrived;
if (!arrived) problems.push('[assert] 40 秒内 VM 没有拿到块高或区块列表');

const snap1 = await page.evaluate(() => {
  const txt = s => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
  const vm = window.BACVM;
  const rows = [...document.querySelectorAll('#ovBlocks tr')].map(tr =>
    [...tr.children].map(td => td.textContent.trim()));
  const txrows = [...document.querySelectorAll('#ovTxs tr')].map(tr =>
    [...tr.children].map(td => td.textContent.trim()));
  return {
    headNum: txt('#headNum'), sbHead: txt('#sbHead'),
    ssBlockTime: txt('#ssBlockTime'), ssGasPrice: txt('#ssGasPrice'), ssPeers: txt('#ssPeers'),
    ssEpoch: txt('#ssEpoch'), navRpc: txt('#navRpc'), sbRpc: txt('#sbRpc'),
    ovHeadCell: txt('#v-overview .datum b[data-vm="chain.head"]'),
    gasLimit: txt('#v-overview [data-vm="chain.gasLimit"]'),
    baseFee: txt('#v-overview [data-vm="chain.baseFee"]'),
    gasPrice: txt('#v-overview [data-vm="chain.gasPrice"]'),
    interval: txt('#v-overview [data-vm="chain.blockIntervalSec"]'),
    chainId: txt('#v-overview [data-vm="chain.chainId"]'),
    blkPanelMeta: txt('#v-overview .ov-mid .panel:nth-child(1) .ph-m'),
    txPanelMeta: txt('#v-overview .ov-mid .panel:nth-child(2) .ph-m'),
    blockRows: rows, txRows: txrows,
    vmHead: vm.chain.head, vmBlockCount: vm.blocks.length, vmTxCount: vm.txs.length,
    vmBlockNums: vm.blocks.map(b => b.number).slice(0, 15),
    vmBlockTs: vm.blocks.map(b => b.ts).slice(0, 15),
    vmTxHashes: vm.txs.map(t => t.hash).slice(0, 5),
    vmMode: vm.mode, vmSt: vm.st, vmLayer: vm.layer,
    stateBar: (() => { const e = document.querySelector('#stateBar'); return e && !e.hidden ? e.textContent.trim() : null; })(),
    degradedBar: (() => { const e = document.querySelector('#degradedBar'); return e && !e.hidden ? e.textContent.trim() : null; })()
  };
});
report.snap1 = snap1;

/* 块高 > 10000 */
const headN = Number(String(snap1.headNum || '').replace(/[^\d]/g, ''));
if (!(headN > 10000)) problems.push(`[assert] 页面块高不是 >10000 的真实数字：#headNum="${snap1.headNum}"`);

/* 10 秒内块高上涨 */
let grew = false, headAfter = null;
try {
  await page.waitForFunction(h0 => {
    const t = document.querySelector('#headNum');
    const n = t ? Number(t.textContent.replace(/[^\d]/g, '')) : 0;
    return n > h0;
  }, headN, { timeout: 11000 });
  grew = true;
} catch { /* 下面报 */ }
headAfter = await page.evaluate(() => document.querySelector('#headNum')?.textContent.trim());
report.headBefore = snap1.headNum; report.headAfter = headAfter; report.headGrew = grew;
if (!grew) problems.push(`[assert] 10 秒内块高没有上涨：${snap1.headNum} → ${headAfter}`);

/* 最新区块表：>=10 行，块号互不相同，时间戳合理 */
const nums = snap1.vmBlockNums.filter(x => typeof x === 'number');
const uniq = new Set(nums);
report.blockTableRows = snap1.blockRows.length;
report.distinctBlockNums = uniq.size;
if (snap1.blockRows.length < 10) problems.push(`[assert] 最新区块表只有 ${snap1.blockRows.length} 行（要求 >=10）`);
if (uniq.size < Math.min(10, nums.length)) problems.push(`[assert] 区块号有重复：${nums.join(',')}`);
const nowSec = Math.floor(Date.now() / 1000);
const badTs = snap1.vmBlockTs.filter(t => !(typeof t === 'number' && t > nowSec - 7200 && t <= nowSec + 120));
if (badTs.length) problems.push(`[assert] 区块时间戳不合理：${badTs.join(',')}（now=${nowSec}）`);
/* 块号应连续递减（3 秒一块，直读最近 N 块） */
const desc = nums.every((v, i) => i === 0 || nums[i - 1] > v);
if (!desc) problems.push(`[assert] 区块号不是递减顺序：${nums.join(',')}`);

/* 最新交易：至少一条真哈希，或诚实空态 */
const txBodyText = await page.evaluate(() => document.querySelector('#ovTxs')?.textContent.trim() || '');
const realHash = snap1.vmTxHashes.filter(h => /^0x[0-9a-f]{64}$/i.test(h || ''));
report.txTableRows = snap1.txRows.length;
report.realTxHashes = realHash;
report.txBodyText = txBodyText.slice(0, 200);
if (realHash.length === 0) {
  if (/发射后公布/.test(txBodyText)) problems.push('[assert] 最新交易表在用「发射后公布」冒充空态（层内链是活的，应显示诚实空态）');
  else report.txEmptyStateHonest = txBodyText;
}

/* 全页禁词 */
const banned = await page.evaluate(() => {
  const hits = [];
  const walk = document.createTreeWalker(document.querySelector('#v-overview'), NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const t = n.nodeValue;
    if (/示例|NaN|undefined/.test(t)) {
      let el = n.parentElement, path = [];
      while (el && path.length < 4) { path.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '.' + String(el.className).split(' ')[0])); el = el.parentElement; }
      hits.push({ text: t.trim().slice(0, 80), path: path.join(' < ') });
    }
  }
  return hits;
});
report.bannedHits = banned;
if (banned.length) problems.push(`[assert] 概览上出现禁词 示例/NaN/undefined ×${banned.length}：` + JSON.stringify(banned));

/* 数「发射后公布」 */
const pre = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('#v-overview *').forEach(el => {
    if (el.children.length) return;
    if (el.textContent.trim() !== '发射后公布') return;
    if (el.closest('[hidden]')) return;
    const panel = el.closest('.panel');
    const head = panel ? (panel.querySelector('.ph-t')?.textContent.trim() || '?') : '(无面板)';
    const label = el.closest('tr')?.querySelector('td')?.textContent.trim()
      || el.parentElement?.querySelector('i,.d-l,span')?.textContent.trim()
      || el.previousElementSibling?.textContent.trim() || '?';
    out.push({ panel: head, field: label, vm: el.getAttribute('data-vm') || null, st: el.getAttribute('data-st') || null });
  });
  return out;
});
report.prelaunch = pre;
console.log('\n发射后公布 ×' + pre.length);
for (const p of pre) console.log('   ', p.panel, '|', p.field, '|', p.vm, '| st=' + p.st);

/* ═════════════ 2. 截图 ═════════════ */
async function shot(name, w, h, full, hash, extra) {
  const pg = await newPage(w, h, name);
  await pg.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await waitLive(pg);
  await pg.waitForTimeout(1200);
  let target = hash;
  if (hash === ':block' || hash === ':tx') {
    target = await pg.evaluate(k => {
      const vm = window.BACVM;
      if (k === ':block') return vm?.blocks?.[0] ? '#/block/' + vm.blocks[0].number : null;
      const t = (vm?.txs || []).find(x => /^0x[0-9a-f]{64}$/i.test(x.hash || ''));
      return t ? '#/tx/' + t.hash : null;
    }, hash);
    if (!target) { problems.push(`[shot] ${name} 跳过：页面上没有可点的真实${hash === ':block' ? '区块' : '交易'}`); await pg.close(); return null; }
  }
  if (target) { await pg.evaluate(h => { location.hash = h; }, target); await pg.waitForTimeout(2200); }
  const ov = await pg.evaluate(() => {
    const d = document.documentElement;
    if (d.scrollWidth <= d.clientWidth + 1) return null;
    const bad = [];
    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.right > d.clientWidth + 2 && r.width > 8) bad.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0]);
    });
    return `${d.scrollWidth}>${d.clientWidth} ${[...new Set(bad)].slice(0, 6).join(', ')}`;
  });
  if (ov) problems.push(`[overflow] ${name} ${ov}`);
  if (extra) await extra(pg);
  await pg.screenshot({ path: join(OUT, name), fullPage: full });
  await pg.close();
  console.log('shot', name, target || '');
  return target;
}

const done = [];
for (const s of [
  ['shot-hero.png', 1440, 900, false, ''],
  ['shot-desktop.png', 1440, 900, true, ''],
  ['shot-wide.png', 1920, 1080, false, ''],
  ['shot-blocks.png', 1440, 1100, true, '#/blocks'],
  ['shot-block-detail.png', 1440, 1200, true, ':block'],
  ['shot-tx-detail.png', 1440, 1200, true, ':tx'],
  ['shot-validators.png', 1440, 1200, true, '#/validators'],
  ['shot-mobile.png', 390, 844, true, '']
]) {
  const t = await shot(...s);
  done.push([s[0], t]);
}
report.shots = done;

await page.close();

/* ═════════════ 3. 失效转移：把 layerRpc 指到死地址 ═════════════ */
/* 不改盘里的文件：用 addInitScript 在 site.config.js 执行前预置 window.BAC_CONFIG，
   site.config.js 的 Object.assign(..., window.BAC_CONFIG || {}) 会让它胜出。 */
const fpage = await newPage(1440, 1000, 'failover');
await fpage.addInitScript(() => {
  window.BAC_CONFIG = { layerRpc: 'https://dead-endpoint-does-not-exist.invalid/rpc' };
});
await fpage.goto(base + '/', { waitUntil: 'domcontentloaded' });
const fok = await waitLive(fpage, 45000);
const fsnap = await fpage.evaluate(() => ({
  headNum: document.querySelector('#headNum')?.textContent.trim(),
  navRpc: document.querySelector('#navRpc')?.textContent.trim(),
  sbRpc: document.querySelector('#sbRpc')?.textContent.trim(),
  rows: document.querySelectorAll('#ovBlocks tr').length,
  vmHead: window.BACVM?.chain?.head,
  layer: window.BACVM?.layer,
  cfgLayerRpc: window.BAC?.CFG?.layerRpc,
  cfgFallback: window.BAC?.CFG?.fallbackRpc,
  degraded: (() => { const e = document.querySelector('#degradedBar'); return e && !e.hidden ? e.textContent.trim() : null; })()
}));
report.failover = { ok: fok, ...fsnap };
if (!fok) problems.push('[assert] 失效转移失败：主 RPC 指向死地址后，45 秒内页面没有拿到真数据');
else if (!(Number(String(fsnap.headNum || '').replace(/[^\d]/g, '')) > 10000)) problems.push(`[assert] 失效转移后块高不对：${fsnap.headNum}`);
await fpage.screenshot({ path: join(OUT, 'shot-failover.png'), fullPage: false });
await fpage.close();

await browser.close();
server.close();

console.log('\n===== REPORT =====');
console.log(JSON.stringify(report, (k, v) => typeof v === 'bigint' ? String(v) : v, 2));
console.log('\n===== PROBLEMS =====');
for (const p of [...new Set(problems)]) console.log(p);
if (!problems.length) console.log('(none)');
