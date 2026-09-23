import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900} });
await p.goto('https://bnbagentchain-scan.com/#/overview',{waitUntil:'networkidle'});
await p.selectOption('#languageSelect','zh-CN').catch(()=>{}); await p.waitForTimeout(8000);
await p.screenshot({path:'out/live-final-zh.png'});
const n = await (await b.newContext({javaScriptEnabled:false, viewport:{width:1440,height:900}})).newPage();
await n.goto('https://bnbagentchain-scan.com/#/overview'); await n.waitForTimeout(1500); await n.screenshot({path:'out/live-final-nojs.png'});
await b.close();
