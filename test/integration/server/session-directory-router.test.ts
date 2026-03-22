// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import express, { type Express } from 'express'
import request from 'supertest'
import { createSessionsRouter } from '../../../server/sessions-router.js'
import { claudeProvider } from '../../../server/coding-cli/providers/claude.js'
import { KimiProvider } from '../../../server/coding-cli/providers/kimi.js'
import { makeSessionKey, type ProjectGroup } from '../../../server/coding-cli/types.js'

const TEST_AUTH_TOKEN = 'test-auth-token'
const kimiFixtureShareDir = path.join(
  process.cwd(),
  'test',
  'fixtures',
  'coding-cli',
  'kimi',
  'share-dir',
)
const kimiFixtureSessionFile = path.join(
  kimiFixtureShareDir,
  'sessions',
  '4a3dcd71f4774356bb688dad99173808',
  'kimi-session-1',
  'context.jsonl',
)

describe('GET /api/session-directory', () => {
  let app: Express
  let patchSessionOverride: ReturnType<typeof vi.fn>
  let deleteSession: ReturnType<typeof vi.fn>

  const projects: ProjectGroup[] = [
    {
      projectPath: '/repo/alpha',
      sessions: [
        {
          provider: 'claude',
          sessionId: 'session-1',
          projectPath: '/repo/alpha',
          lastActivityAt: 100,
          title: 'Alpha deploy',
          firstUserMessage: 'deploy alpha',
        },
        {
          provider: 'claude',
          sessionId: 'session-2',
          projectPath: '/repo/alpha',
          lastActivityAt: 50,
          title: 'Routine cleanup',
        },
      ],
    },
  ]

  beforeEach(() => {
    patchSessionOverride = vi.fn().mockResolvedValue({ ok: true })
    deleteSession = vi.fn().mockResolvedValue(undefined)

    app = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })

    app.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride,
        deleteSession,
      },
      codingCliIndexer: {
        getProjects: () => projects,
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: {
        list: () => [],
      },
    }))
  })

  it('serves session windows from /api/session-directory', async () => {
    const res = await request(app)
      .get('/api/session-directory?priority=visible&limit=1')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items.map((item: { sessionId: string }) => item.sessionId)).toEqual(['session-1'])
    expect(res.body.items[0].lastActivityAt).toBe(100)
    expect(res.body.nextCursor).toBeTruthy()
    expect(typeof res.body.revision).toBe('number')
  })

  it('searches through the same route family', async () => {
    const res = await request(app)
      .get('/api/session-directory?priority=visible&query=deploy')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].sessionId).toBe('session-1')
    expect(res.body.items[0].lastActivityAt).toBe(100)
  })

  it('removes legacy read-model routes', async () => {
    const search = await request(app)
      .get('/api/sessions/search?q=deploy')
      .set('x-auth-token', TEST_AUTH_TOKEN)
    const query = await request(app)
      .post('/api/sessions/query')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ priority: 'visible' })

    expect(search.status).toBe(404)
    expect(query.status).toBe(404)
  })

  it('keeps mutation routes separate', async () => {
    const patch = await request(app)
      .patch('/api/sessions/session-1?provider=claude')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'Renamed session' })
    const remove = await request(app)
      .delete('/api/sessions/session-1?provider=claude')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(patch.status).toBe(200)
    expect(remove.status).toBe(200)
    expect(patchSessionOverride).toHaveBeenCalled()
    expect(deleteSession).toHaveBeenCalled()
  })

  it('broadcasts terminals.changed when a session rename cascades to a terminal title', async () => {
    const broadcastTerminalsChanged = vi.fn()
    const updateTitle = vi.fn()

    app = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })

    app.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride,
        deleteSession,
      },
      codingCliIndexer: {
        getProjects: () => projects,
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: {
        list: () => [{ terminalId: 'term-1', provider: 'claude', sessionId: 'session-1' }],
      },
      registry: {
        updateTitle,
      },
      wsHandler: {
        broadcastTerminalsChanged,
      } as any,
    }))

    const patch = await request(app)
      .patch('/api/sessions/session-1?provider=claude')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'Renamed session' })

    expect(patch.status).toBe(200)
    expect(updateTitle).toHaveBeenCalledWith('term-1', 'Renamed session')
    expect(broadcastTerminalsChanged).toHaveBeenCalledOnce()
  })

  it('does not clobber existing overrides when archiving', async () => {
    const patch = await request(app)
      .patch('/api/sessions/session-1?provider=claude')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ archived: true })

    expect(patch.status).toBe(200)
    // The patch sent to configStore must NOT contain titleOverride/summaryOverride
    // keys — spreading { titleOverride: undefined } over an existing override
    // erases a previously-set friendly name.
    const call = patchSessionOverride.mock.calls[0]
    const patchArg = call[1]
    expect(patchArg).not.toHaveProperty('titleOverride')
    expect(patchArg).not.toHaveProperty('summaryOverride')
    expect(patchArg).not.toHaveProperty('deleted')
    expect(patchArg).not.toHaveProperty('createdAtOverride')
    expect(patchArg).toEqual({ archived: true })
  })

  it('forwards the tier query parameter to the session-directory service', async () => {
    const res = await request(app)
      .get('/api/session-directory?priority=visible&query=deploy&tier=userMessages')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    // Should succeed (200) even with no file-based results since sessions lack sourceFile
    expect(res.status).toBe(200)
  })

  it('defaults to title tier when tier parameter is omitted', async () => {
    const res = await request(app)
      .get('/api/session-directory?priority=visible&query=deploy')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    // Should match on title metadata (existing behavior)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].sessionId).toBe('session-1')
  })

  it('rejects unknown tier values with 400', async () => {
    const res = await request(app)
      .get('/api/session-directory?priority=visible&tier=bogus')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
  })

  it('routes directory reads through the requested visible-first lane', async () => {
    const schedule = vi.fn(async ({ lane, signal, run }: { lane: string; signal: AbortSignal; run: (signal: AbortSignal) => Promise<unknown> }) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return run(signal)
    })

    app = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })
    app.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride,
        deleteSession,
      },
      codingCliIndexer: {
        getProjects: () => projects,
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: {
        list: () => [],
      },
      readModelScheduler: { schedule },
    }))

    const response = await request(app)
      .get('/api/session-directory?priority=background&limit=1')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(response.status).toBe(200)
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({
      lane: 'background',
      signal: expect.any(AbortSignal),
      run: expect.any(Function),
    }))
  })
})

describe('search tiers through the HTTP route (full round-trip)', () => {
  let app: Express
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'router-search-'))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  function createAppWithProjects(projects: ProjectGroup[], codingCliProviders = [claudeProvider]) {
    app = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })
    app.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride: vi.fn().mockResolvedValue({ ok: true }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      },
      codingCliIndexer: {
        getProjects: () => projects,
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders,
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: {
        list: () => [],
      },
    }))
  }

  it('title tier searches metadata only', async () => {
    createAppWithProjects([{
      projectPath: '/repo',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 100,
        title: 'Deploy the service',
      }],
    }])

    const res = await request(app)
      .get('/api/session-directory?priority=visible&query=deploy&tier=title')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].matchedIn).toBe('title')
  })

  it('userMessages tier searches JSONL user messages', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the authentication bug"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working on login"}]}}',
    ].join('\n'))

    createAppWithProjects([{
      projectPath: '/repo',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 100,
        title: 'Session one',
        sourceFile: sessionFile,
      }],
    }])

    const res = await request(app)
      .get('/api/session-directory?priority=visible&query=authentication&tier=userMessages')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].matchedIn).toBe('userMessage')
  })

  it('passes providers to querySessionDirectory for file-based search', async () => {
    const sessionFile = path.join(tempDir, 'session-provider-test.jsonl')
    await fsp.writeFile(sessionFile, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"provider wiring test"}]}}',
    ].join('\n'))

    // Create app with a scheduler spy that captures the run callback args
    const runArgs: any[] = []
    const schedule = vi.fn(async ({ signal, run }: { lane: string; signal: AbortSignal; run: (signal: AbortSignal) => Promise<unknown> }) => {
      return run(signal)
    })

    const testApp = express()
    testApp.use(express.json())
    testApp.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })
    testApp.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride: vi.fn().mockResolvedValue({ ok: true }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      },
      codingCliIndexer: {
        getProjects: () => [{
          projectPath: '/repo',
          sessions: [{
            provider: 'claude',
            sessionId: 'session-provider-test',
            projectPath: '/repo',
            lastActivityAt: 100,
            title: 'Provider test',
            sourceFile: sessionFile,
          }],
        }],
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [claudeProvider],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: { list: () => [] },
      readModelScheduler: { schedule },
    }))

    const res = await request(testApp)
      .get('/api/session-directory?priority=visible&query=provider+wiring&tier=userMessages')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    // The file-based search found the match -- this proves providers were passed through
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].matchedIn).toBe('userMessage')
  })

  it('fullText tier finds assistant message matches', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The secret_keyword is here"}]}}',
    ].join('\n'))

    createAppWithProjects([{
      projectPath: '/repo',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 100,
        title: 'Session one',
        sourceFile: sessionFile,
      }],
    }])

    const res = await request(app)
      .get('/api/session-directory?priority=visible&query=secret_keyword&tier=fullText')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].matchedIn).toBe('assistantMessage')
  })

  it('searches Kimi transcripts through the HTTP route while honoring metadata-backed title and archive state', async () => {
    const kimiProvider = new KimiProvider(kimiFixtureShareDir)

    createAppWithProjects([{
      projectPath: '/repo/root',
      sessions: [{
        provider: 'kimi',
        sessionId: 'kimi-session-1',
        projectPath: '/repo/root',
        lastActivityAt: 100,
        title: 'Pinned title from metadata',
        archived: true,
        sourceFile: kimiFixtureSessionFile,
      }],
    }], [kimiProvider])

    const userRes = await request(app)
      .get('/api/session-directory?priority=visible&query=visible-user-token-kimi&tier=userMessages')
      .set('x-auth-token', TEST_AUTH_TOKEN)
    expect(userRes.status).toBe(200)
    expect(userRes.body.items).toHaveLength(1)
    expect(userRes.body.items[0]).toMatchObject({
      sessionId: 'kimi-session-1',
      title: 'Pinned title from metadata',
      archived: true,
      matchedIn: 'userMessage',
    })

    const assistantRes = await request(app)
      .get('/api/session-directory?priority=visible&query=visible-assistant-token-kimi&tier=fullText')
      .set('x-auth-token', TEST_AUTH_TOKEN)
    expect(assistantRes.status).toBe(200)
    expect(assistantRes.body.items).toHaveLength(1)
    expect(assistantRes.body.items[0].matchedIn).toBe('assistantMessage')

    const hiddenRes = await request(app)
      .get('/api/session-directory?priority=visible&query=hidden-system-token-kimi&tier=fullText')
      .set('x-auth-token', TEST_AUTH_TOKEN)
    expect(hiddenRes.status).toBe(200)
    expect(hiddenRes.body.items).toHaveLength(0)
  })

  it('keeps duplicate Kimi session ids distinct by cwd through the HTTP search route', async () => {
    const appASessionFile = path.join(tempDir, 'kimi-app-a-context.jsonl')
    const appBSessionFile = path.join(tempDir, 'kimi-app-b-context.jsonl')
    await fsp.writeFile(appASessionFile, [
      '{"role":"user","content":"router-shared-kimi-token-app-a"}',
      '{"role":"assistant","content":[{"type":"text","text":"response-a"}]}',
    ].join('\n'))
    await fsp.writeFile(appBSessionFile, [
      '{"role":"user","content":"router-shared-kimi-token-app-b"}',
      '{"role":"assistant","content":[{"type":"text","text":"response-b"}]}',
    ].join('\n'))

    const kimiProvider = new KimiProvider(kimiFixtureShareDir)
    createAppWithProjects([{
      projectPath: '/repo/root',
      sessions: [
        {
          provider: 'kimi',
          sessionId: 'shared-kimi-session',
          projectPath: '/repo/root',
          lastActivityAt: 100,
          cwd: '/repo/root/packages/app-a',
          title: 'Kimi app A',
          sourceFile: appASessionFile,
        },
        {
          provider: 'kimi',
          sessionId: 'shared-kimi-session',
          projectPath: '/repo/root',
          lastActivityAt: 90,
          cwd: '/repo/root/packages/app-b',
          title: 'Kimi app B',
          sourceFile: appBSessionFile,
        },
      ],
    }], [kimiProvider])

    const res = await request(app)
      .get('/api/session-directory?priority=visible&query=router-shared-kimi-token-app-a&tier=userMessages')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0]).toMatchObject({
      provider: 'kimi',
      sessionId: 'shared-kimi-session',
      cwd: '/repo/root/packages/app-a',
      matchedIn: 'userMessage',
    })
  })

  it('routes duplicate Kimi mutations through the opaque cwd-scoped session key', async () => {
    const updateTitle = vi.fn()
    const localPatchSessionOverride = vi.fn().mockResolvedValue({ ok: true })
    const localDeleteSession = vi.fn().mockResolvedValue(undefined)
    const kimiAppAKey = makeSessionKey('kimi', 'shared-kimi-session', '/repo/root/packages/app-a')
    const kimiAppBKey = makeSessionKey('kimi', 'shared-kimi-session', '/repo/root/packages/app-b')

    app = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })
    app.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride: localPatchSessionOverride,
        deleteSession: localDeleteSession,
      },
      codingCliIndexer: {
        getProjects: () => [],
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: {
        list: () => [
          {
            terminalId: 'term-kimi-a',
            provider: 'kimi',
            sessionId: 'shared-kimi-session',
            cwd: '/repo/root/packages/app-a',
            updatedAt: 100,
          },
          {
            terminalId: 'term-kimi-b',
            provider: 'kimi',
            sessionId: 'shared-kimi-session',
            cwd: '/repo/root/packages/app-b',
            updatedAt: 90,
          },
        ],
      },
      registry: {
        updateTitle,
      },
      wsHandler: {
        broadcastTerminalsChanged: vi.fn(),
      } as any,
    }))

    const patch = await request(app)
      .patch(`/api/sessions/${encodeURIComponent(kimiAppBKey)}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'Renamed Kimi app B' })

    expect(patch.status).toBe(200)
    expect(localPatchSessionOverride).toHaveBeenCalledWith(kimiAppBKey, expect.objectContaining({
      titleOverride: 'Renamed Kimi app B',
      titleSource: 'user',
    }))
    expect(updateTitle).toHaveBeenCalledWith('term-kimi-b', 'Renamed Kimi app B')

    const remove = await request(app)
      .delete(`/api/sessions/${encodeURIComponent(kimiAppAKey)}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(remove.status).toBe(200)
    expect(localDeleteSession).toHaveBeenCalledWith(kimiAppAKey)
  })

  it('rejects unscoped Kimi mutation routes instead of falling back to legacy keys', async () => {
    const localPatchSessionOverride = vi.fn().mockResolvedValue({ ok: true })
    const localDeleteSession = vi.fn().mockResolvedValue(undefined)
    const refresh = vi.fn().mockResolvedValue(undefined)

    app = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })
    app.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride: localPatchSessionOverride,
        deleteSession: localDeleteSession,
      },
      codingCliIndexer: {
        getProjects: () => [],
        refresh,
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: {
        list: () => [],
      },
    }))

    const patch = await request(app)
      .patch('/api/sessions/shared-kimi-session?provider=kimi')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ titleOverride: 'Should fail closed' })

    const generateTitle = await request(app)
      .post(`/api/sessions/${encodeURIComponent('kimi:shared-kimi-session')}/generate-title?provider=kimi`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ firstMessage: 'name this session' })

    const remove = await request(app)
      .delete('/api/sessions/shared-kimi-session?provider=kimi')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(patch.status).toBe(400)
    expect(generateTitle.status).toBe(400)
    expect(remove.status).toBe(400)
    expect(localPatchSessionOverride).not.toHaveBeenCalled()
    expect(localDeleteSession).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('treats colon-bearing Kimi session ids as opaque ids when cwd is provided', async () => {
    const localPatchSessionOverride = vi.fn().mockResolvedValue({ ok: true })
    const localDeleteSession = vi.fn().mockResolvedValue(undefined)
    const refresh = vi.fn().mockResolvedValue(undefined)
    const teamAlphaKey = makeSessionKey('kimi', 'team:alpha', '/repo/root/packages/app-b')

    app = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })
    app.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride: localPatchSessionOverride,
        deleteSession: localDeleteSession,
      },
      codingCliIndexer: {
        getProjects: () => [],
        refresh,
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: {
        list: () => [],
      },
    }))

    const patch = await request(app)
      .patch(`/api/sessions/${encodeURIComponent('team:alpha')}?provider=kimi&cwd=${encodeURIComponent('/repo/root/packages/app-b')}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ archived: true })

    const remove = await request(app)
      .delete(`/api/sessions/${encodeURIComponent('team:alpha')}?provider=kimi&cwd=${encodeURIComponent('/repo/root/packages/app-b')}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(patch.status).toBe(200)
    expect(remove.status).toBe(200)
    expect(localPatchSessionOverride).toHaveBeenCalledWith(teamAlphaKey, { archived: true })
    expect(localDeleteSession).toHaveBeenCalledWith(teamAlphaKey)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
