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

describe('SessionContentCache', () => {
  let tmpDir: string
  let cache: SessionContentCache

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-content-cache-'))
    cache = new SessionContentCache()
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('cache hit: second get() returns cached messages without re-reading file', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi there' },
    ]))

    const first = await cache.get(filePath)
    const readFileSpy = vi.spyOn(fsp, 'readFile')
    const second = await cache.get(filePath)

    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    expect(first).toEqual(second)
    expect(readFileSpy).not.toHaveBeenCalled()
  })

  it('cache miss on mtime change: re-reads file after modification', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Hello' },
    ]))

    const first = await cache.get(filePath)
    expect(first).toHaveLength(1)

    await new Promise((r) => setTimeout(r, 100))

    await fsp.appendFile(filePath, '\n' + createJsonlContent([
      { role: 'assistant', text: 'World' },
    ]))

    const second = await cache.get(filePath)
    expect(second).toHaveLength(2)
    expect(second![1].content[0].text).toBe('World')
  })

  it('cache miss on size change: re-reads when size differs', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Short' },
    ]))

    const first = await cache.get(filePath)
    expect(first).toHaveLength(1)

    await new Promise((r) => setTimeout(r, 100))

    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'This is a much longer message than before' },
      { role: 'assistant', text: 'And another message to make it bigger' },
    ]))

    const second = await cache.get(filePath)
    expect(second).toHaveLength(2)
  })

  it('stat error (file deleted): returns null and evicts entry', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Soon to be deleted' },
    ]))

    const first = await cache.get(filePath)
    expect(first).toHaveLength(1)
    expect(cache.stats().entries).toBe(1)

    await fsp.unlink(filePath)

    const second = await cache.get(filePath)
    expect(second).toBeNull()
    expect(cache.stats().entries).toBe(0)
  })

  it('LRU eviction: oldest entries evicted when over budget', async () => {
    const smallCache = new SessionContentCache({ maxBytes: 2048 })

    const files: string[] = []
    for (let i = 0; i < 3; i++) {
      const filePath = path.join(tmpDir, `session-${i}.jsonl`)
      const messages = Array.from({ length: 5 }, (_, j) => ({
        role: 'user' as const,
        text: `Message ${j} in session ${i} with some padding text to increase size!`,
      }))
      await fsp.writeFile(filePath, createJsonlContent(messages))
      files.push(filePath)
    }

    for (const f of files) {
      await smallCache.get(f)
    }

    expect(smallCache.stats().entries).toBeLessThanOrEqual(2)
    expect(smallCache.stats().totalBytes).toBeLessThanOrEqual(2048 * 1.1)
  })

  it('size tracking: totalBytes updated on insert and eviction', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Test message for size tracking' },
    ]))

    expect(cache.stats().totalBytes).toBe(0)

    await cache.get(filePath)
    const afterInsert = cache.stats().totalBytes
    expect(afterInsert).toBeGreaterThan(0)

    const smallCache = new SessionContentCache({ maxBytes: 1500 })
    const f1 = path.join(tmpDir, 'small-1.jsonl')
    const f2 = path.join(tmpDir, 'small-2.jsonl')
    await fsp.writeFile(f1, createJsonlContent([{ role: 'user', text: 'A' }]))
    await fsp.writeFile(f2, createJsonlContent([{ role: 'user', text: 'B' }]))

    await smallCache.get(f1)
    const bytesAfterF1 = smallCache.stats().totalBytes
    expect(bytesAfterF1).toBeGreaterThan(0)
    expect(smallCache.stats().entries).toBe(1)

    await smallCache.get(f2)
    expect(smallCache.stats().entries).toBeLessThanOrEqual(2)
    expect(smallCache.stats().totalBytes).toBeLessThanOrEqual(1500 * 1.5)
  })

  it('invalidate() removes specific entry', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Will be invalidated' },
    ]))

    await cache.get(filePath)
    expect(cache.stats().entries).toBe(1)

    cache.invalidate(filePath)
    expect(cache.stats().entries).toBe(0)

    const readFileSpy = vi.spyOn(fsp, 'readFile')
    await cache.get(filePath)
    expect(readFileSpy).toHaveBeenCalled()
  })

  it('clear() removes all entries', async () => {
    const files: string[] = []
    for (let i = 0; i < 3; i++) {
      const filePath = path.join(tmpDir, `session-${i}.jsonl`)
      await fsp.writeFile(filePath, createJsonlContent([
        { role: 'user', text: `Message ${i}` },
      ]))
      files.push(filePath)
    }

    for (const f of files) {
      await cache.get(f)
    }
    expect(cache.stats().entries).toBe(3)

    cache.clear()
    expect(cache.stats().entries).toBe(0)
    expect(cache.stats().totalBytes).toBe(0)
  })

  it('empty .jsonl file returns empty array (not null)', async () => {
    const filePath = path.join(tmpDir, 'empty.jsonl')
    await fsp.writeFile(filePath, '')

    const result = await cache.get(filePath)
    expect(result).toEqual([])
    expect(result).not.toBeNull()
  })

  it('rejects invalid FRESHELL_SESSION_CACHE_MAX_MB values', () => {
    const origEnv = process.env.FRESHELL_SESSION_CACHE_MAX_MB
    try {
      process.env.FRESHELL_SESSION_CACHE_MAX_MB = 'not-a-number'
      expect(() => new SessionContentCache()).toThrow('Invalid FRESHELL_SESSION_CACHE_MAX_MB')

      process.env.FRESHELL_SESSION_CACHE_MAX_MB = '-5'
      expect(() => new SessionContentCache()).toThrow('must be a positive number')

      process.env.FRESHELL_SESSION_CACHE_MAX_MB = '0'
      expect(() => new SessionContentCache()).toThrow('must be a positive number')

      process.env.FRESHELL_SESSION_CACHE_MAX_MB = 'Infinity'
      expect(() => new SessionContentCache()).toThrow('Invalid FRESHELL_SESSION_CACHE_MAX_MB')
    } finally {
      if (origEnv === undefined) delete process.env.FRESHELL_SESSION_CACHE_MAX_MB
      else process.env.FRESHELL_SESSION_CACHE_MAX_MB = origEnv
    }
  })

  it('accepts valid FRESHELL_SESSION_CACHE_MAX_MB', () => {
    const origEnv = process.env.FRESHELL_SESSION_CACHE_MAX_MB
    try {
      process.env.FRESHELL_SESSION_CACHE_MAX_MB = '50'
      const c = new SessionContentCache()
      expect(c.stats().maxBytes).toBe(50 * 1024 * 1024)
    } finally {
      if (origEnv === undefined) delete process.env.FRESHELL_SESSION_CACHE_MAX_MB
      else process.env.FRESHELL_SESSION_CACHE_MAX_MB = origEnv
    }
  })

  it('malformed JSONL caches partial result', async () => {
    const filePath = path.join(tmpDir, 'malformed.jsonl')
    const content = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Valid 1' }] }, timestamp: '2026-01-01T00:00:01Z' }),
      'this is not valid json at all',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Valid 2' }] }, timestamp: '2026-01-01T00:00:02Z' }),
    ].join('\n')
    await fsp.writeFile(filePath, content)

    const first = await cache.get(filePath)
    expect(first).toHaveLength(2)

    const readFileSpy = vi.spyOn(fsp, 'readFile')
    const second = await cache.get(filePath)
    expect(second).toHaveLength(2)
    expect(readFileSpy).not.toHaveBeenCalled()
  })
})
