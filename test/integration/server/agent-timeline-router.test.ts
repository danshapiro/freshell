// @vitest-environment node
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentTimelineRouter } from '../../../server/agent-timeline/router.js'
import { createAgentTimelineService } from '../../../server/agent-timeline/service.js'
import {
  AgentTimelineTurnBodyQuerySchema,
  RestoreStaleRevisionResponseSchema,
} from '../../../shared/read-models.js'

const TEST_AUTH_TOKEN = 'test-auth-token'

function makeResolvedHistory(options: {
  queryId: string
  liveSessionId?: string
  timelineSessionId?: string
  revision: number
  messages: Array<{
    role: 'user' | 'assistant'
    timestamp: string
    content: Array<{ type: 'text'; text: string }>
  }>
}) {
  return {
    kind: 'resolved' as const,
    queryId: options.queryId,
    liveSessionId: options.liveSessionId,
    timelineSessionId: options.timelineSessionId,
    readiness: options.liveSessionId && options.timelineSessionId ? 'merged' as const : options.timelineSessionId ? 'durable_only' as const : 'live_only' as const,
    revision: options.revision,
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

describe('GET /api/agent-sessions/:sessionId/timeline', () => {
  let app: Express
  let getTimelinePage: ReturnType<typeof vi.fn>
  let getTurnBody: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getTimelinePage = vi.fn().mockResolvedValue({
      sessionId: 'agent-session-1',
      items: [
        {
          turnId: 'turn-2',
          role: 'assistant',
          summary: 'most recent turn',
          timestamp: '2026-03-10T10:02:00.000Z',
        },
      ],
      nextCursor: 'cursor-2',
    })
    getTurnBody = vi.fn().mockResolvedValue({
      sessionId: 'agent-session-1',
      turnId: 'turn-2',
      message: {
        role: 'assistant',
        timestamp: '2026-03-10T10:02:00.000Z',
        content: [{ type: 'text', text: 'full turn body' }],
      },
    })

    app = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })
    app.use('/api', createAgentTimelineRouter({
      service: {
        getTimelinePage,
        getTurnBody,
      },
    }))
  })

  it('serves recent-first timeline pages through the route family', async () => {
    const res = await request(app)
      .get('/api/agent-sessions/agent-session-1/timeline?priority=visible&limit=20&revision=7')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items[0].turnId).toBe('turn-2')
    expect(res.body.nextCursor).toBe('cursor-2')
    expect(getTimelinePage).toHaveBeenCalledWith({
      sessionId: 'agent-session-1',
      priority: 'visible',
      revision: 7,
      cursor: undefined,
      limit: 20,
      signal: expect.any(AbortSignal),
    })
  })

  it('passes includeBodies through the route family', async () => {
    await request(app)
      .get('/api/agent-sessions/agent-session-1/timeline?priority=visible&includeBodies=true&revision=7')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(getTimelinePage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'agent-session-1',
      includeBodies: true,
      revision: 7,
    }))
  })

  it('rejects unpinned timeline reads that omit restore revision', async () => {
    const res = await request(app)
      .get('/api/agent-sessions/agent-session-1/timeline?priority=visible&limit=20')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
    expect(getTimelinePage).not.toHaveBeenCalled()
  })

  it('hydrates turn bodies on demand', async () => {
    expect(AgentTimelineTurnBodyQuerySchema.parse({ revision: '7' })).toEqual({ revision: 7 })

    const res = await request(app)
      .get('/api/agent-sessions/agent-session-1/turns/turn-2?revision=7')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.turnId).toBe('turn-2')
    expect(res.body.message.content[0].text).toBe('full turn body')
    expect(getTurnBody).toHaveBeenCalledWith({
      sessionId: 'agent-session-1',
      turnId: 'turn-2',
      revision: 7,
    })
  })

  it('rejects unpinned turn-body reads that omit restore revision', async () => {
    expect(AgentTimelineTurnBodyQuerySchema.safeParse({})).toMatchObject({ success: false })

    const res = await request(app)
      .get('/api/agent-sessions/agent-session-1/turns/turn-2')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
    expect(getTurnBody).not.toHaveBeenCalled()
  })

  it('fails cleanly on invalid timeline queries', async () => {
    const res = await request(app)
      .get('/api/agent-sessions/agent-session-1/timeline?priority=visible&limit=0&revision=7')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
    expect(getTimelinePage).not.toHaveBeenCalled()
  })
})

describe('agent timeline router with the real service', () => {
  function createAuthedApp(service: ReturnType<typeof createAgentTimelineService>): Express {
    const app = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })
    app.use('/api', createAgentTimelineRouter({ service }))
    return app
  }

  it('preserves canonical durable session ids across timeline pages, inline bodies, and turn bodies', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000321'
    const service = createAgentTimelineService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
          queryId: 'sdk-session-321',
          liveSessionId: 'sdk-session-321',
          timelineSessionId: canonicalSessionId,
          revision: 123,
          messages: [
            {
              role: 'user',
              timestamp: '2026-03-10T10:00:00.000Z',
              content: [{ type: 'text', text: 'older prompt' }],
            },
            {
              role: 'assistant',
              timestamp: '2026-03-10T10:01:00.000Z',
              content: [{ type: 'text', text: 'latest reply' }],
            },
          ],
        })),
      },
    })

    const app = createAuthedApp(service)
    const timelineResponse = await request(app)
      .get('/api/agent-sessions/sdk-session-321/timeline?priority=visible&includeBodies=true&revision=123')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(timelineResponse.status).toBe(200)
    expect(timelineResponse.body.sessionId).toBe(canonicalSessionId)
    expect(timelineResponse.body.items).toHaveLength(2)
    expect(timelineResponse.body.items[0].sessionId).toBe(canonicalSessionId)
    expect(timelineResponse.body.bodies[timelineResponse.body.items[0].turnId].sessionId).toBe(canonicalSessionId)

    const turnResponse = await request(app)
      .get(`/api/agent-sessions/sdk-session-321/turns/${timelineResponse.body.items[0].turnId}?revision=123`)
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(turnResponse.status).toBe(200)
    expect(turnResponse.body.sessionId).toBe(canonicalSessionId)
    expect(turnResponse.body.turnId).toBe(timelineResponse.body.items[0].turnId)
  })

  it('rejects stale page and turn-body revisions with RESTORE_STALE_REVISION', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000654'
    const service = createAgentTimelineService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
          queryId: 'sdk-session-654',
          liveSessionId: 'sdk-session-654',
          timelineSessionId: canonicalSessionId,
          revision: 13,
          messages: [
            {
              role: 'assistant',
              timestamp: '2026-03-10T10:01:00.000Z',
              content: [{ type: 'text', text: 'latest reply' }],
            },
          ],
        })),
      },
    })

    const app = createAuthedApp(service)

    const staleTimeline = await request(app)
      .get('/api/agent-sessions/sdk-session-654/timeline?priority=visible&revision=12')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(staleTimeline.status).toBe(409)
    expect(RestoreStaleRevisionResponseSchema.parse(staleTimeline.body)).toEqual({
      error: 'Stale restore revision',
      code: 'RESTORE_STALE_REVISION',
      currentRevision: 13,
    })

    const staleTurn = await request(app)
      .get('/api/agent-sessions/sdk-session-654/turns/turn-0?revision=12')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(staleTurn.status).toBe(409)
    expect(RestoreStaleRevisionResponseSchema.parse(staleTurn.body)).toEqual({
      error: 'Stale restore revision',
      code: 'RESTORE_STALE_REVISION',
      currentRevision: 13,
    })
  })

  it('round-trips a real service cursor without drifting off the accepted revision', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000777'
    const service = createAgentTimelineService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
          queryId: 'sdk-session-777',
          liveSessionId: 'sdk-session-777',
          timelineSessionId: canonicalSessionId,
          revision: 21,
          messages: [
            {
              role: 'user',
              timestamp: '2026-03-10T10:00:00.000Z',
              content: [{ type: 'text', text: 'oldest prompt' }],
            },
            {
              role: 'assistant',
              timestamp: '2026-03-10T10:01:00.000Z',
              content: [{ type: 'text', text: 'middle reply' }],
            },
            {
              role: 'user',
              timestamp: '2026-03-10T10:02:00.000Z',
              content: [{ type: 'text', text: 'newest prompt' }],
            },
          ],
        })),
      },
    })

    const app = createAuthedApp(service)
    const firstPage = await request(app)
      .get('/api/agent-sessions/sdk-session-777/timeline?priority=visible&limit=2&revision=21')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(firstPage.status).toBe(200)
    expect(firstPage.body.revision).toBe(21)
    expect(firstPage.body.nextCursor).toEqual(expect.any(String))

    const secondPage = await request(app)
      .get(`/api/agent-sessions/sdk-session-777/timeline?priority=visible&cursor=${encodeURIComponent(firstPage.body.nextCursor)}&revision=21`)
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(secondPage.status).toBe(200)
    expect(secondPage.body.revision).toBe(21)
    expect(secondPage.body.nextCursor).toBeNull()
    expect(secondPage.body.items).toEqual([
      expect.objectContaining({
        sessionId: canonicalSessionId,
        turnId: 'turn-0',
        messageId: 'message-0',
        ordinal: 0,
        source: 'durable',
      }),
    ])
  })

  it('rejects malformed turn-body revisions with HTTP 400 instead of treating them as stale restore state', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000655'
    const service = createAgentTimelineService({
      agentHistorySource: {
        resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
          queryId: 'sdk-session-655',
          liveSessionId: 'sdk-session-655',
          timelineSessionId: canonicalSessionId,
          revision: 7,
          messages: [
            {
              role: 'assistant',
              timestamp: '2026-03-10T10:01:00.000Z',
              content: [{ type: 'text', text: 'latest reply' }],
            },
          ],
        })),
      },
    })

    const app = createAuthedApp(service)
    const response = await request(app)
      .get('/api/agent-sessions/sdk-session-655/turns/turn-0?revision=abc')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Invalid request')
  })
})
