#!/usr/bin/env node
// Launch-day gate + announcement generator.
//
//   node tools/launch-announce.mjs
//   node tools/launch-announce.mjs --token 0x...        # override the expected address
//
// It refuses to print anything postable until every hard stop passes. The token address in the
// output is READ FROM THE CHAIN, never typed, so a launch-day announcement cannot carry a
// mistyped or substituted address. Read-only: it sends no transaction and needs no key.

const BSC = process.env.BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org';

const EXPECTED = {
  token:    (process.argv[process.argv.indexOf('--token') + 1] || '').startsWith('0x')
              ? process.argv[process.argv.indexOf('--token') + 1]
              : '0xA97452d175679B2bF5F25a9a382D22aff39b7777',
  router:   '0x63D213C8AAa4E1C758ea41f8ed35066181B8e818',
  bridge:   '0x2129f336ff42821afa27fE5928Dec36Ba90d3508',
  nodeFund: '0xBf92C03f2eD3b7aDFC4908019DF51a0401fC23Ff',
  anchor:   '0xe6cCCD4809905152588f31417408c4Af9043b406',
  staking:  '0xC0cdF18fb2aF4C5Ca34603B6D7C4E29005042943',
  registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
};

const LINKS = {
  site:   'https://bnbagentchain-scan.com',
  rpc:    'https://bnbagentchain-rpc.xyz/rpc',
  node:   'https://bnbagentchain-rpc.xyz/node.json',
  repo:   'https://github.com/BnbAgentChainL2/bnb-agent-chain',
  x:      'https://x.com/Bnbagentchain',
};

let id = 0;
async function rpc(method, params) {
  const r = await fetch(BSC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const code = (a) => rpc('eth_getCode', [a, 'latest']);

// minimal abi decoding — enough for address / uint / string returns
const addr = (h) => h && h.length >= 66 ? '0x' + h.slice(26, 66) : null;
const uint = (h) => h && h !== '0x' ? BigInt(h) : null;
function str(h) {
  if (!h || h.length < 130) return null;
  const len = Number(BigInt('0x' + h.slice(66, 130)));
  return Buffer.from(h.slice(130, 130 + len * 2), 'hex').toString('utf8');
}
const SEL = {
  name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd',
  bacToken: '0xc586f517', identityRegistry: '0x134e18f4', owner: '0x8da5cb5b',
  ownerNotice: '0x29ab9c55', identityNotice: '0x7c145ffa',
};

const checks = [];
const add = (ok, label, detail) => checks.push({ ok, label, detail });

(async () => {
  console.log(`\nBSC RPC: ${BSC}`);
  console.log(`Expected token: ${EXPECTED.token}\n`);

  // ---- hard stop 1: the token exists at all -------------------------------------------------
  const tokenCode = await code(EXPECTED.token);
  const launched = tokenCode && tokenCode !== '0x';
  add(launched, 'Token contract has code',
      launched ? `${(tokenCode.length - 2) / 2} bytes` : 'NO CODE — the token has not launched');

  // ---- hard stop 2: every infrastructure contract still has code ----------------------------
  for (const [k, a] of Object.entries(EXPECTED)) {
    if (k === 'token') continue;
    const c = await code(a);
    add(c && c !== '0x', `${k} has code`, a);
  }

  // ---- hard stop 3: the bridge points at the token we are about to announce -----------------
  try {
    const wired = addr(await call(EXPECTED.bridge, SEL.bacToken));
    add(wired && wired.toLowerCase() === EXPECTED.token.toLowerCase(),
        'bridge.bacToken() == the announced token', wired || 'read failed');
  } catch (e) { add(false, 'bridge.bacToken()', e.message); }

  try {
    const reg = addr(await call(EXPECTED.bridge, SEL.identityRegistry));
    add(reg && reg.toLowerCase() === EXPECTED.registry.toLowerCase(),
        'bridge.identityRegistry() == the ERC-8004 registry', reg || 'read failed');
  } catch (e) { add(false, 'bridge.identityRegistry()', e.message); }

  // ---- hard stop 4: the on-chain disclosures are readable ------------------------------------
  for (const [sel, label] of [[SEL.ownerNotice, 'OWNER_POWER_NOTICE'], [SEL.identityNotice, 'IDENTITY_LIMIT_NOTICE']]) {
    try {
      const t = str(await call(EXPECTED.bridge, sel));
      add(!!t && t.length > 10, `${label} readable on chain`, t ? t.slice(0, 40) + '…' : 'empty');
    } catch (e) { add(false, `${label} readable on chain`, e.message); }
  }

  // ---- token metadata, only if it launched ---------------------------------------------------
  let sym = null, nm = null;
  if (launched) {
    try { nm  = str(await call(EXPECTED.token, SEL.name)); } catch {}
    try { sym = str(await call(EXPECTED.token, SEL.symbol)); } catch {}
    add(sym === 'BAC', 'symbol() == BAC', sym ?? 'read failed');
    add(nm === 'BNB Agent Chain', 'name() == BNB Agent Chain', nm ?? 'read failed');
    try {
      const d = uint(await call(EXPECTED.token, SEL.decimals));
      add(d === 18n, 'decimals() == 18', String(d));
    } catch (e) { add(false, 'decimals()', e.message); }
  }

  // ---- report --------------------------------------------------------------------------------
  console.log('HARD STOPS');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(46)} ${c.detail ?? ''}`);

  const failed = checks.filter((c) => !c.ok);
  console.log('');

  if (!launched) {
    console.log('The token has not launched. Nothing to announce yet.');
    console.log('Re-run this immediately after the launch transaction confirms.\n');
    process.exit(2);
  }
  if (failed.length) {
    console.log(`${failed.length} hard stop(s) failed. DO NOT POST. Pause all promotion and fix first.\n`);
    process.exit(1);
  }

  // ---- only now, emit the postable text with the address read from the chain ------------------
  const CA = EXPECTED.token;
  console.log('='.repeat(78));
  console.log('ALL HARD STOPS PASSED — the text below carries the address as read from chain.');
  console.log('='.repeat(78));

  console.log(`
--- LAUNCH POST (EN) ---------------------------------------------------------

BAC is live.

CA ${CA}

A chain for agents. Entry needs an ERC-8004 identity, and in-layer credits can only be created that way, so every unit of gas traces back to one. No official DEX and no official market: agents build their own.

Explorer   ${LINKS.site}
RPC        ${LINKS.rpc}
Run a node ${LINKS.node}
Code       ${LINKS.repo}

Check the address character by character against this post and the site. They are the only two places we publish it.

--- FIRST REPLY, POST IT IMMEDIATELY (EN) ------------------------------------

Risk: the project can upgrade the bridge contract, change its rules, and withdraw all of the bridge pool at any time. Exiting pays a pro-rata share of bought-back BAC — no amount is promised and it can be far below what you put in. The token can go to zero. Not affiliated with Binance, BNB Chain or Flap. DYOR · NFA

--- LAUNCH POST (ZH) ---------------------------------------------------------

BAC 已上线。

CA ${CA}

一条给 agent 的链。进场要凭 ERC-8004 身份，层内积分只能由此产生，所以链上每一份 gas 都能追到一个 agent 身份。没有官方 DEX，没有官方市场，市场由 agent 自己建。

浏览器   ${LINKS.site}
RPC      ${LINKS.rpc}
跑节点   ${LINKS.node}
代码     ${LINKS.repo}

地址请对着这条帖子和官网逐字核对。我们只在这两个地方公布它。

--- 第一条回复，立刻发（ZH） --------------------------------------------------

风险说明：项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。退出按份额兑付回购来的 BAC，不承诺任何金额，可能远低于投入价值。代币价格可能归零。本项目与 Binance、BNB Chain、Flap 官方无关。DYOR · 任何投资都有风险 · NFA

--- OFFICIAL LINKS BLOCK (paste anywhere) ------------------------------------

Token  ${CA}
Site   ${LINKS.site}
RPC    ${LINKS.rpc}
Node   ${LINKS.node}
Code   ${LINKS.repo}
X      ${LINKS.x}

Bridge ${EXPECTED.bridge}
Router ${EXPECTED.router}
Anchor ${EXPECTED.anchor}
Stake  ${EXPECTED.staking}
Fund   ${EXPECTED.nodeFund}
`);
})().catch((e) => { console.error('\nFATAL:', e.message, '\n'); process.exit(1); });
