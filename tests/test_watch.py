import unittest

from ruleaudit.cards import Requirement
from ruleaudit.watch import diff_texts

OLD = "応募資格\n応募締切日時点で年齢25才以下であること\n締切 10月18日\n"
REQS = [
    Requirement("R1", "資格", "年齢", "S1", "応募締切日時点で年齢25才以下であること"),
    Requirement("R2", "その他", "1年生", "S1", None, absent_terms=["1年生"]),
]


class WatchTest(unittest.TestCase):
    def test_no_change(self):
        self.assertFalse(diff_texts(OLD, OLD, REQS).changed)

    def test_condition_rewritten(self):
        new = OLD.replace("25才以下", "23才以下")
        d = diff_texts(OLD, new, REQS)
        self.assertIn(("R1", "QUOTE_LOST"), [(a, b) for a, b, _ in d.affected])

    def test_qualifier_added_to_sentence(self):
        new = OLD.replace("であること\n", "であること（ただし大学院生を除く）\n")
        d = diff_texts(OLD, new, REQS)
        self.assertIn(("R1", "SENTENCE_CHANGED"), [(a, b) for a, b, _ in d.affected])

    def test_term_appeared(self):
        new = OLD + "1年生は高校の成績証明書で構いません。\n"
        d = diff_texts(OLD, new, REQS)
        self.assertIn(("R2", "TERM_APPEARED"), [(a, b) for a, b, _ in d.affected])

    def test_unrelated_change_affects_nothing(self):
        d = diff_texts(OLD, OLD + "お知らせを更新しました\n", REQS)
        self.assertTrue(d.changed)
        self.assertEqual(d.affected, [])


if __name__ == "__main__":
    unittest.main()
