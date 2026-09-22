# -*- coding: utf-8 -*-
"""
问题 1：桥池出口。
  1.1 三种分配口径下的先发优势（first-mover capture）
  1.2 单地址上限对「拆号」和「细水长流挂单」的抵抗力
  1.3 全局释放率 RELEASE_BPS 的实际效果
  1.4 MAX_EXIT_SHARE_BPS 档位
  1.5 leftover 去向
  1.6 第 1 周 / 第 1 月最幸运退出者
  1.7 鲸鱼第 1 周
  1.8 正常 agent 的退出时长（产品指标）
每行 >= 2000 条随机路径。
"""
import sys
import numpy as np
import engine as E
from common import md_table

TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
OUT = []


def w(s=""):
    print(s)
    OUT.append(s)


def q(x, p):
    return float(np.quantile(x, p))


def days_to(r, frac):
    """被跟踪方拿到「全部应付额 * frac」所需的天数；没拿到记为 >365。"""
    tot = r["track_paid_hist"][:, -1] + r["track_owed_hist"][:, -1]
    ok = r["track_paid_hist"] >= (frac * tot)[:, None]
    return np.where(ok.any(axis=1), ok.argmax(axis=1) + 1, r["days"] + 1)


def dstr(x):
    m = np.median(x)
    return ">365" if m > 365 else f"{m:.0f}"



BASE = dict(scenario="modest", days=365, warmup=30, trials=TRIALS,
            tiers=(200, 350, 500), cap_bps=1000, rollover="pool",
            n_validators=5, p_online=0.8, seed=11)


def mk(**kw):
    d = dict(BASE)
    d.update(kw)
    return E.Cfg(**d)


def sole(cfg, s, whole=True, drip=0.001):
    sch = E.SoleExiter(s=s, whale_credits=1_000_000.0, other_credits=9_000_000.0,
                       whole=whole, drip_frac=drip)
    r = E.run(cfg, sch)
    tn = r["track_n"]
    o = {}
    for d in (6, 29, r["days"] - 1):
        paid = r["snaps"][d][0][:, :tn].sum(axis=1)
        o[d] = paid / (r["p0"] + r["inflow_after"][:, d])
    # 每销毁 1 积分拿到多少 BNB，相对「公平汇率」= 池子/在外积分 的倍数
    burn = r["burned"][:, :tn].sum(axis=1)
    got = r["paid"][:, :tn].sum(axis=1)
    fair = (r["p0"] + r["inflow_after"][:, -1]) / 10_000_000.0
    o["mult"] = np.where(burn > 0, got / np.maximum(burn, 1e-18) / fair, 0.0)
    return o


def first_mover(cfg, a_split=1, M=50, crowd_start=7):
    r = E.run(cfg, E.FirstMover(M=M, crowd_start=crowd_start, a_split=a_split))
    tn = r["track_n"]
    pa = r["paid"][:, :tn].sum(axis=1)
    pt = r["paid"].sum(axis=1)
    ba = r["burned"][:, :tn].sum(axis=1)
    bc = r["burned"][:, tn:].sum(axis=1)
    pc = r["paid"][:, tn:].sum(axis=1)
    share = pa / np.maximum(pt, 1e-18)
    fair = ba / np.maximum(ba + bc, 1e-18)
    ratio = (pa / np.maximum(ba, 1e-18)) / np.maximum(pc / np.maximum(bc, 1e-18), 1e-18)
    return share, ratio, fair


def whale(cfg, s=1, mult=10.0):
    r = E.run(cfg, E.Whale(M=50, mult=mult, s=s))
    tn = r["track_n"]
    p7 = r["snaps"][6][0]
    wp = p7[:, :tn].sum(axis=1)
    return wp / r["p0"], wp / np.maximum(p7.sum(axis=1), 1e-18)


def luckiest(cfg):
    r = E.run(cfg, E.Crowd(M=60))
    o = {}
    for d in (6, 29):
        paid = r["snaps"][d][0]
        o[d] = paid.max(axis=1) / np.maximum(paid.sum(axis=1), 1e-18)
    return o


w("## 1. 桥池出口")
w()
w(f"每行 {TRIALS} 条随机路径（税收流入、见证人数、退出时点全部随机）。默认情景 `modest`、"
  "默认参数 `RELEASE_BPS 200/350/500`、`MAX_EXIT_SHARE_BPS 1000`、`leftover 回池子`、5 个验证者。")
w()

w("### 1.1 三种分配口径下的先发优势")
w()
w("`FirstMover`：A 从第 0 天起每个纪元挂出手上 10% 的积分，第 7 天起另外 50 个等额 agent 同样操作，跑满 365 天。")
w("`公平基准` = A 销毁的积分占全部已销毁积分的比例；`A 占比` 应当贴着它。")
w("`兑付率倍数` = A 的 BNB/积分 ÷ 其他人的 BNB/积分，**1.00 = 没有先发优势**。")
w()
rows = []
for mech in E.MECHS:
    for sc in ("dead", "modest", "viral"):
        share, ratio, fair = first_mover(mk(mechanism=mech, scenario=sc))
        rows.append([mech, sc, f"{np.median(fair)*100:.2f}%",
                     f"{np.median(share)*100:.2f}%", f"{q(share,0.95)*100:.2f}%",
                     f"{np.median(ratio):.2f}x", f"{q(ratio,0.95):.2f}x"])
w(md_table(["分配口径", "情景", "公平基准", "A 占比 中位", "A 占比 p95",
            "兑付率倍数 中位", "兑付率倍数 p95"], rows))
w()

w("### 1.2 单地址上限 `MAX_EXIT_SHARE_BPS = 1000` 挡不挡得住拆号 / 细水长流")
w()
w("`SoleExiter`：某实体持 100 万积分、其他人持 900 万积分且全年从不退出。")
w("`整单` = 每纪元把手上剩下的全部挂单；`细水` = 每纪元只挂原始持仓的 0.1%（专门吃掉「队列里只有我」的那份 pot）。")
w("`兑付率倍数` = 它每销毁 1 积分拿到的 BNB ÷ 公平汇率（全年池子总额 ÷ 1000 万积分）。")
w()
rows = []
for mech in E.MECHS:
    for s in (1, 5, 10, 20):
        for mode, whole in (("整单", True), ("细水", False)):
            o = sole(mk(mechanism=mech), s, whole=whole)
            rows.append([mech, s, mode, f"{np.median(o[6])*100:.2f}%",
                         f"{np.median(o[29])*100:.2f}%", f"{np.median(o[364])*100:.2f}%",
                         f"{np.median(o['mult']):.2f}x"])
w(md_table(["分配口径", "拆号数 s", "挂单方式", "7 天占池子累计", "30 天", "365 天",
            "兑付率倍数"], rows))
w()

w("### 1.3 全局释放率 `RELEASE_BPS` 的效果")
w()
w("`LOCKED` 口径，一个持有全部 1000 万积分的实体在第 0 天一次性全部退出（最大挤兑），拆 20 个号。")
w("表里是它累计拿到的 BNB 占桥池累计收到的全部 BNB 的比例。")
w()
rows = []
for tiers in [(100, 175, 250), (200, 350, 500), (300, 500, 800), (500, 750, 1000)]:
    for nv in (0, 5):
        sch = E.SoleExiter(s=20, whale_credits=10_000_000.0, other_credits=0.0)
        r = E.run(mk(mechanism=E.LOCKED, tiers=tiers, n_validators=nv), sch)
        vals = []
        for d in (6, 29, 89, 364):
            p = r["snaps"][d][0][:, :20].sum(axis=1)
            vals.append(f"{np.median(p / (r['p0'] + r['inflow_after'][:, d]))*100:.2f}%")
        rows.append([f"{tiers[0]}/{tiers[1]}/{tiers[2]}", nv] + vals)
w(md_table(["RELEASE_BPS 档位", "验证者数", "7 天", "30 天", "90 天", "365 天"], rows))
w()

w("### 1.4 `MAX_EXIT_SHARE_BPS` 档位（LOCKED）")
w()
w("左列 = 安全上限：中继私钥被盗、伪造一个把自己写进去的 `exitRoot` 时，每纪元最多能搬走池子的多少（最高释放档 500bps）。")
w("右边 = 正常体验：一个持 10% / 50% 积分的 agent 全额退出后，拿到应付额 50% / 90% 需要多少天（中位）。")
w()
rows = []
for cap in (250, 500, 1000, 2500, 5000, 10000):
    cells = []
    for frac_credit in (0.10, 0.50):
        tot = 10_000_000.0
        sch = E.SoleExiter(s=1, whale_credits=tot * frac_credit,
                           other_credits=tot * (1 - frac_credit))
        r = E.run(mk(mechanism=E.LOCKED, cap_bps=cap), sch)
        cells.append(dstr(days_to(r, 0.50)))
        cells.append(dstr(days_to(r, 0.90)))
    rows.append([cap, f"{cap/1e4*500/1e4*100:.3f}%"] + cells)
w(md_table(["cap_bps", "被盗中继每纪元上限", "持 10%·付清一半(天)", "持 10%·付清九成(天)",
            "持 50%·付清一半(天)", "持 50%·付清九成(天)"], rows))
w()

w("### 1.5 截掉 / 无人认领的部分去哪（`rollover`）")
w()
rows = []
for ro in ("pool", "pot"):
    for mech in E.MECHS:
        o = sole(mk(mechanism=mech, rollover=ro), 1)
        share, ratio, fair = first_mover(mk(mechanism=mech, rollover=ro))
        rows.append([ro, mech, f"{np.median(o[6])*100:.2f}%", f"{np.median(o[29])*100:.2f}%",
                     f"{np.median(o['mult']):.2f}x", f"{np.median(ratio):.2f}x"])
w(md_table(["leftover 去向", "口径", "独占者 7 天", "独占者 30 天", "独占者兑付率倍数",
            "先发兑付率倍数"], rows))
w()

w("### 1.6 第 1 周 / 第 1 月最幸运的退出者")
w()
w("60 个 agent 随机进出（每纪元 12% 概率整单退出、10% 概率补仓），取每条路径上拿得最多的那一个。")
w("`占比` = 它拿到的 BNB ÷ 同期所有人拿到的 BNB；完全平均时约 1/60 = 1.67%。")
w("`超额倍数` = 该占比 ÷ 它销毁的积分占同期全部销毁积分的比例，**1.00 = 它只是本来就大，没有抢跑**。")
w()
rows = []
for mech in E.MECHS:
    for sc in ("dead", "modest", "viral"):
        r = E.run(mk(mechanism=mech, scenario=sc), E.Crowd(M=60))
        cells = []
        for d in (6, 29):
            paid, burned, _ = r["snaps"][d]
            tot = np.maximum(paid.sum(axis=1), 1e-18)
            i = paid.argmax(axis=1)
            sh = paid.max(axis=1) / tot
            bsh = burned[np.arange(len(i)), i] / np.maximum(burned.sum(axis=1), 1e-18)
            cells += [f"{np.median(sh)*100:.2f}%", f"{q(sh,0.95)*100:.2f}%",
                      f"{np.median(sh/np.maximum(bsh,1e-18)):.2f}x"]
        rows.append([mech, sc] + cells)
w(md_table(["分配口径", "情景", "周1 最高 中位", "周1 最高 p95", "周1 超额倍数",
            "月1 最高 中位", "月1 最高 p95", "月1 超额倍数"], rows))
w()

w("### 1.7 鲸鱼（10x 普通 agent）第 1 周独自退出")
w()
rows = []
for mech in E.MECHS:
    for s in (1, 10):
        a, b = whale(mk(mechanism=mech), s=s)
        rows.append([mech, s, f"{np.median(a)*100:.2f}%", f"{q(a,0.95)*100:.2f}%",
                     f"{np.median(b)*100:.2f}%"])
w(md_table(["分配口径", "拆号数", "占周初桥池 中位", "占周初桥池 p95",
            "占周 1 已付出 BNB"], rows))
w()

w("### 1.8 正常 agent 的退出时长（LOCKED，推荐参数 200/350/500 + cap 1000）")
w()
w("某 agent 一次性全额退出，其余人不退出。表里是它拿到应付额 50% / 90% / 99% 所需的天数（中位）。")
w()
rows = []
for nv in (0, 5):
    for frac_credit, label in ((0.01, "1%"), (0.10, "10%"), (0.50, "50%"), (1.00, "100%")):
        tot = 10_000_000.0
        sch = E.SoleExiter(s=1, whale_credits=tot * frac_credit,
                           other_credits=tot * (1 - frac_credit))
        r = E.run(mk(mechanism=E.LOCKED, n_validators=nv), sch)
        rows.append([nv, label, dstr(days_to(r, 0.5)), dstr(days_to(r, 0.9)),
                     dstr(days_to(r, 0.99))])
w(md_table(["验证者数", "该 agent 占全部积分", "付清一半(天)", "付清九成(天)",
            "付清 99%(天)"], rows))
w()

with open("out/bridge.md", "w", encoding="utf-8") as f:
    f.write("\n".join(OUT) + "\n")
print("\n[written] out/bridge.md")
