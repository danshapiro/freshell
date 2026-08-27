import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  startExternalServer,
  type ExternalServerHandle,
} from '../../../../port/oracle/harness/external-server.js'
import {
  WsCaptureClient,
  type CapturedMessage,
} from '../../../../port/oracle/harness/ws-capture-client.js'
import { ContractValidator } from '../../../../port/oracle/harness/contract-validator.js'
import {
  normalizeTranscript,
  diffNormalized,
  canonicalizeTranscript,
  type NormalizedMessage,
  type NormalizedDiff,
} from '../../../../port/oracle/harness/normalize.js'

/** T0 Rust schema conformance and boot determinism over the real WebSocket. */

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
  handshake: CapturedMessage[]
}

describe('T0 Rust handshake conformance and determinism', () => {
  const spawned: ExternalServerHandle[] = []
  let boot1: Boot | null = null
  let boot2: Boot | null = null
  let norm1: NormalizedMessage[] = []
  let norm2: NormalizedMessage[] = []
  let diff: NormalizedDiff | null = null
  let conformance: ReturnType<ContractValidator['assertTranscriptConformant']> | null = null

  async function bootAndCapture(tag: string): Promise<Boot> {
    const server = await startExternalServer({ provider: tag })
    spawned.push(server)
    const client = new WsCaptureClient(server.wsUrl, server.token)
    try {
      await client.connect()
      return { pid: server.pid, port: server.port, handshake: await client.captureHandshake(60_000) }
    } finally {
      await client.close().catch(() => {})
      await server.stop().catch(() => {})
    }
  }

  beforeAll(async () => {
    boot1 = await bootAndCapture('oracle-t0-rust-1')
    boot2 = await bootAndCapture('oracle-t0-rust-2')
    norm1 = normalizeTranscript(boot1.handshake).normalized
    norm2 = normalizeTranscript(boot2.handshake).normalized
    diff = diffNormalized(norm1, norm2)
    conformance = new ContractValidator().assertTranscriptConformant(boot1.handshake)
  }, 240_000)

  afterAll(async () => {
    for (const server of spawned) await server.stop().catch(() => {})
  })

  it('boots two owned Rust servers on non-reserved ports', () => {
    expect(boot1).toBeTruthy()
    expect(boot2).toBeTruthy()
    for (const boot of [boot1!, boot2!]) {
      expect(boot.port).not.toBe(3001)
      expect(boot.pid).toBeGreaterThan(0)
    }
    expect(boot1!.pid).not.toBe(boot2!.pid)
    expect(boot1!.port).not.toBe(boot2!.port)
  })

  it('emits a nonempty handshake conforming to the frozen Rust server schema', () => {
    expect(conformance!.serverMessageCount).toBeGreaterThan(0)
    expect(conformance!.unknownTypes).toEqual([])
    expect(conformance!.allConformant).toBe(true)
  })

  it('produces normalized-identical handshakes across fresh Rust boots', () => {
    if (!diff!.equal) {
      // eslint-disable-next-line no-console
      console.error(
        '[T0-rust] residual handshake diff:\n' +
          JSON.stringify(diff!.differences, null, 2) +
          '\n--- boot 1 ---\n' +
          canonicalizeTranscript(norm1) +
          '\n--- boot 2 ---\n' +
          canonicalizeTranscript(norm2),
      )
    }
    expect(diff!.equal, 'fresh Rust boots must be identical after normalization').toBe(true)
    expect(canonicalizeTranscript(norm1)).toBe(canonicalizeTranscript(norm2))
    expect(norm1.length).toBeGreaterThan(0)
  })

  it('reaps every owned server process', async () => {
    for (const boot of [boot1!, boot2!]) {
      expect(await waitForPidGone(boot.pid), `Rust server ${boot.pid} should be gone`).toBe(true)
    }
  })
})
