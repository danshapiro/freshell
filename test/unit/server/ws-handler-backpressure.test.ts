// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import http from 'http'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler'
import { TerminalRegistry } from '../../../server/terminal-registry'
import { TerminalStreamBroker } from '../../../server/terminal-stream/broker'
import {
  measureTerminalOutputPayloadBytes,
  TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE,
} from '../../../server/terminal-stream/serialized-budget'
import { MAX_REALTIME_MESSAGE_BYTES } from '../../../shared/read-models.js'

const loggerMocks = vi.hoisted(() => {
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { logger }
})

vi.mock('../../../server/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/logger')>()
  return {
    ...actual,
    logger: loggerMocks.logger,
    sessionLifecycleLogger: loggerMocks.logger,
  }
})

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}))

const TEST_AUTH_TOKEN = 'testtoken-testtoken'

/** Create a mock WebSocket that extends EventEmitter (like real ws WebSockets) */
function createMockWs(overrides: Record<string, unknown> = {}) {
  const ws = new EventEmitter() as EventEmitter & {
    bufferedAmount: number
    readyState: number
    send: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    connectionId?: string
    sessionUpdateGeneration?: number
  }
  ws.bufferedAmount = 0
  ws.readyState = WebSocket.OPEN
  ws.send = vi.fn()
  ws.close = vi.fn()
  Object.assign(ws, overrides)
  return ws
}

function structuredLogs(level: 'debug' | 'info' | 'warn' | 'error', event: string) {
  return loggerMocks.logger[level].mock.calls
    .map(([payload]) => payload)
    .filter((payload): payload is Record<string, unknown> => (
      !!payload
      && typeof payload === 'object'
      && (payload as { event?: unknown }).event === event
    ))
}

class FakeBrokerRegistry extends EventEmitter {
  private records = new Map<string, { terminalId: string; mode: string; buffer: { snapshot: () => string } }>()
  private replayRingMaxChars: number | undefined

  createTerminal(terminalId: string, mode = 'shell') {
    this.records.set(terminalId, {
      terminalId,
      mode,
      buffer: { snapshot: () => '' },
    })
  }

  attach(terminalId: string) {
    return this.records.get(terminalId) ?? null
  }

  resize(_terminalId: string, _cols: number, _rows: number) {
    return true
  }

  detach(_terminalId: string) {
    return true
  }

  setReplayRingMaxBytes(next: number | undefined) {
    this.replayRingMaxChars = next
  }

  getReplayRingMaxChars() {
    return this.replayRingMaxChars
  }

  get(terminalId: string) {
    return this.records.get(terminalId)
  }
}

let originalAuthToken: string | undefined
let originalTerminalClientQueueMaxBytes: string | undefined

beforeEach(() => {
  originalAuthToken = process.env.AUTH_TOKEN
  originalTerminalClientQueueMaxBytes = process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES
  process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  loggerMocks.logger.debug.mockClear()
  loggerMocks.logger.info.mockClear()
  loggerMocks.logger.warn.mockClear()
  loggerMocks.logger.error.mockClear()
})

afterEach(() => {
  if (originalAuthToken === undefined) {
    delete process.env.AUTH_TOKEN
  } else {
    process.env.AUTH_TOKEN = originalAuthToken
  }
  if (originalTerminalClientQueueMaxBytes === undefined) {
    delete process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES
  } else {
    process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES = originalTerminalClientQueueMaxBytes
  }
})

function forceSmallTerminalClientQueueForOverflowTest(): void {
  process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES = String(128 * 1024)
}

describe('WsHandler backpressure', () => {
  let server: http.Server
  let handler: WsHandler
  let registry: TerminalRegistry

  beforeEach(async () => {
    server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    registry = new TerminalRegistry()
    handler = new WsHandler(server, registry)
  })

  afterEach(async () => {
    handler?.close()
    registry.shutdown()
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('closes the socket when bufferedAmount exceeds the limit', () => {
    const ws = {
      bufferedAmount: 10_000_000,
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as any

    ;(handler as any).send(ws, { type: 'test' })

    expect(ws.close).toHaveBeenCalled()
    expect(ws.send).not.toHaveBeenCalled()
  })
})

describe('WsHandler.waitForDrain', () => {
  let server: http.Server
  let handler: WsHandler
  let registry: TerminalRegistry

  beforeEach(async () => {
    server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    registry = new TerminalRegistry()
    handler = new WsHandler(server, registry)
  })

  afterEach(async () => {
    handler?.close()
    registry.shutdown()
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('resolves true immediately when bufferedAmount is below threshold', async () => {
    const ws = createMockWs({ bufferedAmount: 100 })
    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000)
    expect(result).toBe(true)
  })

  it('resolves true when bufferedAmount drops below threshold via polling', async () => {
    const ws = createMockWs({ bufferedAmount: 1_000_000 })

    // Simulate buffer draining after ~100ms
    setTimeout(() => {
      ws.bufferedAmount = 0
    }, 100)

    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000)
    expect(result).toBe(true)
  })

  it('resolves false when timeout expires and bufferedAmount stays high', async () => {
    const ws = createMockWs({ bufferedAmount: 1_000_000 })

    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 100)
    expect(result).toBe(false)
  })

  it('resolves false when connection closes while waiting', async () => {
    const ws = createMockWs({ bufferedAmount: 1_000_000 })

    // Simulate connection close after 50ms
    setTimeout(() => {
      ws.readyState = WebSocket.CLOSED
      ws.emit('close')
    }, 50)

    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000)
    expect(result).toBe(false)
  })

  it('resolves false immediately when readyState is not OPEN', async () => {
    const ws = createMockWs({ readyState: WebSocket.CLOSED, bufferedAmount: 1_000_000 })
    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000)
    expect(result).toBe(false)
  })

  it('cleans up timer and poller after resolving', async () => {
    const ws = createMockWs({ bufferedAmount: 100 })
    await (handler as any).waitForDrain(ws, 512 * 1024, 5000)
    // After resolving, no close listener should remain from waitForDrain
    expect(ws.listenerCount('close')).toBe(0)
  })

  it('resolves false immediately when shouldCancel returns true', async () => {
    const ws = createMockWs({ bufferedAmount: 1_000_000 })
    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000, () => true)
    expect(result).toBe(false)
  })

  it('resolves false when shouldCancel becomes true during polling', async () => {
    const ws = createMockWs({ bufferedAmount: 1_000_000 })
    let cancelled = false

    // Cancel after 100ms (before the 5s timeout)
    setTimeout(() => { cancelled = true }, 100)

    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000, () => cancelled)
    expect(result).toBe(false)
  })
})

describe('TerminalStreamBroker catastrophic bufferedAmount handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('does not close the socket for short-lived catastrophic bufferedAmount spikes', async () => {
    const registry = new FakeBrokerRegistry()
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-spike')

    const ws = createMockWs({
      bufferedAmount: 17 * 1024 * 1024, // Above catastrophic threshold
    })
    const closeSpy = vi.spyOn(ws, 'close')

    const attached = await broker.attach(ws as any, 'term-spike', 'viewport_hydrate', 80, 24, 0)
    expect(attached).toBe('attached')

    registry.emit('terminal.output.raw', { terminalId: 'term-spike', data: 'first', at: Date.now() })

    // Stay above threshold for less than the sustained stall window.
    vi.advanceTimersByTime(9_000)
    expect(closeSpy).not.toHaveBeenCalled()

    // Recover below threshold and allow queued frame to flush.
    ws.bufferedAmount = 0
    vi.advanceTimersByTime(100)
    expect(ws.send.mock.calls.some(([raw]) =>
      typeof raw === 'string' && raw.includes('"type":"terminal.output"')
    )).toBe(true)
    expect(perfSpy).not.toHaveBeenCalledWith('terminal_stream_catastrophic_close', expect.any(Object), expect.anything())

    broker.close()
  })

  it('closes the socket with 4008 after sustained catastrophic bufferedAmount', async () => {
    const registry = new FakeBrokerRegistry()
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-stalled')

    const ws = createMockWs({
      bufferedAmount: 17 * 1024 * 1024, // Above catastrophic threshold
    })
    const closeSpy = vi.spyOn(ws, 'close')

    const attached = await broker.attach(ws as any, 'term-stalled', 'viewport_hydrate', 80, 24, 0)
    expect(attached).toBe('attached')

    registry.emit('terminal.output.raw', { terminalId: 'term-stalled', data: 'blocked', at: Date.now() })

    // Exceed the sustained stall threshold (10s default) so broker must hard-close.
    vi.advanceTimersByTime(11_000)

    expect(closeSpy).toHaveBeenCalledWith(4008, 'Catastrophic backpressure')
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(perfSpy).toHaveBeenCalledWith(
      'terminal_stream_catastrophic_close',
      expect.objectContaining({ terminalId: 'term-stalled' }),
      'warn',
    )

    broker.close()
  })

  it('emits terminal_stream_replay_miss and terminal_stream_gap events when replay window is exceeded', async () => {
    const originalRingMax = process.env.TERMINAL_REPLAY_RING_MAX_BYTES
    process.env.TERMINAL_REPLAY_RING_MAX_BYTES = '8'
    try {
      const registry = new FakeBrokerRegistry()
      const perfSpy = vi.fn()
      const broker = new TerminalStreamBroker(registry as any, perfSpy)
      registry.createTerminal('term-replay')

      const wsSeed = createMockWs()
      await broker.attach(wsSeed as any, 'term-replay', 'viewport_hydrate', 80, 24, 0)

      registry.emit('terminal.output.raw', { terminalId: 'term-replay', data: 'aaaa', at: Date.now() })
      registry.emit('terminal.output.raw', { terminalId: 'term-replay', data: 'bbbb', at: Date.now() })
      registry.emit('terminal.output.raw', { terminalId: 'term-replay', data: 'cccc', at: Date.now() })

      const wsReplay = createMockWs()
      await broker.attach(wsReplay as any, 'term-replay', 'viewport_hydrate', 80, 24, 0)

      expect(perfSpy.mock.calls.some(([event, payload, level]) =>
        event === 'terminal_stream_replay_miss' &&
        payload?.terminalId === 'term-replay' &&
        level === 'warn',
      )).toBe(true)
      expect(perfSpy.mock.calls.some(([event, payload, level]) =>
        event === 'terminal_stream_gap' &&
        payload?.terminalId === 'term-replay' &&
        payload?.reason === 'replay_window_exceeded' &&
        level === 'warn',
      )).toBe(true)

      broker.close()
    } finally {
      if (originalRingMax === undefined) delete process.env.TERMINAL_REPLAY_RING_MAX_BYTES
      else process.env.TERMINAL_REPLAY_RING_MAX_BYTES = originalRingMax
    }
  })

  it('emits aggregate terminal.replay.progress logs for replay sends', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-structured-batch')

    for (let i = 1; i <= 8; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-structured-batch',
        data: `batch-${i};`,
        at: Date.now(),
      })
    }

    const wsReplay = createMockWs({ bufferedAmount: 0 })
    await broker.attach(
      wsReplay as any,
      'term-structured-batch',
      'transport_reconnect',
      80,
      24,
      0,
      'structured-batch-attach',
      undefined,
      'foreground',
      true,
    )
    vi.advanceTimersByTime(5)

    expect(structuredLogs('debug', 'terminal.replay.progress')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'terminal.replay.progress',
          severity: 'debug',
          reason: 'completed',
          terminalId: 'term-structured-batch',
          attachRequestId: 'structured-batch-attach',
          source: 'replay',
          streamId: expect.any(String),
          seqStart: 1,
          seqEnd: 8,
          batchCount: 1,
          rawFrameCount: 8,
          dataBytes: expect.any(Number),
          serializedBytes: expect.any(Number),
          maxBufferedAmount: expect.any(Number),
          seqLag: 0,
          clientCount: 1,
          durationMs: expect.any(Number),
        }),
      ]),
    )
    expect(structuredLogs('debug', 'terminal.replay.batch')).toHaveLength(0)

    broker.close()
  })

  it('does not emit terminal.replay.progress logs for live output batches', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-live-batch-observability')

    const ws = createMockWs()
    await broker.attach(
      ws as any,
      'term-live-batch-observability',
      'viewport_hydrate',
      80,
      24,
      0,
      'live-batch-attach',
      undefined,
      'foreground',
      true,
    )
    ws.send.mockClear()
    loggerMocks.logger.debug.mockClear()

    registry.emit('terminal.output.raw', {
      terminalId: 'term-live-batch-observability',
      data: 'live batch payload',
      at: Date.now(),
    })
    vi.advanceTimersByTime(5)

    const liveBatches = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload) => payload?.type === 'terminal.output.batch')
    expect(liveBatches).toEqual([
      expect.objectContaining({
        terminalId: 'term-live-batch-observability',
        attachRequestId: 'live-batch-attach',
        source: 'live',
      }),
    ])
    expect(structuredLogs('debug', 'terminal.replay.progress')
      .filter((payload) => payload.terminalId === 'term-live-batch-observability')).toHaveLength(0)
    expect(structuredLogs('debug', 'terminal.replay.batch')
      .filter((payload) => payload.terminalId === 'term-live-batch-observability')).toHaveLength(0)

    broker.close()
  })

  it('retains unsent live output after a partial legacy batch send failure', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-live-partial-send')

    const ws = createMockWs()
    await broker.attach(
      ws as any,
      'term-live-partial-send',
      'viewport_hydrate',
      80,
      24,
      0,
      'live-partial-send-attach',
    )

    ws.send.mockClear()
    const acceptedOutputPayloads: Array<Record<string, unknown>> = []
    let outputSendAttempts = 0
    ws.send.mockImplementation((raw: string, cb?: (err?: Error) => void) => {
      const payload = JSON.parse(raw)
      if (payload?.type === 'terminal.output') {
        outputSendAttempts += 1
        if (outputSendAttempts === 2) {
          throw new Error('simulated partial send failure')
        }
        acceptedOutputPayloads.push(payload)
      }
      cb?.()
    })

    registry.emit('terminal.output.raw', { terminalId: 'term-live-partial-send', data: 'one', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-live-partial-send', data: 'two', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-live-partial-send', data: 'three', at: Date.now() })

    vi.advanceTimersByTime(1)

    expect(outputSendAttempts).toBe(2)
    expect(acceptedOutputPayloads.map((payload) => payload.data)).toEqual(['one'])
    expect(ws.close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(50)

    expect(acceptedOutputPayloads.map((payload) => payload.data)).toEqual(['one', 'two', 'three'])
    expect(acceptedOutputPayloads.every((payload) => payload.source === 'live')).toBe(true)
    expect(ws.close).not.toHaveBeenCalled()

    broker.close()
  })

  it('emits structured terminal.replay.gap logs for replay gaps', async () => {
    const originalRingMax = process.env.TERMINAL_REPLAY_RING_MAX_BYTES
    process.env.TERMINAL_REPLAY_RING_MAX_BYTES = '8'
    try {
      const registry = new FakeBrokerRegistry()
      const broker = new TerminalStreamBroker(registry as any, vi.fn())
      registry.createTerminal('term-structured-gap')

      const wsSeed = createMockWs()
      await broker.attach(wsSeed as any, 'term-structured-gap', 'viewport_hydrate', 80, 24, 0)

      registry.emit('terminal.output.raw', { terminalId: 'term-structured-gap', data: 'aaaa', at: Date.now() })
      registry.emit('terminal.output.raw', { terminalId: 'term-structured-gap', data: 'bbbb', at: Date.now() })
      registry.emit('terminal.output.raw', { terminalId: 'term-structured-gap', data: 'cccc', at: Date.now() })

      const wsReplay = createMockWs()
      await broker.attach(
        wsReplay as any,
        'term-structured-gap',
        'viewport_hydrate',
        80,
        24,
        0,
        'structured-gap-attach',
      )

      expect(structuredLogs('warn', 'terminal.replay.gap')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'terminal.replay.gap',
            severity: 'warn',
            terminalId: 'term-structured-gap',
            attachRequestId: 'structured-gap-attach',
            streamId: expect.any(String),
            source: 'replay',
            fromSeq: 1,
            toSeq: 1,
            reason: 'replay_window_exceeded',
          }),
        ]),
      )

      broker.close()
    } finally {
      if (originalRingMax === undefined) delete process.env.TERMINAL_REPLAY_RING_MAX_BYTES
      else process.env.TERMINAL_REPLAY_RING_MAX_BYTES = originalRingMax
    }
  })

  it('emits structured terminal.replay.backpressure_state logs for replay pacing', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(4 * 1024 * 1024)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-structured-backpressure')

    for (let i = 1; i <= 10; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-structured-backpressure',
        data: `paused-${i};${'x'.repeat(2 * 1024)}`,
        at: Date.now(),
      })
    }

    const wsReplay = createMockWs({ bufferedAmount: 768 * 1024 })
    await broker.attach(
      wsReplay as any,
      'term-structured-backpressure',
      'transport_reconnect',
      80,
      24,
      0,
      'structured-backpressure-attach',
      undefined,
      'foreground',
    )
    vi.advanceTimersByTime(50)

    const pauseLog = structuredLogs('debug', 'terminal.replay.backpressure_state')
      .find((payload) => payload.terminalId === 'term-structured-backpressure')
    expect(pauseLog).toEqual(expect.objectContaining({
      event: 'terminal.replay.backpressure_state',
      severity: 'debug',
      state: 'entered',
      terminalId: 'term-structured-backpressure',
      attachRequestId: 'structured-backpressure-attach',
      source: 'replay',
      seqStart: 1,
      seqEnd: 1,
      rawFrameCount: 1,
      dataBytes: expect.any(Number),
      bufferedAmount: expect.any(Number),
      threshold: expect.any(Number),
      retryMs: expect.any(Number),
      reason: 'websocket_buffered_amount',
    }))
    expect(pauseLog?.dataBytes).toBeGreaterThan(0)
    expect(structuredLogs('debug', 'terminal.replay.backpressure_pause')
      .filter((payload) => payload.terminalId === 'term-structured-backpressure')).toHaveLength(0)
    expect(structuredLogs('debug', 'terminal_stream_replay_backpressure_pause')
      .filter((payload) => payload.terminalId === 'term-structured-backpressure')).toHaveLength(0)

    broker.close()
  })

  it('emits structured terminal.replay.retention logs when retention loss rotates stream identity', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(6)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-structured-retention')

    const ws = createMockWs()
    await broker.attach(ws as any, 'term-structured-retention', 'viewport_hydrate', 80, 24, 0, 'structured-retention-attach')
    const ready = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(ready?.streamId).toEqual(expect.any(String))

    registry.emit('terminal.output.raw', { terminalId: 'term-structured-retention', data: 'aaa', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-structured-retention', data: 'bbb', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-structured-retention', data: 'ccc', at: Date.now() })

    const retentionLogs = structuredLogs('warn', 'terminal.replay.retention')
      .filter((payload) => payload.terminalId === 'term-structured-retention')
    expect(retentionLogs).toHaveLength(1)
    expect(retentionLogs[0]).toEqual(expect.objectContaining({
      event: 'terminal.replay.retention',
      severity: 'warn',
      terminalId: 'term-structured-retention',
      attachRequestIds: ['structured-retention-attach'],
      attachmentCount: 1,
      previousStreamId: ready.streamId,
      streamId: expect.any(String),
      reason: 'retention_lost',
      retainedBytes: expect.any(Number),
      maxBytes: 6,
      tailSeq: expect.any(Number),
      headSeq: expect.any(Number),
    }))
    expect(retentionLogs[0]?.attachRequestId).toBeUndefined()

    broker.close()
  })

  it('emits one aggregate terminal.replay.retention log for multiple attached clients', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(6)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-retention-multi-client')

    const wsA = createMockWs()
    const wsB = createMockWs()
    await broker.attach(wsA as any, 'term-retention-multi-client', 'viewport_hydrate', 80, 24, 0, 'retention-attach-a')
    await broker.attach(wsB as any, 'term-retention-multi-client', 'viewport_hydrate', 80, 24, 0, 'retention-attach-b')

    registry.emit('terminal.output.raw', { terminalId: 'term-retention-multi-client', data: 'aaa', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-retention-multi-client', data: 'bbb', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-retention-multi-client', data: 'ccc', at: Date.now() })

    const retentionLogs = structuredLogs('warn', 'terminal.replay.retention')
      .filter((payload) => payload.terminalId === 'term-retention-multi-client')
    expect(retentionLogs).toHaveLength(1)
    expect(retentionLogs[0]).toEqual(expect.objectContaining({
      event: 'terminal.replay.retention',
      severity: 'warn',
      terminalId: 'term-retention-multi-client',
      attachRequestIds: expect.arrayContaining(['retention-attach-a', 'retention-attach-b']),
      attachmentCount: 2,
      reason: 'retention_lost',
      retainedBytes: expect.any(Number),
      maxBytes: 6,
      tailSeq: expect.any(Number),
      headSeq: expect.any(Number),
    }))
    expect(retentionLogs[0]?.attachRequestIds).toHaveLength(2)
    expect(retentionLogs[0]?.attachRequestId).toBeUndefined()

    broker.close()
  })

  it('rate limits structured terminal.replay.retention logs and reports suppressed losses', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(6)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-retention-rate-limit')

    const ws = createMockWs()
    await broker.attach(ws as any, 'term-retention-rate-limit', 'viewport_hydrate', 80, 24, 0, 'retention-rate-attach')

    registry.emit('terminal.output.raw', { terminalId: 'term-retention-rate-limit', data: 'aaa', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-retention-rate-limit', data: 'bbb', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-retention-rate-limit', data: 'ccc', at: Date.now() })

    let retentionLogs = structuredLogs('warn', 'terminal.replay.retention')
      .filter((payload) => payload.terminalId === 'term-retention-rate-limit')
    expect(retentionLogs).toHaveLength(1)
    expect(retentionLogs[0]).toEqual(expect.objectContaining({
      event: 'terminal.replay.retention',
      severity: 'warn',
      terminalId: 'term-retention-rate-limit',
      attachRequestIds: ['retention-rate-attach'],
      attachmentCount: 1,
      reason: 'retention_lost',
    }))
    expect(retentionLogs[0]?.attachRequestId).toBeUndefined()
    expect(retentionLogs[0]?.suppressedCount).toBeUndefined()

    registry.emit('terminal.output.raw', { terminalId: 'term-retention-rate-limit', data: 'ddd', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-retention-rate-limit', data: 'eee', at: Date.now() })

    retentionLogs = structuredLogs('warn', 'terminal.replay.retention')
      .filter((payload) => payload.terminalId === 'term-retention-rate-limit')
    expect(retentionLogs).toHaveLength(1)

    vi.advanceTimersByTime(1000)
    registry.emit('terminal.output.raw', { terminalId: 'term-retention-rate-limit', data: 'fff', at: Date.now() })

    retentionLogs = structuredLogs('warn', 'terminal.replay.retention')
      .filter((payload) => payload.terminalId === 'term-retention-rate-limit')
    expect(retentionLogs).toHaveLength(2)
    expect(retentionLogs[1]).toEqual(expect.objectContaining({
      event: 'terminal.replay.retention',
      severity: 'warn',
      terminalId: 'term-retention-rate-limit',
      attachRequestIds: ['retention-rate-attach'],
      attachmentCount: 1,
      reason: 'retention_lost',
      suppressedCount: 2,
    }))
    expect(retentionLogs[1]?.attachRequestId).toBeUndefined()

    broker.close()
  })

  it('echoes attachRequestId on attach.ready, output, and output.gap for a client attachment', async () => {
    forceSmallTerminalClientQueueForOverflowTest()
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-attach-id')

    const ws = createMockWs()
    const attached = await broker.attach(ws as any, 'term-attach-id', 'viewport_hydrate', 80, 24, 0, 'attach-1')
    expect(attached).toBe('attached')

    registry.emit('terminal.output.raw', { terminalId: 'term-attach-id', data: 'seed', at: Date.now() })
    for (let i = 0; i < 240; i += 1) {
      registry.emit('terminal.output.raw', { terminalId: 'term-attach-id', data: 'x'.repeat(1024), at: Date.now() })
    }
    vi.advanceTimersByTime(5)

    const payloads = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')

    expect(payloads.some((m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'attach-1')).toBe(true)
    expect(payloads.some((m) => m.type === 'terminal.output' && m.attachRequestId === 'attach-1')).toBe(true)
    expect(payloads.some((m) => m.type === 'terminal.output.gap' && m.attachRequestId === 'attach-1')).toBe(true)

    broker.close()
  })

  it('does not resize during transport_reconnect when another viewer is already attached', async () => {
    const registry = new FakeBrokerRegistry()
    const resizeSpy = vi.spyOn(registry, 'resize')
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-passive-reconnect')

    const primaryWs = createMockWs()
    const reconnectingWs = createMockWs()

    await broker.attach(primaryWs as any, 'term-passive-reconnect', 'viewport_hydrate', 120, 40, 0, 'attach-primary')
    resizeSpy.mockClear()

    const attached = await broker.attach(
      reconnectingWs as any,
      'term-passive-reconnect',
      'transport_reconnect',
      80,
      24,
      0,
      'attach-reconnect',
    )

    expect(attached).toBe('attached')
    expect(resizeSpy).not.toHaveBeenCalled()

    const payloads = reconnectingWs.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')

    expect(payloads.some((m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'attach-reconnect')).toBe(true)

    broker.close()
  })

  it('reports unknown geometry authority and ignores warm delta when another client is attached', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-geometry-authority')

    const wsA = createMockWs()
    await broker.attach(wsA as any, 'term-geometry-authority', 'viewport_hydrate', 80, 24, 0, 'geometry-a-1')
    registry.emit('terminal.output.raw', {
      terminalId: 'term-geometry-authority',
      data: 'geometry-seed',
      at: Date.now(),
    })
    vi.advanceTimersByTime(1)

    const wsB = createMockWs()
    await broker.attach(wsB as any, 'term-geometry-authority', 'viewport_hydrate', 100, 30, 0, 'geometry-b-1')
    const readyB = wsB.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(readyB).toMatchObject({
      terminalId: 'term-geometry-authority',
      attachRequestId: 'geometry-b-1',
      geometryAuthority: 'multi_client_unknown',
      geometryEpoch: expect.any(Number),
    })

    wsA.send.mockClear()
    await broker.attach(wsA as any, 'term-geometry-authority', 'transport_reconnect', 80, 24, 1, 'geometry-a-2')
    const readyA2 = wsA.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')

    expect(readyA2).toMatchObject({
      terminalId: 'term-geometry-authority',
      attachRequestId: 'geometry-a-2',
      geometryAuthority: 'multi_client_unknown',
      geometryEpoch: expect.any(Number),
      requestedSinceSeq: 1,
      effectiveSinceSeq: 0,
      replayResetReason: 'geometry_authority_unknown',
      replayFromSeq: 1,
      replayToSeq: 1,
    })
    expect(readyA2.geometryEpoch).toBeGreaterThan(readyB.geometryEpoch)

    broker.close()
  })

  it('keeps each live terminal.output frame within the shared realtime byte budget', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-budget')

    const ws = createMockWs()
    const attached = await broker.attach(ws as any, 'term-budget', 'viewport_hydrate', 80, 24, 0, 'attach-budget')
    expect(attached).toBe('attached')

    for (let i = 0; i < 40; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-budget',
        data: 'x'.repeat(1024),
        at: Date.now(),
      })
    }
    vi.advanceTimersByTime(10)

    const payloads = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload): payload is Record<string, any> => !!payload && payload.type === 'terminal.output')

    expect(payloads.length).toBeGreaterThan(0)
    expect(payloads.every((payload) => Buffer.byteLength(payload.data ?? '', 'utf8') <= MAX_REALTIME_MESSAGE_BYTES)).toBe(true)

    broker.close()
  })

  it('keeps actual live and replay terminal.output JSON payloads within the serialized budget', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-serialized-budget')

    const wsLive = createMockWs()
    await broker.attach(
      wsLive as any,
      'term-serialized-budget',
      'viewport_hydrate',
      80,
      24,
      0,
      TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE,
    )

    registry.emit('terminal.output.raw', {
      terminalId: 'term-serialized-budget',
      data: '\u001b'.repeat(20 * 1024),
      at: Date.now(),
    })
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(1)
    }

    const liveOutputFrames = wsLive.send.mock.calls
      .map(([raw]) => raw)
      .filter((raw): raw is string => {
        if (typeof raw !== 'string') return false
        const payload = JSON.parse(raw)
        return payload?.type === 'terminal.output'
      })
    expect(liveOutputFrames.length).toBeGreaterThan(1)

    for (const raw of liveOutputFrames) {
      const payload = JSON.parse(raw)
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_REALTIME_MESSAGE_BYTES)
      expect(payload).toEqual(expect.objectContaining({
        type: 'terminal.output',
        terminalId: 'term-serialized-budget',
        attachRequestId: TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE,
        streamId: expect.any(String),
        seqStart: expect.any(Number),
        seqEnd: expect.any(Number),
      }))
    }

    const wsReplay = createMockWs()
    await broker.attach(
      wsReplay as any,
      'term-serialized-budget',
      'transport_reconnect',
      80,
      24,
      0,
      TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE,
    )
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(1)
    }

    const replayOutputFrames = wsReplay.send.mock.calls
      .map(([raw]) => raw)
      .filter((raw): raw is string => {
        if (typeof raw !== 'string') return false
        const payload = JSON.parse(raw)
        return payload?.type === 'terminal.output'
      })
    expect(replayOutputFrames.length).toBeGreaterThan(1)

    for (const raw of replayOutputFrames) {
      const payload = JSON.parse(raw)
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_REALTIME_MESSAGE_BYTES)
      expect(payload).toEqual(expect.objectContaining({
        type: 'terminal.output',
        terminalId: 'term-serialized-budget',
        attachRequestId: TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE,
        streamId: expect.any(String),
        seqStart: expect.any(Number),
        seqEnd: expect.any(Number),
      }))
    }

    broker.close()
  })

  it('uses serialized terminal.output JSON bytes for maxReplayBytes truncation', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-replay-serialized-truncation')

    const wsSeed = createMockWs()
    await broker.attach(
      wsSeed as any,
      'term-replay-serialized-truncation',
      'viewport_hydrate',
      80,
      24,
      0,
      'seed-serialized-truncation',
    )
    const seedReady = wsSeed.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(seedReady?.streamId).toEqual(expect.any(String))

    const replayAttachRequestId = TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE
    const chunks = [
      `A${'\u001b'.repeat(100)}`,
      `B${'\u001b'.repeat(100)}`,
      `C${'\u001b'.repeat(100)}`,
    ]
    for (const chunk of chunks) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-replay-serialized-truncation',
        data: chunk,
        at: Date.now(),
      })
    }

    const oneSerializedPayloadBudget = measureTerminalOutputPayloadBytes({
      type: 'terminal.output',
      terminalId: 'term-replay-serialized-truncation',
      streamId: seedReady.streamId,
      seqStart: 3,
      seqEnd: 3,
      data: chunks[2],
      attachRequestId: replayAttachRequestId,
      source: 'replay',
    })
    expect(chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk, 'utf8'), 0))
      .toBeLessThan(oneSerializedPayloadBudget)

    const wsReplay = createMockWs()
    await broker.attach(
      wsReplay as any,
      'term-replay-serialized-truncation',
      'viewport_hydrate',
      80,
      24,
      0,
      replayAttachRequestId,
      oneSerializedPayloadBudget,
    )
    vi.advanceTimersByTime(1)

    const replayMessages = wsReplay.send.mock.calls
      .map(([raw]) => ({
        raw,
        payload: typeof raw === 'string' ? JSON.parse(raw) : raw,
      }))

    const gap = replayMessages.find(({ payload }) => payload?.type === 'terminal.output.gap')?.payload
    expect(gap).toMatchObject({
      fromSeq: 1,
      toSeq: 2,
      reason: 'replay_budget_exceeded',
      attachRequestId: replayAttachRequestId,
      streamId: seedReady.streamId,
    })

    const outputFrames = replayMessages
      .filter(({ payload }) => payload?.type === 'terminal.output')
    expect(outputFrames.map(({ payload }) => payload.data)).toEqual([chunks[2]])
    expect(outputFrames[0]?.payload).toMatchObject({
      seqStart: 3,
      seqEnd: 3,
      attachRequestId: replayAttachRequestId,
      streamId: seedReady.streamId,
      source: 'replay',
    })
    expect(Buffer.byteLength(String(outputFrames[0]?.raw ?? ''), 'utf8'))
      .toBeLessThanOrEqual(oneSerializedPayloadBudget)

    broker.close()
  })

  it('emits separate queue overflow gaps for different stream ids', async () => {
    const originalClientQueueMaxBytes = process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES
    process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES = '2048'

    try {
      const registry = new FakeBrokerRegistry()
      const broker = new TerminalStreamBroker(registry as any, vi.fn())
      registry.createTerminal('term-gap-stream')

      const ws = createMockWs()
      await broker.attach(ws as any, 'term-gap-stream', 'viewport_hydrate', 80, 24, 0, 'gap-attach')
      const attachReady = ws.send.mock.calls
        .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
        .find((payload) => payload?.type === 'terminal.attach.ready')
      expect(attachReady?.streamId).toEqual(expect.any(String))

      for (let i = 0; i < 3; i += 1) {
        registry.emit('terminal.output.raw', {
          terminalId: 'term-gap-stream',
          data: `old-${i}-${'o'.repeat(900)}`,
          at: Date.now(),
        })
      }
      registry.emit('terminal.stream.replaced', {
        terminalId: 'term-gap-stream',
        reason: 'codex_pty_recovery',
      })
      for (let i = 0; i < 3; i += 1) {
        registry.emit('terminal.output.raw', {
          terminalId: 'term-gap-stream',
          data: `new-${i}-${'n'.repeat(900)}`,
          at: Date.now(),
        })
      }
      vi.advanceTimersByTime(5)

      const gaps = ws.send.mock.calls
        .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
        .filter((payload) => payload?.type === 'terminal.output.gap')

      expect(gaps.length).toBeGreaterThanOrEqual(2)
      expect(gaps[0]).toEqual(expect.objectContaining({
        streamId: attachReady.streamId,
        reason: 'queue_overflow',
      }))
      expect(new Set(gaps.map((gap) => gap.streamId)).size).toBeGreaterThanOrEqual(2)

      broker.close()
    } finally {
      if (originalClientQueueMaxBytes === undefined) {
        delete process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES
      } else {
        process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES = originalClientQueueMaxBytes
      }
    }
  })

  it('notifies active clients before live output switches to a replacement stream id', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-live-stream-change')

    const ws = createMockWs()
    await broker.attach(ws as any, 'term-live-stream-change', 'viewport_hydrate', 80, 24, 0, 'live-change-attach')
    const ready = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(ready?.streamId).toEqual(expect.any(String))

    registry.emit('terminal.output.raw', { terminalId: 'term-live-stream-change', data: 'before-change', at: Date.now() })
    vi.advanceTimersByTime(1)

    registry.emit('terminal.stream.replaced', {
      terminalId: 'term-live-stream-change',
      reason: 'codex_pty_recovery',
    })
    registry.emit('terminal.output.raw', { terminalId: 'term-live-stream-change', data: 'after-change', at: Date.now() })
    vi.advanceTimersByTime(1)

    const payloads = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    const streamChangedIndex = payloads.findIndex((payload) => payload?.type === 'terminal.stream.changed')
    const afterOutputIndex = payloads.findIndex((payload) =>
      payload?.type === 'terminal.output' && payload.data === 'after-change'
    )
    const streamChanged = payloads[streamChangedIndex]
    const afterOutput = payloads[afterOutputIndex]

    expect(streamChanged).toMatchObject({
      terminalId: 'term-live-stream-change',
      reason: 'codex_pty_recovery',
      attachRequestId: 'live-change-attach',
      streamId: expect.any(String),
    })
    expect(streamChanged.streamId).not.toBe(ready.streamId)
    expect(afterOutput).toMatchObject({
      terminalId: 'term-live-stream-change',
      data: 'after-change',
      streamId: streamChanged.streamId,
      attachRequestId: 'live-change-attach',
    })
    expect(streamChangedIndex).toBeGreaterThan(-1)
    expect(afterOutputIndex).toBeGreaterThan(streamChangedIndex)

    broker.close()
  })

  it('converts a stale replay cursor to a current-stream gap before replacement live output', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-replay-stream-change')

    const seedWs = createMockWs()
    await broker.attach(seedWs as any, 'term-replay-stream-change', 'viewport_hydrate', 80, 24, 0, 'seed-attach')
    const initialReady = seedWs.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(initialReady?.streamId).toEqual(expect.any(String))

    registry.emit('terminal.output.raw', { terminalId: 'term-replay-stream-change', data: 'old-a', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-replay-stream-change', data: 'old-b', at: Date.now() })

    const replayWs = createMockWs()
    await broker.attach(
      replayWs as any,
      'term-replay-stream-change',
      'transport_reconnect',
      80,
      24,
      0,
      'replay-attach',
    )

    registry.emit('terminal.stream.replaced', {
      terminalId: 'term-replay-stream-change',
      reason: 'codex_pty_recovery',
    })
    registry.emit('terminal.output.raw', { terminalId: 'term-replay-stream-change', data: 'new-live', at: Date.now() })
    vi.advanceTimersByTime(1)

    const payloads = replayWs.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    const ready = payloads.find((payload) => payload?.type === 'terminal.attach.ready')
    const streamChangedIndex = payloads.findIndex((payload) => payload?.type === 'terminal.stream.changed')
    const gapIndex = payloads.findIndex((payload) => payload?.type === 'terminal.output.gap')
    const newOutputIndex = payloads.findIndex((payload) =>
      payload?.type === 'terminal.output' && payload.data === 'new-live'
    )
    const replayOutputs = payloads
      .filter((payload) => payload?.type === 'terminal.output')
      .map((payload) => payload.data)

    expect(ready).toMatchObject({
      terminalId: 'term-replay-stream-change',
      streamId: initialReady.streamId,
      replayFromSeq: 1,
      replayToSeq: 2,
      attachRequestId: 'replay-attach',
    })
    expect(payloads[streamChangedIndex]).toMatchObject({
      terminalId: 'term-replay-stream-change',
      reason: 'codex_pty_recovery',
      attachRequestId: 'replay-attach',
      streamId: expect.any(String),
    })
    expect(payloads[streamChangedIndex].streamId).not.toBe(initialReady.streamId)
    expect(payloads[gapIndex]).toMatchObject({
      terminalId: 'term-replay-stream-change',
      streamId: payloads[streamChangedIndex].streamId,
      fromSeq: 1,
      toSeq: 2,
      reason: 'replay_window_exceeded',
      attachRequestId: 'replay-attach',
    })
    expect(payloads[newOutputIndex]).toMatchObject({
      terminalId: 'term-replay-stream-change',
      streamId: payloads[streamChangedIndex].streamId,
      seqStart: 3,
      seqEnd: 3,
      data: 'new-live',
      attachRequestId: 'replay-attach',
    })
    expect(streamChangedIndex).toBeGreaterThan(-1)
    expect(gapIndex).toBeGreaterThan(streamChangedIndex)
    expect(newOutputIndex).toBeGreaterThan(gapIndex)
    expect(replayOutputs).toEqual(['new-live'])

    broker.close()
  })

  it('notifies active clients when retention loss rotates live stream identity', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(6)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-live-retention-change')

    const ws = createMockWs()
    await broker.attach(ws as any, 'term-live-retention-change', 'viewport_hydrate', 80, 24, 0, 'live-retention-attach')
    const ready = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(ready?.streamId).toEqual(expect.any(String))

    registry.emit('terminal.output.raw', { terminalId: 'term-live-retention-change', data: 'aaa', at: Date.now() })
    vi.advanceTimersByTime(1)
    registry.emit('terminal.output.raw', { terminalId: 'term-live-retention-change', data: 'bbb', at: Date.now() })
    vi.advanceTimersByTime(1)
    registry.emit('terminal.output.raw', { terminalId: 'term-live-retention-change', data: 'ccc', at: Date.now() })
    vi.advanceTimersByTime(1)

    const payloads = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    const streamChangedIndex = payloads.findIndex((payload) =>
      payload?.type === 'terminal.stream.changed' && payload.reason === 'retention_lost'
    )
    const cccOutputIndex = payloads.findIndex((payload) =>
      payload?.type === 'terminal.output' && payload.data === 'ccc'
    )
    const streamChanged = payloads[streamChangedIndex]
    const cccOutput = payloads[cccOutputIndex]

    expect(streamChanged).toMatchObject({
      terminalId: 'term-live-retention-change',
      reason: 'retention_lost',
      attachRequestId: 'live-retention-attach',
      streamId: expect.any(String),
    })
    expect(streamChanged.streamId).not.toBe(ready.streamId)
    expect(cccOutput).toMatchObject({
      terminalId: 'term-live-retention-change',
      data: 'ccc',
      streamId: streamChanged.streamId,
      attachRequestId: 'live-retention-attach',
    })
    expect(cccOutputIndex).toBeGreaterThan(streamChangedIndex)

    broker.close()
  })

  it('retags queued live output when retention loss rotates stream identity before flush', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(6)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-live-retention-queued')

    const ws = createMockWs()
    await broker.attach(ws as any, 'term-live-retention-queued', 'viewport_hydrate', 80, 24, 0, 'live-retention-queued-attach')
    const ready = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(ready?.streamId).toEqual(expect.any(String))
    ws.send.mockClear()

    registry.emit('terminal.output.raw', { terminalId: 'term-live-retention-queued', data: 'aaa', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-live-retention-queued', data: 'bbb', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-live-retention-queued', data: 'ccc', at: Date.now() })
    vi.advanceTimersByTime(1)

    const payloads = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    const streamChangedIndex = payloads.findIndex((payload) =>
      payload?.type === 'terminal.stream.changed' && payload.reason === 'retention_lost'
    )
    const streamChanged = payloads[streamChangedIndex]
    const outputs = payloads.filter((payload) => payload?.type === 'terminal.output')

    expect(streamChanged).toMatchObject({
      terminalId: 'term-live-retention-queued',
      reason: 'retention_lost',
      attachRequestId: 'live-retention-queued-attach',
      streamId: expect.any(String),
    })
    expect(streamChanged.streamId).not.toBe(ready.streamId)
    expect(outputs.map((payload) => payload.data)).toEqual(['aaa', 'bbb', 'ccc'])
    expect(outputs.every((payload) => payload.streamId === streamChanged.streamId)).toBe(true)
    expect(outputs.every((payload) => payload.streamId !== ready.streamId)).toBe(true)
    for (const output of outputs) {
      expect(payloads.indexOf(output)).toBeGreaterThan(streamChangedIndex)
      expect(output.attachRequestId).toBe('live-retention-queued-attach')
    }

    broker.close()
  })

  it('retags returned live fragments when retention loss rotates stream identity before enqueue', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(64 * 1024)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-live-retention-fragments')

    const ws = createMockWs()
    await broker.attach(ws as any, 'term-live-retention-fragments', 'viewport_hydrate', 80, 24, 0, 'live-retention-fragments-attach')
    const ready = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(ready?.streamId).toEqual(expect.any(String))
    ws.send.mockClear()

    registry.emit('terminal.output.raw', {
      terminalId: 'term-live-retention-fragments',
      data: 'x'.repeat(200 * 1024),
      at: Date.now(),
    })
    for (let i = 0; i < 100; i += 1) {
      vi.advanceTimersByTime(1)
    }

    const payloads = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    const streamChanges = payloads.filter((payload) =>
      payload?.type === 'terminal.stream.changed' && payload.reason === 'retention_lost'
    )
    const outputs = payloads.filter((payload) => payload?.type === 'terminal.output')
    const finalStreamId = streamChanges.at(-1)?.streamId

    expect(streamChanges.length).toBeGreaterThan(0)
    expect(finalStreamId).toEqual(expect.any(String))
    expect(finalStreamId).not.toBe(ready.streamId)
    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs.every((payload) => payload.streamId === finalStreamId)).toBe(true)
    expect(outputs.every((payload) => payload.streamId !== ready.streamId)).toBe(true)
    expect(outputs.map((payload) => payload.data).join('')).toHaveLength(200 * 1024)

    broker.close()
  })

  it('retags retained replay frames when retention loss rotates stream identity', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(6)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-retention-stream')

    const ws = createMockWs()
    await broker.attach(ws as any, 'term-retention-stream', 'viewport_hydrate', 80, 24, 0, 'retention-attach')
    const initialReady = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    const initialStreamId = initialReady?.streamId
    expect(initialStreamId).toEqual(expect.any(String))

    for (const data of ['aaa', 'bbb', 'ccc']) {
      registry.emit('terminal.output.raw', { terminalId: 'term-retention-stream', data, at: Date.now() })
      vi.advanceTimersByTime(1)
    }

    const wsAfterLoss = createMockWs()
    await broker.attach(
      wsAfterLoss as any,
      'term-retention-stream',
      'transport_reconnect',
      80,
      24,
      0,
      'after-retention-loss',
    )
    vi.advanceTimersByTime(1)

    const payloadsAfterLoss = wsAfterLoss.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    const readyAfterLoss = payloadsAfterLoss
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(readyAfterLoss?.streamId).toEqual(expect.any(String))
    expect(readyAfterLoss.streamId).not.toBe(initialStreamId)

    const gapAfterLoss = payloadsAfterLoss
      .find((payload) => payload?.type === 'terminal.output.gap')
    expect(gapAfterLoss).toMatchObject({
      streamId: readyAfterLoss.streamId,
      fromSeq: 1,
      toSeq: 1,
      reason: 'replay_window_exceeded',
    })

    const replayOutputsAfterLoss = payloadsAfterLoss
      .filter((payload) => payload?.type === 'terminal.output')
    expect(replayOutputsAfterLoss.map((payload) => String(payload.data)).join('')).toBe('bbbccc')
    expect(replayOutputsAfterLoss.every((payload) => payload.streamId === readyAfterLoss.streamId)).toBe(true)
    expect(replayOutputsAfterLoss.every((payload) => payload.streamId !== initialStreamId)).toBe(true)

    broker.close()
  })

  it('gaps old-stream retained replay and only sends output for the attach-ready stream', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(9)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-retained-boundary')

    const ws = createMockWs()
    await broker.attach(ws as any, 'term-retained-boundary', 'viewport_hydrate', 80, 24, 0, 'boundary-seed')
    const initialReady = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(initialReady?.streamId).toEqual(expect.any(String))

    registry.emit('terminal.output.raw', { terminalId: 'term-retained-boundary', data: 'aaa', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-retained-boundary', data: 'bbb', at: Date.now() })
    registry.emit('terminal.stream.replaced', {
      terminalId: 'term-retained-boundary',
      reason: 'codex_pty_recovery',
    })
    registry.emit('terminal.output.raw', { terminalId: 'term-retained-boundary', data: 'ccc', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-retained-boundary', data: 'ddd', at: Date.now() })

    const wsAfterLoss = createMockWs()
    await broker.attach(
      wsAfterLoss as any,
      'term-retained-boundary',
      'transport_reconnect',
      80,
      24,
      0,
      'boundary-after-loss',
    )
    vi.advanceTimersByTime(1)

    const payloadsAfterLoss = wsAfterLoss.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    const readyAfterLoss = payloadsAfterLoss
      .find((payload) => payload?.type === 'terminal.attach.ready')
    const replayOutputsAfterLoss = payloadsAfterLoss
      .filter((payload) => payload?.type === 'terminal.output')
    const replayGapsAfterLoss = payloadsAfterLoss
      .filter((payload) => payload?.type === 'terminal.output.gap')

    expect(readyAfterLoss?.streamId).toEqual(expect.any(String))
    expect(readyAfterLoss.streamId).not.toBe(initialReady.streamId)
    expect(replayGapsAfterLoss).toEqual([
      expect.objectContaining({
        streamId: readyAfterLoss.streamId,
        fromSeq: 1,
        toSeq: 2,
        reason: 'replay_window_exceeded',
      }),
    ])
    expect(replayOutputsAfterLoss.map((payload) => String(payload.data))).toEqual(['ccc', 'ddd'])
    expect(replayOutputsAfterLoss.every((payload) => payload.streamId === readyAfterLoss.streamId)).toBe(true)
    expect(replayOutputsAfterLoss.every((payload) => payload.streamId !== initialReady.streamId)).toBe(true)

    broker.close()
  })

  it('superseding attach on same socket clears stale queued frames and avoids duplicate old-frame delivery', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-supersede')

    const ws = createMockWs()
    await broker.attach(ws as any, 'term-supersede', 'viewport_hydrate', 80, 24, 0, 'attach-old')
    registry.emit('terminal.output.raw', { terminalId: 'term-supersede', data: 'old-frame', at: Date.now() })

    await broker.attach(ws as any, 'term-supersede', 'viewport_hydrate', 80, 24, 1, 'attach-new')
    registry.emit('terminal.output.raw', { terminalId: 'term-supersede', data: 'new-frame', at: Date.now() })
    vi.advanceTimersByTime(5)

    const outputs = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((m) => m?.type === 'terminal.output')

    expect(outputs.some((m) => String(m.data).includes('new-frame') && m.attachRequestId === 'attach-new')).toBe(true)
    expect(outputs.some((m) => String(m.data).includes('old-frame'))).toBe(false)

    broker.close()
  })

  it('streams attach replay through the flush queue instead of synchronously dumping every replay frame', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-replay-batched')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-replay-batched', 'viewport_hydrate', 80, 24, 0, 'seed-attach')

    for (let i = 1; i <= 20; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-replay-batched',
        data: `frame-${i};`,
        at: Date.now(),
      })
    }

    const wsReplay = createMockWs()
    await broker.attach(wsReplay as any, 'term-replay-batched', 'transport_reconnect', 80, 24, 0, 'replay-attach')

    const outputsBeforeFlush = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload) => payload?.type === 'terminal.output')
    expect(outputsBeforeFlush).toHaveLength(0)

    vi.advanceTimersByTime(5)

    const outputsAfterFlush = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload) => payload?.type === 'terminal.output')
    expect(outputsAfterFlush.length).toBeGreaterThan(0)
    expect(outputsAfterFlush.map((payload) => String(payload.data)).join('')).toContain('frame-20;')

    broker.close()
  })

  it('coalesces contiguous replay frames into terminal.output.batch for batch-capable clients', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-replay-coalesced')

    for (let i = 1; i <= 1000; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-replay-coalesced',
        data: `f${i};`,
        at: Date.now(),
      })
    }

    const wsReplay = createMockWs()
    await broker.attach(
      wsReplay as any,
      'term-replay-coalesced',
      'transport_reconnect',
      80,
      24,
      0,
      'replay-attach',
      undefined,
      'foreground',
      true,
    )
    vi.advanceTimersByTime(5)

    const outputs = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload) => payload?.type === 'terminal.output.batch')

    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs.length).toBeLessThan(1000)
    expect(outputs[0]).toMatchObject({
      type: 'terminal.output.batch',
      attachRequestId: 'replay-attach',
      source: 'replay',
      seqStart: 1,
      segments: expect.any(Array),
    })
    expect(outputs[outputs.length - 1]).toMatchObject({
      attachRequestId: 'replay-attach',
      source: 'replay',
      seqEnd: 1000,
    })
    expect(outputs.every((payload) => payload.serializedBytes <= MAX_REALTIME_MESSAGE_BYTES)).toBe(true)
    expect(outputs.reduce((sum, payload) => sum + payload.segments.length, 0)).toBe(1000)
    const joinedData = outputs.map((payload) => String(payload.data)).join('')
    expect(joinedData).toContain('f1;')
    expect(joinedData).toContain('f1000;')

    broker.close()
  })

  it('falls back to budget-safe terminal.output when one batch segment exceeds the batch envelope budget', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    const terminalId = 'term-single-batch-budget'
    const attachRequestId = TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE
    registry.createTerminal(terminalId)

    const ws = createMockWs()
    await broker.attach(
      ws as any,
      terminalId,
      'viewport_hydrate',
      80,
      24,
      0,
      attachRequestId,
      undefined,
      'foreground',
      true,
    )
    const ready = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .find((payload) => payload?.type === 'terminal.attach.ready')
    expect(ready?.streamId).toEqual(expect.any(String))
    const streamId = String(ready.streamId)

    const legacyBudgetBytes = (data: string) => measureTerminalOutputPayloadBytes({
      type: 'terminal.output',
      terminalId,
      streamId,
      seqStart: Number.MAX_SAFE_INTEGER,
      seqEnd: Number.MAX_SAFE_INTEGER,
      data,
      attachRequestId,
    })
    const batchBudgetBytes = (data: string) => {
      let serializedBytes = 0
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const measured = measureTerminalOutputPayloadBytes({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'live',
          seqStart: 1,
          seqEnd: 1,
          data,
          serializedBytes,
          segments: [{ seqStart: 1, seqEnd: 1, endOffset: data.length, rawFrameCount: 1 }],
        })
        if (measured === serializedBytes) return measured
        serializedBytes = measured
      }
      return measureTerminalOutputPayloadBytes({
        type: 'terminal.output.batch',
        terminalId,
        streamId,
        attachRequestId,
        source: 'live',
        seqStart: 1,
        seqEnd: 1,
        data,
        serializedBytes,
        segments: [{ seqStart: 1, seqEnd: 1, endOffset: data.length, rawFrameCount: 1 }],
      })
    }

    let data = ''
    for (let length = 1; length <= MAX_REALTIME_MESSAGE_BYTES; length += 1) {
      const candidate = 'x'.repeat(length)
      if (
        legacyBudgetBytes(candidate) <= MAX_REALTIME_MESSAGE_BYTES
        && batchBudgetBytes(candidate) > MAX_REALTIME_MESSAGE_BYTES
      ) {
        data = candidate
        break
      }
    }
    expect(data.length).toBeGreaterThan(0)
    expect(legacyBudgetBytes(data)).toBeLessThanOrEqual(MAX_REALTIME_MESSAGE_BYTES)
    expect(batchBudgetBytes(data)).toBeGreaterThan(MAX_REALTIME_MESSAGE_BYTES)

    ws.send.mockClear()
    registry.emit('terminal.output.raw', { terminalId, data, at: Date.now() })
    vi.advanceTimersByTime(5)

    const payloads = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    const batchOutputs = payloads.filter((payload) => payload?.type === 'terminal.output.batch')
    const outputFallbacks = payloads.filter((payload) => payload?.type === 'terminal.output')

    expect(batchOutputs.every((payload) => payload.serializedBytes <= MAX_REALTIME_MESSAGE_BYTES)).toBe(true)
    expect(outputFallbacks).toHaveLength(1)
    expect(outputFallbacks[0]).toMatchObject({
      type: 'terminal.output',
      terminalId,
      streamId,
      attachRequestId,
      seqStart: 1,
      seqEnd: 1,
      data,
    })
    expect(measureTerminalOutputPayloadBytes(outputFallbacks[0])).toBeLessThanOrEqual(MAX_REALTIME_MESSAGE_BYTES)

    broker.close()
  })

  it('drains foreground replay batches without the background pacing delay', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-foreground-replay')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-foreground-replay', 'viewport_hydrate', 80, 24, 0, 'seed-attach')

    const chunk = 'x'.repeat(Math.floor(MAX_REALTIME_MESSAGE_BYTES / 2))
    for (let i = 1; i <= 4; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-foreground-replay',
        data: `foreground-frame-${i};${chunk}`,
        at: Date.now(),
      })
    }

    const wsReplay = createMockWs()
    await broker.attach(wsReplay as any, 'term-foreground-replay', 'transport_reconnect', 80, 24, 0, 'foreground-attach')
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(1)
    }

    const outputs = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload) => payload?.type === 'terminal.output')
    expect(outputs.map((payload) => String(payload.data)).join('')).toContain('foreground-frame-4;')

    broker.close()
  })

  it('paces foreground replay when socket bufferedAmount grows under replay pressure', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(4 * 1024 * 1024)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-foreground-paced')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-foreground-paced', 'viewport_hydrate', 80, 24, 0, 'seed-attach')

    const chunk = 'x'.repeat(2 * 1024)
    for (let i = 1; i <= 1400; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-foreground-paced',
        data: `foreground-paced-${i};${chunk}`,
        at: Date.now(),
      })
    }

    const wsReplay = createMockWs({ bufferedAmount: 0 })
    wsReplay.send.mockImplementation((raw: string) => {
      wsReplay.bufferedAmount += Buffer.byteLength(raw, 'utf8')
    })

    await broker.attach(
      wsReplay as any,
      'term-foreground-paced',
      'transport_reconnect',
      80,
      24,
      0,
      'foreground-paced-attach',
      undefined,
      'foreground',
    )
    for (let i = 0; i < 220; i += 1) {
      vi.runOnlyPendingTimers()
    }

    expect(wsReplay.bufferedAmount).toBeLessThanOrEqual(512 * 1024 + 64 * 1024)

    broker.close()
  })

  it('resumes foreground replay after bufferedAmount drains and completes the retained backlog', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(4 * 1024 * 1024)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-foreground-resume')

    const chunk = 'x'.repeat(2 * 1024)
    for (let i = 1; i <= 800; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-foreground-resume',
        data: `foreground-resume-${i};${chunk}`,
        at: Date.now(),
      })
    }

    const wsReplay = createMockWs({ bufferedAmount: 0 })
    wsReplay.send.mockImplementation((raw: string) => {
      wsReplay.bufferedAmount += Buffer.byteLength(raw, 'utf8')
    })

    await broker.attach(
      wsReplay as any,
      'term-foreground-resume',
      'transport_reconnect',
      80,
      24,
      0,
      'foreground-resume-attach',
      undefined,
      'foreground',
    )

    let outputs: any[] = []
    for (let cycle = 0; cycle < 20; cycle += 1) {
      for (let i = 0; i < 220; i += 1) {
        vi.runOnlyPendingTimers()
      }
      outputs = wsReplay.send.mock.calls
        .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
        .filter((payload) => payload?.type === 'terminal.output')
      if (outputs.map((payload) => String(payload.data)).join('').includes('foreground-resume-800;')) {
        break
      }
      wsReplay.bufferedAmount = 0
    }

    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs.every((payload) => payload.attachRequestId === 'foreground-resume-attach')).toBe(true)
    expect(outputs.map((payload) => String(payload.data)).join('')).toContain('foreground-resume-800;')

    broker.close()
  })

  it('rate limits foreground replay backpressure state logs while the socket remains blocked', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(4 * 1024 * 1024)
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-foreground-log-limited')

    for (let i = 1; i <= 40; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-foreground-log-limited',
        data: `foreground-log-limited-${i};${'x'.repeat(2 * 1024)}`,
        at: Date.now(),
      })
    }

    const wsReplay = createMockWs({ bufferedAmount: 768 * 1024 })
    await broker.attach(
      wsReplay as any,
      'term-foreground-log-limited',
      'transport_reconnect',
      80,
      24,
      0,
      'foreground-log-limited-attach',
      undefined,
      'foreground',
    )

    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(50)
    }

    const pauseLogs = loggerMocks.logger.debug.mock.calls.filter(([payload]) =>
      payload
      && typeof payload === 'object'
      && (payload as { event?: unknown }).event === 'terminal.replay.backpressure_state'
      && (payload as { terminalId?: unknown }).terminalId === 'term-foreground-log-limited'
    )
    expect(pauseLogs).toHaveLength(1)
    expect(structuredLogs('debug', 'terminal_stream_replay_backpressure_pause')
      .filter((payload) => payload.terminalId === 'term-foreground-log-limited')).toHaveLength(0)

    broker.close()
  })

  it('pauses background replay when socket bufferedAmount is above the background threshold without closing', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-background-paused')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-background-paused', 'viewport_hydrate', 80, 24, 0, 'seed-attach')
    for (let i = 1; i <= 10; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-background-paused',
        data: `hidden-frame-${i};`,
        at: Date.now(),
      })
    }

    const wsReplay = createMockWs({ bufferedAmount: 768 * 1024 })
    const closeSpy = vi.spyOn(wsReplay, 'close')
    await broker.attach(
      wsReplay as any,
      'term-background-paused',
      'keepalive_delta',
      80,
      24,
      0,
      'background-attach',
      undefined,
      'background',
    )

    vi.advanceTimersByTime(100)

    const outputsWhileBlocked = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload) => payload?.type === 'terminal.output')
    expect(outputsWhileBlocked).toHaveLength(0)
    expect(closeSpy).not.toHaveBeenCalled()

    wsReplay.bufferedAmount = 0
    vi.advanceTimersByTime(100)

    const outputsAfterDrain = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload) => payload?.type === 'terminal.output')
    expect(outputsAfterDrain.length).toBeGreaterThan(0)
    expect(outputsAfterDrain.map((payload) => String(payload.data)).join('')).toContain('hidden-frame-10;')
    expect(closeSpy).not.toHaveBeenCalled()

    broker.close()
  })

  it('foreground attach on the same terminal can drain after a paused background attach', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-promoted')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-promoted', 'viewport_hydrate', 80, 24, 0, 'seed-attach')
    for (let i = 1; i <= 12; i += 1) {
      registry.emit('terminal.output.raw', {
        terminalId: 'term-promoted',
        data: `promoted-frame-${i};`,
        at: Date.now(),
      })
    }

    const ws = createMockWs({ bufferedAmount: 512 * 1024 + 16 * 1024 })
    await broker.attach(ws as any, 'term-promoted', 'keepalive_delta', 80, 24, 0, 'background-attach', undefined, 'background')
    vi.advanceTimersByTime(100)
    expect(ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload) => payload?.type === 'terminal.output')).toHaveLength(0)

    await broker.attach(ws as any, 'term-promoted', 'transport_reconnect', 80, 24, 0, 'foreground-attach', undefined, 'foreground')
    vi.advanceTimersByTime(5)

    const outputs = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload) => payload?.type === 'terminal.output')
    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs.every((payload) => payload.attachRequestId === 'foreground-attach')).toBe(true)
    expect(outputs.map((payload) => String(payload.data)).join('')).toContain('promoted-frame-12;')

    broker.close()
  })

  it('emits terminal_stream_replay_hit, terminal_stream_queue_pressure, and terminal_stream_gap on overflow', async () => {
    forceSmallTerminalClientQueueForOverflowTest()
    const registry = new FakeBrokerRegistry()
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-overflow')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-overflow', 'viewport_hydrate', 80, 24, 0)
    registry.emit('terminal.output.raw', { terminalId: 'term-overflow', data: 'seed-1', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-overflow', data: 'seed-2', at: Date.now() })
    broker.detach('term-overflow', wsSeed as any)

    const wsReplay = createMockWs()
    await broker.attach(wsReplay as any, 'term-overflow', 'viewport_hydrate', 80, 24, 1)
    expect(perfSpy.mock.calls.some(([event, payload]) =>
      event === 'terminal_stream_replay_hit' &&
      payload?.terminalId === 'term-overflow' &&
      payload?.sinceSeq === 1,
    )).toBe(true)

    const wsOverflow = createMockWs()
    await broker.attach(wsOverflow as any, 'term-overflow', 'viewport_hydrate', 80, 24, 0)

    for (let i = 0; i < 220; i += 1) {
      registry.emit('terminal.output.raw', { terminalId: 'term-overflow', data: 'x'.repeat(1024), at: Date.now() })
    }
    vi.advanceTimersByTime(5)

    expect(perfSpy.mock.calls.some(([event, payload, level]) =>
      event === 'terminal_stream_queue_pressure' &&
      payload?.terminalId === 'term-overflow' &&
      typeof payload?.queueDepth === 'number' &&
      payload.queueDepth > 0 &&
      typeof payload?.droppedBytes === 'number' &&
      payload.droppedBytes > 0 &&
      level === 'warn',
    )).toBe(true)
    expect(perfSpy.mock.calls.some(([event, payload, level]) =>
      event === 'terminal_stream_gap' &&
      payload?.terminalId === 'term-overflow' &&
      payload?.reason === 'queue_overflow' &&
      typeof payload?.droppedBytes === 'number' &&
      payload.droppedBytes > 0 &&
      level === 'warn',
    )).toBe(true)
    expect(structuredLogs('warn', 'terminal.replay.gap')
      .filter((payload) => (
        payload.terminalId === 'term-overflow'
        && payload.reason === 'queue_overflow'
      ))).toHaveLength(0)
    expect(structuredLogs('warn', 'terminal.output.gap')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'terminal.output.gap',
          severity: 'warn',
          terminalId: 'term-overflow',
          source: 'live',
          reason: 'queue_overflow',
          fromSeq: expect.any(Number),
          toSeq: expect.any(Number),
          streamId: expect.any(String),
          queueDepth: expect.any(Number),
          droppedBytes: expect.any(Number),
          droppedSerializedApplicationJsonBytes: expect.any(Number),
        }),
      ]),
    )

    broker.close()
  })

  it('uses registry replay budget to avoid replay-window gaps for moderate retained history', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(1_000_000)
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-replay-budget')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-replay-budget', 'viewport_hydrate', 80, 24, 0)
    registry.emit('terminal.output.raw', {
      terminalId: 'term-replay-budget',
      data: 'a'.repeat(400 * 1024),
      at: Date.now(),
    })

    const wsReplay = createMockWs()
    await broker.attach(wsReplay as any, 'term-replay-budget', 'viewport_hydrate', 80, 24, 0)
    vi.advanceTimersByTime(5)

    const payloads = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')

    expect(payloads.some((payload) =>
      payload.type === 'terminal.output.gap' &&
      payload.reason === 'replay_window_exceeded'
    )).toBe(false)
    expect(payloads.some((payload) => payload.type === 'terminal.output')).toBe(true)

    broker.close()
  })

  it('enforces the 32 MiB replay floor for coding-cli terminals to reduce history loss on attach', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(8)
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-coding-floor', 'codex')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-coding-floor', 'viewport_hydrate', 80, 24, 0)
    const terminalState = (broker as any).terminals.get('term-coding-floor')
    expect(terminalState?.replayRing.retentionMaxBytes()).toBe(32 * 1024 * 1024)

    registry.emit('terminal.output.raw', {
      terminalId: 'term-coding-floor',
      data: 'x'.repeat(96 * 1024),
      at: Date.now(),
    })

    const wsReplay = createMockWs()
    await broker.attach(wsReplay as any, 'term-coding-floor', 'viewport_hydrate', 80, 24, 0)
    vi.advanceTimersByTime(5)

    const payloads = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')

    expect(payloads.some((payload) =>
      payload.type === 'terminal.output.gap' &&
      payload.reason === 'replay_window_exceeded'
    )).toBe(false)
    expect(payloads.some((payload) => payload.type === 'terminal.output')).toBe(true)

    broker.close()
  })

  it('replays a truncated frame tail for single oversized output without replay-window gaps', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(8)
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-oversized-tail')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-oversized-tail', 'viewport_hydrate', 80, 24, 0)
    registry.emit('terminal.output.raw', {
      terminalId: 'term-oversized-tail',
      data: '0123456789',
      at: Date.now(),
    })

    const wsReplay = createMockWs()
    await broker.attach(wsReplay as any, 'term-oversized-tail', 'viewport_hydrate', 80, 24, 0)
    vi.advanceTimersByTime(5)

    const payloads = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')

    const replayOutput = payloads.find((payload) => payload.type === 'terminal.output')
    expect(replayOutput).toBeDefined()
    expect(Buffer.byteLength(replayOutput?.data ?? '', 'utf8')).toBeLessThanOrEqual(8)
    expect(payloads.some((payload) =>
      payload.type === 'terminal.output.gap' &&
      payload.reason === 'replay_window_exceeded'
    )).toBe(false)

    broker.close()
  })
})
