// bac-node doctor：采集事实 → 交给 doctor.mjs 的纯函数判断 → 打印。
// 采集全部包在 try 里：doctor 的工作是在环境坏掉的时候还能给出结论，它自己不许因为环境坏掉而崩。

import fsReal from 'node:fs';
import { layout, readConfig, validateConfig } from '../config.mjs';
import { runChecks, summarize } from '../doctor.mjs';
import { Docker } from '../docker.mjs';
import { Rpc } from '../rpc.mjs';
import { Api } from '../api.mjs';
import { ifaceStaking, nodeIdHash, nodeOf, readCall, stakeOf } from '../chain.mjs';
import { nowSec } from '../util.mjs';

/** 磁盘余量：优先用注入的实现，其次 df（POSIX），Windows 上拿不到就返回 null */
export async function diskFree(dir, exec) {
  try {
    const r = await exec('df', ['-Pk', dir], {});
    if (r.code !== 0) return { freeBytes: null, error: (r.stderr || '').trim() || 'df 失败' };
    const line = r.stdout.trim().split('\n').pop();
    const cols = line.trim().split(/\s+/);
    const availKb = Number(cols[3]);
    if (!Number.isFinite(availKb)) return { freeBytes: null, error: '看不懂 df 的输出' };
    return { freeBytes: availKb * 1024, error: null };
  } catch (e) {
    return { freeBytes: null, error: String(e.message) };
  }
}

export async function collect(args, deps = {}) {
  const fs = deps.fs || fsReal;
  const cfg = readConfig(args.home, { fsImpl: fs });
  const lay = layout(args.home);
  const now = deps.now ?? nowSec();
  const docker = deps.docker || new Docker({ cwd: args.home });

  const layerRpc = deps.layerRpc || new Rpc(cfg.layerRpc, { fetchImpl: deps.fetchImpl, label: '本地层内节点' });
  const bscRpc = deps.bscRpc || new Rpc(cfg.bscRpc, { fetchImpl: deps.fetchImpl, label: 'BSC' });
  const bscRpc2 = deps.bscRpc2 || (cfg.bscRpc2
    ? new Rpc(cfg.bscRpc2, { fetchImpl: deps.fetchImpl, label: 'BSC#2' }) : null);
  const api = deps.api || new Api(cfg.apiBase, { fetchImpl: deps.fetchImpl });

  const ctx = {
    cfg, now,
    posix: deps.posix ?? (process.platform !== 'win32'),
    configCheck: validateConfig(cfg),
    processUid: deps.processUid ?? (process.getuid ? process.getuid() : cfg.uid),
    docker: null, psList: null,
    layer: { chainId: null, head: null, headTs: null, genesisHash: null, peers: null, error: null },
    bsc: { ok: false, error: null }, bsc2: null,
    official: { head: null, error: null },
    datadir: { exists: false, uid: null, mode: null },
    nodeKey: { exists: false, mode: null },
    disk: { freeBytes: null, error: null },
    staking: null,
  };

  try { ctx.docker = await docker.available(); } catch (e) { ctx.docker = { ok: false, detail: e.message }; }
  if (ctx.docker && ctx.docker.ok) { try { ctx.psList = await docker.ps(); } catch { ctx.psList = []; } }

  try {
    const b = await layerRpc.getBlock('latest', false);
    ctx.layer.head = Number(BigInt(b.number));
    ctx.layer.headTs = Number(BigInt(b.timestamp));
    ctx.layer.chainId = await layerRpc.chainId();
    const g = await layerRpc.getBlock(0, false);
    ctx.layer.genesisHash = g && g.hash;
    try { ctx.layer.peers = await layerRpc.peerCount(); } catch { ctx.layer.peers = null; }
  } catch (e) { ctx.layer.error = e.message; }

  try { await bscRpc.blockNumber(); ctx.bsc.ok = true; }
  catch (e) { ctx.bsc = { ok: false, error: e.message }; }
  if (bscRpc2) {
    try { await bscRpc2.blockNumber(); ctx.bsc2 = { ok: true, error: null }; }
    catch (e) { ctx.bsc2 = { ok: false, error: e.message }; }
  }

  try { const h = await api.health(); ctx.official.head = h && h.layer ? Number(h.layer.head) : null; }
  catch (e) { ctx.official.error = e.message; }

  try {
    const st = fs.statSync(lay.besuData);
    ctx.datadir = { exists: true, uid: st.uid, mode: st.mode };
  } catch { ctx.datadir = { exists: false, uid: null, mode: null }; }
  try {
    const st = fs.statSync(lay.nodeKey);
    ctx.nodeKey = { exists: true, mode: st.mode };
  } catch { ctx.nodeKey = { exists: false, mode: null }; }

  ctx.disk = deps.disk || await diskFree(lay.home, deps.exec || (await import('../docker.mjs')).realExec);

  if (cfg.addresses.staking && (deps.me || args.address)) {
    const me = deps.me || args.address;
    try {
      const s = await stakeOf(bscRpc, cfg.addresses.staking, me);
      const nodes = Number(await readCall(bscRpc, ifaceStaking, cfg.addresses.staking, 'nodesOf', [me]));
      let registered = null, active = null, strikes = null;
      if (cfg.nodeId) {
        const n = await nodeOf(bscRpc, cfg.addresses.staking, nodeIdHash(cfg.nodeId));
        registered = !/^0x0+$/.test(n.validator);
        active = n.active; strikes = n.strikes;
      }
      ctx.staking = { staked: s.staked, nodes, registered, active, strikes, error: null };
    } catch (e) { ctx.staking = { staked: null, nodes: null, registered: null, active: null, strikes: null, error: e.message }; }
  }

  return ctx;
}

export async function run(args, deps = {}) {
  const log = deps.log;
  const ctx = await collect(args, deps);
  const results = runChecks(ctx);
  log.head('bac-node doctor');
  for (const r of results) {
    const fn = r.status === 'fail' ? 'fail' : r.status === 'warn' ? 'warn' : 'ok';
    log[fn](`${r.title}：${r.detail}`);
    if (r.fix && r.status !== 'ok') log.info(`         怎么办：${r.fix}`);
  }
  const s = summarize(results);
  log.head(s.ok
    ? `全部通过（${s.warns} 条提醒）`
    : `${s.fails} 项失败、${s.warns} 条提醒 —— 失败项修完再谈见证`);
  return { ok: s.ok, results, exitCode: s.ok ? 0 : 1 };
}
