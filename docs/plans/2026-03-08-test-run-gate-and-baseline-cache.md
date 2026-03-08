# Test Run Gate And Baseline Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Serialize broad test runs across repo worktrees, show truthfully who currently holds the gate and why, and publish exact-commit baseline results that other agents can reuse as advisory context.

**Architecture:** Add one TypeScript wrapper script that owns lease acquisition, bounded waiting, holder metadata, and last-result caching for all broad non-interactive npm test entrypoints. Store shared state in the repo's Git common dir, use an atomic lease directory plus heartbeat and PID-liveness checks so the gate works on Linux, WSL, macOS, and native Windows without depending on `flock`, and make `status` use the same immediate live-probe path as waiters so it only reports an active holder when the lease is actually live.

**Tech Stack:** Node.js, TypeScript, `tsx`, `child_process`, `fs/promises`, Git CLI, Vitest.

---

User-approved direction:
- Lock-backed gate, not process-detection-only.
- Holder metadata should include summary, worktree, branch, session/thread ID, and similar context when available.
- Keep a last-run results record so agents can inspect a matching exact-commit baseline instead of blindly rerunning.
- Make the ergonomic path the default npm commands and make heavyweight raw invocations socially and structurally discouraged.
- Do not run a full suite until the gate exists.

Design decisions for implementation:
- Treat the gate as repo-shared state rooted in `git rev-parse --git-common-dir`, not in an individual worktree.
- Gate every broad non-interactive npm test entrypoint: `npm test`, `npm run test:all`, `npm run test:unit`, `npm run test:client`, `npm run test:server`, `npm run test:integration`, `npm run test:coverage`, `npm run check`, and `npm run verify`.
- Keep only explicitly interactive commands (`npm run test:watch`, `npm run test:ui`) and explicit file-scoped raw `npx vitest run <files>` outside the gate. The former are local-only workflows; the latter remain possible but are no longer the sanctioned path for broad runs.
- Make the public npm scripts hard to bypass by routing them all through the wrapper and moving the actual raw runners to private underscore-prefixed scripts that only the wrapper invokes.
- Make baseline results advisory only. Never auto-skip a required fresh landing run.
- Accept summary input from `--summary "..."` and `FRESHELL_TEST_SUMMARY`, but fall back to an automatic placeholder instead of failing if the agent omits it.
- Make `status` read-only in the sense that it never waits and never starts tests, but it must still perform the same immediate lease probe and stale-recovery logic as runners so its holder report is truthful.

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
- exact-commit reusable baseline detection,
- dirty-worktree exclusion from reusable results,
- lease-state classification for `free` / `held` / `stale`,
- cross-platform npm invocation resolution.

Seed the new test file with cases like:

```ts
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildHolderRecord,
  buildGatePaths,
  classifyLeaseState,
  chooseReusableBaseline,
  deriveSummary,
  resolveNpmRunner,
  type TestRunResultRecord,
} from '../../../scripts/test-run-gate.js'

describe('test-run-gate helpers', () => {
  it('roots gate files in the shared common git dir', () => {
    expect(buildGatePaths('/repo/.git')).toEqual({
      rootDir: path.join('/repo/.git', 'freshell-test-gate'),
      leaseDir: path.join('/repo/.git', 'freshell-test-gate', 'lease'),
      holderFile: path.join('/repo/.git', 'freshell-test-gate', 'holder.json'),
      heartbeatFile: path.join('/repo/.git', 'freshell-test-gate', 'heartbeat.json'),
      resultsFile: path.join('/repo/.git', 'freshell-test-gate', 'last-results.json'),
    })
  })

  it('prefers explicit summary but falls back to useful context', () => {
    expect(deriveSummary({ cliSummary: 'Fix attach race', envSummary: 'ignored', branch: 'feature/x' })).toBe('Fix attach race')
    expect(deriveSummary({ cliSummary: '', envSummary: '', branch: 'feature/x' })).toBe('unspecified task on feature/x')
  })

  it('only reuses successful exact-commit clean baselines', () => {
    const candidate: TestRunResultRecord = {
      commandKey: 'full',
      commit: 'abc123',
      cleanWorktree: true,
      exitCode: 0,
      finishedAt: '2026-03-08T19:10:00.000Z',
    }

    expect(chooseReusableBaseline(candidate, { commandKey: 'full', commit: 'abc123' })).toBe(candidate)
    expect(chooseReusableBaseline(candidate, { commandKey: 'check', commit: 'abc123' })).toBeUndefined()
    expect(chooseReusableBaseline({ ...candidate, cleanWorktree: false }, { commandKey: 'full', commit: 'abc123' })).toBeUndefined()
    expect(chooseReusableBaseline({ ...candidate, commit: 'def456' }, { commandKey: 'full', commit: 'abc123' })).toBeUndefined()
  })

  it('classifies live versus stale leases explicitly', () => {
    expect(classifyLeaseState({ leaseExists: false })).toEqual({ state: 'free' })
    expect(classifyLeaseState({ leaseExists: true, pidAlive: true, heartbeatAgeMs: 5_000 })).toEqual({ state: 'held' })
    expect(classifyLeaseState({ leaseExists: true, pidAlive: false, heartbeatAgeMs: 120_000 })).toEqual({ state: 'stale' })
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

export type CommandKey = 'full' | 'check' | 'verify' | 'coverage'

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
    leaseDir: path.join(rootDir, 'lease'),
    holderFile: path.join(rootDir, 'holder.json'),
    heartbeatFile: path.join(rootDir, 'heartbeat.json'),
    resultsFile: path.join(rootDir, 'last-results.json'),
  }
}

export function deriveSummary(input: { cliSummary?: string; envSummary?: string; branch?: string }): string {
  const explicit = input.cliSummary?.trim() || input.envSummary?.trim()
  if (explicit) return explicit
  return input.branch ? `unspecified task on ${input.branch}` : 'unspecified task'
}

export function chooseReusableBaseline(
  candidate: TestRunResultRecord | undefined,
  current: { commandKey: CommandKey; commit?: string },
): TestRunResultRecord | undefined {
  if (!candidate) return undefined
  if (candidate.exitCode !== 0) return undefined
  if (!candidate.cleanWorktree) return undefined
  if (!candidate.commit || candidate.commit !== current.commit) return undefined
  if (candidate.commandKey !== current.commandKey) return undefined
  return candidate
}

export function classifyLeaseState(input: {
  leaseExists: boolean
  pidAlive?: boolean
  heartbeatAgeMs?: number
}) {
  if (!input.leaseExists) return { state: 'free' as const }
  if (input.pidAlive) return { state: 'held' as const }
  if ((input.heartbeatAgeMs ?? Number.POSITIVE_INFINITY) > 60_000) {
    return { state: 'stale' as const }
  }
  return { state: 'held' as const }
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

## Task 3: Add the cross-platform gate wrapper and exercise live-status probing end-to-end

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-run-gate.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-run-gate/fake-heavy-command.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-run-gate.test.ts`

**Step 1: Write the failing integration test for serialization, live-status probing, and stale-lease recovery**

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

it('reclaims a stale lease instead of reporting a dead holder forever', async () => {
  await fsp.mkdir(leaseDir, { recursive: true })
  await fsp.writeFile(holderFile, JSON.stringify({ summary: 'stale', pid: 999999 }))
  await fsp.writeFile(heartbeatFile, JSON.stringify({ updatedAt: '2026-03-08T00:00:00.000Z' }))

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

it('serializes broad runs in forced portable-lock mode', async () => {
  const holder = spawnGateProcess({
    cwd: worktreeDir,
    summary: 'Portable holder',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '400',
      FRESHELL_TEST_FORCE_PORTABLE_GATE: '1',
    },
  })

  await holder.waitForOutput('Portable holder')

  const waiter = spawnGateProcess({
    cwd: secondWorktreeDir,
    summary: 'Portable waiter',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '50',
      FRESHELL_TEST_FORCE_PORTABLE_GATE: '1',
      FRESHELL_TEST_WAIT_TIMEOUT_MS: '5000',
      FRESHELL_TEST_POLL_INTERVAL_MS: '100',
    },
  })

  await waiter.waitForOutput('Another heavyweight test run is already active')
  await expect(holder.exitCode).resolves.toBe(0)
  await expect(waiter.exitCode).resolves.toBe(0)
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
- session/thread detection from `CODEX_THREAD_ID` first, then other known agent session env vars if present.
- git context discovery using `resolveGitCheckoutRoot`, `resolveGitRepoRoot`, `resolveGitCommonDir`, and Git `rev-parse HEAD`.
- a cross-platform lease rooted at `buildGatePaths(commonGitDir).leaseDir`, acquired with atomic `fs.mkdir`.
- heartbeat updates for the current holder plus PID-liveness checks for stale recovery.
- a bounded wait loop with minute-scale defaults and test-only env overrides.
- advisory `holder.json` and `last-results.json` reads/writes.
- a `status` path that performs the same immediate lease probe and stale cleanup as runners, but never waits and never starts a test command.
- cross-platform npm execution using `process.execPath` + `process.env.npm_execpath` when available, with `npm.cmd`/`npm` fallback outside npm.

Implement the execution mapping through private raw scripts so every sanctioned broad package-script entrypoint goes through the same gate:

```ts
const COMMANDS: Record<CommandKey, { label: string; npmScript: string }> = {
  full: { label: 'npm test', npmScript: '_test:full:raw' },
  unit: { label: 'npm run test:unit', npmScript: '_test:unit:raw' },
  client: { label: 'npm run test:client', npmScript: '_test:client:raw' },
  server: { label: 'npm run test:server', npmScript: '_test:server:raw' },
  integration: { label: 'npm run test:integration', npmScript: '_test:integration:raw' },
  check: { label: 'npm run check', npmScript: '_check:raw' },
  verify: { label: 'npm run verify', npmScript: '_verify:raw' },
  coverage: { label: 'npm run test:coverage', npmScript: '_test:coverage:raw' },
}
```

The lease handling should follow this shape:

```ts
async function waitForGate(paths: GatePaths, holder: HolderRecord): Promise<GateLease> {
  const deadline = Date.now() + waitTimeoutMs

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snapshot = await probeGateState(paths)
    if (snapshot.state === 'free') {
      const lease = await tryAcquireLease(paths, holder)
      if (lease) return lease
    } else if (snapshot.state === 'held') {
      renderBusyMessage(snapshot.holder, deadline)
    } else {
      await reclaimStaleLease(paths, snapshot)
    }

    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the heavyweight test gate after 60 minutes')
    }

    await sleep(pollIntervalMs)
  }
}
```

`probeGateState()` must be the single source of truth for both waiters and `status`: it checks whether the lease directory exists, reads holder and heartbeat metadata, verifies PID liveness, and classifies the state as `free`, `held`, or `stale`. `status` may use that probe and may reclaim a provably stale lease, but it must never block and never start a test command.

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

**Step 1: Update the public npm scripts to use the gate**

Change the public test scripts in `package.json` so every broad non-interactive entrypoint routes through the gate and the raw runners become private:

```json
{
  "scripts": {
    "_test:full:raw": "vitest run && vitest run --config vitest.server.config.ts",
    "_test:unit:raw": "vitest run test/unit",
    "_test:client:raw": "vitest run test/unit/client",
    "_test:server:raw": "vitest run --config vitest.server.config.ts",
    "_test:integration:raw": "vitest run --config vitest.server.config.ts test/server",
    "_test:coverage:raw": "vitest run --coverage",
    "_check:raw": "npm run typecheck && npm run _test:full:raw",
    "_verify:raw": "npm run build && npm run _test:full:raw",
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

**Step 2: Update agent and testing docs**

Adjust `AGENTS.md` and `docs/skills/testing.md` so they match the new reality:
- `npm test` is a full gated run, not watch mode.
- every broad non-interactive npm test script is gated, including `test:unit`, `test:client`, `test:server`, and `test:integration`.
- `test:server` is normalized to a deterministic gated one-shot server-suite run; `test:watch` and `test:ui` remain the interactive workflows.
- `npm run test:status` performs a non-blocking live probe, reports an active holder only when the lease is live, and otherwise reports the latest reusable exact-commit baseline.
- agents should set `FRESHELL_TEST_SUMMARY` or pass `--summary`.
- private underscore-prefixed raw scripts are internal plumbing, not agent entrypoints.
- direct `npx vitest run` is for explicit file-targeted test runs only, not for broad config-or-directory runs.

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
- `status` does not report a holder after a stale lease has been reclaimed.

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
- every completed run writes a result record keyed by command,
- a reusable baseline is shown only when `exitCode === 0`, `cleanWorktree === true`, and `commit` matches the current checkout exactly,
- failures are still recorded and shown as informational history, but never marked reusable,
- `status` is read-only in the sense that it never waits and never starts tests, but it still runs the same immediate `probeGateState()` logic as waiters so it can truthfully report `held` versus `free` and reclaim a provably stale lease.

The persisted JSON structure should stay small and explicit:

```ts
interface PersistedResults {
  lastSuccessByCommand: Partial<Record<CommandKey, TestRunResultRecord>>
  lastFailureByCommand: Partial<Record<CommandKey, TestRunResultRecord>>
}
```

**Step 4: Run final verification**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-run-gate.test.ts test/unit/server/coding-cli/git-metadata.test.ts
npx vitest run --config vitest.server.config.ts test/integration/server/test-run-gate.test.ts
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
