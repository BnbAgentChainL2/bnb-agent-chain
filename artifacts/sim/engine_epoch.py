# -*- coding: utf-8 -*-
"""
10 分钟纪元 + 回购付 BAC 的桥池引擎（决策 #20 / #24 / #25 之后）。

与 engine.py 的区别
-------------------
1. 时间步从「1 天」改成「1 个纪元 = 600 秒」，`EPD = 144` 个纪元/天。
2. 释放率改成**按天表达、再除到纪元**：`pot_e = free * RELEASE_DAILY_BPS / (1e4 * EPD)`。
3. 桥里有两个 BAC 桶（决策 #24a）：
   - `lockedBac`  进场锁进来的，永久锁死，唯一出口是 burnLocked() → 死地址。本引擎只做账，从不动它。
   - `buybackBac` 市场上回购来的，**唯一**用于付退出。
4. 三种付款口径：
   - STOCK  (A) 桥按有界预算持续回购、囤 BAC，退出时按 BAC 计价锁定份额。
   - JIT    (B) 退出按 BNB 计价锁定（和今天一样），collect 时现场换成 BAC 发出去。
   - HYBRID (C) 连续回购 + 领取时不够就现场补买。两个变体见 sim_buyback.py 的说明。
5. 市场模型：恒定乘积（flap 内盘曲线 / PancakeSwap V2 都是 x*y=k 形状），
   买入税 2% 在报价侧先扣，PCS 再多 0.25% 手续费；冲击分永久/临时两部分，
   临时部分按 kappa 每纪元衰减（套利把价格拉回去）。这是**模型假设**，不是实测值。

本文件不做任何收益承诺，只做算术。
"""
import numpy as np
from common import daily_tax, FLAP_FEE, BRIDGE_SHARE, MKT_BPS

EPOCH_S = 600
EPD = 144                      # 纪元/天
ANCHOR_WAIT_S = 120            # 决策 #25

BUY_TAX = 0.02
SELL_TAX = 0.02
# 任何一笔在本币上交的税，有 0.9*0.5 = 45% 会回到桥池 —— 包括桥自己回购时交的买入税。
RECYCLE_TO_BRIDGE = (1.0 - FLAP_FEE) * MKT_BPS * BRIDGE_SHARE     # 0.45

STOCK = "STOCK"
JIT = "JIT"
HYBRID = "HYBRID"
MODELS = (STOCK, JIT, HYBRID)


# ----------------------------------------------------------------- 市场

class Market:
    """BAC 的报价侧深度 X（BNB）与价格 P（BNB/BAC）。恒定乘积 + 冲击衰减。

    venue = "curve"  flap 内盘：只有 2% 买入税，没有额外手续费
    venue = "pcs"    PancakeSwap V2：2% 买入税 + 0.25% 池子手续费
    """

    def __init__(self, trials, x0=20.0, p0=2e-8, phi=0.35, kappa=0.08,
                 sigma=0.012, venue="curve", rng=None):
        self.T = trials
        self.X = np.full(trials, float(x0))
        self.logP = np.full(trials, np.log(p0))
        self.temp = np.zeros(trials)
        self.phi = phi                      # 永久冲击占比
        self.kappa = kappa                  # 临时冲击每纪元衰减比例
        self.sigma = sigma                  # 每纪元外生对数收益标准差
        self.fee = 0.0025 if venue == "pcs" else 0.0
        self.venue = venue
        self.rng = rng
        self.bought_bnb = np.zeros(trials)  # 累计投入市场的 BNB（含税前）
        self.tax_paid = np.zeros(trials)    # 累计交出去的买入税 BNB
        self.slip_bnb = np.zeros(trials)    # 累计滑点损耗 BNB（按成交前中间价计）
        self.imp_max = np.zeros(trials)     # 单笔买入的最大价格冲击（相对）
        self.imp_sum = np.zeros(trials)     # 累计价格冲击（对数）
        self.n_buys = np.zeros(trials)      # 真正成交过的买入笔数

    def price(self):
        return np.exp(self.logP + self.temp)

    def buy(self, s):
        """用 s BNB（毛额，含买入税）买 BAC。返回 (tokens, tax_bnb, slip_bnb)。"""
        s = np.maximum(s, 0.0)
        tax = s * BUY_TAX
        s_eff = (s - tax) * (1.0 - self.fee)
        P = self.price()
        frac = np.where(self.X > 0, s_eff / (self.X + s_eff), 0.0)
        tokens = np.where(P > 0, (s_eff / np.maximum(P, 1e-300)) * (1.0 - frac), 0.0)
        # 滑点损耗：按成交前中间价，本该买到 s_eff/P，实际买到 tokens
        slip = s_eff * frac
        # 价格冲击 = 2*ln(1+s_eff/X)，拆成永久/临时
        imp = 2.0 * np.log1p(np.where(self.X > 0, s_eff / self.X, 0.0))
        self.logP += self.phi * imp
        self.temp += (1.0 - self.phi) * imp
        self.X = self.X + self.phi * s_eff
        self.bought_bnb += s
        self.tax_paid += tax
        self.slip_bnb += slip
        self.imp_max = np.maximum(self.imp_max, np.expm1(imp))
        self.imp_sum += imp
        self.n_buys += (s > 0).astype(float)
        return tokens, tax, slip

    def sell_value(self, tokens):
        """退出者拿到 BAC 后若想换回 BNB，能拿到多少（2% 卖出税 + 滑点）。只算账，不改价。"""
        P = self.price()
        X = self.X
        if np.ndim(tokens) == 2:
            P = P[:, None]
            X = X[:, None]
        v = tokens * P
        frac = np.where(X > 0, v / (X + v), 0.0)
        out = v * (1.0 - frac) * (1.0 - self.fee) * (1.0 - SELL_TAX)
        return out

    def step(self):
        self.temp *= (1.0 - self.kappa)
        if self.sigma > 0 and self.rng is not None:
            self.logP += self.rng.normal(-self.sigma ** 2 / 2, self.sigma, size=self.T)


# ----------------------------------------------------------------- 配置

class Cfg:
    def __init__(self, scenario="modest", days=30, warmup_days=3, trials=2500,
                 model=STOCK, release_daily_bps=(200, 350, 500),
                 cap_bps=1000, catchup=EPD,
                 buyback_daily_bps=2000, min_buy_bnb=0.02, buy_interval=6,
                 n_validators=5, p_online=0.8, seed=1,
                 venue="curve", x0=20.0, phi=0.35, kappa=0.08, sigma=0.012,
                 mev_bps_jit=0, topup_bps=2000, mev_bps_topup=100, burst=1.1):
        self.scenario = scenario
        self.days = days
        self.warmup_days = warmup_days
        self.trials = trials
        self.model = model
        self.release_daily_bps = release_daily_bps
        self.cap_bps = cap_bps
        self.catchup = catchup                # 单地址上限可累积的纪元数（=1 就是每纪元都得调）
        self.buyback_daily_bps = buyback_daily_bps   # 每天花掉 BNB 桶的多少
        self.min_buy_bnb = min_buy_bnb
        self.buy_interval = buy_interval      # 每 N 个纪元才允许回购一次
        self.n_validators = n_validators
        self.p_online = p_online
        self.seed = seed
        self.venue = venue
        self.x0 = x0
        self.phi = phi
        self.kappa = kappa
        self.sigma = sigma
        self.mev_bps_jit = mev_bps_jit        # JIT 每笔 collect 换币被夹的损耗
        self.topup_bps = topup_bps            # HYBRID: claimExit 触发的补买占 BNB 桶的比例
        self.mev_bps_topup = mev_bps_topup    # HYBRID: 补买被调用者夹走的比例
        self.burst = burst

    @property
    def E(self):
        return self.days * EPD


def _release_tier(n_wit, tiers):
    b0, b12, b3 = tiers
    out = np.full(n_wit.shape, float(b0))
    out = np.where((n_wit >= 1) & (n_wit <= 2), float(b12), out)
    out = np.where(n_wit >= 3, float(b3), out)
    return out


# ----------------------------------------------------------------- 主循环

def run(cfg, sched):
    """返回逐 agent 的结算结果与全局轨迹。所有金额以 BNB 或 BAC 计，见键名后缀。"""
    rng = np.random.default_rng(cfg.seed)
    T, K, E = cfg.trials, sched.K, cfg.E

    dtax = daily_tax(cfg.scenario, cfg.days + cfg.warmup_days, T, rng)
    bridge_daily = dtax * (1.0 - FLAP_FEE) * MKT_BPS * BRIDGE_SHARE

    mkt = Market(T, x0=cfg.x0, p0=2e-8, phi=cfg.phi, kappa=cfg.kappa,
                 sigma=cfg.sigma, venue=cfg.venue, rng=rng)

    # 预热：只进不出，BNB 先堆着；预热期也按同样节奏回购
    bnb_pool = np.zeros(T)
    stock = np.zeros(T)              # buybackBac
    budget = np.zeros(T)             # 已计提、尚未成交的回购预算（攒到 MIN 才买）
    for d in range(cfg.warmup_days):
        w = rng.random((T, EPD)) ** 2
        w /= w.sum(axis=1, keepdims=True)
        for k in range(EPD):
            bnb_pool += bridge_daily[:, d] * w[:, k]
            budget += bnb_pool * cfg.buyback_daily_bps / 1e4 / EPD
            if cfg.model in (STOCK, HYBRID) and (k % cfg.buy_interval == 0):
                s = np.where(budget >= cfg.min_buy_bnb, np.minimum(budget, bnb_pool), 0.0)
                tok, tax, _ = mkt.buy(s)
                bnb_pool -= s
                budget -= s
                stock += tok
                bnb_pool += tax * RECYCLE_TO_BRIDGE     # 买入税的 45% 回到桥池
            mkt.step()

    p0_bnb = bnb_pool.copy()
    p0_stock = stock.copy()

    wit = (rng.binomial(cfg.n_validators, cfg.p_online, size=(T, cfg.days))
           if cfg.n_validators > 0 else np.zeros((T, cfg.days), dtype=int))
    rday = _release_tier(wit, cfg.release_daily_bps) / 1e4          # 每天
    held = sched.init(T, K, rng)

    owed = np.zeros((T, K))          # STOCK/HYBRID: BAC；JIT: BNB
    debt = np.zeros((T, K))
    unclaimed = np.zeros((T, K))
    paid_asset = np.zeros((T, K))    # 实际收到的资产（BAC 或 BNB->BAC 后的 BAC）
    paid_bnbval = np.zeros((T, K))   # 折成 BNB 的净值（按 collect 当时卖出可得）
    burned = np.zeros((T, K))        # 销毁的积分
    locked_amt = np.zeros((T, K))    # 累计锁定的应付额（原单位：BAC 或 BNB）
    locked_val = np.zeros((T, K))    # 累计锁定额折成锁定当时的 BNB 价值
    lock_rate = np.zeros((T, K))     # 锁定时的每积分汇率（诊断用）
    last_col = np.full((T, K), -10**9, dtype=np.int64)
    acc = np.zeros(T)
    reserved = np.zeros(T)
    last_pot = np.zeros(T)
    jit_swaps = np.zeros(T)
    topups = np.zeros(T)

    inv_worst = 0.0
    rate_hist = np.zeros((T, E), dtype=np.float32)
    pool_hist = np.zeros((T, E), dtype=np.float32)
    stock_hist = np.zeros((T, E), dtype=np.float32)
    price_hist = np.zeros((T, E), dtype=np.float32)
    daily_paid = np.zeros((T, cfg.days))
    daily_in = np.zeros((T, cfg.days))          # 本日进入「付款资产桶」的量（STOCK/HYBRID: BAC；JIT: BNB）
    tracked_daily = np.zeros((T, cfg.days))
    tn = sched.track_n

    e = 0
    for d in range(cfg.days):
        w = rng.random((T, EPD)) ** 2
        w /= w.sum(axis=1, keepdims=True)
        r_e = rday[:, d] / EPD                              # 每纪元释放比例
        for k in range(EPD):
            # 1) 税收到账
            inflow = bridge_daily[:, cfg.warmup_days + d] * w[:, k]
            bnb_pool += inflow
            if cfg.model == JIT:
                daily_in[:, d] += inflow

            # 2) 定时回购（STOCK / HYBRID）
            budget += bnb_pool * cfg.buyback_daily_bps / 1e4 / EPD
            if cfg.model in (STOCK, HYBRID) and (e % cfg.buy_interval == 0):
                s = np.where(budget >= cfg.min_buy_bnb, np.minimum(budget, bnb_pool), 0.0)
                tok, tax, _ = mkt.buy(s)
                bnb_pool -= s
                budget -= s
                stock += tok
                daily_in[:, d] += tok
                bnb_pool += tax * RECYCLE_TO_BRIDGE

            # 3) 本纪元的退出（claimExit：当场锁汇率、当场销毁积分）
            arrive, want = sched.step(e, d, k, held, rng)
            held = held + arrive
            move = np.minimum(want, held)
            if move.any():
                if cfg.model == HYBRID:
                    # C-2：claimExit 顺手补买一笔，好让闲置 BNB 尽快变成 BAC。
                    # 代价：执行时点由调用者决定 -> 可被三明治，桥少拿到 mev_bps_topup 的量。
                    hit = (move.sum(axis=1) > 0).astype(float)
                    s2 = bnb_pool * cfg.topup_bps / 1e4 * hit
                    s2 = np.where(s2 >= cfg.min_buy_bnb, s2, 0.0)
                    tok2, tax2, _ = mkt.buy(s2 * (1.0 - cfg.mev_bps_topup / 1e4))
                    bnb_pool -= s2
                    stock += tok2
                    daily_in[:, d] += tok2
                    bnb_pool += tax2 * RECYCLE_TO_BRIDGE
                    topups += hit
                c_out = held.sum(axis=1)
                if cfg.model == JIT:
                    base = bnb_pool
                else:
                    base = stock
                free = np.maximum(base - owed.sum(axis=1), 0.0)
                rate = np.where(c_out > 0, free / np.where(c_out > 0, c_out, 1.0), 0.0)
                add = move * rate[:, None]
                owed += add
                debt += add * acc[:, None]
                locked_amt += add
                locked_val += add if cfg.model == JIT else add * mkt.price()[:, None]
                lock_rate = np.where(move > 0, rate[:, None], lock_rate)
                held = held - move
                burned = burned + move

            # 4) settleEpoch：从未占用余额里切 pot
            owed_tot = owed.sum(axis=1)
            base = bnb_pool if cfg.model == JIT else stock
            pot = np.maximum(base - reserved, 0.0) * r_e
            head = np.maximum(owed_tot - reserved, 0.0)
            pot = np.minimum(pot, head)
            acc = acc + np.where(owed_tot > 0, pot / np.maximum(owed_tot, 1e-300), 0.0)
            reserved = reserved + pot
            last_pot = np.where(pot > 0, pot, last_pot)

            # 5) collect：MasterChef 收割 + 单地址速率上限（可累积 catchup 个纪元）
            harvest = owed * acc[:, None] - debt
            unclaimed = unclaimed + np.maximum(harvest, 0.0)
            debt = owed * acc[:, None]
            elapsed = np.minimum(e - last_col, cfg.catchup)
            cap = (last_pot[:, None] * cfg.cap_bps / 1e4) * np.maximum(elapsed, 0)
            pay = np.minimum(unclaimed, cap)
            pay = np.minimum(pay, owed)
            pay = np.minimum(pay, reserved[:, None])
            pay = np.where(sched.collects(e), pay, 0.0)
            tot = pay.sum(axis=1)
            last_col = np.where(pay > 0, e, last_col)
            unclaimed -= pay
            owed -= pay
            debt = owed * acc[:, None]
            reserved -= tot

            if cfg.model == JIT:
                bnb_pool -= tot
                tok, tax, _ = mkt.buy(tot * (1.0 - cfg.mev_bps_jit / 1e4))
                bnb_pool += tax * RECYCLE_TO_BRIDGE
                jit_swaps += (tot > 0).astype(float)
                share = np.where(tot[:, None] > 0, pay / np.maximum(tot, 1e-300)[:, None], 0.0)
                got = share * tok[:, None]
                paid_asset += got
                paid_bnbval += mkt.sell_value(got)
            else:
                stock -= tot
                paid_asset += pay
                paid_bnbval += mkt.sell_value(pay)

            daily_paid[:, d] += tot
            tracked_daily[:, d] += pay[:, :tn].sum(axis=1)

            base = bnb_pool if cfg.model == JIT else stock
            gap = float(np.max(owed.sum(axis=1) - base))
            inv_worst = max(inv_worst, gap)

            # 诊断用：当前每积分汇率。积分被退完时无定义，记 0。
            # 分母下限用 1.0 而不是 1e-300，否则 1e-300 会把分子撑成 inf（只影响这条诊断线，
            # 不影响任何被报告的指标 —— 消费它的地方都先 mask 掉 rate == 0 的纪元）。
            c_live = held.sum(axis=1)
            rate_hist[:, e] = np.where(c_live > 0,
                                       np.maximum(base - owed.sum(axis=1), 0.0)
                                       / np.maximum(c_live, 1.0), 0.0)
            pool_hist[:, e] = bnb_pool
            stock_hist[:, e] = stock
            price_hist[:, e] = mkt.price()
            mkt.step()
            e += 1

    return dict(
        p0_bnb=p0_bnb, p0_stock=p0_stock, bnb_pool=bnb_pool, stock=stock,
        owed=owed, paid_asset=paid_asset, paid_bnbval=paid_bnbval,
        burned=burned, lock_rate=lock_rate, held=held,
        locked_amt=locked_amt, locked_val=locked_val,
        daily_in=daily_in,
        rate_hist=rate_hist, pool_hist=pool_hist, stock_hist=stock_hist,
        price_hist=price_hist, daily_paid=daily_paid, tracked_daily=tracked_daily,
        inv_worst=inv_worst, track_n=tn, mkt=mkt, jit_swaps=jit_swaps,
        topups=topups, cfg=cfg,
        bought_bnb=mkt.bought_bnb, tax_paid=mkt.tax_paid, slip_bnb=mkt.slip_bnb,
        imp_max=mkt.imp_max, imp_sum=mkt.imp_sum, n_buys=mkt.n_buys)


# ----------------------------------------------------------------- 行为 schedule
# 接口：init(T,K,rng) -> held；step(e,d,k,held,rng) -> (arrive, want)；collects(e) -> bool/array

class _Base:
    def collects(self, e):
        return True


class FirstMover(_Base):
    """A 从第 0 纪元起每天挂出手上 10%；crowd_day 之后另外 M 个等额 agent 同样操作。"""

    def __init__(self, M=50, crowd_day=3, a_credits=200_000.0, o_credits=200_000.0,
                 exit_frac=0.10, top_up=0.01):
        self.M, self.K, self.track_n = M, 1 + M, 1
        self.a, self.o = a_credits, o_credits
        self.crowd_day, self.f, self.top = crowd_day, exit_frac, top_up

    def init(self, T, K, rng):
        h = np.zeros((T, K))
        h[:, 0] = self.a
        h[:, 1:] = self.o
        return h

    def step(self, e, d, k, held, rng):
        a = np.zeros_like(held)
        x = np.zeros_like(held)
        if k == 0:                                   # 每天第一个纪元动手
            x[:, 0] = held[:, 0] * self.f
            if d >= self.crowd_day:
                x[:, 1:] = held[:, 1:] * self.f
            a[:, 0] = self.a * self.top
            a[:, 1:] = self.o * self.top
        return a, x


class SoleExiter(_Base):
    """某实体持 whale 积分并拆成 s 个身份，其他人全程不退出。"""

    def __init__(self, s=1, whale=1_000_000.0, other=9_000_000.0, whole=True,
                 drip=0.001, day0_all=False):
        self.s, self.K, self.track_n = s, s + 1, s
        self.whale, self.other = whale, other
        self.whole, self.drip, self.day0_all = whole, drip, day0_all

    def init(self, T, K, rng):
        h = np.zeros((T, K))
        h[:, :self.s] = self.whale / self.s
        h[:, self.s] = self.other
        return h

    def step(self, e, d, k, held, rng):
        a = np.zeros_like(held)
        x = np.zeros_like(held)
        if self.day0_all:
            if e == 0:
                x[:, :self.s] = held[:, :self.s]
        elif k == 0:
            if self.whole:
                x[:, :self.s] = held[:, :self.s]
            else:
                x[:, :self.s] = (self.whale / self.s) * self.drip
        return a, x


class TwoExiters(_Base):
    """同一个纪元退出的大户(30%)与小户(1%)，用来测横向公平。"""
    K, track_n = 3, 1

    def __init__(self, total=10_000_000.0, big=0.30, small=0.01):
        self.total, self.bigf, self.smallf = total, big, small

    def init(self, T, K, rng):
        h = np.zeros((T, K))
        h[:, 0] = self.total * self.bigf
        h[:, 1] = self.total * self.smallf
        h[:, 2] = self.total * (1.0 - self.bigf - self.smallf)
        return h

    def step(self, e, d, k, held, rng):
        a = np.zeros_like(held)
        x = np.zeros_like(held)
        if e == 0:
            x[:, 0] = held[:, 0]
            x[:, 1] = held[:, 1]
        return a, x


class Sniper(_Base):
    """择时博弈：列 0 每天只在**回购刚发生的那个纪元**退出，列 1 每天在随机纪元退出，
       列 2 是不退出的其余人。两者持仓相同，比较锁到的汇率。"""
    K, track_n = 3, 1

    def __init__(self, total=10_000_000.0, each=0.02, buy_interval=6):
        self.total, self.each, self.bi = total, each, buy_interval

    def init(self, T, K, rng):
        h = np.zeros((T, K))
        h[:, 0] = self.total * self.each
        h[:, 1] = self.total * self.each
        h[:, 2] = self.total * (1.0 - 2 * self.each)
        self._rand_slot = None
        return h

    def step(self, e, d, k, held, rng):
        a = np.zeros_like(held)
        x = np.zeros_like(held)
        if k == 0:
            self._rand_slot = rng.integers(0, EPD, size=held.shape[0])
        amt = self.total * self.each / 30.0          # 每天各挂出同样多的一份
        if k == 0:                                   # 当天第一个「回购刚发生」的纪元
            x[:, 0] = np.minimum(amt, held[:, 0])
        hit = (self._rand_slot == k)
        x[:, 1] = np.where(hit, np.minimum(amt, held[:, 1]), 0.0)
        return a, x


class BankRun(_Base):
    """挤兑：全部积分在第 0 纪元一次性挂出，拆成 s 个身份。"""

    def __init__(self, s=40, total=10_000_000.0):
        self.s, self.K, self.track_n = s, s, s
        self.total = total

    def init(self, T, K, rng):
        return np.full((T, K), self.total / self.s)

    def step(self, e, d, k, held, rng):
        a = np.zeros_like(held)
        x = np.zeros_like(held)
        if e == 0:
            x[:] = held
        return a, x
