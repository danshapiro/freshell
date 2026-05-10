import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withChunkErrorRecovery, shouldReload, isChunkLoadError } from '@/lib/import-retry'

describe('withChunkErrorRecovery', () => {
  const originalReload = window.location.reload

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: vi.fn() },
      writable: true,
      configurable: true,
    })
    sessionStorage.clear()
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: originalReload },
      writable: true,
      configurable: true,
    })
  })

  it('resolves with the module when import succeeds', async () => {
    const mod = { foo: 'bar' }
    const result = await withChunkErrorRecovery(Promise.resolve(mod))
    expect(result).toBe(mod)
  })

  describe('chunk-load error detection', () => {
    it('reloads on Chrome-style chunk error', async () => {
      const err = new TypeError(
        'Failed to fetch dynamically imported module: http://localhost/assets/chunk-abc123.js'
      )
      const p = withChunkErrorRecovery(Promise.reject(err))
      await new Promise((r) => setTimeout(r, 0))
      expect(window.location.reload).toHaveBeenCalled()
    })

    it('reloads on Firefox-style chunk error', async () => {
      const err = new TypeError(
        'error loading dynamically imported module: http://localhost/assets/chunk-abc123.js'
      )
      const p = withChunkErrorRecovery(Promise.reject(err))
      await new Promise((r) => setTimeout(r, 0))
      expect(window.location.reload).toHaveBeenCalled()
    })

    it('reloads on Safari-style chunk error', async () => {
      const err = new TypeError('Importing a module script failed.')
      const p = withChunkErrorRecovery(Promise.reject(err))
      await new Promise((r) => setTimeout(r, 0))
      expect(window.location.reload).toHaveBeenCalled()
    })

    it('reloads on Vite-style chunk failure', async () => {
      const err = new TypeError('loading chunk 42 failed')
      const p = withChunkErrorRecovery(Promise.reject(err))
      await new Promise((r) => setTimeout(r, 0))
      expect(window.location.reload).toHaveBeenCalled()
    })

    it('does not reload on unrelated TypeError', async () => {
      const err = new TypeError('NetworkError when attempting to fetch resource.')
      await expect(withChunkErrorRecovery(Promise.reject(err))).rejects.toBe(err)
      expect(window.location.reload).not.toHaveBeenCalled()
    })
  })

  describe('circuit breaker', () => {
    it('does not reload if a reload happened within cooldown window', async () => {
      sessionStorage.setItem('freshell.chunk-reload', String(Date.now()))
      const err = new TypeError(
        'Failed to fetch dynamically imported module: http://localhost/assets/chunk-abc123.js'
      )
      await expect(withChunkErrorRecovery(Promise.reject(err))).rejects.toBe(err)
      expect(window.location.reload).not.toHaveBeenCalled()
    })

    it('reloads if the previous reload was outside cooldown window', async () => {
      sessionStorage.setItem('freshell.chunk-reload', String(Date.now() - 20_000))
      const err = new TypeError(
        'Failed to fetch dynamically imported module: http://localhost/assets/chunk-abc123.js'
      )
      const p = withChunkErrorRecovery(Promise.reject(err))
      await new Promise((r) => setTimeout(r, 0))
      expect(window.location.reload).toHaveBeenCalled()
    })
  })

  it('re-throws regular Error unchanged', async () => {
    const err = new Error('Something else broke')
    await expect(withChunkErrorRecovery(Promise.reject(err))).rejects.toBe(err)
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('re-throws non-Error rejections unchanged', async () => {
    await expect(withChunkErrorRecovery(Promise.reject('string failure'))).rejects.toBe(
      'string failure'
    )
    expect(window.location.reload).not.toHaveBeenCalled()
  })
})

describe('shouldReload', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('returns true on first call', () => {
    expect(shouldReload()).toBe(true)
  })

  it('returns false if called within cooldown window', () => {
    sessionStorage.setItem('freshell.chunk-reload', String(Date.now()))
    expect(shouldReload()).toBe(false)
  })

  it('returns true after cooldown expires', () => {
    sessionStorage.setItem('freshell.chunk-reload', String(Date.now() - 20_000))
    expect(shouldReload()).toBe(true)
  })

  it('returns true when sessionStorage is unavailable', () => {
    const originalGetItem = sessionStorage.getItem
    sessionStorage.getItem = () => { throw new DOMException('SecurityError') }
    expect(shouldReload()).toBe(true)
    sessionStorage.getItem = originalGetItem
  })
})

describe('isChunkLoadError', () => {
  it('returns false for non-TypeError errors', () => {
    const err = new RangeError(
      'Failed to fetch dynamically imported module: http://localhost/assets/chunk.js'
    )
    expect(isChunkLoadError(err)).toBe(false)
  })

  it('returns false for matching message in regular Error', () => {
    const err = new Error('importing a module script')
    expect(isChunkLoadError(err)).toBe(false)
  })
})
