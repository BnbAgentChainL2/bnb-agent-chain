// 准入挑战：种子推导、PoW 求解、EIP-712 签名（01 §3.3）。
//
// 三个截止条件同时生效，缺一不可：
//   block.number    <= deadlineBlock (= 发起块 + K_BLOCKS(8))
//   block.timestamp <= deadlineTime  (= 发起时刻 + K_SECONDS(5))
//   uint256(keccak256(abi.encode(seed, nonce))) < TARGET (= 2**236)

import { AbiCoder, getAddress, getBytes, keccak256, type Wallet } from "ethers";
import { solveNonce } from "./keccak.js";
import { ADDRESSES_MAINNET, BSC_CHAIN_ID } from "./config.js";

const abi = AbiCoder.defaultAbiCoder();

/** TARGET = 2**236（01 §3.3），平均约 2**20 次哈希。 */
export const TARGET = 2n ** 236n;
/** K_BLOCKS = 8 */
export const K_BLOCKS = 8;
/** K_SECONDS = 5 */
export const K_SECONDS = 5;
/** ROUNDS = 3 */
export const ROUNDS = 3;

/** EIP-712 domain：chainId 逐字钉死在 56，不随 provider 的链变化（合约里也是写死的）。 */
export const CHALLENGE_DOMAIN_NAME = "BNB Agent Chain Registry";
export const CHALLENGE_DOMAIN_VERSION = "1";

export const CHALLENGE_TYPES = {
  Challenge: [
    { name: "agentId", type: "uint256" },
    { name: "challengeId", type: "bytes32" },
    { name: "seed", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const HEARTBEAT_TYPES = {
  Heartbeat: [
    { name: "agentId", type: "uint256" },
    { name: "epoch", type: "uint64" },
    { name: "epochSeed", type: "bytes32" },
    { name: "note", type: "bytes32" },
  ],
} as const;

export const BIND_WALLET_TYPES = {
  BindWallet: [
    { name: "wallet", type: "address" },
    { name: "controller", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const ROTATE_TYPES = {
  RotateController: [
    { name: "agentId", type: "uint256" },
    { name: "newController", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function domainFor(registry: string) {
  return {
    name: CHALLENGE_DOMAIN_NAME,
    version: CHALLENGE_DOMAIN_VERSION,
    chainId: BSC_CHAIN_ID,
    verifyingContract: getAddress(registry),
  };
}

/**
 * 第一轮种子：seed_1 = keccak256(abi.encode(blockhash(n-1), agentId, challengeNonce, registry))。
 * 正常流程不需要自己算 —— 直接用 ChallengeIssued 事件里的 seed。
 * 这个函数是给独立核验用的：任何人都能验证合约发的种子没有被挑过。
 */
export function seed(blockHash: string, agentId: bigint, nonce: bigint, registry: string): string {
  return keccak256(abi.encode(
    ["bytes32", "uint256", "uint256", "address"],
    [blockHash, agentId, nonce, getAddress(registry)],
  ));
}

/** 后续轮次的链式种子：seed_{r+1} = keccak256(abi.encode(seed_r, nonce_r, blockhash(n-1)))。 */
export function chainedSeed(prevSeed: string, prevNonce: bigint, blockHash: string): string {
  return keccak256(abi.encode(["bytes32", "uint256", "bytes32"], [prevSeed, prevNonce, blockHash]));
}

/** challengeId = keccak256(abi.encode(agentId, round, seed))。 */
export function challengeIdOf(agentId: bigint, round: number, seedHex: string): string {
  return keccak256(abi.encode(["uint256", "uint8", "bytes32"], [agentId, round, seedHex]));
}

export interface SolveOptions {
  /** 墙钟预算（毫秒）。默认 4000：5 秒截止减去广播余量。<=0 表示不限时。 */
  budgetMs?: number;
  /** 起始 nonce，默认随机。测试里传固定值可复现。 */
  start?: bigint;
}

/**
 * 求解一轮挑战。**同步**，会占满当前线程直到出解或预算用完。
 * 预算用完抛 ChallengeTimeoutError 的决定权留给调用方：这里返回 null。
 *
 * 实测速度约 55-65 万次哈希/秒（Node 22，单核），2**236 的中位数解题时间约 1.2 秒，
 * 但它是指数分布：单核在 3.8 秒预算内约有一成解不出来。join() 因此走多核 SolverPool。
 */
export function solve(seedHex: string, target: bigint = TARGET, opts: SolveOptions = {}): { nonce: bigint; ms: number } {
  const budgetMs = opts.budgetMs ?? 4000;
  const start = opts.start ?? randomStart();
  const r = solveNonce(getBytes(seedHex), target, budgetMs, start);
  if (r === null) {
    const e = new Error(`挑战在 ${budgetMs} ms 的预算内没解出来`);
    (e as Error & { code?: string }).code = "challenge_timeout";
    throw e;
  }
  return { nonce: r.nonce, ms: r.ms };
}

/** 和 solve() 一样，但预算用完返回 null 而不是抛错（join 的内部循环用它）。 */
export function trySolve(seedHex: string, target: bigint, budgetMs: number, start?: bigint)
  : { nonce: bigint; ms: number; hashes: number } | null {
  return solveNonce(getBytes(seedHex), target, budgetMs, start ?? randomStart());
}

function randomStart(): bigint {
  const b = new Uint8Array(24);
  globalThis.crypto.getRandomValues(b);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v << 32n; // 低 32 位留给热循环的计数器
}

/**
 * EIP-712 签名（签名者必须是 agent 的 controller）。
 * registry 在 03 §5.4 的签名里没有列出，但 EIP-712 的 verifyingContract 必须是它，
 * 所以这里加了一个可选参数，默认取 ADDRESSES_MAINNET.registry。
 */
export async function sign(
  wallet: Wallet,
  agentId: bigint,
  challengeId: string,
  seedHex: string,
  nonce: bigint,
  registry: string = ADDRESSES_MAINNET.registry,
): Promise<string> {
  return wallet.signTypedData(domainFor(registry), CHALLENGE_TYPES as unknown as Record<string, any>, {
    agentId, challengeId, seed: seedHex, nonce,
  });
}
