// Electron main process entry point
// This module is the entry point for the Electron app.
// It coordinates app lifecycle, window management, and server startup.

import type { ElectronMainLogger } from './main-process-logger.js'

export interface ElectronApp {
  whenReady(): Promise<void>
  on(event: string, callback: (...args: any[]) => void): void
  quit(): void
  requestSingleInstanceLock(): boolean
}

export interface MainProcessDeps {
  app: ElectronApp
  createMainWindow: () => Promise<any>
  stopServer: () => Promise<void>
  disposeRendererRecovery?: () => void
  minimizeToTray: boolean
  platform: NodeJS.Platform
  /** Structured lifecycle observability, supplied by the real entry point. */
  lifecycleLogger?: ElectronMainLogger
  /** Incremented for each entry.ts main() pass (chooser/wizard restarts). */
  startupGeneration?: number
}

export async function initMainProcess(deps: MainProcessDeps): Promise<void> {
  const { app, minimizeToTray } = deps
  const startupGeneration = deps.startupGeneration ?? 1
  const logLifecycle = (event: string, fields: Record<string, unknown> = {}) => {
    const entry = {
      ...fields,
      severity: 'info' as const,
      event,
      startupGeneration,
    }
    deps.lifecycleLogger?.log(entry)
    // Fixture stdout is retained by Playwright even when its required HOME
    // cleanup removes the JSONL log after a failure.
    if (process.env.FRESHELL_ELECTRON_TEST_LIFECYCLE_STDOUT === '1') {
      console.log(JSON.stringify({ component: 'electron-main', ...entry }))
    }
  }

  // Single-instance lock
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    deps.disposeRendererRecovery?.()
    app.quit()
    return
  }

  let mainWindow: any = null
  let isQuitting = false
  let quitContinuationStarted = false
  let serverStopInProgress: Promise<void> | undefined

  await app.whenReady()

  mainWindow = await deps.createMainWindow()

  // Close-to-tray behavior: intercept close and hide, unless the app is
  // genuinely quitting (via app.quit(), tray menu, etc.). The `before-quit`
  // event sets `isQuitting = true` so the close handler lets it through.
  if (minimizeToTray && mainWindow) {
    mainWindow.on('close', (event: { preventDefault: () => void }) => {
      if (!isQuitting) {
        event.preventDefault()
        mainWindow.hide()
      }
    })
  }

  // Calling app.quit() from a before-quit listener synchronously emits
  // before-quit again in Electron. Mark the continuation before calling it so
  // both rejected and synchronously-throwing stopServer implementations are
  // safe from re-entering this listener.
  const continueQuit = () => {
    if (quitContinuationStarted) {
      logLifecycle('electron_continue_quit_ignored', { reason: 'already-started' })
      return
    }
    quitContinuationStarted = true
    logLifecycle('electron_continue_quit')
    app.quit()
  }

  const resumeQuitAfterServerStopFailure = (error: unknown) => {
    serverStopInProgress = undefined
    // Cleanup failure must not strand Electron in a half-quit state. We have
    // already attempted the exact child; resume the quit while the
    // structured error below preserves the failure for diagnosis.
    console.error(JSON.stringify({
      severity: 'error',
      component: 'electron-main',
      event: 'server_stop_before_quit_failed',
      error: error instanceof Error ? error.message : String(error),
    }))
    deps.lifecycleLogger?.log({
      severity: 'error',
      event: 'electron_server_stop_failed',
      startupGeneration,
      error,
    })
    continueQuit()
  }

  // Cleanup on quit
  app.on('before-quit', (event?: { preventDefault: () => void }) => {
    // Electron does not await async event listeners. Prevent the first quit
    // request, then explicitly resume it after the exact server child has
    // stopped. The resumed app.quit() fires before-quit again; the guard lets
    // that one through without stopping the server twice.
    logLifecycle('electron_before_quit', {
      quitContinuationStarted,
      serverStopInProgress: Boolean(serverStopInProgress),
    })
    if (quitContinuationStarted) return

    event?.preventDefault()
    if (!isQuitting) {
      isQuitting = true
      deps.disposeRendererRecovery?.()
    }
    if (serverStopInProgress) return

    try {
      logLifecycle('electron_server_stop_started')
      serverStopInProgress = deps.stopServer()
        .then(() => {
          logLifecycle('electron_server_stop_settled', { outcome: 'fulfilled' })
          continueQuit()
        })
        .catch(resumeQuitAfterServerStopFailure)
    } catch (error) {
      resumeQuitAfterServerStopFailure(error)
    }
  })

  // macOS: re-show window on activate
  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show()
    }
  })

  // Second instance: focus existing window
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized?.()) {
        mainWindow.restore?.()
      }
      mainWindow.focus?.()
    }
  })

  // Note: window-all-closed is handled by entry.ts with a lifecycle-aware
  // guard (wizardPhase). This prevents the app from quitting during the
  // wizard-to-main transition on Windows/Linux.
}
