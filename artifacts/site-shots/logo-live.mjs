import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport:{width:1440,height:900} });
await p.goto('https://bnbagentchain-scan.com/#/overview',{waitUntil:'networkidle'}); await p.selectOption('#languageSelect','zh-CN').catch(()=>{}); await p.waitForTimeout(5000);
await p.screenshot({path:'out/live-logo.png', clip:{x:0,y:0,width:1440,height:700}}); await b.close();
