import type { ElectronMainLogger } from './main-process-logger.js'

export interface RecoverableBrowserWindow {
  loadURL(url: string): Promise<void>
  show(): void
  focus(): void
  isDestroyed?: () => boolean
  webContents?: RecoverableWebContents
}

export interface RecoverableWebContents {
  on(event: string, callback: (...args: any[]) => void): void
  getURL?: () => string
  isDestroyed?: () => boolean
  reload?: () => void
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

const CIRCUIT_WINDOW_MS = 60_000
const MAX_ATTEMPTS_PER_WINDOW = 3
const RETRY_DELAYS_MS = [250, 1000, 3000] as const
const UNRESPONSIVE_THRESHOLD_MS = 15_000
const ABORTED_NAVIGATION_ERROR_CODE = -3

function isWindowDestroyed(window: RecoverableBrowserWindow): boolean {
  return window.isDestroyed?.() ?? false
}

function isWebContentsDestroyed(webContents: RecoverableWebContents | undefined): boolean {
  return webContents?.isDestroyed?.() ?? false
}

export function registerRendererRecovery(options: RendererRecoveryOptions): void {
  const {
    window,
    loadUrl,
    serverUrl,
    logger,
    setTimeout: scheduleTimeout,
    clearTimeout,
  } = options

  const verifyRecovered = options.verifyRecovered ?? (async () => {})
  let recoveryInFlight = false
  let consecutiveFailures = 0
  let unresponsiveTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let scheduledRecoveryTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let attemptTimestamps: number[] = []

  const webContents = window.webContents
  if (!webContents) {
    return
  }

  const clearUnresponsiveTimer = () => {
    if (!unresponsiveTimer) {
      return
    }

    clearTimeout(unresponsiveTimer)
    unresponsiveTimer = undefined
  }

  const pruneAttempts = (now: number) => {
    attemptTimestamps = attemptTimestamps.filter((timestamp) => now - timestamp < CIRCUIT_WINDOW_MS)
  }

  const logWithContext = (entry: Record<string, unknown>) => {
    logger.log({
      serverUrl,
      loadUrl,
      currentUrl: webContents.getURL?.(),
      ...entry,
    })
  }

  const runRecoveryAction = async (request: RecoveryRequest) => {
    if (request.mode === 'load-url') {
      await window.loadURL(loadUrl)
      return
    }

    if (request.crashBeforeReload) {
      webContents.forcefullyCrashRenderer?.()
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

    webContents.reload()
  }

  const startRecovery = (request: RecoveryRequest) => {
    recoveryInFlight = true
    const startedAt = Date.now()
    attemptTimestamps.push(startedAt)
    const attempt = attemptTimestamps.length

    logWithContext({
      severity: 'warn',
      event: 'main_window_recovery_started',
      attempt,
      trigger: request.trigger,
      mode: request.mode,
      ...(request.metadata ?? {}),
    })

    void (async () => {
      try {
        if (isWindowDestroyed(window)) {
          throw new Error('main window destroyed before recovery')
        }

        await runRecoveryAction(request)
        await verifyRecovered()

        if (!isWindowDestroyed(window)) {
          window.show()
          window.focus()
        }

        consecutiveFailures = 0
        logWithContext({
          severity: 'info',
          event: 'main_window_recovery_succeeded',
          attempt,
          trigger: request.trigger,
          mode: request.mode,
          ...(request.metadata ?? {}),
        })
      } catch (error) {
        consecutiveFailures += 1
        logWithContext({
          severity: 'error',
          event: 'main_window_recovery_failed',
          attempt,
          trigger: request.trigger,
          mode: request.mode,
          ...(request.metadata ?? {}),
          error,
        })
      } finally {
        recoveryInFlight = false
      }
    })()
  }

  const requestRecovery = (request: RecoveryRequest) => {
    if (recoveryInFlight) {
      logWithContext({
        severity: 'info',
        event: 'main_window_recovery_skipped',
        reason: 'recovery-in-flight',
        trigger: request.trigger,
        ...(request.metadata ?? {}),
      })
      return
    }

    if (scheduledRecoveryTimer) {
      logWithContext({
        severity: 'info',
        event: 'main_window_recovery_skipped',
        reason: 'recovery-already-scheduled',
        trigger: request.trigger,
        ...(request.metadata ?? {}),
      })
      return
    }

    const now = Date.now()
    pruneAttempts(now)
    if (attemptTimestamps.length >= MAX_ATTEMPTS_PER_WINDOW) {
      logWithContext({
        severity: 'error',
        event: 'main_window_recovery_circuit_open',
        trigger: request.trigger,
        attemptsInWindow: attemptTimestamps.length,
        windowMs: CIRCUIT_WINDOW_MS,
        ...(request.metadata ?? {}),
      })
      return
    }

    const delayMs = consecutiveFailures > 0
      ? RETRY_DELAYS_MS[Math.min(consecutiveFailures - 1, RETRY_DELAYS_MS.length - 1)]
      : 0

    if (delayMs === 0) {
      startRecovery(request)
      return
    }

    scheduledRecoveryTimer = scheduleTimeout(() => {
      scheduledRecoveryTimer = undefined
      startRecovery(request)
    }, delayMs)
  }

  webContents.on('render-process-gone', (_event, details: { reason?: string; exitCode?: number } = {}) => {
    const metadata = {
      reason: details.reason ?? 'unknown',
      exitCode: details.exitCode,
      willRecover: true,
    }

    logWithContext({
      severity: 'warn',
      event: 'main_window_renderer_gone',
      ...metadata,
    })

    requestRecovery({
      trigger: 'render-process-gone',
      mode: 'reload',
      metadata,
    })
  })

  webContents.on(
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

  webContents.on('unresponsive', () => {
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

  webContents.on('responsive', () => {
    clearUnresponsiveTimer()
    logWithContext({
      severity: 'info',
      event: 'main_window_responsive',
    })
  })
}
