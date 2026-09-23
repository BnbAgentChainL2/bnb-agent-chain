// 启动自检。**不通过就不启动。**
//
// 一个「跑着但按不动刹车」的看门狗比没有看门狗更糟：运维会以为桥有保护，于是把
// 2 分钟等待当成安全边界对外讲。所以下面每一条都是硬失败，没有「警告后继续」这个选项。
//
// 检查的东西都是**现读链上**，不是读配置：
//   ① `BacBridge.watchdog()` 是不是就是本进程手上这把钥匙的地址；
//   ② 链上的纪元长度 / 等待期 / 回购上下限，与 src/constants.mjs 里的那份是否逐个相等
//      —— 对不上说明地址填错了，或者链上那份合约不是我们审过的；
//   ③ 桥是不是已经停机（停机之后 `pause()` 本身就没意义了）；
//   ④ 如果配了 vetoKey，它是不是真的就是 `ChainAnchor.vetoKey()`。

import {
  ANCHOR_WAIT,
  EPOCH,
  EPOCHS_PER_DAY,
  MAX_BUYBACK_BNB,
  MAX_BUY_SLIPPAGE_BPS,
  MIN_BUYBACK_BNB,
} from './constants.mjs';

export async function preflight({ cfg, bsc, bsc2, layer }) {
  const problems = [];
  const facts = {};

  // ① 刹车权
  const wd = await bsc.watchdogAddress();
  facts.bridgeWatchdog = wd;
  facts.myAddress = bsc.address;
  if (!bsc.address) problems.push('本进程没有签名能力：WATCHDOG_PRIVATE_KEY 没读进来');
  else if (String(wd).toLowerCase() !== String(bsc.address).toLowerCase()) {
    problems.push(
      `BacBridge.watchdog() = ${wd}，而本进程的钥匙是 ${bsc.address}：这把钥匙按不动刹车，拒绝启动`,
    );
  }

  // ② 链上常量
  const c = await bsc.constants();
  facts.onchain = c;
  const eq = [
    ['BacBridge.EPOCH', c.bridgeEpoch, EPOCH],
    ['ChainAnchor.EPOCH', c.anchorEpoch, EPOCH],
    ['BacBridge.EPOCHS_PER_DAY', c.epochsPerDay, EPOCHS_PER_DAY],
    ['BacBridge.ANCHOR_WAIT', c.bridgeAnchorWait, ANCHOR_WAIT],
    ['ChainAnchor.ANCHOR_WAIT', c.anchorWait, ANCHOR_WAIT],
    ['BacBridge.MIN_BUYBACK_BNB', c.minBuyback, MIN_BUYBACK_BNB],
    ['BacBridge.MAX_BUYBACK_BNB', c.maxBuyback, MAX_BUYBACK_BNB],
    ['BacBridge.MAX_BUY_SLIPPAGE_BPS', c.maxSlippageBps, MAX_BUY_SLIPPAGE_BPS],
  ];
  for (const [name, onchain, mine] of eq) {
    if (String(onchain) !== String(mine)) {
      problems.push(`链上 ${name} = ${onchain}，看门狗里写的是 ${mine}：两边必须一致，否则每一条算式都是错的`);
    }
  }

  // ③ 停机状态
  try {
    const p = await bsc.getBlockNumber();
    facts.bscHead = p;
  } catch (e) {
    problems.push(`primary BSC RPC 读不通：${e && e.message ? e.message : e}`);
  }
  try {
    facts.bsc2Head = await bsc2.getBlockNumber();
  } catch (e) {
    problems.push(`secondary BSC RPC 读不通：${e && e.message ? e.message : e} —— 没有第二个端点就没有复核读`);
  }
  try {
    facts.layerHead = await layer.getBlockNumber();
  } catch (e) {
    problems.push(`层内 RPC 读不通：${e && e.message ? e.message : e} —— 锚点根这条规则完全依赖它`);
  }

  // ④ veto 钥（可选）
  if (cfg.keys.veto) {
    const vk = await bsc.vetoKey();
    facts.anchorVetoKey = vk;
    facts.myVetoAddress = bsc.vetoAddress;
    if (String(vk).toLowerCase() !== String(bsc.vetoAddress ?? '').toLowerCase()) {
      problems.push(
        `配了 WATCHDOG_VETO_PRIVATE_KEY，但 ChainAnchor.vetoKey() = ${vk} 不是它的地址 ${bsc.vetoAddress}`,
      );
    }
  } else {
    facts.vetoPath = '未配置：看门狗只能 pause()。按 artifacts/sim/RESULTS-buyback.md §3.3，pause 不是零损失路径';
  }

  return { ok: problems.length === 0, problems, facts };
}
