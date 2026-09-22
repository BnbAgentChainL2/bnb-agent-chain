// 方向 B：把一个纪元组装成 AnchorJob（03-INTERFACES.md §1.3 的 JSON 形状，逐字）。
//
// 层内是 QBFT，**即时最终性**：一个块被 commit 就不会回滚（docs/research/10-consensus-client.md
// 实测：Besu 24.12.2 + QBFT，45 s 出 21 块，BFT 终局）。所以这里**没有任何层侧重组处理**：
// 不等确认深度、不做孤块标记、anchor job 永远不会变成 orphaned（02 §6.2 那张表里
// 「anchor 分支删除，credit / sync 分支保留」说的就是这件事）。BSC 侧的重组处理一行不动。

import { EPOCH, LAYER_STATE_WINDOW_SEC, LAYER_TOTAL_SUPPLY, OUTBOX_STATUS, WARN } from './constants.mjs';
import { epochEndsAt, mergeCarried, rangeFor } from './anchorMath.mjs';
import { unresolvedAnchors } from './db.mjs';
import { exitRootOf } from './ids.mjs';

/**
 * 组装某个纪元的锚点。
 *
 * @param {{db:object, layer:object, cfg:object, now:()=>number}} ctx
 * @param {number} epoch
 * @returns {Promise<{ok:boolean, payload?:object, warnings:string[], reason?:string}>}
 */
export async function assembleAnchor(ctx, epoch) {
  const { db, layer, cfg } = ctx;
  const now = ctx.now();
  const warnings = [];

  const range = await rangeFor(layer, epoch);
  if (!range) return { ok: false, warnings, reason: `层内在纪元 ${epoch} 结束时还不存在` };

  // 运维约束（03 §1.3）：`--state.scheme=path` 默认只留 128 个状态 ≈ 6.4 分钟，
  // 中继必须在纪元结束后 6 分钟内读完四个余额。读晚了余额可能已经被裁剪。
  const lateBy = now - epochEndsAt(epoch);
  if (lateBy > LAYER_STATE_WINDOW_SEC) warnings.push(WARN.LAYER_STATE_WINDOW_MISSED);

  const empty = range.from > range.to; // 空纪元（长时间停机）：l2Block(epoch) == l2Block(epoch-1)
  const exits = empty ? [] : await layer.exitLogs(range.from, range.to);
  const mints = empty ? [] : await layer.creditLogs(range.from, range.to);

  // 退出的纪元归属**以 ExitBurned 事件里的 epoch 字段为准，别无他解**（03 §1.3）。
  // 区块区间是按「时间戳 < (epoch+1)*86400」切的，两者按构造必然一致；不一致说明
  // 节点的时间戳或我们的区间算错了 —— 宁可停，不可错。
  const bad = exits.find((e) => Number(e.epoch) !== epoch);
  if (bad) {
    warnings.push(WARN.EXIT_EPOCH_MISMATCH);
    return { ok: false, warnings, reason: `exitId=${bad.exitId} 的事件 epoch=${bad.epoch}，与区间推出的 ${epoch} 不一致，已停止组装` };
  }

  const ownLeaves = exits.map((e) => ({
    exitId: Number(e.exitId),
    agentId: Number(e.agentId),
    to: e.to,
    credits: BigInt(e.credits).toString(),
    bornEpoch: Number(e.epoch), // 只是分桶/展示信息，**不进叶子哈希**
    layerTxHash: e.layerTxHash,
    layerBlock: Number(e.layerBlock),
  }));

  const ownCredited = mints.reduce((a, m) => a + BigInt(m.amount), 0n);
  const ownExitCredits = exits.reduce((a, e) => a + BigInt(e.credits), 0n);

  // feeBurnedInEpoch := ΔB_sink + ΔB_signer（03 §1.3）。
  // **小费不进 FeeSink**：zeroBaseFee 下全部 gas 费以 tips 形式进出块者 EOA（决策 #16 / 实测），
  // 两个地址必须分别读、相加。
  const tip = range.to;
  const base = range.previous ? range.previous.number : 0;
  const [sinkNow, sinkPrev, signerNow, signerPrev, bridgeNow] = await Promise.all([
    layer.balance(cfg.addresses.feeSink, tip),
    layer.balance(cfg.addresses.feeSink, base),
    layer.balance(cfg.addresses.layerSigner, tip),
    layer.balance(cfg.addresses.layerSigner, base),
    layer.balance(cfg.addresses.l2Bridge, tip),
  ]);
  const ownFeeBurned = BigInt(sinkNow) - BigInt(sinkPrev) + (BigInt(signerNow) - BigInt(signerPrev));

  // circulating 是**纯信息字段**（01 §6.2 删掉了那条恒等式检查），四个余额全部在 l2Block(epoch) 上读。
  const circulating = LAYER_TOTAL_SUPPLY - BigInt(bridgeNow) - BigInt(sinkNow) - BigInt(signerNow);

  // 被 VETOED / DISPUTED 的纪元并进本次锚点：计数字段相加，叶子原样带上（一个字节都不改）。
  const carried = unresolvedAnchors(db).filter((a) => a.epoch < epoch);
  const merged = mergeCarried(
    { credited: ownCredited, exitCredits: ownExitCredits, feeBurned: ownFeeBurned, leaves: ownLeaves },
    carried,
  );

  const { root, hashes, leaves } = exitRootOf(merged.leaves, cfg.addresses.bacBridge);
  const leavesOut = leaves.map((l, i) => ({ ...l, leaf: hashes[i] }));

  const payload = {
    $schema: 'bac/AnchorJob/1',
    kind: 'anchor',
    epoch,
    anchor: {
      exitRoot: root,
      l2BlockHash: range.current.hash,
      l2Block: range.current.number,
      creditedInEpoch: merged.credited.toString(),
      exitCreditsInEpoch: merged.exitCredits.toString(),
      feeBurnedInEpoch: (merged.feeBurned < 0n ? 0n : merged.feeBurned).toString(),
      circulating: circulating.toString(),
      exitCount: leavesOut.length,
    },
    leaves: leavesOut,
    status: OUTBOX_STATUS.NEW,
    bscTxHash: null,
    // 附加字段（不改 §1.3 已定义的任何字段）：重报了哪些被否决的纪元，运维一眼能看懂。
    carriedEpochs: merged.carriedEpochs,
    range: { from: range.from, to: range.to, empty },
    assembledAt: now,
    attempts: 0,
    lastError: null,
  };

  if (merged.feeBurned < 0n) {
    // 余额减少只可能是出块者自己花掉了小费。它不是 fee，不该算进 feeBurned，也不该变成负数。
    warnings.push('fee_burned_negative_clamped');
  }
  return { ok: true, payload, warnings };
}

/** 纪元 epoch 是否已经结束（可以组装了） */
export function epochOver(epoch, now) {
  return now >= (epoch + 1) * EPOCH;
}
