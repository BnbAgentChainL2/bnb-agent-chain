// attest 的端到端（本地）测试：假链 + 假 BSC + 内存文件系统。
// 重点验三件事：承诺哈希的编码、salt 落盘先于发交易、以及日志里**永远不出现 salt**。

import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, Wallet } from 'ethers';
import { commitmentHash, SaltStore } from '../src/salt-store.mjs';
import { run as attestRun, step } from '../src/commands/attest.mjs';
import { ifaceStaking, ifaceAnchor } from '../src/chain.mjs';
import { writeConfig } from '../src/config.mjs';
import { EPOCH, COMMIT_WINDOW } from '../src/constants.mjs';
import { FakeRpc, fakeChain, memFs, memLogger, testConfig } from './helpers.mjs';

const coder = AbiCoder.defaultAbiCoder();
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // 公开的 anvil 测试钥
const WALLET = new Wallet(KEY);
const EPOCH_N = 1;
const END = (EPOCH_N + 1) * EPOCH;

function fakeAnchor({ state = 0, postedAt = 0, exitRoot = '0x' + '00'.repeat(32), l2Block = 0,
                      l2BlockHash = '0x' + '00'.repeat(32) } = {}) {
  return ifaceAnchor.encodeFunctionResult('getAnchor', [[
    exitRoot, l2BlockHash, BigInt(l2Block), BigInt(postedAt), 0n,
    0n, 0n, 0n, 0n, 0, 0, state,
  ]]);
}

function setup({ anchorState = 0, postedAt = 0, anchorRoot, anchorL2Block, anchorHash } = {}) {
  const fs = memFs();
  const cfg = testConfig();
  writeConfig('/w', cfg, { fsImpl: fs });
  const layer = new FakeRpc({ blocks: fakeChain({ startTs: 2 * EPOCH - 30, period: 3, count: 100 }) });
  const bsc = new FakeRpc({
    calls: {
      [cfg.addresses.anchor.toLowerCase() + ':' + ifaceAnchor.getFunction('getAnchor').selector]:
        fakeAnchor({ state: anchorState, postedAt, exitRoot: anchorRoot, l2Block: anchorL2Block, l2BlockHash: anchorHash }),
    },
  });
  return { fs, cfg, layer, bsc, log: memLogger(), store: new SaltStore('/w/state', { fsImpl: fs, randomBytes: () => new Uint8Array(32).fill(7) }) };
}

test('承诺哈希 = keccak256(abi.encode(uint64,bytes32,bytes32,uint64,bytes32,address))', () => {
  const p = {
    epoch: 20718, exitRoot: '0x' + '11'.repeat(32), l2BlockHash: '0x' + '22'.repeat(32),
    l2Block: 1234501, salt: '0x' + '33'.repeat(32), validator: WALLET.address,
  };
  const manual = keccak256(coder.encode(
    ['uint64', 'bytes32', 'bytes32', 'uint64', 'bytes32', 'address'],
    [BigInt(p.epoch), p.exitRoot, p.l2BlockHash, BigInt(p.l2Block), p.salt, p.validator]));
  assert.equal(commitmentHash(p), manual);
});

test('承诺哈希对每一个输入都敏感（换了谁都不一样）', () => {
  const base = {
    epoch: 1, exitRoot: '0x' + '11'.repeat(32), l2BlockHash: '0x' + '22'.repeat(32),
    l2Block: 9, salt: '0x' + '33'.repeat(32), validator: WALLET.address,
  };
  const h = commitmentHash(base);
  assert.notEqual(h, commitmentHash({ ...base, epoch: 2 }));
  assert.notEqual(h, commitmentHash({ ...base, l2Block: 10 }));
  assert.notEqual(h, commitmentHash({ ...base, salt: '0x' + '44'.repeat(32) }));
  assert.notEqual(h, commitmentHash({ ...base, validator: Wallet.createRandom().address }));
});

test('salt 不是 32 字节 → 拒绝算承诺，不静默截断', () => {
  assert.throws(() => commitmentHash({
    epoch: 1, exitRoot: '0x' + '11'.repeat(32), l2BlockHash: '0x' + '22'.repeat(32),
    l2Block: 1, salt: '0x1234', validator: WALLET.address,
  }), /salt/);
});

test('SaltStore：写了能读回，列得出纪元号', () => {
  const fs = memFs();
  const s = new SaltStore('/w/state', { fsImpl: fs });
  s.write({ epoch: 5, exitRoot: '0x' + '11'.repeat(32), salt: '0x' + '22'.repeat(32) });
  assert.equal(s.read(5).exitRoot, '0x' + '11'.repeat(32));
  assert.deepEqual(s.list(), [5]);
  assert.equal(s.read(6), null);
});

test('commit：先落盘再发交易，且 salt 从不出现在日志里', async () => {
  const { fs, cfg, layer, bsc, log, store } = setup();
  const st = await step({
    cfg, epoch: EPOCH_N, now: END + 10, layer, bsc, store, wallet: WALLET, log,
    dryRun: false, deps: { sleep: async () => {} },
  });
  assert.equal(st.action, 'commit');

  const rec = store.read(EPOCH_N);
  assert.ok(rec, '必须落盘');
  assert.equal(rec.l2Block, 9);
  assert.ok(rec.committedTx, '发完交易要回写 tx');
  assert.equal(rec.commitment, commitmentHash({
    epoch: EPOCH_N, exitRoot: rec.exitRoot, l2BlockHash: rec.l2BlockHash,
    l2Block: rec.l2Block, salt: rec.salt, validator: WALLET.address,
  }));

  // 发出去的就是 commitAttestation(epoch, commitment)
  assert.equal(bsc.sent.length, 1);
  assert.ok(log.text().includes(rec.commitment), '承诺是链上公开值，可以打印');
  assert.ok(!log.text().includes(rec.salt), 'salt 绝不能出现在日志里');
  assert.ok(!log.text().includes(KEY.slice(2)), '私钥绝不能出现在日志里');
});

test('commit：--dry-run 只算不发，但记录照样落盘（下次好复用同一个 salt）', async () => {
  const { cfg, layer, bsc, log, store } = setup();
  await step({ cfg, epoch: EPOCH_N, now: END + 10, layer, bsc, store, wallet: WALLET, log,
    dryRun: true, deps: { sleep: async () => {} } });
  assert.equal(bsc.sent.length, 0);
  assert.ok(store.read(EPOCH_N));
  assert.equal(store.read(EPOCH_N).committedTx, null);
});

test('本地还没追到纪元边界 → 不承诺，也不落盘', async () => {
  const { cfg, bsc, log, store } = setup();
  const layer = new FakeRpc({ blocks: fakeChain({ startTs: 2 * EPOCH - 30, period: 3, count: 4 }) });
  const st = await step({ cfg, epoch: EPOCH_N, now: END + 10, layer, bsc, store, wallet: WALLET, log,
    dryRun: false, deps: {} });
  assert.equal(st.action, 'wait_sync');
  assert.equal(bsc.sent.length, 0);
  assert.equal(store.read(EPOCH_N), null);
});

test('承诺窗口已过 → 不发交易，只告警', async () => {
  const { cfg, layer, bsc, log, store } = setup();
  const st = await step({ cfg, epoch: EPOCH_N, now: END + COMMIT_WINDOW + 1, layer, bsc, store,
    wallet: WALLET, log, dryRun: false, deps: {} });
  assert.equal(st.action, 'commit_missed');
  assert.equal(bsc.sent.length, 0);
});

test('reveal：锚点 POSTED 时揭示，一致时明说一致', async () => {
  const { cfg, layer, bsc, log, store } = setup();
  // 先承诺
  await step({ cfg, epoch: EPOCH_N, now: END + 10, layer, bsc, store, wallet: WALLET, log,
    dryRun: false, deps: { sleep: async () => {} } });
  const rec = store.read(EPOCH_N);

  // 换成「锚点已发且与本地一致」
  const posted = END + COMMIT_WINDOW + 300;
  const bsc2 = new FakeRpc({
    calls: {
      [cfg.addresses.anchor.toLowerCase() + ':' + ifaceAnchor.getFunction('getAnchor').selector]:
        fakeAnchor({ state: 1, postedAt: posted, exitRoot: rec.exitRoot, l2Block: rec.l2Block, l2BlockHash: rec.l2BlockHash }),
    },
  });
  const log2 = memLogger();
  const st = await step({ cfg, epoch: EPOCH_N, now: posted + 60, layer, bsc: bsc2, store,
    wallet: WALLET, log: log2, dryRun: false, deps: { sleep: async () => {} } });
  assert.equal(st.action, 'reveal');
  assert.equal(bsc2.sent.length, 1);
  assert.match(log2.text(), /与链上锚点一致/);
  assert.ok(store.read(EPOCH_N).revealedTx);
  assert.ok(!log2.text().includes(rec.salt), 'salt 依然不许进日志');
});

test('reveal：与官方不一致时照样揭示自己算的那一个，并大声说出来', async () => {
  const { cfg, layer, bsc, log, store } = setup();
  await step({ cfg, epoch: EPOCH_N, now: END + 10, layer, bsc, store, wallet: WALLET, log,
    dryRun: false, deps: { sleep: async () => {} } });
  const rec = store.read(EPOCH_N);
  const posted = END + COMMIT_WINDOW + 300;
  const bsc2 = new FakeRpc({
    calls: {
      [cfg.addresses.anchor.toLowerCase() + ':' + ifaceAnchor.getFunction('getAnchor').selector]:
        fakeAnchor({ state: 1, postedAt: posted, exitRoot: '0x' + 'ee'.repeat(32), l2Block: rec.l2Block,
                     l2BlockHash: rec.l2BlockHash }),
    },
  });
  const log2 = memLogger();
  await step({ cfg, epoch: EPOCH_N, now: posted + 60, layer, bsc: bsc2, store, wallet: WALLET,
    log: log2, dryRun: false, deps: { sleep: async () => {} } });
  assert.match(log2.text(), /与链上锚点不一致/);
  assert.equal(bsc2.sent.length, 1, '不一致也要揭示，这正是见证机制的意义');

  // 揭示的参数必须是本地算出来的那个根，不是链上那个
  const decoded = ifaceStaking.decodeFunctionData('revealAttestation',
    ifaceStaking.encodeFunctionData('revealAttestation',
      [BigInt(EPOCH_N), rec.exitRoot, rec.l2BlockHash, BigInt(rec.l2Block), rec.salt]));
  assert.equal(decoded[1], rec.exitRoot);
});

test('attest --once：跑一趟就返回，不进死循环', async () => {
  const { fs, cfg, layer, bsc, store } = setup();
  const log = memLogger();
  const r = await attestRun(
    { home: '/w', once: true, dryRun: true, now: END + 10 },
    { fs, log, layerRpc: layer, bscRpc: bsc, store, wallet: WALLET, now: END + 10, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.match(log.text(), /纪元/);
});
