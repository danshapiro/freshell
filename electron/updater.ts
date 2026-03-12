import { EventEmitter } from 'events'

export interface AutoUpdaterApi {
  checkForUpdates(): Promise<any>
  downloadUpdate(): Promise<void | string[]>
  quitAndInstall(): void
  on(event: string, callback: (...args: any[]) => void): void
}

export interface UpdateManager {
  /** Check for updates (non-blocking). Emits events. */
  checkForUpdates(): Promise<void>

  /** Download the pending update. */
  downloadUpdate(): Promise<void>

  /** Install update and restart app. */
  installAndRestart(): void

  /** Event emitter for update-available, update-downloaded, error */
  on(event: string, callback: (...args: any[]) => void): void
}

export function createUpdateManager(autoUpdater: AutoUpdaterApi): UpdateManager {
  const emitter = new EventEmitter()

  // Forward events from autoUpdater
  autoUpdater.on('update-available', (info: any) => {
    emitter.emit('update-available', info)
  })

  autoUpdater.on('update-downloaded', (info: any) => {
    emitter.emit('update-downloaded', info)
  })

  autoUpdater.on('error', (err: any) => {
    emitter.emit('error', err)
  })

  return {
    async checkForUpdates(): Promise<void> {
      await autoUpdater.checkForUpdates()
    },

    async downloadUpdate(): Promise<void> {
      await autoUpdater.downloadUpdate()
    },

    installAndRestart(): void {
      autoUpdater.quitAndInstall()
    },

    on(event: string, callback: (...args: any[]) => void): void {
      emitter.on(event, callback)
    },
  }
}
