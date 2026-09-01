# Task 4 receipt closure

## Result

Task 4 has one verified migration regression, now fixed in `7bc113e10`
(`fix: preserve worktree session grouping`). The Rust session directory now
groups a linked worktree under its common repository and serializes the
distinct checkout as `checkoutPath`. No other failure is a verified Task 4
regression.

No production process or endpoint was contacted, checked, stopped, or
restarted. All runs below used the local backend and test-owned ephemeral
servers, never port 3001.

## Verified Task 4 regression

The Task 4 source migration changed HARNESS-04 from an explicitly legacy
fixture to the owned Rust fixture. At parent `8844e431c`, the original
legacy-oriented corpus suite passed 3/3. On the Task 4 branch before the
repair, the Rust run failed `harness-04-session-corpus.spec.ts:247`:

```
worktree projectPath
expected .../repos/main-repo
received .../repos/wt-session
```

The first repair exposed the remaining missing `checkoutPath`; the final
repair covers both wire fields. Evidence:

1. Parent: `/tmp/task4-parent-harness04.log` — `3 passed (28.9s)`.
2. Current red: `/tmp/task4-current-harness04.log` — test at `:247` failed
   on `projectPath`.
3. Current green: `/tmp/task4-current-harness04-green.log` — `3 passed
   (1.1m)`.
4. `cargo test -p freshell-sessions` — passed.
5. `cargo test -p freshell-server session_directory` — `84 passed`.

## Complete current Chromium receipt

Primary command, at `7bc113e10`:

```
FRESHELL_E2E_BACKEND=local NODE_OPTIONS=--no-warnings timeout 3600 \
  npm run test:e2e -- --project=chromium --workers=2
```

Raw log: `/tmp/task4-current-full-final.log`.

The primary run selected all **460** tests and completed with:

| outcome | count |
| --- | ---: |
| passed | 434 |
| failed | 22 |
| explicit existing skip | 1 |
| not run | 3 |
| total selected | 460 |

The three not-run tests were serial successors of the five-minute
`restore-contract-wall-rust.spec.ts:1982` timeout. They were then run
individually on the same commit and all passed:

| identity | current follow-up result | log |
| --- | --- | --- |
| `restore-contract-wall-rust.spec.ts:2078` — freshclaude busy-restart | PASS | `/tmp/task4-current-restore-successor-freshclaude.log` |
| `restore-contract-wall-rust.spec.ts:2150` — double-restart mid-recovery | PASS | `/tmp/task4-current-restore-successor-double-restart.log` |
| `restore-contract-wall-rust.spec.ts:2270` — hidden-pane rebind | PASS | `/tmp/task4-current-restore-successor-hidden-pane.log` |

Thus every selected identity has a current result: **437 passed, 22 failed,
1 explicit in-test skip, 0 unexecuted = 460**. The one skip is the already
selected `agent-checkpoint-rewind.spec.ts:116` optimistic-local-echo timing
race; it was not hidden or introduced by Task 4. No tests were removed,
filtered out, or newly skipped.

## Exact failure reconciliation

`F` means the same test identity failed on the detached Task 4 parent
`8844e431c`; `P` means it passed there. All parent commands used
`FRESHELL_E2E_BACKEND=local`, `--project=rust-chromium`, one or two bounded
workers, and test-owned ports only.

| Current full-run identity | Parent | Parent evidence |
| --- | --- | --- |
| `cfg01-lossless-writes.spec.ts:377` — every REST writer preserves all sentinels; restart writes nothing | F | Prior parent Rust slice recorded in `task-004-full-fix-report.md` |
| `fresh-agent-centralization-smoke.spec.ts:401` — normalizes remote legacy layout sync before exposing server pane snapshots | F | `/tmp/task4-parent-binary-current-18.log` |
| `fresh-agent-centralization-smoke.spec.ts:447` — keeps fresh-agent settings and routes while legacy settings and routes are removed | F | `/tmp/task4-parent-binary-current-18.log` |
| `fresh-agent-control-rust.spec.ts:1691` — compact: POST summarize carries provider/model IDs exactly | F | Prior parent Rust slice recorded in `task-004-full-fix-report.md` |
| `fresh-agent.spec.ts:695` — style setting persists per Fresh Agent pane type and applies serif rendering | F | `/tmp/task4-parent-binary-current-18.log` |
| `freshopencode-db-history.spec.ts:245` — restores Freshopencode turns from DB history when export is truncated | F | `/tmp/task4-parent-binary-current-18.log` |
| `freshopencode-db-history.spec.ts:324` — does not materialize Freshopencode from DB rows without top-level run sessionID | F | `/tmp/task4-parent-binary-current-18.log` |
| `freshopencode-db-history.spec.ts:379` — repairs a persisted placeholder from a unique DB session | F | `/tmp/task4-parent-rust-db-receipt.log` (parent-Rust overlay) |
| `freshopencode-first-send-reload-repro.spec.ts:136` — keeps a submitted first prompt visible while materialization is pending | F | `/tmp/task4-parent-rust-first-send-receipt.log` (parent-Rust overlay) |
| `freshopencode-model-picker.spec.ts:256` — model selector commit persists the provider default | F | `/tmp/task4-parent-binary-current-18.log` |
| `leak-metrics.spec.ts:196` — create/send/close returns to a bounded resource baseline | P | `/tmp/task4-parent-binary-current-18.log` |
| `mobile-viewport.spec.ts:195` — permission banner buttons are visible and functional on mobile | F | `/tmp/task4-parent-binary-current-18.log` |
| `multi-client.spec.ts:237` — reconnecting viewer keeps PTY size stable and output shared | F | Prior parent Rust slice recorded in `task-004-full-fix-report.md` |
| `opencode-restart-recovery.spec.ts:628` — UI-created pane reattaches across refresh | F | `/tmp/task4-parent-binary-current-18.log` |
| `opencode-restart-recovery.spec.ts:713` — hidden session association recovers while browser is closed | F | `/tmp/task4-parent-binary-current-18.log` |
| `opencode-restart-recovery.spec.ts:901` — associated pane survives refresh | F | `/tmp/task4-parent-binary-current-18.log` |
| `opencode-restart-recovery.spec.ts:1042` — surviving panes restore after graceful restart | F | `/tmp/task4-parent-binary-current-18.log` |
| `opencode-restart-recovery.spec.ts:1051` — multiple panes restore after hard kill | F | `/tmp/task4-parent-binary-current-18.log` |
| `rest-spawn-gate-rust.spec.ts:117` — REST burst is gate-bounded and drains fully | F | Prior parent Rust slice recorded in `task-004-full-fix-report.md` |
| `restore-contract-wall-rust.spec.ts:1982` — duplicate respawn yields one PTY | F | `/tmp/task4-parent-restore-contract.log` (parent line `:2008`, same titled test) |
| `tabs-client-retire.spec.ts:113` — closed browser client is removed through unload retire API | F | `/tmp/task4-parent-binary-current-18.log` |
| `truly-idle-alerting.spec.ts:73` — Claude terminal busy/idle alert transition | F | Prior parent Rust slice recorded in `task-004-full-fix-report.md` |

The only current-only full-run failure is `leak-metrics.spec.ts:196`: it
passes in the direct parent run and Task 4 changed only its explanatory
comments, not its executed behavior. It is therefore not a verified Task 4
regression and was not altered.

The parent duplicate-PTY reproduction was deliberately rerun from the
detached worktree at exact `8844e431c`; it timed out after five minutes with
the same test title (`:2008` on the parent, `:1982` currently), establishing
the missing baseline comparison without editing the parent.

The two Freshopencode rows above use a direct Rust-baseline overlay because
their parent files constructed the legacy Node server directly. The temporary
worktree `/home/dan/code/freshell/.worktrees/task4-parent-rust` was checked
out at `8844e431c` and changed only those two specs: four replacements in
`freshopencode-db-history.spec.ts` and two in
`freshopencode-first-send-reload-repro.spec.ts`. The DB placeholder test
failed because the prompt was absent after 30 seconds; the first-send test
failed because the placeholder pane was `idle`, not `running`. Those are
the same assertions that fail on the current Rust-backed branch. The raw
receipts are `/tmp/task4-parent-rust-db-receipt.log` and
`/tmp/task4-parent-rust-first-send-receipt.log`; no temporary-worktree
process remained after the runs.

## Final accounting

The prior incomplete receipt is superseded. Its saved log ended after 337
executions without a Playwright summary. The current receipt has a final
summary, explicit selected count, and individually executed serial
successors. Of the 22 current full-run failures, 21 reproduce on parent Rust
source (19 through the expanded/mapped parent-source runs and two through the
direct six-replacement Rust overlay). One leak-metrics identity is a
run-sensitive parent pass; its executable behavior was unchanged by Task 4.
The only confirmed Task 4 regression is repaired and committed in
`7bc113e10`.
