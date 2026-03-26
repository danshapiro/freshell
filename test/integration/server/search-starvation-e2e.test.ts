// @vitest-environment node
// E2E: deep session search must not starve other foreground requests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import http from 'http'
import express, { type Express } from 'express'
import { createSessionsRouter } from '../../../server/sessions-router.js'
import { createShellBootstrapRouter } from '../../../server/shell-bootstrap-router.js'
import { claudeProvider } from '../../../server/coding-cli/providers/claude.js'
import { defaultReadModelScheduler } from '../../../server/read-models/work-scheduler.js'
import type { ProjectGroup } from '../../../server/coding-cli/types.js'

const TEST_AUTH_TOKEN = 'test-auth-token'

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') return reject(new Error('unexpected address'))
      resolve({ port: addr.port })
    })
  })
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('deep search does not starve other routes (e2e)', () => {
  let tempDir: string
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'search-starvation-e2e-'))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  async function writeSessionFile(filename: string, opts?: { matchLine?: string }): Promise<string> {
    const filePath = path.join(tempDir, filename)
    const lines: string[] = []
    for (let i = 0; i < 50; i++) {
      lines.push(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: `filler message number ${i}` }] },
      }))
    }
    if (opts?.matchLine) {
      lines.push(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: opts.matchLine }] },
      }))
    }
    await fsp.writeFile(filePath, lines.join('\n'))
    return filePath
  }

  async function createServer(projects: ProjectGroup[]) {
    const app: Express = express()
    app.use(express.json())
    app.use('/api', (req, res, next) => {
      if (req.headers['x-auth-token'] !== TEST_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      next()
    })

    app.use('/api', createSessionsRouter({
      configStore: {
        getSettings: async () => ({ theme: 'system' }),
        patchSessionOverride: vi.fn().mockResolvedValue({ ok: true }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      },
      codingCliIndexer: {
        getProjects: () => projects,
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [claudeProvider],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: { list: () => [] },
    }))

    app.use('/api', createShellBootstrapRouter({
      getSettings: async () => ({ theme: 'system' } as any),
      getPlatform: async () => ({ os: 'linux' }),
      getShellState: async () => ({ authenticated: true, ready: true }),
    }))

    server = http.createServer(app)
    const { port } = await listen(server)
    baseUrl = `http://127.0.0.1:${port}`
  }

  it('bootstrap request completes while a foreground slot is occupied', async () => {
    await createServer([])

    // Occupy a foreground slot with a slow visible task on the shared scheduler.
    const slowTask = createDeferred()
    const slowTaskPromise = defaultReadModelScheduler.schedule({
      lane: 'visible',
      run: () => slowTask.promise,
    })

    await new Promise((r) => setTimeout(r, 10))

    // Bootstrap uses the critical lane — should complete even with a visible task running.
    const bootstrapRes = await fetch(
      `${baseUrl}/api/bootstrap`,
      { headers: { 'x-auth-token': TEST_AUTH_TOKEN } },
    )

    expect(bootstrapRes.status).toBe(200)
    const body = await bootstrapRes.json()
    expect(body.settings).toBeDefined()
    expect(body.shell).toEqual({ authenticated: true, ready: true })

    slowTask.resolve()
    await slowTaskPromise
  })

  it('two concurrent session-directory requests both complete', async () => {
    const sourceFile1 = await writeSessionFile('session-1.jsonl', {
      matchLine: 'alpha unique keyword',
    })
    const sourceFile2 = await writeSessionFile('session-2.jsonl', {
      matchLine: 'beta unique keyword',
    })

    await createServer([{
      projectPath: '/repo',
      sessions: [
        {
          provider: 'claude',
          sessionId: 'session-1',
          projectPath: '/repo',
          lastActivityAt: 100,
          title: 'Session one',
          sourceFile: sourceFile1,
        },
        {
          provider: 'claude',
          sessionId: 'session-2',
          projectPath: '/repo',
          lastActivityAt: 99,
          title: 'Session two',
          sourceFile: sourceFile2,
        },
      ],
    }])

    const [res1, res2] = await Promise.all([
      fetch(
        `${baseUrl}/api/session-directory?priority=visible&query=alpha&tier=userMessages`,
        { headers: { 'x-auth-token': TEST_AUTH_TOKEN } },
      ),
      fetch(
        `${baseUrl}/api/session-directory?priority=visible&query=beta&tier=userMessages`,
        { headers: { 'x-auth-token': TEST_AUTH_TOKEN } },
      ),
    ])

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)

    const body1 = await res1.json()
    const body2 = await res2.json()
    expect(body1.items).toHaveLength(1)
    expect(body1.items[0].matchedIn).toBe('userMessage')
    expect(body2.items).toHaveLength(1)
    expect(body2.items[0].matchedIn).toBe('userMessage')
  })

  it('deep search returns correct results through full HTTP round-trip', async () => {
    const sourceFile = await writeSessionFile('session-match.jsonl', {
      matchLine: 'Fix the authentication bug in the login handler',
    })

    await createServer([{
      projectPath: '/repo',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-match',
        projectPath: '/repo',
        lastActivityAt: 100,
        title: 'Bug fix session',
        sourceFile,
      }],
    }])

    const res = await fetch(
      `${baseUrl}/api/session-directory?priority=visible&query=authentication&tier=userMessages`,
      { headers: { 'x-auth-token': TEST_AUTH_TOKEN } },
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].sessionId).toBe('session-match')
    expect(body.items[0].matchedIn).toBe('userMessage')
    expect(body.items[0].snippet).toContain('authentication')
  })

  it('title search does not trigger file I/O', async () => {
    const sourceFile = await writeSessionFile('session-title.jsonl')

    await createServer([{
      projectPath: '/repo',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-title',
        projectPath: '/repo',
        lastActivityAt: 100,
        title: 'Deploy the application',
        sourceFile,
      }],
    }])

    const res = await fetch(
      `${baseUrl}/api/session-directory?priority=visible&query=deploy&tier=title`,
      { headers: { 'x-auth-token': TEST_AUTH_TOKEN } },
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].matchedIn).toBe('title')
  })

  it('fullText tier finds assistant message matches', async () => {
    const sourceFile = await writeSessionFile('session-full.jsonl')
    await fsp.appendFile(sourceFile, '\n' + JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The xylophone_secret is here' }] },
    }))

    await createServer([{
      projectPath: '/repo',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-full',
        projectPath: '/repo',
        lastActivityAt: 100,
        title: 'Full text session',
        sourceFile,
      }],
    }])

    const res = await fetch(
      `${baseUrl}/api/session-directory?priority=visible&query=xylophone_secret&tier=fullText`,
      { headers: { 'x-auth-token': TEST_AUTH_TOKEN } },
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].matchedIn).toBe('assistantMessage')
  })
})
