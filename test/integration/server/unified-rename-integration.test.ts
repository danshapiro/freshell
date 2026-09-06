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
 * Integration test for the rename scope contract (kata freshell#b5fb).
 *
 * Verifies the full round-trip:
 *  - Terminal rename  =>  terminal scope ONLY: no session override is written
 *  - Session rename   =>  terminal override is written (with cascadedTerminalId)
 *  - Session clear    =>  {titleOverride: null} removes titleOverride AND titleSource
 *
 * Uses a real ConfigStore (backed by a temp directory) and real
 * TerminalMetadataService, wired into minimal Express apps that mirror
 * the production PATCH routes in server/terminals-router.ts and
 * server/sessions-router.ts.
 *
 * Note: We inline the session→terminal mirror logic rather than calling
 * cascadeSessionRenameToTerminal, because that function imports the module-level
 * singleton configStore. In this integration test we need all operations to flow
 * through the same ConfigStore instance so assertions read the correct data.
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

  // ────────────────────────────────────────────────────────────
  // Test 1: Terminal rename does NOT write a session override (live)
  // ────────────────────────────────────────────────────────────
  it('terminal rename does NOT write a session override (live)', async () => {
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
      .send({ titleOverride: 'My Renamed Terminal' })
      .expect(200)

    expect(res.body.titleOverride).toBe('My Renamed Terminal')

    // b5fb scope contract: a pane/terminal rename is terminal scope only — it
    // must not write a durable session override.
    expect(await configStore.getSessionOverride(compositeKey)).toBeUndefined()
  })

  // ────────────────────────────────────────────────────────────
  // Test 2: Terminal rename does NOT write a session override (retired)
  // ────────────────────────────────────────────────────────────
  it('terminal rename does NOT write a session override (retired)', async () => {
    const terminalId = 'term_cascade_exit'
    const provider: CodingCliProviderName = 'claude'
    const sessionId = 'session-exited-123'
    const compositeKey = makeSessionKey(provider, sessionId)

    // Seed a terminal and associate it with a coding CLI session
    await terminalMetadata.seedFromTerminal({
      terminalId,
      mode: 'claude',
      cwd: '/tmp/project',
    })
    terminalMetadata.associateSession(terminalId, provider, sessionId)

    // Simulate terminal process exit: retire instead of remove
    terminalMetadata.retire(terminalId)

    // Verify metadata is retired (not in list, but accessible via get)
    expect(terminalMetadata.list().find((m) => m.terminalId === terminalId)).toBeUndefined()
    expect(terminalMetadata.get(terminalId)?.provider).toBe(provider)

    // PATCH terminal with a new title — same scope rule as a live pane
    const res = await request(app)
      .patch(`/api/terminals/${terminalId}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'Renamed After Exit' })
      .expect(200)

    expect(res.body.titleOverride).toBe('Renamed After Exit')

    // A stopped pane with a retained sessionRef follows the same scope rule:
    // no durable session override may be written.
    expect(await configStore.getSessionOverride(compositeKey)).toBeUndefined()
  })

  // ────────────────────────────────────────────
  // Test 3: Session rename cascades to terminal
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

  // ────────────────────────────────────────────────────────────
  // Test 4: Clearing an explicit session rename removes title and source
  // ────────────────────────────────────────────────────────────
  it('clearing an explicit session rename removes title and source', async () => {
    const provider: CodingCliProviderName = 'claude'
    const sessionId = 'session-clear-789'
    const compositeKey = makeSessionKey(provider, sessionId)

    // Explicit durable session rename writes the 'user' rung.
    const setRes = await request(app)
      .patch(`/api/sessions/${compositeKey}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'Kept' })
      .expect(200)
    expect(setRes.body.titleOverride).toBe('Kept')

    const stored = await configStore.getSessionOverride(compositeKey)
    expect(stored?.titleOverride).toBe('Kept')
    expect(stored?.titleSource).toBe('user')

    // An explicit null clear must remove title AND source — otherwise the
    // leftover titleSource:'user' rung permanently freezes the title-source
    // ladder (provider/auto titles can never land again).
    await request(app)
      .patch(`/api/sessions/${compositeKey}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: null })
      .expect(200)

    // Assert on the RAW config row (Object.keys, not just undefined values):
    // neither key may be present at all.
    const raw = JSON.parse(await fsp.readFile(path.join(tempDir, '.freshell', 'config.json'), 'utf8'))
    const row = raw.sessionOverrides?.[compositeKey]
    expect(row).toBeDefined()
    expect(Object.keys(row)).not.toContain('titleOverride')
    expect(Object.keys(row)).not.toContain('titleSource')
  })

  // ────────────────────────────────────────────────────────────
  // Test 5: An archive-only session PATCH preserves an existing title override
  // ────────────────────────────────────────────────────────────
  it('an archive-only session PATCH preserves an existing title override', async () => {
    const provider: CodingCliProviderName = 'claude'
    const sessionId = 'session-archive-keep'
    const compositeKey = makeSessionKey(provider, sessionId)

    // Explicit durable session rename writes the 'user' rung.
    await request(app)
      .patch(`/api/sessions/${compositeKey}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'Kept' })
      .expect(200)

    // An archive-only patch never mentions the title: the absent titleOverride
    // key must leave the existing override (and its source rung) untouched.
    await request(app)
      .patch(`/api/sessions/${compositeKey}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ archived: true })
      .expect(200)

    const stored = await configStore.getSessionOverride(compositeKey)
    expect(stored?.titleOverride).toBe('Kept')
    expect(stored?.titleSource).toBe('user')
    expect(stored?.archived).toBe(true)
  })

  // ────────────────────────────────────────────────────────────
  // Test 6: A whitespace-only session title clears titleOverride AND titleSource
  // ────────────────────────────────────────────────────────────
  it('a whitespace-only session title clears titleOverride AND titleSource', async () => {
    const provider: CodingCliProviderName = 'claude'
    const sessionId = 'session-whitespace-clear'
    const compositeKey = makeSessionKey(provider, sessionId)

    await request(app)
      .patch(`/api/sessions/${compositeKey}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'Kept' })
      .expect(200)

    const stored = await configStore.getSessionOverride(compositeKey)
    expect(stored?.titleOverride).toBe('Kept')
    expect(stored?.titleSource).toBe('user')

    // A whitespace-only title is a clear: like an explicit null clear, it must
    // remove BOTH keys — a leftover titleSource:'user' rung permanently freezes
    // the title-source ladder (provider/auto titles can never land again).
    await request(app)
      .patch(`/api/sessions/${compositeKey}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: '   ' })
      .expect(200)

    // Assert on the RAW config row (Object.keys, not just undefined values):
    // neither key may be present at all.
    const raw = JSON.parse(await fsp.readFile(path.join(tempDir, '.freshell', 'config.json'), 'utf8'))
    const row = raw.sessionOverrides?.[compositeKey]
    expect(row).toBeDefined()
    expect(Object.keys(row)).not.toContain('titleOverride')
    expect(Object.keys(row)).not.toContain('titleSource')
  })

  // ────────────────────────────────────────────────────────────
  // Test 7: A title-only session PATCH preserves stored archived:true
  // ────────────────────────────────────────────────────────────
  it('a title-only session PATCH preserves stored archived:true', async () => {
    const provider: CodingCliProviderName = 'claude'
    const sessionId = 'session-title-keeps-archive'
    const compositeKey = makeSessionKey(provider, sessionId)

    // Seed an archive flag directly (the state a sidebar "Archive" action leaves).
    await configStore.patchSessionOverride(compositeKey, { archived: true })

    // A title-only patch never mentions `archived`: the absent key must leave
    // the stored value untouched. ConfigStore merges {...existing, ...patch}
    // and the JSON save drops keys spread as undefined, so an unconditional
    // `archived` spread in the route would erase it.
    await request(app)
      .patch(`/api/sessions/${compositeKey}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'New Name' })
      .expect(200)

    const stored = await configStore.getSessionOverride(compositeKey)
    expect(stored?.archived).toBe(true)
    expect(stored?.titleOverride).toBe('New Name')
    expect(stored?.titleSource).toBe('user')
  })

  // ────────────────────────────────────────────────────────────
  // Test 8: A title-only session PATCH does not resurrect deleted:true
  // ────────────────────────────────────────────────────────────
  it('a title-only session PATCH does not resurrect deleted:true', async () => {
    const provider: CodingCliProviderName = 'claude'
    const sessionId = 'session-title-keeps-delete'
    const compositeKey = makeSessionKey(provider, sessionId)

    // Seed a soft delete (the state the DELETE endpoint leaves).
    await configStore.patchSessionOverride(compositeKey, { deleted: true })

    // A title-only patch never mentions `deleted`: spreading it as undefined
    // would drop the key on save and resurrect the session in listings.
    await request(app)
      .patch(`/api/sessions/${compositeKey}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'X' })
      .expect(200)

    const stored = await configStore.getSessionOverride(compositeKey)
    expect(stored?.deleted).toBe(true)
    expect(stored?.titleOverride).toBe('X')
    expect(stored?.titleSource).toBe('user')
  })
})

// ────────────────────────────────────────────────────────────────
// Minimal Express app that mirrors the production PATCH routes
// from server/terminals-router.ts and server/sessions-router.ts,
// using inlined session→terminal mirror logic so all operations
// flow through the same ConfigStore instance.
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

  // PATCH /api/terminals/:terminalId  (mirrors server/terminals-router.ts)
  app.patch('/api/terminals/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    const { titleOverride, descriptionOverride, deleted } = req.body || {}

    const next = await configStore.patchTerminalOverride(terminalId, {
      titleOverride,
      descriptionOverride,
      deleted,
    })

    // b5fb scope contract: terminal scope only — no session cascade.

    res.json(next)
  })

  // PATCH /api/sessions/:sessionId  (mirrors server/sessions-router.ts)
  app.patch('/api/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)

    const { titleOverride, summaryOverride, deleted, archived, createdAtOverride } = req.body || {}
    const clean = (v: unknown) => (typeof v === 'string' ? v.trim() || undefined : undefined)
    // Mirror production: every field is key-presence guarded — an absent key
    // leaves the stored value untouched instead of spreading undefined over it.
    const touched = (key: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, key)
    const next = await configStore.patchSessionOverride(compositeKey, {
      ...(touched('titleOverride')
        ? {
            titleOverride: clean(titleOverride),
            titleSource: clean(titleOverride) ? ('user' as const) : undefined,
          }
        : {}),
      ...(touched('summaryOverride') ? { summaryOverride: clean(summaryOverride) } : {}),
      ...(touched('deleted') ? { deleted } : {}),
      ...(touched('archived') ? { archived } : {}),
      ...(touched('createdAtOverride') ? { createdAtOverride } : {}),
    })

    // session→terminal cascade (unchanged, inlined from cascadeSessionRenameToTerminal)
    const cleanTitle = typeof titleOverride === 'string' ? titleOverride.trim() || undefined : undefined
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
