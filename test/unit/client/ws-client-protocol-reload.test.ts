import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsClient } from '../../../src/lib/ws-client'

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  onopen: null | (() => void) = null
  onmessage: null | ((ev: { data: string }) => void) = null
  onclose: null | ((ev: { code: number; reason: string }) => void) = null
  sent: string[] = []

  constructor(_url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: unknown) {
    this.sent.push(String(data))
  }

  close() {
    this.onclose?.({ code: 1000, reason: '' })
  }

  _open() {
    this.onopen?.()
  }

  _message(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  _close(code: number, reason = '') {
    this.onclose?.({ code, reason })
  }
}

describe('WsClient protocol reload mismatch handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    // @ts-expect-error - test WebSocket replacement
    globalThis.WebSocket = MockWebSocket
    localStorage.setItem('freshell.auth-token', 't')
    ;(window as any).setTimeout = globalThis.setTimeout
    ;(window as any).clearTimeout = globalThis.clearTimeout
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('preserves queued traffic between handshakes and flushes it only after v7 ready', async () => {
    const client = new WsClient('ws://example/ws')
    client.send({ type: 'sdk.create', requestId: 'stale-sdk-create' } as any)
    client.send({
      type: 'freshAgent.create',
      requestId: 'fresh-agent-create',
      sessionType: 'freshcodex',
      provider: 'codex',
    } as any)
    client.send({ type: 'ui.layout.sync', layout: { tabs: [] } } as any)

    const pending = client.connect()
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({
      type: 'error',
      code: 'PROTOCOL_MISMATCH',
      message: 'Use protocol v7',
      timestamp: new Date().toISOString(),
    })

    expect(MockWebSocket.instances).toHaveLength(2)
    MockWebSocket.instances[1]._open()
    expect(MockWebSocket.instances[1].sent.map((raw) => JSON.parse(raw).type)).toEqual(['hello'])
    MockWebSocket.instances[1]._message({ type: 'ready' })
    await pending

    const fallbackMessages = MockWebSocket.instances[1].sent.map((raw) => JSON.parse(raw))
    expect(fallbackMessages[0]).toMatchObject({
      type: 'hello',
      protocolVersion: 7,
    })
    expect(fallbackMessages[0].capabilities.paneReconcileExactV1).toBeUndefined()
    expect(fallbackMessages.slice(1).map((message) => message.type)).toEqual([
      'freshAgent.create',
      'sdk.create',
      'ui.layout.sync',
    ])
  })
})
