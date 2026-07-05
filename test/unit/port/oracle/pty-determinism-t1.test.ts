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
  hexHead,
  type PtyCaptureResult,
} from '../../../../port/oracle/harness/pty-capture.js'
import { PTY_SCENARIOS } from '../../../../port/oracle/fixtures/pty-scenarios.js'

const BASELINE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../port/oracle/baselines/pty',
)

/**
 * T1 determinism — the byte-stream rung of the equivalence oracle.
 *
 * Boots the ORIGINAL (node) freshell server as an isolated external process,
 * drives each fixed shell scenario through a REAL pty over the live WebSocket
 * wire, and captures the exact terminal output bytes between sentinels. It then
 * boots a SECOND fully independent server and captures again. For every scenario
 * the two captures MUST be byte-identical — that byte-stability is what lets the
 * Rust port be graded against a committed golden.
 *
 * A mismatch is a real finding (residual nondeterminism), printed as a hex diff.
 *
 * SAFETY: only spawns its own node servers on ephemeral loopback ports and reaps
 * them by tracked pid. It never binds :3001 and never touches the user's live
 * freshell (pid 1262455).
 */

const LIVE_SERVER_PID = 1262455

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
    await new Promise((r) => setTimeout(r, 100))
  }
  return !pidAlive(pid)
}

interface BootCapture {
  pid: number
  port: number
  results: Map<string, PtyCaptureResult>
}

/**
 * Boot a fresh isolated server, capture every scenario on it (each on its own
 * fresh terminal + WS client), then stop/reap the server. Returns the boot's pid
 * + port and the per-scenario captures.
 */
async function captureAllOnFreshBoot(tag: string): Promise<BootCapture> {
  const server: ExternalServerHandle = await startExternalServer({ provider: `oracle-t1-${tag}` })
  const results = new Map<string, PtyCaptureResult>()
  try {
    for (const scenario of PTY_SCENARIOS) {
      const result = await capturePtyScenario(server, scenario)
      results.set(scenario.name, result)
      // eslint-disable-next-line no-console
      console.log(
        `[T1] boot ${tag} "${scenario.name}": ${result.goldenBytes.length}B ` +
          `sha256=${result.sha256.slice(0, 12)}… frames=${result.frameCount} ` +
          `types=${JSON.stringify(result.outputTypeCounts)} ` +
          `reassembled=${result.reassembledLength} gaps=${result.gaps.length}`,
      )
    }
    return { pid: server.pid, port: server.port, results }
  } finally {
    await server.stop()
  }
}

describe('T1 PTY byte-stream golden determinism (original server)', () => {
  let liveAliveAtStart = false
  let bootA: BootCapture | null = null
  let bootB: BootCapture | null = null

  beforeAll(async () => {
    liveAliveAtStart = pidAlive(LIVE_SERVER_PID)
    bootA = await captureAllOnFreshBoot('a')
    bootB = await captureAllOnFreshBoot('b')
  }, 120_000)

  afterAll(async () => {
    // Servers are stopped inside captureAllOnFreshBoot's finally; nothing to
    // reap here. This is a defensive net only.
    for (const boot of [bootA, bootB]) {
      if (boot && pidAlive(boot.pid)) {
        try {
          process.kill(boot.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  })

  it('booted two distinct isolated servers — never :3001 / the live pid', () => {
    expect(bootA, 'boot A must have produced captures').toBeTruthy()
    expect(bootB, 'boot B must have produced captures').toBeTruthy()
    expect(bootA!.pid).toBeGreaterThan(0)
    expect(bootB!.pid).toBeGreaterThan(0)
    expect(bootA!.pid).not.toBe(bootB!.pid)
    for (const boot of [bootA!, bootB!]) {
      expect(boot.pid).not.toBe(LIVE_SERVER_PID)
      expect(boot.port).not.toBe(3001)
    }
  })

  for (const scenario of PTY_SCENARIOS) {
    it(`captures a byte-identical golden across two fresh boots: ${scenario.name}`, () => {
      const a = bootA!.results.get(scenario.name)
      const b = bootB!.results.get(scenario.name)
      expect(a, `boot A missing capture for ${scenario.name}`).toBeTruthy()
      expect(b, `boot B missing capture for ${scenario.name}`).toBeTruthy()

      // No lost bytes (a gap would invalidate the reassembled stream).
      expect(a!.gaps, `boot A saw output gaps for ${scenario.name}`).toEqual([])
      expect(b!.gaps, `boot B saw output gaps for ${scenario.name}`).toEqual([])

      const identical = a!.goldenBytes.equals(b!.goldenBytes)
      if (!identical) {
        // eslint-disable-next-line no-console
        console.error(
          `[T1] BYTE MISMATCH for "${scenario.name}" across boots:\n` +
            hexDiff(a!.goldenBytes, b!.goldenBytes),
        )
      }
      expect(
        identical,
        `golden bytes for "${scenario.name}" must be byte-identical across two fresh boots`,
      ).toBe(true)
      expect(a!.sha256).toBe(b!.sha256)

      // Sanity: the captured bytes match the documented expectation (also proves
      // the sentinel extraction is correct and no shell echo leaked in).
      expect(a!.goldenText).toBe(scenario.expectedGolden)

      // Envelope shape is stable across boots once ids/seqs are normalised.
      expect(a!.normalizedEnvelope.created).toBe(b!.normalizedEnvelope.created)
      expect(a!.normalizedEnvelope.attachReady).toBe(b!.normalizedEnvelope.attachReady)
    })
  }

  it('reaped both spawned server pids and left the live :3001 server untouched', async () => {
    for (const boot of [bootA!, bootB!]) {
      const gone = await waitForPidGone(boot.pid)
      expect(gone, `spawned server pid ${boot.pid} should be reaped`).toBe(true)
    }
    // Never adopted the live pid; if it was up when we started, it is still up.
    expect([bootA!.pid, bootB!.pid]).not.toContain(LIVE_SERVER_PID)
    if (liveAliveAtStart) {
      expect(
        pidAlive(LIVE_SERVER_PID),
        'the user live freshell (pid 1262455) must remain alive — we must not have touched it',
      ).toBe(true)
    }
  })
})

/**
 * T1 baseline — a FRESH capture must equal the committed golden.
 *
 * This is exactly how the Rust port will be graded: boot the server, capture the
 * scenario's terminal bytes, and require them to match `port/oracle/baselines/
 * pty/<scenario>.golden` byte-for-byte (with the `.meta.json` sha256 as an
 * integrity cross-check). Regenerate the goldens only via
 * `port/oracle/baselines/pty/generate-pty-goldens.ts` when a change is intended.
 */
describe('T1 PTY golden baseline (fresh capture equals committed golden)', () => {
  let server: ExternalServerHandle | null = null
  const captures = new Map<string, PtyCaptureResult>()

  beforeAll(async () => {
    server = await startExternalServer({ provider: 'oracle-t1-baseline' })
    try {
      for (const scenario of PTY_SCENARIOS) {
        captures.set(scenario.name, await capturePtyScenario(server, scenario, { cols: 120, rows: 30 }))
      }
    } finally {
      await server.stop()
      server = null
    }
  }, 120_000)

  it('has a committed golden + meta for every scenario', () => {
    for (const scenario of PTY_SCENARIOS) {
      const golden = path.join(BASELINE_DIR, `${scenario.name}.golden`)
      const meta = path.join(BASELINE_DIR, `${scenario.name}.meta.json`)
      expect(fs.existsSync(golden), `missing committed golden ${golden}`).toBe(true)
      expect(fs.existsSync(meta), `missing committed meta ${meta}`).toBe(true)
    }
  })

  for (const scenario of PTY_SCENARIOS) {
    it(`fresh capture matches committed golden: ${scenario.name}`, () => {
      const capture = captures.get(scenario.name)
      expect(capture, `no fresh capture for ${scenario.name}`).toBeTruthy()

      const committed = fs.readFileSync(path.join(BASELINE_DIR, `${scenario.name}.golden`))
      const meta = JSON.parse(
        fs.readFileSync(path.join(BASELINE_DIR, `${scenario.name}.meta.json`), 'utf8'),
      ) as { sha256: string; byteLength: number }

      const identical = capture!.goldenBytes.equals(committed)
      if (!identical) {
        // eslint-disable-next-line no-console
        console.error(
          `[T1] fresh capture for "${scenario.name}" diverged from committed golden ` +
            `(committed ${committed.length}B head=${hexHead(committed, 64)}):\n` +
            hexDiff(capture!.goldenBytes, committed),
        )
      }
      expect(
        identical,
        `fresh capture for "${scenario.name}" must equal the committed golden byte-for-byte`,
      ).toBe(true)
      // Integrity cross-checks against the meta sidecar.
      expect(capture!.sha256).toBe(meta.sha256)
      expect(committed.length).toBe(meta.byteLength)
    })
  }
})
