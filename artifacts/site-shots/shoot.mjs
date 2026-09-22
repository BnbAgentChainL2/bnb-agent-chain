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
  ['shot-validators.png', 1440, 1100, false, '#validators'],
  ['shot-mobile.png', 390, 844, true],
  ['shot-mobile-validators.png', 390, 844, false, '#validators'],
];
for (const [name, w, h, full, anchor] of shots) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.goto(base + (anchor || ''), { waitUntil: 'networkidle' });
  await page.waitForTimeout(anchor ? 1200 : 900);
  // hash 路由的站点（方案三）里 #validators 是一条路由而不是页内锚点，找不到元素就不滚动
  if (anchor) await page.evaluate(sel => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'start' }); }, anchor);
  await page.waitForTimeout(500);
  await page.screenshot({ path: (process.argv[3] || '.') + '/' + name, fullPage: full });
  await page.close();
  console.log('shot', name);
}
await browser.close(); server.close();
