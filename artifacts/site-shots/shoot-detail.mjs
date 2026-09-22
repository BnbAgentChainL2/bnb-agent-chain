import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const root=process.argv[2], out=process.argv[3];
const server=createServer(async(req,res)=>{const p=join(root,decodeURIComponent(req.url.split('?')[0])==='/'?'index.html':decodeURIComponent(req.url.split('?')[0]));try{const b=await readFile(p);res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream'});res.end(b);}catch{res.writeHead(404);res.end('404');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const br=await chromium.launch();
// 1. 搜索下拉
let page=await br.newPage({viewport:{width:1440,height:900}});
await page.goto(base,{waitUntil:'networkidle'}); await page.waitForTimeout(900);
await page.click('#q'); await page.type('#q','1234560',{delay:40}); await page.waitForTimeout(500);
await page.screenshot({path:out+'/shot-search.png'});
console.log('shot shot-search.png');
// 2. 区块详情抽屉
await page.keyboard.press('Enter'); await page.waitForTimeout(700);
await page.screenshot({path:out+'/shot-block-detail.png'});
console.log('shot shot-block-detail.png');
// 3. 交易详情抽屉
await page.keyboard.press('Escape'); await page.waitForTimeout(400);
await page.click('#txBody tr:first-child'); await page.waitForTimeout(700);
await page.screenshot({path:out+'/shot-tx-detail.png'});
console.log('shot shot-tx-detail.png');
// 4. agent 详情
await page.keyboard.press('Escape'); await page.waitForTimeout(400);
await page.evaluate(()=>document.querySelector('#agents').scrollIntoView({block:'start'}));
await page.waitForTimeout(500);
await page.click('#agentCards .card'); await page.waitForTimeout(700);
await page.screenshot({path:out+'/shot-agent-detail.png'});
console.log('shot shot-agent-detail.png');
await br.close(); server.close();
