// l2Block(epoch) 的规范定义（docs/03-INTERFACES.md §1.3 / docs/01-CONTRACT-SPEC.md §6.2）。
// 三处实现（relayer / @bac/agent-sdk / @bac/node-cli）必须字节级一致：
//
//   l2Block(epoch)     = 时间戳 < (epoch + 1) * 86400 的最大层内区块号
//   l2BlockHash(epoch) = 该区块的哈希
//   聚合区间           = (l2Block(epoch-1), l2Block(epoch)]      ← 不用墙钟、不用时间戳筛日志
//
// 绝不能用「中继提交时的 head」：见证人必须在锚点发布之前就把 l2Block/l2BlockHash 封进承诺里，
// 猜一个未来的区块号等于让所有诚实见证人被计入 disputingWeight（attack-funds #5）。

import { EPOCH } from './constants.mjs';
import { NotDeterminedError, BacError } from './util.mjs';

/** 内部：读区块头，返回 {number, hash, timestamp} */
async function head(rpc) {
  const b = await rpc.getBlock('latest', false);
  if (!b) throw new BacError('层内 RPC 没有返回最新区块', 'rpc_error');
  return { number: Number(BigInt(b.number)), hash: b.hash, timestamp: Number(BigInt(b.timestamp)) };
}

async function at(rpc, n) {
  const b = await rpc.getBlock(n, false);
  if (!b) throw new BacError(`层内 RPC 读不到区块 #${n}`, 'rpc_error');
  return { number: Number(BigInt(b.number)), hash: b.hash, timestamp: Number(BigInt(b.timestamp)) };
}

/**
 * 规范的 l2Block(epoch)。
 * **头部时间戳还没越过纪元边界时抛 NotDeterminedError**：那时候「最大的那个块」还没出现，
 * 现在算出来的值随时会变，承诺一个会变的值就是自造异议。宁可停，不可错。
 * @returns {Promise<{number:number, hash:string, timestamp:number}>}
 */
export async function l2BlockFor(rpc, epoch) {
  const boundary = (Number(epoch) + 1) * EPOCH;    // 严格小于这个时间戳
  const h = await head(rpc);
  if (h.timestamp < boundary) {
    throw new NotDeterminedError(
      `纪元 ${epoch} 还没结束：本地头部 #${h.number} 的时间戳 ${h.timestamp} < 边界 ${boundary}。`
      + ' 必须等到本地节点出现一个时间戳 >= 边界的区块才能确定 l2Block（否则承诺的值随后会变）。'
    );
  }
  const g = await at(rpc, 0);
  if (g.timestamp >= boundary) {
    throw new NotDeterminedError(`纪元 ${epoch} 早于创世区块的时间戳 ${g.timestamp}，这条链那时还不存在`);
  }
  // 二分：找最大的 n 使 ts(n) < boundary
  let lo = 0, hi = h.number, best = g;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = await at(rpc, mid);
    if (b.timestamp < boundary) { best = b; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best;
}

/**
 * 聚合区间 (l2Block(epoch-1), l2Block(epoch)]，返回 {from, to} 都是**包含**的区块号。
 * 空纪元（长时间停机）：l2Block(epoch) == l2Block(epoch-1)，此时 from > to，表示区间为空。
 * 第一个纪元（上一纪元早于创世）：from = 0，即从创世块开始（含）。
 */
export async function rangeFor(rpc, epoch) {
  const to = await l2BlockFor(rpc, epoch);
  let prev = null;
  try {
    prev = await l2BlockFor(rpc, Number(epoch) - 1);
  } catch (e) {
    if (e instanceof NotDeterminedError) prev = null;   // 上一纪元早于创世
    else throw e;
  }
  const from = prev ? prev.number + 1 : 0;
  return { from, to: to.number, toHash: to.hash, toTimestamp: to.timestamp, empty: from > to.number };
}

/** 纪元边界的三个时间点，纯函数，测试友好 */
export function epochTimeline(epoch, commitWindow, challengeWindow) {
  const end = (Number(epoch) + 1) * EPOCH;
  return {
    start: Number(epoch) * EPOCH,
    end,
    commitDeadline: end + commitWindow,      // 合约是严格小于：block.timestamp < commitDeadline
    earliestAnchor: end + commitWindow,      // postAnchor 的第 4 条：>= 这个时刻才允许发
    challengeWindow,
  };
}
