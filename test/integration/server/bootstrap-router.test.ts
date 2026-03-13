// @vitest-environment node
import express, { type Express } from 'express'
import request from 'supertest'
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { createShellBootstrapRouter, MAX_BOOTSTRAP_PAYLOAD_BYTES } from '../../../server/shell-bootstrap-router.js'
import { defaultSettings } from '../../../server/config-store.js'

const TEST_AUTH_TOKEN = 'test-auth-token'

function createTestApp(deps?: Partial<Parameters<typeof createShellBootstrapRouter>[0]>): Express {
  const app = express()
  app.use(express.json())
  app.use('/api', (req, res, next) => {
    const token = req.headers['x-auth-token']
    if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
    next()
  })

  app.use('/api', createShellBootstrapRouter({
    getSettings: async () => defaultSettings,
    getLegacyLocalSettingsSeed: async () => undefined,
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

  it('returns server-only settings and stays under the payload budget', async () => {
    const res = await request(app)
      .get('/api/bootstrap')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(Buffer.byteLength(res.text || '', 'utf8')).toBeLessThanOrEqual(MAX_BOOTSTRAP_PAYLOAD_BYTES)
    expect(res.body.settings).toEqual(defaultSettings)
    expect(res.body.settings).not.toHaveProperty('theme')
    expect(res.body).not.toHaveProperty('legacyLocalSettingsSeed')
  })

  it('may return a bootstrap-only legacyLocalSettingsSeed', async () => {
    const seed = {
      theme: 'dark',
      terminal: {
        fontFamily: 'Fira Code',
      },
    }
    const appWithSeed = createTestApp({
      getLegacyLocalSettingsSeed: async () => seed,
    })

    const res = await request(appWithSeed)
      .get('/api/bootstrap')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.legacyLocalSettingsSeed).toEqual(seed)
    expect(Buffer.byteLength(res.text || '', 'utf8')).toBeLessThanOrEqual(MAX_BOOTSTRAP_PAYLOAD_BYTES)
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
