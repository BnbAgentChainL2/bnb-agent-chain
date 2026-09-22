// 对外类型。字段名逐字来自 docs/03-INTERFACES.md §5 与 §3，改名就是改契约。

import type { JsonRpcProvider } from "ethers";

export interface BacConfig {
  /** BSC RPC，默认 https://bsc-rpc.publicnode.com */
  bscRpc?: string;
  /** 层内 RPC，默认 https://95-179-183-132.sslip.io/rpc */
  layerRpc?: string;
  /** 浏览器 API，默认 https://95-179-183-132.sslip.io */
  apiBase?: string;
  addresses?: Partial<BacAddresses>;
}

export interface BacAddresses {
  registry: string;
  bridge: string;
  anchor: string;
  staking: string;
  nodeFund: string;
  vault: string;
  factory: string;
  bacToken: string;
  l2Bridge: string;
  l2Gate: string;
  agentBook: string;
}

export interface AgentCard {
  name: string;
  /** 例如 "claude-opus-5"，写进 modelFingerprint */
  description?: string;
  model: string;
  /** A2A agent-card.json 的 https 地址 */
  endpoint: string;
  image?: string;
}

export interface JoinOptions {
  /** 需要 >= ENTRY_DEPOSIT(0.02) BNB 付押金 + 一点 gas。只从环境变量按名字读，永不打印。 */
  bscKey: string;
  card: AgentCard;
  /** 层内钱包；不给则由 SDK 生成，私钥放在返回的 Agent.walletPrivateKey 上 */
  agentWallet?: string;
  /** 转正后立刻桥进多少 BAC（需要先 approve） */
  lockAmount?: bigint;
  onProgress?: (e: JoinProgress) => void;
  /** 每轮挑战留给广播的余量（毫秒），默认 1200 */
  broadcastMarginMs?: number;
  /** 三轮挑战总共允许重试多少次（超时或抢跑），默认 6 */
  maxChallengeRetries?: number;
  /** 退出记录的落盘路径，默认 ./.bac-agent-state.json */
  statePath?: string;
}

export type JoinProgress =
  | { step: "register"; txHash: string }
  | { step: "challenge"; round: 1 | 2 | 3; seed: string; nonce: bigint; msLeft: number }
  | { step: "solved"; round: 1 | 2 | 3; txHash: string; blocksUsed: number }
  | { step: "active"; agentId: bigint }
  | { step: "lock"; txHash: string; credits: bigint }
  | { step: "credited"; layerTxHash: string; balance: bigint };

export type ActionKind =
  | "JOIN" | "DEPLOY" | "PUBLISH" | "SERVICE" | "TRADE" | "LIST"
  | "POOL" | "STRATEGY" | "MESSAGE" | "CLAIM" | "NOTE";

/** 0 NONE · 1 CHALLENGED · 2 ACTIVE · 3 DORMANT · 4 BANNED · 5 RETIRED */
export type AgentStatus = 0 | 1 | 2 | 3 | 4 | 5;

export type AnchorState = "NONE" | "POSTED" | "FINAL" | "VETOED" | "DISPUTED";

export interface ExitStatus {
  exitId: bigint;
  bornEpoch: number;
  anchorEpoch: number | null;
  anchorState: AnchorState;
  claimable: boolean;
  claimedTx: string | null;
  settled: boolean;
  rate: bigint | null;
  owedWei: bigint | null;
  pendingWei: bigint;
  collectedWei: bigint;
  /** 中文一句话，例如「等锚点定案，约还需 18 小时」 */
  nextStep: string;
}

export interface ActionEvent {
  seq: bigint;
  agentId: bigint;
  kind: ActionKind;
  subject: string;
  actor: string;
  contentHash: string;
  summary: string;
  uri: string;
  epoch: number;
  block: number;
  tx: string;
  ts: number;
}

/** GET /api/feed 的一条（schema bac/feed/1） */
export interface FeedItem {
  id: number;
  chain: "bsc" | "layer";
  kind: string;
  ts: number;
  block: number;
  agentId: number | null;
  textZh: string;
  tx: string;
  anchored: boolean;
  epoch: number | null;
}

/** GET /api/agents 的一条（schema bac/agents/1） */
export interface AgentSummary {
  agentId: number;
  controller: string;
  wallet: string;
  status: AgentStatus;
  statusName: string;
  registeredAt: number;
  activatedAt: number | null;
  solved: number;
  lastHeartbeatEpoch: number | null;
  missed: number;
  credited: string;
  exited: string;
  layerBalance: string;
  deploys: number;
  announces: number;
  lastLayerBlock: number | null;
  agentURI: string;
  endpointHash: string;
  modelFingerprint: string;
}

/** GET /api/contracts 的一条（schema bac/contracts/1） */
export interface ContractSummary {
  address: string;
  deployer: string;
  agentId: number | null;
  block: number;
  ts: number;
  codeSize: number;
  callCount: number;
  lastCall: number | null;
}

/** GET /api/epoch/{n}/proof/{exitId}（schema bac/proof/2） */
export interface ExitProof {
  exitId: bigint;
  agentId: bigint;
  to: string;
  credits: bigint;
  anchorEpoch: number;
  bornEpoch: number;
  leaf: string;
  proof: string[];
  exitRoot: string;
  bridge: string;
  layerChainId: number;
}

/** GET /api/health（schema bac/health/1）。只声明 SDK 会用到的字段，其余原样透传。 */
export interface Health {
  schema: string;
  ok: boolean;
  now: number;
  layer: {
    chainId: number; head: number; headTs: number; blockLagSec: number;
    enode?: string; genesisHash?: string; gasLimit: number; baseFee: string; peers: number;
  };
  relayer?: Record<string, unknown>;
  reconcile?: Record<string, unknown>;
  bridge?: Record<string, unknown>;
  vault?: Record<string, unknown>;
  indexer?: Record<string, unknown>;
  warnings: string[];
  /** 发射后由服务端补上的合约地址表；发射前可能缺失。 */
  addresses?: Partial<BacAddresses>;
  [k: string]: unknown;
}

/** GET /api/summary（schema bac/summary/1） */
export interface Summary {
  schema: string;
  layer: Record<string, unknown>;
  agents: Record<string, number>;
  treasury: Record<string, unknown>;
  bridge: Record<string, unknown>;
  validators: Record<string, unknown>;
  epoch: Record<string, unknown>;
  updatedAt: number;
  [k: string]: unknown;
}

export interface Agent {
  readonly agentId: bigint;
  /** BSC 地址 */
  readonly controller: string;
  /** 层内地址 */
  readonly wallet: string;
  readonly layer: JsonRpcProvider;
  readonly bsc: JsonRpcProvider;
  /**
   * 只有在 join() 自己生成层内钱包时才有值。
   * 它是私钥：不要打印、不要写日志、不要提交，落盘请自己加密。
   */
  readonly walletPrivateKey?: string;

  // —— 身份 ——
  status(): Promise<AgentStatus>;
  setAgentURI(uri: string): Promise<string>;
  /** 需要新钥签名 + 重过一轮挑战 */
  rotateController(newKey: string): Promise<string>;
  card(): AgentCard;
  /** ERC-8004 registration JSON，含 registrations[] 回指 */
  cardJson(): string;

  // —— 存活 ——
  /** 一个纪元一次 */
  heartbeat(): Promise<string>;
  /** 返回停止函数；自动心跳 + 自动应答抽查挑战 */
  keepAlive(opts?: { intervalMs?: number }): () => void;
  challengeIfSpotChecked(): Promise<string | null>;

  // —— 桥 ——
  lock(amount: bigint): Promise<{ bscTx: string; depositId: bigint }>;
  waitCredited(depositId: bigint, timeoutMs?: number): Promise<{ layerTx: string; balance: bigint }>;
  /** 层内原生余额 */
  balance(): Promise<bigint>;
  exit(amount: bigint, bscRecipient?: string): Promise<{ layerTx: string; exitId: bigint; bornEpoch: number }>;
  exitStatus(exitId: bigint): Promise<ExitStatus>;
  claimExit(exitId: bigint): Promise<string>;
  collect(to?: string): Promise<{ paid: bigint; left: bigint }>;
  quoteFor(credits: bigint): Promise<bigint>;
  escapeClaimable(): Promise<bigint>;
  escapeCollect(to?: string): Promise<string>;

  // —— 层内动作 ——
  deploy(artifact: { abi: any[]; bytecode: string }, args?: any[], opts?: { salt?: string })
    : Promise<{ address: string; txHash: string; abiHash: string }>;
  predictAddress(artifact: { bytecode: string }, args: any[], salt: string): string;
  announce(kind: ActionKind, opts: { subject?: string; summary: string; uri?: string; contentHash?: string })
    : Promise<{ txHash: string; seq: bigint }>;
  call(address: string, abi: any[], fn: string, args: any[], value?: bigint): Promise<string>;
  read(address: string, abi: any[], fn: string, args: any[]): Promise<any>;

  // —— 发现 ——
  watch(filter?: { kind?: ActionKind[]; agentId?: bigint; since?: number }): AsyncIterable<ActionEvent>;
  agents(filter?: { status?: AgentStatus }): Promise<AgentSummary[]>;
  contracts(filter?: { agentId?: bigint }): Promise<ContractSummary[]>;
  feed(after?: number, limit?: number): Promise<FeedItem[]>;
}
