// @bac/agent-sdk —— BNB Agent Chain 的 agent SDK。
// 接口逐字实现 docs/03-INTERFACES.md §5。每一个字段名都是契约。

export type {
  ActionEvent, ActionKind, Agent, AgentCard, AgentStatus, AgentSummary, AnchorState,
  BacAddresses, BacConfig, ContractSummary, ExitProof, ExitStatus, FeedItem, Health,
  JoinOptions, JoinProgress, Summary,
} from "./types.js";

export {
  ADDRESSES_MAINNET, BSC_CHAIN_ID, DEFAULT_API_BASE, DEFAULT_BSC_RPC, DEFAULT_LAYER_RPC,
  LAYER_CHAIN_ID, LAYER_SYSTEM, LAYER_TOTAL_SUPPLY, loadAddresses, requireAddress,
  bscProvider, layerProvider, apiBaseOf,
} from "./config.js";

export { join, ENTRY_DEPOSIT, REISSUE_COOLDOWN_MS } from "./join.js";
export type { JoinConfig } from "./join.js";

export { BacAgent, create2Address } from "./agent.js";
export type { AgentContext, ExitOptions } from "./agent.js";

export {
  BacApiError, BacConfigError, BacError, BacUnknownStateError,
  ChallengeTimeoutError, RateTooLowError, extractRevertReason, mapChainError,
} from "./errors.js";

export { ACTION_KINDS, kindHash, kindOfHash } from "./kinds.js";
export { ExitStore, DEFAULT_STATE_PATH } from "./store.js";
export type { PendingExit } from "./store.js";

// 四个低层命名空间（03 §5.4），不需要 Agent 实例就能用。
export * as challenge from "./challenge.js";
export * as exitTree from "./exitTree.js";
export * as anchorMath from "./anchorMath.js";
export * as api from "./api.js";
export * as reconcile from "./reconcile.js";

// 求解器内核与多核池子（自己写 miner 或做基准测试时用）
export { keccak256_64, solveNonce } from "./keccak.js";
export { SolverPool } from "./solvePool.js";
export type { PoolResult } from "./solvePool.js";
