# Test Run Gate And Baseline Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build a unified, cross-platform test gate that makes broad test entry points cooperate across repo worktrees, reports truthful live holder metadata, and exposes exact-checkout reusable baselines without turning public verification commands into silent no-ops on dirty trees.

**Architecture:** Use a repo-scoped Node IPC coordinator instead of `flock` so the gate works on Linux, macOS, WSL, and native Windows. All broad test paths cooperate through one shared library in two layers: a local `vitest` shim package that wraps upstream Vitest so raw `npx vitest run ...` broad runs participate automatically, and a `test-command` wrapper for every public npm test script so command-specific policies and summaries stay consistent. Baseline reuse is advisory on every broad invocation and only becomes an early exit when the current checkout identity is an exact clean match and the caller explicitly opts into reuse.

**Tech Stack:** Node.js, TypeScript, `net`, `fs/promises`, `child_process`, Git CLI, npm file dependencies, Vitest.

---

## Strategy Gate

- The user rejected phased or partial delivery, so the end state must cover both public npm scripts and habitual raw `npx vitest run` broad runs.
- The coordination primitive must be crash-safe and cross-platform. Use a repo-scoped IPC coordinator:
  - Unix: socket file under the Git common dir
  - Windows: named pipe derived from the Git common dir hash
- Holder truth comes from the coordinator’s live session state plus registered leader PIDs, not from an advisory file.
- Baseline reuse is not the default verification path. Every broad command checks for a reusable baseline and reports it, but early exit is allowed only when:
  - the cached run was clean and successful
  - the current checkout is also clean
  - commit, command, node version, and platform all match
  - the caller explicitly opts into reuse
- Preserve current interactive behavior:
  - `npm run test:server` stays watch-mode by default
  - `vitest` watch and `vitest --ui` stay ungated
  - explicit file-targeted runs stay immediate and ungated
- Freeze broad-vs-narrow rules:
  - explicit individual test files are narrowed
  - directories, globs, `-t`, `--changed`, `--project`, config-targeted subset suites, and no-selector runs are broad

## Design Decisions

- Shared gate state is rooted in `git rev-parse --git-common-dir`.
- Shared state contents:
  - live coordinator endpoint
  - `results.json`: bounded newest-first history of recent successful and failed broad runs
- No persistent `holder.json`. Status is answered live by the coordinator.
- Coordinator session state includes:
  - `commandKey`
  - `summary`
  - `startedAt`
  - `ownerPid`
  - `registeredLeaderPids`
  - `cwd`
  - `checkoutRoot`
  - `repoRoot`
  - `branch`
  - `currentCleanWorktree`
  - `nodeVersion`
  - `platform`
  - `sessionId` from `CODEX_THREAD_ID` when present
- Reusable baseline eligibility is frozen to both producer and consumer identity:
  - cached record: exact `commandKey`, exact `commit`, `cleanWorktree === true`, exact `nodeVersion`, exact `platform`, `exitCode === 0`
  - current checkout: exact same `commit`, exact same `nodeVersion`, exact same `platform`, and `currentCleanWorktree === true`
- Baseline behavior on broad invocations:
  - always check and print whether a reusable baseline exists
  - continue to run by default
  - only exit early when `--reuse-baseline` or `FRESHELL_REUSE_TEST_BASELINE=1` is set and the current checkout is an exact reusable match
  - `--force-run` or `FRESHELL_FORCE_TEST_RUN=1` suppresses reuse even when a match exists
- The coordinator, not the wrapper process, owns session truth. Wrappers and shims acquire a session and register broad-test leader PIDs. The coordinator keeps the session active while either the owner PID or any registered leader PID remains alive.
- Broad Vitest leaders run upstream through Vitest’s programmatic Node API (`startVitest`) inside the registered leader process. Do not `exec`-replace the coordinating process.
- Every current public test entry point is routed through the unified surface:
  - `test`
  - `check`
  - `verify`
  - `test:all`
  - `test:server`
  - `test:coverage`
  - `test:unit`
  - `test:integration`
  - `test:client`
- `test:watch` and `test:ui` remain direct interactive commands.

### Task 1: Add shared Git common-dir resolution for repo-wide gate state

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/server/coding-cli/utils.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/coding-cli/git-metadata.test.ts`

**Step 1: Write the failing tests for worktree-aware common-dir lookup**

Extend `test/unit/server/coding-cli/git-metadata.test.ts`:

```ts
import {
  clearRepoRootCache,
  resolveGitCheckoutRoot,
  resolveGitCommonDir,
} from '../../../../server/coding-cli/utils'

it('returns the shared git common dir for linked worktrees', async () => {
  const repoDir = path.join(tempDir, 'repo')
  const worktreeDir = path.join(tempDir, 'repo-worktree')
  await initRepo(repoDir, 'main')
  await runGit(['worktree', 'add', '-b', 'feature/test-gate', worktreeDir], repoDir)

  const nestedDir = path.join(worktreeDir, 'deep', 'child')
  await fsp.mkdir(nestedDir, { recursive: true })

  await expect(resolveGitCheckoutRoot(nestedDir)).resolves.toBe(worktreeDir)
  await expect(resolveGitCommonDir(nestedDir)).resolves.toBe(path.join(repoDir, '.git'))
})

it('returns undefined for directories outside git', async () => {
  const plainDir = path.join(tempDir, 'plain')
  await fsp.mkdir(plainDir, { recursive: true })

  await expect(resolveGitCommonDir(plainDir)).resolves.toBeUndefined()
})
```

**Step 2: Run the targeted test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/coding-cli/git-metadata.test.ts
```

Expected: FAIL because `resolveGitCommonDir` does not exist.

**Step 3: Implement the helper**

Add a cached helper in `server/coding-cli/utils.ts`:

```ts
const commonDirCache = new Map<string, string | undefined>()

export async function resolveGitCommonDir(cwd: string): Promise<string | undefined> {
  const normalized = normalizeGitPathInput(cwd)
  if (!normalized) return undefined

  const cached = commonDirCache.get(normalized)
  if (cached !== undefined) return cached

  const checkoutRoot = await resolveGitCheckoutRoot(normalized)
  try {
    const result = await execFileAsync('git', ['-C', checkoutRoot, 'rev-parse', '--git-common-dir'])
    const resolved = path.resolve(checkoutRoot, result.stdout.trim())
    commonDirCache.set(normalized, resolved)
    return resolved
  } catch {
    commonDirCache.set(normalized, undefined)
    return undefined
  }
}

export function clearRepoRootCache(): void {
  repoRootCache.clear()
  checkoutRootCache.clear()
  commonDirCache.clear()
}
```

**Step 4: Re-run the targeted test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/coding-cli/git-metadata.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/server/coding-cli/utils.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/coding-cli/git-metadata.test.ts
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): resolve shared git common dir"
```

### Task 2: Build the gate core with exact-checkout baseline rules and full invocation classification

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-core.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-gate-core.test.ts`

**Step 1: Write the failing unit tests**

Create `test/unit/server/test-gate-core.test.ts` with coverage for:
- endpoint naming from Git common dir
- Unix socket vs Windows named-pipe path generation
- reusable-baseline acceptance requiring both clean producer and clean current checkout
- advisory baseline reporting vs early-exit reuse eligibility
- classification for every public command and raw Vitest form
- directory/config-targeted subset suites as broad

Seed with cases like:

```ts
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildGateStatePaths,
  canReuseBaselineNow,
  classifyPublicCommand,
  classifyVitestInvocation,
  findReusableBaseline,
  type TestResultRecord,
} from '../../../scripts/test-gate-core.js'

describe('test-gate-core', () => {
  it('requires the current checkout to be clean before baseline reuse is allowed', () => {
    const record: TestResultRecord = {
      commandKey: 'full',
      commit: 'abc123',
      cleanWorktree: true,
      nodeVersion: 'v22.10.2',
      platform: 'linux',
      exitCode: 0,
      finishedAt: '2026-03-08T10:00:00.000Z',
    }

    expect(canReuseBaselineNow(record, {
      commandKey: 'full',
      commit: 'abc123',
      currentCleanWorktree: false,
      nodeVersion: 'v22.10.2',
      platform: 'linux',
    })).toBe(false)
  })

  it('treats directory-targeted subset suites as broad', () => {
    expect(classifyVitestInvocation(['run', 'test/unit'])).toEqual({ mode: 'broad-run' })
    expect(classifyVitestInvocation(['run', '--config', 'vitest.server.config.ts', 'test/server'])).toEqual({ mode: 'broad-run' })
  })

  it('routes every public one-shot entry point through a known command key', () => {
    expect(classifyPublicCommand('unit', [])).toEqual({ mode: 'broad-run', commandKey: 'unit' })
    expect(classifyPublicCommand('client', [])).toEqual({ mode: 'broad-run', commandKey: 'client' })
    expect(classifyPublicCommand('integration', [])).toEqual({ mode: 'broad-run', commandKey: 'integration' })
    expect(classifyPublicCommand('coverage', [])).toEqual({ mode: 'broad-run', commandKey: 'coverage' })
  })
})
```

**Step 2: Run the targeted test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-gate-core.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement the gate core**

Create `scripts/test-gate-core.ts` with:
- `buildGateStatePaths({ gitCommonDir, platform })`
- `buildCheckoutIdentity({ commandKey, commit, currentCleanWorktree, nodeVersion, platform })`
- `findReusableBaseline(history, query)`
- `canReuseBaselineNow(record, currentIdentity)`
- `pushResultHistory(history, record, limit = 20)`
- `classifyVitestInvocation(argv)`
- `classifyPublicCommand(commandKey, forwardedArgs)`
- atomic `readResultHistory()` and `writeResultHistory()`

Use structures like:

```ts
export type PublicCommandKey =
  | 'full'
  | 'all'
  | 'unit'
  | 'client'
  | 'integration'
  | 'coverage'
  | 'server'
  | 'check'
  | 'verify'
  | 'status'

export type InvocationPlan =
  | { mode: 'status' }
  | { mode: 'interactive-watch'; commandKey: PublicCommandKey; forwardedArgs: string[] }
  | { mode: 'narrowed-run'; commandKey: PublicCommandKey; forwardedArgs: string[] }
  | { mode: 'broad-run'; commandKey: PublicCommandKey; forwardedArgs: string[] }
```

**Step 4: Re-run the targeted test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-gate-core.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-core.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-gate-core.test.ts
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add exact-checkout gate core"
```

### Task 3: Implement the repo-wide coordinator with truthful session ownership

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-coordinator.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-leader.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/test-gate-coordinator.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-gate/fake-leader.mjs`

**Step 1: Write the failing integration tests**

Create `test/server/test-gate-coordinator.test.ts` to verify:
- first broad run acquires a session and reports live holder metadata
- second broad run waits, polls holder info, and starts after release
- coordinator keeps session active while registered leader PID is alive even if the wrapper/owner PID dies
- coordinator releases session after owner PID dies and no registered leader PIDs remain
- stale Unix socket file cleanup happens only after a failed probe
- timeout behavior is configurable for tests

Seed with a case like:

```ts
it('keeps the session held while a registered leader pid is still alive after owner exit', async () => {
  const owner = await startOwnerAndLeaderFixture()
  await waitForOutput(owner, 'LEADER_REGISTERED')

  await owner.killOwnerOnly()

  const status = await queryStatus()
  expect(status.active?.summary).toBe('broad run')
  expect(status.active?.registeredLeaderPids.length).toBe(1)
})
```

**Step 2: Run the integration test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/test-gate-coordinator.test.ts
```

Expected: FAIL because the coordinator and leader helper do not exist.

**Step 3: Implement the coordinator**

Create `scripts/test-gate-coordinator.ts` with:
- `ensureCoordinator(paths)` to start or connect to a single repo-scoped coordinator
- `acquireSession(context)`
- `registerLeaderPid(sessionId, pid, metadata)`
- `releaseLeaderPid(sessionId, pid)`
- `getStatus()`
- `waitForSession(context)`

Create `scripts/test-gate-leader.ts` as a helper that:
- connects to the coordinator
- registers its own PID before running broad work
- runs the broad test leader in-process
- unregisters in `finally`

Ownership rules:
- the coordinator session stores `ownerPid` plus `registeredLeaderPids`
- the coordinator considers the session active while either the owner PID or any registered leader PID is still alive
- public status and waiting messages come from the coordinator’s live session view

**Step 4: Re-run the integration test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/test-gate-coordinator.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-coordinator.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-leader.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/server/test-gate-coordinator.test.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-gate/fake-leader.mjs
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add truthful test gate coordinator"
```

### Task 4: Install a complete local `vitest` shim that preserves the package shape and gates raw broad runs

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/package.json`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/index.js`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/index.d.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/config.js`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/config.d.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/vitest.mjs`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/vitest-shim.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package.json`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package-lock.json`

**Step 1: Write the failing integration tests**

Create `test/server/vitest-shim.test.ts` to cover:
- `npx vitest run --reporter=verbose` is broad and routed through the coordinator
- `npx vitest run test/unit/server/auth.test.ts` stays narrowed and ungated
- `npx vitest run test/unit` is broad and gated
- `npx vitest run --config vitest.server.config.ts test/server` is broad and gated
- `npx vitest` watch and `npx vitest --ui` stay ungated
- imports from `vitest` and `vitest/config` still work
- the installed filesystem path `node_modules/vitest/vitest.mjs` exists and is the shimmed entrypoint

Include a contract test like:

```ts
it('preserves the installed vitest.mjs path expected by repo docs', async () => {
  const stat = await fs.stat(path.join(repoDir, 'node_modules', 'vitest', 'vitest.mjs'))
  expect(stat.isFile()).toBe(true)
})
```

**Step 2: Run the integration test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/vitest-shim.test.ts
```

Expected: FAIL because the shim package does not exist.

**Step 3: Implement and install the shim**

Create `tools/vitest-shim/package.json` as a local package named `vitest`:

```json
{
  "name": "vitest",
  "version": "3.2.4-freshell.0",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./config": "./config.js",
    "./package.json": "./package.json"
  },
  "bin": {
    "vitest": "./vitest.mjs"
  },
  "dependencies": {
    "vitest-upstream": "npm:vitest@^3.2.4"
  }
}
```

Implement:
- `index.js`: `export * from 'vitest-upstream'`
- `index.d.ts`: `export * from 'vitest-upstream'`
- `config.js`: `export * from 'vitest-upstream/config'`
- `config.d.ts`: `export * from 'vitest-upstream/config'`
- `vitest.mjs`: CLI wrapper that classifies the invocation, checks advisory baseline availability, optionally early-exits only with explicit reuse opt-in, and for broad one-shot runs hands execution to `scripts/test-gate-leader.ts`

Update root `package.json`:

```json
"devDependencies": {
  "vitest": "file:tools/vitest-shim"
}
```

Then run a real install so the new package and `.bin` are actually present:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npm install
```

Do not use `--package-lock-only`.

**Step 4: Re-run the integration test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/vitest-shim.test.ts
```

Expected: PASS, including the on-disk `node_modules/vitest/vitest.mjs` contract.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/package.json \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/index.js \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/index.d.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/config.js \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/config.d.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/vitest.mjs \
  /home/user/code/freshell/.worktrees/test-run-gate/test/server/vitest-shim.test.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/package.json \
  /home/user/code/freshell/.worktrees/test-run-gate/package-lock.json
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): install complete vitest gate shim"
```

### Task 5: Add the umbrella wrapper and route every current public test entry point through it

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/test-command.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-script-contract.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package.json`

**Step 1: Write the failing tests**

Create `test/server/test-command.test.ts` to verify:
- `npm test` checks for an advisory baseline, then by default still runs unless `--reuse-baseline` is present and the current checkout is clean
- `npm run check` and `npm run verify` behave the same way
- `--force-run` suppresses reuse
- `npm run test:unit`, `npm run test:client`, `npm run test:integration`, and `npm run test:coverage` are treated as broad one-shot commands
- `npm run test:server` stays watch-mode by default
- `npm run test:server -- --run` becomes a broad one-shot command

Create `test/unit/server/test-script-contract.test.ts` asserting every current public test entry point is rewired:

```ts
it('routes all current public test entry points through the wrapper', () => {
  expect(pkg.scripts.test).toBe('tsx scripts/test-command.ts full')
  expect(pkg.scripts.check).toBe('tsx scripts/test-command.ts check')
  expect(pkg.scripts.verify).toBe('tsx scripts/test-command.ts verify')
  expect(pkg.scripts['test:all']).toBe('tsx scripts/test-command.ts all')
  expect(pkg.scripts['test:server']).toBe('tsx scripts/test-command.ts server')
  expect(pkg.scripts['test:coverage']).toBe('tsx scripts/test-command.ts coverage')
  expect(pkg.scripts['test:unit']).toBe('tsx scripts/test-command.ts unit')
  expect(pkg.scripts['test:integration']).toBe('tsx scripts/test-command.ts integration')
  expect(pkg.scripts['test:client']).toBe('tsx scripts/test-command.ts client')
})
```

**Step 2: Run the targeted tests and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-script-contract.test.ts
npx vitest run --config vitest.server.config.ts test/server/test-command.test.ts
```

Expected: FAIL because the wrapper and script rewiring do not exist yet.

**Step 3: Implement the wrapper**

Create `scripts/test-command.ts` to:
- parse `--summary`, `--reuse-baseline`, and `--force-run`
- compute current checkout identity including current clean/dirty state
- always print reusable baseline availability when one exists
- only short-circuit when `--reuse-baseline` or `FRESHELL_REUSE_TEST_BASELINE=1` is set and the current checkout is an exact reusable match
- hold a single coordinator session across the broad phase for umbrella commands
- route narrowed runs directly to the shimmed `vitest`

Update `package.json` scripts so all current public one-shot test entry points route through the wrapper, while `test:watch` and `test:ui` remain direct:

```json
{
  "scripts": {
    "test": "tsx scripts/test-command.ts full",
    "verify": "tsx scripts/test-command.ts verify",
    "check": "tsx scripts/test-command.ts check",
    "test:all": "tsx scripts/test-command.ts all",
    "test:server": "tsx scripts/test-command.ts server",
    "test:coverage": "tsx scripts/test-command.ts coverage",
    "test:unit": "tsx scripts/test-command.ts unit",
    "test:integration": "tsx scripts/test-command.ts integration",
    "test:client": "tsx scripts/test-command.ts client"
  }
}
```

**Step 4: Re-run the targeted tests and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-script-contract.test.ts
npx vitest run --config vitest.server.config.ts test/server/test-command.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/server/test-command.test.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-script-contract.test.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/package.json
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): route all public test commands through gate"
```

### Task 6: Update agent guidance and verify the unified end state

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md`
- Modify if needed: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/vitest.mjs`

**Step 1: Update docs to match the new behavior**

Document:
- broad `npm test`, `check`, `verify`, `test:all`, `test:coverage`, `test:unit`, `test:integration`, `test:client`, and broad raw `npx vitest run ...` now cooperate through the repo-wide coordinator
- matching reusable baselines are always shown, but early exit requires `--reuse-baseline` or `FRESHELL_REUSE_TEST_BASELINE=1`
- fresh-run override uses `--force-run` or `FRESHELL_FORCE_TEST_RUN=1`
- `npm run test:server` remains watch-mode by default
- `npm test` is not watch mode
- final fresh landing run remains:

```bash
FRESHELL_FORCE_TEST_RUN=1 npm test
```

**Step 2: Run focused verification suites**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run \
  test/unit/server/coding-cli/git-metadata.test.ts \
  test/unit/server/test-gate-core.test.ts \
  test/unit/server/test-script-contract.test.ts
npx vitest run --config vitest.server.config.ts \
  test/server/test-gate-coordinator.test.ts \
  test/server/vitest-shim.test.ts \
  test/server/test-command.test.ts
```

Expected: PASS.

**Step 3: Verify advisory baseline behavior on the natural command path**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
FRESHELL_TEST_SUMMARY="Seed reusable baseline" FRESHELL_FORCE_TEST_RUN=1 npm test
FRESHELL_TEST_SUMMARY="Show advisory baseline on clean checkout" npm test
```

Expected:
- first command runs the full suite and records a reusable baseline
- second command reports the matching reusable baseline, then still runs because reuse was not explicitly requested

**Step 4: Verify explicit baseline reuse and dirty-checkout safety**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
FRESHELL_TEST_SUMMARY="Reuse clean exact baseline" FRESHELL_REUSE_TEST_BASELINE=1 npm test
printf 'dirty\n' >> /home/user/code/freshell/.worktrees/test-run-gate/.tmp-baseline-check
FRESHELL_TEST_SUMMARY="Dirty tree cannot reuse baseline" FRESHELL_REUSE_TEST_BASELINE=1 npm test
rm /home/user/code/freshell/.worktrees/test-run-gate/.tmp-baseline-check
```

Expected:
- first reuse command exits quickly with a baseline reuse message
- second command prints that the current checkout is dirty and runs fresh instead of reusing

**Step 5: Commit any verification fixes**

If verification required follow-up edits, commit them:

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md \
  /home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/vitest.mjs
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "fix(testing): finalize unified test gate behavior"
```

If all verification passes without further edits, leave the worktree clean and do not create an empty commit.
