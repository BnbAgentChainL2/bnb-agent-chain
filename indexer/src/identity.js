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
//      https / ipfs / ar 链接**不去抓**（索引器不替任何人访问任意 URL），图片链接更不加载；
//      文本一律去掉控制字符与双向控制符，只有 https: / ipfs: / ar: 才算链接（src/text.js）；
//   2. 持有 ERC-8004 身份不能证明对方是 AI（决策 #31a）。这句话跟着每一个身份块走。
import { Interface, getAddress, ZeroAddress } from "ethers";
import { isRevertError } from "./rpc.js";
import { upsert } from "./db.js";
import { warn, clearWarning } from "./warnings.js";
import { cleanText, cleanLink, isLinkable, isDangerous, schemeOf } from "./text.js";

export const IDENTITY_NOTE = "我们要求持有 agent 身份，我们不能证明它是 AI。";
export const REGISTRATION_NOTE =
  "注册文件由身份持有人自己填写，没有任何人核实；本站只做格式解析，不抓取其中的链接，也不加载图片。";

const IFACE = new Interface([
  "function ownerOf(uint256) view returns (address)",
  "function getMetadata(uint256,string) view returns (bytes)",
  // tokenURI 故意按 bytes 解：string 与 bytes 的 ABI 编码逐字节相同，但 ethers 解 string 时遇到非法 UTF-8 会抛错。
  // tokenURI 是持有人自己写的，Solidity 的 string 里可以塞任意字节 —— 按 string 解，一个人造的身份就能让读数卡死。
  "function tokenURI(uint256) view returns (bytes)",
]);

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const UTF8_LENIENT = new TextDecoder("utf-8");

/** tokenURI 的原始字节转文本。非法 UTF-8 不抛错：按替换字符宽松转换，并标出来（解析时一律算 unparsable）。 */
export function uriFromBytes(bytesHex) {
  const h = String(bytesHex ?? "0x");
  const buf = Buffer.from(h.startsWith("0x") ? h.slice(2) : h, "hex");
  try {
    return { text: UTF8_STRICT.decode(buf), validUtf8: true };
  } catch {
    return { text: UTF8_LENIENT.decode(buf), validUtf8: false };
  }
}

/**
 * ethers 的 ABI 解码错误（返回值的字节解不开）。这是**这一个身份**的确定性结果，不是网络问题：
 * 记下来、接着读下一个，不许让它挡住其他身份。
 */
export function isDecodeError(e) {
  if (!e) return false;
  if (["BAD_DATA", "BUFFER_OVERRUN", "INVALID_ARGUMENT", "NUMERIC_FAULT"].includes(e.code)) return true;
  return /ABI decoding|could not decode|invalid codepoint|invalid utf-?8/i.test(String(e.message || ""));
}

/** tokenURI 原文最多存这么多字符（data: URI 可能内嵌整张图片）。解析在截断之前做。 */
export const TOKEN_URI_MAX = 16384;
const STR_MAX = { name: 200, description: 2000, image: 2048, type: 200, service: 512 };
/** reg_kind = 'text' 时，API 最多给出这么多字符的原文。 */
const TEXT_URI_MAX = 200;

/**
 * 清洗一份（已经抽过字段的）注册文件：存库前做一次，出库（identityOf）再做一次 —— 幂等，
 * 这样哪怕库里是旧规则存下的行，发出去的也是清洗过的。
 *   - 文本字段：去控制字符、双向控制符（RLO 之类）、零宽字符，按码点截断（src/text.js，与 economy X4 同一张字符表）；
 *   - image：只留 https: / ipfs: / ar:，别的 scheme（javascript:、data:、http:…）丢掉并记进 dropped；
 *   - services[].endpoint：ERC-8004 允许非 URL 的值（ENS 名、did:、eip155:…），所以照样给出，
 *     但只有 https: / ipfs: / ar: 标 linkable = true；javascript: / vbscript: / data: / file: / blob: 连文本都不留，记进 dropped。
 */
export function cleanRegistration(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const dropped = [];
  let image = cleanLink(p.image, STR_MAX.image);
  if (image !== null && !isLinkable(image)) {
    image = null;
    dropped.push("image");
  }
  const services = (Array.isArray(p.services) ? p.services : []).slice(0, 10).map((x, i) => {
    const s = x && typeof x === "object" && !Array.isArray(x) ? x : { endpoint: x };
    let endpoint = cleanLink(s.endpoint, STR_MAX.service);
    if (endpoint !== null && isDangerous(endpoint)) {
      endpoint = null;
      dropped.push(`services[${i}].endpoint`);
    }
    return {
      name: cleanText(s.name, STR_MAX.service),
      endpoint,
      version: cleanText(s.version, 64),
      linkable: endpoint !== null && isLinkable(endpoint),
    };
  });
  const servicesTotal = Number.isSafeInteger(p.servicesTotal) && p.servicesTotal >= services.length ? p.servicesTotal : services.length;
  return {
    type: cleanText(p.type, STR_MAX.type),
    name: cleanText(p.name, STR_MAX.name),
    description: cleanText(p.description, STR_MAX.description),
    image,
    services,
    servicesTotal,
    supportedTrust: (Array.isArray(p.supportedTrust) ? p.supportedTrust : []).slice(0, 10).map((x) => cleanText(x, 64)),
    dropped: [...(Array.isArray(p.dropped) ? p.dropped.filter((d) => typeof d === "string" && !dropped.includes(d)) : []), ...dropped].slice(0, 20),
  };
}

/** 从一份注册文件 JSON 里只抽这几个字段，别的一概不收（不可信文本越少越好），再清洗。 */
function pickRegistration(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const svcSrc = Array.isArray(j.services) ? j.services : Array.isArray(j.endpoints) ? j.endpoints : [];
  const services = svcSrc.slice(0, 10).map((x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? { name: x.name ?? x.type ?? null, endpoint: x.endpoint ?? x.url ?? null, version: x.version ?? null }
      : { name: null, endpoint: x, version: null }
  );
  return cleanRegistration({
    type: j.type ?? null,
    name: j.name ?? null,
    description: j.description ?? null,
    image: j.image ?? null,
    services,
    servicesTotal: svcSrc.length,
    supportedTrust: Array.isArray(j.supportedTrust) ? j.supportedTrust : [],
  });
}

/**
 * 解析 tokenURI。返回 { kind, fields }：
 *   kind = 'empty'      —— 空字符串 / 没读到
 *        = 'data-json'  —— data:application/json（base64 或 URL 编码），fields 是抽出来并清洗过的几个字段
 *        = 'uri'        —— **只有** https: / ipfs: / ar: 链接：**不抓取**，fields = null
 *        = 'text'       —— 别的一切（裸字符串、0x…、http:、javascript:…）：不是能点的链接，fields = null
 *        = 'unparsable' —— data: 但解不开 / 不是 JSON 对象
 */
export function parseRegistration(uri) {
  const s = String(uri ?? "").trim();
  if (!s) return { kind: "empty", fields: null };
  const m = /^data:application\/json([^,]*),(.*)$/is.exec(s);
  if (!m) {
    if (schemeOf(s) === "data:") return { kind: "unparsable", fields: null };
    return { kind: isLinkable(s) ? "uri" : "text", fields: null };
  }
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
 * 返回 { exists, holder, agentWallet, tokenURI, tokenURIValidUtf8 }。
 * tokenURI 里有非法 UTF-8 时照样返回（宽松转换），tokenURIValidUtf8 = false，存库时记 reg_kind = 'unparsable'。
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
  let tokenURIValidUtf8 = true;
  if (exists) {
    try {
      agentWallet = walletFromMetadata(await call(rpc, registry, "getMetadata", [id, "agentWallet"]));
    } catch (e) {
      if (!isRevertError(e)) throw e;
    }
    try {
      const u = uriFromBytes(await call(rpc, registry, "tokenURI", [id]));
      tokenURI = u.text;
      tokenURIValidUtf8 = u.validUtf8;
    } catch (e) {
      if (!isRevertError(e)) throw e;
    }
  }
  return { exists, holder, agentWallet, tokenURI, tokenURIValidUtf8 };
}

/** 把一次读数写进 agent_identity。 */
export function storeIdentity(db, { agentId, registry, read, now, bscBlock }) {
  // 非法 UTF-8：原文按替换字符存（让人能看见它长什么样），但不去解析 —— 这是一个明确的最终答案，不再重试。
  const reg = read.tokenURIValidUtf8 === false ? { kind: "unparsable", fields: null } : parseRegistration(read.tokenURI);
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
 * 每轮快照读一小批：从没读过的、换了注册表的、超过 staleSec 没重读的，最旧的先读；**失败过的排在最后**
 * —— 否则一个读不出来的身份（checked_at 永远是 NULL）每轮都排第一、每轮都先失败，别的身份永远轮不到。
 * 失败只记在那一行的 attempts / last_error 上，不写任何猜测值：
 *   - 解码错误（这个身份自己的数据解不开）：记下来，接着读下一个；
 *   - 网络 / 节点错误（多半是整个 RPC 出了问题）：停下这一轮，下一轮再来，别让一次快照卡上几分钟。
 */
export async function refreshIdentities(db, rpc, { registry, now, bscBlock = null, max = 10, staleSec = 3600 }) {
  if (!registry || max <= 0) return { read: 0, failed: 0 };
  const rows = db
    .prepare(
      `SELECT a.agent_id AS id FROM agents a LEFT JOIN agent_identity i ON i.agent_id = a.agent_id
        WHERE i.agent_id IS NULL OR i.checked_at IS NULL OR i.checked_at < ? OR i.registry <> ?
        ORDER BY CASE WHEN COALESCE(i.attempts, 0) > 0 THEN 1 ELSE 0 END ASC,
                 COALESCE(i.checked_at, 0) ASC, a.agent_id ASC
        LIMIT ?`
    )
    .all(Number(now) - staleSec, registry, max);
  let read = 0;
  const failures = [];
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
      failures.push(`#${agentId}：${msg}`);
      if (!isDecodeError(e)) break;
    }
  }
  if (failures.length) {
    warn("identity_read_failed", `ERC-8004 身份读取失败 ${failures.length} 个（${failures.slice(0, 3).join("；")}）`);
  } else {
    clearWarning("identity_read_failed");
  }
  return { read, failed: failures.length };
}

/** API 用：一个 agent 的身份块。没读过就全是 null，并照实说「还没读到」。 */
export function identityOf(db, agentId, registryFallback = null) {
  const r = db.prepare("SELECT * FROM agent_identity WHERE agent_id = ?").get(Number(agentId));
  const read = !!(r && r.checked_at != null);
  let fields = null;
  if (r && r.reg_json) {
    try {
      // 出库再洗一遍（幂等）：旧规则存下的行也不会把 javascript: 图片或 RLO 字符发出去
      fields = cleanRegistration(JSON.parse(r.reg_json));
    } catch {
      fields = null;
    }
  }
  let kind = read ? r.reg_kind : null;
  // 旧规则把任何非 data: 的字符串都记成 'uri'：出库时按白名单重判，不是 https: / ipfs: / ar: 的一律是 'text'
  if (kind === "uri" && !isLinkable(r.token_uri)) kind = "text";
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
      // data: URI 本身就是文件内容，不重复返回；https: / ipfs: / ar: 链接清洗后给出（不抓取）
      uri: kind === "uri" ? cleanLink(r.token_uri, TOKEN_URI_MAX) : null,
      // 不是链接的 tokenURI（裸字符串、0x…、http:…）：清洗、截断后当纯文本给出，**不是链接**；
      // javascript: / data: 这类会被执行或内嵌的，连文本都不给
      text: kind === "text" && !isDangerous(r.token_uri) ? cleanText(r.token_uri, TEXT_URI_MAX) : null,
      uriTruncated: read ? Number(r.token_uri_truncated) === 1 : false,
      name: fields ? fields.name : null,
      description: fields ? fields.description : null,
      image: fields ? fields.image : null,
      type: fields ? fields.type : null,
      services: fields ? fields.services : [],
      supportedTrust: fields ? fields.supportedTrust : [],
      // 因为 scheme 不在白名单里被丢掉的字段（"image"、"services[0].endpoint"…）
      dropped: fields ? fields.dropped : [],
      note: REGISTRATION_NOTE,
    },
    note: IDENTITY_NOTE,
  };
}
