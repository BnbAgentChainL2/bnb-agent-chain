// 主端点 / 兜底端点的失败切换。**逐字照搬网站数据层的做法**
// （web/js/data/bac-core.js 的 healthTable + backoffMs、bac-layer.js 的 pickEndpoint / MAX_HOPS），
// 这样 SDK 和网站在「主域名挂了怎么办」这件事上行为一致，不会一个能读一个读不到。
//
// 规则（决策 #18：两个域名和兜底 IP 指向同一台机器，切换只解决域名/证书问题，不增加信任域）：
//   1. 端点表按「主用在前、兜底在后」排；
//   2. 某个端点**网络层**失败（超时 / HTTP 错 / 不是 JSON）才记退避：base × 2^(n-1)，上限 120 秒；
//   3. JSON-RPC 自己回的 error（方法没开、revert）只是这一条请求的事，**不算端点坏了**，不切换；
//   4. 一次逻辑调用最多打 2 个端点（MAX_HOPS），不做无限重试；
//   5. 主端点还在退避里时优先用上一次成功的那个；退避到期后自然换回主端点。

import { BacApiError } from "../errors.js";

/** 第 n 次失败后要等多久：base × 2^(n-1)，上限 120 秒。与网站 backoffMs 逐字一致。 */
export function backoffMs(fails: number, base = 5000): number {
  const n = Math.max(1, Number(fails) || 1);
  return Math.min(120_000, base * Math.pow(2, n - 1));
}

export interface EndpointHealth {
  fails: number;
  /** 这个时间戳之前不再试它 */
  until: number;
  lastError: string | null;
}

export interface PoolOptions {
  /** 退避基数，默认 5000 毫秒（与网站一致） */
  backoffBaseMs?: number;
  /** 单次请求超时，默认 8000 毫秒（与网站 apiTimeoutMs / layerTimeoutMs 一致） */
  timeoutMs?: number;
  /** 一次逻辑调用最多打几个端点，默认 2 */
  maxHops?: number;
  /** 注入时钟，测试用 */
  now?: () => number;
  /** 注入 fetch，测试用 */
  fetchImpl?: typeof fetch;
}

/** 一组端点的健康表 + 挑选逻辑。无状态共享：每个 pool 自己记自己的退避。 */
export class EndpointPool {
  readonly endpoints: string[];
  readonly backoffBaseMs: number;
  readonly timeoutMs: number;
  readonly maxHops: number;
  readonly stats = { requests: 0, failovers: 0, byUrl: {} as Record<string, number> };

  private readonly health = new Map<string, EndpointHealth>();
  private readonly nowFn: () => number;
  private readonly fetchImpl?: typeof fetch;
  /** 上一次成功的端点 */
  private current: string | null = null;

  constructor(endpoints: Array<string | undefined | null>, opts: PoolOptions = {}) {
    const seen: string[] = [];
    for (const u of endpoints) {
      if (typeof u === "string" && u && !seen.includes(u)) seen.push(u.replace(/\/+$/, ""));
    }
    this.endpoints = seen;
    this.backoffBaseMs = opts.backoffBaseMs ?? 5000;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxHops = Math.max(1, opts.maxHops ?? 2);
    this.nowFn = opts.now ?? (() => Date.now());
    this.fetchImpl = opts.fetchImpl;
  }

  get(url: string): EndpointHealth {
    let e = this.health.get(url);
    if (!e) {
      e = { fails: 0, until: 0, lastError: null };
      this.health.set(url, e);
    }
    return e;
  }

  healthy(url: string, now = this.nowFn()): boolean {
    return this.get(url).until <= now;
  }

  ok(url: string): void {
    const e = this.get(url);
    e.fails = 0;
    e.until = 0;
    e.lastError = null;
    this.current = url;
  }

  bad(url: string, err: unknown, now = this.nowFn()): EndpointHealth {
    const e = this.get(url);
    e.fails += 1;
    e.until = now + backoffMs(e.fails, this.backoffBaseMs);
    e.lastError = err ? String((err as Error)?.message ?? err) : null;
    return e;
  }

  /** 挑一个没试过、且不在退避里的端点；全在退避里就挑最快到期的那个（不彻底放弃）。 */
  pick(now = this.nowFn(), tried: string[] = []): string | null {
    let order = this.endpoints.slice();
    if (this.current && order.length > 1 && order[0] !== this.current && !this.healthy(order[0], now)) {
      order = [this.current, ...order.filter((u) => u !== this.current)];
    }
    let best: string | null = null;
    let bestUntil = Infinity;
    for (const u of order) {
      if (tried.includes(u)) continue;
      if (this.healthy(u, now)) return u;
      const until = this.get(u).until;
      if (until < bestUntil) { bestUntil = until; best = u; }
    }
    return best;
  }

  /**
   * 在端点之间做一次带切换的请求。`run(url)` 抛错 = 这个端点网络层坏了 → 记退避换下一个；
   * 想表达「这条请求本身错了，但端点是好的」，请在 run 里自己抛 BacApiError 之外的…… 见 requestJson 的分工。
   */
  async withFailover<T>(run: (url: string) => Promise<T>): Promise<T> {
    if (this.endpoints.length === 0) {
      throw new BacApiError(0, "没有配置任何端点", "请在 BuiltConfig 里给 apiBase / layerRpc，或让 SDK 用默认值。");
    }
    const tried: string[] = [];
    let lastErr: unknown = null;
    for (let hop = 0; hop < this.maxHops; hop++) {
      const url = this.pick(this.nowFn(), tried);
      if (!url) break;
      tried.push(url);
      this.stats.requests += 1;
      this.stats.byUrl[url] = (this.stats.byUrl[url] ?? 0) + 1;
      try {
        const out = await run(url);
        this.ok(url);
        return out;
      } catch (err) {
        if ((err as { bacNoFailover?: boolean })?.bacNoFailover) throw err;   // 端点是好的，是这条请求本身错了
        lastErr = err;
        this.bad(url, err);
        this.stats.failovers += 1;
      }
    }
    throw new BacApiError(
      0,
      `这 ${tried.length} 个端点都读不到：${tried.join(" / ")}；最后一个错误：${String((lastErr as Error)?.message ?? lastErr)}`,
      "两个域名和兜底 IP 指向同一台机器（决策 #18），全都不通说明那台机器或你的网络出了问题。链上调用不依赖本站。",
    );
  }

  private theFetch(): typeof fetch {
    const f = this.fetchImpl ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new BacApiError(0, "这个运行时没有 fetch", "Node 22 自带 fetch；更老的运行时请自己注入 fetchImpl。");
    }
    return f;
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.theFetch()(url, { ...init, signal: ctl.signal });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) {
        const msg = (body as { error?: { message?: string } })?.error?.message ?? res.statusText;
        const e = new BacApiError(res.status, `${url} 返回 ${res.status}：${msg}`,
          res.status === 429 ? "被限速了（每 IP 每秒 20 次），降低轮询频率再试。" : "按返回的中文说明处理。");
        // 4xx 是我们请求得不对，换个端点也是同样的答案：不算端点坏，不切换。
        if (res.status >= 400 && res.status < 500 && res.status !== 429) (e as unknown as { bacNoFailover: boolean }).bacNoFailover = true;
        throw e;
      }
      if (body === null || typeof body !== "object") {
        throw new BacApiError(res.status, `${url} 返回的不是 JSON 对象`, "站点可能在升级，稍后再试。");
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET 一个只读端点，带切换。`path` 以 / 开头。 */
  async getJson<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      q.set(k, String(v));
    }
    const qs = q.toString();
    return this.withFailover(async (base) =>
      (await this.fetchJson(`${base}${path}${qs ? `?${qs}` : ""}`, {
        method: "GET",
        headers: { accept: "application/json" },
      })) as T);
  }

  /**
   * 裸 JSON-RPC 一条，带切换。
   * **JSON-RPC 自己回的 error 不算端点坏**（方法没开、eth_call revert 都属于这一类），原样抛出去不切换。
   */
  async rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.withFailover(async (url) => {
      const body = await this.fetchJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }) as { result?: T; error?: { code: number; message: string } };
      if (body.error) {
        const e = new BacApiError(200, `${method} 返回 JSON-RPC 错误 ${body.error.code}：${body.error.message}`,
          "这是这条请求本身的问题（方法没开放、或者 eth_call revert 了），换端点没有用。");
        (e as unknown as { bacNoFailover: boolean }).bacNoFailover = true;
        throw e;
      }
      return body.result as T;
    });
  }
}
