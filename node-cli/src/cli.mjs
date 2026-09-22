#!/usr/bin/env node
// bac-node：BNB Agent Chain 见证人节点程序。
// 只做一件事：让一个只会 Docker 的人，把只读全节点跑起来、每纪元诚实见证、领到该领的钱。

import { pathToFileURL } from 'node:url';
import { makeLogger, redact, BacError } from './util.mjs';

export const USAGE = `bac-node —— BNB Agent Chain 见证人节点程序

用法：bac-node <命令> [选项]

  init                生成节点密钥、拉创世并核对哈希、写 compose.yml、打印你的 enode
  start               docker compose up -d（启动前后各核对一次创世哈希，不一致拒绝运行）
  stop                docker compose stop（给 RocksDB 2 分钟干净关闭）
  status              本地高度 / 对端数 / 与官方高度的差 / 本纪元见证状态 / 收益
  doctor              把常见故障查一遍（时钟、对端、创世、目录属主、磁盘、RPC）
  attest              每纪元 commit → 等锚点 → reveal；--once 适合 cron / systemd timer
  verify --epoch N    独立核验：自己重算 exitRoot / l2BlockHash 与链上锚点比，MATCH / MISMATCH
  stake --amount N    approve + stake（默认只打印，--yes 才真发）
  register            registerNode（默认只打印，--yes 才真发）
  unstake --amount N  requestUnstake（冷却 7 天）
  withdraw            withdrawUnstaked（冷却结束后）
  retire              retireNode（减仓前要先退节点）
  claim --epoch N     settleEpochRewards（按序补齐）+ claimReward

通用选项：
  --home <目录>       工作目录，默认当前目录（配置、data、secrets、state 都在这里）
  --json              能输出 JSON 的命令输出 JSON
  --dry-run           只算不发（attest / claim）
  --yes               真的广播交易（stake / register / unstake / withdraw / retire）

私钥：只从环境变量 VALIDATOR_PRIVATE_KEY 读（写在 validator.env，chmod 600）。
本程序从不打印、不落盘、不上传任何私钥。`;

export function parseArgs(argv) {
  const out = { _: [], home: process.env.BAC_HOME || '.' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    const boolFlags = ['json', 'yes', 'dryRun', 'once', 'help', 'version'];
    if (boolFlags.includes(camel) || next === undefined || next.startsWith('--')) {
      out[camel] = true;
    } else { out[camel] = next; i++; }
  }
  return out;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || makeLogger();
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd || args.help || cmd === 'help') { log.line(USAGE); return 0; }

  try {
    switch (cmd) {
      case 'init':
        await (await import('./commands/init.mjs')).run(args, { log, ...deps });
        return 0;
      case 'start':
        await (await import('./commands/node.mjs')).start(args, { log, ...deps });
        return 0;
      case 'stop':
        await (await import('./commands/node.mjs')).stop(args, { log, ...deps });
        return 0;
      case 'status':
        await (await import('./commands/status.mjs')).run(args, { log, ...deps });
        return 0;
      case 'attest':
        await (await import('./commands/attest.mjs')).run(args, { log, ...deps });
        return 0;
      case 'claim':
        await (await import('./commands/claim.mjs')).run(args, { log, ...deps });
        return 0;
      case 'stake':
        await (await import('./commands/stake.mjs')).stake(args, { log, ...deps });
        return 0;
      case 'register':
        await (await import('./commands/stake.mjs')).register(args, { log, ...deps });
        return 0;
      case 'unstake':
        await (await import('./commands/stake.mjs')).unstake(args, { log, ...deps });
        return 0;
      case 'withdraw':
        await (await import('./commands/stake.mjs')).withdraw(args, { log, ...deps });
        return 0;
      case 'retire':
        await (await import('./commands/stake.mjs')).retire(args, { log, ...deps });
        return 0;
      case 'doctor': {
        const r = await (await import('./commands/doctor.mjs')).run(args, { log, ...deps });
        return r.exitCode;
      }
      case 'verify': {
        const r = await (await import('./commands/verify.mjs')).run(args, { log, ...deps });
        return r.exitCode;
      }
      default:
        log.fail(`不认识的命令：${cmd}`);
        log.line(USAGE);
        return 2;
    }
  } catch (e) {
    // redact：万一有人把私钥当参数传进来，也不会在错误信息里泄露出去
    log.fail(redact(e instanceof BacError ? e.message : (e && e.stack) || String(e)));
    return 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  main().then((code) => { process.exitCode = code; });
}
