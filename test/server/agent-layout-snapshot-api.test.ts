import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'
import { LayoutStore } from '../../server/agent-api/layout-store'

function createApp(layoutStore = new LayoutStore()) {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({ layoutStore, registry: {} as any }))
  return { app, layoutStore }
}

function seedTwoTabLayout(layoutStore: LayoutStore) {
  layoutStore.updateFromUi({
    tabs: [
      { id: 'tab_a', title: 'Alpha' },
      { id: 'tab_b', title: 'Beta' },
    ],
    activeTabId: 'tab_b',
    layouts: {
      tab_a: {
        type: 'leaf',
        id: 'pane_a',
        content: { kind: 'terminal', terminalId: 'term_a' },
      },
      tab_b: {
        type: 'leaf',
        id: 'pane_b',
        content: { kind: 'terminal', terminalId: 'term_b' },
      },
    },
    activePane: { tab_a: 'pane_a', tab_b: 'pane_b' },
    paneTitles: { tab_a: { pane_a: 'Alpha pane' }, tab_b: { pane_b: 'Beta pane' } },
    paneTitleSetByUser: { tab_a: { pane_a: true }, tab_b: { pane_b: true } },
  }, 'conn1')
}

describe('GET /api/layout/snapshot', () => {
  it('returns an empty snapshot before a ui layout sync', async () => {
    const { app } = createApp()

    const res = await request(app).get('/api/layout/snapshot').expect(200)

    expect(res.body).toMatchObject({
      status: 'ok',
      data: {
        tabs: [],
        activeTabId: null,
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
      },
    })
  })

  it('filters the normalized snapshot by tabId', async () => {
    const { app, layoutStore } = createApp()
    seedTwoTabLayout(layoutStore)

    const res = await request(app).get('/api/layout/snapshot?tabId=tab_b').expect(200)

    expect(res.body.data).toEqual({
      tabs: [{ id: 'tab_b', title: 'Beta' }],
      activeTabId: 'tab_b',
      layouts: {
        tab_b: {
          type: 'leaf',
          id: 'pane_b',
          content: { kind: 'terminal', terminalId: 'term_b' },
        },
      },
      activePane: { tab_b: 'pane_b' },
      paneTitles: { tab_b: { pane_b: 'Beta pane' } },
      paneTitleSetByUser: { tab_b: { pane_b: true } },
    })
  })

  it('returns an empty filtered snapshot for a missing tabId', async () => {
    const { app, layoutStore } = createApp()
    seedTwoTabLayout(layoutStore)

    const res = await request(app).get('/api/layout/snapshot?tabId=missing').expect(200)

    expect(res.body.data).toEqual({
      tabs: [],
      activeTabId: null,
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
    })
  })

  it('returns legacy agent-chat panes normalized after LayoutStore.updateFromUi', async () => {
    const { app, layoutStore } = createApp()
    layoutStore.updateFromUi({
      tabs: [{ id: 'tab_agent', title: 'Legacy agent' }],
      activeTabId: 'tab_agent',
      layouts: {
        tab_agent: {
          type: 'leaf',
          id: 'pane_agent',
          content: {
            kind: 'agent-chat',
            provider: 'claude',
            createRequestId: 'req_agent',
            resumeSessionId: '11111111-1111-4111-8111-111111111111',
          },
        },
      },
      activePane: { tab_agent: 'pane_agent' },
    }, 'conn1')

    const res = await request(app).get('/api/layout/snapshot?tabId=tab_agent').expect(200)

    expect(JSON.stringify(res.body.data)).not.toContain('"agent-chat"')
    expect(res.body.data.layouts.tab_agent.content).toMatchObject({
      kind: 'fresh-agent',
      provider: 'claude',
      sessionType: 'freshclaude',
      createRequestId: 'req_agent',
      sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
    })
  })

  it('returns fresh non-aliased response data on repeated reads', async () => {
    const { app, layoutStore } = createApp()
    seedTwoTabLayout(layoutStore)

    const first = await request(app).get('/api/layout/snapshot?tabId=tab_a').expect(200)
    first.body.data.tabs[0].title = 'Mutated'
    first.body.data.layouts.tab_a.content.kind = 'mutated'
    first.body.data.paneTitles.tab_a.pane_a = 'Mutated pane'

    const second = await request(app).get('/api/layout/snapshot?tabId=tab_a').expect(200)

    expect(second.body.data.tabs[0].title).toBe('Alpha')
    expect(second.body.data.layouts.tab_a.content.kind).toBe('terminal')
    expect(second.body.data.paneTitles.tab_a.pane_a).toBe('Alpha pane')
  })
})
