# T3 — E2E UI + visual parity

**What T3 asserts:** full user flows and the 7 committed visual baselines run green
against the backend. The frontend is **retained unchanged** in the Rust port, so
the existing Playwright `test/e2e-browser/**` specs and their `*-chromium-linux.png`
snapshots ARE the T3 contract — the port's job is to make the identical suite behave
identically.

Baseline captured against the **pristine original** on this host
(WSL2 Linux, chromium-linux). Machine-readable record:
`port/oracle/baselines/t3/summary.json` (+ raw `playwright-report.json`).

---

## Baseline result (ORIGINAL, this host)

Full suite via the shared, unmodified config
(`test/e2e-browser/playwright.config.ts`, `--project=chromium --workers=4`,
retries=0), each worker booting its **own** isolated server on an ephemeral
loopback port. **The user's live server on :3001 was never touched.**

```
138 tests, 31 files, 4 workers, ~7m10s
  122 passed
   16 failed   (ALL reproduce against the pristine original — see "Findings")
    0 flaky / 0 skipped
Visual baselines: 6 / 7 MATCH
```

Every failure was re-run **in isolation** (`--workers=1 --retries=1`) to separate
flaky-under-contention from hard-against-original.

- **21 spec files are fully green** — the stable T3 CORE. This covers every
  required CORE area: **auth** (6/6), **terminal create/lifecycle** (13/13),
  **reconnection** (6/6), **tab system** (tab-management 11/11, tab-recency-sync,
  tabs-client-retire, multirow-tabs 2/3), **pane system** (pane-system 10/10,
  pane-picker 2/2, pane-activity-indicator 2/3), plus sidebar, settings, stress,
  browser-pane, and **6 of the 7 visual baselines**.
- **1 test is flaky-under-contention, not hard:** `editor-pane.spec.ts:120`
  passed isolated and at 4 workers but failed once at 6 workers. In-baseline.

### The 7 visual baselines

| baseline (`-chromium-linux.png`) | spec | status |
|---|---|---|
| default-layout | screenshot-baselines:4 | **MATCH** |
| settings-view | screenshot-baselines:16 | **MATCH** |
| multiple-tabs | screenshot-baselines:29 | **MATCH** |
| auth-modal | screenshot-baselines:41 | **MATCH** |
| sidebar-collapsed | screenshot-baselines:52 | **MATCH** |
| mobile-layout | screenshot-baselines:64 | **MATCH** |
| editor-pane-loaded | editor-pane:83 | **MISMATCH — 118px (ratio 0.0100)** |

The 6 `screenshot-baselines` assertions use `maxDiffPixelRatio: 0.05` and all match.
`editor-pane-loaded` uses **no tolerance**, so a 118px (1% ) Monaco-editor
antialiasing difference fails it. This is a **baseline-strictness finding**, not a
functional regression — recorded, **not** papered over by retaking the snapshot.

---

## Findings — the 16 failures (NOT hidden, NOT force-greened)

All 16 reproduce against the **pristine original** on this host. This is itself the
headline finding: the committed e2e suite is **partially red against its own
backend**, consistent with `DESIGN.md` ("CI runs NONE of the suites") — these specs
have rotted unnoticed. They are **findings, not port failures**, and baselines were
not retaken to force green.

| category | count | tests |
|---|---|---|
| visual_strictness | 1 | editor-pane:83 (zero-tolerance, 118px) |
| frontend_state_machine | 2 | mobile-viewport:195, pane-activity-indicator:79 |
| frontend_settings_ui | 1 | multirow-tabs:9 |
| fresh_agent_centralization | 2 | fresh-agent-centralization-smoke:402, :448 |
| provider_opencode | 8 | freshopencode-db-history:245/:324, freshopencode-model-picker:41, opencode-restart-recovery:628/:713/:901/:1042/:1051 |
| server_lifecycle / co-located | 2 | server-restart-recovery:21, multi-client:217 |

Notes:
- The frontend ones (`mobile-viewport:195`, `multirow-tabs:9`,
  `pane-activity-indicator:79`) are pure-frontend (harness-`dispatch`-driven or
  settings-UI). Because the frontend is unchanged in the port, they fail identically
  on both sides → not backend-differentiating.
- The `provider_opencode` group needs the real opencode CLI + co-located DB/home
  fixtures (T2 territory bleeding into e2e).
- No pristine-source bug was hit that required a source edit. **Source stayed
  pristine the entire run** (`git diff server/ shared/` empty). None of these 16
  meets the objective-defect bar in a way that needs a source patch here; they are
  logged as baseline findings for later triage. If, while porting, any turns out to
  be a genuine original defect, it goes through the **DEV-000X antagonist
  adjudication** path (see `DEVIATIONS.md`) — never a self-approved patch.

### Baseline semantics (how the port is graded against this)

- The **exact 122-pass / 16-fail set is the equivalence reference.**
- The port **MUST** keep all **122 green tests green** (a newly-red test =
  `PORT_DEFECT`) and keep the **6 matching visual baselines matching**.
- The port **need not** pass the 16 already-red tests (`red == red` is
  `EQUIVALENT`). If the port *fixes* one, that is a candidate **`DELIBERATE_FIX`**
  (antagonist-adjudicated + ledgered), not a silent win.

---

## The targetable-URL seam (how the port is pointed at this suite)

The specs boot a fresh server per worker via the `testServer` fixture. The seam
intercepts exactly that one point — **no shared spec was rewritten.**

- `test/e2e-browser/helpers/external-target.ts` — `createE2eServerHandle()` returns
  either a normal `TestServer` (default) or an `ExternalServer` that points at an
  already-running server. `ExternalServer.start()` only **health-checks** the target;
  `stop()` is a deliberate **no-op** (we never own/kill an external process — this is
  what keeps the seam safe against, e.g., the user's live server).
- `test/e2e-browser/helpers/fixtures.ts` — the worker `testServer` fixture now calls
  `createE2eServerHandle()`. **When `FRESHELL_E2E_TARGET_URL` is unset, behavior is
  identical to before** (verified: the whole 138-test baseline ran through this new
  code path in local mode).
- `port/oracle/t3/playwright.target.config.ts` — the oracle config: single worker,
  no fullyParallel (one shared external server must not be raced), retries 0,
  and it **excludes the 6 server-owning specs** when external (they spawn/restart
  their own local server or read the server's local FS, so they can't target a URL).
- `port/oracle/t3/global-setup.target.ts` — skips the client/server build when
  targeting external (the port is already built/running).

### Grade the Rust port (later)

```bash
# 1. build + boot the Rust freshell-server on some PORT (its own isolated home),
#    serving the UNCHANGED frontend, with a known auth token.
# 2. point the identical specs at it:
FRESHELL_E2E_TARGET_URL=http://127.0.0.1:PORT \
FRESHELL_E2E_TARGET_TOKEN=<token> \
FRESHELL_E2E_TARGET_HOME=/path/to/ports/home   # optional: enables serverInfo.homeDir specs
npx playwright test --config port/oracle/t3/playwright.target.config.ts
```

The committed `*-chromium-linux.png` snapshots are the goldens; the port's unchanged
frontend must still match them (grade on this same chromium-linux host so the
platform suffix and font rendering line up). A port run is **equivalent** iff it
reproduces the reference set above: the 122 stay green, the 6 visual baselines stay
matching, and any newly-green (previously-red) test is routed through the deviation
ledger rather than silently accepted.

### Env vars

| var | meaning |
|---|---|
| `FRESHELL_E2E_TARGET_URL` | http(s) base URL of the server to grade (enables external mode) |
| `FRESHELL_E2E_TARGET_TOKEN` | auth token the specs navigate with (`?token=…`) |
| `FRESHELL_E2E_TARGET_WS_URL` | optional ws(s) override (default: derived + `/ws`) |
| `FRESHELL_E2E_TARGET_HOME` | optional target HOME (co-located) for `serverInfo.homeDir` specs |
| `FRESHELL_E2E_TARGET_TIMEOUT_MS` | optional health-probe timeout (default 30000) |
| `FRESHELL_E2E_SKIP_BUILD` | optional: reuse existing `dist/` for a local run (oracle config) |
| `FRESHELL_E2E_RETRIES` | optional retries override (default 0) |

## Reproduce the baseline locally (ORIGINAL)

```bash
# canonical (parallel, rebuilds):
npx playwright test --config test/e2e-browser/playwright.config.ts --project=chromium --workers=4
# serial via the oracle config, reuse dist:
FRESHELL_E2E_SKIP_BUILD=1 npx playwright test --config port/oracle/t3/playwright.target.config.ts
# regenerate summary.json from the raw report:
node port/oracle/t3/gen-summary.mjs
```
