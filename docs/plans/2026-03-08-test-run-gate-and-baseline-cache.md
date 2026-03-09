# Unified Test Coordination And Advisory Baselines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build one repo-owned test coordination system that serializes broad one-shot test workloads, shows truthful active-holder status, and records advisory exact-commit baselines without weakening the requirement for a fresh `npm test` before landing.

**Architecture:** Replace the fragile `postinstall` mutation approach with a source-controlled local `vitest` wrapper package plus a single TypeScript coordinator CLI. Public npm test entrypoints and raw local `vitest` invocations both normalize into the same workload classifier, while a dedicated locked-runner subcommand executes coordinated workloads under `flock` so kernel lock state is the only liveness truth and holder JSON remains purely advisory.

**Tech Stack:** Node.js, TypeScript, `tsx`, npm, local file dependencies, Linux/WSL `flock`, `child_process`, `fs/promises`, Zod, Vitest.

---

## Strategy Gate

The previous plan kept collapsing back into script-name exceptions and `node_modules` patching. That was the wrong shape.

The actual problem is broader and simpler:

- agents can start the same heavy repo test workloads through multiple entrypoints
- the system has no single source of truth for whether one of those workloads is already running
- baseline knowledge is lost, so agents rerun expensive suites just to learn the inherited commit was already green

The clean steady-state answer is one execution model:

1. every public npm test command expands into a normalized coordinator request
2. every raw local `vitest` invocation enters the same coordinator through a repo-owned wrapper package
3. the coordinator classifies the normalized invocation by workload shape, not by script name
4. coordinated workloads run only through a `flock`-owned locked runner
5. holder metadata and result history live in the Git common-dir shared by all worktrees

That satisfies the user’s one-shot requirement directly. It does not rely on documentation-only behavior, stale sentinel files, or special-case exemptions for “raw” runs.

## Frozen Design Decisions

### 1. Coordination Boundary

The governing invariant is workload shape after adapter expansion, not the original entrypoint name.

- `delegated`: help/version/status and explicitly interactive flows
- `coordinated`: canonical one-shot suites and untargeted raw one-shot runs
- `rejected`: forwarded-arg combinations whose semantics cannot be applied truthfully

Canonical coordinated suites in v1:

| suiteKey | Normalized workload |
| --- | --- |
| `full-suite` | client one-shot suite, then server one-shot suite |
| `client-all` | `vitest run` with default client config and no narrowing selectors |
| `server-all` | `vitest run --config vitest.server.config.ts` with no narrowing selectors |
| `client-coverage` | `vitest run --coverage` with no narrowing selectors |
| `unit-all` | `vitest run test/unit` with no additional narrowing selectors |
| `integration-all` | `vitest run --config vitest.server.config.ts test/server` with no additional narrowing selectors |
| `client-unit-all` | `vitest run test/unit/client` with no additional narrowing selectors |

Delegated narrowed forms in v1:

- positional file or directory targets that do not exactly match a canonical suite shape
- `-t`, `--testNamePattern`
- `--project`
- `--changed`
- `--watch`, `-w`
- `--ui`

Rejected forwarded forms in v1:

- composite commands (`test`, `test:all`, `check`, `verify`) with Vitest flags that cannot be duplicated truthfully across both phases
- `--reporter <value>` on composite commands

### 2. `flock` Is The Only Liveness Truth

- the coordinator never infers liveness from a JSON file
- active/idle detection comes from non-blocking `flock` acquisition attempts only
- coordinated work executes in a dedicated locked-runner subprocess launched under `flock`
- if holder metadata is missing, corrupt, partial, or stale while the lock is held, status must say `running-undescribed`
- if holder metadata exists while the lock is free, it is advisory garbage and must be ignored or overwritten

### 3. Raw Local Vitest Must Be Repo-Owned

Do **not** patch `node_modules/vitest/vitest.mjs` in `postinstall`.

Replace the root devDependency on `vitest` with a source-controlled local wrapper package:

- root `package.json` points `vitest` at `file:tools/vitest-wrapper`
- the wrapper package exposes the `vitest` binary
- the wrapper package re-exports the upstream library APIs the repo actually consumes:
  - `vitest`
  - `vitest/config`
- the wrapper package depends on the real upstream package through an npm alias such as `@freshell/vitest-upstream`

That keeps the interception mechanism inside source control, recorded in `package-lock.json`, and safe across shared or symlinked worktrees because it no longer mutates a shared dependency installation in place.

### 4. Public CLI Contract Is Explicit

Public commands are adapters, not special cases. They expand into normalized requests, then the classifier decides coordinated/delegated/rejected behavior.

| Public command | Adapter expansion | Classification rules |
| --- | --- | --- |
| `npm test` | `full-suite` composite | coordinated |
| `npm run test:all` | `full-suite` composite | coordinated |
| `npm run check` | `typecheck`, then `full-suite` | typecheck delegated, test phase coordinated |
| `npm run verify` | `build`, then `full-suite` | build delegated, test phase coordinated |
| `npm run test:coverage` | `vitest run --coverage` | coordinated `client-coverage` |
| `npm run test:unit` | `vitest run test/unit` | coordinated `unit-all` unless further narrowed |
| `npm run test:integration` | `vitest run --config vitest.server.config.ts test/server` | coordinated `integration-all` unless further narrowed |
| `npm run test:client` | `vitest run test/unit/client` | coordinated `client-unit-all` unless further narrowed |
| `npm run test:server` | `vitest --config vitest.server.config.ts` | delegated by default; `--run` with no narrowing becomes coordinated `server-all` |
| `npm run test:watch` | `vitest` | delegated |
| `npm run test:ui` | `vitest --ui` | delegated |
| `npm run test:status` | coordinator status mode | delegated status-only |

Forwarded-arg contract:

- `--summary "<text>"` and `FRESHELL_TEST_SUMMARY` are coordinator-owned and valid on every public coordinated command
- `--help`, `-h`, `--version`, `-v` always return coordinator help/version for public coordinator entrypoints and upstream Vitest help/version for Vitest-facing entrypoints
- `npm run test:server -- --run` is valid and becomes `server-all`
- `npm test -- --run` is accepted as a no-op compatibility alias because `test` already implies one-shot mode
- composite commands reject forwarded flags that cannot be applied truthfully to both phases

### 5. Advisory Baselines Are Exact-Match And Non-Authoritative

Reusable baseline identity is frozen to:

- `suiteKey`
- `repo.commit`
- `repo.cleanWorktree = true`
- `runtime.nodeVersion`
- `runtime.platform`
- `runtime.arch`

Status/history views must keep these records separate:

- `latestCommandRun`
- `latestCommandFailure`
- `latestSuiteRun`
- `latestSuiteFailure`
- `latestReusableSuccess`

Rules:

- a later failure must not erase an earlier reusable success for the same reusable identity
- reusable baselines are advisory only
- the coordinator may show that an inherited exact-match success exists
- the coordinator must not auto-succeed `test`, `check`, or `verify`
- the repo rule requiring a fresh `npm test` before landing remains unchanged

### 6. Wait Semantics Are Fixed

For coordinated workloads:

- try the lock immediately
- if busy, print holder info when available
- print the current time and poll once per minute
- wait up to one hour
- never kill a run the current process did not start
- exit nonzero only on timeout or internal failure

## Data And Runtime Contracts

### Shared Store Location

Store coordination data under the Git common-dir so all linked worktrees see the same state:

- lock file
- advisory holder record
- command-history records
- suite-history records

Use helpers that resolve:

- invocation cwd
- checkout root
- repo root
- Git common-dir
- branch
- commit
- dirty state

### Holder Record

Persist only after the locked runner has acquired `flock`.

Required fields:

- `schemaVersion`
- `summary`
- `summarySource`
- `startedAt`
- `pid`
- `hostname`
- `username`
- `entrypoint.kind`
- `entrypoint.commandKey`
- `entrypoint.suiteKey`
- `command.display`
- `command.argv`
- `repo.invocationCwd`
- `repo.checkoutRoot`
- `repo.repoRoot`
- `repo.worktreePath`
- `repo.commonDir`
- `repo.branch`
- `repo.commit`
- `repo.cleanWorktree`
- `runtime.nodeVersion`
- `runtime.platform`
- `runtime.arch`
- `agent.kind`
- `agent.sessionId`
- `agent.threadId`

Agent metadata precedence:

- Codex: `CODEX_THREAD_ID`
- Claude: `CLAUDE_SESSION_ID`, then `CLAUDE_THREAD_ID`
- otherwise `unknown`

### Result Records

Persist command-scoped and suite-scoped result records separately.

Each record stores:

- `status`
- `exitCode`
- `startedAt`
- `finishedAt`
- `durationMs`
- summary and agent metadata
- repo identity
- runtime identity

Suite records additionally store:

- `reusable`
- `source.kind`
- `source.commandKey`

## File Plan

**Modify**

- `package.json`
- `package-lock.json`
- `AGENTS.md`
- `docs/skills/testing.md`
- `server/coding-cli/utils.ts`
- `test/unit/server/coding-cli/utils.test.ts`

**Create**

- `scripts/testing/test-coordinator.ts`
- `scripts/testing/test-coordinator-manifest.ts`
- `scripts/testing/test-coordinator-store.ts`
- `scripts/testing/test-coordinator-status.ts`
- `scripts/testing/test-coordinator-upstream.ts`
- `scripts/testing/test-coordinator-locked-runner.ts`
- `tools/vitest-wrapper/package.json`
- `tools/vitest-wrapper/vitest.mjs`
- `tools/vitest-wrapper/index.js`
- `tools/vitest-wrapper/index.d.ts`
- `tools/vitest-wrapper/config.js`
- `tools/vitest-wrapper/config.d.ts`
- `test/fixtures/testing/fake-vitest-upstream.mjs`
- `test/fixtures/testing/fake-coordinated-workload.mjs`
- `test/fixtures/testing/temp-test-coordinator-env.ts`
- `test/unit/server/test-coordinator-manifest.test.ts`
- `test/unit/server/test-coordinator-store.test.ts`
- `test/unit/server/test-coordinator-status.test.ts`
- `test/unit/server/test-coordinator-wrapper.test.ts`
- `test/integration/server/test-coordinator.test.ts`

## Task 1: Lock The Runtime Model And Shared Store

**Files:**

- Modify: `server/coding-cli/utils.ts`
- Modify: `test/unit/server/coding-cli/utils.test.ts`
- Create: `scripts/testing/test-coordinator-store.ts`
- Create: `test/unit/server/test-coordinator-store.test.ts`

- [ ] **Step 1: Write the failing tests**
  - add coverage for `resolveInvocationCwd()` preferring `INIT_CWD`
  - add coverage for `resolveGitCommonDir()` in a linked worktree
  - add coverage for resolving checkout root, repo root, branch, commit, and dirty state from a worktree cwd
  - add store tests for atomic holder writes, command-result writes, suite-result writes, and corrupt JSON tolerance
  - add store tests proving `latestReusableSuccess` survives a newer failure for the same reusable identity

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - extend `server/coding-cli/utils.ts` with invocation cwd and Git common-dir helpers
  - implement the shared common-dir store in `scripts/testing/test-coordinator-store.ts`
  - keep lock state separate from metadata files
  - keep command history and suite history separate

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add server/coding-cli/utils.ts test/unit/server/coding-cli/utils.test.ts scripts/testing/test-coordinator-store.ts test/unit/server/test-coordinator-store.test.ts
  git commit -m "test: add shared test coordination store"
  ```

## Task 2: Freeze The Command Matrix And Status Contract

**Files:**

- Create: `scripts/testing/test-coordinator-manifest.ts`
- Create: `scripts/testing/test-coordinator-status.ts`
- Create: `test/unit/server/test-coordinator-manifest.test.ts`
- Create: `test/unit/server/test-coordinator-status.test.ts`

- [ ] **Step 1: Write the failing tests**
  - test every public command adapter listed in this plan
  - test canonical suite classification for `client-all`, `server-all`, `client-coverage`, `unit-all`, `integration-all`, and `client-unit-all`
  - test `npm run test:server -- --run` normalizing to coordinated `server-all`
  - test `npm test -- --run` behaving as an accepted compatibility no-op
  - test `--help`, `-h`, `--version`, `-v` passthrough behavior
  - test delegated narrowing selectors and interactive flags
  - test composite rejection of unsafe forwarded flags such as `--reporter`
  - test status projection for `idle`, `running`, and `running-undescribed`
  - test separate projection of command history, suite history, and reusable success

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - define the adapter manifest and suite classifier in `scripts/testing/test-coordinator-manifest.ts`
  - define the status projector and JSON schema validation in `scripts/testing/test-coordinator-status.ts`
  - make classification depend on normalized workload shape, not source command name

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/test-coordinator-manifest.ts scripts/testing/test-coordinator-status.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  git commit -m "test: define coordinated test command matrix"
  ```

## Task 3: Replace Raw Vitest With A Repo-Owned Wrapper Package

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tools/vitest-wrapper/package.json`
- Create: `tools/vitest-wrapper/vitest.mjs`
- Create: `tools/vitest-wrapper/index.js`
- Create: `tools/vitest-wrapper/index.d.ts`
- Create: `tools/vitest-wrapper/config.js`
- Create: `tools/vitest-wrapper/config.d.ts`
- Create: `test/unit/server/test-coordinator-wrapper.test.ts`

- [ ] **Step 1: Write the failing tests**
  - test that the local wrapper package re-exports `vitest`
  - test that the local wrapper package re-exports `vitest/config`
  - test that the wrapper binary forwards raw argv into the coordinator entrypoint
  - test that help/version and delegated interactive runs reach the preserved upstream path
  - test that coordinated one-shot raw runs enter the coordinator path

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-wrapper.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - replace the root `vitest` devDependency with `file:tools/vitest-wrapper`
  - add the upstream alias dependency for the real Vitest package
  - implement the wrapper package with source-controlled JS and d.ts proxy files
  - implement `tools/vitest-wrapper/vitest.mjs` so it calls the repo coordinator without mutating `node_modules`
  - update `package-lock.json` by running `npm install` inside the worktree only

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-wrapper.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add package.json package-lock.json tools/vitest-wrapper/package.json tools/vitest-wrapper/vitest.mjs tools/vitest-wrapper/index.js tools/vitest-wrapper/index.d.ts tools/vitest-wrapper/config.js tools/vitest-wrapper/config.d.ts test/unit/server/test-coordinator-wrapper.test.ts
  git commit -m "build: replace vitest with repo-owned wrapper"
  ```

## Task 4: Implement The Coordinator, Locked Runner, And Status CLI

**Files:**

- Create: `scripts/testing/test-coordinator.ts`
- Create: `scripts/testing/test-coordinator-upstream.ts`
- Create: `scripts/testing/test-coordinator-locked-runner.ts`
- Create: `test/fixtures/testing/fake-vitest-upstream.mjs`
- Create: `test/fixtures/testing/fake-coordinated-workload.mjs`
- Create: `test/fixtures/testing/temp-test-coordinator-env.ts`
- Create: `test/integration/server/test-coordinator.test.ts`

- [ ] **Step 1: Write the failing integration tests**
  - test `test:status` returning `idle` when no coordinated run owns the lock
  - test `test:status` reporting `running-undescribed` when lock acquisition fails and holder JSON is unreadable
  - test a coordinated public command acquiring the lock through the locked-runner subprocess
  - test a raw `vitest run` canonical suite acquiring the same lock through the wrapper package
  - test one coordinated run waiting behind another with once-per-minute polling output
  - test timeout after the configured one-hour budget equivalent using shortened fixture timing
  - test holder cleanup on success, failure, and coordinator exception
  - test command history vs suite history vs reusable success separation
  - test that `check` and `verify` only coordinate their test phases, not their build/typecheck phases
  - test delegated narrowed runs bypassing the lock entirely
  - test that the coordinator never kills foreign processes

- [ ] **Step 2: Run the targeted integration tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - implement CLI parsing for public-command mode, raw-wrapper mode, locked-runner mode, and status mode
  - implement non-blocking `flock` polling and the one-hour wait contract
  - launch a dedicated locked runner under `flock` so the lock lifetime belongs to the kernel-held subprocess
  - have the locked runner write holder metadata, execute the normalized workload, write results, and clean advisory metadata in `finally`
  - keep upstream delegation non-recursive

- [ ] **Step 4: Re-run the targeted integration tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/test-coordinator.ts scripts/testing/test-coordinator-upstream.ts scripts/testing/test-coordinator-locked-runner.ts test/fixtures/testing/fake-vitest-upstream.mjs test/fixtures/testing/fake-coordinated-workload.mjs test/fixtures/testing/temp-test-coordinator-env.ts test/integration/server/test-coordinator.test.ts
  git commit -m "feat: coordinate broad test workloads"
  ```

## Task 5: Wire Public Scripts And Document The Contract

**Files:**

- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `docs/skills/testing.md`

- [ ] **Step 1: Write the failing tests or assertions**
  - extend the manifest tests to assert every public npm script resolves to the intended adapter
  - add assertions that `test:status` is present
  - add assertions that raw local `vitest` still reaches the wrapper after the script rewiring

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-wrapper.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - rewire public npm scripts to the coordinator entrypoint
  - add `npm run test:status`
  - document `--summary` and `FRESHELL_TEST_SUMMARY`
  - document that coordinated runs wait rather than kill another agent’s run
  - document that exact-match reusable baselines are advisory only

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-wrapper.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add package.json AGENTS.md docs/skills/testing.md
  git commit -m "docs: publish coordinated test workflow"
  ```

## Task 6: Final Verification

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `AGENTS.md`
- Modify: `docs/skills/testing.md`
- Modify: `server/coding-cli/utils.ts`
- Modify: `test/unit/server/coding-cli/utils.test.ts`
- Create: `scripts/testing/test-coordinator.ts`
- Create: `scripts/testing/test-coordinator-manifest.ts`
- Create: `scripts/testing/test-coordinator-store.ts`
- Create: `scripts/testing/test-coordinator-status.ts`
- Create: `scripts/testing/test-coordinator-upstream.ts`
- Create: `scripts/testing/test-coordinator-locked-runner.ts`
- Create: `tools/vitest-wrapper/package.json`
- Create: `tools/vitest-wrapper/vitest.mjs`
- Create: `tools/vitest-wrapper/index.js`
- Create: `tools/vitest-wrapper/index.d.ts`
- Create: `tools/vitest-wrapper/config.js`
- Create: `tools/vitest-wrapper/config.d.ts`
- Create: `test/fixtures/testing/fake-vitest-upstream.mjs`
- Create: `test/fixtures/testing/fake-coordinated-workload.mjs`
- Create: `test/fixtures/testing/temp-test-coordinator-env.ts`
- Create: `test/unit/server/test-coordinator-manifest.test.ts`
- Create: `test/unit/server/test-coordinator-store.test.ts`
- Create: `test/unit/server/test-coordinator-status.test.ts`
- Create: `test/unit/server/test-coordinator-wrapper.test.ts`
- Create: `test/integration/server/test-coordinator.test.ts`

- [ ] **Step 1: Run the focused coordinator suite**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts test/unit/server/test-coordinator-wrapper.test.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 2: Run repo verification without a full-suite collision**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npm run check
  npm run lint
  ```

- [ ] **Step 3: Pause before the mandatory fresh landing run if another agent already owns the coordinated test lock**
  - use `npm run test:status -- --command test`
  - if the lock is busy, wait per the new contract instead of starting another full run

- [ ] **Step 4: Run the full suite once the lock is available**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  FRESHELL_TEST_SUMMARY="Unified test coordination and advisory baselines" npm test
  ```

- [ ] **Step 5: Commit the final verification or follow-up fixes**

  ```bash
  git add package.json package-lock.json AGENTS.md docs/skills/testing.md server/coding-cli/utils.ts test/unit/server/coding-cli/utils.test.ts scripts/testing/test-coordinator.ts scripts/testing/test-coordinator-manifest.ts scripts/testing/test-coordinator-store.ts scripts/testing/test-coordinator-status.ts scripts/testing/test-coordinator-upstream.ts scripts/testing/test-coordinator-locked-runner.ts tools/vitest-wrapper/package.json tools/vitest-wrapper/vitest.mjs tools/vitest-wrapper/index.js tools/vitest-wrapper/index.d.ts tools/vitest-wrapper/config.js tools/vitest-wrapper/config.d.ts test/fixtures/testing/fake-vitest-upstream.mjs test/fixtures/testing/fake-coordinated-workload.mjs test/fixtures/testing/temp-test-coordinator-env.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-store.test.ts test/unit/server/test-coordinator-status.test.ts test/unit/server/test-coordinator-wrapper.test.ts test/integration/server/test-coordinator.test.ts
  git commit -m "test: finalize coordinated test workflow"
  ```
