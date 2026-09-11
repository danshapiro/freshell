export const SOAK_MIN_DURATION_MS = 30 * 60 * 1_000

export const SOAK_MIN_DESIRED_SOULS = 50

export const SOAK_MAX_SAMPLE_GAP_MS = 15_000

export const SOAK_MAX_COLLECTION_WINDOW_MS = 10_000

export const SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES = 1024 * 1024

export const SOAK_MAX_TERMINAL_SPOOL_BYTES = SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES + 2 * 64 * 1024

export const SOAK_MAX_RUNTIME_LOG_BYTES = 64 * 1024 * 1024

export const SOAK_SAMPLES_FILE = 'phase5-soak-samples.jsonl'

export const SOAK_BROKER_FILE = 'broker.jsonl'

export const SOAK_CLEANUP_FILE = 'cleanup.json'

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024

const MIN_MEMORY_UTILIZATION = 0.8

const MIN_PID_OCCUPANCY = 0.8

const FIXTURES = ['heartbeat', 'shell_output', 'cpu_burner', 'memory_allocator', 'descendant_spawner'] as const

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
  schemaVersion: 2
  sequence: number
  /** Informational UTC wall clock only; never used to establish duration. */
  capturedAtMs: number
  collectionStartedMonotonicMs: number
  collectionEndedMonotonicMs: number
  monotonicElapsedMs: number
  inventoryRevision: number
  desiredSoulIds: string[]
  souls: SoakSoulSample[]
  metrics: SoakMetricSample[]
  pendingLossNotices: number
  retainedBytes: {
    terminalSpools: number
    runtimeLogs: number
  }
  terminalOutput: {
    currentBytes: number
    previousBytes: number
  }
}

export type RuntimeSoakSummary = {
  sampleCount: number
  durationMs: number
  maxSampleGapMs: number
  desiredSouls: number
  cpuThrottlingObserved: boolean
  memoryPressureObserved: boolean
  pidPressureObserved: boolean
  duplicateWriters: 0
  falseLossNotices: 0
  maxTerminalSpoolBytes: number
  maxRuntimeLogBytes: number
  terminalOutputObserved: boolean
  terminalOutputGrowthObserved: boolean
  terminalSpoolRotationObserved: boolean
  terminalSpoolBoundedTailObserved: boolean
}

/** The first complete observation is checked before the 30-minute clock starts. */
export function validateRuntimeSoakBaseline(sample: RuntimeSoakSample, workloadsValue: unknown): void {
  const workloads = validateWorkloads(workloadsValue)
  const observation = validateSamples([sample], workloads, true)
  if (!observation.memoryPressureObserved) {
    throw new Error('runtime soak baseline did not demonstrate calibrated memory pressure')
  }
  if (!observation.pidPressureObserved) {
    throw new Error('runtime soak baseline did not demonstrate calibrated PID pressure')
  }
}

function validateSamples(
  samples: RuntimeSoakSample[],
  workloads: SoakWorkload[],
  baselineOnly = false,
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
  let terminalOutputObserved = false
  let terminalOutputGrowthObserved = false
  let terminalSpoolRotationObserved = false
  const firstMetricBySoul = new Map<string, SoakMetricSample>()
  let previousTerminalOutput: { currentBytes: number; previousBytes: number } | undefined

  for (const [index, sample] of samples.entries()) {
    if (sample.schemaVersion !== 2) throw new Error(`runtime soak sample ${index} must use schema v2`)
    integer(sample.sequence, `sample ${index} sequence`)
    if (sample.sequence !== index) throw new Error(`runtime soak sample sequence must be contiguous at ${index}`)
    integer(sample.capturedAtMs, `sample ${index} capturedAtMs`)
    const collectionStarted = integer(sample.collectionStartedMonotonicMs, `sample ${index} collectionStartedMonotonicMs`)
    const collectionEnded = integer(sample.collectionEndedMonotonicMs, `sample ${index} collectionEndedMonotonicMs`)
    const elapsed = integer(sample.monotonicElapsedMs, `sample ${index} monotonicElapsedMs`)
    integer(sample.inventoryRevision, `sample ${index} inventoryRevision`)
    if (collectionEnded <= collectionStarted || collectionEnded - collectionStarted > SOAK_MAX_COLLECTION_WINDOW_MS) {
      throw new Error(`runtime soak sample ${index} collection window exceeds the blind-gap bound`)
    }
    if (index === 0) {
      if (elapsed !== 0) throw new Error('first runtime soak sample must begin at monotonicElapsedMs=0')
    } else {
      const previous = samples[index - 1]
      if (collectionStarted < previous.collectionEndedMonotonicMs
        || collectionEnded <= previous.collectionEndedMonotonicMs
        || elapsed <= previous.monotonicElapsedMs) {
        throw new Error('runtime soak sample clocks must be strictly monotonic')
      }
      if (sample.inventoryRevision < previous.inventoryRevision) {
        throw new Error('runtime soak inventory revision must be monotonic')
      }
      const gap = collectionEnded - previous.collectionEndedMonotonicMs
      maxGapMs = Math.max(maxGapMs, gap)
      if (gap > SOAK_MAX_SAMPLE_GAP_MS) {
        throw new Error(`runtime soak sample gap ${gap}ms exceeds ${SOAK_MAX_SAMPLE_GAP_MS}ms`)
      }
    }
    if (elapsed !== collectionEnded - samples[0].collectionEndedMonotonicMs) {
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
    const terminal = object(sample.terminalOutput, `sample ${index} terminal output`)
    const currentBytes = integer(terminal.currentBytes, `sample ${index} current terminal spool bytes`)
    const previousBytes = integer(terminal.previousBytes, `sample ${index} previous terminal spool bytes`)
    if (currentBytes + previousBytes !== terminalSpools) {
      throw new Error(`runtime soak sample ${index} terminal output bytes differ from retained spool bytes`)
    }
    if (terminalSpools === 0) throw new Error(`runtime soak sample ${index} observed no terminal output`)
    terminalOutputObserved = true
    if (previousTerminalOutput) {
      terminalOutputGrowthObserved ||= currentBytes > previousTerminalOutput.currentBytes
        || previousBytes > previousTerminalOutput.previousBytes
      terminalSpoolRotationObserved ||= currentBytes < previousTerminalOutput.currentBytes
        || previousBytes > previousTerminalOutput.previousBytes
    }
    previousTerminalOutput = { currentBytes, previousBytes }
  }

  const durationMs = samples.at(-1)!.monotonicElapsedMs
  if (!baselineOnly) {
    if (durationMs < SOAK_MIN_DURATION_MS) throw new Error('runtime soak measured duration must be at least 30 minutes')
    if (!cpuThrottlingObserved) throw new Error('runtime soak did not observe an in-window CPU throttling increase')
    if (!memoryPressureObserved) throw new Error('runtime soak did not observe memory pressure from >=80% utilization or OOM events')
    if (!pidPressureObserved) throw new Error('runtime soak did not observe PID pressure from >=80% actual occupancy')
    if (!terminalOutputGrowthObserved) throw new Error('runtime soak did not observe terminal output growth')
  }
  return {
    sampleCount: samples.length,
    durationMs,
    maxSampleGapMs: maxGapMs,
    desiredSouls: workloads.length,
    cpuThrottlingObserved,
    memoryPressureObserved,
    pidPressureObserved,
    duplicateWriters: 0,
    falseLossNotices: 0,
    maxTerminalSpoolBytes,
    maxRuntimeLogBytes,
    terminalOutputObserved,
    terminalOutputGrowthObserved,
    terminalSpoolRotationObserved,
    terminalSpoolBoundedTailObserved: true,
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
    integer(row.runningWriters, `runtime soak ${soulId} runningWriters`)
    integer(row.lostIncarnations, `runtime soak ${soulId} lostIncarnations`)
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
  if (counts.get('shell_output') !== 1) {
    throw new Error('runtime soak must contain exactly one shell_output production workload')
  }
  return workloads
}

function validateMeasurement(value: unknown, samples: RuntimeSoakSample[], summary: RuntimeSoakSummary): void {
  const measurement = object(value, 'runtime soak measurement')
  const first = samples[0]
  const last = samples.at(-1)!
  integer(measurement.startedAtMs, 'runtime soak wall-clock start')
  integer(measurement.endedAtMs, 'runtime soak wall-clock end')
  if (measurement.startedAtMs !== first.capturedAtMs
    || measurement.endedAtMs !== last.capturedAtMs
    || measurement.monotonicStartedMs !== first.collectionEndedMonotonicMs
    || measurement.monotonicEndedMs !== last.collectionEndedMonotonicMs
    || measurement.monotonicDurationMs !== summary.durationMs) {
    throw new Error('runtime soak receipt measurement differs from the measured sample window')
  }
  integer(measurement.monotonicStartedMs, 'runtime soak monotonic start')
  integer(measurement.monotonicEndedMs, 'runtime soak monotonic end')
  integer(measurement.monotonicDurationMs, 'runtime soak monotonic duration')
  const interval = integer(measurement.sampleIntervalMs, 'runtime soak sample interval')
  if (interval <= 0 || interval > SOAK_MAX_SAMPLE_GAP_MS) {
    throw new Error('runtime soak sample interval exceeds the allowed coverage gap')
  }
}

function validateRetentionBounds(value: unknown): void {
  const bounds = object(value, 'runtime soak retention bounds')
  if (bounds.terminalSpoolConfiguredBytes !== SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES
    || bounds.terminalSpoolsBytes !== SOAK_MAX_TERMINAL_SPOOL_BYTES
    || bounds.runtimeLogsBytes !== SOAK_MAX_RUNTIME_LOG_BYTES) {
    throw new Error('runtime soak retention bounds may not weaken the checked-in policy')
  }
}

function validateTerminalInput(value: unknown, workloads: SoakWorkload[]): void {
  const input = object(value, 'runtime soak terminal input proof')
  const shell = workloads.find(({ fixture }) => fixture === 'shell_output')!
  stringEqual(input.soulId, shell.soulId, 'runtime soak terminal input soul ID')
  safeRunId(input.requestId)
  if (input.dispatchCount !== 1) throw new Error('runtime soak terminal input must be dispatched exactly once')
  if (input.spoolConfiguredBytesObserved !== SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES) {
    throw new Error('runtime soak shell workload did not observe the required 1 MiB spool configuration')
  }
}

function validateCleanup(value: unknown): void {
  const cleanup = object(value, 'runtime soak cleanup')
  if (cleanup.verified !== true || cleanup.unsafeBrokerAttempts !== 0
    || !Array.isArray(cleanup.errors) || cleanup.errors.length !== 0) {
    throw new Error('runtime soak cleanup did not verify every owned object with zero unsafe attempts')
  }
}

function parseSamples(bytes: Buffer): RuntimeSoakSample[] {
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error('runtime soak samples exceed the evidence size bound')
  const raw = bytes.toString('utf8')
  const lines = raw.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) throw new Error('runtime soak evidence contains no samples')
  return lines.map((line, index) => {
    try {
      return object(JSON.parse(line), `runtime soak sample ${index}`) as RuntimeSoakSample
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`runtime soak sample ${index} is not valid JSON`)
      throw error
    }
  })
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a safe non-negative integer`)
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
export type RuntimeSoakResult = {
  schemaVersion: 3
  status: 'PASS' | 'FAIL' | 'BLOCKED'
  candidateSha: string
  runtimeImage: string
  receiptRunId: string
  evidenceRun: string
  desiredWorkloads: SoakWorkload[]
  measurement: {
    startedAtMs: number
    endedAtMs: number
    monotonicStartedMs: number
    monotonicEndedMs: number
    monotonicDurationMs: number
    sampleIntervalMs: number
  }
  retentionBounds: {
    terminalSpoolConfiguredBytes: number
    terminalSpoolsBytes: number
    runtimeLogsBytes: number
  }
  terminalInput: {
    soulId: string
    requestId: string
    dispatchCount: 1
    spoolConfiguredBytesObserved: number
  }
  cleanup: {
    verified: boolean
    unsafeBrokerAttempts: number
    errors: string[]
  }
  summary?: RuntimeSoakSummary
  errors: string[]
}

/** Check measured behavior in the soak process; no imported receipt chain. */
export function validateRuntimeSoakResult(input: { result: unknown; sampleEvidenceBytes: Buffer }): { summary: RuntimeSoakSummary; samples: RuntimeSoakSample[] } {
  const result = object(input.result, 'runtime soak result')
  if (result.schemaVersion !== 3) throw new Error('runtime soak result must use schema v3')
  if (result.status !== 'PASS') throw new Error('runtime soak result status is not PASS')
  const workloads = validateWorkloads(result.desiredWorkloads)
  validateTerminalInput(result.terminalInput, workloads)
  const samples = parseSamples(input.sampleEvidenceBytes)
  const summary = validateSamples(samples, workloads)
  validateMeasurement(result.measurement, samples, summary)
  validateRetentionBounds(result.retentionBounds)
  validateCleanup(result.cleanup)
  if (!Array.isArray(result.errors) || result.errors.length) throw new Error('runtime soak result contains errors')
  return { summary, samples }
}

function safeRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('runtime soak receipt run ID is not a safe evidence directory name')
  }
  return value
}
