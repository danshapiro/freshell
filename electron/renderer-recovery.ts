import type { ElectronMainLogEntry, ElectronMainLogger } from './main-process-logger.js'

export interface RecoverableBrowserWindow {
  loadURL(url: string): Promise<void>
  show(): void
  focus(): void
  isDestroyed?: () => boolean
  webContents?: RecoverableWebContents
}

export interface RecoverableWebContents {
  readonly id?: number
  on(event: string, callback: (...args: any[]) => void): void
  removeListener?(event: string, callback: (...args: any[]) => void): void
  getURL?: () => string
  isDestroyed?: () => boolean
  reload?: () => void | Promise<void>
  forcefullyCrashRenderer?: () => void
}

interface RendererRecoveryTimer {
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
}

export interface RendererRecoveryOptions extends RendererRecoveryTimer {
  window: RecoverableBrowserWindow
  loadUrl: string
  serverUrl: string
  logger: ElectronMainLogger
  verifyRecovered?: () => Promise<void>
}

type RecoveryTrigger =
  | 'render-process-gone'
  | 'did-fail-load'
  | 'unresponsive'

type RecoveryMode = 'reload' | 'load-url'

interface RecoveryRequest {
  trigger: RecoveryTrigger
  mode: RecoveryMode
  crashBeforeReload?: boolean
  metadata?: Record<string, unknown>
}

interface RecoveryAttempt {
  request: RecoveryRequest
  failureObserved: boolean
  retryCancelled: boolean
}

const CIRCUIT_WINDOW_MS = 60_000
const MAX_ATTEMPTS_PER_WINDOW = 3
const RETRY_DELAYS_MS = [250, 1000, 3000] as const
const UNRESPONSIVE_THRESHOLD_MS = 15_000
const ABORTED_NAVIGATION_ERROR_CODE = -3
const TRIGGER_PRIORITY: Record<RecoveryTrigger, number> = {
  unresponsive: 0,
  'render-process-gone': 1,
  'did-fail-load': 2,
}

function isWindowDestroyed(window: RecoverableBrowserWindow): boolean {
  return window.isDestroyed?.() ?? false
}

function isWebContentsDestroyed(webContents: RecoverableWebContents | undefined): boolean {
  return webContents?.isDestroyed?.() ?? false
}

export function registerRendererRecovery(options: RendererRecoveryOptions): () => void {
  const {
    window,
    loadUrl,
    serverUrl,
    logger,
    setTimeout: scheduleTimeout,
    clearTimeout,
  } = options

  const verifyRecovered = options.verifyRecovered ?? (async () => {})
  let disposed = false
  let activeRecovery: RecoveryAttempt | undefined
  let expectedRendererGone = false
  let consecutiveFailures = 0
  let unresponsiveTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let scheduledRecoveryTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let pendingRequest: RecoveryRequest | undefined
  let attemptTimestamps: number[] = []
  const listeners: Array<[string, (...args: any[]) => void]> = []

  const webContents = window.webContents
  if (!webContents) {
    return () => {}
  }

  const clearUnresponsiveTimer = () => {
    if (unresponsiveTimer === undefined) {
      return
    }

    clearTimeout(unresponsiveTimer)
    unresponsiveTimer = undefined
  }

  const clearScheduledRecoveryTimer = () => {
    if (scheduledRecoveryTimer === undefined) {
      return
    }

    clearTimeout(scheduledRecoveryTimer)
    scheduledRecoveryTimer = undefined
  }

  const pruneAttempts = (now: number) => {
    attemptTimestamps = attemptTimestamps.filter((timestamp) => now - timestamp < CIRCUIT_WINDOW_MS)
  }

  const logWithContext = (entry: ElectronMainLogEntry) => {
    logger.log({
      serverUrl,
      loadUrl,
      currentUrl: isWebContentsDestroyed(webContents) ? undefined : webContents.getURL?.(),
      ...entry,
    })
  }

  const dispose = () => {
    if (disposed) {
      return
    }

    disposed = true
    clearUnresponsiveTimer()
    clearScheduledRecoveryTimer()
    pendingRequest = undefined
    activeRecovery = undefined
    expectedRendererGone = false
    for (const [event, listener] of listeners) {
      webContents.removeListener?.(event, listener)
    }
    logWithContext({
      severity: 'info',
      event: 'main_window_recovery_cancelled',
      reason: 'disposed',
    })
  }

  const isLive = () => {
    if (disposed) {
      return false
    }
    if (isWindowDestroyed(window)) {
      dispose()
    }
    return !disposed
  }

  const isCurrent = (attempt: RecoveryAttempt) => isLive() && activeRecovery === attempt

  const listen = (event: string, callback: (...args: any[]) => void) => {
    const listener = (...args: any[]) => {
      if (isLive()) {
        callback(...args)
      }
    }
    listeners.push([event, listener])
    webContents.on(event, listener)
  }

  const merge = (request: RecoveryRequest) => {
    if (!pendingRequest || TRIGGER_PRIORITY[request.trigger] > TRIGGER_PRIORITY[pendingRequest.trigger]) {
      pendingRequest = request
    }
  }

  const runRecoveryAction = async (request: RecoveryRequest) => {
    if (request.mode === 'load-url') {
      await window.loadURL(loadUrl)
      return
    }

    if (request.crashBeforeReload && webContents.forcefullyCrashRenderer) {
      expectedRendererGone = true
      webContents.forcefullyCrashRenderer()
    }

    if (!webContents.reload || isWebContentsDestroyed(webContents)) {
      logWithContext({
        severity: 'warn',
        event: 'main_window_recovery_reload_unavailable',
        trigger: request.trigger,
      })
      await window.loadURL(loadUrl)
      return
    }

    await webContents.reload()
  }

  const startRecovery = (request: RecoveryRequest) => {
    const recovery: RecoveryAttempt = { request, failureObserved: false, retryCancelled: false }
    activeRecovery = recovery
    const startedAt = Date.now()
    attemptTimestamps.push(startedAt)
    const attempt = attemptTimestamps.length
    const context = {
      attempt,
      trigger: request.trigger,
      mode: request.mode,
      ...(request.metadata ?? {}),
    }

    logWithContext({
      severity: 'warn',
      event: 'main_window_recovery_started',
      ...context,
    })

    void (async () => {
      try {
        await runRecoveryAction(request)
        if (!isCurrent(recovery)) return
        await verifyRecovered()
        if (!isCurrent(recovery)) return
        if (recovery.failureObserved || pendingRequest) throw new Error('renderer failed during recovery')

        window.show()
        if (!isCurrent(recovery)) return
        window.focus()
        if (!isCurrent(recovery)) return

        consecutiveFailures = 0
        logWithContext({
          severity: 'info',
          event: 'main_window_recovery_succeeded',
          ...context,
        })
      } catch (error) {
        if (!isCurrent(recovery)) return
        consecutiveFailures += 1
        if (!recovery.retryCancelled) {
          merge(request)
        }
        logWithContext({
          severity: 'error',
          event: 'main_window_recovery_failed',
          ...context,
          error,
        })
      } finally {
        if (activeRecovery === recovery) {
          expectedRendererGone = false
          activeRecovery = undefined
          drain()
        }
      }
    })()
  }

  const startIfCapacity = (backoffMs = 0) => {
    if (!isLive() || activeRecovery || !pendingRequest) {
      return
    }

    const now = Date.now()
    pruneAttempts(now)
    let retryInMs = backoffMs
    if (attemptTimestamps.length >= MAX_ATTEMPTS_PER_WINDOW) {
      const cooldownMs = attemptTimestamps[0] + CIRCUIT_WINDOW_MS - now
      retryInMs = Math.max(retryInMs, cooldownMs)
      logWithContext({
        severity: 'error',
        event: 'main_window_recovery_circuit_open',
        trigger: pendingRequest.trigger,
        attemptsInWindow: attemptTimestamps.length,
        windowMs: CIRCUIT_WINDOW_MS,
        retryInMs,
        ...(pendingRequest.metadata ?? {}),
      })
    }

    if (retryInMs > 0) {
      scheduledRecoveryTimer = scheduleTimeout(() => {
        scheduledRecoveryTimer = undefined
        // The backoff has elapsed; recheck the rolling limit without adding it again.
        startIfCapacity()
      }, retryInMs)
      logWithContext({
        severity: 'info',
        event: 'main_window_recovery_scheduled',
        trigger: pendingRequest.trigger,
        mode: pendingRequest.mode,
        retryInMs,
      })
      return
    }

    const request = pendingRequest
    pendingRequest = undefined
    startRecovery(request)
  }

  const drain = () => {
    if (!isLive() || activeRecovery || scheduledRecoveryTimer !== undefined || !pendingRequest) {
      return
    }
    const backoffMs = consecutiveFailures > 0
      ? RETRY_DELAYS_MS[Math.min(consecutiveFailures - 1, RETRY_DELAYS_MS.length - 1)]
      : 0
    startIfCapacity(backoffMs)
  }

  const requestRecovery = (request: RecoveryRequest) => {
    merge(request)
    if (activeRecovery || scheduledRecoveryTimer !== undefined) {
      if (activeRecovery && request.trigger !== 'unresponsive') {
        activeRecovery.failureObserved = true
      }
      logWithContext({
        severity: 'info',
        event: 'main_window_recovery_skipped',
        reason: activeRecovery ? 'recovery-in-flight' : 'recovery-already-scheduled',
        trigger: request.trigger,
        ...(request.metadata ?? {}),
      })
    }
    drain()
  }

  listen('render-process-gone', (_event, details: { reason?: string; exitCode?: number } = {}) => {
    const metadata = {
      reason: details.reason ?? 'unknown',
      exitCode: details.exitCode,
      willRecover: !expectedRendererGone,
    }
    expectedRendererGone = false

    logWithContext({
      severity: 'warn',
      event: 'main_window_renderer_gone',
      ...metadata,
    })

    if (!metadata.willRecover) return
    requestRecovery({
      trigger: 'render-process-gone',
      mode: 'reload',
      metadata,
    })
  })

  listen(
    'did-fail-load',
    (
      _event,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      const willRecover = isMainFrame && errorCode !== ABORTED_NAVIGATION_ERROR_CODE
      const metadata = {
        errorCode,
        errorDescription,
        validatedUrl,
        isMainFrame,
        willRecover,
      }

      logWithContext({
        severity: willRecover ? 'warn' : 'info',
        event: 'main_window_navigation_failed',
        ...metadata,
      })

      if (!willRecover) {
        return
      }

      requestRecovery({
        trigger: 'did-fail-load',
        mode: 'load-url',
        metadata,
      })
    },
  )

  listen('unresponsive', () => {
    clearUnresponsiveTimer()
    logWithContext({
      severity: 'warn',
      event: 'main_window_unresponsive',
      willRecover: true,
    })

    unresponsiveTimer = scheduleTimeout(() => {
      unresponsiveTimer = undefined
      requestRecovery({
        trigger: 'unresponsive',
        mode: 'reload',
        crashBeforeReload: true,
      })
    }, UNRESPONSIVE_THRESHOLD_MS)
  })

  listen('responsive', () => {
    clearUnresponsiveTimer()
    if (activeRecovery?.request.trigger === 'unresponsive') {
      activeRecovery.retryCancelled = true
    }
    if (pendingRequest?.trigger === 'unresponsive') {
      clearScheduledRecoveryTimer()
      pendingRequest = undefined
      logWithContext({
        severity: 'info',
        event: 'main_window_recovery_cancelled',
        trigger: 'unresponsive',
        reason: 'renderer-responsive',
      })
    }
    logWithContext({
      severity: 'info',
      event: 'main_window_responsive',
    })
  })

  return dispose
}
