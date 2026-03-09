# Unified Broad Test Coordination And Advisory Baselines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build one repo-owned coordination layer that serializes broad one-shot test workloads across public npm scripts and raw local Vitest invocations, records truthful holder metadata, and preserves reusable exact-commit passing baselines without weakening the requirement for a fresh `npm test` before landing.

**Architecture:** All public test scripts and the local `vitest` binary flow through one TypeScript coordinator. The coordinator classifies each invocation into either a delegated workflow or a coordinated broad one-shot workload, uses `flock` as the sole liveness source, persists holder plus result metadata in the Git common-dir shared by all worktrees, and installs the raw-Vitest shim from source-controlled code on `postinstall` so `npm test` and `npx vitest run` share the same gate.

**Tech Stack:** Node.js, TypeScript, `tsx`, npm scripts, `child_process`, `fs/promises`, Git CLI, Linux/WSL `flock`, Zod, Vitest.

---

## Strategy Gate

The previous draft was still solving entrypoints instead of the actual failure mode. The problem is not "`npm test` collisions"; it is overlapping broad one-shot test workloads, no matter whether they start from `npm test`, `npm run check`, or `npx vitest run`. The clean steady state is one execution model:

- one coordinator for every public test script
- one patched local `vitest` entrypoint for raw repo-local Vitest invocations
- one kernel-backed lock for all broad one-shot workloads
- one exact workload identity for advisory reuse
- one truthful status surface that keeps the last reusable pass and the latest failure separate

That is the direct one-shot solution the user asked for. It avoids a half-measure where the easy bypass path remains the tool agents already use.

## Frozen Decisions

- Introduce one repo-owned coordinator CLI:
  - `scripts/testing/test-coordinator.ts`
- Introduce one deterministic installer for the local Vitest shim:
  - `scripts/testing/install-vitest-shim.ts`
- Introduce one repo-owned raw-Vitest shim target:
  - `scripts/testing/vitest-shim.ts`
- Public npm test scripts and the patched local `node_modules/vitest/vitest.mjs` must both call the same coordinator logic.
- `flock` is the only liveness truth.
  - Lock state is never inferred from JSON files.
  - Missing, corrupt, or partial metadata must never block a run.
- Workload identity is frozen to `workloadKey`, not the invoking command.
  - Public commands may map to a canonical `workloadKey` such as `full-suite`.
  - Raw untargeted Vitest runs that do not match a canonical public profile still get coordinated under a deterministic `workloadKey` derived from normalized argv.
- Reusable-baseline identity is frozen to:
  - `workloadKey`
  - `repo.commit`
  - `repo.cleanWorktree = true`
  - `runtime.nodeVersion`
  - `runtime.platform`
  - `runtime.arch`
- Result views are separate:
  - `latestCommandRun`
  - `latestCommandFailure`
  - `latestWorkloadRun`
  - `latestWorkloadFailure`
  - `latestReusableSuccess`
- A later failure must never erase an earlier reusable success for the same reusable identity.
  - Status must surface both independently.
- Cached results are advisory only.
  - They can inform an agent that a reusable baseline already exists.
  - They must never auto-succeed `npm test`, `check`, or `verify`.
- Contention behavior is fixed:
  - coordinated workloads try the lock immediately
  - if busy, they print the current holder if known
  - they re-poll once per minute
  - they wait up to 60 minutes
  - they never kill a run they did not start
  - they exit nonzero only on timeout or internal failure
- Summary precedence is fixed:
  - `--summary "<text>"`
  - `FRESHELL_TEST_SUMMARY`
  - command default
- Agent metadata precedence is fixed:
  - `CODEX_THREAD_ID` => `agent.kind = codex`
  - `CLAUDE_SESSION_ID` or `CLAUDE_THREAD_ID` => `agent.kind = claude`
  - otherwise `agent.kind = unknown`
- `--help`, `-h`, `--version`, and `-v` are unconditional passthroughs.
- Explicit watch/UI requests always delegate, even in CI or non-TTY:
  - `--watch`
  - `-w`
  - `--ui`
- File-targeted or otherwise narrowed raw Vitest runs delegate directly unless they match an exact canonical broad profile first.
  - positional file or directory targets
  - `-t` / `--testNamePattern`
  - `--project`
  - `--changed`
  - other manifest-defined narrowing selectors
- Canonical broad public commands that split into multiple phases must reject unsafe forwarded flags whose semantics cannot be applied truthfully across those phases.
  - `--reporter <value>` is the concrete v1 example

## Unified Execution Model

### Public Command Surface

Every public npm test script routes through the coordinator:

| commandKey | workloadKey | Mode |
| --- | --- | --- |
| `test` | `full-suite` | coordinated |
| `test:all` | `full-suite` | coordinated |
| `check` | `full-suite` | coordinated after typecheck phase |
| `verify` | `full-suite` | coordinated after build phase |
| `test:client:all` | `client-all` | coordinated |
| `test:server:without-logger` | `server-without-logger` | coordinated |
| `test:server:logger-separation` | `server-logger-separation` | coordinated |
| `test:server:all` | `server-all` | coordinated |
| `test:watch` | none | delegated |
| `test:ui` | none | delegated |
| `test:server` | none | delegated |
| `test:unit` | none | delegated |
| `test:integration` | none | delegated |
| `test:client` | none | delegated |
| `test:coverage` | none | delegated |
| `test:status` | none | status-only |

Rules:

- Coordinated commands participate in one repo-wide lock, even when their `workloadKey` differs.
- `test` and `test:all` share the same reusable-baseline identity because they run the same workload.
- `check` and `verify` keep command-specific history while their test phase contributes to `workloadKey = full-suite`.
- Composite coordinated commands execute their real phases through an upstream runner, not by recursively invoking other public npm scripts.

### Raw Vitest Surface

The repo-local `vitest` binary is patched on `postinstall` so `npx vitest ...` and `npm exec vitest ...` enter the coordinator before the upstream Vitest CLI.

Raw classification rules:

1. `--help`, `-h`, `--version`, `-v` => unconditional passthrough.
2. `--watch`, `-w`, `--ui` => delegated passthrough.
3. Canonical broad one-shot forms map to public workload keys when they are exact semantic matches, even when the exact canonical form includes a positional test file.
   - `vitest run --pool forks` => `client-all`
   - `vitest run --config vitest.server.config.ts --exclude test/integration/server/logger.separation.test.ts` => `server-without-logger`
   - `vitest run --config vitest.server.config.ts --pool forks --poolOptions.forks.singleFork --no-file-parallelism test/integration/server/logger.separation.test.ts` => `server-logger-separation`
4. Positional file/dir targets or explicit narrowing selectors that do not match a canonical broad profile => delegated passthrough.
5. Any other untargeted one-shot `vitest run ...` form is still coordinated, but under a deterministic raw workload key:
   - `raw-vitest:<normalized-argv-hash>`

Rules:

- Raw coordinated workloads use the same lock and holder metadata as public commands.
- Raw delegated runs never fabricate heavyweight baseline records.
- Reporter flags and other single-process presentation flags pass through normally on raw Vitest runs because they are not being split across phases.
- The upstream delegate path must be non-recursive: once inside the shimmed entrypoint, bypass the shim and invoke the preserved upstream Vitest program directly.

### Status Surface

Expose one public status command:

```bash
npm run test:status
npm run test:status -- --command test
npm run test:status -- --workload full-suite
```

Behavior:

- With no selector, return current lock/holder state only.
- `--command <commandKey>` returns current holder state plus command/workload history for that command's canonical workload.
- `--workload <workloadKey>` returns current holder state plus workload history for that workload.
- Active raw coordinated runs must always appear in current holder output, even if they do not map to a canonical public workload key.

## Data Contracts

### Holder Record

When a coordinated run holds the lock and metadata is valid:

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
    "kind": "command|raw-vitest",
    "commandKey": "test",
    "workloadKey": "full-suite",
    "display": "npm test"
  },
  "command": {
    "display": "npm test -- --summary Fix terminal attach ordering regression",
    "argv": ["npm", "test", "--", "--summary", "Fix terminal attach ordering regression"]
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

- If the lock is held but holder metadata is missing, unreadable, partial, or invalid, status returns `running-undescribed`.
- Holder metadata is written only after lock acquisition.
- Holder metadata is removed in `finally`.
- Stale holder files are advisory garbage and must never behave like locks.

### Command Result Record

Every coordinated public command invocation persists a command-scoped result:

```json
{
  "schemaVersion": 1,
  "kind": "command-result",
  "commandKey": "check",
  "workloadKey": "full-suite",
  "status": "passed|failed",
  "exitCode": 0,
  "startedAt": "2026-03-09T17:41:22.000Z",
  "finishedAt": "2026-03-09T17:45:10.000Z",
  "durationMs": 228000,
  "summary": "Fix terminal attach ordering regression",
  "summarySource": "cli|env|default",
  "repo": {
    "commit": "abc1234",
    "cleanWorktree": true,
    "branch": "feature/test-run-gate",
    "worktreePath": "/home/user/code/freshell/.worktrees/test-run-gate"
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

### Workload Result Record

Every coordinated broad workload execution persists a workload-scoped result:

```json
{
  "schemaVersion": 1,
  "kind": "workload-result",
  "workloadKey": "full-suite",
  "source": {
    "kind": "command|raw-vitest",
    "commandKey": "test:all",
    "rawDisplay": null
  },
  "status": "passed|failed",
  "exitCode": 0,
  "startedAt": "2026-03-09T17:41:22.000Z",
  "finishedAt": "2026-03-09T17:45:10.000Z",
  "durationMs": 228000,
  "summary": "Fix terminal attach ordering regression",
  "summarySource": "cli|env|default",
  "repo": {
    "commit": "abc1234",
    "cleanWorktree": true,
    "branch": "feature/test-run-gate",
    "worktreePath": "/home/user/code/freshell/.worktrees/test-run-gate"
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
  "reusable": true
}
```

Rules:

- `reusable = true` requires:
  - `status = passed`
  - `repo.cleanWorktree = true`
  - exact reusable-baseline identity
- `latestReusableSuccess` is the newest reusable success for that identity, regardless of later failures.
- `latestWorkloadFailure` is the newest failure for that workload identity and is reported separately.
- `latestWorkloadRun` is the newest workload result regardless of outcome.
- Workload records live under the Git common-dir so all worktrees share the same advisory history.

## File Plan

**Modify**

- `package.json`
- `AGENTS.md`
- `docs/skills/testing.md`
- `server/coding-cli/utils.ts`
- `test/unit/server/coding-cli/utils.test.ts`

**Create**

- `scripts/testing/test-coordinator.ts`
- `scripts/testing/test-coordinator-manifest.ts`
- `scripts/testing/test-coordinator-status.ts`
- `scripts/testing/test-coordinator-store.ts`
- `scripts/testing/test-coordinator-upstream.ts`
- `scripts/testing/install-vitest-shim.ts`
- `scripts/testing/vitest-shim.ts`
- `test/fixtures/test-coordinator/fake-workload.ts`
- `test/fixtures/test-coordinator/temp-coordinator-env.ts`
- `test/unit/server/test-coordinator-manifest.test.ts`
- `test/unit/server/test-coordinator-status.test.ts`
- `test/unit/server/test-coordinator-store.test.ts`
- `test/unit/server/install-vitest-shim.test.ts`
- `test/integration/server/test-coordinator.test.ts`

## Task 1: Shared Repo Metadata Foundations

**Files:**

- Modify: `server/coding-cli/utils.ts`
- Modify: `test/unit/server/coding-cli/utils.test.ts`
- Create: `scripts/testing/test-coordinator-store.ts`
- Create: `test/unit/server/test-coordinator-store.test.ts`

- [ ] **Step 1: Write the failing tests**
  - cover `resolveInvocationCwd()` preferring `INIT_CWD` over `process.cwd()`
  - cover `resolveGitCommonDir()` for a linked worktree
  - cover shared store path resolution under the Git common-dir
  - cover atomic holder/result writes and reads
  - cover corrupt or partial metadata being ignored rather than blocking
  - cover `latestReusableSuccess` and `latestWorkloadFailure` being tracked independently

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - extend `server/coding-cli/utils.ts` with invocation-cwd and Git common-dir helpers
  - implement store helpers for the lock path, holder path, command-result history, and workload-result history
  - keep OS lock state separate from JSON metadata
  - preserve reusable-success records even when later failures are written

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add server/coding-cli/utils.ts test/unit/server/coding-cli/utils.test.ts scripts/testing/test-coordinator-store.ts test/unit/server/test-coordinator-store.test.ts
  git commit -m "test: add shared coordinator metadata store"
  ```

## Task 2: Manifest, Raw Classification, And Status Contracts

**Files:**

- Create: `scripts/testing/test-coordinator-manifest.ts`
- Create: `scripts/testing/test-coordinator-status.ts`
- Create: `test/unit/server/test-coordinator-manifest.test.ts`
- Create: `test/unit/server/test-coordinator-status.test.ts`

- [ ] **Step 1: Write the failing tests**
  - cover every public test script mapping through one manifest entry
  - cover `test` and `test:all` sharing `workloadKey = full-suite`
  - cover `check` and `verify` keeping distinct command keys while contributing to `workloadKey = full-suite`
  - cover broad phase commands participating in coordination
  - cover focused commands delegating directly
  - cover raw `vitest run --pool forks` mapping to `client-all`
  - cover raw canonical server forms mapping to `server-without-logger` and `server-logger-separation`
  - cover untargeted non-canonical raw `vitest run ...` receiving deterministic `raw-vitest:<hash>` workload keys
  - cover positional file targets and narrowing selectors delegating directly
  - cover `--help` / `-h` / `--version` / `-v` unconditional passthrough
  - cover explicit `--watch` / `-w` / `--ui` delegating rather than entering the broad-run gate
  - cover unsafe composite forwarding such as `--reporter <value>` being rejected on split public commands
  - cover status payload assembly for `latestCommandRun`, `latestCommandFailure`, `latestWorkloadRun`, `latestWorkloadFailure`, and `latestReusableSuccess`

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - define the public command manifest
  - define raw Vitest classification rules and canonical workload normalization
  - define command/workload/status Zod schemas
  - project status output from separate command and workload stores

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/test-coordinator-manifest.ts scripts/testing/test-coordinator-status.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  git commit -m "test: define unified test workload manifest"
  ```

## Task 3: Shim Installation And Upstream Delegation

**Files:**

- Create: `scripts/testing/install-vitest-shim.ts`
- Create: `scripts/testing/vitest-shim.ts`
- Create: `test/unit/server/install-vitest-shim.test.ts`

- [ ] **Step 1: Write the failing tests**
  - cover installing the shim into a temp Vitest package layout
  - cover preserving the original upstream entrypoint at a deterministic backup path
  - cover idempotent re-install when the shim is already present
  - cover re-install when the upstream Vitest version changes
  - cover the shim delegating help/version/watch/file-targeted runs straight to preserved upstream
  - cover the shim invoking the coordinator for broad one-shot raw runs
  - cover the shim path being non-recursive when the coordinator delegates back upstream

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/install-vitest-shim.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - implement the installer that patches the local Vitest entrypoint from source-controlled code
  - preserve the original upstream program in `node_modules/vitest`
  - implement the repo-owned shim target that forwards raw argv into the coordinator
  - define the explicit environment marker used to bypass the shim during upstream delegation

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/install-vitest-shim.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/install-vitest-shim.ts scripts/testing/vitest-shim.ts test/unit/server/install-vitest-shim.test.ts
  git commit -m "test: install repo vitest shim"
  ```

## Task 4: Coordinator Execution, Waiting, And Result History

**Files:**

- Create: `scripts/testing/test-coordinator.ts`
- Create: `scripts/testing/test-coordinator-upstream.ts`
- Create: `test/fixtures/test-coordinator/fake-workload.ts`
- Create: `test/fixtures/test-coordinator/temp-coordinator-env.ts`
- Create: `test/integration/server/test-coordinator.test.ts`

- [ ] **Step 1: Write the failing integration tests**
  - cover `test:status` returning `idle` when no coordinated run is active
  - cover a coordinated public command acquiring the lock and writing holder metadata
  - cover a raw broad `vitest run` acquiring the same lock and writing holder metadata with `entrypoint.kind = raw-vitest`
  - cover `npm run test:client:all` waiting behind an active `npm test`
  - cover a raw broad `vitest run --pool forks` waiting behind an active `npm run check`
  - cover minute-by-minute waiting output using injected short polling intervals in tests
  - cover timeout after the configured 60-minute budget equivalent
  - cover holder cleanup on success, failure, and thrown internal error
  - cover `running-undescribed` when the lock is held but holder metadata is unreadable
  - cover command-result history remaining command-specific
  - cover `latestReusableSuccess` surviving a later same-identity failure
  - cover `latestWorkloadFailure` showing the newer failure separately from the preserved reusable pass
  - cover `check` failure before the test phase recording a command failure without fabricating a fresh workload success
  - cover delegated commands bypassing the heavyweight lock entirely

- [ ] **Step 2: Run the targeted integration test and verify it fails**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - parse command mode, raw-Vitest mode, and status mode
  - classify the invocation before any lock attempt
  - delegate help/watch/file-targeted flows directly upstream
  - acquire the repo-wide `flock` only for coordinated workloads
  - loop on non-blocking acquisition plus sleep so the tool can print truthful once-per-minute status updates
  - execute upstream command phases directly without recursively shelling back into public npm scripts or the shimmed Vitest entrypoint
  - persist command and workload results in `finally`
  - never signal or kill foreign PIDs

- [ ] **Step 4: Re-run the targeted integration test and verify it passes**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/test-coordinator.ts scripts/testing/test-coordinator-upstream.ts test/fixtures/test-coordinator/fake-workload.ts test/fixtures/test-coordinator/temp-coordinator-env.ts test/integration/server/test-coordinator.test.ts
  git commit -m "test: add unified broad test coordinator"
  ```

## Task 5: Public Script Cutover And Documentation

**Files:**

- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `docs/skills/testing.md`

- [ ] **Step 1: Extend failing coverage for the cutover**
  - assert every public test npm script resolves through the coordinator entrypoint
  - assert `postinstall` installs the local Vitest shim
  - assert the heavyweight command set includes the broad phase scripts, not only the umbrella commands
  - assert focused commands still delegate without coordination
  - assert `test:status` is exposed publicly

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/install-vitest-shim.test.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - repoint every public test npm script through `scripts/testing/test-coordinator.ts`
  - add `npm run test:status`
  - add a `postinstall` hook for `scripts/testing/install-vitest-shim.ts`
  - document the coordinated broad commands versus delegated focused commands
  - document raw repo-local `npx vitest` behavior: broad untargeted one-shot runs are coordinated, file-targeted and watch/UI runs are delegated
  - document `--summary` and `FRESHELL_TEST_SUMMARY`
  - document that reusable baselines are advisory only
  - document that landing still requires a fresh `npm test`
  - fix `docs/skills/testing.md` so it no longer claims `npm test` is watch mode

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/install-vitest-shim.test.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add package.json AGENTS.md docs/skills/testing.md
  git commit -m "test: cut over public test entrypoints"
  ```

## Task 6: Final Verification

**Files:**

- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `docs/skills/testing.md`
- Modify: `server/coding-cli/utils.ts`
- Modify: `test/unit/server/coding-cli/utils.test.ts`
- Create: `scripts/testing/test-coordinator.ts`
- Create: `scripts/testing/test-coordinator-manifest.ts`
- Create: `scripts/testing/test-coordinator-status.ts`
- Create: `scripts/testing/test-coordinator-store.ts`
- Create: `scripts/testing/test-coordinator-upstream.ts`
- Create: `scripts/testing/install-vitest-shim.ts`
- Create: `scripts/testing/vitest-shim.ts`
- Create: `test/fixtures/test-coordinator/fake-workload.ts`
- Create: `test/fixtures/test-coordinator/temp-coordinator-env.ts`
- Create: `test/unit/server/test-coordinator-manifest.test.ts`
- Create: `test/unit/server/test-coordinator-status.test.ts`
- Create: `test/unit/server/test-coordinator-store.test.ts`
- Create: `test/unit/server/install-vitest-shim.test.ts`
- Create: `test/integration/server/test-coordinator.test.ts`

- [ ] **Step 1: Run the focused automated test set**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts test/unit/server/install-vitest-shim.test.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 2: Run one coordinated smoke sequence after the gate exists**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npm run test:status
  FRESHELL_TEST_SUMMARY="coordination smoke" npm run test -- --summary "coordination smoke"
  npm run test:status -- --command test
  ```

  Notes:
  - do not run multiple redundant heavyweight suites here
  - the point is one real fresh `npm test` after the gate exists
  - if another agent is already using the gate, respect the wait path instead of killing their run

- [ ] **Step 3: Manually confirm the invariants**
  - while the smoke `npm test` is active, verify `test:status` shows the live holder
  - verify the holder includes summary, worktree, branch, and session/thread metadata when available
  - after completion, verify `latestCommandRun` updated for `test`
  - verify `latestReusableSuccess` for `workloadKey = full-suite` remains visible even if a later same-identity failure is recorded in tests
  - verify docs still require a fresh `npm test` before merge

- [ ] **Step 4: Commit**

  ```bash
  git add package.json AGENTS.md docs/skills/testing.md server/coding-cli/utils.ts test/unit/server/coding-cli/utils.test.ts scripts/testing/test-coordinator.ts scripts/testing/test-coordinator-manifest.ts scripts/testing/test-coordinator-status.ts scripts/testing/test-coordinator-store.ts scripts/testing/test-coordinator-upstream.ts scripts/testing/install-vitest-shim.ts scripts/testing/vitest-shim.ts test/fixtures/test-coordinator/fake-workload.ts test/fixtures/test-coordinator/temp-coordinator-env.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts test/unit/server/test-coordinator-store.test.ts test/unit/server/install-vitest-shim.test.ts test/integration/server/test-coordinator.test.ts
  git commit -m "feat: coordinate broad test workloads"
  ```

## Acceptance Criteria

- Every public test npm script routes through one repo-owned coordinator.
- Repo-local raw `npx vitest ...` and `npm exec vitest ...` are part of the coordinated surface because the local Vitest entrypoint is patched on `postinstall`.
- Broad one-shot workloads from public scripts and raw local Vitest share one repo-wide lock.
- File-targeted, watch/UI, help, and version raw Vitest flows preserve their direct behavior and do not enter the heavyweight wait path.
- Waiting is handled by the tool itself with minute-by-minute status messages and a 60-minute ceiling.
- Holder/status truth comes from `flock`; corrupt or missing metadata degrades to `running-undescribed` rather than blocking.
- Advisory reusable baselines are keyed by exact reusable identity and a later failure does not erase the last reusable pass.
- Status surfaces `latestReusableSuccess` and `latestWorkloadFailure` independently so agents can see both the reusable green baseline and the newest failure.
- Command history remains command-specific, so `check` and `verify` do not masquerade as `npm test`.
- Cached results never auto-succeed `npm test`, `check`, or `verify`.
- `AGENTS.md` and `docs/skills/testing.md` explain the coordinated workflow, summary metadata, advisory-only baseline semantics, raw local Vitest behavior, and the continued requirement for a fresh `npm test` before merging.
