import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildReusableSuccessKey,
  type HolderRecord,
  type LatestRunRecord,
  type ReusableSuccessRecord,
} from '../../../../scripts/testing/coordinator-schema.js'
import {
  clearHolderIfRunIdMatches,
  getCoordinatorStoreDir,
  readCommandRuns,
  readHolder,
  readReusableSuccesses,
  readSuiteRuns,
  recordCommandResult,
  recordReusableSuccess,
  recordSuiteResult,
  writeHolder,
} from '../../../../scripts/testing/coordinator-store.js'

let tempDir: string
let storeDir: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-coordinator-store-'))
  storeDir = getCoordinatorStoreDir(path.join(tempDir, '.git'))
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

function createHolderRecord(overrides: Partial<HolderRecord> = {}): HolderRecord {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    summary: 'Nightly full suite',
    summarySource: 'env',
    startedAt: '2026-03-11T00:00:00.000Z',
    pid: 1234,
    hostname: 'test-host',
    username: 'test-user',
    entrypoint: {
      commandKey: 'test',
      suiteKey: 'full-suite',
    },
    command: {
      display: 'npm test',
      argv: ['test'],
    },
    repo: {
      invocationCwd: '/worktrees/test-run-gate',
      checkoutRoot: '/worktrees/test-run-gate',
      repoRoot: '/repo',
      commonDir: '/repo/.git',
      worktreePath: '/worktrees/test-run-gate',
      branch: 'feature/test-run-gate',
      commit: 'abc123',
      isDirty: false,
    },
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    agent: {
      kind: 'codex',
      sessionId: 'session-1',
      threadId: 'thread-1',
    },
    ...overrides,
  }
}

function createLatestRunRecord(overrides: Partial<LatestRunRecord> = {}): LatestRunRecord {
  const holder = createHolderRecord()
  return {
    runId: holder.runId,
    summary: holder.summary,
    summarySource: holder.summarySource,
    startedAt: holder.startedAt,
    finishedAt: '2026-03-11T00:02:00.000Z',
    durationMs: 120_000,
    outcome: 'success',
    exitCode: 0,
    entrypoint: holder.entrypoint,
    command: holder.command,
    repo: holder.repo,
    runtime: holder.runtime,
    agent: holder.agent,
    ...overrides,
  }
}

function createReusableSuccessRecord(overrides: Partial<ReusableSuccessRecord> = {}): ReusableSuccessRecord {
  const base = createLatestRunRecord()
  return {
    ...base,
    reusableKey: buildReusableSuccessKey({
      suiteKey: 'full-suite',
      commit: base.repo.commit,
      isDirty: base.repo.isDirty,
      nodeVersion: base.runtime.nodeVersion,
      platform: base.runtime.platform,
      arch: base.runtime.arch,
    }),
    ...overrides,
  } as ReusableSuccessRecord
}

describe('coordinator-store', () => {
  it('treats missing advisory files as empty state', async () => {
    expect(await readHolder(storeDir)).toBeUndefined()
    expect(await readCommandRuns(storeDir)).toEqual({
      schemaVersion: 1,
      byKey: {},
    })
    expect(await readSuiteRuns(storeDir)).toEqual({
      schemaVersion: 1,
      byKey: {},
    })
    expect(await readReusableSuccesses(storeDir)).toEqual({
      schemaVersion: 1,
      byReusableKey: {},
    })
  })

  it('writes holder state atomically and clears it only when the runId matches', async () => {
    const holder = createHolderRecord()
    await writeHolder(storeDir, holder)

    expect(await readHolder(storeDir)).toEqual(holder)

    await clearHolderIfRunIdMatches(storeDir, 'other-run')
    expect(await readHolder(storeDir)).toEqual(holder)

    await clearHolderIfRunIdMatches(storeDir, holder.runId)
    expect(await readHolder(storeDir)).toBeUndefined()

    const entries = await fsp.readdir(storeDir)
    expect(entries.some((entry) => entry.includes('.tmp'))).toBe(false)
  })

  it('tolerates corrupt advisory JSON by treating it as missing state', async () => {
    await fsp.mkdir(storeDir, { recursive: true })
    await Promise.all([
      fsp.writeFile(path.join(storeDir, 'holder.json'), '{not json'),
      fsp.writeFile(path.join(storeDir, 'command-runs.json'), '{not json'),
      fsp.writeFile(path.join(storeDir, 'suite-runs.json'), '{not json'),
      fsp.writeFile(path.join(storeDir, 'reusable-success.json'), '{not json'),
    ])

    expect(await readHolder(storeDir)).toBeUndefined()
    expect(await readCommandRuns(storeDir)).toEqual({
      schemaVersion: 1,
      byKey: {},
    })
    expect(await readSuiteRuns(storeDir)).toEqual({
      schemaVersion: 1,
      byKey: {},
    })
    expect(await readReusableSuccesses(storeDir)).toEqual({
      schemaVersion: 1,
      byReusableKey: {},
    })
  })

  it('records latest command and suite results without erasing an older reusable clean success', async () => {
    const success = createReusableSuccessRecord()
    await recordReusableSuccess(storeDir, success)

    const failure = createLatestRunRecord({
      runId: 'run-2',
      finishedAt: '2026-03-11T00:05:00.000Z',
      durationMs: 30_000,
      outcome: 'failure',
      exitCode: 23,
    })

    await recordCommandResult(storeDir, {
      ...failure,
      entrypoint: {
        commandKey: 'verify',
        suiteKey: 'full-suite',
      },
      command: {
        display: 'npm run verify',
        argv: ['run', 'verify'],
      },
    })
    await recordSuiteResult(storeDir, failure)

    const commandRuns = await readCommandRuns(storeDir)
    const suiteRuns = await readSuiteRuns(storeDir)
    const reusable = await readReusableSuccesses(storeDir)

    expect(commandRuns.byKey.verify).toMatchObject({
      outcome: 'failure',
      exitCode: 23,
    })
    expect(suiteRuns.byKey['full-suite']).toMatchObject({
      outcome: 'failure',
      exitCode: 23,
    })
    expect(reusable.byReusableKey[success.reusableKey]).toEqual(success)
  })

  it('serializes concurrent command result writes so neither latest entry is lost', async () => {
    const originalRename = fsp.rename.bind(fsp)
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return originalRename(args[0] as Parameters<typeof fsp.rename>[0], args[1] as Parameters<typeof fsp.rename>[1])
    })

    const entries = Array.from({ length: 10 }, (_, index) => ({
      commandKey: `command-${index}`,
      runId: `run-${index}`,
    }))

    try {
      await Promise.all(entries.map((entry) => recordCommandResult(storeDir, createLatestRunRecord({
        runId: entry.runId,
        entrypoint: {
          commandKey: entry.commandKey,
          suiteKey: 'full-suite',
        },
      }))))
    } finally {
      renameSpy.mockRestore()
    }

    const commandRuns = await readCommandRuns(storeDir)
    expect(Object.keys(commandRuns.byKey).sort()).toEqual(entries
      .map((entry) => entry.commandKey)
      .sort())
  })

  it('does not reclaim a live same-process lock just because its JSON metadata looks stale', async () => {
    const originalRename = fsp.rename.bind(fsp)
    let renameCallCount = 0
    let releaseFirstRename: (() => void) | undefined
    const firstRenameBlocked = new Promise<void>((resolve) => {
      releaseFirstRename = resolve
    })
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (...args) => {
      renameCallCount += 1
      if (renameCallCount === 1) {
        await firstRenameBlocked
      }
      return originalRename(args[0] as Parameters<typeof fsp.rename>[0], args[1] as Parameters<typeof fsp.rename>[1])
    })

    const lockPath = path.join(storeDir, 'command-runs.json.lock')
    const first = recordCommandResult(storeDir, createLatestRunRecord({
      runId: 'run-locked-1',
      entrypoint: {
        commandKey: 'command-locked-1',
        suiteKey: 'full-suite',
      },
    }))

    await waitForCondition(async () => {
      try {
        await fsp.access(lockPath)
        return true
      } catch {
        return false
      }
    })

    await fsp.writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: 'test-host',
      startedAt: '1970-01-01T00:00:00.000Z',
    }))

    const second = recordCommandResult(storeDir, createLatestRunRecord({
      runId: 'run-locked-2',
      entrypoint: {
        commandKey: 'command-locked-2',
        suiteKey: 'full-suite',
      },
    }))

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(renameCallCount).toBe(1)

    releaseFirstRename?.()

    try {
      await Promise.all([first, second])
    } finally {
      renameSpy.mockRestore()
    }

    const commandRuns = await readCommandRuns(storeDir)
    expect(Object.keys(commandRuns.byKey).sort()).toEqual([
      'command-locked-1',
      'command-locked-2',
    ])
  })

  it('reclaims an aged readable store lock even when its recorded pid is currently alive', async () => {
    const liveForeignPid = process.ppid > 1 ? process.ppid : 1
    await fsp.mkdir(storeDir, { recursive: true })
    await fsp.writeFile(path.join(storeDir, 'command-runs.json.lock'), JSON.stringify({
      pid: liveForeignPid,
      hostname: 'test-host',
      startedAt: '1970-01-01T00:00:00.000Z',
    }))

    await expect(recordCommandResult(storeDir, createLatestRunRecord({
      runId: 'run-stale-lock',
      entrypoint: {
        commandKey: 'check',
        suiteKey: 'full-suite',
      },
    }))).resolves.toBeUndefined()

    expect((await readCommandRuns(storeDir)).byKey.check).toMatchObject({
      runId: 'run-stale-lock',
    })
  }, 15_000)
})
