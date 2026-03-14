import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

// Use vi.hoisted to ensure mockState is available before vi.mock runs
// vitest hoists vi.mock calls to the top, so we need vi.hoisted for dependencies
const mockState = vi.hoisted(() => ({
  homeDir: process.env.TEMP || process.env.TMP || '/tmp',
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => mockState.homeDir,
    },
    homedir: () => mockState.homeDir,
  }
})

// Import after mocking
import {
  ConfigStore,
  defaultSettings,
  resolveDefaultLoggingDebug,
  type UserConfig,
} from '../../../server/config-store'

describe('resolveDefaultLoggingDebug', () => {
  it('returns true for non-production environments', () => {
    expect(resolveDefaultLoggingDebug({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(true)
    expect(resolveDefaultLoggingDebug({} as NodeJS.ProcessEnv)).toBe(true)
  })

  it('returns false in production', () => {
    expect(resolveDefaultLoggingDebug({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false)
  })
})

describe('ConfigStore', () => {
  let tempDir: string
  let configDir: string
  let configPath: string
  let backupConfigPath: string

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'config-store-test-'))
    mockState.homeDir = tempDir
    configDir = path.join(tempDir, '.freshell')
    configPath = path.join(configDir, 'config.json')
    backupConfigPath = path.join(configDir, 'config.backup.json')
  })

  afterEach(async () => {
    delete process.env.FRESHELL_HOME

    // Clean up temp directory
    try {
      await fsp.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('load()', () => {
    it('returns defaults when no file exists', async () => {
      const store = new ConfigStore()
      const config = await store.load()

      expect(config.version).toBe(1)
      expect(config.settings).toEqual(defaultSettings)
      expect(config.sessionOverrides).toEqual({})
      expect(config.terminalOverrides).toEqual({})
      expect(config.projectColors).toEqual({})
      expect(store.getLastReadError()).toBeUndefined()
    })

    it('creates config file when none exists', async () => {
      const store = new ConfigStore()
      await store.load()

      const exists = await fsp
        .access(configPath)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    })

    it('creates .freshell directory if needed', async () => {
      const store = new ConfigStore()
      await store.load()

      const stat = await fsp.stat(configDir)
      expect(stat.isDirectory()).toBe(true)
    })

    it('stores config under FRESHELL_HOME when set', async () => {
      const isolatedHome = path.join(tempDir, 'isolated-home')
      process.env.FRESHELL_HOME = isolatedHome

      const store = new ConfigStore()
      await store.load()

      await expect(fsp.stat(path.join(isolatedHome, '.freshell', 'config.json'))).resolves.toBeDefined()
      await expect(fsp.access(configPath)).rejects.toThrow()
    })

    it('cleans up stale config temp files on startup', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      const stalePath = path.join(configDir, 'config.json.tmp-123-0')
      const freshPath = path.join(configDir, 'config.json.tmp-456-0')

      await fsp.writeFile(stalePath, 'stale')
      await fsp.writeFile(freshPath, 'fresh')

      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const recentTime = new Date(Date.now() - 2 * 60 * 1000)
      await fsp.utimes(stalePath, oldTime, oldTime)
      await fsp.utimes(freshPath, recentTime, recentTime)

      const store = new ConfigStore()
      await store.load()

      const staleExists = await fsp
        .access(stalePath)
        .then(() => true)
        .catch(() => false)
      const freshExists = await fsp
        .access(freshPath)
        .then(() => true)
        .catch(() => false)

      expect(staleExists).toBe(false)
      expect(freshExists).toBe(true)
    })

    it('parses existing config file', async () => {
      // Create config directory and file
      await fsp.mkdir(configDir, { recursive: true })
      const existingConfig: UserConfig = {
        version: 1,
        settings: {
          ...defaultSettings,
          defaultCwd: '/workspace',
          terminal: {
            ...defaultSettings.terminal,
            scrollback: 12000,
          },
          agentChat: {
            ...defaultSettings.agentChat,
            defaultPlugins: ['fs'],
          },
        },
        sessionOverrides: { 'session-1': { titleOverride: 'Custom Title' } },
        terminalOverrides: { 'term-1': { deleted: true } },
        projectColors: { '/projects/foo': '#ff0000' },
      }
      await fsp.writeFile(configPath, JSON.stringify(existingConfig, null, 2))

      const store = new ConfigStore()
      const config = await store.load()

      expect(config.settings.defaultCwd).toBe('/workspace')
      expect(config.settings.terminal.scrollback).toBe(12000)
      expect(config.settings.agentChat.defaultPlugins).toEqual(['fs'])
      expect(config.sessionOverrides['session-1']?.titleOverride).toBe('Custom Title')
      expect(config.terminalOverrides['term-1']?.deleted).toBe(true)
      expect(config.projectColors['/projects/foo']).toBe('#ff0000')
      expect(store.getLastReadError()).toBeUndefined()
    })

    it('loads a legacy mixed config as sanitized server settings with a top-level migration seed', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      const legacyConfig = {
        version: 1,
        settings: {
          theme: 'dark' as const,
          terminal: {
            fontFamily: 'Fira Code',
            fontSize: 18,
            scrollback: 9000,
          },
          sidebar: {
            sortMode: 'project' as const,
            showSubagents: true,
            excludeFirstChatSubstrings: [' build ', 'build'],
            excludeFirstChatMustStart: true,
          },
          notifications: {
            soundEnabled: false,
          },
          agentChat: {
            defaultPlugins: ['fs'],
          },
        },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }
      await fsp.writeFile(configPath, JSON.stringify(legacyConfig, null, 2))

      const store = new ConfigStore()
      const config = await store.load()

      expect(config.settings).toEqual({
        ...defaultSettings,
        terminal: {
          ...defaultSettings.terminal,
          scrollback: 9000,
        },
        sidebar: {
          excludeFirstChatSubstrings: ['build'],
          excludeFirstChatMustStart: true,
        },
        agentChat: {
          ...defaultSettings.agentChat,
          defaultPlugins: ['fs'],
        },
      })
      expect(config.legacyLocalSettingsSeed).toEqual({
        theme: 'dark',
        terminal: {
          fontFamily: 'Fira Code',
          fontSize: 18,
        },
        sidebar: {
          sortMode: 'project',
          showSubagents: true,
        },
        notifications: {
          soundEnabled: false,
        },
      })
      expect((config.settings as Record<string, unknown>).theme).toBeUndefined()

      const saved = JSON.parse(await fsp.readFile(configPath, 'utf-8'))
      expect(saved.legacyLocalSettingsSeed).toEqual(config.legacyLocalSettingsSeed)
      expect(saved.settings.theme).toBeUndefined()
      expect(saved.settings.sidebar.excludeFirstChatMustStart).toBe(true)
    })

    it('merges existing legacyLocalSettingsSeed with moved local fields still present in settings', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      const partiallyMigratedConfig: UserConfig = {
        version: 1,
        settings: {
          ...defaultSettings,
          terminal: {
            ...defaultSettings.terminal,
            fontSize: 22,
          },
        } as any,
        legacyLocalSettingsSeed: {
          theme: 'dark',
        },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }
      await fsp.writeFile(configPath, JSON.stringify(partiallyMigratedConfig, null, 2))

      const store = new ConfigStore()
      const loaded = await store.load()

      expect(loaded.legacyLocalSettingsSeed).toEqual({
        theme: 'dark',
        terminal: {
          fontSize: 22,
        },
      })
      expect((loaded.settings.terminal as Record<string, unknown>).fontSize).toBeUndefined()

      const saved = JSON.parse(await fsp.readFile(configPath, 'utf-8'))
      expect(saved.legacyLocalSettingsSeed).toEqual({
        theme: 'dark',
        terminal: {
          fontSize: 22,
        },
      })
      expect(saved.settings.terminal.fontSize).toBeUndefined()
    })

    it('clamps malformed migrated local settings before exposing or persisting the legacy seed', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      const invalidSeedConfig: UserConfig = {
        version: 1,
        settings: defaultSettings,
        legacyLocalSettingsSeed: {
          uiScale: -5,
          terminal: {
            fontSize: 1_000_000,
            lineHeight: -2,
          },
          sidebar: {
            width: -999,
          },
        },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }
      await fsp.writeFile(configPath, JSON.stringify(invalidSeedConfig, null, 2))

      const store = new ConfigStore()
      const loaded = await store.load()

      expect(loaded.legacyLocalSettingsSeed).toEqual({
        uiScale: 0.75,
        terminal: {
          fontSize: 32,
          lineHeight: 1,
        },
        sidebar: {
          width: 200,
        },
      })

      const saved = JSON.parse(await fsp.readFile(configPath, 'utf-8'))
      expect(saved.legacyLocalSettingsSeed).toEqual({
        uiScale: 0.75,
        terminal: {
          fontSize: 32,
          lineHeight: 1,
        },
        sidebar: {
          width: 200,
        },
      })
    })

    it('returns null for invalid version and creates default config', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      await fsp.writeFile(configPath, JSON.stringify({ version: 99, settings: {} }))

      const store = new ConfigStore()
      const config = await store.load()

      // Should return defaults since version doesn't match
      expect(config.version).toBe(1)
      expect(config.settings).toEqual(defaultSettings)
      expect(store.getLastReadError()).toBe('VERSION_MISMATCH')
    })

    it('returns defaults for malformed JSON', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      await fsp.writeFile(configPath, 'not valid json {{{')

      const store = new ConfigStore()
      const config = await store.load()

      expect(config.version).toBe(1)
      expect(config.settings).toEqual(defaultSettings)
      expect(store.getLastReadError()).toBe('PARSE_ERROR')
    })

    it('uses cached value on subsequent calls', async () => {
      const store = new ConfigStore()
      const config1 = await store.load()

      // Modify the file directly
      await fsp.writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          settings: { ...defaultSettings, defaultCwd: '/cached' },
          sessionOverrides: {},
          terminalOverrides: {},
          projectColors: {},
        })
      )

      // Should still return cached value
      const config2 = await store.load()
      expect(config2).toBe(config1) // Same reference
    })
  })

  describe('save()', () => {
    it('writes config to disk', async () => {
      const store = new ConfigStore()
      const config: UserConfig = {
        version: 1,
        settings: { ...defaultSettings, defaultCwd: '/workspace' },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }

      await store.save(config)

      const raw = await fsp.readFile(configPath, 'utf-8')
      const saved = JSON.parse(raw)
      expect(saved.settings.defaultCwd).toBe('/workspace')
    })

    it('creates directory if needed', async () => {
      const store = new ConfigStore()
      const config: UserConfig = {
        version: 1,
        settings: defaultSettings,
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }

      // Directory doesn't exist yet
      const existsBefore = await fsp
        .access(configDir)
        .then(() => true)
        .catch(() => false)
      expect(existsBefore).toBe(false)

      await store.save(config)

      const existsAfter = await fsp
        .access(configDir)
        .then(() => true)
        .catch(() => false)
      expect(existsAfter).toBe(true)
    })

    it('updates the cache', async () => {
      const store = new ConfigStore()

      // Load initial config
      await store.load()

      // Save new config
      const newConfig: UserConfig = {
        version: 1,
        settings: { ...defaultSettings, defaultCwd: '/workspace' },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }
      await store.save(newConfig)

      // Subsequent load should return the saved config (from cache)
      const loaded = await store.load()
      expect(loaded.settings.defaultCwd).toBe('/workspace')
    })

    it('writes formatted JSON with indentation', async () => {
      const store = new ConfigStore()
      const config: UserConfig = {
        version: 1,
        settings: defaultSettings,
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }

      await store.save(config)

      const raw = await fsp.readFile(configPath, 'utf-8')
      expect(raw).toContain('\n') // Has newlines (formatted)
      expect(raw).toMatch(/^\{[\r\n]/) // Starts with { followed by newline
    })

    it('retries rename when atomic write hits EPERM', async () => {
      const store = new ConfigStore()
      await store.load()

      const originalRename = fsp.rename.bind(fsp)
      let attempts = 0
      const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (...args) => {
        attempts += 1
        if (attempts === 1) {
          const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        }
        return originalRename(...(args as Parameters<typeof fsp.rename>))
      })

      const config: UserConfig = {
        version: 1,
        settings: { ...defaultSettings, defaultCwd: '/workspace' },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }

      await store.save(config)
      expect(attempts).toBeGreaterThan(1)

      renameSpy.mockRestore()
    })

    it('retries rename when atomic write hits ENOENT', async () => {
      const store = new ConfigStore()
      await store.load()

      const originalRename = fsp.rename.bind(fsp)
      let attempts = 0
      const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (...args) => {
        attempts += 1
        if (attempts === 1) {
          const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        return originalRename(...(args as Parameters<typeof fsp.rename>))
      })

      const config: UserConfig = {
        version: 1,
        settings: { ...defaultSettings, defaultCwd: '/workspace' },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }

      await store.save(config)
      expect(attempts).toBeGreaterThan(1)

      renameSpy.mockRestore()
    })
  })

  describe('config backup behavior', () => {
    it('writes backup file after config save', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.patchSettings({ defaultCwd: '/workspace' })

      const backupExists = await fsp
        .access(backupConfigPath)
        .then(() => true)
        .catch(() => false)
      expect(backupExists).toBe(true)

      const raw = await fsp.readFile(backupConfigPath, 'utf-8')
      const parsed = JSON.parse(raw)
      expect(parsed.settings.defaultCwd).toBe('/workspace')
    })

    it('does not fail config save when backup write fails', async () => {
      const store = new ConfigStore()
      await store.load()

      await fsp.rm(backupConfigPath, { recursive: true, force: true })
      await fsp.mkdir(backupConfigPath, { recursive: true })

      await expect(store.patchSettings({ defaultCwd: '/fallback' })).resolves.toMatchObject({ defaultCwd: '/fallback' })

      const raw = await fsp.readFile(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      expect(parsed.settings.defaultCwd).toBe('/fallback')
    })

    it('reports backup existence correctly', async () => {
      const store = new ConfigStore()
      expect(await store.backupExists()).toBe(false)

      await store.load()
      expect(await store.backupExists()).toBe(true)
    })
  })

  describe('getSettings()', () => {
    it('returns current settings', async () => {
      const store = new ConfigStore()
      const settings = await store.getSettings()

      expect(settings).toEqual(defaultSettings)
    })

    it('returns settings from existing config', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      const existingConfig: UserConfig = {
        version: 1,
        settings: { ...defaultSettings, defaultCwd: '/workspace' },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }
      await fsp.writeFile(configPath, JSON.stringify(existingConfig))

      const store = new ConfigStore()
      const settings = await store.getSettings()

      expect(settings.defaultCwd).toBe('/workspace')
    })
  })

  describe('patchSettings() (updateSettings)', () => {
    it('merges partial updates', async () => {
      const store = new ConfigStore()
      await store.load()

      const updated = await store.patchSettings({ defaultCwd: '/workspace' })

      expect(updated.defaultCwd).toBe('/workspace')
      // Other settings should remain default
      expect(updated.terminal).toEqual(defaultSettings.terminal)
      expect(updated.safety).toEqual(defaultSettings.safety)
    })

    it('deep merges nested objects', async () => {
      const store = new ConfigStore()
      await store.load()

      const updated = await store.patchSettings({
        terminal: { scrollback: 18000 },
      })

      expect(updated.terminal.scrollback).toBe(18000)
      // Other terminal settings should remain default
      expect(updated.logging).toEqual(defaultSettings.logging)
    })

    it('persists updates to disk', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.patchSettings({ defaultCwd: '/workspace' })

      // Read from disk directly
      const raw = await fsp.readFile(configPath, 'utf-8')
      const saved = JSON.parse(raw)
      expect(saved.settings.defaultCwd).toBe('/workspace')
    })

    it('filters local-only and unknown nested keys from internal patch callers', async () => {
      const store = new ConfigStore()
      await store.load()

      const updated = await store.patchSettings({
        theme: 'dark',
        terminal: {
          scrollback: 18000,
          fontFamily: 'Fira Code',
          unknownNestedFlag: true,
        },
        sidebar: {
          excludeFirstChatMustStart: true,
          showSubagents: true,
        },
      } as any)

      expect(updated.theme).toBeUndefined()
      expect(updated.terminal.scrollback).toBe(18000)
      expect((updated.terminal as Record<string, unknown>).fontFamily).toBeUndefined()
      expect((updated.terminal as Record<string, unknown>).unknownNestedFlag).toBeUndefined()
      expect(updated.sidebar.excludeFirstChatMustStart).toBe(true)
      expect((updated.sidebar as Record<string, unknown>).showSubagents).toBeUndefined()
    })

    it('can update safety settings', async () => {
      const store = new ConfigStore()
      await store.load()

      const updated = await store.patchSettings({
        safety: { autoKillIdleMinutes: 60 },
      })

      expect(updated.safety.autoKillIdleMinutes).toBe(60)
    })

    it('can set defaultCwd', async () => {
      const store = new ConfigStore()
      await store.load()

      const updated = await store.patchSettings({
        defaultCwd: '/custom/path',
      })

      expect(updated.defaultCwd).toBe('/custom/path')
    })

    it('preserves legacyLocalSettingsSeed and keeps moved local fields out of settings when saving server-backed changes', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      await fsp.writeFile(configPath, JSON.stringify({
        version: 1,
        settings: {
          theme: 'dark',
          terminal: {
            fontFamily: 'Fira Code',
            scrollback: 9000,
          },
          agentChat: {
            defaultPlugins: ['fs'],
          },
        },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }, null, 2))

      const store = new ConfigStore()
      await store.load()

      const updated = await store.patchSettings({
        agentChat: {
          defaultPlugins: ['fs', 'search'],
        },
      })

      expect(updated.agentChat.defaultPlugins).toEqual(['fs', 'search'])

      const saved = JSON.parse(await fsp.readFile(configPath, 'utf-8'))
      expect(saved.legacyLocalSettingsSeed).toEqual({
        theme: 'dark',
        terminal: {
          fontFamily: 'Fira Code',
        },
      })
      expect(saved.settings.theme).toBeUndefined()
      expect(saved.settings.terminal.fontFamily).toBeUndefined()
      expect(saved.settings.agentChat.defaultPlugins).toEqual(['fs', 'search'])
    })

  })

  describe('recent directories', () => {
    it('prepends newest directory and deduplicates existing entries', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.pushRecentDirectory('/projects/a')
      await store.pushRecentDirectory('/projects/b')
      await store.pushRecentDirectory('/projects/a')

      const snapshot = await store.snapshot()
      expect(snapshot.recentDirectories).toEqual(['/projects/a', '/projects/b'])
    })

    it('caps recent directories at 20 entries', async () => {
      const store = new ConfigStore()
      await store.load()

      for (let i = 0; i < 25; i += 1) {
        await store.pushRecentDirectory(`/projects/${i}`)
      }

      const snapshot = await store.snapshot()
      expect(snapshot.recentDirectories).toHaveLength(20)
      expect(snapshot.recentDirectories?.[0]).toBe('/projects/24')
      expect(snapshot.recentDirectories?.[19]).toBe('/projects/5')
    })

    it('ignores empty or whitespace-only paths', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.pushRecentDirectory('   ')
      await store.pushRecentDirectory('')

      const snapshot = await store.snapshot()
      expect(snapshot.recentDirectories).toEqual([])
    })
  })

  describe('session overrides', () => {
    it('getSessionOverride returns undefined for non-existent session', async () => {
      const store = new ConfigStore()
      const override = await store.getSessionOverride('non-existent')
      expect(override).toBeUndefined()
    })

    it('patchSessionOverride creates new override', async () => {
      const store = new ConfigStore()
      await store.load()

      const result = await store.patchSessionOverride('session-1', {
        titleOverride: 'Custom Title',
      })

      expect(result.titleOverride).toBe('Custom Title')
    })

    it('patchSessionOverride merges with existing', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.patchSessionOverride('session-1', { titleOverride: 'Title' })
      const result = await store.patchSessionOverride('session-1', {
        summaryOverride: 'Summary',
      })

      expect(result.titleOverride).toBe('Title')
      expect(result.summaryOverride).toBe('Summary')
    })

    it('preserves archived and createdAtOverride when patching other fields', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.patchSessionOverride('session-1', { archived: true, createdAtOverride: 123 })
      const result = await store.patchSessionOverride('session-1', { titleOverride: 'Updated' })

      expect(result.archived).toBe(true)
      expect(result.createdAtOverride).toBe(123)
      expect(result.titleOverride).toBe('Updated')
    })

    it('deleteSession marks session as deleted', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.deleteSession('session-1')

      const override = await store.getSessionOverride('session-1')
      expect(override?.deleted).toBe(true)
    })
  })

  describe('terminal overrides', () => {
    it('getTerminalOverride returns undefined for non-existent terminal', async () => {
      const store = new ConfigStore()
      const override = await store.getTerminalOverride('non-existent')
      expect(override).toBeUndefined()
    })

    it('patchTerminalOverride creates new override', async () => {
      const store = new ConfigStore()
      await store.load()

      const result = await store.patchTerminalOverride('term-1', {
        titleOverride: 'Custom Terminal',
      })

      expect(result.titleOverride).toBe('Custom Terminal')
    })

    it('deleteTerminal marks terminal as deleted', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.deleteTerminal('term-1')

      const override = await store.getTerminalOverride('term-1')
      expect(override?.deleted).toBe(true)
    })
  })

  describe('project colors', () => {
    it('setProjectColor saves color for project path', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.setProjectColor('/projects/my-app', '#ff5500')

      const colors = await store.getProjectColors()
      expect(colors['/projects/my-app']).toBe('#ff5500')
    })

    it('getProjectColors returns empty object by default', async () => {
      const store = new ConfigStore()
      const colors = await store.getProjectColors()
      expect(colors).toEqual({})
    })

    it('can set multiple project colors', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.setProjectColor('/project1', '#ff0000')
      await store.setProjectColor('/project2', '#00ff00')

      const colors = await store.getProjectColors()
      expect(colors['/project1']).toBe('#ff0000')
      expect(colors['/project2']).toBe('#00ff00')
    })
  })

  describe('snapshot()', () => {
    it('returns current config state', async () => {
      const store = new ConfigStore()
      await store.load()
      await store.patchSettings({ defaultCwd: '/workspace' })

      const snapshot = await store.snapshot()

      expect(snapshot.version).toBe(1)
      expect(snapshot.settings.defaultCwd).toBe('/workspace')
    })
  })

  describe('settings validation (type safety)', () => {
    it('ignores moved local fields when loading malformed mixed settings', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      const invalidConfig = {
        version: 1,
        settings: {
          ...defaultSettings,
          theme: 'invalid-theme',
          terminal: { scrollback: 5000, fontSize: 20 },
        },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }
      await fsp.writeFile(configPath, JSON.stringify(invalidConfig))

      const store = new ConfigStore()
      const config = await store.load()

      expect((config.settings as Record<string, unknown>).theme).toBeUndefined()
      expect(config.settings.terminal.scrollback).toBe(5000)
      expect(config.legacyLocalSettingsSeed).toEqual({
        terminal: { fontSize: 20 },
      })
    })

    it('agentChat defaultPlugins survives load and patch', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      const existingConfig: UserConfig = {
        version: 1,
        settings: {
          ...defaultSettings,
          agentChat: {
            ...defaultSettings.agentChat,
            defaultPlugins: ['fs'],
          },
        },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }
      await fsp.writeFile(configPath, JSON.stringify(existingConfig))

      const store = new ConfigStore()
      const loaded = await store.load()
      expect(loaded.settings.agentChat.defaultPlugins).toEqual(['fs'])

      const updated = await store.patchSettings({
        agentChat: { defaultPlugins: ['fs', 'search'] },
      })

      expect(updated.agentChat.defaultPlugins).toEqual(['fs', 'search'])
    })

    it('terminal scrollback accepts number values', async () => {
      const store = new ConfigStore()
      await store.load()

      const updated = await store.patchSettings({
        terminal: { scrollback: 10000 },
      })

      expect(updated.terminal.scrollback).toBe(10000)
    })

    it('preserves runtime CLI providers when loading and saving config', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      const existingConfig: UserConfig = {
        version: 1,
        settings: {
          ...defaultSettings,
          codingCli: {
            ...defaultSettings.codingCli,
            enabledProviders: ['claude', 'gemini'],
            knownProviders: ['claude', 'codex', 'opencode', 'gemini'],
            providers: {
              ...defaultSettings.codingCli.providers,
              gemini: {
                cwd: '/workspace/gemini',
                model: 'gemini-2.5-pro',
              },
            },
          },
        },
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }
      await fsp.writeFile(configPath, JSON.stringify(existingConfig, null, 2))

      const store = new ConfigStore()
      const loaded = await store.load()

      expect(loaded.settings.codingCli.enabledProviders).toEqual(['claude', 'gemini'])
      expect(loaded.settings.codingCli.knownProviders).toEqual(['claude', 'codex', 'opencode', 'gemini'])
      expect(loaded.settings.codingCli.providers.gemini).toEqual({
        cwd: '/workspace/gemini',
        model: 'gemini-2.5-pro',
      })

      const updated = await store.patchSettings({ defaultCwd: '/workspace' })

      expect(updated.defaultCwd).toBe('/workspace')
      expect(updated.codingCli.enabledProviders).toEqual(['claude', 'gemini'])
      expect(updated.codingCli.knownProviders).toEqual(['claude', 'codex', 'opencode', 'gemini'])
      expect(updated.codingCli.providers.gemini).toEqual({
        cwd: '/workspace/gemini',
        model: 'gemini-2.5-pro',
      })

      const saved = JSON.parse(await fsp.readFile(configPath, 'utf-8'))
      expect(saved.settings.codingCli.enabledProviders).toEqual(['claude', 'gemini'])
      expect(saved.settings.codingCli.knownProviders).toEqual(['claude', 'codex', 'opencode', 'gemini'])
      expect(saved.settings.codingCli.providers.gemini).toEqual({
        cwd: '/workspace/gemini',
        model: 'gemini-2.5-pro',
      })
    })
  })

  describe('agentChat defaults', () => {
    it('patchSettings merges agentChat providers', async () => {
      const store = new ConfigStore()
      await store.load()

      const updated = await store.patchSettings({
        agentChat: { providers: { freshclaude: { defaultModel: 'claude-sonnet-4-5-20250929' } } },
      })

      expect(updated.agentChat?.providers?.freshclaude?.defaultModel).toBe('claude-sonnet-4-5-20250929')
    })

    it('patchSettings deep-merges agentChat providers without clobbering other keys', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.patchSettings({
        agentChat: { providers: { freshclaude: { defaultModel: 'claude-opus-4-6', defaultEffort: 'high' } } },
      })
      const updated = await store.patchSettings({
        agentChat: { providers: { freshclaude: { defaultPermissionMode: 'default' } } },
      })

      expect(updated.agentChat?.providers?.freshclaude?.defaultModel).toBe('claude-opus-4-6')
      expect(updated.agentChat?.providers?.freshclaude?.defaultPermissionMode).toBe('default')
      expect(updated.agentChat?.providers?.freshclaude?.defaultEffort).toBe('high')
    })

    it('defaultSettings includes empty agentChat providers', () => {
      expect(defaultSettings.agentChat).toEqual({ defaultPlugins: [], providers: {} })
    })

    it('migrates legacy flat freshclaude settings to agentChat.providers.freshclaude on load', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      const legacyConfig: UserConfig = {
        version: 1,
        settings: {
          ...defaultSettings,
          freshclaude: { defaultModel: 'claude-opus-4-6', defaultEffort: 'high' },
        } as any,
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }
      delete (legacyConfig.settings as any).agentChat
      await fsp.writeFile(configPath, JSON.stringify(legacyConfig, null, 2))

      const store = new ConfigStore()
      const loaded = await store.load()

      expect(loaded.settings.agentChat?.providers?.freshclaude?.defaultModel).toBe('claude-opus-4-6')
      expect(loaded.settings.agentChat?.providers?.freshclaude?.defaultEffort).toBe('high')
      expect((loaded.settings as any).freshclaude).toBeUndefined()
    })

    it('merges legacy freshclaude into existing agentChat.providers.freshclaude on load', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      const mixedConfig: UserConfig = {
        version: 1,
        settings: {
          ...defaultSettings,
          freshclaude: { defaultModel: 'claude-opus-4-6', defaultEffort: 'high' },
          agentChat: { providers: { freshclaude: { defaultPermissionMode: 'normal' } } },
        } as any,
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }
      await fsp.writeFile(configPath, JSON.stringify(mixedConfig, null, 2))

      const store = new ConfigStore()
      const loaded = await store.load()

      // agentChat value wins over legacy for overlapping keys
      expect(loaded.settings.agentChat?.providers?.freshclaude?.defaultPermissionMode).toBe('normal')
      // Legacy-only keys are preserved
      expect(loaded.settings.agentChat?.providers?.freshclaude?.defaultModel).toBe('claude-opus-4-6')
      expect(loaded.settings.agentChat?.providers?.freshclaude?.defaultEffort).toBe('high')
      // Legacy key removed
      expect((loaded.settings as any).freshclaude).toBeUndefined()
    })
  })

  describe('network settings', () => {
    it('should include network defaults with host 127.0.0.1 and configured false', async () => {
      const store = new ConfigStore()
      const settings = await store.getSettings()
      expect(settings.network).toEqual({
        host: '127.0.0.1',
        configured: false,
      })
    })

    it('should persist network settings through patch', async () => {
      const store = new ConfigStore()
      await store.patchSettings({
        network: {
          host: '0.0.0.0',
          configured: true,
        },
      })
      const settings = await store.getSettings()
      expect(settings.network).toEqual({
        host: '0.0.0.0',
        configured: true,
      })
    })

    it('should merge partial network settings with existing values', async () => {
      const store = new ConfigStore()
      // First: set all network fields explicitly
      await store.patchSettings({
        network: { host: '0.0.0.0', configured: true },
      })
      // Second: patch ONLY host — configured should be preserved
      await store.patchSettings({
        network: { host: '127.0.0.1' },
      } as any)
      const settings = await store.getSettings()
      expect(settings.network.host).toBe('127.0.0.1')
      expect(settings.network.configured).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('handles empty settings object in file', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      await fsp.writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          settings: {},
          sessionOverrides: {},
          terminalOverrides: {},
          projectColors: {},
        })
      )

      const store = new ConfigStore()
      const config = await store.load()

      // Should merge with defaults
      expect(config.settings.defaultCwd).toBe(defaultSettings.defaultCwd)
      expect(config.settings.terminal).toEqual(defaultSettings.terminal)
    })

    it('handles missing optional fields', async () => {
      await fsp.mkdir(configDir, { recursive: true })
      await fsp.writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          settings: defaultSettings,
          // Missing sessionOverrides, terminalOverrides, projectColors
        })
      )

      const store = new ConfigStore()
      const config = await store.load()

      expect(config.sessionOverrides).toEqual({})
      expect(config.terminalOverrides).toEqual({})
      expect(config.projectColors).toEqual({})
    })

    it('sequential saves maintain valid JSON', async () => {
      const store = new ConfigStore()
      await store.load()

      // Run saves sequentially
      await store.patchSettings({ defaultCwd: '/workspace' })
      await store.setProjectColor('/p1', '#000')
      await store.patchSessionOverride('s1', { titleOverride: 'T1' })

      // File should still be valid JSON
      const raw = await fsp.readFile(configPath, 'utf-8')
      expect(() => JSON.parse(raw)).not.toThrow()

      // Verify all changes were persisted
      const parsed = JSON.parse(raw)
      expect(parsed.settings.defaultCwd).toBe('/workspace')
      expect(parsed.projectColors['/p1']).toBe('#000')
      expect(parsed.sessionOverrides['s1'].titleOverride).toBe('T1')
    })
  })
})
