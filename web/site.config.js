/* BNB Agent Chain · 站点配置（同步加载，必须排在 vendor/ethers 与 js/data/* 之前）
   v2（决策 #29 / #30 / #31）：没有 factory / vault / registry / vaultPortal 了。
   税收先被 Flap 抽走 10% 协议费，剩下的进 BacTaxRouter（router），它按 50/50 推给 BacBridge 与 BacNodeFund。
   发射前 BSC 侧所有合约地址都是 "0x0"：数据层（js/data/bac-core.js）判定合约没配，
   页面上每一个 BSC 侧的数字都显示「发射后公布」，不许出现任何演示值。
   合约部署当天只改 addresses 里的地址（+ deployBlock），然后重新部署网站。
   artifacts/data-check/site.config.proposed.js 是数据层负责人拟换上的下一版（含已锁定的代币地址），换不换由他定。 */
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
  // 索引器读不到时，层内的块与交易由 js/data/bac-layer.js 直接读 layerRpc / fallbackRpc，
  // 照样是真数据 —— 「发射后公布」只留给 BSC 侧那些还不存在的合约。
  indexerBase: 'https://bnbagentchain-rpc.xyz',
  // 现在出块的是演练链（HANDOFF §2）：创世预置测试 BAC、发射时用新创世重建。正式链上线那天改成 false。
  rehearsal: true,

  /* ── 层内直读的节奏（链 3 秒一块，不许比它更快）───────── */
  layerPollMs: 6000,          // 索引器不在时：本站直接读 RPC 的轮询间隔
  layerIdlePollMs: 60000,     // 索引器在正常供数时：只慢速探活，不抢它的活
  layerHiddenPollMs: 60000,   // 标签页切到后台：退到慢档
  layerTimeoutMs: 8000,

  /* ── 合约地址（部署后填）────────────────────────────── */
  addresses: {
    token: '0x0',     // BAC（Flap Tax Token V3）
    router: '0x0',    // BacTaxRouter（Flap 的 beneficiary，税收 BNB 的落点，50/50 推给桥与节点基金；无 owner、不可升级）
    bridge: '0x0',    // BacBridge 的 ERC1967 代理地址（不是实现合约地址）：可升级，owner 可紧急提取全部桥池（决策 #29）
    nodeFund: '0x0',  // BacNodeFund（官方节点基金，owner 可提）
    anchor: '0x0',    // ChainAnchor
    staking: '0x0'    // ValidatorStaking
  },
  // 上面这批合约部署所在的 BSC 块号；0 = 不知道
  deployBlock: 0,

  // BNB Chain / Flap 的主网常量（不是我们的合约；不写也行，数据层默认就是这两个）
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', // ERC-8004 身份注册表（决策 #31）
  flapPortal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',       // Flap Portal（决策 #30）

  /* ── 站点链接（发射后填）────────────────────────────── */
  flapUrl: '',
  x: 'https://x.com/Bnbagentchain',
  github: 'https://github.com/BnbAgentChainL2/bnb-agent-chain',
  siteUrl: 'https://bnbagentchain-scan.com'
}, window.BAC_CONFIG || {});
