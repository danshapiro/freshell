import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsClient, getWsClient, resetWsClientForTests } from '../../../../src/lib/ws-client'

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

describe('WsClient.connect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    // @ts-expect-error - test override
    globalThis.WebSocket = MockWebSocket
    localStorage.setItem('freshell.auth-token', 't')

    // Some Vitest environments provide a minimal window without timer fns.
    ;(window as any).setTimeout = globalThis.setTimeout
    ;(window as any).clearTimeout = globalThis.clearTimeout
  })

  afterEach(() => {
    resetWsClientForTests()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('returns the same in-flight promise and resolves only after ready', async () => {
    const c = new WsClient('ws://example/ws')

    const p1 = c.connect()
    const p2 = c.connect()
    expect(p2).toBe(p1)

    let resolved = false
    void p1.then(() => { resolved = true })

    // Not resolved until ready arrives.
    await Promise.resolve()
    expect(resolved).toBe(false)

    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({ type: 'ready' })

    await p1
    expect(resolved).toBe(true)
  })

  it('treats HELLO_TIMEOUT as transient and schedules reconnect', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')

    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)

    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._close(4002, 'Hello timeout')

    await expect(p).rejects.toThrow(/Handshake timeout/i)

    // Should schedule a reconnect attempt (baseReconnectDelay = 1000).
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 1000)).toBe(true)
  })

  it('treats BACKPRESSURE as transient and schedules reconnect with a minimum delay', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')

    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)

    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._close(4008, 'Backpressure')

    await expect(p).rejects.toThrow(/backpressure/i)

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]).filter((d): d is number => typeof d === 'number')
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(5000)
  })

  it('treats SERVER_SHUTDOWN (4009) as transient and resets backoff for fast reconnect', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')

    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)

    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._close(4009, 'Server shutdown')

    await expect(p).rejects.toThrow(/Server restarting/i)

    // Should schedule a reconnect at base delay (1000ms) since backoff is reset.
    // Filter out the connection timeout (10000ms) which is unrelated.
    const reconnectDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((d): d is number => typeof d === 'number' && d < 10000)
    expect(reconnectDelays).toContain(1000)
    // No exponential backoff — max reconnect delay should be 1000ms
    expect(Math.max(...reconnectDelays)).toBe(1000)
  })

  it('disconnect clears pending reconnect timers', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)

    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._close(4002, 'Hello timeout')

    await expect(p).rejects.toThrow(/Handshake timeout/i)
    expect(MockWebSocket.instances).toHaveLength(1)

    c.disconnect()

    vi.advanceTimersByTime(5000)
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('resetWsClientForTests tears down singleton reconnect state', async () => {
    const c = getWsClient()
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)

    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._close(4002, 'Hello timeout')

    await expect(p).rejects.toThrow(/Handshake timeout/i)
    expect(MockWebSocket.instances).toHaveLength(1)

    resetWsClientForTests()

    vi.advanceTimersByTime(5000)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getWsClient()).not.toBe(c)
  })
})
