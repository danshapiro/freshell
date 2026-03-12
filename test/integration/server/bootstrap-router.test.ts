// @vitest-environment node
import express, { type Express } from 'express'
import request from 'supertest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createShellBootstrapRouter, MAX_BOOTSTRAP_PAYLOAD_BYTES } from '../../../server/shell-bootstrap-router.js'

const TEST_AUTH_TOKEN = 'test-auth-token'

function createTestApp(deps?: Partial<Parameters<typeof createShellBootstrapRouter>[0]>): Express {
  const app = express()
  app.use(express.json())

  // Minimal auth middleware for /api
  app.use('/api', (req, res, next) => {
    const token = req.headers['x-auth-token']
    if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
    next()
  })

  app.use('/api', createShellBootstrapRouter({
    getSettings: async () => ({ theme: 'system', logging: { debug: false } }),
    getPlatform: async () => ({ os: 'linux', arch: 'x64' }),
    getShellTaskStatus: async () => ({ codingCliIndexer: false, sessionRepairService: false }),
    getPerfLogging: () => false,
    getConfigFallback: async () => undefined,
    ...deps,
  }))

  return app
}

describe('GET /api/bootstrap', () => {
  let app: Express

  beforeEach(() => {
    app = createTestApp()
  })

  it('returns only shell-critical first-paint data and stays under the payload budget', async () => {
    const res = await request(app)
      .get('/api/bootstrap')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)

    // Payload budget
    const payloadBytes = Buffer.byteLength(res.text || '', 'utf8')
    expect(payloadBytes).toBeLessThanOrEqual(MAX_BOOTSTRAP_PAYLOAD_BYTES)

    // Explicit contract: only these top-level keys
    const keys = Object.keys(res.body)
    expect(keys.sort()).toEqual(['configFallback', 'perf', 'platform', 'settings', 'shell'].filter(k => k in res.body).sort())

    // No session/timeline/terminal/version/network payloads
    const body = JSON.stringify(res.body)
    expect(body).not.toMatch(/\b(sessions|timeline|terminals?|viewport|scrollback|search|version|network)\b/)

    // Shell contains authenticated and task readiness
    expect(res.body.shell).toMatchObject({ authenticated: true })
  })

  it('fails cleanly without leaking data when unauthenticated', async () => {
    const res = await request(app).get('/api/bootstrap')
    expect(res.status).toBe(401)
    // Ensure no accidental data leak
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('includes configFallback when provided', async () => {
    const appWithFallback = createTestApp({
      getConfigFallback: async () => ({ reason: 'read_error', backupExists: true }),
    })

    const res = await request(appWithFallback)
      .get('/api/bootstrap')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.configFallback).toEqual({ reason: 'read_error', backupExists: true })
  })

  it('routes bootstrap through the critical read-model lane', async () => {
    const schedule = vi.fn(async ({ lane, signal, run }: { lane: string; signal: AbortSignal; run: (signal: AbortSignal) => Promise<unknown> }) => {
      expect(lane).toBe('critical')
      expect(signal).toBeInstanceOf(AbortSignal)
      return run(signal)
    })
    const appWithScheduler = createTestApp({
      readModelScheduler: { schedule },
    })

    const res = await request(appWithScheduler)
      .get('/api/bootstrap')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(schedule).toHaveBeenCalledTimes(1)
  })
})
