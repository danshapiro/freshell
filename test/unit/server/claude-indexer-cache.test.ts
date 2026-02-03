import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { ClaudeSessionIndexer } from '../../../server/claude-indexer'
import { configStore } from '../../../server/config-store'

describe('ClaudeSessionIndexer refresh caching', () => {
  let tempDir: string
  let claudeHome: string
  let projectDir: string
  let sessionFile: string
  const originalClaudeHome = process.env.CLAUDE_HOME

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-indexer-cache-'))
    claudeHome = path.join(tempDir, '.claude')
    projectDir = path.join(claudeHome, 'projects', 'project-a')
    sessionFile = path.join(projectDir, 'session-1.jsonl')
    await fs.mkdir(projectDir, { recursive: true })

    process.env.CLAUDE_HOME = claudeHome

    vi.spyOn(configStore, 'snapshot').mockResolvedValue({
      version: 1,
      settings: {},
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    } as any)
    vi.spyOn(configStore, 'getProjectColors').mockResolvedValue({})
  })

  afterEach(async () => {
    if (originalClaudeHome === undefined) {
      delete process.env.CLAUDE_HOME
    } else {
      process.env.CLAUDE_HOME = originalClaudeHome
    }
    vi.restoreAllMocks()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('reuses cached metadata when files are unchanged', async () => {
    await fs.writeFile(sessionFile, '{"cwd":"/tmp","role":"user","content":"First title"}\n')

    const indexer = new ClaudeSessionIndexer()
    await indexer.refresh()

    const resolved = path.resolve(sessionFile)
    const cacheKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    const cache = (indexer as any).fileCache as Map<string, { meta: { title?: string } }>
    const cached = cache.get(cacheKey)
    expect(cached).toBeTruthy()
    if (cached) {
      cached.meta.title = 'Injected title'
    }

    await indexer.refresh()
    const session = indexer.getProjects()[0]?.sessions[0]
    expect(session?.title).toBe('Injected title')
  })
})
