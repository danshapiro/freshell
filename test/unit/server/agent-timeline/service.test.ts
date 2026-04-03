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

describe('agent timeline service', () => {
  it('returns recent-first timeline pages with a cursor', async () => {
    const resolve = vi.fn().mockResolvedValue({
      liveSessionId: 'agent-session-1',
      messages: baseMessages,
      revision: Date.parse('2026-03-10T10:02:00.000Z'),
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
          liveSessionId: 'agent-session-2',
          messages: [
            {
              role: 'assistant',
              timestamp: '2026-03-10T10:02:00.000Z',
              content: [
                { type: 'text', text: 'expanded turn body' },
                { type: 'text', text: 'with extra content' },
              ],
            },
          ],
          revision: Date.parse('2026-03-10T10:02:00.000Z'),
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
          liveSessionId: 'sdk-1',
          timelineSessionId: '00000000-0000-4000-8000-000000000001',
          messages: [
            {
              role: 'assistant',
              timestamp: '2026-03-10T10:02:00.000Z',
              content: [{ type: 'text', text: 'canonical turn body' }],
            },
          ],
          revision: Date.parse('2026-03-10T10:02:00.000Z'),
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
          liveSessionId: 'agent-session-3',
          messages: [],
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
})
