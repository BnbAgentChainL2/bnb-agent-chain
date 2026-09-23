import { chromium } from '../site-shots/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const out=dirname(fileURLToPath(import.meta.url));
const base='http://127.0.0.1:4187';
const browser=await chromium.launch();
const report={base,dataMode:'explicit demo to isolate decorative feature requests',checks:[],errors:[],visibilityMethod:'document.hidden getter + visibilitychange event simulation; native lifecycle freeze does not make headless Chromium hidden'};
const check=(name,pass,details)=>{report.checks.push({name,pass,details});console.log((pass?'PASS ':'FAIL ')+name);};
const state=page=>page.evaluate(()=>{
 const hero=document.querySelector('.hero'),trace=hero.querySelector('.signal-main');
 const cs=getComputedStyle(trace),anim=trace.getAnimations()[0];
 return {signals:hero.dataset.signals,toggleCount:document.querySelectorAll('.signal-toggle').length,dash:parseFloat(cs.strokeDashoffset),animationState:cs.animationPlayState,currentTime:anim?.currentTime??null,animationCount:hero.getAnimations({subtree:true}).length,traceDisplay:cs.display,networkDisplay:getComputedStyle(hero.querySelector('.agent-network')).display,networkLinks:hero.querySelectorAll('.network-links use,.network-links path').length,documentHidden:document.hidden,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
});
try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'no-preference',locale:'zh-CN'});const page=await context.newPage();const requests=[];
  page.on('pageerror',e=>report.errors.push({width,message:e.message}));page.on('request',r=>requests.push(r.url()));
  await page.goto(base+'/?demo=1#/overview',{waitUntil:'networkidle'});await page.waitForTimeout(100);
  const initial=await state(page),requestCount=requests.length;await page.waitForTimeout(400);const moving=await state(page);
  check(`${width}: animation moves`,initial.signals==='running'&&moving.animationState==='running'&&Math.abs(moving.dash-initial.dash)>.1,{initial,moving});
  check(`${width}: motion toggle button absent`,initial.toggleCount===0,initial.toggleCount);
  await page.evaluate(()=>window.scrollTo({top:document.querySelector('.hero').offsetTop+document.querySelector('.hero').offsetHeight+500,behavior:'instant'}));
  await page.waitForTimeout(120);const outA=await state(page);await page.waitForTimeout(350);const outB=await state(page);
  check(`${width}: out of viewport pauses`,outB.signals==='paused'&&Math.abs(outB.dash-outA.dash)<.001,{outA,outB});
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.waitForTimeout(120);
  check(`${width}: viewport reentry resumes`,(await state(page)).signals==='running',await state(page));
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(80);const hiddenA=await state(page);await page.waitForTimeout(350);const hiddenB=await state(page);
  check(`${width}: hidden visibility event pauses`,hiddenB.documentHidden&&hiddenB.signals==='paused'&&Math.abs(hiddenB.dash-hiddenA.dash)<.001,{method:'simulated document.hidden + visibilitychange',hiddenA,hiddenB});
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(80);
  check(`${width}: visible event resumes`,(await state(page)).signals==='running',await state(page));
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(100);const reduced=await state(page);
  check(`${width}: reduced motion stays static`,reduced.signals==='paused'&&reduced.toggleCount===0&&reduced.animationCount===0&&reduced.traceDisplay==='none'&&reduced.networkDisplay!=='none'&&reduced.networkLinks>0,reduced);
  check(`${width}: no horizontal overflow`,reduced.overflow===0,reduced.overflow);
  await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForTimeout(100);
  await page.locator('.hero-act a[href="#/blocks"]').click();
  await page.locator('#v-blocks').waitFor({state:'visible',timeout:3000});
  check(`${width}: foreground link clickable`,await page.locator('#v-blocks').isVisible()&&await page.evaluate(()=>location.hash)==='#/blocks',await page.evaluate(()=>location.hash));
  check(`${width}: no runtime network requests`,requests.length===requestCount,{initialAssetRequests:requestCount,requestsAfterLoad:requests.slice(requestCount),externalRequests:requests.filter(url=>!url.startsWith(base))});
  await context.close();
 }
}finally{await browser.close();await writeFile(resolve(out,'hero-signals-audit.json'),JSON.stringify(report,null,2)+'\n');}
const failures=report.checks.filter(x=>!x.pass);console.log(JSON.stringify({checks:report.checks.length,failures:failures.length,errors:report.errors,report:resolve(out,'hero-signals-audit.json')},null,2));process.exitCode=failures.length||report.errors.length?1:0;
