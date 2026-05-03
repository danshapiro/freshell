import { it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'
import { FakeCodexLaunchPlanner, DEFAULT_CODEX_REMOTE_WS_URL } from '../helpers/coding-cli/fake-codex-launch-planner.js'

it('runs a command and returns captured output', async () => {
  let buffer = ''
  const registry = {
    create: () => ({ terminalId: 'term1' }),
    input: (_terminalId: string, data: string) => {
      const match = data.match(/__FRESHELL_DONE_[A-Za-z0-9_-]+__/)
      if (match) buffer = `done\n${match[0]}\n`
      return true
    },
    get: () => ({ buffer: { snapshot: () => buffer }, status: 'running' }),
  }

  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { createTab: () => ({ tabId: 't1', paneId: 'p1' }) },
    registry,
  }))

  const res = await request(app).post('/api/run').send({ command: 'echo done', capture: true })
  expect(res.body.status).toBe('ok')
  expect(res.body.data.output).toContain('done')
})

it('allocates and passes an OpenCode control endpoint for /api/run in opencode mode', async () => {
  let buffer = ''
  const registry = {
    create: vi.fn(() => ({ terminalId: 'term1' })),
    input: (_terminalId: string, data: string) => {
      const match = data.match(/__FRESHELL_DONE_[A-Za-z0-9_-]+__/)
      if (match) buffer = `done\n${match[0]}\n`
      return true
    },
    get: () => ({ buffer: { snapshot: () => buffer }, status: 'running' }),
  }

  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { createTab: () => ({ tabId: 't1', paneId: 'p1' }), attachPaneContent: () => {} },
    registry,
  }))

  const res = await request(app).post('/api/run').send({ command: 'echo done', capture: true, mode: 'opencode' })

  expect(res.body.status).toBe('ok')
  expect(registry.create).toHaveBeenCalledWith(expect.objectContaining({
    mode: 'opencode',
    providerSettings: expect.objectContaining({
      opencodeServer: {
        hostname: '127.0.0.1',
        port: expect.any(Number),
      },
    }),
  }))
})

it('uses the Codex planner and marks fresh /api/run sessions as starts', async () => {
  const registry = {
    create: vi.fn(() => ({ terminalId: 'term1' })),
    input: vi.fn(() => true),
  }
  const codexLaunchPlanner = new FakeCodexLaunchPlanner()

  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      createTab: () => ({ tabId: 't1', paneId: 'p1' }),
      attachPaneContent: () => {},
    },
    registry,
    codexLaunchPlanner,
  }))

  const res = await request(app).post('/api/run').send({ command: 'echo done', mode: 'codex' })

  expect(res.body.status).toBe('ok')
  expect(codexLaunchPlanner.planCreateCalls).toEqual([{
    approvalPolicy: undefined,
    cwd: undefined,
    model: undefined,
    resumeSessionId: undefined,
    sandbox: undefined,
  }])
  expect(registry.create).toHaveBeenCalledWith(expect.objectContaining({
    mode: 'codex',
    resumeSessionId: 'thread-new-1',
    sessionBindingReason: 'start',
    providerSettings: expect.objectContaining({
      codexAppServer: expect.objectContaining({
        wsUrl: DEFAULT_CODEX_REMOTE_WS_URL,
      }),
    }),
  }))
  expect(codexLaunchPlanner.sidecar.adoptCalls).toEqual([{ terminalId: 'term1', generation: 0 }])
})

it('shuts down the pending Codex sidecar when /api/run fails after planning', async () => {
  const registry = {
    create: vi.fn(() => {
      throw new Error('spawn failed after planning')
    }),
    input: vi.fn(() => true),
  }
  const codexLaunchPlanner = new FakeCodexLaunchPlanner()

  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      createTab: () => ({ tabId: 't1', paneId: 'p1' }),
      attachPaneContent: () => {},
    },
    registry,
    codexLaunchPlanner,
  }))

  const res = await request(app).post('/api/run').send({ command: 'echo done', mode: 'codex' })

  expect(res.status).toBe(500)
  expect(res.body.message).toBe('spawn failed after planning')
  expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
  expect(codexLaunchPlanner.sidecar.adoptCalls).toEqual([])
})

it('reports pending Codex sidecar shutdown failure when /api/run fails after planning', async () => {
  const registry = {
    create: vi.fn(() => {
      throw new Error('spawn failed after planning')
    }),
    input: vi.fn(() => true),
  }
  const codexLaunchPlanner = new FakeCodexLaunchPlanner()
  codexLaunchPlanner.sidecar.shutdownError = new Error('verified sidecar teardown failed')

  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      createTab: () => ({ tabId: 't1', paneId: 'p1' }),
      attachPaneContent: () => {},
    },
    registry,
    codexLaunchPlanner,
  }))

  const res = await request(app).post('/api/run').send({ command: 'echo done', mode: 'codex' })

  expect(res.status).toBe(500)
  expect(res.body.message).toContain('spawn failed after planning')
  expect(res.body.message).toContain('verified sidecar teardown failed')
  expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
  expect(codexLaunchPlanner.sidecar.adoptCalls).toEqual([])
})

it('kills the created terminal and sidecar when /api/run fails after registry.create', async () => {
  const registry = {
    create: vi.fn(() => ({ terminalId: 'term1' })),
    input: vi.fn(() => true),
    killAndWait: vi.fn(async () => true),
  }
  const codexLaunchPlanner = new FakeCodexLaunchPlanner()
  vi.spyOn(codexLaunchPlanner.sidecar, 'adopt').mockRejectedValue(new Error('adopt failed after create'))

  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      createTab: () => ({ tabId: 't1', paneId: 'p1' }),
      attachPaneContent: () => {},
    },
    registry,
    codexLaunchPlanner,
  }))

  const res = await request(app).post('/api/run').send({ command: 'echo done', mode: 'codex' })

  expect(res.status).toBe(500)
  expect(res.body.message).toBe('adopt failed after create')
  expect(registry.killAndWait).toHaveBeenCalledWith('term1')
  expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
})

it('reports created-terminal cleanup failure when /api/run fails after registry.create', async () => {
  const registry = {
    create: vi.fn(() => ({ terminalId: 'term1' })),
    input: vi.fn(() => true),
    killAndWait: vi.fn(async () => {
      throw new Error('terminal cleanup failed')
    }),
  }
  const codexLaunchPlanner = new FakeCodexLaunchPlanner()
  vi.spyOn(codexLaunchPlanner.sidecar, 'adopt').mockRejectedValue(new Error('adopt failed after create'))

  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      createTab: () => ({ tabId: 't1', paneId: 'p1' }),
      attachPaneContent: () => {},
    },
    registry,
    codexLaunchPlanner,
  }))

  const res = await request(app).post('/api/run').send({ command: 'echo done', mode: 'codex' })

  expect(res.status).toBe(500)
  expect(res.body.message).toContain('adopt failed after create')
  expect(res.body.message).toContain('terminal cleanup failed')
  expect(registry.killAndWait).toHaveBeenCalledWith('term1')
  expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
})

it('rejects invalid Codex settings for /api/run before creating a tab', async () => {
  const createTab = vi.fn(() => ({ tabId: 't1', paneId: 'p1' }))
  const registry = {
    create: vi.fn(() => ({ terminalId: 'term1' })),
    input: vi.fn(() => true),
  }
  const codexLaunchPlanner = new FakeCodexLaunchPlanner()

  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      createTab,
      attachPaneContent: () => {},
    },
    registry,
    codexLaunchPlanner,
    configStore: {
      getSettings: async () => ({
        codingCli: {
          providers: {
            codex: {
              sandbox: 'totally-open',
            },
          },
        },
      }),
    },
  }))

  const res = await request(app).post('/api/run').send({ command: 'echo done', mode: 'codex' })

  expect(res.status).toBe(400)
  expect(res.body).toEqual({
    status: 'error',
    message: 'Invalid Codex sandbox setting "totally-open". Expected read-only, workspace-write, or danger-full-access.',
  })
  expect(codexLaunchPlanner.planCreateCalls).toEqual([])
  expect(createTab).not.toHaveBeenCalled()
  expect(registry.create).not.toHaveBeenCalled()
})

it('rejects Codex /api/run without planning when shutdown admission closes while reading settings', async () => {
  let acceptingCreates = true
  const createTab = vi.fn(() => ({ tabId: 't1', paneId: 'p1' }))
  const registry = {
    create: vi.fn(() => ({ terminalId: 'term1' })),
    input: vi.fn(() => true),
    killAndWait: vi.fn(async () => true),
  }
  const codexLaunchPlanner = new FakeCodexLaunchPlanner()

  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      createTab,
      attachPaneContent: vi.fn(),
    },
    registry,
    codexLaunchPlanner,
    configStore: {
      getSettings: vi.fn(async () => {
        acceptingCreates = false
        return { codingCli: { providers: { codex: {} } } }
      }),
    },
    assertTerminalCreateAccepted: () => {
      if (!acceptingCreates) {
        throw new Error('Server is shutting down; terminal creation is not accepted.')
      }
    },
  }))

  const res = await request(app).post('/api/run').send({ command: 'echo done', mode: 'codex' })

  expect(res.status).toBe(500)
  expect(res.body.message).toContain('Server is shutting down')
  expect(codexLaunchPlanner.planCreateCalls).toEqual([])
  expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(0)
  expect(createTab).not.toHaveBeenCalled()
  expect(registry.create).not.toHaveBeenCalled()
  expect(registry.input).not.toHaveBeenCalled()
  expect(registry.killAndWait).not.toHaveBeenCalled()
})
