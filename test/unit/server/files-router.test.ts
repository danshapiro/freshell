import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'path'

// Mock logger before importing files-router
vi.mock('../../../server/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock configStore
const mockGetSettings = vi.fn()
vi.mock('../../../server/config-store', () => ({
  configStore: {
    getSettings: () => mockGetSettings(),
    load: vi.fn().mockResolvedValue({ settings: {} }),
  },
  defaultSettings: {},
}))

// Mock fs/promises
const mockStat = vi.fn()
const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockMkdir = vi.fn()
const mockReaddir = vi.fn()
vi.mock('fs/promises', () => ({
  default: {
    stat: (...args: unknown[]) => mockStat(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
  },
}))

// Mock child_process.spawn
const mockSpawn = vi.fn()
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  }
})

// Import after mocks are set up
const { filesRouter } = await import('../../../server/files-router')

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/files', filesRouter)
  return app
}

describe('files-router path validation', () => {
  let app: express.Express

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    // Default: no sandboxing (backward compatible)
    mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
  })

  describe('GET /api/files/read', () => {
    it('allows reading when allowedFilePaths is undefined', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockStat.mockResolvedValue({ isDirectory: () => false, size: 42, mtime: new Date() })
      mockReadFile.mockResolvedValue('file content')

      const res = await request(app)
        .get('/api/files/read')
        .query({ path: '/home/user/file.txt' })

      expect(res.status).toBe(200)
      expect(res.body.content).toBe('file content')
    })

    it('allows reading file inside allowed directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })
      mockStat.mockResolvedValue({ isDirectory: () => false, size: 42, mtime: new Date() })
      mockReadFile.mockResolvedValue('file content')

      const res = await request(app)
        .get('/api/files/read')
        .query({ path: '/home/user/projects/src/index.ts' })

      expect(res.status).toBe(200)
      expect(res.body.content).toBe('file content')
    })

    it('blocks reading file outside allowed directory with 403', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .get('/api/files/read')
        .query({ path: '/etc/passwd' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })

    it('blocks path traversal attack', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .get('/api/files/read')
        .query({ path: '/home/user/projects/../../etc/passwd' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })
  })

  describe('POST /api/files/write', () => {
    it('allows writing when allowedFilePaths is undefined', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockMkdir.mockResolvedValue(undefined)
      mockWriteFile.mockResolvedValue(undefined)
      mockStat.mockResolvedValue({ mtime: new Date() })

      const res = await request(app)
        .post('/api/files/write')
        .send({ path: '/home/user/file.txt', content: 'hello' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })

    it('allows writing file inside allowed directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })
      mockMkdir.mockResolvedValue(undefined)
      mockWriteFile.mockResolvedValue(undefined)
      mockStat.mockResolvedValue({ mtime: new Date() })

      const res = await request(app)
        .post('/api/files/write')
        .send({ path: '/home/user/projects/new-file.txt', content: 'hello' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })

    it('blocks writing file outside allowed directory with 403', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .post('/api/files/write')
        .send({ path: '/etc/evil-file', content: 'malicious' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })

    it('blocks path traversal in write path', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .post('/api/files/write')
        .send({ path: '/home/user/projects/../../../tmp/evil', content: 'malicious' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })
  })

  describe('POST /api/files/open', () => {
    it('allows opening when allowedFilePaths is undefined', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockStat.mockResolvedValue({ isFile: () => true })
      mockSpawn.mockReturnValue({ unref: vi.fn() })

      const res = await request(app)
        .post('/api/files/open')
        .send({ path: '/home/user/file.txt' })

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('allows opening file inside allowed directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })
      mockStat.mockResolvedValue({ isFile: () => true })
      mockSpawn.mockReturnValue({ unref: vi.fn() })

      const res = await request(app)
        .post('/api/files/open')
        .send({ path: '/home/user/projects/file.txt' })

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('blocks opening file outside allowed directory with 403', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .post('/api/files/open')
        .send({ path: '/usr/bin/dangerous' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })

    it('blocks path traversal in open endpoint', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .post('/api/files/open')
        .send({ path: '/home/user/projects/../../etc/passwd' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })
  })

  describe('GET /api/files/complete', () => {
    it('allows completion when allowedFilePaths is undefined', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockStat.mockRejectedValue({ code: 'ENOENT' })
      mockReaddir.mockResolvedValue([])

      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: '/home/user/pro' })

      expect(res.status).toBe(200)
    })

    it('allows completion inside allowed directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })
      mockStat.mockRejectedValue({ code: 'ENOENT' })
      mockReaddir.mockResolvedValue([])

      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: '/home/user/projects/src' })

      expect(res.status).toBe(200)
    })

    it('blocks completion outside allowed directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: '/etc/pass' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })
  })

  describe('POST /api/files/validate-dir', () => {
    it('allows validation when allowedFilePaths is undefined', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockStat.mockResolvedValue({ isDirectory: () => true })

      const res = await request(app)
        .post('/api/files/validate-dir')
        .send({ path: '/home/user/projects' })

      expect(res.status).toBe(200)
    })

    it('allows validation inside allowed directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })
      mockStat.mockResolvedValue({ isDirectory: () => true })

      const res = await request(app)
        .post('/api/files/validate-dir')
        .send({ path: '/home/user/projects/subdir' })

      expect(res.status).toBe(200)
    })

    it('blocks validation outside allowed directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .post('/api/files/validate-dir')
        .send({ path: '/var/log' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })
  })
})
