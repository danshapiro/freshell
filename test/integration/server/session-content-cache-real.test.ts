// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { SessionContentCache } from '../../../server/session-content-cache.js'

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

async function findRealJsonlFile(): Promise<string | null> {
  const claudeHome = process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude')
  const projectsDir = path.join(claudeHome, 'projects')
  try {
    const topLevel = await fsp.readdir(projectsDir, { withFileTypes: true })
    for (const entry of topLevel) {
      if (!entry.isDirectory()) continue
      const projectDir = path.join(projectsDir, entry.name)
      const files = await fsp.readdir(projectDir)
      const jsonlFile = files.find((f) => f.endsWith('.jsonl'))
      if (jsonlFile) return path.join(projectDir, jsonlFile)
    }
  } catch {
    return null
  }
  return null
}

describe('SessionContentCache real filesystem', () => {
  let tmpDir: string
  let realFilePath: string | null

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-cache-real-'))
    realFilePath = await findRealJsonlFile()
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('real .jsonl file from ~/.claude: reads and caches correctly', async function () {
    if (!realFilePath) {
      return // skip if no real files available
    }

    const cache = new SessionContentCache()
    const first = await cache.get(realFilePath)
    expect(first).not.toBeNull()
    expect(first!.length).toBeGreaterThan(0)

    // Second read should come from cache
    const readFileSpy = vi.spyOn(fsp, 'readFile')
    const second = await cache.get(realFilePath)
    expect(second).toEqual(first)
    expect(readFileSpy).not.toHaveBeenCalled()
  })

  it('concurrent reads coalesce into single file read', async () => {
    // Use a synthetic file to guarantee controlled behavior
    const filePath = path.join(tmpDir, 'coalesce-test.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Coalesced read test' },
      { role: 'assistant', text: 'Response' },
    ]))

    const cache = new SessionContentCache()
    const originalReadFile = fsp.readFile.bind(fsp)
    let readFileCount = 0
    vi.spyOn(fsp, 'readFile').mockImplementation((...args: any[]) => {
      readFileCount++
      return (originalReadFile as any)(...args)
    })

    // Fire 10 concurrent reads
    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.get(filePath)),
    )

    // All should return the same data
    for (const result of results) {
      expect(result).toHaveLength(2)
    }

    // readFile should have been called exactly once (coalescing)
    expect(readFileCount).toBe(1)
  })

  it('file mutation mid-read: next call sees updated content', async () => {
    const filePath = path.join(tmpDir, 'mutation-test.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Original' },
    ]))

    const cache = new SessionContentCache()
    const first = await cache.get(filePath)
    expect(first).toHaveLength(1)

    // Mutate the file
    await new Promise((r) => setTimeout(r, 100))
    await fsp.appendFile(filePath, '\n' + createJsonlContent([
      { role: 'assistant', text: 'Added later' },
    ]))

    const second = await cache.get(filePath)
    expect(second).toHaveLength(2)
    expect(second![1].content[0].text).toBe('Added later')
  })

  it('cache respects maxBytes across real session files', async () => {
    // Create several files that exceed a small budget
    const files: string[] = []
    for (let i = 0; i < 10; i++) {
      const filePath = path.join(tmpDir, `session-${i}.jsonl`)
      const messages = Array.from({ length: 20 }, (_, j) => ({
        role: 'user' as const,
        text: `Message ${j} in session ${i} with enough padding to make it reasonably large for testing purposes`,
      }))
      await fsp.writeFile(filePath, createJsonlContent(messages))
      files.push(filePath)
    }

    const cache = new SessionContentCache({ maxBytes: 50_000 })

    for (const f of files) {
      await cache.get(f)
    }

    // Cache should be bounded
    expect(cache.stats().totalBytes).toBeLessThanOrEqual(50_000 * 1.1)
    expect(cache.stats().entries).toBeLessThan(10)
  })
})
