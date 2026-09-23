// 五条规则的单元测试：每一条都有「必须跳闸」的例子，也有「绝不许跳闸」的例子。
// 后者和前者一样重要 —— 一次误暂停会让 collect 停摆，而且从 21 天的暂停额度里扣时间。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAYER_TOTAL_SUPPLY, MAX_BUYBACK_BNB, MIN_BUYBACK_BNB, SEVERITY } from '../src/constants.mjs';
import { checkAnchorRoot } from '../src/rules/anchorRoot.mjs';
import { checkBuckets } from '../src/rules/buckets.mjs';
import { checkBuyback } from '../src/rules/buyback.mjs';
import { checkCadence } from '../src/rules/cadence.mjs';
import { checkReconcile } from '../src/rules/reconcile.mjs';
import { checkEpochRelease, checkRollingRelease } from '../src/rules/releaseCap.mjs';

const R = '0x' + 'ab'.repeat(32);
const H = '0x' + 'cd'.repeat(32);

function anchorInput(over = {}) {
  return {
    epoch: 1000,
    onchain: {
      exitRoot: R,
      l2BlockHash: H,
      l2Block: 399,
      creditedInEpoch: 100n,
      exitCreditsInEpoch: 50n,
      feeBurnedInEpoch: 0n,
      circulating: 0n,
      exitCount: 2,
      ...(over.onchain ?? {}),
    },
    mine: {
      root: R,
      l2BlockHash: H,
      l2Block: 399,
      credited: 100n,
      exitCredits: 50n,
      exitCount: 2,
      range: { from: 200, to: 399, empty: false },
      ...(over.mine ?? {}),
    },
    carriedEpochs: over.carriedEpochs ?? [],
    feeBurnedMine: over.feeBurnedMine ?? null,
    circulatingMine: over.circulatingMine ?? null,
  };
}

describe('ANCHOR_ROOT', () => {
  it('诚实锚点：逐字一致 → OK', () => {
    const v = checkAnchorRoot(anchorInput());
    assert.equal(v.severity, SEVERITY.OK);
  });

  it('伪造的 exitRoot → CRITICAL，并且把两边的根都记进 compared', () => {
    const forged = '0x' + '99'.repeat(32);
    const v = checkAnchorRoot(anchorInput({ onchain: { exitRoot: forged } }));
    assert.equal(v.severity, SEVERITY.CRITICAL);
    assert.equal(v.compared.exitRoot.onchain, forged);
    assert.equal(v.compared.exitRoot.mine, R);
  });

  it('l2Block 被改 → CRITICAL', () => {
    const v = checkAnchorRoot(anchorInput({ onchain: { l2Block: 401 } }));
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('l2BlockHash 对不上 → CRITICAL', () => {
    const v = checkAnchorRoot(anchorInput({ onchain: { l2BlockHash: '0x' + '11'.repeat(32) } }));
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('exitCreditsInEpoch 被放大 → CRITICAL', () => {
    const v = checkAnchorRoot(anchorInput({ onchain: { exitCreditsInEpoch: 5000n } }));
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('creditedInEpoch 被多报 → CRITICAL（postAnchor 的检查 #7 挡不住额度内的多报）', () => {
    const v = checkAnchorRoot(anchorInput({ onchain: { creditedInEpoch: 999n } }));
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('只有 exitCount 对不上（根是对的）→ 只 WARN，不跳闸', () => {
    const v = checkAnchorRoot(anchorInput({ onchain: { exitCount: 3 } }));
    assert.equal(v.severity, SEVERITY.WARN);
  });

  it('feeBurned / circulating 是信息字段：对不上也只 WARN', () => {
    const v = checkAnchorRoot(anchorInput({ onchain: { feeBurnedInEpoch: 7n }, feeBurnedMine: 8n }));
    assert.equal(v.severity, SEVERITY.WARN);
  });

  it('历史余额读不回来（feeBurnedMine = null）→ 不因此产生任何裁决', () => {
    const v = checkAnchorRoot(anchorInput({ onchain: { feeBurnedInEpoch: 7n }, feeBurnedMine: null }));
    assert.equal(v.severity, SEVERITY.OK);
  });

  it('空纪元：根是全零、计数全零 → OK（层内停过块不是伪造）', () => {
    const zero = '0x' + '0'.repeat(64);
    const v = checkAnchorRoot(
      anchorInput({
        onchain: { exitRoot: zero, exitCount: 0, exitCreditsInEpoch: 0n, creditedInEpoch: 0n },
        mine: { root: zero, exitCount: 0, exitCredits: 0n, credited: 0n, range: { from: 400, to: 399, empty: true } },
      }),
    );
    assert.equal(v.severity, SEVERITY.OK);
  });
});

describe('RECONCILE', () => {
  const base = {
    bscTotalIssued: 1000n,
    bscTotalExited: 0n,
    bridgeBalance: LAYER_TOTAL_SUPPLY - 1000n,
    feeSinkBalance: 0n,
    signerBalance: 0n,
    feeSplitterBalance: 0n,
    validatorBalances: [],
    inflightCredits: 0n,
    inflightExits: 0n,
    skewExits: 0n,
    toleranceWei: 0n,
  };

  it('恒等式成立 → OK', () => {
    const v = checkReconcile(base);
    assert.equal(v.severity, SEVERITY.OK);
    assert.equal(v.compared.diff, '0');
  });

  it('层内超发（diff < 0）→ CRITICAL', () => {
    // 桥的余额少了 500 = 层内多流通了 500，而 BSC 上没有对应的锁定
    const v = checkReconcile({ ...base, bridgeBalance: LAYER_TOTAL_SUPPLY - 1500n });
    assert.equal(v.severity, SEVERITY.CRITICAL);
    assert.equal(v.compared.diff, '-500');
  });

  it('读数偏斜造成的小额负值被显式扣掉 → 不跳闸', () => {
    const v = checkReconcile({ ...base, bridgeBalance: LAYER_TOTAL_SUPPLY - 1500n, skewExits: 500n });
    assert.notEqual(v.severity, SEVERITY.CRITICAL);
  });

  it('在途存款让 diff 变正 → 在额度内就 OK', () => {
    const v = checkReconcile({ ...base, bscTotalIssued: 1300n, inflightCredits: 300n });
    assert.equal(v.severity, SEVERITY.OK);
  });

  it('正方向超出在途额度 → 只 WARN，永不跳闸', () => {
    const v = checkReconcile({ ...base, bscTotalIssued: 1300n, inflightCredits: 0n });
    assert.equal(v.severity, SEVERITY.WARN);
  });
});

describe('BUCKETS', () => {
  const now = { block: 100, lockedBac: 1000n, totalBurned: 0n, buybackBac: 500n, owedTotal: 200n, reservedTotal: 50n, tokenBalance: 1500n };
  const zeroFlows = { locked: 0n, burned: 0n, bought: 0n, sweptBac: 0n, collected: 0n, haltPaid: 0n, escapeBac: 0n };

  it('账面与余额一致、增量对得上 → OK', () => {
    const prev = { block: 90, lockedBac: 1000n, totalBurned: 0n, buybackBac: 500n };
    const v = checkBuckets({ now, prev, flows: zeroFlows });
    assert.equal(v.severity, SEVERITY.OK);
  });

  it('代币真实余额低于账面 → CRITICAL', () => {
    const v = checkBuckets({ now: { ...now, tokenBalance: 1400n }, prev: null, flows: zeroFlows });
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('owedTotal 超过 buybackBac → CRITICAL（下一笔兑付只能去动锁定桶）', () => {
    const v = checkBuckets({ now: { ...now, owedTotal: 600n }, prev: null, flows: zeroFlows });
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('lockedBac 少了（退出动了锁定桶）→ CRITICAL', () => {
    const prev = { block: 90, lockedBac: 1200n, totalBurned: 0n, buybackBac: 500n };
    const v = checkBuckets({ now, prev, flows: zeroFlows });
    assert.equal(v.severity, SEVERITY.CRITICAL);
    assert.equal(v.compared.delta.lockedBac.onchain, '-200');
    assert.equal(v.compared.delta.lockedBac.fromEvents, '0');
  });

  it('lockedBac 的增量与 Locked 事件之和一致 → OK', () => {
    const prev = { block: 90, lockedBac: 800n, totalBurned: 0n, buybackBac: 500n };
    const v = checkBuckets({ now, prev, flows: { ...zeroFlows, locked: 200n } });
    assert.equal(v.severity, SEVERITY.OK);
  });

  it('一笔正常的 collect：buybackBac 按 collected 减少 → OK', () => {
    const prev = { block: 90, lockedBac: 1000n, totalBurned: 0n, buybackBac: 530n };
    const v = checkBuckets({ now, prev, flows: { ...zeroFlows, collected: 30n } });
    assert.equal(v.severity, SEVERITY.OK);
  });

  it('buybackBac 无端减少（没有对应的 collect / 兑付事件）→ CRITICAL', () => {
    const prev = { block: 90, lockedBac: 1000n, totalBurned: 0n, buybackBac: 700n };
    const v = checkBuckets({ now, prev, flows: zeroFlows });
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('有人直接给桥转了 BAC（余额高于账面）→ 只 WARN', () => {
    const prev = { block: 90, lockedBac: 1000n, totalBurned: 0n, buybackBac: 500n };
    const v = checkBuckets({ now: { ...now, tokenBalance: 1600n }, prev, flows: zeroFlows });
    assert.equal(v.severity, SEVERITY.WARN);
  });

  it('burnLocked 之后 totalBurned 与事件对得上 → OK', () => {
    const prev = { block: 90, lockedBac: 1000n, totalBurned: 0n, buybackBac: 500n };
    const v = checkBuckets({
      now: { ...now, totalBurned: 400n, tokenBalance: 1100n },
      prev,
      flows: { ...zeroFlows, burned: 400n },
    });
    assert.equal(v.severity, SEVERITY.OK);
  });
});

describe('BUYBACK', () => {
  const ev = { txHash: '0xfeed', blockNumber: 500, by: '0x1', venue: 2, bnbSpent: 100000000000000000n, bacBought: 1000n };

  it('单次花费超过 MAX_BUYBACK_BNB → CRITICAL', () => {
    const v = checkBuyback({ event: { ...ev, bnbSpent: MAX_BUYBACK_BNB + 1n }, reference: null, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('单次花费低于 MIN_BUYBACK_BNB → CRITICAL', () => {
    const v = checkBuyback({ event: { ...ev, bnbSpent: MIN_BUYBACK_BNB - 1n }, reference: null, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('花了钱一个 BAC 都没买到 → CRITICAL', () => {
    const v = checkBuyback({ event: { ...ev, bacBought: 0n }, reference: null, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('读不到参考价（非归档 RPC）→ SKIP，绝不跳闸', () => {
    const v = checkBuyback({ event: ev, reference: null, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.SKIP);
    assert.equal(v.compared.referenceAvailable, false);
  });

  it('滑点在上限内 → OK', () => {
    // 参考价：这笔 BNB 本应买到 1100，税 0，合约下限 = 1100 × 97% = 1067
    const v = checkBuyback({ event: { ...ev, bacBought: 1080n }, reference: { expectedGross: 1100n, buyTaxBps: 0n, at: 499 }, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.OK);
  });

  it('滑点击穿下限 → CRITICAL，并记下实测滑点', () => {
    const v = checkBuyback({ event: { ...ev, bacBought: 900n }, reference: { expectedGross: 1100n, buyTaxBps: 0n, at: 499 }, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.CRITICAL);
    assert.equal(v.compared.contractFloor, '1067');
    assert.equal(v.compared.realizedSlippageBps, '1819');
  });

  it('参考价带买入税：下限按税后算，不误判', () => {
    // gross 1100，税 200 bps → 税后 1078，下限 = 1078 × 97% = 1045
    const v = checkBuyback({ event: { ...ev, bacBought: 1050n }, reference: { expectedGross: 1100n, buyTaxBps: 200n, at: 499 }, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.OK);
  });

  it('容差把「参考价读在另一个区块上」的抖动吸收掉', () => {
    const strict = checkBuyback({ event: { ...ev, bacBought: 1060n }, reference: { expectedGross: 1100n, buyTaxBps: 0n, at: 499 }, toleranceBps: 0n });
    assert.equal(strict.severity, SEVERITY.CRITICAL);
    const lenient = checkBuyback({ event: { ...ev, bacBought: 1060n }, reference: { expectedGross: 1100n, buyTaxBps: 0n, at: 499 }, toleranceBps: 100n });
    assert.equal(lenient.severity, SEVERITY.OK);
  });

  it('没有归档节点时的单价软检查最多到 WARN', () => {
    const history = Array.from({ length: 6 }, () => ({ bnbSpent: 100000000000000000n, bacBought: 1000n }));
    const v = checkBuyback({ event: { ...ev, bacBought: 100n }, reference: null, toleranceBps: 0n, history });
    assert.equal(v.severity, SEVERITY.WARN);
  });
});

describe('RELEASE_CAP', () => {
  const before = { buybackBac: 1440000n, reservedTotal: 0n, owedTotal: 1000000n };

  it('按链上算式复算，未超 → OK', () => {
    // cap = 1440000 × 200 / (10000 × 144) = 200
    const v = checkEpochRelease({ event: { epoch: 5, pot: 200n, releaseBps: 200, skipped: false }, before, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.OK);
    assert.equal(v.compared.cap, '200');
  });

  it('超过上限 → CRITICAL', () => {
    const v = checkEpochRelease({ event: { epoch: 5, pot: 5000n, releaseBps: 200, skipped: false }, before, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('releaseBps 不是链上三档之一 → CRITICAL', () => {
    const v = checkEpochRelease({ event: { epoch: 5, pot: 1n, releaseBps: 9000, skipped: false }, before, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('被跳过的纪元 → OK', () => {
    const v = checkEpochRelease({ event: { epoch: 5, pot: 0n, releaseBps: 0, skipped: true }, before, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.OK);
  });

  it('影子账本没覆盖到这段区间 → SKIP，不拿不确定的基数冻结桥', () => {
    const v = checkEpochRelease({ event: { epoch: 5, pot: 999999n, releaseBps: 200, skipped: false }, before: null, toleranceBps: 0n });
    assert.equal(v.severity, SEVERITY.SKIP);
  });

  it('滚动 24 小时超过每天上限 → CRITICAL', () => {
    const v = checkRollingRelease({ windowSec: 86400, released: 60000n, baseMax: 1000000n, maxDailyBps: 500n, toleranceBps: 0n, samples: 10 });
    assert.equal(v.severity, SEVERITY.CRITICAL);
  });

  it('滚动 24 小时在上限内 → OK', () => {
    const v = checkRollingRelease({ windowSec: 86400, released: 40000n, baseMax: 1000000n, maxDailyBps: 500n, toleranceBps: 0n, samples: 10 });
    assert.equal(v.severity, SEVERITY.OK);
  });

  it('逼近上限 90% → WARN', () => {
    const v = checkRollingRelease({ windowSec: 86400, released: 49000n, baseMax: 1000000n, maxDailyBps: 500n, toleranceBps: 0n, samples: 10 });
    assert.equal(v.severity, SEVERITY.WARN);
  });
});

describe('CADENCE（永不跳闸）', () => {
  it('锚点跟得上 → OK', () => {
    const v = checkCadence({ nowTs: 1000 * 600 + 10, lastPostedEpoch: 999 });
    assert.equal(v.severity, SEVERITY.OK);
  });
  it('落后 3 个纪元 → WARN，而且最高只能是 WARN', () => {
    const v = checkCadence({ nowTs: 1000 * 600 + 10, lastPostedEpoch: 996 });
    assert.equal(v.severity, SEVERITY.WARN);
  });
  it('中继停了一整天，仍然只是 WARN', () => {
    const v = checkCadence({ nowTs: 1144 * 600 + 10, lastPostedEpoch: 999 });
    assert.equal(v.severity, SEVERITY.WARN);
    assert.equal(v.compared.behindEpochs, 144);
  });
});
