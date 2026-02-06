import unittest

from smoke_freshell import _parse_smoke_result


class SmokeFreshellParseTest(unittest.TestCase):
  def test_pass_requires_exact_single_line(self) -> None:
    ok, err = _parse_smoke_result("SMOKE_RESULT: PASS")
    self.assertTrue(ok)
    self.assertIsNone(err)

  def test_pass_with_extra_text_is_invalid(self) -> None:
    ok, err = _parse_smoke_result("SMOKE_RESULT: PASS. extra")
    self.assertFalse(ok)
    self.assertEqual(err, "final_result_invalid_format")

  def test_fail_requires_reason(self) -> None:
    ok, err = _parse_smoke_result("SMOKE_RESULT: FAIL - terminal version missing")
    self.assertFalse(ok)
    self.assertIsNone(err)

  def test_empty_is_invalid(self) -> None:
    ok, err = _parse_smoke_result("")
    self.assertFalse(ok)
    self.assertEqual(err, "missing_final_result")

  def test_multiple_lines_is_invalid(self) -> None:
    ok, err = _parse_smoke_result("SMOKE_RESULT: PASS\nmore")
    self.assertFalse(ok)
    self.assertEqual(err, "final_result_not_single_line")


if __name__ == "__main__":
  raise SystemExit(unittest.main())

