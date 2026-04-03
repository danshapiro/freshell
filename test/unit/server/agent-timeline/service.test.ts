// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createAgentTimelineService } from '../../../../server/agent-timeline/service.js'

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

describe('agent timeline service', () => {
  it('returns recent-first timeline pages with a cursor', async () => {
    const resolve = vi.fn().mockResolvedValue({
      ...toResolvedHistory('agent-session-1', undefined),
    })
    const service = createAgentTimelineService({
      agentHistorySource: { resolve },
    })

    const firstPage = await service.getTimelinePage({
      sessionId: 'agent-session-1',
      priority: 'visible',
      limit: 2,
    })

    expect(firstPage.items.map((item) => item.summary)).toEqual([
      'latest user turn',
      'middle assistant turn',
    ])
    expect(firstPage.nextCursor).toBeTruthy()
    expect(resolve).toHaveBeenCalledWith('agent-session-1')

    const secondPage = await service.getTimelinePage({
      sessionId: 'agent-session-1',
      priority: 'visible',
      cursor: firstPage.nextCursor ?? undefined,
      limit: 2,
    })

    expect(secondPage.items.map((item) => item.summary)).toEqual(['oldest user turn'])
    expect(secondPage.nextCursor).toBeNull()
  })

  it('hydrates full turn bodies on demand', async () => {
    const service = createAgentTimelineService({
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

    const page = await service.getTimelinePage({
      sessionId: 'agent-session-2',
      priority: 'visible',
      limit: 1,
    })

    const turn = await service.getTurnBody({
      sessionId: 'agent-session-2',
      turnId: page.items[0]!.turnId,
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
    const service = createAgentTimelineService({
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

    const page = await service.getTimelinePage({
      sessionId: 'sdk-1',
      priority: 'visible',
      limit: 1,
    })

    expect(page.sessionId).toBe('00000000-0000-4000-8000-000000000001')
    expect(page.items[0]?.sessionId).toBe('00000000-0000-4000-8000-000000000001')

    const turn = await service.getTurnBody({
      sessionId: 'sdk-1',
      turnId: page.items[0]!.turnId,
    })

    expect(turn?.sessionId).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('rejects invalid cursors deterministically', async () => {
    const service = createAgentTimelineService({
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

    await expect(service.getTimelinePage({
      sessionId: 'agent-session-3',
      priority: 'background',
      cursor: 'not-a-valid-cursor',
    })).rejects.toThrow(/cursor/i)
  })

  it('rejects stale timeline-page revisions with the current ledger revision', async () => {
    const service = createAgentTimelineService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue({
          ...toResolvedHistory('sdk-1', '00000000-0000-4000-8000-000000000001'),
          revision: 13,
        }),
      },
    })

    await expect(service.getTimelinePage({
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
    const service = createAgentTimelineService({
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
})
