// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createAgentTimelineService } from '../../../../server/agent-timeline/service.js'

describe('agent timeline service', () => {
  it('returns recent-first timeline pages with a cursor', async () => {
    const service = createAgentTimelineService({
      loadSessionHistory: vi.fn().mockResolvedValue([
        {
          role: 'user',
          timestamp: '2026-03-10T10:00:00.000Z',
          content: [{ type: 'text', text: 'oldest user turn' }],
        },
        {
          role: 'assistant',
          timestamp: '2026-03-10T10:01:00.000Z',
          content: [{ type: 'text', text: 'middle assistant turn' }],
        },
        {
          role: 'user',
          timestamp: '2026-03-10T10:02:00.000Z',
          content: [{ type: 'text', text: 'latest user turn' }],
        },
      ]),
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
      loadSessionHistory: vi.fn().mockResolvedValue([
        {
          role: 'assistant',
          timestamp: '2026-03-10T10:02:00.000Z',
          content: [
            { type: 'text', text: 'expanded turn body' },
            { type: 'text', text: 'with extra content' },
          ],
        },
      ]),
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

  it('rejects invalid cursors deterministically', async () => {
    const service = createAgentTimelineService({
      loadSessionHistory: vi.fn().mockResolvedValue([]),
    })

    await expect(service.getTimelinePage({
      sessionId: 'agent-session-3',
      priority: 'background',
      cursor: 'not-a-valid-cursor',
    })).rejects.toThrow(/cursor/i)
  })
})
