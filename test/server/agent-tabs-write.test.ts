import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'
import { FakeCodexLaunchPlanner } from '../helpers/coding-cli/fake-codex-launch-planner.js'

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

    expect(res.body.status).toBe('ok')
    expect(codexLaunchPlanner.planCreateCalls).toHaveLength(1)
    const planCreate = codexLaunchPlanner.planCreateCalls[0]
    expect(planCreate).toEqual(expect.objectContaining({
      approvalPolicy: undefined,
      cwd: undefined,
      model: undefined,
      resumeSessionId: undefined,
      sandbox: undefined,
      terminalId: expect.any(String),
      env: expect.objectContaining({
        FRESHELL: '1',
        FRESHELL_TERMINAL_ID: expect.any(String),
        FRESHELL_TOKEN: '',
        FRESHELL_URL: 'http://localhost:3001',
      }),
    }))
    expect(planCreate.env.FRESHELL_TERMINAL_ID).toBe(planCreate.terminalId)
    expect(planCreate.env.FRESHELL_TAB_ID).toBe(createTab.mock.calls[0]?.[0]?.tabId)
    expect(planCreate.env.FRESHELL_PANE_ID).toBe(createTab.mock.calls[0]?.[0]?.paneId)
    expect(registry.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'codex',
      terminalId: planCreate.terminalId,
      codexSidecar: codexLaunchPlanner.sidecar,
      providerSettings: expect.objectContaining({
        codexAppServer: expect.objectContaining({
          wsUrl: expect.any(String),
        }),
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
