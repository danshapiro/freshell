import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
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

// Import after mocks are set up
import { ConfigStore } from '../../../server/config-store'
import { TerminalMetadataService } from '../../../server/terminal-metadata-service'
import { findTerminalForSession } from '../../../server/rename-cascade'
import { makeSessionKey, type CodingCliProviderName } from '../../../server/coding-cli/types'

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'

/**
 * Integration test for the unified rename cascade.
 *
 * Verifies the full round-trip:
 *  - Terminal rename  =>  session override is written
 *  - Session rename   =>  terminal override is written (with cascadedTerminalId)
 *
 * Uses a real ConfigStore (backed by a temp directory) and real
 * TerminalMetadataService, wired into minimal Express apps that mirror
 * the production PATCH routes in server/index.ts.
 *
 * Note: We inline the cascade logic rather than calling cascadeTerminalRenameToSession
 * / cascadeSessionRenameToTerminal, because those functions import the module-level
 * singleton configStore. In this integration test we need all operations to flow through
 * the same ConfigStore instance so assertions read the correct data.
 */
describe('Unified rename cascade — integration', () => {
  let configStore: ConfigStore
  let terminalMetadata: TerminalMetadataService
  let app: Express
  let tempDir: string

  beforeAll(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  })

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unified-rename-test-'))
    mockState.homeDir = tempDir

    configStore = new ConfigStore()
    terminalMetadata = new TerminalMetadataService({
      now: () => Date.now(),
      git: {
        resolveCheckoutRoot: async () => '',
        resolveRepoRoot: async () => '',
        resolveBranchAndDirty: async () => ({}),
      },
    })

    app = buildTestApp(configStore, terminalMetadata)
  })

  afterEach(async () => {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  // ────────────────────────────────────────────
  // Test 1: Terminal rename cascades to session
  // ────────────────────────────────────────────
  it('terminal rename cascades to session override', async () => {
    const terminalId = 'term_cascade_1'
    const provider: CodingCliProviderName = 'claude'
    const sessionId = 'session-abc-123'
    const compositeKey = makeSessionKey(provider, sessionId)

    // Seed a terminal and associate it with a coding CLI session
    await terminalMetadata.seedFromTerminal({
      terminalId,
      mode: 'claude',
      cwd: '/tmp/project',
    })
    terminalMetadata.associateSession(terminalId, provider, sessionId)

    // PATCH terminal with a new title
    const res = await request(app)
      .patch(`/api/terminals/${terminalId}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'My Renamed Session' })
      .expect(200)

    expect(res.body.titleOverride).toBe('My Renamed Session')

    // Verify the session override was written via the cascade
    const sessionOverride = await configStore.getSessionOverride(compositeKey)
    expect(sessionOverride).toBeDefined()
    expect(sessionOverride!.titleOverride).toBe('My Renamed Session')
  })

  // ────────────────────────────────────────────
  // Test 2: Session rename cascades to terminal
  // ────────────────────────────────────────────
  it('session rename cascades to terminal override', async () => {
    const terminalId = 'term_cascade_2'
    const provider: CodingCliProviderName = 'claude'
    const sessionId = 'session-def-456'
    const compositeKey = makeSessionKey(provider, sessionId)

    // Seed a terminal and associate it with a coding CLI session
    await terminalMetadata.seedFromTerminal({
      terminalId,
      mode: 'claude',
      cwd: '/tmp/project',
    })
    terminalMetadata.associateSession(terminalId, provider, sessionId)

    // PATCH session with a new title
    const res = await request(app)
      .patch(`/api/sessions/${compositeKey}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'Renamed From History' })
      .expect(200)

    expect(res.body.titleOverride).toBe('Renamed From History')
    expect(res.body.cascadedTerminalId).toBe(terminalId)

    // Verify the terminal override was written via the cascade
    const terminalOverride = await configStore.getTerminalOverride(terminalId)
    expect(terminalOverride).toBeDefined()
    expect(terminalOverride!.titleOverride).toBe('Renamed From History')
  })
})

// ────────────────────────────────────────────────────────────────
// Minimal Express app that mirrors the production PATCH routes
// from server/index.ts, using inlined cascade logic so all
// operations flow through the same ConfigStore instance.
// ────────────────────────────────────────────────────────────────

function buildTestApp(
  configStore: ConfigStore,
  terminalMetadata: TerminalMetadataService,
): Express {
  const app = express()
  app.use(express.json())

  // Auth middleware (matches production behavior)
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

  // PATCH /api/terminals/:terminalId  (mirrors server/index.ts)
  app.patch('/api/terminals/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    const { titleOverride, descriptionOverride, deleted } = req.body || {}

    const next = await configStore.patchTerminalOverride(terminalId, {
      titleOverride,
      descriptionOverride,
      deleted,
    })

    // Cascade: if this terminal has a coding CLI session, also rename the session
    // (inlined from cascadeTerminalRenameToSession to use the test's configStore)
    if (typeof titleOverride === 'string' && titleOverride.trim()) {
      const meta = terminalMetadata.list().find((m) => m.terminalId === terminalId)
      if (meta?.provider && meta.sessionId) {
        const compositeKey = makeSessionKey(meta.provider as CodingCliProviderName, meta.sessionId)
        await configStore.patchSessionOverride(compositeKey, { titleOverride: titleOverride.trim() })
      }
    }

    res.json(next)
  })

  // PATCH /api/sessions/:sessionId  (mirrors server/index.ts)
  app.patch('/api/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)

    const { titleOverride } = req.body || {}
    const cleanTitle = typeof titleOverride === 'string' ? titleOverride.trim() || undefined : undefined

    const next = await configStore.patchSessionOverride(compositeKey, {
      titleOverride: cleanTitle,
    })

    // Cascade: if this session is running in a terminal, also rename the terminal
    // (inlined from cascadeSessionRenameToTerminal to use the test's configStore)
    let cascadedTerminalId: string | undefined
    if (cleanTitle) {
      const parts = compositeKey.split(':')
      const sessionProvider = (parts.length >= 2 ? parts[0] : provider) as CodingCliProviderName
      const sessionId = parts.length >= 2 ? parts.slice(1).join(':') : rawId
      const match = findTerminalForSession(terminalMetadata.list(), sessionProvider, sessionId)
      if (match) {
        await configStore.patchTerminalOverride(match.terminalId, { titleOverride: cleanTitle })
        cascadedTerminalId = match.terminalId
      }
    }

    res.json({ ...next, cascadedTerminalId })
  })

  return app
}
