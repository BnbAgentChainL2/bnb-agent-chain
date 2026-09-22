// l2Block(epoch) 的规范口径：relayer / SDK / node-cli 三处必须字节级一致。
// 这里用一条假链（3 秒一个块）做对拍，并覆盖空纪元与越界。

import test from "node:test";
import assert from "node:assert/strict";
import { anchorMath } from "../dist/index.js";

const EPOCH = 86400;

/** 一条 period=3 的假链：block n 的时间戳 = start + 3n。 */
function fakeChain(start, head, period = 3) {
  return {
    async getBlockNumber() { return head; },
    async getBlock(n) {
      const num = n === "latest" ? head : Number(n);
      if (num > head || num < 0) return null;
      return { number: num, hash: "0x" + num.toString(16).padStart(64, "0"), timestamp: start + period * num };
    },
  };
}

/** 朴素定义的参考实现：线性扫，慢但肯定对。 */
async function naive(chain, epoch) {
  const limit = (epoch + 1) * EPOCH;
  const head = await chain.getBlockNumber();
  let best = -1;
  for (let n = 0; n <= head; n++) {
    const b = await chain.getBlock(n);
    if (b.timestamp < limit) best = n; else break;
  }
  return best;
}

test("二分查找与朴素定义在多组纪元上一致", async () => {
  const start = 20718 * EPOCH + 17;          // 创世落在纪元 20718 内
  const chain = fakeChain(start, 60000);     // 60000 块 ≈ 2.08 天
  for (const epoch of [20718, 20719, 20720]) {
    const got = await anchorMath.l2BlockFor(chain, epoch);
    const want = await naive(chain, epoch);
    assert.equal(got.number, want, `epoch ${epoch}`);
    assert.equal(got.hash, "0x" + want.toString(16).padStart(64, "0"));
  }
});

test("纪元还没走完时 l2Block 就是 head", async () => {
  const start = 20718 * EPOCH;
  const chain = fakeChain(start, 100);       // 只有 300 秒
  const got = await anchorMath.l2BlockFor(chain, 20718);
  assert.equal(got.number, 100);
});

test("rangeFor 给出 (l2Block(e-1), l2Block(e)]", async () => {
  const start = 20718 * EPOCH;
  const chain = fakeChain(start, 60000);
  const r = await anchorMath.rangeFor(chain, 20719);
  const prev = await anchorMath.l2BlockFor(chain, 20718);
  const cur = await anchorMath.l2BlockFor(chain, 20719);
  assert.deepEqual(r, { from: prev.number, to: cur.number });
  assert.ok(r.to > r.from);
});

test("空纪元：长时间停机时 l2Block(e) == l2Block(e-1)", async () => {
  // 链在纪元 20718 的第 300 秒停了，之后再也没有块
  const chain = fakeChain(20718 * EPOCH, 100);
  assert.equal(await anchorMath.isEmptyEpoch(chain, 20719), true);
  const a = await anchorMath.l2BlockFor(chain, 20719);
  const b = await anchorMath.l2BlockFor(chain, 20718);
  assert.equal(a.number, b.number);
});

test("纪元早于创世：报错而不是返回 0（宁可停，不可错）", async () => {
  const chain = fakeChain(20718 * EPOCH, 1000);
  await assert.rejects(() => anchorMath.l2BlockFor(chain, 20700), (e) => e.code === "unknown_state");
});

test("读不到区块就报错，不拿 null 往下算", async () => {
  const broken = {
    async getBlockNumber() { return 100; },
    async getBlock() { return null; },
  };
  await assert.rejects(() => anchorMath.l2BlockFor(broken, 20718), (e) => e.code === "unknown_state");
});

test("epochOf 与 floor(ts / 86400) 一致", () => {
  assert.equal(anchorMath.epochOf(1790000000), Math.floor(1790000000 / 86400));
  assert.equal(anchorMath.EPOCH_SECONDS, 86400);
});
