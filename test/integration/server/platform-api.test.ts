import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { detectPlatform } from '../../../server/platform.js'

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'

describe('Platform API', () => {
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

    // Platform endpoint (uses detectPlatform matching server/index.ts implementation)
    app.get('/api/platform', async (_req, res) => {
      const platform = await detectPlatform()
      res.json({ platform })
    })
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

    it('returns a valid platform value (including wsl)', async () => {
      const res = await request(app)
        .get('/api/platform')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      // Standard Node.js platforms plus 'wsl' for Windows Subsystem for Linux
      const validPlatforms = ['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'wsl']
      expect(validPlatforms).toContain(res.body.platform)
    })

    it('returns JSON content type', async () => {
      const res = await request(app)
        .get('/api/platform')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.headers['content-type']).toMatch(/application\/json/)
    })
  })
})
