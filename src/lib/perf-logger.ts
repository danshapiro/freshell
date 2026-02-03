type ClientPerfConfig = {
  enabled: boolean
  longTaskThresholdMs: number
  resourceSlowMs: number
  wsReadySlowMs: number
  wsMessageSlowMs: number
  wsQueueWarnSize: number
  memorySampleMs: number
  rateLimitMs: number
  frameLongMs: number
  apiSlowMs: number
  apiParseSlowMs: number
  reduxActionSlowMs: number
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
    wsReadySlowMs: readNumber(undefined, 500),
    wsMessageSlowMs: readNumber(undefined, 30),
    wsQueueWarnSize: readNumber(undefined, 200),
    memorySampleMs: readNumber(undefined, 10000),
    rateLimitMs: readNumber(undefined, 5000),
    frameLongMs: readNumber(undefined, 200),
    apiSlowMs: readNumber(undefined, 1000),
    apiParseSlowMs: readNumber(undefined, 25),
    reduxActionSlowMs: readNumber(undefined, 32),
  }
}

const perfFlag = typeof __PERF_LOGGING__ !== 'undefined' && __PERF_LOGGING__
  ? __PERF_LOGGING__
  : import.meta.env.VITE_PERF_LOGGING
const perfConfig = resolveClientPerfConfig(perfFlag)
// Perf logging is controlled by the runtime debug switch, not build-time flags.
let perfSwitchEnabled = false
perfConfig.enabled = false
const lastLogByKey = new Map<string, number>()
let perfInitialized = false
let memoryTimer: number | null = null
let inputTrackingInstalled = false
let frameObserverInitialized = false
let lastUserInputAt: number | null = null
let lastLongTaskAt: number | null = null
let longTaskSinceGapLog = 0

export function getClientPerfConfig(): ClientPerfConfig {
  return perfConfig
}

export function isClientPerfLoggingEnabled(): boolean {
  return perfSwitchEnabled
}

export function setClientPerfEnabled(enabled: boolean, source?: string): void {
  if (perfSwitchEnabled === enabled) return
  if (enabled) {
    perfSwitchEnabled = true
    perfConfig.enabled = true
    if (perfInitialized) {
      startMemorySampling()
    } else {
      initClientPerfLogging()
    }
    logClientPerf('perf_logging_toggled', { enabled: true, source })
    return
  }

  // Log before disabling to ensure it is recorded.
  logClientPerf('perf_logging_toggled', { enabled: false, source })
  perfSwitchEnabled = false
  perfConfig.enabled = false
  if (memoryTimer !== null && typeof window !== 'undefined') {
    window.clearInterval(memoryTimer)
    memoryTimer = null
  }
}

function shouldLog(key: string, intervalMs: number): boolean {
  if (!perfSwitchEnabled) return false
  const now = Date.now()
  const last = lastLogByKey.get(key) || 0
  if (now - last < intervalMs) return false
  lastLogByKey.set(key, now)
  return true
}

function toFixedMs(value: number): number {
  return Number(value.toFixed(2))
}

function safeDuration(start: number, end: number): number | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  const delta = end - start
  if (delta < 0) return undefined
  return toFixedMs(delta)
}

function installUserInputTracking() {
  if (inputTrackingInstalled || typeof window === 'undefined') return
  inputTrackingInstalled = true
  const updateLastInput = () => {
    if (typeof performance !== 'undefined') {
      lastUserInputAt = performance.now()
    } else {
      lastUserInputAt = Date.now()
    }
  }
  window.addEventListener('pointerdown', updateLastInput, { capture: true, passive: true })
  window.addEventListener('keydown', updateLastInput, { capture: true, passive: true })
}

function observeFrameGaps() {
  if (frameObserverInitialized || typeof performance === 'undefined') return
  frameObserverInitialized = true
  let lastFrame = performance.now()

  const tick = (now: number) => {
    if (document.visibilityState !== 'visible') {
      lastFrame = now
      requestAnimationFrame(tick)
      return
    }

    const gapMs = now - lastFrame
    if (gapMs >= perfConfig.frameLongMs && shouldLog('perf.frame_gap', perfConfig.rateLimitMs)) {
      const sinceInputMs = lastUserInputAt !== null ? toFixedMs(now - lastUserInputAt) : undefined
      const sinceLongTaskMs = lastLongTaskAt !== null ? toFixedMs(now - lastLongTaskAt) : undefined
      logClientPerf(
        'perf.frame_gap',
        {
          gapMs: toFixedMs(gapMs),
          sinceLastInputMs: sinceInputMs,
          sinceLastLongTaskMs: sinceLongTaskMs,
          longTasksSinceLastGap: longTaskSinceGapLog,
          visibilityState: document.visibilityState,
        },
        'warn',
      )
      longTaskSinceGapLog = 0
    }

    lastFrame = now
    requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)
}

export function logClientPerf(
  event: string,
  context: Record<string, unknown> = {},
  level: 'debug' | 'info' | 'warn' | 'error' = 'info',
) {
  if (!perfSwitchEnabled) return
  const payload = { event, perf: true, ...context }
  if (level === 'error') console.error(payload)
  else if (level === 'warn') console.warn(payload)
  else if (level === 'debug') console.debug(payload)
  else console.info(payload)
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
        lastLongTaskAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
        longTaskSinceGapLog += 1
        const anyEntry = entry as any
        const attribution = Array.isArray(anyEntry.attribution)
          ? anyEntry.attribution.slice(0, 3).map((item: any) => ({
            name: item?.name,
            entryType: item?.entryType,
            containerType: item?.containerType,
            containerId: item?.containerId,
            containerName: item?.containerName,
            scriptURL: item?.scriptURL,
            lineNumber: item?.lineNumber,
            columnNumber: item?.columnNumber,
          }))
          : undefined
        logClientPerf('perf.longtask', {
          name: entry.name,
          startTime: toFixedMs(entry.startTime),
          durationMs: toFixedMs(entry.duration),
          attributionCount: Array.isArray(anyEntry.attribution) ? anyEntry.attribution.length : undefined,
          attribution,
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
        if (entry.duration < perfConfig.resourceSlowMs) continue
        const queueMs = safeDuration(entry.startTime, entry.requestStart)
        const ttfbMs = safeDuration(entry.requestStart, entry.responseStart)
        const downloadMs = safeDuration(entry.responseStart, entry.responseEnd)
        const dnsMs = safeDuration(entry.domainLookupStart, entry.domainLookupEnd)
        const connectMs = safeDuration(entry.connectStart, entry.connectEnd)
        const tlsMs = entry.secureConnectionStart
          ? safeDuration(entry.secureConnectionStart, entry.connectEnd)
          : undefined
        const responseStatus = (entry as any).responseStatus as number | undefined
        logClientPerf('perf.resource_slow', {
          name: entry.name,
          initiatorType: entry.initiatorType,
          durationMs: toFixedMs(entry.duration),
          startTime: toFixedMs(entry.startTime),
          fetchStart: toFixedMs(entry.fetchStart),
          requestStart: toFixedMs(entry.requestStart),
          responseStart: toFixedMs(entry.responseStart),
          responseEnd: toFixedMs(entry.responseEnd),
          queueMs,
          dnsMs,
          connectMs,
          tlsMs,
          ttfbMs,
          downloadMs,
          nextHopProtocol: entry.nextHopProtocol || undefined,
          responseStatus: typeof responseStatus === 'number' && responseStatus > 0 ? responseStatus : undefined,
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
  if (!perfSwitchEnabled || perfInitialized) return
  if (typeof window === 'undefined' || typeof performance === 'undefined') return
  perfInitialized = true

  logClientPerf('perf_logging_enabled', { config: perfConfig })

  installUserInputTracking()

  if (document.readyState === 'complete') {
    logNavigationTiming()
  } else {
    window.addEventListener('load', () => logNavigationTiming(), { once: true })
  }

  observeLongTasks()
  observeResources()
  observePaint()
  observeFrameGaps()
  startMemorySampling()
}
