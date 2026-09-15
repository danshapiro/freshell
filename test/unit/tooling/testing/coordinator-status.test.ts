import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildReusableSuccessKey,
  type HolderRecord,
  type LatestRunRecord,
  type ReusableSuccessRecord,
  type UngatedRunRecord,
} from '../../../../scripts/testing/coordinator-schema.js'
import { buildCoordinatorEndpoint, tryListen } from '../../../../scripts/testing/coordinator-endpoint.js'
import { buildStatusView, renderStatusView } from '../../../../scripts/testing/coordinator-status.js'
import {
  getCoordinatorStoreDir,
  recordCommandResult,
  recordReusableSuccess,
  clearUngatedRunRecord,
  readUngatedRunRecords,
  recordSuiteResult,
  writeHolder,
  writeUngatedRunRecord,
} from '../../../../scripts/testing/coordinator-store.js'

let tempDir: string
const itSupportsUnixSockets = process.platform === 'win32' ? it.skip : it

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fcs-'))
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

function createHolderRecord(overrides: Partial<HolderRecord> = {}): HolderRecord {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    summary: 'Nightly full suite',
    summarySource: 'flag',
    startedAt: '2026-03-11T00:00:00.000Z',
    pid: 4321,
    hostname: 'host-1',
    username: 'user-1',
    entrypoint: {
      commandKey: 'test',
      suiteKey: 'full-suite',
    },
    command: {
      display: 'npm test',
      argv: ['test'],
    },
    repo: {
      invocationCwd: '/repo/.worktrees/test-run-gate',
      checkoutRoot: '/repo/.worktrees/test-run-gate',
      repoRoot: '/repo',
      commonDir: '/repo/.git',
      worktreePath: '/repo/.worktrees/test-run-gate',
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
      sessionId: 'session-123',
      threadId: 'thread-456',
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

function createUngatedRunRecord(overrides: Partial<UngatedRunRecord> = {}): UngatedRunRecord {
  const holder = createHolderRecord()
  return {
    schemaVersion: 1,
    runId: 'ungated-run-1',
    summary: 'Cloud client in flight',
    summarySource: 'env',
    pid: process.pid,
    hostname: os.hostname(),
    queuedAt: new Date(Date.now() - 65_000).toISOString(),
    gate: 'waiting',
    phases: [{
      label: 'cloud client',
      selector: 'cloud-vitest:default',
      startedAt: new Date(Date.now() - 65_000).toISOString(),
      state: 'running',
    }],
    entrypoint: holder.entrypoint,
    command: holder.command,
    repo: holder.repo,
    agent: holder.agent,
    ...overrides,
  }
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  return child.pid!
}

describe('buildStatusView()', () => {
  it('renders idle when the endpoint is not live', async () => {
    const commonDir = path.join(tempDir, 'repo', '.git')
    const endpoint = buildCoordinatorEndpoint(commonDir, 'linux', [tempDir])

    const view = await buildStatusView({
      commonDir,
      endpoint,
      commandKey: 'test',
      suiteKey: 'full-suite',
      commit: 'abc123',
      isDirty: false,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    })

    expect(view.state).toBe('idle')
    expect(renderStatusView(view)).toContain('idle')
  })

  itSupportsUnixSockets('reports running with holder details, latest results, and a matching reusable baseline', async () => {
    const commonDir = path.join(tempDir, 'repo', '.git')
    const storeDir = getCoordinatorStoreDir(commonDir)
    const endpoint = buildCoordinatorEndpoint(commonDir, 'linux', [tempDir])
    const listener = await tryListen(endpoint)
    const holder = createHolderRecord({
      repo: {
        ...createHolderRecord().repo,
        commonDir,
      },
    })
    const latest = createLatestRunRecord({
      repo: {
        ...createLatestRunRecord().repo,
        commonDir,
      },
    })
    const reusable = createReusableSuccessRecord({
      repo: latest.repo,
      runtime: latest.runtime,
    })

    expect(listener.kind).toBe('listening')
    await writeHolder(storeDir, holder)
    await recordCommandResult(storeDir, latest)
    await recordSuiteResult(storeDir, latest)
    await recordReusableSuccess(storeDir, reusable)

    const view = await buildStatusView({
      commonDir,
      endpoint,
      commandKey: 'test',
      suiteKey: 'full-suite',
      commit: latest.repo.commit,
      isDirty: latest.repo.isDirty,
      nodeVersion: latest.runtime.nodeVersion,
      platform: latest.runtime.platform,
      arch: latest.runtime.arch,
    })

    expect(view).toMatchObject({
      state: 'running',
      holder,
      latestCommand: latest,
      latestSuite: latest,
      reusableSuccess: reusable,
    })

    const rendered = renderStatusView(view)
    expect(rendered).toContain('running')
    expect(rendered).toContain(holder.summary)
    expect(rendered).toContain(holder.repo.branch ?? '')
    expect(rendered).toContain(holder.command.display)
    expect(rendered).toContain(holder.agent.sessionId ?? '')

    await listener.close()
  })

  itSupportsUnixSockets('reports running-undescribed when the endpoint is live but holder metadata is missing or corrupt', async () => {
    const commonDir = path.join(tempDir, 'repo', '.git')
    const storeDir = getCoordinatorStoreDir(commonDir)
    const endpoint = buildCoordinatorEndpoint(commonDir, 'linux', [tempDir])
    const listener = await tryListen(endpoint)
    const latest = createLatestRunRecord({
      repo: {
        ...createLatestRunRecord().repo,
        commonDir,
      },
    })
    const reusable = createReusableSuccessRecord({
      repo: latest.repo,
      runtime: latest.runtime,
    })

    expect(listener.kind).toBe('listening')
    await recordCommandResult(storeDir, latest)
    await recordSuiteResult(storeDir, latest)
    await recordReusableSuccess(storeDir, reusable)
    await fsp.mkdir(storeDir, { recursive: true })
    await fsp.writeFile(path.join(storeDir, 'holder.json'), '{not json')

    const view = await buildStatusView({
      commonDir,
      endpoint,
      commandKey: 'test',
      suiteKey: 'full-suite',
      commit: latest.repo.commit,
      isDirty: latest.repo.isDirty,
      nodeVersion: latest.runtime.nodeVersion,
      platform: latest.runtime.platform,
      arch: latest.runtime.arch,
    })

    expect(view.state).toBe('running-undescribed')
    expect(view.holder).toBeUndefined()
    expect(view.latestCommand).toEqual(latest)
    expect(view.latestSuite).toEqual(latest)
    expect(view.reusableSuccess).toEqual(reusable)
    expect(renderStatusView(view)).toContain('running-undescribed')

    await listener.close()
  })

  it('surfaces the latest coordinated suite and reusable baseline when bare status is requested', async () => {
    const commonDir = path.join(tempDir, 'repo', '.git')
    const storeDir = getCoordinatorStoreDir(commonDir)
    const latest = createLatestRunRecord({
      summary: 'Unit-only baseline',
      entrypoint: {
        commandKey: 'test:unit',
        suiteKey: 'default:test/unit',
      },
      command: {
        display: 'npm run test:unit',
        argv: ['test:unit'],
      },
      repo: {
        ...createLatestRunRecord().repo,
        commonDir,
      },
    })
    const reusable = createReusableSuccessRecord({
      summary: latest.summary,
      entrypoint: latest.entrypoint,
      command: latest.command,
      repo: latest.repo,
      runtime: latest.runtime,
      reusableKey: buildReusableSuccessKey({
        suiteKey: 'default:test/unit',
        commit: latest.repo.commit ?? '',
        isDirty: latest.repo.isDirty,
        nodeVersion: latest.runtime.nodeVersion,
        platform: latest.runtime.platform,
        arch: latest.runtime.arch,
      }),
    })

    await recordCommandResult(storeDir, latest)
    await recordSuiteResult(storeDir, latest)
    await recordReusableSuccess(storeDir, reusable)

    const view = await buildStatusView({
      commonDir,
      commit: latest.repo.commit,
      isDirty: latest.repo.isDirty,
      nodeVersion: latest.runtime.nodeVersion,
      platform: latest.runtime.platform,
      arch: latest.runtime.arch,
    })

    expect(view.state).toBe('idle')
    expect(view.latestSuite).toEqual(latest)
    expect(view.reusableSuccess).toEqual(reusable)

    const rendered = renderStatusView(view)
    expect(rendered).toContain('latest-suite: default:test/unit success exit=0')
    expect(rendered).toContain('reusable-summary: Unit-only baseline')
  })

  it('lists live ungated phases separately from the gate holder and ignores records left by dead coordinators', async () => {
    const commonDir = path.join(tempDir, 'repo', '.git')
    const storeDir = getCoordinatorStoreDir(commonDir)
    const endpoint = buildCoordinatorEndpoint(commonDir, 'linux', [tempDir])
    await writeUngatedRunRecord(storeDir, createUngatedRunRecord())
    await writeUngatedRunRecord(storeDir, createUngatedRunRecord({
      runId: 'ungated-run-dead',
      summary: 'Coordinator that was SIGKILLed',
      pid: await exitedPid(),
    }))

    const view = await buildStatusView({ commonDir, endpoint })

    expect(view.state).toBe('idle')
    expect(view.ungatedRuns.map((record) => record.runId)).toEqual(['ungated-run-1'])
    const rendered = renderStatusView(view)
    expect(rendered).toContain('state: idle')
    expect(rendered).toContain('ungated-run: Cloud client in flight (command: npm test, gate: waiting')
    expect(rendered).toMatch(/ungated-phase: cloud client running 1m \d+s/)
    expect(rendered).not.toContain('SIGKILLed')

    await clearUngatedRunRecord(storeDir, 'ungated-run-1')
    expect(await readUngatedRunRecords(storeDir)).toEqual([])
  })
})
