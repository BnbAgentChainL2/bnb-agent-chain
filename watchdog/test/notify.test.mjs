// 告警外发：两种 body 形状、重试、以及「打不通也不许影响刹车」。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setSink } from '../src/log.mjs';
import { notify, sanitize, toText } from '../src/notify.mjs';

setSink(() => {});

const alert = {
  rule: 'anchor_root',
  subject: '1000',
  severity: 'critical',
  summary: '纪元 1000 的 exitRoot 与复算结果不一致',
  compared: { exitRoot: { mine: '0xaa', onchain: '0xbb' } },
  action: 'paused',
  txHash: '0xdeadbeef',
  at: 1700000000,
};

describe('notify', () => {
  it('没配 URL：不报错，只回一个 no_url', async () => {
    const r = await notify({ url: null }, alert, async () => {
      throw new Error('不该被调用');
    });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no_url');
  });

  it('json 形状：原样 POST 结构化告警', async () => {
    let body = null;
    const r = await notify({ url: 'http://hook', format: 'json', timeoutMs: 50, retries: 0 }, alert, async (_u, o) => {
      body = JSON.parse(o.body);
      return { ok: true, status: 200 };
    });
    assert.equal(r.sent, true);
    assert.equal(body.source, 'bac-watchdog');
    assert.equal(body.rule, 'anchor_root');
    assert.equal(body.txHash, '0xdeadbeef');
    assert.equal(body.compared.exitRoot.onchain, '0xbb');
  });

  it('text 形状：POST {"text": "..."}，IM 都吃这个', async () => {
    let body = null;
    await notify({ url: 'http://hook', format: 'text', timeoutMs: 50, retries: 0 }, alert, async (_u, o) => {
      body = JSON.parse(o.body);
      return { ok: true, status: 200 };
    });
    assert.ok(typeof body.text === 'string');
    assert.ok(body.text.includes('【已暂停】'));
    assert.ok(body.text.includes('anchor_root'));
  });

  it('对面 500：按 retries 重试，最后不抛异常', async () => {
    let calls = 0;
    const r = await notify({ url: 'http://hook', format: 'json', timeoutMs: 50, retries: 2 }, alert, async () => {
      calls++;
      return { ok: false, status: 500 };
    });
    assert.equal(calls, 3);
    assert.equal(r.sent, false);
  });

  it('对面直接抛异常：也不许把调用方带走', async () => {
    const r = await notify({ url: 'http://hook', format: 'json', timeoutMs: 50, retries: 0 }, alert, async () => {
      throw new Error('ECONNREFUSED');
    });
    assert.equal(r.sent, false);
    assert.ok(String(r.reason).includes('ECONNREFUSED'));
  });

  it('payload 里不出现私钥或整份配置', () => {
    const s = JSON.stringify(sanitize(alert));
    assert.ok(!s.includes('PRIVATE'));
    assert.ok(!s.includes('rpc'));
  });

  it('一行人话能看出发生了什么、动了什么手', () => {
    const t = toText(alert);
    assert.ok(t.includes('1000'));
    assert.ok(t.includes('0xdeadbeef'));
  });
});
