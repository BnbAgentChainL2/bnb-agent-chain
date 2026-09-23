// built 模块自己的配置：在 BacConfig（03 §5.1，不动）之外多了兜底端点和「包装币地址」。
// 这两样都不进 §5.1 的契约，所以放在这里，改它不会牵动索引器 / API / 网站的字段名。

import { getAddress } from "ethers";
import { DEFAULT_API_BASE, DEFAULT_LAYER_RPC } from "../config.js";
import { BacConfigError } from "../errors.js";
import { EndpointPool, type PoolOptions } from "./endpoints.js";
import type { BacConfig } from "../types.js";

/** 域名失效 / 还没解析出来时的兜底端点（决策 #18，与 web/site.config.js 逐字一致）。 */
export const FALLBACK_API_BASE = "https://95-179-183-132.sslip.io";
export const FALLBACK_LAYER_RPC = "https://95-179-183-132.sslip.io/rpc";

export interface BuiltConfig extends BacConfig {
  /** 主 API 域名不通时的兜底，默认 https://95-179-183-132.sslip.io */
  fallbackApi?: string;
  /** 主层内 RPC 不通时的兜底，默认 https://95-179-183-132.sslip.io/rpc */
  fallbackRpc?: string;
  /**
   * 包装原生币（WBAC，WETH9 形状）的地址。**SDK 不写死它**：
   * 决策 #22 把它放进创世，但地址由创世文件决定，写死等于在地址定下来之前替所有人做主。
   * 不填时从 /api/health 的 `layer.wbac` / `addresses.wbac` 读；两处都没有就报错，不猜。
   */
  wrappedNative?: string;
  /** 端点池参数（超时 / 退避 / 最多跳几次），测试可以注入时钟与 fetch */
  pool?: PoolOptions;
}

const poolCache = new WeakMap<object, { api?: EndpointPool; layer?: EndpointPool }>();

function cacheFor(cfg: BuiltConfig): { api?: EndpointPool; layer?: EndpointPool } {
  let c = poolCache.get(cfg as object);
  if (!c) { c = {}; poolCache.set(cfg as object, c); }
  return c;
}

/** 索引 API 的端点池：主域名在前，兜底 IP 在后。同一个 cfg 对象复用同一个池子（退避状态才有意义）。 */
export function apiPool(cfg: BuiltConfig = {}): EndpointPool {
  const c = cacheFor(cfg);
  if (!c.api) {
    c.api = new EndpointPool([cfg.apiBase ?? DEFAULT_API_BASE, cfg.fallbackApi ?? FALLBACK_API_BASE], cfg.pool);
  }
  return c.api;
}

/** 层内 RPC 的端点池。 */
export function layerPool(cfg: BuiltConfig = {}): EndpointPool {
  const c = cacheFor(cfg);
  if (!c.layer) {
    c.layer = new EndpointPool([cfg.layerRpc ?? DEFAULT_LAYER_RPC, cfg.fallbackRpc ?? FALLBACK_LAYER_RPC], cfg.pool);
  }
  return c.layer;
}

/**
 * 取包装币地址：配置里有就用配置的，否则问 /api/health，还是没有就明确报错。
 * **绝不返回一个猜出来的地址** —— 拿错地址去 deposit 就是把 gas 币扔进一个随便什么合约。
 */
export async function wrappedNativeAddress(cfg: BuiltConfig = {}): Promise<string> {
  if (cfg.wrappedNative) return getAddress(cfg.wrappedNative);
  if (cfg.addresses && (cfg.addresses as Record<string, string>).wbac) {
    return getAddress((cfg.addresses as Record<string, string>).wbac);
  }
  let health: Record<string, any> | null = null;
  try {
    health = await apiPool(cfg).getJson<Record<string, any>>("/api/health");
  } catch {
    health = null;
  }
  const cand = health?.layer?.wbac ?? health?.addresses?.wbac ?? health?.layer?.wrappedNative;
  if (typeof cand === "string" && /^0x[0-9a-fA-F]{40}$/.test(cand) && !/^0x0+$/.test(cand)) {
    return getAddress(cand);
  }
  throw new BacConfigError(
    "不知道包装币（WBAC）的地址",
    "创世里的 WBAC 地址请从 genesis.json 或 /api/health 里取，然后传 BuiltConfig.wrappedNative。SDK 不替你猜一个地址。",
  );
}
