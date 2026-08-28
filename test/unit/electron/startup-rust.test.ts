import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'path'
import {
  resolveDesktopRuntimeResources,
  runStartup,
  type StartupContext,
} from '../../../electron/startup.js'

function context(overrides: Partial<StartupContext> = {}): StartupContext {
  return {
    desktopConfig: {
      serverMode: 'app-bound',
      port: 4321,
      knownServers: [],
      alwaysAskOnLaunch: false,
      globalHotkey: 'CommandOrControl+`',
      startOnLogin: false,
      minimizeToTray: true,
      setupCompleted: true,
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
      load: vi.fn().mockResolvedValue({ width: 800, height: 600, maximized: false }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    updateManager: {
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      downloadUpdate: vi.fn().mockResolvedValue(undefined),
      installAndRestart: vi.fn(),
      on: vi.fn(),
    },
    isDev: false,
    port: 4321,
    resourcesPath: '/opt/Freshell/resources',
    configDir: '/tmp/freshell profile/.freshell',
    platform: 'linux',
    createBrowserWindow: vi.fn().mockReturnValue({
      loadURL: vi.fn().mockResolvedValue(undefined),
      show: vi.fn(),
      hide: vi.fn(),
      focus: vi.fn(),
      maximize: vi.fn(),
      isVisible: vi.fn().mockReturnValue(true),
      isFocused: vi.fn().mockReturnValue(true),
      on: vi.fn(),
    }),
    createTray: vi.fn(),
    discoverLaunchCandidates: vi.fn().mockResolvedValue([]),
    readEnvToken: vi.fn().mockResolvedValue('test-token'),
    ...overrides,
  } as StartupContext
}

describe('Electron Rust app-bound startup', () => {
  it('runs the dev prerequisite pipeline and leaves every Rust-side resource available', () => {
    const projectRoot = process.cwd()
    const configDir = path.join(projectRoot, '.freshell')
    const mcpEntry = path.join(projectRoot, 'dist', 'tools', 'freshell-mcp', 'server.js')
    const hadMcpEntry = existsSync(mcpEntry)
    const previousMcpEntry = hadMcpEntry ? readFileSync(mcpEntry) : undefined

    try {
      // Remove this ignored output so a missing build:tools phase cannot be
      // hidden by a prior local build. `--help` is consumed by concurrently
      // after the prerequisite commands, so no long-lived dev process starts.
      rmSync(mcpEntry, { force: true })
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const result = spawnSync(npm, ['run', 'electron:dev', '--', '--help'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 120_000,
      })
      if (result.error) throw result.error
      expect(result.status, result.stderr || result.stdout).toBe(0)

      const resources = resolveDesktopRuntimeResources(undefined, process.platform, true, configDir)
      expect(existsSync(resources.serverBinary)).toBe(true)
      expect(existsSync(path.join(resources.clientDir, 'index.html'))).toBe(true)
      expect(existsSync(resources.mcpEntry)).toBe(true)
    } finally {
      if (previousMcpEntry) writeFileSync(mcpEntry, previousMcpEntry)
      else rmSync(mcpEntry, { force: true })
    }
  }, 120_000)

  it('resolves packaged Rust resources without Node backend fields', () => {
    const resources = resolveDesktopRuntimeResources(
      '/opt/Freshell/resources',
      'linux',
      false,
      '/tmp/freshell profile/.freshell',
    )
    expect(resources).toEqual({
      serverBinary: path.join('/opt/Freshell/resources', 'bin', 'freshell-server'),
      clientDir: path.join('/opt/Freshell/resources', 'client'),
      claudeNodeBinary: path.join('/opt/Freshell/resources', 'node', 'bin', 'node'),
      claudeSidecarEntry: path.join('/opt/Freshell/resources', 'claude-sidecar', 'index.mjs'),
      mcpNodeBinary: path.join('/opt/Freshell/resources', 'node', 'bin', 'node'),
      mcpEntry: path.join('/opt/Freshell/resources', 'mcp', 'server.js'),
      homeDir: '/tmp/freshell profile',
      configDir: '/tmp/freshell profile/.freshell',
      logDir: '/tmp/freshell profile/.freshell/logs',
    })
  })

  it('uses the debug Rust binary in development and starts the app-bound URL', async () => {
    const ctx = context({ isDev: true, resourcesPath: undefined })
    const result = await runStartup(ctx)
    expect(result.type).toBe('main')
    expect(ctx.serverSpawner.start).toHaveBeenCalledWith(expect.objectContaining({
      port: 4321,
      authToken: 'test-token',
      resources: expect.objectContaining({
        serverBinary: expect.stringMatching(/target[\\/]debug[\\/]freshell-server$/),
      }),
    }))
    if (result.type === 'main') expect(result.serverUrl).toBe('http://localhost:4321')
  })

  it('rejects a relative or non-.freshell config directory before spawning', () => {
    expect(() => resolveDesktopRuntimeResources(
      '/opt/resources',
      'linux',
      false,
      'relative/.freshell',
    )).toThrow(/absolute/i)
    expect(() => resolveDesktopRuntimeResources(
      '/opt/resources',
      'linux',
      false,
      '/tmp/freshell/config',
    )).toThrow(/\.freshell/i)
  })
})
