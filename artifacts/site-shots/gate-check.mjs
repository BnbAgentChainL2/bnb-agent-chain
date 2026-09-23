/* 验证演示数据的闸门：配了地址之后，?demo=1 也不许出现演示值 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'};
const root = process.argv[2];
const server = createServer(async (req,res)=>{
  const rel=decodeURIComponent(req.url.split('?')[0]);
  const p=join(root, rel==='/'?'index.html':rel);
  try{const b=await readFile(p);res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream'});res.end(b);}
  catch{res.writeHead(404);res.end('404');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();

async function check(label, addVault, url){
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  if(addVault){
    await page.addInitScript(()=>{ window.BAC_CONFIG={ addresses:{ vault:'0x69f54a00a7afa24b2aae437d8d58a95ee8321ed4', token:'0xe467672f9c0c85bb08012b5f4aabd4c16b247777' } }; });
  }
  await page.goto(base+url,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(2500);
  const r=await page.evaluate(()=>({
    mode: window.BACVM && window.BACVM.mode,
    live: window.BAC && window.BAC.LIVE,
    blocks: window.BACVM ? window.BACVM.blocks.length : -1,
    head: window.BACVM ? window.BACVM.chain.head : null,
    bodyHasDemoNumber: document.body.innerText.includes('1,234,5'),
    pre: (document.body.innerText.match(/发射后公布/g)||[]).length,
    err: (document.body.innerText.match(/读取失败 · 重试中/g)||[]).length
  }));
  console.log(label, JSON.stringify(r));
  await page.close();
}
await check('pre-launch, no demo   ', false, '/');
await check('pre-launch, ?demo=1   ', false, '/?demo=1');
await check('LIVE config, ?demo=1  ', true,  '/?demo=1');
await browser.close(); server.close();
