// 看门狗的 SQLite。用 Node 22 内置的 `node:sqlite`（`node:22-alpine` 里直接能跑，
// 不需要原生编译，compose 的 command 就是 `node src/index.mjs`）。
//
// 这个库承担两件事，缺一不可：
//   ① **游标**：重启后从上次扫到的区块接着扫，不重复、不跳过。
//   ② **发现（finding）的生命周期**：一条发现从 pending_confirm → pending_trip → tripped
//      是跨进程的。看门狗在「已经确认是假根、还没把 pause() 发出去」的那一瞬间被 kill，
//      重启后必须**接着跳闸**，而不是从头再探测一遍 —— 后者要多花一个完整的轮询周期，
//      在 120 秒的预算里就是致命的。test/restart.test.mjs 测的就是这条。

import { DatabaseSync } from 'node:sqlite';
import { FINDING_STATE } from './constants.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor (
  name        TEXT PRIMARY KEY,       -- 'bsc' | 'layer'
  last_block  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 影子账本：看门狗自己从事件流重算出来的桥内标量，用来在**不依赖归档节点**的情况下
-- 复算「这一笔 settleEpoch 的 pot 是不是超了上限」。键是标量名，值是十进制字符串。
CREATE TABLE IF NOT EXISTS ledger (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 被 VETOED / DISPUTED 的纪元：下一个 FINAL 锚点必须把它们的叶子重报进来（03 §1.3）。
-- 不记这张表，看门狗会把一次**合法**的重报当成伪造的根。
CREATE TABLE IF NOT EXISTS carry (
  epoch       INTEGER PRIMARY KEY,
  state       TEXT NOT NULL,          -- VETOED | DISPUTED
  updated_at  INTEGER NOT NULL
);

-- 每天的释放额，用于滚动 24 小时的释放率上限
CREATE TABLE IF NOT EXISTS release_log (
  epoch       INTEGER PRIMARY KEY,
  pot         TEXT NOT NULL,
  bps         INTEGER NOT NULL,
  at          INTEGER NOT NULL
);

-- 发现：一行就是一次「我比较了什么、两边分别是什么、我打算怎么办」
CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  subject     TEXT NOT NULL,          -- 纪元号 / 交易哈希 / 'global'，同一主体不重复开单
  state       TEXT NOT NULL,          -- pending_confirm | pending_trip | tripped | cleared
  detail      TEXT NOT NULL,          -- JSON：比较的每一个数，原样
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(rule, subject)
);
CREATE INDEX IF NOT EXISTS findings_state ON findings(state, id);

CREATE TABLE IF NOT EXISTS trips (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id  INTEGER NOT NULL,
  rule        TEXT NOT NULL,
  tx_hash     TEXT,
  ok          INTEGER NOT NULL,
  note        TEXT,
  at          INTEGER NOT NULL
);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  // 先落盘再推游标。看门狗的状态机允许重复处理（幂等），但不允许丢失一条已确认的发现。
  db.exec('PRAGMA synchronous = FULL;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败也要把原始错误抛出去 */
    }
    throw e;
  }
}

// ------------------------------------------------------------------ 游标

export function getCursor(db, name) {
  const r = db.prepare('SELECT last_block FROM cursor WHERE name = ?').get(name);
  return r ? Number(r.last_block) : null;
}

export function setCursor(db, name, block, now) {
  db.prepare(
    'INSERT INTO cursor(name,last_block,updated_at) VALUES(?,?,?) ' +
      'ON CONFLICT(name) DO UPDATE SET last_block=excluded.last_block, updated_at=excluded.updated_at',
  ).run(name, Number(block), Number(now));
}

// -------------------------------------------------------------- 影子账本

export function getLedger(db, key, fallback = 0n) {
  const r = db.prepare('SELECT value FROM ledger WHERE key = ?').get(key);
  return r ? BigInt(r.value) : fallback;
}

export function setLedger(db, key, value, now) {
  db.prepare(
    'INSERT INTO ledger(key,value,updated_at) VALUES(?,?,?) ' +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
  ).run(key, BigInt(value).toString(), Number(now));
}

export function allLedger(db) {
  const out = {};
  for (const r of db.prepare('SELECT key,value FROM ledger').all()) out[r.key] = BigInt(r.value);
  return out;
}

// --------------------------------------------------------- 重报（carry）集

export function addCarry(db, epoch, state, now) {
  db.prepare(
    'INSERT INTO carry(epoch,state,updated_at) VALUES(?,?,?) ' +
      'ON CONFLICT(epoch) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at',
  ).run(Number(epoch), String(state), Number(now));
}

/** 某个纪元之前、仍未被重报进任何 FINAL 锚点的纪元号（升序） */
export function carryBefore(db, epoch) {
  return db
    .prepare('SELECT epoch FROM carry WHERE epoch < ? ORDER BY epoch ASC')
    .all(Number(epoch))
    .map((r) => Number(r.epoch));
}

/** 一个 FINAL 锚点落地：它之前的重报集被清空（叶子已经并进去了） */
export function clearCarryBefore(db, epoch) {
  db.prepare('DELETE FROM carry WHERE epoch < ?').run(Number(epoch));
}

// -------------------------------------------------------------- 释放记录

export function recordRelease(db, epoch, pot, bps, at) {
  db.prepare(
    'INSERT INTO release_log(epoch,pot,bps,at) VALUES(?,?,?,?) ' +
      'ON CONFLICT(epoch) DO UPDATE SET pot=excluded.pot, bps=excluded.bps, at=excluded.at',
  ).run(Number(epoch), BigInt(pot).toString(), Number(bps), Number(at));
}

/** 滚动窗口内的释放总额（含端点：at >= since） */
export function releasedSince(db, since) {
  const rows = db.prepare('SELECT pot FROM release_log WHERE at >= ?').all(Number(since));
  let total = 0n;
  for (const r of rows) total += BigInt(r.pot);
  return total;
}

export function pruneReleases(db, before) {
  db.prepare('DELETE FROM release_log WHERE at < ?').run(Number(before));
}

// ------------------------------------------------------------------ 发现

/**
 * 开单或更新一条发现。同一 (rule, subject) 只会有一行 —— 一个假根被连续看到 20 次，
 * 是一条发现被复核了 20 次，不是 20 条告警。
 */
export function upsertFinding(db, { rule, subject, severity, state, detail }, now) {
  db.prepare(
    'INSERT INTO findings(rule,subject,severity,state,detail,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ' +
      'ON CONFLICT(rule,subject) DO UPDATE SET severity=excluded.severity, state=excluded.state, ' +
      'detail=excluded.detail, updated_at=excluded.updated_at',
  ).run(rule, String(subject), severity, state, JSON.stringify(detail ?? {}), Number(now), Number(now));
  return getFinding(db, rule, subject);
}

export function getFinding(db, rule, subject) {
  const r = db.prepare('SELECT * FROM findings WHERE rule = ? AND subject = ?').get(rule, String(subject));
  return r ? hydrate(r) : null;
}

export function setFindingState(db, id, state, now, detail) {
  if (detail === undefined) {
    db.prepare('UPDATE findings SET state = ?, updated_at = ? WHERE id = ?').run(state, Number(now), Number(id));
  } else {
    db.prepare('UPDATE findings SET state = ?, detail = ?, updated_at = ? WHERE id = ?').run(
      state,
      JSON.stringify(detail),
      Number(now),
      Number(id),
    );
  }
}

/** 重启后要接着走完的发现：已经确认、但 pause() 还没发出去的那些 */
export function unfinishedFindings(db) {
  return db
    .prepare('SELECT * FROM findings WHERE state IN (?, ?) ORDER BY id ASC')
    .all(FINDING_STATE.PENDING_TRIP, FINDING_STATE.PENDING_CONFIRM)
    .map(hydrate);
}

export function trippedFindings(db) {
  return db.prepare('SELECT * FROM findings WHERE state = ? ORDER BY id ASC').all(FINDING_STATE.TRIPPED).map(hydrate);
}

export function recordTrip(db, { findingId, rule, txHash, ok, note }, now) {
  db.prepare('INSERT INTO trips(finding_id,rule,tx_hash,ok,note,at) VALUES(?,?,?,?,?,?)').run(
    Number(findingId),
    rule,
    txHash ?? null,
    ok ? 1 : 0,
    note ?? null,
    Number(now),
  );
}

export function allTrips(db) {
  return db.prepare('SELECT * FROM trips ORDER BY id ASC').all();
}

function hydrate(r) {
  return {
    id: Number(r.id),
    rule: r.rule,
    severity: r.severity,
    subject: r.subject,
    state: r.state,
    detail: JSON.parse(r.detail),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
