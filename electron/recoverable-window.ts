import type { BrowserWindowLike } from './startup.js'
import type { ElectronMainLogger } from './main-process-logger.js'
import type { RecoverableWebContents } from './renderer-recovery.js'
import { RendererReadinessTimeout, verifyRendererReady, type RendererDocumentWindow } from './renderer-readiness.js'

type Listener = { event: string; callback: (...args: any[]) => void }
type NativeListener = Listener & { logical?: Listener }
interface NativeWindow extends RendererDocumentWindow {
  loadURL(url: string): Promise<void>
  on(event: string, callback: (...args: any[]) => void): unknown
  removeListener(event: string, callback: (...args: any[]) => void): unknown
  webContents: RendererDocumentWindow['webContents'] & {
    id: number
    on(event: string, callback: (...args: any[]) => void): unknown
    removeListener(event: string, callback: (...args: any[]) => void): unknown
    stop(): void
    forcefullyCrashRenderer(): void
  }
  destroy(): void
  show(): void
  hide(): void
  focus(): void
  maximize(): void
  restore(): void
  isVisible(): boolean
  isFocused(): boolean
  isMaximized(): boolean
  isMinimized(): boolean
  getBounds(): { x: number; y: number; width: number; height: number }
}

interface NativeBindings {
  generation: number
  window: NativeListener[]
  webContents: NativeListener[]
}

interface Attempt {
  native: NativeWindow
  controller: AbortController
  deadline: number
  timer: ReturnType<typeof setTimeout>
}

interface RecoverableWindowOptions {
  createNativeWindow(options: Record<string, any>): NativeWindow
  options: Record<string, any>
  onWebContentsChanged(webContentsId: number): void
  logger: ElectronMainLogger
}

const INITIAL_ATTEMPT_MS = 10_000
// Node/Electron timers coerce larger delays to 1 ms. Growth must remain finite and representable.
const MAX_ATTEMPT_MS = 2_147_483_647

function waitForNative<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      signal.removeEventListener('abort', cancelled)
      reject(signal.reason)
    }
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled))
    if (signal.aborted) cancelled()
    else signal.addEventListener('abort', cancelled, { once: true })
  })
}

/** One logical main window; each replacement stays hidden and untrusted until verified. */
export function createRecoverableWindow({ createNativeWindow, options, onWebContentsChanged, logger }: RecoverableWindowOptions): BrowserWindowLike {
  const windowListeners: Listener[] = []
  const webContentsListeners: Listener[] = []
  const bindings = new Map<NativeWindow, NativeBindings>()
  let activeWindow: NativeWindow
  let currentAttempt: Attempt | undefined
  let disposed = false
  let initialNavigation = true
  let recoveryUrl: string | undefined
  let attemptBudgetMs = INITIAL_ATTEMPT_MS

  const notifyNavigationFailure = (url: string, code: number, description: string) => {
    if (disposed) return
    for (const listener of [...webContentsListeners]) {
      if (listener.event === 'did-fail-load') listener.callback({}, code, description, url, true)
    }
  }

  const bind = (win: NativeWindow, target: 'window' | 'webContents', listener: Listener) => {
    const state = bindings.get(win)!
    const callback = (...args: any[]) => {
      if (!disposed && win === activeWindow && bindings.has(win)) listener.callback(...args)
    }
    state[target].push({ event: listener.event, callback, logical: listener })
    ;(target === 'window' ? win : win.webContents).on(listener.event, callback)
  }

  const detach = (win: NativeWindow) => {
    const state = bindings.get(win)
    if (!state) return
    bindings.delete(win)
    for (const listener of state.window) win.removeListener(listener.event, listener.callback)
    for (const listener of state.webContents) win.webContents.removeListener(listener.event, listener.callback)
  }

  const retire = (attempt: Attempt, error: Error) => {
    if (currentAttempt !== attempt) return
    currentAttempt = undefined
    clearTimeout(attempt.timer)
    attempt.controller.abort(error)
    // Detach before stopping/destroying: their native abort/close events belong to the retired attempt.
    detach(attempt.native)
    if (!attempt.native.isDestroyed()) {
      if (attempt.native !== activeWindow) attempt.native.destroy()
      else attempt.native.webContents.stop()
    }
  }

  const cancelRecovery = () => {
    if (disposed) return
    disposed = true
    if (currentAttempt) retire(currentAttempt, new Error('renderer recovery cancelled'))
    for (const win of bindings.keys()) detach(win)
  }

  const expire = (attempt: Attempt, budgetMs: number, url: string) => {
    if (currentAttempt !== attempt) return
    attemptBudgetMs = Math.min(MAX_ATTEMPT_MS, budgetMs * 2)
    retire(attempt, new RendererReadinessTimeout())
    logger.log({ severity: 'warn', event: 'main_window_recovery_deadline',
      cause: 'attempt-deadline', action: 'retire-attempt', outcome: 'retryable', budgetMs, nextBudgetMs: attemptBudgetMs })
    // Electron's stop() may emit only an inert ERR_ABORTED (-3). The logical
    // deadline is an actual main-frame failure and must start the initial successor.
    notifyNavigationFailure(url, -7, 'ERR_TIMED_OUT')
  }

  const createNative = (nativeOptions: Record<string, any>) => {
    const win = createNativeWindow(nativeOptions)
    const state: NativeBindings = { generation: 0, window: [], webContents: [] }
    bindings.set(win, state)
    const navigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame && !isInPlace) state.generation += 1
    }
    state.webContents.push({ event: 'did-start-navigation', callback: navigation })
    win.webContents.on('did-start-navigation', navigation)
    const closed = () => {
      if (win === activeWindow) {
        cancelRecovery()
        for (const listener of windowListeners) {
          if (listener.event === 'closed') listener.callback()
        }
      } else if (currentAttempt?.native === win) {
        retire(currentAttempt, new Error('renderer window destroyed'))
      }
    }
    state.window.push({ event: 'closed', callback: closed })
    win.on('closed', closed)
    for (const listener of windowListeners) if (listener.event !== 'closed') bind(win, 'window', listener)
    for (const listener of webContentsListeners) bind(win, 'webContents', listener)
    return win
  }

  const perform = async (url: string, navigate: boolean, replacement: boolean): Promise<void> => {
    if (disposed) throw new Error('renderer recovery cancelled')
    if (currentAttempt) retire(currentAttempt, new Error('renderer recovery cancelled'))
    const previous = activeWindow
    const bounds = previous.getBounds()
    const wasVisible = previous.isVisible()
    const wasFocused = previous.isFocused()
    const wasMaximized = previous.isMaximized()
    const controller = new AbortController()
    const budgetMs = attemptBudgetMs
    const attempt: Attempt = {
      native: previous, controller, deadline: Date.now() + budgetMs,
      timer: setTimeout(() => expire(attempt, budgetMs, url), budgetMs),
    }
    currentAttempt = attempt
    const isCurrent = () => !disposed && currentAttempt === attempt
    try {
      if (replacement) attempt.native = createNative({ ...options, ...bounds, show: false })
      const native = attempt.native
      if (navigate) await waitForNative(native.loadURL(url), controller.signal)
      if (!isCurrent()) throw controller.signal.reason ?? new Error('renderer navigation changed')
      const generation = bindings.get(native)?.generation
      await verifyRendererReady(native, url, {
        signal: controller.signal, deadline: attempt.deadline,
        isCurrent: () => isCurrent() && bindings.get(native)?.generation === generation,
      })
      if (!isCurrent()) throw controller.signal.reason ?? new Error('renderer navigation changed')
      if (bindings.get(native)?.generation !== generation) throw new Error('renderer navigation changed')
      if (Date.now() >= attempt.deadline) throw new RendererReadinessTimeout()
      if (replacement) {
        activeWindow = native
        onWebContentsChanged(native.webContents.id)
        if (wasMaximized) native.maximize()
        if (wasVisible) native.show()
        if (wasFocused) native.focus()
        detach(previous)
        if (!previous.isDestroyed()) previous.destroy()
      }
      attemptBudgetMs = INITIAL_ATTEMPT_MS
    } catch (error) {
      if (isCurrent()) {
        if (error instanceof RendererReadinessTimeout || Date.now() >= attempt.deadline) {
          expire(attempt, budgetMs, url)
        } else {
          retire(attempt, error instanceof Error ? error : new Error(String(error)))
          if (!disposed) logger.log({ severity: 'error', event: 'main_window_replacement_failed',
            cause: 'native-document-unavailable', action: 'retire-attempt', outcome: 'retryable', loadUrl: url, error })
          // Initial readiness can fail without a recoverable native event (for example
          // a cross-document abort). Keep that failure in the existing controller.
          notifyNavigationFailure(url, -2, 'ERR_FAILED')
        }
      }
      throw error
    } finally {
      clearTimeout(attempt.timer)
      if (currentAttempt === attempt) currentAttempt = undefined
    }
  }

  activeWindow = createNative(options)
  onWebContentsChanged(activeWindow.webContents.id)

  const webContents: RecoverableWebContents = {
    get id() { return activeWindow.webContents.id },
    on(event, callback) {
      const listener = { event, callback }
      webContentsListeners.push(listener)
      for (const win of bindings.keys()) bind(win, 'webContents', listener)
    },
    removeListener(event, callback) {
      const index = webContentsListeners.findIndex(listener => listener.event === event && listener.callback === callback)
      if (index < 0) return
      // Each logical registration owns its corresponding native bindings.
      const listener = webContentsListeners.splice(index, 1)[0]
      for (const [win, state] of bindings) {
        const nativeIndex = state.webContents.findIndex(binding => binding.logical === listener)
        if (nativeIndex >= 0) {
          const binding = state.webContents.splice(nativeIndex, 1)[0]
          win.webContents.removeListener(event, binding.callback)
        }
      }
    },
    getURL: () => activeWindow.webContents.getURL(),
    isDestroyed: () => activeWindow.webContents.isDestroyed(),
    reload: () => recoveryUrl ? perform(recoveryUrl, true, true) : Promise.reject(new Error('main window recovery URL unavailable')),
    forcefullyCrashRenderer: () => activeWindow.webContents.forcefullyCrashRenderer(),
  }

  return {
    webContents,
    loadURL(url) {
      if (recoveryUrl && url !== recoveryUrl) cancelRecovery()
      recoveryUrl ??= url
      const replace = !initialNavigation
      initialNavigation = false
      return perform(recoveryUrl, true, replace)
    },
    verifyRendererReady: url => perform(url, false, false),
    cancelRecovery,
    show: () => activeWindow.show(), hide: () => activeWindow.hide(), focus: () => activeWindow.focus(),
    maximize: () => activeWindow.maximize(), restore: () => activeWindow.restore(),
    isVisible: () => activeWindow.isVisible(), isFocused: () => activeWindow.isFocused(),
    isDestroyed: () => activeWindow.isDestroyed(), isMaximized: () => activeWindow.isMaximized(),
    isMinimized: () => activeWindow.isMinimized(), getBounds: () => activeWindow.getBounds(),
    on(event, callback) {
      const listener = { event, callback }
      windowListeners.push(listener)
      if (event !== 'closed') for (const win of bindings.keys()) bind(win, 'window', listener)
    },
  }
}
