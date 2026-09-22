// 中继进程入口。compose 里的 command 就是 `node src/index.mjs`（02-CHAIN-SPEC §5）。
//
// 一个 Node 22 进程 + 一个 SQLite 文件 + 两条 EOA 私钥。**不是协议，不是多签，不是 committee。**
//
// 三个循环，全部在同一个事件循环里，彼此 await，绝不并发发交易：
//   ① scanLoop   —— 扫 BSC 的 Locked / AgentRegistry 事件，先落盘再推游标
//   ② anchorLoop —— 纪元一结束就组装锚点（6 分钟状态窗口），承诺窗口过后再发
//   ③ sendLoop   —— 唯一发交易的地方，一次一笔
//
// 层侧**没有重组处理**：QBFT 即时最终性，块一 commit 就不会回滚
// （docs/research/10-consensus-client.md 实测：Besu 24.12.2 + QBFT，45 s / 21 块）。
// BSC 侧的重组处理一行不动（verifySourceLog → orphaned）。

import { loadConfig, redactedConfig } from './config.mjs';
import { openDb, getAnchor, getCursor, initCursor, enqueueBatch, putAnchor, setCursor } from './db.mjs';
import { makeBscChain, makeLayerChain } from './chains.mjs';
import { FinalityTracker } from './finality.mjs';
import { assembleAnchor, epochOver } from './anchorJob.mjs';
import { drainOutbox, resumePending } from './sender.mjs';
import { scanBscOnce } from './scan.mjs';
import { buildStatus } from './status.mjs';
import { epochOf } from './anchorMath.mjs';
import { log } from './log.mjs';

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main() {
  const cfg = loadConfig(process.env);
  log.info('中继启动', redactedConfig(cfg));

  const db = openDb(cfg.dbPath);
  const bsc = makeBscChain(cfg);
  const layer = makeLayerChain(cfg);
  const tracker = new FinalityTracker();
  const warnings = new Set();

  // 游标：库里没有就用环境变量的起点；库里有就以库为准（崩溃重启从这里续）。
  if (getCursor(db, 'bsc') === null) {
    const start = cfg.start.bscBlock ?? (await bsc.getBlockNumber());
    initCursor(db, 'bsc', start, nowSec());
  }
  if (getCursor(db, 'layer') === null) {
    const start = cfg.start.layerBlock ?? 0;
    initCursor(db, 'layer', start, nowSec());
  }
  if (cfg.start.firstEpoch === null) {
    const g = await layer.getBlock(0);
    cfg.start.firstEpoch = g ? epochOf(Number(g.timestamp)) : epochOf(nowSec());
    log.info('FIRST_EPOCH 未配置，按层内创世块推算', { firstEpoch: cfg.start.firstEpoch });
  }

  const ctx = { db, bsc, layer, cfg, tracker, warnings, now: nowSec, snapshot: null };

  // 崩溃重启：先把 status='sent' 的续上，**绝不重复发**（链上幂等键先查一遍）。
  const resumed = await resumePending(ctx);
  log.info('重启续传完成', resumed);

  let running = true;
  let inFlight = null; // 当前这一轮的 promise，优雅关闭时要等它结束

  async function scanLoop() {
    while (running) {
      try {
        await scanBscOnce(ctx);
      } catch (e) {
        log.error('BSC 扫描出错', { err: e });
      }
      await sleep(cfg.poll.bscMs);
    }
  }

  async function anchorLoop() {
    while (running) {
      try {
        await anchorOnce(ctx);
      } catch (e) {
        log.error('锚点组装出错', { err: e });
      }
      await sleep(30_000);
    }
  }

  async function sendLoop() {
    while (running) {
      try {
        ctx.snapshot = await bsc.snapshot(nowSec());
        tracker.update(ctx.snapshot);
        if (tracker.outageSince === null) warnings.delete('bsc_finality_unavailable');
        inFlight = drainOutbox(ctx);
        await inFlight;
        inFlight = null;
      } catch (e) {
        log.error('发送轮出错', { err: e });
        inFlight = null;
      }
      await sleep(5_000);
    }
  }

  async function statusLoop() {
    while (running) {
      try {
        const s = await buildStatus(ctx);
        // 状态对象给索引器用：落一个 JSON 文件在 DB 目录旁边，索引器读它拼进 /api/health。
        // （索引器与中继不共享进程，也不该反向查中继的库。）
        const path = cfg.dbPath.replace(/\.db$/, '') + '-status.json';
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path, JSON.stringify(s, null, 2), 'utf8');
        if (s.warnings.length) log.warn('健康告警', { warnings: s.warnings });
      } catch (e) {
        log.error('状态输出出错', { err: e });
      }
      await sleep(15_000);
    }
  }

  const loops = [scanLoop(), anchorLoop(), sendLoop(), statusLoop()];

  async function shutdown(sig) {
    if (!running) return;
    running = false;
    log.info('收到信号，优雅关闭中（等待在途的那一笔）', { sig });
    try {
      if (inFlight) await inFlight;
    } catch (e) {
      log.error('关闭时在途任务出错', { err: e });
    }
    try {
      db.close();
    } catch (e) {
      log.error('关库失败', { err: e });
    }
    log.info('已关闭');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await Promise.all(loops);
}

/**
 * 锚点的一轮：
 *   ① 纪元一结束就组装（6 分钟状态窗口，读完落盘即可）；
 *   ② 组装好的锚点进 outbox，由 sendLoop 在承诺窗口之后发。
 */
export async function anchorOnce(ctx) {
  const { db, bsc, cfg } = ctx;
  const now = ctx.now();
  const lastPosted = await bsc.lastPostedEpoch();
  const target = Number(lastPosted) === 0 ? cfg.start.firstEpoch : Number(lastPosted) + 1;

  if (!epochOver(target, now)) return { action: 'wait', epoch: target, reason: '纪元还没结束' };
  if (getAnchor(db, target)) return { action: 'wait', epoch: target, reason: '已组装过' };

  const r = await assembleAnchor(ctx, target);
  for (const w of r.warnings) ctx.warnings.add(w);
  if (!r.ok) {
    log.warn('锚点组装未完成', { epoch: target, reason: r.reason });
    return { action: 'stop', epoch: target, reason: r.reason };
  }

  // ① 先落盘（anchors + outbox 各一笔），② 再由发送轮去发。
  putAnchor(db, target, r.payload, 'new', now);
  enqueueBatch(db, [{ kind: 'anchor', key: String(target), payload: r.payload }], now);
  setCursor(db, 'layer', r.payload.anchor.l2Block, now);
  log.info('锚点已组装并入队', {
    epoch: target,
    l2Block: r.payload.anchor.l2Block,
    exitCount: r.payload.anchor.exitCount,
    carried: r.payload.carriedEpochs,
  });
  return { action: 'queued', epoch: target };
}

// 只有被直接执行时才跑（被测试 import 时不跑）
if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  main().catch((e) => {
    log.error('致命错误，进程退出', { err: e });
    process.exit(1);
  });
}
