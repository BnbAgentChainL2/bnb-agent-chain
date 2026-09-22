// 创世门禁与 start 的集成测试：对错链是最贵的一种错，所以这里的每一条都是硬门槛。

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGenesisFile, checkGenesisChain, sha256Hex } from '../src/genesis-gate.mjs';
import { start } from '../src/commands/node.mjs';
import { writeConfig } from '../src/config.mjs';
import { FakeDocker, FakeRpc, memFs, memLogger, testConfig } from './helpers.mjs';

const GEN_TEXT = '{"config":{"chainId":56777}}';
const GEN_SHA = sha256Hex(GEN_TEXT);
const GEN_HASH = '0x' + 'ab'.repeat(32);

function setup(over = {}) {
  const fs = memFs();
  const cfg = testConfig({ genesisHash: GEN_HASH, genesisSha256: GEN_SHA, ...over });
  writeConfig('/w', cfg, { fsImpl: fs });
  fs.writeFileSync('/w/config/genesis.json', GEN_TEXT);
  return { fs, cfg };
}

function chainRpc(genesisHash) {
  return new FakeRpc({
    blocks: [
      { number: '0x0', hash: genesisHash, timestamp: '0x1' },
      { number: '0x1', hash: '0x' + '11'.repeat(32), timestamp: '0x4' },
    ],
  });
}

test('文件核对：sha256 一致才放行', () => {
  assert.equal(checkGenesisFile({ recordedSha256: GEN_SHA, actualText: GEN_TEXT }).ok, true);
});

test('genesis.json 被改过 → 拒绝，并告诉你去哪核对', () => {
  const r = checkGenesisFile({ recordedSha256: GEN_SHA, actualText: GEN_TEXT + ' ' });
  assert.equal(r.ok, false);
  assert.match(r.zh, /api\/genesis/);
});

test('没有 genesis.json → 拒绝', () => {
  assert.equal(checkGenesisFile({ recordedSha256: GEN_SHA, actualText: null }).ok, false);
});

test('配置里没记 sha256 → 拒绝', () => {
  assert.equal(checkGenesisFile({ recordedSha256: '', actualText: GEN_TEXT }).ok, false);
});

test('链上核对：哈希一致才放行；不一致必须拒绝', () => {
  assert.equal(checkGenesisChain({ expected: GEN_HASH, actual: GEN_HASH }).ok, true);
  assert.equal(checkGenesisChain({ expected: GEN_HASH, actual: GEN_HASH.toUpperCase().replace('0X', '0x') }).ok, true);
  const bad = checkGenesisChain({ expected: GEN_HASH, actual: '0x' + 'cd'.repeat(32) });
  assert.equal(bad.ok, false);
  assert.match(bad.zh, /不是这条链/);
});

test('读不到 0 号区块 → 拒绝继续（不当成通过）', () => {
  assert.equal(checkGenesisChain({ expected: GEN_HASH, actual: null }).ok, false);
});

test('start：一切正常时拉起容器并核对两次创世', async () => {
  const { fs } = setup();
  const docker = new FakeDocker();
  const log = memLogger();
  const r = await start({ home: '/w', waitTries: 1, waitMs: 0 },
    { fs, docker, log, rpc: chainRpc(GEN_HASH), sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual(docker.calls.map((c) => c[0]), ['available', 'up']);
  assert.match(log.text(), /sha256/);
});

test('start：链上创世不一致 → 把容器停回去并抛错（没有跳过开关）', async () => {
  const { fs } = setup();
  const docker = new FakeDocker();
  const log = memLogger();
  await assert.rejects(
    () => start({ home: '/w', waitTries: 1, waitMs: 0 },
      { fs, docker, log, rpc: chainRpc('0x' + 'cd'.repeat(32)), sleep: async () => {} }),
    /创世哈希核对失败/);
  assert.ok(docker.calls.some((c) => c[0] === 'stop'), '不一致时必须把容器停回去');
  assert.match(log.text(), /不是这条链/);
});

test('start：本地 genesis.json 被换过 → 连容器都不拉起来', async () => {
  const { fs } = setup();
  fs.writeFileSync('/w/config/genesis.json', '{"config":{"chainId":97}}');
  const docker = new FakeDocker();
  await assert.rejects(
    () => start({ home: '/w' }, { fs, docker, log: memLogger(), rpc: chainRpc(GEN_HASH), sleep: async () => {} }),
    /创世文件核对失败/);
  assert.equal(docker.calls.length, 0, '文件都不对就不该碰 docker');
});

test('start：配置没过校验（比如没记创世哈希）→ 拒绝启动', async () => {
  const { fs } = setup({ genesisHash: '' });
  const docker = new FakeDocker();
  await assert.rejects(
    () => start({ home: '/w' }, { fs, docker, log: memLogger(), rpc: chainRpc(GEN_HASH) }),
    /配置没过校验/);
  assert.equal(docker.calls.length, 0);
});

test('start：docker 不可用 → 明说，不去猜', async () => {
  const { fs } = setup();
  const docker = new FakeDocker({ available: false });
  await assert.rejects(
    () => start({ home: '/w' }, { fs, docker, log: memLogger(), rpc: chainRpc(GEN_HASH) }),
    /docker compose 不可用/);
});
