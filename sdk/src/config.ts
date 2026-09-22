// 顶层配置与地址表（03 §5.1）。

import { getAddress, JsonRpcProvider, Network } from "ethers";
import type { BacAddresses, BacConfig } from "./types.js";
import { BacConfigError } from "./errors.js";

export const LAYER_CHAIN_ID = 56777;
export const BSC_CHAIN_ID = 56;

export const DEFAULT_BSC_RPC = "https://bsc-rpc.publicnode.com";
export const DEFAULT_LAYER_RPC = "https://95-179-183-132.sslip.io/rpc";
export const DEFAULT_API_BASE = "https://95-179-183-132.sslip.io";

/** 层内创世系统合约的固定地址（02 §2），发射前后都不会变。 */
export const LAYER_SYSTEM = {
  l2Bridge: "0x0000000000000000000000000000000000000101",
  l2Gate: "0x0000000000000000000000000000000000000102",
  agentBook: "0x0000000000000000000000000000000000000103",
  feeSink: "0x000000000000000000000000000000000000dEaD",
  // 决策 #17：层内 gas 费分账合约。对账公式必须减它的余额。
  feeSplitter: "0x0000000000000000000000000000000000000104",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  create2Deployer: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
} as const;

/** 层内原生币总量 1e27 wei（02 §2 的会计口径）。 */
export const LAYER_TOTAL_SUPPLY = 10n ** 27n;

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * BSC 侧地址发射后才存在。**发射前全部是 0x0**，
 * 用 loadAddresses() 从 /api/health 读真值，读不到就会报错而不是拿 0x0 去发交易。
 */
export const ADDRESSES_MAINNET: BacAddresses = {
  registry: ZERO,
  bridge: ZERO,
  anchor: ZERO,
  staking: ZERO,
  nodeFund: ZERO,
  vault: ZERO,
  factory: ZERO,
  bacToken: ZERO,
  l2Bridge: LAYER_SYSTEM.l2Bridge,
  l2Gate: LAYER_SYSTEM.l2Gate,
  agentBook: LAYER_SYSTEM.agentBook,
};

export function apiBaseOf(cfg?: BacConfig): string {
  return (cfg?.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

/** 层内 provider：写死 network，省掉一次 eth_chainId，离线测试也能构造。 */
export function layerProvider(cfg?: BacConfig): JsonRpcProvider {
  return new JsonRpcProvider(cfg?.layerRpc ?? DEFAULT_LAYER_RPC, new Network("bac-layer", LAYER_CHAIN_ID), {
    staticNetwork: true,
    batchMaxCount: 1,
  });
}

export function bscProvider(cfg?: BacConfig): JsonRpcProvider {
  return new JsonRpcProvider(cfg?.bscRpc ?? DEFAULT_BSC_RPC, new Network("bsc", BSC_CHAIN_ID), {
    staticNetwork: true,
  });
}

function isZero(a: string | undefined): boolean {
  return !a || a === ZERO || /^0x0+$/i.test(a);
}

/**
 * 从 /api/health 读地址表，失败回退到 ADDRESSES_MAINNET 常量。
 * 读到的地址一律做一次 EIP-55 校验和归一化（03 的全局约定）。
 */
export async function loadAddresses(cfg?: BacConfig): Promise<BacAddresses> {
  const merged: BacAddresses = { ...ADDRESSES_MAINNET, ...(cfg?.addresses ?? {}) };
  try {
    const res = await fetch(`${apiBaseOf(cfg)}/api/health`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const body = (await res.json()) as { addresses?: Partial<BacAddresses> };
      const remote = body?.addresses ?? {};
      for (const [k, v] of Object.entries(remote)) {
        if (typeof v === "string" && !isZero(v) && isZero((merged as unknown as Record<string, string>)[k])) {
          (merged as unknown as Record<string, string>)[k] = v;
        }
      }
    }
  } catch {
    // 离线可用是硬要求：读不到就用常量，真要用到某个 0x0 地址时由 requireAddress 报错。
  }
  for (const [k, v] of Object.entries(merged)) {
    if (!isZero(v)) (merged as unknown as Record<string, string>)[k] = getAddress(v);
  }
  return merged;
}

/** 取一个必须存在的地址；还是 0x0 就明确报错，绝不拿 0x0 去发交易。 */
export function requireAddress(addrs: BacAddresses, key: keyof BacAddresses): string {
  const v = addrs[key];
  if (isZero(v)) {
    throw new BacConfigError(
      `地址 ${String(key)} 还是 0x0（发射前的占位值）`,
      "发射后请用 loadAddresses() 从 /api/health 读，或在 BacConfig.addresses 里手工填入。",
    );
  }
  return getAddress(v);
}
