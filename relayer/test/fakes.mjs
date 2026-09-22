// 离线测试用的假链。**没有任何网络调用**，方法名与 src/chains.mjs 的适配器一一对应。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';

export const ADDR = {
  bacBridge: '0x00000000000000000000000000000000000b4c01',
  agentRegistry: '0x0000000000000000000000000000000000ae9001',
  chainAnchor: '0x0000000000000000000000000000000000a0c001',
  l2Bridge: '0x0000000000000000000000000000000000000101',
  l2Gate: '0x0000000000000000000000000000000000000102',
  feeSink: '0x000000000000000000000000000000000000dead',
  layerSigner: '0x0000000000000000000000000000000000005164',
  feeSplitter: '0x0000000000000000000000000000000000000104',
  agentWallet: '0x000000000000000000000000000000000000abc1',
};

export function fakeCfg(overrides = {}) {
  return {
    addresses: { ...ADDR },
    // everValidator 累积表（03 §1.3）：阶段 1 只有官方出块者一个
    validators: [ADDR.layerSigner],
    start: { firstEpoch: 20700, bscBlock: 100, layerBlock: 0 },
    poll: { bscMs: 1, layerMs: 1, bscLogRange: 3000 },
    rpc: { bsc: 'a', bsc2: 'b', layer: 'c', layerFinality: 'instant' },
    ...overrides,
  };
}

/** 临时库：每个测试一个文件，跑完删掉 */
export function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'bac-relayer-'));
  const path = join(dir, 'relayer.db');
  const db = openDb(path);
  return {
    db,
    path,
    cleanup() {
      try {
        db.close();
      } catch {
        /* 已关就算了 */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 假 BSC。可以手动摆出任意确认状态、任意重组。
 */
export class FakeBsc {
  constructor(opts = {}) {
    this.head = opts.head ?? 1000;
    this.finalized = opts.finalized ?? { number: 985, hash: '0x' + 'f1'.repeat(32) };
    this.finalized2 = opts.finalized2 ?? this.finalized;
    this.crossCheck = opts.crossCheck ?? 'agree';
    this.receipts = new Map(); // txHash -> {blockHash, logs:[{index,address}], status}
    this.posted = opts.lastPostedEpoch ?? 0;
    this.anchorStates = new Map();
    this.sends = [];
    this.mined = new Map(); // txHash -> receipt
    this.failSend = null;
    this.mineResult = 1; // 1 成功 0 revert，null 表示永不上链（超时）
    this.address = '0x0000000000000000000000000000000000ae1a00';
    this.lockedLogs = opts.lockedLogs ?? [];
    this.registryLogs = opts.registryLogs ?? [];
    this.agentStates = opts.agentStates ?? new Map();
    this.issued = opts.issued ?? 0n;
    this.exited = opts.exited ?? 0n;
    this.bal = opts.balance ?? 10n ** 18n;
  }

  async getBlockNumber() {
    return this.head;
  }

  async snapshot(ts) {
    return {
      ts,
      headA: this.head,
      headB: this.head,
      finalizedA: this.finalized,
      finalizedB: this.finalized2,
      crossCheck: this.crossCheck,
    };
  }

  async scanLocked(from, to) {
    return this.lockedLogs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
  }

  async scanRegistry(from, to) {
    return this.registryLogs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
  }

  async agentState(agentId) {
    return this.agentStates.get(Number(agentId)) ?? { wallet: ADDR.agentWallet, status: 2 };
  }

  async verifySourceLog(src) {
    const r = this.receipts.get(src.txHash);
    if (!r) return { ok: false, reason: '收据不存在（交易已从规范链上消失）' };
    if (r.blockHash !== src.blockHash) return { ok: false, reason: 'blockHash 变了' };
    const hit = r.logs.find((l) => Number(l.index) === Number(src.logIndex));
    if (!hit) return { ok: false, reason: '收据里没有该 logIndex' };
    return { ok: true, reason: '源日志仍在规范链上' };
  }

  async lastPostedEpoch() {
    return this.posted;
  }

  async anchorStateOf(epoch) {
    return this.anchorStates.get(epoch) ?? 'NONE';
  }

  async feeGwei() {
    return 5_000_000_000n;
  }

  async sendAnchor(job, opts = {}) {
    if (this.failSend) throw new Error(this.failSend);
    const hash = '0x' + ('a' + job.epoch).padStart(64, '0');
    // nonce 只算一次：重发必须复用同一个 nonce（中继不做 nonce 管理器）
    const nonce = opts.nonce ?? this.sends.length;
    this.sends.push({ kind: 'anchor', epoch: job.epoch, gasPrice: opts.gasPrice, nonce });
    if (this.mineResult !== null) {
      this.mined.set(hash, { status: this.mineResult });
      if (this.mineResult === 1) {
        this.posted = job.epoch; // 链上幂等键：epoch == lastPostedEpoch + 1
        this.anchorStates.set(job.epoch, 'POSTED');
      }
    }
    return { hash, nonce };
  }

  async waitMined(hash /* , ms */) {
    return this.mined.get(hash) ?? null;
  }

  async balance() {
    return this.bal;
  }

  async reconcileReads() {
    return { issued: this.issued, exited: this.exited };
  }
}

/**
 * 假层内链。块是「编号 -> 时间戳」的一张表，日志按区块挂。
 */
export class FakeLayer {
  constructor(opts = {}) {
    /** @type {Array<{number:number,hash:string,timestamp:number}>} 下标即块号 */
    this.blocks = opts.blocks ?? [];
    this.exits = opts.exits ?? [];
    this.mints = opts.mints ?? [];
    this.balances = opts.balances ?? new Map(); // `${addr}@${block}` -> bigint，缺省回退 `${addr}`
    this.seenSet = new Set(opts.seen ?? []);
    this.sends = [];
    this.mined = new Map();
    this.mineResult = 1;
    this.failSend = null;
    this.syncedAt = new Map();
    this.address = '0x0000000000000000000000000000000000ae1b00';
  }

  async getBlockNumber() {
    return this.blocks.length - 1;
  }

  async getBlock(n) {
    return this.blocks[n] ?? null;
  }

  async seen(depositId) {
    return this.seenSet.has(depositId);
  }

  async syncApplied(job) {
    return (this.syncedAt.get(Number(job.agentId)) ?? -1) >= Number(job.bscBlock);
  }

  async feeGwei() {
    return 1_000_000_000n;
  }

  async sendCredit(job, opts = {}) {
    if (this.failSend) throw new Error(this.failSend);
    const hash = '0x' + 'c'.repeat(63) + String(this.sends.length % 10);
    const nonce = opts.nonce ?? this.sends.length;
    this.sends.push({ kind: 'credit', depositId: job.depositId, gasPrice: opts.gasPrice, nonce });
    if (this.mineResult !== null) {
      this.mined.set(hash, { status: this.mineResult });
      if (this.mineResult === 1) this.seenSet.add(job.depositId); // 链上幂等键
    }
    return { hash, nonce };
  }

  async sendSync(job, opts = {}) {
    if (this.failSend) throw new Error(this.failSend);
    const hash = '0x' + ('b' + this.sends.length).padStart(64, '0');
    const nonce = opts.nonce ?? this.sends.length;
    this.sends.push({ kind: 'sync', agentId: job.agentId, nonce });
    if (this.mineResult !== null) {
      this.mined.set(hash, { status: this.mineResult });
      if (this.mineResult === 1) this.syncedAt.set(Number(job.agentId), Number(job.bscBlock));
    }
    return { hash, nonce };
  }

  async waitMined(hash) {
    return this.mined.get(hash) ?? null;
  }

  async exitLogs(from, to) {
    return this.exits.filter((e) => e.layerBlock >= from && e.layerBlock <= to);
  }

  async creditLogs(from, to) {
    return this.mints.filter((m) => m.layerBlock >= from && m.layerBlock <= to);
  }

  async balance(address, blockTag = 'latest') {
    const keyed = this.balances.get(`${address}@${blockTag}`);
    if (keyed !== undefined) return keyed;
    return this.balances.get(address) ?? 0n;
  }
}

/** 造一条等间隔出块的假层内链（period 秒一个块） */
export function makeChain(count, startTs, period = 3) {
  const blocks = [];
  for (let i = 0; i < count; i++) {
    blocks.push({ number: i, hash: '0x' + String(i).padStart(64, '0'), timestamp: startTs + i * period });
  }
  return blocks;
}
