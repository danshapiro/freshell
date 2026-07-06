import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsClient, resetWsClientForTests } from '@/lib/ws-client'
import { getClientLogLevel, setClientLogLevel, type ClientLogLevel } from '@/lib/client-logger'

// The WsClient logs through the real component logger, which routes to
// console.{debug,warn,error}. We assert *severity* directly on those channels:
// an expected server restart must stay off error/warn (it floods logs otherwise).
// NB: the shared test setup (test/setup/dom.ts) already fails any test that emits
// an unexpected console.error, so "never error" is enforced for free — we also
// assert it explicitly for clarity.

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

const latestSocket = () => MockWebSocket.instances[MockWebSocket.instances.length - 1]

describe('WsClient reconnect noise', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let previousLevel: ClientLogLevel

  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    // @ts-expect-error - test override
    globalThis.WebSocket = MockWebSocket
    localStorage.setItem('freshell.auth-token', 't')
    ;(window as any).setTimeout = globalThis.setTimeout
    ;(window as any).clearTimeout = globalThis.clearTimeout

    // Allow debug-level routing so a debug log is observable, and silence the
    // channels we assert on (keeps the test output clean).
    previousLevel = getClientLogLevel()
    setClientLogLevel('debug')
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    resetWsClientForTests()
    debugSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    setClientLogLevel(previousLevel)
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  const called = (spy: ReturnType<typeof vi.spyOn>, needle: string) =>
    spy.mock.calls.some((call) => call.map((a) => String(a)).join(' ').includes(needle))

  it('logs a failed reconnect attempt at debug, not error (expected during a restart)', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({ type: 'ready' })
    await p

    // Server shuts down for a restart -> schedule a reconnect.
    MockWebSocket.instances[0]._close(4009, 'server-shutdown')

    // The scheduled reconnect fires and the socket dies again before ready
    // (server still coming back up).
    await vi.advanceTimersByTimeAsync(1000)
    const reconnecting = latestSocket()
    expect(reconnecting).toBeDefined()
    reconnecting._close(1006, 'still-down')
    await vi.advanceTimersByTimeAsync(0)

    expect(errorSpy).not.toHaveBeenCalled()
    expect(called(debugSpy, 'reconnect failed')).toBe(true)
  })

  it('surfaces giving up (max attempts) at warn, never error', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({ type: 'ready' })
    await p

    // Kick off reconnection, then keep failing every attempt until the client
    // gives up.
    MockWebSocket.instances[0]._close(4009, 'server-shutdown')

    for (let i = 0; i < 20 && !called(warnSpy, 'max reconnect attempts reached'); i += 1) {
      await vi.advanceTimersByTimeAsync(5000)
      const latest = latestSocket()
      if (latest) {
        latest._close(1006, 'still-down')
        await vi.advanceTimersByTimeAsync(0)
      }
    }

    expect(called(warnSpy, 'max reconnect attempts reached')).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
