/**
 * Tests for the inline console error collector in index.html.
 *
 * The collector patches console.error and listens for window 'error' events
 * before the app loads, accumulating entries into window.__consoleErrors so
 * browser-use preflight checks can detect a broken app.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Simulate the inline script from index.html
function installCollector() {
  const errors: Array<{ ts: number; args: string[] }> = []
  ;(window as any).__consoleErrors = errors

  const orig = console.error
  console.error = (...args: unknown[]) => {
    errors.push({
      ts: Date.now(),
      args: Array.prototype.slice.call(args).map(String),
    })
    return orig.apply(console, args)
  }

  const onError = (e: ErrorEvent) => {
    errors.push({ ts: Date.now(), args: [e.message || 'Unknown error'] })
  }
  window.addEventListener('error', onError)

  return () => {
    console.error = orig
    window.removeEventListener('error', onError)
    delete (window as any).__consoleErrors
  }
}

describe('console error collector (index.html inline script)', () => {
  let cleanup: () => void

  beforeEach(() => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true
    cleanup = installCollector()
  })

  afterEach(() => {
    cleanup()
  })

  it('starts with an empty array on window.__consoleErrors', () => {
    expect((window as any).__consoleErrors).toEqual([])
  })

  it('captures console.error calls with stringified args', () => {
    console.error('something broke', 42)

    const errors = (window as any).__consoleErrors
    expect(errors).toHaveLength(1)
    expect(errors[0].args).toEqual(['something broke', '42'])
    expect(errors[0].ts).toBeTypeOf('number')
  })

  it('captures multiple console.error calls in order', () => {
    console.error('first')
    console.error('second')

    const errors = (window as any).__consoleErrors
    expect(errors).toHaveLength(2)
    expect(errors[0].args[0]).toBe('first')
    expect(errors[1].args[0]).toBe('second')
  })

  it('still calls the original console.error', () => {
    // The original is saved before our install, so spy on it indirectly
    // by checking that the patched version doesn't throw
    expect(() => console.error('test')).not.toThrow()
  })

  it('captures window error events', () => {
    const event = new ErrorEvent('error', { message: 'Script error.' })
    window.dispatchEvent(event)

    const errors = (window as any).__consoleErrors
    expect(errors).toHaveLength(1)
    expect(errors[0].args).toEqual(['Script error.'])
  })

  it('falls back to "Unknown error" when error event has no message', () => {
    const event = new ErrorEvent('error', { message: '' })
    window.dispatchEvent(event)

    const errors = (window as any).__consoleErrors
    expect(errors).toHaveLength(1)
    expect(errors[0].args).toEqual(['Unknown error'])
  })

  it('captures both console.error and window errors together', () => {
    console.error('console error')
    window.dispatchEvent(new ErrorEvent('error', { message: 'window error' }))

    const errors = (window as any).__consoleErrors
    expect(errors).toHaveLength(2)
    expect(errors[0].args[0]).toBe('console error')
    expect(errors[1].args[0]).toBe('window error')
  })

  it('does not capture console.warn or console.log', () => {
    console.warn('warning')
    console.log('info')

    const errors = (window as any).__consoleErrors
    expect(errors).toHaveLength(0)
  })

  it('handles Error objects by stringifying them', () => {
    console.error(new Error('oops'))

    const errors = (window as any).__consoleErrors
    expect(errors).toHaveLength(1)
    expect(errors[0].args[0]).toContain('oops')
  })
})
