# Test Run Gate And Baseline Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Serialize broad test phases across repo worktrees, show truthfully who currently holds the gate and why, detect unsanctioned broad Vitest runs that bypass the sanctioned path, and publish a bounded exact-commit baseline history that other agents can reuse without breaking existing focused-test workflows.

**Architecture:** Add one TypeScript wrapper script that owns kernel-lock acquisition for heavyweight test phases, bounded waiting, holder metadata, last-result caching, npm-child argv parsing, and focused-run passthrough for sanctioned npm test entrypoints. Store shared advisory state in the repo's Git common dir, use `flock` on a repo-shared lock file as the only correctness primitive for sanctioned broad-test serialization, keep `check`/`verify` pre-steps outside the lock so the holder message means “tests are running,” and add a secondary process-detector for unsanctioned broad `vitest run` leaders in repo worktrees so bypassed runs become visible blockers instead of silent collisions.

**Tech Stack:** Node.js, TypeScript, `tsx`, `child_process`, `fs/promises`, Git CLI, `flock`, Vitest.

---

User-approved direction:
- Lock-backed gate, not process-detection-only.
- Holder metadata should include summary, worktree, branch, session/thread ID, and similar context when available.
- Keep a last-run results record so agents can inspect a matching exact-commit baseline instead of blindly rerunning.
- Make the ergonomic path the default npm commands and make heavyweight raw invocations socially and structurally discouraged.
- Do not run a full suite until the gate exists.

Design decisions for implementation:
- Treat the gate as repo-shared state rooted in `git rev-parse --git-common-dir`, not in an individual worktree.
- Gate every broad non-interactive npm test entrypoint when it is invoked broadly: `npm test`, `npm run test:all`, `npm run test:unit`, `npm run test:client`, `npm run test:server`, `npm run test:integration`, `npm run test:coverage`, `npm run check`, and `npm run verify`.
- Preserve existing focused-test ergonomics on those same npm scripts by forwarding extra Vitest args and treating only explicit file-targeted narrowed invocations as ungated. `npm test -- test/unit/server/foo.test.ts -t "bar"` and `npm run test:server -- test/server/ws-protocol.test.ts` must keep working through the sanctioned npm entrypoints.
- Keep only explicitly interactive commands (`npm run test:watch`, `npm run test:ui`) outside the wrapper entirely.
- Make the public npm scripts hard to bypass for broad runs by routing them all through the wrapper and moving the actual raw runners to private underscore-prefixed scripts that only the wrapper invokes.
- Make baseline results advisory only. Never auto-skip a required fresh landing run.
- Retain a bounded reusable-history per command keyed by commit so a newer success on `def` does not erase a still-valid reusable baseline for `abc`.
- Accept summary input from `--summary "..."` and `FRESHELL_TEST_SUMMARY`, but fall back to an automatic placeholder instead of failing if the agent omits it.
- Make `status` read-only in the sense that it never waits and never starts tests, but it must still perform the same immediate non-blocking `flock` probe as runners so its holder report is truthful.
- Treat `flock` availability as a required precondition for broad gated runs. If `flock` is unavailable, the wrapper should fail fast with an actionable message rather than silently falling back to a pseudo-lock.
- Parse forwarded args the way npm child scripts actually receive them: the wrapper must inspect its raw argv after the command key and peel off wrapper-only flags such as `--summary` directly, not rely on a literal `--` token surviving into `process.argv`.
- Hold the gate only for heavyweight test phases. `typecheck` and `build` in `check`/`verify` remain outside the gate so an “active test run” message is literally true.
- Add a secondary blocker for known bypass paths: detect repo-local broad `npx vitest run` / `npm exec vitest run` leaders with no explicit file targets, surface them in `status`, and refuse to start a sanctioned broad run while one is active.

## Task 1: Add shared git/run-context helpers for repo-wide gate state

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/server/coding-cli/utils.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/coding-cli/git-metadata.test.ts`

**Step 1: Write the failing tests for shared git context**

Extend `test/unit/server/coding-cli/git-metadata.test.ts` with coverage for a linked worktree so the implementation can resolve both the checkout root and the shared common git dir:

```ts
import { resolveGitBranchAndDirty, resolveGitCheckoutRoot, resolveGitCommonDir, clearRepoRootCache } from '../../../../server/coding-cli/utils'

it('returns the shared common git dir for linked worktrees', async () => {
  const repoDir = path.join(tempDir, 'repo')
  const worktreeDir = path.join(tempDir, 'repo-worktree')
  await initRepo(repoDir, 'main')
  await runGit(['worktree', 'add', '-b', 'feature/test-gate', worktreeDir], repoDir)

  const nestedDir = path.join(worktreeDir, 'deep', 'child')
  await fsp.mkdir(nestedDir, { recursive: true })

  const checkoutRoot = await resolveGitCheckoutRoot(nestedDir)
  const commonDir = await resolveGitCommonDir(nestedDir)

  expect(checkoutRoot).toBe(worktreeDir)
  expect(commonDir).toBe(path.join(repoDir, '.git'))
})

it('falls back gracefully for non-git directories', async () => {
  const plainDir = path.join(tempDir, 'plain')
  await fsp.mkdir(plainDir, { recursive: true })

  await expect(resolveGitCommonDir(plainDir)).resolves.toBeUndefined()
})
```

**Step 2: Run the targeted test and confirm failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/coding-cli/git-metadata.test.ts
```

Expected: FAIL because `resolveGitCommonDir` does not exist yet.

**Step 3: Implement the minimal git-common-dir helper**

Add a new exported helper in `server/coding-cli/utils.ts` that resolves the shared `.git` directory from either a normal repo or a linked worktree:

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

**Step 4: Re-run the targeted test**

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
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add shared git common-dir resolution"
```

## Task 2: Build the gate metadata and baseline cache module with unit coverage

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-run-gate.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-run-gate.test.ts`

**Step 1: Write the failing unit tests for metadata, cache location, and baseline eligibility**

Create `test/unit/server/test-run-gate.test.ts` with pure-function coverage for:
- shared-state paths rooted in the git common dir,
- holder metadata collection,
- summary fallback behavior,
- exact-commit reusable baseline detection from bounded history,
- bounded result-history retention keyed by command and commit,
- dirty-worktree exclusion from reusable results,
- invocation classification for `broad` versus tightly-defined `narrowed`,
- npm-child argv parsing for wrapper options versus forwarded Vitest args,
- cross-platform npm invocation resolution.

Seed the new test file with cases like:

```ts
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildHolderRecord,
  buildGatePaths,
  classifyInvocation,
  deriveSummary,
  findReusableBaseline,
  findUnsanctionedBroadVitest,
  parseInvocationArgs,
  pushResultHistory,
  resolveNpmRunner,
  type TestRunResultRecord,
} from '../../../scripts/test-run-gate.js'

describe('test-run-gate helpers', () => {
  it('roots gate files in the shared common git dir', () => {
    expect(buildGatePaths('/repo/.git')).toEqual({
      rootDir: path.join('/repo/.git', 'freshell-test-gate'),
      lockFile: path.join('/repo/.git', 'freshell-test-gate', 'full-suite.lock'),
      holderFile: path.join('/repo/.git', 'freshell-test-gate', 'holder.json'),
      resultsFile: path.join('/repo/.git', 'freshell-test-gate', 'last-results.json'),
    })
  })

  it('prefers explicit summary but falls back to useful context', () => {
    expect(deriveSummary({ cliSummary: 'Fix attach race', envSummary: 'ignored', branch: 'feature/x' })).toBe('Fix attach race')
    expect(deriveSummary({ cliSummary: '', envSummary: '', branch: 'feature/x' })).toBe('unspecified task on feature/x')
  })

  it('finds an exact-commit reusable baseline even after newer successes are recorded', () => {
    const history = [
      { commandKey: 'full', commit: 'def456', cleanWorktree: true, exitCode: 0, finishedAt: '2026-03-08T19:20:00.000Z' },
      { commandKey: 'full', commit: 'abc123', cleanWorktree: true, exitCode: 0, finishedAt: '2026-03-08T19:10:00.000Z' },
    ] satisfies TestRunResultRecord[]

    expect(findReusableBaseline(history, { commandKey: 'full', commit: 'abc123' })?.commit).toBe('abc123')
    expect(findReusableBaseline(history, { commandKey: 'full', commit: 'zzz999' })).toBeUndefined()
  })

  it('deduplicates by commit and keeps bounded history newest-first', () => {
    const initial = Array.from({ length: 20 }, (_, index) => ({
      commandKey: 'full' as const,
      commit: `sha-${index}`,
      cleanWorktree: true,
      exitCode: 0,
      finishedAt: `2026-03-08T19:${String(index).padStart(2, '0')}:00.000Z`,
    }))

    const updated = pushResultHistory(initial, {
      commandKey: 'full',
      commit: 'sha-5',
      cleanWorktree: true,
      exitCode: 0,
      finishedAt: '2026-03-08T20:00:00.000Z',
    })

    expect(updated[0]?.commit).toBe('sha-5')
    expect(updated).toHaveLength(20)
    expect(updated.filter((entry) => entry.commit === 'sha-5')).toHaveLength(1)
  })

  it('treats no extra selection args as a broad invocation', () => {
    expect(classifyInvocation({ commandKey: 'full', forwardedArgs: [] })).toEqual({ kind: 'broad' })
    expect(classifyInvocation({ commandKey: 'server', forwardedArgs: ['--run'] })).toEqual({ kind: 'broad' })
  })

  it('treats explicit file targets as narrowed invocations', () => {
    expect(classifyInvocation({ commandKey: 'full', forwardedArgs: ['test/unit/server/foo.test.ts'] })).toEqual({ kind: 'narrowed' })
    expect(classifyInvocation({ commandKey: 'client', forwardedArgs: ['test/unit/client/panesSlice.test.ts', '-t', 'restores pane state'] })).toEqual({ kind: 'narrowed' })
  })

  it('treats directory targets and broad selectors as broad invocations', () => {
    expect(classifyInvocation({ commandKey: 'server', forwardedArgs: ['test/server'] })).toEqual({ kind: 'broad' })
    expect(classifyInvocation({ commandKey: 'unit', forwardedArgs: ['test/unit'] })).toEqual({ kind: 'broad' })
    expect(classifyInvocation({ commandKey: 'client', forwardedArgs: ['--changed'] })).toEqual({ kind: 'broad' })
    expect(classifyInvocation({ commandKey: 'full', forwardedArgs: ['-t', 'restores pane state'] })).toEqual({ kind: 'broad' })
  })

  it('parses npm-child argv without relying on a literal double-dash token', () => {
    expect(parseInvocationArgs(['--summary', 'Fix restore bug', 'test/unit/server/foo.test.ts', '-t', 'restores'])).toEqual({
      summary: 'Fix restore bug',
      forwardedArgs: ['test/unit/server/foo.test.ts', '-t', 'restores'],
    })
  })

  it('detects unsanctioned broad vitest leaders but ignores explicit file-targeted runs', () => {
    expect(findUnsanctionedBroadVitest([
      { pid: 101, cwd: '/repo/.worktrees/a', cmd: 'node node_modules/vitest/vitest.mjs run' },
      { pid: 102, cwd: '/repo/.worktrees/b', cmd: 'node node_modules/vitest/vitest.mjs run test/unit/server/foo.test.ts' },
    ])).toEqual([
      { pid: 101, cwd: '/repo/.worktrees/a', cmd: 'node node_modules/vitest/vitest.mjs run' },
    ])
  })

  it('captures summary, branch, worktree, and session identifiers in holder metadata', () => {
    const holder = buildHolderRecord({
      commandKey: 'check',
      summary: 'Fix session hydration',
      cwd: '/repo/.worktrees/test-run-gate',
      repoRoot: '/repo',
      checkoutRoot: '/repo/.worktrees/test-run-gate',
      branch: 'feature/test-run-gate',
      commit: 'abc123',
      sessionId: 'thread-123',
      pid: 4242,
      startedAt: '2026-03-08T19:00:00.000Z',
    })

    expect(holder.summary).toBe('Fix session hydration')
    expect(holder.worktreePath).toBe('/repo/.worktrees/test-run-gate')
    expect(holder.branch).toBe('feature/test-run-gate')
    expect(holder.sessionId).toBe('thread-123')
  })

  it('prefers npm_execpath and falls back safely per platform', () => {
    expect(resolveNpmRunner({ npmExecPath: '/tmp/npm-cli.js', platform: 'linux' })).toEqual({
      command: process.execPath,
      argsPrefix: ['/tmp/npm-cli.js'],
    })
    expect(resolveNpmRunner({ platform: 'win32' })).toEqual({
      command: 'npm.cmd',
      argsPrefix: [],
    })
  })
})
```

**Step 2: Run the unit test and confirm failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-run-gate.test.ts
```

Expected: FAIL because the helper module does not exist yet.

**Step 3: Implement the pure gate helpers in `scripts/test-run-gate.ts`**

Create the new script with exported types and helpers first, before adding the CLI wiring:

```ts
#!/usr/bin/env tsx

import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

export type CommandKey =
  | 'full'
  | 'unit'
  | 'client'
  | 'server'
  | 'integration'
  | 'check'
  | 'verify'
  | 'coverage'

export interface HolderRecord {
  commandKey: CommandKey
  summary: string
  startedAt: string
  pid: number
  cwd: string
  repoRoot: string
  checkoutRoot: string
  worktreePath?: string
  branch?: string
  commit?: string
  sessionId?: string
  agentKind?: string
  hostname: string
}

export interface TestRunResultRecord {
  commandKey: CommandKey
  summary: string
  commit?: string
  cleanWorktree: boolean
  exitCode: number
  startedAt: string
  finishedAt: string
  branch?: string
  checkoutRoot: string
  sessionId?: string
}

export function buildGatePaths(commonGitDir: string) {
  const rootDir = path.join(commonGitDir, 'freshell-test-gate')
  return {
    rootDir,
    lockFile: path.join(rootDir, 'full-suite.lock'),
    holderFile: path.join(rootDir, 'holder.json'),
    resultsFile: path.join(rootDir, 'last-results.json'),
  }
}

export function deriveSummary(input: { cliSummary?: string; envSummary?: string; branch?: string }): string {
  const explicit = input.cliSummary?.trim() || input.envSummary?.trim()
  if (explicit) return explicit
  return input.branch ? `unspecified task on ${input.branch}` : 'unspecified task'
}

export function findReusableBaseline(
  history: TestRunResultRecord[] | undefined,
  current: { commandKey: CommandKey; commit?: string },
): TestRunResultRecord | undefined {
  return history?.find((candidate) => (
    candidate.exitCode === 0 &&
    candidate.cleanWorktree &&
    candidate.commit === current.commit &&
    candidate.commandKey === current.commandKey
  ))
}

export function pushResultHistory(history: TestRunResultRecord[], record: TestRunResultRecord): TestRunResultRecord[] {
  const withoutSameCommit = history.filter((entry) => entry.commit !== record.commit)
  return [record, ...withoutSameCommit].slice(0, 20)
}

export function parseInvocationArgs(argv: string[]) {
  const args = [...argv]
  let summary: string | undefined
  const forwardedArgs: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--summary') {
      summary = args[index + 1]
      index += 1
      continue
    }
    forwardedArgs.push(arg)
  }

  return { summary, forwardedArgs }
}

export function classifyInvocation(input: { commandKey: CommandKey; forwardedArgs: string[] }) {
  const args = input.forwardedArgs
  if (args.length === 0) return { kind: 'broad' as const }
  if (args.every((arg) => arg === '--run' || arg.startsWith('--reporter'))) {
    return { kind: 'broad' as const }
  }

  const positional = args.filter((arg) => !arg.startsWith('-'))
  const hasExplicitFileTarget = positional.some((arg) => /\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/.test(arg))
  const hasDirectoryTarget = positional.some((arg) => /(^|\/)(test|src)(\/)?$/.test(arg) || !/\.[cm]?[jt]sx?$/.test(arg))
  const hasBroadSelector = args.some((arg) => ['--changed', '--related', '--dir'].includes(arg))

  if (hasExplicitFileTarget && !hasDirectoryTarget && !hasBroadSelector) {
    return { kind: 'narrowed' as const }
  }

  return { kind: 'broad' as const }
}

export function findUnsanctionedBroadVitest(processes: Array<{ pid: number; cwd: string; cmd: string }>) {
  return processes.filter(({ cmd }) => {
    if (!/vitest(\.mjs)?\s+run\b/.test(cmd)) return false
    return !(/\.(test|spec)\.[cm]?[jt]sx?\b/.test(cmd))
  })
}

export function resolveNpmRunner(input: { npmExecPath?: string; platform?: NodeJS.Platform }) {
  const npmExecPath = input.npmExecPath?.trim()
  if (npmExecPath) {
    return {
      command: process.execPath,
      argsPrefix: [npmExecPath],
    }
  }

  return {
    command: (input.platform ?? process.platform) === 'win32' ? 'npm.cmd' : 'npm',
    argsPrefix: [],
  }
}

export async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await fsp.rename(tempPath, filePath)
}
```

Keep the file ESM-safe and export the pure helpers so both unit tests and the later CLI code can reuse them.

**Step 4: Re-run the unit test**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-run-gate.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-run-gate.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-run-gate.test.ts
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add test gate metadata and baseline helpers"
```

## Task 3: Add the `flock`-backed gate wrapper and exercise live-status probing end-to-end

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-run-gate.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-run-gate/fake-heavy-command.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-run-gate.test.ts`

**Step 1: Write the failing integration test for serialization, live-status probing, stale-metadata tolerance, strict narrowed passthrough, bounded baseline history, and unsanctioned-run detection**

Create a small fixture script that sleeps briefly and exits with a requested code:

```ts
#!/usr/bin/env tsx

const sleepMs = Number(process.env.FRESHELL_FAKE_HEAVY_SLEEP_MS || '250')
const exitCode = Number(process.env.FRESHELL_FAKE_HEAVY_EXIT_CODE || '0')

await new Promise((resolve) => setTimeout(resolve, sleepMs))
process.exit(exitCode)
```

Then add `test/integration/server/test-run-gate.test.ts` that spawns wrapper processes against a temp git repo and temp state dir:

```ts
it('waits for the active holder, then runs after the lock clears', async () => {
  const holder = spawnGateProcess({
    cwd: worktreeDir,
    summary: 'Holder run',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '900',
      FRESHELL_TEST_WAIT_TIMEOUT_MS: '5000',
      FRESHELL_TEST_POLL_INTERVAL_MS: '100',
      CODEX_THREAD_ID: 'holder-thread',
    },
  })

  await holder.waitForOutput('Holder run')

  const waiter = spawnGateProcess({
    cwd: secondWorktreeDir,
    summary: 'Waiter run',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '100',
      FRESHELL_TEST_WAIT_TIMEOUT_MS: '5000',
      FRESHELL_TEST_POLL_INTERVAL_MS: '100',
      CODEX_THREAD_ID: 'waiter-thread',
    },
  })

  await waiter.waitForOutput('Another heavyweight test run is already active')
  await expect(holder.exitCode).resolves.toBe(0)
  await expect(waiter.exitCode).resolves.toBe(0)
  expect(waiter.output).toContain('Holder run')
  expect(waiter.output).toContain('holder-thread')
})

it('status reports a holder only while the lease is actually live', async () => {
  const holder = spawnGateProcess({
    cwd: worktreeDir,
    summary: 'Live holder',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '900',
      FRESHELL_TEST_POLL_INTERVAL_MS: '100',
      CODEX_THREAD_ID: 'holder-thread',
    },
  })

  await holder.waitForOutput('Live holder')

  const statusWhileHeld = await runGateStatus({ cwd: secondWorktreeDir })
  expect(statusWhileHeld.stdout).toContain('Active test run')
  expect(statusWhileHeld.stdout).toContain('Live holder')
  expect(statusWhileHeld.stdout).toContain('holder-thread')

  await expect(holder.exitCode).resolves.toBe(0)

  const statusAfterRelease = await runGateStatus({ cwd: secondWorktreeDir })
  expect(statusAfterRelease.stdout).not.toContain('Active test run')
})

it('does not treat leftover holder metadata as an active lock', async () => {
  await fsp.writeFile(holderFile, JSON.stringify({ summary: 'stale', pid: 999999 }))

  const run = spawnGateProcess({
    cwd: worktreeDir,
    summary: 'Fresh run',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '50',
    },
  })

  await expect(run.exitCode).resolves.toBe(0)
  expect(run.output).not.toContain('Active test run: stale')
})

it('allows narrowed invocations to bypass the broad-run gate while still using npm scripts', async () => {
  const holder = spawnGateProcess({
    cwd: worktreeDir,
    summary: 'Broad holder',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '400',
    },
  })

  await holder.waitForOutput('Broad holder')

  const narrowed = spawnGateProcess({
    cwd: secondWorktreeDir,
    summary: 'Focused test',
    forwardedArgs: ['test/unit/server/foo.test.ts', '-t', 'focus'],
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '50',
    },
  })

  await expect(narrowed.exitCode).resolves.toBe(0)
  await expect(holder.exitCode).resolves.toBe(0)
  expect(narrowed.output).toContain('Bypassing full-suite gate for narrowed invocation')
  expect(narrowed.output).toContain('test/unit/server/foo.test.ts')
})

it('keeps directory-wide targeted runs inside the gate', async () => {
  const holder = spawnGateProcess({
    cwd: worktreeDir,
    summary: 'Broad holder',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '400',
    },
  })

  await holder.waitForOutput('Broad holder')

  const stillBroad = spawnGateProcess({
    cwd: secondWorktreeDir,
    summary: 'Directory target',
    forwardedArgs: ['test/server'],
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '50',
      FRESHELL_TEST_WAIT_TIMEOUT_MS: '5000',
      FRESHELL_TEST_POLL_INTERVAL_MS: '100',
    },
  })

  await stillBroad.waitForOutput('Another heavyweight test run is already active')
  await expect(holder.exitCode).resolves.toBe(0)
  await expect(stillBroad.exitCode).resolves.toBe(0)
})

it('status can find an older exact-commit reusable baseline after newer runs on other commits', async () => {
  await seedResultsFile({
    successHistoryByCommand: {
      full: [
        { commandKey: 'full', commit: 'def456', cleanWorktree: true, exitCode: 0, finishedAt: '2026-03-08T19:20:00.000Z', summary: 'newer' },
        { commandKey: 'full', commit: currentCommit, cleanWorktree: true, exitCode: 0, finishedAt: '2026-03-08T19:10:00.000Z', summary: 'matching baseline' },
      ],
    },
  })

  const status = await runGateStatus({ cwd: worktreeDir })
  expect(status.stdout).toContain('matching baseline')
})

it('blocks a sanctioned broad run when an unsanctioned broad vitest leader is detected', async () => {
  const rogue = spawnRawVitestLikeProcess({
    cwd: secondWorktreeDir,
    cmdlineLabel: 'npx vitest run',
    sleepMs: 900,
  })

  await rogue.waitForOutput('rogue-broad-run-ready')

  const gated = await runGateProcess({
    cwd: worktreeDir,
    summary: 'Legit run',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '50',
    },
  })

  expect(gated.exitCode).toBe(1)
  expect(gated.output).toContain('Unsanctioned broad Vitest run detected')
  expect(gated.output).toContain('npx vitest run')
})
```

Use short poll/wait overrides so the test stays fast. Do not run the real suite in this integration harness.

**Step 2: Run the integration test and confirm failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/integration/server/test-run-gate.test.ts
```

Expected: FAIL because the CLI wrapper and fixture are not implemented yet.

**Step 3: Implement the CLI wrapper on top of the pure helpers**

Finish `scripts/test-run-gate.ts` with:
- CLI parsing for `full`, `unit`, `client`, `server`, `integration`, `check`, `verify`, `coverage`, and `status`.
- `--summary` parsing with `FRESHELL_TEST_SUMMARY` fallback.
- arbitrary extra-arg passthrough from the wrapper’s raw child argv, preserved exactly for the underlying raw npm script.
- session/thread detection from `CODEX_THREAD_ID` first, then other known agent session env vars if present.
- git context discovery using `resolveGitCheckoutRoot`, `resolveGitRepoRoot`, `resolveGitCommonDir`, and Git `rev-parse HEAD`.
- a `flock`-backed critical section rooted at `buildGatePaths(commonGitDir).lockFile`.
- a bounded wait loop with minute-scale defaults and test-only env overrides.
- advisory `holder.json` and `last-results.json` reads/writes.
- invocation classification that bypasses the gate only for explicit file-targeted runs while still using the sanctioned npm script entrypoint.
- a `status` path that performs the same immediate non-blocking `flock` probe as runners, but never waits and never starts a test command.
- cross-platform npm execution using `process.execPath` + `process.env.npm_execpath` when available, with `npm.cmd`/`npm` fallback outside npm.
- wrapper-managed substeps for `full`, `check`, and `verify` so forwarded args are applied deliberately to each underlying test command instead of relying on npm to propagate args through `&&`.
- a secondary process-detector for unsanctioned broad Vitest leaders in repo worktrees, used only as an advisory blocker and status signal, never as the correctness primitive.

Implement the execution mapping through private raw scripts so every sanctioned broad package-script entrypoint goes through the same gate while preserving forwarded args for the underlying Vitest step:

```ts
const COMMANDS: Record<CommandKey, {
  label: string
  preGateSteps?: (forwardedArgs: string[]) => Array<{ npmScript: string; forwardedArgs: string[] }>
  gatedSteps: (forwardedArgs: string[]) => Array<{ npmScript: string; forwardedArgs: string[] }>
}> = {
  full: {
    label: 'npm test',
    gatedSteps: (forwardedArgs) => [
      { npmScript: '_test:client:all:raw', forwardedArgs: forwardedArgs.length > 0 ? [...forwardedArgs, '--passWithNoTests'] : forwardedArgs },
      { npmScript: '_test:server:all:raw', forwardedArgs: forwardedArgs.length > 0 ? [...forwardedArgs, '--passWithNoTests'] : forwardedArgs },
    ],
  },
  unit: {
    label: 'npm run test:unit',
    gatedSteps: (forwardedArgs) => [{ npmScript: '_test:unit:raw', forwardedArgs }],
  },
  client: {
    label: 'npm run test:client',
    gatedSteps: (forwardedArgs) => [{ npmScript: '_test:client:raw', forwardedArgs }],
  },
  server: {
    label: 'npm run test:server',
    gatedSteps: (forwardedArgs) => [{ npmScript: '_test:server:raw', forwardedArgs }],
  },
  integration: {
    label: 'npm run test:integration',
    gatedSteps: (forwardedArgs) => [{ npmScript: '_test:integration:raw', forwardedArgs }],
  },
  check: {
    label: 'npm run check',
    preGateSteps: () => [
      { npmScript: 'typecheck', forwardedArgs: [] },
    ],
    gatedSteps: (forwardedArgs) => [
      { npmScript: '_test:client:all:raw', forwardedArgs: forwardedArgs.length > 0 ? [...forwardedArgs, '--passWithNoTests'] : forwardedArgs },
      { npmScript: '_test:server:all:raw', forwardedArgs: forwardedArgs.length > 0 ? [...forwardedArgs, '--passWithNoTests'] : forwardedArgs },
    ],
  },
  verify: {
    label: 'npm run verify',
    preGateSteps: () => [
      { npmScript: 'build', forwardedArgs: [] },
    ],
    gatedSteps: (forwardedArgs) => [
      { npmScript: '_test:client:all:raw', forwardedArgs: forwardedArgs.length > 0 ? [...forwardedArgs, '--passWithNoTests'] : forwardedArgs },
      { npmScript: '_test:server:all:raw', forwardedArgs: forwardedArgs.length > 0 ? [...forwardedArgs, '--passWithNoTests'] : forwardedArgs },
    ],
  },
  coverage: {
    label: 'npm run test:coverage',
    gatedSteps: (forwardedArgs) => [{ npmScript: '_test:coverage:raw', forwardedArgs }],
  },
}
```

The gate handling should follow this shape:

```ts
async function waitForGate(paths: GatePaths, holder: HolderRecord): Promise<GateLease> {
  const deadline = Date.now() + waitTimeoutMs

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const probe = await probeGate(paths)
    if (probe.state === 'free') {
      const lease = await tryAcquireGate(paths.lockFile, holder)
      if (lease) return lease
    } else {
      renderBusyMessage(probe.holder, deadline)
    }

    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the heavyweight test gate after 60 minutes')
    }

    await sleep(pollIntervalMs)
  }
}
```

`probeGate()` must be the single source of truth for both waiters and `status`: it attempts a non-blocking `flock` probe against the shared lock file. If the probe acquires the kernel lock, it immediately releases it and reports `free`; if the probe fails, it reports `held` and may print advisory holder metadata from `holder.json`. Leftover metadata without a held kernel lock must be ignored.

Before any sanctioned broad run acquires the kernel lock, the wrapper should also scan running repo/worktree processes for unsanctioned broad Vitest leaders. If one is present, refuse to start and print the same patience/wait guidance plus the detected PID/cwd/cmd. This does not replace `flock`; it only makes the known bypass path noisy and blocks sanctioned collisions against it.

Gate entry must parse npm-child argv first, then branch on invocation shape before touching the queue:

```ts
const { summary, forwardedArgs } = parseInvocationArgs(process.argv.slice(3))
const invocation = classifyInvocation({ commandKey, forwardedArgs })
if (invocation.kind === 'narrowed') {
  console.log('Bypassing full-suite gate for narrowed invocation')
  return runConfiguredSteps(COMMANDS[commandKey].gatedSteps(forwardedArgs))
}

await runConfiguredSteps(COMMANDS[commandKey].preGateSteps?.(forwardedArgs) ?? [])
const lease = await waitForGate(paths, holder)
try {
  return runConfiguredSteps(COMMANDS[commandKey].gatedSteps(forwardedArgs))
} finally {
  await lease.release()
}
```

Keep the bypass rule intentionally tight:
- explicit test file targets such as `test/unit/server/foo.test.ts` or a list of `.test.ts` / `.spec.tsx` files may bypass,
- file targets plus `-t` / `--testNamePattern` may bypass,
- directory targets such as `test/server` or `test/unit/client` remain broad and gated,
- selector-only runs such as `--changed` remain broad and gated.

Use a hidden test-only override so the integration suite can substitute the fixture command instead of running the real tests:

```ts
const fakeCommand = process.env.FRESHELL_TEST_GATE_FAKE_COMMAND?.trim()
if (fakeCommand) {
  return { command: process.execPath, args: [tsxBinPath, fakeCommand] }
}
```

**Step 4: Re-run the integration test**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/integration/server/test-run-gate.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-run-gate.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-run-gate/fake-heavy-command.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-run-gate.test.ts
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): serialize heavyweight test runs with a shared gate"
```

## Task 4: Route public npm entrypoints through the gate and document the new workflow

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package.json`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md`

**Step 1: Update the public npm scripts to use the gate while preserving passthrough ergonomics**

Change the public test scripts in `package.json` so every broad non-interactive entrypoint routes through the gate and the raw runners become private single-step scripts:

```json
{
  "scripts": {
    "_test:client:all:raw": "vitest run",
    "_test:server:all:raw": "vitest run --config vitest.server.config.ts",
    "_test:unit:raw": "vitest run test/unit",
    "_test:client:raw": "vitest run test/unit/client",
    "_test:server:raw": "vitest run --config vitest.server.config.ts",
    "_test:integration:raw": "vitest run --config vitest.server.config.ts test/server",
    "_test:coverage:raw": "vitest run --coverage",
    "test": "tsx scripts/test-run-gate.ts full",
    "verify": "tsx scripts/test-run-gate.ts verify",
    "check": "tsx scripts/test-run-gate.ts check",
    "test:coverage": "tsx scripts/test-run-gate.ts coverage",
    "test:all": "tsx scripts/test-run-gate.ts full",
    "test:unit": "tsx scripts/test-run-gate.ts unit",
    "test:client": "tsx scripts/test-run-gate.ts client",
    "test:server": "tsx scripts/test-run-gate.ts server",
    "test:integration": "tsx scripts/test-run-gate.ts integration",
    "test:status": "tsx scripts/test-run-gate.ts status",
    "test:watch": "vitest",
    "test:ui": "vitest --ui"
  }
}
```

This makes every sanctioned broad `npm run test:*` path gated. Only explicit interactive watch/UI workflows and explicit file-scoped raw Vitest commands remain outside the wrapper.

The wrapper must preserve npm passthrough behavior. These commands must still work and must be documented as sanctioned:

```bash
npm test -- test/unit/server/terminal-registry.test.ts -t "reaping exited terminals"
npm run test:server -- test/unit/server/sessions-sync/diff.test.ts
npm run test:client -- test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
```

All of those should forward their extra args to the corresponding private raw script and skip the broad-run gate because they are narrowed invocations.

By contrast, these commands must remain gated because they are still broad:

```bash
npm run test:server -- test/server
npm run test:unit -- test/unit
npm run test:client -- --changed
```

**Step 2: Update agent and testing docs**

Adjust `AGENTS.md` and `docs/skills/testing.md` so they match the new reality:
- `npm test` is a full gated run, not watch mode.
- every broad non-interactive npm test script is gated when run broadly, including `test:unit`, `test:client`, `test:server`, and `test:integration`.
- those same npm scripts still support `--` passthrough for focused TDD runs, and only explicit file-targeted narrowed invocations bypass the broad-run gate automatically.
- `npm run check` and `npm run verify` only hold the gate during their heavyweight test phases; typecheck/build happen before lock acquisition.
- `npm run test:status` performs a non-blocking live probe, reports an active holder only when the lease is live, and otherwise reports the latest reusable exact-commit baseline.
- agents should set `FRESHELL_TEST_SUMMARY` or pass `--summary`.
- private underscore-prefixed raw scripts are internal plumbing, not agent entrypoints.
- direct `npx vitest run` is no longer the recommended workaround for focused runs because the sanctioned npm scripts preserve passthrough targeting.
- the reusable baseline cache is a bounded per-command history keyed by commit, not just the latest run.
- unsanctioned broad raw `npx vitest run` is now actively detected and shown as a blocker/status finding, even though the kernel lock only governs sanctioned wrapper entrypoints.

Use concrete examples:

```md
FRESHELL_TEST_SUMMARY="Fix terminal attach ordering" npm run check
npm run test:status
```

**Step 3: Run focused verification for the wiring changes**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-run-gate.test.ts test/unit/server/coding-cli/git-metadata.test.ts
npx vitest run --config vitest.server.config.ts test/integration/server/test-run-gate.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/package.json \
  /home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md \
  /home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "docs(testing): route heavyweight test commands through the gate"
```

## Task 5: Run final gated verification and validate the baseline/status UX

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-run-gate.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-run-gate.test.ts`

**Step 1: Add the last failing assertions for human-facing status output**

Extend the integration test so it checks:
- `status` prints a matching reusable baseline after a clean successful run,
- failed runs update the "last failure" record but do not present themselves as reusable baselines,
- holder output includes the wait guidance: poll every minute, be patient for up to one hour, and do not kill a run you did not start,
- `status` does not report a holder when only stale metadata remains,
- explicit file-targeted narrowed invocations continue to bypass the queue and still forward their args,
- directory-targeted or selector-only invocations stay in the queue,
- reusable baseline lookup still finds the current commit after newer successes on other commits,
- unsanctioned broad raw Vitest leaders are surfaced and block sanctioned broad runs.

Add assertions like:

```ts
it('reports the last reusable baseline for the current commit', async () => {
  await runGateProcess({
    cwd: worktreeDir,
    summary: 'Baseline run',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '50',
    },
  })

  const status = await runGateStatus({
    cwd: secondWorktreeDir,
    env: { CODEX_THREAD_ID: 'status-thread' },
  })

  expect(status.stdout).toContain('Reusable baseline available for this commit')
  expect(status.stdout).toContain('Baseline run')
})
```

**Step 2: Run the failing integration test**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/integration/server/test-run-gate.test.ts
```

Expected: FAIL until the status/baseline messaging is complete.

**Step 3: Finish the wrapper output and result bookkeeping**

Update `scripts/test-run-gate.ts` so:
- every completed run writes a result record into bounded per-command history keyed by commit,
- a reusable baseline is shown only when `exitCode === 0`, `cleanWorktree === true`, and `commit` matches the current checkout exactly,
- failures are still recorded and shown as informational history, but never marked reusable,
- `status` is read-only in the sense that it never waits and never starts tests, but it still runs the same immediate non-blocking `probeGate()` logic as waiters so it can truthfully report `held` versus `free`.
- only explicit file-targeted narrowed invocations never enter the `flock` wait loop, but they still use the same wrapper, metadata collection, and raw-script dispatch path.
- `check`/`verify` acquire the gate only around their heavyweight test substeps, not around `typecheck` or `build`.
- when process detection finds an unsanctioned broad Vitest leader, `status` reports it and sanctioned broad runs refuse to start until it exits.

The persisted JSON structure should stay bounded and explicit:

```ts
interface PersistedResults {
  successHistoryByCommand: Partial<Record<CommandKey, TestRunResultRecord[]>>
  failureHistoryByCommand: Partial<Record<CommandKey, TestRunResultRecord[]>>
}
```

Enforce a small cap such as 20 entries per command, newest-first, deduplicated by commit so the cache remains bounded but still useful in a busy multi-agent repo.

**Step 4: Run final verification**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-run-gate.test.ts test/unit/server/coding-cli/git-metadata.test.ts
npx vitest run --config vitest.server.config.ts test/integration/server/test-run-gate.test.ts
FRESHELL_TEST_SUMMARY="Focused verification" npm run test:server -- test/unit/server/sessions-sync/diff.test.ts
FRESHELL_TEST_SUMMARY="Final verification for test gate" npm run check
npm run test:status
```

Expected:
- targeted unit and integration tests PASS,
- `npm run check` waits its turn if necessary and then PASSes through the new gate,
- `npm run test:status` reports a live active holder only when the lease probe confirms one, otherwise it reports the latest exact-commit reusable baseline.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-run-gate.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-run-gate.test.ts
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "test(testing): verify gate status and baseline reporting"
```
