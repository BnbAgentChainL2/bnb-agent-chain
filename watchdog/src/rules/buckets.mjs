// 规则 BUCKETS —— 桥里两种 BAC 的严格分账（决策 #24a②）。
//
// 账目上的规则是：`lockedBac`（agent 进场锁进来的）在**合约的路径里**只有一个出口 ——
// `burnLocked()` 打到死地址；`buybackBac`（从市场回购来的）是唯一能用来付退出的桶。
// 这条规则就是那条记账规则的可执行版本。
//
// **决策 #29 / #29b 之后必须照实说的一句**：「进去的 BAC 永久锁死」这个说法已经作废 ——
// 桥改成可升级代理并加了 `emergencyWithdraw`，owner 的权限在这条规则之上。双桶记账继续实现
// （账目清楚仍然有价值，而且对中继私钥被盗仍然有效），但它不是「最后的兜底」。
// 合约真的改成可升级之后，owner 的每一次升级 / 紧急提取都会让下面的增量对账对不上：
// 那时必须把 `Upgraded` / `EmergencyWithdraw` 两个事件接进 `flows`，否则这条规则会在
// owner 每一次合法动作上误报。**在那之前，任何对不上都不是误报。**
//
// 三层检查，从弱到强：
//   ① 结构性不等式（一次快照就能判）：账面 ≤ 代币真实余额；owedTotal ≤ buybackBac；
//      reservedTotal ≤ owedTotal；totalBurned ≤ lockedBac。
//   ② 事件溯源的增量（两次快照 + 之间的全部事件）：`lockedBac` 只能被 `Locked.measured` 推高，
//      一 wei 都不能少；`totalBurned` 只能被 `LockedBurned` 推高。**这是「退出动了锁定桶」
//      的直接探测器** —— 任何绕过 `burnLocked()` 的路径都会让这两个增量对不上。
//   ③ `buybackBac` 的收支平衡：进 = 回购 + 收编的空投；出 = collect + 停机后的优先兑付 +
//      逃生兑付。对不上就说明有一条我们不知道的路径在动这个桶。
//
// 快照必须**读在同一个区块高度上**，事件区间必须正好是 (上次快照的块, 这次快照的块]。
// 不钉块就会读到撕裂的状态，于是这条规则会在每一笔正常的 collect 上误报。

import { RULE } from '../constants.mjs';
import { critical, ok, warn } from '../verdict.mjs';

/**
 * @param {object} i
 * @param {object} i.now  { block, lockedBac, totalBurned, buybackBac, owedTotal, reservedTotal, tokenBalance }
 * @param {?object} i.prev 上一次快照，第一次运行时给 null（只做 ① 层检查）
 * @param {object} i.flows (prev.block, now.block] 区间内的事件汇总：
 *        { locked, burned, bought, sweptBac, collected, haltPaid, escapeBac, revoked }
 */
export function checkBuckets(i) {
  const n = i.now;
  const accounted = n.lockedBac - n.totalBurned + n.buybackBac;
  const compared = {
    at: n.block,
    lockedBac: n.lockedBac,
    totalBurned: n.totalBurned,
    lockedFree: n.lockedBac - n.totalBurned,
    buybackBac: n.buybackBac,
    owedTotal: n.owedTotal,
    reservedTotal: n.reservedTotal,
    accounted,
    tokenBalance: n.tokenBalance,
    surplus: n.tokenBalance - accounted,
  };

  // ---------------------------------------------------------------- ① 结构
  if (n.totalBurned > n.lockedBac) {
    return critical(
      RULE.BUCKETS,
      'global',
      `totalBurned ${n.totalBurned} > lockedBac ${n.lockedBac}：销毁的比锁进来的还多`,
      compared,
    );
  }
  if (n.tokenBalance < accounted) {
    return critical(
      RULE.BUCKETS,
      'global',
      `桥的 BAC 真实余额 ${n.tokenBalance} 低于账面 ${accounted}（差 ${accounted - n.tokenBalance}）：有 BAC 在账本之外离开了桥`,
      compared,
    );
  }
  if (n.owedTotal > n.buybackBac) {
    return critical(
      RULE.BUCKETS,
      'global',
      `owedTotal ${n.owedTotal} > buybackBac ${n.buybackBac}：已锁定的债权超过了回购桶，下一笔兑付只能去动锁定桶`,
      compared,
    );
  }
  if (n.reservedTotal > n.owedTotal) {
    return critical(
      RULE.BUCKETS,
      'global',
      `reservedTotal ${n.reservedTotal} > owedTotal ${n.owedTotal}：已预留的释放额超过了债权总额`,
      compared,
    );
  }

  if (!i.prev) {
    return ok(RULE.BUCKETS, 'global', '两个桶的结构性不等式全部成立（首次快照，暂无增量可比）', compared);
  }

  // ------------------------------------------------------------ ② / ③ 增量
  const f = i.flows ?? {};
  const g = (k) => BigInt(f[k] ?? 0n);
  const dLocked = n.lockedBac - i.prev.lockedBac;
  const dBurned = n.totalBurned - i.prev.totalBurned;
  const dBuyback = n.buybackBac - i.prev.buybackBac;
  // `revokeEpochOwed` 不在这条等式里：它只把 owed / reserved 还回桶的**自由部分**，
  // 不改 `buybackBac` 本身。把它加进来反而会制造一条误报。
  const expectBuyback = g('bought') + g('sweptBac') - g('collected') - g('haltPaid') - g('escapeBac');

  const delta = {
    window: { from: i.prev.block + 1, to: n.block },
    lockedBac: { onchain: dLocked, fromEvents: g('locked') },
    totalBurned: { onchain: dBurned, fromEvents: g('burned') },
    buybackBac: { onchain: dBuyback, fromEvents: expectBuyback },
    flows: {
      locked: g('locked'),
      burned: g('burned'),
      bought: g('bought'),
      sweptBac: g('sweptBac'),
      collected: g('collected'),
      haltPaid: g('haltPaid'),
      escapeBac: g('escapeBac'),
    },
  };
  const full = { ...compared, prev: { block: i.prev.block, lockedBac: i.prev.lockedBac, totalBurned: i.prev.totalBurned, buybackBac: i.prev.buybackBac }, delta };

  if (dLocked !== g('locked')) {
    return critical(
      RULE.BUCKETS,
      'global',
      `lockedBac 的变化 ${dLocked} 与区间内 Locked 事件之和 ${g('locked')} 不一致：锁定桶被一条不在账本里的路径动过`,
      full,
    );
  }
  if (dBurned !== g('burned')) {
    return critical(
      RULE.BUCKETS,
      'global',
      `totalBurned 的变化 ${dBurned} 与区间内 LockedBurned 之和 ${g('burned')} 不一致`,
      full,
    );
  }
  if (dBuyback !== expectBuyback) {
    return critical(
      RULE.BUCKETS,
      'global',
      `buybackBac 的变化 ${dBuyback} 与「回购 + 收编 − collect − 停机兑付 − 逃生兑付」= ${expectBuyback} 不一致`,
      full,
    );
  }

  // 盈余（真实余额高于账面）是良性的：有人直接给桥转了 BAC，`sweepUntrackedBac()` 会把它
  // 收编进 buybackBac。只在它大到值得有人去按一下那个按钮时提醒一句。
  if (compared.surplus > 0n) {
    return warn(
      RULE.BUCKETS,
      'global',
      `桥里有 ${compared.surplus} wei BAC 还没入账（有人直接转进来的）。任何人都可以调 sweepUntrackedBac() 把它收编进回购桶`,
      full,
    );
  }
  return ok(RULE.BUCKETS, 'global', '两个桶的结构性不等式与逐笔增量全部对得上', full);
}
