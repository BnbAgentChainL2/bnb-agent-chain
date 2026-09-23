// src/identity.js —— ERC-8004 身份读数（决策 #31）。
//
// 一个 agent = 一个锁过桥的 ERC-8004 身份 id（BacBridge.Locked 带着 agentId）。我们只读这些 id，
// 不去扫注册表里那 35 万个身份。每个 id 读三样东西，全部走 eth_call，逐字按
// contracts/src/interfaces/IERC8004Identity.sol（从 BSC 上实际部署的实现反汇编来的签名）：
//   ownerOf(uint256)                    —— 未铸造的 id 会 revert（ERC721NonexistentToken）；
//   getMetadata(uint256,"agentWallet")  —— 返回 20 个**裸字节**，不是 abi 编码的地址；没设置就是空；
//   tokenURI(uint256)                   —— 注册文件，**完全由持有人自己填写，没有任何人核实**。
//
// 两条硬规矩：
//   1. 注册文件里的任何东西（名字、介绍、图片、服务地址）都是自述，API 一律带 selfReported: true；
//      http / ipfs 链接**不去抓**（索引器不替任何人访问任意 URL），图片链接更不加载；
//   2. 持有 ERC-8004 身份不能证明对方是 AI（决策 #31a）。这句话跟着每一个身份块走。
import { Interface, getAddress, ZeroAddress } from "ethers";
import { isRevertError } from "./rpc.js";
import { upsert } from "./db.js";
import { warn, clearWarning } from "./warnings.js";

export const IDENTITY_NOTE = "我们要求持有 agent 身份，我们不能证明它是 AI。";
export const REGISTRATION_NOTE =
  "注册文件由身份持有人自己填写，没有任何人核实；本站只做格式解析，不抓取其中的链接，也不加载图片。";

const IFACE = new Interface([
  "function ownerOf(uint256) view returns (address)",
  "function getMetadata(uint256,string) view returns (bytes)",
  "function tokenURI(uint256) view returns (string)",
]);

/** tokenURI 原文最多存这么多字符（data: URI 可能内嵌整张图片）。解析在截断之前做。 */
export const TOKEN_URI_MAX = 16384;
const STR_MAX = { name: 200, description: 2000, image: 2048, type: 200, service: 512 };

const cap = (v, n) => {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : String(v);
  return s.length > n ? s.slice(0, n) : s;
};

/** 从一份注册文件 JSON 里只抽这几个字段，别的一概不收（不可信文本越少越好）。 */
function pickRegistration(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const svcSrc = Array.isArray(j.services) ? j.services : Array.isArray(j.endpoints) ? j.endpoints : [];
  const services = svcSrc.slice(0, 10).map((x) =>
    x && typeof x === "object"
      ? {
          name: cap(x.name ?? x.type ?? null, STR_MAX.service),
          endpoint: cap(x.endpoint ?? x.url ?? null, STR_MAX.service),
          version: cap(x.version ?? null, 64),
        }
      : { name: null, endpoint: cap(x, STR_MAX.service), version: null }
  );
  const trust = Array.isArray(j.supportedTrust) ? j.supportedTrust.slice(0, 10).map((x) => cap(x, 64)) : [];
  return {
    type: cap(j.type ?? null, STR_MAX.type),
    name: cap(j.name ?? null, STR_MAX.name),
    description: cap(j.description ?? null, STR_MAX.description),
    image: cap(j.image ?? null, STR_MAX.image),
    services,
    servicesTotal: svcSrc.length,
    supportedTrust: trust,
  };
}

/**
 * 解析 tokenURI。返回 { kind, fields }：
 *   kind = 'empty'      —— 空字符串 / 没读到
 *        = 'data-json'  —— data:application/json（base64 或 URL 编码），fields 是抽出来的几个字段
 *        = 'uri'        —— http(s) / ipfs / ar 等外部链接：**不抓取**，fields = null
 *        = 'unparsable' —— data: 但解不开 / 不是 JSON 对象
 */
export function parseRegistration(uri) {
  const s = String(uri ?? "").trim();
  if (!s) return { kind: "empty", fields: null };
  const m = /^data:application\/json([^,]*),(.*)$/is.exec(s);
  if (!m) return { kind: s.startsWith("data:") ? "unparsable" : "uri", fields: null };
  try {
    const meta = m[1].toLowerCase();
    const body = meta.includes(";base64")
      ? Buffer.from(m[2], "base64").toString("utf8")
      : decodeURIComponent(m[2]);
    const fields = pickRegistration(JSON.parse(body));
    return fields ? { kind: "data-json", fields } : { kind: "unparsable", fields: null };
  } catch {
    return { kind: "unparsable", fields: null };
  }
}

/** getMetadata 的返回值：20 个裸字节才算地址，别的长度一律当「没设置」，不猜。 */
export function walletFromMetadata(bytesHex) {
  const h = String(bytesHex ?? "0x").toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(h) || h.length !== 42) return null;
  const a = getAddress(h);
  return a === ZeroAddress ? null : a;
}

async function call(rpc, registry, fn, args) {
  const out = await rpc.ethCall(registry, IFACE.encodeFunctionData(fn, args));
  if (!out || out === "0x") {
    // 没有代码的地址对任何 eth_call 都回 0x：这不是「身份不存在」，是注册表地址配错了。
    throw new Error(`身份注册表 ${registry} 对 ${fn} 返回空（地址上没有代码？）`);
  }
  return IFACE.decodeFunctionResult(fn, out)[0];
}

/**
 * 读一个身份。revert 是确定性答案（不存在 / 没设置），网络错误才往外抛（下一轮重试）。
 * 返回 { exists, holder, agentWallet, tokenURI }。
 */
export async function readIdentity(rpc, registry, agentId) {
  const id = BigInt(agentId);
  let holder = null;
  let exists;
  try {
    holder = getAddress(await call(rpc, registry, "ownerOf", [id]));
    exists = holder !== ZeroAddress;
    if (!exists) holder = null;
  } catch (e) {
    if (!isRevertError(e)) throw e;
    exists = false;
  }
  let agentWallet = null;
  let tokenURI = null;
  if (exists) {
    try {
      agentWallet = walletFromMetadata(await call(rpc, registry, "getMetadata", [id, "agentWallet"]));
    } catch (e) {
      if (!isRevertError(e)) throw e;
    }
    try {
      tokenURI = String(await call(rpc, registry, "tokenURI", [id]));
    } catch (e) {
      if (!isRevertError(e)) throw e;
    }
  }
  return { exists, holder, agentWallet, tokenURI };
}

/** 把一次读数写进 agent_identity。 */
export function storeIdentity(db, { agentId, registry, read, now, bscBlock }) {
  const reg = parseRegistration(read.tokenURI);
  const uri = read.tokenURI ?? null;
  upsert(
    db,
    "agent_identity",
    {
      agent_id: Number(agentId),
      registry,
      exists_on_registry: read.exists ? 1 : 0,
      holder: read.holder,
      agent_wallet: read.agentWallet,
      token_uri: uri === null ? null : uri.slice(0, TOKEN_URI_MAX),
      token_uri_truncated: uri !== null && uri.length > TOKEN_URI_MAX ? 1 : 0,
      reg_kind: reg.kind,
      reg_json: reg.fields ? JSON.stringify(reg.fields) : null,
      checked_at: Number(now),
      checked_bsc_block: bscBlock ?? null,
      attempts: 0,
      last_error: null,
    },
    ["agent_id"]
  );
}

/**
 * 每轮快照读一小批：从没读过的、换了注册表的、超过 staleSec 没重读的，最旧的先读。
 * 网络错误只记在那一行的 attempts / last_error 上，并停止这一轮（多半是 RPC 出问题了），不写任何猜测值。
 */
export async function refreshIdentities(db, rpc, { registry, now, bscBlock = null, max = 10, staleSec = 3600 }) {
  if (!registry || max <= 0) return { read: 0, failed: 0 };
  const rows = db
    .prepare(
      `SELECT a.agent_id AS id FROM agents a LEFT JOIN agent_identity i ON i.agent_id = a.agent_id
        WHERE i.agent_id IS NULL OR i.checked_at IS NULL OR i.checked_at < ? OR i.registry <> ?
        ORDER BY COALESCE(i.checked_at, 0) ASC, a.agent_id ASC LIMIT ?`
    )
    .all(Number(now) - staleSec, registry, max);
  let read = 0;
  for (const r of rows) {
    const agentId = Number(r.id);
    try {
      const got = await readIdentity(rpc, registry, agentId);
      storeIdentity(db, { agentId, registry, read: got, now, bscBlock });
      read += 1;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).slice(0, 500);
      db.prepare(
        `INSERT INTO agent_identity (agent_id, registry, attempts, last_error) VALUES (?, ?, 1, ?)
         ON CONFLICT(agent_id) DO UPDATE SET attempts = agent_identity.attempts + 1, last_error = excluded.last_error`
      ).run(agentId, registry, msg);
      warn("identity_read_failed", `ERC-8004 身份 #${agentId} 读取失败：${msg}`);
      return { read, failed: 1 };
    }
  }
  clearWarning("identity_read_failed");
  return { read, failed: 0 };
}

/** API 用：一个 agent 的身份块。没读过就全是 null，并照实说「还没读到」。 */
export function identityOf(db, agentId, registryFallback = null) {
  const r = db.prepare("SELECT * FROM agent_identity WHERE agent_id = ?").get(Number(agentId));
  const read = !!(r && r.checked_at != null);
  let fields = null;
  if (r && r.reg_json) {
    try {
      fields = JSON.parse(r.reg_json);
    } catch {
      fields = null;
    }
  }
  const kind = read ? r.reg_kind : null;
  return {
    standard: "ERC-8004",
    registry: (r && r.registry) || registryFallback,
    agentId: Number(agentId),
    read,
    exists: read ? Number(r.exists_on_registry) === 1 : null,
    holder: read ? r.holder ?? null : null,
    agentWallet: read ? r.agent_wallet ?? null : null,
    checkedAt: read ? Number(r.checked_at) : null,
    checkedBscBlock: read && r.checked_bsc_block != null ? Number(r.checked_bsc_block) : null,
    lastError: r && r.last_error ? r.last_error : null,
    registration: {
      selfReported: true,
      kind,
      // data: URI 本身就是文件内容，不重复返回；外部链接原样给出（不抓取）
      uri: kind === "uri" ? r.token_uri : null,
      uriTruncated: read ? Number(r.token_uri_truncated) === 1 : false,
      name: fields ? fields.name : null,
      description: fields ? fields.description : null,
      image: fields ? fields.image : null,
      type: fields ? fields.type : null,
      services: fields ? fields.services : [],
      supportedTrust: fields ? fields.supportedTrust : [],
      note: REGISTRATION_NOTE,
    },
    note: IDENTITY_NOTE,
  };
}
