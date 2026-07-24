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

/**
 * T0 EQUIVALENCE — the pivotal rung: the Rust port graded against the original.
 *
 * This is the first time the Rust `freshell-server` is driven by the oracle it
 * must satisfy. The test:
 *   1. boots the ORIGINAL (node) server, captures + normalizes its handshake;
 *   2. boots the RUST server TWICE, captures + normalizes each handshake;
 *   3. asserts three things:
 *      (a) the Rust handshake is T0 schema-CONFORMANT (every server→client
 *          message validates against the frozen `ws-server-messages.schema.json`);
 *      (b) two fresh RUST boots normalize deep-equal (the port is deterministic);
 *      (c) THE PRIZE — the ORIGINAL-normalized and the RUST-normalized handshakes
 *          are DEEP-EQUAL via `diffNormalized` (true old-vs-new T0 equivalence).
 *
 * On any residual diff the failure prints `diffNormalized` output + the two
 * canonical transcripts: that residual IS the exact spec the Rust server must
 * meet. A genuine original-vs-port difference that is a DEFECT in the ORIGINAL
 * (not the port) must be STOPPED and reported for antagonist adjudication —
 * never patched into `server/`.
 *
 * SAFETY: boots on ephemeral loopback ports (never :3001), reaps EVERY spawned
 * pid (node + rust) by tracked pid, and never touches a server it did not spawn.
 */

const LIVE_PID_DO_NOT_TOUCH = 1262455 // the user's live freshell (recorded; never us)

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

interface Boot {
  target: 'node' | 'rust'
  pid: number
  port: number
  handshake: CapturedMessage[]
}

describe('T0 equivalence — Rust port handshake ≡ original (normalized deep-equal)', () => {
  const spawned: ExternalServerHandle[] = []
  let orig: Boot | null = null
  let rust1: Boot | null = null
  let rust2: Boot | null = null
  let normOrig: NormalizedMessage[] = []
  let normRust1: NormalizedMessage[] = []
  let normRust2: NormalizedMessage[] = []
  let conformance: ReturnType<ContractValidator['assertTranscriptConformant']> | null = null
  let diffOrigRust: NormalizedDiff | null = null
  let diffRustRust: NormalizedDiff | null = null

  /** Boot an isolated server of the given target, capture its handshake, stop it. */
  async function bootAndCapture(target: 'node' | 'rust', tag: string): Promise<Boot> {
    const server = await startExternalServer({ target, provider: tag })
    spawned.push(server)
    const client = new WsCaptureClient(server.wsUrl, server.token)
    try {
      await client.connect()
      const handshake = await client.captureHandshake(60_000)
      return { target, pid: server.pid, port: server.port, handshake }
    } finally {
      await client.close().catch(() => {})
      await server.stop().catch(() => {})
    }
  }

  beforeAll(async () => {
    // Sequential (never concurrent): the oracle config is single-fork with no
    // file parallelism, so ports/pids never contend.
    orig = await bootAndCapture('node', 'oracle-eqv-node')
    rust1 = await bootAndCapture('rust', 'oracle-eqv-rust-1')
    rust2 = await bootAndCapture('rust', 'oracle-eqv-rust-2')

    normOrig = normalizeTranscript(orig.handshake).normalized
    normRust1 = normalizeTranscript(rust1.handshake).normalized
    normRust2 = normalizeTranscript(rust2.handshake).normalized

    conformance = new ContractValidator().assertTranscriptConformant(rust1.handshake)
    diffOrigRust = diffNormalized(normOrig, normRust1)
    diffRustRust = diffNormalized(normRust1, normRust2)
  }, 240_000)

  afterAll(async () => {
    // Idempotent belt-and-suspenders reap: bootAndCapture already stopped each,
    // but stop() is safe to call again and guarantees no orphan survives a
    // mid-run failure.
    for (const s of spawned) {
      await s.stop().catch(() => {})
    }
  })

  it('booted an isolated original + two isolated Rust servers (never :3001 / the live pid)', () => {
    expect(orig, 'original boot must have captured').toBeTruthy()
    expect(rust1, 'first Rust boot must have captured').toBeTruthy()
    expect(rust2, 'second Rust boot must have captured').toBeTruthy()
    for (const b of [orig!, rust1!, rust2!]) {
      expect(b.port).not.toBe(3001)
      expect(b.pid).toBeGreaterThan(0)
      expect(b.pid).not.toBe(LIVE_PID_DO_NOT_TOUCH)
    }
    // Distinct processes on distinct ports.
    const pids = [orig!.pid, rust1!.pid, rust2!.pid]
    expect(new Set(pids).size, `distinct pids: ${JSON.stringify(pids)}`).toBe(3)
  })

  it('(a) the Rust handshake is T0 schema-CONFORMANT (every server→client message validates)', () => {
    const r = conformance!
    // eslint-disable-next-line no-console
    console.log(
      `[T0-eqv:rust] captured ${r.serverMessageCount} server→client messages ` +
        `(${JSON.stringify(r.countByType)}); validated ${r.validatedCount}, ` +
        `unknown types: [${r.unknownTypes.join(', ')}], conformant: ${r.allConformant}`,
    )
    if (r.nonconformant.length > 0) {
      // eslint-disable-next-line no-console
      console.error('[T0-eqv:rust] NONCONFORMANCE:', JSON.stringify(r.nonconformant, null, 2))
    }
    expect(r.serverMessageCount).toBeGreaterThan(0)
    expect(
      r.unknownTypes,
      `Rust emitted type(s) with no frozen schema: ${r.unknownTypes.join(', ')}`,
    ).toEqual([])
    expect(
      r.allConformant,
      'every Rust server→client message must validate against the frozen server-messages schema',
    ).toBe(true)
  })

  it('(b) two fresh Rust boots normalize deep-equal (the port is deterministic)', () => {
    if (!diffRustRust!.equal) {
      // eslint-disable-next-line no-console
      console.error(
        '[T0-eqv:rust-determinism] RESIDUAL DIFF between two Rust boots:\n' +
          JSON.stringify(diffRustRust!.differences, null, 2) +
          '\n--- rust boot1 canonical ---\n' +
          canonicalizeTranscript(normRust1) +
          '\n--- rust boot2 canonical ---\n' +
          canonicalizeTranscript(normRust2),
      )
    }
    expect(
      diffRustRust!.equal,
      'two fresh Rust boots must be identical after normalization; see residual diff above',
    ).toBe(true)
    expect(canonicalizeTranscript(normRust1)).toBe(canonicalizeTranscript(normRust2))
  })

  it('(c) THE PRIZE: the ORIGINAL and the RUST handshake are DEEP-EQUAL after normalization', () => {
    const origTypes = normOrig.map((m) => `${m.dir}:${m.type}`)
    const rustTypes = normRust1.map((m) => `${m.dir}:${m.type}`)
    // eslint-disable-next-line no-console
    console.log(
      `[T0-eqv] original pid=${orig!.pid} port=${orig!.port} msgs=${normOrig.length} [${origTypes.join(', ')}]\n` +
        `[T0-eqv] rust     pid=${rust1!.pid} port=${rust1!.port} msgs=${normRust1.length} [${rustTypes.join(', ')}]\n` +
        `[T0-eqv] original≡rust deep-equal: ${diffOrigRust!.equal}`,
    )
    if (!diffOrigRust!.equal) {
      // eslint-disable-next-line no-console
      console.error(
        '[T0-eqv] diffNormalized(original, rust) — THIS IS THE EXACT SPEC THE RUST SERVER MUST MEET:\n' +
          JSON.stringify(diffOrigRust!.differences, null, 2) +
          '\n--- original canonical ---\n' +
          canonicalizeTranscript(normOrig) +
          '\n--- rust canonical ---\n' +
          canonicalizeTranscript(normRust1),
      )
    }
    expect(
      diffOrigRust!.equal,
      'the Rust handshake must be normalized-deep-equal to the original; see diff above',
    ).toBe(true)
    // Redundant with the diff, but pins the canonical golden-string equality too.
    expect(canonicalizeTranscript(normRust1)).toBe(canonicalizeTranscript(normOrig))
  })

  it('reaped every spawned server pid (node + rust) — ownership-safe teardown', async () => {
    for (const b of [orig!, rust1!, rust2!]) {
      const gone = await waitForPidGone(b.pid)
      expect(gone, `spawned ${b.target} server pid ${b.pid} should be gone after stop()`).toBe(true)
    }
  })
})
