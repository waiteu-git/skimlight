"""3値の結果を決める唯一の場所（コードだけで決める。AI は結果を書けない）。

結果の語は3つだけ。「適合」「当たる」とは言わない。決めるのは本人。
  - 引用あり: 要件の引用が原文の控えと逐語で一致し、気になる点が見つからなかった。
  - 引用なし: 要項にその観点の記載が見つからない（カードが「記載なし」とし、裏取りの語も原文に無かった）。
  - 要確認  : それ以外。理由コードを必ず付ける（引用が原文に無い・条件や例外の語がある・状況の値が無い・
              範囲から外れて見える・締切を過ぎている・控えが無い・関連語が原文にある など）。

状況との比較は「並べた結果」として注記に出す（範囲内／範囲外に見える）。範囲外に見える時は「要確認」に倒す。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from ruleaudit import situation as sit
from ruleaudit.cards import Requirement
from ruleaudit.quotes import QuoteMatch, find_terms, match_quote, term_sentences

QUOTED = "引用あり"
NO_QUOTE = "引用なし"
REVIEW = "要確認"

# 理由コード → 人が次にすること（固定文）
REASONS = {
    "NO_SNAPSHOT": "原文の控えがありません。fetch で取得してください",
    "QUOTE_NOT_FOUND": "カードの引用が原文に見つかりません（言い換え・転記ミス・要項の変更の疑い）。原文を開いて確かめてください",
    "QUOTE_TOO_SHORT": "引用が短すぎて照合できません。文の単位で引用してください",
    "QUALIFIER_OUTSIDE": "引用の前後に、条件・例外・否定の語があります（切り取りの疑い）。文の全体を読んでください",
    "QUALIFIER_WITH_CHECK": "引用に条件・例外の語があり、数値の並べでは扱いきれません。文を読んで確かめてください",
    "SITUATION_MISSING": "状況のファイルにこの項目がありません。値を入れると並べられます",
    "OUT_OF_RANGE": "あなたの値が、引用の条件から外れて見えます。原文と値を確かめてください",
    "UNCOMPARABLE": "あなたの値と条件の型が合わず、並べられません",
    "DEADLINE_PASSED": "締切を過ぎています",
    "TERM_PRESENT": "「記載なし」としたが、関連する語が原文にあります。該当箇所を読んでください",
    "SNAPSHOT_CHANGED": "カードを作った後に原文が変わっています。差分を確かめてください",
}


@dataclass
class Finding:
    req_id: str
    topic: str
    kind: str
    status: str
    reasons: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    quote: str | None = None
    sentence: str = ""
    source_id: str = ""
    match: QuoteMatch | None = None


def _years_between(born: date, as_of: date) -> int:
    return as_of.year - born.year - ((as_of.month, as_of.day) < (born.month, born.day))


def compare(check: dict, situation: dict) -> tuple[str, str]:
    """(結果, 注記)。結果は "in" / "out" / "missing" / "uncomparable"。"""
    op = check["op"]
    want = check.get("value")
    have = sit.get(situation, check["field"])
    label = check.get("label", check["field"])
    if have is None:
        return "missing", f"{label}: 状況に値がありません"
    try:
        if op in ("age_at_most", "age_at_least"):
            as_of = date.fromisoformat(check["as_of"])
            age = _years_between(date.fromisoformat(str(have)), as_of)
            ok = age <= want if op == "age_at_most" else age >= want
            rel = "以下" if op == "age_at_most" else "以上"
            return ("in" if ok else "out"), f"{label}: {as_of.isoformat()} 時点で {age} 歳（条件 {want} 歳{rel}）"
        if op == "in":
            ok = have in want
        elif op == "not_in":
            ok = have not in want
        elif op == "contains":
            ok = want in have
        elif op == "is_true":
            ok = have is True
        elif op == "is_false":
            ok = have is False
        else:
            ok = {"<=": have <= want, "<": have < want, ">=": have >= want, ">": have > want,
                  "==": have == want, "!=": have != want}[op]
    except (TypeError, ValueError, KeyError):
        return "uncomparable", f"{label}: 値 {have!r} と条件 {op} {want!r} を並べられません"
    return ("in" if ok else "out"), f"{label}: あなたの値 {_show(have)}／条件 {_show_cond(op, want)}"


def _show(v) -> str:
    if v is True:
        return "はい"
    if v is False:
        return "いいえ"
    if isinstance(v, list):
        return "・".join(_show(x) for x in v)
    return str(v)


def _show_cond(op: str, want) -> str:
    return {
        "is_true": "「はい」であること", "is_false": "「いいえ」であること",
        "in": f"{_show(want)} のどれか", "not_in": f"{_show(want)} のどれでもない",
        "contains": f"「{_show(want)}」を含む", "<=": f"{_show(want)} 以下", "<": f"{_show(want)} 未満",
        ">=": f"{_show(want)} 以上", ">": f"{_show(want)} 超", "==": f"{_show(want)} と同じ", "!=": f"{_show(want)} 以外",
    }.get(op, f"{op} {_show(want)}")


def adjudicate(req: Requirement, doc: str | None, situation: dict, today: date) -> Finding:
    f = Finding(req.id, req.topic, req.kind, REVIEW, quote=req.quote, source_id=req.source)
    if doc is None:
        f.reasons.append("NO_SNAPSHOT")
        return f

    if req.quote is None:
        present = find_terms(req.absent_terms, doc)
        if present:
            f.reasons.append("TERM_PRESENT")
            f.notes.append("原文にある関連語: " + "、".join(present))
            for sent in term_sentences(present, doc):
                f.notes.append(f"原文の文: 「{sent}」")
        else:
            f.status = NO_QUOTE
            f.notes.append("裏取りの語（" + "、".join(req.absent_terms) + "）は原文にありません")
        return f

    m = match_quote(req.quote, doc)
    f.match = m
    if not m.ok:
        f.reasons.append("QUOTE_TOO_SHORT" if m.reason == "TOO_SHORT" else "QUOTE_NOT_FOUND")
        return f
    f.sentence = m.sentence
    if m.count > 1:
        f.notes.append(f"原文に同じ文が {m.count} か所あります（最初の箇所を表示）")
    if m.qualifiers_outside:
        f.reasons.append("QUALIFIER_OUTSIDE")
        f.notes.append("引用の外の語: " + "、".join(m.qualifiers_outside))
    if req.check is not None:
        if m.conditions_inside:
            f.reasons.append("QUALIFIER_WITH_CHECK")
            f.notes.append("引用の中の語: " + "、".join(m.conditions_inside))
        result, note = compare(req.check, situation)
        f.notes.append("並べた結果（判断ではありません）: " + note)
        if result == "missing":
            f.reasons.append("SITUATION_MISSING")
        elif result == "out":
            f.reasons.append("OUT_OF_RANGE")
        elif result == "uncomparable":
            f.reasons.append("UNCOMPARABLE")
    if req.deadline:
        d = date.fromisoformat(req.deadline)
        days = (d - today).days
        if days < 0:
            f.reasons.append("DEADLINE_PASSED")
        else:
            f.notes.append(f"締切まで {days} 日（{d.isoformat()}・時刻はカードでなく原文で確認）")
    if not f.reasons:
        f.status = QUOTED
    return f
