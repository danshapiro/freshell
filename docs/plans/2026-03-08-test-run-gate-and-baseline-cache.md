# Unified Broad One-Shot Test Run Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Keep this unified; do not split it into phased partial measures.

**Goal:** Build one crash-safe `BroadOneShotTestRun` path that serializes only broad one-shot test workloads, reports truthful holder status, and reuses only exact matching reusable baselines without weakening any current command contract on merge.

**Architecture:** Every test entrypoint classifies into exactly one of two outcomes: `delegate upstream` or `gated broad run`. `delegate upstream` covers watch, UI, explicit file-targeted, and other non-broad invocations and never touches the gate, holder, or reuse cache. `gated broad run` routes through a single `BroadOneShotTestRun` primitive that discovers repo state from the caller’s invocation cwd, acquires a repo-shared non-blocking `flock`, writes advisory holder metadata atomically, optionally consults reusable baselines keyed by `suiteKey`, then executes the actual workload. Public npm scripts and patched raw `vitest` both use the same primitive, but the merge-target `main` script surface stays intact, including the split `test:server:all` flow and the special `logger.separation` single-fork phase.

**Tech Stack:** Node.js, TypeScript, `tsx`, npm scripts, `child_process`, `fs/promises`, Git CLI, Linux/WSL `flock`, `patch-package`, Vitest 3.

---

## Frozen Invariants

- This plan targets the merge surface on `main`, not the stale worktree snapshot. Implementation must merge or rebase `main` into the worktree before touching `package.json`, then verify the command manifest below still matches. If `main` drifted again, update this plan first.
- The current merge-target public script surface to preserve is:
  - `test = npm run test:client:all && npm run test:server:all`
  - `test:all = npm run test:client:all && npm run test:server:all`
  - `test:watch = vitest`
  - `test:ui = vitest --ui`
  - `test:client:all = vitest run --pool forks`
  - `test:server = vitest --config vitest.server.config.ts`
  - `test:server:without-logger = vitest run --config vitest.server.config.ts --exclude test/integration/server/logger.separation.test.ts`
  - `test:server:logger-separation = vitest run --config vitest.server.config.ts --pool forks --poolOptions.forks.singleFork --no-file-parallelism test/integration/server/logger.separation.test.ts`
  - `test:server:all = npm run test:server:without-logger && npm run test:server:logger-separation`
  - `test:coverage = vitest run --coverage`
  - `test:unit = vitest run test/unit`
  - `test:integration = vitest run --config vitest.server.config.ts test/server`
  - `test:client = vitest run test/unit/client`
  - `verify = npm run build && npm test`
  - `check = npm run typecheck && npm test`
- `BroadOneShotTestRun` is the only primitive. Every gated broad path, public or raw, must route through it.
- Public delegated scripts still route through the same wrapper for classification. When they delegate, they must produce no lock/holder/reuse side effects, but they may not bypass classification entirely because trailing args can change mode.
- Rewritten public npm scripts must preserve trailing-argv behavior. Any args passed after `--` to `npm run <script> -- ...` must be forwarded into classification and then to the eventual upstream command instead of being dropped or misparsed.
- When a file-targeted single-phase public adapter delegates upstream, forwarded file selectors replace that adapter’s default broad positional selector set instead of being appended to it. Non-selector adapter defaults such as `--config`, `--pool forks`, and `--exclude test/integration/server/logger.separation.test.ts` remain intact on the delegated upstream argv.
- Aggregate and mixed adapters may not guess at forwarded suite-shaping inputs. For `test`, `test:all`, `test:server:all`, `check`, and `verify`, forwarded positional selectors and forwarded suite-shaping flags after `--` must be rejected with an actionable error instead of being copied into every phase or silently dropped. Only a small allowlist of presentation-only flags may be duplicated across split Vitest phases.
- The aggregate-adapter allowlist is frozen to presentation-only Vitest flags that do not change selected tests or runtime semantics:
  - `--reporter`
  - `--silent`
  - `--color`
  - `--no-color`
  - `--tty`
  - `--clearScreen`
  - no other forwarded flags may be duplicated across aggregate or mixed adapters unless this plan is updated first
- Classification is total and binary. Every test entrypoint must end as exactly one of:
  - `delegate upstream`
  - `gated broad run`
- `delegate upstream` means no lock, no holder metadata, no baseline reuse, and no status side effects.
- `delegate upstream` does not mean “skip the wrapper”. It means the wrapper classifies the invocation, then hands off upstream without creating gate state.
- `gated broad run` means the process goes through `BroadOneShotTestRun`, attempts the repo-wide `flock`, writes holder metadata only after the lock is acquired, and may consult reusable baselines only if the suite is fully classified and the adapter policy allows reuse.
- Baseline reuse is opt-in only. Allowed suites must still execute normally unless the caller explicitly requests reuse via `--reuse-baseline`.
- `flock` is the only liveness truth. No pid table, lockfile contents, or holder file may be treated as proof that a run is live.
- Holder metadata is advisory only. Missing, corrupt, stale, partial, or unreadable holder data must never block progress and must never override the lock probe.
- Status is a small explicit state machine driven by lock first, metadata second:
  - `idle`: non-blocking probe acquires the lock and releases it immediately. Ignore any holder file.
  - `running-described`: probe sees the lock is held and holder metadata parses with all required fields.
  - `running-undescribed`: probe sees the lock is held but holder metadata is missing, corrupt, unreadable, or missing required fields.
- Holder writes and result writes must be atomic: write to a temp file in the same directory, `fsync` the temp file, rename over the destination, then best-effort `fsync` the directory. Reads must schema-validate and degrade safely on any failure.
- Repo discovery must not rely on `process.cwd()` alone. Use the caller’s invocation cwd (`INIT_CWD` when present, otherwise `process.cwd()`), then resolve checkout root and git common-dir from Git.
- Test code may not write gate state into the live repo common-dir. The implementation must provide a disposable common-dir seam for tests, for example `FRESHELL_TEST_GATE_COMMON_DIR`, and every new gate test must use a temp directory or temporary git fixture through that seam. No gate test may touch `/home/user/code/freshell/.git`.
- Broad vs narrow is frozen as:
  - “resolves to a file” means actual filesystem-backed resolution from the invocation cwd or an explicit injected resolution seam used by tests; filename suffix heuristics are forbidden
  - Narrow:
    - watch or UI mode
    - explicit file-targeted runs where every positional selector resolves to a file and no known broad suite-shaping selector is present
    - explicit file-targeted runs with `--config` or `-c` when every positional selector resolves to a file and no other broad suite-shaping selector is present
    - public single-phase adapters that forward only file-targeted selectors, where every forwarded positional selector resolves to a file and no known broad suite-shaping selector is present; this includes `test:unit`, `test:integration`, `test:client`, `test:client:all`, and `test:server:without-logger`
    - raw Vitest subcommands `watch`, `dev`, `related`, and `bench`
    - raw non-test operational flags and modes such as `--standalone` and `--mergeReports`
    - public `test:server` and public `test:server:logger-separation`
  - Broad:
    - any non-interactive one-shot run with no selectors
    - any directory target
    - any glob target
    - any project or dir selector
    - any config selector paired with no positional selectors, with directory/glob selectors, or with any other broad suite-shaping selector
    - any test-name pattern
    - `--changed`
    - `--exclude`
    - `--environment`
    - `--coverage`
    - `--shard`
    - current-main public one-shot aggregates such as `test`, `test:all`, `test:client:all`, `test:server:all`, and `test:server:without-logger`
- Bare raw `vitest` is not always watch. Classification must resolve its effective mode from Vitest’s default watch behavior:
  - if effective watch mode is true, `delegate upstream`
  - if effective watch mode is false, classify the same as raw one-shot `vitest run`
- Bare raw `vitest --run` is equivalent to one-shot raw `vitest run` and must classify through the same broad-vs-narrow rules:
  - `vitest --run` with no selectors is broad
  - `vitest --run <file>` is narrow
  - `vitest --run --coverage` is broad
- Any coverage-bearing run is non-reusable, public or raw. If the classified invocation includes any truthy or implicit coverage-enabling flag form such as `--coverage`, `--coverage true`, `--coverage=true`, `--coverage.enabled`, `--coverage.enabled true`, or `--coverage.enabled=true`, baseline reuse must be disabled even when the run is still gated. False-valued forms such as `--coverage false`, `--coverage=false`, `--coverage.enabled false`, and `--coverage.enabled=false` are not coverage-bearing.
- False-valued coverage forms also do not broaden an otherwise narrow invocation. `--coverage false`, `--coverage=false`, `--coverage.enabled false`, and `--coverage.enabled=false` must be treated the same as “coverage absent” for broad-vs-narrow classification.
- Unknown broad suite-shaping flags are never reusable. They may still run as gated broad work, but reuse must be disabled instead of guessed.
- Unknown raw Vitest subcommands that are not the default command and are not explicitly classified above must `delegate upstream`. The classifier still returns an explicit outcome; it may not leave any raw entrypoint undefined.
- Unknown flags on explicitly non-test operational modes must `delegate upstream`, not be coerced into gated broad work.
- `suiteKey` identifies the reusable workload. `commandKey` is provenance and UX only. Different commands may share a `suiteKey` only if they truly execute the same workload.
- Reusable baseline identity is exact: the newest record matching `(suiteKey, commit, cleanWorktree=true, nodeVersion, platform, arch)` controls reuse. If the newest exact record is a failure, no older success for that same identity may be reused.
- Reuse policy is frozen per adapter:
  - `allow reuse`: `test`, `test:all`, `test:client:all`, `test:server:all`, `test:server:without-logger`, `test:unit`, `test:integration`, `test:client`, and `check`
  - `never reuse`: `verify` and `test:coverage`, because both must perform fresh artifact-producing work (`build` and coverage output)
  - `delegate upstream by default`: `test:watch`, `test:ui`, `test:server`, and `test:server:logger-separation`
- Raw classified runs also have a frozen reuse policy:
  - any classified raw run containing `--coverage` is `never reuse`
  - otherwise reuse is allowed only when classification remains fully known and does not fall into another `never reuse` or delegated case
- Public adapter invocations also inherit coverage-induced non-reuse. If forwarded trailing args make a normally reusable public adapter coverage-bearing, that invocation becomes `never reuse`.
- Mixed adapters still reject forwarded suite-shaping flags before reuse policy is considered. In particular, `check -- --coverage...` and `verify -- --coverage...` must fail with an actionable error rather than becoming coverage-bearing reusable/non-reusable variants.
- Even when a suite is reusable, baseline hits may only short-circuit execution when `--reuse-baseline` is present. Without that explicit opt-in, the runner must execute the suite.
- `check` may only reuse an exact prior success of the whole `check` workload. Reusing just the nested test phase is forbidden.
- `verify` must remain gated but non-reusable. Skipping a fresh build would weaken its current contract.
- `test:coverage` must remain gated but non-reusable. Skipping a fresh run would skip coverage artifact generation.
- Any `--outputFile`-bearing invocation is artifact-producing and non-reusable, public or raw. Aggregate and mixed adapters must still reject it, while reusable single-phase adapters and reusable raw broad runs must force fresh execution instead of short-circuiting a baseline hit.
- Raw `vitest` interception must have a non-recursive upstream path. The patch must use a dedicated env marker before handing off to upstream Vitest so the patched entrypoint can bypass gate logic on the second hop.
- Every adapter-launched Vitest child must also set the same bypass env marker before spawning `vitest`, otherwise held broad runs can self-contend against the patched entrypoint.
- The raw Vitest patch may not rely on relative runner paths resolved from the invocation cwd. It must use an absolute path derived from module location so `npx vitest` from `src/` or any nested directory still reaches the runner.
- Concurrency contract is frozen:
  - `BroadOneShotTestRun` uses non-blocking `flock`
  - if the lock is already held, the second broad run exits immediately with code `75`
  - on contention, it prints the same structured status payload as `--status` to stdout, plus a short human message to stderr indicating another broad run is already active
  - it never silently waits
- `--force-run` skips baseline reuse only. It never bypasses lock acquisition, never weakens serialization, and never changes the contention exit code or output contract.
- `--status` contract is frozen:
  - it always performs the same non-blocking lock probe as the runner
  - it exits `0` on successful status queries, regardless of state
  - it prints one JSON object to stdout:
    - `{"state":"idle"}`
    - `{"state":"running-described","holder":{...}}`
    - `{"state":"running-undescribed"}`
  - internal errors exit nonzero and do not fabricate a state
- Summary metadata support is in scope only through explicitly specified mechanisms:
  - `FRESHELL_TEST_SUMMARY`
  - `BroadOneShotTestRun --summary <text>`
  - explicit `--summary` takes precedence over the env var; otherwise the adapter provides a default summary.

## File Structure

**Modify**

- `package.json`
  - Repoint current-main broad one-shot scripts through `BroadOneShotTestRun`.
  - Preserve current-main delegate scripts that must remain upstream.
  - Add `test:status`.
  - Add an exact `postinstall` hook for `patch-package`.
- `package-lock.json`
  - Record `patch-package`, the final script surface, and the lockfile update needed for fresh installs.
- `docs/skills/testing.md`
  - Update the command table to the actual script surface plus `test:status`.
- `server/coding-cli/utils.ts`
  - Add shared git common-dir resolution and invocation-cwd helpers.
- `test/unit/server/coding-cli/utils.test.ts`
  - Cover worktree-aware repo/common-dir discovery.

**Create**

- `scripts/testing/broad-one-shot-test-run.ts`
  - The only primitive: parse adapter inputs, classify, probe status, acquire/release the lock, write holder metadata, consult baselines, run upstream work, persist results, and emit status/contended payloads.
- `scripts/testing/test-run-classification.ts`
  - Exact broad-vs-narrow rules, raw Vitest default-mode resolution, operational-mode delegation, and raw argv normalization.
- `scripts/testing/test-run-gate-state.ts`
  - Lock path resolution, test-only common-dir override seam, `flock` helpers, holder state machine, atomic holder read/write/delete, and status/contended output formatting.
- `scripts/testing/test-run-baselines.ts`
  - `suiteKey` generation, results store, exact reuse lookup, newest-record-wins logic, and per-adapter reuse policy checks.
- `scripts/testing/test-run-adapters.ts`
  - Public command manifest for the current-main script surface, stable `commandKey` naming, default delegated-vs-broad behavior, `suiteKey`s, reuse policy, default summaries, and upstream phase definitions.
- `scripts/testing/test-run-upstream.ts`
  - Non-recursive spawning helpers for npm/Vitest/build/typecheck/upstream child processes, trailing-argv forwarding, and env shaping.
- `scripts/testing/vitest-patched-entry.mjs`
  - Stable JS launcher imported by the patched `vitest.mjs`; resolves repo-root-relative absolute paths without depending on invocation cwd.
- `patches/vitest+3.2.4.patch`
  - Minimal patch that changes `node_modules/vitest/vitest.mjs` to import `../../scripts/testing/vitest-patched-entry.mjs`.
- `test/fixtures/test-run-gate/fake-upstream.ts`
  - Small controllable Node fixture used by integration tests to simulate success, failure, delay, and env capture without running the real broad suite.
- `test/fixtures/test-run-gate/file-targets.ts`
  - Helper that creates real file-target fixtures or an explicit mocked resolution seam for classification tests so narrow file-target cases exercise actual resolution logic.
- `test/fixtures/test-run-gate/temp-gate-env.ts`
  - Helper for creating isolated temp gate directories or temporary git fixtures so parallel tests never touch the live repo `.git`.
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
- Create: `test/fixtures/test-run-gate/file-targets.ts`
- Create: `test/unit/server/test-run-classification.test.ts`

- [ ] **Step 1: Write the failing repo-discovery and classification tests**

  Cover:
  - `resolveGitCommonDir()` returns the shared `.git` directory for linked worktrees.
  - Invocation cwd comes from `INIT_CWD` when present, then falls back to `process.cwd()`.
  - Test-only common-dir override returns the supplied disposable directory without probing the live repo.
  - Trailing argv after `--` is preserved and classified instead of being dropped by the wrapper.
  - Bare `vitest` delegates when effective watch mode is true.
  - Bare `vitest` becomes `gated broad run` when effective watch mode is false.
  - Bare `vitest --run` becomes `gated broad run` with no selectors.
  - Bare `vitest --run <fixture-client-test-file>` becomes `delegate upstream`.
  - Bare `vitest --run --coverage` becomes `gated broad run`.
  - Bare `vitest --run --coverage.enabled` becomes `gated broad run`.
  - Bare `vitest --run --coverage=true` becomes `gated broad run`.
  - Bare `vitest --run --coverage.enabled=true` becomes `gated broad run`.
  - Bare `vitest --run --coverage false` is not treated as coverage-bearing.
  - Bare `vitest --run --coverage=false` is not treated as coverage-bearing.
  - Bare `vitest --run --coverage.enabled false` is not treated as coverage-bearing.
  - Bare `vitest --run --coverage.enabled=false` is not treated as coverage-bearing.
  - `vitest run <fixture-client-test-file> --coverage false`, `--coverage=false`, `--coverage.enabled false`, and `--coverage.enabled=false` stay `delegate upstream`.
  - Raw `vitest run` with no selectors is `gated broad run`.
  - Raw `vitest run test/unit`, `vitest run "test/**/*.test.ts"`, `vitest run --config vitest.server.config.ts test/server`, `vitest run -c vitest.server.config.ts test/server`, `vitest run --root . test/unit`, `vitest run --dir test`, `vitest run --project client --project server`, `vitest run -t name`, and `vitest run --changed` are `gated broad run`.
  - Raw `vitest run --config vitest.server.config.ts <fixture-server-test-file>` and `vitest run -c vitest.server.config.ts <fixture-server-integration-test-file>` are `delegate upstream`.
  - Raw `vitest <fixture-client-test-file>` and `vitest run <fixture-client-test-file>` are `delegate upstream`.
  - Raw `vitest --ui`, `vitest watch`, `vitest dev`, `vitest related`, and `vitest bench` are `delegate upstream`.
  - Raw `vitest --standalone` and `vitest --mergeReports` are `delegate upstream`.
  - Unknown raw Vitest subcommands still get an explicit outcome and default to `delegate upstream`.
  - Unknown broad suite-shaping flags classify as broad but mark reuse disabled.
  - File-target classification cases use real resolved fixture paths or an explicit injected resolution seam; no test uses placeholder paths that bypass the “resolves to a file” contract.

- [ ] **Step 2: Run only the targeted tests and verify they fail**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-run-classification.test.ts
  ```

  Expected:
  - FAIL for missing `resolveGitCommonDir()`
  - FAIL for missing total raw-Vitest classification and default-mode logic

- [ ] **Step 3: Implement repo discovery and total classification**

  Implement:
  - `resolveGitCommonDir(cwd)` using `git -C <checkoutRoot> rev-parse --git-common-dir`
  - `resolveInvocationCwd()` using `INIT_CWD ?? process.cwd()`
  - a test-only gate-state override seam, e.g. `FRESHELL_TEST_GATE_COMMON_DIR`
  - file-target resolution based on actual filesystem lookup from the invocation cwd or an explicit injected resolver seam used by tests, never on suffix matching alone
  - trailing-argv parsing so adapter-owned wrappers preserve `npm run <script> -- ...`
  - `classifyVitestInvocation(argv, runtime)` returning a discriminated union with:
    - `kind: 'delegate-upstream'`
    - `kind: 'gated-broad-run'`
  - explicit bare-`vitest` mode resolution using `CI` and `stdin.isTTY`
  - explicit equivalence between `vitest --run ...` and `vitest run ...`
  - explicit delegate path for operational/non-test modes and flags
  - explicit carve-out for `--config/-c` plus file-only selectors so targeted server one-shots remain delegated
  - normalized broad-run classification results including:
    - normalized positional selectors
    - `baselineReusable: boolean`
    - `unknownSuiteFlags: string[]`

- [ ] **Step 4: Re-run the targeted tests and verify pass**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-run-classification.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit the classification foundation**

  ```bash
  git -C /home/user/code/freshell/.worktrees/test-run-gate add \
    server/coding-cli/utils.ts \
    test/unit/server/coding-cli/utils.test.ts \
    scripts/testing/test-run-classification.ts \
    test/fixtures/test-run-gate/file-targets.ts \
    test/unit/server/test-run-classification.test.ts
  git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): classify broad test entrypoints"
  ```

## Task 2: Gate And Status State Machine

**Files:**

- Create: `scripts/testing/test-run-gate-state.ts`
- Create: `scripts/testing/broad-one-shot-test-run.ts`
- Create: `test/fixtures/test-run-gate/fake-upstream.ts`
- Create: `test/fixtures/test-run-gate/temp-gate-env.ts`
- Create: `test/unit/server/test-run-gate-state.test.ts`
- Create: `test/integration/server/broad-one-shot-test-run.test.ts`

- [ ] **Step 1: Write the failing lock, holder, and status-contract tests**

  Cover:
  - Gate paths are rooted at `resolveGitCommonDir(invocationCwd)` in production.
  - Gate paths use the disposable override seam in tests and never resolve to `/home/user/code/freshell/.git`.
  - Non-blocking `flock` probe returning success produces `idle` even if `holder.json` exists.
  - Held lock plus valid holder metadata produces `running-described`.
  - Held lock plus missing, corrupt, or partial holder metadata produces `running-undescribed`.
  - Holder writes use temp-file-then-rename behavior in the same directory.
  - `--status` emits the exact JSON payload shape frozen above.
  - Contended broad runs exit `75`, emit exactly one JSON object on stdout, and emit the human message on stderr.
  - `--force-run` does not bypass contention and still exits `75` when the lock is already held.
  - Holder delete failures do not suppress lock release.

- [ ] **Step 2: Add one integration test around real `flock` behavior using the fake upstream fixture**

  Simulate:
  - Process A acquires the gate and sleeps inside a disposable temp gate directory.
  - Process B calls the minimal `BroadOneShotTestRun --status` path and receives `running-described`.
  - Process C attempts another broad run, exits `75`, and does not create a second holder.
  - Process C with `--force-run` still exits `75`.
  - After Process A exits without explicit cleanup, a fresh status probe returns `idle` even if the old holder file still exists.
  - No files are written under the live repo `.git`.

- [ ] **Step 3: Implement the gate state module**

  Implement:
  - a minimal `broad-one-shot-test-run.ts` CLI sufficient for Task 2 only:
    - `--status`
    - a fixture-backed broad-run execution path that acquires the lock, writes/removes holder metadata, and returns contention `75`
    - `--force-run` parsing with reuse-disabled semantics only
  - `buildGatePaths(commonDir)` returning:
    - lock file
    - holder file
    - results file
  - `resolveGateCommonDir()` that uses the test override seam when present and normal git-common-dir discovery otherwise
  - `probeBroadRunStatus()`:
    - try non-blocking `flock`
    - if acquired: release immediately and return `idle`
    - if blocked: attempt holder read and schema validation
    - return `running-described` or `running-undescribed`
  - `writeHolderAtomically()` using temp file, `fsync`, rename, best-effort dir `fsync`
  - `readHolderAdvisory()` returning parsed metadata or a typed failure reason
  - `formatStatusPayload()` and `formatContendedPayload()` with JSON-on-stdout and human-message-on-stderr separation
  - `removeHolderIfPresent()` as best-effort cleanup while still holding the lock

- [ ] **Step 4: Re-run the targeted state tests**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-run-gate-state.test.ts test/integration/server/broad-one-shot-test-run.test.ts
  ```

  Expected: PASS without invoking the real full suite.

- [ ] **Step 5: Commit the state machine**

  ```bash
  git -C /home/user/code/freshell/.worktrees/test-run-gate add \
    scripts/testing/test-run-gate-state.ts \
    scripts/testing/broad-one-shot-test-run.ts \
    test/fixtures/test-run-gate/fake-upstream.ts \
    test/fixtures/test-run-gate/temp-gate-env.ts \
    test/unit/server/test-run-gate-state.test.ts \
    test/integration/server/broad-one-shot-test-run.test.ts
  git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add broad run gate state machine"
  ```

## Task 3: Suite Identity And Reuse Rules

**Files:**

- Create: `scripts/testing/test-run-baselines.ts`
- Create: `test/unit/server/test-run-baselines.test.ts`

- [ ] **Step 1: Write the failing baseline and reuse-policy tests**

  Cover:
  - `suiteKey` identity ignores `commandKey`.
  - `test` and `test:all` share the same `suiteKey` only because they execute the same split workload.
  - `test:server:all` has a distinct `suiteKey` from `test:server:without-logger`.
  - `check` has its own whole-workload `suiteKey`.
  - `verify` has its own whole-workload `suiteKey` but `reusePolicy: 'never'`.
  - `test:coverage` has `reusePolicy: 'never'`.
  - raw classified runs with any truthy coverage-enabling flag form such as `--coverage`, `--coverage true`, `--coverage=true`, `--coverage.enabled`, `--coverage.enabled true`, and `--coverage.enabled=true` have `reusePolicy: 'never'`.
  - raw classified runs with `--coverage false`, `--coverage=false`, `--coverage.enabled false`, and `--coverage.enabled=false` are not marked `never reuse` just because the flag token appears.
  - raw classified runs with `--outputFile=<path>` or `--outputFile <path>` have `reusePolicy: 'never'` even when the rest of the run would otherwise be reusable.
  - forwarded truthy coverage flags make reusable public adapters such as `test:unit` and `test:client:all` become `never reuse` for that invocation.
  - forwarded false-valued coverage flags on reusable public adapters such as `test:unit` and `test:client:all` do not disable reuse just because the flag token appears.
  - forwarded `--outputFile=<path>` and `--outputFile <path>` make reusable single-phase public adapters such as `test:unit` and `test:client` become `never reuse` for that invocation.
  - mixed adapters such as `check` reject forwarded coverage flags instead of treating them as reusable/non-reusable variants.
  - Raw broad `suiteKey` includes all classified suite-shaping selectors.
  - Raw broad `suiteKey` excludes non-suite UX flags such as reporter/color formatting, while artifact-producing `--outputFile` still forces `reusePolicy: 'never'`.
  - Unknown suite-shaping flags force `baselineReusable=false`.
  - Reuse requires exact `suiteKey`, exact commit, producer clean worktree, current clean worktree, exact node version, exact platform, exact arch, and prior exit code `0`.
  - The newest exact failure blocks reuse of older exact success.
  - Corrupt or unreadable results files degrade to “no reusable baseline”.

- [ ] **Step 2: Run the targeted baseline tests and verify failure**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-run-baselines.test.ts
  ```

  Expected: FAIL for missing suite identity and reuse-policy logic.

- [ ] **Step 3: Implement suite keys and results handling**

  Implement:
  - stable results record schema including:
    - `suiteKey`
    - `commandKey`
    - `summary`
    - `commit`
    - `cleanWorktree`
    - `nodeVersion`
    - `platform`
    - `arch`
    - `startedAt`
    - `finishedAt`
    - `exitCode`
  - results persistence as a bounded newest-first array written atomically
  - `findReusableBaseline()` that selects only the newest exact identity record and rejects older successes after a newer failure
  - per-adapter `reusePolicy` checks:
    - `allow`
    - `never`
    - `disabled-by-classification`
  - raw classified-run `reusePolicy` checks that force `never` for any coverage-bearing invocation
  - explicit opt-in gating for reuse so baseline matches do not short-circuit execution unless `--reuse-baseline` is present
  - raw Vitest `suiteKey` normalization from the full classified broad arg model

- [ ] **Step 4: Re-run the baseline tests and verify pass**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-run-baselines.test.ts
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
- Modify: `docs/skills/testing.md`

- [ ] **Step 1: Write the failing adapter and merge-surface tests**

  Cover:
  - Current-main public commands map to exactly one outcome.
  - `package.json` matches the frozen script contract exactly for every public test command, for `postinstall`, and for `devDependencies.patch-package`.
  - Trailing argv is forwarded: examples include `npm run test:unit -- <fixture-client-test-file>` and `npm run test:coverage -- --reporter=dot`.
  - Every file-targeted public-adapter delegation case in this task uses the same real resolved fixture paths or explicit injected resolver seam from Task 1; no synthetic placeholder strings are allowed.
  - Delegated public scripts still classify trailing args through the wrapper:
    - `npm run test:server -- --run --coverage` becomes a gated broad run instead of bypassing the gate
    - `npm run test:watch -- --run` becomes a gated broad run instead of bypassing the gate
  - File-targeted single-phase public adapters preserve narrow delegation:
    - `npm run test:unit -- <fixture-client-test-file>` delegates upstream with no gate side effects, replacing the adapter’s default `test/unit` selector with the forwarded file target
    - `npm run test:client -- <fixture-client-test-file>` delegates upstream with no gate side effects, replacing the adapter’s default `test/unit/client` selector with the forwarded file target
    - `npm run test:client:all -- <fixture-client-test-file>` delegates upstream with no gate side effects, replacing the absence of a default positional selector with the forwarded file target while preserving `--pool forks`
    - `npm run test:integration -- <fixture-server-test-file>` delegates upstream with no gate side effects, replacing the adapter’s default `test/server` selector while preserving `--config vitest.server.config.ts`
    - `npm run test:server:without-logger -- <fixture-server-test-file>` delegates upstream with no gate side effects, replacing the default broad selector set with the forwarded file target while preserving `--config vitest.server.config.ts` and the logger exclusion
  - Multi-phase trailing argv behavior is explicit:
    - `npm run test -- --reporter=dot` forwards to both split Vitest phases
    - `npm run test -- --silent` forwards to both split Vitest phases
    - `npm run test -- --color`, `--no-color`, `--tty`, and `--clearScreen` are allowed and forwarded to both split Vitest phases
    - `npm run test:server:all -- --reporter=dot` forwards to both server Vitest phases
    - `npm run check -- --reporter=dot` forwards only to the nested test phase, not typecheck
    - `npm run check -- --silent`, `--color`, `--no-color`, `--tty`, and `--clearScreen` forward only to the nested test phase, not typecheck
    - `npm run verify -- --reporter=dot`, `--silent`, `--color`, `--no-color`, `--tty`, and `--clearScreen` forward only to the nested test phase, not build
    - `npm run test -- <fixture-client-test-file>` is rejected with an actionable error
    - `npm run test:server:all -- <fixture-server-test-file>` is rejected with an actionable error
    - `npm run check -- <fixture-client-test-file>` is rejected with an actionable error
    - `npm run verify -- <fixture-client-test-file>` is rejected with an actionable error
    - `npm run test -- --project server`, `npm run test:server:all -- --dir test/server`, `npm run check -- -t name`, and `npm run verify -- --changed` are rejected with an actionable error instead of being fanned out across phases
    - `npm run test -- --outputFile=tmp.json`, `npm run test:server:all -- --outputFile tmp.json`, `npm run check -- --outputFile=tmp.json`, `npm run check -- --outputFile tmp.json`, `npm run verify -- --outputFile=tmp.json`, and `npm run verify -- --outputFile tmp.json` are rejected with an actionable error until explicit per-phase remapping or artifact-merge semantics exist
    - false-valued non-allowlisted suite-shaping forms such as `npm run test -- --coverage=false`, `npm run test:server:all -- --coverage.enabled false`, `npm run check -- --coverage=false`, and `npm run verify -- --coverage.enabled=false` are rejected with the same actionable error instead of being fanned out
    - other non-allowlisted forwarded flags such as `npm run test -- --isolate=false`, `npm run test:server:all -- --bail=0`, `npm run check -- --maxWorkers=1`, and `npm run verify -- --passWithNoTests=false` are rejected with the same actionable error instead of being fanned out
    - `npm run check -- --coverage` and `npm run verify -- --coverage` are rejected with an actionable error
  - `test`, `test:all`, `test:client:all`, `test:server:all`, `test:server:without-logger`, `test:unit`, `test:integration`, `test:client`, `check`, `verify`, and `test:coverage` are `gated broad run` only when classification does not land in one of the frozen delegated narrow cases above.
  - `test:watch`, `test:ui`, `test:server`, and `test:server:logger-separation` delegate upstream by default, but still pass through wrapper classification first.
  - `test` and `test:all` preserve the split `client-all` then `server-all` phase contract.
  - `test:server:all` preserves the split `without-logger` then `logger-separation` phase contract.
  - `test`/`test:all` stop before `server-all` if `client-all` fails.
  - `test:server:all` stops before `logger-separation` if `without-logger` fails.
  - `test:server:logger-separation` preserves the exact single-fork and no-file-parallelism flags from current `main`.
  - `check` is whole-workload reusable.
  - `verify` and `test:coverage` are gated but never reusable.
  - Adapter-provided default summaries are stable.
  - `--summary` overrides `FRESHELL_TEST_SUMMARY`.

- [ ] **Step 2: Freeze the exact package script target before implementation**

  The target script surface after implementation is:

  ```json
  {
    "postinstall": "patch-package",
    "test": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test",
    "verify": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter verify",
    "check": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter check",
    "test:watch": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:watch",
    "test:ui": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:ui",
    "test:client:all": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:client:all",
    "test:server": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:server",
    "test:server:without-logger": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:server:without-logger",
    "test:server:logger-separation": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:server:logger-separation",
    "test:server:all": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:server:all",
    "test:coverage": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:coverage",
    "test:unit": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:unit",
    "test:integration": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:integration",
    "test:client": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:client",
    "test:all": "tsx scripts/testing/broad-one-shot-test-run.ts --adapter test:all",
    "test:status": "tsx scripts/testing/broad-one-shot-test-run.ts --status"
  }
  ```

- [ ] **Step 3: Implement the adapters and the single primitive**

  Implement:
  - a public adapter manifest with stable `commandKey`, `suiteKey`, reuse policy, default summary, and explicit upstream phases
  - a literal package-contract test that parses `package.json` and fails on drift for:
    - public test scripts
    - delegated scripts
    - split aggregate flows
    - `test:status`
    - `postinstall = patch-package`
    - `devDependencies.patch-package`
  - top-level adapters that call underlying phases directly from the manifest instead of recursively invoking other gated npm scripts
  - delegated public scripts implemented as wrapper-backed adapters so trailing args are reclassified before handoff
  - adapter argv forwarding so trailing args after `--` are appended to the adapter’s declared upstream command and also participate in classification/reuse decisions when they are suite-shaping
  - explicit narrow delegation carve-outs for file-targeted single-phase public adapters:
    - if `test:unit`, `test:integration`, `test:client`, `test:client:all`, or `test:server:without-logger` receives only resolved file selectors and no broad suite-shaping flags, classify as `delegate upstream` instead of gated broad work
    - the delegated upstream argv replaces the adapter’s default broad positional selector set with the forwarded file selectors instead of appending them
    - preserve non-selector adapter defaults during that replacement, including `--config`, `--pool forks`, and the logger exclusion for `test:server:without-logger`
  - explicit multi-phase forwarding rules:
    - duplicate only allowlisted presentation-only flags across each Vitest phase in split aggregates
    - reject any forwarded non-allowlisted flags on aggregate and mixed adapters with a clear error, including suite-shaping, execution-semantic, and false-valued forms
    - reject `--outputFile` on aggregate and mixed adapters until the design grows explicit per-phase remapping or artifact-merge semantics
    - reject false-valued non-allowlisted suite-shaping flags on aggregate and mixed adapters the same way as truthy forms
    - do not forward trailing args into non-Vitest phases like `build` and `typecheck`
    - reject positional selectors on aggregate and mixed adapters with a clear error instead of copying them into every phase
  - reusable single-phase adapters must treat forwarded `--outputFile` as `never reuse` and still execute fresh upstream work when `--reuse-baseline` is requested
  - explicit fail-fast semantics for split phases:
    - abort remaining phases on first nonzero exit, matching current shell `&&` behavior
  - `test` and `test:all` sharing the same `suiteKey` because they run the same phase list
  - `test:server`, `test:watch`, `test:ui`, and `test:server:logger-separation` staying upstream-delegated by default, but only after wrapper classification
  - `test:server:all` as the canonical broad one-shot server suite
  - `BroadOneShotTestRun` CLI behavior:
    - `--status`
    - `--adapter <name>`
    - `--summary <text>`
    - `--reuse-baseline`
    - `--force-run`
    - `--` to terminate runner-control parsing and forward trailing args untouched
    - raw Vitest passthrough mode for Task 5

- [ ] **Step 4: Re-run the adapter tests and verify pass**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-run-adapters.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit the adapter layer**

  ```bash
  git -C /home/user/code/freshell/.worktrees/test-run-gate add \
    package.json package-lock.json \
    docs/skills/testing.md \
    scripts/testing/test-run-adapters.ts \
    scripts/testing/test-run-upstream.ts \
    scripts/testing/broad-one-shot-test-run.ts \
    test/unit/server/test-run-adapters.test.ts
  git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): route broad scripts through one-shot runner"
  ```

## Task 5: Vitest Patch As Just Another Adapter

**Files:**

- Create: `scripts/testing/vitest-patched-entry.mjs`
- Create: `patches/vitest+3.2.4.patch`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/testing/test-run-upstream.ts`
- Create: `test/integration/server/vitest-patch-adapter.test.ts`

- [ ] **Step 1: Write the failing patched-Vitest integration tests**

  Cover:
  - `npx vitest run` enters the same `BroadOneShotTestRun` path as public broad scripts.
  - `npx vitest` with `CI=1` or non-TTY runtime becomes a gated broad run.
  - `npx vitest --run` enters the same `BroadOneShotTestRun` path as raw `vitest run`.
  - Every file-targeted delegation case in this task uses the same real resolved fixture paths or explicit injected resolver seam from Task 1; no synthetic placeholder strings are allowed.
  - `npx vitest --run <fixture-client-test-file>` delegates upstream with no gate side effects.
  - `npx vitest --run --coverage` becomes a gated broad run.
  - `npx vitest --run --coverage true` becomes a gated broad run.
  - `npx vitest --run --coverage.enabled` becomes a gated broad run.
  - `npx vitest --run --coverage.enabled true` becomes a gated broad run.
  - `npx vitest --run --coverage=true` becomes a gated broad run.
  - `npx vitest --run --coverage.enabled=true` becomes a gated broad run.
  - `npx vitest --run --coverage false` is not treated as coverage-bearing.
  - `npx vitest --run --coverage=false` is not treated as coverage-bearing.
  - `npx vitest --run --coverage.enabled false` is not treated as coverage-bearing.
  - `npx vitest --run --coverage.enabled=false` is not treated as coverage-bearing.
  - `npx vitest --run --coverage --reuse-baseline` does not early-exit from a cached success and still executes fresh upstream work.
  - `npx vitest --run --coverage true --reuse-baseline` does not early-exit from a cached success and still executes fresh upstream work.
  - `npx vitest --run --coverage.enabled --reuse-baseline` does not early-exit from a cached success and still executes fresh upstream work.
  - `npx vitest --run --coverage.enabled true --reuse-baseline` does not early-exit from a cached success and still executes fresh upstream work.
  - `npx vitest --run --coverage=true --reuse-baseline` does not early-exit from a cached success and still executes fresh upstream work.
  - `npx vitest --run --coverage.enabled=true --reuse-baseline` does not early-exit from a cached success and still executes fresh upstream work.
  - `npx vitest --run --reporter=json --outputFile=tmp.json --reuse-baseline` does not early-exit from a cached success and still executes fresh upstream work.
  - `npx vitest --run --reporter=json --outputFile tmp.json --reuse-baseline` does not early-exit from a cached success and still executes fresh upstream work.
  - `npx vitest <fixture-client-test-file>` and `npx vitest run <fixture-client-test-file>` delegate upstream with no holder file.
  - `npx vitest run --config vitest.server.config.ts <fixture-server-test-file>` delegates upstream with no gate side effects.
  - `npx vitest --ui`, `npx vitest watch`, `npx vitest dev`, `npx vitest related`, and `npx vitest bench` delegate upstream with no gate side effects.
  - `npx vitest --standalone` and `npx vitest --mergeReports` delegate upstream with no gate side effects.
  - The patched entrypoint works from a nested cwd such as `src/`.
  - The patched entrypoint uses a non-recursive env marker so the second hop bypasses gate interception and imports upstream `node_modules/vitest/dist/cli.js` directly.
  - Unknown broad suite flags still gate the run but disable reuse.

- [ ] **Step 2: Add `patch-package` and implement the stable launcher**

  Implement:
  - `scripts/testing/vitest-patched-entry.mjs` as a stable repo-owned launcher
  - a minimal `patches/vitest+3.2.4.patch` that changes `node_modules/vitest/vitest.mjs` from importing `./dist/cli.js` to importing `../../scripts/testing/vitest-patched-entry.mjs`
  - apply the patch in the current worktree before running patched-entry tests:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx patch-package
  ```

  - launcher behavior:
    - if `FRESHELL_VITEST_UPSTREAM=1`, import `../../node_modules/vitest/dist/cli.js`
    - otherwise spawn `process.execPath` with the absolute `tsx` CLI path and the absolute `broad-one-shot-test-run.ts` path derived from module location
    - preserve invocation cwd, pass `INIT_CWD` through unchanged when present, and forward the disposable gate-dir override used by tests
  - `test-run-upstream.ts` must set `FRESHELL_VITEST_UPSTREAM=1` on every adapter-owned Vitest child process so held broad runs do not re-enter the patched entrypoint

- [ ] **Step 3: Re-run the Vitest patch integration tests**

  Run:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/vitest-patch-adapter.test.ts
  ```

  Expected: PASS, including nested-cwd and raw watch/UI delegation coverage.

- [ ] **Step 4: Commit the raw Vitest adapter**

  ```bash
  git -C /home/user/code/freshell/.worktrees/test-run-gate add \
    package.json package-lock.json \
    scripts/testing/test-run-upstream.ts \
    scripts/testing/vitest-patched-entry.mjs \
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
  - contention exit code `75`
  - `--reuse-baseline` and `--force-run`
  - `--force-run` bypassing reuse only, not serialization
  - baseline reuse staying off by default unless `--reuse-baseline` is present
  - trailing argv passthrough from rewritten npm scripts
  - delegated public scripts reclassifying trailing args instead of bypassing the wrapper
  - forwarded truthy coverage flags making reusable public adapters such as `test:unit` and `test:client:all` become non-reusable for that invocation
  - forwarded false-valued coverage flags on reusable public adapters such as `test:unit` and `test:client:all` not disabling reuse
  - forwarded `--reporter=json --outputFile=tmp.json` making reusable single-phase public adapters such as `test:unit` execute fresh work instead of reusing a baseline
  - forwarded `--reporter=json --outputFile tmp.json` making reusable single-phase public adapters such as `test:unit` execute fresh work instead of reusing a baseline
  - file-targeted single-phase public adapters such as `test:unit`, `test:client`, `test:client:all`, `test:integration`, and `test:server:without-logger` delegating upstream when trailing args resolve to real fixture files
  - mixed adapters such as `check` and `verify` forwarding allowlisted presentation flags only to the nested Vitest phase, never to `build` or `typecheck`
  - mixed adapters such as `check` and `verify` rejecting forwarded coverage flags with an actionable error
  - aggregate adapters such as `test`, `test:all`, and `test:server:all` rejecting false-valued non-allowlisted suite-shaping flags such as `--coverage=false` and `--coverage.enabled false`
  - aggregate adapters rejecting `--outputFile` until explicit per-phase remapping or artifact-merge semantics exist
  - mixed adapters rejecting `--outputFile` in both `--outputFile=tmp.json` and `--outputFile tmp.json` forms
  - aggregate and mixed adapters rejecting other non-allowlisted forwarded flags such as `--isolate=false`, `--bail=0`, and `--maxWorkers=1`
  - `check` whole-workload reuse
  - `verify` gated but never reusable
  - `test:coverage` gated but never reusable
  - raw `npx vitest --run --coverage` gated but never reusable
  - raw `npx vitest --run --coverage true` gated but never reusable
  - raw `npx vitest --run --coverage.enabled` gated but never reusable
  - raw `npx vitest --run --coverage.enabled true` gated but never reusable
  - raw `npx vitest --run --coverage=true` gated but never reusable
  - raw `npx vitest --run --coverage.enabled=true` gated but never reusable
  - raw `npx vitest --run --reporter=json --outputFile=tmp.json` and `npx vitest --run --reporter=json --outputFile tmp.json` executing fresh work instead of reusing a baseline
  - raw `npx vitest --run --coverage false` and `--coverage.enabled false` not being misclassified as coverage-bearing
  - raw `npx vitest --run --coverage=false` and `--coverage.enabled=false` not being misclassified as coverage-bearing
  - every file-targeted delegation case in this task uses the same real resolved fixture paths or explicit injected resolver seam from Task 1; no synthetic placeholder strings are allowed
  - targeted file-only invocations with false-valued coverage flags staying delegated instead of becoming broad
  - `test` and `test:all` preserving the split `client-all -> server-all`
  - `test:server:all` preserving the split `without-logger -> logger-separation`
  - split aggregates aborting remaining phases on first failure
  - raw `npx vitest` default-mode gating in non-interactive execution
  - raw `npx vitest --run` one-shot classification and delegation cases
  - `--config/-c` plus file-only selectors staying delegated for targeted server loops
  - `-c`, `--root`, `--dir`, and repeated `--project` feeding `suiteKey`
  - non-test operational raw Vitest flags bypassing the gate
  - nested-cwd raw Vitest interception
  - adapter-owned Vitest child phases bypassing the patched entrypoint instead of self-contenting
  - disposable common-dir isolation so no test touches the live repo `.git`
  - contended output stream split: JSON only on stdout, human message on stderr
  - aggregate-adapter positional selectors and suite-shaping flags rejecting with a clear error instead of being fanned out ambiguously
  - summary propagation from env and flag

- [ ] **Step 2: Run the targeted gate verification suite during implementation**

  Until Task 5 is complete, do not run the real full-suite commands. Before Task 5 creates the patched-Vitest integration test, run only:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts \
    test/unit/server/coding-cli/utils.test.ts \
    test/unit/server/test-run-classification.test.ts \
    test/unit/server/test-run-gate-state.test.ts \
    test/unit/server/test-run-baselines.test.ts \
    test/unit/server/test-run-adapters.test.ts \
    test/integration/server/broad-one-shot-test-run.test.ts
  ```

  After Task 5 creates `test/integration/server/vitest-patch-adapter.test.ts`, extend the targeted suite to:

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts \
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
  npm test
  npm run test:all
  npm run test:server:all
  npm run test:server:without-logger
  npm run test:server:logger-separation
  npm run test:coverage
  npm run check
  npm run verify
  ```

  Expected:
  - the split current-main script surface still works after rewiring
  - `logger.separation` still runs with its special single-fork flags
  - `test:coverage` still produces fresh coverage output
  - `verify` still performs a fresh build
  - `check` and the reusable pure-test suites remain eligible for exact-match opt-in baseline reuse only

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

- The plan targets the current merge-surface scripts from `main`, not the stale worktree manifest.
- `BroadOneShotTestRun` is the single primitive for all gated broad work.
- Every entrypoint classifies to exactly one outcome: `delegate upstream` or `gated broad run`.
- Bare raw `vitest` is classified by effective watch mode, not assumed to be interactive.
- Bare raw `vitest --run` is covered explicitly and maps through the same one-shot rules as `vitest run`.
- `flock` is the only liveness truth.
- Missing or corrupt holder metadata yields `running-undescribed`, not a deadlock or false idle.
- Holder and results files are written atomically.
- `suiteKey` drives reuse; `commandKey` is provenance only.
- Exact reusable identity includes `arch` as well as commit, cleanliness, node version, and platform.
- The newest exact result wins; a newer failure blocks reuse of older success.
- Unknown broad suite flags disable reuse but do not skip gating.
- Coverage-bearing raw runs are gated but never reusable.
- Coverage-bearing raw runs are non-reusable for all coverage-enabling flag forms, not just literal `--coverage`.
- `--outputFile`-bearing invocations are artifact-producing and non-reusable on raw and reusable single-phase public paths.
- False-valued coverage forms such as `--coverage false` and `--coverage.enabled false` are not treated as coverage-bearing.
- False-valued coverage forms such as `--coverage false`, `--coverage=false`, `--coverage.enabled false`, and `--coverage.enabled=false` are not treated as coverage-bearing.
- False-valued coverage forms such as `--coverage false`, `--coverage=false`, `--coverage.enabled false`, and `--coverage.enabled=false` also do not broaden otherwise narrow/file-targeted invocations.
- File-targeted narrow-run tests use real resolved fixture paths or an explicit injected resolution seam; the plan does not permit placeholder-path heuristics.
- Rewritten broad npm scripts preserve trailing args after `--` and forward them through classification and upstream execution.
- Delegated public scripts still pass through wrapper classification, so trailing args cannot turn them into ungated broad runs.
- Aggregate and mixed adapters reject forwarded suite-shaping flags and positional selectors instead of guessing how to fan them out.
- Aggregate and mixed adapters also reject other non-allowlisted forwarded semantic flags, including false-valued forms such as `--isolate=false`, `--bail=0`, and `--maxWorkers=1`.
- Aggregate adapters duplicate only the frozen presentation-flag allowlist: `--reporter`, `--silent`, `--color`, `--no-color`, `--tty`, and `--clearScreen`.
- Mixed adapters also accept only that same frozen presentation-flag allowlist on their nested Vitest phase, and Task 4 plus Task 6 prove that those flags reach only the nested Vitest phase, never `build` or `typecheck`.
- Aggregate and mixed adapters reject `--outputFile` and other non-allowlisted forwarded semantic flags, including false-valued coverage forms such as `--coverage=false` and `--coverage.enabled false`.
- Non-test operational raw Vitest modes and flags bypass the gate instead of being coerced into broad test runs.
- `--config/-c` plus file-only selectors stay delegated so targeted server one-shots do not hit the broad gate.
- File-targeted public single-phase adapters stay delegated when trailing args resolve to files and no broad selector is present.
- When those public single-phase adapters delegate, forwarded file selectors replace the adapter’s default broad positional selector set while preserving non-selector defaults such as config, pool, and the logger exclusion.
- `test`, `test:all`, and `test:server:all` preserve the current split phase contracts from `main`.
- `test:server:logger-separation` keeps its current single-fork isolation flags.
- `test:coverage` and `verify` are gated but never reusable.
- `check` preserves its full contract and is reusable only as a whole exact workload.
- Raw `vitest` interception has a non-recursive upstream path and works from nested directories.
- New gate tests use a disposable common-dir seam and are proven not to touch the live repo `.git`.
- The drift guard is enforced by a literal `package.json` contract test, not just by manual review.
- All server-side TDD and verification commands run under `vitest.server.config.ts`, so the plan’s test loops are executable.
- `--force-run` bypasses reuse only and never weakens serialization.
- Contended runs emit machine-readable JSON on stdout and human prose on stderr.
- Adapter-launched Vitest phases always set the upstream-bypass env marker, so they cannot self-contend against the patched entrypoint.
- Baseline reuse never happens unless the caller explicitly opts in with `--reuse-baseline`.
- Split-phase adapters preserve fail-fast `&&` semantics and stop on the first failing phase.
- Watch/UI/file-targeted and other delegated paths are covered and proven to avoid gate side effects.
- Contended broad runs fail fast with exit code `75` and truthful holder status.
