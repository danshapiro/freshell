import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createSessionsRouter } from '../../../server/sessions-router.js'

function createMetadataTestApp() {
  const entries = new Map<string, { derivedTitle?: string; sessionType?: string; sessionTypeSource?: 'explicit' | 'materialized' }>()
  const sessionMetadataStore = {
    get: vi.fn(async (provider: string, sessionId: string) => entries.get(`${provider}:${sessionId}`)),
    set: vi.fn(async (provider: string, sessionId: string, entry: { derivedTitle?: string; sessionType?: string; sessionTypeSource?: 'explicit' | 'materialized' }) => {
      const key = `${provider}:${sessionId}`
      const existing = entries.get(key) ?? {}
      let next = { ...existing, ...entry }
      if (
        existing.sessionTypeSource === 'explicit' &&
        entry.sessionTypeSource === 'materialized' &&
        entry.sessionType &&
        entry.sessionType !== existing.sessionType
      ) {
        next = { ...next, sessionType: existing.sessionType, sessionTypeSource: existing.sessionTypeSource }
      }
      const changed = JSON.stringify(existing) !== JSON.stringify(next)
      if (changed) entries.set(key, next)
      return changed
    }),
  }
  const codingCliIndexer = {
    getProjects: vi.fn().mockReturnValue([]),
    refresh: vi.fn().mockResolvedValue(undefined),
  }
  const app = express()
  app.use(express.json())
  app.use('/api', createSessionsRouter({
    configStore: {
      getSettings: vi.fn(),
      patchSessionOverride: vi.fn(),
      deleteSession: vi.fn(),
    } as any,
    codingCliIndexer,
    codingCliProviders: [],
    perfConfig: { slowSessionRefreshMs: 0 },
    sessionMetadataStore: sessionMetadataStore as any,
    validCliProviders: ['claude', 'codex', 'opencode'],
  }))
  return { app, entries, sessionMetadataStore, codingCliIndexer }
}

describe('session-metadata API', () => {
  it('keeps derivedTitle when sessionType is updated to freshcodex', async () => {
    const entries = new Map<string, { derivedTitle?: string; sessionType?: string }>()
    const sessionMetadataStore = {
      get: vi.fn(async (provider: string, sessionId: string) => entries.get(`${provider}:${sessionId}`)),
      set: vi.fn(async (provider: string, sessionId: string, entry: { derivedTitle?: string; sessionType?: string }) => {
        const key = `${provider}:${sessionId}`
        entries.set(key, { ...(entries.get(key) ?? {}), ...entry })
        return true
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

  it('rejects unknown session metadata types while keeping kilroy compatibility', async () => {
    const { app } = createMetadataTestApp()

    await request(app)
      .post('/api/session-metadata')
      .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'kilroy' })
      .expect(200)

    await request(app)
      .post('/api/session-metadata')
      .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'freshmadeup' })
      .expect(400)
  })

  it('skips index refresh when metadata write is unchanged', async () => {
    const { app, codingCliIndexer } = createMetadataTestApp()

    await request(app)
      .post('/api/session-metadata')
      .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'freshclaude', sessionTypeSource: 'materialized' })
      .expect(200)
    await request(app)
      .post('/api/session-metadata')
      .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'freshclaude', sessionTypeSource: 'materialized' })
      .expect(200)

    expect(codingCliIndexer.refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps explicit metadata when a later materialized tag disagrees', async () => {
    const { app, sessionMetadataStore } = createMetadataTestApp()

    await request(app)
      .post('/api/session-metadata')
      .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'claude', sessionTypeSource: 'explicit' })
      .expect(200)
    await request(app)
      .post('/api/session-metadata')
      .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'freshclaude', sessionTypeSource: 'materialized' })
      .expect(200)

    await expect(sessionMetadataStore.get('claude', 'sess-1')).resolves.toMatchObject({
      sessionType: 'claude',
      sessionTypeSource: 'explicit',
    })
  })
})
