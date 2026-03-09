# Unified Test Run Gate And Baseline Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build one repo-owned test-run entry system that serializes broad one-shot test workloads, reports truthful live holder metadata, and exposes reusable last-run results without weakening the existing public test command contracts.

**Architecture:** All supported test entrypoints converge on one repo-owned runner. Public `npm` scripts call that runner directly, and raw `npx vitest` is captured safely by adding a root-package `bin.vitest` wrapper instead of mutating `node_modules`. The runner classifies each invocation into either `delegate upstream` or `gated broad run`; only gated broad runs acquire a repo-wide `flock`, write advisory holder metadata, and consult exact-match reusable baselines.

**Tech Stack:** Node.js, TypeScript, `tsx`, npm scripts, root-package `bin`, `child_process`, `fs/promises`, Git CLI, Linux/WSL `flock`, Vitest 3.

---

## Strategy Gate

The previous plan was solving the right user problem with the wrong interception layer. Patching `node_modules/vitest` is not safe in this repo because worktrees can share `node_modules`, and a worktree-local patch can break `main` before merge. The steady-state architecture here is:

- repo-owned wrapper for every public test script
- repo-owned root-package `bin.vitest` for `npx vitest` and `npm exec vitest`
- no vendor mutation, no `postinstall`, no `patch-package`
- `flock` as the only serialization truth
- process inspection only as optional diagnostics, never as the lock primitive

That covers the real high-frequency entrypoints, is easy for agents to use, and is hard to bypass accidentally. Deliberate bypasses such as `./node_modules/.bin/vitest` or `node node_modules/vitest/vitest.mjs` remain unsupported and out of policy; the implementation should not pretend to fully police them.

## Frozen Invariants

- Preserve the current public test command names and behavior contracts on `main`, while repointing their implementations through the repo-owned runner:
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
- Add `test:status` as the single public read path for live-holder status and cached last-run results.
- Do not add `postinstall`, `patch-package`, dependency swaps, or any other install-time mutation of shared `node_modules`.
- The only supported serialized entrypoints are:
  - the public `npm run test*`, `npm run check`, and `npm run verify` commands above
  - `npx vitest ...` and `npm exec vitest ...` launched from the repo root or any descendant directory
- The supported-entrypoint guarantee must be implemented without modifying `node_modules/.bin`; the root package must own the interception path.
- `flock` is the only liveness truth. Holder files, result files, and process inspection never override the lock probe.
- Holder metadata and result metadata are advisory, schema-validated, and crash-tolerant. Missing, partial, corrupt, stale, or unreadable metadata must never block progress.
- Every invocation must classify to exactly one of:
  - `delegate upstream`
  - `gated broad run`
- `delegate upstream` means:
  - no lock acquisition
  - no holder write
  - no baseline reuse
  - no status side effects
- `gated broad run` means:
  - repo discovery from invocation cwd
  - repo-wide non-blocking `flock`
  - holder metadata written only after lock acquisition
  - optional exact baseline reuse only when the invocation is marked reusable and the caller explicitly asked for reuse
- `--force-run` skips reuse only. It never bypasses lock acquisition.
- The runner must never silently wait. Lock contention exits immediately with code `75`.
- On contention, stdout must emit the same JSON payload as `test:status`, stderr must emit one short human line explaining that another broad run is active, and no child workload may start.
- Do not run a full suite until the gate is implemented. During development, use targeted tests only; `npm test`, `npm run check`, and `npm run verify` are end-of-work verification only.

## User-Facing Metadata Contract

### Holder Record

`test:status` and contention output must expose a `holder` object with this exact required schema for the `running-described` state:

```json
{
  "schemaVersion": 1,
  "summary": "Fix terminal attach ordering regression",
  "summarySource": "cli|env|default",
  "startedAt": "2026-03-09T17:41:22.000Z",
  "pid": 12345,
  "hostname": "devbox",
  "username": "user",
  "entrypoint": {
    "kind": "public-script|raw-vitest",
    "commandKey": "test",
    "display": "npm test"
  },
  "suiteKey": "full-suite",
  "command": {
    "display": "npm test -- --reuse-baseline",
    "argv": ["npm", "test", "--", "--reuse-baseline"]
  },
  "repo": {
    "invocationCwd": "/home/user/code/freshell/.worktrees/test-run-gate",
    "checkoutRoot": "/home/user/code/freshell/.worktrees/test-run-gate",
    "worktreePath": "/home/user/code/freshell/.worktrees/test-run-gate",
    "commonDir": "/home/user/code/freshell/.git",
    "branch": "feature/test-run-gate",
    "commit": "abc1234",
    "cleanWorktree": true
  },
  "runtime": {
    "nodeVersion": "v22.10.2",
    "platform": "linux",
    "arch": "x64"
  },
  "agent": {
    "kind": "codex|claude|unknown",
    "sessionId": "optional string or null",
    "threadId": "optional string or null"
  }
}
```

Rules:

- `sessionId` and `threadId` are nullable, but the keys are required.
- `running-described` is allowed only when every other field above is present and type-valid.
- If the lock is held and the holder file is missing, unreadable, corrupt, or missing any required field, status must fall back to `running-undescribed` with no fabricated partial holder object.
- Summary collection order is frozen:
  - explicit `--summary "<text>"`
  - `FRESHELL_TEST_SUMMARY`
  - command default summary
- Agent metadata collection order is frozen:
  - `agent.kind = codex` when `CODEX_THREAD_ID` is present
  - `agent.kind = claude` when `CLAUDE_SESSION_ID` or `CLAUDE_THREAD_ID` is present
  - otherwise `agent.kind = unknown`
  - `sessionId` and `threadId` are filled from the matching environment variables when present; otherwise `null`

### Status Payload

`npm run test:status -- [options]` must print exactly one JSON object to stdout and exit `0` on successful queries:

```json
{
  "schemaVersion": 1,
  "state": "idle|running-described|running-undescribed",
  "holder": {},
  "target": {
    "commandKey": "test",
    "suiteKey": "full-suite"
  },
  "latestRun": {},
  "latestReusableSuccess": {},
  "latestFailure": {}
}
```

Rules:

- `holder` is present only for `running-described`.
- `target`, `latestRun`, `latestReusableSuccess`, and `latestFailure` are present only when the caller supplied a concrete target, for example `--command test`.
- `latestRun`, `latestReusableSuccess`, and `latestFailure` are either full result records or `null`.
- Internal errors exit nonzero and do not fabricate a status object.

### Result Record

Every gated broad run must persist a result record with this required schema:

```json
{
  "schemaVersion": 1,
  "status": "passed|failed",
  "exitCode": 0,
  "startedAt": "2026-03-09T17:41:22.000Z",
  "finishedAt": "2026-03-09T17:45:10.000Z",
  "durationMs": 228000,
  "summary": "Fix terminal attach ordering regression",
  "summarySource": "cli|env|default",
  "entrypoint": {
    "kind": "public-script|raw-vitest",
    "commandKey": "test",
    "display": "npm test"
  },
  "suiteKey": "full-suite",
  "command": {
    "display": "npm test -- --reuse-baseline",
    "argv": ["npm", "test", "--", "--reuse-baseline"]
  },
  "repo": {
    "invocationCwd": "/home/user/code/freshell/.worktrees/test-run-gate",
    "checkoutRoot": "/home/user/code/freshell/.worktrees/test-run-gate",
    "worktreePath": "/home/user/code/freshell/.worktrees/test-run-gate",
    "commonDir": "/home/user/code/freshell/.git",
    "branch": "feature/test-run-gate",
    "commit": "abc1234",
    "cleanWorktree": true
  },
  "runtime": {
    "nodeVersion": "v22.10.2",
    "platform": "linux",
    "arch": "x64"
  },
  "agent": {
    "kind": "codex|claude|unknown",
    "sessionId": "optional string or null",
    "threadId": "optional string or null"
  },
  "reusable": true,
  "reuseReason": "exact-clean-match|coverage-disabled|command-policy-disabled|dirty-worktree|runtime-mismatch|newer-failure"
}
```

Rules:

- Persist result metadata outside source control under the git common-dir so all worktrees share it.
- The store layout may be implementation-defined, but it must be able to answer `latestRun`, `latestReusableSuccess`, and `latestFailure` for a target without scanning unrelated repos.
- Reusable-baseline identity is frozen to:
  - `suiteKey`
  - `repo.commit`
  - `repo.cleanWorktree = true`
  - `runtime.nodeVersion`
  - `runtime.platform`
  - `runtime.arch`
- `latestReusableSuccess` is valid only when it matches the exact identity above and there is no newer exact-identity failure.
- `check` may reuse only an exact prior `check` success for the full `check` workload.
- `verify` and `test:coverage` are never reusable.

## Classification Policy

- Delegate upstream unconditionally for:
  - `--help`, `-h`, `--version`, `-v`
  - `--watch`, `-w`
  - `--ui`
  - raw Vitest subcommands `watch`, `dev`, `related`, `bench`
  - raw operational modes such as `--standalone` and `--mergeReports`
- Resolve invocation cwd from `INIT_CWD ?? process.cwd()`.
- Resolve the checkout root and git common-dir from Git, not from path heuristics alone.
- Treat positional selectors as file-targeted only when they resolve to real files from the invocation cwd or an explicit test seam. Do not use filename suffix heuristics.
- Narrow delegated runs include:
  - raw `vitest <file>`
  - raw `vitest run <file>`
  - raw `vitest --run <file>`
  - public single-phase adapters with file-only forwarded selectors
  - `test:watch` and `test:server` when effective watch mode is true
- Broad gated runs include:
  - one-shot runs with no selectors
  - directory targets
  - glob targets
  - `--project`, `--dir`, `-t/--testNamePattern`, `--changed`, `--exclude`, `--environment`, `--shard`
  - any truthy coverage form
  - current aggregate adapters `test`, `test:all`, `test:server:all`, `check`, and `verify`
  - current single-phase broad adapters `test:unit`, `test:integration`, `test:client`, `test:client:all`, `test:server` when effective watch mode is false, `test:server:without-logger`, and `test:coverage`
- False-valued coverage forms such as `--coverage=false` and `--coverage.enabled false` do not broaden an otherwise narrow file-targeted run.
- Aggregate and mixed adapters may forward only this safe duplicated flag set across phases:
  - `--silent`
  - `--color`
  - `--no-color`
  - `--tty`
  - `--clearScreen`
- Aggregate and mixed adapters must reject forwarded suite-shaping flags, selectors, `--outputFile`, and `--reporter` with an actionable error instead of guessing how to split them.
- Unknown raw subcommands default to `delegate upstream`.
- Unknown broad-looking flags may still run as gated broad work, but baseline reuse must be disabled instead of guessed.

## File Structure

**Modify**

- `package.json`
  - add root-package `bin.vitest`
  - repoint public test commands through the repo-owned runner
  - add `test:status`
- `docs/skills/testing.md`
  - document `test:status`, `FRESHELL_TEST_SUMMARY`, `--summary`, `--reuse-baseline`, and the supported entrypoints policy
- `server/coding-cli/utils.ts`
  - add shared invocation-cwd and git-common-dir helpers
- `test/unit/server/coding-cli/utils.test.ts`

**Create**

- `scripts/testing/test-runner.ts`
  - shared CLI entry for public commands and status queries
- `scripts/testing/test-run-classification.ts`
  - total classification logic and forwarded-argv policy
- `scripts/testing/test-run-gate-state.ts`
  - lock path discovery, atomic holder/result IO, status assembly
- `scripts/testing/test-run-baselines.ts`
  - exact-match reusable-baseline lookup and result-store helpers
- `scripts/testing/test-run-adapters.ts`
  - public command manifest, default summaries, suite keys, and reuse policy
- `scripts/testing/test-run-upstream.ts`
  - upstream process spawning for real Vitest, build, typecheck, and npm phases
- `scripts/testing/vitest-bin.mjs`
  - repo-owned raw `vitest` entrypoint that forwards into `test-runner.ts`
- `test/fixtures/test-run-gate/fake-upstream.ts`
  - controllable fake workload for integration tests
- `test/fixtures/test-run-gate/file-targets.ts`
  - real files for file-target classification cases
- `test/fixtures/test-run-gate/temp-gate-env.ts`
  - disposable temp common-dir and temp repo fixtures
- `test/unit/server/test-run-classification.test.ts`
- `test/unit/server/test-run-gate-state.test.ts`
- `test/unit/server/test-run-baselines.test.ts`
- `test/unit/server/test-run-adapters.test.ts`
- `test/integration/server/test-runner.test.ts`
- `test/integration/server/vitest-bin.test.ts`

## Task 1: Repo Discovery And Metadata Contract

**Files:**

- Modify: `server/coding-cli/utils.ts`
- Modify: `test/unit/server/coding-cli/utils.test.ts`
- Create: `test/unit/server/test-run-gate-state.test.ts`

- [ ] **Step 1: Write the failing tests**
  - Cover `resolveInvocationCwd()` using `INIT_CWD` first.
  - Cover `resolveGitCommonDir()` returning the shared `.git` dir for a linked worktree.
  - Cover holder schema validation:
    - valid full holder record -> `running-described`
    - lock held plus missing holder file -> `running-undescribed`
    - lock held plus partial holder file -> `running-undescribed`
  - Cover status payload shape with `holder`, `target`, `latestRun`, `latestReusableSuccess`, and `latestFailure`.

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-run-gate-state.test.ts
  ```

- [ ] **Step 3: Implement the helpers and metadata validators**
  - Add `resolveInvocationCwd()` and `resolveGitCommonDir()` to `server/coding-cli/utils.ts`.
  - Add gate-state schemas and atomic IO helpers in `scripts/testing/test-run-gate-state.ts`.
  - Make the status builder lock-first and metadata-second.

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-run-gate-state.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add server/coding-cli/utils.ts test/unit/server/coding-cli/utils.test.ts scripts/testing/test-run-gate-state.ts test/unit/server/test-run-gate-state.test.ts
  git commit -m "test: add gate metadata contract"
  ```

## Task 2: Classification, Adapter Policy, And Baseline Semantics

**Files:**

- Create: `scripts/testing/test-run-classification.ts`
- Create: `scripts/testing/test-run-adapters.ts`
- Create: `scripts/testing/test-run-baselines.ts`
- Create: `test/fixtures/test-run-gate/file-targets.ts`
- Create: `test/unit/server/test-run-classification.test.ts`
- Create: `test/unit/server/test-run-adapters.test.ts`
- Create: `test/unit/server/test-run-baselines.test.ts`

- [ ] **Step 1: Write the failing tests**
  - Cover raw `vitest` help/version passthrough.
  - Cover explicit `--watch/-w` precedence even in `CI=1`.
  - Cover file-targeted delegation using real fixture files.
  - Cover broad gating for no-selector, directory, glob, project, changed, exclude, environment, shard, and truthy coverage cases.
  - Cover aggregate-adapter rejection of forwarded selectors, `--reporter`, and `--outputFile`.
  - Cover exact reusable-baseline identity matching and newer-failure invalidation.
  - Cover `check` exact-whole-command reuse and `verify`/`test:coverage` non-reuse.

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-run-classification.test.ts test/unit/server/test-run-adapters.test.ts test/unit/server/test-run-baselines.test.ts
  ```

- [ ] **Step 3: Implement classification, adapter manifest, and reusable-baseline lookup**
  - Make classification total and binary.
  - Freeze the public adapter manifest to the current script surface above.
  - Add exact reusable-baseline identity logic and status-facing last-result selectors.

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-run-classification.test.ts test/unit/server/test-run-adapters.test.ts test/unit/server/test-run-baselines.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/test-run-classification.ts scripts/testing/test-run-adapters.ts scripts/testing/test-run-baselines.ts test/fixtures/test-run-gate/file-targets.ts test/unit/server/test-run-classification.test.ts test/unit/server/test-run-adapters.test.ts test/unit/server/test-run-baselines.test.ts
  git commit -m "test: classify gated test workloads"
  ```

## Task 3: Unified Runner, Locking, And Status

**Files:**

- Create: `scripts/testing/test-runner.ts`
- Create: `scripts/testing/test-run-upstream.ts`
- Create: `test/fixtures/test-run-gate/fake-upstream.ts`
- Create: `test/fixtures/test-run-gate/temp-gate-env.ts`
- Create: `test/integration/server/test-runner.test.ts`

- [ ] **Step 1: Write the failing integration tests**
  - Cover idle `test:status`.
  - Cover broad-run lock acquisition and holder write.
  - Cover contention exit `75` with status JSON on stdout and one human line on stderr.
  - Cover holder cleanup on success and failure.
  - Cover result persistence for pass and fail.
  - Cover `--reuse-baseline` hit only on exact reusable success.
  - Cover `--force-run` skipping reuse but still respecting the lock.

- [ ] **Step 2: Run the targeted integration test and verify it fails**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-runner.test.ts
  ```

- [ ] **Step 3: Implement the runner**
  - Parse public-command mode, raw-vitest mode, and status mode.
  - Acquire non-blocking `flock` only for classified broad runs.
  - Write holder metadata only after lock acquisition.
  - Execute real upstream commands through absolute program/module paths, not recursive `vitest` command spawning.
  - Persist result records and expose targeted last-result views for `test:status`.

- [ ] **Step 4: Re-run the targeted integration test and verify it passes**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-runner.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/test-runner.ts scripts/testing/test-run-upstream.ts test/fixtures/test-run-gate/fake-upstream.ts test/fixtures/test-run-gate/temp-gate-env.ts test/integration/server/test-runner.test.ts
  git commit -m "test: add unified broad-run gate runner"
  ```

## Task 4: Safe Raw `npx vitest` Interception And Public Script Wiring

**Files:**

- Modify: `package.json`
- Create: `scripts/testing/vitest-bin.mjs`
- Create: `test/integration/server/vitest-bin.test.ts`

- [ ] **Step 1: Write the failing integration tests**
  - Cover `npx vitest --help` delegating upstream through the repo-owned root-package binary.
  - Cover `npx vitest run` entering the same gated path as public broad runs.
  - Cover `npx vitest run <file>` delegating upstream.
  - Cover `npx vitest` launched from a nested repo directory still resolving the root-package `bin.vitest`.
  - Cover public scripts `test`, `check`, `verify`, `test:unit`, `test:server`, and `test:status` invoking the repo-owned runner instead of the dependency binary directly.

- [ ] **Step 2: Run the targeted integration tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/vitest-bin.test.ts
  ```

- [ ] **Step 3: Implement the safe raw-entrypoint path**
  - Add `bin.vitest = scripts/testing/vitest-bin.mjs` to the root package.
  - Make `scripts/testing/vitest-bin.mjs` forward into `test-runner.ts`.
  - Repoint the public test scripts through `test-runner.ts` so every supported path reaches the same classification and gate logic.
  - Keep `freshell` as an existing root-package bin.
  - Do not change `node_modules`, `.bin`, or `package-lock.json`.

- [ ] **Step 4: Re-run the targeted integration tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/vitest-bin.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add package.json scripts/testing/vitest-bin.mjs test/integration/server/vitest-bin.test.ts
  git commit -m "test: route public and raw vitest entrypoints through gate"
  ```

## Task 5: Docs And Final Verification

**Files:**

- Modify: `docs/skills/testing.md`

- [ ] **Step 1: Update the testing docs**
  - Document the supported entrypoints.
  - Document `test:status`.
  - Document `FRESHELL_TEST_SUMMARY`, `--summary`, `--reuse-baseline`, and `--force-run`.
  - Explicitly mark direct vendor-path execution as unsupported.

- [ ] **Step 2: Run the focused test set covering all new code**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-run-classification.test.ts test/unit/server/test-run-gate-state.test.ts test/unit/server/test-run-baselines.test.ts test/unit/server/test-run-adapters.test.ts test/integration/server/test-runner.test.ts test/integration/server/vitest-bin.test.ts
  ```

- [ ] **Step 3: Run the public command smoke checks now that the gate exists**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npm run test:status -- --command test
  FRESHELL_TEST_SUMMARY="plan verification" npm run test -- --force-run
  FRESHELL_TEST_SUMMARY="plan verification" npm run check -- --force-run
  FRESHELL_TEST_SUMMARY="plan verification" npm run verify -- --force-run
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add docs/skills/testing.md
  git commit -m "docs: document gated test entrypoints"
  ```

## Acceptance Criteria

- `npm run test:status -- --command test` reports live holder state truthfully and exposes last-run results with the frozen schema.
- Waiting agents can identify who owns a running broad test run, which worktree and branch it came from, which session/thread to resume when available, and what user-directed summary was supplied.
- Public broad runs serialize through one repo-wide `flock` shared across worktrees.
- `npx vitest` from the repo root or a descendant directory uses the repo-owned wrapper without patching `node_modules`.
- Broad reusable-baseline hits are exact-identity only and opt-in only.
- `verify` and `test:coverage` always execute fresh work.
- No vendor-code mutation, `postinstall`, or shared-`node_modules` patching is introduced.
