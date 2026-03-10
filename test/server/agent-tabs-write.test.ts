import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

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
