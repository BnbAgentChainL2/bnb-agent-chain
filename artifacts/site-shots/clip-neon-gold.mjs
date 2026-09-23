/* 局部截图：node clip-neon-gold.mjs <web目录> <输出目录> <hash> <选择器> <文件名> [宽] */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
const [root, outDir, hash, sel, fname, wArg] = process.argv.slice(2);
const W = +wArg || 1440;
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const p = join(root, rel === '/' ? 'index.html' : rel);
  try { const b = await readFile(p); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: W, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: W < 500, hasTouch: W < 500 });
await page.goto(base + '/?demo=1', { waitUntil: 'load' });
await page.waitForTimeout(1400);
if (hash && hash !== '-') { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForTimeout(1400); }
const el = await page.$(sel);
if (!el) { console.log('选择器没命中', sel); } else { await el.screenshot({ path: join(outDir, fname) }); console.log('clip', fname); }
await browser.close(); server.close();
