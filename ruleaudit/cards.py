"""要件カード（subjects/<id>.json）の読み込みと形の検査。

カードは「要項から取り出した要件」の一覧。誰が書いたか（人・AI）は問わない。引用が原文に在るかは
quotes が確かめ、カードの申告は信じない。

形:
{
  "id": "...", "title": "...", "category": "contest|scholarship|public_service",
  "sources": [{"id": "S1", "url": "https://...", "method": "get|chrome|file", "label": "...",
               "scope_start": "▼イベント概要", "scope_end": "関連するイベント"}],
  "requirements": [
    {"id": "R1", "kind": "資格|締切|提出物|禁止|手続き|給付|その他", "topic": "年齢",
     "source": "S1", "quote": "原文の一節（逐語）",
     "check": {"field": "birth_date", "op": "age_at_most", "value": 25, "as_of": "2026-10-18"},
     "deadline": "2026-10-18",
     "note": "..."},
    {"id": "R9", "kind": "その他", "topic": "二重応募", "source": "S1", "quote": null,
     "absent_terms": ["二重", "重複", "併願"], "note": "要項に記載が見つからない"}
  ]
}
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from ruleaudit.situation import FIELDS

KINDS = {"資格", "締切", "提出物", "禁止", "手続き", "給付", "その他"}
OPS = {"<=", "<", ">=", ">", "==", "!=", "in", "not_in", "contains", "age_at_most", "age_at_least", "is_true", "is_false"}


class CardError(Exception):
    pass


@dataclass
class Source:
    id: str
    url: str
    method: str
    label: str = ""
    scope_start: str = ""  # 控えに残す範囲の開始の目印（その行から）。広告・関連記事の枠を差分から外す
    scope_end: str = ""  # 終了の目印（その行の手前まで）


@dataclass
class Requirement:
    id: str
    kind: str
    topic: str
    source: str
    quote: str | None
    check: dict | None = None
    deadline: str | None = None
    absent_terms: list[str] = field(default_factory=list)
    note: str = ""


@dataclass
class Subject:
    id: str
    title: str
    category: str
    sources: list[Source]
    requirements: list[Requirement]
    attribution: str = ""

    def source(self, sid: str) -> Source:
        for s in self.sources:
            if s.id == sid:
                return s
        raise CardError(f"{self.id}: 出典 {sid} がありません")


def load(path: Path) -> Subject:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    try:
        sources = [Source(**s) for s in raw["sources"]]
        reqs = [Requirement(**r) for r in raw["requirements"]]
        subj = Subject(raw["id"], raw["title"], raw["category"], sources, reqs, raw.get("attribution", ""))
    except (KeyError, TypeError) as e:
        raise CardError(f"{path}: カードの形が違います: {e}") from e
    ids = set()
    sids = {s.id for s in sources}
    for s in sources:
        if s.method not in ("get", "chrome", "file"):
            raise CardError(f"{subj.id}/{s.id}: 取得方法が不正です: {s.method}")
    for r in reqs:
        if r.id in ids:
            raise CardError(f"{subj.id}: 要件 ID が重複しています: {r.id}")
        ids.add(r.id)
        if r.kind not in KINDS:
            raise CardError(f"{subj.id}/{r.id}: 種別が不正です: {r.kind}")
        if r.source not in sids:
            raise CardError(f"{subj.id}/{r.id}: 出典 {r.source} がありません")
        if r.quote is None and not r.absent_terms:
            raise CardError(f"{subj.id}/{r.id}: 引用なしの要件には、裏取りの語（absent_terms）が要ります")
        if r.check is not None:
            if r.check.get("op") not in OPS or "field" not in r.check:
                raise CardError(f"{subj.id}/{r.id}: check の形が違います: {r.check}")
            if r.check["field"] not in FIELDS:
                raise CardError(f"{subj.id}/{r.id}: 状況の型に無い項目です: {r.check['field']}（situation.FIELDS に足す）")
            if r.quote is None:
                raise CardError(f"{subj.id}/{r.id}: 引用の無い要件に check は付けられません")
    return subj


def load_all(directory: Path) -> dict[str, Subject]:
    out = {}
    for p in sorted(Path(directory).glob("*.json")):
        s = load(p)
        out[s.id] = s
    return out
