// 配置：几条「宁可起不来也不要带病跑」的硬失败。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig, redactedConfig } from '../src/config.mjs';
import { _internal, log, registerSecret, setSink } from '../src/log.mjs';

const KEY = '0x' + '11'.repeat(32);

function env(over = {}) {
  return {
    WATCHDOG_PRIVATE_KEY: KEY,
    WATCHDOG_ARMED: 'true',
    BSC_RPC: 'http://a',
    BSC_RPC_2: 'http://b',
    LAYER_RPC: 'http://layer',
    WATCHDOG_DB: '/var/bac/watchdog.db',
    BAC_BRIDGE: '0x00000000000000000000000000000000000b1d6e',
    CHAIN_ANCHOR: '0x00000000000000000000000000000000000a9c40',
    BAC_TOKEN: '0x0000000000000000000000000000000000bac70a',
    LAYER_SIGNER_ADDRESS: '0x0000000000000000000000000000000000515e12',
    ...over,
  };
}

describe('loadConfig', () => {
  it('最小可用配置能读出来', () => {
    const cfg = loadConfig(env());
    assert.equal(cfg.armed, true);
    assert.equal(cfg.poll.fastMs, 5000);
    assert.equal(cfg.validators.length, 1);
  });

  it('WATCHDOG_ARMED 没写 → 拒绝启动（默认值无论取哪个都是错的）', () => {
    assert.throws(() => loadConfig(env({ WATCHDOG_ARMED: undefined })), /WATCHDOG_ARMED/);
  });

  it('两个 BSC 端点相同 → 拒绝启动（那样「复核」只是把同一个错误读两遍）', () => {
    assert.throws(() => loadConfig(env({ BSC_RPC_2: 'http://a' })), /独立/);
  });

  it('轮询间隔超过 10 秒 → 拒绝启动（探测延迟预算要求 ≤ 10 秒）', () => {
    assert.throws(() => loadConfig(env({ WATCHDOG_POLL_MS: '20000' })), /10000|轮询/);
  });

  it('缺私钥 → 拒绝启动', () => {
    assert.throws(() => loadConfig(env({ WATCHDOG_PRIVATE_KEY: '' })), /WATCHDOG_PRIVATE_KEY/);
  });

  it('webhook 形状只认 json / text', () => {
    assert.throws(() => loadConfig(env({ WATCHDOG_WEBHOOK_FORMAT: 'xml' })), /json 或 text/);
  });

  it('redactedConfig 里没有私钥', () => {
    const r = redactedConfig(loadConfig(env()));
    assert.equal(r.keys.watchdog, '[REDACTED]');
    assert.ok(!JSON.stringify(r).includes('1111'));
  });
});

describe('日志擦除', () => {
  it('注册过的私钥在任何一行日志里都只会是 [REDACTED]', () => {
    const lines = [];
    const prev = setSink((_l, line) => lines.push(line));
    registerSecret(KEY);
    log.info('不小心把钥匙塞进了字段', { oops: KEY, nested: { deeper: KEY } });
    setSink(prev);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes('1111'), '日志里不许出现私钥的任何一段');
    assert.ok(lines[0].includes('[REDACTED]'));
  });

  it('不带 0x 前缀的写法也要被擦掉', () => {
    const bare = '22'.repeat(32);
    registerSecret('0x' + bare);
    assert.ok(!_internal.scrub(`key=${bare}`).includes(bare));
  });
});
