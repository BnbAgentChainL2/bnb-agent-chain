// src/ingest.js —— 两条链的摄入循环。
// 纪律（03 §2 的索引作业纪律）：
//   - 层内走我们自己的节点，每 3 秒全量拉一个区块（交易 + 收据 + 日志），日志完整没有窗口限制；
//   - BSC 走公共 RPC，eth_getLogs 分片 ≤ 3000 块、轮询 15 秒、被限窗就砍半重试；
//   - 游标每处理完一片就落盘，重启从游标接着跑，且所有写入是 upsert —— 重启不会重复行。
import { Rpc, getLogsChunked, sleep } from "./rpc.js";
import { getCursor, setCursor } from "./db.js";
import { ingestLogs, ingestLayerBlock, markAnchored, anchoredThrough } from "./store.js";
import { addressBook } from "./config.js";
import { warn, clearWarning } from "./warnings.js";
import { LAYER_SYSTEM_ADDRESSES } from "./abi.js";

/** 块时间戳缓存，避免同一片里对同一个块反复 eth_getBlockByNumber。 */
export class TsCache {
  constructor(rpc, db, chain) {
    this.rpc = rpc;
    this.db = db;
    this.chain = chain;
    this.map = new Map();
  }
  async warm(numbers) {
    for (const n of numbers) {
      if (this.map.has(n)) continue;
      if (this.chain === "layer") {
        const row = this.db.prepare("SELECT ts FROM blocks WHERE number = ?").get(n);
        if (row) {
          this.map.set(n, Number(row.ts));
          continue;
        }
      }
      const b = await this.rpc.getBlockByNumber(n, false);
      this.map.set(n, b ? Number(BigInt(b.timestamp)) : 0);
    }
  }
  get(n) {
    return this.map.get(n) ?? 0;
  }
}

/** BSC 侧一轮摄入。返回处理到哪个块。 */
export async function bscTick(db, cfg, rpc) {
  const book = addressBook(cfg);
  const addresses = Object.entries(cfg.addresses)
    .filter(([, v]) => !!v)
    .map(([, v]) => v);
  if (addresses.length === 0) {
    warn("bsc_addresses_unset", "没有配置任何 BSC 合约地址，BSC 侧不摄入");
    return null;
  }
  clearWarning("bsc_addresses_unset");

  const head = await rpc.blockNumber();
  const safeHead = head - cfg.bscConfirmations;
  const cur = getCursor(db, "bsc");
  const from = cur === null ? cfg.bscStartBlock : cur + 1;
  if (from > safeHead) return cur;

  const ts = new TsCache(rpc, db, "bsc");
  await getLogsChunked(rpc, {
    address: addresses,
    from,
    to: safeHead,
    range: cfg.bscLogRange,
    minRange: cfg.bscLogRangeMin,
    maxRange: cfg.bscLogRangeMax,
    onChunk: async (logs, chunkFrom, chunkTo) => {
      const nums = [...new Set(logs.map((l) => Number(BigInt(l.blockNumber))))];
      await ts.warm(nums);
      ingestLogs(db, {
        chain: "bsc",
        logs: logs.map(normalizeLog),
        cfg,
        addressBook: book,
        tsOf: (n) => ts.get(n),
      });
      // 先落数据、再推游标：顺序反过来就会在崩溃时漏掉一整片日志。
      setCursor(db, "bsc", chunkTo);
    },
  });
  const through = anchoredThrough(db);
  if (through > 0) markAnchored(db, through);
  return safeHead;
}

/** 层内一轮摄入：从游标到 head，逐块拉全量交易 + 收据 + 日志。 */
export async function layerTick(db, cfg, rpc, { maxBlocks = 200 } = {}) {
  const book = addressBook(cfg);
  const head = await rpc.blockNumber();
  const cur = getCursor(db, "layer");
  const from = cur === null ? cfg.layerStartBlock : cur + 1;
  if (from > head) return cur;
  const to = Math.min(head, from + maxBlocks - 1);

  for (let n = from; n <= to; n++) {
    const raw = await rpc.getBlockByNumber(n, true);
    if (!raw) {
      warn("layer_block_missing", `层内区块 ${n} 取不到`);
      break;
    }
    const block = {
      number: Number(BigInt(raw.number)),
      hash: raw.hash,
      parentHash: raw.parentHash,
      timestamp: Number(BigInt(raw.timestamp)),
      gasUsed: Number(BigInt(raw.gasUsed)),
      gasLimit: Number(BigInt(raw.gasLimit)),
      baseFeePerGas: raw.baseFeePerGas ? BigInt(raw.baseFeePerGas) : 0n,
      transactions: (raw.transactions || []).map((t) => ({
        hash: t.hash,
        from: t.from,
        to: t.to,
        value: BigInt(t.value ?? "0x0"),
        gasPrice: t.gasPrice ? BigInt(t.gasPrice) : 0n,
        transactionIndex: Number(BigInt(t.transactionIndex ?? "0x0")),
      })),
    };

    const receipts = [];
    const allLogs = [];
    for (const t of block.transactions) {
      const r = await rpc.getTransactionReceipt(t.hash);
      const rec = {
        gasUsed: r ? Number(BigInt(r.gasUsed)) : 0,
        effectiveGasPrice: r && r.effectiveGasPrice ? BigInt(r.effectiveGasPrice) : t.gasPrice,
        contractAddress: r ? r.contractAddress : null,
        status: r ? Number(BigInt(r.status ?? "0x1")) : 1,
        codeSize: 0,
      };
      if (rec.contractAddress) {
        const code = await rpc.call("eth_getCode", [rec.contractAddress, "latest"]);
        rec.codeSize = code && code !== "0x" ? (code.length - 2) / 2 : 0;
      }
      receipts.push(rec);
      for (const l of r && r.logs ? r.logs : []) allLogs.push(normalizeLog(l));
    }

    ingestLayerBlock(db, { block, receipts, cfg });
    if (allLogs.length) {
      ingestLogs(db, {
        chain: "layer",
        logs: allLogs,
        cfg,
        addressBook: book,
        tsOf: () => block.timestamp,
      });
    }
    setCursor(db, "layer", n);
  }
  return to;
}

/** 把 RPC 返回的十六进制字段归一成我们内部用的形状。 */
export function normalizeLog(l) {
  return {
    address: l.address,
    topics: l.topics || [],
    data: l.data ?? "0x",
    blockNumber: Number(BigInt(l.blockNumber)),
    transactionHash: l.transactionHash,
    logIndex: Number(BigInt(l.logIndex ?? "0x0")),
  };
}

/** 常驻循环。两条链各自一个定时器，互不阻塞；任何一次失败只打告警并退避重试。 */
export async function runIngest(db, cfg, { signal } = {}) {
  const layerRpc = new Rpc(cfg.layerRpc, { name: "layer" });
  const bscRpc = new Rpc(cfg.bscRpc, { name: "bsc" });

  const loop = async (name, fn, intervalMs) => {
    let backoff = intervalMs;
    while (!(signal && signal.aborted)) {
      try {
        await fn();
        backoff = intervalMs;
        clearWarning(`${name}_ingest_failed`);
      } catch (e) {
        warn(`${name}_ingest_failed`, String(e && e.message ? e.message : e));
        backoff = Math.min(120000, backoff * 2);
      }
      await sleep(backoff);
    }
  };

  await Promise.all([
    loop("layer", () => layerTick(db, cfg, layerRpc), cfg.layerPollMs),
    loop("bsc", () => bscTick(db, cfg, bscRpc), cfg.bscPollMs),
  ]);
}

export { LAYER_SYSTEM_ADDRESSES };
