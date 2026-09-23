import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('https://bnbagentchain-scan.com', { waitUntil: 'networkidle' });
await p.waitForTimeout(9000);
const s = await p.evaluate(() => ({
  hasIndexer: window.BAC && BAC.HAS_INDEXER,
  indexer: window.BAC && JSON.parse(JSON.stringify(BAC.state.indexer)),
  layerSource: window.BAC && BAC.state.layer && BAC.state.layer.source,
  layerEndpoint: window.BAC && BAC.state.layer && BAC.state.layer.endpoint,
  warnings: window.BAC && BAC.state.warnings,
}));
console.log(JSON.stringify(s, null, 1).slice(0, 900));
await b.close();
