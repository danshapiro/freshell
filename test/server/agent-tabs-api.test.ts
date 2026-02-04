import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

it('lists tabs', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({ layoutStore: { listTabs: () => ([{ id: 't1' }]) } as any, registry: {} as any }))
  const res = await request(app).get('/api/tabs')
  expect(res.body.status).toBe('ok')
  expect(res.body.data.tabs[0].id).toBe('t1')
})
