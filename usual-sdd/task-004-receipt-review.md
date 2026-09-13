# Task 4 receipt-closure review

## Requirements-compliance verdict: FAIL

## Code-quality verdict: FAIL

## Findings

### Major — active Chromium-selected sources still claim a retired two-backend/legacy execution model

- `test/e2e-browser/specs/harness-02-matrix-bite.spec.ts:43` still names the
  selected test `Node/Rust matrix mutation negative-proof`, although its own
  implementation unconditionally asserts the owned Rust runtime.
- `test/e2e-browser/specs/harness-04-session-corpus.spec.ts:244-247` labels
  the current `[chromium]` test as `legacy-open` and `legacy server pages the
  corpus`; the actual Task 4 fixture at lines 143-155 starts
  `createE2eServerHandle()` with no legacy selection. The final full-run log
  likewise records this test under `[chromium]`.
- Further active claims remain in, for example,
  `rest-tab-persistence.spec.ts:26`, `leak-metrics.spec.ts:33,124`,
  `title-sync-convergence.spec.ts:19-20`, and
  `session-directory-matrix.spec.ts:247`. These say `both servers`, refer to
  server kinds, or name a retired Node build path.
- This violates Task 4 Step 5's required Rust-baseline comment/description
  cleanup and contradicts the closure report's claim that no active retired
  lane/project vocabulary remains. The selection guard does not catch these
  forms: it checks a narrower vocabulary and a `runs/selected ... both
  backends|server kinds|projects` pattern.

### Major — the receipt does not retain direct exact-parent evidence for all 21 reconciled failures

- `usual-sdd/task-004-receipt-closure-report.md:78-81` says all parent runs
  used the detached parent with `--project=rust-chromium`. The retained log
  cited for 15 rows, `/tmp/task4-parent-binary-current-18.log`, instead shows
  `[chromium]` and starts the current harness with
  `FRESHELL_E2E_RUST_SERVER_BIN` pointing at the detached parent's binary.
  That is useful parent-binary behavior evidence, but it is not an execution
  of the exact parent project/config/source set claimed by the report.
- The other five rows (CFG-01, fresh-agent-control, multi-client,
  rest-spawn-gate, and truly-idle) cite only the earlier prose report, not a
  retained per-identity command log. The supplied `/tmp/task4-parent-18.log`
  is incomplete and contains no final result for those identities.
- The direct detached-parent receipts for HARNESS-04 and duplicate-PTY do not
  repair this gap. Therefore the asserted `21` exact-parent reproductions are
  not fully demonstrated by the retained evidence, even though the final
  current accounting itself reconciles to `437 passed + 22 failed + 1 explicit
  skip + 0 unexecuted = 460` and the three serial successors have focused
  passing logs.

### Major — Task 4's comment cleanup left misleading and syntactically broken prose in selected test sources

- `harness-04-session-corpus.spec.ts:17-21` begins a dangling paragraph after
  the Leg A description; the removed Leg B heading/subject is missing.
- `rest-tab-persistence.spec.ts:33-35` leaves a `KNOWN DIVERGENCE` sentence
  without its subject, and `title-sync-convergence.spec.ts:13,19-20` leaves
  dangling fragments about a Node regression control and server kinds.
- `leak-metrics.spec.ts:26,123-129` similarly leaves `fixture):` and partial
  legacy-only PTY-reap citations. These are Task 4-modified active sources,
  not frozen evidence, and make the one-Rust-baseline contract materially
  harder to read and maintain.
