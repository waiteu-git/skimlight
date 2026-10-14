import unittest

from tools import export_vectors


class VectorsTest(unittest.TestCase):
    def test_web_vectors_are_current(self):
        # Web 版と共有するテストベクトルが、いまの CLI の判定と一致している
        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()):
            orig = export_vectors.sys.argv
            export_vectors.sys.argv = ["x", "--check"]
            try:
                self.assertEqual(export_vectors.main(), 0, "python3 -m tools.export_vectors で書き直してください")
            finally:
                export_vectors.sys.argv = orig
