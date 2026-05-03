import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'
import { FakeCodexLaunchPlanner } from '../helpers/coding-cli/fake-codex-launch-planner.js'

class FakeRegistry {
  create = vi.fn(() => ({ terminalId: 'term_1' }))
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

  it('kills the created Codex terminal when resume readiness returns after the PTY exited', async () => {
    const app = express()
    app.use(express.json())
    const terminal = { terminalId: 'term_exited_before_publish', status: 'running' }
    const registry = {
      create: vi.fn(() => terminal),
      killAndWait: vi.fn(async () => true),
    }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    vi.spyOn(codexLaunchPlanner.sidecar, 'waitForLoadedThread').mockImplementation(async (threadId, options) => {
      codexLaunchPlanner.sidecar.waitForLoadedThreadCalls.push({ threadId, options })
      terminal.status = 'exited'
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

    const res = await request(app).post('/api/tabs').send({
      mode: 'codex',
      name: 'resume tab',
      resumeSessionId: 'thread-resume-exits',
    })

    expect(res.status).toBe(500)
    expect(res.body.message).toContain('Codex terminal PTY exited before create completed')
    expect(registry.killAndWait).toHaveBeenCalledWith('term_exited_before_publish')
    expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
    expect(layoutStore.attachPaneContent).not.toHaveBeenCalled()
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
      resumeSessionId: 'thread-resume-shutdown',
    })

    expect(res.status).toBe(500)
    expect(res.body.message).toContain('Server is shutting down')
    expect(codexLaunchPlanner.sidecar.adoptCalls).toEqual([{ terminalId: 'term_shutdown_after_adopt', generation: 0 }])
    expect(codexLaunchPlanner.sidecar.waitForLoadedThreadCalls).toEqual([])
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
})
