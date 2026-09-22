// doctor 的检查项测试：每一条都用伪造的坏环境喂进去，确认它真的报出来。

import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, summarize } from '../src/doctor.mjs';
import { testConfig } from './helpers.mjs';
import { CLOCK_SKEW_FAIL_SEC, DISK_FREE_FAIL_BYTES, MIN_STAKE } from '../src/constants.mjs';

const NOW = 1790000000;

function healthyCtx(over = {}) {
  const cfg = testConfig();
  return {
    cfg, now: NOW,
    configCheck: { errors: [], warnings: [] },
    docker: { ok: true, detail: 'Docker Compose version v2.29.0' },
    psList: [{ Service: 'besu', State: 'running' }],
    layer: {
      chainId: 56777, head: 1234567, headTs: NOW - 1,
      genesisHash: cfg.genesisHash, peers: 5, error: null,
    },
    bsc: { ok: true, error: null },
    bsc2: { ok: true, error: null },
    official: { head: 1234570, error: null },
    datadir: { exists: true, uid: 1000, mode: 0o40755 },
    nodeKey: { exists: true, mode: 0o100600 },
    disk: { freeBytes: 60 * 1024 ** 3, error: null },
    processUid: 1000,
    staking: { staked: MIN_STAKE, nodes: 1, registered: true, active: true, strikes: 0, error: null },
    ...over,
  };
}

const find = (rs, id) => rs.find((r) => r.id === id);

test('健康的环境：没有一项 fail', () => {
  const rs = runChecks(healthyCtx());
  const s = summarize(rs);
  assert.equal(s.fails, 0, rs.filter((r) => r.status === 'fail').map((r) => r.title + ':' + r.detail).join(' | '));
  assert.equal(find(rs, 'genesis').status, 'ok');
  assert.equal(find(rs, 'peers').status, 'ok');
});

test('时钟偏了 40 秒 → fail，并且提示开 NTP', () => {
  const rs = runChecks(healthyCtx({ layer: { ...healthyCtx().layer, headTs: NOW - (CLOCK_SKEW_FAIL_SEC + 10) } }));
  const c = find(rs, 'clock');
  assert.equal(c.status, 'fail');
  assert.match(c.fix, /NTP/);
});

test('时钟差 6 秒 → 只是提醒', () => {
  const rs = runChecks(healthyCtx({ layer: { ...healthyCtx().layer, headTs: NOW - 6 } }));
  assert.equal(find(rs, 'clock').status, 'warn');
});

test('peers = 0 → fail，并且指向 bootnodes 与 30303 的 udp', () => {
  const rs = runChecks(healthyCtx({ layer: { ...healthyCtx().layer, peers: 0 } }));
  const p = find(rs, 'peers');
  assert.equal(p.status, 'fail');
  assert.match(p.fix, /udp/);
});

test('创世哈希对不上 → fail，并告诉你去哪核对', () => {
  const ctx = healthyCtx();
  ctx.layer.genesisHash = '0x' + '11'.repeat(32);
  const rs = runChecks(ctx);
  const g = find(rs, 'genesis');
  assert.equal(g.status, 'fail');
  assert.match(g.detail, /不一致|!=/);
  assert.match(g.fix, /api\/genesis/);
});

test('配置里没有 genesisHash → fail', () => {
  const ctx = healthyCtx();
  ctx.cfg = { ...ctx.cfg, genesisHash: '' };
  assert.equal(find(runChecks(ctx), 'genesis').status, 'fail');
});

test('chainId 不是 56777 → fail', () => {
  const ctx = healthyCtx();
  ctx.layer.chainId = 97;
  assert.equal(find(runChecks(ctx), 'chain_id').status, 'fail');
});

test('data 目录是 root 的而我不是 root → fail（探针里踩过的那个坑）', () => {
  const ctx = healthyCtx({ datadir: { exists: true, uid: 0, mode: 0o40755 }, processUid: 1000 });
  const d = find(runChecks(ctx), 'datadir');
  assert.equal(d.status, 'fail');
  assert.match(d.fix, /chown/);
});

test('data 目录属主和当前用户不一致 → warn', () => {
  const ctx = healthyCtx({ datadir: { exists: true, uid: 1005, mode: 0o40755 }, processUid: 1000 });
  assert.equal(find(runChecks(ctx), 'datadir').status, 'warn');
});

test('磁盘快满 → fail，并提示 trie-log 修剪', () => {
  const ctx = healthyCtx({ disk: { freeBytes: DISK_FREE_FAIL_BYTES - 1, error: null } });
  const d = find(runChecks(ctx), 'disk');
  assert.equal(d.status, 'fail');
  assert.match(d.fix, /trie-log|x-trie-log/);
});

test('层内 RPC 不通 → fail，并且不再往下做依赖它的判断', () => {
  const ctx = healthyCtx({ layer: { chainId: null, head: null, headTs: null, genesisHash: null, peers: null, error: '连不上' } });
  const rs = runChecks(ctx);
  assert.equal(find(rs, 'rpc_layer').status, 'fail');
  assert.equal(find(rs, 'genesis'), undefined);
  assert.equal(find(rs, 'clock'), undefined);
});

test('BSC RPC 不通 → fail；第二个不通只是 warn', () => {
  const rs1 = runChecks(healthyCtx({ bsc: { ok: false, error: 'timeout' } }));
  assert.equal(find(rs1, 'rpc_bsc').status, 'fail');
  const rs2 = runChecks(healthyCtx({ bsc2: { ok: false, error: 'timeout' } }));
  assert.equal(find(rs2, 'rpc_bsc2').status, 'warn');
});

test('docker 不可用 → fail；容器没跑 → fail', () => {
  const rs1 = runChecks(healthyCtx({ docker: { ok: false, detail: 'command not found' } }));
  assert.equal(find(rs1, 'docker').status, 'fail');
  const rs2 = runChecks(healthyCtx({ psList: [] }));
  assert.equal(find(rs2, 'containers').status, 'fail');
  const rs3 = runChecks(healthyCtx({ psList: [{ Service: 'besu', State: 'exited' }] }));
  assert.equal(find(rs3, 'containers').status, 'fail');
});

test('落后官方 2000 个块 → fail；落后 300 个 → warn', () => {
  const ctx = healthyCtx();
  const rs1 = runChecks({ ...ctx, official: { head: ctx.layer.head + 2000, error: null } });
  assert.equal(find(rs1, 'sync').status, 'fail');
  const rs2 = runChecks({ ...ctx, official: { head: ctx.layer.head + 300, error: null } });
  assert.equal(find(rs2, 'sync').status, 'warn');
});

test('质押不足以覆盖节点数 → fail', () => {
  const ctx = healthyCtx({
    staking: { staked: MIN_STAKE, nodes: 2, registered: true, active: true, strikes: 0, error: null },
  });
  assert.equal(find(runChecks(ctx), 'staking').status, 'fail');
});

test('节点被停用 → fail，但明说本金不受影响', () => {
  const ctx = healthyCtx({
    staking: { staked: MIN_STAKE, nodes: 1, registered: true, active: false, strikes: 1, error: null },
  });
  const r = find(runChecks(ctx), 'node_reg');
  assert.equal(r.status, 'fail');
  assert.match(r.detail + r.fix, /本金/);
});

test('有 strike → warn，并指向多机同跑一把私钥', () => {
  const ctx = healthyCtx({
    staking: { staked: MIN_STAKE, nodes: 1, registered: true, active: true, strikes: 2, error: null },
  });
  const r = find(runChecks(ctx), 'node_reg');
  assert.equal(r.status, 'warn');
  assert.match(r.fix, /两台|多机|私钥/);
});

test('节点密钥不存在 → fail；权限太松 → warn', () => {
  const rs1 = runChecks(healthyCtx({ nodeKey: { exists: false, mode: null } }));
  assert.equal(find(rs1, 'node_key').status, 'fail');
  const rs2 = runChecks(healthyCtx({ nodeKey: { exists: true, mode: 0o100644 } }));
  assert.equal(find(rs2, 'node_key').status, 'warn');
});

test('配置有硬错误 → fail 排在最前面', () => {
  const rs = runChecks(healthyCtx({ configCheck: { errors: ['chainId 不对'], warnings: [] } }));
  assert.equal(rs[0].id, 'config');
  assert.equal(rs[0].status, 'fail');
  assert.equal(summarize(rs).ok, false);
});
