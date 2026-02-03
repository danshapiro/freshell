import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { SessionRepairQueue, Priority } from '../../../server/session-scanner/queue.js'
import { createSessionScanner } from '../../../server/session-scanner/scanner.js'
import { SessionCache } from '../../../server/session-scanner/cache.js'
import type { SessionScanResult, SessionRepairResult } from '../../../server/session-scanner/types.js'

const FIXTURES_DIR = path.join(__dirname, '../../fixtures/sessions')

describe('SessionRepairQueue', () => {
  let queue: SessionRepairQueue
  let cache: SessionCache
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-queue-test-'))
    const scanner = createSessionScanner()
    cache = new SessionCache(path.join(tempDir, 'cache.json'))
    queue = new SessionRepairQueue(scanner, cache)
  })

  afterEach(async () => {
    await queue.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('enqueue()', () => {
    it('adds sessions to queue', () => {
      queue.enqueue([
        { sessionId: 'session1', filePath: '/path/to/session1.jsonl', priority: 'disk' },
      ])

      expect(queue.size()).toBe(1)
    })

    it('deduplicates sessions', () => {
      queue.enqueue([
        { sessionId: 'session1', filePath: '/path/to/session1.jsonl', priority: 'disk' },
        { sessionId: 'session1', filePath: '/path/to/session1.jsonl', priority: 'disk' },
      ])

      expect(queue.size()).toBe(1)
    })

    it('re-prioritizes existing session to higher priority', () => {
      queue.enqueue([
        { sessionId: 'session1', filePath: '/path/to/session1.jsonl', priority: 'disk' },
      ])
      queue.enqueue([
        { sessionId: 'session1', filePath: '/path/to/session1.jsonl', priority: 'active' },
      ])

      const next = queue.peek()
      expect(next?.priority).toBe('active')
    })

    it('does not downgrade priority', () => {
      queue.enqueue([
        { sessionId: 'session1', filePath: '/path/to/session1.jsonl', priority: 'active' },
      ])
      queue.enqueue([
        { sessionId: 'session1', filePath: '/path/to/session1.jsonl', priority: 'disk' },
      ])

      const next = queue.peek()
      expect(next?.priority).toBe('active')
    })

    it('updates filePath when re-enqueued with a new path', () => {
      queue.enqueue([
        { sessionId: 'session1', filePath: '/path/to/session1.jsonl', priority: 'disk' },
      ])

      queue.enqueue([
        { sessionId: 'session1', filePath: '/path/to/session1-new.jsonl', priority: 'disk' },
      ])

      const next = queue.peek()
      expect(next?.filePath).toBe('/path/to/session1-new.jsonl')
    })
  })

  describe('priority ordering', () => {
    it('processes active before visible', () => {
      queue.enqueue([
        { sessionId: 'visible1', filePath: '/path/visible1.jsonl', priority: 'visible' },
        { sessionId: 'active1', filePath: '/path/active1.jsonl', priority: 'active' },
      ])

      const first = queue.peek()
      expect(first?.sessionId).toBe('active1')
    })

    it('processes visible before background', () => {
      queue.enqueue([
        { sessionId: 'background1', filePath: '/path/bg1.jsonl', priority: 'background' },
        { sessionId: 'visible1', filePath: '/path/visible1.jsonl', priority: 'visible' },
      ])

      const first = queue.peek()
      expect(first?.sessionId).toBe('visible1')
    })

    it('processes background before disk', () => {
      queue.enqueue([
        { sessionId: 'disk1', filePath: '/path/disk1.jsonl', priority: 'disk' },
        { sessionId: 'background1', filePath: '/path/bg1.jsonl', priority: 'background' },
      ])

      const first = queue.peek()
      expect(first?.sessionId).toBe('background1')
    })

    it('processes in FIFO order within same priority', () => {
      queue.enqueue([
        { sessionId: 'disk1', filePath: '/path/disk1.jsonl', priority: 'disk' },
        { sessionId: 'disk2', filePath: '/path/disk2.jsonl', priority: 'disk' },
        { sessionId: 'disk3', filePath: '/path/disk3.jsonl', priority: 'disk' },
      ])

      expect(queue.peek()?.sessionId).toBe('disk1')
    })

    it('full priority order: active > visible > background > disk', () => {
      queue.enqueue([
        { sessionId: 'disk1', filePath: '/path/disk1.jsonl', priority: 'disk' },
        { sessionId: 'background1', filePath: '/path/bg1.jsonl', priority: 'background' },
        { sessionId: 'visible1', filePath: '/path/visible1.jsonl', priority: 'visible' },
        { sessionId: 'active1', filePath: '/path/active1.jsonl', priority: 'active' },
      ])

      const order: string[] = []
      while (queue.size() > 0) {
        const item = queue.dequeue()
        if (item) order.push(item.sessionId)
      }

      expect(order).toEqual(['active1', 'visible1', 'background1', 'disk1'])
    })
  })

  describe('start() and processing', () => {
    it('emits scanned event for each processed item', async () => {
      const scanned: SessionScanResult[] = []
      queue.on('scanned', (result) => scanned.push(result))

      queue.enqueue([
        { sessionId: 'healthy', filePath: path.join(FIXTURES_DIR, 'healthy.jsonl'), priority: 'active' },
      ])

      queue.start()
      await queue.waitFor('healthy', 5000)

      expect(scanned.length).toBe(1)
      expect(scanned[0].sessionId).toBe('healthy')
      expect(scanned[0].status).toBe('healthy')
    })

    it('emits repaired event when session is repaired', async () => {
      // Copy corrupted file to temp dir
      const testFile = path.join(tempDir, 'corrupted.jsonl')
      await fs.copyFile(path.join(FIXTURES_DIR, 'corrupted-shallow.jsonl'), testFile)

      const repaired: SessionRepairResult[] = []
      queue.on('repaired', (result) => repaired.push(result))

      queue.enqueue([
        { sessionId: 'corrupted', filePath: testFile, priority: 'active' },
      ])

      queue.start()
      await queue.waitFor('corrupted', 5000)

      expect(repaired.length).toBe(1)
      expect(repaired[0].status).toBe('repaired')
    })

    it('emits error event on failure', async () => {
      const errorScanner = {
        scan: vi.fn().mockRejectedValue(new Error('boom')),
        repair: vi.fn(),
      }
      const errorQueue = new SessionRepairQueue(errorScanner as any, cache)

      const errors: Array<{ sessionId: string; error: Error }> = []
      errorQueue.on('error', (sessionId, error) => errors.push({ sessionId, error }))

      errorQueue.enqueue([
        { sessionId: 'broken', filePath: '/does/not/exist.jsonl', priority: 'active' },
      ])

      errorQueue.start()
      await new Promise(r => setTimeout(r, 50))

      expect(errors).toHaveLength(1)
      expect(errors[0].sessionId).toBe('broken')
      expect(errors[0].error.message).toMatch(/boom/i)

      await errorQueue.stop()
    })

    it('caches scan results', async () => {
      queue.enqueue([
        { sessionId: 'healthy', filePath: path.join(FIXTURES_DIR, 'healthy.jsonl'), priority: 'active' },
      ])

      queue.start()
      await queue.waitFor('healthy', 5000)

      // Check cache
      const cached = await cache.get(path.join(FIXTURES_DIR, 'healthy.jsonl'))
      expect(cached).not.toBeNull()
      expect(cached?.status).toBe('healthy')
    })

    it('reuses recent cached scans for active sessions when the file changes', async () => {
      const filePath = path.join(tempDir, 'healthy.jsonl')
      await fs.copyFile(path.join(FIXTURES_DIR, 'healthy.jsonl'), filePath)

      const scanResult: SessionScanResult = {
        sessionId: 'healthy',
        filePath,
        status: 'healthy',
        chainDepth: 1,
        orphanCount: 0,
        fileSize: 1,
        messageCount: 1,
      }

      const scanner = {
        scan: vi.fn().mockResolvedValue(scanResult),
        repair: vi.fn(),
      }

      const localCache = new SessionCache(path.join(tempDir, 'cache.json'))
      await localCache.set(filePath, scanResult)
      await fs.appendFile(filePath, '\n')

      const localQueue = new SessionRepairQueue(scanner as any, localCache)
      localQueue.enqueue([
        { sessionId: 'healthy', filePath, priority: 'active' },
      ])

      localQueue.start()
      const result = await localQueue.waitFor('healthy', 5000)

      expect(result.status).toBe('healthy')
      expect(scanner.scan).not.toHaveBeenCalled()

      await localQueue.stop()
    })

    it('auto-starts when new items are enqueued after drain', async () => {
      const scanned: SessionScanResult[] = []
      queue.on('scanned', (result) => scanned.push(result))

      queue.enqueue([
        { sessionId: 'first', filePath: path.join(FIXTURES_DIR, 'healthy.jsonl'), priority: 'active' },
      ])

      queue.start()
      await queue.waitFor('first', 5000)

      expect(scanned).toHaveLength(1)

      queue.enqueue([
        { sessionId: 'second', filePath: path.join(FIXTURES_DIR, 'healthy.jsonl'), priority: 'active' },
      ])

      await queue.waitFor('second', 5000)
      expect(scanned).toHaveLength(2)
    })
  })

  describe('stop()', () => {
    it('stops processing new items', async () => {
      const scanned: SessionScanResult[] = []
      queue.on('scanned', (result) => scanned.push(result))

      queue.enqueue([
        { sessionId: 'healthy', filePath: path.join(FIXTURES_DIR, 'healthy.jsonl'), priority: 'disk' },
      ])

      await queue.stop()

      queue.start()
      await new Promise(r => setTimeout(r, 50))

      expect(scanned).toHaveLength(0)
      expect(queue.size()).toBe(1)
    })

    it('can be called multiple times safely', async () => {
      await queue.stop()
      await queue.stop()
      await queue.stop()
      // Should not throw
    })
  })

  describe('waitFor()', () => {
    it('resolves when session is processed', async () => {
      queue.enqueue([
        { sessionId: 'healthy', filePath: path.join(FIXTURES_DIR, 'healthy.jsonl'), priority: 'active' },
      ])

      queue.start()

      const result = await queue.waitFor('healthy')
      expect(result.status).toBe('healthy')
    })

    it('resolves immediately if already processed', async () => {
      queue.enqueue([
        { sessionId: 'healthy', filePath: path.join(FIXTURES_DIR, 'healthy.jsonl'), priority: 'active' },
      ])

      queue.start()
      await new Promise(r => setTimeout(r, 100))

      // Now wait again - should resolve immediately from cache
      const result = await queue.waitFor('healthy')
      expect(result.status).toBe('healthy')
    })

    it('handles timeout for stuck/missing sessions', async () => {
      // Session not in queue
      const promise = queue.waitFor('nonexistent', 100)

      await expect(promise).rejects.toThrow(/timeout/i)
    })
  })

  describe('isProcessing()', () => {
    it('returns true while a session is being processed', async () => {
      let resolveScan: ((result: SessionScanResult) => void) | null = null
      let signalStart: (() => void) | null = null
      const scanStarted = new Promise<void>((resolve) => {
        signalStart = resolve
      })
      const scanPromise = new Promise<SessionScanResult>((resolve) => {
        resolveScan = resolve
      })

      const slowScanner = {
        scan: vi.fn().mockImplementation(() => {
          signalStart?.()
          return scanPromise
        }),
        repair: vi.fn(),
      }
      const slowQueue = new SessionRepairQueue(slowScanner as any, cache)

      slowQueue.enqueue([
        { sessionId: 'slow', filePath: '/tmp/slow.jsonl', priority: 'active' },
      ])

      slowQueue.start()
      await scanStarted

      expect(slowQueue.isProcessing('slow')).toBe(true)

      resolveScan!({
        sessionId: 'slow',
        filePath: '/tmp/slow.jsonl',
        status: 'healthy',
        chainDepth: 1,
        orphanCount: 0,
        fileSize: 1,
        messageCount: 1,
      })

      await slowQueue.waitFor('slow', 5000)
      expect(slowQueue.isProcessing('slow')).toBe(false)

      await slowQueue.stop()
    })
  })

  describe('processed cache eviction', () => {
    it('evicts oldest processed entries beyond the max cache size', () => {
      const localQueue = new SessionRepairQueue(
        createSessionScanner(),
        cache,
        { maxProcessedCache: 2 }
      )

      const setProcessed = (localQueue as any).setProcessed.bind(localQueue)

      const baseResult: SessionScanResult = {
        sessionId: 's1',
        filePath: '/tmp/s1.jsonl',
        status: 'healthy',
        chainDepth: 1,
        orphanCount: 0,
        fileSize: 1,
        messageCount: 1,
      }

      setProcessed('s1', baseResult)
      setProcessed('s2', { ...baseResult, sessionId: 's2', filePath: '/tmp/s2.jsonl' })
      setProcessed('s3', { ...baseResult, sessionId: 's3', filePath: '/tmp/s3.jsonl' })

      const processed = (localQueue as any).processed as Map<string, SessionScanResult>
      expect(processed.size).toBe(2)
      expect(processed.has('s1')).toBe(false)
      expect(processed.has('s2')).toBe(true)
      expect(processed.has('s3')).toBe(true)
    })
  })
})
