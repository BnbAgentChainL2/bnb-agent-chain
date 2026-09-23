import { chromium } from 'playwright';
const b = await chromium.launch(); const errs=[];
const p = await b.newPage({ viewport:{width:1440,height:900} });
p.on('pageerror', e=>errs.push('pageerror '+e.message)); p.on('console', m=>{ if(m.type()==='error') errs.push(m.text().slice(0,160)); });
await p.goto('https://bnbagentchain-scan.com/#/overview',{waitUntil:'networkidle'}); await p.selectOption('#languageSelect','zh-CN').catch(()=>{});
await p.waitForTimeout(6000); const h1=await p.textContent('#headNum'); await p.waitForTimeout(9000); const h2=await p.textContent('#headNum');
for (const r of ['blocks','txs','agents','treasury']) { await p.goto('https://bnbagentchain-scan.com/#/'+r); await p.waitForTimeout(3500); }
console.log('head', h1, '->', h2, '| errors', errs.slice(0,6));
await b.close();
