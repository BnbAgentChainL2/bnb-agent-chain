#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""x_length.py — X (Twitter) 加权字数检查器。只读，不联网，不发任何东西。

用法（Windows 上先 set PYTHONIOENCODING=utf-8）：

    PYTHONIOENCODING=utf-8 python scripts/x_length.py
    PYTHONIOENCODING=utf-8 python scripts/x_length.py docs/05-X文案.md --json

它做的事：把 Markdown 里每一个「无语言标记的围栏代码块」当成一条待发的帖子，
按 X 的 twitter-text v3 权重配置算加权长度，逐条打印 PASS / FAIL。
有任何一条超限就以 exit 1 结束，可以直接挂进 CI。

权重规则（twitter-text v3 configs/v3.json，逐字照抄）：
  · defaultWeight = 200（即 2 个计数单位），scale = 100，maxWeightedTweetLength = 280
  · 下面四段码点区间的权重是 100（即 1 个计数单位）：
      U+0000–U+10FF, U+2000–U+200D, U+2010–U+201F, U+2032–U+2037
    其余一切（CJK、假名、谚文、绝大多数 emoji）都按 2 计。
  · 任何 http:// 或 https:// 链接一律按 23 计（t.co 短链长度，transformedURLLength）。
  · bio（个人简介）的上限是 160，不是 280。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

DEFAULT_DOC = "docs/05-X文案.md"

TWEET_LIMIT = 280
BIO_LIMIT = 160
URL_WEIGHT = 23

# twitter-text v3: 权重为 1 的码点区间（闭区间）。其余按 2 计。
LIGHT_RANGES = (
    (0x0000, 0x10FF),
    (0x2000, 0x200D),
    (0x2010, 0x201F),
    (0x2032, 0x2037),
)

URL_RE = re.compile(r"https?://[^\s<>\"'）)】」]+")
FENCE_RE = re.compile(r"^\s*```(.*)$")
SMART_QUOTES = "\u201c\u201d\u2018\u2019"


def char_weight(ch: str) -> int:
    cp = ord(ch)
    for lo, hi in LIGHT_RANGES:
        if lo <= cp <= hi:
            return 1
    return 2


def weighted_length(text: str) -> int:
    """X 的加权长度：链接按 23，CJK/emoji 按 2，其余按 1。"""
    total = 0
    idx = 0
    for m in URL_RE.finditer(text):
        total += sum(char_weight(c) for c in text[idx:m.start()])
        total += URL_WEIGHT
        idx = m.end()
    total += sum(char_weight(c) for c in text[idx:])
    return total


# 「唯一」作为事实性范围陈述是允许的（04-X-PROMPTS.md §7 明确列出），
# 作为优越性主张才是事故。这里只放行已经被规格点名的几个搭配。
ALLOWED_SOLE = ("唯一出口", "唯一入口", "唯一的写方法", "the only real brake", "the only source")


def lint(text: str) -> list[str]:
    """几条硬规则的粗检查。命中不算 FAIL，只打 WARN，人工复核。"""
    warns = []
    if any(q in text for q in SMART_QUOTES):
        warns.append("弯引号（必须用直引号 \" '）")
    scrubbed = text
    for ok in ALLOWED_SOLE:
        scrubbed = scrubbed.replace(ok, "")
    for bad in ("唯一", "第一条", "the only chain", "the first chain", "APY", "年化", "稳赚", "回本"):
        if bad in scrubbed:
            warns.append(f"命中禁用词：{bad}（作为优越性主张时是事故，请人工判断）")
    if re.search(r"0x[0-9a-fA-F]{40}", text):
        warns.append("出现了一个完整的 40 位地址（发射前不许发 CA）")
    return warns


def parse_blocks(path: str):
    """返回 [(label, is_bio, body)]：每个无语言标记的围栏块，配上它上方最近的标题行。"""
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")

    blocks = []
    label = "(文件开头)"
    section = ""
    in_fence = False
    lang = ""
    buf: list[str] = []

    for raw in lines:
        m = FENCE_RE.match(raw)
        if m and not in_fence:
            in_fence, lang, buf = True, m.group(1).strip().lower(), []
            continue
        if m and in_fence:
            in_fence = False
            if lang in ("", "text", "txt"):
                body = "\n".join(buf).strip("\n")
                if body.strip():
                    is_bio = "bio" in label.lower() or "bio" in section.lower()
                    blocks.append((label, is_bio, body))
            continue
        if in_fence:
            buf.append(raw)
            continue

        stripped = raw.strip()
        if stripped.startswith("#"):
            section = stripped.lstrip("# ").strip()
            label = section
        elif stripped.startswith("**") and stripped.endswith("**") and len(stripped) > 4:
            label = stripped.strip("*").strip()

    return blocks


def main() -> int:
    ap = argparse.ArgumentParser(description="X 文案加权字数检查（只读）")
    ap.add_argument("paths", nargs="*", default=[DEFAULT_DOC],
                    help="要检查的 Markdown 文件，默认 docs/05-X文案.md")
    ap.add_argument("--json", action="store_true", help="输出 JSON 而不是表格")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    results = []
    failures = 0

    for p in args.paths:
        path = p if os.path.isabs(p) else os.path.join(root, p)
        if not os.path.exists(path):
            print(f"找不到文件：{path}", file=sys.stderr)
            return 2
        for label, is_bio, body in parse_blocks(path):
            limit = BIO_LIMIT if is_bio else TWEET_LIMIT
            n = weighted_length(body)
            ok = n <= limit
            if not ok:
                failures += 1
            results.append({
                "file": os.path.relpath(path, root).replace("\\", "/"),
                "label": label, "limit": limit, "weighted": n,
                "status": "PASS" if ok else "FAIL",
                "over": max(0, n - limit),
                "warns": lint(body),
                "first_line": body.split("\n")[0][:40],
            })

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 1 if failures else 0

    print(f"{'状态':<6}{'加权':>5} /{'上限':>4}  条目")
    print("-" * 78)
    for r in results:
        print(f"{r['status']:<6}{r['weighted']:>5} /{r['limit']:>4}  {r['label']}")
        for w in r["warns"]:
            print(f"      WARN  {w}")
        if r["status"] == "FAIL":
            print(f"      超出 {r['over']} —— 必须改短，这条发不出去")
    print("-" * 78)
    print(f"共 {len(results)} 条；失败 {failures} 条。"
          + ("" if failures else " 全部在限内。"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
