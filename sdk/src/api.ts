// 浏览器 HTTP API 的只读封装（03 §3）。全部无认证、全部只读。
// 所有金额字段在 API 里是十进制字符串的 wei，进 SDK 一律转 bigint。

import { BacApiError } from "./errors.js";
import { DEFAULT_API_BASE } from "./config.js";
import type { ActionKind, ExitProof, FeedItem, Health, Summary } from "./types.js";

function base(b?: string): string {
  return (b ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new BacApiError(0, `请求 ${url} 失败：${String((err as Error)?.message ?? err)}`,
      "网络不通或站点没起来。SDK 的链上调用不依赖本站，但证明与 feed 依赖它。");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } })?.error?.message ?? res.statusText;
    throw new BacApiError(res.status, `${url} 返回 ${res.status}：${msg}`,
      res.status === 429 ? "被限速了，降低轮询频率再试。" : "按返回的中文说明处理。");
  }
  if (body === null || typeof body !== "object") {
    throw new BacApiError(res.status, `${url} 返回的不是 JSON 对象`, "站点可能在升级，稍后再试。");
  }
  return body as T;
}

export function health(b?: string): Promise<Health> {
  return getJson<Health>(`${base(b)}/api/health`);
}

export function summary(b?: string): Promise<Summary> {
  return getJson<Summary>(`${base(b)}/api/summary`);
}

/**
 * 当前兑付率的估算。**不承诺任何金额**（schema 里的 note 就是这么写的）。
 * exit() 之前必须读它：credits × weiPerCredit == 0 时 claimExit 会 revert。
 */
export async function rate(b?: string): Promise<{ weiPerCredit: bigint; poolBalance: bigint; lastPot: bigint }> {
  const r = await getJson<{ weiPerCredit: string; poolBalance: string; lastPot: string }>(`${base(b)}/api/rate`);
  return {
    weiPerCredit: BigInt(r.weiPerCredit),
    poolBalance: BigInt(r.poolBalance),
    lastPot: BigInt(r.lastPot),
  };
}

export async function feed(
  opts: { after?: number; limit?: number; kind?: ActionKind[] } = {},
  b?: string,
): Promise<FeedItem[]> {
  const q = new URLSearchParams();
  if (opts.after !== undefined) q.set("after", String(opts.after));
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts.kind && opts.kind.length > 0) q.set("kind", opts.kind.join(","));
  const qs = q.toString();
  const r = await getJson<{ items: FeedItem[] }>(`${base(b)}/api/feed${qs ? `?${qs}` : ""}`);
  return r.items ?? [];
}

/**
 * 取一笔退出的 merkle 证明。
 * **返回的 anchorEpoch 才是 claimExit 要用的那个纪元**：被 veto 的纪元里的退出会在后续纪元重报，
 * 此时 anchorEpoch != bornEpoch，而叶子本身一个字节都没变。
 */
export async function proofFor(epoch: number, exitId: bigint, b?: string): Promise<ExitProof> {
  const r = await getJson<{
    exitId: string | number; agentId: string | number; to: string; credits: string;
    anchorEpoch: number; bornEpoch: number; leaf: string; proof: string[];
    exitRoot: string; bridge: string; layerChainId: number;
  }>(`${base(b)}/api/epoch/${epoch}/proof/${exitId}`);
  return {
    exitId: BigInt(r.exitId),
    agentId: BigInt(r.agentId),
    to: r.to,
    credits: BigInt(r.credits),
    anchorEpoch: r.anchorEpoch,
    bornEpoch: r.bornEpoch,
    leaf: r.leaf,
    proof: r.proof,
    exitRoot: r.exitRoot,
    bridge: r.bridge,
    layerChainId: r.layerChainId,
  };
}

/** GET /api/epoch/{n}：单个纪元完整信息 + attestations。 */
export function epoch(n: number, b?: string): Promise<Record<string, any>> {
  return getJson<Record<string, any>>(`${base(b)}/api/epoch/${n}`);
}

/** GET /api/epoch/{n}/leaves：重建证明所需的全部叶子。 */
export function leaves(n: number, b?: string): Promise<Record<string, any>> {
  return getJson<Record<string, any>>(`${base(b)}/api/epoch/${n}/leaves`);
}

/** GET /api/agents */
export async function agents(
  opts: { status?: string; sort?: string; page?: number; pageSize?: number } = {},
  b?: string,
): Promise<{ total: number; items: any[] }> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  const r = await getJson<{ total: number; items: any[] }>(`${base(b)}/api/agents${qs ? `?${qs}` : ""}`);
  return { total: r.total ?? 0, items: r.items ?? [] };
}

/** GET /api/agent/{id} */
export function agent(id: bigint | number, b?: string): Promise<Record<string, any>> {
  return getJson<Record<string, any>>(`${base(b)}/api/agent/${id}`);
}

/** GET /api/contracts */
export async function contracts(
  opts: { agentId?: bigint | number; page?: number; pageSize?: number } = {},
  b?: string,
): Promise<{ total: number; items: any[] }> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  const r = await getJson<{ total: number; items: any[] }>(`${base(b)}/api/contracts${qs ? `?${qs}` : ""}`);
  return { total: r.total ?? 0, items: r.items ?? [] };
}
