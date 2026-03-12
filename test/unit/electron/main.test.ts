import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { initMainProcess, type ElectronApp, type MainProcessDeps } from '../../../electron/main.js'

function createMockApp(): ElectronApp & EventEmitter {
  const emitter = new EventEmitter() as ElectronApp & EventEmitter
  emitter.whenReady = vi.fn().mockResolvedValue(undefined)
  emitter.quit = vi.fn()
  emitter.requestSingleInstanceLock = vi.fn().mockReturnValue(true)
  return emitter
}

describe('initMainProcess', () => {
  let app: ElectronApp & EventEmitter
  let mockWindow: any
  let deps: MainProcessDeps

  beforeEach(() => {
    app = createMockApp()
    mockWindow = {
      show: vi.fn(),
      hide: vi.fn(),
      focus: vi.fn(),
      isMinimized: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      on: vi.fn(),
    }
    deps = {
      app,
      createMainWindow: vi.fn().mockResolvedValue(mockWindow),
      stopServer: vi.fn().mockResolvedValue(undefined),
      minimizeToTray: true,
      platform: 'linux',
    }
  })

  it('calls whenReady and creates main window', async () => {
    await initMainProcess(deps)
    expect(app.whenReady).toHaveBeenCalled()
    expect(deps.createMainWindow).toHaveBeenCalled()
  })

  it('quits when single instance lock fails', async () => {
    ;(app.requestSingleInstanceLock as ReturnType<typeof vi.fn>).mockReturnValue(false)
    await initMainProcess(deps)
    expect(app.quit).toHaveBeenCalled()
    expect(deps.createMainWindow).not.toHaveBeenCalled()
  })

  it('close-to-tray hides window instead of quitting', async () => {
    await initMainProcess(deps)

    // Find the close handler registered on the window
    const onCall = mockWindow.on.mock.calls.find(
      (call: any[]) => call[0] === 'close'
    )
    expect(onCall).toBeDefined()

    const event = { preventDefault: vi.fn() }
    onCall![1](event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(mockWindow.hide).toHaveBeenCalled()
  })

  it('close-to-tray allows close through when app is quitting (isQuitting flag)', async () => {
    await initMainProcess(deps)

    // Find the close handler registered on the window
    const closeCall = mockWindow.on.mock.calls.find(
      (call: any[]) => call[0] === 'close'
    )
    expect(closeCall).toBeDefined()

    // Trigger before-quit first -- this sets isQuitting = true
    app.emit('before-quit')
    await new Promise((r) => setTimeout(r, 10))

    // Now the close handler should NOT prevent default
    const event = { preventDefault: vi.fn() }
    closeCall![1](event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('before-quit stops server', async () => {
    await initMainProcess(deps)

    // Trigger before-quit
    app.emit('before-quit')
    // Give async a tick
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.stopServer).toHaveBeenCalled()
  })

  it('activate shows window on macOS', async () => {
    await initMainProcess(deps)
    app.emit('activate')
    expect(mockWindow.show).toHaveBeenCalled()
  })

  describe('window-all-closed', () => {
    it('does not register window-all-closed handler (handled by entry.ts)', async () => {
      await initMainProcess(deps)
      // initMainProcess should not register window-all-closed; that is entry.ts's responsibility
      const windowAllClosedCalls = app.listeners('window-all-closed')
      expect(windowAllClosedCalls).toHaveLength(0)
    })
  })
})
