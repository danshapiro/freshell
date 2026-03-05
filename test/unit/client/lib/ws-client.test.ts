import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsClient, getWsClient, resetWsClientForTests } from '../../../../src/lib/ws-client'
import { WS_PROTOCOL_VERSION } from '../../../../shared/ws-protocol'

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

  it('sends protocol version in hello and omits legacy terminalAttachChunk capability', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]._open()

    const hello = JSON.parse(MockWebSocket.instances[0].sent[0])
    expect(hello.type).toBe('hello')
    expect(hello.protocolVersion).toBe(WS_PROTOCOL_VERSION)
    expect(hello.capabilities).toEqual({ sessionsPatchV1: true, sessionsPaginationV1: true, uiScreenshotV1: true })

    MockWebSocket.instances[0]._message({ type: 'ready' })
    await p
  })

  it('hello payload does not advertise split flags (one-way negotiation)', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]._open()

    const hello = JSON.parse(MockWebSocket.instances[0].sent[0])
    expect(hello.type).toBe('hello')
    expect(hello.capabilities?.createAttachSplitV1).toBeUndefined()
    expect(hello.capabilities?.attachViewportV1).toBeUndefined()

    MockWebSocket.instances[0]._message({ type: 'ready' })
    await p
  })

  it('stores ready.capabilities and exposes split support helpers', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({
      type: 'ready',
      capabilities: { createAttachSplitV1: true, attachViewportV1: true },
    })
    await p
    expect(c.supportsCreateAttachSplitV1()).toBe(true)
    expect(c.supportsAttachViewportV1()).toBe(true)
  })

  it('defaults capabilities to false when server does not advertise them', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({ type: 'ready' })
    await p
    expect(c.supportsCreateAttachSplitV1()).toBe(false)
    expect(c.supportsAttachViewportV1()).toBe(false)
  })

  it('connect-time queued create resolves mode after ready (no stale unknown state)', async () => {
    const c = new WsClient('ws://example/ws')
    c.send({ type: 'terminal.create', requestId: 'queued-1', mode: 'shell', attachOnCreate: false } as any)
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({
      type: 'ready',
      capabilities: { createAttachSplitV1: true, attachViewportV1: true },
    })
    await p
    const flushed = MockWebSocket.instances[0].sent.map((x) => JSON.parse(x))
    expect(flushed.some((m) => m.type === 'terminal.create' && m.requestId === 'queued-1' && m.attachOnCreate === false)).toBe(true)
  })

  it('connect failure then ready flush sends queued create exactly once', async () => {
    const c = new WsClient('ws://example/ws')
    c.send({ type: 'terminal.create', requestId: 'queued-fail-then-ready', mode: 'shell' } as any)

    const p1 = c.connect()
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._close(1006, 'before-ready')
    await expect(p1).rejects.toThrow()

    const p2 = c.connect()
    MockWebSocket.instances[1]._open()
    MockWebSocket.instances[1]._message({
      type: 'ready',
      capabilities: { createAttachSplitV1: true, attachViewportV1: true },
    })
    await p2

    const sent = MockWebSocket.instances[1].sent.map((x) => JSON.parse(x))
    expect(sent.filter((m) => m.type === 'terminal.create' && m.requestId === 'queued-fail-then-ready')).toHaveLength(1)
  })

  it('capabilities reset to unknown/false on close and refresh on next ready', async () => {
    const c = new WsClient('ws://example/ws')
    const p1 = c.connect()
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({
      type: 'ready',
      capabilities: { createAttachSplitV1: true, attachViewportV1: true },
    })
    await p1
    expect(c.supportsCreateAttachSplitV1()).toBe(true)
    expect(c.supportsAttachViewportV1()).toBe(true)

    MockWebSocket.instances[0]._close(1006, 'reconnect')
    const p2 = c.connect()
    MockWebSocket.instances[1]._open()
    MockWebSocket.instances[1]._message({
      type: 'ready',
      capabilities: { createAttachSplitV1: false, attachViewportV1: false },
    })
    await p2
    expect(c.supportsCreateAttachSplitV1()).toBe(false)
    expect(c.supportsAttachViewportV1()).toBe(false)
  })

  it('explicit-only reconnect with unknown terminalId resends in-flight create once after ready', async () => {
    const c = new WsClient('ws://example/ws')
    c.setLifecycleMode('explicit-only')
    c.send({ type: 'terminal.create', requestId: 'reconnect-unknown-1', mode: 'shell' } as any)

    const p1 = c.connect()
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({
      type: 'ready',
      capabilities: { createAttachSplitV1: true, attachViewportV1: true },
    })
    await p1
    MockWebSocket.instances[0]._close(1006, 'drop-after-create')

    const p2 = c.connect()
    MockWebSocket.instances[1]._open()
    MockWebSocket.instances[1]._message({
      type: 'ready',
      capabilities: { createAttachSplitV1: true, attachViewportV1: true },
    })
    await p2

    const sent = MockWebSocket.instances[1].sent.map((x) => JSON.parse(x))
    expect(sent.filter((m) => m.type === 'terminal.create' && m.requestId === 'reconnect-unknown-1')).toHaveLength(1)
  })

  it('evicted queued creates are removed from reconnect resend tracking', async () => {
    const c = new WsClient('ws://example/ws')
    c.setLifecycleMode('explicit-only')
    ;(c as any).maxQueueSize = 1

    c.send({ type: 'terminal.create', requestId: 'evict-older-create', mode: 'shell' } as any)
    c.send({ type: 'terminal.create', requestId: 'keep-newer-create', mode: 'shell' } as any)

    const p1 = c.connect()
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({
      type: 'ready',
      capabilities: { createAttachSplitV1: true, attachViewportV1: true },
    })
    await p1

    const firstCreates = MockWebSocket.instances[0].sent
      .map((x) => JSON.parse(x))
      .filter((m) => m.type === 'terminal.create')
      .map((m) => m.requestId)
    expect(firstCreates).toEqual(['keep-newer-create'])

    MockWebSocket.instances[0]._close(1006, 'drop-after-ready')

    const p2 = c.connect()
    MockWebSocket.instances[1]._open()
    MockWebSocket.instances[1]._message({
      type: 'ready',
      capabilities: { createAttachSplitV1: true, attachViewportV1: true },
    })
    await p2

    const secondCreates = MockWebSocket.instances[1].sent
      .map((x) => JSON.parse(x))
      .filter((m) => m.type === 'terminal.create')
      .map((m) => m.requestId)
    expect(secondCreates).toEqual(['keep-newer-create'])
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

  it('uses standard reconnect timing for ordinary disconnects (no backpressure penalty loop)', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')

    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)

    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._close(1006, 'Abnormal closure')

    await expect(p).rejects.toThrow(/closed before ready/i)

    const reconnectDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((d): d is number => typeof d === 'number' && d < 10000)

    expect(reconnectDelays).toContain(1000)
    expect(reconnectDelays.every((delay) => delay < 5000)).toBe(true)
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

  it('treats protocol version mismatch as fatal and does not reconnect', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')

    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)

    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._close(4010, 'Protocol version mismatch')

    await expect(p).rejects.toThrow(/protocol version/i)
    await Promise.resolve()

    const reconnectDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((d): d is number => typeof d === 'number' && d < 10000)
    expect(reconnectDelays).toHaveLength(0)

    vi.advanceTimersByTime(30_000)
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('queues input while disconnected and flushes after ready', async () => {
    const c = new WsClient('ws://example/ws')

    c.send({ type: 'terminal.input', terminalId: 'term-1', data: 'pwd\n' })

    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]._open()

    const sentBeforeReady = MockWebSocket.instances[0].sent.map((entry) => JSON.parse(entry))
    expect(sentBeforeReady).toHaveLength(1)
    expect(sentBeforeReady[0].type).toBe('hello')

    MockWebSocket.instances[0]._message({ type: 'ready' })
    await p

    const sentAfterReady = MockWebSocket.instances[0].sent.map((entry) => JSON.parse(entry))
    expect(sentAfterReady.some((msg: any) =>
      msg.type === 'terminal.input' && msg.terminalId === 'term-1' && msg.data === 'pwd\n',
    )).toBe(true)
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
