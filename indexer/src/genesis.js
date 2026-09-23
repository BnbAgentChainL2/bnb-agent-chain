// src/genesis.js —— 从创世文件里读出「层内的币一开始在谁手上」，给 /api/health 的对账用。
//
// 为什么需要它（2026-09-23 线上实测）：
//   对账公式原来假设创世时 1e27 全部在 L2Bridge 里、任何别的地址一分钱都没有。
//   演练链的创世根本不是这样 —— 它只有一个预置账户 0x7099…79C8（Hardhat 公开测试私钥，任何人都能用），
//   L2Bridge 没有预置余额。于是 layerCirculating 被算成 ≈1e27，diff 恒为 −1e27，ok 永远是 false。
//   正式链的创世也不是「全在桥里」：中继有一笔 1,000 BAC 的运营浮存（chain/build-genesis.sh 的 operatorFloat）。
//
// 修法是把「创世时不在 L2Bridge 里的那部分余额」作为一个**公开的、单独列出的项**放进公式，
// 而不是把它藏进某个常量里：
//   genesisSupply  = Σ 创世 alloc 的全部余额           （layerCirculating 的起点）
//   genesisAlloc   = Σ 创世 alloc 里 L2Bridge 以外的余额 （从来没有经过 BSC 桥的那部分）
// 这两个数、以及 genesisAlloc 由哪些地址组成，全部原样返回；任何人拿公开的 genesis.json 就能复核。
import { readFileSync, statSync } from "node:fs";
import { getAddress } from "ethers";
import { LAYER_SYSTEM_ADDRESSES, GENESIS_SUPPLY } from "./abi.js";

let cache = { key: null, value: null };

function toBig(v) {
  if (v === null || v === undefined || v === "") return 0n;
  const s = String(v).trim();
  // Besu / geth 都接受十六进制（0x…）与十进制两种写法
  return BigInt(s);
}

function normAddr(a) {
  const s = String(a).trim();
  return getAddress(s.startsWith("0x") || s.startsWith("0X") ? s : "0x" + s);
}

/**
 * 解析一个 genesis.json 对象。返回：
 *   { supply, bridgeAlloc, genesisAlloc, accounts: [{addr, balance}] }（金额全是十进制字符串）
 * accounts 只列 L2Bridge 以外、余额非零的地址，按余额从大到小。
 */
export function parseGenesisAlloc(genesis) {
  const alloc = (genesis && genesis.alloc) || {};
  const bridge = LAYER_SYSTEM_ADDRESSES.L2Bridge;
  let supply = 0n;
  let bridgeAlloc = 0n;
  const accounts = [];
  for (const [rawAddr, entry] of Object.entries(alloc)) {
    const a = normAddr(rawAddr);
    const bal = toBig(entry && entry.balance);
    supply += bal;
    if (a === bridge) bridgeAlloc += bal;
    else if (bal !== 0n) accounts.push({ addr: a, balance: bal });
  }
  accounts.sort((x, y) => (x.balance === y.balance ? (x.addr < y.addr ? -1 : 1) : x.balance > y.balance ? -1 : 1));
  const other = accounts.reduce((s, x) => s + x.balance, 0n);
  return {
    supply: supply.toString(),
    bridgeAlloc: bridgeAlloc.toString(),
    genesisAlloc: other.toString(),
    accounts: accounts.map((x) => ({ addr: x.addr, balance: x.balance.toString() })),
  };
}

/**
 * 读 cfg.genesisPath。文件没变就用缓存（按 mtime + size）。
 * 读不到 / 解析不了返回 null —— 调用方必须把「读不到」照实写出来，不许悄悄当成 0。
 */
export function readGenesisAlloc(path) {
  if (!path) return null;
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const key = `${path}:${st.mtimeMs}:${st.size}`;
  if (cache.key === key) return cache.value;
  let value = null;
  try {
    value = { ...parseGenesisAlloc(JSON.parse(readFileSync(path, "utf8"))), source: path };
  } catch {
    value = null;
  }
  cache = { key, value };
  return value;
}

/** 读不到创世文件时的退路：按设计值「1e27 全在 L2Bridge」算，genesisAlloc = 0，并且必须说明这是退路。 */
export function fallbackGenesis() {
  return {
    supply: GENESIS_SUPPLY.toString(),
    bridgeAlloc: GENESIS_SUPPLY.toString(),
    genesisAlloc: "0",
    accounts: [],
    source: null,
  };
}

export function resetGenesisCache() {
  cache = { key: null, value: null };
}
