// 自己算一个纪元的三元组 (exitRoot, l2BlockHash, l2Block)。
// 这是见证人存在的全部意义：数据不是从官方 API 抄来的，是从**你自己的全节点**上算出来的。

import { l2BlockFor, rangeFor } from './anchor-math.mjs';
import { fromLogs, root, EXIT_BURNED_TOPIC, ZERO_ROOT } from './exit-tree.mjs';
import { LAYER_CHAIN_ID, L2_BRIDGE } from './constants.mjs';
import { BacError } from './util.mjs';

/**
 * @param {import('./rpc.mjs').Rpc} rpc   本地层内节点
 * @param {number} epoch
 * @param {{bscBridge: string, l2Bridge?: string, logChunk?: number}} opts
 * @returns {Promise<{epoch:number, l2Block:number, l2BlockHash:string, exitRoot:string,
 *                    leaves:Array, from:number, to:number, empty:boolean}>}
 */
export async function computeEpoch(rpc, epoch, opts) {
  if (!opts || !opts.bscBridge) {
    throw new BacError(
      'addresses.bscBridge（BSC 上的 BacBridge）没配：叶子哈希里有它，算不出正确的 exitRoot', 'bad_config');
  }
  const l2Bridge = opts.l2Bridge || L2_BRIDGE;
  const tip = await l2BlockFor(rpc, epoch);          // 不确定时会抛 NotDeterminedError，绝不猜
  const range = await rangeFor(rpc, epoch);

  let leaves = [];
  if (!range.empty) {
    const chunk = opts.logChunk || 5000;             // 节点自己也有 rpc-max-logs-range=5000 的上限
    const logs = [];
    for (let from = range.from; from <= range.to; from += chunk) {
      const to = Math.min(from + chunk - 1, range.to);
      const part = await rpc.getLogs({
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        address: l2Bridge,
        topics: [EXIT_BURNED_TOPIC],
      });
      logs.push(...part);
    }
    // 分桶以事件里的 epoch 字段为准，别无他解（03 §1.3）。
    // 区间本来就按规范切过一次，这里再按事件字段过滤一次，两条规则互相兜底。
    leaves = fromLogs(logs, epoch);
  }

  const exitRoot = leaves.length ? root(leaves, LAYER_CHAIN_ID, opts.bscBridge) : ZERO_ROOT;
  return {
    epoch: Number(epoch),
    l2Block: tip.number,
    l2BlockHash: tip.hash,
    exitRoot,
    leaves,
    from: range.from,
    to: range.to,
    empty: range.empty,
  };
}
