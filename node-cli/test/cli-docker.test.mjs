// CLI 参数解析、docker compose 命令拼装、init 的产物。都不需要真 docker、真网络。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, main, USAGE } from '../src/cli.mjs';
import { Docker } from '../src/docker.mjs';
import { run as initRun, enodeIdFrom, enodeUri } from '../src/commands/init.mjs';
import { readConfig } from '../src/config.mjs';
import { sha256Hex } from '../src/genesis-gate.mjs';
import { memFs, memLogger } from './helpers.mjs';
import { Wallet } from 'ethers';

test('parseArgs：布尔开关、带值选项、中划线转驼峰', () => {
  const a = parseArgs(['attest', '--once', '--home', '/w', '--node-id', 'n1', '--dry-run']);
  assert.deepEqual(a._, ['attest']);
  assert.equal(a.once, true);
  assert.equal(a.home, '/w');
  assert.equal(a.nodeId, 'n1');
  assert.equal(a.dryRun, true);
});

test('parseArgs：后面跟着另一个选项时当布尔处理，不会吞掉它', () => {
  const a = parseArgs(['claim', '--json', '--epoch', '20716']);
  assert.equal(a.json, true);
  assert.equal(a.epoch, '20716');
});

test('用法里列出了任务要求的每一个命令', () => {
  for (const c of ['init', 'start', 'stop', 'status', 'attest', 'claim', 'doctor', 'verify',
                   'stake', 'register', 'unstake', 'withdraw']) {
    assert.ok(USAGE.includes(c), `用法里缺 ${c}`);
  }
});

test('无参数 / --help → 打印用法，退出码 0', async () => {
  const log = memLogger();
  assert.equal(await main([], { log }), 0);
  assert.match(log.text(), /bac-node/);
  assert.equal(await main(['--help'], { log }), 0);
});

test('不认识的命令 → 退出码 2，并打印用法', async () => {
  const log = memLogger();
  assert.equal(await main(['fly'], { log }), 2);
  assert.match(log.text(), /不认识的命令/);
});

test('命令抛错 → 退出码 1，且错误信息里的 32 字节十六进制被遮掉', async () => {
  const log = memLogger();
  const code = await main(['status', '--home', '/no-such-dir-here'], { log });
  assert.equal(code, 1);
  assert.ok(!/0x[0-9a-fA-F]{64}/.test(log.text()), '错误输出里不许出现疑似私钥');
});

test('Docker：compose 命令拼装正确，cwd 指向工作目录', async () => {
  const calls = [];
  const exec = async (cmd, args, opts) => { calls.push([cmd, args, opts.cwd]); return { code: 0, stdout: '', stderr: '' }; };
  const d = new Docker({ exec, cwd: '/w' });
  await d.up();
  await d.stop(['besu']);
  assert.deepEqual(calls[0], ['docker', ['compose', 'up', '-d'], '/w']);
  assert.deepEqual(calls[1], ['docker', ['compose', 'stop', 'besu'], '/w']);
});

test('Docker：up 失败要抛，不能假装成功', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'no such image' });
  const d = new Docker({ exec, cwd: '/w' });
  await assert.rejects(() => d.up(), /docker compose up 失败/);
});

test('Docker：ps 的 json 输出（每行一个对象）能解析', async () => {
  const exec = async () => ({
    code: 0, stderr: '',
    stdout: '{"Service":"besu","State":"running"}\n{"Service":"attester","State":"running"}\n',
  });
  const d = new Docker({ exec, cwd: '/w' });
  const rows = await d.ps();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Service, 'besu');
});

test('Docker：老版本 compose 吐非 json → 返回空数组而不是崩', async () => {
  const exec = async () => ({ code: 0, stdout: 'NAME  STATUS\nbesu  Up 2 hours\n', stderr: '' });
  assert.deepEqual(await new Docker({ exec, cwd: '/w' }).ps(), []);
});

test('enode id 是未压缩公钥去掉 04 前缀的 128 个十六进制字符', () => {
  const w = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const id = enodeIdFrom(w.privateKey);
  assert.equal(id.length, 128);
  assert.match(id, /^[0-9a-f]+$/);
  assert.equal(enodeUri(w.privateKey, '1.2.3.4', 30303), `enode://${id}@1.2.3.4:30303`);
});

test('init：写出配置、compose、genesis、密钥，并打印 enode 而不是私钥', async () => {
  const fs = memFs();
  const log = memLogger();
  const GEN = '{"config":{"chainId":56777}}';
  const HASH = '0x' + 'ab'.repeat(32);
  const enode = 'enode://' + 'a'.repeat(128) + '@95.179.183.132:30303';
  const api = {
    health: async () => ({ layer: { genesisHash: HASH, enode } }),
    genesis: async () => ({ text: GEN, headerHash: HASH }),
  };
  const key = Wallet.createRandom().privateKey;

  const r = await initRun(
    { home: '/w', nodeId: 'my-node-01', p2pHost: '1.2.3.4', uid: 1000, gid: 1000,
      payout: '0x00000000000000000000000000000000000000A1' },
    { fs, log, api, makeKey: () => key });

  assert.equal(r.ok, true);
  const cfg = readConfig('/w', { fsImpl: fs });
  assert.equal(cfg.genesisHash, HASH);
  assert.equal(cfg.genesisSha256, sha256Hex(GEN));
  assert.deepEqual(cfg.bootnodes, [enode]);
  assert.equal(cfg.nodeId, 'my-node-01');
  assert.ok(fs.existsSync('/w/compose.yml'));
  assert.ok(fs.existsSync('/w/config/genesis.json'));
  assert.ok(fs.existsSync('/w/secrets/key'));
  assert.ok(fs.existsSync('/w/validator.env'));
  assert.equal(fs.readFileSync('/w/validator.env').includes('VALIDATOR_PRIVATE_KEY='), true);
  // 关键：输出里有 enode，没有私钥
  assert.match(log.text(), /enode:\/\/[0-9a-f]{128}@1\.2\.3\.4:30303/);
  assert.ok(!log.text().includes(key), '私钥绝不能被打印');
  assert.ok(!log.text().includes(key.slice(2)), '私钥绝不能被打印');
});

test('init：官方两处创世哈希对不上 → 停下来问，不写配置', async () => {
  const fs = memFs();
  const api = {
    health: async () => ({ layer: { genesisHash: '0x' + 'ab'.repeat(32), enode: 'enode://' + 'a'.repeat(128) + '@1.2.3.4:30303' } }),
    genesis: async () => ({ text: '{}', headerHash: '0x' + 'cd'.repeat(32) }),
  };
  await assert.rejects(
    () => initRun({ home: '/w', uid: 1000, gid: 1000 }, { fs, log: memLogger(), api }),
    /两处都对不上|不一致/);
});

test('init：用 root 跑 → 直接拒绝', async () => {
  const fs = memFs();
  await assert.rejects(
    () => initRun({ home: '/w', uid: 0, gid: 0 }, { fs, log: memLogger(), api: { health: async () => ({}), genesis: async () => ({ text: '{}', headerHash: null }) } }),
    /root/);
});
