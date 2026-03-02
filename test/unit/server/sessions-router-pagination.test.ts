// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../../server/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

vi.mock('../../../server/config-store', () => ({
  configStore: {
    getSettings: vi.fn(() => ({})),
    load: vi.fn().mockResolvedValue({ settings: {} }),
    patchSessionOverride: vi.fn(),
    deleteSession: vi.fn(),
    setProjectColor: vi.fn(),
  },
  defaultSettings: {},
}))

vi.mock('../../../server/perf-logger', () => ({
  getPerfConfig: () => ({ slowSessionRefreshMs: 1000 }),
  startPerfTimer: () => () => {},
}))

import type { ProjectGroup, CodingCliSession } from '../../../server/coding-cli/types.js'

function makeSession(id: string, updatedAt: number, projectPath: string): CodingCliSession {
  return {
    provider: 'claude',
    sessionId: id,
    projectPath,
    updatedAt,
    title: `Session ${id}`,
  }
}

function makeProject(path: string, sessions: CodingCliSession[]): ProjectGroup {
  return { projectPath: path, sessions }
}

// Build a realistic dataset
const allProjects: ProjectGroup[] = [
  makeProject('/a', Array.from({ length: 80 }, (_, i) =>
    makeSession(`a${i}`, 1000 + i, '/a'),
  )),
  makeProject('/b', Array.from({ length: 50 }, (_, i) =>
    makeSession(`b${i}`, 2000 + i, '/b'),
  )),
]

const mockIndexer = {
  getProjects: () => allProjects,
  refresh: vi.fn(),
}

describe('GET /sessions with pagination', () => {
  let app: express.Express

  // Lazy import to ensure mocks are in place
  async function setupApp() {
    const { createSessionsRouter } = await import('../../../server/routes/sessions.js')
    app = express()
    app.use(express.json())
    app.use(createSessionsRouter({
      codingCliIndexer: mockIndexer as any,
      codingCliProviders: [],
    }))
  }

  it('returns full list when no pagination params given (backward compat)', async () => {
    await setupApp()
    const res = await request(app).get('/sessions')
    expect(res.status).toBe(200)
    // Should return raw projects array (backward compat)
    expect(Array.isArray(res.body)).toBe(true)
    const totalSessions = (res.body as ProjectGroup[]).reduce(
      (sum, p) => sum + p.sessions.length, 0,
    )
    expect(totalSessions).toBe(130)
  })

  it('returns paginated result when limit is specified', async () => {
    await setupApp()
    const res = await request(app).get('/sessions?limit=50')
    expect(res.status).toBe(200)
    expect(res.body.totalSessions).toBe(130)
    expect(res.body.hasMore).toBe(true)
    expect(res.body.oldestIncludedTimestamp).toBeTypeOf('number')
    expect(res.body.oldestIncludedSessionId).toBeTypeOf('string')
    const pageSessions = (res.body.projects as ProjectGroup[]).reduce(
      (sum, p) => sum + p.sessions.length, 0,
    )
    expect(pageSessions).toBe(50)
  })

  it('supports cursor-based before+beforeId pagination', async () => {
    await setupApp()
    // Page 1
    const page1 = await request(app).get('/sessions?limit=50')
    expect(page1.body.hasMore).toBe(true)

    // Page 2 with cursor
    const { oldestIncludedTimestamp, oldestIncludedSessionId } = page1.body
    const page2 = await request(app)
      .get(`/sessions?limit=50&before=${oldestIncludedTimestamp}&beforeId=${oldestIncludedSessionId}`)
    expect(page2.status).toBe(200)
    expect(page2.body.totalSessions).toBe(130)
    const page2Sessions = (page2.body.projects as ProjectGroup[]).reduce(
      (sum, p) => sum + p.sessions.length, 0,
    )
    expect(page2Sessions).toBe(50)

    // Page 3 — remaining
    const page3 = await request(app)
      .get(`/sessions?limit=50&before=${page2.body.oldestIncludedTimestamp}&beforeId=${page2.body.oldestIncludedSessionId}`)
    expect(page3.body.hasMore).toBe(false)
    const page3Sessions = (page3.body.projects as ProjectGroup[]).reduce(
      (sum, p) => sum + p.sessions.length, 0,
    )
    expect(page3Sessions).toBe(30)

    // Total across all pages should be 130
    expect(pageSessions(page1) + pageSessions(page2) + pageSessions(page3)).toBe(130)
  })

  it('rejects invalid limit parameter', async () => {
    await setupApp()
    const res = await request(app).get('/sessions?limit=abc')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid limit/)
  })

  it('rejects non-integer limit parameter', async () => {
    await setupApp()
    const res = await request(app).get('/sessions?limit=2.5')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid limit/)
  })

  it('rejects empty limit parameter', async () => {
    await setupApp()
    const res = await request(app).get('/sessions?limit=')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid limit/)
  })

  it('rejects invalid before parameter', async () => {
    await setupApp()
    const res = await request(app).get('/sessions?before=xyz')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid before/)
  })

  it('rejects empty before parameter', async () => {
    await setupApp()
    const res = await request(app).get('/sessions?before=')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid before/)
  })

  it('rejects empty beforeId parameter', async () => {
    await setupApp()
    const res = await request(app).get('/sessions?beforeId=')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid beforeId/)
  })

  it('returns paginated result when only beforeId is specified', async () => {
    await setupApp()
    const res = await request(app).get('/sessions?beforeId=a50')
    expect(res.status).toBe(200)
    expect(res.body.totalSessions).toBe(130)
    expect(typeof res.body.hasMore).toBe('boolean')
  })

  it('returns paginated result when before is specified without limit', async () => {
    await setupApp()
    const res = await request(app).get('/sessions?before=2000')
    expect(res.status).toBe(200)
    expect(res.body.totalSessions).toBe(130)
    expect(typeof res.body.hasMore).toBe('boolean')
  })
})

function pageSessions(res: request.Response): number {
  return (res.body.projects as ProjectGroup[]).reduce(
    (sum, p) => sum + p.sessions.length, 0,
  )
}
