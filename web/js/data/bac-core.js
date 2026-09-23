/* BNB Agent Chain · 数据层 · 核心（配置 / 常量 / 格式化 / 事件总线 / 状态骨架）
   规矩（docs/research/04-website-conventions.md §1.1）：
   - js/data/* 是唯一碰链的代码，暴露 window.BAC，**里面没有任何 DOM 代码**；
   - 绑定层（js/ui/bind.js，不属于本轮）是 window.BAC 的唯一消费者；
   - 每一个数字都来自链上或索引器：发射前一律「发射后公布」，读取失败一律「读取失败 · 重试中」，
     永远不显示演示值。null 表示未知，不是 0。
   加载顺序：site.config.js → vendor/ethers-6.13.4.umd.min.js → bac-core.js → bac-chain.js → bac-api.js → bac-view.js
   缺依赖时：打印一条错误，什么都不做（不抛，不影响页面其它部分）。 */
(function (root) {
  'use strict';

  var BAC = root.BAC = root.BAC || {};
  if (BAC.core) return; // 重复加载保护

  /* ══════════════════════════════════════════════════════
     1. 常量
     ══════════════════════════════════════════════════════ */

  var ZERO = '0x0000000000000000000000000000000000000000';

  // 层内创世系统合约（docs/02-CHAIN-SPEC.md §2 + docs/01-CONTRACT-SPEC.md §11）
  var LAYER = {
    L2_BRIDGE: '0x0000000000000000000000000000000000000101',
    L2_GATE: '0x0000000000000000000000000000000000000102',
    AGENT_BOOK: '0x0000000000000000000000000000000000000103',
    FEE_SPLITTER: '0x0000000000000000000000000000000000000104', // 决策 #17
    FEE_SINK: '0x000000000000000000000000000000000000dEaD',
    MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    CREATE2: '0x4e59b44847b379578588920cA78FbF26c0B4956C'
  };

  var C = {
    MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    // 决策 #20：纪元 = 10 分钟。BacBridge / ChainAnchor / ValidatorStaking 里都是 EPOCH = 600，
    // 纪元号 = floor(timestamp / 600)，两条链同一个定义。
    EPOCH: 600,
    LAYER_CHAIN_ID: 56777,
    TOTAL_SUPPLY: 1000000000000000000000000000n,  // 1e27 wei = 1,000,000,000 BAC
    OPERATOR_FLOAT: 1000000000000000000000n,      // 1,000 BAC，创世给中继的 gas，BSC 侧已锁等额
    BPS: 10000,
    BRIDGE_BPS: 5000,                   // BacTaxRouter 分账：桥池 50%（合约常量 BRIDGE_BPS，没有 setter）
    NODE_FUND_BPS: 5000,                // BacTaxRouter 分账：官方节点基金 50%（owner 可提，决策 #10）
    OFFICIAL_BLOCK_VALIDATOR_BPS: 1000, // 官方出块 → 验证者池 10%（决策 #17）
    VALIDATOR_BLOCK_VALIDATOR_BPS: 5000,// 验证者出块 → 自留 50%（决策 #17）
    MIN_VALIDATOR_STAKE: 2000000000000000000000000n, // 2,000,000 BAC
    MAX_EXIT_SHARE_BPS: 1000,           // 单地址每纪元最多拿当期释放额的 10%
    // ChainAnchor.COMMIT_WINDOW = 0：纪元一结束中继就能发锚点（10 分钟纪元下不再等 2 小时）
    COMMIT_WINDOW: 0,
    /* ── BNB Chain / Flap 的主网常量（不是我们的合约，发射前就真实存在）── */
    // 决策 #31：ERC-8004 Identity Registry（BNB Chain 官方，ERC-721 形态，代理合约）
    ERC8004_IDENTITY: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    // 决策 #30：Flap 的普通 Portal（v5.24.0），代币状态从这里读（getTokenV8Safe）
    FLAP_PORTAL: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
    // Portal 实测的协议费（docs/research 09~12）：税先被抽走 10%，路由收到约 0.90 倍。
    // 这是 Portal 的参数，不是 BAC 自己的读数；发射后以 taxProcessor.feeConfigV2().feeRate 为准。
    FLAP_FEE_RATE_BPS: 1000,
    // OpenZeppelin ERC1967 实现槽：bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
    ERC1967_IMPL_SLOT: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    // 决策 #25：锚点提交到可兑付之间的等待期 = 120 秒（合约里的 ChainAnchor.ANCHOR_WAIT）。
    // 页面上一律叫「锚点等待」，不叫「挑战窗口」（决策 #18 术语）。
    CHALLENGE_WINDOW: 120,              // 锚点等待 2 分钟
    BLOCK_PERIOD: 3,                    // 层内 QBFT blockperiodseconds
    GAS_LIMIT: 20000000,
    BSC_BLOCK_TIME: 0.45                // 实测（09-chain-truth.md）
  };

  // 必须逐字使用的两个状态串（04-website-conventions.md §1.3）
  var TEXT = {
    PRE: '发射后公布',
    ERR: '读取失败 · 重试中',
    LOADING: '读取中…',
    NO_RPC: '没有配置 RPC 地址',
    // 键名沿用旧名（v2 没有金库了，指的是 BacTaxRouter / BacBridge）
    NO_VAULT: '读不到税收路由或桥合约：请检查配置里的 router / bridge 地址，或合约接口和网站不一致',
    NO_INDEXER: '索引器读不到：层内数据暂时不可用，BSC 侧数字仍然是实时的',
    // 索引器读不到、但层内节点答话时用这一条：块和交易仍然是真的，只是没有历史与搜索
    RPC_DIRECT: '索引器读不到：区块与交易改由本站直接读层内节点，历史与搜索暂时不可用',
    UNTRUSTED: '由 agent 自己写的，本站不做任何背书',
    NOT_ANCHORED: '未锚定 · 仅来自官方节点',
    ANCHORED: '已锚定',
    // 决策 #18（术语）+ #25：锚点的等待期一律这么说，页面各处逐字复用这一句
    ANCHOR_WAIT: '锚点等待 2 分钟',
    ANCHOR_WAIT_NOTE: '锚点提交后要等 2 分钟才能兑付，这期间任何人都能指出它是错的',
    // 决策 #29a，逐字（BacBridge.OWNER_POWER_NOTICE 也是这一句，数据层会拿链上那份来比对）
    OWNER_POWER: '项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。',
    // 决策 #31a，逐字
    IDENTITY_LIMIT: '我们要求持有 agent 身份，我们不能证明它是 AI。',
    // ERC-8004 的 tokenURI 是持有人自己写的，谁都没核对过
    SELF_REPORTED: '持有人自述 · 未经核对',
    // 代币合约地址已锁定但还没发射：地址上还没有代码
    TOKEN_NOT_LAUNCHED: '代币地址已锁定，还没发射：这个地址上现在没有合约代码'
  };

  /* v2（决策 #31）已经没有自研 AgentRegistry，也就没有 CHALLENGED / ACTIVE / DORMANT… 这套状态机：
     一个 agent = 一个锁进过桥的 ERC-8004 身份编号。下面两张表只为兼容旧代码（BAC.statusName /
     BAC.statusZh 仍然存在），数据层自己产出的 agent 条目里 status / statusName / statusZh 一律是 null。 */
  var AGENT_STATUS = ['NONE', 'CHALLENGED', 'ACTIVE', 'DORMANT', 'BANNED', 'RETIRED'];
  var AGENT_STATUS_ZH = ['未注册', '入场验证中', '活跃', '休眠', '封禁', '退役'];
  var EPOCH_STATE_ZH = { NONE: '未上报', POSTED: '已上报 · 锚点等待中', FINAL: '已定案', VETOED: '被否决', DISPUTED: '有异议' };
  var ACTION_KINDS = ['JOIN', 'DEPLOY', 'PUBLISH', 'SERVICE', 'TRADE', 'LIST', 'POOL', 'STRATEGY', 'MESSAGE', 'CLAIM', 'NOTE'];

  /* ══════════════════════════════════════════════════════
     2. 配置
     ══════════════════════════════════════════════════════ */

  function isAddr(a) {
    return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;
  }
  function lc(a) { return typeof a === 'string' ? a.toLowerCase() : a; }

  /* v2 的地址簿（决策 #30 / #31）：没有 factory / vault / registry / vaultPortal 了。
       token     BAC（Flap Tax Token V3，地址已由 lockSalt 锁定，发射前没有代码）
       router    BacTaxRouter（Flap 的 beneficiary，税收 BNB 的落点，50/50 推给桥与节点基金）
       bridge    BacBridge 的 ERC1967 代理地址（UUPS，owner 可升级 + 紧急提取，决策 #29）
       nodeFund  BacNodeFund
       anchor    ChainAnchor
       staking   ValidatorStaking */
  var ADDRESS_KEYS = ['token', 'router', 'bridge', 'nodeFund', 'anchor', 'staking'];
  var DEFAULT_ADDRESSES = { token: '0x0', router: '0x0', bridge: '0x0', nodeFund: '0x0', anchor: '0x0', staking: '0x0' };
  // 旧配置（v1）里还有、v2 已删除的键：读到了只记一笔，不参与任何判断
  var LEGACY_KEYS = ['factory', 'vault', 'registry'];

  var raw = root.BAC_CONFIG || {};

  /** 防御式读取地址簿：新旧两种配置都能加载，缺键、写错、非字符串一律当「没配」（'0x0'）。
      旧配置的 vault（「税收落点」）在 v2 就是 BacTaxRouter —— 只有 router 没配时才拿它顶上。 */
  function readAddresses(src) {
    var a = src && typeof src === 'object' ? src : {};
    var out = {};
    ADDRESS_KEYS.forEach(function (k) {
      out[k] = typeof a[k] === 'string' && a[k] ? a[k] : DEFAULT_ADDRESSES[k];
    });
    if (!isAddr(out.router) && isAddr(a.vault)) out.router = a.vault;
    return out;
  }
  var rawAddrs = raw.addresses && typeof raw.addresses === 'object' ? raw.addresses : {};

  var CFG = {
    chainId: Number(raw.chainId || 56),
    chainName: raw.chainName || 'BNB Smart Chain',
    rpcs: (raw.rpcs || []).slice(),
    logRpcs: (raw.logRpcs || raw.rpcs || []).slice(),
    explorer: (raw.explorer || 'https://bscscan.com').replace(/\/+$/, ''),
    layerChainId: Number(raw.layerChainId || C.LAYER_CHAIN_ID),
    layerRpc: raw.layerRpc || '',
    indexerBase: (raw.indexerBase || '').replace(/\/+$/, ''),
    // 域名失效 / 还没解析出来时的兜底端点：永久保留，任何人都能用它独立核对这条链
    fallbackRpc: raw.fallbackRpc || '',
    fallbackApi: (raw.fallbackApi || '').replace(/\/+$/, ''),
    addresses: readAddresses(rawAddrs),
    // 旧配置里出现过的 v1 键（只做记录，给「配置还没换」的提示用）
    legacyKeys: LEGACY_KEYS.filter(function (k) { return rawAddrs[k] !== undefined; })
      .concat(['guardian', 'vaultPortal'].filter(function (k) { return raw[k] !== undefined; })),
    // 主网常量：允许配置覆盖（测试网 / 换注册表），默认就是 BSC 主网那两个
    identityRegistry: isAddr(raw.identityRegistry) ? raw.identityRegistry : C.ERC8004_IDENTITY,
    flapPortal: isAddr(raw.flapPortal) ? raw.flapPortal : C.FLAP_PORTAL,
    // 合约部署所在的 BSC 块号（日志时间线从这里开始才算「完整」）；0 / 缺省 = 不知道
    deployBlock: Math.max(0, Math.floor(Number(raw.deployBlock) || 0)),
    // 层内现在是不是演练链：配置显式写了就照它（bind.js 读 BAC.CFG.rehearsal）；没写是 null
    rehearsal: typeof raw.rehearsal === 'boolean' ? raw.rehearsal : null,
    flapUrl: raw.flapUrl || '',
    x: raw.x || '',
    siteUrl: raw.siteUrl || '',
    // 轮询节奏
    pollMs: Math.max(3000, Number(raw.pollMs || 15000)),
    prelaunchPollMs: Math.max(10000, Number(raw.prelaunchPollMs || 60000)),
    // 「地址上有没有代码」的复探节奏：代币发射当天不用重新部署网站，开着的页面最迟这么久就会翻过来
    codeProbeMs: Math.max(10000, Number(raw.codeProbeMs || 120000)),
    // BSC 日志（eth_getLogs）：公共节点只留最近几千块（publicnode 实测 ~6000 块之外报
    // "Archive requests require a personal token"），所以浏览器只看得到一个窗口，完整历史要靠索引器
    logWindowBlocks: Math.max(100, Math.min(50000, Number(raw.logWindowBlocks || 5000))),
    logChunkBlocks: Math.max(100, Math.min(50000, Number(raw.logChunkBlocks || 5000))),
    timelineMax: Math.max(10, Math.min(1000, Number(raw.timelineMax || 200))),
    blockTsPerRefresh: Math.max(0, Math.min(50, Number(raw.blockTsPerRefresh || 12))),
    // agent 名录（BacBridge.deposits + ERC-8004）：最多读最近多少笔存入、多少个身份
    depositsMax: Math.max(10, Math.min(2000, Number(raw.depositsMax || 400))),
    agentsMax: Math.max(5, Math.min(500, Number(raw.agentsMax || 100))),
    agentsPollMs: Math.max(15000, Number(raw.agentsPollMs || 120000)),
    apiPollMs: Math.max(3000, Number(raw.apiPollMs || 6000)),
    // 层内直读 RPC 的节奏：链 3 秒一块，不许比它更快
    layerPollMs: Math.max(3000, Number(raw.layerPollMs || 6000)),
    layerIdlePollMs: Math.max(10000, Number(raw.layerIdlePollMs || 60000)),   // 索引器在供数时的慢档探活
    layerHiddenPollMs: Math.max(10000, Number(raw.layerHiddenPollMs || 60000)), // 标签页切到后台时的慢档
    // 超时
    rpcTimeoutMs: Number(raw.rpcTimeoutMs || 15000),
    apiTimeoutMs: Number(raw.apiTimeoutMs || 8000),
    layerTimeoutMs: Number(raw.layerTimeoutMs || 8000),
    // 列表长度
    feedLimit: Math.min(200, Number(raw.feedLimit || 50)),
    feedMax: Math.min(500, Number(raw.feedMax || 120)),
    blocksLimit: Math.min(200, Number(raw.blocksLimit || 20)),
    agentsPageSize: Math.min(200, Number(raw.agentsPageSize || 50)),
    autoStart: raw.autoStart !== false
  };

  // 兼容写法：cfg.token / cfg.router … 直接可读。cfg.vault 是 router 的旧名（只读别名，v2 没有金库）。
  ADDRESS_KEYS.forEach(function (k) { if (!CFG[k]) CFG[k] = CFG.addresses[k]; });
  CFG.vault = CFG.addresses.router;

  BAC.CFG = CFG;
  BAC.C = C;
  BAC.LAYER = LAYER;
  BAC.TEXT = TEXT;
  BAC.ZERO = ZERO;
  BAC.isAddr = isAddr;
  BAC.AGENT_STATUS = AGENT_STATUS;
  BAC.AGENT_STATUS_ZH = AGENT_STATUS_ZH;
  BAC.ACTION_KINDS = ACTION_KINDS;
  BAC.ADDRESS_KEYS = ADDRESS_KEYS.slice();

  /* ── BSC 侧的三个阶段（决策 #35：合约先部署，代币后发射）────────────────
       'none'      (a) 什么都没部署：只有已锁定的代币地址，地址上没有代码
       'deployed'  (b) router + bridge 已部署（有代码），代币还没发射：
                       合约自己的状态（0 余额、owner、升级次数、空时间线）是**真的**，要照实显示；
                       价格 / 税率 / 交易这些**还不存在**，才写「发射后公布」
       'launched'  (c) 代币地址上有代码了
     三个开关都由 bac-chain.js 的 eth_getCode 探针改写（结果缓存，只从 false 翻到 true，
     没翻完之前每 codeProbeMs 复探一次 —— 发射当天不用重新部署网站）。

     BAC.CONTRACTS_CONFIGURED  配置里 router 与 bridge 都填了（同步可知，加载时就定）
     BAC.CONTRACTS_LIVE        router 与 bridge 地址上都有代码
     BAC.TOKEN_LIVE            代币地址上有代码
     BAC.LIVE                  兼容旧消费者的别名 = CONTRACTS_LIVE || TOKEN_LIVE。
                               探针回来之前是 CONTRACTS_CONFIGURED（绑定层在加载时同步读它决定演示模式）。
     **这几个开关都只管 BSC 那一半**，绝对不许用来挡层内的区块和交易 —— 那条链现在就在出块。 */
  BAC.CONTRACTS_CONFIGURED = isAddr(CFG.addresses.router) && isAddr(CFG.addresses.bridge);
  BAC.TOKEN_CONFIGURED = isAddr(CFG.addresses.token);
  BAC.CONTRACTS_LIVE = false;
  BAC.TOKEN_LIVE = false;
  BAC.LIVE = BAC.CONTRACTS_CONFIGURED;
  BAC.STAGE = 'none';
  /** 探针有没有回来过（没回来 = 还不知道，视图给 'loading' 而不是 'pre'）。 */
  BAC.STAGE_KNOWN = !BAC.CONTRACTS_CONFIGURED && !BAC.TOKEN_CONFIGURED;

  /** 探针结果落地：只从 false 翻到 true（地址上的代码不会自己消失），然后广播 'stage'。 */
  BAC.setStage = function (contractsLive, tokenLive) {
    var before = BAC.STAGE + '|' + BAC.STAGE_KNOWN;
    if (contractsLive === true) BAC.CONTRACTS_LIVE = true;
    if (tokenLive === true) BAC.TOKEN_LIVE = true;
    BAC.STAGE_KNOWN = true;
    BAC.LIVE = BAC.CONTRACTS_LIVE || BAC.TOKEN_LIVE;
    BAC.STAGE = BAC.TOKEN_LIVE ? 'launched' : (BAC.CONTRACTS_LIVE ? 'deployed' : 'none');
    var s = BAC.state;
    if (s) {
      s.live = BAC.LIVE; s.prelaunch = !BAC.LIVE;
      s.contractsLive = BAC.CONTRACTS_LIVE; s.tokenLive = BAC.TOKEN_LIVE;
      s.stage = BAC.STAGE; s.stageKnown = true;
    }
    if (before !== BAC.STAGE + '|' + BAC.STAGE_KNOWN) BAC.emit('stage', BAC.STAGE);
    return BAC.STAGE;
  };
  /** 索引器是否配置好（历史 / 搜索 / 聚合的前提）。 */
  BAC.HAS_INDEXER = !!(CFG.indexerBase || CFG.fallbackApi);
  /** 是否配了层内 RPC（主用或兜底任意一个）。 */
  BAC.HAS_LAYER_RPC = !!(CFG.layerRpc || CFG.fallbackRpc);
  /** **层内链是不是在应答**。和 BAC.LIVE 完全独立：
      BAC.LIVE  = BSC 上的代币发射了没有；
      BAC.LAYER_LIVE = 层内那条链的 RPC 现在答不答话。
      由 bac-layer.js 在每一轮轮询后改写。 */
  BAC.LAYER_LIVE = false;

  BAC.statusName = function (n) { return AGENT_STATUS[Number(n)] || 'NONE'; };
  BAC.statusZh = function (n) { return AGENT_STATUS_ZH[Number(n)] || '未注册'; };
  BAC.epochStateZh = function (s) { return EPOCH_STATE_ZH[s] || '未上报'; };

  /* ══════════════════════════════════════════════════════
     3. 数值与格式化（BigInt 精确，向下取整，未知一律 —）
     ══════════════════════════════════════════════════════ */

  var DASH = '—';

  /** 任何来源（BigInt / number / 十进制字符串 / 0x 字符串 / null）→ BigInt | null。
      接口契约里所有金额都是「十进制字符串的 wei」，这里不做浮点。 */
  function big(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'bigint') return v;
    try {
      if (typeof v === 'number') {
        if (!isFinite(v) || Math.floor(v) !== v) return null;
        return BigInt(v);
      }
      if (typeof v === 'string') {
        var s = v.trim();
        if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
        if (/^-?\d+$/.test(s)) return BigInt(s);
        return null;
      }
      if (typeof v === 'object' && typeof v.toString === 'function') return big(v.toString());
    } catch (e) { return null; }
    return null;
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'bigint' ? Number(v) : Number(v);
    return isFinite(n) ? n : null;
  }

  function group(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /** wei → 字符串，向下取整，最多 maxFrac 位小数。 */
  function units(v, dec, maxFrac, opts) {
    var b = big(v);
    if (b === null) return DASH;
    dec = dec === undefined ? 18 : dec;
    maxFrac = maxFrac === undefined ? 4 : maxFrac;
    opts = opts || {};
    var neg = b < 0n; if (neg) b = -b;
    var base = 10n ** BigInt(dec);
    var whole = b / base, frac = b % base;
    var fs = frac.toString().padStart(dec, '0').slice(0, maxFrac).replace(/0+$/, '');
    if (opts.fixed) fs = frac.toString().padStart(dec, '0').slice(0, maxFrac);
    if (!opts.fixed && whole === 0n && frac > 0n && fs === '') {
      return (neg ? '-' : '') + '<0.' + '0'.repeat(Math.max(0, maxFrac - 1)) + '1';
    }
    var ws = opts.group === false ? whole.toString() : group(whole.toString());
    return (neg ? '-' : '') + ws + (fs ? '.' + fs : '');
  }

  /** 代币口径：≥1000 → 0 位，≥1 → 2 位，其它 4 位。 */
  function token(v, dec) {
    var b = big(v);
    if (b === null) return DASH;
    dec = dec === undefined ? 18 : dec;
    var base = 10n ** BigInt(dec), a = b < 0n ? -b : b;
    if (a >= 1000000000000000000000000000000000000000000000000000000000000n) return '无限';
    var f = a >= 1000n * base ? 0 : (a >= base ? 2 : 4);
    return units(b, dec, f);
  }

  function bnb(v, d) { return units(v, 18, d === undefined ? 4 : d); }

  /** 中文紧凑：12.5 万 / 3.2 亿 */
  function compact(v, dec) {
    var b = big(v);
    if (b === null) return DASH;
    dec = dec === undefined ? 18 : dec;
    var n = Number(b) / Math.pow(10, dec);
    if (!isFinite(n)) return DASH;
    var a = Math.abs(n);
    // 小数位按「除完之后」的大小定：≥100 取 0 位，≥10 取 1 位，其余 2 位
    function digits(x) { var y = Math.abs(x); return y >= 100 ? 0 : (y >= 10 ? 1 : 2); }
    function trim(s) { return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); }
    if (a >= 1e8) { var y1 = n / 1e8; return trim(y1.toFixed(digits(y1))) + ' 亿'; }
    if (a >= 1e4) { var y2 = n / 1e4; return trim(y2.toFixed(digits(y2))) + ' 万'; }
    return token(b, dec);
  }

  function pct(bps) {
    var n = num(bps);
    if (n === null) return DASH;
    var v = n / 100;
    return (Math.round(v * 100) / 100) + '%';
  }

  /** part / whole → 百分比字符串，BigInt 精确（先乘 10000 再除）。 */
  function share(part, whole) {
    var p = big(part), w = big(whole);
    if (p === null || w === null || w === 0n) return DASH;
    return pct(Number(p * 10000n / w));
  }

  function int(v) {
    var n = num(v);
    return n === null ? DASH : group(String(Math.trunc(n)));
  }

  function addr(a) {
    if (!a || typeof a !== 'string' || a.length < 12) return DASH;
    return a.slice(0, 6) + '…' + a.slice(-4);
  }
  function hash(h) {
    if (!h || typeof h !== 'string' || h.length < 14) return DASH;
    return h.slice(0, 10) + '…' + h.slice(-6);
  }

  function duration(sec) {
    var n = num(sec);
    if (n === null) return DASH;
    n = Math.max(0, Math.floor(n));
    var d = Math.floor(n / 86400), h = Math.floor((n % 86400) / 3600),
      m = Math.floor((n % 3600) / 60), s = n % 60;
    if (d > 0) return d + ' 天' + (h ? ' ' + h + ' 小时' : '');
    if (h > 0) return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
    if (m > 0) return m + ' 分' + (s ? ' ' + s + ' 秒' : '');
    return n < 1 ? '不到 1 秒' : s + ' 秒';
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function hms(sec) {
    var n = num(sec);
    if (n === null) return DASH;
    n = Math.max(0, Math.floor(n));
    return pad2(Math.floor(n / 3600)) + ':' + pad2(Math.floor((n % 3600) / 60)) + ':' + pad2(n % 60);
  }

  /** 一律北京时间（UTC+8），接口里的时间戳全部是秒。 */
  function beijing(ts, o) {
    var n = num(ts);
    if (n === null) return DASH;
    o = o || {};
    var d = new Date((n + 8 * 3600) * 1000);
    var date = (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日';
    var time = pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + (o.seconds ? ':' + pad2(d.getUTCSeconds()) : '');
    if (o.date && !o.time) return (o.year ? d.getUTCFullYear() + '年' : '') + date;
    if (o.time && !o.date) return time;
    return (o.year ? d.getUTCFullYear() + '年' : '') + date + ' ' + time;
  }

  function ago(sec) {
    var n = num(sec);
    if (n === null) return DASH;
    n = Math.max(0, Math.floor(n));
    if (n < 60) return n + ' 秒前';
    if (n < 3600) return Math.floor(n / 60) + ' 分钟前';
    if (n < 86400) return Math.floor(n / 3600) + ' 小时前';
    return Math.floor(n / 86400) + ' 天前';
  }

  BAC.fmt = {
    DASH: DASH, big: big, num: num, units: units, token: token, bnb: bnb,
    compact: compact, pct: pct, share: share, int: int, addr: addr, hash: hash,
    duration: duration, hms: hms, beijing: beijing, ago: ago, group: group
  };
  BAC.big = big;

  /* ══════════════════════════════════════════════════════
     4. 纪元与时钟
     ══════════════════════════════════════════════════════ */

  var clockSkew = 0; // 链上时间 − 本地时间（秒）

  BAC.time = {
    now: function () { return Math.floor(Date.now() / 1000) + clockSkew; },
    setChainTime: function (ts) {
      var n = num(ts);
      if (n === null) return;
      var d = n - Math.floor(Date.now() / 1000);
      if (Math.abs(d) < 86400) clockSkew = d; // 超过一天的偏差当成坏数据，不采信
    },
    skew: function () { return clockSkew; }
  };

  BAC.epochOf = function (ts) {
    var n = num(ts);
    return n === null ? null : Math.floor(n / C.EPOCH);
  };
  BAC.currentEpoch = function () { return Math.floor(BAC.time.now() / C.EPOCH); };
  /** 本纪元还剩多少秒 */
  BAC.epochLeft = function () {
    var now = BAC.time.now();
    return (Math.floor(now / C.EPOCH) + 1) * C.EPOCH - now;
  };

  /* ══════════════════════════════════════════════════════
     5. 链接
     ══════════════════════════════════════════════════════ */

  var EX = CFG.explorer;
  BAC.links = {
    tx: function (h) { return h ? EX + '/tx/' + h : null; },
    address: function (a) { return a ? EX + '/address/' + a : null; },
    // 合约的全部事件（浏览器只读得到最近一个窗口的日志，完整历史去这里核对）
    addressEvents: function (a) { return a ? EX + '/address/' + a + '#events' : null; },
    token: function (a) { return a ? EX + '/token/' + a : null; },
    block: function (n) { return (n || n === 0) ? EX + '/block/' + n : null; },
    // 层内没有第三方浏览器：本站自己就是浏览器，用 hash 路由指回自己
    layerTx: function (h) { return h ? '#/tx/' + h : null; },
    layerBlock: function (n) { return (n || n === 0) ? '#/block/' + n : null; },
    layerAddress: function (a) { return a ? '#/address/' + a : null; },
    agent: function (id) { return (id || id === 0) ? '#/agent/' + id : null; },
    epoch: function (e) { return (e || e === 0) ? '#/epoch/' + e : null; },
    flap: function () { return CFG.flapUrl || null; },
    api: function (path) { return CFG.indexerBase ? CFG.indexerBase + path : null; }
  };

  /* ══════════════════════════════════════════════════════
     6. 错误归类（中文一句话，绑定层直接显示）
     ══════════════════════════════════════════════════════ */

  /** 从 "English / 中文" 的 require 串里取中文那半。 */
  function chineseHalf(s) {
    if (typeof s !== 'string') return s;
    var i = s.indexOf(' / ');
    if (i > 0 && /[一-龥]/.test(s.slice(i))) return s.slice(i + 3).trim();
    return s;
  }

  function errInfo(e) {
    if (!e) return { code: 'unknown', message: TEXT.ERR };
    var code = e.code || (e.error && e.error.code) || '';
    var msg = e.shortMessage || e.message || String(e);
    if (code === 'TIMEOUT' || /timeout|timed out|aborted|AbortError/i.test(msg) || e.name === 'AbortError') {
      return { code: 'timeout', message: '请求超时，正在重试' };
    }
    if (code === 'CALL_EXCEPTION' || /revert/i.test(msg)) {
      return { code: 'revert', message: chineseHalf(e.reason || msg) };
    }
    if (code === 'BAD_DATA' || /could not decode/i.test(msg)) {
      return { code: 'baddata', message: '合约返回的数据和网站预期的接口不一致' };
    }
    if (/rate|limit|429|-32005/i.test(msg)) return { code: 'ratelimited', message: 'RPC 限速，正在换一个节点重试' };
    if (/failed to fetch|networkerror|load failed|ECONN|ENOTFOUND|fetch/i.test(msg)) {
      return { code: 'network', message: '网络请求失败，请稍后再试' };
    }
    if (/http (\d{3})/i.test(msg)) return { code: 'http', message: '服务器返回错误：' + msg };
    return { code: 'unknown', message: chineseHalf(msg) };
  }

  /** 同一个 revert 在每个 RPC 上都一样 → 不换 RPC。超时/限速/HTML 响应 → 换。 */
  function isRevert(e) {
    if (!e) return false;
    var code = e.code || '';
    var msg = (e.shortMessage || e.message || String(e));
    if (code === 'BAD_DATA') return true;
    if (code === 'CALL_EXCEPTION' && (e.data || e.reason)) return true;
    if (/revert/i.test(msg) && !/header not found|missing trie|limit|rate|timeout|busy|429|503/i.test(msg)) return true;
    return false;
  }

  BAC.errInfo = errInfo;
  BAC.isRevert = isRevert;
  BAC.chineseHalf = chineseHalf;

  /* ══════════════════════════════════════════════════════
     7. 事件总线（feed / state 会重放给迟到的监听者）
     ══════════════════════════════════════════════════════ */

  var listeners = {}, lastEvent = {};
  var REPLAY = { feed: true, state: true, blocks: true, health: true, layer: true };

  BAC.on = function (name, fn) {
    if (typeof fn !== 'function') return function () {};
    (listeners[name] = listeners[name] || []).push(fn);
    if (REPLAY[name] && lastEvent[name] !== undefined) {
      try { fn(lastEvent[name]); } catch (e) { logErr('on(' + name + ')', e); }
    }
    return function () { BAC.off(name, fn); };
  };
  BAC.off = function (name, fn) {
    var a = listeners[name];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  BAC.emit = function (name, payload) {
    if (REPLAY[name]) lastEvent[name] = payload;
    var a = (listeners[name] || []).slice();
    for (var i = 0; i < a.length; i++) {
      try { a[i](payload); } catch (e) { logErr('emit(' + name + ')', e); }
    }
  };

  function logErr(where, e) {
    if (root.console && root.console.error) root.console.error('[BAC] ' + where, e);
  }
  BAC.logErr = logErr;

  /* ══════════════════════════════════════════════════════
     8. 状态骨架
        null = 未知（显示「发射后公布」或「读取中…」），不是 0。
     ══════════════════════════════════════════════════════ */

  /** source: 'indexer' | 'rpc' | null —— 这一段的数是从哪来的，绑定层要如实显示。
      status: 'prelaunch' | 'loading' | 'ok' | 'error'。
      stale: 上一轮读到过、这一轮失败 —— 显示的是旧数，必须标出来。 */
  function section() {
    return {
      ready: false, error: null, errorDetail: null, failures: 0, updatedAt: null,
      source: null, status: 'loading', stale: false
    };
  }

  BAC.state = {
    live: BAC.LIVE,
    prelaunch: !BAC.LIVE,
    // 三阶段（见上面 BAC.STAGE 的说明）
    stage: BAC.STAGE,
    stageKnown: BAC.STAGE_KNOWN,
    contractsLive: false,
    tokenLive: false,
    // 层内链是否在应答（和 live 无关）
    layerLive: false,
    ready: false,
    loading: false,
    hidden: false,
    error: null,          // null | TEXT.ERR | TEXT.NO_RPC | TEXT.NO_VAULT
    errorDetail: null,
    warnings: [],
    updatedAt: null,
    reason: null,

    // ── BSC 侧（直接读合约）──
    bsc: Object.assign(section(), {
      block: null,        // { number, timestamp, at }
      // eth_getCode 探针：true 有代码 / false 没代码 / null 还没探或探失败
      code: { token: null, router: null, bridge: null, at: null },
      params: null,       // 合约接线（router / bridge / nodeFund 的不可变参数与互相核对）
      tokenParams: null,  // 代币元数据 / 税率 / taxProcessor（只在 TOKEN_LIVE 之后才有）
      token: null,        // 代币的活数据：Portal 状态、价格、待分发税、桥里的 BAC
      treasury: null,     // BacTaxRouter + 桥池 + 节点基金
      bridge: null,       // BacBridge 的桥状态 + owner 权力（#29）
      agents: null,       // 计数兜底（depositId）
      staking: null,      // ValidatorStaking
      anchor: null        // ChainAnchor + 纪元
    }),
    // BSC 日志时间线（公共节点只给最近一个窗口，complete 说明是不是全量）
    timeline: Object.assign(section(), {
      owner: [], flow: [], nodeFund: [],
      fromBlock: null, syncedTo: null, deployBlock: CFG.deployBlock || null,
      complete: false, gaps: [], windowBlocks: CFG.logWindowBlocks
    }),
    // agent 名录（BSC 链上：BacBridge.deposits + ERC-8004 注册表）
    agentDir: Object.assign(section(), {
      items: [], total: null, depositsTotal: null, depositsRead: 0, truncated: false, identityAt: null
    }),

    // ── 层内 + feed（走索引器；索引器挂了进降级模式）──
    indexer: Object.assign(section(), { degraded: false, lastOkAt: null, base: CFG.indexerBase, endpoint: null }),
    // 层内：索引器给得了就用索引器（有历史 / 搜索 / 聚合），给不了就由 bac-layer.js 直接读 RPC。
    // sections 是每一段各自的状态，绑定层照它选占位文案。
    layer: Object.assign(section(), {
      source: null, endpoint: null,
      sections: { head: 'loading', blocks: 'loading', txs: 'loading' },
      head: null, headTs: null, headHash: null, chainId: null, miner: null,
      gasLimit: null, baseFee: null, gasPrice: null, peers: null, txpool: null,
      blockIntervalSec: null, blockTimeSec: null, blockLagSec: null,
      rpcHead: null, rpcHeadTs: null, rpcAt: null
    }),
    health: null,
    summary: null,
    feed: Object.assign(section(), { items: [], head: null, anchoredThrough: null }),
    blocks: Object.assign(section(), { items: [] }),
    txs: Object.assign(section(), { items: [] }),
    agentList: Object.assign(section(), { items: [], total: null, page: 1 }),
    validators: Object.assign(section(), { items: [], totalStaked: null, rewardBalance: null }),
    epochs: Object.assign(section(), { items: [] }),
    rate: Object.assign(section(), { weiPerCredit: null, poolBalance: null, owedTotal: null })
  };

  BAC.newSection = section;

  /** 页面切到后台时由绑定层告诉我们（数据层不碰 document）。 */
  BAC.setHidden = function (hidden) {
    var h = !!hidden;
    if (BAC.state.hidden === h) return;
    BAC.state.hidden = h;
    BAC.emit('hidden', h);
  };

  /** 汇总一个给页面用的「整体是否可信」判断。 */
  BAC.health = function () {
    var s = BAC.state;
    return {
      live: s.live,
      prelaunch: s.prelaunch,
      stage: BAC.STAGE,
      stageKnown: BAC.STAGE_KNOWN,
      contractsLive: BAC.CONTRACTS_LIVE,
      tokenLive: BAC.TOKEN_LIVE,
      layerLive: !!BAC.LAYER_LIVE,
      layerSource: s.layer.source,
      layerEndpoint: s.layer.endpoint,
      bscOk: !!(s.bsc.ready && !s.bsc.error),
      indexerOk: !!(s.indexer.ready && !s.indexer.error),
      degraded: !!s.indexer.degraded,
      warnings: s.warnings.slice()
    };
  };

  BAC.pushWarning = function (w) {
    if (!w) return;
    if (BAC.state.warnings.indexOf(w) < 0) BAC.state.warnings.push(w);
  };
  BAC.clearWarning = function (w) {
    var i = BAC.state.warnings.indexOf(w);
    if (i >= 0) BAC.state.warnings.splice(i, 1);
  };

  /* ══════════════════════════════════════════════════════
     9. 退避（RPC 与索引器共用同一条公式，只是基数不同）
     ══════════════════════════════════════════════════════ */

  /** 第 n 次失败后要等多久：base * 2^(n-1)，上限 120 秒（约定 §1.3，逐字）。 */
  function backoffMs(fails, base) {
    var n = Math.max(1, Number(fails) || 1);
    return Math.min(120000, (base || 15000) * Math.pow(2, n - 1));
  }
  BAC.backoffMs = backoffMs;

  /** 一个 URL / 端点的健康记录表。 */
  function healthTable(base) {
    var h = {};
    return {
      get: function (key) { return h[key] || (h[key] = { fails: 0, until: 0, lastError: null }); },
      ok: function (key) { var e = this.get(key); e.fails = 0; e.until = 0; e.lastError = null; },
      bad: function (key, err, now) {
        var e = this.get(key);
        e.fails++;
        e.until = (now === undefined ? Date.now() : now) + backoffMs(e.fails, base);
        e.lastError = err ? (err.message || String(err)) : null;
        return e;
      },
      healthy: function (key, now) {
        var e = this.get(key);
        return e.until <= (now === undefined ? Date.now() : now);
      },
      all: function () { return h; }
    };
  }
  BAC.healthTable = healthTable;

  /** ethers 可用性：UMD 包在 <script defer> 下可能比本文件晚一点。 */
  BAC.ethersReady = function (timeoutMs) {
    var limit = timeoutMs === undefined ? 20000 : timeoutMs;
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function tick() {
        if (root.ethers) return resolve(root.ethers);
        if (Date.now() - t0 >= limit) return reject(new Error('ethers 库加载失败，请刷新页面'));
        setTimeout(tick, 100);
      })();
    });
  };

  BAC.core = { version: '1' };
})(typeof window !== 'undefined' ? window : globalThis);
