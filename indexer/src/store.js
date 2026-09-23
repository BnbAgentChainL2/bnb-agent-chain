// src/store.js —— 把解码后的事件幂等地写进 §2 的表，并渲染一条 feed。
// 幂等的两条底线：
//   1. 每条日志有一个稳定的键 uniq = chain:txHash:logIndex，重启重放不会产生第二行；
//   2. 所有域表的写入都是 upsert，且计数器（deploys / announces / credited / exited）
//      只在「这条日志是第一次见」时才累加 —— 累加型字段是重放安全性最容易破的地方。
import { AbiCoder, keccak256, getAddress } from "ethers";
import { upsert, tx as withTx } from "./db.js";
import { decodeLog, epochOf, addr, hash } from "./decode.js";
import { renderEvent, renderDeploy, renderCall } from "./render.js";
import { root as exitRoot, ZERO_ROOT } from "./exit-tree.js";
import { warn } from "./warnings.js";

const coder = AbiCoder.defaultAbiCoder();

/** 层内幂等键：keccak256(abi.encode(56, bscBridgeAddr, bscTxHash, logIndex))（03 §1.2）。
 *  它与 BacBridge.Locked 事件里那个自增的 depositId **不是同一个值**，写码时不许混用。 */
export function layerKeyFor(bscChainId, bridgeAddr, bscTxHash, logIndex) {
  return keccak256(
    coder.encode(
      ["uint256", "address", "bytes32", "uint256"],
      [BigInt(bscChainId), getAddress(bridgeAddr), hash(bscTxHash), BigInt(logIndex)]
    )
  );
}

export function uniqOf(chain, txHash, logIndex) {
  return `${chain}:${hash(txHash)}:${Number(logIndex)}`;
}

/** 原始日志落库。返回 true 表示这一条是第一次见（累加型字段只在 true 时动）。 */
export function recordLog(db, { chain, log, ts }) {
  const uniq = uniqOf(chain, log.transactionHash, log.logIndex);
  const before = db.prepare("SELECT 1 FROM logs WHERE uniq = ?").get(uniq);
  if (before) return { uniq, fresh: false };
  upsert(
    db,
    "logs",
    {
      uniq,
      chain,
      block: Number(log.blockNumber),
      tx: hash(log.transactionHash),
      log_index: Number(log.logIndex),
      address: addr(log.address),
      topics: JSON.stringify((log.topics || []).map(hash)),
      data: hash(log.data ?? "0x"),
      ts: Number(ts),
    },
    ["uniq"],
    []
  );
  return { uniq, fresh: true };
}

/** feed 写入。feed_key 保证同一条日志只进一次 feed。 */
export function feedPush(db, { uniq, chain, kind, ts, block, agentId, textZh, tx, anchored, epoch }) {
  const exists = db.prepare("SELECT feed_id FROM feed_key WHERE uniq = ?").get(uniq);
  if (exists) return Number(exists.feed_id);
  const info = db
    .prepare(
      "INSERT INTO feed (chain, kind, ts, block, agent_id, text_zh, tx, anchored, epoch) VALUES (?,?,?,?,?,?,?,?,?)"
    )
    .run(
      chain,
      kind,
      Number(ts),
      Number(block),
      agentId === null || agentId === undefined ? null : Number(agentId),
      textZh,
      hash(tx),
      anchored ? 1 : 0,
      epoch === null || epoch === undefined ? null : Number(epoch)
    );
  const feedId = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO feed_key (uniq, feed_id) VALUES (?, ?)").run(uniq, feedId);
  return feedId;
}

function bumpAgent(db, agentId, col, delta) {
  if (agentId === null || agentId === undefined) return;
  db.prepare(`UPDATE agents SET "${col}" = "${col}" + ? WHERE agent_id = ?`).run(delta, Number(agentId));
}

function bumpAgentWei(db, agentId, col, deltaWeiStr) {
  if (agentId === null || agentId === undefined) return;
  const row = db.prepare(`SELECT "${col}" AS v FROM agents WHERE agent_id = ?`).get(Number(agentId));
  if (!row) return;
  const next = (BigInt(row.v || "0") + BigInt(deltaWeiStr || "0")).toString(10);
  db.prepare(`UPDATE agents SET "${col}" = ? WHERE agent_id = ?`).run(next, Number(agentId));
}

/**
 * agents 表的一行 = 一个锁过桥的 ERC-8004 身份。已有就只把「第一次」往前推（重放 / 乱序安全），不覆盖别的列。
 * 001 里那些旧注册表的列（agent_uri / endpoint_hash / model_fp / status ...）v2 没有来源：
 * 写空串与 2（= 已经锁过桥），API 不再返回它们。
 */
function ensureAgent(db, agentId, { controller, wallet, ts, block }) {
  if (agentId === null || agentId === undefined) return;
  db.prepare(
    `INSERT INTO agents (agent_id, controller, wallet, agent_uri, endpoint_hash, model_fp, status, registered_at, first_lock_block)
     VALUES (?, ?, ?, '', '', '', 2, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       registered_at = MIN(agents.registered_at, excluded.registered_at),
       first_lock_block = CASE
         WHEN agents.first_lock_block IS NULL OR agents.first_lock_block > excluded.first_lock_block
         THEN excluded.first_lock_block ELSE agents.first_lock_block END`
  ).run(Number(agentId), addr(controller), addr(wallet), Number(ts), Number(block));
}

/** 记下「这个地址以这个身份进过桥」。同一对只留最早那一笔。 */
function noteAgentWallet(db, { wallet, agentId, depositId, block, ts }) {
  db.prepare(
    `INSERT INTO agent_wallets (wallet, agent_id, first_deposit_id, first_bsc_block, first_ts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(wallet, agent_id) DO UPDATE SET
       first_deposit_id = MIN(agent_wallets.first_deposit_id, excluded.first_deposit_id),
       first_bsc_block = MIN(agent_wallets.first_bsc_block, excluded.first_bsc_block),
       first_ts = MIN(agent_wallets.first_ts, excluded.first_ts)`
  ).run(addr(wallet), Number(agentId), Number(depositId), Number(block), Number(ts));
}

function ensureEpoch(db, epoch) {
  db.prepare("INSERT INTO epochs (epoch, state) VALUES (?, 'NONE') ON CONFLICT(epoch) DO NOTHING").run(
    Number(epoch)
  );
}

function setEpoch(db, epoch, fields) {
  ensureEpoch(db, epoch);
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  db.prepare(
    `UPDATE epochs SET ${cols.map((c) => `"${c}" = ?`).join(", ")} WHERE epoch = ?`
  ).run(...cols.map((c) => fields[c]), Number(epoch));
}

/**
 * 处理一条已解码事件。
 * ctx: { db, chain, cfg, ts, log, uniq, fresh }
 */
export function applyEvent(ctx, ev) {
  const { db, chain, ts, log, uniq, fresh, cfg } = ctx;
  const a = ev.args;
  const block = Number(log.blockNumber);
  const txh = hash(log.transactionHash);
  const key = `${ev.contract}.${ev.event}`;

  switch (key) {
    // ===== BacBridge（v2：ERC-8004 门禁 + UUPS 代理）=====
    // 决策 #31：没有我们自己的注册表了。一个 agent = 一个锁过桥的 ERC-8004 身份 id，
    // agents 表的行由它**第一次** Locked（或同一笔交易里先发出的 AgentControllerSet）建出来。
    case "BacBridge.AgentControllerSet":
      ensureAgent(db, ev.agentId, { controller: a.current, wallet: a.current, ts, block });
      db.prepare("UPDATE agents SET controller = ? WHERE agent_id = ?").run(a.current, ev.agentId);
      break;
    case "BacBridge.Locked": {
      const bridge = (cfg && cfg.addresses && cfg.addresses.BacBridge) || addr(log.address);
      const layerKey = layerKeyFor(cfg ? cfg.bscChainId : 56, bridge, txh, log.logIndex);
      upsert(
        db,
        "deposits",
        {
          deposit_id: Number(a.depositId),
          layer_key: layerKey,
          agent_id: ev.agentId,
          from_addr: a.from,
          layer_wallet: a.layerWallet,
          measured: a.measured,
          credits: a.credits,
          bsc_block: block,
          bsc_tx: txh,
        },
        ["deposit_id"],
        ["layer_key", "agent_id", "from_addr", "layer_wallet", "measured", "credits", "bsc_block", "bsc_tx"]
      );
      // 第一次锁入时 controller = 调用者（BacBridge.lock 的 agentController 规则）；之后只由 AgentControllerSet 改。
      ensureAgent(db, ev.agentId, { controller: a.from, wallet: a.layerWallet, ts, block });
      noteAgentWallet(db, { wallet: a.layerWallet, agentId: ev.agentId, depositId: Number(a.depositId), block, ts });
      if (fresh) bumpAgentWei(db, ev.agentId, "credited", a.credits);
      break;
    }
    case "BacBridge.ExitClaimed": {
      const exitId = Number(a.exitId);
      // v2（决策 #24）：退出锁定的是 BAC（回购来的），不是 BNB。列名 locked_wei 是 001 的历史名字，值是 BAC 的 wei。
      db.prepare(
        `UPDATE exits SET claimed_tx = ?, claimed_at = ?, locked_wei = ?, anchor_epoch = ? WHERE exit_id = ?`
      ).run(txh, Number(ts), String(a.lockedBacAmt), Number(a.anchorEpoch), exitId);
      if (fresh) bumpAgentWei(db, ev.agentId, "exited", a.credits);
      break;
    }
    case "BacBridge.EpochSettled":
      setEpoch(db, a.epoch, {
        pot: String(a.pot),
        release_bps: Number(a.releaseBps),
        settled_at: Number(ts),
      });
      break;

    // ===== ChainAnchor =====
    case "ChainAnchor.AnchorPosted": {
      const epoch = Number(a.epoch);
      setEpoch(db, epoch, {
        state: "POSTED",
        exit_root: hash(a.exitRoot),
        l2_block: Number(a.l2Block),
        l2_block_hash: hash(a.l2BlockHash),
        credited: String(a.credited),
        exit_credits: String(a.exitCredits),
        fee_burned: String(a.feeBurned),
        circulating: String(a.circulating),
        exit_count: Number(a.exitCount),
        posted_at: Number(ts),
        posted_tx: txh,
      });
      assignAnchorEpoch(db, cfg, epoch, Number(a.exitCount), hash(a.exitRoot));
      break;
    }
    case "ChainAnchor.AnchorFinalized":
      setEpoch(db, a.epoch, {
        state: "FINAL",
        finalized_at: Number(ts),
        agreeing_count: Number(a.agreeingCount),
        release_bps: Number(a.releaseBps),
      });
      break;
    case "ChainAnchor.AnchorVetoed":
      setEpoch(db, a.epoch, { state: "VETOED" });
      // 被否决的纪元里的退出必须并入下一个锚点重报（03 §1.3），所以把归属清掉。
      db.prepare("UPDATE exits SET anchor_epoch = NULL WHERE anchor_epoch = ? AND claimed_tx IS NULL").run(
        Number(a.epoch)
      );
      warn("anchor_vetoed", `纪元 ${a.epoch} 的锚点被否决`);
      break;
    case "ChainAnchor.AnchorDisputed":
      setEpoch(db, a.epoch, {
        state: "DISPUTED",
        agreeing_wt: String(a.agreeingWeight),
        disputing_wt: String(a.disputingWeight),
      });
      db.prepare("UPDATE exits SET anchor_epoch = NULL WHERE anchor_epoch = ? AND claimed_tx IS NULL").run(
        Number(a.epoch)
      );
      warn("anchor_disputed", `纪元 ${a.epoch} 的锚点有异议`);
      break;

    // ===== ValidatorStaking =====
    case "ValidatorStaking.AttestationCommitted":
      upsert(
        db,
        "attestations",
        { epoch: Number(a.epoch), validator: a.validator, committed_tx: txh },
        ["epoch", "validator"],
        ["committed_tx"]
      );
      break;
    case "ValidatorStaking.AttestationRevealed":
      upsert(
        db,
        "attestations",
        {
          epoch: Number(a.epoch),
          validator: a.validator,
          revealed_tx: txh,
          exit_root: hash(a.exitRoot),
          l2_block: Number(a.l2Block),
          l2_block_hash: hash(a.l2BlockHash),
          weight: String(a.weight),
          agreeing: a.agreeing ? 1 : 0,
        },
        ["epoch", "validator"],
        ["revealed_tx", "exit_root", "l2_block", "l2_block_hash", "weight", "agreeing"]
      );
      break;
    case "ValidatorStaking.NodeRegistered":
      db.prepare("UPDATE attestations SET node_id = ? WHERE validator = ? AND node_id IS NULL").run(
        hash(a.nodeIdHash),
        a.validator
      );
      break;
    // RewardsSettled 是按「天」结算的（参数名 day），不是按 10 分钟纪元，不能写进 epochs 表的 reward_pot。
    // 它照样进 decoded_events 与 feed。

    // ===== 层内 =====
    case "L2Bridge.CreditsMinted": {
      const layerKey = hash(a.depositId);
      const dep = db.prepare("SELECT deposit_id, bsc_block FROM deposits WHERE layer_key = ?").get(layerKey);
      if (dep) {
        const bscTs = db
          .prepare("SELECT ts FROM logs WHERE chain = 'bsc' AND tx = (SELECT bsc_tx FROM deposits WHERE deposit_id = ?) LIMIT 1")
          .get(Number(dep.deposit_id));
        const lag = bscTs ? Number(ts) - Number(bscTs.ts) : null;
        db.prepare("UPDATE deposits SET layer_block = ?, layer_tx = ?, lag_sec = ? WHERE deposit_id = ?").run(
          block,
          txh,
          lag,
          Number(dep.deposit_id)
        );
      } else {
        // 层内先看到入账、BSC 侧还没索引到：不是错误，下一轮 BSC 追上后这一行会补齐。
        warn("credit_before_lock", `层内 CreditsMinted 的 depositId ${layerKey} 在 deposits 表里还没有对应行`);
      }
      break;
    }
    case "L2Bridge.ExitBurned":
      upsert(
        db,
        "exits",
        {
          exit_id: Number(a.exitId),
          agent_id: ev.agentId ?? 0,
          to_addr: a.bscRecipient,
          credits: String(a.amount),
          born_epoch: Number(a.epoch),
          layer_tx: txh,
          layer_block: block,
        },
        ["exit_id"],
        ["agent_id", "to_addr", "credits", "born_epoch", "layer_tx", "layer_block"]
      );
      break;
    case "AgentBook.Action":
      upsert(
        db,
        "actions",
        {
          seq: Number(a.seq),
          agent_id: ev.agentId ?? 0,
          actor: a.actor,
          kind: a.kind,
          kind_hash: a.kindHash,
          subject: a.subject,
          content_hash: a.contentHash,
          summary: a.summary ?? "",
          uri: a.uri ?? "",
          block,
          tx: txh,
          epoch: Number(a.epoch),
          ts: Number(ts),
        },
        ["seq"],
        ["agent_id", "actor", "kind", "kind_hash", "subject", "content_hash", "summary", "uri", "block", "tx", "epoch", "ts"]
      );
      if (fresh) bumpAgent(db, ev.agentId, "announces", 1);
      break;
    default:
      break;
  }

  // 渲染 feed。feed.epoch 一律是 600 秒的结算纪元（与 epochs 表同一个编号）：
  //   层内按块时间算 —— AgentBook 事件自带的 epoch 是**天序号**（AgentBook.EPOCH = 86400），只进 actions.epoch；
  //   BSC 事件自带的 epoch（ChainAnchor / BacBridge / ValidatorStaking 的 600 秒纪元）照用，没有就按块时间算。
  // 锚定与否按**块高**判断，不比纪元号：层内这一块 ≤ 最新 FINAL 锚点承诺的 l2Block 才算已锚定。
  const evEpoch = chain === "layer" ? epochOf(ts) : ev.epoch !== null ? ev.epoch : epochOf(ts);
  const { kind, textZh } = renderEvent({ ...ev, agentId: ev.agentId }, { bacToken: cfg && cfg.addresses && cfg.addresses.BacToken });
  feedPush(db, {
    uniq,
    chain,
    kind,
    ts: Number(ts),
    block,
    agentId: ev.agentId,
    textZh,
    tx: txh,
    anchored: chain === "layer" ? isBlockAnchored(db, block) : 1,
    epoch: evEpoch,
  });

  // 解码结果落库，供 /api/tx/{hash} 的 decoded[] 用。
  upsert(
    db,
    "decoded_events",
    {
      uniq,
      chain,
      block,
      tx: txh,
      log_index: Number(log.logIndex),
      contract: ev.contract,
      event: ev.event,
      args: JSON.stringify(ev.args),
      agent_id: ev.agentId,
      ts: Number(ts),
    },
    ["uniq"],
    ["contract", "event", "args", "agent_id"]
  );
}

/**
 * 层内第 block 块是否已被 FINAL 锚点覆盖。锚点承诺的是 (l2Block, l2BlockHash)：块哈希链把它之前的每一块都钉死了，
 * 所以「≤ 最新 FINAL 锚点的 l2Block」就是已锚定。**不许拿纪元号比**：两边的纪元单位一旦不一致
 * （AgentBook 的天序号 vs ChainAnchor 的 600 秒纪元），第一个 FINAL 锚点就会把整条 feed 标成已锚定。
 */
export function isBlockAnchored(db, block) {
  const through = anchoredThroughBlock(db);
  return through !== null && Number(block) <= through ? 1 : 0;
}

/**
 * 锚点收录的归属判定。
 * 候选 = anchor_epoch IS NULL 且 born_epoch <= epoch 的退出，按 exit_id 升序取前 exitCount 个。
 * **必须自己把 exitRoot 重算一遍并与链上那个对上才写归属** —— 对不上就不写、打告警。
 * 「宁可停，不可错」：一个错的 anchor_epoch 会让用户拿着错的证明去 claimExit，交易 revert，积分已经没了。
 */
export function assignAnchorEpoch(db, cfg, epoch, exitCount, postedRoot) {
  const bridge = cfg && cfg.addresses && cfg.addresses.BacBridge;
  if (exitCount === 0) {
    if (hash(postedRoot) !== ZERO_ROOT) {
      warn("anchor_root_mismatch", `纪元 ${epoch}：exitCount 为 0 但 exitRoot 不是 0`);
    }
    return { assigned: 0, ok: hash(postedRoot) === ZERO_ROOT };
  }
  if (!bridge) {
    warn("bridge_address_unset", "没有配置 BAC_ADDR_BRIDGE，无法重算 exitRoot，锚点归属未写入");
    return { assigned: 0, ok: false };
  }
  const rows = db
    .prepare(
      "SELECT exit_id, agent_id, to_addr, credits FROM exits WHERE anchor_epoch IS NULL AND born_epoch <= ? ORDER BY exit_id ASC LIMIT ?"
    )
    .all(Number(epoch), Number(exitCount));
  if (rows.length !== Number(exitCount)) {
    warn(
      "anchor_leaves_missing",
      `纪元 ${epoch}：链上说有 ${exitCount} 笔退出，本地只有 ${rows.length} 笔候选，归属未写入`
    );
    return { assigned: 0, ok: false };
  }
  const leaves = rows.map((r) => ({
    exitId: BigInt(r.exit_id),
    agentId: BigInt(r.agent_id),
    to: r.to_addr,
    credits: BigInt(r.credits),
  }));
  const local = exitRoot(leaves, cfg.layerChainId, bridge);
  if (local.toLowerCase() !== hash(postedRoot)) {
    warn(
      "anchor_root_mismatch",
      `纪元 ${epoch}：本地重算的 exitRoot ${local} 与链上 ${hash(postedRoot)} 不一致，归属未写入`
    );
    return { assigned: 0, ok: false, local };
  }
  const st = db.prepare("UPDATE exits SET anchor_epoch = ? WHERE exit_id = ?");
  for (const r of rows) st.run(Number(epoch), Number(r.exit_id));
  return { assigned: rows.length, ok: true, local };
}

/**
 * 摄入一批日志（同一条链）。返回处理了多少条。
 * getTs(blockNumber) 必须返回该块的时间戳。
 */
export function ingestLogs(db, { chain, logs, cfg, addressBook, tsOf }) {
  let n = 0;
  withTx(db, () => {
    for (const log of logs) {
      const ts = tsOf(Number(log.blockNumber));
      const { uniq, fresh } = recordLog(db, { chain, log, ts });
      const ev = decodeLog(log, { chain, addressBook });
      if (!ev) continue;
      applyEvent({ db, chain, cfg, ts, log, uniq, fresh }, ev);
      n += 1;
    }
  });
  return n;
}

/**
 * 层内区块 + 交易 + 收据落库（03 §4.3 的两类派生条目也在这里产生）。
 * block: eth_getBlockByNumber(n, true) 的返回；receipts: 与 block.transactions 同序的收据数组。
 */
export function ingestLayerBlock(db, { block, receipts, cfg }) {
  const number = Number(block.number);
  const ts = Number(block.timestamp);
  const baseFee = (block.baseFeePerGas ?? 0n).toString();
  withTx(db, () => {
    upsert(
      db,
      "blocks",
      {
        number,
        hash: hash(block.hash),
        parent_hash: hash(block.parentHash),
        ts,
        tx_count: block.transactions.length,
        gas_used: Number(block.gasUsed),
        gas_limit: Number(block.gasLimit),
        base_fee: baseFee,
        epoch: epochOf(ts),
      },
      ["number"],
      ["hash", "parent_hash", "ts", "tx_count", "gas_used", "gas_limit", "base_fee", "epoch"]
    );

    block.transactions.forEach((t, i) => {
      const r = receipts[i] || {};
      const from = addr(t.from);
      const agentId = agentIdOfWallet(db, from);
      const gasUsed = Number(r.gasUsed ?? 0);
      const effPrice = (r.effectiveGasPrice ?? t.gasPrice ?? 0n).toString();
      const created = r.contractAddress ? addr(r.contractAddress) : null;
      const txh = hash(t.hash);
      const already = db.prepare("SELECT 1 FROM txs WHERE hash = ?").get(txh);
      upsert(
        db,
        "txs",
        {
          hash: txh,
          block: number,
          idx: Number(t.transactionIndex ?? i),
          from_addr: from,
          to_addr: t.to ? addr(t.to) : null,
          value: (t.value ?? 0n).toString(),
          gas_used: gasUsed,
          eff_gas_price: effPrice,
          fee_burned: (BigInt(gasUsed) * BigInt(baseFee)).toString(),
          created,
          status: Number(r.status ?? 1),
          agent_id: agentId,
          ts,
        },
        ["hash"],
        ["block", "idx", "from_addr", "to_addr", "value", "gas_used", "eff_gas_price", "fee_burned", "created", "status", "agent_id", "ts"]
      );

      if (agentId !== null) {
        db.prepare("UPDATE agents SET last_layer_tx = ? WHERE agent_id = ? AND (last_layer_tx IS NULL OR last_layer_tx < ?)").run(
          number,
          agentId,
          number
        );
      }

      // §4.3 第一类：收据里 contractAddress 不为空 -> DEPLOY
      if (created) {
        const codeSize = Number(r.codeSize ?? 0);
        upsert(
          db,
          "contracts",
          {
            address: created,
            deployer: from,
            agent_id: agentId,
            tx: txh,
            block: number,
            ts,
            code_size: codeSize,
          },
          ["address"],
          ["deployer", "agent_id", "tx", "block", "ts", "code_size"]
        );
        if (!already) bumpAgent(db, agentId, "deploys", 1);
        feedPush(db, {
          uniq: `layer:${txh}:deploy`,
          chain: "layer",
          kind: "DEPLOY",
          ts,
          block: number,
          agentId,
          textZh: renderDeploy({ agentId, address: created, codeSize }),
          tx: txh,
          anchored: isBlockAnchored(db, number),
          epoch: epochOf(ts),
        });
      }

      // §4.3 第二类：to 指向 contracts 表里的地址 -> CALL
      if (t.to) {
        const to = addr(t.to);
        const c = db.prepare("SELECT agent_id FROM contracts WHERE address = ?").get(to);
        if (c) {
          if (!already) {
            db.prepare("UPDATE contracts SET call_count = call_count + 1, last_call = ? WHERE address = ?").run(
              number,
              to
            );
          }
          feedPush(db, {
            uniq: `layer:${txh}:call`,
            chain: "layer",
            kind: "CALL",
            ts,
            block: number,
            agentId,
            textZh: renderCall({ agentId, address: to, deployerId: c.agent_id }),
            tx: txh,
            anchored: isBlockAnchored(db, number),
            epoch: epochOf(ts),
          });
        }
      }
    });
  });
  return { number, txCount: block.transactions.length };
}

/**
 * 由层内地址反查 agentId。来源是 BacBridge.Locked 的 layerWallet（agent_wallets 表）。
 * ERC-8004 下一个地址可以以多个身份进桥：这里取**最早**进桥的那个身份（depositId 最小），
 * 与层内 L2Gate「一个地址一个 agent」的现状一致（L2Gate 的重新设计见合约头注释，尚未定稿）。
 */
export function agentIdOfWallet(db, wallet) {
  const a = addr(wallet);
  const w = db
    .prepare("SELECT agent_id FROM agent_wallets WHERE wallet = ? ORDER BY first_deposit_id ASC LIMIT 1")
    .get(a);
  if (w) return Number(w.agent_id);
  const row = db.prepare("SELECT agent_id FROM agents WHERE wallet = ? ORDER BY agent_id ASC LIMIT 1").get(a);
  return row ? Number(row.agent_id) : null;
}

/**
 * 锚点定案之后，把层内块高 ≤ throughBlock（最新 FINAL 锚点的 l2Block）的 feed 条目翻成 anchored = 1。
 * 按块高、不按纪元号（见 isBlockAnchored）。
 */
export function markAnchored(db, throughBlock) {
  if (throughBlock === null || throughBlock === undefined) return 0;
  const info = db
    .prepare("UPDATE feed SET anchored = 1 WHERE chain = 'layer' AND anchored = 0 AND block <= ?")
    .run(Number(throughBlock));
  return Number(info.changes ?? 0);
}

/** 最新 FINAL 锚点承诺到的层内块高；还没有任何 FINAL 锚点时是 null。 */
export function anchoredThroughBlock(db) {
  const row = db.prepare("SELECT MAX(l2_block) AS b FROM epochs WHERE state = 'FINAL' AND l2_block IS NOT NULL").get();
  return row && row.b != null ? Number(row.b) : null;
}

/** 已锚定到哪个纪元（/api/feed 的 anchoredThrough）。 */
export function anchoredThrough(db) {
  const row = db.prepare("SELECT MAX(epoch) AS e FROM epochs WHERE state = 'FINAL'").get();
  return row && row.e != null ? Number(row.e) : 0;
}
