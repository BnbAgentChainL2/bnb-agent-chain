import {chromium} from '../site-shots/node_modules/playwright/index.mjs';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
const root=resolve('web'),out=resolve('artifacts/ui-refresh-reference');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const server=createServer(async(q,r)=>{const rel=decodeURIComponent(q.url.split('?')[0]);try{const p=join(root,rel==='/'?'index.html':rel),b=await readFile(p);r.writeHead(200,{'Content-Type':types[extname(p)]||'application/octet-stream'});r.end(b);}catch{r.writeHead(404);r.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();const report={time:new Date().toISOString(),views:[],failures:[]};
const check=(condition,label,detail)=>{if(!condition)report.failures.push({label,detail});};
try{
for(const width of [390,1440,1920]){
 const page=await browser.newPage({viewport:{width,height:width===390?844:1080},locale:'zh-CN',permissions:['clipboard-read','clipboard-write']}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?demo=1#/overview',{waitUntil:'domcontentloaded'});await page.waitForTimeout(650);
 const ids=await page.evaluate(()=>({b:BACVM.blocks[0].number,t:BACVM.txs[0].hash,a:BACVM.agents[0].id,e:BACVM.epochs[0].n}));
 const routes=['overview','blocks','txs','agents','epochs','treasury','validators','tokens','pairs','swaps','search/0x',`block/${ids.b}`,`tx/${ids.t}`,`agent/${ids.a}`,`epoch/${ids.e}`,'token/0x'+'f'.repeat(40),'pair/0x'+'f'.repeat(40)];
 const view={width,routes:[],interactions:{},errors};
 view.interactions.freshChineseBrowserDefaultEnglish=(await page.locator('#languageSelect').inputValue())==='en';check(view.interactions.freshChineseBrowserDefaultEnglish,`default English ${width}`);
 const verify=page.locator('#verify'),summary=page.locator('#verify summary');
 view.interactions.verifyInitiallyClosed=await verify.getAttribute('open')===null;check(view.interactions.verifyInitiallyClosed,`verify initial closed ${width}`);
 await summary.focus();await summary.press('Enter');view.interactions.verifyKeyboardOpen=await verify.getAttribute('open')!==null;check(view.interactions.verifyKeyboardOpen,`verify Enter open ${width}`);
 const copy=page.locator('#verify .vfy-code .cpy').first(),command=await page.locator('#verify .vfy-code code').first().textContent();
 await copy.click();await page.waitForTimeout(100);view.interactions.copyCurl=await page.evaluate(()=>navigator.clipboard.readText())===command;check(view.interactions.copyCurl,`copy curl ${width}`);
 await summary.focus();await summary.press('Enter');view.interactions.verifyKeyboardClose=await verify.getAttribute('open')===null;check(view.interactions.verifyKeyboardClose,`verify Enter close ${width}`);
 for(const language of ['zh-CN','en']){
  await page.locator('#languageSelect').selectOption(language);
  for(const route of routes){
   await page.evaluate(route=>{location.hash='#/'+route;},route);await page.waitForTimeout(90);
   const probe=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,active:[...document.querySelectorAll('.view:not([hidden])')].map(e=>e.id)}));
   check(probe.overflow<=1,`overflow ${width} ${language} ${route}`,probe);
   view.routes.push({language,route,...probe});
  }
 }
 await page.locator('#nav a[data-v="blocks"]').click();check(page.url().endsWith('#/blocks'),`nav ${width}`,page.url());view.interactions.nav=page.url().endsWith('#/blocks');
 const q=page.locator('#q');await q.fill(String(ids.b));await q.press('ArrowDown');
 check(await q.getAttribute('aria-expanded')==='true',`search open ${width}`);
 check(!!await q.getAttribute('aria-activedescendant'),`search keyboard selection ${width}`);
 await q.press('Enter');await page.waitForTimeout(100);
 view.interactions.search=page.url().endsWith('#/block/'+ids.b);check(view.interactions.search,`search navigate ${width}`,page.url());
 await q.fill('0x');await q.press('Escape');view.interactions.searchEsc=await q.getAttribute('aria-expanded')==='false';check(view.interactions.searchEsc,`search escape ${width}`);
 await page.locator('#languageSelect').selectOption('zh-CN');await page.locator('#nav a[data-v="overview"]').click();
 view.interactions.zh=(await page.locator('#nav a[data-v="blocks"]').innerText()).trim()==='区块';check(view.interactions.zh,`zh switch ${width}`);
 await page.locator('#languageSelect').selectOption('en');
 view.interactions.en=(await page.locator('#nav a[data-v="blocks"]').innerText()).trim()==='Blocks';check(view.interactions.en,`en switch ${width}`);
 view.layout=await page.evaluate(()=>{const out={};for(const s of ['.app','.hero','.hero h1','.hero p','.ss i','#ssGasPrice','.tbl','.fine','.disclaimer']){const e=document.querySelector(s);if(!e)continue;const c=getComputedStyle(e),r=e.getBoundingClientRect();out[s]={width:r.width,height:r.height,fontSize:c.fontSize,lineHeight:c.lineHeight,font:c.fontFamily,color:c.color};}return out;});
 await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(120);
 view.screenshot=resolve(out,`width-copy-after-${width}-top.png`);await page.screenshot({path:view.screenshot});
 if(width!==1440){view.fullScreenshot=resolve(out,`width-copy-after-${width}.png`);await page.screenshot({path:view.fullScreenshot,fullPage:true});}
 check(!errors.length,`JS errors ${width}`,errors);report.views.push(view);console.log(JSON.stringify({width,routes:view.routes.length,interactions:view.interactions,errors,screenshot:view.screenshot,layout:view.layout}));await page.close();
}
report.live=[];
for(const width of [1920,390]){
 const page=await browser.newPage({viewport:{width,height:width===390?844:1080},locale:'zh-CN'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/#/overview',{waitUntil:'domcontentloaded'});
 let loadError=null;try{await page.waitForFunction(()=>window.BACVM?.st.blocks==='ok'&&BACVM.blocks?.length>0,{timeout:20000});}catch(e){loadError=e.message;}
 const live=await page.evaluate(()=>({state:BACVM.st,source:BACVM.layer?.source,blocks:BACVM.blocks?.length,latest:BACVM.blocks?.[0]?.number,txs:BACVM.txs?.length,stateBarHidden:document.querySelector('#stateBar')?.hidden,language:document.querySelector('#languageSelect')?.value,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,verifyOpen:document.querySelector('#verify')?.open}));
 check(live.stateBarHidden,`live stateBar hidden ${width}`,live);check(live.overflow<=1,`live overflow ${width}`,live);check(!errors.length,`live JS errors ${width}`,errors);
 const screenshot=resolve(out,`width-copy-live-${width}-top.png`);await page.screenshot({path:screenshot});report.live.push({width,...live,loadError,errors,screenshot});console.log(JSON.stringify(report.live.at(-1)));await page.close();
}
}finally{await browser.close();server.close();}
await writeFile(resolve(out,'width-copy-after-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({failures:report.failures,report:resolve(out,'width-copy-after-report.json')}));process.exitCode=report.failures.length?1:0;
