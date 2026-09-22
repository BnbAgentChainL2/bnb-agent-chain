# -*- coding: utf-8 -*-
"""
问题 2：官方节点基金与验证者奖励。

模型（对应 00-DESIGN-SPEC §5、§6.3）：
  税收 * 0.9 * 0.5 -> BacNodeFund
  运营方按 VALIDATOR_BPS 把节点基金推进 / 注入 ValidatorStaking 的奖励余额 B
  每纪元 settleEpochRewards：pool_e = B * REWARD_RELEASE_BPS/1e4；B -= pool_e
  按 weight = min(stake, WEIGHT_CAP)（或纯线性）分给「本纪元报对根」的节点
  单节点不超过 pool_e * MAX_NODE_SHARE_BPS/1e4，剩下的退回 B（不在场内瓜分）

要回答的：
  2.1 验证者收益 vs 验证者数量（1 -> 10 -> 64）
  2.2 让跑节点划算的最低奖励（~5 USD/月 机器成本 + BSC gas）
  2.3 反女巫：WEIGHT_CAP 与 MAX_NODE_SHARE_BPS 下拆号到底赚不赚
  2.4 需要多大的 VALIDATOR_BPS（节点基金强制分账比例）
每行 >= 2000 条随机路径。
"""
import sys
import numpy as np
from common import (daily_tax, split_tax, md_table, BNB_USD, SERVER_USD_MO,
                    validator_gas_bnb_per_month)

TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
DAYS = 365
OUT = []


def w(s=""):
    print(s)
    OUT.append(s)


def q(x, p):
    return float(np.quantile(x, p))


GAS_MO = validator_gas_bnb_per_month()
COST_MO = SERVER_USD_MO / BNB_USD + GAS_MO          # BNB / 月 / 节点


def run_rewards(scenario, stakes, trials, days=DAYS, seed=7,
                validator_bps=4000, release_bps=500, node_cap_bps=2500,
                weight_cap_mult=10.0, min_stake=2_000_000.0, p_online=0.8,
                warmup=30):
    """stakes: (N,) 每个节点绑定的质押量。返回 (trials, N) 全年累计奖励 BNB。"""
    rng = np.random.default_rng(seed)
    N = len(stakes)
    tax = daily_tax(scenario, days + warmup, trials, rng)
    _, node_in = split_tax(tax)

    stakes = np.asarray(stakes, dtype=float)
    if weight_cap_mult is None:
        wgt = stakes.copy()
    else:
        wgt = np.minimum(stakes, weight_cap_mult * min_stake)

    B = node_in[:, :warmup].sum(axis=1) * (validator_bps / 1e4)   # 预热期的注入
    got = np.zeros((trials, N))
    r = release_bps / 1e4
    cap = node_cap_bps / 1e4

    for d in range(days):
        B = B + node_in[:, warmup + d] * (validator_bps / 1e4)
        pool = B * r
        B = B - pool
        on = rng.random((trials, N)) < p_online          # 本纪元报对根的节点
        wm = on * wgt[None, :]
        tw = wm.sum(axis=1)
        safe = np.where(tw > 0, tw, 1.0)
        ent = pool[:, None] * wm / safe[:, None]
        ent = np.where(tw[:, None] > 0, ent, 0.0)
        pay = np.minimum(ent, (cap * pool)[:, None])
        got = got + pay
        B = B + (pool - pay.sum(axis=1))                 # 没发出去的退回奖励余额
    return got


BASE = dict(validator_bps=4000, release_bps=500, node_cap_bps=2500,
            weight_cap_mult=10.0)

w("## 2. 节点基金与验证者奖励")
w()
w(f"每行 {TRIALS} 条随机路径。成本口径：机器 {SERVER_USD_MO:.0f} USD/月、BNB = {BNB_USD:.0f} USD、"
  f"BSC gas 0.10 gwei、每纪元 commit+reveal 约 175k gas、每周一次 claim 约 65k gas。")
w(f"折合 **每节点每月成本 ≈ {COST_MO:.5f} BNB**（机器 {SERVER_USD_MO/BNB_USD:.5f} + gas {GAS_MO:.5f}）。")
w("这条线是「把机器钱赚回来」，不是收益承诺。")
w()

w("### 2.1 验证者收益 vs 验证者数量")
w()
w("全部节点都押最低门槛 200 万 BAC，在线率 80%，节点基金按 `VALIDATOR_BPS = 4000`（40%）注入奖励池。")
w("`月均` = 全年累计 ÷ 12 的中位数；`达标率` = 月均 ≥ 成本线的路径占比。")
w()
rows = []
for sc in ("dead", "modest", "viral"):
    for N in (1, 3, 10, 30, 64):
        got = run_rewards(sc, [2_000_000.0] * N, TRIALS, **BASE)
        per = got[:, 0] / 12.0
        rows.append([sc, N, f"{np.median(per):.5f}", f"{q(per,0.05):.5f}",
                     f"{np.median(per)*BNB_USD:.2f}",
                     f"{np.mean(per >= COST_MO)*100:.1f}%"])
w(md_table(["情景", "验证者数", "月均 BNB 中位", "月均 BNB p5", "月均 USD 中位",
            "达标率(≥成本线)"], rows))
w()

w("### 2.2 让跑节点划算所需的税收规模")
w()
w("反解：要让 N 个验证者各自月均达到成本线的 1x / 2x，节点基金每月至少要注入多少 BNB、")
w("对应多少 BNB 的日成交额（税 2%、协议费 10%、节点基金 50%、`VALIDATOR_BPS` 40%）。")
w("稳态时「每月发出去的奖励 = 每月注入量」（5%/纪元的释放只决定约 20 天的时间常数，不改变稳态总量）。")
w()
rows = []
for N in (1, 3, 10, 30, 64):
    for mult, lab in ((1.0, "1x 打平"), (2.0, "2x 值得做")):
        need_reward = N * COST_MO * mult                       # BNB/月 发到验证者手里
        need_fund = need_reward / 0.40                         # 节点基金每月进账
        need_tax = need_fund / (0.9 * 0.5)
        need_vol_day = need_tax / 0.02 / 30.0
        rows.append([N, lab, f"{need_reward:.4f}", f"{need_fund:.4f}",
                     f"{need_tax:.3f}", f"{need_vol_day:.1f}"])
w(md_table(["验证者数", "口径", "奖励需求 BNB/月", "节点基金需求 BNB/月",
            "税收需求 BNB/月", "对应日成交额 BNB"], rows))
w()

w("### 2.3 反女巫：拆号赚不赚")
w()
w("一个实体持有 S 枚 BAC，可以押成 1 个节点，也可以拆成 k 个各押 200 万的节点。")
w("`权重` 按现行规则 `min(stake, 10 x 200万)`；对照组是「纯线性、无 WEIGHT_CAP」。")
w("场景：场上另有 9 个诚实节点各押 200 万。`份额` = 该实体全年拿到的奖励占全部发出奖励的比例。")
w()
rows = []
for S, slab in ((2_000_000.0, "200万 (1x)"), (20_000_000.0, "2000万 (10x)"),
                (60_000_000.0, "6000万 (30x)")):
    for wcap, wlab in ((10.0, "现行 WEIGHT_CAP=10x"), (None, "纯线性(无上限)")):
        cells = []
        for k in (1, 3, 10):
            if S / k < 2_000_000.0:
                cells.append("不够门槛")
                continue
            stakes = [S / k] * k + [2_000_000.0] * 9
            got = run_rewards("modest", stakes, TRIALS, weight_cap_mult=wcap,
                              validator_bps=4000, release_bps=500, node_cap_bps=2500)
            share = got[:, :k].sum(axis=1) / np.maximum(got.sum(axis=1), 1e-18)
            cells.append(f"{np.median(share)*100:.1f}%")
        rows.append([slab, wlab] + cells)
w(md_table(["该实体质押", "权重规则", "k=1 份额", "k=3 份额", "k=10 份额"], rows))
w()
w("拆号的边际成本：每多一个节点每月 " + f"{GAS_MO:.5f} BNB 的 BSC gas"
  "（机器可以共用一台，合约分辨不了，所以机器钱不算在内）。")
w()

w("### 2.4 `MAX_NODE_SHARE_BPS` 与 `REWARD_RELEASE_BPS` 的影响")
w()
w("场上 4 个节点：1 个大户（押满 10x 上限）+ 3 个最低门槛。看大户拿多少、以及奖励池的堆积。")
w()
rows = []
for cap in (2500, 4000, 10000):
    for rel in (250, 500, 1000):
        stakes = [20_000_000.0] + [2_000_000.0] * 3
        got = run_rewards("modest", stakes, TRIALS, node_cap_bps=cap, release_bps=rel,
                          validator_bps=4000, weight_cap_mult=10.0)
        share = got[:, 0] / np.maximum(got.sum(axis=1), 1e-18)
        wshare = 20_000_000.0 / (20_000_000.0 + 3 * 2_000_000.0)
        rows.append([cap, rel, f"{wshare*100:.1f}%", f"{np.median(share)*100:.1f}%",
                     f"{np.median(got.sum(axis=1)):.4f}"])
w(md_table(["MAX_NODE_SHARE_BPS", "REWARD_RELEASE_BPS", "大户权重占比",
            "大户实得占比", "全年发出总额 BNB"], rows))
w()

w("### 2.5 `VALIDATOR_BPS`（节点基金强制分账比例）扫描")
w()
w("10 个最低门槛验证者。`达标率` = 月均 ≥ 成本线的路径占比；`2x 达标率` = ≥ 2 倍成本线。")
w()
rows = []
for sc in ("dead", "modest", "viral"):
    for vb in (0, 2000, 4000, 6000):
        if vb == 0:
            rows.append([sc, "0（决策 #10 原样：全靠运营方自觉手工注入）",
                         "—", "—", "—"])
            continue
        got = run_rewards(sc, [2_000_000.0] * 10, TRIALS, validator_bps=vb,
                          release_bps=500, node_cap_bps=2500, weight_cap_mult=10.0)
        per = got[:, 0] / 12.0
        rows.append([sc, vb, f"{np.median(per):.5f}",
                     f"{np.mean(per >= COST_MO)*100:.1f}%",
                     f"{np.mean(per >= 2*COST_MO)*100:.1f}%"])
w(md_table(["情景", "VALIDATOR_BPS", "月均 BNB 中位", "达标率", "2x 达标率"], rows))
w()

w("### 2.6 自由进入均衡：这条链养得起几个验证者")
w()
w("验证者是无许可先到先得的，奖励是固定池子按权重分。所以人数会自己停在")
w("「每人月均 = 成本线」的地方：**N\* = 每月奖励注入 ÷ 成本线**。")
w(f"成本线取 1x（{COST_MO:.5f} BNB/月，纯打平）与 2x（真的值得开机）两档，`VALIDATOR_BPS = 4000`。")
w("`MAX_NODES = 64` 只在 viral 情景下才是真正的约束。")
w()
rows = []
rng = np.random.default_rng(777)
for sc in ("dead", "modest", "viral"):
    tax = daily_tax(sc, 395, TRIALS, rng)
    _, node_in = split_tax(tax)
    # 稳态：取第 180-395 天的平均月注入，避开发射初期的尖峰
    mo = node_in[:, 180:].mean(axis=1) * 30.0 * 0.40
    n1 = mo / COST_MO
    n2 = mo / (2 * COST_MO)
    rows.append([sc, f"{np.median(mo):.4f}",
                 f"{np.median(n1):.0f}", f"{np.median(n2):.0f}",
                 f"{np.quantile(n2, 0.05):.0f}", f"{np.quantile(n2, 0.95):.0f}",
                 "64 封顶" if np.median(n2) > 64 else "未触顶"])
w(md_table(["情景", "稳态月注入 BNB", "N* @1x 打平", "N* @2x 值得做",
            "N* @2x p5", "N* @2x p95", "MAX_NODES=64"], rows))
w()
w("读法：**税收是 0 的时候验证者人数的均衡就是 0**。这不是缺陷，是这套设计诚实的地方 —— ")
w("网站和文案只能写机制和常数，不能写「跑节点能赚多少」。")
w()

with open("out/nodefund.md", "w", encoding="utf-8") as f:
    f.write("\n".join(OUT) + "\n")
print("\n[written] out/nodefund.md")
