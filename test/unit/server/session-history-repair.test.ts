import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import {
  ClaudeHistoryRepairer,
  deriveClaudeHistoryEntryFromTranscript,
} from '../../../server/session-scanner/history-repair.js'

describe('deriveClaudeHistoryEntryFromTranscript', () => {
  it('derives a history row from the first user-facing text prompt', () => {
    const sessionId = 'test-session'
    const content = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        sessionId,
        timestamp: '2026-03-08T08:38:07.095Z',
      }),
      JSON.stringify({
        type: 'user',
        sessionId,
        cwd: '/tmp/project',
        timestamp: '2026-03-08T08:38:07.287Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '  Freshclaude tool strip  ' },
            { type: 'tool_result', content: 'ignored' },
            { type: 'text', text: '\nneeds polish' },
          ],
        },
      }),
    ].join('\n')

    expect(deriveClaudeHistoryEntryFromTranscript(sessionId, content)).toEqual({
      display: 'Freshclaude tool strip needs polish',
      pastedContents: {},
      project: '/tmp/project',
      sessionId,
      timestamp: Date.parse('2026-03-08T08:38:07.287Z'),
    })
  })

  it('skips transcripts without a usable user prompt and cwd', () => {
    const sessionId = 'test-session'
    const content = [
      JSON.stringify({
        type: 'user',
        sessionId,
        timestamp: '2026-03-08T08:38:07.287Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'ignored' }],
        },
      }),
    ].join('\n')

    expect(deriveClaudeHistoryEntryFromTranscript(sessionId, content)).toBeNull()
  })
})

describe('ClaudeHistoryRepairer', () => {
  let tempDir: string
  let claudeHome: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-repair-test-'))
    claudeHome = path.join(tempDir, '.claude')
    await fs.mkdir(path.join(claudeHome, 'projects', 'test-project'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('backfills a missing history row from a top-level transcript', async () => {
    const sessionId = 'session-1'
    const sessionFile = path.join(claudeHome, 'projects', 'test-project', `${sessionId}.jsonl`)
    await fs.writeFile(sessionFile, [
      JSON.stringify({
        type: 'user',
        sessionId,
        cwd: '/tmp/project',
        timestamp: '2026-03-08T08:38:07.287Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Repair this restore issue' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId,
        message: 'On it.',
      }),
    ].join('\n'))

    const repairer = new ClaudeHistoryRepairer({ claudeHome })
    const result = await repairer.ensureHistoryEntryForFile(sessionFile)

    expect(result.status).toBe('created')
    const historyLines = (await fs.readFile(path.join(claudeHome, 'history.jsonl'), 'utf8'))
      .trim()
      .split('\n')
    expect(historyLines).toHaveLength(1)
    expect(JSON.parse(historyLines[0])).toEqual({
      display: 'Repair this restore issue',
      pastedContents: {},
      project: '/tmp/project',
      sessionId,
      timestamp: Date.parse('2026-03-08T08:38:07.287Z'),
    })
  })

  it('does not duplicate an existing history row for the same session', async () => {
    const sessionId = 'session-2'
    const sessionFile = path.join(claudeHome, 'projects', 'test-project', `${sessionId}.jsonl`)
    const historyPath = path.join(claudeHome, 'history.jsonl')
    await fs.writeFile(sessionFile, JSON.stringify({
      type: 'user',
      sessionId,
      cwd: '/tmp/project',
      timestamp: '2026-03-08T08:38:07.287Z',
      message: 'Repair this restore issue',
    }))
    await fs.writeFile(historyPath, `${JSON.stringify({
      display: 'Existing row',
      pastedContents: {},
      project: '/tmp/project',
      sessionId,
      timestamp: Date.parse('2026-03-08T08:38:07.287Z'),
    })}\n`)

    const repairer = new ClaudeHistoryRepairer({ claudeHome })
    const result = await repairer.ensureHistoryEntryForFile(sessionFile)

    expect(result.status).toBe('already_present')
    const historyLines = (await fs.readFile(historyPath, 'utf8')).trim().split('\n')
    expect(historyLines).toHaveLength(1)
  })
})
