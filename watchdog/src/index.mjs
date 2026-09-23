// 进程入口。两个独立的循环：
//   · 快循环（默认 5 秒）：只跑锚点根 —— 唯一有 120 秒窗口的规则。
//   · 慢循环（默认 30 秒）：桶 / 回购 / 释放率 / 对账 / 活性。
// 两个循环各自 `setTimeout` 递归，不用 `setInterval`：后者会在一次慢读之后堆积调用，
// 把「每 5 秒一次」变成「一口气连发五次」。
//
// 跳闸之后进程**故意退出，退出码非零**（EXIT.TRIPPED = 3）：
//   · 它已经对这座桥下过结论，继续巡检只会在日志里刷同一句话；
//   · 非零退出码是运维脚本与 compose 的 restart 策略唯一认得的信号；
//   · SQLite 里留着 `tripped` 的发现，重启时会立刻再退出一次，直到有人来看。
// compose 里因此用 `restart: on-failure:3`：撞三次就停在那里，`docker ps` 上看得见。

import { loadConfig, redactedConfig } from './config.mjs';
import { EXIT } from './constants.mjs';
import { makeBsc, makeLayer } from './chains.mjs';
import { openDb, trippedFindings } from './db.mjs';
import { makeEngine } from './engine.mjs';
import { log } from './log.mjs';
import { preflight } from './preflight.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main(argv = process.argv.slice(2), env = process.env) {
  const once = argv.includes('--once');

  let cfg;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    log.error('配置有误，拒绝启动', { err: e });
    return EXIT.CONFIG;
  }
  log.info('watchdog 启动', { cfg: redactedConfig(cfg), once });

  const db = openDb(cfg.dbPath);

  // 上一轮已经跳过闸而且没人处理：立刻再退出一次，不要假装一切正常。
  const stale = trippedFindings(db);
  if (stale.length > 0 && env.WATCHDOG_RESUME_AFTER_TRIP !== 'true') {
    log.alert('上次已经跳闸且尚未被处理，拒绝继续巡检', {
      findings: stale.map((f) => ({ id: f.id, rule: f.rule, subject: f.subject, at: f.updatedAt })),
      howToClear:
        '人工确认后，把 findings 表里那几行的 state 改成 cleared，或设 WATCHDOG_RESUME_AFTER_TRIP=true 重启',
    });
    return EXIT.TRIPPED;
  }

  const bsc = makeBsc(cfg, 'primary', true);
  const bsc2 = makeBsc(cfg, 'secondary', false);
  const layer = makeLayer(cfg, 'primary');
  const layer2 = makeLayer(cfg, 'secondary');
  if (!layer2.independent) {
    log.warn('层内只有一个 RPC 端点：锚点根的复核读会退化成「隔一会儿再读同一台」', {
      note: '它能排除瞬时读取错误，排不掉节点本身说谎。这与信任表第一行「出块、中继、索引同一个信任域」是同一件事',
    });
  }

  const pf = await preflight({ cfg, bsc, bsc2, layer });
  log.info('启动自检', pf.facts);
  if (!pf.ok) {
    for (const p of pf.problems) log.error('启动自检未通过', { problem: p });
    return EXIT.PREFLIGHT;
  }
  if (!cfg.armed) {
    log.warn('WATCHDOG_ARMED=false：演练模式。检测照跑、告警照发，但**不会发出 pause() 交易**', {});
  }

  const engine = makeEngine({ cfg, db, bsc, bsc2, layer, layer2 });
  await engine.resume();
  if (engine.tripped) return EXIT.TRIPPED;

  if (once) {
    await safe(() => engine.tickFast(), 'tickFast');
    await safe(() => engine.tickSlow(), 'tickSlow');
    return engine.tripped ? EXIT.TRIPPED : EXIT.OK;
  }

  let stop = false;
  const shutdown = (sig) => {
    log.info('收到信号，准备退出', { sig });
    stop = true;
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const fast = (async () => {
    while (!stop && !engine.tripped) {
      const t0 = Date.now();
      await safe(() => engine.tickFast(), 'tickFast');
      const spent = Date.now() - t0;
      if (spent > cfg.poll.fastMs) {
        // 一轮快巡检比轮询间隔还慢 = 探测延迟指标已经保不住了，必须喊出来。
        log.warn('快巡检超时，探测延迟指标可能已经保不住', { spentMs: spent, budgetMs: cfg.poll.fastMs });
      }
      await sleep(Math.max(0, cfg.poll.fastMs - spent));
    }
  })();

  const slow = (async () => {
    while (!stop && !engine.tripped) {
      const t0 = Date.now();
      await safe(() => engine.tickSlow(), 'tickSlow');
      await sleep(Math.max(0, cfg.poll.slowMs - (Date.now() - t0)));
    }
  })();

  await Promise.all([fast, slow]);
  return engine.tripped ? EXIT.TRIPPED : EXIT.OK;
}

/** 一次读失败不该把常驻进程带走：记下来，下一轮接着读。 */
async function safe(fn, label) {
  try {
    return await fn();
  } catch (e) {
    log.error('巡检轮次出错，下一轮继续', { label, err: e });
    return null;
  }
}

// 直接运行时才启动；被测试 import 时不启动。
if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      log.error('未捕获的异常', { err: e });
      process.exitCode = 1;
    },
  );
}
