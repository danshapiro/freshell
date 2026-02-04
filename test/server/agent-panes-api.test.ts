import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

it('lists panes for a tab', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({ layoutStore: { listPanes: () => ([{ id: 'p1' }]) } as any, registry: {} as any }))
  const res = await request(app).get('/api/panes?tabId=t1')
  expect(res.body.status).toBe('ok')
  expect(res.body.data.panes[0].id).toBe('p1')
})
