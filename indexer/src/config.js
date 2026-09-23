// src/config.js —— 全部配置来自环境变量，按名字读，绝不打印任何密钥。
// 本进程是只读索引器：它不需要任何私钥，.env.example 里也没有任何私钥名。
import { getAddress } from "ethers";

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

export function loadConfig(env = process.env) {
  const addresses = {
    AgentRegistry: addrOrNull(env.BAC_ADDR_REGISTRY),
    BacBridge: addrOrNull(env.BAC_ADDR_BRIDGE),
    ChainAnchor: addrOrNull(env.BAC_ADDR_ANCHOR),
    ValidatorStaking: addrOrNull(env.BAC_ADDR_STAKING),
    BacNodeFund: addrOrNull(env.BAC_ADDR_NODE_FUND),
    BacTreasuryVault: addrOrNull(env.BAC_ADDR_VAULT),
    BacVaultFactory: addrOrNull(env.BAC_ADDR_FACTORY),
    BacToken: addrOrNull(env.BAC_ADDR_TOKEN),
    TaxProcessor: addrOrNull(env.BAC_ADDR_TAX_PROCESSOR),
    FlapVaultPortal: addrOrNull(env.BAC_ADDR_FLAP_VAULT_PORTAL),
    // 层内创世地址是常量（02 §4.1），不从环境变量读。
  };

  return {
    dbPath: env.BAC_INDEXER_DB || "/home/ops/bac/data/indexer/index.db",
    relayerDbPath: env.BAC_RELAYER_DB || "/home/ops/bac/data/relayer/relayer.db",
    genesisPath: env.BAC_GENESIS_PATH || "/home/ops/bac/chain/genesis.json",

    layerRpc: env.BAC_LAYER_RPC || "http://geth:8545",
    layerChainId: intOr(env.BAC_LAYER_CHAIN_ID, 56777),
    bscRpc: env.BSC_RPC || "https://bsc-rpc.publicnode.com",
    // 第二个 BSC RPC 只用于 eth_call 兜底。**不能**用 bsc-dataseed 取日志：
    // 2026-09-22 实测它对 eth_getLogs 在任何跨度上都返回 -32005（03 §2 的索引作业纪律）。
    bscRpc2: env.BSC_RPC_2 || "https://bsc-dataseed.bnbchain.org",
    bscChainId: intOr(env.BSC_CHAIN_ID, 56),

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

    addresses,
  };
}

/** 地址簿：小写地址 -> 合约名，给 decodeLog 消歧用。层内三个创世地址永远在里面。 */
export function addressBook(cfg) {
  const book = {
    "0x0000000000000000000000000000000000000101": "L2Bridge",
    "0x0000000000000000000000000000000000000102": "L2Gate",
    "0x0000000000000000000000000000000000000103": "AgentBook",
  };
  for (const [name, a] of Object.entries(cfg.addresses || {})) {
    if (a) book[a.toLowerCase()] = name;
  }
  return book;
}
