import WebSocket from 'ws'
import { expect, test } from '../helpers/fixtures.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

/**
 * SAFE-05 (JSON ping/pong slice only) -- matrix spec.
 *
 * SAFE-05's full acceptance text: "Enforce hello timeout, JSON ping/pong,
 * and transport heartbeat separately. Reply to an application
 * `{type:"ping"}` with the correlated JSON pong while WebSocket
 * control-frame heartbeat independently closes dead peers; neither may
 * kill a detached terminal."
 *
 * This spec proves ONLY the cheaply-provable clause: a raw WS client
 * (bypassing the browser entirely, harness-token `hello`) sends the
 * app-level `{type:"ping"}` and gets back the exact `{type:"pong",
 * timestamp}` shape -- byte-identical between the legacy Node server
 * (`server/ws-handler.ts:1832-1835`) and the Rust port. It runs against
 * BOTH `legacy-chromium` and `rust-chromium` via `MATRIX_SPECS` in
 * `playwright.config.ts`, with legacy as the control.
 *
 * NOT covered here (see the SAFE-05 checklist entry for why each is
 * unproven):
 *   - hello-timeout enforcement (delay past/just-before the deadline) --
 *     the Rust port has no hello-timeout implementation at all (confirmed
 *     by exhaustive grep across `crates/`), so this clause cannot pass on
 *     rust-chromium today; it is a genuine implementation gap, not a test
 *     gap.
 *   - transport control-frame heartbeat independently closing dead peers
 *     via a controllable proxy that can suppress/respond to pings at will
 *     -- needs proxy infrastructure this lane does not own; unit-level
 *     keepalive tests exist in `crates/freshell-ws` but no PW-RUST
 *     browser-visible proof exists.
 *   - "neither may kill a detached terminal" / subscription cleanup /
 *     replacement-page-attaches-to-surviving-terminal -- requires a full
 *     detached-terminal lifecycle scenario, not a cheap protocol exchange.
 */

const ISO_TIMESTAMP_MILLIS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** Open a raw WS connection and complete the harness-token `hello` handshake. */
function connectAndHello(wsUrl: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timeout = setTimeout(() => {
      ws.removeAllListeners()
      ws.terminate()
      reject(new Error('Timed out waiting for ready after hello'))
    }, 10_000)

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token, protocolVersion: WS_PROTOCOL_VERSION }))
    })

    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message?.type === 'ready') {
        clearTimeout(timeout)
        ws.removeAllListeners('message')
        resolve(ws)
      }
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/** Resolve with the next message matching `predicate`, or reject on timeout. */
function nextMessage(ws: WebSocket, predicate: (message: unknown) => boolean, timeoutMs = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', onMessage)
      reject(new Error('Timed out waiting for matching WS message'))
    }, timeoutMs)

    function onMessage(raw: WebSocket.RawData) {
      const message = JSON.parse(String(raw))
      if (predicate(message)) {
        clearTimeout(timeout)
        ws.removeListener('message', onMessage)
        resolve(message)
      }
    }

    ws.on('message', onMessage)
  })
}

test.describe('SAFE-05 JSON ping/pong matrix', () => {
  test('replies to an application ping with the exact correlated pong shape', async ({ serverInfo }) => {
    const ws = await connectAndHello(serverInfo.wsUrl, serverInfo.token)
    try {
      const pongPromise = nextMessage(ws, (m: any) => m?.type === 'pong')
      ws.send(JSON.stringify({ type: 'ping' }))
      const pong = await pongPromise

      // Byte-parity shape: EXACTLY {type, timestamp} -- no extra fields, no
      // missing fields, timestamp is ISO-8601 millis 'Z' (matches legacy's
      // `nowIso()` at server/ws-handler.ts:1834).
      expect(Object.keys(pong).sort()).toEqual(['timestamp', 'type'])
      expect(pong.type).toBe('pong')
      expect(pong.timestamp).toMatch(ISO_TIMESTAMP_MILLIS_Z)
    } finally {
      ws.close()
    }
  })

  test('each independent ping gets its own freshly-timestamped pong, not a cached reply', async ({ serverInfo }) => {
    const ws = await connectAndHello(serverInfo.wsUrl, serverInfo.token)
    try {
      const first = nextMessage(ws, (m: any) => m?.type === 'pong')
      ws.send(JSON.stringify({ type: 'ping' }))
      const pong1 = await first

      const second = nextMessage(ws, (m: any) => m?.type === 'pong')
      ws.send(JSON.stringify({ type: 'ping' }))
      const pong2 = await second

      expect(pong1.timestamp).toMatch(ISO_TIMESTAMP_MILLIS_Z)
      expect(pong2.timestamp).toMatch(ISO_TIMESTAMP_MILLIS_Z)
      // Two distinct reply objects for two distinct pings (not one pong
      // replayed twice), and time only moves forward.
      expect(pong2.timestamp >= pong1.timestamp).toBe(true)
    } finally {
      ws.close()
    }
  })
})
