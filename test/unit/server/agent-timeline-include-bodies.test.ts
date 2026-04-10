// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AgentTimelinePageQuerySchema } from '../../../shared/read-models.js'
import { createAgentTimelineService } from '../../../server/agent-timeline/service.js'

const mockMessages = [
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

function makeResolvedHistory(options: {
  liveSessionId?: string
  timelineSessionId?: string
  revision?: number
  messages: typeof mockMessages
}) {
  return {
    kind: 'resolved' as const,
    queryId: options.liveSessionId ?? options.timelineSessionId ?? 'sess-1',
    liveSessionId: options.liveSessionId,
    timelineSessionId: options.timelineSessionId,
    readiness: options.liveSessionId && options.timelineSessionId
      ? 'merged' as const
      : options.timelineSessionId
        ? 'durable_only' as const
        : 'live_only' as const,
    revision: options.revision ?? Date.parse('2026-03-10T10:02:00.000Z'),
    latestTurnId: options.messages.length > 0 ? `turn-${options.messages.length - 1}` : null,
    turns: options.messages.map((message, index) => ({
      turnId: `turn-${index}`,
      messageId: `message-${index}`,
      ordinal: index,
      source: options.timelineSessionId ? 'durable' as const : 'live' as const,
      message: {
        ...message,
        messageId: `message-${index}`,
      },
    })),
  }
}

describe('AgentTimelinePageQuerySchema includeBodies parsing', () => {
  it('accepts boolean true from client code', () => {
    const result = AgentTimelinePageQuerySchema.parse({ includeBodies: true, priority: 'visible', revision: 7 })
    expect(result.includeBodies).toBe(true)
  })

  it('accepts boolean false from client code', () => {
    const result = AgentTimelinePageQuerySchema.parse({ includeBodies: false, priority: 'visible', revision: 7 })
    expect(result.includeBodies).toBe(false)
  })

  it('accepts string "true" from query parameters', () => {
    const result = AgentTimelinePageQuerySchema.parse({ includeBodies: 'true', priority: 'visible', revision: 7 })
    expect(result.includeBodies).toBe(true)
  })

  it('accepts string "false" from query parameters and parses to false', () => {
    const result = AgentTimelinePageQuerySchema.parse({ includeBodies: 'false', priority: 'visible', revision: 7 })
    expect(result.includeBodies).toBe(false)
  })

  it('treats omitted includeBodies as undefined', () => {
    const result = AgentTimelinePageQuerySchema.parse({ priority: 'visible', revision: 7 })
    expect(result.includeBodies).toBeUndefined()
  })

  it('rejects invalid string values for includeBodies', () => {
    expect(() => AgentTimelinePageQuerySchema.parse({ includeBodies: 'abc', priority: 'visible', revision: 7 })).toThrow()
    expect(() => AgentTimelinePageQuerySchema.parse({ includeBodies: '0', priority: 'visible', revision: 7 })).toThrow()
    expect(() => AgentTimelinePageQuerySchema.parse({ includeBodies: '1', priority: 'visible', revision: 7 })).toThrow()
    expect(() => AgentTimelinePageQuerySchema.parse({ includeBodies: 'yes', priority: 'visible', revision: 7 })).toThrow()
  })
})

describe('agent timeline includeBodies', () => {
  it('includeBodies=false (default): no bodies field in response', async () => {
    const service = createAgentTimelineService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
          liveSessionId: 'sess-1',
          messages: mockMessages,
        })),
      },
    })

    const page = await service.getTimelinePage({
      sessionId: 'sess-1',
      priority: 'visible',
      revision: Date.parse('2026-03-10T10:02:00.000Z'),
    })

    expect(page.items).toHaveLength(3)
    expect(page).not.toHaveProperty('bodies')
  })

  it('includeBodies=true: bodies map includes all page items', async () => {
    const service = createAgentTimelineService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
          liveSessionId: 'sdk-sess-1',
          timelineSessionId: '00000000-0000-4000-8000-000000000010',
          messages: mockMessages,
        })),
      },
    })

    const page = await service.getTimelinePage({
      sessionId: 'sdk-sess-1',
      priority: 'visible',
      includeBodies: true,
      revision: Date.parse('2026-03-10T10:02:00.000Z'),
    })

    expect(page.items).toHaveLength(3)
    expect(page.bodies).toBeDefined()
    expect(Object.keys(page.bodies!)).toHaveLength(3)
    expect(page.sessionId).toBe('00000000-0000-4000-8000-000000000010')
    for (const item of page.items) {
      const body = page.bodies![item.turnId]
      expect(body).toBeDefined()
      expect(body.sessionId).toBe('00000000-0000-4000-8000-000000000010')
      expect(body.turnId).toBe(item.turnId)
      expect(body.message.content).toBeDefined()
      expect(body.message.content.length).toBeGreaterThan(0)
    }
  })

  it('bodies map keys match item turnIds', async () => {
    const service = createAgentTimelineService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
          liveSessionId: 'sess-1',
          messages: mockMessages,
        })),
      },
    })

    const page = await service.getTimelinePage({
      sessionId: 'sess-1',
      priority: 'visible',
      includeBodies: true,
      revision: Date.parse('2026-03-10T10:02:00.000Z'),
    })

    const itemTurnIds = new Set(page.items.map((i) => i.turnId))
    const bodyKeys = new Set(Object.keys(page.bodies!))
    expect(bodyKeys).toEqual(itemTurnIds)
  })

  it('paginated request with includeBodies: only includes bodies for current page', async () => {
    const fiveMessages = Array.from({ length: 5 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      timestamp: `2026-03-10T10:0${i}:00.000Z`,
      content: [{ type: 'text' as const, text: `Message ${i}` }],
    }))

    const service = createAgentTimelineService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
          liveSessionId: 'sess-1',
          revision: Date.parse('2026-03-10T10:04:00.000Z'),
          messages: fiveMessages,
        })),
      },
    })

    const page1 = await service.getTimelinePage({
      sessionId: 'sess-1',
      priority: 'visible',
      limit: 2,
      includeBodies: true,
      revision: Date.parse('2026-03-10T10:04:00.000Z'),
    })

    expect(page1.items).toHaveLength(2)
    expect(Object.keys(page1.bodies!)).toHaveLength(2)
    for (const item of page1.items) {
      expect(page1.bodies![item.turnId]).toBeDefined()
    }

    const page2 = await service.getTimelinePage({
      sessionId: 'sess-1',
      priority: 'visible',
      cursor: page1.nextCursor!,
      limit: 2,
      includeBodies: true,
      revision: page1.revision,
    })

    expect(page2.items).toHaveLength(2)
    expect(Object.keys(page2.bodies!)).toHaveLength(2)
    for (const item of page2.items) {
      expect(page2.bodies![item.turnId]).toBeDefined()
    }
  })

  it('getTurnBody still works independently (backward compatible)', async () => {
    const service = createAgentTimelineService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
          liveSessionId: 'sdk-sess-1',
          timelineSessionId: '00000000-0000-4000-8000-000000000011',
          messages: mockMessages,
        })),
      },
    })

    const page = await service.getTimelinePage({
      sessionId: 'sdk-sess-1',
      priority: 'visible',
      revision: Date.parse('2026-03-10T10:02:00.000Z'),
    })

    const turn = await service.getTurnBody({
      sessionId: 'sdk-sess-1',
      turnId: page.items[0].turnId,
      revision: page.revision,
    })

    expect(turn).not.toBeNull()
    expect(turn!.sessionId).toBe('00000000-0000-4000-8000-000000000011')
    expect(turn!.turnId).toBe(page.items[0].turnId)
    expect(turn!.message.content).toHaveLength(1)
  })
})
