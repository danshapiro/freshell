// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('ai', () => ({
  generateText: vi.fn(async () => ({ text: 'AI Generated Title' })),
}))
vi.mock('@ai-sdk/google', () => ({
  google: () => ({ model: 'stub' }),
}))

import { createSessionsRouter } from '../../server/sessions-router.js'

function mountRouter(options: { projects?: any[] } = {}) {
  const store: Record<string, Record<string, unknown>> = {}
  const patchSessionOverride = vi.fn(async (key: string, patch: Record<string, unknown>) => {
    store[key] = { ...(store[key] || {}), ...patch }
    return store[key]
  })
  const refresh = vi.fn(async () => {})
  const deps = {
    configStore: {
      getSettings: async () => ({ ai: {}, sidebar: {} }),
      getSessionOverride: async (key: string) => store[key],
      patchSessionOverride,
    },
    codingCliIndexer: { getProjects: () => options.projects ?? [], refresh },
    codingCliProviders: [],
    perfConfig: { slowAiSummaryMs: 500 },
  }
  const app = express()
  app.use(express.json())
  app.use('/api', createSessionsRouter(deps as never))
  return { app, patchSessionOverride, refresh }
}

describe('POST /sessions/:id/generate-title', () => {
  beforeEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
  })
  afterEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
  })

  it('400s when firstMessage is missing', async () => {
    const { app } = mountRouter()
    const res = await request(app).post('/api/sessions/abc/generate-title?provider=claude').send({})
    expect(res.status).toBe(400)
  })

  it('finalizes from the first message as source "first-message" when AI is not configured', async () => {
    const { app, patchSessionOverride } = mountRouter()
    const res = await request(app)
      .post('/api/sessions/abc/generate-title?provider=claude')
      .send({ firstMessage: 'Fix the login redirect bug' })

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('first-message')
    expect(res.body.title).toBe('Fix the login redirect bug')
    expect(patchSessionOverride).toHaveBeenCalledWith('claude:abc', {
      titleOverride: 'Fix the login redirect bug',
      titleSource: 'first-message',
    })
  })

  it('generates an AI title as source "ai" when a Gemini key is configured', async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key'
    const { app, patchSessionOverride } = mountRouter()
    const res = await request(app)
      .post('/api/sessions/abc/generate-title?provider=claude')
      .send({ firstMessage: 'Fix the login redirect bug' })

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('ai')
    expect(res.body.title).toBe('AI Generated Title')
    expect(patchSessionOverride).toHaveBeenCalledWith('claude:abc', {
      titleOverride: 'AI Generated Title',
      titleSource: 'ai',
    })
  })

  it('returns the provider-generated title without writing an ai override', async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key'
    const { app, patchSessionOverride } = mountRouter({
      projects: [
        {
          projectPath: '/project/a',
          sessions: [
            {
              provider: 'claude',
              sessionId: 'abc',
              title: 'Provider Named Session',
              titleSource: 'provider-generated',
            },
          ],
        },
      ],
    })
    const res = await request(app)
      .post('/api/sessions/abc/generate-title?provider=claude')
      .send({ firstMessage: 'Fix the login redirect bug' })

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('provider-generated')
    expect(res.body.title).toBe('Provider Named Session')
    expect(patchSessionOverride).not.toHaveBeenCalledWith(
      'claude:abc',
      expect.objectContaining({ titleSource: 'ai' }),
    )
  })
})
