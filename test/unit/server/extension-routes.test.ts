// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

// Mock logger before importing modules
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('../../../server/logger', () => ({ logger: mockLogger }))

import { ExtensionManager } from '../../../server/extension-manager.js'
import { createExtensionRouter } from '../../../server/extension-routes.js'

// ── Helpers ──

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

describe('extension-routes', () => {
  let tempDir: string
  let extDir: string
  let mgr: ExtensionManager
  let app: express.Express

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ext-routes-test-'))
    extDir = path.join(tempDir, 'extensions')
    await fsp.mkdir(extDir, { recursive: true })
    mgr = new ExtensionManager()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await mgr.stopAll()
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  function createApp(): express.Express {
    const a = express()
    a.use(express.json())
    a.use('/api/extensions', createExtensionRouter(mgr))
    return a
  }

  // ── GET / — list all extensions ──

  describe('GET /api/extensions', () => {
    it('returns empty array when no extensions registered', async () => {
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions')
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('returns the client registry for all registered extensions', async () => {
      await writeExtension(extDir, 'srv', serverManifest())
      await writeExtension(extDir, 'cli', clientManifest())
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(2)

      const names = res.body.map((e: any) => e.name)
      expect(names).toContain('test-server')
      expect(names).toContain('test-client')
    })
  })

  // ── GET /:name — single extension details ──

  describe('GET /api/extensions/:name', () => {
    it('returns a single extension by name', async () => {
      await writeExtension(extDir, 'srv', serverManifest())
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions/test-server')
      expect(res.status).toBe(200)
      expect(res.body.name).toBe('test-server')
      expect(res.body.version).toBe('1.0.0')
      expect(res.body.category).toBe('server')
    })

    it('returns 404 for unknown extension', async () => {
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions/nope')
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/not found/i)
    })
  })

  // ── POST /:name/start — start server extension ──

  describe('POST /api/extensions/:name/start', () => {
    it('returns 404 for unknown extension', async () => {
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).post('/api/extensions/nope/start')
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/not found/i)
    })

    it('returns 400 for non-server extension', async () => {
      await writeExtension(extDir, 'cli', clientManifest())
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).post('/api/extensions/test-client/start')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/not a server extension/i)
    })

    it('starts a server extension and returns port', async () => {
      // Stub startServer to avoid spawning real processes
      const startServerSpy = vi.spyOn(mgr, 'startServer').mockResolvedValue(9999)
      await writeExtension(extDir, 'srv', serverManifest())
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).post('/api/extensions/test-server/start')
      expect(res.status).toBe(200)
      expect(res.body.port).toBe(9999)
      expect(startServerSpy).toHaveBeenCalledWith('test-server')
    })

    it('returns 500 when startServer throws', async () => {
      vi.spyOn(mgr, 'startServer').mockRejectedValue(new Error('spawn failed'))
      await writeExtension(extDir, 'srv', serverManifest())
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).post('/api/extensions/test-server/start')
      expect(res.status).toBe(500)
      expect(res.body.error).toMatch(/spawn failed/i)
    })
  })

  // ── POST /:name/stop — stop server extension ──

  describe('POST /api/extensions/:name/stop', () => {
    it('returns 404 for unknown extension', async () => {
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).post('/api/extensions/nope/stop')
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/not found/i)
    })

    it('stops a running server extension', async () => {
      const stopServerSpy = vi.spyOn(mgr, 'stopServer').mockResolvedValue()
      await writeExtension(extDir, 'srv', serverManifest())
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).post('/api/extensions/test-server/stop')
      expect(res.status).toBe(200)
      expect(stopServerSpy).toHaveBeenCalledWith('test-server')
    })
  })

  // ── GET /:name/client/* — serve client extension files ──

  describe('GET /api/extensions/:name/client/*', () => {
    it('returns 404 for unknown extension', async () => {
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions/nope/client/index.html')
      expect(res.status).toBe(404)
    })

    it('returns 400 for non-client extension', async () => {
      await writeExtension(extDir, 'srv', serverManifest())
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions/test-server/client/index.html')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/not a client extension/i)
    })

    it('serves a file from the client extension directory', async () => {
      const htmlContent = '<html><body>Hello</body></html>'
      const extPath = await writeExtension(extDir, 'cli', clientManifest())
      await fsp.writeFile(path.join(extPath, 'index.html'), htmlContent)
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions/test-client/client/index.html')
      expect(res.status).toBe(200)
      expect(res.text).toBe(htmlContent)
    })

    it('returns 404 for missing file', async () => {
      await writeExtension(extDir, 'cli', clientManifest())
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions/test-client/client/nonexistent.html')
      expect(res.status).toBe(404)
    })

    it('scopes file serving to client entry directory', async () => {
      // Extension with client.entry in a subdirectory
      const extPath = await writeExtension(extDir, 'cli-sub', {
        ...clientManifest({ name: 'test-sub-client' }),
        client: { entry: './public/index.html' },
      })
      await fsp.mkdir(path.join(extPath, 'public'), { recursive: true })
      await fsp.writeFile(path.join(extPath, 'public', 'index.html'), '<html>OK</html>')
      await fsp.writeFile(path.join(extPath, 'secret.txt'), 'secret data')
      mgr.scan([extDir])
      app = createApp()

      // File in public dir should be accessible
      const ok = await request(app).get('/api/extensions/test-sub-client/client/index.html')
      expect(ok.status).toBe(200)

      // File outside public dir (in extension root) should not be accessible
      const secret = await request(app).get(
        '/api/extensions/test-sub-client/client/..%2Fsecret.txt',
      )
      expect(secret.status).toBe(400)
    })

    it('prevents path traversal via URL-encoded sequences', async () => {
      await writeExtension(extDir, 'cli', clientManifest())
      mgr.scan([extDir])
      app = createApp()

      // URL-encoded ..%2F bypasses Express's built-in path normalization
      const res = await request(app).get(
        '/api/extensions/test-client/client/..%2F..%2F..%2Fetc%2Fpasswd',
      )
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/invalid file path/i)
    })
  })

  // ── GET /:name/icon — serve extension icon ──

  describe('GET /api/extensions/:name/icon', () => {
    it('returns 404 for unknown extension', async () => {
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions/nope/icon')
      expect(res.status).toBe(404)
    })

    it('returns 404 when extension has no icon', async () => {
      await writeExtension(extDir, 'srv', serverManifest())
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions/test-server/icon')
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/no icon/i)
    })

    it('returns 404 when icon file does not exist on disk', async () => {
      await writeExtension(extDir, 'srv', serverManifest({ icon: 'missing.svg' }))
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions/test-server/icon')
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/not found/i)
    })

    it('serves SVG icon with correct content type', async () => {
      const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>'
      const extPath = await writeExtension(extDir, 'srv', serverManifest({ icon: 'icon.svg' }))
      await fsp.writeFile(path.join(extPath, 'icon.svg'), svgContent)
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app)
        .get('/api/extensions/test-server/icon')
        .buffer(true)
        .parse((res, cb) => {
          let data = ''
          res.setEncoding('utf-8')
          res.on('data', (chunk: string) => { data += chunk })
          res.on('end', () => cb(null, data))
        })
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toMatch(/image\/svg\+xml/)
      expect(res.body).toBe(svgContent)
    })

    it('prevents path traversal in icon filename', async () => {
      // Manifest declares icon as a traversal path
      await writeExtension(extDir, 'srv', serverManifest({ icon: '../../../etc/passwd' }))
      mgr.scan([extDir])
      app = createApp()

      const res = await request(app).get('/api/extensions/test-server/icon')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/invalid icon path/i)
    })
  })

  // ── Security edge cases ──

  describe('Security edge cases', () => {
    describe('extension name traversal in route params', () => {
      it('returns 404 for name with encoded ../ traversal', async () => {
        await writeExtension(extDir, 'srv', serverManifest())
        mgr.scan([extDir])
        app = createApp()

        // ..%2F..%2Fetc — URL-encoded path traversal in the :name param
        const res = await request(app).get('/api/extensions/..%2F..%2Fetc')
        expect(res.status).toBe(404)
      })

      it('returns 404 for name with %2e%2e encoded dots', async () => {
        await writeExtension(extDir, 'srv', serverManifest())
        mgr.scan([extDir])
        app = createApp()

        // %2e%2e%2f — dots and slash individually URL-encoded
        const res = await request(app).get('/api/extensions/%2e%2e%2f%2e%2e%2fserver')
        expect(res.status).toBe(404)
      })

      it('returns 404 for name with null byte injection', async () => {
        await writeExtension(extDir, 'srv', serverManifest())
        mgr.scan([extDir])
        app = createApp()

        // Null byte in extension name should not match any real extension
        const res = await request(app).get('/api/extensions/test%00server')
        expect(res.status).toBe(404)
      })

      it('returns 404 for traversal name on start endpoint', async () => {
        await writeExtension(extDir, 'srv', serverManifest())
        mgr.scan([extDir])
        app = createApp()

        const res = await request(app).post('/api/extensions/..%2F..%2Fetc/start')
        expect(res.status).toBe(404)
      })

      it('returns 404 for traversal name on stop endpoint', async () => {
        await writeExtension(extDir, 'srv', serverManifest())
        mgr.scan([extDir])
        app = createApp()

        const res = await request(app).post('/api/extensions/..%2F..%2Fetc/stop')
        expect(res.status).toBe(404)
      })
    })

    describe('double-encoded path traversal in client files', () => {
      it('blocks double-encoded traversal (%252e%252e%252f)', async () => {
        await writeExtension(extDir, 'cli', clientManifest())
        mgr.scan([extDir])
        app = createApp()

        // %252e%252e%252f — double-encoded "../" (Express decodes once → %2e%2e%2f)
        const res = await request(app).get(
          '/api/extensions/test-client/client/%252e%252e%252f%252e%252e%252fetc%252fpasswd',
        )
        // Should be blocked (400) or simply not found (404) — must NOT serve /etc/passwd
        expect([400, 404]).toContain(res.status)
        // Ensure the response is NOT the contents of /etc/passwd
        expect(res.text).not.toMatch(/root:/)
      })

      it('blocks double-encoded dot-slash (%252e%252e/)', async () => {
        await writeExtension(extDir, 'cli', clientManifest())
        mgr.scan([extDir])
        app = createApp()

        const res = await request(app).get(
          '/api/extensions/test-client/client/%252e%252e/%252e%252e/etc/passwd',
        )
        expect([400, 404]).toContain(res.status)
        expect(res.text).not.toMatch(/root:/)
      })

      it('blocks backslash traversal variants', async () => {
        await writeExtension(extDir, 'cli', clientManifest())
        mgr.scan([extDir])
        app = createApp()

        // Backslash variants (common on Windows, but should be blocked everywhere).
        // On macOS/Linux, backslashes are literal filename chars, so path.resolve
        // won't traverse but sendFile may 500 on the non-existent path — that's fine.
        const res = await request(app).get(
          '/api/extensions/test-client/client/..%5C..%5C..%5Cetc%5Cpasswd',
        )
        expect([400, 404, 500]).toContain(res.status)
        expect(res.text).not.toMatch(/root:/)
      })

      it('blocks mixed encoding traversal', async () => {
        await writeExtension(extDir, 'cli', clientManifest())
        mgr.scan([extDir])
        app = createApp()

        // Mix of encoded and literal traversal characters
        const res = await request(app).get(
          '/api/extensions/test-client/client/..%2f..%2f..%2fetc/passwd',
        )
        expect([400, 404]).toContain(res.status)
        expect(res.text).not.toMatch(/root:/)
      })
    })

    describe('icon path traversal variants', () => {
      it('blocks URL-encoded traversal in manifest icon field', async () => {
        // Manifest icon with URL-encoded traversal sequences
        await writeExtension(extDir, 'srv', serverManifest({ icon: '..%2F..%2F..%2Fetc%2Fpasswd' }))
        mgr.scan([extDir])
        app = createApp()

        const res = await request(app).get('/api/extensions/test-server/icon')
        // The encoded dots remain literal in the filename, so path.resolve won't
        // traverse — it'll just be a weird filename that doesn't exist (404) or
        // gets caught by the traversal check (400)
        expect([400, 404]).toContain(res.status)
        expect(res.text).not.toMatch(/root:/)
      })

      it('blocks icon path with backslash traversal', async () => {
        await writeExtension(extDir, 'srv', serverManifest({ icon: '..\\..\\..\\etc\\passwd' }))
        mgr.scan([extDir])
        app = createApp()

        const res = await request(app).get('/api/extensions/test-server/icon')
        expect([400, 404]).toContain(res.status)
        expect(res.text).not.toMatch(/root:/)
      })
    })
  })
})
