import { describe, it, expect, vi } from 'vitest'
import {
  resolveClientPerfConfig,
  getClientPerfConfig,
  setClientPerfEnabled,
  logClientPerf,
} from '@/lib/perf-logger'

describe('client perf logger config', () => {
  it('defaults to disabled', () => {
    const cfg = resolveClientPerfConfig(undefined)
    expect(cfg.enabled).toBe(false)
  })

  it('enables when flag is set', () => {
    const cfg = resolveClientPerfConfig('true')
    expect(cfg.enabled).toBe(true)
  })

  it('can toggle at runtime', () => {
    const cfg = getClientPerfConfig()
    setClientPerfEnabled(true, 'test')
    expect(cfg.enabled).toBe(true)
    setClientPerfEnabled(false, 'test')
    expect(cfg.enabled).toBe(false)
  })

  it('requires the runtime switch to emit perf logs', () => {
    const cfg = getClientPerfConfig()
    setClientPerfEnabled(false, 'test')
    cfg.enabled = true

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    logClientPerf('perf.test')
    expect(infoSpy).not.toHaveBeenCalled()

    setClientPerfEnabled(true, 'test')
    infoSpy.mockClear()
    logClientPerf('perf.test')
    expect(infoSpy).toHaveBeenCalled()

    infoSpy.mockRestore()
    setClientPerfEnabled(false, 'test')
  })
})
