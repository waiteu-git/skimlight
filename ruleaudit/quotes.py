"""引用の逐語照合。要件カードの引用を、取得した原文の控えに当てる。

一致した時だけ「照合済み」を返す。照合済みかどうかを決めるのはこのモジュールだけで、要件カードを書いた者
（人・AI のどちらでも）の申告は使わない。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ruleaudit.textnorm import BLOCK_SEP, normalize
from ruleaudit.vocab import qualifiers

# 正規化後にこれより短い引用は照合しない（「こと」「以下」のような断片はどこにでも一致する）。
MIN_QUOTE_CHARS = 8
# 文の区切り（原文側）。
_SENTENCE_END = frozenset("。．！？!?\n\r" + BLOCK_SEP)


@dataclass(frozen=True)
class QuoteMatch:
    ok: bool
    reason: str  # "VERIFIED" | "NOT_FOUND" | "TOO_SHORT" | "EMPTY"
    count: int = 0  # 原文中の一致の数（2以上でも照合済み。位置は最初の一致）
    start: int = -1  # 原文上の位置 [start, end)
    end: int = -1
    sentence: str = ""  # 引用を含む原文の文（表示用に原文から切り出す）
    qualifiers_outside: list[str] = field(default_factory=list)  # 文のうち引用の外にある否定・例外・条件の語
    qualifiers_inside: list[str] = field(default_factory=list)  # 引用の中にある否定・例外・条件の語
    conditions_inside: list[str] = field(default_factory=list)  # 引用の中にある例外・条件の語（否定語を除く）


def _sentence_bounds(text: str, start: int, end: int) -> tuple[int, int]:
    s = start
    while s > 0 and text[s - 1] not in _SENTENCE_END:
        s -= 1
    e = end
    if e > 0 and text[e - 1] in _SENTENCE_END:  # 引用が文末の句点まで含む
        return s, e
    while e < len(text) and text[e] not in _SENTENCE_END:
        e += 1
    if e < len(text) and text[e] in "。．！？!?":
        e += 1
    return s, e


def match_quote(quote: str | None, doc: str) -> QuoteMatch:
    if not quote or not quote.strip():
        return QuoteMatch(False, "EMPTY")
    q = normalize(quote)
    if len(q) < MIN_QUOTE_CHARS:
        return QuoteMatch(False, "TOO_SHORT")
    d = normalize(doc)
    if not d.consistent:
        return QuoteMatch(False, "NOT_FOUND")
    first = d.text.find(q.text)
    if first < 0:
        return QuoteMatch(False, "NOT_FOUND")
    count = 0
    pos = first
    while pos >= 0:
        count += 1
        pos = d.text.find(q.text, pos + 1)
    start = d.starts[first]
    end = d.ends[first + len(q) - 1]
    # ブロック境界をまたぐ一致は認めない（別々の段落・表のセルをつないだ引用は原文に無い文）。
    if BLOCK_SEP in doc[start:end]:
        return QuoteMatch(False, "NOT_FOUND")
    ss, se = _sentence_bounds(doc, start, end)
    sentence = doc[ss:se].strip()
    outside_text = doc[ss:start] + "　" + doc[end:se]
    inside = qualifiers(doc[start:end])
    outside = [w for w in qualifiers(outside_text) if w not in inside]
    cond = qualifiers(doc[start:end], negation=False)
    return QuoteMatch(True, "VERIFIED", count, start, end, sentence, outside, inside, cond)


def find_terms(terms: list[str], doc: str) -> list[str]:
    """正規化した原文に現れる語の一覧（「要項に書いていない」の裏取りに使う）。"""
    d = normalize(doc).text
    return [t for t in terms if normalize(t).text and normalize(t).text in d]


def term_sentences(terms: list[str], doc: str, limit: int = 3) -> list[str]:
    """語を含む原文の文（重複なし・最大 limit 件）。表示用に原文から切り出す。"""
    d = normalize(doc)
    out: list[str] = []
    for t in terms:
        nt = normalize(t).text
        if not nt:
            continue
        pos = d.text.find(nt)
        while pos >= 0 and len(out) < limit:
            s, e = _sentence_bounds(doc, d.starts[pos], d.ends[pos + len(nt) - 1])
            sent = doc[s:e].strip()
            if sent not in out:
                out.append(sent)
            pos = d.text.find(nt, pos + 1)
    return out[:limit]
