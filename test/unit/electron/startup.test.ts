import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import path from 'path'
import { runStartup, type StartupContext, type BrowserWindowLike } from '../../../electron/startup.js'
import type { DesktopConfig } from '../../../electron/types.js'

// Spawn paths are built with path.join, so separators are OS-native
// (backslashes on Windows). Normalize to forward slashes so structural
// assertions hold on every platform.
const norm = (p: string): string => p.replace(/\\/g, '/')

function createMockWindow(): BrowserWindowLike {
  let visible = false
  let focused = false
  return {
    loadURL: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockImplementation(() => { visible = true }),
    hide: vi.fn().mockImplementation(() => { visible = false; focused = false }),
    focus: vi.fn().mockImplementation(() => { focused = true }),
    maximize: vi.fn(),
    isVisible: vi.fn().mockImplementation(() => visible),
    isFocused: vi.fn().mockImplementation(() => focused),
    on: vi.fn(),
  }
}

function createMockWindowWithWebContents(): BrowserWindowLike & {
  webContents: EventEmitter & {
    on: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
    getURL: ReturnType<typeof vi.fn>
    emit: (event: string, ...args: any[]) => boolean
  }
} {
  const window = createMockWindow()
  const emitter = new EventEmitter()
  const originalOn = emitter.on.bind(emitter)
  const originalEmit = emitter.emit.bind(emitter)
  const webContents = Object.assign(emitter, {
    on: vi.fn(originalOn),
    reload: vi.fn(),
    getURL: vi.fn().mockReturnValue('http://localhost:3001/'),
    emit: originalEmit,
  })

  return {
    ...window,
    webContents,
  }
}

function createDefaultContext(overrides: Partial<StartupContext> = {}): StartupContext {
  return {
    desktopConfig: {
      serverMode: 'app-bound',
      port: 3001,
      knownServers: [],
      alwaysAskOnLaunch: false,
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
    platform: 'linux' as NodeJS.Platform,
    createBrowserWindow: vi.fn().mockReturnValue(createMockWindow()),
    createTray: vi.fn(),
    discoverLaunchCandidates: vi.fn().mockResolvedValue([]),
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
        port: 3001,
        knownServers: [],
        alwaysAskOnLaunch: false,
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
          port: 3001,
          knownServers: [],
          alwaysAskOnLaunch: false,
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
          port: 3001,
          knownServers: [],
          alwaysAskOnLaunch: false,
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
          port: 3001,
          knownServers: [],
          alwaysAskOnLaunch: false,
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
      expect(norm(startArgs.spawn.nodeBinary)).toContain('/app/resources/bundled-node/bin/node')
      expect(norm(startArgs.spawn.serverEntry)).toContain('/app/resources/server/index.js')
      expect(norm(startArgs.spawn.nativeModulesDir)).toContain('/app/resources/bundled-node/native-modules')
      expect(norm(startArgs.spawn.serverNodeModulesDir)).toContain('/app/resources/server-node-modules')
      expect(result.type).toBe('main')
      if (result.type === 'main') {
        expect(result.serverUrl).toBe('http://localhost:3001')
      }
    })

    it('uses node.exe on Windows platform', async () => {
      const ctx = createDefaultContext({
        isDev: false,
        resourcesPath: 'C:\\Program Files\\Freshell\\resources',
        platform: 'win32',
      })
      const result = await runStartup(ctx)
      expect(result.type).toBe('main')
      const startArgs = (ctx.serverSpawner.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(startArgs.spawn.nodeBinary).toMatch(/node\.exe$/)
    })

    it('uses node (no .exe) on Linux platform', async () => {
      const ctx = createDefaultContext({
        isDev: false,
        resourcesPath: '/app/resources',
        platform: 'linux',
      })
      const result = await runStartup(ctx)
      expect(result.type).toBe('main')
      const startArgs = (ctx.serverSpawner.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(norm(startArgs.spawn.nodeBinary)).toMatch(/\/node$/)
      expect(startArgs.spawn.nodeBinary).not.toMatch(/\.exe$/)
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
    it('opens chooser when remoteUrl is not configured', async () => {
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          port: 3001,
          knownServers: [],
          alwaysAskOnLaunch: false,
          // remoteUrl intentionally omitted
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
      })

      const result = await runStartup(ctx)
      expect(result).toEqual({
        type: 'chooser',
        candidates: [],
        reason: 'manual-choice',
      })
    })

    it('validates connectivity and saved token before opening remote URL', async () => {
      const fetchHealthCheck = vi.fn().mockResolvedValue(true)
      const fetchAuthenticated = vi.fn().mockResolvedValue(true)
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://10.0.0.5:3001',
          remoteToken: 'vpn-token',
          knownServers: [],
          alwaysAskOnLaunch: false,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        fetchHealthCheck,
        fetchAuthenticated,
      })

      const result = await runStartup(ctx)
      expect(fetchHealthCheck).toHaveBeenCalledWith('http://10.0.0.5:3001/api/health')
      expect(fetchAuthenticated).toHaveBeenCalledWith('http://10.0.0.5:3001/api/settings', 'vpn-token')
      expect(ctx.serverSpawner.start).not.toHaveBeenCalled()
      expect(ctx.daemonManager.status).not.toHaveBeenCalled()
      if (result.type === 'main') {
        expect(result.serverUrl).toBe('http://10.0.0.5:3001')
        const window = (ctx.createBrowserWindow as ReturnType<typeof vi.fn>).mock.results[0].value
        expect(window.loadURL).toHaveBeenCalledWith('http://10.0.0.5:3001?token=vpn-token')
      }
    })

    it('opens chooser when saved remote token is missing', async () => {
      const fetchHealthCheck = vi.fn().mockResolvedValue(true)
      const fetchAuthenticated = vi.fn()
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://10.0.0.5:3001',
          knownServers: [],
          alwaysAskOnLaunch: false,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        fetchHealthCheck,
        fetchAuthenticated,
      })

      const result = await runStartup(ctx)
      expect(fetchHealthCheck).toHaveBeenCalledWith('http://10.0.0.5:3001/api/health')
      expect(fetchAuthenticated).not.toHaveBeenCalled()
      expect(result).toEqual({
        type: 'chooser',
        candidates: [],
        reason: 'missing-token',
      })
    })

    it('opens chooser when saved remote token is invalid', async () => {
      const fetchHealthCheck = vi.fn().mockResolvedValue(true)
      const fetchAuthenticated = vi.fn().mockResolvedValue(false)
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://10.0.0.5:3001',
          remoteToken: 'stale-token',
          knownServers: [],
          alwaysAskOnLaunch: false,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        fetchHealthCheck,
        fetchAuthenticated,
      })

      const result = await runStartup(ctx)
      expect(fetchHealthCheck).toHaveBeenCalledWith('http://10.0.0.5:3001/api/health')
      expect(fetchAuthenticated).toHaveBeenCalledWith('http://10.0.0.5:3001/api/settings', 'stale-token')
      expect(result).toEqual({
        type: 'chooser',
        candidates: [],
        reason: 'saved-remote-token-invalid',
      })
    })

    it('normalizes trailing slash in saved remote URL before health and auth probes', async () => {
      const fetchHealthCheck = vi.fn().mockResolvedValue(true)
      const fetchAuthenticated = vi.fn().mockResolvedValue(false)
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://10.0.0.5:3001/',
          remoteToken: 'stale-token',
          knownServers: [],
          alwaysAskOnLaunch: false,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        fetchHealthCheck,
        fetchAuthenticated,
      })

      const result = await runStartup(ctx)
      expect(fetchHealthCheck).toHaveBeenCalledWith('http://10.0.0.5:3001/api/health')
      expect(fetchAuthenticated).toHaveBeenCalledWith('http://10.0.0.5:3001/api/settings', 'stale-token')
      expect(result).toEqual({
        type: 'chooser',
        candidates: [],
        reason: 'saved-remote-token-invalid',
      })
    })

    it('throws user-friendly error when health check returns false', async () => {
      const fetchHealthCheck = vi.fn().mockResolvedValue(false)
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://10.0.0.5:3001',
          knownServers: [],
          alwaysAskOnLaunch: false,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        fetchHealthCheck,
      })

      const result = await runStartup(ctx)
      expect(result).toEqual({
        type: 'chooser',
        candidates: [],
        reason: 'saved-remote-unreachable',
      })
    })

    it('catches fetch TypeError and opens chooser for unreachable hosts', async () => {
      // Simulates what happens when fetch() throws on unreachable host
      const fetchHealthCheck = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://192.168.99.99:3001',
          knownServers: [],
          alwaysAskOnLaunch: false,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        fetchHealthCheck,
      })

      const result = await runStartup(ctx)
      expect(result).toEqual({
        type: 'chooser',
        candidates: [],
        reason: 'saved-remote-unreachable',
      })
    })

    it('catches network errors and opens chooser', async () => {
      // Simulates ECONNREFUSED or similar network error
      const fetchHealthCheck = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://10.0.0.5:3001',
          knownServers: [],
          alwaysAskOnLaunch: false,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        fetchHealthCheck,
      })

      const result = await runStartup(ctx)
      expect(result).toEqual({
        type: 'chooser',
        candidates: [],
        reason: 'saved-remote-unreachable',
      })
    })
  })

  describe('launch discovery integration', () => {
    it('returns chooser when alwaysAskOnLaunch is enabled', async () => {
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'app-bound',
          port: 3001,
          knownServers: [],
          alwaysAskOnLaunch: true,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        discoverLaunchCandidates: vi.fn().mockResolvedValue([
          {
            id: 'local-a',
            url: 'http://localhost:3001',
            origin: 'port-scan',
            ownership: 'detected-local',
            label: 'localhost:3001',
            token: 'local-token',
            requiresAuth: true,
          },
        ]),
      })

      const result = await runStartup(ctx)

      expect(result).toEqual({
        type: 'chooser',
        candidates: [
          {
            id: 'local-a',
            url: 'http://localhost:3001',
            origin: 'port-scan',
            ownership: 'detected-local',
            label: 'localhost:3001',
            token: 'local-token',
            requiresAuth: true,
          },
        ],
        reason: 'always-ask',
      })
      expect(ctx.serverSpawner.start).not.toHaveBeenCalled()
      expect(ctx.createBrowserWindow).not.toHaveBeenCalled()
    })

    it('auto-connects to one discovered local server without spawning a new server', async () => {
      const ctx = createDefaultContext({
        discoverLaunchCandidates: vi.fn().mockResolvedValue([
          {
            id: 'local-a',
            url: 'http://localhost:3001',
            origin: 'port-scan',
            ownership: 'detected-local',
            label: 'localhost:3001',
            token: 'local-token',
            requiresAuth: true,
          },
        ]),
      })

      const result = await runStartup(ctx)

      expect(ctx.serverSpawner.start).not.toHaveBeenCalled()
      expect(result.type).toBe('main')
      if (result.type === 'main') {
        expect(result.serverUrl).toBe('http://localhost:3001')
      }
      const window = (ctx.createBrowserWindow as ReturnType<typeof vi.fn>).mock.results[0].value
      expect(window.loadURL).toHaveBeenCalledWith('http://localhost:3001?token=local-token')
    })
  })

  describe('forced launch (explicit chooser selection)', () => {
    it('honors a forced connect without discovery or policy, even when alwaysAskOnLaunch is true', async () => {
      const discoverLaunchCandidates = vi.fn().mockResolvedValue([
        {
          id: 'local-a',
          url: 'http://localhost:3001',
          origin: 'port-scan',
          ownership: 'detected-local',
          label: 'localhost:3001',
          requiresAuth: true,
          token: 'local-token',
        },
      ])
      const fetchHealthCheck = vi.fn()
      const mockWindow = createMockWindow()
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://saved:3001',
          remoteToken: 'saved-token',
          knownServers: [],
          alwaysAskOnLaunch: true,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        discoverLaunchCandidates,
        fetchHealthCheck,
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
        forcedLaunch: { kind: 'connect', url: 'http://10.0.0.5:3001', token: 'vpn-token' },
      })

      const result = await runStartup(ctx)

      expect(discoverLaunchCandidates).not.toHaveBeenCalled()
      expect(fetchHealthCheck).not.toHaveBeenCalled()
      expect(ctx.serverSpawner.start).not.toHaveBeenCalled()
      expect(result.type).toBe('main')
      expect(mockWindow.loadURL).toHaveBeenCalledWith('http://10.0.0.5:3001?token=vpn-token')
    })

    it('starts a local server on the forced port even when other servers are detected', async () => {
      const discoverLaunchCandidates = vi.fn().mockResolvedValue([
        {
          id: 'other',
          url: 'http://localhost:3001',
          origin: 'port-scan',
          ownership: 'detected-local',
          label: 'localhost:3001',
          requiresAuth: false,
        },
      ])
      const mockWindow = createMockWindow()
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://saved:3001',
          remoteToken: 'saved-token',
          knownServers: [],
          alwaysAskOnLaunch: false,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        discoverLaunchCandidates,
        readEnvToken: vi.fn().mockResolvedValue('env-token'),
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
        forcedLaunch: { kind: 'start-local', port: 3007 },
      })

      const result = await runStartup(ctx)

      expect(discoverLaunchCandidates).not.toHaveBeenCalled()
      expect(ctx.serverSpawner.start).toHaveBeenCalledTimes(1)
      const startArgs = (ctx.serverSpawner.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(startArgs.port).toBe(3007)
      expect(result.type).toBe('main')
      if (result.type === 'main') {
        expect(result.serverUrl).toBe('http://localhost:3007')
      }
      expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3007?token=env-token')
    })
  })

  it('registers hotkey with configured accelerator', async () => {
    const ctx = createDefaultContext()
    await runStartup(ctx)
    expect(ctx.hotkeyManager.register).toHaveBeenCalledWith('CommandOrControl+`', expect.any(Function))
  })

  it('registers renderer recovery for the main window and reloads the crashed renderer', async () => {
    const mockWindow = createMockWindowWithWebContents()
    const logger = { log: vi.fn() }
    const ctx = createDefaultContext({
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      mainProcessLogger: logger,
      rendererRecoveryVerifier: vi.fn().mockResolvedValue(undefined),
      readEnvToken: vi.fn().mockResolvedValue('env token+with&chars'),
    })

    const result = await runStartup(ctx)
    expect(result.type).toBe('main')

    mockWindow.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
    await vi.runOnlyPendingTimersAsync()

    expect(mockWindow.webContents.reload).toHaveBeenCalledTimes(1)
    expect(ctx.serverSpawner.start).toHaveBeenCalledTimes(1)
    expect(ctx.serverSpawner.stop).not.toHaveBeenCalled()
  })

  it('reuses the same authenticated URL for recoverable main-frame load failures', async () => {
    const mockWindow = createMockWindowWithWebContents()
    const logger = { log: vi.fn() }
    const ctx = createDefaultContext({
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      mainProcessLogger: logger,
      rendererRecoveryVerifier: vi.fn().mockResolvedValue(undefined),
      readEnvToken: vi.fn().mockResolvedValue('env token+with&chars'),
    })

    const result = await runStartup(ctx)
    expect(result.type).toBe('main')

    mockWindow.webContents.emit('did-fail-load', {}, -102, 'CONNECTION_REFUSED', 'http://localhost:3001/', true)
    await vi.runOnlyPendingTimersAsync()

    expect(mockWindow.loadURL).toHaveBeenLastCalledWith('http://localhost:3001?token=env%20token%2Bwith%26chars')
    expect(ctx.serverSpawner.start).toHaveBeenCalledTimes(1)
    expect(ctx.serverSpawner.stop).not.toHaveBeenCalled()
  })

  it('logs an explicit warning when recovery cannot attach because webContents is unavailable', async () => {
    const logger = { log: vi.fn() }
    await runStartup(createDefaultContext({ mainProcessLogger: logger }))
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warn',
      event: 'main_window_recovery_unavailable',
    }))
  })

  it('logs main_window_initial_load_failed through the main-process logger with the authenticated load URL', async () => {
    const mockWindow = createMockWindowWithWebContents()
    const error = new Error('initial load failed')
    ;(mockWindow.loadURL as ReturnType<typeof vi.fn>).mockRejectedValue(error)
    const logger = { log: vi.fn() }
    const ctx = createDefaultContext({
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      mainProcessLogger: logger,
      rendererRecoveryVerifier: vi.fn().mockResolvedValue(undefined),
      readEnvToken: vi.fn().mockResolvedValue('token-abc'),
    })

    const result = await runStartup(ctx)
    expect(result.type).toBe('main')
    await Promise.resolve()

    expect(logger.log).toHaveBeenCalledWith({
      severity: 'error',
      event: 'main_window_initial_load_failed',
      serverUrl: 'http://localhost:3001',
      loadUrl: 'http://localhost:3001?token=token-abc',
      error,
    })
  })

  it('logs a sanitized fallback error when the initial load fails without a main-process logger', async () => {
    const mockWindow = createMockWindow()
    const error = new Error('failed to load http://remote.example:3001/?token=saved-remote-token&workspace=main')
    ;(mockWindow.loadURL as ReturnType<typeof vi.fn>).mockRejectedValue(error)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = createDefaultContext({
      desktopConfig: {
        serverMode: 'remote',
        port: 3001,
        remoteUrl: 'http://remote.example:3001/?token=saved-remote-token&workspace=main',
        remoteToken: 'token-abc',
        knownServers: [],
        alwaysAskOnLaunch: false,
        globalHotkey: 'CommandOrControl+`',
        startOnLogin: false,
        minimizeToTray: true,
        setupCompleted: true,
      },
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      fetchHealthCheck: vi.fn().mockResolvedValue(true),
      fetchAuthenticated: vi.fn().mockResolvedValue(true),
    })

    const result = await runStartup(ctx)
    expect(result.type).toBe('main')
    await Promise.resolve()

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const [payload] = consoleErrorSpy.mock.calls[0] ?? []
    expect(typeof payload).toBe('string')
    expect(payload).toContain('"event":"main_window_initial_load_failed"')
    expect(payload).not.toContain('token=saved-remote-token')
    expect(payload).not.toContain('token-abc')
    expect(payload).not.toContain('saved-remote-token')

    const parsed = JSON.parse(payload as string) as Record<string, unknown>
    expect(parsed).toMatchObject({
      severity: 'error',
      component: 'electron-startup',
      event: 'main_window_initial_load_failed',
      serverUrl: 'http://remote.example:3001/?token=%5BREDACTED%5D&workspace=main',
    })
    expect(parsed).not.toHaveProperty('loadUrl')

    consoleErrorSpy.mockRestore()
  })

  describe('hotkey quake-style toggle', () => {
    it('shows and focuses window when hidden', async () => {
      const mockWindow = createMockWindow()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      })
      const result = await runStartup(ctx)
      expect(result.type).toBe('main')

      // Get the hotkey callback
      const registerCall = (ctx.hotkeyManager.register as ReturnType<typeof vi.fn>).mock.calls[0]
      const hotkeyCallback = registerCall[1] as () => void

      // Window starts visible+focused after show() in startup, so hide it first
      mockWindow.hide()
      ;(mockWindow.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(false)
      ;(mockWindow.isFocused as ReturnType<typeof vi.fn>).mockReturnValue(false)

      // Trigger hotkey -- should show + focus
      hotkeyCallback()
      expect(mockWindow.show).toHaveBeenCalled()
      expect(mockWindow.focus).toHaveBeenCalled()
    })

    it('hides window when visible and focused', async () => {
      const mockWindow = createMockWindow()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      })
      await runStartup(ctx)

      const registerCall = (ctx.hotkeyManager.register as ReturnType<typeof vi.fn>).mock.calls[0]
      const hotkeyCallback = registerCall[1] as () => void

      // Window is visible and focused
      ;(mockWindow.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(true)
      ;(mockWindow.isFocused as ReturnType<typeof vi.fn>).mockReturnValue(true)

      hotkeyCallback()
      expect(mockWindow.hide).toHaveBeenCalled()
    })

    it('shows and focuses window when visible but not focused', async () => {
      const mockWindow = createMockWindow()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      })
      await runStartup(ctx)

      const registerCall = (ctx.hotkeyManager.register as ReturnType<typeof vi.fn>).mock.calls[0]
      const hotkeyCallback = registerCall[1] as () => void

      // Window is visible but NOT focused (e.g. behind another window)
      ;(mockWindow.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(true)
      ;(mockWindow.isFocused as ReturnType<typeof vi.fn>).mockReturnValue(false)

      hotkeyCallback()
      expect(mockWindow.show).toHaveBeenCalled()
      expect(mockWindow.focus).toHaveBeenCalled()
    })
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

  it('maximizes window when window state has maximized=true', async () => {
    const mockWindow = createMockWindow()
    const ctx = createDefaultContext({
      windowStatePersistence: {
        load: vi.fn().mockResolvedValue({ width: 1200, height: 800, maximized: true }),
        save: vi.fn().mockResolvedValue(undefined),
      },
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
    })

    await runStartup(ctx)
    expect(mockWindow.maximize).toHaveBeenCalled()
  })

  it('does not maximize window when window state has maximized=false', async () => {
    const mockWindow = createMockWindow()
    const ctx = createDefaultContext({
      windowStatePersistence: {
        load: vi.fn().mockResolvedValue({ width: 1200, height: 800, maximized: false }),
        save: vi.fn().mockResolvedValue(undefined),
      },
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
    })

    await runStartup(ctx)
    expect(mockWindow.maximize).not.toHaveBeenCalled()
  })

  describe('window state persistence on move/resize', () => {
    function createMockWindowWithBounds() {
      const win = createMockWindow()
      ;(win as any).getBounds = vi.fn().mockReturnValue({ x: 100, y: 200, width: 800, height: 600 })
      ;(win as any).isMaximized = vi.fn().mockReturnValue(false)
      return win
    }

    it('saves window state on resize (debounced)', async () => {
      const mockWindow = createMockWindowWithBounds()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      })
      await runStartup(ctx)

      // Find the 'resize' handler registered via window.on
      const onCalls = (mockWindow.on as ReturnType<typeof vi.fn>).mock.calls
      const resizeCall = onCalls.find(([event]: [string]) => event === 'resize')
      expect(resizeCall).toBeDefined()

      // Trigger it
      resizeCall![1]()

      // Advance past debounce timer
      await vi.advanceTimersByTimeAsync(600)

      expect(ctx.windowStatePersistence.save).toHaveBeenCalledWith({
        x: 100, y: 200, width: 800, height: 600, maximized: false,
      })
    })

    it('saves window state on move (debounced)', async () => {
      const mockWindow = createMockWindowWithBounds()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      })
      await runStartup(ctx)

      const onCalls = (mockWindow.on as ReturnType<typeof vi.fn>).mock.calls
      const moveCall = onCalls.find(([event]: [string]) => event === 'move')
      expect(moveCall).toBeDefined()

      moveCall![1]()

      await vi.advanceTimersByTimeAsync(600)

      expect(ctx.windowStatePersistence.save).toHaveBeenCalledWith({
        x: 100, y: 200, width: 800, height: 600, maximized: false,
      })
    })

    it('debounces rapid events (only saves once)', async () => {
      const mockWindow = createMockWindowWithBounds()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      })
      await runStartup(ctx)

      const onCalls = (mockWindow.on as ReturnType<typeof vi.fn>).mock.calls
      const resizeCall = onCalls.find(([event]: [string]) => event === 'resize')
      expect(resizeCall).toBeDefined()

      // Call 5 times rapidly
      for (let i = 0; i < 5; i++) {
        resizeCall![1]()
      }

      await vi.advanceTimersByTimeAsync(600)

      expect(ctx.windowStatePersistence.save).toHaveBeenCalledTimes(1)
    })

    it('does not save before debounce period expires', async () => {
      const mockWindow = createMockWindowWithBounds()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      })
      await runStartup(ctx)

      const onCalls = (mockWindow.on as ReturnType<typeof vi.fn>).mock.calls
      const resizeCall = onCalls.find(([event]: [string]) => event === 'resize')
      expect(resizeCall).toBeDefined()

      resizeCall![1]()

      // Advance only 100ms (less than 500ms debounce)
      await vi.advanceTimersByTimeAsync(100)

      expect(ctx.windowStatePersistence.save).not.toHaveBeenCalled()
    })
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

  it('shows the main window before waiting for page load to finish', async () => {
    const mockWindow = createMockWindow()
    let resolveLoad: (() => void) | undefined
    ;(mockWindow.loadURL as ReturnType<typeof vi.fn>).mockReturnValue(new Promise<void>((resolve) => {
      resolveLoad = resolve
    }))
    const ctx = createDefaultContext({
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
    })

    const startupPromise = runStartup(ctx)

    await vi.waitFor(() => expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001'))
    expect(mockWindow.show).toHaveBeenCalled()
    const result = await startupPromise
    expect(result.type).toBe('main')

    resolveLoad?.()
  })

  describe('auth token in URL', () => {
    it('appends ?token= to URL for app-bound mode', async () => {
      const mockWindow = createMockWindow()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
        readEnvToken: vi.fn().mockResolvedValue('test-auth-token-abc'),
      })
      await runStartup(ctx)
      expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001?token=test-auth-token-abc')
    })

    it('URL-encodes the auth token so metacharacters survive the renderer round-trip', async () => {
      // The renderer reads the token back via URLSearchParams.get, so a raw
      // token containing +, &, #, or a trailing space must be percent-encoded
      // or it would be corrupted (and the app would load unauthenticated).
      const mockWindow = createMockWindow()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
        readEnvToken: vi.fn().mockResolvedValue('a+b&c#d '),
      })
      await runStartup(ctx)
      expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001?token=a%2Bb%26c%23d%20')
    })

    it('appends ?token= to URL for daemon mode', async () => {
      const mockWindow = createMockWindow()
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'daemon',
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
        readEnvToken: vi.fn().mockResolvedValue('daemon-token-xyz'),
      })
      await runStartup(ctx)
      expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001?token=daemon-token-xyz')
    })

    it('appends ?token= to URL for remote mode using remoteToken', async () => {
      const mockWindow = createMockWindow()
      const fetchHealthCheck = vi.fn().mockResolvedValue(true)
      const fetchAuthenticated = vi.fn().mockResolvedValue(true)
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          remoteUrl: 'http://10.0.0.5:3001',
          remoteToken: 'remote-secret-123',
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
        fetchHealthCheck,
        fetchAuthenticated,
      })
      await runStartup(ctx)
      expect(mockWindow.loadURL).toHaveBeenCalledWith('http://10.0.0.5:3001?token=remote-secret-123')
    })

    it('loads URL without token when readEnvToken returns undefined', async () => {
      const mockWindow = createMockWindow()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
        readEnvToken: vi.fn().mockResolvedValue(undefined),
      })
      await runStartup(ctx)
      expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001')
    })

    it('loads URL without token when readEnvToken is not provided (backward compat)', async () => {
      const mockWindow = createMockWindow()
      const ctx = createDefaultContext({
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
        // No readEnvToken provided
      })
      await runStartup(ctx)
      expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001')
    })

    it('calls readEnvToken with correct path (configDir/.env)', async () => {
      const readEnvToken = vi.fn().mockResolvedValue('some-token')
      const ctx = createDefaultContext({
        readEnvToken,
      })
      await runStartup(ctx)
      expect(readEnvToken).toHaveBeenCalledWith(path.join('/home/user/.freshell', '.env'))
    })

    it('does not call readEnvToken for remote mode', async () => {
      const readEnvToken = vi.fn().mockResolvedValue('should-not-be-used')
      const fetchHealthCheck = vi.fn().mockResolvedValue(true)
      const fetchAuthenticated = vi.fn().mockResolvedValue(true)
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'remote',
          remoteUrl: 'http://10.0.0.5:3001',
          remoteToken: 'remote-token',
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        readEnvToken,
        fetchHealthCheck,
        fetchAuthenticated,
      })
      await runStartup(ctx)
      expect(readEnvToken).not.toHaveBeenCalled()
    })

    it('opens chooser for remote mode when remoteToken is absent', async () => {
      const mockWindow = createMockWindow()
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
        createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
        fetchHealthCheck,
      })
      const result = await runStartup(ctx)
      expect(result).toEqual({
        type: 'chooser',
        candidates: [],
        reason: 'missing-token',
      })
      expect(mockWindow.loadURL).not.toHaveBeenCalled()
    })
  })

  it('returns updateCheckTimer in main result so caller can cancel it', async () => {
    const ctx = createDefaultContext()
    const result = await runStartup(ctx)
    expect(result.type).toBe('main')
    if (result.type === 'main') {
      expect(result.updateCheckTimer).toBeDefined()
      // Timer should be a number (NodeJS.Timeout is assignable to ReturnType<typeof setTimeout>)
      clearTimeout(result.updateCheckTimer)
    }
  })

  it('update check timer fires after 10s delay', async () => {
    const ctx = createDefaultContext()
    await runStartup(ctx)

    expect(ctx.updateManager.checkForUpdates).not.toHaveBeenCalled()

    // Advance by 10 seconds
    await vi.advanceTimersByTimeAsync(10_000)

    expect(ctx.updateManager.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('update check can be cancelled via clearTimeout on the timer', async () => {
    const ctx = createDefaultContext()
    const result = await runStartup(ctx)

    if (result.type === 'main') {
      clearTimeout(result.updateCheckTimer)
    }

    // Advance past the 10s delay
    await vi.advanceTimersByTimeAsync(15_000)

    // Should NOT have been called since we cancelled the timer
    expect(ctx.updateManager.checkForUpdates).not.toHaveBeenCalled()
  })
})
