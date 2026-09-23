import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium } from '../site-shots/node_modules/playwright/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, '../../web/assets');
const gold = '#F0B90B';
const body = 'M256 88C166 88 92 149 92 214V314Q92 328 106 328H123Q138 328 142 344L150 374Q152 381 159 388L184 414Q190 420 198 420H314Q322 420 328 414L353 388Q360 381 362 374L370 344Q374 328 389 328H406Q420 328 420 314V214C420 149 346 88 256 88Z';
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><mask id="face" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
<rect width="512" height="512" fill="black"/>
<path d="${body}" fill="white"/>
<circle cx="256" cy="155" r="17" fill="black"/>
<rect x="118" y="216" width="276" height="102" rx="29" fill="black"/>
<rect x="155" y="252" width="70" height="30" rx="7" fill="white"/>
<rect x="287" y="252" width="70" height="30" rx="7" fill="white"/>
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
      rows[i] = 240;
      rows[i + 1] = 185;
      rows[i + 2] = 11;
      rows[i + 3] = Math.round((alpha[y * size + x] + alpha[y * size + size - 1 - x]) / 2);
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

  const grid = [];
  const r = 36;
  const w = Math.sqrt(3) * r;
  const points = Array.from({ length: 6 }, (_, i) => {
    const a = (60 * i - 90) * Math.PI / 180;
    return `${(r * Math.cos(a)).toFixed(3)},${(r * Math.sin(a)).toFixed(3)}`;
  }).join(' ');
  for (let row = -1; row < 11; row++) {
    for (let col = -1; col < 26; col++) {
      grid.push(`<polygon points="${points}" transform="translate(${(col * w + Math.abs(row % 2) * w / 2).toFixed(3)} ${row * 54})"/>`);
    }
  }
  const nodes = [[503, 4.5, 0.85], [599, 4, 0.65], [695, 3.5, 0.45], [791, 3, 0.28], [887, 2.5, 0.15], [983, 2, 0.07], [1079, 1.5, 0.025]];
  const network = nodes.map(([x, radius, opacity], i) => {
    const next = nodes[i + 1];
    const line = next ? `<path d="M${x + radius} 250H${next[0] - next[1]}" stroke="${gold}" stroke-width="${(1.35 - i * 0.12).toFixed(2)}" opacity="${opacity * 0.65}"/>` : '';
    return `${line}<circle cx="${x}" cy="250" r="${radius}" fill="${gold}" opacity="${opacity}"/>`;
  }).join('');
  const bannerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
<rect width="1500" height="500" fill="#0B0E11"/>
<g fill="none" stroke="#080B0D" stroke-width="0.6" opacity="0.7">${grid.join('')}</g>
<image x="216" y="106" width="288" height="288" href="${logoData}"/>
${network}</svg>`;
  await writeFile(resolve(here, 'banner.svg'), bannerSvg);
  await page.setContent(`<html><body style="margin:0;width:1500px;height:500px;overflow:hidden">${bannerSvg}</body></html>`);
  await page.screenshot({ path: resolve(assets, 'banner-1500x500.png'), type: 'png' });

  const preview = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AI Agent logo preview</title>
<style>*{box-sizing:border-box}body{margin:0;padding:36px;background:#171a20;color:#ecedf0;font:14px Arial,sans-serif}header{display:flex;align-items:end;justify-content:space-between;margin-bottom:22px}h1{font-size:19px;font-weight:500;margin:0}header span{color:#8d939e;font-size:12px}.row{display:flex;align-items:center;justify-content:space-around;gap:30px;margin-bottom:18px;padding:26px 30px;border-radius:14px}.dark{background:#0b0e11}.light{background:#f8f9fa;color:#13161b}.sample{text-align:center;min-width:84px;color:#8a8f99;font-size:11px}.sample img{display:block;margin:0 auto 18px}.circle{border-radius:50%;outline:1px solid #737b88}.banner{display:block;width:900px;height:300px;border-radius:14px;margin-top:24px}.hero{display:flex;align-items:center;gap:48px}.hero img{width:220px;height:220px}.hero p{line-height:1.9;font-size:13px;color:#a5abb5}</style>
<header><h1>BNB AGENT CHAIN · Core</h1><span>Selected direction / flat single-color artwork</span></header>
<div class="hero"><img src="${logoData}"><p>Calm horizontal eyes<br>Central sensor<br>Solid, symmetrical silhouette<br>Transparent gold mark</p></div>
${['dark','light'].map(bg => `<section class="row ${bg}">${[32,48,96].map(size => `<div class="sample"><img src="${logoData}" width="${size}" height="${size}">${size}px</div>`).join('')}<div class="sample"><img src="${logoData}" class="circle" width="112" height="112">Circular crop</div></section>`).join('')}
<img class="banner" src="data:image/svg+xml;base64,${Buffer.from(bannerSvg).toString('base64')}"></html>`;
  await writeFile(resolve(here, 'preview.html'), preview);
  await page.setViewportSize({ width: 972, height: 1040 });
  await page.setContent(preview);
  await page.screenshot({ path: resolve(here, 'preview.png'), fullPage: true });
} finally {
  await browser.close();
}
console.log('Core Agent logo and matching banner saved to web/assets; previews and original SVGs saved to artifacts/brand-assets.');
