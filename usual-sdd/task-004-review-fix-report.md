# Task 4 review fix report

## Scope completed

- Removed the four undeclared `rustFixture` references from the repaired browser specs.  Their setup helpers and assertions now describe and exercise the sole Rust baseline unconditionally.
- Removed obsolete legacy/matrix commentary from those specs.
- Replaced the source-text selection guard with resolved Playwright-config and `playwright test --list` checks.  It verifies the real Chromium/CI/continuity selections, exact continuity exclusion, no retired projects or legacy helper imports, selection floors, cloud skip integrity, local-only MCP QA classification, and Rust provenance rejection.
- Added an `ExternalServer` lifecycle regression proving `stop()` cannot signal or stop an explicitly supplied external PID.
- Corrected the stale browser Vitest configuration comment.

## Verification

The red test before the repair was:

```bash
FRESHELL_E2E_BACKEND=local npm run test:e2e -- --project=chromium \
  test/e2e-browser/specs/resume-button.spec.ts --workers=1
```

It failed all three resume-button cases with `ReferenceError: rustFixture is not defined`.

The repaired focused checks passed:

```bash
FRESHELL_E2E_BACKEND=local NODE_OPTIONS=--no-warnings npm run test:e2e:helpers -- \
  helpers/selection-nonvacuity.test.ts helpers/external-target.test.ts
# 2 files passed, 5 tests passed

FRESHELL_E2E_BACKEND=local NODE_OPTIONS=--no-warnings npm exec playwright -- test \
  --config test/e2e-browser/playwright.config.ts --project=chromium --list
# Total: 460 tests in 119 files

FRESHELL_E2E_BACKEND=local NODE_OPTIONS=--no-warnings timeout 900 npm run test:e2e -- \
  --project=chromium --workers=1 \
  test/e2e-browser/specs/resume-button.spec.ts \
  test/e2e-browser/specs/sidebar-click-resume.spec.ts \
  test/e2e-browser/specs/harness-14-server-clock.spec.ts \
  test/e2e-browser/specs/term13-scrollback-boundary.spec.ts
# 10 passed (1.3m)
```

The required complete local Chromium run was also executed with `FRESHELL_E2E_BACKEND=local` and `--workers=2`.  It ran all 460 selected tests and the repaired Task 4 cases passed in that run, but it did not yield a positive whole-suite receipt: 435 passed, 23 unrelated failures, 1 skipped, and 1 did not run (24.8m).  A serial retry reproduced the first failure, CFG-01 lossless config writes, before any Task 4-owned case; the retry was stopped rather than spending a complete serial pass on deterministic, out-of-scope failures.  No tests were skipped or hidden.

No request was made to, nor did this work contact, restart, or health-check port 3001.  The only servers stopped during cleanup were verified ephemeral Rust test processes from this worktree.
