import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

const registry = {
  get: () => ({ buffer: { snapshot: () => 'a\n\x1b[31mred\x1b[0m\n' } }),
}

describe('GET /api/panes/:id/capture', () => {
  it('captures and strips ansi by default', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createAgentApiRouter({ layoutStore: { resolvePaneToTerminal: () => 'term_1' } as any, registry }))
    const res = await request(app).get('/api/panes/p1/capture')
    expect(res.text).toContain('red')
    expect(res.text).not.toContain('\x1b')
  })

  it('captures editor pane content when pane kind is editor', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createAgentApiRouter({
      layoutStore: {
        resolvePaneToTerminal: () => undefined,
        getPaneSnapshot: () => ({
          kind: 'editor',
          paneContent: {
            kind: 'editor',
            content: 'line 1\nline 2\n',
          },
        }),
      } as any,
      registry,
    }))
    const res = await request(app).get('/api/panes/p1/capture?S=1')
    expect(res.status).toBe(200)
    expect(res.text.trim()).toBe('line 2')
  })

  it('returns a clear unsupported message for non-text panes', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createAgentApiRouter({
      layoutStore: {
        resolvePaneToTerminal: () => undefined,
        getPaneSnapshot: () => ({
          kind: 'browser',
          paneContent: {
            kind: 'browser',
            url: 'https://example.com',
          },
        }),
      } as any,
      registry,
    }))
    const res = await request(app).get('/api/panes/p1/capture')
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({
      status: 'error',
      message: expect.stringContaining('does not support capture-pane'),
    })
  })
})
