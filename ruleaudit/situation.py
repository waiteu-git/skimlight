"""本人の状況（端末の JSON）の型・読み込み・検査。

🔴 状況は端末の外へ出さない。このモジュールはネットワークを使わず、snapshot（取得）とは互いに import しない
（tests/test_boundaries.py が固定）。既定の置き場は git の外の .private/situation.json。

型は FIELDS が正典。要件カードの check はここに在る項目しか使えない（打ち間違いで「値が無い」になるのを防ぐ）。
検査の出力は項目名と「入力済み／未入力」だけで、値は表示しない。
"""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

DEFAULT_PATH = Path(".private/situation.json")

# 項目 → (型, 説明)。型は "date"（YYYY-MM-DD）／"bool"／"int"／"str"。
FIELDS: dict[str, tuple[str, str]] = {
    "birth_date": ("date", "生年月日（年齢の条件を、要項の基準日で数える）"),
    "school.enrolled": ("bool", "学校に在学中か"),
    "school.in_japan": ("bool", "日本国内の学校か"),
    "school.four_year": ("bool", "4年制大学か"),
    "school.level": ("str", "課程（学部／大学院／高専／専門学校 など）"),
    "school.grade": ("int", "学年（数字）"),
    "school.international_student": ("bool", "外国からの留学生か"),
    "career.it_engineer_fulltime": ("bool", "ITエンジニア職の正社員としての就業経験があるか"),
    "residence.prefecture": ("str", "住所の都道府県"),
    "residence.municipality_code": ("str", "住所の市区町村の6桁の団体コード"),
    "child.birth_date": ("date", "（子育ての制度を見る時）子の生年月日"),
    "contest.team_size": ("int", "（コンテスト）チームの人数"),
    "contest.work_published": ("bool", "（コンテスト）作品を既に公開しているか"),
}

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def load(path: Path | None) -> dict:
    p = Path(path) if path else DEFAULT_PATH
    if not p.exists():
        return {}
    data = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("状況のファイルは JSON のオブジェクトにしてください")
    return data


def get(situation: dict, dotted: str):
    """"school.grade" のような点区切りで値を引く。無ければ None。"""
    cur = situation
    for key in dotted.split("."):
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def _leaves(d: dict, prefix: str = "") -> list[str]:
    out = []
    for k, v in d.items():
        if k.startswith("_"):
            continue
        path = f"{prefix}{k}"
        if isinstance(v, dict):
            out.extend(_leaves(v, path + "."))
        else:
            out.append(path)
    return out


def validate(situation: dict) -> list[str]:
    """型の誤りと未知の項目（値は出さない）。null は未入力として許す。"""
    problems = []
    for path in _leaves(situation):
        if path not in FIELDS:
            problems.append(f"{path}: 型に無い項目です（打ち間違いなら直してください）")
            continue
        kind = FIELDS[path][0]
        v = get(situation, path)
        if v is None:
            continue
        ok = {
            "bool": isinstance(v, bool),
            "int": isinstance(v, int) and not isinstance(v, bool),
            "str": isinstance(v, str),
            "date": isinstance(v, str) and bool(_DATE.match(v)),
        }[kind]
        if ok and kind == "date":
            try:
                date.fromisoformat(v)
            except ValueError:
                ok = False
        if not ok:
            problems.append(f"{path}: 型が違います（{kind} にしてください）")
    return problems


def template() -> dict:
    """全項目を null で並べた雛形（本人が埋める）。"""
    out: dict = {"_note": "自分の状況。端末の外へ出さない（git の外）。分からない項目は null のままでよい"}
    for path in FIELDS:
        cur = out
        *heads, last = path.split(".")
        for h in heads:
            cur = cur.setdefault(h, {})
        cur[last] = None
    return out
