import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  SOAK_MAX_RUNTIME_LOG_BYTES,
  SOAK_MAX_SAMPLE_GAP_MS,
  SOAK_MAX_TERMINAL_SPOOL_BYTES,
  SOAK_MIN_DURATION_MS,
  validateRuntimeSoakReceipt,
} from '../../../../scripts/testing/runtime-soak-evidence.js'

const candidateSha = 'a'.repeat(40)
const runtimeImage = `sha256:${'b'.repeat(64)}`
const receiptRunId = 'phase5-soak-test'
const evidenceRun = `.runtime-evidence/${candidateSha}/${receiptRunId}`

type MutableSample = ReturnType<typeof validSamples>[number]

function desiredWorkloads() {
  return Array.from({ length: 50 }, (_, index) => ({
    soulId: `soul-${String(index).padStart(2, '0')}`,
    fixture: index === 47 ? 'cpu_burner'
      : index === 48 ? 'memory_allocator'
        : index === 49 ? 'descendant_spawner'
          : 'heartbeat',
  }))
}

function validSamples() {
  const workloads = desiredWorkloads()
  const intervalMs = SOAK_MAX_SAMPLE_GAP_MS
  const sampleCount = Math.ceil(SOAK_MIN_DURATION_MS / intervalMs) + 1
  const startedAtMs = 2_000_000_000_000
  return Array.from({ length: sampleCount }, (_, sequence) => {
    const elapsedMs = sequence === sampleCount - 1
      ? SOAK_MIN_DURATION_MS
      : sequence * intervalMs
    return {
      schemaVersion: 1,
      sequence,
      capturedAtMs: startedAtMs + elapsedMs,
      elapsedMs,
      inventoryRevision: 100 + sequence,
      desiredSoulIds: workloads.map(({ soulId }) => soulId),
      souls: workloads.map(({ soulId, fixture }) => ({
        soulId,
        fixture,
        incarnationId: `incarnation-${soulId}`,
        desiredState: 'running',
        launchState: 'running',
        recoveryState: 'live',
        runningWriters: 1,
        lostIncarnations: 0,
      })),
      metrics: workloads.map(({ soulId, fixture }) => ({
        soulId,
        fixture,
        incarnationId: `incarnation-${soulId}`,
        cpuUsageUsec: sequence * 10_000,
        cpuThrottledUsec: fixture === 'cpu_burner' ? sequence * 1_000 : 0,
        cpuNrThrottled: fixture === 'cpu_burner' ? sequence : 0,
        memoryCurrentBytes: fixture === 'memory_allocator' ? 40 * 1024 * 1024 : 8 * 1024 * 1024,
        memoryPeakBytes: fixture === 'memory_allocator' ? 40 * 1024 * 1024 : 8 * 1024 * 1024,
        memoryLimitBytes: fixture === 'memory_allocator' ? 64 * 1024 * 1024 : 64 * 1024 * 1024,
        memoryOom: 0,
        memoryOomKill: 0,
        pidsCurrent: fixture === 'descendant_spawner' ? 4 : 2,
        pidsMax: fixture === 'descendant_spawner' ? 8 : 16,
      })),
      pendingLossNotices: 0,
      retainedBytes: {
        terminalSpools: 1024,
        runtimeLogs: 2048 + sequence,
      },
    }
  })
}

function encode(samples: MutableSample[]): Buffer {
  return Buffer.from(`${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`)
}

function receiptFor(samples: MutableSample[]) {
  const bytes = encode(samples)
  const brokerBytes = Buffer.from('{"unsafeAttempt":false,"operation":"launch"}\n')
  const cleanupBytes = Buffer.from('{"ok":true,"errors":[],"unsafeBrokerAttempts":[]}\n')
  const first = samples[0]
  const last = samples.at(-1)!
  return {
    bytes,
    receipt: {
      schemaVersion: 2,
      status: 'PASS',
      candidateSha,
      runtimeImage,
      receiptRunId,
      evidenceRun,
      desiredWorkloads: desiredWorkloads(),
      measurement: {
        startedAtMs: first?.capturedAtMs ?? 0,
        endedAtMs: last?.capturedAtMs ?? 0,
        durationMs: first && last ? last.capturedAtMs - first.capturedAtMs : 0,
        sampleIntervalMs: 5_000,
      },
      retentionBounds: {
        terminalSpoolsBytes: SOAK_MAX_TERMINAL_SPOOL_BYTES,
        runtimeLogsBytes: SOAK_MAX_RUNTIME_LOG_BYTES,
      },
      artifacts: {
        samples: {
          path: `${evidenceRun}/phase5-soak-samples.jsonl`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        broker: {
          path: `${evidenceRun}/broker.jsonl`,
          sha256: createHash('sha256').update(brokerBytes).digest('hex'),
        },
        cleanup: {
          path: `${evidenceRun}/cleanup.json`,
          sha256: createHash('sha256').update(cleanupBytes).digest('hex'),
        },
      },
      cleanup: { verified: true, unsafeBrokerAttempts: 0, errors: [] },
      errors: [],
    },
    brokerBytes,
    cleanupBytes,
  }
}

function validate(samples = validSamples(), mutateReceipt?: (receipt: any) => void) {
  const { bytes, brokerBytes, cleanupBytes, receipt } = receiptFor(samples)
  mutateReceipt?.(receipt)
  return validateRuntimeSoakReceipt({
    candidateSha,
    runtimeImage,
    receipt,
    sampleEvidenceBytes: bytes,
    brokerEvidenceBytes: brokerBytes,
    cleanupEvidenceBytes: cleanupBytes,
  })
}

describe('Phase 5 soak evidence', () => {
  it('derives a pass from continuous samples and actual pressure observations', () => {
    const result = validate()
    expect(result.summary).toMatchObject({
      durationMs: SOAK_MIN_DURATION_MS,
      desiredSouls: 50,
      cpuThrottlingObserved: true,
      memoryPressureObserved: true,
      pidPressureObserved: true,
      duplicateWriters: 0,
      falseLossNotices: 0,
      maxTerminalSpoolBytes: 1024,
    })
    expect(result.samples).toHaveLength(Math.ceil(SOAK_MIN_DURATION_MS / SOAK_MAX_SAMPLE_GAP_MS) + 1)
  })

  it('measures the full 30 minutes between first and final samples', () => {
    const samples = validSamples()
    samples.pop()
    expect(() => validate(samples, (receipt) => {
      receipt.durationMs = SOAK_MIN_DURATION_MS
      receipt.desiredSouls = 50
      receipt.cpuPressure = true
      receipt.memoryPressure = true
      receipt.pidPressure = true
    })).toThrow(/at least 30 minutes/i)
  })

  it('rejects missing samples, non-monotonic clocks, and coverage gaps', () => {
    expect(() => validate([])).toThrow(/contains no samples/i)

    const backwards = validSamples()
    backwards[2].capturedAtMs = backwards[1].capturedAtMs
    expect(() => validate(backwards)).toThrow(/strictly monotonic/i)

    const gap = validSamples()
    gap[2].capturedAtMs += 1
    gap[2].elapsedMs += 1
    expect(() => validate(gap)).toThrow(/sample gap/i)
  })

  it('requires one stable unique desired workload set in every sample', () => {
    const duplicate = validSamples()
    duplicate[3].desiredSoulIds[1] = duplicate[3].desiredSoulIds[0]
    expect(() => validate(duplicate)).toThrow(/desired soul IDs.*unique/i)

    const changed = validSamples()
    changed[3].desiredSoulIds[1] = 'soul-replacement'
    expect(() => validate(changed)).toThrow(/stable desired workload set/i)

    const reincarnated = validSamples()
    reincarnated[3].souls[1].incarnationId = 'incarnation-replacement'
    reincarnated[3].metrics[1].incarnationId = 'incarnation-replacement'
    expect(() => validate(reincarnated)).toThrow(/stable incarnation/i)
  })

  it('requires current persistent running intent and exactly one live writer', () => {
    const stopped = validSamples()
    stopped[4].souls[2].desiredState = 'stopped'
    expect(() => validate(stopped)).toThrow(/desiredState=running/i)

    const duplicate = validSamples()
    duplicate[4].souls[2].runningWriters = 2
    expect(() => validate(duplicate)).toThrow(/exactly one running writer/i)

    const lost = validSamples()
    lost[4].souls[2].recoveryState = 'lost'
    expect(() => validate(lost)).toThrow(/recoveryState=live/i)

    const historicalLost = validSamples()
    historicalLost[4].souls[2].lostIncarnations = 1
    expect(() => validate(historicalLost)).toThrow(/zero LOST persisted incarnations/i)
  })

  it('fails closed when any desired soul metric is missing or invalid', () => {
    const missing = validSamples()
    missing[5].metrics.pop()
    expect(() => validate(missing)).toThrow(/metric coverage/i)

    const empty = validSamples()
    empty[5].metrics = []
    expect(() => validate(empty)).toThrow(/metric coverage/i)

    const invalid = validSamples()
    invalid[5].metrics[0].memoryCurrentBytes = Number.NaN
    expect(() => validate(invalid)).toThrow(/finite non-negative integer/i)
  })

  it('requires observed CPU throttling rather than CPU usage alone', () => {
    const samples = validSamples()
    for (const sample of samples) {
      const cpu = sample.metrics.find((metric) => metric.fixture === 'cpu_burner')!
      cpu.cpuThrottledUsec = 0
      cpu.cpuNrThrottled = 0
    }
    expect(() => validate(samples)).toThrow(/CPU throttling/i)
  })

  it('requires observed memory utilization or an OOM-pressure increment', () => {
    const samples = validSamples()
    for (const sample of samples) {
      const memory = sample.metrics.find((metric) => metric.fixture === 'memory_allocator')!
      memory.memoryCurrentBytes = 1
      memory.memoryPeakBytes = 1
    }
    expect(() => validate(samples)).toThrow(/memory pressure/i)
  })

  it('does not mistake a low configured PID limit for actual PID pressure', () => {
    const samples = validSamples()
    for (const sample of samples) {
      const pids = sample.metrics.find((metric) => metric.fixture === 'descendant_spawner')!
      pids.pidsCurrent = 1
      pids.pidsMax = 8
    }
    expect(() => validate(samples)).toThrow(/PID pressure/i)
  })

  it('rejects false loss notices and actual retained-byte overruns', () => {
    const notice = validSamples()
    notice[6].pendingLossNotices = 1
    expect(() => validate(notice)).toThrow(/loss notice/i)

    const spool = validSamples()
    spool[6].retainedBytes.terminalSpools = SOAK_MAX_TERMINAL_SPOOL_BYTES + 1
    expect(() => validate(spool)).toThrow(/terminal spool/i)

    const log = validSamples()
    log[6].retainedBytes.runtimeLogs = SOAK_MAX_RUNTIME_LOG_BYTES + 1
    expect(() => validate(log)).toThrow(/runtime log/i)
  })

  it('binds PASS to the candidate, runtime image, run path, digest, and cleanup', () => {
    expect(() => validate(validSamples(), (receipt) => { receipt.candidateSha = 'c'.repeat(40) }))
      .toThrow(/candidate SHA/i)
    expect(() => validate(validSamples(), (receipt) => { receipt.runtimeImage = `sha256:${'d'.repeat(64)}` }))
      .toThrow(/runtime image/i)
    expect(() => validate(validSamples(), (receipt) => { receipt.artifacts.samples.path = '../samples.jsonl' }))
      .toThrow(/artifact path/i)
    expect(() => validate(validSamples(), (receipt) => { receipt.artifacts.samples.sha256 = '0'.repeat(64) }))
      .toThrow(/digest mismatch/i)
    expect(() => validate(validSamples(), (receipt) => { receipt.cleanup.verified = false }))
      .toThrow(/cleanup/i)
    expect(() => validate(validSamples(), (receipt) => { receipt.status = 'FAIL' }))
      .toThrow(/status is not PASS/i)
  })

  it('derives broker safety and cleanup from their hashed artifacts', () => {
    const samples = validSamples()
    const unsafe = receiptFor(samples)
    unsafe.brokerBytes = Buffer.from('{"unsafeAttempt":true,"operation":"stop"}\n')
    unsafe.receipt.artifacts.broker.sha256 = createHash('sha256').update(unsafe.brokerBytes).digest('hex')
    expect(() => validateRuntimeSoakReceipt({
      candidateSha,
      runtimeImage,
      receipt: unsafe.receipt,
      sampleEvidenceBytes: unsafe.bytes,
      brokerEvidenceBytes: unsafe.brokerBytes,
      cleanupEvidenceBytes: unsafe.cleanupBytes,
    })).toThrow(/unsafe attempt/i)

    const dirty = receiptFor(samples)
    dirty.cleanupBytes = Buffer.from('{"ok":false,"errors":["owned runtime remained"],"unsafeBrokerAttempts":[]}\n')
    dirty.receipt.artifacts.cleanup.sha256 = createHash('sha256').update(dirty.cleanupBytes).digest('hex')
    expect(() => validateRuntimeSoakReceipt({
      candidateSha,
      runtimeImage,
      receipt: dirty.receipt,
      sampleEvidenceBytes: dirty.bytes,
      brokerEvidenceBytes: dirty.brokerBytes,
      cleanupEvidenceBytes: dirty.cleanupBytes,
    })).toThrow(/hashed cleanup evidence/i)
  })
})
