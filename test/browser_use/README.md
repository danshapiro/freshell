# Browser Use Smoke Test (Non-Gating)

This directory contains an LLM-driven browser smoke test for Freshell using the `browser-use` Python library and **Browser Use's hosted LLM gateway** (`ChatBrowserUse`).

## Requirements

- Python 3.10+
- `BROWSER_USE_API_KEY` set in your environment (do not commit this)

## Install

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r test/browser_use/requirements.txt
```

If your environment does not already have a usable Chrome/Chromium, you may need Playwright's browser install:

```bash
python -m playwright install chromium
```

## Logs

This runner logs structured JSON (pino-style) to stdout. Any `?token=...` in URLs is redacted in logs.

Enable more detail with:

```bash
python test/browser_use/smoke_freshell.py --debug
```

## Unit Tests

```bash
python -m unittest discover -s test/browser_use -p '*_test.py'
```

## Run

With the Freshell dev server running (typically Vite on `http://localhost:5173` and backend on `PORT`):

```bash
python test/browser_use/smoke_freshell.py
```

### Headful Chrome (CDP)

If you want to run this smoke test headfully against an existing Chrome instance, start Chrome with CDP enabled and a fixed window size:

```bash
setsid -f google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/home/user/.cache/superpowers/browser-profiles/superpowers-chrome \
  --no-first-run --no-default-browser-check \
  --window-size=1024,768 \
  http://localhost:5173/
```

Then run:

```bash
python test/browser_use/smoke_freshell.py --cdp-url http://localhost:9222
```

Useful flags:

- `--base-url http://localhost:5173`
- `--token <AUTH_TOKEN>`
- `--model bu-latest`
- `--cdp-url http://localhost:9222` (attach to an existing Chrome with remote debugging enabled)
- `--headless`
- `--width 1024 --height 768`
- `--max-steps 120`
- `--pane-target 6` (small pane stress target; hard-capped at 6)
