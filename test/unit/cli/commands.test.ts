import { describe, it, expect, vi } from 'vitest'
import { runCommand } from '../../../tools/freshell-cli/commands/sendKeys'
import {
  runListSessionsCommand,
  runSearchSessionsCommand,
} from '../../../tools/freshell-cli/index.js'
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
            lastActivityAt: 100,
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
            lastActivityAt: 100,
            title: 'Alpha',
          }),
        ],
      },
    ])
  })

  it('follows every session-directory cursor for list and search output', async () => {
    const listClient = {
      get: vi.fn()
        .mockResolvedValueOnce({
          items: [{ provider: 'claude', sessionId: 'page-one', projectPath: '/repo', lastActivityAt: 2 }],
          nextCursor: 'cursor-page-two', revision: 11,
        })
        .mockResolvedValueOnce({
          items: [{ provider: 'claude', sessionId: 'page-two', projectPath: '/repo', lastActivityAt: 1 }],
          nextCursor: null, revision: 11,
        }),
    }
    const listHarness = createCliCommandHarness()
    const listResult = await listHarness.run(async ({ stdout, stderr, setExitCode }) => {
      await runListSessionsCommand(listClient as any, {
        writeJson: (value) => stdout(`${JSON.stringify(value)}\n`),
        writeError: (value) => stderr(String(value)),
        setExitCode,
      })
    })

    expect(listClient.get).toHaveBeenNthCalledWith(1, '/api/session-directory?priority=visible')
    expect(listClient.get).toHaveBeenNthCalledWith(2, '/api/session-directory?priority=visible&cursor=cursor-page-two')
    expect(listResult.json[0].sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual(['page-one', 'page-two'])

    const searchClient = {
      get: vi.fn()
        .mockResolvedValueOnce({
          items: [{ provider: 'claude', sessionId: 'search-one', projectPath: '/repo', lastActivityAt: 2, matchedIn: 'title' }],
          nextCursor: 'search-page-two', revision: 12,
        })
        .mockResolvedValueOnce({
          items: [{ provider: 'claude', sessionId: 'search-two', projectPath: '/repo', lastActivityAt: 1, matchedIn: 'summary' }],
          nextCursor: null, revision: 12,
        }),
    }
    const searchHarness = createCliCommandHarness()
    const searchResult = await searchHarness.run(async ({ stdout, stderr, setExitCode }) => {
      await runSearchSessionsCommand(searchClient as any, 'needle', {
        writeJson: (value) => stdout(`${JSON.stringify(value)}\n`),
        writeError: (value) => stderr(String(value)),
        setExitCode,
      })
    })

    expect(searchClient.get).toHaveBeenNthCalledWith(1, '/api/session-directory?priority=visible&query=needle')
    expect(searchClient.get).toHaveBeenNthCalledWith(2, '/api/session-directory?priority=visible&query=needle&cursor=search-page-two')
    expect(searchResult.json.results.map((session: { sessionId: string }) => session.sessionId)).toEqual(['search-one', 'search-two'])
    expect(searchResult.json.totalScanned).toBe(2)
  })

  it('search-sessions calls the session-directory contract family and keeps search-style output', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            provider: 'claude',
            sessionId: 'session-1',
            projectPath: '/repo/alpha',
            lastActivityAt: 100,
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
          lastActivityAt: 100,
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
