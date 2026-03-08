# Test Run Gate And Baseline Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build a unified, cross-platform test gate that makes broad test entry points cooperate across repo worktrees, shows truthful live holder metadata, and lets agents reuse an exact-commit clean baseline by default instead of rerunning broad suites unnecessarily.

**Architecture:** Replace the previous `flock` idea with a repo-scoped IPC lease server implemented in Node so the coordination primitive works on Linux, macOS, WSL, and native Windows. Unify the entry surface in two layers that share the same gate library: a local `vitest` shim package that wraps upstream Vitest so raw `npx vitest run` participates automatically, and a higher-level `test-command` wrapper for umbrella commands like `npm test`, `npm run check`, and `npm run verify` so those commands hold one lease across their whole broad test phase. Before any broad run queues or starts, the normal command path checks for an exact reusable baseline and exits successfully with a clear reuse message unless the caller explicitly asks for a fresh run.

**Tech Stack:** Node.js, TypeScript, `net`, `fs/promises`, `child_process`, Git CLI, npm file dependencies, Vitest.

---

## Strategy Gate

- The user rejected phased or partial delivery, so the end state must cover both sanctioned npm scripts and habitual raw `npx vitest run` broad runs. The plan therefore changes the installed `vitest` binary inside this repo rather than merely documenting a preferred path.
- The coordination primitive must be crash-safe and cross-platform. Use a repo-scoped IPC lease endpoint instead of `flock` or a plain sentinel file:
  - Unix: a socket file under the Git common dir
  - Windows: a named pipe derived from the Git common dir hash
- The live IPC lease is the only source of truth for whether a broad run is active. Advisory files are limited to reusable result history.
- Baseline reuse has to change the default ergonomics, not live behind a side command. Broad `npm test`, `npm run check`, `npm run verify`, and broad `vitest run` should all short-circuit on an exact reusable baseline unless `--force-run` or `FRESHELL_FORCE_TEST_RUN=1` is supplied.
- Preserve existing interactive behavior where it matters:
  - `npm run test:server` stays watch-mode by default
  - `vitest` watch and `vitest --ui` stay ungated
  - explicit file-targeted runs stay immediate and ungated

## Design Decisions

- Shared gate state is rooted in `git rev-parse --git-common-dir`.
- Shared state contents:
  - live lease endpoint: socket path or named pipe name
  - `results.json`: bounded newest-first history for reusable baselines and recent failures
- No persistent `holder.json`. Active-holder metadata is served live over the lease endpoint so there is no stale-holder file to clean up after crashes.
- Holder metadata served by the lease endpoint includes:
  - `commandKey`
  - `summary`
  - `startedAt`
  - `pid`
  - `cwd`
  - `checkoutRoot`
  - `repoRoot`
  - `branch`
  - `cleanWorktree`
  - `nodeVersion`
  - `platform`
  - `sessionId` from `CODEX_THREAD_ID` when present
- Reusable baseline eligibility is frozen to:
  - exact `commandKey`
  - exact `commit`
  - `cleanWorktree === true`
  - exact `nodeVersion`
  - exact `platform`
  - `exitCode === 0`
- Broad-command default behavior:
  - if a reusable baseline exists and the caller did not force a rerun, print the matching baseline details and exit `0`
  - otherwise attempt to acquire the lease, wait/poll up to one hour, then run
- Fresh-run override:
  - `--force-run`
  - or `FRESHELL_FORCE_TEST_RUN=1`
- Raw broad `npx vitest run` participates because the repo’s installed `vitest` package becomes a local shim that re-exports upstream Vitest APIs and wraps the CLI.
- Umbrella commands still need a dedicated wrapper because `npm test`, `check`, and `verify` represent broader claims than a single Vitest invocation and should hold one lease across the whole broad test phase.

### Task 1: Add shared Git common-dir resolution for repo-wide gate state

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/server/coding-cli/utils.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/coding-cli/git-metadata.test.ts`

**Step 1: Write the failing tests for worktree-aware common-dir lookup**

Extend `test/unit/server/coding-cli/git-metadata.test.ts` so the gate code can rely on shared common-dir discovery:

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

**Step 3: Implement the minimal helper**

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

### Task 2: Build the cross-platform gate core and baseline store with unit coverage

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-core.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-gate-core.test.ts`

**Step 1: Write the failing unit tests for endpoint resolution, baseline trust, and broad-run planning**

Create `test/unit/server/test-gate-core.test.ts` with pure tests for:
- endpoint naming from Git common dir
- Unix socket vs Windows named-pipe path generation
- reusable-baseline eligibility and bounded history retention
- summary derivation
- invocation planning for broad, narrowed, interactive-watch, and status modes
- fresh-run override handling

Seed the file with cases like:

```ts
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildGateStatePaths,
  classifyVitestInvocation,
  deriveSummary,
  findReusableBaseline,
  pushResultHistory,
  type TestResultRecord,
} from '../../../scripts/test-gate-core.js'

describe('test-gate-core', () => {
  it('builds a unix socket endpoint from the git common dir', () => {
    expect(buildGateStatePaths({
      gitCommonDir: '/repo/.git',
      platform: 'linux',
    })).toEqual({
      stateDir: path.join('/repo/.git', 'freshell-test-gate'),
      endpoint: path.join('/repo/.git', 'freshell-test-gate', 'lease.sock'),
      resultsFile: path.join('/repo/.git', 'freshell-test-gate', 'results.json'),
    })
  })

  it('builds a named pipe endpoint on win32', () => {
    const result = buildGateStatePaths({
      gitCommonDir: 'C:\\\\repo\\\\.git',
      platform: 'win32',
    })

    expect(result.endpoint.startsWith('\\\\\\\\.\\\\pipe\\\\freshell-test-gate-')).toBe(true)
  })

  it('reuses only exact clean baselines from the same runtime identity', () => {
    const history: TestResultRecord[] = [
      {
        commandKey: 'full',
        commit: 'abc123',
        cleanWorktree: true,
        nodeVersion: 'v22.10.2',
        platform: 'linux',
        exitCode: 0,
        finishedAt: '2026-03-08T10:00:00.000Z',
      },
    ]

    expect(findReusableBaseline(history, {
      commandKey: 'full',
      commit: 'abc123',
      nodeVersion: 'v22.10.2',
      platform: 'linux',
    })?.commit).toBe('abc123')

    expect(findReusableBaseline(history, {
      commandKey: 'full',
      commit: 'abc123',
      nodeVersion: 'v20.18.0',
      platform: 'linux',
    })).toBeUndefined()
  })

  it('treats broad reporter-only runs as broad and file-targeted runs as narrowed', () => {
    expect(classifyVitestInvocation(['run', '--reporter=verbose'])).toEqual({ mode: 'broad-run' })
    expect(classifyVitestInvocation(['run', 'test/unit/server/auth.test.ts'])).toEqual({
      mode: 'narrowed-run',
      forwardedArgs: ['run', 'test/unit/server/auth.test.ts'],
    })
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
- `deriveSummary(...)`
- `buildHolderRecord(...)`
- `findReusableBaseline(...)`
- `pushResultHistory(...)`
- `classifyVitestInvocation(argv)`
- `classifyUmbrellaCommand(commandKey, forwardedArgs)`
- atomic `readResultHistory()` and `writeResultHistory()`
- cross-platform endpoint hashing for Windows named pipes

Use structures like:

```ts
export type GatePaths = {
  stateDir: string
  endpoint: string
  resultsFile: string
}

export type InvocationPlan =
  | { mode: 'status' }
  | { mode: 'interactive-watch'; forwardedArgs: string[] }
  | { mode: 'narrowed-run'; forwardedArgs: string[] }
  | { mode: 'broad-run'; forwardedArgs: string[] }
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
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add cross-platform gate core"
```

### Task 3: Implement the live IPC lease server and broad-run waiting behavior

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-lease.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/test-gate-lease.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-gate/fake-broad-runner.mjs`

**Step 1: Write the failing integration tests for crash-safe lease behavior**

Create `test/server/test-gate-lease.test.ts` to verify:
- a first broad run acquires the lease and serves live holder metadata
- a second broad run reads holder metadata, prints a waiting message, polls, then starts when the first exits
- idle status reports correctly when no holder exists
- stale Unix socket files are ignored only after a failed connection probe, then replaced safely
- killing the holder process releases the lease without leaving a blocking stale state
- timeout after one hour is configurable in tests with short env overrides

Seed with cases like:

```ts
it('waits on a live holder and then acquires the lease when it exits', async () => {
  const first = startLeaseFixture({
    summary: 'First run',
    holdMs: 150,
  })
  await waitForOutput(first, 'LEASE_READY')

  const second = await runLeaseFixture({
    summary: 'Second run',
    waitMs: 500,
    pollMs: 10,
  })

  expect(second.stdout).toContain('First run')
  expect(second.stdout).toContain('waiting for the active test run to finish')
  expect(second.stdout).toContain('Second run started')
})
```

**Step 2: Run the integration test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/test-gate-lease.test.ts
```

Expected: FAIL because the lease module and fixture do not exist.

**Step 3: Implement the lease server**

Create `scripts/test-gate-lease.ts` with:
- `acquireLeaseOrReadHolder(context)`
- `serveHolderMetadata(server, holderRecord)`
- `queryActiveHolder(paths)`
- `waitForLease(context)`
- stale-socket cleanup on Unix after a failed probe

Use Node `net` so the same mechanism works on every supported platform:

```ts
export async function withLease<T>(context: LeaseContext, run: () => Promise<T>): Promise<LeaseOutcome<T>> {
  const acquired = await tryAcquireLease(context)
  if (!acquired.ok) return acquired

  try {
    const value = await run()
    return { ok: true, value }
  } finally {
    await acquired.release()
  }
}
```

`fake-broad-runner.mjs` should simulate success, failure, and long hold times without invoking real tests.

**Step 4: Re-run the integration test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/test-gate-lease.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-lease.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/server/test-gate-lease.test.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-gate/fake-broad-runner.mjs
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add repo-wide IPC lease server"
```

### Task 4: Replace the installed `vitest` binary with a local shim so raw `npx vitest run` cooperates

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/package.json`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/index.js`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/config.js`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/bin/vitest.mjs`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/vitest-shim.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package.json`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package-lock.json`

**Step 1: Write the failing integration tests for raw Vitest entry points**

Create `test/server/vitest-shim.test.ts` to cover:
- broad `npx vitest run` consults reusable baseline and exits `0` without starting a new run unless forced
- broad `npx vitest run` acquires the lease when no reusable baseline exists
- `npx vitest run --reporter=verbose` still counts as broad
- file-targeted `npx vitest run test/unit/server/auth.test.ts` stays immediate and ungated
- `npx vitest` watch and `npx vitest --ui` stay ungated
- imports from `vitest` and `vitest/config` still resolve through the shim package

Include a contract assertion like:

```ts
it('keeps the vitest module API available through the shim package', async () => {
  const result = await runNodeImport(`
    const mod = await import('vitest')
    const cfg = await import('vitest/config')
    if (typeof mod.describe !== 'function') throw new Error('missing describe')
    if (typeof cfg.defineConfig !== 'function') throw new Error('missing defineConfig')
  `)

  expect(result.exitCode).toBe(0)
})
```

**Step 2: Run the integration test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/vitest-shim.test.ts
```

Expected: FAIL because the shim package does not exist.

**Step 3: Implement the shim package**

Create `tools/vitest-shim/package.json` as a local package named `vitest` that depends on upstream Vitest under an alias:

```json
{
  "name": "vitest",
  "version": "3.2.4-freshell.0",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./config": "./config.js"
  },
  "bin": {
    "vitest": "./bin/vitest.mjs"
  },
  "dependencies": {
    "vitest-upstream": "npm:vitest@^3.2.4"
  }
}
```

Implement:
- `index.js`: `export * from 'vitest-upstream'`
- `config.js`: `export * from 'vitest-upstream/config'`
- `bin/vitest.mjs`: parse CLI args, classify invocation, consult reusable baseline, wait/acquire lease for broad one-shot runs, and exec upstream `vitest-upstream/vitest.mjs` for actual execution

Update root `package.json` devDependencies so:

```json
"vitest": "file:tools/vitest-shim"
```

Then refresh `package-lock.json` with `npm install --package-lock-only`.

**Step 4: Re-run the integration test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/vitest-shim.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/package.json \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/index.js \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/config.js \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/bin/vitest.mjs \
  /home/user/code/freshell/.worktrees/test-run-gate/test/server/vitest-shim.test.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/package.json \
  /home/user/code/freshell/.worktrees/test-run-gate/package-lock.json
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): gate raw vitest entrypoints"
```

### Task 5: Add the umbrella `test-command` wrapper for `npm test`, `check`, `verify`, and command-specific baseline reuse

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/test-command.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-script-contract.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package.json`

**Step 1: Write the failing tests for umbrella-command behavior**

Create `test/server/test-command.test.ts` to verify:
- `npm test` holds one lease across both client and server broad phases
- `npm run check` keeps `typecheck` outside the lease but consults reusable `check` baseline before doing any work
- `npm run verify` keeps `build` outside the lease but consults reusable `verify` baseline before doing any work
- `npm run test:server` stays watch-mode by default
- `npm run test:server -- --run` becomes a broad one-shot and participates in the lease
- `npm test -- test/unit/client/foo.test.tsx` stays narrowed and ungated
- `--force-run` overrides baseline short-circuiting

Create `test/unit/server/test-script-contract.test.ts` that asserts the public scripts route through the wrapper where intended:

```ts
it('routes umbrella commands through test-command', () => {
  expect(pkg.scripts.test).toBe('tsx scripts/test-command.ts full')
  expect(pkg.scripts.check).toBe('tsx scripts/test-command.ts check')
  expect(pkg.scripts.verify).toBe('tsx scripts/test-command.ts verify')
  expect(pkg.scripts['test:all']).toBe('tsx scripts/test-command.ts all')
  expect(pkg.scripts['test:server']).toBe('tsx scripts/test-command.ts server')
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
- parse wrapper flags like `--summary` and `--force-run`
- resolve command-specific baseline eligibility
- short-circuit on a reusable baseline before any build/typecheck/test work
- run `typecheck` or `build` directly when needed for `check` and `verify`
- hold one lease across the complete broad test phase for `full`, `all`, `check`, `verify`, `coverage`, and one-shot `server`
- delegate raw test execution to the existing public `vitest` command, which now points at the shim

Use a shape like:

```ts
async function main(): Promise<void> {
  const cli = parseCommandCli(process.argv.slice(2))
  const context = await buildCommandContext(cli)

  const baseline = await findReusableBaselineForCommand(context)
  if (baseline && !cli.forceRun) {
    printReusableBaselineMessage(baseline)
    process.exit(0)
  }

  if (cli.commandKey === 'check') await runStep(['npm', 'run', 'typecheck'])
  if (cli.commandKey === 'verify') await runStep(['npm', 'run', 'build'])

  process.exit(await runCommandTests(context))
}
```

Update `package.json` scripts so umbrella commands route through `test-command.ts`, while `test:watch` and `test:ui` remain direct.

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
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add umbrella test command gate"
```

### Task 6: Update agent guidance and verify the unified end state

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md`
- Modify if needed: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/bin/vitest.mjs`

**Step 1: Update docs to match the new behavior**

Update `AGENTS.md` and `docs/skills/testing.md` to document:
- broad `npm test`, `npm run check`, `npm run verify`, and broad `npx vitest run` now cooperate through the repo-wide gate
- matching exact-commit clean baselines are reused by default unless `--force-run` or `FRESHELL_FORCE_TEST_RUN=1` is supplied
- `npm run test:server` is still watch-mode by default
- final landing runs that must be fresh should use:

```bash
FRESHELL_FORCE_TEST_RUN=1 npm test
```

- `npm test` is not watch mode

**Step 2: Run focused verification suites**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run \
  test/unit/server/coding-cli/git-metadata.test.ts \
  test/unit/server/test-gate-core.test.ts \
  test/unit/server/test-script-contract.test.ts
npx vitest run --config vitest.server.config.ts \
  test/server/test-gate-lease.test.ts \
  test/server/vitest-shim.test.ts \
  test/server/test-command.test.ts
```

Expected: PASS.

**Step 3: Verify baseline short-circuit on the natural command path**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
FRESHELL_TEST_SUMMARY="Seed reusable baseline" FRESHELL_FORCE_TEST_RUN=1 npm test
FRESHELL_TEST_SUMMARY="Confirm baseline reuse" npm test
```

Expected:
- first command runs the full suite and records a reusable baseline
- second command exits `0` quickly with a message pointing to the matching clean pass instead of rerunning

**Step 4: Verify fresh-run override and umbrella commands**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
FRESHELL_TEST_SUMMARY="Force fresh full suite" FRESHELL_FORCE_TEST_RUN=1 npm test
FRESHELL_TEST_SUMMARY="Force fresh check" FRESHELL_FORCE_TEST_RUN=1 npm run check
FRESHELL_TEST_SUMMARY="Force fresh verify" FRESHELL_FORCE_TEST_RUN=1 npm run verify
```

Expected: PASS. Each command should run fresh broad tests and show live waiting messages if another broad run is already active.

**Step 5: Commit any verification fixes**

If verification required follow-up edits, commit them:

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md \
  /home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/tools/vitest-shim/bin/vitest.mjs
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "fix(testing): finalize unified test gate behavior"
```

If all verification passes without further edits, leave the worktree clean and do not create an empty commit.
