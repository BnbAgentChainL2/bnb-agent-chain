// src/config.js —— 全部配置来自环境变量，按名字读，绝不打印任何密钥。
// 本进程是只读索引器：它不需要任何私钥，.env.example 里也没有任何私钥名。
import { getAddress } from "ethers";
import { BSC_BAC_TOKEN, BSC_FLAP_PORTAL, BSC_IDENTITY_REGISTRY, IFACES, CONTRACT_CHAIN } from "./abi.js";

function addrOrNull(v) {
  if (!v) return null;
  try {
    return getAddress(String(v).trim());
  } catch {
    return null;
  }
}

function intOr(v, d) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : d;
}

/** 决策 #30 / #31 删掉的合约。它们的环境变量如果还设着，说明服务器上的 .env 没跟上，/api/health 要喊出来。 */
export const LEGACY_ADDRESS_ENV = [
  "BAC_ADDR_REGISTRY",
  "BAC_ADDR_VAULT",
  "BAC_ADDR_FACTORY",
  "BAC_ADDR_FLAP_VAULT_PORTAL",
];

/** enode 只接受 enode://<128 位十六进制公钥>@<host>:<port>[?discport=n]，别的一律当没配。 */
export function enodeOrNull(v) {
  const s = String(v ?? "").trim();
  return /^enode:\/\/[0-9a-fA-F]{128}@[^\s@:]+:\d{1,5}(\?discport=\d{1,5})?$/.test(s) ? s : null;
}

export function loadConfig(env = process.env) {
  const bscChainId = intOr(env.BSC_CHAIN_ID, 56);
  // BSC 主网上的三个固定地址（决策 #31 / #30 / #35）只在 chainId = 56 时作默认值，别的链必须显式配置。
  const onBsc = bscChainId === 56;
  const addresses = {
    // 我们自己的合约（部署后填）。BacBridge 填**代理**地址，不是实现合约。
    BacBridge: addrOrNull(env.BAC_ADDR_BRIDGE),
    BacTaxRouter: addrOrNull(env.BAC_ADDR_ROUTER),
    ChainAnchor: addrOrNull(env.BAC_ADDR_ANCHOR),
    ValidatorStaking: addrOrNull(env.BAC_ADDR_STAKING),
    BacNodeFund: addrOrNull(env.BAC_ADDR_NODE_FUND),
    // 只读 view、不摄日志（abi.js 的 READ_ONLY_BSC）
    BacToken: addrOrNull(env.BAC_ADDR_TOKEN) ?? (onBsc ? BSC_BAC_TOKEN : null),
    TaxProcessor: addrOrNull(env.BAC_ADDR_TAX_PROCESSOR),
    FlapPortal: addrOrNull(env.BAC_ADDR_FLAP_PORTAL) ?? (onBsc ? BSC_FLAP_PORTAL : null),
    IdentityRegistry: addrOrNull(env.BAC_ADDR_IDENTITY_REGISTRY) ?? (onBsc ? BSC_IDENTITY_REGISTRY : null),
    // 层内创世地址是常量（02 §4.1），不从环境变量读。
  };

  return {
    dbPath: env.BAC_INDEXER_DB || "/home/ops/bac/data/indexer/index.db",
    relayerDbPath: env.BAC_RELAYER_DB || "/home/ops/bac/data/relayer/relayer.db",
    genesisPath: env.BAC_GENESIS_PATH || "/home/ops/bac/chain/genesis.json",

    layerRpc: env.BAC_LAYER_RPC || "http://geth:8545",
    layerChainId: intOr(env.BAC_LAYER_CHAIN_ID, 56777),
    // 官方节点的 enode（公开的 node.json 里那一条）。/api/health 的 layer.enode 原样返回它；
    // 格式不对就当没配（返回 null），不许把一个错的 enode 发出去让别人连不上。
    layerEnode: enodeOrNull(env.BAC_LAYER_ENODE),
    bscRpc: env.BSC_RPC || "https://bsc-rpc.publicnode.com",
    // 第二个 BSC RPC 只用于 eth_call 兜底。**不能**用 bsc-dataseed 取日志：
    // 2026-09-22 实测它对 eth_getLogs 在任何跨度上都返回 -32005（03 §2 的索引作业纪律）。
    bscRpc2: env.BSC_RPC_2 || "https://bsc-dataseed.bnbchain.org",
    bscChainId,

    // 起始块：BSC 从合约部署块起（backfill from genesis 的含义），层内从 0 起。
    bscStartBlock: intOr(env.BAC_BSC_START_BLOCK, 0),
    layerStartBlock: intOr(env.BAC_LAYER_START_BLOCK, 0),

    // 公共 BSC RPC 对 eth_getLogs 限窗。实测口径见 docs/research/09-chain-truth.md。
    bscLogRange: intOr(env.BAC_BSC_LOG_RANGE, 3000),
    bscLogRangeMax: intOr(env.BAC_BSC_LOG_RANGE_MAX, 5000),
    bscLogRangeMin: intOr(env.BAC_BSC_LOG_RANGE_MIN, 100),
    bscPollMs: intOr(env.BAC_BSC_POLL_MS, 15000),
    layerPollMs: intOr(env.BAC_LAYER_POLL_MS, 3000),
    // BSC 确认深度：这里只是索引器的展示口径，与中继的最终性规则（03 §1.2）无关。
    bscConfirmations: intOr(env.BAC_BSC_CONFIRMATIONS, 15),
    // eth_call 的可用状态窗口（02 §5.3 的 --bonsai-historical-block-limit）。
    ethCallStateWindowBlocks: intOr(env.BAC_ETH_CALL_STATE_WINDOW, 512),

    port: intOr(env.BAC_API_PORT, 8080),
    host: env.BAC_API_HOST || "0.0.0.0",
    // 限速：每 IP 每秒 20 次、每分钟 600 次（03 §3 开头）。
    ratePerSec: intOr(env.BAC_API_RATE_PER_SEC, 20),
    ratePerMin: intOr(env.BAC_API_RATE_PER_MIN, 600),
    apiBase: env.BAC_API_BASE || "https://bnbagentchain-rpc.xyz",
    // 决策 #19（03 §7.6）：每个返回体都带一个 detection 块，里面的 rulesUrl 指向「解码规则」说明页。
    // 那一页还不存在（03 的 [待定] 第 7 条），所以**默认返回 null**，前端退化成纯文字说明；
    // 页上线之后用 BAC_DETECTION_RULES_URL 配上去即可，代码不用动。
    detectionRulesUrl: env.BAC_DETECTION_RULES_URL || null,
    // 每个候选合约的 eth_call 预算上限（§7.1「探测必须便宜」）。
    probeMaxCalls: intOr(env.BAC_PROBE_MAX_CALLS, 16),

    // ERC-8004 身份读数：每轮快照最多读几个 agent、多久重读一次（秒）。
    identityBatch: intOr(env.BAC_IDENTITY_BATCH, 10),
    identityRefreshSec: intOr(env.BAC_IDENTITY_REFRESH_SEC, 3600),

    addresses,
    legacyEnvSet: LEGACY_ADDRESS_ENV.filter((k) => String(env[k] ?? "").trim() !== ""),
  };
}

/**
 * 地址簿：小写地址 -> 合约名，给 decodeLog 消歧用。层内三个创世地址永远在里面。
 * 只收**有事件 ABI** 的合约 —— 代币 / TaxProcessor / Portal / 身份注册表只读 view，不进地址簿。
 */
export function addressBook(cfg) {
  const book = {
    "0x0000000000000000000000000000000000000101": "L2Bridge",
    "0x0000000000000000000000000000000000000102": "L2Gate",
    "0x0000000000000000000000000000000000000103": "AgentBook",
  };
  for (const [name, a] of Object.entries(cfg.addresses || {})) {
    if (a && IFACES[name]) book[a.toLowerCase()] = name;
  }
  return book;
}

/** BSC 上要跑 eth_getLogs 的地址：只有我们自己的、有事件 ABI 的那几个合约。 */
export function bscLogAddresses(cfg) {
  return Object.entries(cfg.addresses || {})
    .filter(([name, a]) => !!a && CONTRACT_CHAIN[name] === "bsc")
    .map(([, a]) => a);
}
