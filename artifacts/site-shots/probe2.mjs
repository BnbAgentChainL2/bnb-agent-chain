/* 补充探针：验证者页「层内 gas 收入」的几个「—」、各页面的发射后公布计数、移动端溢出 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
const WEB = 'D:/CLAUDE DODODODODOODODODODODODOODODO/Agent CHAIN/web';
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const p = join(WEB, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  try { const b = await readFile(p); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(b); }
  catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.BACVM?.chain?.head > 0 && window.BACVM.blocks.length > 0, null, { timeout: 40000 });

const out = {};
for (const h of ['#/overview', '#/blocks', '#/txs', '#/validators', '#/treasury', '#/epochs', '#/agents']) {
  await page.evaluate(x => { location.hash = x; }, h);
  await page.waitForTimeout(2000);
  out[h] = await page.evaluate(() => {
    const view = document.querySelector('.view:not([hidden])');
    if (!view) return null;
    const leaves = [...view.querySelectorAll('*')].filter(e => !e.children.length);
    const count = s => leaves.filter(e => e.textContent.trim() === s).length;
    return {
      id: view.id,
      pre: count('发射后公布'), err: count('读取失败 · 重试中'), loading: count('读取中…'), dash: count('—'),
      badWords: [...view.querySelectorAll('*')].filter(e => !e.children.length && /示例|NaN|undefined/.test(e.textContent)).map(e => e.textContent.trim().slice(0, 60))
    };
  });
}
/* 验证者页「层内 gas 收入」那三个字段 */
await page.evaluate(() => { location.hash = '#/validators'; });
await page.waitForTimeout(2500);
out.valGas = await page.evaluate(() => {
  const p = [...document.querySelectorAll('#v-validators .panel')].find(x => /层内\s*gas\s*收入/.test(x.textContent));
  if (!p) return null;
  return { text: p.innerText.replace(/\n{2,}/g, '\n').slice(0, 700) };
});
out.valNodeList = await page.evaluate(() => {
  const b = document.querySelector('#valBody');
  return b ? b.innerText.trim().slice(0, 300) : null;
});
/* 移动端溢出与表格 */
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
await m.goto(base + '/', { waitUntil: 'domcontentloaded' });
await m.waitForFunction(() => window.BACVM?.chain?.head > 0, null, { timeout: 40000 });
await m.waitForTimeout(2000);
out.mobile = await m.evaluate(() => {
  const d = document.documentElement;
  const bad = [];
  document.querySelectorAll('*').forEach(el => { const r = el.getBoundingClientRect(); if (r.right > d.clientWidth + 2 && r.width > 8) bad.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0]); });
  return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, over: [...new Set(bad)].slice(0, 8), head: document.querySelector('#headNum')?.textContent.trim(), rows: document.querySelectorAll('#ovBlocks tr').length };
});
console.log(JSON.stringify(out, null, 2));
await browser.close(); server.close();
