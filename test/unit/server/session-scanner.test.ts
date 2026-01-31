import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { createSessionScanner } from '../../../server/session-scanner/scanner.js'
import type { SessionScanner, SessionScanResult } from '../../../server/session-scanner/types.js'

const FIXTURES_DIR = path.join(__dirname, '../../fixtures/sessions')

describe('SessionScanner', () => {
  let scanner: SessionScanner
  let tempDir: string

  beforeEach(async () => {
    scanner = createSessionScanner()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-scanner-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('scan()', () => {
    it('returns healthy status for intact chain', async () => {
      const result = await scanner.scan(path.join(FIXTURES_DIR, 'healthy.jsonl'))

      expect(result.status).toBe('healthy')
      expect(result.sessionId).toBe('healthy')
      expect(result.orphanCount).toBe(0)
      expect(result.messageCount).toBe(6)
      expect(result.chainDepth).toBe(6) // All messages in chain
    })

    it('detects orphans and returns corrupted status', async () => {
      const result = await scanner.scan(path.join(FIXTURES_DIR, 'corrupted-shallow.jsonl'))

      expect(result.status).toBe('corrupted')
      expect(result.sessionId).toBe('corrupted-shallow')
      expect(result.orphanCount).toBe(1)
      expect(result.chainDepth).toBe(3) // Chain breaks at msg-006 (depth 3 from end: msg-008 -> msg-007 -> msg-006 -> broken)
    })

    it('calculates correct chain depth for deep corruption', async () => {
      const result = await scanner.scan(path.join(FIXTURES_DIR, 'corrupted-deep.jsonl'))

      expect(result.status).toBe('corrupted')
      expect(result.orphanCount).toBe(1)
      // msg-021 -> msg-020 -> ... -> msg-007 -> msg-006 -> broken
      // That's 15 messages from msg-021 to msg-006 before hitting the orphan
      expect(result.chainDepth).toBe(16) // 16 messages before chain breaks
    })

    it('detects multiple orphans', async () => {
      const result = await scanner.scan(path.join(FIXTURES_DIR, 'corrupted-multiple.jsonl'))

      expect(result.status).toBe('corrupted')
      expect(result.orphanCount).toBe(3) // Three missing parents
    })

    it('returns missing status for non-existent file', async () => {
      const result = await scanner.scan(path.join(FIXTURES_DIR, 'does-not-exist.jsonl'))

      expect(result.status).toBe('missing')
      expect(result.chainDepth).toBe(0)
      expect(result.messageCount).toBe(0)
    })

    it('handles malformed JSON gracefully', async () => {
      const result = await scanner.scan(path.join(FIXTURES_DIR, 'malformed.jsonl'))

      // Should still scan valid lines and detect chain status
      expect(result.status).toBe('healthy') // Valid messages form healthy chain
      expect(result.messageCount).toBe(4) // Only valid JSON lines with uuid
    })

    it('handles empty file', async () => {
      const result = await scanner.scan(path.join(FIXTURES_DIR, 'empty.jsonl'))

      expect(result.status).toBe('healthy') // No messages = no broken chain
      expect(result.chainDepth).toBe(0)
      expect(result.messageCount).toBe(0)
    })

    it('handles file with no uuid fields', async () => {
      const result = await scanner.scan(path.join(FIXTURES_DIR, 'no-uuid.jsonl'))

      expect(result.status).toBe('healthy') // No uuid messages = no chain to check
      expect(result.messageCount).toBe(0)
    })

    it('extracts session ID from filename', async () => {
      const result = await scanner.scan(path.join(FIXTURES_DIR, 'healthy.jsonl'))
      expect(result.sessionId).toBe('healthy')

      const result2 = await scanner.scan(path.join(FIXTURES_DIR, 'corrupted-shallow.jsonl'))
      expect(result2.sessionId).toBe('corrupted-shallow')
    })

    it('includes file size in result', async () => {
      const result = await scanner.scan(path.join(FIXTURES_DIR, 'healthy.jsonl'))
      const stat = await fs.stat(path.join(FIXTURES_DIR, 'healthy.jsonl'))
      expect(result.fileSize).toBe(stat.size)
    })
  })

  describe('repair()', () => {
    async function copyFixture(name: string): Promise<string> {
      const src = path.join(FIXTURES_DIR, name)
      const dest = path.join(tempDir, name)
      await fs.copyFile(src, dest)
      return dest
    }

    it('re-parents orphan messages correctly', async () => {
      const testFile = await copyFixture('corrupted-shallow.jsonl')
      const result = await scanner.repair(testFile)

      expect(result.status).toBe('repaired')
      expect(result.orphansFixed).toBe(1)

      // Verify the file is now healthy
      const scanAfter = await scanner.scan(testFile)
      expect(scanAfter.status).toBe('healthy')
      expect(scanAfter.orphanCount).toBe(0)
    })

    it('creates backup before modifying', async () => {
      const testFile = await copyFixture('corrupted-shallow.jsonl')
      const originalContent = await fs.readFile(testFile, 'utf8')

      const result = await scanner.repair(testFile)

      expect(result.backupPath).toBeDefined()
      expect(result.backupPath).toMatch(/\.backup-\d+$/)

      // Backup should have original content
      const backupContent = await fs.readFile(result.backupPath!, 'utf8')
      expect(backupContent).toBe(originalContent)
    })

    it('is idempotent - calling twice is safe', async () => {
      const testFile = await copyFixture('corrupted-shallow.jsonl')

      const result1 = await scanner.repair(testFile)
      expect(result1.status).toBe('repaired')

      const result2 = await scanner.repair(testFile)
      expect(result2.status).toBe('already_healthy')
      expect(result2.orphansFixed).toBe(0)
    })

    it('repaired chain reaches root', async () => {
      const testFile = await copyFixture('corrupted-shallow.jsonl')
      await scanner.repair(testFile)

      const scanResult = await scanner.scan(testFile)
      expect(scanResult.chainDepth).toBe(scanResult.messageCount)
    })

    it('preserves message content (only parentUuid changes)', async () => {
      const testFile = await copyFixture('corrupted-shallow.jsonl')
      const linesBefore = (await fs.readFile(testFile, 'utf8')).split('\n').filter(Boolean)

      await scanner.repair(testFile)

      const linesAfter = (await fs.readFile(testFile, 'utf8')).split('\n').filter(Boolean)
      expect(linesAfter.length).toBe(linesBefore.length)

      // Check that only parentUuid changed for the orphan line
      for (let i = 0; i < linesBefore.length; i++) {
        const before = JSON.parse(linesBefore[i])
        const after = JSON.parse(linesAfter[i])

        // uuid and type must be preserved
        expect(after.uuid).toBe(before.uuid)
        expect(after.type).toBe(before.type)
        expect(after.message).toBe(before.message)

        // If this wasn't an orphan, parentUuid should be preserved
        if (before.parentUuid !== 'subagent-uuid-not-in-file') {
          expect(after.parentUuid).toBe(before.parentUuid)
        }
      }
    })

    it('repairs multiple orphans', async () => {
      const testFile = await copyFixture('corrupted-multiple.jsonl')
      const result = await scanner.repair(testFile)

      expect(result.status).toBe('repaired')
      expect(result.orphansFixed).toBe(3)

      const scanAfter = await scanner.scan(testFile)
      expect(scanAfter.status).toBe('healthy')
    })

    it('handles already healthy file', async () => {
      const testFile = await copyFixture('healthy.jsonl')
      const result = await scanner.repair(testFile)

      expect(result.status).toBe('already_healthy')
      expect(result.orphansFixed).toBe(0)
      expect(result.backupPath).toBeUndefined() // No backup for healthy files
    })

    it('returns failed for missing file', async () => {
      const result = await scanner.repair(path.join(tempDir, 'does-not-exist.jsonl'))

      expect(result.status).toBe('failed')
      expect(result.error).toBeDefined()
    })

    it('repairs deep corruption correctly', async () => {
      const testFile = await copyFixture('corrupted-deep.jsonl')
      const result = await scanner.repair(testFile)

      expect(result.status).toBe('repaired')
      expect(result.orphansFixed).toBe(1)
      expect(result.newChainDepth).toBe(21) // All 21 messages now in chain

      const scanAfter = await scanner.scan(testFile)
      expect(scanAfter.status).toBe('healthy')
      expect(scanAfter.chainDepth).toBe(21)
    })
  })

  describe('scanBatch()', () => {
    it('scans multiple files in parallel', async () => {
      const files = [
        path.join(FIXTURES_DIR, 'healthy.jsonl'),
        path.join(FIXTURES_DIR, 'corrupted-shallow.jsonl'),
        path.join(FIXTURES_DIR, 'corrupted-deep.jsonl'),
      ]

      const results = await scanner.scanBatch(files)

      expect(results).toHaveLength(3)
      expect(results[0].status).toBe('healthy')
      expect(results[1].status).toBe('corrupted')
      expect(results[2].status).toBe('corrupted')
    })

    it('handles mix of existing and missing files', async () => {
      const files = [
        path.join(FIXTURES_DIR, 'healthy.jsonl'),
        path.join(FIXTURES_DIR, 'does-not-exist.jsonl'),
      ]

      const results = await scanner.scanBatch(files)

      expect(results).toHaveLength(2)
      expect(results[0].status).toBe('healthy')
      expect(results[1].status).toBe('missing')
    })

    it('returns empty array for empty input', async () => {
      const results = await scanner.scanBatch([])
      expect(results).toHaveLength(0)
    })
  })
})
