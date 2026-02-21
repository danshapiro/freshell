// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'
const SLOW_TEST_TIMEOUT_MS = 20000

describe('Files API Integration', () => {
  let app: Express
  let tempDir: string

  beforeAll(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  })

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'files-api-test-'))

    app = express()
    app.use(express.json({ limit: '1mb' }))

    // Auth middleware
    app.use('/api', (req, res, next) => {
      const token = process.env.AUTH_TOKEN
      if (!token) return res.status(500).json({ error: 'Server misconfigured' })
      const provided = req.headers['x-auth-token'] as string | undefined
      if (!provided || provided !== token) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      next()
    })

    // Import and mount files routes
    const { createFilesRouter } = await import('../../../server/files-router')
    app.use('/api/files', createFilesRouter({
      configStore: {
        getSettings: async () => ({}),
        snapshot: async () => ({ settings: {}, recentDirectories: [] }),
      },
      codingCliIndexer: { getProjects: () => [] },
      registry: { list: () => [] },
    }))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  describe('GET /api/files/read', () => {
    it('returns file content and metadata', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      await fsp.writeFile(filePath, 'Hello, world!')

      const res = await request(app)
        .get('/api/files/read')
        .query({ path: filePath })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.content).toBe('Hello, world!')
      expect(res.body.size).toBe(13)
      expect(res.body.modifiedAt).toBeDefined()
    })

    it('returns 400 if path is missing', async () => {
      const res = await request(app)
        .get('/api/files/read')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('path')
    })

    it('returns 404 if file does not exist', async () => {
      const res = await request(app)
        .get('/api/files/read')
        .query({ path: path.join(tempDir, 'nonexistent.txt') })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(404)
    })

    it('returns 400 for directories', async () => {
      const res = await request(app)
        .get('/api/files/read')
        .query({ path: tempDir })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('directory')
    })
  })

  describe('POST /api/files/write', () => {
    it('writes content to file', async () => {
      const filePath = path.join(tempDir, 'new-file.txt')

      const res = await request(app)
        .post('/api/files/write')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ path: filePath, content: 'New content!' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.modifiedAt).toBeDefined()

      // Verify file was written
      const written = await fsp.readFile(filePath, 'utf-8')
      expect(written).toBe('New content!')
    })

    it('overwrites existing file', async () => {
      const filePath = path.join(tempDir, 'existing.txt')
      await fsp.writeFile(filePath, 'Old content')

      const res = await request(app)
        .post('/api/files/write')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ path: filePath, content: 'Updated!' })

      expect(res.status).toBe(200)

      const written = await fsp.readFile(filePath, 'utf-8')
      expect(written).toBe('Updated!')
    })

    it('creates parent directories if needed', async () => {
      const filePath = path.join(tempDir, 'nested', 'deep', 'file.txt')

      const res = await request(app)
        .post('/api/files/write')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ path: filePath, content: 'Nested content' })

      expect(res.status).toBe(200)

      const written = await fsp.readFile(filePath, 'utf-8')
      expect(written).toBe('Nested content')
    })

    it('returns 400 if path is missing', async () => {
      const res = await request(app)
        .post('/api/files/write')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ content: 'No path' })

      expect(res.status).toBe(400)
    })

    it('returns 400 if content is missing', async () => {
      const res = await request(app)
        .post('/api/files/write')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ path: path.join(tempDir, 'file.txt') })

      expect(res.status).toBe(400)
    }, SLOW_TEST_TIMEOUT_MS)
  })

  describe('GET /api/files/complete', () => {
    beforeEach(async () => {
      // Create test file structure
      await fsp.mkdir(path.join(tempDir, 'src'), { recursive: true })
      await fsp.mkdir(path.join(tempDir, 'docs'), { recursive: true })
      await fsp.writeFile(path.join(tempDir, 'src', 'index.ts'), '')
      await fsp.writeFile(path.join(tempDir, 'src', 'utils.ts'), '')
      await fsp.writeFile(path.join(tempDir, 'docs', 'README.md'), '')
      await fsp.writeFile(path.join(tempDir, 'package.json'), '')
    })

    it('returns suggestions for prefix', async () => {
      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: path.join(tempDir, 'src', '') })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.suggestions).toBeInstanceOf(Array)
      expect(res.body.suggestions.length).toBeGreaterThan(0)

      const paths = res.body.suggestions.map((s: any) => s.path)
      expect(paths).toContain(path.join(tempDir, 'src', 'index.ts'))
      expect(paths).toContain(path.join(tempDir, 'src', 'utils.ts'))
    })

    it('includes isDirectory flag', async () => {
      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: path.join(tempDir, '') })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)

      const srcDir = res.body.suggestions.find((s: any) => s.path.endsWith('src'))
      expect(srcDir).toBeDefined()
      expect(srcDir.isDirectory).toBe(true)

      const pkgJson = res.body.suggestions.find((s: any) => s.path.endsWith('package.json'))
      expect(pkgJson).toBeDefined()
      expect(pkgJson.isDirectory).toBe(false)
    })

    it('returns directories first', async () => {
      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: path.join(tempDir, '') })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)

      const suggestions = res.body.suggestions
      const firstFile = suggestions.findIndex((s: any) => !s.isDirectory)
      const lastDir = suggestions.findLastIndex((s: any) => s.isDirectory)

      if (firstFile !== -1 && lastDir !== -1) {
        expect(lastDir).toBeLessThan(firstFile)
      }
    })

    it('returns only directories when dirs=true is provided', async () => {
      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: path.join(tempDir, ''), dirs: 'true' })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.suggestions.length).toBeGreaterThan(0)
      expect(res.body.suggestions.every((s: any) => s.isDirectory)).toBe(true)
      expect(res.body.suggestions.some((s: any) => s.path.endsWith('package.json'))).toBe(false)
    })

    it('limits to 20 results', async () => {
      // Create 25 files
      for (let i = 0; i < 25; i++) {
        await fsp.writeFile(path.join(tempDir, `file${i}.txt`), '')
      }

      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: path.join(tempDir, 'file') })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.suggestions.length).toBeLessThanOrEqual(20)
    })

    it('returns 400 if prefix is missing', async () => {
      const res = await request(app)
        .get('/api/files/complete')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(400)
    })

    it('returns empty array for non-matching prefix', async () => {
      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: path.join(tempDir, 'nonexistent') })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.suggestions).toEqual([])
    })

    it('expands ~ prefixes to the user home directory', async () => {
      const homeTempDir = await fsp.mkdtemp(path.join(os.homedir(), '.freshell-home-complete-'))
      const homeNestedDir = path.join(homeTempDir, 'alpha')
      await fsp.mkdir(homeNestedDir, { recursive: true })

      const homeRelative = path.relative(os.homedir(), homeTempDir).split(path.sep).join('/')
      const prefix = `~/${homeRelative}/a`

      try {
        const res = await request(app)
          .get('/api/files/complete')
          .query({ prefix, dirs: 'true' })
          .set('x-auth-token', TEST_AUTH_TOKEN)

        expect(res.status).toBe(200)
        const paths = res.body.suggestions.map((s: any) => s.path)
        expect(paths).toContain(homeNestedDir)
      } finally {
        await fsp.rm(homeTempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    // This test requires WSL path translation (path.win32.resolve -> /mnt/d/...)
    // which only works on actual Linux/WSL, not on native Windows
    it.skipIf(process.platform === 'win32')('supports Windows drive prefixes when running in WSL', async () => {
      const originalWslDistro = process.env.WSL_DISTRO_NAME
      const originalWslSys32 = process.env.WSL_WINDOWS_SYS32
      const originalPlatform = process.platform
      const fakeSys32 = path.join(tempDir, 'wsl-mount', 'c', 'Windows', 'System32')
      const mappedDir = path.join(tempDir, 'wsl-mount', 'd', 'users', 'words with spaces')
      const mappedMatch = path.join(mappedDir, 'alpha')

      try {
        process.env.WSL_DISTRO_NAME = 'Ubuntu'
        process.env.WSL_WINDOWS_SYS32 = fakeSys32
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
        await fsp.mkdir(fakeSys32, { recursive: true })
        await fsp.mkdir(mappedMatch, { recursive: true })

        const res = await request(app)
          .get('/api/files/complete')
          .query({ prefix: String.raw`D:\users\words with spaces\a`, dirs: 'true' })
          .set('x-auth-token', TEST_AUTH_TOKEN)

        expect(res.status).toBe(200)
        const paths = res.body.suggestions.map((s: any) => s.path)
        expect(paths).toContain(String.raw`D:\users\words with spaces\alpha`)
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
        if (originalWslDistro === undefined) {
          delete process.env.WSL_DISTRO_NAME
        } else {
          process.env.WSL_DISTRO_NAME = originalWslDistro
        }
        if (originalWslSys32 === undefined) {
          delete process.env.WSL_WINDOWS_SYS32
        } else {
          process.env.WSL_WINDOWS_SYS32 = originalWslSys32
        }
      }
    })
  })

  describe('POST /api/files/validate-dir', () => {
    it('returns valid=true for existing directories', async () => {
      const dirPath = path.join(tempDir, 'valid-dir')
      await fsp.mkdir(dirPath, { recursive: true })

      const res = await request(app)
        .post('/api/files/validate-dir')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ path: dirPath })

      expect(res.status).toBe(200)
      expect(res.body.valid).toBe(true)
      expect(res.body.resolvedPath).toBe(path.resolve(dirPath))
    })

    it('returns valid=false for files', async () => {
      const filePath = path.join(tempDir, 'not-a-dir.txt')
      await fsp.writeFile(filePath, 'content')

      const res = await request(app)
        .post('/api/files/validate-dir')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ path: filePath })

      expect(res.status).toBe(200)
      expect(res.body.valid).toBe(false)
    })

    it('returns valid=false for missing paths', async () => {
      const missingPath = path.join(tempDir, 'does-not-exist')

      const res = await request(app)
        .post('/api/files/validate-dir')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ path: missingPath })

      expect(res.status).toBe(200)
      expect(res.body.valid).toBe(false)
    })

    it('returns 400 when path is missing', async () => {
      const res = await request(app)
        .post('/api/files/validate-dir')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('path')
    })

    // This test requires WSL path translation which only works on actual Linux/WSL
    it.skipIf(process.platform === 'win32')('validates Windows drive paths when running in WSL', async () => {
      const originalWslDistro = process.env.WSL_DISTRO_NAME
      const originalWslSys32 = process.env.WSL_WINDOWS_SYS32
      const originalPlatform = process.platform
      const fakeSys32 = path.join(tempDir, 'wsl-mount', 'c', 'Windows', 'System32')
      const mappedDir = path.join(tempDir, 'wsl-mount', 'd', 'users', 'words with spaces')

      process.env.WSL_DISTRO_NAME = 'Ubuntu'
      process.env.WSL_WINDOWS_SYS32 = fakeSys32
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      await fsp.mkdir(fakeSys32, { recursive: true })
      await fsp.mkdir(mappedDir, { recursive: true })

      try {
        const res = await request(app)
          .post('/api/files/validate-dir')
          .set('x-auth-token', TEST_AUTH_TOKEN)
          .send({ path: String.raw`D:\users\words with spaces` })

        expect(res.status).toBe(200)
        expect(res.body.valid).toBe(true)
        expect(res.body.resolvedPath).toBe(String.raw`D:\users\words with spaces`)
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
        if (originalWslDistro === undefined) {
          delete process.env.WSL_DISTRO_NAME
        } else {
          process.env.WSL_DISTRO_NAME = originalWslDistro
        }
        if (originalWslSys32 === undefined) {
          delete process.env.WSL_WINDOWS_SYS32
        } else {
          process.env.WSL_WINDOWS_SYS32 = originalWslSys32
        }
      }
    })
  })
})
