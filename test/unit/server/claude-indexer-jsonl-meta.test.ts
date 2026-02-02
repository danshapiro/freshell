import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { parseSessionJsonlMeta } from '../../../server/claude-indexer'

describe('parseSessionJsonlMeta', () => {
  let tempDir: string
  let sessionFile: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-jsonl-meta-'))
    sessionFile = path.join(tempDir, 'session.jsonl')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('respects maxBytes when reading metadata', async () => {
    const line1 = JSON.stringify({
      cwd: '/tmp',
      role: 'user',
      content: 'First title',
      timestamp: '2025-01-02T00:00:05.000Z',
    })
    const line2 = JSON.stringify({
      summary: 'Second summary',
      timestamp: '2025-01-02T00:00:01.000Z',
    })

    await fs.writeFile(sessionFile, `${line1}\n${line2}\n`)

    const maxBytes = Buffer.byteLength(line1, 'utf8') + 1
    const meta = await parseSessionJsonlMeta(sessionFile, { maxBytes })

    expect(meta.title).toContain('First title')
    expect(meta.summary).toBeUndefined()
    expect(meta.messageCount).toBe(1)
    expect(meta.createdAt).toBe(Date.parse('2025-01-02T00:00:05.000Z'))
  })

  it('continues reading when metadata is incomplete', async () => {
    const line1 = JSON.stringify({
      cwd: '/tmp',
      role: 'user',
      content: 'First title',
      timestamp: '2025-01-02T00:00:05.000Z',
    })
    const line2 = JSON.stringify({
      summary: 'Second summary',
      timestamp: '2025-01-02T00:00:01.000Z',
    })

    await fs.writeFile(sessionFile, `${line1}\n${line2}\n`)

    const maxBytes = Buffer.byteLength(`${line1}\n${line2}\n`, 'utf8') + 10
    const meta = await parseSessionJsonlMeta(sessionFile, { maxBytes })

    expect(meta.title).toContain('First title')
    expect(meta.summary).toBe('Second summary')
    expect(meta.messageCount).toBe(2)
    expect(meta.createdAt).toBe(Date.parse('2025-01-02T00:00:01.000Z'))
  })
})
