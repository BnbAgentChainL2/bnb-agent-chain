/* 方案三「分页式应用」浏览器截图：多视图 + 详情页 + 宽屏，检查横向溢出与空白图。
   服务器与 shoot.mjs 同一套，只是路由是 hash 路由，并且多了合约页 / 纪元页 / 1920 hero。
   用法：node shoot-hybrid.mjs "<site dir>" "<out dir>" */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';

const TYPES = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.woff2':'font/woff2' };
const root = process.argv[2] || process.cwd();
const out  = process.argv[3] || '.';
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  const p = join(root, rel === '/' ? 'index.html' : rel);
  try { const b = await readFile(p); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const shots = [
  // name,                      w,    h,    fullPage, hash,                 clickFirstRowIn,        special
  ['shot-desktop.png',          1440, 900,  true,  '#/overview'],
  ['shot-hero.png',             1440, 900,  false, '#/overview'],
  ['shot-wide.png',             1920, 1080, false, '#/overview'],
  ['shot-wide-hero.png',        1920, 1080, false, '#/overview'],
  ['shot-wide-full.png',        1920, 1080, true,  '#/overview'],
  ['shot-blocks.png',           1440, 950,  false, '#/blocks'],
  ['shot-block-detail.png',     1440, 1100, true,  '#/blocks', '#blkBody tr:nth-child(2)'],
  ['shot-txs.png',              1440, 950,  false, '#/txs'],
  ['shot-tx-detail.png',        1440, 1100, true,  '#/txs', '#txBody tr:nth-child(1)'],
  ['shot-agents.png',           1440, 950,  false, '#/agents'],
  ['shot-agent-detail.png',     1440, 1100, true,  '#/agent/17'],
  ['shot-contract.png',         1440, 1100, true,  '#/agent/17', 'tr[data-go^="#/contract/"]'],
  ['shot-epochs.png',           1440, 1000, false, '#/epochs'],
  ['shot-epoch-detail.png',     1440, 1100, true,  '#/epoch/20717'],
  ['shot-treasury.png',         1440, 1100, true,  '#/treasury'],
  ['shot-validators.png',       1440, 1100, true,  '#/validators'],
  ['shot-search.png',           1440, 900,  false, '#/overview', null, 'search'],
  ['shot-scrolled.png',         1440, 900,  false, '#/blocks', null, 'scroll'],
  ['shot-mobile.png',           390,  844,  true,  '#/overview'],
  ['shot-mobile-top.png',       390,  844,  false, '#/overview'],
  ['shot-mobile-blocks.png',    390,  844,  false, '#/blocks'],
  ['shot-mobile-epoch.png',     390,  844,  true,  '#/epoch/20717'],
  ['shot-mobile-validators.png',390,  844,  true,  '#/validators'],
];

const overflow = [], blank = [], errors = [];
for (const [name, w, h, fullPage, hash, click, special] of shots) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(base + '/' + (hash || ''), { waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  if (click) { await page.click(click); await page.waitForTimeout(800); }
  if (special === 'search') {
    await page.click('#q');
    await page.type('#q', '0x0', { delay: 45 });
    await page.waitForTimeout(500);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(250);
  }
  if (special === 'scroll') { await page.mouse.wheel(0, 420); await page.waitForTimeout(500); }

  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    rows: document.querySelectorAll('tbody tr').length,
    text: (document.querySelector('.view:not([hidden])')?.innerText || '').trim().length
  }));
  if (m.sw > m.cw + 1) overflow.push(`${name}: scrollWidth ${m.sw} > clientWidth ${m.cw}`);
  if (m.text < 120) blank.push(`${name}: 可见视图文字只有 ${m.text} 字`);
  if (errs.length) errors.push(`${name}: ${errs.join(' ; ')}`);

  await page.screenshot({ path: out + '/' + name, fullPage });
  await page.close();
  console.log('shot', name.padEnd(28), '| rows', String(m.rows).padStart(4), '| overflow', m.sw - m.cw,
    '| text', m.text, errs.length ? '| ERRORS ' + errs.join(' ; ') : '');
}
await browser.close(); server.close();

if (overflow.length) { console.log('\n横向溢出：'); overflow.forEach(o => console.log(' - ' + o)); }
else console.log('\n无横向溢出。');
if (blank.length) { console.log('疑似空白：'); blank.forEach(o => console.log(' - ' + o)); }
else console.log('没有空白页面。');
if (errors.length) { console.log('脚本报错：'); errors.forEach(o => console.log(' - ' + o)); }
else console.log('无 JS 报错。');
