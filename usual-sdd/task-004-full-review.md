# Task 4 full review

## Requirements-compliance verdict: FAIL

## Code-quality verdict: PASS

The prior executable-source findings are closed: the four undefined
`rustFixture` references are gone; the selection guard resolves actual
Playwright projects and selection; the external-target no-stop regression is
present; and `RustServer.start()` is covered against a healthy foreign Node
provenance response. The exact Task 4 forbidden-source scan has no matches
(apart from deliberately excluded frozen evidence), and the current Chromium
listing is `460 tests in 119 files`, all labelled `[chromium]`. The existing
checkpoint-rewind skip was already the Rust-leg skip on the Task 4 parent; it
remains selected and explicitly reported, rather than being hidden by project
selection. No active retired lane/project vocabulary was found in the active
browser/Electron sources.

## Findings

### Blocker — the required full Chromium acceptance run is not passing or fully explained

- Evidence: the final receipt in `usual-sdd/task-004-full-fix-report.md`
  records `433 passed, 23 failed, 1 skipped, 3 did not run` out of 460 selected
  tests. The three not-run cases are successors of the 300-second
  `restore-contract-wall-rust.spec.ts:1982` timeout, so this was not a
  complete execution of every selected test.
- The report reproduces only five current failure identities on the Task 4
  parent (`8844e431c`): CFG-01, fresh-agent OpenCode compact,
  multi-client reconnect/PTY size, REST spawn gate drain, and truly-idle
  alerting. It expressly leaves the other 18 current failures open without a
  parent comparison. A bounded parent slice cannot establish that those 18
  failures are pre-existing or unrelated to the Task 4 migration.
- Task 4 Step 6 requires the full `npm run test:e2e -- --project=chromium`
  run to report positive counts **and PASS**. The current receipt does not
  satisfy that requirement, regardless of the source-level migration and
  focused repaired-spec passes.
- Required closure: fix the failures on this branch or establish a direct
  pre-Task-4 Rust-baseline reproduction for each remaining failure, then retain
  a complete passing Chromium receipt (with the required explicit skip still
  identified and no unexecuted successors).
