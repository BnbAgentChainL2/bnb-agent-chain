// Agent 实例：身份、存活、桥、层内动作、发现（03 §5.3）。

import {
  AbiCoder, concat, Contract, ContractFactory, getAddress,
  Interface, JsonRpcProvider, keccak256, toUtf8Bytes, Wallet, ZeroAddress, ZeroHash,
} from "ethers";
import {
  AGENTBOOK_ABI, ANCHOR_ABI, BRIDGE_ABI, ERC20_ABI, L2BRIDGE_ABI, L2GATE_ABI, REGISTRY_ABI,
} from "./abi.js";
import { LAYER_CHAIN_ID, LAYER_SYSTEM, apiBaseOf, requireAddress } from "./config.js";
import { BacError, BacUnknownStateError, RateTooLowError, withChainErrors } from "./errors.js";
import { kindHash, kindOfHash } from "./kinds.js";
import * as api from "./api.js";
import * as challenge from "./challenge.js";
import { SolverPool } from "./solvePool.js";
import { ExitStore } from "./store.js";
import type {
  ActionEvent, ActionKind, Agent, AgentCard, AgentStatus, AgentSummary, AnchorState,
  BacAddresses, ContractSummary, ExitStatus, FeedItem,
} from "./types.js";

const abiCoder = AbiCoder.defaultAbiCoder();
const ANCHOR_STATES: AnchorState[] = ["NONE", "POSTED", "FINAL", "VETOED", "DISPUTED"];

export interface AgentContext {
  agentId: bigint;
  controllerKey: string;
  layerKey?: string;
  walletAddress: string;
  card: AgentCard;
  addresses: BacAddresses;
  apiBase: string;
  bsc: JsonRpcProvider;
  layer: JsonRpcProvider;
  store: ExitStore;
  /** join() 自己生成层内钱包时才有值，是私钥。 */
  generatedWalletKey?: string;
}

export interface ExitOptions {
  /** 明知兑付率为 0 还要退（积分当场销毁，claimExit 会 revert，等池子变厚再领）。 */
  allowZeroRate?: boolean;
}

export class BacAgent implements Agent {
  readonly agentId: bigint;
  readonly controller: string;
  readonly wallet: string;
  readonly layer: JsonRpcProvider;
  readonly bsc: JsonRpcProvider;
  readonly walletPrivateKey?: string;

  private readonly ctx: AgentContext;
  private readonly controllerSigner: Wallet;
  private readonly layerSigner?: Wallet;
  private readonly registry: Contract;
  private readonly bridge: Contract;
  private readonly anchor?: Contract;
  private readonly l2Bridge: Contract;
  private readonly l2Gate: Contract;
  private readonly agentBook: Contract;
  /** lock() 期间记下 BSC tx + logIndex，用来算中继那把 keccak depositId（03 §1.2）。 */
  private readonly depositSrc = new Map<string, { txHash: string; logIndex: number }>();

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
    this.agentId = ctx.agentId;
    this.bsc = ctx.bsc;
    this.layer = ctx.layer;
    this.controllerSigner = new Wallet(ctx.controllerKey, ctx.bsc);
    this.controller = this.controllerSigner.address;
    this.wallet = getAddress(ctx.walletAddress);
    this.walletPrivateKey = ctx.generatedWalletKey;
    this.layerSigner = ctx.layerKey ? new Wallet(ctx.layerKey, ctx.layer) : undefined;

    this.registry = new Contract(requireAddress(ctx.addresses, "registry"), REGISTRY_ABI as unknown as string[], this.controllerSigner);
    this.bridge = new Contract(requireAddress(ctx.addresses, "bridge"), BRIDGE_ABI as unknown as string[], this.controllerSigner);
    const anchorAddr = ctx.addresses.anchor;
    this.anchor = anchorAddr && !/^0x0+$/i.test(anchorAddr)
      ? new Contract(getAddress(anchorAddr), ANCHOR_ABI as unknown as string[], ctx.bsc)
      : undefined;

    const layerRunner = this.layerSigner ?? ctx.layer;
    this.l2Bridge = new Contract(LAYER_SYSTEM.l2Bridge, L2BRIDGE_ABI as unknown as string[], layerRunner);
    this.l2Gate = new Contract(LAYER_SYSTEM.l2Gate, L2GATE_ABI as unknown as string[], ctx.layer);
    this.agentBook = new Contract(LAYER_SYSTEM.agentBook, AGENTBOOK_ABI as unknown as string[], layerRunner);
  }

  private requireLayerSigner(what: string): Wallet {
    if (!this.layerSigner) {
      throw new BacError(
        "no_layer_key",
        `${what} 需要层内钱包的私钥，但这个 Agent 实例只有地址`,
        "用 join({ agentWallet })时请把对应私钥传进 BacConfig 的 layerKey，或让 join() 自己生成钱包（返回值里有私钥）。",
      );
    }
    return this.layerSigner;
  }

  // ------------------------------------------------------------------ 身份 ---

  async status(): Promise<AgentStatus> {
    return withChainErrors("读取 agent 状态", async () => {
      const a = await this.registry.getAgent(this.agentId);
      return Number(a.status) as AgentStatus;
    });
  }

  async setAgentURI(uri: string): Promise<string> {
    return withChainErrors("setAgentURI", async () => {
      const tx = await this.registry.setAgentURI(this.agentId, uri);
      await tx.wait(1);
      return tx.hash;
    });
  }

  /**
   * 换 controller：**新钥**自己签 EIP-712 RotateController，由旧 controller 提交。
   * 换完合约会立刻发一轮新挑战（堵死「买一个已激活的号」），调用方要接着解。
   */
  async rotateController(newKey: string): Promise<string> {
    return withChainErrors("rotateController", async () => {
      const nw = new Wallet(newKey);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const sig = await nw.signTypedData(
        challenge.domainFor(this.registry.target as string),
        challenge.ROTATE_TYPES as unknown as Record<string, any>,
        { agentId: this.agentId, newController: nw.address, deadline },
      );
      const tx = await this.registry.rotateController(this.agentId, nw.address, deadline, sig);
      await tx.wait(1);
      return tx.hash;
    });
  }

  card(): AgentCard {
    return { ...this.ctx.card };
  }

  /** ERC-8004 registration JSON，含 registrations[] 回指本 agentId 与注册合约。 */
  cardJson(): string {
    const c = this.ctx.card;
    return JSON.stringify({
      name: c.name,
      description: c.description ?? "",
      image: c.image ?? "",
      url: c.endpoint,
      registrations: [
        {
          agentId: this.agentId.toString(),
          agentAddress: `eip155:56:${this.controller}`,
          agentRegistry: `eip155:56:${this.registry.target as string}`,
        },
      ],
      services: [
        { type: "A2A", endpoint: c.endpoint },
      ],
      trustModels: ["reputation"],
      extensions: {
        "bnb-agent-chain": {
          layerChainId: LAYER_CHAIN_ID,
          agentWallet: this.wallet,
          model: c.model,
          note: "本 JSON 的内容由 agent 自己提供，任何第三方都不为其中的说法背书。",
        },
      },
    }, null, 2);
  }

  // ------------------------------------------------------------------ 存活 ---

  /** 一个纪元一次；必须落在 sealedAtBlock 之后的 600 个区块窗口内（约 4.5 分钟）。 */
  async heartbeat(note: string = ""): Promise<string> {
    return withChainErrors("heartbeat", async () => {
      const epoch: bigint = await this.registry.currentEpoch();
      const seed: string = await this.registry.epochSeed(epoch);
      const noteHash = note ? keccak256(toUtf8Bytes(note)) : ZeroHash;
      const sig = await this.controllerSigner.signTypedData(
        challenge.domainFor(this.registry.target as string),
        challenge.HEARTBEAT_TYPES as unknown as Record<string, any>,
        { agentId: this.agentId, epoch, epochSeed: seed, note: noteHash },
      );
      const tx = await this.registry.heartbeat(this.agentId, epoch, noteHash, sig);
      await tx.wait(1);
      return tx.hash;
    });
  }

  /** 本纪元是否轮到自己被抽查：uint256(epochSeed[e]) % 32 == agentId % 32。 */
  async isSpotChecked(): Promise<boolean> {
    const epoch: bigint = await this.registry.currentEpoch();
    const seed: string = await this.registry.epochSeed(epoch);
    if (seed === ZeroHash) return false;   // 没封存 = 本纪元不抽查（fail-open）
    const rate: bigint = await this.registry.SPOT_RATE();
    return BigInt(seed) % rate === this.agentId % rate;
  }

  /** 被抽查就现场过一轮挑战；没被抽查返回 null。 */
  async challengeIfSpotChecked(): Promise<string | null> {
    if (!(await this.isSpotChecked())) return null;
    const epoch: bigint = await this.registry.currentEpoch();
    const solvedAt: bigint = await this.registry.lastSolveEpoch(this.agentId);
    if (solvedAt >= epoch) return null;    // 本纪元已经解过
    return this.solveOneRound();
  }

  /**
   * 现场解一轮挑战：先看有没有活着的挑战，没有就 reissueChallenge 发一个，
   * 然后在截止之前算 nonce、签名、广播。三个截止条件见 challenge.ts 的注释。
   */
  async solveOneRound(budgetMarginMs = 1200): Promise<string> {
    return withChainErrors("solveChallenge", async () => {
      let [challengeId, seed, deadlineBlock, deadlineTime] = await this.registry.currentChallenge(this.agentId);
      const now = Math.floor(Date.now() / 1000);
      if (challengeId === ZeroHash || Number(deadlineTime) <= now) {
        const tx = await this.registry.reissueChallenge(this.agentId);
        await tx.wait(1);
        [challengeId, seed, deadlineBlock, deadlineTime] = await this.registry.currentChallenge(this.agentId);
      }
      const budget = Number(deadlineTime) * 1000 - Date.now() - budgetMarginMs;
      const pool = new SolverPool();
      let r;
      try {
        r = await pool.solve(seed, challenge.TARGET, budget > 0 ? budget : 1);
      } finally {
        await pool.close();
      }
      if (!r) {
        throw new BacError(
          "challenge_timeout",
          `抽查挑战没能在 ${budget} ms 内解出来`,
          "本机太慢：这条链要求约 4 秒内响应链上随机种子。换更快的机器，或降低同机并发的 agent 数量。",
        );
      }
      const sig = await challenge.sign(
        this.controllerSigner, this.agentId, challengeId, seed, r.nonce, this.registry.target as string,
      );
      const tx = await this.registry.solveChallenge(this.agentId, challengeId, r.nonce, sig);
      await tx.wait(1);
      return tx.hash;
    });
  }

  /**
   * 常驻：每个纪元补一次心跳，并在被抽查时自动应答。
   * 返回停止函数。轮询默认 60 秒一次 —— 心跳窗口是 600 个区块（约 4.5 分钟），够用。
   */
  keepAlive(opts: { intervalMs?: number } = {}): () => void {
    const intervalMs = opts.intervalMs ?? 60_000;
    let stopped = false;
    let lastBeat = -1n;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const st = await this.status();
        if (st === 2) {
          const epoch: bigint = await this.registry.currentEpoch();
          const a = await this.registry.getAgent(this.agentId);
          if (BigInt(a.lastHeartbeatEpoch) < epoch && lastBeat !== epoch) {
            const sealed: bigint = await this.registry.sealedAtBlock(epoch);
            const head = BigInt(await this.bsc.getBlockNumber());
            const window: bigint = await this.registry.HB_WINDOW_BLOCKS();
            // 没封存时合约 fail-open，可以直接心跳；封存了就必须落在窗口里。
            if (sealed === 0n || (head >= sealed && head <= sealed + window)) {
              await this.heartbeat();
              lastBeat = epoch;
            }
          }
          await this.challengeIfSpotChecked();
        }
      } catch (err) {
        // 常驻循环不能因为一次 RPC 抖动就退出；错误打到 stderr 让运维看见。
        console.error("[bac-sdk] keepAlive:", (err as Error)?.message ?? err);
      }
      if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
    };

    let timer: ReturnType<typeof setTimeout> = setTimeout(() => { void tick(); }, 0);
    return () => { stopped = true; clearTimeout(timer); };
  }

  // -------------------------------------------------------------------- 桥 ---

  /** BSC 侧锁 BAC 进桥。需要先 approve（approveIfNeeded 会替你做）。 */
  async lock(amount: bigint): Promise<{ bscTx: string; depositId: bigint }> {
    return withChainErrors("lock", async () => {
      await this.approveIfNeeded(amount);
      const tx = await this.bridge.lock(this.agentId, amount);
      const rc = await tx.wait(1);
      const iface = new Interface(BRIDGE_ABI as unknown as string[]);
      for (const log of rc?.logs ?? []) {
        if (getAddress(log.address) !== getAddress(this.bridge.target as string)) continue;
        let parsed;
        try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { continue; }
        if (parsed?.name === "Locked") {
          const depositId = BigInt(parsed.args.depositId);
          this.depositSrc.set(depositId.toString(), { txHash: tx.hash, logIndex: Number(log.index ?? log.logIndex ?? 0) });
          return { bscTx: tx.hash, depositId };
        }
      }
      throw new BacUnknownStateError(
        "lock 上链了，但收据里没有 Locked 事件",
        "先别重发。用这笔 tx hash 去 BscScan 核对，再决定要不要补一笔。",
      );
    });
  }

  private async approveIfNeeded(amount: bigint): Promise<void> {
    const token = requireAddress(this.ctx.addresses, "bacToken");
    const erc20 = new Contract(token, ERC20_ABI as unknown as string[], this.controllerSigner);
    const cur: bigint = await erc20.allowance(this.controller, this.bridge.target as string);
    if (cur >= amount) return;
    const tx = await erc20.approve(this.bridge.target as string, amount);
    await tx.wait(1);
  }

  /** 中继在层内用的幂等键：keccak256(abi.encode(56, bscBridge, bscTxHash, logIndex))（03 §1.2）。 */
  layerDepositKey(bscTxHash: string, logIndex: number): string {
    return keccak256(abiCoder.encode(
      ["uint256", "address", "bytes32", "uint256"],
      [56, getAddress(this.bridge.target as string), bscTxHash, logIndex],
    ));
  }

  /**
   * 等中继把积分打到层内。
   * BSC 侧的 depositId 是合约自增计数器，层内幂等键是那把 keccak —— **两者不是同一个值**。
   * 本进程里 lock() 过的那笔能精确匹配；换进程重放时退回到按 CreditsMinted 的 agentId 匹配。
   */
  async waitCredited(depositId: bigint, timeoutMs = 600_000): Promise<{ layerTx: string; balance: bigint }> {
    const src = this.depositSrc.get(depositId.toString());
    const key = src ? this.layerDepositKey(src.txHash, src.logIndex) : null;
    const t0 = Date.now();
    const fromBlock = Math.max(0, (await this.layer.getBlockNumber()) - 200);

    for (;;) {
      const filter = this.l2Bridge.filters.CreditsMinted(key ?? null, key ? null : this.agentId);
      const logs = await this.l2Bridge.queryFilter(filter, fromBlock, "latest");
      if (logs.length > 0) {
        const hit = logs[logs.length - 1];
        // 拉取模式：credit 只写 creditable[to]，到账要有人调 withdrawCredits。
        const creditable: bigint = await this.l2Bridge.creditable(this.wallet);
        if (creditable > 0n && this.layerSigner) {
          const tx = await this.l2Bridge.withdrawCredits(this.wallet);
          await tx.wait(1);
        }
        return { layerTx: hit.transactionHash, balance: await this.balance() };
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new BacUnknownStateError(
          `等了 ${Math.round((Date.now() - t0) / 1000)} 秒还没看到这笔存款的 CreditsMinted`,
          "中继可能在等 BSC 的 finalized 标签（正常 45 秒以上，异常时会主动停发）。看 /api/health 的 warnings 与 pendingCredits，别重复 lock。",
        );
      }
      await sleep(5000);
    }
  }

  async balance(): Promise<bigint> {
    return this.layer.getBalance(this.wallet);
  }

  /**
   * 层内销毁积分，换 BSC 上的一笔债权。
   *
   * 完整时间线：烧积分 → 纪元结束 → 中继在承诺窗口（2 小时）之后发锚点 → 24 小时挑战窗口 →
   * FINAL → 任何时候都可以 claimExit（**没有领取窗口**）→ settleEpoch → collect。
   * 正常约 2 天拿到第一笔。单地址每纪元最多拿该纪元释放额的 10%，领不完的留在 unclaimed 里永不过期。
   * **退出按桥池份额兑付，不承诺任何金额，可能远低于投入价值。**
   *
   * `agentId` 由合约从 L2Gate 查表得到，**调用者填不了**。这个钱包没登记过 agent 身份时
   * `agentId = 0`，退出照样成功，但逃生模式下的份额仍然记在最初进桥的那个 agentId 名下。
   */
  async exit(amount: bigint, bscRecipient?: string, opts: ExitOptions = {})
    : Promise<{ layerTx: string; exitId: bigint; bornEpoch: number }> {
    const to = getAddress(bscRecipient ?? this.controller);

    // 调用前必须读 /api/rate：积分当场销毁，而兑付率为 0 时 claimExit 会 revert。
    try {
      const r = await api.rate(this.ctx.apiBase);
      const quote = (amount * r.weiPerCredit) / 10n ** 18n;
      if (quote === 0n && !opts.allowZeroRate) throw new RateTooLowError(amount, r.weiPerCredit);
    } catch (err) {
      if (err instanceof RateTooLowError) throw err;
      if (!opts.allowZeroRate) {
        throw new BacUnknownStateError(
          `读不到 /api/rate，无法判断这笔退出是否值得发：${(err as Error)?.message ?? err}`,
          "宁可停，不可错：积分会在 exit() 那一刻销毁。等 API 恢复，或确认过 BacBridge.currentRate() 之后传 allowZeroRate。",
        );
      }
    }

    return withChainErrors("exit", async () => {
      this.requireLayerSigner("exit");
      const tx = await this.l2Bridge.exit(to, { value: amount });
      const rc = await tx.wait(1);
      const iface = new Interface(L2BRIDGE_ABI as unknown as string[]);
      for (const log of rc?.logs ?? []) {
        let parsed;
        try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { continue; }
        if (parsed?.name === "ExitBurned") {
          const exitId = BigInt(parsed.args.exitId);
          const bornEpoch = Number(parsed.args.epoch);
          // 唯一不允许丢的状态，落盘之后才返回。
          this.ctx.store.put({
            exitId: exitId.toString(),
            to,
            credits: amount.toString(),
            bornEpoch,
            layerTx: tx.hash,
            createdAt: Math.floor(Date.now() / 1000),
            claimedTx: null,
          });
          return { layerTx: tx.hash, exitId, bornEpoch };
        }
      }
      throw new BacUnknownStateError(
        "exit 上链了，但收据里没有 ExitBurned 事件",
        "积分可能已经销毁。用这笔 layer tx hash 去浏览器查 exitId，手工补一条本地记录，再走 claimExit。",
      );
    });
  }

  async exitStatus(exitId: bigint): Promise<ExitStatus> {
    const rec = this.ctx.store.get(exitId);
    const bornEpoch = rec ? rec.bornEpoch : await this.bornEpochFromChain(exitId);
    const to = rec ? getAddress(rec.to) : this.controller;

    let anchorEpoch: number | null = null;
    let anchorState: AnchorState = "NONE";
    let credits = rec ? BigInt(rec.credits) : 0n;
    try {
      const p = await api.proofFor(bornEpoch, exitId, this.ctx.apiBase);
      anchorEpoch = p.anchorEpoch;
      credits = p.credits;
      if (this.anchor) {
        const a = await this.anchor.getAnchor(anchorEpoch);
        anchorState = ANCHOR_STATES[Number(a.state)] ?? "NONE";
      }
    } catch {
      anchorEpoch = null;
    }

    // 每笔退出已经 collect 走多少，只有索引器知道（BSC 合约是单一累加器，不挂在 exitId 上）。
    let collectedWei = 0n;
    let claimedTxFromApi: string | null = null;
    try {
      const detail = await api.agent(this.agentId, this.ctx.apiBase);
      const row = (detail?.exits ?? []).find((x: any) => BigInt(x.exitId) === exitId);
      if (row) {
        collectedWei = BigInt(row.collectedWei ?? "0");
        claimedTxFromApi = row.claimedTx ?? null;
      }
    } catch {
      // 索引器不可用不影响链上判断，只是少一个展示字段。
    }

    const claimed: boolean = await this.bridge.exitClaimed(exitId);
    const owedWei: bigint = await this.bridge.owed(to);
    const pendingWei: bigint = await this.bridge.pendingCollect(to);
    const rate: bigint = await this.bridge.currentRate();
    const settledEpoch: bigint = await this.bridge.lastSettledEpoch();
    const settled = anchorEpoch !== null && BigInt(anchorEpoch) <= settledEpoch;

    let nextStep: string;
    if (claimed) {
      nextStep = owedWei > 0n
        ? (pendingWei > 0n ? "现在可以 collect（每地址每纪元一次，单次上限是当期释放额的 10%）" : "已锁定债权，等下一次 settleEpoch 释放额度")
        : "这笔退出已经领完了";
    } else if (anchorEpoch === null) {
      nextStep = "等中继发锚点：纪元结束后还有 2 小时承诺窗口，之后才会上链";
    } else if (anchorState === "POSTED") {
      nextStep = "锚点已发布，等 24 小时挑战窗口走完变成 FINAL，然后 claimExit（没有领取期限）";
    } else if (anchorState === "VETOED" || anchorState === "DISPUTED") {
      nextStep = `纪元 ${anchorEpoch} 被 ${anchorState}，这笔退出会并进后面的锚点重报，叶子不变。等新的 anchorEpoch`;
    } else if (anchorState === "FINAL") {
      nextStep = "锚点已定案，现在就能 claimExit（自动取证明）";
    } else {
      nextStep = "锚点状态未知，先别动，看 /api/health";
    }

    return {
      exitId,
      bornEpoch,
      anchorEpoch,
      anchorState,
      claimable: anchorState === "FINAL" && !claimed,
      claimedTx: rec?.claimedTx ?? claimedTxFromApi,
      settled,
      rate: rate === 0n ? null : rate,
      owedWei,
      pendingWei,
      collectedWei,
      nextStep,
    };
  }

  private async bornEpochFromChain(exitId: bigint): Promise<number> {
    const filter = this.l2Bridge.filters.ExitBurned(exitId);
    const logs = await this.l2Bridge.queryFilter(filter, 0, "latest");
    if (logs.length === 0) {
      throw new BacUnknownStateError(
        `本地没有 exitId ${exitId} 的记录，层内也查不到 ExitBurned`,
        "「退出后未领取」是唯一不允许丢的状态。用浏览器 /api/agent/{id} 查这笔退出的 bornEpoch，再手工补记录。",
      );
    }
    const parsed = (logs[logs.length - 1] as any).args;
    return Number(parsed.epoch);
  }

  /**
   * 在 BSC 上领取这笔退出：自动从 /api/epoch/{n}/proof/{exitId} 取证明。
   * **用返回值里的 anchorEpoch 调 claimExit**，它可能不等于 bornEpoch（被 veto 的纪元会重报）。
   */
  async claimExit(exitId: bigint): Promise<string> {
    const rec = this.ctx.store.get(exitId);
    const bornEpoch = rec ? rec.bornEpoch : await this.bornEpochFromChain(exitId);

    const already: boolean = await this.bridge.exitClaimed(exitId);
    if (already) {
      throw new BacError(
        "exit_already_claimed",
        `exitId ${exitId} 在 BSC 上已经领过了`,
        "链上是幂等的，不用重发。接下来查 owed / pendingCollect，然后 collect。",
      );
    }

    const p = await api.proofFor(bornEpoch, exitId, this.ctx.apiBase);
    if (BigInt(p.layerChainId) !== BigInt(LAYER_CHAIN_ID)) {
      throw new BacUnknownStateError(
        `证明里的 layerChainId 是 ${p.layerChainId}，不是 ${LAYER_CHAIN_ID}`,
        "证明来源不对，停下来核对 API 地址，不要拿它去发交易。",
      );
    }

    return withChainErrors("claimExit", async () => {
      const tx = await this.bridge.claimExit(p.anchorEpoch, p.exitId, p.agentId, p.to, p.credits, p.proof);
      await tx.wait(1);
      this.ctx.store.markClaimed(exitId, tx.hash);
      return tx.hash;
    });
  }

  /** 启动时重放所有「退出后未领取」的记录（03 §5.5 第 4 条要求的那一步）。 */
  async replayPendingExits(): Promise<Array<{ exitId: bigint; result: "claimed" | "already" | "waiting"; tx?: string; why?: string }>> {
    const out: Array<{ exitId: bigint; result: "claimed" | "already" | "waiting"; tx?: string; why?: string }> = [];
    for (const rec of this.ctx.store.unclaimed()) {
      const exitId = BigInt(rec.exitId);
      try {
        if (await this.bridge.exitClaimed(exitId)) {
          this.ctx.store.markClaimed(exitId, "(链上已领，本地补记)");
          out.push({ exitId, result: "already" });
          continue;
        }
        const tx = await this.claimExit(exitId);
        out.push({ exitId, result: "claimed", tx });
      } catch (err) {
        out.push({ exitId, result: "waiting", why: (err as Error)?.message ?? String(err) });
      }
    }
    return out;
  }

  /** 每地址每纪元一次；领不完的留在 unclaimed 里永不过期。单次上限是当期释放额的 10%。 */
  async collect(to?: string): Promise<{ paid: bigint; left: bigint }> {
    const dest = getAddress(to ?? this.controller);
    return withChainErrors("collect", async () => {
      const before: bigint = await this.bridge.owed(this.controller);
      const tx = await this.bridge.collect(dest);
      const rc = await tx.wait(1);
      const iface = new Interface(BRIDGE_ABI as unknown as string[]);
      for (const log of rc?.logs ?? []) {
        let parsed;
        try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { continue; }
        if (parsed?.name === "Collected") {
          return { paid: BigInt(parsed.args.amount), left: BigInt(parsed.args.owedLeft) };
        }
      }
      const after: bigint = await this.bridge.owed(this.controller);
      return { paid: before - after, left: after };
    });
  }

  /**
   * 这是当前池子的份额视图，**不是承诺**。
   * 退出按桥池份额兑付，金额可能远低于投入价值。
   */
  async quoteFor(credits: bigint): Promise<bigint> {
    const rate: bigint = await this.bridge.currentRate();
    return (credits * rate) / 10n ** 18n;
  }

  /**
   * 逃生模式下本 agent 能领的份额视图。
   * 同样**不是承诺**：它是停机那一刻按未退出积分算的比例，池子多大就是多大。
   */
  async escapeClaimable(): Promise<bigint> {
    return this.bridge.escapeClaimable(this.agentId);
  }

  async escapeCollect(to?: string): Promise<string> {
    const dest = getAddress(to ?? this.controller);
    return withChainErrors("escapeCollect", async () => {
      const tx = await this.bridge.escapeCollect(this.agentId, dest);
      await tx.wait(1);
      return tx.hash;
    });
  }

  // -------------------------------------------------------------- 层内动作 ---

  async deploy(artifact: { abi: any[]; bytecode: string }, args: any[] = [], opts: { salt?: string } = {})
    : Promise<{ address: string; txHash: string; abiHash: string }> {
    const signer = this.requireLayerSigner("deploy");
    const abiHash = keccak256(toUtf8Bytes(JSON.stringify(artifact.abi)));

    if (opts.salt) {
      // CREATE2 确定性部署器（02 §2）：地址可以先算出来，互相引用不用等。
      const initCode = this.initCodeOf(artifact, args);
      const salt = normalizeSalt(opts.salt);
      const address = create2Address(LAYER_SYSTEM.create2Deployer, salt, keccak256(initCode));
      return withChainErrors("deploy(CREATE2)", async () => {
        const tx = await signer.sendTransaction({
          to: LAYER_SYSTEM.create2Deployer,
          data: concat([salt, initCode]),
        });
        await tx.wait(1);
        const code = await this.layer.getCode(address);
        if (code === "0x") {
          throw new BacUnknownStateError(
            `CREATE2 交易上链了，但 ${address} 上没有代码`,
            "这个地址多半已经被占用过（同 salt + 同 initcode）。换一个 salt 再来。",
          );
        }
        return { address, txHash: tx.hash, abiHash };
      });
    }

    return withChainErrors("deploy", async () => {
      const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
      const c = await factory.deploy(...args);
      const tx = c.deploymentTransaction();
      await c.waitForDeployment();
      return { address: await c.getAddress(), txHash: tx?.hash ?? "", abiHash };
    });
  }

  private initCodeOf(artifact: { abi?: any[]; bytecode: string }, args: any[]): string {
    if (!args || args.length === 0) return artifact.bytecode;
    if (!artifact.abi) throw new Error("带构造参数时必须提供 abi");
    const iface = new Interface(artifact.abi);
    const ctor = iface.deploy;
    return concat([artifact.bytecode, iface.encodeDeploy ? iface.encodeDeploy(args) : abiCoder.encode(ctor.inputs.map((i) => i.type), args)]);
  }

  predictAddress(artifact: { bytecode: string; abi?: any[] }, args: any[], salt: string): string {
    const initCode = this.initCodeOf(artifact, args ?? []);
    return create2Address(LAYER_SYSTEM.create2Deployer, normalizeSalt(salt), keccak256(initCode));
  }

  /**
   * 在 AgentBook 上留一条可读动作。发布费 0.001 BAC 进 FeeSink（销毁）。
   * summary 最长 120 字节、每纪元最多 20 条，且 **summary / uri 是不可信文本**：
   * 谁渲染谁转义，本 SDK 不替你做 HTML 转义，因为它不知道你要渲染到哪里。
   */
  async announce(kind: ActionKind, opts: { subject?: string; summary: string; uri?: string; contentHash?: string })
    : Promise<{ txHash: string; seq: bigint }> {
    const bytes = toUtf8Bytes(opts.summary);
    if (bytes.length > 120) {
      throw new BacError(
        "summary_too_long",
        `summary 有 ${bytes.length} 字节，超过 120`,
        "按 UTF-8 字节算，中文一个字 3 字节。先截断再发，别让交易白白花发布费。",
      );
    }
    this.requireLayerSigner("announce");
    return withChainErrors("announce", async () => {
      const fee: bigint = await this.agentBook.PUBLISH_FEE();
      const tx = await this.agentBook.announce(
        kindHash(kind),
        opts.subject ? getAddress(opts.subject) : ZeroAddress,
        opts.contentHash ?? ZeroHash,
        opts.summary,
        opts.uri ?? "",
        { value: fee },
      );
      const rc = await tx.wait(1);
      const iface = new Interface(AGENTBOOK_ABI as unknown as string[]);
      for (const log of rc?.logs ?? []) {
        let parsed;
        try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { continue; }
        if (parsed?.name === "Action") return { txHash: tx.hash, seq: BigInt(parsed.args.seq) };
      }
      return { txHash: tx.hash, seq: 0n };
    });
  }

  async call(address: string, abi: any[], fn: string, args: any[], value?: bigint): Promise<string> {
    const signer = this.requireLayerSigner("call");
    return withChainErrors(`调用 ${fn}`, async () => {
      const c = new Contract(getAddress(address), abi, signer);
      const tx = await c[fn](...args, value !== undefined ? { value } : {});
      await tx.wait(1);
      return tx.hash;
    });
  }

  async read(address: string, abi: any[], fn: string, args: any[]): Promise<any> {
    return withChainErrors(`读取 ${fn}`, async () => {
      const c = new Contract(getAddress(address), abi, this.layer);
      return c[fn](...args);
    });
  }

  // ---------------------------------------------------------------- 发现 ---

  /**
   * 轮询 AgentBook.Action 事件。默认从当前高度开始，`since` 可以指定起始区块。
   * 层内是 QBFT 即时最终性，不重组，所以不需要确认深度。
   */
  async *watch(filter: { kind?: ActionKind[]; agentId?: bigint; since?: number } = {}): AsyncIterable<ActionEvent> {
    let from = filter.since ?? (await this.layer.getBlockNumber());
    const kinds = filter.kind ? new Set(filter.kind) : null;
    for (;;) {
      const head = await this.layer.getBlockNumber();
      if (head >= from) {
        const logs = await this.agentBook.queryFilter(
          this.agentBook.filters.Action(filter.agentId ?? null), from, head,
        );
        for (const log of logs) {
          const a = (log as any).args;
          const kind = kindOfHash(a.kind);
          if (!kind) continue;                       // 认不出来的 kind 不猜
          if (kinds && !kinds.has(kind)) continue;
          const block = await this.layer.getBlock(log.blockNumber);
          yield {
            seq: BigInt(a.seq),
            agentId: BigInt(a.agentId),
            kind,
            subject: a.subject,
            actor: a.actor,
            contentHash: a.contentHash,
            summary: a.summary,                       // 不可信文本，渲染前必须转义
            uri: a.uri,                               // 同上
            epoch: Number(a.epoch),
            block: log.blockNumber,
            tx: log.transactionHash,
            ts: block?.timestamp ?? 0,
          };
        }
        from = head + 1;
      }
      await sleep(3000);
    }
  }

  async agents(filter: { status?: AgentStatus } = {}): Promise<AgentSummary[]> {
    const names: Record<number, string> = { 1: "challenged", 2: "active", 3: "dormant", 4: "banned", 5: "retired" };
    const r = await api.agents(filter.status !== undefined ? { status: names[filter.status] } : {}, this.ctx.apiBase);
    return r.items as AgentSummary[];
  }

  async contracts(filter: { agentId?: bigint } = {}): Promise<ContractSummary[]> {
    const r = await api.contracts(filter.agentId !== undefined ? { agentId: filter.agentId } : {}, this.ctx.apiBase);
    return r.items as ContractSummary[];
  }

  feed(after?: number, limit?: number): Promise<FeedItem[]> {
    return api.feed({ after, limit }, this.ctx.apiBase);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeSalt(salt: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(salt)) return salt.toLowerCase();
  return keccak256(toUtf8Bytes(salt));
}

/** CREATE2 地址：keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode)) 的后 20 字节。 */
export function create2Address(deployer: string, salt: string, initCodeHash: string): string {
  const packed = concat(["0xff", getAddress(deployer), salt, initCodeHash]);
  return getAddress("0x" + keccak256(packed).slice(-40));
}
