#!/usr/bin/env python3
"""
Browser-use test for tool strip coalescing in Freshclaude.

Verifies that consecutive tool uses in an assistant turn appear as ONE
strip showing "N tools used" instead of multiple separate "1 tool used" strips.
Uses an LLM as judge to evaluate the visual result.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import logging
import urllib.request
from pathlib import Path

# Add parent directory for shared utilities
sys.path.insert(0, str(Path(__file__).resolve().parent))

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


def _parse_result(final_text: str) -> tuple[bool, str | None]:
  """
  Enforce strict output contract:
  - Exactly one line
  - Exactly "TOOL_COALESCE_RESULT: PASS"
    or "TOOL_COALESCE_RESULT: FAIL - <short reason>"
  """
  text = (final_text or "").strip()
  if not text:
    return False, "missing_final_result"

  lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
  if len(lines) != 1:
    return False, "final_result_not_single_line"

  line = lines[0]
  if line == "TOOL_COALESCE_RESULT: PASS":
    return True, None
  if line.startswith("TOOL_COALESCE_RESULT: FAIL - ") and len(line) > len("TOOL_COALESCE_RESULT: FAIL - "):
    return False, None
  return False, "final_result_invalid_format"


def _build_task(*, base_url: str) -> str:
  return f"""
You are testing the tool strip coalescing feature in a Freshell Freshclaude session.

The app is already opened and authenticated at {base_url}.

Your goal: Verify that when an assistant turn uses multiple tools, they appear grouped in ONE tool strip showing "N tools used" instead of multiple separate "1 tool used" strips.

Steps:

1. Open the sidebar if it's collapsed. Look for Freshclaude sessions (they have a different icon than shell tabs).

2. Find and click on a Freshclaude session that has assistant messages with tool uses. Look for sessions that show tool indicators or message counts.

3. If no session with multiple tool uses exists, skip to step 7 and report what you found.

4. Once in a session, look at the assistant messages that contain tool uses. Find a message where the assistant used 2 or more tools in a single turn.

5. Examine the tool strip display for that message:
   - A tool strip should be visible showing either "N tools used" (collapsed) or individual tool blocks (expanded)
   - Count how many separate tool-related text lines are visible (e.g., "1 tool used", "2 tools used", etc.)

6. Judge the result:
   - PASS: You see ONE tool strip per assistant turn, showing the combined count (e.g., "2 tools used" or "3 tools used")
   - FAIL: You see MULTIPLE separate lines each showing "1 tool used" for tools that should be grouped

7. Report your findings as exactly one line:
   - If tool strips are correctly coalesced: TOOL_COALESCE_RESULT: PASS
   - If you see multiple separate "1 tool used" strips: TOOL_COALESCE_RESULT: FAIL - multiple strips found
   - If no suitable session found: TOOL_COALESCE_RESULT: FAIL - no session with tools

Non-negotiable constraints:
- Do not create or write any files
- Stay in ONE browser tab
- Output exactly one result line at the end
"""


async def _run(args: argparse.Namespace) -> int:
  repo_root = Path(__file__).resolve().parents[2]
  dotenv_path = find_upwards(repo_root, ".env")
  dotenv = load_dotenv(dotenv_path) if dotenv_path else {}

  log = JsonLogger(min_level=("debug" if args.debug else "info"))

  if args.require_api_key and not os.environ.get("BROWSER_USE_API_KEY"):
    log.error("Missing BROWSER_USE_API_KEY", event="missing_browser_use_api_key")
    return 2

  base_url = args.base_url or default_base_url(dotenv)
  token = env_or(args.token, "AUTH_TOKEN") or dotenv.get("AUTH_TOKEN")
  try:
    token = require("AUTH_TOKEN", token)
  except ValueError as e:
    log.error(str(e), event="missing_auth_token")
    return 2

  model = env_or(args.model, "BROWSER_USE_MODEL") or "bu-latest"
  target_url = build_target_url(base_url, token)
  redacted_target_url = redact_url(target_url)

  log.info(
    "Tool coalesce test start",
    event="test_start",
    baseUrl=base_url,
    tokenFp=token_fingerprint(token),
    model=model,
    headless=args.headless,
  )

  if args.preflight:
    health_url = f"{base_url.rstrip('/')}/api/health"
    try:
      with urllib.request.urlopen(health_url, timeout=3) as resp:
        log.info("Preflight ok", event="preflight_ok", url=health_url)
    except Exception as e:
      log.error("Preflight failed", event="preflight_failed", url=health_url, error=str(e))
      return 1

  from browser_use import Agent, Browser, ChatBrowserUse  # type: ignore

  llm = ChatBrowserUse(model=model)
  browser = Browser(
    headless=args.headless,
    window_size={"width": args.width, "height": args.height},
    viewport={"width": args.width, "height": args.height},
    no_viewport=False,
  )
  browser_started = False

  try:
    log.info("Pre-opening target URL", event="preopen_target", targetUrl=redacted_target_url)
    await browser.start()
    browser_started = True

    # Navigate to authenticated URL
    page = await browser.new_page(target_url)

    log.info("Target URL opened", event="preopen_target_ok")
  except Exception as e:
    log.error("Failed to pre-open target URL", event="preopen_target_failed", error=str(e))
    if browser_started:
      try:
        await browser.stop()
      except Exception:
        pass
    return 1

  task = _build_task(base_url=base_url)

  agent = Agent(
    task=task.strip(),
    llm=llm,
    browser=browser,
    use_vision=True,
    max_actions_per_step=2,
    directly_open_url=False,
  )

  _start, elapsed_s = monotonic_timer()
  try:
    log.info("Agent run start", event="agent_run_start", maxSteps=args.max_steps)
    history = await agent.run(max_steps=args.max_steps)
  finally:
    if browser_started:
      try:
        await browser.stop()
      except Exception:
        pass

  log.info("Agent finished", event="agent_finished", elapsedS=round(elapsed_s(), 2))

  final_result_fn = getattr(history, "final_result", None)
  final = final_result_fn() if callable(final_result_fn) else None
  final_text = str(final or "").strip()

  ok, parse_err = _parse_result(final_text)
  if parse_err:
    log.error("Invalid final_result format", event="invalid_final_result", error=parse_err, text=final_text[:500])
    return 1
  if ok:
    log.info("TOOL_COALESCE_RESULT: PASS", event="test_pass")
    return 0
  log.error("TOOL_COALESCE_RESULT: FAIL", event="test_fail", reason=final_text[:500])
  return 1


def main(argv: list[str]) -> int:
  p = argparse.ArgumentParser(description="browser_use test for tool strip coalescing in Freshell.")
  p.add_argument("--base-url", default=None, help="Base URL (default: http://localhost:$VITE_PORT)")
  p.add_argument("--token", default=None, help="Auth token (default: AUTH_TOKEN env or .env)")
  p.add_argument("--model", default=None, help="Browser Use model (default: $BROWSER_USE_MODEL or bu-latest)")
  p.add_argument("--headless", action="store_true", help="Run browser headless (default: headful)")
  p.add_argument("--width", type=int, default=1024, help="Browser viewport width")
  p.add_argument("--height", type=int, default=768, help="Browser viewport height")
  p.add_argument("--max-steps", type=int, default=60, help="Max agent steps")
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
    import traceback
    sys.stderr.write(traceback.format_exc())
    sys.stderr.flush()
    return 1


if __name__ == "__main__":
  raise SystemExit(main(sys.argv[1:]))


