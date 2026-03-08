# Test Run Gate And Baseline Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build a unified broad-test gate that serializes heavyweight test entry points across repo worktrees, reports truthful holder metadata, and exposes exact-checkout reusable baselines without weakening the current verification contract of the public test commands.

**Architecture:** Use a kernel-backed `flock` gate again, because crash semantics are the user’s explicit priority and a live coordinator process is not equivalent. Keep the lock attached to the actual broad-test leader process: public umbrella commands re-exec their locked test phase under `flock`, and raw broad `npx vitest run` is intercepted by patching only Vitest’s installed CLI entrypoint so the leader process itself acquires the lock before invoking upstream Vitest through the programmatic Node API. Holder metadata lives in an advisory file beside the lock; status always probes the real lock first and only trusts the metadata file when the lock is actually held. Baseline reuse is advisory on every broad invocation and only becomes an early exit when the current checkout is an exact clean match and the caller explicitly opts into reuse.

**Tech Stack:** Node.js, TypeScript, `tsx`, `child_process`, `fs/promises`, Git CLI, `flock`, `patch-package`, Vitest.

---

## Strategy Gate

- The user rejected phased or partial delivery, so the end state must cover both public npm scripts and habitual raw `npx vitest run` broad runs.
- The lock must inherit the crash-safety property the user explicitly asked for. Use `flock` as the correctness primitive and keep it held by the same process that is actually running the broad test leader.
- Do not replace the `vitest` package. Patch only the installed CLI entrypoint so the full upstream package shape, exports, and type graph remain intact.
- Baseline reuse is not the default verification path. Every broad command checks for a reusable baseline and reports it, but early exit is allowed only when:
  - the cached run was clean and successful
  - the current checkout is also clean
  - checkout identity and broad-suite identity match exactly
  - the caller explicitly opts into reuse
- Freeze broad-vs-narrow rules:
  - explicit individual test files are narrowed
  - directories, globs, `-t`, `--changed`, `--project`, config-targeted subset suites, and no-selector runs are broad
- Preserve current interactive behavior:
  - `npm run test:server` stays watch-mode by default
  - `vitest` watch and `vitest --ui` stay ungated

## Design Decisions

- Shared gate state is rooted in `git rev-parse --git-common-dir`.
- Shared state contents:
  - `broad-tests.lock`: the kernel lock file used only through `flock`
  - `holder.json`: advisory current-holder metadata
  - `results.json`: bounded newest-first history of recent successful and failed broad runs
- Lock truth rules:
  - non-blocking `flock` probe is the source of truth for whether a sanctioned broad run is active
  - `holder.json` is descriptive only and is ignored when the lock probe says the lock is free
  - stale `holder.json` after crashes is tolerated because it is never treated as proof of an active lock
- Holder metadata includes:
  - `commandKey`
  - `suiteKey`
  - `summary`
  - `startedAt`
  - `pid`
  - `cwd`
  - `checkoutRoot`
  - `repoRoot`
  - `branch`
  - `currentCleanWorktree`
  - `nodeVersion`
  - `platform`
  - `sessionId` from `CODEX_THREAD_ID` when present
- Reusable baseline identity is frozen to both checkout identity and suite identity:
  - cached record: exact `commandKey`, exact `suiteKey`, exact `commit`, `cleanWorktree === true`, exact `nodeVersion`, exact `platform`, `exitCode === 0`
  - current checkout: exact same `commit`, exact same `suiteKey`, exact same `nodeVersion`, exact same `platform`, and `currentCleanWorktree === true`
- `suiteKey` rules:
  - public npm one-shot commands have fixed keys such as `full`, `check`, `verify`, `all`, `coverage`, `unit`, `client`, `integration`, `server-run`
  - raw broad Vitest runs derive a normalized `suiteKey` from the effective config path plus the normalized broad selectors that determine the test set
  - cosmetic flags like `--reporter` do not change `suiteKey`
- Baseline behavior on broad invocations:
  - always check and print whether a reusable baseline exists
  - continue to run by default
  - only exit early when `--reuse-baseline` or `FRESHELL_REUSE_TEST_BASELINE=1` is set and the current checkout is an exact reusable match
  - `--force-run` or `FRESHELL_FORCE_TEST_RUN=1` suppresses reuse even when a match exists
- Environment scope:
  - the gated path is supported in the repo’s bash/WSL execution environment, which is what the current session and Codex CMD guidance already prefer
  - if `flock` is unavailable, broad runs fail fast with an actionable message to use the supported bash/WSL environment rather than silently falling back to a weaker lock
- Every current public one-shot test entry point is routed through the unified surface:
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

### Task 2: Build the gate core with exact suite identity and baseline rules

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-core.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-gate-core.test.ts`

**Step 1: Write the failing unit tests**

Create `test/unit/server/test-gate-core.test.ts` with coverage for:
- lock/holder/results path resolution under the Git common dir
- reusable-baseline acceptance requiring both clean producer and clean current checkout
- normalized `suiteKey` generation for raw broad runs
- public command keys for every current public one-shot script
- directory/config-targeted subset suites as broad

Seed with cases like:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildGatePaths,
  buildRawVitestSuiteKey,
  canReuseBaselineNow,
  classifyPublicCommand,
  classifyVitestInvocation,
} from '../../../scripts/test-gate-core.js'

describe('test-gate-core', () => {
  it('does not allow reuse when the current checkout is dirty', () => {
    expect(canReuseBaselineNow({
      commandKey: 'full',
      suiteKey: 'full',
      commit: 'abc123',
      cleanWorktree: true,
      nodeVersion: 'v22.10.2',
      platform: 'linux',
      exitCode: 0,
      finishedAt: '2026-03-08T10:00:00.000Z',
    }, {
      commandKey: 'full',
      suiteKey: 'full',
      commit: 'abc123',
      currentCleanWorktree: false,
      nodeVersion: 'v22.10.2',
      platform: 'linux',
    })).toBe(false)
  })

  it('gives different suite keys to different broad raw runs', () => {
    expect(buildRawVitestSuiteKey(['run', 'test/unit'])).not.toBe(
      buildRawVitestSuiteKey(['run', '--config', 'vitest.server.config.ts', 'test/server'])
    )
  })

  it('treats directory-targeted subset suites as broad', () => {
    expect(classifyVitestInvocation(['run', 'test/unit'])).toEqual({ mode: 'broad-run' })
    expect(classifyVitestInvocation(['run', '--config', 'vitest.server.config.ts', 'test/server'])).toEqual({ mode: 'broad-run' })
  })

  it('covers every current public one-shot command key', () => {
    expect(classifyPublicCommand('unit', []).suiteKey).toBe('unit')
    expect(classifyPublicCommand('client', []).suiteKey).toBe('client')
    expect(classifyPublicCommand('integration', []).suiteKey).toBe('integration')
    expect(classifyPublicCommand('coverage', []).suiteKey).toBe('coverage')
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
- `buildGatePaths(gitCommonDir)`
- `buildHolderRecord(context)`
- `findReusableBaseline(history, query)`
- `canReuseBaselineNow(record, currentIdentity)`
- `pushResultHistory(history, record, limit = 20)`
- `classifyVitestInvocation(argv)`
- `buildRawVitestSuiteKey(argv)`
- `classifyPublicCommand(commandKey, forwardedArgs)`
- atomic `readResultHistory()` and `writeResultHistory()`

Use structures like:

```ts
export type BroadRunIdentity = {
  commandKey: string
  suiteKey: string
  commit: string
  currentCleanWorktree: boolean
  nodeVersion: string
  platform: NodeJS.Platform
}
```

`buildRawVitestSuiteKey` must normalize only suite-shaping arguments:
- config path
- directories/globs/selectors
- flags like `--changed`, `--project`, `--dir`

It must ignore purely presentational flags like `--reporter`.

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
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add exact suite identity helpers"
```

### Task 3: Implement the flock-backed broad-run launcher with truthful holder semantics

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-runner.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/test-gate-runner.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-gate/fake-broad-runner.mjs`

**Step 1: Write the failing integration tests**

Create `test/server/test-gate-runner.test.ts` to verify:
- the actual broad-run leader is re-execed under `flock` and writes holder metadata only after the lock is acquired
- second broad run waits, polls holder metadata, then starts after the first exits
- stale `holder.json` is ignored when the lock probe succeeds
- if the locked leader process is killed, the next run can acquire the lock immediately
- if `flock` is unavailable, broad runs fail fast with an actionable bash/WSL message

Seed with cases like:

```ts
it('ignores stale holder metadata when the kernel lock is free', async () => {
  await fs.mkdir(paths.rootDir, { recursive: true })
  await fs.writeFile(paths.holderFile, JSON.stringify({ summary: 'stale' }), 'utf8')

  const result = await runStatus()

  expect(result.stdout).toContain('No sanctioned broad test run is active')
})

it('releases the gate when the locked leader dies', async () => {
  const first = await startLockedFixture({ holdMs: 1000 })
  await waitForOutput(first, 'LOCKED_LEADER_READY')
  await first.kill('SIGKILL')

  const second = await runLockedFixture({ waitMs: 200, pollMs: 10 })
  expect(second.exitCode).toBe(0)
})
```

**Step 2: Run the integration test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/test-gate-runner.test.ts
```

Expected: FAIL because the runner and fixture do not exist.

**Step 3: Implement the runner**

Create `scripts/test-gate-runner.ts` with two modes:
- outer mode: probe for reusable baseline, probe the real lock, print wait/status messages, and re-exec itself under `flock` for broad runs
- locked mode: write `holder.json`, run the broad leader work in the same process, update `results.json`, and remove `holder.json` in `finally`

Use a structure like:

```ts
async function main(): Promise<void> {
  const cli = parseRunnerCli(process.argv.slice(2))

  if (cli.mode === 'locked') {
    process.exit(await runLocked(cli))
  }

  process.exit(await runUnlocked(cli))
}
```

`runUnlocked` should use:

```bash
flock -n <lockFile> node scripts/test-gate-runner.ts --locked ...
```

so the actual broad-run leader process after `exec` owns the kernel lock.

`runLocked` should:
- write `holder.json`
- invoke the broad suite in-process
- record result history
- remove `holder.json` in `finally`

**Step 4: Re-run the integration test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/test-gate-runner.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-runner.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/server/test-gate-runner.test.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-gate/fake-broad-runner.mjs
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add flock-backed broad test runner"
```

### Task 4: Patch the installed Vitest CLI entrypoint instead of replacing the package

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/vitest-gate-entry.mjs`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/vitest-patch.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package.json`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package-lock.json`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/patches/vitest+3.2.4.patch`

**Step 1: Write the failing integration tests**

Create `test/server/vitest-patch.test.ts` to cover:
- `npx vitest run --reporter=verbose` is broad and routed through the flock runner
- `npx vitest run test/unit/server/auth.test.ts` stays narrowed and ungated
- `npx vitest run test/unit` is broad and gated
- `npx vitest run --config vitest.server.config.ts test/server` is broad and gated
- imports from `vitest`, `vitest/config`, `vitest/node`, `vitest/reporters`, and `vitest/globals` still resolve
- `node_modules/vitest/vitest.mjs` still exists after install and now bootstraps through the repo entry script

Include a contract assertion like:

```ts
it('preserves standard vitest subpath imports after patching the CLI only', async () => {
  const result = await runNodeImport(`
    await import('vitest')
    await import('vitest/config')
    await import('vitest/node')
    await import('vitest/reporters')
    await import('vitest/globals')
  `)

  expect(result.exitCode).toBe(0)
})
```

**Step 2: Run the integration test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/vitest-patch.test.ts
```

Expected: FAIL because the CLI patch and bootstrap entry do not exist.

**Step 3: Implement the CLI patch**

Add `patch-package` and a `postinstall` hook in `package.json`:

```json
{
  "scripts": {
    "postinstall": "patch-package"
  },
  "devDependencies": {
    "patch-package": "^8.0.0"
  }
}
```

Create `scripts/vitest-gate-entry.mjs` as the repo-owned bootstrap that:
- classifies raw Vitest invocation
- computes `suiteKey`
- reports reusable baseline availability
- early-exits only with explicit reuse opt-in
- sends broad runs through `scripts/test-gate-runner.ts`
- delegates narrowed/watch/UI runs to the original upstream CLI behavior

Create `patches/vitest+3.2.4.patch` that changes only `node_modules/vitest/vitest.mjs` to import the repo bootstrap based on `process.cwd()`, leaving the rest of the installed package untouched.

Then run a real install so the patch is actually applied:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npm install
```

Do not replace the `vitest` package dependency.

**Step 4: Re-run the integration test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/vitest-patch.test.ts
```

Expected: PASS, including `vitest/node`, `vitest/reporters`, `vitest/globals`, and the preserved `node_modules/vitest/vitest.mjs` path.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/vitest-gate-entry.mjs \
  /home/user/code/freshell/.worktrees/test-run-gate/test/server/vitest-patch.test.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/package.json \
  /home/user/code/freshell/.worktrees/test-run-gate/package-lock.json \
  /home/user/code/freshell/.worktrees/test-run-gate/patches/vitest+3.2.4.patch
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): patch vitest CLI into broad test gate"
```

### Task 5: Route every current public one-shot test entry point through the unified wrapper

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/test-command.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-script-contract.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package.json`

**Step 1: Write the failing tests**

Create `test/server/test-command.test.ts` to verify:
- `npm test`, `check`, and `verify` report reusable baseline availability but still run by default
- `--reuse-baseline` exits early only on an exact clean current checkout
- `--force-run` suppresses reuse
- `npm run test:unit`, `npm run test:client`, `npm run test:integration`, and `npm run test:coverage` are all broad one-shot commands with fixed suite keys
- `npm run test:server` stays watch-mode by default
- `npm run test:server -- --run` becomes a broad one-shot command

Create `test/unit/server/test-script-contract.test.ts` asserting every current public one-shot entry point is rewired:

```ts
it('routes all current public one-shot test commands through the wrapper', () => {
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
- compute current checkout identity and fixed public `suiteKey`
- report reusable baseline availability on every broad invocation
- continue by default
- only early-exit when reuse is explicitly requested and safe
- run `typecheck` or `build` outside the lock for `check` and `verify`
- re-exec its broad test phase through `scripts/test-gate-runner.ts`

Update `package.json` so all current public one-shot commands route through `test-command.ts`, while `test:watch` and `test:ui` remain direct.

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
- Modify if needed: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/vitest-gate-entry.mjs`

**Step 1: Update docs to match the new behavior**

Document:
- broad public one-shot test commands and broad raw `npx vitest run ...` now cooperate through the flock-backed gate
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
  test/server/test-gate-runner.test.ts \
  test/server/vitest-patch.test.ts \
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

**Step 4: Verify explicit baseline reuse and crash-safe lock release**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
FRESHELL_TEST_SUMMARY="Reuse clean exact baseline" FRESHELL_REUSE_TEST_BASELINE=1 npm test
FRESHELL_TEST_SUMMARY="Crash-safe lock release check" FRESHELL_FORCE_TEST_RUN=1 npm test &
leader_pid=$!
sleep 5
kill -9 "$leader_pid"
FRESHELL_TEST_SUMMARY="Fresh run after crash" FRESHELL_FORCE_TEST_RUN=1 npm test
```

Expected:
- first reuse command exits quickly with a baseline reuse message
- after the forced crash, the next fresh run can acquire the lock immediately because the kernel lock died with the locked leader process

**Step 5: Commit any verification fixes**

If verification required follow-up edits, commit them:

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md \
  /home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/vitest-gate-entry.mjs
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "fix(testing): finalize flock-backed test gate"
```

If all verification passes without further edits, leave the worktree clean and do not create an empty commit.
