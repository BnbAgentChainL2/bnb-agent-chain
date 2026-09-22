/* 逐张 PNG 验非空：解码像素，统计不同颜色数与非背景像素比例。
   用法：node verify-shots.mjs "<dir>" [更多目录…] */
import { chromium } from 'playwright';
import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';

const dirs = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
let bad = 0, n = 0;

for (const dir of dirs) {
  const files = (await readdir(dir)).filter(f => f.endsWith('.png')).sort();
  console.log('\n=== ' + dir + ' (' + files.length + ' 张) ===');
  for (const f of files) {
    const b64 = (await readFile(join(dir, f))).toString('base64');
    const r = await page.evaluate(async (src) => {
      const img = new Image();
      await new Promise((ok, err) => { img.onload = ok; img.onerror = err; img.src = src; });
      const W = Math.min(img.width, 900), H = Math.min(img.height, 2400);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, img.width, img.height * (H / img.height) / (W / img.width) * (W / img.width), 0, 0, W, H);
      g.drawImage(img, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const seen = new Set();
      let light = 0, total = 0;
      for (let i = 0; i < d.length; i += 4 * 7) {
        total++;
        const k = (d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3);
        if (seen.size < 5000) seen.add(k);
        if (d[i] + d[i + 1] + d[i + 2] > 150) light++;
      }
      return { w: img.width, h: img.height, colors: seen.size, ink: +(light / total * 100).toFixed(2) };
    }, 'data:image/png;base64,' + b64);
    n++;
    const ok = r.colors >= 40 && r.ink >= 0.8;
    if (!ok) bad++;
    console.log((ok ? '  OK  ' : '  空白 ') + basename(f).padEnd(30) +
      r.w + 'x' + r.h + '  颜色数 ' + String(r.colors).padStart(5) + '  非背景像素 ' + r.ink + '%');
  }
}
await browser.close();
console.log('\n' + n + ' 张 PNG，' + (bad ? bad + ' 张疑似空白' : '全部非空'));
process.exit(bad ? 1 : 0);
