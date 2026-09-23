import {chromium} from '../site-shots/node_modules/playwright/index.mjs';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const b=await chromium.launch(),report=[];
for(const width of [1920,390]){
 const p=await b.newPage({viewport:{width,height:width===390?844:1080},locale:'zh-CN'}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto('http://127.0.0.1:4187/#/overview',{waitUntil:'domcontentloaded'});await p.waitForTimeout(12000);
 const d=await p.evaluate(()=>({language:BACI18N.getLanguage(),state:BACVM.st,source:BACVM.layer?.source,blocks:BACVM.blocks.length,latest:BACVM.blocks[0]?.number,txs:BACVM.txs.length,stateBarHidden:document.querySelector('#stateBar').hidden,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,verifyOpen:document.querySelector('#verify').open,heroHeight:document.querySelector('.hero').getBoundingClientRect().height,gas:document.querySelector('#ssGasPrice').textContent}));
 const path=resolve(`artifacts/ui-refresh-reference/width-copy-live-${width}-top.png`);await p.screenshot({path});report.push({width,...d,errors,screenshot:path});console.log(JSON.stringify(report.at(-1)));await p.close();
}
await b.close();await writeFile('artifacts/ui-refresh-reference/width-copy-live-final-report.json',JSON.stringify(report,null,2)+'\n');
