// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { SessionMetadataStore } from '../../../server/session-metadata-store.js'
import { createSessionsRouter } from '../../../server/sessions-router.js'

const TEST_AUTH_TOKEN = 'test-auth-token'

describe('POST /api/session-metadata', () => {
  let app: Express
  let tempDir: string
  let sessionMetadataStore: SessionMetadataStore
  let mockRefresh: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-metadata-api-test-'))
    sessionMetadataStore = new SessionMetadataStore(tempDir)
    mockRefresh = vi.fn().mockResolvedValue(undefined)

    app = express()
    app.use(express.json())

    // Auth middleware
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })

    // Mount sessions router with minimal deps
    app.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride: vi.fn().mockResolvedValue({}),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      },
      codingCliIndexer: {
        getProjects: () => [],
        refresh: mockRefresh,
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 500 },
      sessionMetadataStore,
    }))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('stores session metadata, triggers refresh, and returns ok', async () => {
    const res = await request(app)
      .post('/api/session-metadata')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ provider: 'claude', sessionId: 'sess-123', sessionType: 'agent' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    // Verify the metadata was actually persisted
    const stored = await sessionMetadataStore.get('claude', 'sess-123')
    expect(stored).toEqual({ sessionType: 'agent' })

    // Verify the indexer was refreshed so sessions API reflects the change
    expect(mockRefresh).toHaveBeenCalled()
  })

  it('returns 400 when provider is missing', async () => {
    const res = await request(app)
      .post('/api/session-metadata')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ sessionId: 'sess-123', sessionType: 'agent' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/missing required fields/i)
  })

  it('returns 400 when sessionId is missing', async () => {
    const res = await request(app)
      .post('/api/session-metadata')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ provider: 'claude', sessionType: 'agent' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/missing required fields/i)
  })

  it('returns 400 when sessionType is missing', async () => {
    const res = await request(app)
      .post('/api/session-metadata')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ provider: 'claude', sessionId: 'sess-123' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/missing required fields/i)
  })

  it('returns 400 when body is empty', async () => {
    const res = await request(app)
      .post('/api/session-metadata')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/missing required fields/i)
  })

  it('returns 400 when provider is a non-string type', async () => {
    const res = await request(app)
      .post('/api/session-metadata')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ provider: 123, sessionId: 'sess-123', sessionType: 'agent' })

    expect(res.status).toBe(400)
  })

  it('returns 400 when provider is not a known CLI provider', async () => {
    const res = await request(app)
      .post('/api/session-metadata')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ provider: 'unknown-cli', sessionId: 'sess-123', sessionType: 'agent' })

    expect(res.status).toBe(400)
  })

  it('returns 400 when sessionId is an object', async () => {
    const res = await request(app)
      .post('/api/session-metadata')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ provider: 'claude', sessionId: {}, sessionType: 'agent' })

    expect(res.status).toBe(400)
  })

  it('returns 400 when sessionType is an empty string', async () => {
    const res = await request(app)
      .post('/api/session-metadata')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ provider: 'claude', sessionId: 'sess-123', sessionType: '' })

    expect(res.status).toBe(400)
  })

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/session-metadata')
      .send({ provider: 'claude', sessionId: 'sess-123', sessionType: 'agent' })

    expect(res.status).toBe(401)
  })
})
