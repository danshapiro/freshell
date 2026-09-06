import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'
import { ClaudeFreshAgentHistoryResolutionError } from '../../server/fresh-agent/history/claude/history-service'
import { FreshAgentRuntimeUnavailableError } from '../../server/fresh-agent/runtime-manager'

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

  it('returns 422 pane-kind validation for a legacy fresh-agent pane with no backing session', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createAgentApiRouter({
      layoutStore: {
        resolvePaneToTerminal: () => undefined,
        getPaneSnapshot: () => ({
          kind: 'fresh-agent',
          paneContent: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            sessionId: '11111111-1111-4111-8111-111111111111',
          },
        }),
      } as any,
      registry,
      freshAgentRuntimeManager: {
        getSnapshot: async () => {
          throw new ClaudeFreshAgentHistoryResolutionError('RESTORE_NOT_FOUND', 'Restore session not found')
        },
      } as any,
    }))
    const res = await request(app).get('/api/panes/pane-legacy-agent/capture')
    expect(res.status).toBe(422)
    expect(res.body).toEqual({
      status: 'error',
      message: 'pane kind "fresh-agent" does not support capture-pane; use screenshot-pane',
    })
  })

  it('keeps the 500 mapping for fresh-agent history resolution failures other than RESTORE_NOT_FOUND', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createAgentApiRouter({
      layoutStore: {
        resolvePaneToTerminal: () => undefined,
        getPaneSnapshot: () => ({
          kind: 'fresh-agent',
          paneContent: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            sessionId: '22222222-2222-4222-8222-222222222222',
          },
        }),
      } as any,
      registry,
      freshAgentRuntimeManager: {
        getSnapshot: async () => {
          throw new ClaudeFreshAgentHistoryResolutionError('RESTORE_DIVERGED', 'history diverged')
        },
      } as any,
    }))
    const res = await request(app).get('/api/panes/pane-diverged-agent/capture')
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ status: 'error', message: expect.stringContaining('history diverged') })
  })

  it('keeps the existing status mapping for other fresh-agent capture failures', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createAgentApiRouter({
      layoutStore: {
        resolvePaneToTerminal: () => undefined,
        getPaneSnapshot: () => ({
          kind: 'fresh-agent',
          paneContent: {
            kind: 'fresh-agent',
            sessionType: 'freshopencode',
            provider: 'opencode',
            sessionId: 'ses_gone',
          },
        }),
      } as any,
      registry,
      freshAgentRuntimeManager: {
        getSnapshot: async () => {
          throw new FreshAgentRuntimeUnavailableError('runtime down')
        },
      } as any,
    }))
    const res = await request(app).get('/api/panes/pane-live-agent/capture')
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ status: 'error', message: expect.stringContaining('runtime down') })
  })
})
