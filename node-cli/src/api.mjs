// 浏览器 HTTP API 的只读客户端（docs/03-INTERFACES.md §3）。
// 这里读到的东西一律当**参考**：官方节点的自述不是真相，真相是你自己节点上算出来的那个根。
// fetch 可注入，测试不需要网络。

import { BacError } from './util.mjs';

export class Api {
  constructor(base, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.base = String(base || '').replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async get(path) {
    let res;
    try {
      res = await this.fetchImpl(this.base + path, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new BacError(`读不到 ${this.base}${path}：${e.message}`, 'api_unreachable');
    }
    if (!res.ok) throw new BacError(`${this.base}${path} 返回 HTTP ${res.status}`, 'api_http');
    return res.json();
  }

  /** §3.1；返回的 layer.head / layer.enode / layer.genesisHash 是 init 与 status 要的三样 */
  health() { return this.get('/api/health'); }

  /** §3.6 /api/validators */
  validators() { return this.get('/api/validators'); }

  /** §3.6 /api/genesis：原样的 genesis.json，响应头带 X-Genesis-Hash */
  async genesis() {
    let res;
    try {
      res = await this.fetchImpl(this.base + '/api/genesis', { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new BacError(`读不到 ${this.base}/api/genesis：${e.message}`, 'api_unreachable');
    }
    if (!res.ok) throw new BacError(`/api/genesis 返回 HTTP ${res.status}`, 'api_http');
    const text = await res.text();
    const headerHash = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('x-genesis-hash') : null;
    return { text, headerHash };
  }
}
