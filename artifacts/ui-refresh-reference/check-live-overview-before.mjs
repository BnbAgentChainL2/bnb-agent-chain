import { chromium } from '../site-shots/node_modules/playwright/index.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const out = resolve('artifacts/ui-refresh-reference');
await mkdir(out, {recursive:true});
const url = 'https://bnbagentchain-scan.com/#/overview';
const browser = await chromium.launch();
const report = {url, time:new Date().toISOString(), views:[], assets:[]};
const sha = b => createHash('sha256').update(b).digest('hex');
for (const width of [1920, 390]) {
  const context = await browser.newContext({viewport:{width,height:width===390?844:1080},locale:'zh-CN',ignoreHTTPSErrors:true});
  const page = await context.newPage();
  const errors = [], failed = [];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('requestfailed',q=>failed.push({url:q.url(),error:q.failure()?.errorText}));
  try {
    const response = await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForTimeout(12000);
    const screenshot = resolve(out,`live-before-${width}.png`);
    await page.screenshot({path:screenshot,fullPage:true});
    const info = await page.evaluate(()=>{
      const selectors=['body','.wrap','.shell','.hero','.hero h1','.hero p','.ss i','#ssGasPrice','.tbl','.nav','.fine','.disclaimer'];
      const styles={};
      for(const selector of selectors){const e=document.querySelector(selector);if(!e)continue;const c=getComputedStyle(e),r=e.getBoundingClientRect();styles[selector]={text:e.textContent.trim().slice(0,180),font:c.fontFamily,fontSize:c.fontSize,lineHeight:c.lineHeight,color:c.color,background:c.backgroundColor,width:r.width,height:r.height};}
      return {title:document.title,bodyText:document.body.innerText.slice(0,9000),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,styles,css:[...document.styleSheets].map(s=>s.href).filter(Boolean),scripts:[...document.scripts].map(s=>s.src).filter(Boolean),hasI18n:!!window.BACI18N,state:window.BACVM?{st:BACVM.st,head:BACVM.layer?.head,source:BACVM.layer?.source,blocks:BACVM.blocks?.length,txs:BACVM.txs?.length}:null};
    });
    const client = await context.newCDPSession(page);
    await client.send('DOM.enable'); await client.send('CSS.enable');
    const {root} = await client.send('DOM.getDocument');
    const fonts = {};
    for(const selector of ['.hero h1','.ss i','#ssGasPrice','.tbl']){
      const {nodeId}=await client.send('DOM.querySelector',{nodeId:root.nodeId,selector});
      if(nodeId)fonts[selector]=(await client.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;
    }
    report.views.push({width,status:response?.status(),screenshot,errors,failed,fonts,...info});
    console.log(JSON.stringify({width,status:response?.status(),screenshot,errors,overflow:info.overflow,styles:info.styles,state:info.state}));
    if(width===1920){
      const paths=['/','/css/scan-theme.css','/js/ui/i18n.js','/js/ui/pages.js'];
      for(const path of paths){
        try{
          const r=await context.request.get('https://bnbagentchain-scan.com'+path,{timeout:15000});
          const body=await r.body();const local=await readFile(resolve('web',path==='/'?'index.html':path.slice(1))).catch(()=>null);
          report.assets.push({path,status:r.status(),remoteBytes:body.length,remoteSha:sha(body),localSha:local?sha(local):null,equal:!!local&&sha(local)===sha(body)});
        }catch(e){report.assets.push({path,error:e.message});}
      }
    }
  }catch(e){report.views.push({width,error:e.message,errors,failed});console.log(JSON.stringify({width,error:e.message,errors,failed}));}
  await context.close();
}
await browser.close();
await writeFile(resolve(out,'live-before-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({assets:report.assets,report:resolve(out,'live-before-report.json')}));
