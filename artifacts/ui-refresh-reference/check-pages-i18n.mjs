import {chromium} from '../site-shots/node_modules/playwright/index.mjs';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const browser=await chromium.launch();const context=await browser.newContext({locale:'en-US'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:4187/?demo=1&lang=en#/overview',{waitUntil:'networkidle'});
const missing=[];
const collect=async (selector,label)=>{
 await page.evaluate(()=>window.BACI18N.refresh());
 const nodes=await page.locator(selector).evaluate(root=>{const out=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){const p=n.parentElement;if(!p||p.closest('script,style,[translate="no"],[data-i18n-ignore],.sym,.f-x,.hexbox,.logrow dd,.lg-n'))continue;const t=n.data.replace(/\s+/g,' ').trim();if(/[\u3400-\u9fff]/.test(t))out.push({text:t,selector:p.tagName.toLowerCase()+'.'+String(p.className),ancestor:p.parentElement?.className});}return out;});
 missing.push(...nodes.map(n=>({label,...n})));
};
try{
 const ids=await page.evaluate(()=>({block:BACVM.blocks[0].number,tx:BACVM.txs[0].hash,agent:BACVM.agents[0].id,epoch:BACVM.epochs[0].n,contract:BACVM.contractAddrs[0]}));
 const routes=['overview','blocks','txs','agents','treasury','validators','epochs','tokens','pairs','swaps',`block/${ids.block}`,`tx/${ids.tx}`,`agent/${ids.agent}`,`epoch/${ids.epoch}`,`contract/${ids.contract}`,'search/17','search/0x','search/notfound','block/99999999','tx/0x'+'f'.repeat(64),'agent/999999','epoch/999999','contract/0x'+'f'.repeat(40),'token/0x'+'f'.repeat(40),'pair/0x'+'f'.repeat(40)];
 for(const route of routes){await page.evaluate(route=>{location.hash='#/'+route;},route);await page.waitForTimeout(50);await collect('#v-'+route.split('/')[0],route);}
 const scenarios=await page.evaluate(()=>{
  const P=BACUI.pages,V=BACVM,out=[];
  function grab(id,label){BACI18N.refresh();const root=document.querySelector('#v-'+id);const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){const p=n.parentElement;if(!p||p.closest('script,style,[translate="no"],[data-i18n-ignore],.sym,.f-x,.hexbox,.logrow dd,.lg-n'))continue;const text=n.data.replace(/\s+/g,' ').trim();if(/[\u3400-\u9fff]/.test(text))out.push({label,text,selector:p.tagName.toLowerCase()+'.'+String(p.className),ancestor:p.parentElement?.className});}}
  for(const status of ['pre','loading','error','noidx']){
   for(const k of ['blocks','txs','agents','contracts','treasury','validators','fees','epochs'])V.st[k]=status;
   V.treasury.eventsStatus=status;
   P.renderBlocks();grab('blocks','blocks-'+status);P.renderTxs();grab('txs','txs-'+status);P.renderAgents();grab('agents','agents-'+status);P.renderTreasury();grab('treasury','treasury-'+status);P.renderValidators();grab('validators','validators-'+status);
   P.renderAgentDetail(987654);grab('agent','agent-'+status);P.renderContractDetail('0x'+'e'.repeat(40));grab('contract','contract-'+status);P.renderEpochDetail(987654);grab('epoch','epoch-'+status);
  }
  for(const k of ['blocks','txs','agents','contracts','treasury','validators','fees','epochs'])V.st[k]='ok';
  V.layer.source='rpc';P.renderBlocks();grab('blocks','blocks-rpc');P.renderTxs();grab('txs','txs-rpc');P.renderSearchPage('notfound');grab('search','search-rpc-empty');
  V.detail.blockErr={num:987654,code:'not_found'};P.renderBlockDetail(987654);grab('block','block-not-found');V.detail.blockErr.code='error';P.renderBlockDetail(987654);grab('block','block-error');
  const tx=V.txs[0];tx.logs=[];tx.logsCount=3;P.renderTxDetail(tx.hash);grab('tx','tx-raw-logs');tx.logsCount=null;P.renderTxDetail(tx.hash);grab('tx','tx-no-receipt');
  const a='0x'+'a'.repeat(40),b='0x'+'b'.repeat(40),c='0x'+'c'.repeat(40),now=Math.floor(Date.now()/1000);
  const t={address:a,symbol:'中文符号',name:'用户名字',detectLevel:'partial',decimals:18,totalSupply:100000000000000000000n,holders:4,transfers:5,swapCount:2,pairCount:1,agentId:17,wallet:b,deployTs:now,sameNameCount:2};
  const t1={...t,address:b,symbol:'另一个符号',name:'用户名字二'};
  const pair={address:c,kind:'v3',token0:t,token1:t1,feePpm:3000,agentId:17,wallet:b,deployTs:now,reserve0:1000000000000000000n,reserve1:2000000000000000000n,reserveBlock:17,reserveSource:'balanceOf',swapCount:2};
  const swap={ts:now,agentId:17,pair,side:'sell0',normalized:true,amountIn:1000000000000000000n,amountOut:2000000000000000000n,price1Per0:2000000000000000000n,tx:'0x'+'c'.repeat(64)};
  V.st.built='ok';V.built.tokens=[t];V.built.tokensTotal=1;V.built.pairs=[pair];V.built.pairsTotal=1;V.built.swaps=[swap,{...swap,side:'buy0'},{...swap,normalized:false}];V.built.detection={unclassified:2};
  V.built.tokenDetail={address:a,token:t,supplyCheck:{onchain:t.totalSupply,derived:t.totalSupply-1n,drift:1n},topHolders:[{rank:1,address:c,role:'pair',agentId:null,balance:1n,shareBps:100},{rank:2,address:b,role:'factory',agentId:null,balance:1n,shareBps:100},{rank:3,address:a,role:'token',agentId:null,balance:1n,shareBps:100}],pairs:[{...pair,other:t1}],recentTransfers:[{ts:now,from:a,to:b,value:1n,kind:'mint'},{ts:now,from:a,to:b,value:1n,kind:'burn'}]};
  P.renderTokens();grab('tokens','tokens-populated');P.renderTokenDetail(a);grab('token','token-populated');
  V.built.pairDetail={address:c,pair,price:{price1Per0:2000000000000000000n},liquidity:[{ts:now,kind:'add',agentId:17,amount0:1n,amount1:2n},{ts:now,kind:'remove',agentId:17,amount0:1n,amount1:2n}],recentSwaps:[swap,{...swap,side:'buy0'}]};
  P.renderPairs();grab('pairs','pairs-populated');P.renderPairDetail(c);grab('pair','pair-populated');P.renderSwaps();grab('swaps','swaps-populated');
  const ag=V.agents[0];ag.trades={swapCount:2,recent:[swap],pairs:[{address:c,swaps:2},{address:b,swaps:3}]};ag.built={tokens:[t],pairs:[pair]};ag.holdings=[{...t,token:a,balance:1n,shareBps:2,balanceDrift:true}];P.renderAgentDetail(ag.id);grab('agent','agent-built');
  return out;
 });
 missing.push(...scenarios);
}finally{await browser.close();}
const unique=[...new Map(missing.map(x=>[x.text,x])).values()];await writeFile(resolve('artifacts/ui-refresh-reference/pages-i18n-untranslated.json'),JSON.stringify({errors,unique},null,2)+'\n');console.log(JSON.stringify({errors,count:unique.length,unique},null,2));
