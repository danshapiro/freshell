import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

// Mock logger to avoid pino setup in test
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('../../../server/logger', () => ({ logger: mockLogger }))

import { ExtensionManager, type ExtensionRegistryEntry, type ClientExtensionEntry } from '../../../server/extension-manager.js'

// ── Helpers ──

/** Minimal valid server extension manifest */
function serverManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-server',
    version: '1.0.0',
    label: 'Test Server',
    description: 'A test server extension',
    category: 'server',
    server: {
      command: 'node',
      args: ['index.js'],
    },
    ...overrides,
  }
}

/** Minimal valid client extension manifest */
function clientManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-client',
    version: '2.0.0',
    label: 'Test Client',
    description: 'A test client extension',
    category: 'client',
    client: { entry: './index.html' },
    ...overrides,
  }
}

/** Minimal valid CLI extension manifest */
function cliManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-cli',
    version: '0.1.0',
    label: 'Test CLI',
    description: 'A test CLI extension',
    category: 'cli',
    cli: { command: 'htop' },
    ...overrides,
  }
}

/** Write a freshell.json manifest inside a named extension dir */
async function writeExtension(
  parentDir: string,
  dirName: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const extDir = path.join(parentDir, dirName)
  await fsp.mkdir(extDir, { recursive: true })
  await fsp.writeFile(
    path.join(extDir, 'freshell.json'),
    JSON.stringify(manifest, null, 2),
  )
  return extDir
}

describe('ExtensionManager', () => {
  let tempDir: string
  let extDir1: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ext-mgr-test-'))
    extDir1 = path.join(tempDir, 'extensions')
    await fsp.mkdir(extDir1, { recursive: true })
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  // ── Discovery ──

  describe('scan()', () => {
    it('discovers extensions with valid manifests', async () => {
      await writeExtension(extDir1, 'my-server', serverManifest())
      await writeExtension(extDir1, 'my-client', clientManifest())

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      expect(mgr.getAll()).toHaveLength(2)
      expect(mgr.get('test-server')).toBeDefined()
      expect(mgr.get('test-client')).toBeDefined()
    })

    it('stores the filesystem path for each entry', async () => {
      const extPath = await writeExtension(extDir1, 'my-server', serverManifest())

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      const entry = mgr.get('test-server')
      expect(entry?.path).toBe(extPath)
    })

    it('skips directories without freshell.json', async () => {
      // Create a dir without a manifest
      await fsp.mkdir(path.join(extDir1, 'no-manifest'), { recursive: true })
      await writeExtension(extDir1, 'valid', serverManifest())

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      expect(mgr.getAll()).toHaveLength(1)
      expect(mgr.get('test-server')).toBeDefined()
    })

    it('skips invalid manifests and logs a warning', async () => {
      // Write manifest missing required fields
      await writeExtension(extDir1, 'bad-ext', { name: 'bad' })
      await writeExtension(extDir1, 'good-ext', serverManifest())

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      expect(mgr.getAll()).toHaveLength(1)
      expect(mgr.get('test-server')).toBeDefined()
      expect(mgr.get('bad')).toBeUndefined()
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('skips duplicate names and logs a warning (first wins)', async () => {
      const dir2 = path.join(tempDir, 'extensions2')
      await fsp.mkdir(dir2, { recursive: true })

      // Same name in both dirs — first dir should win
      await writeExtension(extDir1, 'ext-a', serverManifest({ name: 'dup-ext', version: '1.0.0' }))
      await writeExtension(dir2, 'ext-b', clientManifest({ name: 'dup-ext', version: '2.0.0' }))

      const mgr = new ExtensionManager()
      mgr.scan([extDir1, dir2])

      expect(mgr.getAll()).toHaveLength(1)
      const entry = mgr.get('dup-ext')
      expect(entry?.manifest.version).toBe('1.0.0')
      expect(entry?.manifest.category).toBe('server')
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('scans multiple directories', async () => {
      const dir2 = path.join(tempDir, 'extensions2')
      await fsp.mkdir(dir2, { recursive: true })

      await writeExtension(extDir1, 'ext-a', serverManifest({ name: 'ext-a' }))
      await writeExtension(dir2, 'ext-b', clientManifest({ name: 'ext-b' }))

      const mgr = new ExtensionManager()
      mgr.scan([extDir1, dir2])

      expect(mgr.getAll()).toHaveLength(2)
      expect(mgr.get('ext-a')).toBeDefined()
      expect(mgr.get('ext-b')).toBeDefined()
    })

    it('skips non-existent directories gracefully', async () => {
      await writeExtension(extDir1, 'real-ext', serverManifest())

      const mgr = new ExtensionManager()
      mgr.scan(['/nonexistent/path/that/does/not/exist', extDir1])

      expect(mgr.getAll()).toHaveLength(1)
      expect(mgr.get('test-server')).toBeDefined()
    })

    it('clears existing registry on re-scan', async () => {
      await writeExtension(extDir1, 'ext-a', serverManifest({ name: 'ext-a' }))

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])
      expect(mgr.getAll()).toHaveLength(1)

      // Re-scan with an empty dir
      const emptyDir = path.join(tempDir, 'empty')
      await fsp.mkdir(emptyDir, { recursive: true })
      mgr.scan([emptyDir])
      expect(mgr.getAll()).toHaveLength(0)
    })

    it('follows symlinks to extension directories', async () => {
      // Create the real extension dir outside the scan dir
      const realExtDir = path.join(tempDir, 'real-ext')
      await fsp.mkdir(realExtDir, { recursive: true })
      await fsp.writeFile(
        path.join(realExtDir, 'freshell.json'),
        JSON.stringify(serverManifest({ name: 'symlinked' })),
      )

      // Symlink it into the scan dir
      await fsp.symlink(realExtDir, path.join(extDir1, 'linked-ext'))

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      expect(mgr.get('symlinked')).toBeDefined()
    })

    it('skips files (non-directories) in scan dir', async () => {
      // Write a regular file in the scan dir
      await fsp.writeFile(path.join(extDir1, 'not-a-dir.txt'), 'hello')
      await writeExtension(extDir1, 'valid', serverManifest())

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      expect(mgr.getAll()).toHaveLength(1)
    })

    it('handles malformed JSON gracefully', async () => {
      const extPath = path.join(extDir1, 'bad-json')
      await fsp.mkdir(extPath, { recursive: true })
      await fsp.writeFile(path.join(extPath, 'freshell.json'), '{ not valid json }')
      await writeExtension(extDir1, 'good', serverManifest())

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      expect(mgr.getAll()).toHaveLength(1)
      expect(mockLogger.warn).toHaveBeenCalled()
    })
  })

  // ── Registry accessors ──

  describe('get()', () => {
    it('returns undefined for unknown names', () => {
      const mgr = new ExtensionManager()
      expect(mgr.get('nonexistent')).toBeUndefined()
    })

    it('returns the entry with parsed manifest', async () => {
      await writeExtension(extDir1, 'ext', serverManifest())

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      const entry = mgr.get('test-server')
      expect(entry).toBeDefined()
      expect(entry!.manifest.name).toBe('test-server')
      expect(entry!.manifest.category).toBe('server')
      expect(entry!.serverPort).toBeUndefined()
    })
  })

  describe('getAll()', () => {
    it('returns empty array when nothing is registered', () => {
      const mgr = new ExtensionManager()
      expect(mgr.getAll()).toEqual([])
    })

    it('returns all registered entries', async () => {
      await writeExtension(extDir1, 'a', serverManifest({ name: 'a' }))
      await writeExtension(extDir1, 'b', clientManifest({ name: 'b' }))
      await writeExtension(extDir1, 'c', cliManifest({ name: 'c' }))

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      const all = mgr.getAll()
      expect(all).toHaveLength(3)
      const names = all.map((e) => e.manifest.name).sort()
      expect(names).toEqual(['a', 'b', 'c'])
    })
  })

  // ── Client serialization ──

  describe('toClientRegistry()', () => {
    it('returns serialized entries without filesystem paths', async () => {
      await writeExtension(extDir1, 'ext', serverManifest())

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      const clientEntries = mgr.toClientRegistry()
      expect(clientEntries).toHaveLength(1)

      const entry = clientEntries[0]
      expect(entry.name).toBe('test-server')
      expect(entry.version).toBe('1.0.0')
      expect(entry.label).toBe('Test Server')
      expect(entry.description).toBe('A test server extension')
      expect(entry.category).toBe('server')
      expect(entry.serverRunning).toBe(false)
      expect(entry.serverPort).toBeUndefined()

      // Must NOT contain filesystem path
      expect(entry).not.toHaveProperty('path')
      // Shouldn't leak manifest object either
      expect(entry).not.toHaveProperty('manifest')
    })

    it('includes iconUrl when manifest has icon field', async () => {
      await writeExtension(extDir1, 'ext', serverManifest({ icon: './icon.svg' }))

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      const entry = mgr.toClientRegistry()[0]
      expect(entry.iconUrl).toBe('/api/extensions/test-server/icon')
    })

    it('omits iconUrl when manifest has no icon field', async () => {
      await writeExtension(extDir1, 'ext', serverManifest())

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      const entry = mgr.toClientRegistry()[0]
      expect(entry.iconUrl).toBeUndefined()
    })

    it('encodes extension name in iconUrl', async () => {
      await writeExtension(
        extDir1,
        'ext',
        serverManifest({ name: 'my ext/special', icon: './icon.png' }),
      )

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      const entry = mgr.toClientRegistry()[0]
      expect(entry.iconUrl).toBe(`/api/extensions/${encodeURIComponent('my ext/special')}/icon`)
    })

    it('includes url from manifest', async () => {
      await writeExtension(extDir1, 'ext', clientManifest({ url: '/dashboard/{{id}}' }))

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      const entry = mgr.toClientRegistry()[0]
      expect(entry.url).toBe('/dashboard/{{id}}')
    })

    it('includes contentSchema from manifest', async () => {
      const manifest = serverManifest({
        contentSchema: {
          runId: { type: 'string', label: 'Run ID', required: true },
        },
      })
      await writeExtension(extDir1, 'ext', manifest)

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      const entry = mgr.toClientRegistry()[0]
      expect(entry.contentSchema).toEqual({
        runId: { type: 'string', label: 'Run ID', required: true },
      })
    })

    it('includes picker config from manifest', async () => {
      const manifest = clientManifest({
        picker: { shortcut: 'K', group: 'tools' },
      })
      await writeExtension(extDir1, 'ext', manifest)

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      const entry = mgr.toClientRegistry()[0]
      expect(entry.picker).toEqual({ shortcut: 'K', group: 'tools' })
    })

    it('includes serverPort when set on entry', async () => {
      await writeExtension(extDir1, 'ext', serverManifest())

      const mgr = new ExtensionManager()
      mgr.scan([extDir1])

      // Simulate Task 3 setting the port
      const entry = mgr.get('test-server')!
      entry.serverPort = 9876

      const clientEntries = mgr.toClientRegistry()
      expect(clientEntries[0].serverPort).toBe(9876)
    })

    it('returns empty array when no extensions registered', () => {
      const mgr = new ExtensionManager()
      expect(mgr.toClientRegistry()).toEqual([])
    })
  })
})
