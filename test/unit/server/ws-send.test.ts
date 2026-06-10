// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import WebSocket from 'ws'

const perfMocks = vi.hoisted(() => ({
  config: {
    enabled: true,
    wsPayloadWarnBytes: 16,
    rateLimitMs: 0,
  },
  logPerfEvent: vi.fn(),
  shouldLog: vi.fn(() => true),
}))

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

vi.mock('../../../server/perf-logger', () => ({
  getPerfConfig: () => perfMocks.config,
  logPerfEvent: perfMocks.logPerfEvent,
  shouldLog: perfMocks.shouldLog,
}))

vi.mock('../../../server/logger', () => ({ logger: loggerMocks.logger }))

import {
  prepareJsonMessage,
  readWebSocketBufferedAmount,
  sendJsonMessage,
  sendPreparedJsonMessage,
} from '../../../server/ws-send'

function createMockWs(overrides: Record<string, unknown> = {}) {
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    connectionId: 'conn-test',
    send: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
  return ws as typeof ws & {
    readyState: number
    bufferedAmount: number
    connectionId?: string
    send: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
}

describe('ws-send', () => {
  beforeEach(() => {
    perfMocks.config.enabled = true
    perfMocks.config.wsPayloadWarnBytes = 16
    perfMocks.config.rateLimitMs = 0
    perfMocks.logPerfEvent.mockClear()
    perfMocks.shouldLog.mockClear()
    perfMocks.shouldLog.mockReturnValue(true)
    loggerMocks.logger.warn.mockClear()
  })

  it('serializes JSON once, measures serialized bytes, and reports bufferedAmount before and after send', () => {
    const ws = createMockWs()
    ws.send.mockImplementation((raw: string, cb?: (err?: Error) => void) => {
      ws.bufferedAmount += Buffer.byteLength(raw, 'utf8')
      cb?.()
    })

    const prepared = prepareJsonMessage({ type: 'unit.test', value: 'ok' })
    const result = sendPreparedJsonMessage(ws, prepared)

    expect(result.sent).toBe(true)
    expect(result.serializedApplicationJsonBytes).toBe(Buffer.byteLength(prepared.serialized, 'utf8'))
    expect(result.bufferedBefore).toBe(0)
    expect(result.bufferedAfter).toBe(Buffer.byteLength(prepared.serialized, 'utf8'))
    expect(ws.send).toHaveBeenCalledWith(prepared.serialized, expect.any(Function))
  })

  it('does not send to a closed socket', () => {
    const ws = createMockWs({ readyState: WebSocket.CLOSED })
    const result = sendJsonMessage(ws, { type: 'closed.test' })

    expect(result.sent).toBe(false)
    expect(result.reason).toBe('closed')
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('closes before sending when bufferedAmount exceeds the configured backpressure limit', () => {
    const ws = createMockWs({ bufferedAmount: 2 * 1024 * 1024 + 1 })
    const result = sendJsonMessage(ws, { type: 'pressure.test' }, {
      maxBufferedAmount: 2 * 1024 * 1024,
      backpressureCloseCode: 4008,
      backpressureCloseReason: 'Backpressure',
    })

    expect(result.sent).toBe(false)
    expect(result.reason).toBe('backpressure')
    expect(ws.close).toHaveBeenCalledWith(4008, 'Backpressure')
    expect(ws.send).not.toHaveBeenCalled()
    expect(perfMocks.logPerfEvent).toHaveBeenCalledWith(
      'ws_backpressure_close',
      expect.objectContaining({
        connectionId: 'conn-test',
        bufferedBytes: 2 * 1024 * 1024 + 1,
        limitBytes: 2 * 1024 * 1024,
      }),
      'warn',
    )
  })

  it('logs ws_send_large from the ws.send callback with bufferedAmount measurements', () => {
    const ws = createMockWs({ bufferedAmount: 100 })
    ws.send.mockImplementation((raw: string, cb?: (err?: Error) => void) => {
      ws.bufferedAmount += Buffer.byteLength(raw, 'utf8')
      cb?.()
    })

    const result = sendJsonMessage(ws, { type: 'large.test', data: 'x'.repeat(32) })

    expect(result.sent).toBe(true)
    expect(perfMocks.logPerfEvent).toHaveBeenCalledWith(
      'ws_send_large',
      expect.objectContaining({
        connectionId: 'conn-test',
        messageType: 'large.test',
        payloadBytes: result.serializedApplicationJsonBytes,
        bufferedBytes: 100,
        bufferedBytesAfter: result.bufferedAfter,
        error: false,
      }),
      'warn',
    )
  })

  it('logs callback errors for small sends when perf logging is disabled', () => {
    perfMocks.config.enabled = false
    const ws = createMockWs()
    const error = new Error('small send failed')
    ws.send.mockImplementation((_raw: string, cb?: (err?: Error) => void) => {
      cb?.(error)
    })

    const result = sendJsonMessage(ws, { type: 'small.test', data: 'ok' })

    expect(result.sent).toBe(true)
    expect(loggerMocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: error,
        connectionId: 'conn-test',
        messageType: 'small.test',
      }),
      'WebSocket send callback reported failure',
    )
    expect(perfMocks.logPerfEvent).not.toHaveBeenCalledWith(
      'ws_send_large',
      expect.anything(),
      expect.anything(),
    )
  })

  it('logs callback errors even when large-send perf logging is rate limited', () => {
    perfMocks.config.enabled = true
    perfMocks.config.wsPayloadWarnBytes = 1
    perfMocks.shouldLog.mockReturnValue(false)
    const ws = createMockWs()
    const error = new Error('rate limited send failed')
    ws.send.mockImplementation((_raw: string, cb?: (err?: Error) => void) => {
      cb?.(error)
    })

    const result = sendJsonMessage(ws, { type: 'limited.test', data: 'x'.repeat(32) })

    expect(result.sent).toBe(true)
    expect(loggerMocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: error,
        connectionId: 'conn-test',
        messageType: 'limited.test',
      }),
      'WebSocket send callback reported failure',
    )
    expect(perfMocks.logPerfEvent).not.toHaveBeenCalledWith(
      'ws_send_large',
      expect.anything(),
      expect.anything(),
    )
  })

  it('normalizes unavailable bufferedAmount reads to undefined', () => {
    expect(readWebSocketBufferedAmount({ bufferedAmount: undefined })).toBeUndefined()
    expect(readWebSocketBufferedAmount({ bufferedAmount: Number.NaN })).toBeUndefined()
  })

  it('uses one shared serialized JSON budget even when WS_MAX_PAYLOAD_BYTES differs', async () => {
    const originalMaxSerialized = process.env.MAX_SERIALIZED_APPLICATION_JSON_BYTES
    const originalWsMaxPayload = process.env.WS_MAX_PAYLOAD_BYTES
    process.env.MAX_SERIALIZED_APPLICATION_JSON_BYTES = '128'
    process.env.WS_MAX_PAYLOAD_BYTES = '4096'
    vi.resetModules()
    try {
      const { sendJsonMessage: sendWithReloadedBudget } = await import('../../../server/ws-send')
      const ws = createMockWs()
      const result = sendWithReloadedBudget(ws, { type: 'budget.test', data: 'x'.repeat(1500) })

      expect(result.sent).toBe(false)
      expect(result.reason).toBe('oversized')
      expect(ws.send).not.toHaveBeenCalled()
    } finally {
      if (originalMaxSerialized === undefined) {
        delete process.env.MAX_SERIALIZED_APPLICATION_JSON_BYTES
      } else {
        process.env.MAX_SERIALIZED_APPLICATION_JSON_BYTES = originalMaxSerialized
      }
      if (originalWsMaxPayload === undefined) {
        delete process.env.WS_MAX_PAYLOAD_BYTES
      } else {
        process.env.WS_MAX_PAYLOAD_BYTES = originalWsMaxPayload
      }
      vi.resetModules()
    }
  })
})
