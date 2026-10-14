"""設計の境界をテストで固定する。"""
import ast
import json
import unittest
from pathlib import Path

PKG = Path(__file__).resolve().parents[1] / "ruleaudit"
ROOT = PKG.parent


def imports(mod: str) -> set[str]:
    tree = ast.parse((PKG / f"{mod}.py").read_text(encoding="utf-8"))
    out = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.module:
            out.add(n.module)
            out.update(f"{n.module}.{a.name}" for a in n.names)
        elif isinstance(n, ast.Import):
            out.update(a.name for a in n.names)
    return out


class BoundaryTest(unittest.TestCase):
    def test_snapshot_never_sees_situation(self):
        self.assertFalse({m for m in imports("snapshot") if "situation" in m})

    def test_situation_has_no_network(self):
        net = {"urllib", "urllib.request", "socket", "http", "http.client", "subprocess", "ruleaudit.snapshot"}
        self.assertFalse(imports("situation") & net)
        self.assertFalse(imports("adjudicate") & net)

    def test_fetch_is_get_only(self):
        src = (PKG / "snapshot.py").read_text(encoding="utf-8")
        self.assertIn('method="GET"', src)
        for verb in ('"POST"', '"PUT"', '"DELETE"', '"PATCH"'):
            self.assertNotIn(verb, src)

    def test_status_words_are_three(self):
        from ruleaudit import adjudicate

        self.assertEqual({adjudicate.QUOTED, adjudicate.NO_QUOTE, adjudicate.REVIEW}, {"引用あり", "引用なし", "要確認"})
        src = (PKG / "adjudicate.py").read_text(encoding="utf-8") + (PKG / "report.py").read_text(encoding="utf-8")
        for word in ("適合", "合格", "対象です", "応募できます"):
            self.assertNotIn(f'"{word}', src)

    def test_situation_files_are_ignored(self):
        gi = (ROOT / ".gitignore").read_text(encoding="utf-8")
        for pat in (".private/", "situation.json", ".cache/"):
            self.assertIn(pat, gi)

    def test_example_situation_is_marked_fictional(self):
        d = json.loads((ROOT / "examples" / "situation.example.json").read_text(encoding="utf-8"))
        self.assertIn("架空", d["_note"])

    def test_subject_cards_load(self):
        from ruleaudit import cards

        if not list((ROOT / "subjects").glob("*.json")):
            self.skipTest("題材カードが無い（公開用のツリーには入れていない）")
        subs = cards.load_all(ROOT / "subjects")
        self.assertTrue(subs)


if __name__ == "__main__":
    unittest.main()


class SituationTypeTest(unittest.TestCase):
    def test_validate(self):
        from ruleaudit import situation as sit

        self.assertEqual(sit.validate({"school": {"grade": 1}, "birth_date": "2006-04-01", "career": {"it_engineer_fulltime": None}}), [])
        probs = sit.validate({"school": {"grade": "1", "grad": 1}, "birth_date": "2006/04/01"})
        self.assertEqual(len(probs), 3)
        # 検査の文面に値を出さない
        self.assertFalse(any("2006" in p for p in probs))

    def test_template_covers_all_fields(self):
        from ruleaudit import situation as sit

        t = sit.template()
        self.assertEqual(sit.validate(t), [])
        for f in sit.FIELDS:
            self.assertIsNone(sit.get(t, f))

    def test_example_is_valid(self):
        from ruleaudit import situation as sit

        self.assertEqual(sit.validate(sit.load(ROOT / "examples" / "situation.example.json")), [])

    def test_card_with_unknown_field_is_rejected(self):
        import tempfile

        from ruleaudit import cards

        bad = {"id": "x", "title": "x", "category": "contest", "sources": [{"id": "S1", "url": "https://e.invalid/", "method": "get"}],
               "requirements": [{"id": "R1", "kind": "資格", "topic": "t", "source": "S1", "quote": "十分に長い引用の文です",
                                 "check": {"field": "school.grad", "op": "==", "value": 1}}]}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.json"
            p.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
            with self.assertRaises(cards.CardError):
                cards.load(p)
