import { chromium } from '../site-shots/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 1 });
const response = await page.goto('https://bscscan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);
await page.screenshot({ path: path.join(out, 'bscscan-desktop.png'), fullPage: true });
const report = await page.evaluate(() => {
  const colors = {};
  const fonts = {};
  const elements = Array.from(document.querySelectorAll('body *')).filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().height);
  for (const el of elements) {
    const s = getComputedStyle(el);
    for (const prop of ['color', 'backgroundColor', 'borderTopColor']) {
      const value = s[prop];
      if (value !== 'rgba(0, 0, 0, 0)') colors[prop + ':' + value] = (colors[prop + ':' + value] || 0) + 1;
    }
    const font = [s.fontFamily, s.fontSize, s.fontWeight].join(' | ');
    fonts[font] = (fonts[font] || 0) + 1;
  }
  const details = Array.from(document.querySelectorAll('body,header,nav,h1,h2,h3,.card,.card-header,.btn-primary,a,input')).slice(0, 100).map(el => {
    const s = getComputedStyle(el);
    return {tag:el.tagName, cls:el.className, text:el.textContent.trim().slice(0,90),color:s.color,bg:s.backgroundColor,border:s.borderColor,font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,radius:s.borderRadius};
  });
  return {title:document.title,text:document.body.innerText.slice(0,10000),stylesheets:Array.from(document.styleSheets).map(s=>s.href),colors:Object.entries(colors).sort((a,b)=>b[1]-a[1]).slice(0,40),fonts:Object.entries(fonts).sort((a,b)=>b[1]-a[1]).slice(0,20),details};
});
report.status = response?.status();
await fs.writeFile(path.join(out, 'bscscan-style-report.json'), JSON.stringify(report, null, 2));
await fs.writeFile(path.join(out, 'bscscan-page.html'), await page.content());
console.log(JSON.stringify({status:report.status,title:report.title,text:report.text.slice(0,1500),stylesheets:report.stylesheets,colors:report.colors.slice(0,20),fonts:report.fonts.slice(0,8)},null,2));
await browser.close();
