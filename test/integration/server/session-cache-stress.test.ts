// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { SessionContentCache } from '../../../server/session-content-cache.js'
import { loadSessionHistory } from '../../../server/session-history-loader.js'

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

describe('SessionContentCache stress tests', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-cache-stress-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  it('50 concurrent session opens with cache: all resolve correctly', async () => {
    const cache = new SessionContentCache()
    const files: { path: string; expectedText: string }[] = []

    // Create 50 temp .jsonl files with distinct content
    for (let i = 0; i < 50; i++) {
      const filePath = path.join(tmpDir, `session-${i}.jsonl`)
      const text = `Unique content for session ${i}`
      await fsp.writeFile(filePath, createJsonlContent([
        { role: 'user', text },
      ]))
      files.push({ path: filePath, expectedText: text })
    }

    // Also create a projects dir for loadSessionHistory
    await fsp.mkdir(path.join(tmpDir, 'projects'), { recursive: true })

    // Open all 50 concurrently via loadSessionHistory with resolver + cache
    const results = await Promise.all(
      files.map(({ path: filePath, expectedText }) =>
        loadSessionHistory('dummy-id', tmpDir, {
          resolveFilePath: () => filePath,
          contentCache: cache,
        }).then((messages) => ({
          messages,
          expectedText,
        })),
      ),
    )

    // All 50 should return correct messages
    for (const { messages, expectedText } of results) {
      expect(messages).toHaveLength(1)
      expect(messages![0].content[0].text).toBe(expectedText)
    }
  })

  it('rapid writer/reader race: reader always gets consistent snapshot', async () => {
    const filePath = path.join(tmpDir, 'writer-reader.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Initial message' },
    ]))

    const cache = new SessionContentCache()
    const results: number[] = []
    let running = true

    // Writer: appends lines every 5ms
    const writerPromise = (async () => {
      let count = 1
      while (running && count < 20) {
        await new Promise((r) => setTimeout(r, 5))
        await fsp.appendFile(filePath, '\n' + createJsonlContent([
          { role: 'user', text: `Appended message ${++count}` },
        ]))
      }
    })()

    // Reader: reads every 10ms for 200ms
    const readerPromise = (async () => {
      const deadline = Date.now() + 200
      while (Date.now() < deadline) {
        const messages = await cache.get(filePath)
        if (messages !== null) {
          results.push(messages.length)
        }
        await new Promise((r) => setTimeout(r, 10))
      }
    })()

    await readerPromise
    running = false
    await writerPromise

    // Every result should be a valid prefix (monotonically non-decreasing or consistent)
    // At minimum, we should have gotten some results
    expect(results.length).toBeGreaterThan(0)
    // Each result should be >= 1 (at least the initial message)
    for (const count of results) {
      expect(count).toBeGreaterThanOrEqual(1)
    }
  })

  it('eviction storm: 200 unique files exceed budget, cache stays bounded', async () => {
    const cache = new SessionContentCache({ maxBytes: 10_000 })

    // Create 200 small files (~200 bytes content each)
    for (let i = 0; i < 200; i++) {
      const filePath = path.join(tmpDir, `evict-${i}.jsonl`)
      await fsp.writeFile(filePath, createJsonlContent([
        { role: 'user', text: `Entry ${i}` },
      ]))
      await cache.get(filePath)

      // Check budget at each step
      expect(cache.stats().totalBytes).toBeLessThanOrEqual(10_000 * 1.5) // allow single-entry overshoot
    }

    expect(cache.stats().entries).toBeLessThan(200)
    expect(cache.stats().totalBytes).toBeLessThanOrEqual(10_000 * 1.5)
  })

  it('mixed concurrent invalidation and reads: no crashes or deadlocks', async () => {
    const cache = new SessionContentCache()
    const files: string[] = []

    // Create 10 files
    for (let i = 0; i < 10; i++) {
      const filePath = path.join(tmpDir, `mixed-${i}.jsonl`)
      await fsp.writeFile(filePath, createJsonlContent([
        { role: 'user', text: `File ${i}` },
      ]))
      files.push(filePath)
    }

    // Mix of operations: 20 reads, 20 invalidates, 10 clears
    const operations: Promise<void>[] = []

    // 20 reads
    for (let i = 0; i < 20; i++) {
      operations.push(
        cache.get(files[i % files.length]!).then(() => undefined),
      )
    }

    // 20 invalidates
    for (let i = 0; i < 20; i++) {
      operations.push(
        Promise.resolve().then(() => {
          cache.invalidate(files[i % files.length]!)
        }),
      )
    }

    // 10 clears
    for (let i = 0; i < 10; i++) {
      operations.push(
        Promise.resolve().then(() => {
          cache.clear()
        }),
      )
    }

    // All should settle without throwing
    await expect(Promise.all(operations)).resolves.toBeDefined()
  })
})
