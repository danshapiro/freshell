# Unified Test Coordination And Advisory Baselines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build a repo-owned coordination layer for heavyweight shared verification runs that waits politely for up to one hour, reports truthful live holder metadata, and exposes advisory last-run baselines without blocking focused test workflows or weakening the repo's required fresh `npm test` before landing.

**Architecture:** Public shared-verification commands route through one TypeScript coordinator that owns lock acquisition, bounded waiting, holder/result metadata, and status queries. Only heavyweight shared workloads participate in the repo-wide `flock`; focused commands keep their current direct behavior. Cached results live in the git common-dir and are surfaced only through `test:status` as advisory metadata, never as an automatic success shortcut for `npm test`, `check`, or `verify`.

**Tech Stack:** Node.js, TypeScript, `tsx`, npm scripts, `child_process`, `fs/promises`, Git CLI, Linux/WSL `flock`, Zod, Vitest.

---

## Strategy Gate

The review findings are correct: the previous plan solved "multiple agents collide on heavyweight verification" by creating a new repo-wide bottleneck for workflows the user did not ask to serialize. The right steady-state architecture is narrower and cleaner:

- one sanctioned coordinator for heavyweight shared verification commands
- minute-by-minute bounded waiting inside the tool, not delegated to every agent
- truthful holder/status data derived from `flock` plus advisory metadata
- advisory baseline records that help agents decide whether they already have a clean shared baseline
- no cached-success path that can replace the mandatory fresh `npm test` before merging

The plan deliberately does **not** try to make process detection a second lock primitive, and it does **not** try to intercept every conceivable raw Vitest launch. The supported coordination surface is the repo's public verification commands; focused commands stay focused, and raw dependency-binary usage is documented as unsupported for shared baseline work.

## Frozen Decisions

- Preserve the current public command contracts for focused workflows:
  - `test:watch = vitest`
  - `test:ui = vitest --ui`
  - `test:server = vitest --config vitest.server.config.ts`
  - `test:unit = vitest run test/unit`
  - `test:integration = vitest run --config vitest.server.config.ts test/server`
  - `test:client = vitest run test/unit/client`
  - `test:coverage` remains a real coverage run and never reuses cache
- Route only the shared verification commands through the coordinator:
  - `test`
  - `test:all`
  - `check`
  - `verify`
  - new `test:status`
- Keep low-level phase scripts available, but treat them as direct tools, not queue participants:
  - `test:client:all`
  - `test:server:without-logger`
  - `test:server:logger-separation`
  - `test:server:all`
- `flock` is the only source of truth for whether a coordinated run is active.
- Holder metadata and result metadata are advisory, schema-validated, atomically written, and crash-tolerant. Missing or corrupt metadata must never block a run.
- Contention behavior is fixed:
  - coordinated commands attempt the lock immediately
  - if busy, they emit a human message naming the current holder and wait
  - they re-poll once per minute
  - they keep waiting for up to 60 minutes total
  - they never kill a run they did not start
  - they exit nonzero only after the 60-minute deadline expires or an internal error occurs
- Summary capture order is fixed:
  - explicit `--summary "<text>"`
  - `FRESHELL_TEST_SUMMARY`
  - per-command default summary
- Agent metadata capture order is fixed:
  - `agent.kind = codex` when `CODEX_THREAD_ID` is present
  - `agent.kind = claude` when `CLAUDE_SESSION_ID` or `CLAUDE_THREAD_ID` is present
  - otherwise `agent.kind = unknown`
- Baseline records are advisory only.
  - `test:status` reports them
  - execution commands never auto-skip based on them
  - no `--reuse-baseline` flag exists on `npm test`, `npm run check`, or `npm run verify`
- The repo rule in `AGENTS.md` remains explicit and unchanged in effect: before fast-forwarding `main`, run a fresh `npm test` and confirm it passes.

## Coordination Model

### Coordinated Commands

These commands share one repo-wide lock because they are the heavyweight, shared verification entrypoints agents are expected to use for baseline confidence:

- `npm test`
- `npm run test:all`
- `npm run check`
- `npm run verify`

The coordinator owns their full upstream workload directly rather than recursively shelling back into public npm scripts. That avoids nested lock acquisition and keeps the top-level behavior explicit.

### Ungated Commands

These commands remain direct and must not block behind an unrelated coordinated run:

- `npm run test:watch`
- `npm run test:ui`
- `npm run test:server`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:client`
- `npm run test:coverage`
- `npm run test:client:all`
- `npm run test:server:without-logger`
- `npm run test:server:logger-separation`
- `npm run test:server:all`

The docs should steer agents toward the coordinated commands for shared baseline work and the focused commands for local iteration. This preserves the repo's current "use narrower alternatives when you can" development story.

### Status And Baseline Semantics

`npm run test:status -- --command <test|test:all|check|verify>` is the single public read path for:

- whether a coordinated run is currently active
- who holds it
- what worktree, branch, commit, and summary that run is serving
- the latest run result for that command
- the latest exact-match reusable success for the current commit/runtime
- the latest failure for that command

Exact reusable-baseline identity is frozen to:

- `commandKey`
- `repo.commit`
- `repo.cleanWorktree = true`
- `runtime.nodeVersion`
- `runtime.platform`
- `runtime.arch`

`latestReusableSuccess` means "this exact command last passed on this exact clean commit under this runtime." It never means "you may skip the fresh merge-gate run." The docs and agent instructions must say that explicitly.

## User-Facing Data Contracts

### Holder Record

When a coordinated run is active and the metadata is valid, `test:status` returns:

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
    "commandKey": "test",
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

- if the lock is held and the holder file is missing, partial, unreadable, or invalid, status must return `running-undescribed`
- no partial holder object may be fabricated
- holder metadata is written only after lock acquisition and removed in a `finally` path

### Status Payload

`npm run test:status -- --command test` prints exactly one JSON object to stdout and exits `0`:

```json
{
  "schemaVersion": 1,
  "state": "idle|running-described|running-undescribed",
  "holder": {},
  "target": {
    "commandKey": "test"
  },
  "latestRun": {},
  "latestReusableSuccess": {},
  "latestFailure": {}
}
```

Rules:

- `holder` is present only for `running-described`
- `target`, `latestRun`, `latestReusableSuccess`, and `latestFailure` are present only when `--command` is supplied
- `latestReusableSuccess` is advisory-only metadata, not an execution shortcut
- non-query internal errors exit nonzero and do not print fabricated status

### Result Record

Every coordinated run persists:

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
    "commandKey": "test",
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
  },
  "advisoryOnly": true,
  "reusable": true
}
```

Rules:

- store result metadata under the git common-dir so all worktrees share it
- `reusable = true` requires exact command identity, clean worktree, zero exit code, and exact runtime match
- `latestReusableSuccess` is invalidated by any newer exact-command failure for that same identity
- `verify` and `test:coverage` still persist results, but only `test`, `test:all`, `check`, and `verify` need to be exposed through `test:status`

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
- `scripts/testing/test-coordinator-upstream.ts`
- `scripts/testing/test-coordinator-store.ts`
- `test/fixtures/test-coordinator/fake-workload.ts`
- `test/fixtures/test-coordinator/temp-coordinator-env.ts`
- `test/unit/server/test-coordinator-manifest.test.ts`
- `test/unit/server/test-coordinator-status.test.ts`
- `test/unit/server/test-coordinator-store.test.ts`
- `test/integration/server/test-coordinator.test.ts`

## Task 1: Repo And Store Foundations

**Files:**

- Modify: `server/coding-cli/utils.ts`
- Modify: `test/unit/server/coding-cli/utils.test.ts`
- Create: `scripts/testing/test-coordinator-store.ts`
- Create: `test/unit/server/test-coordinator-store.test.ts`

- [ ] **Step 1: Write the failing tests**
  - cover `resolveInvocationCwd()` using `INIT_CWD` before `process.cwd()`
  - cover `resolveGitCommonDir()` for a linked worktree
  - cover shared store-path discovery under the git common-dir
  - cover atomic write/read behavior for holder and result records
  - cover corrupt or partial metadata being ignored instead of blocking

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts
  ```

- [ ] **Step 3: Implement the minimal store and git helpers**
  - add invocation-cwd and git-common-dir helpers to `server/coding-cli/utils.ts`
  - implement the shared metadata store in `scripts/testing/test-coordinator-store.ts`
  - keep `flock` state and JSON metadata separate so stale files never act as locks

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add server/coding-cli/utils.ts test/unit/server/coding-cli/utils.test.ts scripts/testing/test-coordinator-store.ts test/unit/server/test-coordinator-store.test.ts
  git commit -m "test: add shared coordinator store"
  ```

## Task 2: Command Manifest, Status Schema, And Advisory Baselines

**Files:**

- Create: `scripts/testing/test-coordinator-manifest.ts`
- Create: `scripts/testing/test-coordinator-status.ts`
- Create: `test/unit/server/test-coordinator-manifest.test.ts`
- Create: `test/unit/server/test-coordinator-status.test.ts`

- [ ] **Step 1: Write the failing tests**
  - cover the coordinated command set being exactly `test`, `test:all`, `check`, and `verify`
  - cover focused commands remaining ungated
  - cover summary-source precedence (`--summary`, env, default)
  - cover holder/status schema validation
  - cover exact reusable-baseline identity by command, commit, clean worktree, and runtime
  - cover `latestReusableSuccess` being advisory-only metadata, never an execution decision

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  ```

- [ ] **Step 3: Implement the manifest and status assembly**
  - freeze the coordinated-vs-direct command manifest
  - define the holder/result/status zod schemas
  - implement exact-match result lookups for `latestRun`, `latestReusableSuccess`, and `latestFailure`
  - make the status layer describe cache hits without granting permission to skip the real run

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/test-coordinator-manifest.ts scripts/testing/test-coordinator-status.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  git commit -m "test: define coordination status contracts"
  ```

## Task 3: Bounded-Wait Coordinator Runner

**Files:**

- Create: `scripts/testing/test-coordinator.ts`
- Create: `scripts/testing/test-coordinator-upstream.ts`
- Create: `test/fixtures/test-coordinator/fake-workload.ts`
- Create: `test/fixtures/test-coordinator/temp-coordinator-env.ts`
- Create: `test/integration/server/test-coordinator.test.ts`

- [ ] **Step 1: Write the failing integration tests**
  - cover `test:status` returning `idle`
  - cover a coordinated run acquiring the lock and writing holder metadata
  - cover contention producing the required human guidance and then waiting instead of fast-failing
  - cover minute-by-minute re-poll output using injected short poll intervals in tests
  - cover timeout after the configured 60-minute budget equivalent
  - cover holder cleanup and result persistence on success and failure
  - cover focused commands bypassing the coordinator lock entirely
  - cover a matching advisory baseline being reported by status while `npm test` still performs a real run

- [ ] **Step 2: Run the targeted integration test and verify it fails**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 3: Implement the coordinator**
  - parse `run <commandKey>` and `status` modes
  - acquire the repo-wide `flock` only for coordinated commands
  - wait by looping on non-blocking acquisition plus a sleep interval so the tool can print truthful status once per minute
  - print holder summary, start time, worktree, branch, and resume identifiers when available
  - enforce "never kill someone else's run" by never sending signals to foreign PIDs
  - execute the actual upstream phases directly from `test-coordinator-upstream.ts`
  - persist result metadata in `finally` and clear holder metadata on exit

- [ ] **Step 4: Re-run the targeted integration test and verify it passes**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/test-coordinator.ts scripts/testing/test-coordinator-upstream.ts test/fixtures/test-coordinator/fake-workload.ts test/fixtures/test-coordinator/temp-coordinator-env.ts test/integration/server/test-coordinator.test.ts
  git commit -m "test: add bounded-wait verification coordinator"
  ```

## Task 4: Public Script Wiring And Agent-Facing Docs

**Files:**

- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `docs/skills/testing.md`

- [ ] **Step 1: Write the failing tests**
  - extend integration coverage so `test`, `test:all`, `check`, `verify`, and `test:status` all invoke the coordinator entry
  - cover focused commands preserving their direct behavior
  - cover docs/agent rules by asserting the documented command table matches the shipped scripts if there is an existing doc consistency seam; otherwise add a small targeted unit test for the manifest used to render the docs examples

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts test/unit/server/test-coordinator-manifest.test.ts
  ```

- [ ] **Step 3: Implement the script and doc cutover**
  - repoint `test`, `test:all`, `check`, `verify`, and `test:status` to `scripts/testing/test-coordinator.ts`
  - leave focused commands wired straight to Vitest
  - fix `docs/skills/testing.md` so `npm test` is described correctly
  - document `FRESHELL_TEST_SUMMARY` and `--summary`
  - document that `test:status` is the way to inspect shared baseline state
  - update `AGENTS.md` to say:
    - use coordinated commands for shared baseline work
    - use focused commands for local iteration
    - cached baselines are advisory only
    - landing still requires a fresh `npm test`

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts test/unit/server/test-coordinator-manifest.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add package.json AGENTS.md docs/skills/testing.md
  git commit -m "test: wire coordinated verification commands"
  ```

## Task 5: Final Verification

**Files:**

- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `docs/skills/testing.md`
- Modify: `server/coding-cli/utils.ts`
- Modify: `test/unit/server/coding-cli/utils.test.ts`
- Create: `scripts/testing/test-coordinator.ts`
- Create: `scripts/testing/test-coordinator-manifest.ts`
- Create: `scripts/testing/test-coordinator-status.ts`
- Create: `scripts/testing/test-coordinator-upstream.ts`
- Create: `scripts/testing/test-coordinator-store.ts`
- Create: `test/fixtures/test-coordinator/fake-workload.ts`
- Create: `test/fixtures/test-coordinator/temp-coordinator-env.ts`
- Create: `test/unit/server/test-coordinator-manifest.test.ts`
- Create: `test/unit/server/test-coordinator-status.test.ts`
- Create: `test/unit/server/test-coordinator-store.test.ts`
- Create: `test/integration/server/test-coordinator.test.ts`

- [ ] **Step 1: Run the focused automated test set**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 2: Run coordinator smoke checks without a second heavyweight suite**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npm run test:status -- --command test
  FRESHELL_TEST_SUMMARY="coordination smoke" npm run test -- --summary "coordination smoke"
  ```

  Notes:
  - do not run `npm run check` or `npm run verify` as additional heavyweight end-to-end suites here if the targeted integration tests already proved their coordinator behavior
  - the goal is one real fresh `npm test` after the gate exists, not multiple redundant heavyweight runs

- [ ] **Step 3: Review status output and confirm the invariants manually**
  - while the smoke `npm test` is active, verify `npm run test:status -- --command test` shows the live holder
  - after completion, verify `latestRun` and `latestReusableSuccess` reflect the finished run
  - verify the docs and agent rules still say a fresh `npm test` is required before merging

- [ ] **Step 4: Commit**

  ```bash
  git add package.json AGENTS.md docs/skills/testing.md server/coding-cli/utils.ts test/unit/server/coding-cli/utils.test.ts scripts/testing/test-coordinator.ts scripts/testing/test-coordinator-manifest.ts scripts/testing/test-coordinator-status.ts scripts/testing/test-coordinator-upstream.ts scripts/testing/test-coordinator-store.ts test/fixtures/test-coordinator/fake-workload.ts test/fixtures/test-coordinator/temp-coordinator-env.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts test/unit/server/test-coordinator-store.test.ts test/integration/server/test-coordinator.test.ts
  git commit -m "feat: coordinate heavyweight verification runs"
  ```

## Acceptance Criteria

- `npm test`, `npm run test:all`, `npm run check`, and `npm run verify` all pass through one coordinator that waits politely for up to one hour when another coordinated run is already active.
- Waiting is handled by the tool itself with minute-by-minute status messages; agents do not need to build their own retry loop.
- `npm run test:unit`, `npm run test:integration`, `npm run test:client`, `npm run test:server`, and the other focused/direct commands do not get serialized behind unrelated heavyweight work.
- `npm run test:status -- --command test` truthfully reports the live lock holder when metadata is valid and falls back to `running-undescribed` when only the lock is known.
- Result metadata is shared across worktrees through the git common-dir and can tell an agent whether the current clean commit already has an exact reusable success for a coordinated command.
- Cached success never causes `npm test`, `npm run check`, or `npm run verify` to auto-succeed.
- `AGENTS.md` and `docs/skills/testing.md` both state that cached baselines are advisory only and that landing still requires a fresh `npm test`.
