import unittest
from datetime import date

from ruleaudit.adjudicate import NO_QUOTE, QUOTED, REVIEW, adjudicate, compare
from ruleaudit.cards import Requirement

DOC = "募集受付 2026年8月25日～2026年10月18日まで\n応募締切日時点で年齢25才以下であること\n応募時点で学部1～3年生の方\n"
TODAY = date(2026, 10, 12)


def req(**kw):
    base = dict(id="R1", kind="資格", topic="t", source="S1", quote=None)
    base.update(kw)
    return Requirement(**base)


AGE = {"field": "birth_date", "op": "age_at_most", "value": 25, "as_of": "2026-10-18"}


class AdjudicateTest(unittest.TestCase):
    def test_three_values_only(self):
        for f in (
            adjudicate(req(quote="応募締切日時点で年齢25才以下であること", check=AGE), DOC, {"birth_date": "2006-04-01"}, TODAY),
            adjudicate(req(absent_terms=["高校"]), DOC, {}, TODAY),
            adjudicate(req(quote="存在しない文をここに書いておく"), DOC, {}, TODAY),
        ):
            self.assertIn(f.status, {QUOTED, NO_QUOTE, REVIEW})

    def test_quoted_in_range(self):
        f = adjudicate(req(quote="応募締切日時点で年齢25才以下であること", check=AGE), DOC, {"birth_date": "2006-04-01"}, TODAY)
        self.assertEqual((f.status, f.reasons), (QUOTED, []))

    def test_out_of_range_goes_to_review(self):
        f = adjudicate(req(quote="応募締切日時点で年齢25才以下であること", check=AGE), DOC, {"birth_date": "2000-01-01"}, TODAY)
        self.assertEqual(f.status, REVIEW)
        self.assertIn("OUT_OF_RANGE", f.reasons)

    def test_birthday_on_deadline_counts(self):
        # 締切日に 26 歳になる＝締切日時点で 26 歳
        self.assertEqual(compare(AGE, {"birth_date": "2000-10-18"})[0], "out")
        self.assertEqual(compare(AGE, {"birth_date": "2000-10-19"})[0], "in")

    def test_missing_situation_goes_to_review(self):
        f = adjudicate(req(quote="応募締切日時点で年齢25才以下であること", check=AGE), DOC, {}, TODAY)
        self.assertIn("SITUATION_MISSING", f.reasons)

    def test_fabricated_quote_goes_to_review(self):
        f = adjudicate(req(quote="1年生は高校の成績証明書で構いません"), DOC, {}, TODAY)
        self.assertEqual((f.status, f.reasons), (REVIEW, ["QUOTE_NOT_FOUND"]))

    def test_absent_terms(self):
        self.assertEqual(adjudicate(req(absent_terms=["高校", "代替"]), DOC, {}, TODAY).status, NO_QUOTE)
        f = adjudicate(req(absent_terms=["学部"]), DOC, {}, TODAY)
        self.assertEqual((f.status, f.reasons), (REVIEW, ["TERM_PRESENT"]))

    def test_deadline(self):
        r = req(kind="締切", quote="2026年8月25日～2026年10月18日まで", deadline="2026-10-18")
        self.assertEqual(adjudicate(r, DOC, {}, TODAY).status, QUOTED)
        self.assertIn("DEADLINE_PASSED", adjudicate(r, DOC, {}, date(2026, 10, 19)).reasons)

    def test_no_snapshot(self):
        self.assertEqual(adjudicate(req(quote="応募時点で学部1～3年生の方"), None, {}, TODAY).reasons, ["NO_SNAPSHOT"])

    def test_in_operator(self):
        c = {"field": "school.grade", "op": "in", "value": [1, 2, 3]}
        self.assertEqual(compare(c, {"school": {"grade": 4}})[0], "out")
        self.assertEqual(compare(c, {"school": {"grade": "1"}})[0], "out")  # 型が違えば一致しない（安全側）


if __name__ == "__main__":
    unittest.main()
