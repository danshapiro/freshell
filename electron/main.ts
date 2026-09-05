// Electron main process entry point
// This module is the entry point for the Electron app.
// It coordinates app lifecycle, window management, and server startup.

export interface ElectronApp {
  whenReady(): Promise<void>
  on(event: string, callback: (...args: any[]) => void): void
  listenerCount(event: string): number
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

/**
 * Acquire the single-instance lock for this process's userData dir. When
 * entry.ts has namespaced userData per profile, each profile holds its own
 * lock. Call BEFORE any boot side effects (provisioning, server spawn).
 * Returns true when the lock is held; on failure the app quits and this
 * returns false. `onDenied` (optional) runs immediately BEFORE app.quit() —
 * entry.ts uses it to lift the wizard-phase `will-quit` veto for the denied
 * duplicate, which never enters the wizard.
 */
export function acquireInstanceLock(app: ElectronApp, onDenied?: () => void): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    onDenied?.()
    app.quit()
    return false
  }
  return true
}

export async function initMainProcess(deps: MainProcessDeps): Promise<void> {
  // The caller must hold the instance lock already (see acquireInstanceLock)
  // and install the canonical `second-instance` surfacing handler (entry.ts
  // registers it right after the lock gate, covering every boot phase).
  const { app, minimizeToTray } = deps
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

  // Note: window-all-closed is handled by entry.ts with a lifecycle-aware
  // guard (wizardPhase). This prevents the app from quitting during the
  // wizard-to-main transition on Windows/Linux.
}
