/* 检查：控制台报错、横向溢出、折线以上可见行数、状态条是否有省略号、键盘搜索 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';

const TYPES = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png' };
const root = process.argv[2];
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  const p = join(root, rel === '/' ? 'index.html' : rel);
  try { const b = await readFile(p); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const routes = ['#/overview','#/blocks','#/txs','#/agents','#/epochs','#/treasury','#/validators',
                '#/block/1234566','#/tx/none','#/agent/17','#/epoch/20717','#/epoch/20690','#/search/17'];
let bad = 0;
for (const w of [1440, 1920, 390]) {
  for (const r of routes) {
    const page = await browser.newPage({ viewport: { width: w, height: w === 390 ? 844 : 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await page.goto(base + '/' + r, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      empty: document.querySelector('.view:not([hidden])')?.innerText.trim().length || 0
    }));
    const ov = m.sw - m.cw;
    if (errs.length || ov > 1 || m.empty < 50) {
      bad++;
      console.log(`BAD  ${w} ${r}  overflow=${ov} textlen=${m.empty} ${errs.slice(0,2).join(' | ')}`);
    }
    await page.close();
  }
}

/* 1440 折线以上：最新区块表可见行数 + 状态条省略号 */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + '/#/overview', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#ovBlocks tr')].filter(t => t.getBoundingClientRect().bottom <= 900).length;
    const txr = [...document.querySelectorAll('#ovTxs tr')].filter(t => t.getBoundingClientRect().bottom <= 900).length;
    const head = document.querySelector('.shell').getBoundingClientRect().height;
    const trunc = [...document.querySelectorAll('.ss i, .ss span')].filter(e => e.scrollWidth > e.clientWidth + 1)
      .map(e => e.textContent);
    const tableTop = document.querySelector('#ovBlocks').getBoundingClientRect().top;
    return { rows, txr, head: +head.toFixed(0), trunc, tableTop: +tableTop.toFixed(0) };
  });
  console.log('1440 折线：头高', r.head, '最新区块表起点 y=' + r.tableTop, '可见区块行', r.rows, '可见交易行', r.txr);
  console.log('1440 状态条被截断的标签：', r.trunc.length ? r.trunc : '无');
  if (r.rows < 8) { bad++; console.log('BAD 折线以上区块行数不足'); }
  if (r.trunc.length) bad++;
  await page.close();
}

/* 390：状态条不该横向滚动 */
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(base + '/#/overview', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => {
    const st = document.querySelector('.sstrip');
    const first = document.querySelector('.ss');
    return { strip: st.scrollWidth - st.clientWidth, leadBottom: +first.getBoundingClientRect().bottom.toFixed(0),
             cols: getComputedStyle(st).gridTemplateColumns };
  });
  console.log('390 状态条横向溢出', r.strip, '| 第一格底边 y=' + r.leadBottom, '| 列', r.cols);
  if (r.strip > 1) { bad++; console.log('BAD 390 状态条仍需横向滚动'); }
  await page.close();
}

/* 1920：版心是否吃满 */
{
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(base + '/#/overview', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => {
    const a = document.querySelector('.app').getBoundingClientRect();
    return { left: +a.left.toFixed(0), width: +a.width.toFixed(0) };
  });
  console.log('1920 版心宽', r.width, '左空边', r.left);
  if (r.left > 60) { bad++; console.log('BAD 1920 空边过大'); }
  await page.close();
}

/* 键盘搜索：↑↓ / Enter / Esc / 范围 chips */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + '/#/overview', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.keyboard.press('/');
  await page.type('#q', '1234560', { delay: 30 });
  await page.waitForTimeout(400);
  const n1 = await page.$$eval('#sresList a', a => a.length);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const sel = await page.$$eval('#sresList a.sel', a => a.map(x => x.textContent));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const h1 = await page.evaluate(() => location.hash);
  // 范围 chips 过滤
  await page.keyboard.press('/');
  await page.fill('#q', '0x');
  await page.type('#q', '0', { delay: 30 });
  await page.waitForTimeout(300);
  const all = await page.$$eval('#sresList a i', a => a.map(x => x.textContent));
  await page.click('#scope .chip[data-s="contract"]');
  await page.waitForTimeout(300);
  const only = await page.$$eval('#sresList a i', a => [...new Set(a.map(x => x.textContent))]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const closed = await page.$eval('#sres', e => e.hidden);
  console.log('搜索：联想', n1, '条 | ↑↓ 高亮', sel, '| Enter →', h1, '| 全部范围类型', [...new Set(all)], '| 合约范围类型', only, '| Esc 关闭', closed);
  if (!n1 || !sel.length || h1 === '#/overview' || !closed) { bad++; console.log('BAD 键盘搜索'); }
  if (only.length && only.some(t => t !== '合约')) { bad++; console.log('BAD 范围 chips 没有过滤'); }
  await page.close();
}

/* 区块列表：按出块者筛选 + 分账列 */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(base + '/#/blocks', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const chips = await page.$$eval('#blkChips .chip', b => b.map(x => x.textContent));
  const spl = await page.$eval('#blkBody tr .spl', e => e.textContent).catch(() => null);
  await page.click('#blkChips .chip[data-k="validator"]');
  await page.waitForTimeout(300);
  const emptyMsg = await page.$eval('#blkBody', e => e.innerText.slice(0, 40));
  console.log('区块筛选 chips', chips, '| 分账徽章', spl, '| 验证者筛选结果', JSON.stringify(emptyMsg));
  if (chips.join('') !== '全部官方节点验证者' || !spl) { bad++; console.log('BAD 区块列表'); }
  await page.close();
}

await browser.close(); server.close();
console.log(bad ? `\n失败 ${bad} 项` : '\n全部通过');
