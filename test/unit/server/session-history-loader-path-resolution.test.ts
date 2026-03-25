import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
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

describe('loadSessionHistory path resolution', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-path-res-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('resolveFilePath returns a path => skips directory scan, reads file directly', async () => {
    // Create a temp .jsonl file at a known path
    const filePath = path.join(tmpDir, 'resolved-session.jsonl')
    await fsp.writeFile(filePath, createJsonlContent([
      { role: 'user', text: 'Resolved message' },
    ]))

    // Also create a projects directory that would be found by the scan
    const projectDir = path.join(tmpDir, 'projects', 'my-project')
    await fsp.mkdir(projectDir, { recursive: true })

    const readdirSpy = vi.spyOn(fsp, 'readdir')

    const messages = await loadSessionHistory('resolved-session', tmpDir, {
      resolveFilePath: () => filePath,
    })

    expect(messages).toHaveLength(1)
    expect(messages![0].content[0].text).toBe('Resolved message')
    // readdir should NOT have been called because the resolver short-circuited the scan
    expect(readdirSpy).not.toHaveBeenCalled()
  })

  it('resolveFilePath returns undefined => falls back to directory scan', async () => {
    const projectDir = path.join(tmpDir, 'projects', 'my-project')
    await fsp.mkdir(projectDir, { recursive: true })
    const sessionId = 'scan-fallback-session'
    await fsp.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      createJsonlContent([{ role: 'user', text: 'Found via scan' }]),
    )

    const messages = await loadSessionHistory(sessionId, tmpDir, {
      resolveFilePath: () => undefined,
    })

    expect(messages).toHaveLength(1)
    expect(messages![0].content[0].text).toBe('Found via scan')
  })

  it('resolveFilePath returns a path that does not exist => falls back to scan', async () => {
    const projectDir = path.join(tmpDir, 'projects', 'my-project')
    await fsp.mkdir(projectDir, { recursive: true })
    const sessionId = 'fallback-on-enoent'
    await fsp.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      createJsonlContent([{ role: 'user', text: 'Found via scan fallback' }]),
    )

    const messages = await loadSessionHistory(sessionId, tmpDir, {
      resolveFilePath: () => path.join(tmpDir, 'nonexistent', 'missing.jsonl'),
    })

    expect(messages).toHaveLength(1)
    expect(messages![0].content[0].text).toBe('Found via scan fallback')
  })

  it('path traversal protection still applies when resolver is present', async () => {
    const resolver = vi.fn().mockReturnValue('/some/path.jsonl')

    const messages = await loadSessionHistory('../etc/passwd', tmpDir, {
      resolveFilePath: resolver,
    })

    expect(messages).toBeNull()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('resolver path is trusted (reads whatever it points to)', async () => {
    // Create two files with different content
    const resolverFile = path.join(tmpDir, 'resolver-target.jsonl')
    await fsp.writeFile(resolverFile, createJsonlContent([
      { role: 'user', text: 'From resolver' },
    ]))

    // Also create a file the scan would find
    const projectDir = path.join(tmpDir, 'projects', 'my-project')
    await fsp.mkdir(projectDir, { recursive: true })
    await fsp.writeFile(
      path.join(projectDir, 'trusted-test.jsonl'),
      createJsonlContent([{ role: 'user', text: 'From scan' }]),
    )

    const messages = await loadSessionHistory('trusted-test', tmpDir, {
      resolveFilePath: () => resolverFile,
    })

    expect(messages).toHaveLength(1)
    expect(messages![0].content[0].text).toBe('From resolver')
  })

  it('resolver is not called when sessionId fails validation', async () => {
    const resolver = vi.fn().mockReturnValue('/some/path.jsonl')

    const messages = await loadSessionHistory('foo/bar', tmpDir, {
      resolveFilePath: resolver,
    })

    expect(messages).toBeNull()
    expect(resolver).not.toHaveBeenCalled()
  })
})
