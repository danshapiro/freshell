import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createPlatformRouter, type PlatformRouterDeps } from '../../../server/platform-router.js'

// Mock logger to avoid pino setup in test
vi.mock('../../../server/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { logger }
})

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'

describe('Platform API', () => {
  let app: Express
  const mockDeps: PlatformRouterDeps = {
    detectPlatform: async () => 'linux',
    detectAvailableClis: async () => ({ claude: true, codex: false }),
    detectHostName: async () => 'test-host',
    checkForUpdate: async (_version: string) => ({ hasUpdate: false }),
    appVersion: '0.0.0-test',
  }

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

    app.use('/api', createPlatformRouter(mockDeps))
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  describe('Authentication', () => {
    it('rejects requests without auth token', async () => {
      const res = await request(app).get('/api/platform')

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('rejects requests with invalid auth token', async () => {
      const res = await request(app)
        .get('/api/platform')
        .set('x-auth-token', 'wrong-token')

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('accepts requests with valid auth token', async () => {
      const res = await request(app)
        .get('/api/platform')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
    })
  })

  describe('GET /api/platform', () => {
    it('returns platform info with valid auth', async () => {
      const res = await request(app)
        .get('/api/platform')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('platform')
      expect(typeof res.body.platform).toBe('string')
    })

    it('returns platform, availableClis, and hostName', async () => {
      const res = await request(app)
        .get('/api/platform')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.platform).toBe('linux')
      expect(res.body.availableClis).toEqual({ claude: true, codex: false })
      expect(res.body.hostName).toBe('test-host')
    })

    it('returns JSON content type', async () => {
      const res = await request(app)
        .get('/api/platform')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.headers['content-type']).toMatch(/application\/json/)
    })
  })

  describe('GET /api/version', () => {
    it('returns current version and update check result', async () => {
      const res = await request(app)
        .get('/api/version')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.currentVersion).toBe('0.0.0-test')
      expect(res.body.updateCheck).toEqual({ hasUpdate: false })
    })

    it('returns null updateCheck when check fails', async () => {
      // Create a separate app with a failing checkForUpdate
      const failApp = express()
      failApp.use(express.json())
      failApp.use('/api', (_req, _res, next) => next())
      failApp.use('/api', createPlatformRouter({
        ...mockDeps,
        checkForUpdate: async () => { throw new Error('network error') },
        appVersion: '1.2.3',
      }))

      const res = await request(failApp)
        .get('/api/version')

      expect(res.status).toBe(200)
      expect(res.body.currentVersion).toBe('1.2.3')
      expect(res.body.updateCheck).toBeNull()
    })
  })
})
