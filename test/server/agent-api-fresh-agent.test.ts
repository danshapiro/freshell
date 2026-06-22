// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router.js'
import { LayoutStore } from '../../server/agent-api/layout-store.js'
import { FreshAgentLostSessionError } from '../../server/fresh-agent/runtime-manager.js'

function makeApp(overrides: { freshAgentRuntimeManager?: any } = {}) {
  const layoutStore = new LayoutStore()
  const wsHandler = { broadcastUiCommand: vi.fn(), broadcast: vi.fn() }
  const freshAgentRuntimeManager = overrides.freshAgentRuntimeManager ?? {
    create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode', sessionRef: { provider: 'opencode', sessionId: 'freshopencode-abc' } })),
    send: vi.fn(async () => undefined),
    attach: vi.fn(async () => ({ sessionId: 'ses_real_1' })),
    getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [] })),
    getTurnPage: vi.fn(async () => ({ revision: 1, nextCursor: null, turns: [], bodies: {} })),
  }
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore, registry: { get: vi.fn(), create: vi.fn() }, wsHandler, freshAgentRuntimeManager,
  }))
  return { app, layoutStore, wsHandler, freshAgentRuntimeManager }
}

describe('agent-api fresh-agent: create', () => {
  it('POST /tabs with agent=opencode creates a fresh-agent pane and returns the sessionId', async () => {
    const { app, freshAgentRuntimeManager, wsHandler, layoutStore } = makeApp()
    const res = await request(app).post('/api/tabs').send({ agent: 'opencode', cwd: '/repo', model: 'umans-ai-coding-plan/umans-kimi-k2.7', effort: 'high' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sessionId: 'freshopencode-abc', sessionRef: { provider: 'opencode', sessionId: 'freshopencode-abc' } })
    expect(res.body.data.paneId).toEqual(expect.any(String))
    expect(freshAgentRuntimeManager.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo', model: 'umans-ai-coding-plan/umans-kimi-k2.7', effort: 'high', requestId: expect.any(String),
    }))
    const snap = layoutStore.getPaneSnapshot(res.body.data.paneId)
    expect(snap?.kind).toBe('fresh-agent')
    expect(wsHandler.broadcastUiCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'tab.create' }))
  })

  it('POST /panes/:id/split with agent=opencode creates a fresh-agent pane beside an existing one', async () => {
    const { app } = makeApp()
    const tab = await request(app).post('/api/tabs').send({ mode: 'shell' }).catch(() => null)
    // Seed a base pane via the fresh-agent create (no terminal registry needed)
    const base = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const res = await request(app).post(`/api/panes/${base.body.data.paneId}/split`).send({ agent: 'opencode' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sessionId: expect.any(String), paneId: expect.any(String) })
    void tab
  })

  it('POST /tabs with an unknown agent returns 400', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/tabs').send({ agent: 'bogus' })
    expect(res.status).toBe(400)
  })

  it('POST /tabs with agent but no runtime manager returns 503', async () => {
    const layoutStore = new LayoutStore()
    const app = express(); app.use(express.json())
    app.use('/api', createAgentApiRouter({ layoutStore, registry: {}, wsHandler: { broadcastUiCommand: vi.fn() } }))
    const res = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    expect(res.status).toBe(503)
  })

  it('rolls back the allocated tab when runtime creation fails', async () => {
    const freshAgentRuntimeManager = {
      create: vi.fn(async () => { throw new Error('sidecar failed to start') }),
      send: vi.fn(async () => undefined),
      attach: vi.fn(async () => ({ sessionId: 'ses_real_1' })),
      getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [] })),
    }
    const { app, layoutStore } = makeApp({ freshAgentRuntimeManager })
    const tabsBefore = layoutStore.getNormalizedSnapshot().tabs.length
    const res = await request(app).post('/api/tabs').send({ agent: 'opencode', cwd: '/repo' })
    expect(res.status).toBe(500)
    expect(layoutStore.getNormalizedSnapshot().tabs.length).toBe(tabsBefore)
  })

  it('rolls back the allocated split pane when runtime creation fails', async () => {
    const freshAgentRuntimeManager = {
      create: vi.fn(async () => { throw new Error('sidecar failed to start') }),
      send: vi.fn(async () => undefined),
      attach: vi.fn(async () => ({ sessionId: 'ses_real_1' })),
      getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [] })),
    }
    const { app, layoutStore } = makeApp({ freshAgentRuntimeManager })
    const { paneId: basePaneId } = layoutStore.createTab({ title: 'base' })
    const panesBefore = layoutStore.listPanes().length
    const res = await request(app).post(`/api/panes/${basePaneId}/split`).send({ agent: 'opencode' })
    expect(res.status).toBe(500)
    expect(layoutStore.listPanes().length).toBe(panesBefore)
  })

  it('rolls back a fresh-agent split without corrupting existing neighbor panes', async () => {
    const freshAgentRuntimeManager = {
      create: vi.fn(async () => { throw new Error('sidecar failed to start') }),
      send: vi.fn(async () => undefined),
      attach: vi.fn(async () => ({ sessionId: 'ses_real_1' })),
      getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [] })),
    }
    const { app, layoutStore } = makeApp({ freshAgentRuntimeManager })
    const { paneId: basePaneId } = layoutStore.createTab({ title: 'base' })
    // Create an existing neighbor so a naive closePane rollback would rebuild the grid.
    const neighbor = layoutStore.splitPane({ paneId: basePaneId, direction: 'horizontal' })
    const before = layoutStore.getNormalizedSnapshot()
    const res = await request(app).post(`/api/panes/${neighbor.newPaneId}/split`).send({ agent: 'opencode' })
    expect(res.status).toBe(500)
    expect(layoutStore.getNormalizedSnapshot()).toEqual(before)
  })
})

describe('agent-api fresh-agent: send-keys', () => {
  it('routes send-keys to the runtime manager for a fresh-agent pane and blocks until the turn returns', async () => {
    const freshAgentRuntimeManager = {
      create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode', sessionRef: { provider: 'opencode', sessionId: 'freshopencode-abc' } })),
      send: vi.fn(async () => ({ submittedTurnId: 'display-user-1' })),
      attach: vi.fn(async () => ({ sessionId: 'ses_real_1' })),
      getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [] })),
    }
    const { app } = makeApp({ freshAgentRuntimeManager })
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const paneId = created.body.data.paneId
    const res = await request(app).post(`/api/panes/${paneId}/send-keys`).send({ data: 'Reply with: ok' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sessionId: 'freshopencode-abc', submittedTurnId: 'display-user-1' })
    expect(freshAgentRuntimeManager.send).toHaveBeenCalledWith(
      { sessionId: 'freshopencode-abc', sessionType: 'freshopencode', provider: 'opencode' },
      { text: 'Reply with: ok' },
    )
  })

  it('passes the pane cwd back to the runtime when sending to a fresh-agent pane', async () => {
    const freshAgentRuntimeManager = {
      create: vi.fn(async () => ({
        sessionId: 'codex-thread-cwd',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-cwd' },
      })),
      send: vi.fn(async () => undefined),
      attach: vi.fn(async () => ({ sessionId: 'codex-thread-cwd' })),
      getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [] })),
    }
    const { app } = makeApp({ freshAgentRuntimeManager })
    const created = await request(app).post('/api/tabs').send({ agent: 'codex', cwd: '/repo/persisted-worktree' })
    const paneId = created.body.data.paneId

    const res = await request(app).post(`/api/panes/${paneId}/send-keys`).send({ data: 'Check cwd' })

    expect(res.status).toBe(200)
    expect(freshAgentRuntimeManager.send).toHaveBeenCalledWith(
      { sessionId: 'codex-thread-cwd', sessionType: 'freshcodex', provider: 'codex', cwd: '/repo/persisted-worktree' },
      { text: 'Check cwd', settings: { cwd: '/repo/persisted-worktree' } },
    )
    expect(freshAgentRuntimeManager.getSnapshot).toHaveBeenCalledWith({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'codex-thread-cwd',
      cwd: '/repo/persisted-worktree',
    })
  })

  it('attaches on a lost session before retrying send (cross-process orchestration)', async () => {
    const send = vi.fn().mockRejectedValueOnce(new FreshAgentLostSessionError('not tracked')).mockResolvedValueOnce({ sessionId: 'ses_real_1' })
    const attach = vi.fn(async () => ({ sessionId: 'ses_real_1' }))
    const { app } = makeApp({ freshAgentRuntimeManager: {
      create: vi.fn(async () => ({ sessionId: 'ses_real_1', sessionType: 'freshopencode', runtimeProvider: 'opencode' })),
      send, attach,       getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [] })),
    } })
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const res = await request(app).post(`/api/panes/${created.body.data.paneId}/send-keys`).send({ data: 'hi' })
    expect(res.status).toBe(200)
    expect(attach).toHaveBeenCalledWith({ sessionId: 'ses_real_1', sessionType: 'freshopencode', provider: 'opencode' })
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('agent-api fresh-agent: capture', () => {
  it('renders the transcript text for a fresh-agent pane', async () => {
    const getSnapshot = vi.fn(async () => ({
      status: 'idle',
      turns: [],
    }))
    const getTurnPage = vi.fn(async () => ({
      revision: 10,
      nextCursor: null,
      turns: [
        { role: 'user', summary: 'Reply with: ok', items: [{ kind: 'text', text: 'Reply with: ok' }] },
        { role: 'assistant', summary: 'ok', items: [{ kind: 'text', text: 'ok' }] },
      ],
      bodies: {},
    }))
    const { app } = makeApp({ freshAgentRuntimeManager: {
      create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode' })),
      send: vi.fn(), attach: vi.fn(), getSnapshot, getTurnPage,
    } })
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const res = await request(app).get(`/api/panes/${created.body.data.paneId}/capture`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('user: Reply with: ok')
    expect(res.text).toContain('assistant: ok')
    expect(getSnapshot).not.toHaveBeenCalled()
    expect(getTurnPage).toHaveBeenCalledWith({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-abc',
      limit: 200,
      includeBodies: true,
      priority: 'visible',
    })
  })

  it('walks all fresh-agent transcript pages before rendering capture text', async () => {
    const getTurnPage = vi.fn()
      .mockResolvedValueOnce({
        revision: 10,
        nextCursor: 'older-page',
        turns: [
          { role: 'user', summary: 'Middle request', items: [{ kind: 'text', text: 'Middle request' }] },
          { role: 'assistant', summary: 'Newest answer', items: [{ kind: 'text', text: 'Newest answer' }] },
        ],
        bodies: {},
      })
      .mockResolvedValueOnce({
        revision: 10,
        nextCursor: null,
        turns: [
          { role: 'assistant', summary: 'Oldest answer', items: [{ kind: 'text', text: 'Oldest answer' }] },
        ],
        bodies: {},
      })
    const { app } = makeApp({ freshAgentRuntimeManager: {
      create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode' })),
      send: vi.fn(),
      attach: vi.fn(),
      getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [] })),
      getTurnPage,
    } })
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const res = await request(app).get(`/api/panes/${created.body.data.paneId}/capture`)

    expect(res.status).toBe(200)
    expect(res.text.indexOf('assistant: Oldest answer')).toBeLessThan(res.text.indexOf('user: Middle request'))
    expect(res.text.indexOf('user: Middle request')).toBeLessThan(res.text.indexOf('assistant: Newest answer'))
    expect(getTurnPage).toHaveBeenNthCalledWith(1, {
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-abc',
      limit: 200,
      includeBodies: true,
      priority: 'visible',
    })
    expect(getTurnPage).toHaveBeenNthCalledWith(2, {
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-abc',
      cursor: 'older-page',
      revision: 10,
      limit: 200,
      includeBodies: true,
      priority: 'visible',
    })
  })

  it('returns a clear error when the canonical transcript pager is unavailable', async () => {
    const { app } = makeApp({ freshAgentRuntimeManager: {
      create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode' })),
      send: vi.fn(),
      attach: vi.fn(),
      getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [{ role: 'assistant', items: [{ kind: 'text', text: 'old path' }] }] })),
    } })
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const res = await request(app).get(`/api/panes/${created.body.data.paneId}/capture`)

    expect(res.status).toBe(503)
    expect(res.body.message).toContain('fresh-agent transcript paging not available')
  })
})

describe('agent-api fresh-agent: wait-for', () => {
  it('resolves matched when the fresh-agent snapshot reports idle', async () => {
    const getSnapshot = vi.fn(async () => ({ status: 'idle', turns: [] }))
    const { app } = makeApp({ freshAgentRuntimeManager: {
      create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode' })),
      send: vi.fn(), attach: vi.fn(), getSnapshot,
    } })
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const res = await request(app).get(`/api/panes/${created.body.data.paneId}/wait-for?timeout=2`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ matched: true, reason: 'idle' })
  })

  it('surfaces a lost session error instead of timing out', async () => {
    const { FreshAgentLostSessionError } = await import('../../server/fresh-agent/runtime-manager.js')
    const { app } = makeApp({ freshAgentRuntimeManager: {
      create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode' })),
      send: vi.fn(), attach: vi.fn(),
      getSnapshot: vi.fn(async () => { throw new FreshAgentLostSessionError('session gone') }),
    } })
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const res = await request(app).get(`/api/panes/${created.body.data.paneId}/wait-for?timeout=1`)
    expect(res.status).toBe(404)
  })
})

describe('agent-api fresh-agent: materialization', () => {
  it('persists a materialized OpenCode session into the pane and broadcasts it', async () => {
    const freshAgentRuntimeManager = {
      create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode' })),
      send: vi.fn(async () => ({ sessionId: 'ses_real_1', sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' } })),
      attach: vi.fn(),
      getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [] })),
    }
    const { app, layoutStore, wsHandler } = makeApp({ freshAgentRuntimeManager })
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const paneId = created.body.data.paneId
    const res = await request(app).post(`/api/panes/${paneId}/send-keys`).send({ data: 'ok' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sessionId: 'ses_real_1', sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' } })
    const snap = layoutStore.getPaneSnapshot(paneId)
    expect(snap?.paneContent?.sessionId).toBe('ses_real_1')
    expect(snap?.paneContent?.sessionRef).toEqual({ provider: 'opencode', sessionId: 'ses_real_1' })
    expect(wsHandler.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.session.materialized', sessionId: 'ses_real_1' }))
  })

  it('returns 404 for a lost session on send-keys', async () => {
    const { FreshAgentLostSessionError } = await import('../../server/fresh-agent/runtime-manager.js')
    const { app } = makeApp({ freshAgentRuntimeManager: {
      create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode' })),
      send: vi.fn(async () => { throw new FreshAgentLostSessionError('session gone') }),
      attach: vi.fn(),
      getSnapshot: vi.fn(async () => ({ status: 'idle', turns: [] })),
    } })
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const res = await request(app).post(`/api/panes/${created.body.data.paneId}/send-keys`).send({ data: 'hi' })
    expect(res.status).toBe(404)
  })
})
