import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpClient } from '../../../server/cli/http'

describe('createHttpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses message from error payload when error field is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          message: 'No screenshot-capable UI client connected',
        }),
        {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    vi.stubGlobal('fetch', fetchMock)

    const client = createHttpClient({
      url: 'http://127.0.0.1:3344',
      token: 'test-token',
    } as any)

    await expect(client.post('/api/screenshots', { scope: 'view', name: 'manual-no-ui-check' })).rejects.toMatchObject({
      message: 'No screenshot-capable UI client connected',
      status: 503,
    })
  })

  it('prefers explicit error field when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          error: 'explicit error field',
          message: 'fallback message',
        }),
        {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    vi.stubGlobal('fetch', fetchMock)

    const client = createHttpClient({
      url: 'http://127.0.0.1:3344',
      token: 'test-token',
    } as any)

    await expect(client.get('/api/example')).rejects.toMatchObject({
      message: 'explicit error field',
      status: 400,
    })
  })
})
