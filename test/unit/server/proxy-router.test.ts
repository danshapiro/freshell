// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
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
