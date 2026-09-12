# Task 4 final independent review

## Requirements-compliance verdict: FAIL

## Code-quality verdict: FAIL

## Findings

### Major — stale legacy/matrix project claims remain throughout the Chromium-selected browser suite

- File/line: `test/e2e-browser/specs/cfg04-legacy-browser-seed.spec.ts:24`
- Evidence: the comment says the spec runs against a legacy Node server and an
  owned Rust server via `rustFixture`, and names the nonexistent `retired Node
  browser lane`, `Rust browser lane`, and `retired matrix list`.  The resolved
  configuration contains only `chromium` (plus opt-in continuity and CI
  firefox/webkit), and this spec's fixture at line 37 always constructs the
  Rust handle.  The same obsolete execution model remains in many Task-4
  modified files, for example `session-directory-matrix.spec.ts:106-108` and
  `restore-sync05.spec.ts:62-64`.
- Impact: this violates the required removal of stale legacy/matrix executable
  claims and makes selected E2E coverage appear to exercise a backend/project
  that no longer exists.  The new selection guard checks imports and resolved
  project names but does not protect this contract.
- Remediation: replace every retired-lane/matrix narrative with the single
  owned-Rust baseline, remove the compatibility `rustFixture` framing, and
  make the guard reject the obsolete lane/matrix vocabulary in browser/Electron
  executable test sources.

### Major — the required full Chromium pass is absent, and the 23 failures are not substantiated as unrelated

- File/line: `usual-sdd/task-004-review-fix-report.md:42`
- Evidence: the recorded complete run accounts for all 460 selected tests as
  435 passed, 23 failed, one skipped, and one not run; it is not a passing
  receipt.  The report names only CFG-01 and reproduces it on the current
  branch, not on the Task-4 parent.  CFG-01 was modified in this task
  (`cfg01-lossless-writes.spec.ts:8,168`) to use the moved fixture-support
  helper.  The other 22 failures and the skipped test are neither identified
  nor linked to a pre-Task-4 baseline.  The last sentence also says no tests
  were skipped while the preceding accounting says one was skipped.
- Impact: targeted passes for the four repaired cases cannot establish the
  required full Rust Chromium result, and the available evidence cannot
  support the assertion that every failure is out of scope.
- Remediation: retain the complete failure list and skip identity/reason;
  reproduce each failure against the Task-4 parent or fix it on this branch,
  then provide a positive full Chromium receipt before marking Task 4 complete.

### Minor — the provenance regression does not exercise a fake healthy non-Rust server through `RustServer.start()`

- File/line: `test/e2e-browser/helpers/selection-nonvacuity.test.ts:151`
- Evidence: the test calls `assertRustServerInfo({ runtime: 'node', ... })`
  directly.  `RustServer.start()` performs the actual health probe and
  `/api/server-info` fetch at `rust-server.ts:339-370`; the existing live fake
  server test covers an identity endpoint that stalls
  (`rust-server.test.ts:69-117`), not one returning healthy Node provenance.
- Impact: a future change that bypasses or alters the start-path identity
  validation could leave this unit assertion green while accepting a healthy
  non-Rust process.
- Remediation: use the occupied-port seam with a fake server returning
  `200 {ok:true}` for health and `200 {runtime:'node', commit:'...'}` for
  server-info, and assert that startup rejects/retries rather than succeeds.

### Minor — unconditional `if (true)` branches and malformed diagnostic text remain after fixture retirement

- File/line: `test/e2e-browser/specs/session-directory-matrix.spec.ts:372`
- Evidence: Task 4 replaced a Rust-kind conditional with `if (true)` while
  retaining the obsolete legacy/Rust lane explanation immediately above it.
  Separately, the corresponding restart fallback reports literal `$()` rather
  than a meaningful fixture name at `server-restart-recovery.spec.ts:100` and
  `restore-sync05.spec.ts:153`.
- Impact: these mechanical remnants obscure the single-baseline intent and
  degrade failures precisely on the external-target/no-restart path.
- Remediation: delete the redundant branches, rewrite the surrounding comments
  for the owned Rust fixture, and use a stable diagnostic such as `Owned Rust
  E2eServerHandle does not implement restart()`.
