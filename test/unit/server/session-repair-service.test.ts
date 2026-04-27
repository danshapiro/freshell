import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { logger } from '../../../server/logger.js'
import { SessionRepairService } from '../../../server/session-scanner/service.js'
import type { SessionScanResult } from '../../../server/session-scanner/types.js'

function createTranscript(sessionId: string, cwd: string, prompt = 'Repair this restore issue'): string {
  return [
    JSON.stringify({
      type: 'queue-operation',
      operation: 'dequeue',
      sessionId,
      timestamp: '2026-03-08T08:38:07.095Z',
    }),
    JSON.stringify({
      type: 'user',
      sessionId,
      cwd,
      timestamp: '2026-03-08T08:38:07.287Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId,
      message: 'On it.',
      timestamp: '2026-03-08T08:38:17.324Z',
    }),
  ].join('\n')
}

describe('SessionRepairService', () => {
  let tempDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>
  const originalClaudeHome = process.env.CLAUDE_HOME

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-repair-service-'))
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempDir)
    process.env.CLAUDE_HOME = path.join(tempDir, '.claude')
  })

  afterEach(async () => {
    homedirSpy.mockRestore()
    if (originalClaudeHome === undefined) {
      delete process.env.CLAUDE_HOME
    } else {
      process.env.CLAUDE_HOME = originalClaudeHome
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('resolves session file paths when prioritizing', async () => {
    const projectDir = path.join(tempDir, '.claude', 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })

    const sessionId = '00000000-0000-4000-8000-000000000711'
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.writeFile(sessionFile, createTranscript(sessionId, '/tmp/project'))

    const scanner = {
      scan: vi.fn(async (filePath: string): Promise<SessionScanResult> => ({
        sessionId: path.basename(filePath, '.jsonl'),
        filePath,
        status: 'healthy',
        chainDepth: 1,
        orphanCount: 0,
        fileSize: 1,
        messageCount: 1,
      })),
      repair: vi.fn(),
    }

    const service = new SessionRepairService({
      cacheDir: tempDir,
      scanner: scanner as any,
    })

    await service.start()

    service.prioritizeSessions({ active: sessionId })

    await vi.waitFor(() => {
      expect(scanner.scan).toHaveBeenCalledWith(sessionFile)
    })

    await service.stop()
  })

  it('returns cached results for active sessions even when the queue is busy', async () => {
    const projectDir = path.join(tempDir, '.claude', 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })

    const slowSessionId = '00000000-0000-4000-8000-000000000712'
    const targetSessionId = '00000000-0000-4000-8000-000000000713'
    const slowFile = path.join(projectDir, `${slowSessionId}.jsonl`)
    const targetFile = path.join(projectDir, `${targetSessionId}.jsonl`)
    await fs.writeFile(slowFile, createTranscript(slowSessionId, '/tmp/slow-project'))
    await fs.writeFile(targetFile, createTranscript(targetSessionId, '/tmp/target-project'))

    let releaseSlow: (() => void) | undefined
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })

    const scan = vi.fn(async (filePath: string): Promise<SessionScanResult> => {
      if (filePath === slowFile) {
        await slowGate
      }
      return {
        sessionId: path.basename(filePath, '.jsonl'),
        filePath,
        status: 'healthy',
        chainDepth: 1,
        orphanCount: 0,
        fileSize: 1,
        messageCount: 1,
      }
    })

    const service = new SessionRepairService({
      cacheDir: tempDir,
      scanner: { scan, repair: vi.fn() } as any,
    })

    const cachedResult: SessionScanResult = {
      sessionId: targetSessionId,
      filePath: targetFile,
      status: 'healthy',
      chainDepth: 1,
      orphanCount: 0,
      fileSize: 1,
      messageCount: 1,
    }
    await (service as any).cache.set(targetFile, cachedResult)

    await service.start()

    service.prioritizeSessions({ background: [slowSessionId] })
    await vi.waitFor(() => {
      expect(scan).toHaveBeenCalledWith(slowFile)
    })

    try {
      const result = await service.waitForSession(targetSessionId, 50)
      expect(result.sessionId).toBe(targetSessionId)
      expect(result.status).toBe('healthy')
      expect(scan).toHaveBeenCalledWith(slowFile)

      const historyPath = path.join(tempDir, '.claude', 'history.jsonl')
      const history = await fs.readFile(historyPath, 'utf8')
      expect(history).toContain(targetSessionId)
    } finally {
      releaseSlow?.()
      await service.stop()
    }
  })

  it('discovers top-level Claude sessions on start and skips nested subagents', async () => {
    const projectDir = path.join(tempDir, '.claude', 'projects', 'test-project')
    const nestedDir = path.join(projectDir, 'parent-session', 'subagents')
    await fs.mkdir(nestedDir, { recursive: true })

    const topLevelSessionId = 'top-level-session'
    const topLevelFile = path.join(projectDir, `${topLevelSessionId}.jsonl`)
    await fs.writeFile(topLevelFile, createTranscript(topLevelSessionId, '/tmp/project'))

    const nestedSessionId = 'nested-subagent'
    await fs.writeFile(path.join(nestedDir, `${nestedSessionId}.jsonl`), createTranscript(nestedSessionId, '/tmp/nested'))

    const scan = vi.fn(async (filePath: string): Promise<SessionScanResult> => ({
      sessionId: path.basename(filePath, '.jsonl'),
      filePath,
      status: 'healthy',
      chainDepth: 1,
      orphanCount: 0,
      fileSize: 1,
      messageCount: 1,
    }))

    const service = new SessionRepairService({
      cacheDir: tempDir,
      scanner: { scan, repair: vi.fn() } as any,
    })

    await service.start()
    try {
      await vi.waitFor(() => {
        expect(scan).toHaveBeenCalledWith(topLevelFile)
      })
      expect(scan).not.toHaveBeenCalledWith(path.join(nestedDir, `${nestedSessionId}.jsonl`))
      const historyPath = path.join(tempDir, '.claude', 'history.jsonl')
      await vi.waitFor(async () => {
        const history = await fs.readFile(historyPath, 'utf8')
        expect(history).toContain(topLevelSessionId)
        expect(history).not.toContain(nestedSessionId)
      })
    } finally {
      await service.stop()
    }
  })

  it('waits for in-flight history backfill before stop resolves', async () => {
    const projectDir = path.join(tempDir, '.claude', 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })

    const sessionId = '00000000-0000-4000-8000-000000000714'
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.writeFile(sessionFile, createTranscript(sessionId, '/tmp/project'))

    let releaseHistory: (() => void) | undefined
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve
    })

    const service = new SessionRepairService({
      cacheDir: tempDir,
      scanner: {
        scan: vi.fn(async (filePath: string): Promise<SessionScanResult> => ({
          sessionId: path.basename(filePath, '.jsonl'),
          filePath,
          status: 'healthy',
          chainDepth: 1,
          orphanCount: 0,
          fileSize: 1,
          messageCount: 1,
        })),
        repair: vi.fn(),
      } as any,
    })

    const ensureHistoryEntryForFile = vi.fn(async () => {
      await historyGate
      return { status: 'created' as const }
    })
    ;(service as any).historyRepairer = {
      ensureHistoryEntryForFile,
    }

    await service.start()
    service.prioritizeSessions({ active: sessionId })

    await vi.waitFor(() => {
      expect(ensureHistoryEntryForFile).toHaveBeenCalledWith(sessionFile)
    })

    let stopped = false
    const stopPromise = service.stop().then(() => {
      stopped = true
    })

    await Promise.resolve()
    expect(stopped).toBe(false)

    releaseHistory?.()
    await stopPromise
    expect(stopped).toBe(true)
  })

  it('treats history backfill failures as best-effort during waitForSession', async () => {
    const projectDir = path.join(tempDir, '.claude', 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })

    const sessionId = '00000000-0000-4000-8000-000000000715'
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.writeFile(sessionFile, createTranscript(sessionId, '/tmp/project'))

    const service = new SessionRepairService({
      cacheDir: tempDir,
      scanner: {
        scan: vi.fn(async (filePath: string): Promise<SessionScanResult> => ({
          sessionId: path.basename(filePath, '.jsonl'),
          filePath,
          status: 'healthy',
          chainDepth: 1,
          orphanCount: 0,
          fileSize: 1,
          messageCount: 1,
        })),
        repair: vi.fn(),
      } as any,
    })

    const historyError = new Error('history append failed')
    ;(service as any).historyRepairer = {
      ensureHistoryEntryForFile: vi.fn().mockRejectedValue(historyError),
    }

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const emittedErrors: Array<{ sessionId: string; error: Error }> = []
    service.on('error', (failedSessionId, error) => {
      emittedErrors.push({ sessionId: failedSessionId, error })
    })

    await service.start()

    try {
      const result = await service.waitForSession(sessionId, 5000)

      expect(result).toMatchObject({
        sessionId,
        filePath: sessionFile,
        status: 'healthy',
      })
      expect(emittedErrors).toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          err: historyError,
          filePath: sessionFile,
          sessionId,
        }),
        'Failed to backfill Claude history entry'
      )
    } finally {
      warnSpy.mockRestore()
      await service.stop()
    }
  })

  it('returns cached result immediately when session is queued but cache is valid', async () => {
    const projectDir = path.join(tempDir, '.claude', 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })

    const targetSessionId = '00000000-0000-4000-8000-000000000716'
    const targetFile = path.join(projectDir, `${targetSessionId}.jsonl`)
    await fs.writeFile(targetFile, createTranscript(targetSessionId, '/tmp/target'))

    // Scanner that should never be called for the target session
    const scan = vi.fn(async (filePath: string): Promise<SessionScanResult> => {
      await new Promise(() => {}) // block forever
      throw new Error('unreachable')
    })

    const service = new SessionRepairService({
      cacheDir: tempDir,
      scanner: { scan, repair: vi.fn() } as any,
    })

    // Seed the cache and session path index
    const cachedResult: SessionScanResult = {
      sessionId: targetSessionId,
      filePath: targetFile,
      status: 'healthy',
      chainDepth: 5,
      orphanCount: 0,
      fileSize: 100,
      messageCount: 10,
    }
    await (service as any).cache.set(targetFile, cachedResult)

    // Directly enqueue the session in the queue (simulating what discovery does)
    // but DON'T start the queue, so it stays queued and never processes
    const queue = (service as any).queue
    queue.enqueue([{ sessionId: targetSessionId, filePath: targetFile, priority: 'disk' }])

    // Also set the session path index (normally done by discovery)
    ;(service as any).sessionPathIndex.set(targetSessionId, targetFile)

    // The session is now queued but not processed.
    // waitForSession should find it via cache and return immediately.
    const before = Date.now()
    const result = await service.waitForSession(targetSessionId, 100)
    const elapsed = Date.now() - before

    expect(result.sessionId).toBe(targetSessionId)
    expect(result.status).toBe('healthy')
    expect(result.chainDepth).toBe(5)
    expect(elapsed).toBeLessThan(50)
    // Scanner should NOT have been called — cache hit bypassed it
    expect(scan).not.toHaveBeenCalled()
  })
})
