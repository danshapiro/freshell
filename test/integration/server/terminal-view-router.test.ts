// @vitest-environment node
import { EventEmitter } from 'node:events'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../server/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { logger }
})

import { httpAuthMiddleware } from '../../../server/auth'
import { createTerminalsRouter } from '../../../server/terminals-router'

class FakeBuffer {
  private chunks: string[] = []

  append(chunk: string) {
    this.chunks.push(chunk)
  }

  snapshot() {
    return this.chunks.join('')
  }
}

class FakeRegistry extends EventEmitter {
  private terminals = new Map<string, any>()

  addTerminal(overrides: Partial<{
    terminalId: string
    title: string
    description?: string
    mode: 'shell' | 'claude' | 'codex'
    status: 'running' | 'exited'
    cwd?: string
    cols: number
    rows: number
    createdAt: number
    lastActivityAt: number
    hasClients: boolean
    pid: number
  }> = {}) {
    const buffer = new FakeBuffer()
    const terminal = {
      terminalId: overrides.terminalId ?? `term-${this.terminals.size + 1}`,
      title: overrides.title ?? 'Shell',
      description: overrides.description,
      mode: overrides.mode ?? 'shell',
      status: overrides.status ?? 'running',
      cwd: overrides.cwd ?? '/tmp/project',
      cols: overrides.cols ?? 120,
      rows: overrides.rows ?? 30,
      createdAt: overrides.createdAt ?? Date.now(),
      lastActivityAt: overrides.lastActivityAt ?? Date.now(),
      clients: overrides.hasClients ? new Set(['client-1']) : new Set(),
      pty: { pid: overrides.pid ?? 4242 },
      buffer,
    }
    this.terminals.set(terminal.terminalId, terminal)
    return terminal
  }

  list() {
    return Array.from(this.terminals.values()).map((terminal) => ({
      terminalId: terminal.terminalId,
      title: terminal.title,
      description: terminal.description,
      mode: terminal.mode,
      createdAt: terminal.createdAt,
      lastActivityAt: terminal.lastActivityAt,
      status: terminal.status,
      hasClients: terminal.clients.size > 0,
      cwd: terminal.cwd,
    }))
  }

  get(terminalId: string) {
    return this.terminals.get(terminalId)
  }

  updateTitle() {}

  updateDescription() {}

  emitOutput(terminalId: string, data: string) {
    const terminal = this.terminals.get(terminalId)
    terminal?.buffer.append(data)
    if (terminal) terminal.lastActivityAt += 1
    this.emit('terminal.output.raw', { terminalId, data, at: Date.now() })
  }
}

function createTestApp(
  registry: FakeRegistry,
  configStore: { snapshot: ReturnType<typeof vi.fn> },
  readModelScheduler?: { schedule: (task: { lane: string; signal: AbortSignal; run: (signal: AbortSignal) => Promise<unknown> }) => Promise<unknown> },
): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())
  app.use('/api', httpAuthMiddleware)
  app.use('/api/terminals', createTerminalsRouter({
    configStore,
    registry,
    wsHandler: { broadcast: vi.fn() },
    ...(readModelScheduler ? { readModelScheduler } : {}),
  }))
  return app
}

describe('terminal view router', () => {
  const AUTH_TOKEN = 'test-auth-token-16chars'
  let registry: FakeRegistry
  let configStore: { snapshot: ReturnType<typeof vi.fn> }
  let app: Express

  beforeAll(() => {
    process.env.AUTH_TOKEN = AUTH_TOKEN
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  beforeEach(() => {
    registry = new FakeRegistry()
    configStore = {
      snapshot: vi.fn().mockResolvedValue({
        version: 1,
        settings: {},
        sessionOverrides: {},
        terminalOverrides: {},
        projectColors: {},
      }),
    }
    app = createTestApp(registry, configStore)
  })

  it('keeps terminal directory and viewport routes separate', async () => {
    registry.addTerminal({
      terminalId: 'term-newer',
      title: 'Newer terminal',
      createdAt: 200,
      lastActivityAt: 200,
    })
    registry.addTerminal({
      terminalId: 'term-older',
      title: 'Older terminal',
      createdAt: 100,
      lastActivityAt: 100,
    })

    const directory = await request(app)
      .get('/api/terminals?priority=visible&limit=1')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(200)

    expect(directory.body).toEqual({
      items: [
        expect.objectContaining({
          terminalId: 'term-newer',
          title: 'Newer terminal',
        }),
      ],
      nextCursor: expect.any(String),
      revision: 200,
    })

    const viewport = await request(app)
      .get('/api/terminals/term-newer/viewport')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(200)

    expect(viewport.body).toEqual(expect.objectContaining({
      terminalId: 'term-newer',
    }))
    expect(Array.isArray(viewport.body.items)).toBe(false)
  })

  it('returns viewport snapshots with tailSeq and runtime metadata', async () => {
    registry.addTerminal({
      terminalId: 'term-viewport',
      title: 'Build shell',
      cwd: '/tmp/project',
      cols: 140,
      rows: 20,
      hasClients: false,
      pid: 5150,
    })

    registry.emitOutput('term-viewport', 'line one\r\n')
    registry.emitOutput('term-viewport', 'line two')

    const response = await request(app)
      .get('/api/terminals/term-viewport/viewport')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(200)

    expect(response.body).toEqual({
      terminalId: 'term-viewport',
      revision: expect.any(Number),
      serialized: 'line one\nline two',
      cols: 140,
      rows: 20,
      tailSeq: 2,
      runtime: {
        title: 'Build shell',
        status: 'detached',
        cwd: '/tmp/project',
        pid: 5150,
      },
    })
  })

  it('rejects invalid terminal directory cursors and 404s missing viewports', async () => {
    await request(app)
      .get('/api/terminals?priority=visible&cursor=not-base64')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(400)

    await request(app)
      .get('/api/terminals/missing-terminal/viewport')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(404)
  })

  it('serves scrollback windows separately from viewport snapshots', async () => {
    registry.addTerminal({
      terminalId: 'term-scrollback',
      rows: 2,
    })

    registry.emitOutput('term-scrollback', 'alpha\nbeta\ngamma\ndelta')

    const response = await request(app)
      .get('/api/terminals/term-scrollback/scrollback?cursor=1&limit=2')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(200)

    expect(response.body).toEqual({
      items: [
        { line: 1, text: 'beta' },
        { line: 2, text: 'gamma' },
      ],
      nextCursor: '3',
    })
  })

  it('keeps terminal search server-side and paged', async () => {
    registry.addTerminal({
      terminalId: 'term-search',
      rows: 3,
    })

    registry.emitOutput('term-search', 'error one\nok line\nerror two')

    const response = await request(app)
      .get('/api/terminals/term-search/search?query=error&cursor=1&limit=1')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(200)

    expect(response.body).toEqual({
      matches: [
        { line: 2, column: 0, text: 'error two' },
      ],
      nextCursor: null,
    })
  })

  it('routes terminal reads through the correct visible-first lanes', async () => {
    registry.addTerminal({
      terminalId: 'term-lanes',
      title: 'Lane test',
    })

    const schedule = vi.fn(async ({ lane, signal, run }: { lane: string; signal: AbortSignal; run: (signal: AbortSignal) => Promise<unknown> }) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return run(signal)
    })

    app = createTestApp(registry, configStore, { schedule })

    await request(app)
      .get('/api/terminals?priority=visible&limit=1')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(200)
    await request(app)
      .get('/api/terminals/term-lanes/viewport')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(200)
    await request(app)
      .get('/api/terminals/term-lanes/scrollback?cursor=0&limit=1')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(200)
    await request(app)
      .get('/api/terminals/term-lanes/search?query=Lane')
      .set('x-auth-token', AUTH_TOKEN)
      .expect(200)

    expect(schedule.mock.calls.map(([task]) => task.lane)).toEqual([
      'visible',
      'critical',
      'background',
      'visible',
    ])
  })
})
