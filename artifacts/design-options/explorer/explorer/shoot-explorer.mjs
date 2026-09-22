import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';

const TYPES = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.woff2':'font/woff2' };
const root = process.argv[2] || process.cwd();
const server = createServer(async (req, res) => {
  const p = join(root, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  try { const b = await readFile(p); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const shots = [
  ['shot-desktop.png', 1440, 900, true],
  ['shot-hero.png', 1440, 900, false],
  ['shot-wide.png', 1920, 1080, false],
  ['shot-wide-full.png', 1920, 1080, true],
  ['shot-validators.png', 1440, 1100, false, '#validators'],
  ['shot-charts.png', 1440, 900, false, '#charts'],
  ['shot-treasury.png', 1440, 900, false, '#treasury'],
  ['shot-blocks.png', 1440, 900, false, '#/blocks'],
  ['shot-txs.png', 1440, 900, false, '#/txs'],
  ['shot-mobile.png', 390, 844, true],
  ['shot-mobile-hero.png', 390, 844, false],
  ['shot-mobile-validators.png', 390, 844, false, '#validators'],
];
for (const [name, w, h, full, anchor] of shots) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.goto(base + (anchor || ''), { waitUntil: 'networkidle' });
  await page.waitForTimeout(anchor ? 1300 : 1000);
  if (anchor && anchor.startsWith('#') && !anchor.startsWith('#/')) {
    await page.evaluate(sel => document.querySelector(sel).scrollIntoView({ block: 'start' }), anchor);
  }
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: (process.argv[3] || '.') + '/' + name, fullPage: full });
  const errs = [];
  console.log('shot', name, 'hOverflow=' + overflow);
  await page.close();
}
// console error check
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
await page.evaluate(() => { document.querySelector('tr.rowlink[data-block]').click(); });
await page.waitForTimeout(400);
const drawerOpen = await page.evaluate(() => document.getElementById('drawer').classList.contains('on'));
await page.screenshot({ path: (process.argv[3] || '.') + '/shot-drawer-block.png' });
await page.evaluate(() => document.getElementById('dwClose').click());
await page.waitForTimeout(300);
await page.evaluate(() => { document.querySelector('tr.rowlink[data-tx]').click(); });
await page.waitForTimeout(400);
await page.screenshot({ path: (process.argv[3] || '.') + '/shot-drawer-tx.png' });
console.log('drawerOpen=', drawerOpen, 'errors=', JSON.stringify(errs));
await browser.close(); server.close();
