import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runStartup, type StartupContext, type BrowserWindowLike } from '../../../electron/startup.js'
import type { DesktopConfig } from '../../../electron/types.js'

function createMockWindow(): BrowserWindowLike {
  return {
    loadURL: vi.fn().mockResolvedValue(undefined),
    show: vi.fn(),
    on: vi.fn(),
  }
}

function createDefaultContext(overrides: Partial<StartupContext> = {}): StartupContext {
  return {
    desktopConfig: {
      serverMode: 'app-bound',
      globalHotkey: 'CommandOrControl+`',
      startOnLogin: false,
      minimizeToTray: true,
      setupCompleted: true,
    },
    daemonManager: {
      platform: 'linux',
      install: vi.fn().mockResolvedValue(undefined),
      uninstall: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockResolvedValue({ installed: true, running: true, pid: 12345 }),
      isInstalled: vi.fn().mockResolvedValue(true),
    },
    serverSpawner: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(false),
      pid: vi.fn().mockReturnValue(undefined),
    },
    hotkeyManager: {
      register: vi.fn().mockReturnValue(true),
      unregister: vi.fn(),
      update: vi.fn().mockReturnValue(true),
      current: vi.fn().mockReturnValue(null),
    },
    windowStatePersistence: {
      load: vi.fn().mockResolvedValue({ width: 1200, height: 800, maximized: false }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    updateManager: {
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      downloadUpdate: vi.fn().mockResolvedValue(undefined),
      installAndRestart: vi.fn(),
      on: vi.fn(),
    },
    isDev: false,
    port: 3001,
    resourcesPath: '/app/resources',
    configDir: '/home/user/.freshell',
    createBrowserWindow: vi.fn().mockReturnValue(createMockWindow()),
    createTray: vi.fn(),
    ...overrides,
  }
}

describe('runStartup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns wizard signal when setup not completed', async () => {
    const ctx = createDefaultContext({
      desktopConfig: {
        serverMode: 'app-bound',
        globalHotkey: 'CommandOrControl+`',
        startOnLogin: false,
        minimizeToTray: true,
        setupCompleted: false,
      },
    })

    const result = await runStartup(ctx)
    expect(result.type).toBe('wizard')
  })

  describe('daemon mode', () => {
    it('does not start daemon if already running', async () => {
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'daemon',
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
      })
      ;(ctx.daemonManager.status as ReturnType<typeof vi.fn>).mockResolvedValue({
        installed: true,
        running: true,
        pid: 12345,
      })

      await runStartup(ctx)
      expect(ctx.daemonManager.status).toHaveBeenCalled()
      expect(ctx.daemonManager.start).not.toHaveBeenCalled()
    })

    it('starts daemon if not running', async () => {
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'daemon',
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
      })
      ;(ctx.daemonManager.status as ReturnType<typeof vi.fn>).mockResolvedValue({
        installed: true,
        running: false,
      })

      await runStartup(ctx)
      expect(ctx.daemonManager.start).toHaveBeenCalled()
    })

    it('throws if daemon not installed', async () => {
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'daemon',
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
      })
      ;(ctx.daemonManager.status as ReturnType<typeof vi.fn>).mockResolvedValue({
        installed: false,
        running: false,
      })

      await expect(runStartup(ctx)).rejects.toThrow('not installed')
    })
  })

  describe('app-bound mode', () => {
    it('spawns server in production mode with paths from resourcesPath', async () => {
      const ctx = createDefaultContext({ isDev: false, resourcesPath: '/app/resources' })
      const result = await runStartup(ctx)

      expect(ctx.serverSpawner.start).toHaveBeenCalledTimes(1)
      const startArgs = (ctx.serverSpawner.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(startArgs.spawn.mode).toBe('production')
      expect(startArgs.spawn.nodeBinary).toContain('/app/resources/bundled-node/bin/node')
      expect(startArgs.spawn.serverEntry).toContain('/app/resources/server/index.js')
      expect(startArgs.spawn.nativeModulesDir).toContain('/app/resources/bundled-node/native-modules')
      expect(startArgs.spawn.serverNodeModulesDir).toContain('/app/resources/server-node-modules')
      expect(result.type).toBe('main')
      if (result.type === 'main') {
        expect(result.serverUrl).toBe('http://localhost:3001')
      }
    })

    it('throws if resourcesPath is missing in production mode', async () => {
      const ctx = createDefaultContext({ isDev: false, resourcesPath: undefined })
      await expect(runStartup(ctx)).rejects.toThrow('resourcesPath is required')
    })

    it('uses tsx in dev mode and points at Vite dev server', async () => {
      const ctx = createDefaultContext({ isDev: true })
      const result = await runStartup(ctx)

      expect(ctx.serverSpawner.start).toHaveBeenCalledTimes(1)
      const startArgs = (ctx.serverSpawner.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(startArgs.spawn.mode).toBe('dev')
      if (result.type === 'main') {
        expect(result.serverUrl).toBe('http://localhost:5173')
      }
    })
  })

  describe('remote mode', () => {
    it('validates connectivity and opens remote URL', async () => {
      const fetchHealthCheck = vi.fn().mockResolvedValue(true)
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          remoteUrl: 'http://10.0.0.5:3001',
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        fetchHealthCheck,
      })

      const result = await runStartup(ctx)
      expect(fetchHealthCheck).toHaveBeenCalledWith('http://10.0.0.5:3001/api/health')
      expect(ctx.serverSpawner.start).not.toHaveBeenCalled()
      expect(ctx.daemonManager.status).not.toHaveBeenCalled()
      if (result.type === 'main') {
        expect(result.serverUrl).toBe('http://10.0.0.5:3001')
      }
    })
  })

  it('registers hotkey with configured accelerator', async () => {
    const ctx = createDefaultContext()
    await runStartup(ctx)
    expect(ctx.hotkeyManager.register).toHaveBeenCalledWith('CommandOrControl+`', expect.any(Function))
  })

  it('creates tray', async () => {
    const ctx = createDefaultContext()
    await runStartup(ctx)
    expect(ctx.createTray).toHaveBeenCalled()
  })

  it('window state is loaded and applied', async () => {
    const ctx = createDefaultContext()
    await runStartup(ctx)
    expect(ctx.windowStatePersistence.load).toHaveBeenCalled()
    expect(ctx.createBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1200, height: 800 }),
    )
  })

  it('creates BrowserWindow and loads server URL', async () => {
    const mockWindow = createMockWindow()
    const ctx = createDefaultContext({
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
    })

    const result = await runStartup(ctx)
    expect(result.type).toBe('main')
    expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001')
    expect(mockWindow.show).toHaveBeenCalled()
  })
})
