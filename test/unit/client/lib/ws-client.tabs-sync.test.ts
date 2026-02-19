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
}

describe('WsClient tabs sync helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    // @ts-expect-error test override
    globalThis.WebSocket = MockWebSocket
    localStorage.setItem('freshell.auth-token', 't')
    ;(window as any).setTimeout = globalThis.setTimeout
    ;(window as any).clearTimeout = globalThis.clearTimeout
  })

  afterEach(() => {
    resetWsClientForTests()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('queues tabs.sync.query until ready and flushes after handshake', async () => {
    const client = new WsClient('ws://example/ws')
    const connectPromise = client.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    const socket = MockWebSocket.instances[0]

    client.sendTabsSyncQuery({
      requestId: 'query-1',
      deviceId: 'local-device',
    })

    socket._open()
    socket._message({ type: 'ready' })
    await connectPromise

    const payloads = socket.sent.map((raw) => JSON.parse(raw))
    expect(payloads.some((msg) => msg.type === 'hello')).toBe(true)
    expect(payloads.some((msg) => msg.type === 'tabs.sync.query' && msg.requestId === 'query-1')).toBe(true)
  })

  it('delivers tabs.sync.snapshot messages to subscribers', async () => {
    const client = new WsClient('ws://example/ws')
    const seen: any[] = []
    const unsubscribe = client.onMessage((msg) => seen.push(msg))

    const connectPromise = client.connect()
    const socket = MockWebSocket.instances[0]
    socket._open()
    socket._message({ type: 'ready' })
    await connectPromise

    socket._message({
      type: 'tabs.sync.snapshot',
      requestId: 'snapshot-1',
      data: { localOpen: [], remoteOpen: [], closed: [] },
    })

    expect(seen.some((msg) => msg.type === 'tabs.sync.snapshot' && msg.requestId === 'snapshot-1')).toBe(true)
    unsubscribe()
  })
})
