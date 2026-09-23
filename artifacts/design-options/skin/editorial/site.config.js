/* BNB Agent Chain · 站点配置（同步加载，必须排在 vendor/ethers 与 js/data/* 之前）
   发射前所有合约地址都是 "0x0"：BAC.LIVE = isAddr(addresses.vault) 为 false，
   页面上每一个链上数字都显示「发射后公布」，不许出现任何演示值。
   发射当天只改这一个文件（写入 token / vault / 各合约地址 + flapUrl），然后重新部署。 */
window.BAC_CONFIG = Object.assign({
  /* ── BSC 侧 ─────────────────────────────────────────── */
  chainId: 56,
  chainName: 'BNB Smart Chain',
  // 读 eth_call / eth_getLogs 的公共 RPC。实测（docs/research/09-chain-truth.md）：
  // bsc-dataseed 对 eth_getLogs 一律 -32005，只能用于 eth_call；日志一律走 publicnode。
  rpcs: [
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed.bnbchain.org'
  ],
  logRpcs: ['https://bsc-rpc.publicnode.com'],
  explorer: 'https://bscscan.com',

  /* ── 层内（BNB Agent Chain）──────────────────────────── */
  layerChainId: 56777,
  layerRpc: 'https://bnbagentchain-rpc.xyz/rpc',
  // 域名失效/被劫持时的兜底：永久保留，任何人都能用它独立核对这条链
  fallbackRpc: 'https://95-179-183-132.sslip.io/rpc',
  fallbackApi: 'https://95-179-183-132.sslip.io',
  // 索引器 HTTP API（docs/03-INTERFACES.md §3）：历史、搜索、聚合从这里读。
  // 索引器还没部署时，层内的块与交易由 js/data/bac-layer.js 直接读 layerRpc / fallbackRpc，
  // 照样是真数据 —— 「发射后公布」只留给 BSC 侧那些还不存在的合约。
  indexerBase: 'https://bnbagentchain-rpc.xyz',

  /* ── 层内直读的节奏（链 3 秒一块，不许比它更快）───────── */
  layerPollMs: 6000,          // 索引器不在时：本站直接读 RPC 的轮询间隔
  layerIdlePollMs: 60000,     // 索引器在正常供数时：只慢速探活，不抢它的活
  layerHiddenPollMs: 60000,   // 标签页切到后台：退到慢档
  layerTimeoutMs: 8000,

  /* ── 合约地址（发射后填）────────────────────────────── */
  addresses: {
    factory: '0x0',   // BacVaultFactory
    vault: '0x0',     // BacTreasuryVault（税收 BNB 的落点，50/50 分账）
    token: '0x0',     // BAC（Flap Tax Token V3）
    bridge: '0x0',    // BacBridge
    nodeFund: '0x0',  // BacNodeFund（官方节点基金，owner 可提）
    registry: '0x0',  // AgentRegistry
    anchor: '0x0',    // ChainAnchor
    staking: '0x0'    // ValidatorStaking
  },

  // Flap 官方地址（主网常量，不是我们的合约）
  guardian: '0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b',
  vaultPortal: '0x90497450f2a706f1951b5bdda52B4E5d16f34C06',

  /* ── 站点链接（发射后填）────────────────────────────── */
  flapUrl: '',
  x: '',
  siteUrl: 'https://bnbagentchain-scan.com'
}, window.BAC_CONFIG || {});
