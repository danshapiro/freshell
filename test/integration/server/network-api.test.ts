import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import request from 'supertest'
import cookieParser from 'cookie-parser'
import { z } from 'zod'
import { NetworkManager } from '../../../server/network-manager.js'
import { ConfigStore } from '../../../server/config-store.js'
import { httpAuthMiddleware } from '../../../server/auth.js'

// Mock firewall detection to avoid real system calls
vi.mock('../../../server/firewall.js', async () => {
  const actual = await vi.importActual<typeof import('../../../server/firewall.js')>('../../../server/firewall.js')
  return { ...actual, detectFirewall: vi.fn().mockResolvedValue({ platform: 'linux-none', active: false }) }
})
vi.mock('../../../server/bootstrap.js', () => ({
  detectLanIps: vi.fn().mockReturnValue(['192.168.1.100']),
}))
vi.mock('is-port-reachable', () => ({
  default: vi.fn().mockResolvedValue(true),
}))
vi.mock('bonjour-service', () => {
  const unpublishAll = vi.fn()
  const publish = vi.fn().mockReturnValue({ name: 'freshell' })
  const destroy = vi.fn()
  return {
    default: vi.fn().mockImplementation(() => ({ publish, unpublishAll, destroy })),
    Bonjour: vi.fn().mockImplementation(() => ({ publish, unpublishAll, destroy })),
  }
})

describe('Network API integration', () => {
  const token = 'test-token-for-network-api'
  let app: express.Express
  let server: http.Server
  let tmpDir: string
  let configStore: ConfigStore
  let networkManager: NetworkManager

  beforeAll(() => {
    process.env.AUTH_TOKEN = token
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-test-'))
    process.env.FRESHELL_HOME = tmpDir

    configStore = new ConfigStore()
    server = http.createServer()
    networkManager = new NetworkManager(server, configStore, 0)

    app = express()
    app.use(express.json())
    app.use('/api', httpAuthMiddleware)

    // Register the same route handlers as server/index.ts
    app.get('/api/network/status', async (_req, res) => {
      try {
        const status = await networkManager.getStatus()
        res.json(status)
      } catch (err) {
        res.status(500).json({ error: 'Failed to get network status' })
      }
    })

    const NetworkConfigureSchema = z.object({
      host: z.enum(['127.0.0.1', '0.0.0.0']),
      configured: z.boolean(),
      mdns: z.object({
        enabled: z.boolean(),
        hostname: z.string().min(1).max(63)
          .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/)
          .transform((s) => s.toLowerCase()),
      }),
    })

    app.post('/api/network/configure', async (req, res) => {
      const parsed = NetworkConfigureSchema.safeParse(req.body || {})
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
      }
      try {
        const { rebindScheduled } = await networkManager.configure(parsed.data)
        const status = await networkManager.getStatus()
        res.json({ ...status, rebindScheduled })
      } catch (err) {
        res.status(500).json({ error: 'Failed to configure network' })
      }
    })

    // /local-file with cookie auth (matches server/index.ts pattern)
    app.get('/local-file', cookieParser(), (req, res, next) => {
      const headerToken = req.headers['x-auth-token'] as string | undefined
      const cookieToken = req.cookies?.['freshell-auth']
      const authToken = headerToken || cookieToken
      const expectedToken = process.env.AUTH_TOKEN
      if (!expectedToken || authToken !== expectedToken) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      next()
    }, (req, res) => {
      const filePath = req.query.path as string
      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter required' })
      }
      const resolved = path.resolve(filePath)
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ error: 'File not found' })
      }
      res.sendFile(resolved)
    })
  })

  afterEach(async () => {
    await networkManager.stop()
    if (server.listening) server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.FRESHELL_HOME
  })

  describe('GET /api/network/status', () => {
    it('returns network status with expected shape', async () => {
      const res = await request(app)
        .get('/api/network/status')
        .set('x-auth-token', token)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('configured')
      expect(res.body).toHaveProperty('host')
      expect(res.body).toHaveProperty('port')
      expect(res.body).toHaveProperty('lanIps')
      expect(res.body).toHaveProperty('firewall')
      expect(res.body).toHaveProperty('devMode')
      expect(res.body).toHaveProperty('accessUrl')
    })

    it('requires authentication', async () => {
      const res = await request(app).get('/api/network/status')
      expect(res.status).toBe(401)
    })
  })

  describe('POST /api/network/configure', () => {
    it('accepts valid network configuration', async () => {
      const res = await request(app)
        .post('/api/network/configure')
        .set('x-auth-token', token)
        .send({
          host: '0.0.0.0',
          configured: true,
          mdns: { enabled: false, hostname: 'freshell' },
        })
      expect(res.status).toBe(200)
    })

    it('rejects invalid host values', async () => {
      const res = await request(app)
        .post('/api/network/configure')
        .set('x-auth-token', token)
        .send({
          host: '10.0.0.1',
          configured: true,
          mdns: { enabled: false, hostname: 'freshell' },
        })
      expect(res.status).toBe(400)
    })

    it('rejects missing mdns hostname', async () => {
      const res = await request(app)
        .post('/api/network/configure')
        .set('x-auth-token', token)
        .send({
          host: '0.0.0.0',
          configured: true,
          mdns: { enabled: false },
        })
      expect(res.status).toBe(400)
    })

    it('normalizes hostname to lowercase', async () => {
      const res = await request(app)
        .post('/api/network/configure')
        .set('x-auth-token', token)
        .send({
          host: '127.0.0.1',
          configured: true,
          mdns: { enabled: false, hostname: 'MyBox' },
        })
      expect(res.status).toBe(200)
      // Verify config was saved with lowercase hostname
      const settings = await configStore.getSettings()
      expect(settings.network.mdns.hostname).toBe('mybox')
    })
  })

  describe('/local-file auth', () => {
    it('rejects requests without cookie or header', async () => {
      const res = await request(app).get('/local-file?path=/tmp/test-file.txt')
      expect(res.status).toBe(401)
    })

    it('accepts requests with valid cookie', async () => {
      const testFile = path.join(tmpDir, 'test-file.txt')
      fs.writeFileSync(testFile, 'hello')
      const res = await request(app)
        .get(`/local-file?path=${encodeURIComponent(testFile)}`)
        .set('Cookie', `freshell-auth=${token}`)
      expect(res.status).toBe(200)
    })

    it('accepts requests with valid header', async () => {
      const testFile = path.join(tmpDir, 'test-file.txt')
      fs.writeFileSync(testFile, 'hello')
      const res = await request(app)
        .get(`/local-file?path=${encodeURIComponent(testFile)}`)
        .set('x-auth-token', token)
      expect(res.status).toBe(200)
    })

    it('rejects requests with wrong cookie', async () => {
      const res = await request(app)
        .get('/local-file?path=/tmp/test-file.txt')
        .set('Cookie', 'freshell-auth=wrong-token-value')
      expect(res.status).toBe(401)
    })
  })
})
