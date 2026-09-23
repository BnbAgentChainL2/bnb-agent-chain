// 环境变量读取。**私钥只按变量名读，读完立刻注册进日志擦除表，永不打印、永不落盘。**
// 变量名见 .env.example（那里只有名字，没有值）。
//
// 两条不肯给默认值的规则，理由都写在下面：
//   1. `WATCHDOG_ARMED` 必须显式写 true 或 false。给它任何默认值都是错的：默认 false
//      会让运维以为桥有刹车而其实没有，默认 true 会让一次演练直接暂停主网的 collect。
//   2. `BSC_RPC` 与 `BSC_RPC_2` 必须是两个**不同**的端点。跳闸前的复核读就是从第二个
//      端点发出去的；两个名字指向同一台机器时，复核只是把同一个错误读了两遍。

import { getAddress } from 'ethers';
import { DEFAULT_POLL_MS, DEFAULT_SLOW_POLL_MS } from './constants.mjs';
import { registerSecret } from './log.mjs';

function req(env, name) {
  const v = env[name];
  if (!v || v === '0x' || String(v).trim() === '') throw new Error(`缺少环境变量 ${name}（值留空或为 0x）`);
  return String(v).trim();
}

function opt(env, name, fallback = null) {
  const v = env[name];
  if (v === undefined || v === null || String(v).trim() === '' || v === '0x') return fallback;
  return String(v).trim();
}

function addr(env, name, fallback) {
  const v = opt(env, name, fallback);
  if (!v) throw new Error(`缺少地址环境变量 ${name}`);
  return getAddress(v);
}

function addrOpt(env, name, fallback = null) {
  const v = opt(env, name, fallback);
  return v ? getAddress(v) : null;
}

function addrList(env, name, fallback) {
  const raw = opt(env, name);
  if (!raw) return fallback ? [getAddress(fallback)] : [];
  const out = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (t === '') continue;
    const a = getAddress(t);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

function num(env, name, fallback) {
  const v = opt(env, name);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${name} 不是数字`);
  return n;
}

function big(env, name, fallback) {
  const v = opt(env, name);
  if (v === null) return fallback;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`环境变量 ${name} 不是整数`);
  }
}

function bool(env, name) {
  const v = opt(env, name);
  if (v === null) return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`环境变量 ${name} 只能是 true 或 false，读到的是 ${JSON.stringify(v)}`);
}

/**
 * 从 process.env（或测试传进来的对象）读出全部配置。
 * @param {Record<string,string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const key = req(env, 'WATCHDOG_PRIVATE_KEY');
  registerSecret(key);
  // 模拟报告 §3.3 B6：只有在 120 秒内 veto 才是零损失。veto 权现在归 admin / vetoKey，
  // 合约没给看门狗。运维如果按报告的建议把 vetoKey 交给这个进程，就填这一项；
  // 留空时看门狗只会 pause()，README 与运维手册必须照实说「那不是零损失」。
  const vetoKey = opt(env, 'WATCHDOG_VETO_PRIVATE_KEY');
  if (vetoKey) registerSecret(vetoKey);

  const armed = bool(env, 'WATCHDOG_ARMED');
  if (armed === null) {
    throw new Error(
      'WATCHDOG_ARMED 必须显式写 true 或 false：true = 真的会发 pause() 交易，false = 只告警不上链（演练用）',
    );
  }

  const cfg = {
    armed,
    rpc: {
      bsc: req(env, 'BSC_RPC'),
      bsc2: req(env, 'BSC_RPC_2'),
      layer: req(env, 'LAYER_RPC'),
      // 层内只有一台官方节点（信任表第一行）。填不了第二个端点时，层侧的复核读退化成
      // 「隔 confirmDelayMs 再读同一台」—— 它只能排除瞬时读取错误，排除不了节点本身说谎。
      layer2: opt(env, 'LAYER_RPC_2'),
    },
    dbPath: req(env, 'WATCHDOG_DB'),
    addresses: {
      bacBridge: addr(env, 'BAC_BRIDGE'),
      chainAnchor: addr(env, 'CHAIN_ANCHOR'),
      bacToken: addr(env, 'BAC_TOKEN'),
      l2Bridge: addr(env, 'L2_BRIDGE', '0x0000000000000000000000000000000000000101'),
      feeSink: addr(env, 'FEE_SINK', '0x000000000000000000000000000000000000dEaD'),
      feeSplitter: addr(env, 'FEE_SPLITTER', '0x0000000000000000000000000000000000000104'),
      layerSigner: addr(env, 'LAYER_SIGNER_ADDRESS', env.CLIQUE_SIGNER),
      flapPortal: addrOpt(env, 'FLAP_VAULT_PORTAL'),
      pancakeRouter: addrOpt(env, 'PANCAKE_ROUTER', '0x10ED43C718714eb63d5aA57B78B54704E256024E'),
    },
    validators: addrList(env, 'LAYER_VALIDATORS', addr(env, 'LAYER_SIGNER_ADDRESS', env.CLIQUE_SIGNER)),
    start: {
      bscBlock: num(env, 'BSC_START_BLOCK', null),
      layerBlock: num(env, 'LAYER_START_BLOCK', null),
    },
    poll: {
      // 快轮询只服务 ANCHOR_ROOT：它是唯一有 120 秒窗口的规则。
      fastMs: num(env, 'WATCHDOG_POLL_MS', DEFAULT_POLL_MS),
      slowMs: num(env, 'WATCHDOG_SLOW_POLL_MS', DEFAULT_SLOW_POLL_MS),
      bscLogRange: num(env, 'BSC_LOG_RANGE', 3000),
      layerLogRange: num(env, 'LAYER_LOG_RANGE', 5000),
      /** 复核读之间的最小间隔（毫秒）。太短等于没换区块，太长吃掉 120 秒预算 */
      confirmDelayMs: num(env, 'WATCHDOG_CONFIRM_DELAY_MS', 1500),
      /**
       * 慢规则读到 head 往回退多少个 BSC 块。BSC 偶尔会重组一两个块，影子账本吃进一条
       * 被重组掉的事件就会在下一轮制造一条假的「桶对不上」。慢规则没有 120 秒窗口，
       * 退 15 块（约 45 秒）换掉这个误报源是划算的。**快规则（锚点）不退块**，
       * 它靠第二个 RPC 的复核读来排除重组。
       */
      slowDepth: num(env, 'WATCHDOG_SLOW_DEPTH', 15),
      /** 滚动释放率窗口，秒 */
      rollingWindowSec: num(env, 'WATCHDOG_ROLLING_WINDOW_SEC', 86400),
    },
    tolerance: {
      /** 释放率：每纪元 pot 与我们自己影子账本算出来的上限之间允许的 bps 偏差 */
      releaseBps: big(env, 'WATCHDOG_RELEASE_TOLERANCE_BPS', 50n),
      /** 回购滑点：合约自己的上限之外再放宽这么多 bps（我们的参考价读在另一个区块上） */
      slippageBps: big(env, 'WATCHDOG_SLIPPAGE_TOLERANCE_BPS', 100n),
      /** 对账 diff 的绝对容差，wei。层内 gas 计量是精确的，这里只吸收读数跨块的抖动 */
      reconcileWei: big(env, 'WATCHDOG_RECONCILE_TOLERANCE_WEI', 0n),
      /** 在途存款的扫描深度（BSC 区块数）。默认 1200 块 ≈ 1 小时，远大于入场的 ~1 分钟 */
      inflightBlocks: num(env, 'WATCHDOG_INFLIGHT_BLOCKS', 1200),
      /** 桶余额：代币真实余额允许比账面**多**多少（多出来的由 sweepUntrackedBac 收编，不是问题） */
      bucketSurplusOk: true,
    },
    notify: {
      url: opt(env, 'WATCHDOG_WEBHOOK_URL'),
      /** json = 原样 POST 结构化告警；text = POST {"text": "..."}（Slack / 飞书 / 企业微信都吃这个形状） */
      format: opt(env, 'WATCHDOG_WEBHOOK_FORMAT', 'json'),
      timeoutMs: num(env, 'WATCHDOG_WEBHOOK_TIMEOUT_MS', 5000),
      retries: num(env, 'WATCHDOG_WEBHOOK_RETRIES', 2),
    },
    keys: { watchdog: key, veto: vetoKey },
  };

  if (cfg.rpc.bsc === cfg.rpc.bsc2) {
    throw new Error('BSC_RPC 与 BSC_RPC_2 必须是两个**独立**的端点：跳闸前的复核读走第二个端点');
  }
  if (!['json', 'text'].includes(cfg.notify.format)) {
    throw new Error('WATCHDOG_WEBHOOK_FORMAT 只能是 json 或 text');
  }
  if (cfg.poll.fastMs > 10000) {
    // 模拟报告 §3.3 的工程指标：轮询间隔 ≤ 10 s。超了就不是「常驻自动 watchdog」了。
    throw new Error(`WATCHDOG_POLL_MS=${cfg.poll.fastMs} 超过 10000：探测延迟预算要求轮询间隔 ≤ 10 秒`);
  }
  return cfg;
}

/**
 * 打日志用的安全视图：**不含任何私钥**，而且里面的 bigint 已经转成十进制字符串 ——
 * 运维脚本会直接 `JSON.stringify` 它，而 JSON 不认识 bigint。
 */
export function redactedConfig(cfg) {
  const plain = (v) => {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = plain(x);
      return out;
    }
    return v;
  };
  return plain({
    armed: cfg.armed,
    rpc: cfg.rpc,
    dbPath: cfg.dbPath,
    addresses: cfg.addresses,
    validators: cfg.validators,
    start: cfg.start,
    poll: cfg.poll,
    tolerance: cfg.tolerance,
    notify: { ...cfg.notify, url: cfg.notify.url ? '[SET]' : null },
    keys: { watchdog: '[REDACTED]', veto: cfg.keys.veto ? '[REDACTED]' : null },
  });
}
