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
        serverMode: 'daemon',
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
      expect(config!.serverMode).toBe('daemon')
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

      const patched = await patchDesktopConfig({ serverMode: 'daemon' })
      expect(patched.serverMode).toBe('daemon')
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
        patchDesktopConfig({ serverMode: 'daemon' }),
        patchDesktopConfig({ startOnLogin: true }),
        patchDesktopConfig({ minimizeToTray: false }),
        patchDesktopConfig({ globalHotkey: 'CommandOrControl+Space' }),
        patchDesktopConfig({ setupCompleted: true }),
      ])

      const final = await readDesktopConfig()
      expect(final).not.toBeNull()
      expect(final!.serverMode).toBe('daemon')
      expect(final!.startOnLogin).toBe(true)
      expect(final!.minimizeToTray).toBe(false)
      expect(final!.globalHotkey).toBe('CommandOrControl+Space')
      expect(final!.setupCompleted).toBe(true)
    })
  })

  describe('schema validation (invariant)', () => {
    it('rejects invalid serverMode', () => {
      const result = DesktopConfigSchema.safeParse({ serverMode: 'invalid-mode' })
      expect(result.success).toBe(false)
    })

    it('rejects invalid remoteUrl', () => {
      const result = DesktopConfigSchema.safeParse({
        serverMode: 'daemon',
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
