// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createServerInfoRouter } from '../../../server/server-info-router.js'

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'

describe('/api/server-info', () => {
  let app: Express
  const startedAt = Date.now()

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

    app.use('/api/server-info', createServerInfoRouter({
      appVersion: '0.6.0',
      startedAt,
    }))
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  it('requires authentication (no token)', async () => {
    await request(app)
      .get('/api/server-info')
      .expect(401)
  })

  it('requires authentication (invalid token)', async () => {
    await request(app)
      .get('/api/server-info')
      .set('x-auth-token', 'wrong-token')
      .expect(401)
  })

  it('returns server info with version, uptime, nodeVersion, platform, arch', async () => {
    const res = await request(app)
      .get('/api/server-info')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .expect(200)

    expect(res.body).toHaveProperty('version', '0.6.0')
    expect(res.body).toHaveProperty('uptime')
    expect(res.body).toHaveProperty('nodeVersion')
    expect(res.body).toHaveProperty('platform')
    expect(res.body).toHaveProperty('arch')
    expect(typeof res.body.uptime).toBe('number')
    expect(res.body.uptime).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(res.body.uptime)).toBe(true)
  })

  it('uptime increases between two calls', async () => {
    const res1 = await request(app)
      .get('/api/server-info')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .expect(200)

    // Wait a short moment
    await new Promise((resolve) => setTimeout(resolve, 50))

    const res2 = await request(app)
      .get('/api/server-info')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .expect(200)

    expect(res2.body.uptime).toBeGreaterThanOrEqual(res1.body.uptime)
  })
})
