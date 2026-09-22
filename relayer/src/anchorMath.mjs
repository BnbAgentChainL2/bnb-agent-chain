// 锚点的规范算术（03-INTERFACES.md §1.3 / 01-CONTRACT-SPEC.md §6.2）。
// **三处实现必须字节级一致**：relayer / @bac/agent-sdk / @bac/node-cli。
// 规范定义（逐字）：
//   l2Block(epoch)     = 时间戳 < (epoch + 1) * 86400 的最大层内区块号
//   l2BlockHash(epoch) = 该区块的哈希
//   六个计数字段与 exitRoot 全部在区块区间 (l2Block(epoch-1), l2Block(epoch)] 上聚合
//   circulating        = 在 l2Block(epoch) 这个高度上读四个余额算，**不读 head**
// 绝不能用「提交时的 head」：见证人要在锚点发布之前就把 l2Block 封进承诺里，
// 让他们猜一个未来区块号 = 10 个诚实验证者全部计入 disputingWeight，第 3 个纪元停机。

import { COMMIT_WINDOW, EPOCH } from './constants.mjs';

/** 纪元 epoch 的结束时间戳（不含），即 (epoch+1)*86400 */
export function epochEndsAt(epoch) {
  return (epoch + 1) * EPOCH;
}

/** 承诺窗口的结束时间：锚点最早能发的时刻（01 §6.2 第 4 条） */
export function commitWindowEndsAt(epoch) {
  return epochEndsAt(epoch) + COMMIT_WINDOW;
}

/** 某个时间戳属于哪个纪元 */
export function epochOf(ts) {
  return Math.floor(ts / EPOCH);
}

/**
 * 规范 `l2Block(epoch)`：时间戳 < (epoch+1)*86400 的**最大**层内区块号。
 * 二分查找，只依赖 `getBlockNumber` 与 `getBlock(n)`，任何人都能独立复算。
 *
 * @param {{getBlockNumber:()=>Promise<number>, getBlock:(n:number)=>Promise<{number:number,hash:string,timestamp:number}>}} provider
 * @param {number} epoch
 * @returns {Promise<{number:number, hash:string, timestamp:number}|null>} 创世块都晚于该纪元时返回 null
 */
export async function l2BlockFor(provider, epoch) {
  const limit = epochEndsAt(epoch);
  const head = await provider.getBlockNumber();
  const headBlock = await provider.getBlock(head);
  if (headBlock && headBlock.timestamp < limit) return normalize(headBlock);

  const genesis = await provider.getBlock(0);
  if (!genesis || genesis.timestamp >= limit) return null; // 这条链在该纪元结束时还不存在

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

function normalize(b) {
  return { number: Number(b.number), hash: b.hash, timestamp: Number(b.timestamp) };
}

/**
 * 纪元 epoch 的聚合区间 `(l2Block(epoch-1), l2Block(epoch)]`。
 * 空纪元（长时间停机）会得到 from > to，调用方据此按「空纪元锚点」处理：
 * l2Block 等于上一纪元，exitCount = 0、exitRoot = 0、四个计数字段为 0（01 §6.2 允许）。
 */
export async function rangeFor(provider, epoch) {
  const cur = await l2BlockFor(provider, epoch);
  if (!cur) return null;
  const prev = await l2BlockFor(provider, epoch - 1);
  const from = prev ? prev.number + 1 : 0;
  return { from, to: cur.number, current: cur, previous: prev };
}

/**
 * 下一个该发的锚点（纯函数，方向 B 的排序纪律）。
 *
 * 顺序检查与 `postAnchor` 的链上检查一一对应（01 §6.2）：
 *   ① epoch == lastPostedEpoch + 1（不可跳号、不可重发）
 *   ② 该纪元必须已经结束（epoch < currentEpoch）
 *   ③ 上一个纪元已定案（FINAL / VETOED / DISPUTED），否则等
 *   ④ 已过承诺窗口 (epoch+1)*86400 + 2h
 *
 * @param {{lastPostedEpoch:number|null, firstEpoch:number, prevState:string, now:number}} s
 * @returns {{action:'post'|'wait', epoch:number, reason:string}}
 */
export function planNextAnchor(s) {
  const epoch = s.lastPostedEpoch === null || s.lastPostedEpoch < s.firstEpoch ? s.firstEpoch : s.lastPostedEpoch + 1;
  const currentEpoch = epochOf(s.now);

  if (epoch >= currentEpoch) {
    return { action: 'wait', epoch, reason: `纪元 ${epoch} 还没结束（当前 ${currentEpoch}）` };
  }
  const isFirst = epoch === s.firstEpoch;
  const resolved = ['FINAL', 'VETOED', 'DISPUTED'];
  if (!isFirst && !resolved.includes(s.prevState)) {
    return { action: 'wait', epoch, reason: `上一个纪元 ${epoch - 1} 尚未定案（当前 ${s.prevState}）` };
  }
  const opensAt = commitWindowEndsAt(epoch);
  if (s.now < opensAt) {
    return { action: 'wait', epoch, reason: `承诺窗口未结束，还需 ${opensAt - s.now}s` };
  }
  return { action: 'post', epoch, reason: '可以发' };
}

/**
 * 把被 VETOED / DISPUTED 的纪元并进本次锚点（03 §1.3 倒数第二段）。
 * 累计计数器只在 `finalize()` 里累加，所以那些纪元的三个计数字段与全部退出叶子必须重报。
 * **叶子本身一个字节都不变**（叶子里已经没有 epoch 字段），用户用新锚点的 anchorEpoch 就能证明。
 *
 * @param {{credited:bigint, exitCredits:bigint, feeBurned:bigint, leaves:object[]}} own 本纪元自己的部分
 * @param {Array<{epoch:number, payload:object}>} carried 被否决/异议的旧锚点
 */
export function mergeCarried(own, carried) {
  let credited = own.credited;
  let exitCredits = own.exitCredits;
  let feeBurned = own.feeBurned;
  const leaves = own.leaves.slice();
  const carriedEpochs = [];

  for (const c of carried) {
    const a = c.payload.anchor;
    credited += BigInt(a.creditedInEpoch);
    exitCredits += BigInt(a.exitCreditsInEpoch);
    feeBurned += BigInt(a.feeBurnedInEpoch);
    for (const l of c.payload.leaves) leaves.push(l);
    carriedEpochs.push(c.epoch);
  }
  return { credited, exitCredits, feeBurned, leaves, carriedEpochs };
}
