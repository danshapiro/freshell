import { it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

it('runs a command and returns captured output', async () => {
  let buffer = ''
  const registry = {
    create: () => ({ terminalId: 'term1' }),
    input: (_terminalId: string, data: string) => {
      const match = data.match(/__FRESHELL_DONE_[A-Za-z0-9_-]+__/)
      if (match) buffer = `done\n${match[0]}\n`
      return true
    },
    get: () => ({ buffer: { snapshot: () => buffer }, status: 'running' }),
  }

  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { createTab: () => ({ tabId: 't1', paneId: 'p1' }) },
    registry,
  }))

  const res = await request(app).post('/api/run').send({ command: 'echo done', capture: true })
  expect(res.body.status).toBe('ok')
  expect(res.body.data.output).toContain('done')
})
