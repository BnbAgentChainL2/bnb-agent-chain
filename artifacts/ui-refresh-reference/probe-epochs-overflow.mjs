import {chromium} from '../site-shots/node_modules/playwright/index.mjs';
const b=await chromium.launch();const p=await b.newPage({viewport:{width:390,height:844}});
await p.goto('http://127.0.0.1:4187/?demo=1&lang=en#/epochs',{waitUntil:'domcontentloaded'});await p.waitForTimeout(600);
console.log(JSON.stringify(await p.evaluate(()=>({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,bad:[...document.querySelectorAll('#v-epochs *')].filter(e=>!e.closest('.tw')).map(e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return{tag:e.tagName,cls:e.className,text:e.textContent.trim().slice(0,160),x:r.x,right:r.right,width:r.width,display:c.display,minWidth:c.minWidth,whiteSpace:c.whiteSpace,overflow:c.overflow,fontSize:c.fontSize,parent:e.parentElement.className};}).filter(r=>r.right>391&&r.width>5)})),null,2));
await p.screenshot({path:'artifacts/ui-refresh-reference/epochs-390-overflow.png',fullPage:true});await b.close();
