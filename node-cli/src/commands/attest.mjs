// bac-node attest：每纪元 commit → 等锚点 → reveal。
//
// 两种跑法：
//   bac-node attest            常驻（compose 里的 attester 服务就是它）
//   bac-node attest --once     跑一趟就退出，给 cron / systemd timer 用
//
// 决定「现在该做什么」的是 attest-state.mjs 那个纯状态机；这里只负责观测和执行。
// 三条不许动的纪律：
//   1) 本地头部没越过纪元边界就不承诺（l2Block 还没定，承诺一个会变的值等于自造异议）；
//   2) 链上承诺与本地 salt 对不上就停下告警，不揭示（揭示不符会吃 strike）；
//   3) 就算你算出来的根和官方不一样，也照样揭示**你自己看到的那一个**。

import fsReal from 'node:fs';
import { layout, readConfig } from '../config.mjs';
import { Rpc } from '../rpc.mjs';
import { SaltStore, commitmentHash } from '../salt-store.mjs';
import { nextAction, isTerminal } from '../attest-state.mjs';
import { computeEpoch } from '../attest-compute.mjs';
import { getAnchor, ifaceStaking, loadSigner, sendTx } from '../chain.mjs';
import { ENV_VALIDATOR_KEY, EPOCH } from '../constants.mjs';
import { BacError, NotDeterminedError, epochOf, fmtBeijing, fmtDuration, nowSec } from '../util.mjs';

/** 观测一个纪元的全部事实，喂给状态机 */
async function observe({ cfg, epoch, now, layer, bsc, store, me, log }) {
  let headTs = null;
  try {
    const b = await layer.getBlock('latest', false);
    headTs = Number(BigInt(b.timestamp));
  } catch (e) { log.warn(`读不到本地头部区块：${e.message}`); }

  let anchor = { state: 'NONE', postedAt: 0, exitRoot: null, l2Block: 0, l2BlockHash: null };
  if (cfg.addresses.anchor) {
    try { anchor = await getAnchor(bsc, cfg.addresses.anchor, epoch); }
    catch (e) { log.warn(`读不到纪元 ${epoch} 的锚点：${e.message}`); }
  }

  const rec = store.read(epoch);
  let commitMatches = true;
  if (rec && rec.committedTx && me) {
    try {
      commitMatches = commitmentHash({
        epoch, exitRoot: rec.exitRoot, l2BlockHash: rec.l2BlockHash,
        l2Block: rec.l2Block, salt: rec.salt, validator: me,
      }) === rec.commitment;
    } catch { commitMatches = false; }
  }

  return {
    ctx: {
      now, epoch, headTs,
      committed: !!(rec && rec.committedTx),
      commitMatches,
      hasSalt: !!rec,
      revealed: !!(rec && rec.revealedTx),
      anchorState: anchor.state,
      postedAt: anchor.postedAt,
      claimed: !!(rec && rec.claimedTx),
    },
    rec, anchor,
  };
}

/** 跑一个纪元的一步。返回状态机的判断，便于上层决定要不要继续。 */
export async function step({ cfg, epoch, now, layer, bsc, store, wallet, log, dryRun, deps }) {
  const me = wallet ? wallet.address : null;
  const { ctx, rec, anchor } = await observe({ cfg, epoch, now, layer, bsc, store, me, log });
  const st = nextAction(ctx);
  const fn = st.severity === 'fail' ? 'fail' : st.severity === 'warn' ? 'warn' : 'info';
  log[fn](`纪元 ${epoch} → ${st.action}：${st.zh}`);

  if (st.action === 'commit') {
    if (!wallet) throw new BacError(`要承诺就得能签名：设好 ${ENV_VALIDATOR_KEY}`, 'no_key');
    let computed;
    try {
      computed = await computeEpoch(layer, epoch, { bscBridge: cfg.addresses.bscBridge, l2Bridge: cfg.addresses.l2Bridge });
    } catch (e) {
      if (e instanceof NotDeterminedError) { log.warn(`还算不出来：${e.message}`); return st; }
      throw e;
    }
    log.info(`  区间 (${computed.from - 1}, ${computed.to}]${computed.empty ? '（空纪元）' : ''}，`
      + `退出 ${computed.leaves.length} 笔`);
    log.info(`  exitRoot ${computed.exitRoot}`);
    log.info(`  l2Block  ${computed.l2Block}  hash ${computed.l2BlockHash}`);

    const salt = (rec && rec.salt) ? rec.salt : store.newSalt();   // 重试时复用同一个 salt
    const commitment = commitmentHash({
      epoch, exitRoot: computed.exitRoot, l2BlockHash: computed.l2BlockHash,
      l2Block: computed.l2Block, salt, validator: wallet.address,
    });
    log.info(`  commitment ${commitment}`);   // 承诺是链上公开值，可以打印；salt 永远不打印

    // 先落盘再发交易：交易发出去了但记录没写 = 到时候揭示不了
    store.write({
      epoch, exitRoot: computed.exitRoot, l2BlockHash: computed.l2BlockHash, l2Block: computed.l2Block,
      salt, commitment, validator: wallet.address,
      leafCount: computed.leaves.length, from: computed.from, to: computed.to,
      committedTx: null, revealedTx: null, claimedTx: null, createdAt: now,
    });

    const data = ifaceStaking.encodeFunctionData('commitAttestation', [BigInt(epoch), commitment]);
    const r = await sendTx(bsc, wallet, {
      to: cfg.addresses.staking, data, log, dryRun, sleep: deps && deps.sleep,
    });
    if (!dryRun) {
      store.write({ ...store.read(epoch), committedTx: r.hash });
      log.ok(`纪元 ${epoch} 已承诺。截止时间是 ${fmtBeijing(st.deadlineAt)}，你赶在了前面`);
    }
    return st;
  }

  if (st.action === 'reveal') {
    if (!wallet) throw new BacError(`要揭示就得能签名：设好 ${ENV_VALIDATOR_KEY}`, 'no_key');
    if (anchor.exitRoot && rec) {
      const same = anchor.exitRoot.toLowerCase() === rec.exitRoot.toLowerCase()
        && Number(anchor.l2Block) === Number(rec.l2Block)
        && String(anchor.l2BlockHash).toLowerCase() === String(rec.l2BlockHash).toLowerCase();
      if (same) log.ok('  与链上锚点一致，这是一次「同意」的揭示');
      else {
        log.fail('  与链上锚点不一致：照实揭示你自己算出来的那一个。');
        log.info(`    链上 exitRoot ${anchor.exitRoot} l2Block ${anchor.l2Block}`);
        log.info(`    本地 exitRoot ${rec.exitRoot} l2Block ${rec.l2Block}`);
        log.info('    QBFT 下层内不会重组，所以不一致只可能是「你和官方看到的不是同一条链」，应该报。');
      }
    }
    const data = ifaceStaking.encodeFunctionData('revealAttestation',
      [BigInt(epoch), rec.exitRoot, rec.l2BlockHash, BigInt(rec.l2Block), rec.salt]);
    const r = await sendTx(bsc, wallet, {
      to: cfg.addresses.staking, data, log, dryRun, sleep: deps && deps.sleep,
    });
    if (!dryRun) {
      store.write({ ...store.read(epoch), revealedTx: r.hash });
      log.ok(`纪元 ${epoch} 已揭示（截止 ${fmtBeijing(st.deadlineAt)}）`);
    }
    return st;
  }

  return st;
}

export async function run(args, deps = {}) {
  const fs = deps.fs || fsReal;
  const log = deps.log;
  const cfg = readConfig(args.home, { fsImpl: fs });
  const lay = layout(args.home);
  const store = deps.store || new SaltStore(lay.state, { fsImpl: fs });
  const layer = deps.layerRpc || new Rpc(cfg.layerRpc, { fetchImpl: deps.fetchImpl, label: '本地层内节点' });
  const bsc = deps.bscRpc || new Rpc(cfg.bscRpc, { fetchImpl: deps.fetchImpl, label: 'BSC' });
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let wallet = null;
  try { wallet = deps.wallet || loadSigner(ENV_VALIDATOR_KEY, deps.env || process.env); }
  catch (e) {
    if (args.dryRun) log.warn(`${e.message}（--dry-run 下继续，只算不发）`);
    else throw e;
  }
  if (!cfg.addresses.staking && !args.dryRun) {
    throw new BacError('addresses.staking 没配：承诺和揭示都发不出去', 'bad_config');
  }
  if (wallet) log.info(`见证地址 ${wallet.address}`);

  const once = !!args.once;
  const loopMs = Number(args.intervalMs ?? 60000);

  do {
    const now = deps.now ?? nowSec();
    const cur = epochOf(now);
    // 看两个纪元：上一个（多半正处在承诺/揭示中）和当前（还没结束，只是提示）
    const epochs = args.epoch !== undefined && args.epoch !== null
      ? [Number(args.epoch)]
      : [cur - 1, cur];

    for (const ep of epochs) {
      if (ep < 0) continue;
      try {
        const st = await step({ cfg, epoch: ep, now, layer, bsc, store, wallet, log, dryRun: !!args.dryRun, deps });
        if (isTerminal(st.action) && st.severity === 'fail') {
          // 状态机判定为「停下来人工看」的，不要在循环里反复打
          log.warn('这一项需要人工处理，attest 不会自动重试它');
        }
      } catch (e) {
        log.fail(`纪元 ${ep} 处理失败：${e.message}`);
        if (once) throw e;
      }
    }

    if (once) break;
    const nextTick = Math.min(loopMs / 1000, 300);
    log.info(`下一轮 ${fmtDuration(nextTick)} 后（当前纪元 ${cur}，${fmtDuration((cur + 1) * EPOCH - now)} 后结束）`);
    await sleep(loopMs);
  } while (!once);

  return { ok: true };
}
