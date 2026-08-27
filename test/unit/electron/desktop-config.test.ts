import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Mock os.homedir to use a temp directory
const mockState = vi.hoisted(() => ({
  homeDir: '',
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
  readDesktopConfig,
  writeDesktopConfig,
  patchDesktopConfig,
  getDefaultDesktopConfig,
  _resetMutexForTesting,
} from '../../../electron/desktop-config.js'
import { DesktopConfigSchema, type DesktopConfig } from '../../../electron/types.js'

describe('DesktopConfig', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'desktop-config-test-'))
    mockState.homeDir = tempDir
    // Reset the module-level mutex chain so prior test state doesn't leak
    _resetMutexForTesting()
  })

  afterEach(async () => {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('getDefaultDesktopConfig', () => {
    it('returns defaults with app-bound server mode', () => {
      const config = getDefaultDesktopConfig()
      expect(config.serverMode).toBe('app-bound')
      expect(config.setupCompleted).toBe(false)
      expect(config.minimizeToTray).toBe(true)
      expect(config.startOnLogin).toBe(false)
      expect(config.globalHotkey).toBe('CommandOrControl+`')
    })
  })

  describe('readDesktopConfig', () => {
    it('returns null when file does not exist', async () => {
      const config = await readDesktopConfig()
      expect(config).toBeNull()
    })

    it('reads config from desktop.json when file exists', async () => {
      const freshellDir = path.join(tempDir, '.freshell')
      await fsp.mkdir(freshellDir, { recursive: true })
      const configData: DesktopConfig = {
        serverMode: 'app-bound',
        globalHotkey: 'CommandOrControl+`',
        startOnLogin: true,
        minimizeToTray: true,
        setupCompleted: true,
      }
      await fsp.writeFile(
        path.join(freshellDir, 'desktop.json'),
        JSON.stringify(configData),
      )

      const config = await readDesktopConfig()
      expect(config).not.toBeNull()
      expect(config!.serverMode).toBe('app-bound')
      expect(config!.startOnLogin).toBe(true)
      expect(config!.setupCompleted).toBe(true)
    })

    it('returns null for invalid JSON', async () => {
      const freshellDir = path.join(tempDir, '.freshell')
      await fsp.mkdir(freshellDir, { recursive: true })
      await fsp.writeFile(
        path.join(freshellDir, 'desktop.json'),
        '{{{invalid json',
      )

      const config = await readDesktopConfig()
      expect(config).toBeNull()
    })

    it('returns null for valid JSON but invalid schema', async () => {
      const freshellDir = path.join(tempDir, '.freshell')
      await fsp.mkdir(freshellDir, { recursive: true })
      await fsp.writeFile(
        path.join(freshellDir, 'desktop.json'),
        JSON.stringify({ serverMode: 42 }),
      )

      const config = await readDesktopConfig()
      expect(config).toBeNull()
    })

    it('migrates persisted daemon mode atomically and emits one redacted notice', async () => {
      const freshellDir = path.join(tempDir, '.freshell')
      await fsp.mkdir(freshellDir, { recursive: true })
      const persisted = {
        serverMode: 'daemon',
        port: 4321,
        remoteUrl: 'https://remote.example.test:4321',
        remoteToken: 'do-not-log-this-token',
        knownServers: [{ url: 'http://localhost:4321', label: 'saved' }],
        alwaysAskOnLaunch: true,
        globalHotkey: 'CommandOrControl+Space',
        startOnLogin: true,
        minimizeToTray: false,
        setupCompleted: true,
        windowState: { x: 1, y: 2, width: 3, height: 4, maximized: true },
      }
      const desktopJson = path.join(freshellDir, 'desktop.json')
      await fsp.writeFile(desktopJson, JSON.stringify(persisted))
      const notice = vi.spyOn(console, 'info').mockImplementation(() => {})

      const migrated = await readDesktopConfig()
      expect(migrated?.serverMode).toBe('app-bound')
      expect(migrated).toMatchObject({
        port: 4321,
        remoteUrl: persisted.remoteUrl,
        remoteToken: persisted.remoteToken,
        knownServers: persisted.knownServers,
        alwaysAskOnLaunch: true,
        globalHotkey: persisted.globalHotkey,
        startOnLogin: true,
        minimizeToTray: false,
        setupCompleted: true,
        windowState: persisted.windowState,
      })

      const saved = JSON.parse(await fsp.readFile(desktopJson, 'utf8'))
      expect(saved).toMatchObject({ ...persisted, serverMode: 'app-bound' })
      expect(notice).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(String(notice.mock.calls[0]?.[0])) as Record<string, unknown>
      expect(payload).toMatchObject({
        severity: 'info',
        event: 'desktop_config_migrated',
        from: 'daemon',
        to: 'app-bound',
      })
      expect(String(notice.mock.calls[0]?.[0])).not.toContain(persisted.remoteToken)

      await readDesktopConfig()
      expect(notice).toHaveBeenCalledTimes(1)
      notice.mockRestore()
    })
  })

  describe('writeDesktopConfig', () => {
    it('writes config atomically (temp file + rename)', async () => {
      const config = getDefaultDesktopConfig()
      await writeDesktopConfig(config)

      const freshellDir = path.join(tempDir, '.freshell')
      const desktopJson = path.join(freshellDir, 'desktop.json')
      const content = await fsp.readFile(desktopJson, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.serverMode).toBe('app-bound')
    })

    it('does NOT touch config.json', async () => {
      const config = getDefaultDesktopConfig()
      await writeDesktopConfig(config)

      const freshellDir = path.join(tempDir, '.freshell')
      const configJson = path.join(freshellDir, 'config.json')
      const exists = fs.existsSync(configJson)
      expect(exists).toBe(false)
    })

    it('creates .freshell directory if it does not exist', async () => {
      const config = getDefaultDesktopConfig()
      await writeDesktopConfig(config)

      const freshellDir = path.join(tempDir, '.freshell')
      const stats = await fsp.stat(freshellDir)
      expect(stats.isDirectory()).toBe(true)
    })
  })

  describe('patchDesktopConfig', () => {
    it('merges patch correctly (read-modify-write)', async () => {
      const config = getDefaultDesktopConfig()
      await writeDesktopConfig(config)

      const patched = await patchDesktopConfig({ serverMode: 'app-bound' })
      expect(patched.serverMode).toBe('app-bound')
      expect(patched.minimizeToTray).toBe(true) // preserved from default
    })

    it('creates config with defaults if file does not exist', async () => {
      const patched = await patchDesktopConfig({ serverMode: 'remote', remoteUrl: 'http://10.0.0.5:3001' })
      expect(patched.serverMode).toBe('remote')
      expect(patched.remoteUrl).toBe('http://10.0.0.5:3001')
      expect(patched.minimizeToTray).toBe(true) // default
    })

    it('mutex is reset between tests (no cross-test state leakage)', async () => {
      // After _resetMutexForTesting() in beforeEach, a patch should work
      // immediately without being chained onto a prior test's work
      const patched = await patchDesktopConfig({ setupCompleted: true })
      expect(patched.setupCompleted).toBe(true)
    })

    it('concurrent patches are serialized by mutex (no lost updates)', async () => {
      await writeDesktopConfig(getDefaultDesktopConfig())

      // Fire 5 concurrent patches, each setting a different field
      await Promise.all([
        patchDesktopConfig({ serverMode: 'app-bound' }),
        patchDesktopConfig({ startOnLogin: true }),
        patchDesktopConfig({ minimizeToTray: false }),
        patchDesktopConfig({ globalHotkey: 'CommandOrControl+Space' }),
        patchDesktopConfig({ setupCompleted: true }),
      ])

      const final = await readDesktopConfig()
      expect(final).not.toBeNull()
      expect(final!.serverMode).toBe('app-bound')
      expect(final!.startOnLogin).toBe(true)
      expect(final!.minimizeToTray).toBe(false)
      expect(final!.globalHotkey).toBe('CommandOrControl+Space')
      expect(final!.setupCompleted).toBe(true)
    })
  })

  describe('port field', () => {
    it('defaults port to 3001 when not specified', () => {
      const config = getDefaultDesktopConfig()
      expect(config.port).toBe(3001)
    })

    it('schema defaults port to 3001 when not provided', () => {
      const result = DesktopConfigSchema.parse({
        serverMode: 'app-bound',
      })
      expect(result.port).toBe(3001)
    })

    it('preserves custom port from config file', async () => {
      const freshellDir = path.join(tempDir, '.freshell')
      await fsp.mkdir(freshellDir, { recursive: true })
      await fsp.writeFile(
        path.join(freshellDir, 'desktop.json'),
        JSON.stringify({
          serverMode: 'app-bound',
          port: 8080,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        }),
      )

      const config = await readDesktopConfig()
      expect(config).not.toBeNull()
      expect(config!.port).toBe(8080)
    })

    it('patches port correctly', async () => {
      await writeDesktopConfig(getDefaultDesktopConfig())
      const patched = await patchDesktopConfig({ port: 9999 })
      expect(patched.port).toBe(9999)

      // Verify it persisted
      const reRead = await readDesktopConfig()
      expect(reRead!.port).toBe(9999)
    })
  })

  describe('launch chooser fields', () => {
    it('defaults alwaysAskOnLaunch to false', () => {
      const config = getDefaultDesktopConfig()
      expect(config.alwaysAskOnLaunch).toBe(false)
    })

    it('schema defaults alwaysAskOnLaunch to false when omitted', () => {
      const result = DesktopConfigSchema.parse({
        serverMode: 'app-bound',
      })
      expect(result.alwaysAskOnLaunch).toBe(false)
    })

    it('preserves known servers from config file', async () => {
      const freshellDir = path.join(tempDir, '.freshell')
      await fsp.mkdir(freshellDir, { recursive: true })
      await fsp.writeFile(
        path.join(freshellDir, 'desktop.json'),
        JSON.stringify({
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://10.0.0.5:3001',
          remoteToken: 'vpn-token',
          knownServers: [
            {
              url: 'http://localhost:3001',
              label: 'Local dev server',
              lastConnectedAt: '2026-05-24T18:00:00.000Z',
            },
          ],
          alwaysAskOnLaunch: true,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        }),
      )

      const config = await readDesktopConfig()
      expect(config).not.toBeNull()
      expect(config!.alwaysAskOnLaunch).toBe(true)
      expect(config!.knownServers).toEqual([
        {
          url: 'http://localhost:3001',
          label: 'Local dev server',
          lastConnectedAt: '2026-05-24T18:00:00.000Z',
        },
      ])
    })

    it('patches alwaysAskOnLaunch and knownServers', async () => {
      await writeDesktopConfig(getDefaultDesktopConfig())

      const patched = await patchDesktopConfig({
        alwaysAskOnLaunch: true,
        knownServers: [
          {
            url: 'http://localhost:3002',
            label: 'Local 3002',
            lastConnectedAt: '2026-05-24T18:05:00.000Z',
          },
        ],
      })

      expect(patched.alwaysAskOnLaunch).toBe(true)
      expect(patched.knownServers).toEqual([
        {
          url: 'http://localhost:3002',
          label: 'Local 3002',
          lastConnectedAt: '2026-05-24T18:05:00.000Z',
        },
      ])
    })
  })

  describe('schema validation (invariant)', () => {
    it('rejects invalid serverMode', () => {
      const result = DesktopConfigSchema.safeParse({ serverMode: 'invalid-mode' })
      expect(result.success).toBe(false)
    })

    it('rejects invalid remoteUrl', () => {
      const result = DesktopConfigSchema.safeParse({
        serverMode: 'app-bound',
        remoteUrl: 'not-a-url',
      })
      expect(result.success).toBe(false)
    })

    it('accepts valid config', () => {
      const result = DesktopConfigSchema.safeParse({
        serverMode: 'app-bound',
        globalHotkey: 'CommandOrControl+`',
        setupCompleted: false,
        minimizeToTray: true,
        startOnLogin: false,
      })
      expect(result.success).toBe(true)
    })
  })
})
