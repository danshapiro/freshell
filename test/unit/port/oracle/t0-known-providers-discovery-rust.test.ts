import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  startExternalServer,
  type ExternalServerHandle,
} from '../../../../port/oracle/harness/external-server.js'
import { WsCaptureClient, type CapturedMessage } from '../../../../port/oracle/harness/ws-capture-client.js'
import {
  normalizeTranscript,
  diffNormalized,
  canonicalizeTranscript,
  type NormalizedMessage,
  type NormalizedDiff,
} from '../../../../port/oracle/harness/normalize.js'

/**
 * T0 comparator BITE-PROOF (`codingCli.knownProviders`) — RULING 2, antagonist
 * adjudication `0000000000000000-dc849de1bd584a39_self-driving-reviewer`
 * (2026-07-11).
 *
 * `t0-equivalence-rust.test.ts` now passes 5/5 after RULING 1's harness
 * cwd-parity fix, but it proves that ONLY because BOTH targets boot from an
 * isolated cwd with NO `extensions/` dir — `knownProviders` is `[]≡[]` there
 * by construction, which does not by itself demonstrate the comparator would
 * actually CATCH a real `knownProviders` divergence.
 *
 * This is the rot-guard: boot BOTH targets with the IDENTICAL cwd semantics
 * `t0-equivalence-rust.test.ts` uses, except pointed at the REAL checkout
 * (`cwdMode: 'project'`, RULING 2's addition to `external-server.ts`), whose
 * `extensions/` dir is genuinely non-empty (`claude-code`, `codex-cli`,
 * `gemini`, `kimi`, `opencode`). Both servers then have EQUAL opportunity to
 * discover it; asserting the comparator still finds them normalized-deep-equal
 * (i) AND that the discovery actually produced non-empty content on the node
 * reference (ii) proves the T0 handshake-equality assertion is not vacuously
 * true because `knownProviders` was empty on both sides.
 *
 * MUTATION DEMONSTRATION (documented in
 * `port/oracle/rest-parity/report-2026-07-11.md`, not left in the tree):
 * temporarily reverting the rust `known_providers` derivation to `Vec::new()`
 * (the pre-fix HEAD behavior) makes assertion (i) FAIL here (normalized
 * original: non-empty array; normalized rust: `[]`) — proof this test is not
 * a tautology and would have caught the very divergence it exists to guard.
 *
 * SAFETY: same as t0-equivalence-rust.test.ts — ephemeral loopback ports only,
 * every spawned pid reaped via `stop()`, never touches port 3001 or the live
 * user pid.
 */

const LIVE_PID_DO_NOT_TOUCH = 1262455 // the user's live freshell (recorded; never us)

interface Boot {
  target: 'node' | 'rust'
  pid: number
  port: number
  handshake: CapturedMessage[]
}

describe('T0 knownProviders discovery — comparator bite-proof (RULING 2)', () => {
  const spawned: ExternalServerHandle[] = []
  let orig: Boot | null = null
  let rust: Boot | null = null
  let normOrig: NormalizedMessage[] = []
  let normRust: NormalizedMessage[] = []
  let diffOrigRust: NormalizedDiff | null = null

  /** Boot an isolated server rooted at the REAL checkout (cwdMode:'project'), capture its handshake, stop it. */
  async function bootAndCapture(target: 'node' | 'rust', tag: string): Promise<Boot> {
    const server = await startExternalServer({ target, provider: tag, cwdMode: 'project' })
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
    // Sequential (never concurrent): matches t0-equivalence-rust.test.ts's posture.
    orig = await bootAndCapture('node', 'oracle-knownproviders-node')
    rust = await bootAndCapture('rust', 'oracle-knownproviders-rust')

    normOrig = normalizeTranscript(orig.handshake).normalized
    normRust = normalizeTranscript(rust.handshake).normalized
    diffOrigRust = diffNormalized(normOrig, normRust)
  }, 240_000)

  afterAll(async () => {
    for (const s of spawned) {
      await s.stop().catch(() => {})
    }
  })

  it('booted an isolated original + an isolated Rust server, both rooted at the real checkout', () => {
    expect(orig, 'original boot must have captured').toBeTruthy()
    expect(rust, 'rust boot must have captured').toBeTruthy()
    for (const b of [orig!, rust!]) {
      expect(b.port).not.toBe(3001)
      expect(b.pid).toBeGreaterThan(0)
      expect(b.pid).not.toBe(LIVE_PID_DO_NOT_TOUCH)
    }
    expect(new Set([orig!.pid, rust!.pid]).size).toBe(2)
  })

  /** Find `codingCli.knownProviders` inside a normalized handshake's `settings.updated` (or `ready`) message. */
  function findKnownProviders(normalized: NormalizedMessage[]): unknown {
    for (const m of normalized) {
      const parsed = m.parsed as Record<string, unknown> | undefined
      const settings = (parsed?.settings ?? parsed) as Record<string, unknown> | undefined
      const codingCli = settings?.codingCli as Record<string, unknown> | undefined
      if (codingCli && 'knownProviders' in codingCli) return codingCli.knownProviders
    }
    return undefined
  }

  it('(i) the ORIGINAL and RUST handshakes are DEEP-EQUAL after normalization (real, non-empty extensions/)', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[T0-knownProviders] original pid=${orig!.pid} knownProviders=${JSON.stringify(findKnownProviders(normOrig))}\n` +
        `[T0-knownProviders] rust     pid=${rust!.pid} knownProviders=${JSON.stringify(findKnownProviders(normRust))}\n` +
        `[T0-knownProviders] original≡rust deep-equal: ${diffOrigRust!.equal}`,
    )
    if (!diffOrigRust!.equal) {
      // eslint-disable-next-line no-console
      console.error(
        '[T0-knownProviders] diffNormalized(original, rust):\n' +
          JSON.stringify(diffOrigRust!.differences, null, 2) +
          '\n--- original canonical ---\n' +
          canonicalizeTranscript(normOrig) +
          '\n--- rust canonical ---\n' +
          canonicalizeTranscript(normRust),
      )
    }
    expect(
      diffOrigRust!.equal,
      'with an IDENTICAL real-checkout cwd on both sides, the Rust handshake must be normalized-deep-equal to the original; see diff above',
    ).toBe(true)
  })

  it('(ii) rot-guard: the NODE reference actually discovered a NON-EMPTY knownProviders (this test is not vacuous)', () => {
    const nodeKnownProviders = findKnownProviders(normOrig)
    expect(
      Array.isArray(nodeKnownProviders) && nodeKnownProviders.length > 0,
      `expected the node original (booted at the real checkout, whose extensions/ dir is non-empty) to report ` +
        `a non-empty codingCli.knownProviders; got ${JSON.stringify(nodeKnownProviders)}. If this ever reports ` +
        `empty, assertion (i)'s pass would be a vacuous []≡[] and this comparator bite-proof would no longer be ` +
        `proving anything.`,
    ).toBe(true)
  })

  it('reaped every spawned server pid (node + rust) — ownership-safe teardown', async () => {
    for (const b of [orig!, rust!]) {
      const gone = await new Promise<boolean>((resolve) => {
        const start = Date.now()
        const check = () => {
          try {
            process.kill(b.pid, 0)
            if (Date.now() - start > 10_000) return resolve(false)
            setTimeout(check, 100)
          } catch {
            resolve(true)
          }
        }
        check()
      })
      expect(gone, `spawned ${b.target} server pid ${b.pid} should be gone after stop()`).toBe(true)
    }
  })
})
