// 求解器工作线程。只做一件事：收到 {seed, target, budget, start} 就算，算出来就回传。
// 用 node:worker_threads（标准库），不引入任何依赖。
//
// 中止靠 workerData 里那块共享内存：主线程把「当前 jobId」写进 flags[0]，
// 谁先出解主线程就改掉它，其它线程在下一个 2048 次哈希的检查点就停手。
// 没有这条，一次求解之后 7 个线程还会各自把预算跑满，下一轮就没有空闲线程了
// （实测：少了这一步，三轮挑战的等效算力只有单线程的 1.3 倍）。

import { parentPort, workerData } from "node:worker_threads";
import { getBytesFromHex } from "./hex.js";
import { solveNonceWithStats } from "./keccak.js";

interface Job {
  seedHex: string;
  targetHex: string;
  budgetMs: number;
  startHex: string;
  jobId: number;
}

const flags = new Int32Array((workerData as { sab: SharedArrayBuffer }).sab);

parentPort?.on("message", (job: Job) => {
  const stop = (): boolean => Atomics.load(flags, 0) !== job.jobId;
  const { result, hashes, ms } = solveNonceWithStats(
    getBytesFromHex(job.seedHex),
    BigInt(job.targetHex),
    job.budgetMs,
    BigInt(job.startHex),
    stop,
  );
  parentPort?.postMessage(
    result === null
      ? { jobId: job.jobId, found: false, hashes, ms }
      : { jobId: job.jobId, found: true, nonceHex: "0x" + result.nonce.toString(16), ms, hashes },
  );
});
