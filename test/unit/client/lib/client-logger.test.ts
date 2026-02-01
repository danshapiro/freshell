import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockFetch = vi.fn()

global.fetch = mockFetch

const mockSessionStorage: Record<string, string> = {}
vi.stubGlobal('sessionStorage', {
  getItem: (key: string) => mockSessionStorage[key] || null,
  setItem: (key: string, value: string) => { mockSessionStorage[key] = value },
})

import { createClientLogger } from '@/lib/client-logger'

describe('client logger', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockSessionStorage['auth-token'] = 'test-token'
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
})
