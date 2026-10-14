import json
import tempfile
import unittest
from pathlib import Path

from ruleaudit import registry, snapshot

FIX = Path(__file__).parent / "fixtures" / "registry.fictional.json"


class HtmlTest(unittest.TestCase):
    def test_hidden_and_scripts_dropped(self):
        html = '<html><head><title>x</title></head><body><p>見える文</p><script>var a="隠す"</script>' \
               '<div style="display: none">隠す</div><span aria-hidden="true">隠す</span><p>次の段落</p></body></html>'
        t = snapshot.html_to_text(html)
        self.assertEqual(t, "見える文\n次の段落")

    def test_url_check_rejects_non_public(self):
        for url in ("http://example.com/", "https://127.0.0.1/", "https://localhost/", "https://user:pw@example.com/",
                    "https://example.com:8443/", "https://host.local/"):
            with self.assertRaises(snapshot.FetchError):
                snapshot._check_url(url)

    def test_store_dedupes_same_text(self):
        with tempfile.TemporaryDirectory() as d:
            a = snapshot.store(Path(d), "s", "S1", "https://e.invalid/", "file", "本文")
            b = snapshot.store(Path(d), "s", "S1", "https://e.invalid/", "file", "本文")
            self.assertEqual(a.text_path, b.text_path)
            self.assertEqual(len(snapshot.history(Path(d), "s", "S1")), 1)


class RegistryTest(unittest.TestCase):
    def test_find_and_card(self):
        recs = registry.load_records(FIX)
        self.assertEqual([registry.psid(r) for r in registry.find(recs, age=5)], ["FICT-0001"])
        self.assertEqual([registry.psid(r) for r in registry.find(recs, area="999998")], ["FICT-0002"])
        card = registry.to_card(recs[0], "fict", "2026-10-12")
        self.assertIn("クリエイティブ・コモンズ・ライセンス表示4.0国際", card["attribution"])
        # カードの S1 の引用は、決まった規則で作った控えの本文に必ず在る
        from ruleaudit.quotes import match_quote

        text = registry.render(recs[0])
        for r in card["requirements"]:
            if r["source"] == "S1":
                self.assertTrue(match_quote(r["quote"], text).ok, r)

    def test_wrapped_shape(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "w.json"
            p.write_text(json.dumps({"data": json.loads(FIX.read_text(encoding="utf-8"))}, ensure_ascii=False), encoding="utf-8")
            self.assertEqual(len(registry.load_records(p)), 2)


if __name__ == "__main__":
    unittest.main()


class TrimTest(unittest.TestCase):
    def test_trim_and_missing_marker(self):
        t = "見出し\n▼概要\n本文\n関連するイベント\n広告"
        self.assertEqual(snapshot.trim(t, "▼概要", "関連するイベント"), ("▼概要\n本文", []))
        kept, warns = snapshot.trim(t, "無い目印", "")
        self.assertEqual(kept, t)
        self.assertTrue(warns)


class MovedRootTest(unittest.TestCase):
    def test_text_path_follows_moved_directory(self):
        import shutil

        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "a", Path(d) / "b"
            snapshot.store(a, "s", "S1", "https://e.invalid/", "file", "本文")
            shutil.move(str(a), str(b))
            m = snapshot.latest_meta(b, "s", "S1")
            self.assertTrue(m.text_path.startswith(str(b)))
            self.assertEqual(Path(m.text_path).read_text(encoding="utf-8"), "本文")
