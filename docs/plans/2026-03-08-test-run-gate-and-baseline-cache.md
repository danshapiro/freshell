# Test Run Gate And Baseline Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Serialize heavyweight test runs across repo worktrees, show who currently holds the test gate and why, and publish exact-commit baseline results that other agents can reuse as advisory context.

**Architecture:** Add one TypeScript wrapper script that owns lock acquisition, bounded waiting, holder metadata, and last-result caching for heavyweight test entrypoints. Store all advisory state in the repo's shared Git common dir so every worktree sees the same gate, use kernel-backed `flock` as the actual mutex so crashes do not leave a stale lock behind, and route public npm scripts through the wrapper while leaving focused `vitest` runs available for narrow local work.

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
- Gate only heavyweight entrypoints: `npm test`, `npm run test:all`, `npm run check`, `npm run verify`, and `npm run test:coverage`.
- Leave focused commands such as `npm run test:unit`, `npm run test:client`, `npm run test:integration`, and direct scoped `npx vitest run <files>` ungated.
- Make baseline results advisory only. Never auto-skip a required fresh landing run.
- Accept summary input from `--summary "..."` and `FRESHELL_TEST_SUMMARY`, but fall back to an automatic placeholder instead of failing if the agent omits it.

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
- dirty-worktree exclusion from reusable results.

Seed the new test file with cases like:

```ts
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildHolderRecord,
  buildGatePaths,
  chooseReusableBaseline,
  deriveSummary,
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

## Task 3: Add the lock-aware CLI wrapper and exercise the wait path end-to-end

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-run-gate.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-run-gate/fake-heavy-command.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-run-gate.test.ts`

**Step 1: Write the failing integration test for serialization, status messaging, and stale metadata tolerance**

Create a small fixture script that sleeps briefly and exits with a requested code:

```ts
#!/usr/bin/env tsx

const sleepMs = Number(process.env.FRESHELL_FAKE_HEAVY_SLEEP_MS || '250')
const exitCode = Number(process.env.FRESHELL_FAKE_HEAVY_EXIT_CODE || '0')

await new Promise((resolve) => setTimeout(resolve, sleepMs))
process.exit(exitCode)
```

Then add `test/integration/server/test-run-gate.test.ts` that spawns two wrapper processes against a temp git repo and temp state dir:

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

it('does not treat a leftover holder.json as an active lock', async () => {
  await fsp.writeFile(holderFile, JSON.stringify({ summary: 'stale' }))

  const run = spawnGateProcess({
    cwd: worktreeDir,
    summary: 'Fresh run',
    env: {
      FRESHELL_TEST_GATE_FAKE_COMMAND: fixturePath,
      FRESHELL_FAKE_HEAVY_SLEEP_MS: '50',
    },
  })

  await expect(run.exitCode).resolves.toBe(0)
  expect(run.output).not.toContain('stale')
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
- CLI parsing for `full`, `check`, `verify`, `coverage`, and `status`.
- `--summary` parsing with `FRESHELL_TEST_SUMMARY` fallback.
- session/thread detection from `CODEX_THREAD_ID` first, then other known agent session env vars if present.
- git context discovery using `resolveGitCheckoutRoot`, `resolveGitRepoRoot`, `resolveGitCommonDir`, and Git `rev-parse HEAD`.
- a `flock`-backed critical section rooted at `buildGatePaths(commonGitDir).lockFile`.
- a bounded wait loop with minute-scale defaults and test-only env overrides.
- advisory `holder.json` and `last-results.json` reads/writes.
- status output that shows the active holder and the last reusable exact-commit baseline for the current command when present.

Implement the execution mapping directly inside the script so the public npm scripts cannot recurse into themselves:

```ts
const COMMANDS: Record<CommandKey, { label: string; steps: Array<{ command: string; args: string[] }> }> = {
  full: {
    label: 'npm test',
    steps: [
      { command: 'npm', args: ['exec', 'vitest', 'run'] },
      { command: 'npm', args: ['exec', 'vitest', 'run', '--config', 'vitest.server.config.ts'] },
    ],
  },
  check: {
    label: 'npm run check',
    steps: [
      { command: 'npm', args: ['run', 'typecheck'] },
      { command: 'npm', args: ['exec', 'vitest', 'run'] },
      { command: 'npm', args: ['exec', 'vitest', 'run', '--config', 'vitest.server.config.ts'] },
    ],
  },
  verify: {
    label: 'npm run verify',
    steps: [
      { command: 'npm', args: ['run', 'build'] },
      { command: 'npm', args: ['exec', 'vitest', 'run'] },
      { command: 'npm', args: ['exec', 'vitest', 'run', '--config', 'vitest.server.config.ts'] },
    ],
  },
  coverage: {
    label: 'npm run test:coverage',
    steps: [
      { command: 'npm', args: ['exec', 'vitest', 'run', '--coverage'] },
    ],
  },
}
```

The lock handling should follow this shape:

```ts
async function waitForGate(paths: GatePaths, holder: HolderRecord): Promise<GateLease> {
  const deadline = Date.now() + waitTimeoutMs

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const lease = await tryAcquireLease(paths.lockFile)
    if (lease) {
      await writeJsonAtomically(paths.holderFile, holder)
      return lease
    }

    const activeHolder = await readJson<HolderRecord>(paths.holderFile)
    renderBusyMessage(activeHolder, deadline)

    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the heavyweight test gate after 60 minutes')
    }

    await sleep(pollIntervalMs)
  }
}
```

Do not trust `holder.json` as proof of a live lock. Only print it after a failed non-blocking lock attempt.

Use a hidden test-only override so the integration suite can substitute the fixture command instead of running the real tests:

```ts
const fakeCommand = process.env.FRESHELL_TEST_GATE_FAKE_COMMAND?.trim()
if (fakeCommand) {
  return [{ command: process.execPath, args: [tsxBinPath, fakeCommand] }]
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

Change the heavyweight public entrypoints in `package.json`:

```json
{
  "scripts": {
    "test": "tsx scripts/test-run-gate.ts full",
    "verify": "tsx scripts/test-run-gate.ts verify",
    "check": "tsx scripts/test-run-gate.ts check",
    "test:coverage": "tsx scripts/test-run-gate.ts coverage",
    "test:all": "tsx scripts/test-run-gate.ts full",
    "test:status": "tsx scripts/test-run-gate.ts status",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run --config vitest.server.config.ts test/server",
    "test:client": "vitest run test/unit/client"
  }
}
```

Leave focused commands ungated.

**Step 2: Update agent and testing docs**

Adjust `AGENTS.md` and `docs/skills/testing.md` so they match the new reality:
- `npm test` is a full gated run, not watch mode.
- `npm run test:status` shows the active holder plus the last reusable exact-commit baseline.
- agents should set `FRESHELL_TEST_SUMMARY` or pass `--summary`.
- direct `npx vitest run` is for narrow targeted test runs only, not for full-suite equivalents.

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
- holder output includes the wait guidance: poll every minute, be patient for up to one hour, and do not kill a run you did not start.

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
- `status` is read-only and never attempts to acquire the gate.

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
- `npm run test:status` reports either an active holder or the latest exact-commit reusable baseline.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-run-gate.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/integration/server/test-run-gate.test.ts
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "test(testing): verify gate status and baseline reporting"
```
