// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const mockState = vi.hoisted(() => {
  const perfConfig = {
    enabled: false,
    httpSlowMs: 500,
  }

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  return {
    perfConfig,
    logger,
    logPerfEvent: vi.fn(),
    withLogContext: vi.fn((_ctx: any, fn: () => void) => fn()),
  }
})

vi.mock('../../../server/logger', () => ({
  logger: mockState.logger,
  withLogContext: mockState.withLogContext,
}))

vi.mock('../../../server/perf-logger', () => ({
  getPerfConfig: () => mockState.perfConfig,
  logPerfEvent: mockState.logPerfEvent,
}))

import { requestLogger, sanitizeUrl } from '../../../server/request-logger'

class FakeResponse extends EventEmitter {
  statusCode = 200
  #headers = new Map<string, unknown>()

  setHeader(name: string, value: unknown) {
    this.#headers.set(String(name).toLowerCase(), value)
  }

  getHeader(name: string) {
    return this.#headers.get(String(name).toLowerCase())
  }
}

describe('sanitizeUrl', () => {
  it('strips token query parameter', () => {
    expect(sanitizeUrl('/?token=abc123')).toBe('/')
  })

  it('preserves other query parameters', () => {
    expect(sanitizeUrl('/page?foo=bar&token=abc&baz=1')).toBe('/page?foo=bar&baz=1')
  })

  it('passes through URLs without token', () => {
    expect(sanitizeUrl('/api/settings')).toBe('/api/settings')
  })

  it('handles URL with only token param', () => {
    expect(sanitizeUrl('/path?token=secret')).toBe('/path')
  })
})

describe('requestLogger', () => {
  beforeEach(() => {
    mockState.logger.info.mockClear()
    mockState.logger.warn.mockClear()
    mockState.logger.error.mockClear()
    mockState.logPerfEvent.mockClear()
    mockState.perfConfig.enabled = false
    mockState.perfConfig.httpSlowMs = 500
  })

  it('logs perf event for slow requests when enabled', async () => {
    mockState.perfConfig.enabled = true
    mockState.perfConfig.httpSlowMs = 0

    const req: any = {
      headers: { 'user-agent': 'test' },
      method: 'GET',
      originalUrl: '/api/test',
      ip: '127.0.0.1',
    }
    const res = new FakeResponse()

    await new Promise<void>((resolve) => {
      requestLogger(req, res as any, () => resolve())
    })

    res.emit('finish')

    expect(mockState.logPerfEvent).toHaveBeenCalledWith(
      'http_request_slow',
      expect.objectContaining({
        method: 'GET',
        path: '/api/test',
        statusCode: 200,
      }),
      'warn',
    )
  })

  it('does not log perf event when disabled', async () => {
    mockState.perfConfig.enabled = false
    mockState.perfConfig.httpSlowMs = 0

    const req: any = {
      headers: { 'user-agent': 'test' },
      method: 'GET',
      originalUrl: '/api/test',
      ip: '127.0.0.1',
    }
    const res = new FakeResponse()

    await new Promise<void>((resolve) => {
      requestLogger(req, res as any, () => resolve())
    })

    res.emit('finish')
    expect(mockState.logPerfEvent).not.toHaveBeenCalled()
  })
})

