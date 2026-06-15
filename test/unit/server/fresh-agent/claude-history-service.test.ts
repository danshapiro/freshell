// @vitest-environment node
import fsp from 'fs/promises'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeFreshAgentHistoryInvalidCursorError,
  createClaudeFreshAgentHistoryService,
} from '../../../../server/fresh-agent/history/claude/history-service.js'

const baseMessages = [
  {
    role: 'user' as const,
    timestamp: '2026-03-10T10:00:00.000Z',
    content: [{ type: 'text' as const, text: 'oldest user turn' }],
  },
  {
    role: 'assistant' as const,
    timestamp: '2026-03-10T10:01:00.000Z',
    content: [{ type: 'text' as const, text: 'middle assistant turn' }],
  },
  {
    role: 'user' as const,
    timestamp: '2026-03-10T10:02:00.000Z',
    content: [{ type: 'text' as const, text: 'latest user turn' }],
  },
]

function toResolvedHistory(sessionId: string, timelineSessionId: string | undefined, messages = baseMessages) {
  return {
    kind: 'resolved' as const,
    queryId: sessionId,
    liveSessionId: sessionId,
    timelineSessionId,
    readiness: 'merged' as const,
    revision: Date.parse('2026-03-10T10:02:00.000Z'),
    latestTurnId: `turn:${messages[messages.length - 1]?.messageId ?? `${sessionId}-${messages.length - 1}`}`,
    turns: messages.map((message, index) => {
      const messageId = message.messageId ?? `${sessionId}-${index}`
      return {
        turnId: `turn:${messageId}`,
        messageId,
        ordinal: index,
        source: index < messages.length - 1 ? 'durable' as const : 'live' as const,
        message: {
          ...message,
          messageId,
        },
      }
    }),
  }
}

describe('Claude fresh-agent history service', () => {
  it('returns recent-first timeline pages with a cursor', async () => {
    const resolve = vi.fn().mockResolvedValue({
      ...toResolvedHistory('agent-session-1', undefined),
    })
    const service = createClaudeFreshAgentHistoryService({
      agentHistorySource: { resolve },
    })

    const firstPage = await service.getThreadTurnPage({
      sessionId: 'agent-session-1',
      priority: 'visible',
      limit: 2,
      revision: Date.parse('2026-03-10T10:02:00.000Z'),
    })

    expect(firstPage.items.map((item) => item.summary)).toEqual([
      'latest user turn',
      'middle assistant turn',
    ])
    expect(firstPage.nextCursor).toBeTruthy()
    expect(resolve).toHaveBeenCalledWith('agent-session-1')

    const secondPage = await service.getThreadTurnPage({
      sessionId: 'agent-session-1',
      priority: 'visible',
      cursor: firstPage.nextCursor ?? undefined,
      limit: 2,
      revision: firstPage.revision,
    })

    expect(secondPage.items.map((item) => item.summary)).toEqual(['oldest user turn'])
    expect(secondPage.nextCursor).toBeNull()
  })

  it('hydrates full turn bodies on demand', async () => {
    const service = createClaudeFreshAgentHistoryService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue({
          ...toResolvedHistory('agent-session-2', undefined, [
            {
              role: 'assistant',
              timestamp: '2026-03-10T10:02:00.000Z',
              content: [
                { type: 'text', text: 'expanded turn body' },
                { type: 'text', text: 'with extra content' },
              ],
              messageId: 'agent-session-2-0',
            },
          ]),
        }),
      },
    })

    const page = await service.getThreadTurnPage({
      sessionId: 'agent-session-2',
      priority: 'visible',
      limit: 1,
      revision: Date.parse('2026-03-10T10:02:00.000Z'),
    })

    const turn = await service.getTurnBody({
      sessionId: 'agent-session-2',
      turnId: page.items[0]!.turnId,
      revision: page.revision,
    })

    expect(turn).toMatchObject({
      turnId: page.items[0]!.turnId,
      sessionId: 'agent-session-2',
      message: {
        role: 'assistant',
      },
    })
    expect(turn.message.content).toHaveLength(2)
  })

  it('returns canonical timeline session ids for pages and turn bodies', async () => {
    const service = createClaudeFreshAgentHistoryService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue({
          ...toResolvedHistory('sdk-1', '00000000-0000-4000-8000-000000000001', [
            {
              role: 'assistant',
              timestamp: '2026-03-10T10:02:00.000Z',
              content: [{ type: 'text', text: 'canonical turn body' }],
              messageId: 'canonical-body-1',
            },
          ]),
        }),
      },
    })

    const page = await service.getThreadTurnPage({
      sessionId: 'sdk-1',
      priority: 'visible',
      limit: 1,
      revision: Date.parse('2026-03-10T10:02:00.000Z'),
    })

    expect(page.sessionId).toBe('00000000-0000-4000-8000-000000000001')
    expect(page.items[0]?.sessionId).toBe('00000000-0000-4000-8000-000000000001')

    const turn = await service.getTurnBody({
      sessionId: 'sdk-1',
      turnId: page.items[0]!.turnId,
      revision: page.revision,
    })

    expect(turn?.sessionId).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('rejects invalid cursors deterministically', async () => {
    const service = createClaudeFreshAgentHistoryService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue({
          kind: 'resolved',
          queryId: 'agent-session-3',
          liveSessionId: 'agent-session-3',
          readiness: 'live_only',
          latestTurnId: null,
          turns: [],
          revision: 0,
        }),
      },
    })

    const page = service.getThreadTurnPage({
      sessionId: 'agent-session-3',
      priority: 'background',
      cursor: 'not-a-valid-cursor',
      revision: 0,
    })

    await expect(page).rejects.toBeInstanceOf(ClaudeFreshAgentHistoryInvalidCursorError)
    await expect(page).rejects.toThrow(/cursor/i)
  })

  it('throws typed restore errors instead of fabricating empty timelines for missing sessions', async () => {
    const service = createClaudeFreshAgentHistoryService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue({
          kind: 'missing',
          code: 'RESTORE_NOT_FOUND',
        }),
      },
    })

    await expect(service.getThreadTurnPage({
      sessionId: 'missing-agent',
      priority: 'visible',
      revision: 0,
    })).rejects.toMatchObject({
      code: 'RESTORE_NOT_FOUND',
    })
  })

  it('throws typed fatal restore errors instead of fabricating empty timelines', async () => {
    const service = createClaudeFreshAgentHistoryService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue({
          kind: 'fatal',
          code: 'RESTORE_UNAVAILABLE',
          message: 'History store is unavailable',
        }),
      },
    })

    await expect(service.getThreadTurnPage({
      sessionId: 'unavailable-agent',
      priority: 'visible',
      revision: 0,
    })).rejects.toMatchObject({
      code: 'RESTORE_UNAVAILABLE',
      message: 'History store is unavailable',
    })
  })

  it('rejects timeline-page reads that omit the accepted restore revision', async () => {
    const service = createClaudeFreshAgentHistoryService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue({
          ...toResolvedHistory('sdk-1', '00000000-0000-4000-8000-000000000001'),
          revision: 13,
        }),
      },
    })

    await expect(service.getThreadTurnPage({
      sessionId: 'sdk-1',
      priority: 'visible',
    } as any)).rejects.toThrow('Restore revision is required')
  })

  it('rejects stale timeline-page revisions with the current ledger revision', async () => {
    const service = createClaudeFreshAgentHistoryService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue({
          ...toResolvedHistory('sdk-1', '00000000-0000-4000-8000-000000000001'),
          revision: 13,
        }),
      },
    })

    await expect(service.getThreadTurnPage({
      sessionId: 'sdk-1',
      priority: 'visible',
      revision: 12,
    })).rejects.toMatchObject({
      code: 'RESTORE_STALE_REVISION',
      requestedRevision: 12,
      actualRevision: 13,
    })
  })

  it('rejects stale turn-body revisions with the current ledger revision', async () => {
    const service = createClaudeFreshAgentHistoryService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue({
          ...toResolvedHistory('sdk-1', '00000000-0000-4000-8000-000000000001'),
          revision: 13,
        }),
      },
    })

    await expect(service.getTurnBody({
      sessionId: 'sdk-1',
      turnId: 'turn:sdk-1-2',
      revision: 12,
    })).rejects.toMatchObject({
      code: 'RESTORE_STALE_REVISION',
      requestedRevision: 12,
      actualRevision: 13,
    })
  })

  it('rejects turn-body reads that omit the accepted restore revision', async () => {
    const service = createClaudeFreshAgentHistoryService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue({
          ...toResolvedHistory('sdk-1', '00000000-0000-4000-8000-000000000001'),
          revision: 13,
        }),
      },
    })

    await expect(service.getTurnBody({
      sessionId: 'sdk-1',
      turnId: 'turn:sdk-1-2',
    } as any)).rejects.toThrow('Restore revision is required')
  })
})

describe('Claude fresh-agent history package boundaries', () => {
  it('does not import fresh-agent route, runtime, or Claude adapter layers', async () => {
    const historyDir = path.join(process.cwd(), 'server/fresh-agent/history/claude')
    const files = (await fsp.readdir(historyDir)).filter((file) => file.endsWith('.ts'))
    const forbiddenImports = [
      /from ['"].*fresh-agent\/router\.js['"]/,
      /from ['"].*fresh-agent\/runtime-manager\.js['"]/,
      /from ['"].*fresh-agent\/adapters\/claude\b/,
      /from ['"]\.\.\/\.\.\/router\.js['"]/,
      /from ['"]\.\.\/\.\.\/runtime-manager\.js['"]/,
      /from ['"]\.\.\/\.\.\/adapters\/claude\b/,
    ]

    const violations: string[] = []
    for (const file of files) {
      const content = await fsp.readFile(path.join(historyDir, file), 'utf8')
      for (const pattern of forbiddenImports) {
        if (pattern.test(content)) {
          violations.push(file)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
