// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

const mockState = vi.hoisted(() => ({
  homeDir: process.env.TEMP || process.env.TMP || '/tmp',
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: { ...actual, homedir: () => mockState.homeDir },
    homedir: () => mockState.homeDir,
  }
})

import { claudeProvider } from '../../../server/coding-cli/providers/claude.js'
import { createSessionsRouter } from '../../../server/sessions-router.js'
import type { ProjectGroup } from '../../../server/coding-cli/types.js'

const TEST_AUTH_TOKEN = 'test-auth-token'

describe('Session Search API', () => {
  let app: Express
  let tempDir: string
  let mockProjects: ProjectGroup[]

  beforeAll(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  })

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'search-api-test-'))
    mockState.homeDir = tempDir

    // Create mock sessions
    const projectDir = path.join(tempDir, 'projects')
    await fsp.mkdir(projectDir, { recursive: true })

    const sessionPath = path.join(projectDir, 'session-abc.jsonl')
    await fsp.writeFile(
      sessionPath,
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix login bug"}]},"cwd":"/project"}\n'
    )
    const sessionPathTwo = path.join(projectDir, 'session-def.jsonl')
    await fsp.writeFile(
      sessionPathTwo,
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"cwd":"/project"}\n' +
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The authentication system works"}]}}'
    )

    mockProjects = [
      {
        projectPath: '/test-project',
        sessions: [
          {
            provider: 'claude',
            sessionId: 'session-abc',
            projectPath: '/test-project',
            updatedAt: 1000,
            title: 'Fix login bug',
            cwd: '/project',
            sourceFile: sessionPath,
          },
          {
            provider: 'claude',
            sessionId: 'session-def',
            projectPath: '/test-project',
            updatedAt: 2000,
            title: 'Hello',
            cwd: '/project',
            sourceFile: sessionPathTwo,
          },
        ],
      },
    ]

    app = express()
    app.use(express.json())

    // Auth middleware
    app.use('/api', (req, res, next) => {
      const token = req.headers['x-auth-token']
      if (token !== TEST_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
      next()
    })

    // Mount sessions router
    app.use('/api', createSessionsRouter({
      configStore: {
        patchSessionOverride: vi.fn().mockResolvedValue({}),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      },
      codingCliIndexer: {
        getProjects: () => mockProjects,
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [claudeProvider],
      perfConfig: { slowSessionRefreshMs: 500 },
    }))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  it('requires authentication', async () => {
    const res = await request(app).get('/api/sessions/search?q=test')
    expect(res.status).toBe(401)
  })

  it('requires query parameter', async () => {
    const res = await request(app)
      .get('/api/sessions/search')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid request')
  })

  it('searches with default title tier', async () => {
    const res = await request(app)
      .get('/api/sessions/search?q=login')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.tier).toBe('title')
    expect(res.body.results).toHaveLength(1)
    expect(res.body.results[0].sessionId).toBe('session-abc')
    expect(res.body.results[0].provider).toBe('claude')
  })

  it('accepts tier parameter', async () => {
    const res = await request(app)
      .get('/api/sessions/search?q=login&tier=userMessages')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.tier).toBe('userMessages')
  })

  it('accepts limit parameter', async () => {
    const res = await request(app)
      .get('/api/sessions/search?q=a&tier=title&limit=5')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
  })

  it('accepts maxFiles parameter and marks partial results', async () => {
    const res = await request(app)
      .get('/api/sessions/search?q=authentication&tier=fullText&maxFiles=1')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.partial).toBe(true)
    expect(res.body.partialReason).toBe('budget')
  })

  it('rejects invalid tier', async () => {
    const res = await request(app)
      .get('/api/sessions/search?q=test&tier=invalid')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
  })
})
