"""規則ページの差分監視（最小版）。

新しい控えと前の控えを比べ、変わった行と「あなたのカードの要件のうち、影響を受けたもの」を出す。
影響の判定もコードだけで行う:
  - QUOTE_LOST     : 前は照合できた引用が、新しい原文で照合できない（条件が書き換わった疑い）
  - QUOTE_FOUND    : 前は照合できなかった引用が、新しい原文で照合できる
  - SENTENCE_CHANGED: 引用は残っているが、引用を含む文が変わった（条件・例外が足された疑い）
  - TERM_APPEARED  : 「記載なし」の要件の裏取りの語が、新しい原文に現れた
"""
from __future__ import annotations

import difflib
from dataclasses import dataclass, field

from ruleaudit.cards import Requirement
from ruleaudit.quotes import find_terms, match_quote


@dataclass
class SourceDiff:
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    affected: list[tuple[str, str, str]] = field(default_factory=list)  # (要件ID, 変化, 説明)

    @property
    def changed(self) -> bool:
        return bool(self.added or self.removed)


def diff_texts(old: str, new: str, reqs: list[Requirement]) -> SourceDiff:
    out = SourceDiff()
    for line in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=0):
        if line.startswith(("+++", "---", "@@")):
            continue
        if line.startswith("+"):
            out.added.append(line[1:])
        elif line.startswith("-"):
            out.removed.append(line[1:])
    if not out.changed:
        return out
    for r in reqs:
        if r.quote is None:
            before, after = set(find_terms(r.absent_terms, old)), set(find_terms(r.absent_terms, new))
            appeared = sorted(after - before)
            if appeared:
                out.affected.append((r.id, "TERM_APPEARED", "新しく現れた語: " + "、".join(appeared)))
            continue
        mo, mn = match_quote(r.quote, old), match_quote(r.quote, new)
        if mo.ok and not mn.ok:
            out.affected.append((r.id, "QUOTE_LOST", "前の原文にあった引用が、新しい原文に見つかりません"))
        elif not mo.ok and mn.ok:
            out.affected.append((r.id, "QUOTE_FOUND", "前の原文に無かった引用が、新しい原文にあります"))
        elif mo.ok and mn.ok and mo.sentence != mn.sentence:
            out.affected.append((r.id, "SENTENCE_CHANGED", f"文が変わりました: 「{mo.sentence}」→「{mn.sentence}」"))
    return out
