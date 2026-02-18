import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

// Use vi.hoisted to ensure mockState is available before vi.mock runs
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

// Import after mocking
import { ConfigStore, defaultSettings, type AppSettings } from '../../../server/config-store'
import { SettingsPatchSchema } from '../../../server/settings-schema'

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'

describe('Settings API Integration', () => {
  let app: Express
  let configStore: ConfigStore
  let tempDir: string

  beforeAll(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  })

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'settings-api-test-'))
    mockState.homeDir = tempDir

    // Create a fresh ConfigStore instance
    configStore = new ConfigStore()

    // Create minimal Express app with settings routes
    app = express()
    app.use(express.json({ limit: '1mb' }))

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

    // Settings routes matching server/index.ts
    app.get('/api/settings', async (_req, res) => {
      const s = await configStore.getSettings()
      res.json(s)
    })

    const normalizeSettingsPatch = (patch: Record<string, any>) => {
      if (Object.prototype.hasOwnProperty.call(patch, 'defaultCwd')) {
        const raw = patch.defaultCwd
        if (raw === null) {
          patch.defaultCwd = undefined
        } else if (typeof raw === 'string' && raw.trim() === '') {
          patch.defaultCwd = undefined
        }
      }
      return patch
    }

    app.patch('/api/settings', async (req, res) => {
      const parsed = SettingsPatchSchema.safeParse(req.body || {})
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
      }
      const updated = await configStore.patchSettings(normalizeSettingsPatch(parsed.data as any))
      res.json(updated)
    })

    app.put('/api/settings', async (req, res) => {
      const parsed = SettingsPatchSchema.safeParse(req.body || {})
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
      }
      const updated = await configStore.patchSettings(normalizeSettingsPatch(parsed.data as any))
      res.json(updated)
    })
  })

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fsp.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  describe('Authentication', () => {
    it('rejects requests without auth token', async () => {
      const res = await request(app).get('/api/settings')

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('rejects requests with invalid auth token', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', 'wrong-token')

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('rejects requests with empty auth token', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', '')

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('accepts requests with valid auth token', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
    })

    it('requires auth for PUT /api/settings', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ theme: 'dark' })

      expect(res.status).toBe(401)
    })

    it('requires auth for PATCH /api/settings', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .send({ theme: 'dark' })

      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/settings', () => {
    it('returns current settings with default values', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body).toEqual(defaultSettings)
    })

    it('returns settings with expected structure', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('theme')
      expect(res.body).toHaveProperty('uiScale')
      expect(res.body).toHaveProperty('terminal')
      expect(res.body).toHaveProperty('safety')
      expect(res.body).toHaveProperty('sidebar')
      expect(res.body).toHaveProperty('codingCli')
      expect(res.body.terminal).toHaveProperty('fontSize')
      expect(res.body.terminal).toHaveProperty('lineHeight')
      expect(res.body.terminal).toHaveProperty('cursorBlink')
      expect(res.body.terminal).toHaveProperty('scrollback')
      expect(res.body.terminal).toHaveProperty('theme')
      expect(res.body.terminal).toHaveProperty('osc52Clipboard')
      expect(res.body.terminal).toHaveProperty('renderer')
      expect(res.body.safety).toHaveProperty('autoKillIdleMinutes')
      expect(res.body.safety).toHaveProperty('warnBeforeKillMinutes')
      expect(res.body.sidebar).toHaveProperty('sortMode')
      expect(res.body.sidebar).toHaveProperty('showProjectBadges')
      expect(res.body.sidebar).toHaveProperty('width')
      expect(res.body.sidebar).toHaveProperty('collapsed')
    })

    it('returns previously saved settings', async () => {
      // Pre-configure settings
      await configStore.patchSettings({ theme: 'dark' })

      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('dark')
    })

    it('returns JSON content type', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.headers['content-type']).toMatch(/application\/json/)
    })
  })

  describe('PUT /api/settings', () => {
    it('updates settings and returns the updated value', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ theme: 'dark' })

      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('dark')
    })

    it('persists settings changes', async () => {
      await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ theme: 'light' })

      // Verify by fetching
      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.body.theme).toBe('light')
    })

    it('merges with existing settings (does not replace)', async () => {
      // Set initial terminal settings
      await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ terminal: { fontSize: 18 } })

      // Update a different field
      const res = await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ theme: 'dark' })

      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('dark')
      expect(res.body.terminal.fontSize).toBe(18) // Preserved
    })

    it('handles nested terminal settings', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({
          terminal: {
            fontSize: 16,
            cursorBlink: false,
          },
        })

      expect(res.status).toBe(200)
      expect(res.body.terminal.fontSize).toBe(16)
      expect(res.body.terminal.cursorBlink).toBe(false)
      // Other terminal settings preserved
      expect(res.body.terminal.lineHeight).toBe(defaultSettings.terminal.lineHeight)
    })

    it('persists terminal policy fields and preserves them during partial terminal patches', async () => {
      await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({
          terminal: {
            osc52Clipboard: 'never',
            renderer: 'canvas',
          },
        })

      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({
          terminal: {
            fontSize: 18,
          },
        })

      expect(res.status).toBe(200)
      expect(res.body.terminal.fontSize).toBe(18)
      expect(res.body.terminal.osc52Clipboard).toBe('never')
      expect(res.body.terminal.renderer).toBe('canvas')
    })

    it('handles nested safety settings', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({
          safety: {
            autoKillIdleMinutes: 60,
          },
        })

      expect(res.status).toBe(200)
      expect(res.body.safety.autoKillIdleMinutes).toBe(60)
      expect(res.body.safety.warnBeforeKillMinutes).toBe(defaultSettings.safety.warnBeforeKillMinutes)
    })

    it('handles empty body', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({})

      expect(res.status).toBe(200)
      expect(res.body).toEqual(defaultSettings)
    })

    it('can set defaultCwd', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ defaultCwd: '/custom/path' })

      expect(res.status).toBe(200)
      expect(res.body.defaultCwd).toBe('/custom/path')
    })
  })

  describe('PATCH /api/settings', () => {
    it('merges partial updates', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ theme: 'dark' })

      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('dark')
      // Other settings unchanged
      expect(res.body.terminal).toEqual(defaultSettings.terminal)
    })

    it('preserves unmodified settings', async () => {
      // Set up initial state
      await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({
          theme: 'dark',
          terminal: { fontSize: 18 },
        })

      // Patch only safety settings
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({
          safety: { autoKillIdleMinutes: 120 },
        })

      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('dark') // Preserved
      expect(res.body.terminal.fontSize).toBe(18) // Preserved
      expect(res.body.safety.autoKillIdleMinutes).toBe(120) // Updated
    })

    it('deep merges nested objects', async () => {
      // Set initial terminal settings
      await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({
          terminal: {
            fontSize: 14,
            scrollback: 10000,
          },
        })

      // Patch only fontSize
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({
          terminal: { fontSize: 16 },
        })

      expect(res.status).toBe(200)
      expect(res.body.terminal.fontSize).toBe(16) // Updated
      expect(res.body.terminal.scrollback).toBe(10000) // Preserved from previous patch
    })

    it('handles empty body', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({})

      expect(res.status).toBe(200)
      expect(res.body).toEqual(defaultSettings)
    })

    it('handles multiple sequential patches', async () => {
      await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ theme: 'dark' })

      await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ terminal: { fontSize: 15 } })

      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ safety: { warnBeforeKillMinutes: 10 } })

      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('dark')
      expect(res.body.terminal.fontSize).toBe(15)
      expect(res.body.safety.warnBeforeKillMinutes).toBe(10)
    })
  })

  describe('Invalid settings handling', () => {
    it('rejects unknown top-level fields', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ unknownField: 'value' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request')
      expect(res.body.details).toBeDefined()
    })

    it('rejects invalid theme value', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ theme: 'invalid-theme' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request')
    })

    it('rejects non-coercible fontSize', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ terminal: { fontSize: 'not-a-number' } })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request')
    })

    it('accepts negative scrollback (coerced number)', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ terminal: { scrollback: -100 } })

      // Negative numbers are valid coerced numbers - business logic can restrict range later
      expect(res.status).toBe(200)
    })

    it('rejects unknown nested terminal field', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ terminal: { unknownField: true } })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request')
    })

    it('rejects invalid sidebar sortMode enum', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ sidebar: { sortMode: 'invalid' } })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request')
    })

    it('rejects non-coercible fontSize object', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ terminal: { fontSize: { invalid: true } } })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request')
    })

    it('coerces string numbers to actual numbers', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ terminal: { fontSize: '18' } })

      expect(res.status).toBe(200)
      expect(res.body.terminal.fontSize).toBe(18)
    })

    it('accepts currently-used sidebar and panes fields', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({
          sidebar: { sortMode: 'recency-pinned' },
          panes: { iconsOnTabs: false },
        })

      expect(res.status).toBe(200)
      expect(res.body.sidebar.sortMode).toBe('recency-pinned')
      expect(res.body.panes.iconsOnTabs).toBe(false)
    })

    it('rejects invalid panes defaultNewPane enum', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ panes: { defaultNewPane: 'invalid' } })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request')
    })

    it('rejects invalid codingCli provider name', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ codingCli: { enabledProviders: ['nonexistent'] } })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request')
    })

    it('validates PUT endpoint the same as PATCH', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ unknownField: 'value' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request')
    })
  })

  describe('Content-Type handling', () => {
    it('requires JSON content type for PUT', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .set('Content-Type', 'text/plain')
        .send('{ "theme": "dark" }')

      // Express.json() won't parse non-JSON content types
      expect(res.status).toBe(200)
      // Body is empty/undefined, so no changes applied
      expect(res.body.theme).toBe(defaultSettings.theme)
    })

    it('handles JSON content type correctly', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ theme: 'dark' }))

      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('dark')
    })
  })

  describe('Concurrency handling', () => {
    it('handles concurrent PATCH requests', async () => {
      // Send multiple patches concurrently
      const requests = [
        request(app)
          .patch('/api/settings')
          .set('x-auth-token', TEST_AUTH_TOKEN)
          .send({ theme: 'dark' }),
        request(app)
          .patch('/api/settings')
          .set('x-auth-token', TEST_AUTH_TOKEN)
          .send({ terminal: { fontSize: 16 } }),
        request(app)
          .patch('/api/settings')
          .set('x-auth-token', TEST_AUTH_TOKEN)
          .send({ safety: { autoKillIdleMinutes: 90 } }),
      ]

      const results = await Promise.all(requests)

      // All should succeed
      results.forEach((res) => expect(res.status).toBe(200))

      // Final state should have all changes (last write wins for overlapping)
      const final = await request(app)
        .get('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(final.status).toBe(200)
      // At minimum the file should be valid and readable
      expect(final.body).toHaveProperty('theme')
      expect(final.body).toHaveProperty('terminal')
      expect(final.body).toHaveProperty('safety')
    })
  })

  describe('Edge cases', () => {
    it('handles very long string values', async () => {
      const longString = 'a'.repeat(10000)
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ defaultCwd: longString })

      expect(res.status).toBe(200)
      expect(res.body.defaultCwd).toBe(longString)
    })

    it('handles unicode characters', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ defaultCwd: '/path/with/unicode/\u00e9\u00e8\u4e2d\u6587' })

      expect(res.status).toBe(200)
      expect(res.body.defaultCwd).toBe('/path/with/unicode/\u00e9\u00e8\u4e2d\u6587')
    })

    it('handles null values in patch', async () => {
      // Set a value first
      await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ defaultCwd: '/some/path' })

      // Try to set it to null
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ defaultCwd: null })

      expect(res.status).toBe(200)
      // null clears the previous value
      expect(res.body.defaultCwd).toBeUndefined()
    })

    it('handles deeply nested objects', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({
          terminal: {
            fontSize: 14,
            lineHeight: 1.5,
            cursorBlink: false,
            scrollback: 3000,
            theme: 'one-light',
          },
        })

      expect(res.status).toBe(200)
      expect(res.body.terminal).toEqual({
        fontSize: 14,
        lineHeight: 1.5,
        cursorBlink: false,
        scrollback: 3000,
        theme: 'one-light',
        warnExternalLinks: true,
        osc52Clipboard: 'ask',
        renderer: 'auto',
      })
    })
  })

  describe('PATCH /api/settings', () => {
    it('clears defaultCwd when null is provided', async () => {
      await configStore.patchSettings({ defaultCwd: '/tmp' })

      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', TEST_AUTH_TOKEN)
        .send({ defaultCwd: null })

      expect(res.status).toBe(200)
      expect(res.body.defaultCwd).toBeUndefined()
    })
  })
})
