/* BNB Agent Chain · 可视层 · 行与单元格渲染
   只读 window.BACVM，任何一个字段是 null 都按「不知道」渲染，绝不当成 0。 */
(function (root) {
  'use strict';

  var UI = root.BACUI;
  if (!UI || !UI.util) {
    if (root.console) root.console.error('[BACUI] rows.js 需要先加载 js/ui/util.js');
    return;
  }
  if (UI.rows) return;

  var VM = root.BACVM;
  var esc = UI.esc, comma = UI.comma, sa = UI.sa, sh = UI.sh, bac = UI.bac, val = UI.val, miss = UI.miss;

  var GASLIMIT_FALLBACK = 20000000;

  /* ── 通用小件 ─────────────────────────────────────────── */

  /** 整行占位：列表读不到时不留空表，明说为什么。
      状态（「发射后公布」）和说明分成两段各自成行：两段各有各的译文，
      拼成一个文本节点时英文里只剩一个空格，读起来是一句没标点的长句。
      说明文字包在 .em-t 里：表格在手机上能横向滚动，说明不能跟着滚出视口（见 bac.css .tbl .empty）。 */
  function missRow(cols, status, extra) {
    return '<tr class="empty"><td class="l" colspan="' + cols + '"><div class="em-t">' +
      '<b class="em-st">' + esc(miss(status)) + '</b>' +
      (extra ? '<span class="em-x">' + esc(extra) + '</span>' : '') + '</div></td></tr>';
  }
  function emptyRow(cols, text) {
    return '<tr class="empty"><td class="l" colspan="' + cols + '"><div class="em-t">' + esc(text) + '</div></td></tr>';
  }

  function stTag(cls, text) { return '<span class="st-tag ' + cls + '">' + esc(text) + '</span>'; }

  function methodTag(t) {
    var cls = { deploy: 'dep', call: 'call', transfer: 'xfer', bridge: 'bri' }[t.type] || 'call';
    var m = t.method || '—';
    return '<span class="tag ' + cls + '">' + esc(m.length > 20 ? m.slice(0, 18) + '…' : m) + '</span>';
  }

  /** 交易的「目标」列：部署 / 合约 / agent 钱包 / 系统合约，各有各的说法。 */
  function toCell(t) {
    if (t.toLabelKind === 'created' || (t.type === 'deploy' && t.created)) {
      return '<span class="ok-t">新合约 ' + esc(sa(t.created || t.to)) + '</span>';
    }
    if (!t.to) return '<span class="sub">—</span>';
    if (t.toLabelKind === 'contract') {
      return '<a class="a-link" href="#/contract/' + esc(t.to) + '"><code>' + esc(sa(t.to)) + '</code></a>' +
        (t.toContractAgentId ? '<span class="sub">agent #' + t.toContractAgentId + ' 部署</span>' : '');
    }
    if (t.toLabelKind === 'agent' && t.toAgentId) {
      return '<code>' + esc(sa(t.to)) + '</code><span class="sub">agent #' + t.toAgentId + '</span>';
    }
    /* 系统地址：显示它**准确的名字**（bind.js 从创世常量表里带过来的），
       不要一律写成「层内系统合约」—— 0x…dEaD 根本不是合约，它是黑洞地址。 */
    if (t.toLabelKind === 'system' || t.toLabelKind === 'sink') {
      return '<code>' + esc(sa(t.to)) + '</code><span class="sub">' +
        esc(t.toLabel || (t.toLabelKind === 'sink' ? '黑洞地址 · 打进去的 BAC 永久销毁' : '层内系统合约')) + '</span>';
    }
    return '<code>' + esc(sa(t.to)) + '</code>';
  }

  /** 出块者列。阶段 1 全部是官方节点；proposer 读不到时如实说读不到。 */
  function propCell(b, status) {
    if (!b.proposerKind) {
      return '<td class="l"><span class="sub">' + esc(miss(status === 'ok' ? 'ok' : status)) + '</span></td>';
    }
    var official = b.proposerKind === 'official';
    return '<td class="l">' + stTag(official ? 'ok' : 'vio', official ? '官方节点' : '验证者') +
      '<span class="sub">' + esc(b.proposer ? sa(b.proposer) : '—') + (official ? ' · 不流通地址' : '') + '</span></td>';
  }

  /** 这条链的区块列表最该有的一列：这一块的 gas 费怎么分。 */
  function splitCell(b) {
    if (!b.proposerKind) return '<td class="r"><span class="spl">—</span></td>';
    return b.proposerKind === 'official'
      ? '<td class="r"><span class="spl o">10 / 90</span></td>'
      : '<td class="r"><span class="spl v">50 / 50</span></td>';
  }

  function gasCell(b) {
    var limit = b.gasLimit || VM.chain.gasLimit || GASLIMIT_FALLBACK;
    var p = (b.gasUsed === null || b.gasUsed === undefined) ? null : (b.gasUsed / limit * 100);
    return '<td class="r n">' + (b.gasUsed === null || b.gasUsed === undefined ? '—' : comma(b.gasUsed)) + '</td>' +
      '<td class="r n hide-m">' + (p === null ? '—' : p.toFixed(2) + '%') + '</td>';
  }

  function anchorCell(b) {
    return '<td class="r">' + (b.anchored
      ? '<span class="anc done">已锚定</span>'
      : '<span class="anc">待锚定</span>') + '</td>';
  }

  /* ── 区块行 ───────────────────────────────────────────── */
  function blockRow(b, compact, status) {
    var st = status || VM.st.blocks;
    if (compact) {
      return '<tr data-go="#/block/' + b.number + '">' +
        '<td class="l n bn">#' + comma(b.number) + '</td>' +
        '<td class="n">' + esc(UI.hms(b.ts)) + '<span class="ago">' + esc(UI.ago(b.ts)) + '</span></td>' +
        '<td class="l">' + (b.proposerKind
          ? stTag(b.proposerKind === 'official' ? 'ok' : 'vio', b.proposerKind === 'official' ? '官方节点' : '验证者')
          : '<span class="sub">—</span>') + '</td>' +
        '<td class="r n">' + (b.txCount === null || b.txCount === undefined ? '—' : b.txCount) + '</td>' +
        '<td class="r n">' + (b.gasUsed === null || b.gasUsed === undefined ? '—' : comma(b.gasUsed)) + '</td>' +
        '<td class="r n">' + val(st, b.fee, bac) + '</td>' +
        splitCell(b) + '</tr>';
    }
    return '<tr data-go="#/block/' + b.number + '">' +
      '<td class="l n bn">#' + comma(b.number) + '</td>' +
      '<td class="n">' + esc(UI.hms(b.ts)) + '<span class="sub">' + esc(UI.ago(b.ts)) + '</span></td>' +
      propCell(b, st) +
      '<td class="r n">' + (b.txCount === null || b.txCount === undefined ? '—' : b.txCount) + '</td>' +
      gasCell(b) +
      '<td class="r n">' + val(st, b.fee, bac) + '</td>' +
      splitCell(b) +
      '<td class="r n hide-m">' + (b.epoch === null || b.epoch === undefined ? '—'
        : '<a class="a-link" href="#/epoch/' + b.epoch + '">' + b.epoch + '</a>') + '</td>' +
      anchorCell(b) + '</tr>';
  }

  /* ── 交易行 ───────────────────────────────────────────── */
  function txRow(t, compact, status) {
    var st = status || VM.st.txs;
    var okTag = t.ok === null || t.ok === undefined
      ? '<span class="sub">—</span>'
      : (t.ok ? stTag('ok', '成功') : stTag('bad', '失败'));
    var who = t.agentId ? 'agent #' + t.agentId
      : (t.fromAddr ? '<code>' + esc(sa(t.fromAddr)) + '</code><span class="sub">未注册</span>' : '—');
    if (compact) {
      return '<tr data-go="#/tx/' + esc(t.hash) + '">' +
        '<td class="l n"><code>' + esc(sh(t.hash)) + '</code></td>' +
        '<td class="l">' + methodTag(t) + '</td>' +
        '<td class="l n">' + (t.agentId ? '#' + t.agentId : '—') + '</td>' +
        '<td class="l n tgt oneline">' + toCell(t) + '</td>' +
        '<td class="r n">' + val(st, t.fee, bac) + '</td>' +
        '<td class="r">' + okTag + '</td></tr>';
    }
    return '<tr data-go="#/tx/' + esc(t.hash) + '">' +
      '<td class="l n"><code>' + esc(sh(t.hash)) + '</code></td>' +
      '<td class="l">' + methodTag(t) + '</td>' +
      '<td class="r n bn">#' + comma(t.block) + '</td>' +
      '<td class="n">' + esc(UI.hms(t.ts)) + '<span class="sub">' + esc(UI.ago(t.ts)) + '</span></td>' +
      '<td class="l n">' + who + '</td>' +
      '<td class="l n">' + toCell(t) + '</td>' +
      '<td class="r n hide-m">' + (t.value && t.value !== 0n ? UI.tokenAmt(t.value) + '<u>BAC</u>' : '0') + '</td>' +
      '<td class="r n">' + (t.gasUsed === null || t.gasUsed === undefined ? '—' : comma(t.gasUsed)) + '</td>' +
      '<td class="r n">' + val(st, t.fee, bac) + '</td>' +
      '<td class="r">' + okTag + '</td></tr>';
  }

  /* ── agent 行 ─────────────────────────────────────────── */
  function hbSpark(a) {
    if (!a.hb || !a.hb.length) return '<span class="sub">—</span>';
    var s = '';
    for (var i = 0; i < a.hb.length; i++) s += a.hb[i] ? '█' : '░';
    return '<span class="spk">' + s + '</span>';
  }

  /** 持有人自述的名字（ERC-8004 tokenURI 里的 name）：不可信文本 —— 转义、截短、不翻译，旁边标「持有人自述」。 */
  function selfName(a, max) {
    if (!a.selfName) return '<span class="sub">—</span>';
    var s = a.selfName.length > (max || 40) ? a.selfName.slice(0, (max || 40) - 1) + '…' : a.selfName;
    return '<span class="self-n" translate="no" data-i18n-ignore>' + esc(s) + '</span><span class="sub">持有人自述</span>';
  }

  /** ERC-8004 名录的一行（决策 #31）：身份编号 / 持有人 / agentWallet / 自述名字 / 首次锁入 / 锁入与已退出积分 / 层内余额。
      v2 没有状态机、心跳、签名轮次 —— 这些列已经去掉，不画空列。 */
  function agentRow(a, status) {
    var st = status || VM.st.agents;
    var idNo = a.identityId === null || a.identityId === undefined ? a.id : a.identityId;
    return '<tr data-go="#/agent/' + a.id + '">' +
      '<td class="l n">#' + esc(String(idNo)) + '</td>' +
      '<td class="l n">' + (a.holder ? '<code translate="no">' + esc(sa(a.holder)) + '</code>' : '<span class="sub">—</span>') +
      (a.identityExists === false ? stTag('bad', '注册表里查不到这个身份') : '') + '</td>' +
      '<td class="l n hide-m">' + (a.agentWallet ? '<code translate="no">' + esc(sa(a.agentWallet)) + '</code>' : '<span class="sub">—</span>') + '</td>' +
      '<td class="l">' + selfName(a) + '</td>' +
      '<td class="n">' + esc(UI.ago(a.joinedTs)) + '</td>' +
      '<td class="r n">' + val(st, a.credited, UI.tokenAmt) + '<u>BAC</u></td>' +
      '<td class="r n">' + val(st, a.exited, UI.tokenAmt) + '<u>BAC</u></td>' +
      '<td class="r n hide-m">' + (a.balance === null || a.balance === undefined ? '—' : UI.tokenAmt(a.balance) + '<u>BAC</u>') + '</td></tr>';
  }

  /* ── BSC 时间线（税收流向 / 节点基金 / 项目方权限记录）──────────────
     条目是数据层 shapeEvent 的原样：{kind, block, tx, logIndex, ts, …金额 BigInt}。
     ts 可能是 null（日志里只有块号）：那就写 BSC 块号，不编时间。
     说明列里中文与地址 / 数字分开放：中文是固定短语（有译文），地址与数字不翻译。 */
  function tlTime(it) {
    if (it.ts !== null && it.ts !== undefined) {
      return '<td class="l n">' + esc(UI.ymd(it.ts)) + ' ' + esc(UI.hms(it.ts)) + '</td>';
    }
    return '<td class="l n"><span class="sub">BSC #' + (it.block === null || it.block === undefined ? '—' : comma(it.block)) + '</span></td>';
  }
  function tlTx(it) {
    if (!it.tx) return '<td class="r n">—</td>';
    var ex = (VM.links && VM.links.explorer) || 'https://bscscan.com';
    return '<td class="r n"><a class="a-link" href="' + esc(ex + '/tx/' + it.tx) + '" target="_blank" rel="noopener"><code translate="no">' +
      esc(sa(it.tx)) + '</code></a></td>';
  }
  function tlAddr(a) { return a ? '<code translate="no">' + esc(sa(a)) + '</code>' : '<span class="sub">—</span>'; }
  function tlBnb(v) { return v === null || v === undefined ? '—' : UI.bnb(v, 6) + '<u>BNB</u>'; }
  function tlBac(v) { return v === null || v === undefined ? '—' : UI.tokenAmt(v) + '<u>BAC</u>'; }
  function tlRow(it, tag, cls, amount, note) {
    return '<tr>' + tlTime(it) + '<td class="l">' + stTag(cls, tag) + '</td>' +
      '<td class="r n">' + amount + '</td><td class="l">' + (note || '') + '</td>' + tlTx(it) + '</tr>';
  }
  var ZERO_ADDR = /^0x0{40}$/i;
  function ownershipRow(it) {
    if (it.kind === 'ownershipStarted') {
      return tlRow(it, '发起转移 owner', 'warn', '—', '<span>从</span> ' + tlAddr(it.from) + ' <span>转给</span> ' + tlAddr(it.to));
    }
    if (typeof it.from === 'string' && ZERO_ADDR.test(it.from)) {
      return tlRow(it, '初始 owner', 'ok', '—', '<span>设为</span> ' + tlAddr(it.to));
    }
    return tlRow(it, 'owner 变更', 'warn', '—', '<span>从</span> ' + tlAddr(it.from) + ' <span>转给</span> ' + tlAddr(it.to));
  }

  /** 税收流向：税收到账 → 50/50 分账 → 推送 → 桥收到 → 回购 */
  function flowRow(it) {
    switch (it.kind) {
      case 'recognized':
        return tlRow(it, '税收到账', 'ok', tlBnb(it.amount), '<span>来自</span> ' + tlAddr(it.from));
      case 'split': {
        var tot = (it.toBridge !== null && it.toBridge !== undefined && it.toNodeFund !== null && it.toNodeFund !== undefined)
          ? it.toBridge + it.toNodeFund : null;
        return tlRow(it, '50/50 分账', 'ok', tlBnb(tot),
          '<span>桥池</span> <b>' + esc(UI.bnb(it.toBridge, 6)) + '</b> · <span>节点基金</span> <b>' + esc(UI.bnb(it.toNodeFund, 6)) + '</b>');
      }
      case 'push': {
        var to = it.target === 'bridge' ? '→ 桥池' : (it.target === 'nodeFund' ? '→ 节点基金' : '→ 其他地址');
        return tlRow(it, it.ok ? '推送成功' : '推送失败', it.ok ? 'ok' : 'bad', tlBnb(it.amount),
          '<span>' + to + '</span>' + (it.ok ? '' : ' <span class="sub">留在路由里等重推</span>'));
      }
      case 'bridgeReceived':
        return tlRow(it, '桥池收到', 'ok', tlBnb(it.amount), '<span>桥的 BNB 账面变为</span> <b>' + esc(UI.bnb(it.bnbAfter, 6)) + '</b>');
      case 'buyback':
        return tlRow(it, '回购 BAC', 'vio', tlBnb(it.bnbSpent),
          '<span>买到</span> <b>' + esc(UI.tokenAmt(it.bacBought)) + '</b> BAC' +
          (it.venueName ? ' <span class="sub" translate="no">' + esc(it.venueName) + '</span>' : ''));
      default:
        return tlRow(it, it.event || '—', 'dim', '—', '');
    }
  }

  /** 节点基金：到账 / 项目方提取 / 换 owner */
  function nodeFundRow(it) {
    switch (it.kind) {
      case 'received':
        return tlRow(it, '节点基金到账', 'ok', tlBnb(it.amount), '<span>余额变为</span> <b>' + esc(UI.bnb(it.balanceAfter, 6)) + '</b>');
      case 'withdraw':
        return tlRow(it, '项目方提取', 'warn', tlBnb(it.amount), '<span>提到</span> ' + tlAddr(it.to));
      case 'ownershipStarted':
      case 'ownership':
        return ownershipRow(it);
      default:
        return tlRow(it, it.event || '—', 'dim', '—', '');
    }
  }

  /** 项目方权限记录（决策 #29c）：升级 / 换实现 / 紧急提取 / 换 owner / 暂停 / 停机 / 逃生通道 */
  function ownerRow(it) {
    function when(ts) { return ts === null || ts === undefined ? '—' : esc(UI.full(ts)); }
    switch (it.kind) {
      case 'upgrade':
        return tlRow(it, '升级桥合约', 'warn', '—',
          '<span>新实现</span> ' + tlAddr(it.newImplementation) +
          (it.number !== null && it.number !== undefined ? ' <span class="sub">第 ' + it.number + ' 次</span>' : '') +
          (it.implementationConfirmed === false ? ' ' + stTag('bad', '和同一笔的 Upgraded 事件对不上') : ''));
      case 'implementation':
        return it.initial
          ? tlRow(it, '初始实现', 'ok', '—', '<span>代理部署时装上的实现</span> ' + tlAddr(it.implementation))
          : tlRow(it, '换实现 · 没留 BridgeUpgraded 事件', 'bad', '—', '<span>新实现</span> ' + tlAddr(it.implementation));
      case 'emergency': {
        var amt = it.asset === 'BNB' ? tlBnb(it.amount)
          : (it.asset === 'BAC' ? tlBac(it.amount)
            : (it.amount === null || it.amount === undefined ? '—' : esc(String(it.amount)) + '<u>最小单位</u>'));
        return tlRow(it, '紧急提取', 'bad', amt, '<span>提到</span> ' + tlAddr(it.to) +
          (it.asset === 'TOKEN' ? ' <span>代币</span> ' + tlAddr(it.token) : ''));
      }
      case 'ownershipStarted':
      case 'ownership':
        return ownershipRow(it);
      case 'pause':
        return tlRow(it, '暂停', 'warn', '—', '<span>暂停到</span> <b>' + when(it.until) + '</b>');
      case 'unpause':
        return tlRow(it, '解除暂停', 'ok', '—', '');
      case 'halt':
        return tlRow(it, '停机', 'bad', '—', '<span>原因代码</span> <b>' + (it.cause === null || it.cause === undefined ? '—' : it.cause) + '</b>');
      case 'escapeArmed':
        return tlRow(it, '武装逃生通道', 'bad', '—', '<span>生效时间</span> <b>' + when(it.effectiveAt) + '</b>');
      case 'escapeArmCancelled':
        return tlRow(it, '取消逃生武装', 'ok', '—', '');
      case 'owedRevoked':
        return tlRow(it, '撤销纪元待领', 'bad', tlBac(it.revoked), '<span>纪元</span> <b>' + (it.epoch === null || it.epoch === undefined ? '—' : it.epoch) + '</b>');
      case 'initialized':
        return tlRow(it, '初始化（部署）', 'ok', '—', '<span>版本</span> <b>' + (it.version === null || it.version === undefined ? '—' : it.version) + '</b>');
      default:
        return tlRow(it, it.event || '—', 'dim', '—', '');
    }
  }

  /* ── 验证者行 ─────────────────────────────────────────── */
  function validatorRow(v, status) {
    var st = status || VM.st.validators;
    return '<tr>' +
      '<td class="l"><code>' + esc(v.nodeId || '—') + '</code><span class="sub">' + esc(v.addr ? sa(v.addr) : '—') + '</span></td>' +
      '<td class="r n">' + val(st, v.stake, UI.tokenAmt) + '</td>' +
      '<td class="r n">' + (v.agreed === null || v.agreed === undefined ? '—' : v.agreed + '/' + (v.attend30 || v.agreed)) + '</td>' +
      '<td class="r n">' + (v.agreed === null || v.agreed === undefined ? '—' : v.agreed) + '</td>' +
      '<td class="r n">' + (v.disputed === null || v.disputed === undefined ? '—' : v.disputed) + '</td>' +
      '<td class="r n hide-m">' + (v.blocks === null || v.blocks === undefined ? '—' : v.blocks) +
      (v.rights ? '' : '<span class="sub">阶段 1</span>') + '</td>' +
      '<td class="r n hide-m">' + val(st, v.gasPoolPending, function (x) { return bac(x, 5); }) + '<u>BAC</u></td>' +
      '<td class="r n hide-m">' + val(st, v.lifetimeClaimedBnb, UI.bnb) + '<u>BNB</u></td>' +
      '<td class="r">' + (v.active === null || v.active === undefined
        ? '<span class="sub">—</span>'
        : stTag(v.active ? 'ok' : 'warn', v.active ? '在线' : '离线')) + '</td>' +
      '</tr>';
  }

  /* ── 纪元行 ───────────────────────────────────────────── */
  function epStateTag(e) {
    return '<span class="ep-state ' + (e.stateCls || 'open') + '">' + esc(e.stateEn || 'NONE') + ' · ' + esc(e.stateZh || '—') + '</span>';
  }

  function epochRow(e, status) {
    var st = status || VM.st.epochs;
    var gapCls = (e.gasGap === null || e.gasGap === undefined) ? '' : (e.gasGap > 0n ? 'amb' : 'grn');
    return '<tr data-go="#/epoch/' + e.n + '">' +
      '<td class="l n bn">' + e.n + '</td>' +
      '<td class="l">' + epStateTag(e) + '</td>' +
      '<td class="r n">' + (e.agreeing === null || e.agreeing === undefined ? '—' : e.agreeing + ' / ' + (e.members === null ? '—' : e.members)) + '</td>' +
      '<td class="r n hide-m">' + (e.releaseBps === null || e.releaseBps === undefined ? '—' : e.releaseBps + '<u>bps</u>') + '</td>' +
      '<td class="r n">' + (e.exits === null || e.exits === undefined ? '—' : e.exits) + '</td>' +
      '<td class="r n hide-m">' + val(st, e.gasFees, bac) + '<u>BAC</u></td>' +
      '<td class="r n hide-m">' + val(st, e.gasRemitted, bac) + '<u>BAC</u></td>' +
      '<td class="r n ' + gapCls + '">' + val(st, e.gasGap, bac) + '</td>' +
      '<td class="l n hide-m">' + (e.anchorTx ? '<code>' + esc(sa(e.anchorTx)) + '</code>' : '<span class="anc">未提交</span>') + '</td>' +
      '</tr>';
  }

  /* ── 税收路由 / 桥池 / 节点基金事件行 ─────────────────────
     钱离开的事件（节点基金提取、桥的紧急提取）和规则被改的事件（桥合约升级）用同一个醒目色，
     决策 #29c 要求它们在时间线上一眼可见。 */
  function treasuryRow(ev) {
    var out = /Withdraw|Upgraded/.test(String(ev.name || ''));
    return '<tr><td class="l n">' + esc(UI.ymd(ev.ts)) + ' ' + esc(UI.hms(ev.ts)) + '</td>' +
      '<td class="l"><span class="tag ' + (out ? 'bri' : 'dep') + '">' + esc(ev.name) + '</span></td>' +
      '<td class="r n">' + val('ok', ev.amount, UI.bnb) + '<u>BNB</u></td>' +
      '<td class="l">' + esc(ev.note || '') + '</td>' +
      '<td class="r n">' + (ev.tx ? '<code>' + esc(sa(ev.tx)) + '</code>' : '—') + '</td></tr>';
  }

  /* ── 键值行（详情页共用）─────────────────────────────── */
  function kv(k, v, cls) {
    return '<tr><td>' + k + '</td><td class="r ' + (cls || '') + '">' + v + '</td></tr>';
  }

  function notFound(what, why) {
    return '<div class="crumbs"><a href="#/overview">概览</a>›<span>未找到</span></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">NOT FOUND</span><span class="ph-fill"></span></div>' +
      '<div class="empty-box"><b>找不到 ' + esc(what) + '</b>' + esc(why) + '</div></div>';
  }

  /** 发射前 / 读取失败时的整页占位，用在所有详情页上。 */
  function pageMiss(title, status, note) {
    return '<div class="crumbs"><a href="#/overview">概览</a>›<span>' + esc(title) + '</span></div>' +
      '<div class="panel"><div class="ph"><span class="ph-t">' + esc(title) + '</span><span class="ph-fill"></span></div>' +
      '<div class="empty-box"><b>' + esc(miss(status)) + '</b>' + esc(note || '') + '</div></div>';
  }

  UI.rows = {
    missRow: missRow, emptyRow: emptyRow, stTag: stTag, methodTag: methodTag,
    toCell: toCell, propCell: propCell, splitCell: splitCell, gasCell: gasCell,
    blockRow: blockRow, txRow: txRow, agentRow: agentRow, hbSpark: hbSpark, selfName: selfName,
    flowRow: flowRow, nodeFundRow: nodeFundRow, ownerRow: ownerRow,
    validatorRow: validatorRow, epochRow: epochRow, epStateTag: epStateTag,
    treasuryRow: treasuryRow, kv: kv, notFound: notFound, pageMiss: pageMiss
  };
})(typeof window !== 'undefined' ? window : globalThis);
