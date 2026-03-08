# Unified Broad One-Shot Test Run Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Keep this unified; do not split it into phased partial measures.

**Goal:** Build one crash-safe `BroadOneShotTestRun` path that serializes only broad one-shot test workloads, reports truthful holder status, and reuses only exact matching reusable baselines without weakening any existing command contract.

**Architecture:** Every test entrypoint classifies into exactly one of two outcomes: `delegate upstream` or `gated broad run`. `delegate upstream` covers watch, UI, explicit file-targeted, and other non-broad invocations and never touches the gate, holder, or reuse cache. `gated broad run` routes through a single `BroadOneShotTestRun` primitive that discovers repo state from the caller’s checkout, acquires a repo-shared `flock`, writes advisory holder metadata atomically, optionally consults reusable baselines keyed by `suiteKey`, then executes the actual workload. Raw `vitest` interception is implemented as one more adapter via a small `patch-package` patch to `node_modules/vitest/vitest.mjs`, with an explicit non-recursive upstream delegation env var.

**Tech Stack:** Node.js, TypeScript, `tsx`, npm scripts, `child_process`, `fs/promises`, Git CLI, Linux/WSL `flock`, `patch-package`, Vitest 3.

---

## Frozen Invariants

- `BroadOneShotTestRun` is the only primitive. Public npm scripts and patched raw `vitest` must both route through it for gated broad work.
- Classification is total and binary. Every entrypoint must end as exactly one of:
  - `delegate upstream`
  - `gated broad run`
- `delegate upstream` means no lock, no holder metadata, no baseline reuse, no status side effects.
- `gated broad run` means the process goes through `BroadOneShotTestRun`, acquires the repo-wide `flock`, writes holder metadata, and may consult reusable baselines only if the suite is fully classified.
- `flock` is the only liveness truth. No in-memory coordinator, pid table, or holder file may be treated as proof that a run is live.
- Holder metadata is advisory only. Missing, corrupt, stale, or partial holder data must never block progress and must never be treated as truth over the lock probe.
- Status is a small explicit state machine driven by lock first, metadata second:
  - `idle`: non-blocking probe acquires the lock, then releases it immediately. Ignore any holder file.
  - `running-described`: probe sees the lock is held and holder metadata parses with all required fields.
  - `running-undescribed`: probe sees the lock is held but holder metadata is missing, corrupt, unreadable, or missing required fields.
- Holder writes must be atomic: write to a temp file in the same directory, `fsync` the temp file, rename over the destination, then best-effort `fsync` the directory. Reads must schema-validate and degrade to `running-undescribed` on any failure.
- Repo discovery must not rely on `process.cwd()` alone. Use the caller’s invocation cwd (`INIT_CWD` when present, otherwise `process.cwd()`), then resolve checkout root and git common-dir from Git.
- Broad vs narrow is frozen as:
  - Narrow: watch mode, UI mode, explicit file-targeted runs where every positional selector is a file path and no known broad suite-shaping flag is present.
  - Broad: any non-interactive one-shot run with no selectors, any directory target, any glob target, any config/project/dir selector, any test-name pattern, `--changed`, `--exclude`, `--environment`, `--coverage`, `--shard`, or any other suite-shaping selector.
- Unknown broad suite-shaping flags are never reusable. They may still run as gated broad work, but reuse must be disabled instead of guessed.
- `suiteKey` identifies the reusable workload. `commandKey` is provenance and UX only. `test` and `test:all` may share a `suiteKey` if they truly run the same workload.
- Reusable baseline identity is exact: newest record matching `(suiteKey, commit, cleanWorktree=true, nodeVersion, platform)` controls reuse. If the newest exact record is a failure, no older success for that same identity may be reused.
- `check` and `verify` may not silently weaken their contracts. If reuse is enabled for them, it must apply only to an exact prior success of the whole command workload, not just the inner Vitest phase.
- Whole-command early exit is forbidden unless the plan explicitly defines the full workload identity and proves it remains equivalent. This plan does so for `check` and `verify` by giving them distinct whole-workload `suiteKey`s.
- Raw `vitest` interception must have a non-recursive upstream path. The patch must set a dedicated env marker before handing off to upstream Vitest so the patched entrypoint can bypass its own gate logic on the second hop.
- Portability must not be overstated. Supported gated execution is Linux/WSL/bash where `flock` exists. If `flock` is unavailable, broad runs fail fast with an actionable message instead of falling back to a weaker scheme.
- Summary metadata support is in scope only through explicitly specified mechanisms:
  - `FRESHELL_TEST_SUMMARY`
  - `BroadOneShotTestRun --summary <text>`
  - Explicit `--summary` takes precedence over the env var; otherwise the adapter provides a default summary.

## File Structure

**Modify**

- `package.json`
  - Repoint broad one-shot scripts through `BroadOneShotTestRun`.
  - Normalize `test:server` to one-shot semantics.
  - Add an explicit watch alias for server tests.
  - Add `test:status`.
  - Add `patch-package` install hook.
- `package-lock.json`
  - Record the `patch-package` dependency and script changes.
- `server/coding-cli/utils.ts`
  - Add shared git common-dir resolution and any small invocation-cwd helpers needed by the runner.
- `test/unit/server/coding-cli/utils.test.ts`
  - Cover worktree-aware repo/common-dir discovery.

**Create**

- `scripts/testing/broad-one-shot-test-run.ts`
  - The only primitive: parse adapter inputs, classify, probe status, acquire/release the lock, write holder metadata, consult baselines, run upstream work, persist results.
- `scripts/testing/test-run-classification.ts`
  - Exact broad-vs-narrow rules and raw Vitest argv normalization.
- `scripts/testing/test-run-gate-state.ts`
  - Lock path resolution, `flock` helpers, holder state machine, atomic holder read/write/delete.
- `scripts/testing/test-run-baselines.ts`
  - `suiteKey` generation, results store, exact reuse lookup, latest-result-wins logic.
- `scripts/testing/test-run-adapters.ts`
  - Public command manifest, stable `commandKey` naming, whole-workload `suiteKey`s, default summaries, upstream argv/phase definitions.
- `scripts/testing/test-run-upstream.ts`
  - Non-recursive spawning helpers for npm/Vitest/upstream child processes and env shaping.
- `patches/vitest+3.2.4.patch`
  - Patch `node_modules/vitest/vitest.mjs` so raw `vitest` invocations enter the same adapter path.
- `test/fixtures/test-run-gate/fake-upstream.ts`
  - Small controllable Node fixture used by integration tests to simulate success, failure, delay, and env capture without running the real broad suite.
- `test/unit/server/test-run-classification.test.ts`
- `test/unit/server/test-run-gate-state.test.ts`
- `test/unit/server/test-run-baselines.test.ts`
- `test/unit/server/test-run-adapters.test.ts`
- `test/integration/server/broad-one-shot-test-run.test.ts`
- `test/integration/server/vitest-patch-adapter.test.ts`

## Task 1: Classification And Delegation

**Files:**

- Modify: `server/coding-cli/utils.ts`
- Modify: `test/unit/server/coding-cli/utils.test.ts`
- Create: `scripts/testing/test-run-classification.ts`
- Create: `test/unit/server/test-run-classification.test.ts`

- [ ] **Step 1: Write the failing classification and repo-discovery tests**

  Cover:
  - `resolveGitCommonDir()` returns the shared `.git` directory for linked worktrees.
  - Invocation cwd comes from `INIT_CWD` when present, then falls back to `process.cwd()`.
  - Raw `vitest` classification returns `delegate upstream` for:
    - `vitest`
    - `vitest --ui`
    - `vitest path/to/file.test.ts`
    - `vitest run path/to/file.test.ts`
  - Raw `vitest` classification returns `gated broad run` for:
    - `vitest run`
    - `vitest run test/unit`
    - `vitest run "test/**/*.test.ts"`
    - `vitest run --config vitest.server.config.ts test/server`
    - `vitest run -t "name"`
    - `vitest run --changed`
  - Unknown suite-shaping flags classify as broad but mark reuse disabled.

- [ ] **Step 2: Run only the targeted tests and verify they fail for the missing helpers**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run test/unit/server/coding-cli/utils.test.ts test/unit/server/test-run-classification.test.ts
  ```

  Expected:
  - FAIL for missing `resolveGitCommonDir()`
  - FAIL for missing classification module and exact broad/narrow rules

- [ ] **Step 3: Implement repo discovery and classification**

  Implement:
  - `resolveGitCommonDir(cwd)` using `git -C <checkoutRoot> rev-parse --git-common-dir`
  - `resolveInvocationCwd()` using `INIT_CWD ?? process.cwd()`
  - `classifyVitestInvocation(argv, cwd)` returning a discriminated union with:
    - `kind: 'delegate-upstream'`
    - `kind: 'gated-broad-run'`
  - Explicit broad/narrow logic exactly matching the frozen invariant above
  - Raw broad results that include:
    - normalized positional selectors
    - `baselineReusable: boolean`
    - `unknownSuiteFlags: string[]`

- [ ] **Step 4: Re-run the targeted tests and verify pass**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run test/unit/server/coding-cli/utils.test.ts test/unit/server/test-run-classification.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit the classification foundation**

  ```bash
  git -C /home/user/code/freshell/.worktrees/test-run-gate add \
    package.json package-lock.json \
    server/coding-cli/utils.ts \
    test/unit/server/coding-cli/utils.test.ts \
    scripts/testing/test-run-classification.ts \
    test/unit/server/test-run-classification.test.ts
  git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): classify broad test runs"
  ```

## Task 2: Gate And Status State Machine

**Files:**

- Create: `scripts/testing/test-run-gate-state.ts`
- Create: `test/unit/server/test-run-gate-state.test.ts`
- Create: `test/integration/server/broad-one-shot-test-run.test.ts`

- [ ] **Step 1: Write the failing lock and holder state tests**

  Cover:
  - Gate paths are rooted at `resolveGitCommonDir(invocationCwd)`.
  - Non-blocking `flock` probe returning success produces `idle` even if `holder.json` exists.
  - Held lock plus valid holder metadata produces `running-described`.
  - Held lock plus missing holder file produces `running-undescribed`.
  - Held lock plus corrupt JSON produces `running-undescribed`.
  - Held lock plus partial JSON missing required fields produces `running-undescribed`.
  - Holder writes use temp-file-then-rename behavior in the same directory.
  - Holder delete failures do not suppress lock release.

- [ ] **Step 2: Add one integration test around real `flock` behavior using the fake upstream fixture**

  Simulate:
  - Process A acquires the gate and sleeps.
  - Process B calls `test:status` and sees `running-described`.
  - Process C attempts another broad run and waits or exits according to the chosen CLI contract, but does not create a second holder.
  - After Process A exits without explicit cleanup, a fresh status probe returns `idle` even if the old holder file still exists.

- [ ] **Step 3: Implement the gate state module**

  Implement:
  - `buildGatePaths(commonDir)` returning:
    - lock file
    - holder file
    - results file
  - `probeBroadRunStatus()`:
    - try non-blocking `flock`
    - if acquired: release immediately and return `idle`
    - if blocked: attempt holder read and schema validation
    - return `running-described` or `running-undescribed`
  - `writeHolderAtomically()` using temp file, `fsync`, rename, best-effort dir `fsync`
  - `readHolderAdvisory()` returning parsed metadata or a typed failure reason
  - `removeHolderIfPresent()` as best-effort cleanup while still holding the lock

- [ ] **Step 4: Re-run the targeted state tests**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run test/unit/server/test-run-gate-state.test.ts test/integration/server/broad-one-shot-test-run.test.ts
  ```

  Expected: PASS without invoking the real full suite.

- [ ] **Step 5: Commit the state machine**

  ```bash
  git -C /home/user/code/freshell/.worktrees/test-run-gate add \
    scripts/testing/test-run-gate-state.ts \
    test/unit/server/test-run-gate-state.test.ts \
    test/integration/server/broad-one-shot-test-run.test.ts
  git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add broad run gate state machine"
  ```

## Task 3: Suite Identity And Reuse Rules

**Files:**

- Create: `scripts/testing/test-run-baselines.ts`
- Create: `test/unit/server/test-run-baselines.test.ts`

- [ ] **Step 1: Write the failing baseline and suite identity tests**

  Cover:
  - `suiteKey` identity ignores `commandKey`.
  - `test` and `test:all` share a `suiteKey` only because they run the same workload.
  - `check` has a distinct whole-workload `suiteKey`.
  - `verify` has a distinct whole-workload `suiteKey`.
  - Raw broad `suiteKey` includes all classified suite-shaping selectors.
  - Raw broad `suiteKey` excludes non-suite UX flags such as reporter/color/output formatting.
  - Unknown suite-shaping flags force `baselineReusable=false`.
  - Reuse requires:
    - exact `suiteKey`
    - exact commit
    - producer clean worktree
    - current clean worktree
    - exact node version
    - exact platform
    - prior exit code `0`
  - Newest exact failure blocks reuse of older exact success.
  - Corrupt or unreadable results file degrades to “no reusable baseline”.

- [ ] **Step 2: Run the targeted baseline tests and verify failure**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run test/unit/server/test-run-baselines.test.ts
  ```

  Expected: FAIL for missing baseline store and exact identity logic.

- [ ] **Step 3: Implement suite keys and results handling**

  Implement:
  - Stable results record schema including:
    - `suiteKey`
    - `commandKey`
    - `summary`
    - `commit`
    - `cleanWorktree`
    - `nodeVersion`
    - `platform`
    - `startedAt`
    - `finishedAt`
    - `exitCode`
  - Results persistence as a bounded newest-first array written atomically through temp-file-then-rename.
  - `findReusableBaseline()` that selects only the newest exact identity record and rejects older successes after a newer failure.
  - Raw Vitest `suiteKey` normalization from the full classified broad arg model.

- [ ] **Step 4: Re-run the baseline tests and verify pass**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run test/unit/server/test-run-baselines.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit the reuse rules**

  ```bash
  git -C /home/user/code/freshell/.worktrees/test-run-gate add \
    scripts/testing/test-run-baselines.ts \
    test/unit/server/test-run-baselines.test.ts
  git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add exact reusable baseline rules"
  ```

## Task 4: Command Adapters And Naming

**Files:**

- Create: `scripts/testing/test-run-adapters.ts`
- Create: `scripts/testing/test-run-upstream.ts`
- Create: `scripts/testing/broad-one-shot-test-run.ts`
- Create: `test/unit/server/test-run-adapters.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing adapter tests**

  Cover:
  - Public commands map to exactly one classification outcome.
  - `test`, `test:all`, `test:coverage`, `test:unit`, `test:integration`, `test:client`, `test:server`, `check`, and `verify` are `gated broad run`.
  - `test:watch`, `test:ui`, and `test:server:watch` are `delegate upstream`.
  - `test:server` is renamed to one-shot server-suite semantics.
  - `check` and `verify` reuse decisions apply to the whole command suite, not to isolated inner phases.
  - Adapter-provided default summaries are stable.
  - `--summary` overrides `FRESHELL_TEST_SUMMARY`.

- [ ] **Step 2: Update the package script surface in the tests before implementation**

  Expected target script mapping:

  ```json
  {
    "test": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test",
    "test:all": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:all",
    "test:coverage": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:coverage",
    "test:unit": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:unit",
    "test:integration": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:integration",
    "test:client": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:client",
    "test:server": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:server",
    "test:server:watch": "vitest --config vitest.server.config.ts",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "check": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter check",
    "verify": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter verify",
    "test:status": "tsx scripts/testing/broad-one-shot-test-run.ts --status"
  }
  ```

- [ ] **Step 3: Implement the adapters and the single primitive**

  Implement:
  - Public adapter manifest with stable `commandKey`, `suiteKey`, default summary, and upstream phases.
  - Whole-workload suites:
    - `suiteKey: "vitest-all"` for `test` and `test:all`
    - `suiteKey: "check"` for `check`
    - `suiteKey: "verify"` for `verify`
  - `BroadOneShotTestRun` CLI behavior:
    - `--status`
    - `--adapter <name>`
    - `--summary <text>`
    - `--reuse-baseline`
    - `--force-run`
    - raw Vitest passthrough mode for Task 5
  - Whole-command phase execution for `check` and `verify` while holding the lock so reuse decisions and recorded results cover the whole contract.

- [ ] **Step 4: Re-run the adapter tests and verify pass**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run test/unit/server/test-run-adapters.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit the adapter layer**

  ```bash
  git -C /home/user/code/freshell/.worktrees/test-run-gate add \
    package.json package-lock.json \
    scripts/testing/test-run-adapters.ts \
    scripts/testing/test-run-upstream.ts \
    scripts/testing/broad-one-shot-test-run.ts \
    test/unit/server/test-run-adapters.test.ts
  git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): route public commands through broad one-shot runner"
  ```

## Task 5: Vitest Patch As Another Adapter

**Files:**

- Create: `patches/vitest+3.2.4.patch`
- Create: `test/fixtures/test-run-gate/fake-upstream.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/integration/server/vitest-patch-adapter.test.ts`

- [ ] **Step 1: Write the failing patched-Vitest integration tests**

  Cover:
  - `npx vitest run` enters the same `BroadOneShotTestRun` path as public broad scripts.
  - `npx vitest run test/unit` becomes a gated broad run.
  - `npx vitest run path/to/file.test.ts` delegates upstream with no holder file.
  - `npx vitest` watch mode delegates upstream with no holder file.
  - `npx vitest --ui` delegates upstream with no holder file.
  - The patched entrypoint uses a non-recursive env marker so the second hop bypasses gate interception and imports upstream `./dist/cli.js` directly.
  - Unknown broad suite flags still gate the run but disable reuse.

- [ ] **Step 2: Add `patch-package` and implement the minimal patch**

  Patch behavior:
  - Intercept at `node_modules/vitest/vitest.mjs`.
  - If `FRESHELL_VITEST_UPSTREAM=1`, import `./dist/cli.js` directly and stop.
  - Otherwise launch `tsx scripts/testing/broad-one-shot-test-run.ts --adapter raw-vitest -- <original argv>`.
  - Set `FRESHELL_VITEST_UPSTREAM=1` on the upstream handoff from `BroadOneShotTestRun`.

- [ ] **Step 3: Re-run the Vitest patch integration tests**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run test/integration/server/vitest-patch-adapter.test.ts
  ```

  Expected: PASS, including explicit watch/UI/file-targeted delegation coverage.

- [ ] **Step 4: Commit the raw Vitest adapter**

  ```bash
  git -C /home/user/code/freshell/.worktrees/test-run-gate add \
    package.json package-lock.json \
    patches/vitest+3.2.4.patch \
    test/fixtures/test-run-gate/fake-upstream.ts \
    test/integration/server/vitest-patch-adapter.test.ts
  git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): intercept raw vitest broad runs"
  ```

## Task 6: Verification And Test Plan

**Files:**

- Modify: `test/integration/server/broad-one-shot-test-run.test.ts`
- Modify: `test/integration/server/vitest-patch-adapter.test.ts`
- Modify: `docs/plans/2026-03-08-test-run-gate-and-baseline-cache.md`

- [ ] **Step 1: Expand the integration tests to cover end-to-end command behavior without running the real broad suite**

  Add coverage for:
  - `test:status` while idle, `running-described`, and `running-undescribed`
  - `--reuse-baseline` and `--force-run`
  - `check` whole-command reuse using a fake successful prior `check` record
  - `verify` whole-command reuse using a fake successful prior `verify` record
  - Exact failure blocking reuse of older success
  - `test:server` one-shot semantics and `test:server:watch` delegation
  - Summary propagation from env and flag

- [ ] **Step 2: Run the targeted verification suite during implementation**

  Until Task 5 is complete, do not run the real full-suite commands. Use only the targeted gate tests:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run \
    test/unit/server/coding-cli/utils.test.ts \
    test/unit/server/test-run-classification.test.ts \
    test/unit/server/test-run-gate-state.test.ts \
    test/unit/server/test-run-baselines.test.ts \
    test/unit/server/test-run-adapters.test.ts \
    test/integration/server/broad-one-shot-test-run.test.ts \
    test/integration/server/vitest-patch-adapter.test.ts
  ```

  Expected: PASS.

- [ ] **Step 3: Run the real command-contract checks only after the feature exists**

  Once all tasks above pass, run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npm run check
  npm run verify
  ```

  Expected:
  - Both commands pass in the implemented gate world.
  - Their contracts remain intact.
  - No whole-command early exit occurs unless an exact whole-workload reusable baseline is present and explicitly requested.

- [ ] **Step 4: Record any final plan deltas and commit**

  If implementation exposed any necessary naming or contract correction, update this plan before the final commit.

  ```bash
  git -C /home/user/code/freshell/.worktrees/test-run-gate add \
    docs/plans/2026-03-08-test-run-gate-and-baseline-cache.md \
    test/integration/server/broad-one-shot-test-run.test.ts \
    test/integration/server/vitest-patch-adapter.test.ts
  git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "test: verify unified broad run gate behavior"
  ```

## Acceptance Checklist

- `BroadOneShotTestRun` is the single primitive for all gated broad work.
- Every entrypoint classifies to exactly one outcome: `delegate upstream` or `gated broad run`.
- `flock` is the only liveness truth.
- Missing or corrupt holder metadata yields `running-undescribed`, not a deadlock or false idle.
- Holder and results files are written atomically.
- `suiteKey` drives reuse; `commandKey` is provenance only.
- Unknown broad suite flags disable reuse but do not skip gating.
- `check` and `verify` preserve their full contracts.
- Raw `vitest` interception has a non-recursive upstream path.
- `test:server` means one-shot broad server-suite execution; `test:server:watch` is the explicit watch alias.
- Watch/UI/file-targeted paths are covered and proven to delegate upstream with no gate side effects.
