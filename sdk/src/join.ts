// join()：注册 → 三轮挑战 → 转正 →（可选）进桥 → 等积分到账（03 §5.2）。
//
// **本 SDK 不能、也不声称能证明使用者是 AI。**
// 它证明的是「一个能在约 4 秒内响应链上随机种子并持续在线的程序」。
// 人也可以写脚本来过这套门禁；门禁挡的是手工点击，不是人类本身。

import { Contract, getAddress, Interface, keccak256, toUtf8Bytes, Wallet, ZeroHash } from "ethers";
import type { JsonRpcProvider } from "ethers";
import { REGISTRY_ABI } from "./abi.js";
import { BacAgent } from "./agent.js";
import * as challenge from "./challenge.js";
import { apiBaseOf, bscProvider, layerProvider, loadAddresses, requireAddress } from "./config.js";
import { BacError, ChallengeTimeoutError, withChainErrors } from "./errors.js";
import { SolverPool } from "./solvePool.js";
import { ExitStore } from "./store.js";
import type { Agent, BacConfig, JoinOptions, JoinProgress } from "./types.js";

/** ENTRY_DEPOSIT = 0.02 BNB，多一 wei 少一 wei 都会 revert。 */
export const ENTRY_DEPOSIT = 20_000_000_000_000_000n;
/** REISSUE_COOLDOWN = 60 秒。 */
export const REISSUE_COOLDOWN_MS = 60_000;

const BIND_WALLET_TTL = 3600;

export interface JoinConfig extends JoinOptions, BacConfig {
  /** 自带层内钱包时，把它的私钥一起给 SDK，否则只能读不能写。 */
  layerKey?: string;
  /** 自带 provider（自建节点、代理、或测试里的假 provider）。不给就按 BacConfig 里的 RPC 建。 */
  bscProvider?: JsonRpcProvider;
  layerProvider?: JsonRpcProvider;
  /** 求解用几个工作线程，默认 CPU 核数 - 1（上限 8）。 */
  solverThreads?: number;
  /**
   * 两次 reissueChallenge 之间等多久。默认 60 秒 —— 这是合约常量 REISSUE_COOLDOWN，
   * 调小了链上照样会 revert，只有在假链上测试时才有意义。
   */
  reissueCooldownMs?: number;
}

/**
 * 一个 agent 的进场全过程。20 行示例见 examples/join-20-lines.mjs。
 *
 * 注意：`bscKey` 是私钥。按名字从环境变量读，**永远不要打印、不要写日志、不要提交**。
 */
export async function join(opts: JoinConfig): Promise<Agent> {
  const progress = (e: JoinProgress): void => { opts.onProgress?.(e); };
  const addrs = await loadAddresses(opts);
  const bsc = opts.bscProvider ?? bscProvider(opts);
  const layer = opts.layerProvider ?? layerProvider(opts);
  const apiBase = apiBaseOf(opts);

  const controller = new Wallet(opts.bscKey, bsc);
  const registryAddr = requireAddress(addrs, "registry");
  const registry = new Contract(registryAddr, REGISTRY_ABI as unknown as string[], controller);

  // 1) 层内钱包：自带就用自带的，不自带就现生成一把（私钥随 Agent 返回）。
  let generatedKey: string | undefined;
  let layerKey = opts.layerKey;
  let walletAddress = opts.agentWallet ? getAddress(opts.agentWallet) : "";
  if (!walletAddress) {
    const w = Wallet.createRandom();
    walletAddress = w.address;
    layerKey = w.privateKey;
    generatedKey = w.privateKey;
  }

  // 2) agentWallet 必须自己签 BindWallet，否则谁都能把别人的层内地址登记成自己的。
  const deadline = BigInt(Math.floor(Date.now() / 1000) + BIND_WALLET_TTL);
  if (!layerKey) {
    throw new BacError(
      "no_layer_key",
      "自带 agentWallet 时必须同时提供它的私钥（layerKey）",
      "register 需要 agentWallet 自己的 EIP-712 BindWallet 签名，只有地址是签不出来的。",
    );
  }
  const walletSigner = new Wallet(layerKey);
  const walletSig = await walletSigner.signTypedData(
    challenge.domainFor(registryAddr),
    challenge.BIND_WALLET_TYPES as unknown as Record<string, any>,
    { wallet: walletAddress, controller: controller.address, deadline },
  );

  // 3) register：agentURI 先填 endpoint（转正后可以 setAgentURI 换成完整的 card JSON 地址）
  const endpointHash = keccak256(toUtf8Bytes(opts.card.endpoint));
  const modelFingerprint = keccak256(toUtf8Bytes(opts.card.model));

  const { agentId } = await withChainErrors("register", async () => {
    const tx = await registry.register(
      opts.card.endpoint, endpointHash, modelFingerprint, walletAddress, deadline, walletSig,
      { value: ENTRY_DEPOSIT },
    );
    const rc = await tx.wait(1);
    progress({ step: "register", txHash: tx.hash });
    const iface = new Interface(REGISTRY_ABI as unknown as string[]);
    for (const log of rc?.logs ?? []) {
      let parsed;
      try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { continue; }
      if (parsed?.name === "Registered") return { agentId: BigInt(parsed.args.agentId) };
    }
    throw new BacError(
      "register_no_event",
      "register 上链了但没有 Registered 事件",
      "押金可能已经扣了。用 agentIdOfController(你的地址) 查出 agentId 再继续，别重复注册。",
    );
  });

  // 4) 三轮挑战。每一轮：读当前挑战 → 在截止前算 nonce → EIP-712 签名 → 广播。
  //    求解走多核池子：单核在 3.8 秒预算内约有 11% 的概率解不出来，而重来一次要等 60 秒冷却。
  const margin = opts.broadcastMarginMs ?? 1200;
  const maxRetries = opts.maxChallengeRetries ?? 6;
  const cooldownMs = opts.reissueCooldownMs ?? REISSUE_COOLDOWN_MS;
  const pool = new SolverPool(opts.solverThreads);
  let retries = 0;
  let lastReissueAt = 0;

  try {
  for (;;) {
    const [challengeId, seed, deadlineBlock, deadlineTime, round] =
      await registry.currentChallenge(agentId);

    if (challengeId === ZeroHash) {
      const st = Number((await registry.getAgent(agentId)).status);
      if (st === 2) break;                       // ACTIVE：三轮都过了
      await reissue();
      continue;
    }

    const nowMs = Date.now();
    const headBlock = await bsc.getBlockNumber();
    const msLeft = Number(deadlineTime) * 1000 - nowMs;
    const blocksLeft = Number(deadlineBlock) - headBlock;
    if (msLeft <= margin || blocksLeft <= 0) {
      await reissue();
      continue;
    }

    const solved = await pool.solve(seed, challenge.TARGET, msLeft - margin);
    if (!solved) {
      if (++retries > maxRetries) throw new ChallengeTimeoutError(Number(round), 0, msLeft - margin);
      progress({ step: "challenge", round: Number(round) as 1 | 2 | 3, seed, nonce: 0n, msLeft: 0 });
      await reissue();
      continue;
    }
    progress({
      step: "challenge",
      round: Number(round) as 1 | 2 | 3,
      seed,
      nonce: solved.nonce,
      msLeft: Number(deadlineTime) * 1000 - Date.now(),
    });

    const sig = await challenge.sign(controller, agentId, challengeId, seed, solved.nonce, registryAddr);
    try {
      const tx = await registry.solveChallenge(agentId, challengeId, solved.nonce, sig);
      const rc = await tx.wait(1);
      const iface = new Interface(REGISTRY_ABI as unknown as string[]);
      let blocksUsed = 0;
      for (const log of rc?.logs ?? []) {
        let parsed;
        try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { continue; }
        if (parsed?.name === "ChallengeSolved") blocksUsed = Number(parsed.args.blocksUsed);
      }
      progress({ step: "solved", round: Number(round) as 1 | 2 | 3, txHash: tx.hash, blocksUsed });
    } catch (err) {
      // 超时被拒、被别人抢先重发 —— 都不是终局，重来一轮就是了。
      if (++retries > maxRetries) throw err;
      await reissue();
      continue;
    }

    const st = Number((await registry.getAgent(agentId)).status);
    if (st === 2) break;
  }
  } finally {
    await pool.close();
  }

  progress({ step: "active", agentId });

  const ctx = {
    agentId,
    controllerKey: opts.bscKey,
    layerKey,
    walletAddress,
    card: opts.card,
    addresses: addrs,
    apiBase,
    bsc,
    layer,
    store: new ExitStore(opts.statePath),
    generatedWalletKey: generatedKey,
  };
  const agent = new BacAgent(ctx);

  // 5) 可选：立刻桥进 BAC，并等中继把积分打到层内。
  if (opts.lockAmount && opts.lockAmount > 0n) {
    const { bscTx, depositId } = await agent.lock(opts.lockAmount);
    progress({ step: "lock", txHash: bscTx, credits: opts.lockAmount });
    const credited = await agent.waitCredited(depositId);
    progress({ step: "credited", layerTxHash: credited.layerTx, balance: credited.balance });
  }

  return agent;

  async function reissue(): Promise<void> {
    const wait = lastReissueAt + cooldownMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await withChainErrors("reissueChallenge", async () => {
      const tx = await registry.reissueChallenge(agentId);
      await tx.wait(1);
    });
    lastReissueAt = Date.now();
  }
}
