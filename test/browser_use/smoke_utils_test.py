import tempfile
import unittest
from pathlib import Path

from smoke_utils import (
  build_target_url,
  find_upwards,
  load_dotenv,
  redact_url,
  token_fingerprint,
)


class SmokeUtilsTest(unittest.TestCase):
  def test_load_dotenv_parses_simple(self):
    with tempfile.TemporaryDirectory() as td:
      p = Path(td) / ".env"
      p.write_text(
        "\n".join(
          [
            "# comment",
            "AUTH_TOKEN=abc123",
            "VITE_PORT=5173",
            "",
            "EMPTY=",
          ]
        ),
        encoding="utf-8",
      )
      env = load_dotenv(p)
      self.assertEqual(env["AUTH_TOKEN"], "abc123")
      self.assertEqual(env["VITE_PORT"], "5173")
      self.assertEqual(env["EMPTY"], "")

  def test_find_upwards_finds_nearest(self):
    with tempfile.TemporaryDirectory() as td:
      root = Path(td)
      (root / "a" / "b").mkdir(parents=True)
      (root / ".env").write_text("ROOT=1", encoding="utf-8")
      (root / "a" / ".env").write_text("A=1", encoding="utf-8")

      found = find_upwards(root / "a" / "b", ".env")
      self.assertIsNotNone(found)
      self.assertEqual(found, root / "a" / ".env")

  def test_redact_url_redacts_token_query_param(self):
    url = "http://localhost:5173/?token=secret&x=1"
    self.assertEqual(redact_url(url), "http://localhost:5173/?token=REDACTED&x=1")

  def test_build_target_url_appends_token(self):
    self.assertEqual(build_target_url("http://localhost:5173", "t"), "http://localhost:5173/?token=t")
    self.assertEqual(build_target_url("http://localhost:5173/", "t"), "http://localhost:5173/?token=t")

  def test_token_fingerprint_matches_repo_style(self):
    self.assertEqual(token_fingerprint("1234567890abcdef"), "1234...cdef")
    self.assertEqual(token_fingerprint("a" * 32), ("a" * 8) + "..." + ("a" * 8))


if __name__ == "__main__":
  unittest.main()
