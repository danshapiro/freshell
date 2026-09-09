import fs from 'node:fs'
import path from 'node:path'

import { defaultReceiptFileName } from './runtime-receipts.js'
import {
  runtimeSoakEvidenceRun,
  sampleDigest,
  SOAK_BROKER_FILE,
  SOAK_CLEANUP_FILE,
  SOAK_MAX_RUNTIME_LOG_BYTES,
  SOAK_MAX_TERMINAL_SPOOL_BYTES,
  SOAK_MIN_DURATION_MS,
  SOAK_SAMPLES_FILE,
  type RuntimeSoakReceipt,
  type RuntimeSoakSample,
  type SoakFixture,
  type SoakWorkload,
  validateRuntimeSoakReceipt,
} from './runtime-soak-evidence.js'
import { newRequest, newSoul, RuntimeHarness, type SupervisorInstance } from './runtime-sandbox.js'

const SAMPLE_INTERVAL_MS = 5_000
const desiredDuration = Number(process.env.FRESHELL_RUNTIME_PHASE5_SOAK_MS ?? SOAK_MIN_DURATION_MS)
if (!Number.isFinite(desiredDuration) || !Number.isInteger(desiredDuration) || desiredDuration < SOAK_MIN_DURATION_MS) {
  throw new Error(`Phase 5 qualification soak must run for at least ${SOAK_MIN_DURATION_MS}ms`)
}

const h = new RuntimeHarness(process.cwd(), undefined, 5)
let supervisor: SupervisorInstance | undefined
let failure: unknown
let controlEpoch: number | undefined
const workloads: SoakWorkload[] = []
const samples: RuntimeSoakSample[] = []
const samplesPath = path.join(h.evidenceDir, SOAK_SAMPLES_FILE)

function dataOf(result: any, expected: string): any {
  if (!result || result.kind !== expected) throw new Error(`expected ${expected}, received a different runtime response`)
  return result.data
}

async function epoch(): Promise<number> {
  return dataOf(await h.adminOk(supervisor!, { method: 'health' }), 'health').controlEpoch
}

function workloadFixture(index: number): SoakFixture {
  if (index === 47) return 'cpu_burner'
  if (index === 48) return 'memory_allocator'
  if (index === 49) return 'descendant_spawner'
  return 'heartbeat'
}

function limitsFor(fixture: SoakFixture) {
  if (fixture === 'cpu_burner') {
    return { cpuMilli: 500, memoryBytes: 96 * 1024 * 1024, swapBytes: 0, pidsMax: 16 }
  }
  if (fixture === 'memory_allocator') {
    return { cpuMilli: 100, memoryBytes: 64 * 1024 * 1024, swapBytes: 0, pidsMax: 8 }
  }
  if (fixture === 'descendant_spawner') {
    return { cpuMilli: 100, memoryBytes: 64 * 1024 * 1024, swapBytes: 0, pidsMax: 8 }
  }
  return { cpuMilli: 50, memoryBytes: 64 * 1024 * 1024, swapBytes: 0, pidsMax: 8 }
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

function retainedBytes(instance: SupervisorInstance): { terminalSpools: number; runtimeLogs: number } {
  let terminalSpools = 0
  let runtimeLogs = 0
  const stack = [path.dirname(instance.runtimeRoot)]
  while (stack.length) {
    const current = stack.pop()!
    if (!fs.existsSync(current)) continue
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name))
      continue
    }
    const base = path.basename(current)
    if (/^terminal-spool-(?:current|previous)\.jsonl$/.test(base)) {
      terminalSpools += stat.size
    } else if (base.endsWith('.log') || base.endsWith('.jsonl')) {
      runtimeLogs += stat.size
    }
  }
  return { terminalSpools, runtimeLogs }
}

async function collectSample(sequence: number, startedAtMs?: number): Promise<RuntimeSoakSample> {
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
  const metrics = []
  for (const workload of workloads) {
    const soul = souls.find((row) => row.soulId === workload.soulId)!
    const raw = dataOf(await h.adminOk(
      instance,
      h.runtimeMetricsBody(workload.soulId, expectedEpoch),
      { requestId: newRequest() },
    ), 'runtime_metrics')
    const current = currentSoul(snapshot.souls, workload.soulId)
    metrics.push({
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
    })
  }
  const notices = dataOf(await h.adminOk(
    instance,
    h.pendingNoticesBody('profile:phase5-soak', 100, expectedEpoch),
    { requestId: newRequest() },
  ), 'pending_notices')
  if (!Array.isArray(notices)) throw new Error('pending notice response was incomplete')
  if (h.broker.unsafeAttempts().length > 0) throw new Error('soak broker recorded an unsafe request')
  const capturedAtMs = Date.now()
  const anchor = startedAtMs ?? capturedAtMs
  return {
    schemaVersion: 1,
    sequence,
    capturedAtMs,
    elapsedMs: capturedAtMs - anchor,
    inventoryRevision: snapshot.revision,
    desiredSoulIds,
    souls,
    metrics,
    pendingLossNotices: notices.length,
    retainedBytes: retainedBytes(instance),
  }
}

function appendSample(sample: RuntimeSoakSample): void {
  samples.push(sample)
  fs.appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`, { mode: 0o600 })
  h.recordLifecycle('phase5.soak.sample', {
    sequence: sample.sequence,
    elapsedMs: sample.elapsedMs,
    desiredSouls: sample.desiredSoulIds.length,
    terminalSpoolBytes: sample.retainedBytes.terminalSpools,
    runtimeLogBytes: sample.retainedBytes.runtimeLogs,
  })
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

try {
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
      FRESHELL_RUNTIME_OUTPUT_SPOOL_BYTES: String(1024 * 1024),
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
    await h.adminOk(supervisor, h.launchBody({
      soulId: workload.soulId,
      fixture,
      limits: limitsFor(fixture),
      profile: 'test_fixture',
      projectKey: `soak-project-${Math.floor(index / 10)}`,
      expectedControlEpoch: controlEpoch,
      viewIntent: {
        ownerId: 'phase5-soak',
        workspaceId: `soak-project-${Math.floor(index / 10)}`,
        kind: 'automatic_primary',
        preferredTabId: `soak-tab-${index}`,
        preferredPaneId: `soak-pane-${index}`,
        title: `Soak fixture ${index}`,
        placementGroup: 'Recovered agents',
        visibility: 'visible',
      },
    }), { requestId: newRequest() })
  }

  // Setup/build/launch time is deliberately outside the measured window.
  // The first complete inventory+metric sample establishes the baseline only
  // after all 50 launches have returned and are independently observable.
  fs.writeFileSync(samplesPath, '', { mode: 0o600 })
  const first = await collectSample(0)
  appendSample(first)
  const measurementStartedAtMs = first.capturedAtMs
  while (true) {
    const remaining = desiredDuration - (Date.now() - measurementStartedAtMs)
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(SAMPLE_INTERVAL_MS, remaining)))
    appendSample(await collectSample(samples.length, measurementStartedAtMs))
  }
  if (samples.at(-1)!.elapsedMs < desiredDuration) {
    appendSample(await collectSample(samples.length, measurementStartedAtMs))
  }
} catch (error) {
  failure = error
} finally {
  const cleanup = await h.cleanup()
  fs.mkdirSync(h.evidenceDir, { recursive: true })
  if (!fs.existsSync(samplesPath)) fs.writeFileSync(samplesPath, '', { mode: 0o600 })
  const sampleEvidenceBytes = fs.readFileSync(samplesPath)
  const brokerPath = path.join(h.evidenceDir, SOAK_BROKER_FILE)
  const cleanupPath = path.join(h.evidenceDir, SOAK_CLEANUP_FILE)
  if (!fs.existsSync(brokerPath)) fs.writeFileSync(brokerPath, '', { mode: 0o600 })
  const brokerEvidenceBytes = fs.readFileSync(brokerPath)
  const cleanupEvidenceBytes = fs.readFileSync(cleanupPath)
  const unsafeBrokerAttempts = h.broker?.unsafeAttempts?.().length ?? 0
  const evidenceRun = runtimeSoakEvidenceRun(h.candidateSha, h.runId)
  const first = samples[0]
  const last = samples.at(-1)
  const errors = [failure ? safeError(failure) : null, ...cleanup.errors].filter((value): value is string => !!value)
  const receipt: RuntimeSoakReceipt = {
    schemaVersion: 2,
    status: 'FAIL',
    candidateSha: h.candidateSha,
    runtimeImage: h.imageRef,
    receiptRunId: h.runId,
    evidenceRun,
    desiredWorkloads: workloads,
    measurement: {
      startedAtMs: first?.capturedAtMs ?? 0,
      endedAtMs: last?.capturedAtMs ?? 0,
      durationMs: first && last ? last.capturedAtMs - first.capturedAtMs : 0,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    },
    retentionBounds: {
      terminalSpoolsBytes: SOAK_MAX_TERMINAL_SPOOL_BYTES,
      runtimeLogsBytes: SOAK_MAX_RUNTIME_LOG_BYTES,
    },
    artifacts: {
      samples: {
        path: `${evidenceRun}/${SOAK_SAMPLES_FILE}`,
        sha256: sampleDigest(sampleEvidenceBytes),
      },
      broker: {
        path: `${evidenceRun}/${SOAK_BROKER_FILE}`,
        sha256: sampleDigest(brokerEvidenceBytes),
      },
      cleanup: {
        path: `${evidenceRun}/${SOAK_CLEANUP_FILE}`,
        sha256: sampleDigest(cleanupEvidenceBytes),
      },
    },
    cleanup: {
      verified: cleanup.ok,
      unsafeBrokerAttempts,
      errors: cleanup.errors,
    },
    errors,
  }
  if (errors.length === 0 && cleanup.ok && unsafeBrokerAttempts === 0) {
    try {
      receipt.status = 'PASS'
      receipt.summary = validateRuntimeSoakReceipt({
        candidateSha: h.candidateSha,
        runtimeImage: h.imageRef,
        receipt,
        sampleEvidenceBytes,
        brokerEvidenceBytes,
        cleanupEvidenceBytes,
      }).summary
      validateRuntimeSoakReceipt({
        candidateSha: h.candidateSha,
        runtimeImage: h.imageRef,
        receipt,
        sampleEvidenceBytes,
        brokerEvidenceBytes,
        cleanupEvidenceBytes,
      })
    } catch (error) {
      receipt.status = 'FAIL'
      receipt.errors.push(safeError(error))
      delete receipt.summary
    }
  }
  const target = process.env.FRESHELL_RUNTIME_PHASE5_SOAK_RECEIPT
    || path.join(h.evidenceDir, defaultReceiptFileName('FRESHELL_RUNTIME_PHASE5_SOAK_RECEIPT'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(receipt, null, 2), { mode: 0o600 })
  console.log(`[phase5-soak] receipt: ${target}`)
  console.log(`[phase5-soak] status=${receipt.status} samples=${samples.length} durationMs=${receipt.measurement.durationMs}`)
  if (receipt.status !== 'PASS') process.exitCode = 1
}
