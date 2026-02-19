import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerServiceWorker } from '@/lib/pwa'

describe('PWA shell registration', () => {
  const originalAddEventListener = window.addEventListener
  const originalServiceWorker = (navigator as any).serviceWorker

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: originalAddEventListener,
    })

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: originalServiceWorker,
    })
  })

  it('registers service worker on window load when enabled', async () => {
    const register = vi.fn().mockResolvedValue(undefined)
    const handlers: Record<string, EventListener> = {}

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { register },
    })

    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: vi.fn((event: string, handler: EventListener) => {
        handlers[event] = handler
      }),
    })

    registerServiceWorker({ enabled: true })
    handlers.load?.(new Event('load'))

    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith('/sw.js')
    })
  })

  it('does not register when disabled', () => {
    const register = vi.fn().mockResolvedValue(undefined)

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { register },
    })

    registerServiceWorker({ enabled: false })
    expect(register).not.toHaveBeenCalled()
  })
})
