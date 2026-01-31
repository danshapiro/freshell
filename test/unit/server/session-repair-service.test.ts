import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { SessionRepairService } from '../../../server/session-scanner/service.js'
import type { SessionScanResult } from '../../../server/session-scanner/types.js'

const FIXTURES_DIR = path.join(__dirname, '../../fixtures/sessions')

describe('SessionRepairService', () => {
  let tempDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-repair-service-'))
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempDir)
  })

  afterEach(async () => {
    homedirSpy.mockRestore()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('resolves session file paths when prioritizing', async () => {
    const projectDir = path.join(tempDir, '.claude', 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })

    const sessionId = 'priority-session'
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.copyFile(path.join(FIXTURES_DIR, 'healthy.jsonl'), sessionFile)

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

    await new Promise((r) => setTimeout(r, 100))

    expect(scanner.scan).toHaveBeenCalled()
    expect(scanner.scan).toHaveBeenCalledWith(sessionFile)

    await service.stop()
  })
})
