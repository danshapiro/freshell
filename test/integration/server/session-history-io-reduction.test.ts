// @vitest-environment node
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

describe('session history I/O reduction', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-io-reduction-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('with resolver: zero readdir calls for known session', async () => {
    // Create 10 project directories with files
    const projectsDir = path.join(tmpDir, 'projects')
    await fsp.mkdir(projectsDir, { recursive: true })
    const sessionId = 'target-session'
    const targetPath = path.join(tmpDir, 'target.jsonl')
    await fsp.writeFile(targetPath, createJsonlContent([
      { role: 'user', text: 'Resolved directly' },
    ]))

    for (let i = 0; i < 10; i++) {
      const dir = path.join(projectsDir, `project-${i}`)
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(
        path.join(dir, `other-session-${i}.jsonl`),
        createJsonlContent([{ role: 'user', text: `project ${i}` }]),
      )
    }

    const originalReaddir = fsp.readdir.bind(fsp)
    let readdirCount = 0
    vi.spyOn(fsp, 'readdir').mockImplementation((...args: any[]) => {
      readdirCount++
      return (originalReaddir as any)(...args)
    })

    const messages = await loadSessionHistory(sessionId, tmpDir, {
      resolveFilePath: () => targetPath,
    })

    expect(messages).toHaveLength(1)
    expect(messages![0].content[0].text).toBe('Resolved directly')
    expect(readdirCount).toBe(0)
  })

  it('without resolver: N readdir calls (baseline measurement)', async () => {
    const projectsDir = path.join(tmpDir, 'projects')
    await fsp.mkdir(projectsDir, { recursive: true })
    const sessionId = 'baseline-session'

    // Create 10 project directories, session file in the last one
    for (let i = 0; i < 10; i++) {
      const dir = path.join(projectsDir, `project-${String(i).padStart(2, '0')}`)
      await fsp.mkdir(dir, { recursive: true })
    }
    const lastDir = path.join(projectsDir, `project-09`)
    await fsp.writeFile(
      path.join(lastDir, `${sessionId}.jsonl`),
      createJsonlContent([{ role: 'user', text: 'Found via scan' }]),
    )

    const originalReaddir = fsp.readdir.bind(fsp)
    let readdirCount = 0
    vi.spyOn(fsp, 'readdir').mockImplementation((...args: any[]) => {
      readdirCount++
      return (originalReaddir as any)(...args)
    })

    const messages = await loadSessionHistory(sessionId, tmpDir)

    expect(messages).toHaveLength(1)
    // At least 1 readdir for the projects dir itself, plus readdirs for subdirectories
    expect(readdirCount).toBeGreaterThanOrEqual(2)
  })

  it('resolver reduces wall-clock time by 5x+ for 50-directory layout', async () => {
    const projectsDir = path.join(tmpDir, 'projects')
    await fsp.mkdir(projectsDir, { recursive: true })
    const sessionId = 'perf-test-session'

    // Create 50 project directories with subdirectories, session in the last one
    for (let i = 0; i < 50; i++) {
      const dir = path.join(projectsDir, `project-${String(i).padStart(3, '0')}`)
      const sessionsDir = path.join(dir, 'sessions')
      await fsp.mkdir(sessionsDir, { recursive: true })
      // Add a decoy file in each
      await fsp.writeFile(
        path.join(sessionsDir, 'decoy.jsonl'),
        createJsonlContent([{ role: 'user', text: `decoy ${i}` }]),
      )
    }
    const targetDir = path.join(projectsDir, 'project-049', 'sessions')
    const targetPath = path.join(targetDir, `${sessionId}.jsonl`)
    await fsp.writeFile(
      targetPath,
      createJsonlContent([{ role: 'user', text: 'Performance target' }]),
    )

    // Warm the OS file cache
    await loadSessionHistory(sessionId, tmpDir)

    // Time scan approach
    const scanStart = performance.now()
    for (let i = 0; i < 5; i++) {
      await loadSessionHistory(sessionId, tmpDir)
    }
    const scanTime = performance.now() - scanStart

    // Time resolver approach
    const resolverStart = performance.now()
    for (let i = 0; i < 5; i++) {
      await loadSessionHistory(sessionId, tmpDir, {
        resolveFilePath: () => targetPath,
      })
    }
    const resolverTime = performance.now() - resolverStart

    expect(scanTime / resolverTime).toBeGreaterThanOrEqual(5)
  })

  it('stat budget: resolving 100 sessions costs < 50ms total', async () => {
    const sessionDir = path.join(tmpDir, 'sessions')
    await fsp.mkdir(sessionDir, { recursive: true })

    // Create 100 session files
    const sessionPaths: Record<string, string> = {}
    for (let i = 0; i < 100; i++) {
      const id = `session-${String(i).padStart(3, '0')}`
      const filePath = path.join(sessionDir, `${id}.jsonl`)
      await fsp.writeFile(filePath, createJsonlContent([
        { role: 'user', text: `Message ${i}` },
      ]))
      sessionPaths[id] = filePath
    }

    // Also create a projects dir so the scan fallback doesn't fail
    await fsp.mkdir(path.join(tmpDir, 'projects'), { recursive: true })

    const start = performance.now()
    for (let i = 0; i < 100; i++) {
      const id = `session-${String(i).padStart(3, '0')}`
      const messages = await loadSessionHistory(id, tmpDir, {
        resolveFilePath: (sid) => sessionPaths[sid],
      })
      expect(messages).toHaveLength(1)
    }
    const totalMs = performance.now() - start

    expect(totalMs).toBeLessThan(50)
  })
})
