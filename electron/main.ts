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

  // Cleanup on quit
  app.on('before-quit', async () => {
    isQuitting = true
    await deps.stopServer()
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
