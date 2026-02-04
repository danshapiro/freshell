import { it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

const registry = {
  get: () => ({ buffer: { snapshot: () => 'a\n\x1b[31mred\x1b[0m\n' } }),
}

it('captures and strips ansi by default', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({ layoutStore: { resolvePaneToTerminal: () => 'term_1' } as any, registry }))
  const res = await request(app).get('/api/panes/p1/capture')
  expect(res.text).toContain('red')
  expect(res.text).not.toContain('\x1b')
})
