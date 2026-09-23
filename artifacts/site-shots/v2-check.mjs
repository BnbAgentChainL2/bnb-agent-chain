import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2];
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json'};
const srv = http.createServer((q,r)=>{ let f=path.join(root, decodeURIComponent(q.url.split('?')[0])); if (fs.existsSync(f)&&fs.statSync(f).isDirectory()) f=path.join(f,'index.html'); if(!fs.existsSync(f)){r.writeHead(404);return r.end();} r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(r); }).listen(4331);
const b = await chromium.launch(); const errs=[];
const p = await b.newPage({ viewport:{width:1440,height:900} });
p.on('pageerror', e=>errs.push('pageerror '+e.message)); p.on('console', m=>{ if(m.type()==='error') errs.push(m.text().slice(0,200)); });
await p.goto('http://127.0.0.1:4331/#/overview',{waitUntil:'networkidle'}); await p.selectOption('#languageSelect','zh-CN').catch(()=>{});
await p.waitForTimeout(12000); const h1=await p.textContent('#headNum');
await p.screenshot({path:'out/v2-overview.png', fullPage:false});
for (const r of ['treasury','validators','agents','epochs']) { await p.goto('http://127.0.0.1:4331/#/'+r); await p.waitForTimeout(9000); await p.screenshot({path:`out/v2-${r}.png`, fullPage:true}); }
await p.goto('http://127.0.0.1:4331/#/overview'); await p.waitForTimeout(8000); const h2=await p.textContent('#headNum');
const body = await p.textContent('body');
console.log('head', h1, '->', h2);
for (const a of ['0x2129f336ff42821afa27fE5928Dec36Ba90d3508','0x63D213C8AAa4E1C758ea41f8ed35066181B8e818','0xBf92C03f2eD3b7aDFC4908019DF51a0401fC23Ff']) console.log('addr on page', a.slice(0,10), body.includes(a) || body.toLowerCase().includes(a.toLowerCase()));
for (const w of [390]) for (const r of ['overview','treasury','validators','agents','epochs','blocks']) { const m = await b.newPage({viewport:{width:w,height:844}}); await m.goto('http://127.0.0.1:4331/#/'+r,{waitUntil:'networkidle'}); await m.waitForTimeout(3000); console.log(w, r, 'overflow', await m.evaluate(()=>document.documentElement.scrollWidth-innerWidth)); await m.close(); }
console.log('errors', errs.slice(0,8));
await b.close(); srv.close();
