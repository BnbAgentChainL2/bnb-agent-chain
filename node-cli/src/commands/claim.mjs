// bac-node claim --epoch N：BSC 侧领奖。
// 顺序是硬的：settleEpochRewards(N) 必须 N == lastRewardEpoch + 1（01 §7），
// 所以这里会先把落下的纪元按顺序补齐，再 claimReward(N, 我)。
// 领奖有 30 天窗口（REWARD_CLAIM_WINDOW），过期会被任何人 sweepExpired 退回奖池。

import fsReal from 'node:fs';
import { layout, readConfig } from '../config.mjs';
import { Rpc } from '../rpc.mjs';
import { SaltStore } from '../salt-store.mjs';
import { epochReward, ifaceStaking, loadSigner, readCall, sendTx } from '../chain.mjs';
import { ENV_VALIDATOR_KEY, REWARD_CLAIM_WINDOW } from '../constants.mjs';
import { BacError, epochOf, fmtDuration, fmtUnits, nowSec } from '../util.mjs';

export async function run(args, deps = {}) {
  const fs = deps.fs || fsReal;
  const log = deps.log;
  const cfg = readConfig(args.home, { fsImpl: fs });
  const lay = layout(args.home);
  const bsc = deps.bscRpc || new Rpc(cfg.bscRpc, { fetchImpl: deps.fetchImpl, label: 'BSC' });
  const store = deps.store || new SaltStore(lay.state, { fsImpl: fs });
  const wallet = deps.wallet || loadSigner(ENV_VALIDATOR_KEY, deps.env || process.env);
  const now = deps.now ?? nowSec();
  const staking = cfg.addresses.staking;
  if (!staking) throw new BacError('addresses.staking 没配', 'bad_config');

  const epoch = Number(args.epoch ?? (epochOf(now) - 1));
  const age = now - (epoch + 2) * 86400;
  if (age > REWARD_CLAIM_WINDOW) {
    log.warn(`纪元 ${epoch} 已经过去 ${fmtDuration(age)}，很可能超过了 30 天领取窗口（已被 sweepExpired 退回奖池）`);
  }

  // 1) 按序结算：把 lastRewardEpoch+1 .. epoch 补齐
  let last = Number(await readCall(bsc, ifaceStaking, staking, 'lastRewardEpoch', []));
  log.info(`链上 lastRewardEpoch = ${last}，要领的是纪元 ${epoch}`);
  if (epoch > last) {
    const missing = epoch - last;
    if (missing > (args.maxSettle ?? 30)) {
      throw new BacError(
        `要补 ${missing} 个纪元的 settleEpochRewards 才轮得到 ${epoch}，超过了 --max-settle 上限。`
        + ' 这通常意味着很久没人结算过；确认一下再用 --max-settle 放大', 'too_many');
    }
    for (let e = last + 1; e <= epoch; e++) {
      const r = await epochReward(bsc, staking, e);
      if (r.settled) { log.info(`纪元 ${e} 已结算，跳过`); continue; }
      log.info(`settleEpochRewards(${e})（无许可，谁都能调；非 FINAL 的纪元 pot = 0，只推进游标）`);
      const data = ifaceStaking.encodeFunctionData('settleEpochRewards', [BigInt(e)]);
      await sendTx(bsc, wallet, { to: staking, data, log, dryRun: !!args.dryRun, sleep: deps.sleep });
      if (args.dryRun) { log.warn('--dry-run：后面的纪元不再逐个模拟'); break; }
    }
    last = Number(await readCall(bsc, ifaceStaking, staking, 'lastRewardEpoch', []));
  }

  // 2) 查这一纪元我有多少
  const mine = await readCall(bsc, ifaceStaking, staking, 'rewardOf', [BigInt(epoch), wallet.address]);
  const pot = await epochReward(bsc, staking, epoch);
  log.info(`纪元 ${epoch}：奖池 ${fmtUnits(pot.pot)} BNB，总权重 ${fmtUnits(pot.weight)}，`
    + `你的份额 ${fmtUnits(mine)} BNB`);
  if (mine === 0n) {
    log.warn('这一纪元你没有可领的：要么没揭示、要么报错了根、要么这个纪元没有奖池（注入是自愿的，不是强制分账）');
    return { ok: true, claimed: 0n };
  }

  // 3) 领
  const data = ifaceStaking.encodeFunctionData('claimReward', [BigInt(epoch), wallet.address]);
  const r = await sendTx(bsc, wallet, { to: staking, data, log, dryRun: !!args.dryRun, sleep: deps.sleep });
  if (!args.dryRun) {
    const rec = store.read(epoch);
    if (rec) store.write({ ...rec, claimedTx: r.hash });
    log.ok(`已领 ${fmtUnits(mine)} BNB（打到 payout 地址）`);
  }
  return { ok: true, claimed: mine };
}
