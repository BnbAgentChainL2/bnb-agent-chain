import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const root=process.argv[2];
const server=createServer(async(req,res)=>{const p=join(root,decodeURIComponent(req.url.split('?')[0])==='/'?'index.html':decodeURIComponent(req.url.split('?')[0]));try{const b=await readFile(p);res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream'});res.end(b);}catch{res.writeHead(404);res.end('404');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const b=await chromium.launch();const page=await b.newPage({viewport:{width:1440,height:900}});
const errs=[];page.on('pageerror',e=>errs.push(String(e)));page.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await page.goto(base,{waitUntil:'networkidle'});
const out={};
// search block
await page.fill('#sinput','1234560');await page.press('#sinput','Enter');await page.waitForTimeout(350);
out.blockSearch=await page.textContent('#dwTitle');
await page.click('#dwClose');await page.waitForTimeout(200);
// search agent
await page.fill('#sinput','#17');await page.press('#sinput','Enter');await page.waitForTimeout(350);
out.agentSearch=await page.textContent('#dwTitle');
await page.click('#dwClose');await page.waitForTimeout(200);
// suggestions
await page.fill('#sinput','0x8');await page.waitForTimeout(250);
out.suggCount=await page.$$eval('#sugg li',n=>n.length);
await page.press('#sinput','Escape');
// 查看全部 -> blocks view
await page.click('a[href="#/blocks"]');await page.waitForTimeout(500);
out.blocksRows=await page.$$eval('#blkBody tr',n=>n.length);
out.blocksVisible=await page.isVisible('#view-blocks');
await page.click('#blkFilter .chip[data-p="validator"]');await page.waitForTimeout(200);
out.validatorEmpty=(await page.textContent('#blkBody')).slice(0,20);
await page.click('#blkFilter .chip[data-p="all"]');await page.waitForTimeout(150);
// pagination
await page.click('#blkPager .pg[data-go="2"]');await page.waitForTimeout(250);
out.page2=await page.textContent('#blkPager span');
// txs view
await page.click('a[href="#/txs"]');await page.waitForTimeout(500);
out.txRows=await page.$$eval('#txBody tr',n=>n.length);
await page.click('#txFilter .chip[data-t="create"]');await page.waitForTimeout(200);
out.createRows=await page.$$eval('#txBody tr',n=>n.length);
// back home + anchor
await page.click('a[href="#validators"]');await page.waitForTimeout(600);
out.homeVisible=await page.isVisible('#view-home');
out.valVisible=await page.isVisible('#validators');
// agent card drawer
await page.click('a[href="#agents"]');await page.waitForTimeout(400);
await page.click('.ac');await page.waitForTimeout(300);
out.agentDrawer=await page.textContent('#dwTitle');
out.errs=errs;
console.log(JSON.stringify(out,null,1));
await b.close();server.close();
