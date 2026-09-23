// src/economy/classify.js —— 03 §7.1 / §7.2 的判定规则。
//
// 判定只看行为（日志形状 + eth_call 应答），不看源码、不看 ABI、不看谁部署的（§7.0 第 2 条）。
// 全部是启发式：会漏也会错，所以每一条结论都要落 contract_probes，分不出来的照实写 not_token，
// 绝不静默丢掉一个地址。
import { getAddress } from "ethers";
import { SELECTOR, MAX_DECIMALS, MAX_TEXT_BYTES, ZERO_ADDR } from "./constants.js";
import { byteLen, hasCode } from "./probe.js";

// ---------------------------------------------------------------- 返回值解码

/** 32 字节的 uint256；长度不对返回 null（这就是 N3 的判据）。 */
export function decodeUint256(hex) {
  if (byteLen(hex) !== 32) return null;
  return BigInt(hex);
}

/** 32 字节里的地址（高 12 字节必须是 0，否则不是一个干净的 address 返回值）。 */
export function decodeAddress(hex) {
  if (byteLen(hex) !== 32) return null;
  const body = String(hex).slice(2);
  if (!/^0{24}/.test(body)) return null;
  try {
    return getAddress("0x" + body.slice(24));
  } catch {
    return null;
  }
}

/** X4：不可信文本的清洗。截断 128 字节 -> 非 UTF-8 换 U+FFFD -> 去控制字符 -> 两端裁空白。 */
export function sanitizeText(bytes) {
  if (bytes === null || bytes === undefined) return null;
  let buf = bytes instanceof Uint8Array ? bytes : Buffer.from(String(bytes), "utf8");
  if (buf.length > MAX_TEXT_BYTES) buf = buf.subarray(0, MAX_TEXT_BYTES);
  // Node 的 utf8 解码对非法字节就是换成 U+FFFD，正是 X4 要的行为。
  let s = Buffer.from(buf).toString("utf8");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, "");
  s = s.trim();
  return s;
}

/**
 * name() / symbol() 的返回值。两种形状都要认：
 *   - 标准 ABI 的 string（offset + length + 内容）；
 *   - 老代币的 bytes32（正好 32 字节，右侧补零）。
 * 认不出来返回 null —— 元数据缺失不否决判定，只影响 detect_level（§7.1.4）。
 */
export function decodeStringReturn(hex) {
  const len = byteLen(hex);
  if (len === 0) return null;
  const body = Buffer.from(String(hex).slice(2), "hex");
  if (len === 32) {
    // bytes32：去掉右侧的 0 填充。
    let end = 32;
    while (end > 0 && body[end - 1] === 0) end -= 1;
    if (end === 0) return null;
    return sanitizeText(body.subarray(0, end));
  }
  if (len < 64) return null;
  const offset = Number(BigInt("0x" + body.subarray(0, 32).toString("hex")));
  if (!Number.isSafeInteger(offset) || offset + 32 > len) return null;
  const strLen = Number(BigInt("0x" + body.subarray(offset, offset + 32).toString("hex")));
  if (!Number.isSafeInteger(strLen) || strLen < 0) return null;
  const start = offset + 32;
  const end = Math.min(len, start + strLen);
  if (end <= start) return null;
  return sanitizeText(body.subarray(start, end));
}

/** balanceOf(addr) 的 calldata。 */
export function balanceOfData(address) {
  return SELECTOR.balanceOf + String(address).replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

// ---------------------------------------------------------------- 代币探测

/**
 * §7.1.3 的四条必要条件 + §7.1.4 的三个可选元数据。
 * shapeOk 由调用方从日志里判定（N2：topics.length == 3 且 data 正好 32 字节），
 * **不许**靠二次 eth_call 代替它（§7.1.3 的原话）。
 *
 * 返回 { isToken, reason, detectLevel, name, symbol, decimals, totalSupply, probeBlock, calls }。
 * 抛 ProbeUnavailable 表示探测失败（不是「不是代币」），调用方必须留在 pending。
 */
export async function probeToken(session, address, { shapeOk }) {
  // N1
  const code = await session.code(address);
  if (!hasCode(code)) {
    return { isToken: false, reason: "N1：这个地址没有代码", probeBlock: session.usedBlock, calls: session.calls };
  }
  // N2
  if (!shapeOk) {
    return {
      isToken: false,
      reason: "N2：没有见过形状正确的 ERC-20 Transfer（3 个 topic + 32 字节 data）",
      probeBlock: session.usedBlock,
      calls: session.calls,
    };
  }
  // N3
  const ts = await session.call(address, SELECTOR.totalSupply);
  const total = ts.ok ? decodeUint256(ts.data) : null;
  if (total === null) {
    return { isToken: false, reason: "N3：totalSupply() 没有返回 32 字节的 uint256", probeBlock: session.usedBlock, calls: session.calls };
  }
  // N4：先探 address(0)，失败再探合约自己的地址，任一成功即算。
  let bal = await session.call(address, balanceOfData(ZERO_ADDR));
  let balOk = bal.ok && decodeUint256(bal.data) !== null;
  if (!balOk) {
    bal = await session.call(address, balanceOfData(address));
    balOk = bal.ok && decodeUint256(bal.data) !== null;
  }
  if (!balOk) {
    return { isToken: false, reason: "N4：balanceOf(address) 没有返回 32 字节的 uint256", probeBlock: session.usedBlock, calls: session.calls };
  }

  // 可选元数据。缺失不否决，只把等级降到 partial。
  const nameR = await session.call(address, SELECTOR.name);
  const symR = await session.call(address, SELECTOR.symbol);
  const decR = await session.call(address, SELECTOR.decimals);
  const name = nameR.ok ? decodeStringReturn(nameR.data) : null;
  const symbol = symR.ok ? decodeStringReturn(symR.data) : null;
  let decimals = null;
  if (decR.ok) {
    const d = decodeUint256(decR.data);
    // X3：> 77 是垃圾值，写 NULL 并降级。
    if (d !== null && d >= 0n && d <= BigInt(MAX_DECIMALS)) decimals = Number(d);
  }
  const full = !!name && !!symbol && decimals !== null;
  return {
    isToken: true,
    reason: null,
    detectLevel: full ? "full" : "partial",
    name: name || null,
    symbol: symbol || null,
    decimals,
    totalSupply: total.toString(10),
    probeBlock: session.usedBlock,
    calls: session.calls,
  };
}

// ---------------------------------------------------------------- 交易对探测

/**
 * §7.2.3 的确认探测。hint 是发现路径给的形状猜测（'v2' | 'v3'），先按它探，不过再试另一种。
 * isKnownToken(addr) 由调用方提供（查 tokens 表）—— 这是 P4，唯一一条跨表的条件。
 *
 * 返回：
 *   { ok: true, kind, token0, token1, feePpm, tickSpacing, reserve0, reserve1, reserveSource, factory, probeBlock }
 *   { ok: false, waiting: true, token0, token1, kind }   —— 两边都还不是已知代币，进 pair_candidates 等
 *   { ok: false, waiting: false, reason }                —— 形状不对，不是交易对
 */
export async function probePair(session, address, { hint = "v2", isKnownToken }) {
  const code = await session.code(address);
  if (!hasCode(code)) return { ok: false, waiting: false, reason: "这个地址没有代码" };

  // P1 / P2
  const t0r = await session.call(address, SELECTOR.token0);
  const t1r = await session.call(address, SELECTOR.token1);
  const token0 = t0r.ok ? decodeAddress(t0r.data) : null;
  const token1 = t1r.ok ? decodeAddress(t1r.data) : null;
  if (!token0 || token0 === ZERO_ADDR) return { ok: false, waiting: false, reason: "P1：token0() 没有返回一个非零地址" };
  if (!token1 || token1 === ZERO_ADDR) return { ok: false, waiting: false, reason: "P2：token1() 没有返回一个非零地址" };
  if (token0 === token1) return { ok: false, waiting: false, reason: "P2：token0 与 token1 是同一个地址" };
  const c0 = await session.code(token0);
  const c1 = await session.code(token1);
  if (!hasCode(c0) || !hasCode(c1)) return { ok: false, waiting: false, reason: "P1/P2：两边的代币地址里有一个没有代码" };

  // 形状：先按 hint 探，不过再试另一种。
  const order = hint === "v3" ? ["v3", "v2"] : ["v2", "v3"];
  let shape = null;
  for (const k of order) {
    if (k === "v2") {
      const r = await session.call(address, SELECTOR.getReserves);
      // P3：getReserves() 返回 96 字节（uint112,uint112,uint32）
      if (r.ok && byteLen(r.data) === 96) {
        const body = String(r.data).slice(2);
        shape = {
          kind: "v2",
          reserve0: BigInt("0x" + body.slice(0, 64)).toString(10),
          reserve1: BigInt("0x" + body.slice(64, 128)).toString(10),
          reserveSource: "getReserves",
          feePpm: null,
          tickSpacing: null,
        };
        break;
      }
    } else {
      // P5：fee() 是 uint24 且 <= 1000000；P6：slot0() 成功且返回 >= 32 字节
      const f = await session.call(address, SELECTOR.fee);
      const fee = f.ok ? decodeUint256(f.data) : null;
      if (fee === null || fee > 1000000n) continue;
      const s0 = await session.call(address, SELECTOR.slot0);
      if (!s0.ok || byteLen(s0.data) < 32) continue;
      // V3 没有 getReserves()：池内余额用 balanceOf(token, pool) 读，来源写 balanceOf。
      const b0 = await session.call(token0, balanceOfData(address));
      const b1 = await session.call(token1, balanceOfData(address));
      const r0 = b0.ok ? decodeUint256(b0.data) : null;
      const r1 = b1.ok ? decodeUint256(b1.data) : null;
      const tsp = await session.call(address, SELECTOR.tickSpacing);
      const tspv = tsp.ok ? decodeUint256(tsp.data) : null;
      shape = {
        kind: "v3",
        reserve0: r0 === null ? "0" : r0.toString(10),
        reserve1: r1 === null ? "0" : r1.toString(10),
        reserveSource: "balanceOf",
        feePpm: Number(fee),
        tickSpacing: tspv === null ? null : Number(BigInt.asIntN(256, tspv)),
      };
      break;
    }
  }
  if (!shape) return { ok: false, waiting: false, reason: "P3/P5/P6：既不是 V2 的 getReserves 形状，也不是 V3 的 fee+slot0 形状" };

  // P4：两边至少有一个已经被 §7.1 判成代币。都不是就停在 pair_candidates 等。
  const k0 = isKnownToken(token0);
  const k1 = isKnownToken(token1);
  if (!k0 && !k1) {
    return { ok: false, waiting: true, kind: shape.kind, token0, token1, reason: "P4：两边都还不是已识别的代币" };
  }

  const fr = await session.call(address, SELECTOR.factory);
  const factory = fr.ok ? decodeAddress(fr.data) : null;

  return {
    ok: true,
    ...shape,
    token0,
    token1,
    factory: factory && factory !== ZERO_ADDR ? factory : null,
    detectLevel: k0 && k1 ? "full" : "partial",
    probeBlock: session.usedBlock,
    calls: session.calls,
  };
}
