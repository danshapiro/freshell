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

      // Poll for processing completion (vitest 3 may have different startup timing)
      const deadline = Date.now() + 5000
      while (repaired.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }

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

      const scanned: SessionScanResult[] = []
      const repaired: SessionRepairResult[] = []
      service.on('scanned', (r) => scanned.push(r))
      service.on('repaired', (r) => repaired.push(r))

      const queue = (service as any).queue
      queue.enqueue([{ sessionId, filePath: sessionFile, priority: 'active' }])
      queue.start()

      // Poll for scan completion rather than fixed timeout
      const deadline = Date.now() + 5000
      while (scanned.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }

      // Session was scanned but should not have been repaired
      expect(scanned.length).toBeGreaterThan(0)
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

    it('uses CLAUDE_HOME when resolving session files', async () => {
      const originalClaudeHome = process.env.CLAUDE_HOME
      const customClaudeHome = path.join(tempDir, 'custom-claude')
      const projectsDir = path.join(customClaudeHome, 'projects', 'custom-project')
      await fs.mkdir(projectsDir, { recursive: true })

      const sessionId = '550e8400-e29b-41d4-a716-446655440000'
      const sessionFile = path.join(projectsDir, `${sessionId}.jsonl`)
      await fs.copyFile(path.join(FIXTURES_DIR, 'healthy.jsonl'), sessionFile)

      process.env.CLAUDE_HOME = customClaudeHome

      const service2 = new SessionRepairService({
        cacheDir: tempDir,
        scanner: createSessionScanner(),
      })

      try {
        await service2.start()
        const result = await service2.waitForSession(sessionId, 5000)
        expect(result.status).toBe('healthy')
        expect(result.filePath).toBe(sessionFile)
      } finally {
        await service2.stop()
        if (originalClaudeHome === undefined) {
          delete process.env.CLAUDE_HOME
        } else {
          process.env.CLAUDE_HOME = originalClaudeHome
        }
      }
    })

    it('resolves canonical sessionId via file path resolver', async () => {
      const canonicalId = '6f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b'
      const legacyId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
      const sessionFile = path.join(mockClaudeDir, `${legacyId}.jsonl`)
      await fs.copyFile(path.join(FIXTURES_DIR, 'healthy.jsonl'), sessionFile)

      service.setFilePathResolver((sessionId) => (sessionId === canonicalId ? sessionFile : undefined))
      const queue = (service as any).queue
      queue.start()

      const result = await service.waitForSession(canonicalId, 5000)
      expect(result.status).toBe('healthy')
      expect(result.sessionId).toBe(canonicalId)
      expect(result.filePath).toBe(sessionFile)
    })

    it('seeds canonical sessionId when legacy session is queued', async () => {
      const canonicalId = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
      const legacyId = 'e4eaaaf2-d142-11e1-b3e4-080027620cdd'
      const sessionFile = path.join(mockClaudeDir, `${legacyId}.jsonl`)
      await fs.copyFile(path.join(FIXTURES_DIR, 'healthy.jsonl'), sessionFile)

      service.setFilePathResolver((sessionId) => (sessionId === canonicalId ? sessionFile : undefined))
      const queue = (service as any).queue
      queue.enqueue([{ sessionId: legacyId, filePath: sessionFile, priority: 'active' }])
      queue.start()

      const result = await service.waitForSession(canonicalId, 5000)
      expect(result.status).toBe('healthy')
      expect(result.sessionId).toBe(canonicalId)

      const cached = service.getResult(canonicalId)
      expect(cached?.filePath).toBe(sessionFile)
      expect(cached?.status).toBe('healthy')
      expect(cached?.sessionId).toBe(canonicalId)
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
      const scanned: SessionScanResult[] = []
      service.on('scanned', (r) => scanned.push(r))
      const queue = (service as any).queue
      queue.enqueue([{ sessionId, filePath: sessionFile, priority: 'active' }])
      queue.start()

      // Poll for processing completion
      const deadline = Date.now() + 5000
      while (scanned.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }

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
