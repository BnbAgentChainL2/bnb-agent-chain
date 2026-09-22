// 每纪元的见证记录：salt + 三元组。
// salt 是承诺-揭示的全部秘密：**在揭示之前泄露它，别人就能提前知道你会报什么**，
// 所以文件权限 0600，日志里永不打印 salt 本身（只打印承诺哈希，那是链上公开的）。
// 丢了 salt = 这一纪元无法揭示（拿不到奖励），但不会损失本金，也不会吃 strike —— 除非你乱猜一个去试。

import fs from 'node:fs';
import path from 'node:path';
import { keccak256, AbiCoder, getAddress } from 'ethers';
import { BacError, isHash32 } from './util.mjs';

const coder = AbiCoder.defaultAbiCoder();
export const RECORD_SCHEMA = 'bac/attestation-record/1';

/**
 * commitment = keccak256(abi.encode(epoch, exitRoot, l2BlockHash, l2Block, salt, msg.sender))
 * 类型逐字对应 ValidatorStaking.commitAttestation 的参数表（01 §7）。
 */
export function commitmentHash({ epoch, exitRoot, l2BlockHash, l2Block, salt, validator }) {
  if (!isHash32(exitRoot)) throw new BacError('exitRoot 不是 32 字节哈希', 'bad_arg');
  if (!isHash32(l2BlockHash)) throw new BacError('l2BlockHash 不是 32 字节哈希', 'bad_arg');
  if (!isHash32(salt)) throw new BacError('salt 不是 32 字节', 'bad_arg');
  return keccak256(coder.encode(
    ['uint64', 'bytes32', 'bytes32', 'uint64', 'bytes32', 'address'],
    [BigInt(epoch), exitRoot, l2BlockHash, BigInt(l2Block), salt, getAddress(validator)]
  ));
}

export class SaltStore {
  constructor(dir, { fsImpl = fs, randomBytes } = {}) {
    this.dir = dir;
    this.fs = fsImpl;
    this.randomBytes = randomBytes || ((n) => {
      const b = new Uint8Array(n);
      globalThis.crypto.getRandomValues(b);
      return b;
    });
  }

  file(epoch) { return path.join(this.dir, `epoch-${Number(epoch)}.json`); }

  newSalt() {
    return '0x' + Array.from(this.randomBytes(32)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  read(epoch) {
    try {
      const raw = this.fs.readFileSync(this.file(epoch), 'utf8');
      const rec = JSON.parse(raw);
      if (rec.schema !== RECORD_SCHEMA) throw new BacError(`见证记录 schema 不认识：${rec.schema}`, 'bad_record');
      return rec;
    } catch (e) {
      if (e instanceof BacError) throw e;
      return null;
    }
  }

  write(rec) {
    this.fs.mkdirSync(this.dir, { recursive: true });
    const p = this.file(rec.epoch);
    this.fs.writeFileSync(p, JSON.stringify({ schema: RECORD_SCHEMA, ...rec }, null, 2) + '\n', { mode: 0o600 });
    try { this.fs.chmodSync(p, 0o600); } catch { /* Windows 上没有 posix 权限，忽略 */ }
    return p;
  }

  list() {
    let names = [];
    try { names = this.fs.readdirSync(this.dir); } catch { return []; }
    return names
      .map((n) => /^epoch-(\d+)\.json$/.exec(n))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }
}
