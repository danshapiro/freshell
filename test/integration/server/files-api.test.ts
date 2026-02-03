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
    const { filesRouter } = await import('../../../server/files-router')
    app.use('/api/files', filesRouter)
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
  })
})
