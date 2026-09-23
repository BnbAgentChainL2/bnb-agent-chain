import { chromium } from '../site-shots/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = dirname(fileURLToPath(import.meta.url));
const root = resolve(out, '../../web');
const mode = process.argv[2] || 'before';
const captureOnly = process.argv.includes('--shots-only');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
await mkdir(out, { recursive:true });
const server = createServer(async (req,res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const file = resolve(root, '.' + (u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname)));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type':types[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' }); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args:['--disable-gpu'] });
const report = { mode, base, dataMode:'explicit ?demo=1; visual/interaction checks only', screenshots:[], pages:[], errors:[], interactions:[] };
const makePage = async (width,height) => {
  const page = await browser.newPage({ viewport:{width,height}, deviceScaleFactor:1, locale:'zh-CN', timezoneId:'Asia/Shanghai', isMobile:width<500 });
  page.on('pageerror', e => report.errors.push({type:'pageerror',width,url:page.url(),message:e.message}));
  page.on('console', m => { if(m.type()==='error') report.errors.push({type:'console',width,url:page.url(),message:m.text()}); });
  return page;
};
const inspect = async (page,width,route) => {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = [...document.querySelectorAll('*')].map(el => ({el,rect:el.getBoundingClientRect()})).filter(({el,rect}) => rect.width>8 && rect.right>doc.clientWidth+2 && getComputedStyle(el).position!=='fixed').slice(0,12).map(({el,rect})=>({selector:el.tagName.toLowerCase()+(el.id?'#'+el.id:'.'+String(el.className).split(' ')[0]),right:Math.round(rect.right)}));
    const rgb = color => (color.match(/[\d.]+/g)||[]).map(Number);
    const lum = c => c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
    const sampleKeys = new Set();
    const samples = [...document.querySelectorAll('.hero h1,.hero-sub,.ph-t,.note,.ph-m,.tbl td,.empty-box,.page-title,.notice p,.srcline b,.dyor,.vhead h1,.hero-facts li,.hr-foot.prose,.f-tag,.fine,.disclaimer p,.f-kind,.tag,.steps li')].filter(el=>el.getBoundingClientRect().height && el.getBoundingClientRect().width).map(el=>{
      const cs=getComputedStyle(el); let ancestor=el,bg=[255,255,255,1];
      while(ancestor){const c=rgb(getComputedStyle(ancestor).backgroundColor);if(c.length===3||c[3]===1){bg=c;break;}ancestor=ancestor.parentElement;}
      const fg=rgb(cs.color), l1=lum(fg),l2=lum(bg),contrast=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
      return {text:el.textContent.trim().slice(0,70),selector:el.tagName.toLowerCase()+'.'+String(el.className),color:cs.color,background:bg.slice(0,3),fontSize:cs.fontSize,fontWeight:cs.fontWeight,contrast:+contrast.toFixed(2),approximate:true};
    }).filter(sample=>{const key=[sample.selector,sample.color,sample.background.join(','),sample.fontSize,sample.fontWeight].join('|');if(sampleKeys.has(key))return false;sampleKeys.add(key);return true;});
    const clipped=[...document.querySelectorAll('.hero h1,.hero-sub,.ph-t,.notice p,.page-title')].filter(el=>el.getBoundingClientRect().width).filter(el=>{const cs=getComputedStyle(el);return ((cs.overflowX==='hidden'||cs.overflowX==='clip')&&el.scrollWidth>el.clientWidth+2)||((cs.overflowY==='hidden'||cs.overflowY==='clip')&&el.scrollHeight>el.clientHeight+2);}).map(el=>({text:el.textContent.trim().slice(0,100),selector:el.className}));
    return {hash:location.hash,view:document.querySelector('.view:not([hidden])')?.id,scrollWidth:doc.scrollWidth,clientWidth:doc.clientWidth,overflow,clipped,contrastSamples:samples,mode:window.BACVM?.mode};
  });
  report.pages.push({width,route,...r});
};
try {
  const sizes = [[1440,1000,'desktop'],[390,844,'mobile']];
  if(mode==='after') sizes.push([1920,1080,'wide']);
  for(const [width,height,label] of sizes){
    const page=await makePage(width,height);
    await page.goto(base+'/?demo=1#/overview',{waitUntil:'domcontentloaded'});
    await page.waitForTimeout(650);
    await page.screenshot({path:resolve(out,`${mode}-${label}.png`),fullPage:true});
    await page.screenshot({path:resolve(out,`${mode}-${label}-top.png`)});
    report.screenshots.push(resolve(out,`${mode}-${label}.png`),resolve(out,`${mode}-${label}-top.png`));
    if(mode==='after' && !captureOnly){
      await inspect(page,width,'overview');
      const firstBlock=await page.evaluate(()=>window.BACVM.blocks[0]?.number);
      await page.locator('#nav a[data-v="blocks"]').click();
      await page.waitForTimeout(150);
      report.interactions.push({width,name:'navigation-blocks',pass:await page.locator('#v-blocks').isVisible()});
      await page.screenshot({path:resolve(out,`after-${label}-blocks.png`),fullPage:true});
      report.screenshots.push(resolve(out,`after-${label}-blocks.png`));
      if(firstBlock!=null){
        await page.locator('#q').fill(String(firstBlock));
        await page.locator('#q').press('Enter');await page.waitForTimeout(180);
        const hash=await page.evaluate(()=>location.hash);
        report.interactions.push({width,name:'search-block',query:String(firstBlock),hash,pass:hash===`#/block/${firstBlock}`});
      }
      const routes=['overview','blocks','txs','agents','epochs','treasury','validators','tokens','pairs','swaps'];
      for(const route of routes){
        await page.evaluate(r=>{location.hash='#/'+r;},route);await page.waitForTimeout(100);
        await inspect(page,width,route);
        if(route==='tokens'){
          await page.screenshot({path:resolve(out,`after-${label}-tokens-empty.png`),fullPage:true});
          report.screenshots.push(resolve(out,`after-${label}-tokens-empty.png`));
        }
      }
    }
    await page.close();
  }
} finally {
  await browser.close();server.close();
  await writeFile(resolve(out,`${mode}-audit.json`),JSON.stringify(report,null,2)+'\n');
}
const failures=[...report.errors,...report.pages.filter(p=>p.scrollWidth>p.clientWidth+1||p.clipped.length),...report.interactions.filter(x=>!x.pass)];
console.log(JSON.stringify({mode,base,screenshots:report.screenshots,errors:report.errors,interactions:report.interactions,pages:report.pages.length,failures:failures.length},null,2));
process.exitCode=failures.length?1:0;
