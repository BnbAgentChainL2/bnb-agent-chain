import { chromium } from '../site-shots/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const out=dirname(fileURLToPath(import.meta.url)),root=resolve(out,'../../web');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://127.0.0.1');const p=resolve(root,'.'+(u.pathname==='/'?'/index.html':decodeURIComponent(u.pathname)));if(!p.startsWith(root+sep)){res.writeHead(403);res.end();return;}const data=await readFile(p);res.writeHead(200,{'Content-Type':types[extname(p)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});
const errors=[],network=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>network.push({url:r.url(),error:r.failure()?.errorText}));
let result;
try{
 await page.goto(base+'/#/overview',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.BACVM?.mode!=='demo'&&window.BAC?.LAYER_LIVE===true&&typeof window.BACVM?.chain.head==='number'&&window.BACVM.chain.head>0&&window.BACVM.blocks.length>0,null,{timeout:40000}).catch(()=>{});
 result=await page.evaluate(()=>({mode:window.BACVM?.mode,head:window.BACVM?.chain.head,headDom:document.querySelector('[data-vm="chain.head"]')?.textContent,blockStatus:window.BACVM?.st.blocks,blockCount:window.BACVM?.blocks.length,blockRows:document.querySelectorAll('#ovBlocks tr').length,firstBlock:window.BACVM?.blocks[0]?.number,source:window.BACVM?.layer.source,endpoint:window.BACVM?.layer.endpoint,live:window.BAC?.LIVE,layerLive:window.BAC?.LAYER_LIVE,domDemoVisible:!document.querySelector('#demoBar')?.hidden,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}));
 result.pass=result.mode!=='demo'&&result.head>0&&result.blockCount>0&&result.blockRows>0&&!result.domDemoVisible&&!errors.length;
 await page.screenshot({path:resolve(out,'after-desktop-live-top.png')});
}finally{await browser.close();server.close();}
const report={...result,errors,network};await writeFile(resolve(out,'live-ui-audit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.pass?0:1;
