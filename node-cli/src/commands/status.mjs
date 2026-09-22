// bac-node status：本地高度 vs 官方高度、对端数、本纪元的见证状态、到手与待领的奖励。
// 一屏看完「我在不在干活、干得对不对、拿到了多少」。

import fsReal from 'node:fs';
import { layout, readConfig } from '../config.mjs';
import { Rpc } from '../rpc.mjs';
import { Api } from '../api.mjs';
import { SaltStore, commitmentHash } from '../salt-store.mjs';
import { nextAction } from '../attest-state.mjs';
import { getAnchor, ifaceStaking, loadSigner, nodeIdHash, readCall, stakeOf, nodeOf } from '../chain.mjs';
import { ENV_VALIDATOR_KEY, EPOCH } from '../constants.mjs';
import { epochOf, fmtBeijing, fmtDuration, fmtUnits, nowSec } from '../util.mjs';

export async function run(args, deps = {}) {
  const fs = deps.fs || fsReal;
  const log = deps.log;
  const cfg = readConfig(args.home, { fsImpl: fs });
  const lay = layout(args.home);
  const now = deps.now ?? nowSec();
  const epoch = epochOf(now);

  const layer = deps.layerRpc || new Rpc(cfg.layerRpc, { fetchImpl: deps.fetchImpl, label: '本地层内节点' });
  const bsc = deps.bscRpc || new Rpc(cfg.bscRpc, { fetchImpl: deps.fetchImpl, label: 'BSC' });
  const api = deps.api || new Api(cfg.apiBase, { fetchImpl: deps.fetchImpl });

  // —— 本地节点 ——
  log.head('本地节点');
  let head = null, headTs = null, peers = null;
  try {
    const b = await layer.getBlock('latest', false);
    head = Number(BigInt(b.number));
    headTs = Number(BigInt(b.timestamp));
    log.ok(`高度 #${head}，块时间 ${fmtBeijing(headTs)}（落后本机时钟 ${now - headTs} 秒）`);
  } catch (e) {
    log.fail(`读不到本地层内 RPC：${e.message}`);
  }
  try { peers = await layer.peerCount(); log[peers === 0 ? 'fail' : 'ok'](`对端 ${peers} 个`); }
  catch { log.warn('读不到 net_peerCount'); }

  // —— 与官方高度比 ——
  let official = null;
  try {
    const h = await api.health();
    official = h && h.layer ? Number(h.layer.head) : null;
    if (official !== null && head !== null) {
      const lag = official - head;
      log[lag > 1200 ? 'fail' : lag > 100 ? 'warn' : 'ok'](
        `官方高度 #${official}，你落后 ${Math.max(0, lag)} 个块（约 ${fmtDuration(Math.max(0, lag) * 3)}）`);
    }
    if (h && Array.isArray(h.warnings) && h.warnings.length) {
      log.warn(`官方 /api/health 自己在报警：${h.warnings.join(', ')}`);
    }
  } catch (e) { log.warn(`读不到官方 /api/health：${e.message}（只是没法比对）`); }

  // —— 我是谁 ——
  let me = null;
  try { me = loadSigner(ENV_VALIDATOR_KEY, deps.env || process.env).address; }
  catch { log.warn(`没设 ${ENV_VALIDATOR_KEY}：只能看链，不知道「你」是谁，也发不了交易`); }

  log.head('见证身份');
  if (me) {
    log.info(`地址 ${me}`);
    if (cfg.addresses.staking) {
      try {
        const s = await stakeOf(bsc, cfg.addresses.staking, me);
        log.info(`质押 ${fmtUnits(s.staked)} BAC` + (s.pending > 0n
          ? `，解押中 ${fmtUnits(s.pending)} BAC（${fmtBeijing(s.unlockAt)} 后可取）` : ''));
      } catch (e) { log.warn(`读质押失败：${e.message}`); }
      if (cfg.nodeId) {
        try {
          const n = await nodeOf(bsc, cfg.addresses.staking, nodeIdHash(cfg.nodeId));
          if (n.validator && /^0x0+$/.test(n.validator)) log.warn(`节点 ${cfg.nodeId} 还没注册`);
          else log[n.active ? 'ok' : 'fail'](
            `节点 ${cfg.nodeId}：${n.active ? 'active' : '已停用（领不到奖，本金不受影响）'}，strikes ${n.strikes}`);
        } catch (e) { log.warn(`读节点失败：${e.message}`); }
      }
    } else log.warn('addresses.staking 没配，跳过链上身份');
  }

  // —— 本纪元与上一个纪元的见证状态 ——
  const store = new SaltStore(lay.state, { fsImpl: fs });
  log.head('见证进度');
  log.info(`当前纪元 ${epoch}，${fmtDuration((epoch + 1) * EPOCH - now)} 后结束`);

  for (const ep of [epoch - 1, epoch]) {
    const rec = store.read(ep);
    let anchor = { state: 'NONE', postedAt: 0 };
    if (cfg.addresses.anchor) {
      try { anchor = await getAnchor(bsc, cfg.addresses.anchor, ep); }
      catch (e) { log.warn(`纪元 ${ep} 的锚点读不到：${e.message}`); }
    }
    let committed = false, revealed = false, commitMatches = false;
    if (rec) { committed = !!rec.committedTx; revealed = !!rec.revealedTx; }
    if (rec && me && rec.exitRoot) {
      try {
        commitMatches = commitmentHash({
          epoch: ep, exitRoot: rec.exitRoot, l2BlockHash: rec.l2BlockHash,
          l2Block: rec.l2Block, salt: rec.salt, validator: me,
        }) === rec.commitment;
      } catch { commitMatches = false; }
    }
    const st = nextAction({
      now, epoch: ep, headTs, committed, commitMatches: committed ? commitMatches : true,
      hasSalt: !!rec, revealed, anchorState: anchor.state, postedAt: anchor.postedAt,
      claimed: rec ? !!rec.claimedTx : false,
    });
    const fn = st.severity === 'fail' ? 'fail' : st.severity === 'warn' ? 'warn' : 'info';
    log[fn](`纪元 ${ep}：锚点 ${anchor.state} · ${st.action} — ${st.zh}`);
    if (rec && rec.exitRoot) log.info(`         本地算出 exitRoot ${rec.exitRoot} · l2Block ${rec.l2Block}`);
    if (anchor.state !== 'NONE' && rec && rec.exitRoot && anchor.exitRoot) {
      const same = anchor.exitRoot.toLowerCase() === rec.exitRoot.toLowerCase()
        && Number(anchor.l2Block) === Number(rec.l2Block)
        && anchor.l2BlockHash.toLowerCase() === rec.l2BlockHash.toLowerCase();
      log[same ? 'ok' : 'fail'](`         与链上锚点 ${same ? '一致' : '不一致（你看到的和官方不是同一条链，照实揭示）'}`);
    }
  }

  // —— 收益 ——
  log.head('收益');
  if (me && cfg.addresses.staking) {
    let pending = 0n, rows = 0;
    for (let ep = epoch - 1; ep >= epoch - (args.epochs ?? 10) && ep >= 0; ep--) {
      try {
        const r = await readCall(bsc, ifaceStaking, cfg.addresses.staking, 'rewardOf', [BigInt(ep), me]);
        if (r > 0n) { pending += r; rows++; log.info(`  纪元 ${ep}：待领 ${fmtUnits(r)} BNB`); }
      } catch { /* 纪元还没结算，正常 */ }
    }
    log[pending > 0n ? 'ok' : 'info'](
      `最近 ${args.epochs ?? 10} 个纪元待领合计 ${fmtUnits(pending)} BNB（${rows} 个纪元）`);
    if (pending > 0n) log.info('  用 bac-node claim --epoch <N> 领。30 天不领会被 sweepExpired 退回奖池');
    try {
      const vs = await api.validators();
      const mine = (vs.items || []).filter((i) => (i.validator || '').toLowerCase() === me.toLowerCase());
      for (const m of mine) log.info(`  节点 ${m.nodeId}：累计已领 ${fmtUnits(m.lifetimeClaimed || '0')} BNB，`
        + `同意 ${m.agreedEpochs} 个纪元 / 异议 ${m.disputedEpochs} 个`);
    } catch { /* API 不通不影响 */ }
  } else log.info('  （没有身份或没配 staking 地址，跳过）');

  log.head('提醒');
  log.info('  奖励来自运营方往 ValidatorStaking.fundRewards() 注入的 BNB，合约不强制注入，不承诺任何收益。');
  log.info('  你跑的是只读全节点，不出块、不投票、不影响共识（02 §0.5）。');
  return { ok: true, head, official, peers, epoch };
}
