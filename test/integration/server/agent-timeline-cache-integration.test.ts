// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { SessionContentCache } from '../../../server/session-content-cache.js'
import { loadSessionHistory } from '../../../server/session-history-loader.js'
import { createAgentTimelineService } from '../../../server/agent-timeline/service.js'

function createJsonlContent(
  messages: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: string }>,
): string {
  return messages
    .map((m, i) =>
      JSON.stringify({
        type: m.role,
        message: { role: m.role, content: [{ type: 'text', text: m.text }] },
        timestamp: m.timestamp ?? `2026-01-01T00:00:${String(i + 1).padStart(2, '0')}Z`,
      }),
    )
    .join('\n')
}

describe('agent timeline cache integration', () => {
  let tmpDir: string
  let cache: SessionContentCache

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-timeline-cache-'))
    cache = new SessionContentCache()
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('timeline page and turn body share cached file read', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'First message' },
      { role: 'assistant', text: 'First response' },
      { role: 'user', text: 'Second message' },
    ]))

    // Also create a projects dir so the scan fallback doesn't fail
    await fsp.mkdir(path.join(tmpDir, 'projects'), { recursive: true })

    const resolveFilePath = () => filePath

    const service = createAgentTimelineService({
      loadSessionHistory: (sessionId) =>
        loadSessionHistory(sessionId, tmpDir, { resolveFilePath, contentCache: cache }),
    })

    const originalReadFile = fsp.readFile.bind(fsp)
    let readFileCount = 0
    vi.spyOn(fsp, 'readFile').mockImplementation((...args: any[]) => {
      readFileCount++
      return (originalReadFile as any)(...args)
    })

    // Request timeline page
    const page = await service.getTimelinePage({
      sessionId: 'session',
      priority: 'visible',
    })
    expect(page.items).toHaveLength(3)

    // Request turn body for one of the items
    const turn = await service.getTurnBody({
      sessionId: 'session',
      turnId: page.items[0].turnId,
    })
    expect(turn).not.toBeNull()

    // readFile should have been called only once (cache shared the read)
    expect(readFileCount).toBe(1)
  })

  it('timeline invalidation after file change', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'First' },
      { role: 'assistant', text: 'Response' },
      { role: 'user', text: 'Third' },
    ]))

    await fsp.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
    const resolveFilePath = () => filePath

    const service = createAgentTimelineService({
      loadSessionHistory: (sessionId) =>
        loadSessionHistory(sessionId, tmpDir, { resolveFilePath, contentCache: cache }),
    })

    // First request: 3 items
    const page1 = await service.getTimelinePage({
      sessionId: 'session',
      priority: 'visible',
    })
    expect(page1.items).toHaveLength(3)

    // Append a new message
    await new Promise((r) => setTimeout(r, 100))
    await fsp.appendFile(filePath, '\n' + createJsonlContent([
      { role: 'assistant', text: 'Fourth message' },
    ]))

    // Second request should see the updated file
    const page2 = await service.getTimelinePage({
      sessionId: 'session',
      priority: 'visible',
    })
    expect(page2.items).toHaveLength(4)
  })

  it('concurrent timeline requests for same session coalesce', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'World' },
    ]))

    await fsp.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
    const resolveFilePath = () => filePath

    const service = createAgentTimelineService({
      loadSessionHistory: (sessionId) =>
        loadSessionHistory(sessionId, tmpDir, { resolveFilePath, contentCache: cache }),
    })

    const originalReadFile = fsp.readFile.bind(fsp)
    let readFileCount = 0
    vi.spyOn(fsp, 'readFile').mockImplementation((...args: any[]) => {
      readFileCount++
      return (originalReadFile as any)(...args)
    })

    // Fire 5 concurrent timeline requests
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.getTimelinePage({
          sessionId: 'session',
          priority: 'visible',
        }),
      ),
    )

    // All should return the same data
    for (const result of results) {
      expect(result.items).toHaveLength(2)
    }

    // readFile should have been called at most once (coalescing + caching)
    expect(readFileCount).toBeLessThanOrEqual(1)
  })
})
