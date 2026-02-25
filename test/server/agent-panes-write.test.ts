import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

it('splits a pane horizontally', async () => {
  const app = express()
  app.use(express.json())
  const splitPane = vi.fn(() => ({ newPaneId: 'pane_new', tabId: 'tab_1' }))
  const attachPaneContent = vi.fn()
  const registryCreate = vi.fn(() => ({ terminalId: 'term_new' }))
  app.use('/api', createAgentApiRouter({
    layoutStore: { splitPane, attachPaneContent },
    registry: { create: registryCreate },
    wsHandler: { broadcastUiCommand: () => {} },
  }))

  const res = await request(app).post('/api/panes/pane_1/split').send({ direction: 'horizontal' })
  expect(res.body.status).toBe('ok')
  expect(res.body.data.paneId).toBe('pane_new')
  expect(registryCreate).toHaveBeenCalled()
  expect(registryCreate).toHaveBeenCalledWith(expect.objectContaining({
    envContext: { tabId: 'tab_1', paneId: 'pane_new' },
  }))
  expect(attachPaneContent).toHaveBeenCalled()
})

it('resolves tmux-style pane targets for close', async () => {
  const app = express()
  app.use(express.json())
  const closePane = vi.fn(() => ({ tabId: 'tab_1' }))
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      closePane,
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_resolved' }),
    },
    registry: {},
    wsHandler: { broadcastUiCommand: () => {} },
  }))

  const res = await request(app).post('/api/panes/1.0/close').send({})
  expect(res.body.status).toBe('ok')
  expect(closePane).toHaveBeenCalledWith('pane_resolved')
})
