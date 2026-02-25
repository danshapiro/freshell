type ClientPerfConfig = {
  enabled: boolean
  longTaskThresholdMs: number
  resourceSlowMs: number
  apiSlowMs: number
  apiParseSlowMs: number
  reduxActionSlowMs: number
  wsReadySlowMs: number
  wsMessageSlowMs: number
  wsQueueWarnSize: number
  memorySampleMs: number
  rateLimitMs: number
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function readNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function resolveClientPerfConfig(flag?: string): ClientPerfConfig {
  return {
    enabled: parseBoolean(flag),
    longTaskThresholdMs: readNumber(undefined, 50),
    resourceSlowMs: readNumber(undefined, 1000),
    apiSlowMs: readNumber(undefined, 1000),
    apiParseSlowMs: readNumber(undefined, 100),
    reduxActionSlowMs: readNumber(undefined, 50),
    wsReadySlowMs: readNumber(undefined, 500),
    wsMessageSlowMs: readNumber(undefined, 30),
    wsQueueWarnSize: readNumber(undefined, 200),
    memorySampleMs: readNumber(undefined, 10000),
    rateLimitMs: readNumber(undefined, 5000),
  }
}

const perfFlag = typeof __PERF_LOGGING__ !== 'undefined' && __PERF_LOGGING__
  ? __PERF_LOGGING__
  : import.meta.env.VITE_PERF_LOGGING
const perfConfig = resolveClientPerfConfig(perfFlag)
const lastLogByKey = new Map<string, number>()
const terminalInputSentAtById = new Map<string, number>()
const terminalInputToOutputSamplesMs: number[] = []
let perfInitialized = false
let memoryTimer: number | null = null
const MAX_TERMINAL_INPUT_TO_OUTPUT_SAMPLES = 200

export function getClientPerfConfig(): ClientPerfConfig {
  return perfConfig
}

export function isClientPerfLoggingEnabled(): boolean {
  return perfConfig.enabled
}

export function setClientPerfEnabled(enabled: boolean, source?: string): void {
  if (perfConfig.enabled === enabled) return
  if (enabled) {
    perfConfig.enabled = true
    initClientPerfLogging()
    logClientPerf('perf_logging_toggled', { enabled: true, source })
    return
  }

  // Log before disabling to ensure it is recorded.
  logClientPerf('perf_logging_toggled', { enabled: false, source })
  perfConfig.enabled = false
  terminalInputSentAtById.clear()
  terminalInputToOutputSamplesMs.length = 0
  if (memoryTimer !== null && typeof window !== 'undefined') {
    window.clearInterval(memoryTimer)
    memoryTimer = null
  }
}

function shouldLog(key: string, intervalMs: number): boolean {
  if (!perfConfig.enabled) return false
  const now = Date.now()
  const last = lastLogByKey.get(key) || 0
  if (now - last < intervalMs) return false
  lastLogByKey.set(key, now)
  return true
}

export function logClientPerf(
  event: string,
  context: Record<string, unknown> = {},
  level: 'debug' | 'info' | 'warn' | 'error' = 'info',
) {
  if (!perfConfig.enabled) return
  const payload = { event, perf: true, ...context }
  if (level === 'error') console.error(payload)
  else if (level === 'warn') console.warn(payload)
  else if (level === 'debug') console.debug(payload)
  else console.info(payload)
}

function perfNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function percentile(samples: number[], ratio: number): number {
  if (samples.length === 0) return 0
  const clamped = Math.min(Math.max(ratio, 0), 1)
  const index = Math.min(samples.length - 1, Math.floor(clamped * (samples.length - 1)))
  return samples[index] || 0
}

export function markTerminalInputSent(terminalId: string, atMs = perfNowMs()): void {
  if (!perfConfig.enabled) return
  if (!terminalId) return
  terminalInputSentAtById.set(terminalId, atMs)
}

export function markTerminalOutputSeen(terminalId: string, atMs = perfNowMs()): void {
  if (!perfConfig.enabled) return
  if (!terminalId) return

  const inputAt = terminalInputSentAtById.get(terminalId)
  if (inputAt === undefined) return
  terminalInputSentAtById.delete(terminalId)

  const latencyMs = Math.max(0, atMs - inputAt)
  terminalInputToOutputSamplesMs.push(latencyMs)
  if (terminalInputToOutputSamplesMs.length > MAX_TERMINAL_INPUT_TO_OUTPUT_SAMPLES) {
    terminalInputToOutputSamplesMs.shift()
  }

  if (!shouldLog('perf.terminal_input_to_output', perfConfig.rateLimitMs)) return

  const sorted = [...terminalInputToOutputSamplesMs].sort((a, b) => a - b)
  logClientPerf('perf.terminal_input_to_output', {
    latencyMs: Number(latencyMs.toFixed(2)),
    sampleCount: sorted.length,
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p90Ms: Number(percentile(sorted, 0.9).toFixed(2)),
    p99Ms: Number(percentile(sorted, 0.99).toFixed(2)),
  })
}

function logNavigationTiming() {
  const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
  if (!entries || entries.length === 0) return
  const nav = entries[0]
  logClientPerf('perf.navigation', {
    type: nav.type,
    startTime: Number(nav.startTime.toFixed(2)),
    ttfbMs: Number((nav.responseStart - nav.requestStart).toFixed(2)),
    responseMs: Number((nav.responseEnd - nav.responseStart).toFixed(2)),
    domContentLoadedMs: Number((nav.domContentLoadedEventEnd - nav.startTime).toFixed(2)),
    loadMs: Number((nav.loadEventEnd - nav.startTime).toFixed(2)),
    transferSize: nav.transferSize,
    encodedBodySize: nav.encodedBodySize,
    decodedBodySize: nav.decodedBodySize,
  })
}

function observeLongTasks() {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < perfConfig.longTaskThresholdMs) continue
        logClientPerf('perf.longtask', {
          name: entry.name,
          startTime: Number(entry.startTime.toFixed(2)),
          durationMs: Number(entry.duration.toFixed(2)),
        }, 'warn')
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // ignore
  }
}

function observeResources() {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        if (entry.name.includes('/api/logs/client')) continue
        if (entry.duration < perfConfig.resourceSlowMs) continue
        logClientPerf('perf.resource_slow', {
          name: entry.name,
          initiatorType: entry.initiatorType,
          durationMs: Number(entry.duration.toFixed(2)),
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
        }, 'warn')
      }
    })
    observer.observe({ entryTypes: ['resource'] })
  } catch {
    // ignore
  }
}

function observePaint() {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        logClientPerf('perf.paint', {
          name: entry.name,
          startTime: Number(entry.startTime.toFixed(2)),
        })
      }
    })
    observer.observe({ entryTypes: ['paint'] })
  } catch {
    // ignore
  }
}

function startMemorySampling() {
  const perfAny = performance as any
  if (!perfAny?.memory) return
  if (memoryTimer !== null) {
    window.clearInterval(memoryTimer)
    memoryTimer = null
  }

  memoryTimer = window.setInterval(() => {
    if (!shouldLog('perf.memory', perfConfig.rateLimitMs)) return
    const memory = perfAny.memory
    logClientPerf('perf.memory', {
      usedJsHeapSize: memory.usedJSHeapSize,
      totalJsHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
    })
  }, perfConfig.memorySampleMs)
}

export function initClientPerfLogging(): void {
  if (!perfConfig.enabled || perfInitialized) return
  if (typeof window === 'undefined' || typeof performance === 'undefined') return
  perfInitialized = true

  logClientPerf('perf_logging_enabled', { config: perfConfig })

  if (document.readyState === 'complete') {
    logNavigationTiming()
  } else {
    window.addEventListener('load', () => logNavigationTiming(), { once: true })
  }

  observeLongTasks()
  observeResources()
  observePaint()
  startMemorySampling()
}
