# Unified Test Coordination And Advisory Baselines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Replace the repo's uncoordinated broad test entrypoints with one repo-owned coordinator that serializes broad one-shot test workloads, reports truthful active-holder and baseline status across worktrees, and preserves the exact current behavior of every public test command.

**Architecture:** Add a TypeScript coordinator CLI at `scripts/testing/test-coordinator.ts` and route every public test command through it in the same change. The coordinator classifies each invocation by workload shape, delegates focused/watch/help flows directly to upstream tools, and gates only broad one-shot workloads behind a repo-wide local socket or named-pipe endpoint keyed by the Git common-dir. Advisory holder and last-run data live as schema-validated JSON under the Git common-dir so every worktree sees the same status and reusable exact-commit baselines without relying on stale sentinel files.

**Tech Stack:** Node.js, TypeScript, `tsx`, `child_process`, `net`, `fs/promises`, Zod, Vitest.

---

## Strategy Gate

Previous planning rounds kept drifting because they solved the problem at the wrong layer. The correct implementation boundary is the repo-owned command contract, not patched dependencies or ad-hoc process detection.

These decisions are now fixed:

- Do not patch `node_modules`, mutate Vitest during `postinstall`, or rely on shell aliases. Those approaches are brittle in shared worktrees and impossible to reason about under trycycle review.
- Do not use lock files as liveness truth. The bound socket or named pipe is the only lock; JSON files are advisory only.
- Do not change the real meaning of existing public commands. Coordinate the exact workloads they run today, even when their names are misleading.
- Do not promise strict FIFO queueing. This implementation provides truthful serialized waiting with crash-safe lock release, which is more important than perfect ordering.
- Do not stage a partial cutover. Public scripts, coordinator runtime, holder/status output, baseline records, and docs land together.

This directly addresses the user's goal: broad repo-supported test runs wait their turn safely, status remains truthful across crashes and worktrees, and agents get actionable last-run information without silently skipping an explicitly requested run.

## Frozen Product Contract

### 1. Public Commands Keep Their Current Meaning

The coordinator must preserve the exact current no-arg behavior of each public command. The suite keys intentionally describe the actual upstream invocation, not an inferred marketing name.

| Command key | Current no-arg upstream behavior | Coordinator behavior |
| --- | --- | --- |
| `test` | `vitest run` then `vitest run --config vitest.server.config.ts` | Coordinated suite `full-suite` |
| `test:all` | `vitest run` then `vitest run --config vitest.server.config.ts` | Coordinated suite `full-suite` |
| `check` | `npm run typecheck` then `npm test` | Run `typecheck` first, then coordinated suite `full-suite` |
| `verify` | `npm run build` then `npm test` | Run `build` first, then coordinated suite `full-suite` |
| `test:coverage` | `vitest run --coverage` | Coordinated suite `default:coverage` |
| `test:unit` | `vitest run test/unit` under the default config, which excludes `test/unit/server/**` | Coordinated suite `default:test/unit` |
| `test:client` | `vitest run test/unit/client` | Coordinated suite `default:test/unit/client` |
| `test:integration` | `vitest run --config vitest.server.config.ts test/server` | Coordinated suite `server:test/server` |
| `test:server` | `vitest --config vitest.server.config.ts` | Delegated by default; coordinated only for explicit broad one-shot `--run` with no narrowing target as suite `server:all:run` |
| `test:watch` | `vitest` | Always delegated |
| `test:ui` | `vitest --ui` | Always delegated |
| `test:status` | New status command | Always delegated to coordinator status output |
| `test:vitest` | New repo-owned direct Vitest path | Classified from forwarded Vitest argv |

Two fresheyes findings are fixed here explicitly:

- `test:unit` must not be relabeled as "all unit tests". Its coordinated suite is the exact default-config `test/unit` workload that exists today.
- `test:integration` must not be relabeled as "all server integration tests". Its coordinated suite is the exact server-config `test/server` workload that exists today.

### 2. Forwarded-Arg Rules Are Explicit

The classifier must freeze all public behaviors instead of letting shell composition decide accidentally.

Coordinator-owned metadata inputs:

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
- `-t`
- `--testNamePattern`
- any explicit file or directory target that narrows a single-phase command

Composite-command rules for `test`, `test:all`, `check`, and `verify`:

- server-only selectors delegate to one truthful server upstream invocation
- client-only selectors delegate to one truthful default-config upstream invocation
- mixed client-plus-server selectors are rejected with an instruction to split the command
- `--reporter` is rejected on composite commands because the coordinator will not fake merged reporter semantics across split phases
- `--run` on `test` or `test:all` is accepted as a compatibility no-op

Single-phase rules:

- `test:server -- --run` with no narrowing target is a coordinated `server:all:run`
- `test:server -- <file>` or `test:server -- -t ...` stays delegated
- if a narrowed target is excluded from the command's default config but clearly belongs to the other config, delegate to the truthful owning config instead of pretending the legacy command can run it; for example, `test:unit -- test/unit/server/...` delegates to the server config
- `test:unit`, `test:client`, `test:integration`, and `test:coverage` coordinate only for their exact broad one-shot workload; any narrowing selector delegates exact upstream behavior
- `--reporter` is allowed on delegated single-phase invocations and rejected on coordinated multi-phase invocations

These real repo forms must have explicit classifier tests:

```bash
npm test -- test/unit/server/terminal-registry.test.ts -t "reaping exited terminals"
npm test -- --run test/unit/client/store/panesSlice.test.ts
npm run test:server -- test/unit/server/sessions-sync/diff.test.ts
npm run test:client -- --run test/unit/client/components/Sidebar.test.tsx
npm run test:unit -- test/unit/server/coding-cli/utils.test.ts
npm run test:vitest -- --config vitest.server.config.ts test/server/ws-protocol.test.ts
```

Each form must resolve to exactly one of:

- a coordinated broad workload
- one truthful delegated upstream invocation
- an explicit rejection with guidance

### 3. Socket Or Named Pipe Is The Only Lock

The lock primitive is a repo-specific local endpoint derived from the Git common-dir hash.

Unix and WSL:

- derive `repoHash = sha256(commonDir).slice(0, 12)`
- choose the shortest existing base directory from `process.env.XDG_RUNTIME_DIR`, `/tmp`, and `os.tmpdir()`
- first candidate path: `<base>/frt-<repoHash>.sock`
- fallback candidate path: `<base>/f-<repoHash>.sock`
- require `Buffer.byteLength(path) <= 90` to stay safely below platform socket-length limits
- if no candidate fits, throw an explicit actionable error telling the user to shorten the runtime directory or set `XDG_RUNTIME_DIR`

Windows:

- named pipe: `\\\\.\\pipe\\freshell-test-<repoHash>`

Rules:

- successful bind means the current process owns the coordinated workload lock
- connection success means another coordinated run is active
- stale Unix socket files are removed only after a failed connection proves there is no live owner
- advisory JSON files never prove liveness on their own

### 4. Shared State Lives Under The Git Common-Dir

Store coordinator state under `path.join(commonDir, 'freshell-test-coordinator')`.

Files:

- `holder.json`
- `command-runs.json`
- `suite-runs.json`
- `reusable-success.json`

Use Zod schemas for every on-disk structure and keep naming aligned with existing git metadata:

- use `repo.isDirty`
- do not invent a parallel `cleanWorktree` field
- reusable success means `repo.isDirty === false`

Suggested schema shapes:

```ts
type HolderRecord = {
  schemaVersion: 1
  runId: string
  summary: string
  summarySource: 'flag' | 'env' | 'fallback'
  startedAt: string
  pid: number
  hostname?: string
  username?: string
  entrypoint: { commandKey: string; suiteKey?: string }
  command: { display: string; argv: string[] }
  repo: {
    invocationCwd?: string
    checkoutRoot: string
    repoRoot: string
    commonDir: string
    worktreePath: string
    branch?: string
    commit?: string
    isDirty?: boolean
  }
  runtime: { nodeVersion: string; platform: string; arch: string }
  agent: { kind?: string; sessionId?: string; threadId?: string }
}

type LatestRunsFile = {
  schemaVersion: 1
  byKey: Record<string, LatestRunRecord>
}

type ReusableSuccessFile = {
  schemaVersion: 1
  byReusableKey: Record<string, ReusableSuccessRecord>
}
```

Reusable success key:

```ts
`${suiteKey}|${commit}|dirty:${isDirty ? 1 : 0}|node:${process.version}|${process.platform}|${process.arch}`
```

Rules:

- only successful coordinated runs can update reusable-success records
- only clean worktrees (`isDirty === false`) are reusable
- later failures update latest command and suite results but do not erase an older reusable success for the same exact reusable key
- if the endpoint is live but `holder.json` is missing, partial, or corrupt, status must report `running-undescribed`

### 5. Upstream Execution Is Direct And Recursion-Safe

The coordinator must never call public test scripts from inside itself.

Implementation requirements:

- run Vitest directly by resolving the repo-local Vitest entry module and spawning it with `process.execPath`
- run `npm run typecheck` and `npm run build` directly for the `check` and `verify` pre-phases
- set `FRESHELL_TEST_COORDINATOR_ACTIVE=1` on any child process launched from the coordinator
- refuse to enter public `run` mode if `FRESHELL_TEST_COORDINATOR_ACTIVE=1` is already set, so future script rewiring fails fast instead of deadlocking recursively
- propagate numeric upstream exit codes exactly
- if an owned child exits by signal, mirror the signal or use the conventional nonzero shell exit path; do not rewrite a failing exit code to zero

The subprocess fixture should stay `.mjs`, not `.ts`, so the integration tests can run it under plain `node` without nested `tsx` startup, loader ambiguity, or distorted exit/signal behavior.

### 6. Wait And Status Semantics Are Fixed

For every coordinated workload:

- attempt the lock immediately
- if busy, print the current time, holder information if available, and matching reusable baseline information if available
- poll roughly once per minute
- wait up to 24 hours
- never kill a workload the current process did not start
- never silently succeed from cached results
- make waiting output clearly state that the command is queued intentionally

`test:status` must surface:

- whether the repo is `idle`, `running`, or `running-undescribed`
- holder summary, elapsed time, branch, worktree, command, pid, and resume/session/thread metadata when available
- latest command result for the inspected command
- latest suite result for the inspected suite
- latest reusable exact-match success for the current commit/runtime when one exists
- bare `npm run test:status` should show current holder information, the latest reusable `full-suite` baseline when present, and a compact latest-results summary by command key; waiting callers may request a more specific suite view internally

## File Plan

**Modify**

- `package.json`
- `AGENTS.md`
- `docs/skills/testing.md`
- `server/coding-cli/utils.ts`
- `test/unit/server/coding-cli/resolve-git-root.test.ts`
- `test/unit/server/coding-cli/git-metadata.test.ts`

**Create**

- `scripts/testing/test-coordinator.ts`
- `scripts/testing/coordinator-command-matrix.ts`
- `scripts/testing/coordinator-schema.ts`
- `scripts/testing/coordinator-store.ts`
- `scripts/testing/coordinator-endpoint.ts`
- `scripts/testing/coordinator-status.ts`
- `scripts/testing/coordinator-upstream.ts`
- `test/fixtures/testing/fake-coordinated-workload.mjs`
- `test/unit/server/testing/coordinator-command-matrix.test.ts`
- `test/unit/server/testing/coordinator-store.test.ts`
- `test/unit/server/testing/coordinator-endpoint.test.ts`
- `test/unit/server/testing/coordinator-status.test.ts`
- `test/unit/server/testing/coordinator-upstream.test.ts`
- `test/integration/server/test-coordinator.test.ts`

## Task 1: Freeze The Command Contract In A Pure Classifier

**Files:**

- Create: `scripts/testing/coordinator-command-matrix.ts`
- Create: `test/unit/server/testing/coordinator-command-matrix.test.ts`

**Step 1: Write the failing tests**

Cover:

- the full no-arg matrix above
- `test:unit` mapping to `default:test/unit`, not any "unit-all" alias
- `test:integration` mapping to `server:test/server`, not any "server-all" alias
- `test:server` default delegation versus `--run` broad coordination
- narrowed targets that belong to the other config delegating to the truthful owner, including `test:unit -- test/unit/server/...`
- `--watch` and `--ui` always delegating
- `--help`, `-h`, `--version`, and `-v` bypassing the gate
- `--reporter` rejection on composite commands and acceptance on delegated single-phase runs
- the preserved real command forms listed above

**Step 2: Run the targeted test and verify it fails**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/testing/coordinator-command-matrix.test.ts
```

Expected: FAIL because the classifier module does not exist yet.

**Step 3: Write the minimal implementation**

Implement one pure classifier module with no I/O:

```ts
export type SuiteKey =
  | 'full-suite'
  | 'default:coverage'
  | 'default:test/unit'
  | 'default:test/unit/client'
  | 'server:test/server'
  | 'server:all:run'

export type CommandDisposition =
  | { kind: 'coordinated'; suiteKey: SuiteKey; phases: UpstreamPhase[] }
  | { kind: 'delegated'; phases: UpstreamPhase[] }
  | { kind: 'passthrough'; phases: UpstreamPhase[] }
  | { kind: 'rejected'; reason: string }

export function classifyCommand(input: CoordinatorInput): CommandDisposition
```

Make the suite definitions encode exact upstream invocations. Do not infer broader semantics from command names.

**Step 4: Re-run the targeted test and verify it passes**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/testing/coordinator-command-matrix.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/testing/coordinator-command-matrix.ts test/unit/server/testing/coordinator-command-matrix.test.ts
git commit -m "test: freeze coordinated test command contract"
```

## Task 2: Add Repo Identity Helpers And Schema-Validated Result Stores

**Files:**

- Modify: `server/coding-cli/utils.ts`
- Modify: `test/unit/server/coding-cli/resolve-git-root.test.ts`
- Modify: `test/unit/server/coding-cli/git-metadata.test.ts`
- Create: `scripts/testing/coordinator-schema.ts`
- Create: `scripts/testing/coordinator-store.ts`
- Create: `test/unit/server/testing/coordinator-store.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- `resolveGitCommonDir()` on a regular repo and on a linked worktree using the same `.git` and `commondir` patterns already tested in `resolve-git-root.test.ts`
- `resolveInvocationCwd()` preferring `INIT_CWD`
- keeping the existing `isDirty` naming instead of introducing `cleanWorktree`
- atomic writes for every JSON store
- corrupt or missing JSON files being tolerated and treated as empty advisory state
- reusable success surviving a later failure for the same reusable key

**Step 2: Run the targeted tests and verify they fail**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/resolve-git-root.test.ts test/unit/server/coding-cli/git-metadata.test.ts test/unit/server/testing/coordinator-store.test.ts
```

Expected: FAIL because the new helper and store modules do not exist yet.

**Step 3: Write the minimal implementation**

Extend the existing git-helper family instead of inventing a second repo parser:

```ts
export async function resolveGitCommonDir(cwd: string): Promise<string | undefined>
export function resolveInvocationCwd(envVars: NodeJS.ProcessEnv = process.env): string | undefined
```

Create Zod schemas and store helpers:

```ts
export async function readHolder(storeDir: string): Promise<HolderRecord | undefined>
export async function writeHolder(storeDir: string, record: HolderRecord): Promise<void>
export async function clearHolderIfRunIdMatches(storeDir: string, runId: string): Promise<void>
export async function recordCommandResult(storeDir: string, result: LatestRunRecord): Promise<void>
export async function recordSuiteResult(storeDir: string, result: LatestRunRecord): Promise<void>
export async function recordReusableSuccess(storeDir: string, result: ReusableSuccessRecord): Promise<void>
```

Use temp-file-plus-rename atomic writes for every JSON file.

**Step 4: Re-run the targeted tests and verify they pass**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/resolve-git-root.test.ts test/unit/server/coding-cli/git-metadata.test.ts test/unit/server/testing/coordinator-store.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/coding-cli/utils.ts test/unit/server/coding-cli/resolve-git-root.test.ts test/unit/server/coding-cli/git-metadata.test.ts scripts/testing/coordinator-schema.ts scripts/testing/coordinator-store.ts test/unit/server/testing/coordinator-store.test.ts
git commit -m "test: add coordinator repo identity and stores"
```

## Task 3: Implement Endpoint Derivation And Truthful Status Projection

**Files:**

- Create: `scripts/testing/coordinator-endpoint.ts`
- Create: `scripts/testing/coordinator-status.ts`
- Create: `test/unit/server/testing/coordinator-endpoint.test.ts`
- Create: `test/unit/server/testing/coordinator-status.test.ts`

**Step 1: Write the failing tests**

Cover:

- Unix socket path derivation staying under the explicit byte-length cap
- fallback to a shorter Unix path name when the first candidate is too long
- actionable error when no Unix candidate fits
- Windows named pipe derivation from the same repo hash
- stale Unix socket cleanup only after a failed connection proves there is no live owner
- `idle`, `running`, and `running-undescribed` status rendering
- status showing latest command result, latest suite result, and matching reusable success

**Step 2: Run the targeted tests and verify they fail**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/testing/coordinator-endpoint.test.ts test/unit/server/testing/coordinator-status.test.ts
```

Expected: FAIL because the endpoint and status modules do not exist yet.

**Step 3: Write the minimal implementation**

Implement small focused modules:

```ts
export function buildCoordinatorEndpoint(commonDir: string, platform = process.platform): CoordinatorEndpoint
export async function tryListen(endpoint: CoordinatorEndpoint): Promise<ListeningServer | { kind: 'busy' }>
export async function readActiveHolder(endpoint: CoordinatorEndpoint): Promise<HolderRecord | 'running-undescribed' | undefined>
export async function buildStatusView(request: StatusRequest): Promise<StatusView>
```

Status must remain truthful even when `holder.json` is missing or corrupt.

**Step 4: Re-run the targeted tests and verify they pass**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/testing/coordinator-endpoint.test.ts test/unit/server/testing/coordinator-status.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/testing/coordinator-endpoint.ts scripts/testing/coordinator-status.ts test/unit/server/testing/coordinator-endpoint.test.ts test/unit/server/testing/coordinator-status.test.ts
git commit -m "test: add coordinator endpoint and status projection"
```

## Task 4: Implement Upstream Execution, Exact Exit Codes, And The Anti-Recursion Guard

**Files:**

- Create: `scripts/testing/coordinator-upstream.ts`
- Create: `test/fixtures/testing/fake-coordinated-workload.mjs`
- Create: `test/unit/server/testing/coordinator-upstream.test.ts`

**Step 1: Write the failing tests**

Cover:

- direct upstream Vitest argv generation for delegated and coordinated single-phase runs
- `--help` and `--version` bypassing coordination and reaching upstream Vitest
- delegated watch invocations converting to a truthful watch-capable upstream call
- exact numeric exit-code propagation from an upstream child
- recursion guard rejecting public `run` mode when `FRESHELL_TEST_COORDINATOR_ACTIVE=1`
- `.mjs` subprocess fixture behavior for exact exit-code and signal handling

**Step 2: Run the targeted tests and verify they fail**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/testing/coordinator-upstream.test.ts
```

Expected: FAIL because the upstream module and fixture do not exist yet.

**Step 3: Write the minimal implementation**

Implement the upstream runner around direct child-process spawning:

```ts
export function assertNoCoordinatorRecursion(envVars: NodeJS.ProcessEnv = process.env): void
export function resolveVitestCommand(repoRoot: string): { command: string; args: string[] }
export async function runUpstreamPhase(phase: UpstreamPhase, envVars?: NodeJS.ProcessEnv): Promise<number>
```

Use the `.mjs` fixture in subprocess tests because it runs under plain `node` without nested `tsx`, which keeps exit codes and signals trustworthy.

**Step 4: Re-run the targeted tests and verify they pass**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/testing/coordinator-upstream.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/testing/coordinator-upstream.ts test/fixtures/testing/fake-coordinated-workload.mjs test/unit/server/testing/coordinator-upstream.test.ts
git commit -m "test: add coordinator upstream runner"
```

## Task 5: Build The Coordinator CLI, Waiting Loop, And End-To-End Behavior

**Files:**

- Create: `scripts/testing/test-coordinator.ts`
- Create: `test/integration/server/test-coordinator.test.ts`

**Step 1: Write the failing integration tests**

Cover:

- one coordinated process acquiring the endpoint and publishing holder metadata
- a second coordinated process waiting behind it without killing it
- waiting output including current time, holder summary, branch/worktree, command, pid, and patience guidance
- once-per-minute polling logic using shortened test-only timers
- timeout behavior using a shortened test-only max wait
- holder cleanup on success, failure, and coordinator exception
- `running-undescribed` when the endpoint is live but holder metadata is absent
- `check` running `typecheck` before the coordinated test phase and propagating the exact failing pre-phase exit code
- `verify` running `build` before the coordinated test phase and propagating the exact failing pre-phase exit code
- latest reusable success being reported without silently short-circuiting an explicit run

**Step 2: Run the targeted integration test and verify it fails**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts
```

Expected: FAIL because the coordinator CLI does not exist yet.

**Step 3: Write the minimal implementation**

Implement `scripts/testing/test-coordinator.ts` with explicit subcommands:

```ts
// Public commands
tsx scripts/testing/test-coordinator.ts run <commandKey> [...forwardedArgs]
tsx scripts/testing/test-coordinator.ts status
```

`run` must:

1. parse and strip coordinator-owned metadata flags
2. classify the request
3. passthrough or delegate immediately when appropriate
4. for coordinated workloads, resolve repo identity and store paths
5. attempt the endpoint immediately
6. if busy, print status and poll until available or timed out
7. once holding the endpoint, write holder metadata, run phases sequentially, persist latest command and suite results, and only then clear holder metadata if `runId` still matches

Do not promise FIFO ordering. The behavior is serialized waiting with crash-safe release.

**Step 4: Re-run the targeted integration test and verify it passes**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/integration/server/test-coordinator.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/testing/test-coordinator.ts test/integration/server/test-coordinator.test.ts
git commit -m "feat: add coordinated test runner"
```

## Task 6: Rewire Public Scripts And Publish The New Workflow

**Files:**

- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `docs/skills/testing.md`
- Modify: `test/unit/server/testing/coordinator-command-matrix.test.ts`
- Modify: `test/integration/server/test-coordinator.test.ts`

**Step 1: Write the failing assertions**

Extend the existing tests to assert:

- every public test command routes through `scripts/testing/test-coordinator.ts`
- `test:status` exists
- `test:vitest` exists
- `docs/skills/testing.md` no longer claims `npm test` is watch mode
- docs describe the exact semantics of `test:unit`, `test:integration`, and `test:server`
- `AGENTS.md` tells agents to use `FRESHELL_TEST_SUMMARY`, `npm run test:status`, and `npm run test:vitest -- ...`, and to wait rather than kill a foreign holder

**Step 2: Run the targeted tests and verify they fail**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/testing/coordinator-command-matrix.test.ts test/integration/server/test-coordinator.test.ts
```

Expected: FAIL because the public script wiring and docs are still old.

**Step 3: Write the minimal implementation**

Rewire the public scripts:

```json
{
  "test": "tsx scripts/testing/test-coordinator.ts run test",
  "test:all": "tsx scripts/testing/test-coordinator.ts run test:all",
  "check": "tsx scripts/testing/test-coordinator.ts run check",
  "verify": "tsx scripts/testing/test-coordinator.ts run verify",
  "test:watch": "tsx scripts/testing/test-coordinator.ts run test:watch",
  "test:ui": "tsx scripts/testing/test-coordinator.ts run test:ui",
  "test:server": "tsx scripts/testing/test-coordinator.ts run test:server",
  "test:coverage": "tsx scripts/testing/test-coordinator.ts run test:coverage",
  "test:unit": "tsx scripts/testing/test-coordinator.ts run test:unit",
  "test:integration": "tsx scripts/testing/test-coordinator.ts run test:integration",
  "test:client": "tsx scripts/testing/test-coordinator.ts run test:client",
  "test:status": "tsx scripts/testing/test-coordinator.ts status",
  "test:vitest": "tsx scripts/testing/test-coordinator.ts run test:vitest"
}
```

Documentation must say plainly:

- broad repo-supported runs wait; they do not fail fast
- `test:unit` is the exact default-config `test/unit` workload
- `test:integration` is the exact server-config `test/server` workload
- `test:server` stays watch-capable by default and only coordinates explicit broad `--run`
- prior successful baselines are advisory only
- raw `npx vitest` is not a supported coordinated path; use `npm run test:vitest -- ...`

**Step 4: Re-run the targeted tests and verify they pass**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/testing/coordinator-command-matrix.test.ts test/integration/server/test-coordinator.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json AGENTS.md docs/skills/testing.md test/unit/server/testing/coordinator-command-matrix.test.ts test/integration/server/test-coordinator.test.ts
git commit -m "docs: publish coordinated test workflow"
```

## Task 7: Verify The Finished System Without A Fake Final Commit

**Files:**

- No new files. This task verifies the already-committed implementation.

**Step 1: Run all targeted coordinator coverage before any broad verification**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/unit/server/testing/coordinator-command-matrix.test.ts test/unit/server/testing/coordinator-store.test.ts test/unit/server/testing/coordinator-endpoint.test.ts test/unit/server/testing/coordinator-status.test.ts test/unit/server/testing/coordinator-upstream.test.ts test/integration/server/test-coordinator.test.ts test/unit/server/coding-cli/resolve-git-root.test.ts test/unit/server/coding-cli/git-metadata.test.ts
```

Expected: PASS.

**Step 2: Smoke-test the public status and passthrough surfaces**

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npm run test:status
npm run test:vitest -- --help
npm run test:server -- --help
```

Expected:

- `test:status` prints idle or active-holder status plus baseline information without crashing
- `test:vitest -- --help` shows upstream Vitest help
- `test:server -- --help` shows truthful upstream help for the watch-capable server command

**Step 3: Run the coordinated broad verification commands**

Do not start these until Steps 1 and 2 pass.

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
FRESHELL_TEST_SUMMARY="Verify coordinated full suite" npm test
FRESHELL_TEST_SUMMARY="Verify coordinated typecheck plus suite" npm run check
FRESHELL_TEST_SUMMARY="Verify coordinated build plus suite" npm run verify
```

Expected:

- each command either acquires the endpoint or waits behind another active holder
- no command kills a foreign holder
- `check` still runs typecheck before the coordinated full-suite phase
- `verify` still runs build before the coordinated full-suite phase

**Step 4: Do not create a blanket final commit**

If verification uncovers a defect:

- fix it in the task that owns that code
- re-run the smallest failing targeted tests first
- make a precise commit for that fix
- repeat Task 7

There must be no unconditional empty or catch-all final commit.
