// /api/health 形状的状态对象：对账公式、howToCheck 原样返回、告警触发。

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { commitWindowEndsAt } from '../src/anchorMath.mjs';
import { WARN } from '../src/constants.mjs';
import { buildStatus, composeStatus, reconcileDiff } from '../src/status.mjs';
import { initCursor } from '../src/db.mjs';
import { ADDR, FakeBsc, FakeLayer, fakeCfg, tmpDb } from './fakes.mjs';
import { _internal, registerSecret } from '../src/log.mjs';

const E = 20700;
const NOW = (E + 1) * 86400 + 3600;

function parts(over = {}) {
  return {
    now: NOW,
    cfg: fakeCfg(),
    lastPostedEpoch: E,
    bscCursor: 1000,
    bscHead: 1018,
    layerCursor: 28799,
    outboxNew: 0,
    outboxSent: 1,
    outboxOrphaned: 0,
    outboxParked: 0,
    bscKeyBalance: 82000000000000000n,
    layerKeyBalance: 994120000000000000000n,
    reconcile: {
      bscTotalIssued: 5000000000000000000000000n,
      bscTotalExited: 120000000000000000000000n,
      // 03 §3.1 的样例数字本身对不上它自己的公式（见 README 的「与文档的出入」），
      // 这里用一组**自洽**的数字：
      //   layerCirculating = (issued - exited) - feeSink - feeSplitter - Σ validator
      layerCirculating: 4879986396875000000000000n,
      feeSinkBalance: 3125000000000000n,
      feeSplitterBalance: 12400000000000000000n,
      validatorBalances: [{ addr: ADDR.layerSigner, balance: 1200000000000000000n }],
    },
    ...over,
  };
}

describe('对账公式（03 §3.1）', () => {
  it('FeeSink / FeeSplitter / 每个验证者的余额必须加回来，diff 才恒为 0', () => {
    const d = reconcileDiff(parts().reconcile);
    assert.equal(d, 0n);
  });

  it('旧写法（不加回 FeeSink）会从第一笔交易起就发散 —— 这里证明差额正是那两项', () => {
    const r = parts().reconcile;
    const old = BigInt(r.bscTotalIssued) - BigInt(r.bscTotalExited) - BigInt(r.layerCirculating);
    assert.equal(
      old,
      BigInt(r.feeSinkBalance) +
        BigInt(r.feeSplitterBalance) +
        r.validatorBalances.reduce((a, v) => a + BigInt(v.balance), 0n),
    );
    assert.notEqual(old, 0n);
  });

  it('中继超发（层内流通多出来）→ diff 非零 + reconcile_mismatch 告警', () => {
    const s = composeStatus(parts({ reconcile: { ...parts().reconcile, layerCirculating: 4879986396875000000000001n } }));
    assert.equal(s.reconcile.ok, false);
    assert.ok(s.warnings.includes(WARN.RECONCILE_MISMATCH));
  });
});

describe('health 形状', () => {
  it('字段名与 03 §3.1 逐字一致，金额是十进制字符串', () => {
    const s = composeStatus(parts());
    assert.equal(s.schema, 'bac/health/1');
    assert.deepEqual(Object.keys(s.relayer), [
      'lastPostedEpoch', 'currentEpoch', 'epochLag', 'bscCursor', 'bscLagBlocks', 'layerCursor',
      'outboxNew', 'outboxSent', 'outboxOrphaned', 'bscKeyBalance', 'layerKeyBalance',
    ]);
    assert.equal(typeof s.relayer.bscKeyBalance, 'string');
    assert.equal(s.relayer.currentEpoch, E + 1);
    assert.equal(s.relayer.epochLag, 1);
    assert.equal(s.relayer.bscLagBlocks, 18);
    assert.equal(
      s.reconcile.formula,
      'diff = (bscTotalIssued - bscTotalExited) - (layerCirculating + feeSinkBalance + feeSplitterBalance + sum(validatorBalances))',
    );
    assert.equal(s.reconcile.ok, true);
  });

  it('howToCheck 原样返回七条 cast，任何人都能自己复算（决策 #17 后多了两条）', () => {
    const s = composeStatus(parts());
    assert.equal(s.reconcile.howToCheck.length, 7);
    assert.match(s.reconcile.howToCheck[0], /totalCreditsIssued\(\)\(uint256\)/);
    assert.match(s.reconcile.howToCheck[1], /totalCreditsExited\(\)\(uint256\)/);
    assert.ok(s.reconcile.howToCheck[2].includes(ADDR.l2Bridge));
    assert.ok(s.reconcile.howToCheck[3].includes(ADDR.feeSink));
    assert.ok(s.reconcile.howToCheck[4].includes(ADDR.feeSplitter));
    assert.match(s.reconcile.howToCheck[5], /qbft_getValidatorsByBlockNumber/);
    assert.match(s.reconcile.howToCheck[6], /validator/);
  });

  it('reconcile 里 FeeSplitter 与逐个验证者余额分项列出（03 §3.1 要求可逐项核）', () => {
    const s = composeStatus(parts());
    assert.equal(s.reconcile.feeSplitterBalance, '12400000000000000000');
    assert.deepEqual(s.reconcile.validatorBalances, [
      { addr: ADDR.layerSigner, balance: '1200000000000000000' },
    ]);
    assert.equal(s.reconcile.signerBalance, undefined);
  });

  it('anchorCommitWindowEndsAt = 下一个该发纪元的 (epoch+1)*86400 + 2h', () => {
    const s = composeStatus(parts());
    assert.equal(s.anchorCommitWindowEndsAt, commitWindowEndsAt(E + 1));
  });
});

describe('告警', () => {
  it('锚点逾期（过了承诺窗口还没发）→ anchor_overdue', () => {
    const s = composeStatus(parts({ now: commitWindowEndsAt(E + 1) + 1, lastPostedEpoch: E }));
    assert.ok(s.warnings.includes(WARN.ANCHOR_OVERDUE));
  });

  it('中继余额低于 0.05 BNB / 100 BAC → relayer_balance_low', () => {
    const s = composeStatus(parts({ bscKeyBalance: 1n }));
    assert.ok(s.warnings.includes(WARN.RELAYER_BALANCE_LOW));
  });

  it('有 parked 的 job → outbox_parked', () => {
    const s = composeStatus(parts({ outboxParked: 1 }));
    assert.ok(s.warnings.includes(WARN.OUTBOX_PARKED));
  });

  it('外部传进来的告警（例如 bsc_finality_unavailable）会被带上且去重', () => {
    const s = composeStatus(parts({ warnings: [WARN.BSC_FINALITY_UNAVAILABLE, WARN.BSC_FINALITY_UNAVAILABLE] }));
    assert.deepEqual(s.warnings.filter((w) => w === WARN.BSC_FINALITY_UNAVAILABLE).length, 1);
  });
});

describe('buildStatus（真读假链）', () => {
  const t = tmpDb();
  after(() => t.cleanup());

  it('能从假 BSC / 假层内拼出完整对象', async () => {
    const cfg = fakeCfg();
    const bsc = new FakeBsc({ head: 1018, lastPostedEpoch: E, issued: 1000n, exited: 0n });
    const layer = new FakeLayer({
      balances: new Map([
        [ADDR.l2Bridge, 1000000000000000000000000000n - 1000n],
        [ADDR.feeSink, 0n],
        [ADDR.feeSplitter, 0n],
        [ADDR.layerSigner, 0n],
      ]),
    });
    initCursor(t.db, 'bsc', 1000, NOW);
    initCursor(t.db, 'layer', 28799, NOW);
    const s = await buildStatus({ db: t.db, bsc, layer, cfg, now: () => NOW, warnings: new Set() });
    assert.equal(s.relayer.lastPostedEpoch, E);
    assert.equal(s.reconcile.diff, '0');
    assert.equal(s.reconcile.ok, true);
    assert.ok(Array.isArray(s.pendingCredits));
  });
});

describe('日志绝不打印私钥', () => {
  it('注册过的秘密值在输出里被替换成 [REDACTED]', () => {
    const fake = '0x' + '9'.repeat(64);
    registerSecret(fake);
    const out = _internal.scrub(JSON.stringify({ msg: 'boom', key: fake }));
    assert.ok(!out.includes(fake));
    assert.ok(out.includes('[REDACTED]'));
  });
});
