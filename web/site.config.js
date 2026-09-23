/* BNB Agent Chain · 站点配置（同步加载，必须排在 vendor/ethers 与 js/data/* 之前）
   v2（决策 #29 / #30 / #31 / #35）：没有 factory / vault / registry / vaultPortal 了。
   BSC 侧分三个阶段，数据层自己用 eth_getCode 判断，不用改这个文件就会翻过来：
     (a) 只有代币地址（已由 lockSalt 锁定，地址上还没有代码）→ 合约和代币的数字都写「发射后公布」
     (b) router / bridge / nodeFund / anchor / staking 部署了 → 合约自己的状态（0 余额、owner、升级次数）照实显示，
         价格 / 税率 / 交易这些还不存在的数才写「发射后公布」
     (c) 代币发射（地址上有代码了）→ 开着的页面最迟 codeProbeMs（默认 2 分钟）内自动翻过来，不用重新部署网站
   部署合约当天只改 addresses 里那五个地址 + deployBlock；发射当天只填 flapUrl。 */
window.BAC_CONFIG = Object.assign({
  /* ── BSC 侧 ─────────────────────────────────────────── */
  chainId: 56,
  chainName: 'BNB Smart Chain',
  // 实测（docs/research/09-chain-truth.md + 2026-09-23 复测）：
  // eth_call / eth_getCode / eth_getStorageAt 走 bsc-dataseed（在前），publicnode 兜底；
  // bsc-dataseed 对 eth_getLogs 一律 -32005，日志只走 publicnode（它也只给最近约 6000 块，
  // 更早的报 "Archive requests require a personal token"，所以浏览器里的时间线只是最近一个窗口）。
  rpcs: [
    'https://bsc-dataseed.bnbchain.org',
    'https://bsc-rpc.publicnode.com'
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
  indexerBase: 'https://bnbagentchain-rpc.xyz',
  // 现在出块的是演练链（HANDOFF §2）：BSC 合约部署之后层内仍是演练链，直到用正式创世重建 —— 显式写死，
  // 不再按「合约地址配没配」去猜。正式链上线那天改成 false。
  rehearsal: true,

  /* ── 层内直读的节奏（链 3 秒一块，不许比它更快）───────── */
  layerPollMs: 6000,          // 索引器不在时：本站直接读 RPC 的轮询间隔
  layerIdlePollMs: 60000,     // 索引器在正常供数时：只慢速探活，不抢它的活
  layerHiddenPollMs: 60000,   // 标签页切到后台：退到慢档
  layerTimeoutMs: 8000,

  /* ── 合约地址 ───────────────────────────────────────── */
  addresses: {
    token: '0xA97452d175679B2bF5F25a9a382D22aff39b7777', // BAC（Flap Tax Token V3）· 决策 #35 已锁定，发射前地址上没有代码
    router: '0x63D213C8AAa4E1C758ea41f8ed35066181B8e818',    // BacTaxRouter（Flap beneficiary，税收 BNB 落点，50/50，无 owner）
    bridge: '0x2129f336ff42821afa27fE5928Dec36Ba90d3508',    // BacBridge 的 ERC1967 代理地址（不是实现合约地址）
    nodeFund: '0xBf92C03f2eD3b7aDFC4908019DF51a0401fC23Ff',  // BacNodeFund（官方节点基金，owner 可提）
    anchor: '0xe6cCCD4809905152588f31417408c4Af9043b406',    // ChainAnchor
    staking: '0xC0cdF18fb2aF4C5Ca34603B6D7C4E29005042943'    // ValidatorStaking
  },
  // 上面这批合约部署所在的 BSC 块号：填了之后，部署后约 40 分钟内打开的页面能看到从部署起的完整时间线；
  // 0 = 不知道（时间线只标「最近窗口」）。部署脚本的回执里有。
  deployBlock: 123558962,   // 决策 #39：BSC 部署区块（deployments/bsc-mainnet.json）

  // BNB Chain / Flap / PancakeSwap 的主网常量（不是我们的合约；不写也行，数据层默认就是这三个）
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', // ERC-8004 Identity Registry（决策 #31）
  flapPortal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',       // Flap Portal v5.24.0（决策 #30）
  // BacBridge.router()：毕业后回购走的 PancakeSwap V2 Router（DeployBac.s.sol 的 BAC_PANCAKE_ROUTER），不是 BacTaxRouter
  pancakeRouter: '0x10ED43C718714eb63d5aA57B78B54704E256024E',

  /* ── 站点链接（发射后填）────────────────────────────── */
  flapUrl: '',
  x: 'https://x.com/Bnbagentchain',
  github: 'https://github.com/BnbAgentChainL2/bnb-agent-chain',
  siteUrl: 'https://bnbagentchain-scan.com'
}, window.BAC_CONFIG || {});
