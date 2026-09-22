// 创世哈希门禁。start 必须过这一关，**没有跳过开关**。
//
// 两层：
//   1) 启动前（离线）：本地 config/genesis.json 的 sha256 必须等于 init 时记下的那个。
//      防的是「文件被换掉/被编辑过」而你没发现。
//   2) 启动后（权威）：本地节点报的 0 号区块哈希必须等于公布的 genesisHash。
//      不一致 = 你在另一条链上，程序把容器停回去并退出 1。
//
// 为什么不肯自己从 genesis.json 算区块哈希：QBFT 的 extraData 是 RLP 结构，
// 再加上 cancun 的 header 字段，自己算错一次就会拒绝一个本来好好的节点。
// 让节点自己算、我们只比对，是唯一不会误伤的做法。

import { createHash } from 'node:crypto';
import { BacError, isHash32 } from './util.mjs';
import { GENESIS_SOURCES } from './constants.mjs';

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function whereToVerify() {
  return ['创世哈希的核对出处（三处必须逐字相同）：', ...GENESIS_SOURCES.map((s) => '  - ' + s)].join('\n');
}

/**
 * 启动前的文件检查。
 * @param {{recordedSha256:string, actualText:string|null}} p
 */
export function checkGenesisFile({ recordedSha256, actualText }) {
  if (actualText === null || actualText === undefined) {
    return { ok: false, zh: 'config/genesis.json 不存在：拒绝启动。先跑 bac-node init' };
  }
  const actual = sha256Hex(actualText);
  if (!recordedSha256) {
    return { ok: false, zh: '配置里没有记录 genesis.json 的 sha256：拒绝启动。先跑 bac-node init' };
  }
  if (actual !== recordedSha256.toLowerCase()) {
    return {
      ok: false,
      zh: `本地 config/genesis.json 的 sha256 是 ${actual}，`
        + `配置里记的是 ${recordedSha256}。文件被改过或被换过，拒绝启动。\n${whereToVerify()}`,
    };
  }
  return { ok: true, zh: `genesis.json sha256 ${actual} 与记录一致` };
}

/**
 * 启动后的链上检查。
 * @param {{expected:string, actual:string|null}} p
 */
export function checkGenesisChain({ expected, actual }) {
  if (!isHash32(expected)) {
    return { ok: false, zh: `配置里的 genesisHash 不是 32 字节哈希：${expected}。拒绝运行。\n${whereToVerify()}` };
  }
  if (!actual) {
    return { ok: false, zh: '读不到本地节点的 0 号区块：还没起来，或者 RPC 不通。拒绝继续' };
  }
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    return {
      ok: false,
      zh: `本地节点的创世哈希 ${actual} 与公布的 ${expected} 不一致 —— 你连的不是这条链，已停止。\n`
        + `${whereToVerify()}`,
    };
  }
  return { ok: true, zh: `创世哈希 ${actual} 与公布值一致` };
}
