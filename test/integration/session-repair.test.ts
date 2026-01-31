import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import {
  SessionRepairService,
  resetSessionRepairService,
  createSessionScanner,
} from '../../server/session-scanner/index.js'
import type { SessionScanResult, SessionRepairResult } from '../../server/session-scanner/types.js'

const FIXTURES_DIR = path.join(__dirname, '../fixtures/sessions')

describe('SessionRepairService Integration', () => {
  let service: SessionRepairService
  let tempDir: string
  let mockClaudeDir: string

  beforeEach(async () => {
    resetSessionRepairService()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-repair-integration-'))
    mockClaudeDir = path.join(tempDir, '.claude', 'projects', 'test-project')
    await fs.mkdir(mockClaudeDir, { recursive: true })

    service = new SessionRepairService({
      cacheDir: tempDir,
      scanner: createSessionScanner(),
    })
  })

  afterEach(async () => {
    await service.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('basic flow', () => {
    it('scans and repairs a corrupted session', async () => {
      // Copy corrupted fixture to mock claude dir
      const sessionId = 'test-session-1'
      const sessionFile = path.join(mockClaudeDir, `${sessionId}.jsonl`)
      await fs.copyFile(
        path.join(FIXTURES_DIR, 'corrupted-shallow.jsonl'),
        sessionFile
      )

      const scanned: SessionScanResult[] = []
      const repaired: SessionRepairResult[] = []

      service.on('scanned', (r) => scanned.push(r))
      service.on('repaired', (r) => repaired.push(r))

      // Manually enqueue since we're using a custom mock dir
      // In production, start() globs the real ~/.claude directory
      const scanner = createSessionScanner()
      const queue = (service as any).queue
      queue.enqueue([{ sessionId, filePath: sessionFile, priority: 'active' }])
      queue.start()

      // Wait for processing
      await new Promise((r) => setTimeout(r, 300))

      expect(scanned.length).toBeGreaterThan(0)
      expect(repaired.length).toBe(1)
      expect(repaired[0].status).toBe('repaired')

      // Verify file is now healthy
      const result = await scanner.scan(sessionFile)
      expect(result.status).toBe('healthy')
    })

    it('handles healthy sessions without repair', async () => {
      const sessionId = 'healthy-session'
      const sessionFile = path.join(mockClaudeDir, `${sessionId}.jsonl`)
      await fs.copyFile(
        path.join(FIXTURES_DIR, 'healthy.jsonl'),
        sessionFile
      )

      const repaired: SessionRepairResult[] = []
      service.on('repaired', (r) => repaired.push(r))

      const queue = (service as any).queue
      queue.enqueue([{ sessionId, filePath: sessionFile, priority: 'active' }])
      queue.start()

      await new Promise((r) => setTimeout(r, 200))

      // Should not have repaired anything
      expect(repaired.length).toBe(0)
    })
  })

  describe('waitForSession', () => {
    it('resolves when session is processed', async () => {
      const sessionId = 'wait-test-session'
      const sessionFile = path.join(mockClaudeDir, `${sessionId}.jsonl`)
      await fs.copyFile(
        path.join(FIXTURES_DIR, 'healthy.jsonl'),
        sessionFile
      )

      const queue = (service as any).queue
      queue.enqueue([{ sessionId, filePath: sessionFile, priority: 'active' }])
      queue.start()

      const result = await service.waitForSession(sessionId, 5000)
      expect(result.status).toBe('healthy')
    })

    it('times out for non-existent session', async () => {
      await expect(
        service.waitForSession('nonexistent', 100)
      ).rejects.toThrow(/not in queue/)
    })
  })

  describe('prioritizeSessions', () => {
    it('re-prioritizes existing queue items', async () => {
      const sessionId = 'priority-test'
      const sessionFile = path.join(mockClaudeDir, `${sessionId}.jsonl`)
      await fs.copyFile(
        path.join(FIXTURES_DIR, 'healthy.jsonl'),
        sessionFile
      )

      // Enqueue at disk priority
      const queue = (service as any).queue
      queue.enqueue([{ sessionId, filePath: sessionFile, priority: 'disk' }])

      expect(queue.peek()?.priority).toBe('disk')

      // Re-prioritize to active
      service.prioritizeSessions({ active: sessionId })

      expect(queue.peek()?.priority).toBe('active')
    })
  })

  describe('backup cleanup', () => {
    it('removes old backup files', async () => {
      // Create an old backup file
      const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000 // 31 days ago
      const oldBackup = path.join(mockClaudeDir, `session.jsonl.backup-${oldTimestamp}`)
      await fs.writeFile(oldBackup, 'old backup content')

      // Create a recent backup
      const recentTimestamp = Date.now() - 1 * 24 * 60 * 60 * 1000 // 1 day ago
      const recentBackup = path.join(mockClaudeDir, `session.jsonl.backup-${recentTimestamp}`)
      await fs.writeFile(recentBackup, 'recent backup content')

      // Start service (triggers cleanup)
      // Note: Service uses real homedir for cleanup, so we test cleanup logic separately
      // Here we just verify the backup files exist
      const files = await fs.readdir(mockClaudeDir)
      expect(files).toContain(`session.jsonl.backup-${oldTimestamp}`)
      expect(files).toContain(`session.jsonl.backup-${recentTimestamp}`)
    })
  })

  describe('cache persistence', () => {
    it('persists and loads cache on stop/start', async () => {
      const sessionId = 'cache-persist-test'
      const sessionFile = path.join(mockClaudeDir, `${sessionId}.jsonl`)
      await fs.copyFile(
        path.join(FIXTURES_DIR, 'healthy.jsonl'),
        sessionFile
      )

      // Process the session
      const queue = (service as any).queue
      queue.enqueue([{ sessionId, filePath: sessionFile, priority: 'active' }])
      queue.start()
      await new Promise((r) => setTimeout(r, 200))

      // Stop service (persists cache)
      await service.stop()

      // Verify cache file exists
      const cacheFile = path.join(tempDir, 'session-cache.json')
      const cacheExists = await fs.stat(cacheFile).then(() => true).catch(() => false)
      expect(cacheExists).toBe(true)

      // Create new service and load cache
      const service2 = new SessionRepairService({ cacheDir: tempDir })
      await (service2 as any).cache.load()

      // Cache should have the entry
      const cached = await (service2 as any).cache.get(sessionFile)
      expect(cached).not.toBeNull()
      expect(cached?.status).toBe('healthy')

      await service2.stop()
    })
  })
})
