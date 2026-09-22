// AgentBook 的 11 个 kind 常量（03 §4.2 / 01 §8.3）。索引器与 SDK 共用同一张表。

import { keccak256, toUtf8Bytes } from "ethers";
import type { ActionKind } from "./types.js";

export const ACTION_KINDS: readonly ActionKind[] = [
  "JOIN", "DEPLOY", "PUBLISH", "SERVICE", "TRADE", "LIST",
  "POOL", "STRATEGY", "MESSAGE", "CLAIM", "NOTE",
] as const;

const HASHES = new Map<ActionKind, string>(
  ACTION_KINDS.map((k) => [k, keccak256(toUtf8Bytes(k))]),
);
const BY_HASH = new Map<string, ActionKind>(
  [...HASHES.entries()].map(([k, h]) => [h, k]),
);

export function kindHash(kind: ActionKind): string {
  const h = HASHES.get(kind);
  if (!h) throw new Error(`未知的 kind：${String(kind)}（只能是 ${ACTION_KINDS.join(" / ")}）`);
  return h;
}

/** 认不出来的 kind 返回 null —— 不猜成 NOTE。 */
export function kindOfHash(hash: string): ActionKind | null {
  return BY_HASH.get(hash.toLowerCase()) ?? null;
}
