// 测试用的假件：假 RPC、假 docker、假文件系统、内存日志。
// 一条硬规则：测试不许碰网络、不许要 docker、不许要服务器。

import { defaultConfig } from '../src/config.mjs';

export function memLogger() {
  const lines = [];
  const push = (s) => lines.push(String(s));
  return {
    lines,
    text: () => lines.join('\n'),
    line: push, ok: push, warn: push, fail: push, info: push, head: push,
  };
}

/** 一条假链：blocks[i] = {number, hash, timestamp}，按数组下标就是区块号 */
export function fakeChain({ startTs = 0, period = 3, count = 100 } = {}) {
  const blocks = [];
  for (let i = 0; i < count; i++) {
    blocks.push({
      number: '0x' + i.toString(16),
      hash: '0x' + i.toString(16).padStart(64, '0'),
      timestamp: '0x' + (startTs + i * period).toString(16),
    });
  }
  return blocks;
}

/** 假 Rpc：只实现本包会用到的方法 */
export class FakeRpc {
  constructor({ blocks = [], logs = [], chainId = 56777, peers = 3, calls = {}, gasPrice = 50000000n } = {}) {
    this.blocks = blocks;
    this.logs = logs;
    this._chainId = chainId;
    this.peers = peers;
    this.calls = calls;            // { [to.toLowerCase()+data.slice(0,10)]: '0x...' }
    this._gasPrice = gasPrice;
    this.sent = [];
    this.receipts = {};
    this.log = [];
  }
  async getBlock(tag, _withTxs) {
    this.log.push(['getBlock', tag]);
    if (tag === 'latest') return this.blocks[this.blocks.length - 1] || null;
    const n = typeof tag === 'number' ? tag : Number(BigInt(tag));
    return this.blocks[n] || null;
  }
  async chainId() { return this._chainId; }
  async blockNumber() { return this.blocks.length - 1; }
  async peerCount() { if (this.peers === null) throw new Error('no peers api'); return this.peers; }
  async getLogs(f) {
    this.log.push(['getLogs', f]);
    const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
    return this.logs.filter((l) => {
      const bn = Number(BigInt(l.blockNumber ?? '0x0'));
      return bn >= from && bn <= to;
    });
  }
  async ethCall(to, data) {
    const key = (to || '').toLowerCase() + ':' + data.slice(0, 10);
    if (!(key in this.calls)) throw new Error(`假 RPC 没有为 ${key} 准备返回值`);
    return this.calls[key];
  }
  async gasPrice() { return this._gasPrice; }
  async getTransactionCount() { return 7; }
  async estimateGas() { return 100000n; }
  async sendRawTransaction(raw) {
    const hash = '0x' + (this.sent.length + 1).toString(16).padStart(64, '0');
    this.sent.push({ raw, hash });
    this.receipts[hash] = { status: '0x1', blockNumber: '0x64', transactionHash: hash };
    return hash;
  }
  async getTransactionReceipt(hash) { return this.receipts[hash] || null; }
}

/** 假 docker：记录调过什么，不真跑 */
export class FakeDocker {
  constructor({ available = true, ps = [], upFails = false } = {}) {
    this.calls = [];
    this._available = available;
    this._ps = ps;
    this.upFails = upFails;
  }
  async available() { this.calls.push(['available']); return { ok: this._available, detail: 'Docker Compose version v2.29.0' }; }
  async up(services = []) {
    this.calls.push(['up', ...services]);
    if (this.upFails) throw new Error('up 失败');
    return { code: 0, stdout: '', stderr: '' };
  }
  async stop(services = []) { this.calls.push(['stop', ...services]); return { code: 0, stdout: '', stderr: '' }; }
  async ps() { this.calls.push(['ps']); return this._ps; }
}

/** 极简内存文件系统，够本包用（readFileSync/writeFileSync/existsSync/mkdirSync/statSync/readdirSync/chmodSync） */
export function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set(['.']);
  const norm = (p) => String(p).replace(/\\/g, '/');
  return {
    files, dirs,
    readFileSync(p) {
      const v = files.get(norm(p));
      if (v === undefined) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; }
      return v;
    },
    writeFileSync(p, data) { files.set(norm(p), String(data)); },
    existsSync(p) { return files.has(norm(p)) || dirs.has(norm(p)); },
    mkdirSync(p) { dirs.add(norm(p)); },
    chmodSync() { },
    statSync(p) {
      if (!files.has(norm(p)) && !dirs.has(norm(p))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { uid: 1000, gid: 1000, mode: 0o100600 };
    },
    readdirSync(p) {
      const prefix = norm(p) + '/';
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
  };
}

export function testConfig(over = {}) {
  return defaultConfig({
    nodeId: 'my-node-01',
    genesisHash: '0x' + 'ab'.repeat(32),
    genesisSha256: 'f'.repeat(64),
    bootnodes: ['enode://' + 'a'.repeat(128) + '@95.179.183.132:30303'],
    payout: '0x00000000000000000000000000000000000000A1',
    addresses: {
      staking: '0x0000000000000000000000000000000000000501',
      anchor: '0x0000000000000000000000000000000000000502',
      bacToken: '0x0000000000000000000000000000000000000503',
      bscBridge: '0x0000000000000000000000000000000000000504',
      l2Bridge: '0x0000000000000000000000000000000000000101',
    },
    ...over,
  });
}
