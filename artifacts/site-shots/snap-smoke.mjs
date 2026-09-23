import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2];
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
const srv = http.createServer((q,r)=>{ let f=path.join(root, decodeURIComponent(q.url.split('?')[0])); if (fs.existsSync(f)&&fs.statSync(f).isDirectory()) f=path.join(f,'index.html'); if(!fs.existsSync(f)){r.writeHead(404);return r.end();} r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(r); }).listen(4322);
const b = await chromium.launch(); const errs=[];
const p = await b.newPage({ viewport:{width:1440,height:900}, locale:'zh-CN' });
p.on('pageerror', e=>errs.push('pageerror '+e.message)); p.on('console', m=>{ if(m.type()==='error') errs.push(m.text()); });
await p.goto('http://127.0.0.1:4322/#/overview',{waitUntil:'networkidle'}); await p.waitForTimeout(7000);
const h1 = await p.textContent('#headNum'); await p.waitForTimeout(8000); const h2 = await p.textContent('#headNum');
const body = await p.textContent('body');
const need = {'29a':'项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。','31a':'我们要求持有 agent 身份，我们不能证明它是 AI','CA':'0xA97452d175679B2bF5F25a9a382D22aff39b7777','rehearsal':'演练链','x':'@Bnbagentchain'};
for (const [k,v] of Object.entries(need)) console.log(k, body.includes(v));
const bad = ['只用于退出兑付','项目方动不了','限时签名','任何人都能指出它是错的','永久锁死'].filter(s=>body.includes(s));
console.log('head', h1, '->', h2, '| forbidden present:', bad, '| errors:', errs.slice(0,5));
for (const r of ['overview','treasury','validators','agents','blocks']) { const m = await b.newPage({viewport:{width:390,height:844}, locale:'zh-CN'}); await m.goto('http://127.0.0.1:4322/#/'+r,{waitUntil:'networkidle'}); await m.waitForTimeout(2500); console.log('390px', r, 'overflow', await m.evaluate(()=>document.documentElement.scrollWidth-innerWidth)); if(r==='overview') await m.screenshot({path:'out/snap-mob.png'}); await m.close(); }
await p.screenshot({path:'out/snap-desk.png'});
await b.close(); srv.close();
