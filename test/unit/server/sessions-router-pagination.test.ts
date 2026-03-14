// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createSessionsRouter } from '../../../server/sessions-router.js'

describe('session-directory query validation', () => {
  let app: express.Express

  beforeEach(() => {
    app = express()
    app.use(express.json())
    app.use(createSessionsRouter({
      configStore: {
        patchSessionOverride: vi.fn(),
        deleteSession: vi.fn(),
      },
      codingCliIndexer: {
        getProjects: () => [],
        refresh: vi.fn(),
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 1_000 },
      terminalMetadata: {
        list: () => [],
      },
    }))
  })

  it('accepts only the visible-first query window contract', async () => {
    const cursor = Buffer.from(JSON.stringify({
      lastActivityAt: 1,
      key: 'claude:session-1',
    }), 'utf8').toString('base64url')
    const res = await request(app).get(`/session-directory?priority=visible&limit=10&revision=3&cursor=${cursor}`)
    expect(res.status).toBe(200)
  })

  it('rejects invalid priority values', async () => {
    const res = await request(app).get('/session-directory?priority=critical')
    expect(res.status).toBe(400)
  })

  it('rejects oversized limits', async () => {
    const res = await request(app).get('/session-directory?priority=visible&limit=51')
    expect(res.status).toBe(400)
  })

  it('rejects malformed cursors', async () => {
    const res = await request(app).get('/session-directory?priority=visible&cursor=%%%')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cursor/i)
  })
})
