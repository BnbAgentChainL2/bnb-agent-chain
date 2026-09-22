// 合约读写：用 ethers 的 Interface 编解码，用我们自己的 Rpc 发送。
// 好处是测试里注入一个假 Rpc 就能跑完整条路径，不需要网络、不需要节点。
// 私钥：只在这一个文件里从环境变量按名字读，用完不打印、不返回、不落盘。

import { Interface, Wallet, keccak256, toUtf8Bytes, getAddress } from 'ethers';
import { VALIDATOR_STAKING_ABI, CHAIN_ANCHOR_ABI, ERC20_ABI, ANCHOR_STATE } from './abi.mjs';
import { BSC_CHAIN_ID, ENV_VALIDATOR_KEY } from './constants.mjs';
import { BacError } from './util.mjs';

export const ifaceStaking = new Interface(VALIDATOR_STAKING_ABI);
export const ifaceAnchor = new Interface(CHAIN_ANCHOR_ABI);
export const ifaceErc20 = new Interface(ERC20_ABI);

export function nodeIdHash(nodeId) { return keccak256(toUtf8Bytes(String(nodeId))); }

/** 只读调用 */
export async function readCall(rpc, iface, to, fn, args = []) {
  if (!to) throw new BacError(`合约地址没配，无法调用 ${fn}`, 'bad_config');
  const data = iface.encodeFunctionData(fn, args);
  const raw = await rpc.ethCall(to, data);
  const out = iface.decodeFunctionResult(fn, raw);
  return out.length === 1 ? out[0] : out;
}

/** 从环境变量按名字取签名者。**只返回钱包对象，绝不返回或打印私钥。** */
export function loadSigner(envName = ENV_VALIDATOR_KEY, env = process.env) {
  const key = env[envName];
  if (!key) {
    throw new BacError(
      `环境变量 ${envName} 没设：需要一个 BSC 私钥来发交易。`
      + ` 写进 validator.env（chmod 600），不要写进 compose.yml，不要贴进聊天窗口`, 'no_key');
  }
  let w;
  try { w = new Wallet(key); }
  catch { throw new BacError(`${envName} 不是合法的私钥（不打印内容）`, 'bad_key'); }
  return w;
}

/**
 * 发一笔 BSC 交易。**一次只发一笔**，发完等 1 个确认再返回（和中继同一条纪律）。
 * dryRun 时只打印将要发的东西，不签名、不广播。
 */
export async function sendTx(rpc, wallet, { to, data, value = 0n, gasLimit, log, dryRun = false,
                                            chainId = BSC_CHAIN_ID, confirmations = 1,
                                            pollMs = 3000, timeoutMs = 300000, sleep }) {
  const from = wallet.address;
  if (!gasLimit) {
    try {
      const est = await rpc.estimateGas({ from, to, data, value: '0x' + BigInt(value).toString(16) });
      gasLimit = (est * 12n) / 10n;      // 20% 余量
    } catch (e) {
      throw new BacError(`估算 gas 失败（多半是合约会 revert）：${e.message}`, 'estimate_failed');
    }
  }
  const gasPrice = await rpc.gasPrice();
  const nonce = await rpc.getTransactionCount(from, 'pending');
  const tx = { to, data, value: BigInt(value), gasLimit: BigInt(gasLimit), gasPrice, nonce, chainId, type: 0 };

  if (log) {
    log.info(`将要发的交易：`);
    log.info(`  from     ${from}`);
    log.info(`  to       ${to}`);
    log.info(`  value    ${tx.value} wei`);
    log.info(`  gasLimit ${tx.gasLimit}   gasPrice ${gasPrice} wei   nonce ${nonce}`);
    log.info(`  data     ${data.length > 74 ? data.slice(0, 74) + '…' : data}`);
  }
  if (dryRun) {
    if (log) log.warn('这是 --dry-run，没有广播。确认无误后加 --yes 再跑一次');
    return { dryRun: true, hash: null };
  }

  const raw = await wallet.signTransaction(tx);
  const hash = await rpc.sendRawTransaction(raw);
  if (log) log.ok(`已广播 ${hash}`);
  if (confirmations === 0) return { hash, receipt: null };

  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const rc = await rpc.getTransactionReceipt(hash);
    if (rc) {
      const ok = BigInt(rc.status ?? '0x1') === 1n;
      if (!ok) throw new BacError(`交易 ${hash} 上链了但失败了（status = 0）`, 'tx_reverted');
      if (log) log.ok(`已上链，区块 ${Number(BigInt(rc.blockNumber))}`);
      return { hash, receipt: rc };
    }
    await wait(pollMs);
  }
  throw new BacError(`交易 ${hash} 超过 ${timeoutMs / 1000} 秒还没上链：不要重发，先去 BscScan 查它`, 'tx_timeout');
}

// ——— 具体的合约读 ———

export async function getAnchor(rpc, anchorAddr, epoch) {
  const a = await readCall(rpc, ifaceAnchor, anchorAddr, 'getAnchor', [BigInt(epoch)]);
  return {
    exitRoot: a.exitRoot, l2BlockHash: a.l2BlockHash,
    l2Block: Number(a.l2Block), postedAt: Number(a.postedAt), finalizedAt: Number(a.finalizedAt),
    creditedInEpoch: a.creditedInEpoch, exitCreditsInEpoch: a.exitCreditsInEpoch,
    feeBurnedInEpoch: a.feeBurnedInEpoch, circulating: a.circulating,
    exitCount: Number(a.exitCount), agreeingCount: Number(a.agreeingCount),
    state: ANCHOR_STATE[Number(a.state)] ?? `UNKNOWN(${a.state})`,
  };
}

export async function stakeOf(rpc, staking, who) {
  const r = await readCall(rpc, ifaceStaking, staking, 'stakeOf', [getAddress(who)]);
  return { staked: r[0], pending: r[1], unlockAt: Number(r[2]) };
}

export async function nodeOf(rpc, staking, hash) {
  const r = await readCall(rpc, ifaceStaking, staking, 'nodeOf', [hash]);
  return { validator: r[0], payout: r[1], enodeURI: r[2], active: r[3], strikes: Number(r[4]) };
}

export async function epochReward(rpc, staking, epoch) {
  const r = await readCall(rpc, ifaceStaking, staking, 'epochReward', [BigInt(epoch)]);
  return { pot: r[0], weight: r[1], rate: r[2], settled: r[3] };
}
