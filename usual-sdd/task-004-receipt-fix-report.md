# Task 4 receipt and narrative follow-up

## Scope

Commit `1dd2e5450` removes the remaining active browser-suite descriptions of
retired backend lanes and strengthens the selection guard. It changes no
fixture behavior. The commit contains active sources only; raw receipts remain
under `/tmp/task4-parent-receipts` and are not committed.

The detached parent used for this report was
`/home/dan/code/freshell/.worktrees/task4-parent-receipts`, at exactly
`8844e431cb8eebdcf0a85c92efcbc0718fc48107`. It was clean before execution.
All test servers used parent-source, isolated test homes and ephemeral ports.
No command contacted, health-checked, stopped, or restarted port 3001.

## Browser-source cleanup

- Rewrote every discovered selected-spec claim that browser coverage runs on
  two server implementations, server kinds, legacy-open semantics, or a
  retired Node build path. This includes the review-named HARNESS-02,
  HARNESS-04, REST persistence, leak metrics, title convergence, and session
  directory specs, plus the other selected sources returned by the broad scan.
- Repaired dangling and mechanically truncated comments in HARNESS-04,
  REST persistence, leak metrics, title convergence, session directory, CFG-03,
  the checkpoint skip explanation, and the OpenCode rail spec. The existing
  explicit checkpoint in-test skip remains an explicit in-test skip.
- `selection-nonvacuity.test.ts` now scans executable browser specs and
  Electron tests for retired lane/build narratives: both server/back-end
  claims, server kinds, legacy-open, Node/Rust forms, retired lane/project/list
  terms, `dist/server/index`, and the former browser helper path. It leaves
  generic data-migration and retained MCP-client language outside that narrow
  execution-narrative vocabulary.

The final scan was:

```bash
rg -n -i -e 'both (servers|backends)|server kinds?|legacy[- ]open|node/rust|rust/node|retired (node|matrix|browser lane)|matrix (list|lane|mutation)|dist/server/index|helpers/test-server\\.ts|if \\(true\\)|fixture\\):|\\$\\(\\)' \
  test/e2e-browser/specs test/e2e-electron --glob '!gate01-baseline.json'
```

It returned no matches.

## Verification

| Command | Result | Raw log |
| --- | --- | --- |
| `npm run test:e2e:helpers -- helpers/selection-nonvacuity.test.ts` | PASS: 4 tests | `/tmp/task4-selection-nonvacuity-green-3.log` |
| Chromium selection list | PASS: 460 tests in 119 files | `/tmp/task4-current-chromium-list-after-narrative-cleanup.log` |
| Six review-named changed specs under Chromium, one worker | PASS: 20 tests | `/tmp/task4-changed-specs-focused.log` |

The focused command was:

```bash
FRESHELL_E2E_BACKEND=local NODE_OPTIONS=--no-warnings timeout 900 \
  npm exec playwright -- test --config test/e2e-browser/playwright.config.ts \
  --project=chromium --workers=1 \
  test/e2e-browser/specs/harness-02-matrix-bite.spec.ts \
  test/e2e-browser/specs/harness-04-session-corpus.spec.ts \
  test/e2e-browser/specs/rest-tab-persistence.spec.ts \
  test/e2e-browser/specs/leak-metrics.spec.ts \
  test/e2e-browser/specs/title-sync-convergence.spec.ts \
  test/e2e-browser/specs/session-directory-matrix.spec.ts
```

## Parent receipt method and limits

The parent’s real `rust-chromium` project is a narrow `MATRIX_SPECS` selector.
For example, it ran CFG-01 and failed, but it selected zero
`fresh-agent-centralization-smoke` tests. Those direct logs are retained as
`cfg01-lossless-writes.log` and `fresh-agent-centralization-smoke.log`.

To execute parent *source* for every current failure-bearing file, I used the
external, untracked `/tmp/task4-parent-receipts.config.ts`. It imports the
parent config, uses the parent `chromium` fixture with its parent
`e2eServerKind: 'rust'`, and removes that project’s narrow `testIgnore`. It is
not the parent’s original project selection, so its results below are called
**parent-source mapped receipts**, never exact parent-project reproductions.
Every invocation had this form (one test per raw log):

```bash
FRESHELL_E2E_BACKEND=local NODE_PATH=/home/dan/code/freshell/node_modules \
  NODE_OPTIONS=--no-warnings timeout 420 npm exec playwright -- test \
  --config /tmp/task4-parent-receipts.config.ts --project=chromium --workers=1 \
  <parent spec> -g <parent title fragment>
```

`/tmp/run-task4-parent-receipts.sh` contains the current-title probes and
`/tmp/run-task4-parent-mapped-receipts.sh` contains every title mapping. Each
raw log appends its final shell exit status. The parent title inventory is
`/tmp/task4-parent-receipts/parent-title-mapping-list.log`.

The two direct-constructor migrations that initially had only Node-backed
parent probes were also run against a behavior-equivalent Rust parent
baseline. The temporary worktree
`/home/dan/code/freshell/.worktrees/task4-parent-rust` was checked out at
`8844e431cb8eebdcf0a85c92efcbc0718fc48107`; its only tracked changes were the
same six import/constructor replacements in the two Freshopencode specs. The
tests were run separately with `npm run test:e2e:chromium -- --workers=1).
Both failed at the same assertions as the current Rust-backed tests:

- DB placeholder repair: prompt text absent after 30 seconds (exit 1);
- first-send reload: the placeholder pane was `idle`, not `running`
  (exit 1).

The raw receipts are
`/tmp/task4-parent-rust-db-receipt.log` and
`/tmp/task4-parent-rust-first-send-receipt.log`. This is direct
parent-source Rust evidence, not a Node-server result.

## All 22 current full-run failure identities

Current status is `F` for every row from
`/tmp/task4-current-full-final.log`; that complete current receipt is
`437 passed + 22 failed + 1 existing explicit skip = 460`. `Parent` is a run
of parent source. `mapped` means the parent title differed, so it is behavior
evidence only and **not** an assertion of exact identity reproduction.
`Parent-Rust overlay` means the parent commit was run with only the same
six direct fixture replacements, so it is the behavior-equivalent Rust
baseline for those two migrations.

| Current failure identity | Parent result | Receipt |
| --- | --- | --- |
| CFG-01 lossless writes | F, exact parent `rust-chromium` selection | `cfg01-lossless-writes.log` |
| fresh-agent centralization: normalizes remote sync | F, exact title, expanded parent source | `fresh-agent-centralization-expanded.log` |
| fresh-agent centralization: keeps fresh settings/routes | F, exact title, expanded parent source | `fresh-agent-centralization-expanded.log` |
| fresh-agent control compact summarize | F, mapped parent title | `mapped-fresh-agent-control.log` |
| fresh-agent serif style | F, exact title, expanded parent source | `fresh-agent-style.log` |
| Freshopencode DB restore | F, exact title, expanded parent source | `freshopencode-db-restore.log` |
| Freshopencode DB lacks top-level run id | F, exact title, expanded parent source | `freshopencode-db-no-top-level.log` |
| Freshopencode DB placeholder repair | F, parent-Rust overlay | `task4-parent-rust-db-receipt.log` |
| Freshopencode first-send reload | F, parent-Rust overlay | `task4-parent-rust-first-send-receipt.log` |
| Freshopencode model picker | F, mapped parent title | `mapped-freshopencode-model-picker.log` |
| leak metrics bounded baseline | P, mapped parent title | `mapped-leak-metrics.log` |
| mobile permission banner | F, exact title, expanded parent source | `mobile-viewport.log` |
| multi-client reconnect/PTY size | F, mapped parent title | `mapped-multi-client.log` |
| OpenCode UI-created refresh | F, mapped parent title | `mapped-opencode-ui-created.log` |
| OpenCode hidden association | F, mapped parent title | `mapped-opencode-hidden.log` |
| OpenCode associated-pane refresh | F, mapped parent title | `mapped-opencode-associated.log` |
| OpenCode graceful restart | F, mapped parent title | `mapped-opencode-graceful.log` |
| OpenCode hard-kill restart | F, mapped parent title | `mapped-opencode-hard-kill.log` |
| REST spawn gate | F, mapped parent title | `mapped-rest-spawn-gate.log` |
| restore-contract duplicate PTY | F, mapped parent title; parent took 5.0m | `mapped-restore-contract.log` |
| tabs unload-retire | F, exact title, expanded parent source | `mapped-tabs-client-retire.log` |
| truly-idle alert transition | F, mapped parent title | `mapped-truly-idle-blue-while-busy.log` |

The direct current-title probes that returned `No tests found` are retained
too. They establish that a renamed parent test cannot be presented as an exact
same-title reproduction; see, for example,
`freshopencode-db-repair.log`, `leak-metrics.log`, and
`opencode-restart-ui-created.log`. The two Freshopencode rows above are
instead backed by the direct parent-Rust overlay receipts.

The leak result deserves special care: it failed in the recorded full current
run, passed in this current focused 20-test run, and passed in the parent-source
mapped run. That is evidence of run sensitivity, not evidence of a Task 4
execution change, and this report makes no causal claim. With the two
Freshopencode overlays added above, the parent accounting is 21 failing
identities and one run-sensitive pass.

## Parent cleanup

After retaining the logs, I verified and stopped the remaining exact
parent-worktree test server PID `998619` and its child sidecar exited with it.
The detached worktree itself was clean and had no remaining process at this
point. It was removed with `git worktree remove`; the saved
`/tmp/task4-parent-receipts` logs remain available.
