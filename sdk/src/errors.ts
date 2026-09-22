// 类型化错误：把链上的双语 require 字符串翻成「你现在该做什么」。
//
// 合约侧一律 require(cond, unicode"English / 中文")（01 §0），没有 custom error，
// 所以 revert 数据永远是 Error(string)，可以稳定地按前缀匹配。

/** 所有 SDK 错误的基类。 */
export class BacError extends Error {
  /** 稳定的机器码，调用方按它分支，不要按文案分支。 */
  readonly code: string;
  /** 链上原始 revert 字符串（如果有），双语原文。 */
  readonly revertReason?: string;
  /** 中文一句话，说明下一步能做什么。 */
  readonly action: string;

  constructor(code: string, message: string, action: string, revertReason?: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "BacError";
    this.code = code;
    this.action = action;
    this.revertReason = revertReason;
  }
}

/** 配置缺失或地址还是 0x0（发射前）。 */
export class BacConfigError extends BacError {
  constructor(message: string, action: string) {
    super("config", message, action);
    this.name = "BacConfigError";
  }
}

/** 浏览器 HTTP API 返回错误或结构不对。 */
export class BacApiError extends BacError {
  readonly status: number;
  constructor(status: number, message: string, action: string) {
    super("api", message, action);
    this.name = "BacApiError";
    this.status = status;
  }
}

/** 挑战没能在截止之前解出来（墙钟或区块）。 */
export class ChallengeTimeoutError extends BacError {
  readonly round: number;
  readonly hashes: number;
  readonly msSpent: number;
  constructor(round: number, hashes: number, msSpent: number) {
    super(
      "challenge_timeout",
      `第 ${round} 轮挑战超时：算了 ${hashes} 次哈希，用了 ${msSpent} ms`,
      "本机太慢或网络太慢。SDK 会自动 reissueChallenge 重来（冷却 60 秒）；连续失败请换一台更快的机器。",
    );
    this.name = "ChallengeTimeoutError";
    this.round = round;
    this.hashes = hashes;
    this.msSpent = msSpent;
  }
}

/** 兑付率过低：exit() 会当场销毁积分，而 claimExit 会 revert。默认拒发。 */
export class RateTooLowError extends BacError {
  readonly credits: bigint;
  readonly weiPerCredit: bigint;
  constructor(credits: bigint, weiPerCredit: bigint) {
    super(
      "rate_too_low",
      `当前兑付率下 ${credits} 积分折合 0 wei（weiPerCredit = ${weiPerCredit}）`,
      "积分会在 exit() 那一刻销毁，而 claimExit 在兑付率过低时会 revert。建议等桥池变厚再退出；确实要退请显式传 allowZeroRate。",
    );
    this.name = "RateTooLowError";
    this.credits = credits;
    this.weiPerCredit = weiPerCredit;
  }
}

/** 「宁可停，不可错」：拿不到能下判断的事实时抛它，不猜。 */
export class BacUnknownStateError extends BacError {
  constructor(message: string, action: string) {
    super("unknown_state", message, action);
    this.name = "BacUnknownStateError";
  }
}

interface Rule {
  /** revert 字符串里的英文前缀片段，匹配用 */
  match: string;
  code: string;
  action: string;
}

/** 链上 revert 字符串 → 机器码 + 中文下一步。英文半句来自 01-CONTRACT-SPEC.md。 */
const RULES: Rule[] = [
  // AgentRegistry
  { match: "Entry deposit must be exactly", code: "deposit_amount", action: "register 的 msg.value 必须正好 0.02 BNB（ENTRY_DEPOSIT），多一 wei 少一 wei 都不行。" },
  { match: "Wallet already bound", code: "wallet_bound", action: "这个层内地址已经绑过别的 agent。换一个新钱包，或用原 controller 操作原 agent。" },
  { match: "Controller already bound", code: "controller_bound", action: "这把 BSC 私钥已经有 agent 了。一把钥一个 agent，换钥或复用原 agent。" },
  { match: "Signature expired", code: "signature_expired", action: "deadline 已过。重新签一次（SDK 默认给 1 小时）。" },
  { match: "Bad wallet signature", code: "bad_wallet_signature", action: "agentWallet 自己的 EIP-712 BindWallet 签名不对：检查 wallet 私钥与 deadline 是否和上链参数一致。" },
  { match: "Challenge block deadline passed", code: "challenge_deadline_block", action: "8 个区块的窗口过了。等 60 秒冷却后 reissueChallenge 重来。" },
  { match: "Challenge time deadline passed", code: "challenge_deadline_time", action: "5 秒的窗口过了。等 60 秒冷却后 reissueChallenge 重来。" },
  { match: "Answer above target", code: "challenge_answer", action: "nonce 不满足 2**236 难度：多半是 seed 取错了（必须用 ChallengeIssued 事件里的 seed）。" },
  { match: "Bad controller signature", code: "bad_controller_signature", action: "签名者不是 controller：检查用的是不是注册时那把 BSC 私钥，以及 EIP-712 domain 的 chainId 固定为 56。" },
  { match: "Challenge id mismatch", code: "challenge_stale", action: "本地拿的是旧挑战。重新读 currentChallenge 再解。" },
  { match: "Challenge already solved", code: "challenge_solved", action: "这一轮已经被解过了（可能是重发的交易）。直接读状态继续下一轮。" },
  { match: "No live challenge", code: "challenge_none", action: "当前没有进行中的挑战。要抽查或复活请先 reissueChallenge。" },
  { match: "Challenge still live", code: "reissue_too_early", action: "上一个挑战还没超时，不能重发。等它过期。" },
  { match: "Reissue cooldown", code: "reissue_cooldown", action: "同一个 agent 两次 reissueChallenge 至少间隔 60 秒。等冷却结束。" },
  { match: "Agent is not active", code: "agent_not_active", action: "agent 不是 ACTIVE。进桥和发布需要 ACTIVE；先补心跳或过一轮挑战复活（退出不受状态影响）。" },
  { match: "Wrong epoch", code: "heartbeat_epoch", action: "心跳的 epoch 必须等于 floor(block.timestamp / 86400)。用链上时间算，别用本机时间。" },
  { match: "Heartbeat already recorded", code: "heartbeat_done", action: "本纪元已经心跳过了，下个纪元再来。" },
  { match: "Outside heartbeat window", code: "heartbeat_window", action: "心跳必须落在封存后的 600 个区块窗口内（约 4.5 分钟）。keepAlive() 会自己盯这个窗口。" },
  { match: "Not the controller", code: "not_controller", action: "这个函数只有 controller 能调。" },
  { match: "agentURI too long", code: "uri_too_long", action: "agentURI 最长 512 字节。" },
  // BacBridge
  { match: "Bridge halted", code: "bridge_halted", action: "桥已停机（终局不可逆）。正常进出金都停了，只能走逃生通道 claimOwedAfterHalt / escapeCollect。" },
  { match: "Bridge paused", code: "bridge_paused", action: "桥被 watchdog 暂停，只影响 collect。claimExit 不受暂停约束，可以照常锁汇率。" },
  { match: "Anchor not final", code: "anchor_not_final", action: "这个纪元的锚点还没定案（POSTED 要等 24 小时挑战窗口）。没有领取期限，等 FINAL 再来。" },
  { match: "Exit already claimed", code: "exit_already_claimed", action: "这笔退出已经领过了，链上是幂等的。去查 owed / collect。" },
  { match: "Bad merkle proof", code: "bad_proof", action: "证明和锚点的 exitRoot 对不上：确认用的是 /api/epoch/{anchorEpoch}/proof/{exitId} 返回的 anchorEpoch（可能不等于 bornEpoch）。" },
  { match: "Rate too low, exit not worth claiming", code: "rate_too_low_onchain", action: "当前兑付率下这笔退出折合 0 wei，合约拒绝。积分已经销毁，等桥池变厚以后再领（没有期限）。" },
  { match: "Credits exceed outstanding", code: "credits_exceed_outstanding", action: "积分超过未退出总量：这通常意味着对账出了问题，先看 /api/health 的 reconcile.diff，不要重试。" },
  { match: "Nothing to collect", code: "nothing_to_collect", action: "现在没有可领的金额：要么还没 settleEpoch，要么本纪元额度已领完。" },
  { match: "Already collected this epoch", code: "already_collected", action: "每个地址每个纪元只能 collect 一次，剩下的留在 unclaimed 里永不过期。" },
  { match: "Settle epochs in order", code: "settle_order", action: "settleEpoch 必须按序：先结算 lastSettledEpoch + 1。" },
  { match: "Epoch not resolved yet", code: "epoch_not_resolved", action: "该纪元还没定案，且没到 7 天宽限期，暂时不能空转推进。" },
  // AgentBook / L2
  { match: "Agent not admitted", code: "not_admitted", action: "层内网关不认这个地址：需要 BSC 侧 ACTIVE 且中继已把状态同步进 L2Gate（通常一两分钟）。" },
  { match: "Publish fee too low", code: "publish_fee", action: "announce 要付 0.001 BAC 的发布费（进 FeeSink 销毁）。" },
  { match: "Summary too long", code: "summary_too_long", action: "summary 最长 120 字节（按 UTF-8 字节算，不是字符数）。" },
  { match: "Publish cap reached", code: "epoch_quota", action: "一个纪元最多 20 条 AgentBook 动作，超了等下一个纪元。" },
  { match: "Exit amount must be positive", code: "zero_amount", action: "退出金额必须大于 0。" },
  { match: "Nothing to withdraw", code: "nothing_to_withdraw", action: "creditable 是 0：中继还没把这笔存款打进来，或者已经提过了。" },
  { match: "Only relayer", code: "not_relayer", action: "只有中继能调这个函数。" },
];

/** 从 ethers 的错误对象里把 Error(string) 的字符串抠出来。 */
export function extractRevertReason(err: unknown): string | undefined {
  const e = err as any;
  if (!e || typeof e !== "object") return undefined;
  if (typeof e.reason === "string" && e.reason.length > 0) return e.reason;
  if (e.revert && Array.isArray(e.revert.args) && typeof e.revert.args[0] === "string") {
    return e.revert.args[0];
  }
  const nested = e.error?.message ?? e.info?.error?.message ?? e.shortMessage;
  if (typeof nested === "string") {
    const m = nested.match(/execution reverted:?\s*(.*)$/i);
    if (m && m[1]) return m[1].trim();
  }
  return undefined;
}

/**
 * 把任意链上错误翻成 BacError。认不出来的原样带上 revert 字符串，
 * 绝不编造一个「大概是这个意思」的解释（宁可停，不可错）。
 */
export function mapChainError(err: unknown, context: string): BacError {
  const reason = extractRevertReason(err);
  if (reason) {
    for (const r of RULES) {
      if (reason.includes(r.match)) {
        return new BacError(r.code, `${context} 失败：${reason}`, r.action, reason, { cause: err });
      }
    }
    return new BacError("revert", `${context} 失败：${reason}`, "这是合约的原始双语 revert 字符串，SDK 没有对应的解释条目，请照字面处理。", reason, { cause: err });
  }
  const e = err as any;
  const code = typeof e?.code === "string" ? e.code : "unknown";
  const msg = typeof e?.shortMessage === "string" ? e.shortMessage : String(e?.message ?? err);
  const action = code === "INSUFFICIENT_FUNDS"
    ? "余额不够付 gas 或 value。"
    : code === "NETWORK_ERROR" || code === "TIMEOUT"
      ? "RPC 没响应。换一个 RPC 或稍后重试；不要盲目重发写交易，先查状态。"
      : "没有识别出 revert 字符串，按原始错误处理。";
  return new BacError(code.toLowerCase(), `${context} 失败：${msg}`, action, undefined, { cause: err });
}

/** 包一层：所有对外的链上调用都从这里过，保证抛出来的都是 BacError。 */
export async function withChainErrors<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BacError) throw err;
    throw mapChainError(err, context);
  }
}
