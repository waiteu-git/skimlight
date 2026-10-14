"""東京都「子育て支援制度レジストリ」（JSON・CC BY 4.0）から、制度を探して要件カードを作る。

構成: 制度のメタ（レジストリ）で発見 → 自治体の制度ページ（原文）を取得 → 逐語照合と関連語の裏取り。
レジストリは制度の「説明」で、原文ではない。レジストリの文が自治体のページに逐語で在るかも確かめる
（在れば引用あり、言い換えなら要確認＝原文を読む所が分かる）。

項目名は公式の README（2024-08-20 作成・JSON データ定義）に合わせた。ファイル全体の形（配列か、
オブジェクトの中の配列か）は README に無いので両方を受ける。
"""
from __future__ import annotations

import json
from pathlib import Path

ATTRIBUTION = (
    "この結果は、以下の著作物を改変して利用しています。"
    "東京デジタル2030ビジョン（こどもDX）子育て支援制度レジストリ、東京都・GovTech東京、"
    "クリエイティブ・コモンズ・ライセンス表示4.0国際。"
    "なお、各制度等については、必ず各自治体の公式サイトをご確認のうえ申請・問い合わせをお願いします。"
)
DATASET_URL = "https://catalog.data.metro.tokyo.lg.jp/dataset/t134211d0000000001"
_AGE_OPS = (
    ("lessThan", "未満"),
    ("lessThanOrEqualTo", "以下"),
    ("greaterThanOrEqualTo", "以上"),
    ("greaterThan", "超"),
)


def load_records(path: Path) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v
    raise ValueError("レジストリの形が想定と違います（制度の配列が見つかりません）")


def _g(rec: dict, *keys):
    cur = rec
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def psid(rec: dict) -> str:
    return str(_g(rec, "basicInformation", "psid") or "")


def name(rec: dict) -> str:
    return _g(rec, "institutionName", "canonicalName") or _g(rec, "institutionName", "shortName") or "(名称なし)"


def age_bounds(rec: dict) -> list[tuple[str, str, int, int | None]]:
    """[(op, 語, 年, 月)]。年が null で月だけの条件もある（README の留意点）。"""
    out = []
    for key, word in _AGE_OPS:
        y = _g(rec, "target", key, "targetAge")
        m = _g(rec, "target", key, "targetAgeOfMonths")
        if y is not None or m is not None:
            out.append((key, word, y, m))
    return out


def _age_phrase(word: str, y, m) -> str:
    parts = []
    if y is not None:
        parts.append(f"{y}歳")
    if m is not None:
        parts.append(f"{m}か月")
    return "".join(parts) + word


def render(rec: dict) -> str:
    """レジストリの1制度を、人が読める行に直す（S1 の控えの本文。決まった規則で作る）。"""
    lines = [f"制度名: {name(rec)}"]
    if _g(rec, "institutionName", "shortName"):
        lines.append(f"通称: {_g(rec, 'institutionName', 'shortName')}")
    for label, val in (
        ("概要", rec.get("summary")),
        ("対象者", _g(rec, "target", "targetPersons")),
        ("年齢の条件", _g(rec, "target", "conditions")),
        ("支給内容", _g(rec, "support", "description")),
        ("金銭的支援", _g(rec, "support", "monetarySupport")),
        ("手続き方法", rec.get("procedureMethod")),
        ("手続き期間の開始", _g(rec, "procedurePeriod", "fromYMD")),
        ("手続き期間の終了", _g(rec, "procedurePeriod", "toYMD")),
        ("対象地域", _g(rec, "area", "areaCode")),
        ("自治体の制度ページ", _g(rec, "localGovernmentLink", "uri")),
        ("psid", psid(rec)),
    ):
        if val not in (None, ""):
            lines.append(f"{label}: {val}")
    for _, word, y, m in age_bounds(rec):
        lines.append(f"対象年齢: {_age_phrase(word, y, m)}")
    return "\n".join(lines)


def find(records: list[dict], *, area: str | None = None, age: int | None = None, keyword: str | None = None) -> list[dict]:
    """area（6桁の団体コード）・age（歳）・keyword で絞る。年齢は年の条件だけで絞り、月の条件は落とさない（要確認側）。"""
    out = []
    for r in records:
        if area and area not in str(_g(r, "area", "areaCode") or ""):
            continue
        if keyword and keyword not in (name(r) + str(r.get("summary") or "") + str(_g(r, "target", "targetPersons") or "")):
            continue
        if age is not None:
            ok = True
            for key, _, y, _m in age_bounds(r):
                if y is None:
                    continue
                if (key == "lessThan" and not age < y) or (key == "lessThanOrEqualTo" and not age <= y) or (
                    key == "greaterThanOrEqualTo" and not age >= y) or (key == "greaterThan" and not age > y):
                    ok = False
            if not ok:
                continue
        out.append(r)
    return out


def to_card(rec: dict, subject_id: str, today_iso: str) -> dict:
    uri = _g(rec, "localGovernmentLink", "uri")
    sources = [{"id": "S1", "url": DATASET_URL + "#psid=" + psid(rec), "method": "file", "label": "子育て支援制度レジストリ（東京都版）の1制度"}]
    if uri:
        sources.append({"id": "S2", "url": uri, "method": "chrome", "label": "自治体の制度ページ（原文）"})
    reqs: list[dict] = []
    n = 0

    def add(**kw):
        nonlocal n
        n += 1
        reqs.append({"id": f"R{n:02d}", **kw})

    persons = _g(rec, "target", "targetPersons")
    if persons:
        add(kind="資格", topic="対象者（レジストリの記述）", source="S1", quote=f"対象者: {persons}")
        if uri:
            add(kind="資格", topic="対象者の記述が原文に在るか", source="S2", quote=persons,
                note="レジストリの文が自治体のページに逐語で無ければ要確認（言い換え・更新の疑い）")
    for key, word, y, m in age_bounds(rec):
        q = f"対象年齢: {_age_phrase(word, y, m)}"
        if y is not None and m is None and key in ("lessThanOrEqualTo", "greaterThanOrEqualTo"):
            op = "age_at_most" if key == "lessThanOrEqualTo" else "age_at_least"
            add(kind="資格", topic=f"年齢（{word}）", source="S1", quote=q,
                check={"field": "child.birth_date", "op": op, "value": y, "as_of": today_iso, "label": "対象の子の年齢（照合日）"})
        else:
            add(kind="資格", topic=f"年齢（{word}）", source="S1", quote=q, note="月・未満・超の条件は数値で並べない（原文で確かめる）")
    to_ymd = _g(rec, "procedurePeriod", "toYMD")
    if to_ymd:
        add(kind="締切", topic="手続き期間の終了", source="S1", quote=f"手続き期間の終了: {to_ymd}", deadline=to_ymd)
    if uri:
        add(kind="資格", topic="所得の条件（原文）", source="S2", quote=None, absent_terms=["所得制限", "所得の制限", "所得額", "所得が"],
            note="レジストリに項目が無い。原文に所得の条件があれば要確認で知らせる")
        add(kind="提出物", topic="必要書類（原文）", source="S2", quote=None, absent_terms=["必要書類", "必要なもの", "持ち物", "添付"],
            note="原文に必要書類の記載があれば要確認で知らせる")
    return {
        "id": subject_id,
        "title": f"{name(rec)}（子育て支援制度レジストリから）",
        "category": "public_service",
        "attribution": ATTRIBUTION,
        "sources": sources,
        "requirements": reqs,
    }
