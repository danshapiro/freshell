import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { ClaudeSessionIndexer } from '../../../server/claude-indexer'
import { configStore } from '../../../server/config-store'

describe('ClaudeSessionIndexer refresh integration', () => {
  let tempDir: string
  let claudeHome: string
  let projectDir: string
  let sessionFile: string
  const originalClaudeHome = process.env.CLAUDE_HOME

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-refresh-'))
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

  it('reads metadata across multiple lines during refresh', async () => {
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

    const indexer = new ClaudeSessionIndexer()
    await indexer.refresh()

    const session = indexer.getProjects()[0].sessions[0]
    expect(session.title).toContain('First title')
    expect(session.summary).toBe('Second summary')
    expect(session.messageCount).toBe(2)
    expect(session.createdAt).toBe(Date.parse('2025-01-02T00:00:01.000Z'))
  })
})
