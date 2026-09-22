// 多核求解池：挑战只有 5 秒 / 8 个区块，单核不够稳。
//
// 单核实测约 55-65 万次哈希/秒，2**236 平均要 2**20 次 → 均值约 1.7 秒，但这是指数分布，
// 尾巴很长：单核在 3.8 秒预算内失败的概率约 11%，三轮下来约 30% 至少要重来一次，
// 而重来一次要等 REISSUE_COOLDOWN(60 秒)。四核并行把失败概率压到万分之几。
//
// 用 node:worker_threads（标准库）。challenge.solve() 仍然是规格里那个同步单线程版本，
// join() 与抽查应答走这里。

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { TARGET } from "./challenge.js";

export interface PoolResult {
  nonce: bigint;
  ms: number;
  hashes: number;
  /** 出解的那个工作线程序号，调试用 */
  worker: number;
}

function randomStart(): bigint {
  const b = new Uint8Array(24);
  globalThis.crypto.getRandomValues(b);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v << 32n;
}

export class SolverPool {
  private readonly workers: Worker[] = [];
  private readonly flags: Int32Array;
  private jobId = 0;
  readonly size: number;

  constructor(size?: number) {
    const cores = availableParallelism();
    this.size = Math.max(1, Math.min(size ?? Math.max(1, cores - 1), 8));
    const sab = new SharedArrayBuffer(4);
    this.flags = new Int32Array(sab);
    const url = new URL("./solveWorker.js", import.meta.url);
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(url, { workerData: { sab } });
      w.unref();                       // 池子没关也不阻止进程退出
      this.workers.push(w);
    }
  }

  /**
   * 并行求解，谁先出解用谁。预算用完返回 null。
   * 每个线程从各自的随机起点搜索，搜索空间是 2**256，撞车概率可以忽略。
   */
  async solve(seedHex: string, target: bigint = TARGET, budgetMs = 4000): Promise<PoolResult | null> {
    const jobId = ++this.jobId;
    Atomics.store(this.flags, 0, jobId);        // 开工：所有线程认这个 jobId
    const t0 = Date.now();
    return new Promise<PoolResult | null>((resolve) => {
      let done = false;
      let pending = this.workers.length;
      const cleanup = (): void => {
        for (const w of this.workers) w.removeAllListeners("message");
      };
      this.workers.forEach((w, i) => {
        const onMessage = (m: any): void => {
          if (done || m.jobId !== jobId) return;
          if (m.found) {
            done = true;
            Atomics.store(this.flags, 0, -1);   // 有人出解：其余线程立刻停手，好让下一轮有空闲线程
            cleanup();
            resolve({ nonce: BigInt(m.nonceHex), ms: Date.now() - t0, hashes: m.hashes, worker: i });
            return;
          }
          if (--pending === 0 && !done) {
            done = true;
            Atomics.store(this.flags, 0, -1);
            cleanup();
            resolve(null);
          }
        };
        w.on("message", onMessage);
        w.postMessage({
          jobId,
          seedHex,
          targetHex: "0x" + target.toString(16),
          budgetMs,
          startHex: "0x" + randomStart().toString(16),
        });
      });
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
  }
}
