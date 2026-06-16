// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router.js'
import { LayoutStore } from '../../server/agent-api/layout-store.js'

function makeApp(overrides: { freshAgentRuntimeManager?: any } = {}) {
  const layoutStore = new LayoutStore()
  const wsHandler = { broadcastUiCommand: vi.fn() }
  const freshAgentRuntimeManager = overrides.freshAgentRuntimeManager ?? {
    create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode', sessionRef: { provider: 'opencode', sessionId: 'freshopencode-abc' } })),
    send: vi.fn(async () => undefined),
    attach: vi.fn(async () => ({ sessionId: 'ses_real_1' })),
    getSnapshot: vi.fn(async () => ({ turns: [] })),
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
})

describe('agent-api fresh-agent: send-keys', () => {
  it('routes send-keys to the runtime manager for a fresh-agent pane and blocks until the turn returns', async () => {
    const { app, freshAgentRuntimeManager } = makeApp()
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const paneId = created.body.data.paneId
    const res = await request(app).post(`/api/panes/${paneId}/send-keys`).send({ data: 'Reply with: ok' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sessionId: 'freshopencode-abc' })
    expect(freshAgentRuntimeManager.send).toHaveBeenCalledWith(
      { sessionId: 'freshopencode-abc', sessionType: 'freshopencode', provider: 'opencode' },
      { text: 'Reply with: ok' },
    )
  })

  it('attaches on a lost session before retrying send (cross-process orchestration)', async () => {
    const lost = Object.assign(new Error('not tracked'), { name: 'FreshAgentLostSessionError' })
    const send = vi.fn().mockRejectedValueOnce(lost).mockResolvedValueOnce({ sessionId: 'ses_real_1' })
    const attach = vi.fn(async () => ({ sessionId: 'ses_real_1' }))
    const { app } = makeApp({ freshAgentRuntimeManager: {
      create: vi.fn(async () => ({ sessionId: 'ses_real_1', sessionType: 'freshopencode', runtimeProvider: 'opencode' })),
      send, attach, getSnapshot: vi.fn(async () => ({ turns: [] })),
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
      turns: [
        { role: 'user', summary: 'Reply with: ok', items: [{ kind: 'text', text: 'Reply with: ok' }] },
        { role: 'assistant', summary: 'ok', items: [{ kind: 'text', text: 'ok' }] },
      ],
    }))
    const { app } = makeApp({ freshAgentRuntimeManager: {
      create: vi.fn(async () => ({ sessionId: 'freshopencode-abc', sessionType: 'freshopencode', runtimeProvider: 'opencode' })),
      send: vi.fn(), attach: vi.fn(), getSnapshot,
    } })
    const created = await request(app).post('/api/tabs').send({ agent: 'opencode' })
    const res = await request(app).get(`/api/panes/${created.body.data.paneId}/capture`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('user: Reply with: ok')
    expect(res.text).toContain('assistant: ok')
    expect(getSnapshot).toHaveBeenCalledWith({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'freshopencode-abc' })
  })
})
