import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve('../../web');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
const srv = http.createServer((q,r)=>{ let f=path.join(root, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith(path.sep)||fs.existsSync(f)&&fs.statSync(f).isDirectory()) f=path.join(f,'index.html'); if(!fs.existsSync(f)){r.writeHead(404);return r.end();} r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(r); }).listen(4321);
const b = await chromium.launch();
for (const [w,h,n] of [[1440,900,'desk'],[390,844,'mob']]) {
  const p = await b.newPage({ viewport:{width:w,height:h} });
  await p.goto('http://127.0.0.1:4321/#/overview',{waitUntil:'networkidle'}); await p.waitForTimeout(2500);
  const ov = await p.evaluate(()=>document.documentElement.scrollWidth - innerWidth);
  await p.screenshot({ path:`out/social-${n}-top.png`, clip:{x:0,y:0,width:w,height: n==='mob'?260:120} });
  const f = await p.$('.f-top'); await f.scrollIntoViewIfNeeded(); await f.screenshot({ path:`out/social-${n}-foot.png` });
  console.log(n,'horizontal overflow px:',ov, 'links:', await p.$$eval('a[href*="x.com/Bnbagentchain"],a[href*="github.com/BnbAgentChainL2"]', a=>a.length));
}
await b.close(); srv.close();
