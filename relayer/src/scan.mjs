// 方向 A（存款）与方向 C（状态镜像）的 BSC 扫描：把日志变成 outbox 里的待办。
// 纪律（03 §1.1 第 1 条）：**先把待办写进 SQLite 并提交事务，再推进游标**。
// 崩在两步之间 = 重扫同一段 = UNIQUE(kind,key) 去重；反过来崩一次就永久漏掉一笔存款。

import { AGENT_STATUS_NAMES, BSC_CHAIN_ID, OUTBOX_STATUS } from './constants.mjs';
import { enqueueBatch, getCursor, setCursor } from './db.mjs';
import { depositKey } from './ids.mjs';
import { log } from './log.mjs';

/**
 * 由一条 `BacBridge.Locked` 日志构造 CreditJob（03 §1.2 的 JSON 形状，逐字）。
 * `depositId` 是中继自己算的 keccak，**不是**事件里那个自增计数器。
 */
export function creditJobFrom(locked, bridgeAddr, seenAt) {
  return {
    $schema: 'bac/CreditJob/1',
    kind: 'credit',
    depositId: depositKey(bridgeAddr, locked.txHash, locked.logIndex),
    agentId: Number(locked.agentId),
    to: locked.layerWallet,
    amount: BigInt(locked.credits).toString(),
    src: {
      chainId: BSC_CHAIN_ID,
      blockNumber: Number(locked.blockNumber),
      blockHash: locked.blockHash,
      txHash: locked.txHash,
      logIndex: Number(locked.logIndex),
      seenAt,
      finalizedAt: null,
    },
    status: OUTBOX_STATUS.NEW,
    layerTxHash: null,
    attempts: 0,
    lastError: null,
  };
}

/** 由一条 AgentRegistry 状态事件构造 SyncJob（03 §1.4 的 JSON 形状，逐字） */
export function syncJobFrom(ev, state, seenAt) {
  return {
    $schema: 'bac/SyncJob/1',
    kind: 'sync',
    agentId: Number(ev.agentId),
    wallet: state.wallet,
    status: state.status,
    statusName: AGENT_STATUS_NAMES[state.status] ?? 'UNKNOWN',
    bscBlock: Number(ev.blockNumber),
    status_: OUTBOX_STATUS.NEW,
    layerTxHash: null,
    // src 不在 03 §1.4 的字段表里，但发送前的二次核对需要它（03 §1.1 第 2 条）。
    // 它是**附加**字段，不改任何已定义字段的名字或含义。
    src: {
      chainId: BSC_CHAIN_ID,
      blockNumber: Number(ev.blockNumber),
      blockHash: ev.blockHash,
      txHash: ev.txHash,
      logIndex: Number(ev.logIndex),
      seenAt,
      kind: 'sync',
    },
    attempts: 0,
    lastError: null,
  };
}

/**
 * 扫一轮 BSC。
 * @param {{db:object, bsc:object, cfg:object, now:()=>number}} ctx
 * @returns {Promise<{from:number,to:number,credits:number,syncs:number}|null>}
 */
export async function scanBscOnce(ctx) {
  const { db, bsc, cfg } = ctx;
  const now = ctx.now();
  const cursor = getCursor(db, 'bsc');
  if (cursor === null) throw new Error('bsc 游标未初始化：先写 BSC_START_BLOCK');

  const head = await bsc.getBlockNumber();
  const from = cursor + 1;
  if (from > head) return null;
  // eth_getLogs 窗口：公共 RPC 限 3000 块（02 §5 / research 09）
  const to = Math.min(head, from + cfg.poll.bscLogRange - 1);

  const locked = await bsc.scanLocked(from, to);
  const registry = await bsc.scanRegistry(from, to);

  const jobs = [];
  for (const lg of locked) {
    jobs.push({ kind: 'credit', key: depositKey(cfg.addresses.bacBridge, lg.txHash, lg.logIndex), payload: creditJobFrom(lg, cfg.addresses.bacBridge, now) });
  }
  for (const ev of registry) {
    // 状态以**现读**为准：一个 agent 在同一段区块里可能连续变了两次状态，
    // 镜像的是最终状态，而不是某一条事件里的中间态。
    const state = await bsc.agentState(ev.agentId);
    jobs.push({ kind: 'sync', key: `${Number(ev.agentId)}:${Number(ev.blockNumber)}`, payload: syncJobFrom(ev, state, now) });
  }

  // ① 先落盘并提交
  if (jobs.length) enqueueBatch(db, jobs, now);
  // ② 再推游标（单独一笔事务）
  setCursor(db, 'bsc', to, now);

  if (jobs.length) log.info('BSC 扫描入队', { from, to, credits: locked.length, syncs: registry.length });
  return { from, to, credits: locked.length, syncs: registry.length };
}
