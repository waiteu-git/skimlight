"""ローカル CLI。題材を省くと全部（all）。

  python3 -m ruleaudit list                                 題材と控えの一覧
  python3 -m ruleaudit fetch [subject]                      原文を取得して控えを残す（GET のみ）
  python3 -m ruleaudit import <subject> <source> <file>     本人が保存したファイルを控えとして取り込む
  python3 -m ruleaudit audit [subject] [--only 要確認]      要件×状況→3値（ネットワークは使わない）
  python3 -m ruleaudit summary                              題材ごとの件数と、近い締切を1行ずつ
  python3 -m ruleaudit deadlines                            締切の要件を日付順に
  python3 -m ruleaudit watch [subject] [--quiet]            取り直して差分と影響（変化 3・取得失敗だけ 4・なし 0）
  python3 -m ruleaudit situation init|check                 状況の雛形を作る／型と不足を検査する（値は表示しない）
  python3 -m ruleaudit registry find <file> [--area 131016] [--age 3] [--keyword 手当]
  python3 -m ruleaudit registry card <file> <psid> <subject_id>   1制度の要件カードと S1 の控えを作る
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import date, datetime, timezone
from pathlib import Path

from ruleaudit import cards, report
from ruleaudit import situation as sit
from ruleaudit.adjudicate import NO_QUOTE, QUOTED, REVIEW, adjudicate

ROOT = Path(__file__).resolve().parents[1]
STATUSES = (REVIEW, QUOTED, NO_QUOTE)


def _subjects(args) -> dict[str, cards.Subject]:
    allsub = cards.load_all(Path(args.subjects))
    name = getattr(args, "subject", None) or "all"
    if name == "all":
        return allsub
    if name not in allsub:
        sys.exit(f"題材がありません: {name}（list で一覧）")
    return {name: allsub[name]}


def _snap_root(args) -> Path:
    return Path(args.cache) / "snapshots"


def _situation_path(args) -> Path:
    return Path(args.situation) if getattr(args, "situation", None) else ROOT / sit.DEFAULT_PATH


def _today(args) -> date:
    return date.fromisoformat(args.today) if getattr(args, "today", None) else date.today()


def _load_situation(args) -> dict:
    situation = sit.load(_situation_path(args))
    for problem in sit.validate(situation):
        print(f"状況のファイル: {problem}", file=sys.stderr)
    return situation


def cmd_list(args) -> int:
    from ruleaudit import snapshot

    for s in cards.load_all(Path(args.subjects)).values():
        print(f"{s.id}\t{s.category}\t{s.title}\t要件 {len(s.requirements)} 件")
        for src in s.sources:
            m = snapshot.latest_meta(_snap_root(args), s.id, src.id)
            got = f"控え {report.fmt_time(m.fetched_at)} {m.sha256[:12]}" if m else "控えなし"
            print(f"  {src.id}\t{src.method}\t{got}\t{src.url}")
    return 0


def cmd_fetch(args) -> int:
    from ruleaudit import snapshot

    rc = 0
    for s in _subjects(args).values():
        for src in s.sources:
            if src.method == "file":
                print(f"{s.id}/{src.id}: 取り込み型です（import を使ってください）")
                continue
            try:
                m = snapshot.capture(_snap_root(args), s.id, src.id, src.url, src.method, scope=(src.scope_start, src.scope_end))
                print(f"{s.id}/{src.id}: {report.fmt_time(m.fetched_at)} {m.sha256[:12]} {m.chars} 字")
            except Exception as e:  # noqa: BLE001 — 1件の失敗で全体を止めない
                print(f"{s.id}/{src.id}: 取得できませんでした: {e}", file=sys.stderr)
                rc = 1
    return rc


def cmd_import(args) -> int:
    from ruleaudit import snapshot

    s = _subjects(args)[args.subject]
    src = s.source(args.source)
    m = snapshot.capture(_snap_root(args), s.id, src.id, src.url, "file", file=args.file, scope=(src.scope_start, src.scope_end))
    print(f"{s.id}/{src.id}: {report.fmt_time(m.fetched_at)} {m.sha256[:12]} {m.chars} 字")
    return 0


def _read_latest(args, subject_id: str, source_id: str):
    # 監査はネットワークを使わない: 控えを読むだけ（snapshot の取得関数は呼ばない）
    from ruleaudit.snapshot import latest_meta

    m = latest_meta(_snap_root(args), subject_id, source_id)
    if m is None:
        return None, None
    return Path(m.text_path).read_text(encoding="utf-8"), m


def _run(args):
    situation = _load_situation(args)
    today = _today(args)
    results = []
    for s in _subjects(args).values():
        docs = {src.id: _read_latest(args, s.id, src.id) for src in s.sources}
        findings = [adjudicate(r, docs[r.source][0], situation, today) for r in s.requirements]
        results.append((s, docs, findings))
    return situation, today, results


def cmd_audit(args) -> int:
    situation, today, results = _run(args)
    if args.only:
        results = [(s, d, [f for f in fs if f.status == args.only]) for s, d, fs in results]
    if args.format == "json":
        out = []
        for s, docs, findings in results:
            out.append({
                "subject": s.id,
                "sources": {k: (asdict(m) if m else None) for k, (_, m) in docs.items()},
                "findings": [{k: v for k, v in asdict(f).items() if k != "match"} for f in findings],
            })
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        print(report.markdown(results, today, has_situation=bool(situation)))
    return 0


def _deadline_rows(results, today: date):
    rows = []
    for s, _docs, findings in results:
        by_id = {r.id: r for r in s.requirements}
        for f in findings:
            r = by_id[f.req_id]
            if r.deadline:
                rows.append(((date.fromisoformat(r.deadline) - today).days, r.deadline, s, f))
    return sorted(rows, key=lambda x: x[1])


def cmd_summary(args) -> int:
    _situation, today, results = _run(args)
    rows = _deadline_rows(results, today)
    for s, _docs, findings in results:
        counts = "・".join(f"{k} {sum(1 for f in findings if f.status == k)}" for k in STATUSES)
        upcoming = [r for r in rows if r[2].id == s.id and r[0] >= 0]
        dl = f"次の締切 {upcoming[0][1]}（あと {upcoming[0][0]} 日）" if upcoming else "締切の要件なし／過ぎた"
        print(f"{s.id}\t{counts}\t{dl}\t{s.title}")
    return 0


def cmd_deadlines(args) -> int:
    _situation, today, results = _run(args)
    for days, d, s, f in _deadline_rows(results, today):
        when = f"あと {days} 日" if days >= 0 else f"{-days} 日前に過ぎた"
        print(f"{d}\t{when}\t[{f.status}]\t{s.id}/{f.req_id} {f.topic}")
    return 0


def _log_watch(args, entry: dict) -> None:
    p = Path(args.cache) / "watch-log.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    entry = {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **entry}
    with p.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def cmd_watch(args) -> int:
    from ruleaudit import snapshot
    from ruleaudit.watch import diff_texts

    changed_any = failed_any = False
    fetched = 0
    for s in _subjects(args).values():
        for src in s.sources:
            if src.method == "file":
                continue
            key = {"subject": s.id, "source": src.id}
            if fetched >= args.max_sources:
                failed_any = True
                print(f"{s.id}/{src.id}: 取得の上限（{args.max_sources} 件）に達したので取りませんでした", file=sys.stderr)
                _log_watch(args, {**key, "result": "error", "error": "max_sources"})
                continue
            fetched += 1
            before = snapshot.latest_meta(_snap_root(args), s.id, src.id)
            try:
                after = snapshot.capture(_snap_root(args), s.id, src.id, src.url, src.method, scope=(src.scope_start, src.scope_end))
            except Exception as e:  # noqa: BLE001
                failed_any = True
                print(f"{s.id}/{src.id}: 取得できませんでした: {e}", file=sys.stderr)
                _log_watch(args, {**key, "result": "error", "error": str(e)[:200]})
                continue
            if before is None:
                print(f"{s.id}/{src.id}: 初回の控えを作りました（比べる前の控えはありません）")
                _log_watch(args, {**key, "result": "first", "after": after.sha256[:12]})
                continue
            if before.sha256 == after.sha256:
                if not args.quiet:
                    print(f"{s.id}/{src.id}: 変化なし（{report.fmt_time(before.fetched_at)} から）")
                _log_watch(args, {**key, "result": "unchanged", "after": after.sha256[:12]})
                continue
            changed_any = True
            old = Path(before.text_path).read_text(encoding="utf-8")
            new = Path(after.text_path).read_text(encoding="utf-8")
            reqs = [r for r in s.requirements if r.source == src.id]
            d = diff_texts(old, new, reqs)
            print(report.diff_markdown(s, src, before, after, d))
            _log_watch(args, {**key, "result": "changed", "before": before.sha256[:12], "after": after.sha256[:12],
                              "affected": [[rid, kind] for rid, kind, _ in d.affected]})
    if changed_any:
        return 3
    return 4 if failed_any else 0


def cmd_situation(args) -> int:
    path = _situation_path(args)
    if args.action == "init":
        if path.exists():
            sys.exit(f"既にあります（上書きしません）: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(sit.template(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"雛形を作りました: {path}（git の外。値を入れてください）")
        return 0
    situation = sit.load(path)
    if not situation:
        print(f"状況のファイルがありません: {path}（situation init で雛形を作れます）")
    problems = sit.validate(situation)
    for p in problems:
        print(f"問題: {p}")
    # カードが使う項目ごとに、入力済みか・どの要件が使うか（値は表示しない）
    used: dict[str, list[str]] = {}
    for s in cards.load_all(Path(args.subjects)).values():
        for r in s.requirements:
            if r.check:
                used.setdefault(r.check["field"], []).append(f"{s.id}/{r.id}")
    for field, (kind, desc) in sit.FIELDS.items():
        state = "入力済み" if sit.get(situation, field) is not None else "未入力"
        users = used.get(field, [])
        mark = "★" if users and state == "未入力" else " "
        print(f"{mark} {field}\t{kind}\t{state}\t{desc}" + (f"\t使う要件 {len(users)} 件" if users else ""))
    missing = [f for f in used if sit.get(situation, f) is None]
    print(f"カードが使う項目 {len(used)} のうち未入力 {len(missing)}（★）")
    return 1 if problems else 0


def cmd_registry(args) -> int:
    from ruleaudit import registry, snapshot

    recs = registry.load_records(Path(args.file))
    if args.action == "find":
        hits = registry.find(recs, area=args.area, age=args.age, keyword=args.keyword)
        for r in hits[: args.limit]:
            print(f"{registry.psid(r)}\t{registry.name(r)}\t{(r.get('area') or {}).get('areaCode', '')}")
        print(f"（{len(hits)} 件中 {min(len(hits), args.limit)} 件）")
        return 0
    if not (args.psid and args.subject_id):
        sys.exit("registry card には psid と subject_id が要ります")
    rec = next((r for r in recs if registry.psid(r) == args.psid), None)
    if rec is None:
        sys.exit(f"psid が見つかりません: {args.psid}")
    out = Path(args.subjects) / f"{args.subject_id}.json"
    if out.exists() and not args.force:
        sys.exit(f"カードが既にあります（--force で上書き）: {out}")
    card = registry.to_card(rec, args.subject_id, _today(args).isoformat())
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(card, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    m = snapshot.store(_snap_root(args), args.subject_id, "S1", card["sources"][0]["url"], "file", registry.render(rec))
    print(f"カード {out}・S1 の控え {m.sha256[:12]}。S2（自治体のページ）は fetch で取得してください")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ruleaudit", description="規則を原文つきで読む道具（ローカル）")
    p.add_argument("--subjects", default=str(ROOT / "subjects"))
    p.add_argument("--cache", default=str(ROOT / ".cache"))
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sp = sub.add_parser("fetch")
    sp.add_argument("subject", nargs="?", default="all")
    sp = sub.add_parser("watch")
    sp.add_argument("subject", nargs="?", default="all")
    sp.add_argument("--quiet", action="store_true", help="変化なしの行を出さない（定期実行向け）")
    sp.add_argument("--max-sources", type=int, default=10, help="1回で取得する出典の上限（既定 10）")
    sp = sub.add_parser("import")
    sp.add_argument("subject")
    sp.add_argument("source")
    sp.add_argument("file")
    for name in ("audit", "summary", "deadlines"):
        sp = sub.add_parser(name)
        sp.add_argument("subject", nargs="?", default="all")
        sp.add_argument("--situation")
        sp.add_argument("--today")
        if name == "audit":
            sp.add_argument("--format", choices=("md", "json"), default="md")
            sp.add_argument("--only", choices=STATUSES)
    sp = sub.add_parser("situation")
    sp.add_argument("action", choices=("init", "check"))
    sp.add_argument("--situation")
    sp = sub.add_parser("registry")
    sp.add_argument("action", choices=("find", "card"))
    sp.add_argument("file")
    sp.add_argument("psid", nargs="?")
    sp.add_argument("subject_id", nargs="?")
    sp.add_argument("--area")
    sp.add_argument("--age", type=int)
    sp.add_argument("--keyword")
    sp.add_argument("--limit", type=int, default=30)
    sp.add_argument("--today")
    sp.add_argument("--force", action="store_true")
    args = p.parse_args(argv)
    handlers = {
        "list": cmd_list, "fetch": cmd_fetch, "import": cmd_import, "audit": cmd_audit, "summary": cmd_summary,
        "deadlines": cmd_deadlines, "watch": cmd_watch, "situation": cmd_situation, "registry": cmd_registry,
    }
    return handlers[args.cmd](args)
