import { monitorEventLoopDelay, performance } from 'perf_hooks'
import { logger } from './logger.js'

export type PerfConfig = {
  enabled: boolean
  httpSlowMs: number
  wsSlowMs: number
  wsBackpressureBytes: number
  terminalSampleMs: number
  processSampleMs: number
  eventLoopResolutionMs: number
  slowSessionRefreshMs: number
  slowAiSummaryMs: number
  slowTerminalCreateMs: number
  rateLimitMs: number
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function readNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function resolvePerfConfig(env: NodeJS.ProcessEnv = process.env): PerfConfig {
  return {
    enabled: parseBoolean(env.PERF_LOGGING) || parseBoolean(env.PERF_DEBUG),
    httpSlowMs: readNumber(env, 'PERF_HTTP_SLOW_MS', 500),
    wsSlowMs: readNumber(env, 'PERF_WS_SLOW_MS', 50),
    wsBackpressureBytes: readNumber(env, 'PERF_WS_BACKPRESSURE_BYTES', 2 * 1024 * 1024),
    terminalSampleMs: readNumber(env, 'PERF_TERMINAL_SAMPLE_MS', 5000),
    processSampleMs: readNumber(env, 'PERF_PROCESS_SAMPLE_MS', 10000),
    eventLoopResolutionMs: readNumber(env, 'PERF_EVENT_LOOP_RESOLUTION_MS', 20),
    slowSessionRefreshMs: readNumber(env, 'PERF_SESSION_REFRESH_SLOW_MS', 500),
    slowAiSummaryMs: readNumber(env, 'PERF_AI_SUMMARY_SLOW_MS', 750),
    slowTerminalCreateMs: readNumber(env, 'PERF_TERMINAL_CREATE_SLOW_MS', 200),
    rateLimitMs: readNumber(env, 'PERF_RATE_LIMIT_MS', 5000),
  }
}

const perfConfig = resolvePerfConfig()
const perfLogger = logger.child({ component: 'perf' })
const lastLogByKey = new Map<string, number>()
let perfInitialized = false
let perfTimer: NodeJS.Timeout | null = null
let eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null
let lastCpu: NodeJS.CpuUsage | null = null
let lastUptime = 0

export function getPerfConfig(): PerfConfig {
  return perfConfig
}

export function isPerfLoggingEnabled(): boolean {
  return perfConfig.enabled
}

export function setPerfLoggingEnabled(enabled: boolean, source?: string): void {
  if (perfConfig.enabled === enabled) return
  perfConfig.enabled = enabled

  if (enabled) {
    initPerfLogging()
    perfLogger.debug({ event: 'perf_logging_toggled', enabled: true, source }, 'Perf logging toggled')
    return
  }

  if (perfTimer) {
    clearInterval(perfTimer)
    perfTimer = null
  }
  if (eventLoopHistogram) {
    eventLoopHistogram.disable()
    eventLoopHistogram = null
  }
  lastCpu = null
  lastUptime = 0
  perfInitialized = false
  perfLogger.debug({ event: 'perf_logging_toggled', enabled: false, source }, 'Perf logging toggled')
}

export function shouldLog(key: string, intervalMs: number): boolean {
  if (!perfConfig.enabled) return false
  const now = Date.now()
  const last = lastLogByKey.get(key) || 0
  if (now - last < intervalMs) return false
  lastLogByKey.set(key, now)
  return true
}

function toMs(ns: number): number {
  return Number((ns / 1e6).toFixed(2))
}

type PerfSeverity = 'debug' | 'info' | 'warn' | 'error'

function withPerfSeverity(level: PerfSeverity, payload: Record<string, unknown>) {
  if ((level === 'warn' || level === 'error') && payload.perfSeverity === undefined) {
    return { ...payload, perfSeverity: level }
  }
  return payload
}

export function logPerfEvent(
  event: string,
  context: Record<string, unknown>,
  level: PerfSeverity = 'info',
) {
  if (!perfConfig.enabled) return
  perfLogger.debug(withPerfSeverity(level, { event, ...context }), 'Perf event')
}

export function startPerfTimer(
  event: string,
  context: Record<string, unknown> = {},
  options: { minDurationMs?: number; level?: PerfSeverity } = {},
) {
  if (!perfConfig.enabled) return () => {}
  const start = performance.now()
  return (extra: Record<string, unknown> = {}) => {
    const durationMs = performance.now() - start
    if (options.minDurationMs && durationMs < options.minDurationMs) return
    const payload = withPerfSeverity(options.level || 'info', {
      event,
      durationMs: Number(durationMs.toFixed(2)),
      ...context,
      ...extra,
    })
    perfLogger.debug(payload, 'Perf timing')
  }
}

export async function withPerfSpan<T>(
  event: string,
  fn: () => Promise<T>,
  context: Record<string, unknown> = {},
  options: { minDurationMs?: number; level?: PerfSeverity } = {},
): Promise<T> {
  if (!perfConfig.enabled) return await fn()
  const end = startPerfTimer(event, context, options)
  try {
    return await fn()
  } finally {
    end()
  }
}

export function initPerfLogging(): void {
  if (!perfConfig.enabled || perfInitialized) return
  perfInitialized = true

  perfLogger.debug({ event: 'perf_logging_enabled', config: perfConfig }, 'Perf logging enabled')

  eventLoopHistogram = monitorEventLoopDelay({ resolution: perfConfig.eventLoopResolutionMs })
  eventLoopHistogram.enable()

  lastCpu = process.cpuUsage()
  lastUptime = process.uptime()

  perfTimer = setInterval(() => {
    if (!eventLoopHistogram || !lastCpu) return
    const cpuDelta = process.cpuUsage(lastCpu)
    lastCpu = process.cpuUsage()
    const uptime = process.uptime()
    const uptimeDelta = uptime - lastUptime
    lastUptime = uptime

    const mem = process.memoryUsage()
    const eventLoop = {
      minMs: toMs(eventLoopHistogram.min),
      maxMs: toMs(eventLoopHistogram.max),
      meanMs: toMs(eventLoopHistogram.mean),
      p50Ms: toMs(eventLoopHistogram.percentile(50)),
      p90Ms: toMs(eventLoopHistogram.percentile(90)),
      p99Ms: toMs(eventLoopHistogram.percentile(99)),
    }

    perfLogger.debug(
      {
        event: 'perf_system',
        uptimeSec: Number(uptime.toFixed(1)),
        intervalSec: Number(uptimeDelta.toFixed(1)),
        cpuUserMs: Number((cpuDelta.user / 1000).toFixed(1)),
        cpuSystemMs: Number((cpuDelta.system / 1000).toFixed(1)),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
        eventLoop,
      },
      'Perf system sample',
    )

    eventLoopHistogram.reset()
  }, perfConfig.processSampleMs)

  perfTimer.unref?.()
}
