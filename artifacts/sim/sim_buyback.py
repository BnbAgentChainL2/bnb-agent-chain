# -*- coding: utf-8 -*-
"""
回购付 BAC + 10 分钟纪元 + 2 分钟锚点等待 的经济重算。

对应决策 #20 / #20a / #21 / #24 / #24a / #24b / #25 / #25a。
输出 out/buyback.md，再由人整理进 RESULTS-buyback.md。

跑法：
    PYTHONIOENCODING=utf-8 python sim_buyback.py 2500

五个问题：
    Q1 三种付款口径（STOCK / JIT / HYBRID）对照
    Q2 10 分钟纪元下重新推导释放率与单地址上限
    Q3 2 分钟等待：中继被盗后 watchdog 的探测延迟要求
    Q4 验证者见证节奏（144 纪元/天的 BSC gas）
    Q5 回购本身：价格冲击、买入税回流比例、每纪元预算与滑点上限
"""
import sys
import numpy as np
import engine_epoch as EE
from engine_epoch import EPD, EPOCH_S, ANCHOR_WAIT_S, RECYCLE_TO_BRIDGE
from common import md_table, BNB_USD, SERVER_USD_MO, daily_tax, split_tax, FLAP_FEE

TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 2500
OUT = []

# ---- gas 口径（实测的标 [实测]，估算的标 [估算]，估算必须在 fork 上复核）----
GAS_COLLECT_BNB = 107_276     # [实测] 现在的 collect，付 BNB
GAS_CLAIMEXIT = 151_662       # [实测]
GAS_PAYOUT_CALL = 9_700       # [估算] call{value:}，已含在 GAS_COLLECT_BNB 里
GAS_ERC20_XFER = 60_000       # [估算] flap 税币的普通转账（非池子路径，不收税）
GAS_V2_SWAP = 180_000         # [估算] swapExactETHForTokensSupportingFeeOnTransferTokens
GAS_LIQUIDATION = 300_000     # [估算] 恰好触发 liquidationThreshold 的那一笔额外开销
GAS_BUYBACK_TX = 220_000      # [估算] 无许可 buyback() 一次
GAS_POSTANCHOR = 155_679      # [实测]
GAS_ATTEST_ROUND = 175_000    # commit + reveal
GAS_ATTEST_EXTRA = 3_000      # [估算] 批量见证里每多带一个纪元的边际 gas
BSC_GWEI = 0.05               # research/09-chain-truth.md 实测
TRIGGER_FEE = 0.0002          # [实测] Flap Trigger Service getFee()


def bnb(gas, gwei=BSC_GWEI):
    return gas * gwei * 1e-9


def w(s=""):
    print(s)
    OUT.append(s)


def q(x, p):
    return float(np.quantile(x, p))


def f2(x):
    return f"{x:.2f}"


def pc(x, n=3):
    return f"{100.0 * x:.{n}f}%"


# ==================================================================== Q1
def q1():
    w("## Q1 三种付款口径的对照")
    w()
    w(f"每行 {TRIALS} 条随机路径。30 天 = 4320 个纪元，预热 30 天。"
      f"市场模型：恒定乘积，报价侧深度 20 BNB，永久冲击占比 0.35，临时冲击每纪元衰减 8%。")
    w()

    # --- 1.1 公平性 ---
    rows = []
    store = {}
    for model in (EE.STOCK, EE.JIT, EE.HYBRID):
        for sc in ("dead", "modest", "viral"):
            cfg = EE.Cfg(scenario=sc, days=30, warmup_days=30, trials=TRIALS,
                         model=model, seed=101)
            r = EE.run(cfg, EE.FirstMover(M=20, crowd_day=7))
            la = r["locked_amt"][:, :1].sum(1)
            lc = r["locked_amt"][:, 1:].sum(1)
            ba = r["burned"][:, :1].sum(1)
            bc = r["burned"][:, 1:].sum(1)
            c1 = (la / np.maximum(ba, 1e-18)) / np.maximum(lc / np.maximum(bc, 1e-18), 1e-18)

            r2 = EE.run(EE.Cfg(scenario=sc, days=30, warmup_days=30, trials=TRIALS,
                               model=model, seed=102), EE.TwoExiters())
            big = r2["locked_amt"][:, 0] / np.maximum(r2["burned"][:, 0], 1e-18)
            small = r2["locked_amt"][:, 1] / np.maximum(r2["burned"][:, 1], 1e-18)
            hz = big / np.maximum(small, 1e-18)

            store[(model, sc)] = r
            rows.append([model, sc, f2(float(np.median(c1))) + "x",
                         f2(q(c1, 0.95)) + "x", f2(float(np.median(hz))) + "x",
                         f"{r['inv_worst']:.3e}"])
    w("### 1.1 先发优势（锁定汇率口径）与同纪元横向公平")
    w()
    w("`C1 先发` = A（第 0 天起每天挂 10%）每销毁 1 积分锁到的应付额 ÷ 其余 20 个 agent 的同一比值，"
      "**1.00 = 没有先发优势**。`C3 横向` = 同一纪元退出的大户(30%)/小户(1%) 的每积分锁定额之比。"
      "`不变式越界` = `owedTotal − 付款资产桶` 在全部纪元上的最大值，应当 ≤ 0。")
    w()
    w(md_table(["付款口径", "情景", "C1 先发 中位", "C1 p95", "C3 横向", "不变式最大越界"], rows))
    w()

    # --- 1.2 择时博弈 ---
    rows = []
    for model in (EE.STOCK, EE.JIT, EE.HYBRID):
        for bi in (1, 6, 36):
            cfg = EE.Cfg(days=30, warmup_days=30, trials=TRIALS, model=model,
                         buy_interval=bi, seed=201)
            r = EE.run(cfg, EE.Sniper(buy_interval=bi))
            snipe = r["locked_amt"][:, 0] / np.maximum(r["burned"][:, 0], 1e-18)
            rand = r["locked_amt"][:, 1] / np.maximum(r["burned"][:, 1], 1e-18)
            adv = snipe / np.maximum(rand, 1e-18)
            # 单纪元汇率跳变幅度
            rh = r["rate_hist"].astype(float)
            ok = (rh[:, :-1] > 0) & (rh[:, 1:] > 0)
            rel = np.where(ok, np.abs(np.diff(rh, axis=1)) / np.maximum(rh[:, :-1], 1e-30), 0.0)
            jump = np.max(rel, axis=1)
            rows.append([model, f"每 {bi} 纪元一次（{bi*10} 分钟）",
                         f2(float(np.median(adv))) + "x", f2(q(adv, 0.95)) + "x",
                         pc(float(np.median(jump)), 3), pc(q(jump, 0.99), 3)])
    w("### 1.2 择时博弈：盯着回购那一刻退出，能多拿多少")
    w()
    w("`狙击者` 每天只在**回购刚发生的那个纪元**挂退出，`随机者` 每天在随机纪元挂同样多的退出，"
      "两者持仓相同。`优势` = 狙击者每积分锁到的应付额 ÷ 随机者的，**1.00 = 盯着回购没有用**。"
      "`汇率单纪元跳变` = `rate` 在相邻两个纪元之间的最大相对变化（全路径最大值的中位 / p99）。")
    w()
    w(md_table(["付款口径", "回购节奏", "狙击优势 中位", "p95", "汇率跳变 中位", "p99"], rows))
    w()

    # --- 1.3 成本：税 + 滑点 + gas ---
    rows = []
    for model in (EE.STOCK, EE.JIT, EE.HYBRID):
        for sc in ("modest", "viral"):
            r = store[(model, sc)]
            bought = np.median(r["bought_bnb"])
            tax = np.median(r["tax_paid"])
            slip = np.median(r["slip_bnb"])
            if bought <= 0:
                rows.append([model, sc, "—", "—", "—", "—"])
                continue
            n_exit_calls = 30 * 21       # 21 个地址 × 30 天（catchup=144 -> 每天 1 次）
            if model == EE.JIT:
                gas_exit = GAS_COLLECT_BNB - GAS_PAYOUT_CALL + GAS_V2_SWAP
                gas_buy = 0.0
            else:
                gas_exit = GAS_COLLECT_BNB - GAS_PAYOUT_CALL + GAS_ERC20_XFER
                gas_buy = bnb(GAS_BUYBACK_TX) * (30 * EPD / 6)
            gas_tot = bnb(gas_exit) * n_exit_calls + gas_buy
            rows.append([model, sc, f"{bought:.3f}", pc(tax / bought, 2),
                         pc(slip / bought, 3), f"{gas_tot:.4f} ({pc(gas_tot/bought,2)})"])
    w("### 1.3 每 1 BNB 买盘预算里烧掉多少（30 天，中位）")
    w()
    w("`买入税` 固定 2%，其中 45% 会回到桥池、45% 进 owner 的节点基金、10% 归 Flap（见 Q5）。"
      "`滑点` 按成交前中间价计。`gas` 含 30 天里 21 个地址各 30 次 `collect`，STOCK/HYBRID 另加"
      f"每小时一次 `buyback()`（{GAS_BUYBACK_TX:,} gas [估算]）。")
    w()
    w(md_table(["付款口径", "情景", "投入市场 BNB", "买入税占比", "滑点占比", "gas 合计 BNB (占比)"], rows))
    w()

    # --- 1.4 每笔退出的价格冲击 ---
    rows = []
    for model in (EE.STOCK, EE.JIT, EE.HYBRID):
        for sc in ("modest", "viral"):
            r = store[(model, sc)]
            n = np.maximum(r["n_buys"], 1.0)
            avg = np.expm1(r["imp_sum"] / n)
            rows.append([model, sc, f"{np.median(r['n_buys']):.0f}",
                         pc(float(np.median(avg)), 4),
                         pc(float(np.median(r["imp_max"])), 3),
                         pc(q(r["imp_max"], 0.95), 3),
                         "0（退出不碰市场）" if model != EE.JIT else "= 该笔买入的冲击"])
    w("### 1.4 单笔买入的价格冲击，以及退出本身有没有冲击")
    w()
    w("`价格冲击` 只算买单对价格的推动（恒定乘积的 `2·ln(1+s_eff/X)`），"
      "不含外生行情噪声。STOCK 口径下退出只是把**已经买好的** BAC 从桥里转出去，"
      "**一笔退出对 BAC 价格的冲击恒为 0**；全部冲击都发生在按固定节奏执行的 `buyback()` 上。"
      "JIT 口径下每一次 `collect` 都是一笔真实的链上买单，冲击由退出者自己承担，"
      "而且**时间点完全可预测**（每个纪元边界之后固定出现），可被夹。")
    w()
    w(md_table(["付款口径", "情景", "30 天内买入笔数 中位", "单笔平均冲击",
                "单笔最大冲击 中位", "单笔最大冲击 p95", "退出本身的冲击"], rows))
    w()

    # --- 1.5 挤兑 ---
    rows = []
    for model in (EE.STOCK, EE.JIT):
        for sc in ("dead", "modest"):
            r = EE.run(EE.Cfg(scenario=sc, days=30, warmup_days=30, trials=TRIALS,
                              model=model, seed=301), EE.BankRun(s=40))
            cum_paid = np.cumsum(r["daily_paid"], axis=1)
            cum_in = np.cumsum(r["daily_in"], axis=1) + (
                r["p0_stock"] if model != EE.JIT else r["p0_bnb"])[:, None]
            frac = cum_paid / np.maximum(cum_in, 1e-30)
            rows.append([model, sc, pc(float(np.median(frac[:, 0])), 2),
                         pc(float(np.median(frac[:, 2])), 2),
                         pc(float(np.median(frac[:, 6])), 2),
                         pc(float(np.median(frac[:, 29])), 2)])
    w("### 1.5 挤兑：全部积分第 0 个纪元一次挂出、拆 40 个身份")
    w()
    w("表里是它累计领走的量 ÷ 同期「付款资产桶」累计收到的全部量（STOCK 算 BAC，JIT 算 BNB）。"
      "两种口径下这条线都只由 `RELEASE_DAILY_BPS` 决定 —— 这是决策 #21 / #25a 说的「唯一真正的闸门」。")
    w()
    w(md_table(["付款口径", "情景", "第 1 天", "第 3 天", "第 7 天", "第 30 天"], rows))
    w()

    # --- 1.6 HYBRID 的库存风险（BNB 计价 + 存货 = 会资不抵债）---
    w("### 1.6 HYBRID 的两个变体，以及为什么两个都被拒")
    w()
    w("C 有两种写法，模拟把两种都跑了：")
    w()
    w("**C-1「BNB 计价的债 + BAC 存货」**：`owed` 按 BNB 锁定（和今天一样），付款时从存货里按当时市价折算 BAC 发出。"
      "这引入**存货风险**：BAC 跌了，存货折成 BNB 就盖不住 BNB 计价的 `owed`，偿付不变式 "
      "`owedTotal <= 资产桶` 直接破。下表是 30 天里 `存货市值 < owedTotal` 的路径占比。")
    rows = []
    for sc in ("dead", "modest", "viral"):
        for sig in (0.006, 0.012, 0.025):
            cfg = EE.Cfg(scenario=sc, days=30, warmup_days=30, trials=TRIALS,
                         model=EE.STOCK, sigma=sig, seed=401)
            r = EE.run(cfg, EE.FirstMover(M=20, crowd_day=7))
            # C-1 等价：把 STOCK 的 owed(BAC) 换算成锁定当时的 BNB 值，再看存货市值够不够
            owed_bnb = r["locked_val"].sum(axis=1) - r["paid_bnbval"].sum(axis=1)
            stock_val = r["stock"] * r["price_hist"][:, -1].astype(float)
            short = owed_bnb > stock_val
            gap = (owed_bnb - stock_val) / np.maximum(stock_val, 1e-30)
            gm = float(np.median(gap[short])) if short.any() else 0.0
            gp = float(np.quantile(gap[short], 0.95)) if short.any() else 0.0
            rows.append([sc, f"每纪元 σ={sig:.3f}（日 σ≈{sig*np.sqrt(EPD)*100:.0f}%）",
                         pc(float(short.mean()), 1), pc(gm, 1), pc(gp, 1)])
    w()
    w(md_table(["情景", "BAC 波动率", "资不抵债路径占比", "缺口占存货 中位", "p95"], rows))
    w()
    w("**C-2「BAC 计价的债 + 领取时触发补买」**：`owed` 按 BAC 锁定（和 A 一样，偿付安全），"
      "但 `claimExit` / `collect` 会顺手触发一笔补买，好让闲置的 BNB 尽快变成 BAC。"
      "偿付没问题，**但它把回购的执行时点交给了调用者**：调用者可以先自己买、让桥在更高的价位买、再卖回去"
      "（三明治）。下表按夹击强度（桥的补买被推高多少）看桥少拿到多少 BAC。")
    rows = []
    base = None
    for mev in (0, 30, 100, 300, 1000):
        r = EE.run(EE.Cfg(days=30, warmup_days=30, trials=TRIALS, model=EE.HYBRID,
                          mev_bps_topup=mev, seed=501), EE.FirstMover(M=20, crowd_day=7))
        got = float(np.median(r["stock"] + r["paid_asset"].sum(axis=1)))
        if base is None:
            base = got
        rows.append([f"{mev} bps", f"{got:.4e}", pc(got / base - 1, 2),
                     f"{np.median(r['topups']):.0f}"])
    w()
    w(md_table(["补买被夹走的比例", "桥 30 天累计拿到的 BAC（中位）", "相对没人夹", "补买触发次数"], rows))
    w()
    w("**两个变体都被拒。** C-1 的问题是结构性的：只要债是 BNB 计价而资产是 BAC，"
      "偿付不变式就随 BAC 价格一起浮动，跌一波就资不抵债；上表 `modest` + 日波动 14% 时"
      "已经有五分之一的路径破了不变式。C-2 偿付是安全的，但它把回购的**执行时点**"
      "交给了任何一个调用者，等于给桥装了一个「按需触发的大买单」按钮 —— "
      "这正是三明治攻击最喜欢的形状。A 的定时回购没有这个按钮。")
    w()


# ==================================================================== Q2
def q2():
    w("## Q2 10 分钟纪元下重新推导释放率")
    w()
    w("旧规格 `RELEASE_BPS = 200/350/500` 是**每纪元**的。纪元从 24 小时改成 10 分钟之后，"
      "144 个纪元/天 × 2% = 每天 288%，池子当天见底。所以口径必须改成**按天表达、再除到纪元**。")
    w()

    rows = []
    for d_bps in (100, 150, 200, 250, 350, 500, 800):
        D = d_bps / 1e4
        lin = D / EPD
        exact = 1.0 - (1.0 - D) ** (1.0 / EPD)
        realized = 1.0 - (1.0 - lin) ** EPD
        rows.append([f"{d_bps}", pc(D, 2), f"{lin*1e6:.2f} ppm ({lin*1e4:.4f} bps)",
                     f"{exact*1e6:.2f} ppm", pc(realized, 4),
                     pc((realized - D) / D, 2)])
    w("### 2.1 从「每天 X%」到「每纪元释放多少」")
    w()
    w("合约里**不要**存一个小于 1 bps 的常数（1 bps = 0.01%，每纪元的释放率只有 1.39 bps，写不进整数 bps）。"
      "正确写法是把 `RELEASE_DAILY_BPS` 存成整数，除的时候一次除完：")
    w()
    w("```solidity")
    w("uint64 public constant EPOCH          = 600;     // 10 分钟")
    w("uint64 public constant EPOCHS_PER_DAY = 144;")
    w("// pot = free * RELEASE_DAILY_BPS / (10000 * EPOCHS_PER_DAY)")
    w("uint256 pot = ((poolBalance - reservedTotal) * bps) / (10000 * EPOCHS_PER_DAY);")
    w("```")
    w()
    w("`线性` 是上面这个写法（每纪元 D/144）；`精确` 是让 144 个纪元复利后正好等于 D。"
      "两者差 0.7%（线性略慢），**选线性**：少一次幂运算、少一个魔数，而且偏保守。")
    w()
    w(md_table(["RELEASE_DAILY_BPS", "每天目标", "线性：每纪元", "精确：每纪元",
                "线性口径的实际日释放", "相对目标"], rows))
    w()

    # 2.2 提取上限验证
    rows = []
    for tiers in ((100, 175, 250), (150, 250, 350), (200, 350, 500),
                  (300, 500, 800), (500, 750, 1000)):
        for nv in (0, 5):
            r = EE.run(EE.Cfg(scenario="modest", days=30, warmup_days=30, trials=TRIALS,
                              model=EE.STOCK, release_daily_bps=tiers,
                              n_validators=nv, seed=601), EE.BankRun(s=40))
            cum_paid = np.cumsum(r["daily_paid"], axis=1)
            cum_in = np.cumsum(r["daily_in"], axis=1) + r["p0_stock"][:, None]
            frac = cum_paid / np.maximum(cum_in, 1e-30)
            rows.append([f"{tiers[0]}/{tiers[1]}/{tiers[2]}", nv,
                         pc(float(np.median(frac[:, 0])), 2),
                         pc(float(np.median(frac[:, 2])), 2),
                         pc(float(np.median(frac[:, 6])), 2),
                         pc(float(np.median(frac[:, 29])), 2)])
    w("### 2.2 提取上限（旧验收标准的按天重述）")
    w()
    w("旧标准是「拆 40 个号、第 0 个纪元全额挂出，**3 个纪元** ≤ 15%、**30 个纪元** ≤ 80%」，"
      "而旧纪元 = 1 天，所以按天重述就是 **3 天 ≤ 15%、30 天 ≤ 80%**。"
      "下表用 10 分钟纪元、144 个纪元/天的引擎重跑同一个攻击。")
    w()
    w(md_table(["RELEASE_DAILY_BPS", "验证者数", "1 天", "3 天", "7 天", "30 天"], rows))
    w()

    # 2.3 单地址上限与 catchup
    rows = []
    for cap in (500, 1000, 2500):
        for catch in (1, EPD):
            r = EE.run(EE.Cfg(scenario="modest", days=30, warmup_days=30, trials=TRIALS,
                              model=EE.STOCK, cap_bps=cap, catchup=catch, seed=701),
                       EE.SoleExiter(s=1, whale=1_000_000.0, other=9_000_000.0,
                                     day0_all=True))
            tot = r["paid_asset"][:, 0] + r["owed"][:, 0]
            cum = np.cumsum(r["tracked_daily"], axis=1)
            ok = cum >= (0.9 * tot)[:, None]
            days90 = np.where(ok.any(axis=1), ok.argmax(axis=1) + 1, 31)
            calls_per_day = 1 if catch == EPD else EPD
            gas_yr = bnb((GAS_COLLECT_BNB - GAS_PAYOUT_CALL + GAS_ERC20_XFER)) * calls_per_day * 365
            rows.append([cap, "1（每纪元都得调）" if catch == 1 else "144（一天调一次即可）",
                         f"{calls_per_day}", f"{np.median(days90):.0f}",
                         f"{gas_yr:.4f}",
                         pc(cap / 1e4 * min(catch, EPD) / EPD * 1.0, 4)])
    w("### 2.3 单地址上限 `MAX_EXIT_SHARE_BPS` 与「补领窗口」")
    w()
    w("**这是 10 分钟纪元逼出来的一处必改。** 现在的 `collect` 是「每地址每纪元最多领 `lastPot × 10%`」，"
      "跳过的纪元**不能补领**。纪元缩到 10 分钟之后，想按自己应得的速度领钱就得**一天调 144 次 `collect`**。")
    w()
    w("改法：把上限乘上「距上次领取过了几个纪元」，并封顶在 `MAX_CATCHUP_EPOCHS = 144`（一天）：")
    w()
    w("```solidity")
    w("uint64 public constant MAX_CATCHUP_EPOCHS = 144;")
    w("uint64 elapsed = e - lastCollectEpoch[msg.sender];")
    w("if (elapsed > MAX_CATCHUP_EPOCHS) elapsed = MAX_CATCHUP_EPOCHS;")
    w("uint256 cap = (lastPot * MAX_EXIT_SHARE_BPS * elapsed) / 10000;")
    w("```")
    w()
    w("这样**单地址的日均速率上限和旧口径逐字相同**（旧：每天最多领当日释放额的 10%），"
      "小偷一点便宜都没占到，诚实用户的 `collect` 次数从 144 次/天降回 1 次/天。")
    w()
    w(md_table(["cap_bps", "MAX_CATCHUP_EPOCHS", "要达到上限速度的 collect 次数/天",
                "持 10% 者领到九成(天)", "该地址一年 collect 的 gas BNB", "单地址日上限（占当日释放额）"], rows))
    w()

    # 2.4 其他必须跟着改的常量
    w("### 2.4 其他被「纪元 = 10 分钟」打破的常量")
    w()
    rows = [
        ["`EPOCH`", "86400", "**600**", "决策 #20"],
        ["`EPOCHS_PER_DAY`", "（没有）", "**144**（新增，用作释放率的除数）", "Q2.1"],
        ["`CHALLENGE_WINDOW` → `ANCHOR_WAIT`", "24 hours", "**120 s**", "决策 #25 + #18 术语"],
        ["`RELEASE_BPS` → `RELEASE_DAILY_BPS`", "200/350/500（每纪元）", "**200/350/500（每天）**", "Q2.1 / Q2.2"],
        ["`MAX_EXIT_SHARE_BPS`", "1000（每纪元，不可补领）", "**1000 + `MAX_CATCHUP_EPOCHS = 144`**", "Q2.3"],
        ["`NO_ATTEST_WINDOW`", "30（纪元 = 30 天）", "**30 天 = 4320 纪元**，实现成 30 个「按天」的环形桶", "见下"],
        ["`NO_ATTEST_WINDOW_BPS`", "1500", "1500（不变，含义仍是 30 天 15%）", "见下"],
        ["`SETTLE_GRACE`", "7 days", "7 days（不变）", "未模拟，是活性参数"],
        ["`OWED_MATURITY`", "14 days", "**14 days，绝对不许跟着缩**", "Q3"],
        ["`ESCAPE_ARM_DELAY`", "14 days", "14 days（不变）", "未模拟"],
        ["`PAUSE_LEN` / `MAX_PAUSE_TOTAL`", "7 days / 21 days", "7 days / 21 days（不变）", "Q3 里有一条关于它的严重结论"],
    ]
    w(md_table(["常量", "旧值", "新值", "依据"], rows))
    w()
    w("**`NO_ATTEST_WINDOW` 是一处会被漏掉的致命项。** 现在的写法是「最近 30 个纪元里，"
      "零见证人的纪元合计最多释放桥池的 15%」，靠一个 30 格的环形数组实现。"
      f"纪元变成 10 分钟之后，30 个纪元 = 5 小时，这条上限就变成 **15% / 5 小时 = 72%/天**，"
      "等于完全失效。必须把窗口改回 **30 天**；但 4320 格的环形数组太贵，"
      "实现成 **30 个按天聚合的桶**（`potRing[(epoch / 144) % 30]`），gas 和今天一样。")
    w()


# ==================================================================== Q3
def q3():
    w("## Q3 2 分钟锚点等待：中继被盗后 watchdog 的探测延迟要求")
    w()
    w("**时间线**（全部以秒计，BSC 出块 3 s）：")
    w()
    w("```")
    w("t=0      被盗的中继 postAnchor() 提交一个把自己写进去的假 exitRoot")
    w("t=120    ANCHOR_WAIT 到期，锚点 FINAL。此刻起 veto 已经不可能")
    w("t>=120   小偷 claimExit()：当场按 rate = (资产桶 − owedTotal)/creditsOutstanding")
    w("         把**整个未占用的资产桶**锁成自己的 owed，积分当场销毁")
    w("t=下一个纪元边界  settleEpoch() 释放 pot = free × RELEASE_DAILY_BPS/(1e4×144)")
    w("t=...    collect()：拆 >=10 个身份即可吃掉整个 pot")
    w("t=L+I    watchdog 探测到（延迟 L）+ 交易上链（I≈7 s：签名 1 s + 2 个 BSC 块）")
    w("```")
    w()

    rng = np.random.default_rng(909)
    T = max(TRIALS, 5000)
    rows = []
    for L, name in ((10, "10 s"), (60, "60 s"), (300, "5 min"), (900, "15 min"),
                    (3600, "1 h"), (21600, "6 h"), (86400, "24 h")):
        for dbps in (200, 500):
            D = dbps / 1e4
            r_e = D / EPD
            # 小偷可以自由选择相对纪元边界的时点：取最有利的对齐（offset -> 0+）
            incl = 3.0 * rng.integers(1, 4, size=T) + rng.random(T)   # 1-3 个块 + 签名
            t_pause = L + incl
            # 假根成熟到暂停之间跨过的纪元边界数（最坏对齐：第一个边界正好在 t=120+）
            win = np.maximum(t_pause - ANCHOR_WAIT_S, 0.0)
            n_pot = np.floor(win / EPOCH_S) + np.where(win > 0, 1.0, 0.0)
            n_pot = np.minimum(n_pot, np.floor(win / EPOCH_S) + 1)
            extracted = 1.0 - (1.0 - r_e) ** n_pot
            rows.append([name, f"{dbps} (每天 {D*100:.0f}%)",
                         f"{int(np.median(n_pot))}",
                         pc(float(np.median(extracted)), 4),
                         pc(float(np.quantile(extracted, 0.95)), 4),
                         "是" if np.median(t_pause) < ANCHOR_WAIT_S else "否"])
    w("### 3.1 暂停之前能真正搬走多少（占资产桶）")
    w()
    w(f"每行 {T} 条随机路径（随机化上链延迟），纪元边界按**对小偷最有利**的方式对齐。"
      "`赶得上 veto` = 暂停交易在 t=120 s 之前上链，也就是还能在锚点 FINAL 之前否决它。")
    w()
    w(md_table(["watchdog 探测延迟", "RELEASE_DAILY_BPS", "跨过的纪元数 中位",
                "被搬走 中位", "p95", "赶得上 veto"], rows))
    w()
    w("**读法：搬走的钱本身一直很小** —— 连 24 小时都发现不了，也只是把当天的释放额（2%–5%）送掉。"
      "这不是好消息，下一节才是重点。")
    w()

    w("### 3.2 真正的损失不是被搬走的那一点，是被锁死的 `owed`")
    w()
    w("`claimExit` 不动钱，它只是**把整个未占用资产桶锁成小偷的债权**，而且积分当场销毁。"
      "此后：")
    w()
    w("- `pause()` 只能停住 `collect`，**不会撤销已经锁定的 `owed`**。"
      f"`PAUSE_LEN = 7 天`、`MAX_PAUSE_TOTAL = 21 天` 一到期，小偷接着按每天 2%–5% 领，"
      "把整个桥领空只是时间问题。")
    w("- `veto` 只在 `postedAt + 120 s` 之前可用（`ChainAnchor` 里就是这么写的）。**错过这 120 秒，"
      "否决路径就永久关闭了。**")
    w("- 停机逃生里那条「不成熟的 `owed` 降级为次级」只在 `haltCause == 2 或 3`（有人 veto 了根 / "
      "验证者多数否决了根）时生效。上线时验证者是 0 个、veto 窗口只有 120 秒，"
      "**这两个 cause 实际上都摸不到**，所以这道保护在 2 分钟等待下等于不存在。")
    w()
    rows = []
    for dbps in (200, 500):
        D = dbps / 1e4
        for days_after in (7, 21, 30, 60, 90, 180):
            got = 1.0 - (1.0 - D) ** days_after
            rows.append([f"{dbps} (每天 {D*100:.0f}%)", f"{days_after} 天", pc(got, 1)])
    w("**假设没有「事后撤销」这条路**：暂停到期后小偷按日上限连续领，累计搬走（占锁定那一刻的资产桶）：")
    w()
    w(md_table(["RELEASE_DAILY_BPS", "暂停到期后经过", "累计搬走"], rows))
    w()
    w("### 3.3 结论：watchdog 必须达到的指标，以及必须新增的一条链上路径")
    w()
    w("1. **零损失的唯一条件是赶在 120 秒内 veto。** 预算：探测延迟 L + 上链延迟 I(≈7 s，2 个 BSC 块) "
      "+ 30 s 安全余量 < 120 s ⇒ **L ≤ 83 s**。工程上取 **轮询间隔 ≤ 10 s、端到端探测延迟 ≤ 30 s**，"
      "并且 watchdog 私钥必须是**热钥**、`veto()` 必须允许 watchdog 无条件调用。")
    w("2. **每天最多 2%–5% 这条闸门在任何延迟下都成立**，包括完全没人看的情况 —— "
      "这就是决策 #21 / #25a 说的那句话的数值依据。但它只限速，不止损。")
    w("3. **必须补一条事后撤销路径，否则 2 分钟等待把桥变成「慢慢被领空」。** 建议："
      "`revokeEpochOwed(uint64 epoch)`，在暂停期间由 watchdog 调用，把该锚点纪元里锁定的 `owed` "
      "整批作废并退回资产桶；被误伤的诚实 agent 凭修正后的根重新 `claimExit`。"
      "没有这条路径，「暂停开关」这个兜底在数学上只是把损失推迟 7–21 天。")
    w("4. **`OWED_MATURITY = 14 天` 绝对不能跟着纪元一起缩。** 它是停机逃生里唯一还能区分"
      "「真实旧债权」和「刚刚伪造的债权」的东西；等待期缩到 2 分钟之后，它是唯一剩下的时间护栏。")
    w()


# ==================================================================== Q4
def q4():
    w("## Q4 验证者见证节奏")
    w()
    machine = SERVER_USD_MO / BNB_USD
    rows = []
    for N, name in ((1, "每个纪元（144 次/天）"), (6, "每 6 个纪元（每小时）"),
                    (12, "每 12 个纪元（每 2 小时）"), (36, "每 36 个纪元（每 6 小时）"),
                    (144, "每 144 个纪元（每天）")):
        rounds_day = EPD / N
        gas_mo = bnb(GAS_ATTEST_ROUND) * rounds_day * 30
        claim_mo = bnb(65_000) * 30 / 7.0
        tot = machine + gas_mo + claim_mo
        rows.append([name, f"{rounds_day*2:.0f}", f"{gas_mo:.5f}", f"{tot:.5f}",
                     f"{tot*12:.4f}", f"{tot/0.00889:.1f}x",
                     f"{EPD/N/EPD*100:.2f}%"])
    # 批量见证
    for M, name in ((6, "批量 6 个纪元/轮（每小时 1 轮）"),
                    (36, "批量 36 个纪元/轮（每 6 小时 1 轮）"),
                    (144, "批量 144 个纪元/轮（每天 1 轮）")):
        rounds_day = EPD / M
        gas_round = GAS_ATTEST_ROUND + (M - 1) * GAS_ATTEST_EXTRA
        gas_mo = bnb(gas_round) * rounds_day * 30
        claim_mo = bnb(65_000) * 30 / 7.0
        tot = machine + gas_mo + claim_mo
        rows.append([f"**{name}**", f"{rounds_day*2:.0f}", f"{gas_mo:.5f}", f"{tot:.5f}",
                     f"{tot*12:.4f}", f"{tot/0.00889:.1f}x", "100.00%"])
    w("### 4.1 成本线（口径与旧表逐字一致：机器 5 USD/月、BNB = 600 USD、BSC 0.05 gwei）")
    w()
    w(f"旧表的成本线是 **0.00889 BNB/月/节点**（机器 0.00833 + gas 0.00055），那是"
      f"**每天 1 个纪元**时的数。每轮 commit+reveal 约 {GAS_ATTEST_ROUND:,} gas，"
      f"每 7 天一次 claim 约 65,000 gas。`覆盖率` = 有见证的纪元占全部纪元的比例。")
    w()
    w(md_table(["见证节奏", "BSC 交易/天", "gas BNB/月", "成本线 BNB/月",
                "BNB/年", "相对旧成本线", "纪元覆盖率"], rows))
    w()
    w("**每纪元见证（决策 #20a 里担心的那一档）把成本线抬高 5.2 倍，一年 0.55 BNB。**"
      "抽样见证（每 N 个纪元见一次）能把 gas 打下来，但代价是 **(N−1)/N 的纪元没有见证人**，"
      f"而 `releaseBpsFor(epoch)` 正是按见证人数选档的 —— 抽样等于把绝大多数纪元锁在"
      "「0 见证人」的最低档（每天 2%），同时触发 `NO_ATTEST_WINDOW` 的零见证上限。"
      "**所以抽样不可用；正确解法是批量见证。**")
    w()
    w("批量见证 = 一轮 commit+reveal 里带一个覆盖 M 个连续纪元的 Merkle 根（或哈希链头），"
      f"每多带一个纪元的边际 gas 只有约 {GAS_ATTEST_EXTRA:,}（一次 keccak + 一个 word 的 calldata）。"
      "**每天一轮、一轮带 144 个纪元**，成本线回到 **0.00924 BNB/月**，和旧表的 0.00889 只差 4%，"
      "而且纪元覆盖率是 100%。")
    w()
    w("**随之必须改的一条**：批量见证要到一天结束后才上链，而 `settleEpoch` 在锚点 FINAL 后 2 分钟"
      "就能执行，那时这一批还没到。所以 `releaseBpsFor(epoch)` 不能再读「本纪元的 `agreeingCount`」，"
      "必须改成读**滚动窗口内的在册见证人数**（例如最近 144 个纪元里至少交过一轮的 validator 地址数）。"
      "否则每一个纪元在结算那一刻都是 0 见证人，释放档永远停在最低档。")
    w()

    # 4.2 自由进入均衡
    rng = np.random.default_rng(77)
    rows = []
    for sc in ("dead", "modest", "viral"):
        tax = daily_tax(sc, 395, TRIALS, rng)
        _, node_in = split_tax(tax)
        steady_mo = float(np.median(node_in[:, -90:].mean(axis=1))) * 30.0 * 0.40   # 取尾部 90 天=稳态，与旧表 2.6 同口径
        for cost, cname in ((0.00889, "旧表（每天 1 个纪元）"),
                            (machine + bnb(GAS_ATTEST_ROUND) * EPD * 30 + bnb(65_000) * 30 / 7,
                             "每纪元见证"),
                            (machine + bnb(GAS_ATTEST_ROUND + 143 * GAS_ATTEST_EXTRA) * 30
                             + bnb(65_000) * 30 / 7, "批量 144/轮，每天 1 轮")):
            n1 = steady_mo / cost
            rows.append([sc, cname, f"{steady_mo:.4f}", f"{cost:.5f}",
                         f"{n1:.1f}", f"{n1/2:.1f}",
                         "**必亏**" if n1 < 1 else ("勉强" if n1 < 3 else "可行")])
    w("### 4.2 自由进入均衡：这条链养得起几个节点")
    w()
    w("`N* = 每月奖励注入 ÷ 成本线`（`VALIDATOR_BPS = 4000`）。`N* < 1` 的意思是"
      "**连第一个节点都是亏的**，没人会开机。")
    w()
    w(md_table(["情景", "见证节奏", "稳态月注入 BNB", "成本线 BNB/月",
                "N* @1x 打平", "N* @2x 值得做", "结论"], rows))
    w()

    # 4.3 中继与触发器成本
    relay_anchor = bnb(GAS_POSTANCHOR) * EPD * 365
    relay_settle = bnb(120_000) * EPD * 365
    trig_epoch = TRIGGER_FEE * EPD * 365
    trig_day = TRIGGER_FEE * 365
    rows = [
        ["`postAnchor`", f"{GAS_POSTANCHOR:,} gas [实测]", f"{EPD}/天", f"{relay_anchor:.3f}"],
        ["`settleEpoch`", "120,000 gas [估算]", f"{EPD}/天", f"{relay_settle:.3f}"],
        ["`buyback()`", f"{GAS_BUYBACK_TX:,} gas [估算]", "24/天（每小时）", f"{bnb(GAS_BUYBACK_TX)*24*365:.3f}"],
        ["Flap Trigger Service", f"{TRIGGER_FEE} BNB/次 [实测]", f"**{EPD}/天**", f"**{trig_epoch:.2f}**"],
        ["Flap Trigger Service", f"{TRIGGER_FEE} BNB/次 [实测]", "1/天", f"{trig_day:.3f}"],
    ]
    w("### 4.3 运营方自己的每年账（不是验证者的）")
    w()
    w(md_table(["动作", "单价", "频率", "BNB/年"], rows))
    w()
    w(f"**Flap Trigger Service 是这张表里唯一会爆的一项。** `getFee()` 实测 {TRIGGER_FEE} BNB/次，"
      f"按每纪元触发一次是 **{trig_epoch:.2f} BNB/年**，比中继全部 gas 加起来还贵一个量级。"
      "结论：**纪元推进绝对不能挂在 Flap Trigger Service 上**，用我们自己的中继 cron"
      f"（反正已经在跑），或者把触发器降到每天 1 次（{trig_day:.3f} BNB/年）。"
      "`research/09-chain-truth.md` 里那句「一天一次纪元触发的年成本 ≈ 0.073 BNB」是按旧纪元写的，必须改。")
    w()


# ==================================================================== Q5
def q5():
    w("## Q5 回购本身")
    w()
    w("### 5.1 单笔回购的价格冲击")
    w()
    w("恒定乘积模型：买入 s BNB（毛额），先扣 2% 买入税，PCS 再扣 0.25% 池子手续费，"
      "剩下的 `s_eff` 进池子，滑点 = `s_eff / (X + s_eff)`（X = 报价侧深度，BNB）。"
      "**这是模型假设**：flap 内盘曲线的 `r / h / k` 没有公开闭式，"
      "上线前必须在 fork 上用真实曲线复核一次。")
    w()
    rows = []
    for venue, fee in (("flap 内盘曲线", 0.0), ("PancakeSwap V2", 0.0025)):
        for X in (5.0, 10.0, 20.0, 50.0, 150.0):
            cells = []
            for s in (0.01, 0.05, 0.2, 1.0, 5.0):
                se = s * (1 - 0.02) * (1 - fee)
                cells.append(pc(se / (X + se), 2))
            rows.append([venue, f"{X:.0f}"] + cells)
    w(md_table(["场所", "深度 X (BNB)", "买 0.01", "买 0.05", "买 0.2", "买 1.0", "买 5.0"], rows))
    w()
    w("**恒定乘积是路径无关的**：同样的总额，一次买完和拆成 100 次买完，拿到的代币总数一样。"
      "拆小**唯一**的好处是让套利在两笔之间把价格拉回去一部分 —— 这个好处的大小完全取决于"
      "临时冲击的衰减速度，下面 5.3 扫了它。")
    w()

    # 5.2 买入税回流
    w("### 5.2 买入税的回流比例（桥自己交的税，有一部分会回到桥）")
    w()
    w("桥回购时交的 2% 买入税和任何人交的税走同一条路：")
    w()
    w("```")
    w("2% 买入税 -> TaxProcessor -> Flap 协议费 10%")
    w("                          -> 金库 90% -> 桥池 45% / 节点基金 45%")
    w("```")
    w()
    rows = []
    for tax in (0.02,):
        back = tax * RECYCLE_TO_BRIDGE
        mult = 1.0 / (1.0 - back)
        rows.append(["每 1 BNB 预算最终投入市场的总额（含回流再投）", f"{mult:.5f} BNB"])
        rows.append(["其中累计交掉的买入税", f"{tax*mult:.5f} BNB（{pc(tax*mult,3)}）"])
        rows.append(["**回流到桥池的部分**", f"**{back*mult:.5f} BNB（{pc(back*mult,3)}）**"])
        rows.append(["漏给 owner 的节点基金", f"{back*mult:.5f} BNB（{pc(back*mult,3)}）"])
        rows.append(["漏给 Flap 协议费", f"{tax*FLAP_FEE*mult:.5f} BNB（{pc(tax*FLAP_FEE*mult,3)}）"])
        rows.append(["净税收漏出（不含滑点）", f"{(tax*mult-back*mult):.5f} BNB（{pc(tax*mult-back*mult,3)}）"])
    w(md_table(["项", "值"], rows))
    w()
    w("**回流比例 = 2% × 45% = 0.9%**，几何求和后桥的有效投入被放大 **1.00908 倍**。"
      "换句话说：**每 1 BNB 的回购预算，有 0.908% 会自己回来再买一次，另有 0.908% 白送给 owner 的节点基金、"
      "0.202% 白送给 Flap。** 净的税收漏出只有 1.110%，不是 2%。")
    w()

    # 5.3 预算 / 节奏 / 滑点上限扫描
    w("### 5.3 每纪元回购预算、节奏与滑点上限")
    w()
    rows = []
    for dbps in (500, 1000, 2000, 5000, 10000):
        for bi in (1, 6, 36, 144):
            r = EE.run(EE.Cfg(scenario="modest", days=30, warmup_days=30, trials=TRIALS,
                              model=EE.STOCK, buyback_daily_bps=dbps, buy_interval=bi,
                              seed=801), EE.FirstMover(M=20, crowd_day=7))
            bought = np.median(r["bought_bnb"])
            slip = np.median(r["slip_bnb"])
            gas_yr = bnb(GAS_BUYBACK_TX) * (EPD / bi) * 365
            idle = np.median(r["bnb_pool"]) / max(np.median(r["bnb_pool"]) +
                                                  np.median(r["bought_bnb"]), 1e-30)
            rows.append([f"{dbps} ({dbps/100:.0f}%/天)", f"{bi} ({bi*10} 分钟)",
                         f"{bought:.3f}", pc(slip / max(bought, 1e-30), 3),
                         f"{gas_yr:.3f}", pc(float(idle), 1)])
    w(f"每行 {TRIALS} 条随机路径，`modest` 情景、30 天、深度 20 BNB。"
      "`闲置 BNB 占比` = 30 天末还躺在桥里没换成 BAC 的 BNB ÷（它 + 已投入市场的）—— "
      "这部分钱**不计入退出者的汇率**，所以它越大，退出者拿得越少、买盘越慢。")
    w()
    w(md_table(["BUYBACK_DAILY_BPS", "回购间隔（纪元）", "30 天投入市场 BNB",
                "滑点占比", "buyback() gas BNB/年", "闲置 BNB 占比"], rows))
    w()

    # 5.4 端到端
    w("### 5.4 每 1 BNB 的交易税，最后有多少变成桥里的 BAC")
    w()
    rows = []
    for slip in (0.000, 0.002, 0.005, 0.010, 0.020):
        mult = 1.0 / (1.0 - 0.02 * RECYCLE_TO_BRIDGE)
        to_bridge = 0.45
        eff = to_bridge * mult * 0.98 * (1 - slip)
        exiter_bnb = eff * 0.98 * (1 - slip)
        rows.append([pc(slip, 2), f"{to_bridge:.4f}", f"{eff:.4f}",
                     pc(eff / to_bridge - 1, 2), f"{exiter_bnb:.4f}",
                     pc(exiter_bnb / to_bridge - 1, 2)])
    w("口径：1 BNB 的交易税 → Flap 协议费 10% → 金库 0.90 → 桥池 0.45 / 节点基金 0.45。"
      "桥用它的 0.45 去回购（含 0.9% 回流），得到的 BAC 按**成交前中间价**折成 BNB 记账。"
      "最后一列是「退出者拿到 BAC 之后又想换回 BNB」的情形（再付 2% 卖出税 + 同样的滑点）。")
    w()
    w(md_table(["单边滑点", "旧口径：退出者拿到的 BNB", "新口径：桥里 BAC 的中间价市值",
                "相对旧口径", "退出者换回 BNB 后", "相对旧口径"], rows))
    w()
    w("**这就是决策 #24b 那个「约 4%」的数值来源，而且实际略差一点：**"
      "单边滑点 0.5% 时，桥里 BAC 的中间价市值是旧口径的 **98.4%（−1.60%）**，"
      "退出者若再换回 BNB 只剩 **95.95%（−4.05%）**。"
      "滑点 1% 时是 **−5.02%**，滑点 2% 时是 **−6.93%**。"
      "决策 #24b 写的「约 4%」在滑点 0.5% 这一档是对的，"
      "**但文案必须写成「至少 4%，滑点大时到 7%」，不能写成「约 4%」一个数**。")
    w()
    w("**这 4%–5% 不是「烧掉」，是转移，必须说清转给谁：**")
    w()
    w(md_table(["拿走的人", "占退出者那笔钱", "说明"], [
        ["owner 的官方节点基金", "约 1.8%", "买入 2% 和卖出 2% 各有 45% 流进节点基金，而节点基金是 owner 可提的（决策 #10）"],
        ["Flap 协议", "约 0.4%", "两笔税各 10% 的协议费"],
        ["桥池自己", "约 1.8%（回流）", "两笔税各 45% 回到桥池，等于还给全体退出者"],
        ["池子与其他 BAC 持有者", "= 滑点，单边 0.2%–2%", "买盘推高的价差留在池子里"],
    ]))
    w()
    w("**必须逐字写进文案的一句**：退出改拿 BAC 之后，退出者每走一次市场，"
      "就有大约 0.9% 落进 owner 可提的节点基金；来回两趟就是约 1.8%。"
      "这不是阴谋，是 50/50 分账的自然后果，但它是**新增的利益冲突**，必须和"
      "「owner 可提节点基金这一半」写在同一段里。")
    w()


def main():
    w("# 回购付 BAC + 10 分钟纪元 的模拟原始输出")
    w()
    w(f"`python sim_buyback.py {TRIALS}` 的原始输出，整理稿见 `RESULTS-buyback.md`。")
    w()
    q1()
    q2()
    q3()
    q4()
    q5()
    import os
    os.makedirs("out", exist_ok=True)
    with open("out/buyback.md", "w", encoding="utf-8") as f:
        f.write("\n".join(OUT) + "\n")
    print("\n-> out/buyback.md")


if __name__ == "__main__":
    main()
