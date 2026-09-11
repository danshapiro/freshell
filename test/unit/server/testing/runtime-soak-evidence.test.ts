import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  SOAK_MAX_RUNTIME_LOG_BYTES,
  SOAK_MAX_SAMPLE_GAP_MS,
  SOAK_MAX_TERMINAL_SPOOL_BYTES,
  SOAK_MIN_DURATION_MS,
  SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES,
  type RuntimeSoakSample,
  type SoakWorkload,
  validateRuntimeSoakBaseline,
  validateRuntimeSoakResult,
} from '../../../../scripts/testing/runtime-soak-evidence.js'

const candidateSha = 'a'.repeat(40)
const runtimeImage = `sha256:${'b'.repeat(64)}`
const receiptRunId = 'phase5-soak-test'
const evidenceRun = `.runtime-evidence/${candidateSha}/${receiptRunId}`
const emptySha256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex')

type MutableSample = ReturnType<typeof validSamples>[number]

function desiredWorkloads(): SoakWorkload[] {
  return Array.from({ length: 50 }, (_, index) => ({
    soulId: `soul-${String(index).padStart(2, '0')}`,
    fixture: index === 46 ? 'shell_output'
      : index === 47 ? 'cpu_burner'
      : index === 48 ? 'memory_allocator'
        : index === 49 ? 'descendant_spawner'
          : 'heartbeat',
  }))
}

function validSamples(): RuntimeSoakSample[] {
  const workloads = desiredWorkloads()
  const intervalMs = SOAK_MAX_SAMPLE_GAP_MS
  const sampleCount = Math.ceil(SOAK_MIN_DURATION_MS / intervalMs) + 1
  const startedAtMs = 2_000_000_000_000
  const monotonicStartedMs = 50_000
  return Array.from({ length: sampleCount }, (_, sequence) => {
    const elapsedMs = sequence === sampleCount - 1
      ? SOAK_MIN_DURATION_MS
      : sequence * intervalMs
    return {
      schemaVersion: 2 as const,
      sequence,
      capturedAtMs: startedAtMs + elapsedMs,
      collectionStartedMonotonicMs: monotonicStartedMs + elapsedMs - 1_000,
      collectionEndedMonotonicMs: monotonicStartedMs + elapsedMs,
      monotonicElapsedMs: elapsedMs,
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
        memoryLimitBytes: fixture === 'memory_allocator' ? 48 * 1024 * 1024 : 64 * 1024 * 1024,
        memoryOom: 0,
        memoryOomKill: 0,
        pidsCurrent: fixture === 'descendant_spawner' ? 20 : 2,
        pidsMax: fixture === 'descendant_spawner' ? 24 : 16,
      })),
      pendingLossNotices: 0,
      retainedBytes: {
        terminalSpools: 1024 + sequence,
        runtimeLogs: 2048 + sequence,
      },
      terminalOutput: {
        currentBytes: 1024 + sequence,
        previousBytes: 0,
      },
    }
  })
}

function encode(samples: MutableSample[]): Buffer {
  return Buffer.from(`${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`)
}

function receiptFor(samples: MutableSample[]) {
  const bytes = encode(samples)
  const first = samples[0]
  const last = samples.at(-1)!
  return {
    bytes,
    receipt: {
      schemaVersion: 3,
      status: 'PASS',
      candidateSha,
      runtimeImage,
      receiptRunId,
      evidenceRun,
      desiredWorkloads: desiredWorkloads(),
      measurement: {
        startedAtMs: first?.capturedAtMs ?? 0,
        endedAtMs: last?.capturedAtMs ?? 0,
        monotonicStartedMs: first?.collectionEndedMonotonicMs ?? 0,
        monotonicEndedMs: last?.collectionEndedMonotonicMs ?? 0,
        monotonicDurationMs: last?.monotonicElapsedMs ?? 0,
        sampleIntervalMs: 5_000,
      },
      retentionBounds: {
        terminalSpoolConfiguredBytes: SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES,
        terminalSpoolsBytes: SOAK_MAX_TERMINAL_SPOOL_BYTES,
        runtimeLogsBytes: SOAK_MAX_RUNTIME_LOG_BYTES,
      },
      terminalInput: {
        soulId: 'soul-46',
        requestId: 'terminal-input-once',
        dispatchCount: 1,
        spoolConfiguredBytesObserved: SOAK_TERMINAL_SPOOL_CONFIGURED_BYTES,
      },
      cleanup: { verified: true, unsafeBrokerAttempts: 0, errors: [] },
      errors: [],
    },
  }
}

function validate(samples = validSamples(), mutateResult?: (result: any) => void) {
  const { bytes, receipt } = receiptFor(samples)
  mutateResult?.(receipt)
  return validateRuntimeSoakResult({ result: receipt, sampleEvidenceBytes: bytes })
}
describe('direct soak measurements', () => {

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
      maxTerminalSpoolBytes: 1024 + Math.ceil(SOAK_MIN_DURATION_MS / SOAK_MAX_SAMPLE_GAP_MS),
      terminalOutputObserved: true,
      terminalOutputGrowthObserved: true,
      terminalSpoolRotationObserved: false,
      terminalSpoolBoundedTailObserved: true,
    })
    expect(result.samples).toHaveLength(Math.ceil(SOAK_MIN_DURATION_MS / SOAK_MAX_SAMPLE_GAP_MS) + 1)
  })


  it('measures the full 30 minutes between first and final samples', () => {
    const samples = validSamples()
    samples.pop()
    expect(() => validate(samples, (receipt) => {
      receipt.measurement.monotonicDurationMs = SOAK_MIN_DURATION_MS
      receipt.desiredSouls = 50
      receipt.cpuPressure = true
      receipt.memoryPressure = true
      receipt.pidPressure = true
    })).toThrow(/at least 30 minutes/i)
  })


  it('rejects missing samples, non-monotonic clocks, and coverage gaps', () => {
    expect(() => validate([])).toThrow(/contains no samples/i)

    const backwards = validSamples()
    backwards[2].collectionEndedMonotonicMs = backwards[1].collectionEndedMonotonicMs
    backwards[2].collectionStartedMonotonicMs = backwards[2].collectionEndedMonotonicMs - 1_000
    expect(() => validate(backwards)).toThrow(/strictly monotonic/i)

    const gap = validSamples()
    gap[2].collectionStartedMonotonicMs += 1
    gap[2].collectionEndedMonotonicMs += 1
    gap[2].monotonicElapsedMs += 1
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
    expect(() => validate(invalid)).toThrow(/safe non-negative integer/i)
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


  it('requires at least 80% memory occupancy or an actual OOM-pressure increment', () => {
    const samples = validSamples()
    for (const sample of samples) {
      const memory = sample.metrics.find((metric) => metric.fixture === 'memory_allocator')!
      memory.memoryCurrentBytes = 1
      memory.memoryPeakBytes = 1
    }
    expect(() => validate(samples)).toThrow(/memory pressure/i)

    for (const [sequence, sample] of samples.entries()) {
      const memory = sample.metrics.find((metric) => metric.fixture === 'memory_allocator')!
      memory.memoryOom = sequence === 0 ? 0 : 1
    }
    expect(validate(samples).summary.memoryPressureObserved).toBe(true)
  })


  it('does not mistake sub-80% PID occupancy or a low configured limit for pressure', () => {
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


  it('uses monotonic time despite wall-clock rollback and rejects legacy schemas', () => {
    const samples = validSamples()
    for (const sample of samples.slice(2)) sample.capturedAtMs -= 3_600_000
    expect(validate(samples).summary.durationMs).toBe(SOAK_MIN_DURATION_MS)

    expect(() => validate(samples, (receipt) => { receipt.schemaVersion = 2 })).toThrow(/schema v3/i)
    samples[0].schemaVersion = 1 as 2
    expect(() => validate(samples)).toThrow(/sample 0.*schema v2/i)
  })


  it('rejects blind collection windows and aborts an uncalibrated first baseline', () => {
    const blind = validSamples()
    blind[2].collectionStartedMonotonicMs = blind[1].collectionEndedMonotonicMs
    blind[2].collectionEndedMonotonicMs = blind[2].collectionStartedMonotonicMs + SOAK_MAX_SAMPLE_GAP_MS + 1
    blind[2].monotonicElapsedMs = blind[2].collectionEndedMonotonicMs - blind[0].collectionEndedMonotonicMs
    expect(() => validate(blind)).toThrow(/collection window/i)

    const baseline = validSamples()[0]
    const memory = baseline.metrics.find((metric) => metric.fixture === 'memory_allocator')!
    memory.memoryCurrentBytes = Math.floor(memory.memoryLimitBytes * 0.79)
    expect(() => validateRuntimeSoakBaseline(baseline, desiredWorkloads())).toThrow(/baseline.*memory pressure/i)
    memory.memoryCurrentBytes = 40 * 1024 * 1024
    const pids = baseline.metrics.find((metric) => metric.fixture === 'descendant_spawner')!
    pids.pidsCurrent = 19
    expect(() => validateRuntimeSoakBaseline(baseline, desiredWorkloads())).toThrow(/baseline.*PID pressure/i)
  })


  it('requires continuous nonzero terminal output growth from the one shell workload', () => {
    const zero = validSamples()
    for (const sample of zero) {
      sample.retainedBytes.terminalSpools = 0
      sample.terminalOutput.currentBytes = 0
    }
    expect(() => validate(zero)).toThrow(/terminal output/i)

    const flat = validSamples()
    for (const sample of flat) {
      sample.retainedBytes.terminalSpools = 1024
      sample.terminalOutput.currentBytes = 1024
    }
    expect(() => validate(flat)).toThrow(/terminal output growth/i)
  })
  it('requires successful exact cleanup and zero unsafe attempts', () => {
    expect(() => validate(validSamples(), result => { result.cleanup.verified = false })).toThrow(/cleanup/i)
    expect(() => validate(validSamples(), result => { result.cleanup.unsafeBrokerAttempts = 1 })).toThrow(/unsafe|cleanup/i)
    expect(() => validate(validSamples(), result => { result.status = 'FAIL' })).toThrow(/status/i)
  })
  it('rejects unsafe numbers and bounds parser input without echoing its contents', () => {
    const bad = validSamples(); bad[2].capturedAtMs = Number.MAX_SAFE_INTEGER + 1
    expect(() => validate(bad)).toThrow(/safe non-negative integer/i)
    const { receipt } = receiptFor(validSamples())
    expect(() => validateRuntimeSoakResult({ result: receipt, sampleEvidenceBytes: Buffer.from('{SECRET_PAYLOAD') }))
      .toThrowError(/^(?!.*SECRET_PAYLOAD).*not valid JSON/i)
    expect(() => validateRuntimeSoakResult({ result: receipt, sampleEvidenceBytes: Buffer.alloc(16*1024*1024+1) })).toThrow(/size bound/i)
  })
})
