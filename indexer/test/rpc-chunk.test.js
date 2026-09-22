// test/rpc-chunk.test.js —— BSC 日志分片与退避。
// 公共 BSC RPC 对 eth_getLogs 限窗是实测事实（docs/research/09-chain-truth.md），
// 所以这组用例用一个假 RPC 把「被限窗 -> 砍半 -> 继续」这条路径跑出来，不碰网络。
import test from "node:test";
import assert from "node:assert/strict";
import { getLogsChunked, RpcError } from "../src/rpc.js";
import { resetWarnings, listWarnings } from "../src/warnings.js";

/** 一个假的 RPC：超过 maxSpan 的请求就按公共节点的口径返回 -32005。 */
function fakeRpc({ maxSpan = Infinity } = {}) {
  const calls = [];
  return {
    name: "fake",
    calls,
    async getLogs({ fromBlock, toBlock }) {
      const from = Number(BigInt(fromBlock));
      const to = Number(BigInt(toBlock));
      calls.push([from, to]);
      if (to - from + 1 > maxSpan) throw new RpcError(-32005, "limit exceeded", "eth_getLogs");
      return [{ blockNumber: "0x" + from.toString(16) }];
    },
  };
}

test("分片覆盖整个区间，不漏块不重叠", async () => {
  const rpc = fakeRpc();
  const seen = [];
  await getLogsChunked(rpc, {
    address: ["0x1"], from: 0, to: 2999, range: 1000, minRange: 100, maxRange: 5000,
    onChunk: async (_logs, f, t) => seen.push([f, t]),
  });
  assert.deepEqual(seen, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test("被限窗时把分片砍半重试，最终仍然覆盖整个区间", async () => {
  resetWarnings();
  const rpc = fakeRpc({ maxSpan: 300 });
  const seen = [];
  await getLogsChunked(rpc, {
    address: ["0x1"], from: 0, to: 999, range: 1000, minRange: 100, maxRange: 5000,
    onChunk: async (_logs, f, t) => seen.push([f, t]),
  });
  // 1000 -> 500 -> 250，成功的分片必须连续拼满 0..999
  assert.equal(seen[0][0], 0);
  assert.equal(seen[seen.length - 1][1], 999);
  for (let i = 1; i < seen.length; i++) assert.equal(seen[i][0], seen[i - 1][1] + 1);
  assert.ok(seen.every(([f, t]) => t - f + 1 <= 300));
});

test("每一片处理完都回调一次，调用方可以在这里推游标（可恢复）", async () => {
  const rpc = fakeRpc();
  const cursor = { v: -1 };
  await getLogsChunked(rpc, {
    address: ["0x1"], from: 100, to: 399, range: 100, minRange: 100, maxRange: 5000,
    onChunk: async (_logs, _f, t) => {
      cursor.v = t;
    },
  });
  assert.equal(cursor.v, 399);
});

test("onChunk 抛错时游标停在上一片，不会跳过日志", async () => {
  const rpc = fakeRpc();
  let cursor = -1;
  await assert.rejects(
    getLogsChunked(rpc, {
      address: ["0x1"], from: 0, to: 299, range: 100, minRange: 100, maxRange: 5000,
      onChunk: async (_logs, _f, t) => {
        if (t > 199) throw new Error("落盘失败");
        cursor = t;
      },
    }),
    /落盘失败/
  );
  assert.equal(cursor, 199);
});

test("连续成功之后分片会放大，但不超过 maxRange", async () => {
  const rpc = fakeRpc();
  await getLogsChunked(rpc, {
    address: ["0x1"], from: 0, to: 20000, range: 1000, minRange: 100, maxRange: 2000,
    onChunk: async () => {},
  });
  const spans = rpc.calls.map(([f, t]) => t - f + 1);
  assert.ok(Math.max(...spans) <= 2000, "分片超过了 maxRange");
  assert.ok(Math.max(...spans) > 1000, "连续成功之后应该放大过");
});

test("非限窗错误直接抛出，不当成限窗吞掉", async () => {
  const rpc = {
    name: "fake",
    async getLogs() {
      throw new RpcError(-32603, "internal", "eth_getLogs");
    },
  };
  await assert.rejects(
    getLogsChunked(rpc, { address: ["0x1"], from: 0, to: 10, range: 10, onChunk: async () => {} }),
    /eth_getLogs 失败/
  );
});

test("被限窗必须留下告警（限速不许静默）", async () => {
  resetWarnings();
  const rpc = fakeRpc({ maxSpan: 50 });
  await getLogsChunked(rpc, {
    address: ["0x1"], from: 0, to: 199, range: 100, minRange: 25, maxRange: 5000,
    onChunk: async () => {},
  });
  assert.ok(rpc.calls.length > 1, "应该重试过");
});
