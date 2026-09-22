// src/db.js —— SQLite 打开 + 迁移 + 幂等写入工具。
// 用 Node 22 自带的 node:sqlite，不引第三方原生模块（离线可跑，没有编译步骤）。
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(HERE, "..", "migrations");

/** 打开数据库并跑完所有未应用的迁移。path 传 ":memory:" 也可以（测试用）。 */
export function openDb(path, { migrationsDir = MIGRATIONS_DIR } = {}) {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    } catch {
      // 目录已存在就算了
    }
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, migrationsDir);
  return db;
}

/** 按文件名顺序应用 migrations/*.sql。已应用过的版本跳过。返回这次应用了哪几个。 */
export function migrate(db, migrationsDir = MIGRATIONS_DIR) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)"
  );
  const done = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => Number(r.version))
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied = [];
  for (const f of files) {
    const version = Number(f.split("_")[0]);
    if (!Number.isFinite(version)) throw new Error(`迁移文件名必须以版本号开头：${f}`);
    if (done.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(version, f, Math.floor(Date.now() / 1000));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`迁移 ${f} 失败：${e.message}`);
    }
    applied.push(f);
  }
  return applied;
}

/** 当前 schema 版本（没有任何迁移时是 0）。 */
export function schemaVersion(db) {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
  return row && row.v != null ? Number(row.v) : 0;
}

/** 事务包装。回调抛异常就回滚 —— 「宁可停，不可错」：半条记录比没有记录更危险。 */
export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚失败就让原异常冒出去
    }
    throw e;
  }
}

/** 读游标；没有记录返回 null（调用方自己决定从哪个块起跑）。 */
export function getCursor(db, chain) {
  const row = db.prepare("SELECT last_block FROM cursor WHERE chain = ?").get(chain);
  return row ? Number(row.last_block) : null;
}

/** 写游标。永远只往前推：倒退的写入被忽略，避免一次重放把进度冲回去。 */
export function setCursor(db, chain, lastBlock, now = Math.floor(Date.now() / 1000)) {
  db.prepare(
    `INSERT INTO cursor (chain, last_block, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chain) DO UPDATE SET
       last_block = MAX(cursor.last_block, excluded.last_block),
       updated_at = excluded.updated_at`
  ).run(chain, lastBlock, now);
}

/**
 * 幂等 upsert。
 * cols 的顺序就是绑定顺序；conflict 是冲突列名数组；update 是冲突时要覆盖的列名数组。
 * update 为空数组时冲突就什么都不做（纯 insert-or-ignore）。
 */
export function upsert(db, table, row, conflict, update = null) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => "?").join(", ");
  const upd = update === null ? cols.filter((c) => !conflict.includes(c)) : update;
  const setSql =
    upd.length === 0
      ? "NOTHING"
      : `UPDATE SET ${upd.map((c) => `"${c}" = excluded."${c}"`).join(", ")}`;
  const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})
     ON CONFLICT(${conflict.map((c) => `"${c}"`).join(", ")}) DO ${setSql}`;
  return db.prepare(sql).run(...cols.map((c) => norm(row[c])));
}

/** node:sqlite 只认 null/number/bigint/string/Uint8Array，布尔和 undefined 要先归一化。 */
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export { norm as normalizeValue };
