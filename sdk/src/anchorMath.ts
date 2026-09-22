// 锚点的区块口径（03 §1.3）。relayer / SDK / node-cli 三处必须**字节级一致**。
//
//   l2Block(epoch)     = 时间戳 < (epoch + 1) * 86400 的最大层内区块号
//   l2BlockHash(epoch) = 该区块的哈希
//   聚合区间           = (l2Block(epoch-1), l2Block(epoch)]   —— 用区块号，不用墙钟、不用时间戳筛日志
//
// 不能用「提交时的 head」：见证人必须在锚点发布之前就能独立算出同一个值，
// 否则诚实验证者会被全部计入 disputingWeight，第 3 个纪元就触发停机条件。

import { BacUnknownStateError } from "./errors.js";

export const EPOCH_SECONDS = 86400;

/** 任何能 getBlock(number) 的东西：ethers 的 Provider，或测试里的假 provider。 */
export interface BlockReader {
  getBlockNumber(): Promise<number>;
  getBlock(n: number | string): Promise<{ number: number; hash: string | null; timestamp: number } | null>;
}

export function epochOf(tsSeconds: number): number {
  return Math.floor(tsSeconds / EPOCH_SECONDS);
}

async function blockAt(p: BlockReader, n: number): Promise<{ number: number; hash: string; timestamp: number }> {
  const b = await p.getBlock(n);
  if (!b || b.hash == null) {
    throw new BacUnknownStateError(
      `读不到层内区块 ${n}（或它没有哈希）`,
      "换一个层内 RPC 再试。算不出 l2Block 就不要往下走：口径不一致会让见证人把诚实锚点判成异议。",
    );
  }
  return { number: b.number, hash: b.hash, timestamp: b.timestamp };
}

/** l2Block(epoch)：时间戳 < (epoch+1) * 86400 的最大区块号，二分查找。 */
export async function l2BlockFor(provider: any, epoch: number): Promise<{ number: number; hash: string }> {
  const p = provider as BlockReader;
  const limit = (epoch + 1) * EPOCH_SECONDS;

  const genesis = await blockAt(p, 0);
  if (genesis.timestamp >= limit) {
    throw new BacUnknownStateError(
      `纪元 ${epoch} 早于创世块（创世时间戳 ${genesis.timestamp} >= ${limit}）`,
      "这个纪元在这条链存在之前，没有对应的 l2Block。检查纪元号是不是算错了。",
    );
  }

  const head = await blockAt(p, await p.getBlockNumber());
  if (head.timestamp < limit) return { number: head.number, hash: head.hash };

  // 不变式：lo 的时间戳 < limit，hi 的时间戳 >= limit
  let lo = 0, hi = head.number;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const b = await blockAt(p, mid);
    if (b.timestamp < limit) lo = mid;
    else hi = mid;
  }
  const found = await blockAt(p, lo);
  return { number: found.number, hash: found.hash };
}

/** 聚合区间 (from, to]：from = l2Block(epoch-1)，to = l2Block(epoch)。 */
export async function rangeFor(provider: any, epoch: number): Promise<{ from: number; to: number }> {
  const prev = await l2BlockFor(provider, epoch - 1);
  const cur = await l2BlockFor(provider, epoch);
  return { from: prev.number, to: cur.number };
}

/** 空纪元（长时间停机）：l2Block(epoch) == l2Block(epoch-1)，exitCount = 0、exitRoot = 0。 */
export async function isEmptyEpoch(provider: any, epoch: number): Promise<boolean> {
  const { from, to } = await rangeFor(provider, epoch);
  return from === to;
}
