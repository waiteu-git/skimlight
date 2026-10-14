"""CLI（Python）の判定から、Web 版（TypeScript）と共有するテストベクトルを書き出す。

  python3 -m tools.export_vectors          web/test-vectors/*.json を書き直す
  python3 -m tools.export_vectors --check  書き出した内容と現在の判定が一致するか（CI・コミット前）

入力はこのファイルに書いた架空・短い文だけ（実在の要項の本文は入れない）。
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

from ruleaudit.adjudicate import adjudicate
from ruleaudit.cards import Requirement
from ruleaudit.quotes import find_terms, match_quote, term_sentences
from ruleaudit.textnorm import normalize
from ruleaudit.vocab import qualifiers

OUT = Path(__file__).resolve().parents[1] / "web" / "test-vectors"

NORMALIZE = [
    "応募締切日時点で年齢２５才以下であること",
    "ｶﾞｷﾞｸﾞ ﾊﾟﾋﾟﾌﾟ",
    "がぎ",
    "# 見出し\n> 引用の行\n本文の x>=5 と C# は残す",
    "**太字** と `コード` と |表|",
    "全角　空白\tタブ\n改行",
    "①②③ ㈱ ㍉ ﬁ",
    "ゼロ幅​スペース‍と異体字セレクタ️",
    "Ｅｎｇｌｉｓｈ ＡＢＣ　１２３",
    "",
    "\u1100\u1161\u11a8 한글 ﾊﾝｸﾞﾙ",
    "a\u0301\u0323 e\u0323\u0301 Z\u0336\u0337\u0338\u0339\u033a",
    "𠮷野家の𩸽と👍🏽と🇯🇵",
    "x>=5\n>=6 行頭の比較",
    "表|セル｜全角の区切り",
    "\ufeff先頭のBOMと\u00a0ノーブレーク\u3000空白",
    "ｱｲｳｴｵ ﾞﾟ ｳﾞ ｶﾞ",
    "No.１～３、ＡＢＣ−ＤＥＦ ～ 〜 ー",
]

DOC = (
    "応募資格\n1. 応募時点で学部1～3年生の方\n３． 応募締切日時点で年齢２５才以下であること\n"
    "他の奨学金と併願・併給も可能です。ただし、学内選考の奨学金を除きます。\n"
    "ITエンジニア職の正社員としての就業経験がないこと(ただし、アルバイトは含みません)。\n"
    "外国籍の方も応募できます。しかし、外国からの留学生の方は応募できません。\n"
    "募集受付 2026年8月25日～2026年10月18日まで\n"
    "応募資格は学部生\u001eに限ります\n"
)
QUOTES = [
    "応募締切日時点で年齢25才以下であること",
    "締切の時点で25歳以下であること",
    "以下",
    "",
    "他の奨学金と併願・併給も可能です。",
    "ITエンジニア職の正社員としての就業経験がないこと",
    "外国からの留学生の方は応募できません",
    "応募資格は学部生に限ります",
    "応募時点で学部1～3年生の方",
    "募集受付 2026年8月25日～2026年10月18日まで",
]
QUALIFIER_TEXTS = [
    "ただし、海外在住の場合は不要です",
    "応募締切日時点で年齢25才以下であること",
    "必ずしも必要ではありません",
    "チームの方は代表者が提出してください",
    "不可欠な書類",
]
TERMS = [["併給", "高校"], ["学内選考"], ["存在しない語"]]

AGE = {"field": "birth_date", "op": "age_at_most", "value": 25, "as_of": "2026-10-18"}
ADJ = [
    ("quoted_in_range", dict(quote="応募締切日時点で年齢25才以下であること", check=AGE), {"birth_date": "2006-04-01"}, "2026-10-12"),
    ("out_of_range", dict(quote="応募締切日時点で年齢25才以下であること", check=AGE), {"birth_date": "2000-01-01"}, "2026-10-12"),
    ("birthday_on_deadline", dict(quote="応募締切日時点で年齢25才以下であること", check=AGE), {"birth_date": "2000-10-18"}, "2026-10-12"),
    ("missing_situation", dict(quote="応募締切日時点で年齢25才以下であること", check=AGE), {}, "2026-10-12"),
    ("fabricated", dict(quote="1年生は高校の成績証明書で構いません"), {}, "2026-10-12"),
    ("absent_ok", dict(quote=None, absent_terms=["高校", "代替"]), {}, "2026-10-12"),
    ("absent_present", dict(quote=None, absent_terms=["学内選考"]), {}, "2026-10-12"),
    ("deadline_open", dict(kind="締切", quote="募集受付 2026年8月25日～2026年10月18日まで", deadline="2026-10-18"), {}, "2026-10-12"),
    ("deadline_passed", dict(kind="締切", quote="募集受付 2026年8月25日～2026年10月18日まで", deadline="2026-10-18"), {}, "2026-10-19"),
    ("qualifier_outside", dict(quote="ITエンジニア職の正社員としての就業経験がないこと",
                               check={"field": "career.it_engineer_fulltime", "op": "is_false"}),
     {"career": {"it_engineer_fulltime": False}}, "2026-10-12"),
    ("in_list_type_mismatch", dict(quote="応募時点で学部1～3年生の方", check={"field": "school.grade", "op": "in", "value": [1, 2, 3]}),
     {"school": {"grade": "1"}}, "2026-10-12"),
]


def build() -> dict[str, object]:
    norm = []
    for t in NORMALIZE:
        n = normalize(t)
        norm.append({"input": t, "text": n.text, "starts": list(n.starts), "ends": list(n.ends),
                     "gap_after": list(n.gap_after), "consistent": n.consistent})
    quotes = []
    for q in QUOTES:
        m = match_quote(q, DOC)
        quotes.append({"quote": q, "ok": m.ok, "reason": m.reason, "count": m.count, "start": m.start, "end": m.end,
                       "sentence": m.sentence, "qualifiers_outside": m.qualifiers_outside,
                       "qualifiers_inside": m.qualifiers_inside, "conditions_inside": m.conditions_inside})
    quals = [{"text": t, "all": qualifiers(t), "no_negation": qualifiers(t, negation=False)} for t in QUALIFIER_TEXTS]
    terms = [{"terms": ts, "found": find_terms(ts, DOC), "sentences": term_sentences(ts, DOC)} for ts in TERMS]
    adj = []
    for name, kw, situation, today in ADJ:
        base = dict(id="R1", kind="資格", topic="t", source="S1", quote=None)
        base.update(kw)
        f = adjudicate(Requirement(**base), DOC, situation, date.fromisoformat(today))
        adj.append({"name": name, "requirement": base, "situation": situation, "today": today,
                    "status": f.status, "reasons": f.reasons})
    return {
        "normalize.json": norm,
        "quotes.json": {"doc": DOC, "cases": quotes, "qualifiers": quals, "terms": terms},
        "adjudicate.json": {"doc": DOC, "cases": adj},
    }


def main() -> int:
    check = "--check" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    bad = 0
    for name, data in build().items():
        text = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
        p = OUT / name
        if check:
            if not p.exists() or p.read_text(encoding="utf-8") != text:
                print(f"一致しません: {p}")
                bad += 1
        else:
            p.write_text(text, encoding="utf-8")
            print(f"書き出し: {p}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
