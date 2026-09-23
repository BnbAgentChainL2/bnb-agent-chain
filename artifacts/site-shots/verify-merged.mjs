/* BNB Agent Chain · 合并后上线前的真链校验
   用法：node verify-merged.mjs <web 目录> <输出目录>
   所有断言都在代码里跑，不靠肉眼。失败会把全部问题打印出来并以退出码 1 结束。 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile, mkdir } from 'fs/promises';
import { extname, join } from 'path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2'
};

const root = process.argv[2];
const outDir = process.argv[3];
await mkdir(outDir, { recursive: true });

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
console.log('serving', root, 'at', base);

const browser = await chromium.launch({ args: ['--disable-gpu'] });
const problems = [];
const expected503 = new Set();
const notes = [];
const fail = m => { problems.push(m); console.log('FAIL ' + m); };
const ok = m => { notes.push(m); console.log('ok   ' + m); };

function newPage(w, h, tag) {
  return browser.newPage({
    viewport: { width: w, height: h }, deviceScaleFactor: 1,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    isMobile: w < 500, hasTouch: w < 500
  }).then(page => {
    page.on('pageerror', e => fail(`[pageerror] ${tag} ${e.message}`));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/status of 503/.test(t)) { expected503.add(tag); return; }   // 索引器未部署，/api/* 返回 503 —— 预期之内
      fail(`[console] ${tag} ${t}`);
    });
    page.on('requestfailed', r => { const u = r.url(); if (/\/api\//.test(u)) return; fail(`[request] ${tag} ${u} ${r.failure()?.errorText}`); });
    return page;
  });
}

const waitLive = async page => {
  await page.waitForFunction(() => {
    const v = window.BACVM;
    return v && v.chain && typeof v.chain.head === 'number' && v.chain.head > 0;
  }, null, { timeout: 45000 }).catch(() => {});
};

/* ═════════════ 1. 真链断言 ═════════════ */
const p1 = await newPage(1440, 1000, 'assert');
await p1.goto(base + '/', { waitUntil: 'domcontentloaded' });
await waitLive(p1);
await p1.waitForTimeout(2500);

const readState = () => p1.evaluate(() => {
  const vm = window.BACVM;
  const domHead = [...document.querySelectorAll('[data-vm="chain.head"]')].map(e => e.textContent.trim());
  return {
    head: vm.chain.head, headTs: vm.chain.headTs,
    interval: vm.chain.blockIntervalSec, gasLimit: vm.chain.gasLimit,
    baseFee: vm.chain.baseFee == null ? null : String(vm.chain.baseFee),
    gasPrice: vm.chain.gasPrice == null ? null : String(vm.chain.gasPrice),
    chainId: vm.chain.chainId, peers: vm.chain.peers, txpool: vm.chain.txpool,
    source: vm.layer && vm.layer.source, endpoint: vm.layer && vm.layer.endpoint,
    sections: vm.layer && vm.layer.sections,
    status: vm.status,
    domHead,
    blocks: vm.blocks.slice(0, 20).map(b => ({ n: b.number, ts: b.ts, txCount: b.txCount, miner: b.miner })),
    txs: vm.txs.slice(0, 10).map(t => ({ h: t.hash, b: t.blockNumber }))
  };
});

const s1 = await readState();
console.log('state#1', JSON.stringify({ head: s1.head, interval: s1.interval, source: s1.source, endpoint: s1.endpoint, sections: s1.sections, chainId: s1.chainId, gasLimit: s1.gasLimit, baseFee: s1.baseFee, gasPrice: s1.gasPrice, peers: s1.peers, txpool: s1.txpool }));

if (!(typeof s1.head === 'number' && s1.head > 10000)) fail(`头块不是 >10000 的真数字：${s1.head}`);
else ok(`头块 = ${s1.head}`);

/* DOM 上的头块也必须是同一个真数字 */
for (const t of s1.domHead) {
  if (!/^[\d,]+$/.test(t)) fail(`DOM 里的 chain.head 不是数字：「${t}」`);
}
if (s1.domHead.length && s1.domHead.every(t => /^[\d,]+$/.test(t))) ok(`DOM 头块 ${s1.domHead.join(' / ')}`);

/* 10 秒内必须增长 */
await p1.waitForTimeout(11000);
const s2 = await readState();
if (!(s2.head > s1.head)) fail(`头块 11 秒内没有增长：${s1.head} → ${s2.head}`);
else ok(`头块 11 秒内 ${s1.head} → ${s2.head}（+${s2.head - s1.head}）`);

/* 最新区块 >= 10 行，编号互不相同，时间戳合理 */
const rows = await p1.evaluate(() => {
  const tb = document.querySelector('#ovBlocks');
  return [...tb.querySelectorAll('tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
});
if (rows.length < 10) fail(`最新区块只有 ${rows.length} 行（需要 >= 10）`);
else ok(`最新区块 ${rows.length} 行`);

const nums = s2.blocks.map(b => b.n);
if (new Set(nums).size !== nums.length) fail(`区块编号有重复：${nums.join(',')}`);
else ok(`区块编号互不相同：${nums.slice(0, 12).join(', ')}…`);

const now = Math.floor(Date.now() / 1000);
const badTs = s2.blocks.filter(b => !(typeof b.ts === 'number' && b.ts > now - 86400 && b.ts <= now + 120));
if (badTs.length) fail(`区块时间戳不合理：${JSON.stringify(badTs.slice(0, 3))}`);
else ok(`区块时间戳合理（最新 ${new Date(s2.blocks[0].ts * 1000).toISOString()}，距今 ${now - s2.blocks[0].ts}s）`);

/* ═════════════ 2. 12 条路由 × 3 宽度 ═════════════ */
const blockN = s2.blocks[0] ? s2.blocks[0].n : null;
const txH = s2.txs[0] ? s2.txs[0].h : null;

const ROUTES = [
  ['overview', '#/overview'], ['blocks', '#/blocks'], ['txs', '#/txs'],
  ['agents', '#/agents'], ['tokens', '#/tokens'], ['pairs', '#/pairs'],
  ['swaps', '#/swaps'], ['epochs', '#/epochs'], ['treasury', '#/treasury'],
  ['validators', '#/validators'],
  ['block', blockN != null ? '#/block/' + blockN : '#/blocks'],
  ['tx', txH ? '#/tx/' + txH : '#/txs']
];
console.log('routes:', ROUTES.map(r => r[1]).join(' '));

const BAD = ['示例', 'NaN', 'undefined', '挑战窗口', '挑战中', '[object Object]', 'null'];
const placeholders = {};
const proseSamples = {};   /* panelName -> count */
const scanScript = (badList) => {
  const view = [...document.querySelectorAll('.view')].find(v => !v.hidden);
  if (!view) return { err: 'no visible view' };
  const hits = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const el = n.parentElement;
    if (!el || el.closest('script,style')) continue;
    if (el.offsetParent === null && el.tagName !== 'BODY' && !el.closest('.view:not([hidden])') && !el.closest('header,footer')) continue;
    const t = n.nodeValue;
    for (const b of badList) if (t.includes(b)) hits.push({ bad: b, text: t.trim().slice(0, 80), where: el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0] });
  }
  /* 「发射后公布」重复 */
  const dbl = [];
  document.querySelectorAll('*').forEach(el => {
    if (el.children.length) return;
    const t = (el.textContent || '').replace(/\s/g, '');
    const c = t.split('发射后公布').length - 1;
    if (c >= 2) dbl.push(el.className + ' :: ' + el.textContent.trim().slice(0, 60));
  });
  /* 「发射后公布」占位统计 */
  const ph = [];
  const scope = [
    [view.id.replace('v-',''), view],
    ['(全站头)', document.querySelector('header.shell')],
    ['(全站脚)', document.querySelector('footer')],
    ['(底部状态条)', document.querySelector('.statusbar')]
  ].filter(x => x[1]);
  scope.forEach(([scopeName, sc]) => {
    sc.querySelectorAll('*').forEach(el => {
      if (el.children.length) return;
      if (el.offsetParent === null) return;
      if (!(el.textContent || '').includes('发射后公布')) return;
      const panel = el.closest('.panel, .card, .kbox, section, footer, header');
      let label = '';
      if (panel) {
        const h = panel.querySelector('.ph-t, h1, h2, h3');
        label = h ? h.textContent.trim() : (panel.className || panel.tagName).toString().split(' ')[0];
      }
      /* 找最近的字段名 */
      const row = el.closest('tr, .ss, .kv, li, div');
      let field = '';
      if (row) {
        const i = row.querySelector('i, th, .k, dt, label');
        field = i ? i.textContent.trim() : '';
      }
      if (!field) field = (el.id || el.className || '').toString().split(' ')[0];
      const txt = (el.textContent || '').trim();
      ph.push({ scope: scopeName, panel: label, field: field, prose: txt.replace(/\s/g,'').length > 12, text: txt.slice(0, 70) });
    });
  });
  return { hits, dbl, ph, viewId: view.id, text: view.innerText };
};

const MONEY = /(\$\s?[\d,]+(\.\d+)?)|([+\-]\s?\d+(\.\d+)?\s?%)|市值|市價|涨跌幅|漲跌幅/;

for (const [w, h] of [[390, 844], [1440, 900], [1920, 1080]]) {
  for (const [name, hash] of ROUTES) {
    const tag = `${name}@${w}`;
    const page = await newPage(w, h, tag);
    await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
    await waitLive(page);
    await page.waitForTimeout(1800);
    const cur = await page.evaluate(() => location.hash);
    if (cur !== hash) fail(`[route] ${tag} hash 被改写成 ${cur}`);

    const r = await page.evaluate(scanScript, BAD);
    if (r.err) { fail(`[route] ${tag} ${r.err}`); await page.close(); continue; }

    for (const hit of r.hits) {
      /* 'null' 只在独立成词时算问题，避免误伤 */
      if (hit.bad === 'null' && !/\bnull\b/.test(hit.text)) continue;
      fail(`[脏字] ${tag} 「${hit.bad}」 in <${hit.where}> ${hit.text}`);
    }
    for (const d of r.dbl) fail(`[重复发射后公布] ${tag} ${d}`);

    if (w === 1440) {
      for (const x of r.ph) {
        const k = `${x.scope} | ${x.panel} › ${x.field}${x.prose ? '  [说明文字]' : ''}`;
        if (x.scope.startsWith('(')) { placeholders[k] = 1; }       // 全站公共，只算一次
        else placeholders[k] = (placeholders[k] || 0) + 1;
        if (x.prose) proseSamples[k] = x.text;
      }
      if (['tokens', 'pairs', 'swaps'].includes(name)) {
        const m = r.text.match(MONEY);
        if (m) fail(`[价格] ${tag} 出现美元价/市值/涨跌幅：「${m[0]}」`);
        else ok(`${name} 视图无美元价 / 市值 / 涨跌幅`);
      }
    }

    if (w === 1440 && name === 'overview') {
      const must = await page.evaluate(() => {
        const t = document.body.innerText;
        return {
          pre: t.includes('发射后公布'),
          rpcDirect: !!(window.BAC && window.BAC.TEXT && window.BAC.TEXT.RPC_DIRECT === '索引器读不到：区块与交易改由本站直接读层内节点，历史与搜索暂时不可用'),
          err: !!(window.BAC && window.BAC.TEXT && window.BAC.TEXT.ERR === '读取失败 · 重试中'),
          loading: t.includes('读取中…'),
          noAffil: t.includes('本项目与 Binance、BNB Chain、Flap 官方无关'),
          guardian: t.includes('Flap Guardian'),
          noPromise: t.includes('不承诺任何金额') || t.includes('不承诺任何收益'),
          live: window.BAC.LIVE, layerLive: window.BAC.LAYER_LIVE
        };
      });
      for (const [k, v] of Object.entries(must)) {
        if (k === 'live') { if (v !== false) fail(`BAC.LIVE 应为 false，实际 ${v}`); else ok('BAC.LIVE = false（BSC 代币未发射）'); continue; }
        if (k === 'layerLive') { if (v !== true) fail(`BAC.LAYER_LIVE 应为 true，实际 ${v}`); else ok('BAC.LAYER_LIVE = true（层内 RPC 在答话）'); continue; }
        if (!v) fail(`必备文案/披露缺失：${k}`); else ok(`必备文案/披露在：${k}`);
      }
    }

    const of = await page.evaluate(() => {
      const d = document.documentElement;
      if (d.scrollWidth <= d.clientWidth + 1) return null;
      const bad = [];
      document.querySelectorAll('*').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.right > d.clientWidth + 2 && r.width > 8) bad.push(el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0]);
      });
      return { sw: d.scrollWidth, cw: d.clientWidth, bad: [...new Set(bad)].slice(0, 6) };
    });
    if (of) fail(`[横向溢出] ${tag} ${of.sw}>${of.cw} ${of.bad.join(', ')}`);
    await page.close();
  }
  console.log(`--- 宽度 ${w} 12 条路由跑完 ---`);
}

/* ═════════════ 3. 截图 ═════════════ */
const SHOTS = [
  ['shot-hero.png', 1440, 900, false, ''],
  ['shot-desktop.png', 1440, 900, true, ''],
  ['shot-wide.png', 1920, 1080, false, ''],
  ['shot-blocks.png', 1440, 1000, true, '#/blocks'],
  ['shot-block-detail.png', 1440, 1100, true, blockN != null ? '#/block/' + blockN : '#/blocks'],
  ['shot-tokens.png', 1440, 1000, true, '#/tokens'],
  ['shot-pairs.png', 1440, 1000, true, '#/pairs'],
  ['shot-validators.png', 1440, 1100, true, '#/validators'],
  ['shot-treasury.png', 1440, 1100, true, '#/treasury'],
  ['shot-mobile.png', 390, 844, true, ''],
  ['shot-mobile-top.png', 390, 844, false, '']
];
const shotNames = [];
for (const [name, w, h, full, hash] of SHOTS) {
  const page = await newPage(w, h, name);
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await waitLive(page);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(outDir, name), fullPage: full });
  shotNames.push(name);
  console.log('shot', name);
  await page.close();
}

const s3 = await readState();
await p1.close();
await browser.close();
server.close();

console.log('\n=== 「发射后公布」占位（1440，按面板）===');
const phList = Object.entries(placeholders).sort((a, b) => b[1] - a[1]);
let phTotal = 0;
for (const [k, v] of phList) { console.log(`  ${v}×  ${k}`); phTotal += v; }
console.log(`占位总数 = ${phTotal}`);
console.log('\n=== 其中属于说明文字（不是数值占位）的 ===');
for (const [k, v] of Object.entries(proseSamples)) console.log(`  ${k}\n     「${v}」`);
console.log('\n预期内的 /api 503（索引器未部署）出现在 ' + expected503.size + ' 个页面标签');

console.log('\n=== 实测读数 ===');
console.log(JSON.stringify({
  head: s3.head, headTs: s3.headTs, blockIntervalSec: s3.interval,
  chainId: s3.chainId, gasLimit: s3.gasLimit, baseFee: s3.baseFee,
  gasPrice: s3.gasPrice, peers: s3.peers, txpool: s3.txpool,
  source: s3.source, endpoint: s3.endpoint, sections: s3.sections
}, null, 2));

console.log('\nSHOTS=' + shotNames.join(','));
console.log('PHTOTAL=' + phTotal);
console.log('PHLIST=' + JSON.stringify(phList));
if (problems.length) {
  console.log('\n--- 问题 ' + problems.length + ' 条 ---');
  for (const p of [...new Set(problems)]) console.log(p);
  process.exitCode = 1;
} else {
  console.log('\n全部断言通过。');
}
