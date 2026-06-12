// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'path'
import os from 'os'

// Mock logger before importing files-router
vi.mock('../../../server/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock configStore (still needed as fallback for any transitive imports)
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

// Mock child_process.spawn AND execFile (path-utils uses execFile for wsl.exe calls;
// without this mock the real wsl.exe is invoked on Windows, triggering error dialogs)
const mockSpawn = vi.fn()
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
    execFile: vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') {
        (cb as (err: Error) => void)(Object.assign(new Error('mocked: no wsl'), { code: 'ENOENT' }))
      }
    }),
  }
})

// Import after mocks are set up
const { createFilesRouter } = await import('../../../server/files-router')

/** Returns a mock ChildProcess that stays alive (exit with code 0 after next tick) */
function mockChildProcess() {
  return {
    unref: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      // Simulate successful process: exit with code 0 after microtask
      if (event === 'exit') Promise.resolve().then(() => cb(0, null))
    }),
    removeListener: vi.fn(),
  }
}

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/files', createFilesRouter({
    configStore: { getSettings: () => mockGetSettings(), snapshot: vi.fn() },
    codingCliIndexer: { getProjects: () => [] },
    registry: { list: () => [] },
  }))
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

    it('resolves tilde paths consistently for validation and file read', async () => {
      const homeDir = os.homedir()
      mockGetSettings.mockResolvedValue({ allowedFilePaths: [homeDir] })
      mockStat.mockResolvedValue({ isDirectory: () => false, size: 42, mtime: new Date() })
      mockReadFile.mockResolvedValue('file content')

      const res = await request(app)
        .get('/api/files/read')
        .query({ path: '~/projects/notes.txt' })

      expect(res.status).toBe(200)
      expect(mockStat).toHaveBeenCalledWith(path.join(homeDir, 'projects', 'notes.txt'))
      expect(mockReadFile).toHaveBeenCalledWith(path.join(homeDir, 'projects', 'notes.txt'), 'utf-8')
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
      mockSpawn.mockReturnValue(mockChildProcess())

      const res = await request(app)
        .post('/api/files/open')
        .send({ path: '/home/user/file.txt' })

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('allows opening file inside allowed directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })
      mockStat.mockResolvedValue({ isFile: () => true })
      mockSpawn.mockReturnValue(mockChildProcess())

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

    it('passes line and column to the opener', async () => {
      mockGetSettings.mockResolvedValue({
        allowedFilePaths: undefined,
        editor: { externalEditor: 'cursor' },
      })
      mockStat.mockResolvedValue({ isFile: () => true })
      mockSpawn.mockReturnValue(mockChildProcess())

      const res = await request(app)
        .post('/api/files/open')
        .send({ path: '/home/user/file.ts', line: 42, column: 10 })

      expect(res.status).toBe(200)
      const expectedPathWithLocation = `${path.resolve('/home/user/file.ts')}:42:10`
      expect(mockSpawn).toHaveBeenCalledWith(
        'cursor',
        ['-r', '-g', expectedPathWithLocation],
        expect.any(Object),
      )
    })

    it('uses configured editor setting', async () => {
      mockGetSettings.mockResolvedValue({
        allowedFilePaths: undefined,
        editor: { externalEditor: 'code' },
      })
      mockStat.mockResolvedValue({ isFile: () => true })
      mockSpawn.mockReturnValue(mockChildProcess())

      const res = await request(app)
        .post('/api/files/open')
        .send({ path: '/home/user/file.ts' })

      expect(res.status).toBe(200)
      const expectedPath = path.resolve('/home/user/file.ts')
      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        ['-g', expectedPath],
        expect.any(Object),
      )
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

    it('anchors relative completion prefixes to the root query parameter', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })
      mockStat.mockRejectedValue({ code: 'ENOENT' })
      mockReaddir.mockResolvedValue([
        { name: 'src', isDirectory: () => true },
        { name: 'notes.md', isDirectory: () => false },
      ])

      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: 's', root: '/home/user/projects' })

      expect(res.status).toBe(200)
      expect(mockReaddir).toHaveBeenCalledWith('/home/user/projects', { withFileTypes: true })
      expect(res.body.suggestions).toEqual([
        { path: '/home/user/projects/src', isDirectory: true },
      ])
    })

    it('blocks completion outside allowed directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: '/etc/pass' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })

    it('blocks root-anchored relative completion that escapes allowed directories', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .get('/api/files/complete')
        .query({ prefix: '../secret', root: '/home/user/projects' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })
  })

  describe('GET /api/files/stat', () => {
    it('returns file metadata without reading content', async () => {
      const mtime = new Date('2026-03-29T12:00:00.000Z')
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockStat.mockResolvedValue({ isDirectory: () => false, size: 1024, mtime })

      const res = await request(app)
        .get('/api/files/stat')
        .query({ path: '/home/user/file.txt' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        exists: true,
        size: 1024,
        modifiedAt: '2026-03-29T12:00:00.000Z',
      })
      expect(mockReadFile).not.toHaveBeenCalled()
    })

    it('returns exists:false for missing files', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockStat.mockRejectedValue({ code: 'ENOENT' })

      const res = await request(app)
        .get('/api/files/stat')
        .query({ path: '/home/user/nonexistent.txt' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ exists: false, size: null, modifiedAt: null })
    })

    it('returns 403 for paths outside allowed directories', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .get('/api/files/stat')
        .query({ path: '/etc/passwd' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })

    it('returns exists:false for directories', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockStat.mockResolvedValue({ isDirectory: () => true, size: 4096, mtime: new Date() })

      const res = await request(app)
        .get('/api/files/stat')
        .query({ path: '/home/user/projects' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ exists: false, size: null, modifiedAt: null })
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

  describe('POST /api/files/mkdir', () => {
    it('creates a new directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockMkdir.mockResolvedValueOnce(undefined)

      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '/home/user/new-project' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ created: true, existed: false, resolvedPath: expect.any(String) })
    })

    it('returns existed:true when directory already exists', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockMkdir.mockRejectedValueOnce({ code: 'EEXIST' })
      mockStat.mockResolvedValueOnce({ isDirectory: () => true })

      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '/home/user/existing' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ created: true, existed: true, resolvedPath: expect.any(String) })
    })

    it('returns 409 when path exists as a file', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockMkdir.mockRejectedValueOnce({ code: 'EEXIST' })
      mockStat.mockResolvedValueOnce({ isDirectory: () => false })

      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '/home/user/file.txt' })

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('Path exists but is not a directory')
    })

    it('returns 403 when path is outside allowed directories', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '/etc/evil' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Path not allowed')
    })

    it('creates directory inside allowed directory', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })
      mockMkdir.mockResolvedValueOnce(undefined)

      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '/home/user/projects/subdir' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ created: true, existed: false, resolvedPath: expect.any(String) })
    })

    it('returns 400 when path is missing', async () => {
      const res = await request(app)
        .post('/api/files/mkdir')
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('path is required')
    })

    it('returns 400 when path is empty', async () => {
      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '   ' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('path is required')
    })

    it('expands tilde in path', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockMkdir.mockResolvedValueOnce(undefined)

      const homeDir = os.homedir()
      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '~/new-project' })

      expect(res.status).toBe(200)
      expect(mockMkdir).toHaveBeenCalledWith(path.join(homeDir, 'new-project'), { recursive: true })
    })

    it('returns 403 when permission is denied', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockMkdir.mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }))

      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '/root/cant-create' })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Permission denied')
    })

    it('returns 409 when a parent path component is a file (ENOTDIR)', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockMkdir.mockRejectedValueOnce(Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' }))

      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '/tmp/file.txt/subdir' })

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('Path exists but is not a directory')
    })

    it('returns 500 with generic error for unexpected failures', async () => {
      mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
      mockMkdir.mockRejectedValueOnce(Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }))

      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '/tmp/full' })

      expect(res.status).toBe(500)
      expect(res.body.error).toBe('No space left on device')
    })
  })
})
