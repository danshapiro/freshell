import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

// Mock the config-store module before importing auth
vi.mock('../../server/config-store', () => ({
  configStore: {
    snapshot: vi.fn().mockResolvedValue({
      version: 1,
      settings: {},
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    }),
    patchTerminalOverride: vi.fn().mockResolvedValue({}),
    deleteTerminal: vi.fn().mockResolvedValue(undefined),
  },
}))

// Mock logger to avoid unnecessary output
vi.mock('../../server/logger', () => {
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

// Import after mocks are set up
import { httpAuthMiddleware } from '../../server/auth'
import { configStore } from '../../server/config-store'

/** Fake registry that returns controlled terminal data without spawning real PTYs */
class FakeRegistry {
  private terminals: Array<{
    terminalId: string
    title: string
    description?: string
    mode: 'shell' | 'claude' | 'codex'
    createdAt: number
    lastActivityAt: number
    status: 'running' | 'exited'
    hasClients: boolean
    cwd?: string
  }> = []

  addTerminal(overrides: Partial<{
    terminalId: string
    title: string
    description?: string
    mode: 'shell' | 'claude' | 'codex'
    status: 'running' | 'exited'
    cwd?: string
  }> = {}) {
    const terminal = {
      terminalId: overrides.terminalId || `term_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      title: overrides.title || 'Shell',
      description: overrides.description,
      mode: overrides.mode || 'shell',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: overrides.status || 'running',
      hasClients: false,
      cwd: overrides.cwd || '/home/user',
    }
    this.terminals.push(terminal)
    return terminal
  }

  clear() {
    this.terminals = []
  }

  list() {
    return [...this.terminals]
  }

  get(terminalId: string) {
    return this.terminals.find(t => t.terminalId === terminalId)
  }

  updateTitle(terminalId: string, title: string) {
    const terminal = this.terminals.find(t => t.terminalId === terminalId)
    if (terminal) terminal.title = title
    return !!terminal
  }

  updateDescription(terminalId: string, description: string | undefined) {
    const terminal = this.terminals.find(t => t.terminalId === terminalId)
    if (terminal) terminal.description = description
    return !!terminal
  }
}

/** Create a minimal Express app with terminal routes for testing */
function createTestApp(registry: FakeRegistry): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())
  app.use('/api', httpAuthMiddleware)

  // GET /api/terminals - list all terminals
  app.get('/api/terminals', async (_req, res) => {
    const cfg = await configStore.snapshot()
    const list = registry.list().filter((t) => !cfg.terminalOverrides?.[t.terminalId]?.deleted)
    const merged = list.map((t) => {
      const ov = cfg.terminalOverrides?.[t.terminalId]
      return {
        ...t,
        title: ov?.titleOverride || t.title,
        description: ov?.descriptionOverride || t.description,
      }
    })
    res.json(merged)
  })

  // PATCH /api/terminals/:terminalId - update terminal
  app.patch('/api/terminals/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    const { titleOverride, descriptionOverride, deleted } = req.body || {}

    const next = await configStore.patchTerminalOverride(terminalId, {
      titleOverride,
      descriptionOverride,
      deleted,
    })

    if (typeof titleOverride === 'string' && titleOverride.trim()) {
      registry.updateTitle(terminalId, titleOverride.trim())
    }
    if (typeof descriptionOverride === 'string') {
      registry.updateDescription(terminalId, descriptionOverride)
    }

    res.json(next)
  })

  // DELETE /api/terminals/:terminalId - mark terminal as deleted
  app.delete('/api/terminals/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    await configStore.deleteTerminal(terminalId)
    res.json({ ok: true })
  })

  return app
}

describe('Terminals API', () => {
  const AUTH_TOKEN = 'test-auth-token-16chars'
  let app: Express
  let registry: FakeRegistry

  beforeAll(() => {
    process.env.AUTH_TOKEN = AUTH_TOKEN
  })

  beforeEach(() => {
    vi.clearAllMocks()
    registry = new FakeRegistry()
    app = createTestApp(registry)

    // Reset config store mock to default behavior
    vi.mocked(configStore.snapshot).mockResolvedValue({
      version: 1,
      settings: {} as any,
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    })
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  describe('GET /api/terminals', () => {
    it('returns 401 when no auth token provided', async () => {
      const response = await request(app)
        .get('/api/terminals')
        .expect(401)

      expect(response.body).toEqual({ error: 'Unauthorized' })
    })

    it('returns 401 when invalid auth token provided', async () => {
      const response = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', 'wrong-token')
        .expect(401)

      expect(response.body).toEqual({ error: 'Unauthorized' })
    })

    it('returns empty array when no terminals exist', async () => {
      const response = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', AUTH_TOKEN)
        .expect(200)

      expect(response.body).toEqual([])
    })

    it('lists all terminals with required fields', async () => {
      registry.addTerminal({
        terminalId: 'term_123',
        title: 'Shell',
        mode: 'shell',
        status: 'running',
        cwd: '/home/user/project',
      })
      registry.addTerminal({
        terminalId: 'term_456',
        title: 'Claude',
        mode: 'claude',
        status: 'running',
      })

      const response = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', AUTH_TOKEN)
        .expect(200)

      expect(response.body).toHaveLength(2)

      // Verify first terminal has all required fields
      const firstTerminal = response.body.find((t: any) => t.terminalId === 'term_123')
      expect(firstTerminal).toBeDefined()
      expect(firstTerminal.terminalId).toBe('term_123')
      expect(firstTerminal.title).toBe('Shell')
      expect(firstTerminal.mode).toBe('shell')
      expect(firstTerminal.status).toBe('running')
      expect(firstTerminal).toHaveProperty('createdAt')
      expect(firstTerminal).toHaveProperty('lastActivityAt')

      // Verify second terminal
      const secondTerminal = response.body.find((t: any) => t.terminalId === 'term_456')
      expect(secondTerminal).toBeDefined()
      expect(secondTerminal.terminalId).toBe('term_456')
      expect(secondTerminal.title).toBe('Claude')
      expect(secondTerminal.mode).toBe('claude')
    })

    it('applies title override from config', async () => {
      registry.addTerminal({
        terminalId: 'term_with_override',
        title: 'Original Title',
        mode: 'shell',
      })

      vi.mocked(configStore.snapshot).mockResolvedValue({
        version: 1,
        settings: {} as any,
        sessionOverrides: {},
        terminalOverrides: {
          'term_with_override': {
            titleOverride: 'Custom Title',
          },
        },
        projectColors: {},
      })

      const response = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', AUTH_TOKEN)
        .expect(200)

      expect(response.body[0].title).toBe('Custom Title')
    })

    it('applies description override from config', async () => {
      registry.addTerminal({
        terminalId: 'term_with_desc',
        title: 'Shell',
        description: 'Original description',
        mode: 'shell',
      })

      vi.mocked(configStore.snapshot).mockResolvedValue({
        version: 1,
        settings: {} as any,
        sessionOverrides: {},
        terminalOverrides: {
          'term_with_desc': {
            descriptionOverride: 'Custom description',
          },
        },
        projectColors: {},
      })

      const response = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', AUTH_TOKEN)
        .expect(200)

      expect(response.body[0].description).toBe('Custom description')
    })

    it('filters out deleted terminals', async () => {
      registry.addTerminal({
        terminalId: 'visible_term',
        title: 'Visible',
        mode: 'shell',
      })
      registry.addTerminal({
        terminalId: 'deleted_term',
        title: 'Deleted',
        mode: 'shell',
      })

      vi.mocked(configStore.snapshot).mockResolvedValue({
        version: 1,
        settings: {} as any,
        sessionOverrides: {},
        terminalOverrides: {
          'deleted_term': {
            deleted: true,
          },
        },
        projectColors: {},
      })

      const response = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', AUTH_TOKEN)
        .expect(200)

      expect(response.body).toHaveLength(1)
      expect(response.body[0].terminalId).toBe('visible_term')
    })

    it('includes all terminal modes: shell, claude, codex', async () => {
      registry.addTerminal({ terminalId: 'shell_term', title: 'Shell', mode: 'shell' })
      registry.addTerminal({ terminalId: 'claude_term', title: 'Claude', mode: 'claude' })
      registry.addTerminal({ terminalId: 'codex_term', title: 'Codex', mode: 'codex' })

      const response = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', AUTH_TOKEN)
        .expect(200)

      expect(response.body).toHaveLength(3)
      const modes = response.body.map((t: any) => t.mode)
      expect(modes).toContain('shell')
      expect(modes).toContain('claude')
      expect(modes).toContain('codex')
    })

    it('includes both running and exited terminals', async () => {
      registry.addTerminal({ terminalId: 'running_term', status: 'running' })
      registry.addTerminal({ terminalId: 'exited_term', status: 'exited' })

      const response = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', AUTH_TOKEN)
        .expect(200)

      expect(response.body).toHaveLength(2)
      const statuses = response.body.map((t: any) => t.status)
      expect(statuses).toContain('running')
      expect(statuses).toContain('exited')
    })
  })

  describe('PATCH /api/terminals/:terminalId', () => {
    it('returns 401 without auth token', async () => {
      const response = await request(app)
        .patch('/api/terminals/term_123')
        .send({ titleOverride: 'New Title' })
        .expect(401)

      expect(response.body).toEqual({ error: 'Unauthorized' })
    })

    it('updates terminal title override', async () => {
      registry.addTerminal({ terminalId: 'term_to_update' })

      vi.mocked(configStore.patchTerminalOverride).mockResolvedValue({
        titleOverride: 'Updated Title',
      })

      const response = await request(app)
        .patch('/api/terminals/term_to_update')
        .set('x-auth-token', AUTH_TOKEN)
        .send({ titleOverride: 'Updated Title' })
        .expect(200)

      expect(configStore.patchTerminalOverride).toHaveBeenCalledWith('term_to_update', {
        titleOverride: 'Updated Title',
        descriptionOverride: undefined,
        deleted: undefined,
      })
      expect(response.body).toEqual({ titleOverride: 'Updated Title' })
    })

    it('updates terminal description override', async () => {
      registry.addTerminal({ terminalId: 'term_desc' })

      vi.mocked(configStore.patchTerminalOverride).mockResolvedValue({
        descriptionOverride: 'New description',
      })

      await request(app)
        .patch('/api/terminals/term_desc')
        .set('x-auth-token', AUTH_TOKEN)
        .send({ descriptionOverride: 'New description' })
        .expect(200)

      expect(configStore.patchTerminalOverride).toHaveBeenCalledWith('term_desc', {
        titleOverride: undefined,
        descriptionOverride: 'New description',
        deleted: undefined,
      })
    })

    it('marks terminal as deleted', async () => {
      registry.addTerminal({ terminalId: 'term_to_delete' })

      vi.mocked(configStore.patchTerminalOverride).mockResolvedValue({
        deleted: true,
      })

      await request(app)
        .patch('/api/terminals/term_to_delete')
        .set('x-auth-token', AUTH_TOKEN)
        .send({ deleted: true })
        .expect(200)

      expect(configStore.patchTerminalOverride).toHaveBeenCalledWith('term_to_delete', {
        titleOverride: undefined,
        descriptionOverride: undefined,
        deleted: true,
      })
    })
  })

  describe('DELETE /api/terminals/:terminalId', () => {
    it('returns 401 without auth token', async () => {
      const response = await request(app)
        .delete('/api/terminals/term_123')
        .expect(401)

      expect(response.body).toEqual({ error: 'Unauthorized' })
    })

    it('marks terminal as deleted and returns ok', async () => {
      const response = await request(app)
        .delete('/api/terminals/term_to_remove')
        .set('x-auth-token', AUTH_TOKEN)
        .expect(200)

      expect(configStore.deleteTerminal).toHaveBeenCalledWith('term_to_remove')
      expect(response.body).toEqual({ ok: true })
    })
  })
})
