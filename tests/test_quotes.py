import unittest

from ruleaudit.quotes import find_terms, match_quote, term_sentences

DOC = "応募資格\n1. 応募時点で学部1～3年生の方\n３． 応募締切日時点で年齢２５才以下であること\n他の奨学金と併願・併給も可能です。ただし、学内選考の奨学金を除きます。\n"


class QuoteTest(unittest.TestCase):
    def test_verbatim_with_width_differences(self):
        m = match_quote("応募締切日時点で年齢25才以下であること", DOC)
        self.assertTrue(m.ok)
        self.assertEqual(DOC[m.start:m.end], "応募締切日時点で年齢２５才以下であること")

    def test_paraphrase_is_not_verified(self):
        self.assertFalse(match_quote("締切の時点で25歳以下であること", DOC).ok)

    def test_too_short(self):
        self.assertEqual(match_quote("以下", DOC).reason, "TOO_SHORT")

    def test_qualifier_in_next_sentence_is_not_outside(self):
        m = match_quote("他の奨学金と併願・併給も可能です。", DOC)
        self.assertTrue(m.ok)
        self.assertEqual(m.qualifiers_outside, [])

    def test_qualifier_outside_quote_in_same_sentence(self):
        doc = "ITエンジニア職の正社員としての就業経験がないこと(ただし、アルバイトは含みません)。"
        m = match_quote("ITエンジニア職の正社員としての就業経験がないこと", doc)
        self.assertIn("ただし", m.qualifiers_outside)

    def test_block_separator_cannot_be_crossed(self):
        doc = "応募資格は学部生\u001eに限ります"
        self.assertFalse(match_quote("応募資格は学部生に限ります", doc).ok)

    def test_find_terms_and_sentences(self):
        self.assertEqual(find_terms(["併給", "高校"], DOC), ["併給"])
        self.assertEqual(term_sentences(["学内選考"], DOC), ["ただし、学内選考の奨学金を除きます。"])


if __name__ == "__main__":
    unittest.main()
