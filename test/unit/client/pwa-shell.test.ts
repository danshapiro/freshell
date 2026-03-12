import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerServiceWorker } from '@/lib/pwa'

describe('PWA shell registration', () => {
  const originalAddEventListener = window.addEventListener
  const originalServiceWorker = (navigator as any).serviceWorker
  const originalSessionStorage = window.sessionStorage

  function createStorageMock(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial))
    return {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key)
      }),
    }
  }

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

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: originalSessionStorage,
    })
  })

  it('registers service worker on window load when enabled', async () => {
    const register = vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) })
    const handlers: Record<string, EventListener> = {}
    const storage = createStorageMock()

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { register, addEventListener: vi.fn() },
    })

    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: vi.fn((event: string, handler: EventListener) => {
        handlers[event] = handler
      }),
    })

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: storage,
    })

    registerServiceWorker({ enabled: true, storage })
    handlers.load?.(new Event('load'))

    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith('/sw.js')
    })
  })

  it('requests a service worker update after registering', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const register = vi.fn().mockResolvedValue({ update })
    const handlers: Record<string, EventListener> = {}
    const storage = createStorageMock()

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { register, addEventListener: vi.fn() },
    })

    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: vi.fn((event: string, handler: EventListener) => {
        handlers[event] = handler
      }),
    })

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: storage,
    })

    registerServiceWorker({ enabled: true, storage })
    handlers.load?.(new Event('load'))

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1)
    })
  })

  it('reloads once when a new service worker takes control', () => {
    const register = vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) })
    const addEventListener = vi.fn()
    const handlers: Record<string, EventListener> = {}
    const reload = vi.fn()
    const storage = createStorageMock()

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: {
        register,
        addEventListener: vi.fn((event: string, handler: EventListener) => {
          handlers[event] = handler
          addEventListener(event, handler)
        }),
      },
    })

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: storage,
    })

    registerServiceWorker({ enabled: true, reload, storage })
    handlers.controllerchange?.(new Event('controllerchange'))
    handlers.controllerchange?.(new Event('controllerchange'))

    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.setItem).toHaveBeenCalledWith('freshell.sw.controller-reload', '1')
    expect(addEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function))
  })

  it('clears the stale reload sentinel on startup', () => {
    const register = vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) })
    const storage = createStorageMock({ 'freshell.sw.controller-reload': '1' })

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { register, addEventListener: vi.fn() },
    })

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: storage,
    })

    registerServiceWorker({ enabled: true, storage })

    expect(storage.removeItem).toHaveBeenCalledWith('freshell.sw.controller-reload')
  })

  it('does not register when disabled', () => {
    const register = vi.fn().mockResolvedValue(undefined)

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { register, addEventListener: vi.fn() },
    })

    registerServiceWorker({ enabled: false })
    expect(register).not.toHaveBeenCalled()
  })
})
