# Unified Test Coordination And Advisory Baselines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build a single repo-owned test entrypoint that serializes all sanctioned heavyweight one-shot test workloads, records truthful holder metadata plus advisory reusable baselines, and preserves focused/local testing workflows without weakening the repo's requirement for a fresh `npm test` before landing.

**Architecture:** All public test npm scripts route through one TypeScript entrypoint that classifies the invoked command as either a coordinated broad one-shot workload or a direct delegated workflow. Coordinated workloads share one repo-wide `flock` plus holder/result metadata stored in the Git common-dir; reusable baselines are keyed by `suiteKey` rather than the invoking command so equivalent workloads like `test` and `test:all` share the same advisory history.

**Tech Stack:** Node.js, TypeScript, `tsx`, npm scripts, `child_process`, `fs/promises`, Git CLI, Linux/WSL `flock`, Zod, Vitest.

---

## Strategy Gate

The prior draft solved the wrong boundary. The actual problem is not only `npm test`; it is every sanctioned heavyweight one-shot entrypoint that can saturate the machine, including the public phase scripts that back the full suite. The clean steady state is:

- one repo-owned CLI for every public test script
- one kernel-backed lock for every heavyweight one-shot workload
- one workload identity (`suiteKey`) for advisory reuse, separate from `commandKey`
- one truthful status surface built from `flock` plus crash-tolerant metadata
- no cached-success shortcut for `npm test`, `check`, or `verify`

This plan intentionally treats the repo's shipped npm scripts as the supported coordination surface. Direct `npx vitest ...` remains possible, but it is explicitly outside the supported shared-baseline path and must be documented that way. The implementation should make the standard path easy and consistent, and should remove heavyweight bypasses from the public scripts themselves.

## Frozen Decisions

- Introduce one public entrypoint script:
  - `scripts/testing/test-coordinator.ts`
- Every public test npm script routes through that entrypoint, including focused commands.
  - The entrypoint decides whether to coordinate or delegate.
  - This keeps usage ergonomic and makes sanctioned heavy runs hard to bypass.
- `flock` is the only liveness truth.
  - Lock state is never inferred from JSON files.
  - Missing/corrupt metadata must never block a run.
- Advisory reuse is keyed by `suiteKey`, not `commandKey`.
  - `commandKey` is provenance and UX.
  - `suiteKey` is workload identity.
- Shared reusable-baseline identity is frozen to:
  - `suiteKey`
  - `repo.commit`
  - `repo.cleanWorktree = true`
  - `runtime.nodeVersion`
  - `runtime.platform`
  - `runtime.arch`
- Command results and suite results are stored separately.
  - `latestCommandRun` answers "what happened the last time someone ran this command?"
  - `latestReusableSuccess` answers "does this exact clean commit already have a passing result for the same heavyweight workload?"
- Contention behavior is fixed:
  - coordinated workloads try the lock immediately
  - if busy, they print the current holder if known
  - they re-poll once per minute
  - they wait for up to 60 minutes
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
- Help/version passthrough is unconditional:
  - `--help`, `-h`, `--version`, `-v` never enter lock/baseline logic
- Explicit watch requests always delegate:
  - `--watch`, `-w`, `--ui` bypass coordination and run upstream directly
- Value-carrying Vitest flags that cannot be truthfully applied across multi-phase commands are not silently forwarded.
  - On composite commands like `test`, `test:all`, `check`, `verify`, and `test:server:all`, unsafe flags such as `--reporter <value>` must be rejected with a clear error unless the value is explicitly allowed by manifest rules.

## Unified Command Model

### Coordinated Broad Workloads

These are the sanctioned heavyweight one-shot workloads that must share the repo-wide lock:

| commandKey | suiteKey | Behavior |
| --- | --- | --- |
| `test` | `full-suite` | client-all then server-all |
| `test:all` | `full-suite` | same workload as `test` |
| `check` | `full-suite` | typecheck, then full-suite |
| `verify` | `full-suite` | build, then full-suite |
| `test:client:all` | `client-all` | broad client Vitest run |
| `test:server:without-logger` | `server-without-logger` | broad server run excluding logger-separation test |
| `test:server:logger-separation` | `server-logger-separation` | special logger-separation run |
| `test:server:all` | `server-all` | without-logger then logger-separation |

Rules:

- Any one of these commands must wait behind any other active coordinated command.
- `test` and `test:all` are separate command keys with the same `suiteKey`.
- `check` and `verify` keep command-specific result history, but their reusable baseline lookup uses `suiteKey = full-suite`.

### Direct Delegated Workflows

These commands still go through the repo entrypoint for consistency, but they do not take the heavyweight lock:

- `test:watch`
- `test:ui`
- `test:server`
- `test:unit`
- `test:integration`
- `test:client`
- `test:coverage`

Rules:

- The coordinator strips only its own control flags and forwards the rest unchanged.
- Delegated commands do not write heavyweight suite baseline records.
- They may still emit a short note when a heavyweight coordinated run is active, but they do not wait on it.

### Status Semantics

`npm run test:status -- --command <commandKey>` is the single public read surface.

For coordinated commands, it reports:

- current lock state
- current holder metadata when available
- `commandKey`
- `suiteKey`
- `latestCommandRun`
- `latestCommandFailure`
- `latestSuiteRun`
- `latestReusableSuccess`

For delegated commands, it reports:

- `state = unsupported-command`
- no fabricated suite-baseline data

This avoids pretending that focused commands participate in the heavyweight advisory baseline model.

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
    "commandKey": "test",
    "suiteKey": "full-suite",
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

- if the lock is held but holder metadata is missing, partial, unreadable, or invalid, status returns `running-undescribed`
- holder metadata is written only after lock acquisition
- holder metadata is removed in `finally`
- stale holder files are advisory garbage and must never behave like locks

### Command Result Record

Every coordinated command invocation persists a command-scoped result:

```json
{
  "schemaVersion": 1,
  "kind": "command-result",
  "commandKey": "check",
  "suiteKey": "full-suite",
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

### Suite Result Record

Every coordinated broad workload execution persists a suite-scoped result:

```json
{
  "schemaVersion": 1,
  "kind": "suite-result",
  "suiteKey": "full-suite",
  "sourceCommandKey": "test:all",
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
  "advisoryOnly": true,
  "reusable": true
}
```

Rules:

- `reusable = true` requires:
  - `status = passed`
  - `repo.cleanWorktree = true`
  - exact `suiteKey`
  - exact runtime identity
- `latestReusableSuccess` is derived from suite results only
- a newer suite failure for the same reusable identity suppresses that earlier success as the current reusable baseline
- suite records live under the Git common-dir so all worktrees see the same advisory history

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
- `test/fixtures/test-coordinator/fake-workload.ts`
- `test/fixtures/test-coordinator/temp-coordinator-env.ts`
- `test/unit/server/test-coordinator-manifest.test.ts`
- `test/unit/server/test-coordinator-status.test.ts`
- `test/unit/server/test-coordinator-store.test.ts`
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
  - cover corrupt/partial metadata being ignored rather than blocking

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - extend `server/coding-cli/utils.ts` with invocation-cwd and Git common-dir helpers
  - implement store helpers for lock path, holder path, command-result history, and suite-result history
  - keep OS lock state separate from JSON metadata

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add server/coding-cli/utils.ts test/unit/server/coding-cli/utils.test.ts scripts/testing/test-coordinator-store.ts test/unit/server/test-coordinator-store.test.ts
  git commit -m "test: add coordinator metadata store"
  ```

## Task 2: Manifest, Classification, And Status Contracts

**Files:**

- Create: `scripts/testing/test-coordinator-manifest.ts`
- Create: `scripts/testing/test-coordinator-status.ts`
- Create: `test/unit/server/test-coordinator-manifest.test.ts`
- Create: `test/unit/server/test-coordinator-status.test.ts`

- [ ] **Step 1: Write the failing tests**
  - cover every public test script mapping through one manifest entry
  - cover heavyweight command keys mapping to the correct `suiteKey`
  - cover `test` and `test:all` sharing `suiteKey = full-suite`
  - cover `check` and `verify` keeping distinct command keys while reusing `suiteKey = full-suite`
  - cover the heavyweight phase commands participating in coordination
  - cover focused commands delegating directly
  - cover `--help` / `-h` / `--version` / `-v` unconditional passthrough
  - cover explicit `--watch` / `-w` / `--ui` delegating rather than entering the broad-run gate
  - cover unsafe composite forwarding such as `--reporter <value>` being rejected unless manifest rules mark it safe
  - cover status payload assembly for `latestCommandRun`, `latestCommandFailure`, `latestSuiteRun`, and `latestReusableSuccess`
  - cover reusable baseline identity by `suiteKey + commit + cleanWorktree + runtime`

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - define the manifest for all public test commands
  - define command/suite/status Zod schemas
  - implement CLI classification and status projection
  - make `suiteKey` the reusable-baseline identity and keep `commandKey` as provenance

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/test-coordinator-manifest.ts scripts/testing/test-coordinator-status.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts
  git commit -m "test: define unified coordinator manifest"
  ```

## Task 3: Coordinator Execution And Contention Behavior

**Files:**

- Create: `scripts/testing/test-coordinator.ts`
- Create: `scripts/testing/test-coordinator-upstream.ts`
- Create: `test/fixtures/test-coordinator/fake-workload.ts`
- Create: `test/fixtures/test-coordinator/temp-coordinator-env.ts`
- Create: `test/integration/server/test-coordinator.test.ts`

- [ ] **Step 1: Write the failing integration tests**
  - cover `test:status` returning `idle` when no coordinated run is active
  - cover a coordinated run acquiring the lock and writing holder metadata
  - cover `npm run test:client:all` waiting behind an active `npm test`
  - cover `npm run test:server:all` waiting behind an active `npm run check`
  - cover minute-by-minute waiting output using injected short polling intervals in tests
  - cover timeout after the configured 60-minute budget equivalent
  - cover holder cleanup on success, failure, and thrown internal error
  - cover `running-undescribed` when the lock is held but holder metadata is unreadable
  - cover command-result history remaining command-specific
  - cover suite-result history being shared across `test` and `test:all`
  - cover `check` failure before the suite phase recording a command failure without fabricating a fresh suite success
  - cover delegated commands bypassing the heavyweight lock entirely

- [ ] **Step 2: Run the targeted integration test and verify it fails**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - parse `run <commandKey>` and `status --command <commandKey>`
  - classify the invocation before any lock attempt
  - delegate focused/help/watch flows directly upstream
  - acquire the repo-wide `flock` only for coordinated workloads
  - loop on non-blocking acquisition plus sleep so the tool can print truthful once-per-minute status updates
  - execute upstream command phases directly without recursively shelling back into public npm scripts
  - persist command and suite results in `finally`
  - never signal or kill foreign PIDs

- [ ] **Step 4: Re-run the targeted integration test and verify it passes**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/testing/test-coordinator.ts scripts/testing/test-coordinator-upstream.ts test/fixtures/test-coordinator/fake-workload.ts test/fixtures/test-coordinator/temp-coordinator-env.ts test/integration/server/test-coordinator.test.ts
  git commit -m "test: add unified test coordinator"
  ```

## Task 4: Public Script Cutover And Documentation

**Files:**

- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `docs/skills/testing.md`

- [ ] **Step 1: Extend failing coverage for the cutover**
  - assert every public test npm script resolves through the coordinator entrypoint
  - assert the heavyweight command set includes the server/client broad phase scripts, not only the umbrella commands
  - assert focused commands still delegate without coordination
  - assert `test:status` is exposed publicly

- [ ] **Step 2: Run the targeted tests and verify they fail**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 3: Write the minimal implementation**
  - repoint every public test npm script through `scripts/testing/test-coordinator.ts`
  - add `npm run test:status`
  - document the coordinated heavyweight commands vs delegated focused commands
  - document `--summary` and `FRESHELL_TEST_SUMMARY`
  - document that reusable baselines are advisory only
  - document that landing still requires a fresh `npm test`
  - fix `docs/skills/testing.md` so it no longer claims `npm test` is watch mode

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-manifest.test.ts test/integration/server/test-coordinator.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add package.json AGENTS.md docs/skills/testing.md
  git commit -m "test: route public test scripts through coordinator"
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
- Create: `scripts/testing/test-coordinator-store.ts`
- Create: `scripts/testing/test-coordinator-upstream.ts`
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

- [ ] **Step 2: Run one coordinated smoke sequence after the gate exists**

  ```bash
  cd /home/user/code/freshell/.worktrees/test-run-gate
  npm run test:status -- --command test
  FRESHELL_TEST_SUMMARY="coordination smoke" npm run test -- --summary "coordination smoke"
  npm run test:status -- --command test
  ```

  Notes:
  - do not run multiple redundant heavyweight suites here
  - the point is one real fresh `npm test` after the gate is in place
  - if another agent is already using the gate, respect the wait path instead of killing their run

- [ ] **Step 3: Manually confirm the invariants**
  - while the smoke `npm test` is active, verify `test:status` shows the live holder
  - after completion, verify `latestCommandRun` updated for `test`
  - verify `latestReusableSuccess` for `suiteKey = full-suite` is visible for both `test` and `test:all`
  - verify docs still require a fresh `npm test` before merge

- [ ] **Step 4: Commit**

  ```bash
  git add package.json AGENTS.md docs/skills/testing.md server/coding-cli/utils.ts test/unit/server/coding-cli/utils.test.ts scripts/testing/test-coordinator.ts scripts/testing/test-coordinator-manifest.ts scripts/testing/test-coordinator-status.ts scripts/testing/test-coordinator-store.ts scripts/testing/test-coordinator-upstream.ts test/fixtures/test-coordinator/fake-workload.ts test/fixtures/test-coordinator/temp-coordinator-env.ts test/unit/server/test-coordinator-manifest.test.ts test/unit/server/test-coordinator-status.test.ts test/unit/server/test-coordinator-store.test.ts test/integration/server/test-coordinator.test.ts
  git commit -m "feat: coordinate sanctioned heavyweight test runs"
  ```

## Acceptance Criteria

- Every public test npm script routes through one repo-owned entrypoint.
- `npm test`, `npm run test:all`, `npm run check`, `npm run verify`, `npm run test:client:all`, `npm run test:server:without-logger`, `npm run test:server:logger-separation`, and `npm run test:server:all` all participate in one repo-wide lock.
- Focused commands such as `test:watch`, `test:ui`, `test:server`, `test:unit`, `test:integration`, `test:client`, and `test:coverage` preserve their direct behavior and do not wait behind unrelated heavyweight runs.
- Waiting is handled by the tool itself with minute-by-minute status messages and a 60-minute ceiling.
- Holder/status truth comes from `flock`; corrupt or missing metadata degrades to `running-undescribed` rather than blocking.
- Advisory reusable baselines are keyed by `suiteKey`, so equivalent workloads like `test` and `test:all` share baseline history on the same clean commit and runtime.
- Command history remains command-specific, so `check` and `verify` do not masquerade as `npm test`.
- Cached results never auto-succeed `npm test`, `check`, or `verify`.
- `AGENTS.md` and `docs/skills/testing.md` both explain the coordinated workflow, summary metadata, advisory-only baseline semantics, and the continued requirement for a fresh `npm test` before merging.
