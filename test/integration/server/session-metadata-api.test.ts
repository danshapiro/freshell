import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createSessionsRouter } from '../../../server/sessions-router.js'

describe('session-metadata API', () => {
  it('keeps derivedTitle when sessionType is updated to freshcodex', async () => {
    const entries = new Map<string, { derivedTitle?: string; sessionType?: string }>()
    const sessionMetadataStore = {
      get: vi.fn(async (provider: string, sessionId: string) => entries.get(`${provider}:${sessionId}`)),
      set: vi.fn(async (provider: string, sessionId: string, entry: { derivedTitle?: string; sessionType?: string }) => {
        const key = `${provider}:${sessionId}`
        entries.set(key, { ...(entries.get(key) ?? {}), ...entry })
      }),
    }
    await sessionMetadataStore.set('codex', 'sess-1', { derivedTitle: 'Sticky title' })

    const app = express()
    app.use(express.json())
    app.use('/api', createSessionsRouter({
      configStore: {
        getSettings: vi.fn(),
        patchSessionOverride: vi.fn(),
        deleteSession: vi.fn(),
      } as any,
      codingCliIndexer: {
        getProjects: vi.fn().mockReturnValue([]),
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 0 },
      sessionMetadataStore: sessionMetadataStore as any,
      validCliProviders: ['codex'],
    }))

    const response = await request(app)
      .post('/api/session-metadata')
      .send({ provider: 'codex', sessionId: 'sess-1', sessionType: 'freshcodex' })

    expect(response.status).toBe(200)
    expect(entries.get('codex:sess-1')).toEqual({
      derivedTitle: 'Sticky title',
      sessionType: 'freshcodex',
    })
  })
})
