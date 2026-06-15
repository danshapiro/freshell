import { expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'
import { CODEX_DURABILITY_SCHEMA_VERSION } from '../../shared/codex-durability.js'

function durableCodexTerminal(sessionId: string) {
  return {
    mode: 'codex',
    shell: 'system',
    resumeSessionId: sessionId,
    codexDurability: {
      schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
      state: 'durable',
      durableThreadId: sessionId,
    },
  }
}

it('rejects attaching a Codex terminal whose canonical identity conflicts with the pane sessionRef', async () => {
  const app = express()
  app.use(express.json())
  const attachPaneContent = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      attachPaneContent,
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: {
          kind: 'terminal',
          terminalId: 'term_new',
          sessionRef: { provider: 'codex', sessionId: 'thread-new' },
        },
      }),
    } as any,
    registry: {
      get: () => durableCodexTerminal('thread-old'),
    } as any,
    wsHandler: { broadcastUiCommand: vi.fn() },
  }))

  const res = await request(app)
    .post('/api/panes/pane_1/attach')
    .send({ terminalId: 'term_old' })

  expect(res.status).toBe(409)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toContain('Expected codex:thread-new, got codex:thread-old')
  expect(attachPaneContent).not.toHaveBeenCalled()
})

it('rejects send-keys when the pane sessionRef conflicts with the target Codex terminal', async () => {
  const inputIfSessionMatches = vi.fn(() => ({
    status: 'session_identity_mismatch',
    terminalId: 'term_old',
    expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
    actualSessionRef: { provider: 'codex', sessionId: 'thread-old' },
  }))
  const rawInput = vi.fn()
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      resolvePaneToTerminal: () => 'term_old',
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        terminalId: 'term_old',
        paneContent: {
          kind: 'terminal',
          terminalId: 'term_old',
          sessionRef: { provider: 'codex', sessionId: 'thread-new' },
        },
      }),
    } as any,
    registry: {
      get: () => durableCodexTerminal('thread-old'),
      input: rawInput,
      inputIfSessionMatches,
    } as any,
  }))

  const res = await request(app)
    .post('/api/panes/pane_1/send-keys')
    .send({ data: 'ls\r' })

  expect(res.status).toBe(409)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toContain('Expected codex:thread-new, got codex:thread-old')
  expect(inputIfSessionMatches).toHaveBeenCalledWith(
    'term_old',
    'ls\r',
    { provider: 'codex', sessionId: 'thread-new' },
  )
  expect(rawInput).not.toHaveBeenCalled()
})
