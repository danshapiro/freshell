import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  startExternalServer,
  type ExternalServerHandle,
} from '../../../../port/oracle/harness/external-server.js'
import {
  WsCaptureClient,
  type CapturedMessage,
} from '../../../../port/oracle/harness/ws-capture-client.js'
import {
  normalizeTranscript,
  diffNormalized,
  canonicalizeTranscript,
  type NormalizedMessage,
  type NormalizationReport,
  type NormalizedDiff,
} from '../../../../port/oracle/harness/normalize.js'

/**
 * T0 handshake DETERMINISM — the normalization layer's first live proof.
 *
 * Boots the ORIGINAL (node) freshell server as an isolated external process,
 * captures the connect handshake, and stops it; then boots a SECOND fresh
 * isolated instance and captures ITS handshake. After normalization the two
 * transcripts MUST be deep-equal: the handshake is deterministic modulo the
 * fields the registry canonicalizes (per-boot server ids, timestamps, the
 * random auth token, temp paths, ...).
 *
 * If they are NOT equal, the failure prints the residual diff. That residual is
 * itself the finding: either a nondeterministic field the registry still needs
 * to cover (add it), or genuine boot-nondeterminism in the server (a real bug to
 * record). This is exactly how the same layer will later diff the Rust port
 * against the original.
 *
 * SAFETY: boots on ephemeral loopback ports (never :3001), reaps BOTH spawned
 * pids by tracked pid, and never touches a server it did not spawn.
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
  pid: number
  port: number
  handshake: CapturedMessage[]
}

describe('T0 handshake determinism (two fresh original boots normalize-equal)', () => {
  const spawned: ExternalServerHandle[] = []
  let boot1: Boot | null = null
  let boot2: Boot | null = null
  let norm1: NormalizedMessage[] = []
  let norm2: NormalizedMessage[] = []
  let report1: NormalizationReport | null = null
  let report2: NormalizationReport | null = null
  let diff: NormalizedDiff | null = null

  /** Boot an isolated original server, capture its handshake, then stop it. */
  async function bootAndCapture(tag: string): Promise<Boot> {
    const server = await startExternalServer({ provider: tag })
    spawned.push(server)
    const client = new WsCaptureClient(server.wsUrl, server.token)
    try {
      await client.connect()
      const handshake = await client.captureHandshake(60_000)
      return { pid: server.pid, port: server.port, handshake }
    } finally {
      await client.close().catch(() => {})
      await server.stop().catch(() => {})
    }
  }

  beforeAll(async () => {
    // Sequential (never concurrent): the oracle config is single-fork with no
    // file parallelism, so ports/pids never contend.
    boot1 = await bootAndCapture('oracle-det-1')
    boot2 = await bootAndCapture('oracle-det-2')

    const n1 = normalizeTranscript(boot1.handshake)
    const n2 = normalizeTranscript(boot2.handshake)
    norm1 = n1.normalized
    norm2 = n2.normalized
    report1 = n1.report
    report2 = n2.report
    diff = diffNormalized(norm1, norm2)
  }, 120_000)

  afterAll(async () => {
    // Idempotent belt-and-suspenders reap: bootAndCapture already stopped each,
    // but stop() is safe to call again and guarantees no orphan survives a
    // mid-run failure.
    for (const s of spawned) {
      await s.stop().catch(() => {})
    }
  })

  it('booted two distinct isolated servers (never :3001, never the live pid)', () => {
    expect(boot1, 'first boot must have captured').toBeTruthy()
    expect(boot2, 'second boot must have captured').toBeTruthy()
    for (const b of [boot1!, boot2!]) {
      expect(b.port).not.toBe(3001)
      expect(b.pid).toBeGreaterThan(0)
      expect(b.pid).not.toBe(LIVE_PID_DO_NOT_TOUCH)
    }
    expect(boot1!.pid).not.toBe(boot2!.pid)
    expect(boot1!.port).not.toBe(boot2!.port)
  })

  it('both handshakes carry the expected message spine', () => {
    for (const b of [boot1!, boot2!]) {
      const types = b.handshake.filter((m) => m.dir === 'in').map((m) => m.type)
      expect(types, `handshake types: ${JSON.stringify(types)}`).toContain('ready')
      expect(types).toContain('settings.updated')
      expect(types).toContain('terminal.inventory')
    }
  })

  it('two fresh boots produce byte-identical handshakes after normalization', () => {
    // Surface everything a human/antagonist would need to adjudicate a failure.
    const types1 = norm1.map((m) => `${m.dir}:${m.type}`)
    const types2 = norm2.map((m) => `${m.dir}:${m.type}`)
    // eslint-disable-next-line no-console
    console.log(
      `[T0-determinism] boot1 pid=${boot1!.pid} port=${boot1!.port} msgs=${norm1.length} [${types1.join(', ')}]\n` +
        `[T0-determinism] boot2 pid=${boot2!.pid} port=${boot2!.port} msgs=${norm2.length} [${types2.join(', ')}]\n` +
        `[T0-determinism] placeholders boot1=${JSON.stringify(report1!.placeholderCounts)} boot2=${JSON.stringify(report2!.placeholderCounts)}\n` +
        `[T0-determinism] shapeViolations boot1=${report1!.shapeViolations.length} boot2=${report2!.shapeViolations.length}; ` +
        `opaque boot1=${report1!.opaque.map((o) => o.field).join('/')} boot2=${report2!.opaque.map((o) => o.field).join('/')}`,
    )
    if (report1!.shapeViolations.length > 0 || report2!.shapeViolations.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        '[T0-determinism] SHAPE VIOLATIONS:',
        JSON.stringify({ boot1: report1!.shapeViolations, boot2: report2!.shapeViolations }, null, 2),
      )
    }
    if (!diff!.equal) {
      // eslint-disable-next-line no-console
      console.error(
        '[T0-determinism] RESIDUAL DIFF (a nondeterministic field missing from the registry, ' +
          'or genuine boot-nondeterminism):\n' +
          JSON.stringify(diff!.differences, null, 2) +
          '\n--- boot1 canonical ---\n' +
          canonicalizeTranscript(norm1) +
          '\n--- boot2 canonical ---\n' +
          canonicalizeTranscript(norm2),
      )
    }

    expect(
      diff!.equal,
      'two fresh original boots must be identical after normalization; see residual diff above',
    ).toBe(true)
    // Redundant with the diff, but pins the canonical golden-string equality too.
    expect(canonicalizeTranscript(norm1)).toBe(canonicalizeTranscript(norm2))
  })

  it('the normalization actually did work (ids/timestamps/token were canonicalized)', () => {
    // Guard against a vacuous pass: if normalization were a no-op the two boots
    // would NOT be equal, but assert the placeholders are present so we know the
    // equality came from canonicalization, not from empty transcripts.
    const canon = canonicalizeTranscript(norm1)
    expect(canon).toContain('<TS:') // ready.timestamp at minimum
    expect(canon).toContain('<OPAQUE:token>') // the random auth token was masked
    expect(norm1.length).toBeGreaterThanOrEqual(3)
  })

  it('both spawned server pids were reaped (ownership-safe teardown)', async () => {
    const gone1 = await waitForPidGone(boot1!.pid)
    const gone2 = await waitForPidGone(boot2!.pid)
    expect(gone1, `spawned server pid ${boot1!.pid} should be gone`).toBe(true)
    expect(gone2, `spawned server pid ${boot2!.pid} should be gone`).toBe(true)
  })
})
