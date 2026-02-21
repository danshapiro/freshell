// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createRequire } from 'module'
import { createDebugRouter } from '../../server/debug-router.js'

const require = createRequire(import.meta.url)
const packageJson = require('../../package.json')
const APP_VERSION: string = packageJson.version

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'

describe('API Endpoints', () => {
  let app: Express

  beforeAll(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN

    app = express()
    app.use(express.json())

    // Auth middleware matching server/auth.ts httpAuthMiddleware
    app.use('/api', (req, res, next) => {
      if (req.path === '/health') return next()

      const token = process.env.AUTH_TOKEN
      if (!token) return res.status(500).json({ error: 'Server misconfigured: AUTH_TOKEN missing' })

      const provided = req.headers['x-auth-token'] as string | undefined
      if (!provided || provided !== token) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      next()
    })

    // Health endpoint - mirrors server/index.ts
    app.get('/api/health', (_req, res) => {
      res.json({ app: 'freshell', ok: true, version: APP_VERSION, ready: true })
    })

    // Debug endpoint - using real router
    app.use('/api/debug', createDebugRouter({
      appVersion: APP_VERSION,
      configStore: { snapshot: vi.fn().mockResolvedValue({ settings: {} }) },
      wsHandler: { connectionCount: () => 0 },
      codingCliIndexer: { getProjects: () => [] },
      tabsRegistryStore: { count: () => 0, listDevices: () => [] },
      registry: { list: () => [] },
    }))
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  describe('GET /api/health', () => {
    it('returns ok status', async () => {
      const res = await request(app).get('/api/health')

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('returns version in response', async () => {
      const res = await request(app).get('/api/health')

      expect(res.body).toHaveProperty('version')
      expect(typeof res.body.version).toBe('string')
    })

    it('returns readiness status', async () => {
      const res = await request(app).get('/api/health')

      expect(res.body).toHaveProperty('ready')
      expect(typeof res.body.ready).toBe('boolean')
    })

    it('returns version matching package.json', async () => {
      const res = await request(app).get('/api/health')

      expect(res.body.version).toBe(APP_VERSION)
    })

    it('does not require authentication', async () => {
      // No auth token provided
      const res = await request(app).get('/api/health')

      expect(res.status).toBe(200)
    })

    it('returns JSON content type', async () => {
      const res = await request(app).get('/api/health')

      expect(res.headers['content-type']).toMatch(/application\/json/)
    })
  })

  describe('GET /api/debug', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/api/debug')

      expect(res.status).toBe(401)
    })

    it('returns debug info with valid auth', async () => {
      const res = await request(app)
        .get('/api/debug')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('version')
      expect(res.body).toHaveProperty('appVersion')
      expect(res.body).toHaveProperty('wsConnections')
      expect(res.body).toHaveProperty('settings')
      expect(res.body).toHaveProperty('terminals')
      expect(res.body).toHaveProperty('time')
    })

    it('returns appVersion matching package.json', async () => {
      const res = await request(app)
        .get('/api/debug')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.body.appVersion).toBe(APP_VERSION)
    })

    it('returns JSON content type', async () => {
      const res = await request(app)
        .get('/api/debug')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.headers['content-type']).toMatch(/application\/json/)
    })
  })
})
