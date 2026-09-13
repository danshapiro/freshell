# Task 3 coverage-fix report

## Changes

- Replaced the Rust-baseline browser smoke spec with five product-action scenarios:
  supported localhost HTTP proxying plus remote HTTPS loopback unavailability,
  editor context-menu/save behavior, client/server extension panels, a real
  markdown disk save and preview round trip, and the fake-provider fresh-agent
  disabled-action surface.
- Restored the supported BrowserPane refresh, activity, and localhost HTTP proxy
  suites. Only retired TCP-forward coverage was removed.
- Removed obsolete `attachmentRejection` tests and isolated diff-panel renders
  so the retained client tests are deterministic.

## Verification

- Focused Task 3 client suite: passed.
- `npm run typecheck:client`: passed.
- `npm run lint`: passed with 11 pre-existing warnings and no errors.
- Forbidden production route scan: no matches.
- `FRESHELL_E2E_BACKEND=local npm run test:e2e:local -- --workers=1 --project=rust-chromium test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts test/e2e-browser/specs/browser-pane.spec.ts`: passed, 10 tests.

All E2E servers used isolated homes and non-production ports. Port 3001 was not
contacted, restarted, or health-checked. No Task 4 files changed.
