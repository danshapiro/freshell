// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createSessionsRouter } from '../../../server/sessions-router.js'
import type { ProjectGroup } from '../../../server/coding-cli/types.js'

const TEST_AUTH_TOKEN = 'test-auth-token'

describe('GET /api/session-directory', () => {
  let app: Express
  let patchSessionOverride: ReturnType<typeof vi.fn>
  let deleteSession: ReturnType<typeof vi.fn>

  const projects: ProjectGroup[] = [
    {
      projectPath: '/repo/alpha',
      sessions: [
        {
          provider: 'claude',
          sessionId: 'session-1',
          projectPath: '/repo/alpha',
          updatedAt: 100,
          title: 'Alpha deploy',
          firstUserMessage: 'deploy alpha',
        },
        {
          provider: 'claude',
          sessionId: 'session-2',
          projectPath: '/repo/alpha',
          updatedAt: 50,
          title: 'Routine cleanup',
        },
      ],
    },
  ]

  beforeEach(() => {
    patchSessionOverride = vi.fn().mockResolvedValue({ ok: true })
    deleteSession = vi.fn().mockResolvedValue(undefined)

    app = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })

    app.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride,
        deleteSession,
      },
      codingCliIndexer: {
        getProjects: () => projects,
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: {
        list: () => [],
      },
    }))
  })

  it('serves session windows from /api/session-directory', async () => {
    const res = await request(app)
      .get('/api/session-directory?priority=visible&limit=1')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items.map((item: { sessionId: string }) => item.sessionId)).toEqual(['session-1'])
    expect(res.body.nextCursor).toBeTruthy()
    expect(typeof res.body.revision).toBe('number')
  })

  it('searches through the same route family', async () => {
    const res = await request(app)
      .get('/api/session-directory?priority=visible&query=deploy')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].sessionId).toBe('session-1')
  })

  it('removes legacy read-model routes', async () => {
    const search = await request(app)
      .get('/api/sessions/search?q=deploy')
      .set('x-auth-token', TEST_AUTH_TOKEN)
    const query = await request(app)
      .post('/api/sessions/query')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ priority: 'visible' })

    expect(search.status).toBe(404)
    expect(query.status).toBe(404)
  })

  it('keeps mutation routes separate', async () => {
    const patch = await request(app)
      .patch('/api/sessions/session-1?provider=claude')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'Renamed session' })
    const remove = await request(app)
      .delete('/api/sessions/session-1?provider=claude')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(patch.status).toBe(200)
    expect(remove.status).toBe(200)
    expect(patchSessionOverride).toHaveBeenCalled()
    expect(deleteSession).toHaveBeenCalled()
  })
})
