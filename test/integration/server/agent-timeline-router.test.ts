// @vitest-environment node
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentTimelineRouter } from '../../../server/agent-timeline/router.js'
import { createAgentTimelineService } from '../../../server/agent-timeline/service.js'

const TEST_AUTH_TOKEN = 'test-auth-token'

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
      .get('/api/agent-sessions/agent-session-1/timeline?priority=visible&limit=20')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items[0].turnId).toBe('turn-2')
    expect(res.body.nextCursor).toBe('cursor-2')
    expect(getTimelinePage).toHaveBeenCalledWith({
      sessionId: 'agent-session-1',
      priority: 'visible',
      cursor: undefined,
      limit: 20,
      signal: expect.any(AbortSignal),
    })
  })

  it('passes includeBodies through the route family', async () => {
    await request(app)
      .get('/api/agent-sessions/agent-session-1/timeline?priority=visible&includeBodies=true')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(getTimelinePage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'agent-session-1',
      includeBodies: true,
    }))
  })

  it('hydrates turn bodies on demand', async () => {
    const res = await request(app)
      .get('/api/agent-sessions/agent-session-1/turns/turn-2')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.turnId).toBe('turn-2')
    expect(res.body.message.content[0].text).toBe('full turn body')
  })

  it('fails cleanly on invalid timeline queries', async () => {
    const res = await request(app)
      .get('/api/agent-sessions/agent-session-1/timeline?priority=visible&limit=0')
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
        resolve: vi.fn().mockResolvedValue({
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
        }),
      },
    })

    const app = createAuthedApp(service)
    const timelineResponse = await request(app)
      .get('/api/agent-sessions/sdk-session-321/timeline?priority=visible&includeBodies=true')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(timelineResponse.status).toBe(200)
    expect(timelineResponse.body.sessionId).toBe(canonicalSessionId)
    expect(timelineResponse.body.items).toHaveLength(2)
    expect(timelineResponse.body.items[0].sessionId).toBe(canonicalSessionId)
    expect(timelineResponse.body.bodies[timelineResponse.body.items[0].turnId].sessionId).toBe(canonicalSessionId)

    const turnResponse = await request(app)
      .get(`/api/agent-sessions/sdk-session-321/turns/${timelineResponse.body.items[0].turnId}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(turnResponse.status).toBe(200)
    expect(turnResponse.body.sessionId).toBe(canonicalSessionId)
    expect(turnResponse.body.turnId).toBe(timelineResponse.body.items[0].turnId)
  })
})
