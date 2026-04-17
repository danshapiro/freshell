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

it('uses the shared Codex planner and marks fresh /api/run sessions as starts', async () => {
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
      resumeSessionId: 'thread-new-1',
      codexAppServer: {
        wsUrl: DEFAULT_CODEX_REMOTE_WS_URL,
      },
    }),
  }))
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
