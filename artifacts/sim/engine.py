# -*- coding: utf-8 -*-
"""
桥池出口引擎（BacBridge 的经济核心）。三种分配口径的对照实验。

每个纪元 e（= 1 天，UTC 对齐）：
    1. 金库 settle() 把 0.45*T 推进 BacBridge
    2. 本纪元 FINAL 的退出被记账
    3. settleEpoch(e)：pot_e = 未被 earmark 的余额 * RELEASE_BPS/1e4
    4. collect：单地址单纪元不超过 pot_e * MAX_EXIT_SHARE_BPS/1e4
    5. 没分出去的 leftover 按 rollover 策略处理

三种口径
--------
QUEUE        00-DESIGN-SPEC 目前的写法：pot 按「本纪元退出队列内」的积分份额分。
             entitlement_i = pot * pending_i / sum(pending)
             被上限截掉时按比例少销毁积分（否则上限就是没收）。

OUTSTANDING  pot 按「全部在外积分」的份额分，没人认领的部分回池子。
             entitlement_i = pot * pending_i / (全部未销毁积分)

LOCKED       本模拟推荐：退出当场按「未被占用的池子 / 全部未销毁积分」锁定一个应付额
             owed_i += C_i * (bal - owedTotal) / creditsOutstanding
             积分当场全部销毁；owed 之后从每个纪元的 pot 里按 owed 份额慢慢付，
             单地址单纪元仍受 cap 限制。
             solvency 不变式：owedTotal <= bal 恒成立（见 sim_treasury.py 的证明与数值检查）。
"""
import numpy as np
from common import daily_tax, split_tax, release_bps, draw_witnesses

QUEUE = "QUEUE"
OUTSTANDING = "OUTSTANDING"
LOCKED = "LOCKED"
MECHS = (QUEUE, OUTSTANDING, LOCKED)


class Cfg:
    def __init__(self, scenario="modest", days=365, warmup=30, trials=2000,
                 tiers=(200, 350, 500), cap_bps=1000, rollover="pool",
                 mechanism=LOCKED, n_validators=5, p_online=0.8,
                 p_unclaimed=0.0, seed=1):
        self.scenario = scenario
        self.days = days
        self.warmup = warmup
        self.trials = trials
        self.tiers = tiers
        self.cap_bps = cap_bps
        self.rollover = rollover
        self.mechanism = mechanism
        self.n_validators = n_validators
        self.p_online = p_online
        self.p_unclaimed = p_unclaimed
        self.seed = seed

    def label(self):
        return (f"{self.mechanism}/{self.tiers[0]}-{self.tiers[2]}"
                f"/cap{self.cap_bps}/{self.rollover}/v{self.n_validators}")


def run(cfg, schedule):
    rng = np.random.default_rng(cfg.seed)
    T, K, D, W = cfg.trials, schedule.K, cfg.days, cfg.warmup
    tax = daily_tax(cfg.scenario, D + W, T, rng)
    bridge_in, node_in = split_tax(tax)

    bal = bridge_in[:, :W].sum(axis=1)       # 预热期只进不出
    p0 = bal.copy()
    inflow_after = np.cumsum(bridge_in[:, W:], axis=1)

    wit = draw_witnesses(cfg.n_validators, cfg.p_online, D, T, rng)
    rbps = release_bps(wit, cfg.tiers) / 1e4
    cap = cfg.cap_bps / 1e4

    held = schedule.init(T, K, rng)          # 层内还拿着的积分
    claim = np.zeros((T, K))                 # QUEUE/OUTSTANDING: 待付积分；LOCKED: owed(BNB)
    paid = np.zeros((T, K))                  # 已收到的 BNB
    burned = np.zeros((T, K))                # 已销毁的积分
    submitted = np.zeros((T, K))
    pot = np.zeros(T)
    carry = np.zeros(T)

    inv_ok = True
    inv_worst = 0.0
    snap_at = sorted({6, 29, 89, D - 1})
    snaps = {}
    bal_hist = np.zeros((T, D))
    out_hist = np.zeros((T, D))
    rate_hist = np.zeros((T, D))
    track_paid_hist = np.zeros((T, D))
    track_owed_hist = np.zeros((T, D))
    tn0 = schedule.track_n

    for d in range(D):
        bal = bal + bridge_in[:, W + d]
        arrive, exit_now = schedule.step(d, held, rng)
        held = held + arrive
        move = np.minimum(exit_now, held)
        submitted = submitted + move

        if cfg.mechanism == LOCKED:
            owed_total = claim.sum(axis=1)
            c_out = held.sum(axis=1)                       # 本纪元销毁之前的全部未销毁积分
            free = np.maximum(bal - owed_total, 0.0)
            rate = np.where(c_out > 0, free / np.where(c_out > 0, c_out, 1.0), 0.0)
            claim = claim + move * rate[:, None]
            held = held - move
            burned = burned + move
            rate_hist[:, d] = rate
        else:
            held = held - move
            claim = claim + move

        free_bal = bal - pot
        pot_new = free_bal * rbps[:, d]
        pot = pot + pot_new
        bal_pot = pot.copy()

        if cfg.mechanism == LOCKED:
            denom = claim.sum(axis=1)
        elif cfg.mechanism == QUEUE:
            denom = claim.sum(axis=1)
        else:
            denom = claim.sum(axis=1) + held.sum(axis=1)
        safe = np.where(denom > 0, denom, 1.0)

        ent = bal_pot[:, None] * claim / safe[:, None]
        ent = np.where(denom[:, None] > 0, ent, 0.0)
        pay = np.minimum(ent, (cap * bal_pot)[:, None])
        if cfg.mechanism == LOCKED:
            pay = np.minimum(pay, claim)                   # 不多付
        if cfg.p_unclaimed > 0:
            miss = rng.random((T, K)) < cfg.p_unclaimed
            miss[:, :schedule.track_n] = False
            pay = np.where(miss, 0.0, pay)

        if cfg.mechanism == LOCKED:
            claim = claim - pay
        else:
            ratio = np.where(ent > 0, pay / np.where(ent > 0, ent, 1.0), 0.0)
            used = claim * ratio
            claim = claim - used
            burned = burned + used

        tot_pay = pay.sum(axis=1)
        paid = paid + pay
        bal = bal - tot_pay
        pot = pot - tot_pay
        if cfg.rollover == "pool":
            pot = np.zeros(T)                              # leftover 立刻回到未占用余额
        # rollover == "pot": 剩下的留在 pot 里滚到下一纪元

        if cfg.mechanism == LOCKED:
            gap = (claim.sum(axis=1) - bal).max()
            inv_worst = max(inv_worst, float(gap))
            if gap > 1e-9 * max(1.0, float(bal.max())):
                inv_ok = False

        bal_hist[:, d] = bal
        out_hist[:, d] = held.sum(axis=1)
        track_paid_hist[:, d] = paid[:, :tn0].sum(axis=1)
        track_owed_hist[:, d] = claim[:, :tn0].sum(axis=1)
        if d in snap_at:
            snaps[d] = (paid.copy(), burned.copy(), claim.copy())

    return dict(p0=p0, bal_end=bal, inflow_after=inflow_after,
                paid=paid, burned=burned, submitted=submitted,
                claim=claim, held=held, bal_hist=bal_hist,
                out_hist=out_hist, rate_hist=rate_hist,
                track_n=schedule.track_n, snaps=snaps, days=D,
                track_paid_hist=track_paid_hist, track_owed_hist=track_owed_hist,
                inv_ok=inv_ok, inv_worst=inv_worst)


# ---------------- agent 行为 schedule ----------------

class SoleExiter:
    """某实体（可拆成 s 个 agent 号）独占整个出口，别人从不退出。
       whole=True 每个纪元把手上剩下的全部挂单；whole=False 每纪元只挂 drip_frac。"""
    def __init__(self, s=1, whale_credits=1_000_000.0, other_credits=9_000_000.0,
                 whole=True, drip_frac=0.001):
        self.s = s
        self.K = s + 1
        self.track_n = s
        self.whale = whale_credits
        self.other = other_credits
        self.whole = whole
        self.drip = drip_frac

    def init(self, T, K, rng):
        h = np.zeros((T, K))
        h[:, :self.s] = self.whale / self.s
        h[:, self.s] = self.other
        return h

    def step(self, d, held, rng):
        a = np.zeros_like(held)
        e = np.zeros_like(held)
        if self.whole:
            e[:, :self.s] = held[:, :self.s]
        else:
            e[:, :self.s] = (self.whale / self.s) * self.drip
        return a, e


class FirstMover:
    """A 先进先出：前 crowd_start 天只有 A 在退出，之后 M 个等额 agent 一起退出。"""
    def __init__(self, M=50, crowd_start=7, a_credits=200_000.0, o_credits=200_000.0,
                 a_split=1, exit_frac=0.10, top_up=0.01):
        self.M = M
        self.s = a_split
        self.K = a_split + M
        self.track_n = a_split
        self.a = a_credits
        self.o = o_credits
        self.crowd_start = crowd_start
        self.f = exit_frac
        self.top = top_up

    def init(self, T, K, rng):
        h = np.zeros((T, K))
        h[:, :self.s] = self.a / self.s
        h[:, self.s:] = self.o
        return h

    def step(self, d, held, rng):
        a = np.zeros_like(held)
        e = np.zeros_like(held)
        e[:, :self.s] = held[:, :self.s] * self.f
        if d >= self.crowd_start:
            e[:, self.s:] = held[:, self.s:] * self.f
        a[:, :self.s] = (self.a / self.s) * self.top
        a[:, self.s:] = self.o * self.top
        return a, e


class Whale:
    """鲸鱼（mult x 普通 agent）第 1 周独自退出然后离场；之后普通 agent 才开始退。"""
    def __init__(self, M=50, mult=10.0, o_credits=200_000.0, whale_days=7, s=1):
        self.M = M
        self.s = s
        self.K = s + M
        self.track_n = s
        self.o = o_credits
        self.w = o_credits * mult
        self.whale_days = whale_days

    def init(self, T, K, rng):
        h = np.zeros((T, K))
        h[:, :self.s] = self.w / self.s
        h[:, self.s:] = self.o
        return h

    def step(self, d, held, rng):
        a = np.zeros_like(held)
        e = np.zeros_like(held)
        if d < self.whale_days:
            e[:, :self.s] = held[:, :self.s]
        else:
            e[:, self.s:] = held[:, self.s:] * 0.10
            a[:, self.s:] = self.o * 0.01
        return a, e


class Crowd:
    """常态：M 个 agent 随机进出。用来看池子水位、每积分兑付率、最幸运者占比和不变式。"""
    def __init__(self, M=60, o_credits=200_000.0, p_exit=0.12, p_arrive=0.10,
                 exit_frac=1.0):
        self.M = M
        self.K = M
        self.track_n = 1
        self.o = o_credits
        self.p_exit = p_exit
        self.p_arrive = p_arrive
        self.f = exit_frac

    def init(self, T, K, rng):
        return rng.lognormal(np.log(self.o), 0.8, size=(T, K))

    def step(self, d, held, rng):
        T, K = held.shape
        a = np.where(rng.random((T, K)) < self.p_arrive,
                     rng.lognormal(np.log(self.o * 0.3), 0.8, size=(T, K)), 0.0)
        e = np.where(rng.random((T, K)) < self.p_exit, held * self.f, 0.0)
        return a, e


class TwoExiters:
    """同一个纪元退出的一大一小：列 0 持 big_frac、列 1 持 small_frac、列 2 是不退出的其余人。
       用来测「同纪元横向公平」：两者每积分拿到的 BNB 应该一样，上限只许影响速度。"""
    K = 3
    track_n = 1

    def __init__(self, total=10_000_000.0, big_frac=0.30, small_frac=0.01):
        self.total = total
        self.big = big_frac
        self.small = small_frac

    def init(self, T, K, rng):
        h = np.zeros((T, K))
        h[:, 0] = self.total * self.big
        h[:, 1] = self.total * self.small
        h[:, 2] = self.total * (1.0 - self.big - self.small)
        return h

    def step(self, d, held, rng):
        a = np.zeros_like(held)
        e = np.zeros_like(held)
        if d == 0:
            e[:, 0] = held[:, 0]
            e[:, 1] = held[:, 1]
        return a, e
