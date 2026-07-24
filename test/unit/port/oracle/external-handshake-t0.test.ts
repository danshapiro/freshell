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
import { WS_PROTOCOL_VERSION } from '../../../../shared/ws-version.js'

/**
 * T0 conformance — the first *live* rung of the equivalence oracle.
 *
 * Boots the ORIGINAL (node) freshell server as an isolated external process on
 * an ephemeral loopback port, drives the real WebSocket handshake through a
 * capture client, and asserts that every server→client message the original
 * emits validates against the frozen `port/contract/ws-server-messages.schema.json`.
 *
 * This is deliberately an external-process test: the Rust port will be graded
 * against the SAME captured transcript + the SAME frozen schema, so the capture
 * path must never depend on in-process TypeScript internals.
 *
 * SAFETY: never touches the user's live server (:3001 / a foreign pid). The
 * harness spawns its own node process on a free port and reaps it by tracked
 * pid on teardown.
 */

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

describe('T0 external-process handshake conformance (original server)', () => {
  let server: ExternalServerHandle | null = null
  let client: WsCaptureClient | null = null
  let handshake: CapturedMessage[] = []
  let bootedPid = 0

  beforeAll(async () => {
    server = await startExternalServer({ provider: 'oracle-t0' })
    bootedPid = server.pid
    client = new WsCaptureClient(server.wsUrl, server.token)
    await client.connect()
    handshake = await client.captureHandshake()
  }, 120_000)

  afterAll(async () => {
    try {
      if (client) await client.close()
    } finally {
      if (server) await server.stop()
    }
  })

  it('booted an isolated server — not the live :3001 instance', () => {
    expect(server).toBeTruthy()
    expect(server!.port).not.toBe(3001)
    expect(server!.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/)
    expect(bootedPid).toBeGreaterThan(0)
    expect(bootedPid).not.toBe(1262455) // the user's live freshell — must never be us
  })

  it('(a) emits a `ready` message carrying the expected fields', () => {
    const ready = handshake.find((m) => m.dir === 'in' && m.type === 'ready')
    expect(ready, 'a ready message must appear in the handshake transcript').toBeTruthy()
    const parsed = ready!.parsed as Record<string, unknown>
    expect(parsed.type).toBe('ready')
    expect(typeof parsed.timestamp).toBe('string')
    expect(typeof parsed.serverInstanceId).toBe('string')
    expect(typeof parsed.bootId).toBe('string')
  })

  it('(b) agrees on WS_PROTOCOL_VERSION across client, contract, and hello', () => {
    const validator = new ContractValidator()
    expect(WS_PROTOCOL_VERSION).toBe(7)
    expect(validator.wsProtocolVersion).toBe(WS_PROTOCOL_VERSION)

    const hello = handshake.find((m) => m.dir === 'out' && m.type === 'hello')
    expect(hello, 'the capture client must have sent a hello').toBeTruthy()
    expect((hello!.parsed as Record<string, unknown>).protocolVersion).toBe(WS_PROTOCOL_VERSION)
  })

  it('(c) every captured server→client message conforms to the frozen schema (T0)', () => {
    const validator = new ContractValidator()
    const report = validator.assertTranscriptConformant(handshake)

    // Emit the full picture so any real finding is legible in CI logs.
    // eslint-disable-next-line no-console
    console.log(
      `[T0] captured ${report.serverMessageCount} server→client messages ` +
        `(${JSON.stringify(report.countByType)}); validated ${report.validatedCount}, ` +
        `unknown types: [${report.unknownTypes.join(', ')}], conformant: ${report.allConformant}`,
    )
    if (report.nonconformant.length > 0) {
      // eslint-disable-next-line no-console
      console.error('[T0] NONCONFORMANCE:', JSON.stringify(report.nonconformant, null, 2))
    }

    expect(report.serverMessageCount).toBeGreaterThan(0)
    expect(
      report.unknownTypes,
      `server emitted type(s) with no frozen schema: ${report.unknownTypes.join(', ')}`,
    ).toEqual([])
    expect(
      report.allConformant,
      'every server→client message must validate against the frozen server-messages schema',
    ).toBe(true)
  })

  it('(d) stop() cleanly reaps the spawned server pid (ownership-safe teardown)', async () => {
    expect(pidAlive(bootedPid)).toBe(true)
    await server!.stop()
    const gone = await waitForPidGone(bootedPid)
    expect(gone, `spawned server pid ${bootedPid} should be gone after stop()`).toBe(true)
  })
})
