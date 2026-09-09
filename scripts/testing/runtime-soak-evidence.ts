import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SOAK_MIN_DURATION_MS = 30 * 60 * 1_000
export const SOAK_MIN_DESIRED_SOULS = 50
export const SOAK_MAX_SAMPLE_GAP_MS = 15_000
export const SOAK_MAX_TERMINAL_SPOOL_BYTES = 64 * 1024 * 1024
export const SOAK_MAX_RUNTIME_LOG_BYTES = 64 * 1024 * 1024
export const SOAK_SAMPLES_FILE = 'phase5-soak-samples.jsonl'
export const SOAK_BROKER_FILE = 'broker.jsonl'
export const SOAK_CLEANUP_FILE = 'cleanup.json'

const MIN_MEMORY_UTILIZATION = 0.5
const MIN_PID_OCCUPANCY = 0.5
const FIXTURES = ['heartbeat', 'cpu_burner', 'memory_allocator', 'descendant_spawner'] as const

export type SoakFixture = typeof FIXTURES[number]

export type SoakWorkload = {
  soulId: string
  fixture: SoakFixture
}

export type SoakSoulSample = SoakWorkload & {
  incarnationId: string
  desiredState: string
  launchState: string
  recoveryState: string
  runningWriters: number
  lostIncarnations: number
}

export type SoakMetricSample = SoakWorkload & {
  incarnationId: string
  cpuUsageUsec: number
  cpuThrottledUsec: number
  cpuNrThrottled: number
  memoryCurrentBytes: number
  memoryPeakBytes: number
  memoryLimitBytes: number
  memoryOom: number
  memoryOomKill: number
  pidsCurrent: number
  pidsMax: number
}

export type RuntimeSoakSample = {
  schemaVersion: 1
  sequence: number
  capturedAtMs: number
  elapsedMs: number
  inventoryRevision: number
  desiredSoulIds: string[]
  souls: SoakSoulSample[]
  metrics: SoakMetricSample[]
  pendingLossNotices: number
  retainedBytes: {
    terminalSpools: number
    runtimeLogs: number
  }
}

export type RuntimeSoakSummary = {
  sampleCount: number
  durationMs: number
  maxSampleGapMs: number
  desiredSouls: number
  cpuThrottlingObserved: true
  memoryPressureObserved: true
  pidPressureObserved: true
  duplicateWriters: 0
  falseLossNotices: 0
  maxTerminalSpoolBytes: number
  maxRuntimeLogBytes: number
}

export type RuntimeSoakReceipt = {
  schemaVersion: 2
  status: 'PASS' | 'FAIL'
  candidateSha: string
  runtimeImage: string
  receiptRunId: string
  evidenceRun: string
  desiredWorkloads: SoakWorkload[]
  measurement: {
    startedAtMs: number
    endedAtMs: number
    durationMs: number
    sampleIntervalMs: number
  }
  retentionBounds: {
    terminalSpoolsBytes: number
    runtimeLogsBytes: number
  }
  artifacts: {
    samples: { path: string; sha256: string }
    broker: { path: string; sha256: string }
    cleanup: { path: string; sha256: string }
  }
  cleanup: {
    verified: boolean
    unsafeBrokerAttempts: number
    errors: string[]
  }
  summary?: RuntimeSoakSummary
  errors: string[]
}

export type ValidateRuntimeSoakReceiptInput = {
  candidateSha: string
  runtimeImage: string
  receipt: unknown
  sampleEvidenceBytes: Buffer
  brokerEvidenceBytes: Buffer
  cleanupEvidenceBytes: Buffer
}

export type ValidatedRuntimeSoakReceipt = {
  receipt: RuntimeSoakReceipt
  samples: RuntimeSoakSample[]
  summary: RuntimeSoakSummary
  sampleEvidenceBytes: Buffer
}

export type LoadRuntimeSoakReceiptInput = {
  repoRoot: string
  candidateSha: string
  runtimeImage: string
  receipt: unknown
}

/**
 * Pure validation boundary for Phase 5 soak certification. Every acceptance
 * verdict is recomputed from the hashed samples; receipt summary booleans and
 * counts are never treated as authority.
 */
export function validateRuntimeSoakReceipt(
  input: ValidateRuntimeSoakReceiptInput,
): ValidatedRuntimeSoakReceipt {
  const receipt = object(input.receipt, 'runtime soak receipt')
  if (receipt.schemaVersion !== 2) throw new Error('runtime soak receipt must use schema v2')
  if (receipt.status !== 'PASS') throw new Error('runtime soak receipt status is not PASS')
  fullSha(input.candidateSha, 'expected candidate SHA')
  stringEqual(receipt.candidateSha, input.candidateSha, 'runtime soak receipt candidate SHA')
  stringEqual(receipt.runtimeImage, input.runtimeImage, 'runtime soak receipt runtime image')
  const receiptRunId = safeRunId(receipt.receiptRunId)
  const evidenceRun = expectedEvidenceRun(input.candidateSha, receiptRunId)
  stringEqual(receipt.evidenceRun, evidenceRun, 'runtime soak receipt evidence run')

  const artifacts = object(receipt.artifacts, 'runtime soak receipt artifacts')
  validateArtifact(artifacts.samples, evidenceRun, SOAK_SAMPLES_FILE, input.sampleEvidenceBytes)
  validateArtifact(artifacts.broker, evidenceRun, SOAK_BROKER_FILE, input.brokerEvidenceBytes)
  validateArtifact(artifacts.cleanup, evidenceRun, SOAK_CLEANUP_FILE, input.cleanupEvidenceBytes)

  const workloads = validateWorkloads(receipt.desiredWorkloads)
  const samples = parseSamples(input.sampleEvidenceBytes)
  const summary = validateSamples(samples, workloads)
  validateMeasurement(receipt.measurement, samples, summary)
  validateRetentionBounds(receipt.retentionBounds)
  validateCleanup(receipt.cleanup)
  validateBrokerEvidence(input.brokerEvidenceBytes)
  validateCleanupEvidence(input.cleanupEvidenceBytes)
  if (!Array.isArray(receipt.errors) || receipt.errors.length !== 0) {
    throw new Error('runtime soak PASS receipt must contain no errors')
  }
  if (receipt.summary !== undefined && stableJson(receipt.summary) !== stableJson(summary)) {
    throw new Error('runtime soak receipt summary differs from the sample-derived summary')
  }

  return { receipt: receipt as RuntimeSoakReceipt, samples, summary, sampleEvidenceBytes: input.sampleEvidenceBytes }
}

/** Resolve and verify candidate-bound files, then cross the pure boundary. */
export function loadRuntimeSoakReceipt(
  input: LoadRuntimeSoakReceiptInput,
): ValidatedRuntimeSoakReceipt {
  const receipt = object(input.receipt, 'runtime soak receipt')
  fullSha(input.candidateSha, 'expected candidate SHA')
  const receiptRunId = safeRunId(receipt.receiptRunId)
  const evidenceRun = expectedEvidenceRun(input.candidateSha, receiptRunId)
  const repoRoot = fs.realpathSync(input.repoRoot)
  const evidenceDir = path.join(repoRoot, ...evidenceRun.split('/'))
  const stat = fs.lstatSync(evidenceDir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(evidenceDir) !== evidenceDir) {
    throw new Error('runtime soak evidence run must be a real candidate-bound directory')
  }
  const manifest = readJsonObject(path.join(evidenceDir, 'manifest.json'), 'runtime soak run manifest')
  const execution = object(manifest.execution, 'runtime soak run manifest execution')
  stringEqual(execution.candidateSha, input.candidateSha, 'runtime soak run manifest candidate SHA')
  stringEqual(execution.runId, receiptRunId, 'runtime soak run manifest run ID')
  const build = readJsonObject(path.join(evidenceDir, 'build.json'), 'runtime soak build artifact')
  stringEqual(build.candidateSha, input.candidateSha, 'runtime soak build candidate SHA')
  stringEqual(build.runtimeImage, input.runtimeImage, 'runtime soak build runtime image')
  const sampleEvidenceBytes = readRegularFile(path.join(evidenceDir, SOAK_SAMPLES_FILE), 'runtime soak samples')
  const brokerEvidenceBytes = readRegularFile(path.join(evidenceDir, SOAK_BROKER_FILE), 'runtime soak broker evidence')
  const cleanupEvidenceBytes = readRegularFile(path.join(evidenceDir, SOAK_CLEANUP_FILE), 'runtime soak cleanup evidence')
  return validateRuntimeSoakReceipt({
    ...input,
    sampleEvidenceBytes,
    brokerEvidenceBytes,
    cleanupEvidenceBytes,
  })
}

export function sampleDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function runtimeSoakEvidenceRun(candidateSha: string, receiptRunId: string): string {
  return expectedEvidenceRun(candidateSha, receiptRunId)
}

function validateSamples(
  samples: RuntimeSoakSample[],
  workloads: SoakWorkload[],
): RuntimeSoakSummary {
  if (samples.length === 0) throw new Error('runtime soak evidence contains no samples')
  const expectedIds = workloads.map(({ soulId }) => soulId)
  const expectedIdKey = stableJson(expectedIds)
  const fixtureBySoul = new Map(workloads.map((workload) => [workload.soulId, workload.fixture]))
  const incarnationBySoul = new Map<string, string>()
  const previousMetricBySoul = new Map<string, SoakMetricSample>()
  let maxGapMs = 0
  let maxTerminalSpoolBytes = 0
  let maxRuntimeLogBytes = 0
  let memoryPressureObserved = false
  let pidPressureObserved = false
  let cpuThrottlingObserved = false
  const firstMetricBySoul = new Map<string, SoakMetricSample>()

  for (const [index, sample] of samples.entries()) {
    if (sample.schemaVersion !== 1) throw new Error(`runtime soak sample ${index} must use schema v1`)
    integer(sample.sequence, `sample ${index} sequence`)
    if (sample.sequence !== index) throw new Error(`runtime soak sample sequence must be contiguous at ${index}`)
    integer(sample.capturedAtMs, `sample ${index} capturedAtMs`)
    integer(sample.elapsedMs, `sample ${index} elapsedMs`)
    integer(sample.inventoryRevision, `sample ${index} inventoryRevision`)
    if (index === 0) {
      if (sample.elapsedMs !== 0) throw new Error('first runtime soak sample must begin at elapsedMs=0')
    } else {
      const previous = samples[index - 1]
      if (sample.capturedAtMs <= previous.capturedAtMs || sample.elapsedMs <= previous.elapsedMs) {
        throw new Error('runtime soak sample clocks must be strictly monotonic')
      }
      if (sample.inventoryRevision < previous.inventoryRevision) {
        throw new Error('runtime soak inventory revision must be monotonic')
      }
      const gap = sample.capturedAtMs - previous.capturedAtMs
      maxGapMs = Math.max(maxGapMs, gap)
      if (gap > SOAK_MAX_SAMPLE_GAP_MS) {
        throw new Error(`runtime soak sample gap ${gap}ms exceeds ${SOAK_MAX_SAMPLE_GAP_MS}ms`)
      }
    }
    if (sample.elapsedMs !== sample.capturedAtMs - samples[0].capturedAtMs) {
      throw new Error(`runtime soak sample ${index} elapsed time is not anchored to the first measured sample`)
    }
    if (!Array.isArray(sample.desiredSoulIds)) throw new Error(`sample ${index} desired soul IDs are missing`)
    if (new Set(sample.desiredSoulIds).size !== sample.desiredSoulIds.length) {
      throw new Error(`sample ${index} desired soul IDs must be unique`)
    }
    if (stableJson(sample.desiredSoulIds) !== expectedIdKey) {
      throw new Error(`sample ${index} does not preserve the stable desired workload set`)
    }

    validateSoulCoverage(sample, expectedIds, fixtureBySoul, incarnationBySoul, index)
    const metrics = validateMetricCoverage(sample, expectedIds, fixtureBySoul, incarnationBySoul, index)
    for (const metric of metrics) {
      const previous = previousMetricBySoul.get(metric.soulId)
      if (previous) {
        for (const field of ['cpuUsageUsec', 'cpuThrottledUsec', 'cpuNrThrottled', 'memoryOom', 'memoryOomKill'] as const) {
          if (metric[field] < previous[field]) {
            throw new Error(`runtime soak ${metric.soulId}.${field} must be monotonic`)
          }
        }
      } else {
        firstMetricBySoul.set(metric.soulId, metric)
      }
      previousMetricBySoul.set(metric.soulId, metric)
      if (metric.fixture === 'memory_allocator') {
        const baseline = firstMetricBySoul.get(metric.soulId)!
        memoryPressureObserved ||= metric.memoryCurrentBytes / metric.memoryLimitBytes >= MIN_MEMORY_UTILIZATION
          || metric.memoryOom > baseline.memoryOom
          || metric.memoryOomKill > baseline.memoryOomKill
      }
      if (metric.fixture === 'descendant_spawner') {
        pidPressureObserved ||= metric.pidsCurrent / metric.pidsMax >= MIN_PID_OCCUPANCY
      }
      if (metric.fixture === 'cpu_burner') {
        const baseline = firstMetricBySoul.get(metric.soulId)!
        cpuThrottlingObserved ||= metric.cpuNrThrottled > baseline.cpuNrThrottled
          && metric.cpuThrottledUsec > baseline.cpuThrottledUsec
      }
    }

    integer(sample.pendingLossNotices, `sample ${index} pendingLossNotices`)
    if (sample.pendingLossNotices !== 0) throw new Error(`runtime soak sample ${index} observed a false loss notice`)
    const retained = object(sample.retainedBytes, `sample ${index} retained bytes`)
    const terminalSpools = integer(retained.terminalSpools, `sample ${index} terminal spool bytes`)
    const runtimeLogs = integer(retained.runtimeLogs, `sample ${index} runtime log bytes`)
    if (terminalSpools > SOAK_MAX_TERMINAL_SPOOL_BYTES) {
      throw new Error(`runtime soak terminal spool retention exceeded ${SOAK_MAX_TERMINAL_SPOOL_BYTES} bytes`)
    }
    if (runtimeLogs > SOAK_MAX_RUNTIME_LOG_BYTES) {
      throw new Error(`runtime soak runtime log retention exceeded ${SOAK_MAX_RUNTIME_LOG_BYTES} bytes`)
    }
    maxTerminalSpoolBytes = Math.max(maxTerminalSpoolBytes, terminalSpools)
    maxRuntimeLogBytes = Math.max(maxRuntimeLogBytes, runtimeLogs)
  }

  const durationMs = samples.at(-1)!.capturedAtMs - samples[0].capturedAtMs
  if (durationMs < SOAK_MIN_DURATION_MS) throw new Error('runtime soak measured duration must be at least 30 minutes')
  if (!cpuThrottlingObserved) throw new Error('runtime soak did not observe an in-window CPU throttling increase')
  if (!memoryPressureObserved) throw new Error('runtime soak did not observe memory pressure from utilization or OOM events')
  if (!pidPressureObserved) throw new Error('runtime soak did not observe PID pressure from actual occupancy')
  return {
    sampleCount: samples.length,
    durationMs,
    maxSampleGapMs: maxGapMs,
    desiredSouls: workloads.length,
    cpuThrottlingObserved: true,
    memoryPressureObserved: true,
    pidPressureObserved: true,
    duplicateWriters: 0,
    falseLossNotices: 0,
    maxTerminalSpoolBytes,
    maxRuntimeLogBytes,
  }
}

function validateSoulCoverage(
  sample: RuntimeSoakSample,
  expectedIds: string[],
  fixtureBySoul: Map<string, SoakFixture>,
  incarnationBySoul: Map<string, string>,
  index: number,
): void {
  if (!Array.isArray(sample.souls) || sample.souls.length !== expectedIds.length) {
    throw new Error(`runtime soak sample ${index} soul coverage is incomplete`)
  }
  const rows = new Map<string, SoakSoulSample>()
  for (const raw of sample.souls) {
    const row = object(raw, `sample ${index} soul`) as SoakSoulSample
    const soulId = nonEmptyString(row.soulId, `sample ${index} soulId`)
    if (rows.has(soulId)) throw new Error(`runtime soak sample ${index} duplicates soul ${soulId}`)
    rows.set(soulId, row)
  }
  for (const soulId of expectedIds) {
    const row = rows.get(soulId)
    if (!row) throw new Error(`runtime soak sample ${index} is missing soul ${soulId}`)
    stringEqual(row.fixture, fixtureBySoul.get(soulId)!, `runtime soak ${soulId} fixture`)
    const incarnationId = nonEmptyString(row.incarnationId, `runtime soak ${soulId} incarnationId`)
    const stableIncarnation = incarnationBySoul.get(soulId)
    if (stableIncarnation && incarnationId !== stableIncarnation) {
      throw new Error(`runtime soak ${soulId} did not retain a stable incarnation`)
    }
    incarnationBySoul.set(soulId, incarnationId)
    if (row.desiredState !== 'running') throw new Error(`runtime soak ${soulId} must retain current desiredState=running`)
    if (row.launchState !== 'running') throw new Error(`runtime soak ${soulId} must retain launchState=running`)
    if (row.recoveryState !== 'live') throw new Error(`runtime soak ${soulId} must retain recoveryState=live`)
    if (row.runningWriters !== 1) throw new Error(`runtime soak ${soulId} must have exactly one running writer`)
    if (row.lostIncarnations !== 0) throw new Error(`runtime soak ${soulId} must have zero LOST persisted incarnations`)
  }
}

function validateMetricCoverage(
  sample: RuntimeSoakSample,
  expectedIds: string[],
  fixtureBySoul: Map<string, SoakFixture>,
  incarnationBySoul: Map<string, string>,
  index: number,
): SoakMetricSample[] {
  if (!Array.isArray(sample.metrics) || sample.metrics.length !== expectedIds.length) {
    throw new Error(`runtime soak sample ${index} metric coverage is incomplete`)
  }
  const metrics = new Map<string, SoakMetricSample>()
  for (const raw of sample.metrics) {
    const metric = object(raw, `sample ${index} metric`) as SoakMetricSample
    const soulId = nonEmptyString(metric.soulId, `sample ${index} metric soulId`)
    if (metrics.has(soulId)) throw new Error(`runtime soak sample ${index} duplicates metrics for ${soulId}`)
    metrics.set(soulId, metric)
  }
  return expectedIds.map((soulId) => {
    const metric = metrics.get(soulId)
    if (!metric) throw new Error(`runtime soak sample ${index} metric coverage is missing ${soulId}`)
    stringEqual(metric.fixture, fixtureBySoul.get(soulId)!, `runtime soak metric ${soulId} fixture`)
    stringEqual(metric.incarnationId, incarnationBySoul.get(soulId)!, `runtime soak metric ${soulId} incarnation`)
    for (const field of [
      'cpuUsageUsec', 'cpuThrottledUsec', 'cpuNrThrottled',
      'memoryCurrentBytes', 'memoryPeakBytes', 'memoryLimitBytes',
      'memoryOom', 'memoryOomKill', 'pidsCurrent', 'pidsMax',
    ] as const) integer(metric[field], `runtime soak ${soulId}.${field}`)
    if (metric.memoryLimitBytes === 0 || metric.pidsMax === 0) {
      throw new Error(`runtime soak ${soulId} metric limits must be positive`)
    }
    if (metric.memoryCurrentBytes > metric.memoryLimitBytes || metric.pidsCurrent > metric.pidsMax) {
      throw new Error(`runtime soak ${soulId} usage exceeds its reported cgroup limit`)
    }
    return metric
  })
}

function validateWorkloads(value: unknown): SoakWorkload[] {
  if (!Array.isArray(value) || value.length < SOAK_MIN_DESIRED_SOULS) {
    throw new Error(`runtime soak must declare at least ${SOAK_MIN_DESIRED_SOULS} desired workloads`)
  }
  const seen = new Set<string>()
  const counts = new Map<SoakFixture, number>()
  const workloads = value.map((raw, index) => {
    const row = object(raw, `desired workload ${index}`)
    const soulId = nonEmptyString(row.soulId, `desired workload ${index} soulId`)
    if (seen.has(soulId)) throw new Error('runtime soak desired soul IDs must be unique')
    seen.add(soulId)
    if (!FIXTURES.includes(row.fixture)) throw new Error(`runtime soak desired workload ${soulId} has an unknown fixture`)
    const fixture = row.fixture as SoakFixture
    counts.set(fixture, (counts.get(fixture) ?? 0) + 1)
    return { soulId, fixture }
  })
  for (const fixture of ['cpu_burner', 'memory_allocator', 'descendant_spawner'] as const) {
    if (counts.get(fixture) !== 1) throw new Error(`runtime soak must contain exactly one ${fixture} pressure workload`)
  }
  return workloads
}

function validateMeasurement(value: unknown, samples: RuntimeSoakSample[], summary: RuntimeSoakSummary): void {
  const measurement = object(value, 'runtime soak measurement')
  const first = samples[0]
  const last = samples.at(-1)!
  if (measurement.startedAtMs !== first.capturedAtMs
    || measurement.endedAtMs !== last.capturedAtMs
    || measurement.durationMs !== summary.durationMs) {
    throw new Error('runtime soak receipt measurement differs from the measured sample window')
  }
  const interval = integer(measurement.sampleIntervalMs, 'runtime soak sample interval')
  if (interval <= 0 || interval > SOAK_MAX_SAMPLE_GAP_MS) {
    throw new Error('runtime soak sample interval exceeds the allowed coverage gap')
  }
}

function validateRetentionBounds(value: unknown): void {
  const bounds = object(value, 'runtime soak retention bounds')
  if (bounds.terminalSpoolsBytes !== SOAK_MAX_TERMINAL_SPOOL_BYTES
    || bounds.runtimeLogsBytes !== SOAK_MAX_RUNTIME_LOG_BYTES) {
    throw new Error('runtime soak retention bounds may not weaken the checked-in policy')
  }
}

function validateCleanup(value: unknown): void {
  const cleanup = object(value, 'runtime soak cleanup')
  if (cleanup.verified !== true || cleanup.unsafeBrokerAttempts !== 0
    || !Array.isArray(cleanup.errors) || cleanup.errors.length !== 0) {
    throw new Error('runtime soak cleanup did not verify every owned object with zero unsafe attempts')
  }
}

function validateArtifact(
  value: unknown,
  evidenceRun: string,
  fileName: string,
  bytes: Buffer,
): void {
  const artifact = object(value, `runtime soak ${fileName} artifact`)
  stringEqual(artifact.path, `${evidenceRun}/${fileName}`, `runtime soak ${fileName} artifact path`)
  const digest = nonEmptyString(artifact.sha256, `runtime soak ${fileName} artifact SHA-256`)
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`runtime soak ${fileName} artifact has no valid SHA-256 digest`)
  if (sampleDigest(bytes) !== digest) throw new Error(`runtime soak ${fileName} artifact digest mismatch`)
}

function validateBrokerEvidence(bytes: Buffer): void {
  const lines = bytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) throw new Error('runtime soak broker evidence contains no events')
  for (const [index, line] of lines.entries()) {
    let event: Record<string, any>
    try {
      event = object(JSON.parse(line), `runtime soak broker event ${index}`)
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`runtime soak broker event ${index} is not valid JSON`)
      throw error
    }
    if (event.unsafeAttempt === true) throw new Error('runtime soak broker evidence records an unsafe attempt')
  }
}

function validateCleanupEvidence(bytes: Buffer): void {
  let cleanup: Record<string, any>
  try {
    cleanup = object(JSON.parse(bytes.toString('utf8')), 'runtime soak cleanup evidence')
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('runtime soak cleanup evidence is not valid JSON')
    throw error
  }
  if (cleanup.ok !== true || !Array.isArray(cleanup.errors) || cleanup.errors.length !== 0
    || !Array.isArray(cleanup.unsafeBrokerAttempts) || cleanup.unsafeBrokerAttempts.length !== 0) {
    throw new Error('runtime soak hashed cleanup evidence did not verify exact safe cleanup')
  }
}

function parseSamples(bytes: Buffer): RuntimeSoakSample[] {
  const raw = bytes.toString('utf8')
  const lines = raw.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) throw new Error('runtime soak evidence contains no samples')
  return lines.map((line, index) => {
    try {
      return object(JSON.parse(line), `runtime soak sample ${index}`) as RuntimeSoakSample
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`runtime soak sample ${index} is not valid JSON: ${error.message}`)
      throw error
    }
  })
}

function expectedEvidenceRun(candidateSha: string, receiptRunId: string): string {
  fullSha(candidateSha, 'candidate SHA')
  safeRunId(receiptRunId)
  return `.runtime-evidence/${candidateSha}/${receiptRunId}`
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error(`${label} is not a full hexadecimal commit ID`)
  return value
}

function safeRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('runtime soak receipt run ID is not a safe evidence directory name')
  }
  return value
}

function readRegularFile(filePath: string, label: string): Buffer {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
  return fs.readFileSync(filePath)
}

function readJsonObject(filePath: string, label: string): Record<string, any> {
  try {
    return object(JSON.parse(readRegularFile(filePath, label).toString('utf8')), label)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${error.message}`)
    throw error
  }
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
  return value as Record<string, any>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative integer`)
  }
  return value
}

function stringEqual(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match the candidate-bound evidence`)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
