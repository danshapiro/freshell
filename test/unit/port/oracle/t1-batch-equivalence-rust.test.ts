import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  startExternalServer,
  type ExternalServerHandle,
} from '../../../../port/oracle/harness/external-server.js'
import {
  capturePtyScenario,
  hexDiff,
  type CapturedBatch,
  type PtyCaptureResult,
} from '../../../../port/oracle/harness/pty-capture.js'
import { BATCH_PTY_SCENARIOS } from '../../../../port/oracle/fixtures/batch-pty-scenarios.js'
import { PTY_SCENARIOS } from '../../../../port/oracle/fixtures/pty-scenarios.js'

/** T1 batch wire behavior against committed Rust byte fixtures. */

const BASELINE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../port/oracle/baselines/pty',
)
const BATCH_CAP = { capabilities: { terminalOutputBatchV1: true } }
const VALID_BARRIER_REASONS = new Set(['control', 'osc52', 'request_mode', 'turn_complete', 'startup_probe'])
const SHARED_NAMES = new Set(PTY_SCENARIOS.map((scenario) => scenario.name))

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForPidGone(pid: number, budgetMs = 10_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (!pidAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !pidAlive(pid)
}

const utf16Len = (value: string) => value.length

function reconstructByUtf16(batch: CapturedBatch): string {
  let previous = 0
  let output = ''
  for (const segment of batch.segments) {
    output += batch.data.slice(previous, segment.endOffset)
    previous = segment.endOffset
  }
  return output
}

interface Boot {
  pid: number
  port: number
  batch: Map<string, PtyCaptureResult>
  legacy: Map<string, PtyCaptureResult>
}

describe('T1 Rust terminal.output.batch baseline', () => {
  const spawned: ExternalServerHandle[] = []
  let boot: Boot | null = null

  beforeAll(async () => {
    const server = await startExternalServer({ provider: 'oracle-t1-batch-rust' })
    spawned.push(server)
    const batch = new Map<string, PtyCaptureResult>()
    const legacy = new Map<string, PtyCaptureResult>()
    try {
      for (const scenario of BATCH_PTY_SCENARIOS) {
        batch.set(scenario.name, await capturePtyScenario(server, scenario, BATCH_CAP))
        legacy.set(scenario.name, await capturePtyScenario(server, scenario))
      }
      boot = { pid: server.pid, port: server.port, batch, legacy }
    } finally {
      await server.stop()
    }
  }, 300_000)

  afterAll(async () => {
    for (const server of spawned) await server.stop().catch(() => {})
  })

  it('captures batch and legacy frames from one owned Rust server', () => {
    expect(boot).toBeTruthy()
    expect(boot!.port).not.toBe(3001)
    expect(boot!.pid).toBeGreaterThan(0)
    expect(boot!.batch.size).toBe(BATCH_PTY_SCENARIOS.length)
    expect(boot!.legacy.size).toBe(BATCH_PTY_SCENARIOS.length)
  })

  for (const scenario of BATCH_PTY_SCENARIOS) {
    it(`matches the committed batch golden: ${scenario.name}`, () => {
      const capture = boot!.batch.get(scenario.name)!
      expect(capture.gaps).toEqual([])
      const committed = fs.readFileSync(path.join(BASELINE_DIR, `${scenario.name}.batch.golden`))
      const meta = JSON.parse(
        fs.readFileSync(path.join(BASELINE_DIR, `${scenario.name}.batch.meta.json`), 'utf8'),
      ) as { sha256: string; byteLength: number }
      if (!capture.goldenBytes.equals(committed)) {
        // eslint-disable-next-line no-console
        console.error(`[T1-batch] Rust mismatch for ${scenario.name}:\n${hexDiff(capture.goldenBytes, committed)}`)
      }
      expect(capture.goldenBytes.equals(committed)).toBe(true)
      expect(capture.sha256).toBe(meta.sha256)
      expect(capture.goldenText).toBe(scenario.expectedGolden)
      expect(committed.length).toBe(meta.byteLength)
    })

    it(`preserves bytes when batch framing is disabled: ${scenario.name}`, () => {
      const batch = boot!.batch.get(scenario.name)!
      const legacy = boot!.legacy.get(scenario.name)!
      expect(batch.goldenBytes.equals(legacy.goldenBytes)).toBe(true)
    })

    it(`gates batch and legacy wire message types: ${scenario.name}`, () => {
      const batch = boot!.batch.get(scenario.name)!
      const legacy = boot!.legacy.get(scenario.name)!
      expect(batch.outputTypeCounts['terminal.output.batch'] ?? 0).toBeGreaterThan(0)
      expect(batch.outputTypeCounts['terminal.output'] ?? 0).toBe(0)
      expect(legacy.outputTypeCounts['terminal.output'] ?? 0).toBeGreaterThan(0)
      expect(legacy.outputTypeCounts['terminal.output.batch'] ?? 0).toBe(0)
    })

    it(`satisfies batch structural invariants: ${scenario.name}`, () => {
      const capture = boot!.batch.get(scenario.name)!
      expect(capture.outputBatches.length).toBeGreaterThan(0)
      for (const batch of capture.outputBatches) {
        expect(batch.segments.length).toBeGreaterThan(0)
        expect(batch.seqStart).toBe(batch.segments[0].seqStart)
        expect(batch.seqEnd).toBe(batch.segments[batch.segments.length - 1].seqEnd)
        let previous = 0
        for (const segment of batch.segments) {
          expect(segment.endOffset).toBeGreaterThanOrEqual(previous)
          expect(segment.rawFrameCount).toBe(Math.max(1, segment.seqEnd - segment.seqStart + 1))
          if (segment.barrier !== undefined) expect(VALID_BARRIER_REASONS.has(segment.barrier)).toBe(true)
          previous = segment.endOffset
        }
        expect(batch.segments[batch.segments.length - 1].endOffset).toBe(utf16Len(batch.data))
        expect(reconstructByUtf16(batch)).toBe(batch.data)
        expect(batch.rawByteLength).toBe(batch.serializedBytes)
        expect(batch.serializedBytes).toBeGreaterThan(Buffer.byteLength(batch.data, 'utf8'))
      }
    })
  }

  it('proves multibyte offsets count UTF-16 code units', () => {
    const capture = boot!.batch.get('multibyte-utf16')!
    expect(capture.goldenText).toBe('a\u{1F600}b\u4e2d\u6587\r\n')
    expect(Buffer.byteLength(capture.goldenText, 'utf8')).toBeGreaterThan(utf16Len(capture.goldenText))
    const withEmoji = capture.outputBatches.filter((batch) => batch.data.includes('\u{1F600}'))
    expect(withEmoji.length).toBeGreaterThan(0)
    for (const batch of withEmoji) {
      const span = batch.segments[batch.segments.length - 1].endOffset
      expect(span).toBe(utf16Len(batch.data))
      expect(span).toBeLessThan(Buffer.byteLength(batch.data, 'utf8'))
    }
  })

  for (const scenario of BATCH_PTY_SCENARIOS) {
    if (!SHARED_NAMES.has(scenario.name)) continue
    it(`keeps batch and legacy committed fixtures equal: ${scenario.name}`, () => {
      const batch = fs.readFileSync(path.join(BASELINE_DIR, `${scenario.name}.batch.golden`))
      const legacy = fs.readFileSync(path.join(BASELINE_DIR, `${scenario.name}.golden`))
      expect(batch.equals(legacy)).toBe(true)
    })
  }

  it('keeps fixture comparison sensitive to a one-byte mutation', () => {
    const scenario = BATCH_PTY_SCENARIOS[0]
    const committed = fs.readFileSync(path.join(BASELINE_DIR, `${scenario.name}.batch.golden`))
    const mutated = Buffer.from(committed)
    mutated[0] ^= 1
    expect(boot!.batch.get(scenario.name)!.goldenBytes.equals(committed)).toBe(true)
    expect(boot!.batch.get(scenario.name)!.goldenBytes.equals(mutated)).toBe(false)
  })

  it('reaps the owned Rust server process', async () => {
    expect(await waitForPidGone(boot!.pid), `Rust server ${boot!.pid} should be gone`).toBe(true)
  })
})
