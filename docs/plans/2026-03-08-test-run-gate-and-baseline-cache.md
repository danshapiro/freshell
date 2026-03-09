# Unified Test Coordination And Advisory Baselines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build one repo-owned test coordinator that serializes sanctioned broad one-shot test runs, reports truthful active-holder status, and records exact-match advisory baselines that agents can inspect instead of rerunning unchanged inherited commits.

**Architecture:** Route every sanctioned public test entrypoint through a TypeScript coordinator owned by this repo. The coordinator normalizes the requested command into an explicit contract, then either delegates directly to upstream Vitest/build/typecheck behavior or launches a dedicated coordinated runner that owns a repo-specific local socket/pipe. That bound endpoint is the only lock primitive, so liveness is cross-platform and clears automatically when the runner dies. Advisory holder metadata and baseline history live under the Git common-dir shared by all worktrees. Raw `npx vitest` is not intercepted because this repo has no worktree-safe way to hijack it without dependency-graph or shell-environment side effects; instead the repo adds a sanctioned direct entrypoint, `npm run test:vitest -- ...`, and updates agent guidance to use sanctioned commands only.

**Tech Stack:** Node.js, TypeScript, `tsx`, npm scripts, `child_process`, `net`, `fs/promises`, Zod, Vitest.

---

## Strategy Gate

The previous plan was solving the wrong problem at the wrong layer:

- `flock` made public repo commands Linux/WSL-only.
- dependency-based Vitest interception required `npm install` side effects that are unsafe in shared or symlinked worktree setups.
- composite command behavior was still implicit shell behavior instead of an explicit repo contract.

The clean steady-state model is:

1. freeze the public CLI contract for every sanctioned test command and forwarded-arg form this repo already uses;
2. coordinate only sanctioned broad one-shot workloads through one repo-owned runtime;
3. use a cross-platform socket/pipe endpoint as the only mutual-exclusion primitive;
4. store advisory holder and baseline records under the Git common-dir;
5. provide a sanctioned direct Vitest passthrough command so agents have an ergonomic alternative to raw `npx vitest`.

That directly solves the user’s goal without platform narrowing, install-time mutation, or ambiguous shell contracts.

## Frozen Design Decisions

### 1. Coordination Boundary

Only sanctioned repo commands are guaranteed to pass through the repo-owned coordinator. Of those, only broad one-shot workloads are coordinated:

- `npm test`
- `npm run test:all`
- `npm run check`
- `npm run verify`
- `npm run test:coverage`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:client`
- `npm run test:server`
- `npm run test:watch`
- `npm run test:ui`
- `npm run test:status`
- `npm run test:vitest -- ...`

Raw `npx vitest ...` and `./node_modules/.bin/vitest ...` remain out of contract in v1. They are documented as unsupported for coordinated broad runs. The sanctioned replacement for direct Vitest usage is `npm run test:vitest -- ...`.

### 2. The Lock Primitive Is A Repo-Specific Socket/Pipe

The coordinated runner binds one repo-specific local endpoint:

- Unix/WSL/macOS: socket path derived from a hash of the Git common-dir and placed under `os.tmpdir()`
- Windows: named pipe derived from the same hash

Rules:

- successful bind means the coordinated runner owns the lock;
- bind failure plus a successful status connection means another coordinated run is active;
- Unix stale socket files are cleaned only after a failed connection proves there is no live owner;
- holder JSON is advisory only and never treated as proof of liveness.

### 3. Shared State Lives Under The Git Common-Dir

Persist under a repo-owned directory inside the Git common-dir:

- `holder.json`
- `latest-command-runs.json`
- `latest-suite-runs.json`
- `latest-reusable-success.json`

Every worktree for the same repo sees the same active-holder and baseline state.

### 4. Advisory Baselines Are Exact-Match And Non-Authoritative

Reusable baseline identity is frozen to:

- `suiteKey`
- `repo.commit`
- `repo.cleanWorktree === true`
- `runtime.nodeVersion`
- `runtime.platform`
- `runtime.arch`

Rules:

- only successful coordinated suite runs can publish reusable baselines;
- later failures do not erase an older reusable success for the same identity;
- the coordinator may surface a matching reusable success in `test:status`;
- `npm test`, `npm run check`, and `npm run verify` never auto-succeed from cache;
- the repo rule requiring a fresh `npm test` before landing remains unchanged.

### 5. Wait Semantics Are Fixed

For every coordinated workload:

- try the lock immediately;
- if busy, print current time, holder info if available, and baseline info if relevant;
- poll once per minute;
- wait up to one hour;
- never kill a run the current process did not start;
- exit nonzero only on timeout or internal failure.

## Frozen Public CLI Contract

### Command Matrix

| Command | No forwarded args | Narrowed / interactive forwarded args |
| --- | --- | --- |
| `npm test` | coordinated `full-suite` | delegated or rejected by classifier |
| `npm run test:all` | coordinated `full-suite` | delegated or rejected by classifier |
| `npm run check` | delegated `typecheck`, then coordinated `full-suite` | delegated or rejected test phase by classifier; `typecheck` still runs |
| `npm run verify` | delegated `build`, then coordinated `full-suite` | delegated or rejected test phase by classifier; `build` still runs |
| `npm run test:coverage` | coordinated `client-coverage` | delegated exact upstream invocation |
| `npm run test:unit` | coordinated `unit-all` | delegated exact upstream invocation |
| `npm run test:integration` | coordinated `integration-all` | delegated exact upstream invocation |
| `npm run test:client` | coordinated `client-unit-all` | delegated exact upstream invocation |
| `npm run test:server` | delegated upstream default watch-capable server command | delegated exact upstream invocation; `--run` with no narrowing becomes coordinated `server-all` |
| `npm run test:watch` | delegated upstream watch command | delegated upstream watch command |
| `npm run test:ui` | delegated upstream UI command | delegated upstream UI command |
| `npm run test:status` | delegated status output | delegated status output |
| `npm run test:vitest -- ...` | classified from forwarded Vitest argv | classified from forwarded Vitest argv |

### Forwarded-Arg Rules

Coordinator-owned options:

- `--summary "<text>"`
- `FRESHELL_TEST_SUMMARY`

Unconditional passthrough:

- `--help`
- `-h`
- `--version`
- `-v`

Always delegated:

- `--watch`
- `-w`
- `--ui`
- `-t`, `--testNamePattern`
- explicit file or directory targets that narrow a single-phase command

Delegated-or-rejected on composite commands (`test`, `test:all`, `check`, `verify`):

- selectors that classify cleanly to one phase are delegated to that single upstream phase;
- mixed client + server selectors are rejected with an instruction to split the command;
- `--reporter` is rejected on composite commands because the repo will not fake merged reporter semantics across split phases;
- `--config vitest.server.config.ts` on a composite command delegates to a single server phase;
- `--run` on `npm test` / `npm run test:all` is an accepted compatibility no-op.

### Existing Repo Forms That Must Be Preserved Explicitly

These forms are part of the contract and must have tests:

```bash
npm test -- test/unit/server/terminal-registry.test.ts -t "reaping exited terminals"
npm test -- --run test/unit/client/store/panesSlice.test.ts
npm run test:server -- test/unit/server/sessions-sync/diff.test.ts
npm run test:client -- --run test/unit/client/components/Sidebar.test.tsx
npm run test:unit -- test/unit/server/coding-cli/utils.test.ts
npm run test:vitest -- --config vitest.server.config.ts test/server/ws-protocol.test.ts
```

The classifier must map each of those to either:

- a coordinated suite,
- one truthful delegated upstream invocation,
- or an explicit rejection.

## Data Contracts

### Holder Record

Required fields:

- `schemaVersion`
- `summary`
- `summarySource`
- `startedAt`
- `pid`
- `hostname`
- `username`
- `entrypoint.commandKey`
- `entrypoint.suiteKey`
- `command.display`
- `command.argv`
- `repo.invocationCwd`
- `repo.checkoutRoot`
- `repo.repoRoot`
- `repo.commonDir`
- `repo.worktreePath`
- `repo.branch`
- `repo.commit`
- `repo.cleanWorktree`
- `runtime.nodeVersion`
- `runtime.platform`
- `runtime.arch`
- `agent.kind`
- `agent.sessionId`
- `agent.threadId`

If the socket/pipe is live but `holder.json` is missing, partial, or corrupt, `test:status` must report `running-undescribed`.

### Result Records

Command and suite records are stored separately. Each record includes:

- `status`
- `exitCode`
- `startedAt`
- `finishedAt`
- `durationMs`
- summary and agent metadata
- repo identity
- runtime identity

Suite records additionally include:

- `suiteKey`
- `reusable`
- `source.commandKey`

## File Plan

**Modify**

- `/home/user/code/freshell/.worktrees/test-run-gate/package.json`
- `/home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md`
- `/home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md`
- `/home/user/code/freshell/.worktrees/test-run-gate/server/coding-cli/utils.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/coding-cli/utils.test.ts`

**Create**

- `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-command-matrix.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-store.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-socket.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-status.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-upstream.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/testing/fake-coordinated-workload.mjs`
- `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/testing/temp-test-coordinator-env.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-store.test.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-command-matrix.test.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-socket.test.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-status.test.ts`
- `/home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-coordinator.test.ts`

## Task 1: Build Repo Identity And Shared Store Primitives

**Files:**

- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/server/coding-cli/utils.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/coding-cli/utils.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-store.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-store.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- `resolveInvocationCwd()` preferring `INIT_CWD` when npm supplies it;
- `resolveGitCommonDir()` in a linked worktree;
- resolving checkout root, repo root, branch, commit, and dirty state from a worktree cwd;
- atomic store writes and corrupt JSON tolerance;
- reusable success surviving a later failure for the same reusable identity.

**Step 2: Run the targeted tests and verify they fail**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts
```

**Step 3: Write the minimal implementation**

Extend `server/coding-cli/utils.ts` with repo helpers the coordinator can reuse:

```ts
export async function resolveGitCommonDir(cwd: string): Promise<string | undefined>
export function resolveInvocationCwd(envVars: NodeJS.ProcessEnv = process.env): string | undefined
export async function resolveGitIdentity(cwd: string): Promise<{
  invocationCwd?: string
  checkoutRoot?: string
  repoRoot?: string
  commonDir?: string
  branch?: string
  commit?: string
  cleanWorktree?: boolean
}>
```

Implement store helpers that keep lock state out of band and write JSON atomically with temp-file-plus-rename semantics.

**Step 4: Re-run the targeted tests and verify they pass**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts
```

**Step 5: Commit**

```bash
git add /home/user/code/freshell/.worktrees/test-run-gate/server/coding-cli/utils.ts /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/coding-cli/utils.test.ts /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-store.ts /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-store.test.ts
git commit -m "test: add shared test coordination store primitives"
```

## Task 2: Freeze The Command Matrix And Composite Arg Classifier

**Files:**

- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-command-matrix.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-command-matrix.test.ts`

**Step 1: Write the failing tests**

Cover:

- every sanctioned command in the matrix above;
- the exact preserved forms listed earlier;
- `--watch` / `-w` always delegating, even in CI or non-TTY;
- `--help`, `-h`, `--version`, and `-v` passthrough behavior;
- `--reporter` passing only on delegated single-phase runs and rejecting on composites;
- composite-command classification for client-only selectors, server-only selectors, and mixed selectors;
- `npm run test:server -- --run` becoming coordinated `server-all`;
- `npm test -- --run` behaving as a compatibility no-op.

**Step 2: Run the targeted tests and verify they fail**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-command-matrix.test.ts
```

**Step 3: Write the minimal implementation**

Implement one pure classifier module:

```ts
export type CommandDisposition =
  | { kind: 'coordinated'; suiteKey: string; upstreamPhases: UpstreamPhase[] }
  | { kind: 'delegated'; upstream: UpstreamInvocation }
  | { kind: 'rejected'; reason: string }
  | { kind: 'passthrough'; target: 'coordinator-help' | 'upstream-help' | 'upstream-version' }

export function classifyCommand(input: CoordinatorInput): CommandDisposition
```

The module must encode the contract directly instead of depending on npm shell behavior.

**Step 4: Re-run the targeted tests and verify they pass**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-command-matrix.test.ts
```

**Step 5: Commit**

```bash
git add /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-command-matrix.ts /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-command-matrix.test.ts
git commit -m "test: freeze coordinated test command contract"
```

## Task 3: Implement Cross-Platform Coordination Runtime And Status Projection

**Files:**

- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-socket.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-status.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-upstream.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/testing/fake-coordinated-workload.mjs`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/testing/temp-test-coordinator-env.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-socket.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-status.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-coordinator.test.ts`

**Step 1: Write the failing unit and subprocess-integration tests**

Cover:

- endpoint-name derivation from Git common-dir hash on Unix and Windows;
- stale Unix socket cleanup only after failed connect;
- `test:status` reporting `idle`, `running`, and `running-undescribed`;
- coordinated runs waiting behind an active coordinated run with once-per-minute polling output;
- timeout behavior using shortened fixture time budgets;
- holder cleanup on success, failure, and coordinator exception;
- command history vs suite history vs latest reusable success separation;
- `check` and `verify` only coordinating their test phases;
- no code path that kills a foreign process.

**Step 2: Run the targeted tests and verify they fail**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-socket.test.ts test/unit/server/test-coordinator-status.test.ts test/integration/server/test-coordinator.test.ts
```

**Step 3: Write the minimal implementation**

Implement the runtime in three layers:

```ts
// test-coordinator-socket.ts
export async function tryStartCoordinatorServer(identity: RepoIdentity): Promise<StartedServer | undefined>
export async function readActiveCoordinator(identity: RepoIdentity): Promise<ActiveCoordinator | undefined>

// test-coordinator-status.ts
export async function buildStatus(identity: RepoIdentity, requestedSuite?: string): Promise<StatusView>

// test-coordinator.ts
if (disposition.kind === 'delegated') return runUpstream(disposition.upstream)
if (disposition.kind === 'coordinated') return runCoordinated(disposition)
```

`runCoordinated()` must:

- start or connect to the repo-specific server;
- persist holder metadata only after the server is live;
- wait/poll up to one hour if another coordinated run is active;
- execute upstream phases sequentially;
- persist command and suite results in `finally`;
- remove advisory holder metadata only if it still belongs to the current pid/run.

**Step 4: Re-run the targeted tests and verify they pass**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-socket.test.ts test/unit/server/test-coordinator-status.test.ts test/integration/server/test-coordinator.test.ts
```

**Step 5: Commit**

```bash
git add /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator.ts /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-socket.ts /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-status.ts /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-upstream.ts /home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/testing/fake-coordinated-workload.mjs /home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/testing/temp-test-coordinator-env.ts /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-socket.test.ts /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-status.test.ts /home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-coordinator.test.ts
git commit -m "feat: add cross-platform coordinated test runtime"
```

## Task 4: Wire Sanctioned Public Commands And Publish The Workflow

**Files:**

- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package.json`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md`

**Step 1: Write the failing assertions or fixture checks**

Extend command-matrix or integration coverage to assert:

- every public npm test script points at the repo-owned coordinator entrypoint;
- `test:status` exists;
- `test:vitest` exists and is documented as the sanctioned direct Vitest path;
- `docs/skills/testing.md` no longer claims `npm test` is watch mode.

**Step 2: Run the targeted tests and verify they fail**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-command-matrix.test.ts test/integration/server/test-coordinator.test.ts
```

**Step 3: Write the minimal implementation**

Rewire scripts so the contract is explicit:

```json
{
  "test": "tsx scripts/testing/test-coordinator.ts run test",
  "test:all": "tsx scripts/testing/test-coordinator.ts run test:all",
  "check": "tsx scripts/testing/test-coordinator.ts run check",
  "verify": "tsx scripts/testing/test-coordinator.ts run verify",
  "test:status": "tsx scripts/testing/test-coordinator.ts status",
  "test:vitest": "tsx scripts/testing/test-coordinator.ts vitest"
}
```

Document:

- how to pass `--summary` or `FRESHELL_TEST_SUMMARY`;
- how `test:status` exposes active-holder and reusable baseline info;
- that agents must wait rather than kill another run;
- that direct `npx vitest` broad runs are unsupported and `npm run test:vitest -- ...` is the sanctioned replacement.

**Step 4: Re-run the targeted tests and verify they pass**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/test-coordinator-command-matrix.test.ts test/integration/server/test-coordinator.test.ts
```

**Step 5: Commit**

```bash
git add /home/user/code/freshell/.worktrees/test-run-gate/package.json /home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md /home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md
git commit -m "docs: publish sanctioned coordinated test entrypoints"
```

## Task 5: Final Verification And Safety Checks

**Files:**

- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package.json`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/server/coding-cli/utils.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/coding-cli/utils.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-command-matrix.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-store.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-socket.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-status.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-upstream.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/testing/fake-coordinated-workload.mjs`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/testing/temp-test-coordinator-env.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-store.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-command-matrix.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-socket.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-status.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-coordinator.test.ts`

**Step 1: Verify targeted coverage before any broad suite**

Do not run `npm test`, `npm run check`, or `npm run verify` until Tasks 1-4 are complete. Before that point, use only the targeted commands listed in the earlier tasks.

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/utils.test.ts test/unit/server/test-coordinator-store.test.ts test/unit/server/test-coordinator-command-matrix.test.ts test/unit/server/test-coordinator-socket.test.ts test/unit/server/test-coordinator-status.test.ts test/integration/server/test-coordinator.test.ts
```

Expected: PASS.

**Step 2: Verify the sanctioned status and direct-entry commands**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npm run test:status
npm run test:vitest -- --help
npm run test:server -- --help
```

Expected:

- `test:status` prints idle or active-holder status plus reusable baseline info without crashing;
- `test:vitest -- --help` shows upstream Vitest help through the coordinator passthrough;
- `test:server -- --help` shows truthful upstream server-test help behavior.

**Step 3: Run the full coordinated suite once the coordinator exists**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npm test
npm run check
```

Expected:

- the coordinated runner acquires the repo lock or waits behind another active run;
- broad runs no longer collide when multiple sanctioned commands start at once;
- `check` still performs typecheck plus a coordinated full-suite test phase.

**Step 4: Commit the verified end state**

```bash
git add /home/user/code/freshell/.worktrees/test-run-gate/package.json /home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md /home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md /home/user/code/freshell/.worktrees/test-run-gate/server/coding-cli/utils.ts /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/coding-cli/utils.test.ts /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator.ts /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-command-matrix.ts /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-store.ts /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-socket.ts /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-status.ts /home/user/code/freshell/.worktrees/test-run-gate/scripts/testing/test-coordinator-upstream.ts /home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/testing/fake-coordinated-workload.mjs /home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/testing/temp-test-coordinator-env.ts /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-store.test.ts /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-command-matrix.test.ts /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-socket.test.ts /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-coordinator-status.test.ts /home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-coordinator.test.ts
git commit -m "feat: coordinate sanctioned broad test runs"
```
