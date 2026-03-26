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

describe('SessionContentCache race conditions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-cache-race-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('file deleted between stat and read: returns null gracefully', async () => {
    const filePath = path.join(tmpDir, 'vanishing.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'I will vanish' },
    ]))

    const cache = new SessionContentCache()

    const first = await cache.get(filePath)
    expect(first).toHaveLength(1)

    await fsp.unlink(filePath)
    cache.invalidate(filePath)

    vi.restoreAllMocks()
    vi.spyOn(fsp, 'stat').mockResolvedValue({
      mtimeMs: Date.now(),
      size: 100,
    } as any)
    vi.spyOn(fsp, 'readFile').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    )

    const result = await cache.get(filePath)
    expect(result).toBeNull()
    expect(cache.stats().entries).toBe(0)
  })

  it('rapid mtime churn: cache correctly invalidates on every change', async () => {
    const filePath = path.join(tmpDir, 'churning.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Message 1' },
    ]))

    const cache = new SessionContentCache()

    const first = await cache.get(filePath)
    expect(first).toHaveLength(1)

    for (let i = 2; i <= 6; i++) {
      await new Promise((r) => setTimeout(r, 10))
      await fsp.appendFile(filePath, '\n' + createJsonlContent([
        { role: 'user', text: `Message ${i}` },
      ]))
      const result = await cache.get(filePath)
      expect(result!.length).toBeGreaterThanOrEqual(i)
    }
  })

  it('concurrent invalidation during coalesced read: next caller gets fresh data', async () => {
    const filePath = path.join(tmpDir, 'coalesce-invalidate.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Original content' },
    ]))

    const cache = new SessionContentCache()

    const initial = await cache.get(filePath)
    expect(initial).toHaveLength(1)

    await new Promise((r) => setTimeout(r, 50))
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Updated content' },
      { role: 'assistant', text: 'New response' },
    ]))

    cache.invalidate(filePath)

    const fresh = await cache.get(filePath)
    expect(fresh).toHaveLength(2)
    expect(fresh![0].content[0].text).toBe('Updated content')
  })

  it('coalesced read fails: all waiters receive null', async () => {
    const filePath = path.join(tmpDir, 'fail-coalesce.jsonl')

    const cache = new SessionContentCache()

    const results = await Promise.all(
      Array.from({ length: 5 }, () => cache.get(filePath)),
    )

    for (const result of results) {
      expect(result).toBeNull()
    }
  })
})
