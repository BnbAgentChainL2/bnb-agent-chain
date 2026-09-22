// 中继的 SQLite（03-INTERFACES.md §1.5 的表结构逐字照抄）。
// 用 Node 22 内置的 `node:sqlite`：不需要原生编译，`node:22-alpine` 里直接能跑
// （compose 的 command 就是 `node src/index.mjs`，不能带编译步骤）。

import { DatabaseSync } from 'node:sqlite';
import { OUTBOX_STATUS } from './constants.mjs';

/** 03 §1.5 逐字 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor (
  name        TEXT PRIMARY KEY,       -- 'bsc' | 'layer'
  last_block  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,          -- 'credit' | 'anchor' | 'sync'
  key         TEXT NOT NULL,          -- depositId | epoch | agentId:bscBlock
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL,          -- new | sent | confirmed | orphaned | failed | parked
  tx_hash     TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(kind, key)
);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, id);

CREATE TABLE IF NOT EXISTS anchors (
  epoch       INTEGER PRIMARY KEY,
  payload     TEXT NOT NULL,          -- AnchorJob（含全部叶子，供任何人重建证明）
  bsc_tx      TEXT,
  state       TEXT NOT NULL,          -- new | posted | finalized | vetoed | disputed
  updated_at  INTEGER NOT NULL
);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = FULL;'); // 先落盘再推游标，这条纪律不能被写缓存拆掉
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** 一个最小的事务包装：出错就 ROLLBACK，绝不留半条记录 */
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

// ------------------------------------------------------------------ cursor ---

export function getCursor(db, name) {
  const row = db.prepare('SELECT last_block FROM cursor WHERE name = ?').get(name);
  return row ? Number(row.last_block) : null;
}

export function initCursor(db, name, block, now) {
  db.prepare('INSERT OR IGNORE INTO cursor(name, last_block, updated_at) VALUES(?, ?, ?)').run(name, block, now);
  return getCursor(db, name);
}

/**
 * 推进游标。**只在 outbox 那一笔事务提交之后才允许调用**（03 §1.1 第 1 条）。
 * 崩在这两步之间 = 重扫一遍同一段区块 = outbox 的 UNIQUE(kind,key) 去重，安全。
 * 反过来（先推游标再写 outbox）崩一次就永久漏掉一笔存款。
 */
export function setCursor(db, name, block, now) {
  db.prepare('INSERT INTO cursor(name, last_block, updated_at) VALUES(?, ?, ?) ' +
    'ON CONFLICT(name) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at')
    .run(name, block, now);
}

// ------------------------------------------------------------------ outbox ---

/**
 * 写入一条待办。已存在（同 kind+key）就原样返回旧行 —— 幂等，重扫无害。
 * @returns {{inserted: boolean, row: object}}
 */
export function enqueue(db, { kind, key, payload }, now) {
  const existing = db.prepare('SELECT * FROM outbox WHERE kind = ? AND key = ?').get(kind, key);
  if (existing) return { inserted: false, row: existing };
  db.prepare(
    'INSERT INTO outbox(kind, key, payload, status, attempts, created_at, updated_at) VALUES(?, ?, ?, ?, 0, ?, ?)',
  ).run(kind, key, JSON.stringify(payload), OUTBOX_STATUS.NEW, now, now);
  return { inserted: true, row: db.prepare('SELECT * FROM outbox WHERE kind = ? AND key = ?').get(kind, key) };
}

/** 一批待办写进一笔事务（先落盘，再由调用方推游标） */
export function enqueueBatch(db, jobs, now) {
  return tx(db, () => jobs.map((j) => enqueue(db, j, now)));
}

/** 队列头：严格按 id 升序，一次只取一条（单线程发送） */
export function nextPending(db) {
  return db.prepare(
    `SELECT * FROM outbox WHERE status IN ('${OUTBOX_STATUS.NEW}', '${OUTBOX_STATUS.SENT}') ORDER BY id ASC LIMIT 1`,
  ).get();
}

export function pendingList(db, limit = 100) {
  return db.prepare(
    `SELECT * FROM outbox WHERE status IN ('${OUTBOX_STATUS.NEW}', '${OUTBOX_STATUS.SENT}') ORDER BY id ASC LIMIT ?`,
  ).all(limit);
}

export function rowsWithStatus(db, status) {
  return db.prepare('SELECT * FROM outbox WHERE status = ? ORDER BY id ASC').all(status);
}

export function countByStatus(db, status) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE status = ?').get(status);
  return Number(r.n);
}

export function getJob(db, kind, key) {
  return db.prepare('SELECT * FROM outbox WHERE kind = ? AND key = ?').get(kind, key);
}

export function getJobById(db, id) {
  return db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
}

/**
 * 更新一条 job 的状态。payload 里的 status / layerTxHash / attempts / lastError 同步更新，
 * 因为 payload 本身就是 `/api/health` 里 `pendingCredits` 的元素形状（03 §1.2）。
 */
export function updateJob(db, id, patch, now) {
  const row = getJobById(db, id);
  if (!row) throw new Error(`outbox #${id} 不存在`);
  const payload = JSON.parse(row.payload);
  const status = patch.status ?? row.status;
  const txHash = patch.txHash !== undefined ? patch.txHash : row.tx_hash;
  const attempts = patch.attempts !== undefined ? patch.attempts : row.attempts;
  const lastError = patch.lastError !== undefined ? patch.lastError : row.last_error;

  payload.status = status;
  if (payload.kind === 'anchor') payload.bscTxHash = txHash ?? null;
  else payload.layerTxHash = txHash ?? null;
  payload.attempts = attempts;
  payload.lastError = lastError ?? null;

  db.prepare('UPDATE outbox SET status = ?, tx_hash = ?, attempts = ?, last_error = ?, payload = ?, updated_at = ? WHERE id = ?')
    .run(status, txHash ?? null, attempts, lastError ?? null, JSON.stringify(payload), now, id);
  return getJobById(db, id);
}

export function parseJob(row) {
  return JSON.parse(row.payload);
}

// ----------------------------------------------------------------- anchors ---

export function putAnchor(db, epoch, payload, state, now, bscTx = null) {
  db.prepare(
    'INSERT INTO anchors(epoch, payload, bsc_tx, state, updated_at) VALUES(?, ?, ?, ?, ?) ' +
      'ON CONFLICT(epoch) DO UPDATE SET payload = excluded.payload, bsc_tx = excluded.bsc_tx, ' +
      'state = excluded.state, updated_at = excluded.updated_at',
  ).run(epoch, JSON.stringify(payload), bscTx, state, now);
}

export function getAnchor(db, epoch) {
  const row = db.prepare('SELECT * FROM anchors WHERE epoch = ?').get(epoch);
  if (!row) return null;
  return { epoch: Number(row.epoch), payload: JSON.parse(row.payload), bscTx: row.bsc_tx, state: row.state, updatedAt: Number(row.updated_at) };
}

export function setAnchorState(db, epoch, state, now, bscTx = undefined) {
  const cur = getAnchor(db, epoch);
  if (!cur) throw new Error(`anchors[${epoch}] 不存在`);
  const payload = cur.payload;
  payload.status = state === 'finalized' ? 'finalized' : state;
  putAnchor(db, epoch, payload, state, now, bscTx === undefined ? cur.bscTx : bscTx);
}

export function lastAnchorEpoch(db) {
  const r = db.prepare('SELECT MAX(epoch) AS e FROM anchors').get();
  return r && r.e !== null ? Number(r.e) : null;
}

/** 所有还没定案（不是 finalized）的锚点，按纪元升序 —— 被 veto/disputed 的要并进下一个锚点 */
export function unresolvedAnchors(db) {
  return db.prepare("SELECT * FROM anchors WHERE state IN ('vetoed','disputed') ORDER BY epoch ASC")
    .all()
    .map((row) => ({ epoch: Number(row.epoch), payload: JSON.parse(row.payload), state: row.state }));
}
