import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('https://bnbagentchain-scan.com', { waitUntil: 'networkidle' });
await p.waitForTimeout(9000);
for (const sel of ['#stateBar', '#degradedBar', '#demoBar']) {
  const vis = await p.isVisible(sel).catch(()=>null);
  const hid = await p.getAttribute(sel, 'hidden').catch(()=>null);
  console.log(sel, '可见=', vis, 'hidden属性=', hid);
}
const st = await p.evaluate(() => window.__VM ? window.__VM.st.idx : 'no __VM');
console.log('st.idx =', st);
await p.screenshot({ path: 'out/vis-hero.png' });
await b.close();
