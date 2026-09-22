#!/usr/bin/env node
// src/cli.js —— 索引器的三个子命令：migrate / ingest / serve。
// 本进程只读链，不需要任何私钥。
import { statSync } from "node:fs";
import { openDb, schemaVersion } from "./db.js";
import { loadConfig } from "./config.js";
import { runIngest } from "./ingest.js";
import { refreshSnapshot } from "./snapshot.js";
import { createApiServer } from "./api/server.js";
import { warn } from "./warnings.js";

const cmd = process.argv[2] || "serve";
const cfg = loadConfig();

if (cmd === "migrate") {
  const db = openDb(cfg.dbPath);
  console.log(`迁移完成，schema 版本 = ${schemaVersion(db)}，文件 = ${cfg.dbPath}`);
  process.exit(0);
}

const db = openDb(cfg.dbPath);
const ctx = { db, cfg, snapshot: {} };

async function snapshotLoop() {
  for (;;) {
    try {
      ctx.snapshot = await refreshSnapshot(db, cfg);
      try {
        ctx.snapshot.dbBytes = statSync(cfg.dbPath).size;
      } catch {
        ctx.snapshot.dbBytes = 0;
      }
    } catch (e) {
      warn("snapshot_failed", String(e && e.message ? e.message : e));
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
}

if (cmd === "ingest") {
  runIngest(db, cfg).catch((e) => {
    console.error("摄入循环退出：", e && e.message ? e.message : e);
    process.exit(1);
  });
  snapshotLoop();
} else if (cmd === "serve") {
  const server = createApiServer(ctx);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`索引器 API 在 http://${cfg.host}:${cfg.port} 上（schema 版本 ${schemaVersion(db)}）`);
  });
  runIngest(db, cfg).catch((e) => warn("ingest_stopped", String(e && e.message ? e.message : e)));
  snapshotLoop();
} else {
  console.error(`未知子命令：${cmd}。可用：migrate | ingest | serve`);
  process.exit(2);
}
