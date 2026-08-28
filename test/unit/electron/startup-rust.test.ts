import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'path'
import {
  resolveDesktopRuntimeResources,
  runStartup,
  type StartupContext,
} from '../../../electron/startup.js'
import {
  resolveElectronDevPrerequisitePaths,
  runElectronDevPrerequisites,
} from '../../../scripts/electron-dev-prerequisites.js'

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
  it('runs isolated dev prerequisites and verifies every Rust startup resource', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'freshell-electron-dev-'))
    const resources = resolveElectronDevPrerequisitePaths(projectRoot, 'linux')
    const runCommand = vi.fn((command: string, args: string[], cwd: string) => {
      expect(command).toBe('npm')
      expect(cwd).toBe(projectRoot)

      const phase = args.join(' ')
      if (phase === 'run build:client') {
        mkdirSync(path.dirname(resources.clientIndex), { recursive: true })
        writeFileSync(resources.clientIndex, '<!doctype html>')
      } else if (phase === 'run build:tools') {
        mkdirSync(path.dirname(resources.mcpEntry), { recursive: true })
        writeFileSync(resources.mcpEntry, 'export {}')
      } else if (phase === 'run build:rust:debug') {
        mkdirSync(path.dirname(resources.serverBinary), { recursive: true })
        writeFileSync(resources.serverBinary, 'rust debug binary')
      }
    })

    try {
      const resolved = runElectronDevPrerequisites({
        projectRoot,
        platform: 'linux',
        npm: 'npm',
        runCommand,
      })

      expect(resolved).toEqual(resources)
      expect(runCommand).toHaveBeenCalledTimes(4)
      expect(runCommand.mock.calls.map(([, args]) => args)).toEqual([
        ['run', 'prebuild'],
        ['run', 'build:client'],
        ['run', 'build:tools'],
        ['run', 'build:rust:debug'],
      ])
      expect(existsSync(resources.serverBinary)).toBe(true)
      expect(existsSync(resources.clientIndex)).toBe(true)
      expect(existsSync(resources.mcpEntry)).toBe(true)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

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
