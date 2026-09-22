# -*- coding: utf-8 -*-
"""
BNB Agent Chain (BAC) - 经济模拟公共模块
Common model layer for every sim in this folder.

口径 (all fixed by docs/00-DESIGN-SPEC.md §3.3):
    交易税 T  -> Flap 协议费 10%  -> 金库拿 0.90*T (mktBps=10000)
    金库 settle() -> 0.45*T 桥池 BacBridge / 0.45*T 官方节点基金 BacNodeFund
一切以 BNB 计。本文件不做任何收益承诺，只做算术。
"""
import numpy as np

# ---------- 固定口径常量（发射表单钉死，不可扫描） ----------
BUY_TAX   = 0.02          # 200 bps
SELL_TAX  = 0.02          # 200 bps
FLAP_FEE  = 0.10          # feeConfigV2().feeRate = 1000 bps (rat 主网实测)
MKT_BPS   = 1.00          # vaultBps == 10000
BRIDGE_SHARE = 0.50       # BRIDGE_BPS 5000
NODE_SHARE   = 0.50       # NODE_BPS  5000

EPOCH_DAYS = 1            # EPOCH = 86400s

# ---------- 外生假设（写进 RESULTS.md 的假设表） ----------
BNB_USD        = 600.0    # 报告里所有 USD 换算的口径，敏感性在 sim_nodefund.py 里扫
SERVER_USD_MO  = 5.0      # 用户给定：验证者自己那台机器约 5 USD/月
BSC_GWEI       = 0.10     # BSC gas price 口径（保守，实测常在 0.05）
# 验证者每纪元的链上成本：commit ~55k + reveal ~120k，claim ~65k 每 7 天一次
VAL_GAS_PER_DAY = 55_000 + 120_000 + 65_000 / 7.0


def validator_gas_bnb_per_month():
    return VAL_GAS_PER_DAY * 30.0 * BSC_GWEI * 1e-9


# ---------- 税收流入情景 ----------
# 日成交额（BNB 计）= 基线衰减曲线 * 对数正态噪声 (+ 偶发尖峰)
SCENARIOS = {
    # name:   V0中位数, 首日对数标准差, 半衰期(天), 地板成交额, 日噪声sigma, 尖峰概率, 尖峰倍数上限, 前期加速天数
    "dead":   dict(v0=150.0,  s0=0.85, half=1.5,  floor=0.30, sig=0.75, spike_p=0.010, spike_max=4.0,  ramp=0),
    "modest": dict(v0=400.0,  s0=0.70, half=21.0, floor=12.0, sig=0.60, spike_p=0.030, spike_max=6.0,  ramp=0),
    "viral":  dict(v0=1500.0, s0=0.60, half=60.0, floor=120.0,sig=0.55, spike_p=0.060, spike_max=10.0, ramp=5),
}


def daily_volume(scenario, days, trials, rng):
    """(trials, days) 日成交额 BNB。随机来源：首日规模、日噪声、尖峰。"""
    p = SCENARIOS[scenario]
    d = np.arange(days)[None, :]
    v0 = p["v0"] * np.exp(rng.normal(-p["s0"] ** 2 / 2, p["s0"], size=(trials, 1)))
    base = p["floor"] + np.maximum(v0 - p["floor"], 0.0) * 0.5 ** (d / p["half"])
    if p["ramp"]:
        boost = 1.0 + 1.2 * np.exp(-d / max(p["ramp"], 1))
        base = base * boost
    noise = np.exp(rng.normal(-p["sig"] ** 2 / 2, p["sig"], size=(trials, days)))
    vol = base * noise
    spike = rng.random((trials, days)) < p["spike_p"]
    mult = 1.0 + rng.random((trials, days)) * (p["spike_max"] - 1.0)
    vol = np.where(spike, vol * mult, vol)
    return vol


def daily_tax(scenario, days, trials, rng):
    """(trials, days) 到 TaxProcessor 的税额 BNB（协议费之前）。
    买卖各 2%，成交额已含买卖两边 -> 税 = 2% * 成交额。"""
    return 0.02 * daily_volume(scenario, days, trials, rng)


def split_tax(tax):
    """税额 -> (进桥池, 进节点基金)。Flap 协议费 10% 先扣。"""
    vault = tax * (1.0 - FLAP_FEE) * MKT_BPS
    return vault * BRIDGE_SHARE, vault * NODE_SHARE


# ---------- 见证人 -> 释放档位 ----------
def release_bps(n_witness, tiers):
    """tiers = (bps0, bps12, bps3plus)。RELEASE_BPS 决策见 00 §3.5。"""
    b0, b12, b3 = tiers
    out = np.full(n_witness.shape, b0, dtype=float)
    out = np.where((n_witness >= 1) & (n_witness <= 2), b12, out)
    out = np.where(n_witness >= 3, b3, out)
    return out


def draw_witnesses(n_validators, p_online, days, trials, rng):
    if n_validators <= 0:
        return np.zeros((trials, days), dtype=int)
    return rng.binomial(n_validators, p_online, size=(trials, days))


def pct(x):
    return f"{100.0 * x:.2f}%"


def md_table(header, rows):
    out = ["| " + " | ".join(header) + " |",
           "|" + "|".join(["---"] * len(header)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)
