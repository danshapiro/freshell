#!/usr/bin/env python3
"""
Non-gating browser smoke test using browser_use + Browser Use's hosted LLM gateway (ChatBrowserUse).

This is intentionally "best effort" and may be flaky. Keep deterministic E2E tests in Playwright.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import traceback
import logging
import urllib.request
from pathlib import Path

from smoke_utils import (
  JsonLogger,
  build_target_url,
  default_base_url,
  env_or,
  find_upwards,
  load_dotenv,
  monotonic_timer,
  redact_url,
  redact_text,
  require,
  token_fingerprint,
)


async def _run(args: argparse.Namespace) -> int:
  repo_root = Path(__file__).resolve().parents[2]
  package_json_path = find_upwards(repo_root, "package.json")
  version = None
  if package_json_path:
    try:
      import json
      version = json.loads(package_json_path.read_text(encoding="utf-8")).get("version")
    except Exception:
      version = None

  dotenv_path = find_upwards(repo_root, ".env")
  dotenv = load_dotenv(dotenv_path) if dotenv_path else {}

  log = JsonLogger(min_level=("debug" if args.debug else "info"), version=version)
  log.info(
    "Smoke start",
    event="smoke_start",
    repoRoot=str(repo_root),
    dotenvPath=str(dotenv_path) if dotenv_path else None,
    hasBrowserUseKey=bool(os.environ.get("BROWSER_USE_API_KEY")),
  )

  if args.require_api_key and not os.environ.get("BROWSER_USE_API_KEY"):
    log.error("Missing BROWSER_USE_API_KEY", event="missing_browser_use_api_key")
    return 2

  base_url = args.base_url or default_base_url(dotenv)
  token = env_or(args.token, "AUTH_TOKEN") or dotenv.get("AUTH_TOKEN")
  try:
    token = require("AUTH_TOKEN (pass --token or set AUTH_TOKEN / .env)", token)
  except ValueError as e:
    log.error(str(e), event="missing_auth_token")
    return 2

  model = env_or(args.model, "BROWSER_USE_MODEL") or "bu-latest"
  target_url = build_target_url(base_url, token)
  redacted_target_url = redact_url(target_url)
  preferred_readme = Path("/home/user/code/freshell/README.md")
  known_text_file = (preferred_readme if preferred_readme.exists() else (repo_root / "README.md")).resolve()

  # Configure browser_use logging and redact tokens from any log messages.
  # This keeps the console usable while avoiding accidental token leakage.
  class _RedactTokenFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
      try:
        msg = record.getMessage()
        redacted = redact_text(msg)
        record.msg = redacted
        record.args = ()
      except Exception:
        pass
      return True

  class _RedactingStream:
    def __init__(self, stream, token: str):
      self._stream = stream
      self._token = token

    def write(self, s):
      try:
        if not isinstance(s, str):
          return self._stream.write(s)
        redacted = redact_text(s)
        if self._token:
          redacted = redacted.replace(self._token, "REDACTED")
        return self._stream.write(redacted)
      except Exception:
        return self._stream.write(s)

    def flush(self):
      return self._stream.flush()

  root_logger = logging.getLogger()
  root_logger.setLevel(logging.INFO if args.debug else logging.INFO)
  for h in root_logger.handlers:
    h.addFilter(_RedactTokenFilter())

  # Some environments have no handlers set yet.
  if not root_logger.handlers:
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.addFilter(_RedactTokenFilter())
    handler.setLevel(logging.INFO)
    root_logger.addHandler(handler)

  log.info(
    "Smoke config",
    event="smoke_config",
    baseUrl=base_url,
    targetUrl=redacted_target_url,
    tokenLen=len(token),
    tokenFp=token_fingerprint(token),
    model=model,
    headless=args.headless,
    width=args.width,
    height=args.height,
    cdpUrl=args.cdp_url,
    maxSteps=args.max_steps,
    paneTarget=args.pane_target,
  )

  if args.preflight:
    health_url = f"{base_url.rstrip('/')}/api/health"
    try:
      with urllib.request.urlopen(health_url, timeout=3) as resp:
        code = getattr(resp, "status", None) or resp.getcode()
        log.info("Preflight /api/health ok", event="preflight_ok", url=health_url, status=code)
    except Exception as e:
      log.error("Preflight /api/health failed", event="preflight_failed", url=health_url, error=str(e))
      return 1

  # Imports are inside the async runner so `python -m py_compile` works without deps installed.
  from browser_use import Agent, Browser, ChatBrowserUse  # type: ignore
  from browser_use.tools.service import Tools  # type: ignore

  llm = ChatBrowserUse(model=model)
  browser = Browser(
    headless=args.headless,
    cdp_url=args.cdp_url,
    window_size={"width": args.width, "height": args.height},
    viewport={"width": args.width, "height": args.height},
    no_viewport=False,
  )

  task = f"""
You are running a browser smoke test for a local Freshell dev instance.

Target URL: {target_url}

Important constraints:
- Do not create or write any files during this run.

Requirements:
1) Navigate to the Target URL.
2) Wait until the page is fully loaded and the top bar is visible.
3) Verify the app header contains the text "freshell".
4) Verify the connection indicator shows the app is connected (not disconnected).
5) Pane stress test (do this once):
   - Use the UI control(s) for adding/splitting panes (floating action button, split buttons, etc).
   - Try to add panes until the UI prevents adding more (button disabled, no new pane appears, or explicit limit message).
   - If you can still add panes indefinitely, stop once you have created at least {args.pane_target} panes total (this is a "good enough" stress level for this smoke test).
   - IMPORTANT: Don't try to verify pane types on this stress-test tab. Just create many panes and then stop.
6) Create a new shell tab (click the plus button in the tab bar with the tooltip/title "New shell tab"). Do not open new windows.
7) On that new tab, create a few panes and confirm one of each type exists (Editor, Terminal, Browser). Keep this as a multi-pane tab for quick review.
8) Create a new shell tab for a single-pane Editor verification:
   - Create an Editor pane.
   - Open this file path: {known_text_file}
   - Verify the editor shows content from that file by using `find_text` to scroll to "Quick Start".
9) Create a new shell tab for a single-pane Terminal verification:
   - Create a WSL (or other shell) terminal pane.
   - Run `node -v` (or `git --version` if node is unavailable).
   - Verify visually the command output looks like a version string in the terminal output.
10) Create a new shell tab for a single-pane Browser verification:
   - Create a Browser pane.
   - Navigate to https://example.com
   - Verify visually the page shows "Example Domain".
11) Create one more new shell tab for Settings verification.
12) On that tab, open the sidebar (if it is collapsed) using the top-left toggle button.
13) Click "Settings" in the sidebar.
14) On the Settings page, confirm "Terminal preview" is visible (use `find_text`).
15) Navigate back to the terminal view.
16) Click through the tabs in the tab bar to confirm they still render (stress, multi-pane, editor, terminal, browser, settings).

Output:
At the end, output exactly one line:
SMOKE_RESULT: PASS
or
SMOKE_RESULT: FAIL - <short reason>
"""

  agent = Agent(
    task=task.strip(),
    llm=llm,
    browser=browser,
    # Disallow filesystem mutation actions (keeps the smoke "pure" and avoids /tmp todo.md noise).
    # Also exclude page-text scraping helpers that can give misleading negatives for xterm/iframes.
    tools=Tools(exclude_actions=["write_file", "replace_file", "read_file", "search_page", "extract"]),
    use_vision=True,
  )

  _start, elapsed_s = monotonic_timer()
  try:
    orig_stdout, orig_stderr = sys.stdout, sys.stderr
    sys.stdout = _RedactingStream(orig_stdout, token)
    sys.stderr = _RedactingStream(orig_stderr, token)
    try:
      history = await agent.run(max_steps=args.max_steps)
    finally:
      sys.stdout = orig_stdout
      sys.stderr = orig_stderr
  finally:
    # Best-effort cleanup. The Browser API exposes start/stop in some versions.
    stop = getattr(browser, "stop", None)
    if callable(stop):
      try:
        await stop()
      except Exception:
        pass

  log.info("Agent finished", event="agent_finished", elapsedS=round(elapsed_s(), 2))

  # Log some history summary if available. This can be large, but it's useful for debugging flakes.
  try:
    action_history = getattr(history, "action_history", None)
    if callable(action_history):
      actions = action_history()
      # Avoid dumping huge non-JSON-serializable structures; log a cheap summary.
      action_count = len(actions) if hasattr(actions, "__len__") else None
      log.debug("Agent action_history summary", event="agent_action_history", actionCount=action_count)
  except Exception:
    log.debug("Failed to read action_history", event="agent_action_history_error", trace=traceback.format_exc())

  try:
    errors = getattr(history, "errors", None)
    if callable(errors):
      errs = errors()
      if isinstance(errs, list):
        non_empty = [e for e in errs if e]
        if non_empty:
          log.warn("Agent history errors present", event="agent_history_errors", errors=non_empty)
      elif errs:
        log.warn("Agent history errors present", event="agent_history_errors", errors=errs)
  except Exception:
    log.debug("Failed to read errors()", event="agent_errors_error", trace=traceback.format_exc())

  # Prefer explicit success indicator if the library provides it.
  is_successful = getattr(history, "is_successful", None)
  if callable(is_successful):
    ok = is_successful()
    if ok is False:
      final_result = getattr(history, "final_result", None)
      msg = final_result() if callable(final_result) else None
      log.error(
        "Agent reported unsuccessful",
        event="agent_unsuccessful",
        finalResult=str(msg)[:2000] if msg is not None else None,
      )
      return 1

  has_errors = getattr(history, "has_errors", None)
  if callable(has_errors) and has_errors():
    errors = getattr(history, "errors", None)
    errs = errors() if callable(errors) else None
    log.error("Agent history contains errors", event="agent_has_errors", errors=errs)
    return 1

  final_result_fn = getattr(history, "final_result", None)
  final = final_result_fn() if callable(final_result_fn) else None
  final_text = str(final or "").strip()
  if "SMOKE_RESULT: PASS" in final_text:
    log.info("SMOKE_RESULT: PASS", event="smoke_pass")
    return 0
  if "SMOKE_RESULT: FAIL" in final_text:
    log.error("SMOKE_RESULT: FAIL", event="smoke_fail", reason=final_text[:2000])
    return 1

  # If the agent didn't follow output instructions, treat as failure (keeps smoke honest).
  log.error("Missing SMOKE_RESULT marker in final_result()", event="missing_smoke_result")
  if final_text:
    log.error("final_result()", event="final_result_text", text=final_text[:2000])
  return 1


def main(argv: list[str]) -> int:
  p = argparse.ArgumentParser(description="browser_use smoke test for Freshell (non-gating).")
  p.add_argument("--base-url", default=None, help="Base URL (default: http://localhost:$VITE_PORT)")
  p.add_argument("--token", default=None, help="Auth token (default: AUTH_TOKEN env or .env)")
  p.add_argument("--model", default=None, help="Browser Use model (default: $BROWSER_USE_MODEL or bu-latest)")
  p.add_argument("--cdp-url", default=None, help="Connect to existing Chrome via CDP (e.g. http://localhost:9222)")
  p.add_argument("--headless", action="store_true", help="Run browser headless (default: headful)")
  p.add_argument("--width", type=int, default=1024, help="Browser viewport width")
  p.add_argument("--height", type=int, default=768, help="Browser viewport height")
  p.add_argument("--max-steps", type=int, default=120, help="Max agent steps")
  p.add_argument("--pane-target", type=int, default=24, help="Stop pane stress after this many panes if no limit is reached")
  p.add_argument("--preflight", action="store_true", help="Fail fast if /api/health is unreachable")
  p.add_argument("--debug", action="store_true", help="Enable debug logging")
  p.add_argument(
    "--no-require-api-key",
    dest="require_api_key",
    action="store_false",
    help="Do not fail fast if BROWSER_USE_API_KEY is missing (may still fail later).",
  )
  p.set_defaults(require_api_key=True)
  args = p.parse_args(argv)
  try:
    return asyncio.run(_run(args))
  except KeyboardInterrupt:
    return 130
  except Exception:
    # Ensure we always get a stack trace for debugging in logs/CI.
    sys.stderr.write(traceback.format_exc())
    sys.stderr.flush()
    return 1


if __name__ == "__main__":
  raise SystemExit(main(sys.argv[1:]))
