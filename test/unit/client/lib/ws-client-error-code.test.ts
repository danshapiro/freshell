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

describe('WsClient close code errors', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    // @ts-expect-error - test override
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

  it('4003 error includes wsCloseCode property', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()

    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._close(4003, 'max connections')

    try {
      await p
      expect.fail('should have rejected')
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain('max connections')
      expect(err.wsCloseCode).toBe(4003)
    }
  })

  it('4001 error includes wsCloseCode property', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()

    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._close(4001, 'Not authenticated')

    try {
      await p
      expect.fail('should have rejected')
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain('Authentication failed')
      expect(err.wsCloseCode).toBe(4001)
    }
  })

  it('4001 error includes wsCloseCode when server sends error message then close (real auth flow)', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()

    const ws = MockWebSocket.instances[0]
    ws._open()
    // Real server sends NOT_AUTHENTICATED error message first...
    ws._message({ type: 'error', code: 'NOT_AUTHENTICATED', message: 'Not authenticated' })
    // ...then closes with 4001
    ws._close(4001, 'Not authenticated')

    try {
      await p
      expect.fail('should have rejected')
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain('Authentication failed')
      expect(err.wsCloseCode).toBe(4001)
    }
  })

  it('non-close-code errors do not have wsCloseCode', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()

    // Simulate an error before open completes
    MockWebSocket.instances[0].onerror?.()
    MockWebSocket.instances[0]._close(1006, 'Abnormal closure')

    try {
      await p
      expect.fail('should have rejected')
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error)
      expect(err.wsCloseCode).toBeUndefined()
    }
  })
})
