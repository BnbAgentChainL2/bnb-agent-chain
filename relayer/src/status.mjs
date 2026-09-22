// 导出给索引器去服务的状态对象：形状照 03-INTERFACES.md §3.1 的 `/api/health`。
// 中继只负责 `relayer`、`reconcile`、`anchorCommitWindowEndsAt` 与 `warnings` 这几块；
// `layer` / `bridge` / `vault` / `indexer` 由索引器自己填，合并后就是 `/api/health` 的响应。

import { BALANCE_FLOOR, OUTBOX_STATUS, WARN } from './constants.mjs';
import { commitWindowEndsAt, epochOf } from './anchorMath.mjs';
import { countByStatus, getCursor, rowsWithStatus } from './db.mjs';

/**
 * `reconcile.howToCheck` **必须原样返回**（03 §3.1）：任何人用这七条 cast 就能自己复算 diff，
 * 不需要相信我们算好的那个布尔值。决策 #17 之后多了 FeeSplitter 与逐个验证者余额两条。
 */
export function howToCheck(cfg, bscRpc = 'https://bsc-rpc.publicnode.com', layerRpc = 'https://95-179-183-132.sslip.io/rpc') {
  return [
    `cast call ${cfg.addresses.bacBridge} "totalCreditsIssued()(uint256)" --rpc-url ${bscRpc}`,
    `cast call ${cfg.addresses.bacBridge} "totalCreditsExited()(uint256)" --rpc-url ${bscRpc}`,
    `cast balance ${cfg.addresses.l2Bridge} --rpc-url ${layerRpc}`,
    `cast balance ${cfg.addresses.feeSink} --rpc-url ${layerRpc}`,
    `cast balance ${cfg.addresses.feeSplitter} --rpc-url ${layerRpc}`,
    `cast rpc qbft_getValidatorsByBlockNumber latest --rpc-url ${layerRpc}`,
    `cast balance <每一个历史出现过的 validator 地址> --rpc-url ${layerRpc}`,
  ];
}

/**
 * 对账（03 §3.1，公式只能是这一个，否则它结构上永远不为 0）：
 *   diff = (bscTotalIssued − bscTotalExited)
 *        − (layerCirculating + feeSinkBalance + feeSplitterBalance + Σ validatorBalances)
 * 其中 layerCirculating = 1e27 − B_bridge − B_sink − B_splitter − Σ B_validator（03 §1.3）。
 * 累计的发布费（进 FeeSink）、已归集未领走的 gas 费（停在 FeeSplitter）、
 * 落在出块者 EOA 里的 gas 费会把 layerCirculating 持续拉低，所以必须把这三项**加回来**，
 * diff 才恒为 0；旧写法（只加 feeSink + 单个 signer）从第一笔归集起就单调发散。
 */
export function reconcileDiff({
  bscTotalIssued,
  bscTotalExited,
  layerCirculating,
  feeSinkBalance,
  feeSplitterBalance = 0n,
  validatorBalances = [],
}) {
  const vSum = validatorBalances.reduce((a, v) => a + BigInt(v.balance), 0n);
  return (
    BigInt(bscTotalIssued) -
    BigInt(bscTotalExited) -
    (BigInt(layerCirculating) + BigInt(feeSinkBalance) + BigInt(feeSplitterBalance) + vSum)
  );
}

/**
 * 纯函数：把已经读好的数字拼成 `/api/health` 的中继部分。
 * 单元测试直接打它，不需要网络。
 */
export function composeStatus(parts) {
  const {
    now,
    cfg,
    lastPostedEpoch,
    bscCursor,
    bscHead,
    layerCursor,
    outboxNew,
    outboxSent,
    outboxOrphaned,
    outboxParked,
    bscKeyBalance,
    layerKeyBalance,
    reconcile,
    pendingCredits = [],
    warnings = [],
  } = parts;

  const currentEpoch = epochOf(now);
  const diff = reconcileDiff(reconcile);
  const w = new Set(warnings);

  if (diff !== 0n) w.add(WARN.RECONCILE_MISMATCH);
  if (BigInt(bscKeyBalance) < BALANCE_FLOOR.BSC_WEI || BigInt(layerKeyBalance) < BALANCE_FLOOR.LAYER_WEI) {
    w.add(WARN.RELAYER_BALANCE_LOW);
  }
  // 锚点逾期：上一个纪元过了承诺窗口还没发出去（02 §5.4 的「锚点超 epochEnd + 2h 未发」）
  const nextEpoch = lastPostedEpoch === null ? cfg.start.firstEpoch : lastPostedEpoch + 1;
  if (nextEpoch < currentEpoch && now > commitWindowEndsAt(nextEpoch)) w.add(WARN.ANCHOR_OVERDUE);
  if (outboxParked > 0) w.add(WARN.OUTBOX_PARKED);

  return {
    schema: 'bac/health/1',
    now,
    relayer: {
      lastPostedEpoch,
      currentEpoch,
      epochLag: lastPostedEpoch === null ? null : currentEpoch - lastPostedEpoch,
      bscCursor,
      bscLagBlocks: bscHead === null || bscCursor === null ? null : bscHead - bscCursor,
      layerCursor,
      outboxNew,
      outboxSent,
      outboxOrphaned,
      bscKeyBalance: BigInt(bscKeyBalance).toString(),
      layerKeyBalance: BigInt(layerKeyBalance).toString(),
    },
    reconcile: {
      bscTotalIssued: BigInt(reconcile.bscTotalIssued).toString(),
      bscTotalExited: BigInt(reconcile.bscTotalExited).toString(),
      layerCirculating: BigInt(reconcile.layerCirculating).toString(),
      feeSinkBalance: BigInt(reconcile.feeSinkBalance).toString(),
      feeSplitterBalance: BigInt(reconcile.feeSplitterBalance ?? 0n).toString(),
      validatorBalances: (reconcile.validatorBalances ?? []).map((v) => ({
        addr: v.addr,
        balance: BigInt(v.balance).toString(),
      })),
      formula:
        'diff = (bscTotalIssued - bscTotalExited) - (layerCirculating + feeSinkBalance + feeSplitterBalance + sum(validatorBalances))',
      diff: diff.toString(),
      ok: diff === 0n,
      howToCheck: howToCheck(cfg),
    },
    // 下一个该发的锚点的承诺窗口结束时间（合约写死，中继压不了它）
    anchorCommitWindowEndsAt: commitWindowEndsAt(nextEpoch),
    // 03 §1.2：CreditJob 就是这里每个元素的形状
    pendingCredits,
    warnings: [...w],
  };
}

/**
 * 真去读链，拼出上面的对象。索引器每次 `/api/health` 调一次即可。
 * @param {{db:object, bsc:object, layer:object, cfg:object, now:()=>number, warnings:Set<string>}} ctx
 */
export async function buildStatus(ctx) {
  const { db, bsc, layer, cfg } = ctx;
  const now = ctx.now();

  const [lastPostedEpochRaw, bscHead, issuedExited, bscKeyBalance, layerKeyBalance] = await Promise.all([
    bsc.lastPostedEpoch(),
    bsc.getBlockNumber(),
    bsc.reconcileReads(),
    bsc.balance(bsc.address),
    layer.balance(layer.address),
  ]);
  // everValidator：QBFT 下验证者集可变，按累积表逐个读（03 §1.3）。
  const everValidator = cfg.validators && cfg.validators.length ? cfg.validators : [cfg.addresses.layerSigner];
  const [bBridge, bSink, bSplitter, ...bValidators] = await Promise.all([
    layer.balance(cfg.addresses.l2Bridge),
    layer.balance(cfg.addresses.feeSink),
    layer.balance(cfg.addresses.feeSplitter),
    ...everValidator.map((v) => layer.balance(v)),
  ]);
  const validatorBalances = everValidator.map((addrOne, i) => ({
    addr: addrOne,
    balance: BigInt(bValidators[i] ?? 0n).toString(),
  }));
  const vSum = validatorBalances.reduce((a, v) => a + BigInt(v.balance), 0n);
  const LAYER_TOTAL = 1000000000000000000000000000n;
  const layerCirculating = LAYER_TOTAL - BigInt(bBridge) - BigInt(bSink) - BigInt(bSplitter) - vSum;

  const pendingCredits = rowsWithStatus(db, OUTBOX_STATUS.NEW)
    .concat(rowsWithStatus(db, OUTBOX_STATUS.SENT))
    .map((r) => JSON.parse(r.payload))
    .filter((p) => p.kind === 'credit');

  return composeStatus({
    now,
    cfg,
    lastPostedEpoch: Number(lastPostedEpochRaw) === 0 ? null : Number(lastPostedEpochRaw),
    bscCursor: getCursor(db, 'bsc'),
    bscHead,
    layerCursor: getCursor(db, 'layer'),
    outboxNew: countByStatus(db, OUTBOX_STATUS.NEW),
    outboxSent: countByStatus(db, OUTBOX_STATUS.SENT),
    outboxOrphaned: countByStatus(db, OUTBOX_STATUS.ORPHANED),
    outboxParked: countByStatus(db, OUTBOX_STATUS.PARKED),
    bscKeyBalance,
    layerKeyBalance,
    reconcile: {
      bscTotalIssued: issuedExited.issued,
      bscTotalExited: issuedExited.exited,
      layerCirculating,
      feeSinkBalance: bSink,
      feeSplitterBalance: bSplitter,
      validatorBalances,
    },
    pendingCredits,
    warnings: [...ctx.warnings],
  });
}
