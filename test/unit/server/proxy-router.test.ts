// @vitest-environment node
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { WebSocketServer, WebSocket } from 'ws'
import type { PortForwardManager } from '../../../server/port-forward.js'
import { createProxyRouter, attachProxyUpgradeHandler } from '../../../server/proxy-router.js'
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
      targetApp.get('/with-xfo', (_req, res) => {
        res.set('X-Frame-Options', 'DENY')
        res.send('framed content')
      })
      targetApp.get('/with-csp', (_req, res) => {
        res.set('Content-Security-Policy', "frame-ancestors 'none'; default-src 'self'")
        res.send('csp content')
      })
      targetApp.get('/with-both', (_req, res) => {
        res.set('X-Frame-Options', 'SAMEORIGIN')
        res.set('Content-Security-Policy', "frame-ancestors 'none'")
        res.send('both headers')
      })
      targetApp.get('/no-frame-headers', (_req, res) => {
        res.set('X-Custom-Header', 'keep-me')
        res.send('no frame headers')
      })
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

    it('strips X-Frame-Options header from proxied responses', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)

      const res = await request(app)
        .get(`/api/proxy/http/${targetPort}/with-xfo`)
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.text).toBe('framed content')
      expect(res.headers['x-frame-options']).toBeUndefined()
    })

    it('strips Content-Security-Policy header from proxied responses', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)

      const res = await request(app)
        .get(`/api/proxy/http/${targetPort}/with-csp`)
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.text).toBe('csp content')
      expect(res.headers['content-security-policy']).toBeUndefined()
    })

    it('strips both X-Frame-Options and Content-Security-Policy simultaneously', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)

      const res = await request(app)
        .get(`/api/proxy/http/${targetPort}/with-both`)
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.text).toBe('both headers')
      expect(res.headers['x-frame-options']).toBeUndefined()
      expect(res.headers['content-security-policy']).toBeUndefined()
    })

    it('preserves non-iframe-blocking headers from proxied responses', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)

      const res = await request(app)
        .get(`/api/proxy/http/${targetPort}/no-frame-headers`)
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.text).toBe('no frame headers')
      expect(res.headers['x-custom-header']).toBe('keep-me')
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

  describe('WebSocket upgrade proxy', () => {
    let wsTargetServer: http.Server
    let wsTargetPort: number
    let wss: WebSocketServer

    beforeAll(async () => {
      wsTargetServer = http.createServer()
      wss = new WebSocketServer({ server: wsTargetServer })
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          ws.send(`echo: ${data}`)
        })
      })
      await new Promise<void>((resolve) => {
        wsTargetServer.listen(0, '127.0.0.1', () => resolve())
      })
      wsTargetPort = (wsTargetServer.address() as AddressInfo).port
    })

    afterAll(async () => {
      for (const client of wss.clients) client.terminate()
      wss.close()
      await new Promise<void>((resolve, reject) => {
        wsTargetServer.close((err) => (err ? reject(err) : resolve()))
      })
    })

    it('proxies WebSocket connections through the upgrade handler', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)
      const server = http.createServer(app)
      attachProxyUpgradeHandler(server)

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const proxyPort = (server.address() as AddressInfo).port

      try {
        const ws = new WebSocket(
          `ws://127.0.0.1:${proxyPort}/api/proxy/http/${wsTargetPort}/`,
          { headers: { 'cookie': `freshell-auth=${TEST_AUTH_TOKEN}` } },
        )

        const reply = await new Promise<string>((resolve, reject) => {
          ws.on('open', () => ws.send('hello'))
          ws.on('message', (data) => resolve(data.toString()))
          ws.on('error', reject)
          setTimeout(() => reject(new Error('WebSocket timeout')), 5000)
        })

        expect(reply).toBe('echo: hello')
        ws.close()
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('delegates non-proxy upgrade requests to existing listeners', async () => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
      const app = createApp(manager)
      const server = http.createServer(app)

      // Simulate freshell's own WS handler registered before the proxy
      const delegatedPaths: string[] = []
      server.on('upgrade', (req, socket) => {
        delegatedPaths.push(req.url ?? '')
        socket.destroy()
      })

      attachProxyUpgradeHandler(server)

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const proxyPort = (server.address() as AddressInfo).port

      try {
        const ws = new WebSocket(
          `ws://127.0.0.1:${proxyPort}/some/other/path`,
          { headers: { 'cookie': `freshell-auth=${TEST_AUTH_TOKEN}` } },
        )

        await new Promise<void>((resolve) => {
          ws.on('error', () => resolve())
          ws.on('close', () => resolve())
          setTimeout(resolve, 2000)
        })

        expect(delegatedPaths).toContain('/some/other/path')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })
})
