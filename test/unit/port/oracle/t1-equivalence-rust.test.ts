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

/** T1 Rust terminal-over-wire bytes against the committed Rust baseline. */

const BASELINE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../port/oracle/baselines/pty',
)

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

interface Boot {
  pid: number
  port: number
  results: Map<string, PtyCaptureResult>
}

describe('T1 Rust PTY byte-stream baseline', () => {
  const spawned: ExternalServerHandle[] = []
  let boot: Boot | null = null

  beforeAll(async () => {
    const server = await startExternalServer({ provider: 'oracle-t1-rust' })
    spawned.push(server)
    const results = new Map<string, PtyCaptureResult>()
    try {
      for (const scenario of PTY_SCENARIOS) {
        const result = await capturePtyScenario(server, scenario)
        results.set(scenario.name, result)
        // eslint-disable-next-line no-console
        console.log(
          `[T1-rust] "${scenario.name}": ${result.goldenBytes.length}B ` +
            `sha256=${result.sha256.slice(0, 12)}… frames=${result.frameCount} gaps=${result.gaps.length}`,
        )
      }
      boot = { pid: server.pid, port: server.port, results }
    } finally {
      await server.stop()
    }
  }, 240_000)

  afterAll(async () => {
    for (const server of spawned) await server.stop().catch(() => {})
  })

  it('captures every scenario on an owned non-reserved Rust server', () => {
    expect(boot).toBeTruthy()
    expect(boot!.port).not.toBe(3001)
    expect(boot!.pid).toBeGreaterThan(0)
    expect(boot!.results.size).toBe(PTY_SCENARIOS.length)
  })

  for (const scenario of PTY_SCENARIOS) {
    it(`matches the committed Rust golden byte-for-byte: ${scenario.name}`, () => {
      const capture = boot!.results.get(scenario.name)
      expect(capture, `no Rust capture for ${scenario.name}`).toBeTruthy()
      expect(capture!.gaps, `Rust saw output gaps for ${scenario.name}`).toEqual([])

      const committed = fs.readFileSync(path.join(BASELINE_DIR, `${scenario.name}.golden`))
      const meta = JSON.parse(
        fs.readFileSync(path.join(BASELINE_DIR, `${scenario.name}.meta.json`), 'utf8'),
      ) as { sha256: string; byteLength: number }
      if (!capture!.goldenBytes.equals(committed)) {
        // eslint-disable-next-line no-console
        console.error(
          `[T1-rust] "${scenario.name}" diverged (committed ${committed.length}B ` +
            `head=${hexHead(committed, 64)}):\n${hexDiff(capture!.goldenBytes, committed)}`,
        )
      }
      expect(capture!.goldenBytes.equals(committed)).toBe(true)
      expect(capture!.sha256).toBe(meta.sha256)
      expect(committed.length).toBe(meta.byteLength)
      expect(capture!.goldenText).toBe(scenario.expectedGolden)
    })
  }

  it('keeps the byte comparator sensitive to a one-byte mutation', () => {
    const capture = boot!.results.get(PTY_SCENARIOS[0].name)!
    const committed = fs.readFileSync(path.join(BASELINE_DIR, `${PTY_SCENARIOS[0].name}.golden`))
    const mutated = Buffer.from(committed)
    mutated[0] ^= 1
    expect(capture.goldenBytes.equals(committed)).toBe(true)
    expect(capture.goldenBytes.equals(mutated)).toBe(false)
  })

  it('reaps the owned Rust server process', async () => {
    expect(await waitForPidGone(boot!.pid), `Rust server ${boot!.pid} should be gone`).toBe(true)
  })
})
