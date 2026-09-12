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

  it('prevents the initial quit until a slow stop settles, then resumes once', async () => {
    let finishStop!: () => void
    ;(deps.stopServer as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>((resolve) => {
      finishStop = resolve
    }))
    await initMainProcess(deps)

    const beforeQuit = app.listeners('before-quit')[0] as (event: { preventDefault: () => void }) => void
    const firstQuit = { preventDefault: vi.fn() }
    beforeQuit(firstQuit)

    expect(firstQuit.preventDefault).toHaveBeenCalledTimes(1)
    expect(deps.stopServer).toHaveBeenCalledTimes(1)
    expect(app.quit).not.toHaveBeenCalled()

    // A second quit request while cleanup is pending is still blocked, but it
    // must not start another stop operation.
    const duplicateQuit = { preventDefault: vi.fn() }
    beforeQuit(duplicateQuit)
    expect(duplicateQuit.preventDefault).toHaveBeenCalledTimes(1)
    expect(deps.stopServer).toHaveBeenCalledTimes(1)
    expect(app.quit).not.toHaveBeenCalled()

    finishStop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(app.quit).toHaveBeenCalledTimes(1)

    // The resumed quit is allowed through and does not stop the server again.
    const resumedQuit = { preventDefault: vi.fn() }
    beforeQuit(resumedQuit)
    expect(resumedQuit.preventDefault).not.toHaveBeenCalled()
    expect(deps.stopServer).toHaveBeenCalledTimes(1)
  })

  it('resumes quitting when server cleanup rejects', async () => {
    ;(deps.stopServer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('stop failed'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await initMainProcess(deps)
      const beforeQuit = app.listeners('before-quit')[0] as (event: { preventDefault: () => void }) => void
      const firstQuit = { preventDefault: vi.fn() }

      beforeQuit(firstQuit)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(firstQuit.preventDefault).toHaveBeenCalledTimes(1)
      expect(deps.stopServer).toHaveBeenCalledTimes(1)
      expect(app.quit).toHaveBeenCalledTimes(1)

      const resumedQuit = { preventDefault: vi.fn() }
      beforeQuit(resumedQuit)
      expect(resumedQuit.preventDefault).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('resumes quitting when server cleanup throws synchronously', async () => {
    const stopServer = vi.fn(() => {
      throw new Error('stop failed synchronously')
    })
    deps.stopServer = stopServer as unknown as MainProcessDeps['stopServer']
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await initMainProcess(deps)
      const beforeQuit = app.listeners('before-quit')[0] as (event: { preventDefault: () => void }) => void
      const firstQuit = { preventDefault: vi.fn() }

      beforeQuit(firstQuit)

      expect(firstQuit.preventDefault).toHaveBeenCalledTimes(1)
      expect(stopServer).toHaveBeenCalledTimes(1)
      expect(app.quit).toHaveBeenCalledTimes(1)

      const resumedQuit = { preventDefault: vi.fn() }
      beforeQuit(resumedQuit)
      expect(resumedQuit.preventDefault).not.toHaveBeenCalled()
      expect(stopServer).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('does not re-enter quit when synchronous cleanup failure re-emits before-quit', async () => {
    const stopServer = vi.fn(() => {
      throw new Error('stop failed synchronously')
    })
    deps.stopServer = stopServer as unknown as MainProcessDeps['stopServer']
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await initMainProcess(deps)
      const beforeQuit = app.listeners('before-quit')[0] as (event: { preventDefault: () => void }) => void
      const firstQuit = { preventDefault: vi.fn() }
      ;(app.quit as ReturnType<typeof vi.fn>).mockImplementation(() => {
        // Electron emits before-quit again when the resumed quit is requested.
        // A synchronous stop failure must not start another cleanup/quit cycle.
        app.emit('before-quit', { preventDefault: vi.fn() })
      })

      beforeQuit(firstQuit)

      expect(firstQuit.preventDefault).toHaveBeenCalledTimes(1)
      expect(stopServer).toHaveBeenCalledTimes(1)
      expect(app.quit).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
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
