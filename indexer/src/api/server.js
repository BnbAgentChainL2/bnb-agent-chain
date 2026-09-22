// src/api/server.js —— 03 §3 的 HTTP 服务。
// 公共响应头、错误形状、限速、路由全在这里；每个端点的数据形状在 handlers.js。
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { keccak256, toUtf8Bytes } from "ethers";
import * as H from "./handlers.js";
import { RPC_WHITELIST, rpcGuard } from "./rpcguard.js";

/** 03 §3 开头写死的公共响应头。 */
export const COMMON_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "public, max-age=3",
  "Content-Type": "application/json; charset=utf-8",
};

/** 每 IP 每秒 20 次、每分钟 600 次（03 §3）。超限 429 + rate_limited。 */
export class RateLimiter {
  constructor({ perSec = 20, perMin = 600 } = {}) {
    this.perSec = perSec;
    this.perMin = perMin;
    this.hits = new Map(); // ip -> number[] (毫秒时间戳)
  }
  /** 返回 true 表示放行。 */
  allow(ip, now = Date.now()) {
    const arr = (this.hits.get(ip) || []).filter((t) => now - t < 60000);
    const lastSec = arr.filter((t) => now - t < 1000).length;
    if (lastSec >= this.perSec || arr.length >= this.perMin) {
      this.hits.set(ip, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(ip, arr);
    return true;
  }
  /** 定期清理，别让 map 无限长大。 */
  sweep(now = Date.now()) {
    for (const [ip, arr] of this.hits) {
      const keep = arr.filter((t) => now - t < 60000);
      if (keep.length === 0) this.hits.delete(ip);
      else this.hits.set(ip, keep);
    }
  }
}

function errBody(code, message) {
  return { error: { code, message } };
}

/**
 * 路由。ctx = { db, cfg, snapshot }。
 * 返回 { status, body, headers? }；抛 ApiError 由调用方转成统一错误形状。
 */
export function route(ctx, method, pathname, query) {
  if (method !== "GET") throw new H.ApiError("bad_request", "这个端点只支持 GET", 400);

  if (pathname === "/api/health" || pathname === "/health") return H.health(ctx);
  if (pathname === "/api/summary") return H.summary(ctx);
  if (pathname === "/api/feed") return H.feed(ctx, query);
  if (pathname === "/api/agents") return H.agents(ctx, query);
  if (pathname === "/api/blocks") return H.blocks(ctx, query);
  if (pathname === "/api/contracts") return H.contracts(ctx, query);
  if (pathname === "/api/epochs") return H.epochs(ctx, query);
  if (pathname === "/api/rate") return H.rate(ctx);
  if (pathname === "/api/validators") return H.validators(ctx);
  if (pathname === "/api/treasury") return H.treasury(ctx, query);
  if (pathname === "/api/genesis") return genesis(ctx);
  // 决策 #17：gas 费分账（03 §3.7）
  if (pathname === "/api/fees") return H.fees(ctx);
  if (pathname === "/api/proposers") return H.proposers(ctx, query);

  let m;
  if ((m = pathname.match(/^\/api\/agent\/([^/]+)$/))) return H.agent(ctx, m[1]);
  if ((m = pathname.match(/^\/api\/block\/([^/]+)$/))) return H.block(ctx, m[1]);
  if ((m = pathname.match(/^\/api\/tx\/([^/]+)$/))) return H.txByHash(ctx, m[1]);
  if ((m = pathname.match(/^\/api\/epoch\/([^/]+)\/leaves$/))) return H.epochLeaves(ctx, m[1]);
  if ((m = pathname.match(/^\/api\/epoch\/([^/]+)\/proof\/([^/]+)$/)))
    return H.epochProof(ctx, m[1], m[2]);
  if ((m = pathname.match(/^\/api\/fees\/([^/]+)$/))) return H.feeEpoch(ctx, m[1]);
  if ((m = pathname.match(/^\/api\/epoch\/([^/]+)$/))) return H.epoch(ctx, m[1]);

  throw new H.ApiError("not_found", `没有这个端点：${pathname}`, 404);
}

/** GET /api/genesis —— 原样返回 genesis.json，并带 X-Genesis-Hash 响应头。 */
export function genesis(ctx) {
  const { cfg } = ctx;
  let text;
  try {
    text = readFileSync(cfg.genesisPath, "utf8");
  } catch {
    throw new H.ApiError("not_found", "本机没有 genesis.json", 404);
  }
  return {
    status: 200,
    raw: text,
    headers: { "X-Genesis-Hash": keccak256(toUtf8Bytes(text)) },
  };
}

/** 客户端 IP：Caddy 在前面，所以优先看 X-Forwarded-For 的第一段。 */
export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

export function createApiServer(ctx, { limiter = new RateLimiter(ctx.cfg) } = {}) {
  const server = createServer(async (req, res) => {
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { ...COMMON_HEADERS, ...extra });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, COMMON_HEADERS);
        res.end();
        return;
      }

      const ip = clientIp(req);
      const url = new URL(req.url, "http://localhost");

      if (!limiter.allow(ip)) {
        if (url.pathname === "/rpc") {
          // JSON-RPC 的超限口径是 -32005（02 §5.3）。
          send(429, { jsonrpc: "2.0", id: null, error: { code: -32005, message: "超过限速" } });
          return;
        }
        send(429, errBody("rate_limited", "超过限速：每 IP 每秒 20 次、每分钟 600 次"));
        return;
      }

      if (url.pathname === "/rpc") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString("utf8");
        const out = await rpcGuard(ctx, raw);
        send(out.status, out.body);
        return;
      }

      const query = Object.fromEntries(url.searchParams.entries());
      const out = route(ctx, req.method, url.pathname, query);
      if (out.raw !== undefined) send(out.status, out.raw, out.headers || {});
      else send(out.status, out.body, out.headers || {});
    } catch (e) {
      if (e && e.code && e.status) {
        send(e.status, errBody(e.code, e.message));
        return;
      }
      send(500, errBody("internal", "服务器内部错误"));
    }
  });
  server.on("listening", () => {
    const t = setInterval(() => limiter.sweep(), 60000);
    if (t.unref) t.unref();
  });
  return server;
}

export { RPC_WHITELIST };
