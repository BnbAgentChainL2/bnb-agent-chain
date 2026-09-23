import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium } from '../site-shots/node_modules/playwright/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, '../../web/assets');
const gold = '#F0B90B';
// Original rounded six-sided silhouette: BiBi's simple, friendly facial
// language informs the expression, while the outer geometry is independent.
const vertices = Array.from({ length: 6 }, (_, i) => {
  const angle = i * Math.PI / 3;
  return [256 + 180 * Math.cos(angle), 256 + 180 * Math.sin(angle)];
});
const toward = (from, to, distance) => {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return from.map((n, i) => n + (to[i] - n) * distance / length);
};
const coords = point => point.map(n => n.toFixed(6)).join(' ');
const body = vertices.map((v, i) => {
  const incoming = toward(v, vertices[(i + 5) % 6], 28);
  const outgoing = toward(v, vertices[(i + 1) % 6], 28);
  return `${i ? 'L' : 'M'}${coords(incoming)}Q${coords(v)} ${coords(outgoing)}`;
}).join('') + 'Z';
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><mask id="face" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
<rect width="512" height="512" fill="black"/>
<path d="${body}" fill="white"/>
<rect x="194" y="207" width="24" height="54" rx="12" fill="black"/>
<rect x="294" y="207" width="24" height="54" rx="12" fill="black"/>
<path d="M217 283H295C290 316 222 316 217 283Z" fill="black"/>
</mask></defs><rect width="512" height="512" fill="${gold}" mask="url(#face)"/>
</svg>`;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  payload.copy(result, 4);
  result.writeUInt32BE(crc32(payload), data.length + 8);
  return result;
}
function encodeGoldPng(alpha) {
  const size = 512;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = size * 4 + 1;
  const rows = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * stride + 1 + x * 4;
      const coverage = Math.round((alpha[y * size + x] + alpha[y * size + size - 1 - x]) / 2);
      rows[i] = coverage ? 240 : 0;
      rows[i + 1] = coverage ? 185 : 0;
      rows[i + 2] = coverage ? 11 : 0;
      rows[i + 3] = coverage;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

await mkdir(assets, { recursive: true });
await writeFile(resolve(here, 'logo.svg'), logoSvg);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 1 });
  const alpha = await page.evaluate(async svg => {
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
    await image.decode();
    const high = document.createElement('canvas');
    high.width = high.height = 2048;
    high.getContext('2d').drawImage(image, 0, 0, 2048, 2048);
    const target = document.createElement('canvas');
    target.width = target.height = 512;
    const ctx = target.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(high, 0, 0, 512, 512);
    const rgba = ctx.getImageData(0, 0, 512, 512).data;
    return Array.from({ length: 512 * 512 }, (_, i) => rgba[i * 4 + 3]);
  }, logoSvg);
  const logo = encodeGoldPng(alpha);
  await writeFile(resolve(assets, 'logo-512.png'), logo);
  const logoData = `data:image/png;base64,${logo.toString('base64')}`;

  await import('./render-banner.mjs');
  const bannerSvg = await readFile(resolve(here, 'banner.svg'), 'utf8');

  const preview = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Agent Companion logo preview</title>
<style>*{box-sizing:border-box}body{margin:0;padding:36px;background:#171a20;color:#ecedf0;font:14px Arial,sans-serif}header{display:flex;align-items:end;justify-content:space-between;margin-bottom:22px}h1{font-size:19px;font-weight:500;margin:0}header span{color:#8d939e;font-size:12px}.row{display:flex;align-items:center;justify-content:space-around;gap:30px;margin-bottom:18px;padding:26px 30px;border-radius:14px}.dark{background:#0b0e11}.light{background:#f8f9fa;color:#13161b}.sample{text-align:center;min-width:84px;color:#8a8f99;font-size:11px}.sample img{display:block;margin:0 auto 18px}.circle{border-radius:50%;outline:1px solid #737b88}.banner{display:block;width:900px;height:300px;border-radius:14px;margin-top:24px}.hero{display:flex;align-items:center;gap:48px}.hero img{width:220px;height:220px}.hero p{line-height:1.9;font-size:13px;color:#a5abb5}</style>
<header><h1>BNB AGENT CHAIN · Companion</h1><span>BiBi 表情语言参考 / 原创六边形轮廓</span></header>
<div class="hero"><img src="${logoData}"><p>竖向眼睛 · 简洁笑脸<br>饱满圆角 · 左右对称<br>单色金 · 透明底</p></div>
${['dark','light'].map(bg => `<section class="row ${bg}">${[32,48,96].map(size => `<div class="sample"><img src="${logoData}" width="${size}" height="${size}">${size}px</div>`).join('')}<div class="sample"><img src="${logoData}" class="circle" width="112" height="112">Circular crop</div></section>`).join('')}
<img class="banner" src="data:image/svg+xml;base64,${Buffer.from(bannerSvg).toString('base64')}"></html>`;
  await writeFile(resolve(here, 'preview.html'), preview);
  await page.setViewportSize({ width: 972, height: 1040 });
  await page.setContent(preview);
  await page.screenshot({ path: resolve(here, 'preview.png'), fullPage: true });
} finally {
  await browser.close();
}
console.log('Agent Companion logo and matching banner saved to web/assets; previews and original SVGs saved to artifacts/brand-assets.');
