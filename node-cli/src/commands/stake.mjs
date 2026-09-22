// BSC 侧的钱相关命令：stake / register / unstake / withdraw / retire。
// 这几条一律**先打印将要发的交易，加 --yes 才真发**（03 §6）。

import fsReal from 'node:fs';
import { getAddress, parseUnits } from 'ethers';
import { readConfig } from '../config.mjs';
import { Rpc } from '../rpc.mjs';
import { ifaceErc20, ifaceStaking, loadSigner, nodeIdHash, readCall, sendTx, stakeOf } from '../chain.mjs';
import { ENV_VALIDATOR_KEY, MIN_STAKE, UNSTAKE_COOLDOWN } from '../constants.mjs';
import { BacError, fmtBeijing, fmtDuration, fmtUnits, nowSec } from '../util.mjs';

function ctx(args, deps) {
  const fs = deps.fs || fsReal;
  const cfg = readConfig(args.home, { fsImpl: fs });
  const bsc = deps.bscRpc || new Rpc(cfg.bscRpc, { fetchImpl: deps.fetchImpl, label: 'BSC' });
  const wallet = deps.wallet || loadSigner(ENV_VALIDATOR_KEY, deps.env || process.env);
  const dryRun = !args.yes;
  return { fs, cfg, bsc, wallet, dryRun };
}

export async function stake(args, deps = {}) {
  const log = deps.log;
  const { cfg, bsc, wallet, dryRun } = ctx(args, deps);
  const staking = cfg.addresses.staking, token = cfg.addresses.bacToken;
  if (!staking || !token) throw new BacError('addresses.staking / addresses.bacToken 没配', 'bad_config');
  const amount = parseUnits(String(args.amount), 18);
  if (amount <= 0n) throw new BacError('--amount 必须大于 0', 'bad_arg');

  const bal = await readCall(bsc, ifaceErc20, token, 'balanceOf', [wallet.address]);
  log.info(`你的 BAC 余额 ${fmtUnits(bal)}，要质押 ${fmtUnits(amount)}`);
  if (bal < amount) throw new BacError('余额不够', 'insufficient');
  if (amount < MIN_STAKE) {
    log.warn(`MIN_STAKE 是 ${fmtUnits(MIN_STAKE)} BAC，少于这个数注册不了节点（质押本身不会 revert）`);
  }

  // 1) 精确额度授权，不做无限授权
  const allow = await readCall(bsc, ifaceErc20, token, 'allowance', [wallet.address, staking]);
  if (allow < amount) {
    log.info(`授权 ${fmtUnits(amount)} BAC 给 ValidatorStaking（精确额度，不是无限授权）`);
    const data = ifaceErc20.encodeFunctionData('approve', [staking, amount]);
    await sendTx(bsc, wallet, { to: token, data, log, dryRun, sleep: deps.sleep });
  } else log.ok('已有足够授权，跳过 approve');

  // 2) 质押
  const data = ifaceStaking.encodeFunctionData('stake', [amount]);
  const r = await sendTx(bsc, wallet, { to: staking, data, log, dryRun, sleep: deps.sleep });
  if (dryRun) log.warn('以上都是 --dry-run。确认无误后加 --yes 真发');
  else log.ok(`已质押 ${fmtUnits(amount)} BAC`);
  return { ok: true, tx: r.hash };
}

export async function register(args, deps = {}) {
  const log = deps.log;
  const { cfg, bsc, wallet, dryRun } = ctx(args, deps);
  const staking = cfg.addresses.staking;
  if (!staking) throw new BacError('addresses.staking 没配', 'bad_config');
  const nodeId = args.nodeId || cfg.nodeId;
  if (!nodeId) throw new BacError('要给节点起个名字：--node-id my-node-01', 'bad_arg');
  const enode = args.enode || cfg.enode;
  if (!enode || !/^enode:\/\/[0-9a-fA-F]{128}@[^:]+:\d+$/.test(enode)) {
    throw new BacError(
      '--enode 没给或格式不对。bac-node init 会打印你自己的 enode（需要 --p2p-host 填公网 IP）', 'bad_arg');
  }
  const payout = getAddress(args.payout || cfg.payout || wallet.address);

  const s = await stakeOf(bsc, staking, wallet.address);
  const nodes = Number(await readCall(bsc, ifaceStaking, staking, 'nodesOf', [wallet.address]));
  const need = MIN_STAKE * BigInt(nodes + 1);
  log.info(`当前质押 ${fmtUnits(s.staked)} BAC，已有 ${nodes} 个节点，再注册一个需要 ${fmtUnits(need)} BAC`);
  if (s.staked < need) {
    throw new BacError(
      `质押不够：每个 nodeIdHash 都要一份独立达标的 MIN_STAKE。先 bac-node stake --amount ${
        fmtUnits(need - s.staked, 18, 0)}`, 'insufficient');
  }

  const hash = nodeIdHash(nodeId);
  log.info(`nodeId "${nodeId}" → nodeIdHash ${hash}`);
  log.info(`enode  ${enode}`);
  log.info(`payout ${payout}`);
  log.warn('权重按**地址**算，不按节点算：同一个地址注册多个节点不会让你的见证权重或奖励变成多份');

  const data = ifaceStaking.encodeFunctionData('registerNode', [hash, enode, payout]);
  const r = await sendTx(bsc, wallet, { to: staking, data, log, dryRun, sleep: deps.sleep });
  if (dryRun) log.warn('以上是 --dry-run。确认无误后加 --yes 真发');
  return { ok: true, tx: r.hash, nodeIdHash: hash };
}

export async function unstake(args, deps = {}) {
  const log = deps.log;
  const { cfg, bsc, wallet, dryRun } = ctx(args, deps);
  const staking = cfg.addresses.staking;
  if (!staking) throw new BacError('addresses.staking 没配', 'bad_config');
  const amount = parseUnits(String(args.amount), 18);

  const s = await stakeOf(bsc, staking, wallet.address);
  const nodes = Number(await readCall(bsc, ifaceStaking, staking, 'nodesOf', [wallet.address]));
  const left = s.staked - amount;
  log.info(`质押 ${fmtUnits(s.staked)} → ${fmtUnits(left)}，你有 ${nodes} 个节点，`
    + `合约要求剩余 >= ${fmtUnits(MIN_STAKE * BigInt(nodes))}`);
  if (left < MIN_STAKE * BigInt(nodes)) {
    throw new BacError('减仓后覆盖不住你注册的节点数，合约会 revert。先 bac-node retire --node-id <名字>', 'blocked');
  }
  log.info(`冷却 ${fmtDuration(UNSTAKE_COOLDOWN)}，之后用 bac-node withdraw 取回。v1 没有罚没，本金照样取回`);

  const data = ifaceStaking.encodeFunctionData('requestUnstake', [amount]);
  const r = await sendTx(bsc, wallet, { to: staking, data, log, dryRun, sleep: deps.sleep });
  if (dryRun) log.warn('以上是 --dry-run。确认无误后加 --yes 真发');
  return { ok: true, tx: r.hash };
}

export async function withdraw(args, deps = {}) {
  const log = deps.log;
  const { cfg, bsc, wallet, dryRun } = ctx(args, deps);
  const staking = cfg.addresses.staking;
  const now = deps.now ?? nowSec();
  const s = await stakeOf(bsc, staking, wallet.address);
  if (s.pending === 0n) { log.warn('没有在冷却中的解押'); return { ok: true }; }
  log.info(`解押中 ${fmtUnits(s.pending)} BAC，解锁时间 ${fmtBeijing(s.unlockAt)}`);
  if (now < s.unlockAt) {
    throw new BacError(`还差 ${fmtDuration(s.unlockAt - now)} 才到解锁时间`, 'too_early');
  }
  const to = getAddress(args.to || cfg.payout || wallet.address);
  const data = ifaceStaking.encodeFunctionData('withdrawUnstaked', [to]);
  const r = await sendTx(bsc, wallet, { to: staking, data, log, dryRun, sleep: deps.sleep });
  if (dryRun) log.warn('以上是 --dry-run。确认无误后加 --yes 真发');
  return { ok: true, tx: r.hash };
}

export async function retire(args, deps = {}) {
  const log = deps.log;
  const { cfg, bsc, wallet, dryRun } = ctx(args, deps);
  const nodeId = args.nodeId || cfg.nodeId;
  if (!nodeId) throw new BacError('--node-id 没给', 'bad_arg');
  const data = ifaceStaking.encodeFunctionData('retireNode', [nodeIdHash(nodeId)]);
  const r = await sendTx(bsc, wallet, { to: cfg.addresses.staking, data, log, dryRun, sleep: deps.sleep });
  if (dryRun) log.warn('以上是 --dry-run。确认无误后加 --yes 真发');
  return { ok: true, tx: r.hash };
}
