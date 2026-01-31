import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { SessionCache } from '../../../server/session-scanner/cache.js'
import type { SessionScanResult } from '../../../server/session-scanner/types.js'

describe('SessionCache', () => {
  let cache: SessionCache
  let tempDir: string
  let cacheFile: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-cache-test-'))
    cacheFile = path.join(tempDir, 'cache.json')
    cache = new SessionCache(cacheFile)
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  function createTestResult(sessionId: string): SessionScanResult {
    return {
      sessionId,
      filePath: path.join(tempDir, `${sessionId}.jsonl`),
      status: 'healthy',
      chainDepth: 10,
      orphanCount: 0,
      fileSize: 1000,
      messageCount: 10,
    }
  }

  async function createTestFile(name: string, content = 'test content'): Promise<string> {
    const filePath = path.join(tempDir, name)
    await fs.writeFile(filePath, content)
    return filePath
  }

  describe('get()', () => {
    it('returns null for cache miss', async () => {
      const filePath = await createTestFile('test.jsonl')
      const result = await cache.get(filePath)
      expect(result).toBeNull()
    })

    it('returns cached result when file unchanged', async () => {
      const filePath = await createTestFile('test.jsonl')
      const scanResult = createTestResult('test')
      scanResult.filePath = filePath

      await cache.set(filePath, scanResult)
      const result = await cache.get(filePath)

      expect(result).not.toBeNull()
      expect(result?.sessionId).toBe('test')
      expect(result?.status).toBe('healthy')
    })

    it('returns null when mtime changes', async () => {
      const filePath = await createTestFile('test.jsonl')
      const scanResult = createTestResult('test')
      scanResult.filePath = filePath

      await cache.set(filePath, scanResult)

      // Wait a bit and modify file to change mtime
      await new Promise(r => setTimeout(r, 100))
      await fs.writeFile(filePath, 'modified content')

      const result = await cache.get(filePath)
      expect(result).toBeNull()
    })

    it('returns null when size changes', async () => {
      const filePath = await createTestFile('test.jsonl', 'original')
      const scanResult = createTestResult('test')
      scanResult.filePath = filePath

      await cache.set(filePath, scanResult)

      // Modify file size without waiting (atomic operation)
      await fs.writeFile(filePath, 'much longer content than before')

      const result = await cache.get(filePath)
      expect(result).toBeNull()
    })

    it('returns null when file is deleted', async () => {
      const filePath = await createTestFile('test.jsonl')
      const scanResult = createTestResult('test')
      scanResult.filePath = filePath

      await cache.set(filePath, scanResult)
      await fs.unlink(filePath)

      const result = await cache.get(filePath)
      expect(result).toBeNull()
    })
  })

  describe('set()', () => {
    it('stores result with file metadata', async () => {
      const filePath = await createTestFile('test.jsonl')
      const scanResult = createTestResult('test')
      scanResult.filePath = filePath

      await cache.set(filePath, scanResult)

      // Verify by getting
      const result = await cache.get(filePath)
      expect(result).not.toBeNull()
    })

    it('overwrites existing entry', async () => {
      const filePath = await createTestFile('test.jsonl')

      const result1 = createTestResult('test')
      result1.filePath = filePath
      result1.status = 'healthy'

      const result2 = createTestResult('test')
      result2.filePath = filePath
      result2.status = 'corrupted'

      await cache.set(filePath, result1)
      await cache.set(filePath, result2)

      const cached = await cache.get(filePath)
      expect(cached?.status).toBe('corrupted')
    })
  })

  describe('invalidate()', () => {
    it('removes entry from cache', async () => {
      const filePath = await createTestFile('test.jsonl')
      const scanResult = createTestResult('test')
      scanResult.filePath = filePath

      await cache.set(filePath, scanResult)
      cache.invalidate(filePath)

      const result = await cache.get(filePath)
      expect(result).toBeNull()
    })

    it('is safe to call on non-existent entry', () => {
      expect(() => cache.invalidate('/nonexistent/path.jsonl')).not.toThrow()
    })
  })

  describe('persist() and load()', () => {
    it('persists cache to disk', async () => {
      const filePath = await createTestFile('test.jsonl')
      const scanResult = createTestResult('test')
      scanResult.filePath = filePath

      await cache.set(filePath, scanResult)
      await cache.persist()

      // Verify file exists
      const exists = await fs.stat(cacheFile).then(() => true).catch(() => false)
      expect(exists).toBe(true)
    })

    it('loads cache from disk', async () => {
      const filePath = await createTestFile('test.jsonl')
      const scanResult = createTestResult('test')
      scanResult.filePath = filePath

      await cache.set(filePath, scanResult)
      await cache.persist()

      // Create new cache instance and load
      const cache2 = new SessionCache(cacheFile)
      await cache2.load()

      const result = await cache2.get(filePath)
      expect(result).not.toBeNull()
      expect(result?.sessionId).toBe('test')
    })

    it('handles missing cache file gracefully', async () => {
      const cache2 = new SessionCache(path.join(tempDir, 'nonexistent.json'))
      await expect(cache2.load()).resolves.not.toThrow()
    })

    it('handles corrupted cache file gracefully', async () => {
      await fs.writeFile(cacheFile, 'not valid json{{{')

      const cache2 = new SessionCache(cacheFile)
      await expect(cache2.load()).resolves.not.toThrow()

      // Should start fresh with empty cache
      const result = await cache2.get('/any/path.jsonl')
      expect(result).toBeNull()
    })

    it('persists multiple entries', async () => {
      const file1 = await createTestFile('test1.jsonl')
      const file2 = await createTestFile('test2.jsonl')

      const result1 = createTestResult('test1')
      result1.filePath = file1
      const result2 = createTestResult('test2')
      result2.filePath = file2

      await cache.set(file1, result1)
      await cache.set(file2, result2)
      await cache.persist()

      const cache2 = new SessionCache(cacheFile)
      await cache2.load()

      expect(await cache2.get(file1)).not.toBeNull()
      expect(await cache2.get(file2)).not.toBeNull()
    })
  })

  describe('clear()', () => {
    it('removes all entries', async () => {
      const file1 = await createTestFile('test1.jsonl')
      const file2 = await createTestFile('test2.jsonl')

      await cache.set(file1, createTestResult('test1'))
      await cache.set(file2, createTestResult('test2'))

      cache.clear()

      expect(await cache.get(file1)).toBeNull()
      expect(await cache.get(file2)).toBeNull()
    })
  })
})
