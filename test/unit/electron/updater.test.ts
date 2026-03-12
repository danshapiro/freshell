import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { createUpdateManager, type AutoUpdaterApi } from '../../../electron/updater.js'

describe('UpdateManager', () => {
  let mockAutoUpdater: AutoUpdaterApi & EventEmitter
  let manager: ReturnType<typeof createUpdateManager>

  beforeEach(() => {
    mockAutoUpdater = new EventEmitter() as AutoUpdaterApi & EventEmitter
    mockAutoUpdater.checkForUpdates = vi.fn().mockResolvedValue(undefined)
    mockAutoUpdater.downloadUpdate = vi.fn().mockResolvedValue(undefined)
    mockAutoUpdater.quitAndInstall = vi.fn()
    manager = createUpdateManager(mockAutoUpdater)
  })

  it('checkForUpdates calls autoUpdater.checkForUpdates', async () => {
    await manager.checkForUpdates()
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled()
  })

  it('emits update-available when update found', () => {
    const callback = vi.fn()
    manager.on('update-available', callback)

    mockAutoUpdater.emit('update-available', { version: '1.0.0' })
    expect(callback).toHaveBeenCalledWith({ version: '1.0.0' })
  })

  it('emits update-downloaded when download completes', () => {
    const callback = vi.fn()
    manager.on('update-downloaded', callback)

    mockAutoUpdater.emit('update-downloaded', { version: '1.0.0' })
    expect(callback).toHaveBeenCalledWith({ version: '1.0.0' })
  })

  it('installAndRestart calls autoUpdater.quitAndInstall', () => {
    manager.installAndRestart()
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalled()
  })

  it('emits error on network failure', () => {
    const callback = vi.fn()
    manager.on('error', callback)

    const error = new Error('Network error')
    mockAutoUpdater.emit('error', error)
    expect(callback).toHaveBeenCalledWith(error)
  })

  it('downloadUpdate delegates to autoUpdater', async () => {
    await manager.downloadUpdate()
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalled()
  })
})
