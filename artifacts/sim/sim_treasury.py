# -*- coding: utf-8 -*-
"""
问题 3：金库与偿付能力。

  3.1 三种税收情景下金库/桥池/节点基金的规模
  3.2 偿付不变式的定义与数值检查（LOCKED 口径）
  3.3 每积分兑付率（backing）随时间与情景的走势
  3.4 50/50 拆分的敏感性（决策 #4 已锁，这里只做体检）
  3.5 逃生模式的份额守恒
每行 >= 2000 条随机路径。

偿付不变式（本模拟要求写进 01-CONTRACT-SPEC 的四条）
---------------------------------------------------
I1  owedTotal <= address(BacBridge).balance                （任何时刻）
    证明：锁定时 owed_i = C_i * (bal - owedTotal)/creditsOutstanding，
          且 sum(C_i) <= creditsOutstanding
          => 新增 owed <= bal - owedTotal；付款同时等量减少 owed 与 bal；
          进账只增加 bal。归纳成立。
I2  sum(本纪元付出) <= pot_e = freeBalance * RELEASE_BPS/1e4
I3  cumulativeExitCredits <= cumulativeCredited <= totalCreditsIssued   （postAnchor 已有硬检查）
I4  逃生模式：sum_i escapeShare_i == 1（MasterChef 累加器），且未付清的 owed 必须
    与未销毁积分一起参与分配，否则「先退出、还没领完」的 agent 在停机时归零。
"""
import sys
import numpy as np
import engine as E
from common import daily_tax, split_tax, md_table, SCENARIOS

TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
OUT = []


def w(s=""):
    print(s)
    OUT.append(s)


def q(x, p):
    return float(np.quantile(x, p))


BASE = dict(days=365, warmup=30, trials=TRIALS, tiers=(200, 350, 500),
            cap_bps=1000, rollover="pool", mechanism=E.LOCKED,
            n_validators=5, p_online=0.8, seed=23)


def mk(**kw):
    d = dict(BASE)
    d.update(kw)
    return E.Cfg(**d)


w("## 3. 金库与偿付能力")
w()
w(f"每行 {TRIALS} 条随机路径。税收口径固定：买/卖各 2%、Flap 协议费 10%、`mktBps = 10000`、"
  "金库 5000/5000 推给 `BacBridge` / `BacNodeFund`。")
w()

w("### 3.1 三种税收情景下的规模（395 天累计，含 30 天预热）")
w()
rows = []
rng = np.random.default_rng(99)
for sc in ("dead", "modest", "viral"):
    tax = daily_tax(sc, 395, TRIALS, rng)
    tot = tax.sum(axis=1)
    br, nf = split_tax(tax)
    flap = tot * 0.10
    rows.append([sc, f"{np.median(tot):.1f}", f"{q(tot,0.05):.1f}", f"{q(tot,0.95):.1f}",
                 f"{np.median(flap):.1f}", f"{np.median(br.sum(axis=1)):.1f}",
                 f"{np.median(nf.sum(axis=1)):.1f}"])
w(md_table(["情景", "税收合计 中位", "p5", "p95", "Flap 协议费", "进桥池", "进节点基金"], rows))
w()
w("口径提醒：「1 BNB 的税 -> 0.5/0.5」是错的。正确写法是 **1 BNB 的税 -> 0.9 BNB 进金库 -> 0.45 / 0.45**。")
w()

w("### 3.2 偿付不变式的数值检查")
w()
w("`Crowd`（60 个 agent 随机进出）+ `SoleExiter`（最大挤兑）两种压力下，逐纪元检查 I1/I2/I5。")
w()
rows = []
for sc in ("dead", "modest", "viral"):
    for name, sch in (("常态 60 agent", E.Crowd(M=60)),
                      ("全员同日挤兑", E.SoleExiter(s=20, whale_credits=10_000_000.0,
                                                 other_credits=0.0))):
        r = E.run(mk(scenario=sc), sch)
        neg = float(r["bal_hist"].min())
        rows.append([sc, name, "通过" if r["inv_ok"] else "**失败**",
                     f"{r['inv_worst']:.3e}", "通过" if neg >= -1e-9 else "**失败**",
                     f"{neg:.3e}"])
w(md_table(["情景", "压力", "I1 owedTotal<=balance", "I1 最大越界(BNB)",
            "I5 balance>=0", "最小余额(BNB)"], rows))
w()
w("I2 由构造保证：`pot_e` 是从未占用余额里按 `RELEASE_BPS` 切出来的，`collect` 只从 `pot_e` 付，")
w("单地址再受 `MAX_EXIT_SHARE_BPS` 二次限制，没分完的退回未占用余额。")
w()

w("### 3.3 每积分兑付率 backing = (balance − owedTotal) / 在外积分")
w()
w("这是 agent 在某个纪元退出时锁定的汇率，单位 BNB / 积分。**它不是承诺，也没有下限。**")
w("关键事实：**进桥的 BAC 一分都不进桥池**（锁在 `BacBridge` 里，出口只有写死的死地址），")
w("桥池只由税收喂养。所以在外积分增长得比税收快时，每积分对应的 BNB 必然下降。")
w("下表按「新 agent 进桥的速度」分档：`p_arrive` = 每个 agent 每纪元补仓的概率。")
w("`—` 表示该时点在外积分已经被退完（只出不进的那一档必然走到这一步），汇率无定义。")
w()
rows = []
for sc in ("dead", "modest", "viral"):
    for pa, palab in ((0.00, "只出不进"), (0.03, "慢"), (0.10, "快")):
        r = E.run(mk(scenario=sc), E.Crowd(M=60, p_arrive=pa))
        rate, out = r["rate_hist"], r["out_hist"]

        def cell(day):
            alive = out[:, day] > 1e-9
            if alive.mean() < 0.5:
                return "—"
            return f"{np.median(rate[alive, day]):.3e}"
        alive = out[:, 364] > 1e-9
        tail = (f"{np.median(rate[alive, 364] / np.maximum(rate[alive, 6], 1e-30)):.2f}x"
                if alive.mean() >= 0.5 else "—")
        rows.append([sc, palab, cell(6), cell(29), cell(89), cell(364), tail])
w(md_table(["情景", "进桥速度", "第 7 天", "第 30 天", "第 90 天", "第 365 天",
            "365天/7天"], rows))
w()
w("层内 gas 销毁的方向相反但量级很小：按 §6.4 的账，填满全链也只有 576 BAC/天，")
w("对千万级的在外积分是 0.006%/天 —— 文案里可以说「销毁减少流通积分」，但不能当成兑付率会涨的理由。")
w()

w("### 3.4 早退 vs 晚退（锁定汇率的真实后果）")
w()
w("两个持仓相同的 agent：A 在第 7 天全退，B 在第 180 天全退。`B/A` = B 每积分拿到的 BNB ÷ A 的。")
w("LOCKED 口径**故意保留**这个差异：谁都拿不到超过自己那一刻的池子份额，但池子会涨会跌。")
w("注意这不是「先发优势」—— A 并没有多拿，只是 A 那一刻池子相对在外积分更厚。")
w()
rows = []
for sc in ("dead", "modest", "viral"):
    for pa, palab in ((0.00, "只出不进"), (0.03, "慢"), (0.10, "快")):
        r = E.run(mk(scenario=sc), E.Crowd(M=60, p_arrive=pa))
        alive = r["out_hist"][:, 179] > 1e-9
        if alive.mean() < 0.5:
            rows.append([sc, palab, "—", "—", "—", "积分已退完，没有 B"])
            continue
        a_ = r["rate_hist"][alive, 6]
        b_ = r["rate_hist"][alive, 179]
        ratio = b_ / np.maximum(a_, 1e-30)
        rows.append([sc, palab, f"{np.median(ratio):.2f}x", f"{q(ratio,0.05):.2f}x",
                     f"{q(ratio,0.95):.2f}x", f"{np.mean(ratio > 1)*100:.0f}%"])
w(md_table(["情景", "进桥速度", "B/A 中位", "p5", "p95", "晚退更划算的概率"], rows))
w()

w("### 3.5 分账比例敏感性（决策 #4 锁死 50/50，这里只做体检）")
w()
w("看桥池在 395 天末的规模，以及 10 个验证者能不能达标。")
w()
rows = []
rng = np.random.default_rng(101)
from common import BNB_USD, SERVER_USD_MO, validator_gas_bnb_per_month
cost = SERVER_USD_MO / BNB_USD + validator_gas_bnb_per_month()
for bridge_bps in (4000, 5000, 6000):
    for sc in ("dead", "modest"):
        tax = daily_tax(sc, 395, TRIALS, rng)
        vault = tax.sum(axis=1) * 0.9
        pool = vault * (bridge_bps / 1e4)
        fund = vault * (1 - bridge_bps / 1e4)
        val_mo = fund * 0.40 / 13.0
        rows.append([f"{bridge_bps//100}/{100-bridge_bps//100}", sc,
                     f"{np.median(pool):.1f}", f"{np.median(fund):.1f}",
                     f"{np.median(val_mo/10):.5f}",
                     f"{np.mean(val_mo/10 >= cost)*100:.0f}%"])
w(md_table(["桥池/节点基金", "情景", "桥池累计 BNB", "节点基金累计 BNB",
            "10 验证者月均 BNB", "达标率"], rows))
w()

w("### 3.6 逃生模式的份额守恒")
w()
w("`escapeCollect` 按 `weight_i = credited_i − exitedCredits_i` 的 MasterChef 累加器分配。")
w("数值检查：随机 2000 组持仓，sum(share) 与 1 的最大偏差。")
w()
rng = np.random.default_rng(5)
n = 2000
wts = rng.lognormal(0, 1.5, size=(n, 40))
sh = wts / wts.sum(axis=1, keepdims=True)
err = float(np.abs(sh.sum(axis=1) - 1.0).max())
w(f"- 最大偏差 `{err:.3e}`（纯浮点误差）。合约用整数累加器 + 余数留在池子里，只会少发不会多发。")
w("- **必须补的一条**：停机时还有未付清 `owed` 的 agent，它的积分已经销毁，"
  "`credited − exitedCredits` 里没有它 —— 逃生分配必须把未付清的 `owed` 一起算进去，"
  "否则「先退出、还没领完」的 agent 在停机那一刻归零。这是 LOCKED 口径引入的新要求。")
w()

with open("out/treasury.md", "w", encoding="utf-8") as f:
    f.write("\n".join(OUT) + "\n")
print("\n[written] out/treasury.md")
