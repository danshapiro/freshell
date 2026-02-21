import { describe, it, expect, vi } from 'vitest'

async function loadPerfLoggerModule() {
  vi.resetModules()
  return import('@/lib/perf-logger')
}

describe('client perf logger config', () => {
  it('defaults to disabled', async () => {
    const { resolveClientPerfConfig } = await loadPerfLoggerModule()
    const cfg = resolveClientPerfConfig(undefined)
    expect(cfg.enabled).toBe(false)
  })

  it('enables when flag is set', async () => {
    const { resolveClientPerfConfig } = await loadPerfLoggerModule()
    const cfg = resolveClientPerfConfig('true')
    expect(cfg.enabled).toBe(true)
  })

  it('can toggle at runtime', async () => {
    const { getClientPerfConfig, setClientPerfEnabled } = await loadPerfLoggerModule()
    const cfg = getClientPerfConfig()
    setClientPerfEnabled(true, 'test')
    expect(cfg.enabled).toBe(true)
    setClientPerfEnabled(false, 'test')
    expect(cfg.enabled).toBe(false)
  })

  it('ignores /api/logs/client resource entries in perf.resource_slow warnings', async () => {
    const { setClientPerfEnabled } = await loadPerfLoggerModule()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalObserver = (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver
    const resourceCallbacks: Array<(entries: PerformanceResourceTiming[]) => void> = []

    class MockPerformanceObserver {
      private callback: (list: { getEntries: () => PerformanceEntry[] }) => void

      constructor(callback: (list: { getEntries: () => PerformanceEntry[] }) => void) {
        this.callback = callback
      }

      observe(options: { entryTypes?: string[] }) {
        if (options.entryTypes?.includes('resource')) {
          resourceCallbacks.push((entries) => {
            this.callback({
              getEntries: () => entries as unknown as PerformanceEntry[],
            })
          })
        }
      }
    }

    ;(globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = MockPerformanceObserver as unknown
    setClientPerfEnabled(true, 'test')
    expect(resourceCallbacks).toHaveLength(1)

    resourceCallbacks[0]([
      {
        name: 'http://localhost:3001/api/logs/client',
        initiatorType: 'fetch',
        duration: 1900,
        transferSize: 0,
        encodedBodySize: 0,
        decodedBodySize: 0,
      } as PerformanceResourceTiming,
      {
        name: 'http://localhost:3001/api/sessions',
        initiatorType: 'fetch',
        duration: 2100,
        transferSize: 0,
        encodedBodySize: 0,
        decodedBodySize: 0,
      } as PerformanceResourceTiming,
    ])

    const resourceWarnPayloads = warnSpy.mock.calls
      .map((call) => call[0] as { event?: string; name?: string })
      .filter((payload) => payload?.event === 'perf.resource_slow')
    expect(resourceWarnPayloads).toHaveLength(1)
    expect(resourceWarnPayloads[0].name).toContain('/api/sessions')

    setClientPerfEnabled(false, 'test')
    ;(globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = originalObserver
    warnSpy.mockRestore()
  })
})
