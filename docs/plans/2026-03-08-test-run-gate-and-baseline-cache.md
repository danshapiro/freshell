# Test Run Gate And Baseline Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Add a single sanctioned test-command path that serializes broad non-interactive test runs across repo worktrees, shows truthful holder/status metadata, and publishes exact-commit reusable baseline results without regressing existing public test command behavior.

**Architecture:** Put all public test npm scripts behind one TypeScript dispatcher that preserves each command's current behavior, routes only broad non-interactive test phases through a repo-shared `flock` gate rooted in the Git common dir, and records advisory holder/result JSON next to that lock. `flock` is the only correctness primitive; metadata and baseline files are advisory, and direct raw `vitest` bypasses are handled by package ergonomics plus repo instructions rather than a second process-detection truth source.

**Tech Stack:** Node.js, TypeScript, `tsx`, `child_process`, `fs/promises`, Git CLI, `flock`, Vitest.

---

## Strategy Gate

- The real problem is broad one-shot test collisions, not generic process discovery. The design therefore makes sanctioned broad runs mutually exclusive with `flock` and removes raw-process scanning from gating decisions entirely.
- Preserve public command contracts instead of bolting a guard onto one script. `npm test` stays the one-shot full suite, `npm run test:server` keeps its current default watch behavior, `npm run test:watch` and `npm run test:ui` stay interactive and ungated, and forwarded test-selection args still work.
- Freeze baseline reuse rules now so they stop reopening in review: a reusable baseline must match `commandKey + commit + cleanWorktree + nodeVersion + platform` and must have `exitCode === 0`.
- Make the sanctioned path easy and accidental bypasses unlikely by routing public npm scripts through the dispatcher and hiding raw Vitest invocations behind private underscore-prefixed scripts plus updated agent docs.
- This is a single-cutover plan. There is no temporary file-lock fallback, no phased rollout, and no process-heuristic blocker.

## Design Decisions

- Shared gate state lives under `$(git rev-parse --git-common-dir)/freshell-test-gate/`.
- Files in that directory:
  - `broad-tests.lock`: kernel lock file used only with `flock`
  - `holder.json`: advisory metadata for the currently running sanctioned broad test phase
  - `results.json`: bounded newest-first history of recent broad-command results
- Holder metadata includes:
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
- `npm run check` and `npm run verify` keep their pre-test `typecheck`/`build` work outside the lock; only the broad test phase is serialized so an active-holder message remains literally true.
- `npm run test:status` is added as a read-only status command. It never waits and never starts tests; it performs the same immediate non-blocking `flock` probe the runners use, then prints holder and reusable-baseline information.
- `npm run test:server` remains default-watch. Only explicit one-shot server runs (`--run` or a non-watch raw script) may enter the gate, and only when they are broad rather than file-targeted.
- Direct `npx vitest run` remains a conscious unsupported bypass. The end-state relies on public-script routing, private raw scripts, and repo guidance instead of fragile runtime policing.

### Task 1: Add shared Git common-dir resolution for repo-wide gate state

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/server/coding-cli/utils.ts`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/coding-cli/git-metadata.test.ts`

**Step 1: Write the failing tests for worktree-aware common-dir lookup**

Extend `test/unit/server/coding-cli/git-metadata.test.ts` with coverage that proves the implementation can resolve both checkout root and Git common dir from a linked worktree:

```ts
import {
  clearRepoRootCache,
  resolveGitBranchAndDirty,
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

Expected: FAIL because `resolveGitCommonDir` is not implemented.

**Step 3: Implement the minimal common-dir helper**

Add a cached helper beside the existing repo-root helpers in `server/coding-cli/utils.ts`:

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

### Task 2: Build the gate-state and invocation-planning module with unit coverage

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-shared.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-gate-shared.test.ts`

**Step 1: Write the failing unit tests for gate paths, metadata, baseline trust, and invocation classification**

Create `test/unit/server/test-gate-shared.test.ts` with pure tests for:
- gate-path resolution under the Git common dir
- summary derivation and fallback behavior
- reusable-baseline eligibility keyed by `commandKey + commit + cleanWorktree + nodeVersion + platform`
- bounded result-history retention
- invocation planning for `test`, `test:all`, `test:unit`, `test:client`, `test:integration`, `test:coverage`, `check`, `verify`, `test:server`, and `status`
- routing explicit file targets to `client`, `server`, or `both`

Seed the file with cases like:

```ts
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildGatePaths,
  classifyInvocation,
  deriveSummary,
  findReusableBaseline,
  pushResultHistory,
  type TestResultRecord,
} from '../../../scripts/test-gate-shared.js'

describe('test-gate-shared', () => {
  it('roots gate files in the shared git common dir', () => {
    expect(buildGatePaths('/repo/.git')).toEqual({
      rootDir: path.join('/repo/.git', 'freshell-test-gate'),
      lockFile: path.join('/repo/.git', 'freshell-test-gate', 'broad-tests.lock'),
      holderFile: path.join('/repo/.git', 'freshell-test-gate', 'holder.json'),
      resultsFile: path.join('/repo/.git', 'freshell-test-gate', 'results.json'),
    })
  })

  it('reuses only exact-commit clean baselines from the same runtime identity', () => {
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

  it('keeps npm run test:server default-watch and only gates explicit broad one-shot runs', () => {
    expect(classifyInvocation('server', [])).toEqual({ mode: 'interactive-watch' })
    expect(classifyInvocation('server', ['test/server/ws-protocol.test.ts'])).toEqual({
      mode: 'interactive-watch',
      forwardedArgs: ['test/server/ws-protocol.test.ts'],
    })
    expect(classifyInvocation('server', ['--run'])).toEqual({
      mode: 'broad-run',
      runKey: 'server',
      targetConfigs: ['server'],
    })
  })

  it('treats explicit file targets on npm test as narrowed runs without the gate', () => {
    expect(classifyInvocation('full', ['test/unit/client/components/App.test.tsx'])).toEqual({
      mode: 'narrowed-run',
      runKey: 'full',
      targetConfigs: ['client'],
      forwardedArgs: ['test/unit/client/components/App.test.tsx'],
    })
  })
})
```

**Step 2: Run the targeted unit test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-gate-shared.test.ts
```

Expected: FAIL because the module does not exist yet.

**Step 3: Implement the shared gate helpers**

Create `scripts/test-gate-shared.ts` with:
- `buildGatePaths(commonDir)`
- `deriveSummary({ cliSummary, envSummary, branch, commandKey })`
- `buildHolderRecord(context)`
- `readResultHistory()` / `writeResultHistory()` using atomic temp-file rename
- `findReusableBaseline(history, query)`
- `pushResultHistory(history, record, limit = 20)`
- `classifyInvocation(commandKey, forwardedArgs)` that returns one of:
  - `status`
  - `interactive-watch`
  - `broad-run`
  - `narrowed-run`

Use a concrete structure like:

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

export function classifyInvocation(commandKey: PublicCommandKey, forwardedArgs: string[]): InvocationPlan {
  if (commandKey === 'status') return { mode: 'status' }
  if (commandKey === 'server' && !forwardedArgs.includes('--run')) {
    return { mode: 'interactive-watch', forwardedArgs }
  }

  const explicitFiles = forwardedArgs.filter((arg) => arg.endsWith('.test.ts') || arg.endsWith('.test.tsx'))
  if (explicitFiles.length > 0) {
    return {
      mode: 'narrowed-run',
      runKey: commandKey === 'all' ? 'full' : commandKey,
      targetConfigs: resolveTargetConfigs(explicitFiles),
      forwardedArgs,
    }
  }

  return {
    mode: 'broad-run',
    runKey: commandKey === 'all' ? 'full' : commandKey,
    targetConfigs: defaultTargetConfigs(commandKey),
    forwardedArgs,
  }
}
```

Keep the classification rules strict:
- explicit test files are narrowed
- broad selectors like `-t`, `--changed`, directories such as `test/server`, or no selector at all remain broad
- `test:server` only becomes one-shot when `--run` is present

**Step 4: Re-run the targeted unit test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-gate-shared.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-shared.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-gate-shared.test.ts
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add test gate shared helpers"
```

### Task 3: Implement the `flock`-backed dispatcher and end-to-end gate behavior

**Files:**
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/test-command.test.ts`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-gate/fake-runner.mjs`

**Step 1: Write the failing integration test for lock truth, waiting, status, stale metadata tolerance, and command semantics**

Create `test/server/test-command.test.ts` that exercises the real dispatcher with a temp Git repo and the fixture runner. Cover:
- non-blocking `status` reporting idle when the lock is free even if `holder.json` is stale
- broad sanctioned run writing holder metadata, acquiring the lock, and recording a result
- second broad sanctioned run waiting, printing the active holder summary, then starting after the first run exits
- timeout after the configured wait limit
- `npm run check` and `npm run verify` behavior modeled as pre-steps outside the lock and gated broad test phase inside it
- `test:server` default watch remaining ungated
- `test:server -- --run` broad one-shot using the gate
- narrowed `npm test -- test/...file.test.ts` bypassing the gate and routing only the needed config(s)

Use a test shape like:

```ts
it('status ignores stale holder metadata when flock is free', async () => {
  await fs.mkdir(paths.rootDir, { recursive: true })
  await fs.writeFile(paths.holderFile, JSON.stringify({ summary: 'stale holder' }), 'utf8')

  const result = await runCli(['status'], env)

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('No sanctioned broad test run is active')
})

it('serializes broad runs and reports the active holder while waiting', async () => {
  const first = startCli(['full', '--summary', 'First run'], {
    ...env,
    FRESHELL_TEST_GATE_FAKE_MODE: 'hold',
  })
  await waitForOutput(first, 'FAKE_RUNNER_STARTED')

  const second = await runCli(['full', '--summary', 'Second run'], {
    ...env,
    FRESHELL_TEST_GATE_POLL_MS: '10',
    FRESHELL_TEST_GATE_WAIT_MS: '200',
  })

  expect(second.stdout).toContain('First run')
  expect(second.stdout).toContain('waiting for the active test run to finish')
})
```

**Step 2: Run the integration test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/test-command.test.ts
```

Expected: FAIL because the dispatcher and fixture runner do not exist.

**Step 3: Implement the dispatcher and locked-run path**

Create `scripts/test-command.ts` as the single public entrypoint for test commands. The script should:
- parse wrapper flags such as `--summary`
- resolve Git common dir, repo root, branch, and dirty state
- classify the invocation with `classifyInvocation`
- run `typecheck`/`build` pre-steps outside the lock for `check`/`verify`
- use `flock` for broad-run phases only
- record `holder.json` only while the broad run is actually active
- append result records to `results.json`
- provide `status` output without waiting

Use a structure like:

```ts
async function runBroadPhaseWithGate(plan: BroadRunPlan, context: RunContext): Promise<number> {
  const deadline = Date.now() + context.waitMs

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const attempt = await spawnLockedRun(plan, context)
    if (attempt.kind === 'started') return attempt.exitCode

    if (Date.now() >= deadline) {
      console.error(renderTimeoutMessage(attempt.holder))
      return 1
    }

    console.error(renderWaitingMessage(attempt.holder, attempt.reusableBaseline))
    await sleep(context.pollMs)
  }
}

async function main(): Promise<void> {
  const { commandKey, summary, forwardedArgs } = parseCli(process.argv.slice(2))
  const context = await buildRunContext(commandKey, summary)
  const plan = classifyInvocation(commandKey, forwardedArgs)

  if (plan.mode === 'status') process.exit(await runStatus(context))
  if (plan.mode === 'interactive-watch') process.exit(await runInteractive(plan, context))
  if (plan.mode === 'narrowed-run') process.exit(await runNarrowed(plan, context))
  process.exit(await runBroadPhaseWithGate(plan, context))
}
```

Implementation details:
- `spawnLockedRun` should exec `flock -n <lockFile> node ... test-command.ts --locked-run ...`
- `--locked-run` is internal and never used from `package.json`
- the locked path writes `holder.json`, executes the private raw npm scripts for the selected config(s), writes a result record, then removes `holder.json` in a `finally`
- if `flock` is missing, fail fast with an actionable error instead of falling back to a pseudo-lock
- keep `status` truthful by probing `flock -n` directly before trusting `holder.json`

Create `test/fixtures/test-gate/fake-runner.mjs` so tests can simulate success, failure, and long-running commands without invoking Vitest itself.

**Step 4: Re-run the integration test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/test-command.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/server/test-command.test.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/fixtures/test-gate/fake-runner.mjs
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): add flock-backed test dispatcher"
```

### Task 4: Wire the public npm scripts, private raw scripts, and documentation

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/package.json`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md`
- Modify: `/home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md`
- Create: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-script-contract.test.ts`

**Step 1: Write the failing script-contract test**

Create `test/unit/server/test-script-contract.test.ts` that reads `package.json` and asserts the sanctioned public scripts all route through the dispatcher, while interactive scripts remain direct:

```ts
import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json' with { type: 'json' }

describe('package test scripts', () => {
  it('routes sanctioned public test scripts through the dispatcher', () => {
    expect(pkg.scripts.test).toBe('tsx scripts/test-command.ts full')
    expect(pkg.scripts['test:all']).toBe('tsx scripts/test-command.ts all')
    expect(pkg.scripts.check).toBe('tsx scripts/test-command.ts check')
    expect(pkg.scripts.verify).toBe('tsx scripts/test-command.ts verify')
    expect(pkg.scripts['test:coverage']).toBe('tsx scripts/test-command.ts coverage')
    expect(pkg.scripts['test:status']).toBe('tsx scripts/test-command.ts status')
  })

  it('keeps interactive server/watch commands ungated by default', () => {
    expect(pkg.scripts['test:server']).toBe('tsx scripts/test-command.ts server')
    expect(pkg.scripts['test:watch']).toBe('vitest')
    expect(pkg.scripts['test:ui']).toBe('vitest --ui')
  })
})
```

**Step 2: Run the targeted unit test and verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-script-contract.test.ts
```

Expected: FAIL because the scripts have not been rewired yet.

**Step 3: Rewire scripts and update repo guidance**

Update `package.json` so public test commands call the dispatcher and raw commands move behind private underscore-prefixed scripts, for example:

```json
{
  "scripts": {
    "test": "tsx scripts/test-command.ts full",
    "test:all": "tsx scripts/test-command.ts all",
    "check": "tsx scripts/test-command.ts check",
    "verify": "tsx scripts/test-command.ts verify",
    "test:unit": "tsx scripts/test-command.ts unit",
    "test:client": "tsx scripts/test-command.ts client",
    "test:integration": "tsx scripts/test-command.ts integration",
    "test:coverage": "tsx scripts/test-command.ts coverage",
    "test:server": "tsx scripts/test-command.ts server",
    "test:status": "tsx scripts/test-command.ts status",
    "_test:full:client": "vitest run",
    "_test:full:server": "vitest run --config vitest.server.config.ts",
    "_test:server:watch": "vitest --config vitest.server.config.ts",
    "_test:server:run": "vitest run --config vitest.server.config.ts"
  }
}
```

Update `AGENTS.md` and `docs/skills/testing.md` to document:
- `npm test` is a gated full-suite one-shot run
- `npm run test:status` shows the active holder and reusable baseline
- `FRESHELL_TEST_SUMMARY="..." npm test` is the preferred summary pattern
- `npm run test:server` remains watch by default
- direct `npx vitest run` broad suites are unsupported bypasses

Also fix the existing incorrect doc claim that `npm test` is watch mode.

**Step 4: Re-run the targeted unit test and verify pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run test/unit/server/test-script-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/package.json \
  /home/user/code/freshell/.worktrees/test-run-gate/AGENTS.md \
  /home/user/code/freshell/.worktrees/test-run-gate/docs/skills/testing.md \
  /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-script-contract.test.ts
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "feat(testing): route public test scripts through gate"
```

### Task 5: Verify the single-cutover behavior end to end

**Files:**
- Modify if needed: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-shared.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/test-run-gate/test/server/test-command.test.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-gate-shared.test.ts`

**Step 1: Run the focused unit and integration suites**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run \
  test/unit/server/coding-cli/git-metadata.test.ts \
  test/unit/server/test-gate-shared.test.ts \
  test/unit/server/test-script-contract.test.ts
```

Expected: PASS.

**Step 2: Run the dispatcher integration suite**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
npx vitest run --config vitest.server.config.ts test/server/test-command.test.ts
```

Expected: PASS.

**Step 3: Run the gated `check` command**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
FRESHELL_TEST_SUMMARY="Verify gated check path" npm run check
```

Expected: PASS. Output should show the sanctioned test gate only around the broad test phase, not around typecheck.

**Step 4: Run the gated `verify` command**

Run:

```bash
cd /home/user/code/freshell/.worktrees/test-run-gate
FRESHELL_TEST_SUMMARY="Verify gated build and test path" npm run verify
```

Expected: PASS. Output should show the same gate behavior after the build phase completes.

**Step 5: Commit any verification fixes**

If verification required follow-up edits, commit them:

```bash
git -C /home/user/code/freshell/.worktrees/test-run-gate add \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-command.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/scripts/test-gate-shared.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/server/test-command.test.ts \
  /home/user/code/freshell/.worktrees/test-run-gate/test/unit/server/test-gate-shared.test.ts
git -C /home/user/code/freshell/.worktrees/test-run-gate commit -m "fix(testing): polish gated test command behavior"
```

If all verification passes without further edits, leave the worktree clean and do not create an empty commit.
