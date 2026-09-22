// 固定 64 字节输入的 keccak256 + 挑战求解器的热循环。
//
// 为什么自己写：挑战的答案条件是 uint256(keccak256(abi.encode(seed, nonce))) < 2**236，
// 也就是平均要算 2**20 约 105 万次哈希，而截止只有 5 秒 / 8 个区块（01 §3.3）。
// 实测（Node 22，本机）：ethers.keccak256 约 14.1 万次/秒，本文件的定长实现约 55-65 万次/秒。
// 依赖仍然只有 ethers 一个：本文件不引入任何第三方包。
// 正确性由 test/keccak.test.js 对 ethers.keccak256 做 200 组随机对拍保证。

const RC_LO = new Int32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000 | 0, 0x0000808b, 0x80000001 | 0,
  0x80008081 | 0, 0x00008009, 0x0000008a, 0x00000088, 0x80008009 | 0, 0x8000000a | 0,
  0x8000808b | 0, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a | 0, 0x80008081 | 0, 0x00008080, 0x80000001 | 0, 0x80008008 | 0,
]);
const RC_HI = new Int32Array([
  0, 0, 0x80000000 | 0, 0x80000000 | 0, 0, 0, 0x80000000 | 0, 0x80000000 | 0, 0, 0, 0, 0,
  0, 0x80000000 | 0, 0x80000000 | 0, 0x80000000 | 0, 0x80000000 | 0, 0x80000000 | 0, 0,
  0x80000000 | 0, 0x80000000 | 0, 0x80000000 | 0, 0, 0x80000000 | 0,
]);

// 状态：25 个 64 位 lane 拆成 50 个 32 位半字（s[2i] = 低半，s[2i+1] = 高半）。
const s = new Int32Array(50);
const b = new Int32Array(50);

/** keccak-f[1600] 置换，就地作用在模块级的 s 上。 */
function permute(): void {
  for (let r = 0; r < 24; r++) {
    // theta
    const c0l = s[0] ^ s[10] ^ s[20] ^ s[30] ^ s[40], c0h = s[1] ^ s[11] ^ s[21] ^ s[31] ^ s[41];
    const c1l = s[2] ^ s[12] ^ s[22] ^ s[32] ^ s[42], c1h = s[3] ^ s[13] ^ s[23] ^ s[33] ^ s[43];
    const c2l = s[4] ^ s[14] ^ s[24] ^ s[34] ^ s[44], c2h = s[5] ^ s[15] ^ s[25] ^ s[35] ^ s[45];
    const c3l = s[6] ^ s[16] ^ s[26] ^ s[36] ^ s[46], c3h = s[7] ^ s[17] ^ s[27] ^ s[37] ^ s[47];
    const c4l = s[8] ^ s[18] ^ s[28] ^ s[38] ^ s[48], c4h = s[9] ^ s[19] ^ s[29] ^ s[39] ^ s[49];
    let dl: number, dh: number;
    dl = c4l ^ ((c1l << 1) | (c1h >>> 31)); dh = c4h ^ ((c1h << 1) | (c1l >>> 31));
    s[0] ^= dl; s[1] ^= dh; s[10] ^= dl; s[11] ^= dh; s[20] ^= dl; s[21] ^= dh; s[30] ^= dl; s[31] ^= dh; s[40] ^= dl; s[41] ^= dh;
    dl = c0l ^ ((c2l << 1) | (c2h >>> 31)); dh = c0h ^ ((c2h << 1) | (c2l >>> 31));
    s[2] ^= dl; s[3] ^= dh; s[12] ^= dl; s[13] ^= dh; s[22] ^= dl; s[23] ^= dh; s[32] ^= dl; s[33] ^= dh; s[42] ^= dl; s[43] ^= dh;
    dl = c1l ^ ((c3l << 1) | (c3h >>> 31)); dh = c1h ^ ((c3h << 1) | (c3l >>> 31));
    s[4] ^= dl; s[5] ^= dh; s[14] ^= dl; s[15] ^= dh; s[24] ^= dl; s[25] ^= dh; s[34] ^= dl; s[35] ^= dh; s[44] ^= dl; s[45] ^= dh;
    dl = c2l ^ ((c4l << 1) | (c4h >>> 31)); dh = c2h ^ ((c4h << 1) | (c4l >>> 31));
    s[6] ^= dl; s[7] ^= dh; s[16] ^= dl; s[17] ^= dh; s[26] ^= dl; s[27] ^= dh; s[36] ^= dl; s[37] ^= dh; s[46] ^= dl; s[47] ^= dh;
    dl = c3l ^ ((c0l << 1) | (c0h >>> 31)); dh = c3h ^ ((c0h << 1) | (c0l >>> 31));
    s[8] ^= dl; s[9] ^= dh; s[18] ^= dl; s[19] ^= dh; s[28] ^= dl; s[29] ^= dh; s[38] ^= dl; s[39] ^= dh; s[48] ^= dl; s[49] ^= dh;

    // rho + pi（由 piln/rotc 表展开）
    b[0] = s[0]; b[1] = s[1];
    b[20] = (s[2] << 1) | (s[3] >>> 31); b[21] = (s[3] << 1) | (s[2] >>> 31);
    b[14] = (s[20] << 3) | (s[21] >>> 29); b[15] = (s[21] << 3) | (s[20] >>> 29);
    b[22] = (s[14] << 6) | (s[15] >>> 26); b[23] = (s[15] << 6) | (s[14] >>> 26);
    b[34] = (s[22] << 10) | (s[23] >>> 22); b[35] = (s[23] << 10) | (s[22] >>> 22);
    b[36] = (s[34] << 15) | (s[35] >>> 17); b[37] = (s[35] << 15) | (s[34] >>> 17);
    b[6] = (s[36] << 21) | (s[37] >>> 11); b[7] = (s[37] << 21) | (s[36] >>> 11);
    b[10] = (s[6] << 28) | (s[7] >>> 4); b[11] = (s[7] << 28) | (s[6] >>> 4);
    b[32] = (s[11] << 4) | (s[10] >>> 28); b[33] = (s[10] << 4) | (s[11] >>> 28);
    b[16] = (s[33] << 13) | (s[32] >>> 19); b[17] = (s[32] << 13) | (s[33] >>> 19);
    b[42] = (s[17] << 23) | (s[16] >>> 9); b[43] = (s[16] << 23) | (s[17] >>> 9);
    b[48] = (s[42] << 2) | (s[43] >>> 30); b[49] = (s[43] << 2) | (s[42] >>> 30);
    b[8] = (s[48] << 14) | (s[49] >>> 18); b[9] = (s[49] << 14) | (s[48] >>> 18);
    b[30] = (s[8] << 27) | (s[9] >>> 5); b[31] = (s[9] << 27) | (s[8] >>> 5);
    b[46] = (s[31] << 9) | (s[30] >>> 23); b[47] = (s[30] << 9) | (s[31] >>> 23);
    b[38] = (s[47] << 24) | (s[46] >>> 8); b[39] = (s[46] << 24) | (s[47] >>> 8);
    b[26] = (s[38] << 8) | (s[39] >>> 24); b[27] = (s[39] << 8) | (s[38] >>> 24);
    b[24] = (s[26] << 25) | (s[27] >>> 7); b[25] = (s[27] << 25) | (s[26] >>> 7);
    b[4] = (s[25] << 11) | (s[24] >>> 21); b[5] = (s[24] << 11) | (s[25] >>> 21);
    b[40] = (s[5] << 30) | (s[4] >>> 2); b[41] = (s[4] << 30) | (s[5] >>> 2);
    b[28] = (s[40] << 18) | (s[41] >>> 14); b[29] = (s[41] << 18) | (s[40] >>> 14);
    b[44] = (s[29] << 7) | (s[28] >>> 25); b[45] = (s[28] << 7) | (s[29] >>> 25);
    b[18] = (s[45] << 29) | (s[44] >>> 3); b[19] = (s[44] << 29) | (s[45] >>> 3);
    b[12] = (s[18] << 20) | (s[19] >>> 12); b[13] = (s[19] << 20) | (s[18] >>> 12);
    b[2] = (s[13] << 12) | (s[12] >>> 20); b[3] = (s[12] << 12) | (s[13] >>> 20);

    // chi
    for (let i = 0; i < 50; i += 10) {
      const b0 = b[i], b1 = b[i + 1], b2 = b[i + 2], b3 = b[i + 3], b4 = b[i + 4];
      const b5 = b[i + 5], b6 = b[i + 6], b7 = b[i + 7], b8 = b[i + 8], b9 = b[i + 9];
      s[i] = b0 ^ (~b2 & b4); s[i + 1] = b1 ^ (~b3 & b5);
      s[i + 2] = b2 ^ (~b4 & b6); s[i + 3] = b3 ^ (~b5 & b7);
      s[i + 4] = b4 ^ (~b6 & b8); s[i + 5] = b5 ^ (~b7 & b9);
      s[i + 6] = b6 ^ (~b8 & b0); s[i + 7] = b7 ^ (~b9 & b1);
      s[i + 8] = b8 ^ (~b0 & b2); s[i + 9] = b9 ^ (~b1 & b3);
    }

    // iota
    s[0] ^= RC_LO[r]; s[1] ^= RC_HI[r];
  }
}

/** 预置好 padding 的初始状态模板（rate = 136 字节，输入固定 64 字节）。 */
const template = new Int32Array(50);
template[16] = 0x01;             // pad10*1 的第 64 字节
template[33] = 0x80000000 | 0;   // pad10*1 的第 135 字节

/** 把 64 字节输入读成 16 个小端 32 位字。 */
export function wordsOf64(input: Uint8Array, out: Int32Array): void {
  if (input.length !== 64) throw new Error("keccak64: 输入必须正好 64 字节");
  const dv = new DataView(input.buffer, input.byteOffset, 64);
  for (let i = 0; i < 16; i++) out[i] = dv.getInt32(i * 4, true);
}

function hex8(v: number): string {
  return (v & 0xff).toString(16).padStart(2, "0")
    + ((v >>> 8) & 0xff).toString(16).padStart(2, "0")
    + ((v >>> 16) & 0xff).toString(16).padStart(2, "0")
    + ((v >>> 24) & 0xff).toString(16).padStart(2, "0");
}

/** 定长 64 字节 keccak256，返回 0x 前缀的 66 字符小写哈希。 */
export function keccak256_64(input: Uint8Array): string {
  const w = new Int32Array(16);
  wordsOf64(input, w);
  s.set(template);
  for (let i = 0; i < 16; i++) s[i] = w[i] ^ template[i];
  permute();
  let out = "0x";
  for (let i = 0; i < 8; i++) out += hex8(s[i]);
  return out;
}

function bitLength(x: bigint): number {
  if (x <= 0n) throw new Error("target 必须大于 0");
  return x.toString(2).length;
}

/**
 * 预筛掩码：摘要（大端解释成 uint256）前 zeroBits 位必须为 0。
 * 摘要第 k 字节 = (s[k >> 2] >>> (8 * (k & 3))) & 0xff（状态是小端存的）。
 */
function maskFor(zeroBits: number): { m0: number; m1: number } {
  let m0 = 0, m1 = 0;
  const full = zeroBits >> 3, rem = zeroBits & 7;
  const put = (k: number, byteMask: number): void => {
    const shifted = (byteMask << (8 * (k & 3))) | 0;
    if ((k >> 2) === 0) m0 |= shifted;
    else if ((k >> 2) === 1) m1 |= shifted;
    else throw new Error("target 过小：本实现只做前 64 位预筛（这个难度在 JS 里本来也算不出来）");
  };
  for (let k = 0; k < full; k++) put(k, 0xff);
  if (rem > 0) put(full, (0xff << (8 - rem)) & 0xff);
  return { m0, m1 };
}

export interface SolveResult {
  nonce: bigint;
  ms: number;
  hashes: number;
}

const MASK256 = (1n << 256n) - 1n;

function nonceBytes(nonce: bigint, buf: Uint8Array): void {
  const hx = nonce.toString(16).padStart(64, "0");
  for (let k = 0; k < 32; k++) buf[32 + k] = parseInt(hx.slice(k * 2, k * 2 + 2), 16);
}

/**
 * 求解 uint256(keccak256(abi.encode(seed, nonce))) < target。
 * 同步、单线程、可被墙钟预算打断：预算用完返回 null，由调用方决定是否 reissueChallenge。
 */
export function solveNonce(
  seed32: Uint8Array,
  target: bigint,
  budgetMs: number,
  startNonce: bigint,
  shouldStop?: () => boolean,
): SolveResult | null {
  return solveNonceWithStats(seed32, target, budgetMs, startNonce, shouldStop).result;
}

/** 和 solveNonce 一样，但没出解时也报出算了多少次（基准测试与诊断用）。 */
export function solveNonceWithStats(
  seed32: Uint8Array,
  target: bigint,
  budgetMs: number,
  startNonce: bigint,
  /** 每 2048 次哈希问一次「还要不要算」。多核池子靠它在别人出解后立刻停手。 */
  shouldStop?: () => boolean,
): { result: SolveResult | null; hashes: number; ms: number } {
  if (seed32.length !== 32) throw new Error("seed 必须是 32 字节");
  const zeroBits = 256 - bitLength(target);
  const { m0, m1 } = maskFor(zeroBits);

  // abi.encode(bytes32 seed, uint256 nonce)：前 32 字节种子，后 32 字节大端 nonce。
  const buf = new Uint8Array(64);
  buf.set(seed32, 0);
  const base = new Int32Array(16);

  const t0 = Date.now();
  let hashes = 0;
  let nonce = startNonce & MASK256;
  let counter = Number(nonce & 0xffffffffn) | 0;
  const rebase = (): void => {
    nonceBytes(nonce & ~0xffffffffn, buf);
    wordsOf64(buf, base);
  };
  rebase();

  const CHECK_EVERY = 2048;
  for (;;) {
    for (let i = 0; i < CHECK_EVERY; i++) {
      s.set(template);
      s[0] = base[0]; s[1] = base[1]; s[2] = base[2]; s[3] = base[3];
      s[4] = base[4]; s[5] = base[5]; s[6] = base[6]; s[7] = base[7];
      s[8] = base[8]; s[9] = base[9]; s[10] = base[10]; s[11] = base[11];
      s[12] = base[12]; s[13] = base[13]; s[14] = base[14];
      // nonce 的低 32 位落在字节 60..63（大端），对应小端第 15 个字要做字节翻转。
      s[15] = ((counter & 0xff) << 24) | (((counter >>> 8) & 0xff) << 16)
        | (((counter >>> 16) & 0xff) << 8) | ((counter >>> 24) & 0xff);
      permute();
      hashes++;
      if ((s[0] & m0) === 0 && (s[1] & m1) === 0) {
        const cand = (nonce & ~0xffffffffn) | BigInt(counter >>> 0);
        // 预筛只是必要条件，命中后用完整摘要做一次精确比较。
        const probe = new Uint8Array(64);
        probe.set(seed32, 0);
        nonceBytes(cand, probe);
        if (BigInt(keccak256_64(probe)) < target) {
          const ms = Date.now() - t0;
          return { result: { nonce: cand, ms, hashes }, hashes, ms };
        }
      }
      counter = (counter + 1) | 0;
      if ((counter >>> 0) === 0) {
        nonce = (nonce + 0x100000000n) & MASK256;
        rebase();
      }
    }
    if (budgetMs > 0 && Date.now() - t0 >= budgetMs) {
      return { result: null, hashes, ms: Date.now() - t0 };
    }
    if (shouldStop !== undefined && shouldStop()) {
      return { result: null, hashes, ms: Date.now() - t0 };
    }
  }
}
