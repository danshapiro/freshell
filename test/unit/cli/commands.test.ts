import { describe, it, expect, vi } from 'vitest'
import { runCommand } from '../../../server/cli/commands/sendKeys'
import {
  runListSessionsCommand,
  runSearchSessionsCommand,
} from '../../../server/cli/index.js'
import { createCliCommandHarness } from '../../helpers/visible-first/cli-command-harness.js'

describe('CLI commands', () => {
  it('calls api send-keys endpoint', async () => {
    const client = { post: vi.fn().mockResolvedValue({ status: 'ok' }) }
    await runCommand({ target: 'pane_1', keys: ['Enter'] }, client as any)
    expect(client.post).toHaveBeenCalled()
  })

  it('list-sessions calls the session-directory contract and keeps grouped output', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            provider: 'claude',
            sessionId: 'session-1',
            projectPath: '/repo/alpha',
            updatedAt: 100,
            title: 'Alpha',
          },
        ],
        nextCursor: null,
        revision: 7,
      }),
    }
    const harness = createCliCommandHarness()

    const result = await harness.run(async ({ stdout, stderr, setExitCode }) => {
      await runListSessionsCommand(client as any, {
        writeJson: (value) => stdout(`${JSON.stringify(value)}\n`),
        writeError: (value) => stderr(String(value)),
        setExitCode,
      })
    })

    expect(client.get).toHaveBeenCalledWith('/api/session-directory?priority=visible')
    expect(result.exitCode).toBe(0)
    expect(result.json).toEqual([
      {
        projectPath: '/repo/alpha',
        sessions: [
          expect.objectContaining({
            provider: 'claude',
            sessionId: 'session-1',
            title: 'Alpha',
          }),
        ],
      },
    ])
  })

  it('search-sessions calls the session-directory contract family and keeps search-style output', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            provider: 'claude',
            sessionId: 'session-1',
            projectPath: '/repo/alpha',
            updatedAt: 100,
            title: 'Alpha deploy',
            snippet: 'Alpha deploy',
            matchedIn: 'title',
          },
        ],
        nextCursor: null,
        revision: 9,
      }),
    }
    const harness = createCliCommandHarness()

    const result = await harness.run(async ({ stdout, stderr, setExitCode }) => {
      await runSearchSessionsCommand(client as any, 'alpha', {
        writeJson: (value) => stdout(`${JSON.stringify(value)}\n`),
        writeError: (value) => stderr(String(value)),
        setExitCode,
      })
    })

    expect(client.get).toHaveBeenCalledWith('/api/session-directory?priority=visible&query=alpha')
    expect(result.exitCode).toBe(0)
    expect(result.json).toEqual({
      results: [
        expect.objectContaining({
          sessionId: 'session-1',
          matchedIn: 'title',
          snippet: 'Alpha deploy',
        }),
      ],
      tier: 'title',
      query: 'alpha',
      totalScanned: 1,
    })
  })
})
