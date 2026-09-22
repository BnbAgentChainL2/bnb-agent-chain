// 环境变量读取。**私钥只按变量名读，读完立刻注册进日志擦除表，永不打印、永不落盘。**
// 变量名与 02-CHAIN-SPEC.md §5 的 compose 段一致（LAYER_RPC / BSC_RPC / BSC_RPC_2 / DB_PATH /
// RELAYER_PRIVATE_KEY / RELAYER_LAYER_PRIVATE_KEY），其余见 .env.example。

import { getAddress } from 'ethers';
import { registerSecret } from './log.mjs';

function req(env, name) {
  const v = env[name];
  if (!v || v === '0x' || v.trim() === '') throw new Error(`缺少环境变量 ${name}（值留空或为 0x）`);
  return v.trim();
}

function addr(env, name, fallback) {
  const v = env[name] && env[name].trim() !== '' && env[name] !== '0x' ? env[name].trim() : fallback;
  if (!v) throw new Error(`缺少地址环境变量 ${name}`);
  return getAddress(v);
}

/** 逗号分隔的地址列表；留空时退回 fallback 一个地址。全部规范成 EIP-55。 */
function addrList(env, name, fallback) {
  const raw = env[name];
  if (!raw || String(raw).trim() === '') return fallback ? [getAddress(fallback)] : [];
  const out = [];
  for (const part of String(raw).split(',')) {
    const t = part.trim();
    if (t === '') continue;
    const a = getAddress(t);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

function num(env, name, fallback) {
  const v = env[name];
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${name} 不是数字`);
  return n;
}

/**
 * 从 process.env（或测试传进来的对象）读出全部配置。
 * @param {Record<string,string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const bscKey = req(env, 'RELAYER_PRIVATE_KEY');
  const layerKey = req(env, 'RELAYER_LAYER_PRIVATE_KEY');
  // 注册进擦除表之后，这两个值在本进程的任何日志里都只会显示 [REDACTED]。
  registerSecret(bscKey);
  registerSecret(layerKey);

  const cfg = {
    rpc: {
      bsc: req(env, 'BSC_RPC'),
      bsc2: req(env, 'BSC_RPC_2'),
      layer: req(env, 'LAYER_RPC'),
      layerFinality: env.LAYER_FINALITY ?? 'instant',
    },
    dbPath: req(env, 'DB_PATH'),
    addresses: {
      bacBridge: addr(env, 'BAC_BRIDGE'),
      agentRegistry: addr(env, 'AGENT_REGISTRY'),
      chainAnchor: addr(env, 'CHAIN_ANCHOR'),
      l2Bridge: addr(env, 'L2_BRIDGE', '0x0000000000000000000000000000000000000101'),
      l2Gate: addr(env, 'L2_GATE', '0x0000000000000000000000000000000000000102'),
      agentBook: addr(env, 'AGENT_BOOK', '0x0000000000000000000000000000000000000103'),
      feeSink: addr(env, 'FEE_SINK', '0x000000000000000000000000000000000000dEaD'),
      // 出块者 EOA：03 §3.1 的 howToCheck 里叫 CLIQUE_SIGNER（历史名字），
      // QBFT 下就是当届提案者的地址，小费进这里，必须与 FeeSink 分开读。
      layerSigner: addr(env, 'LAYER_SIGNER_ADDRESS', env.CLIQUE_SIGNER),
      // 决策 #17：gas 费分账合约。归集进来还没被领走的 gas 费停在它名下，
      // 对账公式里漏减它，diff 会从第一笔归集起恒为正（03 §3.1）。
      feeSplitter: addr(env, 'FEE_SPLITTER', '0x0000000000000000000000000000000000000104'),
    },
    // everValidator 累积表：QBFT 的验证者集可变，对账要按这张表逐个读余额（03 §1.3 / §3.1）。
    // 留空时退回只有官方出块者一个地址 —— 这是阶段 1 的真实情况。
    validators: addrList(env, 'LAYER_VALIDATORS', addr(env, 'LAYER_SIGNER_ADDRESS', env.CLIQUE_SIGNER)),
    start: {
      bscBlock: num(env, 'BSC_START_BLOCK', null),
      layerBlock: num(env, 'LAYER_START_BLOCK', null),
      firstEpoch: num(env, 'FIRST_EPOCH', null),
    },
    poll: {
      bscMs: num(env, 'BSC_POLL_MS', 15000),
      layerMs: num(env, 'LAYER_POLL_MS', 3000),
      bscLogRange: num(env, 'BSC_LOG_RANGE', 3000),
    },
    keys: { bsc: bscKey, layer: layerKey },
  };

  if (cfg.rpc.bsc === cfg.rpc.bsc2) {
    throw new Error('BSC_RPC 与 BSC_RPC_2 必须是两个**独立**的 RPC：一致的 finalized 是方向 A 的确认条件之一');
  }
  if (cfg.rpc.layerFinality !== 'instant') {
    throw new Error('LAYER_FINALITY 只能是 instant：层内是 QBFT 即时最终性，中继不做层侧重组处理');
  }
  return cfg;
}

/** 打日志用的安全视图：**不含任何私钥** */
export function redactedConfig(cfg) {
  return {
    rpc: cfg.rpc,
    dbPath: cfg.dbPath,
    addresses: cfg.addresses,
    validators: cfg.validators,
    start: cfg.start,
    poll: cfg.poll,
    keys: { bsc: '[REDACTED]', layer: '[REDACTED]' },
  };
}
