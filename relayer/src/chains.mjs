// 两条链的适配器。**所有网络调用只出现在这个文件里**，其它模块拿到的都是纯数据，
// 于是每一条纪律（确认状态机、outbox、锚点排序、重启续传）都能用假 provider 离线测试。
//
// 适配器接口（测试里的 fake 必须实现同一套方法名）：
//   bsc:   snapshot(ts) / getBlockNumber() / scanLocked(from,to) / scanRegistry(from,to) /
//          verifySourceLog(src) / lastPostedEpoch() / anchorStateOf(epoch) /
//          feeGwei() / sendAnchor(job, opts) / waitMined(hash, ms) / balance(addr) / reads()
//   layer: getBlockNumber() / getBlock(n) / seen(depositId) / syncApplied(job) /
//          feeGwei() / sendCredit(job, opts) / sendSync(job, opts) / waitMined(hash, ms) /
//          exitLogs(from,to) / creditLogs(from,to) / balance(addr, blockTag)

import { Contract, Interface, JsonRpcProvider, Wallet } from 'ethers';
import { AGENT_REGISTRY_ABI, BAC_BRIDGE_ABI, CHAIN_ANCHOR_ABI, L2_BRIDGE_ABI, L2_GATE_ABI } from './abi.mjs';
import { log } from './log.mjs';

const bridgeIface = new Interface(BAC_BRIDGE_ABI);
const registryIface = new Interface(AGENT_REGISTRY_ABI);
const l2BridgeIface = new Interface(L2_BRIDGE_ABI);

const LOCKED_TOPIC = bridgeIface.getEvent('Locked').topicHash;

/** 方向 C 关心的五个 AgentRegistry 事件（03 §1.4） */
const SYNC_EVENTS = ['Activated', 'Dormant', 'Banned', 'AgentWalletSet', 'Retired'];

// ------------------------------------------------------------------- BSC ----

export function makeBscChain(cfg) {
  const pA = new JsonRpcProvider(cfg.rpc.bsc, 56, { staticNetwork: true });
  const pB = new JsonRpcProvider(cfg.rpc.bsc2, 56, { staticNetwork: true });
  const wallet = new Wallet(cfg.keys.bsc, pA);
  const bridge = new Contract(cfg.addresses.bacBridge, BAC_BRIDGE_ABI, pA);
  const registry = new Contract(cfg.addresses.agentRegistry, AGENT_REGISTRY_ABI, pA);
  const anchor = new Contract(cfg.addresses.chainAnchor, CHAIN_ANCHOR_ABI, wallet);

  async function safe(fn, label) {
    try {
      return await fn();
    } catch (e) {
      log.warn('BSC 读取失败', { label, err: e });
      return null;
    }
  }

  return {
    address: wallet.address,

    async getBlockNumber() {
      return await pA.getBlockNumber();
    },

    /**
     * 一次确认快照：两个独立 RPC 的 head 与 finalized，外加一次交叉核对。
     * 交叉核对 = 在**共同高度**（两边 finalized 的较小者）上比区块哈希。
     * 这是「两个独立 BSC RPC 给出一致的 finalized」这句话唯一可执行的读法：
     * 两个 RPC 的 finalized 高度天然会差几个块，比高度必然假阳性；比同一高度的哈希才是在问
     * 「你们俩在同一条链上吗」。
     */
    async snapshot(ts) {
      const [headA, headB] = await Promise.all([safe(() => pA.getBlockNumber(), 'headA'), safe(() => pB.getBlockNumber(), 'headB')]);
      const [fa, fb] = await Promise.all([
        safe(() => pA.getBlock('finalized'), 'finalizedA'),
        safe(() => pB.getBlock('finalized'), 'finalizedB'),
      ]);
      const finalizedA = fa ? { number: Number(fa.number), hash: fa.hash } : null;
      const finalizedB = fb ? { number: Number(fb.number), hash: fb.hash } : null;
      let crossCheck = 'unknown';
      if (finalizedA && finalizedB) {
        const h = Math.min(finalizedA.number, finalizedB.number);
        const [ba, bb] = await Promise.all([safe(() => pA.getBlock(h), 'crossA'), safe(() => pB.getBlock(h), 'crossB')]);
        if (ba && bb) crossCheck = ba.hash === bb.hash ? 'agree' : 'disagree';
      }
      return { ts, headA, headB, finalizedA, finalizedB, crossCheck };
    },

    /** 扫一段区块里的 BacBridge.Locked */
    async scanLocked(from, to) {
      const logs = await pA.getLogs({ address: cfg.addresses.bacBridge, topics: [LOCKED_TOPIC], fromBlock: from, toBlock: to });
      const out = [];
      for (const lg of logs) {
        const parsed = bridgeIface.parseLog({ topics: [...lg.topics], data: lg.data });
        const block = await pA.getBlock(lg.blockNumber);
        out.push({
          depositIdOnBsc: parsed.args.depositId,
          agentId: parsed.args.agentId,
          layerWallet: parsed.args.layerWallet,
          credits: parsed.args.credits,
          blockNumber: lg.blockNumber,
          blockHash: lg.blockHash,
          txHash: lg.transactionHash,
          logIndex: lg.index,
          blockTs: Number(block.timestamp),
        });
      }
      return out;
    },

    /** 扫一段区块里的 AgentRegistry 状态事件（方向 C） */
    async scanRegistry(from, to) {
      const topics = [SYNC_EVENTS.map((n) => registryIface.getEvent(n).topicHash)];
      const logs = await pA.getLogs({ address: cfg.addresses.agentRegistry, topics, fromBlock: from, toBlock: to });
      const out = [];
      for (const lg of logs) {
        const parsed = registryIface.parseLog({ topics: [...lg.topics], data: lg.data });
        const block = await pA.getBlock(lg.blockNumber);
        out.push({
          name: parsed.name,
          agentId: parsed.args.agentId,
          wallet: parsed.args.agentWallet ?? parsed.args.wallet ?? null,
          blockNumber: lg.blockNumber,
          blockHash: lg.blockHash,
          txHash: lg.transactionHash,
          logIndex: lg.index,
          blockTs: Number(block.timestamp),
        });
      }
      return out;
    },

    /** 当前状态：某个 agent 在 BSC 上的钱包与状态（方向 C 发送前现读，避免把过期状态写进层内） */
    async agentState(agentId) {
      // 一次 getAgent 读出结构体：钱包与状态必须来自**同一次**读，
      // 分两次读会读到跨区块的两个状态，方向 C 就可能把一个已经不存在的组合写进层内。
      const a = await registry.getAgent(agentId);
      return { wallet: a.agentWallet ?? a[1], status: Number(a.status ?? a[10]) };
    },

    /**
     * 发送前的二次核对（03 §1.1 第 2 条）：用 `eth_getTransactionReceipt` 重读源日志。
     * 收据不在了、或换了 blockHash、或那条日志不见了 → 该 job 变 orphaned，不发。
     */
    async verifySourceLog(src) {
      const r = await pA.getTransactionReceipt(src.txHash);
      if (!r) return { ok: false, reason: '收据不存在（交易已从规范链上消失）' };
      if (r.blockHash !== src.blockHash) return { ok: false, reason: `blockHash 变了：${r.blockHash} != ${src.blockHash}` };
      const hit = r.logs.find((l) => Number(l.index) === Number(src.logIndex));
      if (!hit) return { ok: false, reason: `收据里没有 logIndex=${src.logIndex}` };
      if (hit.address.toLowerCase() !== cfg.addresses.bacBridge.toLowerCase() && src.kind !== 'sync') {
        return { ok: false, reason: '日志地址与 BacBridge 不符' };
      }
      return { ok: true, reason: '源日志仍在规范链上' };
    },

    async lastPostedEpoch() {
      return Number(await anchor.lastPostedEpoch());
    },

    async anchorStateOf(epoch) {
      const a = await anchor.getAnchor(epoch);
      return ['NONE', 'POSTED', 'FINAL', 'VETOED', 'DISPUTED'][Number(a.state)];
    },

    async feeGwei() {
      const fd = await pA.getFeeData();
      return fd.gasPrice ?? 1000000000n;
    },

    /** 发锚点。一次只发一笔，nonce 由调用方在重发时复用（不做 nonce 管理器）。 */
    async sendAnchor(job, opts = {}) {
      const a = job.anchor;
      const tuple = {
        exitRoot: a.exitRoot,
        l2BlockHash: a.l2BlockHash,
        l2Block: BigInt(a.l2Block),
        postedAt: 0n, // 链上自己填
        finalizedAt: 0n,
        creditedInEpoch: BigInt(a.creditedInEpoch),
        exitCreditsInEpoch: BigInt(a.exitCreditsInEpoch),
        feeBurnedInEpoch: BigInt(a.feeBurnedInEpoch),
        circulating: BigInt(a.circulating),
        exitCount: BigInt(a.exitCount),
        agreeingCount: 0n,
        state: 0n,
      };
      const overrides = {};
      if (opts.nonce !== undefined && opts.nonce !== null) overrides.nonce = opts.nonce;
      if (opts.gasPrice) overrides.gasPrice = opts.gasPrice;
      const tx = await anchor.postAnchor(BigInt(job.epoch), tuple, overrides);
      return { hash: tx.hash, nonce: tx.nonce };
    },

    async waitMined(hash, ms) {
      return await pA.waitForTransaction(hash, 1, ms);
    },

    async balance(address) {
      return await pA.getBalance(address);
    },

    /** 对账用的两个 BSC 读数（03 §3.1） */
    async reconcileReads() {
      const [issued, exited] = await Promise.all([bridge.totalCreditsIssued(), bridge.totalCreditsExited()]);
      return { issued, exited };
    },

    async bridgeReads() {
      const [paused, halted, lastSettled, skipped, pool, owed, reserved] = await Promise.all([
        safe(() => bridge.isPaused(), 'isPaused'),
        safe(() => bridge.isHalted(), 'isHalted'),
        safe(() => bridge.lastSettledEpoch(), 'lastSettledEpoch'),
        safe(() => bridge.skippedEpochs(), 'skippedEpochs'),
        safe(() => bridge.poolBalance(), 'poolBalance'),
        safe(() => bridge.owedTotal(), 'owedTotal'),
        safe(() => bridge.reservedTotal(), 'reservedTotal'),
      ]);
      return { paused, halted, lastSettled, skipped, pool, owed, reserved };
    },
  };
}

// ----------------------------------------------------------------- 层内 ----

export function makeLayerChain(cfg) {
  const p = new JsonRpcProvider(cfg.rpc.layer, 56777, { staticNetwork: true });
  const wallet = new Wallet(cfg.keys.layer, p);
  const l2Bridge = new Contract(cfg.addresses.l2Bridge, L2_BRIDGE_ABI, wallet);
  const l2Gate = new Contract(cfg.addresses.l2Gate, L2_GATE_ABI, wallet);

  return {
    address: wallet.address,

    async getBlockNumber() {
      return await p.getBlockNumber();
    },

    async getBlock(n) {
      const b = await p.getBlock(n);
      return b ? { number: Number(b.number), hash: b.hash, timestamp: Number(b.timestamp) } : null;
    },

    /** 链上幂等键（03 §1.1 第 4 条）：已经 credit 过就别再发 */
    async seen(depositId) {
      return await l2Bridge.seen(depositId);
    },

    /**
     * 方向 C 的幂等兜底：`syncedAt(agentId) >= bscBlock` 说明这条（或更新的）状态已经写进去了。
     * `syncedAt` 不在 01 §8.2 的 ABI 列表里，所以读不到就退回比较 `statusOf(wallet)`。
     */
    async syncApplied(job) {
      try {
        const at = Number(await l2Gate.syncedAt(job.agentId));
        if (at >= job.bscBlock) return true;
      } catch {
        /* 合约没有这个 view，走下面的退路 */
      }
      try {
        const s = Number(await l2Gate.statusOf(job.wallet));
        return s === job.status;
      } catch {
        return false;
      }
    },

    async feeGwei() {
      const fd = await p.getFeeData();
      // zeroBaseFee（决策 #16）：层内全部 gas 费以 tips 形式进出块者，用 legacy gasPrice 最省事。
      return fd.gasPrice ?? 1000000000n;
    },

    async sendCredit(job, opts = {}) {
      const overrides = {};
      if (opts.nonce !== undefined && opts.nonce !== null) overrides.nonce = opts.nonce;
      if (opts.gasPrice) overrides.gasPrice = opts.gasPrice;
      const tx = await l2Bridge.credit(job.depositId, BigInt(job.agentId), job.to, BigInt(job.amount), overrides);
      return { hash: tx.hash, nonce: tx.nonce };
    },

    async sendSync(job, opts = {}) {
      const overrides = {};
      if (opts.nonce !== undefined && opts.nonce !== null) overrides.nonce = opts.nonce;
      if (opts.gasPrice) overrides.gasPrice = opts.gasPrice;
      const tx = await l2Gate.applySync(BigInt(job.agentId), job.wallet, job.status, BigInt(job.bscBlock), overrides);
      return { hash: tx.hash, nonce: tx.nonce };
    },

    async waitMined(hash, ms) {
      return await p.waitForTransaction(hash, 1, ms);
    },

    /** 某段区块里的 ExitBurned（锚点叶子的唯一来源） */
    async exitLogs(from, to) {
      const topic = l2BridgeIface.getEvent('ExitBurned').topicHash;
      const logs = await p.getLogs({ address: cfg.addresses.l2Bridge, topics: [topic], fromBlock: from, toBlock: to });
      return logs.map((lg) => {
        const parsed = l2BridgeIface.parseLog({ topics: [...lg.topics], data: lg.data });
        return {
          exitId: parsed.args.exitId,
          agentId: parsed.args.agentId,
          to: parsed.args.bscRecipient,
          credits: parsed.args.amount,
          epoch: Number(parsed.args.epoch),
          layerTxHash: lg.transactionHash,
          layerBlock: lg.blockNumber,
        };
      });
    },

    /** 某段区块里的 CreditsMinted（creditedInEpoch 的唯一来源） */
    async creditLogs(from, to) {
      const topic = l2BridgeIface.getEvent('CreditsMinted').topicHash;
      const logs = await p.getLogs({ address: cfg.addresses.l2Bridge, topics: [topic], fromBlock: from, toBlock: to });
      return logs.map((lg) => {
        const parsed = l2BridgeIface.parseLog({ topics: [...lg.topics], data: lg.data });
        return { depositId: parsed.args.depositId, amount: parsed.args.amount, layerBlock: lg.blockNumber };
      });
    },

    async balance(address, blockTag = 'latest') {
      return await p.getBalance(address, blockTag);
    },
  };
}
