import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildCoordinatorEndpoint,
  tryListen,
  type CoordinatorEndpoint,
  type ListeningServer,
} from '../../../../scripts/testing/coordinator-endpoint.js'
import { buildStatusView, renderStatusView } from '../../../../scripts/testing/coordinator-status.js'
import {
  getCoordinatorStoreDir,
  readCommandRuns,
  readHolder,
  readReusableSuccesses,
  readSuiteRuns,
  readUngatedRunRecords,
} from '../../../../scripts/testing/coordinator-store.js'
import { isProcessRunning } from '../../../../scripts/testing/process-tree.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const require = createRequire(import.meta.url)
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href
const COORDINATOR = path.join(REPO_ROOT, 'scripts', 'testing', 'test-coordinator.ts')
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'testing', 'fake-coordinated-workload.mjs')

const CLOUD = 'cloud-vitest:default'
const LOCAL = 'npm:test:balanced --skip-suite=client'
const SUMMARY = 'ungated phase contract'
const LONG_HOLD_MS = 120_000

type Behavior = Record<string, Record<string, unknown>>
type Capture = { selector: string; args: string[]; pid: number; grandchildPid?: number }
type CoordinatorEvent = { event: string; [field: string]: unknown }

type CoordinatorRun = {
  child: ChildProcess
  output: () => string
  events: () => CoordinatorEvent[]
  waitForEvent: (event: string, timeoutMs?: number) => Promise<CoordinatorEvent>
  exit: Promise<number | null>
  hasExited: () => boolean
}

const describeUnix = process.platform === 'win32' ? describe.skip : describe

let tempDir: string
let repoDir: string
let runtimeDir: string
let captureFile: string
let commonDir: string
let storeDir: string
let endpoint: CoordinatorEndpoint
const runs: CoordinatorRun[] = []
const gates: ListeningServer[] = []

beforeEach(async () => {
  tempDir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'ftc-')))
  repoDir = path.join(tempDir, 'repo')
  runtimeDir = path.join(tempDir, 'rt')
  captureFile = path.join(tempDir, 'capture.jsonl')
  await fsp.mkdir(repoDir, { recursive: true })
  await fsp.mkdir(runtimeDir, { recursive: true })
  execFileSync('git', ['init', '-q', repoDir])
  execFileSync('git', [
    '-C', repoDir,
    '-c', 'user.name=Coordinator Test',
    '-c', 'user.email=coordinator-test@example.invalid',
    'commit', '-q', '--allow-empty', '-m', 'init',
  ])
  commonDir = path.join(repoDir, '.git')
  storeDir = getCoordinatorStoreDir(commonDir)
  endpoint = buildCoordinatorEndpoint(commonDir, process.platform, [runtimeDir])
})

afterEach(async () => {
  // Kill leftover fake phases first: they inherit the coordinator's output
  // pipes, so the coordinator child cannot report 'close' while they live.
  for (const run of runs) {
    if (!run.hasExited()) run.child.kill('SIGKILL')
  }
  for (const capture of readCaptures()) {
    for (const pid of [capture.pid, capture.grandchildPid]) {
      if (pid && isProcessRunning(pid)) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
  }
  for (const run of runs.splice(0)) await run.exit
  for (const gate of gates.splice(0)) await gate.close().catch(() => {})
  await fsp.rm(tempDir, { recursive: true, force: true })
})

async function holdGate(): Promise<ListeningServer> {
  const attempt = await tryListen(endpoint)
  if (attempt.kind !== 'listening') throw new Error('test could not take the coordinator gate')
  gates.push(attempt)
  return attempt
}

async function releaseGate(gate: ListeningServer): Promise<void> {
  gates.splice(gates.indexOf(gate), 1)
  await gate.close()
}

function startCoordinator(
  behavior: Behavior,
  extraEnv: Record<string, string> = {},
  commandKey = 'test',
): CoordinatorRun {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('FRESHELL_TEST_') || key.startsWith('FRESHELL_VITEST_')) delete env[key]
  }
  Object.assign(env, {
    INIT_CWD: repoDir,
    PWD: repoDir,
    XDG_RUNTIME_DIR: runtimeDir,
    FRESHELL_VITEST_BACKEND: 'cloud',
    FRESHELL_TEST_SUMMARY: SUMMARY,
    FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM: FIXTURE,
    FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify(behavior),
    FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
    FRESHELL_TEST_COORDINATOR_REPO_ROOT: REPO_ROOT,
    FRESHELL_TEST_COORDINATOR_POLL_MS: '50',
    FRESHELL_TEST_COORDINATOR_STOP_GRACE_MS: '5000',
    ...extraEnv,
  })

  const child = spawn(process.execPath, ['--import', TSX_LOADER, COORDINATOR, 'run', commandKey], {
    cwd: repoDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let exited = false
  child.stdout!.on('data', (chunk) => { output += chunk.toString() })
  child.stderr!.on('data', (chunk) => { output += chunk.toString() })
  const exit = new Promise<number | null>((resolve) => {
    child.once('close', (code) => {
      exited = true
      resolve(code)
    })
  })

  const events = (): CoordinatorEvent[] => output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as { component?: string; event?: string }
        return parsed.component === 'test-coordinator' && parsed.event ? [parsed as CoordinatorEvent] : []
      } catch {
        return []
      }
    })

  const run: CoordinatorRun = {
    child,
    output: () => output,
    events,
    exit,
    hasExited: () => exited,
    waitForEvent: async (event, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = events().find((entry) => entry.event === event)
        if (found) return found
        if (exited) break
        await delay(20)
      }
      throw new Error(`coordinator never logged ${event}; output:\n${output}`)
    },
  }
  runs.push(run)
  return run
}

function readCaptures(): Capture[] {
  try {
    return fs.readFileSync(captureFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Capture)
  } catch {
    return []
  }
}

async function waitForCapture(selector: string, timeoutMs = 20_000): Promise<Capture> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const capture = readCaptures().find((entry) => entry.selector === selector)
    if (capture) return capture
    await delay(20)
  }
  throw new Error(`phase ${selector} never started`)
}

async function expectProcessesGone(pids: Array<number | undefined>, timeoutMs = 10_000): Promise<void> {
  const live = () => pids.filter((pid): pid is number => typeof pid === 'number' && isProcessRunning(pid))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && live().length > 0) await delay(50)
  expect(live()).toEqual([])
}

function eventIndex(run: CoordinatorRun, event: string): number {
  return run.events().findIndex((entry) => entry.event === event)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describeUnix('test coordinator with an ungated cloud client phase', () => {
  it('runs the cloud client phase to completion while another run holds the gate, then runs local phases once the gate is free', async () => {
    const gate = await holdGate()
    const run = startCoordinator({
      [CLOUD]: { holdMs: 100, stdout: 'cloud line one\ncloud line two\n' },
      [LOCAL]: { stdout: 'local line\n' },
    })

    const finished = await run.waitForEvent('ungated_phase_finished')
    expect(finished).toMatchObject({ phase: 'cloud client', exitCode: 0 })
    expect(readCaptures().map((capture) => capture.selector)).toEqual([CLOUD])
    expect(run.hasExited()).toBe(false)
    expect(eventIndex(run, 'gate_acquired')).toBe(-1)
    expect(await readUngatedRunRecords(storeDir)).toMatchObject([{
      summary: SUMMARY,
      gate: 'waiting',
      phases: [{ label: 'cloud client', state: 'passed', exitCode: 0 }],
    }])

    await releaseGate(gate)

    expect(await run.exit).toBe(0)
    expect(readCaptures().map((capture) => capture.selector)).toEqual([CLOUD, LOCAL])
    expect(eventIndex(run, 'ungated_phase_finished')).toBeLessThan(eventIndex(run, 'gate_acquired'))
    expect(eventIndex(run, 'gate_acquired')).toBeLessThan(eventIndex(run, 'gate_released'))

    const lines = run.output().split('\n')
    expect(lines).toContain('[cloud client] cloud line one')
    expect(lines).toContain('[cloud client] cloud line two')
    expect(lines).not.toContain('cloud line one')

    expect((await readCommandRuns(storeDir)).byKey.test).toMatchObject({ outcome: 'success', exitCode: 0 })
    expect((await readSuiteRuns(storeDir)).byKey['full-suite']).toMatchObject({ outcome: 'success', exitCode: 0 })
    expect(Object.keys((await readReusableSuccesses(storeDir)).byReusableKey)).toHaveLength(1)
    expect(await readUngatedRunRecords(storeDir)).toEqual([])
  })

  it('fails without taking the gate or starting local phases when the cloud phase fails while queued', async () => {
    await holdGate()
    const run = startCoordinator({
      [CLOUD]: { exitCode: 1 },
    })

    expect(await run.exit).toBe(1)
    expect(readCaptures().map((capture) => capture.selector)).toEqual([CLOUD])
    expect(eventIndex(run, 'gate_acquired')).toBe(-1)
    expect((await readCommandRuns(storeDir)).byKey.test).toMatchObject({ outcome: 'failure', exitCode: 1 })
    expect((await readSuiteRuns(storeDir)).byKey['full-suite']).toMatchObject({ outcome: 'failure', exitCode: 1 })
    expect((await readReusableSuccesses(storeDir)).byReusableKey).toEqual({})
    expect(await readUngatedRunRecords(storeDir)).toEqual([])
  })

  it('releases the gate as soon as local phases finish and still fails the run when the cloud phase fails afterwards', async () => {
    const cloudRelease = path.join(tempDir, 'release-cloud')
    const run = startCoordinator({
      [CLOUD]: { waitForFile: cloudRelease, exitCode: 1 },
      [LOCAL]: {},
    })

    await run.waitForEvent('gate_released')
    expect(run.hasExited()).toBe(false)
    const contender = await tryListen(endpoint)
    expect(contender.kind).toBe('listening')
    if (contender.kind === 'listening') await contender.close()
    expect(await readUngatedRunRecords(storeDir)).toMatchObject([{ gate: 'released', phases: [{ state: 'running' }] }])

    await fsp.writeFile(cloudRelease, '')

    expect(await run.exit).toBe(1)
    expect((await readCommandRuns(storeDir)).byKey.test).toMatchObject({ outcome: 'failure', exitCode: 1 })
    expect((await readSuiteRuns(storeDir)).byKey['full-suite']).toMatchObject({ outcome: 'failure', exitCode: 1 })
    expect((await readReusableSuccesses(storeDir)).byReusableKey).toEqual({})
  })

  it('stops the cloud phase and its descendants when a gated local phase fails', async () => {
    const run = startCoordinator({
      [CLOUD]: { holdMs: LONG_HOLD_MS, grandchildHoldMs: LONG_HOLD_MS },
      [LOCAL]: { exitCode: 3 },
    })

    const cloud = await waitForCapture(CLOUD)
    expect(await run.exit).toBe(3)
    await expectProcessesGone([cloud.pid, cloud.grandchildPid])
    expect((await readCommandRuns(storeDir)).byKey.test).toMatchObject({ outcome: 'failure', exitCode: 3 })
    expect((await readSuiteRuns(storeDir)).byKey['full-suite']).toMatchObject({ outcome: 'failure', exitCode: 3 })
    expect((await readReusableSuccesses(storeDir)).byReusableKey).toEqual({})
  })

  it('stops the cloud phase when a gated pre-phase fails, without starting the suite phase', async () => {
    const run = startCoordinator({
      [CLOUD]: { holdMs: LONG_HOLD_MS, grandchildHoldMs: LONG_HOLD_MS },
      'npm:typecheck': { exitCode: 2 },
    }, {}, 'check')

    const cloud = await waitForCapture(CLOUD)
    expect(await run.exit).toBe(2)
    await expectProcessesGone([cloud.pid, cloud.grandchildPid])
    expect(readCaptures().map((capture) => capture.selector)).toEqual([CLOUD, 'npm:typecheck'])
    expect((await readCommandRuns(storeDir)).byKey.check).toMatchObject({ outcome: 'failure', exitCode: 2 })
    expect((await readSuiteRuns(storeDir)).byKey['full-suite']).toBeUndefined()
  })

  it.each([
    ['still running', { holdMs: LONG_HOLD_MS, grandchildHoldMs: LONG_HOLD_MS }],
    ['already passed', {}],
  ])('exits 124 and leaves no cloud processes when the gate wait times out while the cloud phase is %s', async (_label, cloudBehavior) => {
    await holdGate()
    const run = startCoordinator({ [CLOUD]: cloudBehavior }, { FRESHELL_TEST_COORDINATOR_MAX_WAIT_MS: '3000' })

    const cloud = await waitForCapture(CLOUD)
    expect(await run.exit).toBe(124)
    await expectProcessesGone([cloud.pid, cloud.grandchildPid])
    expect(readCaptures().map((capture) => capture.selector)).toEqual([CLOUD])
    expect((await readCommandRuns(storeDir)).byKey.test).toMatchObject({ outcome: 'failure', exitCode: 124 })
    expect((await readSuiteRuns(storeDir)).byKey['full-suite']).toBeUndefined()
    expect(await readUngatedRunRecords(storeDir)).toEqual([])
  })

  it('shows the queued run\'s cloud phase in test:status and stops it on SIGTERM without orphans', async () => {
    await holdGate()
    const run = startCoordinator({ [CLOUD]: { holdMs: LONG_HOLD_MS, grandchildHoldMs: LONG_HOLD_MS } })
    const cloud = await waitForCapture(CLOUD)
    await run.waitForEvent('ungated_phase_started')

    const rendered = renderStatusView(await buildStatusView({ commonDir, endpoint }))
    expect(rendered).toContain('state: running-undescribed')
    expect(rendered).toContain(`ungated-run: ${SUMMARY}`)
    expect(rendered).toContain('gate: waiting')
    expect(rendered).toMatch(/ungated-phase: cloud client running/)

    run.child.kill('SIGTERM')

    expect(await run.exit).toBe(143)
    await expectProcessesGone([cloud.pid, cloud.grandchildPid])
    expect((await readCommandRuns(storeDir)).byKey.test).toMatchObject({ outcome: 'failure', exitCode: 143 })
    expect((await readSuiteRuns(storeDir)).byKey['full-suite']).toBeUndefined()
    expect(await readUngatedRunRecords(storeDir)).toEqual([])
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('%s stops both the cloud phase and the gated local phase trees, records exit %i, and frees the gate', async (signal, exitCode) => {
    const run = startCoordinator({
      [CLOUD]: { holdMs: LONG_HOLD_MS, grandchildHoldMs: LONG_HOLD_MS },
      [LOCAL]: { holdMs: LONG_HOLD_MS, grandchildHoldMs: LONG_HOLD_MS },
    })
    const cloud = await waitForCapture(CLOUD)
    const local = await waitForCapture(LOCAL)

    run.child.kill(signal)

    expect(await run.exit).toBe(exitCode)
    await expectProcessesGone([cloud.pid, cloud.grandchildPid, local.pid, local.grandchildPid])
    expect((await readCommandRuns(storeDir)).byKey.test).toMatchObject({ outcome: 'failure', exitCode })
    expect((await readSuiteRuns(storeDir)).byKey['full-suite']).toMatchObject({ outcome: 'failure', exitCode })
    expect(await readHolder(storeDir)).toBeUndefined()
    expect(await readUngatedRunRecords(storeDir)).toEqual([])
    const contender = await tryListen(endpoint)
    expect(contender.kind).toBe('listening')
    if (contender.kind === 'listening') await contender.close()
  })

  it('keeps every phase gated when the Vitest backend is local', async () => {
    const run = startCoordinator({ 'npm:test:balanced': {} }, { FRESHELL_VITEST_BACKEND: 'local' })

    expect(await run.exit).toBe(0)
    expect(readCaptures().map((capture) => capture.selector)).toEqual(['npm:test:balanced'])
    expect(eventIndex(run, 'ungated_phase_started')).toBe(-1)
    expect((await readSuiteRuns(storeDir)).byKey['full-suite']).toMatchObject({ outcome: 'success' })
  })
})
