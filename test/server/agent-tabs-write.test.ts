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
})
