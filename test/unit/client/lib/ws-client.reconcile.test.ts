import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECONCILE_VERDICT_WAIT_MS, WsClient, getWsClient, resetWsClientForTests } from '../../../../src/lib/ws-client'
import { WS_PROTOCOL_VERSION } from '../../../../shared/ws-version'

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

async function connectAndReady(c: WsClient, ready: Record<string, unknown> = {}): Promise<MockWebSocket> {
  const p = c.connect()
  const instance = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  instance._open()
  instance._message({ type: 'ready', ...ready })
  await p
  return instance
}

function framesOf(instance: MockWebSocket): any[] {
  return instance.sent.map((x) => JSON.parse(x))
}

describe('WsClient pane-reconcile capability', () => {
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

  it('hello advertises paneReconcileV1', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]._open()

    const hello = JSON.parse(MockWebSocket.instances[0].sent[0])
    expect(hello.type).toBe('hello')
    expect(hello.protocolVersion).toBe(8)
    expect(hello.capabilities).toMatchObject({
      uiScreenshotV1: true,
      terminalOutputBatchV1: true,
      paneReconcileV1: true,
      paneReconcileExactV1: true,
    })

    MockWebSocket.instances[0]._message({ type: 'ready' })
    await p
  })

  describe('v8 to frozen-v7 transport fallback', () => {
    it('retries once only after a pre-ready PROTOCOL_MISMATCH and preserves queues until v7 ready', async () => {
      const c = new WsClient('ws://example/ws')
      c.send({ type: 'terminal.create', requestId: 'queued-create', mode: 'claude' } as any)
      c.send({ type: 'ping' })

      const connected = c.connect()
      const v8 = MockWebSocket.instances[0]
      v8._open()
      expect(framesOf(v8)[0]).toMatchObject({
        type: 'hello',
        protocolVersion: 8,
        capabilities: { paneReconcileExactV1: true },
      })
      expect(framesOf(v8).filter((frame) => frame.type !== 'hello')).toEqual([])

      v8._message({
        type: 'error',
        code: 'PROTOCOL_MISMATCH',
        message: 'expected v7',
        timestamp: '2026-07-29T00:00:00.000Z',
      })
      expect(MockWebSocket.instances).toHaveLength(2)

      const v7 = MockWebSocket.instances[1]
      // A late close callback from the superseded socket must not clobber the
      // replacement socket or reject the shared connect promise.
      v8._close(4010, 'Protocol version mismatch')
      v7._open()
      const v7Hello = framesOf(v7)[0]
      expect(v7Hello.protocolVersion).toBe(7)
      expect(v7Hello.capabilities?.paneReconcileExactV1).toBeUndefined()
      expect(framesOf(v7).filter((frame) => frame.type !== 'hello')).toEqual([])

      v7._message({ type: 'ready' })
      await expect(connected).resolves.toBeUndefined()
      expect(framesOf(v7).filter((frame) => frame.type !== 'hello')).toEqual([
        expect.objectContaining({ type: 'terminal.create', requestId: 'queued-create' }),
        { type: 'ping' },
      ])
    })

    it('never oscillates after the one v7 retry', async () => {
      const c = new WsClient('ws://example/ws')
      const result = c.connect().then(
        () => 'resolved',
        () => 'rejected',
      )
      const v8 = MockWebSocket.instances[0]
      v8._open()
      v8._message({
        type: 'error',
        code: 'PROTOCOL_MISMATCH',
        message: 'expected v7',
        timestamp: '2026-07-29T00:00:00.000Z',
      })

      const v7 = MockWebSocket.instances[1]
      v7._open()
      v7._message({
        type: 'error',
        code: 'PROTOCOL_MISMATCH',
        message: 'still mismatched',
        timestamp: '2026-07-29T00:00:00.000Z',
      })
      expect(await result).toBe('rejected')
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    it('does not downgrade on a close code without the actual mismatch frame', async () => {
      const c = new WsClient('ws://example/ws')
      const result = c.connect().then(
        () => 'resolved',
        () => 'rejected',
      )
      const socket = MockWebSocket.instances[0]
      socket._open()
      socket._close(4010, 'Protocol version mismatch')

      expect(await result).toBe('rejected')
      expect(MockWebSocket.instances).toHaveLength(1)
    })

    it('does not downgrade after authentication failure', async () => {
      const c = new WsClient('ws://example/ws')
      const result = c.connect().then(
        () => 'resolved',
        () => 'rejected',
      )
      const socket = MockWebSocket.instances[0]
      socket._open()
      socket._message({
        type: 'error',
        code: 'NOT_AUTHENTICATED',
        message: 'no',
        timestamp: '2026-07-29T00:00:00.000Z',
      })

      expect(await result).toBe('rejected')
      expect(MockWebSocket.instances).toHaveLength(1)
    })
  })

  it('surfaces ready.capabilities and resets them on disconnect', async () => {
    const client = getWsClient()
    expect(client.getServerCapabilities()).toEqual({})

    await connectAndReady(client, { capabilities: { paneReconcileV1: true } })
    expect(client.getServerCapabilities().paneReconcileV1).toBe(true)

    MockWebSocket.instances[0]._close(1006, 'drop')
    expect(client.getServerCapabilities().paneReconcileV1).toBeUndefined()
    expect(client.getServerCapabilities()).toEqual({})
  })

  it('suppresses the in-flight create replay when the capability is acked', async () => {
    const c = new WsClient('ws://example/ws')
    c.send({ type: 'terminal.create', requestId: 'cr-1', mode: 'shell' } as any)

    await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
    MockWebSocket.instances[0]._close(1006, 'drop-after-create')

    const reconnectInstance = await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
    const creates = framesOf(reconnectInstance).filter((f) => f.type === 'terminal.create')
    expect(creates).toHaveLength(0)
  })

  it('keeps the legacy replay when the server does not ack (old server)', async () => {
    const c = new WsClient('ws://example/ws')
    c.send({ type: 'terminal.create', requestId: 'cr-1', mode: 'shell' } as any)

    await connectAndReady(c, { /* no capabilities */ })
    MockWebSocket.instances[0]._close(1006, 'drop-after-create')

    const reconnectInstance = await connectAndReady(c, { /* no capabilities */ })
    const creates = framesOf(reconnectInstance).filter((f) => f.type === 'terminal.create')
    expect(creates).toHaveLength(1)
  })

  it('honors a downgraded server: capability acked on a previous socket does not suppress replay', async () => {
    const c = new WsClient('ws://example/ws')
    c.send({ type: 'terminal.create', requestId: 'cr-1', mode: 'shell' } as any)

    // First connection acks the capability.
    await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
    MockWebSocket.instances[0]._close(1006, 'drop-after-create')

    // Downgraded server: reconnect ready has no capabilities. Legacy replay must fire.
    const reconnectInstance = await connectAndReady(c, { /* no capabilities */ })
    const creates = framesOf(reconnectInstance).filter((f) => f.type === 'terminal.create')
    expect(creates).toHaveLength(1)
  })

  it('holds the pre-ready create queue when the capability is acked; timeout fallback flushes it', async () => {
    // (was: "flushes the pre-ready create queue even when the capability is acked")
    const c = new WsClient('ws://example/ws')
    // Queued while offline: still a NEW user-initiated create, but under the
    // sender-level pre-verdict hold it waits for a verdict (or the bound).
    c.send({ type: 'terminal.create', requestId: 'cr-new', mode: 'shell' } as any)

    const instance = await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
    expect(framesOf(instance).filter((f) => f.type === 'terminal.create')).toHaveLength(0)

    vi.advanceTimersByTime(RECONCILE_VERDICT_WAIT_MS + 50)
    const creates = framesOf(instance).filter((f) => f.type === 'terminal.create')
    expect(creates).toEqual([
      expect.objectContaining({ type: 'terminal.create', requestId: 'cr-new' }),
    ])
  })

  describe('sender-level pre-verdict create hold', () => {
    it('exports RECONCILE_VERDICT_WAIT_MS = 4000 (the ONE definition Tasks 8/9 import)', () => {
      expect(RECONCILE_VERDICT_WAIT_MS).toBe(4_000)
    })

    it('holds queued pane creates on ready when paneReconcileV1 is acked (nothing on the wire)', async () => {
      const c = new WsClient('ws://example/ws')
      c.send({ type: 'terminal.create', requestId: 'req-t' } as any)
      c.send({ type: 'freshAgent.create', requestId: 'req-f' } as any)

      const instance = await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
      expect(framesOf(instance).filter((f) => f.type === 'terminal.create')).toHaveLength(0)
      expect(framesOf(instance).filter((f) => f.type === 'freshAgent.create')).toHaveLength(0)
    })

    it('setReconcilePendingCreates releases creates OUTSIDE the pending set immediately', async () => {
      const c = new WsClient('ws://example/ws')
      c.send({ type: 'terminal.create', requestId: 'req-a' } as any)
      c.send({ type: 'terminal.create', requestId: 'req-b' } as any)

      const instance = await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
      c.setReconcilePendingCreates(['req-a'])

      const creates = framesOf(instance).filter((f) => f.type === 'terminal.create')
      expect(creates).toEqual([
        expect.objectContaining({ type: 'terminal.create', requestId: 'req-b' }),
      ])
    })

    it('after setReconcilePendingCreates, new creates outside the set send immediately; ones inside are held', async () => {
      const c = new WsClient('ws://example/ws')
      const instance = await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
      c.setReconcilePendingCreates(['req-pending'])

      c.send({ type: 'terminal.create', requestId: 'req-pending' } as any)
      c.send({ type: 'terminal.create', requestId: 'req-other' } as any)

      const creates = framesOf(instance).filter((f) => f.type === 'terminal.create')
      expect(creates).toEqual([
        expect.objectContaining({ type: 'terminal.create', requestId: 'req-other' }),
      ])
    })

    it('cancelCreate retracts a held create (attach-fold path) — it never reaches the wire', async () => {
      const c = new WsClient('ws://example/ws')
      c.send({ type: 'terminal.create', requestId: 'req-a' } as any)
      c.send({ type: 'terminal.create', requestId: 'req-b' } as any)

      const instance = await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
      c.cancelCreate('req-a')
      c.clearReconcileCreateHold()

      const creates = framesOf(instance).filter((f) => f.type === 'terminal.create')
      expect(creates.filter((f) => f.requestId === 'req-a')).toHaveLength(0)
      // Still-held creates flush on clearReconcileCreateHold (cardinality-gap fallback).
      expect(creates).toEqual([
        expect.objectContaining({ type: 'terminal.create', requestId: 'req-b' }),
      ])
    })

    it('flushes remaining held creates after RECONCILE_VERDICT_WAIT_MS (legacy fallback)', async () => {
      const c = new WsClient('ws://example/ws')
      const instance = await connectAndReady(c, { capabilities: { paneReconcileV1: true } })

      // Mount effect committing after ready: held while the hold is active.
      c.send({ type: 'terminal.create', requestId: 'req-a' } as any)
      expect(framesOf(instance).filter((f) => f.type === 'terminal.create')).toHaveLength(0)

      vi.advanceTimersByTime(RECONCILE_VERDICT_WAIT_MS + 50)
      const creates = framesOf(instance).filter((f) => f.type === 'terminal.create')
      expect(creates).toEqual([
        expect.objectContaining({ type: 'terminal.create', requestId: 'req-a' }),
      ])
    })

    it('without paneReconcileV1 the pre-ready flush is byte-identical (regression)', async () => {
      const c = new WsClient('ws://example/ws')
      c.send({ type: 'terminal.create', requestId: 'req-a' } as any)

      const instance = await connectAndReady(c, { /* no capabilities */ })
      const creates = framesOf(instance).filter((f) => f.type === 'terminal.create')
      expect(creates).toEqual([
        expect.objectContaining({ type: 'terminal.create', requestId: 'req-a' }),
      ])
    })

    it('disconnect mid-hold re-queues held creates for the next connection (sent exactly once, same requestId)', async () => {
      const c = new WsClient('ws://example/ws')
      c.send({ type: 'terminal.create', requestId: 'req-a' } as any)

      await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
      // Held, never on the wire; connection drops mid-hold.
      MockWebSocket.instances[MockWebSocket.instances.length - 1]._close(1006, 'drop-mid-hold')

      // Downgraded server: no capability, the create flushes via the normal
      // preReadyCreateQueue path — exactly once, never a duplicate.
      const reconnectInstance = await connectAndReady(c, { /* no capabilities */ })
      const creates = framesOf(reconnectInstance).filter((f) => f.type === 'terminal.create')
      expect(creates).toEqual([
        expect.objectContaining({ type: 'terminal.create', requestId: 'req-a' }),
      ])
    })
  })

  it('hello opts into paneReconcileFreshAgentV1', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]._open()

    const sentMessages = framesOf(MockWebSocket.instances[0])
    const hello = sentMessages.find((m) => m.type === 'hello') as { capabilities?: Record<string, unknown> }
    expect(hello?.capabilities?.paneReconcileFreshAgentV1).toBe(true)
    expect(hello?.capabilities?.paneReconcileExactV1).toBe(true)
    expect(WS_PROTOCOL_VERSION).toBe(8)

    MockWebSocket.instances[0]._message({ type: 'ready' })
    await p
  })

  it('getServerCapabilities exposes paneReconcileFreshAgentV1 from ready', async () => {
    const client = getWsClient()
    await connectAndReady(client, { capabilities: { paneReconcileV1: true, paneReconcileFreshAgentV1: true } })
    expect(client.getServerCapabilities().paneReconcileFreshAgentV1).toBe(true)
  })
})
