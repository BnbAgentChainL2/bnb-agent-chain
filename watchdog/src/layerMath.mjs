// 锚点的规范算术，**看门狗自己的一份**（与中继的实现分开写，理由见 src/ids.mjs 的文件头）。
// 规范：docs/03-INTERFACES.md §1.3 / docs/01-CONTRACT-SPEC.md §6.2。
//   l2Block(epoch)     = 时间戳 < (epoch + 1) * EPOCH 的最大层内区块号
//   l2BlockHash(epoch) = 该区块的哈希
//   六个计数字段与 exitRoot 全部在区间 (l2Block(epoch-1), l2Block(epoch)] 上聚合
//
// 注意 EPOCH 现在是 **600 秒**（决策 #20），不是 86400。这份文件里没有第二个纪元长度常量，
// 它只从 src/constants.mjs 读一次，而启动自检会把它和链上的 `ChainAnchor.EPOCH()` 对上。

import { EPOCH } from './constants.mjs';

/** 纪元 epoch 的结束时间戳（不含） */
export function epochEndsAt(epoch) {
  return (epoch + 1) * EPOCH;
}

/** 某个时间戳属于哪个纪元 */
export function epochOf(ts) {
  return Math.floor(ts / EPOCH);
}

function normalize(b) {
  return { number: Number(b.number), hash: b.hash, timestamp: Number(b.timestamp) };
}

/**
 * 规范 `l2Block(epoch)`：二分查找，只依赖 `getBlockNumber` 与 `getBlock(n)`。
 * 任何人都能用同样两个 RPC 方法复算 —— 这正是「独立于中继」的含义。
 * @returns {Promise<{number:number,hash:string,timestamp:number}|null>} 链在该纪元结束时还不存在则 null
 */
export async function l2BlockFor(provider, epoch) {
  const limit = epochEndsAt(epoch);
  const head = await provider.getBlockNumber();
  const headBlock = await provider.getBlock(head);
  if (headBlock && headBlock.timestamp < limit) return normalize(headBlock);

  const genesis = await provider.getBlock(0);
  if (!genesis || genesis.timestamp >= limit) return null;

  // 不变式：lo 的时间戳 < limit，hi 的时间戳 >= limit
  let lo = 0;
  let hi = head;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await provider.getBlock(mid);
    if (b.timestamp < limit) lo = mid;
    else hi = mid;
  }
  return normalize(await provider.getBlock(lo));
}

/**
 * 纪元 epoch 的聚合区间 `(l2Block(epoch-1), l2Block(epoch)]`。
 * 空纪元（层内停过块）会得到 from > to：那是**合法**的锚点形状（exitCount = 0、
 * exitRoot = 0、l2Block 等于上一纪元），不是异常，规则里必须这么判。
 */
export async function rangeFor(provider, epoch) {
  const cur = await l2BlockFor(provider, epoch);
  if (!cur) return null;
  const prev = await l2BlockFor(provider, epoch - 1);
  const from = prev ? prev.number + 1 : 0;
  return { from, to: cur.number, current: cur, previous: prev, empty: from > cur.number };
}
