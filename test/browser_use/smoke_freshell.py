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
import time
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


def _parse_smoke_result(final_text: str) -> tuple[bool, str | None]:
  """
  Enforce strict output contract:
  - Exactly one line
  - Exactly "SMOKE_RESULT: PASS"
    or "SMOKE_RESULT: FAIL - <short reason>"
  """
  text = (final_text or "").strip()
  if not text:
    return False, "missing_final_result"

  lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
  if len(lines) != 1:
    return False, "final_result_not_single_line"

  line = lines[0]
  if line == "SMOKE_RESULT: PASS":
    return True, None
  if line.startswith("SMOKE_RESULT: FAIL - ") and len(line) > len("SMOKE_RESULT: FAIL - "):
    return False, None
  return False, "final_result_invalid_format"


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

  # Hard cap: keep the smoke run small and fast.
  # This also enforces the repo-local rule: never open more than 6 panes during this smoke.
  MAX_PANES = 6
  if args.pane_target > MAX_PANES:
    log.warn("Clamping pane_target to 6", event="pane_target_clamped", requested=args.pane_target, clamped=MAX_PANES)
    args.pane_target = MAX_PANES

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
  root_logger.setLevel(logging.DEBUG if args.debug else logging.INFO)
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
  from browser_use.agent.views import ActionResult  # type: ignore
  from pydantic import BaseModel  # type: ignore

  llm = ChatBrowserUse(model=model)
  browser = Browser(
    headless=args.headless,
    cdp_url=args.cdp_url,
    window_size={"width": args.width, "height": args.height},
    viewport={"width": args.width, "height": args.height},
    no_viewport=False,
  )
  browser_started = False

  # Pre-open the authenticated URL outside the agent task to avoid printing the token.
  # browser_use prints the entire task (and action URLs) to stdout; keep secrets out of it.
  try:
    log.info("Pre-opening target URL", event="preopen_target", targetUrl=redacted_target_url)
    await browser.start()
    browser_started = True
    # Avoid leaking browser tabs across runs: when attaching over CDP to an existing Chrome,
    # tabs may remain open after we disconnect. Each open Freshell tab maintains its own
    # backend WS connection, and the backend enforces a max-connection limit.
    #
    # Strategy:
    # - Reuse a single existing page (navigate it to the authed URL)
    # - Close other Freshell/blank tabs to free WS connections
    pages = []
    try:
      pages = await browser.get_pages()
    except Exception:
      pages = []

    page = None
    if pages:
      for p in reversed(pages):
        try:
          url = await p.get_url()
          title = await p.get_title()
          if (title and "freshell" in title.lower()) or (url and url.startswith(base_url)):
            page = p
            break
        except Exception:
          continue
      if page is None:
        page = pages[-1]
    else:
      page = await browser.new_page("about:blank")

    try:
      from browser_use.browser.events import CloseTabEvent  # type: ignore

      for p in pages:
        if p is page:
          continue
        try:
          url = await p.get_url()
          title = await p.get_title()
          is_freshellish = (title and "freshell" in title.lower()) or (url and url.startswith(base_url)) or url == "about:blank"
          if not is_freshellish:
            continue
          tid = getattr(p, "_target_id", None)
          if tid:
            await browser.event_bus.dispatch(CloseTabEvent(target_id=tid))
        except Exception:
          continue
    except Exception:
      pass

    # Navigate without opening a new browser tab (keeps WS connections bounded).
    try:
      goto = getattr(page, "goto", None)
      if callable(goto):
        await goto(target_url)
      else:
        navigate = getattr(page, "navigate", None)
        if callable(navigate):
          await navigate(target_url)
        else:
          page = await browser.new_page(target_url)
    except Exception:
      page = await browser.new_page(target_url)

    # Ensure the agent focus is on the active tab we just navigated.
    try:
      from browser_use.browser.events import SwitchTabEvent  # type: ignore

      tid = getattr(page, "_target_id", None)
      await browser.event_bus.dispatch(SwitchTabEvent(target_id=tid))
    except Exception:
      pass

    # Ensure viewport is applied to the active page (especially when attaching over CDP).
    try:
      set_viewport_size = getattr(page, "set_viewport_size", None)
      if callable(set_viewport_size):
        await set_viewport_size(args.width, args.height)
    except Exception:
      pass
    # Wait for the SPA to fully bootstrap auth:
    # - token removed from URL
    # - auth-token stored in sessionStorage
    # - terminal view rendered (Add Pane button present)
    #
    # Without this, the agent may refresh/navigate and lose auth, causing flaky failures.
    deadline = time.monotonic() + 30.0
    ready = False
    while time.monotonic() < deadline:
      try:
        # These checks intentionally avoid reading the token value to keep it out of any debug logs.
        auth_present = await page.evaluate("() => !!sessionStorage.getItem('auth-token')")
        token_removed = await page.evaluate("() => !new URLSearchParams(window.location.search).has('token')")
        has_add_pane = await page.evaluate("() => !!document.querySelector('button[aria-label=\"Add pane\"]')")
        has_connected = await page.evaluate("() => !!document.querySelector('[title=\"Connected\"]')")
        if auth_present and token_removed and has_add_pane and has_connected:
          ready = True
          break
      except Exception:
        pass
      await asyncio.sleep(0.5)
    if not ready:
      log.error("Pre-open did not complete auth bootstrap in time", event="preopen_target_not_ready")
      raise RuntimeError("App did not bootstrap auth/render in time")

    try:
      current_url = await page.get_url()
      log.info("Target URL opened", event="preopen_target_ok", currentUrl=redact_url(current_url))
    except Exception:
      log.info("Target URL opened", event="preopen_target_ok")
  except Exception as e:
    log.error("Failed to pre-open target URL", event="preopen_target_failed", error=str(e))
    try:
      stop = getattr(browser, "stop", None)
      if browser_started and callable(stop):
        await stop()
    except Exception:
      pass
    return 1

  task = f"""
You are running a browser smoke test for a local Freshell dev instance.

The app is already opened and authenticated in the current tab.

Important constraints:
- Do not create or write any files during this run.
- Do everything in a single browser window and a single browser tab. Do not open any new windows or browser tabs.

Requirements:
1) Wait until the page is fully loaded and the top bar is visible.
   - If you see an "Empty DOM tree" / blank page, make sure you are looking at the Freshell page ({base_url}) and continue from there. Do not navigate away to other sites.
2) Verify the app header contains the text "freshell".
3) Verify the connection indicator shows the app is connected (not disconnected).
   - If it says "Disconnected", wait up to ~10 seconds for it to become connected, then re-check.
   - If it stays disconnected, FAIL with a short reason.
4) Pane stress:
   - Open a new tab to use for this test
   - Rename the tab by double clicking on it 'Stress test'
   - On the current in-app tab, add shell panes until there are {args.pane_target} panes.
   - Do this one pane at a time (avoid stale element errors): click "Add pane" once, then choose "shell" once. If there are multiple choices for shell (cmd, powershell, wsl) rotate your choice each pane.
5) Mixed panes on a new in-app tab:
   - Create a new Freshell in-app shell tab using the '+' button in the top tab bar (tooltip: "New shell tab").
   - Rename the tab by double clicking on it 'Test mixed panes'
   - On this new in-app tab, create a 3-pane layout with EXACTLY one of each type: Editor, shell, Browser.
     - Use the "Add pane" button to split, then pick the pane type in the new pane chooser.
6) Verify the Editor pane:
   - In the Editor pane: open this file path: {known_text_file}.
     - Click the "Enter file path..." input in the editor toolbar, clear it, type/paste the full file path, then press Enter to load it.
     - Ensure Preview mode works:
       - Click the "Source" button and then the "Preview" button (in that order) to prove mode switching works.
     - Use `find_text` to confirm "Quick Start" is visible (this ensures file content actually loaded).
7) Verify the Terminal pane:
   - In the shell pane:
     - Wait for the terminal to be ready (not stuck on "Starting terminal..." / "Reconnecting...").
       - If it is still stuck after ~15 seconds, close just the Terminal pane and re-create a shell pane once, then wait again.
       - If it is still stuck, FAIL with a short reason.
     - Then run `node -v` (or `git --version` if node is unavailable).
     - WAIT for the command to finish and then check that the terminal output contains a version-looking string (examples: `v20.11.0` or `git version 2.44.0`).
     - Terminal input reliability rules:
       - Do NOT send `{{Enter}}` as part of the text (it often gets typed literally).
       - Do NOT use `send_keys` to type command text into the terminal (it can double-type in xterm).
       - Instead, click the terminal pane to focus it, then use the `insert_text` tool to insert the command text, then `send_keys` with `Enter`.
8) Verify the Browser pane:
   - In the Browser pane: open example.com.
   - Verify visually (inside the Browser pane content) that the heading "Example Domain" is visible.
   - Do NOT rely on `find_text` for this (the Browser pane renders cross-origin content).
9) Settings navigation:
   - Stay on the current in-app tab.
   - Open the sidebar (if it is collapsed) using the top-left toggle button.
   - Click "Settings" in the sidebar.
   - Confirm "Terminal preview" is visible by using `find_text`. If `find_text` fails, FAIL.
   - Navigate back to the terminal view by opening the sidebar and clicking "Terminal".

Strict success rules:
- If any verification fails, you MUST output `SMOKE_RESULT: FAIL - <short reason>`.

Output:
At the end, output exactly one line:
SMOKE_RESULT: PASS
or
SMOKE_RESULT: FAIL - <short reason>
"""

  log.info("Agent init start", event="agent_init_start")

  # Register a helper tool to insert text via CDP Input.insertText.
  #
  # Rationale: browser_use's `send_keys` dispatches keydown+char events per character
  # which can double-type into xterm.js terminals. Using CDP insertText behaves like
  # a paste into the currently focused element and is much more reliable for terminals.
  tools = Tools(exclude_actions=["write_file", "replace_file", "read_file", "search_page", "extract", "evaluate"])

  class InsertTextAction(BaseModel):
    text: str

  @tools.registry.action("Insert text into the currently focused element (CDP Input.insertText).", param_model=InsertTextAction)
  async def insert_text(params: InsertTextAction, browser_session):  # type: ignore[no-untyped-def]
    try:
      cdp_session = await browser_session.get_or_create_cdp_session(target_id=None, focus=True)
      await cdp_session.cdp_client.send.Input.insertText(
        params={"text": params.text},
        session_id=cdp_session.session_id,
      )
      memory = f"Inserted text: {params.text}"
      return ActionResult(extracted_content=memory, long_term_memory=memory)
    except Exception as e:
      return ActionResult(error=f"Failed to insert text: {type(e).__name__}: {e}")

  agent = Agent(
    task=task.strip(),
    llm=llm,
    browser=browser,
    tools=tools,
    use_vision=True,
    # Reduce stale-element flakes by keeping each step small and disabling auto-URL opening from task text.
    max_actions_per_step=2,
    directly_open_url=False,
  )
  log.info("Agent init done", event="agent_init_done")

  _start, elapsed_s = monotonic_timer()
  try:
    orig_stdout, orig_stderr = sys.stdout, sys.stderr
    sys.stdout = _RedactingStream(orig_stdout, token)
    sys.stderr = _RedactingStream(orig_stderr, token)
    try:
      log.info("Agent run start", event="agent_run_start", maxSteps=args.max_steps)
      history = await agent.run(max_steps=args.max_steps)
    finally:
      sys.stdout = orig_stdout
      sys.stderr = orig_stderr
  finally:
    # Best-effort cleanup. The Browser API exposes start/stop in some versions.
    stop = getattr(browser, "stop", None)
    if browser_started and callable(stop):
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
    # browser_use can report transient LLM transport errors inside history.errors().
    # Treat those as advisory and only fail if we see non-transient errors.
    transient_prefixes = (
      "API request failed:",
      "LLM call failed",
    )
    non_transient: list[str] = []
    if isinstance(errs, list):
      for e in errs:
        if not e:
          continue
        if isinstance(e, str) and any(e.startswith(p) for p in transient_prefixes):
          continue
        non_transient.append(str(e))
    elif isinstance(errs, str):
      if not any(errs.startswith(p) for p in transient_prefixes):
        non_transient.append(errs)
    elif errs:
      non_transient.append(str(errs))

    if non_transient:
      log.error("Agent history contains non-transient errors", event="agent_has_errors", errors=non_transient)
      return 1

    log.warn("Agent history contains only transient errors", event="agent_has_transient_errors", errors=errs)

  # Browser Use can emit a separate judge verdict even if the agent prints PASS.
  # Treat judge FAIL as a smoke failure (keeps this test honest).
  judgement_data = None
  try:
    judgement = getattr(history, "judgement", None)
    judgement_data = judgement() if callable(judgement) else None
  except Exception:
    judgement_data = None

  verdict_from_judgement = None
  if isinstance(judgement_data, dict):
    verdict_from_judgement = judgement_data.get("verdict")
  elif judgement_data is not None:
    verdict_from_judgement = getattr(judgement_data, "verdict", None)

  if verdict_from_judgement is False:
    log.error("Judge verdict: FAIL", event="judge_fail", judgement=judgement_data)
    return 1

  is_validated = getattr(history, "is_validated", None)
  if callable(is_validated):
    verdict = is_validated()
    if verdict is False:
      log.error("Judge verdict: FAIL", event="judge_fail", judgement=judgement_data)
      return 1

  final_result_fn = getattr(history, "final_result", None)
  final = final_result_fn() if callable(final_result_fn) else None
  final_text = str(final or "").strip()
  ok, parse_err = _parse_smoke_result(final_text)
  if parse_err:
    log.error("Invalid final_result() format", event="invalid_final_result", error=parse_err, text=final_text[:2000])
    return 1
  if ok:
    log.info("SMOKE_RESULT: PASS", event="smoke_pass")
    return 0
  log.error("SMOKE_RESULT: FAIL", event="smoke_fail", reason=final_text[:2000])
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
  p.add_argument("--pane-target", type=int, default=6, help="Target total panes for the small pane stress (hard-capped at 6)")
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
