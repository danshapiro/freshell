import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

function createTerminal(snapshot: string, mode: 'codex' | 'shell' = 'codex') {
  return {
    mode,
    status: 'running',
    buffer: {
      snapshot: () => snapshot,
    },
  }
}

function createApp(options: {
  terminal?: ReturnType<typeof createTerminal>
  codexActivityTracker?: { isPromptBlocked: (terminalId: string, at: number) => boolean }
} = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      resolvePaneToTerminal: () => 'term_1',
    },
    registry: {
      get: () => options.terminal ?? createTerminal('$ ', 'codex'),
    },
    codexActivityTracker: options.codexActivityTracker,
  }))
  return app
}

describe('agent wait-for API', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not return prompt while a codex pane is pending even if the buffer looks like a prompt', async () => {
    const tracker = {
      isPromptBlocked: () => true,
    }

    const res = await request(createApp({ codexActivityTracker: tracker }))
      .get('/api/panes/pane_1/wait-for?prompt=true&T=0.25')

    expect(res.body.status).toBe('approx')
    expect(res.body.data).toEqual({ matched: false })
  })

  it('does not return stable while a codex pane is busy', async () => {
    const tracker = {
      isPromptBlocked: () => true,
    }

    const res = await request(createApp({
      terminal: createTerminal('still working', 'codex'),
      codexActivityTracker: tracker,
    }))
      .get('/api/panes/pane_1/wait-for?prompt=true&stable=0.05&T=0.3')

    expect(res.body.status).toBe('approx')
    expect(res.body.data).toEqual({ matched: false })
  })

  it('returns prompt once the codex tracker unblocks', async () => {
    let blocked = true
    setTimeout(() => {
      blocked = false
    }, 250)

    const tracker = {
      isPromptBlocked: () => blocked,
    }

    const res = await request(createApp({ codexActivityTracker: tracker }))
      .get('/api/panes/pane_1/wait-for?prompt=true&T=1.2')

    expect(res.body.status).toBe('ok')
    expect(res.body.data).toEqual({ matched: true, reason: 'prompt' })
  })

  it('keeps existing prompt behavior for non-codex panes', async () => {
    const isPromptBlocked = vi.fn(() => true)

    const res = await request(createApp({
      terminal: createTerminal('$ ', 'shell'),
      codexActivityTracker: { isPromptBlocked },
    }))
      .get('/api/panes/pane_1/wait-for?prompt=true&T=0.25')

    expect(res.body.status).toBe('ok')
    expect(res.body.data).toEqual({ matched: true, reason: 'prompt' })
    expect(isPromptBlocked).not.toHaveBeenCalled()
  })
})
