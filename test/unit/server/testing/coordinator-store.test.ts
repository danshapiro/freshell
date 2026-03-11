import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
})
