import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'

const mockFetch = vi.fn()

global.fetch = mockFetch

import { createClientLogger } from '@/lib/client-logger'

describe('client logger', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('forwards console warnings to the server', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })

    const logger = createClientLogger({
      flushIntervalMs: 0,
      maxBatchSize: 1,
      enableNetwork: true,
    })

    const uninstall = logger.installConsoleCapture()

    console.warn('Heads up', { code: 123 })
    await logger.flush()

    uninstall()

    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('/api/logs/client')
    expect(options).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      })
    )

    const body = JSON.parse(options.body as string)
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].severity).toBe('warn')
    expect(body.entries[0].message).toContain('Heads up')
  })

  it('does not enqueue perf telemetry payloads for remote transport', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })

    const logger = createClientLogger({
      flushIntervalMs: 0,
      maxBatchSize: 10,
      enableNetwork: true,
    })
    const uninstall = logger.installConsoleCapture()

    console.warn({ event: 'perf.longtask', perf: true, durationMs: 120 })
    await logger.flush()

    uninstall()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('drops duplicate warning entries within the dedupe window', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })

    const logger = createClientLogger({
      flushIntervalMs: 0,
      maxBatchSize: 10,
      enableNetwork: true,
    })
    const uninstall = logger.installConsoleCapture()

    console.warn('[ChunkedAttach] noisy warning')
    console.warn('[ChunkedAttach] noisy warning')
    await logger.flush()
    uninstall()

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, options] = mockFetch.mock.calls[0]
    const body = JSON.parse(options.body as string)
    expect(body.entries).toHaveLength(1)
  })
})
