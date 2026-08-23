import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsClient, resetWsClientForTests } from '../../../../src/lib/ws-client'

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  onopen: null | (() => void) = null
  onmessage: null | ((ev: { data: string }) => void) = null
  onclose: null | ((ev: { code: number; reason: string }) => void) = null
  onerror: null | (() => void) = null
  sent: string[] = []

  constructor(_url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: any) {
    this.sent.push(String(data))
  }

  close() {
    this.onclose?.({ code: 1000, reason: '' })
  }

  _open() {
    this.onopen?.()
  }

  _message(obj: any) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  _close(code: number, reason = '') {
    this.onclose?.({ code, reason })
  }
}

// Shared fresh-socket handshake fixture: every abandon test delivers this on
// the replacement socket so the recycled connection reaches ready.
const READY_MSG = { type: 'ready', bootId: 'b1', serverInstanceId: 's1', capabilities: {} }

async function connectReady(client: WsClient): Promise<{ client: WsClient; socket: MockWebSocket }> {
  const p = client.connect()
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  socket._open()
  socket._message(READY_MSG)
  await p
  return { client, socket }
}

describe('WsClient liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    // @ts-expect-error - test override
    globalThis.WebSocket = MockWebSocket
    localStorage.setItem('freshell.auth-token', 't')

    // Some Vitest environments provide a minimal window without timer fns.
    // jsdom window timers are NOT auto-faked: re-point the interval fns too,
    // or the liveness watch never ticks under fake-timer advances.
    ;(window as any).setTimeout = globalThis.setTimeout
    ;(window as any).clearTimeout = globalThis.clearTimeout
    ;(window as any).setInterval = globalThis.setInterval
    ;(window as any).clearInterval = globalThis.clearInterval
  })

  afterEach(() => {
    resetWsClientForTests()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('sends an app-level ping after 30s of inbound silence while ready', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    // Ready traffic itself was inbound activity. 10s ticks at t=10/20 skip
    // (silence < 30s); the t=30 tick sees silence === 30s and probes.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(true)
  })

  it('does not ping while inbound traffic keeps the socket fresh', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    await vi.advanceTimersByTimeAsync(15_000)
    socket._message({ type: 'settings.updated', settings: {} }) // any inbound frame
    await vi.advanceTimersByTimeAsync(15_000)
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(false)
  })

  it('abandons a socket whose probe goes unanswered past the pong timeout — no reliance on its onclose', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    await vi.advanceTimersByTimeAsync(30_000)          // probe sent
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(true)
    // The dead transport NEVER delivers onclose — that is the hazard under test.
    // t=30 tick probes; the t=40 tick sees probe age 10s >= PONG_TIMEOUT_MS and abandons.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(MockWebSocket.instances.length).toBe(2)     // fresh socket driven immediately
    const fresh = MockWebSocket.instances[1]
    fresh._open(); fresh._message(READY_MSG)           // fresh socket completes handshake
    socket._close(4002, 'late')                        // stale socket's LATE close arrives
    await vi.advanceTimersByTimeAsync(5_000)
    expect(MockWebSocket.instances.length).toBe(2)     // …and is ignored (generation guard)
  })

  it('clears the outstanding probe on any inbound message (no abandon while traffic flows)', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    await vi.advanceTimersByTimeAsync(30_000)           // t=30: probe
    socket._message({ type: 'pong', timestamp: 'x' })  // probe cleared; silence restarts from t=30
    // Silence restarts at the last inbound frame, so feed periodic traffic:
    // at each 10s tick silence stays < 30s and no further probe is needed.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(20_000)
      socket._message({ type: 'settings.updated', settings: {} })
    }
    expect(MockWebSocket.instances.length).toBe(1)     // never abandoned
  })

  it('re-probes on persistent silence and abandons when the repeat probe also goes unanswered', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    await vi.advanceTimersByTimeAsync(30_000)           // t=30: probe #1
    socket._message({ type: 'pong', timestamp: 'x' })  // t=30: cleared
    await vi.advanceTimersByTimeAsync(40_000)           // t=60: probe #2; t=70: unanswered 10s → abandon
    expect(MockWebSocket.instances.length).toBe(2)
  })

  it('poke() while ready and recently active sends an immediate probe', async () => {
    const { client, socket } = await connectReady(new WsClient('ws://test/ws'))
    client.poke()
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(true)
  })

  it('poke() after 65s+ of silence abandons immediately instead of waiting out the probe', async () => {
    const { client, socket } = await connectReady(new WsClient('ws://test/ws'))
    // Simulate a frozen tab: no timers ran (background clamp) but the wall
    // clock jumped past the keepalive window threshold.
    vi.setSystemTime(Date.now() + 65_000)
    client.poke()                                      // no onclose delivery from the dead socket
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(false) // no probe wait
    expect(MockWebSocket.instances.length).toBe(2)     // abandoned into a fresh socket
    vi.setSystemTime(Date.now() - 65_000)
  })

  it('poke() while disconnected skips the pending backoff wait and connects now', async () => {
    const { client } = await connectReady(new WsClient('ws://test/ws'))
    MockWebSocket.instances[0]._close(4002, 'boom')    // transient → scheduleReconnect armed (1s+)
    client.poke()
    expect(MockWebSocket.instances.length).toBe(2)     // connected without advancing timers
  })

  it('stops probing after disconnect()', async () => {
    const { client, socket } = await connectReady(new WsClient('ws://test/ws'))
    client.disconnect()
    const sentCount = socket.sent.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket.sent.length).toBe(sentCount)
  })
})
