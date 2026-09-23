import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../site-shots/node_modules/playwright/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, '../../web/assets');
const GOLD = '#F0B90B';
const R = 180;
const STROKE = 20;
const DOT = 27;
const C = Math.sqrt(3) / 2;
const inner = R - STROKE / C;
const points = radius => Array.from({ length: 6 }, (_, i) => {
  const angle = (i * 60 - 90) * Math.PI / 180;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
});
const polygon = radius => points(radius).map(p => p.map(n => n.toFixed(6)).join(',')).join(' ');
const outline = radius => `M${points(radius).map(p => p.map(n => n.toFixed(6)).join(' ')).join('L')}Z`;
const mark = `<defs><clipPath id="hex-clip"><polygon points="${polygon(R)}"/></clipPath></defs>
<g fill="${GOLD}" clip-path="url(#hex-clip)">
<path fill-rule="evenodd" d="${outline(R)} ${outline(inner)}"/>
<path d="${points(R).map(([x, y]) => `M0 0L${x.toFixed(6)} ${y.toFixed(6)}`).join(' ')}" fill="none" stroke="${GOLD}" stroke-width="${STROKE}"/>
<circle r="${DOT}"/>
</g>`;
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><g transform="translate(256 256)">${mark}</g></svg>`;

// Original geometric rasterization: subpixel area coverage, mirrored in both
// axes. Every nontransparent pixel has exactly the requested RGB value.
// This does not process or reuse image-model output.
function logoPixels(size, samples = 8) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const scale = 512 / size;
  const half = size / 2;
  const inHex = (x, y, radius) => x <= C * radius && y + x / Math.sqrt(3) <= radius;
  for (let py = 0; py < half; py++) {
    for (let px = 0; px < half; px++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = Math.abs((px + (sx + 0.5) / samples) * scale - 256);
          const y = Math.abs((py + (sy + 0.5) / samples) * scale - 256);
          if (inHex(x, y, R) && (
            !inHex(x, y, inner) ||
            x <= STROKE / 2 ||
            Math.abs(0.5 * x - C * y) <= STROKE / 2 ||
            x * x + y * y <= DOT * DOT
          )) hits++;
        }
      }
      const alpha = Math.round(hits * 255 / (samples * samples));
      for (const [x, y] of [[px, py], [size - 1 - px, py], [px, size - 1 - py], [size - 1 - px, size - 1 - py]]) {
        const i = (y * size + x) * 4;
        pixels[i] = 240;
        pixels[i + 1] = 185;
        pixels[i + 2] = 11;
        pixels[i + 3] = alpha;
      }
    }
  }
  return pixels;
}

// Encode RGBA directly to PNG to preserve the exact RGB values even on
// partially transparent edge pixels (no premultiplied-alpha rounding).
const { deflateSync } = await import('node:zlib');
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
function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(rows, y * (size * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

await mkdir(assets, { recursive: true });
const logo = png(512, logoPixels(512));
await writeFile(resolve(assets, 'logo-512.png'), logo);
await writeFile(resolve(here, 'logo.svg'), logoSvg);

const grid = [];
const gridR = 30;
const gridW = Math.sqrt(3) * gridR;
for (let row = -1; row < 13; row++) {
  for (let col = -1; col < 31; col++) {
    const x = col * gridW + (Math.abs(row % 2) ? gridW / 2 : 0);
    const y = row * gridR * 1.5;
    grid.push(`<polygon points="${polygon(gridR)}" transform="translate(${x.toFixed(3)} ${y.toFixed(3)})"/>`);
  }
}
const nodes = [
  [480, 4, 0.90], [566, 3.5, 0.72], [652, 3, 0.53],
  [738, 2.5, 0.35], [824, 2, 0.20], [910, 1.5, 0.10], [996, 1, 0.04],
];
const network = nodes.map(([x, r, opacity], i) => {
  const line = i < nodes.length - 1 ? `<path d="M${x + r} 250H${nodes[i + 1][0] - nodes[i + 1][1]}" stroke="${GOLD}" stroke-width="${(1.25 - i * 0.12).toFixed(2)}" opacity="${(opacity * 0.7).toFixed(3)}"/>` : '';
  return `${line}<circle cx="${x}" cy="250" r="${r}" fill="${GOLD}" opacity="${opacity}"/>`;
}).join('');
const bannerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
<rect width="1500" height="500" fill="#0B0E11"/>
<g fill="none" stroke="#080B0D" stroke-width="0.7">${grid.join('')}</g>
<image x="232" y="122" width="256" height="256" href="data:image/png;base64,${logo.toString('base64')}"/>
${network}
</svg>`;
await writeFile(resolve(here, 'banner.svg'), bannerSvg);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;width:1500px;height:500px;overflow:hidden">${bannerSvg}</body></html>`);
  await page.screenshot({ path: resolve(assets, 'banner-1500x500.png'), type: 'png' });

  const data = `data:image/png;base64,${logo.toString('base64')}`;
  const preview = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Logo size and crop preview</title>
  <style>body{margin:0;padding:32px;background:#25282d;color:#fff;font:14px Arial,sans-serif}h1{font-size:18px}section{display:flex;align-items:center;gap:40px;margin:20px 0;padding:28px;border-radius:12px}.dark{background:#0b0e11}.light{background:#fff;color:#111}.sample{text-align:center;min-width:100px}.sample img{display:block;margin:0 auto 14px}.circle{border-radius:50%;outline:1px solid #929292}.large{image-rendering:pixelated}.banner{width:900px;height:300px;display:block}</style>
  <h1>Actual-size logo checks · 32 / 48 / 128 px + circular crop</h1>
  ${['dark', 'light'].map(bg => `<section class="${bg}">${[32, 48, 128].map(size => `<div class="sample"><img src="${data}" width="${size}" height="${size}">${size} px</div>`).join('')}<div class="sample"><img class="circle" src="${data}" width="128" height="128">Circular crop</div></section>`).join('')}
  <img class="banner" src="data:image/svg+xml;base64,${Buffer.from(bannerSvg).toString('base64')}"></html>`;
  await writeFile(resolve(here, 'preview.html'), preview);
  await page.setViewportSize({ width: 964, height: 940 });
  await page.setContent(preview);
  await page.screenshot({ path: resolve(here, 'preview.png'), fullPage: true });
} finally {
  await browser.close();
}
console.log('Saved web/assets/logo-512.png (512×512 RGBA), web/assets/banner-1500x500.png (1500×500), and artifacts/brand-assets/preview.html');
