// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
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

describe('AgentTimelinePageQuerySchema includeBodies parsing', () => {
  it('accepts boolean true from client code', () => {
    const result = AgentTimelinePageQuerySchema.parse({ includeBodies: true, priority: 'visible' })
    expect(result.includeBodies).toBe(true)
  })

  it('accepts boolean false from client code', () => {
    const result = AgentTimelinePageQuerySchema.parse({ includeBodies: false, priority: 'visible' })
    expect(result.includeBodies).toBe(false)
  })

  it('accepts string "true" from query parameters', () => {
    const result = AgentTimelinePageQuerySchema.parse({ includeBodies: 'true', priority: 'visible' })
    expect(result.includeBodies).toBe(true)
  })

  it('accepts string "false" from query parameters and parses to false', () => {
    const result = AgentTimelinePageQuerySchema.parse({ includeBodies: 'false', priority: 'visible' })
    expect(result.includeBodies).toBe(false)
  })

  it('treats omitted includeBodies as undefined', () => {
    const result = AgentTimelinePageQuerySchema.parse({ priority: 'visible' })
    expect(result.includeBodies).toBeUndefined()
  })

  it('rejects invalid string values for includeBodies', () => {
    expect(() => AgentTimelinePageQuerySchema.parse({ includeBodies: 'abc', priority: 'visible' })).toThrow()
    expect(() => AgentTimelinePageQuerySchema.parse({ includeBodies: '0', priority: 'visible' })).toThrow()
    expect(() => AgentTimelinePageQuerySchema.parse({ includeBodies: '1', priority: 'visible' })).toThrow()
    expect(() => AgentTimelinePageQuerySchema.parse({ includeBodies: 'yes', priority: 'visible' })).toThrow()
  })
})

describe('agent timeline includeBodies', () => {
  it('includeBodies=false (default): no bodies field in response', async () => {
    const service = createAgentTimelineService({
      loadSessionHistory: vi.fn().mockResolvedValue(mockMessages),
    })

    const page = await service.getTimelinePage({
      sessionId: 'sess-1',
      priority: 'visible',
    })

    expect(page.items).toHaveLength(3)
    expect(page).not.toHaveProperty('bodies')
  })

  it('includeBodies=true: bodies map includes all page items', async () => {
    const service = createAgentTimelineService({
      loadSessionHistory: vi.fn().mockResolvedValue(mockMessages),
    })

    const page = await service.getTimelinePage({
      sessionId: 'sess-1',
      priority: 'visible',
      includeBodies: true,
    })

    expect(page.items).toHaveLength(3)
    expect(page.bodies).toBeDefined()
    expect(Object.keys(page.bodies!)).toHaveLength(3)
    // Each body should have full message content
    for (const item of page.items) {
      const body = page.bodies![item.turnId]
      expect(body).toBeDefined()
      expect(body.sessionId).toBe('sess-1')
      expect(body.turnId).toBe(item.turnId)
      expect(body.message.content).toBeDefined()
      expect(body.message.content.length).toBeGreaterThan(0)
    }
  })

  it('bodies map keys match item turnIds', async () => {
    const service = createAgentTimelineService({
      loadSessionHistory: vi.fn().mockResolvedValue(mockMessages),
    })

    const page = await service.getTimelinePage({
      sessionId: 'sess-1',
      priority: 'visible',
      includeBodies: true,
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
      loadSessionHistory: vi.fn().mockResolvedValue(fiveMessages),
    })

    const page1 = await service.getTimelinePage({
      sessionId: 'sess-1',
      priority: 'visible',
      limit: 2,
      includeBodies: true,
    })

    expect(page1.items).toHaveLength(2)
    expect(Object.keys(page1.bodies!)).toHaveLength(2)
    // Bodies should only contain the 2 items on this page
    for (const item of page1.items) {
      expect(page1.bodies![item.turnId]).toBeDefined()
    }

    // Request page 2
    const page2 = await service.getTimelinePage({
      sessionId: 'sess-1',
      priority: 'visible',
      cursor: page1.nextCursor!,
      limit: 2,
      includeBodies: true,
    })

    expect(page2.items).toHaveLength(2)
    expect(Object.keys(page2.bodies!)).toHaveLength(2)
    // Bodies should only contain page 2's items
    for (const item of page2.items) {
      expect(page2.bodies![item.turnId]).toBeDefined()
    }
  })

  it('getTurnBody still works independently (backward compatible)', async () => {
    const service = createAgentTimelineService({
      loadSessionHistory: vi.fn().mockResolvedValue(mockMessages),
    })

    // Get the timeline page first to know the turnId
    const page = await service.getTimelinePage({
      sessionId: 'sess-1',
      priority: 'visible',
    })

    const turn = await service.getTurnBody({
      sessionId: 'sess-1',
      turnId: page.items[0].turnId,
    })

    expect(turn).not.toBeNull()
    expect(turn!.sessionId).toBe('sess-1')
    expect(turn!.turnId).toBe(page.items[0].turnId)
    expect(turn!.message.content).toHaveLength(1)
  })
})
