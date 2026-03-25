// @vitest-environment node
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentTimelineRouter } from '../../../server/agent-timeline/router.js'

const TEST_AUTH_TOKEN = 'test-auth-token'

function makeMockMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    timestamp: `2026-03-10T10:${String(i).padStart(2, '0')}:00.000Z`,
    content: [{ type: 'text' as const, text: `Message ${i}` }],
  }))
}

describe('GET /api/agent-sessions/:sessionId/timeline with includeBodies', () => {
  let app: Express
  let getTimelinePage: ReturnType<typeof vi.fn>
  let getTurnBody: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getTimelinePage = vi.fn()
    getTurnBody = vi.fn()

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

  it('GET /timeline?includeBodies=true returns bodies in response', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      turnId: `turn-${2 - i}`,
      sessionId: 's1',
      role: i % 2 === 0 ? 'user' : 'assistant',
      summary: `Summary ${2 - i}`,
    }))
    const bodies: Record<string, any> = {}
    for (const item of items) {
      bodies[item.turnId] = {
        sessionId: 's1',
        turnId: item.turnId,
        message: { role: item.role, content: [{ type: 'text', text: `Body ${item.turnId}` }] },
      }
    }

    getTimelinePage.mockResolvedValue({
      sessionId: 's1',
      items,
      bodies,
      nextCursor: null,
      revision: 1234567890,
    })

    const res = await request(app)
      .get('/api/agent-sessions/s1/timeline?priority=visible&includeBodies=true')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(3)
    expect(res.body.bodies).toBeDefined()
    expect(Object.keys(res.body.bodies)).toHaveLength(3)
    expect(res.body.bodies['turn-2']).toBeDefined()
    expect(res.body.bodies['turn-2'].message.content[0].text).toBe('Body turn-2')

    // Verify the query passed to the service includes includeBodies
    expect(getTimelinePage).toHaveBeenCalledWith(
      expect.objectContaining({
        includeBodies: true,
      }),
    )
  })

  it('GET /timeline without includeBodies: no bodies field', async () => {
    getTimelinePage.mockResolvedValue({
      sessionId: 's1',
      items: [{ turnId: 'turn-0', sessionId: 's1', role: 'user', summary: 'Hello' }],
      nextCursor: null,
      revision: 123,
    })

    const res = await request(app)
      .get('/api/agent-sessions/s1/timeline?priority=visible')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.bodies).toBeUndefined()

    // Verify includeBodies was not set (or false)
    expect(getTimelinePage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
      }),
    )
  })

  it('includeBodies=true returns all bodies in a single HTTP response, eliminating per-turn requests', async () => {
    // With includeBodies=true, one HTTP response carries all turn bodies.
    // Without it, the client would need 10 separate getTurnBody requests.
    const items = Array.from({ length: 10 }, (_, i) => ({
      turnId: `turn-${9 - i}`,
      sessionId: 's1',
      role: i % 2 === 0 ? 'user' : 'assistant',
      summary: `Summary ${9 - i}`,
    }))
    const bodies: Record<string, any> = {}
    for (const item of items) {
      bodies[item.turnId] = {
        sessionId: 's1',
        turnId: item.turnId,
        message: { role: item.role, content: [{ type: 'text', text: `Body ${item.turnId}` }] },
      }
    }

    getTimelinePage.mockResolvedValue({
      sessionId: 's1',
      items,
      bodies,
      nextCursor: null,
      revision: 1234567890,
    })

    const res = await request(app)
      .get('/api/agent-sessions/s1/timeline?priority=visible&includeBodies=true')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    // A single response carries all 10 bodies
    expect(Object.keys(res.body.bodies)).toHaveLength(10)
    // Every turn has a body with correct content
    for (const item of items) {
      expect(res.body.bodies[item.turnId]).toBeDefined()
      expect(res.body.bodies[item.turnId].message.content[0].text).toBe(`Body ${item.turnId}`)
    }
    // No separate getTurnBody calls were made on the server
    expect(getTurnBody).not.toHaveBeenCalled()
  })

  it('GET /timeline?includeBodies=false does not return bodies', async () => {
    getTimelinePage.mockResolvedValue({
      sessionId: 's1',
      items: [{ turnId: 'turn-0', sessionId: 's1', role: 'user', summary: 'Hello' }],
      nextCursor: null,
      revision: 123,
    })

    const res = await request(app)
      .get('/api/agent-sessions/s1/timeline?priority=visible&includeBodies=false')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.bodies).toBeUndefined()

    // Service should have been called with includeBodies=false
    expect(getTimelinePage).toHaveBeenCalledWith(
      expect.objectContaining({
        includeBodies: false,
      }),
    )
  })

  it('includeBodies=true with empty session: empty items and no bodies', async () => {
    getTimelinePage.mockResolvedValue({
      sessionId: 's1',
      items: [],
      nextCursor: null,
      revision: 0,
    })

    const res = await request(app)
      .get('/api/agent-sessions/s1/timeline?priority=visible&includeBodies=true')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items).toEqual([])
    // Bodies may be absent or empty object for empty sessions
    if (res.body.bodies !== undefined) {
      expect(Object.keys(res.body.bodies)).toHaveLength(0)
    }
  })
})
