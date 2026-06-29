import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronMainLogger } from '../../../electron/main-process-logger.js'
import {
  registerRendererRecovery,
  type RecoverableBrowserWindow,
  type RecoverableWebContents,
} from '../../../electron/renderer-recovery.js'

type MockWebContents = RecoverableWebContents & EventEmitter & {
  emit: EventEmitter['emit']
  reload: ReturnType<typeof vi.fn>
  forcefullyCrashRenderer: ReturnType<typeof vi.fn>
  getURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
}

type MockWindow = RecoverableBrowserWindow & {
  loadURL: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  webContents: MockWebContents
}

function createRecoverableWindow(loadUrl: string): MockWindow {
  const webContents = new EventEmitter() as MockWebContents
  webContents.reload = vi.fn()
  webContents.forcefullyCrashRenderer = vi.fn()
  webContents.getURL = vi.fn().mockReturnValue(loadUrl)
  webContents.isDestroyed = vi.fn().mockReturnValue(false)

  return {
    loadURL: vi.fn().mockResolvedValue(undefined),
    show: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
    webContents,
  }
}

describe('registerRendererRecovery', () => {
  const serverUrl = 'http://localhost:5173'
  const loadUrl = `${serverUrl}/?token=super-secret`
  let logger: ElectronMainLogger & { log: ReturnType<typeof vi.fn> }
  let window: MockWindow

  beforeEach(() => {
    vi.useFakeTimers()
    logger = { log: vi.fn() }
    window = createRecoverableWindow(loadUrl)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reloads the crashed renderer when the renderer process is gone', async () => {
    const verifyRecovered = vi.fn().mockResolvedValue(undefined)

    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
      verifyRecovered,
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await vi.runOnlyPendingTimersAsync()

    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(window.loadURL).not.toHaveBeenCalled()
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warn',
      event: 'main_window_renderer_gone',
      reason: 'crashed',
      exitCode: 133,
    }))
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'info',
      event: 'main_window_recovery_succeeded',
    }))
  })

  it('shows and focuses the window after recovery succeeds', async () => {
    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await vi.advanceTimersByTimeAsync(0)

    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })

  it('recovers clean renderer exits while the main window is expected to stay alive', async () => {
    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    await vi.runOnlyPendingTimersAsync()

    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      event: 'main_window_renderer_gone',
      reason: 'clean-exit',
      willRecover: true,
    }))
  })

  it('logs did-fail-load and retries only main-frame non-abort failures', async () => {
    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
    })

    window.webContents.emit('did-fail-load', {}, -102, 'CONNECTION_REFUSED', loadUrl, true)
    await vi.runOnlyPendingTimersAsync()
    expect(window.loadURL).toHaveBeenCalledWith(loadUrl)

    window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', loadUrl, true)
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      event: 'main_window_navigation_failed',
      errorCode: -3,
      willRecover: false,
    }))
  })

  it('recovers after a sustained unresponsive renderer and cancels when responsive returns', async () => {
    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
    })

    window.webContents.emit('unresponsive')
    window.webContents.emit('responsive')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(window.loadURL).not.toHaveBeenCalled()

    window.webContents.emit('unresponsive')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(window.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('backs off before retrying after a failed recovery', async () => {
    const verifyRecovered = vi.fn()
      .mockRejectedValueOnce(new Error('recovery failed'))
      .mockResolvedValueOnce(undefined)

    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
      verifyRecovered,
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await vi.advanceTimersByTimeAsync(0)
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await vi.advanceTimersByTimeAsync(249)
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(window.webContents.reload).toHaveBeenCalledTimes(2)
  })

  it('cancels queued unresponsive backoff recovery when the renderer becomes responsive', async () => {
    const verifyRecovered = vi.fn().mockRejectedValueOnce(new Error('recovery failed'))

    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
      verifyRecovered,
    })

    window.webContents.emit('unresponsive')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(window.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)

    window.webContents.emit('unresponsive')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)

    window.webContents.emit('responsive')
    await vi.advanceTimersByTimeAsync(250)

    expect(window.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('falls back to loadURL and logs when reload is unavailable', async () => {
    Reflect.deleteProperty(window.webContents, 'reload')

    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await vi.advanceTimersByTimeAsync(0)

    expect(window.loadURL).toHaveBeenCalledWith(loadUrl)
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warn',
      event: 'main_window_recovery_reload_unavailable',
      trigger: 'render-process-gone',
    }))
  })

  it('falls back to loadURL and logs when webContents is destroyed before reload', async () => {
    window.webContents.isDestroyed.mockReturnValue(true)

    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await vi.advanceTimersByTimeAsync(0)

    expect(window.loadURL).toHaveBeenCalledWith(loadUrl)
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warn',
      event: 'main_window_recovery_reload_unavailable',
      trigger: 'render-process-gone',
    }))
  })

  it('stops retrying after the crash-loop circuit breaker opens', async () => {
    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
    })

    for (let index = 0; index < 4; index += 1) {
      window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
      await vi.runOnlyPendingTimersAsync()
    }

    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'error',
      event: 'main_window_recovery_circuit_open',
    }))
  })

  it('coalesces duplicate failure events while one recovery attempt is in flight', async () => {
    const verifyRecovered = vi.fn().mockReturnValue(new Promise(() => {}))

    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
      verifyRecovered,
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    window.webContents.emit('did-fail-load', {}, -102, 'CONNECTION_REFUSED', loadUrl, true)
    await vi.runOnlyPendingTimersAsync()

    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(window.loadURL).not.toHaveBeenCalled()
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      event: 'main_window_recovery_skipped',
      reason: 'recovery-in-flight',
    }))
  })

  it('does not log success until the recovery verifier resolves', async () => {
    let resolveVerifier!: () => void
    const verifyRecovered = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      resolveVerifier = resolve
    }))

    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
      verifyRecovered,
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await vi.runOnlyPendingTimersAsync()

    expect(logger.log).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'main_window_recovery_succeeded',
    }))

    resolveVerifier()
    await Promise.resolve()

    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      event: 'main_window_recovery_succeeded',
    }))
  })

  it('does not log success until an async renderer reload resolves', async () => {
    let resolveReload!: () => void
    window.webContents.reload.mockReturnValue(new Promise<void>((resolve) => {
      resolveReload = resolve
    }))

    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await vi.advanceTimersByTimeAsync(0)

    expect(logger.log).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'main_window_recovery_succeeded',
    }))
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()

    resolveReload()

    await vi.waitFor(() => {
      expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
        event: 'main_window_recovery_succeeded',
      }))
    })
    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })

  it('logs recovery failure without success when an async renderer reload rejects', async () => {
    window.webContents.reload.mockRejectedValue(new Error('replacement load failed'))

    registerRendererRecovery({
      window,
      loadUrl,
      serverUrl,
      logger,
      setTimeout,
      clearTimeout,
    })

    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await vi.advanceTimersByTimeAsync(0)

    await vi.waitFor(() => {
      expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
        severity: 'error',
        event: 'main_window_recovery_failed',
      }))
    })
    expect(logger.log).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'main_window_recovery_succeeded',
    }))
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })
})
