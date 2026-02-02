import { describe, it, expect, vi, beforeEach } from 'vitest'
const mockState = vi.hoisted(() => {
  const debugEntries: Record<string, unknown>[] = []
  const perfLogger = {
    debug: vi.fn((payload: Record<string, unknown>) => debugEntries.push(payload)),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const logger = {
    child: vi.fn(() => perfLogger),
  }
  return { debugEntries, perfLogger, logger }
})

vi.mock('../../../server/logger', () => ({ logger: mockState.logger }))

import {
  resolvePerfConfig,
  setPerfLoggingEnabled,
  isPerfLoggingEnabled,
  getPerfConfig,
  logPerfEvent,
  startPerfTimer,
} from '../../../server/perf-logger'

const { debugEntries, perfLogger } = mockState

beforeEach(() => {
  debugEntries.length = 0
  perfLogger.debug.mockClear()
  perfLogger.info.mockClear()
  perfLogger.warn.mockClear()
  perfLogger.error.mockClear()
  getPerfConfig().enabled = false
})

describe('perf logger config', () => {
  it('defaults to disabled with standard thresholds', () => {
    const cfg = resolvePerfConfig({} as NodeJS.ProcessEnv)
    expect(cfg.enabled).toBe(false)
    expect(cfg.httpSlowMs).toBe(500)
    expect(cfg.wsSlowMs).toBe(50)
  })

  it('enables with PERF_LOGGING or PERF_DEBUG', () => {
    const enabled = resolvePerfConfig({ PERF_LOGGING: '1' } as NodeJS.ProcessEnv)
    expect(enabled.enabled).toBe(true)

    const enabledAlt = resolvePerfConfig({ PERF_DEBUG: 'true' } as NodeJS.ProcessEnv)
    expect(enabledAlt.enabled).toBe(true)
  })

  it('accepts numeric overrides with fallbacks', () => {
    const cfg = resolvePerfConfig({
      PERF_HTTP_SLOW_MS: '250',
      PERF_WS_SLOW_MS: '75',
      PERF_TERMINAL_SAMPLE_MS: '2000',
    } as NodeJS.ProcessEnv)
    expect(cfg.httpSlowMs).toBe(250)
    expect(cfg.wsSlowMs).toBe(75)
    expect(cfg.terminalSampleMs).toBe(2000)

    const fallback = resolvePerfConfig({ PERF_HTTP_SLOW_MS: 'nope' } as NodeJS.ProcessEnv)
    expect(fallback.httpSlowMs).toBe(500)
  })

  it('can toggle at runtime', () => {
    setPerfLoggingEnabled(true, 'test')
    expect(isPerfLoggingEnabled()).toBe(true)
    setPerfLoggingEnabled(false, 'test')
    expect(isPerfLoggingEnabled()).toBe(false)
  })

  it('logs perf events as debug with perfSeverity for warn', () => {
    getPerfConfig().enabled = true
    logPerfEvent('http_request_slow', { statusCode: 500 }, 'warn')
    expect(perfLogger.debug).toHaveBeenCalledTimes(1)
    expect(debugEntries[0].perfSeverity).toBe('warn')
    expect(perfLogger.warn).not.toHaveBeenCalled()
  })

  it('logs perf timing as debug with perfSeverity when configured', () => {
    getPerfConfig().enabled = true
    const end = startPerfTimer('session_refresh', { step: 'start' }, { minDurationMs: 0, level: 'warn' })
    end()
    expect(perfLogger.debug).toHaveBeenCalledTimes(1)
    expect(debugEntries[0].event).toBe('session_refresh')
    expect(debugEntries[0].perfSeverity).toBe('warn')
    expect(typeof debugEntries[0].durationMs).toBe('number')
  })
})
