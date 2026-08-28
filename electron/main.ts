// Electron main process entry point
// This module is the entry point for the Electron app.
// It coordinates app lifecycle, window management, and server startup.

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
  minimizeToTray: boolean
  platform: NodeJS.Platform
}

export async function initMainProcess(deps: MainProcessDeps): Promise<void> {
  const { app, minimizeToTray } = deps

  // Single-instance lock
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
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
    if (quitContinuationStarted) return
    quitContinuationStarted = true
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
    continueQuit()
  }

  // Cleanup on quit
  app.on('before-quit', (event?: { preventDefault: () => void }) => {
    // Electron does not await async event listeners. Prevent the first quit
    // request, then explicitly resume it after the exact server child has
    // stopped. The resumed app.quit() fires before-quit again; the guard lets
    // that one through without stopping the server twice.
    if (quitContinuationStarted) return

    event?.preventDefault()
    isQuitting = true
    if (serverStopInProgress) return

    try {
      serverStopInProgress = deps.stopServer()
        .then(() => {
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
