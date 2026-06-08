import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'
import { UnknownTerminalModeError } from '../../server/terminal-registry'
import { FakeCodexLaunchPlanner } from '../helpers/coding-cli/fake-codex-launch-planner.js'
import { INVALID_RAW_CODEX_RESUME_MESSAGE } from '../../server/coding-cli/codex-app-server/restore-decision.js'

class FakeRegistry {
  create = vi.fn((opts?: { terminalId?: string }) => ({ terminalId: opts?.terminalId ?? 'term_1' }))
}

describe('tab endpoints', () => {
  it('creates a new tab and returns ids', async () => {
    const app = express()
    app.use(express.json())
    const layoutStore = {
      createTab: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
      attachPaneContent: () => {},
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry: new FakeRegistry(), wsHandler: { broadcastUiCommand: () => {} } }))
    const res = await request(app).post('/api/tabs').send({ name: 'alpha' })
    expect(res.body.status).toBe('ok')
    expect(res.body.data.tabId).toBe('tab_1')
  })

  it('creates browser tabs without spawning a terminal', async () => {
    const app = express()
    app.use(express.json())
    const registry = new FakeRegistry()
    const createTab = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
    const layoutStore = {
      createTab,
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, wsHandler: { broadcastUiCommand: () => {} } }))
    const res = await request(app).post('/api/tabs').send({ name: 'web', browser: 'https://example.com' })

    expect(res.body.status).toBe('ok')
    expect(createTab).toHaveBeenCalled()
    expect(registry.create).not.toHaveBeenCalled()
    expect(layoutStore.attachPaneContent).toHaveBeenCalled()
  })

  it('allocates and passes an OpenCode control endpoint when creating an opencode tab', async () => {
    const app = express()
    app.use(express.json())
    const registry = new FakeRegistry()
    const layoutStore = {
      createTab: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
      attachPaneContent: () => {},
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, wsHandler: { broadcastUiCommand: () => {} } }))

    const res = await request(app).post('/api/tabs').send({ mode: 'opencode', name: 'OpenCode' })

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

  it('creates terminal tabs from canonical sessionRef without mirroring legacy resumeSessionId payloads', async () => {
    const app = express()
    app.use(express.json())
    const registry = new FakeRegistry()
    const attachPaneContent = vi.fn()
    const broadcastUiCommand = vi.fn()
    const layoutStore = {
      createTab: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
      attachPaneContent,
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, wsHandler: { broadcastUiCommand } }))

    const sessionRef = { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' }
    const res = await request(app).post('/api/tabs').send({
      mode: 'claude',
      name: 'resume me',
      sessionRef,
    })

    expect(res.body.status).toBe('ok')
    expect(registry.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'claude',
      resumeSessionId: sessionRef.sessionId,
    }))
    expect(attachPaneContent).toHaveBeenCalledWith('tab_1', 'pane_1', expect.objectContaining({
      kind: 'terminal',
      sessionRef,
    }))
    expect(attachPaneContent.mock.calls[0]?.[2]).not.toHaveProperty('resumeSessionId')
    expect(broadcastUiCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'tab.create',
      payload: expect.objectContaining({
        sessionRef,
      }),
    }))
    expect(broadcastUiCommand.mock.calls[0]?.[0]?.payload).not.toHaveProperty('resumeSessionId')
  })

  it('passes the planned Codex sidecar through /api/tabs terminal creation', async () => {
    const app = express()
    app.use(express.json())
    const registry = new FakeRegistry()
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const createTab = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
    const layoutStore = {
      createTab,
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))

    const res = await request(app).post('/api/tabs').send({ mode: 'codex', name: 'Codex' })

    expect(res.body.status).toBe('ok')
    expect(codexLaunchPlanner.planCreateCalls).toHaveLength(1)
    const planCreate = codexLaunchPlanner.planCreateCalls[0]
    expect(planCreate).toEqual(expect.objectContaining({
      approvalPolicy: undefined,
      cwd: undefined,
      model: undefined,
      resumeSessionId: undefined,
      sandbox: undefined,
    }))
    expect(registry.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'codex',
      providerSettings: expect.objectContaining({
        codexAppServer: expect.objectContaining({
          sidecar: codexLaunchPlanner.sidecar,
          wsUrl: expect.any(String),
        }),
      }),
    }))
  })

  it('retries initial Codex launch before creating a Codex tab terminal', async () => {
    const app = express()
    app.use(express.json())
    const registry = new FakeRegistry()
    const codexLaunchPlanner = new FakeCodexLaunchPlanner({
      sessionId: 'thread-canonical',
      remote: { wsUrl: 'ws://127.0.0.1:43123' },
    })
    codexLaunchPlanner.failNext(2)
    const createTab = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
    const layoutStore = {
      createTab,
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))

    const res = await request(app).post('/api/tabs').send({ mode: 'codex', name: 'Codex' })

    expect(res.body.status).toBe('ok')
    expect(codexLaunchPlanner.planCreateCalls).toHaveLength(3)
    expect(createTab).toHaveBeenCalledTimes(1)
    expect(registry.create).toHaveBeenCalledTimes(1)
  })

  it('fails Codex tab creation without mutating layout when launch retries are exhausted', async () => {
    const app = express()
    app.use(express.json())
    const registry = new FakeRegistry()
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    codexLaunchPlanner.failNext(5)
    const createTab = vi.fn((input: { tabId: string; paneId: string }) => ({
      tabId: input.tabId,
      paneId: input.paneId,
    }))
    const layoutStore = {
      createTab,
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))

    const res = await request(app).post('/api/tabs').send({ mode: 'codex', name: 'Codex' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ status: 'error', message: 'fake Codex launch failed' })
    expect(codexLaunchPlanner.planCreateCalls).toHaveLength(5)
    expect(createTab).not.toHaveBeenCalled()
    expect(registry.create).not.toHaveBeenCalled()
  }, 15_000)

  it('shuts down the planned Codex sidecar when tab terminal creation fails before registry ownership', async () => {
    const app = express()
    app.use(express.json())
    const registry = new FakeRegistry()
    registry.create.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const createTab = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
    const closeTab = vi.fn()
    const layoutStore = {
      createTab,
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab,
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))

    const res = await request(app).post('/api/tabs').send({ mode: 'codex', name: 'Codex' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ status: 'error', message: 'spawn failed' })
    expect(codexLaunchPlanner.planCreateCalls).toHaveLength(1)
    expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
    expect(closeTab).toHaveBeenCalledWith('tab_1')
  })

  it('rejects invalid Codex sandbox values with a 400 before spawning', async () => {
    const app = express()
    app.use(express.json())
    const registry = new FakeRegistry()
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const createTab = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
    const layoutStore = {
      createTab,
      attachPaneContent: () => {},
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))

    const res = await request(app).post('/api/tabs').send({
      mode: 'codex',
      name: 'bad sandbox',
      sandbox: 'totally-open',
    })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      status: 'error',
      message: 'Invalid Codex sandbox setting "totally-open". Expected read-only, workspace-write, or danger-full-access.',
    })
    expect(codexLaunchPlanner.planCreateCalls).toEqual([])
    expect(createTab).not.toHaveBeenCalled()
    expect(registry.create).not.toHaveBeenCalled()
  })

  it('rejects Codex tab creation without planning when shutdown admission closes while reading settings', async () => {
    const app = express()
    app.use(express.json())
    let acceptingCreates = true
    const registry = {
      create: vi.fn(() => {
        throw new Error('registry.create should not run')
      }),
      killAndWait: vi.fn(async () => true),
    }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const layoutStore = {
      createTab: vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' })),
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    const configStore = {
      getSettings: vi.fn(async () => {
        acceptingCreates = false
        return { codingCli: { providers: { codex: {} } } }
      }),
    }
    app.use('/api', createAgentApiRouter({
      layoutStore,
      registry,
      configStore,
      codexLaunchPlanner,
      assertTerminalCreateAccepted: () => {
        if (!acceptingCreates) {
          throw new Error('Server is shutting down; terminal creation is not accepted.')
        }
      },
    }))

    const res = await request(app).post('/api/tabs').send({ mode: 'codex', name: 'shutdown before planning' })

    expect(res.status).toBe(500)
    expect(res.body.message).toContain('Server is shutting down')
    expect(configStore.getSettings).toHaveBeenCalledTimes(1)
    expect(codexLaunchPlanner.planCreateCalls).toEqual([])
    expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(0)
    expect(registry.create).not.toHaveBeenCalled()
    expect(registry.killAndWait).not.toHaveBeenCalled()
    expect(layoutStore.createTab).not.toHaveBeenCalled()
    expect(layoutStore.attachPaneContent).not.toHaveBeenCalled()
  })

  it('kills the created Codex terminal when tab creation fails after registry.create', async () => {
    const app = express()
    app.use(express.json())
    const registry = {
      create: vi.fn(() => ({ terminalId: 'term_1' })),
      killAndWait: vi.fn(async () => true),
    }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    vi.spyOn(codexLaunchPlanner.sidecar, 'adopt').mockRejectedValue(new Error('adopt failed after tab create'))
    const layoutStore = {
      createTab: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))

    const res = await request(app).post('/api/tabs').send({ mode: 'codex', name: 'resume tab' })

    expect(res.status).toBe(500)
    expect(res.body.message).toBe('adopt failed after tab create')
    expect(registry.killAndWait).toHaveBeenCalledWith('term_1')
    expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
    expect(layoutStore.attachPaneContent).not.toHaveBeenCalled()
  })

  it('kills the inserted Codex terminal when registry.create fails after insertion', async () => {
    const app = express()
    app.use(express.json())
    const createError = new Error('terminal.created listener failed') as Error & { terminalId?: string }
    createError.terminalId = 'term_inserted'
    const registry = {
      create: vi.fn(() => {
        throw createError
      }),
      killAndWait: vi.fn(async () => true),
    }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const layoutStore = {
      createTab: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))

    const res = await request(app).post('/api/tabs').send({ mode: 'codex', name: 'emit failure tab' })

    expect(res.status).toBe(500)
    expect(res.body.message).toBe('terminal.created listener failed')
    expect(registry.killAndWait).toHaveBeenCalledWith('term_inserted')
    expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
    expect(layoutStore.attachPaneContent).not.toHaveBeenCalled()
  })

  it('rejects raw Codex resume ids instead of fresh-creating tabs', async () => {
    const app = express()
    app.use(express.json())
    const registry = {
      create: vi.fn(),
      killAndWait: vi.fn(async () => true),
    }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const layoutStore = {
      createTab: vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' })),
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))

    const res = await request(app).post('/api/tabs').send({
      mode: 'codex',
      name: 'resume tab',
      resumeSessionId: 'thread-resume-exits',
    })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      status: 'error',
      message: INVALID_RAW_CODEX_RESUME_MESSAGE,
    })
    expect(codexLaunchPlanner.planCreateCalls).toEqual([])
    expect(registry.create).not.toHaveBeenCalled()
    expect(registry.killAndWait).not.toHaveBeenCalled()
    expect(layoutStore.createTab).not.toHaveBeenCalled()
    expect(layoutStore.attachPaneContent).not.toHaveBeenCalled()
  })

  it('uses canonical Codex sessionRef as the durable resume path', async () => {
    const app = express()
    app.use(express.json())
    const terminal = { terminalId: 'term_codex_canonical', status: 'running' }
    const registry = {
      create: vi.fn(() => terminal),
      killAndWait: vi.fn(async () => true),
    }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner({
      sessionId: 'thread-canonical',
      remote: { wsUrl: 'ws://127.0.0.1:43123' },
    })
    const layoutStore = {
      createTab: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))

    const sessionRef = { provider: 'codex', sessionId: 'thread-canonical' }
    const res = await request(app).post('/api/tabs').send({
      mode: 'codex',
      name: 'resume tab',
      sessionRef,
    })

    expect(res.status).toBe(200)
    expect(codexLaunchPlanner.planCreateCalls[0]).toEqual(expect.objectContaining({
      resumeSessionId: 'thread-canonical',
    }))
    expect(registry.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'codex',
      resumeSessionId: 'thread-canonical',
    }))
    expect(layoutStore.attachPaneContent).toHaveBeenCalledWith('tab_1', 'pane_1', expect.objectContaining({
      sessionRef,
    }))
    expect(layoutStore.attachPaneContent.mock.calls[0]?.[2]).not.toHaveProperty('resumeSessionId')
  })

  it('kills the created Codex terminal without waiting for readiness when shutdown admission closes after adoption', async () => {
    const app = express()
    app.use(express.json())
    let acceptingCreates = true
    const terminal = { terminalId: 'term_shutdown_after_adopt', status: 'running' }
    const registry = {
      create: vi.fn(() => terminal),
      killAndWait: vi.fn(async () => true),
      publishCodexSidecar: vi.fn(),
    }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const originalAdopt = codexLaunchPlanner.sidecar.adopt.bind(codexLaunchPlanner.sidecar)
    vi.spyOn(codexLaunchPlanner.sidecar, 'adopt').mockImplementation(async (input) => {
      await originalAdopt(input)
      acceptingCreates = false
    })
    const layoutStore = {
      createTab: vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' })),
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({
      layoutStore,
      registry,
      codexLaunchPlanner,
      assertTerminalCreateAccepted: () => {
        if (!acceptingCreates) {
          throw new Error('Server is shutting down; terminal creation is not accepted.')
        }
      },
    }))

    const res = await request(app).post('/api/tabs').send({
      mode: 'codex',
      name: 'resume tab',
      sessionRef: { provider: 'codex', sessionId: 'thread-resume-shutdown' },
    })

    expect(res.status).toBe(500)
    expect(res.body.message).toContain('Server is shutting down')
    expect(codexLaunchPlanner.sidecar.adoptCalls).toEqual([{ terminalId: 'term_shutdown_after_adopt', generation: 0 }])
    expect(registry.publishCodexSidecar).not.toHaveBeenCalled()
    expect(registry.killAndWait).toHaveBeenCalledWith('term_shutdown_after_adopt')
    expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
    expect(layoutStore.attachPaneContent).not.toHaveBeenCalled()
  })

  it('rejects Codex tab creation when shutdown admission closes after planning', async () => {
    const app = express()
    app.use(express.json())
    let acceptingCreates = true
    const registry = {
      create: vi.fn(() => ({ terminalId: 'term_1', status: 'running' })),
      killAndWait: vi.fn(async () => true),
    }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const originalPlanCreate = codexLaunchPlanner.planCreate.bind(codexLaunchPlanner)
    vi.spyOn(codexLaunchPlanner, 'planCreate').mockImplementation(async (input) => {
      const plan = await originalPlanCreate(input)
      acceptingCreates = false
      return plan
    })
    const layoutStore = {
      createTab: vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' })),
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({
      layoutStore,
      registry,
      codexLaunchPlanner,
      assertTerminalCreateAccepted: () => {
        if (!acceptingCreates) {
          throw new Error('Server is shutting down; terminal creation is not accepted.')
        }
      },
    }))

    const res = await request(app).post('/api/tabs').send({ mode: 'codex', name: 'shutdown after plan' })

    expect(res.status).toBe(500)
    expect(res.body.message).toContain('Server is shutting down')
    expect(registry.create).not.toHaveBeenCalled()
    expect(registry.killAndWait).not.toHaveBeenCalled()
    expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
    expect(layoutStore.attachPaneContent).not.toHaveBeenCalled()
  })

  it('kills the created Codex terminal when shutdown admission closes before adoption', async () => {
    const app = express()
    app.use(express.json())
    const registry = {
      create: vi.fn(() => ({ terminalId: 'term_1', status: 'running' })),
      killAndWait: vi.fn(async () => true),
    }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const layoutStore = {
      createTab: vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' })),
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }),
      selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({
      layoutStore,
      registry,
      codexLaunchPlanner,
      assertTerminalCreateAccepted: () => {
        if (registry.create.mock.calls.length > 0) {
          throw new Error('Server is shutting down; terminal creation is not accepted.')
        }
      },
    }))

    const res = await request(app).post('/api/tabs').send({ mode: 'codex', name: 'shutdown before adopt' })

    expect(res.status).toBe(500)
    expect(res.body.message).toContain('Server is shutting down')
    expect(registry.create).toHaveBeenCalledTimes(1)
    expect(codexLaunchPlanner.sidecar.adoptCalls).toEqual([])
    expect(registry.killAndWait).toHaveBeenCalledWith('term_1')
    expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
    expect(layoutStore.attachPaneContent).not.toHaveBeenCalled()
  })

  it('rejects blank tab rename payloads', async () => {
    const app = express()
    app.use(express.json())
    const renameTab = vi.fn()
    app.use('/api', createAgentApiRouter({
      layoutStore: { renameTab },
      registry: {} as any,
      wsHandler: { broadcastUiCommand: vi.fn() },
    }))

    const res = await request(app).patch('/api/tabs/tab_1').send({ name: '   ' })

    expect(res.status).toBe(400)
    expect(renameTab).not.toHaveBeenCalled()
  })

  it('trims tab rename payloads before writing and broadcasts only successful renames', async () => {
    const app = express()
    app.use(express.json())
    const renameTab = vi.fn(() => ({ tabId: 'tab_1' }))
    const broadcastUiCommand = vi.fn()
    app.use('/api', createAgentApiRouter({
      layoutStore: { renameTab },
      registry: {} as any,
      wsHandler: { broadcastUiCommand },
    }))

    const res = await request(app).patch('/api/tabs/tab_1').send({ name: '  Release prep  ' })

    expect(res.status).toBe(200)
    expect(renameTab).toHaveBeenCalledWith('tab_1', 'Release prep')
    expect(broadcastUiCommand).toHaveBeenCalledWith({
      command: 'tab.rename',
      payload: { id: 'tab_1', title: 'Release prep' },
    })
  })

  it('does not broadcast tab.rename when the tab does not exist', async () => {
    const app = express()
    app.use(express.json())
    const renameTab = vi.fn(() => ({ message: 'tab not found' }))
    const broadcastUiCommand = vi.fn()
    app.use('/api', createAgentApiRouter({
      layoutStore: { renameTab },
      registry: {} as any,
      wsHandler: { broadcastUiCommand },
    }))

    const res = await request(app).patch('/api/tabs/missing').send({ name: 'Ghost' })

    expect(res.status).toBe(200)
    expect(renameTab).toHaveBeenCalledWith('missing', 'Ghost')
    expect(broadcastUiCommand).not.toHaveBeenCalled()
  })

  it('rejects an unknown terminal mode with a 400 and rolls back the tab', async () => {
    const app = express()
    app.use(express.json())
    const closeTab = vi.fn()
    // A spawn for an unmodelled mode (e.g. mode: 'terminal') throws from the
    // registry; the route must surface a 400, not spawn a dead terminal.
    const registry = {
      create: vi.fn(() => { throw new UnknownTerminalModeError('terminal') }),
    }
    const layoutStore = {
      createTab: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
      attachPaneContent: vi.fn(),
      closeTab,
    }
    app.use('/api', createAgentApiRouter({
      layoutStore,
      registry: registry as any,
      wsHandler: { broadcastUiCommand: vi.fn() },
    }))

    const res = await request(app).post('/api/tabs').send({ name: 'x', mode: 'terminal' })

    expect(res.status).toBe(400)
    expect(res.body.status).toBe('error')
    expect(res.body.message).toMatch(/Invalid terminal mode/)
    // The half-created tab is cleaned up rather than left dangling.
    expect(closeTab).toHaveBeenCalledWith('tab_1')
  })
})
