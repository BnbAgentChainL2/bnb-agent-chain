/* BNB Agent Chain · 站点截图
   用法：node shoot.mjs <web 目录> <输出目录> [--demo]
   --demo 时给每个 URL 加上 ?demo=1（只有在 site.config.js 没填地址时才会真的出演示数据）。
   同时收集 console 错误、失败请求和横向溢出，跑完打印出来。 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2'
};

const root = process.argv[2] || process.cwd();
const outDir = process.argv[3] || '.';
const DEMO = process.argv.includes('--demo');
const suffix = DEMO ? '-demo' : '';
const query = DEMO ? '?demo=1' : '';

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const p = join(root, rel === '/' ? 'index.html' : rel);
  try {
    const b = await readFile(p);
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(b);
  } catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--disable-gpu'] });
const problems = [];

/* name, width, height, fullPage, hash */
const shots = [
  ['shot-desktop.png', 1440, 900, true, ''],
  ['shot-hero.png', 1440, 900, false, ''],
  ['shot-wide.png', 1920, 1080, false, ''],
  ['shot-wide-full.png', 1920, 1080, true, ''],
  ['shot-validators.png', 1440, 1100, true, '#/validators'],
  ['shot-treasury.png', 1440, 1100, true, '#/treasury'],
  ['shot-blocks.png', 1440, 1000, false, '#/blocks'],
  ['shot-block-detail.png', 1440, 1100, true, ':block'],
  ['shot-tx-detail.png', 1440, 1100, true, ':tx'],
  ['shot-epochs.png', 1440, 1000, false, '#/epochs'],
  ['shot-agents.png', 1440, 1000, false, '#/agents'],
  ['shot-mobile.png', 390, 844, true, ''],
  ['shot-mobile-top.png', 390, 844, false, ''],
  ['shot-mobile-validators.png', 390, 844, true, '#/validators']
];

for (const [name, w, h, full, hash] of shots) {
  const page = await browser.newPage({
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    isMobile: w < 500,
    hasTouch: w < 500
  });
  const tag = `${name}`;
  page.on('console', m => { if (m.type() === 'error') problems.push(`[console] ${tag} ${m.text()}`); });
  page.on('pageerror', e => problems.push(`[pageerror] ${tag} ${e.message}`));
  page.on('requestfailed', r => problems.push(`[request] ${tag} ${r.url()} ${r.failure()?.errorText}`));

  await page.goto(base + '/' + query, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  /* ':block' / ':tx' 表示「用页面上真实存在的第一条」，而不是写死一个假 id */
  let target = hash;
  if (hash === ':block' || hash === ':tx') {
    target = await page.evaluate(kind => {
      const vm = window.BACVM;
      if (kind === ':block') return vm && vm.blocks && vm.blocks[0] ? '#/block/' + vm.blocks[0].number : '#/blocks';
      return vm && vm.txs && vm.txs[0] ? '#/tx/' + vm.txs[0].hash : '#/txs';
    }, hash);
  }
  if (target) { await page.evaluate(h => { location.hash = h; }, target); }
  await page.waitForTimeout(1400);

  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    if (d.scrollWidth <= d.clientWidth + 1) return null;
    const bad = [];
    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.right > d.clientWidth + 2 && r.width > 8) bad.push(el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0]);
    });
    return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, bad: [...new Set(bad)].slice(0, 6) };
  });
  if (overflow) problems.push(`[overflow] ${tag} ${overflow.scrollWidth}>${overflow.clientWidth} ${overflow.bad.join(', ')}`);

  const outName = name.replace(/\.png$/, suffix + '.png');
  await page.screenshot({ path: join(outDir, outName), fullPage: full });
  await page.close();
  console.log('shot', outName);
}

await browser.close();
server.close();

if (problems.length) {
  console.log('\n--- 问题 ---');
  for (const p of [...new Set(problems)]) console.log(p);
  process.exitCode = 1;
} else {
  console.log('\n没有 console 错误、失败请求或横向溢出。');
}
