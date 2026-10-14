"""結果の文面（Markdown）。表示する原文の文字列は、原文の控えから切り出したものだけ。"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from ruleaudit.adjudicate import NO_QUOTE, QUOTED, REASONS, REVIEW

JST = timezone(timedelta(hours=9), "JST")
_ORDER = {REVIEW: 0, QUOTED: 1, NO_QUOTE: 2}
FOOTER = (
    "この結果は、要項の原文とあなたの状況を並べた記録です。応募できるか・受けられるかの判断ではありません。"
    "決めるのはあなたです。迷う所は主催者・窓口に確かめてください。"
)


def fmt_time(ts: str) -> str:
    """控えの時刻（UTC・20261012T081500Z）を日本時間で読める形にする。"""
    try:
        dt = datetime.strptime(ts, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return ts
    return dt.astimezone(JST).strftime("%Y-%m-%d %H:%M JST")


def markdown(results, today: date, has_situation: bool) -> str:
    out: list[str] = []
    for s, docs, findings in results:
        out.append(f"# {s.title}")
        out.append("")
        out.append(f"照合日 {today.isoformat()}")
        if not has_situation:
            out.append("状況のファイルがありません（数値の並べは出ません）。`.private/situation.json` を作ってください。")
        out.append("")
        out.append("## 出典")
        for src in s.sources:
            _, m = docs[src.id]
            got = f"取得 {fmt_time(m.fetched_at)}・控え {m.sha256[:12]}" if m else "控えなし"
            label = f"{src.label}　" if src.label else ""
            out.append(f"- {src.id} {label}{src.url}（{got}）")
        counts = {k: sum(1 for f in findings if f.status == k) for k in (REVIEW, QUOTED, NO_QUOTE)}
        out.append("")
        out.append(f"## 要件（要確認 {counts[REVIEW]}・引用あり {counts[QUOTED]}・引用なし {counts[NO_QUOTE]}）")
        for f in sorted(findings, key=lambda f: (_ORDER[f.status], f.req_id)):
            out.append("")
            out.append(f"### [{f.status}] {f.req_id} {f.topic}（{f.kind}）")
            if f.quote is not None:
                out.append(f"- 引用: 「{f.quote}」（{f.source_id}）")
            if f.sentence and f.sentence != f.quote:
                out.append(f"- 原文の文: 「{f.sentence}」")
            for r in f.reasons:
                out.append(f"- 理由 {r}: {REASONS[r]}")
            for n in f.notes:
                out.append(f"- {n}")
        if s.attribution:
            out.append("")
            out.append(s.attribution)
        out.append("")
    out.append("---")
    out.append(FOOTER)
    return "\n".join(out)


def diff_markdown(s, src, before, after, d) -> str:
    out = [f"## 変更あり: {s.title} / {src.id}", f"{fmt_time(before.fetched_at)} → {fmt_time(after.fetched_at)}　{src.url}"]
    if d.affected:
        out.append("")
        out.append("### あなたのカードの要件で影響を受けたもの")
        for rid, kind, desc in d.affected:
            out.append(f"- {rid} {kind}: {desc}")
    else:
        out.append("カードの要件に影響する変化は見つかりませんでした（変わった行は下）。")
    out.append("")
    out.append("### 変わった行")
    for line in d.removed[:40]:
        out.append(f"- 削: {line}")
    for line in d.added[:40]:
        out.append(f"- 足: {line}")
    if len(d.removed) > 40 or len(d.added) > 40:
        out.append(f"（ほか 削 {max(0, len(d.removed) - 40)} 行・足 {max(0, len(d.added) - 40)} 行）")
    return "\n".join(out)
