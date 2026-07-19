import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { TestServer } from '../helpers/test-server.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerKind } from '../helpers/external-target.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

/**
 * SAFE-01 -- matrix spec.
 *
 * Full acceptance text: "Match token validation and authentication rules.
 * Reject empty, weak, default, malformed, and conflicting token sources
 * while preserving header/cookie/query/WS behavior." Validation note: "Launch
 * parameterized bad-token configurations and assert startup/config errors,
 * then test good/wrong/missing tokens through UI, API, local-file, proxy,
 * and WebSocket without exposing the token in logs."
 *
 * Prior state (crate-level only, see checklist entry before this commit):
 * `crates/freshell-server/src/main.rs`'s `validate_auth_token()` and
 * `crates/freshell-server/src/boot.rs`'s `is_authed()` precedence fix are
 * unit/real-socket tested at the Rust level, but never driven from a
 * Playwright `PW-RUST` spec (browser/API/WS matrix, and the bad-token
 * STARTUP rejection, were both unproven at this layer).
 *
 * This spec closes that gap for every CHEAPLY PROVABLE clause, run against
 * BOTH `legacy-chromium` and `rust-chromium` (`server/auth.ts` and
 * `crates/freshell-server/src/main.rs::validate_auth_token` share the exact
 * same messages/order/`DEFAULT_BAD_TOKENS` set, confirmed by direct
 * source read of both, so legacy is a true parity control here -- NOT a
 * "known divergence" case like SAFE-03/SAFE-05).
 *
 * NOT covered here (see the SAFE-01 checklist entry for why):
 *   - "local-file" token source: no distinct local-file credential surface
 *     was identified in either server (auth is header/cookie/query only);
 *     interpreted as out of scope pending product clarification.
 *   - "proxy": needs controllable proxy infrastructure this lane does not
 *     own (same gap noted for SAFE-05's transport-heartbeat clause).
 *   - "without exposing the token in logs": the underlying sanitization
 *     already has a direct Rust unit test
 *     (`crates/freshell-server/src/logging.rs`'s
 *     `sanitize_route_strips_only_the_token_query_param`); re-proving it by
 *     scraping a live debug-log file at the browser layer was judged too
 *     fragile (debug logging verbosity is a runtime toggle, not guaranteed
 *     on for a freshly-booted E2E server) to add real proof for the
 *     token/time cost, so it is left as crate-level-only evidence.
 *   - "weak/default value" startup message is EMPIRICALLY UNREACHABLE in
 *     both implementations: `DEFAULT_BAD_TOKENS` (`changeme`/`default`/
 *     `password`/`token`) are all under 16 characters, and the "too short"
 *     check runs BEFORE the weak-value check in both `server/auth.ts` and
 *     `main.rs::validate_auth_token`, so any of those literal values always
 *     hits "too short" first. The "too-short" matrix case below uses
 *     `changeme` itself to PROVE this empirically (see the
 *     `weak-default-token-is-actually-caught-by-the-too-short-check` case)
 *     rather than silently skip the weak-value clause.
 */

const BAD_TOKEN_STARTUP_TIMEOUT_MS = 20_000

async function bootWithToken(kind: E2eServerKind, token: string): Promise<{ started: boolean; message: string }> {
  const server = kind === 'rust'
    ? new RustServer({ token, startTimeoutMs: BAD_TOKEN_STARTUP_TIMEOUT_MS })
    : new TestServer({ token, startTimeoutMs: BAD_TOKEN_STARTUP_TIMEOUT_MS })

  try {
    await server.start()
    await server.stop()
    return { started: true, message: '' }
  } catch (error) {
    return { started: false, message: String((error as Error).message) }
  }
}

/** Open a raw WS connection and send a `hello` with the given token (or omit it if `token` is undefined). */
function connectAndSendHello(wsUrl: string, token: string | undefined): Promise<{
  ws: WebSocket
  outcome: 'ready' | { closeCode: number; closeReason: string }
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timeout = setTimeout(() => {
      ws.removeAllListeners()
      ws.terminate()
      reject(new Error('Timed out waiting for hello response'))
    }, 10_000)

    ws.on('open', () => {
      const hello: Record<string, unknown> = { type: 'hello', protocolVersion: WS_PROTOCOL_VERSION }
      if (token !== undefined) hello.token = token
      ws.send(JSON.stringify(hello))
    })

    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message?.type === 'ready') {
        clearTimeout(timeout)
        ws.removeAllListeners()
        resolve({ ws, outcome: 'ready' })
      }
    })

    ws.on('close', (code, reasonBuf) => {
      clearTimeout(timeout)
      ws.removeAllListeners()
      resolve({ ws, outcome: { closeCode: code, closeReason: String(reasonBuf) } })
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

test.describe('SAFE-01 startup token-validation matrix (bad tokens refuse to boot)', () => {
  test('empty token refuses to start with the exact required-token message', async ({ e2eServerKind }) => {
    const result = await bootWithToken(e2eServerKind, '')
    expect(result.started).toBe(false)
    expect(result.message).toContain('AUTH_TOKEN is required. Refusing to start without authentication.')
  })

  test('too-short token (generic) refuses to start with the exact too-short message', async ({ e2eServerKind }) => {
    const result = await bootWithToken(e2eServerKind, 'short-secret')
    expect(result.started).toBe(false)
    expect(result.message).toContain('AUTH_TOKEN is too short. Use at least 16 characters.')
  })

  // Empirical proof that the "weak/default value" message is unreachable:
  // every DEFAULT_BAD_TOKENS entry is under 16 characters, so the too-short
  // check fires first in BOTH implementations. See the file doc comment.
  test('weak/default token ("changeme") is actually caught by the too-short check, not the weak-value check', async ({ e2eServerKind }) => {
    const result = await bootWithToken(e2eServerKind, 'changeme')
    expect(result.started).toBe(false)
    expect(result.message).toContain('AUTH_TOKEN is too short. Use at least 16 characters.')
    expect(result.message).not.toContain('default/weak value')
  })

  // Rust-only hardening beyond legacy: a whitespace-only token is JS-truthy
  // (legacy's `!token` check passes it through) but Rust additionally
  // rejects it via `token.trim().is_empty()`. KNOWN DIVERGENCE, not a bug:
  // documented directly in `main.rs::validate_auth_token`'s doc comment.
  test('whitespace-only token: Rust hardens beyond legacy (rejected on Rust, accepted on legacy)', async ({ e2eServerKind }) => {
    const whitespaceToken = ' '.repeat(20)
    const result = await bootWithToken(e2eServerKind, whitespaceToken)
    if (e2eServerKind === 'rust') {
      expect(result.started).toBe(false)
      expect(result.message).toContain('AUTH_TOKEN is required. Refusing to start without authentication.')
    } else {
      // KNOWN DIVERGENCE: legacy's `!token` check is JS-falsy-only, so a
      // 20-space string (truthy, >=16 chars, not in DEFAULT_BAD_TOKENS)
      // passes every startup check and the server boots normally.
      expect(result.started).toBe(true)
    }
  })
})

test.describe('SAFE-01 runtime auth matrix (good/wrong/missing tokens; conflicting sources)', () => {
  test('API: header token authorizes; API: wrong header token is rejected; API: missing token is rejected', async ({ serverInfo }) => {
    const good = await fetch(`${serverInfo.baseUrl}/api/settings`, { headers: { 'x-auth-token': serverInfo.token } })
    expect(good.status).toBe(200)

    const wrong = await fetch(`${serverInfo.baseUrl}/api/settings`, { headers: { 'x-auth-token': 'not-the-real-token' } })
    expect(wrong.status).toBe(401)

    const missing = await fetch(`${serverInfo.baseUrl}/api/settings`)
    expect(missing.status).toBe(401)
  })

  test('API: cookie-only good token authorizes', async ({ serverInfo }) => {
    const res = await fetch(`${serverInfo.baseUrl}/api/settings`, {
      headers: { Cookie: `freshell-auth=${encodeURIComponent(serverInfo.token)}` },
    })
    expect(res.status).toBe(200)
  })

  // SAFE-01's flagship fix: a present, non-empty header wins UNCONDITIONALLY
  // over a cookie, even when the cookie is correct. Proven here via a REAL
  // HTTP round trip (the crate-level unit test in `boot.rs` calls
  // `is_authed()` directly; this exercises the whole request path).
  test('API: conflicting sources -- a WRONG header rejects even with a CORRECT cookie present', async ({ serverInfo }) => {
    const res = await fetch(`${serverInfo.baseUrl}/api/settings`, {
      headers: {
        'x-auth-token': 'wrong-header-value',
        Cookie: `freshell-auth=${encodeURIComponent(serverInfo.token)}`,
      },
    })
    expect(res.status).toBe(401)
  })

  test('API: an EMPTY header value falls through to a correct cookie (not treated as a present header)', async ({ serverInfo }) => {
    const res = await fetch(`${serverInfo.baseUrl}/api/settings`, {
      headers: {
        'x-auth-token': '',
        Cookie: `freshell-auth=${encodeURIComponent(serverInfo.token)}`,
      },
    })
    expect(res.status).toBe(200)
  })

  test('UI: token via ?token= URL query authenticates and is stripped from the URL', async ({ page, serverInfo }) => {
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}`)

    // The auth modal must NOT appear (token from URL authenticated us).
    const modal = page.getByRole('dialog')
    await expect(modal).not.toBeVisible({ timeout: 10_000 })

    // The token must be removed from the visible URL (history.replaceState),
    // never left sitting in browser history / the address bar.
    await expect.poll(() => new URL(page.url()).searchParams.has('token'), { timeout: 5_000 }).toBe(false)
  })

  test('WS: hello with the correct token reaches ready', async ({ serverInfo }) => {
    const { ws, outcome } = await connectAndSendHello(serverInfo.wsUrl, serverInfo.token)
    try {
      expect(outcome).toBe('ready')
    } finally {
      ws.close()
    }
  })

  test('WS: hello with the wrong token closes 4001 "Invalid token"', async ({ serverInfo }) => {
    const { ws, outcome } = await connectAndSendHello(serverInfo.wsUrl, 'definitely-wrong-token')
    try {
      expect(outcome).not.toBe('ready')
      const closed = outcome as { closeCode: number; closeReason: string }
      expect(closed.closeCode).toBe(4001)
      expect(closed.closeReason).toBe('Invalid token')
    } finally {
      ws.close()
    }
  })

  test('WS: hello with a MISSING token closes 4001 "Invalid token" (same as wrong token)', async ({ serverInfo }) => {
    const { ws, outcome } = await connectAndSendHello(serverInfo.wsUrl, undefined)
    try {
      expect(outcome).not.toBe('ready')
      const closed = outcome as { closeCode: number; closeReason: string }
      expect(closed.closeCode).toBe(4001)
      expect(closed.closeReason).toBe('Invalid token')
    } finally {
      ws.close()
    }
  })
})
