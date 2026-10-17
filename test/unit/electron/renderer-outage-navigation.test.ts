import { describe, expect, it, vi } from 'vitest'
import { navigateToUnavailableEndpoint } from '../../e2e-electron/renderer-outage-navigation.js'

const url = 'http://127.0.0.1:4455/?token=owned-token'
const refused = () => Object.assign(new Error('ERR_CONNECTION_REFUSED'), { code: 'ERR_CONNECTION_REFUSED', errno: -102 })

function cachedOfflineWindow() {
  let cachedDocument = true
  const window = {
    webContents: { session: { clearCache: vi.fn(async () => { cachedDocument = false }) } },
    loadURL: vi.fn(async (_url: string) => {
      // Chromium can mount cached Freshell bytes while its API bootstrap fails.
      if (!cachedDocument) throw refused()
    }),
  }
  return window
}

describe('renderer outage navigation fault', () => {
  it('establishes a real network failure even when the app document is cached', async () => {
    const window = cachedOfflineWindow()
    await expect(navigateToUnavailableEndpoint(window, url)).resolves.toEqual({ code: 'ERR_CONNECTION_REFUSED', errno: -102 })
    expect(window.loadURL).toHaveBeenCalledExactlyOnceWith(url)
  })

  it('does not navigate until cache eviction has completed', async () => {
    let evict!: () => void
    const window = cachedOfflineWindow()
    const clear = window.webContents.session.clearCache.getMockImplementation()!
    window.webContents.session.clearCache.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { evict = resolve })
      await clear()
    })
    const fault = navigateToUnavailableEndpoint(window, url)
    await Promise.resolve()
    expect(window.loadURL).not.toHaveBeenCalled()
    evict()
    await expect(fault).resolves.toEqual({ code: 'ERR_CONNECTION_REFUSED', errno: -102 })
  })

  it('preserves a cache-eviction failure without claiming or starting the outage navigation', async () => {
    const window = cachedOfflineWindow()
    const failure = new Error('cache eviction failed')
    window.webContents.session.clearCache.mockRejectedValueOnce(failure)
    await expect(navigateToUnavailableEndpoint(window, url)).rejects.toBe(failure)
    expect(window.loadURL).not.toHaveBeenCalled()
  })

  it('refuses to count a successful app document as a native network failure', async () => {
    const window = cachedOfflineWindow()
    window.loadURL.mockResolvedValueOnce(undefined)
    await expect(navigateToUnavailableEndpoint(window, url)).rejects.toThrow('Outage navigation unexpectedly loaded a document')
  })

  it.each([
    { code: 'ERR_ABORTED', errno: -3 },
    { code: 'ERR_BLOCKED_BY_CLIENT', errno: -20 },
    { code: 'ERR_CONNECTION_REFUSED', errno: -3 },
  ])('preserves an unrelated $code/$errno failure', async details => {
    const window = cachedOfflineWindow()
    const failure = Object.assign(new Error(details.code), details)
    window.loadURL.mockRejectedValueOnce(failure)
    await expect(navigateToUnavailableEndpoint(window, url)).rejects.toBe(failure)
  })
})
