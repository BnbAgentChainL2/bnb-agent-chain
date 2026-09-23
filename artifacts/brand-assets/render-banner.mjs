import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from '../site-shots/node_modules/playwright/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, '../../web/assets');
const archive = resolve(here, 'archive/v4-banner-dark');
await mkdir(archive, { recursive: true });
for (const [source, name] of [[resolve(assets, 'banner-1500x500.png'), 'banner-1500x500.png'], [resolve(here, 'banner.svg'), 'banner.svg']]) {
  try { await copyFile(source, resolve(archive, name), 1); } catch (error) { if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error; }
}
const logo = await readFile(resolve(assets, 'logo-512.png'));
const logoHash = createHash('sha256').update(logo).digest('hex');
const logoData = `data:image/png;base64,${logo.toString('base64')}`;
const bannerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
<title>BNB AGENT CHAIN</title>
<desc>Gold and navy typography on warm white, with the original Agent Companion mark in a restrained network.</desc>
<defs>
  <style>text{font-family:Arial,'Liberation Sans',sans-serif;font-weight:700}</style>
  <clipPath id="canvas"><rect width="1500" height="500"/></clipPath>
</defs>
<g clip-path="url(#canvas)">
  <rect width="1500" height="500" fill="#F8F9FA"/>
  <path d="M995 0H1500V500H1034C1115 364 1099 155 995 0Z" fill="#F0F3F5"/>
  <path d="M1500 419H1128C1102 419 1082 399 1082 373V331" fill="none" stroke="#D8E0E5" stroke-width="2"/>
  <path d="M1370 0V73C1370 101 1348 123 1320 123H1265" fill="none" stroke="#D8E0E5" stroke-width="2"/>
  <path d="M1500 248H1356" fill="none" stroke="#D8E0E5" stroke-width="2"/>
  <circle cx="1210" cy="248" r="188" fill="none" stroke="#DCE3E8" stroke-width="1.5"/>
  <circle cx="1210" cy="248" r="149" fill="none" stroke="#DCE3E8" stroke-width="1.5" stroke-dasharray="2 10"/>
  <path d="M1054 143A188 188 0 0 1 1144 72" fill="none" stroke="#F0B90B" stroke-width="3" stroke-linecap="round"/>
  <circle cx="1210" cy="248" r="115" fill="#081D35"/>
  <image x="1048" y="86" width="324" height="324" href="${logoData}"/>
  <g fill="#F8F9FA" stroke="#DCE3E8" stroke-width="1.5">
    <circle cx="1370" cy="149" r="22"/>
    <circle cx="1090" cy="393" r="18"/>
  </g>
  <g fill="none" stroke="#0784C3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1362 149H1378M1370 141V157"/>
    <path d="M1084 393H1096M1090 387V399"/>
  </g>
  <circle cx="1233" cy="62" r="6" fill="#F0B90B"/>
  <circle cx="1397" cy="248" r="7" fill="#081D35"/>
  <circle cx="1284" cy="421" r="6" fill="#0784C3"/>
  <circle cx="1024" cy="219" r="5" fill="#F0B90B"/>
  <text x="147" y="180" font-size="86" letter-spacing="-3" fill="#DBA509">BNB</text>
  <text x="141" y="286" font-size="96" letter-spacing="-4.5" fill="#081D35">AGENT CHAIN</text>
  <path d="M147 332H231" stroke="#F0B90B" stroke-width="7"/>
  <path d="M250 332H884" stroke="#DCE3E8" stroke-width="1.5"/>
  <circle cx="884" cy="332" r="4" fill="#F0B90B"/>
  <g fill="#C2CDD5"><circle cx="899" cy="103" r="2"/><circle cx="911" cy="103" r="2"/><circle cx="923" cy="103" r="2"/><circle cx="899" cy="115" r="2"/><circle cx="911" cy="115" r="2"/><circle cx="923" cy="115" r="2"/></g>
</g>
</svg>`;
await writeFile(resolve(here, 'banner.svg'), bannerSvg);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;width:1500px;height:500px;overflow:hidden">${bannerSvg}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(assets, 'banner-1500x500.png'), type: 'png' });
  const banner = await readFile(resolve(assets, 'banner-1500x500.png'));
  const bannerData = `data:image/png;base64,${banner.toString('base64')}`;
  await page.setViewportSize({ width: 1120, height: 720 });
  await page.setContent(`<!doctype html><html><style>*{box-sizing:border-box}body{margin:0;padding:32px 40px;background:#e9edf1;font-family:Arial,sans-serif;color:#081d35}.card{background:#fff;border:1px solid #dce3e8;border-radius:16px;overflow:hidden}.cover{width:100%;display:block}.profile{height:170px;padding:78px 32px 20px;position:relative}.avatar{position:absolute;left:30px;top:-69px;width:132px;height:132px;border:5px solid white;border-radius:50%;background:#081d35}.name{font-weight:700;font-size:24px}.handle{font-size:15px;color:#6b7d8e;margin-top:6px}.label{font-size:12px;color:#617587;letter-spacing:1px;margin:24px 0 12px}.small{width:600px;display:block;border:1px solid #dce3e8;border-radius:8px}</style><div class="card"><img class="cover" src="${bannerData}"><div class="profile"><img class="avatar" src="${logoData}"><div class="name">BNB AGENT CHAIN</div><div class="handle">Profile crop preview</div></div></div><div class="label">COMPACT DISPLAY · 600 × 200</div><img class="small" src="${bannerData}"></html>`);
  await page.screenshot({ path: resolve(here, 'banner-preview.png'), fullPage: true });
  console.log(JSON.stringify({ width: banner.readUInt32BE(16), height: banner.readUInt32BE(20), logoSha256: logoHash, logoUnchanged: logoHash === createHash('sha256').update(await readFile(resolve(assets, 'logo-512.png'))).digest('hex'), output: resolve(assets, 'banner-1500x500.png') }, null, 2));
} finally { await browser.close(); }
