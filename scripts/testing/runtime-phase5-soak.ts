import { sampleRuntimeRetention } from './runtime-retention-sample.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  SOAK_MAX_RUNTIME_LOG_BYTES,
  SOAK_MAX_TERMINAL_SPOOL_BYTES,
  SOAK_MIN_DURATION_MS,
  SOAK_SAMPLES_FILE,
  SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES,
  type RuntimeSoakResult,
  type RuntimeSoakSample,
  type SoakFixture,
  type SoakWorkload,
  validateRuntimeSoakBaseline,
  validateRuntimeSoakResult,
} from './runtime-soak-evidence.js'
import { newRequest, newSoul, RuntimeHarness, type SupervisorInstance } from './runtime-sandbox.js'

const SAMPLE_INTERVAL_MS = 5_000
const BASELINE_SETTLE_MS = 5_000
const METRIC_CONCURRENCY = 10
const desiredDuration = Number(process.env.FRESHELL_RUNTIME_PHASE5_SOAK_MS ?? SOAK_MIN_DURATION_MS)
if (!Number.isSafeInteger(desiredDuration) || desiredDuration < SOAK_MIN_DURATION_MS) {
  throw new Error(`Phase 5 qualification soak must run for at least ${SOAK_MIN_DURATION_MS}ms`)
}

const h = new RuntimeHarness(process.cwd(), undefined, 5)
let supervisor: SupervisorInstance | undefined
let failure: unknown
let prepared = false
let controlEpoch: number | undefined
let terminalInputProof: RuntimeSoakResult['terminalInput'] | undefined
let shellSpoolConfiguredBytes: number | undefined
const workloads: SoakWorkload[] = []
const samples: RuntimeSoakSample[] = []
const samplesPath = path.join(h.evidenceDir, SOAK_SAMPLES_FILE)
const target = path.join(h.evidenceDir, 'soak-results.json')

function dataOf(result: any, expected: string): any {
  if (!result || result.kind !== expected) throw new Error(`expected ${expected}, received a different runtime response`)
  return result.data
}

async function epoch(): Promise<number> {
  return dataOf(await h.adminOk(supervisor!, { method: 'health' }), 'health').controlEpoch
}

function monotonicNow(): number {
  return Math.floor(performance.now())
}

function workloadFixture(index: number): SoakFixture {
  if (index === 46) return 'shell_output'
  if (index === 47) return 'cpu_burner'
  if (index === 48) return 'memory_allocator'
  if (index === 49) return 'descendant_spawner'
  return 'heartbeat'
}

/** Fixed proposals: the authentic calibration may reject them but never weakens acceptance or retries looser values. */
function limitsFor(fixture: SoakFixture) {
  if (fixture === 'shell_output') {
    return { cpuMilli: 100, memoryBytes: 128 * 1024 * 1024, swapBytes: 0, pidsMax: 16 }
  }
  if (fixture === 'cpu_burner') {
    // host + fixture worker + four bounded burners; each Rust process has a
    // main task and the checked-in four-thread Tokio floor.
    return { cpuMilli: 500, memoryBytes: 96 * 1024 * 1024, swapBytes: 0, pidsMax: 32 }
  }
  if (fixture === 'memory_allocator') {
    // The worker touches 32 MiB. The Sept 11 baseline measured 39,424,000 B
    // total occupancy: only 78.3% of the original 48 MiB cap, correctly rejected.
    // Tighten (never loosen) that test-only cap to 44 MiB: the measured working
    // set is 85.4%, with headroom. The live baseline must still independently
    // satisfy the UNCHANGED >=80% floor before the measurement clock starts.
    return { cpuMilli: 100, memoryBytes: 44 * 1024 * 1024, swapBytes: 0, pidsMax: 12 }
  }
  if (fixture === 'descendant_spawner') {
    // host, worker, child, and grandchild at five tasks each occupy at least
    // 20/24 slots without an unbounded fork workload.
    return { cpuMilli: 100, memoryBytes: 64 * 1024 * 1024, swapBytes: 0, pidsMax: 24 }
  }
  // host + heartbeat worker need ten baseline tasks at the four-thread floor.
  return { cpuMilli: 50, memoryBytes: 64 * 1024 * 1024, swapBytes: 0, pidsMax: 12 }
}

function currentSoul(rows: any[], soulId: string): any | undefined {
  return rows
    .filter((row) => row.soulId === soulId)
    .sort((left, right) => (
      Number(left.intentRevision ?? 0) - Number(right.intentRevision ?? 0)
      || Number(left.executionGeneration ?? 0) - Number(right.executionGeneration ?? 0)
    ))
    .at(-1)
}

function retainedBytes(instance: SupervisorInstance, terminalIncarnationId: string) {
  return sampleRuntimeRetention(path.dirname(instance.runtimeRoot), h.runtimeDir(instance, terminalIncarnationId))
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, map: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await map(values[index])
    }
  }))
  return results
}

async function collectSample(sequence: number, baselineMonotonicMs?: number): Promise<RuntimeSoakSample> {
  const collectionStartedMonotonicMs = monotonicNow()
  const instance = supervisor!
  const expectedEpoch = controlEpoch!
  const snapshot = dataOf(await h.adminOk(instance, h.inventorySnapshotBody()), 'inventory_snapshot')
  const desiredSoulIds = workloads.map(({ soulId }) => soulId)
  const souls = workloads.map(({ soulId, fixture }) => {
    const rows = snapshot.souls.filter((row: any) => row.soulId === soulId)
    const current = currentSoul(snapshot.souls, soulId)
    return {
      soulId,
      fixture,
      incarnationId: String(current?.incarnationId ?? ''),
      desiredState: String(current?.desiredState ?? 'missing'),
      launchState: String(current?.launchState ?? 'missing'),
      recoveryState: String(current?.recoveryState ?? 'missing'),
      runningWriters: rows.filter((row: any) => row.launchState === 'running').length,
      lostIncarnations: rows.filter((row: any) => row.recoveryState === 'lost').length,
    }
  })
  const soulById = new Map(souls.map((soul) => [soul.soulId, soul]))
  const metrics = await mapConcurrent(workloads, METRIC_CONCURRENCY, async (workload) => {
    const soul = soulById.get(workload.soulId)!
    const raw = dataOf(await h.adminOk(
      instance,
      h.runtimeMetricsBody(workload.soulId, expectedEpoch),
      { requestId: newRequest() },
    ), 'runtime_metrics')
    const current = currentSoul(snapshot.souls, workload.soulId)
    return {
      soulId: workload.soulId,
      fixture: workload.fixture,
      incarnationId: soul.incarnationId,
      cpuUsageUsec: raw.cpuUsageUsec,
      cpuThrottledUsec: raw.cpuThrottledUsec,
      cpuNrThrottled: raw.cpuNrThrottled,
      memoryCurrentBytes: raw.memoryCurrentBytes,
      memoryPeakBytes: raw.memoryPeakBytes,
      memoryLimitBytes: current?.effectiveLimits?.memoryBytes,
      memoryOom: raw.memoryOom,
      memoryOomKill: raw.memoryOomKill,
      pidsCurrent: raw.pidsCurrent,
      pidsMax: raw.pidsMax,
    }
  })
  const notices = dataOf(await h.adminOk(
    instance,
    h.pendingNoticesBody('profile:phase5-soak', 100, expectedEpoch),
    { requestId: newRequest() },
  ), 'pending_notices')
  if (!Array.isArray(notices)) throw new Error('pending notice response was incomplete')
  if (h.broker.unsafeAttempts().length > 0) throw new Error('soak broker recorded an unsafe request')
  const shell = souls.find(({ fixture }) => fixture === 'shell_output')!
  const retained = retainedBytes(instance, shell.incarnationId)
  const collectionEndedMonotonicMs = monotonicNow()
  const anchor = baselineMonotonicMs ?? collectionEndedMonotonicMs
  return {
    schemaVersion: 2,
    sequence,
    capturedAtMs: Date.now(),
    collectionStartedMonotonicMs,
    collectionEndedMonotonicMs,
    monotonicElapsedMs: collectionEndedMonotonicMs - anchor,
    inventoryRevision: snapshot.revision,
    desiredSoulIds,
    souls,
    metrics,
    pendingLossNotices: notices.length,
    retainedBytes: { terminalSpools: retained.terminalSpools, runtimeLogs: retained.runtimeLogs },
    terminalOutput: retained.terminalOutput,
  }
}

function appendSample(sample: RuntimeSoakSample): void {
  samples.push(sample)
  fs.appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`, { mode: 0o600 })
  h.recordLifecycle('phase5.soak.sample', {
    sequence: sample.sequence,
    monotonicElapsedMs: sample.monotonicElapsedMs,
    collectionMs: sample.collectionEndedMonotonicMs - sample.collectionStartedMonotonicMs,
    desiredSouls: sample.desiredSoulIds.length,
    terminalSpoolBytes: sample.retainedBytes.terminalSpools,
    runtimeLogBytes: sample.retainedBytes.runtimeLogs,
  })
}

function terminalSpec(projectKey: string): Record<string, unknown> {
  const workspace = h.repoRoot
  const rawGitCommon = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: workspace, encoding: 'utf8' }).trim()
  const gitCommonDir = fs.realpathSync(path.isAbsolute(rawGitCommon) ? rawGitCommon : path.resolve(workspace, rawGitCommon))
  return {
    terminalId: `terminal-${newRequest()}`,
    streamId: `stream-${newRequest()}`,
    mode: 'shell',
    program: '/bin/bash',
    args: ['--noprofile', '--norc'],
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      HOME: '/home/freshell/provider',
    },
    cwd: workspace,
    runAsUid: 65_534,
    runAsGid: 0,
    cols: 100,
    rows: 30,
    projectKey,
    workspacePath: workspace,
    gitCommonDir,
    createRequestId: `create-${newRequest()}`,
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readEvidence(fileName: string): Buffer {
  const file = path.join(h.evidenceDir, fileName)
  return fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0)
}

function writeResult(result: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(`[phase5-soak] result: ${target}`)
}

  try {
    // A partial prepare may own resources and always requires exact cleanup.
    prepared = true
    await h.prepare()
    supervisor = await h.startSupervisor({
      scenarioId: 'phase5-30m-soak',
      installationBudget: {
        cpuMilli: 4_000,
        memoryBytes: 4 * 1024 * 1024 * 1024,
        swapBytes: 0,
        pidsMax: 2_048,
      },
      projectBudget: {
        cpuMilli: 1_200,
        memoryBytes: 1024 * 1024 * 1024,
        swapBytes: 0,
        pidsMax: 512,
      },
      env: {
        FRESHELL_RUNTIME_OUTPUT_SPOOL_BYTES: String(SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES),
      },
    })
    controlEpoch = await epoch()
    await h.adminOk(supervisor, h.migrationPlanBody({
      requestedMode: 'managed-opt-in',
      apply: true,
      expectedControlEpoch: controlEpoch,
    }), { requestId: newRequest() })

    for (let index = 0; index < 50; index += 1) {
      const fixture = workloadFixture(index)
      const workload = { soulId: newSoul(), fixture }
      workloads.push(workload)
      const projectKey = `soak-project-${Math.floor(index / 10)}`
      const limits = limitsFor(fixture)
      const launch = dataOf(await h.adminOk(supervisor, h.launchBody({
        soulId: workload.soulId,
        ...(fixture === 'shell_output'
          ? { provider: 'shell', terminal: terminalSpec(projectKey) }
          : { fixture }),
        limits,
        profile: 'custom',
        projectKey,
        expectedControlEpoch: controlEpoch,
        viewIntent: {
          ownerId: 'phase5-soak',
          workspaceId: projectKey,
          kind: 'automatic_primary',
          preferredTabId: `soak-tab-${index}`,
          preferredPaneId: `soak-pane-${index}`,
          title: `Soak fixture ${index}`,
          placementGroup: 'Recovered agents',
          visibility: 'visible',
        },
      }), { requestId: newRequest() }), 'launch')
      if (Object.entries(limits).some(([field, value]) => launch.effectiveLimits?.[field] !== value)) {
        throw new Error(`owned ${fixture} workload did not receive its fixed calibrated limits`)
      }
      if (fixture === 'shell_output') {
        const observed = h.execOwnedContainerExact(
          String(launch.view.containerId),
          ['sh', '-lc', 'printf "%s" "$FRESHELL_RUNTIME_OUTPUT_SPOOL_BYTES"'],
        ).trim()
        shellSpoolConfiguredBytes = Number(observed)
        if (shellSpoolConfiguredBytes !== SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES) {
          throw new Error('owned shell workload did not receive the required 1 MiB terminal spool configuration')
        }
      }
    }

    const shell = workloads.find(({ fixture }) => fixture === 'shell_output')!
    const inputRequestId = newRequest()
    const boundedOutputCommand = `while :; do printf 'SOAK_OUTPUT %0240d\\n' 0; sleep 1; done\n`
    await h.adminOk(
      supervisor,
      h.terminalInputBody(shell.soulId, boundedOutputCommand, controlEpoch),
      { requestId: inputRequestId },
    )
    terminalInputProof = {
      soulId: shell.soulId,
      requestId: inputRequestId,
      dispatchCount: 1,
      spoolConfiguredBytesObserved: shellSpoolConfiguredBytes!,
    }

    await new Promise((resolve) => setTimeout(resolve, BASELINE_SETTLE_MS))
    fs.writeFileSync(samplesPath, '', { mode: 0o600 })
    const first = await collectSample(0)
    appendSample(first)
    validateRuntimeSoakBaseline(first, workloads)
    const measurementStartedMonotonicMs = first.collectionEndedMonotonicMs

    while (true) {
      const remaining = desiredDuration - (monotonicNow() - measurementStartedMonotonicMs)
      if (remaining <= 0) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(SAMPLE_INTERVAL_MS, remaining)))
      appendSample(await collectSample(samples.length, measurementStartedMonotonicMs))
    }
    if (samples.at(-1)!.monotonicElapsedMs < desiredDuration) {
      appendSample(await collectSample(samples.length, measurementStartedMonotonicMs))
    }
  } catch (error) {
    failure = error
  } finally {
    let cleanup = { ok: true, errors: [] as string[] }
    if (prepared) {
      try {
        cleanup = await h.cleanup()
      } catch (error) {
        const message = `cleanup failed: ${safeError(error)}`
        cleanup = { ok: false, errors: [message] }
        failure ??= error
      }
    }
    fs.mkdirSync(h.evidenceDir, { recursive: true })
    if (!fs.existsSync(samplesPath)) fs.writeFileSync(samplesPath, '', { mode: 0o600 })
    const sampleEvidenceBytes = readEvidence(SOAK_SAMPLES_FILE)
    const unsafeBrokerAttempts = h.broker?.unsafeAttempts?.().length ?? 0
    const evidenceRun = path.relative(h.repoRoot, h.evidenceDir)
    const first = samples[0]
    const last = samples.at(-1)
    const errors = [
      failure ? safeError(failure) : null,
      ...cleanup.errors,
      terminalInputProof ? null : 'shell output input was not dispatched',
    ].filter((value): value is string => !!value)
    const result: RuntimeSoakResult = {
      schemaVersion: 3,
      status: 'FAIL',
      candidateSha: h.candidateSha,
      runtimeImage: h.imageRef,
      receiptRunId: h.runId,
      evidenceRun,
      desiredWorkloads: workloads,
      measurement: {
        startedAtMs: first?.capturedAtMs ?? 0,
        endedAtMs: last?.capturedAtMs ?? 0,
        monotonicStartedMs: first?.collectionEndedMonotonicMs ?? 0,
        monotonicEndedMs: last?.collectionEndedMonotonicMs ?? 0,
        monotonicDurationMs: last?.monotonicElapsedMs ?? 0,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
      },
      retentionBounds: {
        terminalSpoolConfiguredBytes: SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES,
        terminalSpoolsBytes: SOAK_MAX_TERMINAL_SPOOL_BYTES,
        runtimeLogsBytes: SOAK_MAX_RUNTIME_LOG_BYTES,
      },
      terminalInput: terminalInputProof ?? {
        soulId: '',
        requestId: 'not-dispatched',
        dispatchCount: 1,
        spoolConfiguredBytesObserved: 0,
      },
      cleanup: { verified: cleanup.ok, unsafeBrokerAttempts, errors: cleanup.errors },
      errors,
    }
    if (errors.length === 0 && cleanup.ok && unsafeBrokerAttempts === 0) {
      try {
        result.status = 'PASS'
        const validated = validateRuntimeSoakResult({ result, sampleEvidenceBytes })
        result.summary = validated.summary
      } catch (error) {
        result.status = 'FAIL'
        result.errors.push(safeError(error))
        delete result.summary
      }
    }
    writeResult(result)
    console.log(`[phase5-soak] status=${result.status} samples=${samples.length} monotonicDurationMs=${result.measurement.monotonicDurationMs}`)
    if (result.status !== 'PASS') process.exitCode = 1
  }
