// @vitest-environment node
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import type { PortForwardManager } from '../../../server/port-forward.js'
import { createProxyRouter } from '../../../server/proxy-router.js'
import { parseTrustProxyEnv } from '../../../server/request-ip.js'

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

function createApp(manager: PortForwardManager): Express {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.set('trust proxy', parseTrustProxyEnv(process.env.FRESHELL_TRUST_PROXY))
  app.use('/api', (req, res, next) => {
    const token = process.env.AUTH_TOKEN
    const provided = req.headers['x-auth-token'] as string | undefined
    if (!provided || provided !== token) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  })
  app.use('/api/proxy', createProxyRouter({ portForwardManager: manager }))
  return app
}

function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('createProxyRouter', () => {
  afterEach(() => {
    delete process.env.AUTH_TOKEN
    delete process.env.FRESHELL_TRUST_PROXY
  })

  describe('HTTP reverse proxy', () => {
    let targetServer: http.Server
    let targetPort: number

    beforeAll(async () => {
      const targetApp = express()
      targetApp.get('/', (_req, res) => res.send('hello from target'))
      targetApp.get('/path/to/page', (_req, res) => res.send('deep path'))
      targetApp.get('/with-query', (req, res) => res.json({ q: req.query.q }))
      targetApp.post('/echo', express.json(), (req, res) => res.json(req.body))
      targetServer = await new Promise((resolve) => {
        const server = targetApp.listen(0, '127.0.0.1', () => resolve(server))
      })
      targetPort = (targetServer.address() as AddressInfo).port
    })

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        targetServer.close((err) => (err ? reject(err) : resolve()))
      })
    })

    it('proxies GET to localhost target', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)

      const res = await request(app)
        .get(`/api/proxy/http/${targetPort}/`)
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.text).toBe('hello from target')
    })

    it('proxies deep paths', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)

      const res = await request(app)
        .get(`/api/proxy/http/${targetPort}/path/to/page`)
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.text).toBe('deep path')
    })

    it('preserves query strings', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)

      const res = await request(app)
        .get(`/api/proxy/http/${targetPort}/with-query?q=hello`)
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ q: 'hello' })
    })

    it('proxies POST with body', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)

      const res = await request(app)
        .post(`/api/proxy/http/${targetPort}/echo`)
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ foo: 'bar' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ foo: 'bar' })
    })

    it('returns 502 for unreachable port', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)

      const res = await request(app)
        .get('/api/proxy/http/19999/')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(502)
    })

    it('rejects invalid port numbers', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)

      const res = await request(app)
        .get('/api/proxy/http/99999/')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(400)
    })
  })

  it('waits for forward shutdown before returning from delete', async () => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
    process.env.FRESHELL_TRUST_PROXY = 'loopback'

    const deferred = createDeferred()
    const close = vi.fn(() => deferred.promise)
    const manager = {
      forward: vi.fn(),
      close,
    } as unknown as PortForwardManager

    const app = createApp(manager)

    let settled = false
    const responsePromise = request(app)
      .delete('/api/proxy/forward/3000')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .then((response) => {
        settled = true
        return response
      })

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledWith(3000, 'loopback')
    })
    expect(settled).toBe(false)

    deferred.resolve()

    await expect(responsePromise).resolves.toMatchObject({
      status: 200,
      body: { ok: true },
    })
  })
})
