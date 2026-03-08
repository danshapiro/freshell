import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// Provide a minimal ResizeObserver stub for jsdom environments
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe = vi.fn()
    disconnect = vi.fn()
    unobserve = vi.fn()
    constructor(_cb: ResizeObserverCallback) {}
  } as unknown as typeof globalThis.ResizeObserver
}
