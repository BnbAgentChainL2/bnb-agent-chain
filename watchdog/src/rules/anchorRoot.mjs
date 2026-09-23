// 规则 ANCHOR_ROOT —— 看门狗唯一有 120 秒窗口的规则，也是唯一能挡住「中继被盗」的规则。
//
// 问的问题只有一个：**链上这个锚点里的 exitRoot，是不是我自己从层内日志重算出来的那个？**
// 我不读中继的数据库、不读它的日志、不信它报的 exitCount，只从层内节点拉 `ExitBurned`
// 与 `CreditsMinted`，用自己那份 merkle 实现（src/ids.mjs）算一遍根。
//
// 合法的重报必须放过（否则这条规则每次 veto 之后都会误报一次）：
// 被 VETOED / DISPUTED 的纪元的叶子会**原样**并进下一个锚点（03 §1.3），
// 所以期望叶子集 = 本纪元区间的叶子 ∪ 每个未结重报纪元区间的叶子。
//
// 误报的另外两个来源，都在这里被显式处理掉：
//   ① 空纪元（层内停过块）：from > to，锚点合法形状是 exitRoot = 0、exitCount = 0、
//      l2Block 等于上一纪元。不特判就会把停机当成伪造。
//   ② 历史状态读不回来（Besu `--bonsai-historical-block-limit=512` ≈ 25.6 分钟）：
//      `feeBurnedInEpoch` 与 `circulating` 要在旧区块上读余额，重启后补算老纪元时必然读不到。
//      这两项一律降级成 SKIP / WARN，**永不跳闸** —— 它们本来就是信息字段（修订 #30）。

import { RULE } from '../constants.mjs';
import { ZERO_ROOT } from '../ids.mjs';
import { critical, ok, warn } from '../verdict.mjs';

/**
 * @param {object} input
 * @param {number} input.epoch
 * @param {object} input.onchain  链上读回来的 Anchor（字段名与 IChainAnchor.Anchor 一致）
 * @param {object} input.mine     看门狗自己算的：{ root, exitCount, exitCredits, credited, l2Block, l2BlockHash, empty }
 * @param {number[]} input.carriedEpochs 本次期望被重报进来的纪元
 * @param {?bigint} input.feeBurnedMine   读得到就给，读不到给 null（历史状态窗口已过）
 * @param {?bigint} input.circulatingMine 同上
 */
export function checkAnchorRoot(input) {
  const { epoch, onchain, mine, carriedEpochs = [] } = input;
  const base = {
    epoch,
    carriedEpochs,
    range: mine.range ?? null,
    exitRoot: { mine: mine.root, onchain: onchain.exitRoot },
    l2Block: { mine: mine.l2Block, onchain: Number(onchain.l2Block) },
    l2BlockHash: { mine: mine.l2BlockHash, onchain: onchain.l2BlockHash },
    exitCount: { mine: mine.exitCount, onchain: Number(onchain.exitCount) },
    exitCredits: { mine: mine.exitCredits, onchain: BigInt(onchain.exitCreditsInEpoch) },
    credited: { mine: mine.credited, onchain: BigInt(onchain.creditedInEpoch) },
    leafIds: mine.leafIds ?? null,
  };

  // ① 根。这是钱的那一项：根对了，谁都只能按真实叶子领；根错了，小偷把整个资产桶锁成自己的债权。
  const mineRoot = (mine.root ?? ZERO_ROOT).toLowerCase();
  const chainRoot = String(onchain.exitRoot).toLowerCase();
  if (mineRoot !== chainRoot) {
    return critical(
      RULE.ANCHOR_ROOT,
      epoch,
      `纪元 ${epoch} 的 exitRoot 与看门狗从层内日志复算的结果不一致：链上 ${chainRoot}，复算 ${mineRoot}（叶子 ${mine.exitCount} 片）`,
      base,
    );
  }

  // ② 层内区块。根相同但区块号被篡改，意味着下一纪元的区间会被整段跳过 —— 同样是偷。
  if (Number(onchain.l2Block) !== Number(mine.l2Block)) {
    return critical(
      RULE.ANCHOR_ROOT,
      epoch,
      `纪元 ${epoch} 的 l2Block 不是规范定义的那个块：链上 ${Number(onchain.l2Block)}，规范 ${mine.l2Block}`,
      base,
    );
  }
  if (mine.l2BlockHash && String(onchain.l2BlockHash).toLowerCase() !== String(mine.l2BlockHash).toLowerCase()) {
    return critical(
      RULE.ANCHOR_ROOT,
      epoch,
      `纪元 ${epoch} 的 l2BlockHash 与层内第 ${mine.l2Block} 块的真实哈希不一致`,
      base,
    );
  }

  // ③ 退出积分总量。根一致时它本该恒等；不等说明叶子集合一样但金额字段被改过，
  //    而 postAnchor 的检查 #8 用的就是这个数。
  if (BigInt(onchain.exitCreditsInEpoch) !== BigInt(mine.exitCredits)) {
    return critical(
      RULE.ANCHOR_ROOT,
      epoch,
      `纪元 ${epoch} 的 exitCreditsInEpoch 与叶子金额之和不一致：链上 ${BigInt(onchain.exitCreditsInEpoch)}，复算 ${mine.exitCredits}`,
      base,
    );
  }

  // ④ 入账积分。多报 creditedInEpoch = 在层内凭空多发积分，postAnchor 的检查 #7 只挡「超过
  //    BSC 总锁定量」，挡不住「在额度内多报」。这一项必须由看门狗从 CreditsMinted 复算。
  if (BigInt(onchain.creditedInEpoch) !== BigInt(mine.credited)) {
    return critical(
      RULE.ANCHOR_ROOT,
      epoch,
      `纪元 ${epoch} 的 creditedInEpoch 与 CreditsMinted 之和不一致：链上 ${BigInt(onchain.creditedInEpoch)}，复算 ${mine.credited}`,
      base,
    );
  }

  // ⑤ exitCount：根与金额都对上之后它只是展示字段，错了要说，但不值得冻结一座桥。
  if (Number(onchain.exitCount) !== Number(mine.exitCount)) {
    return warn(RULE.ANCHOR_ROOT, epoch, `纪元 ${epoch} 的 exitCount 与叶子片数不一致（根本身是对的）`, base);
  }

  // ⑥ 两个信息字段。读不到就 SKIP（历史状态窗口已过），读得到但不等只 WARN（修订 #30：
  //    链上从来不校验 circulating，它不是钱）。
  const info = { ...base };
  if (input.feeBurnedMine !== null && input.feeBurnedMine !== undefined) {
    info.feeBurned = { mine: input.feeBurnedMine, onchain: BigInt(onchain.feeBurnedInEpoch) };
    if (BigInt(onchain.feeBurnedInEpoch) !== BigInt(input.feeBurnedMine)) {
      return warn(RULE.ANCHOR_ROOT, epoch, `纪元 ${epoch} 的 feeBurnedInEpoch 对不上（信息字段，不跳闸）`, info);
    }
  }
  if (input.circulatingMine !== null && input.circulatingMine !== undefined) {
    info.circulating = { mine: input.circulatingMine, onchain: BigInt(onchain.circulating) };
    if (BigInt(onchain.circulating) !== BigInt(input.circulatingMine)) {
      return warn(RULE.ANCHOR_ROOT, epoch, `纪元 ${epoch} 的 circulating 对不上（信息字段，不跳闸）`, info);
    }
  }

  return ok(RULE.ANCHOR_ROOT, epoch, `纪元 ${epoch} 的锚点与看门狗的独立复算逐字一致`, info);
}
