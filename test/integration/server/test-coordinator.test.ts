import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildCoordinatorEndpoint, tryListen } from '../../../scripts/testing/coordinator-endpoint.js'
import {
  buildReusableSuccessKey,
  type LatestRunRecord,
  type ReusableSuccessRecord,
} from '../../../scripts/testing/coordinator-schema.js'
import {
  getCoordinatorStoreDir,
  readCommandRuns,
  readHolder,
  readReusableSuccesses,
  readSuiteRuns,
  recordCommandResult,
  recordReusableSuccess,
  recordSuiteResult,
} from '../../../scripts/testing/coordinator-store.js'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const require = createRequire(import.meta.url)
const TSX_CLI = require.resolve('tsx/cli')
const COORDINATOR_SCRIPT = path.join(REPO_ROOT, 'scripts', 'testing', 'test-coordinator.ts')
const FAKE_UPSTREAM = path.join(REPO_ROOT, 'test', 'fixtures', 'testing', 'fake-coordinated-workload.mjs')

type CoordinatorHandle = {
  child: ChildProcessWithoutNullStreams
  stdout: string
  stderr: string
  output: string
}

type RepoFixture = {
  baseDir: string
  repoRoot: string
  checkoutRoot: string
  worktreePath: string
  commonDir: string
  storeDir: string
  headCommit: string
  branch: string
  cleanup: () => Promise<void>
  markDirty: () => Promise<void>
  cleanWorktree: () => Promise<void>
}

const activeChildren: CoordinatorHandle[] = []
const activeFixtureDirs: string[] = []

beforeEach(() => {
  activeChildren.length = 0
  activeFixtureDirs.length = 0
})

afterEach(async () => {
  await Promise.all(activeChildren.map((handle) => stopChild(handle)))
  await Promise.all(activeFixtureDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => {})))
})

function createChildEnv(cwd: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'FRESHELL_TEST_COORDINATOR_ACTIVE',
    'VITEST',
    'VITEST_POOL_ID',
    'VITEST_WORKER_ID',
    'PW_TEST_LOGS_DIR',
  ]) {
    delete env[key]
  }
  return {
    ...env,
    PWD: cwd,
    INIT_CWD: cwd,
    FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM: FAKE_UPSTREAM,
    FRESHELL_TEST_COORDINATOR_REPO_ROOT: REPO_ROOT,
    ...overrides,
  }
}

function spawnCoordinator(
  cwd: string,
  commandKey: string,
  forwardedArgs: string[] = [],
  envOverrides: NodeJS.ProcessEnv = {},
): CoordinatorHandle {
  const args = [TSX_CLI, COORDINATOR_SCRIPT, 'run', commandKey]
  if (forwardedArgs.length > 0) {
    args.push('--', ...forwardedArgs)
  }

  const child = spawn(process.execPath, args, {
    cwd,
    env: createChildEnv(cwd, envOverrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const handle: CoordinatorHandle = {
    child,
    stdout: '',
    stderr: '',
    output: '',
  }
  child.stdout.on('data', (chunk: Buffer) => {
    handle.stdout += chunk.toString()
    handle.output = `${handle.stdout}${handle.stderr}`
  })
  child.stderr.on('data', (chunk: Buffer) => {
    handle.stderr += chunk.toString()
    handle.output = `${handle.stdout}${handle.stderr}`
  })
  activeChildren.push(handle)
  return handle
}

async function runStatus(cwd: string, envOverrides: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; output: string }> {
  const handle = spawn(process.execPath, [TSX_CLI, COORDINATOR_SCRIPT, 'status'], {
    cwd,
    env: createChildEnv(cwd, envOverrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  let stdout = ''
  let stderr = ''
  handle.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  handle.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const [code] = await once(handle, 'exit') as [number | null]
  return {
    code,
    output: `${stdout}${stderr}`,
  }
}

async function waitForOutput(handle: CoordinatorHandle, pattern: RegExp, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pattern.test(handle.output)) {
      return handle.output
    }
    if (handle.child.exitCode !== null) {
      break
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for output ${pattern}. Output so far:\n${handle.output}`)
}

async function waitForExit(handle: CoordinatorHandle, timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  if (handle.child.exitCode !== null) {
    return {
      code: handle.child.exitCode,
      signal: handle.child.signalCode,
      output: handle.output,
    }
  }

  const result = await Promise.race([
    once(handle.child, 'exit').then(([code, signal]) => ({ code, signal: signal as NodeJS.Signals | null })),
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for process exit. Output:\n${handle.output}`)
    }),
  ])

  return {
    ...result,
    output: handle.output,
  }
}

async function stopChild(handle: CoordinatorHandle): Promise<void> {
  const index = activeChildren.indexOf(handle)
  if (index >= 0) {
    activeChildren.splice(index, 1)
  }

  if (handle.child.exitCode !== null || handle.child.killed) {
    return
  }

  handle.child.kill('SIGTERM')
  try {
    await Promise.race([
      once(handle.child, 'exit'),
      delay(3_000),
    ])
  } catch {
    // ignore
  }

  if (handle.child.exitCode === null) {
    handle.child.kill('SIGKILL')
    await once(handle.child, 'exit').catch(() => {})
  }
}

async function readCaptureLines(captureFile: string) {
  const raw = await fsp.readFile(captureFile, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function createRepoFixture(options: { linkedWorktree?: boolean; dirty?: boolean } = {}): Promise<RepoFixture> {
  const linkedWorktree = options.linkedWorktree ?? true
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-coordinator-fixture-'))
  activeFixtureDirs.push(baseDir)

  const repoRoot = path.join(baseDir, 'repo')
  const worktreePath = linkedWorktree ? path.join(baseDir, 'repo-feature') : repoRoot
  const dirtyFile = path.join(worktreePath, 'dirty.txt')

  await initRepo(repoRoot, 'main')
  if (linkedWorktree) {
    await runGit(['worktree', 'add', '-b', 'feature/worktree', worktreePath], repoRoot)
  }

  if (options.dirty) {
    await fsp.writeFile(dirtyFile, 'dirty\n')
  }

  const headCommit = (await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])).stdout.trim()
  const branch = (await execFileAsync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const commonDir = path.join(repoRoot, '.git')
  const storeDir = getCoordinatorStoreDir(commonDir)

  return {
    baseDir,
    repoRoot,
    checkoutRoot: worktreePath,
    worktreePath,
    commonDir,
    storeDir,
    headCommit,
    branch,
    cleanup: async () => {
      await fsp.rm(baseDir, { recursive: true, force: true })
    },
    markDirty: async () => {
      await fsp.writeFile(dirtyFile, 'dirty\n')
    },
    cleanWorktree: async () => {
      await execFileAsync('git', ['-C', worktreePath, 'reset', '--hard', 'HEAD'])
      await execFileAsync('git', ['-C', worktreePath, 'clean', '-fd'])
    },
  }
}

async function initRepo(repoDir: string, branchName: string) {
  await fsp.mkdir(repoDir, { recursive: true })
  await runGit(['init'], repoDir)
  await runGit(['config', 'user.email', 'test@example.com'], repoDir)
  await runGit(['config', 'user.name', 'Freshell Test'], repoDir)
  await fsp.writeFile(path.join(repoDir, 'README.md'), '# test\n')
  await runGit(['add', 'README.md'], repoDir)
  await runGit(['commit', '-m', 'init'], repoDir)
  await runGit(['checkout', '-B', branchName], repoDir)
}

async function runGit(args: string[], cwd: string) {
  await execFileAsync('git', args, { cwd })
}

function buildReusableRecord(input: {
  commandKey: string
  suiteKey: string
  summary: string
  fixture: RepoFixture
  exitCode?: number
}): ReusableSuccessRecord {
  const runtime = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  }
  const record: LatestRunRecord = {
    runId: `seed-${input.commandKey}`,
    summary: input.summary,
    summarySource: 'env',
    startedAt: '2026-03-11T00:00:00.000Z',
    finishedAt: '2026-03-11T00:01:00.000Z',
    durationMs: 60_000,
    outcome: 'success',
    exitCode: input.exitCode ?? 0,
    entrypoint: {
      commandKey: input.commandKey,
      suiteKey: input.suiteKey,
    },
    command: {
      display: input.commandKey === 'test' ? 'npm test' : `npm run ${input.commandKey}`,
      argv: [input.commandKey],
    },
    repo: {
      invocationCwd: input.fixture.checkoutRoot,
      checkoutRoot: input.fixture.checkoutRoot,
      repoRoot: input.fixture.repoRoot,
      commonDir: input.fixture.commonDir,
      worktreePath: input.fixture.worktreePath,
      branch: input.fixture.branch,
      commit: input.fixture.headCommit,
      isDirty: false,
    },
    runtime,
    agent: {
      kind: 'codex',
      sessionId: 'seed-session',
      threadId: 'seed-thread',
    },
  }

  return {
    ...record,
    reusableKey: buildReusableSuccessKey({
      suiteKey: input.suiteKey,
      commit: input.fixture.headCommit,
      isDirty: false,
      nodeVersion: runtime.nodeVersion,
      platform: runtime.platform,
      arch: runtime.arch,
    }),
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('test coordinator CLI', () => {
  it('acquires the broad gate, publishes a truthful holder while active, and records a reusable full-suite baseline after success', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, 'capture.jsonl')
    const child = spawnCoordinator(
      fixture.checkoutRoot,
      'test',
      [],
      {
        FRESHELL_TEST_SUMMARY: 'Nightly full suite',
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
          'npm:test:balanced': { holdMs: 1_000 },
        }),
      },
    )

    const activeStatus = await waitForStatusOutput(fixture.checkoutRoot, /Nightly full suite/)
    expect(activeStatus.output).toContain('Nightly full suite')
    expect(activeStatus.output).toContain('commandKey: test')
    expect(activeStatus.output).toContain('suiteKey: full-suite')
    expect(activeStatus.output).toContain(fixture.branch)
    expect(activeStatus.output).toContain(fixture.worktreePath)
    expect(activeStatus.output).toContain('npm test')

    const exit = await waitForExit(child)
    expect(exit.code).toBe(0)

    const idleStatus = await runStatus(fixture.checkoutRoot)
    expect(idleStatus.code).toBe(0)
    expect(idleStatus.output).toContain('state: idle')

    expect(await readHolder(fixture.storeDir)).toBeUndefined()
    const commandRuns = await readCommandRuns(fixture.storeDir)
    const suiteRuns = await readSuiteRuns(fixture.storeDir)
    const reusableSuccesses = await readReusableSuccesses(fixture.storeDir)

    expect(commandRuns.byKey.test).toMatchObject({
      outcome: 'success',
    })
    expect(suiteRuns.byKey['full-suite']).toMatchObject({
      outcome: 'success',
    })
    const reusableKey = buildReusableSuccessKey({
      suiteKey: 'full-suite',
      commit: fixture.headCommit,
      isDirty: false,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    })
    expect(reusableSuccesses.byReusableKey[reusableKey]).toMatchObject({
      outcome: 'success',
    })
  })

  it('waits behind an active broad run, prints queued guidance and advisory baseline info, and still runs after the holder releases', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, 'capture.jsonl')
    const seeded = buildReusableRecord({
      commandKey: 'test',
      suiteKey: 'full-suite',
      summary: 'Previous clean baseline',
      fixture,
    })
    await recordReusableSuccess(fixture.storeDir, seeded)

    const first = spawnCoordinator(
      fixture.checkoutRoot,
      'test',
      [],
      {
        FRESHELL_TEST_SUMMARY: 'First broad run',
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        FRESHELL_TEST_COORDINATOR_POLL_MS: '50',
        FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
          'npm:test:balanced': { holdMs: 5_000 },
        }),
      },
    )
    await waitForRunningStatus(fixture.checkoutRoot, /running/)

    const second = spawnCoordinator(
      fixture.checkoutRoot,
      'test:all',
      [],
      {
        FRESHELL_TEST_SUMMARY: 'Queued broad run',
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        FRESHELL_TEST_COORDINATOR_POLL_MS: '50',
      },
    )

    const queuedOutput = await waitForOutput(second, /First broad run/)
    expect(queuedOutput).toMatch(/queued intentionally/i)
    expect(queuedOutput).toContain('First broad run')
    expect(queuedOutput).toContain(fixture.branch)
    expect(queuedOutput).toContain(fixture.worktreePath)
    expect(queuedOutput).toContain('npm test')
    expect(queuedOutput).toContain('Previous clean baseline')

    expect((await waitForExit(first)).code).toBe(0)
    expect((await waitForExit(second)).code).toBe(0)

    const commandRuns = await readCommandRuns(fixture.storeDir)
    expect(commandRuns.byKey['test:all']).toMatchObject({
      outcome: 'success',
    })
  })

  it('acquires the gate before running typecheck and only succeeds after both phases pass', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, 'capture.jsonl')
    const child = spawnCoordinator(
      fixture.checkoutRoot,
      'check',
      [],
      {
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
          'npm:typecheck': { stdout: 'TYPECHECK_MARKER\n', holdMs: 1_000 },
        }),
      },
    )

    await waitForOutput(child, /TYPECHECK_MARKER/)
    const prePhaseStatus = await waitForRunningStatus(fixture.checkoutRoot, /commandKey: check/)
    expect(prePhaseStatus.output).toContain('suiteKey: full-suite')

    const exit = await waitForExit(child)
    expect(exit.code).toBe(0)

    const captures = await readCaptureLines(captureFile)
    expect(captures.map((entry) => entry.selector)).toEqual([
      'npm:typecheck',
      'npm:test:balanced',
    ])
    const commandRuns = await readCommandRuns(fixture.storeDir)
    const suiteRuns = await readSuiteRuns(fixture.storeDir)
    expect(commandRuns.byKey.check).toMatchObject({ outcome: 'success' })
    expect(suiteRuns.byKey['full-suite']).toMatchObject({ outcome: 'success' })
  })

  it.each([
    {
      commandKey: 'check',
      prePhaseSelector: 'npm:typecheck',
    },
    {
      commandKey: 'verify',
      prePhaseSelector: 'npm:build',
    },
  ])(
    'waits to acquire the gate before running coordinated $commandKey pre-phases and refreshes holder metadata after queueing',
    async ({ commandKey, prePhaseSelector }) => {
      const fixture = await createRepoFixture({ linkedWorktree: true })
      const captureFile = path.join(fixture.baseDir, `${commandKey}-queue-refresh.jsonl`)
      const holder = spawnCoordinator(
        fixture.checkoutRoot,
        'test',
        [],
        {
          FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
          FRESHELL_TEST_COORDINATOR_POLL_MS: '50',
          FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
            'npm:test:balanced': { holdMs: 3_000 },
          }),
        },
      )

      await waitForRunningStatus(fixture.checkoutRoot, /commandKey: test/)

      const queued = spawnCoordinator(
        fixture.checkoutRoot,
        commandKey,
        [],
        {
          FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
          FRESHELL_TEST_COORDINATOR_POLL_MS: '50',
          FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
            'npm:test:balanced': { holdMs: 1_000 },
          }),
        },
      )

      await waitForOutput(queued, /queued intentionally/i, 15_000)
      await fixture.markDirty()

      const queuedCaptures = await readCaptureLines(captureFile)
      expect(queuedCaptures.map((entry) => entry.selector)).not.toContain(prePhaseSelector)

      expect((await waitForExit(holder)).code).toBe(0)
      await waitForRunningStatus(fixture.checkoutRoot, new RegExp(`commandKey: ${commandKey}`))

      const activeHolder = await readHolder(fixture.storeDir)
      expect(activeHolder).toMatchObject({
        entrypoint: {
          commandKey,
          suiteKey: 'full-suite',
        },
        repo: {
          isDirty: true,
        },
      })

      const exit = await waitForExit(queued)
      expect(exit.code).toBe(0)

      const latest = (await readCommandRuns(fixture.storeDir)).byKey[commandKey]
      expect(latest).toMatchObject({
        outcome: 'success',
        repo: {
          isDirty: true,
        },
      })
      expect(latest.durationMs).toBeLessThan(2_000)
    },
  )

  it('propagates a failing build exit code exactly and never claims the coordinated suite ran', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, 'capture.jsonl')
    const child = spawnCoordinator(
      fixture.checkoutRoot,
      'verify',
      [],
      {
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
          'npm:build': { exitCode: 23 },
        }),
      },
    )

    const exit = await waitForExit(child)
    expect(exit.code).toBe(23)
    expect(await readHolder(fixture.storeDir)).toBeUndefined()
    expect((await readSuiteRuns(fixture.storeDir)).byKey['full-suite']).toBeUndefined()

    const captures = await readCaptureLines(captureFile)
    expect(captures.map((entry) => entry.selector)).toEqual(['npm:build'])
  })

  it.each([
    {
      commandKey: 'check',
      forwardedArgs: ['test/server/ws-protocol.test.ts'],
      failingSelector: 'npm:typecheck',
      exitCode: 31,
    },
    {
      commandKey: 'verify',
      forwardedArgs: ['test/unit/client/components/Sidebar.test.tsx'],
      failingSelector: 'npm:build',
      exitCode: 32,
    },
  ])(
    'records focused $commandKey pre-phase failures without claiming a full-suite run',
    async ({ commandKey, forwardedArgs, failingSelector, exitCode }) => {
      const fixture = await createRepoFixture({ linkedWorktree: true })
      const captureFile = path.join(fixture.baseDir, `${commandKey}-focused-prephase.jsonl`)
      const child = spawnCoordinator(
        fixture.checkoutRoot,
        commandKey,
        forwardedArgs,
        {
          FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
          FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
            [failingSelector]: { exitCode },
          }),
        },
      )

      const exit = await waitForExit(child)
      expect(exit.code).toBe(exitCode)
      expect(await readHolder(fixture.storeDir)).toBeUndefined()
      expect((await readSuiteRuns(fixture.storeDir)).byKey['full-suite']).toBeUndefined()

      const latest = (await readCommandRuns(fixture.storeDir)).byKey[commandKey]
      expect(latest).toMatchObject({
        outcome: 'failure',
        exitCode,
        entrypoint: {
          commandKey,
        },
        command: {
          display: `npm run ${commandKey} -- ${forwardedArgs.join(' ')}`,
          argv: [commandKey, ...forwardedArgs],
        },
      })
      expect(latest.entrypoint.suiteKey).toBeUndefined()

      const captures = await readCaptureLines(captureFile)
      expect(captures.map((entry) => entry.selector)).toEqual([failingSelector])
    },
  )

  it.each([
    {
      commandKey: 'check',
      forwardedArgs: ['test/server/ws-protocol.test.ts'],
      prePhaseSelector: 'npm:typecheck',
      delegatedSelector: 'vitest:server:run --config vitest.server.config.ts test/server/ws-protocol.test.ts',
    },
    {
      commandKey: 'verify',
      forwardedArgs: ['test/unit/client/components/Sidebar.test.tsx'],
      prePhaseSelector: 'npm:build',
      delegatedSelector: 'vitest:default:run test/unit/client/components/Sidebar.test.tsx',
    },
  ])(
    'records focused successful $commandKey runs after pre-phases succeed',
    async ({ commandKey, forwardedArgs, prePhaseSelector, delegatedSelector }) => {
      const fixture = await createRepoFixture({ linkedWorktree: true })
      const captureFile = path.join(fixture.baseDir, `${commandKey}-focused-success.jsonl`)
      const child = spawnCoordinator(
        fixture.checkoutRoot,
        commandKey,
        forwardedArgs,
        {
          FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        },
      )

      const exit = await waitForExit(child)
      expect(exit.code).toBe(0)

      const latest = (await readCommandRuns(fixture.storeDir)).byKey[commandKey]
      expect(latest).toMatchObject({
        outcome: 'success',
        exitCode: 0,
        entrypoint: {
          commandKey,
        },
        command: {
          display: `npm run ${commandKey} -- ${forwardedArgs.join(' ')}`,
          argv: [commandKey, ...forwardedArgs],
        },
      })
      expect(latest.entrypoint.suiteKey).toBeUndefined()
      expect((await readSuiteRuns(fixture.storeDir)).byKey['full-suite']).toBeUndefined()

      const captures = await readCaptureLines(captureFile)
      expect(captures.map((entry) => entry.selector)).toEqual([
        prePhaseSelector,
        delegatedSelector,
      ])
    },
  )

  it.each([
    {
      commandKey: 'check',
      forwardedArgs: ['test/server/ws-protocol.test.ts'],
      prePhaseSelector: 'npm:typecheck',
      failingSelector: 'vitest:server:run --config vitest.server.config.ts test/server/ws-protocol.test.ts',
      exitCode: 41,
    },
    {
      commandKey: 'verify',
      forwardedArgs: ['test/unit/client/components/Sidebar.test.tsx'],
      prePhaseSelector: 'npm:build',
      failingSelector: 'vitest:default:run test/unit/client/components/Sidebar.test.tsx',
      exitCode: 42,
    },
  ])(
    'records focused $commandKey failures after successful pre-phases without claiming a full-suite run',
    async ({ commandKey, forwardedArgs, prePhaseSelector, failingSelector, exitCode }) => {
      const fixture = await createRepoFixture({ linkedWorktree: true })
      const captureFile = path.join(fixture.baseDir, `${commandKey}-focused-post-prephase-failure.jsonl`)
      const child = spawnCoordinator(
        fixture.checkoutRoot,
        commandKey,
        forwardedArgs,
        {
          FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
          FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
            [failingSelector]: { exitCode },
          }),
        },
      )

      const exit = await waitForExit(child)
      expect(exit.code).toBe(exitCode)
      expect(await readHolder(fixture.storeDir)).toBeUndefined()
      expect((await readSuiteRuns(fixture.storeDir)).byKey['full-suite']).toBeUndefined()

      const latest = (await readCommandRuns(fixture.storeDir)).byKey[commandKey]
      expect(latest).toMatchObject({
        outcome: 'failure',
        exitCode,
        entrypoint: {
          commandKey,
        },
        command: {
          display: `npm run ${commandKey} -- ${forwardedArgs.join(' ')}`,
          argv: [commandKey, ...forwardedArgs],
        },
      })
      expect(latest.entrypoint.suiteKey).toBeUndefined()

      const captures = await readCaptureLines(captureFile)
      expect(captures.map((entry) => entry.selector)).toEqual([
        prePhaseSelector,
        failingSelector,
      ])
    },
  )

  it('reports running-undescribed when the gate is live but holder metadata is missing or corrupt', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const endpoint = buildCoordinatorEndpoint(fixture.commonDir)
    const listener = await tryListen(endpoint)
    expect(listener.kind).toBe('listening')

    const latest = buildReusableRecord({
      commandKey: 'test',
      suiteKey: 'full-suite',
      summary: 'Seed latest success',
      fixture,
    })
    await recordCommandResult(fixture.storeDir, latest)
    await recordSuiteResult(fixture.storeDir, latest)
    await recordReusableSuccess(fixture.storeDir, latest)

    const missingHolderStatus = await runStatus(fixture.checkoutRoot)
    expect(missingHolderStatus.output).toContain('state: running-undescribed')
    expect(missingHolderStatus.output).toContain('Seed latest success')

    await fsp.mkdir(fixture.storeDir, { recursive: true })
    await fsp.writeFile(path.join(fixture.storeDir, 'holder.json'), '{not json')
    const corruptHolderStatus = await runStatus(fixture.checkoutRoot)
    expect(corruptHolderStatus.output).toContain('state: running-undescribed')

    await listener.close()
    const idleStatus = await runStatus(fixture.checkoutRoot)
    expect(idleStatus.output).toContain('state: idle')
  })

  it('preserves test:server help/watch behavior by default and coordinates only explicit broad --run', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, 'capture.jsonl')

    expect((await waitForExit(spawnCoordinator(
      fixture.checkoutRoot,
      'test:server',
      ['--help'],
      {
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
      },
    ))).code).toBe(0)

    expect((await waitForExit(spawnCoordinator(
      fixture.checkoutRoot,
      'test:server',
      ['--run'],
      {
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
      },
    ))).code).toBe(0)

    const captures = await readCaptureLines(captureFile)
    expect(captures.map((entry) => entry.selector)).toEqual([
      'vitest:server:--config vitest.server.config.ts --help',
      'vitest:server:--config vitest.server.config.ts --run',
    ])
    const suiteRuns = await readSuiteRuns(fixture.storeDir)
    expect(suiteRuns.byKey['server:all:run']).toMatchObject({
      outcome: 'success',
    })
  })

  it('falls back to the actual checkout when INIT_CWD is outside the repo for status and help passthroughs', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const outsideDir = path.join(fixture.baseDir, 'outside-init-cwd')
    const captureFile = path.join(fixture.baseDir, 'init-cwd-fallback.jsonl')
    await fsp.mkdir(outsideDir, { recursive: true })

    const status = await runStatus(fixture.checkoutRoot, {
      INIT_CWD: outsideDir,
    })
    expect(status.code).toBe(0)
    expect(status.output).toContain('state: idle')

    const help = await waitForExit(spawnCoordinator(
      fixture.checkoutRoot,
      'check',
      ['--help'],
      {
        INIT_CWD: outsideDir,
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
      },
    ))
    expect(help.code).toBe(0)
    expect(help.output).not.toContain('requires a git repository checkout')

    const captures = await readCaptureLines(captureFile)
    expect(captures.map((entry) => entry.selector)).toEqual([
      'vitest:default:run --help',
    ])
  })

  it('records coordinated forwarded-arg commands truthfully in holder and latest-run metadata', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, 'coordinated-forwarded-argv.jsonl')
    const child = spawnCoordinator(
      fixture.checkoutRoot,
      'test:server',
      ['--run'],
      {
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
          'vitest:server:--config vitest.server.config.ts --run': { holdMs: 1_000 },
        }),
      },
    )

    await waitForRunningStatus(fixture.checkoutRoot, /suiteKey: server:all:run/)

    const holder = await readHolder(fixture.storeDir)
    expect(holder).toMatchObject({
      entrypoint: {
        commandKey: 'test:server',
        suiteKey: 'server:all:run',
      },
      command: {
        display: 'npm run test:server -- --run',
        argv: ['test:server', '--run'],
      },
    })

    const exit = await waitForExit(child)
    expect(exit.code).toBe(0)

    const latest = (await readCommandRuns(fixture.storeDir)).byKey['test:server']
    expect(latest).toMatchObject({
      outcome: 'success',
      entrypoint: {
        commandKey: 'test:server',
        suiteKey: 'server:all:run',
      },
      command: {
        display: 'npm run test:server -- --run',
        argv: ['test:server', '--run'],
      },
    })
  })

  it('keeps focused and interactive commands immediate passthroughs even while a broad holder is active', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, 'capture.jsonl')
    const holder = spawnCoordinator(
      fixture.checkoutRoot,
      'test',
      [],
      {
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
          'npm:test:balanced': { holdMs: 20_000 },
        }),
      },
    )

    await waitForRunningStatus(fixture.checkoutRoot, /running/)

    const commands: Array<{ key: string; args: string[] }> = [
      { key: 'test:unit', args: ['test/unit/server/coding-cli/utils.test.ts'] },
      { key: 'test:client', args: ['--run', 'test/unit/client/components/Sidebar.test.tsx'] },
      { key: 'test', args: ['--watch'] },
      { key: 'test', args: ['--ui'] },
      { key: 'test:watch', args: ['--help'] },
      { key: 'test:ui', args: ['--help'] },
      { key: 'test:vitest', args: ['--config', 'vitest.server.config.ts', 'test/server/ws-protocol.test.ts'] },
    ]

    for (const command of commands) {
      const exit = await waitForExit(spawnCoordinator(
        fixture.checkoutRoot,
        command.key,
        command.args,
        {
          FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        },
      ))
      expect(exit.code).toBe(0)
      expect(holder.child.exitCode).toBeNull()
    }

    const captures = await readCaptureLines(captureFile)
    expect(captures.map((entry) => entry.selector)).toContain('vitest:default:run --watch')
    expect(captures.map((entry) => entry.selector)).toContain('vitest:default:run --ui')
    expect(captures.map((entry) => entry.selector)).not.toContain('vitest:server:run --config vitest.server.config.ts --watch')
    expect(captures.map((entry) => entry.selector)).not.toContain('vitest:server:run --config vitest.server.config.ts --ui')

    await stopChild(holder)
  })

  it('coordinates exact broad single-phase workloads and records their distinct suite keys', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const commands = ['test:coverage', 'test:unit', 'test:client', 'test:integration']

    for (const command of commands) {
      expect((await waitForExit(spawnCoordinator(fixture.checkoutRoot, command))).code).toBe(0)
    }

    const suiteRuns = await readSuiteRuns(fixture.storeDir)
    expect(Object.keys(suiteRuns.byKey).sort()).toEqual([
      'default:coverage',
      'default:test/unit',
      'default:test/unit/client',
      'server:test/server',
    ])
  })

  it.each([
    {
      commandKey: 'test',
      forwardedArgs: ['--bail', '1'],
      selectors: ['npm:test:balanced --bail 1'],
      expectedSuiteKey: 'full-suite',
      expectReusableSuccess: true,
    },
    {
      commandKey: 'check',
      forwardedArgs: ['--changed', 'origin/main'],
      selectors: [
        'npm:typecheck',
        'npm:test:balanced --changed origin/main',
      ],
      expectedSuiteKey: undefined,
      expectReusableSuccess: false,
    },
  ])('keeps broad composite $commandKey workloads coordinated when forwarded args stay cross-config', async ({
    commandKey,
    forwardedArgs,
    selectors,
    expectedSuiteKey,
    expectReusableSuccess,
  }) => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, `${commandKey}-broad-flags.jsonl`)

    const exit = await waitForExit(spawnCoordinator(
      fixture.checkoutRoot,
      commandKey,
      forwardedArgs,
      {
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
      },
    ))

    expect(exit.code).toBe(0)
    expect((await readCaptureLines(captureFile)).map((entry) => entry.selector)).toEqual(selectors)
    const latest = (await readCommandRuns(fixture.storeDir)).byKey[commandKey]
    expect(latest).toMatchObject({ outcome: 'success' })
    expect(latest.entrypoint.commandKey).toBe(commandKey)
    expect(latest.entrypoint.suiteKey).toBe(expectedSuiteKey)

    const suiteRuns = await readSuiteRuns(fixture.storeDir)
    if (expectedSuiteKey) {
      expect(suiteRuns.byKey[expectedSuiteKey]).toMatchObject({ outcome: 'success' })
    } else {
      expect(suiteRuns.byKey['full-suite']).toBeUndefined()
    }

    const reusableSuccesses = await readReusableSuccesses(fixture.storeDir)
    expect(Object.keys(reusableSuccesses.byReusableKey)).toHaveLength(expectReusableSuccess ? 1 : 0)

    if (!expectedSuiteKey) {
      const status = await runStatus(fixture.checkoutRoot)
      expect(status.output).not.toContain('latest-suite: full-suite')
      expect(status.output).not.toContain('reusable-summary:')
    }
  })

  it.each([
    {
      commandKey: 'test:unit',
      forwardedArgs: ['--reporter', 'dot'],
      suiteKey: 'default:test/unit',
      selectors: ['vitest:default:run test/unit --reporter dot'],
    },
    {
      commandKey: 'test:coverage',
      forwardedArgs: ['--bail', '1'],
      suiteKey: 'default:coverage',
      selectors: ['vitest:default:run --coverage --bail 1'],
    },
    {
      commandKey: 'test:server',
      forwardedArgs: ['--run', '--reporter', 'dot'],
      suiteKey: 'server:all:run',
      selectors: ['vitest:server:--config vitest.server.config.ts --run --reporter dot'],
    },
  ])('keeps broad single-phase $commandKey workloads coordinated when benign flags are forwarded', async ({
    commandKey,
    forwardedArgs,
    suiteKey,
    selectors,
  }) => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, `${commandKey.replaceAll(':', '-')}-single-phase-broad-flags.jsonl`)

    const exit = await waitForExit(spawnCoordinator(
      fixture.checkoutRoot,
      commandKey,
      forwardedArgs,
      {
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
      },
    ))

    expect(exit.code).toBe(0)
    expect((await readCaptureLines(captureFile)).map((entry) => entry.selector)).toEqual(selectors)
    expect((await readSuiteRuns(fixture.storeDir)).byKey[suiteKey]).toMatchObject({ outcome: 'success' })
    expect((await readCommandRuns(fixture.storeDir)).byKey[commandKey]).toMatchObject({
      outcome: 'success',
      entrypoint: {
        suiteKey,
      },
    })
  })

  it.each([
    {
      forwardedArgs: ['test'],
      selectors: ['npm:test:balanced test'],
      expectedSuiteKey: 'full-suite',
    },
    {
      forwardedArgs: ['test/unit'],
      selectors: ['npm:test:balanced test/unit'],
      expectedSuiteKey: undefined,
    },
    {
      forwardedArgs: ['test/integration'],
      selectors: ['npm:test:balanced test/integration'],
      expectedSuiteKey: undefined,
    },
  ])('splits cross-config composite directory selectors truthfully for %j', async ({
    forwardedArgs,
    selectors,
    expectedSuiteKey,
  }) => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, `cross-config-${forwardedArgs[0].replaceAll('/', '-')}.jsonl`)

    const exit = await waitForExit(spawnCoordinator(
      fixture.checkoutRoot,
      'test',
      forwardedArgs,
      {
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
      },
    ))

    expect(exit.code).toBe(0)
    expect((await readCaptureLines(captureFile)).map((entry) => entry.selector)).toEqual(selectors)

    const latest = (await readCommandRuns(fixture.storeDir)).byKey.test
    expect(latest).toMatchObject({ outcome: 'success' })
    expect(latest.entrypoint.commandKey).toBe('test')
    expect(latest.entrypoint.suiteKey).toBe(expectedSuiteKey)

    const suiteRuns = await readSuiteRuns(fixture.storeDir)
    if (expectedSuiteKey) {
      expect(suiteRuns.byKey[expectedSuiteKey]).toMatchObject({ outcome: 'success' })
    } else {
      expect(suiteRuns.byKey['full-suite']).toBeUndefined()
    }
  })

  it('shows the latest exact coordinated suite and matching reusable baseline in bare status output', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })

    expect((await waitForExit(spawnCoordinator(fixture.checkoutRoot, 'test:unit'))).code).toBe(0)

    const status = await runStatus(fixture.checkoutRoot)
    expect(status.code).toBe(0)
    expect(status.output).toContain('state: idle')
    expect(status.output).toContain('latest-suite: default:test/unit success exit=0')
    expect(status.output).toContain('reusable-summary:')
  })

  it('does not create reusable baselines for dirty worktree successes, but does after an exact clean rerun', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true, dirty: true })

    expect((await waitForExit(spawnCoordinator(fixture.checkoutRoot, 'test'))).code).toBe(0)
    expect(Object.keys((await readReusableSuccesses(fixture.storeDir)).byReusableKey)).toHaveLength(0)

    await fixture.cleanWorktree()
    expect((await waitForExit(spawnCoordinator(fixture.checkoutRoot, 'test'))).code).toBe(0)

    const reusableSuccesses = await readReusableSuccesses(fixture.storeDir)
    expect(Object.keys(reusableSuccesses.byReusableKey)).toHaveLength(1)
  })

  it('times out queued callers without killing the foreign holder or clearing its holder record', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })
    const captureFile = path.join(fixture.baseDir, 'capture.jsonl')
    const holder = spawnCoordinator(
      fixture.checkoutRoot,
      'test',
      [],
      {
        FRESHELL_TEST_SUMMARY: 'Long-running holder',
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify({
          'npm:test:balanced': { holdMs: 10_000 },
        }),
      },
    )

    await waitForRunningStatus(fixture.checkoutRoot, /running/)

    const waiting = spawnCoordinator(
      fixture.checkoutRoot,
      'test:all',
      [],
      {
        FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
        FRESHELL_TEST_COORDINATOR_POLL_MS: '50',
        FRESHELL_TEST_COORDINATOR_MAX_WAIT_MS: '200',
      },
    )

    const exit = await waitForExit(waiting)
    expect(exit.code).not.toBe(0)
    expect(exit.output).toMatch(/queued intentionally/i)

    const holderRecord = await readHolder(fixture.storeDir)
    expect(holder.child.exitCode).toBeNull()
    expect(holderRecord?.summary).toBe('Long-running holder')
    expect((await readCommandRuns(fixture.storeDir)).byKey['test:all']).toMatchObject({
      outcome: 'failure',
      exitCode: 124,
    })
    expect((await readSuiteRuns(fixture.storeDir)).byKey['full-suite']).toBeUndefined()

    await stopChild(holder)
  })

  it('rejects unknown coordinator run subcommands with a clean usage error', async () => {
    const fixture = await createRepoFixture({ linkedWorktree: true })

    const exit = await waitForExit(spawnCoordinator(fixture.checkoutRoot, 'bogus'))

    expect(exit.code).toBe(1)
    expect(exit.output).toContain('Unknown command key "bogus"')
    expect(exit.output).not.toContain('Cannot read properties')
  })

  it('publishes the coordinated workflow truthfully in AGENTS.md and docs/skills/testing.md', async () => {
    const agents = await fsp.readFile(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8')
    const docs = await fsp.readFile(path.join(REPO_ROOT, 'docs', 'skills', 'testing.md'), 'utf8')

    expect(agents).toContain('FRESHELL_TEST_SUMMARY')
    expect(agents).toContain('npm run test:status')
    expect(agents).toContain('npm run test:vitest -- ...')
    expect(agents).toMatch(/wait rather than kill a foreign holder/i)

    expect(docs).not.toContain('| `npm test` | Watch mode (re-runs on file changes) |')
    expect(docs).toContain('`test:unit` is the exact default-config `test/unit` workload')
    expect(docs).toContain('`test:integration` is the exact server-config `test/server` workload')
    expect(docs).toContain('`test:server` stays watch-capable by default and only coordinates explicit broad `--run`')
    expect(docs).toContain('prior successful baselines are advisory only')
    expect(docs).toContain('use `npm run test:vitest -- ...`')
  })
})

async function waitForRunningStatus(cwd: string, pattern: RegExp, timeoutMs = 5_000) {
  return waitForStatusOutput(cwd, pattern, timeoutMs)
}

async function waitForStatusOutput(cwd: string, pattern: RegExp, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  let lastOutput = ''

  while (Date.now() < deadline) {
    const status = await runStatus(cwd)
    lastOutput = status.output
    if (pattern.test(status.output)) {
      return status
    }
    await delay(50)
  }

  throw new Error(`Timed out waiting for status ${pattern}. Last output:\n${lastOutput}`)
}
