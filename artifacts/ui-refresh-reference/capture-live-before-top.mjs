import {chromium} from '../site-shots/node_modules/playwright/index.mjs';
import {resolve} from 'node:path';
const browser=await chromium.launch();
for(const width of [1920,390]){
 const page=await browser.newPage({viewport:{width,height:width===390?844:1080},locale:'zh-CN'});
 await page.goto('https://bnbagentchain-scan.com/#/overview',{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(3500);
 const path=resolve(`artifacts/ui-refresh-reference/live-before-${width}-top.png`);
 await page.screenshot({path}); console.log(path); await page.close();
}
await browser.close();
