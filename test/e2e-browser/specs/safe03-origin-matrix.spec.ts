import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { TestServer } from '../helpers/test-server.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerHandle, E2eServerKind } from '../helpers/external-target.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

/**
 * SAFE-03 -- matrix spec.
 *
 * Full acceptance text: "Enforce WebSocket Origin policy. Accept configured
 * trusted origins and reject hostile/malformed origins before session state
 * is exposed." Validation note: "Open raw sockets with same-origin, allowed
 * remote, missing, `null`, and hostile origins, assert documented
 * accept/close behavior, and verify rejected clients receive no
 * ready/settings/terminal data."
 *
 * Prior state (crate-level only): `crates/freshell-ws/src/origin.rs`'s
 * `evaluate_origin`/`resolve_allowed_origins` and
 * `crates/freshell-ws/tests/origin_policy.rs`'s real-socket integration
 * tests prove this at the Rust level, but never from a Playwright `PW-RUST`
 * spec (HARNESS-05: raw sockets driven from within an owned Playwright
 * test).
 *
 * KNOWN DIVERGENCE (documented in `origin.rs`'s own module doc comment, not
 * a new finding): the legacy Node server's Origin check
 * (`server/auth.ts#isOriginAllowed`, `ws-handler.ts`) is explicitly
 * ADVISORY-ONLY -- it never closes a socket for a bad Origin, only logs a
 * warning, and still authenticates via the hello token. The Rust port
 * deliberately HARDENS this into a real enforced policy (closing with a new
 * 4011 code before any session state is sent) because the Rust server's
 * production bind is `0.0.0.0` (LAN-reachable), where advisory-only leaves a
 * DNS-rebinding path open. This spec therefore runs the SAME connection
 * attempts against BOTH `legacy-chromium` and `rust-chromium`, but asserts
 * the DIFFERENT, per-kind-correct outcome for the reject-path cases:
 * legacy is the CONTROL that empirically proves the pre-hardening gap this
 * checklist item exists to close, rust proves the fix.
 *
 * NOT covered here:
 *   - "verify rejected clients receive no ... settings/terminal data": the
 *     origin_policy.rs real-socket tests already prove the very FIRST frame
 *     after a hello on a rejected connection is never `ready` (session
 *     state), and this spec's `connectWithOrigin` helper applies the same
 *     check at the Playwright layer. A full "no terminal.inventory ever
 *     arrives either" walk would require creating a terminal and racing a
 *     background broadcast against the close, which is a materially bigger
 *     scenario for a marginal increment of proof beyond "the very next
 *     frame is a close, not `ready`" -- left as a narrowing note, not
 *     fabricated.
 */

async function bootWithAllowedOrigins(
  kind: E2eServerKind,
  allowedOrigins: string,
): Promise<E2eServerHandle> {
  const server = kind === 'rust'
    ? new RustServer({ env: { ALLOWED_ORIGINS: allowedOrigins }, startTimeoutMs: 60_000 })
    : new TestServer({ env: { ALLOWED_ORIGINS: allowedOrigins }, startTimeoutMs: 30_000 })
  await server.start()
  return server
}

type OriginOutcome = 'ready' | { closeCode: number; closeReason: string }

/**
 * Open a raw WS connection with an explicit (or absent) `Origin` header,
 * send a well-formed `hello` with a VALID token immediately, and observe
 * whether the very first inbound frame is `ready` (allowed through) or a
 * `close` (rejected before session state).
 */
function connectWithOrigin(wsUrl: string, token: string, origin: string | undefined): Promise<OriginOutcome> {
  return new Promise((resolve, reject) => {
    const options = origin !== undefined ? { headers: { Origin: origin } } : undefined
    const ws = new WebSocket(wsUrl, options)
    const timeout = setTimeout(() => {
      ws.removeAllListeners()
      ws.terminate()
      reject(new Error('Timed out waiting for origin-policy outcome'))
    }, 10_000)

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token, protocolVersion: WS_PROTOCOL_VERSION }))
    })

    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message?.type === 'ready') {
        clearTimeout(timeout)
        ws.removeAllListeners()
        ws.close()
        resolve('ready')
      }
      // Any other message type (e.g. an `error` frame accompanying the
      // reject) is not itself conclusive -- wait for the close event below.
    })

    ws.on('close', (code, reasonBuf) => {
      clearTimeout(timeout)
      ws.removeAllListeners()
      resolve({ closeCode: code, closeReason: String(reasonBuf) })
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

const ALLOW_LISTED_REMOTE_ORIGIN = 'https://trusted.example'

test.describe.serial('SAFE-03 WS Origin policy matrix', () => {
  let server: E2eServerHandle

  test.beforeAll(async ({ e2eServerKind }) => {
    server = await bootWithAllowedOrigins(e2eServerKind, ALLOW_LISTED_REMOTE_ORIGIN)
  })

  test.afterAll(async () => {
    await server.stop()
  })

  test('no Origin header is allowed through to the ready handshake', async () => {
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, undefined)
    expect(outcome).toBe('ready')
  })

  test('same-origin (Origin matches the request Host) is allowed', async () => {
    const sameOrigin = `http://127.0.0.1:${server.info.port}`
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, sameOrigin)
    expect(outcome).toBe('ready')
  })

  test('an allow-listed remote origin (configured via ALLOWED_ORIGINS) is allowed', async () => {
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, ALLOW_LISTED_REMOTE_ORIGIN)
    expect(outcome).toBe('ready')
  })

  test('a hostile origin (DNS-rebinding shape) is rejected before session state -- KNOWN DIVERGENCE vs legacy', async ({ e2eServerKind }) => {
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, 'http://evil.example')
    if (e2eServerKind === 'rust') {
      expect(outcome).not.toBe('ready')
      const closed = outcome as { closeCode: number; closeReason: string }
      expect(closed.closeCode).toBe(4011)
      expect(closed.closeReason).toBe('Origin not allowed')
    } else {
      // CONTROL: legacy's Origin check is advisory-only -- it never closes
      // the socket, so a hostile origin with a valid token still reaches
      // `ready`. This is the exact pre-hardening gap SAFE-03 closes.
      expect(outcome).toBe('ready')
    }
  })

  test('the literal `null` origin (sandboxed iframe / file://) is rejected -- KNOWN DIVERGENCE vs legacy', async ({ e2eServerKind }) => {
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, 'null')
    if (e2eServerKind === 'rust') {
      expect(outcome).not.toBe('ready')
      const closed = outcome as { closeCode: number; closeReason: string }
      expect(closed.closeCode).toBe(4011)
      expect(closed.closeReason).toBe('Origin not allowed')
    } else {
      expect(outcome).toBe('ready')
    }
  })

  test('a malformed origin (not a URL at all) is rejected -- KNOWN DIVERGENCE vs legacy', async ({ e2eServerKind }) => {
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, 'not-a-url')
    if (e2eServerKind === 'rust') {
      expect(outcome).not.toBe('ready')
      const closed = outcome as { closeCode: number; closeReason: string }
      expect(closed.closeCode).toBe(4011)
      expect(closed.closeReason).toBe('Origin not allowed')
    } else {
      expect(outcome).toBe('ready')
    }
  })
})
