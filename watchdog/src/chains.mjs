// 两条链的适配器。**所有网络调用只出现在这个文件里**，其它模块拿到的都是普通数据，
// 于是每一条规则、整个状态机、重启续传都能用假 provider 离线测到底（test/*.test.mjs）。
//
// 适配器接口（测试里的 fake 必须实现同一套方法名）：
//   bsc:   getBlockNumber() / anchorEvents(from,to) / getAnchor(epoch) / lastPostedEpoch() /
//          bridgeState(blockTag) / bridgeEvents(from,to) / lockedIn(from,to) /
//          exitClaimedIn(from,to) / referencePrice(blockTag, spend) / watchdogAddress() /
//          constants() / sendPause() / sendVeto(epoch, reasonHash) / vetoKey()
//   layer: getBlockNumber() / getBlock(n) / exitLogs(from,to) / creditLogs(from,to) /
//          balance(addr, blockTag) / seen(depositId)

import { Contract, Interface, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import {
  BAC_BRIDGE_ABI,
  CHAIN_ANCHOR_ABI,
  ERC20_ABI,
  L2_BRIDGE_ABI,
  PANCAKE_ROUTER_ABI,
  SEL_TOKEN_STATE,
  WBNB,
} from './abi.mjs';
import { ANCHOR_STATE, BSC_CHAIN_ID, BUYBACK_QUOTE_REF, LAYER_CHAIN_ID } from './constants.mjs';
import { log } from './log.mjs';

const bridgeIface = new Interface(BAC_BRIDGE_ABI);
const anchorIface = new Interface(CHAIN_ANCHOR_ABI);
const l2Iface = new Interface(L2_BRIDGE_ABI);
const routerIface = new Interface(PANCAKE_ROUTER_ABI);

/** `getTokenV8Safe(address)` 的 4 字节选择器，与 BacBridge 里那一行同源 */
const SEL_TOKEN_STATE_4 = keccak256(toUtf8Bytes(SEL_TOKEN_STATE)).slice(0, 10);

/** 分段拉日志：公共 RPC 的 eth_getLogs 窗口有限（BSC 3000 块，Besu 默认 5000） */
async function getLogsChunked(provider, filter, from, to, range) {
  const out = [];
  for (let start = from; start <= to; start += range) {
    const end = Math.min(to, start + range - 1);
    const logs = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
    for (const l of logs) out.push(l);
  }
  return out;
}

// =============================================================== BSC ========

/**
 * @param {object} cfg
 * @param {'primary'|'secondary'} which 复核读走 secondary —— 两个端点必须是不同的机器，
 *        否则「复核」只是把同一个错误读了两遍（config.mjs 里已经硬性拦住相同的 URL）。
 * @param {boolean} withSigner 只有 primary 需要签名能力；secondary 永远是只读的
 */
export function makeBsc(cfg, which = 'primary', withSigner = true) {
  const url = which === 'primary' ? cfg.rpc.bsc : cfg.rpc.bsc2;
  const provider = new JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true });
  const wallet = withSigner && which === 'primary' ? new Wallet(cfg.keys.watchdog, provider) : null;
  const vetoWallet = withSigner && which === 'primary' && cfg.keys.veto ? new Wallet(cfg.keys.veto, provider) : null;

  const bridgeRO = new Contract(cfg.addresses.bacBridge, BAC_BRIDGE_ABI, provider);
  const anchorRO = new Contract(cfg.addresses.chainAnchor, CHAIN_ANCHOR_ABI, provider);
  const token = new Contract(cfg.addresses.bacToken, ERC20_ABI, provider);
  const router = new Contract(cfg.addresses.pancakeRouter ?? WBNB, PANCAKE_ROUTER_ABI, provider);

  const range = cfg.poll.bscLogRange;

  return {
    which,
    url,
    address: wallet ? wallet.address : null,
    vetoAddress: vetoWallet ? vetoWallet.address : null,

    async getBlockNumber() {
      return await provider.getBlockNumber();
    },

    async getBlockTimestamp(n) {
      const b = await provider.getBlock(n);
      return b ? Number(b.timestamp) : null;
    },

    /** ChainAnchor 的四个事件，按区块 / 日志序排好 */
    async anchorEvents(from, to) {
      const logs = await getLogsChunked(provider, { address: cfg.addresses.chainAnchor }, from, to, range);
      const out = [];
      for (const lg of logs) {
        let parsed;
        try {
          parsed = anchorIface.parseLog({ topics: [...lg.topics], data: lg.data });
        } catch {
          continue; // 不认识的事件：不猜，跳过
        }
        out.push({ name: parsed.name, args: parsed.args, blockNumber: lg.blockNumber, txHash: lg.transactionHash, logIndex: lg.index });
      }
      return out;
    },

    async getAnchor(epoch) {
      const a = await anchorRO.getAnchor(BigInt(epoch));
      return {
        exitRoot: a.exitRoot,
        l2BlockHash: a.l2BlockHash,
        l2Block: Number(a.l2Block),
        postedAt: Number(a.postedAt),
        finalizedAt: Number(a.finalizedAt),
        creditedInEpoch: BigInt(a.creditedInEpoch),
        exitCreditsInEpoch: BigInt(a.exitCreditsInEpoch),
        feeBurnedInEpoch: BigInt(a.feeBurnedInEpoch),
        circulating: BigInt(a.circulating),
        exitCount: Number(a.exitCount),
        agreeingCount: Number(a.agreeingCount),
        state: ANCHOR_STATE[Number(a.state)] ?? 'UNKNOWN',
      };
    },

    async lastPostedEpoch() {
      return Number(await anchorRO.lastPostedEpoch());
    },

    /** 桥的全部标量，**钉在同一个区块高度上**读（撕裂的读数 = 每次 collect 都误报） */
    async bridgeState(blockTag = 'latest') {
      const o = { blockTag };
      const [lockedBac, totalBurned, buybackBac, owedTotal, reservedTotal, issued, exited, bnbBalance, tokenBalance] =
        await Promise.all([
          bridgeRO.lockedBac(o),
          bridgeRO.totalBurned(o),
          bridgeRO.buybackBac(o),
          bridgeRO.owedTotal(o),
          bridgeRO.reservedTotal(o),
          bridgeRO.totalCreditsIssued(o),
          bridgeRO.totalCreditsExited(o),
          bridgeRO.bnbBalance(o),
          token.balanceOf(cfg.addresses.bacBridge, o),
        ]);
      return {
        block: typeof blockTag === 'number' ? blockTag : await provider.getBlockNumber(),
        lockedBac,
        totalBurned,
        buybackBac,
        owedTotal,
        reservedTotal,
        totalCreditsIssued: issued,
        totalCreditsExited: exited,
        bnbBalance,
        tokenBalance,
      };
    },

    /** 桥的全部事件，已经按「影子账本需要的汇总」与「逐笔清单」两种形状返回 */
    async bridgeEvents(from, to) {
      const logs = await getLogsChunked(provider, { address: cfg.addresses.bacBridge }, from, to, range);
      const flows = { locked: 0n, burned: 0n, bought: 0n, sweptBac: 0n, collected: 0n, haltPaid: 0n, escapeBac: 0n, accepted: 0n, spentBnb: 0n };
      const boughtBack = [];
      const settled = [];
      const exits = [];
      const paused = [];
      for (const lg of logs) {
        let p;
        try {
          p = bridgeIface.parseLog({ topics: [...lg.topics], data: lg.data });
        } catch {
          continue;
        }
        const meta = { blockNumber: lg.blockNumber, txHash: lg.transactionHash, logIndex: lg.index };
        switch (p.name) {
          case 'Locked':
            flows.locked += BigInt(p.args.measured);
            break;
          case 'LockedBurned':
            flows.burned += BigInt(p.args.amount);
            break;
          case 'BoughtBack':
            flows.bought += BigInt(p.args.bacBought);
            flows.spentBnb += BigInt(p.args.bnbSpent);
            boughtBack.push({ ...meta, by: p.args.by, venue: Number(p.args.venue), bnbSpent: BigInt(p.args.bnbSpent), bacBought: BigInt(p.args.bacBought), buybackBacAfter: BigInt(p.args.buybackBacAfter) });
            break;
          case 'UntrackedBac':
            flows.sweptBac += BigInt(p.args.amount);
            break;
          case 'Collected':
            flows.collected += BigInt(p.args.amount);
            break;
          case 'OwedPaidAfterHalt':
            flows.haltPaid += BigInt(p.args.amount);
            break;
          case 'EscapeCollected':
            flows.escapeBac += BigInt(p.args.bacPaid);
            break;
          case 'ReleaseReceived':
          case 'Untracked':
            flows.accepted += BigInt(p.args.amount);
            break;
          case 'EpochSettled':
            settled.push({ ...meta, epoch: Number(p.args.epoch), pot: BigInt(p.args.pot), owedTotalAfter: BigInt(p.args.owedTotalAfter), releaseBps: Number(p.args.releaseBps), skipped: Boolean(p.args.skipped) });
            break;
          case 'ExitClaimed':
            exits.push({ ...meta, anchorEpoch: Number(p.args.anchorEpoch), exitId: BigInt(p.args.exitId), agentId: BigInt(p.args.agentId), to: p.args.to, credits: BigInt(p.args.credits), lockedBacAmt: BigInt(p.args.lockedBacAmt) });
            break;
          case 'Paused':
          case 'Unpaused':
            paused.push({ ...meta, name: p.name, by: p.args.by, cumulative: Number(p.args.cumulative) });
            break;
          default:
            break;
        }
      }
      return { flows, boughtBack, settled, exits, paused };
    },

    /** 在途存款：一段区块里的 Locked（金额 + 幂等键需要的 tx / logIndex） */
    async lockedIn(from, to) {
      const topic = bridgeIface.getEvent('Locked').topicHash;
      const logs = await getLogsChunked(provider, { address: cfg.addresses.bacBridge, topics: [topic] }, from, to, range);
      return logs.map((lg) => {
        const p = bridgeIface.parseLog({ topics: [...lg.topics], data: lg.data });
        return { credits: BigInt(p.args.credits), txHash: lg.transactionHash, logIndex: lg.index, blockNumber: lg.blockNumber };
      });
    },

    /** 读数偏斜容差用：一段区块里已领取的退出积分 */
    async exitClaimedIn(from, to) {
      const topic = bridgeIface.getEvent('ExitClaimed').topicHash;
      const logs = await getLogsChunked(provider, { address: cfg.addresses.bacBridge, topics: [topic] }, from, to, range);
      let total = 0n;
      for (const lg of logs) total += BigInt(bridgeIface.parseLog({ topics: [...lg.topics], data: lg.data }).args.credits);
      return total;
    },

    /**
     * 在 `blockTag` 上独立复算一次参考价（回购规则用）。
     * 读法与 BacBridge._venue 完全一致：从 `getTokenV8Safe` 的 returndata 里挖三个 word，
     * 毕业后改读 PancakeSwap 的 `getAmountsOut`。**读不到就返回 null，绝不猜。**
     */
    async referencePrice(blockTag, spend) {
      if (!cfg.addresses.flapPortal) return null;
      try {
        const data = SEL_TOKEN_STATE_4 + cfg.addresses.bacToken.toLowerCase().replace('0x', '').padStart(64, '0');
        const ret = await provider.call({ to: cfg.addresses.flapPortal, data, blockTag });
        if (!ret || ret.length < 2 + 576 * 2) return null;
        const word = (k) => BigInt('0x' + ret.slice(2 + k * 64, 2 + (k + 1) * 64));
        const status = word(0);
        const price = word(3);
        const buyTaxBps = word(12);
        if (buyTaxBps >= 10000n) return null;
        if (status === 1n) {
          if (price === 0n) return null;
          return { venue: 1, expectedGross: (BigInt(spend) * 10n ** 18n) / price, buyTaxBps, at: blockTag };
        }
        if (status !== 4n) return null;
        const path = [WBNB, cfg.addresses.bacToken];
        const amounts = await router.getAmountsOut(BUYBACK_QUOTE_REF, path, { blockTag });
        const refOut = BigInt(amounts[1]);
        if (refOut === 0n) return null;
        return { venue: 2, expectedGross: (BigInt(spend) * refOut) / BUYBACK_QUOTE_REF, buyTaxBps, at: blockTag };
      } catch (e) {
        // 绝大多数情况是「公共 RPC 不是归档节点」。这不是异常，是已知的能力缺口。
        log.debug('参考价读取失败（多半是非归档 RPC）', { blockTag, err: e });
        return null;
      }
    },

    async watchdogAddress() {
      return await bridgeRO.watchdog();
    },

    async vetoKey() {
      return await anchorRO.vetoKey();
    },

    /** 启动自检要核对的链上常量 */
    async constants() {
      const [bEpoch, bPerDay, bWait, minB, maxB, slip, aEpoch, aWait] = await Promise.all([
        bridgeRO.EPOCH(),
        bridgeRO.EPOCHS_PER_DAY(),
        bridgeRO.ANCHOR_WAIT(),
        bridgeRO.MIN_BUYBACK_BNB(),
        bridgeRO.MAX_BUYBACK_BNB(),
        bridgeRO.MAX_BUY_SLIPPAGE_BPS(),
        anchorRO.EPOCH(),
        anchorRO.ANCHOR_WAIT(),
      ]);
      return {
        bridgeEpoch: Number(bEpoch),
        epochsPerDay: Number(bPerDay),
        bridgeAnchorWait: Number(bWait),
        minBuyback: BigInt(minB),
        maxBuyback: BigInt(maxB),
        maxSlippageBps: BigInt(slip),
        anchorEpoch: Number(aEpoch),
        anchorWait: Number(aWait),
      };
    },

    /** 刹车。**这是本进程唯一的写操作**（veto 只有在运维额外交钥匙时才存在）。 */
    async sendPause() {
      if (!wallet) throw new Error('secondary 适配器没有签名能力：复核读永远是只读的');
      const c = new Contract(cfg.addresses.bacBridge, BAC_BRIDGE_ABI, wallet);
      const tx = await c.pause();
      return { hash: tx.hash, wait: (ms) => provider.waitForTransaction(tx.hash, 1, ms) };
    },

    /**
     * 零损失路径：在 `postedAt + 120 s` 之前否决这个锚点。
     * 合约今天只允许 `admin` 或 `vetoKey` 调它（ChainAnchor.veto），看门狗没有这个权。
     * 只有运维照 artifacts/sim/RESULTS-buyback.md §3.3 B6 把 vetoKey 交给本进程时才可用。
     */
    async sendVeto(epoch, reasonHash) {
      if (!vetoWallet) return null;
      const c = new Contract(cfg.addresses.chainAnchor, CHAIN_ANCHOR_ABI, vetoWallet);
      const tx = await c.veto(BigInt(epoch), reasonHash);
      return { hash: tx.hash, wait: (ms) => provider.waitForTransaction(tx.hash, 1, ms) };
    },
  };
}

// ============================================================== 层内 =======

export function makeLayer(cfg, which = 'primary') {
  const url = which === 'primary' ? cfg.rpc.layer : (cfg.rpc.layer2 ?? cfg.rpc.layer);
  const provider = new JsonRpcProvider(url, LAYER_CHAIN_ID, { staticNetwork: true });
  const l2 = new Contract(cfg.addresses.l2Bridge, L2_BRIDGE_ABI, provider);
  const range = cfg.poll.layerLogRange;

  return {
    which,
    url,
    /** 层内只有一台官方节点时，secondary 与 primary 指向同一台 —— 调用方据此降级说明 */
    independent: which === 'primary' || Boolean(cfg.rpc.layer2),

    async getBlockNumber() {
      return await provider.getBlockNumber();
    },

    async getBlock(n) {
      const b = await provider.getBlock(n);
      return b ? { number: Number(b.number), hash: b.hash, timestamp: Number(b.timestamp) } : null;
    },

    async exitLogs(from, to) {
      const topic = l2Iface.getEvent('ExitBurned').topicHash;
      const logs = await getLogsChunked(provider, { address: cfg.addresses.l2Bridge, topics: [topic] }, from, to, range);
      return logs.map((lg) => {
        const p = l2Iface.parseLog({ topics: [...lg.topics], data: lg.data });
        return {
          exitId: BigInt(p.args.exitId),
          agentId: BigInt(p.args.agentId),
          to: p.args.bscRecipient,
          credits: BigInt(p.args.amount),
          epoch: Number(p.args.epoch),
          layerTxHash: lg.transactionHash,
          layerBlock: lg.blockNumber,
        };
      });
    },

    async creditLogs(from, to) {
      const topic = l2Iface.getEvent('CreditsMinted').topicHash;
      const logs = await getLogsChunked(provider, { address: cfg.addresses.l2Bridge, topics: [topic] }, from, to, range);
      return logs.map((lg) => {
        const p = l2Iface.parseLog({ topics: [...lg.topics], data: lg.data });
        return { depositId: p.args.depositId, amount: BigInt(p.args.amount), layerBlock: lg.blockNumber };
      });
    },

    async balance(address, blockTag = 'latest') {
      return await provider.getBalance(address, blockTag);
    },

    async seen(depositId) {
      return await l2.seen(depositId);
    },

    /** 层内累计已销毁的退出积分。与 BSC 的 `totalCreditsExited` 之差 = 在途退出 */
    async totalExited() {
      return BigInt(await l2.totalExited());
    },
  };
}
