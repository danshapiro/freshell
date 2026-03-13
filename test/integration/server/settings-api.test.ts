// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

const mockState = vi.hoisted(() => ({
  homeDir: process.env.TEMP || process.env.TMP || '/tmp',
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => mockState.homeDir,
    },
    homedir: () => mockState.homeDir,
  }
})

import { ConfigStore, defaultSettings } from '../../../server/config-store'
import { createSettingsRouter } from '../../../server/settings-router'

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'

describe('Settings API Integration', () => {
  let app: Express
  let configStore: ConfigStore
  let tempDir: string

  beforeAll(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  })

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'settings-api-test-'))
    mockState.homeDir = tempDir
    configStore = new ConfigStore()

    app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api', (req, res, next) => {
      const token = process.env.AUTH_TOKEN
      const provided = req.headers['x-auth-token'] as string | undefined
      if (!token) return res.status(500).json({ error: 'Server misconfigured: AUTH_TOKEN missing' })
      if (!provided || provided !== token) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      next()
    })

    app.use('/api/settings', createSettingsRouter({
      configStore,
      registry: { setSettings: vi.fn() },
      wsHandler: { broadcast: vi.fn() },
      codingCliIndexer: { refresh: vi.fn().mockResolvedValue(undefined) },
      perfConfig: { slowSessionRefreshMs: 500 },
      applyDebugLogging: vi.fn(),
    }))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  it('rejects requests without auth', async () => {
    const res = await request(app).get('/api/settings')

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('GET /api/settings returns only the server-backed contract', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(defaultSettings)
    expect(res.body).not.toHaveProperty('theme')
    expect(res.body).not.toHaveProperty('uiScale')
    expect(res.body).not.toHaveProperty('notifications')
    expect(res.body.terminal).toEqual({ scrollback: defaultSettings.terminal.scrollback })
    expect(res.body.sidebar).toEqual({
      excludeFirstChatSubstrings: [],
      excludeFirstChatMustStart: false,
    })
  })

  it('PATCH /api/settings round-trips representative server-backed fields', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({
        defaultCwd: '/workspace',
        terminal: { scrollback: 12000 },
        sidebar: {
          excludeFirstChatSubstrings: [' __AUTO__ ', '__AUTO__', 'canary'],
          excludeFirstChatMustStart: true,
        },
        codingCli: {
          providers: {
            codex: {
              cwd: '/workspace/codex',
            },
          },
        },
        agentChat: {
          defaultPlugins: ['fs', 'search'],
        },
      })

    expect(res.status).toBe(200)
    expect(res.body.defaultCwd).toBe('/workspace')
    expect(res.body.terminal.scrollback).toBe(12000)
    expect(res.body.sidebar.excludeFirstChatSubstrings).toEqual(['__AUTO__', 'canary'])
    expect(res.body.sidebar.excludeFirstChatMustStart).toBe(true)
    expect(res.body.codingCli.providers.codex.cwd).toBe('/workspace/codex')
    expect(res.body.agentChat.defaultPlugins).toEqual(['fs', 'search'])
  })

  it('PATCH /api/settings accepts defaultCwd: null and clears it', async () => {
    await request(app)
      .patch('/api/settings')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ defaultCwd: '/workspace' })

    const res = await request(app)
      .patch('/api/settings')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ defaultCwd: null })

    expect(res.status).toBe(200)
    expect(res.body.defaultCwd).toBeUndefined()
  })

  it('PATCH /api/settings rejects local-only settings fields', async () => {
    const payloads = [
      { theme: 'dark' },
      { terminal: { fontSize: 18 } },
      { terminal: { osc52Clipboard: 'always' } },
      { sidebar: { sortMode: 'activity' } },
      { sidebar: { showSubagents: true } },
      { sidebar: { ignoreCodexSubagents: true } },
      { notifications: { soundEnabled: false } },
    ]

    for (const payload of payloads) {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send(payload)

      expect(res.status, JSON.stringify(payload)).toBe(400)
      expect(res.body.error).toBe('Invalid request')
    }
  })

  it('PATCH /api/settings rejects stray local-only sidebar keys', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ sidebar: { width: 300, ignoreCodexSubagentSessions: true } })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid request')
  })

  it('PUT /api/settings applies the same server-only validation as PATCH', async () => {
    const res = await request(app)
      .put('/api/settings')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ theme: 'dark' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid request')
  })

  it('non-JSON content leaves the settings unchanged', async () => {
    const res = await request(app)
      .put('/api/settings')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .set('Content-Type', 'text/plain')
      .send('{ "defaultCwd": "/workspace" }')

    expect(res.status).toBe(200)
    expect(res.body).toEqual(defaultSettings)
  })

  it('application/json content updates server-backed settings', async () => {
    const res = await request(app)
      .put('/api/settings')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ defaultCwd: '/workspace' }))

    expect(res.status).toBe(200)
    expect(res.body.defaultCwd).toBe('/workspace')
  })
})
