// 看门狗的状态机。把「读链 → 跑规则 → 复核 → 跳闸」串起来，**本身不发任何网络请求**：
// 它只调 chains.mjs 给的适配器，所以整台机器能用假适配器离线跑完（test/*.test.mjs）。
//
// ─── 一条发现的一生 ────────────────────────────────────────────────────────
//   规则返回 CRITICAL
//     → 落 SQLite，state = pending_confirm（**先落盘再做别的**，这样在这一步被 kill
//       也不会丢掉「我已经看到过」这件事）
//     → 复核：用**第二个 RPC 端点**把同一件事重读一遍、重算一遍
//         · 复核不成立 → state = cleared，只留一行日志，不打扰任何人
//         · 复核成立   → state = pending_trip，落盘
//     → 跳闸：（可选 veto →）pause() → 落 trips 表 → webhook → state = tripped
//   进程在任何一步被 kill，重启时 `resume()` 会从 SQLite 里把没走完的发现捡起来接着走。
//
// ─── 误报与漏报之间往哪边倒 ─────────────────────────────────────────────────
// 往「宁可暂停」倒，但只对**能算清楚**的规则这么做。理由是两边的代价并不对称，而且
// 和直觉相反：
//   · 一次误暂停**是可以立刻撤销的** —— `unpause()` 就在同一把钥匙上，`pausedCumulative`
//     只累计真正暂停过的秒数。所以误报的代价是「几分钟 collect 停摆 + 从 21 天额度里
//     扣掉这几分钟」，不是七天。
//   · 一次漏报是不可逆的：120 秒之后锚点 FINAL，小偷的 `claimExit` 当场把整个未占用的
//     资产桶锁成自己的债权，`pause()` 再也撤不回来（只有 `revokeEpochOwed` 能，而那要人来按）。
// 所以：**算得清的规则（锚点根、对账负方向、两个桶、释放率上限）跳闸；
// 算不清的规则（活性、行情、信息字段、需要归档节点而读不到的项）只告警。**
// 这条取舍在 README 和 chain/OPERATIONS.md 里都写了同一份。

import {
  EPOCH,
  EPOCHS_PER_DAY,
  FINDING_STATE,
  RELEASE_DAILY_BPS,
  RULE,
  SEVERITY,
} from './constants.mjs';
import {
  addCarry,
  carryBefore,
  clearCarryBefore,
  getCursor,
  getLedger,
  recordRelease,
  recordTrip,
  releasedSince,
  pruneReleases,
  setCursor,
  setFindingState,
  setLedger,
  unfinishedFindings,
  upsertFinding,
} from './db.mjs';
import { depositKey as depositKeyOf, exitRootOf } from './ids.mjs';
import { l2BlockFor } from './layerMath.mjs';
import { log } from './log.mjs';
import { notify } from './notify.mjs';
import { checkAnchorRoot } from './rules/anchorRoot.mjs';
import { checkBuckets } from './rules/buckets.mjs';
import { checkBuyback } from './rules/buyback.mjs';
import { checkCadence } from './rules/cadence.mjs';
import { checkReconcile } from './rules/reconcile.mjs';
import { checkEpochRelease, checkRollingRelease } from './rules/releaseCap.mjs';
import { plain } from './verdict.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {object} deps.db
 * @param {object} deps.bsc   primary BSC 适配器（唯一有签名能力的那个）
 * @param {object} deps.bsc2  secondary BSC 适配器（只读，复核用）
 * @param {object} deps.layer primary 层内适配器
 * @param {object} deps.layer2 secondary 层内适配器（没有第二台节点时与 primary 相同）
 * @param {() => number} [deps.now] 秒级时间戳，测试可注入
 * @param {Function} [deps.notifyFn] 测试可注入
 * @param {Function} [deps.sleepFn] 测试可注入
 */
export function makeEngine(deps) {
  const { cfg, db, bsc, bsc2, layer, layer2 } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const notifyFn = deps.notifyFn ?? notify;
  const sleepFn = deps.sleepFn ?? sleep;

  /** 跳闸之后进程不再继续巡检：它已经对这座桥下过结论了 */
  let tripped = false;
  /** 每条规则的最近一次裁决，给 /status 与日志用 */
  const last = {};
  /**
   * WARN 的去重表。告警要在半夜被人看见，所以它不能每 30 秒重复一次同一句话 ——
   * 被淹掉的告警等于没有告警。同一 (rule, subject, summary) 在冷却期内只外发一次。
   */
  const warnedAt = new Map();
  const WARN_COOLDOWN_SEC = 3600;

  // ================================================================ 工具

  function record(v) {
    last[v.rule] = { at: now(), severity: v.severity, subject: v.subject, summary: v.summary };
    const line = { rule: v.rule, subject: v.subject, summary: v.summary, compared: v.compared };
    if (v.severity === SEVERITY.CRITICAL) log.alert('规则判定为严重', line);
    else if (v.severity === SEVERITY.WARN) log.warn('规则告警', line);
    else if (v.severity === SEVERITY.SKIP) log.info('规则跳过', line);
    else log.debug('规则通过', line);
    return v;
  }

  /**
   * 处理一条裁决。CRITICAL 才会进入「复核 → 跳闸」；其余只记录。
   * @param {object} v 裁决
   * @param {() => Promise<object>} reconfirm 复核函数：必须走**另一个**数据源重算一遍
   */
  async function handle(v, reconfirm) {
    record(v);
    if (v.severity !== SEVERITY.CRITICAL) {
      if (v.severity === SEVERITY.WARN) {
        const key = `${v.rule}|${v.subject}|${v.summary}`;
        const at = warnedAt.get(key) ?? 0;
        if (now() - at >= WARN_COOLDOWN_SEC) {
          warnedAt.set(key, now());
          await notifyFn(cfg.notify, { ...v, action: 'none', at: now() });
        }
      }
      return v;
    }
    const f = upsertFinding(
      db,
      { rule: v.rule, subject: v.subject, severity: v.severity, state: FINDING_STATE.PENDING_CONFIRM, detail: { first: plain(v.compared), summary: v.summary } },
      now(),
    );
    log.alert('已开单，进入复核', { findingId: f.id, rule: v.rule, subject: v.subject });

    await sleepFn(cfg.poll.confirmDelayMs);
    let second;
    try {
      second = await reconfirm();
    } catch (e) {
      // 复核本身失败（第二个 RPC 挂了）不等于问题消失，也不等于问题坐实。
      // 保持 pending_confirm，下一轮继续 —— 但把它喊出来，因为这时候看门狗是瘸的。
      log.error('复核读失败，发现保持在 pending_confirm', { findingId: f.id, rule: v.rule, err: e });
      await notifyFn(cfg.notify, { ...v, action: 'confirm_failed', at: now() });
      return v;
    }
    record(second);
    if (second.severity !== SEVERITY.CRITICAL) {
      setFindingState(db, f.id, FINDING_STATE.CLEARED, now(), { first: plain(v.compared), second: plain(second.compared), verdict: '复核不成立，未暂停' });
      log.warn('复核不成立，撤单（未暂停）', { findingId: f.id, rule: v.rule, subject: v.subject, secondSummary: second.summary });
      return second;
    }
    setFindingState(db, f.id, FINDING_STATE.PENDING_TRIP, now(), { first: plain(v.compared), second: plain(second.compared), summary: second.summary, rule: v.rule, subject: v.subject });
    return await trip({ ...f, state: FINDING_STATE.PENDING_TRIP, detail: { first: plain(v.compared), second: plain(second.compared), summary: second.summary } }, second.summary);
  }

  /**
   * 跳闸。顺序是刻意的：**先刹车，再喊人。**
   * webhook 打不通、DNS 挂了、对面 500，都不许挡住 `pause()`。
   */
  async function trip(finding, summary) {
    tripped = true;
    const subject = finding.subject;
    const why = summary ?? finding.detail?.summary ?? '（无摘要）';

    // ① 零损失路径：只有当运维按模拟报告 §3.3 B6 把 vetoKey 交给本进程、
    //    且这个锚点还在 120 秒等待期内时才存在。合约默认不给看门狗这个权。
    let vetoTx = null;
    if (finding.rule === RULE.ANCHOR_ROOT && cfg.keys.veto) {
      try {
        const epoch = Number(subject);
        const a = await bsc.getAnchor(epoch);
        const remaining = a.postedAt + 120 - now();
        if (a.state === 'POSTED' && remaining > 0) {
          const reason = '0x' + '0'.repeat(63) + '1'; // 占位 reasonHash，链上只做记录
          const r = await bsc.sendVeto(epoch, reason);
          vetoTx = r ? r.hash : null;
          log.alert('已提交 veto（零损失路径）', { epoch, txHash: vetoTx, remainingSec: remaining });
        } else {
          log.alert('veto 窗口已过或锚点不在 POSTED 状态，只能 pause', { epoch, state: a.state, remainingSec: remaining });
        }
      } catch (e) {
        log.error('veto 失败，继续走 pause', { err: e });
      }
    }

    // ② 刹车
    let txHash = null;
    let okTx = false;
    let note = null;
    if (!cfg.armed) {
      note = 'WATCHDOG_ARMED=false：演练模式，没有发出任何交易';
      log.alert('演练模式：本该在此处调用 BacBridge.pause()', { rule: finding.rule, subject, why });
    } else {
      try {
        const r = await bsc.sendPause();
        txHash = r.hash;
        log.alert('已提交 BacBridge.pause()', { rule: finding.rule, subject, txHash });
        try {
          const rc = await r.wait(60000);
          okTx = Boolean(rc && (rc.status === 1 || rc.status === undefined));
        } catch (e) {
          note = `pause 交易已发出但未在 60 秒内确认：${e && e.message ? e.message : e}`;
          log.error('pause 交易等待确认超时', { txHash, err: e });
        }
      } catch (e) {
        note = `pause 调用失败：${e && e.message ? e.message : e}`;
        log.alert('pause 调用失败 —— 桥没有被刹住，必须立刻人工介入', { rule: finding.rule, subject, err: e });
      }
    }

    recordTrip(db, { findingId: finding.id, rule: finding.rule, txHash, ok: okTx, note: note ?? (vetoTx ? `veto=${vetoTx}` : null) }, now());
    setFindingState(db, finding.id, FINDING_STATE.TRIPPED, now(), { ...finding.detail, txHash, vetoTx, armed: cfg.armed, note });

    // ③ 喊人
    await notifyFn(cfg.notify, {
      rule: finding.rule,
      subject,
      severity: SEVERITY.CRITICAL,
      summary: why,
      compared: finding.detail ?? {},
      action: txHash ? 'paused' : cfg.armed ? 'pause_failed' : 'dry_run',
      txHash,
      at: now(),
    });
    return { tripped: true, txHash, vetoTx, rule: finding.rule, subject };
  }

  // ==================================================== 快规则：锚点根

  /**
   * `l2Block(epoch)` 的记忆化。二分查找一次要 log2(层内高度) 次 `getBlock`，在 3 秒一块的
   * 链上一天就是 28,800 块 ≈ 15 次往返；而每评估一个纪元要查两次（epoch 与 epoch-1），
   * 复核再翻一倍。**已经结束的纪元的 l2Block 是不会变的**（QBFT 即时最终性，层内不重组），
   * 所以缓存它是安全的，而且直接把关键路径上的往返次数砍掉一半以上。
   * 只缓存已经结束的纪元：当前纪元还在长块，缓存它会算错。
   */
  const blockCache = new Map();
  async function l2BlockCached(L, epoch) {
    const key = `${L.which ?? 'p'}:${epoch}`;
    if (blockCache.has(key)) return blockCache.get(key);
    const b = await l2BlockFor(L, epoch);
    if ((epoch + 1) * EPOCH <= now()) {
      if (blockCache.size > 4096) blockCache.clear();
      blockCache.set(key, b);
    }
    return b;
  }

  /** `(l2Block(epoch-1), l2Block(epoch)]`，走缓存 */
  async function rangeCached(L, epoch) {
    const cur = await l2BlockCached(L, epoch);
    if (!cur) return null;
    const prev = await l2BlockCached(L, epoch - 1);
    const from = prev ? prev.number + 1 : 0;
    return { from, to: cur.number, current: cur, previous: prev, empty: from > cur.number };
  }

  /**
   * 从层内日志独立复算一个纪元应有的锚点内容。
   * @param {object} L 层内适配器（复核时传 secondary）
   */
  async function deriveAnchor(L, epoch) {
    const range = await rangeCached(L, epoch);
    if (!range) return null;

    const carried = carryBefore(db, epoch);
    let leaves = [];
    let credited = 0n;
    let exitCredits = 0n;

    if (!range.empty) {
      const exits = await L.exitLogs(range.from, range.to);
      const mints = await L.creditLogs(range.from, range.to);
      leaves = exits.map((e) => ({ exitId: e.exitId, agentId: e.agentId, to: e.to, credits: e.credits }));
      credited += mints.reduce((a, m) => a + m.amount, 0n);
      exitCredits += exits.reduce((a, e) => a + e.credits, 0n);
    }

    // 被否决 / 异议的纪元的叶子会原样并进来（03 §1.3）。不算这一段，
    // 每一次 veto 之后的第一个锚点都会被误判成伪造。
    for (const c of carried) {
      const rc = await rangeCached(L, c);
      if (!rc || rc.empty) continue;
      const ex = await L.exitLogs(rc.from, rc.to);
      const mi = await L.creditLogs(rc.from, rc.to);
      for (const e of ex) leaves.push({ exitId: e.exitId, agentId: e.agentId, to: e.to, credits: e.credits });
      credited += mi.reduce((a, m) => a + m.amount, 0n);
      exitCredits += ex.reduce((a, e) => a + e.credits, 0n);
    }

    const { root, leaves: sorted } = exitRootOf(leaves, cfg.addresses.bacBridge);
    return {
      root,
      exitCount: sorted.length,
      exitCredits,
      credited,
      l2Block: range.current.number,
      l2BlockHash: range.current.hash,
      empty: range.empty,
      range: { from: range.from, to: range.to, empty: range.empty },
      leafIds: sorted.slice(0, 32).map((l) => String(l.exitId)),
      carried,
    };
  }

  /**
   * 评估一个纪元的锚点。`secondary = true` 时**两边都换成另一个数据源**：
   * 锚点从第二个 BSC RPC 读（顺带排除掉 BSC 重组造成的幻影），
   * 层内从第二个层节点读（只有一台节点时会降级，日志里会写明）。
   */
  async function evaluateAnchor(epoch, secondary = false) {
    const B = secondary ? bsc2 : bsc;
    const L = secondary ? layer2 : layer;
    const onchain = await B.getAnchor(epoch);
    if (onchain.state === 'NONE') {
      return record({
        rule: RULE.ANCHOR_ROOT,
        subject: String(epoch),
        severity: SEVERITY.SKIP,
        summary: `纪元 ${epoch} 在${secondary ? '第二个' : ''} RPC 上不存在（多半是 BSC 重组掉了这笔 postAnchor）`,
        compared: { epoch, source: B.url, state: onchain.state },
      });
    }
    const mine = await deriveAnchor(L, epoch);
    if (!mine) {
      return record({
        rule: RULE.ANCHOR_ROOT,
        subject: String(epoch),
        severity: SEVERITY.SKIP,
        summary: `层内在纪元 ${epoch} 结束时还不存在，无法复算`,
        compared: { epoch },
      });
    }
    // 两个信息字段要读历史余额（Besu 的 bonsai 只留 512 个块 ≈ 25.6 分钟）。
    // 读不到给 null，规则里会直接跳过它们 —— 它们本来就不跳闸。
    let feeBurnedMine = null;
    let circulatingMine = null;
    try {
      const tip = mine.l2Block;
      const base = Math.max(0, (mine.range.from ?? 1) - 1);
      const [sinkNow, sinkPrev, signerNow, signerPrev] = await Promise.all([
        L.balance(cfg.addresses.feeSink, tip),
        L.balance(cfg.addresses.feeSink, base),
        L.balance(cfg.addresses.layerSigner, tip),
        L.balance(cfg.addresses.layerSigner, base),
      ]);
      const d = BigInt(sinkNow) - BigInt(sinkPrev) + (BigInt(signerNow) - BigInt(signerPrev));
      feeBurnedMine = d < 0n ? 0n : d;
    } catch {
      feeBurnedMine = null; // 历史状态窗口已过，正常现象
    }
    return checkAnchorRoot({ epoch, onchain, mine, carriedEpochs: mine.carried, feeBurnedMine, circulatingMine });
  }

  /** 快巡检：只做锚点根这一条，因为只有它有 120 秒的窗口 */
  async function tickFast() {
    if (tripped) return { skipped: 'tripped' };
    const head = await bsc.getBlockNumber();
    let cursor = getCursor(db, 'bsc_anchor');
    if (cursor === null) {
      cursor = cfg.start.bscBlock !== null ? cfg.start.bscBlock - 1 : head - 1;
      setCursor(db, 'bsc_anchor', cursor, now());
    }
    const from = cursor + 1;
    if (from > head) return { from, to: head, events: 0 };

    const events = await bsc.anchorEvents(from, head);
    const posted = [];
    // **按链上顺序逐条处理，不能先把事件分完类再统一评估。**
    // 一段区块里可能同时有 Posted(E)、Finalized(E)、Posted(E+1)：`Finalized(E)` 会清空
    // E 之前的重报集，所以 Posted(E) 必须在它之前被评估完，否则该纪元合法重报进来的叶子
    // 已经被清掉了，一个诚实的锚点会被判成伪造。
    for (const e of events) {
      const epoch = Number(e.args.epoch);
      if (e.name === 'AnchorVetoed') addCarry(db, epoch, 'VETOED', now());
      else if (e.name === 'AnchorDisputed') addCarry(db, epoch, 'DISPUTED', now());
      else if (e.name === 'AnchorFinalized') clearCarryBefore(db, epoch);
      else if (e.name === 'AnchorPosted') {
        posted.push(epoch);
        const v = await evaluateAnchor(epoch, false);
        const out = await handle(v, () => evaluateAnchor(epoch, true));
        if (tripped) return { from, to: head, events: events.length, tripped: true, at: out };
      }
    }
    // **游标最后才推进。** 中继那边的纪律是「先落盘再推游标」，这里是同一条纪律的另一面：
    // 崩在中间就重扫同一段，规则是幂等的（同一 rule+subject 只有一行发现），重扫的代价
    // 是重启后多一次 getLogs；反过来先推游标，崩一次就**永久漏掉**那个纪元的锚点 ——
    // 而那正是这个进程存在的唯一理由。
    setCursor(db, 'bsc_anchor', head, now());
    return { from, to: head, events: events.length, posted };
  }

  // ================================================ 慢规则：桶 / 回购 / 释放 / 对账

  function snapshotFromLedger() {
    const block = Number(getLedger(db, 'snap_block', -1n));
    if (block < 0) return null;
    return {
      block,
      lockedBac: getLedger(db, 'snap_lockedBac'),
      totalBurned: getLedger(db, 'snap_totalBurned'),
      buybackBac: getLedger(db, 'snap_buybackBac'),
      owedTotal: getLedger(db, 'snap_owedTotal'),
      reservedTotal: getLedger(db, 'snap_reservedTotal'),
    };
  }

  function saveSnapshot(s) {
    const t = now();
    setLedger(db, 'snap_block', BigInt(s.block), t);
    setLedger(db, 'snap_lockedBac', s.lockedBac, t);
    setLedger(db, 'snap_totalBurned', s.totalBurned, t);
    setLedger(db, 'snap_buybackBac', s.buybackBac, t);
    setLedger(db, 'snap_owedTotal', s.owedTotal, t);
    setLedger(db, 'snap_reservedTotal', s.reservedTotal, t);
  }

  /**
   * 把一段区块里的事件按顺序重放一遍，得到每一笔 `EpochSettled` **发生之前**的
   * `buybackBac / reservedTotal / owedTotal`。这就是释放率上限的基数，
   * 而且完全不需要归档节点。
   *
   * 出现 `EpochOwedRevoked` / `Halted` 时账本判定为脏：这两条路径对 `reservedTotal`
   * 的影响是逐地址算出来的，链下没法精确重放。脏了就不给 `before`，规则会返回 SKIP，
   * 下一轮从链上快照重新起算。**宁可少判一次，也不拿一个自己都不确定的基数去冻结桥。**
   */
  function replayForSettles(prev, events) {
    if (!prev) return { befores: new Map(), dirty: true };
    const state = { buybackBac: prev.buybackBac, reservedTotal: prev.reservedTotal, owedTotal: prev.owedTotal };
    const befores = new Map();
    let dirty = false;
    const stream = [];
    for (const b of events.boughtBack) stream.push({ k: 'bought', at: [b.blockNumber, b.logIndex], v: b });
    for (const s of events.settled) stream.push({ k: 'settled', at: [s.blockNumber, s.logIndex], v: s });
    for (const x of events.exits) stream.push({ k: 'exit', at: [x.blockNumber, x.logIndex], v: x });
    stream.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
    if (events.dirty) dirty = true;
    for (const item of stream) {
      if (item.k === 'bought') state.buybackBac += item.v.bacBought;
      else if (item.k === 'exit') state.owedTotal += item.v.lockedBacAmt;
      else if (item.k === 'settled') {
        befores.set(item.v.epoch, { buybackBac: state.buybackBac, reservedTotal: state.reservedTotal, owedTotal: state.owedTotal });
        state.reservedTotal += item.v.pot;
      }
    }
    return { befores, dirty };
  }

  /** 慢巡检：桶、回购、释放率、对账、活性 */
  async function tickSlow() {
    if (tripped) return { skipped: 'tripped' };
    const head = await bsc.getBlockNumber();
    const to = head - cfg.poll.slowDepth;
    if (to <= 0) return { skipped: 'head_too_low' };

    let cursor = getCursor(db, 'bsc_bridge');
    if (cursor === null) {
      cursor = cfg.start.bscBlock !== null ? cfg.start.bscBlock - 1 : to - 1;
      setCursor(db, 'bsc_bridge', cursor, now());
    }
    const from = cursor + 1;
    if (from > to) return { from, to, skipped: 'no_new_blocks' };

    const state = await bsc.bridgeState(to);
    const events = await bsc.bridgeEvents(from, to);
    const prev = snapshotFromLedger();
    const usablePrev = prev && prev.block === from - 1 ? prev : null;

    // ---- 两个桶
    const vBuckets = checkBuckets({
      now: { block: to, lockedBac: state.lockedBac, totalBurned: state.totalBurned, buybackBac: state.buybackBac, owedTotal: state.owedTotal, reservedTotal: state.reservedTotal, tokenBalance: state.tokenBalance },
      prev: usablePrev,
      flows: events.flows,
    });
    await handle(vBuckets, async () => {
      const s2 = await bsc2.bridgeState(to);
      const e2 = await bsc2.bridgeEvents(from, to);
      return checkBuckets({
        now: { block: to, lockedBac: s2.lockedBac, totalBurned: s2.totalBurned, buybackBac: s2.buybackBac, owedTotal: s2.owedTotal, reservedTotal: s2.reservedTotal, tokenBalance: s2.tokenBalance },
        prev: usablePrev,
        flows: e2.flows,
      });
    });
    if (tripped) return { from, to, tripped: true };

    // ---- 释放率（逐纪元 + 滚动 24 小时）
    const dirtyEvents = { ...events, dirty: events.flows.haltPaid > 0n || events.flows.escapeBac > 0n };
    const { befores, dirty } = replayForSettles(usablePrev, dirtyEvents);
    for (const s of events.settled) {
      recordRelease(db, s.epoch, s.pot, s.releaseBps, now());
      const before = dirty ? null : (befores.get(s.epoch) ?? null);
      const v = checkEpochRelease({ event: s, before, toleranceBps: cfg.tolerance.releaseBps });
      await handle(v, async () => checkEpochRelease({ event: await refetchSettle(s), before, toleranceBps: cfg.tolerance.releaseBps }));
      if (tripped) return { from, to, tripped: true };
    }

    const win = cfg.poll.rollingWindowSec;
    pruneReleases(db, now() - win * 2);
    const released = releasedSince(db, now() - win);
    const rollBase = bigMax(getLedger(db, 'roll_base'), state.buybackBac);
    const rollAt = Number(getLedger(db, 'roll_base_at', 0n));
    if (rollAt === 0 || now() - rollAt > win) {
      setLedger(db, 'roll_base', state.buybackBac, now());
      setLedger(db, 'roll_base_at', BigInt(now()), now());
    } else {
      setLedger(db, 'roll_base', rollBase, now());
    }
    const vRoll = checkRollingRelease({
      windowSec: win,
      released,
      baseMax: rollBase,
      maxDailyBps: RELEASE_DAILY_BPS.QUORUM,
      toleranceBps: cfg.tolerance.releaseBps,
      samples: events.settled.length,
    });
    await handle(vRoll, async () => vRoll); // 数据源是本地 SQLite，复核就是再算一遍同一份记录
    if (tripped) return { from, to, tripped: true };

    // ---- 回购
    for (const b of events.boughtBack) {
      const ref = await bsc.referencePrice(b.blockNumber - 1, b.bnbSpent);
      const history = events.boughtBack.filter((x) => x.blockNumber < b.blockNumber);
      const v = checkBuyback({ event: b, reference: ref, toleranceBps: cfg.tolerance.slippageBps, history });
      await handle(v, async () => {
        const ref2 = await bsc2.referencePrice(b.blockNumber - 1, b.bnbSpent);
        return checkBuyback({ event: b, reference: ref2, toleranceBps: cfg.tolerance.slippageBps, history });
      });
      if (tripped) return { from, to, tripped: true };
    }

    // ---- 对账（自己再钉一次块：两条链的读数偏斜要显式算出来，不能借用上面的快照）
    const vRec = await evaluateReconcile(false);
    await handle(vRec, () => evaluateReconcile(true));
    if (tripped) return { from, to, tripped: true };

    // ---- 活性（永不跳闸）
    const vCad = checkCadence({ nowTs: now(), lastPostedEpoch: await bsc.lastPostedEpoch(), warnAfterEpochs: 3 });
    await handle(vCad, async () => vCad);

    saveSnapshot({ block: to, lockedBac: state.lockedBac, totalBurned: state.totalBurned, buybackBac: state.buybackBac, owedTotal: state.owedTotal, reservedTotal: state.reservedTotal });
    setCursor(db, 'bsc_bridge', to, now());
    return { from, to, settled: events.settled.length, boughtBack: events.boughtBack.length };
  }

  async function refetchSettle(s) {
    const e2 = await bsc2.bridgeEvents(s.blockNumber, s.blockNumber);
    return e2.settled.find((x) => x.epoch === s.epoch) ?? s;
  }

  /** 对账：BSC 的两个计数器钉在一个块上，层内的四个余额钉在另一个块上，偏斜显式扣掉 */
  async function evaluateReconcile(secondary) {
    const B = secondary ? bsc2 : bsc;
    const L = secondary ? layer2 : layer;
    const bscBlock = (await B.getBlockNumber()) - cfg.poll.slowDepth;
    const st = await B.bridgeState(bscBlock);
    const layerBlock = await L.getBlockNumber();

    const [bridgeBalance, feeSinkBalance, signerBalance, feeSplitterBalance] = await Promise.all([
      L.balance(cfg.addresses.l2Bridge, layerBlock),
      L.balance(cfg.addresses.feeSink, layerBlock),
      L.balance(cfg.addresses.layerSigner, layerBlock),
      L.balance(cfg.addresses.feeSplitter, layerBlock),
    ]);
    const validatorBalances = [];
    for (const v of cfg.validators) validatorBalances.push({ addr: v, balance: await L.balance(v, layerBlock) });

    // 在途存款：最近 inflightBlocks 个 BSC 块里 lock 了、层内还没 credit 的那些
    const lockFrom = Math.max(0, bscBlock - cfg.tolerance.inflightBlocks);
    const locked = await B.lockedIn(lockFrom, bscBlock);
    let inflightCredits = 0n;
    for (const l of locked) {
      // 层内的幂等键，不是事件里那个自增 depositId（03 §1.2）
      const key = depositKeyOf(cfg.addresses.bacBridge, l.txHash, l.logIndex);
      let seen = true;
      try {
        seen = await L.seen(key);
      } catch {
        seen = false; // 读不到就按「还没到」算：这只会把容差放宽，不会放宽跳闸方向
      }
      if (!seen) inflightCredits += l.credits;
    }

    // 在途退出：层内已经烧了、BSC 还没领的。用两条链的累计计数器之差算，
    // 它天然就是这个数，不用再扫一遍日志。
    let inflightExits = 0n;
    try {
      const layerExited = await layerTotalExited(L);
      const d = layerExited - st.totalCreditsExited;
      inflightExits = d > 0n ? d : 0n;
    } catch {
      inflightExits = 0n;
    }

    const skewExits = await B.exitClaimedIn(Math.max(0, bscBlock - 20), bscBlock);

    return checkReconcile({
      bscTotalIssued: st.totalCreditsIssued,
      bscTotalExited: st.totalCreditsExited,
      bridgeBalance,
      feeSinkBalance,
      signerBalance,
      feeSplitterBalance,
      validatorBalances,
      inflightCredits,
      inflightExits,
      skewExits,
      toleranceWei: cfg.tolerance.reconcileWei,
      at: { bscBlock, layerBlock, source: B.url },
    });
  }

  async function layerTotalExited(L) {
    if (typeof L.totalExited === 'function') return await L.totalExited();
    return 0n;
  }

  // ======================================================== 重启续传

  /**
   * 启动时把上次没走完的发现捡起来。这是「重启不丢探测进度」那条要求的落点：
   *   pending_trip   —— 已经复核成立，只差交易没发出去 → **直接跳闸**，不重新探测
   *   pending_confirm —— 还没复核完 → 重跑一遍规则，走正常的复核流程
   */
  async function resume() {
    const items = unfinishedFindings(db);
    if (items.length === 0) return { resumed: 0 };
    log.alert('发现未走完的告警，重启后继续处理', { count: items.length, items: items.map((i) => ({ id: i.id, rule: i.rule, subject: i.subject, state: i.state })) });
    let acted = 0;
    for (const f of items) {
      if (f.state === FINDING_STATE.PENDING_TRIP) {
        await trip(f, f.detail?.summary ?? `${f.rule} / ${f.subject}（重启前已复核成立）`);
        acted++;
        break; // 跳闸即终局，后面的单子留给人看
      }
      if (f.state === FINDING_STATE.PENDING_CONFIRM && f.rule === RULE.ANCHOR_ROOT) {
        const v = await evaluateAnchor(Number(f.subject), false);
        await handle(v, () => evaluateAnchor(Number(f.subject), true));
        acted++;
        if (tripped) break;
      }
    }
    return { resumed: acted };
  }

  return {
    tickFast,
    tickSlow,
    resume,
    trip,
    evaluateAnchor,
    evaluateReconcile,
    deriveAnchor,
    get tripped() {
      return tripped;
    },
    get last() {
      return last;
    },
  };
}

function bigMax(a, b) {
  return a > b ? a : b;
}

/** 纪元与每日纪元数在这里再导出一次，运维脚本可以直接引用，避免第二份硬编码 */
export const CLOCK = { EPOCH, EPOCHS_PER_DAY };
