# T3 re-baseline of the ORIGINAL on host SurfaceBookPro9 — 2026-07-11

Work-queue item 3 of `port/HANDOFF.md` §9: run the retained T3 e2e suite against the
ORIGINAL (Node/TS) freshell on THIS host and record its exact pass/fail profile.
This profile is the comparison target for the Rust port on this host.

## How it was run

- ORIGINAL `dist/server/index.js` (fresh `npm run build`, worktree commit `59a585ad`,
  branch `feat/rust-tauri-port`) booted as an EXTERNAL target on `127.0.0.1:17871`
  with an isolated scratch `$HOME` under the user home (pre-seeded
  `{"version":1,"settings":{"network":{"configured":true,"host":"127.0.0.1"}}}`,
  identical to what the E2E `TestServer` writes, so the setup wizard is bypassed),
  `NODE_ENV=production`, fresh random `AUTH_TOKEN`.
- Suite: `npx playwright test --config port/oracle/t3/playwright.target.config.ts`
  with `FRESHELL_E2E_TARGET_URL` / `FRESHELL_E2E_TARGET_TOKEN` /
  `FRESHELL_E2E_TARGET_HOME` set. External mode excludes the 6 server-owning spec
  files → **126 externally-targetable tests**. workers=1, retries=0, **single run**
  (no re-runs; red is data).
- Host: WSL2 (`Linux 6.6.87.2-microsoft-standard-WSL2`), Node v24.12.0,
  Playwright 1.58.2, chromium-1208 (145.0.7632.6), snapshots `chromium-linux`.
- Playwright headless smoke (`npx playwright screenshot about:blank`) verified
  before the run: PASS.

## Result

**117 passed / 9 failed of 126 · runtime 16.1 m (963,590 ms) · 0 flaky · 0 skipped.**
Visual: all 6 `screenshot-baselines` goldens MATCH; `editor-pane-loaded` (the
no-tolerance golden) MISMATCH — same visual profile as the prior host.

Artifacts:
- `port/oracle/baselines/t3/summary-2026-07-11-original-sbp9.json` (this host's profile;
  the prior host's `summary.json` is preserved untouched)
- `port/oracle/baselines/t3/playwright-report-2026-07-11-original-sbp9.json` (raw report)

## Failing specs (exact, with line numbers)

| # | Spec | Failure |
|---|------|---------|
| 1 | `editor-pane.spec.ts:83` — loads the editor lazily and requests a new JS asset after the click | `toHaveScreenshot(editor-pane-loaded.png)` (no-tolerance golden) mismatch |
| 2 | `fresh-agent-centralization-smoke.spec.ts:402` — normalizes remote legacy layout sync before exposing server pane snapshots | expected HTTP 422, received 500 |
| 3 | `fresh-agent-centralization-smoke.spec.ts:448` — keeps fresh-agent settings and routes while legacy settings and routes are removed | `getByText('Fresh agent')` not found |
| 4 | `fresh-agent.spec.ts:98` — pane picker hides fresh clients by default even when their CLIs are enabled | **NEW on this host** — Freshclaude button `toHaveCount(0)` got 1 (spec line 117) |
| 5 | `freshopencode-model-picker.spec.ts:41` — shows MRU tiles, sorted modal sources, and client-side filtering | Freshopencode pane group not found (needs opencode model catalog) |
| 6 | `mobile-viewport.spec.ts:195` — permission banner buttons are visible and functional on mobile | `toContainText` on permission-request alert failed |
| 7 | `multi-client.spec.ts:217` — reconnecting second viewer keeps page 1 PTY size stable and both pages keep shared output | `page.waitForFunction` timeout 20 s |
| 8 | `multirow-tabs.spec.ts:9` — enables multi-row tabs via settings toggle | multi-row-tabs switch not visible after opening Settings |
| 9 | `pane-activity-indicator.spec.ts:79` — freshclaude panes transition from waiting to blue running and back to idle | pane icon `toHaveClass(/text-blue-500/)` failed |

## Comparison to the prior host's profile

Prior host (`summary.json` + `EQUIVALENCE-REPORT.md` §6): **118/126** externally-targetable
pass with **8 EQUIVALENT-red** fails — `editor-pane:83`,
`fresh-agent-centralization-smoke:402`, `fresh-agent-centralization-smoke:448`,
`freshopencode-model-picker:41`, `mobile-viewport:195`, `multi-client:217`,
`multirow-tabs:9`, `pane-activity-indicator:79`.

This host: **117/126**, failing set = the **same 8** plus **one newly red**:

- `fresh-agent.spec.ts:98` "pane picker hides fresh clients by default even when their
  CLIs are enabled" — the pane picker on this host renders a `Freshclaude` tile where
  the spec expects fresh clients hidden by default. Passed on the prior host
  (`fresh-agent.spec.ts` was 9/9 in `summary.json`); 8/9 here. Host-environment
  dependence suspected (available CLIs on this host differ), but recorded exactly as
  observed — single run, unclassified flaky-vs-hard.

No prior-red spec became green. So the Rust port's target profile on THIS host is:
keep all 117 green tests green (+ 6/6 visual MATCH); the 9 red are red-on-original
(EQUIVALENT if red against the port too).

## Hygiene

- Server on :17871 reaped after the run (PID killed, verified dead); scratch home
  removed; orphan sweep clean; no listeners left on 1787x. The user's live server
  was never touched (reserved ORIGINAL port 17871 used, never 3000-3010).
- Purity: `git diff --name-only server/ shared/ src/` empty; no test/spec files
  modified; no assertions weakened; nothing committed.
