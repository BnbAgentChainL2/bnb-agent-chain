/* 皮肤稿自检：每条路由在 390 / 1440 / 1920 下都不许横向溢出，也不许有 JS 报错。 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';

const root = process.argv[2];
const T = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml'
};
const srv = createServer(async (q, r) => {
  const rel = decodeURIComponent(q.url.split('?')[0]);
  const p = join(root, rel === '/' ? 'index.html' : rel);
  try { const b = await readFile(p); r.writeHead(200, { 'Content-Type': T[extname(p)] || 'application/octet-stream' }); r.end(b); }
  catch { r.writeHead(404); r.end('404'); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const br = await chromium.launch({ args: ['--disable-gpu'] });

const probe = () => {
  const d = document.documentElement;
  const bad = [];
  document.querySelectorAll('*').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > d.clientWidth + 2 && r.width > 8) bad.push(el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0]);
  });
  return { ov: d.scrollWidth - d.clientWidth, bad: [...new Set(bad)].slice(0, 5) };
};

let fails = 0;
for (const w of [390, 1440, 1920]) {
  const page = await br.newPage({ viewport: { width: w, height: 900 }, locale: 'zh-CN', isMobile: w < 500 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(base + '/?demo=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);

  const ids = await page.evaluate(() => ({
    b: window.BACVM.blocks[0] && window.BACVM.blocks[0].number,
    t: window.BACVM.txs[0] && window.BACVM.txs[0].hash,
    a: window.BACVM.agents[0] && window.BACVM.agents[0].id,
    e: window.BACVM.epochs[0] && window.BACVM.epochs[0].n
  }));
  const routes = ['#/overview', '#/blocks', '#/txs', '#/agents', '#/epochs', '#/treasury', '#/validators',
    '#/search/0x', '#/block/' + ids.b, '#/tx/' + ids.t, '#/agent/' + ids.a, '#/epoch/' + ids.e];

  for (const h of routes) {
    await page.evaluate(x => { location.hash = x; }, h);
    await page.waitForTimeout(420);
    const o = await page.evaluate(probe);
    if (o.ov > 1) { fails++; console.log('OVERFLOW', w, h, o.ov, o.bad.join(',')); }
  }
  if (errs.length) { fails++; console.log('PAGEERROR', w, errs.slice(0, 3).join(' | ')); }
  console.log('width', w, '·', routes.length, 'routes ok');
  await page.close();
}
await br.close(); srv.close();
console.log(fails ? 'FAILS ' + fails : 'ALL CLEAN');
process.exitCode = fails ? 1 : 0;
