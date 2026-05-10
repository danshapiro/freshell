import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initChunkErrorRecovery } from '@/lib/import-retry'

function createRejectionEvent(reason: unknown): Event {
  const event = new Event('unhandledrejection', { cancelable: true })
  Object.defineProperty(event, 'reason', { value: reason, writable: false })
  return event
}

describe('initChunkErrorRecovery', () => {
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

  it('reloads on vite:preloadError event', () => {
    initChunkErrorRecovery()
    const event = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(event)
    expect(window.location.reload).toHaveBeenCalled()
  })

  it('reloads on unhandledrejection with chunk-load error', () => {
    initChunkErrorRecovery()
    const err = new TypeError(
      'Failed to fetch dynamically imported module: http://localhost/assets/chunk-abc123.js'
    )
    window.dispatchEvent(createRejectionEvent(err))
    expect(window.location.reload).toHaveBeenCalled()
  })

  it('does not reload on unhandledrejection with non-chunk error', () => {
    initChunkErrorRecovery()
    const err = new Error('Something else')
    window.dispatchEvent(createRejectionEvent(err))
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('respects circuit breaker on vite:preloadError', () => {
    sessionStorage.setItem('freshell.chunk-reload', String(Date.now()))
    initChunkErrorRecovery()
    const event = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(event)
    expect(window.location.reload).not.toHaveBeenCalled()
  })
})
