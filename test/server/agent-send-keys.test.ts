import { it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

it('sends input to a pane terminal', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: { input: () => true },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ data: 'ls\r' })
  expect(res.body.status).toBe('ok')
})

it('resolves tmux-style target to a pane before sending', async () => {
  const input = vi.fn(() => true)
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      resolvePaneToTerminal: (paneId: string) => (paneId === 'pane_9' ? 'term_2' : undefined),
      resolveTarget: () => ({ paneId: 'pane_9' }),
    },
    registry: { input },
  }))

  const res = await request(app).post('/api/panes/alpha.0/send-keys').send({ data: 'C-c' })
  expect(res.body.status).toBe('ok')
  expect(input).toHaveBeenCalledWith('term_2', 'C-c')
})
