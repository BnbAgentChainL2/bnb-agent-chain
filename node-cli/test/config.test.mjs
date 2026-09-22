// 配置校验的测试。校验的每一条都对应一个「跑错了会很贵」的场景。

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, defaultConfig, layout, writeConfig, readConfig, CONFIG_SCHEMA } from '../src/config.mjs';
import { renderCompose } from '../src/compose-template.mjs';
import { memFs, testConfig } from './helpers.mjs';
import { BESU_IMAGE, L2_BRIDGE } from '../src/constants.mjs';

const has = (list, re) => list.some((s) => re.test(s));

test('一份填好的配置能过', () => {
  const v = validateConfig(testConfig());
  assert.equal(v.ok, true, v.errors.join('；'));
});

test('schema 不对 → 不过', () => {
  const v = validateConfig(testConfig({ schema: 'bac/whatever/9' }));
  assert.equal(v.ok, false);
  assert.ok(has(v.errors, /schema/));
});

test('chainId 不是 56777 → 不过', () => {
  const v = validateConfig(testConfig({ chainId: 56778 }));
  assert.equal(v.ok, false);
  assert.ok(has(v.errors, /chainId/));
});

test('镜像用 latest → 不过（共识客户端不许被上游悄悄换掉）', () => {
  const v = validateConfig(testConfig({ besuImage: 'hyperledger/besu:latest' }));
  assert.equal(v.ok, false);
  assert.ok(has(v.errors, /latest/));
});

test('镜像钉死了但不是实测那个版本 → 过，但提醒', () => {
  const v = validateConfig(testConfig({ besuImage: 'hyperledger/besu:25.1.0' }));
  assert.equal(v.ok, true);
  assert.ok(has(v.warnings, /实测/));
});

test('uid/gid 是 0 → 不过（root 属主的 data 目录是真实踩过的坑）', () => {
  const v = validateConfig(testConfig({ uid: 0 }));
  assert.equal(v.ok, false);
  assert.ok(has(v.errors, /uid/));
});

test('地址不是合法地址 → 不过；不是 EIP-55 → 只提醒', () => {
  const bad = testConfig();
  bad.addresses = { ...bad.addresses, staking: '0x123' };
  assert.equal(validateConfig(bad).ok, false);

  const lower = testConfig();
  lower.addresses = { ...lower.addresses, staking: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' };
  const v = validateConfig(lower);
  assert.equal(v.ok, true);
  assert.ok(has(v.warnings, /EIP-55/));
});

test('l2Bridge 被改成别的地址 → 不过（它是创世固定地址）', () => {
  const cfg = testConfig();
  cfg.addresses = { ...cfg.addresses, l2Bridge: '0x0000000000000000000000000000000000000999' };
  const v = validateConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(has(v.errors, new RegExp(L2_BRIDGE)));
});

test('start 前没有 genesisHash → 不过；平时只是提醒', () => {
  const cfg = testConfig({ genesisHash: '' });
  assert.equal(validateConfig(cfg).ok, true);
  const v = validateConfig(cfg, { forStart: true });
  assert.equal(v.ok, false);
  assert.ok(has(v.errors, /genesisHash/));
});

test('start 前 bootnodes 为空 → 不过', () => {
  const v = validateConfig(testConfig({ bootnodes: [] }), { forStart: true });
  assert.equal(v.ok, false);
  assert.ok(has(v.errors, /bootnodes/));
});

test('bootnode 格式不对 → 不过', () => {
  const v = validateConfig(testConfig({ bootnodes: ['enode://xyz@1.2.3.4:30303'] }));
  assert.equal(v.ok, false);
});

test('地址没填只是提醒，不拦（发射前本来就没有）', () => {
  const cfg = defaultConfig({ nodeId: 'n1', genesisHash: '0x' + 'ab'.repeat(32), payout: '0x00000000000000000000000000000000000000A1' });
  const v = validateConfig(cfg);
  assert.equal(v.ok, true);
  assert.ok(has(v.warnings, /staking/));
});

test('读写配置：落盘不带 home，读回来带上调用者给的 home', () => {
  const fs = memFs();
  const cfg = testConfig({ home: '/somewhere' });
  writeConfig('/work', cfg, { fsImpl: fs });
  const raw = JSON.parse(fs.readFileSync('/work/bac-node.json'));
  assert.equal(raw.home, undefined);
  assert.equal(raw.schema, CONFIG_SCHEMA);
  const back = readConfig('/work', { fsImpl: fs });
  assert.equal(back.home, '/work');
  assert.equal(back.nodeId, 'my-node-01');
});

test('配置文件不是 JSON → 报明白话', () => {
  const fs = memFs({ '/work/bac-node.json': '{ 坏掉的' });
  assert.throws(() => readConfig('/work', { fsImpl: fs }), /不是合法 JSON/);
});

test('目录布局把密钥和数据分开放', () => {
  const l = layout('/home/me/bac');
  assert.match(l.nodeKey.replace(/\\/g, '/'), /secrets\/key$/);
  assert.match(l.genesis.replace(/\\/g, '/'), /config\/genesis\.json$/);
  assert.match(l.besuData.replace(/\\/g, '/'), /data\/besu$/);
});

test('生成的 compose 带上 uid:gid、钉死的镜像、只绑本机的 RPC', () => {
  const y = renderCompose(testConfig({ uid: 1001, gid: 1001, p2pHost: '1.2.3.4' }));
  assert.match(y, /user: "1001:1001"/);
  assert.ok(y.includes(BESU_IMAGE));
  // 每一个 image: 的值都必须带版本号，不许是 latest（注释里出现 latest 不算）
  for (const line of y.split('\n')) {
    const m = /^\s*image:\s*(\S+)/.exec(line);
    if (m) assert.ok(!/:latest$/.test(m[1]), `镜像没钉死：${m[1]}`);
  }
  assert.match(y, /127\.0\.0\.1:8545:8545/);
  assert.match(y, /--p2p-host=1\.2\.3\.4/);
  assert.match(y, /stop_grace_period: 2m/);
  assert.match(y, /--bonsai-limit-trie-logs-enabled=true/);
  assert.match(y, /env_file: \[ \.\/validator\.env \]/);
  // 私钥绝不能出现在 compose 里
  assert.ok(!/VALIDATOR_PRIVATE_KEY=0x/.test(y));
});

test('没给 p2pHost 时 compose 里就不写 --p2p-host（让 Besu 自己判断）', () => {
  const y = renderCompose(testConfig({ p2pHost: '' }));
  assert.ok(!y.includes('--p2p-host'));
});
