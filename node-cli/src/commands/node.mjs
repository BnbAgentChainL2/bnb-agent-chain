// bac-node start / stop：驱动 docker compose，并在启动后强制核对创世哈希。
// 创世核对没有跳过开关：对错链是最贵的一种错，宁可不跑。

import fsReal from 'node:fs';
import { layout, readConfig, validateConfig } from '../config.mjs';
import { checkGenesisChain, checkGenesisFile } from '../genesis-gate.mjs';
import { Docker } from '../docker.mjs';
import { Rpc } from '../rpc.mjs';
import { BacError } from '../util.mjs';

export async function start(args, deps = {}) {
  const fs = deps.fs || fsReal;
  const log = deps.log;
  const home = args.home;
  const lay = layout(home);
  const cfg = readConfig(home, { fsImpl: fs });

  const v = validateConfig(cfg, { forStart: true });
  for (const w of v.warnings) log.warn(w);
  if (!v.ok) {
    for (const e of v.errors) log.fail(e);
    throw new BacError('配置没过校验，拒绝启动', 'bad_config');
  }

  // —— 启动前：本地 genesis.json 有没有被换过 ——
  const text = fs.existsSync(lay.genesis) ? fs.readFileSync(lay.genesis, 'utf8') : null;
  const fileCheck = checkGenesisFile({ recordedSha256: cfg.genesisSha256, actualText: text });
  if (!fileCheck.ok) { log.fail(fileCheck.zh); throw new BacError('创世文件核对失败，拒绝启动', 'genesis'); }
  log.ok(fileCheck.zh);

  // —— 起容器 ——
  const docker = deps.docker || new Docker({ cwd: home });
  const avail = await docker.available();
  if (!avail.ok) throw new BacError(`docker compose 不可用：${avail.detail}`, 'docker');
  log.info(`docker: ${avail.detail}`);
  await docker.up(args.services || []);
  log.ok('容器已拉起，正在等节点回应 RPC …');

  // —— 启动后：链上创世哈希（权威）——
  const rpc = deps.rpc || new Rpc(cfg.layerRpc, { fetchImpl: deps.fetchImpl, label: '本地层内节点' });
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const tries = args.waitTries ?? 30;
  let genesis = null, lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const b = await rpc.getBlock(0, false);
      if (b && b.hash) { genesis = b.hash; break; }
    } catch (e) { lastErr = e; }
    await sleep(args.waitMs ?? 2000);
  }
  if (!genesis && lastErr) log.warn(`读 0 号区块失败：${lastErr.message}`);

  const chainCheck = checkGenesisChain({ expected: cfg.genesisHash, actual: genesis });
  if (!chainCheck.ok) {
    log.fail(chainCheck.zh);
    log.warn('已经把容器停回去，以免你在错的链上继续同步和见证');
    try { await docker.stop(['besu']); } catch (e) { log.warn(`停容器失败：${e.message}`); }
    throw new BacError('创世哈希核对失败', 'genesis');
  }
  log.ok(chainCheck.zh);

  try {
    const id = await rpc.chainId();
    log.ok(`chainId ${id}`);
  } catch { /* 上面已经核对过创世，这里只是锦上添花 */ }

  log.head('起来了。接下来：');
  log.info('  bac-node status    看同步进度与本纪元的见证状态');
  log.info('  bac-node doctor    把常见故障查一遍');
  log.info('  docker compose logs -f besu    看它追块');
  return { ok: true, genesis };
}

export async function stop(args, deps = {}) {
  const log = deps.log;
  const home = args.home;
  const docker = deps.docker || new Docker({ cwd: home });
  log.info('docker compose stop（stop_grace_period 是 2 分钟，RocksDB 要时间干净关闭，别急着 Ctrl-C）');
  await docker.stop(args.services || []);
  log.ok('已停止');
  return { ok: true };
}
