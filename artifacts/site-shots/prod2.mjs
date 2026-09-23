import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('https://bnbagentchain-scan.com', { waitUntil: 'networkidle' });
await p.waitForTimeout(7000);
const h1 = await p.textContent('#headNum').catch(()=>null);
await p.screenshot({ path: 'out/final-hero.png' });
await p.waitForTimeout(11000);
const h2 = await p.textContent('#headNum').catch(()=>null);
console.log('生产站块高 11 秒前后:', h1, '->', h2);
await p.screenshot({ path: 'out/final-desktop.png', fullPage: true });
for (const [route, name] of [['#/tokens','final-tokens'],['#/blocks','final-blocks'],['#/validators','final-validators']]) {
  await p.goto('https://bnbagentchain-scan.com/' + route, { waitUntil: 'networkidle' });
  await p.waitForTimeout(3500);
  await p.screenshot({ path: 'out/' + name + '.png' });
}
const w = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await w.goto('https://bnbagentchain-scan.com', { waitUntil: 'networkidle' });
await w.waitForTimeout(6000);
await w.screenshot({ path: 'out/final-wide.png' });
await b.close();
