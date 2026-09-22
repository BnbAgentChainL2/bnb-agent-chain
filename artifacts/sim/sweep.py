# -*- coding: utf-8 -*-
"""
问题 4：参数扫描，找出同时满足用户规则的那一组。

验收标准（每条都来自用户既有的经济规则：慢滴、无先发优势、单地址上限）
----------------------------------------------------------------------
C1 无先发优势     FirstMover 的兑付率倍数 中位 ∈ [0.92, 1.10] 且 p95 <= 1.20
C2 独占者不套利   SoleExiter（整单/细水、s = 1/5/10/20）兑付率倍数 <= 1.10
C3 同纪元横向公平 同一纪元退出的大户(30%)与小户(1%)，每积分拿到的 BNB 之比 ∈ [0.95, 1.05]
C4 反应窗口       拆号饱和(s=40)后 3 个纪元内能搬走的桥池 <= 15%
                  （24h 挑战窗口 + veto + 验证者否决要来得及）
C5 慢滴           同上，30 个纪元内 <= 80%
C6 正常体验       持 10% 积分的 agent 全额退出后，90 天内拿到应付额的九成
C7 偿付不变式     I1 owedTotal<=balance 与 I5 balance>=0 在三种情景下全部通过

注意 C4/C5 用「拆号饱和」口径，因为单地址上限是可以拆号绕过去的（见 1.2 与 4.3）。
"""
import sys
import numpy as np
import engine as E
from common import md_table

TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
OUT = []


def w(s=""):
    print(s)
    OUT.append(s)


def q(x, p):
    return float(np.quantile(x, p))


def mk(mech, tiers, cap, ro, scenario="modest", seed=31):
    return E.Cfg(scenario=scenario, days=365, warmup=30, trials=TRIALS,
                 tiers=tiers, cap_bps=cap, rollover=ro, mechanism=mech,
                 n_validators=5, p_online=0.8, seed=seed)


def days_to(r, frac):
    tot = r["track_paid_hist"][:, -1] + r["track_owed_hist"][:, -1]
    ok = r["track_paid_hist"] >= (frac * tot)[:, None]
    return np.where(ok.any(axis=1), ok.argmax(axis=1) + 1, r["days"] + 1)


def evaluate(mech, tiers, cap, ro):
    m, bad = {}, []

    # C1 先发优势
    r = E.run(mk(mech, tiers, cap, ro), E.FirstMover(M=50))
    pa, pc = r["paid"][:, :1].sum(1), r["paid"][:, 1:].sum(1)
    ba, bc = r["burned"][:, :1].sum(1), r["burned"][:, 1:].sum(1)
    ratio = (pa / np.maximum(ba, 1e-18)) / np.maximum(pc / np.maximum(bc, 1e-18), 1e-18)
    m["C1"] = (float(np.median(ratio)), q(ratio, 0.95))
    if not (0.92 <= m["C1"][0] <= 1.10) or m["C1"][1] > 1.20:
        bad.append(f"C1 先发 {m['C1'][0]:.2f}x/p95 {m['C1'][1]:.2f}x")

    # C2 独占者套利（所有拆号数与挂单方式里最坏的一个）
    worst = 0.0
    for s in (1, 5, 10, 20):
        for whole in (True, False):
            rr = E.run(mk(mech, tiers, cap, ro),
                       E.SoleExiter(s=s, whale_credits=1_000_000.0,
                                    other_credits=9_000_000.0, whole=whole))
            burn = rr["burned"][:, :s].sum(1)
            got = rr["paid"][:, :s].sum(1)
            fair = (rr["p0"] + rr["inflow_after"][:, -1]) / 10_000_000.0
            mult = np.where(burn > 0, got / np.maximum(burn, 1e-18) / fair, 0.0)
            worst = max(worst, float(np.median(mult)))
    m["C2"] = worst
    if worst > 1.10:
        bad.append(f"C2 独占者 {worst:.2f}x")

    # C3 同纪元横向公平
    r = E.run(mk(mech, tiers, cap, ro), E.TwoExiters())
    big = r["paid"][:, 0] / np.maximum(r["burned"][:, 0], 1e-18)
    small = r["paid"][:, 1] / np.maximum(r["burned"][:, 1], 1e-18)
    hz = big / np.maximum(small, 1e-18)
    m["C3"] = float(np.median(hz))
    if not (0.95 <= m["C3"] <= 1.05):
        bad.append(f"C3 大户/小户 {m['C3']:.2f}x")

    # C4 / C5 拆号饱和后的挤兑速度
    r = E.run(mk(mech, tiers, cap, ro),
              E.SoleExiter(s=40, whale_credits=10_000_000.0, other_credits=0.0))
    cum = r["track_paid_hist"]
    denom = r["p0"][:, None] + r["inflow_after"]
    d3 = float(np.median(cum[:, 2] / denom[:, 2]))
    d30 = float(np.median(cum[:, 29] / denom[:, 29]))
    m["C4"], m["C5"] = d3, d30
    if d3 > 0.15:
        bad.append(f"C4 3纪元 {d3*100:.0f}%")
    if d30 > 0.80:
        bad.append(f"C5 30纪元 {d30*100:.0f}%")

    # C6 正常体验
    r = E.run(mk(mech, tiers, cap, ro),
              E.SoleExiter(s=1, whale_credits=1_000_000.0, other_credits=9_000_000.0))
    d90 = float(np.median(days_to(r, 0.90)))
    m["C6"] = d90
    if d90 > 90:
        bad.append(f"C6 付清九成 {d90:.0f} 天")

    # C7 不变式
    ok = True
    for sc in ("dead", "modest", "viral"):
        rr = E.run(mk(mech, tiers, cap, ro, scenario=sc), E.Crowd(M=60))
        ok = ok and rr["inv_ok"] and float(rr["bal_hist"].min()) >= -1e-9
    m["C7"] = ok
    if not ok:
        bad.append("C7 不变式失败")
    return m, bad


def row_of(label, m, bad):
    return [*label, f"{m['C1'][0]:.2f}x", f"{m['C2']:.2f}x", f"{m['C3']:.2f}x",
            f"{m['C4']*100:.0f}%", f"{m['C5']*100:.0f}%", f"{m['C6']:.0f}",
            "通过" if m["C7"] else "失败",
            "**接受**" if not bad else "拒绝：" + "；".join(bad)]


HEAD = ["C1 先发", "C2 独占", "C3 横向", "C4 3纪元", "C5 30纪元", "C6 天", "C7", "结论"]

w("## 4. 参数扫描")
w()
w(f"每个格子 {TRIALS} 条随机路径，情景 `modest`（C7 三个情景都跑）。验收标准见 `sweep.py` 头部。")
w()

w("### 4.1 第一轮：分配口径 x leftover 去向（固定 `RELEASE_BPS 200/350/500` + `cap 1000`）")
w()
rows = []
for mech in E.MECHS:
    for ro in ("pool", "pot"):
        m, bad = evaluate(mech, (200, 350, 500), 1000, ro)
        rows.append(row_of([mech, ro], m, bad))
w(md_table(["口径", "leftover"] + HEAD, rows))
w()

w("### 4.2 第二轮：释放档位 x 单地址上限（口径 `LOCKED`、leftover 回池子）")
w()
rows = []
accepted = []
for tiers in [(100, 175, 250), (150, 250, 350), (200, 350, 500), (300, 500, 800),
              (500, 750, 1000)]:
    for cap in (250, 500, 1000, 2500):
        m, bad = evaluate(E.LOCKED, tiers, cap, "pool")
        if not bad:
            accepted.append((tiers, cap, m))
        rows.append(row_of([f"{tiers[0]}/{tiers[1]}/{tiers[2]}", cap], m, bad))
w(md_table(["RELEASE_BPS", "cap_bps"] + HEAD, rows))
w()
w(f"通过全部 7 条的组合：**{len(accepted)} 个**。")
w()
if accepted:
    rows = [[f"{t[0]}/{t[1]}/{t[2]}", c, f"{m['C4']*100:.0f}%", f"{m['C5']*100:.0f}%",
             f"{m['C6']:.0f}", f"{c/1e4*t[2]/1e4*100:.3f}%"] for t, c, m in accepted]
    w(md_table(["RELEASE_BPS", "cap_bps", "3 纪元可搬走", "30 纪元可搬走",
                "持10%者付清九成(天)", "单身份每纪元上限"], rows))
    w()

w("### 4.3 单地址上限被拆号绕过的程度（`LOCKED`、200/350/500）")
w()
w("某实体持有全部积分、第 0 天全额退出，拆成 s 个 agent 身份。")
w("`3 纪元可搬走` 在 s x cap >= 100% 之后就不再变化 —— 那一刻起，**唯一起作用的闸门是 RELEASE_BPS**。")
w()
rows = []
for cap in (500, 1000, 2500):
    cells = []
    for s in (1, 2, 5, 10, 20, 40):
        r = E.run(mk(E.LOCKED, (200, 350, 500), cap, "pool"),
                  E.SoleExiter(s=s, whale_credits=10_000_000.0, other_credits=0.0))
        d3 = np.median(r["track_paid_hist"][:, 2] /
                       (r["p0"] + r["inflow_after"][:, 2]))
        cells.append(f"{d3*100:.0f}%")
    rows.append([cap, f"{int(np.ceil(1e4/cap))}"] + cells)
w(md_table(["cap_bps", "饱和所需身份数", "s=1", "s=2", "s=5", "s=10", "s=20", "s=40"], rows))
w()

with open("out/sweep.md", "w", encoding="utf-8") as f:
    f.write("\n".join(OUT) + "\n")
print("\n[written] out/sweep.md")
