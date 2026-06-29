import { EventEmitter } from 'node:events'
import { it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

it('sends input to a pane terminal', async () => {
  const input = vi.fn(() => ({ status: 'written' }))
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: { input },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ data: 'ls\r' })
  expect(res.body.status).toBe('ok')
  expect(input).toHaveBeenCalledWith('term_1', 'ls\r')
})

it('prefers raw data over keys when both are supplied', async () => {
  const input = vi.fn(() => ({ status: 'written' }))
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: { input },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({
    data: 'raw ENTER',
    keys: 'ENTER',
  })

  expect(res.body.status).toBe('ok')
  expect(input).toHaveBeenCalledWith('term_1', 'raw ENTER')
})

it('preserves raw text fallback when data and keys are absent', async () => {
  const input = vi.fn(() => ({ status: 'written' }))
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: { input },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ text: 'plain text' })

  expect(res.body.status).toBe('ok')
  expect(input).toHaveBeenCalledWith('term_1', 'plain text')
})

it('normalizes REST send-keys token strings through the shared key translator', async () => {
  const input = vi.fn(() => ({ status: 'written' }))
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: { input },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ keys: 'ENTER' })

  expect(res.body.status).toBe('ok')
  expect(input).toHaveBeenCalledWith('term_1', '\r')
})

it('normalizes REST send-keys token arrays through the shared key translator', async () => {
  const input = vi.fn(() => ({ status: 'written' }))
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: { input },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ keys: ['2', 'ENTER'] })

  expect(res.body.status).toBe('ok')
  expect(input).toHaveBeenCalledWith('term_1', '2\r')
})

it('resolves tmux-style target to a pane before sending', async () => {
  const input = vi.fn(() => ({ status: 'written' }))
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

it('rejects blocked Codex input instead of reporting success', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: {
      input: () => ({
        status: 'blocked_codex_identity_unavailable',
        terminalId: 'term_1',
        reason: 'candidate_persist_failed',
      }),
    },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ data: 'ls\r' })

  expect(res.status).toBe(409)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toBe('Codex restore identity could not be captured before input could be accepted.')
})

it('rejects lifecycle-loss-pending Codex input instead of reporting success', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: {
      input: () => ({
        status: 'blocked_codex_lifecycle_loss_pending',
        terminalId: 'term_1',
      }),
    },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ data: 'ls\r' })

  expect(res.status).toBe(409)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toBe('Codex worker lifecycle loss is still being resolved.')
})

it('rejects clean-exit-decision-pending Codex input instead of reporting success', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: {
      input: () => ({
        status: 'blocked_codex_clean_exit_decision_pending',
        terminalId: 'term_1',
      }),
    },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ data: 'ls\r' })

  expect(res.status).toBe(409)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toBe('Codex clean exit state is still being resolved.')
})

it('waits for Codex identity capture before sending a seeded prompt when requested', async () => {
  const events = new EventEmitter()
  let identityReady = false
  const input = vi.fn(() => (
    identityReady
      ? { status: 'written' }
      : {
      status: 'blocked_codex_identity_pending',
      terminalId: 'term_1',
    }
  ))
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: Object.assign(events, { input }),
  }))

  const response = request(app)
    .post('/api/panes/p1/send-keys')
    .send({ data: 'build the thing\r', waitForCodexIdentity: true })
  const responsePromise = response.then((res) => res)

  await vi.waitFor(() => expect(input).toHaveBeenCalled())
  identityReady = true
  events.emit('terminal.codex.durability.updated', {
    terminalId: 'term_1',
    durability: { state: 'captured_pre_turn' },
  })

  const res = await responsePromise
  expect(res.status).toBe(200)
  expect(res.body.status).toBe('ok')
  expect(input).toHaveBeenLastCalledWith('term_1', 'build the thing\r')
})

it('passes the pane canonical sessionRef to the registry identity gate', async () => {
  const inputIfSessionMatches = vi.fn(() => ({ status: 'written' }))
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      resolvePaneToTerminal: () => 'term_1',
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        terminalId: 'term_1',
        paneContent: {
          kind: 'terminal',
          terminalId: 'term_1',
          sessionRef: { provider: 'codex', sessionId: 'thread-1' },
        },
      }),
    },
    registry: {
      get: () => ({ mode: 'codex' }),
      input: vi.fn(() => ({ status: 'written' })),
      inputIfSessionMatches,
    },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ data: 'ls\r' })
  expect(res.body.status).toBe('ok')
  expect(inputIfSessionMatches).toHaveBeenCalledWith('term_1', 'ls\r', {
    provider: 'codex',
    sessionId: 'thread-1',
  })
})
