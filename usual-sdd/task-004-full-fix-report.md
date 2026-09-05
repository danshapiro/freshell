# Task 4 full-fix report

## Scope and result

This follow-up fixes the concrete executable-source findings from the final
review.  It does **not** claim a green full Chromium suite: the final local
receipt is `433 passed, 23 failed, 1 skipped, 3 did not run` (460 selected).
The three failures caused by this follow-up's initial comment cleanup were
identified and fixed before that receipt was taken.

The work is in two commits:

- `60c0ceb5c test: harden Rust browser E2E guard`
- `dd2515af1 test: repair Rust baseline comments`

No process on port 3001 was contacted, health-checked, stopped, or restarted.
All browser fixtures used owned ephemeral ports.

## Executable-source corrections

- Browser and Electron executable test sources now describe one owned Rust
  baseline.  The compatibility `rustFixture` type/fixture was removed rather
  than retained as a compatibility layer.
- Retired lane/project prose and both-backend claims were removed from the
  active browser/Electron source set.  Frozen evidence such as
  `gate01-baseline.json` was intentionally not rewritten.
- `selection-nonvacuity.test.ts` scans both active source roots and rejects the
  retired vocabulary and a claim that selected tests run against both
  backends.  The terms are assembled in the guard so the guard does not match
  its own source.
- The selected Rust assertions are direct and unconditional; the mechanical
  `if (true)` branches are gone.  Restart fallbacks now use stable owned-fixture
  diagnostics rather than literal shell-looking text.
- `rust-server.test.ts` now binds a fake healthy HTTP server to port `0`, has it
  return healthy status plus `{ runtime: 'node' }`, injects that occupied port
  into `RustServer`, and proves `RustServer.start()` rejects it.  This covers
  the real start-path provenance probe, not only the assertion helper.

The first full run after `60c0ceb5c` exposed three failures in
`tabs-registry-persistence-rust.spec.ts`: a bulk comment edit had swallowed
the `connectAndHello` helper declaration.  `dd2515af1` restored the two comment
closures and rewrote the affected header for the owned Rust baseline.  The
focused spec then passed all three tests.

## Verification

Commands and receipts:

1. `NODE_OPTIONS=--no-warnings timeout 180 npm exec playwright -- test --config test/e2e-browser/playwright.config.ts --project=chromium --list`
   - `Total: 460 tests in 119 files`.
2. `FRESHELL_E2E_BACKEND=local NODE_OPTIONS=--no-warnings timeout 240 npm run test:e2e:helpers -- helpers/selection-nonvacuity.test.ts helpers/rust-server.test.ts`
   - `8 passed` (including the healthy foreign-server start-path regression).
3. `FRESHELL_E2E_BACKEND=local NODE_OPTIONS=--no-warnings timeout 180 npm exec playwright -- test --config test/e2e-browser/playwright.config.ts --project=chromium --workers=1 test/e2e-browser/specs/tabs-registry-persistence-rust.spec.ts`
   - `3 passed` after the comment-closure repair.
4. Final full local receipt:
   `FRESHELL_E2E_BACKEND=local NODE_OPTIONS=--no-warnings timeout 2700 npm run test:e2e -- --project=chromium --workers=2`
   - `23 failed, 1 skipped, 3 did not run, 433 passed (24.9m)`.

The full-suite accounting reconciles exactly: `433 + 23 + 1 + 3 = 460`.
Full pass was **not** achieved; no test was hidden or newly skipped.

## Full Chromium receipt: failures

1. `cfg01-lossless-writes.spec.ts:377` — every REST writer preserves all sentinels; restart writes nothing.
2. `fresh-agent-centralization-smoke.spec.ts:401` — normalizes remote legacy layout sync before exposing server pane snapshots.
3. `fresh-agent-centralization-smoke.spec.ts:447` — keeps fresh-agent settings and routes while legacy settings and routes are removed.
4. `fresh-agent-control-rust.spec.ts:1691` — compact summarize carries provider/model IDs exactly.
5. `fresh-agent.spec.ts:695` — serif style setting persists per fresh-agent pane type.
6. `freshopencode-db-history.spec.ts:245` — restores Freshopencode turns from DB history when export is truncated.
7. `freshopencode-db-history.spec.ts:324` — does not materialize from DB rows without a top-level run session ID.
8. `freshopencode-db-history.spec.ts:379` — repairs a persisted placeholder from a unique DB session.
9. `freshopencode-first-send-reload-repro.spec.ts:136` — keeps a submitted first prompt visible while materialization is pending.
10. `freshopencode-model-picker.spec.ts:256` — model selector commit persists the provider default.
11. `harness-04-session-corpus.spec.ts:247` — corpus paging has exact manifest semantics.
12. `leak-metrics.spec.ts:196` — create/send/close returns to bounded resources.
13. `mobile-viewport.spec.ts:195` — mobile permission banner buttons are visible and functional.
14. `multi-client.spec.ts:237` — reconnecting viewer keeps PTY size stable and output shared.
15. `opencode-restart-recovery.spec.ts:628` — UI-created pane reattaches across refresh.
16. `opencode-restart-recovery.spec.ts:713` — hidden session association recovers while browser is closed.
17. `opencode-restart-recovery.spec.ts:901` — associated pane survives refresh.
18. `opencode-restart-recovery.spec.ts:1042` — surviving panes restore after graceful restart.
19. `opencode-restart-recovery.spec.ts:1051` — multiple panes restore after hard kill.
20. `rest-spawn-gate-rust.spec.ts:117` — REST burst is gate-bounded and drains fully.
21. `restore-contract-wall-rust.spec.ts:1982` — duplicate respawn yields one PTY.
22. `tabs-client-retire.spec.ts:113` — closed browser client is removed through unload retire API.
23. `truly-idle-alerting.spec.ts:73` — Claude terminal busy/idle alert transition.

The one skipped test is `agent-checkpoint-rewind.spec.ts:116`; its existing
in-test reason is the frozen optimistic-local-echo timing race around the
Rewind interaction.  The three not-run tests are the serial successors of the
300-second `restore-contract-wall-rust.spec.ts:1982` timeout:

- `restore-contract-wall-rust.spec.ts:2078` — freshclaude busy-restart.
- `restore-contract-wall-rust.spec.ts:2150` — double-restart mid-recovery.
- `restore-contract-wall-rust.spec.ts:2270` — hidden-pane rebind.

## Parent comparison

The Task 4 parent is `8844e431c`.  A detached parent worktree was used and
removed after the run.  It ran the 16 files that contain the current receipt's
failures under the parent's `rust-chromium` project:

`FRESHELL_E2E_BACKEND=local NODE_OPTIONS=--no-warnings timeout 2700 npm exec playwright -- test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --workers=2 <16 failure-bearing files>`

That parent run produced `36 passed, 14 failed, 1 did not run` (51 tests).
It reproduces these current failure identities on the parent Rust baseline:

- CFG-01 lossless config write (same `completedMigrations` drift);
- fresh-agent OpenCode compact provider/model assertion;
- multi-client reconnect/PTY-size assertion;
- REST spawn gate drain assertion (`1` pane observed where `16` required);
- truly-idle alerting assertion.

The parent run also has several independent restore-contract and multi-client
failures not present in the final 460-test receipt.  Thus it is evidence of a
pre-existing unstable/failing Rust test baseline, not evidence that all
remaining current failures are harmless.  The 18 full-receipt failures not
identically reproduced by that bounded parent slice remain explicitly open;
this report does not label them unrelated without direct proof.

The only newly introduced regressions found during this follow-up were the
three swallowed-helper failures described above, and they are fixed and
focused-green.  Task 5 files were not changed.
