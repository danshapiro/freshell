# Task 4 independent review

## Requirements-compliance verdict: FAIL

The owned Rust fixture, external-target no-stop implementation, shared fixture
support, GATE-01 executable removal/frozen JSON retention, and local Chromium
selection are structurally present.  However, four Chromium-selected specs now
throw before their intended assertion because the removed fixture option was
replaced with an undeclared lexical identifier.  The required full Chromium
pass also has no positive receipt.  This does not meet the Rust-only browser
E2E completion requirement.

## Code-quality verdict: FAIL

The migration left mechanical compatibility references that no longer bind at
runtime, and the new non-vacuity test does not verify actual Playwright
selection or the required external-target safety seam.

## Findings

### Blocker — undefined `rustFixture` prevents all resume-button tests from running

- File/line: `test/e2e-browser/specs/resume-button.spec.ts:227`
- Evidence: commit `0041c964` removed `e2eServerKind` from the test callback
  but changed the call to `bootResumeScenario(rustFixture)`.  No lexical
  `rustFixture` is declared in this module; `playwright --project=chromium
  --list` selects all three tests in this file.
- Impact: each selected test throws `ReferenceError` before the scenario
  boots, so the required full Chromium project cannot pass.
- Remediation: remove the obsolete parameter and call
  `bootResumeScenario()`; update its stale Node/matrix documentation.

### Blocker — undefined `rustFixture` prevents the Amplifier sidebar-resume proof from running

- File/line: `test/e2e-browser/specs/sidebar-click-resume.spec.ts:299`
- Evidence: the test callback now accepts only `{ page }`, while its first
  statement evaluates `rustFixture !== 'rust'`.  There is no declaration in
  scope, and the Chromium list selects this test.
- Impact: the Rust-only Amplifier resume assertion fails with `ReferenceError`
  instead of executing against the owned Rust server.
- Remediation: delete the obsolete skip and legacy-lane rationale; the single
  Rust fixture makes the test unconditional.

### Blocker — undefined `rustFixture` prevents both server-clock tests from running

- File/line: `test/e2e-browser/specs/harness-14-server-clock.spec.ts:202`
- Evidence: the callbacks no longer destructure `e2eServerKind`, but pass the
  undeclared `rustFixture` to `startGatedServer`.  That helper does not use its
  argument after Task 4, and both tests are selected by Chromium.
- Impact: the clock gate loses its executable Rust coverage and the full
  project fails before exercising either test.
- Remediation: make `startGatedServer()` parameterless and call it without an
  identifier; remove the retired two-backend comments.

### Blocker — undefined `rustFixture` is evaluated at the end of the TERM-13 large-cap test

- File/line: `test/e2e-browser/specs/term13-scrollback-boundary.spec.ts:319`
- Evidence: the Task 4 diff removed the fixture destructure but retained
  `void rustFixture`.  Chromium selection includes both TERM-13 tests.
- Impact: after the otherwise expensive large-cap scenario succeeds, this
  test still throws `ReferenceError`, producing a false failure and preventing
  a green full Chromium receipt.
- Remediation: delete the obsolete statement and update the comment to a
  Rust-baseline assertion.

### Major — the selection non-vacuity test permits a zero or legacy Chromium selection

- File/line: `test/e2e-browser/helpers/selection-nonvacuity.test.ts:21`
- Evidence: it counts `test(` text in source files rather than Playwright's
  resolved selection, checks invented names (`retired Node browser lane` and
  `Rust browser lane`) instead of `legacy-chromium`/`rust-chromium`, never
  inspects the fixture factory or browser helper imports, and never loads the
  opt-in `continuity-smoke` project.  For example, adding a non-matching
  `testMatch` to Chromium leaves lines 27--38 green while Playwright selects
  zero tests.
- Impact: the required floors, exact project/fixture contract, zero-legacy
  condition, and continuity registration can regress without this guard
  failing.
- Remediation: invoke/parse the owning Playwright config selection (or its
  resolved project data) for Chromium and CI projects; assert the actual
  `[chromium]` count/file floors, exact project names and ignores, continuity
  registration, no legacy helper imports, and Rust construction provenance.

### Major — the required external-target no-stop seam has no regression test

- File/line: `test/e2e-browser/helpers/external-target.ts:136`
- Evidence: `stop()` is correctly a no-op, but no current helper test imports
  `ExternalServer` or `createE2eServerHandle`; the deleted
  `test-server.test.ts` was not replaced with a test that proves an external
  PID is never signalled.
- Impact: a future refactor can turn the explicit external-target seam into a
  lifecycle owner without the Task 4 helper suite detecting it.
- Remediation: add a helper test with an external target/process sentinel that
  calls `stop()` and proves no signal or stop request reaches that target.

### Major — there is no positive full-Chromium completion receipt

- File/line: `usual-sdd/task-004-report.md:18`
- Evidence: the report says the required full `npm run test:e2e --
  --project=chromium` output was truncated and explicitly makes no final pass
  claim.  The completion addendum supplies only the four-spec focused run
  (24 passed, 1 failed) plus a one-test retry; neither executes the four
  blocker files above.
- Impact: Task 4 lacks its required full-project proof, and the static
  failures show that claiming it green would be incorrect.
- Remediation: fix the selected-spec failures, then run and retain the
  complete local Rust Chromium receipt with a positive count and Rust
  `/api/server-info` provenance for every owned worker.

### Minor — helper config still names the deleted Node test-server suite

- File/line: `test/e2e-browser/vitest.config.ts:1`
- Evidence: the comment says the helper suite is for
  `test-server.test.ts`, which Task 4 deletes.
- Impact: it contradicts the stated helper migration and can mislead future
  maintainers toward the retired browser constructor.
- Remediation: describe the Rust fixture, shared support, and selection helper
  tests instead.

## Verification evidence

- `FRESHELL_E2E_BACKEND=local npm run test:e2e:helpers --
  helpers/selection-nonvacuity.test.ts` passed: 1 file, 4 tests.  This proves
  the current guard runs, not that its selection contract is sufficient.
- `FRESHELL_E2E_BACKEND=local npm exec playwright -- test --config
  test/e2e-browser/playwright.config.ts --project=chromium --list` passed:
  460 tests in 119 files, all labelled `[chromium]`; it performs no server
  startup and no port-3001 contact.
- The required forbidden-executable scan returned no matches (excluding the
  frozen GATE-01 JSON); the deleted runner/config/collator files are absent and
  `gate01-baseline.json` remains.
- The completion report's 24/25 focused result is consistent with the cited
  resize assertion being unchanged since commit `6425ab19db`; its immediate
  one-test retry demonstrates that a pass was observed.  A single retry does
  not establish the race is eliminated, and neither receipt covers the
  failures above.
