import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { initMainProcess, acquireInstanceLock, type ElectronApp, type MainProcessDeps } from '../../../electron/main.js'

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

  describe('acquireInstanceLock', () => {
    it('returns true without quitting when the lock is acquired', () => {
      const app = createMockApp()
      expect(acquireInstanceLock(app)).toBe(true)
      expect(app.quit).not.toHaveBeenCalled()
    })

    it('quits and returns false when another instance holds the lock', () => {
      const app = createMockApp()
      ;(app.requestSingleInstanceLock as ReturnType<typeof vi.fn>).mockReturnValue(false)
      expect(acquireInstanceLock(app)).toBe(false)
      expect(app.quit).toHaveBeenCalled()
    })

    it('invokes onDenied BEFORE quitting (so entry.ts can lift the wizard-phase will-quit veto)', () => {
      const app = createMockApp()
      ;(app.requestSingleInstanceLock as ReturnType<typeof vi.fn>).mockReturnValue(false)
      const onDenied = vi.fn()
      expect(acquireInstanceLock(app, onDenied)).toBe(false)
      expect(onDenied.mock.invocationCallOrder[0])
        .toBeLessThan((app.quit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
    })
  })

  it('shows a hidden main window before focusing it on second-instance', async () => {
    await initMainProcess(deps)

    app.emit('second-instance')

    expect(mockWindow.show).toHaveBeenCalled()
    expect(mockWindow.focus).toHaveBeenCalled()
    expect(mockWindow.show.mock.invocationCallOrder[0])
      .toBeLessThan(mockWindow.focus.mock.invocationCallOrder[0])
  })

  it('does not double-register second-instance when an early canonical handler exists', async () => {
    // entry.ts installs its own canonical handler in main() before any window
    // creation; initMainProcess must defer to it.
    app.on('second-instance', () => {})
    await initMainProcess(deps)
    expect(app.listenerCount('second-instance')).toBe(1)
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
