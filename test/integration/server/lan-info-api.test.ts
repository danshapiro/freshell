// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createNetworkRouter } from '../../../server/network-router.js'

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'

describe('LAN Info API', () => {
  let app: Express
  let detectLanIps: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
    detectLanIps = vi.fn().mockResolvedValue(['192.168.1.100', '10.0.0.50'])

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

    // Mount network router with mock deps (only lan-info matters here)
    app.use('/api', createNetworkRouter({
      networkManager: {
        getStatus: async () => ({}),
        configure: async () => ({ rebindScheduled: false }),
        getManagedWindowsRemoteAccessPorts: async () => [],
        getRelevantPorts: () => [],
        getRemoteAccessPorts: () => [],
        persistManagedWindowsRemoteAccessPorts: async () => {},
        setFirewallConfiguring: () => {},
        clearManagedWindowsRemoteAccessPorts: async () => {},
        resetFirewallCache: () => {},
      },
      configStore: {
        getSettings: async () => ({}),
      },
      wsHandler: {
        broadcast: () => {},
      },
      detectLanIps,
    }))
  })

  afterEach(() => {
    delete process.env.AUTH_TOKEN
  })

  describe('Authentication', () => {
    it('rejects requests without auth token', async () => {
      const res = await request(app).get('/api/lan-info')

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('rejects requests with invalid auth token', async () => {
      const res = await request(app)
        .get('/api/lan-info')
        .set('x-auth-token', 'wrong-token')

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('accepts requests with valid auth token', async () => {
      const res = await request(app)
        .get('/api/lan-info')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
    })
  })

  describe('GET /api/lan-info', () => {
    it('returns LAN IPs as an array', async () => {
      const res = await request(app)
        .get('/api/lan-info')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('ips')
      expect(Array.isArray(res.body.ips)).toBe(true)
    })

    it('returns valid IP addresses', async () => {
      const res = await request(app)
        .get('/api/lan-info')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      // Each IP should be a valid IPv4 format
      for (const ip of res.body.ips) {
        expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
      }
    })

    it('returns JSON content type', async () => {
      const res = await request(app)
        .get('/api/lan-info')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.headers['content-type']).toMatch(/application\/json/)
    })

    it('returns a deterministic 500 when async LAN detection fails', async () => {
      detectLanIps.mockRejectedValueOnce(new Error('lan detection failed'))

      const res = await request(app)
        .get('/api/lan-info')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ error: 'Failed to get LAN info' })
    })
  })
})
