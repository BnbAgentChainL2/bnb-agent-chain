// 离线测试用的假链。**方法名必须与 src/chains.mjs 里的真适配器逐字一致** ——
// 这就是「所有网络调用只出现在 chains.mjs 里」这条纪律的回报：整台状态机、
// 全部五条规则、重启续传，都能不连任何网络地跑完。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EPOCH } from '../src/constants.mjs';
import { exitRootOf } from '../src/ids.mjs';

// 全部用小写：ethers 的 `getAddress` 对**混合大小写**的输入会校验 EIP-55 校验和，
// 而这些是手编的假地址，凑不出合法校验和。小写输入它一律接受。
export const ADDR = {
  bridge: '0x00000000000000000000000000000000000b1d6e',
  anchor: '0x00000000000000000000000000000000000a9c40',
  token: '0x0000000000000000000000000000000000bac70a',
  l2Bridge: '0x0000000000000000000000000000000000000101',
  feeSink: '0x000000000000000000000000000000000000dead',
  feeSplitter: '0x0000000000000000000000000000000000000104',
  signer: '0x0000000000000000000000000000000000515e12',
  watchdog: '0x000000000000000000000000000000000077a7c4',
  portal: '0x00000000000000000000000000000000000900a1',
  alice: '0x00000000000000000000000000000000000a11ce',
  thief: '0x0000000000000000000000000000000000174e17',
};

/** 一份可用的 cfg，字段形状与 loadConfig 的输出一致（但不含任何真私钥） */
export function fakeCfg(over = {}) {
  return {
    armed: true,
    rpc: { bsc: 'http://bsc-a', bsc2: 'http://bsc-b', layer: 'http://layer-a', layer2: 'http://layer-b' },
    dbPath: ':memory:',
    addresses: {
      bacBridge: ADDR.bridge,
      chainAnchor: ADDR.anchor,
      bacToken: ADDR.token,
      l2Bridge: ADDR.l2Bridge,
      feeSink: ADDR.feeSink,
      feeSplitter: ADDR.feeSplitter,
      layerSigner: ADDR.signer,
      flapPortal: null,
      pancakeRouter: null,
    },
    validators: [ADDR.signer],
    start: { bscBlock: 1, layerBlock: 0 },
    poll: { fastMs: 5000, slowMs: 30000, bscLogRange: 3000, layerLogRange: 5000, confirmDelayMs: 0, slowDepth: 0, rollingWindowSec: 86400 },
    tolerance: { releaseBps: 50n, slippageBps: 100n, reconcileWei: 0n, inflightBlocks: 1200 },
    notify: { url: null, format: 'json', timeoutMs: 100, retries: 0 },
    keys: { watchdog: '0x' + '11'.repeat(32), veto: null },
    ...over,
  };
}

/** 造一条等间隔出块的层内链 */
export function makeBlocks(count, startTs, step = 3) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ number: i, hash: '0x' + (i + 1).toString(16).padStart(64, '0'), timestamp: startTs + i * step });
  }
  return out;
}

export class FakeLayer {
  /**
   * @param {object} o
   * @param {Array} o.blocks
   * @param {Array} o.exits  { exitId, agentId, to, credits, epoch, layerBlock }
   * @param {Array} o.mints  { amount, layerBlock }
   * @param {object} o.balances { addr: bigint }
   */
  constructor(o = {}) {
    this.blocks = o.blocks ?? makeBlocks(10, 0);
    this.exits = o.exits ?? [];
    this.mints = o.mints ?? [];
    this.balances = o.balances ?? {};
    this.totalExitedValue = o.totalExited ?? 0n;
    this.independent = o.independent ?? true;
    this.seenSet = new Set(o.seen ?? []);
    this.url = o.url ?? 'http://layer-fake';
    this.calls = { exitLogs: 0, creditLogs: 0, getBlock: 0 };
  }
  async getBlockNumber() {
    return this.blocks[this.blocks.length - 1].number;
  }
  async getBlock(n) {
    this.calls.getBlock++;
    return this.blocks[n] ?? null;
  }
  async exitLogs(from, to) {
    this.calls.exitLogs++;
    return this.exits.filter((e) => e.layerBlock >= from && e.layerBlock <= to);
  }
  async creditLogs(from, to) {
    this.calls.creditLogs++;
    return this.mints.filter((m) => m.layerBlock >= from && m.layerBlock <= to);
  }
  async balance(addr, _blockTag) {
    if (!(addr in this.balances)) throw new Error(`该区块上读不到 ${addr} 的余额（模拟历史状态窗口已过）`);
    return this.balances[addr];
  }
  async seen(key) {
    return this.seenSet.has(key);
  }
  async totalExited() {
    return this.totalExitedValue;
  }
}

export class FakeBsc {
  constructor(o = {}) {
    this.head = o.head ?? 100;
    this.anchors = o.anchors ?? new Map(); // epoch -> anchor 对象
    this.events = o.events ?? []; // { name, args:{epoch}, blockNumber, txHash, logIndex }
    this.state = o.state ?? null;
    this.bridgeEventsData = o.bridgeEvents ?? emptyBridgeEvents();
    this.locked = o.locked ?? [];
    this.skewExits = o.skewExits ?? 0n;
    this.reference = o.reference ?? null;
    this.address = o.address ?? ADDR.watchdog;
    this.vetoAddress = o.vetoAddress ?? null;
    this.url = o.url ?? 'http://bsc-fake';
    this.which = o.which ?? 'primary';
    this.pauses = [];
    this.vetoes = [];
    this.pauseShouldFail = o.pauseShouldFail ?? false;
    this.lastPosted = o.lastPostedEpoch ?? 0;
    this.constantsData = o.constants ?? null;
  }
  async getBlockNumber() {
    return this.head;
  }
  async getBlockTimestamp(n) {
    return n * 3;
  }
  async anchorEvents(from, to) {
    return this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
  }
  async getAnchor(epoch) {
    return this.anchors.get(Number(epoch)) ?? { state: 'NONE', exitRoot: '0x' + '0'.repeat(64), l2Block: 0, l2BlockHash: '0x' + '0'.repeat(64), postedAt: 0, finalizedAt: 0, creditedInEpoch: 0n, exitCreditsInEpoch: 0n, feeBurnedInEpoch: 0n, circulating: 0n, exitCount: 0, agreeingCount: 0 };
  }
  async lastPostedEpoch() {
    return this.lastPosted;
  }
  async bridgeState(block) {
    return { ...this.state, block: typeof block === 'number' ? block : this.head };
  }
  async bridgeEvents(_from, _to) {
    return this.bridgeEventsData;
  }
  async lockedIn(_from, _to) {
    return this.locked;
  }
  async exitClaimedIn(_from, _to) {
    return this.skewExits;
  }
  async referencePrice(_blockTag, _spend) {
    return this.reference;
  }
  async watchdogAddress() {
    return ADDR.watchdog;
  }
  async vetoKey() {
    return '0x0000000000000000000000000000000000000000';
  }
  async constants() {
    return this.constantsData;
  }
  async sendPause() {
    if (this.pauseShouldFail) throw new Error('pause 被模拟成失败');
    const hash = '0x' + (this.pauses.length + 1).toString(16).padStart(64, '0');
    this.pauses.push(hash);
    return { hash, wait: async () => ({ status: 1 }) };
  }
  async sendVeto(epoch, reasonHash) {
    const hash = '0xve70' + (this.vetoes.length + 1).toString(16).padStart(60, '0');
    this.vetoes.push({ epoch, reasonHash, hash });
    return { hash, wait: async () => ({ status: 1 }) };
  }
}

export function emptyBridgeEvents() {
  return {
    flows: { locked: 0n, burned: 0n, bought: 0n, sweptBac: 0n, collected: 0n, haltPaid: 0n, escapeBac: 0n, accepted: 0n, spentBnb: 0n },
    boughtBack: [],
    settled: [],
    exits: [],
    paused: [],
  };
}

/** 一个诚实的锚点：由同一份层内数据算出来 */
export function honestAnchor(layer, epoch, bridgeAddr = ADDR.bridge) {
  const limit = (epoch + 1) * EPOCH;
  const prevLimit = epoch * EPOCH;
  const cur = [...layer.blocks].filter((b) => b.timestamp < limit).pop();
  const prev = [...layer.blocks].filter((b) => b.timestamp < prevLimit).pop();
  const from = prev ? prev.number + 1 : 0;
  const exits = layer.exits.filter((e) => e.layerBlock >= from && e.layerBlock <= cur.number);
  const mints = layer.mints.filter((m) => m.layerBlock >= from && m.layerBlock <= cur.number);
  const { root } = exitRootOf(exits.map((e) => ({ exitId: e.exitId, agentId: e.agentId, to: e.to, credits: e.credits })), bridgeAddr);
  return {
    exitRoot: root,
    l2BlockHash: cur.hash,
    l2Block: cur.number,
    postedAt: limit + 5,
    finalizedAt: 0,
    creditedInEpoch: mints.reduce((a, m) => a + m.amount, 0n),
    exitCreditsInEpoch: exits.reduce((a, e) => a + e.credits, 0n),
    feeBurnedInEpoch: 0n,
    circulating: 0n,
    exitCount: exits.length,
    agreeingCount: 0,
    state: 'POSTED',
  };
}

/** 临时目录里的真 SQLite（重启测试需要它能落盘） */
export function tmpDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'bac-wd-'));
  return { path: join(dir, 'wd.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
