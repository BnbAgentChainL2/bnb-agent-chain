#!/usr/bin/env node
// tools/check-abi.mjs —— 边界检查：四个包里声明的 ABI 片段，必须在 contracts/src 里真的存在。
//
// 为什么要有它：relayer 的假链在测试里直接实现了 agentState()，所以
// `AgentRegistry.agentWallet(uint256)`（合约上根本没有这个函数）能一路通过全部单测，
// 只有在真链上才会 revert。这个脚本把「ABI 对不对得上合约」从人工检查变成一条命令。
//
// 用法：node tools/check-abi.mjs      （有不一致就退出码 1，并逐条打印）
// 离线：只读本地文件，不连任何网络。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 消费方的 ABI 文件。flap 的第三方接口不在检查范围内（它们不是我们的合约）。 */
const CONSUMERS = [
  'relayer/src/abi.mjs',
  'indexer/src/abi.js',
  'sdk/src/abi.ts',
  'node-cli/src/abi.mjs',
];

/** 第三方来源，合约仓库里没有也不算错。 */
const EXTERNAL_FUNCS = new Set([
  'allowance', 'balanceOf', 'decimals', 'approve', 'transfer', 'transferFrom',
  'totalSupply', 'symbol', 'name',
]);
const EXTERNAL_EVENTS = new Set(['FlapTaxVaultTokenCreated', 'Transfer', 'Approval']);

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f === 'flap') continue; // 第三方接口
      walk(p, out);
    } else if (f.endsWith('.sol')) out.push(p);
  }
  return out;
}

/** 合约侧：函数名（含 public 状态变量的自动 getter）与事件签名。 */
function readContracts() {
  const funcs = new Set();
  const events = new Map(); // name -> Set(签名)
  for (const f of walk(join(ROOT, 'contracts', 'src'))) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*/g, '');
    for (const m of src.matchAll(/\bfunction\s+(\w+)\s*\(/g)) funcs.add(m[1]);
    for (const m of src.matchAll(/\bpublic\b\s*(?:constant\s+|immutable\s+)?(\w+)\s*[;=]/g)) funcs.add(m[1]);
    for (const m of src.matchAll(/\bevent\s+(\w+)\s*\(([^;]*?)\)\s*;/gs)) {
      const types = m[2].split(',').map((a) => a.trim()).filter(Boolean).map((a) => a.split(/\s+/)[0]);
      if (!events.has(m[1])) events.set(m[1], new Set());
      events.get(m[1]).add(`${m[1]}(${types.join(',')})`);
    }
  }
  return { funcs, events };
}

function main() {
  const { funcs, events } = readContracts();
  const problems = [];
  for (const rel of CONSUMERS) {
    let src;
    try {
      src = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      problems.push(`[读不到] ${rel}`);
      continue;
    }
    for (const m of src.matchAll(/['"]function\s+(\w+)\(/g)) {
      const name = m[1];
      if (funcs.has(name) || EXTERNAL_FUNCS.has(name)) continue;
      problems.push(`[合约没有这个函数] ${rel}: ${name}(...)`);
    }
    for (const m of src.matchAll(/['"]event\s+(\w+)\(([^)]*)\)['"]/g)) {
      const name = m[1];
      if (EXTERNAL_EVENTS.has(name)) continue;
      const types = m[2].split(',').map((a) => a.trim()).filter(Boolean)
        .map((a) => a.split(/\s+/).filter((t) => t !== 'indexed')[0]);
      const sig = `${name}(${types.join(',')})`;
      if (!events.has(name)) { problems.push(`[合约没有这个事件] ${rel}: ${sig}`); continue; }
      if (!events.get(name).has(sig)) {
        problems.push(`[事件签名不一致] ${rel}: ${sig} vs 合约 ${[...events.get(name)].join(' / ')}`);
      }
    }
  }
  if (problems.length === 0) {
    console.log('ABI 边界检查通过：四个包声明的函数与事件，在 contracts/src 里都找得到。');
    return 0;
  }
  for (const p of problems) console.log(p);
  console.log(`\n共 ${problems.length} 条不一致。合约与规格不一致时以 docs/01-CONTRACT-SPEC.md 为准，并在 README 里记一条。`);
  return 1;
}

process.exit(main());
