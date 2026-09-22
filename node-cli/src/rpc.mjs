// 极小的 JSON-RPC 客户端：只用 fetch，可注入。
// 之所以不直接用 ethers 的 Provider：测试必须在没有网络、没有 docker 的机器上跑，
// 注入一个假的 fetch 比拦 Provider 内部行为可靠得多。

import { BacError } from './util.mjs';

export class Rpc {
  /**
   * @param {string} url
   * @param {{fetchImpl?: Function, timeoutMs?: number, label?: string}} opts
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.label = opts.label || url;
    this.id = 0;
  }

  async call(method, params = []) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params });
    let res;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new BacError(`RPC 连不上 ${this.label}：${e.message}`, 'rpc_unreachable');
    }
    if (!res.ok) throw new BacError(`RPC ${this.label} 返回 HTTP ${res.status}`, 'rpc_http');
    const json = await res.json();
    if (json.error) {
      throw new BacError(`RPC ${this.label} ${method} 报错：${json.error.message} (${json.error.code})`, 'rpc_error');
    }
    return json.result;
  }

  async chainId() { return Number(BigInt(await this.call('eth_chainId'))); }
  async blockNumber() { return Number(BigInt(await this.call('eth_blockNumber'))); }
  async peerCount() { return Number(BigInt(await this.call('net_peerCount'))); }

  async getBlock(numberOrTag, withTxs = false) {
    const tag = typeof numberOrTag === 'number' ? '0x' + numberOrTag.toString(16) : numberOrTag;
    return this.call('eth_getBlockByNumber', [tag, withTxs]);
  }

  async getLogs(filter) { return this.call('eth_getLogs', [filter]); }

  async ethCall(to, data, tag = 'latest') { return this.call('eth_call', [{ to, data }, tag]); }

  async getBalance(addr, tag = 'latest') { return BigInt(await this.call('eth_getBalance', [addr, tag])); }

  async getTransactionCount(addr, tag = 'pending') {
    return Number(BigInt(await this.call('eth_getTransactionCount', [addr, tag])));
  }

  async gasPrice() { return BigInt(await this.call('eth_gasPrice')); }

  async estimateGas(tx) { return BigInt(await this.call('eth_estimateGas', [tx])); }

  async sendRawTransaction(raw) { return this.call('eth_sendRawTransaction', [raw]); }

  async getTransactionReceipt(hash) { return this.call('eth_getTransactionReceipt', [hash]); }

  /** QBFT：当届验证者集（02 §2：任何硬编码唯一签名者地址的代码都要改成读这个） */
  async qbftValidators(tag = 'latest') { return this.call('qbft_getValidatorsByBlockNumber', [tag]); }
}
