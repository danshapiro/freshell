import { describe, expect, it, vi } from 'vitest'

import { waitForHttp } from './wait-for-http.js'

describe('waitForHttp', () => {
  it('rejects a persistent HTTP 200 response when waiting for shutdown', async () => {
    const fetchHealth = vi.fn(async () => ({ status: 200 }))

    await expect(
      waitForHttp(43_127, 'down', 5, { fetchHealth, pollInterval: 1 }),
    ).rejects.toThrow('port 43127 did not become down')
    expect(fetchHealth).toHaveBeenCalled()
  })

  it('accepts a failed connection as proof of shutdown', async () => {
    const fetchHealth = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })

    await expect(
      waitForHttp(43_127, 'down', 20, { fetchHealth, pollInterval: 1 }),
    ).resolves.toBeUndefined()
    expect(fetchHealth).toHaveBeenCalledTimes(1)
  })
})
